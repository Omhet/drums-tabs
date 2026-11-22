"""How strong the record's kick or snare is on every sixteenth, next to the reading.

to_midi.py counts a written note as on a hit when any onset is within 90 ms.
On a dense drum stem (Sonne's had guitar bleed on nearly every sixteenth) that
passes notes the record does not play. This prints, per bar, the band's onset
strength at each sixteenth (+-60 ms) on a 0-9 scale where 5 is the median of
the written notes, with the written ones in brackets, and the same for
nodrums.wav underneath to tell bass bleed from a drum. A written note at 0-1
is not on the record; an unwritten cell as strong as the written ones around
it is a hit the score leaves out.

usage (any directory): python -I <this> <reading.txt> <slug> <first_bar> <kick|snare> <bar_from> <bar_to>
"""

import sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from pipeline import grid as grid_mod, onsets, paths  # noqa: E402
from pipeline.reference import BANDS  # noqa: E402
from to_midi import notes_for, score_bars  # noqa: E402

WINDOW = 0.06


def main() -> None:
    reading, slug, first = Path(sys.argv[1]), sys.argv[2], int(sys.argv[3])
    inst, b0, b1 = sys.argv[4], int(sys.argv[5]), int(sys.argv[6])
    row = {"kick": "BD", "snare": "SD"}[inst]
    song = paths.song_dir(slug)
    grid = grid_mod.load(song)
    beats = np.asarray(grid.beats)
    patterns, seq = score_bars(reading)
    written = {s for s, k, _ in notes_for(patterns, seq, first) if k == row}

    def envelope(wav: Path):
        y, sr = onsets.load_mono(wav)
        spectrum = onsets.magnitudes(y)
        return onsets.envelope_times(spectrum.shape[1], sr), onsets.superflux(
            y, sr, *BANDS[inst], spectrum=spectrum)

    def at(times, env, slot: int) -> float:
        beat = grid.bar_one_beat + slot // 4
        if beat < 0 or beat + 1 >= len(beats):
            return 0.0
        t = beats[beat] + (slot % 4) / 4 * (beats[beat + 1] - beats[beat])
        m = (times > t - WINDOW) & (times < t + WINDOW)
        return float(env[m].max()) if m.any() else 0.0

    drums = envelope(song.drums)
    bleed = envelope(song.stems_dir / "nodrums.wav")
    ref = np.median([at(*drums, s) for s in written if s >= 0])
    print(f"{inst}: 5 = the median written {inst}; [n] = written there")
    for bar in range(b0, b1 + 1):
        base = (bar - first) * 16
        for label, env, mark in ((f"{bar:3d} {seq[bar - 1] if 0 < bar <= len(seq) else '-':<4} drums  ", drums, True),
                                 ("         nodrums", bleed, False)):
            cells = []
            for k in range(16):
                v = str(min(9, int(round(5 * at(*env, base + k) / ref))))
                cells.append(f"[{v}]" if mark and base + k in written else f" {v} ")
                if k % 4 == 3:
                    cells.append("|")
            print(f"{label} {''.join(cells)}")


if __name__ == "__main__":
    main()
