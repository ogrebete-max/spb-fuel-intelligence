"""Lightweight, dependency-free QA for the Phase 0 evidence package."""

from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures"
ALLOWED_SOURCE_STATUSES = {
    "GREEN_VERIFIED_HTTP",
    "GREEN_VERIFIED_BROWSER",
    "YELLOW_NEEDS_KEY",
    "YELLOW_NEEDS_MANUAL_HAR",
    "CONTROL_ONLY",
    "RED_BLOCKED",
    "RED_NO_REALTIME_DATA",
}
FORBIDDEN_JSON_KEYS = {
    "authorization",
    "cookie",
    "set-cookie",
    "token",
    "access_token",
    "refresh_token",
    "client_id",
    "device_id",
    "deviceid",
    "sessionid",
    "code_challenge",
    "phone",
    "telephone",
    "email",
    "ip",
}


def walk_keys(value: object, path: str = "$") -> list[str]:
    failures: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            if key.lower() in FORBIDDEN_JSON_KEYS:
                failures.append(f"{path}.{key}")
            failures.extend(walk_keys(child, f"{path}.{key}"))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            failures.extend(walk_keys(child, f"{path}[{index}]"))
    return failures


def main() -> None:
    fixture_paths = sorted(FIXTURES.glob("*/*.json"))
    documents = {path: json.loads(path.read_text(encoding="utf-8")) for path in fixture_paths}
    source_docs = {
        path: value
        for path, value in documents.items()
        if path.parent.name != "_probe-evidence"
    }

    assert len(source_docs) == 24, f"expected 24 source fixtures, got {len(source_docs)}"
    statuses = [value["_fixture"]["classification"] for value in source_docs.values()]
    assert set(statuses) <= ALLOWED_SOURCE_STATUSES, set(statuses) - ALLOWED_SOURCE_STATUSES
    assert len({value["_fixture"]["source"] for value in source_docs.values()}) == 24

    forbidden = {
        str(path.relative_to(ROOT)): locations
        for path, value in documents.items()
        if (locations := walk_keys(value))
    }
    assert not forbidden, f"forbidden JSON keys found: {forbidden}"

    config = (ROOT / "config" / "sources.yaml").read_text(encoding="utf-8")
    ids = re.findall(r"(?m)^  - id: (.+)$", config)
    config_statuses = re.findall(r"(?m)^    status: (.+)$", config)
    assert len(ids) == len(set(ids)) == 24
    assert len(config_statuses) == 24
    assert set(config_statuses) <= ALLOWED_SOURCE_STATUSES
    assert Counter(config_statuses) == Counter(statuses)

    required = [
        ROOT / "docs" / "source-capability-matrix.md",
        ROOT / "docs" / "phase0-results.md",
        ROOT / "docs" / "provenance-map.md",
        ROOT / "config" / "sources.yaml",
        ROOT / "src" / "normalizers.py",
        ROOT / "tests" / "test_normalizers.py",
    ]
    assert all(path.is_file() and path.stat().st_size > 0 for path in required)

    print(f"QA OK: {len(source_docs)} sources, {len(fixture_paths)} JSON evidence files")
    print("Status counts:", dict(sorted(Counter(statuses).items())))


if __name__ == "__main__":
    main()
