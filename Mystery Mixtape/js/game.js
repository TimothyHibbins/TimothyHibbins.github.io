const DAILY_INDEX_PATH = "data/daily-puzzles.json";
const MIXTAPE_MANIFEST_PATH = "mixtapes/index.json";
const STORAGE_PREFIX = "mystery-mixtape.v1";
const WRONG_GUESS_PENALTY_SECONDS = 10;
const CLIP_PLAY_SECONDS = 10;

const els = {
  puzzleDate: document.getElementById("puzzle-date"),
  sourceSelect: document.getElementById("source-select"),
  tapeSelect: document.getElementById("tape-select"),
  loadTapeBtn: document.getElementById("load-tape-btn"),
  clueTitle: document.getElementById("clue-title"),
  clueText: document.getElementById("clue-text"),
  cassette: document.getElementById("mixtape-cassette"),
  cassetteStatus: document.getElementById("cassette-status"),
  cassetteClue: document.getElementById("cassette-clue"),
  transportPlayBtn: document.getElementById("transport-play-btn"),
  timelineScrubber: document.getElementById("timeline-scrubber"),
  timelineMarkers: document.getElementById("timeline-markers"),
  timelineSegments: document.getElementById("timeline-segments"),
  timelineReadout: document.getElementById("timeline-readout"),
  statusMessage: document.getElementById("status-message"),
  roundMeta: document.getElementById("round-meta"),
  giveUpBtn: document.getElementById("give-up-btn"),
  guessForm: document.getElementById("guess-form"),
  guessInput: document.getElementById("guess-input"),
  wrongGuessesWrap: document.getElementById("wrong-guesses-wrap"),
  wrongGuessesList: document.getElementById("wrong-guesses-list"),
  revealPanel: document.getElementById("reveal-panel"),
  revealList: document.getElementById("song-reveal-list"),
  confettiLayer: document.getElementById("confetti-layer"),
  rulesBtn: document.getElementById("rules-btn"),
  rulesModal: document.getElementById("rules-modal"),
  rulesCloseBtn: document.getElementById("rules-close-btn")
};

const state = {
  dateKey: "",
  manifestPacks: [],
  selectedPackSlug: "",
  selectedTapeKey: "",
  selectedTapePath: "",
  selectedPackLabel: "",
  availableTapes: [],
  puzzle: null,
  phase: "loading",
  startedAtMs: null,
  endedAtMs: null,
  wrongGuesses: 0,
  guesses: [],
  audioContext: null,
  clipBufferCache: new Map(),
  currentSource: null,
  currentGain: null,
  currentAudioTimeoutId: null,
  sequencePlaybackToken: 0,
  isSequencePlaying: false,
  timelinePlaybackToken: 0,
  timelineCurrentSec: 0,
  isTimelinePlaying: false,
  timelineTickIntervalId: null,
  timelineTickStartSec: 0,
  timelineTickStartMs: 0,
  preserveTimelinePositionOnStop: false,
  sourceLabel: "",
  sourceBasePath: "",
  persistProgress: true
};

let tickIntervalId = null;

function getAestDateKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function getMixtapeSlugFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const value = params.get("mixtape") || "";
  return value.trim();
}

function isAbsolutePathLike(path) {
  return /^(?:[a-z]+:)?\/\//i.test(path) || path.startsWith("/");
}

