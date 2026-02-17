let matchData;     // Will store the currently displayed match data

let matchSpecifier = '20250116-M-Australian_Open-R64-Learner_Tien-Daniil_Medvedev';
let currentMatchId = matchSpecifier;

let JetBrainsMonoBold;
let dataLoaded = false;
let fullDataLoaded = false;

// Global variables used in visualization (initialized in parseMatchData)
let tennisMatch;
let currentScoresnake;

let scoresnakeSectionWidth; // Width allocated for the scoresnake chart (set in setup)

// Sound effect — pre-rendered ping buffers.
// Pitches snap to a pentatonic scale so rapid adjacent pings
// always sound harmonious (no dissonant semitones).
let _pingBuffers = {};  // keyed by frequency, lazily created

// Orbit controls for rally view
var _orbitAngle = 2 * Math.PI * (5 / 360);  // initial angle (5°)
var _orbitVScale = 0.5;  // vertical squash (pitch angle)
var _orbitDragging = false;
var _orbitDragStartX = 0;
var _orbitDragStartY = 0;
var _orbitDragStartAngle = 0;
var _orbitDragStartVScale = 0.5;
var _orbitRallyBox = null;  // set each frame to the rally bounding box

// Two octaves of C major pentatonic (C D E G A), spanning ~262–1047 Hz.
// Any pair of these notes sounds consonant together.
const _pentatonicFreqs = [
  261.6, 293.7, 329.6, 392.0, 440.0,   // C4 D4 E4 G4 A4
  523.3, 587.3, 659.3, 784.0, 880.0,   // C5 D5 E5 G5 A5
  1047                                   // C6
];

function _getOrCreatePingBuffer(ctx, freq) {
  let key = Math.round(freq);
  if (_pingBuffers[key]) return _pingBuffers[key];

  let sampleRate = ctx.sampleRate;
  let duration = 0.065;   // 65 ms — slightly longer for warmth at lower pitch
  let attack = 0.005;     // 5 ms fade-in
  let release = 0.055;    // 55 ms fade-out
  let hold = duration - attack - release;
  let len = Math.ceil(sampleRate * duration);
  let buf = ctx.createBuffer(1, len, sampleRate);
  let data = buf.getChannelData(0);
  let amp = 0.08;         // gentle volume — frequent sounds should be subtle

  for (let i = 0; i < len; i++) {
    let t = i / sampleRate;

    // Cosine-shaped envelope — rounder and more natural than linear
    let envelope;
    if (t < attack) {
      envelope = 0.5 * (1 - Math.cos(Math.PI * t / attack));          // smooth in
    } else if (t < attack + hold) {
      envelope = 1;
    } else {
      let fade = (t - attack - hold) / release;
      envelope = 0.5 * (1 + Math.cos(Math.PI * fade));                // smooth out
    }

    // Pure sine + a very quiet octave overtone for a bit of warmth
    let fundamental = Math.sin(2 * Math.PI * freq * t);
    let octave = Math.sin(2 * Math.PI * freq * 2 * t) * 0.12;
    data[i] = (fundamental + octave) * envelope * amp;
  }

  _pingBuffers[key] = buf;
  return buf;
}

function playHoverPing(pitchHint) {
  let ctx = getAudioContext();
  if (ctx.state !== 'running') return;

  // Map 0–1 to a pentatonic scale note
  let t = (pitchHint !== undefined) ? pitchHint : Math.random();
  let idx = Math.round(t * (_pentatonicFreqs.length - 1));
  let freq = _pentatonicFreqs[idx];

  let buf = _getOrCreatePingBuffer(ctx, freq);
  let src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
}

// ─── Game hover sound ───────────────────────────────────────────
// Deeper, slightly longer single tone — marks game boundaries.
// Same pentatonic scale shifted down one octave, with a touch of
// fifth-harmonic warmth to distinguish it from point pings.
let _gameBuffers = {};

function _getOrCreateGameBuffer(ctx, freq) {
  let key = Math.round(freq);
  if (_gameBuffers[key]) return _gameBuffers[key];

  let sampleRate = ctx.sampleRate;
  let duration = 0.11;     // 110 ms — noticeably longer than a point ping
  let attack = 0.008;
  let release = 0.09;
  let hold = duration - attack - release;
  let len = Math.ceil(sampleRate * duration);
  let buf = ctx.createBuffer(1, len, sampleRate);
  let data = buf.getChannelData(0);
  let amp = 0.06;

  for (let i = 0; i < len; i++) {
    let t = i / sampleRate;
    let envelope; if (t < attack) {
      envelope = 0.5 * (1 - Math.cos(Math.PI * t / attack));
    } else if (t < attack + hold) {
      envelope = 1;
    } else {
      let fade = (t - attack - hold) / release;
      envelope = 0.5 * (1 + Math.cos(Math.PI * fade));
    }
    let fundamental = Math.sin(2 * Math.PI * freq * t);
    let octave = Math.sin(2 * Math.PI * freq * 2 * t) * 0.15;
    let fifth = Math.sin(2 * Math.PI * freq * 1.5 * t) * 0.08;
    data[i] = (fundamental + octave + fifth) * envelope * amp;
  }

  _gameBuffers[key] = buf;
  return buf;
}

function playGameHoverPing(pitchHint) {
  let ctx = getAudioContext();
  if (ctx.state !== 'running') return;

  let t = (pitchHint !== undefined) ? pitchHint : Math.random();
  let idx = Math.round(t * (_pentatonicFreqs.length - 1));
  let freq = _pentatonicFreqs[idx] / 2;   // one octave below point pings

  let buf = _getOrCreateGameBuffer(ctx, freq);
  let src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
}

// ─── Set hover sound ────────────────────────────────────────────
// Warm pentatonic chord (root + 3rd + 6th) shifted one octave down —
// marks set boundaries.  Three voices sum to a gentle, consonant pad.
let _setBuffers = {};

function _getOrCreateSetBuffer(ctx, freqs) {
  let key = freqs.map(f => Math.round(f)).join('_');
  if (_setBuffers[key]) return _setBuffers[key];

  let sampleRate = ctx.sampleRate;
  let duration = 0.22;     // 220 ms — lingers longer than game or point
  let attack = 0.015;
  let release = 0.18;
  let hold = duration - attack - release;
  let len = Math.ceil(sampleRate * duration);
  let buf = ctx.createBuffer(1, len, sampleRate);
  let data = buf.getChannelData(0);
  let amp = 0.035;         // per voice — 3 voices ≈ 0.105 peak

  for (let i = 0; i < len; i++) {
    let t = i / sampleRate;
    let envelope;
    if (t < attack) {
      envelope = 0.5 * (1 - Math.cos(Math.PI * t / attack));
    } else if (t < attack + hold) {
      envelope = 1;
    } else {
      let fade = (t - attack - hold) / release;
      envelope = 0.5 * (1 + Math.cos(Math.PI * fade));
    }
    let sample = 0;
    for (let freq of freqs) {
      sample += Math.sin(2 * Math.PI * freq * t);
      sample += Math.sin(2 * Math.PI * freq * 2 * t) * 0.1;
    }
    data[i] = sample * envelope * amp;
  }

  _setBuffers[key] = buf;
  return buf;
}

function playSetHoverPing(pitchHint) {
  let ctx = getAudioContext();
  if (ctx.state !== 'running') return;

  let t = (pitchHint !== undefined) ? pitchHint : Math.random();
  let idx = Math.round(t * (_pentatonicFreqs.length - 1));

  // Triad from pentatonic: root + 2 steps + 4 steps, all one octave down.
  // e.g. C4→E4→A4 becomes C3→E3→A3 — a gentle Am-family voicing.
  let root = _pentatonicFreqs[idx] / 2;
  let third = _pentatonicFreqs[Math.min(idx + 2, _pentatonicFreqs.length - 1)] / 2;
  let fifth = _pentatonicFreqs[Math.min(idx + 4, _pentatonicFreqs.length - 1)] / 2;

  let buf = _getOrCreateSetBuffer(ctx, [root, third, fifth]);
  let src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
}

function mousePressed() {
  // Resume audio context on first click (browser requirement)
  let ctx = getAudioContext();
  if (ctx.state === 'suspended') ctx.resume();

  // Orbit drag: start if mouse is inside the rally box
  if (_orbitRallyBox) {
    let b = _orbitRallyBox;
    if (mouseX >= b.x && mouseX <= b.x + b.w && mouseY >= b.y && mouseY <= b.y + b.h) {
      _orbitDragging = true;
      _orbitDragStartX = mouseX;
      _orbitDragStartY = mouseY;
      _orbitDragStartAngle = _orbitAngle;
      _orbitDragStartVScale = _orbitVScale;
    }
  }
}

function mouseDragged() {
  if (_orbitDragging) {
    let dx = mouseX - _orbitDragStartX;
    let dy = mouseY - _orbitDragStartY;
    _orbitAngle = _orbitDragStartAngle + dx * 0.005;
    // Vertical drag changes pitch (vScale): dragging up = more top-down, down = more oblique
    _orbitVScale = constrain(_orbitDragStartVScale - dy * 0.003, 0.15, 0.85);
  }
}

function mouseReleased() {
  _orbitDragging = false;
}

function preload() {
  // Only load the font in preload - load CSV async later
  JetBrainsMonoBold = loadFont('JetBrainsMono-Bold.ttf',
    () => { }, // success callback
    () => { JetBrainsMonoBold = null; } // error callback - use default font
  );

  // Load just the default match data synchronously for immediate display
  matchData = loadTable('tien versus medvedev.csv', 'csv', 'header');
}

function setup() {

  window.currentSelectedMatch = null;
  window.currentlyDisplayedMatch = null;

  // Canvas sized to actual sketch-pane width (respects pane-collapsed state)
  let sketchPaneEl = document.getElementById('sketch-pane');
  let initWidth = sketchPaneEl ? sketchPaneEl.clientWidth : windowWidth;
  let canvas = createCanvas(initWidth, windowHeight);
  canvas.parent('sketch-pane');

  scoresnakeSectionWidth = width * 0.6;
  matchX = scoresnakeSectionWidth / 2, matchY = 50;


  // Parse and display the default match immediately
  parseMatchData();

  // Determine if this is best of 3 or best of 5
  let maxSetsWon = Math.max(tennisMatch.setsWon[1], tennisMatch.setsWon[2]);
  SETS_TO_WIN_MATCH = maxSetsWon; // 2 for best of 3, 3 for best of 5

  // ScoresnakeChart will be created in draw() when needed
  dataLoaded = true;

  // Set up tab switching
  setupTabs();

  // Set up color picker and theme controls
  initColorPicker();
  initAccentViewport();
  initThemeControls();

  // Set up basic search interface with loading message
  setupSearchInterfaceLoading();

  // Update progress to show download is starting
  updateProgress(0, 'Starting download of match databases...');

  // Load all CSV files
  loadAllMatchData();
}

function loadMatch(matchId, options = { setCurrent: true }) {
  try {

    if (options.setCurrent) {
      matchSpecifier = matchId;
      currentMatchId = matchId;
      // Also track for preview system
      window.currentSelectedMatch = matchId;
      window.currentlyDisplayedMatch = matchId;
    }

    // Load match data lazily from CSV
    loadMatchById(matchId, function () {

      // Check if we have valid match data
      if (matchData.getRowCount() === 0) {
        console.error('No data found for match:', matchId);
        return; // Skip if no data found
      }

      // Parse the match data into an easily accessible object
      parseMatchData();

      // Check if parsing was successful
      if (!tennisMatch || !tennisMatch.sets || tennisMatch.sets.length === 0) {
        console.error('Parsing failed for match:', matchId, 'tennisMatch:', tennisMatch);
        return; // Skip if parsing failed
      }

      // Determine if this is best of 3 or best of 5
      let maxSetsWon = Math.max(tennisMatch.setsWon[1], tennisMatch.setsWon[2]);
      SETS_TO_WIN_MATCH = maxSetsWon; // 2 for best of 3, 3 for best of 5

      // Create new scoresnake visualization
      currentScoresnake = new ScoresnakeChart(tennisMatch);

      if (options.setCurrent) {
        updateMatchDisplay(matchId);
      }

      // Redraw (works even when noLoop() is active)
      if (dataLoaded) {
        redraw();
      }
    });
  } catch (e) {
    // Enhanced error logging
    console.error('Error loading match ' + matchId + ':', e);
    console.error('Stack trace:', e.stack);
  }
}


var matchX;
var matchY;
let scaleFactor;

POINTS_TO_WIN_GAME = 4;
GAMES_TO_WIN_SET = 6;
SETS_TO_WIN_MATCH = 3;

let pointSquareSize = 5;

let gameGap = pointSquareSize;
let gameSize = pointSquareSize * POINTS_TO_WIN_GAME;
let gameSizePlusGap = gameSize + gameGap;

let setSize = gameSizePlusGap * GAMES_TO_WIN_SET - gameGap;
let setGap = pointSquareSize * 4 + gameGap;
let setSizePlusGap = setSize + setGap;

let timelineHeight = 150;

let matchSize = setSizePlusGap * SETS_TO_WIN_MATCH;

let pointScoreText = ["0", "15", "30", "40"];

// Axis mapping for players
let pAxes = {
  1: "y",
  2: "x"
}

function axisToPlayer(axis) {
  return Number(
    Object.keys(pAxes).find(player => pAxes[player] === axis)
  );
}

POINT_WON_AGAINST_SERVE = "against serve";
POINT_WON_ON_SERVE = "on serve";

INACTIVE = "inactive";
ACTIVE_SET = "active set";
ACTIVE_GAME = "active game";

// --- OKLCH → sRGB conversion ---
function oklchToRgb(L, C, h) {
  let hRad = h * Math.PI / 180;
  let a = C * Math.cos(hRad);
  let b = C * Math.sin(hRad);
  let l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  let m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  let s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  let l = l_ * l_ * l_;
  let m = m_ * m_ * m_;
  let s = s_ * s_ * s_;
  let r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  let g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  let bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  r = r <= 0.0031308 ? 12.92 * r : 1.055 * Math.pow(Math.max(0, r), 1 / 2.4) - 0.055;
  g = g <= 0.0031308 ? 12.92 * g : 1.055 * Math.pow(Math.max(0, g), 1 / 2.4) - 0.055;
  bl = bl <= 0.0031308 ? 12.92 * bl : 1.055 * Math.pow(Math.max(0, bl), 1 / 2.4) - 0.055;
  return {
    r: Math.round(Math.max(0, Math.min(1, r)) * 255),
    g: Math.round(Math.max(0, Math.min(1, g)) * 255),
    b: Math.round(Math.max(0, Math.min(1, bl)) * 255)
  };
}
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}
// Convert sRGB (0-255) to OKLab
function srgbToOklab(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  r = r <= 0.04045 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4);
  g = g <= 0.04045 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4);
  b = b <= 0.04045 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4);
  let l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  let m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  let s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  l = Math.cbrt(l); m = Math.cbrt(m); s = Math.cbrt(s);
  return {
    L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
  };
}
// Check if OKLCH (L, C, hue) maps to a valid sRGB color (all channels in [0, 1])
function oklchInGamut(L, C, h) {
  let hRad = h * Math.PI / 180;
  let a = C * Math.cos(hRad);
  let b = C * Math.sin(hRad);
  let l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  let m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  let s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  let l = l_ * l_ * l_;
  let m = m_ * m_ * m_;
  let s = s_ * s_ * s_;
  let r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  let g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  let bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  // Check linear RGB before gamma (more precise gamut boundary)
  return r >= -0.001 && r <= 1.001 && g >= -0.001 && g <= 1.001 && bl >= -0.001 && bl <= 1.001;
}
// Cast a ray from (L0,a0,b0) in direction (dL,da,db) and find where it first enters the sRGB gamut.
// Build the Pareto surface by sampling the gamut boundary on a (hue, L) grid.
// For each grid point, the best achievable chroma is min(C_ideal, maxChroma(L, h)).
// Pareto dominance is computed over (|ΔL|, |ΔC|, |Δh|) objectives.
function buildParetoSurface(selH1d) {
  let L_id = _stripBrightLC[selH1d].L;
  let C_id = _stripBrightLC[selH1d].C;
  let h_id = (selH1d + 180) % 360;
  let idealInGamut = C_id <= maxChroma(L_id, h_id) + 0.001;

  // Ideal point in OKLab for distance computation
  let hIdRad = h_id * Math.PI / 180;
  let a_id = C_id * Math.cos(hIdRad);
  let b_id = C_id * Math.sin(hIdRad);

  let hSteps = 72, lSteps = 40;
  let grid = [];  // grid[hi][li]
  let allPts = [];
  let maxDist = 0;

  for (let hi = 0; hi < hSteps; hi++) {
    let row = [];
    let h = hi * 360 / hSteps;
    for (let li = 0; li <= lSteps; li++) {
      let L = li / lSteps;
      let Cmax = maxChroma(L, h);
      if (Cmax < 0.001 && C_id < 0.001) { row.push(null); continue; }
      // Best achievable chroma at this (L, h): move toward C_ideal but stay in gamut
      let C = Math.min(C_id, Cmax);
      if (C < 0.001) C = 0;

      let objL = Math.abs(L - L_id);
      let objC = Math.max(0, C_id - Cmax);  // 0 if Cmax >= C_id (C_ideal is achievable)
      let rawDh = Math.abs(h - h_id);
      let objH = Math.min(rawDh, 360 - rawDh);

      // OKLab Euclidean distance from ideal
      let hRad = h * Math.PI / 180;
      let a = C * Math.cos(hRad), b = C * Math.sin(hRad);
      let dist = Math.sqrt((L - L_id) ** 2 + (a - a_id) ** 2 + (b - b_id) ** 2);

      let pt = { L: L, C: C, h: h, objL: objL, objC: objC, objH: objH, dist: dist, pareto: true };
      row.push(pt);
      allPts.push(pt);
      if (dist > maxDist) maxDist = dist;
    }
    grid.push(row);
  }

  // Pareto dominance filtering
  for (let i = 0; i < allPts.length; i++) {
    let a = allPts[i];
    if (!a.pareto) continue;
    for (let j = 0; j < allPts.length; j++) {
      if (i === j) continue;
      let b = allPts[j];
      if (b.objL <= a.objL && b.objC <= a.objC && b.objH <= a.objH &&
        (b.objL < a.objL || b.objC < a.objC || b.objH < a.objH)) {
        a.pareto = false;
        break;
      }
    }
  }

  // Find three extreme vertices and nearest Pareto point
  let bestDL = Infinity, bestDC = Infinity, bestDH = Infinity;
  let vertexL = null, vertexC = null, vertexH = null;
  let nearestDist = Infinity, nearestPt = null;
  for (let i = 0; i < allPts.length; i++) {
    let p = allPts[i];
    if (!p.pareto) continue;
    if (p.objL < bestDL) { bestDL = p.objL; vertexL = p; }
    if (p.objC < bestDC) { bestDC = p.objC; vertexC = p; }
    if (p.objH < bestDH) { bestDH = p.objH; vertexH = p; }
    if (p.dist < nearestDist) { nearestDist = p.dist; nearestPt = p; }
  }

  _raySurfaceCache = {
    h1: selH1d, pts: grid, idealInGamut: idealInGamut, maxDist: maxDist,
    idealL: L_id, idealC: C_id, idealH: h_id,
    thetaSteps: hSteps, phiSteps: lSteps,
    vertexL: vertexL, vertexC: vertexC, vertexH: vertexH,
    nearestPt: nearestPt
  };
}

// Find best P2 within the volume constraints (deltaL, deltaC, deltaH)
// Returns the Pareto surface point nearest to ideal that satisfies all three constraints
function findBestP2InVolume(selH1d) {
  let sc = _raySurfaceCache;
  if (!sc.pts || sc.h1 !== selH1d) return null;
  let allPts = [];
  for (let hi = 0; hi < sc.thetaSteps; hi++)
    for (let li = 0; li <= sc.phiSteps; li++)
      if (sc.pts[hi][li]) allPts.push(sc.pts[hi][li]);

  let bestDist = Infinity, bestPt = null;
  for (let i = 0; i < allPts.length; i++) {
    let p = allPts[i];
    // Check volume constraints
    if (p.objL > _p2MaxDeltaL) continue;
    if (p.objC > _p2MaxDeltaC) continue;
    if (p.objH > _p2MaxDeltaH) continue;
    if (p.dist < bestDist) { bestDist = p.dist; bestPt = p; }
  }
  return bestPt;
}

// Binary search for maximum in-gamut chroma at given L and hue
function maxChroma(L, hue) {
  let lo = 0, hi = 0.4;
  for (let i = 0; i < 20; i++) {
    let mid = (lo + hi) / 2;
    if (oklchInGamut(L, mid, hue)) lo = mid; else hi = mid;
  }
  return lo;
}
// Max chroma that works for BOTH a hue and its complement (180° opposite)
function pairChroma(L, hue) {
  return Math.min(maxChroma(L, hue), maxChroma(L, (hue + 180) % 360));
}
// Per-pair optimized L: each complementary pair (h, h+180) independently
// finds the L that maximizes pairChroma. No global L constraint — each
// pair gets maximum saturation without dragging others down.
var _brightL = 0.65, _darkL = 0.38;  // mean values, updated by precomputeLC
var _brightLC = new Array(360);
var _darkLC = new Array(360);
(function precomputeLC() {
  for (let h = 0; h < 180; h++) {
    let h2 = (h + 180) % 360;
    // Bright: find L in [0.50, 0.80] maximizing pairChroma(L, h)
    let bestBL = 0.65, bestBC = 0;
    for (let L = 0.50; L <= 0.80; L += 0.005) {
      let pc = pairChroma(L, h);
      if (pc > bestBC) { bestBC = pc; bestBL = L; }
    }
    // Dark: find L in [0.25, 0.45] maximizing pairChroma(L, h)
    let bestDL = 0.35, bestDC = 0;
    for (let L = 0.25; L <= 0.45; L += 0.005) {
      let pc = pairChroma(L, h);
      if (pc > bestDC) { bestDC = pc; bestDL = L; }
    }
    // Ensure bright-dark gap >= 0.18 for each pair
    if (bestBL - bestDL < 0.18) {
      let mid = (bestBL + bestDL) / 2;
      bestBL = Math.min(0.80, mid + 0.09);
      bestDL = Math.max(0.25, mid - 0.09);
      bestBC = pairChroma(bestBL, h);
      bestDC = pairChroma(bestDL, h);
    }
    _brightLC[h] = { L: bestBL, C: bestBC };
    _brightLC[h2] = { L: bestBL, C: bestBC };
    _darkLC[h] = { L: bestDL, C: bestDC };
    _darkLC[h2] = { L: bestDL, C: bestDC };
  }
  // Mean L for reference
  let sB = 0, sD = 0;
  for (let h = 0; h < 360; h++) { sB += _brightLC[h].L; sD += _darkLC[h].L; }
  _brightL = sB / 360; _darkL = sD / 360;
})();
// Strip-specific: per-hue independent max chroma (no pair constraint).
// Each hue finds its own best L for maximum sRGB-gamut chroma independently.
var _stripBrightLC = new Array(360);
var _stripDarkLC = new Array(360);
var _stripDarkDeltaL = 0.19;  // constant lightness drop from bright to dark
(function precomputeStripLC() {
  // First pass: compute bright frontier
  for (let h = 0; h < 360; h++) {
    let bestL = 0.65, bestC = 0;
    for (let L = 0.55; L <= 0.92; L += 0.002) {
      let c = maxChroma(L, h);
      if (c > bestC) { bestC = c; bestL = L; }
    }
    _stripBrightLC[h] = { L: bestL, C: bestC };
  }
  // Second pass: dark = bright - constant deltaL, maximize chroma at that L
  for (let h = 0; h < 360; h++) {
    let darkL = Math.max(0.15, _stripBrightLC[h].L - _stripDarkDeltaL);
    let darkC = maxChroma(darkL, h);
    _stripDarkLC[h] = { L: darkL, C: darkC };
  }
})();
// Perceptually-spaced strip hues: redistribute 36 stops at equal OKLAB arc length
var _stripHues = new Array(36);
(function computeStripHues() {
  // Compute OKLAB (L, a, b) for each 1-degree hue at strip bright settings
  let labs = [];
  for (let h = 0; h < 360; h++) {
    let lc = _stripBrightLC[h];
    let hRad = h * Math.PI / 180;
    labs.push({
      L: lc.L,
      a: lc.C * Math.cos(hRad),
      b: lc.C * Math.sin(hRad),
      hue: h
    });
  }
  // Cumulative perceptual arc length around the wheel
  let cumLen = [0];
  for (let i = 1; i < 360; i++) {
    let dL = labs[i].L - labs[i - 1].L;
    let da = labs[i].a - labs[i - 1].a;
    let db = labs[i].b - labs[i - 1].b;
    cumLen.push(cumLen[i - 1] + Math.sqrt(dL * dL + da * da + db * db));
  }
  // Close the loop (359 -> 0)
  let dL = labs[0].L - labs[359].L;
  let da = labs[0].a - labs[359].a;
  let db = labs[0].b - labs[359].b;
  let totalLen = cumLen[359] + Math.sqrt(dL * dL + da * da + db * db);
  // Place 36 stops at equal arc-length intervals
  let stepLen = totalLen / 36;
  let j = 0;
  for (let i = 0; i < 36; i++) {
    let target = i * stepLen;
    while (j < 358 && cumLen[j + 1] < target) j++;
    // Linear interpolation between j and j+1
    if (j >= 359) {
      _stripHues[i] = Math.round(labs[j].hue);
    } else {
      let frac = (cumLen[j + 1] > cumLen[j]) ? (target - cumLen[j]) / (cumLen[j + 1] - cumLen[j]) : 0;
      _stripHues[i] = Math.round(labs[j].hue + frac);
    }
  }
})();
// Strip tradeoff: minimum required hue contrast (0° = no constraint, 180° = perfect complement)
var _stripTradeoff = 180;
var _stripSacrificeMode = 2; // 0 = chroma only, 1 = chroma+L, 2 = surface (free pick)
var _stripSacrificeBoth = true; // derived: true when mode >= 1
var _surfaceP2L = 0.5;  // surface mode: P2 lightness (free pick)
var _surfaceP2C = 0.15; // surface mode: P2 chroma (free pick)
// Pareto surface cache: { h1: int, pts: [[{L,C,h,dist}]], idealInGamut: bool, maxDist: number }
var _raySurfaceCache = { h1: -1, pts: null, idealInGamut: false, maxDist: 0 };
var _paretoAnimating = false;
var _paretoAnimStart = 0;
var _paretoAnimDuration = 8000; // ms (slow expansion)
var _stripSwapped = false;       // true = swap which player gets which strip color
var _stripPerHueTradeoff = new Array(36).fill(180); // per-column tradeoff sliders
// Lab viewport visibility toggles
var _labGamutMode = 0;  // 0=hidden, 1=outline (silhouette), 2=translucent, 3=opaque
var _labShowSurface = true;
var _labShowFrontier = true;
var _labShowDark = true;
var _labShowIdeal = false;
var _labShowClosest = false;
var _labShowMaxChromaRing = false;  // gamut boundary at P1's L
var _labShowConstChromaRing = false; // constant-chroma circle at P1's C
var _labHoverToggle = null;  // which toggle key is hovered
var _labHoverCurve = null;   // which curve the mouse is near: 'frontier','dark','ideal','closest'
var _labMouseX = 0;          // mouse position in canvas coords for hover labels
var _labMouseY = 0;
// P2 volume extent sliders (max allowable deviation from ideal)
var _p2MaxDeltaL = 1.0;   // 0..1 — max L deviation from ideal
var _p2MaxDeltaC = 1.0;   // 0..1 — max C deficit from ideal (normalized)
var _p2MaxDeltaH = 180;   // 0..180 — max hue deviation from ideal
// Precompute gamut boundary profiles for polar view
// For each hue h (0..359), store maxChroma at 80 L levels from 0 to 1
var _gamutProfileSteps = 80;
var _gamutProfileLC = [];
var _absoluteMaxC = new Float32Array(360);
(function precomputeGamutProfiles() {
  for (var h = 0; h < 360; h++) {
    var profile = new Float32Array(_gamutProfileSteps);
    var mc = 0;
    for (var i = 0; i < _gamutProfileSteps; i++) {
      var L = i / (_gamutProfileSteps - 1);
      profile[i] = maxChroma(L, h);
      if (profile[i] > mc) mc = profile[i];
    }
    _gamutProfileLC.push(profile);
    _absoluteMaxC[h] = mc;
  }
})();
// Full max-chroma frontier: for each hue, find L that maximizes chroma across ALL L values
// (no pairing constraint — used for frontier curve display only, not swatch positions)
var _fullBrightLC = new Array(360);
var _fullDarkLC = new Array(360);
(function precomputeFullLC() {
  let minI = Math.ceil(0.35 * (_gamutProfileSteps - 1)); // L >= 0.35 to avoid pedestal
  for (let h = 0; h < 360; h++) {
    let bestL = 0.5, bestC = 0;
    let prof = _gamutProfileLC[h];
    for (let i = minI; i < _gamutProfileSteps; i++) {
      if (prof[i] > bestC) { bestC = prof[i]; bestL = i / (_gamutProfileSteps - 1); }
    }
    _fullBrightLC[h] = { L: bestL, C: bestC };
    let darkL = Math.max(0.05, bestL - _stripDarkDeltaL);
    let darkC = maxChroma(darkL, h);
    _fullDarkLC[h] = { L: darkL, C: darkC };
  }
})();
function maxLightness(C, h) {
  if (C < 0.001) return 0.99;
  var hInt = ((Math.round(h) % 360) + 360) % 360;
  var profile = _gamutProfileLC[hInt];
  for (var i = _gamutProfileSteps - 1; i >= 0; i--) {
    if (profile[i] >= C) return i / (_gamutProfileSteps - 1);
  }
  return -1;
}
function minLightness(C, h) {
  if (C < 0.001) return 0.01;
  var hInt = ((Math.round(h) % 360) + 360) % 360;
  var profile = _gamutProfileLC[hInt];
  for (var i = 0; i < _gamutProfileSteps; i++) {
    if (profile[i] >= C) return i / (_gamutProfileSteps - 1);
  }
  return -1;
}
// Compute best P2 hue for a given P1 hue and minimum contrast requirement.
// Returns { h2, L2, C2, deficit } where:
//   h2 = P2 hue with minimum deficit among all hues with angDist >= minContrast
//   L2 = P2 lightness (= P1's L in C-only mode, P2's own optimal L in both mode)
//   C2 = P2 chroma (clamped to gamut)
//   deficit = sacrifice metric (C-only: chroma loss; both: Euclidean L+C distance)
function computeStripP2(h1, minContrast) {
  let L1 = _stripBrightLC[h1].L;
  let C1 = _stripBrightLC[h1].C;
  let bestH2 = (h1 + 180) % 360, bestDef = Infinity, bestL2 = L1, bestC2 = 0;
  for (let h2 = 0; h2 < 360; h2++) {
    let ang = Math.min(Math.abs(h2 - h1), 360 - Math.abs(h2 - h1));
    if (ang < minContrast) continue;
    if (_stripSacrificeBoth) {
      // Search over L to find the point on the gamut boundary closest to P1's (L,C)
      for (let li = 0; li <= 40; li++) {
        let L2 = 0.20 + li * 0.70 / 40;
        let C2 = maxChroma(L2, h2);
        let def = Math.sqrt((L1 - L2) ** 2 + (C1 - C2) ** 2);
        if (def < bestDef) { bestDef = def; bestH2 = h2; bestL2 = L2; bestC2 = C2; }
      }
    } else {
      let def = Math.max(0, C1 - maxChroma(L1, h2));
      if (def < bestDef) { bestDef = def; bestH2 = h2; bestL2 = L1; bestC2 = Math.min(C1, maxChroma(L1, h2)); }
    }
  }
  return { h2: bestH2, L2: bestL2, C2: bestC2, deficit: bestDef };
}
// Compute dark-variant P2: offset L by deltaL (0.28) from bright P2's L
function computeStripP2Dark(h1, h2bright, brightL2) {
  if (_stripSacrificeBoth) {
    // Use the bright P2's L minus deltaL constant
    let darkL = Math.max(0, (brightL2 !== undefined ? brightL2 : _stripBrightLC[((h2bright % 360) + 360) % 360].L) - 0.28);
    let darkC = maxChroma(darkL, h2bright);
    return { L: darkL, C: darkC };
  }
  let L1 = _stripDarkLC[h1].L;
  let C1 = _stripDarkLC[h1].C;
  let C2 = Math.min(C1, maxChroma(L1, h2bright));
  return { L: L1, C: C2 };
}
// Pareto frontier for graph: for each contrast level (0–180), what’s the minimum chroma deficit?
function computePareto(h1) {
  let L1 = _stripBrightLC[h1].L;
  let C1 = _stripBrightLC[h1].C;
  // Min deficit at each exact angular distance
  let bestAtDist = new Float32Array(181).fill(Infinity);
  let bestH2AtDist = new Int16Array(181);
  let bestL2AtDist = new Float32Array(181).fill(L1);
  let bestC2AtDist = new Float32Array(181);
  for (let h2 = 0; h2 < 360; h2++) {
    let ang = Math.min(Math.abs(h2 - h1), 360 - Math.abs(h2 - h1));
    if (_stripSacrificeBoth) {
      // Search over L to find closest gamut-boundary point to P1's (L,C)
      for (let li = 0; li <= 40; li++) {
        let L2 = 0.20 + li * 0.70 / 40;
        let C2 = maxChroma(L2, h2);
        let def = Math.sqrt((L1 - L2) ** 2 + (C1 - C2) ** 2);
        if (def < bestAtDist[ang]) {
          bestAtDist[ang] = def;
          bestH2AtDist[ang] = h2;
          bestL2AtDist[ang] = L2;
          bestC2AtDist[ang] = C2;
        }
      }
    } else {
      let def = Math.max(0, C1 - maxChroma(L1, h2));
      if (def < bestAtDist[ang]) {
        bestAtDist[ang] = def;
        bestH2AtDist[ang] = h2;
        bestL2AtDist[ang] = L1;
        bestC2AtDist[ang] = Math.min(C1, maxChroma(L1, h2));
      }
    }
  }
  // Sweep from 180 to 0: running minimum (as you relax contrast, deficit can only improve)
  let frontier = new Array(181);
  let runMin = Infinity, runH2 = (h1 + 180) % 360, runL2 = L1, runC2 = 0;
  for (let x = 180; x >= 0; x--) {
    if (bestAtDist[x] <= runMin) {
      runMin = bestAtDist[x];
      runH2 = bestH2AtDist[x];
      runL2 = bestL2AtDist[x];
      runC2 = bestC2AtDist[x];
    }
    frontier[x] = { deficit: runMin, h2: runH2, L2: runL2, C2: runC2 };
  }
  return frontier;
}
// Ring shape (0..1 normalized chroma profile) + rotation to orient long axis vertically
var _ringShape = new Float32Array(360);
var _shapeRot = 0;  // degrees added when converting hue → visual position
(function computeRingShapeAndRotation() {
  for (let h = 0; h < 360; h++) _ringShape[h] = _brightLC[h].C;
  // Smooth 4 passes with 5° moving average for organic curve
  for (let iter = 0; iter < 4; iter++) {
    let tmp = new Float32Array(360);
    for (let h = 0; h < 360; h++) {
      let sum = 0;
      for (let d = -2; d <= 2; d++) sum += _ringShape[(h + d + 360) % 360];
      tmp[h] = sum / 5;
    }
    _ringShape = tmp;
  }
  let mn = Infinity, mx = 0;
  for (let h = 0; h < 360; h++) {
    mn = Math.min(mn, _ringShape[h]);
    mx = Math.max(mx, _ringShape[h]);
  }
  for (let h = 0; h < 360; h++) _ringShape[h] = (_ringShape[h] - mn) / (mx - mn);
  // Find long axis: maximize shape[h] + shape[h+180], orient vertically
  let bestAxis = 0, bestSum = 0;
  for (let h = 0; h < 180; h++) {
    let sum = _ringShape[h] + _ringShape[(h + 180) % 360];
    if (sum > bestSum) { bestSum = sum; bestAxis = h; }
  }
  _shapeRot = -bestAxis;
})();
function hueToHex(hue, dark, refHue) {
  let h = ((Math.round(hue) % 360) + 360) % 360;
  let lc;
  if (_displayMode === 'strip' || _displayMode === 'lab') {
    // refHue: use refHue's L,C (for P2 matching P1's brightness/chroma)
    let lookupH = (refHue !== undefined) ? ((Math.round(refHue) % 360) + 360) % 360 : h;
    lc = dark ? _stripDarkLC[lookupH] : _stripBrightLC[lookupH];
    // Clamp C to gamut at the actual display hue
    let mc = maxChroma(lc.L, hue);
    let c = oklchToRgb(lc.L, Math.min(lc.C, mc), hue);
    return rgbToHex(c.r, c.g, c.b);
  } else {
    lc = dark ? _darkLC[h] : _brightLC[h];
  }
  let c = oklchToRgb(lc.L, lc.C, hue);
  return rgbToHex(c.r, c.g, c.b);
}

