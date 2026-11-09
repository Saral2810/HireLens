"""Raw ingestion: copy recruiter Excel and CSV rows into Parquet without changing their values.

Guarantees:
  - Safe to rerun: a file is identified by its content hash, so it loads only once, even if renamed.
  - Traceable: each row records its source file, sheet, row number and run.
  - Tolerant of schema drift: columns are stored as JSON because each source names them differently.
  - Reconciled: the saved Parquet file must hold rows read minus blank rows, or the file fails.
  - Isolated failures: a corrupt file is recorded as failed, and the remaining files still load.
  - Loud failures: the command exits with code 1 if any file failed, so a scheduler notices.
  - Safe reading: files over MAX_FILE_BYTES and symbolic links are not read. Excel files are parsed
    with defusedxml installed, which openpyxl uses to block malicious XML.

Usage (from the pipeline folder): python -m ingest.load_raw_files
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import sqlite3
import sys
import uuid
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Iterable, Iterator, List, Optional, Tuple

import pyarrow as pa
import pyarrow.parquet as pq
from openpyxl import load_workbook

from config import LANDING_DIR, OPS_DB, RAW_DIR

RAW_SCHEMA = pa.schema([
    ("raw_json", pa.string()),
    ("_source_file", pa.string()),
    ("_file_hash", pa.string()),
    ("_sheet_name", pa.string()),
    ("_row_number", pa.int32()),
    ("_run_id", pa.string()),
    ("_ingested_at", pa.string()),
])

OPS_SCHEMA = """
CREATE TABLE IF NOT EXISTS pipeline_runs (
  run_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL,
  files_seen INTEGER DEFAULT 0, files_loaded INTEGER DEFAULT 0, files_skipped INTEGER DEFAULT 0,
  files_failed INTEGER DEFAULT 0, rows_loaded INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ingested_files (
  file_hash TEXT PRIMARY KEY, file_name TEXT NOT NULL, run_id TEXT NOT NULL, raw_path TEXT NOT NULL,
  rows_read INTEGER NOT NULL, rows_loaded INTEGER NOT NULL, blank_rows_skipped INTEGER NOT NULL,
  ingested_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS failed_files (
  run_id TEXT NOT NULL, file_name TEXT NOT NULL, file_hash TEXT NOT NULL, error TEXT NOT NULL, failed_at TEXT NOT NULL
);
"""

SUPPORTED_SUFFIXES = {".xlsx", ".csv"}
HEADER_SCAN_LIMIT = 20
MIN_HEADER_CELLS = 3
MAX_FILE_BYTES = 20 * 1024 * 1024  # recruiter exports are far smaller; bigger files are refused


class FileTooLargeError(Exception):
    """The file is bigger than MAX_FILE_BYTES."""


class ReconciliationError(Exception):
    """The saved Parquet file does not hold the number of rows that should have been loaded."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def cell_to_text(value: object) -> Optional[str]:
    """Text form of a cell. Blank cells become None; values are otherwise left as found."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date().isoformat() if value.time() == datetime.min.time() else value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    text = str(value)
    return text if text.strip() else None


def iter_sheets(path: Path) -> Iterator[Tuple[str, Iterable[Tuple[int, List[Optional[str]]]]]]:
    """Yields (sheet name, rows), where each row is (1-based row number, text cells)."""
    if path.suffix.lower() == ".csv":
        with path.open(newline="", encoding="utf-8-sig") as handle:
            rows = [(i, [cell_to_text(c) for c in row]) for i, row in enumerate(csv.reader(handle), start=1)]
        yield "csv", rows
        return
    book = load_workbook(path, read_only=True, data_only=True)
    try:
        for sheet in book.worksheets:
            rows = [
                (i, [cell_to_text(c) for c in row])
                for i, row in enumerate(sheet.iter_rows(values_only=True), start=1)
            ]
            yield sheet.title, rows
    finally:
        book.close()


def find_header(rows: List[Tuple[int, List[Optional[str]]]]) -> Optional[int]:
    """Index of the first row with enough filled cells to be a header, skipping title rows above it."""
    for index, (_, cells) in enumerate(rows[:HEADER_SCAN_LIMIT]):
        if sum(c is not None for c in cells) >= MIN_HEADER_CELLS:
            return index
    return None


def header_names(cells: List[Optional[str]]) -> List[str]:
    """Trimmed header names. Blank or repeated headers get a suffix so no column is lost."""
    names: List[str] = []
    seen: dict = {}
    for position, cell in enumerate(cells, start=1):
        name = (cell or "").strip() or f"_column_{position}"
        seen[name] = seen.get(name, 0) + 1
        names.append(name if seen[name] == 1 else f"{name}_{seen[name]}")
    return names


def read_file(path: Path, file_hash: str, run_id: str, ingested_at: str) -> Tuple[List[dict], int, int]:
    """Returns (raw records, rows read, blank rows skipped)."""
    records: List[dict] = []
    rows_read = 0
    blank_skipped = 0
    for sheet_name, rows in iter_sheets(path):
        rows = list(rows)
        header_index = find_header(rows)
        if header_index is None:
            continue  # empty or notes sheet: no table to load
        names = header_names(rows[header_index][1])
        for row_number, cells in rows[header_index + 1:]:
            rows_read += 1
            if all(c is None for c in cells):
                blank_skipped += 1
                continue
            # A row wider than its header keeps the extra cells instead of dropping them.
            extra = [f"_column_{i}" for i in range(len(names) + 1, len(cells) + 1)]
            raw = dict(zip(names + extra, cells))
            records.append({
                "raw_json": json.dumps(raw, ensure_ascii=False),
                "_source_file": path.name,
                "_file_hash": file_hash,
                "_sheet_name": sheet_name,
                "_row_number": row_number,
                "_run_id": run_id,
                "_ingested_at": ingested_at,
            })
    if not records:
        raise ValueError("no data rows found in any sheet")
    return records, rows_read, blank_skipped


def write_raw(records: List[dict], raw_dir: Path, file_hash: str, ingest_date: str, expected_rows: int) -> Path:
    """Writes one Parquet file atomically; the hash-based name makes a retry overwrite, not duplicate.

    The row count is read back from the temporary file, so a short write never becomes the final file.
    """
    partition = raw_dir / f"ingest_date={ingest_date}"
    partition.mkdir(parents=True, exist_ok=True)
    target = partition / f"{file_hash}.parquet"
    temp = partition / f".{file_hash}.tmp"
    try:
        pq.write_table(pa.Table.from_pylist(records, schema=RAW_SCHEMA), temp)
        saved_rows = pq.read_metadata(temp).num_rows
        if saved_rows != expected_rows:
            raise ReconciliationError(f"expected {expected_rows} rows, saved file holds {saved_rows}")
        os.replace(temp, target)
    finally:
        temp.unlink(missing_ok=True)
    return target


def run_ingestion(landing: Path = LANDING_DIR, raw_dir: Path = RAW_DIR, ops_db: Path = OPS_DB) -> dict:
    ops_db.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(ops_db)
    connection.executescript(OPS_SCHEMA)

    run_id = str(uuid.uuid4())
    started_at = utc_now()
    connection.execute(
        "INSERT INTO pipeline_runs (run_id, started_at, status) VALUES (?, ?, 'running')", (run_id, started_at)
    )
    connection.commit()

    summary = {"run_id": run_id, "files_seen": 0, "files_loaded": 0, "files_skipped": 0, "files_failed": 0, "rows_loaded": 0}
    # "~$" files are Excel's temporary lock files, not data. Symbolic links could point outside
    # the landing folder, so they are not followed.
    paths = sorted(
        p for p in landing.glob("*")
        if p.is_file() and not p.is_symlink()
        and p.suffix.lower() in SUPPORTED_SUFFIXES and not p.name.startswith("~$")
    )
    try:
        for path in paths:
            summary["files_seen"] += 1
            file_hash = file_sha256(path)
            already_loaded = connection.execute(
                "SELECT 1 FROM ingested_files WHERE file_hash = ?", (file_hash,)
            ).fetchone()
            if already_loaded:
                summary["files_skipped"] += 1
                continue
            ingested_at = utc_now()
            try:
                size = path.stat().st_size
                if size > MAX_FILE_BYTES:
                    raise FileTooLargeError(f"{size} bytes, limit is {MAX_FILE_BYTES}")
                records, rows_read, blank_skipped = read_file(path, file_hash, run_id, ingested_at)
                target = write_raw(records, raw_dir, file_hash, ingested_at[:10], rows_read - blank_skipped)
            except Exception as error:  # one bad file must not stop the others
                connection.execute(
                    "INSERT INTO failed_files VALUES (?, ?, ?, ?, ?)",
                    (run_id, path.name, file_hash, f"{type(error).__name__}: {error}", utc_now()),
                )
                connection.commit()
                summary["files_failed"] += 1
                continue
            connection.execute(
                "INSERT INTO ingested_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (file_hash, path.name, run_id, str(target), rows_read, len(records), blank_skipped, ingested_at),
            )
            connection.commit()
            summary["files_loaded"] += 1
            summary["rows_loaded"] += len(records)
        status = "partial" if summary["files_failed"] else "succeeded"
    except Exception:
        status = "failed"
        raise
    finally:
        connection.execute(
            """UPDATE pipeline_runs SET finished_at = ?, status = ?, files_seen = ?, files_loaded = ?,
               files_skipped = ?, files_failed = ?, rows_loaded = ? WHERE run_id = ?""",
            (utc_now(), status if "status" in locals() else "failed", summary["files_seen"], summary["files_loaded"],
             summary["files_skipped"], summary["files_failed"], summary["rows_loaded"], run_id),
        )
        connection.commit()
        connection.close()
    summary["status"] = status
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.parse_args()
    summary = run_ingestion()
    print(json.dumps(summary, indent=2))
    if summary["files_failed"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
