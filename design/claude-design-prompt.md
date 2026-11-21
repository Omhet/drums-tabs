# Redesign brief: a drum play-along player

You are redesigning the interface of a personal drum-practice web app. It works,
and the drummer who built it uses it, but it grew a lot of machinery they never
use, and its screen is hard to read from where they sit. The job is a calm,
readable player built around how they actually practise. The visual identity is
open: they dislike every existing practice app they have tried (Moises, Melodics,
Drumeo, Songsterr) and want something of their own, so do not imitate those.

Three screenshots of today's app are attached; §11 says what each one shows.

---

## 1. Who, and where they sit

- **One person using their own tool.** Not a product: no onboarding, no accounts,
  no marketing, no hand-holding empty states. It runs in Chrome on Windows.
- They play an **electronic kit** (Roland TD-27) on headphones.
- The screen is a **31.5" 4K monitor at Windows 175% scaling, about 2 metres in
  front of the drum throne.** A maximised Chrome window gives the page about
  **2194 × 1100 CSS px**. Design every frame at that size.
- From the throne they can reach the mouse and a few keys. Their hands are busy
  with sticks, so an action mid-song is a quick reach, not time at a desk.

**This is a 2-metre interface**, closer to a TV ("10-foot") UI than to a
desktop web app. On this setup one CSS pixel is 0.32 mm, about half an
arc-minute of the eye at 2 m. Today's interface uses 12–13 px text, which is at
the limit of what perfect eyesight can make out from the throne, and draws the
staff with 9 px between its lines, about half the size of a printed part on a
music stand. Use these minimums:

| Used from the throne for | Examples | Minimum |
|---|---|---|
| Reading continuously while playing | the notation | 20 px between staff lines (today: 9) |
| Catching in a glance | tempo, current section, bar number, count-in, loop on/off, pass number | 64 px type |
| Reading | section names, button labels, short messages | 32 px type, 40 preferred |
| Clicking mid-session | play, loop, tempo steps, picking a section, muting a channel | 64 px targets |
| Doing once, or between songs | settings, fine mix levels, calibration | ordinary desktop sizes |

These numbers are the main force behind the redesign. At these sizes only a
handful of controls fit on screen, so everything not needed mid-song has to live
somewhere you open between songs.

## 2. What a session looks like

In the drummer's words: play along with a whole song, often slower than the
record; loop the difficult parts and play them slower; then raise the tempo about
10% at a time until it is back to full speed. Most sessions are free playing, with
no recording and no scoring.

So the screen exists for three things, in this order:

1. **Read the notation** while the song plays. The notation is the hero.
2. **Loop a section and change the tempo** in steps, quickly, from the throne.
3. **Set the mix**: for example, mute the record's drummer and bring up a click.

## 3. What the app does today (all of this stays)

- **Notation** of the drum part on a five-line percussion staff, engraved by
  alphaTab as SVG. Four bars a line by default. Under each note, optionally,
  **sticking**: an R or an L for which hand plays it.
- **It follows the real drummer.** The song is the original record, and for some
  songs its music video. The notation's cursor follows the beats the record's
  drummer actually played, which drift like any band's, not a fixed metronome.
- **Line-by-line scrolling.** The line being played is the top line. When the
  cursor enters the next line, the window moves down one line. Clicking a note
  jumps there. While paused, the mouse wheel browses the notation.
- **Sections.** Every song is cut into named sections: verse, chorus,
  "into chorus", "break" and so on. Fills are short sections of their own, often
  a single bar, so they can be practised alone. Names repeat: a song has three
  verses. Today sections appear only as labels inside the notation.
- **Video**, for songs that have one: the music video, in sync with the audio.
  Today it sits above the notation and takes most of the stage.
- **Tempo** from 25% to 125% of the record, slowing the audio and the video with
  the pitch kept. Show the percentage first; BPM is a useful second (Song 2's
  record is about 130 BPM, so 80% is about 104).
- **Mix**, four channels:
  - **Band**: the record without its drums
  - **Drums**: the record's own drummer
  - **Click**: a click that follows the drummer's beats
  - **Kit**: the notation played back on drum samples, so you can hear what is written

  The usual moves are muting the record's drummer to play their part yourself,
  and adding a click when slowed down.
- **Keyboard:** Space play/pause · ← → a bar · ↑ ↓ a line · Home back to the
  top · [ ] tempo −5/+5% · Shift+[ ] tempo −10/+10% · \ back to 100% ·
  L loop on/off · + − notation size · 0 reset the layout · 1 2 3 4 mute a
  channel · Z zen (fullscreen: picture and notation only) · Esc leaves zen.
- **Notation layout**, set once per monitor: size, bars per line (1–8), note
  spacing, gap between lines.
- **Two themes**, set separately: one for the interface, one for the notation's
  paper and ink. A dark room often wants a dark interface and a light page.