// Player hues (OKLCH hue degrees)
var _playerHue1 = 328;   // default: magenta-ish
var _playerHue2 = 148;   // complementary: green
var _colorPickerLocked = true;

function updateColorScheme() {
  // In strip mode, _playerHue2 is always derived from _playerHue1.
  // _stripSwapped controls which player wears which color.
  // derivedRef tells hueToHex to use P1's L (chroma-only mode) for the derived hue.
  let isStripLike = (_displayMode === 'strip' || _displayMode === 'lab');
  let derivedRef = (isStripLike && !_stripSacrificeBoth) ? _playerHue1 : undefined;
  let swap = (isStripLike && _stripSwapped);
  let h1eff = swap ? _playerHue2 : _playerHue1;
  let h2eff = swap ? _playerHue1 : _playerHue2;
  let r1 = swap ? derivedRef : undefined;
  let r2 = swap ? undefined : derivedRef;
  colorScheme[1] = hueToHex(h1eff, false, r1);
  // Surface mode: P2 uses stored L/C directly
  if (isStripLike && _stripSacrificeMode === 2) {
    let p2rgb = oklchToRgb(_surfaceP2L, _surfaceP2C, h2eff);
    colorScheme[2] = rgbToHex(p2rgb.r, p2rgb.g, p2rgb.b);
    // Dark variant: reduce L by deltaL constant (0.28)
    let darkL = Math.max(0, _surfaceP2L - 0.28);
    let darkC = Math.min(_surfaceP2C, maxChroma(darkL, h2eff));
    let p2dRgb = oklchToRgb(darkL, darkC, h2eff);
    let p2dHex = rgbToHex(p2dRgb.r, p2dRgb.g, p2dRgb.b);
    pointSquareColorScheme[POINT_WON_ON_SERVE] = {
      1: hueToHex(h1eff, true, r1),
      2: p2dHex
    };
  } else {
    colorScheme[2] = hueToHex(h2eff, false, r2);
    pointSquareColorScheme[POINT_WON_ON_SERVE] = {
      1: hueToHex(h1eff, true, r1),
      2: hueToHex(h2eff, true, r2)
    };
  }
  pointSquareColorScheme[POINT_WON_AGAINST_SERVE] = {
    1: colorScheme[1],
    2: colorScheme[2]
  };
}

colorScheme = { 1: "#ff00f2", 2: "#0cdc58" };
pointSquareColorScheme = {
  [INACTIVE]: "#202020",
  [ACTIVE_SET]: "#505050",
  [ACTIVE_GAME]: "#8f8f8f",
  [POINT_WON_ON_SERVE]: { 1: "#A423B7", 2: "#00A300" },
  [POINT_WON_AGAINST_SERVE]: { 1: "#ff00f2", 2: "#0cdc58" }
};
updateColorScheme();  // set initial colors from OKLCH

// ──── Accent hue management ────
var _accentHue = 155;  // default green (≈ #4ade80)
var _accentFrontierCache = null;  // cached frontier array for current theme
function setAccentHue(hue) {
  _accentHue = hue;
  let root = document.documentElement.style;
  // Get the frontier L/C for this hue (or compute fallback)
  let fp = null;
  if (_accentFrontierCache && _accentFrontierCache[hue]) {
    fp = _accentFrontierCache[hue];
  } else {
    // Compute inline if cache not yet available
    let bg = getThemeBgRgb();
    let fg = getThemeFgRgb();
    let tmp = computeAccentFrontier(bg, fg);
    _accentFrontierCache = tmp;
    fp = tmp[hue];
  }
  let baseL = fp.L, baseC = fp.C;
  function accentAt(L, capC) {
    let c = oklchToRgb(L, Math.min(capC, maxChroma(L, hue)), hue);
    return rgbToHex(c.r, c.g, c.b);
  }
  function accentRgba(L, capC, a) {
    let c = oklchToRgb(L, Math.min(capC, maxChroma(L, hue)), hue);
    return `rgba(${c.r},${c.g},${c.b},${a})`;
  }
  // Derive accent variants from the frontier's optimal L/C
  root.setProperty('--accent', accentAt(baseL, baseC));
  root.setProperty('--accent-dim', accentAt(Math.max(0.2, baseL - 0.27), baseC * 0.7));
  root.setProperty('--accent-mid', accentAt(Math.max(0.25, baseL - 0.17), baseC * 0.85));
  root.setProperty('--accent-dark', accentAt(Math.max(0.15, baseL - 0.55), baseC * 0.4));
  root.setProperty('--accent-bg', accentAt(Math.max(0.15, baseL - 0.55), baseC * 0.3));
  root.setProperty('--accent-bg-hover', accentAt(Math.max(0.18, baseL - 0.45), baseC * 0.4));
  root.setProperty('--accent-border', accentAt(Math.max(0.2, baseL - 0.42), baseC * 0.45));
  root.setProperty('--accent-text', accentAt(Math.min(0.95, baseL + 0.08), baseC * 0.4));
  root.setProperty('--accent-glow', accentRgba(baseL, baseC, 0.35));
  root.setProperty('--accent-tint', accentRgba(baseL, baseC, 0.12));
  root.setProperty('--accent-key1', accentAt(Math.max(0.2, baseL - 0.04), baseC * 0.9));
  root.setProperty('--accent-key2', accentAt(Math.max(0.2, baseL - 0.12), baseC * 0.9));
  root.setProperty('--accent-key3', accentAt(Math.max(0.2, baseL - 0.20), baseC * 0.9));
}
setAccentHue(155);

// ──── Theme management ────
var _themeLight = false;
var _themeTemp = 'neutral';
function setTheme(light, temp) {
  _themeLight = light;
  _themeTemp = temp;
  let body = document.body;
  body.classList.toggle('theme-light', light);
  body.classList.remove('theme-warm', 'theme-cool');
  if (temp !== 'neutral') body.classList.add('theme-' + temp);
  if (_colorPickerDrawFn) _colorPickerDrawFn();
  if (_accentDrawFn) {
    _accentDrawFn();           // redraws viewport (recomputes frontier cache)
    setAccentHue(_accentHue);  // re-derive CSS variables from updated frontier
  }
  if (typeof redraw === 'function') redraw();
}

// ──── Discrete color stops ────
var _numStops = 36;
var _stopStep = 360 / _numStops;  // 10°  // ≈9.73°
function snapHue(hue) {
  let s = Math.round(hue / _stopStep) * _stopStep;
  return ((s % 360) + 360) % 360;
}

// ──── Ring shape mode ────
var _useCircle = false;
var _shapeLerp = 1;  // 0=circle, 1=gamut (animated)
var _displayMode = 'lab';  // 'gamut' | 'circle' | 'lab'
var _colorPickerDrawFn = null;

// Hue name labels for major positions
var _hueNames = [
  [0, 'Rose'], [30, 'Red'], [60, 'Orange'], [90, 'Amber'],
  [120, 'Chartreuse'], [150, 'Green'], [180, 'Teal'], [210, 'Cyan'],
  [240, 'Azure'], [270, 'Indigo'], [300, 'Purple'], [330, 'Magenta']
];

