"""The render plan, and the slicing that has to find its way back out of a wav.

The render itself is not tested here: it needs the plugin, its licence and
several gigabytes of samples. `drums kit-bake --smoke` is that test, and it is
the first thing the real command runs. What *is* testable without any of that
is the arithmetic on either side of it -- where each sample was asked for, and
whether it can be found again -- and that is where the mistakes would be.
"""

from __future__ import annotations

import numpy as np
import pytest

from pipeline import bake
from pipeline.kit import Articulation, Instrument, Kit, Render, Sampler, Weights
from pipeline.proc import StageError

SR = bake.SR


def articulation(name: str, **overrides) -> Articulation:
    spec = dict(
        name=name,
        instrument=name,
        default=True,
        note=36,
        layers=3,
        round_robin=2,
        tail_s=0.5,
        stereo=False,
        ring=False,
    )
    spec.update(overrides)
    return Articulation(**spec)


def render_of(*articulations: Articulation, low: int = 20, high: int = 120) -> Render:
    return Render(
        articulations={a.name: a for a in articulations},
        velocity_low=low,
        velocity_high=high,
    )


def kit_of(render: Render) -> Kit:
    instruments = {
        a.instrument: Instrument(
            name=a.instrument, x=0.0, y=0.0, limbs=("right_hand",), time_keeper=False
        )
        for a in render.articulations.values()
    }
    weights = Weights(
        max_speed_cm_s=700,
        travel=1.0,
        crossover=2.0,
        repeat=1.5,
        repeat_below_ms=260,
        lead="right",
        lead_bias=2.5,
    )
    return Kit(
        instruments=instruments,
        hands=weights,
        digest="test",
        render=render,
        sampler=Sampler(choke=(), trim={}),
    )


# --- the plan -----------------------------------------------------------------


def test_every_layer_and_take_gets_a_slot():
    plan = bake.build_plan(render_of(articulation("snare", layers=4, round_robin=3)))
    assert len(plan.slots) == 12
    assert sorted({s.layer for s in plan.slots}) == [0, 1, 2, 3]
    assert sorted({s.rr for s in plan.slots}) == [0, 1, 2]


def test_layers_are_spread_across_the_velocity_range():
    render = render_of(articulation("snare", layers=5), low=20, high=120)
    plan = bake.build_plan(render)
    velocities = sorted({s.velocity for s in plan.slots})
    assert velocities == [20, 45, 70, 95, 120]


def test_one_layer_uses_the_loudest_velocity():
    render = render_of(articulation("snare", layers=1), low=20, high=120)
    assert {s.velocity for s in bake.build_plan(render).slots} == {120}


def test_nothing_can_ring_into_the_next_sample():
    render = render_of(
        articulation("snare", tail_s=0.5),
        articulation("crash", note=49, tail_s=3.5),
    )
    plan = bake.build_plan(render)
    for earlier, later in zip(plan.slots, plan.slots[1:], strict=False):
        assert later.at_s - earlier.at_s >= earlier.tail_s + bake.GAP_S - 1e-9


def test_the_plan_starts_after_the_mark_has_died_away():
    plan = bake.build_plan(render_of(articulation("snare")))
    assert plan.slots[0].at_s >= bake.MARK_AT_S + bake.MARK_GAP_S
    assert plan.duration_s > plan.slots[-1].at_s + plan.slots[-1].tail_s


def test_only_renders_one_articulation():
    render = render_of(articulation("snare"), articulation("crash", note=49))
    plan = bake.build_plan(render, only="crash")
    assert {s.articulation for s in plan.slots} == {"crash"}


def test_only_an_unknown_articulation_says_what_there_is():
    render = render_of(articulation("snare"))
    with pytest.raises(StageError, match="snare"):
        bake.build_plan(render, only="cowbell")


