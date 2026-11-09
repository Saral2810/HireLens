import json
import os
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

import pyarrow.parquet as pq
import pytest
from openpyxl import Workbook

import ingest.load_raw_files as loader
from ingest.load_raw_files import run_ingestion

PIPELINE_DIR = Path(__file__).resolve().parents[1]


@pytest.fixture
def dirs(tmp_path):
    landing = tmp_path / "landing"
    landing.mkdir()
    return landing, tmp_path / "raw", tmp_path / "ops.db"


def make_workbook(path, sheets):
    book = Workbook()
    book.remove(book.active)
    for name, rows in sheets.items():
        sheet = book.create_sheet(name)
        for row in rows:
            sheet.append(row)
    book.save(path)


def raw_rows(raw):
    rows = []
    for file in raw.rglob("*.parquet"):
        rows.extend(pq.read_table(file).to_pylist())
    return rows


HEADER = ["Name", "Email", "CTC"]


def test_values_are_kept_as_found_with_lineage(dirs):
    landing, raw, ops = dirs
    make_workbook(landing / "a.xlsx", {"Naukri": [HEADER, ["Asha", " ASHA@EXAMPLE.COM ", "12 LPA"]]})
    result = run_ingestion(landing, raw, ops)
    assert result["status"] == "succeeded" and result["rows_loaded"] == 1
    row = raw_rows(raw)[0]
    assert json.loads(row["raw_json"]) == {"Name": "Asha", "Email": " ASHA@EXAMPLE.COM ", "CTC": "12 LPA"}
    assert (row["_source_file"], row["_sheet_name"], row["_row_number"]) == ("a.xlsx", "Naukri", 2)
    assert row["_run_id"] == result["run_id"]


def test_rerun_does_not_duplicate(dirs):
    landing, raw, ops = dirs
    make_workbook(landing / "a.xlsx", {"S": [HEADER, ["Asha", "a@example.com", "1"]]})
    run_ingestion(landing, raw, ops)
    second = run_ingestion(landing, raw, ops)
    assert (second["files_loaded"], second["files_skipped"]) == (0, 1)
    assert len(raw_rows(raw)) == 1


def test_renamed_copy_is_skipped(dirs):
    landing, raw, ops = dirs
    make_workbook(landing / "a.xlsx", {"S": [HEADER, ["Asha", "a@example.com", "1"]]})
    shutil.copy(landing / "a.xlsx", landing / "a_final_v2.xlsx")
    result = run_ingestion(landing, raw, ops)
    assert (result["files_loaded"], result["files_skipped"]) == (1, 1)
    assert len(raw_rows(raw)) == 1


def test_corrupt_file_fails_alone_then_loads_once_replaced(dirs):
    landing, raw, ops = dirs
    (landing / "bad.xlsx").write_bytes(b"this is not a workbook")
    make_workbook(landing / "good.xlsx", {"S": [HEADER, ["Asha", "a@example.com", "1"]]})
    result = run_ingestion(landing, raw, ops)
    assert result["status"] == "partial"
    assert (result["files_loaded"], result["files_failed"]) == (1, 1)
    with sqlite3.connect(ops) as connection:
        assert connection.execute("SELECT file_name FROM failed_files").fetchall() == [("bad.xlsx",)]

    make_workbook(landing / "bad.xlsx", {"S": [HEADER, ["Ravi", "r@example.com", "2"]]})
    assert run_ingestion(landing, raw, ops)["files_loaded"] == 1
    assert len(raw_rows(raw)) == 2


def test_title_rows_blank_rows_and_empty_sheets(dirs):
    landing, raw, ops = dirs
    make_workbook(landing / "a.xlsx", {
        "S": [["Export from recruiter"], [], HEADER, ["Asha", "a@example.com", "1"], [], ["Ravi", "r@example.com", "2"]],
        "Notes": [],
    })
    run_ingestion(landing, raw, ops)
    rows = raw_rows(raw)
    assert sorted(r["_row_number"] for r in rows) == [4, 6]
    assert all(set(json.loads(r["raw_json"])) == set(HEADER) for r in rows)
    with sqlite3.connect(ops) as connection:
        stored = connection.execute("SELECT rows_read, rows_loaded, blank_rows_skipped FROM ingested_files").fetchone()
    assert stored[0] == stored[1] + stored[2]