function initColorPicker() {
  let canvas = document.getElementById('color-ring-canvas');
  if (!canvas) return;
  let sz = 560;
  canvas.width = sz; canvas.height = sz;
  let ctx = canvas.getContext('2d');
  let W = sz, H = sz, cx = W / 2, cy = H / 2, hs = sz / 2;

  // Ring geometry — rings touch each other
  let outerOuter = hs * 0.78;
  let ringTotal = hs * 0.26;
  let brightHW = ringTotal * 0.57 / 2;
  let darkHW = ringTotal * 0.43 / 2;
  let midR = outerOuter - brightHW;

  // Click-to-grab: click once to grab, click again to release
  let dragging = null;
  let hoverHandle = null;     // null | 'p1' | 'p2'
  let hoverHue = -1;          // snapped hue under mouse for ring hover expand
  let _lastStop1 = Math.round(_playerHue1 / _stopStep);
  let _lastStop2 = Math.round(_playerHue2 / _stopStep);
  let _tickAudioCtx = null;
  let _animFrame = null;

  // Selected swatch expand amount (extra px outward)
  let expandPx = 6;

  // Graph drag state for strip tradeoff curve
  let draggingGraph = false;
  let draggingSlider = -1;  // index of column being slider-dragged, or -1

  // Rotate 90 extra so long axis is horizontal instead of vertical
  let extraRot = 90;

  function shapeDeg(hue) {
    let raw = _ringShape[((Math.round(hue) % 360) + 360) % 360];
    return 0.5 + (raw - 0.5) * _shapeLerp;
  }
  let shapeRange = hs * 0.16;
  function brightR(hue) { return midR - shapeRange / 2 + shapeDeg(hue) * shapeRange; }
  function darkR(hue) { return brightR(hue) - brightHW - darkHW; }
  function outerEdge(hue) { return brightR(hue) + brightHW; }
  function innerEdge(hue) { return darkR(hue) - darkHW; }
  function hueToAngle(hue) { return (hue + _shapeRot + extraRot - 90) * Math.PI / 180; }
  function mouseToHue(mx, my) {
    let deg = Math.atan2(my - cy, mx - cx) * 180 / Math.PI + 90 - _shapeRot - extraRot;
    return ((deg % 360) + 360) % 360;
  }
  function canvasCoords(e) {
    let rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * (canvas.width / rect.width), y: (e.clientY - rect.top) * (canvas.height / rect.height) };
  }

  // Which segment index does a hue fall in?
  function hueToSeg(hue) { return Math.round(((hue % 360) + 360) % 360 / _stopStep) % _numStops; }

  // ──── Soft iOS-style click ────
  function playSoftClick() {
    if (!_tickAudioCtx) _tickAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_tickAudioCtx.state === 'suspended') _tickAudioCtx.resume();
    let t = _tickAudioCtx.currentTime;
    let sr = _tickAudioCtx.sampleRate;
    let len = Math.floor(0.006 * sr);
    let buf = _tickAudioCtx.createBuffer(1, len, sr);
    let data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.06));
    let src = _tickAudioCtx.createBufferSource();
    src.buffer = buf;
    let g = _tickAudioCtx.createGain(); g.gain.value = 0.025;
    let filt = _tickAudioCtx.createBiquadFilter();
    filt.type = 'highpass'; filt.frequency.value = 4500; filt.Q.value = 0.5;
    src.connect(filt); filt.connect(g); g.connect(_tickAudioCtx.destination);
    src.start(t);
  }
  function checkDetent(player, hue) {
    let det = Math.round(((hue % 360) + 360) % 360 / _stopStep);
    if (player === 1) { if (det !== _lastStop1) { playSoftClick(); _lastStop1 = det; } }
    else { if (det !== _lastStop2) { playSoftClick(); _lastStop2 = det; } }
  }

  // ──── Drawing ────
  function drawRing() {
    if (_displayMode === 'lab') { drawLabView(); return; }
    if (_displayMode === 'strip') { drawStripView(); return; }
    // Reset any lab-mode inline styles
    canvas.style.width = '';
    canvas.style.height = '';
    canvas.style.maxWidth = '';
    if (canvas.width !== W) { canvas.width = W; canvas.height = H; }
    ctx.clearRect(0, 0, W, H);

    let seg1 = hueToSeg(_playerHue1), seg2 = hueToSeg(_playerHue2);
    let hovSeg = (hoverHue >= 0) ? hueToSeg(hoverHue) : -1;

    // Gamut axes (drawn behind ring so they show through center hole)
    if (_shapeLerp > 0.05) {
      let axAlpha = Math.min(1, _shapeLerp) * 0.15;
      let axisColor = _themeLight ? `rgba(0,0,0,${axAlpha * 0.5})` : `rgba(255,255,255,${axAlpha * 0.4})`;
      let maxH = 0, minH = 0, maxV = 0, minV = 1;
      for (let h = 0; h < 360; h++) {
        if (_ringShape[h] > maxV) { maxV = _ringShape[h]; maxH = h; }
        if (_ringShape[h] < minV) { minV = _ringShape[h]; minH = h; }
      }
      ctx.setLineDash([4, 6]);
      ctx.strokeStyle = axisColor; ctx.lineWidth = 1;
      // Main chroma axis through center
      let aMax = hueToAngle(maxH), aMin = hueToAngle(minH);
      let extMax = outerEdge(maxH) + 12, extMin = outerEdge(minH) + 12;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(aMax) * extMax, cy + Math.sin(aMax) * extMax);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + Math.cos(aMin) * extMin, cy + Math.sin(aMin) * extMin);
      ctx.stroke();
      // Perpendicular axis through center
      let pH1 = (maxH + 90) % 360, pH2 = (maxH + 270) % 360;
      let aP1 = hueToAngle(pH1), aP2 = hueToAngle(pH2);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(aP1) * (outerEdge(pH1) + 12), cy + Math.sin(aP1) * (outerEdge(pH1) + 12));
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + Math.cos(aP2) * (outerEdge(pH2) + 12), cy + Math.sin(aP2) * (outerEdge(pH2) + 12));
      ctx.stroke();
      ctx.setLineDash([]);
      // Axis labels
      let labelAlpha = Math.min(1, _shapeLerp) * 0.35;
      let labelColor = _themeLight ? `rgba(0,0,0,${labelAlpha})` : `rgba(255,255,255,${labelAlpha})`;
      ctx.font = '9px -apple-system, sans-serif';
      ctx.fillStyle = labelColor;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      let lmx = cx + Math.cos(aMax) * (extMax + 16);
      let lmy = cy + Math.sin(aMax) * (extMax + 16);
      ctx.fillText('High chroma', lmx, lmy);
      let lnx = cx + Math.cos(aMin) * (extMin + 16);
      let lny = cy + Math.sin(aMin) * (extMin + 16);
      ctx.fillText('Low chroma', lnx, lny);
    }

    // Ring segments
    for (let i = 0; i < _numStops; i++) {
      let hCenter = i * _stopStep;
      let hStart = hCenter - _stopStep / 2;
      let hEnd = hCenter + _stopStep / 2;
      let a1 = hueToAngle(hStart), a2 = hueToAngle(hEnd);
      let h = ((Math.round(hCenter) % 360) + 360) % 360;
      let isSel = (i === seg1 || i === seg2);
      let isHov = (i === hovSeg && !isSel);
      let exp = isSel ? expandPx : (isHov ? expandPx * 0.5 : 0);

      // Outer (bright) ring — use radii at each edge for smooth border
      let oE_s = outerEdge(hStart) + exp, oE_e = outerEdge(hEnd) + exp;
      let bR_s = brightR(hStart), bR_e = brightR(hEnd);
      let iB_s = bR_s - brightHW, iB_e = bR_e - brightHW;
      let lc = _brightLC[h]; let c = oklchToRgb(lc.L, lc.C, hCenter);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a1) * oE_s, cy + Math.sin(a1) * oE_s);
      ctx.lineTo(cx + Math.cos(a2) * oE_e, cy + Math.sin(a2) * oE_e);
      ctx.lineTo(cx + Math.cos(a2) * iB_e, cy + Math.sin(a2) * iB_e);
      ctx.lineTo(cx + Math.cos(a1) * iB_s, cy + Math.sin(a1) * iB_s);
      ctx.closePath();
      ctx.fillStyle = `rgb(${c.r},${c.g},${c.b})`;
      ctx.fill();

      // Inner (dark) ring — touching bright ring
      let dR_s = darkR(hStart), dR_e = darkR(hEnd);
      let oDk_s = dR_s + darkHW, oDk_e = dR_e + darkHW;
      let iDk_s = innerEdge(hStart) - exp, iDk_e = innerEdge(hEnd) - exp;
      let lcd = _darkLC[h]; let cd = oklchToRgb(lcd.L, lcd.C, hCenter);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a1) * oDk_s, cy + Math.sin(a1) * oDk_s);
      ctx.lineTo(cx + Math.cos(a2) * oDk_e, cy + Math.sin(a2) * oDk_e);
      ctx.lineTo(cx + Math.cos(a2) * iDk_e, cy + Math.sin(a2) * iDk_e);
      ctx.lineTo(cx + Math.cos(a1) * iDk_s, cy + Math.sin(a1) * iDk_s);
      ctx.closePath();
      ctx.fillStyle = `rgb(${cd.r},${cd.g},${cd.b})`;
      ctx.fill();

      // Segment divider line (bright)
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a1) * oE_s, cy + Math.sin(a1) * oE_s);
      ctx.lineTo(cx + Math.cos(a1) * iDk_s, cy + Math.sin(a1) * iDk_s);
      ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = 0.5;
      ctx.stroke();
    }

    // Hue name labels (inside ring, highlighted when player hue is nearby)
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let k = 0; k < _hueNames.length; k++) {
      let nh = _hueNames[k][0], name = _hueNames[k][1];
      let ang = hueToAngle(nh);
      let labelR = innerEdge(nh) - 14;
      let lx = cx + Math.cos(ang) * labelR;
      let ly = cy + Math.sin(ang) * labelR;
      let d1 = Math.abs(((snapHue(_playerHue1) - nh + 540) % 360) - 180);
      let d2 = Math.abs(((snapHue(_playerHue2) - nh + 540) % 360) - 180);
      if (d1 <= _stopStep || d2 <= _stopStep) {
        let nearHue = (d1 <= d2) ? snapHue(_playerHue1) : snapHue(_playerHue2);
        let nlc = _brightLC[Math.round(nearHue) % 360];
        let nc = oklchToRgb(nlc.L, nlc.C, nearHue);
        ctx.fillStyle = `rgb(${nc.r},${nc.g},${nc.b})`;
        ctx.font = 'bold 9px -apple-system, sans-serif';
      } else {
        ctx.fillStyle = _themeLight ? 'rgba(0,0,0,0.22)' : 'rgba(255,255,255,0.2)';
        ctx.font = '8px -apple-system, sans-serif';
      }
      ctx.fillText(name, lx, ly);
    }

    // Handles with hover/grab state
    let h1hov = (hoverHandle === 'p1'), h2hov = (hoverHandle === 'p2');
    let h1grab = (dragging === 'p1'), h2grab = (dragging === 'p2');
    drawHandle(_playerHue1, 'P1', h1hov || h1grab, h1grab);
    drawHandle(_playerHue2, 'P2', h2hov || h2grab, h2grab);

    // Lock indicator
    if (_colorPickerLocked) {
      let lockColor = _themeLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.12)';
      let a1 = hueToAngle(_playerHue1), a2 = hueToAngle(_playerHue2);
      let dI1 = innerEdge(_playerHue1) - 3;
      let dI2 = innerEdge(_playerHue2) - 3;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a1) * dI1, cy + Math.sin(a1) * dI1);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a2) * dI2, cy + Math.sin(a2) * dI2);
      ctx.strokeStyle = lockColor; ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  function drawHandle(hue, label, isHovered, isGrabbed) {
    let snapped = snapHue(hue);
    let deg = Math.round(snapped) % 360;
    let a = hueToAngle(snapped);
    let segIdx = hueToSeg(snapped);
    let hCenter = segIdx * _stopStep;
    let segStart = hCenter - _stopStep / 2;
    let segEnd = hCenter + _stopStep / 2;

    // Selection border aligned to segment boundaries
    let aS = hueToAngle(segStart), aE = hueToAngle(segEnd);
    let oS = outerEdge(segStart) + expandPx, oE_s = outerEdge(segEnd) + expandPx;
    let iS = innerEdge(segStart) - expandPx, iE = innerEdge(segEnd) - expandPx;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(aS) * oS, cy + Math.sin(aS) * oS);
    ctx.lineTo(cx + Math.cos(aE) * oE_s, cy + Math.sin(aE) * oE_s);
    ctx.lineTo(cx + Math.cos(aE) * iE, cy + Math.sin(aE) * iE);
    ctx.lineTo(cx + Math.cos(aS) * iS, cy + Math.sin(aS) * iS);
    ctx.closePath();
    ctx.strokeStyle = _themeLight ? 'rgba(0,0,0,0.65)' : 'rgba(255,255,255,0.75)';
    ctx.lineWidth = isGrabbed ? 3.5 : 2.5;
    ctx.stroke();

    // Circle tab outside the ring
    let circR = isHovered ? 15 : 13;
    let rOuter = outerEdge(deg) + expandPx;
    let tabCx = cx + Math.cos(a) * (rOuter + circR + 4);
    let tabCy = cy + Math.sin(a) * (rOuter + circR + 4);

    let lc = _brightLC[deg];
    let cB = oklchToRgb(lc.L, lc.C, snapped);
    let hexColor = `rgb(${cB.r},${cB.g},${cB.b})`;

    // Shadow for hovered handle
    if (isHovered) {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur = 8;
    }

    ctx.beginPath();
    ctx.arc(tabCx, tabCy, circR, 0, Math.PI * 2);
    ctx.fillStyle = hexColor;
    ctx.fill();
    ctx.strokeStyle = _themeLight ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.25)';
    ctx.lineWidth = isGrabbed ? 2.5 : 1.5;
    ctx.stroke();

    if (isHovered) ctx.restore();

    // Label
    ctx.fillStyle = lc.L > 0.6 ? '#000' : '#fff';
    ctx.font = 'bold 9px -apple-system, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, tabCx, tabCy);

    // Tooltip for grabbed state
    if (isGrabbed) {
      let tipY = tabCy - circR - 10;
      ctx.fillStyle = _themeLight ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.7)';
      ctx.font = '8px -apple-system, sans-serif';
      ctx.fillText('click to confirm', tabCx, tipY);
    }
  }

  // ──── 3D Isometric OKLCH view ────
  // Single 3D graph: hue = angle, chroma = radius, lightness = vertical
  // Canvas dims computed dynamically in drawLabView()
  let isoCanW = 840;
  let isoCanH = 700;
  let isoSized = false;       // true once we've computed canvas size
  let isoCx = isoCanW / 2, isoCy = isoCanH / 2;
  let draggingPolarP2 = false;
  let draggingOrbit = false;
  let orbitLastX = 0, orbitLastY = 0;
  let orbitScrollAxis = null;  // 'lat' or 'lon' when hovering widget
  let isoHoverLabel = null;    // 'bright' or 'dark' when hovering a frontier label
  let _gamutMaskCanvas = null;   // cached gamut silhouette mask for scroll hit-testing
  let _gamutOverlayCanvas = null; // cached overlay canvas for silhouette compositing

  // Orbit angles (in radians)
  let isoTheta = -Math.PI / 4;   // horizontal rotation (azimuth)
  let isoPhi = Math.PI / 5.5;    // vertical tilt (elevation), 0 = top-down, PI/2 = side

  // Scale factors for chroma (radial) and lightness (vertical)
  let polarMaxC = 0;
  (function () {
    for (let h = 0; h < 360; h++) polarMaxC = Math.max(polarMaxC, _absoluteMaxC[h]);
    polarMaxC *= 1.08;
  })();
  let isoChromaScale = 620;   // pixels per unit chroma
  let isoLScale = 420;        // pixels per unit lightness

  // Project 3D point (chromatic a, chromatic b, L) to 2D canvas using orbit angles
  // L=0.5 is the center of projection (orbit pivot)
  function isoProject(ca, cb, L) {
    // Rotate around vertical (lightness) axis by theta
    let rx = ca * Math.cos(isoTheta) - cb * Math.sin(isoTheta);
    let ry = ca * Math.sin(isoTheta) + cb * Math.cos(isoTheta);
    // Apply elevation tilt, centered at L=0.5
    let sx = isoCx + rx * isoChromaScale;
    let sy = isoCy - ry * Math.sin(isoPhi) * isoChromaScale - (L - 0.5) * Math.cos(isoPhi) * isoLScale;
    return { x: sx, y: sy };
  }

  // Project from OKLCH to 2D canvas
  function isoProjectLCH(L, C, h) {
    let hRad = h * Math.PI / 180;
    return isoProject(C * Math.cos(hRad), C * Math.sin(hRad), L);
  }
  // Depth for painter's algorithm (larger = farther from camera)
  function isoDepth(L, C, h) {
    let hRad = h * Math.PI / 180;
    let ca = C * Math.cos(hRad), cb = C * Math.sin(hRad);
    let ry = ca * Math.sin(isoTheta) + cb * Math.cos(isoTheta);
    return ry * Math.cos(isoPhi) - (L - 0.5) * Math.sin(isoPhi);
  }

  // Compute 36 frontier screen points for bright or dark
  function isoFrontierPts(dark) {
    let pts = [];
    for (let i = 0; i < 36; i++) {
      let h = _stripHues[i];
      let hd = ((Math.round(h) % 360) + 360) % 360;
      let lc = dark ? _stripDarkLC[hd] : _stripBrightLC[hd];
      let sp = isoProjectLCH(lc.L, lc.C, h);
      let rgb = oklchToRgb(lc.L, lc.C, h);
      pts.push({
        x: sp.x, y: sp.y,
        h: h, hd: hd, L: lc.L, C: lc.C, rgb: rgb, idx: i
      });
    }
    return pts;
  }

  function drawLabView() {
    // Dynamically size canvas to fill available space in right pane
    // Only recompute on first entry or when isoSized is cleared (window resize)
    if (!isoSized) {
      let wrap = document.getElementById('color-ring-wrap');
      let availW = wrap.clientWidth || 840;
      let wrapRect = wrap.getBoundingClientRect();
      // Measure actual height needed for controls below the viewport
      let belowH = 140; // fallback
      let slidersEl = document.getElementById('lab-pareto-sliders');
      let controlsEl = document.getElementById('color-picker-controls');
      if (controlsEl) {
        let ctrlRect = controlsEl.getBoundingClientRect();
        belowH = (ctrlRect.bottom - wrapRect.bottom) + ctrlRect.height + 20;
      }
      if (belowH < 160) belowH = 160; // ensure minimum reserve
      // Reserve space for controls + sliders below viewport
      let availH = Math.max(400, window.innerHeight - wrapRect.top - belowH);
      isoCanW = Math.round(availW);
      isoCanH = Math.round(availH);
      isoSized = true;
    }
    isoCx = isoCanW / 2;
    isoCy = isoCanH / 2;

    // Auto-fit: project all extreme points at unit scale, find bounding box, then scale to fit
    let margin = 50;  // px margin on each side
    let fitW = isoCanW - margin * 2;
    let fitH = isoCanH - margin * 2;

    // Compute projected extents at unit chroma/L scale (isoCx=0, isoCy=0)
    let minPx = Infinity, maxPx = -Infinity, minPy = Infinity, maxPy = -Infinity;
    // Sample all frontier points + axis endpoints
    let samplePts = [];
    for (let h = 0; h < 360; h += 10) {
      let lc = _stripBrightLC[h];
      samplePts.push({ ca: lc.C * Math.cos(h * Math.PI / 180), cb: lc.C * Math.sin(h * Math.PI / 180), L: lc.L });
      let lcd = _stripDarkLC[h];
      samplePts.push({ ca: lcd.C * Math.cos(h * Math.PI / 180), cb: lcd.C * Math.sin(h * Math.PI / 180), L: lcd.L });
      // Include full frontier (may extend beyond strip frontier for deep blues)
      let flc = _fullBrightLC[h];
      samplePts.push({ ca: flc.C * Math.cos(h * Math.PI / 180), cb: flc.C * Math.sin(h * Math.PI / 180), L: flc.L });
    }
    // Axis endpoints
    samplePts.push({ ca: 0, cb: 0, L: 0.15 });
    samplePts.push({ ca: 0, cb: 0, L: 0.95 });

    let kL = 0.685;  // lScale / chromaScale ratio

    for (let pt of samplePts) {
      let rx = pt.ca * Math.cos(isoTheta) - pt.cb * Math.sin(isoTheta);
      let ry = pt.ca * Math.sin(isoTheta) + pt.cb * Math.cos(isoTheta);
      // Normalized projection (at cScale=1): matches isoProject math
      let px = rx;
      let py = -(ry * Math.sin(isoPhi) + (pt.L - 0.5) * Math.cos(isoPhi) * kL);
      if (px < minPx) minPx = px;
      if (px > maxPx) maxPx = px;
      if (py < minPy) minPy = py;
      if (py > maxPy) maxPy = py;
    }

    let extW = maxPx - minPx || 0.001;
    let extH = maxPy - minPy || 0.001;
    let scaleX = fitW / extW;
    let scaleY = fitH / extH;
    isoChromaScale = Math.min(scaleX, scaleY);
    isoLScale = isoChromaScale * kL;

    // Re-center: offset so bounding box is centered in canvas
    let midPx = (minPx + maxPx) / 2;
    let midPy = (minPy + maxPy) / 2;
    isoCx = isoCanW / 2 - midPx * isoChromaScale;
    isoCy = isoCanH / 2 - midPy * isoChromaScale;

    canvas.width = isoCanW;
    canvas.height = isoCanH;
    canvas.style.maxWidth = 'none';
    canvas.style.width = isoCanW + 'px';
    canvas.style.height = isoCanH + 'px';

    // Black background
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, isoCanW, isoCanH);

    // Always light text on black background
    let textColor = 'rgba(255,255,255,0.85)';
    let subtleColor = 'rgba(255,255,255,0.5)';
    let gridColor = 'rgba(255,255,255,0.15)';
    let gridColorFaint = 'rgba(255,255,255,0.08)';

    let sel1 = hueToStripIdx(_playerHue1);
    let selH1 = _stripHues[sel1];
    let selH1d = ((Math.round(selH1) % 360) + 360) % 360;
    let selTradeoff = _stripPerHueTradeoff[sel1];

    let labSwap = (_displayMode === 'lab') && _stripSwapped;
    let p1Label = labSwap ? 'P2' : 'P1';
    let p2Label = labSwap ? 'P1' : 'P2';

    // ── Grid: chroma circles at mid-lightness only ──
    let gridMidL = 0.5;  // L=0.5 center level for chroma rings
    let gridChromaStep = 0.05;
    let gridChromaMax = polarMaxC;

    // Draw concentric chroma rings at mid-lightness
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 0.9;
    for (let cr = gridChromaStep; cr <= gridChromaMax; cr += gridChromaStep) {
      ctx.beginPath();
      for (let a = 0; a <= 360; a += 5) {
        let sp = isoProjectLCH(gridMidL, cr, a);
        if (a === 0) ctx.moveTo(sp.x, sp.y); else ctx.lineTo(sp.x, sp.y);
      }
      ctx.stroke();
    }

    // Draw vertical lightness lines at cardinal hues (every 30°)
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 0.9;
    for (let h = 0; h < 360; h += 30) {
      // Find the max chroma at this hue across bright range
      let mc = _absoluteMaxC[h] * 0.7;
      if (mc < 0.01) continue;
      let p0 = isoProjectLCH(0.25, mc, h);
      let p1 = isoProjectLCH(0.95, mc, h);
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }

    // Draw ellipse outlines at key lightness levels (fewer for clarity)
    let labelLevels = [0.3, 0.5, 0.7, 0.9];
    ctx.lineWidth = 1.0;
    ctx.strokeStyle = gridColor;
    for (let gl = 0; gl < labelLevels.length; gl++) {
      let L = labelLevels[gl];
      ctx.beginPath();
      let cr = 0.1;
      for (let a = 0; a <= 360; a += 3) {
        let sp = isoProjectLCH(L, cr, a);
        if (a === 0) ctx.moveTo(sp.x, sp.y); else ctx.lineTo(sp.x, sp.y);
      }
      ctx.closePath();
      ctx.stroke();
      // Label
      let labelPt = isoProjectLCH(L, 0.12, 330);
      ctx.fillStyle = subtleColor;
      ctx.font = '9px -apple-system, sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText('L=' + L.toFixed(1), labelPt.x + 4, labelPt.y);
    }

    // ── Vertical axis line ──
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    let axBot = isoProjectLCH(0.15, 0, 0);
    let axTop = isoProjectLCH(0.95, 0, 0);
    ctx.beginPath();
    ctx.moveTo(axBot.x, axBot.y);
    ctx.lineTo(axTop.x, axTop.y);
    ctx.stroke();
    // L=0.5 center tick mark
    let axMid = isoProjectLCH(0.5, 0, 0);
    ctx.beginPath();
    ctx.arc(axMid.x, axMid.y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fill();
    // Lightness axis label
    ctx.save();
    ctx.translate(axTop.x - 14, (axTop.y + axBot.y) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = subtleColor;
    ctx.font = '9px -apple-system, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText('Lightness', 0, 0);
    ctx.restore();

    // ── Gamut volume ── (always drawn: 0=silhouette, 1=edges, 2=wireframe, 3=opaque)
    {
      let gHsteps = 72;
      let gLsteps = _gamutProfileSteps;

      // Build depth-sorted gamut quads (positions — always needed for mask)
      let gamutQuads = [];
      for (let hi = 0; hi < gHsteps; hi++) {
        let h0 = hi * 360 / gHsteps;
        let h1g = ((hi + 1) % gHsteps) * 360 / gHsteps;
        let hIdx0 = Math.round(h0) % 360;
        let hIdx1 = Math.round(h1g) % 360;
        let prof0 = _gamutProfileLC[hIdx0], prof1 = _gamutProfileLC[hIdx1];
        for (let li = 0; li < gLsteps - 1; li++) {
          let L0 = li / (gLsteps - 1), L1 = (li + 1) / (gLsteps - 1);
          let C00 = prof0[li], C01 = prof0[li + 1];
          let C10 = prof1[li], C11 = prof1[li + 1];
          if (C00 < 0.001 && C01 < 0.001 && C10 < 0.001 && C11 < 0.001) continue;
          let sp00 = isoProjectLCH(L0, C00, h0), sp01 = isoProjectLCH(L1, C01, h0);
          let sp10 = isoProjectLCH(L0, C10, h1g), sp11 = isoProjectLCH(L1, C11, h1g);
          let d = (isoDepth(L0, C00, h0) + isoDepth(L1, C01, h0)
            + isoDepth(L0, C10, h1g) + isoDepth(L1, C11, h1g)) / 4;
          gamutQuads.push({ sp00, sp01, sp10, sp11, d, h0, h1g, L0, L1, C00, C01, C10, C11 });
        }
      }
      gamutQuads.sort(function (a, b) { return b.d - a.d; });

      // Build / update gamut mask canvas (for scroll hit-testing + silhouette)
      if (!_gamutMaskCanvas) _gamutMaskCanvas = document.createElement('canvas');
      if (_gamutMaskCanvas.width !== isoCanW || _gamutMaskCanvas.height !== isoCanH) {
        _gamutMaskCanvas.width = isoCanW; _gamutMaskCanvas.height = isoCanH;
      }
      let maskCtx = _gamutMaskCanvas.getContext('2d');
      maskCtx.clearRect(0, 0, isoCanW, isoCanH);
      maskCtx.fillStyle = '#ffffff';
      for (let qi = 0; qi < gamutQuads.length; qi++) {
        let q = gamutQuads[qi];
        maskCtx.beginPath();
        maskCtx.moveTo(q.sp00.x, q.sp00.y); maskCtx.lineTo(q.sp01.x, q.sp01.y);
        maskCtx.lineTo(q.sp11.x, q.sp11.y); maskCtx.lineTo(q.sp10.x, q.sp10.y);
        maskCtx.closePath();
        maskCtx.fill();
      }

      // Helper: draw colored wireframe lines (L-latitude + h-meridian)
      function drawColoredWire(alpha, lineW) {
        // L-latitude contours
        for (let li = 2; li < gLsteps - 1; li += 4) {
          let L = li / (gLsteps - 1);
          let prevSp = null;
          for (let hi2 = 0; hi2 <= gHsteps; hi2++) {
            let h = (hi2 % gHsteps) * 360 / gHsteps;
            let hIdx = Math.round(h) % 360;
            let C = _gamutProfileLC[hIdx][li];
            if (C < 0.001) { prevSp = null; continue; }
            let sp = isoProjectLCH(L, C, h);
            if (prevSp) {
              let rgb = oklchToRgb(L, C, h);
              ctx.strokeStyle = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + alpha + ')';
              ctx.lineWidth = lineW;
              ctx.beginPath(); ctx.moveTo(prevSp.x, prevSp.y); ctx.lineTo(sp.x, sp.y); ctx.stroke();
            }
            prevSp = sp;
          }
        }
        // H-meridian lines
        for (let hi2 = 0; hi2 < gHsteps; hi2 += 6) {
          let h = hi2 * 360 / gHsteps;
          let hIdx = Math.round(h) % 360;
          let prof = _gamutProfileLC[hIdx];
          let prevSp = null;
          for (let li = 0; li < gLsteps; li++) {
            let L = li / (gLsteps - 1), C = prof[li];
            if (C < 0.001) { prevSp = null; continue; }
            let sp = isoProjectLCH(L, C, h);
            if (prevSp) {
              let rgb = oklchToRgb(L, C, h);
              ctx.strokeStyle = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + alpha + ')';
              ctx.lineWidth = lineW;
              ctx.beginPath(); ctx.moveTo(prevSp.x, prevSp.y); ctx.lineTo(sp.x, sp.y); ctx.stroke();
            }
            prevSp = sp;
          }
        }
      }

      if (_labGamutMode <= 1) {
        // SILHOUETTE (mode 0) or EDGES (mode 1) — overlay outside gamut, axes visible inside
        let invertColor = _themeLight ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.08)';
        if (!_gamutOverlayCanvas) _gamutOverlayCanvas = document.createElement('canvas');
        if (_gamutOverlayCanvas.width !== isoCanW || _gamutOverlayCanvas.height !== isoCanH) {
          _gamutOverlayCanvas.width = isoCanW; _gamutOverlayCanvas.height = isoCanH;
        }
        let ovCtx = _gamutOverlayCanvas.getContext('2d');
        ovCtx.clearRect(0, 0, isoCanW, isoCanH);
        ovCtx.fillStyle = invertColor;
        ovCtx.fillRect(0, 0, isoCanW, isoCanH);
        ovCtx.globalCompositeOperation = 'destination-out';
        ovCtx.drawImage(_gamutMaskCanvas, 0, 0);
        ovCtx.globalCompositeOperation = 'source-over';
        ctx.drawImage(_gamutOverlayCanvas, 0, 0);

        if (_labGamutMode === 1) {
          // EDGES: add colored wireframe on top of silhouette
          drawColoredWire(0.7, 0.8);
        }
      } else if (_labGamutMode === 2) {
        // WIREFRAME: colored wireframe lines only (no overlay, no fill)
        drawColoredWire(0.9, 0.8);
      } else {
        // OPAQUE (mode 3): solid colored quads at 100% + subtle wireframe
        for (let qi = 0; qi < gamutQuads.length; qi++) {
          let q = gamutQuads[qi];
          let mH = (q.h0 + q.h1g) / 2, mL = (q.L0 + q.L1) / 2;
          let mC = (q.C00 + q.C01 + q.C10 + q.C11) / 4;
          let rgb = oklchToRgb(mL, Math.min(mC, maxChroma(mL, mH)), mH);
          ctx.beginPath();
          ctx.moveTo(q.sp00.x, q.sp00.y); ctx.lineTo(q.sp01.x, q.sp01.y);
          ctx.lineTo(q.sp11.x, q.sp11.y); ctx.lineTo(q.sp10.x, q.sp10.y);
          ctx.closePath();
          ctx.fillStyle = 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')';
          ctx.fill();
        }
        drawColoredWire(0.15, 0.5);
      }
    }

    // ── Max chroma ring (gamut boundary at P1's lightness) ──
    _isoCurveCache.maxchroma = null;
    if (_labShowMaxChromaRing) {
      let hoverMaxC = (_labHoverToggle === 'maxchroma' || _labHoverCurve === 'maxchroma');
      let p1LC = _stripBrightLC[selH1d];
      let p1L = p1LC.L;
      let ringPts = [];
      for (let h = 0; h < 360; h++) {
        let C = maxChroma(p1L, h);
        let sp = isoProjectLCH(p1L, C, h);
        let rgb = oklchToRgb(p1L, C, h);
        ringPts.push({ x: sp.x, y: sp.y, C: C, rgb: rgb });
      }
      _isoCurveCache.maxchroma = ringPts;
      ctx.setLineDash([5, 3]);
      for (let i = 0; i < 360; i++) {
        let a = ringPts[i], b = ringPts[(i + 1) % 360];
        if (a.C < 0.001 && b.C < 0.001) continue;
        ctx.strokeStyle = 'rgb(' + a.rgb.r + ',' + a.rgb.g + ',' + a.rgb.b + ')';
        ctx.lineWidth = hoverMaxC ? 3.5 : 1.5;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // ── Constant chroma ring (circle at P1's chroma, all hues, clamped to gamut) ──
    _isoCurveCache.constchroma = null;
    if (_labShowConstChromaRing) {
      let hoverConstC = (_labHoverToggle === 'constchroma' || _labHoverCurve === 'constchroma');
      let p1LC = _stripBrightLC[selH1d];
      let constC = p1LC.C;
      let ringPts = [];
      for (let h = 0; h < 360; h++) {
        let inGamut = constC <= maxChroma(p1LC.L, h);
        let sp = isoProjectLCH(p1LC.L, constC, h);
        let rgb = inGamut ? oklchToRgb(p1LC.L, constC, h) : { r: 100, g: 100, b: 100 };
        ringPts.push({ x: sp.x, y: sp.y, inGamut: inGamut, rgb: rgb });
      }
      _isoCurveCache.constchroma = ringPts;
      for (let i = 0; i < 360; i++) {
        let a = ringPts[i], b = ringPts[(i + 1) % 360];
        if (a.inGamut) {
          ctx.strokeStyle = 'rgb(' + a.rgb.r + ',' + a.rgb.g + ',' + a.rgb.b + ')';
          ctx.setLineDash([]);
          ctx.lineWidth = hoverConstC ? 4 : 2;
        } else {
          ctx.strokeStyle = 'rgba(255,255,255,0.45)';
          ctx.setLineDash([4, 4]);
          ctx.lineWidth = hoverConstC ? 2.5 : 1.5;
        }
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // ── Pareto surface (mode 2) ──
    if (_stripSacrificeMode === 2 && _labShowSurface) {
      // Build/cache surface
      if (_raySurfaceCache.h1 !== selH1d) buildParetoSurface(selH1d);
      let sc = _raySurfaceCache;
      let pts = sc.pts;
      let hS = sc.thetaSteps, lS = sc.phiSteps;

      // Animation: determine max visible distance from ideal
      let animMaxD = null;
      if (_paretoAnimating) {
        let elapsed = performance.now() - _paretoAnimStart;
        let frac = Math.min(1, elapsed / _paretoAnimDuration);
        frac = 1 - Math.pow(1 - frac, 2);  // ease-out quadratic (gentler)
        animMaxD = frac * sc.maxDist;
        if (elapsed >= _paretoAnimDuration) _paretoAnimating = false;
      }

      // Draw ideal point marker
      let idealSp = isoProjectLCH(sc.idealL, sc.idealC, sc.idealH);
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(idealSp.x, idealSp.y, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      if (sc.idealInGamut) {
        let idRgb = oklchToRgb(sc.idealL, sc.idealC, sc.idealH);
        ctx.beginPath(); ctx.arc(idealSp.x, idealSp.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgb(' + idRgb.r + ',' + idRgb.g + ',' + idRgb.b + ')';
        ctx.fill();
      }
      // "Ideal" label
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '8px -apple-system, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText('Ideal', idealSp.x, idealSp.y - 10);

      // Draw dotted line from P1 through axis to ideal point
      let p1Sp = isoProjectLCH(_stripBrightLC[selH1d].L, _stripBrightLC[selH1d].C, selH1d);
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(p1Sp.x, p1Sp.y); ctx.lineTo(idealSp.x, idealSp.y); ctx.stroke();
      ctx.setLineDash([]);

      // ── Depth-sorted opaque surface quads (Pareto region only) ──
      let quadsToDraw = [];
      for (let hi = 0; hi < hS; hi++) {
        let hi2 = (hi + 1) % hS;
        for (let li = 0; li < lS; li++) {
          let p00 = pts[hi][li], p01 = pts[hi][li + 1];
          let p10 = pts[hi2][li], p11 = pts[hi2][li + 1];
          if (!p00 || !p01 || !p10 || !p11) continue;
          // Only draw quads where at least one corner is Pareto-optimal
          if (!p00.pareto && !p01.pareto && !p10.pareto && !p11.pareto) continue;
          // Animation filter
          if (animMaxD !== null) {
            if (p00.dist > animMaxD && p01.dist > animMaxD && p10.dist > animMaxD && p11.dist > animMaxD) continue;
          }
          let sp00 = isoProjectLCH(p00.L, p00.C, p00.h);
          let sp01 = isoProjectLCH(p01.L, p01.C, p01.h);
          let sp10 = isoProjectLCH(p10.L, p10.C, p10.h);
          let sp11 = isoProjectLCH(p11.L, p11.C, p11.h);
          let d = (isoDepth(p00.L, p00.C, p00.h) + isoDepth(p01.L, p01.C, p01.h)
            + isoDepth(p10.L, p10.C, p10.h) + isoDepth(p11.L, p11.C, p11.h)) / 4;
          let mL = (p00.L + p01.L + p10.L + p11.L) / 4;
          let mC = (p00.C + p01.C + p10.C + p11.C) / 4;
          let mH = ((Math.atan2(
            (Math.sin(p00.h * Math.PI / 180) + Math.sin(p01.h * Math.PI / 180) + Math.sin(p10.h * Math.PI / 180) + Math.sin(p11.h * Math.PI / 180)) / 4,
            (Math.cos(p00.h * Math.PI / 180) + Math.cos(p01.h * Math.PI / 180) + Math.cos(p10.h * Math.PI / 180) + Math.cos(p11.h * Math.PI / 180)) / 4
          ) * 180 / Math.PI) + 360) % 360;
          let rgb = oklchToRgb(mL, mC, mH);
          quadsToDraw.push({ sp00: sp00, sp01: sp01, sp10: sp10, sp11: sp11, rgb: rgb, d: d });
        }
      }
      quadsToDraw.sort(function (a, b) { return b.d - a.d; });
      for (let qi = 0; qi < quadsToDraw.length; qi++) {
        let q = quadsToDraw[qi];
        ctx.beginPath();
        ctx.moveTo(q.sp00.x, q.sp00.y); ctx.lineTo(q.sp01.x, q.sp01.y);
        ctx.lineTo(q.sp11.x, q.sp11.y); ctx.lineTo(q.sp10.x, q.sp10.y);
        ctx.closePath();
        ctx.fillStyle = 'rgb(' + q.rgb.r + ',' + q.rgb.g + ',' + q.rgb.b + ')';
        ctx.fill();
      }

      // ── Wireframe (Pareto region only) ──
      for (let hi = 0; hi < hS; hi += 6) {
        ctx.beginPath();
        let started = false;
        for (let li = 0; li <= lS; li++) {
          let pt = pts[hi][li];
          if (!pt || !pt.pareto) { started = false; continue; }
          if (animMaxD !== null && pt.dist > animMaxD) { started = false; continue; }
          let sp = isoProjectLCH(pt.L, pt.C, pt.h);
          if (!started) { ctx.moveTo(sp.x, sp.y); started = true; }
          else ctx.lineTo(sp.x, sp.y);
        }
        ctx.strokeStyle = 'rgba(0,0,0,0.15)';
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }
      for (let li = 3; li <= lS; li += 3) {
        ctx.beginPath();
        let started = false;
        for (let hi = 0; hi <= hS; hi++) {
          let pt = pts[hi % hS][li];
          if (!pt || !pt.pareto) { started = false; continue; }
          if (animMaxD !== null && pt.dist > animMaxD) { started = false; continue; }
          let sp = isoProjectLCH(pt.L, pt.C, pt.h);
          if (!started) { ctx.moveTo(sp.x, sp.y); started = true; }
          else ctx.lineTo(sp.x, sp.y);
        }
        ctx.strokeStyle = 'rgba(0,0,0,0.1)';
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }

      // ── Nearest Pareto point marker ──
      let nearPt = sc.nearestPt;
      if (nearPt && (animMaxD === null || nearPt.dist <= animMaxD)) {
        let cpSp = isoProjectLCH(nearPt.L, nearPt.C, nearPt.h);
        let cpRgb = oklchToRgb(nearPt.L, nearPt.C, nearPt.h);
        ctx.beginPath(); ctx.arc(cpSp.x, cpSp.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgb(' + cpRgb.r + ',' + cpRgb.g + ',' + cpRgb.b + ')';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([2, 3]);
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.moveTo(idealSp.x, idealSp.y); ctx.lineTo(cpSp.x, cpSp.y); ctx.stroke();
        ctx.setLineDash([]);
      }

      // ── Three extreme vertex markers ──
      let extremes = [
        { pt: sc.vertexL, label: 'Best L' },
        { pt: sc.vertexC, label: 'Best C' },
        { pt: sc.vertexH, label: 'Best h' }
      ];
      for (let ei = 0; ei < extremes.length; ei++) {
        let ex = extremes[ei];
        if (!ex.pt) continue;
        if (animMaxD !== null && ex.pt.dist > animMaxD) continue;
        let exSp = isoProjectLCH(ex.pt.L, ex.pt.C, ex.pt.h);
        let exRgb = oklchToRgb(ex.pt.L, ex.pt.C, ex.pt.h);
        ctx.beginPath();
        ctx.moveTo(exSp.x, exSp.y - 5); ctx.lineTo(exSp.x + 4, exSp.y);
        ctx.lineTo(exSp.x, exSp.y + 5); ctx.lineTo(exSp.x - 4, exSp.y);
        ctx.closePath();
        ctx.fillStyle = 'rgb(' + exRgb.r + ',' + exRgb.g + ',' + exRgb.b + ')';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.font = '7px -apple-system, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(ex.label, exSp.x, exSp.y - 8);
      }

      // Request next frame if animating
      if (_paretoAnimating) {
        requestAnimationFrame(function () { drawRing(); });
      }
    }

    // ── P2 sacrifice curve in 3D (hidden in surface mode) ──
    let frontier = computePareto(selH1d);

    if (_stripSacrificeMode < 2) {
      // Build bright sacrifice curve (using L2/C2 from Pareto frontier)
      let curvePtsB = [];
      for (let x = 0; x <= 180; x++) {
        let fh2 = frontier[x].h2;
        let fL2 = frontier[x].L2;
        let fC2 = frontier[x].C2;
        let sp = isoProjectLCH(fL2, fC2, fh2);
        let frgb = oklchToRgb(fL2, fC2, fh2);
        curvePtsB.push({ x: sp.x, y: sp.y, h2: fh2, L2: fL2, C2: fC2, rgb: frgb, contrast: x });
      }

      // Draw sacrifice curve dots (bright)
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      for (let k = 0; k < curvePtsB.length; k++) {
        ctx.beginPath();
        ctx.arc(curvePtsB[k].x, curvePtsB[k].y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      for (let k = 0; k < curvePtsB.length; k++) {
        let pt = curvePtsB[k];
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 1.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgb(' + pt.rgb.r + ',' + pt.rgb.g + ',' + pt.rgb.b + ')';
        ctx.fill();
      }
    } // end if _stripSacrificeMode < 2

    // ── Frontiers: bright and dark loops in 3D (smooth 360-point curves) ──
    let brightPts = isoFrontierPts(false);
    let darkPts = isoFrontierPts(true);

    // Build smooth 360-point frontier curves
    function buildSmoothFrontier(dark) {
      // Use strip frontier with triangle-weighted smoothing (±5°) for smooth curve
      let srcArr = dark ? _stripDarkLC : _stripBrightLC;
      let rawL = new Float64Array(360), rawC = new Float64Array(360);
      for (let h = 0; h < 360; h++) { rawL[h] = srcArr[h].L; rawC[h] = srcArr[h].C; }
      let smoothR = 5;
      let pts = [];
      for (let h = 0; h < 360; h++) {
        let sumL = 0, sumC = 0, wSum = 0;
        for (let d = -smoothR; d <= smoothR; d++) {
          let hh = ((h + d) % 360 + 360) % 360;
          let w = 1 - Math.abs(d) / (smoothR + 1);
          sumL += rawL[hh] * w; sumC += rawC[hh] * w; wSum += w;
        }
        let sL = sumL / wSum;
        let sC = Math.min(sumC / wSum, maxChroma(sL, h));
        let sp = isoProjectLCH(sL, sC, h);
        let rgb = oklchToRgb(sL, sC, h);
        pts.push({ x: sp.x, y: sp.y, L: sL, C: sC, h: h, rgb: rgb });
      }
      return pts;
    }
    let smoothBright = buildSmoothFrontier(false);
    let smoothDark = buildSmoothFrontier(true);

    // Build smooth 360-point ideal curves (mirror of frontier — out-of-gamut)
    function buildSmoothIdeal(dark) {
      let pts = [];
      for (let h = 0; h < 360; h++) {
        let lc = dark ? _stripDarkLC[h] : _stripBrightLC[h];
        let mirrorH = (h + 180) % 360;
        let sp = isoProjectLCH(lc.L, lc.C, mirrorH);
        pts.push({ x: sp.x, y: sp.y, L: lc.L, C: lc.C, h: mirrorH, srcH: h });
      }
      return pts;
    }

    // Build smooth 360-point closest-to-ideal curves (true nearest in-gamut point)
    // Cached: inputs (_stripBrightLC/_stripDarkLC) are constant, only projection changes
    var _closestCache = { bright: null, dark: null };
    function buildSmoothClosest(dark) {
      let cacheKey = dark ? 'dark' : 'bright';
      if (_closestCache[cacheKey]) {
        // Re-project cached LCH points
        let cached = _closestCache[cacheKey];
        let pts = [];
        for (let i = 0; i < cached.length; i++) {
          let c = cached[i];
          let sp = isoProjectLCH(c.L, c.C, c.h);
          pts.push({ x: sp.x, y: sp.y, L: c.L, C: c.C, h: c.h, rgb: c.rgb, srcH: c.srcH });
        }
        return pts;
      }
      // Helper: fast maxChroma from precomputed profile (avoids binary search)
      function fastMaxC(L, h) {
        let hIdx = ((Math.round(h) % 360) + 360) % 360;
        let prof = _gamutProfileLC[hIdx];
        let fIdx = L * (_gamutProfileSteps - 1);
        let lo = Math.floor(fIdx), hi = Math.ceil(fIdx);
        if (lo < 0) lo = 0; if (hi >= _gamutProfileSteps) hi = _gamutProfileSteps - 1;
        if (lo === hi) return prof[lo];
        let t = fIdx - lo;
        return prof[lo] * (1 - t) + prof[hi] * t;
      }
      let pts = [];
      let lchCache = [];
      for (let srcH = 0; srcH < 360; srcH++) {
        let lc = dark ? _stripDarkLC[srcH] : _stripBrightLC[srcH];
        let idealH = (srcH + 180) % 360;
        let idealL = lc.L, idealC = lc.C;
        let idealRad = idealH * Math.PI / 180;
        let idealA = idealC * Math.cos(idealRad), idealB = idealC * Math.sin(idealRad);
        let bestD = Infinity, bestL = idealL, bestC = 0, bestH2 = idealH;
        // Coarse search
        for (let dh = -60; dh <= 60; dh += 2) {
          let h2 = ((idealH + dh) % 360 + 360) % 360;
          let h2Rad = h2 * Math.PI / 180;
          for (let dl = -20; dl <= 20; dl += 2) {
            let L2 = idealL + dl * 0.02;
            if (L2 < 0 || L2 > 1) continue;
            let Cmax = fastMaxC(L2, h2);
            let C2 = Math.min(idealC, Cmax);
            let a2 = C2 * Math.cos(h2Rad), b2 = C2 * Math.sin(h2Rad);
            let d = Math.sqrt((L2 - idealL) ** 2 + (a2 - idealA) ** 2 + (b2 - idealB) ** 2);
            if (d < bestD) { bestD = d; bestL = L2; bestC = C2; bestH2 = h2; }
          }
        }
        // Fine-tune
        for (let dh = -3; dh <= 3; dh++) {
          let h2 = ((bestH2 + dh) % 360 + 360) % 360;
          let h2Rad = h2 * Math.PI / 180;
          for (let dl = -3; dl <= 3; dl++) {
            let L2 = bestL + dl * 0.005;
            if (L2 < 0 || L2 > 1) continue;
            let C2 = Math.min(idealC, fastMaxC(L2, h2));
            let a2 = C2 * Math.cos(h2Rad), b2 = C2 * Math.sin(h2Rad);
            let d = Math.sqrt((L2 - idealL) ** 2 + (a2 - idealA) ** 2 + (b2 - idealB) ** 2);
            if (d < bestD) { bestD = d; bestL = L2; bestC = C2; bestH2 = h2; }
          }
        }
        let sp = isoProjectLCH(bestL, bestC, bestH2);
        let rgb = oklchToRgb(bestL, bestC, bestH2);
        pts.push({ x: sp.x, y: sp.y, L: bestL, C: bestC, h: bestH2, rgb: rgb, srcH: srcH });
        lchCache.push({ L: bestL, C: bestC, h: bestH2, rgb: rgb, srcH: srcH });
      }
      _closestCache[cacheKey] = lchCache;
      return pts;
    }

    // Helper: draw a colored gradient loop (like the frontier)
    function drawColoredLoop(smooth, lineW) {
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = lineW + 2;
      ctx.beginPath();
      for (let i = 0; i <= 360; i++) {
        let pt = smooth[i % 360];
        if (i === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y);
      }
      ctx.closePath(); ctx.stroke();
      for (let i = 0; i < 360; i += 3) {
        let a = smooth[i], b = smooth[(i + 3) % 360];
        let grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
        grad.addColorStop(0, 'rgb(' + a.rgb.r + ',' + a.rgb.g + ',' + a.rgb.b + ')');
        grad.addColorStop(1, 'rgb(' + b.rgb.r + ',' + b.rgb.g + ',' + b.rgb.b + ')');
        ctx.strokeStyle = grad;
        ctx.lineWidth = lineW;
        ctx.beginPath(); ctx.moveTo(a.x, a.y);
        for (let j = i + 1; j <= i + 3; j++) ctx.lineTo(smooth[j % 360].x, smooth[j % 360].y);
        ctx.stroke();
      }
    }

    // Helper: draw a dashed monochrome loop (for ideal curves — not in gamut)
    function drawDashedLoop(smooth, color, lineW) {
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = color;
      ctx.lineWidth = lineW;
      ctx.beginPath();
      for (let i = 0; i <= 360; i++) {
        let pt = smooth[i % 360];
        if (i === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y);
      }
      ctx.closePath(); ctx.stroke();
      ctx.setLineDash([]);
    }

    // ── Draw frontier loops ──
    let hoverFrontier = (_labHoverToggle === 'frontier' || _labHoverCurve === 'frontier');
    let hoverDark = (_labHoverToggle === 'dark' || _labHoverCurve === 'dark');
    _isoCurveCache.frontier = null; _isoCurveCache.dark = null;
    if (_labShowFrontier && _labShowDark) {
      let show = isoHoverLabel !== 'bright';
      if (show) { drawColoredLoop(smoothDark, (hoverFrontier || hoverDark) ? 5 : 3); _isoCurveCache.dark = smoothDark; }
    }
    if (_labShowFrontier) {
      let show = isoHoverLabel !== 'dark';
      if (show) { drawColoredLoop(smoothBright, hoverFrontier ? 6 : 3.5); _isoCurveCache.frontier = smoothBright; }
      // Drop lines from bright to dark at P1 position
      if (_labShowDark && isoHoverLabel !== 'bright') {
        let bP1 = brightPts[sel1], dP1 = darkPts[sel1];
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = 'rgba(255,255,255,0.2)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(bP1.x, bP1.y); ctx.lineTo(dP1.x, dP1.y); ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // ── Draw ideal curves (dashed, monochrome — out of gamut) ──
    let hoverIdeal = (_labHoverToggle === 'ideal' || _labHoverCurve === 'ideal');
    _isoCurveCache.ideal = null; _isoCurveCache.idealDark = null;
    if (_labShowIdeal) {
      let idealBright = buildSmoothIdeal(false);
      drawDashedLoop(idealBright, 'rgba(255,255,255,0.45)', hoverIdeal ? 4 : 2);
      _isoCurveCache.ideal = idealBright;
      if (_labShowDark) {
        let idealDark = buildSmoothIdeal(true);
        drawDashedLoop(idealDark, 'rgba(255,255,255,0.25)', hoverIdeal ? 3 : 1.5);
        _isoCurveCache.idealDark = idealDark;
      }
    }

    // ── Draw closest-to-ideal curves (in color — in gamut) ──
    let hoverClosest = (_labHoverToggle === 'closest' || _labHoverCurve === 'closest');
    _isoCurveCache.closest = null; _isoCurveCache.closestDark = null;
    if (_labShowClosest) {
      let closestBright = buildSmoothClosest(false);
      drawColoredLoop(closestBright, hoverClosest ? 5 : 2.5);
      _isoCurveCache.closest = closestBright;
      if (_labShowDark) {
        let closestDark = buildSmoothClosest(true);
        drawColoredLoop(closestDark, hoverClosest ? 4 : 2);
        _isoCurveCache.closestDark = closestDark;
      }
    }

    // ── Swatch circles on both frontiers (only P1 highlighted) ──
    if (_labShowFrontier) {
      for (let fi = 0; fi < 2; fi++) {
        let ptsArr = fi === 0 ? darkPts : brightPts;
        let isDark = fi === 0;
        if (isDark && !_labShowDark) continue;
        if (isoHoverLabel === 'bright' && isDark) continue;
        if (isoHoverLabel === 'dark' && !isDark) continue;
        for (let i = 0; i < 36; i++) {
          let pt = ptsArr[i];
          let isSel = (i === sel1);
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, isSel ? 8 : 4.5, 0, Math.PI * 2);
          ctx.fillStyle = 'rgb(' + pt.rgb.r + ',' + pt.rgb.g + ',' + pt.rgb.b + ')';
          ctx.fill();
          if (isSel) {
            ctx.strokeStyle = 'rgba(255,255,255,0.8)';
            ctx.lineWidth = 2;
            ctx.stroke();
          } else {
            ctx.strokeStyle = 'rgba(255,255,255,0.12)';
            ctx.lineWidth = 0.7;
            ctx.stroke();
          }
        }
      }
    } // end if _labShowFrontier

    // ── P1 highlight on bright frontier ──
    let p1bPt = brightPts[sel1];
    ctx.beginPath();
    ctx.arc(p1bPt.x, p1bPt.y, 9, 0, Math.PI * 2);
    ctx.fillStyle = 'rgb(' + p1bPt.rgb.r + ',' + p1bPt.rgb.g + ',' + p1bPt.rgb.b + ')';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // ── P2 highlight on sacrifice curve (or surface) ──
    let p2L, p2C, p2H;
    if (_stripSacrificeMode === 2) {
      p2L = _surfaceP2L; p2C = _surfaceP2C; p2H = _playerHue2;
    } else {
      let selP2 = computeStripP2(selH1d, selTradeoff);
      p2L = selP2.L2; p2C = selP2.C2; p2H = selP2.h2;
    }
    let sp2 = isoProjectLCH(p2L, p2C, p2H);
    let sp2rgb = oklchToRgb(p2L, p2C, p2H);
    ctx.beginPath();
    ctx.arc(sp2.x, sp2.y, 9, 0, Math.PI * 2);
    ctx.fillStyle = 'rgb(' + sp2rgb.r + ',' + sp2rgb.g + ',' + sp2rgb.b + ')';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // ── Dark P2 dot (only when dark is toggled on) ──
    if (_labShowDark) {
      let darkP2L = Math.max(0, p2L - 0.28);
      let darkP2C = Math.min(p2C, maxChroma(darkP2L, p2H));
      let dp2 = isoProjectLCH(darkP2L, darkP2C, p2H);
      let dp2rgb = oklchToRgb(darkP2L, darkP2C, p2H);
      ctx.beginPath();
      ctx.arc(dp2.x, dp2.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = 'rgb(' + dp2rgb.r + ',' + dp2rgb.g + ',' + dp2rgb.b + ')';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Drop line from bright P2 to dark P2
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(' + sp2rgb.r + ',' + sp2rgb.g + ',' + sp2rgb.b + ',0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(sp2.x, sp2.y); ctx.lineTo(dp2.x, dp2.y); ctx.stroke();
      ctx.setLineDash([]);
    }

    // ── Radial axis lines: from P1/P2 to central axis at their brightness ──
    // P1 radial line
    let p1AxisPt = isoProjectLCH(p1bPt.L, 0, 0);
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = 'rgba(' + p1bPt.rgb.r + ',' + p1bPt.rgb.g + ',' + p1bPt.rgb.b + ',0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(p1bPt.x, p1bPt.y); ctx.lineTo(p1AxisPt.x, p1AxisPt.y); ctx.stroke();
    // P2 radial line
    let p2AxisPt = isoProjectLCH(p2L, 0, 0);
    ctx.strokeStyle = 'rgba(' + sp2rgb.r + ',' + sp2rgb.g + ',' + sp2rgb.b + ',0.5)';
    ctx.beginPath(); ctx.moveTo(sp2.x, sp2.y); ctx.lineTo(p2AxisPt.x, p2AxisPt.y); ctx.stroke();
    // Brightness difference line on central axis
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(p1AxisPt.x, p1AxisPt.y); ctx.lineTo(p2AxisPt.x, p2AxisPt.y); ctx.stroke();
    ctx.setLineDash([]);
    // ΔL label at midpoint of brightness diff line
    let deltaL = Math.abs(p1bPt.L - p2L);
    if (deltaL > 0.01) {
      let midAxisPt = isoProjectLCH((p1bPt.L + p2L) / 2, 0, 0);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = '8px -apple-system, sans-serif';
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText('\u0394L=' + deltaL.toFixed(2), midAxisPt.x - 5, midAxisPt.y);
    }

    // ── Angle indicator: arc showing deviation from 180° opposite P1 ──
    let idealH2 = (selH1d + 180) % 360;
    let actualH2 = p2H;
    let angDev = ((actualH2 - idealH2 + 540) % 360) - 180;  // signed deviation
    if (Math.abs(angDev) > 1) {
      // Draw arc at a fixed chroma radius on the bright plane
      let arcC = 0.06;  // small radius arc near center
      let arcL = _stripBrightLC[selH1d].L;
      let idealRad = idealH2 * Math.PI / 180;
      let actualRad = actualH2 * Math.PI / 180;

      // Draw the ideal line (dashed)
      let idPt = isoProjectLCH(arcL, arcC * 1.5, idealH2);
      let cenPt = isoProjectLCH(arcL, 0, 0);
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cenPt.x, cenPt.y); ctx.lineTo(idPt.x, idPt.y); ctx.stroke();
      ctx.setLineDash([]);

      // Draw isometric arc from ideal to actual
      let startH = angDev > 0 ? idealH2 : actualH2;
      let endH = angDev > 0 ? actualH2 : idealH2;
      let arcSteps = Math.max(8, Math.abs(angDev));
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let s = 0; s <= arcSteps; s++) {
        let frac = s / arcSteps;
        let h = startH + frac * ((endH - startH + 360) % 360);
        let sp = isoProjectLCH(arcL, arcC, h);
        if (s === 0) ctx.moveTo(sp.x, sp.y); else ctx.lineTo(sp.x, sp.y);
      }
      ctx.stroke();

      // Label the deviation angle
      let midH = idealH2 + angDev / 2;
      let midPt = isoProjectLCH(arcL, arcC + 0.015, midH);
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = 'bold 9px -apple-system, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText((angDev > 0 ? '+' : '') + Math.round(angDev) + '\u00B0', midPt.x, midPt.y - 8);
    }

    // ── P1/P2 labels (always on) ──
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = 'bold 10px -apple-system, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    let p1off = isoProjectLCH(p1bPt.L + 0.04, p1bPt.C * 1.15, selH1);
    ctx.fillText(p1Label, p1off.x, p1off.y - 6);
    let p2off = isoProjectLCH(p2L + 0.04, p2C * 1.15, p2H);
    ctx.fillText(p2Label, p2off.x, p2off.y - 6);

    // ── Hover label at mouse (appears when hovering a curve) ──
    _isoBrightLabelRect = null;
    _isoDarkLabelRect = null;
    if (_labHoverCurve) {
      let labelText = _labHoverCurve === 'frontier' ? 'Chromaticity frontier'
        : _labHoverCurve === 'dark' ? 'Dark frontier'
        : _labHoverCurve === 'ideal' ? 'Ideal (out-of-gamut)'
        : _labHoverCurve === 'closest' ? 'Closest to ideal'
        : _labHoverCurve === 'maxchroma' ? 'Max chroma ring'
        : _labHoverCurve === 'constchroma' ? 'Constant chroma ring'
        : _labHoverCurve;
      ctx.font = 'bold 13px -apple-system, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText(labelText, _labMouseX + 12, _labMouseY - 10);
    }

    // ── Info line (always on) ──
    {
      let angSep = Math.min(Math.abs(Math.round(p2H) - selH1d), 360 - Math.abs(Math.round(p2H) - selH1d));
      ctx.font = '10px -apple-system, sans-serif';
      ctx.fillStyle = subtleColor;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(
        p1Label + ': ' + Math.round(selH1) + '\u00B0  ' +
        p2Label + ': ' + Math.round(p2H) + '\u00B0  (\u0394' + angSep + '\u00B0)' +
        '   \u0394h \u2265 ' + selTradeoff + '\u00B0',
        isoCanW / 2, isoCanH - 30
      );
    }

    // ── Latitude / Longitude scroll widgets ──
    let wMar = 14;
    let wLen = 80, wThick = 18;
    // Longitude widget (horizontal bar, bottom-left)
    let lonX = wMar, lonY = isoCanH - wMar - wThick;
    _isoLonRect = { x: lonX, y: lonY, w: wLen, h: wThick };
    let lonHov = orbitScrollAxis === 'lon';
    ctx.fillStyle = lonHov ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.08)';
    ctx.strokeStyle = lonHov ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(lonX, lonY, wLen, wThick, 4);
    ctx.fill(); ctx.stroke();
    // Lon indicator knob
    let lonFrac = ((isoTheta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / (2 * Math.PI);
    let lonKnobX = lonX + 4 + lonFrac * (wLen - 8);
    ctx.beginPath();
    ctx.arc(lonKnobX, lonY + wThick / 2, 4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fill();
    // Lon label
    ctx.font = '8px -apple-system, sans-serif';
    ctx.fillStyle = lonHov ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.35)';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText('\u03B8 lon', lonX + wLen / 2, lonY - 3);

    // Latitude widget (vertical bar, bottom-left, above lon widget)
    let latX = wMar, latY = lonY - wLen - 24;
    _isoLatRect = { x: latX, y: latY, w: wThick, h: wLen };
    let latHov = orbitScrollAxis === 'lat';
    ctx.fillStyle = latHov ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.08)';
    ctx.strokeStyle = latHov ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(latX, latY, wThick, wLen, 4);
    ctx.fill(); ctx.stroke();
    // Lat indicator knob (top = π/2, bottom = 0)
    let latFrac = 1 - isoPhi / (Math.PI / 2);
    let latKnobY = latY + 4 + latFrac * (wLen - 8);
    ctx.beginPath();
    ctx.arc(latX + wThick / 2, latKnobY, 4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fill();
    // Lat label
    ctx.font = '8px -apple-system, sans-serif';
    ctx.fillStyle = latHov ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.35)';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('\u03C6 lat', latX + wThick + 4, latY + wLen / 2);

    // ── Caption (always on) ──
    {
      ctx.font = '9px -apple-system, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText('OKLCH \u00B7 angle = hue, radius = chroma, height = lightness', isoCanW / 2, isoCanH - 6);
    }
  }

  // Widget hit rects (set during draw)
  var _isoLatRect = null, _isoLonRect = null;
  var _isoBrightLabelRect = null, _isoDarkLabelRect = null;
  // Cached projected curve points for hover detection (set during draw)
  var _isoCurveCache = { frontier: null, dark: null, ideal: null, idealDark: null, closest: null, closestDark: null, maxchroma: null, constchroma: null };

  // ──── Strip (two-line) view ────
  // Find which strip column index is closest to a given hue
  function hueToStripIdx(hue) {
    let h = ((hue % 360) + 360) % 360;
    let best = 0, bestDist = 999;
    for (let i = 0; i < 36; i++) {
      let d = Math.abs(((h - _stripHues[i] + 540) % 360) - 180);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
  }

  // Graph layout constants (right side of widened canvas)
  let stripCanW = 840;
  let stripW = 550;   // strip cells right edge
  let gxL = 620, gxR = 830, gyT = 85, gyB = 435;
  let gPlotW = gxR - gxL, gPlotH = gyB - gyT;

  function drawStripView() {
    // Reset any lab-mode inline styles
    canvas.style.width = '';
    canvas.style.height = '';
    canvas.style.maxWidth = '';
    if (canvas.width !== stripCanW) { canvas.width = stripCanW; canvas.height = H; }
    ctx.clearRect(0, 0, stripCanW, H);

    let padX = 30;
    let cellW = (stripW - padX) / 36;
    let sel = hueToStripIdx(_playerHue1);
    let hovCol = (hoverHue >= 0) ? hueToStripIdx(hoverHue) : -1;

    let textColor = _themeLight ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.85)';
    let subtleColor = _themeLight ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.5)';

    // Vertical layout
    let y_p1b = 80, p1BH = 100;
    let y_p1d = y_p1b + p1BH, p1DH = 30;
    let y_gap = y_p1d + p1DH, gapH = 18;
    let y_p2d = y_gap + gapH, p2DH = 30;
    let y_p2b = y_p2d + p2DH, p2BH = 100;
    let y_end = y_p2b + p2BH;
    // Third strip: per-hue tradeoff sliders
    let y_s3gap = y_end + 6;
    let y_s3 = y_s3gap + 2, s3H = 100;
    let y_s3end = y_s3 + s3H;

    // Draw cells (top two strips)
    for (let i = 0; i < 36; i++) {
      let h1 = _stripHues[i];
      let h1d = ((Math.round(h1) % 360) + 360) % 360;
      let p2info = computeStripP2(h1d, _stripPerHueTradeoff[i]);
      let h2 = p2info.h2;
      let x = padX + i * cellW;

      // P1 bright
      let lc1b = _stripBrightLC[h1d];
      let rgb1b = oklchToRgb(lc1b.L, lc1b.C, h1);
      ctx.fillStyle = `rgb(${rgb1b.r},${rgb1b.g},${rgb1b.b})`;
      ctx.fillRect(x, y_p1b, cellW + 0.5, p1BH);

      // P1 dark
      let lc1d = _stripDarkLC[h1d];
      let rgb1d = oklchToRgb(lc1d.L, lc1d.C, h1);
      ctx.fillStyle = `rgb(${rgb1d.r},${rgb1d.g},${rgb1d.b})`;
      ctx.fillRect(x, y_p1d, cellW + 0.5, p1DH);

      // P2 dark
      let p2dark = computeStripP2Dark(h1d, h2, p2info.L2);
      let rgb2d = oklchToRgb(p2dark.L, p2dark.C, h2);
      ctx.fillStyle = `rgb(${rgb2d.r},${rgb2d.g},${rgb2d.b})`;
      ctx.fillRect(x, y_p2d, cellW + 0.5, p2DH);

      // P2 bright
      let rgb2b = oklchToRgb(p2info.L2, p2info.C2, h2);
      ctx.fillStyle = `rgb(${rgb2b.r},${rgb2b.g},${rgb2b.b})`;
      ctx.fillRect(x, y_p2b, cellW + 0.5, p2BH);

      // Divider
      if (i > 0) {
        ctx.strokeStyle = 'rgba(0,0,0,0.1)';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(x, y_p1b); ctx.lineTo(x, y_end);
        ctx.stroke();
      }
    }

    // ── Third strip: per-hue tradeoff gradient sliders ──
    for (let i = 0; i < 36; i++) {
      let h1 = _stripHues[i];
      let h1d = ((Math.round(h1) % 360) + 360) % 360;
      let x = padX + i * cellW;
      let frontier_i = computePareto(h1d);

      // Draw vertical gradient: each pixel row = a different contrast level
      for (let py = 0; py < s3H; py++) {
        let frac = py / s3H; // 0 = top = 0°, 1 = bottom = 180°
        let contrast = Math.round(frac * 180);
        let fh2 = frontier_i[contrast].h2;
        let fL2, fC2;
        if (_stripSacrificeBoth) {
          fL2 = _stripBrightLC[fh2].L; fC2 = _stripBrightLC[fh2].C;
        } else {
          let lc1 = _stripBrightLC[h1d];
          fL2 = lc1.L; fC2 = Math.min(lc1.C, maxChroma(lc1.L, fh2));
        }
        let frgb = oklchToRgb(fL2, fC2, fh2);
        ctx.fillStyle = `rgb(${frgb.r},${frgb.g},${frgb.b})`;
        ctx.fillRect(x, y_s3 + py, cellW + 0.5, 1);
      }

      // Slider handle for this column
      let sliderFrac = _stripPerHueTradeoff[i] / 180;
      let handleYs = y_s3 + sliderFrac * s3H;
      ctx.strokeStyle = _themeLight ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x + 1, handleYs);
      ctx.lineTo(x + cellW - 1, handleYs);
      ctx.stroke();
      // Small triangle marker
      ctx.fillStyle = _themeLight ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.7)';
      ctx.beginPath();
      ctx.moveTo(x, handleYs - 3);
      ctx.lineTo(x + 4, handleYs);
      ctx.lineTo(x, handleYs + 3);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x + cellW, handleYs - 3);
      ctx.lineTo(x + cellW - 4, handleYs);
      ctx.lineTo(x + cellW, handleYs + 3);
      ctx.closePath();
      ctx.fill();

      // Divider
      if (i > 0) {
        ctx.strokeStyle = 'rgba(0,0,0,0.1)';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(x, y_s3); ctx.lineTo(x, y_s3end);
        ctx.stroke();
      }
    }

    // Third strip selection highlight
    let sx3 = padX + sel * cellW;
    ctx.strokeStyle = _themeLight ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2.5;
    ctx.strokeRect(sx3 - 0.5, y_s3 - 0.5, cellW + 1, s3H + 1);

    // Third strip axis labels
    ctx.font = '9px -apple-system, sans-serif';
    ctx.fillStyle = subtleColor;
    ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText('0\u00B0', padX - 3, y_s3);
    ctx.textBaseline = 'bottom';
    ctx.fillText('180\u00B0', padX - 3, y_s3end);
    ctx.textBaseline = 'middle';
    ctx.fillText('90\u00B0', padX - 3, y_s3 + s3H / 2);

    // Third strip label
    ctx.save();
    ctx.translate(14, y_s3 + s3H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.font = 'bold 10px -apple-system, sans-serif';
    ctx.fillStyle = subtleColor;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('\u0394h', 0, 0);
    ctx.restore();

    // Hover highlight on strips
    if (hovCol >= 0 && hovCol !== sel) {
      let hx = padX + hovCol * cellW;
      ctx.strokeStyle = _themeLight ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(hx, y_p1b, cellW, y_end - y_p1b);
    }

    // Selection highlight on main strips
    let sx = padX + sel * cellW;
    ctx.strokeStyle = _themeLight ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2.5;
    ctx.strokeRect(sx - 0.5, y_p1b - 0.5, cellW + 1, y_end - y_p1b + 1);

    // P1/P2 labels
    let topLabel = _stripSwapped ? 'P2' : 'P1';
    let botLabel = _stripSwapped ? 'P1' : 'P2';
    ctx.font = 'bold 13px -apple-system, sans-serif';
    ctx.fillStyle = textColor;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.save();
    ctx.translate(14, y_p1b + (p1BH + p1DH) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(topLabel, 0, 0);
    ctx.restore();
    ctx.save();
    ctx.translate(14, y_p2d + (p2DH + p2BH) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(botLabel, 0, 0);
    ctx.restore();

    // "vs" in the gap
    ctx.fillStyle = _themeLight ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.15)';
    ctx.font = 'bold 11px -apple-system, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('vs', sx + cellW / 2, y_gap + gapH / 2);

    // Hue labels along top
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = subtleColor;
    for (let k = 0; k < _hueNames.length; k++) {
      let nh = _hueNames[k][0], name = _hueNames[k][1];
      let ni = hueToStripIdx(nh);
      let nx = padX + ni * cellW + cellW / 2;
      ctx.fillText(name, nx, y_p1b - 3);
    }

    // Info line
    let selH1 = _stripHues[sel];
    let selH1d = ((Math.round(selH1) % 360) + 360) % 360;
    let selTradeoff = _stripPerHueTradeoff[sel];
    let selP2 = computeStripP2(selH1d, selTradeoff);
    let selH2 = selP2.h2;
    let slc1 = _stripBrightLC[selH1d];
    let angSep = Math.min(Math.abs(selH2 - selH1d), 360 - Math.abs(selH2 - selH1d));
    let stripMidX = padX + (stripW - padX) / 2;
    ctx.fillStyle = textColor;
    ctx.font = '11px -apple-system, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(topLabel + ': ' + Math.round(selH1) + '\u00B0  ' + botLabel + ': ' + selH2 + '\u00B0  (\u0394' + angSep + '\u00B0)   L\u2081=' + slc1.L.toFixed(2) + '  C\u2081=' + slc1.C.toFixed(3) + '  L\u2082=' + selP2.L2.toFixed(2) + '  C\u2082=' + selP2.C2.toFixed(3), stripMidX, y_s3end + 6);

    // ──── Pareto tradeoff graph ────
    let frontier = computePareto(selH1d);
    let maxDef = 0;
    for (let x2 = 0; x2 <= 180; x2++) maxDef = Math.max(maxDef, frontier[x2].deficit);
    if (maxDef < 0.001) maxDef = 0.05;

    // P1 and P2 colors for the current selection
    let p1rgb = oklchToRgb(slc1.L, slc1.C, selH1);
    let p2rgb = oklchToRgb(selP2.L2, selP2.C2, selH2);
    let p1hex = `rgb(${p1rgb.r},${p1rgb.g},${p1rgb.b})`;
    let p2hex = `rgb(${p2rgb.r},${p2rgb.g},${p2rgb.b})`;

    // Graph background
    ctx.fillStyle = _themeLight ? 'rgba(0,0,0,0.03)' : 'rgba(255,255,255,0.03)';
    ctx.fillRect(gxL, gyT, gPlotW, gPlotH);

    // Grid lines
    ctx.strokeStyle = _themeLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 0.5;
    for (let g = 0; g <= 6; g++) {
      let gy2 = gyT + (g / 6) * gPlotH;
      ctx.beginPath(); ctx.moveTo(gxL, gy2); ctx.lineTo(gxR, gy2); ctx.stroke();
    }
    for (let g = 0; g <= 6; g++) {
      let gx2 = gxL + (g / 6) * gPlotW;
      ctx.beginPath(); ctx.moveTo(gx2, gyT); ctx.lineTo(gx2, gyB); ctx.stroke();
    }

    // Axes in P1 color
    ctx.strokeStyle = p1hex;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(gxL, gyB); ctx.lineTo(gxR, gyB); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(gxL, gyT); ctx.lineTo(gxL, gyB); ctx.stroke();
    ctx.globalAlpha = 1.0;

    // Outline behind colored curve
    ctx.setLineDash([]);
    ctx.strokeStyle = _themeLight ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    for (let x2 = 0; x2 <= 180; x2++) {
      let px = gxL + (x2 / 180) * gPlotW;
      let py = gyB - (frontier[x2].deficit / maxDef) * gPlotH;
      if (x2 === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Colored Pareto curve segments
    for (let x2 = 0; x2 < 180; x2++) {
      let px1 = gxL + (x2 / 180) * gPlotW;
      let py1 = gyB - (frontier[x2].deficit / maxDef) * gPlotH;
      let px2n = gxL + ((x2 + 1) / 180) * gPlotW;
      let py2n = gyB - (frontier[x2 + 1].deficit / maxDef) * gPlotH;
      let fh2 = frontier[x2].h2;
      let fL2, fC2;
      if (_stripSacrificeBoth) {
        fL2 = _stripBrightLC[fh2].L; fC2 = _stripBrightLC[fh2].C;
      } else {
        fL2 = slc1.L; fC2 = Math.min(slc1.C, maxChroma(slc1.L, fh2));
      }
      let frgb = oklchToRgb(fL2, fC2, fh2);
      ctx.strokeStyle = `rgb(${frgb.r},${frgb.g},${frgb.b})`;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(px1, py1);
      ctx.lineTo(px2n, py2n);
      ctx.stroke();
    }

    // Current tradeoff handle position
    let handleX = gxL + (selTradeoff / 180) * gPlotW;
    let handleY = gyB - (frontier[selTradeoff].deficit / maxDef) * gPlotH;

    // Gradient guide lines (P2→P1 color)
    // Vertical guide: gradient varying in hue angle from P2 to P1
    let vGrad = ctx.createLinearGradient(handleX, handleY, handleX, gyB);
    vGrad.addColorStop(0, p2hex);
    vGrad.addColorStop(1, p1hex);
    ctx.strokeStyle = vGrad;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(handleX, handleY); ctx.lineTo(handleX, gyB); ctx.stroke();

    // Horizontal guide: gradient varying in C (or L+C) from P2 to P1
    let hGrad = ctx.createLinearGradient(gxL, handleY, handleX, handleY);
    hGrad.addColorStop(0, p1hex);
    hGrad.addColorStop(1, p2hex);
    ctx.strokeStyle = hGrad;
    ctx.beginPath(); ctx.moveTo(handleX, handleY); ctx.lineTo(gxL, handleY); ctx.stroke();
    ctx.setLineDash([]);

    // Handle circle — P2 color
    ctx.beginPath();
    ctx.arc(handleX, handleY, 7, 0, Math.PI * 2);
    ctx.fillStyle = p2hex;
    ctx.fill();
    ctx.strokeStyle = _themeLight ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Y-axis tick labels
    ctx.font = '10px -apple-system, sans-serif';
    ctx.fillStyle = textColor;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    let yTicks = 4;
    for (let t = 0; t <= yTicks; t++) {
      let frac = t / yTicks;
      let val = maxDef * frac;
      let ty = gyB - frac * gPlotH;
      ctx.fillText(val.toFixed(3), gxL - 4, ty);
    }

    // X-axis tick labels
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let deg = 0; deg <= 180; deg += 30) {
      let tx = gxL + (deg / 180) * gPlotW;
      ctx.fillText(deg + '\u00B0', tx, gyB + 4);
    }

    // X-axis label
    ctx.font = '11px -apple-system, sans-serif';
    ctx.fillStyle = textColor;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText('Minimum hue contrast', gxL + gPlotW / 2, gyB + 20);

    // Y-axis label (rotated)
    ctx.save();
    ctx.translate(gxL - 42, gyT + gPlotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.fillStyle = textColor;
    ctx.fillText(_stripSacrificeBoth ? 'L + C distance' : 'Chroma sacrifice', 0, 0);
    ctx.restore();

    // Current handle values
    ctx.font = '11px -apple-system, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = textColor;
    ctx.fillText('\u0394h \u2265 ' + selTradeoff + '\u00B0   deficit = ' + frontier[selTradeoff].deficit.toFixed(3), gxL + gPlotW / 2, gyT - 6);

    // Title
    ctx.font = 'bold 12px -apple-system, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = textColor;
    ctx.fillText('Contrast vs Sacrifice Tradeoff', gxL + gPlotW / 2, gyT - 22);
  }
  // ──── Input handling ────
  function hueFromEvent(e) { let p = canvasCoords(e); return snapHue(mouseToHue(p.x, p.y)); }

  function hitTest(e) {
    if (_displayMode === 'lab' || _displayMode === 'strip') return null;
    let p = canvasCoords(e);
    let dist = Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2);
    // Check proximity to handle circles
    function distToHandle(playerHue) {
      let s = snapHue(playerHue);
      let d = Math.round(s) % 360;
      let ang = hueToAngle(s);
      let rO = outerEdge(d) + expandPx;
      let tx = cx + Math.cos(ang) * (rO + 17);
      let ty = cy + Math.sin(ang) * (rO + 17);
      return Math.sqrt((p.x - tx) ** 2 + (p.y - ty) ** 2);
    }
    let d1 = distToHandle(_playerHue1);
    let d2 = distToHandle(_playerHue2);
    if (d1 < 22 && d1 <= d2) return 'p1';
    if (d2 < 22) return 'p2';
    let hue = mouseToHue(p.x, p.y);
    let deg = Math.round(hue) % 360;
    if (dist > innerEdge(deg) - 10 && dist < outerEdge(deg) + 10) return 'ring';
    return null;
  }

  function updateSwatches() {
    let s1b = document.getElementById('swatch-p1-bright');
    let s1d = document.getElementById('swatch-p1-dark');
    let s2b = document.getElementById('swatch-p2-bright');
    let s2d = document.getElementById('swatch-p2-dark');
    let isStripLike2 = (_displayMode === 'strip' || _displayMode === 'lab');
    let swap = (isStripLike2 && _stripSwapped);
    let derivedRef = (isStripLike2 && !_stripSacrificeBoth) ? _playerHue1 : undefined;
    let h1eff = swap ? _playerHue2 : _playerHue1;
    let h2eff = swap ? _playerHue1 : _playerHue2;
    let r1 = swap ? derivedRef : undefined;
    let r2 = swap ? undefined : derivedRef;
    if (s1b) s1b.style.background = hueToHex(h1eff, false, r1);
    if (s1d) s1d.style.background = hueToHex(h1eff, true, r1);
    if (isStripLike2 && _stripSacrificeMode === 2) {
      // Surface mode: P2 swatches from stored L/C
      let p2rgb = oklchToRgb(_surfaceP2L, _surfaceP2C, h2eff);
      if (s2b) s2b.style.background = rgbToHex(p2rgb.r, p2rgb.g, p2rgb.b);
      let darkL = Math.max(0, _surfaceP2L - 0.28);
      let darkC = Math.min(_surfaceP2C, maxChroma(darkL, h2eff));
      let p2dRgb = oklchToRgb(darkL, darkC, h2eff);
      if (s2d) s2d.style.background = rgbToHex(p2dRgb.r, p2dRgb.g, p2dRgb.b);
    } else {
      if (s2b) s2b.style.background = hueToHex(h2eff, false, r2);
      if (s2d) s2d.style.background = hueToHex(h2eff, true, r2);
    }
  }

  function applyHues() {
    // Strip/Lab modes use _stripHues (non-uniform spacing), don't snap to 10° grid
    if (_displayMode !== 'strip' && _displayMode !== 'lab') {
      _playerHue1 = snapHue(_playerHue1);
      _playerHue2 = snapHue(_playerHue2);
    }
    updateColorScheme();
    updateSwatches();
    drawRing();
    if (typeof redraw === 'function') redraw();
  }

  // Click: handle = grab, ring = move nearest (no grab)
  canvas.addEventListener('mousedown', function (e) {
    // Strip mode: click selects a column OR drags graph handle
    if (_displayMode === 'strip') {
      let p = canvasCoords(e);
      let padX = 30, cellW = (stripW - padX) / 36;
      // Third strip vertical layout (must match drawStripView)
      let y_s3 = 80 + 100 + 30 + 18 + 30 + 100 + 6 + 2;  // y_p1b+p1BH+p1DH+gapH+p2DH+p2BH+gap+2
      let s3H = 100;
      // Check if click is on the Pareto graph area
      if (p.x >= gxL && p.x <= gxR && p.y >= gyT && p.y <= gyB) {
        draggingGraph = true;
        let frac = Math.max(0, Math.min(1, (p.x - gxL) / (gxR - gxL)));
        let selIdx = hueToStripIdx(_playerHue1);
        _stripPerHueTradeoff[selIdx] = Math.round(frac * 180);
        let h1d = ((Math.round(_playerHue1) % 360) + 360) % 360;
        if (_colorPickerLocked) _playerHue2 = computeStripP2(h1d, _stripPerHueTradeoff[selIdx]).h2;
        applyHues();
        return;
      }
      // Check third strip slider drag
      let col3 = Math.floor((p.x - padX) / cellW);
      if (col3 >= 0 && col3 < 36 && p.y >= y_s3 && p.y <= y_s3 + s3H) {
        draggingSlider = col3;
        let frac = Math.max(0, Math.min(1, (p.y - y_s3) / s3H));
        _stripPerHueTradeoff[col3] = Math.round(frac * 180);
        // If this is the selected column, update P2 immediately
        let selIdx = hueToStripIdx(_playerHue1);
        if (col3 === selIdx) {
          let h1d = ((Math.round(_playerHue1) % 360) + 360) % 360;
          if (_colorPickerLocked) _playerHue2 = computeStripP2(h1d, _stripPerHueTradeoff[selIdx]).h2;
        }
        applyHues();
        return;
      }
      // Main strip column click
      let col = Math.floor((p.x - padX) / cellW);
      if (col >= 0 && col < 36 && p.y >= 80 && p.y < y_s3) {
        _playerHue1 = _stripHues[col];
        let h1d = ((Math.round(_playerHue1) % 360) + 360) % 360;
        if (_colorPickerLocked) _playerHue2 = computeStripP2(h1d, _stripPerHueTradeoff[col]).h2;
        checkDetent(1, _playerHue1);
        applyHues();
      }
      return;
    }
    // Lab/3D isometric mode: click P1 on frontier, or grab P2 on sacrifice curve, or surface pick, or orbit
    if (_displayMode === 'lab') {
      let p = canvasCoords(e);
      // In surface mode, check for surface click (pick P2 on ray-cast Pareto surface)
      if (_stripSacrificeMode === 2 && _raySurfaceCache.pts) {
        let pts = _raySurfaceCache.pts;
        // Find the nearest surface point to the click
        let bestSurfDist = Infinity, bestSurfPt = null;
        for (let ti = 0; ti < pts.length; ti++) {
          for (let pi = 0; pi < pts[ti].length; pi++) {
            let pt = pts[ti][pi];
            if (!pt || !pt.pareto) continue;
            let sp = isoProjectLCH(pt.L, pt.C, pt.h);
            let d = (p.x - sp.x) ** 2 + (p.y - sp.y) ** 2;
            if (d < bestSurfDist) { bestSurfDist = d; bestSurfPt = pt; }
          }
        }
        // Also check frontier swatches for P1 selection
        let bestFIdx = -1, bestFDist = 25;
        for (let ii = 0; ii < 36; ii++) {
          let h = _stripHues[ii];
          let hd = ((Math.round(h) % 360) + 360) % 360;
          let lc = _stripBrightLC[hd];
          let sp = isoProjectLCH(lc.L, lc.C, h);
          let d = Math.sqrt((p.x - sp.x) ** 2 + (p.y - sp.y) ** 2);
          if (d < bestFDist) { bestFDist = d; bestFIdx = ii; }
        }
        if (bestFIdx >= 0 && bestFDist < Math.sqrt(bestSurfDist)) {
          // Frontier swatch is closer — select P1
          _playerHue1 = _stripHues[bestFIdx];
          _raySurfaceCache.h1 = -1; // invalidate surface cache for new P1
          // Rebuild and set P2 to nearest Pareto point
          let newH1d = ((Math.round(_playerHue1) % 360) + 360) % 360;
          buildParetoSurface(newH1d);
          let volPt = findBestP2InVolume(newH1d);
          if (volPt) {
            _surfaceP2L = volPt.L;
            _surfaceP2C = volPt.C;
            _playerHue2 = volPt.h;
          }
          checkDetent(1, _playerHue1);
          applyHues();
          return;
        }
        if (bestSurfDist < 900 && bestSurfPt) {  // within 30px
          // Pick this point as P2 on Pareto surface
          _playerHue2 = bestSurfPt.h;
          _surfaceP2L = bestSurfPt.L;
          _surfaceP2C = bestSurfPt.C;
          applyHues();
          return;
        }
        // Fall through to orbit
        draggingOrbit = true;
        orbitLastX = e.clientX;
        orbitLastY = e.clientY;
        canvas.style.cursor = 'move';
        return;
      }
      // Check proximity to P2 indicator first (sacrifice curve)
      let sel1i = hueToStripIdx(_playerHue1);
      let h1d = ((Math.round(_stripHues[sel1i]) % 360) + 360) % 360;
      let selTdff = _stripPerHueTradeoff[sel1i];
      let selP2info = computeStripP2(h1d, selTdff);
      let p2sp = isoProjectLCH(selP2info.L2, selP2info.C2, selP2info.h2);
      let dp2 = Math.sqrt((p.x - p2sp.x) ** 2 + (p.y - p2sp.y) ** 2);
      if (dp2 < 18) {
        draggingPolarP2 = true;
        canvas.style.cursor = 'grabbing';
        return;
      }
      // Click selects P1: find nearest frontier swatch (bright or dark)
      let bestIdx = -1, bestDist = 30;
      for (let dark = 0; dark < 2; dark++) {
        for (let ii = 0; ii < 36; ii++) {
          let h = _stripHues[ii];
          let hd = ((Math.round(h) % 360) + 360) % 360;
          let lc = dark ? _stripDarkLC[hd] : _stripBrightLC[hd];
          let sp = isoProjectLCH(lc.L, lc.C, h);
          let d = Math.sqrt((p.x - sp.x) ** 2 + (p.y - sp.y) ** 2);
          if (d < bestDist) { bestDist = d; bestIdx = ii; }
        }
      }
      if (bestIdx >= 0) {
        _playerHue1 = _stripHues[bestIdx];
        let h1dn = ((Math.round(_playerHue1) % 360) + 360) % 360;
        if (_colorPickerLocked) {
          let selIdx = hueToStripIdx(_playerHue1);
          _playerHue2 = computeStripP2(h1dn, _stripPerHueTradeoff[selIdx]).h2;
        }
        checkDetent(1, _playerHue1);
        applyHues();
        return;
      }
      // Nothing hit — start orbit drag
      draggingOrbit = true;
      orbitLastX = e.clientX;
      orbitLastY = e.clientY;
      canvas.style.cursor = 'move';
      return;
    }
    if (dragging) {
      // Already grabbed — click confirms/releases
      dragging = null;
      hoverHandle = null;
      canvas.style.cursor = '';
      drawRing();
      return;
    }
    let hit = hitTest(e);
    if (hit === 'p1' || hit === 'p2') {
      dragging = hit;
      canvas.style.cursor = 'grabbing';
      drawRing();
    } else if (hit === 'ring') {
      // Move nearest handle here but don't grab
      let ang = hueFromEvent(e);
      let d1 = Math.abs(((ang - _playerHue1 + 540) % 360) - 180);
      let d2 = Math.abs(((ang - _playerHue2 + 540) % 360) - 180);
      if (d1 <= d2) {
        _playerHue1 = ang;
        if (_colorPickerLocked) _playerHue2 = snapHue(_playerHue1 + 180);
        checkDetent(1, _playerHue1);
      } else {
        _playerHue2 = ang;
        if (_colorPickerLocked) _playerHue1 = snapHue(_playerHue2 + 180);
        checkDetent(2, _playerHue2);
      }
      applyHues();
    }
  });

  canvas.addEventListener('mouseup', function () {
    if (draggingGraph) {
      draggingGraph = false;
      canvas.style.cursor = '';
    }
    if (draggingSlider >= 0) {
      draggingSlider = -1;
      canvas.style.cursor = '';
    }
    if (draggingPolarP2) {
      draggingPolarP2 = false;
      canvas.style.cursor = '';
    }
    if (draggingOrbit) {
      draggingOrbit = false;
      canvas.style.cursor = '';
    }
  });

  canvas.addEventListener('mousemove', function (e) {
    // Strip mode: hover column or drag graph
    if (_displayMode === 'strip') {
      let p = canvasCoords(e);
      let padX2 = 30, cellW2 = (stripW - padX2) / 36;
      let y_s3m = 80 + 100 + 30 + 18 + 30 + 100 + 6 + 2;
      let s3Hm = 100;
      // Slider drag in progress
      if (draggingSlider >= 0) {
        let frac = Math.max(0, Math.min(1, (p.y - y_s3m) / s3Hm));
        _stripPerHueTradeoff[draggingSlider] = Math.round(frac * 180);
        canvas.style.cursor = 'ns-resize';
        let selIdx = hueToStripIdx(_playerHue1);
        if (draggingSlider === selIdx) {
          let h1d = ((Math.round(_playerHue1) % 360) + 360) % 360;
          if (_colorPickerLocked) _playerHue2 = computeStripP2(h1d, _stripPerHueTradeoff[selIdx]).h2;
        }
        applyHues();
        return;
      }
      // Graph drag in progress
      if (draggingGraph) {
        let frac = Math.max(0, Math.min(1, (p.x - gxL) / (gxR - gxL)));
        let selIdx = hueToStripIdx(_playerHue1);
        _stripPerHueTradeoff[selIdx] = Math.round(frac * 180);
        canvas.style.cursor = 'grabbing';
        let h1d = ((Math.round(_playerHue1) % 360) + 360) % 360;
        if (_colorPickerLocked) _playerHue2 = computeStripP2(h1d, _stripPerHueTradeoff[selIdx]).h2;
        applyHues();
        return;
      }
      // Check graph hover
      if (p.x >= gxL && p.x <= gxR && p.y >= gyT && p.y <= gyB) {
        canvas.style.cursor = 'grab';
        return;
      }
      // Check third strip hover
      let col3 = Math.floor((p.x - padX2) / cellW2);
      if (col3 >= 0 && col3 < 36 && p.y >= y_s3m && p.y <= y_s3m + s3Hm) {
        canvas.style.cursor = 'ns-resize';
        return;
      }
      let col = Math.floor((p.x - padX2) / cellW2);
      let newHH = (col >= 0 && col < 36) ? _stripHues[col] : -1;
      canvas.style.cursor = (newHH >= 0) ? 'pointer' : '';
      if (newHH !== hoverHue) { hoverHue = newHH; drawRing(); }
      return;
    }
    // Lab/polar mode: orbit drag, P2 drag, or hover cursor
    if (_displayMode === 'lab') {
      // Orbit drag in progress: rotate view
      if (draggingOrbit) {
        isoTheta += (e.clientX - orbitLastX) * 0.005;
        isoPhi = Math.max(0, Math.min(Math.PI / 2, isoPhi + (e.clientY - orbitLastY) * 0.005));
        orbitLastX = e.clientX;
        orbitLastY = e.clientY;
        canvas.style.cursor = 'move';
        drawRing();
        return;
      }
      let p = canvasCoords(e);
      // P2 drag in progress: snap to nearest position on sacrifice curve
      if (draggingPolarP2) {
        let sel1i = hueToStripIdx(_playerHue1);
        let h1d = ((Math.round(_stripHues[sel1i]) % 360) + 360) % 360;
        let frt = computePareto(h1d);
        // Find curve point closest to mouse (using iso projection)
        let bestContrast = _stripPerHueTradeoff[sel1i];
        let bestDist2 = Infinity;
        for (let x = 0; x <= 180; x++) {
          let fh2 = frt[x].h2;
          let fL2, fC2;
          if (_stripSacrificeBoth) {
            fL2 = _stripBrightLC[fh2].L; fC2 = _stripBrightLC[fh2].C;
          } else {
            let lc1 = _stripBrightLC[h1d];
            fL2 = lc1.L; fC2 = Math.min(lc1.C, maxChroma(lc1.L, fh2));
          }
          let sp = isoProjectLCH(fL2, fC2, fh2);
          let dd = (p.x - sp.x) ** 2 + (p.y - sp.y) ** 2;
          if (dd < bestDist2) { bestDist2 = dd; bestContrast = x; }
        }
        _stripPerHueTradeoff[sel1i] = bestContrast;
        let p2info = computeStripP2(h1d, bestContrast);
        _playerHue2 = p2info.h2;
        canvas.style.cursor = 'grabbing';
        applyHues();
        return;
      }
      // Hover: check proximity to P2 indicator for grab cursor
      let sel1i = hueToStripIdx(_playerHue1);
      let h1d = ((Math.round(_stripHues[sel1i]) % 360) + 360) % 360;
      let selTdff = _stripPerHueTradeoff[sel1i];
      let selP2info = computeStripP2(h1d, selTdff);
      let p2sp = isoProjectLCH(selP2info.L2, selP2info.C2, selP2info.h2);
      let dp2 = Math.sqrt((p.x - p2sp.x) ** 2 + (p.y - p2sp.y) ** 2);
      if (dp2 < 18) {
        canvas.style.cursor = 'grab';
        return;
      }
      // Check proximity to any frontier swatch
      let nearSwatch = false;
      for (let dark = 0; dark < 2; dark++) {
        for (let ii = 0; ii < 36; ii++) {
          let h = _stripHues[ii];
          let hd = ((Math.round(h) % 360) + 360) % 360;
          let lc = dark ? _stripDarkLC[hd] : _stripBrightLC[hd];
          let sp = isoProjectLCH(lc.L, lc.C, h);
          let d = Math.sqrt((p.x - sp.x) ** 2 + (p.y - sp.y) ** 2);
          if (d < 20) { nearSwatch = true; break; }
        }
        if (nearSwatch) break;
      }
      canvas.style.cursor = nearSwatch ? 'pointer' : 'move';
      // Check frontier label hover (hide the other frontier)
      let oldLabel = isoHoverLabel;
      isoHoverLabel = null;
      if (_isoBrightLabelRect && p.x >= _isoBrightLabelRect.x && p.x <= _isoBrightLabelRect.x + _isoBrightLabelRect.w &&
        p.y >= _isoBrightLabelRect.y && p.y <= _isoBrightLabelRect.y + _isoBrightLabelRect.h) {
        isoHoverLabel = 'bright';
        canvas.style.cursor = 'pointer';
      } else if (_isoDarkLabelRect && p.x >= _isoDarkLabelRect.x && p.x <= _isoDarkLabelRect.x + _isoDarkLabelRect.w &&
        p.y >= _isoDarkLabelRect.y && p.y <= _isoDarkLabelRect.y + _isoDarkLabelRect.h) {
        isoHoverLabel = 'dark';
        canvas.style.cursor = 'pointer';
      }
      if (isoHoverLabel !== oldLabel) drawRing();
      // Check curve hover proximity
      let oldHoverCurve = _labHoverCurve;
      _labHoverCurve = null;
      _labMouseX = p.x; _labMouseY = p.y;
      let curveThresh = 14; // px distance threshold
      let bestCurveDist = curveThresh;
      function checkCurveProx(pts, name) {
        if (!pts) return;
        for (let i = 0; i < pts.length; i++) {
          let cp = pts[i];
          let dx = p.x - cp.x, dy = p.y - cp.y;
          let d = Math.sqrt(dx * dx + dy * dy);
          if (d < bestCurveDist) { bestCurveDist = d; _labHoverCurve = name; }
        }
      }
      checkCurveProx(_isoCurveCache.frontier, 'frontier');
      checkCurveProx(_isoCurveCache.dark, 'dark');
      checkCurveProx(_isoCurveCache.ideal, 'ideal');
      checkCurveProx(_isoCurveCache.idealDark, 'ideal');
      checkCurveProx(_isoCurveCache.closest, 'closest');
      checkCurveProx(_isoCurveCache.closestDark, 'closest');
      checkCurveProx(_isoCurveCache.maxchroma, 'maxchroma');
      checkCurveProx(_isoCurveCache.constchroma, 'constchroma');
      if (_labHoverCurve !== oldHoverCurve) drawRing();
      // Check widget hover for scroll axis control
      let oldAxis = orbitScrollAxis;
      orbitScrollAxis = null;
      if (_isoLatRect && p.x >= _isoLatRect.x && p.x <= _isoLatRect.x + _isoLatRect.w &&
        p.y >= _isoLatRect.y && p.y <= _isoLatRect.y + _isoLatRect.h) {
        orbitScrollAxis = 'lat';
        canvas.style.cursor = 'ns-resize';
      } else if (_isoLonRect && p.x >= _isoLonRect.x && p.x <= _isoLonRect.x + _isoLonRect.w &&
        p.y >= _isoLonRect.y && p.y <= _isoLonRect.y + _isoLonRect.h) {
        orbitScrollAxis = 'lon';
        canvas.style.cursor = 'ew-resize';
      }
      if (orbitScrollAxis !== oldAxis) drawRing();
      return;
    }
    if (dragging) {
      handleDrag(e);
      return;
    }
    // Hover detection
    let hit = hitTest(e);
    let newHoverHandle = null;
    let newHoverHue = -1;
    if (hit === 'p1' || hit === 'p2') {
      newHoverHandle = hit;
      canvas.style.cursor = 'grab';
    } else if (hit === 'ring') {
      newHoverHue = hueFromEvent(e);
      canvas.style.cursor = 'pointer';
    } else {
      canvas.style.cursor = '';
    }
    if (newHoverHandle !== hoverHandle || newHoverHue !== hoverHue) {
      hoverHandle = newHoverHandle;
      hoverHue = newHoverHue;
      drawRing();
    }
  });

  canvas.addEventListener('mouseleave', function () {
    if (orbitScrollAxis) { orbitScrollAxis = null; drawRing(); }
    if (hoverHandle || hoverHue >= 0) {
      hoverHandle = null; hoverHue = -1;
      canvas.style.cursor = '';
      drawRing();
    }
  });

  // Redraw on resize so lab view fills available space
  window.addEventListener('resize', function () {
    isoSized = false;          // force canvas re-measure on next draw
    if (_displayMode === 'lab') drawRing();
  });

  // Scroll wheel with accumulator (halved sensitivity)
  let scrollAccum = 0;
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    // Strip mode: scroll moves selection left/right
    if (_displayMode === 'strip') {
      scrollAccum += e.deltaY;
      if (Math.abs(scrollAccum) < 60) return;
      let dir = Math.sign(scrollAccum);
      scrollAccum = 0;
      let idx = hueToStripIdx(_playerHue1);
      idx = ((idx + dir) % 36 + 36) % 36;
      _playerHue1 = _stripHues[idx];
      let h1d = ((Math.round(_playerHue1) % 360) + 360) % 360;
      let newIdx = hueToStripIdx(_playerHue1);
      if (_colorPickerLocked) _playerHue2 = computeStripP2(h1d, _stripPerHueTradeoff[newIdx]).h2;
      checkDetent(1, _playerHue1);
      applyHues();
      return;
    }
    // Lab/polar mode: orbit axis scroll or P1 hue scroll
    if (_displayMode === 'lab') {
      // If hovering a widget, scroll controls that orbit axis
      if (orbitScrollAxis === 'lat') {
        isoPhi = Math.max(0, Math.min(Math.PI / 2, isoPhi - e.deltaY * 0.003));
        drawRing();
        return;
      }
      if (orbitScrollAxis === 'lon') {
        isoTheta += e.deltaY * 0.003;
        drawRing();
        return;
      }
      // Check if cursor is inside gamut silhouette
      let gInside = false;
      if (_gamutMaskCanvas) {
        let rect = canvas.getBoundingClientRect();
        let mx = (e.clientX - rect.left) * (canvas.width / rect.width);
        let my = (e.clientY - rect.top) * (canvas.height / rect.height);
        let pixel = _gamutMaskCanvas.getContext('2d').getImageData(
          Math.max(0, Math.min(Math.round(mx), isoCanW - 1)),
          Math.max(0, Math.min(Math.round(my), isoCanH - 1)), 1, 1).data;
        gInside = pixel[0] > 128;
      }
      if (!gInside) {
        // Outside gamut: Y = latitude, X = longitude
        if (Math.abs(e.deltaY) > 0.5) {
          isoPhi = Math.max(0, Math.min(Math.PI / 2, isoPhi - e.deltaY * 0.003));
        }
        if (Math.abs(e.deltaX) > 0.5) {
          isoTheta += e.deltaX * 0.003;
        }
        drawRing();
        return;
      }
      // Inside gamut: both axes cycle swatches
      let delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      scrollAccum += delta;
      if (Math.abs(scrollAccum) < 60) return;
      let dir = Math.sign(scrollAccum);
      scrollAccum = 0;
      let idx = hueToStripIdx(_playerHue1);
      let newIdx = ((idx + dir) % 36 + 36) % 36;
      _playerHue1 = _stripHues[newIdx];
      let h1d = ((Math.round(_playerHue1) % 360) + 360) % 360;
      if (_stripSacrificeMode === 2) {
        buildParetoSurface(h1d);
        let volPt2 = findBestP2InVolume(h1d);
        if (volPt2) {
          _surfaceP2L = volPt2.L;
          _surfaceP2C = volPt2.C;
          _playerHue2 = volPt2.h;
        }
      } else if (_colorPickerLocked) {
        _playerHue2 = computeStripP2(h1d, _stripPerHueTradeoff[newIdx]).h2;
      }
      checkDetent(1, _playerHue1);
      applyHues();
      return;
    }
    scrollAccum += e.deltaY;
    if (Math.abs(scrollAccum) < 60) return;
    let steps = Math.sign(scrollAccum);
    scrollAccum = 0;
    let ang = hueFromEvent(e);
    let d1 = Math.abs(((ang - _playerHue1 + 540) % 360) - 180);
    let d2 = Math.abs(((ang - _playerHue2 + 540) % 360) - 180);
    let target = (d1 <= d2) ? 'p1' : 'p2';
    if (target === 'p1') {
      _playerHue1 = snapHue(_playerHue1 + steps * _stopStep);
      if (_colorPickerLocked) _playerHue2 = snapHue(_playerHue1 + 180);
      checkDetent(1, _playerHue1);
    } else {
      _playerHue2 = snapHue(_playerHue2 + steps * _stopStep);
      if (_colorPickerLocked) _playerHue1 = snapHue(_playerHue2 + 180);
      checkDetent(2, _playerHue2);
    }
    applyHues();
  }, { passive: false });

  function handleDrag(e) {
    let ang = hueFromEvent(e);
    if (dragging === 'p1') {
      _playerHue1 = ang;
      if (_colorPickerLocked) _playerHue2 = snapHue(_playerHue1 + 180);
      checkDetent(1, _playerHue1);
    } else if (dragging === 'p2') {
      _playerHue2 = ang;
      if (_colorPickerLocked) _playerHue1 = snapHue(_playerHue2 + 180);
      checkDetent(2, _playerHue2);
    }
    applyHues();
  }

  // Lock/unlock button
  let lockBtn = document.getElementById('color-lock-btn');
  if (lockBtn) {
    lockBtn.addEventListener('click', function () {
      _colorPickerLocked = !_colorPickerLocked;
      lockBtn.classList.toggle('color-locked', _colorPickerLocked);
      lockBtn.querySelector('span').textContent = _colorPickerLocked ? 'Locked' : 'Unlocked';
      let path = lockBtn.querySelector('path');
      if (path) path.setAttribute('d', _colorPickerLocked ? 'M7 11V7a5 5 0 0 1 10 0v4' : 'M7 11V7a5 5 0 0 1 9.9-1');
      if (_colorPickerLocked) {
        if (_displayMode === 'strip' || _displayMode === 'lab') {
          let h1d = ((Math.round(_playerHue1) % 360) + 360) % 360;
          let selIdx = hueToStripIdx(_playerHue1);
          _playerHue2 = computeStripP2(h1d, _stripPerHueTradeoff[selIdx]).h2;
        } else {
          _playerHue2 = snapHue(_playerHue1 + 180);
        }
        applyHues();
      }
    });
  }

  // Swap button
  let swapBtn = document.getElementById('color-swap-btn');
  if (swapBtn) {
    swapBtn.addEventListener('click', function () {
      if (_displayMode === 'strip' || _displayMode === 'lab') {
        _stripSwapped = !_stripSwapped;
      } else {
        let tmp = _playerHue1; _playerHue1 = _playerHue2; _playerHue2 = tmp;
      }
      applyHues();
    });
  }

  // Shape switch toggle (4-state: Gamut / Circle / Strip / Lab)
  let shapeToggle = document.getElementById('color-shape-toggle');
  let sacrificeBtn = document.getElementById('color-sacrifice-btn');

  // Show/hide sacrifice button based on mode
  let sacrificeModeLabels = ['Chroma only', 'Chroma + L', 'Surface'];
  function updateSacrificeBtn() {
    if (!sacrificeBtn) return;
    let show = _displayMode === 'strip' || _displayMode === 'lab';
    sacrificeBtn.classList.toggle('sacrifice-hidden', !show);
    sacrificeBtn.querySelector('span').textContent = sacrificeModeLabels[_stripSacrificeMode];
  }

  if (sacrificeBtn) {
    sacrificeBtn.addEventListener('click', function () {
      // Surface mode only available in lab
      let maxMode = _displayMode === 'lab' ? 2 : 1;
      _stripSacrificeMode = (_stripSacrificeMode + 1) % (maxMode + 1);
      _stripSacrificeBoth = _stripSacrificeMode >= 1;
      sacrificeBtn.querySelector('span').textContent = sacrificeModeLabels[_stripSacrificeMode];
      updateAnimateBtn();
      let h1d = ((Math.round(_playerHue1) % 360) + 360) % 360;
      let selIdx = hueToStripIdx(_playerHue1);
      if (_stripSacrificeMode === 2) {
        // Initialize surface P2 to the nearest Pareto point to ideal
        buildParetoSurface(h1d);
        let bestPt = findBestP2InVolume(h1d);
        if (bestPt) {
          _surfaceP2L = bestPt.L;
          _surfaceP2C = bestPt.C;
          _playerHue2 = bestPt.h;
        } else {
          let p2info = computeStripP2(h1d, _stripPerHueTradeoff[selIdx]);
          _surfaceP2L = p2info.L2;
          _surfaceP2C = p2info.C2;
          _playerHue2 = p2info.h2;
        }
      } else if (_colorPickerLocked) {
        _playerHue2 = computeStripP2(h1d, _stripPerHueTradeoff[selIdx]).h2;
      }
      applyHues();
    });
  }

  // Animate button: show/hide based on surface mode, triggers ray expansion animation
  let animateBtn = document.getElementById('color-animate-btn');
  function updateAnimateBtn() {
    if (!animateBtn) return;
    let show = _displayMode === 'lab' && _stripSacrificeMode === 2;
    animateBtn.classList.toggle('sacrifice-hidden', !show);
    if (typeof updateParetoSliders === 'function') updateParetoSliders();
  }
  if (animateBtn) {
    animateBtn.addEventListener('click', function () {
      if (_displayMode !== 'lab' || _stripSacrificeMode !== 2) return;
      _paretoAnimating = true;
      _paretoAnimStart = performance.now();
      // Ensure surface is built
      let h1d = ((Math.round(_playerHue1) % 360) + 360) % 360;
      if (_raySurfaceCache.h1 !== h1d) buildParetoSurface(h1d);
      drawRing();
    });
  }

  if (shapeToggle) {
    shapeToggle.addEventListener('click', function (e) {
      let target = e.target.closest('.shape-toggle-label');
      if (!target) return;
      let newMode;
      if (target.classList.contains('shape-label-gamut')) newMode = 'gamut';
      else if (target.classList.contains('shape-label-circle')) newMode = 'circle';
      else if (target.classList.contains('shape-label-strip')) newMode = 'strip';
      else if (target.classList.contains('shape-label-lab')) newMode = 'lab';
      else return;
      if (newMode === _displayMode) return;
      shapeToggle.classList.remove('shape-circle', 'shape-strip', 'shape-lab');
      if (newMode === 'circle') shapeToggle.classList.add('shape-circle');
      else if (newMode === 'strip') shapeToggle.classList.add('shape-strip');
      else if (newMode === 'lab') shapeToggle.classList.add('shape-lab');
      _displayMode = newMode;
      isoSized = false;          // force re-measure when entering lab view
      updateSacrificeBtn();
      updateAnimateBtn();
      updateLabToggleBar();
      if (newMode === 'gamut') { _useCircle = false; animateShape(); }
      else if (newMode === 'circle') { _useCircle = true; animateShape(); }
      else { drawRing(); }
    });
  }

  function animateShape() {
    let target = _useCircle ? 0 : 1;
    if (_animFrame) cancelAnimationFrame(_animFrame);
    function step() {
      let diff = target - _shapeLerp;
      if (Math.abs(diff) < 0.01) {
        _shapeLerp = target;
        drawRing();
        _animFrame = null;
        return;
      }
      _shapeLerp += diff * 0.12;
      drawRing();
      _animFrame = requestAnimationFrame(step);
    }
    _animFrame = requestAnimationFrame(step);
  }

  // ── Lab viewport toggle bar ──
  let labToggleBar = document.getElementById('lab-toggle-bar');
  function updateLabToggleBar() {
    if (!labToggleBar) return;
    labToggleBar.classList.toggle('lab-toggle-hidden', _displayMode !== 'lab');
  }
  updateLabToggleBar();
  updateSacrificeBtn();
  updateAnimateBtn();

  if (labToggleBar) {
    let gamutModeLabels = ['Silhouette', 'Edges', 'Wireframe', 'Opaque'];
    labToggleBar.addEventListener('click', function (e) {
      let btn = e.target.closest('.lab-toggle-btn') || e.target.closest('.lab-cycle-btn');
      if (!btn) return;
      let key = btn.dataset.toggle;
      if (key === 'gamut') {
        // Cycle through 4 modes
        _labGamutMode = (_labGamutMode + 1) % 4;
        btn.textContent = 'Gamut: ' + gamutModeLabels[_labGamutMode];
        btn.classList.add('active'); // always active (no 'off' mode)
      } else {
        btn.classList.toggle('active');
        let on = btn.classList.contains('active');
        if (key === 'surface') _labShowSurface = on;
        else if (key === 'frontier') _labShowFrontier = on;
        else if (key === 'dark') _labShowDark = on;
        else if (key === 'ideal') _labShowIdeal = on;
        else if (key === 'closest') _labShowClosest = on;
        else if (key === 'maxchroma') _labShowMaxChromaRing = on;
        else if (key === 'constchroma') _labShowConstChromaRing = on;
      }
      drawRing();
    });

    // Hover tracking on toggle buttons
    labToggleBar.addEventListener('mouseover', function (e) {
      let btn = e.target.closest('.lab-toggle-btn') || e.target.closest('.lab-cycle-btn');
      if (!btn) return;
      let key = btn.dataset.toggle;
      if (_labHoverToggle !== key) { _labHoverToggle = key; drawRing(); }
    });
    labToggleBar.addEventListener('mouseout', function (e) {
      if (_labHoverToggle !== null) { _labHoverToggle = null; drawRing(); }
    });
  }

  // ── Pareto parameter sliders ──
  var paretoSlidersWrap = document.getElementById('lab-pareto-sliders');
  function updateParetoSliders() {
    if (!paretoSlidersWrap) return;
    let show = _displayMode === 'lab' && _stripSacrificeMode === 2;
    paretoSlidersWrap.classList.toggle('lab-toggle-hidden', !show);
  }
  updateParetoSliders();

  if (paretoSlidersWrap) {
    // Slider input — controls volume extent for P2 selection
    paretoSlidersWrap.addEventListener('input', function (e) {
      let slider = e.target.closest('.pareto-slider');
      if (!slider) return;
      let axis = slider.dataset.axis;
      let rawVal = parseFloat(slider.value);
      if (axis === 'L') { _p2MaxDeltaL = rawVal / 100; }
      else if (axis === 'C') { _p2MaxDeltaC = rawVal / 100; }
      else if (axis === 'H') { _p2MaxDeltaH = rawVal; }
      // Update value display
      let valSpan = paretoSlidersWrap.querySelector('.pareto-val[data-axis="' + axis + '"]');
      if (valSpan) {
        if (axis === 'H') valSpan.textContent = Math.round(rawVal) + '\u00B0';
        else valSpan.textContent = (rawVal / 100).toFixed(2);
      }
      // Update P2 selection within volume constraints
      let h1d = ((Math.round(_playerHue1) % 360) + 360) % 360;
      if (_raySurfaceCache.h1 !== h1d) buildParetoSurface(h1d);
      let bestPt = findBestP2InVolume(h1d);
      if (bestPt) {
        _surfaceP2L = bestPt.L;
        _surfaceP2C = bestPt.C;
        _playerHue2 = bestPt.h;
        applyHues();
      }
      drawRing();
    });
  }

  // Expose drawRing for theme changes
  _colorPickerDrawFn = drawRing;

  // Initialize Pareto surface P2 if starting in surface mode
  if (_stripSacrificeMode === 2) {
    let h1d = ((Math.round(_playerHue1) % 360) + 360) % 360;
    buildParetoSurface(h1d);
    let bestPt = findBestP2InVolume(h1d);
    if (bestPt) {
      _surfaceP2L = bestPt.L;
      _surfaceP2C = bestPt.C;
      _playerHue2 = bestPt.h;
    }
  }

  applyHues();
}

// ──── Accent colour viewport (3D isometric, max-distance frontier) ────
// Returns the sRGB background color for the current theme as {r,g,b}
function getThemeBgRgb() {
  if (_themeLight) {
    if (_themeTemp === 'warm') return { r: 245, g: 238, b: 228 };
    if (_themeTemp === 'cool') return { r: 228, g: 235, b: 245 };
    return { r: 230, g: 230, b: 230 };
  }
  if (_themeTemp === 'warm') return { r: 20, g: 16, b: 10 };
  if (_themeTemp === 'cool') return { r: 8, g: 12, b: 20 };
  return { r: 0, g: 0, b: 0 };
}

// Returns the sRGB foreground (text/border) color for the current theme as {r,g,b}
function getThemeFgRgb() {
  if (_themeLight) {
    if (_themeTemp === 'warm') return { r: 40, g: 36, b: 30 };
    if (_themeTemp === 'cool') return { r: 30, g: 36, b: 45 };
    return { r: 35, g: 35, b: 35 };
  }
  if (_themeTemp === 'warm') return { r: 230, g: 222, b: 210 };
  if (_themeTemp === 'cool') return { r: 210, g: 218, b: 230 };
  return { r: 220, g: 220, b: 220 };
}

// Compute max-perceptual-distance chromaticity frontier from bg,
// subject to maintaining a minimum distinctiveness from fg.
// Maximises dist(accent, bg) while requiring dist(accent, fg) >= minFgDist.
function computeAccentFrontier(bgRgb, fgRgb) {
  let bgLab = srgbToOklab(bgRgb.r, bgRgb.g, bgRgb.b);
  let fgLab = srgbToOklab(fgRgb.r, fgRgb.g, fgRgb.b);
  let minFgDist = 0.35;  // minimum OKLab distance to foreground
  let frontier = [];
  for (let h = 0; h < 360; h++) {
    let hRad = h * Math.PI / 180;
    let cosH = Math.cos(hRad), sinH = Math.sin(hRad);
    let bestL = 0.5, bestC = 0, bestDist = 0;
    for (let Li = 5; Li <= 95; Li++) {
      let L = Li / 100;
      let C = maxChroma(L, h);
      let a = C * cosH, b = C * sinH;
      let dBgL = L - bgLab.L, dBgA = a - bgLab.a, dBgB = b - bgLab.b;
      let dBg = Math.sqrt(dBgL * dBgL + dBgA * dBgA + dBgB * dBgB);
      let dFgL = L - fgLab.L, dFgA = a - fgLab.a, dFgB = b - fgLab.b;
      let dFg = Math.sqrt(dFgL * dFgL + dFgA * dFgA + dFgB * dFgB);
      if (dFg < minFgDist) continue;  // too close to foreground, skip
      if (dBg > bestDist) { bestDist = dBg; bestL = L; bestC = C; }
    }
    // Fallback: if nothing passed the fg constraint, use max-bg anyway
    if (bestDist === 0) {
      for (let Li = 5; Li <= 95; Li++) {
        let L = Li / 100;
        let C = maxChroma(L, h);
        let a = C * cosH, b = C * sinH;
        let dBgL = L - bgLab.L, dBgA = a - bgLab.a, dBgB = b - bgLab.b;
        let dBg = Math.sqrt(dBgL * dBgL + dBgA * dBgA + dBgB * dBgB);
        if (dBg > bestDist) { bestDist = dBg; bestL = L; bestC = C; }
      }
    }
    frontier.push({ L: bestL, C: bestC, h: h, dist: bestDist });
  }
  return frontier;
}

var _accentDrawFn = null;  // redraw function for accent viewport

function initAccentViewport() {
  let acCan = document.getElementById('accent-viewport-canvas');
  if (!acCan) return;
  let acCtx = acCan.getContext('2d');

  // Orbit state (independent from player color viewport)
  let acTheta = -Math.PI / 4;
  let acPhi = Math.PI / 5.5;
  let acCScale = 500, acLScale = 340;
  let acCx = 0, acCy = 0;
  let acW = 400, acH = 320;

  // Projection helpers (same math as main viewport but isolated state)
  function acProject(ca, cb, L) {
    let rx = ca * Math.cos(acTheta) - cb * Math.sin(acTheta);
    let ry = ca * Math.sin(acTheta) + cb * Math.cos(acTheta);
    return {
      x: acCx + rx * acCScale,
      y: acCy - ry * Math.sin(acPhi) * acCScale - (L - 0.5) * Math.cos(acPhi) * acLScale
    };
  }
  function acProjectLCH(L, C, h) {
    let hRad = h * Math.PI / 180;
    return acProject(C * Math.cos(hRad), C * Math.sin(hRad), L);
  }

  // Cached frontier
  let cachedFrontier = null;
  let cachedDarkFrontier = null;
  let cachedBgKey = '';

  function ensureFrontier() {
    let bg = getThemeBgRgb();
    let fg = getThemeFgRgb();
    let key = bg.r + ',' + bg.g + ',' + bg.b + '|' + fg.r + ',' + fg.g + ',' + fg.b;
    if (key === cachedBgKey && cachedFrontier) return;
    cachedBgKey = key;
    cachedFrontier = computeAccentFrontier(bg, fg);
    _accentFrontierCache = cachedFrontier;  // share with setAccentHue
    // Dark version: L - 0.28
    cachedDarkFrontier = [];
    for (let i = 0; i < 360; i++) {
      let fp = cachedFrontier[i];
      let dL = Math.max(0.15, fp.L - 0.28);
      let dC = Math.min(fp.C, maxChroma(dL, fp.h));
      cachedDarkFrontier.push({ L: dL, C: dC, h: fp.h });
    }
  }

  function drawAccentView() {
    let wrap = document.getElementById('accent-viewport-wrap');
    if (!wrap) return;
    acW = wrap.clientWidth || 400;
    acH = wrap.clientHeight || 320;
    acCan.width = acW;
    acCan.height = acH;
    acCx = acW / 2;
    acCy = acH / 2;

    ensureFrontier();

    // Auto-fit projection scale
    let margin = 35;
    let kL = 0.42;
    let minPx = Infinity, maxPx = -Infinity, minPy = Infinity, maxPy = -Infinity;
    for (let h = 0; h < 360; h += 15) {
      let fp = cachedFrontier[h];
      let ca = fp.C * Math.cos(h * Math.PI / 180), cb = fp.C * Math.sin(h * Math.PI / 180);
      let rx = ca * Math.cos(acTheta) - cb * Math.sin(acTheta);
      let ry = ca * Math.sin(acTheta) + cb * Math.cos(acTheta);
      let px = rx;
      let py = -(ry * Math.sin(acPhi) + (fp.L - 0.5) * Math.cos(acPhi) * kL);
      if (px < minPx) minPx = px; if (px > maxPx) maxPx = px;
      if (py < minPy) minPy = py; if (py > maxPy) maxPy = py;
    }
    // Axis endpoints
    for (let aL of [0.15, 0.95]) {
      let py = -(0 * Math.sin(acPhi) + (aL - 0.5) * Math.cos(acPhi) * kL);
      if (py < minPy) minPy = py; if (py > maxPy) maxPy = py;
    }
    let extW = maxPx - minPx || 0.001;
    let extH = maxPy - minPy || 0.001;
    acCScale = Math.min((acW - margin * 2) / extW, (acH - margin * 2) / extH);
    acLScale = acCScale * kL;
    let midPx = (minPx + maxPx) / 2;
    let midPy = (minPy + maxPy) / 2;
    acCx = acW / 2 - midPx * acCScale;
    acCy = acH / 2 - midPy * acCScale;

    // Background
    acCtx.fillStyle = '#000';
    acCtx.fillRect(0, 0, acW, acH);

    // L axis
    let axBot = acProjectLCH(0.15, 0, 0), axTop = acProjectLCH(0.95, 0, 0);
    acCtx.strokeStyle = 'rgba(255,255,255,0.15)';
    acCtx.lineWidth = 1;
    acCtx.beginPath(); acCtx.moveTo(axBot.x, axBot.y); acCtx.lineTo(axTop.x, axTop.y); acCtx.stroke();

    // Background color marker on L axis
    let bgRgb = getThemeBgRgb();
    let bgLab = srgbToOklab(bgRgb.r, bgRgb.g, bgRgb.b);
    let bgPt = acProjectLCH(Math.max(0.15, Math.min(0.95, bgLab.L)), 0, 0);
    acCtx.beginPath();
    acCtx.arc(bgPt.x, bgPt.y, 5, 0, Math.PI * 2);
    acCtx.fillStyle = 'rgb(' + bgRgb.r + ',' + bgRgb.g + ',' + bgRgb.b + ')';
    acCtx.fill();
    acCtx.strokeStyle = 'rgba(255,255,255,0.5)';
    acCtx.lineWidth = 1.5;
    acCtx.stroke();

    // Foreground color marker on L axis
    let fgRgb = getThemeFgRgb();
    let fgLab = srgbToOklab(fgRgb.r, fgRgb.g, fgRgb.b);
    let fgPt = acProjectLCH(Math.max(0.15, Math.min(0.95, fgLab.L)), 0, 0);
    acCtx.beginPath();
    acCtx.arc(fgPt.x, fgPt.y, 5, 0, Math.PI * 2);
    acCtx.fillStyle = 'rgb(' + fgRgb.r + ',' + fgRgb.g + ',' + fgRgb.b + ')';
    acCtx.fill();
    acCtx.strokeStyle = 'rgba(255,255,255,0.5)';
    acCtx.lineWidth = 1.5;
    acCtx.stroke();

    // Draw dark frontier
    let darkSmooth = [];
    for (let h = 0; h < 360; h++) {
      let dp = cachedDarkFrontier[h];
      let sp = acProjectLCH(dp.L, dp.C, dp.h);
      let rgb = oklchToRgb(dp.L, dp.C, dp.h);
      darkSmooth.push({ x: sp.x, y: sp.y, rgb: rgb });
    }
    acCtx.strokeStyle = 'rgba(0,0,0,0.4)';
    acCtx.lineWidth = 4;
    acCtx.beginPath();
    for (let i = 0; i <= 360; i++) {
      let p = darkSmooth[i % 360];
      if (i === 0) acCtx.moveTo(p.x, p.y); else acCtx.lineTo(p.x, p.y);
    }
    acCtx.closePath(); acCtx.stroke();
    for (let i = 0; i < 360; i += 3) {
      let a = darkSmooth[i], b = darkSmooth[(i + 3) % 360];
      let grad = acCtx.createLinearGradient(a.x, a.y, b.x, b.y);
      grad.addColorStop(0, 'rgb(' + a.rgb.r + ',' + a.rgb.g + ',' + a.rgb.b + ')');
      grad.addColorStop(1, 'rgb(' + b.rgb.r + ',' + b.rgb.g + ',' + b.rgb.b + ')');
      acCtx.strokeStyle = grad;
      acCtx.lineWidth = 2;
      acCtx.beginPath(); acCtx.moveTo(a.x, a.y);
      for (let j = i + 1; j <= i + 3; j++) acCtx.lineTo(darkSmooth[j % 360].x, darkSmooth[j % 360].y);
      acCtx.stroke();
    }

    // Draw bright frontier
    let brightSmooth = [];
    for (let h = 0; h < 360; h++) {
      let fp = cachedFrontier[h];
      let sp = acProjectLCH(fp.L, fp.C, fp.h);
      let rgb = oklchToRgb(fp.L, fp.C, fp.h);
      brightSmooth.push({ x: sp.x, y: sp.y, rgb: rgb });
    }
    acCtx.strokeStyle = 'rgba(0,0,0,0.5)';
    acCtx.lineWidth = 5;
    acCtx.beginPath();
    for (let i = 0; i <= 360; i++) {
      let p = brightSmooth[i % 360];
      if (i === 0) acCtx.moveTo(p.x, p.y); else acCtx.lineTo(p.x, p.y);
    }
    acCtx.closePath(); acCtx.stroke();
    for (let i = 0; i < 360; i += 3) {
      let a = brightSmooth[i], b = brightSmooth[(i + 3) % 360];
      let grad = acCtx.createLinearGradient(a.x, a.y, b.x, b.y);
      grad.addColorStop(0, 'rgb(' + a.rgb.r + ',' + a.rgb.g + ',' + a.rgb.b + ')');
      grad.addColorStop(1, 'rgb(' + b.rgb.r + ',' + b.rgb.g + ',' + b.rgb.b + ')');
      acCtx.strokeStyle = grad;
      acCtx.lineWidth = 3;
      acCtx.beginPath(); acCtx.moveTo(a.x, a.y);
      for (let j = i + 1; j <= i + 3; j++) acCtx.lineTo(brightSmooth[j % 360].x, brightSmooth[j % 360].y);
      acCtx.stroke();
    }

    // Swatch dots every 10°
    for (let i = 0; i < 36; i++) {
      let h = i * 10;
      let fp = cachedFrontier[h];
      let sp = acProjectLCH(fp.L, fp.C, fp.h);
      let rgb = oklchToRgb(fp.L, fp.C, fp.h);
      let isSel = (Math.round(_accentHue / 10) % 36) === i;
      acCtx.beginPath();
      acCtx.arc(sp.x, sp.y, isSel ? 7 : 4, 0, Math.PI * 2);
      acCtx.fillStyle = 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')';
      acCtx.fill();
      if (isSel) {
        acCtx.strokeStyle = '#fff';
        acCtx.lineWidth = 2;
        acCtx.stroke();
      } else {
        acCtx.strokeStyle = 'rgba(255,255,255,0.1)';
        acCtx.lineWidth = 0.5;
        acCtx.stroke();
      }
    }

    // BG label
    acCtx.font = '9px -apple-system, sans-serif';
    acCtx.fillStyle = 'rgba(255,255,255,0.4)';
    acCtx.textAlign = 'center'; acCtx.textBaseline = 'bottom';
    acCtx.fillText('Max distance from bg (min fg floor)', acW / 2, acH - 4);

    // Update background swatch chip
    let bgChip = document.getElementById('accent-bg-chip');
    if (bgChip) {
      bgChip.style.background = 'rgb(' + bgRgb.r + ',' + bgRgb.g + ',' + bgRgb.b + ')';
    }
    // Update foreground swatch chip
    let fgChip = document.getElementById('accent-fg-chip');
    if (fgChip) {
      fgChip.style.background = 'rgb(' + fgRgb.r + ',' + fgRgb.g + ',' + fgRgb.b + ')';
    }
  }

  // Click to select accent hue
  acCan.addEventListener('click', function (e) {
    if (acDragged) return;  // don't select after orbit drag
    ensureFrontier();
    let rect = acCan.getBoundingClientRect();
    let mx = (e.clientX - rect.left) * (acW / rect.width);
    let my = (e.clientY - rect.top) * (acH / rect.height);
    // Find closest frontier swatch (10° stops)
    let best = -1, bestD2 = Infinity;
    for (let i = 0; i < 36; i++) {
      let h = i * 10;
      let fp = cachedFrontier[h];
      let sp = acProjectLCH(fp.L, fp.C, fp.h);
      let dx = sp.x - mx, dy = sp.y - my;
      let d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = i; }
    }
    if (best >= 0 && bestD2 < 900) {  // within ~30px
      setAccentHue(best * 10);
      drawAccentView();
    }
  });

  // Orbit drag (same as main viewport pattern)
  let acDragging = false, acDragged = false, acLastX = 0, acLastY = 0;
  acCan.addEventListener('mousedown', function (e) {
    if (e.button === 0) {
      acDragging = true;
      acDragged = false;
      acLastX = e.clientX;
      acLastY = e.clientY;
    }
  });
  window.addEventListener('mousemove', function (e) {
    if (!acDragging) return;
    let dx = e.clientX - acLastX, dy = e.clientY - acLastY;
    acLastX = e.clientX; acLastY = e.clientY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) acDragged = true;
    acTheta += dx * 0.008;
    acPhi = Math.max(0.05, Math.min(Math.PI / 2 - 0.05, acPhi - dy * 0.008));
    drawAccentView();
  });
  window.addEventListener('mouseup', function () { acDragging = false; });

  _accentDrawFn = drawAccentView;
  drawAccentView();
}

// ──── Theme toggle controls ────
function initThemeControls() {
  let lightDarkBtn = document.getElementById('theme-lightdark-btn');
  if (lightDarkBtn) {
    lightDarkBtn.addEventListener('click', function () {
      _themeLight = !_themeLight;
      setTheme(_themeLight, _themeTemp);
      lightDarkBtn.querySelector('span').textContent = _themeLight ? 'Light' : 'Dark';
    });
  }
  let tempBtns = document.querySelectorAll('.theme-temp-btn');
  tempBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      tempBtns.forEach(function (b) { b.classList.remove('theme-temp-active'); });
      btn.classList.add('theme-temp-active');
      _themeTemp = btn.dataset.temp;
      setTheme(_themeLight, _themeTemp);
    });
  });
}

