#!/usr/bin/env python3
"""Local-only PaddleOCR JSON-line worker for Wheat.

The protocol accepts paths only. Wheat creates private temporary files for image
buffers and removes them after inference, so document bytes never leave the PC.
"""

from __future__ import annotations

import contextlib
import gc
import html
import importlib.metadata
import json
import os
import re
import sys
import traceback
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterable


PROTOCOL_OUT = sys.stdout
LANGUAGE = os.environ.get("WHEAT_PADDLEOCR_LANG", "fr").strip() or "fr"
DEVICE = os.environ.get("WHEAT_PADDLEOCR_DEVICE", "cpu").strip() or "cpu"
OCR_DETECTION_MODEL = os.environ.get("WHEAT_PADDLEOCR_DETECTION_MODEL", "PP-OCRv5_mobile_det").strip() or "PP-OCRv5_mobile_det"
OCR_RECOGNITION_MODEL = os.environ.get("WHEAT_PADDLEOCR_RECOGNITION_MODEL", "latin_PP-OCRv5_mobile_rec").strip() or "latin_PP-OCRv5_mobile_rec"
# Document- and textline-orientation classification.
#
# `PP-LCNet_x1_0_doc_ori` and `PP-LCNet_x1_0_textline_ori` ship inside
# `resources/paddleocr/models/official_models`, so turning them on costs no
# download and no network access. They are what lets a page scanned sideways or
# upside down, or a receipt photographed at an angle, still read correctly:
# without them a rotated page produces confident nonsense. Unwarping stays off
# because its `UVDoc` model is not bundled and PaddleOCR would try to fetch it.
#
# Every pipeline construction falls back to the previous, orientation-free
# options if this PaddleOCR build refuses the arguments, so an older runtime
# keeps working exactly as before.
ORIENTATION_ENABLED = os.environ.get("WHEAT_PADDLEOCR_ORIENTATION", "1").strip().lower() not in {"0", "false", "no"}
# How many threads this sidecar may use. Wheat runs a small pool of workers and
# divides the machine between them, so the previous unconditional "up to four"
# meant every member of a three-member pool claimed four cores and they spent
# their time contending instead of recognising.
def _cpu_threads() -> int:
    configured = os.environ.get("WHEAT_PADDLEOCR_CPU_THREADS", "").strip()
    if configured.isdigit() and int(configured) >= 1:
        return min(8, int(configured))
    return max(1, min(4, os.cpu_count() or 1))


CPU_THREADS = _cpu_threads()
MAX_INPUT_BYTES = 50_000_000
ALLOWED_SUFFIXES = {
    ".avif", ".bmp", ".gif", ".heic", ".heif", ".jpeg", ".jpg",
    ".pdf", ".png", ".tif", ".tiff", ".webp",
}

# One pipeline per mode, kept for the life of the process.
#
# This used to be a single slot that was thrown away whenever the mode changed,
# so a batch that alternated invoices (`ocr`) and bank statements (`structure`)
# reloaded a model between every document. Both fit in memory together; the
# reload did not fit in anybody's patience.
_pipelines: dict[str, Any] = {}


class _TableParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: list[list[list[str]]] = []
        self._table: list[list[str]] | None = None
        self._row: list[str] | None = None
        self._cell: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        del attrs
        tag = tag.lower()
        if tag == "table":
            self._table = []
        elif tag == "tr" and self._table is not None:
            self._row = []
        elif tag in {"td", "th"} and self._row is not None:
            self._cell = []
        elif tag == "br" and self._cell is not None:
            self._cell.append(" ")

    def handle_data(self, data: str) -> None:
        if self._cell is not None:
            self._cell.append(data)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in {"td", "th"} and self._cell is not None and self._row is not None:
            self._row.append(_clean_text("".join(self._cell)))
            self._cell = None
        elif tag == "tr" and self._row is not None and self._table is not None:
            if any(self._row):
                self._table.append(self._row)
            self._row = None
        elif tag == "table" and self._table is not None:
            if self._table:
                self.tables.append(self._table)
            self._table = None


def _emit(payload: dict[str, Any]) -> None:
    PROTOCOL_OUT.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    PROTOCOL_OUT.flush()


