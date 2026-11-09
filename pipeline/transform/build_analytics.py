"""Analytics layer: builds the star schema in sql/analytics.sql and saves each table as Delta.

The tables are small, so they are rebuilt from the Cleaned table on every run (each rebuild is a
new Delta version). Nothing is saved unless every data check passes first.

Usage (from the pipeline folder): python -m transform.build_analytics
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import duckdb
from deltalake import write_deltalake

from checks.data_checks import ANALYTICS_TABLES, analytics_problems
from config import ANALYTICS_DIR, CLEANED_DIR, OPS_DB
from transform.delta_io import register, table_exists

SQL_PATH = Path(__file__).parent / "sql" / "analytics.sql"

OPS_SCHEMA = """
CREATE TABLE IF NOT EXISTS analytics_runs (
  finished_at TEXT NOT NULL, applications INTEGER NOT NULL, candidates INTEGER NOT NULL, skills_linked INTEGER NOT NULL
);
"""


class DataCheckError(Exception):
    """A data check failed, so nothing was saved."""


def build_analytics(cleaned_dir: Path = CLEANED_DIR, analytics_dir: Path = ANALYTICS_DIR, ops_db: Path = OPS_DB) -> dict:
    applications_path = cleaned_dir / "candidate_applications"
    if not table_exists(applications_path):
        raise FileNotFoundError(f"No cleaned table at {applications_path}. Run the cleaned step first.")

    connection = duckdb.connect()
    register(connection, "applications", applications_path)
    connection.execute(SQL_PATH.read_text(encoding="utf-8"))
    if connection.execute("SELECT count(*) FROM applications").fetchone()[0] == 0:
        raise DataCheckError("the cleaned table is empty")

    # Materialise each view once, then check the exact rows that will be saved.
    tables = {name: connection.execute(f"SELECT * FROM {name}").to_arrow_table() for name in ANALYTICS_TABLES}  # nosec B608 - fixed table names
    checker = duckdb.connect()
    register(checker, "applications", applications_path)
    for name, table in tables.items():
        checker.register(name, table)
    problems = analytics_problems(checker)
    checker.close()
    connection.close()
    if problems:
        raise DataCheckError("; ".join(problems))

    for name, table in tables.items():
        write_deltalake(str(analytics_dir / name), table, mode="overwrite", schema_mode="overwrite")

    summary = {name: table.num_rows for name, table in tables.items()}
    ops_db.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(ops_db) as ops:
        ops.executescript(OPS_SCHEMA)
        ops.execute(
            "INSERT INTO analytics_runs VALUES (?, ?, ?, ?)",
            (datetime.now(timezone.utc).isoformat(timespec="seconds"), summary["fact_application"],
             summary["dim_candidate"], summary["bridge_application_skill"]),
        )
    return summary


def main() -> None:
    print(json.dumps(build_analytics(), indent=2))


if __name__ == "__main__":
    main()
