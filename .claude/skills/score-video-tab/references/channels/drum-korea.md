# 알려드럼 (@DRUM-KOREA)

A Korean drum-lesson channel: a drummer plays the song along with the record,
and the score scrolls under him a line at a time. Channel id
`UCJPvv0hCRPskkLQwmi1AI2A`. The user confirmed this key on 2026-11-22 against
Come As You Are. It belongs to this channel, so don't use it for another one.

## The frame (1080p)

- The drummer fills the top of the frame, with a pedal camera in a corner and
  the lyrics in English and Korean. The score is a white strip across the
  bottom: **rows 756-1080** (`strips.py <video> <out> 756 1080`; the height
  has to be even).
- **Four bars a line**, one line on screen at a time: the whole strip turns
  over when the cursor reaches the end. The last line of a song can hold five
  bars.
- The **bar number** is printed at the left of each line, before the
  percussion clef. The first bar starts at x ≈ 95 (`bars.py --clef-end 95`).
- The **cursor** is a translucent blue column (blue minus red > 40) that
  steps through the notes. `strips.py` masks it out.
- The video opens on the first line before the music starts. It ends on an
  end card with no staff, which `bars.py` skips.
- The description has a difficulty (`난이도: ★★★`) and a technique list
  (`테크닉: 8비트리듬+…+16비트필인+하이햇오픈+점점크게+악센트`). Read the list
  as a checklist of what the score holds: 16비트 필인 means sixteenth-note
  fills, 하이햇 오픈 open hi-hat, 점점 크게 a crescendo, 악센트 accents.
  (Come As You Are's also said 쉐이크리듬, a shuffle feel, and the score had
  none: the list is a hint, not a promise.)

## The key

Positions are counted in half-spaces down from the top staff line: 0 is the
top line, 1 the top space, 2 the second line, 3 the second space, and so on to
8, the bottom line. Negative numbers are above the staff.

| what you see                          | where                         | row  |
|---------------------------------------|-------------------------------|------|
| x                                     | -1, the space above the staff | HH   |
| x with a "0" over it (above the beam) | -1                            | HH `o` (open) |
| filled triangle                       | -1, above the staff           | RD   |
| circled x (⊗)                         | -1, above the staff           | CR   |
| notehead                              | 1, the top space              | HT   |
| notehead                              | 2, the second line            | MT   |
| notehead                              | 3, the second space           | SD   |
| notehead                              | 5, the third space            | FT   |
| notehead                              | 7, the bottom space           | BD   |

`group.py --labels "-1:HH,1:HT,2:MT,3:SD,5:FT,7:BD"` labels the sheets with
this key.

The cymbals all sit at the same height, so **the shape is the instrument**. A
triangle is the ride, a circled x is the crash, a plain x is the hi-hat. The
circled x is the crash here even though the app draws an open hi-hat that way,
so read it as CR. The score has one crash symbol. Whether a passage is on the
first or the second crash is the drummer's choice (see SKILL.md).

## Everything else on the staff

- **One voice**: every stem points up, the kick's too. A kick and a cymbal on
  the same stem sound together.
- **Accents**: `>` over the note → `O`.
- **Flams**: a small grace note with a slash before the main note → `f` on the
  main note's cell.
- **Dotted notes** turn up in fills: a dotted eighth lasts three sixteenths.
  Count them from the beams, not from the spacing.
- **Sticking** is printed under fills and some grooves: `R`, `L`, and `K` for
  the kick. It is not part of the reading yet (it's an idea in `handoff.md`
  §4), so leave it out, but it shows you where the hits are.
- **Crescendo** hairpins sit under the staff over a bar or two → a `<` after
  that bar's pattern name in the bar list.
- **Count-in**: the first line opens with empty bars before the pickup. Read
  them as `rest`. `to_midi.py` finds which score bar is the song's bar 1.

## Songs read from this channel

| song | video | score bar = song bar 1 | notes |
|------|-------|------------------------|-------|
| Nirvana, Come As You Are | `qxlvvZV229Q` | 4 | 105 score bars, 18 patterns; the score leaves out the kick on the "&" of 1 in the chorus's snare-sixteenth bars |
