// ═══════════════════════════════════════════════════════════════════
//  Auragram  –  live 2-D frequency heatmap visualiser
//  Vanilla Web Audio API + Canvas · no dependencies
// ═══════════════════════════════════════════════════════════════════

(() => {
    "use strict";

    // ── Config ────────────────────────────────────────────────────────
    const FFT_SIZE = 32768;        // → 16384 bins, ~1.3 Hz resolution @44.1 kHz
    const SMOOTHING = 0;            // no temporal smoothing — raw per-frame FFT
    const AUTO_LOAD_FILE = "Zara Larsson - Midnight Sun (Official Audio) (1080p_24fps_H264-128kbit_AAC).flac";
    const RENDER_SIZE = 512;          // off-screen render resolution (px)
    const MIN_DB = -100;
    const MAX_DB = -20;
    const BASE_FREQ = 16.3516;      // C0 in Hz
    const LOW_FREQ = 30;           // ~B0
    const HIGH_FREQ = 16000;        // ~B9
    const HPS_MAX_FREQ = 4200;      // max fundamental for HPS search (harmonics go higher)
    let _hpsBuffer = null;           // reusable Float64Array for HPS computation
    const LOW_OCTAVE = Math.log2(LOW_FREQ / BASE_FREQ); // ≈0.875
    const HIGH_OCTAVE = Math.log2(HIGH_FREQ / BASE_FREQ); // ≈9.936
    const OCTAVE_SPAN = HIGH_OCTAVE - LOW_OCTAVE;
    const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
    const HARMONIC_MAX_RATIO_OCT = 5;  // harmonic view: show up to 2^5 = 32nd harmonic
    const NUM_HARMONIC_ROWS = 10;       // equal-height rows in harmonic grid (1× … 10×)
    const AURA_HIGH_OCTAVE = HIGH_OCTAVE; // match spectrogram range
    const AURA_LOW_OCTAVE = LOW_OCTAVE;
    const AURA_OCTAVE_SPAN = AURA_HIGH_OCTAVE - AURA_LOW_OCTAVE;
    const SHEAR_EXT = 1 / OCTAVE_SPAN; // extra Y range to show full spectrum through shear

    // ── DOM refs ──────────────────────────────────────────────────────
    const canvas = document.getElementById("visualiser");
    const ctx = canvas.getContext("2d");
    const canvasWrap = document.getElementById("canvas-wrap");
    const dropOverlay = document.getElementById("drop-overlay");
    const idlePrompt = document.getElementById("idle-prompt");
    const btnPlay = document.getElementById("btn-play");
    const timeDisplay = document.getElementById("time-display");
    const fileInput = document.getElementById("file-input");
    const fileName = document.getElementById("file-name");
    const xLabels = document.getElementById("x-labels");
    const yLabels = document.getElementById("y-labels");
    const btnSwap = document.getElementById("btn-swap");
    const btnEqView = document.getElementById("btn-eq-view");
    const btnAWeight = document.getElementById("btn-a-weight");
    const btnMic = document.getElementById("btn-mic");
    const btnNoteSpec = document.getElementById("btn-note-spec");
    const tlResetBtn = document.getElementById("btn-tl-reset");
    const cutoffSlider = document.getElementById("cutoff-slider");
    const cutoffLabel = document.getElementById("cutoff-label");
    const legendDiv = document.getElementById("legend");
    const mainArea = document.getElementById("main-area");
    const timelineCanvas = document.getElementById("timeline-canvas");
    const timelineHead = document.getElementById("timeline-playhead");
    const timelineArea = document.getElementById("timeline-area");
    const canvasInner = document.getElementById("canvas-inner");
    const resizeHandle = document.getElementById("resize-handle");
    const analysisBar = document.getElementById("analysis-bar");
    const analysisFill = document.getElementById("analysis-fill");
    const analysisLabel = document.getElementById("analysis-label");
    const tlYLabels = document.getElementById("tl-y-labels");
    const tlXLabels = document.getElementById("tl-x-labels");

    // ── Off-screen render canvas ──────────────────────────────────────
    const offCanvas = document.createElement("canvas");
    offCanvas.width = RENDER_SIZE;
    offCanvas.height = RENDER_SIZE;
    const offCtx = offCanvas.getContext("2d");
    const imgData = offCtx.createImageData(RENDER_SIZE, RENDER_SIZE);
    const pixels = imgData.data;  // Uint8ClampedArray, length = 4·W·H

    // ── Audio state ───────────────────────────────────────────────────
    let audioCtx = null;
    let analyser = null;
    let gainNode = null;
    let sourceNode = null;
    let audioBuffer = null;
    let freqData = null;         // Float32Array for getFloatFrequencyData
    let prevFreqData = null;         // previous frame for onset detection
    let spectralAvg = null;         // running average per FFT bin (spectral norm)
    let isPlaying = false;
    let startedAt = 0;
    let pausedAt = 0;
    let animId = null;
    let seekDragging = false;   // true while dragging on the timeline
    let aurogramHeight = null;    // stored auragram height (px), null = auto 30%
    let scrubPending = false;   // debounce flag for scrub rendering

    // ── Microphone mode ──────────────────────────────────────────────
    let micActive = false;       // true while mic input is live
    let micStream = null;        // MediaStream from getUserMedia
    let micSource = null;        // MediaStreamAudioSourceNode

    // ── Audio latency compensation ───────────────────────────────────
    //  getPlaybackTime() returns the corrected playback position matching
    //  what the user actually hears, accounting for output pipeline latency.
    function getPlaybackTime() {
        if (!audioCtx || !audioBuffer) return pausedAt;
        if (!isPlaying) return pausedAt;
        const raw = audioCtx.currentTime - startedAt;
        const latency = (audioCtx.baseLatency || 0) + (audioCtx.outputLatency || 0);
        return Math.max(0, Math.min(audioBuffer.duration, raw - latency));
    }

    /** Compute a time-centred FFT from stored mono audio at exact timeSec.
     *  Writes results into freqData[].  Returns true on success.
     *  This replaces the AnalyserNode read — the AnalyserNode has an inherent
     *  ~370ms lag (it uses the last fftSize samples, not centred at the
     *  current position), which causes the auragram to desync from the
     *  spectrogram (which WAS centred during pre-analysis). */
    function computeFFTAtTime(timeSec) {
        if (!_fftMono || !freqData) return false;
        const totalSamples = _fftMono.length;
        const centreSample = Math.round(timeSec * _fftSampleRate);
        const startSample = centreSample - (FFT_SIZE >> 1);

        // Fill buffer with windowed samples in bit-reversed order
        for (let i = 0; i < FFT_SIZE; i++) {
            const si = startSample + i;
            const sample = (si >= 0 && si < totalSamples) ? _fftMono[si] : 0;
            const ri = _fftBitRev[i];
            _fftRe[ri] = sample * _fftWin[i];
            _fftIm[ri] = 0;
        }

        // Radix-2 Cooley-Tukey FFT (in-place)
        let stageIdx = 0;
        for (let len = 2; len <= FFT_SIZE; len <<= 1) {
            const halfLen = len >> 1;
            const twRe = _fftTwiddleRe[stageIdx];
            const twIm = _fftTwiddleIm[stageIdx];
            for (let i = 0; i < FFT_SIZE; i += len) {
                for (let j = 0; j < halfLen; j++) {
                    const a = i + j;
                    const b = a + halfLen;
                    const tRe = twRe[j] * _fftRe[b] - twIm[j] * _fftIm[b];
                    const tIm = twRe[j] * _fftIm[b] + twIm[j] * _fftRe[b];
                    _fftRe[b] = _fftRe[a] - tRe;
                    _fftIm[b] = _fftIm[a] - tIm;
                    _fftRe[a] += tRe;
                    _fftIm[a] += tIm;
                }
            }
            stageIdx++;
        }

        // Convert to dB (matching AnalyserNode output scale)
        const binCount = FFT_SIZE / 2;
        for (let b = 0; b < binCount; b++) {
            const magSq = _fftRe[b] * _fftRe[b] + _fftIm[b] * _fftIm[b];
            freqData[b] = magSq > 0 ? 10 * Math.log10(magSq / _fftNormSq) : -200;
        }
        return true;
    }

    // ── A-weighting ──────────────────────────────────────────────────
    //  Standard IEC 61672 A-weighting curve.  Returns dB correction for
    //  a given frequency (0 dB at 1 kHz, negative below ~500 Hz and
    //  above ~6 kHz, strongly negative below 100 Hz).
    function aWeightDbForFreq(f) {
        if (f <= 0) return -200;
        const f2 = f * f;
        const f4 = f2 * f2;
        const num = 12194 * 12194 * f4;
        const den = (f2 + 20.6 * 20.6)
            * Math.sqrt((f2 + 107.7 * 107.7) * (f2 + 737.9 * 737.9))
            * (f2 + 12194 * 12194);
        if (den === 0) return -200;
        return 20 * Math.log10(num / den) + 2.0; // +2.0 so A(1000 Hz) ≈ 0 dB
    }

    /** Build the per-bin A-weight LUT.  Called once from ensureAudioContext. */
    function buildAWeightLUT(binCount, sampleRate) {
        _aWeightLUT = new Float32Array(binCount);
        const binHz = sampleRate / FFT_SIZE;
        for (let b = 0; b < binCount; b++) {
            _aWeightLUT[b] = aWeightDbForFreq(b * binHz);
        }
    }

    // ── Spectrograph zoom state ──────────────────────────────────────
    let tlZoomX = 1;    // X zoom level (1 = full track visible)
    let tlPanX = 0;    // X pan (fraction 0..1 of full duration, left edge)
    let tlZoomY = 1;    // Y zoom level (1 = full freq range)
    let tlPanY = 0;    // Y pan (fraction 0..1 of freq range, bottom edge)
    let lastTlRedraw = 0; // throttle timestamp for auto-pan redraws

    // ── Auragram zoom state (harmonic view X axis) ───────────────────
    let auraZoomX = 1;   // 1 = full range visible
    let auraPanX = 0;   // fraction 0..1 of total range, left edge

    // ── Processing modes (independently toggleable) ──────────────────
    let modeOnset = false;      // transient emphasis (boost frame-to-frame increases)
    let noteColourSpec = false;      // colour spectrogram by note hue
    let harmCutoffPct = 0;          // harmonic cutoff slider (0 = no cutoff, 100 = reject all)
    let hoverFundNote = null;       // MIDI-ish note number of hovered fundamental (null = no hover)
    let selNoteLo = null;       // drag-selected note range low (MIDI note, null = no selection)
    let selNoteHi = null;       // drag-selected note range high (MIDI note)
    let selRowLo = null;       // drag-selected harmonic row range low (1-based, null = all)
    let selRowHi = null;       // drag-selected harmonic row range high (1-based)
    let showHarmonics = false;      // harmonic overlay (off by default)
    let sourceGrouped = true;       // group X axis by source (on by default)
    let colourMode = 'amplitude'; // default to amplitude heatmap
    let viewMode = 'harmonic';  // 'sheared' | 'swapped' | 'harmonic'
    let harmSwapped = false;       // swap X/Y in harmonic view
    let spectralAvgSeeded = false;      // has the avg been seeded from real data?
    let prevRenderedDb = null;       // previous frame's per-pixel dB (for onset after normalize)
    let curFrameDb = null;           // reusable per-frame dB buffer (RENDER_SIZE²)
    // Reusable per-frame typed arrays (allocated once when analyser is created)
    let _binRow = null;              // Int8Array[binCount]
    let _binFund = null;             // Int32Array[binCount]
    let _binClaimCount = null;       // Uint8Array[binCount]
    let _isSpecPeak = null;          // Uint8Array[binCount]
    // Temporal persistence: keep confirmed notes across frames to prevent
    // transient beats from stealing vocal harmonics.
    // Map<midi, { freq: number, hold: number }>
    let _prevConfirmedNotes = new Map();
    const NOTE_HOLD_FRAMES = 8;      // frames to persist a confirmed note after detection drops it
    const NOTE_HOLD_MIN_DB_ABOVE = 15; // held note must still have energy (dB above MIN_DB)
    const NORM_ALPHA = 0.02;       // running average decay (lower = slower adapt)
    let aWeightEnabled = true;       // A-weighting toggle (default on)
    let _aWeightLUT = null;          // Float32Array[binCount] — dB correction per bin
    const GAMMA = 1.8;        // power curve for colour mapping (>1 = suppress quiet, boost loud)

    // ── Stored FFT infrastructure (populated by runPreAnalysis) ───────
    //  Used by computeFFTAtTime() to compute perfectly time-centred FFTs
    //  from the raw audio, eliminating the AnalyserNode's inherent
    //  ~370ms lag (fftSize/2 samples of look-behind).
    let _fftMono = null;         // Float32Array — mono audio samples
    let _fftWin = null;          // Float32Array — Blackman window
    let _fftBitRev = null;       // Uint32Array  — bit-reversal permutation
    let _fftTwiddleRe = null;    // Array<Float64Array> — cos twiddle factors per stage
    let _fftTwiddleIm = null;    // Array<Float64Array> — sin twiddle factors per stage
    let _fftRe = null;           // Float32Array — FFT real working buffer
    let _fftIm = null;           // Float32Array — FFT imag working buffer
    let _fftNormSq = 0;          // fftLen² — normalisation divisor
    let _fftSampleRate = 0;      // sample rate of the stored audio

    // Density correction: convert per-Hz amplitude to per-semitone (log-freq) density.
    // Adds 10·log₁₀(f / fRef) to raw dB.  fRef = 440 Hz (A4)  →  correction = 0 at A4.
    const DENSITY_REF_FREQ = 440;
    const DENSITY_LOG_REF = 10 * Math.log10(DENSITY_REF_FREQ); // cached
    // Adjusted display range to accommodate density correction
    // At 30Hz: correction ≈ −11.7 dB; at 16kHz: correction ≈ +15.6 dB
    const DENSITY_MIN = MIN_DB - 15;   // −115
    const DENSITY_MAX = MAX_DB + 18;   //   −2
    const DENSITY_RANGE = DENSITY_MAX - DENSITY_MIN; // 113

    // ── Per-bin timbre colour (OKLAB a, b) ────────────────────────────
    let binColA = null;                // Float32Array[frequencyBinCount] OKLAB a
    let binColB = null;                // Float32Array[frequencyBinCount] OKLAB b

    // ── Persistent source tracking ────────────────────────────────────
    //  Each detected source gets a stable identity (A, B, C…) and a fixed
    //  hue that persists across frames even as the source changes pitch.
    //  Identity is matched via harmonic-envelope fingerprint similarity.
    const SOURCE_LABELS = 'ABCDEFGHIJKLMNOP';
    const MAX_SESSIONS = 8;           // max tracked sources (never expired)
    const SESSION_EXPIRY = 120;        // frames before a source fades in the panel
    const FP_LEN = 16;          // total fingerprint dimensions
    const MATCH_THRESH = 0.55;        // min cosine similarity to match
    const FP_ALPHA = 0.08;        // running-avg update rate for fingerprint
    let sessionIdCounter = 0;
    let frameCounter = 0;

    // ── Source isolation (hover) ───────────────────────────────────────
    let isolatedSrcId = null;         // session id being soloed (null = all)
    let hoveredSrcId = null;         // session id the mouse is over
    let soloGain = null;         // GainNode for isolated audio
    let soloFilters = [];           // active BiquadFilterNodes for isolation
    let allSessions = [];           // [{id, label, hue, cosH, sinH, fingerprint, lastSeen, freq}]

    // ── Note hover isolation ───────────────────────────────────────────
    let hoverGainNode = null;         // GainNode for hover-isolated audio
    let hoverFilterNodes = [];         // BiquadFilterNodes for hover note
    let lastHoverBins = null;         // Set<binIndex> from last renderFrame (detected harmonics)

    // ── Pre-analysis (two-pass) ────────────────────────────────────────
    //  After loading a file we run an offline FFT scan across the whole
    //  track to build robust source profiles.  `preAnalysis` stores the
    //  results so that real-time rendering can match sources using stable
    //  pre-computed fingerprints rather than noisy per-frame estimates.
    const PRE_ANALYSIS_HOP = 0.05;      // seconds between analysis frames (50 ms)
    let preAnalysis = null;       // {sessions, timeline, duration, fps}
    //  preAnalysis.sessions: [{id, label, hue, cosH, sinH, fingerprint, instrumentGuess, avgFreq}]
    //  preAnalysis.timeline: Float32Array[nFrames * maxSources] — source presence grid
    //  preAnalysis.presenceMap: Map<sessionId, Float32Array[nFrames]> — activity 0..1
    //  preAnalysis.nFrames: total frames
    //  preAnalysis.frameTimes: Float64Array — time in seconds for each frame

    /** Fixed hue wheel — first 8 are maximally spaced, deterministic. */
    function sessionHue(idx) {
        // Golden-angle spacing so colours never cluster
        return (idx * 0.618033988749895 * 2 * Math.PI) % (2 * Math.PI);
    }

    /** Extract 16-dimensional timbral fingerprint for a fundamental at `freq`.
     *
     *  Dimensions:
     *    [0..7]  Harmonic relative amplitudes (dB, clamped –40…0, peak-interpolated)
     *    [8]     Spectral centroid (harmonic-weighted, scaled)
     *    [9]     Spectral flatness (geo-mean / arith-mean of harmonic amps)
     *    [10]    Odd / even harmonic asymmetry
     *    [11]    Harmonic-to-noise ratio (energy at harmonic peaks vs total band)
     *    [12]    Log-frequency register (octaves above A1 = 55 Hz)
     *    [13]    High-harmonic energy ratio (harmonics 5–8 vs 1–4)
     *    [14]    Sub-fundamental energy (half-freq relative to fundamental)
     *    [15]    Spectral tilt (linear slope of harmonic decay)
     *
     *  The vector is normalised to unit length so cosine similarity works.
     *  Each extra dimension is pre-scaled so it has influence comparable to
     *  the harmonic-envelope dimensions. */
    function extractFingerprint(freq) {
        const binWidth = audioCtx.sampleRate / FFT_SIZE;
        const fp = new Float64Array(FP_LEN);
        const fundBin = Math.round(freq / binWidth);
        const fundDb = (fundBin >= 0 && fundBin < freqData.length) ? freqData[fundBin] : MIN_DB;
        const fundAmp = Math.pow(10, (fundDb - MIN_DB) / 20);

        // ── [0..7] Harmonic relative amplitude (peak-interpolated) ────
        for (let h = 0; h < 8; h++) {
            const hBin = Math.round(freq * (h + 1) / binWidth);
            if (hBin < 0 || hBin >= freqData.length) { fp[h] = 0; continue; }
            let best = freqData[hBin];
            for (let d = -2; d <= 2; d++) {
                const idx = hBin + d;
                if (idx >= 0 && idx < freqData.length) best = Math.max(best, freqData[idx]);
            }
            fp[h] = Math.max(-40, Math.min(0, best - fundDb));
        }

        // ── [8] Spectral centroid (as weighted harmonic number) ────────
        let wSum = 0, fSum = 0;
        for (let h = 1; h <= 12; h++) {
            const hBin = Math.round(freq * h / binWidth);
            if (hBin >= freqData.length) break;
            const amp = Math.pow(10, (freqData[hBin] - MIN_DB) / 20);
            wSum += amp;
            fSum += amp * h;
        }
        fp[8] = wSum > 0 ? (fSum / wSum) * 3 : 0;          // ×3 scaling

        // ── [9] Spectral flatness across harmonics ─────────────────────
        let logS = 0, linS = 0, hCnt = 0;
        for (let h = 1; h <= 8; h++) {
            const hBin = Math.round(freq * h / binWidth);
            if (hBin >= freqData.length) break;
            const amp = Math.pow(10, (freqData[hBin] - MIN_DB) / 20);
            if (amp > 0) { logS += Math.log(amp); linS += amp; hCnt++; }
        }
        fp[9] = (hCnt > 0 && linS > 0) ?
            (Math.exp(logS / hCnt) / (linS / hCnt)) * 10 : 0;  // ×10

        // ── [10] Odd / even harmonic asymmetry ─────────────────────────
        let oddE = 0, evenE = 0;
        for (let h = 1; h <= 8; h++) {
            const hBin = Math.round(freq * h / binWidth);
            if (hBin >= freqData.length) break;
            const amp = Math.pow(10, (freqData[hBin] - MIN_DB) / 20);
            if (h % 2 === 1) oddE += amp; else evenE += amp;
        }
        fp[10] = (oddE + evenE > 0) ?
            ((oddE - evenE) / (oddE + evenE)) * 5 : 0;         // ×5

        // ── [11] Harmonic-to-noise ratio ───────────────────────────────
        //    Ratio of energy at harmonic peaks to total energy in the band
        let harmEnergy = 0, totalEnergy = 0;
        for (let h = 1; h <= 8; h++) {
            const hBin = Math.round(freq * h / binWidth);
            if (hBin >= freqData.length) break;
            harmEnergy += Math.pow(10, (freqData[hBin] - MIN_DB) / 20);
        }
        const lo = Math.max(0, Math.round(freq / binWidth));
        const hi = Math.min(freqData.length - 1, Math.round(8 * freq / binWidth));
        for (let b = lo; b <= hi; b++) {
            totalEnergy += Math.pow(10, (freqData[b] - MIN_DB) / 20);
        }
        fp[11] = totalEnergy > 0 ? (harmEnergy / totalEnergy) * 8 : 0;   // ×8

        // ── [12] Log-frequency register ────────────────────────────────
        //    A1 = 55 Hz → 0, each octave adds 2
        fp[12] = Math.log2(Math.max(30, freq) / 55) * 2;

        // ── [13] High-harmonic presence (H5–H8 / H1–H4) ──────────────
        let lowH = 0, highH = 0;
        for (let h = 1; h <= 4; h++) {
            const hBin = Math.round(freq * h / binWidth);
            if (hBin < freqData.length) lowH += Math.pow(10, (freqData[hBin] - MIN_DB) / 20);
        }
        for (let h = 5; h <= 8; h++) {
            const hBin = Math.round(freq * h / binWidth);
            if (hBin < freqData.length) highH += Math.pow(10, (freqData[hBin] - MIN_DB) / 20);
        }
        fp[13] = lowH > 0 ? (highH / lowH) * 5 : 0;                    // ×5

        // ── [14] Sub-fundamental energy ────────────────────────────────
        const subBin = Math.round(0.5 * freq / binWidth);
        let subAmp = 0;
        if (subBin >= 0 && subBin < freqData.length) {
            subAmp = Math.pow(10, (freqData[subBin] - MIN_DB) / 20);
        }
        fp[14] = fundAmp > 0 ? (subAmp / fundAmp) * 5 : 0;             // ×5

        // ── [15] Spectral tilt (linear slope of harmonic decay in dB) ──
        let sX = 0, sY = 0, sXY = 0, sX2 = 0, n = 0;
        for (let h = 1; h <= 8; h++) {
            const hBin = Math.round(freq * h / binWidth);
            if (hBin >= freqData.length) break;
            const y = freqData[hBin] - fundDb;
            sX += h; sY += y; sXY += h * y; sX2 += h * h; n++;
        }
        if (n >= 2) {
            fp[15] = ((n * sXY - sX * sY) / (n * sX2 - sX * sX)) * 2;   // ×2
        }

        // ── Normalise to unit vector ───────────────────────────────────
        let mag = 0;
        for (let i = 0; i < FP_LEN; i++) mag += fp[i] * fp[i];
        mag = Math.sqrt(mag);
        if (mag > 0.001) for (let i = 0; i < FP_LEN; i++) fp[i] /= mag;
        return fp;
    }

    /** Extract 16-harmonic relative amplitude envelope for a fundamental.
     *  Returns Float32Array[16] where env[0]=0 (h1 reference), env[h-1] =
     *  dB of h-th harmonic relative to the fundamental.
     *  Used during pre-analysis to build timbral templates and at runtime
     *  to match against them.
     *  @param {Float32Array} specDb  - full dB spectrum
     *  @param {number}       freq    - fundamental frequency in Hz
     *  @param {number}       binHz   - Hz per FFT bin
     *  @param {number}       bins    - number of FFT bins */
    function extractHarmonicEnvelope(specDb, freq, binHz, bins) {
        const env = new Float32Array(16);
        const fundBin = Math.round(freq / binHz);
        const fundDb = (fundBin >= 0 && fundBin < bins) ? specDb[fundBin] : MIN_DB;
        env[0] = 0; // h1 is reference (0 dB relative)
        for (let h = 2; h <= 16; h++) {
            const hBin = Math.round(freq * h / binHz);
            if (hBin >= bins) { env[h - 1] = -60; continue; }
            // Peak-interpolate ±2 bins to handle spectral leakage
            let best = specDb[hBin];
            for (let d = -2; d <= 2; d++) {
                const idx = hBin + d;
                if (idx >= 0 && idx < bins) best = Math.max(best, specDb[idx]);
            }
            env[h - 1] = Math.max(-60, best - fundDb);
        }
        return env;
    }

    /** Cosine similarity between two unit-length envelopes. */
    function envelopeSimilarity(a, b) {
        let dot = 0, magA = 0, magB = 0;
        for (let i = 0; i < 16; i++) {
            dot += a[i] * b[i];
            magA += a[i] * a[i];
            magB += b[i] * b[i];
        }
        return dot / (Math.sqrt(magA * magB) + 1e-10);
    }

    /** Cosine similarity between two fingerprints. */
    function fpSimilarity(a, b) {
        let dot = 0;
        for (let i = 0; i < FP_LEN; i++) dot += a[i] * b[i];
        return dot;  // both already unit-normalised
    }

    /** Classify the likely instrument / source type from spectral features.
     *  Returns a short human-readable label (e.g. "Vocals", "Bass", "Guitar").
     *
     *  Uses a scoring system based on well-established timbral descriptors:
     *    • Spectral flatness   (noise-like → percussion)
     *    • Harmonic-to-noise ratio (HNR)
     *    • Fundamental frequency register
     *    • Spectral centroid
     *    • Odd/even harmonic asymmetry
     *    • Spectral tilt (harmonic decay rate)
     *  Ref: Peeters (2003) "A Large Set of Audio Features for Sound Description"
     *       MFCC / MIR literature on timbral feature classification */
    function classifyInstrument(freq) {
        if (!freqData || !audioCtx) return '?';
        const binWidth = audioCtx.sampleRate / FFT_SIZE;
        const fundBin = Math.round(freq / binWidth);
        const fundDb = (fundBin >= 0 && fundBin < freqData.length) ? freqData[fundBin] : MIN_DB;

        // ── Feature: Spectral centroid (weighted harmonic number) ──────
        let wSum = 0, fSum = 0;
        for (let h = 1; h <= 12; h++) {
            const hBin = Math.round(freq * h / binWidth);
            if (hBin >= freqData.length) break;
            const a = Math.pow(10, (freqData[hBin] - MIN_DB) / 20);
            wSum += a; fSum += a * h;
        }
        const centroid = wSum > 0 ? fSum / wSum : 1;

        // ── Feature: Spectral flatness (geometric / arithmetic mean) ───
        let logS = 0, linS = 0, cnt = 0;
        for (let h = 1; h <= 8; h++) {
            const hBin = Math.round(freq * h / binWidth);
            if (hBin >= freqData.length) break;
            const a = Math.pow(10, (freqData[hBin] - MIN_DB) / 20);
            if (a > 0) { logS += Math.log(a); linS += a; cnt++; }
        }
        const flatness = (cnt > 0 && linS > 0) ?
            Math.exp(logS / cnt) / (linS / cnt) : 0;

        // ── Feature: Harmonic-to-noise ratio ───────────────────────────
        let harmE = 0, totE = 0;
        for (let h = 1; h <= 8; h++) {
            const hBin = Math.round(freq * h / binWidth);
            if (hBin >= freqData.length) break;
            harmE += Math.pow(10, (freqData[hBin] - MIN_DB) / 20);
        }
        const bLo = Math.max(0, Math.round(freq / binWidth));
        const bHi = Math.min(freqData.length - 1, Math.round(8 * freq / binWidth));
        for (let b = bLo; b <= bHi; b++) {
            totE += Math.pow(10, (freqData[b] - MIN_DB) / 20);
        }
        const hnr = totE > 0 ? harmE / totE : 0;

        // ── Feature: Odd/even harmonic ratio ───────────────────────────
        let oddE = 0, evenE = 0;
        for (let h = 1; h <= 8; h++) {
            const hBin = Math.round(freq * h / binWidth);
            if (hBin >= freqData.length) break;
            const a = Math.pow(10, (freqData[hBin] - MIN_DB) / 20);
            if (h % 2 === 1) oddE += a; else evenE += a;
        }
        const oeRatio = evenE > 0 ? oddE / evenE : 10;

        // ── Feature: Spectral tilt ─────────────────────────────────────
        let sX = 0, sY = 0, sXY = 0, sX2 = 0, n = 0;
        for (let h = 1; h <= 8; h++) {
            const hBin = Math.round(freq * h / binWidth);
            if (hBin >= freqData.length) break;
            const y = freqData[hBin] - fundDb;
            sX += h; sY += y; sXY += h * y; sX2 += h * h; n++;
        }
        const tilt = n >= 2 ? (n * sXY - sX * sY) / (n * sX2 - sX * sX) : 0;

        // ── Score-based classification ─────────────────────────────────
        const scores = {};

        // Percussion / Drums: high flatness, low HNR
        scores['Perc'] = (flatness > 0.5 ? 3 : 0) + (hnr < 0.2 ? 2 : 0);

        // Bass: very low register
        scores['Bass'] = (freq < 110 ? 4 : freq < 180 ? 2 : 0)
            + (centroid < 3 ? 1 : 0);

        // Vocals: moderate HNR (breathiness), mid register, moderate centroid
        scores['Vocals'] = (freq > 100 && freq < 1100 ? 1 : 0)
            + (hnr > 0.15 && hnr < 0.50 ? 2 : 0)
            + (centroid > 2 && centroid < 7 ? 1 : 0)
            + (flatness > 0.2 && flatness < 0.6 ? 1 : 0);

        // Guitar: mid register, decent harmonics, moderate tilt
        scores['Guitar'] = (freq >= 70 && freq <= 1000 ? 1 : 0)
            + (hnr > 0.3 ? 1 : 0)
            + (tilt > -6 && tilt < -1 ? 1 : 0)
            + (centroid > 1.5 && centroid < 5 ? 1 : 0);

        // Keys/Piano: clean harmonics, wide register
        scores['Keys'] = (hnr > 0.5 ? 2 : 0)
            + (flatness < 0.25 ? 1 : 0)
            + (freq >= 50 && freq <= 4000 ? 1 : 0);

        // Strings/Pads: very clean, strong even harmonics
        scores['Strings'] = (hnr > 0.5 ? 1 : 0)
            + (flatness < 0.2 ? 1 : 0)
            + (oeRatio < 1.5 ? 1 : 0)
            + (tilt > -3 ? 1 : 0);

        // Synth/Lead: high register, very clean or bright
        scores['Synth'] = (freq > 500 ? 1 : 0)
            + (hnr > 0.6 ? 1 : 0)
            + (centroid > 4 ? 1 : 0);

        // Brass/Wind: strong odd harmonics, moderate register
        scores['Brass'] = (oeRatio > 2.5 ? 2 : 0)
            + (freq > 100 && freq < 1200 ? 1 : 0)
            + (hnr > 0.35 ? 1 : 0);

        // Pick the highest-scoring category
        let best = '?', bestScore = -1;
        for (const [cat, sc] of Object.entries(scores)) {
            if (sc > bestScore) { bestScore = sc; best = cat; }
        }
        return best;
    }

    /** Match detected fundamentals to persistent sessions (allSessions).
     *  Sessions are never expired — they persist for the whole track so that
     *  scrubbing back re‑matches the same sources instead of creating new ones.
     *  Returns fundamentals annotated with .sessionId, .hue, .label, .cosH, .sinH */
    function matchToSessions(fundamentals) {
        frameCounter++;
        const nf = fundamentals.length;
        if (nf === 0) return fundamentals;

        // Extract fingerprints for current detections
        const fps = fundamentals.map(f => extractFingerprint(f.freq));

        // ── Step 0: Cluster fundamentals by fingerprint similarity ─────
        const CLUSTER_THRESH = 0.85;
        const clusterOf = new Int8Array(nf);
        clusterOf.fill(-1);
        let nClusters = 0;
        for (let i = 0; i < nf; i++) {
            if (clusterOf[i] >= 0) continue;
            clusterOf[i] = nClusters;
            for (let j = i + 1; j < nf; j++) {
                if (clusterOf[j] >= 0) continue;
                if (fpSimilarity(fps[i], fps[j]) >= CLUSTER_THRESH) {
                    clusterOf[j] = nClusters;
                }
            }
            nClusters++;
        }

        // Build per-cluster representative fingerprint
        const clusterFp = [];
        const clusterMembers = [];
        for (let c = 0; c < nClusters; c++) {
            const members = [];
            const avg = new Float64Array(FP_LEN);
            for (let fi = 0; fi < nf; fi++) {
                if (clusterOf[fi] !== c) continue;
                members.push(fi);
                for (let k = 0; k < FP_LEN; k++) avg[k] += fps[fi][k];
            }
            const n = members.length;
            for (let k = 0; k < FP_LEN; k++) avg[k] /= n;
            let mag = 0;
            for (let k = 0; k < FP_LEN; k++) mag += avg[k] * avg[k];
            mag = Math.sqrt(mag);
            if (mag > 0.001) for (let k = 0; k < FP_LEN; k++) avg[k] /= mag;
            clusterFp.push(avg);
            clusterMembers.push(members);
        }

        // ══ PRE-ANALYSIS MODE: match only to fixed reference sessions ══
        // When preAnalysis exists (i.e. NOT during pre-analysis itself),
        // never create new sessions — only match against existing ones.
        const locked = preAnalysis !== null;

        // ── Step 1: Match clusters to ANY session (including stale) ────
        const usedSess = new Set();
        const clusterAssigned = new Array(nClusters).fill(-1);

        for (let pass = 0; pass < nClusters; pass++) {
            let bestSim = -Infinity, bestCi = -1, bestSi = -1;
            for (let ci = 0; ci < nClusters; ci++) {
                if (clusterAssigned[ci] >= 0) continue;
                for (let si = 0; si < allSessions.length; si++) {
                    if (usedSess.has(si)) continue;
                    const sim = fpSimilarity(clusterFp[ci], allSessions[si].fingerprint);
                    if (sim > bestSim) { bestSim = sim; bestCi = ci; bestSi = si; }
                }
            }
            // Use a lower threshold when locked — we trust the pre-analysis profiles
            const thresh = locked ? MATCH_THRESH * 0.8 : MATCH_THRESH;
            if (bestSim >= thresh && bestCi >= 0) {
                clusterAssigned[bestCi] = bestSi;
                usedSess.add(bestSi);
            } else {
                break;
            }
        }

        // ── Step 2: Create new sessions for unmatched clusters ─────────
        //    (Skipped when locked — pre-analysis already built all sessions)
        if (!locked) {
            for (let ci = 0; ci < nClusters; ci++) {
                if (clusterAssigned[ci] >= 0) continue;
                if (allSessions.length >= MAX_SESSIONS) {
                    // At capacity — force-match to best existing even if below threshold
                    let bestSim = -Infinity, bestSi = -1;
                    for (let si = 0; si < allSessions.length; si++) {
                        if (usedSess.has(si)) continue;
                        const sim = fpSimilarity(clusterFp[ci], allSessions[si].fingerprint);
                        if (sim > bestSim) { bestSim = sim; bestSi = si; }
                    }
                    if (bestSi >= 0) {
                        clusterAssigned[ci] = bestSi;
                        usedSess.add(bestSi);
                    }
                    continue;
                }
                const newId = sessionIdCounter++;
                const hue = sessionHue(newId);
                const newFreq = fundamentals[clusterMembers[ci][0]].freq;
                allSessions.push({
                    id: newId,
                    label: SOURCE_LABELS[newId % SOURCE_LABELS.length],
                    hue: hue,
                    cosH: Math.cos(hue),
                    sinH: Math.sin(hue),
                    fingerprint: clusterFp[ci].slice(),
                    lastSeen: frameCounter,
                    freq: newFreq,
                    instrumentGuess: classifyInstrument(newFreq),
                    classifyCounter: 0
                });
                clusterAssigned[ci] = allSessions.length - 1;
                usedSess.add(clusterAssigned[ci]);
            }
        }

        // ── Step 3: Update matched sessions ────────────────────────────
        //    When locked (post-pre-analysis), do NOT drift the reference
        //    fingerprints — keep them fixed so matching stays stable.
        for (let ci = 0; ci < nClusters; ci++) {
            const si = clusterAssigned[ci];
            if (si < 0 || si >= allSessions.length) continue;
            const sess = allSessions[si];
            sess.lastSeen = frameCounter;
            sess.freq = fundamentals[clusterMembers[ci][0]].freq;
            if (!locked) {
                const fp = clusterFp[ci];
                for (let k = 0; k < FP_LEN; k++) {
                    sess.fingerprint[k] = sess.fingerprint[k] * (1 - FP_ALPHA) + fp[k] * FP_ALPHA;
                }
                let mag = 0;
                for (let k = 0; k < FP_LEN; k++) mag += sess.fingerprint[k] * sess.fingerprint[k];
                mag = Math.sqrt(mag);
                if (mag > 0.001) for (let k = 0; k < FP_LEN; k++) sess.fingerprint[k] /= mag;
                // Re-classify periodically (every ~30 frames) for stability
                sess.classifyCounter = (sess.classifyCounter || 0) + 1;
                if (sess.classifyCounter >= 30) {
                    sess.classifyCounter = 0;
                    sess.instrumentGuess = classifyInstrument(sess.freq);
                }
            }
        }

        // (No session expiry — allSessions persists for the whole track)

        // ── Step 4: Annotate all fundamentals ──────────────────────────
        for (let ci = 0; ci < nClusters; ci++) {
            const si = clusterAssigned[ci];
            for (const fi of clusterMembers[ci]) {
                if (si >= 0 && si < allSessions.length) {
                    const sess = allSessions[si];
                    fundamentals[fi].sessionId = sess.id;
                    fundamentals[fi].hue = sess.hue;
                    fundamentals[fi].cosH = sess.cosH;
                    fundamentals[fi].sinH = sess.sinH;
                    fundamentals[fi].label = sess.label;
                } else {
                    fundamentals[fi].sessionId = -1;
                    fundamentals[fi].hue = 0;
                    fundamentals[fi].cosH = 1;
                    fundamentals[fi].sinH = 0;
                    fundamentals[fi].label = '?';
                }
            }
        }

        return fundamentals;
    }

    // ── Pre-computed lookup: pixel row/col → FFT bin (float) ──────────
    //    Computed once per resize so the hot render loop is just lookups.
    let binLookup = null;         // Float64Array[RENDER_SIZE * RENDER_SIZE]

    // ═════════════════  SOURCE PANEL (removed — info now in timeline)  ══

    function updateSourcePanel() {
        // no-op — source info is shown in the timeline spectrogram lanes
    }

    // ═════════════════  AUDIO ISOLATION  ══════════════════════════════
    //  When a source is isolated (soloed), we create a parallel chain of
    //  narrow bandpass filters at each of its harmonics.  The main gain
    //  is muted; the solo chain goes to a separate gain → destination.
    //  Filters are updated every frame as the source's pitch changes.

    /** Create or tear down the isolation filter chain. */
    function applyIsolation() {
        if (!audioCtx || !sourceNode) return;

        // Tear down existing solo chain
        teardownSoloChain();

        if (isolatedSrcId === null) {
            // Unmute main path
            if (gainNode) gainNode.gain.value = 1;
            return;
        }

        // Mute main audio path
        gainNode.gain.value = 0;

        // Create solo gain node
        soloGain = audioCtx.createGain();
        soloGain.gain.value = 1;
        soloGain.connect(audioCtx.destination);

        // Find the session data for the isolated source
        const sess = allSessions.find(s => s.id === isolatedSrcId);
        if (!sess) return;

        buildSoloFilters(sess);
    }

    /** Build bandpass filters covering the frequency bands of a source's
     *  correlation-cluster bins.  This uses the actual correlated bin
     *  frequency ranges rather than assuming harmonic positions. */
    function buildSoloFilters(sess) {
        if (!audioCtx || !sourceNode || !soloGain) return;

        for (const f of soloFilters) {
            try { f.disconnect(); } catch (_) { }
        }
        soloFilters = [];

        const nyquist = audioCtx.sampleRate / 2;
        const binFreqs = sess.corrBinFreqs;
        if (!binFreqs || binFreqs.length === 0) return;

        // Group adjacent bins into contiguous frequency bands, then
        // create one bandpass per band.  This is more efficient than
        // one filter per bin and covers the full bandwidth of each source.
        const sorted = binFreqs.slice().sort((a, b) => a - b);
        const bands = [];
        let bandLo = sorted[0], bandHi = sorted[0];
        for (let i = 1; i < sorted.length; i++) {
            // If gap between successive bins > ~3 semitones, start new band
            if (Math.log2(sorted[i] / bandHi) > 0.25) {
                bands.push([bandLo, bandHi]);
                bandLo = sorted[i];
            }
            bandHi = sorted[i];
        }
        bands.push([bandLo, bandHi]);

        for (const [lo, hi] of bands) {
            const center = Math.sqrt(lo * hi);  // geometric mean
            if (center >= nyquist * 0.95 || center < 10) continue;
            const bw = Math.max(0.5, Math.log2(hi / lo) + 0.5); // bandwidth in octaves + margin
            const Q = 1 / (2 * Math.sinh(Math.LN2 / 2 * bw));

            const bp = audioCtx.createBiquadFilter();
            bp.type = 'bandpass';
            bp.frequency.value = center;
            bp.Q.value = Math.max(0.5, Math.min(25, Q));

            sourceNode.connect(bp);
            bp.connect(soloGain);
            soloFilters.push(bp);
        }
    }

    /** Update solo filter frequencies — no-op for correlation clusters
     *  since the frequency bands don't drift. */
    function updateSoloFilters() {
        // Correlation-based clusters have fixed frequency assignments,
        // so filter positions don't need per-frame updates.
    }

    /** Tear down the solo filter chain. */
    function teardownSoloChain() {
        for (const f of soloFilters) {
            try { f.disconnect(); } catch (_) { }
        }
        soloFilters = [];
        if (soloGain) {
            try { soloGain.disconnect(); } catch (_) { }
            soloGain = null;
        }
    }

    // ── Note hover sound isolation ─────────────────────────────────────

    /** Return effective isolation range {lo, hi, rowLo, rowHi}, or null.
     *  Spectral isolation is currently disabled — always returns null.
     *  The infrastructure remains so it can be re-enabled later. */
    function getIsolationRange() {
        return null;  // isolation disabled
    }

    /** Tear down any active hover filter chain and restore normal audio. */
    function teardownHoverFilters() {
        for (const f of hoverFilterNodes) {
            try { f.disconnect(); } catch (_) { }
        }
        hoverFilterNodes = [];
        if (hoverGainNode) {
            try { hoverGainNode.disconnect(); } catch (_) { }
            hoverGainNode = null;
        }
        // Unmute main path
        if (gainNode) gainNode.gain.value = 1;
    }

    const MAX_ISO_BANDS = 60;  // max bandpass groups before we give up filtering

    /** Build bandpass filters from detected bins (lastHoverBins).
     *  Falls back to theoretical harmonic positions if no detected bins.
     *  Uses a cascade of 4 bandpass filters per band (48 dB/oct rolloff). */
    function applyHoverFilters() {
        teardownHoverFilters();
        const range = getIsolationRange();
        if (!range || !audioCtx || !sourceNode) return;

        // Mute main dry path
        gainNode.gain.value = 0;

        // Create wet gain
        hoverGainNode = audioCtx.createGain();
        hoverGainNode.gain.value = 1;
        hoverGainNode.connect(audioCtx.destination);

        const nyquist = audioCtx.sampleRate / 2;
        const CASCADE = 4;

        // Collect band centres to filter
        let bands = [];  // [[lo, hi], ...]

        if (lastHoverBins && lastHoverBins.size > 0) {
            // Use detected bin frequencies
            const binFreqHz = audioCtx.sampleRate / FFT_SIZE;
            const freqs = [];
            for (const b of lastHoverBins) freqs.push(b * binFreqHz);
            freqs.sort((a, b) => a - b);

            // Merge adjacent frequencies within 1.5 semitones into bands
            let bLo = freqs[0], bHi = freqs[0];
            for (let i = 1; i < freqs.length; i++) {
                if (Math.log2(freqs[i] / bHi) < 1.5 / 12) {
                    bHi = freqs[i];
                } else {
                    bands.push([bLo, bHi]);
                    bLo = freqs[i]; bHi = freqs[i];
                }
            }
            bands.push([bLo, bHi]);
        } else {
            // Fallback: theoretical harmonics for notes in range
            for (let note = range.lo; note <= range.hi; note++) {
                const fundFreq = BASE_FREQ * Math.pow(2, note / 12);
                for (let h = range.rowLo; h <= range.rowHi; h++) {
                    const freq = fundFreq * h;
                    if (freq >= nyquist * 0.95) break;
                    bands.push([freq, freq]);
                }
            }
        }

        // If too many bands → selection is too broad, restore normal audio
        if (bands.length > MAX_ISO_BANDS || bands.length === 0) {
            teardownHoverFilters();
            return;
        }

        for (const [lo, hi] of bands) {
            const center = Math.sqrt(lo * hi) || lo;
            if (center >= nyquist * 0.95 || center < 10) continue;
            let prev = sourceNode;
            for (let c = 0; c < CASCADE; c++) {
                const bp = audioCtx.createBiquadFilter();
                bp.type = 'bandpass';
                bp.frequency.value = center;
                bp.Q.value = 30;
                prev.connect(bp);
                hoverFilterNodes.push(bp);
                prev = bp;
            }
            prev.connect(hoverGainNode);
        }
    }

    let _prevHoverBinKey = '';  // for change detection

    /** Update hover filter frequencies to match the latest detected bins.
     *  Called each frame from renderFrame(). Only rebuilds when bins actually change. */
    function updateHoverFilterFreqs() {
        if (!hoverGainNode) return;
        if (!lastHoverBins || lastHoverBins.size === 0) {
            if (_prevHoverBinKey !== '') {
                _prevHoverBinKey = '';
                applyHoverFilters();
            }
            return;
        }
        // Build a cheap key from the bin set to detect changes
        const arr = Array.from(lastHoverBins);
        arr.sort((a, b) => a - b);
        // Sample up to 10 bins for the key (avoid huge string every frame)
        const step = Math.max(1, (arr.length / 10) | 0);
        let key = '';
        for (let i = 0; i < arr.length; i += step) key += arr[i] + ',';
        key += arr.length;
        if (key !== _prevHoverBinKey) {
            _prevHoverBinKey = key;
            applyHoverFilters();
        }
    }

    /** Called whenever hover/selection changes. */
    function onIsolationChanged() {
        if (!getIsolationRange()) return;     // isolation disabled — nothing to do
        _prevHoverBinKey = '';  // force filter rebuild on next frame
        drawTimeline();
        if (isPlaying) {
            applyHoverFilters();
        }
        if (!isPlaying && freqData) {
            prevRenderedDb = null;
            renderFrame();
        }
    }

    // ═════════════════  INIT  ═════════════════════════════════════════

    function init() {
        sizeCanvas();
        buildAxisLabels();
        buildBinLookup();
        window.addEventListener("resize", () => {
            sizeCanvas();
            buildAxisLabels();
            drawTimeline();
        });

        // ── Prevent reload / re-init on tab switch ───────────────────
        //  When the tab is backgrounded, RAF stops and AudioContext may
        //  be suspended.  On return, we resume cleanly without a full
        //  page reload or state reset.
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                // Tab hidden — cancel RAF to avoid stale frame
                if (animId) { cancelAnimationFrame(animId); animId = null; }
            } else {
                // Tab visible again — resume AudioContext if needed
                if (audioCtx && audioCtx.state === 'suspended') {
                    audioCtx.resume();
                }
                // Restart animation loop if playing or mic is active
                if ((isPlaying || micActive) && !animId) tick();
                // Redraw spectrogram to current position
                drawTimeline();
                if (audioBuffer) {
                    const cur = getPlaybackTime();
                    updatePlayhead(cur);
                    updateTimeDisplay(cur);
                }
            }
        });

        // ── File input ────────────────────────────────────────────────
        fileInput.addEventListener("change", (e) => {
            if (e.target.files.length) loadFile(e.target.files[0]);
        });

        // ── Drag-and-drop ─────────────────────────────────────────────
        canvasWrap.addEventListener("dragover", (e) => { e.preventDefault(); dropOverlay.classList.add("active"); });
        canvasWrap.addEventListener("dragleave", () => { dropOverlay.classList.remove("active"); });
        canvasWrap.addEventListener("drop", (e) => {
            e.preventDefault();
            dropOverlay.classList.remove("active");
            const file = e.dataTransfer.files[0];
            if (file && file.type.startsWith("audio/")) loadFile(file);
        });

        // ── Playback controls ─────────────────────────────────────────
        btnPlay.addEventListener("click", togglePlay);

        // Keyboard shortcut: space = play/pause
        document.addEventListener("keydown", (e) => {
            if (e.code === "Space" && audioBuffer) { e.preventDefault(); togglePlay(); }
        });

        // ── Mode toggle buttons (independent toggles) ─────────────────
        // (removed — only harmonic view with swap is available now)

        // ── Swap XY button ──────────────────────────────────────────────
        if (btnSwap) btnSwap.addEventListener("click", () => {
            harmSwapped = !harmSwapped;
            btnSwap.classList.toggle("active", harmSwapped);
            buildAxisLabels();
            prevRenderedDb = null;
            renderOneFrame();
        });

        // ── EQ View toggle ──────────────────────────────────────────────
        if (btnEqView) btnEqView.addEventListener("click", () => {
            if (viewMode === 'eq') {
                viewMode = 'harmonic';
                btnEqView.classList.remove('active');
            } else {
                viewMode = 'eq';
                btnEqView.classList.add('active');
            }
            buildAxisLabels();
            prevRenderedDb = null;
            renderOneFrame();
        });

        // ── A-Weight toggle ─────────────────────────────────────────────
        if (btnAWeight) btnAWeight.addEventListener("click", () => {
            aWeightEnabled = !aWeightEnabled;
            btnAWeight.classList.toggle("active", aWeightEnabled);
            prevRenderedDb = null;
            renderOneFrame();
        });

        // ── Microphone toggle ───────────────────────────────────────────
        if (btnMic) btnMic.addEventListener("click", toggleMic);

        // ── Note-colour spectrogram button ──────────────────────────────
        if (btnNoteSpec) btnNoteSpec.addEventListener("click", () => {
            noteColourSpec = !noteColourSpec;
            btnNoteSpec.classList.toggle("active", noteColourSpec);
            drawTimeline();
        });

        // ── Cutoff slider ───────────────────────────────────────────────
        if (cutoffSlider) {
            cutoffSlider.addEventListener("input", () => {
                harmCutoffPct = parseInt(cutoffSlider.value, 10);
                if (cutoffLabel) cutoffLabel.textContent = harmCutoffPct + '%';
                renderOneFrame();
            });
        }

        // ── Timeline reset zoom button ──────────────────────────────────
        if (tlResetBtn) tlResetBtn.addEventListener("click", () => {
            tlZoomX = 1; tlPanX = 0; tlZoomY = 1; tlPanY = 0;
            drawTimeline();
            if (audioBuffer) {
                updatePlayhead(getPlaybackTime());
            }
        });

        // ── Resize handle drag (vertical resizing of auragram) ────────
        {
            let dragStartY = 0, dragStartH = 0;
            const onMove = (e) => {
                const clientY = e.touches ? e.touches[0].clientY : e.clientY;
                const delta = clientY - dragStartY;
                aurogramHeight = Math.max(80, Math.min(window.innerHeight - 120, dragStartH + delta));
                sizeCanvas();
                drawTimeline();
            };
            const onUp = () => {
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
                document.removeEventListener("touchmove", onMove);
                document.removeEventListener("touchend", onUp);
                document.body.style.cursor = "";
            };
            resizeHandle.addEventListener("mousedown", (e) => {
                e.preventDefault();
                dragStartY = e.clientY;
                dragStartH = canvas.getBoundingClientRect().height;
                document.body.style.cursor = "ns-resize";
                document.addEventListener("mousemove", onMove);
                document.addEventListener("mouseup", onUp);
            });
            resizeHandle.addEventListener("touchstart", (e) => {
                dragStartY = e.touches[0].clientY;
                dragStartH = canvas.getBoundingClientRect().height;
                document.addEventListener("touchmove", onMove, { passive: false });
                document.addEventListener("touchend", onUp);
            });
        }

        // ── Playhead drag (now vertical — drag on the spectrogram Y axis) ──
        //  The DOM playhead handle is hidden; dragging is handled via
        //  the timeline mousedown/mouseup (click-to-seek) path below.

        // ── Timeline: drag-to-select & seek ──────────────────────────────
        //  Rotated layout: X = frequency, Y = time.
        //  Click = seek (Y position), horizontal drag = freq selection.
        if (timelineCanvas) {
            const tlStrip = timelineCanvas.parentElement;

            // Selection band overlay — now vertical (spans full height,
            // horizontal extent from frequency drag)
            let tlSelBox = document.createElement('div');
            tlSelBox.id = 'tl-sel-box';
            tlSelBox.style.cssText = 'position:absolute;border-left:1px solid #fa4;border-right:1px solid #fa4;background:rgba(255,170,68,.12);pointer-events:none;display:none;z-index:3;top:0;bottom:0;';
            tlStrip.appendChild(tlSelBox);

            let dragStartX = 0, dragStartY = 0;  // pixel coords within strip
            let dragging = false;
            const MIN_DRAG_PX = 5;

            function tlMousePos(e) {
                const r = tlStrip.getBoundingClientRect();
                return {
                    x: Math.max(0, Math.min(r.width, e.clientX - r.left)),
                    y: Math.max(0, Math.min(r.height, e.clientY - r.top))
                };
            }

            /** Convert a pixel X offset on the rotated spectrogram to a MIDI note number. */
            function tlXtoMidi(px) {
                if (!preAnalysis) return 0;
                const rect = tlStrip.getBoundingClientRect();
                const W = rect.width;
                const TB = preAnalysis.TIMELINE_BINS;
                const xFrac = px / W;   // left=low, right=high
                const visYStart = tlPanY * TB;
                const visYRange = TB / tlZoomY;
                const bin = Math.max(0, Math.min(TB - 1, Math.round(visYStart + xFrac * visYRange)));
                const freq = preAnalysis.tlBinFreqs[bin];
                return Math.round(12 * Math.log2(freq / BASE_FREQ));
            }

            timelineCanvas.addEventListener('mousedown', (e) => {
                if (!audioBuffer) return;
                e.preventDefault();
                const p = tlMousePos(e);
                dragStartX = p.x;
                dragStartY = p.y;
                dragging = true;
                tlSelBox.style.display = 'none';
            });

            window.addEventListener('mousemove', (e) => {
                if (!dragging) return;
                const p = tlMousePos(e);
                const dx = Math.abs(p.x - dragStartX);
                if (dx > MIN_DRAG_PX) {
                    const x0 = Math.min(dragStartX, p.x);
                    const w = dx;
                    tlSelBox.style.left = x0 + 'px';
                    tlSelBox.style.width = w + 'px';
                    tlSelBox.style.display = 'block';
                }
            });

            window.addEventListener('mouseup', (e) => {
                if (!dragging) return;
                dragging = false;
                tlSelBox.style.display = 'none';
                if (!audioBuffer) return;

                const p = tlMousePos(e);
                const rect = tlStrip.getBoundingClientRect();
                const W = rect.width, H = rect.height;
                if (W < 1 || H < 1) return;

                const dx = Math.abs(p.x - dragStartX);
                const dy = Math.abs(p.y - dragStartY);

                if (dx < MIN_DRAG_PX && dy < MIN_DRAG_PX) {
                    // Small click → seek to that time position (Y axis) + clear selection
                    selNoteLo = null; selNoteHi = null;
                    selRowLo = null; selRowHi = null;
                    const auraSel = document.getElementById('aura-sel-box');
                    if (auraSel) auraSel.style.display = 'none';
                    const yFrac = Math.max(0, Math.min(1, p.y / H));
                    const timeFrac = tlPanX + yFrac / tlZoomX;
                    pausedAt = Math.max(0, Math.min(audioBuffer.duration, timeFrac * audioBuffer.duration));
                    updateTimeDisplay(pausedAt);
                    updatePlayhead(pausedAt);
                    if (!scrubPending) {
                        scrubPending = true;
                        scrubRender().then(() => { scrubPending = false; });
                    }
                    commitSeek();
                    onIsolationChanged();
                    drawTimeline();
                    return;
                }

                // Horizontal drag → frequency range selection for isolation
                const midiA = tlXtoMidi(dragStartX);
                const midiB = tlXtoMidi(p.x);
                selNoteLo = Math.min(midiA, midiB);
                selNoteHi = Math.max(midiA, midiB);
                selRowLo = null; selRowHi = null;
                const auraSel2 = document.getElementById('aura-sel-box');
                if (auraSel2) auraSel2.style.display = 'none';

                // Show the persistent selection band overlay (vertical)
                const x0 = Math.min(dragStartX, p.x);
                const w = Math.abs(p.x - dragStartX);
                tlSelBox.style.left = x0 + 'px';
                tlSelBox.style.width = w + 'px';
                tlSelBox.style.display = 'block';

                onIsolationChanged();
            });

            // Double-click → reset zoom AND clear selection
            timelineCanvas.addEventListener('dblclick', () => {
                tlZoomX = 1; tlPanX = 0; tlZoomY = 1; tlPanY = 0;
                selNoteLo = null; selNoteHi = null;
                selRowLo = null; selRowHi = null;
                tlSelBox.style.display = 'none';
                const auraSel3 = document.getElementById('aura-sel-box');
                if (auraSel3) auraSel3.style.display = 'none';
                onIsolationChanged();
                if (audioBuffer) {
                    updatePlayhead(getPlaybackTime());
                }
            });

            // ── Timeline: scroll = scrub, shift+scroll = zoom ─────────
            //  Rotated: Y = time, X = frequency
            timelineCanvas.addEventListener('wheel', (e) => {
                e.preventDefault();
                const rect = timelineCanvas.getBoundingClientRect();
                const mx = (e.clientX - rect.left) / rect.width;   // 0..1 cursor X
                const my = (e.clientY - rect.top) / rect.height;    // 0..1 cursor Y

                if (e.ctrlKey || e.metaKey) {
                    // Ctrl+scroll = X zoom (frequency axis)
                    const factor = e.deltaY > 0 ? 0.85 : 1.18;
                    const newZY = Math.max(1, Math.min(32, tlZoomY * factor));
                    const freqFrac = tlPanY + mx / tlZoomY;
                    tlZoomY = newZY;
                    tlPanY = Math.max(0, Math.min(1 - 1 / tlZoomY, freqFrac - mx / tlZoomY));
                } else if (e.shiftKey) {
                    // Shift+scroll = zoom (time axis) centred on playhead
                    const factor = e.deltaY > 0 ? 0.85 : 1.18;
                    const newZX = Math.max(1, Math.min(200, tlZoomX * factor));
                    const current = getPlaybackTime();
                    const playFrac = audioBuffer ? (current / audioBuffer.duration) : 0.5;
                    tlZoomX = newZX;
                    const anchor = newZX > 1 ? 1 / 3 : 0.5;
                    tlPanX = Math.max(0, Math.min(1 - 1 / tlZoomX, playFrac - anchor / tlZoomX));
                } else {
                    // Normal scroll = scrub (move playback position in time)
                    if (audioBuffer) {
                        const scrubStep = (audioBuffer.duration / tlZoomX) * 0.03;
                        const delta = e.deltaY > 0 ? scrubStep : -scrubStep;
                        const cur = getPlaybackTime();
                        pausedAt = Math.max(0, Math.min(audioBuffer.duration, cur + delta));
                        if (isPlaying) {
                            startedAt = audioCtx.currentTime - pausedAt
                                - ((audioCtx.baseLatency || 0) + (audioCtx.outputLatency || 0));
                        }
                        updateTimeDisplay(pausedAt);
                        updatePlayhead(pausedAt);
                        if (!isPlaying && !scrubPending) {
                            scrubPending = true;
                            scrubRender().then(() => { scrubPending = false; });
                        }
                    }
                }
                drawTimeline();
                if (audioBuffer) {
                    const current = getPlaybackTime();
                    updatePlayhead(current);
                }
            }, { passive: false });

            // ── Timeline hover: detect hovered note for isolation ────────
            //  Rotated: frequency is on the X axis, so we use cursor X.
            timelineCanvas.addEventListener('mousemove', (e) => {
                if (!preAnalysis) return;
                const rect = timelineCanvas.getBoundingClientRect();
                const mx = (e.clientX - rect.left) / rect.width;
                const TB = preAnalysis.TIMELINE_BINS;
                const xFrac = mx;   // left=low, right=high
                const visYStart = tlPanY * TB;
                const visYRange = TB / tlZoomY;
                const bin = Math.max(0, Math.min(TB - 1, Math.round(visYStart + xFrac * visYRange)));
                const freq = preAnalysis.tlBinFreqs[bin];
                const midiNote = Math.round(12 * Math.log2(freq / BASE_FREQ));
                if (hoverFundNote !== midiNote) {
                    hoverFundNote = midiNote;
                    onIsolationChanged();
                }
            });

            timelineCanvas.addEventListener('mouseleave', () => {
                if (hoverFundNote !== null) {
                    hoverFundNote = null;
                    onIsolationChanged();
                }
            });
        }

        // ── Auragram: 2D drag-to-select + hover ─────────────────────────
        {
            let auraSelBox = document.createElement('div');
            auraSelBox.id = 'aura-sel-box';
            auraSelBox.style.cssText = 'position:absolute;border:1px solid #fa4;background:rgba(255,170,68,.12);pointer-events:none;display:none;z-index:3;';
            canvasInner.appendChild(auraSelBox);

            let auraDragStartX = 0, auraDragStartY = 0;
            let auraDragging = false;
            const AURA_MIN_DRAG = 5;

            function auraMousePos(e) {
                const r = canvas.getBoundingClientRect();
                return {
                    x: Math.max(0, Math.min(r.width, e.clientX - r.left)),
                    y: Math.max(0, Math.min(r.height, e.clientY - r.top)),
                    w: r.width, h: r.height
                };
            }

            /** Convert auragram pixel coords to {midiNote, row}. */
            function auraPxToNoteRow(px, py, W, H) {
                const visOctStart = AURA_LOW_OCTAVE + auraPanX * AURA_OCTAVE_SPAN;
                const visOctRange = AURA_OCTAVE_SPAN / auraZoomX;
                let oct, rowFrac;
                if (!harmSwapped) {
                    oct = visOctStart + (px / W) * visOctRange;
                    rowFrac = 1 - (py / H);  // bottom=0, top=1
                } else {
                    oct = visOctStart + (1 - py / H) * visOctRange;
                    rowFrac = px / W;  // left=0, right=1
                }
                const midiNote = Math.round(oct * 12);
                const row = Math.max(1, Math.min(NUM_HARMONIC_ROWS, Math.ceil(rowFrac * NUM_HARMONIC_ROWS)));
                return { midiNote, row };
            }

            canvas.addEventListener('mousedown', (e) => {
                if (viewMode !== 'harmonic') return;
                e.preventDefault();
                const p = auraMousePos(e);
                auraDragStartX = p.x;
                auraDragStartY = p.y;
                auraDragging = true;
                auraSelBox.style.display = 'none';
            });

            window.addEventListener('mousemove', (e) => {
                if (auraDragging) {
                    const p = auraMousePos(e);
                    const dx = Math.abs(p.x - auraDragStartX);
                    const dy = Math.abs(p.y - auraDragStartY);
                    if (dx > AURA_MIN_DRAG || dy > AURA_MIN_DRAG) {
                        const x0 = Math.min(auraDragStartX, p.x);
                        const y0 = Math.min(auraDragStartY, p.y);
                        auraSelBox.style.left = x0 + 'px';
                        auraSelBox.style.top = y0 + 'px';
                        auraSelBox.style.width = Math.abs(p.x - auraDragStartX) + 'px';
                        auraSelBox.style.height = Math.abs(p.y - auraDragStartY) + 'px';
                        auraSelBox.style.display = 'block';
                    }
                    return;
                }
                // Normal hover (no drag)
                if (viewMode !== 'harmonic') return;
                const rect = canvas.getBoundingClientRect();
                if (e.clientX < rect.left || e.clientX > rect.right ||
                    e.clientY < rect.top || e.clientY > rect.bottom) return;
                const visOctStart = AURA_LOW_OCTAVE + auraPanX * AURA_OCTAVE_SPAN;
                const visOctRange = AURA_OCTAVE_SPAN / auraZoomX;
                let oct;
                if (!harmSwapped) {
                    const xFrac = (e.clientX - rect.left) / rect.width;
                    oct = visOctStart + xFrac * visOctRange;
                } else {
                    const yFrac = 1 - (e.clientY - rect.top) / rect.height;
                    oct = visOctStart + yFrac * visOctRange;
                }
                const midiNote = Math.round(oct * 12);
                if (hoverFundNote !== midiNote) {
                    hoverFundNote = midiNote;
                    onIsolationChanged();
                }
            });

            window.addEventListener('mouseup', (e) => {
                if (!auraDragging) return;
                auraDragging = false;
                const p = auraMousePos(e);
                const dx = Math.abs(p.x - auraDragStartX);
                const dy = Math.abs(p.y - auraDragStartY);

                if (dx < AURA_MIN_DRAG && dy < AURA_MIN_DRAG) {
                    // Small click → clear selection
                    selNoteLo = null; selNoteHi = null;
                    selRowLo = null; selRowHi = null;
                    auraSelBox.style.display = 'none';
                    const tlSel0 = document.getElementById('tl-sel-box');
                    if (tlSel0) tlSel0.style.display = 'none';
                    onIsolationChanged();
                    return;
                }

                // 2D drag → select note range + harmonic row range
                const a = auraPxToNoteRow(auraDragStartX, auraDragStartY, p.w, p.h);
                const b = auraPxToNoteRow(p.x, p.y, p.w, p.h);
                selNoteLo = Math.min(a.midiNote, b.midiNote);
                selNoteHi = Math.max(a.midiNote, b.midiNote);
                selRowLo = Math.min(a.row, b.row);
                selRowHi = Math.max(a.row, b.row);
                // Clear spectrogram selection overlay since auragram drag overrides
                const tlSel1 = document.getElementById('tl-sel-box');
                if (tlSel1) tlSel1.style.display = 'none';

                // Show persistent selection box
                const x0 = Math.min(auraDragStartX, p.x);
                const y0 = Math.min(auraDragStartY, p.y);
                auraSelBox.style.left = x0 + 'px';
                auraSelBox.style.top = y0 + 'px';
                auraSelBox.style.width = (Math.abs(p.x - auraDragStartX)) + 'px';
                auraSelBox.style.height = (Math.abs(p.y - auraDragStartY)) + 'px';
                auraSelBox.style.display = 'block';

                onIsolationChanged();
            });

            canvas.addEventListener('mouseleave', () => {
                if (!auraDragging && hoverFundNote !== null) {
                    hoverFundNote = null;
                    onIsolationChanged();
                }
            });

            // Double-click on auragram → clear selection
            canvas.addEventListener('dblclick', () => {
                selNoteLo = null; selNoteHi = null;
                selRowLo = null; selRowHi = null;
                auraSelBox.style.display = 'none';
                // Also hide spectrogram selection box
                const tlSel = document.getElementById('tl-sel-box');
                if (tlSel) tlSel.style.display = 'none';
                onIsolationChanged();
            });
        }

        // ── Auragram canvas: zoom & pan via scroll wheel ───────────────
        canvas.addEventListener('wheel', (e) => {
            if (viewMode !== 'harmonic' && viewMode !== 'eq') return;
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();

            // In swapped mode, cursor Y controls zoom/pan (pitch is on Y axis)
            const mFrac = harmSwapped
                ? 1 - (e.clientY - rect.top) / rect.height   // Y fraction (bottom=0)
                : (e.clientX - rect.left) / rect.width;       // X fraction

            if (e.shiftKey) {
                const panStep = 0.1 / auraZoomX;
                auraPanX = Math.max(0, Math.min(1 - 1 / auraZoomX, auraPanX + (e.deltaY > 0 ? panStep : -panStep)));
            } else {
                const factor = e.deltaY > 0 ? 0.85 : 1.18;
                const newZ = Math.max(1, Math.min(64, auraZoomX * factor));
                const cursor = auraPanX + mFrac / auraZoomX;
                auraZoomX = newZ;
                auraPanX = Math.max(0, Math.min(1 - 1 / auraZoomX, cursor - mFrac / auraZoomX));
            }
            buildAxisLabels();
            if (!isPlaying && freqData) {
                prevRenderedDb = null;
                renderFrame();
            }
        }, { passive: false });

        // ── Auto-load bundled file ─────────────────────────────────────
        if (AUTO_LOAD_FILE) autoLoadFile(AUTO_LOAD_FILE);
    }

    // ═════════════════  SIZING  ═══════════════════════════════════════

    function sizeCanvas() {
        // Stretch the auragram wide — height uses stored value or ~35% of viewport
        const wrapRect = canvasInner.getBoundingClientRect();
        const w = Math.max(200, Math.floor(wrapRect.width));
        const h = aurogramHeight !== null
            ? Math.max(80, Math.min(window.innerHeight - 120, aurogramHeight))
            : Math.max(120, Math.floor(window.innerHeight * 0.30));
        canvas.width = RENDER_SIZE;            // off-screen resolution stays square
        canvas.height = RENDER_SIZE;
        canvas.style.width = w + "px";
        canvas.style.height = h + "px";
    }

    // ═════════════════  AXIS LABELS  ══════════════════════════════════

    function buildAxisLabels() {
        xLabels.innerHTML = "";
        yLabels.innerHTML = "";
        // Reset overrides that harmonic mode may have set
        xLabels.style.position = '';
        xLabels.style.display = '';
        xLabels.style.height = '';

        if (viewMode === 'harmonic' && !harmSwapped) {
            // X: note names for visible fundamental range (zoom/pan aware, clipped to C8)
            xLabels.style.position = 'relative';
            xLabels.style.display = 'block';
            xLabels.style.height = '24px';
            const visOctStart = AURA_LOW_OCTAVE + auraPanX * AURA_OCTAVE_SPAN;
            const visOctRange = AURA_OCTAVE_SPAN / auraZoomX;
            const loOct = Math.max(Math.ceil(AURA_LOW_OCTAVE), Math.floor(visOctStart));
            const hiOct = Math.min(AURA_HIGH_OCTAVE, Math.ceil(visOctStart + visOctRange));
            for (let o = loOct; o <= hiOct; o++) {
                for (let n = 0; n < 12; n++) {
                    const noteOct = o + n / 12;
                    const xFrac = (noteOct - visOctStart) / visOctRange;
                    if (xFrac < -0.01 || xFrac > 1.01) continue;
                    const span = document.createElement("span");
                    span.style.position = 'absolute';
                    span.style.left = (Math.max(0, Math.min(1, xFrac)) * 100) + '%';
                    span.style.transform = 'translateX(-50%)';
                    if (n === 0) {
                        span.textContent = 'C' + o;
                        span.style.color = '#999';
                        span.style.fontSize = '8px';
                        span.style.fontWeight = '600';
                        span.style.top = '10px';
                    } else {
                        span.textContent = NOTE_NAMES[n];
                        span.style.color = '#555';
                        span.style.fontSize = '6px';
                    }
                    xLabels.appendChild(span);
                }
            }
            // Y: equally-spaced harmonic row labels 1×, 2×, …
            for (let h = 1; h <= NUM_HARMONIC_ROWS; h++) {
                const yFrac = (h - 0.5) / NUM_HARMONIC_ROWS;
                const span = document.createElement("span");
                span.textContent = h + "×";
                span.style.position = "absolute";
                span.style.bottom = (yFrac * 100) + "%";
                span.style.transform = "translateY(50%)";
                span.style.fontSize = '8px';
                span.style.color = h === 1 ? '#ccc' : '#777';
                yLabels.appendChild(span);
            }
        } else if (viewMode === 'harmonic' && harmSwapped) {
            // X: equally-spaced harmonic column labels 1×, 2×, …
            xLabels.style.position = 'relative';
            xLabels.style.display = 'block';
            xLabels.style.height = '24px';
            for (let h = 1; h <= NUM_HARMONIC_ROWS; h++) {
                const xFrac = (h - 0.5) / NUM_HARMONIC_ROWS;
                const span = document.createElement("span");
                span.textContent = h + "×";
                span.style.position = 'absolute';
                span.style.left = (xFrac * 100) + '%';
                span.style.transform = 'translateX(-50%)';
                span.style.fontSize = '8px';
                span.style.color = h === 1 ? '#ccc' : '#777';
                xLabels.appendChild(span);
            }
            // Y: note names for visible fundamental range (zoom/pan aware)
            const visOctStart = AURA_LOW_OCTAVE + auraPanX * AURA_OCTAVE_SPAN;
            const visOctRange = AURA_OCTAVE_SPAN / auraZoomX;
            const loOct = Math.max(Math.ceil(AURA_LOW_OCTAVE), Math.floor(visOctStart));
            const hiOct = Math.min(AURA_HIGH_OCTAVE, Math.ceil(visOctStart + visOctRange));
            for (let o = loOct; o <= hiOct; o++) {
                for (let n = 0; n < 12; n++) {
                    const noteOct = o + n / 12;
                    const yFrac = (noteOct - visOctStart) / visOctRange;
                    if (yFrac < -0.01 || yFrac > 1.01) continue;
                    const span = document.createElement("span");
                    span.style.position = 'absolute';
                    span.style.bottom = (Math.max(0, Math.min(1, yFrac)) * 100) + '%';
                    span.style.transform = 'translateY(50%)';
                    if (n === 0) {
                        span.textContent = 'C' + o;
                        span.style.color = '#999';
                        span.style.fontSize = '8px';
                        span.style.fontWeight = '600';
                    } else {
                        span.textContent = NOTE_NAMES[n];
                        span.style.color = '#555';
                        span.style.fontSize = '6px';
                    }
                    yLabels.appendChild(span);
                }
            }
        } else if (viewMode === 'eq') {
            // X: note names for visible frequency range (same as harmonic non-swapped)
            xLabels.style.position = 'relative';
            xLabels.style.display = 'block';
            xLabels.style.height = '24px';
            const visOctStart = AURA_LOW_OCTAVE + auraPanX * AURA_OCTAVE_SPAN;
            const visOctRange = AURA_OCTAVE_SPAN / auraZoomX;
            const loOct = Math.max(Math.ceil(AURA_LOW_OCTAVE), Math.floor(visOctStart));
            const hiOct = Math.min(AURA_HIGH_OCTAVE, Math.ceil(visOctStart + visOctRange));
            for (let o = loOct; o <= hiOct; o++) {
                for (let n = 0; n < 12; n++) {
                    const noteOct = o + n / 12;
                    const xFrac = (noteOct - visOctStart) / visOctRange;
                    if (xFrac < -0.01 || xFrac > 1.01) continue;
                    const span = document.createElement("span");
                    span.style.position = 'absolute';
                    span.style.left = (Math.max(0, Math.min(1, xFrac)) * 100) + '%';
                    span.style.transform = 'translateX(-50%)';
                    if (n === 0) {
                        span.textContent = 'C' + o;
                        span.style.color = '#999';
                        span.style.fontSize = '8px';
                        span.style.fontWeight = '600';
                        span.style.top = '10px';
                    } else {
                        span.textContent = NOTE_NAMES[n];
                        span.style.color = '#555';
                        span.style.fontSize = '6px';
                    }
                    xLabels.appendChild(span);
                }
            }
            // Y: dB scale labels
            const eqDbMin = MIN_DB, eqDbMax = MAX_DB, eqDbRange = eqDbMax - eqDbMin;
            for (let dB = Math.ceil(eqDbMin / 10) * 10; dB <= eqDbMax; dB += 10) {
                const yFrac = (dB - eqDbMin) / eqDbRange;
                const span = document.createElement("span");
                span.textContent = dB + ' dB';
                span.style.position = 'absolute';
                span.style.bottom = (yFrac * 100) + '%';
                span.style.transform = 'translateY(50%)';
                span.style.fontSize = '7px';
                span.style.color = '#777';
                yLabels.appendChild(span);
            }
        } else if (viewMode === 'swapped') {
            // X: octave labels (C1, C2, …)
            const loOct = Math.ceil(LOW_OCTAVE);
            const hiOct = Math.floor(HIGH_OCTAVE);
            for (let o = loOct; o <= hiOct; o++) {
                const span = document.createElement("span");
                span.textContent = "C" + o;
                xLabels.appendChild(span);
            }
            // Y: note names (C, C♯, D, … positioned evenly)
            for (let i = 0; i < 12; i++) {
                const yFrac = i / 12;
                const span = document.createElement("span");
                span.textContent = NOTE_NAMES[i];
                span.style.position = "absolute";
                span.style.bottom = (yFrac * 100) + "%";
                span.style.transform = "translateY(50%)";
                yLabels.appendChild(span);
            }
        } else {
            // Standard sheared: X = note names, Y = octave labels
            for (let i = 0; i < 12; i++) {
                const span = document.createElement("span");
                span.textContent = NOTE_NAMES[i];
                xLabels.appendChild(span);
            }
            const loOct = Math.ceil(LOW_OCTAVE);
            const hiOct = Math.floor(HIGH_OCTAVE);
            for (let o = loOct; o <= hiOct; o++) {
                const span = document.createElement("span");
                span.textContent = "C" + o;
                const yFrac = (o - LOW_OCTAVE) / (OCTAVE_SPAN * (1 + SHEAR_EXT));
                if (yFrac < 0 || yFrac > 1) continue;
                span.style.position = "absolute";
                span.style.bottom = (yFrac * 100) + "%";
                span.style.transform = "translateY(50%)";
                yLabels.appendChild(span);
            }
        }
    }

    // ═════════════════  BIN LOOKUP TABLE  ═════════════════════════════

    /** Get the frequency for a pixel position based on current viewMode. */
    function pixelToFreq(px, py) {
        if (viewMode === 'harmonic') {
            // X = fundamental pitch with zoom/pan, clipped to C8
            const visOctStart = AURA_LOW_OCTAVE + auraPanX * AURA_OCTAVE_SPAN;
            const visOctRange = AURA_OCTAVE_SPAN / auraZoomX;
            const xOct = visOctStart + (px / (RENDER_SIZE - 1)) * visOctRange;
            const fundFreq = BASE_FREQ * Math.pow(2, xOct);
            const yFrac = 1 - py / (RENDER_SIZE - 1);
            const row = Math.min(NUM_HARMONIC_ROWS - 1, (yFrac * NUM_HARMONIC_ROWS) | 0);
            return fundFreq * (row + 1);
        }

        let xFrac, yN;
        if (viewMode === 'swapped') {
            // X = octave (left=low, right=high), Y = note within octave (bottom=C, top=B)
            xFrac = 1 - py / (RENDER_SIZE - 1);                 // note position
            yN = (px / (RENDER_SIZE - 1)) * (1 + SHEAR_EXT); // octave position (extended)
        } else {
            // X = note within octave, Y = octave (bottom=low, top=high)
            xFrac = px / (RENDER_SIZE - 1);
            yN = (1 - py / (RENDER_SIZE - 1)) * (1 + SHEAR_EXT);
        }

        const shearedY = yN - xFrac / OCTAVE_SPAN;
        const octave = LOW_OCTAVE + shearedY * OCTAVE_SPAN;
        const octaveI = Math.floor(octave);
        return BASE_FREQ * Math.pow(2, octaveI + xFrac);
    }

    function buildBinLookup() {
        binLookup = new Float64Array(RENDER_SIZE * RENDER_SIZE);
        for (let py = 0; py < RENDER_SIZE; py++) {
            for (let px = 0; px < RENDER_SIZE; px++) {
                binLookup[py * RENDER_SIZE + px] = pixelToFreq(px, py);
            }
        }
    }

    // ═════════════════  FILE LOADING  ═════════════════════════════════

    async function loadFile(file) {
        stop();

        // Stop mic if active
        if (micActive) await toggleMic();

        // Reset session tracking for new file
        allSessions = [];
        sessionIdCounter = 0;
        frameCounter = 0;
        isolatedSrcId = null;
        hoveredSrcId = null;
        preAnalysis = null;
        tlZoomX = 1; tlPanX = 0;
        tlZoomY = 1; tlPanY = 0;
        auraZoomX = 1; auraPanX = 0;

        fileName.textContent = file.name;
        idlePrompt.style.display = "none";

        ensureAudioContext();

        if (audioCtx.state === "suspended") await audioCtx.resume();

        const arrayBuf = await file.arrayBuffer();
        audioBuffer = await audioCtx.decodeAudioData(arrayBuf);

        pausedAt = 0;
        btnPlay.disabled = false;
        updateTimeDisplay(0);

        // Start pre-analysis in the background, play immediately
        runPreAnalysis();
        play();
    }

    function ensureAudioContext() {
        if (audioCtx) return;
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = FFT_SIZE;
        analyser.smoothingTimeConstant = SMOOTHING;
        gainNode = audioCtx.createGain();
        gainNode.connect(audioCtx.destination);
        analyser.connect(gainNode);
        freqData = new Float32Array(analyser.frequencyBinCount);
        prevFreqData = new Float32Array(analyser.frequencyBinCount);
        spectralAvg = new Float32Array(analyser.frequencyBinCount);
        spectralAvg.fill(MIN_DB);
        // Pre-allocate reusable per-frame buffers
        const bc = analyser.frequencyBinCount;
        _binRow = new Int8Array(bc);
        _binFund = new Int32Array(bc);
        _binClaimCount = new Uint8Array(bc);
        _isSpecPeak = new Uint8Array(bc);
        _hpsBuffer = new Float64Array(bc);
        curFrameDb = new Float32Array(RENDER_SIZE * RENDER_SIZE);
        buildAWeightLUT(bc, audioCtx.sampleRate);
        rebuildBinLookupWithSampleRate(audioCtx.sampleRate);
    }

    /** Rebuild bin lookup with actual sampleRate so entries are FFT bin indices. */
    function rebuildBinLookupWithSampleRate(sampleRate) {
        const invBinWidth = FFT_SIZE / sampleRate;
        binLookup = new Float64Array(RENDER_SIZE * RENDER_SIZE);
        for (let py = 0; py < RENDER_SIZE; py++) {
            for (let px = 0; px < RENDER_SIZE; px++) {
                binLookup[py * RENDER_SIZE + px] = pixelToFreq(px, py) * invBinWidth;
            }
        }
    }

    // ═════════════════  AUTO-LOAD  ═════════════════════════════════════

    async function autoLoadFile(url) {
        try {
            idlePrompt.style.display = "none";
            fileName.textContent = decodeURIComponent(url.split("/").pop());

            ensureAudioContext();

            const resp = await fetch(url);
            if (!resp.ok) throw new Error(resp.statusText);
            const arrayBuf = await resp.arrayBuffer();
            audioBuffer = await audioCtx.decodeAudioData(arrayBuf);

            pausedAt = 0;
            btnPlay.disabled = false;
            updateTimeDisplay(0);

            runPreAnalysis();
            btnPlay.textContent = "Play";
        } catch (err) {
            console.error("Auto-load failed:", err);
            idlePrompt.style.display = "flex";
        }
    }

    // ═════════════════  PRE-ANALYSIS (SPECTROGRAM ONLY)  ═══════════════
    //  Single-pass direct-FFT scan: collect log-spaced spectrogram
    //  for the timeline display.  No source analysis.
    //  Uses a pure-JS radix-2 FFT on the raw PCM data — avoids creating
    //  thousands of OfflineAudioContexts (which is slow and unreliable).

    async function runPreAnalysis() {
        if (!audioBuffer) return;

        const sr = audioBuffer.sampleRate;
        const duration = audioBuffer.duration;
        const hop = PRE_ANALYSIS_HOP;
        const nFrames = Math.ceil(duration / hop);
        const fftLen = FFT_SIZE;
        const binCount = fftLen / 2;
        const binWidth = sr / fftLen;

        // Show progress bar
        analysisBar.classList.remove('hidden');
        analysisFill.style.width = '0%';
        analysisLabel.textContent = 'Collecting spectra\u2026';

        // ── Downsampled spectrogram bins (log-spaced) ──────────────────
        const TIMELINE_BINS = 512;
        const tlBinFreqs = new Float64Array(TIMELINE_BINS);
        const tlBinFFTIdx = new Int32Array(TIMELINE_BINS);
        for (let b = 0; b < TIMELINE_BINS; b++) {
            const t = b / (TIMELINE_BINS - 1);
            const freq = LOW_FREQ * Math.pow(HIGH_FREQ / LOW_FREQ, t);
            tlBinFreqs[b] = freq;
            tlBinFFTIdx[b] = Math.round(freq / binWidth);
        }

        // Storage
        const frameTimes = new Float64Array(nFrames);
        const spectrogram = new Float32Array(nFrames * TIMELINE_BINS);
        spectrogram.fill(MIN_DB);  // initialise to silence so unanalysed frames render dark

        // ── Publish preAnalysis immediately so playback can start ───────
        preAnalysis = {
            nFrames: nFrames,
            analysedFrames: 0,           // how many frames have been computed so far
            frameTimes: frameTimes,
            duration: duration,
            spectrogram: spectrogram,
            TIMELINE_BINS: TIMELINE_BINS,
            tlBinFreqs: tlBinFreqs,
        };
        drawTimeline();                  // show empty spectrogram right away

        // ── Extract mono audio data ────────────────────────────────────
        const nCh = audioBuffer.numberOfChannels;
        const totalSamples = audioBuffer.length;
        const mono = new Float32Array(totalSamples);
        for (let ch = 0; ch < nCh; ch++) {
            const chData = audioBuffer.getChannelData(ch);
            for (let i = 0; i < totalSamples; i++) mono[i] += chData[i];
        }
        if (nCh > 1) {
            const scale = 1 / nCh;
            for (let i = 0; i < totalSamples; i++) mono[i] *= scale;
        }

        // ── Pre-compute Blackman window (matches AnalyserNode default) ─
        const win = new Float32Array(fftLen);
        {
            const a0 = 0.42, a1 = 0.5, a2 = 0.08;
            for (let i = 0; i < fftLen; i++) {
                win[i] = a0 - a1 * Math.cos(2 * Math.PI * i / (fftLen - 1))
                    + a2 * Math.cos(4 * Math.PI * i / (fftLen - 1));
            }
        }

        // ── Pre-compute bit-reversal permutation table ─────────────────
        const bitRev = new Uint32Array(fftLen);
        for (let i = 0; i < fftLen; i++) {
            let j = 0;
            for (let bit = 1, rBit = fftLen >> 1; bit < fftLen; bit <<= 1, rBit >>= 1) {
                if (i & bit) j |= rBit;
            }
            bitRev[i] = j;
        }

        // ── Pre-compute twiddle factors (cos/sin per butterfly stage) ──
        const twiddleRe = [];
        const twiddleIm = [];
        for (let len = 2; len <= fftLen; len <<= 1) {
            const halfLen = len >> 1;
            const stRe = new Float64Array(halfLen);
            const stIm = new Float64Array(halfLen);
            for (let j = 0; j < halfLen; j++) {
                const angle = -2 * Math.PI * j / len;
                stRe[j] = Math.cos(angle);
                stIm[j] = Math.sin(angle);
            }
            twiddleRe.push(stRe);
            twiddleIm.push(stIm);
        }

        // ── Reusable FFT buffers ──────────────────────────────────────
        const re = new Float32Array(fftLen);
        const im = new Float32Array(fftLen);
        const nSq = fftLen * fftLen;

        // ── Timbral template collection buffers ───────────────────────
        const fullSpecDb = new Float32Array(binCount);  // full-spectrum dB per frame
        const envCollector = [];  // [{freq, envelope, frameIdx, energy}]
        if (!_hpsBuffer || _hpsBuffer.length < binCount) {
            _hpsBuffer = new Float64Array(binCount);
        }

        const CHUNK_SIZE = 32;    // frames per UI-yield chunk
        let lastRedraw = performance.now();

        for (let fi = 0; fi < nFrames; fi += CHUNK_SIZE) {
            const chunkEnd = Math.min(fi + CHUNK_SIZE, nFrames);

            for (let f = fi; f < chunkEnd; f++) {
                const t = f * hop;
                frameTimes[f] = t;

                // Centre the FFT window at time t
                const centreSample = Math.round(t * sr);
                const startSample = centreSample - (fftLen >> 1);

                // Fill buffer with windowed samples (bit-reversed order)
                for (let i = 0; i < fftLen; i++) {
                    const si = startSample + i;
                    const sample = (si >= 0 && si < totalSamples) ? mono[si] : 0;
                    const ri = bitRev[i];
                    re[ri] = sample * win[i];
                    im[ri] = 0;
                }

                // Radix-2 Cooley-Tukey FFT (in-place)
                let stageIdx = 0;
                for (let len = 2; len <= fftLen; len <<= 1) {
                    const halfLen = len >> 1;
                    const twRe = twiddleRe[stageIdx];
                    const twIm = twiddleIm[stageIdx];
                    for (let i = 0; i < fftLen; i += len) {
                        for (let j = 0; j < halfLen; j++) {
                            const a = i + j;
                            const b = a + halfLen;
                            const tRe = twRe[j] * re[b] - twIm[j] * im[b];
                            const tIm = twRe[j] * im[b] + twIm[j] * re[b];
                            re[b] = re[a] - tRe;
                            im[b] = im[a] - tIm;
                            re[a] += tRe;
                            im[a] += tIm;
                        }
                    }
                    stageIdx++;
                }

                // Store log-spaced spectrogram bins (dB, matching AnalyserNode scale)
                const specOff = f * TIMELINE_BINS;
                for (let b = 0; b < TIMELINE_BINS; b++) {
                    const fftBin = tlBinFFTIdx[b];
                    if (fftBin >= 0 && fftBin < binCount) {
                        const magSq = re[fftBin] * re[fftBin] + im[fftBin] * im[fftBin];
                        spectrogram[specOff + b] = magSq > 0
                            ? 10 * Math.log10(magSq / nSq)
                            : -200;
                    } else {
                        spectrogram[specOff + b] = MIN_DB;
                    }
                }

                // ── Timbral template collection ──────────────────────
                //  Convert full linear spectrum to dB, run HPS to find
                //  fundamentals, extract harmonic envelopes for each.
                for (let b = 0; b < binCount; b++) {
                    const magSq = re[b] * re[b] + im[b] * im[b];
                    fullSpecDb[b] = magSq > 0
                        ? 10 * Math.log10(magSq / nSq)
                        : -200;
                }
                const frameFunds = findFundamentalsHPS(
                    fullSpecDb, binCount, binWidth, 8
                );
                for (const fund of frameFunds) {
                    if (fund.score < MIN_DB + 30) continue;
                    const env = extractHarmonicEnvelope(
                        fullSpecDb, fund.freq, binWidth, binCount
                    );
                    // Count confirmed harmonics (above −30 dB relative)
                    let nConf = 0;
                    for (let h = 0; h < 16; h++) if (env[h] > -30) nConf++;
                    if (nConf < 3) continue;
                    envCollector.push({
                        freq: fund.freq,
                        envelope: env,
                        frameIdx: f,
                        energy: fund.score
                    });
                }
            }

            // Update analysed count so drawTimeline can show partial results
            preAnalysis.analysedFrames = chunkEnd;

            // Update progress bar and periodically redraw spectrogram
            const pct = Math.min(100, Math.round((chunkEnd / nFrames) * 100));
            analysisFill.style.width = pct + '%';
            analysisLabel.textContent = `Collecting spectra\u2026 ${pct}%`;

            const now = performance.now();
            if (now - lastRedraw > 200) {
                drawTimeline();
                lastRedraw = now;
            }

            await new Promise(r => setTimeout(r, 0));
        }

        preAnalysis.analysedFrames = nFrames;

        // ═══════════════════════════════════════════════════════════════
        //  TIMBRAL TEMPLATE CLUSTERING
        //  Group the collected harmonic envelopes into stable templates
        //  that represent distinct sound sources across the whole track.
        // ═══════════════════════════════════════════════════════════════
        const TMPL_SIM_THRESH = 0.80;   // cosine sim threshold for same template
        const TMPL_MAX_OCT = 1.5;    // max octave distance for same template
        const MIN_TMPL_OBS = Math.max(3, Math.round(nFrames * 0.008));

        // Sort by energy (strongest seeds first for greedy clustering)
        envCollector.sort((a, b) => b.energy - a.energy);

        // Greedy agglomerative clustering
        const cAssign = new Int32Array(envCollector.length).fill(-1);
        const rawTemplates = [];
        let tId = 0;

        for (let i = 0; i < envCollector.length; i++) {
            if (cAssign[i] >= 0) continue;
            cAssign[i] = tId;
            const members = [i];

            // Normalize seed envelope for similarity comparison
            const seedEnv = envCollector[i].envelope;
            let sMag = 0;
            for (let k = 0; k < 16; k++) sMag += seedEnv[k] * seedEnv[k];
            sMag = Math.sqrt(sMag);
            const seedNorm = new Float32Array(16);
            if (sMag > 0.001) for (let k = 0; k < 16; k++) seedNorm[k] = seedEnv[k] / sMag;

            for (let j = i + 1; j < envCollector.length; j++) {
                if (cAssign[j] >= 0) continue;
                // Frequency proximity check
                const octDist = Math.abs(
                    Math.log2(envCollector[j].freq / envCollector[i].freq)
                );
                if (octDist > TMPL_MAX_OCT) continue;
                // Envelope cosine similarity
                const sim = envelopeSimilarity(seedEnv, envCollector[j].envelope);
                if (sim >= TMPL_SIM_THRESH) {
                    cAssign[j] = tId;
                    members.push(j);
                }
            }

            if (members.length < MIN_TMPL_OBS) { tId++; continue; }

            // Compute mean envelope and frequency stats
            const meanEnv = new Float32Array(16);
            let fSum = 0, fLo = Infinity, fHi = 0;
            for (const mi of members) {
                for (let k = 0; k < 16; k++) meanEnv[k] += envCollector[mi].envelope[k];
                fSum += envCollector[mi].freq;
                fLo = Math.min(fLo, envCollector[mi].freq);
                fHi = Math.max(fHi, envCollector[mi].freq);
            }
            const nm = members.length;
            for (let k = 0; k < 16; k++) meanEnv[k] /= nm;

            rawTemplates.push({
                id: rawTemplates.length,
                envelope: meanEnv,
                freqLo: fLo,
                freqHi: fHi,
                avgFreq: fSum / nm,
                count: nm
            });
            tId++;
        }

        // Sort templates by frequency (bass first) and assign hues
        rawTemplates.sort((a, b) => a.avgFreq - b.avgFreq);
        for (let i = 0; i < rawTemplates.length; i++) {
            rawTemplates[i].id = i;
            rawTemplates[i].hue = sessionHue(i);
        }
        preAnalysis.templates = rawTemplates;

        // ── Build allSessions from templates ────────────────────────
        //  Creates persistent source identities before live playback
        //  starts, so matchToSessions (locked mode) has stable targets.
        allSessions = [];
        sessionIdCounter = 0;
        for (const tmpl of rawTemplates) {
            const hue = tmpl.hue;
            // Build a fingerprint from the template envelope
            const fp = new Float64Array(FP_LEN);
            for (let h = 0; h < 8; h++) {
                fp[h] = Math.max(-40, Math.min(0, tmpl.envelope[h]));
            }
            // Centroid (fp[8])
            let wS = 0, fS = 0;
            for (let h = 0; h < 16; h++) {
                const amp = Math.pow(10, Math.max(-40, tmpl.envelope[h]) / 20);
                wS += amp; fS += amp * (h + 1);
            }
            fp[8] = wS > 0 ? (fS / wS) * 3 : 0;
            // Flatness (fp[9])
            let logS = 0, linS = 0, cnt = 0;
            for (let h = 0; h < 8; h++) {
                const amp = Math.pow(10, Math.max(-40, tmpl.envelope[h]) / 20);
                if (amp > 0.001) { logS += Math.log(amp); linS += amp; cnt++; }
            }
            fp[9] = (cnt > 0 && linS > 0) ?
                (Math.exp(logS / cnt) / (linS / cnt)) * 10 : 0;
            // Register (fp[12])
            fp[12] = Math.log2(Math.max(30, tmpl.avgFreq) / 55) * 2;
            // Normalize fingerprint
            let fpMag = 0;
            for (let k = 0; k < FP_LEN; k++) fpMag += fp[k] * fp[k];
            fpMag = Math.sqrt(fpMag);
            if (fpMag > 0.001) for (let k = 0; k < FP_LEN; k++) fp[k] /= fpMag;

            allSessions.push({
                id: sessionIdCounter,
                label: SOURCE_LABELS[sessionIdCounter % SOURCE_LABELS.length],
                hue,
                cosH: Math.cos(hue),
                sinH: Math.sin(hue),
                fingerprint: fp,
                lastSeen: 0,
                freq: tmpl.avgFreq,
                instrumentGuess: classifyFromFingerprint({
                    fingerprint: fp, freq: tmpl.avgFreq
                }),
                classifyCounter: 0,
                templateId: tmpl.id
            });
            sessionIdCounter++;
        }

        // Hide progress bar
        analysisBar.classList.add('hidden');
        analysisFill.style.width = '100%';

        drawTimeline();

        console.log(`Pre-analysis complete: ${nFrames} frames, ` +
            `${envCollector.length} envelope observations → ` +
            `${rawTemplates.length} timbral templates, ` +
            `${allSessions.length} sessions`);

        // ── Save FFT resources for live playback ──────────────────────
        _fftMono = mono;
        _fftWin = win;
        _fftBitRev = bitRev;
        _fftTwiddleRe = twiddleRe;
        _fftTwiddleIm = twiddleIm;
        _fftRe = re;
        _fftIm = im;
        _fftNormSq = nSq;
        _fftSampleRate = sr;
    }

    /** Classify instrument from a stabilised session's fingerprint + freq. */
    function classifyFromFingerprint(sess) {
        const freq = sess.freq || sess.avgFreq || 200;
        const fp = sess.fingerprint;
        if (!fp) return '?';

        // Use the un-normalised fingerprint dimensions [8..15] which store
        // timbral features (before unit normalisation, they carry meaningful
        // magnitude info).  After normalisation the relative values still
        // indicate the feature shape.

        // We can derive rough feature values from the normalised fp:
        // fp[8]  ~ scaled spectral centroid
        // fp[9]  ~ scaled spectral flatness
        // fp[10] ~ scaled odd/even asymmetry
        // fp[11] ~ scaled HNR
        // fp[12] ~ scaled log-frequency register
        // fp[13] ~ scaled high-harmonic presence
        // fp[14] ~ scaled sub-fundamental energy
        // fp[15] ~ scaled spectral tilt

        // Since we have the actual session freq, use frequency register directly
        const scores = {};

        // Drums/Percussion: high flatness (fp[9]), low HNR (fp[11])
        scores['Perc'] = (fp[9] > 0.2 ? 3 : 0) + (fp[11] < 0.1 ? 2 : 0);

        // Bass: very low register
        scores['Bass'] = (freq < 110 ? 4 : freq < 180 ? 2 : 0)
            + (fp[8] < 0.15 ? 1 : 0);

        // Vocals: mid register, moderate HNR, moderate flatness
        scores['Vocals'] = (freq > 100 && freq < 1100 ? 1 : 0)
            + (fp[11] > 0.05 && fp[11] < 0.25 ? 2 : 0)
            + (fp[9] > 0.05 && fp[9] < 0.25 ? 1 : 0)
            + (fp[8] > 0.1 && fp[8] < 0.3 ? 1 : 0);

        // Guitar: mid register, decent harmonics
        scores['Guitar'] = (freq >= 70 && freq <= 1000 ? 1 : 0)
            + (fp[11] > 0.15 ? 1 : 0)
            + (fp[15] < -0.05 ? 1 : 0)
            + (fp[8] > 0.05 && fp[8] < 0.2 ? 1 : 0);

        // Keys/Piano: clean harmonics, wide register
        scores['Keys'] = (fp[11] > 0.25 ? 2 : 0)
            + (fp[9] < 0.1 ? 1 : 0);

        // Strings/Pads: very clean, strong even harmonics
        scores['Strings'] = (fp[11] > 0.25 ? 1 : 0)
            + (fp[9] < 0.08 ? 1 : 0)
            + (fp[10] < 0 ? 1 : 0);

        // Synth/Lead: high register, very clean or bright
        scores['Synth'] = (freq > 500 ? 1 : 0)
            + (fp[11] > 0.3 ? 1 : 0)
            + (fp[8] > 0.2 ? 1 : 0);

        // Brass/Wind: strong odd harmonics
        scores['Brass'] = (fp[10] > 0.15 ? 2 : 0)
            + (freq > 100 && freq < 1200 ? 1 : 0);

        let best = '?', bestScore = -1;
        for (const [cat, sc] of Object.entries(scores)) {
            if (sc > bestScore) { bestScore = sc; best = cat; }
        }
        return best;
    }

    // ═════════════════  TIMELINE  ═════════════════════════════════════

    /** Height (px) of the elongated current-time spectral line. */
    const PLAYHEAD_BAND_PX = 40;

    /** Draw the rotated spectrograph on the timeline canvas.
     *  X = frequency (log scale, low at left, high at right).
     *  Y = time (top = earlier, bottom = later).
     *  The current playback position is drawn as a bright, vertically-
     *  elongated spectral band instead of a thin playhead line. */
    function drawTimeline() {
        if (!preAnalysis) return;

        const strip = timelineCanvas.parentElement;
        const W = strip.clientWidth;
        const H = strip.clientHeight;
        if (W < 1 || H < 1) return;
        if (timelineCanvas.width !== W || timelineCanvas.height !== H) {
            timelineCanvas.width = W;
            timelineCanvas.height = H;
        }
        const tCtx = timelineCanvas.getContext('2d');
        tCtx.clearRect(0, 0, W, H);

        const nf = preAnalysis.nFrames;
        const TB = preAnalysis.TIMELINE_BINS;
        const spec = preAnalysis.spectrogram;
        const dbRange = MAX_DB - MIN_DB;

        // Visible time range (Y axis) from zoom/pan (tlZoomX/tlPanX still
        // control the time axis — we just render it vertically now).
        const visStart = tlPanX * nf;
        const visEnd = Math.min(nf, (tlPanX + 1 / tlZoomX) * nf);
        const visFrames = visEnd - visStart;

        // Visible frequency range (X axis) from zoom/pan
        const visYStart = tlPanY * TB;
        const visYEnd = Math.min(TB, (tlPanY + 1 / tlZoomY) * TB);
        const visYRange = visYEnd - visYStart;

        // Current playback frame (for the elongated highlight band)
        let curFrame = -1;
        if (audioBuffer) {
            curFrame = Math.round(getPlaybackTime() / PRE_ANALYSIS_HOP);
        }
        // Convert current frame to a Y-pixel range
        const phFrac = visFrames > 0 ? (curFrame - visStart) / visFrames : -1;
        const phCentrePy = Math.round(phFrac * H);
        const phHalf = Math.floor(PLAYHEAD_BAND_PX / 2);
        const phTop = phCentrePy - phHalf;
        const phBot = phCentrePy + phHalf;
        const phVisible = (phFrac >= -0.02 && phFrac <= 1.02);

        const tlImg = tCtx.createImageData(W, H);
        const tlPx = tlImg.data;

        // Pre-compute hover isolation mask for the spectrogram.
        let hoverMask = null;
        const tlIsoRange = getIsolationRange();
        if (tlIsoRange && lastHoverBins && lastHoverBins.size > 0 && audioBuffer) {
            hoverMask = new Uint8Array(TB);
            const fftBinHz = audioBuffer.sampleRate / FFT_SIZE;
            const loRatio = Math.pow(2, -0.5 / 12);
            const hiRatio = Math.pow(2, 0.5 / 12);
            const detFreqs = [];
            for (const b of lastHoverBins) detFreqs.push(b * fftBinHz);
            detFreqs.sort((a, b) => a - b);
            for (let b = 0; b < TB; b++) {
                const freq = preAnalysis.tlBinFreqs[b];
                for (let d = 0; d < detFreqs.length; d++) {
                    const ratio = freq / detFreqs[d];
                    if (ratio < loRatio) continue;
                    if (ratio > hiRatio) continue;
                    hoverMask[b] = 1;
                    break;
                }
            }
        } else if (tlIsoRange) {
            hoverMask = new Uint8Array(TB);
            for (let note = tlIsoRange.lo; note <= tlIsoRange.hi; note++) {
                const fundFreq = BASE_FREQ * Math.pow(2, note / 12);
                for (let b = 0; b < TB; b++) {
                    if (hoverMask[b]) continue;
                    const freq = preAnalysis.tlBinFreqs[b];
                    for (let h = tlIsoRange.rowLo; h <= tlIsoRange.rowHi; h++) {
                        if (Math.abs(Math.log2(freq / (fundFreq * h))) < 0.5 / 12) {
                            hoverMask[b] = 1;
                            break;
                        }
                    }
                }
            }
        }

        // How many frames have actually been computed so far (progressive loading)
        const analysedFrames = preAnalysis.analysedFrames || nf;

        // Rotated render: Y = time (top→bottom), X = frequency (left→right)
        for (let py = 0; py < H; py++) {
            // Is this row inside the playhead band?
            const inPlayhead = phVisible && (py >= phTop && py <= phBot);

            // Map py → frame index
            const frame = inPlayhead
                ? curFrame   // all playhead-band rows show the current frame
                : Math.min(nf - 1, Math.max(0, Math.floor(visStart + (py / H) * visFrames)));

            // If this frame hasn't been analysed yet, render dark row
            // (but still draw the playhead band edges below)
            if (frame >= analysedFrames) {
                for (let px = 0; px < W; px++) {
                    const imgIdx = (py * W + px) * 4;
                    tlPx[imgIdx] = 8;
                    tlPx[imgIdx + 1] = 8;
                    tlPx[imgIdx + 2] = 12;
                    tlPx[imgIdx + 3] = 255;
                }
                continue;
            }

            const off = frame * TB;

            for (let px = 0; px < W; px++) {
                // Map px → frequency bin (left = low freq, right = high freq)
                const xFrac = px / (W - 1);
                const bin = Math.max(0, Math.min(TB - 1, Math.round(visYStart + xFrac * visYRange)));

                const db = spec[off + bin];
                const rawT = Math.max(0, Math.min(1, (db - MIN_DB) / dbRange));
                let brightness = Math.pow(rawT, GAMMA);

                // Dim non-hovered frequencies
                if (hoverMask && !hoverMask[bin]) brightness *= 0.12;

                const t255 = Math.max(0, Math.min(255, (brightness * 255) | 0));
                const imgIdx = (py * W + px) * 4;
                tlPx[imgIdx] = COLOUR_LUT_R[t255];
                tlPx[imgIdx + 1] = COLOUR_LUT_G[t255];
                tlPx[imgIdx + 2] = COLOUR_LUT_B[t255];
                tlPx[imgIdx + 3] = 255;
            }
        }

        tCtx.putImageData(tlImg, 0, 0);

        // Draw subtle edge lines on the playhead band
        if (phVisible) {
            tCtx.strokeStyle = 'rgba(255,255,255,0.22)';
            tCtx.lineWidth = 1;
            const yTop = Math.max(0, phTop) + 0.5;
            const yBot = Math.min(H - 1, phBot) + 0.5;
            tCtx.beginPath(); tCtx.moveTo(0, yTop); tCtx.lineTo(W, yTop); tCtx.stroke();
            tCtx.beginPath(); tCtx.moveTo(0, yBot); tCtx.lineTo(W, yBot); tCtx.stroke();
        }

        updateTimelineLabels();
    }

    /** Update external DOM-based axis labels for the rotated spectrograph.
     *  X axis = frequency (left=low, right=high).
     *  Y axis = time (top=earlier, bottom=later). */
    function updateTimelineLabels() {
        if (!preAnalysis || !audioBuffer || !tlYLabels || !tlXLabels) return;
        const dur = audioBuffer.duration;

        const strip = timelineCanvas.parentElement;
        const W = strip.clientWidth;
        const H = strip.clientHeight;
        if (W < 1 || H < 1) return;

        // ── Y axis: time labels ──
        tlYLabels.innerHTML = '';
        const visStartSec = tlPanX * dur;
        const visEndSec = Math.min(dur, (tlPanX + 1 / tlZoomX) * dur);
        const visDur = visEndSec - visStartSec;

        const targetYTicks = Math.max(3, Math.floor(H / 60));
        const rawYInterval = visDur / targetYTicks;
        const niceIntervals = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
        let yInterval = niceIntervals[niceIntervals.length - 1];
        for (const ni of niceIntervals) {
            if (ni >= rawYInterval * 0.7) { yInterval = ni; break; }
        }

        const firstYTick = Math.ceil(visStartSec / yInterval) * yInterval;
        for (let t = firstYTick; t <= visEndSec; t += yInterval) {
            const yPct = ((t - visStartSec) / visDur) * 100;
            if (yPct < 3 || yPct > 97) continue;

            const span = document.createElement('span');
            span.className = 'tl-y-tick';
            span.style.top = yPct + '%';
            span.textContent = fmtTimePrecise(t);
            tlYLabels.appendChild(span);
        }

        // ── X axis: frequency labels ──
        tlXLabels.innerHTML = '';
        const TB = preAnalysis.TIMELINE_BINS;
        const tlBinFreqs = preAnalysis.tlBinFreqs;
        const visYStart = tlPanY * TB;
        const visYEnd = Math.min(TB, (tlPanY + 1 / tlZoomY) * TB);
        const visYRange = visYEnd - visYStart;
        const loFreq = tlBinFreqs[Math.max(0, Math.min(TB - 1, Math.round(visYStart)))];
        const hiFreq = tlBinFreqs[Math.max(0, Math.min(TB - 1, Math.round(visYEnd - 1)))];

        const freqTicks = [32, 50, 100, 200, 440, 500, 1000, 2000, 4000, 8000, 16000];
        for (const fq of freqTicks) {
            if (fq < loFreq * 0.9 || fq > hiFreq * 1.1) continue;
            let bestB = 0;
            for (let b = 0; b < TB; b++) {
                if (Math.abs(Math.log2(tlBinFreqs[b] / fq)) < Math.abs(Math.log2(tlBinFreqs[bestB] / fq))) {
                    bestB = b;
                }
            }
            if (bestB < visYStart || bestB >= visYEnd) continue;
            const xFrac = (bestB - visYStart) / visYRange;
            const xPct = xFrac * 100;
            if (xPct < 3 || xPct > 97) continue;

            const span = document.createElement('span');
            span.className = 'tl-x-tick';
            span.style.left = xPct + '%';
            span.textContent = fq >= 1000 ? (fq / 1000) + 'k' : fq + '';
            tlXLabels.appendChild(span);
        }
    }

    /** Format time with sub-second precision for short zoom levels. */
    function fmtTimePrecise(s) {
        const m = Math.floor(s / 60);
        const sec = s % 60;
        if (sec === Math.floor(sec)) {
            return m + ':' + String(Math.floor(sec)).padStart(2, '0');
        }
        return m + ':' + sec.toFixed(1).padStart(4, '0');
    }

    /** Build source isolation sidebar (source swatches for click-to-isolate). */
    function buildSourceSidebar() {
        const sidebar = document.getElementById('source-sidebar');
        if (!sidebar || !preAnalysis || !preAnalysis.sessions) return;
        const sessions = preAnalysis.sessions;
        sidebar.innerHTML = '';

        for (const s of sessions) {
            const rgb = oklabToRgb255(0.75, 0.15 * s.cosH, 0.15 * s.sinH);
            const btn = document.createElement('button');
            btn.className = 'src-btn';
            btn.dataset.sessionId = s.id;
            btn.title = `${s.label} \u2013 ${s.instrumentGuess || 'Unknown'}`;

            const swatch = document.createElement('span');
            swatch.className = 'src-swatch';
            swatch.style.background = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;

            const lbl = document.createElement('span');
            lbl.className = 'src-label';
            lbl.textContent = s.label;

            btn.appendChild(swatch);
            btn.appendChild(lbl);

            btn.addEventListener('click', () => {
                if (isolatedSrcId === s.id) {
                    isolatedSrcId = null;
                    hoveredSrcId = null;
                } else {
                    isolatedSrcId = s.id;
                    hoveredSrcId = s.id;
                }
                applyIsolation();
                updateSidebarHighlight();
                drawTimeline();
            });

            sidebar.appendChild(btn);
        }
        updateSidebarHighlight();
    }

    /** Highlight the active isolation button in the sidebar. */
    function updateSidebarHighlight() {
        const sidebar = document.getElementById('source-sidebar');
        if (!sidebar) return;
        for (const btn of sidebar.children) {
            btn.classList.toggle('active', btn.dataset.sessionId == isolatedSrcId);
        }
    }

    /** Update the timeline playhead position — now drawn on the canvas,
     *  so we just hide the DOM element and trigger a redraw. */
    function updatePlayhead(timeSec) {
        if (!preAnalysis || !audioBuffer) return;
        // Hide the old DOM playhead — the elongated band is drawn in drawTimeline
        timelineHead.style.display = 'none';
    }

    // ═════════════════  PLAYBACK  ═════════════════════════════════════

    function play() {
        if (!audioBuffer || isPlaying) return;
        // Resume AudioContext on user gesture (browser autoplay policy)
        if (audioCtx.state === "suspended") audioCtx.resume();
        sourceNode = audioCtx.createBufferSource();
        sourceNode.buffer = audioBuffer;
        sourceNode.connect(analyser);
        sourceNode.onended = onPlaybackEnded;
        sourceNode.start(0, pausedAt);
        // Offset startedAt so getPlaybackTime() returns pausedAt right now
        const latency = (audioCtx.baseLatency || 0) + (audioCtx.outputLatency || 0);
        startedAt = audioCtx.currentTime - pausedAt - latency;
        isPlaying = true;
        btnPlay.textContent = "Pause";
        // Re-apply isolation if active
        if (isolatedSrcId !== null) applyIsolation();
        // Re-apply hover/selection filter if active
        if (getIsolationRange()) applyHoverFilters();
        if (!animId) tick();
    }

    function pause() {
        if (!isPlaying) return;
        // Use compensated time so pausedAt matches what was last heard
        pausedAt = getPlaybackTime();
        teardownSoloChain();
        teardownHoverFilters();
        sourceNode.onended = null;
        sourceNode.stop();
        sourceNode.disconnect();
        sourceNode = null;
        isPlaying = false;
        btnPlay.textContent = "Play";
        // Stop animation loop but keep last frame visible (frozen)
        if (animId) { cancelAnimationFrame(animId); animId = null; }
    }

    function stop() {
        teardownSoloChain();
        teardownHoverFilters();
        if (sourceNode) {
            sourceNode.onended = null;
            try { sourceNode.stop(); } catch (_) { }
            sourceNode.disconnect();
            sourceNode = null;
        }
        isPlaying = false;
        pausedAt = 0;
        btnPlay.textContent = "Play";
        if (animId) { cancelAnimationFrame(animId); animId = null; }
    }

    // ── Microphone toggle ───────────────────────────────────────────
    async function toggleMic() {
        if (micActive) {
            // Stop mic
            if (micSource) { micSource.disconnect(); micSource = null; }
            if (micStream) {
                micStream.getTracks().forEach(t => t.stop());
                micStream = null;
            }
            micActive = false;
            if (btnMic) btnMic.classList.remove('active');
            // Restore gain (un-mute) for file playback
            if (gainNode) gainNode.gain.value = 1;
            // Stop animation loop (frozen last frame stays visible)
            if (animId && !isPlaying) { cancelAnimationFrame(animId); animId = null; }
            return;
        }

        // Stop file playback if running
        if (isPlaying) pause();

        // Check for secure context (getUserMedia requires HTTPS or localhost)
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            alert('Microphone access requires HTTPS or localhost.\nTry serving with a local server, e.g.:\n  python3 -m http.server');
            return;
        }

        try {
            micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (err) {
            console.warn('Mic access denied:', err);
            alert('Microphone access was denied.\n' + err.message);
            return;
        }

        ensureAudioContext();
        if (audioCtx.state === 'suspended') await audioCtx.resume();

        // Mute output to avoid feedback (mic → analyser → gainNode → speakers)
        if (gainNode) gainNode.gain.value = 0;

        micSource = audioCtx.createMediaStreamSource(micStream);
        micSource.connect(analyser);

        micActive = true;
        spectralAvgSeeded = false;
        idlePrompt.style.display = 'none';
        if (btnMic) btnMic.classList.add('active');
        if (!animId) tick();
    }

    function togglePlay() {
        if (isPlaying) pause(); else play();
    }

    function onPlaybackEnded() {
        // Natural end of buffer
        teardownSoloChain();
        teardownHoverFilters();
        sourceNode = null;
        isPlaying = false;
        pausedAt = 0;
        btnPlay.textContent = "Play";
        updateTimeDisplay(0);
        updatePlayhead(0);
        if (animId) { cancelAnimationFrame(animId); animId = null; }
    }

    // ── Seek ──────────────────────────────────────────────────────────

    // onSeekInput is no longer needed — timeline drag updates pausedAt directly

    function commitSeek() {
        const wasPlaying = isPlaying;
        if (isPlaying) pause();
        // pausedAt is already set by the timeline drag handler
        if (wasPlaying) {
            play();
        } else {
            scrubRender();
        }
    }

    function updateTimeDisplay(currentSec) {
        const dur = audioBuffer ? audioBuffer.duration : 0;
        timeDisplay.textContent = fmtTime(currentSec) + " / " + fmtTime(dur);
    }

    function fmtTime(s) {
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return m + ":" + String(sec).padStart(2, "0");
    }

    // ═════════════════  COLOUR MAP  ═══════════════════════════════════
    //  Heatmap with power-curve baked in for better dynamic range.
    //  The LUT input (0–255) already has gamma applied.

    const STOPS = [
        [0.00, 0, 0, 4],   // near-black (tiny blue tint)
        [0.12, 20, 0, 80],   // deep indigo
        [0.24, 0, 30, 190],   // blue
        [0.36, 0, 150, 200],   // cyan
        [0.48, 10, 190, 50],   // green
        [0.62, 200, 210, 0],   // yellow-green
        [0.76, 240, 160, 0],   // orange
        [0.88, 230, 40, 0],   // red
        [1.00, 255, 255, 255],   // white
    ];

    // Build a 256-entry table: colourLUT[i] = [r, g, b] for t = i/255
    const COLOUR_LUT_R = new Uint8Array(256);
    const COLOUR_LUT_G = new Uint8Array(256);
    const COLOUR_LUT_B = new Uint8Array(256);

    (function buildColourLUT() {
        for (let i = 0; i < 256; i++) {
            const t = i / 255;
            let r = 0, g = 0, b = 0;
            for (let s = 1; s < STOPS.length; s++) {
                if (t <= STOPS[s][0]) {
                    const prev = STOPS[s - 1], next = STOPS[s];
                    const f = (t - prev[0]) / (next[0] - prev[0]);
                    r = prev[1] + f * (next[1] - prev[1]);
                    g = prev[2] + f * (next[2] - prev[2]);
                    b = prev[3] + f * (next[3] - prev[3]);
                    break;
                }
            }
            COLOUR_LUT_R[i] = r;
            COLOUR_LUT_G[i] = g;
            COLOUR_LUT_B[i] = b;
        }
    })();

    // ═════════════════  OKLAB COLOUR UTILITIES  ═══════════════════════
    //  All colour mixing done in OKLAB perceptual colour space.
    //  OKLCH (polar) for defining hues; OKLAB (cartesian) for mixing.

    function oklabToRgb255(L, a, b) {
        // OKLAB → linear RGB via LMS cube roots
        const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
        const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
        const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

        const l = l_ * l_ * l_;
        const m = m_ * m_ * m_;
        const s = s_ * s_ * s_;

        // Linear RGB
        let rl = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
        let gl = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
        let bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;

        // Linear → sRGB gamma
        rl = rl <= 0.0031308 ? rl * 12.92 : 1.055 * Math.pow(Math.max(0, rl), 1 / 2.4) - 0.055;
        gl = gl <= 0.0031308 ? gl * 12.92 : 1.055 * Math.pow(Math.max(0, gl), 1 / 2.4) - 0.055;
        bl = bl <= 0.0031308 ? bl * 12.92 : 1.055 * Math.pow(Math.max(0, bl), 1 / 2.4) - 0.055;

        return [
            Math.max(0, Math.min(255, (rl * 255 + 0.5) | 0)),
            Math.max(0, Math.min(255, (gl * 255 + 0.5) | 0)),
            Math.max(0, Math.min(255, (bl * 255 + 0.5) | 0))
        ];
    }

    // ═════════════════  TIMBRE COLOUR COMPUTATION  ════════════════════
    //  Each function writes per-FFT-bin (a, b) in OKLAB into outA/outB.
    //  Brightness (L) is applied later from amplitude.

    /** Mode A: Spectral Centroid — local brightness-weighted centroid offset → hue. */
    function computeCentroidBinColours(outA, outB) {
        const len = freqData.length;
        const halfWin = 30;
        const C = 0.14;

        for (let i = 0; i < len; i++) {
            if (freqData[i] < MIN_DB + 10) { outA[i] = 0; outB[i] = 0; continue; }

            let sumW = 0, sumWF = 0;
            const lo = Math.max(0, i - halfWin);
            const hi = Math.min(len - 1, i + halfWin);
            for (let j = lo; j <= hi; j++) {
                const w = Math.pow(10, (freqData[j] - MIN_DB) / 60);
                sumW += w;
                sumWF += w * j;
            }
            const centroid = sumWF / sumW;
            const offset = (centroid - i) / halfWin;  // -1 to +1

            // Map offset to hue angle (shifted so centred → green, up → blue, down → red)
            const H = offset * Math.PI * 0.8 + Math.PI * 0.33;
            outA[i] = C * Math.cos(H);
            outB[i] = C * Math.sin(H);
        }
    }

    /** Mode B: Source Attribution — colour by which fundamental owns this bin, with mixing.
     *  Uses persistent session hues for stable colours. */
    function computeSourceBinColours(outA, outB, fundamentals) {
        const binWidth = audioCtx.sampleRate / FFT_SIZE;
        const len = freqData.length;
        const nf = fundamentals.length;
        if (nf === 0) { outA.fill(0); outB.fill(0); return; }

        const maxC = 0.16;

        for (let bin = 0; bin < len; bin++) {
            if (freqData[bin] < MIN_DB + 5) { outA[bin] = 0; outB[bin] = 0; continue; }

            const freq = bin * binWidth;
            if (freq < 1) { outA[bin] = 0; outB[bin] = 0; continue; }

            let sumWa = 0, sumWb = 0, sumW = 0;

            for (let fi = 0; fi < nf; fi++) {
                const fFreq = fundamentals[fi].freq;
                const ratio = freq / fFreq;
                const nearH = Math.round(ratio);
                if (nearH < 1 || nearH > 16) continue;

                const devSemitones = Math.abs(12 * Math.log2(ratio / nearH));
                if (devSemitones > 1.0) continue;

                const closeness = Math.exp(-devSemitones * 4);
                const strength = Math.pow(10, (fundamentals[fi].db - MIN_DB) / 80);
                const harDecay = 1 / nearH;
                const w = closeness * strength * harDecay;

                sumWa += w * fundamentals[fi].cosH;
                sumWb += w * fundamentals[fi].sinH;
                sumW += w;
            }

            if (sumW > 0.001) {
                const conf = Math.min(1, sumW / (sumW + 0.05));
                outA[bin] = (sumWa / sumW) * maxC * conf;
                outB[bin] = (sumWb / sumW) * maxC * conf;
            } else {
                outA[bin] = 0;
                outB[bin] = 0;
            }
        }
    }

    /** Mode C: Harmonic Rank — colour by which harmonic number this bin is. */
    function computeRankBinColours(outA, outB, fundamentals) {
        const binWidth = audioCtx.sampleRate / FFT_SIZE;
        const len = freqData.length;
        const C = 0.14;

        for (let bin = 0; bin < len; bin++) {
            if (freqData[bin] < MIN_DB + 5) { outA[bin] = 0; outB[bin] = 0; continue; }

            const freq = bin * binWidth;
            if (freq < 1) { outA[bin] = 0; outB[bin] = 0; continue; }

            let bestW = 0, bestH = 0;

            for (const f of fundamentals) {
                const ratio = freq / f.freq;
                const nearH = Math.round(ratio);
                if (nearH < 1 || nearH > 16) continue;

                const devSemitones = Math.abs(12 * Math.log2(ratio / nearH));
                if (devSemitones > 1.0) continue;

                const w = Math.exp(-devSemitones * 4) * Math.pow(10, (f.db - MIN_DB) / 80);
                if (w > bestW) { bestW = w; bestH = nearH; }
            }

            if (bestW > 0.001 && bestH >= 1) {
                // Map harmonic 1-8 to hue, wrapping for higher
                const H = ((bestH - 1) / 7) * Math.PI * 1.8;
                outA[bin] = C * Math.cos(H);
                outB[bin] = C * Math.sin(H);
            } else {
                outA[bin] = 0;
                outB[bin] = 0;
            }
        }
    }

    /** Mode E: Source+Rank — hue from source session, chroma from harmonic number. */
    function computeSrcRankBinColours(outA, outB, fundamentals) {
        const binWidth = audioCtx.sampleRate / FFT_SIZE;
        const len = freqData.length;
        const nf = fundamentals.length;
        if (nf === 0) { outA.fill(0); outB.fill(0); return; }

        const maxC = 0.18;

        for (let bin = 0; bin < len; bin++) {
            if (freqData[bin] < MIN_DB + 5) { outA[bin] = 0; outB[bin] = 0; continue; }

            const freq = bin * binWidth;
            if (freq < 1) { outA[bin] = 0; outB[bin] = 0; continue; }

            let bestW = 0, bestSrc = -1, bestH = 1;

            for (let fi = 0; fi < nf; fi++) {
                const fFreq = fundamentals[fi].freq;
                const ratio = freq / fFreq;
                const nearH = Math.round(ratio);
                if (nearH < 1 || nearH > 16) continue;

                const devSemitones = Math.abs(12 * Math.log2(ratio / nearH));
                if (devSemitones > 1.0) continue;

                const closeness = Math.exp(-devSemitones * 4);
                const strength = Math.pow(10, (fundamentals[fi].db - MIN_DB) / 80);
                const harDecay = 1 / nearH;
                const w = closeness * strength * harDecay;

                if (w > bestW) { bestW = w; bestSrc = fi; bestH = nearH; }
            }

            if (bestW > 0.001 && bestSrc >= 0) {
                const rankChroma = maxC / Math.sqrt(bestH);
                const conf = Math.min(1, bestW / (bestW + 0.05));
                outA[bin] = fundamentals[bestSrc].cosH * rankChroma * conf;
                outB[bin] = fundamentals[bestSrc].sinH * rankChroma * conf;
            } else {
                outA[bin] = 0;
                outB[bin] = 0;
            }
        }
    }

    /** Mode D: Spectral Slope — how fast energy drops above this bin → timbre shape. */
    function computeSlopeBinColours(outA, outB) {
        const len = freqData.length;
        const winUp = 20;
        const C = 0.13;

        for (let i = 0; i < len; i++) {
            if (freqData[i] < MIN_DB + 10) { outA[i] = 0; outB[i] = 0; continue; }

            // Linear regression of dB over bins above
            let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, n = 0;
            for (let j = 0; j <= winUp; j++) {
                const idx = i + j;
                if (idx >= len) break;
                const x = j;
                const y = freqData[idx] - freqData[i];
                sumX += x; sumY += y; sumXY += x * y; sumX2 += x * x;
                n++;
            }

            if (n > 3) {
                const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
                // slope typically -3 (steep/sine-like) to 0 (flat/sawtooth-like)
                const norm = Math.max(0, Math.min(1, (slope + 3) / 3));
                // Blue (steep) → Red (gradual)
                const H = (1 - norm) * Math.PI * 0.9 + Math.PI * 0.6;
                outA[i] = C * Math.cos(H);
                outB[i] = C * Math.sin(H);
            } else {
                outA[i] = 0;
                outB[i] = 0;
            }
        }
    }

    // ═════════════════  RENDER LOOP  ══════════════════════════════════

    /** Re-render with existing freqData (for mode/colour switches while paused). */
    function renderOneFrame() {
        if (!analyser || !freqData) return;
        renderFrame();
    }

    /** Compute FFT at a given position using OfflineAudioContext, then render. */
    async function scrubRender() {
        if (!audioBuffer || !audioCtx) return;

        const sr = audioBuffer.sampleRate;
        const fftLen = FFT_SIZE;
        // Render enough samples for one FFT window
        const durSamples = fftLen * 2;
        const durSec = durSamples / sr;
        const startSec = Math.max(0, pausedAt - durSec * 0.5);

        const offline = new OfflineAudioContext(1, durSamples, sr);
        const offAnalyser = offline.createAnalyser();
        offAnalyser.fftSize = fftLen;
        offAnalyser.smoothingTimeConstant = 0;

        const src = offline.createBufferSource();
        src.buffer = audioBuffer;
        src.connect(offAnalyser);
        offAnalyser.connect(offline.destination);
        src.start(0, startSec, durSec);

        await offline.startRendering();

        // Extract FFT data from the offline analyser
        const offFreq = new Float32Array(offAnalyser.frequencyBinCount);
        offAnalyser.getFloatFrequencyData(offFreq);

        // Copy into our working buffer
        if (freqData && freqData.length === offFreq.length) {
            freqData.set(offFreq);
        }

        // ── Instant-seed spectralAvg so normalisation works immediately ─
        //    Without this, scrubbing causes the image to fade because the
        //    running average is stale from the previous playback position.
        if (spectralAvg && freqData) {
            for (let i = 0; i < freqData.length; i++) {
                spectralAvg[i] = Math.max(MIN_DB, freqData[i]);
            }
            spectralAvgSeeded = true;
        }

        renderFrame();
    }

    function tick() {
        animId = requestAnimationFrame(tick);

        // ── Microphone mode: always read live from analyser ────────────
        if (micActive) {
            analyser.getFloatFrequencyData(freqData);
            renderFrame();
            return;
        }

        // Compute current playback time once, visible to both blocks below.
        const current = (isPlaying && !seekDragging) ? getPlaybackTime() : null;

        // Update time display & playhead
        if (current !== null) {
            updateTimeDisplay(current);

            // Auto-pan: keep playhead band visible (time is on Y axis now)
            if (tlZoomX > 1 && audioBuffer) {
                const frac = current / audioBuffer.duration;
                const targetPan = Math.max(0, Math.min(1 - 1 / tlZoomX, frac - (1 / 3) / tlZoomX));
                if (Math.abs(targetPan - tlPanX) > 0.000005) {
                    tlPanX = targetPan;
                }
            }

            // Throttle spectrogram redraw during playback
            {
                const now = performance.now();
                if (now - lastTlRedraw > 100) {
                    drawTimeline();
                    lastTlRedraw = now;
                }
            }

            updatePlayhead(current);

            // Gate solo output by source presence (mute when source not detected)
            if (isolatedSrcId !== null && soloGain && preAnalysis && preAnalysis.presenceMap) {
                const fIdx = Math.min(preAnalysis.nFrames - 1,
                    Math.max(0, Math.floor(current / PRE_ANALYSIS_HOP)));
                const presence = preAnalysis.presenceMap.get(isolatedSrcId);
                const isPresent = presence && fIdx < presence.length && presence[fIdx] > 0.1;
                const tGain = isPresent ? 1 : 0;
                soloGain.gain.linearRampToValueAtTime(tGain, audioCtx.currentTime + 0.03);
            }

            if (current >= audioBuffer.duration) {
                onPlaybackEnded();
                return;
            }
        }

        // ── Get frequency data ─────────────────────────────────────────
        // While seek-dragging, scrubRender handles the auragram — skip here
        // to avoid overwriting the offline FFT with stale live analyser data.
        if (!seekDragging) {
            if (isPlaying) {
                // Use our own time-centred FFT for perfect auragram-spectrogram sync.
                // Falls back to AnalyserNode if pre-analysis hasn't finished yet.
                if (_fftMono) {
                    computeFFTAtTime(current);
                } else {
                    analyser.getFloatFrequencyData(freqData);
                }
            }
            renderFrame();
        }
    }

    /** Core rendering function — reads freqData, writes to canvas + updates legend. */
    function renderFrame() {
        if (!analyser || !freqData) return;

        // ── Update spectral running average ────────────────────────────
        if (isPlaying || micActive) {
            if (!spectralAvgSeeded) {
                let hasRealData = false;
                for (let i = 0; i < freqData.length; i++) {
                    if (freqData[i] > MIN_DB) { hasRealData = true; break; }
                }
                if (hasRealData) {
                    for (let i = 0; i < freqData.length; i++) {
                        spectralAvg[i] = Math.max(MIN_DB, freqData[i]);
                    }
                    spectralAvgSeeded = true;
                }
            } else {
                const a = NORM_ALPHA;
                const b = 1 - a;
                for (let i = 0; i < freqData.length; i++) {
                    const v = Math.max(MIN_DB, freqData[i]);
                    spectralAvg[i] = b * spectralAvg[i] + a * v;
                }
            }
        }

        // ── Render to off-screen ImageData ─────────────────────────────
        const binCount = analyser.frequencyBinCount;
        const dbRange = MAX_DB - MIN_DB;
        const invRange = 1 / dbRange;

        const totalPixels = RENDER_SIZE * RENDER_SIZE;
        curFrameDb.fill(0);
        if (!prevRenderedDb) {
            prevRenderedDb = new Float32Array(totalPixels);
        }

        // ── Detect fundamentals & match to sessions (always, for panel) ──
        const useTimbre = (colourMode !== 'amplitude');
        let detectedFunds = detectFundamentals();
        detectedFunds = matchToSessions(detectedFunds);

        // Update solo filters to track current pitch
        if (isolatedSrcId !== null) updateSoloFilters();

        if (useTimbre) {
            if (!binColA || binColA.length !== binCount) {
                binColA = new Float32Array(binCount);
                binColB = new Float32Array(binCount);
            }
            switch (colourMode) {
                case 'centroid': computeCentroidBinColours(binColA, binColB); break;
                case 'source': computeSourceBinColours(binColA, binColB, detectedFunds); break;
                case 'rank': computeRankBinColours(binColA, binColB, detectedFunds); break;
                case 'slope': computeSlopeBinColours(binColA, binColB); break;
                case 'srcrank': computeSrcRankBinColours(binColA, binColB, detectedFunds); break;
            }
        }

        // ── Shared HPS detection (harmonic + EQ views) ───────────────
        const binFreqHz = audioCtx.sampleRate / FFT_SIZE;
        let confirmedFunds = [];
        let confirmedNotes = new Map();
        if (viewMode === 'harmonic' || viewMode === 'eq') {
            const result = runSharedHPSDetection(freqData, binCount, binFreqHz, isPlaying || micActive);
            confirmedFunds = result.confirmedFunds;
            confirmedNotes = result.confirmedNotes;
        }

        // ── Apply A-weighting to freqData for display ────────────────
        //  Applied after HPS detection (which needs raw spectrum) but
        //  before the rendering loop (which should show perceptual loudness).
        if (aWeightEnabled && _aWeightLUT) {
            for (let i = 0; i < binCount; i++) freqData[i] += _aWeightLUT[i];
        }

        // ── Render pixel loop ─────────────────────────────────────────
        if (viewMode === 'harmonic') {
            // Visible fundamental range with zoom/pan, clipped to C8
            const visOctStart = AURA_LOW_OCTAVE + auraPanX * AURA_OCTAVE_SPAN;
            const visOctRange = AURA_OCTAVE_SPAN / auraZoomX;
            const invBW = FFT_SIZE / audioCtx.sampleRate;

            // Layout: bands separated by thin gaps for visual separation.
            const GAP_FRAC = 0.06;
            const totalUnits = NUM_HARMONIC_ROWS + (NUM_HARMONIC_ROWS - 1) * GAP_FRAC;
            const unitPx = RENDER_SIZE / totalUnits;
            const bandSize = unitPx;
            const gapSize = unitPx * GAP_FRAC;

            // Precompute band ranges in render coords.
            // Normal: rows (Y bands), Swapped: columns (X bands).
            // bandLo[r] = lower pixel index, bandHi[r] = upper pixel index.
            const bandLo = new Float32Array(NUM_HARMONIC_ROWS);
            const bandHi = new Float32Array(NUM_HARMONIC_ROWS);
            if (!harmSwapped) {
                // Row 0 at bottom, row N-1 at top
                for (let r = 0; r < NUM_HARMONIC_ROWS; r++) {
                    const slotBot = r * (bandSize + gapSize);
                    bandLo[r] = RENDER_SIZE - 1 - slotBot - bandSize;  // top py
                    bandHi[r] = RENDER_SIZE - 1 - slotBot;             // bottom py
                }
            } else {
                // Column 0 at left, column N-1 at right
                for (let r = 0; r < NUM_HARMONIC_ROWS; r++) {
                    const slotLeft = r * (bandSize + gapSize);
                    bandLo[r] = Math.round(slotLeft);
                    bandHi[r] = Math.round(slotLeft + bandSize);
                }
            }

            // Clear pixel buffer to opaque black
            for (let i = 0; i < pixels.length; i += 4) {
                pixels[i] = 0; pixels[i + 1] = 0; pixels[i + 2] = 0; pixels[i + 3] = 255;
            }

            // Detection now handled by shared runSharedHPSDetection() above
            const binRow = _binRow;
            const binFund = _binFund;
            binRow.fill(-1);
            binFund.fill(0);

            // ── Pre-compute harmonic claim counts per bin ────────────────
            //  For each FFT bin, count how many confirmed fundamentals have
            //  an integer harmonic landing on/near it.  Used to split energy
            //  when two fundamentals share a harmonic frequency.
            const binClaimCount = _binClaimCount;
            binClaimCount.fill(0);
            for (const fund of confirmedFunds) {
                for (let h = 1; h <= NUM_HARMONIC_ROWS; h++) {
                    const targetBin = Math.round(fund.bin * h);
                    if (targetBin >= binCount) break;
                    // Mark the target bin and ±2 neighbours (to cover rounding)
                    for (let d = -2; d <= 2; d++) {
                        const b = targetBin + d;
                        if (b >= 0 && b < binCount) {
                            binClaimCount[b] = Math.min(255, binClaimCount[b] + 1);
                        }
                    }
                }
            }
            // Ensure all counts are at least 1 to avoid division by zero
            for (let b = 0; b < binCount; b++) {
                if (binClaimCount[b] === 0) binClaimCount[b] = 1;
            }

            // Populate binRow/binFund for hover isolation
            // (row 0 for everything, upgrade to harmonic row if matched)
            for (let b = 0; b < binCount; b++) {
                if (freqData[b] > MIN_DB + 3) {
                    binRow[b] = 0;
                    binFund[b] = b;
                }
            }
            for (const fund of confirmedFunds) {
                for (let r = 0; r < NUM_HARMONIC_ROWS; r++) {
                    const harmN = r + 1;
                    const targetBin = Math.round(fund.bin * harmN);
                    if (targetBin >= binCount) break;
                    const halfSemi = Math.max(3, Math.round(targetBin * 0.058));
                    const sLo = Math.max(0, targetBin - halfSemi);
                    const sHi = Math.min(binCount - 1, targetBin + halfSemi);
                    for (let b = sLo; b <= sHi; b++) {
                        if (freqData[b] > MIN_DB + 8 && (binRow[b] <= 0)) {
                            binRow[b] = r;
                            binFund[b] = fund.bin;
                        }
                    }
                }
            }

            // ── Build hover isolation set based on actual detected harmonics ──
            //  For each bin, check if its fundamental MIDI note AND harmonic row
            //  fall within the isolation range.
            let hoverBins = null;  // Set<binIndex> or null if no isolation
            const isoRange = getIsolationRange();
            if (isoRange) {
                hoverBins = new Set();
                for (let b = 0; b < binCount; b++) {
                    const row = binRow[b];
                    if (row < 0) continue;
                    // Row filter: binRow is 0-based (0 = fundamental), range is 1-based
                    if ((row + 1) < isoRange.rowLo || (row + 1) > isoRange.rowHi) continue;
                    const fb = binFund[b];
                    const fundFreqHz = fb * binFreqHz;
                    if (fundFreqHz <= 0) continue;
                    const fundMidi = Math.round(12 * Math.log2(fundFreqHz / BASE_FREQ));
                    if (fundMidi >= isoRange.lo && fundMidi <= isoRange.hi) hoverBins.add(b);
                }
                lastHoverBins = hoverBins;
                // Update audio filters to match the latest detected bin frequencies
                if (isPlaying) updateHoverFilterFreqs();
            } else {
                lastHoverBins = null;
            }

            // ── Render data bands ─────────────────────────────────────────
            //  Row 0: direct FFT read — all energy above noise floor.
            //  Rows 1+: direct FFT read at exact fundFreq × harmN, gated by
            //  confirmedNotes map.  No per-bin masks → no alignment gaps.
            //
            //  Row 0 applies density correction: at low frequencies many pixels
            //  map to the same FFT bin, making bass appear as a wide bright blob.
            //  Subtracting 10·log₁₀(freq / DENSITY_REF_FREQ) compensates so that
            //  visual brightness reflects energy per semitone, not per Hz-bin.
            {
                // Pre-compute exact pixel position for each confirmed fundamental.
                // For rows 1+, only render at the exact pixel(s) matching the
                // detected frequency — not the whole semitone.
                // fundPixels: array of { px, exactFreq } for non-swapped,
                //             or { py, exactFreq } for swapped.
                const fundPixels = []; // { pos, exactFreq, envCap }
                for (const [midi, exactFreq] of confirmedNotes) {
                    const oct = Math.log2(exactFreq / BASE_FREQ);
                    let pos;
                    if (!harmSwapped) {
                        pos = Math.round(((oct - visOctStart) / visOctRange) * (RENDER_SIZE - 1));
                    } else {
                        pos = Math.round((1 - (oct - visOctStart) / visOctRange) * (RENDER_SIZE - 1));
                    }
                    if (pos < 0 || pos >= RENDER_SIZE) continue;

                    // ── Envelope cap: enforce roughly monotonic harmonic decay ──
                    //  Read raw dB at each harmonic, then build a running ceiling.
                    //  Allow h2 to exceed h1 by up to ENV_H2_SLACK (voice formants),
                    //  but after that the cap only rises by ENV_STEP_SLACK per step.
                    //  Rendering will use min(rawDb, cap[h]) so stray energy from
                    //  other sources can't make a mid-harmonic brighter than the ones below.
                    const ENV_H2_SLACK = 6;     // dB h2 may exceed h1
                    const ENV_STEP_SLACK = 3;   // dB each subsequent h may exceed prev
                    const envCap = new Float32Array(NUM_HARMONIC_ROWS);
                    const rawH = new Float32Array(NUM_HARMONIC_ROWS);
                    for (let h = 0; h < NUM_HARMONIC_ROWS; h++) {
                        const hBin = Math.min(binCount - 1,
                            Math.max(0, Math.round(exactFreq * (h + 1) * invBW)));
                        let hDb = freqData[hBin];
                        if (hDb < MIN_DB) hDb = MIN_DB;
                        if (binClaimCount[hBin] > 1) {
                            hDb -= 10 * Math.log10(binClaimCount[hBin]);
                            if (hDb < MIN_DB) hDb = MIN_DB;
                        }
                        rawH[h] = hDb;
                    }
                    envCap[0] = rawH[0];
                    for (let h = 1; h < NUM_HARMONIC_ROWS; h++) {
                        const slack = (h === 1) ? ENV_H2_SLACK : ENV_STEP_SLACK;
                        envCap[h] = Math.min(rawH[h], envCap[h - 1] + slack);
                    }

                    fundPixels.push({ pos, exactFreq, envCap });
                }

                for (let r = 0; r < NUM_HARMONIC_ROWS; r++) {
                    const harmMul = r + 1;
                    const lo = Math.max(0, Math.round(bandLo[r]));
                    const hi = Math.min(RENDER_SIZE - 1, Math.round(bandHi[r]));

                    if (!harmSwapped) {
                        if (r === 0) {
                            // Row 0: render all pixels — raw spectrum
                            // with density correction for log-freq display
                            for (let py = lo; py <= hi; py++) {
                                const rowOffset = py * RENDER_SIZE;
                                for (let px = 0; px < RENDER_SIZE; px++) {
                                    const pxIdx = rowOffset + px;
                                    const oct = visOctStart + (px / (RENDER_SIZE - 1)) * visOctRange;
                                    const fundFreq = BASE_FREQ * Math.pow(2, oct);
                                    const targetFreq = fundFreq * harmMul;
                                    const bin = Math.min(binCount - 1, Math.max(0, Math.round(targetFreq * invBW)));

                                    let db = freqData[bin];
                                    if (db < MIN_DB) db = MIN_DB;
                                    // Density correction: normalise from per-Hz to per-semitone
                                    // Low freqs have fewer bins/semitone so appear too wide & bright
                                    db -= 10 * Math.log10(Math.max(1, targetFreq / DENSITY_REF_FREQ));
                                    if (db <= MIN_DB) continue;

                                    curFrameDb[pxIdx] = db;

                                    let t = Math.max(0, Math.min(1, (db - MIN_DB) * invRange));
                                    if (modeOnset && (isPlaying || micActive)) {
                                        const delta = db - prevRenderedDb[pxIdx];
                                        if (delta > 0) t = t * 0.3 + delta / 12;
                                    }

                                    let brightness = Math.pow(Math.min(1, Math.max(0, t)), GAMMA);
                                    if (hoverBins && !hoverBins.has(bin)) brightness *= 0.08;
                                    const idx = pxIdx * 4;
                                    const t255 = Math.max(0, Math.min(255, (brightness * 255) | 0));
                                    pixels[idx] = COLOUR_LUT_R[t255];
                                    pixels[idx + 1] = COLOUR_LUT_G[t255];
                                    pixels[idx + 2] = COLOUR_LUT_B[t255];
                                    pixels[idx + 3] = 255;
                                }
                            }
                        } else {
                            // Rows 1+: render only at exact fundamental pixel positions
                            // with envelope cap to enforce roughly decreasing harmonic decay
                            for (const fp of fundPixels) {
                                const px = fp.pos;
                                const targetFreq = fp.exactFreq * harmMul;
                                const bin = Math.min(binCount - 1, Math.max(0, Math.round(targetFreq * invBW)));

                                let db = freqData[bin];
                                if (db < MIN_DB) db = MIN_DB;
                                if (binClaimCount[bin] > 1) {
                                    db -= 10 * Math.log10(binClaimCount[bin]);
                                    if (db < MIN_DB) db = MIN_DB;
                                }
                                // Apply envelope cap — prevent stray energy from other
                                // sources making a mid-harmonic brighter than those below
                                db = Math.min(db, fp.envCap[r]);
                                if (db <= MIN_DB) continue;

                                const t = Math.max(0, Math.min(1, (db - MIN_DB) * invRange));
                                let brightness = Math.pow(t, GAMMA);
                                if (hoverBins && !hoverBins.has(bin)) brightness *= 0.08;
                                const t255 = Math.max(0, Math.min(255, (brightness * 255) | 0));

                                for (let py = lo; py <= hi; py++) {
                                    const pxIdx = py * RENDER_SIZE + px;
                                    curFrameDb[pxIdx] = db;
                                    const idx = pxIdx * 4;
                                    pixels[idx] = COLOUR_LUT_R[t255];
                                    pixels[idx + 1] = COLOUR_LUT_G[t255];
                                    pixels[idx + 2] = COLOUR_LUT_B[t255];
                                    pixels[idx + 3] = 255;
                                }
                            }
                        }
                    } else {
                        if (r === 0) {
                            // Row 0 swapped: render all pixels — raw spectrum
                            // with density correction for log-freq display
                            for (let py = 0; py < RENDER_SIZE; py++) {
                                const yFrac = 1 - py / (RENDER_SIZE - 1);
                                const oct = visOctStart + yFrac * visOctRange;
                                const fundFreq = BASE_FREQ * Math.pow(2, oct);
                                const targetFreq = fundFreq * harmMul;
                                const bin = Math.min(binCount - 1, Math.max(0, Math.round(targetFreq * invBW)));

                                let db = freqData[bin];
                                if (db < MIN_DB) db = MIN_DB;
                                // Density correction: normalise from per-Hz to per-semitone
                                db -= 10 * Math.log10(Math.max(1, targetFreq / DENSITY_REF_FREQ));
                                if (db <= MIN_DB) continue;

                                const t = Math.max(0, Math.min(1, (db - MIN_DB) * invRange));
                                let brightness = Math.pow(t, GAMMA);
                                if (hoverBins && !hoverBins.has(bin)) brightness *= 0.08;
                                const t255 = Math.max(0, Math.min(255, (brightness * 255) | 0));

                                const rowOffset = py * RENDER_SIZE;
                                for (let cx = lo; cx <= hi; cx++) {
                                    const pxIdx = rowOffset + cx;
                                    const idx = pxIdx * 4;
                                    pixels[idx] = COLOUR_LUT_R[t255];
                                    pixels[idx + 1] = COLOUR_LUT_G[t255];
                                    pixels[idx + 2] = COLOUR_LUT_B[t255];
                                    pixels[idx + 3] = 255;
                                }
                            }
                        } else {
                            // Rows 1+ swapped: render only at exact fundamental pixel positions
                            // with envelope cap to enforce roughly decreasing harmonic decay
                            for (const fp of fundPixels) {
                                const py = fp.pos;
                                const targetFreq = fp.exactFreq * harmMul;
                                const bin = Math.min(binCount - 1, Math.max(0, Math.round(targetFreq * invBW)));

                                let db = freqData[bin];
                                if (db < MIN_DB) db = MIN_DB;
                                if (binClaimCount[bin] > 1) {
                                    db -= 10 * Math.log10(binClaimCount[bin]);
                                    if (db < MIN_DB) db = MIN_DB;
                                }
                                // Apply envelope cap
                                db = Math.min(db, fp.envCap[r]);
                                if (db <= MIN_DB) continue;

                                const t = Math.max(0, Math.min(1, (db - MIN_DB) * invRange));
                                let brightness = Math.pow(t, GAMMA);
                                if (hoverBins && !hoverBins.has(bin)) brightness *= 0.08;
                                const t255 = Math.max(0, Math.min(255, (brightness * 255) | 0));

                                const rowOffset = py * RENDER_SIZE;
                                for (let cx = lo; cx <= hi; cx++) {
                                    const pxIdx = rowOffset + cx;
                                    const idx = pxIdx * 4;
                                    pixels[idx] = COLOUR_LUT_R[t255];
                                    pixels[idx + 1] = COLOUR_LUT_G[t255];
                                    pixels[idx + 2] = COLOUR_LUT_B[t255];
                                    pixels[idx + 3] = 255;
                                }
                            }
                        }
                    }
                }
            }

            // Write pixel buffer and blit to visible canvas
            prevRenderedDb.set(curFrameDb);
            offCtx.putImageData(imgData, 0, 0);
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(offCanvas, 0, 0, canvas.width, canvas.height);

            // ── Guide lines (drawn on visible canvas) ────────────────────
            const W = canvas.width;
            const H = canvas.height;
            ctx.strokeStyle = 'rgba(255,255,255,0.10)';
            ctx.lineWidth = 1;

            if (!harmSwapped) {
                // Row boundaries
                for (let r = 0; r < NUM_HARMONIC_ROWS; r++) {
                    const yTop = (bandLo[r] / (RENDER_SIZE - 1)) * H;
                    const yBot = (bandHi[r] / (RENDER_SIZE - 1)) * H;
                    ctx.beginPath(); ctx.moveTo(0, yTop); ctx.lineTo(W, yTop); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(0, yBot); ctx.lineTo(W, yBot); ctx.stroke();
                }
                // Octave gridlines
                ctx.strokeStyle = 'rgba(255,255,255,0.07)';
                const loOct = Math.ceil(visOctStart);
                const hiOct = Math.floor(visOctStart + visOctRange);
                for (let o = loOct; o <= hiOct; o++) {
                    const x = ((o - visOctStart) / visOctRange) * W;
                    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
                }
            } else {
                // Column boundaries
                for (let r = 0; r < NUM_HARMONIC_ROWS; r++) {
                    const xL = (bandLo[r] / (RENDER_SIZE - 1)) * W;
                    const xR = (bandHi[r] / (RENDER_SIZE - 1)) * W;
                    ctx.beginPath(); ctx.moveTo(xL, 0); ctx.lineTo(xL, H); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(xR, 0); ctx.lineTo(xR, H); ctx.stroke();
                }
                // Octave gridlines (horizontal)
                ctx.strokeStyle = 'rgba(255,255,255,0.07)';
                const loOct = Math.ceil(visOctStart);
                const hiOct = Math.floor(visOctStart + visOctRange);
                for (let o = loOct; o <= hiOct; o++) {
                    const y = (1 - (o - visOctStart) / visOctRange) * H;
                    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
                }
            }
        } else if (viewMode === 'eq') {
            // ═══════════════════════════════════════════════════════════════
            //  EQ VIEW — vertical bars per frequency, coloured by SOURCE
            //  IDENTITY using timbral templates from pre-analysis.
            //
            //  Phase 1: Link each confirmed fundamental to its session
            //  (for color) and timbral template (for guided claiming).
            //
            //  Phase 2: Walk harmonics h=1→16 outward from each
            //  fundamental and claim FFT bins.  Templates lower the
            //  energy threshold at expected harmonic positions, capturing
            //  reverb/echo energy that strict peak detection misses.
            //  Lower harmonic number ALWAYS wins ownership.
            //
            //  Phase 3: Render bars — each distinct sound source gets
            //  its own hue from the session/template system.
            // ═══════════════════════════════════════════════════════════════

            // Visible frequency range (use auragram zoom/pan)
            const visOctStart_eq = AURA_LOW_OCTAVE + auraPanX * AURA_OCTAVE_SPAN;
            const visOctRange_eq = AURA_OCTAVE_SPAN / auraZoomX;

            // Clear to black
            for (let i = 0; i < pixels.length; i += 4) {
                pixels[i] = 0; pixels[i + 1] = 0; pixels[i + 2] = 0; pixels[i + 3] = 255;
            }

            const eqDbMin = MIN_DB;
            const eqDbMax = MAX_DB;
            const eqDbRange = eqDbMax - eqDbMin;

            const hasTemplates = preAnalysis && preAnalysis.templates &&
                preAnalysis.templates.length > 0;

            // ── Phase 1: Build fund info with session + template links ──
            const eqFundInfo = []; // {freq, hue, template, sessionIdx}
            for (const [midi, freq] of confirmedNotes) {
                let bestHue = -1;    // session hue (radians), -1 = unmatched
                let bestTmpl = null;
                let bestSessionIdx = -1;

                // Match to detected fundamentals → session
                for (const df of detectedFunds) {
                    const d = Math.abs(12 * Math.log2(df.freq / freq));
                    if (d < 2 && df.sessionId >= 0) {
                        const si = allSessions.findIndex(s => s.id === df.sessionId);
                        if (si >= 0) {
                            bestSessionIdx = si;
                            bestHue = allSessions[si].hue;
                            // Use session's template if available
                            if (allSessions[si].templateId !== undefined && hasTemplates) {
                                bestTmpl = preAnalysis.templates[allSessions[si].templateId] || null;
                            }
                            break;
                        }
                    }
                }

                // If no session match, try direct template matching by envelope
                if (!bestTmpl && hasTemplates) {
                    const curEnv = extractHarmonicEnvelope(
                        freqData, freq, binFreqHz, binCount
                    );
                    let bestSim = 0.5; // minimum similarity threshold
                    for (const tmpl of preAnalysis.templates) {
                        if (freq < tmpl.freqLo * 0.4 || freq > tmpl.freqHi * 2.5) continue;
                        const sim = envelopeSimilarity(curEnv, tmpl.envelope);
                        if (sim > bestSim) {
                            bestSim = sim;
                            bestTmpl = tmpl;
                        }
                    }
                    if (bestTmpl && bestHue < 0) bestHue = bestTmpl.hue;
                }

                eqFundInfo.push({
                    freq,
                    hue: bestHue,
                    template: bestTmpl,
                    sessionIdx: bestSessionIdx
                });
            }

            // ── Phase 2: Build bin ownership from fundamentals outward ──
            const eqBinOwner = new Int8Array(binCount);  // index into eqFundInfo (-1 = unclaimed)
            eqBinOwner.fill(-1);
            const eqBinHNum = new Uint8Array(binCount);
            eqBinHNum.fill(255);

            const EQ_BASE_HW = 5;    // search radius for h=1
            const EQ_HW_SCALE = 1.2;  // extra bins per harmonic number
            const EQ_CLAIM_PAD = 4;    // extra bins beyond search around peak
            const EQ_MIN_ENERGY = MIN_DB + 6;  // minimum dB (no template)
            const EQ_TMPL_ENERGY = MIN_DB + 3;  // lower threshold with template
            const EQ_TMPL_TOL = 18;           // dB tolerance for template match
            const EQ_MAX_HARM = 24;           // walk up to 24th harmonic

            for (let fi = 0; fi < eqFundInfo.length; fi++) {
                const info = eqFundInfo[fi];
                const ff = info.freq;
                const tmpl = info.template;
                const fundBin = Math.round(ff / binFreqHz);
                const fundDb = (fundBin >= 0 && fundBin < binCount)
                    ? freqData[fundBin] : MIN_DB;

                for (let h = 1; h <= EQ_MAX_HARM; h++) {
                    const hFreq = ff * h;
                    const expectedBin = Math.round(hFreq / binFreqHz);
                    if (expectedBin >= binCount) break;

                    const hw = Math.round(EQ_BASE_HW + EQ_HW_SCALE * h);

                    // Find spectral peak near expected harmonic position
                    let peakBin = expectedBin;
                    let peakDb = (expectedBin >= 0 && expectedBin < binCount)
                        ? freqData[expectedBin] : MIN_DB;
                    for (let d = -hw; d <= hw; d++) {
                        const cb = expectedBin + d;
                        if (cb >= 0 && cb < binCount && freqData[cb] > peakDb) {
                            peakDb = freqData[cb];
                            peakBin = cb;
                        }
                    }

                    // Energy gating — template lowers threshold for expected harmonics
                    let accept = peakDb >= EQ_MIN_ENERGY;
                    if (!accept && tmpl && (h - 1) < tmpl.envelope.length) {
                        const expectedDb = fundDb + tmpl.envelope[h - 1];
                        if (peakDb >= EQ_TMPL_ENERGY &&
                            Math.abs(peakDb - expectedDb) < EQ_TMPL_TOL) {
                            accept = true;
                        }
                    }
                    if (!accept) continue;

                    // Claim bins — claim window SCALES with h (matching search window)
                    // Lower harmonic number ALWAYS wins ownership
                    const claimHW = hw + EQ_CLAIM_PAD;
                    for (let d = -claimHW; d <= claimHW; d++) {
                        const cb = peakBin + d;
                        if (cb < 0 || cb >= binCount) continue;
                        if (h < eqBinHNum[cb]) {
                            eqBinOwner[cb] = fi;
                            eqBinHNum[cb] = h;
                        }
                    }
                }
            }

            // ── Phase 2.5: Neighbour propagation ────────────────────────
            //  Unclaimed bins with real energy near a claimed bin inherit
            //  that bin's owner.  This fills gaps between harmonics where
            //  reverb, formant spread, and spectral leakage place energy
            //  that's clearly part of the same source but falls outside
            //  the tight claim windows around discrete peaks.
            const PROP_RADIUS = 25;   // max bins to search for a neighbour
            const PROP_MIN_DB = MIN_DB + 10;
            for (let b = 0; b < binCount; b++) {
                if (eqBinOwner[b] >= 0) continue;          // already claimed
                if (freqData[b] < PROP_MIN_DB) continue;   // no energy

                // Search left and right for nearest claimed bin
                let bestDist = PROP_RADIUS + 1;
                let bestOwner = -1;
                for (let d = 1; d <= PROP_RADIUS; d++) {
                    const left = b - d;
                    const right = b + d;
                    if (left >= 0 && eqBinOwner[left] >= 0) {
                        if (d < bestDist) { bestDist = d; bestOwner = eqBinOwner[left]; }
                        break;
                    }
                    if (right < binCount && eqBinOwner[right] >= 0) {
                        if (d < bestDist) { bestDist = d; bestOwner = eqBinOwner[right]; }
                        break;
                    }
                }
                if (bestOwner >= 0) {
                    eqBinOwner[b] = bestOwner;
                    eqBinHNum[b] = 254;  // mark as propagated (not a direct harmonic)
                }
            }

            // ── Phase 3: Render bars with source-identity colours ───────
            for (let px = 0; px < RENDER_SIZE; px++) {
                const oct = visOctStart_eq + (px / (RENDER_SIZE - 1)) * visOctRange_eq;
                const freq = BASE_FREQ * Math.pow(2, oct);
                const bin = Math.min(binCount - 1,
                    Math.max(0, Math.round(freq / binFreqHz)));

                let db = freqData[bin];
                if (db < eqDbMin) db = eqDbMin;
                if (db > eqDbMax) db = eqDbMax;

                const t = (db - eqDbMin) / eqDbRange;
                if (t <= 0) continue;

                const barPx = Math.round(t * RENDER_SIZE);
                if (barPx <= 0) continue;

                const ownerIdx = eqBinOwner[bin];

                let r, g, b_col;
                if (ownerIdx >= 0) {
                    const info = eqFundInfo[ownerIdx];
                    const isPropagated = eqBinHNum[bin] >= 254; // echo/reverb energy
                    let hue360;
                    if (info.hue >= 0) {
                        // Session/template hue (radians → degrees)
                        hue360 = ((info.hue % (2 * Math.PI)) / (2 * Math.PI)) * 360;
                        if (hue360 < 0) hue360 += 360;
                    } else {
                        // Fallback: frequency-based hue
                        hue360 = ((Math.log2(info.freq / 30) /
                            Math.log2(4200 / 30)) * 330) % 360;
                    }
                    // Direct harmonics: full saturation, bright
                    // Echo/reverb: desaturated, darker — tinted but muted
                    const sat = isPropagated ? 0.35 : 0.92;
                    const lit = isPropagated
                        ? 0.18 + t * 0.22   // 18%–40% (darker)
                        : 0.30 + t * 0.35;  // 30%–65% (full)
                    // HSL → RGB
                    const C = (1 - Math.abs(2 * lit - 1)) * sat;
                    const X = C * (1 - Math.abs(((hue360 / 60) % 2) - 1));
                    const m = lit - C / 2;
                    const h6 = hue360 / 60;
                    let r1, g1, b1;
                    if (h6 < 1) { r1 = C; g1 = X; b1 = 0; }
                    else if (h6 < 2) { r1 = X; g1 = C; b1 = 0; }
                    else if (h6 < 3) { r1 = 0; g1 = C; b1 = X; }
                    else if (h6 < 4) { r1 = 0; g1 = X; b1 = C; }
                    else if (h6 < 5) { r1 = X; g1 = 0; b1 = C; }
                    else { r1 = C; g1 = 0; b1 = X; }
                    r = Math.round((r1 + m) * 255);
                    g = Math.round((g1 + m) * 255);
                    b_col = Math.round((b1 + m) * 255);
                } else {
                    // Unclaimed — dim grey
                    const grey = Math.round(30 + t * 80);
                    r = grey; g = grey; b_col = grey;
                }

                // Fill the bar from bottom up
                const yStart = RENDER_SIZE - barPx;
                for (let py = yStart; py < RENDER_SIZE; py++) {
                    const pxIdx = py * RENDER_SIZE + px;
                    const idx = pxIdx * 4;
                    pixels[idx] = r;
                    pixels[idx + 1] = g;
                    pixels[idx + 2] = b_col;
                    pixels[idx + 3] = 255;
                }
            }

            offCtx.putImageData(imgData, 0, 0);
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(offCanvas, 0, 0, canvas.width, canvas.height);

            // ── EQ overlay: dB gridlines (labels are in Y-axis sidebar) ──
            const W = canvas.width;
            const H = canvas.height;
            ctx.strokeStyle = 'rgba(255,255,255,0.10)';
            ctx.lineWidth = 1;
            for (let dB = Math.ceil(eqDbMin / 10) * 10; dB <= eqDbMax; dB += 10) {
                const t_grid = (dB - eqDbMin) / eqDbRange;
                const y = H * (1 - t_grid);
                ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
            }
            // Octave gridlines (vertical)
            ctx.strokeStyle = 'rgba(255,255,255,0.07)';
            const loOct_eq = Math.ceil(visOctStart_eq);
            const hiOct_eq = Math.floor(visOctStart_eq + visOctRange_eq);
            for (let o = loOct_eq; o <= hiOct_eq; o++) {
                const x = ((o - visOctStart_eq) / visOctRange_eq) * W;
                ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
            }

        } else {
            // ── Non-harmonic modes: discrete bins from precomputed lookup ──
            for (let py = 0; py < RENDER_SIZE; py++) {
                const rowOffset = py * RENDER_SIZE;
                for (let px = 0; px < RENDER_SIZE; px++) {
                    const pxIdx = rowOffset + px;
                    const bin = Math.round(binLookup[pxIdx]);

                    let db = (bin >= 0 && bin < binCount) ? freqData[bin] : MIN_DB;
                    if (db < MIN_DB) db = MIN_DB;

                    curFrameDb[pxIdx] = db;

                    let t = Math.max(0, Math.min(1, (db - MIN_DB) * invRange));
                    if (modeOnset && (isPlaying || micActive)) {
                        const delta = db - prevRenderedDb[pxIdx];
                        if (delta > 0) t = t * 0.3 + delta / 12;
                    }

                    const brightness = Math.pow(Math.min(1, Math.max(0, t)), GAMMA);

                    const idx = pxIdx * 4;
                    if (useTimbre && bin >= 0 && bin < binCount) {
                        const rgb = oklabToRgb255(brightness, binColA[bin], binColB[bin]);
                        pixels[idx] = rgb[0];
                        pixels[idx + 1] = rgb[1];
                        pixels[idx + 2] = rgb[2];
                    } else {
                        const t255 = (brightness * 255) | 0;
                        pixels[idx] = COLOUR_LUT_R[t255];
                        pixels[idx + 1] = COLOUR_LUT_G[t255];
                        pixels[idx + 2] = COLOUR_LUT_B[t255];
                    }
                    pixels[idx + 3] = 255;
                }
            }

            prevRenderedDb.set(curFrameDb);

            offCtx.putImageData(imgData, 0, 0);

            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(offCanvas, 0, 0, canvas.width, canvas.height);
        }

        // ── Harmonic overlay (disabled in harmonic view — redundant) ──
        if (showHarmonics && viewMode !== 'harmonic') drawHarmonicOverlay(detectedFunds);

        // ── Update legend ──────────────────────────────────────────────
        updateLegend(detectedFunds);

        // ── Restore raw freqData so next renderOneFrame() doesn't double-apply ──
        if (aWeightEnabled && _aWeightLUT) {
            for (let i = 0; i < binCount; i++) freqData[i] -= _aWeightLUT[i];
        }
    }

    /** Convert a frequency to canvas pixel coordinates. Returns null if out of range.
     *  In harmonic mode returns null (overlay is disabled). */
    function freqToCanvasXY(freq) {
        if (viewMode === 'harmonic') return null;  // overlay not meaningful in harmonic view
        if (freq < LOW_FREQ * 0.9 || freq > HIGH_FREQ * 1.1) return null;

        const totalOctave = Math.log2(freq / BASE_FREQ);
        const octaveI = Math.floor(totalOctave);
        const xFrac = totalOctave - octaveI;
        const bandCentre = octaveI + 0.5;
        const shearedYNorm = (bandCentre - LOW_OCTAVE) / OCTAVE_SPAN;
        const yNP = shearedYNorm + xFrac / OCTAVE_SPAN;   // yNorm in extended range
        const yMax = 1 + SHEAR_EXT;
        if (yNP < -0.05 || yNP > yMax * 1.05) return null;

        let renderX, renderY;
        if (viewMode === 'swapped') {
            // X = octave position, Y = note position
            renderX = (yNP / yMax) * (RENDER_SIZE - 1);
            renderY = (1 - xFrac) * (RENDER_SIZE - 1);
        } else {
            // Standard sheared: X = note, Y = octave
            renderX = xFrac * (RENDER_SIZE - 1);
            renderY = (1 - yNP / yMax) * (RENDER_SIZE - 1);
        }

        return {
            x: renderX / RENDER_SIZE * canvas.width,
            y: renderY / RENDER_SIZE * canvas.height
        };
    }

    /** Get a human-readable note name for a frequency, e.g. "A4". */
    function noteName(freq) {
        const semitones = Math.round(12 * Math.log2(freq / BASE_FREQ));
        const idx = ((semitones % 12) + 12) % 12;
        const oct = Math.floor(semitones / 12);
        return NOTE_NAMES[idx] + oct;
    }

    /** Shared HPS-based fundamental detection pipeline.
     *  Runs the full HPS → spectral-peak validation → rolloff → suppression
     *  → confirmedNotes + temporal persistence pipeline.  Used by both the
     *  harmonic view and the EQ view so they show the same fundamentals.
     *  @returns {{ confirmedFunds: Array, confirmedNotes: Map<number,number> }} */
    function runSharedHPSDetection(freqData, binCount, binFreqHz, playing) {
        const hpsFunds = findFundamentalsHPS(freqData, binCount, binFreqHz, 32);

        // ── Pre-compute spectral peaks ──────────────────────────────
        //  Used by the HPS validation pipeline only (EQ view uses its
        //  own fundamentals-outward ownership system).
        const PEAK_HW = 5;
        const PEAK_PROM = 3;
        const PEAK_MARK = 3;
        const isSpecPeak = _isSpecPeak;
        isSpecPeak.fill(0);
        for (let b = PEAK_HW; b < binCount - PEAK_HW; b++) {
            const db = freqData[b];
            if (db <= MIN_DB + 3) continue;
            let isMax = true;
            let localFloor = db;
            for (let d = 1; d <= PEAK_HW; d++) {
                if (freqData[b - d] > db || freqData[b + d] > db) {
                    isMax = false; break;
                }
                localFloor = Math.min(localFloor, freqData[b - d], freqData[b + d]);
            }
            if (!isMax) continue;
            if ((db - localFloor) < PEAK_PROM) continue;
            for (let d = -PEAK_MARK; d <= PEAK_MARK; d++) {
                const mb = b + d;
                if (mb >= 0 && mb < binCount) isSpecPeak[mb] = 1;
            }
        }

        // ── Validate HPS candidates ─────────────────────────────────
        const HARM_CHECK = 6;
        const MIN_CONFIRMED = 4;
        const confirmedRaw = [];
        for (const fund of hpsFunds) {
            let fundIsPeak = false;
            for (let d = -2; d <= 2; d++) {
                const cb = fund.bin + d;
                if (cb >= 0 && cb < binCount && isSpecPeak[cb]) {
                    fundIsPeak = true; break;
                }
            }
            if (!fundIsPeak) continue;

            let confirmed = 0;
            for (let h = 1; h <= HARM_CHECK; h++) {
                const hBin = Math.round(fund.bin * (h + 1));
                if (hBin >= binCount) break;
                for (let d = -2; d <= 2; d++) {
                    const cb = hBin + d;
                    if (cb >= 0 && cb < binCount && isSpecPeak[cb]) {
                        confirmed++; break;
                    }
                }
            }
            if (confirmed < MIN_CONFIRMED) continue;
            confirmedRaw.push(fund);
        }

        // ── Rolloff validation ──────────────────────────────────────
        const ROLLOFF_TOLERANCE = 6;
        const rolloffPassed = [];
        for (const fund of confirmedRaw) {
            const lowH = [1, 2];
            const highH = [4, 5, 6];
            let lowSum = 0, lowN = 0;
            for (const h of lowH) {
                const hBin = Math.round(fund.bin * h);
                if (hBin < binCount) { lowSum += freqData[hBin]; lowN++; }
            }
            let highSum = 0, highN = 0;
            for (const h of highH) {
                const hBin = Math.round(fund.bin * h);
                if (hBin < binCount) { highSum += freqData[hBin]; highN++; }
            }
            if (lowN === 0 || highN === 0) { rolloffPassed.push(fund); continue; }
            const lowAvg = lowSum / lowN;
            const highAvg = highSum / highN;
            if (highAvg - lowAvg <= ROLLOFF_TOLERANCE) {
                rolloffPassed.push(fund);
            }
        }

        // ── Suppress harmonics of lower fundamentals ────────────────
        const INDEPENDENCE_DB = 10;
        const sortedByFreq = [...rolloffPassed].sort((a, b) => a.freq - b.freq);
        const confirmedFunds = [];
        for (const p of sortedByFreq) {
            let isHarmonicOfLower = false;
            for (const q of confirmedFunds) {
                const ratio = p.freq / q.freq;
                const nearest = Math.round(ratio);
                if (nearest >= 2 && nearest <= 10 &&
                    Math.abs(ratio - nearest) < 0.04) {
                    const prevHBin = Math.round(q.bin * (nearest - 1));
                    const nextHBin = Math.round(q.bin * (nearest + 1));
                    const prevHDb = (prevHBin > 0 && prevHBin < binCount)
                        ? freqData[prevHBin] : MIN_DB;
                    const nextHDb = (nextHBin > 0 && nextHBin < binCount)
                        ? freqData[nextHBin] : MIN_DB;
                    const adjacentAvg = (prevHDb + nextHDb) / 2;
                    let pDb = freqData[p.bin];
                    if (p.bin > 0) pDb = Math.max(pDb, freqData[p.bin - 1]);
                    if (p.bin < binCount - 1) pDb = Math.max(pDb, freqData[p.bin + 1]);
                    if (pDb <= adjacentAvg + INDEPENDENCE_DB) {
                        isHarmonicOfLower = true;
                        break;
                    }
                }
            }
            if (!isHarmonicOfLower) confirmedFunds.push(p);
        }

        // ── Confirmed-fundamental note set ──────────────────────────
        const confirmedNotes = new Map();
        for (const fund of confirmedFunds) {
            const exactFreq = fund.bin * binFreqHz;
            const midi = Math.round(12 * Math.log2(exactFreq / BASE_FREQ));
            if (!confirmedNotes.has(midi)) confirmedNotes.set(midi, exactFreq);
        }

        // ── Temporal persistence ────────────────────────────────────
        if (playing) {
            for (const [midi, entry] of _prevConfirmedNotes) {
                if (confirmedNotes.has(midi)) continue;
                const fundBin = Math.round(entry.freq / binFreqHz);
                const fundDb = (fundBin >= 0 && fundBin < binCount) ? freqData[fundBin] : MIN_DB;
                if (fundDb > MIN_DB + NOTE_HOLD_MIN_DB_ABOVE && entry.hold > 0) {
                    confirmedNotes.set(midi, entry.freq);
                }
            }
            const nextPersist = new Map();
            for (const [midi, freq] of confirmedNotes) {
                const prev = _prevConfirmedNotes.get(midi);
                if (prev && !confirmedFunds.some(f => {
                    const m = Math.round(12 * Math.log2((f.bin * binFreqHz) / BASE_FREQ));
                    return m === midi;
                })) {
                    nextPersist.set(midi, { freq, hold: prev.hold - 1 });
                } else {
                    nextPersist.set(midi, { freq, hold: NOTE_HOLD_FRAMES });
                }
            }
            _prevConfirmedNotes = nextPersist;
        }

        return { confirmedFunds, confirmedNotes };
    }

    /** Find fundamentals via Harmonic Product Spectrum (HPS).
     *  Averages the dB spectrum at integer-multiple positions (equivalent to
     *  the geometric mean of linear magnitudes).  Peaks in the product
     *  correspond to real fundamentals whose harmonic series creates aligned
     *  energy.  Includes subharmonic suppression to remove octave-error ghosts.
     *  @param {Float32Array} specDb  - dB magnitude spectrum (from analyser)
     *  @param {number}       bins    - number of frequency bins
     *  @param {number}       binHz   - Hz per bin (sampleRate / fftSize)
     *  @param {number}       [max=24] - max candidates to return
     *  @returns {Array<{bin:number, freq:number, score:number}>} sorted by score desc */
    function findFundamentalsHPS(specDb, bins, binHz, max) {
        if (!max) max = 24;
        const hpsOrder = 5;          // multiply 5 downsampled copies
        const minBin = Math.max(1, Math.ceil(LOW_FREQ / binHz));
        const maxBin = Math.min(bins - 1, Math.floor(HPS_MAX_FREQ / binHz));

        // HPS in dB domain: average dB at harmonic positions.
        const hps = _hpsBuffer || new Float64Array(bins);
        for (let i = 0; i < bins; i++) hps[i] = -Infinity;
        for (let i = minBin; i <= maxBin; i++) {
            let dbSum = 0;
            let n = 0;
            for (let h = 1; h <= hpsOrder; h++) {
                const idx = i * h;
                if (idx >= bins) break;
                // ±1 bin window to handle spectral leakage
                let best = specDb[idx];
                if (idx > 0 && specDb[idx - 1] > best) best = specDb[idx - 1];
                if (idx < bins - 1 && specDb[idx + 1] > best) best = specDb[idx + 1];
                dbSum += Math.max(MIN_DB, best);
                n++;
            }
            hps[i] = n >= 2 ? dbSum / n : -Infinity;
        }

        // Peak detection in HPS — require actual energy at the fundamental
        const peaks = [];
        const minScore = MIN_DB + 25;    // at least 25 dB above noise floor on average
        const fundThresh = MIN_DB + 50;  // fundamental must be clearly audible
        // -50 dB — quiet fundamentals don't produce visible harmonics
        for (let i = minBin + 1; i < maxBin; i++) {
            if (hps[i] > hps[i - 1] && hps[i] > hps[i + 1] && hps[i] > minScore) {
                // Reject phantom fundamentals: the bin at the fundamental frequency
                // must itself have significant energy, not just its upper harmonics
                let fundDb = specDb[i];
                if (i > 0 && specDb[i - 1] > fundDb) fundDb = specDb[i - 1];
                if (i < bins - 1 && specDb[i + 1] > fundDb) fundDb = specDb[i + 1];
                if (fundDb < fundThresh) continue;

                // ── Harmonic coherence bonus ────────────────────────────
                //  Measure how well the harmonic series follows a natural
                //  amplitude rolloff.  A clean tonal source (voice, pitched
                //  instrument) will have h1 > h2 > h3 > … (roughly), while
                //  a percussive hit has random peaks across harmonics.
                //  Bonus = count of consecutive non-increasing harmonic pairs
                //         × COHERENCE_WEIGHT dB.
                const COHERENCE_WEIGHT = 4;  // dB bonus per coherent pair
                let coherence = 0;
                let prevHarmDb = fundDb;
                for (let h = 2; h <= hpsOrder; h++) {
                    const hIdx = i * h;
                    if (hIdx >= bins) break;
                    let hDb = specDb[hIdx];
                    if (hIdx > 0 && specDb[hIdx - 1] > hDb) hDb = specDb[hIdx - 1];
                    if (hIdx < bins - 1 && specDb[hIdx + 1] > hDb) hDb = specDb[hIdx + 1];
                    // Allow h2 to be louder than h1 (common in voice formants)
                    // but higher harmonics should decrease
                    if (h >= 3 && hDb <= prevHarmDb + 3) coherence++;
                    prevHarmDb = hDb;
                }
                const coherenceBonus = coherence * COHERENCE_WEIGHT;

                peaks.push({ bin: i, freq: i * binHz, score: hps[i] + coherenceBonus });
            }
        }
        peaks.sort((a, b) => b.score - a.score);

        // Non-maximum suppression: within 1 semitone, keep only the strongest
        const nms = [];
        for (const p of peaks) {
            let suppressed = false;
            for (const q of nms) {
                if (Math.abs(12 * Math.log2(p.freq / q.freq)) < 1.0) {
                    suppressed = true; break;
                }
            }
            if (!suppressed) nms.push(p);
            if (nms.length >= max * 2) break;  // collect extras for subharmonic pass
        }

        // Harmonic suppression: remove candidates that are an upward
        // harmonic of a stronger candidate.  We intentionally do NOT
        // suppress subharmonics (lower-frequency candidates), because
        // the real fundamental often scores lower than a formant-boosted
        // h2.  Subharmonic cleanup is handled later in confirmedFunds
        // where we sort by frequency and always prefer the lowest pitch.
        const result = [];
        for (const p of nms) {
            let isRelated = false;
            for (const q of result) {
                // Is p a harmonic of q? (e.g. p=440, q=220 → ratio=2)
                const ratio = p.freq / q.freq;
                const nearUp = Math.round(ratio);
                if (nearUp >= 2 && nearUp <= 10 &&
                    Math.abs(ratio - nearUp) < 0.04) {
                    isRelated = true;
                    break;
                }
                // No subharmonic check — see comment above.
            }
            if (!isRelated) result.push(p);
            if (result.length >= max) break;
        }

        return result;
    }

    /** Detect likely fundamental pitches via peak-finding + harmonic scoring. */
    function detectFundamentals() {
        if (!freqData || !audioCtx) return [];

        const sampleRate = audioCtx.sampleRate;
        const binWidth = sampleRate / FFT_SIZE;
        const minBin = Math.ceil(LOW_FREQ / binWidth);
        const maxBin = Math.min(Math.floor(HIGH_FREQ / binWidth), freqData.length - 1);
        const threshold = MAX_DB - 45;

        // ── Step 1: Find local maxima ──────────────────────────────────
        const rawPeaks = [];
        for (let i = minBin + 2; i < maxBin - 2; i++) {
            if (freqData[i] > threshold &&
                freqData[i] >= freqData[i - 1] && freqData[i] >= freqData[i + 1] &&
                freqData[i] >= freqData[i - 2] && freqData[i] >= freqData[i + 2]) {
                rawPeaks.push({ bin: i, freq: i * binWidth, db: freqData[i] });
            }
        }

        // ── Step 2: Non-maximum suppression (remove peaks ≤1.5 semitones of a stronger one)
        rawPeaks.sort((a, b) => b.db - a.db);
        const peaks = [];
        for (const p of rawPeaks) {
            let dominated = false;
            for (const q of peaks) {
                if (Math.abs(12 * Math.log2(p.freq / q.freq)) < 1.5) { dominated = true; break; }
            }
            if (!dominated) peaks.push(p);
        }

        // ── Step 3: Score each peak as a potential fundamental ─────────
        // A real fundamental should have energy at integer multiples.
        const candidates = [];
        for (const p of peaks) {
            let score = 0;
            let matchCount = 0;
            for (let h = 2; h <= 8; h++) {
                const hFreq = p.freq * h;
                if (hFreq > HIGH_FREQ) break;
                const hBin = Math.round(hFreq / binWidth);
                if (hBin >= freqData.length) break;

                // Check a small window around the expected harmonic position
                let best = MIN_DB;
                for (let j = -3; j <= 3; j++) {
                    const idx = hBin + j;
                    if (idx >= 0 && idx < freqData.length) best = Math.max(best, freqData[idx]);
                }
                if (best > threshold) {
                    score += best / h;
                    matchCount++;
                }
            }
            if (matchCount >= 2) {
                candidates.push({ freq: p.freq, db: p.db, score: p.db + score, harmonics: matchCount + 1 });
            }
        }
        candidates.sort((a, b) => b.score - a.score);

        // ── Step 4: Remove candidates that are harmonics of a stronger fundamental
        //    Only suppress if the candidate is significantly weaker (< 65% of the
        //    fundamental's score).  This lets two real sources at harmonically-
        //    related pitches coexist.
        const fundamentals = [];
        for (const c of candidates) {
            let dominated = false;
            for (const f of fundamentals) {
                if (dominated) break;
                for (let h = 2; h <= 8; h++) {
                    if (Math.abs(12 * Math.log2(c.freq / (f.freq * h))) < 1.5 &&
                        c.score < f.score * 0.50) {
                        dominated = true;
                        break;
                    }
                }
            }
            if (!dominated) fundamentals.push(c);
        }

        return fundamentals.slice(0, 6);
    }

    /** Draw coloured harmonic series for detected fundamentals.
     *  Uses persistent session colours. */
    function drawHarmonicOverlay(funds) {
        if (!freqData) return;
        if (!funds) funds = detectFundamentals();

        for (let fi = 0; fi < funds.length; fi++) {
            const f = funds[fi];
            // Derive overlay colour from the session hue
            const rgb = oklabToRgb255(0.78, 0.16 * f.cosH, 0.16 * f.sinH);
            const color = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.9)`;

            // Collect on-screen harmonic positions
            const pts = [];
            for (let h = 1; h <= 16; h++) {
                const pos = freqToCanvasXY(f.freq * h);
                if (pos) pts.push({ ...pos, h });
            }
            if (pts.length < 2) continue;

            // Connecting lines (dashed)
            ctx.save();
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.2;
            ctx.setLineDash([3, 5]);
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
            ctx.stroke();
            ctx.setLineDash([]);

            // Dots and labels
            ctx.textBaseline = "bottom";
            ctx.font = "bold 9px -apple-system, sans-serif";
            for (const p of pts) {
                const r = p.h === 1 ? 5 : 3;

                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
                ctx.fill();

                ctx.strokeStyle = "rgba(0,0,0,0.5)";
                ctx.lineWidth = 0.8;
                ctx.stroke();

                // Fundamental: show session label + note, overtones: harmonic number
                const label = p.h === 1 ? (f.label + ' ' + noteName(f.freq)) : String(p.h);
                ctx.fillStyle = color;
                ctx.fillText(label, p.x + r + 2, p.y - 2);
            }
            ctx.restore();
        }
    }

    // ═════════════════  DYNAMIC LEGEND  ════════════════════════════════

    let legendThrottle = 0;

    function updateLegend(detectedFunds) {
        if (!legendDiv) return;
        // Throttle to ~4 updates/sec (avoid DOM thrash)
        const now = performance.now();
        if (now - legendThrottle < 250) return;
        legendThrottle = now;

        legendDiv.innerHTML = '';

        if (colourMode === 'amplitude') {
            // Gradient bar from the amplitude heatmap stops
            const bar = document.createElement('span');
            bar.className = 'gradient-bar';
            const stops = STOPS.map(s => `rgb(${s[1]},${s[2]},${s[3]}) ${(s[0] * 100).toFixed(0)}%`).join(',');
            bar.style.background = `linear-gradient(to right, ${stops})`;
            const itemLo = mkItem('Quiet', null, bar);
            const itemHi = mkItem('Loud', null);
            legendDiv.appendChild(itemLo);
            legendDiv.appendChild(itemHi);
            return;
        }

        if (colourMode === 'centroid') {
            // Show centroid meaning: low → centre → high
            addSwatchItem('Energy below', centroidHueToRGB(-0.8));
            addSwatchItem('Balanced', [180, 180, 180]);
            addSwatchItem('Energy above', centroidHueToRGB(0.8));
            return;
        }

        if (colourMode === 'slope') {
            addSwatchItem('Steep (sine-like)', slopeHueToRGB(0));
            addSwatchItem('Moderate', slopeHueToRGB(0.5));
            addSwatchItem('Gradual (saw-like)', slopeHueToRGB(1));
            return;
        }

        if (colourMode === 'source') {
            addSwatchItem('Per-source colours — hover timeline to isolate', [140, 140, 140]);
            return;
        }

        if (colourMode === 'rank') {
            for (let h = 1; h <= 8; h++) {
                const H = ((h - 1) / 7) * Math.PI * 1.8;
                const rgb = oklabToRgb255(0.75, 0.14 * Math.cos(H), 0.14 * Math.sin(H));
                addSwatchItem(h === 1 ? '1st (fundamental)' : h + ordSuffix(h), rgb);
            }
            return;
        }

        if (colourMode === 'srcrank') {
            addSwatchItem('Hue = source (see panel →), Chroma = harmonic rank', [140, 140, 140]);
            return;
        }
    }

    function mkItem(text, rgb, customEl) {
        const item = document.createElement('span');
        item.className = 'legend-item';
        if (customEl) {
            item.appendChild(customEl);
        } else if (rgb) {
            const sw = document.createElement('span');
            sw.className = 'swatch';
            sw.style.background = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
            item.appendChild(sw);
        }
        const lbl = document.createElement('span');
        lbl.textContent = text;
        item.appendChild(lbl);
        return item;
    }

    function addSwatchItem(text, rgb) {
        legendDiv.appendChild(mkItem(text, rgb));
    }

    function centroidHueToRGB(offset) {
        const H = offset * Math.PI * 0.8 + Math.PI * 0.33;
        return oklabToRgb255(0.75, 0.14 * Math.cos(H), 0.14 * Math.sin(H));
    }

    function slopeHueToRGB(norm) {
        const H = (1 - norm) * Math.PI * 0.9 + Math.PI * 0.6;
        return oklabToRgb255(0.75, 0.13 * Math.cos(H), 0.13 * Math.sin(H));
    }

    function ordSuffix(n) {
        if (n === 2) return 'nd';
        if (n === 3) return 'rd';
        return 'th';
    }

    // ═════════════════  BOOT  ═════════════════════════════════════════
    init();
})();