function joinPath(basePath, path) {
  const cleanPath = String(path || "").replace(/^\.\//, "");
  if (!cleanPath) {
    return cleanPath;
  }
  if (!basePath || isAbsolutePathLike(cleanPath)) {
    return cleanPath;
  }
  const cleanBase = String(basePath).replace(/\/+$/, "");
  return `${cleanBase}/${cleanPath}`;
}

async function fetchJson(path, notFoundOk = false) {
  const response = await fetch(encodeURI(path));
  if (!response.ok) {
    if (notFoundOk && response.status === 404) {
      return null;
    }
    throw new Error(`Could not load ${path}.`);
  }
  return response.json();
}

async function loadIndexForMixtape(slug, label = "") {
  const basePath = `mixtapes/${slug}`;
  const patchPath = joinPath(basePath, "data/daily-puzzles.patch.json");
  const fullPath = joinPath(basePath, "data/daily-puzzles.json");

  let dailyIndex = await fetchJson(patchPath, true);
  if (!dailyIndex) {
    dailyIndex = await fetchJson(fullPath, true);
  }

  if (!dailyIndex) {
    throw new Error(`Mixtape "${slug}" has no daily puzzle index.`);
  }

  return {
    basePath,
    label: label || slug,
    dailyIndex
  };
}

async function loadManifestPacks() {
  const manifest = await fetchJson(MIXTAPE_MANIFEST_PATH, true);
  if (!manifest) {
    return { packs: [], defaultSlug: "" };
  }

  const packs = (Array.isArray(manifest.packs) ? manifest.packs : [])
    .filter((pack) => pack && typeof pack.slug === "string" && pack.slug.trim())
    .map((pack) => ({
      slug: pack.slug.trim(),
      label: String(pack.label || pack.slug).trim() || pack.slug.trim()
    }));

  return {
    packs,
    defaultSlug: String(manifest.default || "").trim()
  };
}

function extractTapeEntries(dailyIndex) {
  const entries = [];

  if (dailyIndex && typeof dailyIndex.puzzles === "object" && !Array.isArray(dailyIndex.puzzles)) {
    for (const [key, value] of Object.entries(dailyIndex.puzzles)) {
      if (typeof value === "string" && value.trim()) {
        entries.push({
          key,
          label: key,
          path: value
        });
      }
    }
  }

  if (Array.isArray(dailyIndex?.puzzles)) {
    for (const item of dailyIndex.puzzles) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const path = String(item.file || item.path || "").trim();
      if (!path) {
        continue;
      }
      const key = String(item.date || item.id || item.title || path).trim();
      entries.push({
        key,
        label: key,
        path
      });
    }
  }

  const fallback = String(dailyIndex?.fallback || "").trim();
  if (fallback && !entries.some((entry) => entry.path === fallback)) {
    entries.push({
      key: "fallback",
      label: "fallback",
      path: fallback
    });
  }

  return entries;
}

function renderSourceOptions() {
  if (!els.sourceSelect) {
    return;
  }
  els.sourceSelect.innerHTML = "";
  for (const pack of state.manifestPacks) {
    const option = document.createElement("option");
    option.value = pack.slug;
    option.textContent = pack.label;
    els.sourceSelect.appendChild(option);
  }
  if (state.selectedPackSlug) {
    els.sourceSelect.value = state.selectedPackSlug;
  }
}

function renderTapeOptions() {
  if (!els.tapeSelect) {
    return;
  }
  els.tapeSelect.innerHTML = "";
  for (const tape of state.availableTapes) {
    const option = document.createElement("option");
    option.value = tape.key;
    option.textContent = tape.label;
    els.tapeSelect.appendChild(option);
  }
  if (state.selectedTapeKey) {
    els.tapeSelect.value = state.selectedTapeKey;
  }
}

function applySourceBaseToPuzzle(puzzle, basePath) {
  if (!puzzle || !Array.isArray(puzzle.songs)) {
    return puzzle;
  }

  return {
    ...puzzle,
    songs: puzzle.songs.map((song) => ({
      ...song,
      clipSrc: joinPath(basePath, song.clipSrc)
    }))
  };
}

