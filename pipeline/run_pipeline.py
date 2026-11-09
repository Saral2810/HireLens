"""Runs every pipeline step in order and stops at the first failure.

Steps: load raw files -> clean and MERGE -> check cleaned -> build analytics -> check analytics.
This is the quick way to run the pipeline by hand; Airflow (dags/hirelens_pipeline.py) runs the
same steps on a schedule, with retries.

Usage: python pipeline/run_pipeline.py [--full-rebuild]
Exits with code 1 if any step fails.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from checks.data_checks import check_analytics, check_cleaned  # noqa: E402
from ingest.load_raw_files import run_ingestion  # noqa: E402
from transform.build_analytics import build_analytics  # noqa: E402
from transform.build_cleaned import build_cleaned  # noqa: E402


class PipelineError(Exception):
    """A step failed; the message says which one and why."""


def run_pipeline(full_rebuild: bool = False) -> dict:
    results = {}

    def step(name, action):
        started = time.perf_counter()
        results[name] = {"result": action(), "seconds": round(time.perf_counter() - started, 2)}
        return results[name]["result"]

    raw = step("load_raw_files", run_ingestion)
    if raw["files_failed"]:
        raise PipelineError(f"load_raw_files: {raw['files_failed']} file(s) failed; see failed_files in ops.db")
    step("build_cleaned", lambda: build_cleaned(full_rebuild=full_rebuild))
    problems = step("check_cleaned", check_cleaned)
    if problems:
        raise PipelineError(f"check_cleaned: {'; '.join(problems)}")
    step("build_analytics", build_analytics)
    problems = step("check_analytics", check_analytics)
    if problems:
        raise PipelineError(f"check_analytics: {'; '.join(problems)}")
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--full-rebuild", action="store_true", help="clean every raw file again from scratch")
    args = parser.parse_args()
    try:
        results = run_pipeline(full_rebuild=args.full_rebuild)
    except Exception as error:  # report any failure clearly and exit non-zero
        print(f"PIPELINE FAILED: {type(error).__name__}: {error}")
        sys.exit(1)
    print(json.dumps(results, indent=2, default=str))


if __name__ == "__main__":
    main()
