"""Turn a reading into tab.mid, placed on the record by its own drum hits.

1. Expand reading.txt to one pattern per score bar.
2. For each candidate "which score bar is the song's bar 1", put every kick and
   snare on the song's beat map and count how many land on a hit in the drum
   stem (the same onset picking and 90 ms window as `drums reference`). The
   best offset is the alignment: the audio decides it. --first-bar pins it.
3. List the bars to look at again: written kicks and snares with no hit near
   them, and strong hits on the record where nothing at all is written.
4. With --write, write songs/<slug>/tab.mid (on the chart's grid of 32nds from
   bar 1, General MIDI drum keys) and print the [midi_map] song.toml needs.

The reading is in sixteenths; a `d` cell is a double, the cell's hit and
another a 32nd after it (the score's 32nd-note kick pairs).

usage (any directory): python <this> <reading.txt> <slug> [--first-bar N] [--write]
"""

import argparse
import sys
from pathlib import Path

import mido
import numpy as np

REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from pipeline import grid as grid_mod, onsets, paths  # noqa: E402
from pipeline.chart import SLOTS_PER_BEAT  # noqa: E402
from pipeline.reference import BANDS, slot_to_seconds  # noqa: E402
from review import base, parse  # noqa: E402

#: Reading row -> (General MIDI drum key, the app's instrument name).
KEYS = {
    "BD": (36, "kick"), "SD": (38, "snare"), "XS": (37, "sidestick"),
    "HH": (42, "hihat_closed"), "HHo": (46, "hihat_open"), "HP": (44, "hihat_pedal"),
    "CR": (49, "crash"), "CR2": (57, "crash2"), "RD": (51, "ride"),
    "HT": (50, "tom_high"), "MT": (47, "tom_mid"), "FT": (43, "tom_floor"),
}
#: A cell is a sixteenth: this many slots of the chart's grid.
CELL = SLOTS_PER_BEAT // 4
#: Slots in a 4/4 bar.
BAR = 16 * CELL
VELOCITY = {"x": 96, "o": 96, "O": 120, "X": 120, "f": 110, "g": 40, "d": 96}


def score_bars(reading: Path) -> tuple[dict, list[str]]:
    patterns, lines = parse(reading)
    seq: list[str] = []
    for first, names in lines:
        if first != len(seq) + 1:
            raise SystemExit(f"the line at bar {first} follows bar {len(seq)}")
        seq += [base(n) for n in names]
    return patterns, seq


