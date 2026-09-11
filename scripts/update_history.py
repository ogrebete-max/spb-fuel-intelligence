"""Append one freshly collected snapshot to temporal intelligence state."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.history import load_history, save_history, update_history_data  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", type=Path, default=ROOT / "data" / "stations.json")
    parser.add_argument("--history", type=Path, default=ROOT / "data" / "history.json")
    args = parser.parse_args()
    snapshot = json.loads(args.snapshot.read_text(encoding="utf-8"))
    history = update_history_data(load_history(args.history), snapshot)
    save_history(args.history, history)
    print(json.dumps(history["stats"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