function normalizeTheme(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stateStorageKey() {
  const sourceKey = state.sourceBasePath || "daily";
  return `${STORAGE_PREFIX}.${sourceKey}.${state.dateKey}`;
}

function nowMs() {
  return Date.now();
}

function elapsedSeconds() {
  if (!state.startedAtMs) {
    return 0;
  }
  const endMs = state.endedAtMs || nowMs();
  return Math.max(0, Math.floor((endMs - state.startedAtMs) / 1000));
}

function currentScoreSeconds() {
  return elapsedSeconds() + state.wrongGuesses * WRONG_GUESS_PENALTY_SECONDS;
}

function formatClock(totalSeconds) {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function timelineDurationSec() {
  if (!state.puzzle || !Array.isArray(state.puzzle.songs)) {
    return 0;
  }
  return state.puzzle.songs.length * CLIP_PLAY_SECONDS;
}

function clampTimelineSec(value) {
  const duration = timelineDurationSec();
  if (!duration) {
    return 0;
  }
  return Math.max(0, Math.min(duration, Number(value) || 0));
}

function stopTimelineTick() {
  if (!state.timelineTickIntervalId) {
    return;
  }
  clearInterval(state.timelineTickIntervalId);
  state.timelineTickIntervalId = null;
}

function startTimelineTick(startSec, segmentDurationSec) {
  stopTimelineTick();
  state.timelineTickStartSec = clampTimelineSec(startSec);
  state.timelineTickStartMs = nowMs();

  state.timelineTickIntervalId = setInterval(() => {
    const elapsed = (nowMs() - state.timelineTickStartMs) / 1000;
    state.timelineCurrentSec = clampTimelineSec(
      Math.min(state.timelineTickStartSec + elapsed, state.timelineTickStartSec + segmentDurationSec)
    );
    renderTimeline();
  }, 80);
}

function renderTimelineMarkers() {
  if (!els.timelineMarkers) {
    return;
  }

  const duration = timelineDurationSec();
  els.timelineMarkers.innerHTML = "";
  if (!duration || !state.startedAtMs) {
    return;
  }

  for (const guess of state.guesses) {
    if (!guess || typeof guess.atMs !== "number") {
      continue;
    }

    const relSec = Math.max(0, (guess.atMs - state.startedAtMs) / 1000);
    const pct = Math.max(0, Math.min(100, (relSec / duration) * 100));
    const marker = document.createElement("span");
    marker.className = `timeline-marker write ${guess.result === "correct" ? "correct" : "wrong"}`;
    marker.style.left = `${pct}%`;
    marker.title = `${guess.result === "correct" ? "Answer" : "Wrong"}: ${guess.value}`;
    els.timelineMarkers.appendChild(marker);
  }
}

function renderTimelineSegments() {
  if (!els.timelineSegments) {
    return;
  }

  const trackCount = state.puzzle?.songs?.length || 0;
  els.timelineSegments.innerHTML = "";
  if (!trackCount) {
    return;
  }

  for (let i = 0; i < trackCount; i += 1) {
    const segment = document.createElement("span");
    segment.className = "timeline-segment";
    segment.dataset.track = String(i + 1);
    els.timelineSegments.appendChild(segment);
  }
}

function renderTimeline() {
  const duration = timelineDurationSec();
  const terminalSolved = state.phase === "solved";

  if (els.timelineScrubber) {
    els.timelineScrubber.max = String(duration || 60);
    els.timelineScrubber.value = String(clampTimelineSec(state.timelineCurrentSec));
    els.timelineScrubber.disabled = !terminalSolved;
  }

  if (els.timelineReadout) {
    els.timelineReadout.textContent = `${formatClock(Math.floor(clampTimelineSec(state.timelineCurrentSec)))} / ${formatClock(Math.floor(duration || 60))}`;
  }

  renderTimelineSegments();
  renderTimelineMarkers();
}

function setStatusMessage(message, tone = "") {
  els.statusMessage.textContent = message;
  els.statusMessage.classList.remove("ok", "warn", "bad");
  if (tone) {
    els.statusMessage.classList.add(tone);
  }
}

function triggerConfettiBurst() {
  if (!els.confettiLayer) {
    return;
  }

  const colors = ["#fde047", "#fb7185", "#38bdf8", "#34d399", "#f9fafb"];
  const count = 46;

  for (let i = 0; i < count; i += 1) {
    const piece = document.createElement("span");
    piece.className = "confetti-piece";

    const left = 8 + Math.random() * 84;
    const delay = Math.random() * 0.18;
    const duration = 1 + Math.random() * 0.9;
    const drift = (Math.random() - 0.5) * 180;
    const size = 6 + Math.random() * 8;
    const rotate = Math.random() * 360;

    piece.style.left = `${left}%`;
    piece.style.top = "-12px";
    piece.style.width = `${size}px`;
    piece.style.height = `${Math.max(4, size * 0.55)}px`;
    piece.style.background = colors[i % colors.length];
    piece.style.setProperty("--confetti-drift", `${drift}px`);
    piece.style.setProperty("--confetti-rot", `${rotate}deg`);
    piece.style.animationDelay = `${delay}s`;
    piece.style.animationDuration = `${duration}s`;

    els.confettiLayer.appendChild(piece);
    setTimeout(() => piece.remove(), Math.ceil((delay + duration) * 1000) + 120);
  }
}

function playSuccessChime() {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    const freqs = [523.25, 659.25, 783.99];
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, now);

      const start = now + i * 0.06;
      const end = start + 0.26;

      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(end + 0.02);
    });
  } catch (error) {
    // Ignore chime failures so gameplay is unaffected.
  }
}

function triggerSuccessEffects() {
  playSuccessChime();
  triggerConfettiBurst();
}

function startClock() {
  if (tickIntervalId) {
    return;
  }
  tickIntervalId = setInterval(renderRoundMeta, 250);
}

function stopClock() {
  if (!tickIntervalId) {
    return;
  }
  clearInterval(tickIntervalId);
  tickIntervalId = null;
}

function persistGameState() {
  if (!state.persistProgress) {
    return;
  }
  if (!state.dateKey) {
    return;
  }
  const payload = {
    phase: state.phase,
    startedAtMs: state.startedAtMs,
    endedAtMs: state.endedAtMs,
    wrongGuesses: state.wrongGuesses,
    guesses: state.guesses
  };
  localStorage.setItem(stateStorageKey(), JSON.stringify(payload));
}

