"""Repo-root and data paths for maintenance scripts (no hard-coded user Desktop paths)."""
from pathlib import Path


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def data_import_dir() -> Path:
    d = repo_root() / "data" / "import"
    d.mkdir(parents=True, exist_ok=True)
    return d


def prisma_db() -> Path:
    return repo_root() / "apps" / "api" / "prisma" / "dev.db"
