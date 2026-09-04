# Smart OCR Organizer Research

## Feasibility

It is feasible to build a useful local-first OCR organizer for Wheat, but not realistic to promise perfect extraction from every scanned document without a stronger document AI layer.

What is realistic offline now:

- Digital PDFs: extract embedded text, tables, and page screenshots with `pdf-parse`.
- Scanned PDFs: rasterize pages and run OCR on the rendered images.
- Common images: OCR for PNG, JPG/JPEG, BMP, WEBP, PBM, and non-animated GIF through Tesseract.js.
- Multi-language OCR: local `fra+eng+ara` trained data for French, English, and Arabic.
- Structured extraction: rules for invoices, bank statements, payroll docs, tax docs, receipts, contracts, identity docs, letters, tables, and unknown docs.
- Smart organization: copy each imported document into `Company / Year / Month / Type / Counterparty`.
- Excel-compatible export: structured rows, separate sheets per document type, detected tables, free-text index, and MAD number formatting.
- Confidence and review: confidence score, uncertain field highlighting, duplicate fingerprinting, and manual correction.

What needs an optional advanced backend later:

- HEIC and TIFF OCR need local conversion support such as Sharp/libvips, ImageMagick, or a Python OCR worker.
- High-quality handwritten extraction is not reliable with Tesseract alone.
- Complex table reconstruction, nested layouts, stamps, logos, signatures, and multi-column reading order are better handled by PaddleOCR PP-Structure, Azure AI Document Intelligence, Google Document AI, AWS Textract, or a vision-language model.
- Template learning should eventually store supplier-specific rules and field corrections per supplier.

## Recommended Stack

Current Wheat implementation:

- `tesseract.js` for offline OCR.
- Bundled local trained data: `fra`, `eng`, `ara`.
- `pdf-parse` for digital PDF text, screenshots, and table extraction.
- Rule-based classifier and extractor in Electron main process.
- SQLite/Prisma document records with structured JSON in `Document.extracted`.
- ExcelJS for structured `.xlsx` export.
- jsPDF for PDF summary export.

Recommended production roadmap:

1. Keep the local Tesseract/pdf-parse engine as the default offline mode.
2. Add an optional Python worker with PaddleOCR PP-Structure for better layout/table extraction.
3. Add optional cloud/server mode connectors for Azure Document Intelligence, Google Document AI, or AWS Textract when internet and privacy policy allow it.
4. Add supplier template learning from user corrections.
5. Add image preprocessing with OpenCV or OCRmyPDF-style pipeline: rotate, denoise, remove background, deskew, clean, and border crop.

## Sources

- Tesseract input formats: https://tesseract-ocr.github.io/tessdoc/InputFormats.html
- Tesseract.js local installation paths: https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md
- Tesseract.js image format support: https://github.com/naptha/tesseract.js/blob/master/docs/image-format.md
- OCRmyPDF preprocessing pipeline: https://ocrmypdf.readthedocs.io/en/latest/cookbook.html
- PaddleOCR PP-Structure overview: https://www.paddleocr.ai/v2.9.1/en/ppstructure/overview.html
- Google Document AI Form Parser: https://docs.cloud.google.com/document-ai/docs/form-parser
- AWS Textract document analysis: https://docs.aws.amazon.com/textract/latest/dg/how-it-works-analyzing.html
- Azure Document Intelligence invoice model: https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/invoice

## Implemented In Wheat

- Smart OCR import route: `atlas:smart-ocr:process`.
- Single-file import from the Electron dialog.
- Single-file drag-and-drop path import when Electron exposes a file path.
- Smart document classification and confidence.
- Structured fields: date, invoice number, reference, counterparty, supplier/client, ICE, IF, HT, TVA, TTC, payment terms, due date, currency, payroll fields.
- Bank transaction row extraction heuristics.
- PDF table extraction and heuristic table parsing.
- Duplicate fingerprinting.
- Manual correction UI.
- Full-text search and type filtering.
- Export formats: `.xlsx`, `.csv`, `.json`, `.pdf`.
- Direct accounting-entry suggestion through `Creer ecriture suggeree`.
