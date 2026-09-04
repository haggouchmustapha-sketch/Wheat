# Wheat 2.1.1

- Upgraded Wheat AI into a broad local accounting agent with 95 typed capabilities across 19 product areas.
- Added strict intent checks, company and role scoping, four risk levels, dry-run previews, explicit confirmations, and optimistic concurrency protection.
- Added audited multi-step and bulk execution with bounded progress, partial-failure reporting, and affected-record links.
- Reused Wheat's domain services for exact-cent entries, accounts, journals, invoices, payments, banking, payroll, VAT, fiscal workpapers, reports, documents, and settings.
- Improved the Wheat AI workspace with structured proposals, preview cards, progress and error states, result summaries, and safe in-app navigation.
- Preserved the local-only security boundary: no raw SQL, raw Prisma, shell, arbitrary filesystem, or silent statutory filing capability is exposed to the model.
- Included the automatic updater workflow so this release package can be discovered, checksum-verified, staged, and installed with recovery support.