def notes_for(patterns: dict, seq: list[str], first_bar: int) -> list[tuple[int, str, int]]:
    """(slot from song bar 1, row name, velocity), with score bar `first_bar` as song bar 1.

    Slots are the chart's (32nds); a `d` cell is two notes, a 32nd apart.
    """
    out = []
    for i, name in enumerate(seq):
        song_bar = i + 1 - (first_bar - 1)
        for row, cells in patterns[name]["rows"].items():
            for k, c in enumerate(cells):
                if c == ".":
                    continue
                key = "HHo" if row == "HH" and c == "o" else row
                at = (song_bar - 1) * BAR + k * CELL
                out.append((at, key, VELOCITY[c]))
                if c == "d":
                    out.append((at + CELL // 2, key, VELOCITY[c]))
    return out


def picked(song: paths.Song) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    y, sr = onsets.load_mono(song.drums)
    spectrum = onsets.magnitudes(y)
    times = onsets.envelope_times(spectrum.shape[1], sr)
    found = {}
    for inst, (fmin, fmax) in BANDS.items():
        env = onsets.normalize(onsets.superflux(y, sr, fmin, fmax, spectrum=spectrum))
        at = onsets.pick_onsets(env, times, delta=0.06, wait=0.04)
        found[inst] = (at, np.interp(at, times, env))
    return found


def check(grid, notes, found, window_ms: float) -> dict:
    res = {}
    for inst, key in (("kick", "BD"), ("snare", "SD")):
        at_found, _ = found[inst]
        written = [s for s, k, _ in notes if k == key and s >= 0]
        hit = 0
        missing = []
        for s in written:
            t = slot_to_seconds(grid, s)
            if t is not None and at_found.size and np.min(np.abs(at_found - t)) * 1000 <= window_ms:
                hit += 1
            else:
                missing.append(s)
        res[inst] = (hit, len(written), missing)
    return res


def beat_name(k: int) -> str:
    """A slot in the bar, counted: "1", "2e", "3&", "4a", or "4a+" for the 32nd after."""
    cell, rest = divmod(k, CELL)
    return f"{cell // 4 + 1}{['', 'e', '&', 'a'][cell % 4]}{'+' if rest else ''}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("reading", type=Path)
    ap.add_argument("slug")
    ap.add_argument("--first-bar", type=int, help="the score bar that is the song's bar 1")
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()
    song = paths.song_dir(a.slug)
    grid = grid_mod.load(song)
    patterns, seq = score_bars(a.reading)
    found = picked(song)
    print(f"{len(seq)} score bars, beat map {grid.bar_count} bars, count-in {grid.count_in_bars}")

    if a.first_bar:
        first = a.first_bar
    else:
        rates = []
        # Negative: the score video can start after the record does (Numb's
        # score begins at the song's bar 3, so its bar 1 is song bar 3 = -1).
        for cand in [*range(-7, 0), *range(1, 9)]:
            r = check(grid, notes_for(patterns, seq, cand), found, 90)
            hit = sum(v[0] for v in r.values())
            total = sum(v[1] for v in r.values())
            rates.append((hit / max(total, 1), cand))
            print(f"  score bar {cand} = song bar 1: {hit}/{total} kick+snare on a hit ({hit / max(total, 1):.1%})")
        rates.sort(reverse=True)
        first = rates[0][1]
        # A groove that repeats every two bars puts the offsets two bars
        # either side within a few points of the right one (Come As You Are:
        # 100% at the right offset, 94.9% two bars off). A reading that is
        # right lands near 100% at one offset and clearly less at any other.
        if rates[0][0] < 0.95 or rates[0][0] - rates[1][0] < 0.03:
            print(f"  ! no clear winner ({rates[0][0]:.1%} vs {rates[1][0]:.1%}): look before trusting {first}")
    notes = notes_for(patterns, seq, first)
    print(f"\nalignment: score bar {first} is the song's bar 1 (song bar = score bar - {first - 1})")
    for window in (90, 60, 30):
        r = check(grid, notes, found, window)
        print(f"  within {window:>2} ms: " + ", ".join(
            f"{inst} {h}/{n} ({h / max(n, 1):.1%})" for inst, (h, n, _) in r.items()))

    flagged: dict[int, list[str]] = {}
    for inst, (_, _, missing) in check(grid, notes, found, 60).items():
        for s in missing:
            flagged.setdefault(s // BAR + first, []).append(f"written {inst} on {beat_name(s % BAR)}, no hit")
    # Strong hits where nothing at all is written. Only "nothing at all": a
    # crash or the kick rings in the snare band and the snare's body in the
    # kick band, so a hit on a written cymbal is not evidence of a snare.
    every = np.array(sorted({slot_to_seconds(grid, s) for s, _, _ in notes if s >= 0}))
    first_t = slot_to_seconds(grid, 0)
    last_t = slot_to_seconds(grid, (len(seq) - first + 1) * BAR)
    for inst in ("kick", "snare"):
        at, strength = found[inst]
        strong = at[(strength > np.percentile(strength, 50)) & (at > first_t - 0.1) & (at < last_t)]
        for t in strong:
            if np.min(np.abs(every - t)) * 1000 > 60:
                pos = (grid_mod.beat_position(grid, np.array([t]))[0] - grid.bar_one_beat) * 4
                slot = int(round(pos)) * CELL
                flagged.setdefault(slot // BAR + first, []).append(
                    f"loud {inst}-range hit near {beat_name(slot % BAR)}, nothing written")
    print(f"\nbars to look at again ({len(flagged)} of {len(seq)}):")
    for bar in sorted(flagged):
        name = seq[bar - 1] if 0 < bar <= len(seq) else "-"
        print(f"  score bar {bar:>3} = song bar {bar - first + 1:>3} ({name}): " + "; ".join(flagged[bar]))

    if a.write:
        write_midi(song.tab_midi, notes, grid)
        print(f"\nwrote {song.tab_midi}")
        used = sorted({KEYS[k] for s, k, _ in notes if s >= 0})
        print("\nsong.toml needs:\n[midi_map]")
        for key, name in used:
            print(f'{key} = "{name}"')


def write_midi(path: Path, notes, grid) -> None:
    ppq = 480
    step = ppq // SLOTS_PER_BEAT
    mid = mido.MidiFile(ticks_per_beat=ppq)
    tr = mido.MidiTrack()
    mid.tracks.append(tr)
    tr.append(mido.MetaMessage("track_name", name="drums (read from score video)", time=0))
    tr.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(round(grid.score.bpm)), time=0))
    tr.append(mido.MetaMessage("time_signature", numerator=4, denominator=4, time=0))
    events = []
    for s, key, vel in notes:
        if s < 0:
            continue  # before the song's bar 1: the count-in has no place in the chart
        n = KEYS[key][0]
        events.append((s * step, 1, n, vel))
        events.append((s * step + step // 2, 0, n, 0))
    events.sort(key=lambda e: (e[0], e[1], e[2]))
    now = 0
    for t, on, n, vel in events:
        tr.append(mido.Message("note_on" if on else "note_off", channel=9, note=n,
                               velocity=vel if on else 0, time=t - now))
        now = t
    tr.append(mido.MetaMessage("end_of_track", time=0))
    mid.save(path)


if __name__ == "__main__":
    main()
