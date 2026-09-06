import JSZip from "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm";

const STORAGE_KEY = "mystery-mixtape.creator.v7";
const MIXTAPE_MANIFEST_PATH = "mixtapes/index.json";
const TRACK_COUNT = 6;
const CLIP_SECONDS = 10;
const CLIP_CONTEXT_SECONDS = 2;
const FADE_SECONDS = 1;
const TIME_STEP = 0.01;
const WAV_RATE = 44100;
const SOURCE_CANVAS_HEIGHT = 112;
const SOURCE_CANVAS_MIN_WIDTH = 1800;
const SOURCE_CANVAS_MAX_WIDTH = 8192;
const SOURCE_CANVAS_PIXELS_PER_SECOND = 220;

const els = {
    themeClue: document.getElementById("theme-clue"),
    themeClueAsk: document.getElementById("theme-clue-ask"),
    themeAnswer: document.getElementById("theme-answer"),
    themeAliases: document.getElementById("theme-aliases"),
    segmentsStrip: document.getElementById("segments-strip"),
    combinedCanvas: document.getElementById("combined-canvas"),
    selectedClipCanvas: document.getElementById("selected-clip-canvas"),
    selectedFileCanvas: document.getElementById("selected-file-canvas"),
    songCount: document.getElementById("song-count"),
    catalogPackSelect: document.getElementById("catalog-pack-select"),
    catalogTapeSelect: document.getElementById("catalog-tape-select"),
    catalogLoadBtn: document.getElementById("catalog-load-btn"),
    saveOverTapeBtn: document.getElementById("save-over-tape-btn"),
    importMixtapeBtn: document.getElementById("import-mixtape-btn"),
    importMixtapeInput: document.getElementById("import-mixtape-input"),
    uploadAllBtn: document.getElementById("upload-all-btn"),
    uploadAllInput: document.getElementById("upload-all-input"),
    combinedPreviewBtn: document.getElementById("combined-preview-btn"),
    clearSelectionBtn: document.getElementById("clear-selection-btn"),
    downloadPackageBtn: document.getElementById("download-package-btn"),
    clearAllBtn: document.getElementById("clear-all-btn"),
    builderStatus: document.getElementById("builder-status")
};

const audioContext = new AudioContext();

const state = {
    tracks: createEmptyTracks(),
    selectedTrackId: "",
    dragSourceId: "",
    hoverSec: null,
    dragClip: null,
    catalogPacks: [],
    currentLoadedTape: null,
    loadedPuzzleDate: "",
    loadedPuzzleClueTitle: "Clue"
};

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

function joinPath(basePath, path) {
    const cleanPath = String(path || "").replace(/^\.\//, "");
    if (!cleanPath) {
        return cleanPath;
    }
    if (!basePath) {
        return cleanPath;
    }
    const cleanBase = String(basePath).replace(/\/+$/, "");
    return `${cleanBase}/${cleanPath}`;
}

function extractTapeEntries(dailyIndex) {
    const entries = [];

    if (dailyIndex && typeof dailyIndex.puzzles === "object" && !Array.isArray(dailyIndex.puzzles)) {
        for (const [key, value] of Object.entries(dailyIndex.puzzles)) {
            if (typeof value === "string" && value.trim()) {
                entries.push({ key, label: key, path: value.trim() });
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
            entries.push({ key, label: key, path });
        }
    }

    entries.sort((a, b) => String(a.key).localeCompare(String(b.key)));
    return entries;
}

async function loadIndexForPack(slug) {
    const basePath = `mixtapes/${slug}`;
    const patchPath = joinPath(basePath, "data/daily-puzzles.patch.json");
    const fullPath = joinPath(basePath, "data/daily-puzzles.json");

    let dailyIndex = await fetchJson(patchPath, true);
    if (!dailyIndex) {
        dailyIndex = await fetchJson(fullPath, true);
    }
    if (!dailyIndex) {
        throw new Error(`Mixtape "${slug}" has no daily index.`);
    }

    return { basePath, dailyIndex };
}

function computeSourceCanvasWidth(durationSec) {
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
        return SOURCE_CANVAS_MIN_WIDTH;
    }
    const desired = Math.round(durationSec * SOURCE_CANVAS_PIXELS_PER_SECOND);
    return Math.max(SOURCE_CANVAS_MIN_WIDTH, Math.min(SOURCE_CANVAS_MAX_WIDTH, desired));
}

function getWaveformBackgroundColor() {
    const rootStyles = getComputedStyle(document.documentElement);
    const surface = rootStyles.getPropertyValue("--surface").trim();
    return surface || "#fffdf8";
}

function createEmptyTracks() {
    return Array.from({ length: TRACK_COUNT }, (_, index) => ({
        id: `track-${index + 1}`,
        title: "",
        artist: "",
        link: "",
        clipSrc: "",
        sourceFileName: "",
        sourceFile: null,
        arrayBuffer: null,
        decoded: null,
        durationSec: 0,
        startSec: 0,
        previewPlayheadSec: null,
        previewOffsetSec: 0,
        previewStartCtxTime: 0,
        previewOffsetAtStart: 0,
        previewStopTimer: null,
        previewSource: null,
        spectrogramImage: null,
        spectrogramCanvas: null,
        sourceCanvasW: SOURCE_CANVAS_MIN_WIDTH,
        sourceCanvasH: SOURCE_CANVAS_HEIGHT
    }));
}

function todayAestDate() {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Australia/Melbourne",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(new Date());
}

function setStatus(text, tone = "") {
    els.builderStatus.textContent = text;
    els.builderStatus.classList.remove("ok", "warn", "bad");
    if (tone) {
        els.builderStatus.classList.add(tone);
    }
}

function sanitizeFileBaseName(value) {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 52) || "track";
}

