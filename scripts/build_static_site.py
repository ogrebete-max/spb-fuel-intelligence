"""Export the local API snapshot as a static GitHub Pages site."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import sys


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.repository import GRADES, StationRepository  # noqa: E402


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "site")
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists():
        shutil.rmtree(output)
    shutil.copytree(ROOT / "web", output)
    index_path = output / "index.html"
    index_html = index_path.read_text(encoding="utf-8")
    static_marker = '<meta name="spbfi-static-site" content="false">'
    if static_marker not in index_html:
        raise RuntimeError("static-site marker is missing from web/index.html")
    index_path.write_text(index_html.replace(static_marker, '<meta name="spbfi-static-site" content="true">'), encoding="utf-8")

    repository = StationRepository(ROOT / "data" / "stations.json", ROOT / "data" / "history.json")
    snapshot_time = "snapshot"
    meta = repository.meta()
    meta["mode"] = "static_github_pages"
    meta["static"] = True
    data_dir = output / "static-data"
    write_json(data_dir / "meta.json", meta)
    write_json(data_dir / "sources.json", repository.sources())

    for grade in GRADES:
        payload = repository.query(grade=grade, as_of=snapshot_time, limit=10_000)
        write_json(data_dir / f"stations-{grade}.json", payload)
    for station in repository.stations:
        detail = repository.detail(station["id"], as_of=snapshot_time)
        write_json(data_dir / "details" / f"{station['id']}.json", detail)
    print(f"static_site={output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