function hydrateFromStorage() {
  if (!state.persistProgress) {
    return;
  }
  const serialized = localStorage.getItem(stateStorageKey());
  if (!serialized) {
    return;
  }

  try {
    const parsed = JSON.parse(serialized);
    if (parsed && typeof parsed === "object") {
      state.phase = parsed.phase || state.phase;
      state.startedAtMs = parsed.startedAtMs || null;
      state.endedAtMs = parsed.endedAtMs || null;
      state.wrongGuesses = Number(parsed.wrongGuesses || 0);
      state.guesses = Array.isArray(parsed.guesses) ? parsed.guesses : [];
    }
  } catch (error) {
    setStatusMessage("Saved game data was invalid and has been ignored.", "warn");
  }
}

function startRoundIfNeeded() {
  if (state.phase === "loading" || state.phase === "missing") {
    return false;
  }

  if (!state.startedAtMs) {
    state.startedAtMs = nowMs();
    if (state.phase === "ready") {
      state.phase = "running";
    }
    setStatusMessage("Round started.");
  }

  startClock();
  persistGameState();
  return true;
}

function stopAnyClip() {
  stopTimelineTick();

  if (state.currentAudioTimeoutId) {
    clearTimeout(state.currentAudioTimeoutId);
    state.currentAudioTimeoutId = null;
  }

  if (state.currentSource) {
    try {
      state.currentSource.stop();
    } catch (error) {
      // Source may already be stopped.
    }
    state.currentSource.disconnect();
    state.currentSource = null;
  }

  if (state.currentGain) {
    state.currentGain.disconnect();
    state.currentGain = null;
  }
}

function getAudioContext() {
  if (!state.audioContext) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    state.audioContext = new AudioCtx();
  }
  return state.audioContext;
}

async function getClipBuffer(clipSrc) {
  if (state.clipBufferCache.has(clipSrc)) {
    return state.clipBufferCache.get(clipSrc);
  }

  const response = await fetch(encodeURI(clipSrc));
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const arr = await response.arrayBuffer();
  const buffer = await getAudioContext().decodeAudioData(arr.slice(0));
  state.clipBufferCache.set(clipSrc, buffer);
  return buffer;
}

async function playClipForWindow(song, index, token, options = {}) {
  if (!song || !song.clipSrc) {
    setStatusMessage(`Track ${index + 1} has no clip source configured.`, "warn");
    return false;
  }

  if (token !== state.sequencePlaybackToken) {
    return false;
  }

  try {
    stopAnyClip();

    const ctx = getAudioContext();
    await ctx.resume();
    const buffer = await getClipBuffer(song.clipSrc);

    if (token !== state.sequencePlaybackToken) {
      return false;
    }

    const offsetSec = Math.max(0, Math.min(Number(options.offsetSec || 0), Math.max(0, buffer.duration - 0.05)));
    const maxPlayableSec = Math.max(0.05, buffer.duration - offsetSec);
    const requestedDuration = Number(options.durationSec || CLIP_PLAY_SECONDS);
    const duration = Math.min(maxPlayableSec, Math.max(0.05, requestedDuration));
    const timelineStartSec = clampTimelineSec(
      Number.isFinite(options.timelineStartSec) ? Number(options.timelineStartSec) : index * CLIP_PLAY_SECONDS + offsetSec
    );
    const playStartedMs = nowMs();

    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(ctx.destination);

    state.currentSource = source;
    state.currentGain = gain;

    return await new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) {
          return;
        }
        settled = true;

        if (state.preserveTimelinePositionOnStop) {
          const playedSec = Math.max(0, (nowMs() - playStartedMs) / 1000);
          state.timelineCurrentSec = clampTimelineSec(timelineStartSec + Math.min(duration, playedSec));
          state.preserveTimelinePositionOnStop = false;
        } else {
          state.timelineCurrentSec = clampTimelineSec(timelineStartSec + duration);
        }
        renderTimeline();

        if (state.currentAudioTimeoutId) {
          clearTimeout(state.currentAudioTimeoutId);
          state.currentAudioTimeoutId = null;
        }

        if (state.currentSource === source) {
          state.currentSource = null;
        }

        if (state.currentGain === gain) {
          gain.disconnect();
          state.currentGain = null;
        }

        resolve(ok);
      };

      source.onended = () => finish(true);
      startTimelineTick(timelineStartSec, duration);
      source.start(0, offsetSec, duration);
      state.currentAudioTimeoutId = setTimeout(() => {
        try {
          source.stop();
        } catch (error) {
          // Source may have naturally ended.
        }
        finish(true);
      }, Math.ceil(duration * 1000) + 80);
    });
  } catch (error) {
    setStatusMessage(`Could not play track ${index + 1}: ${error.message || "decode/playback error"}.`, "bad");
    stopAnyClip();
    return false;
  }
}

