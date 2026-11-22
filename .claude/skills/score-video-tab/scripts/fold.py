"""Where the record's kick and snare sit on the beat grid, averaged over bars.

Folds the drum stem's kick- and snare-band onset envelopes over the bar at 32
points (32nds, placed between the grid's beats) and averages them over a run
of bars. On a right grid the snare peaks on 2 and 4. Sonne's peaked on the "&"
of 1 and of 3: the detector had every beat on the "&", and `tempo_multiplier =
"offbeat"` in song.toml fixed it.

Run it when every offset in to_midi.py scores about the same and well under
95%: the grid, not the reading, is the first suspect then.

usage (any directory): python -I <this> <slug> <bar_from> <bar_to>
"""

import sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO))

from pipeline import grid as grid_mod, onsets, paths  # noqa: E402
from pipeline.reference import BANDS  # noqa: E402


def main() -> None:
    slug, b0, b1 = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    song = paths.song_dir(slug)
    grid = grid_mod.load(song)
    y, sr = onsets.load_mono(song.drums)
    spectrum = onsets.magnitudes(y)
    times = onsets.envelope_times(spectrum.shape[1], sr)
    beats = np.asarray(grid.beats)
    labels = [f"{b}{s}" for b in range(1, 5) for s in ("", "e", "&", "a")]
    for inst in ("kick", "snare"):
        env = onsets.normalize(onsets.superflux(y, sr, *BANDS[inst], spectrum=spectrum))
        prof = np.zeros(32)
        n = 0
        for bar in range(b0, b1 + 1):
            i0 = grid.bar_one_beat + (bar - 1) * grid.beats_per_bar
            if i0 + 4 >= len(beats):
                break
            for k in range(32):
                beat = i0 + k // 8
                t = beats[beat] + (k % 8) / 8 * (beats[beat + 1] - beats[beat])
                m = (times > t - 0.015) & (times < t + 0.015)
                prof[k] += env[m].max() if m.any() else 0.0
            n += 1
        prof /= max(n, 1)
        print(f"{inst}, bars {b0}-{b0 + n - 1}:")
        for k in range(32):
            label = labels[k // 2] if k % 2 == 0 else "+"
            print(f"  {label:>3} {'#' * int(round(40 * prof[k] / prof.max())):<40} {prof[k]:.2f}")


if __name__ == "__main__":
    main()
