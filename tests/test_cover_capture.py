import configparser
import json

import pytest

from pipeline import cover_capture as cap

FFMPEG_DEVICES = """\
[in#0 @ 000001] "OBS Virtual Camera" (none)
[in#0 @ 000001]   Alternative name "@device_sw_{860BB310-5D01-11D0-BD3B-00A0C911CE86}\\{A3FCE0F5-3493-419F-958A-ABA1250EC20B}"
[in#0 @ 000001] "HD Pro Webcam C920" (video)
[in#0 @ 000001]   Alternative name "@device_pnp_\\\\?\\usb#vid_046d&pid_082d&mi_00#7&1b2c3d&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global"
[in#0 @ 000001] "In 1-2 (MOTU M Series)" (audio)
[in#0 @ 000001]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{3AAD4D2D-18BB-4528-9FCE-784E2987C7F9}"
[in#0 @ 000001] "Microphone (HD Pro Webcam C920)" (audio)
[in#0 @ 000001]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{11111111-2222-3333-4444-555555555555}"
Error opening input file dummy.
"""

MIC = cap.Mic("In 1-2 (MOTU M Series)", "{0.0.1.00000000}.{3aad4d2d-18bb-4528-9fce-784e2987c7f9}")


def test_dshow_parsing_and_webcam_pick():
    devices = cap.parse_dshow_devices(FFMPEG_DEVICES)
    assert [(d.name, d.kind) for d in devices] == [
        ("OBS Virtual Camera", "none"),
        ("HD Pro Webcam C920", "video"),
        ("In 1-2 (MOTU M Series)", "audio"),
        ("Microphone (HD Pro Webcam C920)", "audio"),
    ]
    cam = cap.find_webcam(devices)
    assert cam.name == "HD Pro Webcam C920"
    assert cam.path.startswith("\\\\?\\usb#vid_046d") and cam.path.endswith("\\global")
    assert cap.find_webcam_mic(cam, devices).name == "Microphone (HD Pro Webcam C920)"


def test_no_webcam_when_only_the_virtual_camera():
    devices = cap.parse_dshow_devices(FFMPEG_DEVICES.split('[in#0 @ 000001] "HD Pro')[0])
    assert cap.find_webcam(devices) is None


def test_profile_ini(tmp_path):
    files = cap.ObsFiles(tmp_path / "obs-studio")
    raw = tmp_path / "songs" / "x" / "covers" / "dev" / "raw"
    cap.write_profile(files, raw, nvenc=True)
    ini = configparser.ConfigParser(interpolation=None)
    ini.optionxform = str
    ini.read(files.basic_ini, encoding="utf-8-sig")
    assert ini["General"]["Name"] == "DrumCover"
    assert ini["Output"]["Mode"] == "Advanced"
    adv = ini["AdvOut"]
    assert adv["RecFilePath"] == str(raw).replace("\\", "/")
    assert adv["RecFormat2"] == "mkv" and adv["RecEncoder"] == "obs_nvenc_h264_tex"
    video = ini["Video"]
    assert (video["BaseCX"], video["OutputCY"], video["FPSInt"], video["FPSType"]) == ("1920", "1080", "30", "1")
    assert video["AutoRemux"] == "true"
    assert ini["Audio"]["SampleRate"] == "48000"
    enc = json.loads(files.record_encoder.read_text(encoding="utf-8"))
    assert enc["rate_control"] == "CQP" and enc["cqp"] == 18
    cap.write_profile(files, raw, nvenc=False)
    assert json.loads(files.record_encoder.read_text(encoding="utf-8"))["crf"] == 18


def test_scene_collection_without_and_with_webcam(tmp_path):
    files = cap.ObsFiles(tmp_path)
    cap.write_collection(files, None, MIC)
    data = json.loads(files.collection.read_text(encoding="utf-8"))
    by_id = {s["id"]: s for s in data["sources"]}
    assert set(by_id) == {"wasapi_input_capture", "scene"}
    assert by_id["wasapi_input_capture"]["settings"]["device_id"] == MIC.endpoint
    assert by_id["wasapi_input_capture"]["mixers"] == 1
    assert "DesktopAudioDevice1" not in data  # no headphone mix in the camera audio
    assert data["current_scene"] == cap.SCENE

    cam = cap.find_webcam(cap.parse_dshow_devices(FFMPEG_DEVICES))
    data = cap.scene_collection(cam, MIC)
    by_id = {s["id"]: s for s in data["sources"]}
    dshow = by_id["dshow_input"]["settings"]
    assert dshow["video_device_id"] == f"HD Pro Webcam C920:{cam.path}"
    assert dshow["resolution"] == "1920x1080" and dshow["frame_interval"] == 333333
    items = by_id["scene"]["settings"]["items"]
    assert [i["source_uuid"] for i in items] == [by_id["dshow_input"]["uuid"], by_id["wasapi_input_capture"]["uuid"]]


def test_websocket_keeps_an_existing_password(tmp_path):
    files = cap.ObsFiles(tmp_path)
    files.websocket.parent.mkdir(parents=True)
    files.websocket.write_text(json.dumps({"server_enabled": False, "server_password": "abc", "auth_required": True}))
    assert cap.enable_websocket(files) == "abc"
    cfg = json.loads(files.websocket.read_text())
    assert cfg["server_enabled"] is True and cfg["server_port"] == 4455
    assert cap.websocket_password(files) == "abc"


def test_websocket_generates_a_password(tmp_path):
    files = cap.ObsFiles(tmp_path)
    password = cap.enable_websocket(files)
    assert len(password) >= 12 and cap.websocket_password(files) == password


