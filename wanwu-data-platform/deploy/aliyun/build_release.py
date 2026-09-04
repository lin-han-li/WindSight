"""Build a clean Linux release archive for this project directory."""
from __future__ import annotations

import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "release" / "wanwu-data-platform.tar.gz"
EXCLUDED_DIRS = {"__pycache__", "venv", "venv311", "logs", "instance", "node_modules", "build"}
EXCLUDED_SUFFIXES = {".pyc", ".pyo", ".db", ".db-wal", ".db-shm", ".log"}
EXCLUDED_NAMES = {".env", ".env.local", "windsight.env"}

def include(path: Path) -> bool:
    relative = path.relative_to(ROOT)
    return (
        not any(part in EXCLUDED_DIRS for part in relative.parts)
        and path.name not in EXCLUDED_NAMES
        and path.suffix.lower() not in EXCLUDED_SUFFIXES
    )

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
with tarfile.open(OUTPUT, "w:gz") as archive:
    for path in sorted(ROOT.rglob("*")):
        if path.is_file() and include(path) and path != OUTPUT:
            archive.add(path, arcname=path.relative_to(ROOT).as_posix(), recursive=False)
print(OUTPUT)
