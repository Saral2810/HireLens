import sys
from pathlib import Path

# Lets tests import the pipeline's packages (ingest, transform, checks, ...).
sys.path.insert(0, str(Path(__file__).resolve().parent))