def test_user_ini_choice_is_restored(tmp_path):
    ini = tmp_path / "user.ini"
    before = "﻿[General]\r\nFirstRun=true\r\n\r\n[Basic]\r\nProfile=Untitled\r\nProfileDir=Untitled\r\nSceneCollection=Untitled\r\nSceneCollectionFile=Untitled.json\r\nConfigOnNewProfile=true\r\n"
    ini.write_bytes(before.encode("utf-8"))
    choice = cap.read_user_choice(ini)
    assert choice["Profile"] == "Untitled" and choice["SceneCollectionFile"] == "Untitled.json"
    ini.write_bytes(before.replace("=Untitled", "=DrumCover").encode("utf-8"))
    assert cap.restore_user_choice(ini, choice)
    assert ini.read_bytes() == before.encode("utf-8")
    assert not cap.restore_user_choice(ini, choice)


def test_midi_log_record():
    rec = cap.midi_log_record([0x99, 38, 112], perf=1234.5678901, wall=1761475200.1234567)
    assert rec == {
        "perf": 1234.56789,
        "wall": 1761475200.123457,
        "bytes": [153, 38, 112],
        "type": "note_on",
        "channel": 9,
        "note": 38,
        "velocity": 112,
    }
    line = json.dumps(rec)
    assert "\n" not in line and json.loads(line)["note"] == 38
    assert cap.midi_log_record([0xB9, 4, 90], 0.0, 0.0)["control"] == 4  # hi-hat pedal CC4


def test_pick_midi_port():
    names = ["MOTU M Series MIDI In 0", "TD-27 1"]
    assert cap.pick_midi_port(names) == "TD-27 1"
    assert cap.pick_midi_port(names, "motu") == "MOTU M Series MIDI In 0"
    assert cap.pick_midi_port(["MOTU M Series MIDI In 0"]) is None


def test_newest_video():
    items = [
        {"folder": "100APPLE", "name": "IMG_0001", "filename": "IMG_0001.HEIC", "modified": "2026-10-26T10:00:00"},
        {"folder": "100APPLE", "name": "IMG_0002", "filename": "IMG_0002.MOV", "modified": "2026-10-26T11:00:00"},
        {"folder": "101APPLE", "name": "IMG_0003", "filename": "IMG_0003.MOV", "modified": "2026-10-26T12:00:00"},
        {"folder": "101APPLE", "name": "IMG_0004", "filename": "IMG_0004.JPG", "modified": "2026-10-26T13:00:00"},
    ]
    assert cap.newest_video(items)["name"] == "IMG_0003"
    assert cap.newest_video(items[:1]) is None


def test_several_phones_are_refused():
    answer = cap.explain({"error": "several", "phones": ["Apple iPhone", "Apple iPhone"]})
    assert answer["error"].endswith(cap.ONE_AT_A_TIME)
    assert "2 iPhones" in answer["error"]
    assert cap.explain({"phone": "Apple iPhone", "items": []}) == {"phone": "Apple iPhone", "items": []}


def test_role_target(tmp_path):
    assert cap.role_target(tmp_path, "foot", ".MOV") == tmp_path / "foot.mov"
    assert cap.role_target(tmp_path, "main", "") == tmp_path / "main.mov"


IPHONE_STREAM = {"codec_name": "hevc", "width": 1920, "height": 1080, "r_frame_rate": "60/1",
                 "avg_frame_rate": "60/1", "side_data_list": [{"rotation": -90}]}  # fmt: skip


def test_video_check_an_upright_60fps_phone():
    pts = [k / 60 for k in range(600)]
    check = cap.video_check(IPHONE_STREAM, 10.0, pts)
    assert (check.width, check.height, check.rotation) == (1080, 1920, -90)
    assert check.vertical and check.fps == pytest.approx(60.0)
    assert check.irregular == 0.0 and check.warnings() == []
    assert "1080x1920 upright" in check.summary()


def test_video_check_warns_on_30fps_landscape_and_uneven_frames():
    flat = {**IPHONE_STREAM, "side_data_list": []}
    check = cap.video_check(flat, 10.0, [k / 30 for k in range(300)])
    text = " ".join(check.warnings())
    assert "not vertical" in text and "30.00 fps, not 60" in text
    # Auto FPS: a stretch at 30 among 60
    pts = [k / 60 for k in range(300)] + [5 + k / 30 for k in range(1, 60)]
    check = cap.video_check(IPHONE_STREAM, 7.0, pts)
    assert check.fps == pytest.approx(60.0)
    assert any("Auto FPS" in w for w in check.warnings())


def test_check_video_reads_a_real_rotated_file(tmp_path):
    import subprocess

    flat, phone = tmp_path / "flat.mov", tmp_path / "phone.mov"
    run = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    subprocess.run([*run, "-f", "lavfi", "-i", "testsrc2=s=180x320:r=60:d=2", "-vf", "transpose=2",
                    "-c:v", "libx265", "-tag:v", "hvc1", "-x265-params", "log-level=error", str(flat)], check=True)  # fmt: skip
    subprocess.run([*run, "-display_rotation", "-90", "-i", str(flat), "-c", "copy", str(phone)], check=True)
    check = cap.check_video(phone)
    assert (check.width, check.height, check.rotation, check.codec) == (180, 320, -90, "hevc")
    assert check.fps == pytest.approx(60.0, abs=0.01) and check.warnings() == []
    assert check.duration_s == pytest.approx(2.0, abs=0.05)