function localMouse() {
  // Return null if the mouse is outside the canvas
  if (mouseX < 0 || mouseX > width || mouseY < 0 || mouseY > height) {
    return null;
  }
  // mouseX/mouseY are CSS pixels; the drawing context transform includes
  // the pixelDensity scale, so we must scale up to match before inverting.
  let pd = pixelDensity();
  let inv = drawingContext.getTransform().inverse();
  let pt = new DOMPoint(mouseX * pd, mouseY * pd).matrixTransform(inv);
  return { x: pt.x, y: pt.y };
}


// Precomputed random offsets for deterministic rally hit positions
const _rallyRandoms = [];
for (let i = 0; i < 200; i++) {
  let v = (Math.sin(i * 127.1 + 311.7) * 43758.5453) % 1;
  _rallyRandoms.push(v < 0 ? v + 1 : v);
}
function rallyRandom(i) { return _rallyRandoms[i % _rallyRandoms.length]; }

/**
 * drawRally — draws court + rally trajectories in an isometric 3D view.
 *
 * All 3D projection is done manually (no p5 rotate/scale for the isometric view)
 * so that "up" (elevation) always points toward the top of the screen.
 *
 * @param {object} bbox       { x, y, w, h } bounding box in canvas coords
 * @param {number} angle      rotation angle (radians) for the court plane
 * @param {number} vScale     vertical squash factor for isometric look (e.g. 0.55)
 * @param {object|null} rally parsed rally object, or null for empty court
 */
