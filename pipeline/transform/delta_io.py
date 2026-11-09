"""Small helpers for reading Delta tables into DuckDB without building SQL from file paths.

Why reads don't use DeltaTable.to_pyarrow_table(): on this Mac (tested with deltalake 1.2.1 on
Python 3.9 and 1.6.6 on Python 3.12), a process that calls it hangs while exiting, after the read
itself has finished. That would freeze
scheduled tasks. Instead, Delta works out which Parquet files make up the requested version (from
its transaction log), and pyarrow reads those files directly. Writes and MERGE still use deltalake.
"""
from __future__ import annotations

from pathlib import Path
from typing import List, Optional
from urllib.parse import unquote, urlparse

import duckdb
import pyarrow as pa
import pyarrow.dataset as ds
from deltalake import DeltaTable


def table_exists(path: Path) -> bool:
    return DeltaTable.is_deltatable(str(path))


def _local_path(uri: str) -> str:
    """Delta lists files as URL-encoded paths (a space becomes %20); turn them back into file paths."""
    return unquote(urlparse(uri).path) if uri.startswith("file://") else unquote(uri)


def read_table(path: Path, columns: Optional[List[str]] = None, version: Optional[int] = None) -> pa.Table:
    """The table as it was at `version` (default: latest), read with pyarrow."""
    table = DeltaTable(str(path), version=version)
    schema = pa.schema(table.schema().to_arrow())
    files = [_local_path(uri) for uri in table.file_uris()]
    if not files:
        empty = schema.empty_table()
        return empty.select(columns) if columns else empty
    return ds.dataset(files, format="parquet", schema=schema).to_table(columns=columns)


def register(connection: duckdb.DuckDBPyConnection, name: str, path: Path) -> None:
    """Makes a Delta table queryable in DuckDB under `name`."""
    connection.register(name, read_table(path))
