// The song map, shared by the mockups: one block per section, as wide as it
// lasts. Blocks too narrow for their name get class `short` and their name in
// a separate tier (`.sm-tier`) so a one-bar fill is still labelled. Each
// direction styles it.
(function () {
  const SONGS = {
    song2: {
      title: 'Song 2', artist: 'Blur', bpm: 130, bars: 64, length: '2:03',
      sections: [
        ['verse', 1, 7], ['into chorus', 8, 8], ['chorus', 9, 16], ['into verse', 17, 17],
        ['verse', 18, 24], ['chorus to break', 25, 33], ['break', 34, 34], ['chorus', 35, 38],
        ['into verse', 39, 39], ['verse', 40, 46], ['chorus to break', 47, 55], ['break', 56, 56],
        ['last chorus', 57, 64],
      ].map(([name, from, to]) => ({ name, from, to })),
    },
  };

  function div(cls, parent, css, text) {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    if (css) Object.assign(d.style, css);
    if (text != null) d.textContent = text;
    if (parent) parent.appendChild(d);
    return d;
  }

  /**
   * o: song, width, loop {from,to}, at (bar position, 1-based float),
   *    minLabel (px a block needs to hold its own name), kind (fn name -> class)
   */
  function render(host, o) {
    const song = SONGS[o.song];
    const W = o.width;
    const per = W / song.bars;
    host.classList.add('sm');
    host.style.width = `${W}px`;
    const strip = div('sm-strip', host);
    const tier = div('sm-tier', host);
    for (const s of song.sections) {
      const left = (s.from - 1) * per;
      const width = (s.to - s.from + 1) * per;
      const b = div('sm-block', strip, { left: `${left}px`, width: `${width}px` });
      b.dataset.name = s.name;
      if (o.kind) b.classList.add(o.kind(s.name));
      const inLoop = o.loop && s.from >= o.loop.from && s.to <= o.loop.to;
      if (inLoop) b.classList.add('in-loop');
      if (o.at != null && o.at >= s.from && o.at < s.to + 1) b.classList.add('now');
      // Measured, not guessed: a name that overflows its block (on one line,
      // or two with `wrap`) moves to the tier.
      const label = div('sm-label', b, null, s.name);
      label.style.whiteSpace = o.wrap ? 'normal' : 'nowrap';
      label.style.minWidth = '0';
      const cs = getComputedStyle(b);
      const contentW = b.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const lineH = parseFloat(getComputedStyle(label).fontSize) * 1.2;
      const tooWide = label.scrollWidth > contentW + 0.5;
      const tooTall = label.offsetHeight > lineH * (o.wrap ? 2 : 1) + 1;
      if (tooWide || tooTall) {
        label.remove();
        b.classList.add('short');
        const t = div('sm-tlabel', tier, { left: `${left + width / 2}px` }, s.name);
        if (inLoop) t.classList.add('in-loop');
      }
    }
    // Tier names that would touch are pushed apart.
    const tl = [...tier.children];
    for (let pass = 0; pass < 30; pass++) {
      let moved = false;
      for (let i = 1; i < tl.length; i++) {
        const a = tl[i - 1], c = tl[i];
        const aRight = parseFloat(a.style.left) + a.offsetWidth / 2;
        const cLeft = parseFloat(c.style.left) - c.offsetWidth / 2;
        const overlap = aRight + 18 - cLeft;
        if (overlap > 0.5) {
          a.style.left = `${parseFloat(a.style.left) - overlap / 2}px`;
          c.style.left = `${parseFloat(c.style.left) + overlap / 2}px`;
          moved = true;
        }
      }
      if (!moved) break;
    }
    if (o.loop) {
      div('sm-loop', strip, {
        left: `${(o.loop.from - 1) * per}px`,
        width: `${(o.loop.to - o.loop.from + 1) * per}px`,
      });
    }
    if (o.at != null) div('sm-head', strip, { left: `${(o.at - 1) * per}px` });
    return { per };
  }

  window.SongMap = { render, SONGS };
})();