def _clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", html.unescape(str(value or ""))).strip()


def _version(distribution: str) -> str | None:
    try:
        return importlib.metadata.version(distribution)
    except importlib.metadata.PackageNotFoundError:
        return None


def _health() -> dict[str, Any]:
    version = _version("paddleocr")
    paddle_version = _version("paddlepaddle")
    available = bool(version and paddle_version)
    reason = None if available else (
        "Installez le runtime local avec npm run paddle:setup "
        "(PaddleOCR et PaddlePaddle sont absents de ce Python)."
    )
    return {
        "available": available,
        "version": version,
        "paddleVersion": paddle_version,
        "pythonVersion": sys.version.split()[0],
        "language": LANGUAGE,
        "device": DEVICE,
        "orientation": ORIENTATION_ENABLED,
        "cpuThreads": CPU_THREADS,
        "reason": reason,
    }


def _build(factory: Any, options: dict[str, Any], degraded_keys: tuple[str, ...] = ()) -> Any:
    """Constructs a pipeline, degrading rather than failing.

    A PaddleOCR build that rejects an argument raises `TypeError`; an
    orientation model that cannot be loaded raises something else entirely.
    Both fall back to the orientation-free options that Wheat used before, so a
    runtime mismatch degrades accuracy instead of breaking OCR outright.
    """
    try:
        return factory(**options)
    except TypeError:
        if degraded_keys:
            reduced = {key: options[key] for key in degraded_keys if key in options}
            try:
                return factory(**reduced)
            except Exception:
                pass
        raise
    except Exception:
        if not any(options.get(key) for key in ("use_doc_orientation_classify", "use_textline_orientation")):
            raise
        safe = dict(options)
        safe["use_doc_orientation_classify"] = False
        safe["use_textline_orientation"] = False
        return factory(**safe)


def _new_pipeline(mode: str) -> Any:
    with contextlib.redirect_stdout(sys.stderr):
        if mode == "vl":
            from paddleocr import PaddleOCRVL

            return _build(PaddleOCRVL, {
                "pipeline_version": "v1.6",
                "device": DEVICE,
                "use_doc_orientation_classify": ORIENTATION_ENABLED,
                "use_doc_unwarping": False,
            })

        if mode == "structure":
            from paddleocr import PPStructureV3

            options = {
                "lang": LANGUAGE,
                "device": DEVICE,
                "text_detection_model_name": OCR_DETECTION_MODEL,
                "text_recognition_model_name": OCR_RECOGNITION_MODEL,
                "use_doc_orientation_classify": ORIENTATION_ENABLED,
                "use_doc_unwarping": False,
                "use_textline_orientation": ORIENTATION_ENABLED,
                "use_table_recognition": True,
                "use_formula_recognition": False,
                "use_chart_recognition": False,
                "use_seal_recognition": False,
                "enable_mkldnn": False,
                "cpu_threads": CPU_THREADS,
            }
            return _build(PPStructureV3, options, (
                "lang", "device", "text_detection_model_name",
                "text_recognition_model_name", "use_doc_orientation_classify",
                "use_doc_unwarping", "use_textline_orientation",
            ))

        from paddleocr import PaddleOCR

        return _build(PaddleOCR, {
            "lang": LANGUAGE,
            "device": DEVICE,
            "text_detection_model_name": OCR_DETECTION_MODEL,
            "text_recognition_model_name": OCR_RECOGNITION_MODEL,
            "use_doc_orientation_classify": ORIENTATION_ENABLED,
            "use_doc_unwarping": False,
            "use_textline_orientation": ORIENTATION_ENABLED,
            "text_det_limit_side_len": 1800,
            "text_det_limit_type": "max",
            "enable_mkldnn": False,
            "cpu_threads": CPU_THREADS,
        })


def _get_pipeline(mode: str) -> Any:
    pipeline = _pipelines.get(mode)
    if pipeline is not None:
        return pipeline
    gc.collect()
    pipeline = _new_pipeline(mode)
    _pipelines[mode] = pipeline
    return pipeline


