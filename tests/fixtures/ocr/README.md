# Recognised-document fixtures

Each JSON file is a verbatim PaddleOCR result — text, per-element confidence and
polygon bounding boxes — captured from one of the documents in
`test documents for use/` by running Wheat's own recognition path.

They exist so the document-understanding layer can be tested without running
recognition: the tests that use them assert what Wheat *makes of* a recognised
page, and would otherwise be measuring the recogniser at the same time. When a
field regresses, the fixture says immediately whether the characters were there
to be read.

Do not hand-edit these files. Re-record them from the source document if the
recognition stack changes, and note in the commit which document produced which
file:

| Fixture | Source document | What it exercises |
| --- | --- | --- |
| `scanned-invoice-debours-ifcof.json` | `SFKT141P26081319210.pdf`, page 1, rasterised as Wheat rasterises it | Abbreviated invoice label (`FACT°`), two ICE numbers, disbursements outside the taxable base |
| `scanned-invoice-offset-totals-column.json` | `SFKT141P26081319260.pdf` | A totals column printed one row below its labels — proximity alone reads it wrong |
| `photo-invoice-comadeb.json` | `WhatsApp Image 2026-08-21 at 00.59.54.jpeg` | Phone photo, customer named on a labelled line, issuer identifiers spread over three footer lines, a duplicated decimal group in the total |
| `photo-invoice-lakhouili.json` | `WhatsApp Image 2026-08-13 at 23.31.16.png` | Phone photo whose HT was misread by one digit: the totals must fail their own arithmetic |
| `scanned-bank-statement.json` | `Whatsapp Scan 9 juillet 2026 at 15.46.15.pdf` | A document that is not an invoice and must not acquire invoice fields |
