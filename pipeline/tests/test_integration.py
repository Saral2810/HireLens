"""End to end: the real commands, run as separate processes against a temporary data folder."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from openpyxl import load_workbook

from transform.delta_io import read_table

PIPELINE_DIR = Path(__file__).resolve().parents[1]


def command(data_dir, *args, timeout=180):
    env = {**os.environ, "HIRELENS_DATA_DIR": str(data_dir)}
    return subprocess.run([sys.executable, *args], cwd=PIPELINE_DIR, env=env, capture_output=True, text=True,
                          timeout=timeout)


@pytest.fixture
def data_dir(tmp_path):
    data = tmp_path / "data with spaces"
    result = command(data, "-m", "generate.generate_candidate_files", "--files", "2", "--rows", "40")
    assert result.returncode == 0, result.stderr
    return data


def test_whole_pipeline_runs_then_merges_an_update(data_dir):
    first = command(data_dir, "run_pipeline.py")
    assert first.returncode == 0, first.stdout + first.stderr
    results = json.loads(first.stdout)
    assert results["load_raw_files"]["result"]["rows_loaded"] == 240  # 2 files x 3 sheets x 40 rows
    assert results["check_cleaned"]["result"] == [] and results["check_analytics"]["result"] == []
    facts_before = results["build_analytics"]["result"]["fact_application"]

    update = command(data_dir, "-m", "generate.generate_candidate_files", "--update-from", "candidates_001.xlsx")
    assert update.returncode == 0, update.stderr
    second = json.loads(command(data_dir, "run_pipeline.py").stdout)
    cleaned = second["build_cleaned"]["result"]
    assert cleaned["new_files"] == 1 and cleaned["updated"] > 0
    assert second["build_analytics"]["result"]["fact_application"] == facts_before + cleaned["inserted"]

    third = json.loads(command(data_dir, "run_pipeline.py").stdout)
    assert third["load_raw_files"]["result"]["files_loaded"] == 0
    assert third["build_cleaned"]["result"]["status"] == "no_new_files"


def test_update_rows_show_their_new_values_and_old_ones_stay_in_history(data_dir):
    assert command(data_dir, "run_pipeline.py").returncode == 0
    assert command(data_dir, "-m", "generate.generate_candidate_files", "--update-from", "candidates_001.xlsx").returncode == 0
    assert command(data_dir, "run_pipeline.py").returncode == 0

    book = load_workbook(data_dir / "landing" / "candidates_update_001.xlsx", read_only=True)
    first_update = next(book["Naukri"].iter_rows(min_row=2, values_only=True))
    book.close()
    email = first_update[1]
    table = data_dir / "cleaned" / "candidate_applications"
    latest = [r for r in read_table(table).to_pylist() if r["email"] == email and r["source"] == "Naukri"]
    assert latest[0]["source_file"] == "candidates_update_001.xlsx"
    assert latest[0]["ctc_lpa"] == float(first_update[2].split()[0])
    history = command(data_dir, "-m", "tools.delta_history", "--email", email)
    assert history.returncode == 0 and "MERGE" in history.stdout and "WRITE" in history.stdout


def test_corrupt_file_stops_the_pipeline_with_exit_code_1(data_dir):
    (data_dir / "landing" / "broken.xlsx").write_bytes(b"not a workbook")
    result = command(data_dir, "run_pipeline.py")
    assert result.returncode == 1 and "PIPELINE FAILED" in result.stdout and "load_raw_files" in result.stdout


def test_full_rebuild_matches_incremental_result(data_dir):
    assert command(data_dir, "run_pipeline.py").returncode == 0
    assert command(data_dir, "-m", "generate.generate_candidate_files", "--update-from", "candidates_001.xlsx").returncode == 0
    assert command(data_dir, "run_pipeline.py").returncode == 0
    table = data_dir / "cleaned" / "candidate_applications"
    incremental = sorted(r["row_id"] for r in read_table(table).to_pylist())
    rebuild = command(data_dir, "run_pipeline.py", "--full-rebuild")
    assert rebuild.returncode == 0, rebuild.stdout
    assert sorted(r["row_id"] for r in read_table(table).to_pylist()) == incremental


def test_report_and_check_commands(data_dir):
    assert command(data_dir, "run_pipeline.py").returncode == 0
    for layer in ("cleaned", "analytics"):
        result = command(data_dir, "-m", "checks.data_checks", layer)
        assert result.returncode == 0 and "passed" in result.stdout
    result = command(data_dir, "-m", "transform.run_report", "top_skills_by_city")
    assert result.returncode == 0 and "skill_rank" in result.stdout