async function playMixtapeSequence() {
  if (!state.puzzle || !Array.isArray(state.puzzle.songs)) {
    return;
  }

  if (!startRoundIfNeeded()) {
    return;
  }

  if (state.phase === "gaveup") {
    setStatusMessage("Round already finished.", "warn");
    return;
  }

  if (state.isSequencePlaying) {
    setStatusMessage("Mixtape is already playing.", "warn");
    return;
  }

  state.sequencePlaybackToken += 1;
  const token = state.sequencePlaybackToken;
  state.isSequencePlaying = true;
  state.timelineCurrentSec = 0;
  render();
  let failedTrack = -1;

  for (let index = 0; index < state.puzzle.songs.length; index += 1) {
    if (token !== state.sequencePlaybackToken || state.phase === "gaveup") {
      break;
    }

    state.timelineCurrentSec = index * CLIP_PLAY_SECONDS;
    renderTimeline();
    setStatusMessage(`Playing clip ${index + 1} of ${state.puzzle.songs.length}...`);
    const ok = await playClipForWindow(state.puzzle.songs[index], index, token);
    if (!ok && token === state.sequencePlaybackToken) {
      failedTrack = index;
      break;
    }
  }

  if (token === state.sequencePlaybackToken && failedTrack >= 0) {
    setStatusMessage(`Playback stopped at clip ${failedTrack + 1}.`, "bad");
  } else if (token === state.sequencePlaybackToken && state.phase !== "gaveup") {
    setStatusMessage("Mixtape finished. Replay anytime or submit your guess.", "ok");
  }

  if (token === state.sequencePlaybackToken) {
    state.isSequencePlaying = false;
    if (!state.isTimelinePlaying) {
      state.timelineCurrentSec = timelineDurationSec();
      renderTimeline();
    }
    render();
  }
}

function pauseTransportPlayback() {
  state.preserveTimelinePositionOnStop = true;
  state.isSequencePlaying = false;
  state.isTimelinePlaying = false;
  state.sequencePlaybackToken += 1;
  state.timelinePlaybackToken += 1;
  stopAnyClip();
  render();
}

async function playTimelineFromCursor() {
  if (!state.puzzle || state.phase !== "solved") {
    setStatusMessage("Timeline scrub is unlocked after solving the theme.", "warn");
    return;
  }

  const duration = timelineDurationSec();
  if (!duration) {
    return;
  }

  if (state.isTimelinePlaying) {
    setStatusMessage("Timeline already playing.", "warn");
    return;
  }

  state.isTimelinePlaying = true;
  state.sequencePlaybackToken += 1;
  state.timelinePlaybackToken += 1;
  const token = state.timelinePlaybackToken;

  let cursor = clampTimelineSec(state.timelineCurrentSec);
  if (cursor >= duration - 0.01) {
    cursor = 0;
  }
  state.timelineCurrentSec = cursor;
  render();

  while (token === state.timelinePlaybackToken && state.isTimelinePlaying && cursor < duration - 0.01) {
    const index = Math.min(state.puzzle.songs.length - 1, Math.floor(cursor / CLIP_PLAY_SECONDS));
    const offsetSec = cursor - index * CLIP_PLAY_SECONDS;
    const segmentDuration = Math.min(CLIP_PLAY_SECONDS - offsetSec, duration - cursor);

    setStatusMessage(`Timeline ${formatClock(Math.floor(cursor))}...`, "ok");
    const ok = await playClipForWindow(state.puzzle.songs[index], index, state.sequencePlaybackToken, {
      offsetSec,
      durationSec: segmentDuration,
      timelineStartSec: cursor
    });
    if (!ok || token !== state.timelinePlaybackToken || !state.isTimelinePlaying) {
      break;
    }

    cursor = clampTimelineSec(cursor + segmentDuration);
  }

  if (token === state.timelinePlaybackToken) {
    state.isTimelinePlaying = false;
    if (state.timelineCurrentSec >= duration - 0.01) {
      state.timelineCurrentSec = duration;
      setStatusMessage("Timeline ended. Scrub to replay any point.", "ok");
    }
    render();
  }
}