def test_different_columns_per_sheet_and_csv(dirs):
    landing, raw, ops = dirs
    make_workbook(landing / "a.xlsx", {
        "Naukri": [["Candidate Name", "Email ID", "City"], ["Asha", "a@example.com", "Jaipur"]],
        "Referrals": [["Name", "Email", "Referred By"], ["Ravi", "r@example.com", "Asha"]],
    })
    (landing / "b.csv").write_text("Name,Email,CTC\nMeera,m@example.com,5\n", encoding="utf-8")
    result = run_ingestion(landing, raw, ops)
    assert result["rows_loaded"] == 3
    columns = {tuple(json.loads(r["raw_json"])) for r in raw_rows(raw)}
    assert ("Name", "Email", "Referred By") in columns and ("Candidate Name", "Email ID", "City") in columns


def test_short_write_fails_and_leaves_no_file(dirs, monkeypatch):
    landing, raw, ops = dirs
    make_workbook(landing / "a.xlsx", {"S": [HEADER, ["Asha", "a@example.com", "1"], ["Ravi", "r@example.com", "2"]]})
    real_write = pq.write_table
    monkeypatch.setattr(pq, "write_table", lambda table, path: real_write(table.slice(0, 1), path))

    result = run_ingestion(landing, raw, ops)

    assert (result["status"], result["files_failed"], result["rows_loaded"]) == ("partial", 1, 0)
    assert not [p for p in raw.rglob("*") if p.is_file()]
    with sqlite3.connect(ops) as connection:
        error = connection.execute("SELECT error FROM failed_files").fetchone()[0]
        assert "ReconciliationError" in error
        assert connection.execute("SELECT COUNT(*) FROM ingested_files").fetchone()[0] == 0

    # Once the write is healthy again, the same file loads on the next run.
    monkeypatch.setattr(pq, "write_table", real_write)
    assert run_ingestion(landing, raw, ops)["rows_loaded"] == 2


def test_file_with_no_table_is_failed_not_silently_loaded(dirs):
    landing, raw, ops = dirs
    make_workbook(landing / "empty.xlsx", {"Notes": [["just a note"]]})
    result = run_ingestion(landing, raw, ops)
    assert (result["files_failed"], result["rows_loaded"]) == (1, 0)


# ── Safety and failure handling ───────────────────────────────────────────────

def test_symbolic_links_are_not_followed(dirs, tmp_path):
    landing, raw, ops = dirs
    outside = tmp_path / "outside.xlsx"
    make_workbook(outside, {"S": [HEADER, ["Asha", "a@example.com", "1"]]})
    os.symlink(outside, landing / "link.xlsx")
    result = run_ingestion(landing, raw, ops)
    assert result["files_seen"] == 0 and bronze_rows_count(raw) == 0


def test_oversized_file_is_refused(dirs, monkeypatch):
    landing, raw, ops = dirs
    make_workbook(landing / "a.xlsx", {"S": [HEADER, ["Asha", "a@example.com", "1"]]})
    monkeypatch.setattr(loader, "MAX_FILE_BYTES", 10)
    result = run_ingestion(landing, raw, ops)
    assert (result["files_failed"], result["rows_loaded"]) == (1, 0)
    with sqlite3.connect(ops) as connection:
        assert "FileTooLargeError" in connection.execute("SELECT error FROM failed_files").fetchone()[0]


def test_excel_xml_is_parsed_with_defusedxml():
    """openpyxl switches to defusedxml when it is installed, which blocks XML entity attacks."""
    from openpyxl.xml import DEFUSEDXML
    assert DEFUSEDXML is True


def run_cli(data_dir):
    env = {**os.environ, "HIRELENS_DATA_DIR": str(data_dir)}
    return subprocess.run([sys.executable, "-m", "ingest.load_raw_files"], cwd=PIPELINE_DIR, env=env,
                          capture_output=True, text=True, timeout=60)


def test_command_exits_1_when_a_file_fails_so_schedulers_notice(tmp_path):
    (tmp_path / "landing").mkdir()
    (tmp_path / "landing" / "bad.xlsx").write_bytes(b"not a workbook")
    result = run_cli(tmp_path)
    assert result.returncode == 1 and '"files_failed": 1' in result.stdout


def test_command_exits_0_when_all_files_load(tmp_path):
    (tmp_path / "landing").mkdir()
    make_workbook(tmp_path / "landing" / "a.xlsx", {"S": [HEADER, ["Asha", "a@example.com", "1"]]})
    result = run_cli(tmp_path)
    assert result.returncode == 0 and '"rows_loaded": 1' in result.stdout


def bronze_rows_count(raw):
    return sum(pq.read_metadata(f).num_rows for f in raw.rglob("*.parquet")) if raw.exists() else 0
