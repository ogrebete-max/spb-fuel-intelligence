"""How far each feed's «есть» and «нет» agree with the independent others.

The measurement behind NEGATIVE_WEIGHT_BY_SOURCE in src/evidence_engine.py
(28–29 Sep 2026). Every fresh statement a feed made about a station's 92 or 95
is set against the majority of the fresh statements of the other feeds there
that come from another provenance cluster; ties are skipped, and a statement
repeated by later builds is counted once. For each feed it prints how often its
«есть» and its «нет» agreed, and the weight its «нет» would get: in full from
80% up, a tenth at 53% and below, straight in between, and in full with fewer
than 100 statements.

Agreement is not a look at the pump. When the club's own marks are many enough,
measure against them instead.

The published builds GitHub keeps for about a day, one folder each:

    gh api "repos/ogrebete-max/spb-fuel-intelligence/actions/artifacts?per_page=100" \
      --jq '.artifacts[] | select(.expired == false) | .id'
    gh api repos/ogrebete-max/spb-fuel-intelligence/actions/artifacts/<id>/zip > build.zip
    unzip build.zip && tar -xf artifact.tar      # into a folder of its own

    python docs/sources-scout/source-weights.py <folder with one folder per build>
"""
from __future__ import annotations

import collections
import glob
import json
import os
import sys

YES = {"AVAILABLE", "LIKELY", "LIMITED", "QUEUE"}
NO = {"NOT_AVAILABLE", "LIKELY_NOT"}
GRADES = ("AI92", "AI95")
MIN_STATEMENTS = 100


def measure(root: str) -> tuple[int, dict[str, dict[str, int]]]:
    seen: set[tuple] = set()
    stat: dict[str, dict[str, int]] = collections.defaultdict(lambda: {"yy": 0, "yn": 0, "ny": 0, "nn": 0})
    builds = sorted(name for name in os.listdir(root) if os.path.isdir(os.path.join(root, name, "static-data")))
    for build in builds:
        for path in glob.glob(os.path.join(root, build, "static-data", "details", "*.json")):
            with open(path, encoding="utf-8") as handle:
                card = json.load(handle)
            for grade in GRADES:
                rows = [row for row in ((card.get("grades") or {}).get(grade) or {}).get("evidence") or []
                        if row.get("fresh") and row.get("availability") in YES | NO]
                for row in rows:
                    key = (row.get("source"), card["id"], grade,
                           row.get("effective_observed_at") or row.get("observed_at") or row.get("received_at"),
                           row.get("availability"))
                    if key in seen:
                        continue
                    others = [other for other in rows if other.get("source") != row.get("source")
                              and other.get("provenance_cluster") != row.get("provenance_cluster")]
                    yes = sum(1 for other in others if other["availability"] in YES)
                    no = sum(1 for other in others if other["availability"] in NO)
                    if yes == no:
                        continue
                    seen.add(key)
                    said = "y" if row["availability"] in YES else "n"
                    stat[row.get("source")][said + ("y" if yes > no else "n")] += 1
    return len(builds), stat


def weight(right: int, total: int) -> float:
    if total < MIN_STATEMENTS:
        return 1.0
    return round(max(0.1, min(1.0, (right / total - 0.5) / 0.3)), 2)


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    builds, stat = measure(sys.argv[1])
    print(f"builds: {builds}, statements compared: {sum(sum(c.values()) for c in stat.values())}")
    print(f"{'feed':22} {'says есть':>10} {'agrees':>7} {'says нет':>9} {'agrees':>7} {'weight of нет':>14}")
    table = {}
    for source, c in sorted(stat.items(), key=lambda item: -sum(item[1].values())):
        yes_total, no_total = c["yy"] + c["yn"], c["ny"] + c["nn"]
        share = lambda right, total: f"{100 * right / total:6.0f}%" if total else "      —"
        no_weight = weight(c["nn"], no_total)
        if no_weight < 1.0:
            table[source] = no_weight
        print(f"{str(source):22} {yes_total:10} {share(c['yy'], yes_total)} {no_total:9} {share(c['nn'], no_total)} {no_weight:14.2f}")
    print("\nNEGATIVE_WEIGHT_BY_SOURCE = " + json.dumps(table, ensure_ascii=False, indent=4))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