function drawRally(bbox, angle, vScale, rally) {

  // --- Court dimensions in feet ---
  let cW = 36;       // doubles width
  let cL = 78;       // baseline to baseline
  let singlesW = 27;
  let serviceDepth = 21;
  let netHeight = 3.5;

  let sL = (cW - singlesW) / 2;          // singles left
  let sR = cW - sL;                       // singles right
  let netY = cL / 2;
  let svcFar = netY - serviceDepth;
  let svcNear = netY + serviceDepth;

  // --- Projection: court (cx, cy, elev) → screen (sx, sy) ---
  // "Court space" has origin at court centre, x right, y down-court.
  // We rotate the court plane by `angle`, squash the vertical axis by `vScale`,
  // then elevation goes straight up on screen (no squash).
  let cosA = cos(angle), sinA = sin(angle);

  // Project a point.  cx, cy are court coords (0..cW, 0..cL).
  // elev is height above court surface in feet.
  function project(cx, cy, elev) {
    // centre-relative court coords
    let rx = cx - cW / 2;
    let ry = cy - cL / 2;
    // rotate in the ground plane
    let px = rx * cosA - ry * sinA;
    let py = rx * sinA + ry * cosA;
    // squash py for isometric, then lift by elevation (screen-up, unscaled)
    return { x: px, y: py * vScale - elev };
  }

  // --- Determine scale to fill bounding box ---
  // Fit to just beyond the inner court (baselines + sidelines) with a small margin
  let margin = 12;  // feet of run-off beyond court lines (used for drawing)
  let fitMargin = 3;  // feet beyond court lines for bounding fit
  let samples = [
    project(-fitMargin, -fitMargin, 0), project(cW + fitMargin, -fitMargin, 0),
    project(-fitMargin, cL + fitMargin, 0), project(cW + fitMargin, cL + fitMargin, 0),
    project(-1, netY, netHeight + 1), project(cW + 1, netY, netHeight + 1),
    project(cW / 2, cL, 10.5)  // serve contact height (~3m)
  ];
  let minPx = Infinity, maxPx = -Infinity, minPy = Infinity, maxPy = -Infinity;
  for (let s of samples) {
    if (s.x < minPx) minPx = s.x;
    if (s.x > maxPx) maxPx = s.x;
    if (s.y < minPy) minPy = s.y;
    if (s.y > maxPy) maxPy = s.y;
  }
  let projW = maxPx - minPx;
  let projH = maxPy - minPy;
  let sc = min(bbox.w / projW, bbox.h / projH) * 0.95;

  // Screen offset: centre the projection in the bbox
  let centreX = (minPx + maxPx) / 2;
  let centreY = (minPy + maxPy) / 2;
  let offX = bbox.x + bbox.w / 2;
  let offY = bbox.y + bbox.h / 2;

  // Final screen coordinate
  function toScreen(cx, cy, elev) {
    let p = project(cx, cy, elev || 0);
    return { x: offX + (p.x - centreX) * sc, y: offY + (p.y - centreY) * sc };
  }

  // --- Fill bounding box background ---
  if (_themeLight) {
    if (_themeTemp === 'warm') fill(230, 222, 210);
    else if (_themeTemp === 'cool') fill(215, 222, 232);
    else fill(220, 225, 230);
  } else {
    if (_themeTemp === 'warm') fill(38, 34, 26);
    else if (_themeTemp === 'cool') fill(26, 32, 42);
    else fill(30, 40, 55);
  }
  noStroke();
  rect(bbox.x, bbox.y, bbox.w, bbox.h);

  // --- Clip all subsequent drawing to the bounding box ---
  push();
  clip(function () {
    rect(bbox.x, bbox.y, bbox.w, bbox.h);
  });

  // --- Draw bounding box outline ---
  noFill();
  stroke(255, 255, 255, 60);
  strokeWeight(1);
  rect(bbox.x, bbox.y, bbox.w, bbox.h);

  // --- Draw run-off surface (area beyond baselines where players stand) ---
  let r00 = toScreen(-margin, -margin), r10 = toScreen(cW + margin, -margin);
  let r11 = toScreen(cW + margin, cL + margin), r01 = toScreen(-margin, cL + margin);
  noStroke();
  fill("#5E8EBB");
  beginShape();
  vertex(r00.x, r00.y); vertex(r10.x, r10.y);
  vertex(r11.x, r11.y); vertex(r01.x, r01.y);
  endShape(CLOSE);

  // --- Draw court surface ---
  let c00 = toScreen(0, 0), c10 = toScreen(cW, 0);
  let c11 = toScreen(cW, cL), c01 = toScreen(0, cL);

  fill("#58738E");
  noStroke();
  beginShape();
  vertex(c00.x, c00.y); vertex(c10.x, c10.y);
  vertex(c11.x, c11.y); vertex(c01.x, c01.y);
  endShape(CLOSE);

  // Helper: draw a court line as a perspective-projected rectangle (5cm wide)
  let lineHW = 0.082;  // half-width in feet (~2.5cm = 5cm total)
  function courtLine(x1, y1, x2, y2, elev, col) {
    let e = elev || 0;
    let ddx = x2 - x1, ddy = y2 - y1;
    let dLen = Math.sqrt(ddx * ddx + ddy * ddy);
    if (dLen === 0) return;
    // Direction unit vector
    let ux = ddx / dLen, uy = ddy / dLen;
    // Extend endpoints by lineHW for square corners
    x1 -= ux * lineHW; y1 -= uy * lineHW;
    x2 += ux * lineHW; y2 += uy * lineHW;
    // Perpendicular offset in court plane
    let px = -uy * lineHW;
    let py = ux * lineHW;
    let a = toScreen(x1 + px, y1 + py, e);
    let b = toScreen(x1 - px, y1 - py, e);
    let c = toScreen(x2 - px, y2 - py, e);
    let d = toScreen(x2 + px, y2 + py, e);
    if (col) fill(col); else fill(255);
    noStroke();
    beginShape();
    vertex(a.x, a.y); vertex(b.x, b.y);
    vertex(c.x, c.y); vertex(d.x, d.y);
    endShape(CLOSE);
  }

  // baselines
  courtLine(0, 0, cW, 0);
  courtLine(0, cL, cW, cL);
  // singles sidelines
  courtLine(sL, 0, sL, cL);
  courtLine(sR, 0, sR, cL);
  // doubles sidelines
  courtLine(0, 0, 0, cL);
  courtLine(cW, 0, cW, cL);
  // service lines
  courtLine(sL, svcFar, sR, svcFar);
  courtLine(sL, svcNear, sR, svcNear);
  // centre service line
  courtLine(cW / 2, svcFar, cW / 2, svcNear);
  // centre marks
  courtLine(cW / 2, 0, cW / 2, 0.7);
  courtLine(cW / 2, cL, cW / 2, cL - 0.7);

  // --- 3D Net ---
  let nL = -1, nR = cW + 1;
  let netMeshHW = 0.03;  // half-width for mesh lines
  let netCableHW = 0.07; // half-width for top cable
  let netPostHW = 0.06;  // half-width for posts

  // Helper: draw a vertical quad (for net mesh/posts)
  function netVertQuad(cx, cy, z0, z1, hw, col) {
    let a = toScreen(cx - hw, cy, z0);
    let b = toScreen(cx + hw, cy, z0);
    let c = toScreen(cx + hw, cy, z1);
    let d = toScreen(cx - hw, cy, z1);
    fill(col); noStroke();
    beginShape();
    vertex(a.x, a.y); vertex(b.x, b.y);
    vertex(c.x, c.y); vertex(d.x, d.y);
    endShape(CLOSE);
  }

  // Net shadow on ground
  let nSh0 = toScreen(nL, netY - 0.3, 0);
  let nSh1 = toScreen(nR, netY - 0.3, 0);
  let nSh2 = toScreen(nR, netY + 0.3, 0);
  let nSh3 = toScreen(nL, netY + 0.3, 0);
  fill(0, 0, 0, 35); noStroke();
  beginShape();
  vertex(nSh0.x, nSh0.y); vertex(nSh1.x, nSh1.y);
  vertex(nSh2.x, nSh2.y); vertex(nSh3.x, nSh3.y);
  endShape(CLOSE);

  // Net mesh background (semi-transparent fill)
  let nbl = toScreen(nL, netY, 0), nbr = toScreen(nR, netY, 0);
  let ntl = toScreen(nL, netY, netHeight), ntr = toScreen(nR, netY, netHeight);
  fill(200, 200, 200, 25); noStroke();
  beginShape();
  vertex(nbl.x, nbl.y); vertex(nbr.x, nbr.y);
  vertex(ntr.x, ntr.y); vertex(ntl.x, ntl.y);
  endShape(CLOSE);

  // Horizontal mesh lines (perspective quads)
  let meshCol = color(200, 200, 200, 50);
  for (let h = 0.7; h < netHeight; h += 0.7) {
    courtLine(nL, netY, nR, netY, h, meshCol);
  }
  // Vertical mesh lines (perspective quads)
  for (let xp = nL + 1; xp < nR; xp += 1) {
    netVertQuad(xp, netY, 0, netHeight, netMeshHW, meshCol);
  }

  // Top cable (thicker quad)
  courtLine(nL, netY, nR, netY, netHeight, color(220, 220, 220, 200));
  // Also draw cable with a bit more width
  let cableCol = color(220, 220, 220, 220);
  courtLine(nL, netY, nR, netY, netHeight + 0.04, cableCol);

  // Posts (vertical quads)
  let postCol = color(200, 200, 200, 200);
  netVertQuad(nL + 0.3, netY, 0, netHeight + 0.5, netPostHW, postCol);
  netVertQuad(nR - 0.3, netY, 0, netHeight + 0.5, netPostHW, postCol);

  // --- Rally drawing ---
  if (rally && rally.serves && rally.serves.length > 0) {

    let server = rally.serves[0].hitter;
    let returner = server === 1 ? 2 : 1;

    // Directions 1/3 are "to opponent's forehand/backhand".
    // For a right-hander, forehand = their right-hand side.
    // Near-side player (y > netY) faces toward low y, their right = high x.
    // Far-side player (y < netY) faces toward high y, their right = low x.
    // When ball lands 'near', the RECEIVER is on the near side (high x = forehand).
    // When ball lands 'far',  the RECEIVER is on the far side  (low x = forehand).
    function dirToX(dir, side, ri) {
      let r = rallyRandom(ri);
      let bias = r * r * 8;  // 0-8ft from sideline, clustered near 0
      if (side === 'near') {
        // Receiver on near side: their forehand (1) = high x, backhand (3) = low x
        if (dir === '1') return sR - 0.3 - bias;
        if (dir === '3') return sL + 0.3 + bias;
      } else {
        // Receiver on far side: their forehand (1) = low x, backhand (3) = high x
        if (dir === '1') return sL + 0.3 + bias;
        if (dir === '3') return sR - 0.3 - bias;
      }
      // Direction '2' (center): spread across the middle third
      return cW / 2 + (rallyRandom(ri + 50) - 0.5) * 10;
    }

    function serveDirToX(dir) {
      if (dir === '6') return cW / 2 + 0.5;
      if (dir === '4') return sR - singlesW * 0.12;
      return cW / 2 + singlesW * 0.18;
    }

    // --- Build position sequence ---
    // Each position: { x, y, z, type: 'hit'|'bounce'|'net' }
    //   z = elevation in feet above court
    let positions = [];

    // Server toss position — high up behind baseline
    let serveZ = 10;  // ball contact height in feet (~3 metres)
    positions.push({ x: cW / 2, y: cL - 1, z: serveZ, type: 'hit' });

    let activeServe = null;
    for (let srv of rally.serves) { if (srv.in) { activeServe = srv; break; } }
    if (!activeServe) activeServe = rally.serves[rally.serves.length - 1];

    let servLandX = serveDirToX(activeServe.direction);
    let servLandY = (svcFar + netY) / 2;
    positions.push({ x: servLandX, y: servLandY, z: 0, type: 'bounce' });

    let serveOnly = activeServe.ace || activeServe.unreturnable || !activeServe.in;

    if (!serveOnly && rally.shots.length > 0) {
      // Returner hits the return in the air.
      // They stand several feet behind the far baseline and move in to contact.
      let returnHitZ = 2.5 + rallyRandom(97) * 1.5;  // 2.5-4ft contact
      let retHitX = servLandX + (rallyRandom(99) - 0.5) * 4;
      let retHitY = servLandY * 0.35 + rallyRandom(98) * 5;  // ~10-15ft area
      positions.push({ x: retHitX, y: retHitY, z: returnHitZ, type: 'hit' });

      for (let i = 0; i < rally.shots.length; i++) {
        let shot = rally.shots[i];
        let landsNear = (i % 2 === 0);
        let side = landsNear ? 'near' : 'far';
        let landX = dirToX(shot.direction, side, i * 7 + 10);
        let landY;

        // Depth biased toward the baseline: r² clusters near 0 offset
        let depthR = rallyRandom(i * 7 + 13);
        let depthOffset = depthR * depthR * 8;  // 0-8ft from baseline

        if (landsNear) {
          if (shot.category === 'dropshot') landY = netY + 2 + depthR * 4;
          else if (shot.category === 'volley' || shot.category === 'halfvolley')
            landY = netY + 4 + depthR * 5;
          else landY = cL - 1 - depthOffset;
          if (shot.isReturn && shot.returnDepth) {
            if (shot.returnDepth === '7') landY = svcNear - 1 - depthR * 3;
            else if (shot.returnDepth === '8') landY = (svcNear + cL) / 2 - depthR * 3;
            else if (shot.returnDepth === '9') landY = cL - 1 - depthR * 2;
          }
        } else {
          if (shot.category === 'dropshot') landY = netY - 2 - depthR * 4;
          else if (shot.category === 'volley' || shot.category === 'halfvolley')
            landY = netY - 4 - depthR * 5;
          else landY = 1 + depthOffset;
        }

        // Last shot errors
        let isLastError = (i === rally.shots.length - 1 && shot.isError);
        let endsInNet = isLastError && shot.errorType === 'into the net';

        if (isLastError && !endsInNet) {
          if (shot.errorType === 'long')
            landY = landsNear ? cL + 2 + depthR * 3 : -2 - depthR * 3;
          else if (shot.errorType === 'wide') {
            landX = (landX < cW / 2) ? sL - 1 - depthR * 3 : sR + 1 + depthR * 3;
          } else if (shot.errorType === 'wide and long') {
            landX = (landX < cW / 2) ? sL - 1 - depthR * 3 : sR + 1 + depthR * 3;
            landY = landsNear ? cL + 2 + depthR * 3 : -2 - depthR * 3;
          }
        }

        if (endsInNet) {
          // Ball hits near the top of the net
          positions.push({ x: landX, y: netY, z: netHeight * 0.85, type: 'net' });
        } else {
          // Normal bounce on the court surface
          positions.push({ x: landX, y: landY, z: 0, type: 'bounce' });

          // If not the last shot, add the hit position where the player contacts the ball.
          // The player moves behind the bounce (toward their own baseline) and hits
          // the ball in the air as it rises from the bounce.
          if (i < rally.shots.length - 1) {
            // Player intercepts the ball while it's still rising after the bounce.
            // They stand well behind the baseline on deep shots.
            let prevPos = positions[positions.length - 2];
            let bouncePos = positions[positions.length - 1];
            let dx = bouncePos.x - prevPos.x;
            let dy = bouncePos.y - prevPos.y;
            let dLen = Math.sqrt(dx * dx + dy * dy);
            if (dLen > 0) { dx /= dLen; dy /= dLen; }

            // 6-16ft further along ball's travel direction (well beyond baseline)
            let pullBack = 6 + rallyRandom(i * 7 + 20) * 10;
            let hitX = bouncePos.x + dx * pullBack;
            let hitY = bouncePos.y + dy * pullBack;

            // Clamp to run-off area but maintain direction to avoid shadow kink
            let maxY = cL + margin - 1;
            let minY = -(margin - 1);
            if (landsNear && hitY > maxY) {
              let t = (maxY - bouncePos.y) / (hitY - bouncePos.y);
              hitY = maxY;
              hitX = bouncePos.x + (hitX - bouncePos.x) * t;
            } else if (!landsNear && hitY < minY) {
              let t = (minY - bouncePos.y) / (hitY - bouncePos.y);
              hitY = minY;
              hitX = bouncePos.x + (hitX - bouncePos.x) * t;
            }

            // Contact height — ball is still rising from the bounce
            let hitZ = 2.5 + rallyRandom(i * 7 + 22) * 1.5;  // 2.5-4ft
            if (shot.category === 'volley' || shot.category === 'halfvolley')
              hitZ = 2 + rallyRandom(i * 7 + 23) * 2;
            else if (shot.category === 'overhead')
              hitZ = 8;
            else if (shot.category === 'dropshot')
              hitZ = 2 + rallyRandom(i * 7 + 24);

            positions.push({ x: hitX, y: hitY, z: hitZ, type: 'hit' });
          }
        }
      }
    }

    // --- Extend to second bounce for aces, unreturnables, and winners ---
    // When the rally ends with a legal bounce the opponent couldn't return,
    // continue the ball's trajectory to where it would bounce a second time.
    let _secondBouncePeak = 0;
    let lastPos = positions[positions.length - 1];
    let needsSecondBounce = false;
    if (lastPos && lastPos.type === 'bounce' && positions.length >= 2) {
      let lastShot = rally.shots.length > 0 ? rally.shots[rally.shots.length - 1] : null;
      if (serveOnly && (activeServe.ace || activeServe.unreturnable)) {
        needsSecondBounce = true;
      } else if (lastShot && lastShot.isWinner && !lastShot.isError) {
        needsSecondBounce = true;
      }
    }
    if (needsSecondBounce && positions.length >= 2) {
      let prev = positions[positions.length - 2];  // the hit
      let bounce1 = positions[positions.length - 1]; // the first bounce

      // --- Compute the incoming arc's peakZ (same logic as the drawing loop) ---
      let incomingPeakZ;
      let isIncomingServe = (positions.length === 2); // serve → bounce
      if (isIncomingServe) {
        incomingPeakZ = prev.z - 3;
      } else {
        // Hit → bounce crossing the net
        let fSide = prev.y < netY, tSide = bounce1.y < netY;
        let crossesNet = fSide !== tSide;
        if (crossesNet) {
          let dy = prev.y - bounce1.y;
          let t_net = (dy !== 0) ? (prev.y - netY) / dy : 0.5;
          t_net = constrain(t_net, 0.05, 0.95);
          let clearance = netHeight + 1.2;  // use midpoint clearance estimate
          let midZ = (prev.z + bounce1.z) / 2;
          let linearZ = prev.z * (1 - t_net) + bounce1.z * t_net;
          let coeff = 4 * t_net * (1 - t_net);
          incomingPeakZ = midZ + (clearance - linearZ) / coeff;
          incomingPeakZ = max(incomingPeakZ, prev.z);
        } else {
          incomingPeakZ = max(prev.z, bounce1.z) + 0.5;
        }
      }

      // --- Physics: angle of incidence = angle of reflection, scaled by COR ---
      // Tennis ball COR (speed) ≈ 0.73, so height scales as e² ≈ 0.53
      let e = 0.73;
      let peak2 = e * e * incomingPeakZ;

      // t_peak of the incoming arc: z'(t)=0
      //   z(t) = from.z*(1-t) + to.z*t + 4*(peakZ - midZ)*t*(1-t)
      //   z'(t) = (to.z - from.z) + 4*(peakZ - midZ)*(1-2t) = 0
      //   t_peak = 0.5 + (to.z - from.z) / (8*(peakZ - midZ))
      let hitZ = prev.z;
      let midZ_in = hitZ / 2;  // since bounce z = 0
      let denom = 8 * (incomingPeakZ - midZ_in);
      let t_peak = (denom !== 0) ? 0.5 + (0 - hitZ) / denom : 0.5;
      t_peak = constrain(t_peak, 0.1, 0.9);

      // Falling portion of incoming arc covers fraction (1 - t_peak) of d_in
      let dx = bounce1.x - prev.x;
      let dy_court = bounce1.y - prev.y;
      let d_in = Math.sqrt(dx * dx + dy_court * dy_court);
      let d_fall = d_in * (1 - t_peak);

      // Second arc distance = 2 * e * d_fall (symmetric parabola, COR-scaled time)
      let dist2 = 2 * e * d_fall;

      // Direction: same as the incoming ball's direction
      let dLen = d_in;
      if (dLen > 0) { dx /= dLen; dy_court /= dLen; }
      let b2x = bounce1.x + dx * dist2;
      let b2y = bounce1.y + dy_court * dist2;
      positions.push({ x: b2x, y: b2y, z: 0, type: 'bounce' });

      // Store for the drawing loop
      _secondBouncePeak = peak2;
    }

    // Determine loser color for the X mark
    let loser = rally.serverWon ? returner : server;

    // --- Arc drawing as perspective-projected 3D ribbon ---
    // Draws a quad strip in court space with a given width (in feet)
    // that follows the parabolic trajectory.
    let ribbonW = 0.16;  // 5cm = ~0.16ft half-width
    function drawArc(from, to, peakZ, col, _sw) {
      let r = red(col), g = green(col), b = blue(col);
      fill(r, g, b, 210); noStroke();
      let steps = 30;
      let pts = [];
      for (let s = 0; s <= steps; s++) {
        let t = s / steps;
        let cx = lerp(from.x, to.x, t);
        let cy = lerp(from.y, to.y, t);
        let midZ = (from.z + to.z) / 2;
        let elev = from.z * (1 - t) + to.z * t + 4 * (peakZ - midZ) * t * (1 - t);
        elev = max(elev, 0);
        pts.push({ cx, cy, elev });
      }
      // Build quad strip: for each segment, offset perpendicular in court space
      for (let s = 0; s < pts.length - 1; s++) {
        let p0 = pts[s], p1 = pts[s + 1];
        // Direction vector in court space
        let ddx = p1.cx - p0.cx;
        let ddy = p1.cy - p0.cy;
        let dLen = Math.sqrt(ddx * ddx + ddy * ddy);
        if (dLen === 0) continue;
        // Perpendicular in court plane
        let px = -ddy / dLen * ribbonW;
        let py = ddx / dLen * ribbonW;
        let a = toScreen(p0.cx + px, p0.cy + py, p0.elev);
        let b = toScreen(p0.cx - px, p0.cy - py, p0.elev);
        let c = toScreen(p1.cx - px, p1.cy - py, p1.elev);
        let d = toScreen(p1.cx + px, p1.cy + py, p1.elev);
        beginShape();
        vertex(a.x, a.y); vertex(b.x, b.y);
        vertex(c.x, c.y); vertex(d.x, d.y);
        endShape(CLOSE);
      }
    }

    let arcPeaks = [];
    for (let i = 0; i < positions.length - 1; i++) {
      let from = positions[i], to = positions[i + 1];
      let hitterIdx = (from.type === 'hit') ? ((i === 0) ? 0 : Math.floor(i / 2)) : Math.floor(i / 2);
      let hitter = (hitterIdx % 2 === 0) ? server : returner;
      let isMain = (from.type === 'hit');
      let isServe = (i === 0);
      let isBounceRise = (from.type === 'bounce' && to.type === 'hit');

      let peakZ;

      if (isServe) {
        // Serve: ball is already past the peak (heading downward at contact)
        peakZ = from.z - 3;

      } else if (isBounceRise) {
        // Bounce → hit: ball is STILL RISING when struck.
        // This is a smaller parabola than the incoming shot (energy lost).
        // Set peakZ so that z'(1) > 0 (ball ascending at contact).
        //   z'(1) = (to.z - from.z) - 4*(peakZ - midZ)
        //   For z'(1) > 0:  peakZ < midZ + (to.z - from.z)/4
        //                         = from.z*0.25 + to.z*0.75
        let midZ = (from.z + to.z) / 2;
        let maxForRising = midZ + (to.z - from.z) / 4;
        // Interpolate between midZ and maxForRising so peakZ is always > midZ
        // (always concave / bowing upward) while still rising at contact
        peakZ = midZ + (maxForRising - midZ) * (0.5 + rallyRandom(i * 7 + 30) * 0.5);
        peakZ = max(peakZ, midZ + 0.3);

      } else if (isMain) {
        // Hit → bounce: mostly FALLING trajectory.
        // Compute minimum peakZ that clears the net, producing a flat shot.
        let fSide = from.y < netY, tSide = to.y < netY;
        let crossesNet = fSide !== tSide;

        if (crossesNet) {
          let dy = from.y - to.y;
          let t_net = (dy !== 0) ? (from.y - netY) / dy : 0.5;
          t_net = constrain(t_net, 0.05, 0.95);
          // Net clearance: 0.3-2.3ft above the net
          let clearance = netHeight + 0.3 + rallyRandom(i * 7 + 31) * 2;
          let midZ = (from.z + to.z) / 2;
          let linearZ = from.z * (1 - t_net) + to.z * t_net;
          let coeff = 4 * t_net * (1 - t_net);
          peakZ = midZ + (clearance - linearZ) / coeff;
          peakZ = max(peakZ, from.z);  // at least as high as contact point
        } else {
          peakZ = max(from.z, to.z) + 0.5;
        }

      } else {
        // Bounce → second bounce: use the precomputed peak from the physics calc
        peakZ = _secondBouncePeak > 0 ? _secondBouncePeak : 2;
      }

      arcPeaks.push(peakZ);
      drawArc(from, to, peakZ, colorScheme[hitter], isMain || (from.type === 'bounce' && to.type === 'bounce') ? 2 : 1.2);
    }

    // --- Tennis rackets at hit positions ---
    // Draw a semi-transparent racket at each 'hit' position,
    // oriented so the string face is perpendicular to the 3D ball velocity.
    function drawRacket(hitPos, nextPos, peakZ, hitterColor, shotSide, playerSide) {
      // 3D velocity at the moment of contact (t=0 of the outgoing arc)
      let vx = nextPos.x - hitPos.x;
      let vy = nextPos.y - hitPos.y;
      let midZ = (hitPos.z + nextPos.z) / 2;
      let vz = (nextPos.z - hitPos.z) + 4 * (peakZ - midZ);

      let vLen = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (vLen === 0) return;
      vx /= vLen; vy /= vLen; vz /= vLen;

      // Racket dimensions in court feet
      let headR = 0.75;
      let handleLen = 1.8;
      let handleHW = 0.08;

      let hx = hitPos.x, hy = hitPos.y, hz = hitPos.z;

      // Build two axes spanning the plane perpendicular to velocity.
      // axis1: horizontal perpendicular (velocity × up)
      let a1x = vy, a1y = -vx, a1z = 0;
      let a1Len = Math.sqrt(a1x * a1x + a1y * a1y);
      if (a1Len < 0.001) { a1x = 1; a1y = 0; a1z = 0; a1Len = 1; }
      a1x /= a1Len; a1y /= a1Len;
      // axis2: velocity × axis1
      let a2x = vy * a1z - vz * a1y;
      let a2y = vz * a1x - vx * a1z;
      let a2z = vx * a1y - vy * a1x;
      let a2Len = Math.sqrt(a2x * a2x + a2y * a2y + a2z * a2z);
      if (a2Len > 0) { a2x /= a2Len; a2y /= a2Len; a2z /= a2Len; }

      // Handle direction in the racket face plane, then angled behind velocity.
      let isBackhand = (shotSide === 'backhand');
      let flipForSide = (playerSide === 'far') ? -1 : 1;
      let handSign = (isBackhand ? -1 : 1) * flipForSide;

      // Handle: blend of "behind velocity" and "to the grip side" (axis1)
      let gripMix = 0.6;
      let hdx = -vx * (1 - gripMix) + a1x * handSign * gripMix;
      let hdy = -vy * (1 - gripMix) + a1y * handSign * gripMix;
      let hdz = -vz * (1 - gripMix) + a1z * handSign * gripMix;
      let hdLen = Math.sqrt(hdx * hdx + hdy * hdy + hdz * hdz);
      if (hdLen > 0) { hdx /= hdLen; hdy /= hdLen; hdz /= hdLen; }

      let cr = red(hitterColor), cg = green(hitterColor), cb = blue(hitterColor);

      // --- Racket head: ellipse in the plane perpendicular to velocity ---
      let headSegs = 16;
      fill(cr, cg, cb, 100); noStroke();
      beginShape();
      for (let s = 0; s < headSegs; s++) {
        let ang = (s / headSegs) * TWO_PI;
        let ca = cos(ang), sa = sin(ang);
        let ex = hx + (a1x * ca + a2x * sa * 0.85) * headR;
        let ey = hy + (a1y * ca + a2y * sa * 0.85) * headR;
        let ez = hz + (a1z * ca + a2z * sa * 0.85) * headR;
        let sp = toScreen(ex, ey, ez);
        vertex(sp.x, sp.y);
      }
      endShape(CLOSE);

      // --- Racket strings ---
      stroke(cr, cg, cb, 70); strokeWeight(0.5);
      // Strings along axis2 (across head)
      for (let s = -3; s <= 3; s++) {
        let frac = s / 4;
        let along = frac * headR * 0.85;
        let halfSpan = headR * Math.sqrt(1 - frac * frac) * 0.93;
        let bx = hx + a2x * along, by = hy + a2y * along, bz = hz + a2z * along;
        let sp1 = toScreen(bx + a1x * halfSpan, by + a1y * halfSpan, bz + a1z * halfSpan);
        let sp2 = toScreen(bx - a1x * halfSpan, by - a1y * halfSpan, bz - a1z * halfSpan);
        line(sp1.x, sp1.y, sp2.x, sp2.y);
      }
      // Strings along axis1 (up/down head)
      for (let s = -3; s <= 3; s++) {
        let frac = s / 4;
        let across = frac * headR;
        let halfSpan = headR * 0.85 * Math.sqrt(1 - frac * frac) * 0.93;
        let bx = hx + a1x * across, by = hy + a1y * across, bz = hz + a1z * across;
        let sp1 = toScreen(bx + a2x * halfSpan, by + a2y * halfSpan, bz + a2z * halfSpan);
        let sp2 = toScreen(bx - a2x * halfSpan, by - a2y * halfSpan, bz - a2z * halfSpan);
        line(sp1.x, sp1.y, sp2.x, sp2.y);
      }
      noStroke();

      // --- Handle ---
      let hpx = -hdy * handleHW, hpy = hdx * handleHW;
      let hs = headR * 0.6;
      let he = hs + handleLen;
      let ha = toScreen(hx + hdx * hs + hpx, hy + hdy * hs + hpy, hz + hdz * hs);
      let hb = toScreen(hx + hdx * hs - hpx, hy + hdy * hs - hpy, hz + hdz * hs);
      let hc = toScreen(hx + hdx * he - hpx, hy + hdy * he - hpy, hz + hdz * he);
      let hd = toScreen(hx + hdx * he + hpx, hy + hdy * he + hpy, hz + hdz * he);
      fill(cr, cg, cb, 150);
      beginShape();
      vertex(ha.x, ha.y); vertex(hb.x, hb.y);
      vertex(hc.x, hc.y); vertex(hd.x, hd.y);
      endShape(CLOSE);
    }

    // Draw rackets at each hit position
    for (let i = 0; i < positions.length - 1; i++) {
      if (positions[i].type === 'hit') {
        let hitIdx = Math.floor(i / 2);
        let hitter = (hitIdx % 2 === 0) ? server : returner;

        let shotSide = 'forehand';
        if (i > 0) {
          let shotIdx = Math.floor(i / 2) - 1;
          if (shotIdx >= 0 && shotIdx < rally.shots.length) {
            shotSide = rally.shots[shotIdx].side || 'forehand';
          }
        }

        let playerSide = (hitter === server) ? 'near' : 'far';
        drawRacket(positions[i], positions[i + 1], arcPeaks[i], colorScheme[hitter], shotSide, playerSide);
      }
    }

    // --- Bounce dots (perspective circles on court surface) ---
    for (let pos of positions) {
      if (pos.type === 'bounce') {
        let r = 0.5;  // radius in court feet
        noStroke(); fill(255, 255, 255, 180);
        beginShape();
        for (let a = 0; a < 12; a++) {
          let ang = (a / 12) * TWO_PI;
          let p = toScreen(pos.x + cos(ang) * r, pos.y + sin(ang) * r, 0);
          vertex(p.x, p.y);
        }
        endShape(CLOSE);
      }
    }

    // --- X mark painted on the ground at the final position ---
    if (positions.length >= 2) {
      let end = positions[positions.length - 1];
      let xCol = colorScheme[loser] || color(255, 70, 70);
      fill(xCol); noStroke();
      // Draw X as two perspective-projected rectangles on the court surface
      let sz = 1.8;  // half-length in court feet
      let hw = 0.12;  // half-width in court feet (~3.5cm thick lines)
      // Diagonal 1: bottom-left to top-right
      let d1a = toScreen(end.x - sz + hw, end.y - sz, 0);
      let d1b = toScreen(end.x - sz - hw, end.y - sz, 0);
      let d1c = toScreen(end.x + sz - hw, end.y + sz, 0);
      let d1d = toScreen(end.x + sz + hw, end.y + sz, 0);
      beginShape();
      vertex(d1a.x, d1a.y); vertex(d1b.x, d1b.y);
      vertex(d1c.x, d1c.y); vertex(d1d.x, d1d.y);
      endShape(CLOSE);
      // Diagonal 2: top-left to bottom-right
      let d2a = toScreen(end.x + sz + hw, end.y - sz, 0);
      let d2b = toScreen(end.x + sz - hw, end.y - sz, 0);
      let d2c = toScreen(end.x - sz - hw, end.y + sz, 0);
      let d2d = toScreen(end.x - sz + hw, end.y + sz, 0);
      beginShape();
      vertex(d2a.x, d2a.y); vertex(d2b.x, d2b.y);
      vertex(d2c.x, d2c.y); vertex(d2d.x, d2d.y);
      endShape(CLOSE);
    }

    // --- Ground shadow (perspective-projected ribbon on court surface) ---
    let shadowW = 0.08;  // half-width in court feet
    for (let i = 0; i < positions.length - 1; i++) {
      let from = positions[i], to = positions[i + 1];
      let ddx = to.x - from.x;
      let ddy = to.y - from.y;
      let dLen = Math.sqrt(ddx * ddx + ddy * ddy);
      if (dLen === 0) continue;
      let px = -ddy / dLen * shadowW;
      let py = ddx / dLen * shadowW;
      fill(0, 0, 0, 40); noStroke();
      let a = toScreen(from.x + px, from.y + py, 0);
      let b = toScreen(from.x - px, from.y - py, 0);
      let c = toScreen(to.x - px, to.y - py, 0);
      let d = toScreen(to.x + px, to.y + py, 0);
      beginShape();
      vertex(a.x, a.y); vertex(b.x, b.y);
      vertex(c.x, c.y); vertex(d.x, d.y);
      endShape(CLOSE);
    }
  }

  pop();  // End clipping to bounding box
}