def _plain(value: Any, depth: int = 0) -> Any:
    if depth > 16:
        return None
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        output: dict[str, Any] = {}
        for key, item in value.items():
            name = str(key)
            if name.lower() in {
                "input_img", "output_img", "doc_preprocessed_img", "markdown_images",
                "table_cell_img", "imgs_in_doc",
            }:
                continue
            output[name] = _plain(item, depth + 1)
        return output
    if isinstance(value, (list, tuple)):
        return [_plain(item, depth + 1) for item in value]
    if hasattr(value, "tolist"):
        try:
            return _plain(value.tolist(), depth + 1)
        except Exception:
            return None
    return str(value)


def _result_payload(result: Any) -> dict[str, Any]:
    value = getattr(result, "json", None)
    if callable(value):
        value = value()
    if value is None and isinstance(result, dict):
        value = result
    if isinstance(value, str):
        value = json.loads(value)
    value = _plain(value)
    return value if isinstance(value, dict) else {}


def _walk(value: Any) -> Iterable[tuple[str, Any]]:
    if isinstance(value, dict):
        for key, item in value.items():
            yield str(key), item
            yield from _walk(item)
    elif isinstance(value, list):
        for item in value:
            yield from _walk(item)


def _find_lists(root: dict[str, Any], names: set[str]) -> list[list[Any]]:
    found: list[list[Any]] = []
    for key, value in _walk(root):
        if key in names and isinstance(value, list) and value:
            found.append(value)
    return found


def _bbox(polygon: Any) -> dict[str, float] | None:
    if not isinstance(polygon, list) or not polygon:
        return None
    if len(polygon) == 4 and all(isinstance(value, (int, float)) for value in polygon):
        return {"x0": float(polygon[0]), "y0": float(polygon[1]), "x1": float(polygon[2]), "y1": float(polygon[3])}
    points = [point for point in polygon if isinstance(point, list) and len(point) >= 2]
    if not points:
        return None
    xs = [float(point[0]) for point in points]
    ys = [float(point[1]) for point in points]
    return {"x0": min(xs), "y0": min(ys), "x1": max(xs), "y1": max(ys)}


def _extract_words(payloads: list[dict[str, Any]]) -> list[dict[str, Any]]:
    words: list[dict[str, Any]] = []
    for page_index, payload in enumerate(payloads, start=1):
        text_lists = _find_lists(payload, {"rec_texts", "text", "texts"})
        score_lists = _find_lists(payload, {"rec_scores", "text_rec_score", "scores"})
        polygon_lists = _find_lists(payload, {"dt_polys", "rec_polys", "text_det_polygons"})
        texts = next((items for items in text_lists if all(isinstance(item, str) for item in items)), [])
        scores = next((items for items in score_lists if all(isinstance(item, (int, float)) for item in items)), [])
        polygons = next((items for items in polygon_lists if isinstance(items, list)), [])
        for index, raw_text in enumerate(texts):
            text = _clean_text(raw_text)
            if not text:
                continue
            raw_score = float(scores[index]) if index < len(scores) else 0.0
            confidence = raw_score * 100 if raw_score <= 1 else raw_score
            item: dict[str, Any] = {"text": text, "confidence": round(max(0.0, min(100.0, confidence))), "page": page_index}
            if index < len(polygons):
                box = _bbox(polygons[index])
                if box:
                    item["bbox"] = box
            words.append(item)
    return words


def _markdown_table(value: str) -> list[list[str]] | None:
    lines = [line.strip() for line in value.splitlines() if line.strip().startswith("|") and line.count("|") >= 3]
    if len(lines) < 3:
        return None
    rows = [[_clean_text(cell) for cell in line.strip("|").split("|")] for line in lines]
    rows = [row for row in rows if not all(re.fullmatch(r":?-{2,}:?", cell or "") for cell in row)]
    return rows if len(rows) >= 2 else None


def _extract_tables(payloads: list[dict[str, Any]]) -> list[list[list[str]]]:
    tables: list[list[list[str]]] = []
    seen: set[str] = set()
    strings: list[str] = []
    for payload in payloads:
        for key, value in _walk(payload):
            if not isinstance(value, str):
                continue
            lowered = key.lower()
            if "html" in lowered or ("content" in lowered and ("<table" in value.lower() or "|" in value)):
                strings.append(value)
    for value in strings:
        parsed: list[list[list[str]]] = []
        if "<table" in value.lower():
            parser = _TableParser()
            parser.feed(value)
            parsed.extend(parser.tables)
        markdown = _markdown_table(value)
        if markdown:
            parsed.append(markdown)
        for table in parsed:
            normalized = [[_clean_text(cell) for cell in row] for row in table if any(_clean_text(cell) for cell in row)]
            key = json.dumps(normalized, ensure_ascii=False)
            if len(normalized) >= 2 and key not in seen:
                seen.add(key)
                tables.append(normalized)
    return tables


