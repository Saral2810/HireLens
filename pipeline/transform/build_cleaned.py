"""Cleaned layer: cleans new raw files with sql/cleaned.sql and MERGEs them into Delta tables.

Outputs:
  - candidate_applications: one row per person (email) per hiring source, the latest version
  - rejected_rows: each bad, duplicate or out-of-date raw row, with the reasons

Each run processes only raw files it has not processed before (tracked in ops.db), then:
  - inserts people not saved yet and updates people whose new row is newer (Delta MERGE)
  - saves rejected rows once each, even if a run is repeated after a crash
Every MERGE is a new Delta version, so older values stay readable (time travel).
Use --full-rebuild after changing a cleaning rule, so old rows are cleaned again.

Usage (from the pipeline folder): python -m transform.build_cleaned [--full-rebuild]
"""
from __future__ import annotations

import argparse
import json
import sqlite3
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import duckdb
import pyarrow as pa
from deltalake import DeltaTable, write_deltalake

from config import CLEANED_DIR, OPS_DB, RAW_DIR
from transform.delta_io import read_table, table_exists

SQL_PATH = Path(__file__).parent / "sql" / "cleaned.sql"
SAVED_KEY_COLUMNS = ["row_id", "email", "source", "applied_on", "ingested_at"]

OPS_SCHEMA = """
CREATE TABLE IF NOT EXISTS cleaned_runs (
  finished_at TEXT NOT NULL, mode TEXT NOT NULL, new_files INTEGER NOT NULL, raw_rows INTEGER NOT NULL,
  inserted INTEGER NOT NULL, updated INTEGER NOT NULL, already_saved INTEGER NOT NULL,
  rejected INTEGER NOT NULL, delta_version INTEGER
);
CREATE TABLE IF NOT EXISTS cleaned_files (
  file_hash TEXT PRIMARY KEY, processed_at TEXT NOT NULL, delta_version INTEGER NOT NULL
);
"""


class ReconciliationError(Exception):
    """A raw row is missing from the outputs, or appears more than once."""


