"""Export the local API snapshot as a static GitHub Pages site."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.repository import GRADES, StationRepository  # noqa: E402


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def repository_build_tag() -> str:
    """A short, changing token for cache busting: the current commit, or the time."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"], cwd=ROOT,
            capture_output=True, text=True, check=True, timeout=10,
        )
        return result.stdout.strip() or _clock_tag()
    except (OSError, subprocess.SubprocessError):
        return _clock_tag()


def _clock_tag() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d%H%M")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "site")
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists():
        shutil.rmtree(output)
    # The checks that live beside the app (web/voice.test.mjs) are not published.
    shutil.copytree(ROOT / "web", output, ignore=shutil.ignore_patterns("*.test.mjs"))
    index_path = output / "index.html"
    index_html = index_path.read_text(encoding="utf-8")
    static_marker = '<meta name="spbfi-static-site" content="false">'
    if static_marker not in index_html:
        raise RuntimeError("static-site marker is missing from web/index.html")
    index_html = index_html.replace(static_marker, '<meta name="spbfi-static-site" content="true">')
    # A browser holding yesterday's app.js against today's data is the single
    # most confusing failure this project has: the page looks broken and no
    # amount of server-side fixing shows up.  Stamping the build into the asset
    # URLs makes a stale bundle impossible to reuse.
    build = repository_build_tag()
    index_html = index_html.replace('href="styles.css"', f'href="styles.css?v={build}"')
    index_html = index_html.replace('src="app.js"', f'src="app.js?v={build}"')
    index_html = index_html.replace('src="analytics.js"', f'src="analytics.js?v={build}"')
    index_html = index_html.replace('src="log.js"', f'src="log.js?v={build}"')
    # The running page learns its own build so it can notice, from meta.json,
    # that a newer one has been deployed and reload itself (an installed PWA
    # left open on a phone otherwise keeps yesterday's code for days).
    stamp = f'<script>window.SPBFI_BUILD = "{build}";</script>'
    index_html = index_html.replace('<script src="config.js">', stamp + '\n  <script src="config.js">', 1)
    # config.js holds the club server's address. GitHub Pages lets a browser
    # keep it for ten minutes, and on 14 Sep 2026, when the club moved to its
    # own server, phones that reloaded onto the new build kept calling the old
    # one in that time. With the build in its URL the new address comes at once.
    index_html = index_html.replace('src="config.js"', f'src="config.js?v={build}"', 1)
    index_path.write_text(index_html, encoding="utf-8")

    analytics_path = output / "analytics.html"
    analytics_html = analytics_path.read_text(encoding="utf-8")
    analytics_html = analytics_html.replace('href="analytics.css"', f'href="analytics.css?v={build}"')
    analytics_html = analytics_html.replace('src="analytics-dashboard.js"', f'src="analytics-dashboard.js?v={build}"')
    analytics_path.write_text(analytics_html, encoding="utf-8")

    repository = StationRepository(ROOT / "data" / "stations.json", ROOT / "data" / "history.json")
    snapshot_time = "snapshot"
    meta = repository.meta()
    meta["mode"] = "static_github_pages"
    meta["static"] = True
    meta["build"] = build
    data_dir = output / "static-data"
    write_json(data_dir / "meta.json", meta)
    write_json(data_dir / "sources.json", repository.sources())
    # Every grade for every station in one small file, so a card can show all
    # six marks without the phone downloading six full bundles.
    write_json(data_dir / "grades-brief.json", repository.grades_brief(as_of=snapshot_time))
    # Publishing the raw collector outcome makes a silently failing upstream
    # visible on the site itself, not only in a workflow log.
    probe_path = ROOT / "data" / "live" / "full-aoi-probe-results.json"
    if probe_path.exists():
        write_json(data_dir / "collectors.json", json.loads(probe_path.read_text(encoding="utf-8")))

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
