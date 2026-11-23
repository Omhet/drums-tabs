# Reading sheets (the brief for a reader agent)

You are reading bars of a drum score, one image at a time, into text grids. A
wrong cell turns into a wrong note that a drummer practises, so take care, and
say so when you are not sure rather than guessing quietly.

Read these first:

- `references/reading.md`: the grid format and how to count a bar. You write
  pattern blocks only. The header and the bar list are not your job.
- The channel file you were given (`references/channels/<handle>.md`): which
  staff position and which symbol is which drum. It belongs to this channel
  only.

Don't open another song's `reading.txt` or anything under `songs/`. Read the
images.

## Your sheets

Each `read_gNN.png` is one bar: the first bar of group gNN, the bars of the
score that look the same. Red at the top: the group, its first bar number,
and how many bars it stands for. Blue at the left: the staff positions,
labelled with the channel's drums. The cymbals all sit above the staff, so
for those the label tells you only the height. The shape tells you which
cymbal.

Two sheets can hold the same notes. The grouping also splits on layout, such
as a wider bar at the start of a line or sticking letters printed under one
and not the other. Read each sheet as it is: identical grids are merged
later.

For each sheet, write `<read_dir>/gNN.txt` (the same number):

```
pattern g07     open-hat groove, crash on 1
  CR  x . . . . . . . . . . . . . . .
  HH  . . o . o . o . o . o . o . o .
  SD  . . . . o . . . . . . . o . . .
  BD  o . . o . o . . o . . o . o . d   # a 32nd-note pair on the "a" of 4
```

- The first line is `pattern gNN`, then a few words on what the drums play.
- One row per drum that plays, with exactly sixteen cells
  (`1 e & a 2 e & a 3 e & a 4 e & a`) from `reading.md`'s cell list.
- **A bar with no notes:** the file holds just `rest`.
- **A crescendo hairpin under the bar:** add a line `crescendo`.
- **Anything the grid cannot hold** (a choke, a grace note on another drum, a
  tie, a 32nd that is not a pair): write the nearest grid and a `#` comment on
  that row saying what the score has.
- **A cell you are unsure of:** your best reading, and a `#` comment on its
  row with the beat and what is in doubt ("4&: open or closed hat? the 0 is
  faint").

## How to read one

1. Open the sheet. Walk the bar beat by beat. Count each beat from the beams
   and flags, and check that it adds up to four cells. Then name every
   notehead on each stem by its height and shape. Then add the marks: accents,
   flams, open-hat circles, ghost notes.
2. **Zoom wherever it is tight:** three beams against two, a small grace note,
   an open-hat circle, a dot. Run
   `python -I <scripts>/zoom.py <sheet> <scratch>/gNN_b3.png 3 4` to get beats
   3-4 at three times the size, then open that file.
3. Before writing, look at the whole bar once more and count the noteheads
   against your grid.

## When you are done

Reply with one line per doubt: the sheet, the beat, and what is uncertain.
Write "no doubts" if there are none. Don't put the grids in the reply: they
are in the files.
