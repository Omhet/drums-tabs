// The stylesheet's colour tokens (index.html, from design/lamp/Lamp-Spec), read
// back for the two things that paint with them but are not CSS: alphaTab's
// engraving (main.ts palette) and the heatmap's noteheads (heatmap.ts). Read at
// the moment of drawing, so a theme switch is a re-read and a redraw.

export type Rgb = [number, number, number];

/** A `#rrggbb` custom property of the page, as three numbers. */
export function tokenRgb(name: string): Rgb {
  const hex = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`${name} is not a #rrggbb colour: "${hex}"`);
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}