def test_smoke_is_small_enough_to_be_worth_running():
    render = render_of(
        articulation("kick", layers=6, round_robin=4),
        articulation("snare", note=38, layers=10, round_robin=4),
        articulation("hat", note=42, layers=8, round_robin=4),
        articulation("ride", note=51, layers=6, round_robin=4),
    )
    plan = bake.build_plan(render, smoke=True)
    assert len(plan.slots) == 12
    assert plan.duration_s < 30


# --- slicing ------------------------------------------------------------------


def burst(frames: int, seed: int, decay: float = 40.0) -> np.ndarray:
    """A drum-shaped noise: sharp attack, exponential tail, its own waveform."""
    rng = np.random.default_rng(seed)
    t = np.arange(frames) / SR
    return (rng.standard_normal(frames) * np.exp(-decay * t)).astype(np.float32)


def fake_render(plan: bake.Plan, delta_s: float = 0.0, silent: set[str] | None = None):
    """A render as the plugin would hand it back, with each hit where it belongs."""
    silent = silent or set()
    total = int((plan.duration_s + delta_s + 2.0) * SR)
    audio = np.zeros((2, total), dtype=np.float32)

    def place(at_s: float, data: np.ndarray, gain: float):
        start = int(round((at_s + delta_s) * SR))
        end = min(total, start + len(data))
        audio[0, start:end] += data[: end - start] * gain
        audio[1, start:end] += data[: end - start] * gain

    place(bake.MARK_AT_S, burst(int(0.3 * SR), seed=0), 0.9)
    for i, slot in enumerate(plan.slots):
        if slot.articulation in silent:
            continue
        length = int(slot.tail_s * 0.8 * SR)
        place(slot.at_s, burst(length, seed=i + 1), slot.velocity / 127 * 0.5)
    return audio


def test_a_slice_is_found_at_the_right_place_and_length():
    plan = bake.build_plan(render_of(articulation("snare", layers=2, round_robin=2)))
    cuts = bake.slice_render(fake_render(plan), plan)
    assert len(cuts) == len(plan.slots)
    for cut in cuts:
        assert cut.peak > 0.01
        # Trimmed to the sound: shorter than the window it was cut from, and
        # never longer than the tail it was allowed.
        assert 0 < cut.seconds <= cut.slot.tail_s + bake.LEAD_S + 1e-3


def test_plugin_latency_does_not_walk_the_cuts_off_their_samples():
    plan = bake.build_plan(render_of(articulation("snare", layers=2, round_robin=2)))
    straight = bake.slice_render(fake_render(plan), plan)
    late = bake.slice_render(fake_render(plan, delta_s=0.137), plan)
    for a, b in zip(straight, late, strict=True):
        assert abs(a.seconds - b.seconds) < 0.01
        assert abs(a.peak - b.peak) < 0.01


def test_a_quiet_layer_stays_quieter_than_a_loud_one():
    """The whole point of layers: they are not normalised to each other."""
    plan = bake.build_plan(render_of(articulation("snare", layers=4, round_robin=1)))
    cuts = bake.slice_render(fake_render(plan), plan)
    peaks = [c.peak for c in sorted(cuts, key=lambda c: c.slot.layer)]
    assert peaks == sorted(peaks)
    assert peaks[-1] > peaks[0] * 2


def test_a_mono_articulation_is_folded_and_a_stereo_one_is_not():
    render = render_of(
        articulation("snare", layers=1, round_robin=1),
        articulation("ride", note=51, layers=1, round_robin=1, stereo=True),
    )
    plan = bake.build_plan(render)
    cuts = {c.slot.articulation: c for c in bake.slice_render(fake_render(plan), plan)}
    assert cuts["snare"].data.shape[0] == 1
    assert cuts["ride"].data.shape[0] == 2


def test_a_silent_slice_is_reported_with_the_drum_that_made_it():
    render = render_of(
        articulation("snare", layers=1, round_robin=1),
        articulation("cowbell", note=56, layers=1, round_robin=1),
    )
    plan = bake.build_plan(render)
    cuts = bake.slice_render(fake_render(plan, silent={"cowbell"}), plan)
    with pytest.raises(StageError, match="cowbell"):
        bake.check_audible(cuts)


