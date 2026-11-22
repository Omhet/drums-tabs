"""Check a reading against the bar images, and write a review page.

Parses reading.txt (patterns, then one row of pattern names per score line)
and checks that it covers every bar image, that each line has as many bars as
its picture, and that every group of bars the images call identical was read
as one pattern. Then writes review.md: each score line's picture with its bars'
grids under it, in order, to look at side by side.

usage: python -I review.py <reading.txt> <bars_dir> <lines_dir> <review.md>
"""

import json
import os
import sys
from pathlib import Path

ORDER = ["CR", "CR2", "RD", "HH", "HT", "MT", "SD", "XS", "FT", "BD", "HP"]


def parse(path: Path) -> tuple[dict, list[tuple[int, list[str]]]]:
    """The reading's patterns (name -> rows) and its lines (first bar, pattern names)."""
    patterns: dict[str, dict] = {}
    lines: list[tuple[int, list[str]]] = []
    cur = None
    in_bars = False
    for raw in path.read_text(encoding="utf-8").splitlines():
        s = raw.split("#", 1)[0].rstrip()
        if not s.strip():
            continue
        if s.startswith("pattern "):
            parts = s.split(None, 2)
            cur = {"name": parts[1], "desc": parts[2] if len(parts) > 2 else "", "rows": {}}
            patterns[parts[1]] = cur
            in_bars = False
        elif s.strip() == "bars":
            in_bars, cur = True, None
        elif in_bars:
            first, *names = s.split()
            lines.append((int(first), names))
        elif cur is not None:
            inst, *cells = s.split()
            if len(cells) != 16:
                raise SystemExit(f"{cur['name']} {inst}: {len(cells)} cells, not 16")
            if inst not in ORDER:
                raise SystemExit(f"{cur['name']}: unknown row {inst} (rows are {', '.join(ORDER)})")
            cur["rows"][inst] = "".join(cells)
    patterns["rest"] = {"name": "rest", "desc": "", "rows": {}}
    return patterns, lines


def title(path: Path) -> str:
    for raw in path.read_text(encoding="utf-8").splitlines():
        if raw.startswith("#"):
            return raw.lstrip("# ").strip()
    return path.stem


def grid_block(names: list[str], patterns: dict) -> str:
    insts = [i for i in ORDER if any(i in patterns[n.rstrip("<")]["rows"] for n in names)]
    out = ["     " + " | ".join(f"{n:<19}" for n in names),
           "     " + " | ".join("1   2   3   4      " for _ in names)]
    for i in insts:
        cells = []
        for n in names:
            row = patterns[n.rstrip("<")]["rows"].get(i, "." * 16)
            cells.append(" ".join(row[k:k + 4] for k in range(0, 16, 4)))
        out.append(f"{i:<4} " + " | ".join(cells))
    return "\n".join(out)


def main() -> None:
    reading, bars_dir, lines_dir, out = map(Path, sys.argv[1:5])
    patterns, lines = parse(reading)
    seq: dict[int, str] = {}
    for first, names in lines:
        for k, n in enumerate(names):
            if n.rstrip("<") not in patterns:
                raise SystemExit(f"bar {first + k}: unknown pattern {n}")
            seq[first + k] = n.rstrip("<")
    meta = json.loads((bars_dir / "bars.json").read_text())
    n_img = len(meta["bars"])
    problems = []
    if sorted(seq) != list(range(1, n_img + 1)):
        problems.append(f"reading has bars {min(seq)}-{max(seq)} ({len(seq)}), images have {n_img}")
    for g in meta["groups"]:
        got = {seq.get(b) for b in g}
        if len(got) > 1:
            problems.append(f"bars {g} look identical but were read as {sorted(map(str, got))}")
    for first, names in lines:
        img_line = meta["bars"][first - 1]["line"]
        n_on_line = sum(1 for b in meta["bars"] if b["line"] == img_line)
        if n_on_line != len(names):
            problems.append(f"line at bar {first}: {len(names)} read, {n_on_line} in the picture")
    print("\n".join(problems) or "consistent with the image grouping")

    rel = os.path.relpath(lines_dir, out.parent).replace(os.sep, "/")
    md = [f"# {title(reading)}: the reading, line by line", "",
          "Each picture is one line of the score; the grids under it are the same bars, in order.",
          "`x` cymbal, `o` drum or open hi-hat, `O` accent, `f` flam, `g` ghost, `d` double (and a 32nd after), `.` nothing; "
          "a `<` after a name is a crescendo.", ""]
    for first, names in lines:
        img_line = meta["bars"][first - 1]["line"]
        last = first + len(names) - 1
        md += [f"## Bars {first}-{last}", "", f"![bars {first}-{last}]({rel}/line{img_line:02d}.png)", "",
               "```", grid_block(names, patterns), "```", ""]
    md += ["## The patterns", ""]
    for p in patterns.values():
        if p["name"] == "rest":
            continue
        used = [b for b, n in seq.items() if n == p["name"]]
        md += [f"**{p['name']}**: {p['desc']} (bars {', '.join(map(str, used))})", "", "```",
               grid_block([p["name"]], patterns), "```", ""]
    out.write_text("\n".join(md), encoding="utf-8")
    print(f"wrote {out}")
    if problems:
        sys.exit(1)


if __name__ == "__main__":
    main()
