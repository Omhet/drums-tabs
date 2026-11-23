# Reading the bars

The score is read one distinct bar at a time into `reading.txt`, by reader
agents (`reader.md` is their brief) or by you, when you check a bar they
doubted or one the record flags. Everything after the reading (the MIDI, the
alignment, the checks) is scripted.
So the reading is the step where care pays: a wrong cell turns into a wrong
note that the user practises.

## The format

`songs/nirvana-come-as-you-are-official-music-video/reading.txt` is a complete
example. Copy its header and layout.

```
# <Title> - <Artist>                 <- the first comment line is the title
# read from the drum-score video <url> (channel <name>)
# 4/4, quarter = <tempo mark>, <N> bars, <repeat signs or none>
# Key for this channel: ...          <- copy it from the channel file

pattern V1      ride groove, crash on 1
  CR  x . . . . . . . . . . . . . . .
  RD  . . x . x . x . x . x . x . x .
  SD  . . . . o . . . . . . . o . . .
  BD  o . . . . . . . o . o . . . o .

bars
  1    rest rest rest P4
  5    V1 V2 V3 V2
  21   V5 V2 V4< V2<
```

- **A pattern** has a name, a description and one row per instrument that
  plays in it. Each row has exactly sixteen cells: `1 e & a 2 e & a 3 e & a 4 e & a`.
  The rows are `CR CR2 RD HH HT MT SD XS FT BD HP` (XS is cross-stick, HP the
  hi-hat pedal). Leave out a row that has nothing in it.
- **Cells:** `x` is a cymbal or closed hat, `o` a drum hit (on the HH row, an
  open hat), `O` or `X` an accent, `f` a flam, `g` a ghost note, `d` a double
  (the hit and another a 32nd after it), `.` nothing. They become velocities
  96, 120, 110, 40 and 96 (both of a double's notes).
- **The bar list** has one row per line of the score: the score bar number the
  line starts on, then one pattern name per bar, in order. A `<` after a name
  marks a crescendo over that bar; for now it is only a note. A `!` marks a
  bar read apart from the bars that look like it, on purpose (the user's call
  from the record), so `review.py` doesn't flag it. `rest` is a bar with
  nothing in it.
- **A pattern's name** appears once and is used wherever that bar comes
  back. `assemble.py` names each one after its first sheet (`g07`), and the
  description says what the drums play. Come As You Are and Sonne were read
  by hand, before reader agents, and use names like V1 and G2 (V for verse,
  G for groove, F for fill). Either kind is fine.
- A `#` starts a comment anywhere. Use one wherever the chart departs from the
  score, with the reason.

## How to read a bar

Open every `read_gNN.png` (one per group of bars that look the same). The
staff positions are labelled with the channel's instruments down the left.

1. **Count the rhythm from the beams and flags, not the spacing.** One beam is
   an eighth (two cells), two beams a sixteenth (one cell), a dot adds half
   again. Walk the bar beat by beat and check that each beat adds up to four
   cells. Three beams are a 32nd, half a cell. A 32nd pair (Sonne's double
   kicks) is a `d` on the first one's cell.
2. **Then the pitch of every notehead on each stem:** which line or space,
   and what shape. Use the channel's key, which belongs to that channel only.
3. **Then the marks:** accents, flams (a small grace note before the hit),
   open-hat circles, ghost notes in parentheses.
4. **When a bar is hard to see**, open its line image (`lines/lineNN.png`) or a
   raw frame. The groups are cut from the clean lines, and a neighbouring bar
   can show you the beat spacing.

Sticking letters under the notes (R, L, K) are not read into the grid yet
(`handoff.md` §4). They still help: K under a note means a kick was played
there.

## Checking the reading

`review.py` checks three things: the reading covers every bar image, each line
has as many bars as its picture, and every group of bars that look the same
was given one pattern. It also writes `review.md`, where each line's picture
sits above its grids. Look through it line by line, because that is where a
misread shows. If the image grouping put two different bars together (it once
merged a ride bar with a crash bar), `group.py --compare 5-21` prints why.

Then `to_midi.py` checks the reading against the record, which is the strong
test. Every written kick and snare should land on a hit in the drum stem. The
right alignment comes out near 100%. A bar whose kicks or snares miss is
almost always a misread, so look at it again. A strong hit on the record where
the score has nothing is a different case. That is usually the transcriber
leaving something out, and it is the user's to decide (SKILL.md).

## Mistakes made before

- The **ride triangle and the crash circle** at the same height look alike at
  a glance, and the first image grouping merged them. Look at the shape.
- **Two lines can be identical except for the bar number.** `strips.py`
  splits them when the cursor jumps back to the left. If a line seems to be
  missing, count the lines against the bar numbers.
- **The last bar's final hit** often sits off the beat map (the ending
  stretches). `to_midi.py` flags it every time, so ignore it.
- A groove that repeats every two bars makes the alignment two bars off score
  well too (94.9% against 100% for Come As You Are). Trust the clear winner
  only when it is near 100%.
- **A "0" at the start of a hairpin is not an open hat.** Engel's crescendo
  begins with a "0" just left of the first hat, level with the hairpin line
  (a niente mark: from nothing). An open-hat "0" sits above the note's own
  stem. Two readers took the first for an open hat; zoom in when a "0" comes
  right before a hairpin.