class MergeMismatchError(Exception):
    """Delta reported a different number of inserts or updates than the SQL planned."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def check_every_row_accounted(
    raw_ids: Iterable[str], cleaned_ids: Iterable[str], rejected_ids: Iterable[str], already_saved_ids: Iterable[str]
) -> None:
    """Each raw row must appear exactly once across the cleaned, rejected and already-saved outputs."""
    expected = Counter(raw_ids)
    actual = Counter(cleaned_ids) + Counter(rejected_ids) + Counter(already_saved_ids)
    if expected != actual:
        missing = sum((expected - actual).values())
        extra = sum((actual - expected).values())
        raise ReconciliationError(f"{missing} raw rows missing and {extra} unexpected rows in the outputs")


def merge_applications(path: Path, rows: pa.Table, planned_inserts: int, planned_updates: int) -> None:
    """Upserts on (email, source). The newer-row rule is repeated here as a second guard."""
    metrics = (
        DeltaTable(str(path))
        .merge(rows, predicate="t.email = s.email AND t.source = s.source", source_alias="s", target_alias="t")
        .when_matched_update_all(
            predicate="s.applied_on > t.applied_on OR (s.applied_on = t.applied_on AND s.ingested_at > t.ingested_at)"
        )
        .when_not_matched_insert_all()
        .execute()
    )
    inserted, updated = metrics["num_target_rows_inserted"], metrics["num_target_rows_updated"]
    if (inserted, updated) != (planned_inserts, planned_updates):
        raise MergeMismatchError(
            f"planned {planned_inserts} inserts and {planned_updates} updates, Delta did {inserted} and {updated}"
        )


def save_rejected(path: Path, rows: pa.Table) -> None:
    """Adds rejected rows, skipping any row_id already saved, so a repeated run adds nothing twice."""
    if not table_exists(path):
        write_deltalake(str(path), rows)
    elif rows.num_rows:
        DeltaTable(str(path)).merge(
            rows, predicate="t.row_id = s.row_id", source_alias="s", target_alias="t"
        ).when_not_matched_insert_all().execute()


def build_cleaned(raw_dir: Path = RAW_DIR, cleaned_dir: Path = CLEANED_DIR, ops_db: Path = OPS_DB,
                  full_rebuild: bool = False) -> dict:
    all_files = sorted(raw_dir.rglob("*.parquet"))
    if not all_files:
        raise FileNotFoundError(f"No raw Parquet files found in {raw_dir}. Run the raw loader first.")

    applications_path = cleaned_dir / "candidate_applications"
    rejected_path = cleaned_dir / "rejected_rows"
    ops_db.parent.mkdir(parents=True, exist_ok=True)
    ops = sqlite3.connect(ops_db)
    ops.executescript(OPS_SCHEMA)
    mode = "full_rebuild" if full_rebuild else "incremental"

    # Raw files are named after their file hash, so the name says which file it is.
    done = set() if full_rebuild else {h for (h,) in ops.execute("SELECT file_hash FROM cleaned_files")}
    new_files = [path for path in all_files if path.stem not in done]
    summary = {"mode": mode, "new_files": len(new_files), "raw_rows": 0, "inserted": 0, "updated": 0,
               "already_saved": 0, "rejected_rows": 0, "reject_reasons": {}, "delta_version": None}
    if not new_files:
        if table_exists(applications_path):
            summary["delta_version"] = DeltaTable(str(applications_path)).version()
        summary["status"] = "no_new_files"
        ops.close()
        return summary

    connection = duckdb.connect()
    connection.read_parquet([str(path) for path in new_files], hive_partitioning=False).create_view("raw_rows")
    if table_exists(applications_path) and not full_rebuild:
        connection.register("current_applications", read_table(applications_path, columns=SAVED_KEY_COLUMNS))
    else:
        connection.execute(
            "CREATE TEMP TABLE current_applications "
            "(row_id VARCHAR, email VARCHAR, source VARCHAR, applied_on DATE, ingested_at VARCHAR)"
        )
    connection.execute(SQL_PATH.read_text(encoding="utf-8"))

    raw_ids = [row[0] for row in connection.execute("SELECT row_id FROM all_row_ids").fetchall()]
    planned = connection.execute("SELECT * FROM cleaned_rows ORDER BY row_id").to_arrow_table()
    already_saved = [row[0] for row in connection.execute("SELECT row_id FROM already_saved_rows").fetchall()]
    rejected = connection.execute("SELECT * FROM rejected_rows ORDER BY row_id").to_arrow_table()
    connection.close()

    # Runs before anything is saved, so a failed check leaves the saved tables as they were.
    check_every_row_accounted(raw_ids, planned["row_id"].to_pylist(), rejected["row_id"].to_pylist(), already_saved)

    actions = Counter(planned["action"].to_pylist())
    rows = planned.drop(["action"])
    if full_rebuild or not table_exists(applications_path):
        write_deltalake(str(applications_path), rows, mode="overwrite", schema_mode="overwrite")
        if full_rebuild:
            write_deltalake(str(rejected_path), rejected, mode="overwrite", schema_mode="overwrite")
        else:
            save_rejected(rejected_path, rejected)
    else:
        if rows.num_rows:
            merge_applications(applications_path, rows, actions["insert"], actions["update"])
        save_rejected(rejected_path, rejected)

    version = DeltaTable(str(applications_path)).version()
    reasons = Counter(reason for row in rejected["reject_reasons"].to_pylist() for reason in row)
    summary.update({
        "raw_rows": len(raw_ids), "inserted": actions["insert"], "updated": actions["update"],
        "already_saved": len(already_saved), "rejected_rows": rejected.num_rows,
        "reject_reasons": dict(reasons.most_common()), "delta_version": version, "status": "succeeded",
    })

    now = utc_now()
    with ops:
        if full_rebuild:
            ops.execute("DELETE FROM cleaned_files")
        ops.executemany(
            "INSERT OR REPLACE INTO cleaned_files VALUES (?, ?, ?)", [(path.stem, now, version) for path in new_files]
        )
        ops.execute(
            "INSERT INTO cleaned_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (now, mode, len(new_files), len(raw_ids), actions["insert"], actions["update"],
             len(already_saved), rejected.num_rows, version),
        )
    ops.close()
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--full-rebuild", action="store_true", help="clean every raw file again from scratch")
    args = parser.parse_args()
    print(json.dumps(build_cleaned(full_rebuild=args.full_rebuild), indent=2))


if __name__ == "__main__":
    main()
