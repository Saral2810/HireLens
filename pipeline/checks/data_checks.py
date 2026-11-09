"""Data checks that run after each layer is saved. Each check returns a list of problems (empty = pass).

The same Analytics checks also run before saving (in build_analytics). Running them again on the
saved tables catches problems in the save itself, such as a crash between two tables.

Usage (from the pipeline folder): python -m checks.data_checks cleaned|analytics
Exits with code 1 and prints each problem if any check fails.
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path
from typing import List

import duckdb

from config import ANALYTICS_DIR, CLEANED_DIR, OPS_DB, RAW_DIR
from transform.delta_io import register, table_exists

MAX_REJECTED_SHARE = 0.30  # more than 30% of a batch rejected usually means a broken source file

ANALYTICS_TABLES = [
    "dim_candidate", "dim_source", "dim_city", "dim_skill", "dim_date", "fact_application", "bridge_application_skill",
]

# (problem description, SQL that counts the bad rows). Table names are fixed, never user input.
ANALYTICS_RULES = [
    ("fact rows differ from cleaned applications",
     "SELECT abs((SELECT count(*) FROM fact_application) - (SELECT count(*) FROM applications))"),
    ("repeated application_key in fact_application",
     "SELECT count(*) - count(DISTINCT application_key) FROM fact_application"),
    ("repeated candidate_key in dim_candidate", "SELECT count(*) - count(DISTINCT candidate_key) FROM dim_candidate"),
    ("repeated source_key in dim_source", "SELECT count(*) - count(DISTINCT source_key) FROM dim_source"),
    ("repeated city_key in dim_city", "SELECT count(*) - count(DISTINCT city_key) FROM dim_city"),
    ("repeated skill_key in dim_skill", "SELECT count(*) - count(DISTINCT skill_key) FROM dim_skill"),
    ("repeated date_key in dim_date", "SELECT count(*) - count(DISTINCT date_key) FROM dim_date"),
    ("fact rows with no matching candidate",
     "SELECT count(*) FROM fact_application f ANTI JOIN dim_candidate d USING (candidate_key)"),
    ("fact rows with no matching source",
     "SELECT count(*) FROM fact_application f ANTI JOIN dim_source d USING (source_key)"),
    ("fact rows with no matching city", "SELECT count(*) FROM fact_application f ANTI JOIN dim_city d USING (city_key)"),
    ("fact rows with no matching date",
     "SELECT count(*) FROM fact_application f ANTI JOIN dim_date d ON f.applied_date_key = d.date_key"),
    ("skill links with no matching application",
     "SELECT count(*) FROM bridge_application_skill b ANTI JOIN fact_application f USING (application_key)"),
    ("skill links with no matching skill",
     "SELECT count(*) FROM bridge_application_skill b ANTI JOIN dim_skill d USING (skill_key)"),
    ("skill links differ from skills listed on applications",
     "SELECT abs((SELECT count(*) FROM bridge_application_skill) "
     "- (SELECT COALESCE(sum(len(skills)), 0) FROM applications))"),
]

CLEANED_RULES = [
    ("repeated person and source in candidate_applications",
     "SELECT count(*) - count(DISTINCT (email, source)) FROM applications"),
    ("repeated row_id in candidate_applications", "SELECT count(*) - count(DISTINCT row_id) FROM applications"),
    ("rows both saved and rejected", "SELECT count(*) FROM applications a SEMI JOIN rejected r USING (row_id)"),
    ("required fields missing in candidate_applications",
     "SELECT count(*) FROM applications WHERE email IS NULL OR full_name IS NULL OR applied_on IS NULL"),
]


def run_rules(connection: duckdb.DuckDBPyConnection, rules) -> List[str]:
    problems = []
    for description, sql in rules:
        bad = connection.execute(sql).fetchone()[0]
        if bad:
            problems.append(f"{description}: {bad}")
    return problems


def analytics_problems(connection: duckdb.DuckDBPyConnection) -> List[str]:
    """Expects `applications` and every analytics table to be queryable on the connection."""
    return run_rules(connection, ANALYTICS_RULES)


def check_cleaned(cleaned_dir: Path = CLEANED_DIR, raw_dir: Path = RAW_DIR, ops_db: Path = OPS_DB) -> List[str]:
    applications_path, rejected_path = cleaned_dir / "candidate_applications", cleaned_dir / "rejected_rows"
    if not (table_exists(applications_path) and table_exists(rejected_path)):
        return ["cleaned tables do not exist yet"]
    connection = duckdb.connect()
    register(connection, "applications", applications_path)
    register(connection, "rejected", rejected_path)
    problems = run_rules(connection, CLEANED_RULES)
    connection.close()

    with sqlite3.connect(ops_db) as ops:
        processed = {h for (h,) in ops.execute("SELECT file_hash FROM cleaned_files")}
        latest = ops.execute(
            "SELECT raw_rows, rejected FROM cleaned_runs WHERE raw_rows > 0 ORDER BY rowid DESC LIMIT 1"
        ).fetchone()
    waiting = [path.name for path in raw_dir.rglob("*.parquet") if path.stem not in processed]
    if waiting:
        problems.append(f"raw files not cleaned yet: {len(waiting)}")
    if latest and latest[1] / latest[0] > MAX_REJECTED_SHARE:
        problems.append(f"latest batch rejected {latest[1]} of {latest[0]} rows, over {MAX_REJECTED_SHARE:.0%}")
    return problems


def check_analytics(analytics_dir: Path = ANALYTICS_DIR, cleaned_dir: Path = CLEANED_DIR) -> List[str]:
    missing = [name for name in ANALYTICS_TABLES if not table_exists(analytics_dir / name)]
    if missing:
        return [f"analytics tables missing: {', '.join(missing)}"]
    connection = duckdb.connect()
    register(connection, "applications", cleaned_dir / "candidate_applications")
    for name in ANALYTICS_TABLES:
        register(connection, name, analytics_dir / name)
    problems = analytics_problems(connection)
    connection.close()
    return problems


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("layer", choices=["cleaned", "analytics"])
    args = parser.parse_args()
    problems = check_cleaned() if args.layer == "cleaned" else check_analytics()
    if problems:
        for problem in problems:
            print(f"FAILED: {problem}")
        sys.exit(1)
    print(f"All {args.layer} checks passed.")


if __name__ == "__main__":
    main()