async function onTransportPlayPause() {
  if (state.phase === "loading" || state.phase === "missing") {
    return;
  }

  if (state.isSequencePlaying || state.isTimelinePlaying) {
    pauseTransportPlayback();
    setStatusMessage("Playback paused.", "warn");
    return;
  }

  if (state.phase === "solved") {
    await playTimelineFromCursor();
    return;
  }

  await playMixtapeSequence();
}

function answerSet() {
  if (!state.puzzle) {
    return new Set();
  }

  const canonical = [state.puzzle.theme, ...(state.puzzle.aliases || [])]
    .map((item) => normalizeTheme(String(item || "")))
    .filter(Boolean);

  return new Set(canonical);
}

function submitGuess(rawGuess) {
  const guess = rawGuess.trim();
  if (!guess) {
    setStatusMessage("Enter a guess first.", "warn");
    return "empty";
  }

  if (!startRoundIfNeeded()) {
    return "blocked";
  }

  if (state.phase === "solved" || state.phase === "gaveup") {
    setStatusMessage("Round already finished.", "warn");
    return "blocked";
  }

  const normalizedGuess = normalizeTheme(guess);
  const options = answerSet();
  const isCorrect = options.has(normalizedGuess);

  if (isCorrect) {
    state.phase = "solved";
    state.endedAtMs = nowMs();
    state.guesses.push({ value: guess, result: "correct", atMs: state.endedAtMs });

    state.preserveTimelinePositionOnStop = true;
    state.sequencePlaybackToken += 1;
    state.isSequencePlaying = false;
    state.isTimelinePlaying = false;
    stopAnyClip();

    stopClock();
    triggerSuccessEffects();
    setStatusMessage("Correct. Theme solved.", "ok");
  } else {
    state.phase = "running";
    state.wrongGuesses += 1;
    state.guesses.push({ value: guess, result: "wrong", atMs: nowMs() });
    setStatusMessage(`Not it. +${WRONG_GUESS_PENALTY_SECONDS}s penalty. Keep guessing.`, "bad");
  }

  persistGameState();
  render();
  return isCorrect ? "correct" : "wrong";
}

function giveUp() {
  if (!startRoundIfNeeded()) {
    return;
  }

  if (state.phase === "solved" || state.phase === "gaveup") {
    return;
  }

  state.phase = "gaveup";
  state.endedAtMs = nowMs();

  state.sequencePlaybackToken += 1;
  state.timelinePlaybackToken += 1;
  state.isSequencePlaying = false;
  state.isTimelinePlaying = false;
  stopAnyClip();
  stopClock();

  setStatusMessage("Round ended. Marked as DNF.", "warn");
  persistGameState();
  render();
}

function renderRoundMeta() {
  if (!state.startedAtMs) {
    els.roundMeta.textContent = "";
    return;
  }

  const elapsed = elapsedSeconds();
  const penalty = state.wrongGuesses * WRONG_GUESS_PENALTY_SECONDS;

  if (state.phase === "gaveup") {
    els.roundMeta.textContent = `Elapsed ${formatClock(elapsed)} | Penalty +${penalty}s | Score DNF`;
    return;
  }

  const suffix = state.phase === "solved" ? "" : "*";
  els.roundMeta.textContent = `Elapsed ${formatClock(elapsed)} | Penalty +${penalty}s | Score ${currentScoreSeconds()}s${suffix}`;
}

function renderReveal() {
  const isTerminal = state.phase === "solved" || state.phase === "gaveup";
  els.revealPanel.classList.toggle("hidden", !isTerminal);

  if (!isTerminal || !state.puzzle) {
    return;
  }

  els.revealList.innerHTML = "";

  const header = document.createElement("div");
  header.className = "reveal-row head";
  ["#", "Song Title", "Artist(s)"].forEach((label) => {
    const cell = document.createElement("div");
    cell.textContent = label;
    header.appendChild(cell);
  });
  els.revealList.appendChild(header);

  state.puzzle.songs.forEach((song, index) => {
    const row = document.createElement("div");
    row.className = "reveal-row";

    const indexCell = document.createElement("div");
    indexCell.textContent = String(index + 1);

    const titleCell = document.createElement("div");
    titleCell.textContent = song.title;

    const artistCell = document.createElement("div");
    artistCell.textContent = song.artist;

    row.append(indexCell, titleCell, artistCell);
    els.revealList.appendChild(row);
  });
}

