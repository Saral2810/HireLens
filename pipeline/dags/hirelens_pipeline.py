"""Airflow pipeline (DAG) for the HireLens data pipeline.

Runs the same steps as run_pipeline.py, one Airflow task each, so every step gets its own retries,
logs and status in the Airflow web screen:

    load_raw_files -> build_cleaned -> check_cleaned -> build_analytics -> check_analytics

Each task runs a pipeline command in the pipeline's own Python environment (pipeline/.venv), so
Airflow's many packages never mix with the pipeline's. A task fails when its command exits non-zero,
which every command does on a failed file, a failed MERGE or a failed data check.
"""
from __future__ import annotations

import os
import shlex
from datetime import datetime, timedelta
from pathlib import Path

from airflow.providers.standard.operators.bash import BashOperator
from airflow.sdk import DAG

PIPELINE_DIR = Path(__file__).resolve().parents[1]
PIPELINE_PYTHON = Path(os.environ.get("HIRELENS_PIPELINE_PYTHON", PIPELINE_DIR / ".venv" / "bin" / "python"))

# Task id -> the pipeline module it runs. Fixed here, never taken from input.
STEPS = {
    "load_raw_files": "ingest.load_raw_files",
    "build_cleaned": "transform.build_cleaned",
    "check_cleaned": "checks.data_checks cleaned",
    "build_analytics": "transform.build_analytics",
    "check_analytics": "checks.data_checks analytics",
}

default_args = {
    "owner": "hirelens",
    "retries": 2,                           # try a failed task twice more...
    "retry_delay": timedelta(minutes=1),    # ...a minute apart
    "execution_timeout": timedelta(minutes=15),  # a stuck task fails instead of running forever
}


def step_command(module_and_args: str) -> str:
    # shlex.quote keeps paths with spaces (like "Downloads from Windows") as one argument.
    return f"{shlex.quote(str(PIPELINE_PYTHON))} -m {module_and_args}"


with DAG(
    dag_id="hirelens_pipeline",
    description="Recruiter files -> Raw -> Cleaned (MERGE) -> Analytics star schema, with data checks",
    schedule="@daily",
    start_date=datetime(2026, 11, 1),
    catchup=False,       # don't run every missed day when Airflow starts
    max_active_runs=1,   # two runs at once could MERGE into the same Delta table together
    default_args=default_args,
    tags=["hirelens", "data-pipeline"],
) as dag:
    tasks = [
        BashOperator(task_id=task_id, bash_command=step_command(module), cwd=str(PIPELINE_DIR))
        for task_id, module in STEPS.items()
    ]
    for upstream, downstream in zip(tasks, tasks[1:]):
        upstream >> downstream
