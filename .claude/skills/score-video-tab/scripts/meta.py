"""Print what step 1 needs from a score video's metadata, and its channel file.

Reads the JSON that `yt-dlp -J` saved: the title, the channel and its handle,
the length, the description (difficulty and technique list), and whether the
channel has a file in references/channels/. Prints as UTF-8, since channel
names are often Korean and the Windows console's cp1252 cannot print them.

usage: python -I meta.py <meta.json>
"""

import json
import sys
from pathlib import Path

CHANNELS = Path(__file__).resolve().parent.parent / "references" / "channels"


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    m = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    handle = (m.get("uploader_id") or "").lstrip("@").lower()
    ch = CHANNELS / f"{handle}.md"
    print(f"title     {m.get('title')}")
    print(f"channel   {m.get('channel')} ({m.get('uploader_id')}, {m.get('channel_id')})")
    print(f"duration  {m.get('duration')} s")
    has_137 = any(f.get("format_id") == "137" for f in m.get("formats", []))
    print("format    " + ("137 (1080p H.264) is offered" if has_137 else 'no 137: use -f "bv*[height=1080]"'))
    print(f"channel file  {ch if ch.exists() else f'none ({ch.name}): a new channel, see step 1'}")
    print()
    print(m.get("description") or "")


if __name__ == "__main__":
    main()