class Connector {
  constructor(x, y, pW, pL, thickness = pointSquareSize, winnerAxisIsX = true) {

    this.x = x;
    this.y = y;
    this.pW = pW;
    this.pL = pL;
    this.thickness = thickness;
    this.winnerAxisIsX = winnerAxisIsX;

  }

  drawConnector(pos) {

    let { x, y, pW, pL, thickness, winnerAxisIsX } = this;

    x += pos.x;
    y += pos.y;

    fill(100);

    // l = loser axis
    // w = winner axis

    let s = pointSquareSize;

    let points = [
      { l: pL, w: pW },
      { l: pL, w: pW + thickness / 3 },
      { l: 0, w: pW + thickness / 3 },
      { l: 0, w: pW + thickness },
      { l: s, w: pW + thickness },
      { l: s, w: pW + thickness * 2 / 3 },
      { l: pL + s, w: pW + thickness * 2 / 3 },
      { l: pL + s, w: pW }
    ];

    push();
    translate(x, y);

    beginShape();

    for (let pt of points) {
      if (winnerAxisIsX) {
        vertex(pt.w, pt.l);
      } else {
        vertex(pt.l, pt.w);
      }
    }

    endShape();

    pop();

  }

}

class PointSquare {
  constructor() {
    this.state = INACTIVE;
  }

