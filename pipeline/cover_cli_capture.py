"""Cover commands: capture. Registered on `pipeline.cli.app` at import."""

from __future__ import annotations

import json
import shutil
import time
from pathlib import Path

import typer

from pipeline import cover
from pipeline import cover_capture as cap
from pipeline.cli import _fail, _resolve, app, console  # noqa: F401
from pipeline.cover_sync import camera_file
from pipeline.proc import StageError

PHONE_SETTINGS = "1080p at 60 fps, Auto FPS off, Lock Camera on, Enhanced Stabilization off"
PHONE_ROOM = "plugged in, Do Not Disturb on, at least 5 GB free (about 3 GB per 30 min at 1080p60)"

PREFLIGHT = [
    f"Both phones (main: side-front of you; foot: the right foot on the pedal): {PHONE_SETTINGS}",
    f"Both phones: {PHONE_ROOM}",
    "Live: the cover set is open, its tracks armed, and saved once",
    "TD-27 on, headphones on, the room quiet for the count-in",
]

INSTRUCTIONS = [
    "Start recording on BOTH phones now, before anything in Live. They run for the whole session.",
    "In Live, for every attempt: Stop twice (back to 1|1|1), then F9.",
    "In the count-in, play 4 hard quarter notes on the hi-hat -- the sync slate.",
    "A false start? Stop twice and F9 again. Every pass is kept.",
    "When you are done: Ctrl+S in Live, stop both phones, then press Enter here.",
]

PREFLIGHT_OBS = [
    f"Foot phone (the right foot on the pedal): {PHONE_SETTINGS}",
    f"Foot phone: {PHONE_ROOM}",
    "Live: the cover set is open, its tracks armed, and saved once",
    "TD-27 on, headphones on, the room quiet for the count-in",
]

INSTRUCTIONS_OBS = [
    "Start recording on the foot phone now. It and OBS run for the whole session.",
    "In Live, for every attempt: Stop twice (back to 1|1|1), then F9.",
    "In the count-in, play 4 hard quarter notes on the hi-hat -- the sync slate.",
    "A false start? Stop twice and F9 again. Every pass is kept.",
    "When you are done: Ctrl+S in Live, stop the foot phone, then press Enter here.",
]


def _setup_webcam(files: cap.ObsFiles) -> None:
    devices = cap.list_dshow_devices()
    cam = cap.find_webcam(devices)
    if cam is None:
        seen = ", ".join(f"{d.name} ({d.kind})" for d in devices) or "nothing"
        raise StageError(f"no webcam found (dshow sees: {seen}). Plug it in and run again.")
    cam_mic = cap.find_webcam_mic(cam, devices)
    mic = cap.resolve_mic(cam_mic.name if cam_mic else cap.PLACEHOLDER_MIC)
    cap.write_collection(files, cam, mic)
    console.print(f"[green]webcam[/green] {cam.name}  [green]mic[/green] {mic.name}")
    if cam_mic is None:
        console.print("[yellow]the webcam has no mic of its own; recording the MOTU's In 1-2[/yellow]")


def _obs_prepare(files: cap.ObsFiles, sess: cover.Session) -> str:
    """Write OBS's profile (recording into raw/) and make sure there is a scene; the websocket password."""
    cap.write_profile(files, sess.raw, cap.has_nvenc())
    if not files.collection.exists():
        cap.write_collection(files, None, cap.resolve_mic(cap.PLACEHOLDER_MIC))
        console.print("[yellow]no webcam set up yet; recording the MOTU mic only[/yellow]")
    return cap.enable_websocket(files)


def _obs_finish(files: cap.ObsFiles, sess: cover.Session, client, proc, user_choice) -> None:
    """Stop OBS's recording, keep it as raw/main.mp4, close OBS and give the user's choice back."""
    mkv = cap.stop_recording(client)
    console.print(f"stopped; waiting for OBS to remux {mkv.name}")
    mp4 = cap.wait_for_remux(mkv)
    dest = sess.raw / cap.MAIN_FILE
    aside = cap.keep_as(mp4, dest)
    info = cap.probe(dest)
    if aside:
        console.print(f"[yellow]an earlier {dest.name} was kept as {aside.name}[/yellow]")
    kinds = ", ".join(s["codec_type"] + ":" + s["codec_name"] for s in info["streams"])
    console.print(f"[green]{dest}[/green] ({float(info['format']['duration']):.1f} s; {kinds}); kept {mkv.name}")

    # A client still connected holds OBS's shutdown for 30 s on the websocket.
    client.disconnect()
    if not cap.close_obs():
        console.print("[yellow]OBS did not close; close it yourself (it will reopen on DrumCover next time)[/yellow]")
    else:
        proc.wait(timeout=10)
        cap.restore_user_choice(files.user_ini, user_choice)


