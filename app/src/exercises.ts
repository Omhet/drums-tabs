// The exercise panels: the song's list, the cutting form, the ladder, the pool.
//
// This file renders and nothing else. It reads the pool off disk, draws it, and
// hands `Practice` an exercise to aim at -- it owns no MIDI, no clock and no
// grading, all of which live in practice.ts where the kit is. The split is the
// same one `routine.ts` and `practice.ts` already have, one layer up.
import type { SongMeta } from 'virtual:songs';
import {
  deleteExercise,
  exercisesForSong,
  ladder,
  nextSquare,
  readExercises,
  sourceFor,
  tempoSeries,
  uniqueId,
  writeExercise,
  type Exercise,
  type ExerciseFile,
  type ExerciseSource,
  type Kind,
  type Square,
} from './exercise';
import type { Practice } from './practice';
import { PASS, rollingMedian, TEMPOS } from './routine';

/** Past this a loop is not something you can hold in your head. */
const LONG_BARS = 8;
const SVG = 'http://www.w3.org/2000/svg';

export interface ExercisesElements {
  /** The song's list, in the desk. */
  list: HTMLElement;
  /** The cutting form, revealed by `Cut bars…`. */
  form: HTMLFormElement;
  cut: HTMLButtonElement;
  poolButton: HTMLButtonElement;
  /** The pool, which takes over the stage. */
  pool: HTMLElement;
  /** The armed exercise's ladder, in the desk. */
  ladder: HTMLElement;
  drillState: HTMLOutputElement;
  back: HTMLButtonElement;
}

export class Exercises {
  /** The whole pool, re-read whenever it changes on disk. */
  private files: ExerciseFile[] = [];
  private song: SongMeta | undefined;
  /** Which exercise the desk's Drill group is showing, if any. */
  private open: string | undefined;

