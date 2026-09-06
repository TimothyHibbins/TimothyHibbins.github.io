#!/usr/bin/env python3
"""Build Mystery Mixtape assets from a creator export job JSON.

Usage:
  python3 _scripts/build_mixtape.py --job /path/to/job.json
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class SongJob:
    title: str
    artist: str
    source_file_name: str
    start_sec: int
    link: str = ""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build Mystery Mixtape clips and puzzle JSON")
    parser.add_argument("--job", required=True, help="Path to exported job JSON")
    parser.add_argument(
        "--project-root",
        default=str(Path(__file__).resolve().parents[1]),
        help="Path to Mystery Mixtape project root"
    )
    parser.add_argument(
        "--source-dir",
        default="",
        help="Directory containing source audio files referenced by sourceFileName"
    )
    return parser.parse_args()


def ensure_ffmpeg_available() -> None:
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg is required but was not found in PATH.")


def load_job(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))

    required = ["date", "theme", "songs"]
    for key in required:
        if key not in payload:
            raise ValueError(f"Job file missing required field: {key}")

    songs = payload["songs"]
    if not isinstance(songs, list) or len(songs) != 6:
        raise ValueError("Job must contain exactly six songs.")

    return payload


def parse_songs(raw_songs: list[dict[str, Any]]) -> list[SongJob]:
    parsed: list[SongJob] = []
    for idx, song in enumerate(raw_songs, start=1):
        try:
            title = str(song["title"]).strip()
            artist = str(song["artist"]).strip()
            source_file_name = str(song["sourceFileName"]).strip()
            start_sec = int(song["startSec"])
            link = str(song.get("link") or song.get("songLink") or "").strip()
        except KeyError as exc:
            raise ValueError(f"Song {idx} missing field {exc}") from exc

        if not title or not artist or not source_file_name:
            raise ValueError(f"Song {idx} requires title, artist, and sourceFileName")
        if start_sec < 0:
            raise ValueError(f"Song {idx} startSec must be >= 0")

        parsed.append(SongJob(title=title, artist=artist, source_file_name=source_file_name, start_sec=start_sec, link=link))

    return parsed


def resolve_source_audio(source_dir: Path, source_file_name: str) -> Path:
    source_path = (source_dir / source_file_name).resolve()
    if not source_path.exists() or not source_path.is_file():
        raise FileNotFoundError(
            f"Source file not found: {source_path} (from sourceFileName={source_file_name})"
        )
    return source_path


def trim_clip(source_path: Path, target_path: Path, start_sec: int, clip_length_sec: int = 10) -> None:
    command = [
        "ffmpeg",
        "-y",
        "-ss",
        str(start_sec),
        "-i",
        str(source_path),
        "-t",
        str(clip_length_sec),
        "-vn",
        "-acodec",
        "libmp3lame",
        "-q:a",
        "4",
        str(target_path),
    ]

    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed for {source_path.name}: {result.stderr.strip()}")


def combine_clips(clip_paths: list[Path], output_path: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="mystery_mixtape_concat_") as tmp_dir_name:
        concat_path = Path(tmp_dir_name) / "concat_list.txt"
        lines = []
        for clip_path in clip_paths:
            safe_path = str(clip_path.resolve()).replace("'", "'\\''")
            lines.append(f"file '{safe_path}'")

        concat_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

        command = [
            "ffmpeg",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_path),
            "-c",
            "copy",
            str(output_path),
        ]

        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg concat failed: {result.stderr.strip()}")


def write_puzzle_json(project_root: Path, job: dict[str, Any], songs: list[SongJob], clip_paths: list[str]) -> Path:
    date_key = str(job["date"])
    aliases = job.get("aliases")
    if not isinstance(aliases, list):
        aliases = []

    puzzle = {
        "date": date_key,
        "clue": str(job.get("clue") or job.get("themeClue") or ""),
        "clueAskBold": str(job.get("clueAskBold") or job.get("themeClueAsk") or "").strip(),
        "theme": str(job["theme"]),
        "aliases": [str(alias) for alias in aliases],
        "songs": [
            {
                "title": song.title,
                "artist": song.artist,
                "link": song.link,
                "clipSrc": clip_path,
                "hint": ""
            }
            for song, clip_path in zip(songs, clip_paths)
        ]
    }

    puzzle_dir = project_root / "data" / "puzzles"
    puzzle_dir.mkdir(parents=True, exist_ok=True)
    puzzle_path = puzzle_dir / f"{date_key}.json"
    puzzle_path.write_text(json.dumps(puzzle, indent=2), encoding="utf-8")
    return puzzle_path


def update_daily_index(project_root: Path, date_key: str, puzzle_rel_path: str) -> Path:
    index_path = project_root / "data" / "daily-puzzles.json"
    if index_path.exists():
        index_payload = json.loads(index_path.read_text(encoding="utf-8"))
    else:
        index_payload = {"timezone": "Australia/Melbourne", "puzzles": {}}

    if "puzzles" not in index_payload or not isinstance(index_payload["puzzles"], dict):
        index_payload["puzzles"] = {}

    index_payload["puzzles"][date_key] = puzzle_rel_path
    if "fallback" not in index_payload:
        index_payload["fallback"] = puzzle_rel_path

    index_path.write_text(json.dumps(index_payload, indent=2), encoding="utf-8")
    return index_path


def main() -> None:
    args = parse_args()
    ensure_ffmpeg_available()

    job_path = Path(args.job).expanduser().resolve()
    if not job_path.exists():
        raise FileNotFoundError(f"Job file not found: {job_path}")

    job = load_job(job_path)
    songs = parse_songs(job["songs"])

    date_key = str(job["date"])
    project_root = Path(args.project_root).expanduser().resolve()
    source_dir = Path(args.source_dir).expanduser().resolve() if args.source_dir else job_path.parent.resolve()

    if not source_dir.exists() or not source_dir.is_dir():
        raise FileNotFoundError(f"Source directory not found: {source_dir}")

    clips_dir = project_root / "data" / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)

    clip_paths: list[str] = []
    built_clip_paths: list[Path] = []

    for index, song in enumerate(songs, start=1):
        source_path = resolve_source_audio(source_dir, song.source_file_name)
        output_name = f"{date_key}__{index}.mp3"
        output_path = clips_dir / output_name

        trim_clip(source_path, output_path, start_sec=song.start_sec, clip_length_sec=10)
        clip_paths.append(f"data/clips/{output_name}")
        built_clip_paths.append(output_path)
        print(f"Built clip {index}/6: {output_name}")

    combined_name = f"{date_key}__mixtape_full.mp3"
    combined_path = clips_dir / combined_name
    combine_clips(built_clip_paths, combined_path)
    print(f"Built combined mixtape: {combined_name}")

    puzzle_path = write_puzzle_json(project_root, job, songs, clip_paths)
    puzzle_rel_path = f"data/puzzles/{puzzle_path.name}"
    index_path = update_daily_index(project_root, date_key, puzzle_rel_path)

    print("\nBuild complete")
    print(f"Puzzle file: {puzzle_path}")
    print(f"Daily index: {index_path}")
    print(f"Combined mixtape: {combined_path}")


if __name__ == "__main__":
    main()
