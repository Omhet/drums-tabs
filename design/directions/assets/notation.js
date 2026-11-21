// Shared by the mockups: lays real alphaTab engraving (captured from the app's
// cover-tab.html at 20 px between staff lines) into a page, row by row, and
// draws the page's own layers over it -- loop, current bar, cursor, section
// labels, sticking letters. Each direction styles those layers in its own CSS.
(function () {
  function div(cls, parent, css, text) {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    if (css) Object.assign(d.style, css);
    if (text != null) d.textContent = text;
    if (parent) parent.appendChild(d);
    return d;
  }
  const px = (n) => `${n}px`;

  /**
   * host: an empty element. o:
   *   score     key into window.SCORES
   *   rows      row indices to show, top to bottom
   *   lane      px under each row for the sticking letters (default 30)
   *   trimTop   px cut from the top of each row (unused headroom)
   *   gap       px between rows
   *   cursor    { bar, slot }   slot = sixteenth in the bar
   *   current   bar number to mark as the bar being played
   *   loop      { from, to }   bars, inclusive
   *   sections  [{ name, from, to }] -- labels at each section's first bar
   *   sticking  draw R/L (default true)
   *   barNumbers 'page' to draw our own and hide alphaTab's
   *   paused    { bar, slot } a second, quieter cursor (browsing)
   */
  function render(host, o) {
    const S = window.SCORES[o.score];
    const lane = o.lane ?? 30;
    const trimTop = o.trimTop ?? 0;
    host.classList.add('nt');
    host.style.width = px(S.width);
    if (o.barNumbers === 'page') host.classList.add('nt-own-barno');
    const starts = new Map((o.sections ?? []).map((s) => [s.from, s]));
    const beatX = (bar, slot) => {
      const hits = S.beats.filter((b) => b.bar === bar && b.slot === slot);
      const b = hits.find((h) => h.voice === 0) ?? hits[0];
      if (b) return b.x;
      const bb = S.bars.find((x) => x.bar === bar);
      return bb.x + (bb.w * slot) / 16;
    };
    o.rows.forEach((ri, n) => {
      const r = S.rows.find((x) => x.i === ri);
      const rowBars = S.bars.filter((b) => b.row === ri);
      // A row where a section starts gets a lane above it for the name, the
      // way alphaTab makes room for its own section markers.
      const labelLane = o.labelLane && rowBars.some((b) => starts.has(b.bar)) ? o.labelLane : 0;
      const top = r.y + trimTop - labelLane;
      const height = r.h - trimTop + lane + labelLane;
      const row = div('nt-row', host, { height: px(height), marginTop: n ? px(o.gap ?? 0) : '0' });
      row.dataset.row = ri;
      if (labelLane) row.classList.add('has-label');
      const inner = div('nt-inner', row, { top: px(-top), width: px(S.width), height: px(top + height) });
      const under = div('nt-under', inner);
      // The engraving clipped to its own row, so the next row's top stems do
      // not show through the sticking lane.
      const ink = div('nt-ink', inner, { top: px(r.y + trimTop), height: px(r.h - trimTop), bottom: 'auto', overflow: 'hidden' });
      const over = div('nt-over', inner);
      const staffTop = rowBars[0].y;
      const staffH = rowBars[0].h;
      const rowBox = { top, bottom: top + height };
      for (const b of rowBars) {
        const inLoop = o.loop && b.bar >= o.loop.from && b.bar <= o.loop.to;
        const box = { left: px(b.x), width: px(b.w), top: px(rowBox.top), height: px(height) };
        if (inLoop) {
          const l = div('nt-loop', under, box);
          if (b.bar === o.loop.from) l.classList.add('first');
          if (b.bar === o.loop.to) l.classList.add('last');
          if (b === rowBars[0]) l.classList.add('row-first');
          if (b === rowBars[rowBars.length - 1]) l.classList.add('row-last');
        } else if (o.loop) {
          div('nt-out', over, box);
        }
        if (o.current === b.bar) {
          div('nt-cur', under, { left: px(b.x), width: px(b.w), top: px(staffTop - 60), height: px(staffH + 120) });
        }
        if (starts.has(b.bar)) {
          const s = div('nt-sec', over, { left: px(b.x), top: px(rowBox.top) });
          div('nt-sec-name', s, null, starts.get(b.bar).name);
        }
        if (o.barNumbers === 'page') div('nt-barno', over, { left: px(b.x), top: px(staffTop) }, String(b.bar));
        if (o.loop && b.bar === o.loop.from) div('nt-rep start', over, { left: px(b.x), top: px(staffTop), height: px(staffH) });
        if (o.loop && b.bar === o.loop.to) div('nt-rep end', over, { left: px(b.x + b.w), top: px(staffTop), height: px(staffH) });
      }
      for (const p of S.partials) {
        if (p.top + p.h < r.y || p.top > r.y + r.h) continue;
        const holder = div('nt-part', ink, { left: px(p.left), top: px(p.top - r.y - trimTop), width: px(p.w), height: px(p.h) });
        holder.innerHTML = p.svg;
      }
      if (o.sticking !== false) {
        for (const b of S.beats) {
          if (b.row !== ri || !b.letters) continue;
          div('nt-stick', over, { left: px(b.x), top: px(r.y + r.h - 6) }, b.letters);
        }
      }
      if (o.cursor && rowBars.some((b) => b.bar === o.cursor.bar)) {
        div('nt-cursor', over, { left: px(beatX(o.cursor.bar, o.cursor.slot)), top: px(staffTop - 56), height: px(staffH + 112) });
      }
      if (o.paused && rowBars.some((b) => b.bar === o.paused.bar)) {
        div('nt-cursor ghost', over, { left: px(beatX(o.paused.bar, o.paused.slot)), top: px(staffTop - 56), height: px(staffH + 112) });
      }
    });
  }

  /** Fit the fixed 2194 x 1100 frame into a smaller window; 1:1 on the real screen. */
  function fit() {
    const f = document.querySelector('.frame');
    if (!f) return;
    const s = Math.min(1, window.innerWidth / 2194, window.innerHeight / 1100);
    f.style.transform = s < 1 ? `scale(${s})` : '';
  }
  window.addEventListener('resize', fit);
  window.addEventListener('DOMContentLoaded', fit);

  window.Notation = { render, fit };
})();
