const DAILY_INDEX_PATH = "data/daily-puzzles.json";
const MIXTAPE_MANIFEST_PATH = "mixtapes/index.json";
const STORAGE_PREFIX = "mystery-mixtape.v1";
const WRONG_GUESS_PENALTY_SECONDS = 10;
const CLIP_PLAY_SECONDS = 10;
const BUZZ_WINDOW_MS = 5000;
const RULES_COOKIE_NAME = "mystery_mixtape_hide_rules";
const COMPLETION_COOKIE_PREFIX = "mystery_mixtape_completion_";
const COMPLETION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 5;
const SETTINGS_STORAGE_KEY = `${STORAGE_PREFIX}.settings`;

const els = {
    puzzleDate: document.getElementById("puzzle-date"),
    archiveBtn: document.getElementById("archive-btn"),
    archiveModal: document.getElementById("archive-modal"),
    archiveCloseBtn: document.getElementById("archive-close-btn"),
    archiveList: document.getElementById("archive-list"),
    clueTitle: document.getElementById("clue-title"),
    clueText: document.getElementById("clue-text"),
    cassette: document.getElementById("mixtape-cassette"),
    wheelLeft: document.getElementById("wheel-left"),
    wheelRight: document.getElementById("wheel-right"),
    cassetteStatus: document.getElementById("cassette-status"),
    cassetteClue: document.getElementById("cassette-clue"),
    cassetteTapeNumber: document.getElementById("cassette-tape-number"),
    cassetteStartPrompt: document.getElementById("cassette-start-prompt"),
    cassetteTransportFlash: document.getElementById("cassette-transport-flash"),
    startBtn: document.getElementById("start-btn"),
    transportRow: document.getElementById("transport-row"),
    timelineSurface: document.getElementById("timeline-surface"),
    timelineWaveform: document.getElementById("timeline-waveform"),
    timelineSegments: document.getElementById("timeline-segments"),
    timelineTimeLeft: document.getElementById("timeline-time-left"),
    timelineTimeRight: document.getElementById("timeline-time-right"),
    roundMeta: document.getElementById("round-meta"),
    guessForm: document.getElementById("answer-text"),
    guessInput: document.getElementById("guess-input"),
    guessSubmitBtn: document.querySelector(".guess-submit-btn"),
    giveUpBtn: document.getElementById("give-up-btn"),
    wrongGuessesWrap: document.getElementById("wrong-guesses-wrap"),
    wrongGuessesList: document.getElementById("wrong-guesses-list"),
    revealPanel: document.getElementById("reveal-panel"),
    revealList: document.getElementById("song-reveal-list"),
    answerText: document.getElementById("answer-text"),
    shareBtn: document.getElementById("share-btn"),
    confettiLayer: document.getElementById("confetti-layer"),
    rulesBtn: document.getElementById("rules-btn"),
    settingsBtn: document.getElementById("settings-btn"),
    settingsModal: document.getElementById("settings-modal"),
    settingsCloseBtn: document.getElementById("settings-close-btn"),
    settingsDisablePulse: document.getElementById("settings-disable-pulse"),
    rulesModal: document.getElementById("rules-modal"),
    rulesCloseBtn: document.getElementById("rules-close-btn"),
    rulesHideCheckbox: document.getElementById("rules-hide-checkbox")
};

const state = {
    dateKey: "",
    manifestPacks: [],
    selectedPackSlug: "",
    selectedTapeKey: "",
    selectedTapePath: "",
    selectedPackLabel: "",
    selectedTapeNumber: null,
    selectedReleaseDate: "",
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
    timelineTickRafId: null,
    timelineTickStartSec: 0,
    timelineTickStartMs: 0,
    buzzActive: false,
    buzzDeadlineMs: 0,
    buzzTimerIntervalId: null,
    timelineWaveformPeaks: [],
    timelineWaveformBaselines: [],
    timelineWaveformToken: 0,
    maxHeardSec: 0,
    timelineHoverSec: null,
    timelineScrubPointerId: null,
    timelineScrubWasPlaying: false,
    isTimelineScrubbing: false,
    wheelLeftAngleDeg: 0,
    wheelRightAngleDeg: 0,
    activePlayMs: 0,
    activePlayStartedAtMs: null,
    preserveTimelinePositionOnStop: false,
    revealRenderedToken: "",
    revealAnimationPlayed: false,
    sourceLabel: "",
    sourceBasePath: "",
    persistProgress: true,
    disableCassettePulse: false
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

function escapeHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function applyBoldAskToken(clue, askText) {
    const source = String(clue || "");
    const ask = String(askText || "").trim();
    if (!ask) {
        return source;
    }

    const parts = ask
        .split(/\s+/)
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

    if (!parts.length) {
        return source;
    }

    // Match phrase in a tolerant way so minor punctuation/spacing differences still bold correctly.
    const pattern = parts.join("[^A-Za-z0-9]+?");
    const matchResult = new RegExp(pattern, "i").exec(source);
    if (!matchResult || matchResult.index < 0) {
        return source;
    }

    const index = matchResult.index;
    const matchedText = matchResult[0];
    const head = source.slice(0, index);
    const match = source.slice(index, index + matchedText.length);
    const tail = source.slice(index + matchedText.length);
    return `${head}**${match}**${tail}`;
}

function clueToSafeHtml(clueText, clueAskBold) {
    const rawClue = String(clueText || "");
    const clueWithAsk = rawClue.includes("**")
        ? rawClue
        : applyBoldAskToken(rawClue, clueAskBold);
    const parts = clueWithAsk.split(/(\*\*[^*]+\*\*)/g);

    return parts
        .map((part) => {
            if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
                return `<strong>${escapeHtml(part.slice(2, -2))}</strong>`;
            }
            return escapeHtml(part);
        })
        .join("");
}

