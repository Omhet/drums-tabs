// The exercise panels: the song's list, the cutting form, the ladder, the pool.
//
// This file renders and nothing else. It reads the pool off disk, draws it, and
// hands `Practice` an exercise to aim at -- it owns no MIDI, no clock and no
// grading, all of which live in practice.ts where the kit is. The split is the
// same one `routine.ts` and `practice.ts` already have, one layer up.
import type { SongMeta } from 'virtual:songs';
import type { ChartHit } from './chart';
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
  type Backing,
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
  /** The pool, which takes over the stage. */
  pool: HTMLElement;
  /** The armed exercise's ladder, in the desk. */
  ladder: HTMLElement;
  drillState: HTMLOutputElement;
  /** What the loop plays under the open exercise, for this sitting. */
  against: HTMLSelectElement;
  againstRow: HTMLElement;
  back: HTMLButtonElement;
  /** Throw the open exercise away from the page that is showing it. */
  kill: HTMLButtonElement;
}

export class Exercises {
  /** The whole pool, re-read whenever it changes on disk. */
  private files: ExerciseFile[] = [];
  private song: SongMeta | undefined;
  /** Whether the open one is being played on its own notes rather than a record. */
  private standaloneOpen = false;
  /**
   * What each exercise is being played against this session.
   *
   * Not written back to the file, for the same reason the tempo is not: which
   * rung you are on and what you have under you are facts about this sitting.
   */
  private readonly against = new Map<string, Backing>();
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
    private readonly chartHash: () => string,
    /**
     * Open an exercise again through the router.
     *
     * Changing what it plays against can mean loading a song that is not on
     * screen, or letting one go -- which is the router's job, and doing it any
     * other way would be a second way in to the same decision.
     */
    private readonly reopen: (id: string) => void = () => {}
  ) {
    el.cut.addEventListener('click', () => this.toggleForm());
    el.kill.addEventListener('click', () => {
      if (this.open) void this.remove(this.open);
    });
    el.against.addEventListener('change', () => {
      const id = this.open;
      if (!id) return;
      this.against.set(id, parseBackingChoice(el.against.value));
      // Through the router, because switching to a record may mean loading a
      // song that is not on screen -- and that is one code path already.
      this.reopen(id);
    });
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

  /** The exercise itself, for the router to decide how to open it. */
  exerciseOf(id: string): Exercise | undefined {
    return this.file(id)?.exercise;
  }

  /**
   * What the open exercise is being played against: this sitting's choice, or
   * what the file says.
   */
  backingOf(id: string): Backing {
    const ex = this.exerciseOf(id);
    const chosen = this.against.get(id) ?? ex?.backing ?? 'record';
    // A choice the exercise cannot honour is not a choice: without a song
    // still in `songs/` it cannot use the record, and its own notes -- which
    // every exercise has -- are the only thing left.
    if (chosen !== 'kit' && !this.playableSources(id).length) return ex ? 'kit' : chosen;
    return chosen;
  }

  private playableSources(id: string): ExerciseSource[] {
    const ex = this.exerciseOf(id);
    return (ex?.sources ?? []).filter((source) => this.songs.some((s) => s.slug === source.slug));
  }

  /**
   * Whether this one wants to be played on its own rather than against a
   * record.
   *
   * An exercise whose song has been deleted is still perfectly playable now,
   * which is new, and is the clearest single thing carrying its own notes
   * bought it.
   */
  standalone(id: string): boolean {
    return this.backingOf(id) === 'kit';
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
   * first if it is not the one on screen -- or nothing, when it is being played
   * on its own notes and there is no song to load.
   */
  arm(id: string, opts: { tempo?: number; standalone?: boolean } = {}): ExerciseSource | undefined {
    const file = this.file(id);
    if (!file) {
      this.onStatus(`No exercise called ${id}.`, true);
      return undefined;
    }
    const source = opts.standalone ? undefined : sourceFor(file.exercise, this.song?.slug);
    if (!source && !opts.standalone) {
      this.onStatus(`${file.exercise.name} has no source to play it from.`, true);
      return undefined;
    }
    const at = opts.tempo ?? nextSquare(ladder(file.drills));
    this.open = id;
    this.standaloneOpen = !!opts.standalone;
    this.practice.armExercise(file.exercise, source, at, this.backingOf(id));
    this.drawLadder(id);
    return source;
  }

  /**
   * What this exercise can be played against, and which of them it is on.
   *
   * Only the ones it can honour: the kit needs notes of its own and the record
   * needs a song still in `songs/`. With one option there is no choice to
   * make, and the row goes away rather than sitting there as a decision you do
   * not have.
   */
  private drawAgainst(id: string) {
    const ex = this.exerciseOf(id);
    const select = this.el.against;
    select.replaceChildren();
    if (!ex) return;
    const options: { value: Backing; label: string }[] = [];
    options.push({ value: 'kit', label: 'its own notes' });
    if (this.playableSources(id).length) {
      options.push({ value: 'record', label: 'the record' });
      options.push({ value: 'click', label: 'click only' });
    }
    for (const option of options) select.add(new Option(option.label, option.value));
    select.value = this.backingOf(id);
    this.el.againstRow.hidden = options.length < 2;
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
    const source = this.standaloneOpen ? undefined : sourceFor(file.exercise, this.song?.slug);
    const bars = file.exercise.chart.bars;

    // Bar numbers belong to a song. Played on its own it is a length, which is
    // the true thing to say about three bars that came from nowhere in
    // particular.
    const where = source
      ? `bars ${source.startBar}-${source.endBar}`
      : bars
        ? `${bars} bar${bars > 1 ? 's' : ''} of its own`
        : '';
    this.el.drillState.textContent = where
      ? `${file.exercise.name} · ${where}` +
        (file.exercise.restBars
          ? ` · ${file.exercise.restBars} bar${file.exercise.restBars > 1 ? 's' : ''} of rest`
          : ' · no rest') +
        (file.exercise.backing === 'click' ? ' · click only' : '')
      : file.exercise.name;
    this.el.drillState.title = file.exercise.note ?? '';
    this.drawAgainst(id);

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
      // Picking a rung must not change which timeline it is on: whatever the
      // route decided when it opened this exercise still holds.
      button.addEventListener('click', () =>
        this.arm(id, { tempo: square.tempo, standalone: this.standaloneOpen })
      );
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
    button.className = 'ex-open';
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
    return this.wrap(exercise, button);
  }

  /**
   * A row and the one thing you can do to it that is not opening it.
   *
   * Both lists draw the same pair, because throwing an exercise away is the
   * same act wherever you are standing when you decide it -- and until this
   * existed there was no way to do it at all outside the headless checks.
   */
  private wrap(exercise: Exercise, open: HTMLButtonElement): HTMLElement {
    const row = document.createElement('div');
    row.className = 'ex';
    const kill = document.createElement('button');
    kill.className = 'ex-kill';
    kill.type = 'button';
    kill.dataset.id = exercise.id;
    kill.textContent = '✕';
    kill.title = `Delete ${exercise.name}, drills and all`;
    kill.setAttribute('aria-label', `Delete ${exercise.name}`);
    kill.addEventListener('click', (e) => {
      // The row is not a button any more, but the open half still is and a
      // stray bubble would arm what you just asked to throw away.
      e.stopPropagation();
      void this.remove(exercise.id);
    });
    row.append(open, kill);
    return row;
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
    button.className = 'ex-open';

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
    // What it can be played against, which is a different question from what
    // it is: an exercise with its own notes always has an answer.
    const against = ex.sources
      .filter((source) => this.songs.some((song) => song.slug === source.slug))
      .map((source) => `${this.title(source.slug)} ${source.startBar}-${source.endBar}`);
    against.unshift(`${ex.chart.bars} bar${ex.chart.bars > 1 ? 's' : ''} of its own`);
    where.textContent = against.join(' · ');

    button.append(left, where, pips(ladder(file.drills)));
    button.addEventListener('click', () => this.goTo(`#exercise/${ex.id}`));
    return this.wrap(ex, button);
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
    // The kit first and by default: it is the only one of the three that needs
    // no song, so it is the one that makes the exercise a thing of its own.
    const backing = select(
      'Backing',
      [
        { value: 'kit', label: 'its own notes' },
        { value: 'record', label: 'the record' },
        { value: 'click', label: 'click only' },
      ],
      'kit'
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

    // The notes themselves, re-based so the exercise's first bar is bar 1.
    // This is the whole of the cut now: what is written down is a small score,
    // and the song it came off is a place it can also be played.
    const chart = await this.practice.chartFor(startBar, endBar);
    if (!chart) return refuse('No beat map, so those bars cannot be placed in time.');

    let exercise: Exercise;
    let differs = 0;
    if (addTo) {
      // A second place to play the same figure from: the whole of the
      // many-to-many link, and one more entry in an array.
      const existing = this.file(addTo)?.exercise;
      if (!existing) return refuse('That exercise is gone.');
      const already = existing.sources.some(
        (s) => s.slug === source.slug && s.startBar === startBar && s.endBar === endBar
      );
      if (already) return refuse(`${existing.name} already has those bars.`);
      // Now that an exercise has notes of its own, "this is the same figure"
      // is a claim that can be checked. A warning and never a refusal, for the
      // same reason `chartHash` warns and never refuses: the same lick played
      // a little differently in another song is still the same exercise.
      differs = countDifferences(existing.chart.hits, chart.hits);
      exercise = {
        ...existing,
        sources: [...existing.sources, source],
      };
    } else {
      exercise = {
        version: 2,
        id: uniqueId(name, this.files.map((f) => f.exercise.id)),
        name,
        kind: value('Kind') === 'groove' ? 'groove' : 'fill',
        restBars: Math.max(0, Number(value('Rest bars')) || 0),
        backing: parseBackingChoice(value('Backing')),
        chart,
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
    if (differs) {
      this.onStatus(
        `Those bars are not quite the same figure -- ${differs} note${differs > 1 ? 's' : ''} differ. ` +
          `Added to ${exercise.name} as a second source anyway.`
      );
      return;
    }
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
    if (this.open === id) {
      this.open = undefined;
      // You were standing on its page; the pool is what is there instead.
      if (location.hash.startsWith('#exercise/')) this.goTo('#exercises');
    }
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
/** The three the form offers, defaulting to the one that needs no song. */
function parseBackingChoice(value: string): Backing {
  return value === 'click' || value === 'record' ? value : 'kit';
}

/**
 * How many notes two cuts disagree about.
 *
 * Nothing when either side has no notes to compare -- an exercise cut before
 * the notes moved into the file has nothing to be measured against, and
 * inventing a difference would be worse than saying nothing.
 */
function countDifferences(a: readonly ChartHit[], b: readonly ChartHit[]): number {
  if (a.length === 0) return 0;
  const spell = (h: ChartHit) => `${h.slot}:${h.instrument}`;
  const left = new Set(a.map(spell));
  const right = new Set(b.map(spell));
  let differs = 0;
  for (const k of left) if (!right.has(k)) differs++;
  for (const k of right) if (!left.has(k)) differs++;
  return differs;
}

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
