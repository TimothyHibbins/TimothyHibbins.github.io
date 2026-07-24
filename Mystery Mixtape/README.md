# Mystery Mixtape

Mystery Mixtape is a daily guessing game: players hear six 10-second clips and try to guess the shared theme as quickly as possible.

## Current MVP Features

- Daily puzzle loads from static JSON based on AEST date.
- Player can submit guesses at any time after starting.
- Score = elapsed time + 10 seconds per wrong guess.
- Player can continue guessing after wrong answers.
- Player can give up (result is DNF).
- On solve or give up, theme and all songs are revealed.
- Creator mode supports local audio upload, in-page scrubbing, clip start selection, reordering, and JSON export.

## Folder Layout

- `index.html`: game page
- `creator.html`: WIP creator page
- `data/daily-puzzles.json`: date to puzzle map
- `data/puzzles/*.json`: puzzle files
- `data/clips/`: generated 10-second clips
- `_scripts/build_mixtape.py`: local clip build pipeline

## Creator Workflow

1. Open `creator.html`
2. Set puzzle date, theme, aliases.
3. Add 6 songs with local source file + clip start second.
4. Export build job JSON.
5. Run:

```bash
python3 _scripts/build_mixtape.py --job /absolute/path/to/job.json --source-dir /absolute/path/to/source-audio
```

6. Commit generated files in `data/clips/`, `data/puzzles/`, and `data/daily-puzzles.json`.

Build output includes:

- six clipped files: `data/clips/<date>__1.mp3` ... `data/clips/<date>__6.mp3`
- one combined file: `data/clips/<date>__mixtape_full.mp3`

## Dependencies for build script

No Python package install is required for local-file mode.
Install `ffmpeg` on your machine (for clip trimming and combining).