function renderCassetteState() {
  const playable = state.phase !== "loading" && state.phase !== "missing";
  const terminal = state.phase === "solved" || state.phase === "gaveup";

  els.cassette.classList.toggle("playing", state.isSequencePlaying);
  els.cassette.classList.toggle("inactive", !playable || terminal);
  els.cassette.classList.toggle("flipped", terminal);

  if (state.isSequencePlaying) {
    els.cassetteStatus.textContent = "Playing";
  } else if (state.phase === "solved") {
    els.cassetteStatus.textContent = state.isTimelinePlaying ? "Timeline Playing" : "Solved: Scrub Timeline";
  } else if (state.phase === "gaveup") {
    els.cassetteStatus.textContent = "Finished";
  } else if (playable) {
    els.cassetteStatus.textContent = "Press Play";
  } else {
    els.cassetteStatus.textContent = "Loading";
  }
}

function renderTransportState() {
  const playable = state.phase !== "loading" && state.phase !== "missing";
  const isAnyPlayback = state.isSequencePlaying || state.isTimelinePlaying;

  if (els.transportPlayBtn) {
    els.transportPlayBtn.disabled = !playable;
    if (isAnyPlayback) {
      els.transportPlayBtn.textContent = "Pause";
    } else {
      els.transportPlayBtn.textContent = "Play";
    }
  }

  renderTimeline();
}

function renderWrongGuesses() {
  if (!els.wrongGuessesWrap || !els.wrongGuessesList) {
    return;
  }

  const wrong = state.guesses.filter((guess) => guess.result === "wrong");
  els.wrongGuessesWrap.classList.toggle("hidden", wrong.length === 0);

  els.wrongGuessesList.innerHTML = "";
  for (const guess of wrong) {
    const li = document.createElement("li");
    li.textContent = guess.value;
    els.wrongGuessesList.appendChild(li);
  }
}

function renderClue() {
  const defaultClue = "Listen carefully to all six clips and find the common thread.";

  if (!state.puzzle) {
    els.clueTitle.textContent = "";
    els.clueText.textContent = "";
    if (els.cassetteClue) {
      els.cassetteClue.textContent = "Loading clue...";
    }
    return;
  }

  const clueText = state.puzzle.clue || defaultClue;
  els.clueTitle.textContent = "";
  els.clueText.textContent = "";
  if (els.cassetteClue) {
    els.cassetteClue.textContent = clueText;
  }
}

function renderGuessInputState() {
  const terminal = state.phase === "solved" || state.phase === "gaveup";
  const playable = state.phase !== "loading" && state.phase !== "missing";
  els.guessInput.disabled = !playable || terminal;
  els.giveUpBtn.disabled = !playable || terminal;
  els.guessInput.classList.toggle("correct", state.phase === "solved");
  els.guessForm.classList.toggle("hidden", terminal);
}

function render() {
  renderClue();
  renderRoundMeta();
  renderCassetteState();
  renderTransportState();
  renderGuessInputState();
  renderWrongGuesses();
  renderReveal();
}

function resetForNewTape() {
  pauseTransportPlayback();
  stopClock();
  state.puzzle = null;
  state.phase = "ready";
  state.startedAtMs = null;
  state.endedAtMs = null;
  state.wrongGuesses = 0;
  state.guesses = [];
  state.timelineCurrentSec = 0;
  state.isTimelinePlaying = false;
  if (els.guessInput) {
    els.guessInput.value = "";
  }
}

async function refreshTapeOptionsForPack(slug) {
  const pack = state.manifestPacks.find((item) => item.slug === slug);
  if (!pack) {
    throw new Error(`Unknown set "${slug}".`);
  }

  const source = await loadIndexForMixtape(pack.slug, pack.label);
  state.sourceLabel = source.label;
  state.sourceBasePath = source.basePath;
  state.selectedPackSlug = pack.slug;
  state.selectedPackLabel = pack.label;

  state.availableTapes = extractTapeEntries(source.dailyIndex);
  if (!state.availableTapes.length) {
    throw new Error(`Set "${pack.label}" has no tapes in its index.`);
  }

  const stillExists = state.availableTapes.find((item) => item.key === state.selectedTapeKey);
  const chosen = stillExists || state.availableTapes[0];
  state.selectedTapeKey = chosen.key;
  state.selectedTapePath = chosen.path;
  renderTapeOptions();
}

function applyTapeSelectionFromUI() {
  const selectedKey = String(els.tapeSelect?.value || "");
  const tape = state.availableTapes.find((item) => item.key === selectedKey) || state.availableTapes[0];
  if (!tape) {
    return false;
  }
  state.selectedTapeKey = tape.key;
  state.selectedTapePath = tape.path;
  return true;
}