function inferTitleFromFileName(fileName = "") {
    return fileName
        .replace(/\.[^/.]+$/, "")
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function inferFileNameFromPath(path = "") {
    const text = String(path || "").trim();
    if (!text) {
        return "";
    }
    const normalized = text.replace(/\\/g, "/");
    const index = normalized.lastIndexOf("/");
    return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function normalizePathForLookup(path = "") {
    return String(path || "")
        .replace(/\\/g, "/")
        .replace(/^\.?\//, "")
        .replace(/^\/+/, "")
        .trim();
}

function saveDraft() {
    const payload = {
        themeClue: els.themeClue.value,
        themeClueAsk: els.themeClueAsk.value,
        themeAnswer: els.themeAnswer.value,
        themeAliases: els.themeAliases.value,
        selectedTrackId: state.selectedTrackId,
        tracks: state.tracks.map((track) => ({
            id: track.id,
            title: track.title,
            artist: track.artist,
            link: track.link,
            clipSrc: track.clipSrc,
            sourceFileName: track.sourceFileName,
            startSec: track.startSec
        }))
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function restoreDraft() {
    const serialized = localStorage.getItem(STORAGE_KEY);
    if (!serialized) {
        return;
    }

    try {
        const payload = JSON.parse(serialized);
        if (!payload || typeof payload !== "object") {
            return;
        }

        els.themeClue.value = payload.themeClue || "";
        els.themeClueAsk.value = payload.themeClueAsk || "";
        els.themeAnswer.value = payload.themeAnswer || "";
        els.themeAliases.value = payload.themeAliases || "";

        if (Array.isArray(payload.tracks) && payload.tracks.length === TRACK_COUNT) {
            state.tracks = payload.tracks.map((stored, index) => ({
                id: stored.id || `track-${index + 1}`,
                title: stored.title || "",
                artist: stored.artist || "",
                link: stored.link || "",
                clipSrc: stored.clipSrc || "",
                sourceFileName: stored.sourceFileName || "",
                sourceFile: null,
                arrayBuffer: null,
                decoded: null,
                durationSec: 0,
                startSec: Number.isFinite(Number(stored.startSec)) ? quantizeTime(Math.max(0, Number(stored.startSec))) : 0,
                previewPlayheadSec: null,
                previewOffsetSec: 0,
                previewStartCtxTime: 0,
                previewOffsetAtStart: 0,
                previewStopTimer: null,
                previewSource: null,
                spectrogramImage: null,
                spectrogramCanvas: null,
                sourceCanvasW: SOURCE_CANVAS_MIN_WIDTH,
                sourceCanvasH: SOURCE_CANVAS_HEIGHT
            }));
        }

        if (payload.selectedTrackId && state.tracks.some((track) => track.id === payload.selectedTrackId)) {
            state.selectedTrackId = payload.selectedTrackId;
        }
    } catch (error) {
        setStatus("Stored draft could not be restored.", "warn");
    }
}

function completeTrackCount() {
    return state.tracks.filter((track) => track.title && track.artist && track.decoded).length;
}

function updateSongCount() {
    els.songCount.textContent = String(completeTrackCount());
}

function getTrackIndexById(id) {
    return state.tracks.findIndex((track) => track.id === id);
}

function getSelectedTrack() {
    return state.tracks.find((track) => track.id === state.selectedTrackId) || null;
}

function quantizeTime(value) {
    return Math.round(value / TIME_STEP) * TIME_STEP;
}

function trackMaxStart(track) {
    return Math.max(0, track.durationSec - CLIP_SECONDS);
}

function clampTrackStart(track) {
    track.startSec = quantizeTime(Math.max(0, Math.min(track.startSec, trackMaxStart(track))));
}

function stopPreview(track, { stopSource = true } = {}) {
    if (track.previewStopTimer) {
        clearInterval(track.previewStopTimer);
        track.previewStopTimer = null;
    }

    if (stopSource && track.previewSource) {
        try {
            track.previewSource.stop();
        } catch (error) {
            // Source may already be stopped.
        }
    }

    track.previewSource = null;
    track.previewPlayheadSec = null;
}

function resetPreviewPosition(track) {
    track.previewOffsetSec = 0;
    track.previewPlayheadSec = null;
    track.previewStartCtxTime = 0;
    track.previewOffsetAtStart = 0;
}

function pausePreview(track) {
    if (!track.previewSource) {
        return;
    }

    const elapsed = Math.max(0, audioContext.currentTime - track.previewStartCtxTime);
    track.previewOffsetSec = Math.max(0, Math.min(CLIP_SECONDS, track.previewOffsetAtStart + elapsed));
    stopPreview(track);
    track.previewPlayheadSec = track.startSec + track.previewOffsetSec;
}

function stopAllPreviews(exceptTrackId = "") {
    for (const track of state.tracks) {
        if (!exceptTrackId || track.id !== exceptTrackId) {
            stopPreview(track);
            resetPreviewPosition(track);
        }
    }
}

function updateCombinedPreviewButton() {
    const selectedTrack = getSelectedTrack();
    if (!els.combinedPreviewBtn) {
        return;
    }
    if (!selectedTrack || !selectedTrack.decoded) {
        els.combinedPreviewBtn.textContent = "Play Selected (Space)";
        els.combinedPreviewBtn.disabled = true;
        if (els.clearSelectionBtn) {
            els.clearSelectionBtn.disabled = !selectedTrack;
        }
        return;
    }
    els.combinedPreviewBtn.disabled = false;
    if (els.clearSelectionBtn) {
        els.clearSelectionBtn.disabled = false;
    }
    els.combinedPreviewBtn.textContent = selectedTrack.previewSource ? "Pause Selected (Space)" : "Play Selected (Space)";
}

function clearSelection() {
    state.selectedTrackId = "";
    state.hoverSec = null;
    saveDraft();
    renderCanvases();
}

function scrubTrackToSec(track, sec, { restartIfPlaying = true } = {}) {
    const clipEnd = Math.min(track.durationSec || CLIP_SECONDS, track.startSec + CLIP_SECONDS);
    const clampedSec = Math.max(track.startSec, Math.min(clipEnd, sec));
    track.previewOffsetSec = Math.max(0, Math.min(CLIP_SECONDS, clampedSec - track.startSec));
    track.previewPlayheadSec = clampedSec;

    if (track.previewSource && restartIfPlaying) {
        pausePreview(track);
        startPreview(track);
        return;
    }

    renderCanvases();
    updateCombinedPreviewButton();
}

function getClipWindow(track) {
    const desiredSpan = CLIP_SECONDS + CLIP_CONTEXT_SECONDS * 2;
    if (!track.durationSec) {
        return { start: 0, end: desiredSpan };
    }

    let start = track.startSec - CLIP_CONTEXT_SECONDS;
    let end = track.startSec + CLIP_SECONDS + CLIP_CONTEXT_SECONDS;

    if (start < 0) {
        end = Math.min(track.durationSec, end - start);
        start = 0;
    }

    if (end > track.durationSec) {
        const overshoot = end - track.durationSec;
        start = Math.max(0, start - overshoot);
        end = track.durationSec;
    }

    if (end - start < Math.min(desiredSpan, track.durationSec)) {
        end = Math.min(track.durationSec, start + desiredSpan);
        start = Math.max(0, end - desiredSpan);
    }

    return { start, end };
}

function computeWaveformImage(track) {
    if (!track.decoded) {
        track.spectrogramImage = null;
        track.spectrogramCanvas = null;
        return;
    }

    const channel = track.decoded.getChannelData(0);
    const width = track.sourceCanvasW;
    const height = track.sourceCanvasH;
    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = width;
    sourceCanvas.height = height;
    const sourceCtx = sourceCanvas.getContext("2d");
    if (sourceCtx) {
        sourceCtx.fillStyle = getWaveformBackgroundColor();
        sourceCtx.fillRect(0, 0, width, height);

        const midY = Math.floor(height / 2);
        sourceCtx.strokeStyle = "rgba(17,24,39,0.18)";
        sourceCtx.lineWidth = 1;
        sourceCtx.beginPath();
        sourceCtx.moveTo(0, midY + 0.5);
        sourceCtx.lineTo(width, midY + 0.5);
        sourceCtx.stroke();

        const samplesPerPixel = Math.max(1, Math.floor(channel.length / width));
        sourceCtx.strokeStyle = "rgba(17,24,39,0.98)";
        sourceCtx.lineWidth = 1;

        for (let x = 0; x < width; x += 1) {
            const start = x * samplesPerPixel;
            const end = Math.min(channel.length, start + samplesPerPixel);
            let min = 1;
            let max = -1;

            for (let i = start; i < end; i += 1) {
                const sample = channel[i];
                if (sample < min) {
                    min = sample;
                }
                if (sample > max) {
                    max = sample;
                }
            }

            const y1 = Math.floor((1 - (max + 1) / 2) * (height - 1));
            const y2 = Math.floor((1 - (min + 1) / 2) * (height - 1));
            sourceCtx.beginPath();
            sourceCtx.moveTo(x + 0.5, y1);
            sourceCtx.lineTo(x + 0.5, y2 + 1);
            sourceCtx.stroke();
        }
    }

    track.spectrogramImage = null;
    track.spectrogramCanvas = sourceCanvas;
}

function fillEmptySpectrogram(ctx, width, height, text) {
    ctx.fillStyle = getWaveformBackgroundColor();
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#6b7280";
    ctx.font = "11px IBM Plex Mono";
    ctx.fillText(text, 8, Math.floor(height / 2));
}

function getDrawContext(canvas) {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        return null;
    }

    const dpr = Number(canvas.dataset.dpr || "1");
    const width = Math.max(10, Math.floor(canvas.clientWidth));
    const height = Math.max(10, Math.floor(canvas.clientHeight));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width, height };
}

function secToCanvasX(sec, rangeStart, rangeEnd, width) {
    if (rangeEnd <= rangeStart) {
        return 0;
    }
    const ratio = (sec - rangeStart) / (rangeEnd - rangeStart);
    return Math.max(0, Math.min(width, Math.floor(ratio * width)));
}

function pointerToSec(canvas, event, rangeStart, rangeEnd) {
    const rect = canvas.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    const clamped = Math.max(0, Math.min(1, ratio));
    return rangeStart + clamped * (rangeEnd - rangeStart);
}

function drawWindowedSpectrogram(track, canvas, windowStart, windowEnd, labelText = "", options = {}) {
    const draw = getDrawContext(canvas);
    if (!draw) {
        return;
    }

    const { ctx, width, height } = draw;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = getWaveformBackgroundColor();
    ctx.fillRect(0, 0, width, height);

    if (!track.decoded || !track.spectrogramCanvas || !track.durationSec) {
        fillEmptySpectrogram(ctx, width, height, "Use Upload 6 Tracks above");
        return;
    }

    const sourceStartX = secToCanvasX(windowStart, 0, track.durationSec, track.sourceCanvasW);
    const sourceEndX = secToCanvasX(windowEnd, 0, track.durationSec, track.sourceCanvasW);
    const sourceWidth = Math.max(1, sourceEndX - sourceStartX);

    ctx.drawImage(track.spectrogramCanvas, sourceStartX, 0, sourceWidth, track.sourceCanvasH, 0, 0, width, height);

    const clipStart = track.startSec;
    const clipEnd = Math.min(track.durationSec, track.startSec + CLIP_SECONDS);
    const clipStartX = secToCanvasX(clipStart, windowStart, windowEnd, width);
    const clipEndX = secToCanvasX(clipEnd, windowStart, windowEnd, width);

    ctx.fillStyle = "rgba(239,68,68,0.24)";
    ctx.fillRect(clipStartX, 0, Math.max(1, clipEndX - clipStartX), height);

    if (Number.isFinite(state.hoverSec) && state.hoverSec >= windowStart && state.hoverSec <= windowEnd) {
        const hoverX = secToCanvasX(state.hoverSec, windowStart, windowEnd, width);
        ctx.strokeStyle = "rgba(251,191,36,0.95)";
        ctx.beginPath();
        ctx.moveTo(hoverX + 0.5, 0);
        ctx.lineTo(hoverX + 0.5, height);
        ctx.stroke();
    }

    if (Number.isFinite(track.previewPlayheadSec) && track.previewPlayheadSec >= windowStart && track.previewPlayheadSec <= windowEnd) {
        const playX = secToCanvasX(track.previewPlayheadSec, windowStart, windowEnd, width);
        ctx.strokeStyle = "rgba(34,197,94,0.98)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(playX, 0);
        ctx.lineTo(playX, height);
        ctx.stroke();
    }

    void labelText;
    void options;
}

function drawCombinedSpectrogram(canvas, labelText = "Combined 60s mixtape") {
    const draw = getDrawContext(canvas);
    if (!draw) {
        return;
    }

    const { ctx, width, height } = draw;
    const segWidth = width / TRACK_COUNT;

    ctx.fillStyle = getWaveformBackgroundColor();
    ctx.fillRect(0, 0, width, height);

    for (let i = 0; i < TRACK_COUNT; i += 1) {
        const track = state.tracks[i];
        const x = i * segWidth;

        if (track.decoded && track.spectrogramCanvas && track.durationSec) {
            const clipStartX = secToCanvasX(track.startSec, 0, track.durationSec, track.sourceCanvasW);
            const clipEndX = secToCanvasX(Math.min(track.durationSec, track.startSec + CLIP_SECONDS), 0, track.durationSec, track.sourceCanvasW);
            const clipWidth = Math.max(1, clipEndX - clipStartX);
            ctx.drawImage(track.spectrogramCanvas, clipStartX, 0, clipWidth, track.sourceCanvasH, x, 0, segWidth, height);
        } else {
            ctx.fillStyle = "rgba(17,24,39,0.08)";
            ctx.fillRect(x, 0, segWidth, height);
            ctx.fillStyle = "#6b7280";
            ctx.font = "10px IBM Plex Mono";
            ctx.fillText("Upload", x + 8, Math.floor(height / 2));
        }

        if (state.selectedTrackId === track.id) {
            ctx.fillStyle = "rgba(255,255,255,0.06)";
            ctx.fillRect(x, 0, segWidth, height);
        }

        if (Number.isFinite(track.previewPlayheadSec) && track.durationSec) {
            const clipStart = track.startSec;
            const clipEnd = Math.min(track.durationSec, clipStart + CLIP_SECONDS);
            if (track.previewPlayheadSec >= clipStart && track.previewPlayheadSec <= clipEnd) {
                const local = (track.previewPlayheadSec - clipStart) / CLIP_SECONDS;
                const playX = x + local * segWidth;
                ctx.strokeStyle = "rgba(34,197,94,0.98)";
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(playX, 0);
                ctx.lineTo(playX, height);
                ctx.stroke();
            }
        }

        if (i > 0) {
            ctx.strokeStyle = "rgba(17,24,39,0.22)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x + 0.5, 0);
            ctx.lineTo(x + 0.5, height);
            ctx.stroke();
        }
    }

    void labelText;
}

function sizeCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(10, Math.floor(rect.width));
    const height = Math.max(10, Math.floor(rect.height));
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    const pixelWidth = Math.floor(width * dpr);
    const pixelHeight = Math.floor(height * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
        canvas.dataset.dpr = String(dpr);
        return true;
    }

    if (canvas.dataset.dpr !== String(dpr)) {
        canvas.dataset.dpr = String(dpr);
    }

    return false;
}

function renderCanvases() {
    renderSelectedEditor();
    renderRowMeta();
    updateCombinedPreviewButton();
}

function selectTrack(trackId) {
    if (!state.tracks.some((track) => track.id === trackId)) {
        return;
    }
    state.selectedTrackId = trackId;
    state.hoverSec = null;
    saveDraft();
    renderCanvases();
}

function syncTrackStart(track, nextValue) {
    const playing = Boolean(track.previewSource);
    if (playing) {
        pausePreview(track);
    }

    const value = quantizeTime(Math.max(0, Number(nextValue) || 0));
    track.startSec = value;
    clampTrackStart(track);

    const clipEnd = Math.min(track.durationSec || CLIP_SECONDS, track.startSec + CLIP_SECONDS);
    const playheadCandidate = track.startSec + track.previewOffsetSec;
    if (playheadCandidate > clipEnd) {
        track.previewOffsetSec = CLIP_SECONDS;
    }
    if (playheadCandidate < track.startSec) {
        track.previewOffsetSec = 0;
    }

    if (!track.previewSource) {
        track.previewPlayheadSec = track.startSec + track.previewOffsetSec;
    }

    if (playing) {
        stopPreview(track);
        resetPreviewPosition(track);
    }

    saveDraft();

    renderCanvases();
}

function clearTrackAudio(track) {
    stopPreview(track);
    resetPreviewPosition(track);
    track.title = "";
    track.artist = "";
    track.link = "";
    track.clipSrc = "";
    track.sourceFileName = "";
    track.sourceFile = null;
    track.arrayBuffer = null;
    track.decoded = null;
    track.durationSec = 0;
    track.startSec = 0;
    track.spectrogramImage = null;
    track.spectrogramCanvas = null;
}

async function loadTrackFile(track, file) {
    stopPreview(track);
    track.sourceFile = file;
    track.sourceFileName = file.name;
    track.title = inferTitleFromFileName(file.name);
    track.artist = "";
    track.link = "";
    track.arrayBuffer = await file.arrayBuffer();
    track.decoded = await audioContext.decodeAudioData(track.arrayBuffer.slice(0));
    track.durationSec = track.decoded.duration;
    track.sourceCanvasW = computeSourceCanvasWidth(track.durationSec);
    track.sourceCanvasH = SOURCE_CANVAS_HEIGHT;
    clampTrackStart(track);
    resetPreviewPosition(track);
    computeWaveformImage(track);
}

function renderSelectedEditor() {
    const track = getSelectedTrack();

    sizeCanvas(els.combinedCanvas);
    sizeCanvas(els.selectedClipCanvas);
    sizeCanvas(els.selectedFileCanvas);

    drawCombinedSpectrogram(els.combinedCanvas, "Combined 60s waveform overview");

    if (!track) {
        const clipDraw = getDrawContext(els.selectedClipCanvas);
        const fileDraw = getDrawContext(els.selectedFileCanvas);
        if (clipDraw) {
            fillEmptySpectrogram(clipDraw.ctx, clipDraw.width, clipDraw.height, "Select a row below");
        }
        if (fileDraw) {
            fillEmptySpectrogram(fileDraw.ctx, fileDraw.width, fileDraw.height, "Select a row below");
        }
        return;
    }

    const hasDecodedAudio = Boolean(track.decoded && track.spectrogramCanvas && track.durationSec);

    if (!hasDecodedAudio) {
        const clipDraw = getDrawContext(els.selectedClipCanvas);
        const fileDraw = getDrawContext(els.selectedFileCanvas);
        if (clipDraw) {
            fillEmptySpectrogram(
                clipDraw.ctx,
                clipDraw.width,
                clipDraw.height,
                track.sourceFileName ? "Re-upload to restore audio" : "No audio loaded"
            );
        }
        if (fileDraw) {
            fillEmptySpectrogram(
                fileDraw.ctx,
                fileDraw.width,
                fileDraw.height,
                track.sourceFileName ? "Re-upload to restore audio" : "No audio loaded"
            );
        }
        return;
    }

    const clipWindow = getClipWindow(track);
    drawWindowedSpectrogram(
        track,
        els.selectedClipCanvas,
        clipWindow.start,
        clipWindow.end,
        "",
        { showDragHandles: true }
    );
    drawWindowedSpectrogram(
        track,
        els.selectedFileCanvas,
        0,
        Math.max(1, track.durationSec || CLIP_SECONDS),
        "",
        { showDragHandles: true }
    );
}

function renderRowMeta() {
    const cards = els.segmentsStrip.querySelectorAll(".segment-card");
    cards.forEach((card) => {
        const track = state.tracks.find((item) => item.id === card.dataset.trackId);
        if (!track) {
            return;
        }

        card.classList.toggle("selected", track.id === state.selectedTrackId);
        card.classList.toggle("playing", Boolean(track.previewSource));
    });
}

async function handleFileSelection(track, file) {
    if (!file) {
        return;
    }

    try {
        await loadTrackFile(track, file);
        updateSongCount();
        saveDraft();
        renderSegmentsStrip();
        renderCanvases();
        setStatus(`Loaded ${track.sourceFileName}.`, "ok");
    } catch (error) {
        track.sourceFile = null;
        track.arrayBuffer = null;
        track.decoded = null;
        track.spectrogramImage = null;
        track.spectrogramCanvas = null;
        track.durationSec = 0;
        renderSegmentsStrip();
        renderCanvases();
        setStatus("Audio file could not be decoded.", "bad");
    }
}

async function handleBulkFiles(fileList) {
    const files = Array.from(fileList || []).slice(0, TRACK_COUNT);
    if (!files.length) {
        return;
    }

    setStatus("Loading audio files...", "warn");
    stopAllPreviews();

    for (const track of state.tracks) {
        clearTrackAudio(track);
    }

    const failures = [];
    for (let index = 0; index < files.length; index += 1) {
        const track = state.tracks[index];
        const file = files[index];
        try {
            await loadTrackFile(track, file);
        } catch (error) {
            clearTrackAudio(track);
            failures.push(file.name);
        }
    }

    updateSongCount();
    saveDraft();
    renderSegmentsStrip();
    renderCanvases();

    if (failures.length) {
        setStatus(`Some files could not be decoded: ${failures.join(", ")}.`, "bad");
        return;
    }

    if (files.length !== TRACK_COUNT) {
        setStatus(`Loaded ${files.length} file(s). Expected 6 for a full mixtape.`, "warn");
        return;
    }

    setStatus("Loaded 6 tracks.", "ok");
}

async function fetchAndDecodeClip(track, clipSrc) {
    const response = await fetch(encodeURI(clipSrc));
    if (!response.ok) {
        throw new Error(`Could not load clip at ${clipSrc}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    track.arrayBuffer = arrayBuffer;
    track.decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    track.durationSec = track.decoded.duration;
    track.startSec = 0;
    track.sourceCanvasW = computeSourceCanvasWidth(track.durationSec);
    track.sourceCanvasH = SOURCE_CANVAS_HEIGHT;
    resetPreviewPosition(track);
    computeWaveformImage(track);
}

async function decodeClipFromArrayBuffer(track, arrayBuffer) {
    track.arrayBuffer = arrayBuffer;
    track.decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    track.durationSec = track.decoded.duration;
    track.startSec = 0;
    track.sourceCanvasW = computeSourceCanvasWidth(track.durationSec);
    track.sourceCanvasH = SOURCE_CANVAS_HEIGHT;
    resetPreviewPosition(track);
    computeWaveformImage(track);
}

async function applyImportedPuzzle(payload, loadClip) {
    if (!payload || typeof payload !== "object") {
        throw new Error("Selected file does not contain a mixtape object.");
    }
    if (!Array.isArray(payload.songs) || payload.songs.length !== TRACK_COUNT) {
        throw new Error(`Mixtape must contain exactly ${TRACK_COUNT} songs.`);
    }

    stopAllPreviews();
    state.hoverSec = null;
    state.selectedTrackId = "";

    els.themeClue.value = String(payload.clue || "").trim();
    els.themeClueAsk.value = String(payload.clueAskBold || "").trim();
    els.themeAnswer.value = String(payload.theme || "").trim();
    state.loadedPuzzleDate = String(payload.date || "").trim();
    state.loadedPuzzleClueTitle = String(payload.clueTitle || "Clue").trim() || "Clue";
    els.themeAliases.value = Array.isArray(payload.aliases)
        ? payload.aliases.map((item) => String(item || "").trim()).filter(Boolean).join(", ")
        : "";

    const failures = [];

    for (let i = 0; i < TRACK_COUNT; i += 1) {
        const incoming = payload.songs[i] || {};
        const track = state.tracks[i];
        clearTrackAudio(track);

        track.title = String(incoming.title || "").trim();
        track.artist = String(incoming.artist || "").trim();
        track.link = String(incoming.link || "").trim();

        const clipSrc = String(incoming.clipSrc || "").trim();
        if (!clipSrc) {
            failures.push(`Track ${i + 1}: missing clipSrc`);
            continue;
        }

        track.clipSrc = clipSrc;
        track.sourceFileName = inferFileNameFromPath(clipSrc);

        try {
            await loadClip(track, clipSrc);
        } catch (error) {
            clearTrackAudio(track);
            track.title = String(incoming.title || "").trim();
            track.artist = String(incoming.artist || "").trim();
            track.link = String(incoming.link || "").trim();
            track.clipSrc = clipSrc;
            track.sourceFileName = inferFileNameFromPath(clipSrc);
            failures.push(`Track ${i + 1}: ${track.sourceFileName || clipSrc}`);
        }
    }

    updateSongCount();
    saveDraft();
    renderSegmentsStrip();
    renderCanvases();

    if (failures.length) {
        setStatus(
            `Imported clue/answers and track metadata, but some clips could not be loaded (${failures.length}). Re-upload those tracks to re-export.`,
            "warn"
        );
        return;
    }

    setStatus("Mixtape imported and ready to edit/download.", "ok");
}

async function importMixtapeJson(file) {
    if (!file) {
        return;
    }

    setStatus("Importing mixtape JSON...", "warn");

    let payload;
    try {
        payload = JSON.parse(await file.text());
    } catch (error) {
        setStatus("Selected file is not valid JSON.", "bad");
        return;
    }

    try {
        await applyImportedPuzzle(payload, async (track, clipSrc) => {
            await fetchAndDecodeClip(track, clipSrc);
        });
    } catch (error) {
        setStatus(error.message || "Import failed.", "bad");
    }
}

async function importMixtapeZip(file) {
    if (!file) {
        return;
    }

    setStatus("Importing mixtape package...", "warn");

    let zip;
    try {
        zip = await JSZip.loadAsync(await file.arrayBuffer());
    } catch (error) {
        setStatus("Selected file is not a valid ZIP package.", "bad");
        return;
    }

    const allEntries = Object.entries(zip.files)
        .filter(([, entry]) => !entry.dir)
        .map(([name]) => normalizePathForLookup(name));

    const puzzlePath = allEntries.find((name) => /(?:^|\/)data\/puzzles\/[^/]+\.json$/i.test(name));
    if (!puzzlePath) {
        setStatus("ZIP package is missing data/puzzles/*.json.", "bad");
        return;
    }

    const puzzleEntry = zip.file(puzzlePath);
    if (!puzzleEntry) {
        setStatus("Could not read puzzle JSON from package.", "bad");
        return;
    }

    let payload;
    try {
        payload = JSON.parse(await puzzleEntry.async("string"));
    } catch (error) {
        setStatus("Puzzle JSON in ZIP is invalid.", "bad");
        return;
    }

    try {
        await applyImportedPuzzle(payload, async (track, clipSrc) => {
            const normalizedClip = normalizePathForLookup(clipSrc);
            const clipPath = allEntries.find((name) => name === normalizedClip || name.endsWith(`/${normalizedClip}`));
            if (!clipPath) {
                throw new Error(`Missing clip in zip: ${clipSrc}`);
            }
            const clipEntry = zip.file(clipPath);
            if (!clipEntry) {
                throw new Error(`Missing clip in zip: ${clipSrc}`);
            }
            const clipBuffer = await clipEntry.async("arraybuffer");
            await decodeClipFromArrayBuffer(track, clipBuffer);
        });
    } catch (error) {
        setStatus(error.message || "Import failed.", "bad");
    }
}

function renderCatalogPackOptions() {
    if (!els.catalogPackSelect) {
        return;
    }
    els.catalogPackSelect.innerHTML = "";
    for (const pack of state.catalogPacks) {
        const option = document.createElement("option");
        option.value = pack.slug;
        option.textContent = pack.label;
        els.catalogPackSelect.appendChild(option);
    }
}

function renderCatalogTapeOptions() {
    if (!els.catalogTapeSelect || !els.catalogPackSelect) {
        return;
    }
    const slug = String(els.catalogPackSelect.value || "");
    const pack = state.catalogPacks.find((item) => item.slug === slug) || state.catalogPacks[0];
    els.catalogTapeSelect.innerHTML = "";
    if (!pack) {
        return;
    }
    for (const tape of pack.tapes) {
        const option = document.createElement("option");
        option.value = tape.key;
        option.textContent = tape.label;
        els.catalogTapeSelect.appendChild(option);
    }
}

async function loadCatalogPacks() {
    const manifest = await fetchJson(MIXTAPE_MANIFEST_PATH, true);
    if (!manifest || !Array.isArray(manifest.packs) || !manifest.packs.length) {
        throw new Error("No mixtape packs found in mixtapes/index.json.");
    }

    const packs = [];
    for (const item of manifest.packs) {
        const slug = String(item?.slug || "").trim();
        if (!slug) {
            continue;
        }
        const label = String(item?.label || slug).trim() || slug;
        try {
            const { basePath, dailyIndex } = await loadIndexForPack(slug);
            const tapes = extractTapeEntries(dailyIndex);
            if (!tapes.length) {
                continue;
            }
            packs.push({ slug, label, basePath, tapes });
        } catch (error) {
            // Skip packs that cannot be read.
        }
    }

    if (!packs.length) {
        throw new Error("No readable tapes found in mixtape packs.");
    }

    state.catalogPacks = packs;
    renderCatalogPackOptions();
    renderCatalogTapeOptions();
}

async function loadSelectedCatalogTape() {
    const packSlug = String(els.catalogPackSelect?.value || "");
    const tapeKey = String(els.catalogTapeSelect?.value || "");
    const pack = state.catalogPacks.find((item) => item.slug === packSlug);
    if (!pack) {
        setStatus("Pick a pack first.", "warn");
        return;
    }
    const tape = pack.tapes.find((item) => item.key === tapeKey) || pack.tapes[0];
    if (!tape) {
        setStatus("No tape found for selected pack.", "warn");
        return;
    }

    const puzzlePath = joinPath(pack.basePath, tape.path);
    setStatus(`Loading ${pack.label} / ${tape.key}...`, "warn");

    let payload;
    try {
        payload = await fetchJson(puzzlePath);
    } catch (error) {
        setStatus(error.message || "Could not load selected tape.", "bad");
        return;
    }

    try {
        await applyImportedPuzzle(payload, async (track, clipSrc) => {
            const resolvedClip = joinPath(pack.basePath, clipSrc);
            await fetchAndDecodeClip(track, resolvedClip);
        });
        state.currentLoadedTape = {
            packSlug: pack.slug,
            packLabel: pack.label,
            tapeKey: tape.key,
            puzzleRelativePath: normalizePathForLookup(puzzlePath)
        };
        setStatus(`Loaded ${pack.label} / ${tape.key}. Ready to save over or re-download.`, "ok");
    } catch (error) {
        setStatus(error.message || "Failed to load selected tape.", "bad");
    }
}

function getTrackClipPath(track) {
    const explicit = String(track.clipSrc || "").trim();
    if (explicit) {
        return explicit;
    }
    const fallback = String(track.sourceFileName || "").trim();
    if (!fallback) {
        return "";
    }
    return `data/clips/${fallback}`;
}

function downloadTextFile(filename, content) {
    const blob = new Blob([content], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
}

function buildPuzzleObjectForSave() {
    const integrated = integrateBoldAskIntoClue(els.themeClue.value, els.themeClueAsk.value);
    const aliases = parseAliasList(els.themeAliases.value)
        .filter((alias) => alias.toLowerCase() !== String(els.themeAnswer.value || "").trim().toLowerCase());

    return {
        date: state.loadedPuzzleDate || todayAestDate(),
        clueTitle: state.loadedPuzzleClueTitle || "Clue",
        clue: integrated.clue,
        clueAskBold: integrated.clueAskBold,
        theme: String(els.themeAnswer.value || "").trim(),
        aliases,
        songs: state.tracks.map((track) => ({
            title: String(track.title || "").trim(),
            artist: String(track.artist || "").trim(),
            link: String(track.link || "").trim(),
            clipSrc: getTrackClipPath(track),
            hint: ""
        }))
    };
}

async function saveOverCurrentTape() {
    if (!state.currentLoadedTape?.puzzleRelativePath) {
        setStatus("Load a tape from the mixtape selectors first.", "warn");
        return;
    }

    if (!String(els.themeClue.value || "").trim()) {
        setStatus("Clue is required.", "bad");
        return;
    }
    if (!String(els.themeAnswer.value || "").trim()) {
        setStatus("Answer is required.", "bad");
        return;
    }

    const puzzle = buildPuzzleObjectForSave();
    const serialized = `${JSON.stringify(puzzle, null, 2)}\n`;
    const fallbackName = String(state.currentLoadedTape.puzzleRelativePath || "tape.json").split("/").pop() || "tape.json";

    downloadTextFile(fallbackName, serialized);
    setStatus(`Downloaded ${fallbackName}. Replace the original tape JSON with this file.`, "ok");
}

function startPreview(track) {
    if (!track.decoded) {
        setStatus("Load audio before preview.", "warn");
        return;
    }

    stopAllPreviews(track.id);
    stopPreview(track);
    audioContext.resume();

    const source = audioContext.createBufferSource();
    const gainNode = audioContext.createGain();
    source.buffer = track.decoded;
    source.connect(gainNode);
    gainNode.connect(audioContext.destination);
    track.previewSource = source;

    const clipOffset = Math.max(0, Math.min(CLIP_SECONDS, track.previewOffsetSec));
    const startedAt = audioContext.currentTime;
    const remaining = Math.max(0.05, CLIP_SECONDS - clipOffset);
    const startOffset = track.startSec + clipOffset;
    const fadeDuration = Math.min(FADE_SECONDS, remaining / 2);
    track.previewStartCtxTime = startedAt;
    track.previewOffsetAtStart = clipOffset;
    track.previewPlayheadSec = startOffset;

    gainNode.gain.setValueAtTime(0, startedAt);
    gainNode.gain.linearRampToValueAtTime(1, startedAt + fadeDuration);
    gainNode.gain.setValueAtTime(1, Math.max(startedAt + fadeDuration, startedAt + remaining - fadeDuration));
    gainNode.gain.linearRampToValueAtTime(0, startedAt + remaining);

    source.start(0, startOffset, remaining);

    track.previewStopTimer = setInterval(() => {
        const elapsed = audioContext.currentTime - startedAt;
        const nextOffset = clipOffset + elapsed;
        if (nextOffset >= CLIP_SECONDS) {
            stopPreview(track);
            resetPreviewPosition(track);
            renderCanvases();
            renderSegmentsStrip();
            updateCombinedPreviewButton();
            return;
        }

        track.previewOffsetSec = nextOffset;
        track.previewPlayheadSec = track.startSec + nextOffset;
        renderCanvases();
    }, 30);

    source.onended = () => {
        if (track.previewSource === source) {
            stopPreview(track, { stopSource: false });
            resetPreviewPosition(track);
            renderCanvases();
            updateCombinedPreviewButton();
        }
    };

    renderCanvases();
}

function togglePreview(track, { fromBeginning = false } = {}) {
    if (track.previewSource) {
        pausePreview(track);
        renderCanvases();
        return;
    }
    if (fromBeginning) {
        track.previewOffsetSec = 0;
        track.previewPlayheadSec = track.startSec;
    }
    startPreview(track);
}

function toggleSelectedPreview(options = {}) {
    const selectedTrack = getSelectedTrack();
    if (!selectedTrack) {
        return;
    }
    togglePreview(selectedTrack, options);
}

function reorderTracks(sourceId, targetId) {
    if (!sourceId || !targetId || sourceId === targetId) {
        return;
    }

    const sourceIndex = getTrackIndexById(sourceId);
    const targetIndex = getTrackIndexById(targetId);
    if (sourceIndex < 0 || targetIndex < 0) {
        return;
    }

    const reordered = [...state.tracks];
    const [moved] = reordered.splice(sourceIndex, 1);
    reordered.splice(targetIndex, 0, moved);
    state.tracks = reordered;

    saveDraft();
    renderSegmentsStrip();
    renderCanvases();
}

function renderSegmentsStrip() {
    els.segmentsStrip.innerHTML = "";

    const header = document.createElement("div");
    header.className = "segments-table-head";
    ["", "#", "Song Title", "Artist(s)", "Link"].forEach((label, idx) => {
        const cell = document.createElement("div");
        cell.className = "segments-table-head-cell";
        if (idx === 0) {
            cell.classList.add("segments-table-head-spacer");
        }
        cell.textContent = label;
        header.appendChild(cell);
    });
    els.segmentsStrip.appendChild(header);

    state.tracks.forEach((track, index) => {
        const card = document.createElement("article");
        const rowStates = [];
        if (track.id === state.selectedTrackId) {
            rowStates.push("selected");
        }
        if (track.previewSource) {
            rowStates.push("playing");
        }
        card.className = `segment-card${rowStates.length ? ` ${rowStates.join(" ")}` : ""}`;
        card.dataset.trackId = track.id;

        card.addEventListener("click", (event) => {
            if (event.target.closest("input, button, a, label")) {
                return;
            }
            if (state.selectedTrackId === track.id) {
                state.selectedTrackId = "";
                saveDraft();
                renderCanvases();
                return;
            }
            selectTrack(track.id);
        });

        card.addEventListener("dragover", (event) => {
            event.preventDefault();
        });

        card.addEventListener("drop", (event) => {
            event.preventDefault();
            reorderTracks(state.dragSourceId, track.id);
        });

        const grip = document.createElement("div");
        grip.className = "segment-grip";
        grip.draggable = true;
        grip.title = "Drag to reorder";

        grip.addEventListener("dragstart", () => {
            state.dragSourceId = track.id;
        });

        const indexChip = document.createElement("span");
        indexChip.className = "segment-index";
        indexChip.textContent = `#${index + 1}`;

        const indexCell = document.createElement("div");
        indexCell.className = "segment-cell segment-index-cell";
        indexCell.appendChild(indexChip);

        const titleCell = document.createElement("div");
        titleCell.className = "segment-cell segment-title-cell";

        const artistCell = document.createElement("div");
        artistCell.className = "segment-cell segment-artist-cell";

        const linkCell = document.createElement("div");
        linkCell.className = "segment-cell segment-link-cell";

        const titleInput = document.createElement("input");
        titleInput.type = "text";
        titleInput.placeholder = "Song";
        titleInput.value = track.title;
        titleInput.addEventListener("mousedown", (event) => event.stopPropagation());
        titleInput.addEventListener("click", (event) => event.stopPropagation());
        titleInput.addEventListener("input", () => {
            track.title = titleInput.value.trim();
            updateSongCount();
            saveDraft();
        });
        titleInput.className = "segment-inline-input";
        titleCell.appendChild(titleInput);

        const artistInput = document.createElement("input");
        artistInput.type = "text";
        artistInput.placeholder = "Artist";
        artistInput.value = track.artist;
        artistInput.addEventListener("mousedown", (event) => event.stopPropagation());
        artistInput.addEventListener("click", (event) => event.stopPropagation());
        artistInput.addEventListener("input", () => {
            track.artist = artistInput.value.trim();
            updateSongCount();
            saveDraft();
        });
        artistInput.className = "segment-inline-input";
        artistCell.appendChild(artistInput);

        const linkInput = document.createElement("input");
        linkInput.type = "url";
        linkInput.placeholder = "https://...";
        linkInput.value = track.link || "";
        linkInput.addEventListener("mousedown", (event) => event.stopPropagation());
        linkInput.addEventListener("click", (event) => event.stopPropagation());
        linkInput.addEventListener("input", () => {
            track.link = linkInput.value.trim();
            saveDraft();
        });
        linkInput.className = "segment-inline-input";
        linkCell.appendChild(linkInput);

        card.title = track.sourceFileName || "";
        card.append(grip, indexCell, titleCell, artistCell, linkCell);
        els.segmentsStrip.appendChild(card);
    });

    updateSongCount();
}

function isTypingContext() {
    const active = document.activeElement;
    if (!active) {
        return false;
    }
    const tag = active.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || active.isContentEditable;
}

function openFilePicker(input) {
    if (!input) {
        return;
    }

    try {
        if (typeof input.showPicker === "function") {
            input.showPicker();
            return;
        }
    } catch (error) {
        // Fall back to click() when showPicker is unsupported or blocked.
    }

    input.click();
}

function bindCanvasInteractions() {
    function setSelectedCursor(track, canvas, sec, mode) {
        const clipStart = track.startSec;
        const clipEnd = Math.min(track.durationSec, clipStart + CLIP_SECONDS);
        if (mode === "clip") {
            canvas.style.cursor = sec >= clipStart && sec <= clipEnd ? "grab" : "ew-resize";
            return;
        }

        const nearLeft = Math.abs(sec - clipStart) <= 0.5;
        const nearRight = Math.abs(sec - clipEnd) <= 0.5;
        const inClip = sec >= clipStart && sec <= clipEnd;
        canvas.style.cursor = nearLeft || nearRight || inClip ? "grab" : "pointer";
    }

    els.selectedClipCanvas.addEventListener("mousedown", (event) => {
        const track = getSelectedTrack();
        if (!track || !track.decoded) {
            return;
        }

        const range = getClipWindow(track);
        const sec = pointerToSec(els.selectedClipCanvas, event, range.start, range.end);
        const clipStart = track.startSec;
        const clipEnd = Math.min(track.durationSec, clipStart + CLIP_SECONDS);

        if (sec >= clipStart && sec <= clipEnd) {
            state.dragClip = {
                trackId: track.id,
                canvas: els.selectedClipCanvas,
                pointerDeltaSec: sec - clipStart,
                dragStartSec: track.startSec,
                downSec: sec,
                rangeStart: range.start,
                rangeEnd: range.end,
                rangeMode: "clip"
            };
            els.selectedClipCanvas.style.cursor = "grabbing";
        } else {
            syncTrackStart(track, sec);
        }

        event.preventDefault();
    });

    els.selectedClipCanvas.addEventListener("mousemove", (event) => {
        const track = getSelectedTrack();
        if (!track || !track.decoded) {
            els.selectedClipCanvas.style.cursor = "default";
            return;
        }
        const range = getClipWindow(track);
        const sec = pointerToSec(els.selectedClipCanvas, event, range.start, range.end);
        setSelectedCursor(track, els.selectedClipCanvas, sec, "clip");
    });

    els.selectedClipCanvas.addEventListener("mouseleave", () => {
        if (!state.dragClip || state.dragClip.canvas !== els.selectedClipCanvas) {
            els.selectedClipCanvas.style.cursor = "default";
        }
    });

    els.selectedFileCanvas.addEventListener("mousedown", (event) => {
        const track = getSelectedTrack();
        if (!track || !track.decoded) {
            return;
        }

        const rangeEnd = Math.max(1, track.durationSec || CLIP_SECONDS);
        const sec = pointerToSec(els.selectedFileCanvas, event, 0, rangeEnd);
        const clipStart = track.startSec;
        const clipEnd = Math.min(track.durationSec, clipStart + CLIP_SECONDS);

        if (sec >= clipStart && sec <= clipEnd) {
            state.dragClip = {
                trackId: track.id,
                canvas: els.selectedFileCanvas,
                pointerDeltaSec: sec - clipStart,
                dragStartSec: track.startSec,
                downSec: sec,
                rangeStart: 0,
                rangeEnd,
                rangeMode: "full"
            };
            els.selectedFileCanvas.style.cursor = "grabbing";
        } else {
            syncTrackStart(track, sec);
        }

        event.preventDefault();
    });

    els.selectedFileCanvas.addEventListener("mousemove", (event) => {
        const track = getSelectedTrack();
        if (!track || !track.decoded) {
            els.selectedFileCanvas.style.cursor = "default";
            return;
        }
        const rangeEnd = Math.max(1, track.durationSec || CLIP_SECONDS);
        const sec = pointerToSec(els.selectedFileCanvas, event, 0, rangeEnd);
        setSelectedCursor(track, els.selectedFileCanvas, sec, "full");
    });

    els.selectedFileCanvas.addEventListener("mouseleave", () => {
        if (!state.dragClip || state.dragClip.canvas !== els.selectedFileCanvas) {
            els.selectedFileCanvas.style.cursor = "default";
        }
    });

    window.addEventListener("mousemove", (event) => {
        if (state.dragClip) {
            const track = state.tracks.find((item) => item.id === state.dragClip.trackId);
            if (!track || !state.dragClip.canvas) {
                return;
            }
            const sec = pointerToSec(state.dragClip.canvas, event, state.dragClip.rangeStart, state.dragClip.rangeEnd);
            const delta = sec - state.dragClip.downSec;
            syncTrackStart(track, state.dragClip.dragStartSec + delta);
            return;
        }
    });

    window.addEventListener("mouseup", () => {
        state.dragClip = null;
        els.selectedClipCanvas.style.cursor = "default";
        els.selectedFileCanvas.style.cursor = "default";
    });
}

function resampleBuffer(buffer, outputRate) {
    if (buffer.sampleRate === outputRate) {
        return buffer;
    }

    const ratio = buffer.sampleRate / outputRate;
    const outLength = Math.round(buffer.length / ratio);
    const out = new AudioBuffer({
        sampleRate: outputRate,
        numberOfChannels: buffer.numberOfChannels,
        length: outLength
    });

    for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
        const src = buffer.getChannelData(ch);
        const dst = out.getChannelData(ch);
        for (let i = 0; i < outLength; i += 1) {
            const srcIndex = i * ratio;
            const lo = Math.floor(srcIndex);
            const hi = Math.min(src.length - 1, lo + 1);
            const frac = srcIndex - lo;
            dst[i] = src[lo] * (1 - frac) + src[hi] * frac;
        }
    }

    return out;
}

function writeString(view, offset, text) {
    for (let i = 0; i < text.length; i += 1) {
        view.setUint8(offset + i, text.charCodeAt(i));
    }
}

function encodeWav(buffer) {
    const pcm = resampleBuffer(buffer, WAV_RATE);
    const channels = pcm.numberOfChannels;
    const frames = pcm.length;
    const blockAlign = channels * 2;
    const dataBytes = frames * blockAlign;

    const arr = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(arr);

    writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + dataBytes, true);
    writeString(view, 8, "WAVE");
    writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, pcm.sampleRate, true);
    view.setUint32(28, pcm.sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, "data");
    view.setUint32(40, dataBytes, true);

    let offset = 44;
    for (let i = 0; i < frames; i += 1) {
        for (let ch = 0; ch < channels; ch += 1) {
            const sample = Math.max(-1, Math.min(1, pcm.getChannelData(ch)[i]));
            view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
            offset += 2;
        }
    }

    return new Uint8Array(arr);
}