## 4. What goes (do not bring it back)

- **Routines** (a grid of tempos you "open", fill and "seal") and **exercises**
  (bars cut into a separate pool and drilled on their own page against a tempo
  ladder). The drummer likes neither, and both are being removed from the code.
- **The always-on practice rail**: MIDI, calibration, record and the routine
  grid, shown even when no kit is connected and mostly disabled.
- **The developer status line** ("130 BPM, 886 notes, 258 sync points. notation
  has 65 bars, beat map has 64…"). Show only messages a drummer needs, in plain
  words.
- **Settings sitting on screen for good.** Half of today's left rail is layout
  sliders and theme toggles.
- **Jargon**: take, cell, run, drill, rep, ladder, sync points, beat map. The
  words on screen are **song, section, loop, tempo, count-in, mix**, plus
  **kit** and **score** for the optional layer in §6.

## 5. What is new and needs designing

**Song map.** A strip showing the whole song as its sections in order, each as
long as it lasts, with the playhead moving along it. It answers "where am I?"
from 2 m. Click a section to jump there. It is also where you pick a loop.

**Loop.** Pick one section, several sections next to each other, or a range of
bars (a fill plus the bar before it is a common pick). Show the loop both on the
song map and in the notation. A loop needs:

- on/off, with a key
- a pass counter ("pass 3")
- a choice of what happens between passes: jump straight back, or a bar of click
  as a breather. This is a setting, not a mode.
- a one-bar count-in before the first pass

**Tempo steps.** Tempo is the control touched most. A big readout; steps of 5%
and 10%; one quick way back to 100%.

**Tempo ramp**, optional per loop: "start at 70%, +5% every 2 passes, stop at
100%". It does what the drummer does by hand today. Show where the ramp is
("80% → 100%, next step after this pass").

**Count-in from pause.** Pressing play from a pause gives one bar of click first,
shown as a big 1 2 3 4 that can be read from the throne.

**Position.** The current section and bar number, readable from the throne.

**Library.** A home screen for the songs, replacing today's dropdown. Show
artist and title cleanly ("Blur — Song 2", not "Blur - Song 2 (Official Music
Video)"), length, the record's BPM, and whether it has a video. A song that is
prepared but not yet notated (Windhorse, below) shows as not playable yet. Nice
to have: each song remembers where you left off, meaning the last loop and tempo.

## 6. Optional layer: playing the e-kit and being scored

With the kit connected over MIDI, the app can grade what was played against the
notation. This used to be tied to routines and exercises. It stays, but as a
quiet, optional layer on whatever is playing: the whole song, or each pass of a
loop. Design it as secondary. When no kit is connected, none of it is on screen.

- **Connection** as a small status: not connected / connected / connected and
  calibrated. Calibration is a one-time ritual (you tap along to a click and it
  measures how late the system makes you sound), and it lives in settings.
- **The reading after a pass.** It was redesigned once already, because a correct
  table of 24 numbers turned out to be unreadable. The rule: each element answers
  one question, in words where a word will do, with the raw numbers folded away.
  - **Notes**: how many of the written notes you played ("96%")
  - **Steady**: how even your timing was ("tight", "±8 ms")
  - **Feel**: where you sit against the record, as a needle between ahead,
    on it and behind
  - **Bar strip**: one block per bar, coloured by whether its notes landed. Click
    one to jump there. It leads to a sentence like "go again at bars 18 and 20".
  - **Coloured noteheads** in the notation: played, missed, wrong drum. Three
    colours, no more.

  The three are never blended into one score. No points, streaks, badges or
  celebrations.
- **With a ramp running**, a scored pass can also be what moves the tempo up
  ("step up when a pass is at least 90%"). Show this as an option of the ramp,
  not as a separate mode.

## 7. Screens and states

**First, three visual directions** of one frame: the Player, with Song 2 playing
with its video and the chorus looped at 80%. The three should differ in layout
and in feel, not be three palettes over one layout. Give each a name and one
sentence about its idea. **Stop there so a direction can be picked.**

Then, in the chosen direction:

1. Player: a whole song playing, with its video
2. Player: the same song with the video hidden, so the notation takes the stage
3. Player: a song with no video (Kill Me)
4. Player: looping "chorus" at 80% with the ramp on, pass 3
5. Player: the count-in moment, starting from a pause
6. Player: paused, browsing the notation away from the cursor
7. Picking a loop on the song map: nothing picked, one section, a range across sections
8. Mix, open
9. Library
10. Settings: notation layout, themes, sticking, MIDI and calibration, the keyboard list
11. Zen (fullscreen)
12. Scored: the kit connected, and the reading after a pass (§6)
13. Theme pairs: dark interface with light notation, dark with dark, light with light

**A clickable prototype only where a still image cannot show it**: picking a loop
on the song map, stepping the tempo, and the ramp moving it. Everything else can
be static frames.

**Last, a spec sheet** for implementation: the type scale, spacing, and colour
tokens as CSS custom properties for each theme. Include the notation's own
tokens (paper, ink, cursor, current bar, loop range, sticking letters, the three
verdict colours) and a short list of the components.

## 8. Principles

- **The notation is the hero.** Every other element earns its place against the
  size of the notation.
- **Readable at a glance from 2 m.** If it cannot be read or clicked from the
  throne, it does not belong on screen mid-song.
- **Calm while playing.** Nothing moves except the cursor and the line advancing.
  No animated transitions around the notation, nothing blinking.
- **A dim room.** Assume low light. Avoid large bright areas, except perhaps the
  notation's paper.
- **Few controls, big ones.** A handful are visible; the rest live in places you
  open between songs.
- **Plain words.** The reader is a drummer, not an engineer.
- **No gamification.**

## 9. Constraints from the build

- **One web page**: plain TypeScript and hand-written CSS with custom
  properties, no component framework, Chrome only. Prefer what plain HTML and CSS
  do well.
- **The notation is SVG drawn by alphaTab.** You control the paper and ink
  colours, the scale, bars per line, note spacing, line gap, the cursor and the
  current-bar highlight, how the loop is marked, the section labels (they can be
  hidden and drawn by the page instead), the R/L letters (already drawn by the
  page) and the notehead colours. You do not control the glyph shapes (the
  Bravura music font) or the engraving rules.
- **The notation's width must not change while it plays.** Changing its width or
  scale makes alphaTab re-engrave the whole score, a visible stall. Panels opened
  mid-song (mix, loop settings) should lay over the stage rather than squeeze it.
- **How much notation fits**: with 20 px between staff lines, a full-width line
  holds two to three bars of a busy part at today's note spacing, and four only
  with the spacing tightened. A line with its stems and sticking is about 270 px
  tall. Plan for 2 lines visible with the video and 3 without, and treat bars
  per line as a trade the design has to make visible.
- **Keep the keyboard model** in §3. Propose a key for the ramp if it needs one.
- **The behaviour in §5 is already built**, with plain temporary controls in
  today's left rail: the loop, tempo steps, the ramp (and its "only on a pass
  of 90%+" option), count-in from a pause, per-song memory of loop and tempo,
  and scoring per pass. The design is for how it looks and is reached, not
  for what it does.
- **Videos are 16:9.**

## 10. Real content for the mockups

| Song | Artist | Bars | Record BPM | Length | Video |
|---|---|---|---|---|---|
| Song 2 | Blur | 64 | 130 | 2:03 | yes |
| Kill Me | Hayley Williams | 62 | 91 | 2:47 | no |
| One For The Road | Arctic Monkeys | 73 | 91 | 3:26 | yes |
| Windhorse | Of The Trees | – | – | 3:54 | yes, not notated yet |

Sections, as bars:

- **Song 2**: verse 1–7 · into chorus 8 · chorus 9–16 · into verse 17 ·
  verse 18–24 · chorus to break 25–33 · break 34 · chorus 35–38 · into verse 39 ·
  verse 40–46 · chorus to break 47–55 · break 56 · last chorus 57–64
- **Kill Me**: verse 1–12 · into chorus 13–14 · chorus 15–22 · into verse 23 ·
  verse 24–31 · into chorus 2 32–33 · chorus 34–40 · into bridge 41 ·
  bridge 42–45 · build 46–49 · into last chorus 50–53 · last chorus 54–62
- **One For The Road**: not named yet, lettered A–N: A 1–8 · B 9–16 · C 17–20 ·
  D 21–24 · E 25–31 · F 32–36 · D 37–40 · G 41–44 · H 45–48 · I 49–53 ·
  J 54–57 · K 58–61 · L 62–65 · M 66–69 · N 70–73

Messages the app needs, in plain words:

- a song whose separated stems are missing plays the full record, so Band and
  Drums cannot be set apart
- the drum samples have not been made yet, so Kit is silent
  (the fix is a terminal command, `drums kit-bake`)
- the kit is connected but not calibrated yet

## 11. The attached screenshots (today's app at 2194 × 1100)

- **player-with-video.png**: Song 2 with its video. The video takes about three
  quarters of the stage's height, and the notation gets two lines with 9 px
  between staff lines. The side rails take about 30% of the width. Most of the
  right rail is disabled or empty.
- **player-fill.png**: Kill Me, which has no video, with the notation filling the
  stage. Fine at a desk, small from the throne. Section names ("into chorus",
  "verse") sit in the notation as bold serif text, the only place they appear.
- **reading-after-a-take.png**: older, at 1600 × 900. The scored reading after a
  whole-song take is at the bottom right: three dials, the bar strip, coloured
  noteheads. The content is right; it is just tiny and buried in the rail.
