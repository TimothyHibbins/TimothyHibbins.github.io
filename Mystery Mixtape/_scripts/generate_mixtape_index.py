#!/usr/bin/env python3
"""Generate mixtapes/index.json by scanning numbered tape folders.

Usage:
  python3 _scripts/generate_mixtape_index.py
"""

from __future__ import annotations

import json
import re
from pathlib import Path


TAPE_DIR_RE = re.compile(r"^tape\s+(\d+)\s*$", re.IGNORECASE)


def main() -> None:
    project_root = Path(__file__).resolve().parents[1]
    mixtapes_dir = project_root / "mixtapes"
    index_path = mixtapes_dir / "index.json"

    packs: list[tuple[int, dict[str, str]]] = []
    for child in mixtapes_dir.iterdir():
        if not child.is_dir():
            continue

        match = TAPE_DIR_RE.match(child.name)
        if not match:
            continue

        tape_number = int(match.group(1))
        patch_index = child / "data" / "daily-puzzles.patch.json"
        full_index = child / "data" / "daily-puzzles.json"
        if not patch_index.is_file() and not full_index.is_file():
            continue

        packs.append((
            tape_number,
            {
                "slug": f"tape {tape_number}",
                "label": f"Tape {tape_number}"
            }
        ))

    packs.sort(key=lambda item: item[0])
    payload = {
        "default": packs[0][1]["slug"] if packs else "",
        "packs": [pack for _, pack in packs]
    }

    index_path.write_text(json.dumps(payload, indent=4) + "\n", encoding="utf-8")
    print(f"Wrote {index_path} with {len(packs)} packs")


if __name__ == "__main__":
    main()
