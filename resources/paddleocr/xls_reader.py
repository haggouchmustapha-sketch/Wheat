#!/usr/bin/env python3
"""Read one legacy BIFF .xls sheet into bounded JSON for Wheat."""

from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

import xlrd


MAX_ROWS = 2_001
MAX_COLUMNS = 100


def cell_text(book: xlrd.book.Book, cell: xlrd.sheet.Cell) -> str:
    if cell.ctype in {xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK}:
        return ""
    if cell.ctype == xlrd.XL_CELL_DATE:
        value = xlrd.xldate_as_datetime(cell.value, book.datemode)
        return value.date().isoformat() if value.time() == dt.time() else value.isoformat()
    if cell.ctype == xlrd.XL_CELL_BOOLEAN:
        return "TRUE" if cell.value else "FALSE"
    if cell.ctype == xlrd.XL_CELL_NUMBER:
        return str(int(cell.value)) if float(cell.value).is_integer() else format(cell.value, ".15g")
    return str(cell.value).strip()


def main() -> int:
    if len(sys.argv) != 2:
        raise ValueError("Un chemin XLS local est requis.")
    source = Path(sys.argv[1]).resolve(strict=True)
    if source.suffix.lower() != ".xls" or source.stat().st_size <= 0 or source.stat().st_size > 25_000_000:
        raise ValueError("Le fichier XLS est invalide ou dépasse 25 Mo.")
    book = xlrd.open_workbook(source, on_demand=True)
    if not book.sheet_names():
        raise ValueError("Le classeur XLS ne contient aucune feuille.")
    sheet = book.sheet_by_index(0)
    if sheet.nrows > MAX_ROWS or sheet.ncols > MAX_COLUMNS:
        raise ValueError(f"La feuille XLS dépasse la limite de {MAX_ROWS - 1} lignes ou {MAX_COLUMNS} colonnes.")
    matrix = [[cell_text(book, sheet.cell(row, column)) for column in range(sheet.ncols)] for row in range(sheet.nrows)]
    print(json.dumps({"sheet": sheet.name, "matrix": matrix}, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