function clipTrackToWav(track) {
    if (!track.decoded) {
        throw new Error(`Track audio missing for ${track.id}`);
    }

    const startFrame = Math.floor(track.startSec * track.decoded.sampleRate);
    const lenFrames = Math.floor(CLIP_SECONDS * track.decoded.sampleRate);

    if (startFrame + lenFrames > track.decoded.length) {
        throw new Error(`Clip exceeds source duration for ${track.title || track.id}`);
    }

    const clipped = new AudioBuffer({
        sampleRate: track.decoded.sampleRate,
        numberOfChannels: track.decoded.numberOfChannels,
        length: lenFrames
    });

    const fadeFrames = Math.min(Math.floor(FADE_SECONDS * track.decoded.sampleRate), Math.floor(lenFrames / 2));

    for (let ch = 0; ch < track.decoded.numberOfChannels; ch += 1) {
        const src = track.decoded.getChannelData(ch).subarray(startFrame, startFrame + lenFrames);
        const dst = clipped.getChannelData(ch);
        dst.set(src);

        for (let i = 0; i < fadeFrames; i += 1) {
            const gainIn = i / fadeFrames;
            const outIndex = lenFrames - 1 - i;
            const gainOut = i / fadeFrames;
            dst[i] *= gainIn;
            dst[outIndex] *= gainOut;
        }
    }

    return encodeWav(clipped);
}