def _fallback_text(payloads: list[dict[str, Any]]) -> str:
    blocks: list[str] = []
    for payload in payloads:
        for key, value in _walk(payload):
            if key == "block_content" and isinstance(value, str) and "<table" not in value.lower():
                content = _clean_text(value)
                if content and content not in blocks:
                    blocks.append(content)
    return "\n".join(blocks)


def _recognize(input_path: str, mode: str) -> dict[str, Any]:
    source = Path(input_path).resolve(strict=True)
    if source.suffix.lower() not in ALLOWED_SUFFIXES:
        raise ValueError("Format d'image/PDF non autorisé pour PaddleOCR.")
    if source.stat().st_size <= 0 or source.stat().st_size > MAX_INPUT_BYTES:
        raise ValueError("Le fichier OCR est vide ou dépasse la limite locale de 50 Mo.")
    if mode not in {"ocr", "structure", "vl"}:
        raise ValueError("Mode PaddleOCR invalide.")
    pipeline = _get_pipeline(mode)
    with contextlib.redirect_stdout(sys.stderr):
        results = list(pipeline.predict(input=str(source)))
    payloads = [_result_payload(result) for result in results]
    words = _extract_words(payloads)
    text = "\n".join(word["text"] for word in words)
    if not text:
        text = _fallback_text(payloads)
    confidences = [float(word["confidence"]) for word in words if float(word["confidence"]) > 0]
    confidence = round(sum(confidences) / len(confidences)) if confidences else (45 if text else 0)
    tables = _extract_tables(payloads) if mode == "structure" else []
    return {
        "text": text,
        "confidence": confidence,
        "words": words,
        "tables": tables,
        "engine": "PaddleOCR-VL-1.6" if mode == "vl" else "PaddleOCR PP-StructureV3" if mode == "structure" else "PaddleOCR PP-OCR",
        "engineVersion": _version("paddleocr") or "unknown",
        "language": LANGUAGE,
        "pageCount": max(1, len(payloads)),
        "warnings": [] if text else ["PaddleOCR n'a retourné aucun texte exploitable."],
    }


def _handle(message: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    action = message.get("action")
    if action == "health":
        return _health(), False
    if action == "recognize":
        if not _health()["available"]:
            raise RuntimeError(_health()["reason"])
        return _recognize(str(message.get("inputPath") or ""), str(message.get("mode") or "ocr")), False
    if action == "warmup":
        _get_pipeline(str(message.get("mode") or "ocr"))
        return {"warmed": True}, False
    if action == "shutdown":
        return {"stopped": True}, True
    raise ValueError("Action PaddleOCR inconnue.")


def _serve() -> int:
    for raw_line in sys.stdin:
        request_id: Any = None
        try:
            message = json.loads(raw_line)
            if not isinstance(message, dict):
                raise ValueError("La requête PaddleOCR doit être un objet JSON.")
            request_id = message.get("id")
            payload, should_stop = _handle(message)
            _emit({"id": request_id, "ok": True, **payload})
            if should_stop:
                return 0
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            _emit({"id": request_id, "ok": False, "error": _clean_text(error)[:2000]})
    return 0


def _warmup() -> int:
    status = _health()
    if not status["available"]:
        print(status["reason"], file=sys.stderr)
        return 1
    _get_pipeline("ocr")
    _get_pipeline("structure")
    print("PaddleOCR and PP-StructureV3 models are ready for Wheat.")
    return 0


if __name__ == "__main__":
    if "--health" in sys.argv:
        print(json.dumps(_health(), ensure_ascii=False))
        raise SystemExit(0 if _health()["available"] else 1)
    if "--warmup" in sys.argv:
        raise SystemExit(_warmup())
    raise SystemExit(_serve())
