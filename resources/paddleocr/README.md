# Wheat PaddleOCR sidecar

This worker runs PaddleOCR locally and communicates with the Electron main
process through newline-delimited JSON over standard input/output. It never
uploads documents or writes accounting records.

Ordinary documents use the fast Latin PP-OCRv5 mobile detector/recognizer.
Scanned bank tables use PP-StructureV3 for layout and cell reconstruction.

Prepare the isolated runtime and download the pinned models with:

```powershell
npm run paddle:setup
```

The generated `runtime` and warmed `models` directories are deliberately
ignored by Git. When they are present before `npm run installer`, Electron
Builder copies the portable Python runtime and offline models into the Wheat
resources. Without them, Wheat can use a compatible system installation;
otherwise it uses the existing local Tesseract fallback and reports that
PaddleOCR is unavailable.

Runtime overrides for managed installations:

- `WHEAT_PADDLEOCR_PYTHON`: explicit Python executable.
- `WHEAT_PADDLEOCR_WORKER`: explicit `worker.py` path.
- `WHEAT_PADDLEOCR_LANG`: PaddleOCR language code, default `fr`.
- `WHEAT_PADDLEOCR_DEVICE`: inference device, default `cpu`.
- `WHEAT_PADDLEOCR_DETECTION_MODEL`: document text detector, default `PP-OCRv5_mobile_det`.
- `WHEAT_PADDLEOCR_RECOGNITION_MODEL`: document recognizer, default `latin_PP-OCRv5_mobile_rec`.
