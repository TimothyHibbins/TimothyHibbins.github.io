const DAILY_INDEX_PATH = "data/daily-puzzles.json";
const MIXTAPE_MANIFEST_PATH = "mixtapes/index.json";
const STORAGE_PREFIX = "mystery-mixtape.v1";
const WRONG_GUESS_PENALTY_SECONDS = 10;
const CLIP_PLAY_SECONDS = 10;
const BUZZ_WINDOW_MS = 5000;

const els = {
    puzzleDate: document.getElementById("puzzle-date"),
    archiveBtn: document.getElementById("archive-btn"),
    archiveModal: document.getElementById("archive-modal"),
    archiveCloseBtn: document.getElementById("archive-close-btn"),
    archiveList: document.getElementById("archive-list"),
    clueTitle: document.getElementById("clue-title"),
    clueText: document.getElementById("clue-text"),
    cassette: document.getElementById("mixtape-cassette"),
    cassetteStatus: document.getElementById("cassette-status"),
    cassetteClue: document.getElementById("cassette-clue"),
    cassetteStartPrompt: document.getElementById("cassette-start-prompt"),
    startBtn: document.getElementById("start-btn"),
    transportRow: document.getElementById("transport-row"),
    transportPlayBtn: document.getElementById("transport-play-btn"),
    timelineSurface: document.getElementById("timeline-surface"),
    timelineWaveform: document.getElementById("timeline-waveform"),
    timelineProgress: document.getElementById("timeline-progress"),
    timelinePlayhead: document.getElementById("timeline-playhead"),
    timelineMarkers: document.getElementById("timeline-markers"),
    timelineSegments: document.getElementById("timeline-segments"),
    timelineReadout: document.getElementById("timeline-readout"),
    roundMeta: document.getElementById("round-meta"),
    guessForm: document.getElementById("guess-form"),
    guessInput: document.getElementById("guess-input"),
    guessSubmitBtn: document.querySelector(".guess-submit-btn"),
    wrongGuessesWrap: document.getElementById("wrong-guesses-wrap"),
    wrongGuessesList: document.getElementById("wrong-guesses-list"),
    revealPanel: document.getElementById("reveal-panel"),
    revealList: document.getElementById("song-reveal-list"),
    shareBtn: document.getElementById("share-btn"),
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
    archiveEntries: [],
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
    buzzActive: false,
    buzzDeadlineMs: 0,
    buzzTimerIntervalId: null,
    timelineWaveformPeaks: [],
    timelineWaveformToken: 0,
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

async function fetchArchiveClue(basePath, tapePath) {
    try {
        const response = await fetch(encodeURI(joinPath(basePath, tapePath)));
        if (!response.ok) {
            return "Could not load clue";
        }
        const puzzle = await response.json();
        return String(puzzle?.clue || "No clue available").trim() || "No clue available";
    } catch (error) {
        return "Could not load clue";
    }
}

async function buildArchiveEntries() {
    const entries = [];
    for (const pack of state.manifestPacks) {
        const source = await loadIndexForMixtape(pack.slug, pack.label);
        const tapes = extractTapeEntries(source.dailyIndex);
        for (const tape of tapes) {
            const clue = await fetchArchiveClue(source.basePath, tape.path);
            entries.push({
                packSlug: pack.slug,
                packLabel: pack.label,
                basePath: source.basePath,
                tapeKey: tape.key,
                tapePath: tape.path,
                clue
            });
        }
    }
    state.archiveEntries = entries;
}

function renderArchiveList() {
    if (!els.archiveList) {
        return;
    }
    els.archiveList.innerHTML = "";

    for (const item of state.archiveEntries) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "archive-tape-row";
        row.dataset.packSlug = item.packSlug;
        row.dataset.tapeKey = item.tapeKey;
        row.innerHTML = `
            <span class="archive-tape-id">${item.packLabel} / ${item.tapeKey}</span>
            <span class="archive-tape-clue">${item.clue}</span>
        `;
        row.addEventListener("click", async () => {
            await loadTapeFromArchiveItem(item);
            closeArchiveModal();
        });
        els.archiveList.appendChild(row);
    }
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

function clearBuzzTimerInterval() {
    if (!state.buzzTimerIntervalId) {
        return;
    }
    clearInterval(state.buzzTimerIntervalId);
    state.buzzTimerIntervalId = null;
}

function updateBuzzTimerUi() {
    if (!els.buzzTimer) {
        return;
    }

    if (!state.buzzActive) {
        els.buzzTimer.classList.add("hidden");
        return;
    }

    const remainingMs = Math.max(0, state.buzzDeadlineMs - nowMs());
    els.buzzTimer.classList.remove("hidden");
    els.buzzTimer.textContent = `${(remainingMs / 1000).toFixed(1)}s`;
}

async function resumeSequenceAfterBuzzIfNeeded() {
    if (state.phase === "solved" || state.phase === "gaveup") {
        return;
    }
    if (state.isSequencePlaying || state.isTimelinePlaying) {
        return;
    }
    await playMixtapeFromCursor(state.timelineCurrentSec);
}

async function endBuzzWindow({
    resumePlayback = false,
    statusText = "",
    statusTone = "",
    skipStatus = false
} = {}) {
    const wasActive = state.buzzActive;
    state.buzzActive = false;
    state.buzzDeadlineMs = 0;
    clearBuzzTimerInterval();
    updateBuzzTimerUi();

    if (!skipStatus && statusText) {
        setStatusMessage(statusText, statusTone);
    }

    render();

    if (wasActive && resumePlayback) {
        await resumeSequenceAfterBuzzIfNeeded();
    }
}

function startBuzzTimerLoop() {
    clearBuzzTimerInterval();
    state.buzzTimerIntervalId = setInterval(() => {
        const remainingMs = state.buzzDeadlineMs - nowMs();
        if (remainingMs <= 0) {
            endBuzzWindow({
                resumePlayback: true,
                statusText: "Time up. Mixtape resumed.",
                statusTone: "warn"
            });
            return;
        }
        updateBuzzTimerUi();
    }, 50);
}

function sizeTimelineWaveformCanvas() {
    const canvas = els.timelineWaveform;
    if (!canvas) {
        return;
    }
    const rect = canvas.getBoundingClientRect();
    const cssWidth = Math.max(10, Math.floor(rect.width));
    const cssHeight = Math.max(12, Math.floor(rect.height));
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    const nextWidth = Math.floor(cssWidth * dpr);
    const nextHeight = Math.floor(cssHeight * dpr);
    if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
        canvas.width = nextWidth;
        canvas.height = nextHeight;
    }
}

