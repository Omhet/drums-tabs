"""Which hand plays what, and what the hi-hat foot is doing.

The chart says "snare on the 2". It does not say which hand, and a drummer
makes hundreds of those decisions a song. This works them out by minimum
effort -- a path through the whole song, not a choice per note, because the
cheapest hand for this hit is decided by where the other hand has to be for the
next one.

It also derives the **hi-hat foot**, the other thing the chart implies but
never states: ``hihat_open`` means the foot was up at that moment,
``hihat_closed`` that it was down, and ``hihat_pedal`` is a chick with no hand
involved. That is the only instrument in the vocabulary with a state, so it is
one special case rather than the first of many.

Both are proposals, frozen into ``sticking.lock.json`` and pinned to the chart
they were derived from -- the repo's usual measure-once idiom. Hand-fix what
the solver gets wrong; it is authoritative from then on.

**And both double as chart validators.** A passage with no feasible sticking is
one no human can play, and a foot that has to be up and down at the same
instant is a contradiction. Neither is a crash: both name the bar, because a
chart is written by hand in Ableton and hand-written charts have mistakes in
them.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from pipeline.chart import SLOTS_PER_BEAT, Hit, chart_hash, read_hits
from pipeline.kit import HANDS, Kit, Weights
from pipeline.paths import Song
from pipeline.proc import StageError

VERSION = 1
#: More than this many states carried between hits and the search is exploring
#: paths that differ only in an idle hand's history. Never reached in practice
#: -- the hands alternate, so a handful of states survive each hit.
BEAM = 64


@dataclass(frozen=True)
class Stroke:
    """One hit, and the limb that plays it."""

    #: 1-based, as written on the page.
    bar: int
    #: Sixteenths into that bar, 0-based.
    slot: int
    instrument: str
    limb: str
    velocity: int


@dataclass(frozen=True)
class HatChange:
    """The hi-hat foot lifting or dropping, at a place in the chart."""

    bar: int
    slot: int
    open: bool


@dataclass
class Sticking:
    strokes: list[Stroke]
    hat: list[HatChange]
    #: What it was solved from, so it can tell when it is stale.
    chart: str = ""
    kit: str = ""
    tempo_bpm: float = 0.0
    beats_per_bar: int = 4
    cost: float = 0.0
    notes: list[str] = field(default_factory=list)


class Unplayable(StageError):
    """No hand can get there in time -- the chart, not the solver, is wrong."""

    def __init__(self, message: str, event: int = -1):
        super().__init__(message)
        #: Which hit it gave up on, so the caller can say which bar.
        self.event = event


# --- the search ---------------------------------------------------------------


@dataclass(frozen=True)
class _Where:
    """A hand: what it last played, and when (seconds)."""

    instrument: str
    at: float


def _travel(kit: Kit, w: Weights, hand_at: _Where | None, target: str, now: float) -> float | None:
    """Cost of putting a hand on ``target`` now, or None if it cannot get there.

    A hand that has not played yet is already wherever it needs to be: the song
    has not started, and nothing was learned by pretending it has to travel.
    """
    if hand_at is None:
        return 0.0
    gap = now - hand_at.at
    distance = kit.distance(hand_at.instrument, target)
    if distance == 0:
        return 0.0
    if gap <= 0:
        return None
    speed = distance / gap
    if speed > w.max_speed_cm_s:
        return None
    return w.travel * (speed / w.max_speed_cm_s) ** 2


def _needed_speed(kit: Kit, hand_at: _Where | None, target: str, now: float) -> float:
    """How fast a hand would have to move to make it. For the error message."""
    if hand_at is None or now <= hand_at.at:
        return float("inf")
    return kit.distance(hand_at.instrument, target) / (now - hand_at.at)


def _preference(kit: Kit, w: Weights, hands: dict[str, _Where | None]) -> float:
    """What the assignment costs beyond the travel: taste, not physics."""
    cost = 0.0
    lead, other = hands.get(w.lead_hand), hands.get(w.other_hand)
    if lead is not None and other is not None:
        lead_on_time = kit.get(lead.instrument).time_keeper
        other_on_time = kit.get(other.instrument).time_keeper
        # The other hand doing the time-keeping means the hands have swapped
        # roles: possible, and sometimes right in a fill, but not the default.
        if other_on_time and not lead_on_time:
            cost += w.lead_bias
        # Crossed arms, measured only away from the time-keepers: reaching
        # over to the hats is how the kit is played, not a mistake.
        if not lead_on_time and not other_on_time:
            right = hands["right_hand"]
            left = hands["left_hand"]
            if right is not None and left is not None:
                if kit.get(right.instrument).x < kit.get(left.instrument).x:
                    cost += w.crossover
    return cost


def _repeat(w: Weights, hand_at: _Where | None, now: float, previous_hit: float | None) -> float:
    """Same hand twice in a row, faster than one hand can comfortably go."""
    if hand_at is None or previous_hit is None or hand_at.at != previous_hit:
        return 0.0
    gap_ms = (now - hand_at.at) * 1000
    if gap_ms >= w.repeat_below_ms:
        return 0.0
    return w.repeat * (1 - gap_ms / w.repeat_below_ms)


def assign_hands(
    events: list[tuple[float, list[str]]],
    kit: Kit,
) -> tuple[list[list[str]], float]:
    """A limb for every hand hit, as the cheapest path through the whole song.

    ``events`` is one entry per moment something is struck by hand: the time in
    seconds and the instruments struck together there. The result mirrors it,
    with a hand for each instrument, and what that path cost.
    """
    w = kit.hands
    # state -> (cost, previous state, this event's assignment)
    State = tuple[_Where | None, _Where | None]  # (left_hand, right_hand)
    start: State = (None, None)
    paths: dict[State, tuple[float, State | None, tuple[str, ...] | None]] = {start: (0.0, None, None)}
    history: list[dict[State, tuple[float, State | None, tuple[str, ...] | None]]] = [paths]
    previous_time: float | None = None

    for index, (now, instruments) in enumerate(events):
        if len(instruments) > len(HANDS):
            raise Unplayable(
                f"{len(instruments)} things struck by hand at once "
                f"({', '.join(instruments)}) and only two hands"
            )
        # One instrument: either hand. Two: one each, both ways round.
        options: list[tuple[str, ...]]
        if len(instruments) == 1:
            options = [("left_hand",), ("right_hand",)]
        else:
            options = [("left_hand", "right_hand"), ("right_hand", "left_hand")]

        following: dict[State, tuple[float, State | None, tuple[str, ...] | None]] = {}
        closest = float("inf")
        for state, (cost_so_far, _, _) in paths.items():
            hands: dict[str, _Where | None] = {"left_hand": state[0], "right_hand": state[1]}
            for assignment in options:
                extra = 0.0
                moved = dict(hands)
                ok = True
                for instrument, limb in zip(instruments, assignment):
                    travel = _travel(kit, w, hands[limb], instrument, now)
                    if travel is None:
                        closest = min(closest, _needed_speed(kit, hands[limb], instrument, now))
                        ok = False
                        break
                    extra += travel + _repeat(w, hands[limb], now, previous_time)
                    moved[limb] = _Where(instrument, now)
                if not ok:
                    continue
                extra += _preference(kit, w, moved)
                nxt: State = (moved["left_hand"], moved["right_hand"])
                total = cost_so_far + extra
                best = following.get(nxt)
                if best is None or total < best[0]:
                    following[nxt] = (total, state, assignment)

        if not following:
            raise Unplayable(
                f"nothing can reach {', '.join(instruments)} in time: it would take "
                f"{closest:.0f} cm/s and the limit is {w.max_speed_cm_s:.0f}",
                event=index,
            )
        if len(following) > BEAM:
            following = dict(sorted(following.items(), key=lambda item: item[1][0])[:BEAM])
        paths = following
        history.append(paths)
        previous_time = now

    # Walk back from the cheapest ending.
    state = min(paths, key=lambda key: paths[key][0])
    cost = paths[state][0]
    assignments: list[list[str]] = []
    for step in range(len(events), 0, -1):
        _, previous, assignment = history[step][state]
        assert assignment is not None and previous is not None
        assignments.append(list(assignment))
        state = previous
    assignments.reverse()
    return assignments, cost


# --- the hi-hat foot -----------------------------------------------------------


def hat_track(
    played: list[tuple[Hit, str]], beats_per_bar: int
) -> tuple[list[HatChange], list[str]]:
    """When the hi-hat foot is up, derived from what the hands play on it.

    The foot starts down. It lifts for an ``hihat_open`` -- a sixteenth early,
    so the cymbals are already apart when the stick lands -- and drops again at
    the next closed hat or chick. Anything that says the foot is up and down at
    the same instant is a mistake in the chart, and is reported rather than
    resolved.
    """
    slots_per_bar = beats_per_bar * SLOTS_PER_BEAT
    at_slot: dict[int, set[str]] = {}
    for hit, instrument in played:
        at_slot.setdefault(hit.slot, set()).add(instrument)

    problems: list[str] = []
    changes: list[HatChange] = []
    open_now = False

    def place(slot: int, is_open: bool) -> None:
        nonlocal open_now
        if is_open == open_now:
            return
        bar, position = divmod(max(slot, 0), slots_per_bar)
        if changes and changes[-1].bar == bar + 1 and changes[-1].slot == position:
            changes.pop()  # a lift and a drop on the same slot cancel out
        else:
            changes.append(HatChange(bar=bar + 1, slot=position, open=is_open))
        open_now = is_open

    for slot in sorted(at_slot):
        here = at_slot[slot]
        if "hihat_open" in here and "hihat_pedal" in here:
            bar = slot // slots_per_bar + 1
            problems.append(
                f"bar {bar}: the hi-hat is played open and pedalled shut on the same beat"
            )
        if "hihat_open" in here:
            # Early enough to be open when the stick lands, but never before
            # the hit that came before it.
            lift = slot - 1
            previous = [s for s in at_slot if s < slot]
            if previous and max(previous) >= lift:
                lift = slot
            place(lift, True)
        elif "hihat_closed" in here or "hihat_pedal" in here:
            place(slot, False)
    return changes, problems


# --- putting it together --------------------------------------------------------


def solve(song: Song, kit: Kit, tempo_bpm: float, beats_per_bar: int) -> Sticking:
    """Sticking and hi-hat foot for a song's chart."""
    mapping = {int(key): str(value) for key, value in (song.meta().get("midi_map") or {}).items()}
    if not mapping:
        raise StageError(f"{song.toml}: no [midi_map], so the notes have no instruments")

    hits = read_hits(song.tab_midi)
    played: list[tuple[Hit, str]] = []
    unmapped: set[int] = set()
    for hit in hits:
        instrument = mapping.get(hit.note)
        if instrument is None:
            unmapped.add(hit.note)
            continue
        played.append((hit, instrument))
    if not played:
        raise StageError(f"{song.tab_midi}: nothing in the chart is in [midi_map]")

    seconds = 60.0 / (tempo_bpm * SLOTS_PER_BEAT)
    slots_per_bar = beats_per_bar * SLOTS_PER_BEAT

    # Feet are a lookup: one pedal, one foot. Only the hands are searched.
    hand_hits: list[tuple[Hit, str]] = []
    strokes: list[Stroke] = []
    for hit, instrument in played:
        foot = kit.get(instrument).foot
        if foot is None:
            hand_hits.append((hit, instrument))
            continue
        bar, position = divmod(hit.slot, slots_per_bar)
        strokes.append(
            Stroke(bar + 1, position, instrument, foot, hit.velocity)
        )

    # Everything struck at the same sixteenth is one moment, and needs one hand
    # each: that is where "two notes at once means two limbs" comes from.
    events: list[tuple[float, list[str]]] = []
    at_event: list[list[Hit]] = []
    for hit, instrument in hand_hits:
        if at_event and hit.slot == at_event[-1][0].slot:
            events[-1][1].append(instrument)
            at_event[-1].append(hit)
        else:
            events.append((hit.slot * seconds, [instrument]))
            at_event.append([hit])

    try:
        assignments, cost = assign_hands(events, kit)
    except Unplayable as exc:
        # The solver knows the moment; the chart knows which bar that is.
        where = ""
        if 0 <= exc.event < len(at_event):
            bar, position = divmod(at_event[exc.event][0].slot, slots_per_bar)
            where = f"bar {bar + 1}, sixteenth {position + 1}: "
        raise Unplayable(
            f"{where}{exc}. Either the chart asks for something nobody can play, "
            f"or [hands] max_speed_cm_s in kit.toml is set too low."
        ) from None

    for (_, instruments), limbs, group in zip(events, assignments, at_event):
        for instrument, limb, hit in zip(instruments, limbs, group):
            bar, position = divmod(hit.slot, slots_per_bar)
            strokes.append(Stroke(bar + 1, position, instrument, limb, hit.velocity))
    strokes.sort(key=lambda stroke: (stroke.bar, stroke.slot, stroke.instrument))

    changes, problems = hat_track(played, beats_per_bar)
    if unmapped:
        problems.append(
            "not in [midi_map], so left out: " + ", ".join(str(note) for note in sorted(unmapped))
        )

    return Sticking(
        strokes=strokes,
        hat=changes,
        chart=chart_hash(song.tab_midi),
        kit=kit.digest,
        tempo_bpm=tempo_bpm,
        beats_per_bar=beats_per_bar,
        cost=round(cost, 3),
        notes=problems,
    )