async function loadSelectedTape() {
  if (!state.selectedPackSlug || !state.selectedTapePath) {
    throw new Error("Please choose a set and tape first.");
  }

  resetForNewTape();
  state.phase = "loading";
  render();

  const resolvedPuzzlePath = joinPath(state.sourceBasePath, state.selectedTapePath);
  const puzzleResponse = await fetch(encodeURI(resolvedPuzzlePath));
  if (!puzzleResponse.ok) {
    throw new Error(`Could not load puzzle file at ${resolvedPuzzlePath}.`);
  }

  const puzzle = applySourceBaseToPuzzle(await puzzleResponse.json(), state.sourceBasePath);
  if (!Array.isArray(puzzle.songs) || puzzle.songs.length !== 6) {
    throw new Error("Puzzle must contain exactly six songs.");
  }

  state.puzzle = puzzle;
  state.phase = "ready";
  state.persistProgress = false;
  state.dateKey = `${state.selectedPackSlug}:${state.selectedTapeKey}`;

  els.puzzleDate.textContent = `Set: ${state.selectedPackLabel} | Tape: ${state.selectedTapeKey}`;
  setStatusMessage(`Loaded ${state.selectedPackLabel} / ${state.selectedTapeKey}. Press Play to start.`);
  render();
}

async function setupTapePicker() {
  const { packs, defaultSlug } = await loadManifestPacks();
  state.manifestPacks = packs;
  if (!packs.length) {
    throw new Error("No mixtape sets found in mixtapes/index.json.");
  }

  const querySlug = getMixtapeSlugFromQuery();
  const initialSlug =
    packs.find((pack) => pack.slug === querySlug)?.slug ||
    packs.find((pack) => pack.slug === defaultSlug)?.slug ||
    packs[0].slug;

  state.selectedPackSlug = initialSlug;
  renderSourceOptions();
  await refreshTapeOptionsForPack(initialSlug);
  await loadSelectedTape();
}

function openRulesModal() {
  els.rulesModal.classList.remove("hidden");
}

function closeRulesModal() {
  els.rulesModal.classList.add("hidden");
}

function wireEvents() {
  els.sourceSelect.addEventListener("change", async () => {
    const slug = String(els.sourceSelect.value || "");
    try {
      await refreshTapeOptionsForPack(slug);
      els.puzzleDate.textContent = `Set: ${state.selectedPackLabel} | Tape: ${state.selectedTapeKey}`;
      setStatusMessage("Choose a tape and press Load.", "ok");
      render();
    } catch (error) {
      setStatusMessage(error.message || "Could not load set.", "bad");
    }
  });

  els.tapeSelect.addEventListener("change", () => {
    if (applyTapeSelectionFromUI()) {
      els.puzzleDate.textContent = `Set: ${state.selectedPackLabel} | Tape: ${state.selectedTapeKey}`;
    }
  });

  els.loadTapeBtn.addEventListener("click", async () => {
    if (!applyTapeSelectionFromUI()) {
      setStatusMessage("No tape selected.", "warn");
      return;
    }
    try {
      await loadSelectedTape();
    } catch (error) {
      state.phase = "missing";
      setStatusMessage(error.message || "Failed to load tape.", "bad");
      render();
    }
  });

  els.transportPlayBtn.addEventListener("click", () => {
    onTransportPlayPause();
  });

  els.timelineScrubber.addEventListener("input", () => {
    const nextSec = clampTimelineSec(Number(els.timelineScrubber.value));
    state.timelineCurrentSec = nextSec;
    renderTimeline();
  });

  els.timelineScrubber.addEventListener("change", () => {
    if (state.phase !== "solved") {
      return;
    }
    if (state.isTimelinePlaying) {
      pauseTransportPlayback();
      playTimelineFromCursor();
    }
  });

  els.giveUpBtn.addEventListener("click", giveUp);

  els.guessForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const outcome = submitGuess(els.guessInput.value);
    if (outcome === "wrong") {
      els.guessInput.value = "";
    }
    els.guessInput.focus();
  });

  els.rulesBtn.addEventListener("click", openRulesModal);
  els.rulesCloseBtn.addEventListener("click", closeRulesModal);
  els.rulesModal.addEventListener("click", (event) => {
    if (event.target === els.rulesModal) {
      closeRulesModal();
    }
  });
  window.addEventListener("keydown", (event) => {
    if (event.code === "Escape") {
      closeRulesModal();
    }
  });
}

async function init() {
  wireEvents();
  render();

  try {
    await setupTapePicker();
  } catch (error) {
    state.phase = "missing";
    setStatusMessage(error.message || "Failed to load puzzle.", "bad");
  }

  render();
}

init();