  draw(x, y) {

    stroke(0);
    fill(pointSquareColorScheme[this.state]);
    strokeWeight(0.25);

    rect(x, y, pointSquareSize, pointSquareSize);

  }


}

class Game {
  constructor(tiles = POINTS_TO_WIN_GAME) {
    this.active = false;
    this.tailSize = 0;

    this.pointSquares = [];

    for (let p1 = 0; p1 < tiles; p1++) {
      this.pointSquares.push([]);
      for (let p2 = 0; p2 < tiles; p2++) {
        this.pointSquares[p1].push(new PointSquare());
      }
    }

    this.tiles = tiles;
  }

  draw(x, y, b = 30) {

    // console.log(`Drawing game at (${x}, ${y}) with tailSize ${tailSize} and point tiles ${xTiles} x ${yTiles}`);

    stroke(20);
    fill(b);
    strokeWeight(0.25);

    let s = pointSquareSize;

    for (let p1_pts = 0; p1_pts < this.pointSquares.length; p1_pts++) {
      for (let p2_pts = 0; p2_pts < this.pointSquares[p1_pts].length; p2_pts++) {



        if (this.pointSquares[p1_pts][p2_pts] != null) {

          if (pAxes[1] == "x") {
            this.pointSquares[p1_pts][p2_pts].draw(x + p1_pts * s, y + p2_pts * s);
          } else {
            this.pointSquares[p1_pts][p2_pts].draw(x + p2_pts * s, y + p1_pts * s);
          }
        }

      }
    }

    fill(255);

    if (this.tiles > POINTS_TO_WIN_GAME) {
      for (let i = 0; i < this.tiles; i++) {

        textAlign(RIGHT, CENTER);
        textSize(5);

        push();
        translate(x + i * pointSquareSize + pointSquareSize / 2, y - 3);
        rotate(-TAU / 4);
        text(i, 0, 0);

        pop();

        textAlign(LEFT, CENTER);
        push();
        translate(x - 3, y + i * pointSquareSize + pointSquareSize / 2);
        text(i, 0, 0);

        pop();

      }
    }

    let tX = x + this.tiles * s;
    let tY = y + this.tiles * s;

    for (let layer = 0; layer < this.tailSize; layer++) {
      // fill(b);
      // rect(tX + layer * s, tY + layer * s, s, s);
      // rect(tX + layer * s, tY + (layer - 1) * s, s, s);
      // rect(tX + (layer - 1) * s, tY + layer * s, s, s);

      if (this.tiles > POINTS_TO_WIN_GAME) {

        textAlign(RIGHT, CENTER);
        textSize(5);
        fill(255);

        push();
        translate(tX + layer * s + pointSquareSize / 2, tY + (layer - 1) * s - 3);
        rotate(-TAU / 4);
        text(this.tiles + layer, 0, 0);

        pop();

        textAlign(LEFT, CENTER);
        push();
        translate(tX + (layer - 1) * s - 3, tY + layer * s + pointSquareSize / 2);
        text(this.tiles + layer, 0, 0);

        pop();

      }

    }

  }

}

class TennisSet {
  constructor(tiebreakerSet = false) {

    this.tiebreakerSet = tiebreakerSet;

    this.gameOffsets = {
      1: new Array(GAMES_TO_WIN_SET).fill(gameSize),  // Offsets for player 1's games
      2: new Array(GAMES_TO_WIN_SET).fill(gameSize)   // Offsets for player 2's games
    }

    this.gameOffsets[1].push(gameSize);
    this.gameOffsets[2].push(gameSize);

    this.active = {
      1: new Array(GAMES_TO_WIN_SET + 1).fill(false),
      2: new Array(GAMES_TO_WIN_SET + 1).fill(false)
    }

    // this.games[p1_gamesWon][p2_gamesWon]
    this.games = [];

    for (let p1_gamesWon = 0; p1_gamesWon < GAMES_TO_WIN_SET + 1; p1_gamesWon++) {
      this.games.push([]);

      if (p1_gamesWon < GAMES_TO_WIN_SET) {
        for (let p2_gamesWon = 0; p2_gamesWon < GAMES_TO_WIN_SET; p2_gamesWon++) {
          this.games[p1_gamesWon].push(new Game());
        }

        if (p1_gamesWon < GAMES_TO_WIN_SET - 1) {
          this.games[p1_gamesWon].push(null);
        } else {
          this.games[p1_gamesWon].push(new Game());
        }
      } else {
        for (let p2_gamesWon = 0; p2_gamesWon < GAMES_TO_WIN_SET; p2_gamesWon++) {
          if (p2_gamesWon < GAMES_TO_WIN_SET - 1) {
            this.games[p1_gamesWon].push(null);
          } else {
            this.games[p1_gamesWon].push(new Game());
          }
        }

        let nPoints = 7;
        if (this.tiebreakerSet) {
          nPoints = 10;
        }
        this.games[p1_gamesWon].push(new Game(nPoints)); // Tiebreak game with 7 points to win
      }

    }



  }

  draw(x, y) {

    let setDimensions = {
      1: this.gameOffsets[1].reduce((acc, curr) => acc + curr, 0),
      2: this.gameOffsets[2].reduce((acc, curr) => acc + curr, 0)
    }


    // draw score axis labels
    for (let [p, q] of [[1, 2], [2, 1]]) {

      let offset = {
        1: 0,
        2: 0
      }



      for (let g = 0; g < this.games.length; g++) {


        let special = 0;
        if (g == this.games.length - 1) {
          if (this.active[p][g]) {

          } else {
            continue;
          }
        }

        let gapToChart = 15;
        textFont(JetBrainsMonoBold);
        textSize(14);
        noStroke();
        textAlign(CENTER, CENTER);

        fill(pointSquareColorScheme[POINT_WON_AGAINST_SERVE][p]);

        if (!this.active[p][g]) {
          fill(pointSquareColorScheme[POINT_WON_ON_SERVE][p]);
        }

        let pOffset = { [p]: gameSize, [q]: 0 };

        let textOffset = { [p]: 0, [q]: -gapToChart };
        fill(pointSquareColorScheme[POINT_WON_AGAINST_SERVE][p]);

        push();

        let lineEndPoint = { [p]: 0, [q]: setDimensions[p] };

        translate(x + offset[axisToPlayer("x")], y + offset[axisToPlayer("y")]);

        translate(
          pOffset[axisToPlayer("x")],
          pOffset[axisToPlayer("y")]);

        stroke(pointSquareColorScheme[POINT_WON_AGAINST_SERVE][p]);
        strokeWeight(0.5);
        line(0, 0, lineEndPoint[axisToPlayer("x")], lineEndPoint[axisToPlayer("y")]);
        noStroke();

        translate(
          textOffset[axisToPlayer("x")],
          textOffset[axisToPlayer("y")]);



        rotate(-TAU / 8);
        text(g + 1, 0, 0);
        pop();

        for (let i = 0; i < pointScoreText.length; i++) {

          textAlign(CENTER, CENTER);
          textSize(5);

          let gapToChart = 3;

          let pOffset = { [p]: i * pointSquareSize, [q]: 0 };

          let textOffset = { [p]: 0, [q]: -gapToChart };

          let lineEndPoint = { [p]: 0, [q]: setDimensions[p] };

          push();

          translate(x + offset[axisToPlayer("x")] + pOffset[axisToPlayer("x")], y + offset[axisToPlayer("y")] + pOffset[axisToPlayer("y")]);

          stroke(pointSquareColorScheme[POINT_WON_ON_SERVE][p]);
          strokeWeight(0.25);
          line(0, 0, lineEndPoint[axisToPlayer("x")], lineEndPoint[axisToPlayer("y")]);
          noStroke();

          translate(textOffset[axisToPlayer("x")], textOffset[axisToPlayer("y")]);

          if (pAxes[p] == "x") {

            rotate(-TAU / 4)

          }

          text(pointScoreText[i], 0, 0);

          pop();

        }

        offset[p] += this.gameOffsets[p][g] + gameGap;

      }



    }


    let offset = {
      1: 0,
      2: 0
    }
    for (let p1_gamesWon = 0; p1_gamesWon < this.games.length; p1_gamesWon++) {

      offset[2] = 0;

      for (let p2_gamesWon = 0; p2_gamesWon < this.games[p1_gamesWon].length; p2_gamesWon++) {

        let game = this.games[p1_gamesWon][p2_gamesWon];

        if (!game || (p1_gamesWon == GAMES_TO_WIN_SET && !this.active[1][p1_gamesWon]) || (p2_gamesWon == GAMES_TO_WIN_SET && !this.active[2][p2_gamesWon])) {
          offset[2] += this.gameOffsets[2][p2_gamesWon] + gameGap;
          continue;
        }

        let b;

        if (game.active) {
          b = 110;
        } else if (this.active[1][p1_gamesWon] && this.active[2][p2_gamesWon]) {
          b = 50;
        } else {
          b = 20;
        }

        // game.draw(x + offset[axisToPlayer("x")], y + offset[axisToPlayer("y")], b);

        offset[2] += this.gameOffsets[2][p2_gamesWon] + gameGap;

      }

      offset[1] += this.gameOffsets[1][p1_gamesWon] + gameGap;
    }
  }

}

drawArrow = (x1, y1, x2, y2, size) => {
  push();
  let angle = atan2(y2 - y1, x2 - x1);
  translate(x1, y1);
  rotate(angle);
  // line(0, 0, dist(x1, y1, x2, y2) - size, 0);
  translate(dist(x1, y1, x2, y2) - size, 0);
  triangle(0, -size / 2, size, 0, 0, size / 2);
  pop();
}

class ScoresnakeChart {
  constructor(matchData) {
    this.matchData = matchData;

    this.connectors = [];

    this.setOffsets = {
      1: new Array(SETS_TO_WIN_MATCH).fill(setSize),  // Offsets for player 1's sets
      2: new Array(SETS_TO_WIN_MATCH).fill(setSize)   // Offsets for player 2's sets
    }

    this.timeline = {
      setOffsets: [],  // Cumulative offsets for sets on the timeline
      gameOffsets: [], // Cumulative offsets for games on the timeline
      minX: 0,
      maxX: 0,
      targetMinX: 0,
      targetMaxX: 0
    }

    // this.sets[p1_setsWon][p2_setsWon]
    this.sets = [];

    for (let p1_setsWon = 0; p1_setsWon < SETS_TO_WIN_MATCH; p1_setsWon++) {

      this.sets.push([]);

      for (let p2_setsWon = 0; p2_setsWon < SETS_TO_WIN_MATCH; p2_setsWon++) {
        if (p1_setsWon == SETS_TO_WIN_MATCH - 1 && p2_setsWon == SETS_TO_WIN_MATCH - 1) {
          this.sets[p1_setsWon].push(new TennisSet(true));
        } else {
          this.sets[p1_setsWon].push(new TennisSet());
        }
      }
    }

    this.minX = 0;
    this.minY = 0;

    this.targetMinX = 0;
    this.targetMinY = 0;

    this.maxX = 1;
    this.maxY = 1;

    this.targetMaxX = 1;
    this.targetMaxY = 1;

    this.hoverSet = null;
    this.hoverGame = null;
    this.hoverPoint = null;

    this.selectedSet = null;
    this.selectedGame = null;
    this.selectedPoint = null;

    this.zoomedSet = null;
    this.zoomedGame = null;



    this.mousePosVec = createVector(0, 0);

    this.update();

  }

