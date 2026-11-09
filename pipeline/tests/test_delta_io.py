"""The Delta reader: versions, columns, empty tables, paths with spaces, and clean process exit."""
import subprocess
import sys
from pathlib import Path

import pyarrow as pa
from deltalake import DeltaTable, write_deltalake

from transform.delta_io import read_table

PIPELINE_DIR = Path(__file__).resolve().parents[1]


def make_versions(path):
    write_deltalake(str(path), pa.table({"k": ["a", "b"], "v": [1, 2]}))
    (DeltaTable(str(path)).merge(pa.table({"k": ["b", "c"], "v": [20, 3]}), predicate="t.k = s.k",
                                 source_alias="s", target_alias="t")
     .when_matched_update_all().when_not_matched_insert_all().execute())


def test_reads_latest_and_older_versions(tmp_path):
    path = tmp_path / "table"
    make_versions(path)
    assert sorted(read_table(path).to_pylist(), key=lambda r: r["k"]) == [
        {"k": "a", "v": 1}, {"k": "b", "v": 20}, {"k": "c", "v": 3}]
    assert sorted(read_table(path, version=0).to_pylist(), key=lambda r: r["k"]) == [
        {"k": "a", "v": 1}, {"k": "b", "v": 2}]


def test_reads_selected_columns(tmp_path):
    path = tmp_path / "table"
    make_versions(path)
    assert read_table(path, columns=["k"]).column_names == ["k"]


def test_folder_with_spaces(tmp_path):
    path = tmp_path / "Downloads from Windows" / "table"
    make_versions(path)
    assert read_table(path).num_rows == 3


def test_empty_table_keeps_its_columns(tmp_path):
    path = tmp_path / "empty"
    write_deltalake(str(path), pa.table({"k": pa.array([], pa.string())}))
    result = read_table(path)
    assert result.num_rows == 0 and result.column_names == ["k"]


def test_process_exits_promptly_after_reading(tmp_path):
    """Regression test: deltalake's own to_pyarrow_table() could leave the process hanging at exit."""
    path = tmp_path / "Downloads from Windows" / "table"
    make_versions(path)
    code = f"from transform.delta_io import read_table; print(read_table({str(path)!r}, version=0).num_rows)"
    for _ in range(3):
        result = subprocess.run([sys.executable, "-c", code], cwd=PIPELINE_DIR, capture_output=True, text=True,
                                timeout=30)
        assert result.stdout.strip() == "2"
