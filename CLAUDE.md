# Working in this repo

## This is an active, single-user work in progress

Nothing is deployed. Nobody else has a checkout. The data under `songs/`,
`exercises/` and `kit/` belongs to this one machine.

**So there is no backward compatibility to keep, and no migrations to write.**
When a file format changes, change it and regenerate the files. Do not add a
`version` union, a compat branch, an optional field that is only optional for
old data, or a reader that upgrades a file on write. Do not keep a code path
alive for data that no longer exists on disk — check whether it does.

That is not a style preference. On 2026-09-20 the exercise format's version-1
path — a `1 | 2` union, an optional `chart`, nine fallbacks across five files
and a whole "orphan exercise" UI state — was supporting exactly zero files,
because the only exercise on disk was version 2. It all came out and nothing
changed.

**The one exception is `songs/*/takes/`.** A take is a record of what was
actually played. It cannot be regenerated, it is never rewritten, and its older
shapes are tolerated on read — see the rules at the top of `app/src/take.ts`.
Everything else is derived and can be rebuilt: `grid.lock.json`,
`sticking.lock.json`, `reference.lock.json`, `tab.mid` (from the Ableton set),
`exercise.json`, and `kit/samples/` (`npm run bake-kit`).

## Where things are written down

Keep these current as part of the work, not afterwards.

- **`README.md` → "Where things stand"** is the authoritative status log: a
  running narrative with a "things learned" list per step.
- **`handoff.md`** is where the build stands against the plan, and §5 holds the
  working ground rules.
- **`practice-plan.md`, `avatar-plan.md`** are the *reasoning* — requirements
  interviews for milestones, some still unbuilt. Not status. Do not edit their
  Q&A rounds to match today; they are a record of what was decided and why.

## Two greps that lie

Before deleting anything that looks unreferenced, note that some names are built
rather than written:

- `app/src/routine.ts` builds `/practice/routines` as `` `${ROUTE}s` ``, so a
  grep for the plural finds nothing although the handler is live.
- `app/src/main.ts` builds fader element ids as `` `fader-${f}` ``, so
  `#fader-drums` and friends in `index.html` look orphaned and are not.

## Verifying

- Python: `.venv/Scripts/python -m pytest -q tests`.
- App: `npm run typecheck` and `npm test` in `app/`.
- The browser: the `npm run check-*` scripts in `app/` drive a real Chrome
  (Playwright's bundled Chromium has no H.264/AAC decoders). Start
  `npx vite --port 5173 --strictPort` from `app/` first, warm it with one
  request — vite pre-bundles on the first load and reloads mid-test — and kill
  the server when done.
- Starting the dev server makes the Ableton plugin rewrite
  `songs/<slug>/tab.mid` from the `.als`, which shows up as a modified file in
  `git status`. That is expected, not a change you made.

## Commits

Write the commit message out in the message to the user. Do not stage and do not
commit — that is the user's to do.