def test_a_wholly_silent_render_says_so_rather_than_slicing_nothing():
    plan = bake.build_plan(render_of(articulation("snare", layers=1, round_robin=1)))
    with pytest.raises(StageError, match="silent"):
        bake.slice_render(np.zeros((2, int(plan.duration_s * SR)), dtype=np.float32), plan)


# --- the round-robin report ---------------------------------------------------


def test_takes_that_differ_are_reported_as_differing():
    plan = bake.build_plan(render_of(articulation("snare", layers=2, round_robin=3)))
    spread = bake.round_robin_spread(bake.slice_render(fake_render(plan), plan))
    assert spread["snare"] > 0.5


def test_takes_that_are_the_same_recording_are_reported_as_identical():
    """A kit with its round-robin off must not pass quietly: it machine-guns."""
    plan = bake.build_plan(render_of(articulation("snare", layers=2, round_robin=3)))
    audio = fake_render(plan)
    cuts = bake.slice_render(audio, plan)
    same = [bake.Cut(slot=c.slot, data=cuts[0].data.copy(), peak=cuts[0].peak) for c in cuts]
    spread = bake.round_robin_spread(same)
    assert spread["snare"] < 0.02


# --- the manifest -------------------------------------------------------------


def test_the_bank_is_written_with_one_gain_for_all_of_it(tmp_path, monkeypatch):
    render = render_of(articulation("snare", layers=3, round_robin=2))
    monkeypatch.setattr(bake, "SAMPLES_DIR", tmp_path / "samples")
    monkeypatch.setattr(bake, "MANIFEST", tmp_path / "kit.lock.json")
    monkeypatch.setattr(bake, "REPO_ROOT", tmp_path)

    plan = bake.build_plan(render)
    cuts = bake.slice_render(fake_render(plan), plan)
    manifest = bake.write_bank(cuts, kit_of(render), log=lambda _: None)

    assert manifest["sampleRate"] == SR
    snare = manifest["articulations"]["snare"]
    assert snare["instrument"] == "snare"
    assert snare["default"] is True
    assert len(snare["layers"]) == 3
    assert [len(layer["files"]) for layer in snare["layers"]] == [2, 2, 2]
    # Louder layers stay louder in the written bank, and the loudest sits at
    # the headroom the whole bank was scaled to.
    peaks = [layer["peak"] for layer in snare["layers"]]
    assert peaks == sorted(peaks)
    assert peaks[-1] == pytest.approx(10 ** (bake.HEADROOM_DB / 20), rel=0.02)
    for layer in snare["layers"]:
        for name in layer["files"]:
            assert (tmp_path / "samples" / name).exists()


def test_an_incremental_bake_keeps_the_gain_the_rest_of_the_bank_used(tmp_path, monkeypatch):
    render = render_of(articulation("snare", layers=2, round_robin=2))
    monkeypatch.setattr(bake, "SAMPLES_DIR", tmp_path / "samples")
    monkeypatch.setattr(bake, "MANIFEST", tmp_path / "kit.lock.json")
    monkeypatch.setattr(bake, "REPO_ROOT", tmp_path)

    plan = bake.build_plan(render)
    cuts = bake.slice_render(fake_render(plan), plan)
    first = bake.write_bank(cuts, kit_of(render), log=lambda _: None)

    # Re-render one articulation on its own; its slices happen to be quieter,
    # which would rescale the whole bank if the gain were recomputed.
    quiet = [bake.Cut(slot=c.slot, data=c.data * 0.25, peak=c.peak * 0.25) for c in cuts]
    again = bake.write_bank(
        quiet, kit_of(render), gain=first["gain"], merge=True, log=lambda _: None
    )
    assert again["gain"] == first["gain"]