function drawTimelineWaveformPlaceholder() {
    const canvas = els.timelineWaveform;
    if (!canvas) {
        return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function buildWavePeaksFromBuffer(buffer, binCount) {
    const bins = Math.max(24, Math.floor(binCount || 120));
    const peaks = new Float32Array(bins);
    const data = buffer.getChannelData(0);
    if (!data || !data.length) {
        return peaks;
    }

    const samplesPerBin = Math.max(1, Math.floor(data.length / bins));
    for (let i = 0; i < bins; i += 1) {
        const start = i * samplesPerBin;
        const end = Math.min(data.length, start + samplesPerBin);
        let maxAbs = 0;
        for (let j = start; j < end; j += 1) {
            const v = Math.abs(data[j]);
            if (v > maxAbs) {
                maxAbs = v;
            }
        }
        peaks[i] = maxAbs;
    }

    return peaks;
}

function renderTimelineWaveform() {
    const canvas = els.timelineWaveform;
    if (!canvas) {
        return;
    }
    sizeTimelineWaveformCanvas();

    const ctx = canvas.getContext("2d");
    if (!ctx) {
        return;
    }

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const tracks = state.timelineWaveformPeaks;
    if (!Array.isArray(tracks) || !tracks.length) {
        return;
    }

    const midY = height / 2;
    const segmentWidth = width / tracks.length;
    ctx.strokeStyle = "rgba(255,255,255,0.96)";
    ctx.lineWidth = Math.max(1, Math.floor((window.devicePixelRatio || 1)));
    ctx.globalAlpha = 0.95;

    for (let trackIndex = 0; trackIndex < tracks.length; trackIndex += 1) {
        const peaks = tracks[trackIndex];
        if (!(peaks instanceof Float32Array) || !peaks.length) {
            continue;
        }

        const xStart = trackIndex * segmentWidth;
        const localWidth = segmentWidth;
        for (let i = 0; i < peaks.length; i += 1) {
            const x = xStart + (i / peaks.length) * localWidth;
            const amp = Math.max(0.015, Math.min(1, peaks[i]));
            const bar = amp * (height * 0.48);
            ctx.beginPath();
            ctx.moveTo(x + 0.5, midY - bar);
            ctx.lineTo(x + 0.5, midY + bar);
            ctx.stroke();
        }
    }

    ctx.globalAlpha = 1;
}

async function buildTimelineWaveformData() {
    if (!state.puzzle || !Array.isArray(state.puzzle.songs)) {
        state.timelineWaveformPeaks = [];
        renderTimelineWaveform();
        return;
    }

    const token = ++state.timelineWaveformToken;
    state.timelineWaveformPeaks = new Array(state.puzzle.songs.length).fill(null);
    renderTimelineWaveform();

    for (let i = 0; i < state.puzzle.songs.length; i += 1) {
        if (token !== state.timelineWaveformToken) {
            return;
        }

        const song = state.puzzle.songs[i];
        if (!song?.clipSrc) {
            continue;
        }

        try {
            const buffer = await getClipBuffer(song.clipSrc);
            if (token !== state.timelineWaveformToken) {
                return;
            }
            state.timelineWaveformPeaks[i] = buildWavePeaksFromBuffer(buffer, 140);
            renderTimelineWaveform();
        } catch (error) {
            // Ignore waveform extraction failures per clip; playback errors are handled elsewhere.
        }
    }
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

    if (state.phase !== "solved") {
        els.timelineSegments.innerHTML = "";
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
    const clampedSec = clampTimelineSec(state.timelineCurrentSec);
    const pct = duration ? Math.max(0, Math.min(100, (clampedSec / duration) * 100)) : 0;

    if (els.timelineSurface) {
        els.timelineSurface.classList.toggle("seekable", terminalSolved);
        els.timelineSurface.setAttribute("aria-disabled", terminalSolved ? "false" : "true");
        els.timelineSurface.setAttribute("aria-valuemin", "0");
        els.timelineSurface.setAttribute("aria-valuemax", String(Math.floor(duration || 60)));
        els.timelineSurface.setAttribute("aria-valuenow", String(Math.floor(clampedSec)));
        els.timelineSurface.setAttribute(
            "aria-valuetext",
            `${formatClock(Math.floor(clampedSec))} / ${formatClock(Math.floor(duration || 60))}`
        );
    }

    if (els.timelineProgress) {
        els.timelineProgress.style.width = `${pct}%`;
    }

    if (els.timelinePlayhead) {
        els.timelinePlayhead.style.left = `${pct}%`;
    }

    if (els.timelineReadout) {
        els.timelineReadout.textContent = `${formatClock(Math.floor(clampedSec))} / ${formatClock(Math.floor(duration || 60))}`;
    }

    renderTimelineWaveform();
    renderTimelineSegments();
    renderTimelineMarkers();
}

function setStatusMessage(message, tone = "") {
    if (!els.statusMessage) {
        return;
    }
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

async function playMixtapeFromCursor(startSec = 0) {
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

    const duration = timelineDurationSec();
    let cursor = clampTimelineSec(startSec);
    if (cursor >= duration - 0.01) {
        cursor = 0;
    }

    state.sequencePlaybackToken += 1;
    const token = state.sequencePlaybackToken;
    state.isSequencePlaying = true;
    state.timelineCurrentSec = cursor;
    render();
    let failedTrack = -1;

    while (token === state.sequencePlaybackToken && state.isSequencePlaying && cursor < duration - 0.01) {
        const index = Math.min(state.puzzle.songs.length - 1, Math.floor(cursor / CLIP_PLAY_SECONDS));
        const offsetSec = cursor - index * CLIP_PLAY_SECONDS;
        const segmentDuration = Math.min(CLIP_PLAY_SECONDS - offsetSec, duration - cursor);

        state.timelineCurrentSec = clampTimelineSec(cursor);
        renderTimeline();
        setStatusMessage(`Playing clip ${index + 1} of ${state.puzzle.songs.length}...`);
        const ok = await playClipForWindow(state.puzzle.songs[index], index, token, {
            offsetSec,
            durationSec: segmentDuration,
            timelineStartSec: cursor
        });
        if (!ok && token === state.sequencePlaybackToken) {
            failedTrack = index;
            break;
        }

        cursor = clampTimelineSec(cursor + segmentDuration);
    }

    if (token === state.sequencePlaybackToken && failedTrack >= 0) {
        setStatusMessage(`Playback stopped at clip ${failedTrack + 1}.`, "bad");
    } else if (token === state.sequencePlaybackToken && state.phase !== "gaveup") {
        setStatusMessage("Mixtape finished. Replay anytime or submit your guess.", "ok");
    }

    if (token === state.sequencePlaybackToken) {
        state.isSequencePlaying = false;
        if (!state.isTimelinePlaying) {
            state.timelineCurrentSec = state.buzzActive ? clampTimelineSec(cursor) : timelineDurationSec();
            renderTimeline();
        }
        render();
    }
}

async function playMixtapeSequence() {
    await playMixtapeFromCursor(0);
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

    if (state.phase !== "solved") {
        setStatusMessage("Timeline controls unlock after solving the theme.", "warn");
        return;
    }

    if (state.phase === "solved") {
        await playTimelineFromCursor();
        return;
    }
}

async function onStartRound() {
    if (!state.puzzle) {
        setStatusMessage("Pick a tape from Archive first.", "warn");
        return false;
    }
    if (state.phase === "solved" || state.phase === "gaveup") {
        setStatusMessage("Round already finished.", "warn");
        return false;
    }
    if (state.isSequencePlaying) {
        return false;
    }
    startRoundIfNeeded();
    render();
    els.guessInput.focus();
    playMixtapeSequence();
    return true;
}

function answerSet() {
    if (!state.puzzle) {
        return [];
    }

    const canonical = [state.puzzle.theme, ...(state.puzzle.aliases || [])]
        .map((item) => normalizeTheme(String(item || "")))
        .filter(Boolean);

    return Array.from(new Set(canonical));
}

function isAcceptedGuess(normalizedGuess, acceptedAnswers) {
    if (!normalizedGuess) {
        return false;
    }
    for (const answer of acceptedAnswers) {
        if (!answer) {
            continue;
        }
        if (normalizedGuess === answer || normalizedGuess.includes(answer)) {
            return true;
        }
    }
    return false;
}

function submitGuess(rawGuess) {
    const guess = rawGuess.trim();
    if (!guess) {
        setStatusMessage("Enter a guess first.", "warn");
        return "empty";
    }

    if (!state.startedAtMs) {
        setStatusMessage("Press Start first.", "warn");
        return "blocked";
    }

    if (state.phase === "solved" || state.phase === "gaveup") {
        setStatusMessage("Round already finished.", "warn");
        return "blocked";
    }

    const normalizedGuess = normalizeTheme(guess);
    const options = answerSet();
    const isCorrect = isAcceptedGuess(normalizedGuess, options);

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
        setStatusMessage("Not it. Keep guessing.", "bad");
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
    clearBuzzTimerInterval();
    state.buzzActive = false;
    state.buzzDeadlineMs = 0;
    updateBuzzTimerUi();
    stopAnyClip();
    stopClock();

    setStatusMessage("Round ended. Marked as DNF.", "warn");
    persistGameState();
    render();
}

function renderRoundMeta() {
    if (els.roundMeta) {
        els.roundMeta.textContent = "";
    }
}

function renderReveal() {
    const isTerminal = state.phase === "solved" || state.phase === "gaveup";
    els.revealPanel.classList.toggle("hidden", !isTerminal);

    if (!isTerminal || !state.puzzle) {
        return;
    }

    // Display the answer
    const answerDisplay = document.querySelector(".answer-text");
    if (answerDisplay && state.puzzle.theme) {
        let answerText = `Answer: ${state.puzzle.theme}`;

        // If solved with an alternative answer, show it
        if (state.phase === "solved" && state.guesses.length > 0) {
            const correctGuess = state.guesses.find(g => g.result === "correct");
            if (correctGuess && normalizeTheme(correctGuess.value) !== normalizeTheme(state.puzzle.theme)) {
                answerText += ` (You guessed: ${correctGuess.value})`;
            }
        }

        answerDisplay.textContent = answerText;
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

    els.cassette.classList.toggle("playing", state.isSequencePlaying || state.isTimelinePlaying);
    els.cassette.classList.toggle("inactive", !playable || terminal);
    els.cassette.classList.toggle("flipped", terminal);

    // Show/hide click-to-start prompt
    const showStartPrompt = state.phase === "ready" && !state.startedAtMs;
    if (els.cassetteStartPrompt) {
        els.cassetteStartPrompt.classList.toggle("hidden", !showStartPrompt);

        // Change text based on mobile detection
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth < 640;
        els.cassetteStartPrompt.textContent = isMobile ? "Tap cassette to start!" : "Click cassette to start!";
    }

    els.cassette.classList.toggle("ready", showStartPrompt);

    if (state.isSequencePlaying) {
        els.cassetteStatus.textContent = "Playing";
    } else if (state.phase === "solved") {
        els.cassetteStatus.textContent = state.isTimelinePlaying ? "Timeline Playing" : "Solved: Scrub Timeline";
    } else if (state.phase === "gaveup") {
        els.cassetteStatus.textContent = "Finished";
    } else if (playable) {
        els.cassetteStatus.textContent = "";
    } else {
        els.cassetteStatus.textContent = "Loading";
    }
}

function renderTransportState() {
    const playable = state.phase !== "loading" && state.phase !== "missing";
    const isAnyPlayback = state.isSequencePlaying || state.isTimelinePlaying;
    const solved = state.phase === "solved";

    if (els.transportRow) {
        els.transportRow.classList.toggle("hidden", !solved);
    }

    if (els.transportPlayBtn) {
        els.transportPlayBtn.disabled = !playable || !solved;
        if (isAnyPlayback) {
            els.transportPlayBtn.textContent = "⏸";
            els.transportPlayBtn.setAttribute("aria-label", "Pause");
            els.transportPlayBtn.setAttribute("title", "Pause");
        } else {
            els.transportPlayBtn.textContent = "▶";
            els.transportPlayBtn.setAttribute("aria-label", "Play");
            els.transportPlayBtn.setAttribute("title", "Play");
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
            els.cassetteClue.textContent = "Open Archive and choose a tape.";
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
    const canGuess = playable && !terminal && Boolean(state.puzzle);
    els.guessInput.disabled = !canGuess;
    els.guessInput.classList.toggle("correct", state.phase === "solved");
    els.guessForm.classList.toggle("hidden", terminal);

    if (!state.puzzle) {
        els.guessInput.placeholder = "Open Archive and choose a tape";
    } else if (!state.startedAtMs) {
        els.guessInput.placeholder = "Press Enter to start";
    } else {
        els.guessInput.placeholder = "Enter your guess here";
    }
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
    state.timelineWaveformPeaks = [];
    state.timelineWaveformToken += 1;
    drawTimelineWaveformPlaceholder();
    if (els.guessInput) {
        els.guessInput.value = "";
        els.guessInput.placeholder = "Press Enter to start";
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
    setStatusMessage(`Loaded ${state.selectedPackLabel} / ${state.selectedTapeKey}.`);
    buildTimelineWaveformData();
    render();
}

async function loadTapeFromArchiveItem(item) {
    state.selectedPackSlug = item.packSlug;
    state.selectedPackLabel = item.packLabel;
    state.sourceBasePath = item.basePath;
    state.sourceLabel = item.packLabel;
    state.selectedTapeKey = item.tapeKey;
    state.selectedTapePath = item.tapePath;
    try {
        await loadSelectedTape();
    } catch (error) {
        state.phase = "missing";
        setStatusMessage(error.message || "Failed to load tape.", "bad");
        render();
    }
}

async function setupTapePicker() {
    const { packs } = await loadManifestPacks();
    state.manifestPacks = packs;
    if (!packs.length) {
        throw new Error("No mixtape sets found in mixtapes/index.json.");
    }

    await buildArchiveEntries();
    renderArchiveList();

    if (!state.archiveEntries.length) {
        state.phase = "missing";
        setStatusMessage("No tapes found in archive.", "bad");
        render();
        return;
    }

    // Default to Tape 8 (or first tape if not found)
    const tape8Entry = state.archiveEntries.find(entry => entry.packSlug === "tape 8");
    if (tape8Entry) {
        await loadTapeFromArchiveItem(tape8Entry);
    } else {
        // Fallback to showing archive modal if Tape 8 not found
        state.phase = "ready";
        state.puzzle = null;
        state.startedAtMs = null;
        state.endedAtMs = null;
        state.wrongGuesses = 0;
        state.guesses = [];
        state.timelineCurrentSec = 0;
        els.puzzleDate.textContent = "Select a tape from Archive.";
        setStatusMessage("Open Archive and choose a tape.", "ok");
        render();
        openArchiveModal();
    }
}

function generateShareText() {
    if (state.phase !== "solved") {
        return "";
    }

    // Extract tape number from selectedTapeKey (e.g., "Tape 3" -> "3")
    const tapeMatch = state.selectedTapeKey.match(/\d+/);
    const tapeNumber = tapeMatch ? tapeMatch[0] : "?";

    // Total elapsed time in seconds
    const totalSeconds = elapsedSeconds();

    // Find the correct guess
    const correctGuess = state.guesses.find(g => g.result === "correct");
    if (!correctGuess || !state.startedAtMs) {
        return "";
    }

    // Calculate which track the correct answer was given on
    const correctAnswerTime = (correctGuess.atMs - state.startedAtMs) / 1000;
    const correctAnswerTrack = Math.floor(correctAnswerTime / CLIP_PLAY_SECONDS);

    // Generate grid: one row per track up to and including the correct answer track
    const lines = [];
    lines.push(`Mystery Mixtape ${tapeNumber}`);
    lines.push(`${totalSeconds} seconds`);

    const tracksToShow = Math.min(correctAnswerTrack + 1, state.puzzle.songs.length);

    for (let trackIdx = 0; trackIdx < tracksToShow; trackIdx++) {
        const trackStart = trackIdx * CLIP_PLAY_SECONDS;
        const trackEnd = (trackIdx + 1) * CLIP_PLAY_SECONDS;
        const squares = [];

        // Each track has 5 squares (10 seconds / 2 seconds each)
        for (let squareIdx = 0; squareIdx < 5; squareIdx++) {
            const squareStart = trackStart + (squareIdx * 2);
            const squareEnd = squareStart + 2;

            // Check if this square is after the correct answer
            if (squareStart >= correctAnswerTime) {
                squares.push("⬛");
                continue;
            }

            // Check if there was a guess during this interval
            let guessInInterval = null;
            for (const guess of state.guesses) {
                const guessTime = (guess.atMs - state.startedAtMs) / 1000;
                if (guessTime >= squareStart && guessTime < squareEnd) {
                    guessInInterval = guess;
                    break;
                }
            }

            if (guessInInterval) {
                // There was a guess in this interval
                if (guessInInterval.result === "correct") {
                    squares.push("🟩");
                } else {
                    squares.push("🟥");
                }
            } else {
                // No guess, just listening
                // Only mark as listened if we actually reached this point
                if (squareStart < correctAnswerTime) {
                    squares.push("⬜️");
                } else {
                    squares.push("⬛");
                }
            }
        }

        lines.push(squares.join(""));
    }

    return lines.join("\n");
}

async function shareResults() {
    const shareText = generateShareText();
    if (!shareText) {
        return;
    }

    try {
        await navigator.clipboard.writeText(shareText);
        const originalText = els.shareBtn.textContent;
        els.shareBtn.textContent = "Copied!";
        setTimeout(() => {
            els.shareBtn.textContent = originalText;
        }, 2000);
    } catch (error) {
        console.error("Failed to copy to clipboard:", error);
        // Fallback: show the text in an alert
        alert("Share text:\n\n" + shareText);
    }
}

function openArchiveModal() {
    console.log('[DEBUG] openArchiveModal() called');
    console.log('[DEBUG] els.archiveModal:', els.archiveModal);

    if (!els.archiveModal) {
        console.error('[DEBUG] Archive modal element not found!');
        return;
    }

    console.log('[DEBUG] Removing hidden class from modal');
    console.log('[DEBUG] Modal classList before:', els.archiveModal.classList.toString());
    els.archiveModal.classList.remove("hidden");
    console.log('[DEBUG] Modal classList after:', els.archiveModal.classList.toString());
    console.log('[DEBUG] Modal display:', window.getComputedStyle(els.archiveModal).display);
}

function closeArchiveModal() {
    if (!els.archiveModal) {
        return;
    }
    els.archiveModal.classList.add("hidden");
}

function openRulesModal() {
    els.rulesModal.classList.remove("hidden");
}

function closeRulesModal() {
    els.rulesModal.classList.add("hidden");
}

function timelinePointerToSec(event) {
    if (!els.timelineSurface) {
        return 0;
    }
    const rect = els.timelineSurface.getBoundingClientRect();
    if (!rect.width) {
        return clampTimelineSec(state.timelineCurrentSec);
    }
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    return clampTimelineSec(ratio * timelineDurationSec());
}

function seekTimeline(nextSec, { restartIfPlaying = true } = {}) {
    if (state.phase !== "solved") {
        setStatusMessage("Timeline seeking unlocks after solving the theme.", "warn");
        return;
    }
    state.timelineCurrentSec = clampTimelineSec(nextSec);
    renderTimeline();

    if (restartIfPlaying && state.isTimelinePlaying) {
        pauseTransportPlayback();
        playTimelineFromCursor();
    }
}

function wireEvents() {
    console.log('[DEBUG] wireEvents() called');

    if (els.archiveBtn) {
        console.log('[DEBUG] Attaching click listener to archive button');
        els.archiveBtn.addEventListener("click", openArchiveModal);
    } else {
        console.error('[DEBUG] Archive button not found!');
    }

    if (els.archiveCloseBtn) {
        els.archiveCloseBtn.addEventListener("click", closeArchiveModal);
    }

    if (els.archiveModal) {
        els.archiveModal.addEventListener("click", (event) => {
            if (event.target === els.archiveModal) {
                closeArchiveModal();
            }
        });
    }

    if (els.transportPlayBtn) {
        els.transportPlayBtn.addEventListener("click", () => {
            onTransportPlayPause();
        });
    }

    // Cassette click to start
    if (els.cassette) {
        els.cassette.addEventListener("click", async () => {
            if (state.phase === "ready" && !state.startedAtMs) {
                await onStartRound();
            }
        });
    }

    if (els.timelineSurface) {
        els.timelineSurface.addEventListener("click", (event) => {
            seekTimeline(timelinePointerToSec(event));
        });

        els.timelineSurface.addEventListener("keydown", (event) => {
            if (state.phase !== "solved") {
                return;
            }
            const duration = timelineDurationSec() || 60;
            if (event.key === "ArrowLeft") {
                event.preventDefault();
                seekTimeline(state.timelineCurrentSec - 1, { restartIfPlaying: false });
            } else if (event.key === "ArrowRight") {
                event.preventDefault();
                seekTimeline(state.timelineCurrentSec + 1, { restartIfPlaying: false });
            } else if (event.key === "Home") {
                event.preventDefault();
                seekTimeline(0, { restartIfPlaying: false });
            } else if (event.key === "End") {
                event.preventDefault();
                seekTimeline(duration, { restartIfPlaying: false });
            } else if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                if (state.isTimelinePlaying) {
                    pauseTransportPlayback();
                } else {
                    playTimelineFromCursor();
                }
            }
        });
    }

    if (els.guessForm) {
        els.guessForm.addEventListener("submit", async (event) => {
            event.preventDefault();
            if (!state.puzzle) {
                setStatusMessage("Pick a tape from Archive first.", "warn");
                return;
            }

            const value = els.guessInput.value;

            if (!state.startedAtMs) {
                const started = await onStartRound();
                if (!started) {
                    return;
                }
                if (!value.trim()) {
                    els.guessInput.focus();
                    return;
                }
            }

            const outcome = submitGuess(els.guessInput.value);
            if (outcome === "wrong") {
                els.guessInput.value = "";
            }
            els.guessInput.focus();
        });
    }

    if (els.rulesBtn) {
        els.rulesBtn.addEventListener("click", openRulesModal);
    }

    if (els.rulesCloseBtn) {
        els.rulesCloseBtn.addEventListener("click", closeRulesModal);
    }

    if (els.shareBtn) {
        els.shareBtn.addEventListener("click", shareResults);
    }

    if (els.rulesModal) {
        els.rulesModal.addEventListener("click", (event) => {
            if (event.target === els.rulesModal) {
                closeRulesModal();
            }
        });
    }

    window.addEventListener("keydown", (event) => {
        if (event.code === "Escape") {
            closeRulesModal();
            closeArchiveModal();
        }
    });

    window.addEventListener("resize", () => {
        renderTimelineWaveform();
    });
}

async function init() {
    try {
        console.log('[DEBUG] init() called');
        wireEvents();
        render();

        try {
            console.log('[DEBUG] Calling setupTapePicker()...');
            await setupTapePicker();
            console.log('[DEBUG] setupTapePicker() completed');
        } catch (error) {
            console.error('[DEBUG] Error in setupTapePicker():', error);
            state.phase = "missing";
            setStatusMessage(error.message || "Failed to load puzzle.", "bad");
        }

        render();
        console.log('[DEBUG] init() completed');
    } catch (error) {
        console.error('[FATAL ERROR] in init():', error);
        console.error(error.stack);
    }
}

init();