function isLikelySafeHttpUrl(value) {
    try {
        const parsed = new URL(String(value || ""));
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch (error) {
        return false;
    }
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
    const today = getAestDateKey();

    for (const pack of state.manifestPacks) {
        const source = await loadIndexForMixtape(pack.slug, pack.label);
        const tapes = extractTapeEntries(source.dailyIndex);

        // Extract tape number from slug (e.g., "tape 8" -> 8)
        const tapeNumberMatch = pack.slug.match(/\d+/);
        const tapeNumber = tapeNumberMatch ? parseInt(tapeNumberMatch[0]) : null;

        for (const tape of tapes) {
            // Only show tapes whose date has arrived (or passed)
            if (tape.key > today) {
                continue;
            }

            const completion = getTapeCompletionRecord(pack.slug, tape.key);

            const clue = await fetchArchiveClue(source.basePath, tape.path);
            entries.push({
                packSlug: pack.slug,
                packLabel: pack.label,
                basePath: source.basePath,
                tapeKey: tape.key,
                tapePath: tape.path,
                tapeNumber: tapeNumber,
                releaseDate: tape.key,
                clue,
                completion
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
        const completion = getTapeCompletionRecord(item.packSlug, item.tapeKey);
        const row = document.createElement("button");
        row.type = "button";
        row.className = "archive-tape-row";
        row.dataset.packSlug = item.packSlug;
        row.dataset.tapeKey = item.tapeKey;
        row.innerHTML = `
            <span class="archive-tape-id">${item.packLabel} / ${item.tapeKey}</span>
            <span class="archive-tape-info">
                <span class="archive-tape-clue">${item.clue}</span>
                <span class="archive-tape-result ${completion ? `result-${completion.result}` : ""}">${completion ? formatCompletionSummary(completion) : "Not played"}</span>
            </span>
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

function getCookieValue(name) {
    const target = `${encodeURIComponent(name)}=`;
    const parts = document.cookie ? document.cookie.split(";") : [];
    for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.startsWith(target)) {
            return decodeURIComponent(trimmed.slice(target.length));
        }
    }
    return "";
}

function setCookieValue(name, value, maxAgeSeconds) {
    document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSeconds}; SameSite=Lax`;
}

function clearCookieValue(name) {
    document.cookie = `${encodeURIComponent(name)}=; path=/; max-age=0; SameSite=Lax`;
}

function encodeCookieSuffix(value) {
    return String(value || "")
        .trim()
        .replace(/[^a-z0-9]+/gi, "_")
        .replace(/^_+|_+$/g, "") || "unknown";
}

function completionCookieName(packSlug, tapeKey) {
    return `${COMPLETION_COOKIE_PREFIX}${encodeCookieSuffix(packSlug)}__${encodeCookieSuffix(tapeKey)}`;
}

function getTapeCompletionRecord(packSlug, tapeKey) {
    const serialized = getCookieValue(completionCookieName(packSlug, tapeKey));
    if (!serialized) {
        return null;
    }

    try {
        const parsed = JSON.parse(serialized);
        if (parsed && typeof parsed === "object") {
            return parsed;
        }
    } catch (error) {
        return null;
    }

    return null;
}

function setTapeCompletionRecord({ packSlug, tapeKey, result, wrongGuesses = 0, guesses = 0, scoreSeconds = 0 }) {
    if (!packSlug || !tapeKey || !result) {
        return;
    }

    const payload = {
        result,
        wrongGuesses: Number(wrongGuesses || 0),
        guesses: Number(guesses || 0),
        scoreSeconds: Number(scoreSeconds || 0),
        completedAt: nowMs()
    };

    setCookieValue(completionCookieName(packSlug, tapeKey), JSON.stringify(payload), COMPLETION_COOKIE_MAX_AGE_SECONDS);
}

function formatCompletionSummary(record) {
    if (!record || typeof record !== "object") {
        return "";
    }

    const resultLabel = record.result === "solved" ? "Solved" : record.result === "gaveup" ? "DNF" : "Completed";
    const details = [];
    if (Number.isFinite(Number(record.guesses)) && Number(record.guesses) > 0) {
        details.push(`${Number(record.guesses)} guess${Number(record.guesses) === 1 ? "" : "es"}`);
    }
    if (Number.isFinite(Number(record.wrongGuesses)) && Number(record.wrongGuesses) > 0) {
        details.push(`${Number(record.wrongGuesses)} wrong`);
    }
    if (Number.isFinite(Number(record.scoreSeconds)) && Number(record.scoreSeconds) > 0) {
        details.push(formatClock(Math.floor(Number(record.scoreSeconds))));
    }

    return details.length ? `${resultLabel} • ${details.join(" • ")}` : resultLabel;
}

function shouldAutoShowRules() {
    return false;
}

function getActiveElapsedMs() {
    return Math.max(0, Math.floor(clampTimelineSec(state.timelineCurrentSec) * 1000));
}

function startActivePlayTimerIfNeeded() {
    if (state.activePlayStartedAtMs) {
        return;
    }
    if (state.phase === "solved" || state.phase === "gaveup") {
        return;
    }
    state.activePlayStartedAtMs = nowMs();
}

function stopActivePlayTimer() {
    if (!state.activePlayStartedAtMs) {
        return;
    }
    state.activePlayMs += Math.max(0, nowMs() - state.activePlayStartedAtMs);
    state.activePlayStartedAtMs = null;
}

function elapsedSeconds() {
    if (!state.startedAtMs) {
        return 0;
    }
    return Math.max(0, Math.floor(clampTimelineSec(state.timelineCurrentSec)));
}

function currentScoreSeconds() {
    return elapsedSeconds() + state.wrongGuesses * WRONG_GUESS_PENALTY_SECONDS;
}

function formatClock(totalSeconds) {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatClockCompact(totalSeconds) {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}:${String(secs).padStart(2, "0")}`;
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

function showCassetteTransportFlash(mode) {
    if (!els.cassetteTransportFlash) {
        return;
    }
    const symbol = mode === "pause" ? "❚❚" : "▶";
    els.cassetteTransportFlash.textContent = symbol;
    els.cassetteTransportFlash.classList.remove("flash");
    // Force reflow so repeated toggles restart the animation.
    void els.cassetteTransportFlash.offsetWidth;
    els.cassetteTransportFlash.classList.add("flash");
}

function capitalizeFirstLetter(value) {
    const text = String(value || "").trim();
    if (!text) {
        return "";
    }
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function playCassetteTransportClick(mode) {
    try {
        const ctx = getAudioContext();
        if (ctx.state === "suspended") {
            ctx.resume().catch(() => {
                // Ignore resume failures; clicks are non-critical.
            });
        }

        const now = ctx.currentTime;
        const gain = ctx.createGain();
        const highpass = ctx.createBiquadFilter();
        highpass.type = "highpass";
        highpass.frequency.setValueAtTime(mode === "pause" ? 540 : 760, now);

        const noiseBuffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * 0.045)), ctx.sampleRate);
        const data = noiseBuffer.getChannelData(0);
        for (let i = 0; i < data.length; i += 1) {
            const decay = 1 - (i / data.length);
            data[i] = (Math.random() * 2 - 1) * decay;
        }

        const noise = ctx.createBufferSource();
        noise.buffer = noiseBuffer;

        const thump = ctx.createOscillator();
        thump.type = "triangle";
        thump.frequency.setValueAtTime(mode === "pause" ? 140 : 180, now);

        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.linearRampToValueAtTime(0.1, now + 0.002);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);

        noise.connect(highpass);
        thump.connect(highpass);
        highpass.connect(gain);
        gain.connect(ctx.destination);

        noise.start(now);
        noise.stop(now + 0.045);
        thump.start(now);
        thump.stop(now + 0.03);
    } catch (error) {
        // Ignore click synthesis errors to avoid blocking gameplay interactions.
    }
}

function getTimelineAmplitudeAtSec(sec) {
    const tracks = state.timelineWaveformPeaks;
    if (!Array.isArray(tracks) || !tracks.length) {
        return 0;
    }
    const duration = timelineDurationSec();
    const clampedSec = Math.max(0, Math.min(duration, Number(sec) || 0));
    const trackIndex = Math.min(tracks.length - 1, Math.floor(clampedSec / CLIP_PLAY_SECONDS));
    const peaks = tracks[trackIndex];
    if (!(peaks instanceof Float32Array) || !peaks.length) {
        return 0;
    }
    const trackStartSec = trackIndex * CLIP_PLAY_SECONDS;
    const localTrackRatio = Math.max(0, Math.min(0.999, (clampedSec - trackStartSec) / CLIP_PLAY_SECONDS));
    const sampleIndex = Math.min(peaks.length - 1, Math.floor(localTrackRatio * peaks.length));
    const amp = Math.max(0, Math.min(1, Number(peaks[sampleIndex]) || 0));
    const baselineTrack = state.timelineWaveformBaselines[trackIndex];
    const baseline = baselineTrack instanceof Float32Array
        ? Math.max(0, Math.min(0.95, Number(baselineTrack[sampleIndex]) || 0))
        : Math.max(0, Math.min(0.95, Number(baselineTrack) || 0));
    const relative = (amp - baseline) / Math.max(0.05, 1 - baseline);
    return Math.max(0, Math.min(1, relative));
}

function estimateTrackBaseline(peaks) {
    if (!(peaks instanceof Float32Array) || !peaks.length) {
        return 0.18;
    }
    const sorted = Array.from(peaks).sort((a, b) => a - b);
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * 0.55)));
    return Math.max(0.06, Math.min(0.85, sorted[idx]));
}

function buildAdaptiveBaselineEnvelope(peaks, radius = 10) {
    if (!(peaks instanceof Float32Array) || !peaks.length) {
        return new Float32Array(0);
    }
    const baseline = new Float32Array(peaks.length);
    const windowRadius = Math.max(2, Math.floor(radius));

    for (let i = 0; i < peaks.length; i += 1) {
        const start = Math.max(0, i - windowRadius);
        const end = Math.min(peaks.length - 1, i + windowRadius);
        const window = [];
        for (let j = start; j <= end; j += 1) {
            window.push(peaks[j]);
        }
        window.sort((a, b) => a - b);
        const floorIdx = Math.max(0, Math.min(window.length - 1, Math.floor(window.length * 0.3)));
        baseline[i] = window[floorIdx];
    }

    for (let i = 0; i < baseline.length; i += 1) {
        baseline[i] = Math.max(0.04, Math.min(0.86, baseline[i]));
    }

    return baseline;
}

function renderCassetteMotion() {
    const timelineSec = clampTimelineSec(state.timelineCurrentSec);
    // Keep wheel angle deterministic from timeline position so pause/resume never resets.
    state.wheelLeftAngleDeg = timelineSec * 156;
    state.wheelRightAngleDeg = -timelineSec * 119;

    if (els.wheelLeft) {
        els.wheelLeft.style.transform = `rotate(${state.wheelLeftAngleDeg.toFixed(3)}deg)`;
    }
    if (els.wheelRight) {
        els.wheelRight.style.transform = `rotate(${state.wheelRightAngleDeg.toFixed(3)}deg)`;
    }

    const isPlaying = state.isSequencePlaying || state.isTimelinePlaying;
    const amp = isPlaying ? getTimelineAmplitudeAtSec(timelineSec) : 0;
    const beatEnergy = Math.max(0, (amp - 0.04) / 0.96);
    const pulseScale = state.disableCassettePulse
        ? 1
        : (isPlaying ? 1 + Math.pow(beatEnergy, 0.66) * 0.0225 : 1);
    if (els.cassette) {
        els.cassette.style.setProperty("--cassette-pulse-scale", pulseScale.toFixed(4));
    }
}

function fitCassetteClueText() {
    if (!els.cassetteClue) {
        return;
    }
    const clueEl = els.cassetteClue;
    clueEl.style.removeProperty("--cassette-clue-size");

    const computed = window.getComputedStyle(clueEl);
    const startSize = Math.max(10, parseFloat(computed.fontSize) || 16);
    let nextSize = startSize;
    const minSize = 8;

    clueEl.style.setProperty("--cassette-clue-size", `${nextSize}px`);

    for (let i = 0; i < 26; i += 1) {
        const tooTall = clueEl.scrollHeight > clueEl.clientHeight + 1;
        const tooWide = clueEl.scrollWidth > clueEl.clientWidth + 1;
        if (!tooTall && !tooWide) {
            break;
        }
        nextSize = Math.max(minSize, nextSize - 0.6);
        clueEl.style.setProperty("--cassette-clue-size", `${nextSize}px`);
        if (nextSize <= minSize) {
            break;
        }
    }
}

function persistSettings() {
    const payload = {
        disableCassettePulse: Boolean(state.disableCassettePulse)
    };
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(payload));
}

function hydrateSettings() {
    const serialized = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!serialized) {
        return;
    }
    try {
        const parsed = JSON.parse(serialized);
        if (parsed && typeof parsed === "object") {
            state.disableCassettePulse = Boolean(parsed.disableCassettePulse);
        }
    } catch (error) {
        // Ignore malformed settings and continue with defaults.
    }
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

    const bassSignal = new Float32Array(data.length);
    const lowPassHz = 185;
    const alpha = Math.exp((-2 * Math.PI * lowPassHz) / Math.max(1, buffer.sampleRate));
    let low = 0;
    for (let i = 0; i < data.length; i += 1) {
        low = alpha * low + (1 - alpha) * data[i];
        bassSignal[i] = low;
    }

    const samplesPerBin = Math.max(1, Math.floor(data.length / bins));
    for (let i = 0; i < bins; i += 1) {
        const start = i * samplesPerBin;
        const end = Math.min(data.length, start + samplesPerBin);
        let sumAbs = 0;
        let sumBassAbs = 0;
        let count = 0;
        for (let j = start; j < end; j += 1) {
            sumAbs += Math.abs(data[j]);
            sumBassAbs += Math.abs(bassSignal[j]);
            count += 1;
        }
        const fullBand = count ? sumAbs / count : 0;
        const bassBand = count ? sumBassAbs / count : 0;
        peaks[i] = Math.max(0, (fullBand * 0.32) + (bassBand * 0.68));
    }

    let maxPeak = 0;
    for (let i = 0; i < peaks.length; i += 1) {
        if (peaks[i] > maxPeak) {
            maxPeak = peaks[i];
        }
    }
    if (maxPeak > 0) {
        for (let i = 0; i < peaks.length; i += 1) {
            peaks[i] = Math.min(1, peaks[i] / maxPeak);
        }
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

    const duration = timelineDurationSec();
    const isTerminalPhase = state.phase === "solved" || state.phase === "gaveup";
    const reachedSec = isTerminalPhase
        ? Math.max(0, Math.min(duration, state.timelineCurrentSec))
        : Math.max(0, Math.min(duration, state.maxHeardSec));

    const deviceScale = canvas.getBoundingClientRect().width > 0 ? width / canvas.getBoundingClientRect().width : 1;
    const edgePad = Math.max(0, Math.round(12 * deviceScale));
    const usedWidth = Math.max(1, width - edgePad * 2);
    const totalBars = Math.max(1, usedWidth);
    const stepWidth = usedWidth / totalBars;
    const offsetX = edgePad;

    if (els.timelineSegments) {
        els.timelineSegments.style.setProperty("--wave-offset-x", `${offsetX}px`);
    }

    const tintColor = new Array(totalBars).fill(null);
    const tintAlpha = new Array(totalBars).fill(0);
    const trail = [1, 0.9, 0.78, 0.66, 0.54, 0.42, 0.3, 0.22, 0.16, 0.1, 0.06];

    if (duration > 0 && state.startedAtMs && Array.isArray(state.guesses)) {
        for (const guess of state.guesses) {
            if (!guess) {
                continue;
            }
            const guessSec = typeof guess.timelineSec === "number"
                ? guess.timelineSec
                : typeof guess.atMs === "number"
                    ? Math.max(0, Math.min(duration, (guess.atMs - state.startedAtMs) / 1000))
                    : 0;
            const relSec = Math.max(0, Math.min(duration, guessSec));
            const startIndex = Math.max(0, Math.min(totalBars - 1, Math.floor((relSec / duration) * totalBars)));
            const color = guess.result === "correct" ? "74, 222, 128" : "251, 113, 133";
            for (let i = 0; i < trail.length; i += 1) {
                const idx = startIndex + i;
                if (idx >= totalBars) {
                    break;
                }
                if (trail[i] > tintAlpha[idx]) {
                    tintAlpha[idx] = trail[i];
                    tintColor[idx] = color;
                }
            }
        }
    }

    const mainHeight = Math.max(1, Math.floor(height * 0.75));
    const reflectionHeight = Math.max(1, height - mainHeight);
    const reflectionScale = 1 / 3;
    let hoverStartSec = null;
    let hoverEndSec = null;

    if (isTerminalPhase && Number.isFinite(state.timelineHoverSec) && duration > 0) {
        hoverStartSec = Math.max(0, Math.min(duration, Math.min(state.timelineCurrentSec, state.timelineHoverSec)));
        hoverEndSec = Math.max(0, Math.min(duration, Math.max(state.timelineCurrentSec, state.timelineHoverSec)));
    }

    for (let globalBarIndex = 0; globalBarIndex < totalBars; globalBarIndex += 1) {
        const secAtPoint = duration > 0 ? (globalBarIndex / Math.max(1, totalBars - 1)) * duration : 0;
        const reached = secAtPoint <= reachedSec;
        const inHoverSpan = hoverStartSec !== null && hoverEndSec !== null && secAtPoint >= hoverStartSec && secAtPoint <= hoverEndSec;
        const x = offsetX + Math.floor(globalBarIndex * stepWidth);
        const nextX = globalBarIndex === totalBars - 1 ? offsetX + usedWidth : offsetX + Math.floor((globalBarIndex + 1) * stepWidth);
        const barWidth = Math.max(1, nextX - x);

        const trackIndex = Math.min(tracks.length - 1, Math.floor(secAtPoint / CLIP_PLAY_SECONDS));
        const peaks = tracks[trackIndex];
        let amp = 0.08;
        if (peaks instanceof Float32Array && peaks.length) {
            const trackStartSec = trackIndex * CLIP_PLAY_SECONDS;
            const localTrackRatio = Math.max(0, Math.min(0.999, (secAtPoint - trackStartSec) / CLIP_PLAY_SECONDS));
            const sampleIndex = Math.min(peaks.length - 1, Math.floor(localTrackRatio * peaks.length));
            amp = Math.max(0.14, Math.min(0.98, Math.pow(peaks[sampleIndex], 0.52)));
        }

        const barHeight = Math.max(1, Math.floor(amp * Math.max(1, mainHeight - 2)));
        const mainY = mainHeight - barHeight;
        if (reached) {
            ctx.fillStyle = inHoverSpan ? "rgba(222, 226, 232, 0.92)" : "rgba(255,255,255,0.88)";
        } else {
            ctx.fillStyle = inHoverSpan ? "rgba(146, 98, 106, 0.92)" : "rgba(118, 52, 58, 0.92)";
        }
        ctx.fillRect(x, mainY, barWidth, barHeight);

        const reflectedBarHeight = Math.max(1, Math.floor(barHeight * reflectionScale));
        if (reached) {
            ctx.fillStyle = inHoverSpan ? "rgba(176, 184, 196, 0.48)" : "rgba(255,255,255,0.38)";
        } else {
            ctx.fillStyle = inHoverSpan ? "rgba(106, 60, 68, 0.62)" : "rgba(85, 37, 43, 0.56)";
        }
        ctx.fillRect(x, mainHeight, barWidth, Math.min(reflectionHeight, reflectedBarHeight));

        const tint = tintColor[globalBarIndex];
        const alpha = tintAlpha[globalBarIndex];
        if (tint && alpha > 0) {
            const tintOpacity = Math.min(0.6, 0.14 + alpha * 0.4);
            ctx.fillStyle = `rgba(${tint}, ${tintOpacity})`;
            ctx.fillRect(x, 0, barWidth, height);
        }
    }

}

async function buildTimelineWaveformData() {
    if (!state.puzzle || !Array.isArray(state.puzzle.songs)) {
        state.timelineWaveformPeaks = [];
        state.timelineWaveformBaselines = [];
        renderTimelineWaveform();
        return;
    }

    const token = ++state.timelineWaveformToken;
    state.timelineWaveformPeaks = new Array(state.puzzle.songs.length).fill(null);
    state.timelineWaveformBaselines = new Array(state.puzzle.songs.length).fill(null);
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
            const envelope = buildAdaptiveBaselineEnvelope(state.timelineWaveformPeaks[i], 11);
            if (envelope.length) {
                state.timelineWaveformBaselines[i] = envelope;
            } else {
                state.timelineWaveformBaselines[i] = estimateTrackBaseline(state.timelineWaveformPeaks[i]);
            }
            renderTimelineWaveform();
        } catch (error) {
            // Ignore waveform extraction failures per clip; playback errors are handled elsewhere.
        }
    }
}

function stopTimelineTick() {
    if (state.timelineTickIntervalId) {
        clearInterval(state.timelineTickIntervalId);
        state.timelineTickIntervalId = null;
    }
    if (state.timelineTickRafId) {
        cancelAnimationFrame(state.timelineTickRafId);
        state.timelineTickRafId = null;
    }
}

function startTimelineTick(startSec, segmentDurationSec) {
    stopTimelineTick();
    state.timelineTickStartSec = clampTimelineSec(startSec);
    state.timelineTickStartMs = nowMs();

    const step = () => {
        const elapsed = (nowMs() - state.timelineTickStartMs) / 1000;
        state.timelineCurrentSec = clampTimelineSec(
            Math.min(state.timelineTickStartSec + elapsed, state.timelineTickStartSec + segmentDurationSec)
        );
        if (state.phase !== "solved" && state.phase !== "gaveup") {
            state.maxHeardSec = Math.max(state.maxHeardSec, state.timelineCurrentSec);
        }
        renderTimeline();

        if (elapsed < segmentDurationSec && (state.isSequencePlaying || state.isTimelinePlaying)) {
            state.timelineTickRafId = requestAnimationFrame(step);
        } else {
            state.timelineTickRafId = null;
        }
    };

    state.timelineTickRafId = requestAnimationFrame(step);
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
        segment.textContent = `Song ${i + 1}`;
        els.timelineSegments.appendChild(segment);
    }
}

function renderTimeline() {
    const duration = timelineDurationSec();
    const timelineInteractive = state.phase === "solved" || state.phase === "gaveup";
    const clampedSec = clampTimelineSec(state.timelineCurrentSec);

    if (els.timelineSurface) {
        els.timelineSurface.classList.toggle("seekable", timelineInteractive);
        els.timelineSurface.setAttribute("aria-disabled", timelineInteractive ? "false" : "true");
        els.timelineSurface.setAttribute("aria-valuemin", "0");
        els.timelineSurface.setAttribute("aria-valuemax", String(Math.floor(duration || 60)));
        els.timelineSurface.setAttribute("aria-valuenow", String(Math.floor(clampedSec)));
        els.timelineSurface.setAttribute(
            "aria-valuetext",
            `${formatClockCompact(Math.floor(clampedSec))} / ${formatClockCompact(Math.floor(duration || 60))}`
        );
    }

    if (els.timelineTimeLeft) {
        els.timelineTimeLeft.textContent = formatClockCompact(Math.floor(clampedSec));
    }

    if (els.timelineTimeRight) {
        els.timelineTimeRight.textContent = formatClockCompact(Math.floor(duration || 60));
    }

    renderTimelineWaveform();
    renderCassetteMotion();
    renderTimelineSegments();
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
        activePlayMs: state.activePlayMs,
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
            state.activePlayMs = Number(parsed.activePlayMs || 0);
            state.activePlayStartedAtMs = null;
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

                // Ignore stale clip-end cursor updates after a manual seek/pause changed tokens.
                if (token === state.sequencePlaybackToken) {
                    if (state.preserveTimelinePositionOnStop) {
                        const playedSec = Math.max(0, (nowMs() - playStartedMs) / 1000);
                        state.timelineCurrentSec = clampTimelineSec(timelineStartSec + Math.min(duration, playedSec));
                        state.preserveTimelinePositionOnStop = false;
                    } else {
                        state.timelineCurrentSec = clampTimelineSec(timelineStartSec + duration);
                    }
                    if (state.phase !== "solved" && state.phase !== "gaveup") {
                        state.maxHeardSec = Math.max(state.maxHeardSec, state.timelineCurrentSec);
                    }
                    renderTimeline();
                }

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

    showCassetteTransportFlash("play");
    playCassetteTransportClick("play");

    const duration = timelineDurationSec();
    let cursor = clampTimelineSec(startSec);
    if (cursor >= duration - 0.01) {
        cursor = 0;
    }

    state.sequencePlaybackToken += 1;
    const token = state.sequencePlaybackToken;
    state.isSequencePlaying = true;
    startActivePlayTimerIfNeeded();
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
        stopActivePlayTimer();
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

function pauseTransportPlayback({ showFlash = true, preservePosition = true } = {}) {
    if (showFlash) {
        showCassetteTransportFlash("pause");
        playCassetteTransportClick("pause");
    }
    stopActivePlayTimer();
    state.preserveTimelinePositionOnStop = Boolean(preservePosition);
    state.isSequencePlaying = false;
    state.isTimelinePlaying = false;
    state.sequencePlaybackToken += 1;
    state.timelinePlaybackToken += 1;
    stopAnyClip();
    render();
}

async function playTimelineFromCursor() {
    if (!state.puzzle || (state.phase !== "solved" && state.phase !== "gaveup")) {
        setStatusMessage("Timeline scrub is unlocked after solving or giving up.", "warn");
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

    showCassetteTransportFlash("play");
    playCassetteTransportClick("play");

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

    if (!state.puzzle) {
        setStatusMessage("Pick a tape from Archive first.", "warn");
        return;
    }

    if (state.isSequencePlaying || state.isTimelinePlaying) {
        pauseTransportPlayback();
        setStatusMessage("Playback paused.", "warn");
        return;
    }

    if (state.phase === "solved" || state.phase === "gaveup") {
        await playTimelineFromCursor();
        return;
    }

    const isInitialStart = !state.startedAtMs;
    if (isInitialStart && els.guessInput) {
        els.guessInput.focus();
    }

    await playMixtapeFromCursor(state.timelineCurrentSec);
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
        setStatusMessage("Press Play first.", "warn");
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
        stopActivePlayTimer();
        state.phase = "solved";
        state.endedAtMs = nowMs();
        state.guesses.push({ value: guess, result: "correct", atMs: state.endedAtMs, timelineSec: clampTimelineSec(state.timelineCurrentSec) });

        state.preserveTimelinePositionOnStop = true;
        state.sequencePlaybackToken += 1;
        state.isSequencePlaying = false;
        state.isTimelinePlaying = false;
        stopAnyClip();

        stopClock();
        triggerSuccessEffects();
        setTapeCompletionRecord({
            packSlug: state.selectedPackSlug,
            tapeKey: state.selectedTapeKey,
            result: "solved",
            wrongGuesses: state.wrongGuesses,
            guesses: state.guesses.length,
            scoreSeconds: currentScoreSeconds()
        });
        setStatusMessage("Correct. Theme solved.", "ok");
    } else {
        state.phase = "running";
        state.wrongGuesses += 1;
        state.guesses.push({ value: guess, result: "wrong", atMs: nowMs(), timelineSec: clampTimelineSec(state.timelineCurrentSec) });
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
    stopActivePlayTimer();
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

    setTapeCompletionRecord({
        packSlug: state.selectedPackSlug,
        tapeKey: state.selectedTapeKey,
        result: "gaveup",
        wrongGuesses: state.wrongGuesses,
        guesses: state.guesses.length,
        scoreSeconds: currentScoreSeconds()
    });

    setStatusMessage("Round ended. Marked as DNF.", "warn");
    persistGameState();
    render();
}

function renderRoundMeta() {
    if (els.roundMeta) {
        els.roundMeta.textContent = "";
    }
}

function renderGiveUpButton() {
    if (!els.giveUpBtn) {
        return;
    }

    const show = Boolean(state.puzzle)
        && state.phase !== "solved"
        && state.phase !== "gaveup"
        && elapsedSeconds() >= 60;

    els.giveUpBtn.classList.toggle("hidden", !show);
}

function renderAnswerLine() {
    if (!els.answerText || !els.guessInput) {
        return;
    }

    const isTerminal = state.phase === "solved" || state.phase === "gaveup";
    els.answerText.classList.toggle("answer-revealed", isTerminal);

    if (isTerminal && state.puzzle) {
        els.guessInput.value = capitalizeFirstLetter(state.puzzle.theme);
        els.guessInput.disabled = true;
    } else if (!state.puzzle) {
        els.guessInput.value = "";
    }
}

function renderShareCta() {
    if (!els.shareBtn) {
        return;
    }
    const shareText = generateShareText();
    if (!shareText) {
        els.shareBtn.textContent = "Share text unavailable";
        els.shareBtn.disabled = true;
        return;
    }
    els.shareBtn.textContent = shareText;
    els.shareBtn.disabled = false;
}

function renderReveal() {
    const isTerminal = state.phase === "solved" || state.phase === "gaveup";
    els.revealPanel.classList.toggle("hidden", !isTerminal);

    if (!isTerminal || !state.puzzle) {
        return;
    }

    renderShareCta();

    const revealToken = `${state.selectedPackSlug}|${state.selectedTapeKey}|${state.phase}`;
    if (state.revealRenderedToken === revealToken) {
        return;
    }
    state.revealRenderedToken = revealToken;
    const shouldAnimateRows = !state.revealAnimationPlayed;

    els.revealList.innerHTML = "";

    const header = document.createElement("div");
    header.className = "reveal-row head";
    ["#", "Song Title", "Artist(s)", "Link"].forEach((label) => {
        const cell = document.createElement("div");
        cell.textContent = label;
        header.appendChild(cell);
    });
    els.revealList.appendChild(header);

    state.puzzle.songs.forEach((song, index) => {
        const row = document.createElement("div");
        row.className = shouldAnimateRows ? "reveal-row reveal-animate" : "reveal-row";
        if (shouldAnimateRows) {
            row.style.animationDelay = `${index * 90}ms`;
        }

        const indexCell = document.createElement("div");
        indexCell.textContent = String(index + 1);

        const titleCell = document.createElement("div");
        titleCell.textContent = song.title;

        const artistCell = document.createElement("div");
        artistCell.textContent = song.artist;

        const linkCell = document.createElement("div");
        if (isLikelySafeHttpUrl(song.link)) {
            const anchor = document.createElement("a");
            anchor.href = song.link;
            anchor.target = "_blank";
            anchor.rel = "noopener noreferrer";
            anchor.className = "reveal-link";
            anchor.textContent = "Open";
            linkCell.appendChild(anchor);
        } else {
            linkCell.textContent = "-";
        }

        row.append(indexCell, titleCell, artistCell, linkCell);
        els.revealList.appendChild(row);
    });

    if (shouldAnimateRows) {
        state.revealAnimationPlayed = true;
    }

}

function renderCassetteState() {
    const playable = state.phase !== "loading" && state.phase !== "missing";
    const terminal = state.phase === "solved" || state.phase === "gaveup";

    els.cassette.classList.toggle("playing", state.isSequencePlaying || state.isTimelinePlaying);
    els.cassette.classList.toggle("inactive", !playable || terminal);
    els.cassette.classList.toggle("flipped", terminal);

    // Show/hide click-to-start prompt
    const showStartPrompt = state.phase !== "solved"
        && state.phase !== "gaveup"
        && state.puzzle
        && !state.startedAtMs
        && !state.isSequencePlaying
        && !state.isTimelinePlaying;
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

function renderCassetteTapeNumber() {
    if (!els.cassetteTapeNumber) {
        return;
    }
    els.cassetteTapeNumber.classList.add("hidden");
    els.cassetteTapeNumber.textContent = "";
}

function renderTransportState() {
    const hasPuzzle = Boolean(state.puzzle);

    if (els.transportRow) {
        els.transportRow.classList.toggle("hidden", !hasPuzzle);
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
        li.textContent = capitalizeFirstLetter(guess.value);
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
            fitCassetteClueText();
        }
        return;
    }

    const clueText = state.puzzle.clue || defaultClue;
    els.clueTitle.textContent = "";
    els.clueText.textContent = "";
    if (els.cassetteClue) {
        const clueHtml = clueToSafeHtml(clueText, state.puzzle.clueAskBold || "");
        els.cassetteClue.innerHTML = `<span class="cassette-clue-text">${clueHtml}</span>`;
        fitCassetteClueText();
    }
}

function renderGuessInputState() {
    const terminal = state.phase === "solved" || state.phase === "gaveup";
    const playable = state.phase !== "loading" && state.phase !== "missing";
    const canGuess = playable && !terminal && Boolean(state.puzzle);
    els.guessInput.disabled = !canGuess;
    els.guessInput.classList.toggle("correct", state.phase === "solved");

    if (!state.puzzle) {
        els.guessInput.placeholder = "type answer here";
    } else {
        els.guessInput.placeholder = "type answer here";
    }
}

function render() {
    renderClue();
    renderRoundMeta();
    renderCassetteState();
    renderCassetteTapeNumber();
    renderTransportState();
    renderGuessInputState();
    renderGiveUpButton();
    renderAnswerLine();
    renderWrongGuesses();
    renderReveal();
}

function resetForNewTape() {
    pauseTransportPlayback({ showFlash: false });
    stopClock();
    state.isTimelineScrubbing = false;
    state.timelineScrubPointerId = null;
    state.timelineScrubWasPlaying = false;
    state.puzzle = null;
    state.phase = "ready";
    state.startedAtMs = null;
    state.endedAtMs = null;
    state.wrongGuesses = 0;
    state.guesses = [];
    state.timelineCurrentSec = 0;
    state.isTimelinePlaying = false;
    state.timelineWaveformPeaks = [];
    state.timelineWaveformBaselines = [];
    state.timelineWaveformToken += 1;
    state.timelineHoverSec = null;
    state.maxHeardSec = 0;
    state.wheelLeftAngleDeg = 0;
    state.wheelRightAngleDeg = 0;
    state.activePlayMs = 0;
    state.activePlayStartedAtMs = null;
    state.revealRenderedToken = "";
    state.revealAnimationPlayed = false;
    drawTimelineWaveformPlaceholder();
    if (els.guessInput) {
        els.guessInput.value = "";
        els.guessInput.placeholder = "type answer here";
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

    // Format date for display
    const dateObj = new Date(state.selectedReleaseDate + "T00:00:00");
    if (state.selectedTapeNumber) {
        const dayOnly = dateObj.toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            timeZone: 'Australia/Melbourne'
        });
        els.puzzleDate.innerHTML = `<span class="game-meta-title">Mystery Mixtape #${state.selectedTapeNumber}</span><span class="game-meta-sub">${dayOnly} (<a class="timezone-link" href="https://en.wikipedia.org/wiki/Australian_Eastern_Standard_Time" target="_blank" rel="noreferrer">AEST</a>)</span>`;
    } else {
        els.puzzleDate.textContent = `Set: ${state.selectedPackLabel} | Tape: ${state.selectedTapeKey}`;
    }

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
    state.selectedTapeNumber = item.tapeNumber;
    state.selectedReleaseDate = item.releaseDate;
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

    // Default to the most recent tape by tape number that has been released
    const today = getAestDateKey();

    // Filter tapes that have been released (releaseDate <= today)
    const releasedTapes = state.archiveEntries.filter(entry => entry.releaseDate <= today);

    if (releasedTapes.length > 0) {
        // Sort by tape number descending and take the highest
        releasedTapes.sort((a, b) => (b.tapeNumber || 0) - (a.tapeNumber || 0));
        const mostRecentTape = releasedTapes[0];
        try {
            await loadTapeFromArchiveItem(mostRecentTape);
        } catch (error) {
            console.error("Failed to auto-load tape:", error);
            openArchiveModal();
        }
    } else {
        // No released tapes yet - show archive modal
        openArchiveModal();
    }
}

function generateShareText() {
    if (state.phase !== "solved") {
        return "";
    }

    // Use the tape number from state
    const tapeNumber = state.selectedTapeNumber || "?";

    // Find the correct guess
    const correctGuess = state.guesses.find(g => g.result === "correct");
    if (!correctGuess || !state.startedAtMs) {
        return "";
    }

    // Calculate which track the correct answer was given on
    const correctAnswerTime = (correctGuess.atMs - state.startedAtMs) / 1000;
    const correctAnswerTrack = Math.floor(correctAnswerTime / CLIP_PLAY_SECONDS);

    const lines = [];
    lines.push(`Mystery Mixtape ${tapeNumber}`);
    const squares = [];
    const totalTracks = state.puzzle?.songs?.length || 6;

    for (let trackIdx = 0; trackIdx < totalTracks; trackIdx++) {
        const trackStart = trackIdx * CLIP_PLAY_SECONDS;
        const trackEnd = (trackIdx + 1) * CLIP_PLAY_SECONDS;

        if (trackIdx > correctAnswerTrack) {
            squares.push("⬛");
            continue;
        }

        if (trackIdx === correctAnswerTrack) {
            squares.push("🟩");
            continue;
        }

        const hadWrongInTrack = state.guesses.some((guess) => {
            if (guess.result !== "wrong") {
                return false;
            }
            const guessTime = (guess.atMs - state.startedAtMs) / 1000;
            return guessTime >= trackStart && guessTime < trackEnd;
        });

        squares.push(hadWrongInTrack ? "🟥" : "⬜️");
    }

    lines.push(squares.join(""));

    return lines.join("\n");
}

async function shareResults() {
    const shareText = generateShareText();
    if (!shareText) {
        return;
    }

    try {
        await navigator.clipboard.writeText(shareText);
        const originalText = shareText;
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
    renderArchiveList();
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
    if (els.rulesHideCheckbox) {
        els.rulesHideCheckbox.checked = getCookieValue(RULES_COOKIE_NAME) === "1";
    }
    els.rulesModal.classList.remove("hidden");
}

function closeRulesModal() {
    if (els.rulesHideCheckbox?.checked) {
        setCookieValue(RULES_COOKIE_NAME, "1", 60 * 60 * 24 * 365 * 5);
    } else {
        clearCookieValue(RULES_COOKIE_NAME);
    }
    els.rulesModal.classList.add("hidden");
}

function openSettingsModal() {
    if (els.settingsDisablePulse) {
        els.settingsDisablePulse.checked = Boolean(state.disableCassettePulse);
    }
    if (els.settingsModal) {
        els.settingsModal.classList.remove("hidden");
    }
}

function closeSettingsModal() {
    if (!els.settingsModal || els.settingsModal.classList.contains("hidden")) {
        return;
    }
    if (els.settingsDisablePulse) {
        state.disableCassettePulse = Boolean(els.settingsDisablePulse.checked);
        persistSettings();
        renderCassetteMotion();
    }
    els.settingsModal.classList.add("hidden");
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

function updateTimelineHover(event) {
    if (!els.timelineSurface) {
        return;
    }
    if (state.phase !== "solved" && state.phase !== "gaveup") {
        if (state.timelineHoverSec !== null) {
            state.timelineHoverSec = null;
            renderTimelineWaveform();
        }
        return;
    }
    const nextSec = timelinePointerToSec(event);
    if (!Number.isFinite(state.timelineHoverSec) || Math.abs(state.timelineHoverSec - nextSec) > 0.05) {
        state.timelineHoverSec = nextSec;
        renderTimelineWaveform();
    }
}

function clearTimelineHover() {
    if (state.timelineHoverSec === null) {
        return;
    }
    state.timelineHoverSec = null;
    renderTimelineWaveform();
}

function seekTimeline(nextSec, { restartIfPlaying = true } = {}) {
    if (state.phase !== "solved" && state.phase !== "gaveup") {
        setStatusMessage("Timeline seeking unlocks after solving or giving up.", "warn");
        return;
    }
    state.timelineCurrentSec = clampTimelineSec(nextSec);
    renderTimeline();

    if (restartIfPlaying && state.isTimelinePlaying) {
        pauseTransportPlayback({ showFlash: false, preservePosition: false });
        playTimelineFromCursor();
    }
}

function beginTimelineScrub(event) {
    if (state.phase !== "solved" && state.phase !== "gaveup") {
        setStatusMessage("Timeline seeking unlocks after solving or giving up.", "warn");
        return;
    }

    if (!els.timelineSurface) {
        return;
    }

    state.isTimelineScrubbing = true;
    state.timelineHoverSec = null;
    state.timelineScrubPointerId = typeof event.pointerId === "number" ? event.pointerId : null;
    state.timelineScrubWasPlaying = state.isTimelinePlaying;

    if (state.timelineScrubWasPlaying) {
        pauseTransportPlayback({ showFlash: false, preservePosition: false });
    }

    if (typeof event.pointerId === "number" && typeof els.timelineSurface.setPointerCapture === "function") {
        try {
            els.timelineSurface.setPointerCapture(event.pointerId);
        } catch (error) {
            // Pointer capture can fail on some platforms.
        }
    }

    seekTimeline(timelinePointerToSec(event), { restartIfPlaying: false });
}

function updateTimelineScrub(event) {
    if (!state.isTimelineScrubbing) {
        return;
    }
    if (state.timelineScrubPointerId !== null && typeof event.pointerId === "number" && event.pointerId !== state.timelineScrubPointerId) {
        return;
    }
    seekTimeline(timelinePointerToSec(event), { restartIfPlaying: false });
}

function endTimelineScrub(event) {
    if (!state.isTimelineScrubbing) {
        return;
    }
    if (state.timelineScrubPointerId !== null && typeof event.pointerId === "number" && event.pointerId !== state.timelineScrubPointerId) {
        return;
    }

    if (els.timelineSurface && state.timelineScrubPointerId !== null && typeof els.timelineSurface.releasePointerCapture === "function") {
        try {
            els.timelineSurface.releasePointerCapture(state.timelineScrubPointerId);
        } catch (error) {
            // Ignore release errors.
        }
    }

    const resumeTimeline = state.timelineScrubWasPlaying;
    state.isTimelineScrubbing = false;
    state.timelineScrubPointerId = null;
    state.timelineScrubWasPlaying = false;

    if (resumeTimeline && (state.phase === "solved" || state.phase === "gaveup")) {
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

    // Cassette click to start
    if (els.cassette) {
        els.cassette.addEventListener("click", async () => {
            await onTransportPlayPause();
        });
    }

    if (els.timelineSurface) {
        els.timelineSurface.addEventListener("pointerdown", (event) => {
            beginTimelineScrub(event);
        });

        els.timelineSurface.addEventListener("pointermove", (event) => {
            updateTimelineScrub(event);
            if (!state.isTimelineScrubbing) {
                updateTimelineHover(event);
            }
        });

        els.timelineSurface.addEventListener("pointerup", (event) => {
            endTimelineScrub(event);
        });

        els.timelineSurface.addEventListener("pointercancel", (event) => {
            endTimelineScrub(event);
        });

        els.timelineSurface.addEventListener("pointerleave", () => {
            clearTimelineHover();
        });

        els.timelineSurface.addEventListener("keydown", (event) => {
            if (state.phase !== "solved" && state.phase !== "gaveup") {
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

    window.addEventListener("pointermove", (event) => {
        updateTimelineScrub(event);
    });

    window.addEventListener("pointerup", (event) => {
        endTimelineScrub(event);
    });

    window.addEventListener("pointercancel", (event) => {
        endTimelineScrub(event);
    });

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

    if (els.guessInput) {
        els.guessInput.addEventListener("keydown", (event) => {
            if (event.key !== "Enter") {
                return;
            }
            event.preventDefault();
            if (els.guessForm && typeof els.guessForm.requestSubmit === "function") {
                els.guessForm.requestSubmit();
            }
        });
    }

    if (els.rulesBtn) {
        els.rulesBtn.addEventListener("click", openRulesModal);
    }

    if (els.settingsBtn) {
        els.settingsBtn.addEventListener("click", openSettingsModal);
    }

    if (els.settingsCloseBtn) {
        els.settingsCloseBtn.addEventListener("click", closeSettingsModal);
    }

    if (els.settingsDisablePulse) {
        els.settingsDisablePulse.addEventListener("change", () => {
            state.disableCassettePulse = Boolean(els.settingsDisablePulse.checked);
            persistSettings();
            renderCassetteMotion();
        });
    }

    if (els.rulesCloseBtn) {
        els.rulesCloseBtn.addEventListener("click", closeRulesModal);
    }

    if (els.shareBtn) {
        els.shareBtn.addEventListener("click", shareResults);
    }

    if (els.giveUpBtn) {
        els.giveUpBtn.addEventListener("click", () => {
            giveUp();
        });
    }

    if (els.rulesModal) {
        els.rulesModal.addEventListener("click", (event) => {
            if (event.target === els.rulesModal) {
                closeRulesModal();
            }
        });
    }

    if (els.settingsModal) {
        els.settingsModal.addEventListener("click", (event) => {
            if (event.target === els.settingsModal) {
                closeSettingsModal();
            }
        });
    }

    window.addEventListener("keydown", (event) => {
        if (event.code === "Escape") {
            closeRulesModal();
            closeArchiveModal();
            closeSettingsModal();
        }
    });

    window.addEventListener("resize", () => {
        renderTimelineWaveform();
        fitCassetteClueText();
    });
}

async function init() {
    try {
        console.log('[DEBUG] init() called');
        hydrateSettings();
        wireEvents();
        if (els.rulesModal) {
            els.rulesModal.classList.add("hidden");
        }
        if (els.archiveModal) {
            els.archiveModal.classList.add("hidden");
        }
        if (els.settingsModal) {
            els.settingsModal.classList.add("hidden");
        }
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
        if (shouldAutoShowRules()) {
            openRulesModal();
        }
        console.log('[DEBUG] init() completed');
    } catch (error) {
        console.error('[FATAL ERROR] in init():', error);
        console.error(error.stack);
    }
}

init();
