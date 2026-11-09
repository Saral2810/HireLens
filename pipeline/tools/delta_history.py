"""Shows a Delta table's version history, and optionally one person's row in every version (time travel).

Usage (from the pipeline folder):
  python -m tools.delta_history
  python -m tools.delta_history --email someone@example.com
"""
from __future__ import annotations

import argparse
from pathlib import Path
from typing import List, Optional

import pyarrow.compute as pc
from deltalake import DeltaTable

from config import CLEANED_DIR
from transform.delta_io import read_table

APPLICATIONS = CLEANED_DIR / "candidate_applications"
SHOWN_COLUMNS = ["source", "full_name", "ctc_lpa", "notice_days", "applied_on", "source_file"]


def history(path: Path = APPLICATIONS) -> List[dict]:
    """One entry per version, newest first: version number, operation and when it happened."""
    return [
        {"version": entry["version"], "operation": entry.get("operation"), "timestamp": entry.get("timestamp")}
        for entry in DeltaTable(str(path)).history()
    ]


def rows_for_email(email: str, path: Path = APPLICATIONS, version: Optional[int] = None) -> List[dict]:
    """The person's rows as they were at `version` (default: the latest). Filtered in Python, not SQL."""
    table = read_table(path, version=version)
    matches = table.filter(pc.equal(table["email"], email.strip().lower()))
    return matches.select(SHOWN_COLUMNS).to_pylist()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--email", help="show this person's rows in every version")
    args = parser.parse_args()
    for entry in history():
        print(f"version {entry['version']}: {entry['operation']} at {entry['timestamp']}")
        if args.email:
            for row in rows_for_email(args.email, version=entry["version"]) or ["(not in this version)"]:
                print(f"    {row}")


if __name__ == "__main__":
    main()