@app.command("cover-take")
def cover_take(
    song: str = typer.Argument(None, help="Song slug or URL (not needed with --setup-webcam)"),
    name: str = typer.Option(None, "--name", help="Session name (default: the latest session)"),
    obs: bool = typer.Option(False, "--obs", help="Film the main camera with a webcam in OBS (raw/main.mp4) instead of the main phone"),
    setup_webcam: bool = typer.Option(False, "--setup-webcam", help="Find the webcam, put it in the OBS scene, open OBS to frame it"),
    midi_port: str = typer.Option(None, "--midi-port", help="MIDI input to log (default: the TD-27)"),
    minimized: bool = typer.Option(False, "--minimized", hidden=True, help="Start OBS in the tray (tests)"),
    stop_after: float = typer.Option(None, "--stop-after", hidden=True, help="Stop after N seconds instead of Enter (tests)"),
) -> None:
    """Record a session: the raw TD-27 MIDI log while both phones film; you press Enter when done."""
    files = cap.ObsFiles(cap.obs_config_dir())
    if (obs or setup_webcam) and cap.obs_running():
        _fail(StageError("OBS is open. Close it first -- cover-take writes its config and starts it itself."))

    if setup_webcam:
        try:
            _setup_webcam(files)
            cap.enable_websocket(files)
            cap.launch_obs()
        except StageError as exc:
            _fail(exc)
        console.print("OBS is open on the DrumCover scene. Frame the shot in the preview, then close OBS.")
        return

    if not song:
        raise typer.BadParameter("name a song (or use --setup-webcam)")
    try:
        sess = cover.session(_resolve(song), name)
    except StageError as exc:
        _fail(exc)
    sess.raw.mkdir(parents=True, exist_ok=True)

    console.print("[bold]Before you start[/bold]")
    for line in PREFLIGHT_OBS if obs else PREFLIGHT:
        console.print(f"  [ ] {line}")
    if not sess.als.exists():
        console.print(f"  [yellow]no Live set at {sess.als} -- the saved-set check will be skipped[/yellow]")

    # MIDI first, so it is listening before anything can be played.
    port = cap.pick_midi_port(cap.midi_input_names(), midi_port)
    if port is None and midi_port:
        _fail(StageError(f"no MIDI input matching {midi_port!r} (have: {', '.join(cap.midi_input_names())})"))
    if port is None:
        console.print("[yellow]no TD-27 MIDI input -- is the module on? The raw MIDI log is off.[/yellow]")

    user_choice = cap.read_user_choice(files.user_ini) if obs else None
    if obs:
        try:
            password = _obs_prepare(files, sess)
        except StageError as exc:
            _fail(exc)

    logger = cap.MidiLogger(port, sess.raw / cap.MIDI_LOG) if port else None
    if logger:
        logger.start()
    session_wall = time.time()
    perf, wall = time.perf_counter(), session_wall
    client = proc = None
    if obs:
        proc = cap.launch_obs(minimized=minimized)
        try:
            client = cap.connect(password)
            cap.start_recording(client, sess.raw)
            perf, wall = time.perf_counter(), time.time()
        except StageError as exc:
            if logger:
                logger.stop()
            _fail(exc)
    record = cap.capture_record(perf, wall, port, obs)
    (sess.raw / cap.CAPTURE_JSON).write_text(json.dumps(record, indent=2), encoding="utf-8")
    started = "OBS is recording" if obs else "The take has started"
    console.print(f"[green]{started}[/green]" + (f"; logging MIDI from {port}" if port else ""))

    console.print("\n[bold]Now[/bold]")
    for i, line in enumerate(INSTRUCTIONS_OBS if obs else INSTRUCTIONS, 1):
        console.print(f"  {i}. {line}")
    if stop_after is None:
        typer.prompt("\nPress Enter when you are done", default="", show_default=False)
    else:
        time.sleep(stop_after)

    if logger:
        logger.stop()
        console.print(f"MIDI: {logger.count} messages -> {logger.path.name}")
    if obs:
        try:
            _obs_finish(files, sess, client, proc, user_choice)
        except StageError as exc:
            _fail(exc)

    if sess.als.exists():
        saved = sess.als.stat().st_mtime
        last = logger.last_wall if logger and logger.last_wall else session_wall
        if saved < last:
            console.print(f"[red]{sess.als.name} was not saved after the last thing you played. Ctrl+S in Live now.[/red]")
        else:
            console.print(f"[green]{sess.als.name} saved after the last attempt[/green]")
    if sess.toml.exists():
        sess.update("capture", {"obs": obs, "midi_log": cap.MIDI_LOG if logger else None, "recorded_at": wall})
    if not obs:
        console.print(f"Next: `drums cover-import {sess.song.slug} --as main`, then the same `--as foot`, one phone at a time.")


