"""Where the pipeline keeps its data. Set HIRELENS_DATA_DIR to use another folder (tests do this)."""
import os
from pathlib import Path

PIPELINE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("HIRELENS_DATA_DIR", PIPELINE_DIR / "data"))

LANDING_DIR = DATA_DIR / "landing"
RAW_DIR = DATA_DIR / "raw" / "candidate_rows"
CLEANED_DIR = DATA_DIR / "cleaned"
ANALYTICS_DIR = DATA_DIR / "analytics"
OPS_DB = DATA_DIR / "ops" / "ops.db"
