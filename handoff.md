# Handoff: polish the foundation and the interface first

Written 2026-09-16, redirected 2026-11-21. Read §0, then `README.md` "Where
things stand". The plan files (`practice-plan.md`, `avatar-plan.md`) are the
*reasoning*, not the status -- and §3 below records where the built thing now
deliberately departs from them.

---

## 0. Since 2026-11-21: no new features until the foundation is polished

The project had stalled on its own surface. What gets used is the play-along
player: notation on the drummer's own clock, the stems, a click, the tempo, the
sticking. What the user does in a session is play along with a whole song,
often slower; loop the hard parts slower; and raise the tempo about 10% at a
time. Most sessions are free playing, nothing recorded. The disk agreed: 14
takes, all from 13-16 September, no routine ever opened, one exercise.

So the work is in three parts:

- **A. Remove routines and exercises -- done (2026-11-21).** Code, data, routes
  and checks. Scoring stays: `Record` plays the whole song at the tempo set and
  the reading is unchanged. See README "Where things stand".
- **B. The play-along features, under the old look -- done (2026-11-21).**
  All six parts, in a Loop group under Transport in the left rail:
  - B1 loop a section or a range of bars (`app/src/loop.ts`), on/off with
    `L`, a pass counter, a bar of count-in before the first pass, a bar of
    click between passes or straight back (rest bar on by default), the bars
    tinted in the notation;
  - B2 tempo steps of 5 and 10 (`[` `]`, Shift, buttons) and `\` back to
    100%, and the ramp ("from 70% to 100%, +5% every 2 passes");
  - B3 a count-in when Play starts from a pause, from the start of the bar
    the cursor is in (a setting, on by default);
  - B4 the status line in plain words, the diagnostics in the console, and
    readiness as `<html data-ready="<slug>">`;
  - B5 each song remembering its tempo and loop (`localStorage` `song:<slug>`);
  - B6 `Record` with the loop on marking every pass and writing each as a
    take, a chip per pass, and the ramp optionally waiting for a pass of 90%+.

  See README "Where things stand" for what was decided and learned. What the
  redesign will have to redo rather than restyle: the loop is picked from a
  select and two number fields, not on a song map; the loop is drawn as a tint
  over the staff only; the count-in is heard but not shown as a big 1 2 3 4.
- **C. The new interface: Lamp (picked 2026-11-21) -- done (2026-11-22).** The brief
  is `design/claude-design-prompt.md`, the page before it `design/now/`, the
  picked design `design/lamp/` (start at its README and `Lamp-Spec.dc.html`).
  Built in stages so the app works after each one; each stage ends with
  typecheck, `npm test`, every browser check, and screenshots at 2194x1100:
  - **C1 tokens and type -- done (2026-11-21).** The spec's custom properties
    replace today's (`--*`, `--tab-*`, `--verdict-*`), verbatim; Atkinson
    Hyperlegible Next self-hosted in `app/public/fonts/` (variable woff2,
    latin + latin-ext, OFL.txt), not loaded from Google at runtime; alphaTab's
    `palette()` and the heatmap read the paper's tokens (`src/tokens.ts`).
    The paper no longer follows the interface theme: cream by default.
  - **C2 the player shell -- done (2026-11-21).** The left rail and right desk
    go. Header (24-355): video 588x331, title, section name / bar of N, pass
    block, tempo readout, the 76 px controls row (Play, Loop, Ramp, Mix,
    Video, the -10 -5 100% +5 +10 pills). The song map's slot (stage C3 fills
    it). The paper 2114 wide at alphaTab scale 2.25, 4 bars a line, 2 lines
    with the video and 3 without (V); the width never changes mid-song. The
    Lines select and Fill go. New keys: `{ }` `R` `M` `V`; Home goes back to
    where play stopped, again to the top. Screenshots against the frames in
    `design/built/` (`app/scripts/shots-lamp.mjs` retakes them).
    **Temporary until later stages:**
    - a plain **drawer** (`M`, the Mix pill, the Settings icon; `#drawer` in
      `index.html`) holding the mix faders, count-in, the loop's rest bar,
      the ramp's numbers, the four layout knobs, sticking, both
      themes, MIDI / Calibrate / Record / passes / the reading, and the keys
      list -- C4 (Mix panel, Settings) and C7 (reading card, kit chip)
      replace it;
    - the **title is the song picker** (a select), and the Songs icon opens
      it, until C6's library; the title is song.toml's full YouTube title,
      since there is no `artist` / short `title` yet (C6);
    - **zen** is the old one re-laid (picture centred over the paper), C5;
    - in the **compact header** the pass block, which the frames do not show,
      is one 28 px line over the controls, and with the Ramp pill in it the
      switches go to their icons alone (no frame draws compact + loop).
  - **C3 the song map and the paper's layers -- done (2026-11-21).** The map
    (`src/songmap.ts`, LampMap's layout) in the slot at 372: blocks as long as
    they last in three shades, short names on a tier above, the playhead, the
    loop outlined; a click jumps to a section. The Loop pill (and `L` with no
    loop, which loops the section you are in) opens it as the 164 px picker
    laid over the paper: click, shift-click, a click inside the loop to clear
    it, a drag across the bar marks, handles (mouse or arrow keys), a line
    saying "Loop: chorus · bars 9–16 · 8 bars", Loop off, Done, `Esc`. A pick
    while playing waits for the next bar line (or, holding the bar being
    played, loops around it). The drawer's select and bar fields are gone.
    The paper's layers (`src/layers.ts`): names in a label lane above the line
    they start in (a blank alphaTab rehearsal mark holds the lane open, so
    only those lines grow), the loop as a brass bracket with end ticks, the
    current bar as a wash in place of alphaTab's. The status line moved to the
    header's top row. The known gap is closed for Kill Me and Song 2: compact
    header at Lamp-03's numbers (map 130, paper 220, 870 tall) and the line
    gap default 12 (27 px, the sticking lane exactly), so three section lines
    are 866 / 853 px. One For The Road's tallest three are 884, and there the
    window shows two whole lines rather than cut one (it never shows part of
    a line now).
    **Still temporary after C3:** the drawer, the title as song picker, the
    old zen and the compact pass line (as above); the status line squeezed
    beside the title (an ellipsis and a tooltip) until C6's short titles give
    it room; the browsing dashed box on the map (C5); the picker's Loop off
    and Done pills, which no frame draws.
  - **C4 mix panel and settings -- done (2026-11-21).** The drawer is gone.
    - The **Mix panel** (Lamp-08, `#mix-panel`): `M`, the Mix pill, Done and
      `Esc`; 960 wide at the right margin, top 20 (left 1194 at 2194), over
      the header and the top of the paper, which does not move. Rows Band,
      Drums, Click, Kit: name and a line, a 76 px mute pill with its key
      (`1`-`4`, On / Muted), the level, its percent. **A mute is not a level
      of 0 any more**: the level stays, dimmed, and the key puts it back; a
      drag on a muted row unmutes it. Click and Kit start muted (60%, 80%).
      Remembered as `mixer` in localStorage (`{level, muted}`; the old `mix`
      key is no longer read). The Kit row says "—" and "Kit is silent ... Run
      drums kit-bake in a terminal" with no bank. With neither stem (Lamp-08b)
      the Band and Drums rows fold into one **Record** row, band and drums
      together, which is the nodrums channel: the mixer puts the whole
      record's own gain on it (`mixer.noStems`). No song here lacks stems;
      `check-nokit` and `shots-lamp` refuse them with a route to see it.
      In the compact header the panel is at the same place, clear of the Mix
      pill (checked), and opening it closes the loop picker and vice versa.
    - The **Settings page** (Lamp-10, `#settings`): the gear, Done, `Esc`.
      Covers the whole window and only covers it: a song playing goes on, and
      no player key works under it but Space. Notation (size in px between
      staff lines, bars a line with − +, the gap in on-screen
      px, sticking), Look (interface and paper as segmented pairs, the three
      pairings clickable), Loop (between passes Straight back / A bar of
      click; count-in before the first pass of a loop -- new, on by default --
      and from a pause; the ramp's four numbers; the 90% gate), Kit (a dot
      and a sentence for the connection, Connect while MIDI has not been
      asked for, the input, the calibration in a sentence with its date and
      ms, Calibrate / Calibrate again) and Keys (`Z · Esc`: Esc also closes
      what is open). The Ramp on/off switch is the Ramp pill and `R` only.
    - Corner icons: Songs (still opens the title's picker until C6) and
      Settings, in Lamp-01's corner with the video and at the right of the
      compact band's top row without it (no frame draws them there).
    **Temporary after C4:**
    - **Record, the passes chips, the hits monitor and the reading** live at
      the foot of Settings' Notation column ("Record"), the plainest place
      with room: C7 puts Record in the controls row only while the kit is
      connected and the reading in a card in the header. Until then you press
      Record on Settings, Done, and play; the reading is there after.
    - No notation preview on Settings (the frame's optional live preview).
    - Still from C2/C3: the compact pass line, the squeezed status line, the
      picker's Loop off and Done pills. (The title picker, the old zen and the
      browsing box went in C5/C6.)
  - **C5 states -- done (2026-11-21).**
    - **Count-in** (Lamp-05): every count-in (a loop's first pass, the rest
      bar between passes, Play from a pause, Record) replaces where you are
      with "count-in · then chorus, bar 9, pass 1" and 1 2 3 4 at 160 px
      (counted faint, sounding brass, to come dim), over the pass block's room
      too; the picture at 0.45. Lit from the clicks' own times on the audio
      clock (`click.ts` `watchCountIns`, main.ts `showCount`), read against
      `getOutputTimestamp()`. Compact: the words on the pass's line, the
      numbers (76 px) where the section is. The "Counting in" status lines of
      the loop and of a pause are gone (Record's stays until C7).
    - **Ramp ladder** (Lamp-04): with the ramp on, the rungs from..to in place
      of the tempo pills -- done, now, next (dashed), later -- seven at most,
      around where it is (`loop.ts` `rampLadder`). "next step after this
      pass / after 2 passes / ramp done: full speed" under the pass. In the
      full header the Video pill steps aside, as in the frame (V works).
    - **Browsing while paused** (Lamp-06): the wheel turns the paper away from
      the cursor's line; the pass block becomes the eye and "bars 25–32",
      "looking ahead (back); play goes on from bar 11"; a "Back to bar 11
      [Home]" pill after Play; the paper's dashed edge; the map's dashed box
      (`SongMap.view`); " · paused" after the title; the picture at 0.6. Home
      or the pill go back; Home otherwise as before. Mix and Video step aside
      in the full header, as in the frame.
    - **Zen** (Lamp-11): ground `--zen-bg` (#0f0d0a), the picture 718x404
      centred at 24 when it is shown (V hidden counts as none), the paper at
      452 as wide as ever; without a picture the paper from 24, four lines if
      they fit.
  - **C6 library -- done (2026-11-21).** `song.toml` `[song]` with `artist`
    and a short `title`, required (`plugins/ableton.ts` refuses a song.toml
    without them; `drums fetch` writes them for a new song from the channel
    and the video title, and keeps them on a re-fetch). `virtual:songs` also
    carries `bars` (as the player engraves them, counted off tab.mid), `bpm`
    and `seconds`. The header says "Song 2 — Blur"; the select is gone. The
    **Songs page** (`src/library.ts`, Lamp-09) is the home route (`#`,
    `#/songs`, or a slug that is no song), from the Songs icon: 200 px rows,
    a frame grabbed from the video 30% in (or the "no video" staff), "Artist
    — **Title**", "2:03 · 130 BPM · 65 bars · video", where you left off
    ("chorus looped at 80%", "whole song at 85%", "not played yet"), Resume /
    Play, the song played last outlined in brass (each song now remembers
    `played`, when it last started). ↑ ↓ Home End choose, Enter opens on
    `#<slug>`, Esc back to the song. Opening it stops what plays. Checks
    default to `#<FIRST_SONG>` (`browser.mjs`) since no hash is the library.
    **Still temporary after C6:** Record, the passes, the hits monitor and the
    reading at the foot of Settings (C7); the squeezed status line beside the
    title (shorter now, with the short titles); the picker's Loop off and
    Done pills, which no frame draws; no notation preview on Settings.
  - **C7 the kit layer -- done (2026-11-22). Part C is complete.**
    - The **kit chip** in the corner beside Songs and Settings: a green dot,
      "Kit connected · calibrated" / "· not calibrated"; nothing without a
      kit. "Connected" is `MidiIn.hasSource` (a port, or injected strokes).
      The page connects by itself when MIDI permission is already granted
      (`navigator.permissions`); Connect and Calibrate stay in Settings › Kit.
    - **Record** (76 px pill, after Loop/Ramp) only while the kit is
      connected: the whole song, or every pass of the loop, with its
      count-in; again, it stops; on, it is filled accent with a beating dot
      and says "Recording". Pressed with a loop already going round it starts
      the loop again, marked, from its count-in. Record's "Counting in /
      Recording" status lines are gone (the header shows both). With Record
      in the row the full header's Video pill steps aside while the loop is
      on or a take records, and Mix too beside the ladder (V and M work); the
      compact band shows every switch as its icon while a kit is connected,
      and says "recording the whole song" on the pass's line.
    - The **reading card** (Lamp-12, `#reading`, built in `practice.ts`)
      after a pass or a song: in the full header the third column, the pass
      block's place, 290 tall; the tempo at 160 with the BPM alone; the row
      Play, (Back), Loop, Record, Mix as round icons; "bar 9 pass 3".
      "Pass 2, just played" / "Whole song, just played" / "..., stopped part
      way" / "Pass 3, the last one played through"; Notes (rounded down),
      Steady word and ±ms, Feel word and needle; one block a bar (played /
      missed from the verdict tokens, lightened on the dark interface; a whole
      song's strip closes up without numbers past 16 bars); a click jumps to
      the bar; one sentence. **Chosen lifetime:** each pass's reading
      replaces the last while the loop goes round (it says "recording" and
      has no close then); when Record stops it stays, showing the last pass
      that reached its end, until Esc, its close (x), the next Record or
      another song -- which put the noteheads' colours away too.
    - The temporary Record section in Settings › Notation is gone, and with it
      the passes chips (the card shows the pass just played; the takes on disk
      are the history); the hits monitor is in Settings › Kit; the per-limb
      numbers are the card's tooltip and the console.
    - `drums fetch` on an existing song keeps everything it does not own
      (`paths.update_toml`, `tests/test_fetch_toml.py`).
    - The count-in's picture really is at 0.45 (`check-ui` asserts the
      computed opacity); Song 2's count-in frame is simply a dark shot.

  **Left, or deliberately different from the frames, after part C:**
    - No frame draws the **compact header with a card**: there the card is one
      80 px row in the song map's slot, and the map comes back when it goes
      (or while the loop picker has the slot).
    - **Record is not in any frame** (decided after them); Lamp-12's row is
      Play, Loop, Mix. With the card up the row is round icons; Ramp and Video
      step aside (R and V work).
    - The card is the frame's 690 wide only roughly: it is the column the
      160 px tempo leaves (about 620 at 100%), and 290 tall rather than 300
      so it clears the map's tier of names.
    - The strip's played blue is `--verdict-played` mixed 32% toward white on
      the dark interface: the paper's #1f5fa8 is too dark on #1f1a15 (the
      frame used #5b8fd0 for the same reason).
    - The Feel and Steady words are shorter than before ("on it", "behind",
      "solid", "loose") to fit 60 px in a third of the card; a long one
      ("dragging", "all over") steps down to 44.
    - No passes history on screen (the chips went); no notation preview on
      Settings; the picker's Loop off and Done pills, which no frame draws;
      the status line squeezed beside the title (now also beside the chip).
    - Windhorse is not in the library, by choice.

**The screen is two metres away.** A 31.5" 4K monitor at 175% scaling, about
2 m from the throne: a maximised page is about 2194x1100 CSS px. Check layouts
at that size, not at 1600x900. The brief's minimums: 20 px between staff lines
(9 today), 64 px type for anything caught at a glance, 32-40 px for anything
read, 64 px targets for anything clicked mid-song.

---

## 1. Where things stand

M0 and M1 of `practice-plan.md` are complete; M2 was built and then removed.
M3 was started from the far end: the *reading* was rebuilt, which is what the
user actually wanted from it. The take-vs-take overlay Q14 specifies is still
unbuilt.

**M0** pivoted the clock onto `<audio>` on `mix.wav`, prepped the original track
as its own song, and added `drums sections` and `drums sticking`.

**M1** is the thin slice: Web MIDI in, the calibration ritual, a take on disk,
the scorer, and the grade drawn on the staff.

**M2** was the routine grid. It was removed on 2026-11-21 with the exercises,
never having been opened for real; see §0 and §2.

**The reading** (2026-09-16) is three dials, a bar strip and three notehead
colours, replacing a table nobody could read. See §3. Since C7 it is Lamp-12's
card in the header, and the kit layer (chip, Record pill, card) is only on the
page while a kit is connected.

```
app/src/grade.ts       the scorer. Pure, and tested.
app/src/reference.ts   the floor: how far behind the chart the record plays
app/src/loop.ts        the loop: bars round and round on the mix clock, its count-ins and ramp
app/src/practice.ts    the kit layer: MIDI, calibrate, the chip, Record (the song or every pass of the loop), the reading card
app/plugins/practice.ts  /practice/take, /practice/calibration, virtual:kit
app/src/midi-in.ts     the module -> hits, stamped in mix time
app/src/chart.ts       tab.mid -> notes, placed in the mix, given limbs
app/src/calibrate.ts   tap-to-click, median of N, two clocks bridged
app/src/take.ts        the take format (Q8). The important one.
app/src/heatmap.ts     noteheads coloured by verdict + the extras lane
app/src/clock.ts       the narrow view of the mix clock the rest of the page gets
app/src/kit.ts         the written notes, sounded: when each one fires
app/src/bank.ts        ...and which recording it fires, and how loud
kit/samples/           the bank: 255 recordings; `drums kit-bake` writes it
kit.toml [render]      what to render it from (NOT the module's numbering)
kit.toml [sampler]     chokes and trims: how the bank is played
kit.toml [input]       what your module sends (NOT the chart's numbering)
pipeline/reference.py  measures the floor, writes reference.lock.json
songs/<slug>/takes/    every take, never rewritten
```

### Checks

From `app/`, with `npm run dev` running in its own terminal:

```
npm run smoke · check-sync · check-mix · check-ui out.png · check-practice · check-loop [out.png] · node scripts/check-nokit.mjs
npm test                                   # scorer + chart + bar_offset + loop + song map + library, 53, no browser
.venv/Scripts/python -m pytest -q tests    # 243 (16 skipped: the slow cover e2e), no browser
cd app && npm run typecheck
```

**Known-good as of 2026-11-22 (after C7, part C done):** 243 pytest (16
skipped), 53 node tests, clean typecheck, and every browser check on One For
The Road (smoke, sync 72 bars, ui, mix, nokit 11 ok -- including a song with
its stems refused) and Kill Me (practice 53 ok, loop 87 ok), all at 2194x1100.
The kit checks inject strokes, which is what makes the kit "connected".
`node scripts/shots-lamp.mjs` retakes the frames in `design/built/`. Do not
edit `index.html` while a check runs: vite reloads the page under it. `check-practice` records the
whole song, so it takes about as long as the record does; `check-loop` takes
about a minute and a half. Every check waits for `<html data-ready>`, not for
words on the status line. `check-mix` needs a baked bank, so run
`drums kit-pick` and `drums kit-bake` once if `kit/samples/` is not there;
`check-nokit` is the opposite, and hides the bank to read the message a fresh
checkout gets.

Gotchas, all previously bitten: the checks need **real Chrome or Edge** (bundled
Chromium has no H.264); the Ableton plugin reloads the page on every `.als` save,
so a page loaded mid-reload can look broken; and **never write alphaTex or other
backslash-heavy content through a shell heredoc** — use an editor tool.

### The songs

| slug | bars | BPM | cells | floor |
|---|---|---|---|---|
| `hayley-williams-kill-me-official-visualizer` | 62 | 90.9 | 44 | +12.7 ms |
| `blur-song-2-official-music-video` | 64 | 130.4 | 32 | +6.2 ms |
| `arctic-monkeys-one-for-the-road-official-video` | 72 | 90.9 | 60 | +10.5 ms |

**Song 2's Live set lives in the Kill Me project folder.** It was saved there,
and moving a `.als` out of its Ableton project by hand breaks its sample links,
so `[author]` points at where it actually is. Each song watches its own set by
filename, so two in one folder do not collide. Moving it properly means *Save As*
from inside Live, then updating the path.

**One For The Road's set starts three bars before the notation does.** It was
written against the record from the top of the track, so its bars 1-3 are the
intro and its bar 4 is the song's bar 1. `bar_offset = 3` in `[author]` takes
them off on the way to `tab.mid`; the value was measured by sliding the chart
against the drum stem (a clean peak at -3.00 bars — on the repaired grid, 100%
of the 422 kick and snare hits matched against 91.5% one bar either way), not
eyeballed. Two consequences: the straightened stems go at **bar 4** of that set
rather than at 1|1|1, and the renders are at **91 BPM**, so the Live project
needs to be at 91 — it was written at 90. Changing a project's tempo does not
move a note; the clips are on the bar grid.

**The beat map had four half-beat seams, and they are why the grid repair
changed** (2026-09-18). `repair_local_octave` halves a stretch the detector ran
at double time, and a run spanning an odd number of half-beats used to leave one
1.5x interval behind, documented as harmless. It is not: every beat after such a
seam is half a beat late and the error rides to the end of the song. Four of them
had this grid's last beat 1.3 s late and the chart 84% off the record through the
back half. `realign_seams` (in `pipeline/grid.py`, 6 tests) closes them by
pulling the remainder back; no beat is invented or lost, so bar numbering is
untouched. The fit is now 100% in every 20-second window. **No other song has an
octave run at all**, so the change is a no-op for them — do not regrid them
expecting a difference.

**Song 2's chart is 65 bars and its beat map is 64.** The last crash sits on the
downbeat of 65 and the detector found no beats past it, so a cell ending at 65
could not be placed and the sections stop at 64. Playing that crash on a
whole-song take logs two extras, which never touch accuracy.

### Settled, so do not re-ask

- **Multi-client MIDI works.** TD-27 with Local Control off, driving Superior
  Drummer 3 in Ableton, and Chrome receives the same strokes — no loopMIDI hop,
  no virtual-port splitter. Q2's fallbacks are documented and not needed here.
- **The `[input]` note numbers are right**, checked pad by pad.
- **The WSOLA tempo question is closed.** 70% and 80% sound fine, so the tempo
  ladder is free and no `drums ladder` pipeline step is needed.
- **Calibration is about +29 ms with a ±17 ms spread**, measured warm. One number
  for the whole module, by the user's choice.
- **Sections are named by hand from the notation** on both songs, with every
  fill and pickup cut out as a block of its own so it can be drilled. Re-running
  `drums sections --redetect` would throw the names away.
- **A cross-stick is its own instrument, not a snare** (2026-09-18). One For The
  Road writes one for four bars, so `sidestick` is in `ARTICULATION`
  (`snare (side stick)`, a cross notehead), in `kit.toml` as geometry, and in
  `[input.note]` where the module's note 37 now reads as `sidestick` rather than
  `snare`. Both ends had to move together: a chart asking for a drum the scorer
  cannot receive marks every correct stroke wrong. The pair is **not** in
  `same_drum` — that is for a threshold the module sets, like an open or closed
  hat, and nothing flickers here. The cost is that a cross-stick played on the
  other two songs, whose charts never ask for one, is now a wrong drum instead
  of a snare; that is the intended trade.

### What the user still owes the work

1. **Name One For The Road's sections.** It still has the lettered seed
   `drums sections` proposed -- fifteen blocks, A-N. They are about to be the
   song map and the loop picker, so names will matter there.
2. **Check the module's hi-hat offset** (parked). Closed only registers under
   heavy pressure, which is either a miscalibrated offset or honest reporting of
   a loose-hat style. The Monitor tells them apart: press to what *you* call
   closed and see whether note 42 or 46 comes out. Nothing depends on the
   outcome — `[input]` maps both and takes re-grade from raw stamps.
3. **Read the R/L letters** and tune `kit.toml` if they are not what they would
   play, then `drums sticking <slug> --restick`.

---

## 2. What M2 built, and where it went

M2 was the routine grid: a fixed set of (section x tempo) cells one run walked,
open across sittings and sealed by hand. It was built on 2026-09-13, cut down
to the whole song at four tempos on 2026-09-19, and **removed on 2026-11-21**
without ever having been opened for real. The rules it held are in
`git show 5c21a14:app/src/routine.ts`, and README "Where things stand" has the
history.

### The two oldest takes are the proof of the format

`songs/hayley-williams-kill-me-official-visualizer/takes/` holds the first two
takes played on the real kit. **Do not delete them** and do not rewrite their
`grade`: they are the evidence that Q8's "store raw timestamps, record the
corrections beside them" decision works. They carry a pre-redetect
`sectionsHash`, no `cell.id` and no `referenceMs` — all exactly right, because a
take is never rewritten and every one of those fields is optional for that
reason.

---

## 3. Where the build now departs from the plan, and why

**Q11 said score-as-heatmap plus a per-limb timing strip. Q14 said two lines per
cell.** Both were right about what is measurable and wrong about what is legible.
Played against the real kit, the report was five notehead colours plus a legend,
a totals line and a six-by-four table — twenty-four numbers, none of which said
whether the take was good or what to go and play again. The user's verdict was
that they could not read it, and that is the only verdict that matters here.

What it is now:

- **Three dials** — `Notes` (accuracy), `Steady` (spread), `Feel` (where you sit,
  as a needle). Each answers one question; they are never blended into a score.
  Mean and spread stay apart for Q7's original reason.
- **A bar strip** — one block per bar of the cell, coloured by whether the notes
  landed, click one to put the cursor there.
- **Three notehead colours, not five.** Colour answers *did the note happen*;
  *when* it happened is a quantity and is shown as one. Hue has no direction, so
  the early/late split was a decode step on every take.
- **The old table survives** behind a `the numbers` toggle.

**The reference floor is applied, not just reported.** This reverses a decision
M1 left deliberately open. `drums reference` writes `reference.lock.json`, pinned
to the chart hash, and `grade.ts` subtracts it alongside the calibration before
matching — so zero on the Feel dial means "where the record sits". It is one
number for the whole kit, which is a real simplification: only kick and snare are
measurable, and Song 2's kick is +10.7 while its snare is −1.3. The per-instrument
split is in the lock for a later version to use without re-measuring.

---

## 4. What is left

**Before any of this: §0.** Part C comes first (B is done). Everything below waits.

**The rest of M3.** The take-vs-take overlay (Q14). The per-cell trend lines it
also asked for were built on the routine grid and went with it.

**M4, the coach.** Two halves that do not belong together:
- **Step-by-step** (Q12) — transport paused, the cursor waits for you to play the
  next note. No scoring, no take, no calibration. Nearer to a play-along feature
  than a coaching one, and buildable on its own.
- **Exercises** (Q13) — built on 2026-09-19 and **removed on 2026-11-21**:
  the user did not like their shape (a pool, a page of their own, a ladder).
  What survives of the idea is the loop, which came back as part B in §0
  (`app/src/loop.ts`).
  If an agent is ever to write exercises, it starts again from what the user
  wants then; the old format is `git show 5c21a14:app/src/exercise.ts`.

**M5, the artifact.** Take → `.mid` warped onto the straight grid for Ableton
(small, all the machinery exists); phone-video alignment by onset-envelope
correlation against the take's MIDI (new — the existing `drums align` correlates
waveforms, which will not work on stick-on-mesh against an SD3 render); the
export itself.

**M6, the avatar.** Three.js sticks over a top-down kit, driven by the sticking
lock. Explicitly last.

**Small and unscheduled, but wanted** has become part B in §0: the user values
playing along with the notation at different tempos above everything else.

**Tabs from drum-score videos** (started 2026-11-22; a project skill since the
same day, `.claude/skills/score-video-tab/`). Claude reads the notation strip
of a YouTube drum-score video into a grid per bar, `songs/<slug>/reading.txt`,
which `tab.mid` is generated from; the record's audio only checks the reading.
Come As You Are went first: all 105 bars read, from 18 distinct bar patterns,
and the song is in the library with every written kick and snare on a hit in
the record (README "Where things stand"), plus the kick on the "&" of 1 that
the record has in the chorus and the score does not. The skill holds the
scripts, the reading format and one file per channel with its drum key; the
next video from 알려드럼 is its first real test. Two things the score shows
that the reading does not use yet:
- **Dynamics.** Crescendo hairpins (Come As You Are bars 23-24 and 39-40) and
  accents (the chorus's snare sixteenths; the reading already marks them) could
  become note velocities in `tab.mid`, which the kit plays through its velocity
  layers.
- **The printed sticking.** Some channels print R/L/K under the fills. That is
  the transcriber's own sticking: it could check what `drums sticking` works
  out in `sticking.lock.json`, or decide those notes outright.
- **Sticking only where it is not obvious.** The letters under every note are
  off by default since 2026-11-22 (the Settings switch still turns them all
  on): the user wants them the way a printed score has them, only on the spots
  a drummer would not guess -- the fills, a hand crossing over. Learning which
  spots those are is the work; the scores that print R/L/K are examples of
  where a transcriber thought it was needed.
- **Cymbal chokes.** The user wants these later (2026-11-22). Sonne's score
  ends on a crash with a fist over it (심벌뮤트, cymbal mute): grab the cymbal
  right after the hit. The chart has no way to say it, so `reading.txt` has a
  plain crash and a comment. It needs a mark in the reading, a way to carry it
  in `tab.mid` (General MIDI has no choke key; a module sends it as aftertouch
  on the cymbal), and a symbol on the staff.

**The avatar's input already exists.** `Kit.onNote` (`app/src/kit.ts`) fires per
note as it is booked, carrying instrument, limb, velocity and the AudioContext
time it will sound at — which is exactly what avatar-plan B1 asks for, and it is
handed the whole part up front rather than as a stream. Whoever builds M6
subscribes to `mixer.onNote` and needs nothing else from the transport.

---

## 5. Ground rules carried into this work

- **Concepts get explained plainly.** The reader is a drummer, not a DSP
  engineer; define jargon at first use.
- **The user knows the songs.** Measurements from a recording are not ground
  truth about what was played.
- **Write commit messages out; the user stages and commits.**
- `README.md` "Where things stand" is the authoritative status log, written as a
  running narrative with a "things learned" list per step. Keep it updated as
  part of the work, not afterwards.