def _report(dest: Path, role: str, raw: Path) -> None:
    """What landed in raw/: size, rotation, frame rate, length -- and what looks wrong."""
    check = cap.check_video(dest)
    console.print(f"[green]{dest}[/green]: {check.summary()}")
    for warning in check.warnings():
        console.print(f"[yellow]  {warning}[/yellow]")
    other = camera_file(raw, next(r for r in cover.CAMERAS if r != role))
    if other is not None and other.stat().st_size == dest.stat().st_size:
        console.print(f"[yellow]  it is the same size as {other.name}: the same video twice? Was the other phone plugged in?[/yellow]")


@app.command("cover-import")
def cover_import(
    song: str = typer.Argument(..., help="Song slug or URL"),
    role: str = typer.Option(..., "--as", help="main or foot: which phone this is"),
    name: str = typer.Option(None, "--name", help="Session name (default: the latest session)"),
    file: Path = typer.Option(None, "--file", help="Copy this file instead of reading the phone"),
    force: bool = typer.Option(False, "--force", help="Replace a main.* / foot.* already in raw/"),
) -> None:
    """Copy the newest video off the USB-connected iPhone into raw/main.* or raw/foot.*, and check it."""
    if role not in cover.CAMERAS:
        raise typer.BadParameter(f"--as is one of {', '.join(cover.CAMERAS)}, not {role!r}")
    try:
        sess = cover.session(_resolve(song), name)
    except StageError as exc:
        _fail(exc)
    sess.raw.mkdir(parents=True, exist_ok=True)
    existing = camera_file(sess.raw, role)
    if existing and not force:
        _fail(StageError(f"{existing} is already there; --force to replace it"))

    if file is not None:
        if not file.exists():
            _fail(StageError(f"no such file: {file}"))
        dest = cap.role_target(sess.raw, role, file.suffix)
        if existing:
            existing.unlink()
        console.print(f"copying {file} ...")
        shutil.copy2(file, dest)
    else:
        listing = cap.phone_videos()
        item = None if "error" in listing else cap.newest_video(listing.get("items", []))
        if item is None:
            why = listing.get("error") or "no videos in the phone's DCIM"
            console.print(f"[red]{why}[/red]")
            console.print("Copy the video by hand (Photos app or Explorer) into:")
            console.print(f"  {sess.raw}")
            console.print(f"and name it {role}.mov -- or run again with --file <path>.")
            raise typer.Exit(code=1)
        size_gb = item["size"] / 1e9
        console.print(f"{listing['phone']} as {role}: {item['folder']}/{item['filename']} ({size_gb:.2f} GB, {item['modified']})")
        try:
            copied = cap.copy_from_phone(item, sess.raw)
        except StageError as exc:
            _fail(exc)
        dest = cap.role_target(sess.raw, role, copied.suffix)
        if existing:
            existing.unlink()
        copied.rename(dest)

    try:
        _report(dest, role, sess.raw)
    except StageError as exc:
        _fail(exc)
