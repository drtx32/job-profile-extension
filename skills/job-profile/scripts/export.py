#!/usr/bin/env python3
"""Copy the first sheet of a profile workbook to the clipboard."""

import argparse
from pathlib import Path

import pandas as pd


def export_to_clipboard(excel_path: str) -> int:
    path = Path(excel_path).expanduser()
    if not path.is_file():
        raise FileNotFoundError(f"Excel file not found: {path}")

    frame = pd.read_excel(path, sheet_name=0)
    frame.to_clipboard(index=False, excel=True)
    print(f"Copied {len(frame)} rows. Open the form page and press Alt+Shift+V.")
    return len(frame)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Copy a recruitment profile workbook to the clipboard for Alt+Shift+V import."
    )
    parser.add_argument("excel_path", help="Path to the .xlsx/.xls profile workbook")
    args = parser.parse_args()
    export_to_clipboard(args.excel_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