function validateExport() {
    if (!els.themeClue.value.trim()) {
        return "Clue is required.";
    }
    if (!els.themeAnswer.value.trim()) {
        return "Answer is required.";
    }

    for (let i = 0; i < state.tracks.length; i += 1) {
        const track = state.tracks[i];
        if (!track.title || !track.artist || !track.decoded) {
            return `Track ${i + 1} is incomplete.`;
        }
        if (track.link) {
            try {
                const parsed = new URL(track.link);
                if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                    return `Track ${i + 1} link must use http or https.`;
                }
            } catch (error) {
                return `Track ${i + 1} link is not a valid URL.`;
            }
        }
        if (track.startSec + CLIP_SECONDS > track.durationSec) {
            return `Track ${i + 1} clip exceeds source duration.`;
        }
    }

    return "";
}

function parseAliasList(value) {
    return String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

function integrateBoldAskIntoClue(clueText, askText) {
    const clue = String(clueText || "").trim();
    const ask = String(askText || "").trim();

    if (!clue) {
        return { clue: "", clueAskBold: "" };
    }

    // If clue already contains inline markdown bold markers, keep them authoritative.
    if (clue.includes("**")) {
        return { clue, clueAskBold: "" };
    }

    if (!ask) {
        return { clue, clueAskBold: "" };
    }

    const parts = ask
        .split(/\s+/)
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

    if (!parts.length) {
        return { clue, clueAskBold: "" };
    }

    const pattern = parts.join("[^A-Za-z0-9]+?");
    const matchResult = new RegExp(pattern, "i").exec(clue);
    if (!matchResult || matchResult.index < 0) {
        return { clue, clueAskBold: ask };
    }

    const index = matchResult.index;
    const matchedText = matchResult[0];
    const head = clue.slice(0, index);
    const match = clue.slice(index, index + matchedText.length);
    const tail = clue.slice(index + matchedText.length);

    return {
        clue: `${head}**${match}**${tail}`,
        clueAskBold: ""
    };
}

async function exportZip() {
    const problem = validateExport();
    if (problem) {
        setStatus(problem, "bad");
        return;
    }

    const dateKey = todayAestDate();
    const integrated = integrateBoldAskIntoClue(els.themeClue.value, els.themeClueAsk.value);
    const clue = integrated.clue;
    const clueAskBold = integrated.clueAskBold;
    const answer = els.themeAnswer.value.trim();
    const aliases = parseAliasList(els.themeAliases.value)
        .filter((alias) => alias.toLowerCase() !== answer.toLowerCase());

    setStatus("Building package...", "warn");

    try {
        const zip = new JSZip();
        const root = zip.folder(`mystery-mixtape-${dateKey}`);
        const clips = root.folder("data/clips");
        const puzzles = root.folder("data/puzzles");

        const clipFileNames = [];

        for (let i = 0; i < state.tracks.length; i += 1) {
            const track = state.tracks[i];
            const safe = sanitizeFileBaseName(`${track.artist}-${track.title}`);
            const clipName = `${dateKey}__${i + 1}__${safe}.wav`;
            clipFileNames.push(clipName);
            clips.file(clipName, clipTrackToWav(track));
        }

        const puzzle = {
            date: dateKey,
            clueTitle: "Clue",
            clue,
            clueAskBold,
            theme: answer,
            aliases,
            songs: state.tracks.map((track, i) => ({
                title: track.title,
                artist: track.artist,
                link: track.link || "",
                clipSrc: `data/clips/${clipFileNames[i]}`,
                hint: ""
            }))
        };

        puzzles.file(`${dateKey}.json`, JSON.stringify(puzzle, null, 2));

        root.file(
            "data/daily-puzzles.patch.json",
            JSON.stringify(
                {
                    timezone: "Australia/Melbourne",
                    puzzles: {
                        [dateKey]: `data/puzzles/${dateKey}.json`
                    },
                    fallback: `data/puzzles/${dateKey}.json`
                },
                null,
                2
            )
        );

        root.file(
            "README_IMPORT.txt",
            [
                "Unzip and copy into project:",
                "1) data/clips/*.wav",
                `2) data/puzzles/${dateKey}.json`,
                "3) merge data/daily-puzzles.patch.json into data/daily-puzzles.json"
            ].join("\n")
        );

        const blob = await zip.generateAsync({ type: "blob" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `mystery-mixtape-${dateKey}.zip`;
        a.click();
        URL.revokeObjectURL(url);

        setStatus("Mixtape package downloaded.", "ok");
    } catch (error) {
        setStatus(error.message || "Package build failed.", "bad");
    }
}

function clearAll() {
    stopAllPreviews();
    state.tracks = createEmptyTracks();
    state.selectedTrackId = "";
    state.hoverSec = null;
    els.themeClue.value = "";
    els.themeClueAsk.value = "";
    els.themeAnswer.value = "";
    els.themeAliases.value = "";
    localStorage.removeItem(STORAGE_KEY);
    renderSegmentsStrip();
    renderCanvases();
    setStatus("All tracks and cached draft data reset.", "warn");
}

function wireEvents() {
    if (els.catalogPackSelect) {
        els.catalogPackSelect.addEventListener("change", () => {
            renderCatalogTapeOptions();
        });
    }

    if (els.catalogLoadBtn) {
        els.catalogLoadBtn.addEventListener("click", async () => {
            await loadSelectedCatalogTape();
        });
    }

    if (els.saveOverTapeBtn) {
        els.saveOverTapeBtn.addEventListener("click", async () => {
            await saveOverCurrentTape();
        });
    }

    if (els.importMixtapeBtn && els.importMixtapeInput) {
        els.importMixtapeBtn.addEventListener("keydown", (event) => {
            if (event.code !== "Space" && event.code !== "Enter") {
                return;
            }
            event.preventDefault();
            openFilePicker(els.importMixtapeInput);
        });

        els.importMixtapeInput.addEventListener("change", async () => {
            const [file] = Array.from(els.importMixtapeInput.files || []);
            const name = String(file?.name || "").toLowerCase();
            if (name.endsWith(".zip")) {
                await importMixtapeZip(file || null);
            } else {
                await importMixtapeJson(file || null);
            }
            els.importMixtapeInput.value = "";
        });
    }

    els.uploadAllBtn.addEventListener("keydown", (event) => {
        if (event.code !== "Space" && event.code !== "Enter") {
            return;
        }
        event.preventDefault();
        openFilePicker(els.uploadAllInput);
    });
    els.uploadAllInput.addEventListener("change", async () => {
        await handleBulkFiles(els.uploadAllInput.files);
        els.uploadAllInput.value = "";
    });
    els.combinedPreviewBtn.addEventListener("click", () => toggleSelectedPreview());
    els.clearSelectionBtn.addEventListener("click", clearSelection);
    els.downloadPackageBtn.addEventListener("click", exportZip);
    els.clearAllBtn.addEventListener("click", clearAll);

    [els.themeClue, els.themeClueAsk, els.themeAnswer, els.themeAliases].forEach((el) => {
        el.addEventListener("input", saveDraft);
    });

    bindCanvasInteractions();

    window.addEventListener("resize", () => {
        renderSegmentsStrip();
        renderCanvases();
    });

    window.addEventListener("keydown", (event) => {
        if (event.code !== "Space") {
            return;
        }
        if (isTypingContext()) {
            return;
        }
        event.preventDefault();
        toggleSelectedPreview({ fromBeginning: true });
    });
}

function init() {
    restoreDraft();
    if (state.selectedTrackId && !state.tracks.some((track) => track.id === state.selectedTrackId)) {
        state.selectedTrackId = "";
    }
    renderSegmentsStrip();
    renderCanvases();
    wireEvents();
    loadCatalogPacks().catch((error) => {
        setStatus(error.message || "Could not load mixtape catalog.", "warn");
    });
}

window.addEventListener("beforeunload", () => {
    stopAllPreviews();
});

init();