# --- the lock file ----------------------------------------------------------------


def path_for(song: Song):
    return song.root / "sticking.lock.json"


def save(song: Song, sticking: Sticking) -> None:
    head = {
        "version": VERSION,
        "chart": sticking.chart,
        "kit": sticking.kit,
        "tempo_bpm": sticking.tempo_bpm,
        "beats_per_bar": sticking.beats_per_bar,
        "cost": sticking.cost,
        "notes": sticking.notes,
    }
    # One stroke per line, which is a third of the bytes of pretty-printed JSON
    # and the format you want when you are changing an R to an L by hand. `bar`
    # is 1-based as written on the page; `slot` is sixteenths into that bar.
    strokes = [
        json.dumps(
            {
                "bar": stroke.bar,
                "slot": stroke.slot,
                "instrument": stroke.instrument,
                "limb": stroke.limb,
                "velocity": stroke.velocity,
            }
        )
        for stroke in sticking.strokes
    ]
    hat = [json.dumps({"bar": c.bar, "slot": c.slot, "open": c.open}) for c in sticking.hat]
    lines = [json.dumps(head, indent=1)[:-2] + ","]  # everything but the closing brace
    lines.append(' "strokes": [')
    lines.append(",\n".join(f"  {line}" for line in strokes))
    lines.append(" ],")
    lines.append(' "hat": [')
    lines.append(",\n".join(f"  {line}" for line in hat))
    lines.append(" ]")
    lines.append("}")
    path_for(song).write_text("\n".join(lines) + "\n", encoding="utf-8")


def load(song: Song) -> Sticking | None:
    path = path_for(song)
    if not path.exists():
        return None
    body = json.loads(path.read_text(encoding="utf-8"))
    return Sticking(
        strokes=[
            Stroke(
                bar=int(s["bar"]),
                slot=int(s["slot"]),
                instrument=str(s["instrument"]),
                limb=str(s["limb"]),
                velocity=int(s.get("velocity", 100)),
            )
            for s in body.get("strokes", [])
        ],
        hat=[HatChange(int(c["bar"]), int(c["slot"]), bool(c["open"])) for c in body.get("hat", [])],
        chart=str(body.get("chart", "")),
        kit=str(body.get("kit", "")),
        tempo_bpm=float(body.get("tempo_bpm", 0)),
        beats_per_bar=int(body.get("beats_per_bar", 4)),
        cost=float(body.get("cost", 0)),
        notes=list(body.get("notes", [])),
    )
