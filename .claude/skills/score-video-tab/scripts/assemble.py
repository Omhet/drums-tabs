"""Put the readers' sheets together into reading.txt.

Each reader writes one file per sheet, <read_dir>/gNN.txt: a `pattern gNN`
block in reading.txt's format, or just `rest`, and a `crescendo` line if a
hairpin sits under the bar (references/reader.md has the format). This checks
every file, gives groups with the same grid one pattern (named after the first
group), and writes reading.txt's patterns and bar list, one row per score line,
from bars.json. The header -- the comment lines at the top of reading.txt --
is kept, so write it first.

It builds the first reading only. After that reading.txt is the source: fix
misreads and the user's changes there. It refuses to overwrite a reading.txt
that already has patterns.

Prints every comment the readers left, by group: their doubts and what the
grid could not hold. Look at those sheets yourself.

usage: python -I assemble.py <bars_dir> <read_dir> <reading.txt>
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from review import ORDER  # noqa: E402

CELLS = set("xoOXfgd.")


def read_sheet(path: Path) -> dict:
    """{"rest": bool, "desc", "rows": {inst: (cells, comment)}, "notes": [...], "cresc": bool}"""
    s = {"rest": False, "desc": "", "rows": {}, "notes": [], "cresc": False}
    seen_pattern = False
    for n, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        body, _, comment = raw.partition("#")
        body, comment = body.strip(), comment.strip()
        where = f"{path.name}:{n}"
        if not body:
            if comment:
                s["notes"].append(comment)
            continue
        words = body.split()
        if words == ["rest"]:
            s["rest"] = True
        elif words == ["crescendo"]:
            s["cresc"] = True
        elif words[0] == "pattern":
            if len(words) < 2 or words[1] != path.stem:
                raise SystemExit(f"{where}: the block should be named {path.stem}")
            s["desc"] = body.split(None, 2)[2] if len(words) > 2 else ""
            seen_pattern = True
        else:
            inst, cells = words[0], words[1:]
            if inst not in ORDER:
                raise SystemExit(f"{where}: unknown row {inst} (rows are {', '.join(ORDER)})")
            if len(cells) != 16 or not set(cells) <= CELLS:
                raise SystemExit(f"{where}: {inst} needs sixteen cells of {''.join(sorted(CELLS))}")
            s["rows"][inst] = (" ".join(cells), comment)
    if s["rest"] == seen_pattern:
        raise SystemExit(f"{path.name}: needs a pattern block or `rest`, not {'both' if seen_pattern else 'neither'}")
    return s


def main() -> None:
    bars_dir, read_dir, out = map(Path, sys.argv[1:4])
    sys.stdout.reconfigure(encoding="utf-8")
    meta = json.loads((bars_dir / "bars.json").read_text())
    groups = meta["groups"]
    missing = [f"g{g:02d}" for g in range(len(groups)) if not (read_dir / f"g{g:02d}.txt").exists()]
    if missing:
        raise SystemExit(f"no reading for {', '.join(missing)}")

    head: list[str] = []
    if out.exists():
        for line in out.read_text(encoding="utf-8").splitlines():
            if line.startswith("pattern ") or line.strip() == "bars":
                raise SystemExit(f"{out} already has a reading; edit it there")
            head.append(line)
    while head and not head[-1].strip():
        head.pop()

    name_of: dict[int, str] = {}     # group -> pattern name
    cresc: set[int] = set()
    by_grid: dict[tuple, str] = {}
    blocks: list[str] = []
    for g in range(len(groups)):
        s = read_sheet(read_dir / f"g{g:02d}.txt")
        if s["cresc"]:
            cresc.add(g)
        for note in s["notes"] + [f"{i}: {c}" for i, (_, c) in s["rows"].items() if c]:
            print(f"g{g:02d} (bars {', '.join(map(str, groups[g]))}): {note}")
        if s["rest"]:
            name_of[g] = "rest"
            continue
        key = tuple(sorted((i, cells) for i, (cells, _) in s["rows"].items()))
        if key in by_grid:
            name_of[g] = by_grid[key]
            continue
        name = by_grid[key] = name_of[g] = f"g{g:02d}"
        block = [f"pattern {name:<7} {s['desc']}"] + [f"# {n}" for n in s["notes"]]
        for inst in ORDER:
            if inst in s["rows"]:
                cells, comment = s["rows"][inst]
                block.append(f"  {inst:<3} {cells}" + (f"   # {comment}" if comment else ""))
        blocks.append("\n".join(block))

    group_of = {b: g for g, members in enumerate(groups) for b in members}
    lines: dict[int, list[int]] = {}
    for b in meta["bars"]:
        lines.setdefault(b["line"], []).append(b["bar"])
    rows = []
    for bars in lines.values():
        names = [name_of[group_of[b]] + ("<" if group_of[b] in cresc else "") for b in bars]
        rows.append(f"  {bars[0]:<4} " + " ".join(names))

    text = "\n".join(head + [""] + ["\n\n".join(blocks), "", "bars", *rows]) + "\n"
    out.write_text(text.lstrip("\n"), encoding="utf-8")
    print(f"{len(groups)} sheets, {len(blocks)} patterns: wrote {out}")


if __name__ == "__main__":
    main()