  constructor(
    private readonly el: ExercisesElements,
    private readonly practice: Practice,
    private readonly songs: SongMeta[],
    /** Where the page should go: the hash is the router (main.ts). */
    private readonly goTo: (hash: string) => void,
    private readonly onStatus: (text: string, isError?: boolean) => void,
    /** Which bar the cursor is on, so the form opens on the section you are in. */
    private readonly currentBar: () => number,
    /** The notes a range asks for, so an exercise over silence can be refused. */
    private readonly notesIn: (startBar: number, endBar: number) => number,
    /** Today's chart hash, stamped on a source when the scissors come out. */
    private readonly chartHash: () => string
  ) {
    el.cut.addEventListener('click', () => this.toggleForm());
    el.poolButton.addEventListener('click', () => this.goTo('#exercises'));
    el.back.addEventListener('click', () => {
      this.practice.disarm();
      this.goTo(`#${encodeURIComponent(this.song?.slug ?? '')}`);
    });
    el.form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.save();
    });
    // A drill reaching disk is the only thing that changes a ladder, and the
    // ladder is read back rather than patched: the square *is* the newest file.
    practice.onDrilled = () => void this.reload();
  }

  /** The pool as last read. */
  get all(): ExerciseFile[] {
    return this.files;
  }

  /** Re-read the pool and redraw whatever is on screen. */
  async reload() {
    this.files = await readExercises();
    this.drawList();
    this.drawPool();
    if (this.open) this.drawLadder(this.open);
  }

  /**
   * Where an exercise would be played from, without arming it.
   *
   * The router needs this before it can load anything: an exercise names the
   * song, so following a `#exercise/<id>` link has to know which record to put
   * on before it can aim at the bars.
   */
  sourceOf(id: string): ExerciseSource | undefined {
    const file = this.file(id);
    return file ? sourceFor(file.exercise, this.song?.slug) : undefined;
  }

  /** Point the panels at a song. Called when one loads. */
  async load(song: SongMeta) {
    this.song = song;
    this.el.form.hidden = true;
    await this.reload();
  }

  /**
   * A song's title with the video's boilerplate off the end.
   *
   * Titles come from YouTube, so they carry "(Official Music Video)" and its
   * cousins. That is four words of nothing in a list whose whole job is to be
   * read at a glance, and it is only ever dropped for display -- `song.toml`
   * and every file keep the real thing.
   */
  private title(slug: string): string {
    const full = this.songs.find((s) => s.slug === slug)?.title ?? slug;
    return full.replace(/\s*\((?:official|lyric|audio|visuali[sz]er)[^)]*\)\s*$/i, '').trim() || full;
  }

  private file(id: string): ExerciseFile | undefined {
    return this.files.find((f) => f.exercise.id === id);
  }

  // --- arming ------------------------------------------------------------------------

  /**
   * Aim at an exercise, at the rung it suggests.
   *
   * Returns the source it will be played from, so the caller can load that song
   * first if it is not the one on screen.
   */
  arm(id: string, tempo?: number): ExerciseSource | undefined {
    const file = this.file(id);
    if (!file) {
      this.onStatus(`No exercise called ${id}.`, true);
      return undefined;
    }
    const source = sourceFor(file.exercise, this.song?.slug);
    if (!source) {
      this.onStatus(`${file.exercise.name} has no source to play it from.`, true);
      return undefined;
    }
    const at = tempo ?? nextSquare(ladder(file.drills));
    this.open = id;
    this.practice.armExercise(file.exercise, source, at);
    this.drawLadder(id);
    return source;
  }

  /**
   * The ladder: four squares, one per rung, and a line under each.
   *
   * The same grid the routine draws, deliberately -- the question is the same
   * one ("how did that go, and which way is it going") so it should not be a
   * second thing to learn. What is different is that nothing is sealed: the
   * newest drill at a tempo simply *is* that square.
   */
  private drawLadder(id: string) {
    const file = this.file(id);
    const el = this.el.ladder;
    el.replaceChildren();
    if (!file) return;
    const armed = this.practice.armed;
    const squares = ladder(file.drills);
    const source = sourceFor(file.exercise, this.song?.slug);

    this.el.drillState.textContent = source
      ? `${file.exercise.name} · bars ${source.startBar}-${source.endBar}` +
        (file.exercise.restBars
          ? ` · ${file.exercise.restBars} bar${file.exercise.restBars > 1 ? 's' : ''} of rest`
          : ' · no rest') +
        (file.exercise.backing === 'click' ? ' · click only' : '')
      : file.exercise.name;
    this.el.drillState.title = file.exercise.note ?? '';

    const table = document.createElement('table');
    table.className = 'grid';
    const head = document.createElement('tr');
    head.appendChild(document.createElement('th'));
    for (const tempo of TEMPOS) {
      const th = document.createElement('th');
      th.textContent = `${Math.round(tempo * 100)}%`;
      head.appendChild(th);
    }
    const thead = document.createElement('thead');
    thead.appendChild(head);
    table.appendChild(thead);

    const body = document.createElement('tbody');
    const row = document.createElement('tr');
    row.className = 'whole';
    const label = document.createElement('th');
    label.textContent = file.exercise.kind;
    row.appendChild(label);
    for (const square of squares) {
      const td = document.createElement('td');
      const button = document.createElement('button');
      const drill = square.drill;
      button.className =
        'cell' +
        (drill ? (drill.accuracy >= PASS ? ' pass' : ' fail') : '') +
        (armed?.tempo === square.tempo ? ' at' : '');
      button.textContent = drill ? `${Math.round(drill.accuracy * 100)}%` : '·';
      button.title = drill
        ? `${drill.completeReps} rep${drill.completeReps === 1 ? '' : 's'} on ${drill.startedAt.slice(0, 10)}, ` +
          `${Math.round(drill.worst * 100)}% to ${Math.round(drill.best * 100)}%. ` +
          'The median of a sitting, and the newest sitting wins.'
        : 'Not drilled at this tempo yet';
      button.addEventListener('click', () => this.arm(id, square.tempo));
      td.appendChild(button);
      row.appendChild(td);
    }
    body.appendChild(row);

    if (file.drills.length > 1) {
      const trends = document.createElement('tr');
      trends.className = 'trends';
      const th = document.createElement('th');
      th.className = 'trend-head';
      th.textContent = `${file.drills.length} drills`;
      th.title =
        'How each tempo has gone across your sittings, oldest on the left, smoothed ' +
        'as a median of the last three. The dotted line is ' +
        `${Math.round(PASS * 100)}%.`;
      trends.appendChild(th);
      for (const square of squares) trends.appendChild(trendCell(file, square));
      body.appendChild(trends);
    }
    table.appendChild(body);
    el.appendChild(table);
  }

  // --- the song's list ----------------------------------------------------------------

  private drawList() {
    const el = this.el.list;
    el.replaceChildren();
    const slug = this.song?.slug;
    if (!slug) return;
    for (const exercise of exercisesForSong(this.files.map((f) => f.exercise), slug)) {
      el.appendChild(this.row(exercise, slug));
    }
  }

  /** One line: what it is called, which bars, and its four squares in miniature. */
  private row(exercise: Exercise, slug: string): HTMLElement {
    const file = this.file(exercise.id);
    const source = sourceFor(exercise, slug)!;
    const button = document.createElement('button');
    button.className = 'ex';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = exercise.name;
    const bars = document.createElement('span');
    bars.className = 'bars';
    bars.textContent = `${source.startBar}-${source.endBar}`;
    button.append(name, bars, pips(ladder(file?.drills ?? [])));
    button.title =
      `${exercise.kind} · bars ${source.startBar}-${source.endBar}` +
      (exercise.note ? ` · ${exercise.note}` : '') +
      (source.chartHash && source.chartHash !== this.chartHash()
        ? ' · cut from an older chart, so the notes in these bars may have moved'
        : '');
    button.addEventListener('click', () => this.goTo(`#exercise/${exercise.id}`));
    return button;
  }

  // --- the pool ------------------------------------------------------------------------

  /**
   * Every exercise in the repo, grooves then fills.
   *
   * Across songs, which is the whole point of the pool being at the repo root:
   * the thing you want to drill is a kind of figure, and which record it came
   * off is a detail of where to hear it.
   */
  private drawPool() {
    const el = this.el.pool;
    el.replaceChildren();
    if (this.files.length === 0) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent =
        'No exercises yet. Open a song, find the bars you keep dropping, and press Cut bars.';
      el.appendChild(p);
      return;
    }
    for (const kind of ['groove', 'fill'] as Kind[]) {
      const of = this.files.filter((f) => f.exercise.kind === kind);
      if (of.length === 0) continue;
      const h2 = document.createElement('h2');
      h2.textContent = kind === 'groove' ? 'Grooves' : 'Fills';
      el.appendChild(h2);
      for (const file of of.sort((a, b) => a.exercise.name.localeCompare(b.exercise.name))) {
        el.appendChild(this.poolRow(file));
      }
    }
  }

  private poolRow(file: ExerciseFile): HTMLElement {
    const ex = file.exercise;
    const button = document.createElement('button');
    button.className = 'ex';
    // A source whose song is gone is still a real exercise with a real history;
    // it just cannot be played until that song comes back.
    const playable = ex.sources.filter((s) => this.songs.some((song) => song.slug === s.slug));
    if (playable.length === 0) button.classList.add('orphan');

    const left = document.createElement('div');
    const name = document.createElement('b');
    name.textContent = ex.name;
    left.appendChild(name);
    if (ex.note) {
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = ex.note;
      left.appendChild(note);
    }

    const where = document.createElement('span');
    where.className = 'where';
    where.textContent =
      ex.sources.length === 0
        ? 'nowhere to play it'
        : ex.sources
            .map((s) => `${this.title(s.slug)} ${s.startBar}-${s.endBar}`)
            .join(' · ');

    button.append(left, where, pips(ladder(file.drills)));
    if (playable.length === 0) {
      button.title = 'The song this was cut from is not in songs/ any more.';
    } else {
      button.addEventListener('click', () => this.goTo(`#exercise/${ex.id}`));
    }
    return button;
  }

  // --- cutting one out ------------------------------------------------------------------

  private toggleForm() {
    const form = this.el.form;
    if (!form.hidden) {
      form.hidden = true;
      return;
    }
    this.buildForm();
    form.hidden = false;
  }

  /**
   * The form that cuts bars into an exercise.
   *
   * The picker is the section list, because the fills are already blocks of
   * their own in every prepared song -- so the common case is "this section,
   * whole" and the form arrives filled in. The bar inputs are for the grooves
   * the sections do not happen to name.
   */
  private buildForm() {
    const form = this.el.form;
    const song = this.song;
    form.replaceChildren();
    if (!song) return;

    const sections = song.sections.filter((s) => s.name.trim());
    // Open on the section the cursor is in: you found the bars by playing them.
    const bar = this.currentBar();
    const here = sections.find((s) => bar >= s.start_bar && bar <= s.end_bar) ?? sections[0];

    const section = select(
      'From',
      [
        ...sections.map((s) => ({
          value: `${s.start_bar}-${s.end_bar}`,
          label: `${s.name} · ${s.start_bar}-${s.end_bar}`,
        })),
        { value: '', label: '(these bars)' },
      ],
      here ? `${here.start_bar}-${here.end_bar}` : ''
    );
    const from = number('Bars', here?.start_bar ?? 1);
    const to = number('to', here?.end_bar ?? 1);
    // `Kill Me verse`, not `Hayley Williams - Kill Me (Official Visualizer) verse`.
    const short = this.title(song.slug).split(' - ').pop() ?? song.slug;
    const name = text('Name', here ? `${short} ${here.name}` : '');
    const kind = select(
      'Kind',
      [
        { value: 'fill', label: 'fill' },
        { value: 'groove', label: 'groove' },
      ],
      kindOf(here)
    );
    const rest = number('Rest bars', 1);
    const backing = select(
      'Backing',
      [
        { value: 'record', label: 'the record' },
        { value: 'click', label: 'click only' },
      ],
      'record'
    );
    const note = text('Note', '');
    const add = select('Add to', [{ value: '', label: '(a new exercise)' }], '');
    for (const file of this.files) {
      add.input.add(new Option(file.exercise.name, file.exercise.id));
    }

    section.input.addEventListener('change', () => {
      const [a, b] = section.input.value.split('-');
      if (!a || !b) return;
      from.input.value = a;
      to.input.value = b;
      const named = sections.find((s) => String(s.start_bar) === a && String(s.end_bar) === b);
      if (!named) return;
      name.input.value = `${short} ${named.name}`;
      kind.input.value = kindOf(named);
    });

    const why = document.createElement('p');
    why.className = 'why';
    why.hidden = true;
    const save = document.createElement('button');
    save.type = 'submit';
    save.textContent = 'Cut it';
    const row = document.createElement('div');
    row.className = 'row';
    row.appendChild(save);

    form.append(
      ...section.nodes,
      ...from.nodes,
      ...to.nodes,
      ...name.nodes,
      ...kind.nodes,
      ...rest.nodes,
      ...backing.nodes,
      ...note.nodes,
      ...add.nodes,
      why,
      row
    );
    form.dataset.ready = '1';
  }

  /** Write it, or say why it is not an exercise. */
  private async save() {
    const song = this.song;
    const form = this.el.form;
    if (!song) return;
    const value = (label: string) =>
      (form.querySelector(`[data-field="${label}"]`) as HTMLInputElement | HTMLSelectElement)?.value ?? '';
    const why = form.querySelector('.why') as HTMLParagraphElement;
    const refuse = (text: string) => {
      why.textContent = text;
      why.hidden = false;
    };
    why.hidden = true;

    const startBar = Number(value('Bars'));
    const endBar = Number(value('to'));
    const name = value('Name').trim();
    const addTo = value('Add to');

    // Three refusals, because none of them can be fixed after the fact: an
    // exercise over silence scores 0% for ever, one the beat map cannot place
    // can never be played at all, and one that is really a section is a take.
    if (!Number.isInteger(startBar) || !Number.isInteger(endBar) || endBar < startBar) {
      return refuse('Those bars are the wrong way round.');
    }
    if (this.notesIn(startBar, endBar) === 0) {
      return refuse(
        `Bars ${startBar}-${endBar} have nothing written in them, so there is nothing to be graded on.`
      );
    }
    if (endBar - startBar + 1 > LONG_BARS) {
      return refuse(
        `That is ${endBar - startBar + 1} bars -- a section, not an exercise. ` +
          'A loop you cannot hold in your head is a take.'
      );
    }
    if (!addTo && !name) return refuse('It needs a name.');

    const section = song.sections.find((s) => s.start_bar === startBar && s.end_bar === endBar);
    const source: ExerciseSource = {
      slug: song.slug,
      ...(section ? { section: section.name } : {}),
      startBar,
      endBar,
      chartHash: this.chartHash(),
    };

    let exercise: Exercise;
    if (addTo) {
      // A second place to play the same figure from: the whole of the
      // many-to-many link, and one more entry in an array.
      const existing = this.file(addTo)?.exercise;
      if (!existing) return refuse('That exercise is gone.');
      const already = existing.sources.some(
        (s) => s.slug === source.slug && s.startBar === startBar && s.endBar === endBar
      );
      if (already) return refuse(`${existing.name} already has those bars.`);
      exercise = { ...existing, sources: [...existing.sources, source] };
    } else {
      exercise = {
        version: 1,
        id: uniqueId(name, this.files.map((f) => f.exercise.id)),
        name,
        kind: value('Kind') === 'groove' ? 'groove' : 'fill',
        restBars: Math.max(0, Number(value('Rest bars')) || 0),
        backing: value('Backing') === 'click' ? 'click' : 'record',
        sources: [source],
        createdAt: new Date().toISOString(),
        ...(value('Note').trim() ? { note: value('Note').trim() } : {}),
      };
    }

    try {
      await writeExercise(exercise);
    } catch (err) {
      return refuse(`Not written: ${(err as Error).message}`);
    }
    form.hidden = true;
    await this.reload();
    this.onStatus(
      addTo
        ? `${exercise.name} can now be played from bars ${startBar}-${endBar} of this song too.`
        : `Cut ${exercise.name} out of bars ${startBar}-${endBar}. Drill it from the list.`
    );
  }

  /** Throw one away, drills and all. The confirm says the history goes too. */
  async remove(id: string) {
    const file = this.file(id);
    if (!file) return;
    const drills = file.drills.length;
    const ok = window.confirm(
      `Delete ${file.exercise.name}?` +
        (drills ? ` Its ${drills} drill${drills > 1 ? 's' : ''} go with it.` : '')
    );
    if (!ok) return;
    try {
      await deleteExercise(id);
    } catch (err) {
      this.onStatus(`Not deleted: ${(err as Error).message}`, true);
      return;
    }
    if (this.open === id) this.open = undefined;
    this.practice.disarm();
    await this.reload();
    this.onStatus(`${file.exercise.name} is gone.`);
  }
}

