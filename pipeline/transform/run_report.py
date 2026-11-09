"""Runs one of the business reports in sql/reports/ against the saved Analytics tables.

Usage (from the pipeline folder): python -m transform.run_report weekly_applications
Reports: weekly_applications, ctc_by_city_source, top_skills_by_city, notice_by_source
"""
from __future__ import annotations

import argparse
from pathlib import Path

import duckdb
import pyarrow as pa

from checks.data_checks import ANALYTICS_TABLES
from config import ANALYTICS_DIR
from transform.delta_io import register

REPORTS_DIR = Path(__file__).parent / "sql" / "reports"
REPORTS = sorted(path.stem for path in REPORTS_DIR.glob("*.sql"))


def run_report(name: str, analytics_dir: Path = ANALYTICS_DIR) -> pa.Table:
    if name not in REPORTS:  # only the fixed report files can run, never a path from input
        raise ValueError(f"Unknown report {name!r}. Choose from: {', '.join(REPORTS)}")
    connection = duckdb.connect()
    for table in ANALYTICS_TABLES:
        register(connection, table, analytics_dir / table)
    result = connection.execute((REPORTS_DIR / f"{name}.sql").read_text(encoding="utf-8")).to_arrow_table()
    connection.close()
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("report", choices=REPORTS)
    args = parser.parse_args()
    print(duckdb.from_arrow(run_report(args.report)))


if __name__ == "__main__":
    main()
