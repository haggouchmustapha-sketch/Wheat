import { WHEAT_APP_VERSION } from "../appVersion";

export function createDemoData() {
  const companyId = "demo-company-wheat";
  const accounts = [
    { id: "a342", companyId, code: "342100", label: "Clients", classNo: 3, type: "ASSET", active: true },
    { id: "a441", companyId, code: "441100", label: "Fournisseurs", classNo: 4, type: "LIABILITY", active: true },
    { id: "a4455", companyId, code: "445500", label: "Etat - TVA facturée", classNo: 4, type: "LIABILITY", active: true },
    { id: "a3455", companyId, code: "345520", label: "TVA récupérable sur charges", classNo: 3, type: "ASSET", active: true },
    { id: "a514", companyId, code: "514100", label: "Banques", classNo: 5, type: "ASSET", active: true },
    { id: "a611", companyId, code: "611100", label: "Achats de marchandises", classNo: 6, type: "EXPENSE", active: true },
    { id: "a614", companyId, code: "614100", label: "Locations et charges locatives", classNo: 6, type: "EXPENSE", active: true },
    { id: "a711", companyId, code: "711100", label: "Ventes de marchandises", classNo: 7, type: "REVENUE", active: true },
  ];

  const journals = [
    { id: "jve", companyId, code: "VE", label: "Ventes", nextNumber: 88, locked: false },
    { id: "jac", companyId, code: "AC", label: "Achats", nextNumber: 144, locked: false },
    { id: "jbq", companyId, code: "BQ", label: "Banque", nextNumber: 157, locked: false },
    { id: "jod", companyId, code: "OD", label: "Opérations diverses", nextNumber: 246, locked: false },
  ];

  const entries = [
    {
      id: "e1",
      companyId,
      journalId: "jve",
      number: "VE-2026-000087",
      date: "2026-05-30T00:00:00.000Z",
      pieceNumber: "FA-2026-1287",
      label: "Clients - Facture FA-2026-1287",
      status: "VALIDATED",
      source: "SEED",
      journal: journals[0],
      lines: [
        { id: "l1", account: accounts[0], accountId: "a342", label: "Client Groupe Toubkal", debit: 25000, credit: 0 },
        { id: "l2", account: accounts[7], accountId: "a711", label: "Prestations", debit: 0, credit: 20833.33 },
        { id: "l3", account: accounts[2], accountId: "a4455", label: "TVA facturée", debit: 0, credit: 4166.67 },
      ],
    },
    {
      id: "e2",
      companyId,
      journalId: "jbq",
      number: "BQ-2026-000156",
      date: "2026-05-30T00:00:00.000Z",
      pieceNumber: "VIR-BMCI-156",
      label: "BMCI - Virement reçu",
      status: "VALIDATED",
      source: "SEED",
      journal: journals[2],
      lines: [
        { id: "l4", account: accounts[4], accountId: "a514", label: "Encaissement", debit: 18500, credit: 0 },
        { id: "l5", account: accounts[0], accountId: "a342", label: "Règlement client", debit: 0, credit: 18500 },
      ],
    },
    {
      id: "e3",
      companyId,
      journalId: "jac",
      number: "AC-2026-000143",
      date: "2026-05-29T00:00:00.000Z",
      pieceNumber: "FR-9876",
      label: "Fournisseurs - Facture FR-9876",
      status: "VALIDATED",
      source: "SEED",
      journal: journals[1],
      lines: [
        { id: "l6", account: accounts[5], accountId: "a611", label: "Achats", debit: 13000, credit: 0 },
        { id: "l7", account: accounts[3], accountId: "a3455", label: "TVA récupérable", debit: 2600, credit: 0 },
        { id: "l8", account: accounts[1], accountId: "a441", label: "Fournisseur", debit: 0, credit: 15600 },
      ],
    },
  ];

  return {
    appVersion: WHEAT_APP_VERSION,
    databasePath: "Mode navigateur demo",
    user: { id: "u1", name: "M. Amine B.", email: "amine@wheat.local", role: "ADMIN", twoFactorOn: true },
    activeCompanyId: companyId,
    companies: [
      {
        id: companyId,
        name: "SOCIÉTÉ TOUBKAL SARL",
        legalForm: "SARL",
        ice: "001589742000063",
        taxId: "IF 48291073",
        city: "Casablanca",
        baseCurrency: "MAD",
        accounts,
        journals,
        fiscalYears: [
          { id: "fy2025", companyId, label: "Exercice 2025", startsOn: "2025-01-01T00:00:00.000Z", endsOn: "2025-12-31T00:00:00.000Z", lockedTo: "2025-12-31T00:00:00.000Z", status: "CLOSED" },
          { id: "fy2026", companyId, label: "Exercice 2026", startsOn: "2026-01-01T00:00:00.000Z", endsOn: "2026-12-31T00:00:00.000Z", lockedTo: "2026-03-31T00:00:00.000Z", status: "OPEN" },
        ],
        _count: { entries: entries.length, invoices: 4, documents: 2, employees: 3 },
      },
      {
        id: "demo-company-trading",
        name: "MAGHREB TRADING",
        legalForm: "SARL AU",
        ice: "002741963000017",
        taxId: "IF 39048122",
        city: "Rabat",
        baseCurrency: "MAD",
        accounts,
        journals,
        fiscalYears: [],
        _count: { entries: 12, invoices: 21, documents: 7, employees: 2 },
      },
    ],
    entries,
    invoices: [
      { id: "i1", companyId, kind: "SALE", counterparty: "Groupe Toubkal Distribution", ice: "001589742000063", invoiceNo: "FA-2026-1287", invoiceDate: "2026-05-30T00:00:00.000Z", dueDate: "2026-07-29T00:00:00.000Z", ht: 20833.33, vat: 4166.67, ttc: 25000, status: "UNPAID", paymentMethod: "Virement" },
      { id: "i2", companyId, kind: "SALE", counterparty: "Riad Services SARL", ice: "001372951000048", invoiceNo: "FA-2026-1244", invoiceDate: "2026-02-14T00:00:00.000Z", dueDate: "2026-04-14T00:00:00.000Z", ht: 72000, vat: 14400, ttc: 86400, status: "OVERDUE", paymentMethod: "Chèque" },
      { id: "i3", companyId, kind: "PURCHASE", counterparty: "Techno Bureau Maroc", ice: "000894112000089", invoiceNo: "FR-9876", invoiceDate: "2026-05-29T00:00:00.000Z", dueDate: "2026-06-28T00:00:00.000Z", ht: 13000, vat: 2600, ttc: 15600, status: "UNPAID", paymentMethod: "Virement" },
      { id: "i4", companyId, kind: "PURCHASE", counterparty: "Maroc Leasing", ice: "000456777000011", invoiceNo: "ML-2026-0081", invoiceDate: "2026-01-20T00:00:00.000Z", dueDate: "2026-03-20T00:00:00.000Z", paymentDate: "2026-05-02T00:00:00.000Z", ht: 184000, vat: 36800, ttc: 220800, status: "PAID_LATE", paymentMethod: "Prélèvement" },
    ],
    documents: [
      { id: "d1", companyId, title: "Facture Techno Bureau FR-9876.pdf", type: "Facture fournisseur", fiscalYear: "2026", tags: "achat,tva,ocr", ocrText: "Techno Bureau Maroc ICE 000894112000089 HT 13000 TVA 2600 TTC 15600", extracted: JSON.stringify({ supplier: "Techno Bureau Maroc", ice: "000894112000089", date: "2026-05-29", ht: 13000, vat: 2600, ttc: 15600 }), status: "EXTRACTED", createdAt: "2026-05-29T00:00:00.000Z" },
      { id: "d2", companyId, title: "Relevé BMCI Mai 2026.xlsx", type: "Relevé bancaire", fiscalYear: "2026", tags: "banque,rapprochement", ocrText: "BMCI VIR GROUPE TOUBKAL FA-1287 FRAIS BANCAIRES", extracted: JSON.stringify({ bank: "BMCI", period: "Mai 2026", movements: 34 }), status: "LINKED", createdAt: "2026-05-30T00:00:00.000Z" },
    ],
    bankAccounts: [
      {
        id: "b1",
        companyId,
        bankName: "BMCI - Compte principal",
        iban: "01178000012100000000",
        balance: 3245680.45,
        currency: "MAD",
        movements: [
          { id: "m1", bankAccountId: "b1", date: "2026-05-30T00:00:00.000Z", label: "VIR GROUPE TOUBKAL FA-1287", amount: 18500, reference: "VIR-BMCI-156", status: "MATCHED", confidence: 97 },
          { id: "m2", bankAccountId: "b1", date: "2026-05-28T00:00:00.000Z", label: "FRAIS BANCAIRES MAI 2026", amount: -350, reference: "FB-05-2026", status: "SUGGESTED", confidence: 86 },
        ],
      },
      { id: "b2", companyId, bankName: "Attijariwafa bank", iban: "00778000023100000000", balance: 2156234.12, currency: "MAD", movements: [] },
      { id: "b3", companyId, bankName: "CIH Bank", iban: "23078000034100000000", balance: 1842107.35, currency: "MAD", movements: [] },
    ],
    taxPeriods: [{ id: "t1", companyId, label: "TVA Mai 2026", collectedVat: 4925140.75, deductibleVat: 3048720.57, dueVat: 1876420.18, creditVat: 231250, status: "TO_FILE", declarationDue: "2026-06-20T00:00:00.000Z" }],
    employees: [
      { id: "p1", companyId, fullName: "Salma El Idrissi", cin: "BK245178", cnss: "183456789", position: "Comptable senior", grossSalary: 12500, cnssEmployee: 560, amoEmployee: 275, ir: 1450, netSalary: 10215 },
      { id: "p2", companyId, fullName: "Yassine Berrada", cin: "BE339901", cnss: "284991001", position: "Assistant comptable", grossSalary: 7200, cnssEmployee: 322.56, amoEmployee: 158.4, ir: 475, netSalary: 6244.04 },
      { id: "p3", companyId, fullName: "Nora Ait Lahcen", cin: "EE148520", cnss: "392810445", position: "Réviseur", grossSalary: 9800, cnssEmployee: 439.04, amoEmployee: 215.6, ir: 920, netSalary: 8225.36 },
    ],
    activityLogs: [
      { id: "al1", companyId, action: "LOGIN", entity: "Session", description: "Connexion locale avec authentification mock", createdAt: "2026-05-20T09:15:00.000Z", user: { name: "M. Amine B." } },
      { id: "al2", companyId, action: "OCR_EXTRACT", entity: "Document", description: "Extraction OCR pour FR-9876 avec proposition d'écriture", createdAt: "2026-05-20T09:20:00.000Z", user: { name: "M. Amine B." } },
    ],
  };
}
