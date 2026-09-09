"""Debug renders for the grid. The whole point of Phase 1a.

A beat grid can only be validated by a human, and only if looking at it is
cheap. Two artifacts do that job:

**``debug/grid.png``** answers, in one glance, the three questions that decide
whether a grid is usable -- is the tempo octave right, is the downbeat phase
right, and does the grid still track the drummer at the end of the song. The
last one is why the phase-scatter panel exists: drift shows up there as a
diagonal smear long before it's audible.

**``debug/beat_click.wav``** is the confirmation. A grid can look plausible and
still be a beat off; playing a click over the mix settles it in ten seconds.
"""

from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # no display on a headless run; must precede pyplot

import matplotlib.pyplot as plt
import numpy as np
import soundfile as sf

from pipeline import grid as grid_mod
from pipeline import onsets, paths
from pipeline.backends.base import OnsetEvent
from pipeline.grid import DrumSupport, Grid

# Zoom strips are placed at these fractions through the song. The last one is the
# important one -- accumulated drift is invisible at the start by definition.
ZOOM_POSITIONS = (0.0, 0.33, 0.66, 0.97)
ZOOM_BARS = 4


def render_inspector(
    song: paths.Song, grid: Grid, support: DrumSupport | None = None
) -> Path:
    """Write ``debug/grid.png``."""
    support = support or DrumSupport.from_stem(song.drums)
    song.debug_dir.mkdir(parents=True, exist_ok=True)

    fig = plt.figure(figsize=(16, 13), dpi=110)
    spec = fig.add_gridspec(
        3 + len(ZOOM_POSITIONS),
        2,
        height_ratios=[0.9, 1.5, 1.3] + [1.0] * len(ZOOM_POSITIONS),
        hspace=0.75,
        wspace=0.18,
    )

    _panel_tempo(fig.add_subplot(spec[0, :]), grid)
    _panel_phase_profile(fig.add_subplot(spec[1, 0]), grid, support)
    _panel_phase_scatter(fig.add_subplot(spec[1, 1]), grid, support)
    _panel_decisions(fig.add_subplot(spec[2, :]), grid)

    y, sr = onsets.load_mono(song.drums)
    # Separated drum stems come out at wildly different levels, and a quiet one
    # is invisible against a fixed +/-1 axis -- which silently turns the zoom
    # strips, the part you actually check the grid against, into blank boxes.
    # Scale by a high percentile rather than the peak so one crash doesn't
    # flatten everything else.
    scale = float(np.percentile(np.abs(y), 99.9)) or 1.0
    for row, fraction in enumerate(ZOOM_POSITIONS):
        _panel_zoom(fig.add_subplot(spec[3 + row, :]), grid, y / scale, sr, fraction)

    meta = song.meta().get("source", {})
    fig.suptitle(
        f"{meta.get('title', song.slug)}\n"
        f"{grid.score.bpm:.1f} BPM   {grid.bar_count} bars   "
        f"count-in {grid.count_in_bars} bar(s)   "
        f"rotation {grid.downbeat_offset}   "
        f"backbeat margin {grid.score.backbeat_margin:+.3f}",
        fontsize=13,
        y=0.985,
    )
    fig.savefig(song.grid_png, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return song.grid_png


def _panel_tempo(ax, grid: Grid) -> None:
    """Instantaneous tempo over the song.

    An octave error reads as a flat line in the wrong place; dropped or inserted
    beats read as isolated spikes; a genuine tempo change reads as a slope. All
    three are diagnoses, and they look nothing alike.
    """
    intervals = np.diff(grid.beats)
    bpm = 60.0 / intervals
    ax.plot(grid.beats[:-1], bpm, lw=0.7, color="#2b6cb0")
    median = float(np.median(bpm))
    ax.axhline(median, color="#c05621", lw=1.0, ls="--", label=f"median {median:.1f}")
    ax.axhspan(*grid_mod.PLAUSIBLE_BPM, color="#38a169", alpha=0.06)
    ax.set_ylim(max(0, median * 0.6), median * 1.45)
    ax.set_ylabel("BPM")
    ax.set_xlabel("time (s)")
    ax.set_title("tempo per beat", fontsize=10, loc="left")
    ax.legend(loc="upper right", fontsize=8, framealpha=0.9)

    for event in grid.repair.get("intervals", {}).get("events", []):
        ax.axvline(
            event["at"],
            color="#e53e3e" if "drop" in event["action"] else "#d69e2e",
            lw=0.8,
            alpha=0.7,
        )


def _panel_phase_profile(ax, grid: Grid, support: DrumSupport) -> None:
    """Mean kick and snare strength per beat of the bar. The downbeat-phase evidence.

    If the phase is right this shows kick leaning on beat 1 and snare on 2 and 4.
    If it's rotated by two, snare peaks on 1 and 3 and the picture is obviously
    wrong without needing to hear anything.
    """
    kick = onsets.support_at(support.kick, support.times, grid.beats)
    snare = onsets.support_at(support.snare, support.times, grid.beats)
    position = (np.arange(grid.beats.size) - grid.downbeat_offset) % grid.beats_per_bar

    labels = [str(i + 1) for i in range(grid.beats_per_bar)]
    kick_means = [float(kick[position == i].mean()) for i in range(grid.beats_per_bar)]
    snare_means = [float(snare[position == i].mean()) for i in range(grid.beats_per_bar)]

    x = np.arange(grid.beats_per_bar)
    ax.bar(x - 0.2, kick_means, width=0.4, color="#2c5282", label="kick band")
    ax.bar(x + 0.2, snare_means, width=0.4, color="#c53030", label="snare band")
    ax.set_xticks(x, labels)
    ax.set_xlabel("beat of bar")
    ax.set_ylabel("mean onset strength")
    ax.set_title("phase check: kick on 1, snare on 2 and 4", fontsize=10, loc="left")
    ax.legend(fontsize=8)


def _panel_phase_scatter(ax, grid: Grid, support: DrumSupport) -> None:
    """Every drum onset's position within the bar, against time.

    The drift detector. A grid that tracks the performance keeps these in tight
    vertical columns for the whole song; a grid that's slightly off tempo smears
    them into diagonals that walk across the bar.
    """
    combined = onsets.normalize(np.maximum(support.kick, support.snare))
    events = onsets.pick_onsets(combined, support.times)
    if events.size == 0:
        ax.set_title("phase scatter: no onsets found", fontsize=10, loc="left")
        return
    bar, phase = grid_mod.bar_position(grid, events)
    ax.scatter(bar, phase, s=1.5, alpha=0.35, color="#2d3748", linewidths=0)
    for beat in range(grid.beats_per_bar):
        ax.axhline(beat, color="#a0aec0", lw=0.6)
    ax.set_ylim(-0.15, grid.beats_per_bar - 0.85)
    ax.set_yticks(range(grid.beats_per_bar), [str(i + 1) for i in range(grid.beats_per_bar)])
    ax.set_xlabel("bar")
    ax.set_ylabel("position in bar")
    ax.set_title(
        "drift check: columns stay vertical if the grid tracks", fontsize=10, loc="left"
    )


def _panel_decisions(ax, grid: Grid) -> None:
    """The repair log, rendered into the image so the PNG is self-contained."""
    ax.axis("off")
    repair = grid.repair
    tempo = repair.get("tempo", {})
    lines = [
        f"detector      {grid.source.get('detector')} / {grid.source.get('checkpoint')}"
        f"   separation {grid.source.get('separation') or 'n/a'}",
        f"beats         {repair.get('raw_beat_count')} raw -> {repair.get('beat_count')} "
        f"({repair.get('intervals', {}).get('inserted', 0)} inserted, "
        f"{repair.get('intervals', {}).get('dropped', 0)} dropped, "
        f"{repair.get('edges_trimmed', {}).get('head', 0)}+"
        f"{repair.get('edges_trimmed', {}).get('tail', 0)} trimmed from the edges)",
        f"tempo         median {tempo.get('median_bpm')} BPM, "
        f"10-90th pct {tempo.get('p10_bpm')}-{tempo.get('p90_bpm')}, "
        f"drift {tempo.get('drift_pct')}%",
        f"octave        {repair.get('octave', {}).get('decision')}",
        f"local octave  {_describe_local_octave(repair.get('local_octave', {}))}",
        f"rotation      {repair.get('rotation', {}).get('decision')}",
        f"              margins per rotation "
        f"{repair.get('rotation', {}).get('margins')}",
        f"bar one       {repair.get('bar_one', {}).get('decision')}",
        f"quality       snare alignment {grid.score.snare_alignment:.3f}, "
        f"beat coverage {grid.score.coverage:.1%}",
    ]
    ax.text(
        0.0,
        1.0,
        "\n".join(lines),
        va="top",
        ha="left",
        family="monospace",
        fontsize=9,
        transform=ax.transAxes,
    )


def _describe_local_octave(log: dict) -> str:
    runs = log.get("runs") or []
    if not runs:
        return "no double-time stretches"
    return "; ".join(
        f"{r['from']:.0f}-{r['to']:.0f}s ran at {r['local_bpm']} vs {r['song_bpm']} "
        f"BPM, halved ({r['beats_dropped']} beats)"
        for r in runs
    )


def _panel_zoom(ax, grid: Grid, y: np.ndarray, sr: int, fraction: float) -> None:
    """A few bars of the drum stem with the grid drawn over it."""
    first_bar = max(1, int(round((grid.bar_count - ZOOM_BARS) * fraction)) + 1)
    last_bar = min(grid.bar_count, first_bar + ZOOM_BARS)
    start = grid.bar_start(first_bar)
    end = grid.bar_start(last_bar)

    lo, hi = int(start * sr), min(len(y), int(end * sr))
    if hi <= lo:
        ax.axis("off")
        return
    segment = np.clip(y[lo:hi], -1.0, 1.0)
    times = np.linspace(start, end, segment.size)
    ax.plot(times, segment, lw=0.4, color="#4a5568")
    ax.set_xlim(start, end)
    ax.set_ylim(-1.05, 1.05)
    ax.set_yticks([])

    for index, beat_time in enumerate(grid.beats):
        if not start <= beat_time <= end:
            continue
        is_downbeat = (index - grid.downbeat_offset) % grid.beats_per_bar == 0
        ax.axvline(
            beat_time,
            color="#e53e3e" if is_downbeat else "#a0aec0",
            lw=1.6 if is_downbeat else 0.7,
        )
        if is_downbeat:
            bar_number = (index - grid.bar_one_beat) // grid.beats_per_bar + 1
            ax.text(
                beat_time,
                1.06,
                str(bar_number),
                color="#e53e3e",
                fontsize=8,
                ha="left",
                va="bottom",
            )
    ax.set_xlabel("time (s)", fontsize=8, labelpad=1)
    ax.tick_params(axis="x", labelsize=8)
    ax.set_title(
        f"bars {first_bar}-{last_bar} (red, above)   {start:.1f}-{end:.1f}s",
        fontsize=9,
        loc="left",
    )


# --------------------------------------------------------------------------
# click track
# --------------------------------------------------------------------------


def _click(sr: int, freq: float, duration: float = 0.035) -> np.ndarray:
    """A short exponentially-decaying sine. Cuts through a dense mix; no ringing."""
    t = np.arange(int(sr * duration)) / sr
    return np.sin(2 * np.pi * freq * t) * np.exp(-t * 90.0)


def render_click_track(song: paths.Song, grid: Grid, *, mix_gain: float = 0.55) -> Path:
    """Mix a beat click over ``mix.wav``, with a different pitch on each downbeat.

    Two pitches rather than one because the phase, not the tempo, is what usually
    goes wrong -- and a same-pitch click sounds correct even when it's a beat off.
    """
    data, sr = sf.read(str(song.mix), always_2d=True, dtype="float32")
    mono = data.mean(axis=1) * mix_gain

    downbeat = _click(sr, 1600.0)
    offbeat = _click(sr, 900.0)
    for index, beat_time in enumerate(grid.beats):
        start = int(beat_time * sr)
        is_downbeat = (index - grid.downbeat_offset) % grid.beats_per_bar == 0
        click = downbeat if is_downbeat else offbeat
        end = min(mono.size, start + click.size)
        if start >= mono.size:
            break
        mono[start:end] += click[: end - start] * (0.5 if is_downbeat else 0.3)

    peak = float(np.max(np.abs(mono))) or 1.0
    if peak > 0.99:
        mono *= 0.99 / peak

    song.debug_dir.mkdir(parents=True, exist_ok=True)
    sf.write(str(song.beat_click), mono, sr, subtype="PCM_16")
    return song.beat_click

# --------------------------------------------------------------------------
# onset click tracks
# --------------------------------------------------------------------------

# One pitch per instrument, so a stray hit is identifiable by ear without
# looking anywhere: a click where the drum stem is silent is a phantom, a hit
# with no click over it is a miss.
ONSET_CLICK_HZ: dict[str, float] = {
    "kick": 700.0,
    "snare": 1200.0,
    "hihat_closed": 2400.0,
    "hihat_open": 2400.0,
    "tom_high": 1000.0,
    "tom_mid": 900.0,
    "tom_floor": 800.0,
    "ride": 2000.0,
    "crash": 1800.0,
}


def render_onset_clicks(
    song: paths.Song,
    events: list[OnsetEvent],
    *,
    stem_gain: float = 0.6,
) -> list[Path]:
    """One click track per instrument, mixed over the drum stem.

    Per instrument rather than one combined track because these are checked by
    *listening*, and a combined track only tells you that something is wrong
    somewhere. Played against drums.wav, a kick track answers "did it find the
    kicks" on its own.
    """
    by_instrument: dict[str, list[float]] = {}
    for event in events:
        by_instrument.setdefault(event.instrument, []).append(event.t)

    data, sr = sf.read(str(song.drums), always_2d=True, dtype="float32")
    stem = data.mean(axis=1) * stem_gain
    song.debug_dir.mkdir(parents=True, exist_ok=True)

    written: list[Path] = []
    for instrument, times in sorted(by_instrument.items()):
        track = stem.copy()
        click = _click(sr, ONSET_CLICK_HZ.get(instrument, 1500.0))
        for t in times:
            start = int(t * sr)
            if start >= track.size:
                continue
            end = min(track.size, start + click.size)
            track[start:end] += click[: end - start] * 0.4
        peak = float(np.max(np.abs(track))) or 1.0
        if peak > 0.99:
            track *= 0.99 / peak
        out = song.onset_click(instrument)
        sf.write(str(out), track, sr, subtype="PCM_16")
        written.append(out)
    return written
