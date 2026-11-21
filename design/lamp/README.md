# Lamp: the picked redesign (2026-11-21)

Of three directions (Lamp, Console, Chart) the user picked **Lamp**, set in
**Atkinson Hyperlegible Next** instead of a serif. The source is the Claude
Design canvas https://claude.ai/artifact/7rf7x1nNqfGb28azauUy1v (pages: Lamp
frames, Prototype, Spec, Directions). These are copies of its files, so the
build does not depend on reaching it.

The `.dc.html` files are Claude Design components: absolute-positioned inline
styles at 2194x1100, read them for **sizes, colours, words and layout**, not as
code to paste. They do not render outside the canvas (`support.js`, `/_blob/`
images are the canvas's). `LampMap.dc.html` and `Lamp-Prototype.dc.html` have
real logic: the song map's block/label/tier layout and the loop-pick rules.

| file | what |
|---|---|
| `Lamp-Spec.dc.html` | **the spec**: type scale, space, components, every colour token as CSS custom properties for both interface themes and both papers |
| `Lamp-01` .. `03` | player: video, video hidden (3 lines), no video (Kill Me) |
| `Lamp-04` | chorus looped at 80%, ramp ladder in place of the tempo pills |
| `Lamp-05` | count-in: 1 2 3 4 at 160 px in place of the section name |
| `Lamp-06` | paused and browsing: "bars 25-32", Back to bar 11 (Home), dashed outline |
| `Lamp-07` | the song map grown into a picker (164 px): bar marks, handles |
| `Lamp-08`, `08b` | the mix as a panel over the header; the no-stems version |
| `Lamp-09` | library |
| `Lamp-10` | settings, including the keys list (new: `{ }` `\` `L` `R` `M` `V`) |
| `Lamp-11` | zen |
| `Lamp-12` | kit connected: the reading card in the header after a pass |
| `Lamp-Prototype` | loop picking, tempo steps, the ramp ladder, clickable |
| `notation/` | three of the canvas's notation captures (real alphaTab at scale 2.25 with the page's layers drawn on: section label lane, loop bracket, current-bar wash, cursor, R/L) |

Not copied: the theme-pair frames 13a-c (the spec has their tokens) and the
two directions not picked.
