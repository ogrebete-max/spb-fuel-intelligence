"""Build a deterministic SHA-256 inventory for the Phase 0 evidence package."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "snapshot-manifest.json"
EXCLUDED_PARTS = {"__pycache__", ".pytest_cache", "site", "live"}
EXCLUDED_NAMES = {MANIFEST.name}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def included_files() -> list[Path]:
    return sorted(
        path
        for path in ROOT.rglob("*")
        if path.is_file()
        and path.name not in EXCLUDED_NAMES
        and not any(part in EXCLUDED_PARTS for part in path.parts)
        and path.suffix.lower() != ".zip"
    )


def main() -> None:
    files = included_files()
    fixture_files = [path for path in files if "fixtures" in path.parts and path.suffix == ".json"]
    payload = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "snapshot_date": "2026-09-11",
        "area_of_interest": {
            "west": 29.50,
            "south": 59.60,
            "east": 31.10,
            "north": 60.35,
        },
        "fixture_file_count": len(fixture_files),
        "files": [
            {
                "path": path.relative_to(ROOT).as_posix(),
                "bytes": path.stat().st_size,
                "sha256": sha256(path),
            }
            for path in files
        ],
    }
    MANIFEST.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