/**
 * A guess at what a section is, for the form to open on.
 *
 * The names are the user's own, written while naming the notation, and the ones
 * they use for the bar that interrupts the groove are fairly consistent -- so a
 * short block called "into chorus" is a fill and a long one called "verse" is
 * not. Only ever a default; the picker is right there.
 */
function kindOf(section: { name: string; start_bar: number; end_bar: number } | undefined): Kind {
  if (!section) return 'fill';
  if (/fill|pickup|into |break|build/i.test(section.name)) return 'fill';
  return section.end_bar - section.start_bar + 1 > 2 ? 'groove' : 'fill';
}

/** Four squares in miniature: a shape to recognise, not numbers to read. */
function pips(squares: Square[]): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'pips';
  for (const square of squares) {
    const pip = document.createElement('i');
    const drill = square.drill;
    if (drill) pip.className = drill.accuracy >= PASS ? 'pass' : 'fail';
    wrap.appendChild(pip);
  }
  return wrap;
}

/**
 * One tempo's line across the sittings.
 *
 * The routine's own sparkline, on the same fixed 0-100% scale with the same
 * dotted threshold, because it answers the same question about a smaller thing.
 */
function trendCell(file: ExerciseFile, square: Square): HTMLTableCellElement {
  const td = document.createElement('td');
  td.className = 'trend';
  const series = rollingMedian(tempoSeries(file.drills, square.tempo));
  const points = series
    .map((value, i) => ({ value, i }))
    .filter((p): p is { value: number; i: number } => p.value !== undefined);
  if (points.length === 0) return td;

  const W = 54;
  const H = 18;
  const PAD = 2;
  const span = Math.max(1, series.length - 1);
  const x = (i: number) => (series.length < 2 ? W / 2 : PAD + (i / span) * (W - 2 * PAD));
  const y = (v: number) => H - PAD - Math.max(0, Math.min(1, v)) * (H - 2 * PAD);

  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));

  const mark = document.createElementNS(SVG, 'line');
  mark.setAttribute('x1', '0');
  mark.setAttribute('x2', String(W));
  mark.setAttribute('y1', String(y(PASS)));
  mark.setAttribute('y2', String(y(PASS)));
  mark.setAttribute('class', 'pass-line');
  svg.appendChild(mark);

  if (points.length > 1) {
    const line = document.createElementNS(SVG, 'polyline');
    line.setAttribute('points', points.map((p) => `${x(p.i)},${y(p.value)}`).join(' '));
    line.setAttribute('class', 'line');
    svg.appendChild(line);
  }
  const last = points[points.length - 1]!;
  const dot = document.createElementNS(SVG, 'circle');
  dot.setAttribute('cx', String(x(last.i)));
  dot.setAttribute('cy', String(y(last.value)));
  dot.setAttribute('r', '2.4');
  dot.setAttribute('class', 'dot');
  svg.appendChild(dot);

  td.classList.add(last.value >= PASS ? 'pass' : 'fail');
  td.appendChild(svg);
  return td;
}

// --- form bits ------------------------------------------------------------------------
// A label and a control, keyed by the label so `save` can read them back by the
// word on screen rather than by an id nobody sees.

function labelled(text_: string): HTMLLabelElement {
  const label = document.createElement('label');
  label.textContent = text_;
  return label;
}

function select(label: string, options: { value: string; label: string }[], value: string) {
  const input = document.createElement('select');
  input.dataset.field = label;
  for (const option of options) input.add(new Option(option.label, option.value));
  input.value = value;
  return { input, nodes: [labelled(label), input] };
}

function number(label: string, value: number) {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.dataset.field = label;
  input.value = String(value);
  return { input, nodes: [labelled(label), input] };
}

function text(label: string, value: string) {
  const input = document.createElement('input');
  input.type = 'text';
  input.dataset.field = label;
  input.value = value;
  return { input, nodes: [labelled(label), input] };
}
