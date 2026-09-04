export const money = (value: number | string, currency = "MAD") =>
  new Intl.NumberFormat("fr-MA", {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "MAD" ? 2 : 2,
  }).format(Number(value || 0)).replace(/\u00a0/g, " ");

export const number = (value: number | string) =>
  new Intl.NumberFormat("fr-MA", { maximumFractionDigits: 2 }).format(Number(value || 0));

export const date = (value: string | Date | null | undefined) =>
  value === null || value === undefined || value === ""
    ? "—"
    : new Intl.DateTimeFormat("fr-MA", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value));

export const daysBetween = (from: string | Date | null | undefined, to: string | Date = new Date()) => {
  if (from === null || from === undefined || from === "") return Number.NaN;
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  return Math.ceil((end - start) / 86_400_000);
};

export const percent = (value: number) =>
  `${new Intl.NumberFormat("fr-MA", { maximumFractionDigits: 1 }).format(value)}%`;

export const statusLabel = (status: string) =>
  ({
    VALIDATED: "Validée",
    DRAFT: "Brouillon",
    POSTED: "Comptabilisée",
    REVERSED: "Extournée",
    PENDING: "En attente",
    UNPAID: "Impayée",
    OVERDUE: "En retard",
    PAID_LATE: "Payée en retard",
    TO_FILE: "À déclarer",
    EXTRACTED: "OCR prêt",
    LINKED: "Lié",
    MATCHED: "Lettré",
    SUGGESTED: "Suggestion",
  })[status] ?? status;
