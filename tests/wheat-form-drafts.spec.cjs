/**
 * Unfinished work, and what is allowed to destroy it.
 *
 * The failure being fixed was not in one form. Every create-and-edit surface in
 * Wheat held its contents in React state and nowhere else, so leaving a screen
 * discarded whatever had been typed into it — not as a bug in one place but as
 * the default behaviour of the whole application, because unmounting is what a
 * router does and component state is what unmounting destroys. An accountant
 * mid-invoice could not open the suppliers list to check a name.
 *
 * So the rule this suite pins is a rule about *deletion*, not about storage:
 * the only things that may remove somebody's unfinished work are the person
 * saying so, and a submission the domain service confirmed. Everything else —
 * navigating, closing a panel, a failed post, a validation error, a restart —
 * must leave it exactly where it was.
 *
 * The accounting-safety half matters as much. A draft is not accounting data.
 * It is never read by a domain service, never posted, never numbered; it holds
 * what somebody typed until they decide, and it is scoped to one dossier so
 * that unfinished work in one company cannot surface in another.
 */

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const drafts = tsxRequire(path.join(root, "electron", "formDrafts.ts"), __filename);
const migratedDatabasePath = path.join(root, "prisma", "dev.db");

test.describe("form drafts", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  let temporaryRoot;
  let prisma;
  let service;
  let companyA;
  let companyB;

  test.beforeAll(async () => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-drafts-"));
    const databasePath = path.join(temporaryRoot, "drafts.db");
    fs.copyFileSync(migratedDatabasePath, databasePath);
    prisma = new PrismaClient({ datasources: { db: { url: `file:${databasePath.replace(/\\/g, "/")}` } } });
    await prisma.$connect();

    const company = (name, ice) => prisma.company.create({
      data: { name, legalForm: "SARL", ice, taxId: `IF-${ice}`, city: "Casablanca" },
    });
    companyA = await company("DOSSIER A", "001111111000011");
    companyB = await company("DOSSIER B", "002222222000022");
    service = drafts.createFormDraftService(async () => prisma);
  });

  test.afterAll(async () => {
    await prisma?.$disconnect();
    if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  /* -------------------------------------------------------- keeping work */

  test("what was typed comes back", async () => {
    await service.save({
      companyId: companyA.id, entity: "invoice", draftKey: "new-sales",
      payload: { counterpartyId: "c1", invoiceNo: "FA-2026-0007", lines: [{ ht: "4500.00", vat: "900.00" }] },
    });
    const held = await service.load({ companyId: companyA.id, entity: "invoice", draftKey: "new-sales" });
    expect(held.payload.invoiceNo).toBe("FA-2026-0007");
    expect(held.payload.lines[0].ht).toBe("4500.00");
  });

  test("saving again replaces the draft rather than accumulating drafts", async () => {
    await service.save({ companyId: companyA.id, entity: "invoice", draftKey: "new-sales", payload: { invoiceNo: "FA-2026-0008" } });
    const held = await service.load({ companyId: companyA.id, entity: "invoice", draftKey: "new-sales" });
    expect(held.payload.invoiceNo).toBe("FA-2026-0008");
    expect(held.revision).toBeGreaterThan(1);
    expect(await prisma.formDraft.count({ where: { companyId: companyA.id, entity: "invoice", draftKey: "new-sales" } })).toBe(1);
  });

  test("nothing held is null, not an error", async () => {
    expect(await service.load({ companyId: companyA.id, entity: "invoice", draftKey: "never-started" })).toBeNull();
  });

  /* ------------------------------------------------ drafts stay separate */

  test("two unfinished items do not overwrite each other", async () => {
    await service.save({ companyId: companyA.id, entity: "invoice", draftKey: "new-purchases", payload: { invoiceNo: "FR-9001" } });
    await service.save({ companyId: companyA.id, entity: "entry", draftKey: "new", payload: { label: "Écriture en cours" } });

    const sales = await service.load({ companyId: companyA.id, entity: "invoice", draftKey: "new-sales" });
    const purchases = await service.load({ companyId: companyA.id, entity: "invoice", draftKey: "new-purchases" });
    const entry = await service.load({ companyId: companyA.id, entity: "entry", draftKey: "new" });

    expect(sales.payload.invoiceNo).toBe("FA-2026-0008");
    expect(purchases.payload.invoiceNo).toBe("FR-9001");
    expect(entry.payload.label).toBe("Écriture en cours");
  });

  test("a draft never leaks into another dossier", async () => {
    // The one that would be unforgivable: somebody's supplier invoice appearing
    // in a different client's books.
    await service.save({ companyId: companyB.id, entity: "invoice", draftKey: "new-sales", payload: { invoiceNo: "AUTRE-DOSSIER" } });
    const a = await service.load({ companyId: companyA.id, entity: "invoice", draftKey: "new-sales" });
    const b = await service.load({ companyId: companyB.id, entity: "invoice", draftKey: "new-sales" });
    expect(a.payload.invoiceNo).toBe("FA-2026-0008");
    expect(b.payload.invoiceNo).toBe("AUTRE-DOSSIER");
  });

  test("returning to a dossier finds its work still there", async () => {
    const listed = await service.list({ companyId: companyA.id });
    expect(listed.map((item) => `${item.entity}:${item.draftKey}`).sort()).toEqual([
      "entry:new", "invoice:new-purchases", "invoice:new-sales",
    ]);
  });

  test("a draft leaves with the dossier it belongs to", async () => {
    const doomed = await prisma.company.create({
      data: { name: "DOSSIER SUPPRIMÉ", legalForm: "SARL", ice: "003333333000033", taxId: "IF-3", city: "Rabat" },
    });
    await service.save({ companyId: doomed.id, entity: "entry", draftKey: "new", payload: { label: "x" } });
    await prisma.company.delete({ where: { id: doomed.id } });
    expect(await prisma.formDraft.count({ where: { companyId: doomed.id } })).toBe(0);
  });

  /* ------------------------------------------------------- stale drafts */

  test("a draft started against a record that has since changed is flagged, not applied", async () => {
    await service.save({
      companyId: companyA.id, entity: "invoice", draftKey: "inv_42",
      payload: { invoiceNo: "ANCIENNE SAISIE" }, baseVersion: 3,
    });
    const stale = await service.load({ companyId: companyA.id, entity: "invoice", draftKey: "inv_42", currentVersion: 5 });
    expect(stale.stale).toBe(true);
    // Flagged, but still returned: it is the person's work, and discarding it
    // unasked is the failure this whole module exists to prevent.
    expect(stale.payload.invoiceNo).toBe("ANCIENNE SAISIE");
  });

  test("a draft against an unchanged record is not flagged", async () => {
    const fresh = await service.load({ companyId: companyA.id, entity: "invoice", draftKey: "inv_42", currentVersion: 3 });
    expect(fresh.stale).toBe(false);
  });

  test("a draft with no record behind it is never stale", async () => {
    const held = await service.load({ companyId: companyA.id, entity: "entry", draftKey: "new", currentVersion: 9 });
    expect(held.stale).toBe(false);
  });

  /* --------------------------------------------------------- discarding */

  test("a discard removes exactly one draft", async () => {
    await service.discard({ companyId: companyA.id, entity: "invoice", draftKey: "inv_42" });
    expect(await service.load({ companyId: companyA.id, entity: "invoice", draftKey: "inv_42" })).toBeNull();
    expect(await service.load({ companyId: companyA.id, entity: "invoice", draftKey: "new-sales" })).not.toBeNull();
  });

  test("discarding something that was never held is not an error", async () => {
    const result = await service.discard({ companyId: companyA.id, entity: "invoice", draftKey: "imaginary" });
    expect(result.discarded).toBe(false);
  });

  /* ------------------------------------------------------------ refusals */

  test("a draft for a dossier that no longer exists is refused", async () => {
    await expect(service.save({ companyId: "does-not-exist", entity: "invoice", draftKey: "new", payload: {} }))
      .rejects.toThrow(/n'existe plus/i);
  });

  test("an oversized payload is refused rather than silently truncated", async () => {
    // Truncating somebody's work to fit is the same fault in a different shape.
    await expect(service.save({
      companyId: companyA.id, entity: "invoice", draftKey: "huge",
      payload: { blob: "x".repeat(300_000) },
    })).rejects.toThrow(/taille maximale/i);
  });

  test("a malformed identity is refused", async () => {
    await expect(service.save({ companyId: companyA.id, entity: "", draftKey: "new", payload: {} })).rejects.toThrow(/requis/i);
    await expect(service.save({ companyId: companyA.id, entity: "invoice", draftKey: "a b", payload: {} })).rejects.toThrow(/non autorisés/i);
  });

  test("a payload that cannot be serialised is refused", async () => {
    const cyclic = {};
    cyclic.self = cyclic;
    await expect(service.save({ companyId: companyA.id, entity: "invoice", draftKey: "cyclic", payload: cyclic }))
      .rejects.toThrow(/ne peut pas être enregistrée/i);
  });

  /* ------------------------------------------ drafts are not accounting */

  test("holding a draft creates no accounting record of any kind", async () => {
    const before = {
      invoices: await prisma.invoice.count({ where: { companyId: companyA.id } }),
      entries: await prisma.entry.count({ where: { companyId: companyA.id } }),
      counterparties: await prisma.counterparty.count({ where: { companyId: companyA.id } }),
    };
    await service.save({
      companyId: companyA.id, entity: "invoice", draftKey: "new-sales",
      payload: { invoiceNo: "FA-2026-9999", lines: [{ ht: "10000.00", vat: "2000.00" }] },
    });
    expect({
      invoices: await prisma.invoice.count({ where: { companyId: companyA.id } }),
      entries: await prisma.entry.count({ where: { companyId: companyA.id } }),
      counterparties: await prisma.counterparty.count({ where: { companyId: companyA.id } }),
    }).toEqual(before);
  });

  test("typing does not write to the audit chain", async () => {
    // The chain records what happened to the books. Typing is not that, and
    // burying real events under keystroke noise would change what it means.
    const chained = () => prisma.auditEvent.count({ where: { chain: { companyId: companyA.id } } });
    const logged = () => prisma.activityLog.count({ where: { companyId: companyA.id } });
    const before = { chained: await chained(), logged: await logged() };
    await service.save({ companyId: companyA.id, entity: "entry", draftKey: "new", payload: { label: "encore" } });
    await service.discard({ companyId: companyA.id, entity: "entry", draftKey: "new" });
    expect({ chained: await chained(), logged: await logged() }).toEqual(before);
  });
});

/* ------------------------------------------------------------------------ */

/**
 * Source guards for the renderer half.
 *
 * There is no DOM harness here, so what can be checked is the shape that
 * caused the fault: whether a draft is released anywhere other than a confirmed
 * submission, and whether the shared hook is the thing every form uses.
 */
test.describe("how the forms use it", () => {
  const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

  test("clearing a draft is never in a finally block", () => {
    // A `finally` runs on the failure path too, which would delete the work of
    // somebody whose posting was merely rejected — the exact cruelty the brief
    // singles out.
    for (const file of [["src", "App.tsx"], ["src", "components", "OperationalAccounting.tsx"]]) {
      const source = read(...file);
      for (const match of source.matchAll(/finally\s*\{([\s\S]{0,400}?)\}/g)) {
        expect(match[1], `${file.join("/")} clears a draft in a finally`).not.toMatch(/\.clear\(\)/);
      }
    }
  });

  test("every composer releases its draft only after the service returned", () => {
    const source = read("src", "components", "OperationalAccounting.tsx");
    for (const store of ["invoiceDraftStore", "creditDraftStore", "paymentDraftStore", "counterpartyDraftStore"]) {
      expect(source, `${store} is never cleared`).toContain(`await ${store}.clear()`);
    }
  });

  test("closing a composer does not clear anything", () => {
    const source = read("src", "components", "OperationalAccounting.tsx");
    const close = source.slice(source.indexOf("const closeComposer = () => {"), source.indexOf("const requestConfirmation"));
    expect(close).not.toMatch(/clear\(\)|discardFormDraft/);
  });

  test("the shared hook persists on unmount instead of discarding", () => {
    const hook = read("src", "lib", "useFormDraft.ts");
    const teardown = hook.slice(hook.indexOf("useEffect(() => () => {"));
    expect(teardown).toMatch(/flush\(\)/);
    expect(teardown).not.toMatch(/clear\(\)/);
  });

  test("the forms named in the brief go through the shared hook", () => {
    const operational = read("src", "components", "OperationalAccounting.tsx");
    const app = read("src", "App.tsx");
    expect(operational).toMatch(/useDraftedForm/);
    expect(app).toMatch(/useDraftedForm/);
    for (const entity of ['"invoice"', '"credit_note"', '"payment"', '"counterparty"']) {
      expect(operational, `${entity} has no draft`).toContain(`entity: ${entity}`);
    }
    for (const entity of ['"document_extraction"', '"entry"']) {
      expect(app, `${entity} has no draft`).toContain(`entity: ${entity}`);
    }
  });

  /*
   * The rest of the meaningful composers, wired in the reliability pass. The
   * rule is the same one: what somebody typed is state Wheat is responsible
   * for, not scratch space belonging to a mounted component.
   */
  test("the referential, VAT, reconciliation and fiscal forms hold their work too", () => {
    const books = read("src", "components", "BooksWorkspace13.tsx");
    const compliance = read("src", "components", "ComplianceWorkspace14.tsx");
    const operational = read("src", "components", "OperationalAccounting.tsx");
    const fiscal = read("src", "components", "FiscalWorkspace.tsx");

    for (const entity of ['"settings.company"', '"settings.fiscal_year"', '"settings.account"', '"settings.journal"', '"settings.bank_account"']) {
      expect(books, `${entity} has no draft`).toContain(`entity: ${entity}`);
    }
    expect(compliance, "the VAT configuration has no draft").toContain('entity: "tax_configuration"');
    expect(operational, "the reconciliation review has no draft").toContain('entity: "reconciliation.review"');
    expect(fiscal, "the opening balances have no draft").toContain('entity: "fiscal.opening"');
    expect(fiscal, "the fiscal adjustment has no draft").toContain('entity: "fiscal.adjustment"');
  });

  /*
   * The leak this rule exists to prevent: a form does not empty itself the
   * instant the dossier changes, so for one render its contents belong to the
   * previous dossier while `companyId` already names the new one. Autosaving
   * then files one dossier's unfinished work under another.
   */
  test("autosave is armed per identity, after the read, so work cannot cross dossiers", () => {
    const hook = read("src", "lib", "useFormDraft.ts");
    const drafted = hook.slice(hook.indexOf("export function useDraftedForm"));
    // Writing is gated on the identity the contents were read for.
    expect(drafted).toMatch(/armedFor !== `\$\{companyId\}\|\$\{entity\}\|\$\{draftKey\}`/);
    // The gate is closed on every identity change, and reopened only after the
    // read for the new identity comes back.
    const restore = drafted.slice(drafted.indexOf("restoredFor.current = identity;"));
    expect(restore).toMatch(/setArmedFor\(null\);/);
    expect(restore).toMatch(/setArmedFor\(identity\);/);
    expect(restore.indexOf("setArmedFor(null);")).toBeLessThan(restore.indexOf("setArmedFor(identity);"));
  });

  test("each of them is scoped so two unfinished items cannot overwrite each other", () => {
    const books = read("src", "components", "BooksWorkspace13.tsx");
    const operational = read("src", "components", "OperationalAccounting.tsx");
    const fiscal = read("src", "components", "FiscalWorkspace.tsx");
    // An edit is drafted against the record it edits, a creation against "new".
    expect(books).toContain('draftKey: String(accountForm.id ?? "new")');
    expect(books).toContain('draftKey: String(journalForm.id ?? "new")');
    expect(books).toContain('draftKey: String(fiscalForm.id ?? "new")');
    expect(books).toContain('draftKey: String(bankForm.id ?? "new")');
    // The reconciliation notes belong to one movement and no other.
    expect(operational).toContain('draftKey: selectedMovementId || "none"');
    expect(fiscal).toContain('draftKey: String(fiscal?.id ?? "new")');
  });
});
