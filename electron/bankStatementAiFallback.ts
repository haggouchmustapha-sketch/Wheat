import { corroborated, parseReviewJson, type AiReviewChat } from "./ocrAiReview";
import { looksLikeStatementAmount } from "./reconciliation";

/**
 * The last resort when a scanned statement's own table cannot be reconstructed.
 *
 * The deterministic path comes first and stays the default: embedded text, then
 * local layout recognition, then the geometric table reconstruction and the
 * heading repairs. This runs only when that path has finished and left
 * something a person cannot work with — a movement row with no date, or with no
 * amount on either side. A statement Wheat read completely never reaches here.
 *
 * It reuses the document reviewer's provider, its consent rules and its
 * anti-invention gate rather than introducing a second AI subsystem, and it
 * works from the recognised **text** — no page images — so any model that can
 * hold a conversation is compatible. That is deliberate: choosing a model,
 * sending the request and only then discovering it cannot read images is a
 * failure Wheat can avoid entirely by not needing them.
 *
 * Three rules make the result safe to show an accountant:
 *
 *   1. **It fills, it never overwrites.** A cell the local path read is left
 *      exactly as the local path read it. Only empty cells can be filled.
 *   2. **Every value must be findable in the recognised text.** A date or an
 *      amount that appears nowhere on the page is discarded, whatever the model
 *      says. It may re-read the page; it may not compose one.
 *   3. **A filled cell is a proposal.** Every row it touched is named in the
 *      warnings and marked for review, so nothing it supplied reaches the
 *      ledger without somebody having looked at it.
 */

export type BankAiFallbackTable = {
  headers: string[];
  rows: Array<Record<string, string>>;
  warnings: string[];
};

export type BankAiFallbackMapping = {
  date?: string;
  valueDate?: string;
  label?: string;
  reference?: string;
  debit?: string;
  credit?: string;
  amount?: string;
};

export type BankAiFallbackResult = {
  table: BankAiFallbackTable;
  /** Whether anything was actually filled. */
  applied: boolean;
  provider: string;
  modelId: string;
  /** 1-based row numbers the fallback contributed to. Always shown for review. */
  filledRows: number[];
  notes: string[];
};

const SYSTEM_PROMPT = [
  "Tu relis les lignes d'un releve bancaire marocain deja reconnu par OCR.",
  "Reponds uniquement par un objet JSON, sans texte autour et sans bloc de code.",
  "Format : {\"rows\": [{\"index\": <numero de ligne fourni>, \"date\": \"JJ MM\", \"valueDate\": \"JJ MM AAAA\", \"debit\": \"1 234,56\", \"credit\": \"1 234,56\"}]}.",
  "N'invente jamais un montant, une date ou un libelle absent du texte reconnu.",
  "Si une valeur est illisible, omets la cle. Si une ligne n'est pas un mouvement, omets la ligne.",
  "Recopie les montants exactement comme ils sont imprimes, avec leurs separateurs.",
  "Un mouvement porte un debit OU un credit, jamais les deux.",
];

const FILLABLE = ["date", "valueDate", "debit", "credit"] as const;

/** A movement row Wheat could not finish reading on its own. */
function isIncomplete(row: Record<string, string>, mapping: BankAiFallbackMapping): boolean {
  const dateMissing = Boolean(mapping.date) && !String(row[mapping.date!] ?? "").trim();
  const hasAmount = [mapping.amount, mapping.debit, mapping.credit]
    .filter((column): column is string => Boolean(column))
    .some((column) => looksLikeStatementAmount(row[column]));
  return dateMissing || !hasAmount;
}

/**
 * Rows the local path left unusable, with their 1-based numbers. Returned so
 * the caller can decide whether asking a model is warranted at all.
 */
export function incompleteMovementRows(
  table: BankAiFallbackTable,
  mapping: BankAiFallbackMapping,
  isMovement: (row: Record<string, string>) => boolean,
): number[] {
  return table.rows
    .map((row, index) => ({ row, number: index + 1 }))
    .filter(({ row }) => isMovement(row) && isIncomplete(row, mapping))
    .map(({ number }) => number);
}

