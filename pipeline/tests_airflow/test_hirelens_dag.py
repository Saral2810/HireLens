"""Airflow tests. Run with Airflow's own environment:

    pipeline/.venv-airflow/bin/python -m pytest pipeline/tests_airflow -q
"""
import os
import subprocess
import sys
from pathlib import Path

import pytest

PIPELINE_DIR = Path(__file__).resolve().parents[1]
DAGS_DIR = PIPELINE_DIR / "dags"
PIPELINE_PYTHON = PIPELINE_DIR / ".venv" / "bin" / "python"
AIRFLOW = Path(sys.executable).parent / "airflow"
EXPECTED_ORDER = ["load_raw_files", "build_cleaned", "check_cleaned", "build_analytics", "check_analytics"]


@pytest.fixture(scope="module")
def airflow_env(tmp_path_factory):
    home = tmp_path_factory.mktemp("airflow home")
    env = {
        **os.environ,
        "AIRFLOW_HOME": str(home),
        "AIRFLOW__CORE__DAGS_FOLDER": str(DAGS_DIR),
        "AIRFLOW__CORE__LOAD_EXAMPLES": "False",
        "NO_PROXY": "*",  # macOS: avoids a known crash when Airflow forks
    }
    subprocess.run([str(AIRFLOW), "db", "migrate"], env=env, check=True, capture_output=True, timeout=300)
    return env


@pytest.fixture(scope="module")
def dag(airflow_env):
    os.environ.update({k: airflow_env[k] for k in ("AIRFLOW_HOME", "AIRFLOW__CORE__DAGS_FOLDER")})
    from airflow.models import DagBag
    bag = DagBag(dag_folder=str(DAGS_DIR))  # examples are off via AIRFLOW__CORE__LOAD_EXAMPLES
    assert bag.import_errors == {}
    return bag.get_dag("hirelens_pipeline")


def test_tasks_run_in_order(dag):
    order = []
    task = dag.get_task(EXPECTED_ORDER[0])
    while task:
        order.append(task.task_id)
        task = next(iter(task.downstream_list), None)
    assert order == EXPECTED_ORDER


def test_retries_timeout_and_one_run_at_a_time(dag):
    assert dag.max_active_runs == 1 and dag.catchup is False
    for task in dag.tasks:
        assert task.retries == 2
        assert task.retry_delay.total_seconds() == 60
        assert task.execution_timeout.total_seconds() == 900


def test_commands_use_the_pipeline_environment_and_quote_paths(dag):
    for task in dag.tasks:
        assert task.bash_command.startswith("'") and str(PIPELINE_PYTHON) in task.bash_command
        assert task.cwd == str(PIPELINE_DIR)


def run_dag(airflow_env, data_dir):
    env = {**airflow_env, "HIRELENS_DATA_DIR": str(data_dir)}
    return subprocess.run([str(AIRFLOW), "dags", "test", "hirelens_pipeline", "2026-11-08"], env=env,
                          capture_output=True, text=True, timeout=600)


def test_full_dag_run_succeeds_on_generated_data(airflow_env, tmp_path):
    data = tmp_path / "data"
    subprocess.run([str(PIPELINE_PYTHON), "-m", "generate.generate_candidate_files", "--files", "1", "--rows", "30"],
                   cwd=PIPELINE_DIR, env={**os.environ, "HIRELENS_DATA_DIR": str(data)}, check=True, timeout=120)
    result = run_dag(airflow_env, data)
    output = result.stdout + result.stderr
    assert result.returncode == 0, output[-3000:]
    assert "DagRun Finished" in output and "state=success" in output
    for name in ["dim_candidate", "fact_application", "bridge_application_skill"]:
        assert (data / "analytics" / name / "_delta_log").is_dir()