  draw(pos) {

    this.recalculateTargetScale();

    this.maxX = lerp(this.maxX, this.targetMaxX, 0.1);
    this.maxY = lerp(this.maxY, this.targetMaxY, 0.1);

    this.minX = lerp(this.minX, this.targetMinX, 0.1);
    this.minY = lerp(this.minY, this.targetMinY, 0.1);

    push();
    translate(matchX, matchY);


    let graphHeight = dist(0, 0, this.maxX - this.minX, this.maxY - this.minY);

    let scaleFactor = (height - matchY - timelineHeight) / graphHeight;


    let graphWidth = graphHeight;

    let xScaleFactor = min((scoresnakeSectionWidth - matchY * 2) / graphWidth, scaleFactor * 1.4);

    scale(xScaleFactor, scaleFactor);

    rotate(TAU / 8);

    pos.x -= this.minX;
    pos.y -= this.minY;

    // for (let connector of this.connectors) {
    //   connector.drawConnector(pos);
    // }

    let px = axisToPlayer("x");
    let py = axisToPlayer("y");


    let setX = 0
    let setY = 0;

    let hover = false;
    let m = localMouse();
    let mouseInCanvas = m !== null;
    if (!mouseInCanvas) m = { x: -Infinity, y: -Infinity };

    let setHoverChange = false;
    let gameHoverChange = false;

    // draw the rallies and the snake itself
    for (let set of this.matchData.sets) {

      let gameX = 0
      let gameY = 0;

      if (
        mouseInCanvas &&
        !setHoverChange &&
        m.x < pos.x + setX + this.setOffsets[px][set.setsWon[px]]
        && m.y < pos.y + setY + this.setOffsets[py][set.setsWon[py]]
        && mouseY < height - timelineHeight
      ) {

        setHoverChange = true;

        if (this.hoverSet != set) {
          this.hoverSet = set;

          // pitch maps to position in match (low→high as match progresses)
          let firstPt = set.games[0] && set.games[0].points[0];
          let idx = firstPt ? this.matchData.allPoints.indexOf(firstPt) : 0;
          let pitchHint = idx / Math.max(this.matchData.allPoints.length - 1, 1);
          playSetHoverPing(pitchHint);
        }

        fill(30);
        rect(pos.x + setX, pos.y + setY,
          this.setOffsets[px][set.setsWon[px]],
          this.setOffsets[py][set.setsWon[py]]);

      }


      for (let game of set.games) {

        if (
          !gameHoverChange &&
          m.x < pos.x + setX + gameX + this.sets[set.setsWon[1]][set.setsWon[2]].gameOffsets[px][game.gamesWon[px]]
          && m.x > pos.x + setX + gameX
          && m.y < pos.y + setY + gameY + this.sets[set.setsWon[1]][set.setsWon[2]].gameOffsets[py][game.gamesWon[py]]
          && m.y > pos.y + setY + gameY
          && mouseY < height - timelineHeight
        ) {

          gameHoverChange = true;

          if (this.hoverGame != game) {
            this.hoverGame = game;

            // pitch maps to position in match (low→high as match progresses)
            let firstPt = game.points[0];
            let idx = firstPt ? this.matchData.allPoints.indexOf(firstPt) : 0;
            let pitchHint = idx / Math.max(this.matchData.allPoints.length - 1, 1);
            playGameHoverPing(pitchHint);
          }

          fill(60);
          rect(pos.x + setX + gameX, pos.y + setY + gameY,
            this.sets[set.setsWon[1]][set.setsWon[2]].gameOffsets[px][game.gamesWon[px]],
            this.sets[set.setsWon[1]][set.setsWon[2]].gameOffsets[py][game.gamesWon[py]]);

        }

        let pointX;
        let pointY;

        let s = pointSquareSize;



        for (let point of game.points) {

          pointX = point.pointsWon[px] * pointSquareSize;
          pointY = point.pointsWon[py] * pointSquareSize;


          let r = s / 1.5;


          let serveStatus;
          if (point.server == point.winner) {
            serveStatus = POINT_WON_ON_SERVE;
          } else {
            serveStatus = POINT_WON_AGAINST_SERVE;
          }

          fill(pointSquareColorScheme[serveStatus][point.winner]);

          if (point == this.hoverPoint) {
            fill(255);
          }

          if (!hover
            && m.x < pos.x + setX + gameX + pointX + s
            && m.x > pos.x + setX + gameX + pointX
            && m.y < pos.y + setY + gameY + pointY + s
            && m.y > pos.y + setY + gameY + pointY
            && mouseY < height - timelineHeight
          ) {

            hover = true;

            if (this.hoverPoint != point) {
              this.hoverPoint = point;

              // pitch maps to position in match (low→high as match progresses)
              let idx = this.matchData.allPoints.indexOf(point);
              let pitchHint = idx / (this.matchData.allPoints.length - 1);
              playHoverPing(pitchHint);
            }

          }

          // node
          let nodeSize = s * 2 / 3;

          stroke(0);
          strokeWeight(0.25);
          square(
            pos.x + setX + gameX + pointX + (s - nodeSize) / 2,
            pos.y + setY + gameY + pointY + (s - nodeSize) / 2,
            nodeSize
          );

          // arrow to next point node
          // drawing arrow


          let w = point.winner;
          let l;
          if (w == 1) {
            l = 2;
          } else {
            l = 1;
          }

          let nextPointXY = { [w]: s, [l]: 0 };
          // console.log(nextPointXY);

          let fromX = pos.x + setX + gameX + pointX + s / 2;
          let fromY = pos.y + setY + gameY + pointY + s / 2;
          let toX = pos.x + setX + gameX + pointX + nextPointXY[axisToPlayer("x")] + s / 2;
          let toY = pos.y + setY + gameY + pointY + nextPointXY[axisToPlayer("y")] + s / 2;

          // console.log(`Drawing arrow from (${fromX}, ${fromY}) to (${toX}, ${toY})`);

          drawArrow(fromX, fromY, toX, toY, 3);

        }

        pointX += s;
        pointY += s;

        pointX = max(pointX, gameSize);
        pointY = max(pointY, gameSize);


        stroke(pointSquareColorScheme[POINT_WON_AGAINST_SERVE][px]);
        strokeWeight(0.5);
        line(pos.x + setX + gameX + pointX, pos.y + setY + gameY, pos.x + setX + gameX + pointX, pos.y + setY + gameY + pointY);


        stroke(pointSquareColorScheme[POINT_WON_AGAINST_SERVE][py]);
        strokeWeight(0.5);
        line(pos.x + setX + gameX, pos.y + setY + gameY + pointY, pos.x + setX + gameX + pointX, pos.y + setY + gameY + pointY);


        if (game.winner == px) {

          gameX += this.sets[set.setsWon[1]][set.setsWon[2]].gameOffsets[px][game.gamesWon[px]];

          gameX += gameGap;
        } else {
          gameY += this.sets[set.setsWon[1]][set.setsWon[2]].gameOffsets[py][game.gamesWon[py]];

          gameY += gameGap;
        }
      }

      if (set.winner == px) {
        setX += this.setOffsets[px][set.setsWon[px]];

        stroke(pointSquareColorScheme[POINT_WON_AGAINST_SERVE][px]);
        strokeWeight(0.5);
        line(pos.x + setX, pos.y + setY, pos.x + setX, pos.y + setY + this.setOffsets[py][set.setsWon[py]]);

        setX += setGap;



      } else {
        setY += this.setOffsets[py][set.setsWon[py]];

        stroke(pointSquareColorScheme[POINT_WON_AGAINST_SERVE][py]);
        strokeWeight(0.5);
        line(pos.x + setX, pos.y + setY, pos.x + setX + this.setOffsets[px][set.setsWon[px]], pos.y + setY);

        setY += setGap;
      }

    }

    let matchDimensions = {
      1: this.setOffsets[1].reduce((acc, curr) => acc + curr, 0) + setGap * (SETS_TO_WIN_MATCH - 1),
      2: this.setOffsets[2].reduce((acc, curr) => acc + curr, 0) + setGap * (SETS_TO_WIN_MATCH - 1)
    };

    // draw score axis labels
    // for (let [p, q] of [[1, 2], [2, 1]]) {

    //   let offset = {
    //     1: 0,
    //     2: 0
    //   }

    //   for (let s = 0; s < this.sets.length; s++) {

    //     // if (g == this.games.length - 1) {
    //     //   if (this.active[p][g]) {

    //     //   } else {
    //     //     continue;
    //     //   }
    //     // }

    //     let gapToChart = 40;
    //     textFont(JetBrainsMonoBold);
    //     textSize(24);
    //     noStroke();
    //     textAlign(CENTER, CENTER);

    //     fill(pointSquareColorScheme[POINT_WON_AGAINST_SERVE][p]);

    //     let pOffset = { [p]: this.setOffsets[p][s], [q]: 0 };

    //     let textOffset = { [p]: 0, [q]: -gapToChart };
    //     fill(pointSquareColorScheme[POINT_WON_AGAINST_SERVE][p]);

    //     push();

    //     let lineEndPoint = { [p]: 0, [q]: matchDimensions[q] };

    //     translate(pos.x + offset[axisToPlayer("x")], pos.y + offset[axisToPlayer("y")]);

    //     translate(
    //       pOffset[axisToPlayer("x")],
    //       pOffset[axisToPlayer("y")]);

    //     stroke(pointSquareColorScheme[POINT_WON_AGAINST_SERVE][p]);
    //     strokeWeight(0.5);
    //     line(0, 0, lineEndPoint[axisToPlayer("x")], lineEndPoint[axisToPlayer("y")]);
    //     noStroke();

    //     translate(
    //       textOffset[axisToPlayer("x")],
    //       textOffset[axisToPlayer("y")]);



    //     rotate(-TAU / 8);
    //     text(s + 1, 0, 0);
    //     pop();

    //     offset[p] += this.setOffsets[p][s] + setGap;

    //   }



    // }

    let offset = {
      1: 0,
      2: 0
    };

    // for (let p1_setsWon = 0; p1_setsWon < SETS_TO_WIN_MATCH; p1_setsWon++) {

    //   offset[2] = 0;

    //   for (let p2_setsWon = 0; p2_setsWon < SETS_TO_WIN_MATCH; p2_setsWon++) {

    //     let set = this.sets[p1_setsWon][p2_setsWon];

    //     set.draw(
    //       pos.x + offset[axisToPlayer("x")], pos.y + offset[axisToPlayer("y")]);

    //     offset[2] += this.setOffsets[2][p2_setsWon] + setGap;

    //   }

    //   offset[1] += this.setOffsets[1][p1_setsWon] + setGap;

    // }

    pop();


    // timeline
    let w = width / this.matchData.allPoints.length / 10;

    let x = 0;


    fill(0);
    rect(0, height - timelineHeight, width, timelineHeight);


    this.timeline.targetMinX = 0;
    if (this.zoomedGame != null) {
      this.timeline.targetMinX = this.timeline.gameOffsets[this.zoomedGame.gameNumber - 1];
      this.timeline.targetMaxX = this.timeline.gameOffsets[this.zoomedGame.gameNumber];
    } else if (this.zoomedSet != null) {
      this.timeline.targetMinX = this.timeline.setOffsets[this.zoomedSet.setNumber - 1];
      this.timeline.targetMaxX = this.timeline.setOffsets[this.zoomedSet.setNumber];
    } else {
      this.timeline.targetMaxX = this.timeline.totalWidth;

    }

    // lerp the timeline min and max for smooth zooming
    this.timeline.minX = lerp(this.timeline.minX, this.timeline.targetMinX, 0.1);
    this.timeline.maxX = lerp(this.timeline.maxX, this.timeline.targetMaxX, 0.1);

    let timelineXscale = (width) / (this.timeline.maxX - this.timeline.minX);
    // console.log(timelineXscale);

    push();
    translate(-this.timeline.minX * timelineXscale, 0);
    scale(timelineXscale, 1);


    m = localMouse();
    mouseInCanvas = m !== null;
    if (!mouseInCanvas) m = { x: -Infinity, y: -Infinity };

    let g = 0;
    let s = 0;

    for (let set of this.matchData.sets) {

      if (m.x > this.timeline.setOffsets[s] && m.x < this.timeline.setOffsets[s + 1] && m.y > height - timelineHeight && m.y < height) {

        setHoverChange = true;

        if (this.hoverSet != set) {
          this.hoverSet = set;

          // pitch maps to position in match (low→high as match progresses)
          let firstPt = set.games[0] && set.games[0].points[0];
          let idx = firstPt ? this.matchData.allPoints.indexOf(firstPt) : 0;
          let pitchHint = idx / Math.max(this.matchData.allPoints.length - 1, 1);
          playSetHoverPing(pitchHint);

        }

      }

      for (let game of set.games) {

        let gameX = this.timeline.gameOffsets[g];

        let pointX = 0;

        if (m.x > gameX && m.x < this.timeline.gameOffsets[g + 1] && m.y > height - timelineHeight && m.y < height) {

          gameHoverChange = true;

          if (this.hoverGame != game) {
            this.hoverGame = game;

            // pitch maps to position in match (low→high as match progresses)
            let firstPt = game.points[0];
            let idx = firstPt ? this.matchData.allPoints.indexOf(firstPt) : 0;
            let pitchHint = idx / Math.max(this.matchData.allPoints.length - 1, 1);
            playGameHoverPing(pitchHint);

          }

        }

        for (let point of game.points) {

          let amt = timelineHeight / 3;

          let h = timelineHeight - amt;
          if (set == this.hoverSet) {
            h += amt / 3;
          }
          if (game == this.hoverGame) {
            h += amt / 3;
          }
          if (point == this.hoverPoint) {
            h += amt / 3;
          }

          let serveStatus;
          if (point.server == point.winner) {
            serveStatus = POINT_WON_ON_SERVE;
          } else {
            serveStatus = POINT_WON_AGAINST_SERVE;
          }

          fill(pointSquareColorScheme[serveStatus][point.winner]);

          stroke(0);
          strokeWeight(0.1);
          rect(gameX + pointX, height - h, point.rally.totalShots, h);
          noStroke();

          if (m.x > gameX + pointX && m.x < gameX + pointX + point.rally.totalShots && m.y > height - h && m.y < height) {

            hover = true;

            if (this.hoverPoint != point) {
              this.hoverPoint = point;

              // pitch maps to position in match (low→high as match progresses)
              let idx = this.matchData.allPoints.indexOf(point);
              let pitchHint = idx / (this.matchData.allPoints.length - 1);
              playHoverPing(pitchHint);

            }

          }

          pointX += point.rally.totalShots;

        }
        g++;

      }

      s++;


    }

    pop();

    if (!setHoverChange) {
      this.hoverSet = null;
    }
    if (!gameHoverChange) {
      this.hoverGame = null;
    }
    if (!hover) {
      this.hoverPoint = null;
    }

    if (this.hoverPoint) {

      let rally = parseRally(this.hoverPoint);


      textSize(10);
      fill(255);
      noStroke();
      textAlign(LEFT, BOTTOM);
      textWithBackground(describeRally(rally), mouseX + 10, mouseY + 10);


    }


  }

  update() {

    matchData = this.matchData;

    let timelineOffset = 0;

    let s = pointSquareSize;

    let setPos = createVector(0, 0);

    for (let set of matchData.sets) {

      this.timeline.setOffsets.push(timelineOffset);

      let gamePos = createVector(0, 0);

      // Guard against out-of-bounds set indices
      let p1Sets = set.setsWon[1];
      let p2Sets = set.setsWon[2];
      if (!this.sets[p1Sets] || !this.sets[p1Sets][p2Sets]) continue;
      let currentSet = this.sets[p1Sets][p2Sets];

      currentSet.active[1][0] = true;
      currentSet.active[2][0] = true;

      for (let [g, game] of set.games.entries()) {

        this.timeline.gameOffsets.push(timelineOffset);

        // Guard against out-of-bounds game indices
        let p1Games = game.gamesWon[1];
        let p2Games = game.gamesWon[2];
        if (!currentSet.games[p1Games] || !currentSet.games[p1Games][p2Games]) continue;
        let currentGame = currentSet.games[p1Games][p2Games];

        currentGame.active = true;

        let pointPos = createVector(0, 0);

        for (let point of game.points) {

          timelineOffset += point.rally.totalShots;

          let displayGame = currentGame;


          // growing the tail and adding new point squares if the number of points in the game exceeds the initial tiles (e.g. due to deuce)
          if (displayGame.pointSquares.length - 1 < max(point.pointsWon[1], point.pointsWon[2])) {

            for (let p1 = 0; p1 < displayGame.pointSquares.length; p1++) {
              if (p1 < displayGame.pointSquares.length - 1) {
                displayGame.pointSquares[p1].push(null);
              } else {
                displayGame.pointSquares[p1].push(new PointSquare());

              }
            }

            displayGame.pointSquares.push([]);
            for (let p2 = 0; p2 < displayGame.pointSquares[0].length - 1; p2++) {
              if (p2 < displayGame.pointSquares[0].length - 2) {
                displayGame.pointSquares[displayGame.pointSquares.length - 1].push(null);
              } else {
                displayGame.pointSquares[displayGame.pointSquares.length - 1].push(new PointSquare());

              }
            }
            displayGame.pointSquares[displayGame.pointSquares.length - 1].push(new PointSquare());


          }
          let state;

          if (point.winner == 1) {
            if (point.server == 1) {
              state = POINT_WON_ON_SERVE[1];
            } else {
              state = POINT_WON_AGAINST_SERVE[1];
            }
          } else if (point.winner == 2) {
            if (point.server == 2) {
              state = POINT_WON_ON_SERVE[2];
            } else {
              state = POINT_WON_AGAINST_SERVE[2];
            }
          }

          displayGame.pointSquares[point.pointsWon[1]][point.pointsWon[2]].state = state;

          pointPos[pAxes[point.winner]] += s;

        }

        // winner
        let w = game.winner;
        // loser
        let l;
        if (w == 1) {
          l = 2;
        } else {
          l = 1;
        }



        let gX = gamePos.x; let gY = gamePos.y;

        let gameOffsets = currentSet.gameOffsets;

        if (game.gamesWon[l] >= GAMES_TO_WIN_SET - 1 || game.gamesWon[w] < GAMES_TO_WIN_SET - 1) {
          currentSet.active[w][game.gamesWon[w] + 1] = true;
        }


        let sGame = currentGame;

        sGame.tailSize = pointPos[pAxes[w]] / s - sGame.tiles;

        gameOffsets[w][game.gamesWon[w]] = max(
          gameOffsets[w][game.gamesWon[w]],
          pointPos[pAxes[w]]
        );

        gameOffsets[l][game.gamesWon[l]] = max(
          gameOffsets[l][game.gamesWon[l]],
          pointPos[pAxes[w]] // have to account for tail protruding in both axes directions, so use winner's pointPos for both winner and loser offsets
        );

        if (!game.points[game.points.length - 1].isSetWinningPoint) {

          gamePos[pAxes[w]] += gameOffsets[w][game.gamesWon[w]];

          noStroke();

          let t;
          if (pAxes[w] == "x") {
            t = (gamePos.x - pointPos[pAxes[w]]) - gX;
          } else {
            t = (gamePos.y - pointPos[pAxes[w]]) - gY;
          }

          this.connectors.push(new Connector(
            setPos.x + gX,
            setPos.y + gY,
            pointPos[pAxes[w]],
            pointPos[pAxes[l]],
            t,
            (pAxes[w] == "x")
          ));

        } else {

          this.connectors.push(new Connector(
            setPos.x,
            setPos.y,
            gamePos[pAxes[w]] + pointPos[pAxes[w]],
            gamePos[pAxes[l]] + pointPos[pAxes[l]],
            setGap,
            (pAxes[w] == "x")
          ));

          gamePos[pAxes[w]] += pointPos[pAxes[w]];

        }

      }

      // winner
      let w = set.winner;
      // loser
      let l;
      if (w == 1) {
        l = 2;
      } else {
        l = 1;
      }

      let setOffsets = this.setOffsets;

      setOffsets[w][set.setsWon[w]] = max(
        setOffsets[w][set.setsWon[w]],
        gamePos[pAxes[w]] + gameGap * 6
      );

      setOffsets[l][set.setsWon[l]] = max(
        setOffsets[l][set.setsWon[l]],
        gamePos[pAxes[l]] + gameGap * 6
      );

      setPos[pAxes[set.winner]] += setOffsets[w][set.setsWon[w]];

    }

    this.recalculateTargetScale();
    this.maxX = this.targetMaxX;
    this.maxY = this.targetMaxY;



    this.timeline.totalWidth = timelineOffset;
    this.timeline.maxX = timelineOffset;
    this.timeline.setOffsets.push(timelineOffset);
    this.timeline.gameOffsets.push(timelineOffset);

  }

  recalculateTargetScale() {

    // get min, build up
    this.targetMinX = 0;
    this.targetMinY = 0;


    let gameOffsets;

    if (this.zoomedSet != null) {
      for (let s = 0; s < this.zoomedSet.setsWon[axisToPlayer("x")]; s++) {
        this.targetMinX += this.setOffsets[axisToPlayer("x")][s] + setGap;
      }
      for (let s = 0; s < this.zoomedSet.setsWon[axisToPlayer("y")]; s++) {
        this.targetMinY += this.setOffsets[axisToPlayer("y")][s] + setGap;
      }

      if (this.zoomedGame != null) {

        gameOffsets = this.sets[this.zoomedSet.setsWon[1]][this.zoomedSet.setsWon[2]].gameOffsets;

        for (let g = 0; g < this.zoomedGame.gamesWon[axisToPlayer("x")]; g++) {
          this.targetMinX += gameOffsets[axisToPlayer("x")][g] + gameGap;
        }

        for (let g = 0; g < this.zoomedGame.gamesWon[axisToPlayer("y")]; g++) {
          this.targetMinY += gameOffsets[axisToPlayer("y")][g] + gameGap;
        }
      }
    }

    this.targetMaxX = this.targetMinX;
    this.targetMaxY = this.targetMinY;

    if (this.zoomedGame != null) {

      this.targetMaxX += gameOffsets[axisToPlayer("x")][this.zoomedGame.gamesWon[axisToPlayer("x")]];
      this.targetMaxY += gameOffsets[axisToPlayer("y")][this.zoomedGame.gamesWon[axisToPlayer("y")]];

    } else if (this.zoomedSet != null) {

      this.targetMaxX += this.setOffsets[axisToPlayer("x")][this.zoomedSet.setsWon[axisToPlayer("x")]];
      this.targetMaxY += this.setOffsets[axisToPlayer("y")][this.zoomedSet.setsWon[axisToPlayer("y")]];

    } else {
      for (let s = 0; s < this.setOffsets[axisToPlayer("x")].length; s++) {
        this.targetMaxX += this.setOffsets[axisToPlayer("x")][s] + setGap;
      }
      for (let s = 0; s < this.setOffsets[axisToPlayer("y")].length; s++) {
        this.targetMaxY += this.setOffsets[axisToPlayer("y")][s] + setGap;
      }
    }

  }

}

function textWithBackground(str, x, y, padding = 6) {
  let lines = str.split('\n');
  let lineHeight = textAscent() + textDescent();
  let tw = Math.max(...lines.map(l => textWidth(l)));
  let th = lineHeight * lines.length;

  // Read current alignment from p5's internal state
  let hAlign = drawingContext.textAlign;  // "left", "center", "right"
  let vAlign = drawingContext.textBaseline; // "top", "middle", "alphabetic", "bottom"

  // Calculate background rect origin based on alignment
  let rx = x - padding;
  if (hAlign === 'center') rx = x - tw / 2 - padding;
  else if (hAlign === 'right') rx = x - tw - padding;

  let ry = y - padding;
  if (vAlign === 'top') ry = y - padding;
  else if (vAlign === 'middle') ry = y - th / 2 - padding;
  else if (vAlign === 'alphabetic' || vAlign === 'bottom') ry = y - th - padding;

  // Draw background
  fill(0, 200);
  noStroke();
  rect(rx, ry, tw + padding * 2, th + padding * 2);

  // Draw text at the same position with same alignment
  fill(255);
  text(str, x, y);
}

// Parse CSV data into a nested hierarchical object
function parseMatchData() {
  // Create the match object with nested structure
  tennisMatch = {
    matchId: '',
    player1: '',
    player2: '',
    sets: [],  // Array of set objects
    allPoints: []  // Flat sequence of all points in match order
  };

  // Extract match info from first row
  if (matchData.getRowCount() > 0) {
    let firstRow = matchData.getRow(0);
    tennisMatch.matchId = firstRow.getString('match_id');

    // Parse player names from match_id
    let parts = tennisMatch.matchId.split('-');
    if (parts.length >= 5) {
      tennisMatch.player1 = parts[parts.length - 2].replace(/_/g, ' ');
      tennisMatch.player2 = parts[parts.length - 1].replace(/_/g, ' ');
    }
  }

  // Sort rows by point number to handle out-of-order data
  let sortedRows = [];
  for (let i = 0; i < matchData.getRowCount(); i++) {
    sortedRows.push({
      index: i,
      pointNumber: matchData.getRow(i).getNum('Pt'),
      row: matchData.getRow(i)
    });
  }
  sortedRows.sort((a, b) => a.pointNumber - b.pointNumber);

  let currentSetIndex = -1;
  let currentGameIndex = -1;
  let lastGameNumber = -1;
  let lastSet1 = -1;
  let lastSet2 = -1;

  // Iterate through each point in sorted order
  for (let i = 0; i < sortedRows.length; i++) {
    let row = sortedRows[i].row;

    let games1 = row.getNum('Gm1');
    let games2 = row.getNum('Gm2');
    let gameNumber = row.getNum('Gm#');
    let set1 = row.getNum('Set1');
    let set2 = row.getNum('Set2');

    // Skip rows with backwards set progress (data errors in CSV)
    if (i > 0 && (set1 + set2) < (lastSet1 + lastSet2)) {
      continue;  // Skip this row entirely
    }

    // If starting a new set, save the final score of the previous set
    if (i > 0 && (set1 !== lastSet1 || set2 !== lastSet2)) {
      // Get the previous row's game scores (final score of completed set)
      let prevRow = sortedRows[i - 1].row;
      let finalGm1 = prevRow.getNum('Gm1');
      let finalGm2 = prevRow.getNum('Gm2');
      // console.log(`Saving final score for set ${currentSetIndex + 1} from prev row: ${finalGm1}-${finalGm2}`);
      tennisMatch.sets[currentSetIndex].games1 = finalGm1;
      tennisMatch.sets[currentSetIndex].games2 = finalGm2;

      // Determine set winner from Set1/Set2 transition
      // If Set1 increased, player 1 won; if Set2 increased, player 2 won
      if (set1 > lastSet1) {
        tennisMatch.sets[currentSetIndex].winner = 1;
      } else if (set2 > lastSet2) {
        tennisMatch.sets[currentSetIndex].winner = 2;
      }
    }

    // Create a new set when either Set1 or Set2 changes
    if (i === 0 || set1 !== lastSet1 || set2 !== lastSet2) {
      // console.log(`Creating set ${tennisMatch.sets.length + 1} at row ${i}: Set1=${set1}, Set2=${set2}, Gm1=${games1}, Gm2=${games2}`);
      tennisMatch.sets.push({
        setNumber: tennisMatch.sets.length + 1,
        games1: 0,  // Will be updated
        games2: 0,  // Will be updated
        winner: null,  // Will be set when set ends
        setsWon: { 1: set1, 2: set2 },  // Sets won by each player at start of this set
        gamesWon: null,  // Will be set after processing all games
        games: []   // Array of game objects
      });
      currentSetIndex++;
      lastSet1 = set1;
      lastSet2 = set2;
      currentGameIndex = -1;
    }

    // Create a new game if needed
    if (gameNumber !== lastGameNumber) {
      tennisMatch.sets[currentSetIndex].games.push({
        gameNumber: gameNumber,
        server: row.getNum('Svr'),
        winner: null,  // Will be set when game ends
        gamesWon: null,  // Will be calculated after determining winner
        pointsWon: null,  // Will be set after processing all points
        points: []     // Array of point objects
      });
      currentGameIndex++;
      lastGameNumber = gameNumber;
    }

    // Count points won in current game so far (BEFORE this point)
    let currentGame = tennisMatch.sets[currentSetIndex].games[currentGameIndex];
    let pointsWon = { 1: 0, 2: 0 };

    for (let existingPoint of currentGame.points) {
      if (existingPoint.winner === 1) pointsWon[1]++;
      else if (existingPoint.winner === 2) pointsWon[2]++;
    }

    // Get the winner of this point
    let pointWinner = row.getNum('PtWinner');

    // Create the point object
    let point = {
      number: row.getNum('Pt'),
      pointScore: row.getString('Pts'),
      server: row.getNum('Svr'),
      first: row.getString('1st'),
      second: row.getString('2nd'),
      winner: pointWinner,
      pointsWon: pointsWon,  // Points won by each player BEFORE this point
      setsWon: { 1: set1, 2: set2 },  // Sets won by each player at time of this point
      gamesWon: { 1: games1, 2: games2 }  // Games won in current set by each player at time of this point
    };

    // Parse rally notation into structured shot objects (replaces raw 'notes' field)
    point.rally = parseRally(point);

    // Add point to the current game and the flat allPoints array
    tennisMatch.sets[currentSetIndex].games[currentGameIndex].points.push(point);
    tennisMatch.allPoints.push(point);
  }

  // Set the final score for the last set (since there's no "next set" to trigger it)
  if (sortedRows.length > 0) {
    let lastRow = sortedRows[sortedRows.length - 1].row;
    tennisMatch.sets[currentSetIndex].games1 = lastRow.getNum('Gm1');
    tennisMatch.sets[currentSetIndex].games2 = lastRow.getNum('Gm2');

    // For the last set, we can't use Set1/Set2 to determine winner
    // (they show match score, not who won this set)
    // Winner will be determined later from game winners
  }

  // Determine game winners and calculate final counts
  for (let set of tennisMatch.sets) {
    let gamesWonSoFar = { 1: 0, 2: 0 };

    for (let g = 0; g < set.games.length; g++) {
      let game = set.games[g];

      // The winner is the winner of the last point
      if (game.points.length > 0) {
        game.winner = game.points[game.points.length - 1].winner;

        // Set the final pointsWon (soFar count + this point's winner)
        let finalCount = {
          1: game.points[game.points.length - 1].pointsWon[1],
          2: game.points[game.points.length - 1].pointsWon[2]
        };
        if (game.winner === 1) finalCount[1]++;
        else if (game.winner === 2) finalCount[2]++;
        game.pointsWon = finalCount;
      }

      // Mark if this was a game-winning point
      if (game.points.length > 0) {
        game.points[game.points.length - 1].isGameWinningPoint = true;
      }

      // Set gamesWon to reflect state BEFORE this game
      game.gamesWon = { 1: gamesWonSoFar[1], 2: gamesWonSoFar[2] };

      // Update games won so far (after this game completes)
      if (game.winner === 1) gamesWonSoFar[1]++;
      else if (game.winner === 2) gamesWonSoFar[2]++;
    }

    // Count game winners for this set
    let p1GamesWon = 0;
    let p2GamesWon = 0;

    for (let game of set.games) {
      if (game.winner === 1) p1GamesWon++;
      else if (game.winner === 2) p2GamesWon++;
    }

    // Set the final gamesWon
    set.gamesWon = { 1: p1GamesWon, 2: p2GamesWon };

    // For sets that don't have a winner yet, determine from game count
    if (set.winner === null) {
      if (p1GamesWon > p2GamesWon) {
        set.winner = 1;
      } else if (p2GamesWon > p1GamesWon) {
        set.winner = 2;
      }
    }

    // Mark set-winning points
    if (set.games.length > 0) {
      let lastGame = set.games[set.games.length - 1];
      if (lastGame.points.length > 0) {
        lastGame.points[lastGame.points.length - 1].isSetWinningPoint = true;
      }
    }
  }

  // Calculate final match score (sets won) and update setsWon
  let setsWonSoFar = { 1: 0, 2: 0 };
  for (let set of tennisMatch.sets) {
    // Update setsWon to reflect state BEFORE this set
    set.setsWon = { 1: setsWonSoFar[1], 2: setsWonSoFar[2] };

    // Update sets won so far (after this set completes)
    if (set.winner === 1) setsWonSoFar[1]++;
    else if (set.winner === 2) setsWonSoFar[2]++;
  }
  tennisMatch.setsWon = { 1: setsWonSoFar[1], 2: setsWonSoFar[2] };

  //console.log(`Loaded match: ${tennisMatch.player1} vs ${tennisMatch.player2}`);
  //console.log(`Sets: ${tennisMatch.sets.length}`);
  for (let i = 0; i < tennisMatch.sets.length; i++) {
    //console.log(`  Set ${i + 1}: ${tennisMatch.sets[i].games1}-${tennisMatch.sets[i].games2}, winner: ${tennisMatch.sets[i].winner}`);
  }
  //console.log(`Total games: ${tennisMatch.sets.reduce((sum, set) => sum + set.games.length, 0)}`);
  //console.log(`Total points: ${tennisMatch.sets.reduce((sum, set) =>
  // sum + set.games.reduce((gSum, game) => gSum + game.points.length, 0), 0)
  // } `);
}

function drawNames() {

  fill(0, 0, 0, 200);
  noStroke();

  let o = 40;

  triangle(scoresnakeSectionWidth / 2 - o, 0, 0, height / 2 - o, 0, 0);
  triangle(scoresnakeSectionWidth - scoresnakeSectionWidth / 2 + o, 0, scoresnakeSectionWidth, height - height / 2 - o, scoresnakeSectionWidth, 0);


  textSize(32);
  if (JetBrainsMonoBold) textFont(JetBrainsMonoBold);
  textAlign(LEFT, TOP);

  // Helper function to split name into 2 lines optimally
  function getOptimalTwoLinesSplit(nameParts) {
    if (nameParts.length <= 2) {
      return nameParts;
    }

    // Try all possible ways to split into 2 lines
    let bestSplit = null;
    let minMaxWidth = Infinity;

    for (let i = 1; i < nameParts.length; i++) {
      let line1 = nameParts.slice(0, i).join(' ');
      let line2 = nameParts.slice(i).join(' ');
      let maxWidth = Math.max(textWidth(line1), textWidth(line2));

      if (maxWidth < minMaxWidth) {
        minMaxWidth = maxWidth;
        bestSplit = [line1, line2];
      }
    }

    return bestSplit;
  }

  fill(pointSquareColorScheme[POINT_WON_AGAINST_SERVE][1]);
  // Player 1
  let player1Parts = tennisMatch.player1.split(' ');
  let player1Lines = getOptimalTwoLinesSplit(player1Parts);
  text(player1Lines.join('\n'), 50, 50);

  fill(pointSquareColorScheme[POINT_WON_AGAINST_SERVE][2]);
  // Player 2 - keep LEFT alignment but calculate position from right edge
  let player2Parts = tennisMatch.player2.split(' ');
  let player2Lines = getOptimalTwoLinesSplit(player2Parts);
  let maxWidth = Math.max(textWidth(player2Lines[0]), textWidth(player2Lines[1]));

  text(player2Lines.join('\n'), scoresnakeSectionWidth - 50 - maxWidth, 50);
}

function mouseWheel(event) {

  if (event.deltaY < 0) { // scrolling up
    if (currentScoresnake.zoomedSet == null) {

      currentScoresnake.zoomedSet = currentScoresnake.hoverSet;

    } else {

      if (currentScoresnake.zoomedGame == null) {

        // if hover set is the same as zoomed set, zoom into game -- otherwise just switch set without zooming into game
        if (currentScoresnake.zoomedSet == currentScoresnake.hoverSet) {

          currentScoresnake.zoomedGame = currentScoresnake.hoverGame;

        } else {
          currentScoresnake.zoomedSet = currentScoresnake.hoverSet;
        }

      } else {

        currentScoresnake.zoomedSet = currentScoresnake.hoverSet;
        currentScoresnake.zoomedGame = currentScoresnake.hoverGame;

      }

    }
  } else if (event.deltaY > 0) { // scrolling down

    if (currentScoresnake.zoomedGame != null) {
      currentScoresnake.zoomedGame = null;
    } else {
      currentScoresnake.zoomedSet = null;
    }
  }
}

function mouseClicked() {
  if (!currentScoresnake) return;

  if (currentScoresnake.hoverPoint) {
    currentScoresnake.selectedPoint = currentScoresnake.hoverPoint;
  } else {
    currentScoresnake.selectedPoint = null;
  }

}

function draw() {
  if (_themeLight) {
    if (_themeTemp === 'warm') background(245, 238, 228);
    else if (_themeTemp === 'cool') background(228, 235, 245);
    else background(230);
  } else {
    if (_themeTemp === 'warm') background(20, 16, 10);
    else if (_themeTemp === 'cool') background(8, 12, 20);
    else background(0);
  }

  if (!dataLoaded) {
    // Show loading screen if somehow data isn't ready
    fill(255);
    textSize(48);
    textAlign(CENTER, CENTER);
    if (JetBrainsMonoBold) textFont(JetBrainsMonoBold);
    text('Loading...', width / 2, height / 2);
    return;
  }

  // Create ScoresnakeChart if we have match data
  if (dataLoaded && tennisMatch && !currentScoresnake) {
    currentScoresnake = new ScoresnakeChart(tennisMatch);
  }

  if (!tennisMatch || !currentScoresnake) {
    fill(255);
    textSize(24);
    textAlign(CENTER, CENTER);
    text('Error: Match data not loaded', width / 2, height / 2);
    return;
  }



  let paneCollapsed = document.getElementById('sketch-pane')?.classList.contains('pane-collapsed');

  scoresnakeSectionWidth = paneCollapsed ? width * 0.6 : width;
  matchX = scoresnakeSectionWidth / 2, matchY = 50;

  currentScoresnake.draw({ x: 0, y: 0 });

  drawNames();

  // Draw rally visualisation only when the right pane is closed (more room)
  if (paneCollapsed) {
    let rallyToDraw;
    if (currentScoresnake.selectedPoint) {
      rallyToDraw = currentScoresnake.selectedPoint.rally;
    } else if (currentScoresnake.hoverPoint) {
      rallyToDraw = currentScoresnake.hoverPoint.rally;
    } else {
      rallyToDraw = null;
    }
    // let hoveredRally = currentScoresnake.hoverPoint ? currentScoresnake.hoverPoint.rally : null;
    let rallyBox = {
      x: scoresnakeSectionWidth,
      y: 0,
      w: width - (scoresnakeSectionWidth),
      h: height - timelineHeight
    };
    _orbitRallyBox = rallyBox;
    drawRally(rallyBox, _orbitAngle, _orbitVScale, rallyToDraw);
  } else {
    _orbitRallyBox = null;
  }
  noStroke();

}

function windowResized() {
  // Resize main canvas to actual sketch-pane width
  let sketchPaneEl = document.getElementById('sketch-pane');
  let paneWidth = sketchPaneEl ? sketchPaneEl.clientWidth : windowWidth * 0.6;
  resizeCanvas(paneWidth, windowHeight);

  // // Create new scoresnake with new dimensions
  // if (dataLoaded && tennisMatch) {
  //   currentScoresnake = new ScoresnakeChart();
  //   currentScoresnake.update(tennisMatch);
  //   redraw();
  // }
}