export async function completeBankTableWithAi(input: {
  table: BankAiFallbackTable;
  mapping: BankAiFallbackMapping;
  /** The full recognised text of the statement, used as the evidence corpus. */
  recognisedText: string;
  /** Rows to ask about, 1-based, as returned by `incompleteMovementRows`. */
  rowNumbers: number[];
  chat: AiReviewChat;
}): Promise<BankAiFallbackResult> {
  const base: BankAiFallbackResult = {
    table: input.table, applied: false, provider: "", modelId: "", filledRows: [], notes: [],
  };
  const text = String(input.recognisedText ?? "").trim();
  if (!input.rowNumbers.length) return base;
  if (text.length < 40) return { ...base, notes: ["Texte reconnu trop court pour une relecture assistée."] };

  const asked = input.rowNumbers.map((number) => ({
    index: number,
    current: Object.fromEntries(
      FILLABLE
        .map((field) => [field, input.mapping[field] ? input.table.rows[number - 1]?.[input.mapping[field]!] ?? "" : ""])
        .filter(([, value]) => value !== undefined),
    ),
    raw: input.table.rows[number - 1],
  }));

  const user = [
    "Lignes incompletes a relire (numero, valeurs deja lues, cellules brutes) :",
    JSON.stringify(asked).slice(0, 12_000),
    `Texte reconnu du releve :\n${text.slice(0, 24_000)}`,
  ].join("\n\n");

  let reply: { text: string; provider: string; modelId: string };
  try {
    reply = await input.chat({ system: SYSTEM_PROMPT.join(" "), user });
  } catch (error) {
    return { ...base, notes: [`Relecture assistée indisponible : ${error instanceof Error ? error.message : String(error)}`] };
  }

  const parsed = parseReviewJson(reply.text);
  const proposals = Array.isArray(parsed?.rows) ? parsed!.rows : null;
  if (!proposals) {
    return { ...base, provider: reply.provider, modelId: reply.modelId, notes: ["La relecture assistée n'a pas renvoyé de lignes exploitables."] };
  }

  const rows = input.table.rows.map((row) => ({ ...row }));
  const notes: string[] = [];
  const filledRows = new Set<number>();
  const allowed = new Set(input.rowNumbers);

  for (const proposal of proposals) {
    if (!proposal || typeof proposal !== "object") continue;
    const number = Number((proposal as Record<string, unknown>).index);
    // Only the rows Wheat asked about, and only rows that exist.
    if (!Number.isInteger(number) || !allowed.has(number) || !rows[number - 1]) continue;
    const target = rows[number - 1];

    for (const field of FILLABLE) {
      const column = input.mapping[field];
      if (!column) continue;
      const suggestion = String((proposal as Record<string, unknown>)[field] ?? "").trim();
      if (!suggestion) continue;
      // Rule 1: an existing reading is never replaced.
      if (String(target[column] ?? "").trim()) continue;
      // Rule 2: it must be on the page.
      if (!corroborated(text, suggestion)) {
        notes.push(`Ligne ${number}, ${field} : valeur proposée absente du texte reconnu, ignorée.`);
        continue;
      }
      if ((field === "debit" || field === "credit") && !looksLikeStatementAmount(suggestion)) {
        notes.push(`Ligne ${number}, ${field} : « ${suggestion} » n'est pas un montant, ignoré.`);
        continue;
      }
      target[column] = suggestion;
      filledRows.add(number);
    }

    // A movement carries one side. If the fallback produced both, neither is
    // trustworthy and the row is left exactly as the local path left it.
    const debitColumn = input.mapping.debit;
    const creditColumn = input.mapping.credit;
    if (debitColumn && creditColumn && looksLikeStatementAmount(target[debitColumn]) && looksLikeStatementAmount(target[creditColumn])) {
      rows[number - 1] = { ...input.table.rows[number - 1] };
      filledRows.delete(number);
      notes.push(`Ligne ${number} : la relecture assistée propose un débit et un crédit sur la même ligne ; la ligne reste telle que lue localement.`);
    }
  }

  const filled = [...filledRows].sort((left, right) => left - right);
  if (!filled.length) {
    return { ...base, provider: reply.provider, modelId: reply.modelId, notes };
  }

  return {
    table: {
      headers: input.table.headers,
      rows,
      warnings: [
        ...input.table.warnings,
        `Relecture assistée par Wheat AI : ${filled.length} ligne(s) complétée(s) à partir du texte reconnu (ligne(s) ${filled.join(", ")}). Chaque valeur ainsi proposée doit être vérifiée sur le relevé avant confirmation.`,
        ...notes,
      ],
    },
    applied: true,
    provider: reply.provider,
    modelId: reply.modelId,
    filledRows: filled,
    notes,
  };
}
