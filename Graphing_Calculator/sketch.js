/* Graphing Calculator (Draft)
 * - p5.js renderer
 * - Pan (drag), zoom (wheel), reset view
 * - Expression compiler with a whitelist of identifiers
 */

/* ===== OKLAB perceptual colour utilities ===== */
// sRGB ↔ linear sRGB
function srgbToLinear(x) { return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }
function linearToSrgb(x) { return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055; }

// sRGB [0-255] → OKLAB {L, a, b}
function rgbToOklab(r, g, b) {
  const lr = srgbToLinear(r / 255), lg = srgbToLinear(g / 255), lb = srgbToLinear(b / 255);
  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
  };
}

// OKLAB {L, a, b} → sRGB [0-255]
function oklabToRgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l3 = l_ * l_ * l_, m3 = m_ * m_ * m_, s3 = s_ * s_ * s_;
  const lr = +4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const lg = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const lb = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3;
  return [
    Math.round(Math.min(255, Math.max(0, linearToSrgb(lr) * 255))),
    Math.round(Math.min(255, Math.max(0, linearToSrgb(lg) * 255))),
    Math.round(Math.min(255, Math.max(0, linearToSrgb(lb) * 255)))
  ];
}

// OKLAB → OKLCH {L, C, h (degrees)}
function oklabToOklch(L, a, b) {
  const C = Math.sqrt(a * a + b * b);
  const h = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
  return { L, C, h };
}

// OKLCH → OKLAB
function oklchToOklab(L, C, h) {
  const hRad = h * Math.PI / 180;
  return { L, a: C * Math.cos(hRad), b: C * Math.sin(hRad) };
}

// Mix two sRGB [0-255] colors in OKLAB space, return sRGB [0-255]
function oklabMix(r1, g1, b1, r2, g2, b2, t) {
  const c1 = rgbToOklab(r1, g1, b1);
  const c2 = rgbToOklab(r2, g2, b2);
  return oklabToRgb(
    c1.L + (c2.L - c1.L) * t,
    c1.a + (c2.a - c1.a) * t,
    c1.b + (c2.b - c1.b) * t
  );
}

// Brighten a sRGB color toward white by t [0-1] in OKLAB
function oklabBrighten(r, g, b, t) {
  return oklabMix(r, g, b, 255, 255, 255, t);
}

// sRGB hex → OKLCH  (for CSS conversion reference)
function hexToOklch(hex) {
  const [r, g, b] = hexToRgb(hex);
  const ok = rgbToOklab(r, g, b);
  return oklabToOklch(ok.L, ok.a, ok.b);
}

window._gcT = 0; // global t parameter read by compiled expressions

let canvas;

const ui = {
  exprEl: null,
  modeButtons: [],
  plotEl: null,
  statusEl: null,
  canvasWrapEl: null,
  infoBtn: null,
  infoPopup: null,
  resetOverlay: null,
  graphTogglesEl: null,
  hudEl: null,
};

const view = {
  originX: 0,
  originY: 0,
  scale: 80, // pixels per 1 world unit
  rotation: 0, // radians — angle of x-axis from horizontal (CCW visual)
};

var DISCRETE_MODE_PIXEL_X_MARGIN = 0.18;
var DISCRETE_MODE_PIXEL_Y_MARGIN = 0.05;

const state = {
  isPanning: false,
  panStartMouseX: 0,
  panStartMouseY: 0,
  panStartOriginX: 0,
  panStartOriginY: 0,

  mode: "cartesian",
  fn: null,
  lastExpr: "",
  steps: [],
  ops: [], // editable operation list (without leading x step)
  hasPlotted: false,
  viewDirty: false, // true after pan/zoom
  lightMode: false,
  theme: "auto", // "light", "dark", "auto"
  toggles: { xgrid: true, ygrid: true, xaxis: false, yaxis: false, arrows: true, intermediates: true, subintermediates: false, starbursts: false, xlabels: false, ylabels: false },
  glowCurves: false, // when true, curves are 1px bright with coloured glow (continuous/discreteX only)
  equalizeColors: false, // when true, normalize OP_COLORS to uniform perceptual lightness
  latexOpsOrder: false, // when true, LaTeX matches ops sequence order rather than conventional math
  latexMulSymbol: "dot", // "dot" = \cdot, "times" = \times
  hudVisible: false, // HUD info overlay visibility
  hoveredToggle: null, // which toggle key is being hovered (for glow effect)
  toggleJustTurnedOff: {}, // tracks toggles recently clicked OFF (prevents immediate hover preview)
  tauMode: false, // when true, x-axis is in τ units (1 τ = 2π)
  discreteMode: "discreteX", // "continuous", "discreteX", or "discrete"
  numeralMode: false, // when true, discrete pixels show numeral values instead of solid fills
  stepEyes: { x: true, ops: [], y: true }, // per-step visibility (eye toggles)
  stepEyeMode: false, // mobile: show eye toggles inside op boxes
  hoveredStep: null, // "x" | "op-0" | "op-1" | ... | "y" (for glow)
  equalsEdge: null,  // { fromId, toId } — pipe the '=' marker sits on; null = Y→root
  equalsLhsSpans: null,   // LHS displaySpans when equalsEdge active (for mode switching)
  equalsFullSpans: null,  // tree-order full spans (LHS = RHS)
  equalsRhsExpr: null,    // parseable RHS expression string
  treeRotationDeg: 0,     // rotation angle for the expression tree view (degrees)
  statusText: "",
  statusKind: "info",
  t: 0,
  tMin: 0,
  tMax: 10,
  tSpeed: 1,
  tPlaying: true,
  usesT: false,

  // Expanded column state for discrete modes (click-to-inspect)
  // expandedCols: Set of ix that have intermediate columns expanded
  // expandedSubCols: Map of "ix:opIdx" → true for subintermediate expansions
  expandedCols: new Set(),
  expandedSubCols: new Map(),
};

/** Returns true when in any discrete mode ("discrete" or "discreteX"). */
function isDiscreteAny() {
  return state.discreteMode === "discrete" || state.discreteMode === "discreteX";
}

function setStatus(message, kind = "info") {
  state.statusText = message || "";
  state.statusKind = kind;
}

function setStatusForCurrentMode() {
  if (!state.fn) return;
  const expr = state.lastExpr || ui.exprEl?.value || "";
  if (state.mode === "cartesian") {
    setStatus(`Plotting y = ${expr}`, "info");
  } else if (state.mode === "delta") {
    setStatus(`Plotting Δ(x) = f(x) − x for f(x) = ${expr}`, "info");
  } else if (state.mode === "numberLines") {
    setStatus(`Mapping x → f(x) for f(x) = ${expr}`, "info");
  }
}

function resetView() {
  // Centre on the visible region between topbar and bottom bar
  const topbar = document.querySelector('.topbar');
  const toggleBar = document.querySelector('.graph-toggles');
  const topH = topbar ? topbar.getBoundingClientRect().height : 0;
  const bottomH = (toggleBar && toggleBar.style.display !== 'none') ? toggleBar.getBoundingClientRect().height : 0;
  view.originX = width * 0.5;
  view.originY = topH + (height - topH - bottomH) * 0.5;
  view.scale = 80;
  // Keep rotation / axis orientation unchanged
  // Clear expanded discrete columns
  state.expandedCols.clear();
  state.expandedSubCols.clear();
}

function screenToWorld(sx, sy) {
  const dx = (sx - view.originX) / view.scale;
  const dy = (view.originY - sy) / view.scale;
  const c = Math.cos(view.rotation), s = Math.sin(view.rotation);
  return {
    x: dx * c + dy * s,
    y: -dx * s + dy * c,
  };
}

function worldToScreen(wx, wy) {
  const c = Math.cos(view.rotation), s = Math.sin(view.rotation);
  return {
    x: view.originX + (wx * c - wy * s) * view.scale,
    y: view.originY - (wx * s + wy * c) * view.scale,
  };
}

function niceGridStep(pxPerUnit) {
  // Pick a world-space step so that grid lines are roughly 25–80px apart.
  const targetPx = 45;
  const raw = targetPx / Math.max(1e-9, pxPerUnit); // world units
  const pow10 = Math.pow(10, Math.floor(Math.log10(raw)));
  const candidates = [1, 2, 5, 10].map((m) => m * pow10);

  let best = candidates[0];
  let bestScore = Infinity;
  for (const c of candidates) {
    const px = c * pxPerUnit;
    const score = Math.abs(px - targetPx);
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }

  return best;
}

/**
 * Continuous grid system.
 * We draw multiple levels from the 1-2-5 sequence, each with an alpha
 * that depends on how many pixels apart they are. As you zoom in, finer
 * levels smoothly fade in; as you zoom out, they smoothly fade out.
 * This eliminates pop-in/pop-out entirely.
 */
function getGridLevels() {
  // Generate a sorted array of all grid steps that could be relevant
  // at the current zoom, from very fine to very coarse.
  const pxPerUnit = view.scale;
  const levels = [];

  if (state.tauMode) {
    // Tau mode: grid x-levels are decimal multiples of τ = 2π
    // Use 1-5 pattern (same as normal mode) but scaled by τ:
    // 0.1τ, 0.5τ, τ, 5τ, 10τ, 50τ, …
    const TAU = 2 * Math.PI;
    const minWorldSpan = 3 / pxPerUnit;
    const maxWorldSpan = 2000 / pxPerUnit;
    // Express in τ units
    const minTau = minWorldSpan / TAU;
    const maxTau = maxWorldSpan / TAU;
    const minLog = Math.floor(Math.log10(minTau)) - 1;
    const maxLog = Math.ceil(Math.log10(maxTau)) + 1;
    for (let d = minLog; d <= maxLog; d++) {
      const p = Math.pow(10, d);
      for (const m of [1, 5]) {
        const step = TAU * m * p;
        const px = step * pxPerUnit;
        if (px < 2 || px > 5000) continue;
        levels.push({ step, px });
      }
    }
  } else {
    // Find the decade range we need
    const minWorldSpan = 3 / pxPerUnit;
    const maxWorldSpan = 2000 / pxPerUnit;
    const minLog = Math.floor(Math.log10(minWorldSpan)) - 1;
    const maxLog = Math.ceil(Math.log10(maxWorldSpan)) + 1;

    for (let d = minLog; d <= maxLog; d++) {
      const p = Math.pow(10, d);
      for (const m of [1, 5]) {
        const step = m * p;
        const px = step * pxPerUnit;
        if (px < 2) continue;
        if (px > 5000) continue;
        levels.push({ step, px });
      }
    }
  }
  levels.sort((a, b) => a.step - b.step);

  // Build result with a single normalised alpha (0-1) per level.
  // Every consumer (gridlines, ticks, labels, arrows, starbursts) scales
  // this same alpha by its own max-opacity constant — the fade behaviour
  // is written once here.
  const result = [];
  for (const lv of levels) {
    const px = lv.px;
    if (px < 50) continue;
    // Smooth fade: 0 at ≤50 px, 1 at ≥80 px
    const alpha = constrain((px - 50) / 30, 0, 1);
    if (alpha < 0.01) continue;
    result.push({ step: lv.step, alpha, px });
  }
  // Enforce: at most ONE layer may be partially fading in (alpha < 1).
  // Walk from coarsest (end) to finest (start); first partial → drop
  // everything finer.
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].alpha < 0.99) {
      if (i > 0) result.splice(0, i);
      break;
    }
  }
  return result;
}

/** Get grid levels for the y-axis (always decimal, ignoring tau mode). */
function getYGridLevels() {
  if (!state.tauMode) return getGridLevels();
  // Decimal 1-5 grid for y-axis even in tau mode
  const pxPerUnit = view.scale;
  const levels = [];
  const minWorldSpan = 3 / pxPerUnit;
  const maxWorldSpan = 2000 / pxPerUnit;
  const minLog = Math.floor(Math.log10(minWorldSpan)) - 1;
  const maxLog = Math.ceil(Math.log10(maxWorldSpan)) + 1;
  for (let d = minLog; d <= maxLog; d++) {
    const p = Math.pow(10, d);
    for (const m of [1, 5]) {
      const step = m * p;
      const px = step * pxPerUnit;
      if (px < 2 || px > 5000) continue;
      levels.push({ step, px });
    }
  }
  levels.sort((a, b) => a.step - b.step);
  const result = [];
  for (const lv of levels) {
    if (lv.px < 50) continue;
    const alpha = constrain((lv.px - 50) / 30, 0, 1);
    if (alpha < 0.01) continue;
    result.push({ step: lv.step, alpha, px: lv.px });
  }
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].alpha < 0.99) { if (i > 0) result.splice(0, i); break; }
  }
  return result;
}

function drawGridLines() {
  const { minX, maxX, minY, maxY } = getVisibleWorldBounds();
  const diagWorld = Math.sqrt(width * width + height * height) / view.scale + 2;

  const xCol = getStepColor("x");
  const yCol = getStepColor("y");
  const xLevels = getGridLevels();    // tau-aware for x-axis
  const yLevels = getYGridLevels();   // always decimal for y-axis

  strokeWeight(1);

  // Restrict y gridlines to visible function range, clamped to viewport
  // (without clamping, a function like 3x²+2x+5 with rangeMax≈3M causes
  //  millions of off-screen line draws)
  const dr = state.fn ? computeVisibleDomainRange() : null;
  const yGridMin = Math.max(minY, (dr && Number.isFinite(dr.rangeMin)) ? dr.rangeMin : minY);
  const yGridMax = Math.min(maxY, (dr && Number.isFinite(dr.rangeMax)) ? dr.rangeMax : maxY);

  // Vertical lines (x grid) — tau-aware
  if (state.toggles.xgrid) {
    for (const lv of xLevels) {
      const alpha = lv.alpha * 40;
      stroke(red(xCol), green(xCol), blue(xCol), alpha);
      for (let x = Math.floor((minX - 1) / lv.step) * lv.step; x <= maxX + 1; x += lv.step) {
        const p1 = worldToScreen(x, -diagWorld);
        const p2 = worldToScreen(x, diagWorld);
        line(p1.x, p1.y, p2.x, p2.y);
      }
    }
  }

  // Horizontal lines (y grid) — always decimal
  if (state.toggles.ygrid) {
    for (const lv of yLevels) {
      const alpha = lv.alpha * 40;
      stroke(red(yCol), green(yCol), blue(yCol), alpha);
      for (let y = Math.floor((yGridMin - 1) / lv.step) * lv.step; y <= yGridMax + 1; y += lv.step) {
        const p1 = worldToScreen(-diagWorld, y);
        const p2 = worldToScreen(diagWorld, y);
        line(p1.x, p1.y, p2.x, p2.y);
      }
    }
  }
}

// Returns the next finer step in the 1-2-5 grid sequence
function getNextFinerStep(currentStep) {
  const log10 = Math.log10(currentStep);
  const decade = Math.floor(log10 + 1e-9);
  const mantissa = currentStep / Math.pow(10, decade);
  if (Math.abs(mantissa - 5) < 0.1) return 2 * Math.pow(10, decade);
  if (Math.abs(mantissa - 2) < 0.1) return 1 * Math.pow(10, decade);
  if (Math.abs(mantissa - 1) < 0.1) return 5 * Math.pow(10, decade - 1);
  return currentStep / 2;
}

// getArrowGridLevels is now just an alias — getGridLevels already returns
// normalised 0-1 alpha so no extra wrapper is needed.
function getArrowGridLevels() {
  return getGridLevels();
}

// Legacy wrapper kept for any remaining callers
function getGridStepAndFade() {
  const minorStep = niceGridStep(view.scale);
  const majorStep = minorStep * 5;
  const finerStep = getNextFinerStep(minorStep);
  const finerPx = finerStep * view.scale;
  const finerFade = constrain((finerPx - 8) / 14, 0, 1);
  return { minorStep, majorStep, finerStep, finerFade };
}

// Per-frame cache for computeVisibleDomainRange (called multiple times per draw)
let _domainRangeCache = null;
let _domainRangeCacheFrame = -1;

function computeVisibleDomainRange() {
  if (!state.fn) return { domainMin: -Infinity, domainMax: Infinity, rangeMin: -Infinity, rangeMax: Infinity };
  // Return cached result if already computed this frame
  if (_domainRangeCacheFrame === frameCount && _domainRangeCache) return _domainRangeCache;
  const { minX, maxX } = getVisibleWorldBounds();
  // Sample over a wide domain to capture the function's full range,
  // not just the visible portion — ensures y-axis covers all reachable values.
  const sampleMin = Math.min(-1000, minX);
  const sampleMax = Math.max(1000, maxX);
  let domainMin = Infinity, domainMax = -Infinity;
  let rangeMin = Infinity, rangeMax = -Infinity;
  const samples = 2000;
  const step = (sampleMax - sampleMin) / samples;
  for (let i = 0; i <= samples; i++) {
    const x = sampleMin + i * step;
    let y;
    try { y = state.fn(x); } catch { continue; }
    if (!Number.isFinite(y)) continue;
    if (x < domainMin) domainMin = x;
    if (x > domainMax) domainMax = x;
    if (y < rangeMin) rangeMin = y;
    if (y > rangeMax) rangeMax = y;
  }
  _domainRangeCache = { domainMin, domainMax, rangeMin, rangeMax };
  _domainRangeCacheFrame = frameCount;
  return _domainRangeCache;
}

function drawAxesAndLabels(majorStep) {
  // Axes
  const showYAxis = state.toggles.yaxis;
  const xAxisColor = getStepColor("x");
  const yAxisColor = getStepColor("y");
  const tickAlpha = state.lightMode ? 80 : 120;
  const tickColor = state.lightMode ? color(0, 0, 0, tickAlpha) : color(255, 255, 255, tickAlpha);

  const origin = worldToScreen(0, 0);
  const diagWorld = Math.sqrt(width * width + height * height) / view.scale + 2;
  const θ = view.rotation;
  // Perpendicular directions for tick marks (in screen space)
  const xPerp = { x: Math.sin(θ), y: Math.cos(θ) }; // perp to x-axis
  const yPerp = { x: -Math.cos(θ), y: Math.sin(θ) }; // perp to y-axis

  const dr = state.fn ? computeVisibleDomainRange() : null;

  // In any discrete mode, axes are drawn by discrete renderers — skip continuous lines.
  if (!isDiscreteAny()) {
    // x-axis — draw along world x direction
    strokeWeight(2);
    if (state.toggles.xaxis) {
      stroke(red(xAxisColor), green(xAxisColor), blue(xAxisColor), 220);
      if (dr && Number.isFinite(dr.domainMin) && Number.isFinite(dr.domainMax)) {
        const p1 = worldToScreen(dr.domainMin, 0);
        const p2 = worldToScreen(dr.domainMax, 0);
        line(p1.x, p1.y, p2.x, p2.y);
      } else {
        const p1 = worldToScreen(-diagWorld, 0);
        const p2 = worldToScreen(diagWorld, 0);
        line(p1.x, p1.y, p2.x, p2.y);
      }
    }
    // y-axis — draw along world y direction
    if (showYAxis) {
      stroke(red(yAxisColor), green(yAxisColor), blue(yAxisColor), 220);
      strokeWeight(2);
      if (dr && Number.isFinite(dr.rangeMin) && Number.isFinite(dr.rangeMax)) {
        const p1 = worldToScreen(0, dr.rangeMin);
        const p2 = worldToScreen(0, dr.rangeMax);
        line(p1.x, p1.y, p2.x, p2.y);
      } else {
        const p1 = worldToScreen(0, -diagWorld);
        const p2 = worldToScreen(0, diagWorld);
        line(p1.x, p1.y, p2.x, p2.y);
      }
    }
  }

  // Tick marks and labels — use continuous grid levels for smooth fading
  const { minX, maxX, minY, maxY } = getVisibleWorldBounds();
  // In discrete tau mode, use decimal grid levels for x so labels align with columns
  const _discreteTau = isDiscreteAny() && state.tauMode;
  let xLevels = _discreteTau ? getYGridLevels() : getGridLevels();
  let yLevels = getYGridLevels();      // always decimal for y-axis
  const tickBaseCol = state.lightMode ? [0, 0, 0] : [255, 255, 255];
  const _eSTauLabel = _discreteTau ? (2 * Math.PI) : 1; // scale factor for x-label formatting

  // In discrete modes, clamp grid levels to the discrete resolution
  if (isDiscreteAny()) {
    const { xStep, yStep } = getDiscreteStep();
    xLevels = xLevels.filter(lv => lv.step >= xStep - 1e-9);
    yLevels = yLevels.filter(lv => lv.step >= yStep - 1e-9);
  }

  // Tick marks only in continuous mode — colored to match axes, with glow
  if (!isDiscreteAny()) {
    const xTickCol = getStepColor("x");
    const yTickCol = getStepColor("y");

    // x ticks (tau-aware)
    if (state.toggles.xaxis) {
      for (const lv of xLevels) {
        const tAlpha = lv.alpha * 160;
        if (tAlpha < 1) continue;
        push();
        stroke(red(xTickCol), green(xTickCol), blue(xTickCol), tAlpha);
        strokeWeight(1);
        if (state.glowCurves) {
          drawingContext.shadowColor = `rgba(${red(xTickCol)},${green(xTickCol)},${blue(xTickCol)},0.5)`;
          drawingContext.shadowBlur = 6;
        }
        for (let x = Math.floor(minX / lv.step) * lv.step; x <= maxX; x += lv.step) {
          const s = worldToScreen(x, 0);
          if (s.x < -50 || s.x > width + 50 || s.y < -50 || s.y > height + 50) continue;
          line(s.x - xPerp.x * 4, s.y - xPerp.y * 4, s.x + xPerp.x * 4, s.y + xPerp.y * 4);
        }
        pop();
      }
    }

    // y ticks (always decimal)
    if (showYAxis) {
      for (const lv of yLevels) {
        const tAlpha = lv.alpha * 160;
        if (tAlpha < 1) continue;
        push();
        stroke(red(yTickCol), green(yTickCol), blue(yTickCol), tAlpha);
        strokeWeight(1);
        if (state.glowCurves) {
          drawingContext.shadowColor = `rgba(${red(yTickCol)},${green(yTickCol)},${blue(yTickCol)},0.5)`;
          drawingContext.shadowBlur = 6;
        }
        for (let y = Math.floor(minY / lv.step) * lv.step; y <= maxY; y += lv.step) {
          const s = worldToScreen(0, y);
          if (s.x < -50 || s.x > width + 50 || s.y < -50 || s.y > height + 50) continue;
          line(s.x - yPerp.x * 4, s.y - yPerp.y * 4, s.x + yPerp.x * 4, s.y + yPerp.y * 4);
        }
        pop();
      }
    }
  }

  // Labels — fade in with grid levels, using glass pill backgrounds
  const xAxisCol = getStepColor("x");
  const yAxisCol2 = getStepColor("y");

  // x labels (tau-aware) — shown when x-axis AND xlabels are both on
  if (state.toggles.xaxis && state.toggles.xlabels) {
    for (const lv of xLevels) {
      const labelAlpha = lv.alpha * 190;
      if (labelAlpha < 1) continue;
      for (let x = Math.floor(minX / lv.step) * lv.step; x <= maxX; x += lv.step) {
        const s = worldToScreen(x, 0);
        if (s.x < -50 || s.x > width + 50 || s.y < -50 || s.y > height + 50) continue;
        drawGlassLabel(formatXLabel(x * _eSTauLabel), s.x + xPerp.x * 8, s.y + xPerp.y * 8 + 2,
          { col: xAxisCol, alpha: labelAlpha, align: "center", baseline: "top", size: 11 });
      }
    }
  }

  // y labels (always decimal) — shown when y-axis AND ylabels are both on
  if (showYAxis && state.toggles.ylabels) {
    for (const lv of yLevels) {
      const labelAlpha = lv.alpha * 190;
      if (labelAlpha < 1) continue;
      for (let y = Math.floor(minY / lv.step) * lv.step; y <= maxY; y += lv.step) {
        const s = worldToScreen(0, y);
        if (s.x < -50 || s.x > width + 50 || s.y < -50 || s.y > height + 50) continue;
        drawGlassLabel(formatNumber(y), s.x + yPerp.x * 8 - 2, s.y + yPerp.y * 8 - 2,
          { col: yAxisCol2, alpha: labelAlpha, align: "right", baseline: "bottom", size: 11 });
      }
    }
  }
}

const MONO_FONT = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";
const SANS_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

function getLabelFont() {
  return MONO_FONT;
}

/**
 * Draw a label with a rounded frosted-glass pill background.
 * @param {string} txt - Label text
 * @param {number} sx  - Screen x
 * @param {number} sy  - Screen y
 * @param {object} opts - { col, alpha, align, baseline, size, glow }
 *   col: p5 color or [r,g,b]
 *   alpha: 0-255 (default 220)
 *   align: "left"|"center"|"right" (default "left")
 *   baseline: "top"|"center"|"bottom" (default "bottom")
 *   size: font size (default 12)
 *   glow: boolean — add color glow behind label text (default: state.glowCurves)
 */
function drawGlassLabel(txt, sx, sy, opts = {}) {
  const col = opts.col;
  const a = opts.alpha !== undefined ? opts.alpha : 220;
  const sz = opts.size || 12;
  const halign = opts.align || "left";
  const vbaseline = opts.baseline || "bottom";
  const doGlow = opts.glow !== undefined ? opts.glow : state.glowCurves;

  let r, g, b;
  if (Array.isArray(col)) {
    r = col[0]; g = col[1]; b = col[2];
  } else if (col) {
    r = red(col); g = green(col); b = blue(col);
  } else {
    const def = state.lightMode ? [30, 35, 50] : [230, 240, 255];
    r = def[0]; g = def[1]; b = def[2];
  }

  // Blend text color toward white in glow mode for brighter appearance
  const wt = doGlow ? (state.lightMode ? 0.0 : 0.25) : 0;
  const tr = r + (255 - r) * wt;
  const tg = g + (255 - g) * wt;
  const tb = b + (255 - b) * wt;

  // Use raw canvas API for reliable font control
  const ctx = drawingContext;
  ctx.save();

  const fontStr = `${sz}px ${getLabelFont()}`;
  ctx.font = fontStr;

  const tw = ctx.measureText(txt).width;
  const pad = 4;
  const pillW = tw + pad * 2;
  const pillH = sz + pad * 2;

  // Compute pill origin based on alignment
  let px, py;
  if (halign === "center") px = sx - pillW / 2;
  else if (halign === "right") px = sx - pillW;
  else px = sx;
  if (vbaseline === "bottom") py = sy - pillH;
  else if (vbaseline === "center") py = sy - pillH / 2;
  else py = sy;

  // Glass background — higher alpha than CSS bars to compensate for no backdrop-filter blur
  const alphaFrac = a / 255;
  const bgBaseAlpha = state.lightMode ? 0.7 : 0.55;
  const bgAlpha = bgBaseAlpha * alphaFrac;
  // Use selected background color for glass panes in light mode, or defaults
  const bgRGB = (state.lightMode && state.bgColorRGB) ? state.bgColorRGB : null;
  const bgR = bgRGB ? bgRGB[0] : (state.lightMode ? 255 : 0);
  const bgG = bgRGB ? bgRGB[1] : (state.lightMode ? 255 : 0);
  const bgB = bgRGB ? bgRGB[2] : (state.lightMode ? 255 : 0);

  // Draw softened glass (blurred pass for frosted edges, then solid center)
  ctx.fillStyle = `rgba(${bgR},${bgG},${bgB},${bgAlpha * 0.5})`;
  ctx.filter = 'blur(4px)';
  ctx.beginPath();
  const rad = pillH / 2;
  if (ctx.roundRect) {
    ctx.roundRect(px, py, pillW, pillH, rad);
  } else {
    ctx.moveTo(px + rad, py);
    ctx.arcTo(px + pillW, py, px + pillW, py + pillH, rad);
    ctx.arcTo(px + pillW, py + pillH, px, py + pillH, rad);
    ctx.arcTo(px, py + pillH, px, py, rad);
    ctx.arcTo(px, py, px + pillW, py, rad);
    ctx.closePath();
  }
  ctx.fill();
  ctx.filter = 'none';

  // Solid glass center
  ctx.fillStyle = `rgba(${bgR},${bgG},${bgB},${bgAlpha})`;
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(px, py, pillW, pillH, rad);
  } else {
    ctx.moveTo(px + rad, py);
    ctx.arcTo(px + pillW, py, px + pillW, py + pillH, rad);
    ctx.arcTo(px + pillW, py + pillH, px, py + pillH, rad);
    ctx.arcTo(px, py + pillH, px, py, rad);
    ctx.arcTo(px, py, px + pillW, py, rad);
    ctx.closePath();
  }
  ctx.fill();

  // Draw text (glow on text only)
  ctx.font = fontStr; // re-set after filter changes
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  if (doGlow) {
    ctx.shadowColor = `rgba(${r},${g},${b},0.6)`;
    ctx.shadowBlur = 10;
  }
  ctx.fillStyle = `rgba(${tr},${tg},${tb},${alphaFrac})`;
  ctx.fillText(txt, px + pad, py + pad);

  ctx.restore();
}

function formatNumber(v) {
  // Keep labels compact — 1 decimal place.
  const av = Math.abs(v);
  if (av === 0) return "0";
  if (av >= 1000 || av < 0.001) return v.toExponential(1);
  const s = v.toFixed(1);
  return s.replace(/\.?0+$/, "");
}

/** Format a number for live-value display: always 1 decimal place. */
function formatLiveNumber(v) {
  if (!Number.isFinite(v)) return '\u2014';
  const av = Math.abs(v);
  if (av >= 1e4) return v.toExponential(1);
  return (Math.round(v * 10) / 10).toFixed(1);
}

/** Format a value as a decimal multiple of τ (e.g. 0.1τ, 0.5τ, τ, 2τ). */
function formatTauNumber(v) {
  if (!Number.isFinite(v)) return '\u2014';
  const TAU = 2 * Math.PI;
  const ratio = v / TAU;
  if (Math.abs(ratio) < 0.001) return '0';
  if (Math.abs(ratio - 1) < 0.001) return '\u03c4';
  if (Math.abs(ratio + 1) < 0.001) return '-\u03c4';
  // Clean decimal: round to 1 d.p. to avoid float noise
  const r = Math.round(ratio * 10) / 10;
  const s = r.toFixed(1).replace(/\.?0+$/, '');
  return s + '\u03c4';
}

/** Format x for live display, respecting tau mode. */
function formatLiveX(v) {
  if (state.tauMode) return formatTauNumber(v);
  return formatLiveNumber(v);
}

/** Format x for axis labels, respecting tau mode. */
function formatXLabel(v) {
  if (state.tauMode) return formatTauNumber(v);
  return formatNumber(v);
}

function getPlotColor() {
  const [r, g, b] = hexToRgb(userColors.curve);
  return color(r, g, b);
}

function getDeltaArrowColor(delta) {
  // Use a neutral color for arrows — step-typed coloring is preferred
  return state.lightMode ? color(80, 90, 110, 200) : color(180, 195, 220, 200);
}

function getVisibleWorldBounds() {
  const corners = [
    screenToWorld(0, 0),
    screenToWorld(width, 0),
    screenToWorld(0, height),
    screenToWorld(width, height),
  ];
  return {
    minX: Math.min(corners[0].x, corners[1].x, corners[2].x, corners[3].x),
    maxX: Math.max(corners[0].x, corners[1].x, corners[2].x, corners[3].x),
    minY: Math.min(corners[0].y, corners[1].y, corners[2].y, corners[3].y),
    maxY: Math.max(corners[0].y, corners[1].y, corners[2].y, corners[3].y),
  };
}

function getMajorStepWorld() {
  // Pick the grid level from the 1-2-5 sequence that gives ~50-120px spacing for labels
  const pxPerUnit = view.scale;
  const targetPx = 80;
  const raw = targetPx / Math.max(1e-9, pxPerUnit);
  const pow10 = Math.pow(10, Math.floor(Math.log10(raw)));
  const candidates = [1, 2, 5, 10].map(m => m * pow10);
  let best = candidates[0];
  let bestDist = Infinity;
  for (const c of candidates) {
    const px = c * pxPerUnit;
    if (px < 30) continue; // too dense for labels
    const dist = Math.abs(px - targetPx);
    if (dist < bestDist) { bestDist = dist; best = c; }
  }
  return best;
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}

/* ======= Single source of truth for all op/badge/toolbox colours ======= */
const OP_COLORS = {
  x: "#4682dc",
  y: "#5ac878",
  addSub: "#dc5050",
  mulDiv: "#e6963c",
  exp: "#e6c030",   // exponential-related: power, root, b^x, log, ln, exp, 10^x
  trig: "#a064c8",   // sin, cos, tan, asin, acos, atan
  misc: "#8892a8",   // abs, floor, ceil, round
  curve: "#5ac878",
  delete: "#ff4444", // trash / delete action
};
const OP_COLORS_ORIG = { ...OP_COLORS };

// Per-role arm colors — every category uses per-role keys so colours
// follow the arm labels through swaps.
//   addSub: roles "1", "2", "3"  (addend + addend = sum)
//   mulDiv: roles "2", "4", "8"  (factor × factor = product)
//   exp:    roles "base", "exponent", "power"
const ARM_COLORS = {
  addSub: { "1": "#e84848", "2": "#e84848", "3": "#ff0010" },
  mulDiv: { "2": "#e88020", "4": "#e88020", "8": "#ff4a00" },
  exp: { base: "#c8a028", exponent: "#c0d038", power: "#ffb800" },
};

/** Equalize all OP_COLORS to a uniform perceptual lightness in OKLCH */
function equalizeOpColors(on, targetL) {
  targetL = targetL || 0.65;
  if (on) {
    for (const key of Object.keys(OP_COLORS_ORIG)) {
      const hex = OP_COLORS_ORIG[key];
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      const lab = rgbToOklab(r, g, b);
      const lch = oklabToOklch(lab.L, lab.a, lab.b);
      const newLab = oklchToOklab(targetL, lch.C, lch.h);
      const [nr, ng, nb] = oklabToRgb(newLab.L, newLab.a, newLab.b);
      const rr = Math.round(Math.max(0, Math.min(255, nr)));
      const gg = Math.round(Math.max(0, Math.min(255, ng)));
      const bb = Math.round(Math.max(0, Math.min(255, nb)));
      OP_COLORS[key] = `#${rr.toString(16).padStart(2, '0')}${gg.toString(16).padStart(2, '0')}${bb.toString(16).padStart(2, '0')}`;
    }
  } else {
    Object.assign(OP_COLORS, OP_COLORS_ORIG);
  }
}
const userColors = OP_COLORS;

/* Classify an op into a colour category */
const TRIG_FNS = new Set(["sin", "cos", "tan", "asin", "acos", "atan"]);
const EXP_FNS = new Set(["exp", "ln", "log"]);

function getOpCategory(op) {
  if (op.type === "add" || op.type === "sub") return "addSub";
  if (op.type === "mul" || op.type === "div") return "mulDiv";
  if (op.type === "power") return "exp";
  const fn = getFunctionName(op);
  if (fn) {
    if (TRIG_FNS.has(fn)) return "trig";
    if (EXP_FNS.has(fn)) return "exp";
    return "misc";
  }
  if (op.label === "x\u00B2") return "exp";
  if (getPowerExponent(op) !== null) return "exp";
  if (getRootN(op) !== null) return "exp";
  if (getExpBase(op) !== null) return "exp";
  if (getLogBase(op) !== null) return "exp";
  if (op.label === "10^x") return "exp";
  if (getModOperand(op) !== null) return "mulDiv";
  return "misc";
}

// Map raw op type strings ("add","mul","other") to OP_COLORS keys
function resolveTypeToCategory(type) {
  if (type === "add" || type === "sub") return "addSub";
  if (type === "mul" || type === "div") return "mulDiv";
  return "misc";
}

/** Blend a hex colour toward the page background to simulate opacity.
 *  Returns a new #rrggbb hex string. */
function dimHexColor(hex, opacity) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  const dark = document.body.classList.contains('dark-mode');
  const bg = dark ? { r: 28, g: 30, b: 46 } : { r: 247, g: 247, b: 249 };
  const mr = Math.round(r * opacity + bg.r * (1 - opacity));
  const mg = Math.round(g * opacity + bg.g * (1 - opacity));
  const mb = Math.round(b * opacity + bg.b * (1 - opacity));
  return `#${mr.toString(16).padStart(2, '0')}${mg.toString(16).padStart(2, '0')}${mb.toString(16).padStart(2, '0')}`;
}

// Arm role opacities (semantic, not positional)
const ARM_OP = { IN: 0.3, OPERAND: 1.0, OUT: 0.6 };

/**
 * Get the function (output-arm) and operand (top-arm) colors for an op.
 * For 3-arm junctions the colors reflect the current rotation state.
 * For 2-arm junctions (no operand) opndColor equals the base hex.
 */
function getOpArmColors(op) {
  const colorHex = OP_COLORS[getColorKeyForOp(op)] || OP_COLORS.misc;
  const { IN, OPERAND: OP, OUT } = ARM_OP;
  // arm order is [BL, T, BR]; output=BR, operand=T
  let brOpacity = OUT, tOpacity = OP;
  if (getExpFamilyState(op) >= 0) {
    const st = getExpFamilyState(op);
    if (st === 1) { brOpacity = OP; tOpacity = IN; }   // log
    else if (st === 2) { brOpacity = IN; tOpacity = OUT; } // root
  } else {
    // add/sub, mul/div: state 1 (sub, div) = one CW rotation
    const info = getRotationInfo(op);
    if (info && info.curState === 1) { brOpacity = OP; tOpacity = IN; }
  }
  return {
    fnColor: dimHexColor(colorHex, brOpacity),
    opndColor: dimHexColor(colorHex, tOpacity),
    colorHex,
  };
}

/**
 * Get fn/operand colors for an AST binary operator character.
 * Maps +,-,*,/,%,** → same arm-derived colors as getOpArmColors.
 * Single source of truth for both sequential and traditional LaTeX.
 */
function getAstBinaryColors(opChar) {
  const { IN, OPERAND: OP, OUT } = ARM_OP;
  const families = {
    '+': { hex: OP_COLORS.addSub, state: 0 },
    '-': { hex: OP_COLORS.addSub, state: 1 },
    '*': { hex: OP_COLORS.mulDiv, state: 0 },
    '/': { hex: OP_COLORS.mulDiv, state: 1 },
    '%': { hex: OP_COLORS.mulDiv, state: 0 },
    '**': { hex: OP_COLORS.exp, state: 0 },
  };
  const info = families[opChar];
  if (!info) return { fnColor: OP_COLORS.misc, opndColor: OP_COLORS.misc };
  let brOp = OUT, tOp = OP;
  if (info.state === 1) { brOp = OP; tOp = IN; }
  return {
    fnColor: dimHexColor(info.hex, brOp),
    opndColor: dimHexColor(info.hex, tOp),
  };
}

// ---- Step colors (for arrows and boxes): use OP_COLORS single source of truth ----
// Accepts a category key ("x","y","addSub","exp",…) OR a step/op object (with .type/.label)
function getStepColor(typeOrOp) {
  let cat;
  if (typeof typeOrOp === "object" && typeOrOp !== null) {
    // For special step types like "x"/"y" that exist directly in OP_COLORS
    cat = OP_COLORS[typeOrOp.type] ? typeOrOp.type : getOpCategory(typeOrOp);
  } else {
    cat = OP_COLORS[typeOrOp] ? typeOrOp : resolveTypeToCategory(typeOrOp);
  }
  const hex = OP_COLORS[cat] || OP_COLORS.misc;
  const [r, g, b] = hexToRgb(hex);
  return color(r, g, b);
}

// ---- Glow color helper: returns rgba string for drawingContext.shadowColor ----
function getGlowRGBA(key) {
  const toggleMap = { grid: OP_COLORS.x, yaxis: OP_COLORS.y, arrows: OP_COLORS.curve, intermediates: OP_COLORS.misc };
  let hex = toggleMap[key];
  if (!hex) {
    if (key === "x") hex = OP_COLORS.x;
    else if (key === "y") hex = OP_COLORS.y;
    else {
      const idx = parseInt(key);
      if (!isNaN(idx) && state.ops[idx]) hex = OP_COLORS[getOpCategory(state.ops[idx])] || OP_COLORS.misc;
      else hex = OP_COLORS.misc;
    }
  }
  const [r, g, b] = hexToRgb(hex);
  return state.lightMode
    ? `rgba(${r}, ${g}, ${b}, 0.85)`
    : `rgba(${r}, ${g}, ${b}, 1.0)`;
}

// ---- Expression parser: tokenize -> AST -> linearized steps ----
/**
 * Pre-process log_base(value) notation → (ln(value)/ln(base)).
 * Handles balanced parentheses in the argument so log_2(x+sin(x)) works.
 * Only fires when the base is a simple token (identifier/number); complex
 * base expressions like (x+1) are not matched and should use ln form directly.
 */
function expandLogBase(expr) {
  let result = '';
  let i = 0;
  while (i < expr.length) {
    const m = expr.slice(i).match(/^log_([a-zA-Z][a-zA-Z0-9_]*|[0-9]+(?:\.[0-9]+)?)\(/);
    if (m) {
      const base = m[1];
      const openIdx = i + m[0].length; // first char after '('
      let depth = 1, j = openIdx;
      while (j < expr.length && depth > 0) {
        if (expr[j] === '(') depth++;
        else if (expr[j] === ')') depth--;
        j++;
      }
      if (depth === 0) {
        const arg = expr.slice(openIdx, j - 1);
        result += `(ln(${arg})/ln(${base}))`;
        i = j;
      } else { result += expr[i]; i++; }
    } else { result += expr[i]; i++; }
  }
  return result;
}

/**
 * Pre-process nthrt_n(value) notation → ((value)^(1/(n))).
 * nthrt_2(x) = sqrt(x), nthrt_3(x) = cube root, etc.
 * Handles balanced parentheses in the argument.
 */
function expandNthRoot(expr) {
  let result = '';
  let i = 0;
  while (i < expr.length) {
    const m = expr.slice(i).match(/^nthrt_([a-zA-Z][a-zA-Z0-9_]*|[0-9]+(?:\.[0-9]+)?)\(/);
    if (m) {
      const index = m[1];
      const openIdx = i + m[0].length;
      let depth = 1, j = openIdx;
      while (j < expr.length && depth > 0) {
        if (expr[j] === '(') depth++;
        else if (expr[j] === ')') depth--;
        j++;
      }
      if (depth === 0) {
        const arg = expr.slice(openIdx, j - 1);
        result += `((${arg})^(1/(${index})))`;
        i = j;
      } else { result += expr[i]; i++; }
    } else { result += expr[i]; i++; }
  }
  return result;
}

const TOK = {
  NUM: "NUM",
  VAR_X: "VAR_X",
  IDENT: "IDENT",
  PLUS: "PLUS",
  MINUS: "MINUS",
  STAR: "STAR",
  SLASH: "SLASH",
  PERCENT: "PERCENT",
  STARSTAR: "STARSTAR",
  LPAREN: "LPAREN",
  RPAREN: "RPAREN",
  COMMA: "COMMA",
  EOF: "EOF",
};

function tokenize(str) {
  const s = str.replace(/\s+/g, "").replace(/\^/g, "**");
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === "+") {
      tokens.push({ type: TOK.PLUS });
      i++;
    } else if (s[i] === "-") {
      tokens.push({ type: TOK.MINUS });
      i++;
    } else if (s[i] === "*") {
      if (s[i + 1] === "*") {
        tokens.push({ type: TOK.STARSTAR });
        i += 2;
      } else {
        tokens.push({ type: TOK.STAR });
        i++;
      }
    } else if (s[i] === "/") {
      tokens.push({ type: TOK.SLASH });
      i++;
    } else if (s[i] === "%") {
      tokens.push({ type: TOK.PERCENT });
      i++;
    } else if (s[i] === "(") {
      tokens.push({ type: TOK.LPAREN });
      i++;
    } else if (s[i] === ")") {
      tokens.push({ type: TOK.RPAREN });
      i++;
    } else if (s[i] === ",") {
      tokens.push({ type: TOK.COMMA });
      i++;
    } else if (/[0-9.]/.test(s[i])) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      const num = parseFloat(s.slice(i, j));
      if (!Number.isFinite(num)) throw new Error("Invalid number");
      tokens.push({ type: TOK.NUM, value: num });
      i = j;
    } else if (/[a-zA-Z_]/.test(s[i])) {
      let j = i;
      while (j < s.length && /[a-zA-Z0-9_]/.test(s[j])) j++;
      const id = s.slice(i, j);
      if (id === "x") tokens.push({ type: TOK.VAR_X });
      else tokens.push({ type: TOK.IDENT, value: id });
      i = j;
    } else {
      i++;
    }
  }
  tokens.push({ type: TOK.EOF });
  return tokens;
}

function parseExpression(tokens) {
  let pos = 0;
  function cur() {
    return tokens[pos] || { type: TOK.EOF };
  }
  function consume(ty) {
    if (cur().type === ty) {
      pos++;
      return true;
    }
    return false;
  }

  function expr() {
    let left = term();
    while (cur().type === TOK.PLUS || cur().type === TOK.MINUS) {
      const op = cur().type === TOK.PLUS ? "+" : "-";
      pos++;
      const right = term();
      left = { type: "binary", op, left, right };
    }
    return left;
  }

  function term() {
    let left = factor();
    while (cur().type === TOK.STAR || cur().type === TOK.SLASH || cur().type === TOK.PERCENT) {
      const op = cur().type === TOK.STAR ? "*" : cur().type === TOK.SLASH ? "/" : "%";
      pos++;
      const right = factor();
      left = { type: "binary", op, left, right };
    }
    return left;
  }

  function factor() {
    return power();
  }

  function power() {
    let left = unary();
    if (consume(TOK.STARSTAR)) {
      const right = power();
      return { type: "binary", op: "**", left, right };
    }
    return left;
  }

  function unary() {
    if (consume(TOK.PLUS)) return unary();
    if (consume(TOK.MINUS)) return { type: "binary", op: "-", left: { type: "num", value: 0 }, right: unary() };
    return postfix();
  }

  function postfix() {
    const p = primary();
    if (cur().type === TOK.LPAREN) {
      pos++;
      const arg = expr();
      if (!consume(TOK.RPAREN)) throw new Error("Expected )");
      return { type: "call", fn: p.type === "ident" ? p.value : null, arg };
    }
    return p;
  }

  function primary() {
    if (consume(TOK.LPAREN)) {
      const e = expr();
      if (!consume(TOK.RPAREN)) throw new Error("Expected )");
      return e;
    }
    if (cur().type === TOK.NUM) {
      const v = cur().value;
      pos++;
      return { type: "num", value: v };
    }
    if (cur().type === TOK.VAR_X) {
      pos++;
      return { type: "var", name: "x" };
    }
    if (cur().type === TOK.IDENT) {
      const value = cur().value;
      pos++;
      return { type: "ident", value };
    }
    throw new Error("Unexpected token");
  }

  const ast = expr();
  if (cur().type !== TOK.EOF) throw new Error("Unexpected token");
  return ast;
}

function exprString(node) {
  if (!node) return "";
  if (node.type === "num") return String(node.value);
  if (node.type === "var") return "x";
  if (node.type === "ident") return node.value;
  if (node.type === "binary") {
    const left = exprString(node.left);
    const right = exprString(node.right);
    const needParenLeft = node.left.type === "binary" && precedence(node.left.op) < precedence(node.op);
    const needParenRight = node.right.type === "binary" && precedence(node.right.op) <= precedence(node.op);
    return (needParenLeft ? "(" + left + ")" : left) + node.op + (needParenRight ? "(" + right + ")" : right);
  }
  if (node.type === "call") {
    const fn = node.fn || exprString(node.arg);
    return fn + "(" + exprString(node.arg) + ")";
  }
  return "";
}

function precedence(op) {
  if (op === "+" || op === "-") return 1;
  if (op === "*" || op === "/" || op === "%") return 2;
  if (op === "**") return 3;
  return 0;
}

/* ======= AST → color-coded LaTeX (for KaTeX rendering) ======= */

/** Return the current LaTeX multiplication symbol based on user toggle. */
function latexMulSym() {
  return state.latexMulSymbol === 'times' ? '\\times' : '\\cdot';
}

/** Check if the leftmost displayed leaf of an AST subtree is (or renders as) a number.
 *  Used for juxtaposition: 5·x² → 5x² (starts with var, no parens)
 *  vs 5·2^x → 5(2^x) (starts with digit, needs parens).
 *  When hasX=true, x/t are replaced by a number, so they also count as digits. */
function _astStartsWithDigit(node, hasX) {
  if (!node) return false;
  if (node.type === "num") return true;
  if (node.type === "var") return !!hasX; // x renders as a number when live
  if (node.type === "ident" || node.type === "call") return false;
  if (node.type === "unary") return false;
  if (node.type === "binary") return _astStartsWithDigit(node.left, hasX);
  return false;
}

/**
 * Convert an AST node to a LaTeX string with \textcolor{hex}{...} wrapping
 * for each semantically-meaningful piece (operators, functions, variables).
 * Color assignments match colorizeRawExpr / OP_COLORS.
 * When xVal is a finite number, x is replaced by its numeric value.
 */
function astToColoredLatex(node, xVal, parentOpndColor) {
  if (!node) return "";
  const hasX = xVal !== undefined && xVal !== null && Number.isFinite(xVal);

  switch (node.type) {
    case "num": {
      const v = node.value;
      let str;
      if (Number.isInteger(v) && Math.abs(v) < 1e15) str = String(v);
      else str = parseFloat(v.toPrecision(10)).toString();
      // If a parent binary op supplied an operand colour, apply it
      return parentOpndColor ? `\\textcolor{${parentOpndColor}}{${str}}` : str;
    }

    case "var":
      if (hasX) return `\\textcolor{${OP_COLORS.x}}{${formatLatexNumber(xVal)}}`;
      return `\\textcolor{${OP_COLORS.x}}{x}`;

    case "ident": {
      const id = node.value;
      if (id === "pi" || id === "PI")
        return `\\textcolor{${OP_COLORS.misc}}{\\pi}`;
      if (id === "tau" || id === "TAU")
        return `\\textcolor{${OP_COLORS.misc}}{\\tau}`;
      if (id === "e")
        return `\\textcolor{${OP_COLORS.misc}}{e}`;
      if (id === "t")
        return `\\textcolor{${OP_COLORS.misc}}{t}`;
      return `\\text{${id}}`;
    }

    case "call": {
      const fn = node.fn;
      const inner = astToColoredLatex(node.arg, xVal);
      let color = OP_COLORS.misc;
      if (TRIG_FNS.has(fn)) color = OP_COLORS.trig;
      else if (EXP_FNS.has(fn) || fn === "sqrt" || fn.startsWith("log_") || fn.startsWith("nthrt_")) color = OP_COLORS.exp;
      const fnColor = dimHexColor(color, ARM_OP.OUT);

      /* sqrt → radical sign */
      if (fn === "sqrt")
        return `\\textcolor{${fnColor}}{\\sqrt{${inner}}}`;

      /* abs → vertical bars */
      if (fn === "abs")
        return `\\textcolor{${fnColor}}{\\lvert}${inner}\\textcolor{${fnColor}}{\\rvert}`;

      /* floor / ceil → bracket delimiters */
      if (fn === "floor")
        return `\\textcolor{${fnColor}}{\\lfloor}${inner}\\textcolor{${fnColor}}{\\rfloor}`;
      if (fn === "ceil")
        return `\\textcolor{${fnColor}}{\\lceil}${inner}\\textcolor{${fnColor}}{\\rceil}`;

      /* nthrt_n: nth root → \sqrt[n]{…} */
      const nthrtMatch = fn.match(/^nthrt_(.+)$/);
      if (nthrtMatch) {
        const idx = nthrtMatch[1];
        const idxLatex = idx === "x"
          ? `\\textcolor{${OP_COLORS.x}}{x}`
          : `\\textcolor{${color}}{${idx}}`;
        if (idx === "2")
          return `\\textcolor{${fnColor}}{\\sqrt{${inner}}}`;
        return `\\textcolor{${fnColor}}{\\sqrt[${idxLatex}]{${inner}}}`;
      }

      /* log with a base: log_2, log_x, etc. → \log_{base}(…) */
      const logBaseMatch = fn.match(/^log_(.+)$/);
      if (logBaseMatch) {
        const base = logBaseMatch[1];
        // Color variable bases like x with OP_COLORS.x, others with exp color
        const baseLatex = base === "x"
          ? `\\textcolor{${OP_COLORS.x}}{x}`
          : `\\textcolor{${color}}{${base}}`;
        return `{\\textcolor{${fnColor}}{\\log}}_{${baseLatex}}\\textcolor{${fnColor}}{(}${inner}\\textcolor{${fnColor}}{)}`;
      }

      /* Standard named functions: sin, cos, tan, arcXXX, ln, log, exp, round */
      const latexFnMap = {
        sin: "\\sin", cos: "\\cos", tan: "\\tan",
        asin: "\\arcsin", acos: "\\arccos", atan: "\\arctan",
        ln: "\\ln", log: "\\log", exp: "\\exp",
        round: "\\text{round}",
      };
      const latexFn = latexFnMap[fn] || `\\text{${fn}}`;
      return `\\textcolor{${fnColor}}{${latexFn}}\\textcolor{${fnColor}}{(}${inner}\\textcolor{${fnColor}}{)}`;
    }

    case "binary": {
      const { op, left, right } = node;

      /* ── addition / subtraction ────────────────────── */
      if (op === "+") {
        const { fnColor: fn, opndColor: opC } = getAstBinaryColors('+');
        return `${astToColoredLatex(left, xVal, opC)} \\textcolor{${fn}}{+} ${astToColoredLatex(right, xVal, opC)}`;
      }
      if (op === "-") {
        const { fnColor: fn, opndColor: opC } = getAstBinaryColors('-');
        // Unary minus: parser encodes as 0 - rhs
        if (left.type === "num" && left.value === 0) {
          const rLatex = astToColoredLatex(right, xVal, opC);
          const needP = right.type === "binary" && (right.op === "+" || right.op === "-");
          return needP
            ? `\\textcolor{${fn}}{-}\\!\\left(${rLatex}\\right)`
            : `\\textcolor{${fn}}{-}${rLatex}`;
        }
        return `${astToColoredLatex(left, xVal, opC)} \\textcolor{${fn}}{-} ${astToColoredLatex(right, xVal, opC)}`;
      }

      /* ── multiplication ────────────────────────────── */
      if (op === "*") {
        const { fnColor: fn, opndColor: opC } = getAstBinaryColors('*');
        // Normalise: put number/constant coefficients before variable expressions
        // e.g. x^2 * 5 → show as 5x^2 in traditional LaTeX
        let effL = left, effR = right;
        if ((right.type === "num" || right.type === "ident")
          && left.type !== "num" && left.type !== "ident") {
          effL = right; effR = left;
        }
        let lLatex = astToColoredLatex(effL, xVal, opC);
        let rLatex = astToColoredLatex(effR, xVal, opC);
        // Wrap lower-precedence children
        if (effL.type === "binary" && precedence(effL.op) < 2)
          lLatex = `\\left(${lLatex}\\right)`;
        if (effR.type === "binary" && precedence(effR.op) < 2)
          rLatex = `\\left(${rLatex}\\right)`;

        // Use implicit multiplication (juxtaposition) when unambiguous:
        //   number · call, number · var, call · var, etc.
        const lSimple = effL.type === "num" || effL.type === "ident";
        const rIsCallOrVar = effR.type === "call" || effR.type === "var";
        if (lSimple && rIsCallOrVar) {
          // When x is live and renders as a digit, need parens: 2(3) not 23
          if (hasX && effR.type === "var") return `${lLatex}(${rLatex})`;
          // e.g. 5\sin(x) or 2x — juxtaposition, no space
          return `${lLatex}${rLatex}`;
        }
        // number · complex-expr: parens only when expr starts with a digit
        // e.g. 5(2^x) needs parens, but 5x² doesn't (unless x is live → 5(3²))
        if (lSimple && (effR.type === "binary" || effR.type === "call")) {
          if (_astStartsWithDigit(effR, hasX)) return `${lLatex}(${rLatex})`;
          return `${lLatex}${rLatex}`;
        }
        return `${lLatex} \\textcolor{${fn}}{${latexMulSym()}} ${rLatex}`;
      }

      /* ── division → fraction ───────────────────────── */
      if (op === "/") {
        const { fnColor: fn, opndColor: opC } = getAstBinaryColors('/');
        return `\\textcolor{${fn}}{\\frac{${astToColoredLatex(left, xVal, opC)}}{${astToColoredLatex(right, xVal, opC)}}}`;
      }

      /* ── modulo ────────────────────────────────────── */
      if (op === "%") {
        const { fnColor: fn, opndColor: opC } = getAstBinaryColors('%');
        return `${astToColoredLatex(left, xVal, opC)} \\textcolor{${fn}}{\\bmod} ${astToColoredLatex(right, xVal, opC)}`;
      }

      /* ── exponentiation ────────────────────────────── */
      if (op === "**") {
        const { fnColor, opndColor: expOpC } = getAstBinaryColors('**');
        const lLatex = astToColoredLatex(left, xVal);
        const rLatex = astToColoredLatex(right, xVal, expOpC);
        let base = lLatex;
        if (left.type === "binary")
          base = `\\left(${lLatex}\\right)`;

        // x^(1/2) → √x , x^(1/n) → ⁿ√x
        if (right.type === "binary" && right.op === "/"
          && right.left.type === "num" && right.left.value === 1
          && right.right.type === "num") {
          const n = right.right.value;
          if (n === 2)
            return `\\textcolor{${fnColor}}{\\sqrt{${lLatex}}}`;
          return `\\textcolor{${fnColor}}{\\sqrt[${n}]{${lLatex}}}`;
        }

        // Colour the exponent in exp colour
        return `{${base}}^{\\textcolor{${OP_COLORS.exp}}{${rLatex}}}`;
      }
      break;
    }
  }
  return "";
}

/**
 * Convenience: parse raw expression string → colored LaTeX.
 * Returns empty string on failure (partial / invalid input).
 * When xVal is a finite number, substitutes it for x and appends = result.
 */
function exprToColoredLatex(raw, xVal) {
  try {
    const _isDark = !document.body.classList.contains('light');
    const eqSign = _isDark ? `\\textcolor{white}{=}` : `\\textcolor{black}{=}`;

    // When equalsEdge is active, build LaTeX from displaySpans (LHS = RHS)
    if (state.equalsEdge && state.displaySpans && state.displaySpans.length) {
      const eqLatex = _spansToLatex(state.displaySpans, xVal);
      if (xVal !== undefined && xVal !== null && Number.isFinite(xVal)) {
        let yVal;
        try { yVal = state.fn ? state.fn(xVal) : NaN; } catch { yVal = NaN; }
        const resultStr = Number.isFinite(yVal)
          ? `\\textcolor{${OP_COLORS.y}}{${formatLatexNumber(yVal)}}`
          : `\\textcolor{${OP_COLORS.misc}}{\\text{undef}}`;
        return { main: eqLatex, tail: null };
      }
      return { main: eqLatex, tail: null };
    }

    const yPrefix = `\\textcolor{${OP_COLORS.y}}{y}`;

    // Pipe layout → traditional (tree) LaTeX; ops sequence → sequential LaTeX
    const hasPipe = state.pipeLayout && state.pipeLayout.nodes && state.pipeLayout.mainPath;
    const usePipe = hasPipe && !state.latexOpsOrder;          // traditional mode
    const useOps = state.latexOpsOrder && state.ops && state.ops.length > 0; // sequential mode

    function getExprLatex(xv) {
      if (usePipe) return pipeLayoutToColoredLatex(state.pipeLayout, xv);
      if (useOps) return opsToColoredLatex(state.ops, xv);
      const tokens = tokenize(raw);
      const ast = parseExpression(tokens);
      return astToColoredLatex(ast, xv);
    }

    if (xVal !== undefined && xVal !== null && Number.isFinite(xVal)) {
      const exprLatex = getExprLatex(xVal);
      let yVal;
      try { yVal = state.fn ? state.fn(xVal) : NaN; } catch { yVal = NaN; }
      const resultStr = Number.isFinite(yVal)
        ? `\\textcolor{${OP_COLORS.y}}{${formatLatexNumber(yVal)}}`
        : `\\textcolor{${OP_COLORS.misc}}{\\text{undef}}`;
      return {
        main: `${resultStr} ${eqSign} ${exprLatex}`,
        tail: null,
      };
    }
    const body = getExprLatex(undefined);
    return { main: `${yPrefix} ${eqSign} ${body}`, tail: null };
  } catch {
    return "";
  }
}

/** Convert displaySpans [{text, color}] into colored LaTeX.
 *  When xVal is finite, 'x' spans are replaced with their numeric value,
 *  and parentheses are inserted for juxtaposition disambiguation. */
function _spansToLatex(spans, xVal) {
  const hasX = xVal !== undefined && xVal !== null && Number.isFinite(xVal);
  // Resolve CSS variables to actual computed colors for KaTeX
  const isDark = !document.body.classList.contains('light');
  const cssVarMap = {
    'var(--text)': isDark ? '#e0e0e0' : '#1a1a1a',
    'var(--muted)': isDark ? '#888888' : '#666666',
    'var(--bg)': isDark ? '#1a1a2e' : '#ffffff',
  };

  function resolveHex(c) {
    if (!c) return 'white';
    if (c.startsWith('var(')) return cssVarMap[c] || (isDark ? '#e0e0e0' : '#1a1a1a');
    return c;
  }
  function convertText(t) {
    const ms = latexMulSym();
    // Replace * or × (with optional surrounding spaces) in one pass
    t = t.replace(/\s*[\*\u00d7]\s*/g, `\\;${ms}\\;`);
    t = t.replace(/\//g, '\\div ');
    // Greek letters → LaTeX commands
    t = t.replace(/\u03c4/g, '\\tau ');
    t = t.replace(/\u03c0/g, '\\pi ');
    t = t.replace(/ /g, '\\;');
    t = t.replace(/_/g, '\\_');
    return t;
  }

  let out = '';
  let i = 0;
  while (i < spans.length) {
    const s = spans[i];
    const t = s.text.trim();
    const hex = resolveHex(s.color);

    // Handle nthrt_ pseudo-function → \sqrt[index]{argument}
    if (t === 'nthrt_') {
      const fnHex = hex;
      // Gather index spans (between nthrt_ and the opening paren)
      let indexLatex = '';
      let j = i + 1;
      while (j < spans.length && spans[j].text.trim() !== '(') {
        indexLatex += `\\textcolor{${resolveHex(spans[j].color)}}{${convertText(spans[j].text)}}`;
        j++;
      }
      // Skip the '('
      if (j < spans.length && spans[j].text.trim() === '(') j++;
      // Gather argument spans until matching ')'
      let argLatex = '';
      let depth = 1;
      while (j < spans.length && depth > 0) {
        const st = spans[j].text.trim();
        if (st === '(') depth++;
        if (st === ')') { depth--; if (depth === 0) { j++; break; } }
        argLatex += `\\textcolor{${resolveHex(spans[j].color)}}{${convertText(spans[j].text)}}`;
        j++;
      }
      // Check if index is "2" → simple \sqrt
      const rawIndex = spans.slice(i + 1, i + 1 + (j - i - 1)).map(sp => sp.text.trim()).join('');
      const indexOnly = rawIndex.replace(/\(.*/, '');
      if (indexOnly === '2') {
        out += `\\textcolor{${fnHex}}{\\sqrt{${argLatex}}}`;
      } else {
        out += `\\textcolor{${fnHex}}{\\sqrt[${indexLatex}]{${argLatex}}}`;
      }
      i = j;
      continue;
    }

    // Handle log_ pseudo-function → \log_{base}(argument)
    if (t === 'log_') {
      const fnHex = hex;
      // Gather base spans (between log_ and the opening paren)
      let baseLatex = '';
      let j = i + 1;
      while (j < spans.length && spans[j].text.trim() !== '(') {
        baseLatex += `\\textcolor{${resolveHex(spans[j].color)}}{${convertText(spans[j].text)}}`;
        j++;
      }
      // Skip the '('
      if (j < spans.length && spans[j].text.trim() === '(') j++;
      // Gather argument spans until matching ')'
      let argLatex = '';
      let depth = 1;
      while (j < spans.length && depth > 0) {
        const st = spans[j].text.trim();
        if (st === '(') depth++;
        if (st === ')') { depth--; if (depth === 0) { j++; break; } }
        argLatex += `\\textcolor{${resolveHex(spans[j].color)}}{${convertText(spans[j].text)}}`;
        j++;
      }
      out += `\\textcolor{${fnHex}}{\\log}_{${baseLatex}}\\textcolor{${fnHex}}{(}${argLatex}\\textcolor{${fnHex}}{)}`;
      i = j;
      continue;
    }

    // Handle ^ as a proper LaTeX superscript: base^{exponent}
    if (t === '^' && i + 1 < spans.length) {
      const next = spans[i + 1];
      const nhex = resolveHex(next.color);
      let nt = convertText(next.text);
      // Check if the exponent is wrapped in parens — if so, include them inside the superscript
      if (nt === '(' && i + 3 < spans.length) {
        // Gather everything until the matching ')'
        let inner = '';
        let j = i + 2;
        let depth = 1;
        while (j < spans.length && depth > 0) {
          const st = spans[j].text;
          if (st === '(') depth++;
          if (st === ')') depth--;
          if (depth > 0) {
            inner += `\\textcolor{${resolveHex(spans[j].color)}}{${convertText(st)}}`;
          }
          j++;
        }
        out += `^{${inner}}`;
        i = j;
      } else {
        out += `^{\\textcolor{${nhex}}{${nt}}}`;
        i += 2;
      }
      continue;
    }

    // x → numeric value when live
    if (hasX && (t === 'x' || t === 't')) {
      const numStr = formatLatexNumber(xVal);
      out += `\\textcolor{${hex}}{${numStr}}`;
      i++;
      continue;
    }

    out += `\\textcolor{${hex}}{${convertText(s.text)}}`;
    i++;
  }
  return out;
}

/** Format a number for LaTeX display (1 dp max, matching the rest of the UI). */
function formatLatexNumber(v) {
  if (!Number.isFinite(v)) return "\\text{undef}";
  const av = Math.abs(v);
  if (av >= 1e4 || (av !== 0 && av < 0.01)) return v.toExponential(1);
  // Up to 1 decimal place, strip trailing zeros
  return parseFloat(v.toFixed(1)).toString();
}

/** Scale the KaTeX output to fill the latex-display container */
function scaleLatexToFit(el) {
  if (!el) return;
  const katexHtml = el.querySelector('.katex-html');
  if (!katexHtml) return;

  // Reset previous scale so we can measure natural size
  katexHtml.style.transform = 'none';

  // Force layout reflow after reset
  void katexHtml.offsetHeight;

  // Get the section body that has the explicit resized height
  const sectionBody = el.closest('.ew-section__body');
  if (!sectionBody) return;
  const containerH = sectionBody.clientHeight;
  const containerW = sectionBody.clientWidth;
  if (containerH <= 0 || containerW <= 0) return;

  // Measure content at natural size
  const contentRect = katexHtml.getBoundingClientRect();
  const contentH = contentRect.height;
  const contentW = contentRect.width;
  if (contentH <= 0 || contentW <= 0) return;

  // Scale to fit both dimensions with padding.
  // padH accounts for vertical breathing room;
  // padW also includes .latex-row's 8px left+right CSS padding (16px total)
  const padH = 12;
  const padW = 12 + 16;
  const scaleH = (containerH - padH) / contentH;
  const scaleW = (containerW - padW) / contentW;
  const scale = Math.min(scaleH, scaleW, 5); // cap at 5x

  if (scale > 1.05 || scale < 0.95) {
    katexHtml.style.transform = `scale(${scale})`;
    katexHtml.style.transformOrigin = 'center center';
  }
}

/** Render the color-coded LaTeX into the #latex-display element via KaTeX */
function updateLatexDisplay(raw, xVal) {
  const el = ui.latexEl;
  if (!el || typeof katex === "undefined") return;
  _lastLatexLiveKey = "__force__"; // invalidate live cache
  const result = exprToColoredLatex(raw || "", xVal);
  if (!result) {
    el.style.opacity = "0";
    return;
  }
  // result is { main, tail } where tail is the "= value" part (or null)
  // \mathrlap renders the tail at zero width so only 'main' affects centering.
  // The container has overflow:visible so the tail remains readable.
  const latex = result.tail
    ? `${result.main} \\mathrlap{\\;${result.tail}}`
    : result.main;
  try {
    katex.render(latex, el, {
      throwOnError: false,
      displayMode: true,
      output: "html",
    });
    el.style.opacity = "1";
    scaleLatexToFit(el);
  } catch {
    el.style.opacity = "0";
  }
}

/**
 * Throttled live-update for cursor hover.
 * Only re-renders KaTeX when the displayed x-value string changes.
 * When xVal is null (cursor off canvas), reverts to the symbolic equation.
 */
let _lastLatexLiveKey = null;
function updateLatexDisplayLive(xVal) {
  const raw = ui.exprEl?.value ?? "";
  // Build a cheap cache key — formatted x value (or null for symbolic mode)
  const key = (xVal !== null && xVal !== undefined && Number.isFinite(xVal))
    ? formatLatexNumber(xVal)
    : null;
  if (key === _lastLatexLiveKey) return;
  _lastLatexLiveKey = key;
  updateLatexDisplay(raw, xVal);
}

/* ======= Ops-order LaTeX: mirror the step-flow sequence ======= */

/**
 * Build LaTeX that mirrors the operations toolbox sequence.
 * e.g. for "5*x^2": ops = [{type:"other",label:"x²"}, {type:"mul",operand:"5"}]
 * produces  (x^{2}) \cdot 5   instead of conventional  5x^{2}
 */
function opsToColoredLatex(ops, xVal) {
  if (!ops || ops.length === 0) return `\\textcolor{${OP_COLORS.x}}{x}`;
  const hasX = xVal !== undefined && xVal !== null && Number.isFinite(xVal);

  let latex = hasX
    ? `\\textcolor{${OP_COLORS.x}}{${formatLatexNumber(xVal)}}`
    : `\\textcolor{${OP_COLORS.x}}{x}`;
  let prevPrec = 999;

  for (const op of ops) {
    const { fnColor, opndColor } = getOpArmColors(op);
    const c = (s) => `\\textcolor{${fnColor}}{${s}}`;
    const cOp = (s) => `\\textcolor{${opndColor}}{${s}}`;

    // Color a complex operand recursively: try to parse it as an AST
    // so sub-expressions like "2*x" keep their internal colours instead
    // of being wrapped in a single parent-operand colour.
    function coloredOperand(raw) {
      if (!raw) return cOp("");
      // Simple number or single-char variable → just use parent operand colour
      if (/^-?\d+(\.\d+)?$/.test(raw) || /^[a-zA-Z]$/.test(raw)) {
        if (raw === "x") return `\\textcolor{${OP_COLORS.x}}{${hasX ? formatLatexNumber(xVal) : "x"}}`;
        return cOp(raw);
      }
      // Complex expression → parse and recursively colour
      try {
        const tokens = tokenize(raw);
        const ast = parseExpression(tokens);
        return astToColoredLatex(ast, xVal, opndColor);
      } catch {
        return cOp(raw);
      }
    }

    if (op.type === "add" || op.type === "sub") {
      const sym = op.type === "add" ? "+" : "-";
      latex = `${latex} ${c(sym)} ${coloredOperand(op.operand || "")}`;
      prevPrec = 1;
    } else if (op.type === "mul" || op.type === "div") {
      if (prevPrec < 2) latex = `${c("(")}${latex}${c(")")}`;
      if (op.type === "div") {
        latex = c(`\\frac{${latex}}{${coloredOperand(op.operand || "")}}`);
      } else {
        const operand = op.operand || "";
        if (/[+\-]/.test(operand) && !/^\d/.test(operand)) {
          latex = `${latex} ${c(latexMulSym())} ${c("(")}${coloredOperand(operand)}${c(")")}`;
        } else {
          latex = `${latex} ${c(latexMulSym())} ${coloredOperand(operand)}`;
        }
      }
      prevPrec = 2;
    } else {
      const fnName = getFunctionName(op);
      if (fnName) {
        if (fnName === "sqrt") {
          latex = c(`\\sqrt{${latex}}`);
        } else if (fnName === "abs") {
          latex = `${c("\\lvert")}${latex}${c("\\rvert")}`;
        } else if (fnName === "floor") {
          latex = `${c("\\lfloor")}${latex}${c("\\rfloor")}`;
        } else if (fnName === "ceil") {
          latex = `${c("\\lceil")}${latex}${c("\\rceil")}`;
        } else {
          const latexFnMap = {
            sin: "\\sin", cos: "\\cos", tan: "\\tan",
            asin: "\\arcsin", acos: "\\arccos", atan: "\\arctan",
            ln: "\\ln", log: "\\log", exp: "\\exp",
            round: "\\text{round}",
          };
          const ltx = latexFnMap[fnName] || `\\text{${fnName}}`;
          latex = `${c(`${ltx}`)}${c("(")}${latex}${c(")")}`;
        }
        prevPrec = 999;
      } else if (op.label === "x\u00B2") {
        if (prevPrec < 3) latex = `${c("(")}${latex}${c(")")}`;
        latex = `{${latex}}^{${cOp("2")}}`;
        prevPrec = 3;
      } else if (getExpBase(op) !== null) {
        const base = op.operand || getExpBase(op);
        latex = `{${coloredOperand(base)}}^{${latex}}`;
        prevPrec = 999;
      } else if (getLogBase(op) !== null) {
        const base = op.operand || getLogBase(op);
        latex = `{${c("\\log")}}_{${coloredOperand(base)}}${c("(")}${latex}${c(")")}`;
        prevPrec = 999;
      } else if (op.label === "^ \u22121" || op.label === "^ -1") {
        if (prevPrec < 3) latex = `${c("(")}${latex}${c(")")}`;
        latex = `{${latex}}^{${c("-1")}}`;
        prevPrec = 3;
      } else if (getPowerExponent(op) !== null) {
        const expStr = op.operand || getPowerExponent(op);
        if (prevPrec < 3) latex = `${c("(")}${latex}${c(")")}`;
        latex = `{${latex}}^{${coloredOperand(expStr)}}`;
        prevPrec = 3;
      } else if (getRootN(op) !== null) {
        const rootN = op.operand || getRootN(op);
        if (prevPrec < 3) latex = `${c("(")}${latex}${c(")")}`;
        latex = `{${latex}}^{${c("1/")}${coloredOperand(rootN)}}`;
        prevPrec = 3;
      } else if (getModOperand(op) !== null) {
        const modVal = op.operand || getModOperand(op);
        if (prevPrec < 2) latex = `${c("(")}${latex}${c(")")}`;
        latex = `${latex} ${c("\\bmod")} ${coloredOperand(modVal)}`;
        prevPrec = 2;
      } else {
        latex += ` ${c(op.label)}`;
        prevPrec = 0;
      }
    }
  }
  return latex;
}

/* ======= LaTeX \u2192 expression string converter (for paste-in) ======= */

/**
 * Convert a LaTeX string to an expression string that the calculator can parse.
 * Returns null if conversion fails or result is invalid.
 */
function latexToExpr(latex) {
  if (!latex || typeof latex !== "string") return null;
  let s = latex.trim();

  // Strip leading y= or f(x)= prefix
  s = s.replace(/^\\?[yf]\s*(?:\\\(?\s*x\s*\\?\))?\s*=\s*/i, "");

  // Remove \\textcolor{...}{content} \u2192 keep content
  s = s.replace(/\\textcolor\{[^}]*\}\{([^}]*)\}/g, "$1");

  // Remove display-mode wrappers
  s = s.replace(/\\displaystyle\s*/g, "");
  s = s.replace(/\\left\s*/g, "");
  s = s.replace(/\\right\s*/g, "");
  s = s.replace(/\\,/g, " ");
  s = s.replace(/\\!/g, "");
  s = s.replace(/\\;\s*/g, " ");
  s = s.replace(/\\quad\s*/g, " ");

  // \\frac{a}{b} \u2192 ((a)/(b))
  for (let i = 0; i < 10 && /\\frac\{/.test(s); i++) {
    s = s.replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, "(($1)/($2))");
  }

  // \\sqrt[n]{expr} \u2192 (expr)^(1/(n))
  s = s.replace(/\\sqrt\[([^\]]+)\]\{([^}]*)\}/g, "(($2))^(1/($1))");
  // \\sqrt{expr} \u2192 sqrt(expr)
  s = s.replace(/\\sqrt\{([^}]*)\}/g, "sqrt($1)");

  // Named functions
  const fnMap = {
    "\\\\sin": "sin", "\\\\cos": "cos", "\\\\tan": "tan",
    "\\\\arcsin": "asin", "\\\\arccos": "acos", "\\\\arctan": "atan",
    "\\\\ln": "ln", "\\\\log": "log", "\\\\exp": "exp",
  };
  for (const [ltx, fn] of Object.entries(fnMap)) {
    s = s.replace(new RegExp(ltx + "\\s*\\{([^}]*)\\}", "g"), fn + "($1)");
    s = s.replace(new RegExp(ltx + "\\s*\\(", "g"), fn + "(");
    s = s.replace(new RegExp(ltx + "(?=\\s|[^a-zA-Z])", "g"), fn);
  }

  // Delimiters \u2192 function calls
  s = s.replace(/\\lvert\s*(.*?)\\rvert/g, "abs($1)");
  s = s.replace(/\\lfloor\s*(.*?)\\rfloor/g, "floor($1)");
  s = s.replace(/\\lceil\s*(.*?)\\rceil/g, "ceil($1)");

  // Constants and operators
  s = s.replace(/\\bmod/g, "%");
  s = s.replace(/\\pi/g, "pi");
  s = s.replace(/\\tau/g, "tau");
  s = s.replace(/\\cdot/g, "*");
  s = s.replace(/\\times/g, "*");

  // ^{expr} \u2192 ^(expr)
  s = s.replace(/\^\{([^}]*)\}/g, "^($1)");

  // Remove remaining braces/backslashes
  s = s.replace(/\\text\{([^}]*)\}/g, "$1");
  s = s.replace(/\{/g, "(").replace(/\}/g, ")");
  s = s.replace(/\\/g, "");
  s = s.replace(/\s+/g, "");

  // Validate
  try {
    const tokens = tokenize(s);
    parseExpression(tokens);
    compileExpression(s);
    return s;
  } catch {
    return null;
  }
}

/**
 * Get the raw (uncolored) LaTeX string for the current expression.
 */
function getRawLatex() {
  const raw = ui.exprEl?.value ?? "";
  if (!raw.trim()) return "";

  // When equalsEdge is active and displaySpans exist, use spans for the equation
  if (state.equalsEdge && state.displaySpans && state.displaySpans.length) {
    return state.displaySpans.map(s => s.text).join('');
  }

  try {
    const tokens = tokenize(raw);
    const ast = parseExpression(tokens);
    if (state.latexOpsOrder && state.ops.length > 0) {
      return "y = " + _opsToPlainLatex(state.ops);
    }
    return "y = " + _astToPlainLatex(ast);
  } catch {
    return "";
  }
}

/** AST \u2192 plain LaTeX (no \\textcolor) */
function _astToPlainLatex(node) {
  if (!node) return "";
  switch (node.type) {
    case "num": {
      const v = node.value;
      if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
      return parseFloat(v.toPrecision(10)).toString();
    }
    case "var": return "x";
    case "ident": {
      const id = node.value;
      if (id === "pi" || id === "PI") return "\\pi";
      if (id === "tau" || id === "TAU") return "\\tau";
      return id;
    }
    case "call": {
      const fn = node.fn, inner = _astToPlainLatex(node.arg);
      if (fn === "sqrt") return `\\sqrt{${inner}}`;
      if (fn === "abs") return `\\lvert ${inner} \\rvert`;
      if (fn === "floor") return `\\lfloor ${inner} \\rfloor`;
      if (fn === "ceil") return `\\lceil ${inner} \\rceil`;
      const map = { sin: "\\sin", cos: "\\cos", tan: "\\tan", asin: "\\arcsin", acos: "\\arccos", atan: "\\arctan", ln: "\\ln", log: "\\log", exp: "\\exp" };
      return `${map[fn] || fn}(${inner})`;
    }
    case "binary": {
      const { op, left, right } = node;
      if (op === "+") return `${_astToPlainLatex(left)} + ${_astToPlainLatex(right)}`;
      if (op === "-") {
        if (left.type === "num" && left.value === 0) return `-${_astToPlainLatex(right)}`;
        return `${_astToPlainLatex(left)} - ${_astToPlainLatex(right)}`;
      }
      if (op === "*") {
        let l = _astToPlainLatex(left), r = _astToPlainLatex(right);
        if (left.type === "binary" && precedence(left.op) < 2) l = `(${l})`;
        if (right.type === "binary" && precedence(right.op) < 2) r = `(${r})`;
        const lSimple = left.type === "num" || left.type === "ident";
        const rCallOrVar = right.type === "call" || right.type === "var";
        if (lSimple && rCallOrVar) return `${l}${r}`;
        // number · complex-expr: parens only when expr starts with a digit
        const rNeedsParen = (right.type === "binary" || right.type === "call") && _astStartsWithDigit(right);
        if (lSimple && rNeedsParen) return `${l}(${r})`;
        // number · complex-expr starting with var: juxtaposition (e.g. 5x²)
        if (lSimple && (right.type === "binary" || right.type === "call")) return `${l}${r}`;
        return `${l} ${latexMulSym()} ${r}`;
      }
      if (op === "/") return `\\frac{${_astToPlainLatex(left)}}{${_astToPlainLatex(right)}}`;
      if (op === "%") return `${_astToPlainLatex(left)} \\bmod ${_astToPlainLatex(right)}`;
      if (op === "**") {
        let base = _astToPlainLatex(left);
        if (left.type === "binary") base = `(${base})`;
        if (right.type === "binary" && right.op === "/" && right.left.type === "num" && right.left.value === 1 && right.right.type === "num") {
          const n = right.right.value;
          return n === 2 ? `\\sqrt{${_astToPlainLatex(left)}}` : `\\sqrt[${n}]{${_astToPlainLatex(left)}}`;
        }
        return `{${base}}^{${_astToPlainLatex(right)}}`;
      }
    }
  }
  return "";
}

/** Ops \u2192 plain LaTeX (no \\textcolor) */
function _opsToPlainLatex(ops) {
  let latex = "x", prevPrec = 999;
  for (const op of ops) {
    if (op.type === "add" || op.type === "sub") {
      latex = `${latex} ${op.type === "add" ? "+" : "-"} ${op.operand || ""}`;
      prevPrec = 1;
    } else if (op.type === "mul" || op.type === "div") {
      if (prevPrec < 2) latex = `(${latex})`;
      latex = op.type === "div" ? `\\frac{${latex}}{${op.operand || ""}}` : `${latex} ${latexMulSym()} ${op.operand || ""}`;
      prevPrec = 2;
    } else {
      const fnName = getFunctionName(op);
      if (fnName) {
        if (fnName === "sqrt") latex = `\\sqrt{${latex}}`;
        else if (fnName === "abs") latex = `\\lvert ${latex} \\rvert`;
        else if (fnName === "floor") latex = `\\lfloor ${latex} \\rfloor`;
        else if (fnName === "ceil") latex = `\\lceil ${latex} \\rceil`;
        else { const m = { sin: "\\sin", cos: "\\cos", tan: "\\tan", asin: "\\arcsin", acos: "\\arccos", atan: "\\arctan", ln: "\\ln", log: "\\log", exp: "\\exp" }; latex = `${m[fnName] || fnName}(${latex})`; }
        prevPrec = 999;
      } else if (op.label === "x\u00B2") {
        if (prevPrec < 3) latex = `(${latex})`;
        latex = `{${latex}}^{2}`; prevPrec = 3;
      } else if (getPowerExponent(op) !== null) {
        if (prevPrec < 3) latex = `(${latex})`;
        latex = `{${latex}}^{${op.operand || getPowerExponent(op)}}`; prevPrec = 3;
      } else if (getRootN(op) !== null) {
        if (prevPrec < 3) latex = `(${latex})`;
        latex = `{${latex}}^{1/${op.operand || getRootN(op)}}`; prevPrec = 3;
      } else if (getModOperand(op) !== null) {
        if (prevPrec < 2) latex = `(${latex})`;
        latex = `${latex} \\bmod ${op.operand || getModOperand(op)}`; prevPrec = 2;
      } else { latex += ` ${op.label}`; prevPrec = 0; }
    }
  }
  return latex;
}

const ALLOWED_IDS = new Set([
  "x", "t", "pi", "e", "tau", "sin", "cos", "tan", "asin", "acos", "atan",
  "sqrt", "abs", "ln", "log", "exp", "floor", "ceil", "round", "mod",
]);

/**
 * Check whether an AST subtree contains a reference to x.
 */
function astContainsX(node) {
  if (!node) return false;
  if (node.type === "var") return true;
  if (node.type === "binary") return astContainsX(node.left) || astContainsX(node.right);
  if (node.type === "call") return astContainsX(node.arg);
  return false;
}

function linearize(node) {
  const steps = [];

  function pushStep(type, label, expr, operand, applyToExpr) {
    steps.push({ type, label, expr, operand: operand || null, applyToExpr: applyToExpr || null });
  }

  /**
   * Recursively linearize the AST, always following the branch that contains x.
   * For commutative binary ops where x is on the right, we swap sides so
   * left is always the x-containing branch.
   */
  function go(n) {
    if (!n) return "";
    if (n.type === "num") {
      pushStep("other", String(n.value), String(n.value));
      return String(n.value);
    }
    if (n.type === "var") {
      pushStep("x", "x", "x");
      return "x";
    }
    if (n.type === "ident") {
      if (!ALLOWED_IDS.has(n.value)) throw new Error("Unknown identifier " + n.value);
      pushStep("other", n.value, n.value);
      return n.value;
    }
    if (n.type === "binary") {
      const leftHasX = astContainsX(n.left);
      const rightHasX = astContainsX(n.right);

      if (n.op === "+" || n.op === "-") {
        // If x is only on the right side for +, swap: a+f(x) => f(x)+a
        if (!leftHasX && rightHasX && n.op === "+") {
          const xExpr = go(n.right);
          const otherStr = exprString(n.left);
          const label = "+ " + otherStr;
          const expr = "(" + xExpr + ")+(" + otherStr + ")";
          pushStep("add", label, expr, otherStr, (prev) => "(" + prev + ")+(" + otherStr + ")");
          return expr;
        }
        // If x is only on the right for -, rewrite: a - f(x) => negate(f(x)) + a
        // i.e. operate on x branch first, then handle the subtraction
        if (!leftHasX && rightHasX && n.op === "-") {
          // a - f(x) = -(f(x) - a) ... but that changes semantics.
          // Better: a - f(x) => f(x) * (-1) + a
          const xExpr = go(n.right);
          const otherStr = exprString(n.left);
          // Negate: multiply by -1
          const negExpr = "(" + xExpr + ")*(-1)";
          pushStep("mul", "× −1", negExpr, "-1", (prev) => "(" + prev + ")*(-1)");
          // Then add the constant
          const expr = "(" + negExpr + ")+(" + otherStr + ")";
          pushStep("add", "+ " + otherStr, expr, otherStr, (prev) => "(" + prev + ")+(" + otherStr + ")");
          return expr;
        }
        // Normal case: x on left
        const leftExpr = go(n.left);
        const rightStr = exprString(n.right);
        const label = (n.op === "+" ? "+ " : "− ") + rightStr;
        const expr = "(" + leftExpr + ")" + n.op + "(" + rightStr + ")";
        const op = n.op;
        pushStep(n.op === "+" ? "add" : "sub", label, expr, rightStr, (prev) => "(" + prev + ")" + op + "(" + rightStr + ")");
        return expr;
      }
      if (n.op === "*" || n.op === "/") {
        // If x is only on the right for *, swap: a*f(x) => f(x)*a
        if (!leftHasX && rightHasX && n.op === "*") {
          const xExpr = go(n.right);
          const otherStr = exprString(n.left);
          const label = "× " + otherStr;
          const expr = "(" + xExpr + ")*(" + otherStr + ")";
          pushStep("mul", label, expr, otherStr, (prev) => "(" + prev + ")*(" + otherStr + ")");
          return expr;
        }
        // If x is only on the right for /, rewrite: a / f(x) => f(x)^(-1) * a
        if (!leftHasX && rightHasX && n.op === "/") {
          const xExpr = go(n.right);
          const otherStr = exprString(n.left);
          // Reciprocal: raise to -1
          const recipExpr = "(" + xExpr + ")**(-1)";
          pushStep("other", "^ −1", recipExpr, "-1", (prev) => "(" + prev + ")**(-1)");
          // Then multiply
          const expr = "(" + recipExpr + ")*(" + otherStr + ")";
          pushStep("mul", "× " + otherStr, expr, otherStr, (prev) => "(" + prev + ")*(" + otherStr + ")");
          return expr;
        }
        // Normal case: x on left
        const leftExpr = go(n.left);
        const rightStr = exprString(n.right);
        const label = (n.op === "*" ? "× " : "/ ") + rightStr;
        const expr = "(" + leftExpr + ")" + n.op + "(" + rightStr + ")";
        const op = n.op;
        pushStep(n.op === "*" ? "mul" : "div", label, expr, rightStr, (prev) => "(" + prev + ")" + op + "(" + rightStr + ")");
        return expr;
      }
      if (n.op === "%") {
        const leftExpr = go(n.left);
        const rightStr = exprString(n.right);
        const label = "% " + rightStr;
        const expr = "((" + leftExpr + ")%(" + rightStr + ")+(" + rightStr + "))%(" + rightStr + ")";
        pushStep("other", label, expr, rightStr, (prev) => "((" + prev + ")%(" + rightStr + ")+(" + rightStr + "))%(" + rightStr + ")");
        return expr;
      }
      if (n.op === "**") {
        const leftExpr = go(n.left);
        const rightStr = exprString(n.right);
        const rightVal = n.right.type === "num" ? n.right.value : null;
        const isInt = rightVal !== null && Number.isInteger(rightVal) && rightVal >= 2;
        const isX = n.left.type === "var";
        if (isX && isInt) {
          const label = "^ " + rightStr;
          const expr = "(" + leftExpr + ")**(" + rightStr + ")";
          pushStep("other", label, expr, rightStr, (prev) => "(" + prev + ")**(" + rightStr + ")");
          return expr;
        }
        const label = "^ " + rightStr;
        const expr = "(" + leftExpr + ")" + "**" + "(" + rightStr + ")";
        pushStep("other", label, expr, rightStr, (prev) => "(" + prev + ")**(" + rightStr + ")");
        return expr;
      }
    }
    if (n.type === "call") {
      const argExpr = go(n.arg);
      const fnName = n.fn || "?";
      const label = fnName + "()";
      const expr = fnName + "(" + argExpr + ")";
      pushStep("other", label, expr, null, (prev) => fnName + "(" + prev + ")");
      return expr;
    }
    return exprString(n);
  }

  go(node);
  return steps;
}

/**
 * Replace ** operators with safePow() calls, handling balanced parentheses.
 * Ensures negative bases with non-integer exponents produce real results.
 */
function replacePowWithSafe(s) {
  let result = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '*' && i + 1 < s.length && s[i + 1] === '*') {
      // Found **. Extract left operand from result, right from remaining.
      let left;
      if (result.endsWith(')')) {
        let depth = 1, j = result.length - 2;
        while (j >= 0 && depth > 0) {
          if (result[j] === ')') depth++;
          if (result[j] === '(') depth--;
          j--;
        }
        j++;
        left = result.substring(j);
        result = result.substring(0, j);
      } else {
        let j = result.length - 1;
        while (j >= 0 && /[a-zA-Z0-9_.]/.test(result[j])) j--;
        j++;
        left = result.substring(j);
        result = result.substring(0, j);
      }
      i += 2; // skip **
      let right;
      if (i < s.length && s[i] === '(') {
        let depth = 1, j = i + 1;
        while (j < s.length && depth > 0) {
          if (s[j] === '(') depth++;
          if (s[j] === ')') depth--;
          j++;
        }
        right = s.substring(i, j);
        i = j;
      } else {
        let j = i;
        if (j < s.length && s[j] === '-') j++;
        while (j < s.length && /[a-zA-Z0-9_.]/.test(s[j])) j++;
        right = s.substring(i, j);
        i = j;
      }
      result += 'safePow(' + left + ',' + right + ')';
    } else {
      result += s[i];
      i++;
    }
  }
  return result;
}

function compileNormalizedExpr(normalized) {
  let jsExpr = normalized
    .replace(/\bpi\b/g, "PI")
    .replace(/\btau\b/g, "TAU")
    .replace(/\be\b/g, "E")
    .replace(/\blog\b/g, "log10")
    .replace(/\bln\b/g, "log")
    .replace(/\bmod\b/g, "_mod");
  jsExpr = replacePowWithSafe(jsExpr);
  const body =
    '"use strict";' +
    "const t=window._gcT;" +
    "function safePow(b,e){if(b>=0||e===Math.floor(e))return Math.pow(b,e);return NaN;}" +
    "const sin=Math.sin, cos=Math.cos, tan=Math.tan;" +
    "const asin=Math.asin, acos=Math.acos, atan=Math.atan;" +
    "const sqrt=function(v){return v<0?NaN:Math.sqrt(v);}, abs=Math.abs;" +
    "const exp=Math.exp, floor=Math.floor, ceil=Math.ceil, round=Math.round;" +
    "const log=Math.log;" +
    "const log10=(Math.log10?Math.log10:(v)=>Math.log(v)/Math.LN10);" +
    "function _mod(a,b){return ((a%b)+b)%b;};" +
    "const PI=Math.PI, E=Math.E, TAU=2*Math.PI;" +
    "return (" + jsExpr + ");";
  return new Function("x", body);
}

function parseAndLinearize(exprRaw) {
  const expr = (exprRaw ?? "").trim();
  if (!expr) return { steps: [], ops: [], fullExpr: "", pipeLayout: null };
  const normalized = expr.replace(/\s+/g, "").replace(/\^/g, "**");
  // Pre-process log_base(value) and nthrt_n(value) → expanded form before identifier validation
  let expanded = expandLogBase(normalized);
  expanded = expandNthRoot(expanded);
  const identifiers = expanded.match(/[a-zA-Z_]+/g) || [];
  for (const id of identifiers) {
    if (id !== "x" && !ALLOWED_IDS.has(id)) return { steps: [], ops: [], fullExpr: normalized, pipeLayout: null };
  }
  try {
    // Tokenize/parse the EXPANDED form so log_x(2)/nthrt_n(x) are resolved in the AST
    const tokens = tokenize(expandNthRoot(expandLogBase(expr)));
    const ast = parseExpression(tokens);
    const steps = linearize(ast);
    const fullExpr = steps.length > 0 ? steps[steps.length - 1].expr : normalized;
    const fns = steps.map((s) => ({ ...s, fn: compileNormalizedExpr(s.expr) }));
    const ops = fns.filter((s) => s.type !== "x").map((s) => ({
      type: s.type, label: s.label, operand: s.operand,
      applyToExpr: s.applyToExpr,
    }));
    const pipeLayout = astToPipeLayout(ast);
    return { steps: fns, ops, fullExpr, pipeLayout };
  } catch {
    return { steps: [], ops: [], fullExpr: normalized, pipeLayout: null };
  }
}

/**
 * Build a DAG layout for the pipe diagram from the AST.
 * Returns { nodes, mainPath: { valueIds, opIds }, branches } or null if invalid/empty.
 * nodes: [ { id, type: 'value', value } | { id, type: 'op', opType, leftId, rightId, operand, symbol } ]
 * mainPath: path from x to root (valueIds = [xId, ...], opIds = main path op node ids in order)
 * branches: [ { feedsIntoMainOpIndex, opId, inputLeftId, inputRightId } ]
 */
function astToPipeLayout(ast) {
  if (!ast) return null;
  const nodes = [];

  function pushValue(v) {
    const id = nodes.length;
    nodes.push({ id, type: "value", value: v });
    return id;
  }

  function opTypeFromAst(n) {
    if (n.type === "binary") {
      if (n.op === "+") return "add";
      if (n.op === "-") return "sub";
      if (n.op === "*") return "mul";
      if (n.op === "/") return "div";
      if (n.op === "**") return "power";
      if (n.op === "%") return "mod";
    }
    if (n.type === "call") return "call";
    return "other";
  }

  function operandString(n) {
    if (!n) return null;
    if (n.type === "num") return String(n.value);
    if (n.type === "var") return "x";
    if (n.type === "ident") return n.value;
    return exprString(n);
  }

  function symbolFromOp(n) {
    if (n.type === "binary") {
      if (n.op === "+") return "+";
      if (n.op === "-") return "\u2212";
      if (n.op === "*") return "\u00d7";
      if (n.op === "/") return "\u00f7";
      if (n.op === "**") return "^";
      if (n.op === "%") return "%";
    }
    if (n.type === "call") {
      const fn = n.fn || "?";
      // Use bracket symbols for ceil, floor, abs
      if (fn === "ceil") return "\u2308\u2309";  // ⌈⌉
      if (fn === "floor") return "\u230a\u230b";  // ⌊⌋
      if (fn === "abs") return "|\u00b7|";       // |·|
      return fn;  // just the function name, no ()
    }
    return "";
  }

  function go(n) {
    if (!n) return -1;
    if (n.type === "num") return pushValue(String(n.value));
    if (n.type === "var") return pushValue("x");
    if (n.type === "ident") {
      if (!ALLOWED_IDS.has(n.value)) return -1;
      return pushValue(n.value);
    }
    if (n.type === "binary") {
      let leftId = go(n.left);
      let rightId = go(n.right);
      if (leftId < 0 || rightId < 0) return -1;
      if (leftId === rightId) {
        const dup = nodes[leftId];
        rightId = pushValue(dup && dup.type === "value" ? dup.value : "?");
      }
      const id = nodes.length;
      const opType = opTypeFromAst(n);
      const operand = operandString(n.right);
      nodes.push({
        id, type: "op", opType, leftId, rightId,
        operand: opType === "power" || opType === "mul" || opType === "add" || opType === "sub" || opType === "div" ? operand : null,
        symbol: symbolFromOp(n), ast: n,
      });
      return id;
    }
    if (n.type === "call") {
      const argId = go(n.arg);
      if (argId < 0) return -1;
      const id = nodes.length;
      nodes.push({
        id, type: "op", opType: "call", leftId: argId, rightId: null,
        operand: null, symbol: symbolFromOp(n), fn: n.fn, ast: n,
      });
      return id;
    }
    return -1;
  }

  const rootId = go(ast);
  if (rootId < 0 || nodes[rootId].type !== "op") return null;

  function pathFromRootToX(nodeId) {
    const node = nodes[nodeId];
    if (!node) return [];
    if (node.type === "value") return node.value === "x" ? [nodeId] : [];
    if (node.type === "op") {
      const leftPath = pathFromRootToX(node.leftId);
      if (leftPath.length) return [nodeId, ...leftPath];
      if (node.rightId != null) {
        const rightPath = pathFromRootToX(node.rightId);
        if (rightPath.length) return [nodeId, ...rightPath];
      }
    }
    return [];
  }

  const pathToX = pathFromRootToX(rootId);
  if (pathToX.length === 0) return null;
  const mainOpIds = pathToX.filter((id) => nodes[id].type === "op");
  const xId = pathToX[pathToX.length - 1];

  // Create intermediate value nodes for ALL op→op parent-child connections.
  // Each intermediate represents the OUTPUT of a child operator feeding INTO its parent.
  const intermediates = [];
  const opToIntermediateId = new Map();
  const nodeCount = nodes.length; // snapshot before adding intermediates
  for (let i = 0; i < nodeCount; i++) {
    if (nodes[i].type !== "op") continue;
    const node = nodes[i];
    for (const side of ["leftId", "rightId"]) {
      const childId = node[side];
      if (childId == null) continue;
      if (side === "rightId" && node.rightId === node.leftId) continue;
      const child = nodes[childId];
      if (!child || child.type !== "op") continue;

      const intId = nodeCount + intermediates.length;
      intermediates.push({
        id: intId,
        type: "intermediate",
        sourceOpId: childId,
        connectsToOpId: childId,
        value: null,
      });
      opToIntermediateId.set(childId, intId);
      node[side] = intId; // rewire parent to point to intermediate
    }
  }
  const allNodes = [...nodes, ...intermediates];

  const mainPath = { valueIds: [xId, ...mainOpIds], opIds: mainOpIds };

  const mainOpSet = new Set(mainOpIds);
  const branches = [];
  for (let i = 0; i < allNodes.length; i++) {
    if (allNodes[i].type !== "op" || mainOpSet.has(i)) continue;
    for (let j = 0; j < mainOpIds.length; j++) {
      const mainOp = allNodes[mainOpIds[j]];
      if (mainOp.leftId === i || mainOp.rightId === i) {
        branches.push({
          feedsIntoMainOpIndex: j,
          opId: i,
          inputLeftId: allNodes[i].leftId,
          inputRightId: allNodes[i].rightId,
        });
        break;
      }
    }
  }

  return { nodes: allNodes, mainPath, branches, opToIntermediateId };
}

function rebuildStepsFromOps(ops) {
  let expr = "x";
  const steps = [{ type: "x", label: "x", expr: "x", fn: compileNormalizedExpr("x"), operand: null, applyToExpr: null }];
  for (const op of ops) {
    expr = op.applyToExpr(expr);
    steps.push({ ...op, expr, fn: compileNormalizedExpr(expr) });
  }
  return steps;
}

/** Rotate vector (x,y) by angleDeg degrees (CCW). */
function rotateVec(x, y, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  return { x: x * c - y * s, y: x * s + y * c };
}

/**
 * Assign (x, y) positions to all nodes in the DAG.
 * Structure per operator:
 *   - Operator has output arm going south (toward y / parent intermediate)
 *   - Operator branches into two children at 120° from the output arm (NW and NE)
 *   - Children may be values, x, or intermediate nodes
 *   - Intermediate nodes connect vertically (north) to the next operator above them
 */
function computeDagPositions(layout) {
  if (!layout || !layout.nodes || !layout.mainPath || !layout.mainPath.opIds.length) return null;
  const { nodes } = layout;
  const rootOpId = layout.mainPath.opIds[0];
  const NODE_R = 26;
  const PIPE = Math.round(Math.max(80, 2 * NODE_R * 2) * 2 / 3);
  const Y_OFF = PIPE;
  const opToIntermediateId = layout.opToIntermediateId || new Map();

  // Build parent map for ancestor lookups
  const parentOf = {};
  function buildParents(nodeId, visited) {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const node = nodes[nodeId];
    if (!node) return;
    if (node.type === "intermediate" && node.connectsToOpId != null) {
      if (!(node.connectsToOpId in parentOf)) {
        parentOf[node.connectsToOpId] = nodeId;
        buildParents(node.connectsToOpId, visited);
      }
    }
    if (node.type === "op") {
      if (node.leftId != null && !(node.leftId in parentOf)) {
        parentOf[node.leftId] = nodeId;
        buildParents(node.leftId, visited);
      }
      if (node.rightId != null && node.rightId !== node.leftId && !(node.rightId in parentOf)) {
        parentOf[node.rightId] = nodeId;
        buildParents(node.rightId, visited);
      }
    }
  }
  buildParents(rootOpId, new Set());

  // Find the deepest common operator ancestor of two nodes
  function findCommonAncestorOp(a, b) {
    const ancestors = new Set();
    let curr = a;
    while (curr != null) { ancestors.add(curr); curr = parentOf[curr]; }
    curr = b;
    while (curr != null) {
      if (ancestors.has(curr) && nodes[curr] && nodes[curr].type === "op") return curr;
      curr = parentOf[curr];
    }
    return rootOpId;
  }

  // Which direct child of ancestor leads to descendant? Returns 'left' or 'right'
  function whichSide(ancId, descId) {
    let curr = descId;
    while (curr != null && parentOf[curr] !== ancId) curr = parentOf[curr];
    if (curr == null) return null;
    const anc = nodes[ancId];
    if (anc.leftId === curr) return 'left';
    if (anc.rightId === curr) return 'right';
    return null;
  }

  // Per-edge connector length multiplier: edgeMult['opId-left'] or edgeMult['opId-right']
  const edgeMult = {};
  const leftDir = rotateVec(0, 1, -120);   // NE
  const rightDir = rotateVec(0, 1, 120);   // NW

  function placeSubtree(nodeId, x, y) {
    const node = nodes[nodeId];
    if (!node || node.x != null) return;
    node.x = x;
    node.y = y;

    if (node.type === "value") return;

    if (node.type === "intermediate") {
      if (node.connectsToOpId != null) {
        placeSubtree(node.connectsToOpId, x, y - PIPE);
      }
      return;
    }

    if (node.type === "op") {
      const lMult = edgeMult[nodeId + '-left'] || 1;
      const rMult = edgeMult[nodeId + '-right'] || 1;
      if (node.leftId != null) {
        placeSubtree(node.leftId, x + PIPE * lMult * leftDir.x, y + PIPE * lMult * leftDir.y);
      }
      if (node.rightId != null && node.rightId !== node.leftId) {
        placeSubtree(node.rightId, x + PIPE * rMult * rightDir.x, y + PIPE * rMult * rightDir.y);
      }
    }
  }

  // Iterative overlap resolution with per-edge multipliers.
  // Each iteration: find overlaps, increase only the specific arm of the common
  // ancestor that leads to the more "inward" overlapping node.
  const MIN_DIST = 2 * NODE_R + 8;
  for (let iter = 0; iter < 15; iter++) {
    for (const n of nodes) { n.x = null; n.y = null; }
    placeSubtree(rootOpId, 0, 0);

    // Find worst overlap per ancestor
    const ancOverlaps = new Map(); // ancId -> { sideA, sideB, dist }
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].x == null) continue;
      for (let j = i + 1; j < nodes.length; j++) {
        if (nodes[j].x == null) continue;
        const dist = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
        if (dist >= MIN_DIST) continue;
        const anc = findCommonAncestorOp(i, j);
        if (anc == null) continue;
        const sideI = whichSide(anc, i);
        const sideJ = whichSide(anc, j);
        if (sideI && sideJ && sideI !== sideJ) {
          // They're on opposite sides — expand BOTH sides to resolve
          const keyL = anc + '-left';
          const keyR = anc + '-right';
          if (!ancOverlaps.has(keyL) || dist < ancOverlaps.get(keyL)) {
            ancOverlaps.set(keyL, dist);
          }
          if (!ancOverlaps.has(keyR) || dist < ancOverlaps.get(keyR)) {
            ancOverlaps.set(keyR, dist);
          }
        }
      }
    }
    if (ancOverlaps.size === 0) break;
    for (const key of ancOverlaps.keys()) {
      edgeMult[key] = (edgeMult[key] || 1) + 1;
    }
  }

  // Relaxation pass: try to reduce each multiplier by 1 if no overlaps result
  const multKeys = Object.keys(edgeMult).filter(k => edgeMult[k] > 1);
  for (const key of multKeys) {
    const orig = edgeMult[key];
    edgeMult[key] = orig - 1;
    // Re-place all nodes
    for (const n of nodes) { n.x = null; n.y = null; }
    placeSubtree(rootOpId, 0, 0);
    // Check for overlaps
    let hasOverlap = false;
    for (let i = 0; i < nodes.length && !hasOverlap; i++) {
      if (nodes[i].x == null) continue;
      for (let j = i + 1; j < nodes.length; j++) {
        if (nodes[j].x == null) continue;
        const dist = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
        if (dist < MIN_DIST) { hasOverlap = true; break; }
      }
    }
    if (hasOverlap) edgeMult[key] = orig; // revert
  }
  // Final placement with relaxed multipliers
  for (const n of nodes) { n.x = null; n.y = null; }
  placeSubtree(rootOpId, 0, 0);

  return { rootOpId, yX: 0, yY: Y_OFF, PIPE, opToIntermediateId };
}

/**
 * Shared tree walker for exprFromPipeLayout and pipeLayoutToColoredSpans.
 * Produces BOTH a plain-text expression string and colored overlay spans with
 * identical text content, using precedence-aware parenthesization.
 *
 * Returns { text, spans } or null if layout is invalid.
 * Spans: array of { text, color, opacity? }.
 * Numbers get color:null from leaves; the parent operation overrides null with
 * the arm-role color so only plain numbers inherit arm coloring while x, pi,
 * trig functions etc. keep their own specific colours.
 */
function _walkPipeTree(layout) {
  if (!layout || !layout.nodes || !layout.mainPath) return null;
  const nodes = layout.nodes;
  const rootId = layout.mainPath.opIds[0];

  function catFor(opType) {
    if (opType === "add" || opType === "sub") return "addSub";
    if (opType === "mul" || opType === "div") return "mulDiv";
    if (opType === "power") return "exp";
    return null;
  }
  function armCol(cat, roleLabel) {
    const cc = ARM_COLORS[cat];
    return (cc && cc[roleLabel]) || OP_COLORS[cat] || OP_COLORS.misc;
  }

  /* ── tiny helpers ─────────────────────────────────────────── */
  function sp(text, color, opacity) {
    const s = { text, color };
    if (opacity !== undefined) s.opacity = opacity;
    return s;
  }
  function atom(text, color) {
    return { text, spans: [sp(text, color)], prec: 99 };
  }

  /* ── recursive tree walk ──────────────────────────────────── */
  // Returns { text, spans, prec }
  // prec: 1=addSub, 2=mulDiv, 3=power, 99=atomic/call
  function nr(id) {
    const nd = nodes[id];
    if (!nd) return atom("?", "var(--muted)");

    if (nd.type === "value") {
      const v = String(nd.value);
      if (nd.value === "x") return atom(v, OP_COLORS.x);
      if (nd.value === "pi") return atom("π", OP_COLORS.misc);
      if (nd.value === "e") return atom(v, OP_COLORS.misc);
      if (nd.value === "t") return atom(v, OP_COLORS.misc);
      if (nd.value === "tau" || nd.value === "TAU") return atom("τ", OP_COLORS.misc);
      return atom(v, null); // null → inherit arm colour from parent
    }
    if (nd.type === "intermediate") {
      return nd.connectsToOpId != null ? nr(nd.connectsToOpId) : atom("?", "var(--muted)");
    }
    if (nd.type !== "op") return atom("?", "var(--muted)");

    const cat = nd.armCategory || catFor(nd.opType);
    const roles = nd.armAssignment;
    const Lo = nd.leftId != null ? nr(nd.leftId) : null;
    const Ro = (nd.rightId != null && nd.rightId !== nd.leftId) ? nr(nd.rightId) : null;
    const _ac = cat && ARM_COLORS[cat];
    const badge = (_ac && roles && _ac[roles.output]) ? _ac[roles.output] : (cat ? (OP_COLORS[cat] || OP_COLORS.misc) : OP_COLORS.misc);

    /* ── single-arg call ops (trig, sqrt, …) ──────────────── */
    if (nd.opType === "call" && !cat) {
      const fn = nd.fn || (nd.ast && nd.ast.fn) || "f";
      let fnC = OP_COLORS.misc;
      if (TRIG_FNS.has(fn)) fnC = OP_COLORS.trig;
      else if (EXP_FNS.has(fn) || fn === "sqrt") fnC = OP_COLORS.exp;
      const inner = Lo || atom("?", "var(--muted)");
      return {
        text: `${fn}(${inner.text})`,
        spans: [sp(fn, fnC), sp("(", "var(--muted)", 0.35), ...inner.spans, sp(")", "var(--muted)", 0.35)],
        prec: 99
      };
    }

    /* ── fallback for ops without arm assignment ──────────── */
    if (!roles || !cat) {
      if (nd.ast && nd.ast.type === "binary" && Lo && Ro) {
        const p = nd.ast.op === "**" ? "^" : nd.ast.op;
        return {
          text: `(${Lo.text}${p}${Ro.text})`,
          spans: [sp("(", "var(--muted)", 0.35), ...Lo.spans, sp(p, badge), ...Ro.spans, sp(")", "var(--muted)", 0.35)],
          prec: 0
        };
      }
      return Lo || atom("?", "var(--muted)");
    }

    /* ── role mapping ─────────────────────────────────────── */
    const byRole = {};
    byRole[roles.left] = Lo;
    byRole[roles.right] = Ro;

    /** Wrap child in parens when its precedence is too low for context.
     *  Parens are colored to the *parent* operation's badge colour. */
    function w(role, minPrec) {
      const o = byRole[role];
      if (!o) return atom("?", "var(--muted)");
      if (o.prec >= minPrec) return o;
      return {
        text: `(${o.text})`,
        spans: [sp("(", badge, 0.5), ...o.spans, sp(")", badge, 0.5)],
        prec: 99
      };
    }

    /** Colour child spans: override null (numbers) with the arm-role colour. */
    function col(role, result) {
      const ac = armCol(cat, role);
      return result.spans.map(s => s.color === null ? { ...s, color: ac } : s);
    }

    /* ── addSub  (arm1 + arm2 = arm3) ─────────────────────── */
    if (cat === "addSub") {
      if (roles.output === "3") {
        const a = w("1", 1), b = w("2", 1);
        return {
          text: `${a.text} + ${b.text}`, prec: 1,
          spans: [...col("1", a), sp(" + ", badge), ...col("2", b)]
        };
      }
      if (roles.output === "1") {
        const a = w("3", 1), b = w("2", 2);
        return {
          text: `${a.text} - ${b.text}`, prec: 1,
          spans: [...col("3", a), sp(" - ", badge), ...col("2", b)]
        };
      }
      if (roles.output === "2") {
        const a = w("3", 1), b = w("1", 2);
        return {
          text: `${a.text} - ${b.text}`, prec: 1,
          spans: [...col("3", a), sp(" - ", badge), ...col("1", b)]
        };
      }
    }

    /* ── mulDiv  (arm2 × arm4 = arm8) ─────────────────────── */
    if (cat === "mulDiv") {
      if (roles.output === "8") {
        const a = w("2", 2), b = w("4", 2);
        return {
          text: `${a.text}*${b.text}`, prec: 2,
          spans: [...col("2", a), sp("*", badge), ...col("4", b)]
        };
      }
      if (roles.output === "2") {
        const a = w("8", 2), b = w("4", 3);
        return {
          text: `${a.text}/${b.text}`, prec: 2,
          spans: [...col("8", a), sp("/", badge), ...col("4", b)]
        };
      }
      if (roles.output === "4") {
        const a = w("8", 2), b = w("2", 3);
        return {
          text: `${a.text}/${b.text}`, prec: 2,
          spans: [...col("8", a), sp("/", badge), ...col("2", b)]
        };
      }
    }

    /* ── exp  (base ^ exponent = power) ───────────────────── */
    if (cat === "exp") {
      const base = byRole.base;
      const exp = byRole.exponent;
      const pow = byRole.power;
      const baseT = base ? base.text : "?";
      const expT = exp ? exp.text : "?";
      const powT = pow ? pow.text : "?";

      if (roles.output === "power") {
        // base^exponent
        const baseNP = base && base.prec < 99;
        const expNP = /[+\-*/^()]/.test(expT);
        const bW = baseNP
          ? { text: `(${baseT})`, spans: [sp("(", "var(--muted)", 0.35), ...col("base", base), sp(")", "var(--muted)", 0.35)] }
          : { text: baseT, spans: col("base", base) };
        const eW = expNP
          ? { text: `(${expT})`, spans: [sp("(", "var(--muted)", 0.35), ...col("exponent", exp), sp(")", "var(--muted)", 0.35)] }
          : { text: expT, spans: col("exponent", exp) };
        return {
          text: `${bW.text}^${eW.text}`, prec: 3,
          spans: [...bW.spans, sp("^", badge), ...eW.spans]
        };
      }

      if (roles.output === "base") {
        // nthrt_index(radicand) when index is a simple token
        if (/^[a-zA-Z][a-zA-Z0-9]*$/.test(expT) || /^\d+(\.\d+)?$/.test(expT)) {
          const expC = expT === "x" ? OP_COLORS.x : armCol(cat, "exponent");
          return {
            text: `nthrt_${expT}(${powT})`, prec: 99,
            spans: [sp("nthrt_", badge), sp(expT, expC), sp("(", "var(--muted)", 0.35), ...col("power", pow), sp(")", "var(--muted)", 0.35)]
          };
        }
        return {
          text: `(${powT})^(1/(${expT}))`, prec: 3,
          spans: [
            sp("(", "var(--muted)", 0.35), ...col("power", pow), sp(")", "var(--muted)", 0.35),
            sp("^", badge), sp("(1/", badge),
            sp("(", "var(--muted)", 0.35), ...col("exponent", exp), sp(")", "var(--muted)", 0.35),
            sp(")", "var(--muted)", 0.35),
          ]
        };
      }

      if (roles.output === "exponent") {
        if (/^[a-zA-Z][a-zA-Z0-9]*$/.test(baseT) || /^\d+(\.\d+)?$/.test(baseT)) {
          const baseC = baseT === "x" ? OP_COLORS.x : armCol(cat, "base");
          return {
            text: `log_${baseT}(${powT})`, prec: 99,
            spans: [sp("log_", badge), sp(baseT, baseC), sp("(", "var(--muted)", 0.35), ...col("power", pow), sp(")", "var(--muted)", 0.35)]
          };
        }
        return {
          text: `ln(${powT})/ln(${baseT})`, prec: 2,
          spans: [
            sp("ln", badge), sp("(", "var(--muted)", 0.35), ...col("power", pow), sp(")", "var(--muted)", 0.35),
            sp("/", badge),
            sp("ln", badge), sp("(", "var(--muted)", 0.35), ...col("base", base), sp(")", "var(--muted)", 0.35),
          ]
        };
      }
    }

    return atom("?", "var(--muted)");
  }

  const result = nr(rootId);
  // Clean up: replace any remaining null colours with default text colour
  const spans = result.spans.map(s => s.color === null ? { ...s, color: "var(--text)" } : s);
  return { text: result.text, spans };
}

/**
 * Build a mathematical expression string from the pipe-layout tree.
 * Delegates to _walkPipeTree for precedence-aware generation.
 */
function exprFromPipeLayout(layout) {
  const r = _walkPipeTree(layout);
  return r ? r.text : null;
}

/**
 * Walk a subtree of the pipe layout starting from an arbitrary node.
 * Returns { text, spans } like _walkPipeTree, but rooted at nodeId.
 */
function _walkSubtree(layout, nodeId) {
  if (!layout || !layout.nodes || nodeId == null) return null;
  // Temporarily override mainPath to trick _walkPipeTree into starting at nodeId
  // Actually, we need to factor out the inner recursive walker. 
  // For now, re-use the same logic by traversing from nodeId.
  const nodes = layout.nodes;

  function catFor(opType) {
    if (opType === "add" || opType === "sub") return "addSub";
    if (opType === "mul" || opType === "div") return "mulDiv";
    if (opType === "power") return "exp";
    return null;
  }
  function armCol(cat, roleLabel) {
    const cc = ARM_COLORS[cat];
    return (cc && cc[roleLabel]) || OP_COLORS[cat] || OP_COLORS.misc;
  }
  function sp(text, color, opacity) {
    const s = { text, color };
    if (opacity !== undefined) s.opacity = opacity;
    return s;
  }
  function atom(text, color) {
    return { text, spans: [sp(text, color)], prec: 99 };
  }

  // Re-use the inner walker from _walkPipeTree
  // This is a simplified duplicate; ideally we'd refactor to share code
  function nr(id) {
    const nd = nodes[id];
    if (!nd) return atom("?", "var(--muted)");
    if (nd.type === "value") {
      const v = String(nd.value);
      if (nd.value === "x") return atom(v, OP_COLORS.x);
      if (nd.value === "pi" || nd.value === "e" || nd.value === "t") return atom(v, OP_COLORS.misc);
      if (nd.value === "tau" || nd.value === "TAU") return atom("τ", OP_COLORS.misc);
      return atom(v, null);
    }
    if (nd.type === "intermediate") {
      return nd.connectsToOpId != null ? nr(nd.connectsToOpId) : atom("?", "var(--muted)");
    }
    if (nd.type !== "op") return atom("?", "var(--muted)");

    const cat = nd.armCategory || catFor(nd.opType);
    const roles = nd.armAssignment;
    const Lo = nd.leftId != null ? nr(nd.leftId) : null;
    const Ro = (nd.rightId != null && nd.rightId !== nd.leftId) ? nr(nd.rightId) : null;
    const _ac = cat && ARM_COLORS[cat];
    const badge = (_ac && roles && _ac[roles.output]) ? _ac[roles.output] : (cat ? (OP_COLORS[cat] || OP_COLORS.misc) : OP_COLORS.misc);

    if (!roles || !cat) {
      return Lo || atom("?", "var(--muted)");
    }

    const byRole = {};
    byRole[roles.left] = Lo;
    byRole[roles.right] = Ro;

    function w(role, minPrec) {
      const o = byRole[role];
      if (!o) return atom("?", "var(--muted)");
      if (o.prec >= minPrec) return o;
      return { text: `(${o.text})`, spans: [sp("(", badge, 0.5), ...o.spans, sp(")", badge, 0.5)], prec: 99 };
    }
    function col(role, result) {
      const ac = armCol(cat, role);
      return result.spans.map(s => s.color === null ? { ...s, color: ac } : s);
    }

    if (cat === "addSub") {
      if (roles.output === "3") {
        const a = w("1", 1), b = w("2", 1);
        return { text: `${a.text} + ${b.text}`, prec: 1, spans: [...col("1", a), sp(" + ", badge), ...col("2", b)] };
      }
      if (roles.output === "1") {
        const a = w("3", 1), b = w("2", 2);
        return { text: `${a.text} - ${b.text}`, prec: 1, spans: [...col("3", a), sp(" - ", badge), ...col("2", b)] };
      }
      if (roles.output === "2") {
        const a = w("3", 1), b = w("1", 2);
        return { text: `${a.text} - ${b.text}`, prec: 1, spans: [...col("3", a), sp(" - ", badge), ...col("1", b)] };
      }
    }
    if (cat === "mulDiv") {
      if (roles.output === "8") {
        const a = w("2", 2), b = w("4", 2);
        return { text: `${a.text}*${b.text}`, prec: 2, spans: [...col("2", a), sp("*", badge), ...col("4", b)] };
      }
      if (roles.output === "2") {
        const a = w("8", 2), b = w("4", 3);
        return { text: `${a.text}/${b.text}`, prec: 2, spans: [...col("8", a), sp("/", badge), ...col("4", b)] };
      }
      if (roles.output === "4") {
        const a = w("8", 2), b = w("2", 3);
        return { text: `${a.text}/${b.text}`, prec: 2, spans: [...col("8", a), sp("/", badge), ...col("2", b)] };
      }
    }
    if (cat === "exp") {
      const base = byRole.base, exp = byRole.exponent, pow = byRole.power;
      if (roles.output === "power") {
        const bt = base || atom("?", "var(--muted)"), et = exp || atom("?", "var(--muted)");
        return { text: `${bt.text}^${et.text}`, prec: 3, spans: [...col("base", bt), sp("^", badge), ...col("exponent", et)] };
      }
      if (roles.output === "base") {
        const et = exp || atom("?", "var(--muted)"), pt = pow || atom("?", "var(--muted)");
        return { text: `nthrt_${et.text}(${pt.text})`, prec: 99, spans: [sp("nthrt_", badge), ...col("exponent", et), sp("(", "var(--muted)", 0.35), ...col("power", pt), sp(")", "var(--muted)", 0.35)] };
      }
      if (roles.output === "exponent") {
        const bt = base || atom("?", "var(--muted)"), pt = pow || atom("?", "var(--muted)");
        return { text: `log_${bt.text}(${pt.text})`, prec: 99, spans: [sp("log_", badge), ...col("base", bt), sp("(", "var(--muted)", 0.35), ...col("power", pt), sp(")", "var(--muted)", 0.35)] };
      }
    }
    return atom("?", "var(--muted)");
  }

  const result = nr(nodeId);
  const spans = result.spans.map(s => s.color === null ? { ...s, color: "var(--text)" } : s);
  return { text: result.text, spans };
}

/**
 * Walk the pipe-layout tree and produce **colored LaTeX** whose colors match
 * the pipe diagram exactly — operands in their arm-role color, operator
 * symbols in the badge (OP_COLORS[cat]) color, x in OP_COLORS.x.
 *
 * When xVal is finite, x is replaced by its numeric value.
 */
function pipeLayoutToColoredLatex(layout, xVal) {
  if (!layout || !layout.nodes || !layout.mainPath) return null;
  const nodes = layout.nodes;
  const rootId = layout.mainPath.opIds[0];
  const hasX = xVal !== undefined && xVal !== null && Number.isFinite(xVal);

  function catFor(opType) {
    if (opType === "add" || opType === "sub") return "addSub";
    if (opType === "mul" || opType === "div") return "mulDiv";
    if (opType === "power") return "exp";
    return null;
  }

  function col(text, hex) { return `\\textcolor{${hex}}{${text}}`; }

  /** Wrap text in a role-arm color */
  function armCol(text, cat, roleLabel) {
    const cc = ARM_COLORS[cat];
    const c = cc && cc[roleLabel] ? cc[roleLabel] : OP_COLORS[cat] || OP_COLORS.misc;
    return col(text, c);
  }

  /** Latex for a number value, optionally colored */
  function numLatex(v, hex) {
    let s;
    if (Number.isInteger(v) && Math.abs(v) < 1e15) s = String(v);
    else s = parseFloat(v.toPrecision(10)).toString();
    return hex ? col(s, hex) : s;
  }

  /** Classify a node for juxtaposition detection. */
  function nodeClassify(id) {
    const n = nodes[id];
    if (!n) return "unknown";
    if (n.type === "intermediate" && n.connectsToOpId != null) return nodeClassify(n.connectsToOpId);
    if (n.type === "value") {
      if (n.value === "x" || n.value === "t") return "var";
      if (n.value === "pi" || n.value === "e") return "const";
      return "num";
    }
    if (n.type === "op") return n.opType;
    return "unknown";
  }

  /** Check if the leftmost displayed leaf of a subtree is (or renders as) a number.
   *  Used for juxtaposition: 5·x² → 5x² (starts with var, no parens)
   *  vs 5·2^x → 5(2^x) (starts with digit, needs parens).
   *  When hasX=true, x/t are replaced by a number, so they also count as digits. */
  function nodeLeftmostIsNum(id) {
    const n = nodes[id];
    if (!n) return false;
    if (n.type === "intermediate" && n.connectsToOpId != null)
      return nodeLeftmostIsNum(n.connectsToOpId);
    if (n.type === "value") {
      if (n.value === "pi" || n.value === "e") return false;
      // When showing live values, x/t render as numbers → juxtaposition is ambiguous
      if (n.value === "x" || n.value === "t") return hasX;
      return true; // numeric literal
    }
    if (n.type === "op") {
      const roles = n.armAssignment;
      const cat = n.armCategory || catFor(n.opType);
      if (cat === "exp" && roles) {
        // base^exponent — base is leftmost
        const baseId = roles.left === "base" ? n.leftId : n.rightId;
        return nodeLeftmostIsNum(baseId);
      }
      // Other ops: left child is leftmost
      return n.leftId != null ? nodeLeftmostIsNum(n.leftId) : false;
    }
    return false;
  }

  /** Generate LaTeX for a node, returning { latex, role } where role is the arm-role label
   *  this sub-expression feeds into its parent (if any). */
  function nodeLatex(id) {
    const nd = nodes[id];
    if (!nd) return "?";
    if (nd.type === "value") {
      const v = nd.value;
      if (v === "x") {
        if (hasX) return col(formatLatexNumber(xVal), OP_COLORS.x);
        return col("x", OP_COLORS.x);
      }
      // Numeric or constant — will be colored by parent based on arm role
      if (v === "pi") return col("\\pi", OP_COLORS.misc);
      if (v === "e") return col("e", OP_COLORS.misc);
      if (v === "t") return col("t", OP_COLORS.misc);
      return String(v);
    }
    if (nd.type === "intermediate") {
      return nd.connectsToOpId != null ? nodeLatex(nd.connectsToOpId) : "?";
    }
    if (nd.type !== "op") return "?";

    const cat = nd.armCategory || catFor(nd.opType);
    const roles = nd.armAssignment;
    const L = nd.leftId != null ? nodeLatex(nd.leftId) : null;
    const R = (nd.rightId != null && nd.rightId !== nd.leftId) ? nodeLatex(nd.rightId) : null;
    const _armCC = cat && ARM_COLORS[cat];
    const badgeHex = (_armCC && roles && _armCC[roles.output]) ? _armCC[roles.output] : (cat ? (OP_COLORS[cat] || OP_COLORS.misc) : OP_COLORS.misc);

    // Single-arg call ops (trig, etc.) — no arm system
    if (nd.opType === "call" && !cat) {
      const fn = nd.fn || (nd.ast && nd.ast.fn) || "f";
      let fnColor = OP_COLORS.misc;
      if (TRIG_FNS.has(fn)) fnColor = OP_COLORS.trig;
      else if (EXP_FNS.has(fn) || fn === "sqrt") fnColor = OP_COLORS.exp;
      const inner = L || "?";
      const latexFnMap = {
        sin: "\\sin", cos: "\\cos", tan: "\\tan",
        asin: "\\arcsin", acos: "\\arccos", atan: "\\arctan",
        ln: "\\ln", log: "\\log", exp: "\\exp",
        sqrt: null, abs: null, floor: null, ceil: null, round: "\\text{round}",
      };
      if (fn === "sqrt") return col(`\\sqrt{${inner}}`, fnColor);
      if (fn === "abs") return `${col("\\lvert", fnColor)}${inner}${col("\\rvert", fnColor)}`;
      if (fn === "floor") return `${col("\\lfloor", fnColor)}${inner}${col("\\rfloor", fnColor)}`;
      if (fn === "ceil") return `${col("\\lceil", fnColor)}${inner}${col("\\rceil", fnColor)}`;
      const latexFn = latexFnMap[fn] || `\\text{${fn}}`;
      return `${col(latexFn, fnColor)}${col("(", fnColor)}${inner}${col(")", fnColor)}`;
    }

    if (!roles || !cat) {
      if (nd.ast && nd.ast.type === "binary" && L && R) {
        const p = nd.ast.op === "**" ? "^" : nd.ast.op;
        return `${L}${p}${R}`;
      }
      return L || "?";
    }

    // Color each child by its arm role
    const byRole = {};
    const lRole = roles.left, rRole = roles.right;
    byRole[lRole] = L != null ? armCol(L, cat, lRole) : "?";
    byRole[rRole] = R != null ? armCol(R, cat, rRole) : null;

    if (cat === "addSub") {
      if (roles.output === "3") {
        return `${byRole["1"]} ${col("+", badgeHex)} ${byRole["2"]}`;
      }
      if (roles.output === "1") {
        return `${byRole["3"]} ${col("-", badgeHex)} ${byRole["2"]}`;
      }
      if (roles.output === "2") {
        return `${byRole["3"]} ${col("-", badgeHex)} ${byRole["1"]}`;
      }
    }
    if (cat === "mulDiv") {
      if (roles.output === "8") {
        // Juxtaposition: coefficient × expression → implicit multiplication
        const role2Id = roles.left === "2" ? nd.leftId : nd.rightId;
        const role4Id = roles.left === "4" ? nd.leftId : nd.rightId;
        const t2 = nodeClassify(role2Id);
        const t4 = nodeClassify(role4Id);
        const s2 = (t2 === "num" || t2 === "const");
        const e4 = (t4 === "var" || t4 === "call");
        const s4 = (t4 === "num" || t4 === "const");
        const e2 = (t2 === "var" || t2 === "call");
        // Juxtaposition only for number·variable or number·function (e.g. 3x, 3sin(x))
        // When showing live values, x renders as a digit → need parens: 2(3) not 23
        if (s2 && e4) {
          if (hasX && t4 === "var") return `${byRole["2"]}${col("(", badgeHex)}${byRole["4"]}${col(")", badgeHex)}`;
          return `${byRole["2"]}${byRole["4"]}`;
        }
        if (s4 && e2) {
          if (hasX && t2 === "var") return `${byRole["4"]}${col("(", badgeHex)}${byRole["2"]}${col(")", badgeHex)}`;
          return `${byRole["4"]}${byRole["2"]}`;
        }
        // number·complex-expr: parens only when expr starts with a digit (e.g. 3(2^x))
        // but juxtaposition when expr starts with a variable (e.g. 5x²)
        const c4 = (t4 === "power" || t4 === "mul" || t4 === "div" || t4 === "add" || t4 === "sub");
        const c2 = (t2 === "power" || t2 === "mul" || t2 === "div" || t2 === "add" || t2 === "sub");
        if (s2 && c4) {
          if (nodeLeftmostIsNum(role4Id)) return `${byRole["2"]}${col("(", badgeHex)}${byRole["4"]}${col(")", badgeHex)}`;
          return `${byRole["2"]}${byRole["4"]}`;
        }
        if (s4 && c2) {
          if (nodeLeftmostIsNum(role2Id)) return `${byRole["4"]}${col("(", badgeHex)}${byRole["2"]}${col(")", badgeHex)}`;
          return `${byRole["4"]}${byRole["2"]}`;
        } return `${byRole["2"]} ${col(latexMulSym(), badgeHex)} ${byRole["4"]}`;
      }
      if (roles.output === "2") {
        return `${col(`\\frac{${byRole["8"]}}{${byRole["4"]}}`, badgeHex)}`;
      }
      if (roles.output === "4") {
        return `${col(`\\frac{${byRole["8"]}}{${byRole["2"]}}`, badgeHex)}`;
      }
    }
    if (cat === "exp") {
      const baseE = byRole.base || "?";
      const expE = byRole.exponent || "?";
      const powE = byRole.power || "?";
      if (roles.output === "power") {
        return `{${baseE}}^{${expE}}`;
      }
      if (roles.output === "base") {
        // Always use root notation
        const expNodeId = roles.right === "exponent" ? nd.rightId : nd.leftId;
        const rawExp = nodeRawValue(expNodeId);
        const expVal = rawExp != null ? parseFloat(rawExp) : NaN;
        // Simple √ for square root
        if (Number.isInteger(expVal) && expVal === 2) {
          return col(`\\sqrt{${powE}}`, badgeHex);
        }
        // nth root for everything else (integer n, variable x, expression…)
        return col(`\\sqrt[${expE}]{${powE}}`, badgeHex);
      }
      if (roles.output === "exponent") {
        // log_base notation
        const rawBase = nodeRawValue(roles.left === "base" ? nd.leftId : nd.rightId);
        if (rawBase && (/^[a-zA-Z]$/.test(rawBase) || /^\d+(\.\d+)?$/.test(rawBase))) {
          const baseLatex = rawBase === "x" ? col("x", OP_COLORS.x) : armCol(rawBase, cat, "base");
          return `{${col("\\log", badgeHex)}}_{${baseLatex}}${col("(", badgeHex)}${powE}${col(")", badgeHex)}`;
        }
        return `${col(`\\frac{\\ln(${powE})}{\\ln(${baseE})}`, badgeHex)}`;
      }
    }
    return "?";
  }

  /** Get the raw string value of a value node (for detecting integers/variables) */
  function nodeRawValue(id) {
    const nd = nodes[id];
    if (!nd) return null;
    if (nd.type === "value") return nd.value;
    if (nd.type === "intermediate" && nd.connectsToOpId != null) return nodeRawValue(nd.connectsToOpId);
    return null;
  }

  return nodeLatex(rootId);
}

/**
 * Build colored text spans for the input overlay from the pipe-layout tree.
 * Delegates to _walkPipeTree so text always matches exprFromPipeLayout.
 */
function pipeLayoutToColoredSpans(layout) {
  const r = _walkPipeTree(layout);
  return r ? r.spans : null;
}

/**
 * After an arm swap, rebuild the expression from the layout tree,
 * update state.fn and equation displays.
 *
 * IMPORTANT: We do NOT re-linearize (parseAndLinearize) or syncInputFromOps
 * here because the linearizer walks x→root and may reorder operands (e.g.
 * log(2)/log(x) becomes log(x)/log(2) — a different function!).  The pipe
 * layout keeps the canonical tree structure; we just compile the expression
 * string for state.fn and update the text/LaTeX displays.
 */
function applySwapToAstAndState() {
  _swapInProgress = true;
  try {
    const layout = state.pipeLayout;
    if (!layout) return;
    const treeResult = _walkPipeTree(layout);
    const newExpr = treeResult ? treeResult.text : null;
    if (!newExpr || newExpr === "?") return;

    // Update expression input and compile the JS function
    if (ui.exprEl) { ui.exprEl.value = newExpr; autoSizeInput(); }
    state.lastExpr = newExpr;
    state.fn = compileExpression(newExpr);

    // Store pipe-tree spans for the overlay (renderStepRepresentation will call updateInputOverlay)
    state.displaySpans = treeResult.spans;
  } catch (err) {
    console.error("[applySwapToAstAndState]", err);
  }
  // Clear flag after current microtask + next frame to cover any deferred
  // input events from programmatic .value assignment.
  requestAnimationFrame(() => { _swapInProgress = false; });
}

/**
 * Delete an operator node from the DAG and rebuild the expression + diagram.
 *
 * Rules:
 *  - If one input is a constant and the other is an intermediate (i.e. output of
 *    another operator), the intermediate's subtree replaces this operator.
 *  - If one input is a constant and the other is the variable x, the variable
 *    replaces this operator.
 *  - If both inputs are intermediate nodes (two sub-expressions), the entire
 *    operator and everything deeper is replaced with x (to keep x in the expr).
 *  - For single-arg call ops (sin, cos, etc.), the single input replaces the op
 *    (constant → x, intermediate/x → passes through).
 *  - In all cases, if removing the operator would cause x to vanish from the
 *    expression, we substitute x instead of a numeric constant.
 */
function deleteOperatorNode(opId, layout) {
  if (!layout || !layout.nodes) return;
  const nodes = layout.nodes;
  const opNode = nodes[opId];
  if (!opNode || opNode.type !== "op") return;

  /** Does the subtree rooted at nodeId contain the variable x? */
  function subtreeHasX(nodeId) {
    const n = nodes[nodeId];
    if (!n) return false;
    if (n.type === "value") return n.value === "x";
    if (n.type === "intermediate") return n.connectsToOpId != null && subtreeHasX(n.connectsToOpId);
    if (n.type === "op") {
      if (n.leftId != null && subtreeHasX(n.leftId)) return true;
      if (n.rightId != null && n.rightId !== n.leftId && subtreeHasX(n.rightId)) return true;
    }
    return false;
  }

  /** Check if x exists somewhere in the tree OUTSIDE the subtree rooted at opId. */
  function xExistsOutside(excludeOpId) {
    const rootId = layout.mainPath.opIds[0];
    function walk(nodeId) {
      if (nodeId === excludeOpId) return false; // skip excluded subtree
      const n = nodes[nodeId];
      if (!n) return false;
      if (n.type === "value") return n.value === "x";
      if (n.type === "intermediate") return n.connectsToOpId != null && walk(n.connectsToOpId);
      if (n.type === "op") {
        if (n.leftId != null && walk(n.leftId)) return true;
        if (n.rightId != null && n.rightId !== n.leftId && walk(n.rightId)) return true;
      }
      return false;
    }
    return walk(rootId);
  }

  /** Determine the fallback replacement: "x" if removing opId would lose x, else "1". */
  function fallbackVal() {
    return xExistsOutside(opId) ? "1" : "x";
  }

  // Classify children
  const leftChild = opNode.leftId != null ? nodes[opNode.leftId] : null;
  const rightChild = (opNode.rightId != null && opNode.rightId !== opNode.leftId)
    ? nodes[opNode.rightId] : null;

  function isIntermediate(n) { return n && n.type === "intermediate"; }
  function isVariable(n) { return n && n.type === "value" && n.value === "x"; }
  function isConstant(n) { return n && n.type === "value" && n.value !== "x"; }

  // For single-arg call ops (trig etc.) — just one child
  if (!rightChild) {
    if (isIntermediate(leftChild) || isVariable(leftChild)) {
      replaceOpInParent(opId, opNode.leftId, nodes, layout);
    } else {
      replaceOpWithConstant(opId, fallbackVal(), nodes, layout);
    }
    rebuildAfterDelete(layout);
    return;
  }

  // Two-input operators
  const leftIsIntermediate = isIntermediate(leftChild);
  const rightIsIntermediate = isIntermediate(rightChild);
  const leftIsVariable = isVariable(leftChild);
  const rightIsVariable = isVariable(rightChild);
  const leftIsConstant = isConstant(leftChild);
  const rightIsConstant = isConstant(rightChild);

  if (leftIsIntermediate && rightIsIntermediate) {
    // Both intermediate — replace with fallback (x if x would be lost, else 1)
    replaceOpWithConstant(opId, fallbackVal(), nodes, layout);
  } else if (leftIsConstant && rightIsIntermediate) {
    replaceOpInParent(opId, opNode.rightId, nodes, layout);
  } else if (rightIsConstant && leftIsIntermediate) {
    replaceOpInParent(opId, opNode.leftId, nodes, layout);
  } else if (leftIsConstant && rightIsVariable) {
    replaceOpInParent(opId, opNode.rightId, nodes, layout);
  } else if (rightIsConstant && leftIsVariable) {
    replaceOpInParent(opId, opNode.leftId, nodes, layout);
  } else if (leftIsVariable && rightIsIntermediate) {
    replaceOpInParent(opId, opNode.leftId, nodes, layout);
  } else if (rightIsVariable && leftIsIntermediate) {
    replaceOpInParent(opId, opNode.rightId, nodes, layout);
  } else if (leftIsVariable && rightIsVariable) {
    replaceOpInParent(opId, opNode.leftId, nodes, layout);
  } else {
    replaceOpWithConstant(opId, fallbackVal(), nodes, layout);
  }

  rebuildAfterDelete(layout);
}

/** Replace operator opId in its parent by pointing the parent to replacementId instead. */
function replaceOpInParent(opId, replacementId, nodes, layout) {
  // Find the parent that references this operator (or its intermediate)
  for (const n of nodes) {
    if (!n || n.type !== "op") continue;
    if (n.leftId != null) {
      const leftChild = nodes[n.leftId];
      // Direct reference to the op
      if (n.leftId === opId) { n.leftId = replacementId; return; }
      // Through an intermediate that connects to this op
      if (leftChild && leftChild.type === "intermediate" && leftChild.connectsToOpId === opId) {
        n.leftId = replacementId;
        return;
      }
    }
    if (n.rightId != null && n.rightId !== n.leftId) {
      const rightChild = nodes[n.rightId];
      if (n.rightId === opId) { n.rightId = replacementId; return; }
      if (rightChild && rightChild.type === "intermediate" && rightChild.connectsToOpId === opId) {
        n.rightId = replacementId;
        return;
      }
    }
  }
  // If no parent found, this was the root — replace root with the replacement node
  // We'll handle this in rebuildAfterDelete by detecting the new root.
}

/** Replace operator opId with a new constant value node. */
function replaceOpWithConstant(opId, val, nodes, layout) {
  const newId = nodes.length;
  nodes.push({ id: newId, type: "value", value: val });
  replaceOpInParent(opId, newId, nodes, layout);
}

/** After deleting an operator, rebuild the expression + layout + re-render. */
function rebuildAfterDelete(layout, preserveLayout) {
  try {
    // Rebuild expression from modified tree
    const treeResult = _walkPipeTree(layout);
    if (!treeResult) return;
    const newExpr = treeResult.text;

    // Update state
    if (ui.exprEl) { ui.exprEl.value = newExpr; autoSizeInput(); }
    state.lastExpr = newExpr;
    state.fn = compileExpression(newExpr);
    state.displaySpans = treeResult.spans;

    if (preserveLayout) {
      // Keep the existing layout nodes (with arm assignments, exp-family state, etc.)
      // but recompute mainPath since nodes may have been added/rewired.
      _refreshMainPath(layout);
      // state.pipeLayout is already layout — no reassignment needed
    } else {
      // Re-parse to get a clean layout
      const { steps, ops, pipeLayout } = parseAndLinearize(newExpr);
      state.steps = steps;
      state.ops = ops;
      if (pipeLayout) state.pipeLayout = pipeLayout;
    }

    // Clear equals edge if it's stale
    state.equalsEdge = null;
    state.equalsLhsSpans = null;
    state.equalsFullSpans = null;
    state.equalsRhsExpr = null;

    renderStepRepresentation();
    updateInputOverlay();
    updateLatexDisplay(newExpr);
  } catch (err) {
    console.error("[deleteOperatorNode]", err);
  }
}

/** Recompute mainPath on an existing layout after nodes are added/rewired. */
function _refreshMainPath(layout) {
  const nodes = layout.nodes;
  // Find root: the op node that is not a child of any other op
  const childIds = new Set();
  for (const n of nodes) {
    if (!n || n.type !== "op") continue;
    if (n.leftId != null) childIds.add(n.leftId);
    if (n.rightId != null && n.rightId !== n.leftId) childIds.add(n.rightId);
  }
  // Also consider intermediate -> connectsToOpId
  for (const n of nodes) {
    if (!n || n.type !== "intermediate") continue;
    if (n.connectsToOpId != null) childIds.add(n.connectsToOpId);
  }
  let rootOpId = null;
  for (const n of nodes) {
    if (!n || n.type !== "op") continue;
    if (!childIds.has(n.id)) { rootOpId = n.id; break; }
  }
  if (rootOpId == null) return;

  function pathFromRootToX(nodeId) {
    const node = nodes[nodeId];
    if (!node) return [];
    if (node.type === "value") return node.value === "x" ? [nodeId] : [];
    if (node.type === "intermediate") {
      return node.connectsToOpId != null ? pathFromRootToX(node.connectsToOpId) : [];
    }
    if (node.type === "op") {
      const leftPath = pathFromRootToX(node.leftId);
      if (leftPath.length) return [nodeId, ...leftPath];
      if (node.rightId != null) {
        const rightPath = pathFromRootToX(node.rightId);
        if (rightPath.length) return [nodeId, ...rightPath];
      }
    }
    return [];
  }

  const pathToX = pathFromRootToX(rootOpId);
  if (pathToX.length === 0) return;
  const mainOpIds = pathToX.filter(id => nodes[id].type === "op");
  const xId = pathToX[pathToX.length - 1];
  layout.mainPath = { valueIds: [xId, ...mainOpIds], opIds: mainOpIds };
}

/** Derive opType and symbol from an arm category + assignment (module-level) */
function _deriveOpInfo(cat, assignment) {
  if (cat === "addSub") {
    if (assignment.output === "3") return { opType: "add", symbol: "+" };
    return { opType: "sub", symbol: "\u2212" };
  }
  if (cat === "mulDiv") {
    if (assignment.output === "8") return { opType: "mul", symbol: "\u00d7" };
    return { opType: "div", symbol: "\u00f7" };
  }
  if (cat === "exp") {
    if (assignment.output === "power") return { opType: "power", symbol: "^" };
    if (assignment.output === "base") return { opType: "call", symbol: "\u207f\u221a" };
    return { opType: "call", symbol: "log" };
  }
  return null;
}

function _categoryForOpType(opType) {
  if (opType === "add" || opType === "sub") return "addSub";
  if (opType === "mul" || opType === "div") return "mulDiv";
  if (opType === "power") return "exp";
  return null;
}

/**
 * Render the pipe diagram from the DAG: straight pipes only, 120° separation at junctions.
 * Uses SVG layer groups for correct z-ordering: pipes → arrows → nodes → text → debug.
 */
function renderPipeDiagramDag(ops, layout, showIntermediates, horizontal, showDebug, showPipeDebug) {
  if (!layout || !layout.nodes || !layout.mainPath || !layout.mainPath.opIds.length) {
    const empty = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    empty.setAttribute("viewBox", "0 0 100 40");
    empty.setAttribute("width", "100");
    empty.setAttribute("height", "40");
    return empty;
  }
  const positions = computeDagPositions(layout);
  if (!positions) return document.createElementNS("http://www.w3.org/2000/svg", "svg");

  const NS = "http://www.w3.org/2000/svg";
  const svgEl = (tag) => document.createElementNS(NS, tag);
  const { nodes } = layout;
  const { rootOpId, yX: rawYX, yY: rawYY, PIPE } = positions;

  // Compute effective rotation: base treeRotationDeg + 90° if horizontal mode
  const _treeDeg = ((state.treeRotationDeg || 0) + (horizontal ? -90 : 0)) % 360;
  const _treeRad = _treeDeg * Math.PI / 180;
  const _cosR = Math.cos(_treeRad), _sinR = Math.sin(_treeRad);

  // Capture unrotated bounding box BEFORE rotation so the viewBox stays
  // the same size at every rotation angle (diagonal of this box).
  const _preAllX = [rawYX], _preAllY = [rawYY];
  for (const n of nodes) {
    if (n.x != null) _preAllX.push(n.x);
    if (n.y != null) _preAllY.push(n.y);
  }
  const _preW = Math.max(..._preAllX) - Math.min(..._preAllX);
  const _preH = Math.max(..._preAllY) - Math.min(..._preAllY);

  // Apply rotation to all node coordinates
  if (_treeDeg !== 0) {
    for (const n of nodes) {
      if (n.x != null) {
        const ox = n.x, oy = n.y;
        n.x = ox * _cosR - oy * _sinR;
        n.y = ox * _sinR + oy * _cosR;
      }
    }
  }
  const yX = _treeDeg !== 0
    ? (rawYX * _cosR - rawYY * _sinR)
    : rawYX;
  const yY = _treeDeg !== 0
    ? (rawYX * _sinR + rawYY * _cosR)
    : rawYY;

  // Store Y position on layout for external use (e.g. equals drag)
  layout._yX = yX;
  layout._yY = yY;

  const R = 22;
  const JR = 18;
  const PW = 15;       // pipe width
  const ARROW_W = 2;   // thin arrow line width
  const PAD = 18;      // reduced padding for compact tree view
  const CR = PIPE / 2; // ring circle radius — centerlines of neighbors just touch
  layout._CR = CR;      // expose for attachEqualsDrag
  const GREY = "#888";
  const MATH_FONT = "KaTeX_Main, 'Times New Roman', serif";

  // Counter-rotation is NOT needed at render time: coordinate pre-computation
  // keeps text upright.  But during the CSS-rotate animation step the whole SVG
  // spins, so we mark every text element with .pipe-upright so the animation
  // code can apply a matching CSS counter-rotation in real-time.
  const _counterDeg = 0;
  function uprightText(textEl, cx, cy) {
    textEl.classList.add('pipe-upright');
    if (_counterDeg !== 0) {
      textEl.setAttribute("transform", `rotate(${_counterDeg} ${cx} ${cy})`);
    }
    return textEl;
  }

  const isDarkMode = !document.body.classList.contains("light");
  const GLASS_FILL = "var(--bg)";

  function opColor(node) {
    // For call-type ops, resolve category from stored fn name
    if (node.opType === "call") {
      const fn = node.fn || (node.ast && node.ast.fn) || null;
      if (fn) {
        if (TRIG_FNS.has(fn)) return userColors.trig || OP_COLORS.trig;
        if (EXP_FNS.has(fn)) return userColors.exp || OP_COLORS.exp;
        return userColors.misc || OP_COLORS.misc;
      }
    }
    return userColors[getColorKeyForOp({ type: node.opType })] || OP_COLORS.misc;
  }

  // ARM_COLORS is now at module scope (near OP_COLORS)

  /** Map opType → default { left, right, output } role labels */
  function getArmRoles(opType) {
    switch (opType) {
      case "add": return { left: "1", right: "2", output: "3" };
      case "sub": return { left: "3", right: "2", output: "1" };
      case "mul": return { left: "2", right: "4", output: "8" };
      case "div": return { left: "8", right: "4", output: "2" };
      case "power": return { left: "base", right: "exponent", output: "power" };
      default: return null;
    }
  }

  /** Derive opType and symbol from an arm assignment */
  function deriveOpInfo(cat, assignment) {
    if (cat === "addSub") {
      if (assignment.output === "3") return { opType: "add", symbol: "+" };
      return { opType: "sub", symbol: "\u2212" };
    }
    if (cat === "mulDiv") {
      if (assignment.output === "8") return { opType: "mul", symbol: "\u00d7" };
      return { opType: "div", symbol: "\u00f7" };
    }
    if (cat === "exp") {
      if (assignment.output === "power") return { opType: "power", symbol: "^" };
      if (assignment.output === "base") return { opType: "call", symbol: "\u207f\u221a" };
      return { opType: "call", symbol: "log" };
    }
    return null;
  }

  function categoryForOpType(opType) {
    if (opType === "add" || opType === "sub") return "addSub";
    if (opType === "mul" || opType === "div") return "mulDiv";
    if (opType === "power") return "exp";
    return null;
  }

  /** Darken a hex color by mixing toward black */
  function darkenColor(hex, amount) {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    const t = 1 - amount; // amount=0.7 means 30% original, 70% black
    const cr = Math.round(r * t);
    const cg = Math.round(g * t);
    const cb = Math.round(b * t);
    return `#${cr.toString(16).padStart(2, '0')}${cg.toString(16).padStart(2, '0')}${cb.toString(16).padStart(2, '0')}`;
  }

  /**
   * Return a "result arm" variant for an operator's output pipe.
   * Lighter and slightly desaturated, with hue shift to make it clearly distinct.
   */
  function outputArmColor(baseHex) {
    let h = baseHex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    const lab = rgbToOklab(r, g, b);
    const lch = oklabToOklch(lab.L, lab.a, lab.b);
    // Significantly lighter, more desaturated, slight hue shift
    const newL = Math.min(1, lch.L + 0.18);
    const newC = lch.C * 0.5;
    const newH = (lch.h + 20) % 360;
    const adj = oklchToOklab(newL, newC, newH);
    const [nr, ng, nb] = oklabToRgb(adj.L, adj.a, adj.b);
    const cr = Math.round(Math.max(0, Math.min(255, nr)));
    const cg = Math.round(Math.max(0, Math.min(255, ng)));
    const cb = Math.round(Math.max(0, Math.min(255, nb)));
    return `#${cr.toString(16).padStart(2, '0')}${cg.toString(16).padStart(2, '0')}${cb.toString(16).padStart(2, '0')}`;
  }

  // Compute viewBox bounds — tight fit to content.
  // Uses actual bounding rect (not forced-square) so the tree fills the
  // available width.  A small minimum prevents degenerate zero-size.
  const allX = [yX], allY = [yY];
  for (const n of nodes) {
    if (n.x != null) allX.push(n.x);
    if (n.y != null) allY.push(n.y);
  }
  const bMinX = Math.min(...allX) - R - PAD;
  const bMaxX = Math.max(...allX) + R + PAD;
  const bMinY = Math.min(...allY) - R - PAD;
  const bMaxY = Math.max(...allY) + R + PAD;
  const vbW = Math.max(bMaxX - bMinX, 80);
  const vbH = Math.max(bMaxY - bMinY, 80);
  const cxMid = (bMinX + bMaxX) / 2;
  const cyMid = (bMinY + bMaxY) / 2;

  const svg = svgEl("svg");
  svg.setAttribute("viewBox", `${cxMid - vbW / 2} ${cyMid - vbH / 2} ${vbW} ${vbH}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.classList.add("pipe-diagram");

  // Same sizing for both horizontal and vertical modes
  svg.style.width = "100%";
  svg.style.maxWidth = "100%";
  svg.style.height = "100%";
  svg.style.display = "block";
  svg.style.margin = "0 auto";

  // Defs: arrow marker — dark, thin chevron
  const defs = svgEl("defs");
  const arrow = svgEl("marker");
  arrow.setAttribute("id", "pipe-arrow-root");
  arrow.setAttribute("viewBox", "0 0 10 6");
  arrow.setAttribute("markerUnits", "userSpaceOnUse");
  arrow.setAttribute("markerWidth", 14);
  arrow.setAttribute("markerHeight", 8);
  arrow.setAttribute("refX", 9);
  arrow.setAttribute("refY", 3);
  arrow.setAttribute("orient", "auto");
  arrow.setAttribute("overflow", "visible");
  // We'll create per-color markers dynamically
  const defaultArrowPath = svgEl("path");
  defaultArrowPath.setAttribute("d", "M0,0.5 L9,3 L0,5.5 Z");
  defaultArrowPath.setAttribute("fill", "#000");
  arrow.appendChild(defaultArrowPath);
  defs.appendChild(arrow);
  svg.appendChild(defs);

  // Create a marker per color for matching arrow+line coloring
  const markerCache = {};
  function getArrowMarkerId(pipeColor) {
    const key = pipeColor || '#000';
    if (markerCache[key]) return markerCache[key];
    const safeId = 'pipe-arrow-' + key.replace(/[^a-zA-Z0-9]/g, '_');
    const m = svgEl("marker");
    m.setAttribute("id", safeId);
    m.setAttribute("viewBox", "0 0 10 6");
    m.setAttribute("markerUnits", "userSpaceOnUse");
    m.setAttribute("markerWidth", 14);
    m.setAttribute("markerHeight", 8);
    m.setAttribute("refX", 9);
    m.setAttribute("refY", 3);
    m.setAttribute("orient", "auto");
    m.setAttribute("overflow", "visible");
    const p = svgEl("path");
    p.setAttribute("d", "M0,0.5 L9,3 L0,5.5 Z");
    // Arrow fill = very dark version of the pipe color
    p.setAttribute("fill", darkenColor(key, 0.7));
    m.appendChild(p);
    defs.appendChild(m);
    markerCache[key] = safeId;
    return safeId;
  }

  // ---------- Layer groups (back → front) ----------
  const gPipes = svgEl("g");  // thick connector pipes (lowest)
  const gRings = svgEl("g");  // decorative ring circles around nodes
  const gArrows = svgEl("g");  // thin arrow flow lines
  const gNodes = svgEl("g");  // circles / node fills
  const gText = svgEl("g");  // symbol text on nodes
  const gDebug = svgEl("g");  // debug labels (can be toggled)
  const gPipeDebug = svgEl("g");  // pipe arm role labels
  const gInteract = svgEl("g"); // interaction layer (swap buttons, hover zones) — topmost
  if (!showDebug) gDebug.setAttribute("display", "none");
  if (!showPipeDebug) gPipeDebug.setAttribute("display", "none");
  svg.appendChild(gPipes);
  svg.appendChild(gRings);
  svg.appendChild(gArrows);
  svg.appendChild(gNodes);
  svg.appendChild(gText);
  svg.appendChild(gDebug);
  svg.appendChild(gPipeDebug);
  svg.appendChild(gInteract);

  // ---- Radial menu layer — now rendered into HTML portal ----
  // Keep a dummy gRadialMenu in SVG for backwards compat (unused)
  const gRadialMenu = svgEl("g");
  gRadialMenu.setAttribute("display", "none");
  svg.appendChild(gRadialMenu);
  let _radialDismiss = null;

  /**
   * Convert SVG coordinate to screen coordinate using the SVG's CTM.
   */
  function svgToScreen(svgX, svgY) {
    const pt = svg.createSVGPoint();
    pt.x = svgX; pt.y = svgY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const sp = pt.matrixTransform(ctm);
    return { x: sp.x, y: sp.y };
  }

  /**
   * Show a radial operator menu centred at SVG coords (mx, my).
   * Renders into the HTML portal layer for z-priority.
   */
  function showRadialMenu(targetNodeId, mx, my, nodeType) {
    const backdrop = document.getElementById('radial-menu-backdrop');
    const portal = document.getElementById('radial-menu-portal');
    if (!portal || !backdrop) return;

    // Clear previous
    while (portal.firstChild) portal.removeChild(portal.firstChild);
    backdrop.style.display = '';
    portal.style.display = '';

    // Get screen position of the SVG coord
    const center = svgToScreen(mx, my);

    // Compute a scale factor from SVG units → screen px
    const origin = svgToScreen(0, 0);
    const oneUnit = svgToScreen(1, 0);
    const scale = Math.abs(oneUnit.x - origin.x) || 1;

    // Set portal position and size to cover the menu area
    portal.style.left = '0px';
    portal.style.top = '0px';
    portal.style.width = '100vw';
    portal.style.height = '100vh';
    portal.setAttribute('viewBox', `0 0 ${window.innerWidth} ${window.innerHeight}`);

    const isDark = isDarkMode;
    const BTN_R = R * scale; // full badge radius
    const gap = 4 * scale;
    const step = BTN_R * 2 + gap; // centre-to-centre distance

    function catColor(cat, item) {
      if (cat === "delete") return isDark ? "#ffffff" : "#222222";
      // Per-operator output color for binary ops (uses same ARM_COLORS as badges)
      if (item && item.op && item.op !== "call") {
        const roles = getArmRoles(item.op);
        if (roles) {
          const ac = ARM_COLORS[cat];
          if (ac && ac[roles.output]) return ac[roles.output];
        }
      }
      // Exp call-types: log and nthrt have specific output roles
      if (item && cat === "exp" && item.fn) {
        if (item.fn === "log") return ARM_COLORS.exp?.exponent || OP_COLORS.exp;
        if (item.fn === "nthrt") return ARM_COLORS.exp?.base || OP_COLORS.exp;
      }
      return OP_COLORS[cat] || OP_COLORS.misc;
    }

    // ---- Determine which menu item matches the target node's current op ----
    const targetNd = nodes[targetNodeId];
    function itemMatchesNode(item) {
      if (!targetNd || item.action === "delete") return false;
      if (targetNd.type !== "op") return false;
      // Exp family
      if (item.fn === "nthrt") return targetNd.armAssignment && targetNd.armAssignment.output === "base";
      if (item.fn === "log") return targetNd.armAssignment && targetNd.armAssignment.output === "exponent";
      if (item.op === "power") return targetNd.opType === "power" && targetNd.armAssignment && targetNd.armAssignment.output === "power";
      // Binary ops
      if (item.op && item.op !== "call") return targetNd.opType === item.op;
      // Single-arg calls
      if (item.fn) return targetNd.symbol === item.symbol;
      return false;
    }

    // ---- Styled symbol helper: renders n^m, log(m), ⁿ√ with tspans ----
    // (uses setStyledLabel defined at renderPipeDiagramDag scope)

    function makeBtn(item, bx, by, isCurrent) {
      const g = svgEl("g");
      g.style.cursor = "pointer";
      const col = catColor(item.cat, item);
      // When filled (hover or active), symbol colour becomes bg-contrast
      const filledTextCol = isDark ? "#000" : "#fff";

      // Button circle — glass fill matching pipe diagram badges
      const bg = svgEl("circle");
      bg.setAttribute("cx", bx); bg.setAttribute("cy", by);
      bg.setAttribute("r", BTN_R);
      bg.setAttribute("stroke", col);
      bg.setAttribute("stroke-width", 2.5 * scale);

      // If this is the currently-active operator, pre-fill the button
      if (isCurrent) {
        bg.setAttribute("fill", col);
      } else {
        bg.style.fill = GLASS_FILL;
      }
      g.appendChild(bg);

      // Highlight ring for currently-selected operator
      if (isCurrent) {
        const ring = svgEl("circle");
        ring.setAttribute("cx", bx); ring.setAttribute("cy", by);
        ring.setAttribute("r", BTN_R + 3 * scale);
        ring.setAttribute("fill", "none");
        ring.setAttribute("stroke", col);
        ring.setAttribute("stroke-width", 2 * scale);
        ring.setAttribute("opacity", "0.6");
        g.insertBefore(ring, bg);
      }

      // Track initial text color — filled buttons use contrast, normal use category color
      const initialTextCol = isCurrent ? filledTextCol : col;

      if (item.action === "delete") {
        // Draw trash can icon
        const s = BTN_R * 0.055;
        const icon = svgEl("g");
        // Body (tapered bin)
        const body = svgEl("path");
        body.setAttribute("d",
          `M${bx - 4 * s},${by - 1 * s} L${bx - 3 * s},${by + 6 * s} L${bx + 3 * s},${by + 6 * s} L${bx + 4 * s},${by - 1 * s} Z`);
        body.setAttribute("fill", "none");
        body.setAttribute("stroke", col);
        body.setAttribute("stroke-width", 1.8 * s);
        body.setAttribute("stroke-linejoin", "round");
        icon.appendChild(body);
        // Lid
        const lid = svgEl("line");
        lid.setAttribute("x1", bx - 5.5 * s); lid.setAttribute("y1", by - 2 * s);
        lid.setAttribute("x2", bx + 5.5 * s); lid.setAttribute("y2", by - 2 * s);
        lid.setAttribute("stroke", col);
        lid.setAttribute("stroke-width", 2 * s);
        lid.setAttribute("stroke-linecap", "round");
        icon.appendChild(lid);
        // Handle
        const handle = svgEl("path");
        handle.setAttribute("d",
          `M${bx - 1.8 * s},${by - 2 * s} L${bx - 1.8 * s},${by - 4.5 * s} L${bx + 1.8 * s},${by - 4.5 * s} L${bx + 1.8 * s},${by - 2 * s}`);
        handle.setAttribute("fill", "none");
        handle.setAttribute("stroke", col);
        handle.setAttribute("stroke-width", 1.5 * s);
        handle.setAttribute("stroke-linejoin", "round");
        icon.appendChild(handle);
        // Vertical lines inside
        for (const dx of [-1.5, 0, 1.5]) {
          const l = svgEl("line");
          l.setAttribute("x1", bx + dx * s); l.setAttribute("y1", by + 0.5 * s);
          l.setAttribute("x2", bx + dx * 0.85 * s); l.setAttribute("y2", by + 5 * s);
          l.setAttribute("stroke", col);
          l.setAttribute("stroke-width", 1 * s);
          l.setAttribute("stroke-linecap", "round");
          icon.appendChild(l);
        }
        g.appendChild(icon);
      } else {
        // Text label — styled to match badge rendering with same font & sizing
        const t = svgEl("text");
        t.setAttribute("x", bx); t.setAttribute("y", by);
        t.setAttribute("text-anchor", "middle");
        t.setAttribute("dominant-baseline", "central");
        t.setAttribute("font-family", MATH_FONT);
        t.setAttribute("font-style", "normal");
        t.setAttribute("fill", initialTextCol);
        // Consistent font-size scaling based on label length
        const len = item.label.length;
        const fontSize = len <= 1 ? BTN_R * 1.2
          : len <= 2 ? BTN_R * 0.82
            : len === 3 ? BTN_R * 0.7
              : len === 4 ? BTN_R * 0.58
                : BTN_R * 0.48;
        setStyledLabel(t, item.label, fontSize, initialTextCol);
        g.appendChild(t);
      }

      // ---- Hover: preview change on the actual diagram badge ----
      g.addEventListener("mouseenter", () => {
        // Button hover fill — fill circle, text becomes contrast color
        bg.style.fill = col;
        bg.setAttribute("fill", col);
        g.querySelectorAll("text").forEach(el => el.setAttribute("fill", filledTextCol));
        g.querySelectorAll("tspan").forEach(el => el.setAttribute("fill", filledTextCol));
        g.querySelectorAll("path, line").forEach(el => {
          if (el.getAttribute("stroke") && el.getAttribute("stroke") !== "none")
            el.setAttribute("stroke", filledTextCol);
        });
        // Preview on pipe diagram: update target node's badge
        if (targetNd && targetNd._junctionEl && targetNd._symbolTextEl) {
          const previewCol = catColor(item.cat, item);
          targetNd._junctionEl.setAttribute("stroke", previewCol);
          if (item.action === "delete") {
            targetNd._symbolTextEl.textContent = "\u2715"; // ✕ cross
            targetNd._symbolTextEl.setAttribute("fill", previewCol);
            targetNd._junctionEl.setAttribute("stroke-dasharray", "3 2");
          } else {
            const previewFontSize = badgeFontSizeForLabel(item.label, JR);
            setStyledLabel(targetNd._symbolTextEl, item.label, previewFontSize, previewCol);
            targetNd._symbolTextEl.setAttribute("fill", previewCol);
          }
        }
      });
      g.addEventListener("mouseleave", () => {
        // Button hover restore — isCurrent keeps filled, others revert to glass
        if (isCurrent) {
          bg.style.fill = col;
          bg.setAttribute("fill", col);
        } else {
          bg.style.fill = GLASS_FILL;
          bg.removeAttribute("fill");
        }
        g.querySelectorAll("text").forEach(el => el.setAttribute("fill", initialTextCol));
        g.querySelectorAll("tspan").forEach(el => el.setAttribute("fill", initialTextCol));
        g.querySelectorAll("path, line").forEach(el => {
          if (el.getAttribute("stroke") && el.getAttribute("stroke") !== "none")
            el.setAttribute("stroke", initialTextCol);
        });
        // Restore pipe diagram badge
        if (targetNd && targetNd._junctionEl && targetNd._symbolTextEl) {
          const origCol = targetNd._origBadgeCol || "#888";
          targetNd._junctionEl.setAttribute("stroke", origCol);
          targetNd._junctionEl.removeAttribute("stroke-dasharray");
          const origFontSize = badgeFontSizeForLabel(targetNd._origDisplaySymbol || "", JR);
          setStyledLabel(targetNd._symbolTextEl, targetNd._origDisplaySymbol || "", origFontSize, origCol);
          targetNd._symbolTextEl.setAttribute("fill", origCol);
        }
      });
      g.addEventListener("click", (e) => {
        e.stopPropagation();
        dismissRadialMenu();
        if (item.action === "delete") {
          if (nodeType === "op") deleteOperatorNode(targetNodeId, layout);
        } else {
          applyRadialMenuChoice(targetNodeId, nodeType, item, layout);
        }
      });
      return g;
    }

    // Hex-grid layout — positions in step units from centre
    //
    //  Hex neighbours use offsets: N(0,-1) NE(0.866,-0.5) SE(0.866,0.5)
    //                               S(0,1)  SW(-0.866,0.5) NW(-0.866,-0.5)
    //
    //                abs
    //     floor  tan      +         −
    //       round    🗑      ×    ÷
    //     atan  ceil   cos   ^    mod
    //             sin        ⁿ√  log
    //                asin
    //                 acos

    const items = [
      // trash — centre
      { x: 0, y: 0, cat: "delete", action: "delete" },
      // addSub
      { x: 0, y: -1, label: "+", op: "add", symbol: "+", cat: "addSub" },
      { x: 0.866, y: -1.5, label: "\u2212", op: "sub", symbol: "\u2212", cat: "addSub" },
      // mulDiv
      { x: 0.866, y: -0.5, label: "\u00d7", op: "mul", symbol: "\u00d7", cat: "mulDiv" },
      { x: 1.732, y: -1, label: "\u00f7", op: "div", symbol: "\u00f7", cat: "mulDiv" },
      { x: 1.732, y: 0, label: "mod", op: "mod", symbol: "%", cat: "mulDiv" },
      // exp
      { x: 0.866, y: 0.5, label: "^", op: "power", symbol: "^", cat: "exp" },
      { x: 0.866, y: 1.5, label: "log", op: "call", symbol: "log", fn: "log", cat: "exp" },
      { x: 1.732, y: 1, label: "\u207f\u221a", op: "call", symbol: "\u207f\u221a", fn: "nthrt", cat: "exp" },
      // trig
      { x: -0.866, y: 0.5, label: "sin", op: "call", symbol: "sin", fn: "sin", cat: "trig" },
      { x: 0, y: 1, label: "cos", op: "call", symbol: "cos", fn: "cos", cat: "trig" },
      { x: -0.866, y: 1.5, label: "asin", op: "call", symbol: "asin", fn: "asin", cat: "trig" },
      { x: 0, y: 2, label: "acos", op: "call", symbol: "acos", fn: "acos", cat: "trig" },
      { x: -1.732, y: 0, label: "tan", op: "call", symbol: "tan", fn: "tan", cat: "trig" },
      { x: -1.732, y: 1, label: "atan", op: "call", symbol: "atan", fn: "atan", cat: "trig" },

      // x: -0.866, y: -0.5
      //
      // misc
      { x: 0, y: -2, label: "|·|", op: "call", symbol: "|·|", fn: "abs", cat: "misc" },
      { x: -0.866, y: -1.5, label: "⌈⌉", op: "call", symbol: "⌈⌉", fn: "ceil", cat: "misc" },
      { x: -1.732, y: -1, label: "round", op: "call", symbol: "round", fn: "round", cat: "misc" },
      { x: -0.866, y: -0.5, label: "⌊⌋", op: "call", symbol: "⌊⌋", fn: "floor", cat: "misc" },
    ];

    const cx = center.x, cy = center.y;

    // Save original badge appearance for preview restore
    if (targetNd && targetNd._junctionEl) {
      targetNd._origBadgeCol = targetNd._junctionEl.getAttribute("stroke") || "#888";
    }
    if (targetNd && targetNd._symbolTextEl) {
      // Determine current display symbol from the element
      const symEl = targetNd._symbolTextEl;
      // Check for styled tspan content
      const tspans = symEl.querySelectorAll("tspan");
      if (tspans.length > 0) {
        // Reconstruct symbol from tspan pattern
        const firstText = tspans[0].textContent || "";
        if (firstText === "n" && tspans.length >= 2 && tspans[1].textContent === "m") {
          targetNd._origDisplaySymbol = "^";
        } else if (firstText.startsWith("log")) {
          targetNd._origDisplaySymbol = "log";
        } else {
          targetNd._origDisplaySymbol = symEl.textContent;
        }
      } else {
        targetNd._origDisplaySymbol = symEl.textContent;
      }
    }

    for (const item of items) {
      const isCurrent = nodeType === "op" && itemMatchesNode(item);
      portal.appendChild(makeBtn(item, cx + item.x * step, cy + item.y * step, isCurrent));
    }

    setTimeout(() => {
      _radialDismiss = (e) => {
        if (portal.contains(e.target)) return;
        dismissRadialMenu();
      };
      backdrop.addEventListener("click", _radialDismiss);
      document.addEventListener("click", _radialDismiss, true);
    }, 10);
  }

  function dismissRadialMenu() {
    const backdrop = document.getElementById('radial-menu-backdrop');
    const portal = document.getElementById('radial-menu-portal');
    if (backdrop) backdrop.style.display = 'none';
    if (portal) {
      portal.style.display = 'none';
      while (portal.firstChild) portal.removeChild(portal.firstChild);
    }
    // Also clear the old SVG layer in case
    gRadialMenu.setAttribute("display", "none");
    while (gRadialMenu.firstChild) gRadialMenu.removeChild(gRadialMenu.firstChild);
    if (_radialDismiss) {
      if (backdrop) backdrop.removeEventListener("click", _radialDismiss);
      document.removeEventListener("click", _radialDismiss, true);
      _radialDismiss = null;
    }
  }

  function applyRadialMenuChoice(targetNodeId, nodeType, item, layout) {
    const nodes = layout.nodes;
    const nd = nodes[targetNodeId];
    if (!nd) return;

    // Helper: badge symbol for a call-type fn (matches symbolFromOp output)
    function callSymbolForFn(fn) {
      if (fn === "ceil") return "\u2308\u2309";
      if (fn === "floor") return "\u230a\u230b";
      if (fn === "abs") return "|\u00b7|";
      return fn;
    }

    const SINGLE_ARG_FNS = ["sin", "cos", "tan", "asin", "acos", "atan", "abs", "round", "ceil", "floor"];
    const isSingleArg = SINGLE_ARG_FNS.includes(item.fn || "");
    const isExpFamily = (item.fn === "nthrt" || item.fn === "log");

    if (nodeType === "op") {
      const wasSingleArg = nd.rightId == null || nd.rightId === nd.leftId;
      if (isExpFamily) {
        if (wasSingleArg) {
          const newValId = nodes.length;
          nodes.push({ id: newValId, type: "value", value: item.fn === "nthrt" ? "2" : "e" });
          nd.rightId = newValId;
        }
        nd.opType = "power";
        nd.symbol = item.symbol;
        nd.armCategory = "exp";
        nd.armAssignment = item.fn === "nthrt"
          ? { left: "power", right: "exponent", output: "base" }
          : { left: "power", right: "base", output: "exponent" };
      } else if (isSingleArg && !wasSingleArg) {
        nd.rightId = null;
        nd.opType = "call";
        nd.symbol = callSymbolForFn(item.fn);
        nd.fn = item.fn;
      } else if (!isSingleArg && wasSingleArg) {
        const newValId = nodes.length;
        nodes.push({ id: newValId, type: "value", value: "1" });
        nd.rightId = newValId;
        nd.opType = item.op;
        nd.symbol = item.symbol;
      } else {
        nd.opType = item.op || "call";
        nd.symbol = item.symbol || callSymbolForFn(item.fn);
        if (item.fn) nd.fn = item.fn;
      }
      if (!isExpFamily) {
        nd.armAssignment = null;
        nd.armCategory = null;
        const defRoles = getArmRoles(nd.opType);
        if (defRoles) {
          nd.armAssignment = { ...defRoles };
          nd.armCategory = _categoryForOpType(nd.opType);
        }
      }
    } else if (nodeType === "value") {
      const newValId = nodes.length;
      nodes.push({ id: newValId, type: "value", value: isExpFamily ? (item.fn === "nthrt" ? "2" : "e") : "1" });
      const newOpId = nodes.length;
      if (isExpFamily) {
        nodes.push({
          id: newOpId, type: "op", opType: "power",
          leftId: targetNodeId, rightId: newValId,
          symbol: item.symbol, ast: null,
          armCategory: "exp",
          armAssignment: item.fn === "nthrt"
            ? { left: "power", right: "exponent", output: "base" }
            : { left: "power", right: "base", output: "exponent" },
        });
      } else if (isSingleArg) {
        nodes.push({
          id: newOpId, type: "op", opType: "call",
          leftId: targetNodeId, rightId: null,
          symbol: callSymbolForFn(item.fn), fn: item.fn, ast: null,
        });
      } else {
        nodes.push({
          id: newOpId, type: "op", opType: item.op,
          leftId: targetNodeId, rightId: newValId,
          symbol: item.symbol, ast: null,
        });
      }
      if (!isExpFamily) {
        const defRoles = getArmRoles(nodes[newOpId].opType);
        if (defRoles) {
          nodes[newOpId].armAssignment = { ...defRoles };
          nodes[newOpId].armCategory = _categoryForOpType(nodes[newOpId].opType);
        }
      }
      // Create intermediate node so the parent op connects through it (not directly to the new op)
      const newIntId = nodes.length;
      nodes.push({
        id: newIntId, type: "intermediate",
        sourceOpId: newOpId, connectsToOpId: newOpId, value: null,
      });
      if (layout.opToIntermediateId) {
        layout.opToIntermediateId.set(newOpId, newIntId);
      }
      // Redirect parent to the intermediate
      for (const n of nodes) {
        if (!n || n.type !== "op" || n.id === newOpId) continue;
        if (n.leftId === targetNodeId) { n.leftId = newIntId; break; }
        if (n.rightId === targetNodeId) { n.rightId = newIntId; break; }
      }
    } else if (nodeType === "intermediate") {
      const intNode = nd;
      const newValId = nodes.length;
      nodes.push({ id: newValId, type: "value", value: isExpFamily ? (item.fn === "nthrt" ? "2" : "e") : "1" });
      const newOpId = nodes.length;
      if (isExpFamily) {
        nodes.push({
          id: newOpId, type: "op", opType: "power",
          leftId: targetNodeId, rightId: newValId,
          symbol: item.symbol, ast: null,
          armCategory: "exp",
          armAssignment: item.fn === "nthrt"
            ? { left: "power", right: "exponent", output: "base" }
            : { left: "power", right: "base", output: "exponent" },
        });
      } else if (isSingleArg) {
        nodes.push({
          id: newOpId, type: "op", opType: "call",
          leftId: targetNodeId, rightId: null,
          symbol: callSymbolForFn(item.fn), fn: item.fn, ast: null,
        });
      } else {
        nodes.push({
          id: newOpId, type: "op", opType: item.op,
          leftId: targetNodeId, rightId: newValId,
          symbol: item.symbol, ast: null,
        });
      }
      if (!isExpFamily) {
        const defRoles = getArmRoles(nodes[newOpId].opType);
        if (defRoles) {
          nodes[newOpId].armAssignment = { ...defRoles };
          nodes[newOpId].armCategory = _categoryForOpType(nodes[newOpId].opType);
        }
      }
      const newIntId = nodes.length;
      nodes.push({
        id: newIntId, type: "intermediate",
        sourceOpId: newOpId, connectsToOpId: newOpId, value: null,
      });
      for (const n of nodes) {
        if (!n || n.type !== "op" || n.id === newOpId) continue;
        if (n.leftId === targetNodeId) { n.leftId = newIntId; break; }
        if (n.rightId === targetNodeId) { n.rightId = newIntId; break; }
      }
    }

    rebuildAfterDelete(layout, true);
  }

  // ---- Shared tooltip element ----
  let _tooltipEl = document.querySelector('.node-tooltip');
  if (!_tooltipEl) {
    _tooltipEl = document.createElement('div');
    _tooltipEl.className = 'node-tooltip';
    document.body.appendChild(_tooltipEl);
  }

  function showNodeTooltip(svgCx, svgCy, text) {
    // Position above the outer ring edge (R + RING_THICK + margin)
    const sp = svgToScreen(svgCx, svgCy);
    // Compute SVG-to-screen scale to translate the badge radius correctly
    const origin = svgToScreen(0, 0);
    const unit = svgToScreen(0, -1);
    const svgScale = Math.abs(unit.y - origin.y) || 1;
    const offset = (22 + 11 + 6) * svgScale; // R + RING_THICK + gap, in screen px
    _tooltipEl.textContent = text;
    _tooltipEl.style.left = sp.x + 'px';
    _tooltipEl.style.top = (sp.y - offset) + 'px';
    _tooltipEl.classList.add('visible');
  }
  function hideNodeTooltip() {
    _tooltipEl.classList.remove('visible');
  }

  function attachRadialClick(nodeId, cx, cy, nodeType, radius) {
    const hitCircle = svgEl("circle");
    hitCircle.setAttribute("cx", cx);
    hitCircle.setAttribute("cy", cy);
    hitCircle.setAttribute("r", radius);
    hitCircle.setAttribute("fill", "transparent");
    hitCircle.setAttribute("stroke", "none");
    hitCircle.dataset.badgeHit = "1";
    hitCircle.style.cursor = "pointer";
    hitCircle.setAttribute("pointer-events", "all");
    hitCircle.addEventListener("click", (e) => {
      e.stopPropagation();
      hideNodeTooltip();
      showRadialMenu(nodeId, cx, cy, nodeType);
    });

    // Tooltip on hover
    const tipText = nodeType === "op" ? "Click to change operator"
      : nodeType === "value" ? "Click to wrap in operator"
        : "Click to insert operator";
    hitCircle.addEventListener("mouseenter", () => showNodeTooltip(cx, cy, tipText));
    hitCircle.addEventListener("mouseleave", () => hideNodeTooltip());

    gInteract.appendChild(hitCircle);
  }

  // ---- Drawing helpers ----

  // Gradient cache for pipe gradients
  let gradId = 0;

  /** Draw a thick pipe segment with two-color gradient.
   *  Gradient runs colorStart at (x1,y1) → colorEnd at (x2,y2).
   *  Arrows point in the (x1,y1)→(x2,y2) direction.
   *  Non-stretched pipes get one arrowhead at the midpoint.
   *  Stretched pipes get two arrowheads, one entering each node's ring circle. */
  function drawPipe(x1, y1, x2, y2, colorStart, colorEnd) {
    const cS = colorStart || GREY;
    const cE = colorEnd || cS;

    // Create a linearGradient along the pipe
    const gid = 'pipe-grad-' + (gradId++);
    const grad = svgEl("linearGradient");
    grad.setAttribute("id", gid);
    grad.setAttribute("gradientUnits", "userSpaceOnUse");
    grad.setAttribute("x1", x1);
    grad.setAttribute("y1", y1);
    grad.setAttribute("x2", x2);
    grad.setAttribute("y2", y2);
    const stop1 = svgEl("stop");
    stop1.setAttribute("offset", "0%");
    stop1.setAttribute("stop-color", cS);
    const stop2 = svgEl("stop");
    stop2.setAttribute("offset", "100%");
    stop2.setAttribute("stop-color", cE);
    grad.appendChild(stop1);
    grad.appendChild(stop2);
    defs.appendChild(grad);

    // Thick pipe body — drawn center-to-center (behind badges)
    const pipe = svgEl("line");
    pipe.setAttribute("x1", x1);
    pipe.setAttribute("y1", y1);
    pipe.setAttribute("x2", x2);
    pipe.setAttribute("y2", y2);
    pipe.setAttribute("stroke", `url(#${gid})`);
    pipe.setAttribute("stroke-width", PW);
    pipe.setAttribute("stroke-linecap", "round");
    gPipes.appendChild(pipe);

    // ---- Arrow line (full length) + arrowhead triangle(s) ----
    const dx = x2 - x1, dy = y2 - y1;
    const dist = Math.hypot(dx, dy) || 1;
    if (dist <= 1) return;
    const ux = dx / dist, uy = dy / dist;



    // Arrowhead triangles — white in dark mode, black in light mode
    const ALEN = 12;  // triangle length
    const AHW = 4;   // triangle half-width at base
    const nx = -uy, ny = ux; // perpendicular unit vector
    const arrowFill = isDarkMode ? "white" : "black";

    function arrowTriangle(tipX, tipY) {
      const bx = tipX - ALEN * ux, by = tipY - ALEN * uy;
      const pts = [
        `${tipX},${tipY}`,
        `${bx + AHW * nx},${by + AHW * ny}`,
        `${bx - AHW * nx},${by - AHW * ny}`
      ].join(" ");
      const tri = svgEl("polygon");
      tri.setAttribute("points", pts);
      tri.setAttribute("fill", arrowFill);
      gArrows.appendChild(tri);
    }

    if (dist <= 2 * CR + 1) {
      // Non-stretched: single arrowhead centred in the overlap region
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      arrowTriangle(mx + (ALEN / 2) * ux, my + (ALEN / 2) * uy);
    } else {
      // Stretched: two arrowheads, one centred inside each ring's stroke band
      arrowTriangle(x1 + (CR + ALEN / 2) * ux, y1 + (CR + ALEN / 2) * uy);
      arrowTriangle(x2 - (CR - ALEN / 2) * ux, y2 - (CR - ALEN / 2) * uy);
    }
  }

  /** Draw a small role label at the midpoint of a pipe, into the gPipeDebug layer */
  function drawPipeLabel(x, y, label, color) {
    const tw = Math.max(18, label.length * 7.5);
    const th = 15;
    const bgRect = svgEl("rect");
    bgRect.setAttribute("x", x - tw / 2);
    bgRect.setAttribute("y", y - th / 2);
    bgRect.setAttribute("width", tw);
    bgRect.setAttribute("height", th);
    bgRect.setAttribute("fill", "#1a1a1a");
    bgRect.setAttribute("stroke", color || "#fff");
    bgRect.setAttribute("stroke-width", 0.7);
    bgRect.setAttribute("rx", 3);
    bgRect.setAttribute("opacity", 0.92);
    gPipeDebug.appendChild(bgRect);
    const t = svgEl("text");
    t.setAttribute("x", x);
    t.setAttribute("y", y);
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("dominant-baseline", "central");
    t.setAttribute("fill", color || "#fff");
    t.setAttribute("font-size", 9);
    t.setAttribute("font-family", MATH_FONT);
    t.textContent = label;
    uprightText(t, x, y);
    gPipeDebug.appendChild(t);
  }

  /** Draw pipe between two nodes. Arrow always points TOWARD ROOT (y).
   *  Pipe body drawn center-to-center (behind badges). Arrow line clipped to edges.
   *  colorStart/colorEnd: gradient colors from origin(start) → child(end).
   *  armLabel: optional role label at midpoint. */
  function pipeToChild(ox, oy, childX, childY, colorStart, colorEnd, childRadius, startRadius, arrowToward, armLabel) {
    const dx = childX - ox, dy = childY - oy;
    const len = Math.hypot(dx, dy) || 1;
    if (len <= 1) return;
    if (arrowToward === 'child') {
      // Arrows point origin→child; gradient colorStart at origin → colorEnd at child
      drawPipe(ox, oy, childX, childY, colorStart, colorEnd);
    } else {
      // Arrows point child→origin; gradient colorEnd at child → colorStart at origin
      drawPipe(childX, childY, ox, oy, colorEnd, colorStart);
    }
    if (armLabel) {
      drawPipeLabel((ox + childX) / 2, (oy + childY) / 2, armLabel, colorStart);
    }
  }

  function drawDebugLabel(x, y, label) {
    const w = Math.max(20, label.length * 6.5);
    const h = 14;
    const bgRect = svgEl("rect");
    bgRect.setAttribute("x", x - w / 2);
    bgRect.setAttribute("y", y - h / 2);
    bgRect.setAttribute("width", w);
    bgRect.setAttribute("height", h);
    bgRect.setAttribute("fill", "#1a1a1a");
    bgRect.setAttribute("stroke", "#f90");
    bgRect.setAttribute("stroke-width", 0.5);
    bgRect.setAttribute("rx", 2);
    gDebug.appendChild(bgRect);
    const t = svgEl("text");
    t.setAttribute("x", x);
    t.setAttribute("y", y);
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("dominant-baseline", "middle");
    t.setAttribute("fill", "#f90");
    t.setAttribute("font-size", 10);
    t.setAttribute("font-family", "monospace");
    t.textContent = label;
    uprightText(t, x, y);
    gDebug.appendChild(t);
  }

  // Only show ring circles for nodes adjacent to the equals marker
  const _eqActiveRingIds = new Set();
  {
    const eq = state.equalsEdge;
    if (eq) {
      if (typeof eq.fromId === 'number') _eqActiveRingIds.add(eq.fromId);
      if (typeof eq.toId === 'number') _eqActiveRingIds.add(eq.toId);
    } else {
      _eqActiveRingIds.add(rootOpId);
    }
  }

  /** Draw a low-opacity ring circle — DISABLED (rings removed) */
  function drawRing(cx, cy, color, nodeId) {
    return; // rings removed; grab handle is separate
  }

  /** Draw a circle onto the gNodes layer */
  function drawCircle(cx, cy, r, fill, stroke, strokeWidth) {
    const circle = svgEl("circle");
    circle.setAttribute("cx", cx);
    circle.setAttribute("cy", cy);
    circle.setAttribute("r", r);
    if (fill && fill.startsWith('var(')) {
      circle.style.fill = fill;
    } else {
      circle.setAttribute("fill", fill);
    }
    if (stroke) circle.setAttribute("stroke", stroke);
    if (strokeWidth) circle.setAttribute("stroke-width", strokeWidth);
    gNodes.appendChild(circle);
    return circle;
  }

  /** Draw text onto the gText layer with KaTeX font */
  function drawText(x, y, text, fontSize, fill, isItalic) {
    const t = svgEl("text");
    t.setAttribute("x", x);
    t.setAttribute("y", y);
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("dominant-baseline", "central");
    t.setAttribute("font-size", fontSize || 14);
    t.setAttribute("font-family", MATH_FONT);
    if (isItalic !== false) t.setAttribute("font-style", "italic");
    t.setAttribute("fill", fill || "#fff");
    t.textContent = text;
    uprightText(t, x, y);
    gText.appendChild(t);
    return t;
  }

  /**
   * Compute font size for a badge label that fits within a junction circle.
   * Single symbols get size 15; longer labels shrink progressively.
   */
  function badgeFontSizeForLabel(label, radius) {
    const len = label.length;
    if (len <= 1) return radius * 0.83;       // ~15 for JR=18
    if (len <= 2) return radius * 0.72;
    if (len === 3) return radius * 0.61;
    if (len === 4) return radius * 0.5;
    return radius * 0.42;
  }

  /**
   * Set styled symbol content on an SVG text element.
   * Renders n^m with superscript, log(m) with italic m, etc.
   * Used by both pipe-diagram badges and radial-menu buttons.
   */
  function setStyledLabel(textEl, label, fontSize, fillCol) {
    textEl.textContent = "";
    if (label === "^") {
      // m^n — base (m) with superscript exponent (n) using dy offsets
      const base = svgEl("tspan");
      base.textContent = "m";
      base.setAttribute("font-style", "italic");
      if (fillCol) base.setAttribute("fill", fillCol);
      textEl.appendChild(base);
      const exp = svgEl("tspan");
      exp.textContent = "n";
      exp.setAttribute("font-style", "italic");
      exp.setAttribute("dy", `-${fontSize * 0.35}px`);
      exp.setAttribute("font-size", `${fontSize * 0.6}px`);
      if (fillCol) exp.setAttribute("fill", fillCol);
      textEl.appendChild(exp);
      // Invisible reset tspan to restore baseline for subsequent content
      const reset = svgEl("tspan");
      reset.textContent = "\u200B";
      reset.setAttribute("dy", `${fontSize * 0.35}px`);
      reset.setAttribute("font-size", "0");
      textEl.appendChild(reset);
      textEl.setAttribute("font-size", fontSize);
      return;
    }
    if (label === "log") {
      // log with subscript base (m) using dy offsets
      const lbl = svgEl("tspan");
      lbl.textContent = "log";
      lbl.setAttribute("font-style", "normal");
      if (fillCol) lbl.setAttribute("fill", fillCol);
      textEl.appendChild(lbl);
      const sub = svgEl("tspan");
      sub.textContent = "m";
      sub.setAttribute("font-style", "italic");
      sub.setAttribute("dy", `${fontSize * 0.25}px`);
      sub.setAttribute("font-size", `${fontSize * 0.55 * 0.6}px`);
      if (fillCol) sub.setAttribute("fill", fillCol);
      textEl.appendChild(sub);
      // Invisible reset tspan to restore baseline
      const reset = svgEl("tspan");
      reset.textContent = "\u200B";
      reset.setAttribute("dy", `-${fontSize * 0.25}px`);
      reset.setAttribute("font-size", "0");
      textEl.appendChild(reset);
      textEl.setAttribute("font-size", fontSize * 0.55);
      return;
    }
    // Default plain label
    textEl.textContent = label;
    textEl.setAttribute("font-size", fontSize);
  }

  // ---- Node drawing ----

  function drawIntermediateNode(nodeId, parentX, parentY, gradJunction, gradIntermediate, parentArmLabel) {
    const node = nodes[nodeId];
    if (!node || node.x == null) return;
    const px = node.x, py = node.y;
    const intRad = R * 0.55;

    // Pipe from parent operator to this intermediate
    // gradJunction → gradIntermediate  (B→A for ABC input arms, darken→bright for exp)
    pipeToChild(parentX, parentY, px, py, gradJunction, gradIntermediate, intRad, JR, undefined, parentArmLabel);

    // Helper: draw the intermediate badge circle + live value text
    function drawIntBadge(strokeCol) {
      drawRing(px, py, strokeCol, nodeId);
      const circleEl = drawCircle(px, py, intRad, GLASS_FILL, strokeCol, 1.5);
      node._circleEl = circleEl;
      // Live value text inside the intermediate circle
      const lv = svgEl("text");
      lv.setAttribute("x", px);
      lv.setAttribute("y", py);
      lv.setAttribute("text-anchor", "middle");
      lv.setAttribute("dominant-baseline", "central");
      lv.setAttribute("font-size", 9);
      lv.setAttribute("font-family", MATH_FONT);
      lv.setAttribute("font-style", "normal");
      lv.setAttribute("fill", strokeCol);
      lv.setAttribute("opacity", "0.9");
      lv.setAttribute("display", "none");
      lv.textContent = "";
      uprightText(lv, px, py);
      gText.appendChild(lv);
      node._liveValueEl = lv;
      // Store original counter-rotation transform for restoring after scale
      node._liveValueOrigTransform = lv.getAttribute("transform") || "";

      drawDebugLabel(px, py + intRad + 10, String(nodeId));
      attachRadialClick(nodeId, px, py, "intermediate", intRad + 4);
    }

    // Determine child op's output arm color (for coloring the intermediate)
    let intStrokeCol = gradIntermediate || "#aaa";
    if (node.connectsToOpId != null) {
      const nextOp = nodes[node.connectsToOpId];
      if (nextOp && nextOp.x != null) {
        const nextCatResolved = nextOp.armCategory || categoryForOpType(nextOp.opType);
        const nextCol = nextCatResolved ? (OP_COLORS[nextCatResolved] || opColor(nextOp)) : opColor(nextOp);
        if (!nextOp.armAssignment) {
          const defRoles = getArmRoles(nextOp.opType);
          if (defRoles) {
            nextOp.armAssignment = { ...defRoles };
            nextOp.armCategory = categoryForOpType(nextOp.opType);
          }
        }
        const nextRoles = nextOp.armAssignment || getArmRoles(nextOp.opType);
        const nextCat = nextOp.armCategory || categoryForOpType(nextOp.opType);
        const childOutLabel = nextRoles ? nextRoles.output : null;

        // Determine pipe/circle colors based on child op's category (per-role for all)
        let childGradInt, childGradJunc;
        const ncc = nextCat && ARM_COLORS[nextCat];
        if (ncc && nextRoles) {
          const childOutCol = ncc[nextRoles.output] || nextCol;
          intStrokeCol = childOutCol;
          childGradInt = childOutCol;
          childGradJunc = darkenColor(childOutCol, 0.3);
        } else {
          const childOutCol = outputArmColor(nextCol);
          intStrokeCol = childOutCol;
          childGradInt = childOutCol;
          childGradJunc = darkenColor(childOutCol, 0.3);
        }

        drawIntBadge(intStrokeCol);

        // Pipe from intermediate to child op: childGradInt → childGradJunc
        pipeToChild(px, py, nextOp.x, nextOp.y, childGradInt, childGradJunc, JR, intRad, undefined, childOutLabel);
        drawNode(node.connectsToOpId, px, py, false);
      } else {
        drawIntBadge(intStrokeCol);
      }
    } else {
      drawIntBadge(intStrokeCol);
    }
  }

  // ---- Compute set of node IDs on the equals path (for badge inversion) ----
  const _eqPathNodeSet = new Set();
  {
    const eqEdge = state.equalsEdge;
    if (eqEdge && typeof eqEdge.fromId === 'number') {
      function _buildEqPath(nid, target) {
        if (nid == null) return false;
        const nd = nodes[nid];
        if (!nd) return false;
        if (nid === target) return true;
        if (nd.type === 'intermediate' && nd.connectsToOpId != null) {
          return _buildEqPath(nd.connectsToOpId, target);
        }
        if (nd.type !== 'op') return false;
        if (nd.leftId != null && _buildEqPath(nd.leftId, target)) {
          _eqPathNodeSet.add(nid);
          return true;
        }
        if (nd.rightId != null && nd.rightId !== nd.leftId && _buildEqPath(nd.rightId, target)) {
          _eqPathNodeSet.add(nid);
          return true;
        }
        return false;
      }
      _buildEqPath(rootOpId, eqEdge.toId);
    }
  }

  // =======================================================================
  // ---- Operand scroll-to-adjust dial ("watch crown") --------------------
  // Adds interactive hover+scroll UI on numeric value nodes.
  // Three columns (10s, 1s, 0.1s) with a thick ring showing a value dial.
  // =======================================================================

  /** Update expression and graph after changing a value node in-place.
   *  Does NOT rebuild the SVG — caller updates dial/text elements directly. */
  function applyDagValueChange(nodeId, newStr) {
    nodes[nodeId].value = newStr;
    if (state.equalsEdge) {
      const eqResult = generateEquation(layout, state.equalsEdge);
      if (eqResult) applyEqualsResult(eqResult);
    } else {
      const treeResult = _walkPipeTree(layout);
      if (treeResult) {
        if (ui.exprEl) { ui.exprEl.value = treeResult.text; autoSizeInput(); }
        state.lastExpr = treeResult.text;
        state.fn = compileExpression(treeResult.text);
        state.displaySpans = treeResult.spans;
      }
    }
    try {
      const expr = ui.exprEl?.value ?? "";
      const { steps, ops: newOps } = parseAndLinearize(expr);
      state.steps = steps;
      state.ops = newOps;
    } catch { }
    updateInputOverlay();
    updateLatexDisplay(ui.exprEl?.value ?? "");
  }

  // ---- Spinner click sound via AudioContext ----
  let _spinAudioCtx = null;
  function playSpinClick() {
    try {
      if (!_spinAudioCtx) _spinAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = _spinAudioCtx;
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(1200, t);
      osc.frequency.exponentialRampToValueAtTime(600, t + 0.03);
      gain.gain.setValueAtTime(0.12, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.06);
    } catch (_) { }
  }

  /** Hover highlight + keyboard entry for variable value nodes (x, pi, e). */
  function addVariableHighlight(nodeId, cx, cy, armCol) {
    const node = nodes[nodeId];
    const HOVER_SCALE = 1.25;
    let _keyHandler = null;
    let _typedBuf = "";

    // Hit zone circle (same size as expanded badge)
    const hit = svgEl("circle");
    hit.setAttribute("cx", cx);
    hit.setAttribute("cy", cy);
    hit.setAttribute("r", R * HOVER_SCALE + 2);
    hit.setAttribute("fill", "transparent");
    hit.setAttribute("stroke", "none");
    hit.setAttribute("pointer-events", "all");
    hit.dataset.badgeHit = "1";
    hit.style.cursor = "pointer";

    // Click opens radial menu
    hit.addEventListener("click", (e) => {
      e.stopPropagation();
      hideNodeTooltip();
      showRadialMenu(nodeId, cx, cy, "value");
    });

    hit.addEventListener("mouseenter", () => {
      // Scale up the original circle + text (preserving counter-rotation on text)
      const circleXform = `translate(${cx},${cy}) scale(${HOVER_SCALE}) translate(${-cx},${-cy})`;
      const textXform = _counterDeg !== 0
        ? `translate(${cx},${cy}) scale(${HOVER_SCALE}) rotate(${_counterDeg}) translate(${-cx},${-cy})`
        : circleXform;
      if (node._circleEl) node._circleEl.setAttribute("transform", circleXform);
      if (node._textEl) {
        node._textEl.style.transformBox = "view-box";
        node._textEl.style.transformOrigin = "0 0";
        node._textEl.setAttribute("transform", textXform);
      }
      // Tooltip above expanded badge
      const tipOffset = R * HOVER_SCALE + 8;
      showNodeTooltip(cx, cy - tipOffset + 28, "Click to wrap in operator");
      _typedBuf = "";

      // Keyboard handler: type digits to convert to numeric constant,
      // or type variable names to change to a different variable
      _keyHandler = (e) => {
        // Accept digits, minus, dot for converting to constant
        if (/^[\d.\-]$/.test(e.key)) {
          e.preventDefault();
          _typedBuf += e.key;
          // Validate as a partial number
          if (/^-?[\d]*\.?[\d]*$/.test(_typedBuf) && _typedBuf !== "-" && _typedBuf !== ".") {
            applyDagValueChange(nodeId, _typedBuf);
            playSpinClick();
            renderStepRepresentation();
          }
          return;
        }
        // Accept letters for changing variable (x, e, pi)
        if (/^[a-zA-Z]$/.test(e.key)) {
          e.preventDefault();
          _typedBuf += e.key.toLowerCase();
          const validVars = ["x", "e", "pi"];
          const match = validVars.find(v => v === _typedBuf);
          if (match && match !== node.value) {
            applyDagValueChange(nodeId, match);
            playSpinClick();
            renderStepRepresentation();
          }
          return;
        }
      };
      document.addEventListener("keydown", _keyHandler);
    });

    hit.addEventListener("mouseleave", () => {
      // Restore original transforms (counter-rotation for text)
      if (node._circleEl) node._circleEl.removeAttribute("transform");
      if (node._textEl) {
        node._textEl.style.transformBox = "";
        node._textEl.style.transformOrigin = "";
        if (_counterDeg !== 0) {
          node._textEl.setAttribute("transform", `rotate(${_counterDeg} ${cx} ${cy})`);
        } else {
          node._textEl.removeAttribute("transform");
        }
      }
      hideNodeTooltip();
      _typedBuf = "";
      if (_keyHandler) {
        document.removeEventListener("keydown", _keyHandler);
        _keyHandler = null;
      }
    });

    gInteract.appendChild(hit);
  }

  /** Create scroll-to-adjust dial on a numeric value node. */
  function addValueDial(nodeId, cx, cy, armCol) {
    const node = nodes[nodeId];
    const val = parseFloat(node.value);
    if (!Number.isFinite(val)) return;

    const RING_THICK = 11;
    const HOVER_SCALE = 1.25;
    const STEPS = [10, 1, 0.1];
    const DIAL_R = R + RING_THICK;
    const RING_R = R + RING_THICK / 2;
    const ARC_HALF = 2 * Math.PI / 3; // each side spans 1/3 of the full ring
    const BALL_R_VAL = (RING_THICK / 2) - 0.5;
    const MIN_LABEL_SPACING = 2 * BALL_R_VAL / RING_R * 1.15; // 15% gap
    const NUM_LABELS = Math.max(1, Math.floor(ARC_HALF / MIN_LABEL_SPACING));
    const BASE_FONT = 28;
    const INNER_PAD = 4;
    const MAX_TEXT_W = (R - INNER_PAD) * 2;

    // ---- Scroll sensitivity / trackpad detection ----
    let scrollAccum = 0;
    const MOUSE_THRESH = 30;
    const TRACKPAD_THRESH = 60;
    let isTrackpad = false;

    // ---- Clip ----
    const clipId = "dial-clip-" + nodeId;
    const clipDef = svgEl("clipPath");
    clipDef.setAttribute("id", clipId);
    const clipC = svgEl("circle");
    clipC.setAttribute("cx", cx);
    clipC.setAttribute("cy", cy);
    clipC.setAttribute("r", R - 1);
    clipDef.appendChild(clipC);

    // ---- Dial group ----
    const gDial = svgEl("g");
    gDial.setAttribute("display", "none");
    gDial.setAttribute("pointer-events", "none");
    gDial.appendChild(clipDef);

    // Background
    const bg = svgEl("circle");
    bg.setAttribute("cx", cx);
    bg.setAttribute("cy", cy);
    bg.setAttribute("r", R);
    bg.style.fill = GLASS_FILL;
    bg.setAttribute("stroke", armCol);
    bg.setAttribute("stroke-width", 2);
    gDial.appendChild(bg);

    // Clipped inner area for the number display
    const gClipped = svgEl("g");
    gClipped.setAttribute("clip-path", `url(#${clipId})`);
    gDial.appendChild(gClipped);

    // Single centred text element — uses <tspan> per character for digit highlighting
    const numText = svgEl("text");
    numText.setAttribute("x", cx);
    numText.setAttribute("y", cy);
    numText.setAttribute("text-anchor", "middle");
    numText.setAttribute("dominant-baseline", "central");
    numText.setAttribute("font-size", BASE_FONT);
    numText.setAttribute("font-family", MATH_FONT);
    numText.setAttribute("font-style", "normal");
    numText.setAttribute("fill", armCol);
    uprightText(numText, cx, cy);
    gClipped.appendChild(numText);

    // Thick opaque dial ring
    const ring = svgEl("circle");
    ring.setAttribute("cx", cx);
    ring.setAttribute("cy", cy);
    ring.setAttribute("r", RING_R);
    ring.setAttribute("fill", "none");
    ring.setAttribute("stroke", armCol);
    ring.setAttribute("stroke-width", RING_THICK);
    ring.setAttribute("opacity", "1");
    gDial.appendChild(ring);

    // Dial labels — each is a group: black circle + coloured text
    const BALL_R = BALL_R_VAL;
    const dialLabels = [];
    for (let i = -NUM_LABELS; i <= NUM_LABELS; i++) {
      const g = svgEl("g");
      g.setAttribute("display", "none");
      const c = svgEl("circle");
      c.setAttribute("r", BALL_R);
      c.setAttribute("fill", "#000");
      g.appendChild(c);
      const t = svgEl("text");
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("dominant-baseline", "central");
      t.setAttribute("font-family", MATH_FONT);
      t.setAttribute("font-style", "normal");
      t.setAttribute("fill", armCol);
      g.appendChild(t);
      gDial.appendChild(g);
      dialLabels.push({ g, circle: c, el: t, offset: i });
    }

    gInteract.appendChild(gDial);

    // ---- Hit zone ----
    const hit = svgEl("circle");
    hit.setAttribute("cx", cx);
    hit.setAttribute("cy", cy);
    hit.setAttribute("r", DIAL_R * HOVER_SCALE + 2);
    hit.setAttribute("fill", "transparent");
    hit.setAttribute("stroke", "none");
    hit.dataset.badgeHit = "1";
    hit.style.cursor = "ns-resize";
    hit.setAttribute("pointer-events", "all");
    // Click opens radial menu (wraps this value in an operator)
    hit.addEventListener("click", (e) => {
      e.stopPropagation();
      hideNodeTooltip();
      showRadialMenu(nodeId, cx, cy, "value");
    });
    gInteract.appendChild(hit);

    // ---- State ----
    let activeCol = -1;
    let angOffset = 0;
    let animId = null;

    // ---- Helpers ----

    /** Map character index in the display string → column (0=tens,1=ones,2=tenths).
     *  Returns -1 for minus sign, dot, or digits outside the three columns. */
    function charToCol(str, idx) {
      const ch = str[idx];
      if (ch === "-" || ch === "\u2212") return -1;
      if (ch === ".") return 2; // dot grouped with tenths
      const dotIdx = str.indexOf(".");
      const signLen = (str[0] === "-" || str[0] === "\u2212") ? 1 : 0;
      if (dotIdx >= 0 && idx > dotIdx) return 2; // after decimal
      // Integer digits — count position from right of the integer part
      const intEnd = dotIdx >= 0 ? dotIdx : str.length;
      const posFromRight = intEnd - 1 - idx;
      if (posFromRight === 0) return 1; // ones
      if (posFromRight === 1) return 0; // tens
      return -1; // hundreds+
    }

    /** Pad the value string so the active column's digit is always visible. */
    function paddedValue(col) {
      let str = node.value;
      const signLen = (str[0] === "-" || str[0] === "\u2212") ? 1 : 0;
      const sign = str.substring(0, signLen);
      const rest = str.substring(signLen);
      if (col === 0) { // tens — ensure at least 2 integer digits
        const dotPos = rest.indexOf(".");
        const intPart = dotPos >= 0 ? rest.substring(0, dotPos) : rest;
        const fracPart = dotPos >= 0 ? rest.substring(dotPos) : "";
        if (intPart.length < 2) str = sign + "0".repeat(2 - intPart.length) + intPart + fracPart;
      }
      if (col === 2) { // tenths — ensure decimal point + at least 1 decimal digit
        if (!str.includes(".")) str += ".0";
        else if (str.endsWith(".")) str += "0";
      }
      return str;
    }

    /** Render the number with per-character tspans, highlighting the active column's digit. */
    function updateNumberDisplay() {
      const str = paddedValue(activeCol);
      while (numText.firstChild) numText.removeChild(numText.firstChild);
      for (let i = 0; i < str.length; i++) {
        const tspan = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
        const col = charToCol(str, i);
        if (col === activeCol && activeCol >= 0) {
          tspan.setAttribute("fill", "#fff");
        } else {
          tspan.setAttribute("fill", armCol);
          // Dim leading-zero tens or trailing .0
          const ch = str[i];
          const signLen = (str[0] === "-" || str[0] === "\u2212") ? 1 : 0;
          const isLeadingZero = col === 0 && ch === "0" && signLen === 0;
          if (isLeadingZero) tspan.setAttribute("opacity", "0.3");
        }
        tspan.textContent = str[i];
        numText.appendChild(tspan);
      }
      // Fit text inside circle
      numText.setAttribute("font-size", BASE_FONT);
      try {
        const bbox = numText.getBBox();
        if (bbox.width > MAX_TEXT_W) {
          const scaled = Math.floor(BASE_FONT * MAX_TEXT_W / bbox.width);
          numText.setAttribute("font-size", Math.max(8, scaled));
        }
      } catch (_) { }
    }

    function formatDialVal(v, step) {
      if (step < 1) return v.toFixed(1);
      return String(Math.round(v));
    }

    function fitText(textEl, maxW, baseSize) {
      textEl.setAttribute("font-size", baseSize);
      try {
        const bbox = textEl.getBBox();
        if (bbox.width > maxW) {
          const scaled = Math.floor(baseSize * maxW / bbox.width);
          textEl.setAttribute("font-size", Math.max(6, scaled));
        }
      } catch (_) { }
    }

    function ringLabelMaxW() {
      return BALL_R * 2 * 0.85; // text fits inside ball-bearing diameter
    }

    function positionDialLabels(col, extraAng) {
      const v = parseFloat(node.value);
      const step = STEPS[col];
      const dAng = ARC_HALF / NUM_LABELS;
      const maxW = ringLabelMaxW();
      for (const lbl of dialLabels) {
        const off = lbl.offset;
        const ang = -Math.PI / 2 + off * dAng + extraAng;
        if (ang < -Math.PI / 2 - ARC_HALF || ang > -Math.PI / 2 + ARC_HALF) {
          lbl.g.setAttribute("display", "none");
          continue;
        }
        const lx = cx + RING_R * Math.cos(ang);
        const ly = cy + RING_R * Math.sin(ang);
        lbl.circle.setAttribute("cx", lx);
        lbl.circle.setAttribute("cy", ly);
        lbl.el.setAttribute("x", lx);
        lbl.el.setAttribute("y", ly);
        uprightText(lbl.el, lx, ly);
        lbl.el.textContent = formatDialVal(v + off * step, step);
        const baseSz = off === 0 ? 9 : 8;
        // Active label: white text; others: arm colour
        lbl.el.setAttribute("fill", off === 0 ? "#fff" : armCol);
        const fade = 1 - Math.abs(ang + Math.PI / 2) / ARC_HALF;
        const opacity = Math.max(0.15, fade);
        lbl.circle.setAttribute("opacity", String(opacity));
        lbl.el.setAttribute("opacity", String(opacity));
        lbl.g.setAttribute("display", "");
        fitText(lbl.el, maxW, baseSz);
      }
    }

    function setActiveCol(c) {
      if (c === activeCol) return;
      activeCol = c;
      updateNumberDisplay();
      if (c >= 0 && c < 3) {
        angOffset = 0;
        positionDialLabels(c, 0);
      } else {
        for (const lbl of dialLabels) lbl.g.setAttribute("display", "none");
      }
    }

    function getColumn(e) {
      const pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const svgPt = pt.matrixTransform(svg.getScreenCTM().inverse());
      const lx = (svgPt.x - cx) / HOVER_SCALE + cx;
      const COL_W = (2 * R) / 3;
      const relX = lx - (cx - R);
      return Math.max(0, Math.min(2, Math.floor(relX / COL_W)));
    }

    function animateSnap() {
      if (Math.abs(angOffset) < 0.005) {
        angOffset = 0;
        if (activeCol >= 0) positionDialLabels(activeCol, 0);
        animId = null;
        return;
      }
      angOffset *= 0.55;
      if (activeCol >= 0) positionDialLabels(activeCol, angOffset);
      animId = requestAnimationFrame(animateSnap);
    }

    // ---- Events ----
    // ---- Keyboard direct-entry handler ----
    let _varBuf = "";
    function onKeyDown(e) {
      // Only respond to digit keys, minus, period, backspace, and letters (for variable names)
      const key = e.key;
      if (/^[0-9]$/.test(key)) {
        e.preventDefault();
        _varBuf = "";
        applyDagValueChange(nodeId, key);
        playSpinClick();
        updateNumberDisplay();
        if (activeCol >= 0) positionDialLabels(activeCol, 0);
      } else if (key === "-" || key === ".") {
        e.preventDefault();
        _varBuf = "";
        const cur = node.value;
        if (key === "-") {
          // Toggle sign
          const newStr = cur.startsWith("-") ? cur.slice(1) : "-" + cur;
          applyDagValueChange(nodeId, newStr || "0");
        } else {
          // Add decimal if not present
          if (!cur.includes(".")) applyDagValueChange(nodeId, cur + ".0");
        }
        playSpinClick();
        updateNumberDisplay();
        if (activeCol >= 0) positionDialLabels(activeCol, 0);
      } else if (/^[a-zA-Z]$/.test(key)) {
        // Type variable names (x, e, pi) to convert numeric constant to variable
        e.preventDefault();
        _varBuf += key.toLowerCase();
        const validVars = ["x", "e", "pi"];
        const match = validVars.find(v => v === _varBuf);
        if (match) {
          applyDagValueChange(nodeId, match);
          playSpinClick();
          renderStepRepresentation();
          _varBuf = "";
        } else if (!validVars.some(v => v.startsWith(_varBuf))) {
          _varBuf = ""; // reset if no variable can match
        }
      } else if (key === "Backspace" || key === "Delete") {
        e.preventDefault();
        _varBuf = "";
        deleteOperatorNode(nodeId, layout);
      }
    }

    hit.addEventListener("mouseenter", (e) => {
      // Hide original node circle + text so they don't show behind the scaled dial
      if (node._circleEl) node._circleEl.setAttribute("display", "none");
      if (node._textEl) node._textEl.setAttribute("display", "none");
      gDial.setAttribute("display", "");
      gDial.setAttribute("transform",
        `translate(${cx},${cy}) scale(${HOVER_SCALE}) translate(${-cx},${-cy})`);
      updateNumberDisplay();
      setActiveCol(getColumn(e));
      document.addEventListener("keydown", onKeyDown);
      // Show tooltip above expanded dial
      const tipOffset = (R + RING_THICK) * HOVER_SCALE + 8;
      showNodeTooltip(cx, cy - tipOffset + 28, "Click to wrap in operator");
    });

    hit.addEventListener("mousemove", (e) => {
      setActiveCol(getColumn(e));
    });

    hit.addEventListener("mouseleave", () => {
      document.removeEventListener("keydown", onKeyDown);
      gDial.setAttribute("display", "none");
      gDial.removeAttribute("transform");
      setActiveCol(-1);
      if (animId) { cancelAnimationFrame(animId); animId = null; }
      angOffset = 0;
      scrollAccum = 0;
      hideNodeTooltip();
      // Restore original circle + text
      if (node._circleEl) node._circleEl.setAttribute("display", "");
      if (node._textEl) {
        node._textEl.textContent = node.value;
        node._textEl.setAttribute("display", "");
        // Resize restored text to fit inside circle
        node._textEl.setAttribute("font-size", 32);
        try {
          const bbox = node._textEl.getBBox();
          if (bbox.width > MAX_TEXT_W) {
            const scaled = Math.floor(32 * MAX_TEXT_W / bbox.width);
            node._textEl.setAttribute("font-size", Math.max(8, scaled));
          }
        } catch (_) { }
      }
    });

    hit.addEventListener("wheel", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Trackpad heuristic: trackpads typically send small fractional deltaY
      const absDY = Math.abs(e.deltaY);
      if (absDY > 0 && absDY < 10) isTrackpad = true;
      else if (absDY >= 50) isTrackpad = false;

      const thresh = isTrackpad ? TRACKPAD_THRESH : MOUSE_THRESH;
      scrollAccum -= e.deltaY; // negate: scroll-up = positive accumulation
      if (Math.abs(scrollAccum) < thresh) return;

      const col = getColumn(e);
      const step = STEPS[col];
      const curVal = parseFloat(node.value);
      if (!Number.isFinite(curVal)) return;

      const ticks = Math.trunc(scrollAccum / thresh);
      scrollAccum -= ticks * thresh;
      // scroll-up (negative deltaY) → positive ticks → increase value
      const dir = ticks > 0 ? 1 : -1;
      const absTicks = Math.abs(ticks);

      // Digit-based change for tens column; step-based for ones & tenths
      let newVal;
      if (step === 10) {
        // Tens column: change only the tens digit, preserving other digits
        const isNeg = curVal < 0;
        const absVal = Math.abs(curVal);
        const digit = Math.floor(absVal / 10) % 10;
        const digitDelta = (isNeg ? -dir : dir) * absTicks;
        const newDigit = digit + digitDelta;
        let newAbs = absVal - digit * 10 + Math.abs(newDigit) * 10;
        let newNeg = newDigit < 0 ? !isNeg : isNeg;
        if (newAbs === 0) newNeg = false;
        newVal = newNeg ? -newAbs : newAbs;
      } else {
        // Ones / tenths: simple step-based arithmetic
        newVal = curVal + dir * absTicks * step;
      }
      if (step < 1) newVal = Math.round(newVal * 10) / 10;
      const hasDec = node.value.includes(".");
      const curDec = hasDec ? (node.value.split(".")[1] || "").length : 0;
      const outDec = step < 1 ? Math.max(1, curDec) : curDec;
      const newStr = outDec > 0 ? newVal.toFixed(outDec) : String(Math.round(newVal));
      applyDagValueChange(nodeId, newStr);
      playSpinClick();

      const dAng = ARC_HALF / NUM_LABELS;
      // Scroll up → value increases → ring appears to step clockwise
      angOffset += dir * absTicks * dAng;
      updateNumberDisplay();
      if (activeCol >= 0) positionDialLabels(activeCol, angOffset);
      if (!animId) animId = requestAnimationFrame(animateSnap);
    }, { passive: false });

    // ---- Touch hold-to-scroll for mobile ----
    {
      const TOUCH_SCALE = 1.6;
      const TOUCH_LIFT = 55;        // SVG units to raise dial above finger
      const HOLD_DELAY = 250;       // ms before activating
      const TOUCH_SCROLL_THRESH = 8; // px per tick
      let holdTimer = null;
      let touchActive = false;
      let lastTouchY = 0;
      let touchScrollAccum = 0;

      function getColumnFromTouch(touch) {
        const pt = svg.createSVGPoint();
        pt.x = touch.clientX;
        pt.y = touch.clientY;
        const svgPt = pt.matrixTransform(svg.getScreenCTM().inverse());
        const COL_W = (2 * R) / 3;
        const relX = svgPt.x - (cx - R);
        return Math.max(0, Math.min(2, Math.floor(relX / COL_W)));
      }

      function activateTouchDial(touch) {
        touchActive = true;
        lastTouchY = touch.clientY;
        touchScrollAccum = 0;
        // Hide original node visuals
        if (node._circleEl) node._circleEl.setAttribute("display", "none");
        if (node._textEl) node._textEl.setAttribute("display", "none");
        // Show dial scaled & lifted above touch point
        gDial.setAttribute("display", "");
        gDial.setAttribute("transform",
          `translate(0,${-TOUCH_LIFT}) translate(${cx},${cy}) scale(${TOUCH_SCALE}) translate(${-cx},${-cy})`);
        updateNumberDisplay();
        setActiveCol(getColumnFromTouch(touch));
        // Tooltip above lifted dial
        const tipOffset = (R + RING_THICK) * TOUCH_SCALE + TOUCH_LIFT + 8;
        showNodeTooltip(cx, cy - tipOffset + 28, "Slide \u2195 to scroll, \u2194 to change place");
      }

      function deactivateTouchDial() {
        touchActive = false;
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        gDial.setAttribute("display", "none");
        gDial.removeAttribute("transform");
        setActiveCol(-1);
        if (animId) { cancelAnimationFrame(animId); animId = null; }
        angOffset = 0;
        touchScrollAccum = 0;
        hideNodeTooltip();
        // Restore original circle + text
        if (node._circleEl) node._circleEl.setAttribute("display", "");
        if (node._textEl) {
          node._textEl.textContent = node.value;
          node._textEl.setAttribute("display", "");
          node._textEl.setAttribute("font-size", 32);
          try {
            const bbox = node._textEl.getBBox();
            if (bbox.width > MAX_TEXT_W) {
              const scaled = Math.floor(32 * MAX_TEXT_W / bbox.width);
              node._textEl.setAttribute("font-size", Math.max(8, scaled));
            }
          } catch (_) { }
        }
      }

      hit.addEventListener("touchstart", (e) => {
        e.preventDefault();
        const touch = e.touches[0];
        holdTimer = setTimeout(() => {
          holdTimer = null;
          activateTouchDial(touch);
        }, HOLD_DELAY);
      }, { passive: false });

      hit.addEventListener("touchmove", (e) => {
        if (!touchActive && holdTimer) {
          // Moved before hold triggered → cancel
          clearTimeout(holdTimer);
          holdTimer = null;
          return;
        }
        if (!touchActive) return;
        e.preventDefault();
        const touch = e.touches[0];

        // Horizontal: column selection
        setActiveCol(getColumnFromTouch(touch));

        // Vertical: scroll value (up = increase)
        const dy = lastTouchY - touch.clientY;
        lastTouchY = touch.clientY;
        touchScrollAccum += dy;

        if (Math.abs(touchScrollAccum) >= TOUCH_SCROLL_THRESH) {
          const col = activeCol >= 0 ? activeCol : 1;
          const step = STEPS[col];
          const curVal = parseFloat(node.value);
          if (!Number.isFinite(curVal)) return;

          const ticks = Math.trunc(touchScrollAccum / TOUCH_SCROLL_THRESH);
          touchScrollAccum -= ticks * TOUCH_SCROLL_THRESH;
          const dir = ticks > 0 ? 1 : -1;
          const absTicks = Math.abs(ticks);

          let newVal;
          if (step === 10) {
            const isNeg = curVal < 0;
            const absVal = Math.abs(curVal);
            const digit = Math.floor(absVal / 10) % 10;
            const digitDelta = (isNeg ? -dir : dir) * absTicks;
            const newDigit = digit + digitDelta;
            let newAbs = absVal - digit * 10 + Math.abs(newDigit) * 10;
            let newNeg = newDigit < 0 ? !isNeg : isNeg;
            if (newAbs === 0) newNeg = false;
            newVal = newNeg ? -newAbs : newAbs;
          } else {
            newVal = curVal + dir * absTicks * step;
          }
          if (step < 1) newVal = Math.round(newVal * 10) / 10;
          const hasDec = node.value.includes(".");
          const curDec = hasDec ? (node.value.split(".")[1] || "").length : 0;
          const outDec = step < 1 ? Math.max(1, curDec) : curDec;
          const newStr = outDec > 0 ? newVal.toFixed(outDec) : String(Math.round(newVal));
          applyDagValueChange(nodeId, newStr);
          playSpinClick();

          const dAng = ARC_HALF / NUM_LABELS;
          angOffset += dir * absTicks * dAng;
          updateNumberDisplay();
          if (activeCol >= 0) positionDialLabels(activeCol, angOffset);
          if (!animId) animId = requestAnimationFrame(animateSnap);
        }
      }, { passive: false });

      hit.addEventListener("touchend", () => {
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        if (touchActive) deactivateTouchDial();
      });

      hit.addEventListener("touchcancel", () => {
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        if (touchActive) deactivateTouchDial();
      });
    }
  }

  function drawNode(nodeId, parentX, parentY, drawOutputArm, parentArmColor) {
    const node = nodes[nodeId];
    if (!node || node.x == null) return;
    const px = node.x, py = node.y;

    if (node.type === "value") {
      // x always keeps its blue; other operands colored by the arm they connect to
      const isX = node.value === "x";
      const armCol = isX ? OP_COLORS.x : (parentArmColor || "#888");
      const circleEl = drawCircle(px, py, R, GLASS_FILL, armCol, 2);
      node._circleEl = circleEl;  // ref so dial can hide on hover
      // Numbers: upright (non-italic). Variables/constants: italic (matches LaTeX)
      const isNumeric = /^-?[\d.]+$/.test(node.value);
      const textEl = drawText(px, py, node.value, 32, armCol, !isNumeric);
      node._textEl = textEl;  // ref for in-place updates
      drawDebugLabel(px, py + R + 12, String(nodeId));
      // Scroll-to-adjust dial for numeric constants
      // (addValueDial integrates click-to-radial + tooltip, no extra attachRadialClick)
      if (isNumeric) {
        addValueDial(nodeId, px, py, armCol);
      } else {
        // Variable/constant value nodes get hover highlight + radial click
        addVariableHighlight(nodeId, px, py, armCol);
      }
      return;
    }

    if (node.type === "intermediate") {
      return;
    }

    // Operator node
    const cat = categoryForOpType(node.opType);

    // Initialise persistent arm assignment and category if not yet set
    if (!node.armAssignment) {
      const defaultRoles = getArmRoles(node.opType);
      if (defaultRoles) {
        node.armAssignment = { ...defaultRoles };
        node.armCategory = cat;  // persist original category
      }
    }
    // Use persisted category (survives opType changes like power→call)
    const effectiveCat = node.armCategory || cat;
    const roles = node.armAssignment || getArmRoles(node.opType);

    // Stable base color: use effectiveCat to avoid grey fallback after exp→call swaps
    const col = effectiveCat
      ? (OP_COLORS[effectiveCat] || opColor(node))
      : opColor(node);

    // Per-arm colors — all categories use per-role keys so colours follow swaps
    let outArmCol, leftArmCol, rightArmCol, badgeCol;
    const armCC = effectiveCat && ARM_COLORS[effectiveCat];
    if (armCC && roles) {
      leftArmCol = armCC[roles.left] || col;
      rightArmCol = armCC[roles.right] || col;
      outArmCol = armCC[roles.output] || col;
      badgeCol = outArmCol;  // badge color follows output pipe
    } else {
      leftArmCol = col;
      rightArmCol = col;
      outArmCol = outputArmColor(col);
      badgeCol = outArmCol;  // badge color follows output pipe
    }
    const outLabel = roles ? roles.output : null;
    const leftLabel = roles ? roles.left : null;
    const rightLabel = roles ? roles.right : null;

    // Derive displayed symbol from arm assignment (may differ from initial opType after swaps)
    let displaySymbol = node.symbol || "";
    if (roles && effectiveCat) {
      const info = deriveOpInfo(effectiveCat, roles);
      if (info) displaySymbol = info.symbol;
    }

    // If this node is on the equals path, show the INVERSE operator symbol
    // (e.g. "+" → "−", "×" → "÷") to match the rearranged LHS equation
    if (_eqPathNodeSet.has(nodeId) && effectiveCat) {
      if (effectiveCat === "addSub") {
        displaySymbol = displaySymbol === "+" ? "\u2212" : "+";
      } else if (effectiveCat === "mulDiv") {
        displaySymbol = displaySymbol === "\u00d7" ? "\u00f7" : "\u00d7";
      }
      // exp family inversion (^↔√↔log) is complex; skip for now
    }

    // Output arm pipe toward parent: darken→bright gradient for all categories
    if (drawOutputArm && parentX != null && parentY != null) {
      pipeToChild(px, py, parentX, parentY, darkenColor(outArmCol, 0.3), outArmCol, R, JR, 'child', outLabel);
    }

    // Ring circle + operator junction circle
    drawRing(px, py, badgeCol, nodeId);
    const junctionCircle = drawCircle(px, py, JR, GLASS_FILL, badgeCol, 2.5);
    junctionCircle.dataset.ringId = String(nodeId);
    node._junctionEl = junctionCircle;
    // Operator symbol — use styled rendering for ^ (n^m) and log (log(m))
    // Scale font size to fit within the junction circle radius
    const badgeFontSize = badgeFontSizeForLabel(displaySymbol, JR);
    const isSymbol = /^[+\-×÷\^/%⌈⌉⌊⌋|·]|log|ⁿ√$/.test(displaySymbol);
    const symTextEl = drawText(px, py, "", badgeFontSize, badgeCol, !isSymbol);
    setStyledLabel(symTextEl, displaySymbol, badgeFontSize, badgeCol);
    // Tag the just-added text for animation
    const lastText = gText.lastElementChild;
    if (lastText) lastText.dataset.ringId = String(nodeId);
    node._symbolTextEl = lastText;
    // Tag the ring circle for animation (if exists)
    const lastRing = gRings.lastElementChild;
    if (lastRing) lastRing.dataset.ringId = String(nodeId);
    drawDebugLabel(px, py + JR + 10, String(nodeId));

    // Live value text — small label below junction, hidden until cursor update
    {
      const lv = svgEl("text");
      lv.setAttribute("x", px);
      lv.setAttribute("y", py + JR + 13);
      lv.setAttribute("text-anchor", "middle");
      lv.setAttribute("dominant-baseline", "hanging");
      lv.setAttribute("font-size", 10);
      lv.setAttribute("font-family", MATH_FONT);
      lv.setAttribute("font-style", "normal");
      lv.setAttribute("fill", badgeCol);
      lv.setAttribute("opacity", "0.85");
      lv.setAttribute("display", "none");
      lv.textContent = "";
      uprightText(lv, px, py + JR + 13);
      gText.appendChild(lv);
      node._liveValueEl = lv;
    }

    // Radial menu click target for operator nodes
    attachRadialClick(nodeId, px, py, "op", JR);

    // ---- Swap buttons (3 between each pair of arms) ----
    if (roles && effectiveCat) {
      // Compute actual directions to each arm endpoint
      const armDirs = {};
      // Output direction: toward parent
      if (parentX != null && parentY != null) {
        const dx = parentX - px, dy = parentY - py;
        const len = Math.hypot(dx, dy) || 1;
        armDirs.output = { x: dx / len, y: dy / len };
      }
      // Left direction: toward left child
      if (node.leftId != null) {
        const lc = nodes[node.leftId];
        if (lc && lc.x != null) {
          const dx = lc.x - px, dy = lc.y - py;
          const len = Math.hypot(dx, dy) || 1;
          armDirs.left = { x: dx / len, y: dy / len };
        }
      }
      // Right direction: toward right child
      if (node.rightId != null && node.rightId !== node.leftId) {
        const rc = nodes[node.rightId];
        if (rc && rc.x != null) {
          const dx = rc.x - px, dy = rc.y - py;
          const len = Math.hypot(dx, dy) || 1;
          armDirs.right = { x: dx / len, y: dy / len };
        }
      }

      // Actual endpoint positions (for swap animation)
      const armEndpoints = {};
      if (parentX != null && parentY != null) armEndpoints.output = { x: parentX, y: parentY };
      if (node.leftId != null) {
        const lc = nodes[node.leftId];
        if (lc && lc.x != null) armEndpoints.left = { x: lc.x, y: lc.y };
      }
      if (node.rightId != null && node.rightId !== node.leftId) {
        const rc = nodes[node.rightId];
        if (rc && rc.x != null) armEndpoints.right = { x: rc.x, y: rc.y };
      }

      // Create swap buttons between each pair of arms that exists
      const armPairs = [];
      if (armDirs.left && armDirs.right) armPairs.push(["left", "right"]);
      if (armDirs.left && armDirs.output) armPairs.push(["left", "output"]);
      if (armDirs.right && armDirs.output) armPairs.push(["right", "output"]);

      const SWAP_R = 10;
      const SWAP_DIST = JR + 16;

      // Container group: hover zone (behind) + buttons (on top)
      // mouseenter/leave on the group handles show/hide for all children
      const swapGroup = svgEl("g");
      swapGroup.classList.add("swap-group");
      swapGroup.setAttribute("data-node-id", nodeId);

      // Hover zone: invisible circle — appended first so it's behind buttons
      const hoverZone = svgEl("circle");
      hoverZone.setAttribute("cx", px);
      hoverZone.setAttribute("cy", py);
      hoverZone.setAttribute("r", JR + 26);
      hoverZone.setAttribute("fill", "transparent");
      hoverZone.setAttribute("stroke", "none");
      hoverZone.setAttribute("pointer-events", "all");
      hoverZone.dataset.badgeHit = "1";
      // Click on the hover zone centre opens the radial menu to change operator
      hoverZone.addEventListener("click", (e) => {
        e.stopPropagation();
        hideNodeTooltip();
        showRadialMenu(nodeId, px, py, "op");
      });
      hoverZone.style.cursor = "pointer";
      swapGroup.appendChild(hoverZone);

      for (const [posA, posB] of armPairs) {
        const dA = armDirs[posA], dB = armDirs[posB];
        // Bisector direction (between the two arms)
        const mx = dA.x + dB.x, my = dA.y + dB.y;
        const mLen = Math.hypot(mx, my) || 1;
        const bx = px + SWAP_DIST * mx / mLen;
        const by = py + SWAP_DIST * my / mLen;

        const btnG = svgEl("g");
        btnG.classList.add("swap-btn");
        btnG.setAttribute("data-node-id", nodeId);
        btnG.setAttribute("data-pos-a", posA);
        btnG.setAttribute("data-pos-b", posB);
        btnG.style.cursor = "pointer";
        btnG.style.opacity = "0";
        btnG.style.transition = "opacity 0.15s";
        btnG.style.pointerEvents = "none";

        const bg = svgEl("circle");
        bg.setAttribute("cx", bx);
        bg.setAttribute("cy", by);
        bg.setAttribute("r", SWAP_R);
        bg.setAttribute("fill", isDarkMode ? "rgba(40,40,40,0.9)" : "rgba(230,230,230,0.9)");
        bg.setAttribute("stroke", "#888");
        bg.setAttribute("stroke-width", 1);
        btnG.appendChild(bg);

        // Swap icon: ↔ symbol
        const ico = svgEl("text");
        ico.setAttribute("x", bx);
        ico.setAttribute("y", by);
        ico.setAttribute("text-anchor", "middle");
        ico.setAttribute("dominant-baseline", "central");
        ico.setAttribute("font-size", 11);
        ico.setAttribute("fill", "#ccc");
        ico.textContent = "⇄";
        uprightText(ico, bx, by);
        btnG.appendChild(ico);

        // Click handler: swap the two arms with turnstile animation
        btnG.addEventListener("click", (e) => {
          e.stopPropagation();

          // --- Turnstile animation ---
          const endA = armEndpoints[posA], endB = armEndpoints[posB];
          if (!endA || !endB) {
            // Fallback: immediate swap, no animation
            const temp = node.armAssignment[posA];
            node.armAssignment[posA] = node.armAssignment[posB];
            node.armAssignment[posB] = temp;
            const info = deriveOpInfo(effectiveCat, node.armAssignment);
            if (info) { node.opType = info.opType; node.symbol = info.symbol; }
            applySwapToAstAndState();
            renderStepRepresentation();
            return;
          }

          // Compute rotation angle
          const θA = Math.atan2(endA.y - py, endA.x - px);
          const θB = Math.atan2(endB.y - py, endB.x - px);
          let delta = θB - θA;
          while (delta > Math.PI) delta -= 2 * Math.PI;
          while (delta < -Math.PI) delta += 2 * Math.PI;
          const deltaDeg = delta * 180 / Math.PI;

          // Arm animation colours — per-role for all categories
          let animColA, animColB;
          const animCC = effectiveCat && ARM_COLORS[effectiveCat];
          if (animCC && node.armAssignment) {
            animColA = animCC[node.armAssignment[posA]] || col;
            animColB = animCC[node.armAssignment[posB]] || col;
          } else {
            animColA = animColB = col;
          }

          // Build overlay group
          const animOverlay = svgEl("g");
          animOverlay.style.pointerEvents = "none";

          // Dim layer (covers entire SVG)
          const dimLayer = svgEl("rect");
          dimLayer.setAttribute("x", "-10000"); dimLayer.setAttribute("y", "-10000");
          dimLayer.setAttribute("width", "20000"); dimLayer.setAttribute("height", "20000");
          dimLayer.setAttribute("fill", isDarkMode ? "rgba(30,30,30,0.6)" : "rgba(255,255,255,0.6)");
          animOverlay.appendChild(dimLayer);

          // Static pivot badge
          const pivotC = svgEl("circle");
          pivotC.setAttribute("cx", px); pivotC.setAttribute("cy", py);
          pivotC.setAttribute("r", JR);
          pivotC.style.fill = GLASS_FILL;
          pivotC.setAttribute("stroke", badgeCol);
          pivotC.setAttribute("stroke-width", 2.5);
          animOverlay.appendChild(pivotC);
          const pivotT = svgEl("text");
          pivotT.setAttribute("x", px); pivotT.setAttribute("y", py);
          pivotT.setAttribute("text-anchor", "middle");
          pivotT.setAttribute("dominant-baseline", "central");
          pivotT.setAttribute("font-size", 15);
          pivotT.setAttribute("font-family", MATH_FONT);
          pivotT.setAttribute("fill", badgeCol);
          pivotT.textContent = displaySymbol;
          uprightText(pivotT, px, py);
          animOverlay.appendChild(pivotT);

          // Arm A: rotating line from junction to endA
          const gA = svgEl("g");
          const lineA = svgEl("line");
          lineA.setAttribute("x1", px); lineA.setAttribute("y1", py);
          lineA.setAttribute("x2", endA.x); lineA.setAttribute("y2", endA.y);
          lineA.setAttribute("stroke", animColA);
          lineA.setAttribute("stroke-width", PW);
          lineA.setAttribute("stroke-linecap", "round");
          lineA.setAttribute("opacity", "0.85");
          gA.appendChild(lineA);
          const smilA = svgEl("animateTransform");
          smilA.setAttribute("attributeName", "transform");
          smilA.setAttribute("type", "rotate");
          smilA.setAttribute("from", `0 ${px} ${py}`);
          smilA.setAttribute("to", `${deltaDeg} ${px} ${py}`);
          smilA.setAttribute("dur", "0.4s");
          smilA.setAttribute("fill", "freeze");
          smilA.setAttribute("calcMode", "spline");
          smilA.setAttribute("keyTimes", "0;1");
          smilA.setAttribute("keySplines", "0.42 0 0.58 1");
          smilA.setAttribute("begin", "indefinite");
          gA.appendChild(smilA);
          animOverlay.appendChild(gA);

          // Arm B: rotating line from junction to endB (opposite direction)
          const gB = svgEl("g");
          const lineB = svgEl("line");
          lineB.setAttribute("x1", px); lineB.setAttribute("y1", py);
          lineB.setAttribute("x2", endB.x); lineB.setAttribute("y2", endB.y);
          lineB.setAttribute("stroke", animColB);
          lineB.setAttribute("stroke-width", PW);
          lineB.setAttribute("stroke-linecap", "round");
          lineB.setAttribute("opacity", "0.85");
          gB.appendChild(lineB);
          const smilB = svgEl("animateTransform");
          smilB.setAttribute("attributeName", "transform");
          smilB.setAttribute("type", "rotate");
          smilB.setAttribute("from", `0 ${px} ${py}`);
          smilB.setAttribute("to", `${-deltaDeg} ${px} ${py}`);
          smilB.setAttribute("dur", "0.4s");
          smilB.setAttribute("fill", "freeze");
          smilB.setAttribute("calcMode", "spline");
          smilB.setAttribute("keyTimes", "0;1");
          smilB.setAttribute("keySplines", "0.42 0 0.58 1");
          smilB.setAttribute("begin", "indefinite");
          gB.appendChild(smilB);
          animOverlay.appendChild(gB);

          svg.appendChild(animOverlay);

          // Start SMIL animations
          smilA.beginElement();
          smilB.beginElement();

          // After animation: apply swap and re-render
          const ANIM_DUR = 430;
          setTimeout(() => {
            // Swap the role labels (no normalisation — positions stay, roles move)
            const temp = node.armAssignment[posA];
            node.armAssignment[posA] = node.armAssignment[posB];
            node.armAssignment[posB] = temp;
            // Update opType and symbol
            const info = deriveOpInfo(effectiveCat, node.armAssignment);
            if (info) { node.opType = info.opType; node.symbol = info.symbol; }
            // Update AST, expression, overlay, latex, and re-render SVG
            applySwapToAstAndState();
            renderStepRepresentation();
            updateInputOverlay();
            updateLatexDisplay(ui.exprEl?.value ?? "");
          }, ANIM_DUR);
        });

        swapGroup.appendChild(btnG);
      }

      // Hover on the group shows/hides all buttons inside it
      const OP_HOVER_SCALE = 1.2;
      let _opDeleteHandler = null;
      swapGroup.addEventListener("mouseenter", () => {
        swapGroup.querySelectorAll(".swap-btn").forEach(b => {
          b.style.opacity = "1"; b.style.pointerEvents = "auto";
        });
        // Expand the junction circle and symbol text (preserving counter-rotation on text)
        const circleXform = `translate(${px},${py}) scale(${OP_HOVER_SCALE}) translate(${-px},${-py})`;
        const textXform = _counterDeg !== 0
          ? `translate(${px},${py}) scale(${OP_HOVER_SCALE}) rotate(${_counterDeg}) translate(${-px},${-py})`
          : circleXform;
        if (node._junctionEl) node._junctionEl.setAttribute("transform", circleXform);
        if (node._symbolTextEl) {
          node._symbolTextEl.style.transformBox = "view-box";
          node._symbolTextEl.style.transformOrigin = "0 0";
          node._symbolTextEl.setAttribute("transform", textXform);
        }
        // Attach keyboard delete listener
        _opDeleteHandler = (e) => {
          if (e.key === "Backspace" || e.key === "Delete" || e.key === "d" || e.key === "D") {
            e.preventDefault();
            deleteOperatorNode(nodeId, layout);
          }
        };
        document.addEventListener("keydown", _opDeleteHandler);
      });
      swapGroup.addEventListener("mouseleave", () => {
        swapGroup.querySelectorAll(".swap-btn").forEach(b => {
          b.style.opacity = "0"; b.style.pointerEvents = "none";
        });
        // Restore original transforms (counter-rotation for text)
        if (node._junctionEl) node._junctionEl.removeAttribute("transform");
        if (node._symbolTextEl) {
          node._symbolTextEl.style.transformBox = "";
          node._symbolTextEl.style.transformOrigin = "";
          if (_counterDeg !== 0) {
            node._symbolTextEl.setAttribute("transform", `rotate(${_counterDeg} ${px} ${py})`);
          } else {
            node._symbolTextEl.removeAttribute("transform");
          }
        }
        if (_opDeleteHandler) {
          document.removeEventListener("keydown", _opDeleteHandler);
          _opDeleteHandler = null;
        }
      });

      gInteract.appendChild(swapGroup);
    }

    // Draw children — darken→role-color gradient for all categories
    const childEntries = [];
    if (node.leftId != null) childEntries.push({ id: node.leftId, armCol: leftArmCol, label: leftLabel });
    if (node.rightId != null && node.rightId !== node.leftId)
      childEntries.push({ id: node.rightId, armCol: rightArmCol, label: rightLabel });

    for (const { id: childId, armCol, label } of childEntries) {
      const child = nodes[childId];
      if (!child || child.x == null) continue;

      if (child.type === "intermediate") {
        drawIntermediateNode(childId, px, py, darkenColor(armCol, 0.3), armCol, label);
      } else {
        const childRad = child.type === "value" ? R : JR;
        pipeToChild(px, py, child.x, child.y, darkenColor(armCol, 0.3), armCol, childRad, JR, undefined, label);
        drawNode(childId, px, py, false, armCol);
      }
    }
  }

  // ---- Draw y node: black glass fill with green ring ----
  drawCircle(yX, yY, R, GLASS_FILL, OP_COLORS.y, 2);
  const yTextEl = drawText(yX, yY, "y", 32, OP_COLORS.y, true);
  layout._yTextEl = yTextEl;  // ref for live value updates
  drawDebugLabel(yX, yY + R + 12, "y");

  // ---- Draw tree from root ----
  drawNode(rootOpId, yX, yY, true);

  // ==================================================================
  // ---- Dimmed third arrows on intermediate nodes -------------------
  // DISABLED: rings removed, so third-arm stubs are no longer shown.
  // ==================================================================

  // ==================================================================
  // ---- Equals marker: white ring + "=" pill on the equals pipe -----
  // ==================================================================
  {
    // Determine equals pipe endpoints
    const eq = state.equalsEdge;
    let eqFromX, eqFromY, eqToX, eqToY;
    if (!eq) {
      // Default: equals is on the Y→root pipe
      eqFromX = yX; eqFromY = yY;
      const root = nodes[rootOpId];
      eqToX = root.x; eqToY = root.y;
    } else {
      const fromN = eq.fromId === 'y' ? { x: yX, y: yY } : nodes[eq.fromId];
      const toN = eq.toId === 'y' ? { x: yX, y: yY } : nodes[eq.toId];
      if (fromN && toN) {
        eqFromX = fromN.x; eqFromY = fromN.y;
        eqToX = toN.x; eqToY = toN.y;
      }
    }

    if (eqFromX != null && eqToX != null) {
      const mx = (eqFromX + eqToX) / 2, my = (eqFromY + eqToY) / 2;
      const dx = eqToX - eqFromX, dy = eqToY - eqFromY;
      const dist = Math.hypot(dx, dy) || 1;
      const ux = dx / dist, uy = dy / dist;
      const nx = -uy, ny = ux; // perpendicular

      // Two opposing arrow triangles representing the equals sign: ▶◀
      const EQ_ALEN = 8;   // triangle length
      const EQ_AHW = 3.5; // triangle half-width at base
      const EQ_GAP = 2;   // gap between the two tips

      // Position equals marker at from-end or to-end of the pipe
      const atToEnd = eq && eq.atToEnd;
      const eqPosX = atToEnd ? (eqToX - CR * ux) : (eqFromX + CR * ux);
      const eqPosY = atToEnd ? (eqToY - CR * uy) : (eqFromY + CR * uy);

      // Both triangles together at this position, tips pointing at each other (▶◀)
      const triAx = eqPosX - EQ_GAP / 2 * ux, triAy = eqPosY - EQ_GAP / 2 * uy;
      const triBx = eqPosX + EQ_GAP / 2 * ux, triBy = eqPosY + EQ_GAP / 2 * uy;

      // Triangle A: tip pointing toward to-end (+u direction)
      const aBase_x = triAx - EQ_ALEN * ux, aBase_y = triAy - EQ_ALEN * uy;
      const triA = svgEl("polygon");
      triA.setAttribute("points", [
        `${triAx},${triAy}`,
        `${aBase_x + EQ_AHW * nx},${aBase_y + EQ_AHW * ny}`,
        `${aBase_x - EQ_AHW * nx},${aBase_y - EQ_AHW * ny}`
      ].join(" "));
      const eqFill = isDarkMode ? "white" : "black";
      triA.style.fill = "var(--text)";
      triA.setAttribute("opacity", 0.85);
      triA.classList.add("eq-tri", "eq-tri-a");
      gArrows.appendChild(triA);

      // Triangle B: tip pointing toward from-end (-u direction)
      const bBase_x = triBx + EQ_ALEN * ux, bBase_y = triBy + EQ_ALEN * uy;
      const triB = svgEl("polygon");
      triB.setAttribute("points", [
        `${triBx},${triBy}`,
        `${bBase_x + EQ_AHW * nx},${bBase_y + EQ_AHW * ny}`,
        `${bBase_x - EQ_AHW * nx},${bBase_y - EQ_AHW * ny}`
      ].join(" "));
      triB.style.fill = "var(--text)";
      triB.setAttribute("opacity", 0.85);
      triB.classList.add("eq-tri", "eq-tri-b");
      gArrows.appendChild(triB);

      // Visible grab circle at the equals marker — ring matches theme
      const grabR = EQ_ALEN + 4; // just big enough to enclose the double arrows
      const eqGrab = svgEl("circle");
      eqGrab.setAttribute("cx", eqPosX);
      eqGrab.setAttribute("cy", eqPosY);
      eqGrab.setAttribute("r", grabR);
      eqGrab.style.fill = isDarkMode ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)";
      eqGrab.style.stroke = isDarkMode ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.35)";
      eqGrab.setAttribute("stroke-width", "2");
      eqGrab.setAttribute("cursor", "grab");
      eqGrab.setAttribute("pointer-events", "all");
      eqGrab.classList.add("equals-grab");
      eqGrab.dataset.fromId = eq ? String(eq.fromId) : 'y';
      eqGrab.dataset.toId = eq ? String(eq.toId) : String(rootOpId);
      gInteract.appendChild(eqGrab);

      // ---- Hide normal arrow polygons that sit on the equals pipe ----
      svg.querySelectorAll('polygon:not(.eq-tri)').forEach(p => {
        const pts = p.getAttribute('points');
        if (!pts) return;
        const verts = pts.trim().split(/\s+/).map(v => v.split(',').map(Number));
        let sx = 0, sy = 0;
        for (const [vx, vy] of verts) { sx += vx; sy += vy; }
        const centX = sx / verts.length, centY = sy / verts.length;
        // Check if centroid is near the equals pipe midpoint
        if (Math.hypot(centX - mx, centY - my) < dist / 2 + 2) {
          p.setAttribute('opacity', '0');
          p.classList.add('eq-hidden');
        }
      });


    }
  }

  // ==================================================================
  // ---- Post-process: permanently rotate arrow triangles for equalsEdge ----
  // ==================================================================
  const eqEdge = state.equalsEdge;
  if (eqEdge && typeof eqEdge.fromId === 'number') {
    // Find path from root to equalsEdge.toId
    const eqPath = [];
    function findEqPath(nodeId, target) {
      if (nodeId == null) return false;
      const nd = nodes[nodeId];
      if (!nd) return false;
      if (nodeId === target) return true;
      if (nd.type === 'intermediate' && nd.connectsToOpId != null) {
        return findEqPath(nd.connectsToOpId, target);
      }
      if (nd.type !== 'op') return false;
      if (nd.leftId != null && findEqPath(nd.leftId, target)) {
        eqPath.push({ nodeId, armToChild: 'left' });
        return true;
      }
      if (nd.rightId != null && nd.rightId !== nd.leftId && findEqPath(nd.rightId, target)) {
        eqPath.push({ nodeId, armToChild: 'right' });
        return true;
      }
      return false;
    }
    findEqPath(rootOpId, eqEdge.toId);
    eqPath.reverse();

    // For each ring on the path, compute rotation and apply to arrow triangles
    for (const step of eqPath) {
      const nd = nodes[step.nodeId];
      if (!nd || nd.type !== 'op') continue;
      const cx = nd.x, cy = nd.y;

      // Output direction (toward parent or Y)
      let px, py;
      if (step.nodeId === rootOpId) {
        px = yX; py = yY;
      } else {
        for (let j = 0; j < nodes.length; j++) {
          const pn = nodes[j];
          if (pn && (pn.leftId === step.nodeId || pn.rightId === step.nodeId)) {
            px = pn.x; py = pn.y; break;
          }
          if (pn && pn.type === 'intermediate' && pn.connectsToOpId === step.nodeId) {
            px = pn.x; py = pn.y; break;
          }
        }
      }
      if (px == null) continue;
      const outAngle = Math.atan2(py - cy, px - cx);

      // Child direction (the arm equals exits through)
      const childId = step.armToChild === 'left' ? nd.leftId : nd.rightId;
      const child = nodes[childId];
      if (!child || child.x == null) continue;
      const childAngle = Math.atan2(child.y - cy, child.x - cx);

      let rotRad = childAngle - outAngle;
      if (rotRad > Math.PI) rotRad -= 2 * Math.PI;
      if (rotRad < -Math.PI) rotRad += 2 * Math.PI;
      const rotDeg = rotRad * 180 / Math.PI;
      const rotStr = `rotate(${rotDeg}, ${cx}, ${cy})`;

      // Find and rotate arrow triangles whose vertices are near this ring
      svg.querySelectorAll('polygon:not(.eq-tri)').forEach(p => {
        const pts = p.getAttribute('points');
        if (!pts) return;
        const verts = pts.trim().split(/\s+/).map(v => v.split(',').map(Number));
        for (const [vx, vy] of verts) {
          if (Math.hypot(vx - cx, vy - cy) < CR + 15) {
            p.setAttribute('transform', rotStr);
            break;
          }
        }
      });
    }

    // After rotating arrows, recalculate which polygons should be hidden.
    // Collect the centroids of actual eq-tri marker elements, then hide any
    // regular polygon whose visual (rotated) centroid overlaps a marker,
    // and UN-hide any previously-hidden polygon that has rotated away.
    const eqTriCentroids = [];
    svg.querySelectorAll('.eq-tri').forEach(tri => {
      const pts = tri.getAttribute('points');
      if (!pts) return;
      const verts = pts.trim().split(/\s+/).map(v => v.split(',').map(Number));
      let sx = 0, sy = 0;
      for (const [vx, vy] of verts) { sx += vx; sy += vy; }
      eqTriCentroids.push({ x: sx / verts.length, y: sy / verts.length });
    });
    const EQ_HIDE_R = 15;
    svg.querySelectorAll('polygon:not(.eq-tri)').forEach(p => {
      const pts = p.getAttribute('points');
      if (!pts) return;
      const verts = pts.trim().split(/\s+/).map(v => v.split(',').map(Number));
      let sx = 0, sy = 0;
      for (const [vx, vy] of verts) { sx += vx; sy += vy; }
      let cx2 = sx / verts.length, cy2 = sy / verts.length;
      // Account for rotation transform to get visual centroid
      const t = p.getAttribute('transform');
      if (t) {
        const m = t.match(/rotate\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/);
        if (m) {
          const deg = parseFloat(m[1]), rcx = parseFloat(m[2]), rcy = parseFloat(m[3]);
          const rad = deg * Math.PI / 180;
          const dx2 = cx2 - rcx, dy2 = cy2 - rcy;
          cx2 = rcx + dx2 * Math.cos(rad) - dy2 * Math.sin(rad);
          cy2 = rcy + dx2 * Math.sin(rad) + dy2 * Math.cos(rad);
        }
      }
      let nearTri = false;
      for (const tc of eqTriCentroids) {
        if (Math.hypot(cx2 - tc.x, cy2 - tc.y) < EQ_HIDE_R) {
          nearTri = true;
          break;
        }
      }
      if (nearTri) {
        p.setAttribute('opacity', '0');
        p.classList.add('eq-hidden');
      } else if (p.classList.contains('eq-hidden')) {
        p.removeAttribute('opacity');
        p.classList.remove('eq-hidden');
      }
    });
  }

  return svg;
}

/**
 * Generate subintermediate functions between prevStep and curStep.
 * These represent the "internal" substeps of an operation:
 *   add/sub by n  → substeps at ±1 increments
 *   mul by n      → substeps at prev*2, prev*3, …, prev*(n-1)
 *   div by n      → substeps at prev*(n-1)/n, …, prev*2/n
 *   power ^ n     → substeps at prev^2, prev^3, …, prev^(n-1)
 * Returns array of { fn, col } where col is the step colour.
 * Caps at 12 subintermediates to avoid flooding.
 */
function getSubintermediateFns(prevStepFn, op) {
  const subs = [];
  const operand = parseFloat(op.operand);
  const MAX_SUBS = 12;

  if (op.type === "add") {
    if (!Number.isFinite(operand)) return subs;
    const absN = Math.abs(operand);
    if (absN > 1) {
      const sign = operand > 0 ? 1 : -1;
      const isInt = absN === Math.round(absN);
      const top = isInt ? absN - 1 : Math.floor(absN);
      for (let k = 1; k <= Math.min(top, MAX_SUBS); k++) {
        const offset = k * sign;
        subs.push({ fn: (x) => prevStepFn(x) + offset, category: "addSub" });
      }
    }
  } else if (op.type === "sub") {
    if (!Number.isFinite(operand)) return subs;
    const absN = Math.abs(operand);
    if (absN > 1) {
      const sign = operand > 0 ? -1 : 1;
      const isInt = absN === Math.round(absN);
      const top = isInt ? absN - 1 : Math.floor(absN);
      for (let k = 1; k <= Math.min(top, MAX_SUBS); k++) {
        const offset = k * sign;
        subs.push({ fn: (x) => prevStepFn(x) + offset, category: "addSub" });
      }
    }
  } else if (op.type === "mul") {
    if (!Number.isFinite(operand)) return subs;
    const absN = Math.abs(operand);
    if (absN > 1) {
      const isInt = absN === Math.round(absN);
      const top = isInt ? absN - 1 : Math.floor(absN);
      for (let k = 1; k <= Math.min(top, MAX_SUBS); k++) {
        const mult = operand > 0 ? k : -k;
        subs.push({ fn: (x) => prevStepFn(x) * mult, category: "mulDiv" });
      }
    } else if (absN > 0 && absN < 1) {
      // Multiplying by a fraction ≡ dividing by the reciprocal
      const recip = 1 / absN;
      const sign = operand > 0 ? 1 : -1;
      const isRecipInt = Math.abs(recip - Math.round(recip)) < 1e-9;
      const count = isRecipInt ? Math.round(recip) - 2 : Math.floor(recip) - 1;
      for (let k = 1; k <= Math.min(count, MAX_SUBS); k++) {
        const frac = (recip - k) / recip;
        subs.push({ fn: (x) => prevStepFn(x) * frac * sign, category: "mulDiv" });
      }
    }
  } else if (op.type === "div") {
    if (!Number.isFinite(operand)) return subs;
    const absN = Math.abs(operand);
    // Evenly-spaced fractional milestones from prev toward prev/n
    if (absN > 1) {
      const sign = operand > 0 ? 1 : -1;
      const isInt = absN === Math.round(absN);
      const count = isInt ? Math.round(absN) - 2 : Math.floor(absN) - 1;
      for (let k = 1; k <= Math.min(count, MAX_SUBS); k++) {
        const frac = (absN - k) / absN;
        subs.push({ fn: (x) => prevStepFn(x) * frac * sign, category: "mulDiv" });
      }
    } else if (absN > 0 && absN < 1) {
      // Dividing by a fraction ≡ multiplying by the reciprocal
      const recip = 1 / absN;
      const isRecipInt = Math.abs(recip - Math.round(recip)) < 1e-9;
      const top = isRecipInt ? Math.round(recip) - 1 : Math.floor(recip);
      for (let k = 1; k <= Math.min(top, MAX_SUBS); k++) {
        const mult = operand > 0 ? k : -k;
        subs.push({ fn: (x) => prevStepFn(x) * mult, category: "mulDiv" });
      }
    }
  } else {
    // Check for power: ^ n
    const exp = getPowerExponent(op);
    if (exp !== null) {
      const n = parseFloat(exp);
      if (Number.isFinite(n) && n > 1) {
        const isInt = n === Math.round(n);

        if (n < 3) {
          // x^2, x^2.1, etc: "adding prev to itself" — show prev*k
          // Only visible at values of x where k is strictly between 1 and |prev|
          for (let k = 2; k <= MAX_SUBS + 1; k++) {
            const mult = k;
            subs.push({
              fn: (x) => {
                const p = prevStepFn(x);
                const result = p * mult;
                const target = Math.pow(p, n);
                // Only show when result is strictly between p and target
                const lo = Math.min(p, target), hi = Math.max(p, target);
                if (result > lo + 1e-9 && result < hi - 1e-9) return result;
                return NaN;
              }, category: "mulDiv"
            });
          }
        } else {
          // x^3, x^3.5, x^4, etc: successive prior powers
          // Show prev^2, prev^3, … (always valid decomposition steps, no gating)
          const top = isInt ? n - 1 : Math.floor(n);
          for (let k = 2; k <= Math.min(top, MAX_SUBS + 1); k++) {
            const pow = k;
            subs.push({ fn: (x) => Math.pow(prevStepFn(x), pow), category: "exp" });
          }
        }
      }
    }
  }

  // sin()/cos(): subintermediate showing ([input] % τ) / τ — reveals the periodic wrapping fraction
  const fnName = getFunctionName(op);
  if (fnName === "sin" || fnName === "cos") {
    const TAU = 2 * Math.PI;
    subs.push({
      fn: (x) => { const v = prevStepFn(x); return (((v % TAU) + TAU) % TAU) / TAU; },
      category: "trig"
    });
  }

  // mod ops: subintermediate showing [operand] % [input]
  const modVal = getModOperand(op);
  if (modVal !== null) {
    const modNum = parseFloat(modVal);
    if (Number.isFinite(modNum)) {
      subs.push({
        fn: (x) => { const v = prevStepFn(x); return v !== 0 ? ((modNum % v) + v) % v : NaN; },
        category: "mulDiv"
      });
    }
  }

  return subs;
}

function swapOp(op) {
  // Arithmetic swap
  const arithSwap = { add: "sub", sub: "add", mul: "div", div: "mul" };
  const newType = arithSwap[op.type];
  if (newType) {
    const labelPrefixes = { add: "+ ", sub: "− ", mul: "× ", div: "/ " };
    const opChars = { add: "+", sub: "-", mul: "*", div: "/" };
    const opChar = opChars[newType];
    return {
      type: newType,
      label: labelPrefixes[newType] + op.operand,
      operand: op.operand,
      applyToExpr: (prev) => "(" + prev + ")" + opChar + "(" + op.operand + ")",
    };
  }
  // Special label swaps
  if (op.label === "x²") {
    return {
      type: "other", label: "sqrt()", operand: null,
      applyToExpr: (prev) => "sqrt(" + prev + ")",
    };
  }
  // b^x swap: base-exponential to log_base
  const expBase = getExpBase(op);
  if (expBase !== null) {
    if (expBase === "10") return {
      type: "other", label: "log()", operand: null,
      applyToExpr: (prev) => "log(" + prev + ")",
    };
    return {
      type: "other",
      label: "log_" + expBase + "()",
      operand: expBase,
      applyToExpr: (prev) => "ln(" + prev + ")/ln(" + expBase + ")",
    };
  }
  // log_b swap: back to b^x
  const logBase = getLogBase(op);
  if (logBase !== null) {
    return {
      type: "other",
      label: logBase + "^x",
      operand: logBase,
      applyToExpr: (prev) => "(" + logBase + ")**(" + prev + ")",
    };
  }
  // Function swap (sin↔asin, cos↔acos, etc.)
  const fnName = getFunctionName(op);
  if (fnName && FUNC_INVERSES[fnName]) {
    const invName = FUNC_INVERSES[fnName];
    // Special cases that aren't simple function wraps
    if (invName === "x^2") {
      return {
        type: "other", label: "x²", operand: null,
        applyToExpr: (prev) => "(" + prev + ")**2",
      };
    }
    if (invName === "10^x") {
      return {
        type: "other", label: "10^x", operand: null,
        applyToExpr: (prev) => "10**(" + prev + ")",
      };
    }
    return {
      type: "other",
      label: invName + "()",
      operand: null,
      applyToExpr: (prev) => invName + "(" + prev + ")",
    };
  }
  // Power swap: ^ N ↔ ⁿ√ N (keep operand, change operation)
  const exp = getPowerExponent(op);
  if (exp !== null) {
    return {
      type: "other",
      label: "ⁿ√ " + exp,
      operand: exp,
      applyToExpr: (prev) => "(" + prev + ")**(1/(" + exp + "))",
    };
  }
  // Root swap: ⁿ√ N → ^ N
  const rootN = getRootN(op);
  if (rootN !== null) {
    return {
      type: "other",
      label: "^ " + rootN,
      operand: rootN,
      applyToExpr: (prev) => "(" + prev + ")**(" + rootN + ")",
    };
  }
  return null;
}

const FUNC_INVERSES = {
  sin: "asin", asin: "sin",
  cos: "acos", acos: "cos",
  tan: "atan", atan: "tan",
  sqrt: "x^2",
  ln: "exp", exp: "ln",
  log: "10^x",
};

function getFunctionName(op) {
  if (op.type !== "other") return null;
  const m = op.label.match(/^([a-zA-Z_]+)\(\)$/);
  if (!m) return null;
  if (/^log_.+$/.test(m[1])) return null;  // handled by getLogBase
  return m[1];
}

/**
 * Check if an op is a power/exponent step (label like "^ 3").
 * Returns the exponent string if so, null otherwise.
 */
function getPowerExponent(op) {
  if (op.type !== "other") return null;
  const m = op.label.match(/^\^\s*(.+)$/);
  return m ? m[1].trim() : null;
}

function getRootN(op) {
  if (op.type !== "other") return null;
  const m = op.label.match(/^ⁿ√\s*(.+)$/);
  return m ? m[1].trim() : null;
}

function getExpBase(op) {
  if (op.type !== "other") return null;
  const m = op.label.match(/^(.+)\^x$/);
  return m ? m[1].trim() : null;
}

function getLogBase(op) {
  if (op.type !== "other") return null;
  const m = op.label.match(/^log_(.+)\(\)$/);
  return m ? m[1].trim() : null;
}

function getModOperand(op) {
  if (op.type !== "other") return null;
  const m = op.label.match(/^%\s*(.+)$/);
  return m ? m[1].trim() : null;
}

function getInverseFunctionLabel(op) {
  if (op.label === "x²") return "sqrt()";
  const expBase = getExpBase(op);
  if (expBase !== null) {
    if (expBase === "10") return "log()";
    return "log_" + expBase + "()";
  }
  const logBase = getLogBase(op);
  if (logBase !== null) return logBase + "^x";
  const fnName = getFunctionName(op);
  if (fnName) {
    const inv = FUNC_INVERSES[fnName];
    if (inv === "x^2") return "x²";
    if (inv === "10^x") return "10^x";
    return inv ? inv + "()" : null;
  }
  const exp = getPowerExponent(op);
  if (exp !== null) return "ⁿ√ " + exp;
  const rootN = getRootN(op);
  if (rootN !== null) return "^ " + rootN;
  return null;
}

function applyOpsChange(relayout) {
  if (_swapInProgress) { return; }
  try {
    const steps = rebuildStepsFromOps(state.ops);
    state.steps = steps;
    state.fn = steps.length > 0 ? steps[steps.length - 1].fn : null;
    syncInputFromOps();
    if (relayout) {
      const expr = ui.exprEl?.value ?? "";
      if (expr.trim()) {
        try {
          const { pipeLayout } = parseAndLinearize(expr);
          if (pipeLayout != null) state.pipeLayout = pipeLayout;
        } catch (_) { }
      }
    }
    renderStepRepresentation();
    setStatusForCurrentMode();
    // Resize the expression input to fit updated content
    autoSizeInput();
    // Update LaTeX display
    updateLatexDisplay(ui.exprEl?.value ?? "");
  } catch (err) {
    setStatus(err?.message ?? String(err), "error");
  }
}

/**
 * Delete preview: temporarily show the graph as if an op were removed.
 * Saves real state so it can be restored on mouseleave.
 */
function enterDeletePreview(idx) {
  if (state._deletePreviewSaved) return; // already in preview
  // Save current state
  state._deletePreviewSaved = {
    fn: state.fn,
    steps: state.steps,
  };
  // Build preview ops without the target
  const previewOps = [...state.ops];
  previewOps.splice(idx, 1);
  try {
    const previewSteps = rebuildStepsFromOps(previewOps);
    state.steps = previewSteps;
    state.fn = previewSteps.length > 0 ? previewSteps[previewSteps.length - 1].fn : null;
  } catch {
    // On error, just keep current state
    state._deletePreviewSaved = null;
  }
}

function clearDeletePreview() {
  if (!state._deletePreviewSaved) return;
  state.fn = state._deletePreviewSaved.fn;
  state.steps = state._deletePreviewSaved.steps;
  state._deletePreviewSaved = null;
}

/**
 * Build a clean display expression from ops, with parallel color information.
 * Returns { text, spans } where spans is [{text, color, isBracket}].
 */
function buildDisplayExpr(ops) {
  const spans = [];
  const xColor = userColors.x;
  spans.push({ text: "x", color: xColor, isBracket: false });
  let prevPrec = 999; // x is a primary, highest precedence

  /** Break a complex operand into individually-coloured spans.
   *  Simple operands (plain numbers, single vars) keep the parent's opndColor;
   *  complex sub-expressions (e.g. "2*x") get recursively coloured. */
  function operandSpans(raw, opndColor) {
    if (!raw) return [{ text: "", color: opndColor, isBracket: false }];
    if (/^-?\d+(\.\d+)?$/.test(raw)) return [{ text: raw, color: opndColor, isBracket: false }];
    if (/^[a-zA-Z]$/.test(raw)) {
      return [{ text: raw, color: raw === "x" ? OP_COLORS.x : opndColor, isBracket: false }];
    }
    // Complex: use colorizeRawExpr and replace default-text numbers with opndColor
    const parts = colorizeRawExpr(raw);
    return parts.map(s => ({
      text: s.text,
      color: s.color === "var(--text)" ? opndColor : s.color,
      isBracket: false,
      opacity: s.opacity,
    }));
  }

  for (const op of ops) {
    const { fnColor, opndColor } = getOpArmColors(op);

    if (op.type === "add" || op.type === "sub") {
      const sym = op.type === "add" ? " + " : " - ";
      const operand = op.operand || "";
      spans.push({ text: sym, color: fnColor, isBracket: false });
      spans.push(...operandSpans(operand, opndColor));
      prevPrec = 1;
    } else if (op.type === "mul" || op.type === "div") {
      const sym = op.type === "mul" ? " * " : " / ";
      const operand = op.operand || "";
      if (prevPrec < 2) {
        spans.splice(0, 0, { text: "(", color: fnColor, isBracket: true });
        spans.push({ text: ")", color: fnColor, isBracket: true });
      }
      spans.push({ text: sym, color: fnColor, isBracket: false });
      // Wrap operand in parens if it has lower-precedence operators
      if (/[+\-]/.test(operand) && !/^\d/.test(operand)) {
        spans.push({ text: "(", color: fnColor, isBracket: true });
        spans.push(...operandSpans(operand, opndColor));
        spans.push({ text: ")", color: fnColor, isBracket: true });
      } else {
        spans.push(...operandSpans(operand, opndColor));
      }
      prevPrec = 2;
    } else {
      const fnName = getFunctionName(op);
      if (fnName) {
        spans.splice(0, 0, { text: fnName + "(", color: fnColor, isBracket: false });
        spans.push({ text: ")", color: fnColor, isBracket: false });
        prevPrec = 999;
      } else if (op.label === "x²") {
        if (prevPrec < 3) {
          spans.splice(0, 0, { text: "(", color: fnColor, isBracket: true });
          spans.push({ text: ")", color: fnColor, isBracket: true });
        }
        spans.push({ text: "^", color: fnColor, isBracket: false });
        spans.push({ text: "2", color: opndColor, isBracket: false });
        prevPrec = 3;
      } else if (getExpBase(op) !== null) {
        const base = op.operand || getExpBase(op);
        spans.splice(0, 0, ...operandSpans(base, opndColor),
          { text: "^(", color: fnColor, isBracket: false });
        spans.push({ text: ")", color: fnColor, isBracket: false });
        prevPrec = 999;
      } else if (getLogBase(op) !== null) {
        const base = op.operand || getLogBase(op);
        spans.splice(0, 0, { text: "log_", color: fnColor, isBracket: false },
          ...operandSpans(base, opndColor),
          { text: "(", color: fnColor, isBracket: false });
        spans.push({ text: ")", color: fnColor, isBracket: false });
        prevPrec = 999;
      } else if (op.label === "^ −1" || op.label === "^ -1") {
        if (prevPrec < 3) {
          spans.splice(0, 0, { text: "(", color: fnColor, isBracket: true });
          spans.push({ text: ")", color: fnColor, isBracket: true });
        }
        spans.push({ text: "^(-1)", color: fnColor, isBracket: false });
        prevPrec = 3;
      } else if (getPowerExponent(op) !== null) {
        const expStr = op.operand || getPowerExponent(op);
        if (prevPrec < 3) {
          spans.splice(0, 0, { text: "(", color: fnColor, isBracket: true });
          spans.push({ text: ")", color: fnColor, isBracket: true });
        }
        spans.push({ text: "^", color: fnColor, isBracket: false });
        spans.push(...operandSpans(expStr, opndColor));
        prevPrec = 3;
      } else if (getRootN(op) !== null) {
        const rootN = op.operand || getRootN(op);
        if (prevPrec < 3) {
          spans.splice(0, 0, { text: "(", color: fnColor, isBracket: true });
          spans.push({ text: ")", color: fnColor, isBracket: true });
        }
        spans.push({ text: "^(1/", color: fnColor, isBracket: false });
        spans.push(...operandSpans(rootN, opndColor));
        spans.push({ text: ")", color: fnColor, isBracket: false });
        prevPrec = 3;
      } else if (getModOperand(op) !== null) {
        const modVal = op.operand || getModOperand(op);
        if (prevPrec < 2) {
          spans.splice(0, 0, { text: "(", color: fnColor, isBracket: true });
          spans.push({ text: ")", color: fnColor, isBracket: true });
        }
        spans.push({ text: " % ", color: fnColor, isBracket: false });
        spans.push(...operandSpans(modVal, opndColor));
        prevPrec = 2;
      } else {
        spans.push({ text: op.label, color: fnColor, isBracket: false });
        prevPrec = 0;
      }
    }
  }

  const text = spans.map(s => s.text).join('');
  return { text, spans };
}

/**
 * Reconstruct a human-readable expression from state.ops
 * and update the text input to match.
 */
function syncInputFromOps() {
  if (!ui.exprEl || !state.ops.length) return;
  const { text, spans } = buildDisplayExpr(state.ops);
  ui.exprEl.value = text;
  state.lastExpr = text;
  state.displaySpans = spans;
  updateInputOverlay();
}

/**
 * Build a colored overlay that shows each part of the expression
 * colored by its corresponding step type.
 * For live mode: colors the raw input text by tokenizing it.
 */
function updateInputOverlay() {
  if (!ui.exprOverlay || !ui.exprEl) return;
  const controlEl = ui.exprEl.closest('.control--expr');
  const isEqActive = !!state.equalsEdge;
  // Toggle eq-active class for equalsEdge state (removes y= indent on input)
  if (controlEl) controlEl.classList.toggle('eq-active', isEqActive);
  const text = ui.exprEl.value;

  // "y = " prefix HTML — rendered inside the overlay so it's part of the expression display
  const _eqCol = document.body.classList.contains('light') ? 'black' : 'white';
  const yEqHtml = '<span style="color:' + OP_COLORS.y + '">y</span>'
    + '<span style="color:' + _eqCol + '"> = </span>';

  if (!text) {
    // Even when empty, show "y = " in the overlay (unless eq-active)
    ui.exprOverlay.innerHTML = isEqActive ? '' : yEqHtml;
    if (controlEl) controlEl.classList.toggle('has-overlay', !isEqActive && !!ui.exprOverlay.innerHTML);
    return;
  }

  // If we have pre-built spans from buildDisplayExpr (after Enter/plotFunction), use them
  if (state.displaySpans && state.displaySpans.length) {
    const spanText = state.displaySpans.map(s => s.text).join('');
    // When equalsEdge is active, always use displaySpans (input has RHS only, spans have LHS = RHS)
    if (spanText === text || isEqActive) {
      const spansHtml = state.displaySpans
        .map(s => {
          const opacity = s.isBracket ? 0.35 : (s.opacity || 1);
          return '<span style="color:' + s.color + ';opacity:' + opacity + '">' + escapeHtml(s.text) + '</span>';
        })
        .join('');
      // Prepend "y = " only in normal mode (eq-active displaySpans already contain y)
      ui.exprOverlay.innerHTML = isEqActive ? spansHtml : yEqHtml + spansHtml;
      if (controlEl) controlEl.classList.add('has-overlay');
      return;
    }
  }

  // Live coloring: prefer pipe-layout-aware spans when available
  let spans;
  if (state.pipeLayout && state.pipeLayout.nodes && state.pipeLayout.mainPath) {
    spans = pipeLayoutToColoredSpans(state.pipeLayout);
    // Verify span text matches the actual input — fall back if mismatch
    if (spans && spans.length > 0) {
      const spanText = spans.map(s => s.text).join('');
      if (spanText !== text) spans = null;
    }
  }
  if (!spans || spans.length === 0) {
    spans = colorizeRawExpr(text);
  }
  if (spans.length > 0) {
    const spansHtml = spans
      .map(s => '<span style="color:' + s.color + (s.opacity ? ';opacity:' + s.opacity : '') + '">' + escapeHtml(s.text) + '</span>')
      .join('');
    ui.exprOverlay.innerHTML = yEqHtml + spansHtml;
    if (controlEl) controlEl.classList.add('has-overlay');
  } else {
    ui.exprOverlay.innerHTML = yEqHtml;
    if (controlEl) controlEl.classList.toggle('has-overlay', !!ui.exprOverlay.innerHTML);
  }
  // Re-measure input width now that overlay content has changed (may shrink)
  autoSizeInput();
}

/** Tokenize raw input text and assign colors based on token type */
function colorizeRawExpr(text) {
  const spans = [];
  const funcNames = new Set(["sin", "cos", "tan", "asin", "acos", "atan", "sqrt", "abs", "ln", "log", "exp", "floor", "ceil", "round", "mod"]);
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      let j = i; while (j < text.length && /\s/.test(text[j])) j++;
      spans.push({ text: text.slice(i, j), color: "var(--muted)" });
      i = j;
    } else if (text[i] === 'x' && (i + 1 >= text.length || !/[a-zA-Z0-9_]/.test(text[i + 1])) && (i === 0 || !/[a-zA-Z0-9_]/.test(text[i - 1]))) {
      spans.push({ text: "x", color: OP_COLORS.x });
      i++;
    } else if (/[a-zA-Z_]/.test(text[i])) {
      let j = i; while (j < text.length && /[a-zA-Z0-9_]/.test(text[j])) j++;
      const word = text.slice(i, j);
      if (funcNames.has(word)) {
        const isTrig = TRIG_FNS.has(word);
        const isExp = EXP_FNS.has(word) || word === "sqrt";
        const isMod = word === "mod";
        const col = isMod ? OP_COLORS.mulDiv : isTrig ? OP_COLORS.trig : isExp ? OP_COLORS.exp : OP_COLORS.misc;
        spans.push({ text: word, color: col });
      } else if (word.startsWith("log_") && word.length > 4) {
        // log_base notation → split into "log_" (exp color) and base part
        const basePart = word.slice(4);
        spans.push({ text: "log_", color: OP_COLORS.exp });
        if (basePart === "x") {
          spans.push({ text: basePart, color: OP_COLORS.x });
        } else {
          spans.push({ text: basePart, color: OP_COLORS.exp });
        }
      } else if (word.startsWith("nthrt_") && word.length > 6) {
        // nthrt_n notation → split into "nthrt_" (exp color) and index part
        const idxPart = word.slice(6);
        spans.push({ text: "nthrt_", color: OP_COLORS.exp });
        if (idxPart === "x") {
          spans.push({ text: idxPart, color: OP_COLORS.x });
        } else {
          spans.push({ text: idxPart, color: OP_COLORS.exp });
        }
      } else if (word === "pi" || word === "e") {
        spans.push({ text: word, color: OP_COLORS.misc });
      } else {
        spans.push({ text: word, color: "var(--muted)" });
      }
      i = j;
    } else if (/[0-9.]/.test(text[i])) {
      let j = i; while (j < text.length && /[0-9.]/.test(text[j])) j++;
      // Color operands based on adjacent operator
      spans.push({ text: text.slice(i, j), color: "var(--text)" });
      i = j;
    } else if (text[i] === '+' || text[i] === '-') {
      spans.push({ text: text[i], color: OP_COLORS.addSub });
      i++;
    } else if (text[i] === '*' || text[i] === '/' || text[i] === '%') {
      spans.push({ text: text[i], color: OP_COLORS.mulDiv });
      i++;
    } else if (text[i] === '^') {
      spans.push({ text: text[i], color: OP_COLORS.exp });
      i++;
    } else if (text[i] === '(' || text[i] === ')') {
      spans.push({ text: text[i], color: "var(--muted)", opacity: 0.5 });
      i++;
    } else {
      spans.push({ text: text[i], color: "var(--muted)" });
      i++;
    }
  }
  return spans;
}

function getStepColorHex(typeOrKey) {
  return OP_COLORS[typeOrKey] || OP_COLORS[resolveTypeToCategory(typeOrKey)] || OP_COLORS.misc;
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function getOpSymbol(step) {
  switch (step.type) {
    case "add": return "+";
    case "sub": return "−";
    case "mul": return "×";
    case "div": return "÷";
    default: return null;
  }
}

function getInverseOpSymbol(step) {
  switch (step.type) {
    case "add": return "−";
    case "sub": return "+";
    case "mul": return "÷";
    case "div": return "×";
    default: return null;
  }
}

function getOpValue(step) {
  if (step.type === "add" || step.type === "sub") {
    return step.label.replace(/^[+−]\s*/, "");
  }
  if (step.type === "mul" || step.type === "div") {
    return step.label.replace(/^[×÷/]\s*/, "");
  }
  return null;
}

function getInverseType(type) {
  if (type === "add") return "sub";
  if (type === "sub") return "add";
  if (type === "mul") return "div";
  if (type === "div") return "mul";
  return type;
}

function getColorKeyForOp(op) {
  return getOpCategory(op);
}

/* ======= Pipe diagram helpers ======= */

/** Single source of truth: scroll direction for changing operand/numeric value. Returns +1 to increase, -1 to decrease. Scroll down = bigger. */
function getOperandScrollDir(e) {
  return e.deltaY > 0 ? 1 : -1;
}

/** Return the operand value for an op (shown as a badge above the junction), or null. */
function getOperandForPipe(op) {
  if (op.type === "add" || op.type === "sub" || op.type === "mul" || op.type === "div") {
    return op.operand || getOpValue(op) || null;
  }
  if (op.label === "x\u00B2") return "2";
  const exp = getPowerExponent(op); if (exp !== null) return exp;
  const rootN = getRootN(op); if (rootN !== null) return rootN;
  const expBase = getExpBase(op); if (expBase !== null) return expBase;
  const logBase = getLogBase(op); if (logBase !== null) return logBase;
  const modVal = getModOperand(op); if (modVal !== null) return modVal;
  // Functions like sin, cos, etc. — no external operand
  return null;
}

/** Return the symbol to display at the centre of an operator junction. */
function getPipeSymbol(op) {
  if (!op) return "?";
  if (op.type === "add") return "+";
  if (op.type === "sub") return "\u2212";
  if (op.type === "mul") return "\u00d7";
  if (op.type === "div") return "\u00f7";
  const expSt = getExpFamilyState(op);
  if (expSt >= 0) {
    if (expSt === 0) return "^";
    if (expSt === 1) return "log";
    return "\u221a";
  }
  if (op.label === "x\u00B2" || getPowerExponent(op) !== null) return "^";
  if (getRootN(op) !== null) return "\u221a";
  if (getExpBase(op) !== null) return "b\u02e3";
  if (getLogBase(op) !== null) return "log";
  if (getModOperand(op) !== null) return "%";
  if (op.label === "^ \u22121" || op.label === "^ -1") return "^\u207b\u00b9";
  const fn = getFunctionName(op);
  if (fn) return fn;
  return op.label || "?";
}

/* ======= Exp-family rotation helpers ======= */

/**
 * Determine whether an op is in the power/log/root trio.
 * Returns 0 = power, 1 = log, 2 = root, or -1 if not in the family.
 */
function getExpFamilyState(op) {
  if (!op) return -1;
  if (op.label === "x\u00B2" || getPowerExponent(op) !== null) return 0; // power
  if (getLogBase(op) !== null) return 1; // log
  if (getRootN(op) !== null) return 2;   // root
  return -1;
}

/** Extract the shared operand N from a power/log/root op. */
function getExpFamilyOperand(op) {
  if (op.label === "x\u00B2") return "2";
  return getPowerExponent(op) || getLogBase(op) || getRootN(op) || null;
}

/**
 * Mutate op to the given state (0=power, 1=log, 2=root)
 * keeping the same operand N.  Updates label, operand, and applyToExpr.
 */
function setExpFamilyState(op, newState, operand) {
  switch (newState) {
    case 0: // power: input^N
      op.label = operand === "2" ? "x\u00B2" : "^ " + operand;
      op.operand = operand;
      op.applyToExpr = (prev) => "(" + prev + ")**(" + operand + ")";
      break;
    case 1: // log: log_N(input)
      op.label = "log_" + operand + "()";
      op.operand = operand;
      if (operand === "10") {
        op.applyToExpr = (prev) => "log(" + prev + ")";
      } else {
        op.applyToExpr = (prev) => "ln(" + prev + ")/ln(" + operand + ")";
      }
      break;
    case 2: // root: input^(1/N) = N-th root
      op.label = "\u207F\u221A " + operand;
      op.operand = operand;
      op.applyToExpr = (prev) => "(" + prev + ")**(1/(" + operand + "))";
      break;
  }
}

/** Is this op in the exp family and eligible for rotation? */
function isExpRotatable(op) {
  return getExpFamilyState(op) >= 0;
}

/**
 * Determine the rotation family for any op.
 * Returns { family, states, curState } or null.
 *   family: "exp" | "addSub" | "mulDiv"
 *   states: number of states in the cycle
 *   curState: current state index
 */
function getRotationInfo(op) {
  if (!op) return null;
  const expSt = getExpFamilyState(op);
  if (expSt >= 0) return { family: "exp", states: 3, curState: expSt };
  if (op.type === "add") return { family: "addSub", states: 2, curState: 0 };
  if (op.type === "sub") return { family: "addSub", states: 2, curState: 1 };
  if (op.type === "mul") return { family: "mulDiv", states: 2, curState: 0 };
  if (op.type === "div") return { family: "mulDiv", states: 2, curState: 1 };
  return null;
}

/** Is this op rotatable (any family)? */
function isRotatable(op) {
  return getRotationInfo(op) !== null;
}

/**
 * Mutate an add/sub or mul/div op to the given state.
 * add/sub: 0=add, 1=sub.  mul/div: 0=mul, 1=div.
 */
function setArithState(op, newState) {
  const labelPrefixes = { add: "+ ", sub: "\u2212 ", mul: "\u00d7 ", div: "\u00f7 " };
  const opChars = { add: "+", sub: "-", mul: "*", div: "/" };
  let newType;
  if (op.type === "add" || op.type === "sub") {
    newType = newState === 0 ? "add" : "sub";
  } else {
    newType = newState === 0 ? "mul" : "div";
  }
  const opChar = opChars[newType];
  op.type = newType;
  op.label = labelPrefixes[newType] + op.operand;
  op.applyToExpr = (prev) => "(" + prev + ")" + opChar + "(" + op.operand + ")";
}

/**
 * Rotate any op by dir (+1 = CW, -1 = CCW).
 * Mutates the op in place.
 */
function rotateOp(op, dir) {
  const info = getRotationInfo(op);
  if (!info) return;
  const newState = ((info.curState + dir) % info.states + info.states) % info.states;
  if (info.family === "exp") {
    setExpFamilyState(op, newState, getExpFamilyOperand(op));
  } else {
    setArithState(op, newState);
  }
}

/**
 * Render the operations sequence as an SVG pipe diagram.
 *
 * Layout:
 *   - Operators at 3-way (or 2-way) junctions with coloured junction arms.
 *   - Value badges (x, intermediates, y) in the lower row; connector pipes (hex lattice)
 *     link each value badge to its junction arm. Operand badges above operators, linked by arm + pipe.
 *   - No hex outlines on value/operand badges; valve handwheels and operator circles only.
 */
function renderPipeDiagram(ops, layout, showIntermediates) {
  if (showIntermediates === undefined) showIntermediates = true;
  const safeOps = Array.isArray(ops) ? ops : [];
  const NS = "http://www.w3.org/2000/svg";
  const svgEl = (tag) => document.createElementNS(NS, tag);
  const useBranchedLayout = layout && layout.branches && layout.branches.length > 0;

  function hexToRgba(hex, alpha) {
    const h = hex.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  /** Composite colour over page background for an opaque fill */
  function blendFill(hex, alpha) {
    const h = hex.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    const dark = document.body.classList.contains('dark-mode');
    const bg = dark ? { r: 28, g: 30, b: 46 } : { r: 247, g: 247, b: 249 };
    const mr = Math.round(r * alpha + bg.r * (1 - alpha));
    const mg = Math.round(g * alpha + bg.g * (1 - alpha));
    const mb = Math.round(b * alpha + bg.b * (1 - alpha));
    return `rgb(${mr},${mg},${mb})`;
  }

  /** Mix colour toward near-black — always produces a dark tinted result */
  function darkFill(hex, t) {
    const h = hex.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    const base = { r: 20, g: 22, b: 34 };
    const mr = Math.round(r * t + base.r * (1 - t));
    const mg = Math.round(g * t + base.g * (1 - t));
    const mb = Math.round(b * t + base.b * (1 - t));
    return `rgb(${mr},${mg},${mb})`;
  }

  /* ---- layout constants ---- */

  /** Convert vertical touch-drag into synthetic WheelEvents on a hit circle.
   *  Reuses existing wheel handlers unchanged.  Threshold in px per tick. */
  function addTouchScroll(hitEl, threshold) {
    if (threshold == null) threshold = 30;
    let startY = null;
    let accum = 0;
    hitEl.addEventListener("touchstart", (e) => {
      e.preventDefault();
      startY = e.touches[0].clientY;
      accum = 0;
    }, { passive: false });
    hitEl.addEventListener("touchmove", (e) => {
      if (startY == null) return;
      e.preventDefault();
      const dy = startY - e.touches[0].clientY;
      startY = e.touches[0].clientY;
      accum += dy;
      while (Math.abs(accum) >= threshold) {
        const sign = accum > 0 ? -1 : 1; // finger-up → negative deltaY (scroll up)
        accum -= (accum > 0 ? 1 : -1) * threshold;
        const synth = new WheelEvent("wheel", {
          deltaY: sign * 100,
          bubbles: false,
          cancelable: true,
          clientX: e.touches[0].clientX,
          clientY: e.touches[0].clientY
        });
        hitEl.dispatchEvent(synth);
      }
    }, { passive: false });
    hitEl.addEventListener("touchend", () => { startY = null; });
    hitEl.addEventListener("touchcancel", () => { startY = null; });
  }

  const R = 33;    // large badge radius (x, y, operands)
  const JR = 16;    // small badge radius (operators)
  const IR = 20;    // intermediate value badge radius
  const DOT_R = 3;     // small filled circles at spoke ends
  const RING_W = 1.5;   // ring stroke width
  const SPOKE_W = 2;     // spoke stroke width
  const PW = 12;    // pipe stroke width
  const GAP = 60;    // horizontal spacing (fallback for 0-ops)
  const PAD = 14;    // SVG padding
  const GREY = "#888";

  const S60 = Math.sin(Math.PI / 3);  // √3/2 ≈ 0.866
  const C60 = Math.cos(Math.PI / 3);  // 0.5

  /* ---- Circles of radius ARM: operator junction circle and imaginary value circles just touch (distance 2*ARM) ---- */
  const HEX_R = 44;
  const ARM = HEX_R;   // junction circle radius; value "circles" same radius, touching
  const HEX_STEP = 2 * ARM * Math.sqrt(3);  // so op-to-value distance = 2*ARM (horizontal STEP/2, vertical ARM)

  const VALUE_FONT_BASE = 26;
  const VALUE_BADGE_FONT_PREFERRED = Math.round(R * 1.2);

  /* ---- vertical positions ---- */
  let hasOperand, pipeY, operandCY, lowY, branchValueY, branchOpY, subBranchOpY, subBranchValueY, branchIntermediateY;
  // For alternating layout: odd ops are flipped with branches going down
  let oddOpY, oddBranchIntY, oddBranchOpY, oddBranchValueY, oddSubBranchOpY, oddSubBranchValueY;
  let hasSubBranch = false;
  if (useBranchedLayout) {
    const { nodes: _n, branches: _b } = layout;
    for (const br of _b) {
      if ((_n[br.inputLeftId] && _n[br.inputLeftId].type === "op") ||
        (_n[br.inputRightId] && _n[br.inputRightId].type === "op")) {
        hasSubBranch = true; break;
      }
    }
    const extraArms = hasSubBranch ? 3 : 0;
    pipeY = PAD + (6 + extraArms) * ARM + R;
    // Even ops at pipeY (standard, T arm up) — branches above
    branchIntermediateY = pipeY - 2 * ARM;
    branchOpY = pipeY - 4 * ARM;
    branchValueY = branchOpY - ARM;
    subBranchOpY = branchValueY - ARM;
    subBranchValueY = subBranchOpY - ARM;
    operandCY = pipeY - 2 * ARM;
    // Compact mode: junction circles touch — no grey connectors. Center-to-center = 2*ARM along pipe.
    const compactV = showIntermediates ? 0 : ARM;   // vertical gap even→odd = ARM so arm tips meet
    const compactBranchV = showIntermediates ? 0 : 2 * ARM;  // branch feed tip meets main T tip
    oddOpY = pipeY + 2 * ARM - compactV;
    oddBranchIntY = oddOpY + 2 * ARM;
    oddBranchOpY = oddOpY + 4 * ARM - compactBranchV;
    oddBranchValueY = oddBranchOpY + ARM;
    oddSubBranchOpY = oddBranchValueY + ARM;
    oddSubBranchValueY = oddSubBranchOpY + ARM;
    if (!showIntermediates) {
      branchOpY = branchOpY + compactBranchV;
      branchValueY = branchOpY - ARM;
      subBranchOpY = branchValueY - ARM;
      subBranchValueY = subBranchOpY - ARM;
    }
    lowY = pipeY + ARM;
    hasOperand = false;
  } else {
    hasOperand = safeOps.some(op => getOperandForPipe(op) !== null);
    pipeY = hasOperand ? PAD + 2 * ARM + R : PAD + HEX_R;
    operandCY = hasOperand ? pipeY - 2 * ARM : 0;
    lowY = pipeY + ARM;
    branchValueY = branchOpY = subBranchOpY = subBranchValueY = branchIntermediateY = 0;
    oddOpY = oddBranchIntY = oddBranchOpY = oddBranchValueY = oddSubBranchOpY = oddSubBranchValueY = 0;
  }

  const pipeItems = [];
  let firstValCX;

  if (useBranchedLayout) {
    const { nodes, mainPath, branches } = layout;
    const mainOpIdsOrdered = mainPath.opIds.slice().reverse();
    const n = mainOpIdsOrdered.length;
    firstValCX = PAD + HEX_R * S60 + (hasSubBranch ? 2 * ARM * Math.sqrt(3) : 0);
    const opColor = (node) => userColors[getColorKeyForOp({ type: node.opType })] || OP_COLORS.misc;

    function valueFontSizeForRadius(preferred, label, r) {
      const len = Math.max(1, (label || "").length);
      return Math.min(preferred, Math.max(8, Math.floor((2 * r * 0.9) / (0.6 * len))));
    }
    const _sup = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
    function getNodeLabel(id) {
      const nd = nodes[id];
      if (!nd) return "?";
      if (nd.type === "value") return nd.value;
      if (nd.type === "op" && nd.ast) {
        if (nd.opType === "power" && nd.ast.left && nd.ast.left.type === "var"
          && nd.ast.right && nd.ast.right.type === "num") {
          return "x" + String(nd.ast.right.value).split("").map(c => _sup[c] || c).join("");
        }
        return exprString(nd.ast).replace(/\*\*/g, "^");
      }
      return "?";
    }

    // Which display indices have branches (and which have sub-branch inputs)
    const branchedSet = new Set();
    const branchHasSubRight = new Map();
    const branchHasSubLeft = new Map();
    for (const br of branches) {
      const di = n - 1 - br.feedsIntoMainOpIndex;
      branchedSet.add(di);
      if (nodes[br.inputRightId] && nodes[br.inputRightId].type === "op") branchHasSubRight.set(di, br);
      if (nodes[br.inputLeftId] && nodes[br.inputLeftId].type === "op") branchHasSubLeft.set(di, br);
    }

    const SQRT3 = Math.sqrt(3);
    const VAL_Y = pipeY + ARM;
    const opGap = showIntermediates ? HEX_STEP : ARM * SQRT3;
    const opCXArr = [];
    opCXArr[0] = firstValCX + ARM * SQRT3;
    for (let i = 1; i < n; i++) {
      opCXArr[i] = opCXArr[i - 1] + opGap;
    }
    const valCXArr = [firstValCX];
    for (let i = 0; i < n; i++) {
      if (i < n - 1) valCXArr.push((opCXArr[i] + opCXArr[i + 1]) / 2);
    }
    valCXArr.push(opCXArr[n - 1] + ARM * SQRT3);

    pipeItems.push({ cx: valCXArr[0], cy: VAL_Y, r: R, label: "x", color: OP_COLORS.x, italic: true, operand: null, fontSize: VALUE_BADGE_FONT_PREFERRED });
    for (let i = 0; i < n; i++) {
      const isFlipped = (i % 2 === 1);
      const opY = isFlipped ? oddOpY : pipeY;
      const opNode = nodes[mainOpIdsOrdered[i]];
      const branchForThisOp = branches.find((b) => b.feedsIntoMainOpIndex === n - 1 - i);
      const stepOp = (safeOps && i < safeOps.length) ? safeOps[i] : null;
      const bIntY = isFlipped ? oddBranchIntY : branchIntermediateY;
      const it = {
        cx: opCXArr[i], cy: opY, r: JR,
        label: stepOp ? getPipeSymbol(stepOp) : opNode.symbol,
        color: stepOp ? (userColors[getColorKeyForOp(stepOp)] || OP_COLORS.misc) : opColor(opNode),
        italic: false,
        operand: branchForThisOp ? null : (stepOp ? getOperandForPipe(stepOp) : (opNode.operand || null)),
        fontSize: 16,
        op: stepOp, layoutOpNode: opNode,
        isFlipped,
        branchFeed: branchForThisOp ? { cx: opCXArr[i], cy: bIntY } : null,
      };
      pipeItems.push(it);
      if (i < n - 1) {
        pipeItems.push({ cx: valCXArr[i + 1], cy: VAL_Y, r: R, label: "?", color: opColor(opNode), italic: false, operand: null, fontSize: 32, isIntermediate: true });
      }
    }
    pipeItems.push({ cx: valCXArr[n], cy: VAL_Y, r: R, label: "y", color: OP_COLORS.y, italic: true, operand: null, fontSize: VALUE_BADGE_FONT_PREFERRED });

    for (const br of branches) {
      const di = n - 1 - br.feedsIntoMainOpIndex;
      const isFlipped = (di % 2 === 1);
      const branchOpCX = opCXArr[di];
      const branchOpNode = nodes[br.opId];
      const col = opColor(branchOpNode);
      const branchLeftCX = branchOpCX - ARM * Math.sqrt(3);
      const branchRightCX = branchOpCX + ARM * Math.sqrt(3);
      const leftAstNum = branchOpNode.ast && branchOpNode.ast.left && branchOpNode.ast.left.type === "num" ? branchOpNode.ast.left : null;
      // Y levels depend on whether the main-path op is even (up) or odd (down)
      const bOpY = isFlipped ? oddBranchOpY : branchOpY;
      const bIntY = isFlipped ? oddBranchIntY : branchIntermediateY;
      const bValY = isFlipped ? oddBranchValueY : branchValueY;
      const sbOpY = isFlipped ? oddSubBranchOpY : subBranchOpY;

      // Branch op junction
      pipeItems.push({ cx: branchOpCX, cy: bOpY, r: JR, label: branchOpNode.symbol, color: col, italic: false, operand: branchOpNode.operand || null, fontSize: 16, isBranchOp: true, isFlipped, layoutOpNode: branchOpNode, branchInputLeftId: br.inputLeftId, branchInputRightId: br.inputRightId, feedsIntoMainOpIndex: br.feedsIntoMainOpIndex });

      // Intermediate "?" between branch op and main-path op
      pipeItems.push({ cx: branchOpCX, cy: bIntY, r: R, label: "?", color: col, italic: false, operand: null, fontSize: 32, isIntermediate: true, isBranchIntermediate: true });

      function findNumNode(ast) {
        if (!ast) return null;
        if (ast.type === "num") return ast;
        if (ast.type === "call") return findNumNode(ast.arg);
        if (ast.type === "binary") return findNumNode(ast.right);
        return null;
      }

      // Helper: push a sub-branch (op junction + intermediate ? + two values) or a simple value
      function pushBranchInput(nd, badgeCX, isLeft) {
        if (nd && nd.type === "op") {
          const subCol = opColor(nd);
          // Sub-branch positioned along the 30° line from the branch arm through the value badge.
          // The junction is ROTATED so its feed arm points directly at the value badge —
          // no kinks anywhere except at junction centers.
          const sideSign = isLeft ? -1 : 1;
          const sbCX = badgeCX + sideSign * ARM * SQRT3;
          // Feed direction (unit vector from sub-branch center toward value badge)
          const fdx = badgeCX - sbCX, fdy = bValY - sbOpY;
          const fdist = Math.sqrt(fdx * fdx + fdy * fdy);
          const fnx = fdx / fdist, fny = fdy / fdist;
          // Input arm directions: rotate feed direction by ±120°
          const cos120 = -0.5, sin120 = SQRT3 / 2;
          const a1nx = fnx * cos120 - fny * sin120, a1ny = fnx * sin120 + fny * cos120;
          const a2nx = fnx * cos120 + fny * sin120, a2ny = -fnx * sin120 + fny * cos120;
          // Value badge positions along each input arm direction (ARM*√3 from center)
          const val1X = sbCX + ARM * SQRT3 * a1nx, val1Y = sbOpY + ARM * SQRT3 * a1ny;
          const val2X = sbCX + ARM * SQRT3 * a2nx, val2Y = sbOpY + ARM * SQRT3 * a2ny;
          pipeItems.push({ cx: badgeCX, cy: bValY, r: R, label: "?", color: subCol, italic: false, operand: null, fontSize: 32, isIntermediate: true, isBranchValue: true });
          pipeItems.push({
            cx: sbCX, cy: sbOpY, r: JR, label: nd.symbol, color: subCol, italic: false, operand: null, fontSize: 16, isSubBranchOp: true, subBranchNode: nd, isFlipped, parentValCX: badgeCX, parentValCY: bValY,
            subBranchKey: "sub-" + br.feedsIntoMainOpIndex + (isLeft ? "-L" : "-R"),
            sbArms: {
              feed: { x: sbCX + ARM * fnx, y: sbOpY + ARM * fny },
              left: { x: sbCX + ARM * a1nx, y: sbOpY + ARM * a1ny },
              right: { x: sbCX + ARM * a2nx, y: sbOpY + ARM * a2ny },
              leftVal: { x: val1X, y: val1Y },
              rightVal: { x: val2X, y: val2Y },
            }
          });
          const subLeftAst = findNumNode(nd.ast && nd.ast.left);
          const subRightAst = findNumNode(nd.ast && nd.ast.right);
          const sL = (subLeftAst && subLeftAst.type === "num") ? String(subLeftAst.value) : getNodeLabel(nd.leftId);
          const sR = (subRightAst && subRightAst.type === "num") ? String(subRightAst.value) : getNodeLabel(nd.rightId);
          const sLx = sL === "x", sRx = sR === "x";
          pipeItems.push({ cx: val1X, cy: val1Y, r: R, label: sL, color: sLx ? OP_COLORS.x : subCol, italic: sLx, operand: null, fontSize: valueFontSizeForRadius(VALUE_BADGE_FONT_PREFERRED, sL, R), isBranchValue: true, astNode: subLeftAst });
          pipeItems.push({ cx: val2X, cy: val2Y, r: R, label: sR, color: sRx ? OP_COLORS.x : subCol, italic: sRx, operand: null, fontSize: valueFontSizeForRadius(VALUE_BADGE_FONT_PREFERRED, sR, R), isBranchValue: true, astNode: subRightAst });
        } else {
          const label = getNodeLabel(isLeft ? br.inputLeftId : br.inputRightId);
          const isX = label === "x";
          const astNum = isLeft ? leftAstNum : null;
          pipeItems.push({ cx: badgeCX, cy: bValY, r: R, label, color: isX ? OP_COLORS.x : (isLeft ? col : OP_COLORS.misc), italic: isX, operand: null, fontSize: valueFontSizeForRadius(VALUE_BADGE_FONT_PREFERRED, label, R), isBranchValue: true, astNode: astNum });
        }
      }
      pushBranchInput(nodes[br.inputLeftId], branchLeftCX, true);
      pushBranchInput(nodes[br.inputRightId], branchRightCX, false);
    }
  } else if (safeOps.length === 0) {
    firstValCX = PAD + HEX_R * S60;
    const xCX = firstValCX, yCX = firstValCX + HEX_STEP;
    pipeItems.push({ cx: xCX, cy: lowY, r: R, label: "x", color: OP_COLORS.x, italic: true, operand: null, fontSize: VALUE_BADGE_FONT_PREFERRED });
    pipeItems.push({ cx: yCX, cy: lowY, r: R, label: "y", color: OP_COLORS.y, italic: true, operand: null, fontSize: VALUE_BADGE_FONT_PREFERRED });
  } else {
    firstValCX = PAD + HEX_R * S60;
    pipeItems.push({
      cx: firstValCX, cy: lowY, r: R, label: "x",
      color: OP_COLORS.x, italic: true, operand: null, fontSize: VALUE_BADGE_FONT_PREFERRED
    });

    const nbGap = showIntermediates ? HEX_STEP : HEX_STEP - R * Math.sqrt(3);
    for (let i = 0; i < safeOps.length; i++) {
      const op = safeOps[i];
      const operand = getOperandForPipe(op);
      const sym = getPipeSymbol(op);
      const col = userColors[getColorKeyForOp(op)] || OP_COLORS.misc;
      const fs = sym.length > 3 ? 12 : sym.length > 2 ? 14 : sym.length > 1 ? 16 : 22;

      const opCX = firstValCX + i * nbGap + nbGap / 2;
      pipeItems.push({
        cx: opCX, cy: pipeY, r: JR, label: sym, color: col, italic: false,
        operand, fontSize: fs, op
      });

      if (i < safeOps.length - 1) {
        const intCX = firstValCX + (i + 1) * nbGap;
        const { fnColor: intColor } = getOpArmColors(op);
        pipeItems.push({
          cx: intCX, cy: lowY, r: R, label: "?",
          color: intColor, italic: false, operand: null, fontSize: 32, isIntermediate: true
        });
      }
    }
    pipeItems.push({
      cx: firstValCX + safeOps.length * nbGap, cy: lowY, r: R, label: "y",
      color: OP_COLORS.y, italic: true, operand: null, fontSize: VALUE_BADGE_FONT_PREFERRED
    });
  }

  /* ---- SVG dimensions ---- */
  if (pipeItems.length === 0) {
    const empty = svgEl("svg");
    empty.setAttribute("viewBox", "0 0 100 40");
    empty.setAttribute("width", 100);
    empty.setAttribute("height", 40);
    return empty;
  }
  const maxCX = Math.max(...pipeItems.map(it => it.cx + (it.r || 0)));
  const minCX = Math.min(...pipeItems.map(it => it.cx - (it.r || 0)));
  const maxCY = Math.max(...pipeItems.map(it => (it.cy || pipeY) + (it.r || 0)));
  const minCY = Math.min(...pipeItems.map(it => (it.cy || pipeY) - (it.r || 0)));
  lowY = Math.max(lowY, maxCY);
  const svgOriginX = Math.min(0, minCX - PAD);
  const svgOriginY = Math.min(0, minCY - PAD);
  const svgW = maxCX + ARM + PAD - svgOriginX;
  const svgH = lowY + ARM + PAD - svgOriginY;

  /* ---- create SVG ---- */
  const svg = svgEl("svg");
  svg.setAttribute("viewBox", `${svgOriginX} ${svgOriginY} ${svgW} ${svgH}`);
  svg.setAttribute("width", svgW);
  svg.setAttribute("height", svgH);
  svg.setAttribute("overflow", "visible");
  svg.classList.add("pipe-diagram");

  /* Five layers, back → front */
  const gHex = svgEl("g");   // (unused; hex outlines removed)
  const gPipe = svgEl("g");   // connector pipes: value badge → junction arm (hex lattice)
  const gArms = svgEl("g");   // coloured junction arms
  const gSpokes = svgEl("g");   // valve spokes + dots (value badges only)
  const gFills = svgEl("g");   // dark glass fills + operator circles
  const gFront = svgEl("g");   // rings + text
  const gInteract = svgEl("g"); // hit areas (topmost)

  /** Draw one segment of pipe (hex-lattice style) in gPipe. */
  function drawPipeSegment(x1, y1, x2, y2, colorHex) {
    const line = svgEl("line");
    line.setAttribute("x1", x1); line.setAttribute("y1", y1);
    line.setAttribute("x2", x2); line.setAttribute("y2", y2);
    line.setAttribute("stroke", colorHex || GREY);
    line.setAttribute("stroke-width", PW);
    line.setAttribute("stroke-linecap", "round");
    gPipe.appendChild(line);
  }

  /** Grey connector pipe from arm tip (touch point) to value badge. */
  function drawConnectorToValue(ax, ay, vx, vy) {
    drawPipeSegment(ax, ay, vx, vy, GREY);
  }

  /** Classify an op for arm-labelling */
  function getJunctionFamily(op) {
    if (!op) return null;
    if (op.type === "power") return "exp";
    if (op.type === "add") return "add";
    if (op.type === "sub") return "sub";
    if (op.type === "mul") return "mul";
    if (op.type === "div") return "div";
    if (getExpFamilyState(op) >= 0) return "exp";
    return null;
  }

  /** Get arm labels [BL, T, BR] in same order as getArmOpacities roles (so indices match) */
  function getArmLabels(family, op) {
    if (family === "add") return ["addend", "addend", "sum"];
    if (family === "sub") return ["difference", "subtrahend", "minuend"];
    if (family === "mul") return ["factor", "factor", "product"];
    if (family === "div") return ["quotient", "dividend", "divisor"];
    if (family === "exp") {
      const st = getExpFamilyState(op);
      if (st === 1) return ["power", "base", "exponent"];
      if (st === 2) return ["exponent", "power", "base"];
      return ["base", "exponent", "power"];
    }
    return null;
  }

  /** Get arm opacities [BL, T, BR] tied to semantic role, not position.
   *  Roles: input=IN, output=OUT, operand=OPERAND.
   *  For exp family the roles rotate through positions with state.
   *  For add/sub/mul/div the physical layout is fixed. */
  function getArmOpacities(family, op) {
    const { IN, OPERAND: OP, OUT } = ARM_OP;
    if (family === "exp") {
      const st = op ? getExpFamilyState(op) : 0; // layout node without op → power state 0
      // state 0: BL=input, T=operand, BR=output
      // state 1: BL=output, T=input,   BR=operand
      // state 2: BL=operand, T=output, BR=input
      if (st === 1) return [OUT, IN, OP];
      if (st === 2) return [OP, OUT, IN];
      return [IN, OP, OUT];
    }
    // add/sub, mul/div: opacities rotate with state (same pattern as exp)
    const info = op ? getRotationInfo(op) : null;
    if (info && info.curState === 1) return [OUT, IN, OP];
    return [IN, OP, OUT];
  }

  /* ---- Junction arms to touch point (circles of radius ARM just touch); grey connectors fill the gap ---- */
  function drawArm(x1, y1, x2, y2, color, target, opacity) {
    const arm = svgEl("line");
    arm.setAttribute("x1", x1); arm.setAttribute("y1", y1);
    arm.setAttribute("x2", x2); arm.setAttribute("y2", y2);
    const blended = (opacity !== undefined && opacity < 1) ? dimHexColor(color, opacity) : color;
    arm.setAttribute("stroke", blended);
    arm.setAttribute("stroke-width", PW);
    (target || gArms).appendChild(arm);
  }

  const valueItems = (useBranchedLayout ? pipeItems.filter(it => (it.italic || it.isIntermediate) && !it.isBranchValue && !it.isBranchIntermediate) : (safeOps.length ? pipeItems.filter(it => it.italic || it.isIntermediate) : []));
  const opItems = (useBranchedLayout ? pipeItems.filter(it => !it.italic && !it.isIntermediate && !it.isBranchOp && !it.isSubBranchOp && !it.isBranchValue) : (safeOps.length ? pipeItems.filter(it => !it.italic && !it.isIntermediate) : []));
  const branchItems = useBranchedLayout ? pipeItems.filter(it => it.isBranchOp || it.isBranchValue) : [];

  for (let i = 0; i < opItems.length; i++) {
    const it = opItems[i];
    const opCX = it.cx, opCY = it.cy;
    const flipped = !!it.isFlipped;
    const vLeft = valueItems[i], vRight = valueItems[i + 1];
    if (!vLeft || !vRight) continue;
    const col = it.color;
    // For standard (even) ops: BL/BR go down, T goes up
    // For flipped (odd) ops: left/right go up, T goes down
    const sign = flipped ? -1 : 1;
    const blTipX = opCX - ARM * S60, blTipY = opCY + sign * ARM * C60;
    const brTipX = opCX + ARM * S60, brTipY = opCY + sign * ARM * C60;

    if (it.operand != null || it.branchFeed) {
      const family = it.op ? getJunctionFamily(it.op) : (it.layoutOpNode ? getJunctionFamily({ type: it.layoutOpNode.opType }) : null);
      const armAlpha = family ? getArmOpacities(family, it.op) : [0.3, 1.0, 0.6];
      const rotatable = it.op && isRotatable(it.op);
      let armTarget = null;
      if (rotatable) {
        armTarget = svgEl("g");
        armTarget.style.transformOrigin = `${opCX}px ${opCY}px`;
        gArms.appendChild(armTarget);
        it._armsGroup = armTarget;
      }
      const tTipX = opCX;
      const tTipY = opCY - sign * ARM;
      drawArm(opCX, opCY, tTipX, tTipY, col, armTarget, armAlpha[1]);
      drawArm(opCX, opCY, blTipX, blTipY, col, armTarget, armAlpha[0]);
      drawArm(opCX, opCY, brTipX, brTipY, col, armTarget, armAlpha[2]);

      const outline = svgEl("circle");
      outline.setAttribute("cx", opCX); outline.setAttribute("cy", opCY);
      outline.setAttribute("r", ARM);
      outline.setAttribute("fill", "none");
      outline.setAttribute("stroke", col);
      outline.setAttribute("stroke-width", 1);
      outline.setAttribute("opacity", 0.35);
      it._outline = outline;
      gFront.appendChild(outline);

      const armLabels = family ? getArmLabels(family, it.op) : null;
      if (armLabels) {
        const ll = armLabels, lfs = 9;
        const labelTarget = armTarget || gFront;
        const needsCounter = !!armTarget;
        function makeArmLabel(x, y, text, armOpacity) {
          const lClr = dimHexColor(it.color, armOpacity);
          const g = svgEl("g");
          const bg = svgEl("rect");
          bg.setAttribute("rx", 3); bg.setAttribute("ry", 3);
          bg.setAttribute("fill", darkFill(it.color, 0.08));
          g.appendChild(bg);
          const t = svgEl("text");
          t.setAttribute("x", x); t.setAttribute("y", y);
          t.setAttribute("text-anchor", "middle");
          t.setAttribute("dominant-baseline", "central");
          t.setAttribute("fill", lClr);
          t.setAttribute("font-size", lfs);
          t.setAttribute("font-family", "KaTeX_Main, 'Times New Roman', serif");
          t.setAttribute("font-style", "italic");
          t.textContent = text;
          g.appendChild(t);
          // Mark group for CSS counter-rotation during animation
          g.classList.add('pipe-upright');
          if (_counterDeg !== 0) {
            g.setAttribute("transform", `rotate(${_counterDeg} ${x} ${y})`);
          }
          if (needsCounter) {
            g.style.transformOrigin = `${x}px ${y}px`;
            g.style.transition = "transform 0.3s ease-in-out";
          }
          labelTarget.appendChild(g);
          requestAnimationFrame(() => {
            try {
              const bbox = t.getBBox();
              const pad = 3;
              bg.setAttribute("x", bbox.x - pad); bg.setAttribute("y", bbox.y - pad);
              bg.setAttribute("width", bbox.width + 2 * pad);
              bg.setAttribute("height", bbox.height + 2 * pad);
            } catch (e) { }
          });
          return g;
        }
        const blTxt = makeArmLabel(blTipX, blTipY, ll[0], armAlpha[0]);
        const tTxt = makeArmLabel(tTipX, tTipY, ll[1], armAlpha[1]);
        const brTxt = makeArmLabel(brTipX, brTipY, ll[2], armAlpha[2]);
        if (needsCounter) it._armLabels = [blTxt, tTxt, brTxt];
      }
      it._opFnColor = (it.op && getOpArmColors(it.op).fnColor) || it.color;
      it._opOpndColor = (it.op && getOpArmColors(it.op).opndColor) || it.color;
      if (it.branchFeed) {
        if (showIntermediates) {
          drawConnectorToValue(tTipX, tTipY, it.branchFeed.cx, it.branchFeed.cy);
        }
        // When !showIntermediates, branch op is positioned so its feed tip meets this T tip — no connector
      } else {
        const operandY = flipped ? (opCY + 2 * ARM) : operandCY;
        drawConnectorToValue(tTipX, tTipY, opCX, operandY);
      }
      if (showIntermediates) {
        drawConnectorToValue(blTipX, blTipY, vLeft.cx, vLeft.cy);
        drawConnectorToValue(brTipX, brTipY, vRight.cx, vRight.cy);
      }
    } else {
      drawArm(opCX, opCY, blTipX, blTipY, col, null, ARM_OP.IN);
      drawArm(opCX, opCY, brTipX, brTipY, col, null, ARM_OP.OUT);
      it._opFnColor = dimHexColor(it.color, ARM_OP.OUT);
      it._opOpndColor = it.color;
      const outline = svgEl("circle");
      outline.setAttribute("cx", opCX); outline.setAttribute("cy", opCY);
      outline.setAttribute("r", ARM);
      outline.setAttribute("fill", "none");
      outline.setAttribute("stroke", col);
      outline.setAttribute("stroke-width", 1);
      outline.setAttribute("opacity", 0.35);
      it._outline = outline;
      gFront.appendChild(outline);
      if (showIntermediates) {
        drawConnectorToValue(blTipX, blTipY, vLeft.cx, vLeft.cy);
        drawConnectorToValue(brTipX, brTipY, vRight.cx, vRight.cy);
      }
    }
  }

  // When intermediates are hidden, junction circles touch — only connect first op to x, last op to y
  if (!showIntermediates && opItems.length > 0) {
    const xItem = pipeItems.find(it => it.italic && it.label === "x");
    const yItem = pipeItems.find(it => it.italic && it.label === "y");
    for (let i = 0; i < opItems.length; i++) {
      const curr = opItems[i];
      const cFlip = !!curr.isFlipped;
      const cSign = cFlip ? -1 : 1;
      const cBlTipX = curr.cx - ARM * S60, cBlTipY = curr.cy + cSign * ARM * C60;
      const cBrTipX = curr.cx + ARM * S60, cBrTipY = curr.cy + cSign * ARM * C60;
      if (i === 0 && xItem) drawConnectorToValue(cBlTipX, cBlTipY, xItem.cx, xItem.cy);
      if (i === opItems.length - 1 && yItem) drawConnectorToValue(cBrTipX, cBrTipY, yItem.cx, yItem.cy);
    }
  }

  if (useBranchedLayout) {
    const S60 = Math.sqrt(3) / 2;
    for (const it of pipeItems) {
      if (!it.isBranchOp) continue;
      const cx = it.cx, cy = it.cy;
      const bFlipped = !!it.isFlipped;
      const bSign = bFlipped ? -1 : 1;
      // For even (above): down arm toward main path, left/right up toward inputs
      // For odd (below): up arm toward main path, left/right down toward inputs
      const isMulDiv = it.layoutOpNode && (it.layoutOpNode.opType === "mul" || it.layoutOpNode.opType === "div");
      const branchFamily = it.layoutOpNode && it.layoutOpNode.opType === "div" ? "div" : "mul";
      const branchOpForState = it.layoutOpNode ? { type: it.layoutOpNode.opType } : null;
      let branchAlpha;
      try {
        branchAlpha = getArmOpacities(branchFamily, branchOpForState);
      } catch (_) {
        branchAlpha = [ARM_OP.IN, ARM_OP.OPERAND, ARM_OP.OUT];
      }
      if (!branchAlpha || branchAlpha.length < 3) branchAlpha = [ARM_OP.IN, ARM_OP.OPERAND, ARM_OP.OUT];
      const branchRot = branchOpForState ? getRotationInfo(branchOpForState) : null;
      const branchState = branchRot ? branchRot.curState : 0;
      const leftIdx = branchState === 0 ? 0 : 1;
      const rightIdx = branchState === 0 ? 1 : 2;
      const feedIdx = branchState === 0 ? 2 : 0;
      const leftArmColor = dimHexColor(it.color, branchAlpha[leftIdx]);
      const rightArmColor = dimHexColor(it.color, branchAlpha[rightIdx]);
      const feedArmColor = dimHexColor(it.color, branchAlpha[feedIdx]);
      const rotatableBranch = isMulDiv && it.layoutOpNode.ast;
      let armTarget = null;
      if (rotatableBranch) {
        armTarget = svgEl("g");
        armTarget.style.transformOrigin = `${cx}px ${cy}px`;
        gArms.appendChild(armTarget);
        it._armsGroup = armTarget;
      }
      // Feed arm toward main path; input arms toward branch values
      const touchFeedX = cx;
      const touchFeedY = cy + bSign * ARM;
      const touchLeftX = cx - ARM * S60;
      const touchLeftY = cy - bSign * ARM / 2;
      const touchRightX = cx + ARM * S60;
      const touchRightY = cy - bSign * ARM / 2;
      const leftValCX = cx - ARM * Math.sqrt(3);
      const rightValCX = cx + ARM * Math.sqrt(3);
      const bValY = bFlipped ? oddBranchValueY : branchValueY;
      const bIntY = bFlipped ? oddBranchIntY : branchIntermediateY;
      drawArm(cx, cy, touchLeftX, touchLeftY, leftArmColor, armTarget, 1);
      drawArm(cx, cy, touchRightX, touchRightY, rightArmColor, armTarget, 1);
      drawArm(cx, cy, touchFeedX, touchFeedY, feedArmColor, armTarget, 1);
      if (showIntermediates) {
        drawConnectorToValue(touchFeedX, touchFeedY, cx, bIntY);
      }
      // In compact mode, the connection between branch feed and main-path T arm
      // is handled from the main-path side using extended arm colors (no grey pipe).
      drawConnectorToValue(touchLeftX, touchLeftY, leftValCX, bValY);
      drawConnectorToValue(touchRightX, touchRightY, rightValCX, bValY);
      const armLabels = getArmLabels(branchFamily, null);
      if (armLabels) {
        const ll = armLabels, lfs = 9;
        const labelTarget = armTarget || gFront;
        function makeBranchArmLabel(x, y, text, color) {
          const g = svgEl("g");
          const bg = svgEl("rect");
          bg.setAttribute("rx", 3); bg.setAttribute("ry", 3);
          bg.setAttribute("fill", darkFill(it.color, 0.08));
          g.appendChild(bg);
          const t = svgEl("text");
          t.setAttribute("x", x); t.setAttribute("y", y);
          t.setAttribute("text-anchor", "middle");
          t.setAttribute("dominant-baseline", "central");
          t.setAttribute("fill", color);
          t.setAttribute("font-size", lfs);
          t.setAttribute("font-family", "KaTeX_Main, 'Times New Roman', serif");
          t.setAttribute("font-style", "italic");
          t.textContent = text;
          g.appendChild(t);
          g.classList.add('pipe-upright');
          if (_counterDeg !== 0) {
            g.setAttribute("transform", `rotate(${_counterDeg} ${x} ${y})`);
          }
          if (armTarget) {
            g.style.transformOrigin = `${x}px ${y}px`;
            g.style.transition = "transform 0.3s ease-in-out";
          }
          labelTarget.appendChild(g);
          requestAnimationFrame(() => {
            try {
              const bbox = t.getBBox();
              const pad = 3;
              bg.setAttribute("x", bbox.x - pad); bg.setAttribute("y", bbox.y - pad);
              bg.setAttribute("width", bbox.width + 2 * pad);
              bg.setAttribute("height", bbox.height + 2 * pad);
            } catch (e) { }
          });
        }
        const branchLabelEls = [];
        function addBranchArmLabel(x, y, text, color) {
          makeBranchArmLabel(x, y, text, color);
          if (labelTarget.lastChild) branchLabelEls.push(labelTarget.lastChild);
        }
        addBranchArmLabel(touchLeftX, touchLeftY, ll[leftIdx], leftArmColor);
        addBranchArmLabel(touchFeedX, touchFeedY, ll[feedIdx], feedArmColor);
        addBranchArmLabel(touchRightX, touchRightY, ll[rightIdx], rightArmColor);
        if (rotatableBranch) it._armLabels = branchLabelEls;
      }
      const junctionRotations = layout.junctionRotations || {};
      const branchRotKey = it.feedsIntoMainOpIndex != null ? "branch-" + it.feedsIntoMainOpIndex : null;
      const branchRotDeg = branchRotKey ? junctionRotations[branchRotKey] : undefined;
      if (rotatableBranch && armTarget && typeof branchRotDeg === "number") {
        armTarget.style.transform = `rotate(${branchRotDeg}deg)`;
        if (it._armLabels) for (const lbl of it._armLabels) lbl.style.transform = `rotate(${-branchRotDeg}deg)`;
      }
      const outline = svgEl("circle");
      outline.setAttribute("cx", cx);
      outline.setAttribute("cy", cy);
      outline.setAttribute("r", ARM);
      outline.setAttribute("fill", "none");
      outline.setAttribute("stroke", it.color);
      outline.setAttribute("stroke-width", 1);
      outline.setAttribute("opacity", 0.35);
      gFront.appendChild(outline);
      it._outline = outline;
    }

    // Sub-branch junctions (complex inputs within branches)
    for (const it of pipeItems) {
      if (!it.isSubBranchOp || !it.sbArms) continue;
      const cx = it.cx, cy = it.cy;
      const subCol = it.color;
      const subNode = it.subBranchNode;
      const subFamily = subNode ? getJunctionFamily({ type: subNode.opType }) : null;
      const sbExpState = subNode && subNode._expState !== undefined ? subNode._expState : 0;
      const subArmAlpha = (() => {
        if (subFamily === "exp") {
          const { IN, OPERAND: OP, OUT } = ARM_OP;
          if (sbExpState === 1) return [OUT, IN, OP];
          if (sbExpState === 2) return [OP, OUT, IN];
          return [IN, OUT, OP];
        }
        return subFamily ? getArmOpacities(subFamily, null) : [ARM_OP.OPERAND, ARM_OP.OUT, ARM_OP.IN];
      })();
      // Map [BL, T, BR] to (left, right, feed) so feed always gets OUTPUT (same idea as branch)
      const sbLeftIdx = subFamily === "exp" && sbExpState === 1 ? 1 : 0;
      const sbRightIdx = subFamily === "exp" && sbExpState === 1 ? 2 : 2;
      const sbFeedIdx = subFamily === "exp" && sbExpState === 1 ? 0 : 1;
      const sbLeftLbl = subFamily === "exp" && sbExpState === 1 ? 1 : 0;
      const sbFeedLbl = subFamily === "exp" && sbExpState === 1 ? 0 : 2;
      const sbRightLbl = subFamily === "exp" && sbExpState === 1 ? 2 : 1;
      // Use pre-computed rotated arm positions — arms point along actual pipe directions
      const { feed, left, right, leftVal, rightVal } = it.sbArms;
      const sbArmTarget = svgEl("g");
      sbArmTarget.style.transformOrigin = `${cx}px ${cy}px`;
      gArms.appendChild(sbArmTarget);
      it._armsGroup = sbArmTarget;
      drawArm(cx, cy, left.x, left.y, dimHexColor(subCol, subArmAlpha[sbLeftIdx]), sbArmTarget, 1);
      drawArm(cx, cy, right.x, right.y, dimHexColor(subCol, subArmAlpha[sbRightIdx]), sbArmTarget, 1);
      drawArm(cx, cy, feed.x, feed.y, dimHexColor(subCol, subArmAlpha[sbFeedIdx]), sbArmTarget, 1);
      drawConnectorToValue(left.x, left.y, leftVal.x, leftVal.y);
      drawConnectorToValue(right.x, right.y, rightVal.x, rightVal.y);
      // Feed connector to parent value badge — straight line along same direction as feed arm
      const pvCX = it.parentValCX, pvCY = it.parentValCY;
      drawConnectorToValue(feed.x, feed.y, pvCX, pvCY);
      const subLabels = (() => {
        if (subFamily === "exp") {
          if (sbExpState === 1) return ["power", "base", "exponent"];
          if (sbExpState === 2) return ["exponent", "power", "base"];
          return ["base", "exponent", "power"];
        }
        return subFamily ? getArmLabels(subFamily, null) : null;
      })();
      const sbLabelEls = [];
      if (subLabels) {
        const lfs = 9;
        const labelTarget = sbArmTarget;
        function makeSubArmLabel(x, y, text, armOpacity) {
          const lClr = dimHexColor(subCol, armOpacity);
          const g = svgEl("g");
          const bg = svgEl("rect");
          bg.setAttribute("rx", 3); bg.setAttribute("ry", 3);
          bg.setAttribute("fill", darkFill(subCol, 0.08));
          g.appendChild(bg);
          const t = svgEl("text");
          t.setAttribute("x", x); t.setAttribute("y", y);
          t.setAttribute("text-anchor", "middle");
          t.setAttribute("dominant-baseline", "central");
          t.setAttribute("fill", lClr);
          t.setAttribute("font-size", lfs);
          t.setAttribute("font-family", "KaTeX_Main, 'Times New Roman', serif");
          t.setAttribute("font-style", "italic");
          t.textContent = text;
          g.appendChild(t);
          g.classList.add('pipe-upright');
          if (_counterDeg !== 0) {
            g.setAttribute("transform", `rotate(${_counterDeg} ${x} ${y})`);
          }
          g.style.transformOrigin = `${x}px ${y}px`;
          g.style.transition = "transform 0.3s ease-in-out";
          labelTarget.appendChild(g);
          requestAnimationFrame(() => {
            try {
              const bbox = t.getBBox();
              const pad = 3;
              bg.setAttribute("x", bbox.x - pad); bg.setAttribute("y", bbox.y - pad);
              bg.setAttribute("width", bbox.width + 2 * pad);
              bg.setAttribute("height", bbox.height + 2 * pad);
            } catch (e) { }
          });
          return g;
        }
        sbLabelEls.push(makeSubArmLabel(left.x, left.y, subLabels[sbLeftLbl], subArmAlpha[sbLeftIdx]));
        sbLabelEls.push(makeSubArmLabel(feed.x, feed.y, subLabels[sbFeedLbl], subArmAlpha[sbFeedIdx]));
        sbLabelEls.push(makeSubArmLabel(right.x, right.y, subLabels[sbRightLbl], subArmAlpha[sbRightIdx]));
      }
      it._armLabels = sbLabelEls;
      const sbRotKey = it.subBranchKey;
      const sbRotDeg = sbRotKey && (layout.junctionRotations || {})[sbRotKey];
      if (typeof sbRotDeg === "number" && sbArmTarget && it._armLabels) {
        sbArmTarget.style.transform = `rotate(${sbRotDeg}deg)`;
        for (const lbl of it._armLabels) lbl.style.transform = `rotate(${-sbRotDeg}deg)`;
      }
      const outline = svgEl("circle");
      outline.setAttribute("cx", cx);
      outline.setAttribute("cy", cy);
      outline.setAttribute("r", ARM);
      outline.setAttribute("fill", "none");
      outline.setAttribute("stroke", subCol);
      outline.setAttribute("stroke-width", 1);
      outline.setAttribute("opacity", 0.35);
      gFront.appendChild(outline);
      it._outline = outline;
    }
  }

  if (safeOps.length === 0) {
    const v0 = pipeItems[0], v1 = pipeItems[1];
    const midX = (v0.cx + v1.cx) / 2;
    const midY = v0.cy + (v1.cx - v0.cx) / (2 * S60);
    drawPipeSegment(v0.cx, v0.cy, midX, midY, GREY);
    drawPipeSegment(midX, midY, v1.cx, v1.cy, GREY);
  }

  for (const it of pipeItems) {
    if (it.italic || it.isIntermediate) continue;
    if (!it._opFnColor) {
      const res = it.op ? getOpArmColors(it.op) : { fnColor: it.color, opndColor: it.color };
      it._opFnColor = res.fnColor;
      it._opOpndColor = res.opndColor;
    }
  }

  /* ---- draw a valve handwheel at (cx, cy, radius) ---- */
  function drawValve(cx, cy, color, rad) {
    const spokeR = rad;
    const ringOut = rad;
    const ringIn = rad - 6;
    // 6 spokes from centre to edge
    for (let k = 0; k < 6; k++) {
      const a = k * Math.PI / 3;
      const spoke = svgEl("line");
      spoke.setAttribute("x1", cx);
      spoke.setAttribute("y1", cy);
      spoke.setAttribute("x2", cx + Math.cos(a) * spokeR);
      spoke.setAttribute("y2", cy + Math.sin(a) * spokeR);
      spoke.setAttribute("stroke", color);
      spoke.setAttribute("stroke-width", SPOKE_W);
      gSpokes.appendChild(spoke);
    }
    // Small filled dots at spoke tips
    for (let k = 0; k < 6; k++) {
      const a = k * Math.PI / 3;
      const dot = svgEl("circle");
      dot.setAttribute("cx", cx + Math.cos(a) * spokeR);
      dot.setAttribute("cy", cy + Math.sin(a) * spokeR);
      dot.setAttribute("r", DOT_R);
      dot.setAttribute("fill", color);
      gSpokes.appendChild(dot);
    }
    // Glass fill — matches top-bar glass via CSS custom property
    const glass = svgEl("circle");
    glass.setAttribute("cx", cx);
    glass.setAttribute("cy", cy);
    glass.setAttribute("r", ringIn);  // fill to inner ring radius
    glass.setAttribute("style", "fill: var(--valve-glass, var(--glass-bg))");
    gFills.appendChild(glass);
    // Two concentric rings (replace outline)
    let outerRing = null;
    for (const rr of [ringIn, ringOut]) {
      const ring = svgEl("circle");
      ring.setAttribute("cx", cx);
      ring.setAttribute("cy", cy);
      ring.setAttribute("r", rr);
      ring.setAttribute("fill", "none");
      ring.setAttribute("stroke", color);
      ring.setAttribute("stroke-width", RING_W);
      gFront.appendChild(ring);
      if (rr === ringOut) outerRing = ring;
    }
    return outerRing;
  }

  /* ---- draw a pointy-top hex outline at (cx, cy) ---- */
  function drawHex(cx, cy, color) {
    const pts = [];
    for (let k = 0; k < 6; k++) {
      // Start from top vertex (-90°), go clockwise
      const a = -Math.PI / 2 + k * Math.PI / 3;
      pts.push(`${cx + HEX_R * Math.cos(a)},${cy + HEX_R * Math.sin(a)}`);
    }
    const hex = svgEl("polygon");
    hex.setAttribute("points", pts.join(" "));
    hex.setAttribute("fill", "none");
    hex.setAttribute("stroke", color);
    hex.setAttribute("stroke-width", 1);
    hex.setAttribute("opacity", 0.2);
    gHex.appendChild(hex);
  }

  /* ---- draw a text label at (cx, cy) ---- */
  function drawLabel(cx, cy, label, color, italic, fontSize) {
    const txt = svgEl("text");
    txt.setAttribute("x", cx);
    txt.setAttribute("y", cy);
    txt.setAttribute("text-anchor", "middle");
    txt.setAttribute("dominant-baseline", "central");
    txt.setAttribute("fill", color);
    txt.setAttribute("font-size", fontSize);
    txt.setAttribute("font-family", "KaTeX_Main, 'Times New Roman', serif");
    if (italic) txt.setAttribute("font-style", "italic");
    txt.textContent = label;
    txt.classList.add('pipe-upright');
    gFront.appendChild(txt);
  }

  /** Value badge font size: use preferred (2x) but shrink if label won't fit in circle of radius r. */
  function valueFontSize(preferred, label, r) {
    const len = Math.max(1, (label || "").length);
    const maxW = 2 * r * 0.9;
    const fitSize = maxW / (0.6 * len);
    return Math.min(preferred, Math.max(8, Math.floor(fitSize)));
  }

  /* ---- pipe-level badges (x, operators, intermediates, y); no hex outlines ---- */
  for (const it of pipeItems) {
    const cy = it.cy || pipeY;
    if (it.isIntermediate) continue;
    if (false) { // intermediates hidden
      const glass = svgEl("circle");
      glass.setAttribute("cx", it.cx); glass.setAttribute("cy", cy); glass.setAttribute("r", it.r);
      glass.setAttribute("style", "fill: var(--valve-glass, var(--glass-bg))");
      gFills.appendChild(glass);
      const ring = svgEl("circle");
      ring.setAttribute("cx", it.cx); ring.setAttribute("cy", cy); ring.setAttribute("r", it.r);
      ring.setAttribute("fill", "none"); ring.setAttribute("stroke", it.color); ring.setAttribute("stroke-width", RING_W);
      gFront.appendChild(ring);
      it._valveRing = ring;
      const fs = valueFontSize(it.fontSize, it.label, it.r);
      drawLabel(it.cx, cy, it.label, it.color, true, fs);
    } else if (it.italic) {
      const glass = svgEl("circle");
      glass.setAttribute("cx", it.cx); glass.setAttribute("cy", cy); glass.setAttribute("r", it.r);
      glass.setAttribute("style", "fill: var(--valve-glass, var(--glass-bg))");
      gFills.appendChild(glass);
      const ring = svgEl("circle");
      ring.setAttribute("cx", it.cx); ring.setAttribute("cy", cy); ring.setAttribute("r", it.r);
      ring.setAttribute("fill", "none"); ring.setAttribute("stroke", it.color); ring.setAttribute("stroke-width", RING_W);
      gFront.appendChild(ring);
      it._valveRing = ring;
      const fs = valueFontSize(it.fontSize, it.label, it.r);
      drawLabel(it.cx, cy, it.label, it.color, it.italic, fs);
    } else if (it.isBranchValue) {
      const outerRing = drawValve(it.cx, cy, it.color, it.r);
      it._valveRing = outerRing;
      const fs = it.fontSize != null ? it.fontSize : valueFontSize(VALUE_BADGE_FONT_PREFERRED, it.label, it.r);
      drawLabel(it.cx, cy, it.label, it.color, it.italic, fs);
    } else if (it.isBranchOp || it.isSubBranchOp) {
      const opFnColor = it.color;
      const circ = svgEl("circle");
      circ.setAttribute("cx", it.cx);
      circ.setAttribute("cy", cy);
      circ.setAttribute("r", it.r);
      circ.setAttribute("fill", darkFill(opFnColor, 0.15));
      circ.setAttribute("stroke", opFnColor);
      circ.setAttribute("stroke-width", 1.5);
      gFills.appendChild(circ);
      drawLabel(it.cx, cy, it.label, opFnColor, it.italic, it.fontSize);
    } else {
      const opFnColor = it._opFnColor || it.color;
      const opBadgeY = it.cy || pipeY;
      const circ = svgEl("circle");
      circ.setAttribute("cx", it.cx);
      circ.setAttribute("cy", opBadgeY);
      circ.setAttribute("r", it.r);
      circ.setAttribute("fill", darkFill(opFnColor, 0.15));
      circ.setAttribute("stroke", opFnColor);
      circ.setAttribute("stroke-width", 1.5);
      gFills.appendChild(circ);
      drawLabel(it.cx, opBadgeY, it.label, opFnColor, it.italic, it.fontSize);
    }
  }

  /* ---- operand badges: above even ops, below odd ops ---- */
  for (const it of pipeItems) {
    if (it.operand != null && !it.isBranchOp) {
      const badgeColor = it._opOpndColor || it.color;
      const opndY = it.isFlipped ? (oddOpY + 2 * ARM) : operandCY;
      const outerRing = drawValve(it.cx, opndY, badgeColor, R);
      it._operandRing = outerRing;
      const fs = valueFontSize(40, it.operand, R);
      drawLabel(it.cx, opndY, it.operand, badgeColor, false, fs);
    }
  }

  /* ---- interactive hit areas for x / y / intermediate badges (hover highlight) ---- */
  for (const it of pipeItems) {
    if (!it.italic && !it.isIntermediate && !it.isBranchValue) continue;
    if (it.isIntermediate) continue;
    const cy = it.cy || pipeY;
    const hit = svgEl("circle");
    hit.setAttribute("cx", it.cx);
    hit.setAttribute("cy", cy);
    hit.setAttribute("r", it.r);
    hit.setAttribute("fill", "transparent");
    hit.setAttribute("stroke", "none");
    hit.style.cursor = "default";
    gInteract.appendChild(hit);
    const ring = it._valveRing;
    if (ring) {
      hit.addEventListener("mouseenter", () => {
        ring.setAttribute("stroke-width", 2.5);
        ring.setAttribute("opacity", 1);
      });
      hit.addEventListener("mouseleave", () => {
        ring.setAttribute("stroke-width", RING_W);
        ring.removeAttribute("opacity");
      });
    }
    if (it.isBranchValue && it.astNode && layout && it.astNode.type === "num") {
      hit.style.cursor = "ns-resize";
      hit.addEventListener("wheel", (e) => {
        e.preventDefault();
        const ast = it.astNode;
        const curVal = Number(ast.value);
        if (!Number.isFinite(curVal)) return;
        const step = ast.value % 1 !== 0 ? 0.1 : 1;
        const dir = getOperandScrollDir(e);
        let newVal = curVal + dir * step;
        if (step < 1) newVal = Math.round(newVal * 10) / 10;
        ast.value = newVal;
        const rootId = layout.mainPath.opIds[0];
        const rootNode = layout.nodes[rootId];
        const rootAst = rootNode && rootNode.ast;
        if (rootAst && ui.exprEl) {
          const newExpr = exprString(rootAst);
          ui.exprEl.value = newExpr;
          try {
            state.fn = compileExpression(newExpr);
            state.lastExpr = newExpr;
            const { steps, ops } = parseAndLinearize(newExpr);
            state.steps = steps;
            state.ops = ops;
            state.stepEyes.ops = ops.map(() => true);
          } catch (_) { }
          renderStepRepresentation();
          updateLatexDisplay(newExpr);
        }
      }, { passive: false });
      addTouchScroll(hit);
    }
  }

  /* ---- interactive hit areas for operators (hover + scroll) ---- */
  let _animating = false;   // global lock to prevent overlapping rotations

  for (const it of pipeItems) {
    if (it.italic || it.isIntermediate || it.isBranchValue) continue;
    const opCy = it.cy || pipeY;
    const hitRadius = ARM;
    const hit = svgEl("circle");
    hit.setAttribute("cx", it.cx);
    hit.setAttribute("cy", opCy);
    hit.setAttribute("r", hitRadius);
    hit.setAttribute("fill", "transparent");
    hit.setAttribute("stroke", "none");
    hit.style.cursor = "default";
    gInteract.appendChild(hit);

    const ol = it._outline;
    if (ol) {
      hit.addEventListener("mouseenter", () => {
        ol.setAttribute("stroke-width", 2);
        ol.setAttribute("opacity", "0.8");
      });
      hit.addEventListener("mouseleave", () => {
        ol.setAttribute("stroke-width", 1);
        ol.setAttribute("opacity", "0.35");
      });
    }

    // Scroll-to-rotate on any rotatable operator
    if (it.op && isRotatable(it.op)) {
      hit.style.cursor = "ns-resize";
      hit.addEventListener("wheel", (e) => {
        e.preventDefault();
        if (_animating) return;
        _animating = true;

        const info = getRotationInfo(it.op);
        const dir = e.deltaY > 0 ? 1 : -1; // down=CW, up=CCW
        // For 2-state families, always toggle: state 0→1 = CW, 1→0 = CCW
        const visualDir = (info && info.states === 2)
          ? (info.curState === 0 ? 1 : -1)
          : dir;
        const deg = visualDir * 120;

        // Animate the arms group rotation
        const ag = it._armsGroup;
        if (ag) {
          ag.style.transition = "transform 0.3s ease-in-out";
          ag.style.transform = `rotate(${deg}deg)`;
        }
        // Counter-rotate labels so text stays horizontal
        if (it._armLabels) {
          for (const lbl of it._armLabels) {
            lbl.style.transform = `rotate(${-deg}deg)`;
          }
        }
        // Brighten the outline during rotation
        if (ol) {
          ol.style.transition = "stroke-width 0.3s, opacity 0.3s";
          ol.setAttribute("stroke-width", 2.5);
          ol.setAttribute("opacity", 1);
        }

        // After animation, mutate op and re-render
        setTimeout(() => {
          rotateOp(it.op, dir);
          _animating = false;
          applyOpsChange();
        }, 320);
      }, { passive: false });
      addTouchScroll(hit, 40);
    } else if (it.isSubBranchOp && layout && it.subBranchNode && it.subBranchNode.ast) {
      const subNd = it.subBranchNode;
      const subAst = subNd.ast;
      const layoutOpType = subNd.opType;
      const isExpFamily = layoutOpType === "power";
      const isMulDivFamily = layoutOpType === "mul" || layoutOpType === "div";
      const isAddSubFamily = layoutOpType === "add" || layoutOpType === "sub";
      const isSubRotatable = isExpFamily || isMulDivFamily || isAddSubFamily;
      if (isSubRotatable) {
        if (isExpFamily && subNd._expState === undefined && subAst && typeof subAst.op === "string") {
          subNd._expState = (subAst.op === "/" ? 1 : subAst.op === "**" && subAst.right && subAst.right.type === "binary" ? 2 : 0);
        }
        const numStates = isExpFamily ? 3 : 2;
        // Derive base/exp from current AST state so we never use a wrong node (e.g. coefficient 3 instead of exponent 2)
        function getSubExpBaseAndExp(ast, state) {
          if (!ast || ast.type !== "binary") return { base: null, exp: null };
          if (state === 0) {
            if (ast.op === "**" && ast.left && ast.right)
              return { base: ast.left, exp: (ast.right.type === "binary" && ast.right.op === "/" ? ast.right.right : ast.right) };
            if (ast.op === "/" && ast.left && ast.left.type === "call" && ast.right && ast.right.type === "call")
              return { base: ast.left.arg, exp: ast.right.arg };
          }
          if (state === 1 && ast.op === "/" && ast.left && ast.left.type === "call" && ast.right && ast.right.type === "call")
            return { base: ast.left.arg, exp: ast.right.arg };
          if (state === 2 && ast.op === "**" && ast.left && ast.right && ast.right.type === "binary" && ast.right.op === "/")
            return { base: ast.left, exp: ast.right.right };
          return { base: null, exp: null };
        }
        hit.style.cursor = "ns-resize";
        hit.addEventListener("wheel", (e) => {
          e.preventDefault();
          if (_animating) return;
          _animating = true;
          const dir = e.deltaY > 0 ? 1 : -1;
          // Determine visual rotation direction (for 2-state, always toggle)
          let visualDir = dir;
          if (numStates === 2) {
            const curState = isMulDivFamily
              ? (subAst.op === "/" ? 1 : 0)
              : (subAst.op === "-" ? 1 : 0);
            visualDir = curState === 0 ? 1 : -1;
          }
          const deg = visualDir * 120;
          // Animate arms group rotation
          const ag = it._armsGroup;
          if (ag) {
            ag.style.transition = "transform 0.3s ease-in-out";
            ag.style.transform = `rotate(${deg}deg)`;
          }
          // Counter-rotate labels
          if (it._armLabels) {
            for (const lbl of it._armLabels) {
              lbl.style.transform = `rotate(${-deg}deg)`;
            }
          }
          if (ol) {
            ol.style.transition = "stroke-width 0.3s, opacity 0.3s";
            ol.setAttribute("stroke-width", 2.5);
            ol.setAttribute("opacity", 1);
          }
          setTimeout(() => {
            if (isExpFamily) {
              const cur = subNd._expState || 0;
              const next = ((cur + dir) % 3 + 3) % 3;
              subNd._expState = next;
              const { base, exp } = getSubExpBaseAndExp(subAst, cur);
              if (!base || !exp) {
                _animating = false;
                return;
              }
              if (next === 0) {
                subAst.op = "**";
                subAst.left = base;
                subAst.right = exp;
                subNd.symbol = "^";
              } else if (next === 1) {
                subAst.op = "/";
                subAst.left = { type: "call", fn: "ln", arg: base };
                subAst.right = { type: "call", fn: "ln", arg: exp };
                subNd.symbol = "log";
              } else {
                subAst.op = "**";
                subAst.left = base;
                subAst.right = {
                  type: "binary", op: "/",
                  left: { type: "num", value: 1 }, right: exp
                };
                subNd.symbol = "\u207F\u221A";
              }
            } else if (isMulDivFamily) {
              subAst.op = subAst.op === "*" ? "/" : "*";
              subNd.opType = subAst.op === "/" ? "div" : "mul";
              subNd.symbol = subAst.op === "/" ? "\u00f7" : "\u00d7";
            } else if (isAddSubFamily) {
              subAst.op = subAst.op === "+" ? "-" : "+";
              subNd.opType = subAst.op === "-" ? "sub" : "add";
              subNd.symbol = subAst.op === "-" ? "\u2212" : "+";
            }

            if (state.pipeJunctionRotations == null) state.pipeJunctionRotations = {};
            const sbKey = it.subBranchKey;
            if (sbKey != null) state.pipeJunctionRotations[sbKey] = (state.pipeJunctionRotations[sbKey] || 0) + deg;

            const rootId = layout.mainPath.opIds[0];
            const rootNode = layout.nodes[rootId];
            const rootAst = rootNode && rootNode.ast;
            if (rootAst && ui.exprEl) {
              const newExpr = exprString(rootAst);
              ui.exprEl.value = newExpr;
              try {
                state.fn = compileExpression(newExpr);
                state.lastExpr = newExpr;
                const { steps, ops, pipeLayout } = parseAndLinearize(newExpr);
                state.steps = steps;
                state.ops = ops;
                state.stepEyes.ops = ops.map(() => true);
                if (pipeLayout != null && !isExpFamily) state.pipeLayout = pipeLayout;
              } catch (_) { }
              renderStepRepresentation();
              updateLatexDisplay(newExpr);
            }
            _animating = false;
          }, 320);
        }, { passive: false });
        addTouchScroll(hit, 40);
      }
    } else if (it.isBranchOp && layout && it.layoutOpNode && it.layoutOpNode.ast && (it.layoutOpNode.opType === "mul" || it.layoutOpNode.opType === "div")) {
      hit.style.cursor = "ns-resize";
      hit.addEventListener("wheel", (e) => {
        e.preventDefault();
        if (_animating) return;
        _animating = true;
        // 2-state toggle: mul→CW, div→CCW (matches main-path pattern)
        const deg = (it.layoutOpNode.opType === "mul" ? 1 : -1) * 120;

        const ag = it._armsGroup;
        if (ag) {
          ag.style.transition = "transform 0.3s ease-in-out";
          ag.style.transform = `rotate(${deg}deg)`;
        }
        // Counter-rotate labels so text stays horizontal (same as main path)
        if (it._armLabels) {
          for (const lbl of it._armLabels) {
            lbl.style.transform = `rotate(${-deg}deg)`;
          }
        }
        if (ol) {
          ol.style.transition = "stroke-width 0.3s, opacity 0.3s";
          ol.setAttribute("stroke-width", 2.5);
          ol.setAttribute("opacity", 1);
        }

        setTimeout(() => {
          const ast = it.layoutOpNode.ast;
          if (ast && ast.type === "binary") {
            const newOp = ast.op === "*" ? "/" : "*";
            ast.op = newOp;
            it.layoutOpNode.opType = newOp === "/" ? "div" : "mul";
            it.layoutOpNode.symbol = newOp === "/" ? "\u00f7" : "\u00d7";
            if (state.pipeJunctionRotations == null) state.pipeJunctionRotations = {};
            const rotKey = it.feedsIntoMainOpIndex != null ? "branch-" + it.feedsIntoMainOpIndex : null;
            if (rotKey != null) state.pipeJunctionRotations[rotKey] = (state.pipeJunctionRotations[rotKey] || 0) + deg;
            const rootId = layout.mainPath.opIds[0];
            const rootNode = layout.nodes[rootId];
            const rootAst = rootNode && rootNode.ast;
            if (rootAst && ui.exprEl) {
              const newExpr = exprString(rootAst);
              ui.exprEl.value = newExpr;
              try {
                state.fn = compileExpression(newExpr);
                state.lastExpr = newExpr;
                const { steps, ops, pipeLayout } = parseAndLinearize(newExpr);
                state.steps = steps;
                state.ops = ops;
                state.stepEyes.ops = ops.map(() => true);
                if (pipeLayout != null) state.pipeLayout = pipeLayout;
              } catch (_) { }
              renderStepRepresentation();
              updateLatexDisplay(newExpr);
              updateInputOverlay();
            }
          }
          _animating = false;
        }, 320);
      }, { passive: false });
      addTouchScroll(hit, 40);
    }
  }

  /* ---- interactive hit areas for operand badges (hover + scroll to change value) ---- */
  for (const it of pipeItems) {
    if (it.operand == null || !it.op) continue;
    const opndHitY = it.isFlipped ? (oddOpY + 2 * ARM) : operandCY;
    const hit = svgEl("circle");
    hit.setAttribute("cx", it.cx);
    hit.setAttribute("cy", opndHitY);
    hit.setAttribute("r", R);
    hit.setAttribute("fill", "transparent");
    hit.setAttribute("stroke", "none");
    hit.style.cursor = "ns-resize";
    gInteract.appendChild(hit);

    // Hover highlight on outer ring
    const oRing = it._operandRing;
    if (oRing) {
      hit.addEventListener("mouseenter", () => {
        oRing.setAttribute("stroke-width", 2.5);
        oRing.setAttribute("opacity", 1);
      });
      hit.addEventListener("mouseleave", () => {
        oRing.setAttribute("stroke-width", RING_W);
        oRing.removeAttribute("opacity");
      });
    }

    hit.addEventListener("wheel", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const op = it.op;
      const curStr = op.operand;
      if (!curStr) return;
      const curVal = parseFloat(curStr);
      if (!Number.isFinite(curVal)) return;

      // Determine step: store on first interaction so it stays consistent
      if (op._scrollStep === undefined) {
        op._scrollStep = curStr.includes(".") ? 0.1 : 1;
      }
      const step = op._scrollStep;
      const dir = getOperandScrollDir(e);

      let newVal = curVal + dir * step;
      if (step < 1) newVal = Math.round(newVal * 10) / 10;
      const newStr = step < 1 ? newVal.toFixed(1) : String(Math.round(newVal));

      // Rebuild op with new operand
      const expSt = getExpFamilyState(op);
      if (expSt >= 0) {
        setExpFamilyState(op, expSt, newStr);
      } else {
        op.operand = newStr;
        const info = getRotationInfo(op);
        if (info) setArithState(op, info.curState);
      }
      applyOpsChange();
    }, { passive: false });
    addTouchScroll(hit);
  }

  svg.appendChild(gHex);
  svg.appendChild(gPipe);
  svg.appendChild(gArms);
  svg.appendChild(gSpokes);
  svg.appendChild(gFills);
  svg.appendChild(gFront);
  svg.appendChild(gInteract);
  return svg;
}

// ==================================================================
// ---- Equals-marker drag interaction ------------------------------
// Lets the user drag the "=" around a ring to rotate arms,
// rearranging the equation.  Turnstile mode: the ring's arrows
// follow the cursor angle in real-time and snap to the nearest
// arm on release (or auto-snap when very close).
// ==================================================================

/** Module-level state for continuing drag across SVG rebuilds */
let _eqDragContinuation = null; // { pointerId, clientX, clientY, fromId, toId, curT }

function attachEqualsDrag(svg, layout) {
  const grabs = svg.querySelectorAll('.equals-grab');
  if (!grabs.length) return;
  const { nodes } = layout;
  const rootOpId = layout.mainPath.opIds[0];
  const CR = layout._CR || 34.5;
  const EQ_ALEN = 8, EQ_AHW = 3.5, EQ_GAP = 2;

  /** Convert a pointer event to SVG-space coords */
  function svgPoint(evt) {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX; pt.y = evt.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    return pt.matrixTransform(ctm.inverse());
  }

  // ================================================================
  // Build the full pipe-edge network from the layout
  // ================================================================
  const networkEdges = []; // { fromId, toId, fromX, fromY, toX, toY, len, ux, uy }

  function addEdge(fromId, toId) {
    const fromN = fromId === 'y'
      ? { x: layout._yX, y: layout._yY }
      : nodes[fromId];
    const toN = nodes[toId];
    if (!fromN || !toN || fromN.x == null || toN.x == null) return;
    const dx = toN.x - fromN.x, dy = toN.y - fromN.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) return;
    networkEdges.push({
      fromId, toId,
      fromX: fromN.x, fromY: fromN.y,
      toX: toN.x, toY: toN.y,
      len, ux: dx / len, uy: dy / len
    });
  }

  addEdge('y', rootOpId);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n) continue;
    if (n.type === 'op') {
      if (n.leftId != null) addEdge(i, n.leftId);
      if (n.rightId != null && n.rightId !== n.leftId) addEdge(i, n.rightId);
    } else if (n.type === 'intermediate') {
      if (n.connectsToOpId != null) addEdge(i, n.connectsToOpId);
    }
  }


  // ================================================================
  // Helpers
  // ================================================================

  /** Find the edge index matching the current equalsEdge state */
  function findCurrentEdgeIdx() {
    const eq = state.equalsEdge;
    if (!eq) {
      return networkEdges.findIndex(
        e => e.fromId === 'y' && e.toId === rootOpId
      );
    }
    return networkEdges.findIndex(
      e => String(e.fromId) === String(eq.fromId) &&
        String(e.toId) === String(eq.toId)
    );
  }

  const SLIDE_MARGIN = 5; // small margin from node centers

  // ================================================================
  // Drag state
  // ================================================================
  let dragging = false;
  let curEdgeIdx = -1;
  let curT = 0;                // world-unit parameter along current edge
  let eqTriA = null, eqTriB = null, eqGrabEl = null;
  let dragMoved = false;       // did the cursor actually move during the drag?
  let savedPointerId = null;   // for re-capturing pointer after SVG rebuild
  let lastClientX = 0, lastClientY = 0; // last pointer position

  // ================================================================
  // Visual marker update - sets SVG attributes directly, no rebuild
  // ================================================================
  function updateMarkerVisual(mx, my, ux, uy) {
    const nx = -uy, ny = ux;
    // Triangle A: tip toward to-end
    const tax = mx - (EQ_GAP / 2) * ux, tay = my - (EQ_GAP / 2) * uy;
    const abx = tax - EQ_ALEN * ux, aby = tay - EQ_ALEN * uy;
    if (eqTriA) {
      eqTriA.setAttribute('points',
        `${tax},${tay} ${abx + EQ_AHW * nx},${aby + EQ_AHW * ny} ${abx - EQ_AHW * nx},${aby - EQ_AHW * ny}`);
      eqTriA.removeAttribute('transform');
    }
    // Triangle B: tip toward from-end
    const tbx = mx + (EQ_GAP / 2) * ux, tby = my + (EQ_GAP / 2) * uy;
    const bbx = tbx + EQ_ALEN * ux, bby = tby + EQ_ALEN * uy;
    if (eqTriB) {
      eqTriB.setAttribute('points',
        `${tbx},${tby} ${bbx + EQ_AHW * nx},${bby + EQ_AHW * ny} ${bbx - EQ_AHW * nx},${bby - EQ_AHW * ny}`);
      eqTriB.removeAttribute('transform');
    }

    // Grab circle
    if (eqGrabEl) {
      eqGrabEl.setAttribute('cx', mx);
      eqGrabEl.setAttribute('cy', my);
    }
  }

  // ================================================================
  // Core sliding logic — find the closest point on ANY edge in the
  // network and place the marker there.  No junction transitions needed.
  // ================================================================
  function slideToPosition(cursorPt) {
    const prevEdgeIdx = curEdgeIdx;
    let bestEdge = -1, bestDist = Infinity, bestT = 0;
    for (let i = 0; i < networkEdges.length; i++) {
      const e = networkEdges[i];
      const relX = cursorPt.x - e.fromX;
      const relY = cursorPt.y - e.fromY;
      let t = relX * e.ux + relY * e.uy;
      const tMin = SLIDE_MARGIN;
      const tMax = Math.max(tMin, e.len - SLIDE_MARGIN);
      t = Math.max(tMin, Math.min(tMax, t));
      // perpendicular distance from cursor to this clamped point
      const px = e.fromX + t * e.ux;
      const py = e.fromY + t * e.uy;
      const dist = Math.hypot(cursorPt.x - px, cursorPt.y - py);
      if (dist < bestDist) {
        bestDist = dist;
        bestT = t;
        bestEdge = i;
      }
    }
    if (bestEdge >= 0) {
      curEdgeIdx = bestEdge;
      curT = bestT;
    }

    // If the edge changed, do a live equation update + SVG rebuild
    if (prevEdgeIdx >= 0 && curEdgeIdx !== prevEdgeIdx) {
      liveEdgeUpdate();
      return; // this closure is dead after SVG rebuild
    }

    // Update visual
    const edge = networkEdges[curEdgeIdx];
    if (!edge) return;
    const mx = edge.fromX + curT * edge.ux;
    const my = edge.fromY + curT * edge.uy;
    updateMarkerVisual(mx, my, edge.ux, edge.uy);
  }

  // ================================================================
  // Live edge update — called mid-drag when the marker crosses to a
  // different pipe.  Updates the equation + rebuilds SVG + resumes drag.
  // ================================================================
  function liveEdgeUpdate() {
    const edge = networkEdges[curEdgeIdx];
    if (!edge) return;

    // Compute new equalsEdge from current edge
    let newEq;
    if (edge.fromId === 'y') {
      newEq = null;
    } else {
      newEq = { fromId: edge.fromId, toId: edge.toId };
      newEq.atToEnd = curT > edge.len / 2;
    }
    state.equalsEdge = newEq;

    // Save continuation so the new attachEqualsDrag can resume the drag
    _eqDragContinuation = {
      pointerId: savedPointerId,
      clientX: lastClientX,
      clientY: lastClientY,
      fromId: edge.fromId,
      toId: edge.toId,
      curT: curT
    };
    dragging = false;

    _swapInProgress = true;
    try {
      const eqResult = generateEquation(layout, state.equalsEdge);
      if (eqResult) {
        applyEqualsResult(eqResult);
      } else {
        const treeResult = _walkPipeTree(layout);
        if (treeResult) {
          if (ui.exprEl) { ui.exprEl.value = treeResult.text; autoSizeInput(); }
          state.lastExpr = treeResult.text;
          state.fn = compileExpression(treeResult.text);
          state.displaySpans = treeResult.spans;
        }
      }
      renderStepRepresentation();
      updateInputOverlay();
      updateLatexDisplay(ui.exprEl?.value ?? "");
    } catch (err) {
      console.error("[liveEdgeUpdate]", err);
    } finally {
      requestAnimationFrame(() => { _swapInProgress = false; });
    }
  }

  /** Reset marker visuals to the official rendered position */
  function resetMarkerVisual() {
    const idx = findCurrentEdgeIdx();
    if (idx < 0) return;
    const edge = networkEdges[idx];
    if (!edge) return;
    const atToEnd = state.equalsEdge?.atToEnd;
    const t = atToEnd ? (edge.len - CR) : CR;
    const mx = edge.fromX + t * edge.ux;
    const my = edge.fromY + t * edge.uy;
    updateMarkerVisual(mx, my, edge.ux, edge.uy);
  }

  // ================================================================
  // Commit - called on pointer release.  Sets state.equalsEdge and
  // rebuilds the SVG exactly once.  Returns true if a rebuild happened.
  // ================================================================
  function commitPosition() {
    if (curEdgeIdx < 0) return false;
    const edge = networkEdges[curEdgeIdx];
    if (!edge) return false;
    if (!dragMoved) return false;

    let newEq;
    if (edge.fromId === 'y') {
      newEq = null; // Y->root = default
    } else {
      newEq = { fromId: edge.fromId, toId: edge.toId };
      newEq.atToEnd = curT > edge.len / 2;
    }

    // Skip rebuild if nothing changed
    const oldEq = state.equalsEdge;
    const same = (!newEq && !oldEq) ||
      (newEq && oldEq &&
        String(newEq.fromId) === String(oldEq.fromId) &&
        String(newEq.toId) === String(oldEq.toId) &&
        !!newEq.atToEnd === !!oldEq.atToEnd);
    if (same) return false;

    state.equalsEdge = newEq;
    _swapInProgress = true;
    try {
      const eqResult = generateEquation(layout, state.equalsEdge);
      if (eqResult) {
        applyEqualsResult(eqResult);
      } else {
        const treeResult = _walkPipeTree(layout);
        if (treeResult) {
          if (ui.exprEl) { ui.exprEl.value = treeResult.text; autoSizeInput(); }
          state.lastExpr = treeResult.text;
          state.fn = compileExpression(treeResult.text);
          state.displaySpans = treeResult.spans;
        }
      }
      renderStepRepresentation();
      updateInputOverlay();
      updateLatexDisplay(ui.exprEl?.value ?? "");
    } catch (err) {
      console.error("[commitPosition]", err);
    } finally {
      requestAnimationFrame(() => { _swapInProgress = false; });
    }
    return true;
  }

  // ================================================================
  // Pointer event handlers
  // ================================================================
  function onPointerDown(e) {
    e.preventDefault();
    e.stopPropagation();
    const grab = e.currentTarget;

    curEdgeIdx = findCurrentEdgeIdx();
    if (curEdgeIdx < 0) return;
    grab.setPointerCapture(e.pointerId);

    const edge = networkEdges[curEdgeIdx];
    const atToEnd = state.equalsEdge?.atToEnd;
    curT = atToEnd ? (edge.len - CR) : CR;

    eqTriA = svg.querySelector('.eq-tri-a');
    eqTriB = svg.querySelector('.eq-tri-b');
    eqGrabEl = grab;
    dragMoved = false;
    dragging = true;
    savedPointerId = e.pointerId;
    lastClientX = e.clientX;
    lastClientY = e.clientY;
    grab.style.cursor = 'grabbing';
  }

  function onPointerMove(e) {
    if (!dragging) return;
    dragMoved = true;
    lastClientX = e.clientX;
    lastClientY = e.clientY;
    slideToPosition(svgPoint(e));
    // Dim the accordion if the cursor is behind/over it
    const ew = document.getElementById('expr-window');
    if (ew) {
      const r = ew.getBoundingClientRect();
      const over = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      ew.classList.toggle('dragging-dimmed', over);
    }
  }

  function onPointerUp(e) {
    if (!dragging) return;
    dragging = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
    e.currentTarget.style.cursor = 'grab';
    if (!commitPosition()) resetMarkerVisual();
    const ew = document.getElementById('expr-window');
    if (ew) ew.classList.remove('dragging-dimmed');
  }

  function onLostPointerCapture() {
    if (!dragging) return;
    dragging = false;
    if (eqGrabEl) eqGrabEl.style.cursor = 'grab';
    if (!commitPosition()) resetMarkerVisual();
    const ew = document.getElementById('expr-window');
    if (ew) ew.classList.remove('dragging-dimmed');
  }

  // Attach events to all grab circles
  grabs.forEach(g => {
    g.addEventListener('pointerdown', onPointerDown);
    g.addEventListener('pointermove', onPointerMove);
    g.addEventListener('pointerup', onPointerUp);
    g.addEventListener('lostpointercapture', onLostPointerCapture);
  });

  // ================================================================
  // Continuation: resume drag after SVG rebuild from liveEdgeUpdate
  // ================================================================
  if (_eqDragContinuation) {
    const cont = _eqDragContinuation;
    _eqDragContinuation = null;

    // Find the edge matching the continuation state
    const matchIdx = networkEdges.findIndex(
      e => String(e.fromId) === String(cont.fromId) &&
        String(e.toId) === String(cont.toId)
    );
    if (matchIdx < 0) return;

    curEdgeIdx = matchIdx;
    curT = cont.curT;

    // Find the closest grab circle to the last pointer position
    let bestGrab = null, bestDist = Infinity;
    const ctm = svg.getScreenCTM();
    if (ctm) {
      grabs.forEach(g => {
        const cx = parseFloat(g.getAttribute('cx'));
        const cy = parseFloat(g.getAttribute('cy'));
        const pt = svg.createSVGPoint();
        pt.x = cx; pt.y = cy;
        const scr = pt.matrixTransform(ctm);
        const d = Math.hypot(scr.x - cont.clientX, scr.y - cont.clientY);
        if (d < bestDist) { bestDist = d; bestGrab = g; }
      });
    }

    if (bestGrab) {
      try {
        bestGrab.setPointerCapture(cont.pointerId);
        eqTriA = svg.querySelector('.eq-tri-a');
        eqTriB = svg.querySelector('.eq-tri-b');
        eqGrabEl = bestGrab;
        savedPointerId = cont.pointerId;
        lastClientX = cont.clientX;
        lastClientY = cont.clientY;
        dragging = true;
        dragMoved = true;
        bestGrab.style.cursor = 'grabbing';

        // Position the marker at the continued position
        const edge = networkEdges[curEdgeIdx];
        if (edge) {
          const mx = edge.fromX + curT * edge.ux;
          const my = edge.fromY + curT * edge.uy;
          updateMarkerVisual(mx, my, edge.ux, edge.uy);
        }
      } catch (_) {
        // Pointer was released during rebuild — no continuation
      }
    }
  }
}

/** Perform one step of equals rotation: the equals marker moves from
 *  one arm position to another on a given operator node's ring.
 *  This does NOT change arm assignments — the math stays the same.
 *  It only moves the equals cut point and regenerates the equation display.
 */
function performEqualsRotation(nodeId, fromArm, toArm, layout, opts) {
  if (!opts) opts = {};
  const { nodes } = layout;
  const node = nodes[nodeId];
  if (!node) return;

  // ---- Handle intermediate nodes ----
  if (node.type === 'intermediate') {
    if (toArm === 'child') {
      // Moving deeper through the intermediate toward its child op
      state.equalsEdge = { fromId: nodeId, toId: node.connectsToOpId };
    } else if (toArm === 'output') {
      // Moving back toward parent
      let parentId = null;
      for (let i = 0; i < nodes.length; i++) {
        const pn = nodes[i];
        if (pn && pn.type === 'op' && (pn.leftId === nodeId || pn.rightId === nodeId)) {
          parentId = i; break;
        }
      }
      if (parentId != null) {
        state.equalsEdge = { fromId: parentId, toId: nodeId };
      }
    }
    // Fall through to equation regeneration below
  } else if (!node.armAssignment) {
    return;
  } else {
    // ---- Handle op nodes (existing logic) ----
    // Update the equals edge: from fromArm to toArm on this node's ring
    if (toArm === 'output') {
      // Equals moved back toward Y
      const rootOpId = layout.mainPath.opIds[0];
      if (nodeId === rootOpId) {
        state.equalsEdge = null; // back to Y→root (default)
      } else {
        // Find the parent node
        let parentId = null;
        for (let i = 0; i < nodes.length; i++) {
          const pn = nodes[i];
          if (pn && (pn.leftId === nodeId || pn.rightId === nodeId)) {
            parentId = i; break;
          }
          if (pn && pn.type === "intermediate" && pn.connectsToOpId === nodeId) {
            parentId = i; break;
          }
        }
        if (parentId != null) {
          state.equalsEdge = { fromId: parentId, toId: nodeId };
        } else {
          state.equalsEdge = null;
        }
      }
    } else {
      // Equals moved toward a child
      const childId = toArm === 'left' ? node.leftId : node.rightId;
      state.equalsEdge = { fromId: nodeId, toId: childId };
    }
  }

  // Apply atToEnd positioning if specified by the caller
  if (opts.atToEnd !== undefined && state.equalsEdge) {
    state.equalsEdge.atToEnd = opts.atToEnd;
  }

  _swapInProgress = true;
  try {
    const eqResult = generateEquation(layout, state.equalsEdge);
    if (eqResult) {
      applyEqualsResult(eqResult);
    } else {
      // Back to default (equalsEdge = null): restore normal expression display
      state.equalsLhsSpans = null;
      state.equalsFullSpans = null;
      state.equalsRhsExpr = null;
      const treeResult = _walkPipeTree(layout);
      if (treeResult) {
        if (ui.exprEl) { ui.exprEl.value = treeResult.text; autoSizeInput(); }
        state.lastExpr = treeResult.text;
        state.fn = compileExpression(treeResult.text);
        state.displaySpans = treeResult.spans;
      }
    }
    renderStepRepresentation();
    updateInputOverlay();
    updateLatexDisplay(ui.exprEl?.value ?? "");
  } catch (err) {
    console.error("[equalsRotation]", err);
  } finally {
    requestAnimationFrame(() => { _swapInProgress = false; });
  }
}

/**
 * Generate a full equation (LHS = RHS) based on the equals edge position.
 * Traces from Y down to the cut point, applying inverse operations at each
 * node along the path. Builds coloured spans for both sides.
 *
 * Returns { fullText, fullSpans, lhsSpans, lhsText, rhsExpr } where:
 *   fullText = "LHS = RHS" for display
 *   fullSpans = coloured spans for the full equation (tree order)
 *   lhsSpans = coloured spans for the LHS only
 *   lhsText  = raw LHS text
 *   rhsExpr  = the RHS as a compilable expression (for the plot function)
 */
function generateEquation(layout, equalsEdge) {
  if (!equalsEdge) return null; // default position = standard y = expr

  const { nodes } = layout;
  const rootOpId = layout.mainPath.opIds[0];

  // Build the path from root down to the equals edge target node.
  // At each operator node on the path, the "other" arm (not on the path) 
  // gets peeled off and applied as an inverse to the LHS.
  function findPathToNode(targetNodeId) {
    // BFS/DFS from root to find the path to targetNodeId
    const path = []; // array of { nodeId, armToChild: 'left'|'right' }
    function dfs(nodeId) {
      if (nodeId == null) return false;
      const nd = nodes[nodeId];
      if (!nd) return false;
      if (nodeId === targetNodeId) return true;
      if (nd.type === "intermediate") {
        if (nd.connectsToOpId != null && dfs(nd.connectsToOpId)) {
          return true;
        }
        return false;
      }
      if (nd.type !== "op") return false;
      // Try left
      if (nd.leftId != null && dfs(nd.leftId)) {
        path.push({ nodeId, armToChild: 'left' });
        return true;
      }
      // Try right
      if (nd.rightId != null && nd.rightId !== nd.leftId && dfs(nd.rightId)) {
        path.push({ nodeId, armToChild: 'right' });
        return true;
      }
      return false;
    }
    dfs(rootOpId);
    path.reverse(); // root at index 0
    return path;
  }

  // Determine the target: the deeper node of the equals edge
  const targetId = equalsEdge.toId;
  const pathDown = findPathToNode(targetId);

  // Verify the layout tree is walkable
  if (!_walkPipeTree(layout)) return null;

  // For now, produce a simple display: the full expression with "=" marker
  // More sophisticated LHS/RHS splitting to come
  // Placeholder: show "y = expr" still but with the equals position noted
  function sp(text, color, opacity) {
    const s = { text, color };
    if (opacity !== undefined) s.opacity = opacity;
    return s;
  }

  // Build LHS by tracing from Y to the equals edge, inverting each op
  let lhsText = "y";
  let lhsSpans = [sp("y", OP_COLORS.y)];

  for (const step of pathDown) {
    const nd = nodes[step.nodeId];
    if (!nd || !nd.armAssignment) continue;
    const cat = nd.armCategory || _categoryForOpType(nd.opType);
    const roles = nd.armAssignment;
    if (!cat || !roles) continue;

    // The "output" arm is what feeds toward Y.
    // The arm going toward the child on the path is step.armToChild.
    // The "other" arm is the one NOT on the path and NOT the output.
    const positions = ['output', 'left', 'right'];
    const otherArm = positions.find(p => p !== 'output' && p !== step.armToChild);
    if (!otherArm) continue;

    // Get the subtree expression for the "other" arm
    const otherNodeId = otherArm === 'left' ? nd.leftId : nd.rightId;
    const otherResult = _walkSubtree(layout, otherNodeId);
    const otherText = otherResult ? otherResult.text : "?";
    const rawOtherSpans = otherResult ? otherResult.spans : [sp("?", "var(--muted)")];

    // Determine what inverse to apply based on the operator and which arm is which
    const outputRole = roles.output;
    const pathRole = roles[step.armToChild];
    const otherRole = roles[otherArm];
    const badge = OP_COLORS[cat] || OP_COLORS.misc;

    // Apply arm color to uncolored spans (var(--text) means _walkSubtree left them default)
    const otherArmColor = (ARM_COLORS[cat] && ARM_COLORS[cat][otherRole]) || badge;
    const otherSpans = rawOtherSpans.map(s =>
      s.color === "var(--text)" ? { ...s, color: otherArmColor } : s
    );

    // Apply the inverse: LHS = inverse(LHS, otherArm)
    if (cat === "addSub") {
      // a + b = c → if output=c (sum), path=a, other=b: LHS - b
      // if output=c, path=b, other=a: LHS - a
      // if output=a (difference), path is going toward sum(c) or subtrahend(b)
      if (outputRole === "3") {
        // output is the sum; we're peeling off the "other" addend
        lhsText = `${lhsText} - ${otherText}`;
        lhsSpans = [...lhsSpans, sp(" - ", badge), ...otherSpans];
      } else if (outputRole === "1" || outputRole === "2") {
        // output is a part; the sum is on one of the child arms
        // If other = the sum arm: LHS = other - LHS... no.
        // Actually: output = sum - other_part. So sum = output + other_part.
        // LHS (which started as y = output) going deeper...
        // If path goes toward sum (role 3): LHS - other = path_arm
        // If path goes toward subtrahend: need to invert differently
        if (pathRole === "3") {
          // LHS + other = sum
          lhsText = `${lhsText} + ${otherText}`;
          lhsSpans = [...lhsSpans, sp(" + ", badge), ...otherSpans];
        } else {
          // Path goes to the subtrahend. output = sum - path → path = sum - output
          // LHS = output, so path = other(sum) - LHS → LHS = other - path
          // Actually this gets complex. For addSub:
          // role 1 + role 2 = role 3
          // If output = "1": y = role3 - role2. Path goes deeper into role3 or role2.
          //   If path → role3 (sum side): need to invert: role3 = y + role2 → LHS + other
          //   If path → role2 (subtrahend side): role2 = role3 - y → LHS = other(role3) - LHS... tricky
          // Let's handle the simple cases first
          lhsText = `${otherText} - ${lhsText}`;
          lhsSpans = [...otherSpans, sp(" - ", badge), ...lhsSpans];
        }
      }
    } else if (cat === "mulDiv") {
      if (outputRole === "8") {
        // output is the product: LHS / other
        lhsText = `${lhsText}/${otherText}`;
        lhsSpans = [...lhsSpans, sp("/", badge), ...otherSpans];
      } else if (pathRole === "8") {
        // path goes to the product side: LHS * other = product
        lhsText = `${lhsText}*${otherText}`;
        lhsSpans = [...lhsSpans, sp(" \u00d7 ", badge), ...otherSpans];
      } else {
        // path goes to the other factor: product / LHS = path
        lhsText = `${otherText}/${lhsText}`;
        lhsSpans = [...otherSpans, sp("/", badge), ...lhsSpans];
      }
    } else if (cat === "exp") {
      if (outputRole === "power") {
        // output is the power: base^exp = y → base = y^(1/exp) or exp = log_base(y)
        if (pathRole === "base") {
          lhsText = `nthrt_${otherText}(${lhsText})`;
          lhsSpans = [sp("nthrt_", badge), ...otherSpans, sp("(", "var(--muted)", 0.35), ...lhsSpans, sp(")", "var(--muted)", 0.35)];
        } else {
          lhsText = `log_${otherText}(${lhsText})`;
          lhsSpans = [sp("log_", badge), ...otherSpans, sp("(", "var(--muted)", 0.35), ...lhsSpans, sp(")", "var(--muted)", 0.35)];
        }
      } else if (outputRole === "base") {
        if (pathRole === "power") {
          lhsText = `${lhsText}^${otherText}`;
          lhsSpans = [...lhsSpans, sp("^", badge), ...otherSpans];
        } else {
          lhsText = `log_${lhsText}(${otherText})`;
          lhsSpans = [sp("log_", badge), ...lhsSpans, sp("(", "var(--muted)", 0.35), ...otherSpans, sp(")", "var(--muted)", 0.35)];
        }
      } else if (outputRole === "exponent") {
        if (pathRole === "power") {
          lhsText = `${otherText}^${lhsText}`;
          lhsSpans = [...otherSpans, sp("^", badge), ...lhsSpans];
        } else {
          lhsText = `nthrt_${lhsText}(${otherText})`;
          lhsSpans = [sp("nthrt_", badge), ...lhsSpans, sp("(", "var(--muted)", 0.35), ...otherSpans, sp(")", "var(--muted)", 0.35)];
        }
      }
    }
  }

  // RHS: the subtree below the cut
  const rhsResult = _walkSubtree(layout, targetId);
  const rhsText = rhsResult ? rhsResult.text : "?";
  const rhsSpans = rhsResult ? rhsResult.spans : [sp("?", "var(--muted)")];

  // Combine: LHS = RHS
  const fullText = `${lhsText} = ${rhsText}`;
  const fullSpans = [
    ...lhsSpans,
    sp(" = ", "var(--text)"),
    ...rhsSpans
  ];

  return { fullText, fullSpans, lhsSpans, lhsText, rhsExpr: rhsText };
}

/**
 * Rebuild displaySpans for equalsEdge mode based on the current display order
 * (sequential vs traditional).  Updates the input text and state accordingly.
 * Called when equalsEdge data changes or when the display order toggles.
 */
function rebuildEqualsDisplaySpans() {
  if (!state.equalsEdge || !state.equalsLhsSpans || !state.equalsRhsExpr) return;

  let displaySpans;
  if (state.latexOpsOrder) {
    // Sequential mode: linearize the RHS and build ops-order spans
    try {
      const { ops: rhsOps } = parseAndLinearize(state.equalsRhsExpr);
      const seqResult = buildDisplayExpr(rhsOps);
      displaySpans = [
        ...state.equalsLhsSpans,
        { text: " = ", color: "var(--text)" },
        ...seqResult.spans
      ];
    } catch {
      displaySpans = state.equalsFullSpans;
    }
  } else {
    displaySpans = state.equalsFullSpans;
  }

  state.displaySpans = displaySpans;
  const inputText = displaySpans.map(s => s.text).join('');
  if (ui.exprEl) { ui.exprEl.value = inputText; autoSizeInput(); }
  state.lastExpr = inputText;
}

/**
 * Store generateEquation results in state and rebuild the display.
 * Used by all three equalsEdge handler call sites.
 */
function applyEqualsResult(eqResult) {
  const { fullSpans, lhsSpans, rhsExpr } = eqResult;
  state.equalsLhsSpans = lhsSpans;
  state.equalsFullSpans = fullSpans;
  state.equalsRhsExpr = rhsExpr;
  state.fn = compileExpression(rhsExpr);
  rebuildEqualsDisplaySpans();
}

function renderStepRepresentation() {
  const el = document.getElementById("step-rep");
  const label = document.getElementById("step-rep-label");
  if (!el) return;
  el.innerHTML = "";
  const ops = state.ops;
  const pipeLayout = state.pipeLayout || null;

  el.classList.remove("step-rep--empty");
  // label is kept hidden; checkboxes preserved for JS state only

  try {
    const intCb = document.getElementById("show-intermediates");
    const showInt = intCb ? intCb.checked : true;
    const horzCb = document.getElementById("pipe-horizontal");
    const horz = horzCb ? horzCb.checked : false;
    const dbgCb = document.getElementById("pipe-debug-labels");
    const showDbg = dbgCb ? dbgCb.checked : false;
    const armCb = document.getElementById("pipe-arm-labels");
    const showArm = armCb ? armCb.checked : false;
    const svg = pipeLayout
      ? renderPipeDiagramDag(ops, pipeLayout, showInt, horz, showDbg, showArm)
      : renderPipeDiagram(ops, null, showInt);
    el.appendChild(svg);

    // ---- Attach equals-marker drag interaction ----
    if (pipeLayout) {
      attachEqualsDrag(svg, pipeLayout);
    }
  } catch (err) {
    console.error("[PipeDiagram] render error:", err);
    el.textContent = "⚠ " + err.message;
  }
}

// Hook up pipe diagram toggles
(function () {
  const ids = ["show-intermediates", "pipe-horizontal", "pipe-debug-labels", "pipe-arm-labels"];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", () => renderStepRepresentation());
  });
})();

/**
 * Apply step-derived colors to connectors (arrows between op boxes).
 * Called both when cursor is on canvas AND when it's off, so connectors stay colored.
 */
function applyConnectorColors(arrowCols) {
  for (let j = 0; j < arrowCols.length; j++) {
    const ac = arrowCols[j];
    const fwdHex = j === 0 ? OP_COLORS.x
      : (OP_COLORS[getOpCategory(state.ops[j - 1])] || OP_COLORS.misc);
    const invHex = j < state.ops.length
      ? (OP_COLORS[getOpCategory(state.ops[j])] || OP_COLORS.misc)
      : OP_COLORS.y;
    const cfwd = ac.querySelector('.connector-fwd');
    const cinv = ac.querySelector('.connector-inv');
    if (cfwd) {
      cfwd.style.color = fwdHex;
      cfwd.style.background = fwdHex + '26';
      cfwd.style.borderColor = fwdHex + '33';
    }
    if (cinv) {
      cinv.style.color = invHex;
      cinv.style.background = invHex + '26';
      cinv.style.borderColor = invHex + '33';
    }
  }
}

// ==================================================================
// ---- DAG live-value evaluator for the expression tree --------
// ==================================================================

/**
 * Evaluate every node in a pipeLayout DAG at the given x value.
 * Returns a Map<nodeId, number>.  Respects arm-assignment swaps.
 */
function evaluateDagAtX(layout, x) {
  if (!layout || !layout.nodes) return null;
  const nodes = layout.nodes;
  const vals = new Map();

  function catFor(opType) {
    if (opType === "add" || opType === "sub") return "addSub";
    if (opType === "mul" || opType === "div") return "mulDiv";
    if (opType === "power") return "exp";
    return null;
  }

  function ev(id) {
    if (vals.has(id)) return vals.get(id);
    const n = nodes[id];
    if (!n) { vals.set(id, NaN); return NaN; }
    let result;

    if (n.type === "value") {
      if (n.value === "x") result = x;
      else if (n.value === "pi") result = Math.PI;
      else if (n.value === "e") result = Math.E;
      else if (n.value === "tau") result = 2 * Math.PI;
      else { result = parseFloat(n.value); if (!Number.isFinite(result)) result = NaN; }
    } else if (n.type === "intermediate") {
      result = ev(n.sourceOpId);
    } else if (n.type === "op") {
      const cat = n.armCategory || catFor(n.opType);
      const roles = n.armAssignment;

      if (n.opType === "call" && (!cat || cat === null)) {
        // Function call — apply named function to left child
        const arg = ev(n.leftId);
        const fn = (n.ast && n.ast.fn) || (n.symbol ? n.symbol.replace("()", "") : "");
        switch (fn) {
          case "sin": result = Math.sin(arg); break;
          case "cos": result = Math.cos(arg); break;
          case "tan": result = Math.tan(arg); break;
          case "asin": result = Math.asin(arg); break;
          case "acos": result = Math.acos(arg); break;
          case "atan": result = Math.atan(arg); break;
          case "sqrt": result = arg < 0 ? NaN : Math.sqrt(arg); break;
          case "abs": result = Math.abs(arg); break;
          case "exp": result = Math.exp(arg); break;
          case "log": result = Math.log(arg) / Math.LN10; break;
          case "ln": result = Math.log(arg); break;
          case "floor": result = Math.floor(arg); break;
          case "ceil": result = Math.ceil(arg); break;
          case "round": result = Math.round(arg); break;
          default: result = NaN;
        }
      } else if (roles && cat) {
        // Category-aware evaluation with arm-swap support
        const leftVal = ev(n.leftId);
        const rightVal = n.rightId != null ? ev(n.rightId) : NaN;
        const byRole = {};
        byRole[roles.left] = leftVal;
        if (roles.right) byRole[roles.right] = rightVal;

        if (cat === "addSub") {
          // arm1 + arm2 = arm3
          if (roles.output === "3") result = (byRole["1"] || 0) + (byRole["2"] || 0);
          else if (roles.output === "1") result = (byRole["3"] || 0) - (byRole["2"] || 0);
          else if (roles.output === "2") result = (byRole["3"] || 0) - (byRole["1"] || 0);
          else result = NaN;
        } else if (cat === "mulDiv") {
          // arm2 × arm4 = arm8
          if (roles.output === "8") result = (byRole["2"] || 0) * (byRole["4"] || 0);
          else if (roles.output === "2") result = (byRole["8"] || 0) / (byRole["4"] || 1);
          else if (roles.output === "4") result = (byRole["8"] || 0) / (byRole["2"] || 1);
          else result = NaN;
        } else if (cat === "exp") {
          // base ^ exponent = power
          const base = byRole.base, expo = byRole.exponent, pow = byRole.power;
          if (roles.output === "power") {
            result = (base >= 0 || expo === Math.floor(expo)) ? Math.pow(base, expo) : NaN;
          } else if (roles.output === "base") {
            result = (pow >= 0 || (1 / expo) === Math.floor(1 / expo)) ? Math.pow(pow, 1 / expo) : NaN;
          } else if (roles.output === "exponent") {
            result = Math.log(pow) / Math.log(base);
          } else result = NaN;
        } else result = NaN;
      } else {
        // No arm assignment — use basic opType
        const lv = ev(n.leftId);
        const rv = n.rightId != null ? ev(n.rightId) : NaN;
        switch (n.opType) {
          case "add": result = lv + rv; break;
          case "sub": result = lv - rv; break;
          case "mul": result = lv * rv; break;
          case "div": result = lv / rv; break;
          case "power": result = (lv >= 0 || rv === Math.floor(rv)) ? Math.pow(lv, rv) : NaN; break;
          case "mod": result = ((lv % rv) + rv) % rv; break;
          default: result = NaN;
        }
      }
    } else {
      result = NaN;
    }

    vals.set(id, result);
    return result;
  }

  for (let i = 0; i < nodes.length; i++) ev(i);
  return vals;
}

/**
 * Update the live value display inside the expression-tree SVG.
 * Called every frame while the cursor is on the canvas.
 * Pass xVal = null to revert to default labels.
 */
function updateLiveDagValues(xVal) {
  const layout = state.pipeLayout;
  if (!layout || !layout.nodes) return;
  const nodes = layout.nodes;

  if (xVal === null || xVal === undefined) {
    // Revert: restore original text on value nodes and y-node, hide op/intermediate live labels
    for (const n of nodes) {
      if (n.type === "value" && n._textEl) {
        n._textEl.textContent = n.value;
        // Restore italic for variables, normal for numbers
        const isNumeric = /^-?[\d.]+$/.test(n.value);
        n._textEl.setAttribute("font-style", isNumeric ? "normal" : "italic");
        n._textEl.setAttribute("font-size", 32);
        try {
          const bbox = n._textEl.getBBox();
          if (bbox.width > 35) {
            const scaled = Math.floor(32 * 35 / bbox.width);
            n._textEl.setAttribute("font-size", Math.max(8, scaled));
          }
        } catch (_) { }
      }
      if (n.type === "op" && n._liveValueEl) {
        n._liveValueEl.setAttribute("display", "none");
      }
      if (n.type === "intermediate" && n._liveValueEl) {
        n._liveValueEl.setAttribute("display", "none");
        // Restore original intermediate badge size & transform
        if (n._circleEl) n._circleEl.removeAttribute("transform");
        n._liveValueEl.style.transformBox = "";
        n._liveValueEl.style.transformOrigin = "";
        if (n._liveValueOrigTransform) {
          n._liveValueEl.setAttribute("transform", n._liveValueOrigTransform);
        } else {
          n._liveValueEl.removeAttribute("transform");
        }
      }
    }
    if (layout._yTextEl) {
      layout._yTextEl.textContent = "y";
      layout._yTextEl.setAttribute("font-style", "italic");
      layout._yTextEl.setAttribute("font-size", 32);
    }
    return;
  }

  // Evaluate the full DAG at this x
  const vals = evaluateDagAtX(layout, xVal);
  if (!vals) return;

  // Root op is the last op on the main path → its value is "y"
  const rootOpId = layout.mainPath ? layout.mainPath.opIds[0] : null;

  for (const n of nodes) {
    if (n.type === "value" && n._textEl) {
      if (n.value === "x") {
        // Show live x value (non-italic for numbers)
        const v = vals.get(n.id);
        const txt = Number.isFinite(v) ? formatLiveNumber(v) : "\u2014";
        n._textEl.textContent = txt;
        n._textEl.setAttribute("font-style", "normal");
        // Auto-size to fit circle
        n._textEl.setAttribute("font-size", 24);
        try {
          const bbox = n._textEl.getBBox();
          if (bbox.width > 35) {
            const scaled = Math.floor(24 * 35 / bbox.width);
            n._textEl.setAttribute("font-size", Math.max(8, scaled));
          }
        } catch (_) { }
      }
      // Constants keep their label — no change needed
    }

    if (n.type === "op" && n._liveValueEl) {
      // Op live values are now displayed on intermediate nodes instead
      n._liveValueEl.setAttribute("display", "none");
    }

    if (n.type === "intermediate" && n._liveValueEl) {
      // Intermediate shows the output value of its sourceOp (the child op it wraps)
      const srcId = n.sourceOpId != null ? n.sourceOpId : n.connectsToOpId;
      const v = srcId != null ? vals.get(srcId) : undefined;
      if (v !== undefined) {
        const txt = Number.isFinite(v) ? formatLiveNumber(v) : "\u2014";
        n._liveValueEl.textContent = txt;
        n._liveValueEl.setAttribute("display", "");
        // Scale intermediate badge up to full value-badge size
        const intRad = 22 * 0.55; // R * 0.55
        const intScale = 22 / intRad; // ≈ 1.82
        const ix = n.x, iy = n.y;
        const circleXform = `translate(${ix},${iy}) scale(${intScale}) translate(${-ix},${-iy})`;
        if (n._circleEl) n._circleEl.setAttribute("transform", circleXform);
        // Override CSS transform-box so the SVG-coordinate scale works correctly
        n._liveValueEl.style.transformBox = "view-box";
        n._liveValueEl.style.transformOrigin = "0 0";
        // Scale & preserve original text transform (counter-rotation)
        const origT = n._liveValueOrigTransform || "";
        const rMatch = origT.match(/rotate\(([^\s,)]+)/);
        const cDeg = rMatch ? rMatch[1] : null;
        const textXform = cDeg
          ? `translate(${ix},${iy}) scale(${intScale}) rotate(${cDeg}) translate(${-ix},${-iy})`
          : circleXform;
        n._liveValueEl.setAttribute("transform", textXform);
        // Auto-size text to fit enlarged circle
        // Font-size and maxW are in LOCAL (pre-transform) coordinates;
        // both circle and text are scaled by intScale, so use intRad-based limits.
        const localFont = Math.round(24 / intScale); // visually ≈24 after scale
        const maxW = (22 * 1.6) / intScale;           // visually ≈35 after scale
        n._liveValueEl.setAttribute("font-size", localFont);
        try {
          const bbox = n._liveValueEl.getBBox();
          if (bbox.width > maxW) {
            const scaled = Math.floor(localFont * maxW / bbox.width);
            n._liveValueEl.setAttribute("font-size", Math.max(4, scaled));
          }
        } catch (_) { }
      } else {
        n._liveValueEl.setAttribute("display", "none");
        // Restore original size & transform
        if (n._circleEl) n._circleEl.removeAttribute("transform");
        if (n._liveValueOrigTransform) {
          n._liveValueEl.setAttribute("transform", n._liveValueOrigTransform);
        } else {
          n._liveValueEl.removeAttribute("transform");
        }
      }
    }
  }

  // Update y-node
  if (layout._yTextEl && rootOpId != null) {
    const yVal = vals.get(rootOpId);
    const txt = Number.isFinite(yVal) ? formatLiveNumber(yVal) : "\u2014";
    layout._yTextEl.textContent = txt;
    layout._yTextEl.setAttribute("font-style", "normal");
    layout._yTextEl.setAttribute("font-size", 24);
    try {
      const bbox = layout._yTextEl.getBBox();
      if (bbox.width > 35) {
        const scaled = Math.floor(24 * 35 / bbox.width);
        layout._yTextEl.setAttribute("font-size", Math.max(8, scaled));
      }
    } catch (_) { }
  }
}

function updateLiveOpValues(xVal) {
  const flow = document.querySelector('.step-flow');

  if (xVal === null || !state.fn) {
    // Revert text to defaults (but keep connector colors)
    if (flow) {
      const xEl = flow.querySelector('[data-live-role="x"]');
      const yEl = flow.querySelector('[data-live-role="y"]');
      const opBlocks = flow.querySelectorAll('.op-block');
      const arrowCols = flow.querySelectorAll('.step-arrows-col');
      if (xEl) { xEl.textContent = 'x'; xEl.style.color = ''; }
      if (yEl) { yEl.textContent = 'y'; yEl.style.color = ''; }
      for (const block of opBlocks) {
        const fwd = block.querySelector('[data-live-role="fwd"]');
        const inv = block.querySelector('[data-live-role="inv"]');
        if (fwd) { fwd.textContent = fwd.dataset.liveDefault || ''; fwd.style.color = ''; }
        if (inv) { inv.textContent = inv.dataset.liveDefault || ''; inv.style.color = ''; }
      }
      // Always keep connectors colored — apply colors even when cursor is off
      applyConnectorColors(arrowCols);
    }
    // Revert input overlay
    updateInputOverlay();
    return;
  }

  // Compute values through the forward chain
  const steps = state.steps || [];
  const values = [xVal];
  for (let k = 0; k < steps.length; k++) {
    let v;
    try { v = steps[k].fn(xVal); } catch { v = NaN; }
    values.push(v);
  }

  // Helper: get hex color for the step that produced values[idx]
  function colorAtValueIdx(vIdx) {
    // vIdx 0 = input x, vIdx 1 = after step[0] (identity x), etc.
    // ops[0] corresponds to steps[1], so values[i+2] is after ops[i]
    if (vIdx <= 1) return OP_COLORS.x;
    const opIdx = vIdx - 2;
    if (opIdx >= 0 && opIdx < state.ops.length) {
      return OP_COLORS[getOpCategory(state.ops[opIdx])] || OP_COLORS.misc;
    }
    return OP_COLORS.x;
  }

  // ---- Update step-flow UI (only if present) ----
  if (flow) {
    const xEl = flow.querySelector('[data-live-role="x"]');
    const yEl = flow.querySelector('[data-live-role="y"]');
    const opBlocks = flow.querySelectorAll('.op-block');
    const arrowCols = flow.querySelectorAll('.step-arrows-col');

    // x endpoint: x-color
    if (xEl) {
      xEl.textContent = formatLiveX(xVal);
      xEl.style.color = OP_COLORS.x;
    }

    // y endpoint: color of the last op (or x if no ops)
    const yVal = values[values.length - 1];
    const lastHex = state.ops.length > 0
      ? (OP_COLORS[getOpCategory(state.ops[state.ops.length - 1])] || OP_COLORS.misc)
      : OP_COLORS.x;
    if (yEl) {
      yEl.textContent = Number.isFinite(yVal) ? formatLiveNumber(yVal) : '\u2014';
      yEl.style.color = lastHex;
    }

    // Color connectors: fwd by preceding (left) box, inv by succeeding (right) box
    applyConnectorColors(arrowCols);

    // Each op block
    for (let i = 0; i < opBlocks.length; i++) {
      const block = opBlocks[i];
      const fwd = block.querySelector('[data-live-role="fwd"]');
      const inv = block.querySelector('[data-live-role="inv"]');

      const inputVal = (i + 1 < values.length) ? values[i + 1] : NaN;
      const outputVal = (i + 2 < values.length) ? values[i + 2] : NaN;

      // Fwd value colored by box to the LEFT, inv value colored by box to the RIGHT
      const prevHex = i === 0
        ? OP_COLORS.x
        : (OP_COLORS[getOpCategory(state.ops[i - 1])] || OP_COLORS.misc);
      // Box to the right: ops[i+1] if exists, else y
      const nextHex = i < state.ops.length - 1
        ? (OP_COLORS[getOpCategory(state.ops[i + 1])] || OP_COLORS.misc)
        : OP_COLORS.y;

      if (fwd) {
        const def = fwd.dataset.liveDefault || '';
        const sym = fwd.dataset.liveSym || def;
        const operand = fwd.dataset.liveOperand || '';
        const isRootOrder = fwd.dataset.liveOrder === 'root';
        if (Number.isFinite(inputVal)) {
          const v = formatLiveNumber(inputVal);
          if (sym.endsWith('()')) {
            const fn = sym.slice(0, -2);
            fwd.innerHTML = fn + '(<span style="color:' + prevHex + '">' + v + '</span>)';
          } else if (isRootOrder) {
            // Root exception: [operand] [sym] [input]
            fwd.innerHTML = operand + '&nbsp;' + sym + '&nbsp;<span style="color:' + prevHex + '">' + v + '</span>';
          } else if (operand) {
            // Normal: [input] [sym] [operand]
            fwd.innerHTML = '<span style="color:' + prevHex + '">' + v + '</span>&nbsp;' + sym + '&nbsp;' + operand;
          } else {
            fwd.innerHTML = '<span style="color:' + prevHex + '">' + v + '</span>&nbsp;' + sym;
          }
        } else {
          fwd.textContent = def;
          fwd.style.color = '';
        }
      }
      if (inv) {
        const def = inv.dataset.liveDefault || '';
        const sym = inv.dataset.liveSym || def;
        const operand = inv.dataset.liveOperand || '';
        const isRootOrder = inv.dataset.liveOrder === 'root';
        if (Number.isFinite(outputVal)) {
          const v = formatLiveNumber(outputVal);
          if (sym.endsWith('()')) {
            const fn = sym.slice(0, -2);
            inv.innerHTML = fn + '(<span style="color:' + nextHex + '">' + v + '</span>)';
          } else if (isRootOrder) {
            inv.innerHTML = operand + '&nbsp;' + sym + '&nbsp;<span style="color:' + nextHex + '">' + v + '</span>';
          } else if (operand) {
            inv.innerHTML = '<span style="color:' + nextHex + '">' + v + '</span>&nbsp;' + sym + '&nbsp;' + operand;
          } else {
            inv.innerHTML = '<span style="color:' + nextHex + '">' + v + '</span>&nbsp;' + sym;
          }
        } else {
          inv.textContent = def;
          inv.style.color = '';
        }
      }
    }
  }

  // Always update the text input box with live values (even without step-flow)
  updateLiveInputOverlay(xVal, values);
}

/**
 * Update the input text overlay with live computed values.
 * Replaces 'x' with the current value and shows the result.
 */
function updateLiveInputOverlay(xVal, values) {
  if (!ui.exprOverlay || !ui.exprEl) return;

  // Resolve source spans: prefer displaySpans, fall back to pipe-layout spans
  let srcSpans = state.displaySpans && state.displaySpans.length ? state.displaySpans : null;
  if (!srcSpans && state.pipeLayout && state.pipeLayout.nodes && state.pipeLayout.mainPath) {
    srcSpans = pipeLayoutToColoredSpans(state.pipeLayout);
  }
  if (!srcSpans || !srcSpans.length) return;

  const controlEl = ui.exprEl.closest('.control--expr');
  // Always prefer state.fn for y-value (steps chain may be incomplete for tree expressions)
  let yVal;
  if (state.fn) {
    try { yVal = state.fn(xVal); } catch { yVal = NaN; }
  } else {
    yVal = values[values.length - 1];
  }
  const xStr = formatLiveX(xVal);
  const yStr = Number.isFinite(yVal) ? formatLiveNumber(yVal) : '\u2014';

  // Rebuild the overlay from spans, replacing 'x' with the live value
  const html = srcSpans.map(s => {
    const opacity = s.isBracket ? 0.35 : (s.opacity || 1);
    if (s.text === 'x') {
      return '<span style="color:' + OP_COLORS.x + ';opacity:' + opacity + '">' + escapeHtml(xStr) + '</span>';
    }
    return '<span style="color:' + s.color + ';opacity:' + opacity + '">' + escapeHtml(s.text) + '</span>';
  }).join('');

  // Replace "y" prefix with the live y-value instead of appending "= yVal"
  const yValHtml = '<span style="color:' + OP_COLORS.y + '">' + escapeHtml(yStr) + '</span>'
    + '<span style="color:var(--muted);opacity:0.5"> = </span>';
  if (state.equalsEdge) {
    ui.exprOverlay.innerHTML = html;
  } else {
    ui.exprOverlay.innerHTML = yValHtml + html;
  }
  if (controlEl) controlEl.classList.add('has-overlay');
  // Auto-size input to fit live-value overlay
  autoSizeExprInput();
}

/**
 * Auto-size the expression input to fit live-value overlay content.
 * Delegates to autoSizeInput which considers both input text and overlay width.
 */
function autoSizeExprInput() {
  autoSizeInput();
}

function compileExpression(exprRaw) {
  const expr = (exprRaw ?? "").trim();
  if (!expr) throw new Error("Enter an expression, e.g. sin(x) or x^2.");

  // Disallow obviously dangerous/irrelevant characters up-front.
  // Allowed: letters, numbers, underscore, whitespace, basic operators, parentheses, comma, dot for decimals.
  if (/[^a-zA-Z0-9_\s+\-*/^().,% ]/.test(expr)) {
    throw new Error("Unsupported character detected. Use numbers, x, operators (+-*/^%), and functions like sin(x).");
  }

  // Normalize
  let normalized = expr.replace(/\s+/g, "");
  normalized = normalized.replace(/\^/g, "**");

  // Pre-process log_base(value) → (ln(value)/ln(base)) before validation
  normalized = expandLogBase(normalized);
  // Pre-process nthrt_n(value) → ((value)**(1/(n))) before validation
  normalized = expandNthRoot(normalized);

  const allowed = new Set([
    "x",
    "t",
    "pi",
    "e",
    "tau",
    "sin",
    "cos",
    "tan",
    "asin",
    "acos",
    "atan",
    "sqrt",
    "abs",
    "ln",
    "log",
    "exp",
    "floor",
    "ceil",
    "round",
    "mod",
  ]);

  // Validate identifiers
  const identifiers = normalized.match(/[a-zA-Z_]+/g) ?? [];
  for (const id of identifiers) {
    if (!allowed.has(id)) {
      throw new Error(`Unknown identifier "${id}". Try sin, cos, tan, sqrt, ln, log, pi, e, x, t.`);
    }
  }

  // Replace constants and function aliases where needed.
  // We avoid "Math." in the user expression entirely and provide a local scope instead.
  let jsExpr = normalized
    .replace(/\bpi\b/g, "PI")
    .replace(/\btau\b/g, "TAU")
    .replace(/\be\b/g, "E")
    .replace(/\blog\b/g, "log10")
    .replace(/\bln\b/g, "log")
    .replace(/\bmod\b/g, "_mod");
  jsExpr = replacePowWithSafe(jsExpr);

  const body =
    '"use strict";' +
    "const t=window._gcT;" +
    "function safePow(b,e){if(b>=0||e===Math.floor(e))return Math.pow(b,e);return NaN;}" +
    "const sin=Math.sin, cos=Math.cos, tan=Math.tan;" +
    "const asin=Math.asin, acos=Math.acos, atan=Math.atan;" +
    "const sqrt=function(v){return v<0?NaN:Math.sqrt(v);}, abs=Math.abs;" +
    "const exp=Math.exp, floor=Math.floor, ceil=Math.ceil, round=Math.round;" +
    "const log=Math.log;" +
    "const log10=(Math.log10 ? Math.log10 : (v)=>Math.log(v)/Math.LN10);" +
    "function _mod(a,b){return ((a%b)+b)%b;};" +
    "const PI=Math.PI, E=Math.E, TAU=2*Math.PI;" +
    "return (" +
    jsExpr +
    ");";

  // If this throws, we surface as a user error.
  const fn = new Function("x", body);

  // Sanity test: evaluate at x=0 to catch immediate syntax issues.
  // (Some expressions are undefined at 0; that's OK as long as it's a number or Infinity/NaN.)
  // eslint-disable-next-line no-unused-vars
  fn(0);

  return fn;
}

/** Auto-size the expression input to fit its content. */
function autoSizeInput() {
  const el = ui.exprEl;
  if (!el) return;
  // Temporarily shrink to measure scrollWidth (the content width)
  const saved = el.style.width;
  el.style.width = '0';
  const needed = el.scrollWidth;
  el.style.width = saved;
  // Measure overlay content width independently: temporarily remove right:0
  // so the overlay shrinks to its intrinsic content width (avoids feedback loop)
  let overlayContentW = 0;
  if (ui.exprOverlay && ui.exprOverlay.innerHTML) {
    const sr = ui.exprOverlay.style.right;
    ui.exprOverlay.style.right = 'auto';
    overlayContentW = ui.exprOverlay.scrollWidth;
    ui.exprOverlay.style.right = sr;
  }
  el.style.width = Math.max(180, needed + 16, overlayContentW + 12) + 'px';
}

let _swapInProgress = false;  // guard: prevent liveParse from rebuilding pipeLayout during swap
function liveParse() {
  if (_swapInProgress) { return; }
  const expr = ui.exprEl?.value ?? "";
  // If the expression hasn't changed and we already have a layout, skip rebuild.
  // This prevents async input events (e.g. Safari programmatic .value set) from
  // nuking a freshly-swapped pipeLayout.
  if (expr && state.lastExpr === expr && state.pipeLayout) {
    return;
  }
  if (!expr.trim()) {
    state.fn = null;
    state.steps = [];
    state.ops = [];
    state.displaySpans = null;
    state.usesT = false;
    updateTimelineVisibility();
    renderStepRepresentation();
    updateInputOverlay();
    updateLatexDisplay("");
    setStatus("", "info");
    return;
  }
  try {
    const fn = compileExpression(expr);
    state.fn = fn;
    state.lastExpr = expr;
    const { steps, ops, pipeLayout } = parseAndLinearize(expr);
    state.steps = steps;
    state.ops = ops;
    state.pipeLayout = pipeLayout || null;
    state.stepEyes.ops = ops.map(() => true);
    // Clear expanded discrete columns since the expression changed
    state.expandedCols.clear();
    state.expandedSubCols.clear();
    const normalized = expr.replace(/\s+/g, "");
    state.usesT = /\bt\b/.test(normalized);
    updateTimelineVisibility();
    renderStepRepresentation();
    setStatusForCurrentMode();
    if (ops.length > 0) {
      const { text, spans } = buildDisplayExpr(ops);
      state.displaySpans = spans;
      // Don't overwrite user's text during typing — just update overlay
    } else {
      state.displaySpans = null;
    }
    updateInputOverlay();
    updateLatexDisplay(expr);
    if (!state.hasPlotted) {
      state.hasPlotted = true;
      if (ui.infoBtn) ui.infoBtn.style.display = "";
    }
  } catch {
    // Partial/invalid input — keep last valid state, still color the raw text
    state.displaySpans = null;
    updateInputOverlay();
  }
}

function plotFunction() {
  if (_swapInProgress) { return; }
  const expr = ui.exprEl?.value ?? "";
  // Clear any equals rotation state from previous expression
  state.equalsEdge = null;
  state.equalsLhsSpans = null;
  state.equalsFullSpans = null;
  state.equalsRhsExpr = null;
  try {
    const fn = compileExpression(expr);
    state.fn = fn;
    state.lastExpr = expr;
    const { steps, ops, pipeLayout } = parseAndLinearize(expr);
    state.steps = steps;
    state.ops = ops;
    state.pipeLayout = pipeLayout || null;
    state.stepEyes.ops = ops.map(() => true);
    // Clear expanded discrete columns since the expression changed
    state.expandedCols.clear();
    state.expandedSubCols.clear();
    const normalized = expr.replace(/\s+/g, "");
    state.usesT = /\bt\b/.test(normalized);
    updateTimelineVisibility();
    renderStepRepresentation();
    setStatusForCurrentMode();
    // Use pipe-tree expression (with brackets + correct coloring) when available;
    // fall back to sequential buildDisplayExpr only if there's no pipe layout.
    if (state.pipeLayout) {
      const treeResult = _walkPipeTree(state.pipeLayout);
      if (treeResult) {
        ui.exprEl.value = treeResult.text;
        state.lastExpr = treeResult.text;
        state.displaySpans = treeResult.spans;
      } else {
        state.displaySpans = null;
      }
    } else if (ops.length > 0) {
      const { text, spans } = buildDisplayExpr(ops);
      state.displaySpans = spans;
      ui.exprEl.value = text;
      state.lastExpr = text;
    } else {
      state.displaySpans = null;
    }
    updateInputOverlay();
    updateLatexDisplay(ui.exprEl?.value ?? expr);
    if (!state.hasPlotted) {
      state.hasPlotted = true;
      if (ui.infoBtn) ui.infoBtn.style.display = "";
    }
  } catch (err) {
    console.error('[plotFunction]', err);
    state.fn = null;
    state.steps = [];
    state.ops = [];
    renderStepRepresentation();
    setStatus(err?.message ?? String(err), "error");
  }
}

function setup() {
  // Detect mobile/touch device
  const isMobile = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 0 && window.innerWidth < 800);
  if (isMobile) document.body.classList.add('mobile');

  // Detect iOS (all iOS browsers use WebKit — no Fullscreen API)
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS) document.body.classList.add('ios');

  ui.exprEl = document.getElementById("expr");
  ui.modeButtons = Array.from(document.querySelectorAll("#mode-toggle .mode-btn"));
  ui.plotEl = document.getElementById("plot");
  ui.statusEl = document.getElementById("status");
  ui.canvasWrapEl = document.getElementById("canvas-wrap");
  ui.infoBtn = document.getElementById("info-btn");
  ui.infoPopup = document.getElementById("info-popup");
  ui.graphTogglesEl = document.getElementById("graph-toggles");

  // Create colored overlay for input expression
  if (ui.exprEl) {
    const controlLabel = ui.exprEl.closest(".control") || ui.exprEl.parentElement;
    controlLabel.style.position = "relative";
    const overlay = document.createElement("div");
    overlay.className = "expr-color-overlay";
    overlay.id = "expr-overlay";
    controlLabel.appendChild(overlay);
    ui.exprOverlay = overlay;

    // Position overlay to match the input's left edge within the control
    ui._positionOverlay = () => {
      const ctrlRect = controlLabel.getBoundingClientRect();
      const inputRect = ui.exprEl.getBoundingClientRect();
      const leftOffset = inputRect.left - ctrlRect.left;
      overlay.style.left = leftOffset + "px";
      overlay.style.right = "0";
    };
    ui._positionOverlay();
    window.addEventListener("resize", ui._positionOverlay);

    // Sync overlay scroll/position with input
    ui.exprEl.addEventListener("scroll", () => {
      overlay.scrollLeft = ui.exprEl.scrollLeft;
    });
    // Live-parse on every keystroke
    ui.exprEl.addEventListener("input", () => {
      liveParse();
      autoSizeInput();
    });
    // Auto-size on load
    autoSizeInput();
  }

  // --- Canvas sizing: fill entire viewport ---
  const w = window.innerWidth;
  const h = window.innerHeight;

  canvas = createCanvas(w, h);
  canvas.parent("canvas-wrap");
  // Paint dark immediately to prevent bright flash through topbar glass
  background(10, 14, 28);

  // Prevent browser image-drag when dragging on the canvas
  canvas.elt.addEventListener('dragstart', e => e.preventDefault());

  // Create reset view overlay button
  const resetOverlay = document.createElement("button");
  resetOverlay.className = "reset-overlay";
  resetOverlay.textContent = "Reset view";
  resetOverlay.style.display = "none";
  resetOverlay.addEventListener("click", () => {
    resetView();
    state.viewDirty = false;
    resetOverlay.style.display = "none";
  });
  ui.resetOverlay = resetOverlay;
  document.body.appendChild(resetOverlay);

  // Position reset button relative to accordion
  const exprWin = document.getElementById('expr-window');
  const portraitMQ = window.matchMedia(
    '(max-width: 600px) and (orientation: portrait), ' +
    '(hover: none) and (pointer: coarse) and (orientation: portrait)');

  function positionResetButton() {
    if (resetOverlay.style.display === 'none' || !exprWin) return;
    const r = exprWin.getBoundingClientRect();
    if (portraitMQ.matches) {
      // Mobile portrait: above the pane, centred horizontally
      resetOverlay.style.top = '';
      resetOverlay.style.bottom = (window.innerHeight - r.top + 6) + 'px';
      resetOverlay.style.left = '50%';
      resetOverlay.style.transform = 'translateX(-50%)';
    } else {
      // Desktop: below the accordion window, centred on it
      resetOverlay.style.bottom = '';
      resetOverlay.style.top = (r.bottom + 6) + 'px';
      resetOverlay.style.left = (r.left + r.width / 2) + 'px';
      resetOverlay.style.transform = 'translateX(-50%)';
    }
  }

  // Observe accordion size/position changes
  if (exprWin) {
    new ResizeObserver(positionResetButton).observe(exprWin);
    new MutationObserver(positionResetButton).observe(exprWin, {
      attributes: true, attributeFilter: ['style', 'class'],
      subtree: true, childList: true
    });

    // ---- Recentre graph when pane height changes (mobile portrait) ----
    let _prevPaneTop = null;
    new ResizeObserver(() => {
      if (!portraitMQ.matches) { _prevPaneTop = null; return; }
      const paneTop = exprWin.getBoundingClientRect().top;
      if (_prevPaneTop !== null && _prevPaneTop !== paneTop) {
        // Shift origin so the same world point stays at the visible centre.
        // Visible centre Y = paneTop / 2, so delta = (newTop - oldTop) / 2.
        view.originY += (paneTop - _prevPaneTop) / 2;
      }
      _prevPaneTop = paneTop;
    }).observe(exprWin);
  }

  // Also reposition when shown
  const _resetShowObserver = new MutationObserver(() => positionResetButton());
  _resetShowObserver.observe(resetOverlay, { attributes: true, attributeFilter: ['style'] });

  resetView();

  // ---- UI wiring ----
  if (ui.modeButtons.length) {
    const active = ui.modeButtons.find((b) => b.classList.contains("mode-btn--active")) || ui.modeButtons[0];
    state.mode = active?.dataset.mode || "cartesian";
    ui.modeButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.mode;
        if (!mode) return; // skip non-mode buttons
        state.mode = mode;
        ui.modeButtons.forEach((b) => b.classList.toggle("mode-btn--active", b === btn));
        setStatusForCurrentMode();
      });
    });
  }

  ui.exprEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      plotFunction();
    }
  });

  // On mobile: hide toolbox when keyboard appears (input focused)
  if (isMobile && ui.exprEl) {
    const toolboxW = document.querySelector('.toolbox-wrapper');
    const stepRow = document.querySelector('.step-toolbox-row');
    ui.exprEl.addEventListener('focus', () => {
      toolboxW?.classList.add('toolbox-hidden');
      stepRow?.classList.add('toolbox-hidden');
    });
    ui.exprEl.addEventListener('blur', () => {
      toolboxW?.classList.remove('toolbox-hidden');
      stepRow?.classList.remove('toolbox-hidden');
    });
  }

  // Info button toggle
  // ---- Toolbox visibility toggle ----
  const toolboxCb = document.getElementById('show-toolbox');
  const toolboxWrapper = document.querySelector('.toolbox-wrapper');
  if (toolboxCb && toolboxWrapper) {
    // Default: hidden (checkbox unchecked)
    toolboxWrapper.style.display = toolboxCb.checked ? '' : 'none';
    toolboxCb.addEventListener('change', () => {
      toolboxWrapper.style.display = toolboxCb.checked ? '' : 'none';
    });
  }

  // ---- Floating expression window: drag ----
  (function setupExprWindowDrag() {
    const win = document.getElementById('expr-window');
    const bar = document.getElementById('expr-window-titlebar');
    if (!win || !bar) return;
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;

    // Media query: disable dragging in mobile portrait mode
    const portraitMQ = window.matchMedia(
      '(max-width: 600px) and (orientation: portrait), ' +
      '(hover: none) and (pointer: coarse) and (orientation: portrait)');

    function isPortraitMobile() { return portraitMQ.matches; }

    // Remove the initial centering transform so we can position with left/top
    // (only when not in portrait-mobile mode)
    function initPosition() {
      if (isPortraitMobile()) {
        // Portrait mobile: let CSS handle positioning
        win.style.left = '';
        win.style.top = '';
        win.style.transform = '';
        return;
      }
      const winRect = win.getBoundingClientRect();
      win.style.left = winRect.left + 'px';
      win.style.top = winRect.top + 'px';
      win.style.transform = 'none';
    }
    initPosition();

    // Re-init when orientation changes
    portraitMQ.addEventListener('change', initPosition);

    bar.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || isPortraitMobile()) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const r = win.getBoundingClientRect();
      ox = r.left; oy = r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      win.style.left = (ox + e.clientX - sx) + 'px';
      win.style.top = (oy + e.clientY - sy) + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  })();

  // ---- Floating expression window: section collapse/options toggles ----
  (function setupExprWindowSections() {
    document.querySelectorAll('.ew-section__header').forEach(header => {
      header.style.cursor = 'pointer';
      header.addEventListener('click', (e) => {
        if (e.target.closest('.ew-section__options-btn')) return;
        if (e.target.closest('.ew-swipe-tab')) return; // don't collapse on tab click
        const section = header.closest('.ew-section');
        if (section) section.classList.toggle('collapsed');
      });
    });
    document.querySelectorAll('.ew-section__options-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const sName = btn.dataset.section;
        const optPanel = document.getElementById('ew-options-' + sName);
        if (!optPanel) return;
        const visible = optPanel.style.display !== 'none';
        optPanel.style.display = visible ? 'none' : '';
        btn.classList.toggle('active', !visible);
      });
    });
  })();

  // ---- Mobile portrait: merge Text + LaTeX into a single swipeable section ----
  (function setupSwipeableTextLatex() {
    const secText = document.getElementById('ew-section-text');
    const secLatex = document.getElementById('ew-section-latex');
    if (!secText || !secLatex) return;

    const bodyText = document.getElementById('ew-body-text');
    const bodyLatex = document.getElementById('ew-body-latex');
    if (!bodyText || !bodyLatex) return;

    const optionsLatex = document.getElementById('ew-options-latex');

    // Create merged section
    const merged = document.createElement('div');
    merged.className = 'ew-section ew-section--swipe';
    merged.id = 'ew-section-textlatex';

    // Header with tabs
    const header = document.createElement('div');
    header.className = 'ew-section__header';
    header.style.cursor = 'pointer';
    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'ew-section__collapse';
    collapseBtn.title = 'Collapse';
    collapseBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10"><polyline points="2,3 5,7 8,3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    header.appendChild(collapseBtn);

    const tabs = document.createElement('span');
    tabs.className = 'ew-swipe-tabs';
    const tabText = document.createElement('span');
    tabText.className = 'ew-swipe-tab active';
    tabText.dataset.tab = 'text';
    tabText.textContent = 'Text';
    const tabLatex = document.createElement('span');
    tabLatex.className = 'ew-swipe-tab';
    tabLatex.dataset.tab = 'latex';
    tabLatex.textContent = 'LaTeX';
    tabs.appendChild(tabText);
    tabs.appendChild(tabLatex);
    header.appendChild(tabs);

    // Options button (for latex)
    const optBtn = document.createElement('button');
    optBtn.className = 'ew-section__options-btn';
    optBtn.dataset.section = 'latex';
    optBtn.title = 'Options';
    optBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>';
    header.appendChild(optBtn);
    merged.appendChild(header);

    // Collapse on header click (but not on tabs or options)
    header.addEventListener('click', (e) => {
      if (e.target.closest('.ew-swipe-tab') || e.target.closest('.ew-section__options-btn')) return;
      merged.classList.toggle('collapsed');
    });

    // Options toggle
    optBtn.addEventListener('click', () => {
      if (!optionsLatex) return;
      const vis = optionsLatex.style.display !== 'none';
      optionsLatex.style.display = vis ? 'none' : '';
      optBtn.classList.toggle('active', !vis);
    });

    // Swipe container
    const swipe = document.createElement('div');
    swipe.className = 'ew-swipe-container';

    const pageText = document.createElement('div');
    pageText.className = 'ew-swipe-page';
    const pageLatex = document.createElement('div');
    pageLatex.className = 'ew-swipe-page';

    swipe.appendChild(pageText);
    swipe.appendChild(pageLatex);
    merged.appendChild(swipe);

    // Move options drawer into merged section
    if (optionsLatex) merged.appendChild(optionsLatex);

    function activate() {
      // Move bodies into swipe pages
      pageText.appendChild(bodyText);
      pageLatex.appendChild(bodyLatex);
      // Insert merged section and hide originals
      secText.style.display = 'none';
      secLatex.style.display = 'none';
      const exprWin = document.getElementById('expr-window');
      // Insert before the tree section (which is order:1 in column-reverse, i.e. last child)
      exprWin.insertBefore(merged, secText);
      merged.style.display = '';
    }

    function deactivate() {
      // Move bodies back to originals
      const origBodyText = secText.querySelector('.ew-section__body') || secText;
      const origBodyLatex = secLatex.querySelector('.ew-section__body') || secLatex;
      // bodyText/bodyLatex are the actual body elements with IDs, reinsert into parent sections
      const textBodySlot = secText.querySelector('.ew-section__header');
      const latexBodySlot = secLatex.querySelector('.ew-section__header');
      if (textBodySlot) textBodySlot.after(bodyText);
      if (latexBodySlot) latexBodySlot.after(bodyLatex);
      // Move options back
      if (optionsLatex) secLatex.appendChild(optionsLatex);
      secText.style.display = '';
      secLatex.style.display = '';
      merged.style.display = 'none';
      if (merged.parentNode) merged.parentNode.removeChild(merged);
    }

    // Tab switching
    function switchTab(tab) {
      if (tab === 'text') {
        swipe.scrollTo({ left: 0, behavior: 'smooth' });
        tabText.classList.add('active');
        tabLatex.classList.remove('active');
      } else {
        swipe.scrollTo({ left: swipe.scrollWidth / 2, behavior: 'smooth' });
        tabText.classList.remove('active');
        tabLatex.classList.add('active');
      }
    }
    tabText.addEventListener('click', (e) => { e.stopPropagation(); switchTab('text'); });
    tabLatex.addEventListener('click', (e) => { e.stopPropagation(); switchTab('latex'); });

    // Update active tab on scroll
    swipe.addEventListener('scroll', () => {
      const half = swipe.scrollWidth / 2;
      if (swipe.scrollLeft > half * 0.4) {
        tabText.classList.remove('active');
        tabLatex.classList.add('active');
      } else {
        tabText.classList.add('active');
        tabLatex.classList.remove('active');
      }
    });

    // Activate/deactivate based on media query
    if (portraitMQ.matches) activate();
    portraitMQ.addEventListener('change', (e) => {
      if (e.matches) activate();
      else deactivate();
    });
  })();

  // ---- Resizable section bodies (LaTeX + Expression Tree) ----
  (function setupSectionResizers() {
    function addResizer(sectionId) {
      const section = document.getElementById(sectionId);
      if (!section) return;
      const body = section.querySelector('.ew-section__body');
      if (!body) return;

      // Create resize handle element
      const handle = document.createElement('div');
      handle.className = 'ew-resize-handle';
      // Insert after the body (before options drawer or next section)
      body.after(handle);

      // Mark body as resizable — don't set a fixed height initially;
      // let content determine natural height. Only apply fixed height
      // once the user actually drags.
      body.classList.add('ew-resizable');

      let dragging = false, startY = 0, startH = 0;

      handle.addEventListener('mousedown', (e) => {
        if (section.classList.contains('collapsed')) return;
        dragging = true;
        startY = e.clientY;
        startH = body.offsetHeight;
        body.style.height = startH + 'px'; // pin current height on first drag
        body.style.transition = 'none';
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const delta = e.clientY - startY;
        const newH = Math.max(30, startH + delta);
        body.style.height = newH + 'px';
      });

      document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        body.style.transition = '';
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      });

      // Touch support
      handle.addEventListener('touchstart', (e) => {
        if (section.classList.contains('collapsed')) return;
        dragging = true;
        startY = e.touches[0].clientY;
        startH = body.offsetHeight;
        body.style.height = startH + 'px';
        body.style.transition = 'none';
        e.preventDefault();
      }, { passive: false });

      document.addEventListener('touchmove', (e) => {
        if (!dragging) return;
        const delta = e.touches[0].clientY - startY;
        const newH = Math.max(30, startH + delta);
        body.style.height = newH + 'px';
      });

      document.addEventListener('touchend', () => {
        if (!dragging) return;
        dragging = false;
        body.style.transition = '';
      });
    }

    addResizer('ew-section-latex');
    addResizer('ew-section-tree');

    // Re-scale LaTeX when the section body is resized
    const latexEl = document.getElementById('latex-display');
    const latexBody = document.getElementById('ew-body-latex');
    if (latexEl && latexBody) {
      new ResizeObserver(() => scaleLatexToFit(latexEl)).observe(latexBody);
    }
  })();

  // ---- Expression tree: scroll-to-rotate + compass ----
  (function setupTreeRotation() {
    const treeBody = document.getElementById('ew-body-tree');
    if (!treeBody) return;

    const STEP_DEG = 30; // discrete rotation steps (12 positions)
    let _animating = false; // true while chase loop is running
    let _targetDeg = state.treeRotationDeg || 0;  // desired cumulative angle (scroll accumulates here)
    let _compassCumAngle = state.treeRotationDeg || 0; // cumulative (unwrapped) compass angle

    // Build compass element – SVG dial showing "down" direction with 12 segment marks
    const compass = document.createElement('div');
    compass.className = 'tree-compass';
    compass.title = 'Scroll to rotate tree, click to reset';
    const compassSize = 48;
    const cR = 20; // compass circle radius
    const cx0 = compassSize / 2, cy0 = compassSize / 2;
    // Build tick marks for 12 positions (every 30°)
    let tickMarksSvg = '';
    for (let i = 0; i < 12; i++) {
      const angle = i * 30 * Math.PI / 180;
      const inner = cR - 3;
      const outer = cR;
      const x1 = cx0 + inner * Math.sin(angle);
      const y1 = cy0 - inner * Math.cos(angle);
      const x2 = cx0 + outer * Math.sin(angle);
      const y2 = cy0 - outer * Math.cos(angle);
      const sw = (i % 3 === 0) ? 1.5 : 0.8; // thicker marks at 0°/90°/180°/270°
      tickMarksSvg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="currentColor" stroke-width="${sw}" opacity="0.4"/>`;
    }
    compass.innerHTML =
      `<svg width="${compassSize}" height="${compassSize}" viewBox="0 0 ${compassSize} ${compassSize}">` +
      `<circle cx="${cx0}" cy="${cy0}" r="${cR}" fill="none" stroke="currentColor" stroke-width="1" opacity="0.25"/>` +
      tickMarksSvg +
      `<g class="tree-compass__needle" style="transform-origin: ${cx0}px ${cy0}px;">` +
      `<line x1="${cx0}" y1="${cy0 - cR + 7}" x2="${cx0}" y2="${cy0 + cR - 5}" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>` +
      `<polyline points="${cx0 - 3.5},${cy0 + cR - 9} ${cx0},${cy0 + cR - 4.5} ${cx0 + 3.5},${cy0 + cR - 9}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>` +
      `</g>` +
      `</svg>`;

    // Insert compass into the tree section body (before the step-rep wrapper)
    const stepRepWrapper = treeBody.querySelector('.step-rep-wrapper');
    if (stepRepWrapper) treeBody.insertBefore(compass, stepRepWrapper);
    else treeBody.prepend(compass);

    function updateCompass() {
      const needle = compass.querySelector('.tree-compass__needle');
      if (!needle) return;
      needle.style.transform = `rotate(${_compassCumAngle}deg)`;
    }

    /** Parse "x y w h" viewBox string into an object. */
    function parseVB(str) {
      if (!str) return null;
      const p = str.split(/\s+/).map(Number);
      return { x: p[0], y: p[1], w: p[2], h: p[3] };
    }

    /**
     * Compute a predicted viewBox for a given additional rotation delta,
     * plus the centroid of the (unrotated) content.
     * The CSS rotation uses the centroid as its pivot, so we must rotate
     * each point around that same centroid (not the origin) to predict
     * the correct bounding box.
     */
    function predictViewBoxForDelta(svgEl, deltaDeg) {
      const layout = state.pipeLayout;
      if (!layout || !layout.nodes || layout._yX == null) return null;
      const R = 22, PAD = 18;
      const rad = deltaDeg * Math.PI / 180;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      const yX = layout._yX, yY = layout._yY;

      // Collect pre-baked positions (centroid of these = CSS rotation pivot)
      const pts = [[yX, yY]];
      for (const n of layout.nodes) {
        if (n.x != null) pts.push([n.x, n.y]);
      }
      const centX = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      const centY = pts.reduce((s, p) => s + p[1], 0) / pts.length;

      // Rotate each point around the centroid to match the SVG rotate() pivot
      const allX = [], allY = [];
      for (const [px, py] of pts) {
        const dx = px - centX, dy = py - centY;
        allX.push(dx * cos - dy * sin + centX);
        allY.push(dx * sin + dy * cos + centY);
      }

      const bMinX = Math.min(...allX) - R - PAD;
      const bMaxX = Math.max(...allX) + R + PAD;
      const bMinY = Math.min(...allY) - R - PAD;
      const bMaxY = Math.max(...allY) + R + PAD;
      const vbW = Math.max(bMaxX - bMinX, 80);
      const vbH = Math.max(bMaxY - bMinY, 80);
      const cxMid = (bMinX + bMaxX) / 2;
      const cyMid = (bMinY + bMaxY) / 2;
      return { x: cxMid - vbW / 2, y: cyMid - vbH / 2, w: vbW, h: vbH, centX, centY };
    }

    /**
     * Exponential-chase animation loop.
     * `_displayDeg` smoothly chases `_targetDeg`; on each rAF frame the
     * SVG `<g>` wrapper is rotated around the content centroid, upright labels
     * are counter-rotated around their own positions, and the viewBox is updated
     * to encompass the rotated bounding box.
     */
    let _rafId = null;
    let _displayDeg = state.treeRotationDeg || 0;
    const CHASE_SPEED = 0.14;   // fraction of remaining gap consumed per frame
    const SNAP_THRESH = 0.4;    // degrees: if closer than this, snap to target

    function startChaseLoop() {
      if (_rafId) return;
      _animating = true;
      const stepRep = document.getElementById('step-rep');

      function tick() {
        const targetNorm = ((_targetDeg % 360) + 360) % 360;
        const displayNorm = ((_displayDeg % 360) + 360) % 360;

        let delta = targetNorm - displayNorm;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;

        if (Math.abs(delta) < SNAP_THRESH) {
          /* ──── snap & finalize ──── */
          _displayDeg = _targetDeg;
          state.treeRotationDeg = targetNorm;

          const curSvg = stepRep?.querySelector('svg.pipe-diagram');
          if (curSvg) {
            const wrapper = curSvg.querySelector('.rotation-wrapper');
            if (wrapper) {
              wrapper.removeAttribute('transform');
              while (wrapper.firstChild) curSvg.appendChild(wrapper.firstChild);
              wrapper.remove();
            }
            curSvg.style.transition = 'none';
            curSvg.style.transform = 'none';
          }
          renderStepRepresentation();
          _animating = false;
          _rafId = null;
          return;
        }

        /* ──── chase: move a fraction of the remaining gap ──── */
        _displayDeg += delta * CHASE_SPEED;

        const curSvg = stepRep?.querySelector('svg.pipe-diagram');
        if (curSvg) {
          let cssDelta = _displayDeg - state.treeRotationDeg;
          cssDelta = ((cssDelta % 360) + 360 + 180) % 360 - 180;

          // Compute predicted viewBox and content centroid
          const predicted = predictViewBoxForDelta(curSvg, cssDelta);
          const pivotX = predicted ? predicted.centX : 0;
          const pivotY = predicted ? predicted.centY : 0;

          // Ensure wrapper exists
          let wrapper = curSvg.querySelector('.rotation-wrapper');
          if (!wrapper) {
            const NS = 'http://www.w3.org/2000/svg';
            wrapper = document.createElementNS(NS, 'g');
            wrapper.classList.add('rotation-wrapper');
            while (curSvg.firstChild) wrapper.appendChild(curSvg.firstChild);
            curSvg.appendChild(wrapper);
          }

          // Rotate around content centroid — stable visual pivot
          wrapper.setAttribute('transform',
            `rotate(${cssDelta}, ${pivotX}, ${pivotY})`);

          // Counter-rotate upright labels around their own positions
          wrapper.querySelectorAll('.pipe-upright').forEach(el => {
            const t = el.tagName === 'text' ? el : el.querySelector('text');
            if (!t) return;
            const cx = parseFloat(t.getAttribute('x'));
            const cy = parseFloat(t.getAttribute('y'));
            if (isNaN(cx) || isNaN(cy)) return;
            // Disable CSS transitions during animation to prevent flyout
            el.style.transition = 'none';
            el.setAttribute('transform', `rotate(${-cssDelta}, ${cx}, ${cy})`);
          });

          // Update viewBox
          if (predicted) {
            curSvg.setAttribute('viewBox',
              `${predicted.x} ${predicted.y} ${predicted.w} ${predicted.h}`);
          }
        }

        _rafId = requestAnimationFrame(tick);
      }

      _rafId = requestAnimationFrame(tick);
    }

    /**
     * Queue a rotation of `deltaDeg`.  The compass updates immediately;
     * the chase loop drives the tree toward the new target.
     */
    function animateRotation(deltaDeg) {
      _targetDeg += deltaDeg;
      _compassCumAngle += deltaDeg;
      updateCompass();
      startChaseLoop();
    }

    // Scroll on compass to rotate the tree (discrete 30° steps)
    compass.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const dir = e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0;
      if (dir === 0) return;

      animateRotation(dir * STEP_DEG);
    }, { passive: false });

    // Touch drag on compass to rotate the tree
    {
      let _tcStartY = null, _tcAccum = 0;
      const TC_THRESH = 30;
      compass.addEventListener('touchstart', (e) => {
        e.preventDefault();
        _tcStartY = e.touches[0].clientY;
        _tcAccum = 0;
      }, { passive: false });
      compass.addEventListener('touchmove', (e) => {
        if (_tcStartY == null) return;
        e.preventDefault();
        const dy = _tcStartY - e.touches[0].clientY;
        _tcStartY = e.touches[0].clientY;
        _tcAccum += dy;
        while (Math.abs(_tcAccum) >= TC_THRESH) {
          const dir = _tcAccum > 0 ? -1 : 1; // finger-up = CCW
          _tcAccum -= (_tcAccum > 0 ? 1 : -1) * TC_THRESH;
          animateRotation(dir * STEP_DEG);
        }
      }, { passive: false });
      compass.addEventListener('touchend', () => { _tcStartY = null; });
      compass.addEventListener('touchcancel', () => { _tcStartY = null; });
    }

    // Click compass to reset to 0°
    compass.addEventListener('click', () => {
      if (state.treeRotationDeg === 0 && _compassCumAngle === 0 && _targetDeg === 0) return;

      // Shortest path back to 0° for the compass needle
      const remainder = ((_compassCumAngle % 360) + 360) % 360;
      const shortDelta = remainder <= 180 ? -remainder : (360 - remainder);
      _compassCumAngle += shortDelta;
      _targetDeg = 0;
      updateCompass();
      startChaseLoop();
    });

    // Initial state
    updateCompass();
  })();

  ui.infoBtn?.addEventListener("click", () => {
    const popup = ui.infoPopup;
    if (popup) popup.classList.toggle("info-popup--visible");
  });
  document.addEventListener("click", (e) => {
    if (ui.infoPopup?.classList.contains("info-popup--visible") &&
      !ui.infoPopup.contains(e.target) && e.target !== ui.infoBtn) {
      ui.infoPopup.classList.remove("info-popup--visible");
    }
  });

  // ---- Settings gear (FMTTM-style) ----
  setupSettingsGear();

  // ---- Fullscreen button ----
  setupFullscreenButton();

  // ---- Toggle bar (bottom of graph) ----
  buildToggleBar();

  // ---- Graph Controls + Visibility sections in expr-window ----
  populateGraphControlsSection();
  populateVisibilitySection();

  // ---- Mobile: eye-icon visibility toggle panel ----
  setupMobileTogglePanel();

  // ---- Mobile: touch handlers for pinch-zoom and drag-pan ----
  setupTouchHandlers();

  // ---- Mobile: topbar collapse, pseudo-fullscreen, tap-to-show, bar positioning ----
  setupMobileBarControls();

  // ---- HUD overlay (top-left of canvas area) ----
  const hudEl = document.createElement("div");
  hudEl.className = "graph-hud";
  hudEl.id = "graph-hud";
  const canvasWrap = document.getElementById("canvas-wrap");
  if (canvasWrap) canvasWrap.appendChild(hudEl);
  else document.body.appendChild(hudEl);
  ui.hudEl = hudEl;

  // ---- LaTeX display element ----
  ui.latexEl = document.getElementById("latex-display");

  // ---- Rotation segmented button ----
  const rotToggle = document.getElementById('rot-toggle');
  const rotBtns = rotToggle ? Array.from(rotToggle.querySelectorAll('.mode-btn')) : [];
  ui.rotBtns = rotBtns;
  rotBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const angle = parseFloat(btn.dataset.rot);
      view.rotation = angle;
      rotBtns.forEach(b => b.classList.toggle('mode-btn--active', b === btn));
      state.viewDirty = true;
      if (ui.resetOverlay && angle !== 0) ui.resetOverlay.style.display = "";
    });
  });

  // ---- Tau mode toggle ----
  const tauBtn = document.getElementById('tau-toggle');
  if (tauBtn) {
    tauBtn.addEventListener('click', () => {
      state.tauMode = !state.tauMode;
      tauBtn.classList.toggle('mode-btn--active', state.tauMode);
      state.viewDirty = true;
    });
  }

  // ---- Glow curves toggle ----
  const glowBtn = document.getElementById('glow-toggle');
  if (glowBtn) {
    // Set initial active state
    glowBtn.classList.toggle('mode-btn--active', state.glowCurves);
    glowBtn.addEventListener('click', () => {
      state.glowCurves = !state.glowCurves;
      glowBtn.classList.toggle('mode-btn--active', state.glowCurves);
    });
  }

  // ---- Numeral mode toggle ----
  const numeralBtn = document.getElementById('numeral-toggle');
  if (numeralBtn) {
    numeralBtn.classList.toggle('mode-btn--active', state.numeralMode);
    numeralBtn.addEventListener('click', () => {
      state.numeralMode = !state.numeralMode;
      numeralBtn.classList.toggle('mode-btn--active', state.numeralMode);
    });
  }

  // ---- Equalize colors toggle (experimental) ----
  const eqBtn = document.getElementById('eq-toggle');
  if (eqBtn) {
    eqBtn.classList.toggle('mode-btn--active', state.equalizeColors);
    eqBtn.addEventListener('click', () => {
      state.equalizeColors = !state.equalizeColors;
      equalizeOpColors(state.equalizeColors);
      eqBtn.classList.toggle('mode-btn--active', state.equalizeColors);
      // Re-render LaTeX with updated colours
      updateLatexDisplay(ui.exprEl?.value ?? "");
    });
  }

  // ---- LaTeX order segmented control (sequential ↔ traditional) ----
  const segOrderSeq = document.getElementById('seg-order-seq');
  const segOrderTrad = document.getElementById('seg-order-trad');
  if (segOrderSeq && segOrderTrad) {
    // Initialise from state (latexOpsOrder=true → sequential/ops, false → traditional/AST)
    segOrderSeq.classList.toggle('seg-btn--active', state.latexOpsOrder);
    segOrderTrad.classList.toggle('seg-btn--active', !state.latexOpsOrder);
    const pickOrder = (useOps) => {
      state.latexOpsOrder = useOps;
      segOrderSeq.classList.toggle('seg-btn--active', useOps);
      segOrderTrad.classList.toggle('seg-btn--active', !useOps);
      // When equalsEdge is active, rebuild displaySpans for the new order
      if (state.equalsEdge) {
        rebuildEqualsDisplaySpans();
        updateInputOverlay();
      }
      _lastLatexLiveKey = '__force__';
      updateLatexDisplay(ui.exprEl?.value ?? "");
    };
    segOrderSeq.addEventListener('click', () => pickOrder(true));
    segOrderTrad.addEventListener('click', () => pickOrder(false));
  }

  // ---- LaTeX multiplication symbol segmented control (× ↔ ·) ----
  const segMulTimes = document.getElementById('seg-mul-times');
  const segMulDot = document.getElementById('seg-mul-dot');
  if (segMulTimes && segMulDot) {
    segMulTimes.classList.toggle('seg-btn--active', state.latexMulSymbol === 'times');
    segMulDot.classList.toggle('seg-btn--active', state.latexMulSymbol === 'dot');
    const pickMul = (sym) => {
      state.latexMulSymbol = sym;
      segMulTimes.classList.toggle('seg-btn--active', sym === 'times');
      segMulDot.classList.toggle('seg-btn--active', sym === 'dot');
      _lastLatexLiveKey = '__force__';
      updateLatexDisplay(ui.exprEl?.value ?? "");
    };
    segMulTimes.addEventListener('click', () => pickMul('times'));
    segMulDot.addEventListener('click', () => pickMul('dot'));
  }

  // ---- LaTeX copy button ----
  const latexCopyBtn = document.getElementById('latex-copy-btn');
  if (latexCopyBtn) {
    latexCopyBtn.addEventListener('click', async () => {
      const raw = getRawLatex();
      if (!raw) return;
      try {
        await navigator.clipboard.writeText(raw);
        latexCopyBtn.textContent = '✓';
        setTimeout(() => { latexCopyBtn.textContent = 'copy'; }, 1200);
      } catch { /* clipboard denied */ }
    });
  }

  // ---- LaTeX paste button ----
  const latexPasteBtn = document.getElementById('latex-paste-btn');
  if (latexPasteBtn) {
    latexPasteBtn.addEventListener('click', async () => {
      try {
        const clip = await navigator.clipboard.readText();
        const expr = latexToExpr(clip);
        if (expr && ui.exprEl) {
          ui.exprEl.value = expr;
          ui.exprEl.dispatchEvent(new Event('input', { bubbles: true }));
          latexPasteBtn.textContent = '✓';
          setTimeout(() => { latexPasteBtn.textContent = 'paste'; }, 1200);
        } else {
          latexPasteBtn.textContent = '✗';
          setTimeout(() => { latexPasteBtn.textContent = 'paste'; }, 1200);
        }
      } catch { /* clipboard denied */ }
    });
  }

  // ---- Expression copy button ----
  const exprCopyBtn = document.getElementById('expr-copy-btn');
  if (exprCopyBtn) {
    exprCopyBtn.addEventListener('click', async () => {
      // When equalsEdge is active, copy the full equation (LHS = RHS)
      let val;
      if (state.equalsEdge && state.displaySpans && state.displaySpans.length) {
        val = state.displaySpans.map(s => s.text).join('');
      } else {
        val = ui.exprEl?.value ? ("y = " + ui.exprEl.value) : "";
      }
      if (!val) return;
      try {
        await navigator.clipboard.writeText(val);
        exprCopyBtn.textContent = '✓';
        setTimeout(() => { exprCopyBtn.textContent = 'copy'; }, 1200);
      } catch { /* clipboard denied */ }
    });
  }

  // ---- Expression paste button ----
  const exprPasteBtn = document.getElementById('expr-paste-btn');
  if (exprPasteBtn) {
    exprPasteBtn.addEventListener('click', async () => {
      try {
        const clip = await navigator.clipboard.readText();
        if (clip && ui.exprEl) {
          ui.exprEl.value = clip.trim();
          ui.exprEl.dispatchEvent(new Event('input', { bubbles: true }));
          exprPasteBtn.textContent = '✓';
          setTimeout(() => { exprPasteBtn.textContent = 'paste'; }, 1200);
        }
      } catch { /* clipboard denied */ }
    });
  }

  // ---- Timeline control for t parameter ----
  setupTimeline();

  // ---- Discrete mode 3-way toggle ----
  const discreteBtns = document.querySelectorAll('.discrete-btn');
  function updateDiscreteBtns() {
    discreteBtns.forEach(b => {
      b.classList.toggle('mode-btn--active', b.dataset.discrete === state.discreteMode);
    });
  }
  updateDiscreteBtns();
  discreteBtns.forEach(b => {
    b.addEventListener('click', () => {
      state.discreteMode = b.dataset.discrete;
      updateDiscreteBtns();
    });
  });

  function updateOverlayPositions() {
    if (document.body.classList.contains('mobile')) return; // mobile uses bottom-positioning via setupMobileBarControls
    const topbar = document.querySelector('.topbar');
    const modeToggle = document.getElementById('mode-toggle-overlay');
    if (!topbar) return;
    const h = topbar.getBoundingClientRect().height;
    if (modeToggle) modeToggle.style.top = (h + 12) + "px";
  }
  updateOverlayPositions();
  {
    const topbar = document.querySelector('.topbar');
    if (topbar) new ResizeObserver(updateOverlayPositions).observe(topbar);
  }

  // ---- Toolbox (right of step flow) ----
  buildToolbox();

  // First plot
  plotFunction();

  // KaTeX loads with defer — if it wasn't ready during plotFunction, retry
  if (typeof katex === "undefined") {
    const katexScript = document.querySelector('script[src*="katex"]');
    if (katexScript) katexScript.addEventListener("load", () => {
      updateLatexDisplay(ui.exprEl?.value ?? "");
    });
  }

  // Set initial rotation to vertical (90°)
  view.rotation = -Math.PI / 2;
  if (ui.rotBtns) ui.rotBtns.forEach(b => {
    b.classList.toggle("mode-btn--active", Math.abs(parseFloat(b.dataset.rot) - (-Math.PI / 2)) < 0.01);
  });

  // Auto-start t playback
  if (state.usesT) {
    state.tPlaying = true;
    const playBtn = document.getElementById('timeline-play');
    if (playBtn) {
      const playIcon = playBtn.querySelector('.play-icon');
      const pauseIcon = playBtn.querySelector('.pause-icon');
      if (playIcon && pauseIcon) {
        playIcon.style.display = 'none';
        pauseIcon.style.display = '';
      }
      playBtn.classList.add('timeline-play-btn--active');
    }
  }
}

/* ========== Toolbox: drag-and-drop function/operator palette ========== */

const TOOLBOX_ITEMS = {
  add: { type: "add", operand: "1" },
  sub: { type: "sub", operand: "1" },
  mul: { type: "mul", operand: "2" },
  div: { type: "div", operand: "2" },
  power: { type: "power", operand: "2" },
  root: { type: "root", operand: "2" },
  basePow: { type: "basePow", operand: "2" },
  sin: { type: "function", fn: "sin" },
  cos: { type: "function", fn: "cos" },
  tan: { type: "function", fn: "tan" },
  asin: { type: "function", fn: "asin" },
  acos: { type: "function", fn: "acos" },
  atan: { type: "function", fn: "atan" },
  abs: { type: "function", fn: "abs" },
  ln: { type: "function", fn: "ln" },
  log10: { type: "function", fn: "log" },
  exp: { type: "function", fn: "exp" },
  floor: { type: "function", fn: "floor" },
  ceil: { type: "function", fn: "ceil" },
  round: { type: "function", fn: "round" },
  mod: { type: "mod", operand: "2" },
};

function createOpFromToolboxItem(item) {
  const opChars = { add: "+", sub: "-", mul: "*", div: "/" };
  const labelPrefixes = { add: "+ ", sub: "− ", mul: "× ", div: "/ " };

  if (opChars[item.type]) {
    const operand = item.operand;
    return {
      type: item.type,
      label: labelPrefixes[item.type] + operand,
      operand: operand,
      applyToExpr: (prev) => "(" + prev + ")" + opChars[item.type] + "(" + operand + ")",
    };
  }
  if (item.type === "power") {
    const operand = item.operand;
    return {
      type: "other",
      label: "^ " + operand,
      operand: operand,
      applyToExpr: (prev) => "(" + prev + ")**(" + operand + ")",
    };
  }
  if (item.type === "root") {
    const operand = item.operand;
    return {
      type: "other",
      label: "\u207F\u221A " + operand,
      operand: operand,
      applyToExpr: (prev) => "(" + prev + ")**(1/(" + operand + "))",
    };
  }
  if (item.type === "basePow") {
    const operand = item.operand;
    return {
      type: "other",
      label: operand + "^x",
      operand: operand,
      applyToExpr: (prev) => "(" + operand + ")**(" + prev + ")",
    };
  }
  if (item.type === "function") {
    return {
      type: "other",
      label: item.fn,
      operand: null,
      applyToExpr: (prev) => item.fn + "(" + prev + ")",
    };
  }
  if (item.type === "mod") {
    const operand = item.operand;
    return {
      type: "other",
      label: "% " + operand,
      operand: operand,
      applyToExpr: (prev) => "mod(" + prev + "," + operand + ")",
    };
  }
  return null;
}

function buildToolbox() {
  const tbx = document.getElementById("toolbox");
  if (!tbx) return;

  // Map data-cat attribute to OP_COLORS keys
  const catToKey = { arith: "addSub", exp: "exp", trig: "trig", misc: "misc" };

  const allItems = tbx.querySelectorAll(".toolbox__item[data-tool]");
  for (let k = 0; k < allItems.length; k++) {
    const el = allItems[k];
    const key = el.getAttribute("data-tool");
    const def = TOOLBOX_ITEMS[key];
    if (!def) continue;

    // Color by data-cat attribute, using OP_COLORS single source of truth
    const cat = el.getAttribute("data-cat") || "misc";
    // Map to CSS class name
    const catKey = cat === 'arith'
      ? ((key === 'add' || key === 'sub') ? 'addSub' : 'mulDiv')
      : (catToKey[cat] || 'misc');
    el.classList.add('op-block--' + catKey);
    // Border/background handled by CSS class (which uses var(--panel)
    // for tinting with the active colour scheme)

    attachToolboxDrag(el, def);
  }
}

function attachToolboxDrag(el, itemDef) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const op = createOpFromToolboxItem(itemDef);
    if (!op) return;

    // Build a full badge ghost (like the op-block in the step sequence)
    const cat = getOpCategory(op);
    const ghost = document.createElement("div");
    ghost.className = "op-block op-block--" + cat;
    // Populate with forward / value / inverse structure
    const fwdSym = getOpSymbol(op);
    const invSym = getInverseOpSymbol(op);
    const val = getOpValue(op);
    if (fwdSym !== null) {
      const fwd = document.createElement("div"); fwd.className = "op-block__fwd"; fwd.textContent = val ? fwdSym + "\u00A0" + val : fwdSym; ghost.appendChild(fwd);
      if (val) { const v = document.createElement("div"); v.className = "op-block__val"; v.textContent = val; ghost.appendChild(v); }
      const inv = document.createElement("div"); inv.className = "op-block__inv"; inv.textContent = val ? invSym + "\u00A0" + val : invSym; ghost.appendChild(inv);
    } else {
      const invLabel = getInverseFunctionLabel(op);
      const fwd = document.createElement("div"); fwd.className = "op-block__fwd"; fwd.textContent = op.label; ghost.appendChild(fwd);
      if (invLabel) { const inv = document.createElement("div"); inv.className = "op-block__inv"; inv.textContent = invLabel; ghost.appendChild(inv); }
    }

    const elRect = el.getBoundingClientRect();
    ghost.style.cssText =
      "position:fixed;z-index:9999;pointer-events:none;" +
      "left:" + elRect.left + "px;top:" + elRect.top + "px;" +
      "opacity:0.85;box-shadow:0 8px 24px rgba(0,0,0,0.3);" +
      "transform:scale(1.05);transition:none;";
    document.body.appendChild(ghost);
    // Measure ghost after append so we can centre it during drag
    const gw = ghost.offsetWidth;
    const gh = ghost.offsetHeight;

    let insertIdx = state.ops.length; // default: append to end
    let hoveredBlock = null;

    const onMove = (ev) => {
      ghost.style.left = (ev.clientX - gw / 2) + "px";
      ghost.style.top = (ev.clientY - gh / 2) + "px";

      // Detect insertion point in the step flow
      ghost.style.display = "none";
      const hit = document.elementFromPoint(ev.clientX, ev.clientY);
      ghost.style.display = "";

      // Clear previous hover
      if (hoveredBlock) {
        hoveredBlock.classList.remove("op-block--dragover");
        hoveredBlock = null;
      }

      const target = hit?.closest(".op-block");
      if (target && target.dataset.idx !== undefined) {
        insertIdx = parseInt(target.dataset.idx) + 1;
        target.classList.add("op-block--dragover");
        hoveredBlock = target;
      } else {
        // Check if over y endpoint or after last op
        const yTarget = hit?.closest(".step-box--y");
        if (yTarget) {
          insertIdx = state.ops.length;
        } else {
          const xTarget = hit?.closest(".step-box--x");
          if (xTarget) {
            insertIdx = 0;
          }
        }
      }
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      ghost.remove();
      if (hoveredBlock) hoveredBlock.classList.remove("op-block--dragover");

      // Insert the op
      state.ops.splice(insertIdx, 0, op);
      state.stepEyes.ops.splice(insertIdx, 0, true);
      applyOpsChange(true);
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });
}

/* ========== Fullscreen button ========== */

function setupFullscreenButton() {
  const btn = document.getElementById("fullscreen-btn");
  const btnEW = document.getElementById("fullscreen-btn-ew");

  const expandSVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
  const compressSVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
  const expandSmall = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
  const compressSmall = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';

  // Cross-browser fullscreen helpers
  function requestFS(el) {
    if (el.requestFullscreen) return el.requestFullscreen();
    if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
    if (el.mozRequestFullScreen) return el.mozRequestFullScreen();
    if (el.msRequestFullscreen) return el.msRequestFullscreen();
    return Promise.reject();
  }
  function exitFS() {
    if (document.exitFullscreen) return document.exitFullscreen();
    if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
    if (document.mozCancelFullScreen) return document.mozCancelFullScreen();
    if (document.msExitFullscreen) return document.msExitFullscreen();
    return Promise.reject();
  }
  function getFS() {
    return document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;
  }

  if (btn) btn.innerHTML = expandSVG;
  if (btnEW) btnEW.innerHTML = expandSmall;

  function doToggle() {
    if (!getFS()) {
      requestFS(document.documentElement).catch(() => {
        window.scrollTo(0, 1);
      });
    } else {
      exitFS().catch(() => { });
    }
  }

  if (btn) btn.addEventListener("click", doToggle);
  if (btnEW) btnEW.addEventListener("click", (e) => { e.stopPropagation(); doToggle(); });

  // Listen for all vendor-prefixed fullscreenchange events
  ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach(evt => {
    document.addEventListener(evt, () => {
      const fs = getFS();
      if (btn) btn.innerHTML = fs ? compressSVG : expandSVG;
      if (btnEW) btnEW.innerHTML = fs ? compressSmall : expandSmall;
    });
  });
}

/* ========== Settings gear (FMTTM-style) ========== */

function setupSettingsGear() {
  const gear = document.getElementById("settingsGear");
  const gearEW = document.getElementById("settingsGear-ew");
  const menu = document.getElementById("settingsMenu");
  if (!menu) return;

  let menuOpen = false;
  let hoverTimeout = null;

  function openSettingsMenu() {
    menuOpen = true;
    menu.classList.add("show");
    gear.classList.add("menu-open");
    clearTimeout(hoverTimeout);
  }

  function closeSettingsMenu() {
    menuOpen = false;
    menu.classList.remove("show");
    gear.classList.remove("menu-open");
    clearTimeout(hoverTimeout);
  }

  function toggleSettingsMenu() {
    if (menuOpen) {
      closeSettingsMenu();
      gear.classList.remove("spin");
      gear.classList.add("spin-reverse");
      gear.addEventListener("animationend", () => gear.classList.remove("spin-reverse"), { once: true });
    } else {
      openSettingsMenu();
      gear.classList.remove("spin-reverse");
      gear.classList.add("spin");
      gear.addEventListener("animationend", () => gear.classList.remove("spin"), { once: true });
    }
  }

  gear.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleSettingsMenu();
  });

  // Titlebar gear triggers same menu
  if (gearEW) {
    gearEW.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSettingsMenu();
    });
  }

  // Hover behavior with delay
  const hoverZone = [gear, menu].filter(Boolean);
  hoverZone.forEach((el) => {
    el.addEventListener("mouseenter", () => {
      clearTimeout(hoverTimeout);
      hoverTimeout = setTimeout(openSettingsMenu, 300);
    });
    el.addEventListener("mouseleave", () => {
      clearTimeout(hoverTimeout);
      hoverTimeout = setTimeout(closeSettingsMenu, 500);
    });
  });

  // Close when clicking outside
  document.addEventListener("click", (e) => {
    if (menuOpen && !menu.contains(e.target) && e.target !== gear) {
      closeSettingsMenu();
    }
  });

  // ---- Theme buttons ----
  const themeLight = document.getElementById("themeLight");
  const themeDark = document.getElementById("themeDark");
  const themeAuto = document.getElementById("themeAuto");

  function setTheme(theme) {
    state.theme = theme;
    document.querySelectorAll(".theme-btn").forEach((b) => b.classList.remove("active"));
    if (theme === "light") {
      themeLight?.classList.add("active");
      state.lightMode = true;
      document.body.classList.add("light");
    } else if (theme === "dark") {
      themeDark?.classList.add("active");
      state.lightMode = false;
      document.body.classList.remove("light");
    } else {
      // auto
      themeAuto?.classList.add("active");
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      state.lightMode = !prefersDark;
      document.body.classList.toggle("light", state.lightMode);
    }
    // When entering dark mode, clear bg-color CSS overrides;
    // when entering light mode, re-apply them if a bg color is saved
    if (!state.lightMode) {
      document.body.style.removeProperty("--body-bg");
      document.body.style.removeProperty("--panel");
      document.body.style.removeProperty("--panel2");
      document.body.style.removeProperty("--settings-menu-bg");
      document.body.style.removeProperty("--glass-bg");
      document.body.style.removeProperty("--valve-glass");
      document.body.style.removeProperty("--topbar-bg");
      // Dark mode: accent derived from dark bg defaults
      if (typeof clearAccentOverrides === 'function') clearAccentOverrides();
    } else if (state.bgColor) {
      // Re-apply inline overrides for current bg color
      const rgb = state.bgColorRGB;
      if (rgb) {
        const [r, g, b] = rgb;
        document.body.style.setProperty("--body-bg", state.bgColor);
        document.body.style.setProperty("--panel", state.bgColor);
        document.body.style.setProperty("--panel2", state.bgColor);
        document.body.style.setProperty("--settings-menu-bg", state.bgColor);
        document.body.style.setProperty("--glass-bg", `rgba(${r},${g},${b},0.55)`);
        document.body.style.setProperty("--valve-glass", `rgba(${r},${g},${b},0.85)`);
        document.body.style.setProperty("--topbar-bg",
          `linear-gradient(180deg, rgba(${r},${g},${b},0.95) 0%, rgba(${r},${g},${b},0.9) 100%)`);
        if (typeof applyAccentFromBg === 'function') applyAccentFromBg(r, g, b);
      }
    } else {
      // Light mode, default bg — clear accent overrides to use CSS defaults
      if (typeof clearAccentOverrides === 'function') clearAccentOverrides();
    }
    try { localStorage.setItem("gc-theme", theme); } catch { }
  }

  themeLight?.addEventListener("click", () => setTheme("light"));
  themeDark?.addEventListener("click", () => setTheme("dark"));
  themeAuto?.addEventListener("click", () => setTheme("auto"));

  // Auto theme: respond to system changes
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.theme === "auto") setTheme("auto");
  });

  // ---- Background color buttons ----
  const bgColors = {
    colorDefault: null,
    colorOffwhite: "#F8F8F8",
    colorSolarised: "#FDF6E3",
    colorFT: "#FFF1E5",
  };

  // Helper: derive accent / toggle colors from an RGB background
  function applyAccentFromBg(r, g, b) {
    // RGB → OKLCH for perceptually uniform accent derivation
    const lab = rgbToOklab(r, g, b);
    const lch = oklabToOklch(lab.L, lab.a, lab.b);
    const h = lch.C > 0.005 ? lch.h : 270; // fallback hue if near-achromatic
    const accentC = state.lightMode ? 0.11 : 0.09;
    const accentL = state.lightMode ? 49 : 69;
    const toggleA = state.lightMode ? 0.22 : 0.4;
    const toggleTxtL = state.lightMode ? 37 : 92;
    const toggleTxtC = state.lightMode ? 0.09 : 0.03;
    const glowA = state.lightMode ? 0.1 : 0.15;
    const hStr = h.toFixed(1);
    document.body.style.setProperty("--accent", `oklch(${accentL}% ${accentC} ${hStr})`);
    document.body.style.setProperty("--toggle-active-bg", `oklch(${accentL}% ${accentC} ${hStr} / ${toggleA})`);
    document.body.style.setProperty("--toggle-active-color", `oklch(${toggleTxtL}% ${toggleTxtC} ${hStr})`);
    document.body.style.setProperty("--toggle-glow-bg", `oklch(${accentL}% ${accentC} ${hStr} / ${glowA})`);
  }
  function clearAccentOverrides() {
    document.body.style.removeProperty("--accent");
    document.body.style.removeProperty("--toggle-active-bg");
    document.body.style.removeProperty("--toggle-active-color");
    document.body.style.removeProperty("--toggle-glow-bg");
  }

  function setBackgroundColor(id) {
    document.querySelectorAll(".color-btn").forEach((b) => b.classList.remove("active"));
    document.getElementById(id)?.classList.add("active");
    const col = bgColors[id];
    // Store for p5.js canvas background
    state.bgColor = col || null;
    if (col) {
      // Parse hex to RGB for canvas glass labels
      const r = parseInt(col.slice(1, 3), 16), g = parseInt(col.slice(3, 5), 16), b = parseInt(col.slice(5, 7), 16);
      state.bgColorRGB = [r, g, b];
      // Only apply CSS overrides in light mode — dark mode uses its own palette
      if (state.lightMode) {
        document.body.style.setProperty("--body-bg", col);
        document.body.style.setProperty("--panel", col);
        document.body.style.setProperty("--panel2", col);
        document.body.style.setProperty("--settings-menu-bg", col);
        document.body.style.setProperty("--glass-bg", `rgba(${r},${g},${b},0.55)`);
        document.body.style.setProperty("--valve-glass", `rgba(${r},${g},${b},0.85)`);
        document.body.style.setProperty("--topbar-bg",
          `linear-gradient(180deg, rgba(${r},${g},${b},0.95) 0%, rgba(${r},${g},${b},0.9) 100%)`);
        applyAccentFromBg(r, g, b);
      }
    } else {
      state.bgColorRGB = null;
      // Clear any inline overrides so CSS variables fall back to theme defaults
      document.body.style.removeProperty("--body-bg");
      document.body.style.removeProperty("--panel");
      document.body.style.removeProperty("--panel2");
      document.body.style.removeProperty("--settings-menu-bg");
      document.body.style.removeProperty("--glass-bg");
      document.body.style.removeProperty("--valve-glass");
      document.body.style.removeProperty("--topbar-bg");
      clearAccentOverrides();
    }
    try { localStorage.setItem("gc-bg-color", id); } catch { }
    // Re-render tree to pick up new glass fill
    if (typeof renderStepRepresentation === 'function') renderStepRepresentation();
  }

  Object.keys(bgColors).forEach((id) => {
    document.getElementById(id)?.addEventListener("click", () => setBackgroundColor(id));
  });

  // Restore from localStorage
  try {
    const savedTheme = localStorage.getItem("gc-theme");
    if (savedTheme) setTheme(savedTheme);
    else setTheme("auto");

    const savedBg = localStorage.getItem("gc-bg-color");
    if (savedBg) setBackgroundColor(savedBg);
  } catch {
    setTheme("auto");
  }
}

/* ========== Toggle bar (bottom of graph) ========== */

const toggleDefs = [
  {
    type: 'group', label: 'Axis',
    keys: ['xaxis', 'yaxis'],
    children: [
      { key: 'xaxis', label: 'x', colorKey: 'x' },
      { key: 'yaxis', label: 'y', colorKey: 'y' },
    ]
  },
  {
    type: 'group', label: 'Gridlines',
    keys: ['xgrid', 'ygrid'],
    children: [
      { key: 'xgrid', label: 'x', colorKey: 'x' },
      { key: 'ygrid', label: 'y', colorKey: 'y' },
    ]
  },
  {
    type: 'group', label: 'Labels',
    keys: ['xlabels', 'ylabels'],
    children: [
      { key: 'xlabels', label: 'x', colorKey: 'x' },
      { key: 'ylabels', label: 'y', colorKey: 'y' },
    ]
  },
  { key: "arrows", label: "Transforms", colorKey: "curve" },
  {
    type: 'group', label: 'Intermediates',
    keys: ['intermediates', 'subintermediates'],
    children: [
      { key: 'intermediates', label: 'main', colorKey: 'other' },
      { key: 'subintermediates', label: 'sub', colorKey: 'other' },
    ]
  },
  { key: "starbursts", label: "Starbursts", colorKey: "other" },
];

function updateToggleGroupUI(group, def) {
  const allOn = def.keys.every(k => state.toggles[k]);
  const anyOn = def.keys.some(k => state.toggles[k]);
  // The group div itself is the parent button now
  group.classList.toggle("graph-toggle-btn--on", allOn);
  group.classList.toggle("graph-toggle-btn--partial", anyOn && !allOn);
  def.children.forEach(child => {
    const subBtn = group.querySelector(`[data-toggle-key="${child.key}"]`);
    if (subBtn) subBtn.classList.toggle("toggle-group__sub--on", state.toggles[child.key]);
  });
}

function buildToggleBar() {
  const bar = ui.graphTogglesEl;
  if (!bar) return;
  bar.innerHTML = "";

  // "Visibility toggles:" label
  const labelSpan = document.createElement("span");
  labelSpan.className = "graph-toggles-label";
  labelSpan.textContent = "Visibility toggles:";
  bar.appendChild(labelSpan);

  toggleDefs.forEach((def) => {
    if (def.type === 'group') {
      // The group itself acts as the outer button rectangle
      const group = document.createElement("div");
      group.className = "toggle-group graph-toggle-btn";
      group.setAttribute("role", "button");
      group.tabIndex = 0;

      const allOn = def.keys.every(k => state.toggles[k]);
      const anyOn = def.keys.some(k => state.toggles[k]);
      if (allOn) group.classList.add("graph-toggle-btn--on");
      else if (anyOn) group.classList.add("graph-toggle-btn--partial");

      // Label on the left — clicking it toggles all children
      const labelSpan = document.createElement("span");
      labelSpan.className = "toggle-group__label";
      labelSpan.textContent = def.label;
      group.appendChild(labelSpan);

      // Click on the label area (group background) toggles all
      group.addEventListener("click", (e) => {
        // If the click was on a sub-button, don't toggle all
        if (e.target.closest(".toggle-group__sub")) return;
        const allCurrentlyOn = def.keys.every(k => state.toggles[k]);
        const newVal = !allCurrentlyOn;
        def.keys.forEach(k => {
          state.toggles[k] = newVal;
          if (!newVal) state.toggleJustTurnedOff[k] = true;
        });
        updateToggleGroupUI(group, def);
      });
      group.addEventListener("mouseenter", () => { state.hoveredToggle = [...def.keys]; });
      group.addEventListener("mouseleave", () => {
        if (Array.isArray(state.hoveredToggle)) state.hoveredToggle = null;
        def.keys.forEach(k => delete state.toggleJustTurnedOff[k]);
      });

      // Sub-buttons container — sits inside the outer button
      const subContainer = document.createElement("div");
      subContainer.className = "toggle-group__subs";

      // Sub-buttons
      def.children.forEach((child) => {
        const subBtn = document.createElement("button");
        subBtn.className = "toggle-group__sub" + (state.toggles[child.key] ? " toggle-group__sub--on" : "");
        subBtn.type = "button";
        subBtn.dataset.toggleKey = child.key;

        // Apply color from colorKey
        if (child.colorKey && userColors[child.colorKey]) {
          const hex = userColors[child.colorKey];
          const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
          subBtn.style.setProperty('--sub-toggle-color', hex);
          subBtn.style.setProperty('--sub-toggle-bg', `rgba(${r},${g},${b},0.15)`);
          subBtn.style.setProperty('--sub-toggle-bg-light', `rgba(${r},${g},${b},0.12)`);
        }

        const subSpan = document.createElement("span");
        subSpan.textContent = child.label;
        subBtn.appendChild(subSpan);

        subBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          state.toggles[child.key] = !state.toggles[child.key];
          if (!state.toggles[child.key]) state.toggleJustTurnedOff[child.key] = true;
          subBtn.classList.toggle("toggle-group__sub--on", state.toggles[child.key]);
          updateToggleGroupUI(group, def);
        });
        subBtn.addEventListener("mouseenter", () => { state.hoveredToggle = child.key; });
        subBtn.addEventListener("mouseleave", () => {
          if (state.hoveredToggle === child.key) state.hoveredToggle = null;
          delete state.toggleJustTurnedOff[child.key];
        });

        subContainer.appendChild(subBtn);
      });

      group.appendChild(subContainer);
      bar.appendChild(group);
    } else {
      // Regular toggle button
      const btn = document.createElement("button");
      btn.className = "graph-toggle-btn" + (state.toggles[def.key] ? " graph-toggle-btn--on" : "");
      btn.type = "button";
      btn.dataset.toggleKey = def.key;

      const span = document.createElement("span");
      span.textContent = def.label;
      btn.appendChild(span);

      btn.addEventListener("click", () => {
        state.toggles[def.key] = !state.toggles[def.key];
        const isOn = state.toggles[def.key];
        btn.classList.toggle("graph-toggle-btn--on", isOn);
        if (!isOn) state.toggleJustTurnedOff[def.key] = true;
      });
      btn.addEventListener("mouseenter", () => { state.hoveredToggle = def.key; });
      btn.addEventListener("mouseleave", () => {
        if (state.hoveredToggle === def.key) state.hoveredToggle = null;
        delete state.toggleJustTurnedOff[def.key];
      });

      bar.appendChild(btn);
    }
  });

  // ---- HUD toggle inside the visibility toggles bar ----
  {
    const hudBtn = document.createElement("button");
    hudBtn.className = "graph-toggle-btn" + (state.hudVisible ? " graph-toggle-btn--on" : "");
    hudBtn.type = "button";
    hudBtn.id = "hud-toggle";
    hudBtn.title = "Show / hide coordinate info overlay";
    const span = document.createElement("span");
    span.textContent = "HUD";
    hudBtn.appendChild(span);
    hudBtn.addEventListener("click", () => {
      state.hudVisible = !state.hudVisible;
      hudBtn.classList.toggle("graph-toggle-btn--on", state.hudVisible);
      if (ui.hudEl) ui.hudEl.style.display = state.hudVisible ? 'block' : 'none';
    });
    bar.appendChild(hudBtn);
  }

  // Reset button placed just below the expression window accordion
  if (ui.resetOverlay) {
    const exprWindow = document.getElementById('expr-window');
    if (exprWindow) exprWindow.after(ui.resetOverlay);
  }
}

/* ========== Graph Controls section in expr-window ========== */

function populateGraphControlsSection() {
  const body = document.getElementById('ew-body-controls');
  if (!body) return;
  body.innerHTML = '';

  // Move all button groups from mode-toggle-overlay into the section
  const overlay = document.getElementById('mode-toggle-overlay');
  if (overlay) {
    const groups = Array.from(overlay.querySelectorAll('.mode-toggle__buttons'));
    const wrap = document.createElement('div');
    wrap.className = 'ew-controls-wrap';
    groups.forEach(g => {
      const clone = g.cloneNode(true);
      wrap.appendChild(clone);
    });
    body.appendChild(wrap);

    // Wire up cloned mode buttons
    const modeBtns = body.querySelectorAll('#mode-toggle .mode-btn, [data-mode]');
    modeBtns.forEach(btn => {
      if (!btn.dataset.mode) return;
      btn.addEventListener('click', () => {
        state.mode = btn.dataset.mode;
        // Sync both overlay and section
        body.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('mode-btn--active', b.dataset.mode === btn.dataset.mode));
        overlay.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('mode-btn--active', b.dataset.mode === btn.dataset.mode));
        if (ui.modeButtons) ui.modeButtons.forEach(b => b.classList.toggle('mode-btn--active', b.dataset.mode === btn.dataset.mode));
        setStatusForCurrentMode();
      });
    });

    // Wire up cloned rotation buttons
    const rotBtns = body.querySelectorAll('[data-rot]');
    rotBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const angle = parseFloat(btn.dataset.rot);
        view.rotation = angle;
        body.querySelectorAll('[data-rot]').forEach(b => b.classList.toggle('mode-btn--active', b === btn));
        if (ui.rotBtns) ui.rotBtns.forEach(b => b.classList.toggle('mode-btn--active', parseFloat(b.dataset.rot) === angle));
        state.viewDirty = true;
        if (ui.resetOverlay && angle !== 0) ui.resetOverlay.style.display = "";
      });
    });

    // Wire up cloned discrete buttons
    const discBtns = body.querySelectorAll('[data-discrete]');
    discBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        state.discreteMode = btn.dataset.discrete;
        body.querySelectorAll('[data-discrete]').forEach(b => b.classList.toggle('mode-btn--active', b.dataset.discrete === state.discreteMode));
        document.querySelectorAll('.discrete-btn').forEach(b => b.classList.toggle('mode-btn--active', b.dataset.discrete === state.discreteMode));
      });
    });

    // Wire up simple toggle buttons (tau, glow, numeral, EQ)
    const tauBtn = body.querySelector('#tau-toggle') || body.querySelector('.tau-toggle');
    if (tauBtn) {
      // Clone has same id — remove it to avoid duplicates, use class instead
      tauBtn.removeAttribute('id');
      tauBtn.addEventListener('click', () => {
        state.tauMode = !state.tauMode;
        tauBtn.classList.toggle('mode-btn--active', state.tauMode);
        const orig = document.getElementById('tau-toggle');
        if (orig) orig.classList.toggle('mode-btn--active', state.tauMode);
      });
    }
    const glowBtn = body.querySelector('#glow-toggle');
    if (glowBtn) {
      glowBtn.removeAttribute('id');
      glowBtn.addEventListener('click', () => {
        state.glowCurves = !state.glowCurves;
        glowBtn.classList.toggle('mode-btn--active', state.glowCurves);
        const orig = document.getElementById('glow-toggle');
        if (orig) orig.classList.toggle('mode-btn--active', state.glowCurves);
      });
    }
    const numBtn = body.querySelector('#numeral-toggle');
    if (numBtn) {
      numBtn.removeAttribute('id');
      numBtn.addEventListener('click', () => {
        state.numeralMode = !state.numeralMode;
        numBtn.classList.toggle('mode-btn--active', state.numeralMode);
        const orig = document.getElementById('numeral-toggle');
        if (orig) orig.classList.toggle('mode-btn--active', state.numeralMode);
      });
    }
    const eqBtn = body.querySelector('#eq-toggle');
    if (eqBtn) {
      eqBtn.removeAttribute('id');
      eqBtn.addEventListener('click', () => {
        state.equalizeColors = !state.equalizeColors;
        eqBtn.classList.toggle('mode-btn--active', state.equalizeColors);
        const orig = document.getElementById('eq-toggle');
        if (orig) orig.classList.toggle('mode-btn--active', state.equalizeColors);
      });
    }
  }
}

/* ========== Visibility section in expr-window ========== */

function populateVisibilitySection() {
  const body = document.getElementById('ew-body-visibility');
  if (!body) return;
  body.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'ew-visibility-wrap';

  toggleDefs.forEach((def) => {
    if (def.type === 'group') {
      const group = document.createElement('div');
      group.className = 'toggle-group graph-toggle-btn';
      group.setAttribute('role', 'button');
      group.tabIndex = 0;

      const allOn = def.keys.every(k => state.toggles[k]);
      const anyOn = def.keys.some(k => state.toggles[k]);
      if (allOn) group.classList.add('graph-toggle-btn--on');
      else if (anyOn) group.classList.add('graph-toggle-btn--partial');

      const labelSpan = document.createElement('span');
      labelSpan.className = 'toggle-group__label';
      labelSpan.textContent = def.label;
      group.appendChild(labelSpan);

      group.addEventListener('click', (e) => {
        if (e.target.closest('.toggle-group__sub')) return;
        const allCurrentlyOn = def.keys.every(k => state.toggles[k]);
        const newVal = !allCurrentlyOn;
        def.keys.forEach(k => {
          state.toggles[k] = newVal;
          if (!newVal) state.toggleJustTurnedOff[k] = true;
        });
        updateToggleGroupUI(group, def);
      });
      group.addEventListener('mouseenter', () => { state.hoveredToggle = [...def.keys]; });
      group.addEventListener('mouseleave', () => {
        if (Array.isArray(state.hoveredToggle)) state.hoveredToggle = null;
        def.keys.forEach(k => delete state.toggleJustTurnedOff[k]);
      });

      const subContainer = document.createElement('div');
      subContainer.className = 'toggle-group__subs';
      def.children.forEach(child => {
        const subBtn = document.createElement('button');
        subBtn.className = 'toggle-group__sub' + (state.toggles[child.key] ? ' toggle-group__sub--on' : '');
        subBtn.type = 'button';
        subBtn.dataset.toggleKey = child.key;
        if (child.colorKey && userColors[child.colorKey]) {
          const hex = userColors[child.colorKey];
          const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
          subBtn.style.setProperty('--sub-toggle-color', hex);
          subBtn.style.setProperty('--sub-toggle-bg', `rgba(${r},${g},${b},0.15)`);
          subBtn.style.setProperty('--sub-toggle-bg-light', `rgba(${r},${g},${b},0.12)`);
        }
        const subSpan = document.createElement('span');
        subSpan.textContent = child.label;
        subBtn.appendChild(subSpan);
        subBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          state.toggles[child.key] = !state.toggles[child.key];
          if (!state.toggles[child.key]) state.toggleJustTurnedOff[child.key] = true;
          subBtn.classList.toggle('toggle-group__sub--on', state.toggles[child.key]);
          updateToggleGroupUI(group, def);
        });
        subBtn.addEventListener('mouseenter', () => { state.hoveredToggle = child.key; });
        subBtn.addEventListener('mouseleave', () => {
          if (state.hoveredToggle === child.key) state.hoveredToggle = null;
          delete state.toggleJustTurnedOff[child.key];
        });
        subContainer.appendChild(subBtn);
      });
      group.appendChild(subContainer);
      wrap.appendChild(group);
    } else {
      const btn = document.createElement('button');
      btn.className = 'graph-toggle-btn' + (state.toggles[def.key] ? ' graph-toggle-btn--on' : '');
      btn.type = 'button';
      btn.dataset.toggleKey = def.key;
      const span = document.createElement('span');
      span.textContent = def.label;
      btn.appendChild(span);
      btn.addEventListener('click', () => {
        state.toggles[def.key] = !state.toggles[def.key];
        btn.classList.toggle('graph-toggle-btn--on', state.toggles[def.key]);
        if (!state.toggles[def.key]) state.toggleJustTurnedOff[def.key] = true;
      });
      btn.addEventListener('mouseenter', () => { state.hoveredToggle = def.key; });
      btn.addEventListener('mouseleave', () => {
        if (state.hoveredToggle === def.key) state.hoveredToggle = null;
        delete state.toggleJustTurnedOff[def.key];
      });
      wrap.appendChild(btn);
    }
  });

  // HUD toggle
  {
    const hudBtn = document.createElement('button');
    hudBtn.className = 'graph-toggle-btn' + (state.hudVisible ? ' graph-toggle-btn--on' : '');
    hudBtn.type = 'button';
    hudBtn.title = 'Show / hide coordinate info overlay';
    const span = document.createElement('span');
    span.textContent = 'HUD';
    hudBtn.appendChild(span);
    hudBtn.addEventListener('click', () => {
      state.hudVisible = !state.hudVisible;
      hudBtn.classList.toggle('graph-toggle-btn--on', state.hudVisible);
      if (ui.hudEl) ui.hudEl.style.display = state.hudVisible ? 'block' : 'none';
    });
    wrap.appendChild(hudBtn);
  }

  body.appendChild(wrap);
}

function windowResized() {
  resizeCanvas(window.innerWidth, window.innerHeight);
}

/* ========== Mobile: eye-icon visibility toggle panel ========== */

function setupMobileTogglePanel() {
  if (!document.body.classList.contains('mobile')) return;

  const eyeBtn = document.getElementById('mobile-eye-toggle');
  const panel = document.getElementById('mobile-toggle-panel');
  if (!eyeBtn || !panel) return;

  // Build toggle buttons into the panel (mirrors buildToggleBar but bigger)
  function populatePanel() {
    panel.innerHTML = '';

    const labelSpan = document.createElement('span');
    labelSpan.className = 'graph-toggles-label';
    labelSpan.textContent = 'Visibility toggles';
    panel.appendChild(labelSpan);

    toggleDefs.forEach((def) => {
      if (def.type === 'group') {
        // Same outer-button structure as desktop
        const group = document.createElement('div');
        group.className = 'toggle-group graph-toggle-btn';
        group.setAttribute('role', 'button');
        group.tabIndex = 0;

        const allOn = def.keys.every(k => state.toggles[k]);
        const anyOn = def.keys.some(k => state.toggles[k]);
        if (allOn) group.classList.add('graph-toggle-btn--on');
        else if (anyOn) group.classList.add('graph-toggle-btn--partial');

        const labelSpan = document.createElement('span');
        labelSpan.className = 'toggle-group__label';
        labelSpan.textContent = def.label;
        group.appendChild(labelSpan);

        group.addEventListener('click', (e) => {
          if (e.target.closest('.toggle-group__sub')) return;
          const allCurrentlyOn = def.keys.every(k => state.toggles[k]);
          const newVal = !allCurrentlyOn;
          def.keys.forEach(k => {
            state.toggles[k] = newVal;
            if (!newVal) state.toggleJustTurnedOff[k] = true;
          });
          updateMobilePanelUI();
          // Also sync desktop toggle bar
          if (typeof updateToggleGroupUI === 'function') {
            const desktopGroups = ui.graphTogglesEl?.querySelectorAll('.toggle-group');
            desktopGroups?.forEach(dg => {
              // Match by label
              const lbl = dg.querySelector('.toggle-group__label');
              if (lbl && lbl.textContent === def.label) updateToggleGroupUI(dg, def);
            });
          }
        });

        const subContainer = document.createElement('div');
        subContainer.className = 'toggle-group__subs';

        def.children.forEach((child) => {
          const subBtn = document.createElement('button');
          subBtn.className = 'toggle-group__sub' + (state.toggles[child.key] ? ' toggle-group__sub--on' : '');
          subBtn.type = 'button';
          subBtn.dataset.toggleKey = child.key;

          if (child.colorKey && userColors[child.colorKey]) {
            const hex = userColors[child.colorKey];
            const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
            subBtn.style.setProperty('--sub-toggle-color', hex);
            subBtn.style.setProperty('--sub-toggle-bg', `rgba(${r},${g},${b},0.15)`);
            subBtn.style.setProperty('--sub-toggle-bg-light', `rgba(${r},${g},${b},0.12)`);
          }

          subBtn.textContent = child.label;

          subBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            state.toggles[child.key] = !state.toggles[child.key];
            if (!state.toggles[child.key]) state.toggleJustTurnedOff[child.key] = true;
            updateMobilePanelUI();
          });

          subContainer.appendChild(subBtn);
        });

        group.appendChild(subContainer);
        panel.appendChild(group);
      } else {
        const btn = document.createElement('button');
        btn.className = 'graph-toggle-btn' + (state.toggles[def.key] ? ' graph-toggle-btn--on' : '');
        btn.type = 'button';
        btn.dataset.toggleKey = def.key;
        btn.textContent = def.label;

        btn.addEventListener('click', () => {
          state.toggles[def.key] = !state.toggles[def.key];
          if (!state.toggles[def.key]) state.toggleJustTurnedOff[def.key] = true;
          updateMobilePanelUI();
        });

        panel.appendChild(btn);
      }
    });
  }

  function updateMobilePanelUI() {
    // Standalone buttons
    panel.querySelectorAll('.graph-toggle-btn[data-toggle-key]').forEach(btn => {
      const key = btn.dataset.toggleKey;
      btn.classList.toggle('graph-toggle-btn--on', !!state.toggles[key]);
    });
    // Sub-buttons
    panel.querySelectorAll('.toggle-group__sub[data-toggle-key]').forEach(btn => {
      const key = btn.dataset.toggleKey;
      btn.classList.toggle('toggle-group__sub--on', !!state.toggles[key]);
    });
    // Group parent (the toggle-group div itself)
    panel.querySelectorAll('.toggle-group').forEach(groupEl => {
      const subBtns = groupEl.querySelectorAll('.toggle-group__sub');
      const keys = Array.from(subBtns).map(b => b.dataset.toggleKey);
      const allOn = keys.every(k => state.toggles[k]);
      const anyOn = keys.some(k => state.toggles[k]);
      groupEl.classList.toggle('graph-toggle-btn--on', allOn);
      groupEl.classList.toggle('graph-toggle-btn--partial', !allOn && anyOn);
    });
  }

  populatePanel();

  eyeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.classList.toggle('open');
    eyeBtn.classList.toggle('active', panel.classList.contains('open'));
  });

  // Close panel when tapping outside
  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target) && e.target !== eyeBtn) {
      panel.classList.remove('open');
      eyeBtn.classList.remove('active');
    }
  });
}

/* ========== Mobile: touch handlers (pinch-zoom, drag-pan, cursor offset) ========== */

function setupTouchHandlers() {
  if (!document.body.classList.contains('mobile')) return;

  const canvasWrap = document.getElementById('canvas-wrap');
  if (!canvasWrap) return;

  let activeTouches = [];
  let isPinching = false;
  let initialPinchDist = 0;
  let initialScale = 0;
  // For simultaneous pan+zoom: track pinch center movement
  let prevPinchCenterX = 0;
  let prevPinchCenterY = 0;
  let pinchWorldCenter = null;
  const CURSOR_OFFSET_Y = -60;

  let touchCursorX = -1;
  let touchCursorY = -1;
  let touchActive = false;

  window._mobileTouchCursor = { x: -1, y: -1, active: false };

  function getTouchDist(t1, t2) {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function getTouchCenter(t1, t2) {
    return {
      x: (t1.clientX + t2.clientX) / 2,
      y: (t1.clientY + t2.clientY) / 2,
    };
  }

  function inputIsFocused() {
    const el = document.activeElement;
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
  }

  canvasWrap.addEventListener('touchstart', (e) => {
    if (inputIsFocused()) return;
    // Don't interfere with timeline slider or other UI controls
    const t = e.touches[0];
    if (t && isOverUI(t.clientX, t.clientY)) return;
    activeTouches = Array.from(e.touches);

    if (activeTouches.length === 2) {
      isPinching = true;
      initialPinchDist = getTouchDist(activeTouches[0], activeTouches[1]);
      initialScale = view.scale;
      const center = getTouchCenter(activeTouches[0], activeTouches[1]);
      prevPinchCenterX = center.x;
      prevPinchCenterY = center.y;
      pinchWorldCenter = screenToWorld(center.x, center.y);
      e.preventDefault();
    } else if (activeTouches.length === 1) {
      if (!isOverUI(activeTouches[0].clientX, activeTouches[0].clientY)) {
        state.isPanning = true;
        state.panStartMouseX = activeTouches[0].clientX;
        state.panStartMouseY = activeTouches[0].clientY;
        state.panStartOriginX = view.originX;
        state.panStartOriginY = view.originY;

        touchCursorX = activeTouches[0].clientX;
        touchCursorY = activeTouches[0].clientY + CURSOR_OFFSET_Y;
        touchActive = true;
        window._mobileTouchCursor = { x: touchCursorX, y: touchCursorY, active: true };
      }
    }
  }, { passive: false });

  canvasWrap.addEventListener('touchmove', (e) => {
    if (inputIsFocused()) return;
    activeTouches = Array.from(e.touches);

    if (isPinching && activeTouches.length >= 2) {
      // Simultaneous zoom + pan
      const newDist = getTouchDist(activeTouches[0], activeTouches[1]);
      const zoomFactor = newDist / initialPinchDist;
      const nextScale = constrain(initialScale * zoomFactor, 12, 1200);
      view.scale = nextScale;

      const center = getTouchCenter(activeTouches[0], activeTouches[1]);

      // Recompute origin: zoom about initial pinch world point + pan by center delta
      const c = Math.cos(view.rotation), s = Math.sin(view.rotation);
      view.originX = center.x - (pinchWorldCenter.x * c - pinchWorldCenter.y * s) * view.scale;
      view.originY = center.y + (pinchWorldCenter.x * s + pinchWorldCenter.y * c) * view.scale;

      prevPinchCenterX = center.x;
      prevPinchCenterY = center.y;

      state.viewDirty = true;
      if (ui.resetOverlay) ui.resetOverlay.style.display = "";
      e.preventDefault();
    } else if (state.isPanning && activeTouches.length === 1) {
      const dx = activeTouches[0].clientX - state.panStartMouseX;
      const dy = activeTouches[0].clientY - state.panStartMouseY;
      view.originX = state.panStartOriginX + dx;
      view.originY = state.panStartOriginY + dy;
      state.viewDirty = true;
      if (ui.resetOverlay) ui.resetOverlay.style.display = "";

      touchCursorX = activeTouches[0].clientX;
      touchCursorY = activeTouches[0].clientY + CURSOR_OFFSET_Y;
      window._mobileTouchCursor = { x: touchCursorX, y: touchCursorY, active: true };
      e.preventDefault();
    }
  }, { passive: false });

  canvasWrap.addEventListener('touchend', (e) => {
    const prevPanning = state.isPanning;
    const panSX = state.panStartMouseX;
    const panSY = state.panStartMouseY;
    activeTouches = Array.from(e.touches);
    if (activeTouches.length < 2) {
      if (isPinching && activeTouches.length === 1) {
        // Transition from pinch back to single-finger: restart pan from current position
        state.isPanning = true;
        state.panStartMouseX = activeTouches[0].clientX;
        state.panStartMouseY = activeTouches[0].clientY;
        state.panStartOriginX = view.originX;
        state.panStartOriginY = view.originY;
      }
      isPinching = false;
    }
    if (activeTouches.length === 0) {
      state.isPanning = false;
      // Check for tap (small drag) in discrete mode
      if (prevPanning && e.changedTouches && e.changedTouches.length > 0) {
        const ct = e.changedTouches[0];
        const tdx = ct.clientX - panSX;
        const tdy = ct.clientY - panSY;
        if (Math.sqrt(tdx * tdx + tdy * tdy) < 10 && isDiscreteAny()) {
          handleDiscreteColumnClick(ct.clientX, ct.clientY);
        }
      }
      setTimeout(() => {
        touchActive = false;
        window._mobileTouchCursor = { x: -1, y: -1, active: false };
      }, 1500);
    }
  });

  // Prevent default to stop iOS scroll/bounce — but not for UI controls
  canvasWrap.addEventListener('touchmove', (e) => {
    if (activeTouches.length >= 1 && (state.isPanning || isPinching)) e.preventDefault();
  }, { passive: false });
}

/* ========== Mobile: bar controls (collapse, positioning, pseudo-fullscreen, tap-to-show) ========== */

function setupMobileBarControls() {
  if (!document.body.classList.contains('mobile')) return;

  const topbar = document.querySelector('.topbar');
  const collapseBtn = document.getElementById('topbar-collapse-btn');
  const modeToggle = document.getElementById('mode-toggle-overlay');
  const timeline = document.getElementById('timeline-control');
  const pseudoFsBtn = document.getElementById('pseudofs-btn');

  // ---- 1. Topbar collapse toggle ----
  if (collapseBtn && topbar) {
    collapseBtn.addEventListener('click', () => {
      topbar.classList.toggle('collapsed');
      updateMobileBarPositions();
    });
  }

  // ---- 1b. Mode dropdown (portrait only) ----
  const modeDropdownTrigger = document.getElementById('mode-dropdown-trigger');
  const modeDropdownList = document.getElementById('mode-dropdown-list');
  if (modeDropdownTrigger && modeDropdownList) {
    // Toggle dropdown on trigger click
    modeDropdownTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      modeDropdownList.classList.toggle('open');
    });

    // Close dropdown on outside click
    document.addEventListener('click', (e) => {
      if (!modeDropdownTrigger.contains(e.target) && !modeDropdownList.contains(e.target)) {
        modeDropdownList.classList.remove('open');
      }
    });

    // Update trigger text when a mode button inside the list is clicked
    const modeLabels = { cartesian: 'Cartesian', delta: 'Δ from x', numberLines: 'Parallel' };
    modeDropdownList.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        if (mode && modeLabels[mode]) {
          modeDropdownTrigger.textContent = modeLabels[mode] + ' ▾';
          // Actually switch the mode
          state.mode = mode;
          // Update active styling on all mode buttons
          if (ui.modeButtons) {
            ui.modeButtons.forEach(b => b.classList.toggle('mode-btn--active', b.dataset.mode === mode));
          }
          setStatusForCurrentMode();
        }
        modeDropdownList.classList.remove('open');
      });
    });
  }

  // ---- 2. Dynamic positioning: mode bar & timeline above topbar ----
  function updateMobileBarPositions() {
    if (!topbar) return;
    const topbarH = topbar.getBoundingClientRect().height;

    if (modeToggle) {
      modeToggle.style.bottom = topbarH + 'px';
    }
    if (timeline) {
      // Timeline sits above mode-toggle if visible, else above topbar
      const modeVisible = modeToggle && getComputedStyle(modeToggle).display !== 'none';
      const modeH = modeVisible ? modeToggle.getBoundingClientRect().height : 0;
      timeline.style.bottom = (topbarH + modeH) + 'px';
    }
  }

  // Run positioning after layout settles (multiple attempts for robustness)
  requestAnimationFrame(() => {
    updateMobileBarPositions();
    // Second pass after dynamic content settles
    setTimeout(updateMobileBarPositions, 100);
    setTimeout(updateMobileBarPositions, 500);
  });
  window.addEventListener('resize', updateMobileBarPositions);
  window.addEventListener('orientationchange', () => {
    setTimeout(updateMobileBarPositions, 300);
  });

  // Also update when mode-toggle visibility changes (e.g. mode buttons toggled)
  if (modeToggle) {
    const observer = new MutationObserver(updateMobileBarPositions);
    observer.observe(modeToggle, { attributes: true, attributeFilter: ['style', 'class'] });
  }

  // ---- 3. Pseudo-fullscreen ----
  // Use Fullscreen API where supported; on iOS suggest PWA.
  if (pseudoFsBtn) {
    const isStandalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
    const isIOS = document.body.classList.contains('ios');

    if (isStandalone) {
      pseudoFsBtn.style.display = 'none';
    } else {
      let fsActive = false;

      pseudoFsBtn.addEventListener('click', () => {
        if (fsActive) return;
        // Try standard Fullscreen API first (works on Firefox Android, Chrome Android)
        const docEl = document.documentElement;
        const tryFullscreen = docEl.requestFullscreen || docEl.webkitRequestFullscreen || docEl.mozRequestFullScreen || docEl.msRequestFullscreen;
        if (tryFullscreen) {
          const promise = tryFullscreen.call(docEl);
          if (promise && promise.then) {
            promise.then(() => {
              fsActive = true;
              pseudoFsBtn.style.display = 'none';
            }).catch(() => {
              showPWAHint();
            });
          } else {
            fsActive = true;
            pseudoFsBtn.style.display = 'none';
          }
        } else {
          showPWAHint();
        }
      });

      function showPWAHint() {
        // iOS doesn't support fullscreen API in browser — suggest Add to Home Screen
        if (isIOS) {
          pseudoFsBtn.innerHTML = '<span style="font-size:0.7rem">Add to Home Screen (Share → Add) for fullscreen</span>';
        } else {
          pseudoFsBtn.innerHTML = '<span style="font-size:0.7rem">Install as app for fullscreen</span>';
        }
        setTimeout(() => { pseudoFsBtn.style.display = 'none'; }, 6000);
      }

      // Monitor visual viewport for chrome show/hide — resize canvas accordingly
      if (window.visualViewport) {
        let lastVVH = window.visualViewport.height;
        window.visualViewport.addEventListener('resize', () => {
          const newH = window.visualViewport.height;
          if (Math.abs(newH - lastVVH) > 10) {
            lastVVH = newH;
            if (typeof resizeCanvas === 'function') {
              resizeCanvas(window.innerWidth, window.innerHeight);
            }
            updateMobileBarPositions();
          }
        });
      }

      // Fullscreen change listener
      const onFsChange = () => {
        const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement);
        if (!isFs && fsActive) {
          fsActive = false;
          pseudoFsBtn.style.display = '';
        }
      };
      document.addEventListener('fullscreenchange', onFsChange);
      document.addEventListener('webkitfullscreenchange', onFsChange);
    }

    // Show button again on orientation change
    window.addEventListener('orientationchange', () => {
      pseudoFsBtn.style.display = '';
      setTimeout(() => updateMobileBarPositions(), 500);
    });
  }

  // ---- 4. Mobile op-block gestures are handled in renderStepRepresentation ----
  // (drag-to-trash for delete, swipe-down for swap)

  // ---- 5. Eye-toggle mode in op boxes ----
  setupEyeToggleMode();
}

/* ========== Mobile: eye-toggle mode (replace box contents with eye toggles) ========== */
function setupEyeToggleMode() {
  const eyeBtn = document.getElementById('step-eye-mode-btn');
  if (!eyeBtn) return;

  state.stepEyeMode = false;

  eyeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    state.stepEyeMode = !state.stepEyeMode;
    eyeBtn.classList.toggle('active', state.stepEyeMode);

    // Re-render steps with eye mode
    renderStepRepresentation();
  });
}

function isMouseOverCanvas() {
  return mouseX >= 0 && mouseX <= width && mouseY >= 0 && mouseY <= height;
}

/** Show or hide the timeline control based on whether expression uses t. */
function updateTimelineVisibility() {
  const el = document.getElementById('timeline-control');
  if (!el) return;
  el.style.display = state.usesT ? '' : 'none';
  // Reposition mobile bars since timeline affects stacking
  if (document.body.classList.contains('mobile')) {
    requestAnimationFrame(() => {
      const topbar = document.querySelector('.topbar');
      const modeToggle = document.getElementById('mode-toggle-overlay');
      if (topbar) {
        const topbarH = topbar.getBoundingClientRect().height;
        if (modeToggle) modeToggle.style.bottom = topbarH + 'px';
        const modeVisible = modeToggle && getComputedStyle(modeToggle).display !== 'none';
        const modeH = modeVisible ? modeToggle.getBoundingClientRect().height : 0;
        el.style.bottom = (topbarH + modeH) + 'px';
      }
    });
  }
}

/** Wire up timeline slider, play/pause, and keyboard shortcuts. */
function setupTimeline() {
  const slider = document.getElementById('timeline-slider');
  const playBtn = document.getElementById('timeline-play');
  const valEl = document.getElementById('timeline-value');
  if (!slider || !playBtn || !valEl) return;

  slider.addEventListener('input', () => {
    state.t = parseFloat(slider.value);
    window._gcT = state.t;
    valEl.textContent = 't = ' + state.t.toFixed(2);
  });

  playBtn.addEventListener('click', () => {
    state.tPlaying = !state.tPlaying;
    const playIcon = playBtn.querySelector('.play-icon');
    const pauseIcon = playBtn.querySelector('.pause-icon');
    if (playIcon && pauseIcon) {
      playIcon.style.display = state.tPlaying ? 'none' : '';
      pauseIcon.style.display = state.tPlaying ? '' : 'none';
    }
    playBtn.classList.toggle('timeline-play-btn--active', state.tPlaying);
  });

  // Keyboard: Space toggles play when timeline is visible
  document.addEventListener('keydown', (e) => {
    if (!state.usesT) return;
    // Don't hijack space when typing in the expression input
    if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      playBtn.click();
    }
  });
}

function isOverUI(cx, cy) {
  // cx, cy are optional explicit coordinates (for touch); fallback to p5 mouseX/mouseY
  const checkX = cx !== undefined ? cx : mouseX;
  const checkY = cy !== undefined ? cy : mouseY;
  const topbar = document.querySelector('.topbar');
  const toggles = ui.graphTogglesEl;
  const settingsMenu = document.getElementById('settingsMenu');
  const modeOverlay = document.getElementById('mode-toggle-overlay');
  const timelineCtrl = document.getElementById('timeline-control');
  const mobilePanel = document.getElementById('mobile-toggle-panel');
  const mobileEye = document.getElementById('mobile-eye-toggle');
  const settingsGear = document.getElementById('settingsGear');
  const trashZoneEl = document.getElementById('trash-zone');
  const exprWindow = document.getElementById('expr-window');
  const radialBackdrop = document.getElementById('radial-menu-backdrop');
  const radialPortal = document.getElementById('radial-menu-portal');
  const nodeTooltip = document.querySelector('.node-tooltip');
  const els = [topbar, toggles, settingsMenu, modeOverlay, timelineCtrl, mobilePanel, mobileEye, settingsGear, trashZoneEl, exprWindow, radialBackdrop, radialPortal, nodeTooltip];
  for (const el of els) {
    if (!el || el.style.display === 'none') continue;
    const r = el.getBoundingClientRect();
    if (checkX >= r.left && checkX <= r.right && checkY >= r.top && checkY <= r.bottom) return true;
  }
  return false;
}

function mousePressed() {
  if (document.body.classList.contains('mobile')) return;
  if (!isMouseOverCanvas() || isOverUI()) return;
  state.isPanning = true;
  state.panStartMouseX = mouseX;
  state.panStartMouseY = mouseY;
  state.panStartOriginX = view.originX;
  state.panStartOriginY = view.originY;
}

function mouseDragged() {
  if (document.body.classList.contains('mobile')) return;
  if (!state.isPanning) return;
  const dx = mouseX - state.panStartMouseX;
  const dy = mouseY - state.panStartMouseY;
  view.originX = state.panStartOriginX + dx;
  view.originY = state.panStartOriginY + dy;
  state.viewDirty = true;
  if (ui.resetOverlay) ui.resetOverlay.style.display = "";
}

function mouseReleased() {
  if (state.isPanning) {
    const dx = mouseX - state.panStartMouseX;
    const dy = mouseY - state.panStartMouseY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    state.isPanning = false;
    // Treat as a click if the drag distance was tiny
    if (dist < 5 && isDiscreteAny()) {
      handleDiscreteColumnClick(mouseX, mouseY);
    }
  }
}

function mouseWheel(event) {
  if (document.body.classList.contains('mobile')) return;
  if (!isMouseOverCanvas() || isOverUI()) return;

  // Zoom about cursor:
  const before = screenToWorld(mouseX, mouseY);
  const zoomFactor = Math.exp(-event.delta * 0.0012);
  const nextScale = constrain(view.scale * zoomFactor, 12, 1200);

  view.scale = nextScale;

  // Recompute origin so the world point under the cursor stays fixed
  const c = Math.cos(view.rotation), s = Math.sin(view.rotation);
  view.originX = mouseX - (before.x * c - before.y * s) * view.scale;
  view.originY = mouseY + (before.x * s + before.y * c) * view.scale;

  state.viewDirty = true;
  if (ui.resetOverlay) ui.resetOverlay.style.display = "";

  return false;
}

// Draw a four-pointed curved starburst with corners aligned to rotated axes.
// controlR (0→1): 0 = deep cross (concave), 1 = diamond. Default 0.2.
function drawStarburst(cx, cy, col, size, alphaOverride, controlR) {
  if (!state.toggles.starbursts || isDiscreteAny()) return;
  size = size || 4.95;
  const a = alphaOverride !== undefined ? alphaOverride : 255;
  if (controlR === undefined) controlR = 0.2;
  const n = 4;
  const outerR = size * 1.8;

  // Build tip vectors using view rotation (arms along axes)
  const θ = view.rotation;
  const tips = [];
  for (let i = 0; i < n; i++) {
    const angle = θ + (i * TWO_PI) / n;
    tips.push({ x: Math.cos(angle) * outerR, y: -Math.sin(angle) * outerR });
  }
  // Control-point vectors: same angles but at controlR * outerR
  const cpR = controlR * outerR;
  const cpVecs = [];
  for (let i = 0; i < n; i++) {
    const angle = θ + (i * TWO_PI) / n;
    cpVecs.push({ x: Math.cos(angle) * cpR, y: -Math.sin(angle) * cpR });
  }

  push();
  noStroke();
  fill(red(col), green(col), blue(col), a);
  beginShape();
  vertex(cx + tips[0].x, cy + tips[0].y);
  for (let i = 0; i < n; i++) {
    const nxt = (i + 1) % n;
    bezierVertex(
      cx + cpVecs[i].x, cy + cpVecs[i].y,
      cx + cpVecs[nxt].x, cy + cpVecs[nxt].y,
      cx + tips[nxt].x, cy + tips[nxt].y
    );
  }
  endShape();
  pop();
}

function drawKnotCircle(cx, cy, col, radius, alphaOverride) {
  drawStarburst(cx, cy, col, radius || 4.95, alphaOverride);
}

function drawArrowScreen(x1, y1, x2, y2, options = {}) {
  const col = options.col ?? color(255);
  const alpha = options.alpha ?? 220;
  const strokeWeightPx = options.strokeWeightPx ?? 2;

  push();
  stroke(red(col), green(col), blue(col), alpha);
  strokeWeight(strokeWeightPx);
  noFill();
  line(x1, y1, x2, y2);
  pop();
}

/**
 * Draw the cursor starburst: differently colored arms with coordinate labels.
 * Horizontal arms in y-color (green), vertical arms in x-color (blue).
 * Uses the same bezier approach as drawStarburst but with two color passes.
 */
function drawCursorStarburst() {
  if (!isMouseOverCanvas() || isOverUI()) return;
  const cx = mouseX, cy = mouseY;
  const world = screenToWorld(cx, cy);

  const xCol = getStepColor("x");
  const yCol = getStepColor("y");

  // In discrete mode, draw a highlighted pixel instead
  if (isDiscreteAny()) {
    drawDiscreteCursor(cx, cy, world, xCol, yCol);
    return;
  }

  const n = 4;
  const size = 14;
  const outerR = size * 2.2;
  const controlR = 0.2;
  const cpR = controlR * outerR;

  // Build tip and control-point vectors (arms along rotated axes)
  const θ = view.rotation;
  const tips = [];
  const cpVecs = [];
  for (let i = 0; i < n; i++) {
    const angle = θ + (i * TWO_PI) / n;
    tips.push({ x: Math.cos(angle) * outerR, y: -Math.sin(angle) * outerR });
    cpVecs.push({ x: Math.cos(angle) * cpR, y: -Math.sin(angle) * cpR });
  }

  // Arm colors: 0=+x(horiz), 1=+y(vert), 2=-x(horiz), 3=-y(vert)
  const armCols = [yCol, xCol, yCol, xCol];

  push();

  // Draw the full starburst shape once per arm, clipped to that arm's quadrant.
  // This preserves the exact 4-point shape while giving each arm its own color.
  const ctx = drawingContext;
  for (let i = 0; i < n; i++) {
    const col = armCols[i];
    const armAngle = θ + (i * TWO_PI) / n;
    const halfWedge = PI / n; // π/4 for 4 arms
    const farR = outerR * 4;

    ctx.save();
    // Clip to pie-slice quadrant for this arm
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(
      cx + Math.cos(armAngle - halfWedge) * farR,
      cy - Math.sin(armAngle - halfWedge) * farR
    );
    ctx.lineTo(
      cx + Math.cos(armAngle + halfWedge) * farR,
      cy - Math.sin(armAngle + halfWedge) * farR
    );
    ctx.closePath();
    ctx.clip();

    // Draw the full starburst in this arm's color
    noStroke();
    fill(red(col), green(col), blue(col), 230);
    beginShape();
    vertex(cx + tips[0].x, cy + tips[0].y);
    for (let j = 0; j < n; j++) {
      const nxt = (j + 1) % n;
      bezierVertex(
        cx + cpVecs[j].x, cy + cpVecs[j].y,
        cx + cpVecs[nxt].x, cy + cpVecs[nxt].y,
        cx + tips[nxt].x, cy + tips[nxt].y
      );
    }
    endShape();

    ctx.restore();
  }

  // Coordinate labels with glass backgrounds
  const xLabel = formatLiveX(world.x);
  const yLabel = formatLiveNumber(world.y);
  const labelOff = outerR + 8;

  // x-coordinate label: above in x-color (blue)
  drawGlassLabel(xLabel, cx, cy - labelOff,
    { col: xCol, alpha: 220, align: "center", baseline: "bottom", size: 12 });

  // y-coordinate label: to the right in y-color (green)
  drawGlassLabel(yLabel, cx + labelOff, cy,
    { col: yCol, alpha: 220, align: "left", baseline: "center", size: 12 });

  pop();
}

/**
 * Draw a green vertical line from the cursor to the y-curve,
 * with a starburst marker at the curve point and a y-value label.
 */
function drawCursorToYCurve() {
  if (!state.fn || !isMouseOverCanvas() || isOverUI()) return;
  if (state.mode === "numberLines") return; // not applicable in parallel mode

  const world = screenToWorld(mouseX, mouseY);
  const xW = world.x;
  let yW;
  try {
    yW = state.mode === "delta" ? state.fn(xW) - xW : state.fn(xW);
  } catch { return; }
  if (!Number.isFinite(yW)) return;

  const cursorScreen = { x: mouseX, y: mouseY };
  const curveScreen = worldToScreen(xW, yW);

  // Don't draw if curve point is off screen
  if (curveScreen.y < -100 || curveScreen.y > height + 100) return;

  const yCol = getStepColor("y");

  push();
  // Vertical line from cursor to curve point
  stroke(red(yCol), green(yCol), blue(yCol), 100);
  strokeWeight(1);
  setLineDash([4, 4]);
  line(cursorScreen.x, cursorScreen.y, curveScreen.x, curveScreen.y);
  setLineDash([]);

  // Starburst marker at the curve point (draw directly, ignoring starbursts toggle)
  pop();
  {
    // Temporarily enable starbursts so drawStarburst renders even if toggle is off
    const saved = state.toggles.starbursts;
    state.toggles.starbursts = true;
    drawStarburst(curveScreen.x, curveScreen.y, yCol, 5, 220);
    state.toggles.starbursts = saved;
  }

  // y-value label next to the curve point with glass background
  const label = formatLiveNumber(yW);
  // Place label to the right of the curve point, or left if near right edge
  const lx = curveScreen.x + 10;
  const side = lx + 60 < width ? "left" : "right";
  drawGlassLabel(label,
    side === "left" ? curveScreen.x + 10 : curveScreen.x - 10,
    curveScreen.y,
    { col: yCol, alpha: 220, align: side === "left" ? "left" : "right", baseline: "center", size: 12 });
}

/** Helper: set dashed line pattern via canvas context */
function setLineDash(pattern) {
  drawingContext.setLineDash(pattern);
}

function drawCurve(yAtX, curveCol, curveWeight) {
  const col = curveCol || getPlotColor();

  // Glow mode: smooth vertical gradient glow (continuous / discreteX)
  const useGlow = state.glowCurves && state.discreteMode !== "discrete";

  const maxJumpPx = Math.max(120, height * 0.6);
  const { minX, maxX } = getVisibleWorldBounds();
  const step = 1 / view.scale;

  if (useGlow) {
    // Phase 1: sample into screen-space segments (flat array pairs)
    const segments = [];
    let seg = [];
    let prevSx = 0, prevSy = 0;

    for (let wx = minX - step; wx <= maxX + step; wx += step) {
      let wy;
      try { wy = yAtX(wx); } catch { wy = NaN; }
      if (!Number.isFinite(wy)) {
        if (seg.length) { segments.push(seg); seg = []; }
        continue;
      }
      const s = worldToScreen(wx, wy);
      if (seg.length) {
        if (dist(prevSx, prevSy, s.x, s.y) > maxJumpPx) {
          segments.push(seg);
          seg = [];
        }
      }
      seg.push(s.x, s.y);
      prevSx = s.x;
      prevSy = s.y;
    }
    if (seg.length) segments.push(seg);

    // Phase 2: per-column gradient glow (rotated to match y-axis direction)
    const r = red(col), g = green(col), b = blue(col);
    const alphaScale = alpha(col) / 255;
    const ctx = drawingContext;

    const glowRadius = 60;
    const glowH = glowRadius * 2;
    const peakAlpha = 0.50 * alphaScale;

    // Pre-render a 1px-wide gradient column: high peak, fast falloff, long tail
    const gradCanvas = document.createElement('canvas');
    gradCanvas.width = 1;
    gradCanvas.height = glowH;
    const gradCtx = gradCanvas.getContext('2d');
    const grad = gradCtx.createLinearGradient(0, 0, 0, glowH);
    grad.addColorStop(0, `rgba(${r},${g},${b},0)`);
    grad.addColorStop(0.15, `rgba(${r},${g},${b},${(peakAlpha * 0.02).toFixed(4)})`);
    grad.addColorStop(0.30, `rgba(${r},${g},${b},${(peakAlpha * 0.08).toFixed(4)})`);
    grad.addColorStop(0.40, `rgba(${r},${g},${b},${(peakAlpha * 0.25).toFixed(4)})`);
    grad.addColorStop(0.47, `rgba(${r},${g},${b},${(peakAlpha * 0.70).toFixed(4)})`);
    grad.addColorStop(0.5, `rgba(${r},${g},${b},${peakAlpha.toFixed(4)})`);
    grad.addColorStop(0.53, `rgba(${r},${g},${b},${(peakAlpha * 0.70).toFixed(4)})`);
    grad.addColorStop(0.60, `rgba(${r},${g},${b},${(peakAlpha * 0.25).toFixed(4)})`);
    grad.addColorStop(0.70, `rgba(${r},${g},${b},${(peakAlpha * 0.08).toFixed(4)})`);
    grad.addColorStop(0.85, `rgba(${r},${g},${b},${(peakAlpha * 0.02).toFixed(4)})`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    gradCtx.fillStyle = grad;
    gradCtx.fillRect(0, 0, 1, glowH);

    // Glow direction: perpendicular to x-axis = along y-axis in world space
    // In screen space the y-axis points at angle -(rotation + π/2) from rightward
    const glowAngle = -view.rotation;

    // Stamp gradient column at each sample point, rotated to match axis
    ctx.save();
    for (const pts of segments) {
      for (let i = 0; i < pts.length; i += 2) {
        ctx.save();
        ctx.translate(pts[i], pts[i + 1]);
        ctx.rotate(glowAngle);
        ctx.drawImage(gradCanvas, -0.5, -glowRadius, 1, glowH);
        ctx.restore();
      }
    }
    ctx.restore();

    // Phase 3: core hairline — near-white with a hint of chroma
    stroke(255 * 0.8 + r * 0.2, 255 * 0.8 + g * 0.2, 255 * 0.8 + b * 0.2, 255 * alphaScale);
    strokeWeight(0.5);
    noFill();
    for (const pts of segments) {
      if (pts.length < 4) continue;
      beginShape();
      for (let i = 0; i < pts.length; i += 2) vertex(pts[i], pts[i + 1]);
      endShape();
    }
  } else {
    // Standard non-glow rendering (single pass)
    stroke(col);
    strokeWeight(curveWeight || 2);
    noFill();

    let drawing = false;
    let prevSx = 0;
    let prevSy = 0;

    for (let wx = minX - step; wx <= maxX + step; wx += step) {
      let wy;
      try {
        wy = yAtX(wx);
      } catch {
        wy = NaN;
      }

      if (!Number.isFinite(wy)) {
        if (drawing) endShape();
        drawing = false;
        continue;
      }

      const s = worldToScreen(wx, wy);

      if (!drawing) {
        beginShape();
        vertex(s.x, s.y);
        drawing = true;
      } else {
        const jump = dist(prevSx, prevSy, s.x, s.y);
        if (jump > maxJumpPx) {
          endShape();
          beginShape();
        }
        vertex(s.x, s.y);
      }

      prevSx = s.x;
      prevSy = s.y;
    }

    if (drawing) endShape();
  }
}

/**
 * Get the fixed discrete cell size for discrete mode.
 * x-step is 0.1τ in tau mode, 0.1 otherwise; y-step is always 0.1.
 */
function getDiscreteStep() {
  return {
    xStep: 0.1,
    yStep: 0.1
  };
}

/** Compute the rendered cell width & margin for a discrete cell.
 *  xStep is always 0.1 (visual grid never changes); tau mode only affects
 *  which x-values those cells represent via the evaluation scale. */
function getDiscreteCellMetrics(xStep) {
  const mx = xStep * DISCRETE_MODE_PIXEL_X_MARGIN;
  const cellW = xStep - 2 * mx;
  return { cellW, mx };
}

/* ========== Expanded-column mapping for discrete click-to-inspect ========== */

/**
 * Build a complete column layout for the visible range.
 * Returns an array of column descriptors sorted by visual slot:
 *   { slot, worldX, kind, ix, opIdx?, subIdx?, evalFn?, color?, label? }
 * kind: 'data' (original), 'intermediate', 'subintermediate'
 */
function buildExpandedColumnLayout(ix0, ix1, xStep, eS) {
  const steps = state.steps;
  const ops = state.ops;
  const nOps = steps.length - 1;
  const isDelta = state.mode === "delta";
  const cols = [];

  const allExpanded = [...state.expandedCols].sort((a, b) => a - b);

  // Extend ix0 leftward to include expanded columns whose intermediates
  // might spill into the visible range
  let effIx0 = ix0;
  for (const src of allExpanded) {
    if (src >= ix0) break;
    let cnt = nOps;
    for (let opIdx = 0; opIdx < ops.length; opIdx++) {
      if (state.expandedSubCols.has(src + ':' + opIdx)) {
        cnt += getSubintermediateFns(steps[opIdx].fn, ops[opIdx]).length;
      }
    }
    // If intermediates extend to slot ≥ ix0 in display space, include this source
    if (src + cnt >= ix0) effIx0 = Math.min(effIx0, src);
  }

  // Pre-calculate total offset for effIx0 (sum of all insertions before effIx0)
  let offsetForStart = 0;
  for (const src of allExpanded) {
    if (src < effIx0) {
      offsetForStart += nOps;
      for (let opIdx = 0; opIdx < ops.length; opIdx++) {
        if (state.expandedSubCols.has(src + ':' + opIdx)) {
          offsetForStart += getSubintermediateFns(steps[opIdx].fn, ops[opIdx]).length;
        }
      }
    }
  }

  let slot = offsetForStart;
  for (let ix = effIx0; ix <= ix1; ix++) {
    const worldX = (ix + slot) * xStep;
    cols.push({ slot: ix + slot, worldX, kind: 'data', ix });

    if (state.expandedCols.has(ix) && nOps > 0) {
      for (let opIdx = 0; opIdx < nOps; opIdx++) {
        slot++;
        const intWorldX = (ix + slot) * xStep;
        const step = steps[opIdx + 1];
        const prevStep = steps[opIdx];
        cols.push({
          slot: ix + slot, worldX: intWorldX, kind: 'intermediate',
          ix, opIdx, evalFn: step.fn, prevFn: prevStep.fn,
          step, prevStep,
        });

        const subKey = ix + ':' + opIdx;
        if (state.expandedSubCols.has(subKey) && opIdx < ops.length) {
          const subFns = getSubintermediateFns(steps[opIdx].fn, ops[opIdx]);
          for (let si = 0; si < subFns.length; si++) {
            slot++;
            const subWorldX = (ix + slot) * xStep;
            cols.push({
              slot: ix + slot, worldX: subWorldX, kind: 'subintermediate',
              ix, opIdx, subIdx: si, evalFn: subFns[si].fn,
              category: subFns[si].category,
            });
          }
        }
      }
    }
  }
  return cols;
}

/**
 * Convert a screen click position to the logical ix of the clicked column,
 * accounting for expanded intermediate columns.
 * Returns { ix, kind, opIdx? } or null if not on a column.
 */
function screenToDiscreteColumn(sx, sy) {
  const { xStep } = getDiscreteStep();
  const eS = state.tauMode ? 2 * Math.PI : 1;
  const w = screenToWorld(sx, sy);
  const { minX, maxX } = getVisibleWorldBounds();
  const ix0 = Math.floor(minX / xStep) - 1;
  const ix1 = Math.ceil(maxX / xStep) + 1;

  const cols = buildExpandedColumnLayout(ix0, ix1, xStep, eS);
  // Find which column slot the click lands in
  const clickSlot = Math.round(w.x / xStep);
  for (const col of cols) {
    if (col.slot === clickSlot) return col;
  }
  return null;
}

/**
 * Handle a click/tap on the discrete grid.
 * - Click on a data column: toggle intermediate expansion
 * - Click on an intermediate column: toggle subintermediate expansion
 * - Click on a subintermediate column: no action (for now)
 */
function handleDiscreteColumnClick(sx, sy) {
  if (!isDiscreteAny() || !state.fn) return false;
  const col = screenToDiscreteColumn(sx, sy);
  if (!col) return false;

  if (col.kind === 'data') {
    if (state.expandedCols.has(col.ix)) {
      // Collapse: remove expansion and all subexpansions for this ix
      state.expandedCols.delete(col.ix);
      for (const key of [...state.expandedSubCols.keys()]) {
        if (key.startsWith(col.ix + ':')) state.expandedSubCols.delete(key);
      }
    } else {
      state.expandedCols.add(col.ix);
    }
    return true;
  } else if (col.kind === 'intermediate') {
    const subKey = col.ix + ':' + col.opIdx;
    if (state.expandedSubCols.has(subKey)) {
      state.expandedSubCols.delete(subKey);
    } else {
      state.expandedSubCols.set(subKey, true);
    }
    return true;
  }
  return false;
}

/**
 * Draw the entire discrete scene: inactive tint, axes as pixels, all curves as
 * pixels, with color blending and y-curve priority.
 * Optimised: yMargin=0 so each column of inactive cells is one tall fillRect
 * instead of one rect per cell. Active pixels are drawn individually.
 */
function drawDiscreteScene() {
  if (!state.fn) return;

  const { minX, maxX, minY, maxY } = getVisibleWorldBounds();
  const { xStep, yStep } = getDiscreteStep();
  const xMargin = DISCRETE_MODE_PIXEL_X_MARGIN; // wide x-gap → skinnier pixels
  const yMargin = DISCRETE_MODE_PIXEL_Y_MARGIN;    // no y-gap → column strips for perf

  const ix0 = Math.floor(minX / xStep);
  const ix1 = Math.ceil(maxX / xStep);

  // In numeral mode, compute yRatio so pixel height matches text height.
  // yRatio scales the y-axis in screen space; world intervals stay 0.1.
  let yRatio = 1;
  if (state.numeralMode) {
    const cW = xStep * (1 - 2 * DISCRETE_MODE_PIXEL_X_MARGIN);
    const cH = yStep * (1 - 2 * DISCRETE_MODE_PIXEL_Y_MARGIN);
    const refSz = 100;
    drawingContext.font = `bold ${refSz}px 'JetBrains Mono', monospace`;
    const pm = drawingContext.measureText('8');
    const pH = pm.actualBoundingBoxAscent + pm.actualBoundingBoxDescent;
    const pW3 = drawingContext.measureText('8.8').width;
    const dW = drawingContext.measureText('.').width;
    const eW3 = pW3 - dW * 0.65;
    const isVert = Math.abs(view.rotation + Math.PI / 2) < 0.1;
    yRatio = isVert ? (eW3 * cW / (pH * cH)) : (pH * cW / (eW3 * cH));
  }

  // Adjust iy bounds for anisotropic y-scaling
  const iy0 = Math.floor(minY / (yStep * yRatio));
  const iy1 = Math.ceil(maxY / (yStep * yRatio));

  const isDelta = state.mode === "delta";
  const showYAxis = state.toggles.yaxis;
  const showIntermediates = state.toggles.intermediates;
  const eS = state.tauMode ? 2 * Math.PI : 1; // evaluation scale: tau mode scales x-values

  // --- Expansion displacement: shift columns to make room for expanded intermediates ---
  const _hasExp = state.expandedCols.size > 0 && state.steps.length > 1;
  const _sortedExp = _hasExp ? [...state.expandedCols].sort((a, b) => a - b) : [];
  const _insCountMap = new Map();
  if (_hasExp) {
    const nOps = state.steps.length - 1;
    for (const src of _sortedExp) {
      let cnt = nOps;
      for (let opIdx = 0; opIdx < state.ops.length; opIdx++) {
        if (state.expandedSubCols.has(src + ':' + opIdx)) {
          cnt += getSubintermediateFns(state.steps[opIdx].fn, state.ops[opIdx]).length;
        }
      }
      _insCountMap.set(src, cnt);
    }
  }
  /** Return world-x display position for logical column ix, accounting for inserted columns */
  function _dx(ix) {
    if (!_hasExp) return ix * xStep;
    let shift = 0;
    for (const src of _sortedExp) {
      if (src >= ix) break;
      shift += _insCountMap.get(src);
    }
    return ix * xStep + shift * xStep;
  }

  // --- Build pixel map: key → { r, g, b, count, hasY } ---
  const pixels = new Map();

  function addColor(ix, iy, r, g, b, isY) {
    if (ix < ix0 - 1 || ix > ix1 + 1 || iy < iy0 - 1 || iy > iy1 + 1) return;
    const key = ix * 131072 + iy;
    let px = pixels.get(key);
    if (!px) {
      px = { ix, iy, r: 0, g: 0, b: 0, count: 0, hasY: false };
      pixels.set(key, px);
    }
    px.r += r; px.g += g; px.b += b; px.count++;
    if (isY) px.hasY = true;
  }

  // 1. Axes as pixels
  const xAxisCol = getStepColor("x");
  const yAxisCol = getStepColor("y");
  const xR = red(xAxisCol), xG = green(xAxisCol), xB = blue(xAxisCol);
  const yR = red(yAxisCol), yG = green(yAxisCol), yB = blue(yAxisCol);

  if (state.toggles.xaxis) {
    for (let ix = ix0; ix <= ix1; ix++) addColor(ix, 0, xR, xG, xB, false);
  }
  if (showYAxis) {
    for (let iy = iy0; iy <= iy1; iy++) addColor(0, iy, yR, yG, yB, false);
  }

  // 2. Intermediate curve pixels
  if (showIntermediates) {
    const steps = state.steps;
    for (let k = 0; k < steps.length - 1; k++) {
      if (k === 0 && !state.stepEyes.x) continue;
      if (k > 0 && state.stepEyes.ops[k - 1] === false) continue;
      const step = steps[k];
      const col = getStepColor(step);
      const cr = red(col), cg = green(col), cb = blue(col);
      for (let ix = ix0; ix <= ix1; ix++) {
        const cx = ix * xStep * eS;
        let fy;
        try { fy = step.fn(cx); } catch { continue; }
        if (!Number.isFinite(fy)) continue;
        if (isDelta) fy = fy - cx;
        if (!Number.isFinite(fy)) continue;
        addColor(ix, Math.round(fy / yStep), cr, cg, cb, false);
      }

      // Subintermediate pixels (dimmer than intermediates)
      if (state.toggles.subintermediates) {
        const nextOp = state.ops[k];
        if (nextOp && state.stepEyes.ops[k] !== false) {
          const subItems = getSubintermediateFns(step.fn, nextOp);
          for (const sub of subItems) {
            const subCol = getStepColor(sub.category);
            const sr = Math.round(red(subCol) * 0.5);
            const sg = Math.round(green(subCol) * 0.5);
            const sb = Math.round(blue(subCol) * 0.5);
            for (let ix = ix0; ix <= ix1; ix++) {
              const cx = ix * xStep * eS;
              let fy;
              try { fy = sub.fn(cx); } catch { continue; }
              if (!Number.isFinite(fy)) continue;
              if (isDelta) fy = fy - cx;
              if (!Number.isFinite(fy)) continue;
              addColor(ix, Math.round(fy / yStep), sr, sg, sb, false);
            }
          }
        }
      }
    }
  }

  // 3. Y curve pixels (highest priority)
  const plotCol = getPlotColor();
  const pR = red(plotCol), pG = green(plotCol), pB = blue(plotCol);
  if (state.stepEyes.y) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const cx = ix * xStep * eS;
      let fy;
      try { fy = state.fn(cx); } catch { continue; }
      if (!Number.isFinite(fy)) continue;
      if (isDelta) fy = fy - cx;
      if (!Number.isFinite(fy)) continue;
      addColor(ix, Math.round(fy / yStep), pR, pG, pB, true);
    }
  }

  // --- Render using raw canvas for performance ---
  const ctx = drawingContext;
  const θ = view.rotation;
  const cosθ = Math.cos(θ), sinθ = Math.sin(θ);
  const pd = window.devicePixelRatio || 1;

  ctx.save();
  // Anisotropic transform: y-axis scaled by yRatio so pixel height matches text
  ctx.setTransform(
    pd * view.scale * cosθ, -pd * view.scale * sinθ,
    -pd * view.scale * sinθ * yRatio, -pd * view.scale * cosθ * yRatio,
    pd * view.originX, pd * view.originY
  );

  const { cellW, mx } = getDiscreteCellMetrics(xStep);
  const my = yStep * yMargin;
  const cellH = yStep - 2 * my;

  // Note: the transform flips y, so fillRect draws "upward" in world space.
  // We pass negative cellH so rects extend in the +y (upward) world direction.

  // Compute discrete scene colors
  let inR, inG, inB, gutR, gutG, gutB;
  if (state.lightMode) {
    const bg = state.bgColorRGB || [245, 246, 250];
    inR = bg[0]; inG = bg[1]; inB = bg[2];
    // Gutter = slightly darker background (darken each channel by ~5%)
    gutR = Math.round(bg[0] * 0.92);
    gutG = Math.round(bg[1] * 0.92);
    gutB = Math.round(bg[2] * 0.92);
  } else {
    inR = 18; inG = 20; inB = 28;
    gutR = 0; gutG = 0; gutB = 0;
  }

  const numerals = state.numeralMode;
  // In numeral mode + dark mode, use pure black for inactive pixel fill
  if (numerals && !state.lightMode) {
    inR = 0; inG = 0; inB = 0;
  }

  // 4a. Gutter fill: cover entire visible grid area with gutter color (light mode)
  if (state.lightMode) {
    ctx.fillStyle = `rgb(${gutR},${gutG},${gutB})`;
    const gutLeft = _dx(ix0) - xStep / 2;
    const gutW = _dx(ix1) - _dx(ix0) + xStep;
    const gutBot = iy0 * yStep - yStep / 2;
    const gutH = (iy1 - iy0 + 1) * yStep;
    ctx.fillRect(gutLeft, gutBot, gutW, gutH);
  }

  // 4a. Inactive tint: one tall strip per column
  ctx.fillStyle = `rgb(${inR},${inG},${inB})`;
  const stripBot = iy0 * yStep - yStep / 2 + my;
  const stripTop = (iy1 + 1) * yStep - yStep / 2 - my;
  const stripH = stripTop - stripBot;
  for (let ix = ix0; ix <= ix1; ix++) {
    ctx.fillRect(_dx(ix) - xStep / 2 + mx, stripBot, cellW, stripH);
  }

  // 4a2. Carve horizontal gap bands between rows (O(rows)) for y-margin
  if (my > 0) {
    ctx.fillStyle = `rgb(${gutR},${gutG},${gutB})`;
    const bandLeft = _dx(ix0) - xStep / 2;
    const bandW = _dx(ix1) - _dx(ix0) + xStep;
    const bandH = 2 * my;
    for (let iy = iy0; iy <= iy1 + 1; iy++) {
      const bandY = iy * yStep - yStep / 2 - my;
      ctx.fillRect(bandLeft, bandY, bandW, bandH);
    }
  }

  // Pre-compute per-column grid boost factor (0 = no grid tick, up to 1 = major tick)
  const gridBoostMap = new Map();
  if (state.toggles.xgrid) {
    const xGL = getGridLevels();
    const cellSpan = xStep * eS; // world-space width of one discrete cell
    for (const lv of xGL) {
      if (lv.alpha < 0.01) continue;
      // Skip grid levels that match every column (not meaningful ticks)
      if (lv.step <= cellSpan * (1 + 1e-6)) continue;
      for (let ix = ix0; ix <= ix1; ix++) {
        const cx = ix * xStep * eS;
        if (Math.abs(cx / lv.step - Math.round(cx / lv.step)) > 1e-6) continue;
        const prev = gridBoostMap.get(ix) || 0;
        if (lv.alpha > prev) gridBoostMap.set(ix, lv.alpha);
      }
    }
  }

  // 4b. Transformation band fills (skip in numeral mode — replaced by colored numerals)
  if (!numerals && showIntermediates) {
    const steps = state.steps;
    if (steps.length >= 2) {
      for (let k = 1; k < steps.length; k++) {
        if (k < steps.length - 1 && state.stepEyes.ops[k - 1] === false) continue;
        if (k === steps.length - 1 && !state.stepEyes.y) continue;
        const prevStep = steps[k - 1];
        const curStep = steps[k];
        const col = getStepColor(curStep);
        const cr = red(col), cg = green(col), cb = blue(col);

        // Build ordered band boundary functions: [prev, sub1, sub2, …, target]
        const op = state.ops[k - 1];
        let bandFns = [prevStep.fn];
        if (op && state.toggles.subintermediates) {
          const subItems = getSubintermediateFns(prevStep.fn, op);
          bandFns = bandFns.concat(subItems.map(s => s.fn));
        }
        bandFns.push(curStep.fn);

        const bandAlphaA = state.lightMode ? 0.10 : 0.14;
        const bandAlphaB = state.lightMode ? 0.05 : 0.07;

        for (let ix = ix0; ix <= ix1; ix++) {
          const cx = ix * xStep * eS;
          const gBoost = gridBoostMap.get(ix) || 0;

          // Evaluate band boundaries (snap to grid), skip NaN subs
          const vals = [];
          // Prev (required)
          let v0;
          try { v0 = prevStep.fn(cx); } catch { continue; }
          if (!Number.isFinite(v0)) continue;
          if (isDelta) v0 = v0 - cx;
          if (!Number.isFinite(v0)) continue;
          vals.push(Math.round(v0 / yStep) * yStep);

          // Subs (optional, skip NaN)
          for (let fi = 1; fi < bandFns.length - 1; fi++) {
            let v;
            try { v = bandFns[fi](cx); } catch { continue; }
            if (!Number.isFinite(v)) continue;
            if (isDelta) v = v - cx;
            if (!Number.isFinite(v)) continue;
            vals.push(Math.round(v / yStep) * yStep);
          }

          // Target (required)
          let v1;
          try { v1 = curStep.fn(cx); } catch { continue; }
          if (!Number.isFinite(v1)) continue;
          if (isDelta) v1 = v1 - cx;
          if (!Number.isFinite(v1)) continue;
          vals.push(Math.round(v1 / yStep) * yStep);

          if (vals.length < 2) continue;

          // Draw alternating sub-bands — brighter at grid ticks
          for (let b = 0; b < vals.length - 1; b++) {
            const bv0 = vals[b], bv1 = vals[b + 1];
            const lo = Math.min(bv0, bv1);
            const hi = Math.max(bv0, bv1);
            if (hi - lo < 1e-9) continue;
            const baBase = (b % 2 === 0) ? bandAlphaA : bandAlphaB;
            const ba = Math.min(1, baBase * (1 + gBoost * 0.75));
            ctx.fillStyle = `rgba(${cr},${cg},${cb},${ba.toFixed(4)})`;
            ctx.fillRect(
              _dx(ix) - xStep / 2 + mx,
              lo, cellW, hi - lo
            );
          }
        }
      }
    }
  }

  // 4b2. Glow pass (gradient aura behind each curve pixel)
  if (state.glowCurves) {
    const glowScreenPx = 60;
    const glowWR = glowScreenPx / view.scale;
    const glowCanvasH = 128;

    const _glowCache = new Map();
    function makeGlowCol(cr, cg, cb, peak) {
      const key = `${cr | 0},${cg | 0},${cb | 0},${peak.toFixed(4)}`;
      if (_glowCache.has(key)) return _glowCache.get(key);
      const gc = document.createElement('canvas');
      gc.width = 1; gc.height = glowCanvasH;
      const gx = gc.getContext('2d');
      const gr = gx.createLinearGradient(0, 0, 0, glowCanvasH);
      gr.addColorStop(0, `rgba(${cr},${cg},${cb},0)`);
      gr.addColorStop(0.15, `rgba(${cr},${cg},${cb},${(peak * 0.02).toFixed(4)})`);
      gr.addColorStop(0.30, `rgba(${cr},${cg},${cb},${(peak * 0.08).toFixed(4)})`);
      gr.addColorStop(0.40, `rgba(${cr},${cg},${cb},${(peak * 0.25).toFixed(4)})`);
      gr.addColorStop(0.47, `rgba(${cr},${cg},${cb},${(peak * 0.70).toFixed(4)})`);
      gr.addColorStop(0.5, `rgba(${cr},${cg},${cb},${peak.toFixed(4)})`);
      gr.addColorStop(0.53, `rgba(${cr},${cg},${cb},${(peak * 0.70).toFixed(4)})`);
      gr.addColorStop(0.60, `rgba(${cr},${cg},${cb},${(peak * 0.25).toFixed(4)})`);
      gr.addColorStop(0.70, `rgba(${cr},${cg},${cb},${(peak * 0.08).toFixed(4)})`);
      gr.addColorStop(0.85, `rgba(${cr},${cg},${cb},${(peak * 0.02).toFixed(4)})`);
      gr.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      gx.fillStyle = gr;
      gx.fillRect(0, 0, 1, glowCanvasH);
      _glowCache.set(key, gc);
      return gc;
    }

    function stampDiscreteGlow(evalFn, colObj, alphaS) {
      const cr = red(colObj), cg = green(colObj), cb = blue(colObj);
      const peakAlpha = 0.50 * alphaS;
      const gc = makeGlowCol(cr, cg, cb, peakAlpha);
      // Pre-build boosted glow variant for grid ticks
      const boostedPeak = Math.min(1, peakAlpha * 2.0);
      const gcBoosted = makeGlowCol(cr, cg, cb, boostedPeak);
      const boostedGlowWR = glowWR * 1.5;
      for (let ix = ix0; ix <= ix1; ix++) {
        const cx = ix * xStep * eS;
        let fy;
        try { fy = evalFn(cx); } catch { continue; }
        if (!Number.isFinite(fy)) continue;
        if (isDelta) fy = fy - cx;
        if (!Number.isFinite(fy)) continue;
        const iy = Math.round(fy / yStep);
        const worldY = iy * yStep;
        const gBoost = gridBoostMap.get(ix) || 0;
        if (gBoost > 0.01) {
          // Extended + brighter glow at grid ticks
          const r = glowWR + (boostedGlowWR - glowWR) * gBoost;
          ctx.drawImage(gcBoosted, 0, 0, 1, glowCanvasH,
            _dx(ix) - xStep / 2 + mx,
            worldY - r,
            cellW, 2 * r
          );
        } else {
          ctx.drawImage(gc, 0, 0, 1, glowCanvasH,
            _dx(ix) - xStep / 2 + mx,
            worldY - glowWR,
            cellW, 2 * glowWR
          );
        }
      }
    }

    // x-axis glow (also boosted at grid ticks)
    if (state.toggles.xaxis) {
      const xCol = getStepColor("x");
      const peakAlpha = 0.50 * (130 / 255);
      const gc = makeGlowCol(red(xCol), green(xCol), blue(xCol), peakAlpha);
      const boostedPeakX = Math.min(1, peakAlpha * 2.0);
      const gcBoostedX = makeGlowCol(red(xCol), green(xCol), blue(xCol), boostedPeakX);
      const boostedGlowWRx = glowWR * 1.5;
      for (let ix = ix0; ix <= ix1; ix++) {
        const gBoost = gridBoostMap.get(ix) || 0;
        if (gBoost > 0.01) {
          const r = glowWR + (boostedGlowWRx - glowWR) * gBoost;
          ctx.drawImage(gcBoostedX, 0, 0, 1, glowCanvasH,
            _dx(ix) - xStep / 2 + mx,
            -r,
            cellW, 2 * r
          );
        } else {
          ctx.drawImage(gc, 0, 0, 1, glowCanvasH,
            _dx(ix) - xStep / 2 + mx,
            -glowWR,
            cellW, 2 * glowWR
          );
        }
      }
    }

    // Intermediate glow
    if (showIntermediates) {
      const steps = state.steps;
      for (let k = 0; k < steps.length - 1; k++) {
        if (k === 0 && !state.stepEyes.x) continue;
        if (k > 0 && state.stepEyes.ops[k - 1] === false) continue;
        stampDiscreteGlow(steps[k].fn, getStepColor(steps[k]), 130 / 255);

        // Subintermediate glow (dimmer)
        if (state.toggles.subintermediates) {
          const nextOp = state.ops[k];
          if (nextOp && state.stepEyes.ops[k] !== false) {
            const subItems = getSubintermediateFns(steps[k].fn, nextOp);
            for (const sub of subItems) {
              stampDiscreteGlow(sub.fn, getStepColor(sub.category), 80 / 255);
            }
          }
        }
      }
    }

    // Y-curve glow
    if (state.stepEyes.y) {
      stampDiscreteGlow(state.fn, getPlotColor(), 1);
    }
  }

  // 4c. Overdraw active pixels with resolved colors (brighter at grid ticks)
  const glowTint = state.glowCurves;
  if (!numerals) {
    for (const [, px] of pixels) {
      let fr, fg, fb;
      if (px.hasY) {
        fr = pR; fg = pG; fb = pB;
      } else {
        fr = px.r / px.count;
        fg = px.g / px.count;
        fb = px.b / px.count;
      }
      if (glowTint) {
        [fr, fg, fb] = oklabMix(fr, fg, fb, 255, 255, 255, 0.3);
      }
      // Brighten at grid ticks (perceptual lerp toward white in OKLAB)
      const gBoost = gridBoostMap.get(px.ix) || 0;
      if (gBoost > 0) {
        const t = gBoost * 0.5;
        [fr, fg, fb] = oklabBrighten(fr, fg, fb, t);
      }
      ctx.fillStyle = `rgb(${Math.round(fr)},${Math.round(fg)},${Math.round(fb)})`;
      ctx.fillRect(
        _dx(px.ix) - xStep / 2 + mx,
        px.iy * yStep - yStep / 2 + my,
        cellW, cellH
      );
    }
  }

  // 4d. Numeral mode: draw y-values as text in ALL pixels (active + inactive)
  if (numerals) {
    ctx.save();
    const pd2 = window.devicePixelRatio || 1;
    ctx.setTransform(pd2, 0, 0, pd2, 0, 0);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const isVertical = Math.abs(view.rotation + Math.PI / 2) < 0.1;
    // Cell screen dimensions (after anisotropic scaling)
    const cellScrW = isVertical ? (cellH * view.scale * yRatio) : (cellW * view.scale);
    const cellScrH = isVertical ? (cellW * view.scale) : (cellH * view.scale * yRatio);
    // Font sized so text fits both dimensions (they match by design via yRatio)
    const refSize = 100;
    ctx.font = `bold ${refSize}px 'JetBrains Mono', monospace`;
    const probe = ctx.measureText('8');
    const probeH = probe.actualBoundingBoxAscent + probe.actualBoundingBoxDescent;
    const probeW3 = ctx.measureText('8.8').width;
    const dotW = ctx.measureText('.').width;
    const effW3 = probeW3 - dotW * 0.65;
    let fontSize = refSize * Math.min(cellScrW / effW3, cellScrH / probeH);
    fontSize = Math.max(4, fontSize);
    const boldFont = `bold ${fontSize}px 'JetBrains Mono', monospace`;
    ctx.font = boldFont;

    // Horizontal squeeze factors for compressed characters
    const MINUS_SQ = 0.55;
    const DOT_SQ = 0.35;
    const DEC_SQ = 0.85;

    // Centering correction
    const finalProbe = ctx.measureText('8');
    const finalAsc = finalProbe.actualBoundingBoxAscent;
    const finalDesc = finalProbe.actualBoundingBoxDescent;
    const yShift = (finalAsc - finalDesc) / 2;

    // --- Pre-cache text and tight-kerned char data per unique iy ---
    // Pre-measure bold char widths for squeeze rendering
    const boldMinusW = ctx.measureText('\u2212').width;
    const boldDotW = ctx.measureText('.').width;
    const boldDigitW = {};
    for (let d = 0; d <= 9; d++) boldDigitW[d] = ctx.measureText(String(d)).width;

    const rowCache = new Map();
    for (let iy = iy0; iy <= iy1; iy++) {
      const val = iy * yStep;
      const absVal = Math.abs(val);
      let text;
      if (absVal >= 100) text = Math.round(absVal).toString();
      else if (absVal >= 10) text = Math.round(absVal).toString();
      else if (absVal < 0.05) text = '0';
      else text = absVal.toFixed(1);
      const isNeg = val < 0;
      const dotIdx = text.indexOf('.');
      const hasDot = dotIdx !== -1;
      // Build per-char layout: { ch, w (allocated), sq (squeeze) }
      // Integer part: bold, full width. Dot + decimal: bold, squeezed.
      let chars = [];
      let totalW = 0;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (hasDot && i >= dotIdx) {
          if (ch === '.') {
            const w = boldDotW * DOT_SQ;
            chars.push({ ch, w, sq: DOT_SQ });
            totalW += w;
          } else {
            const bw = boldDigitW[parseInt(ch)] || boldDotW;
            const w = bw * DEC_SQ;
            chars.push({ ch, w, sq: DEC_SQ });
            totalW += w;
          }
        } else {
          const w = boldDigitW[parseInt(ch)] || ctx.measureText(ch).width;
          chars.push({ ch, w, sq: 1 });
          totalW += w;
        }
      }
      // Minus sign: bold, squeezed
      let minusW = 0;
      if (isNeg) {
        minusW = boldMinusW * MINUS_SQ;
        totalW += minusW;
      }
      rowCache.set(iy, { text, isNeg, hasDot, chars, totalW, minusW });
    }

    // --- Row atlas: pre-render each iy text as white on shared offscreen canvas ---
    // --- Row atlas: pre-render each iy text as white on shared offscreen canvas ---
    const _PAD = 2;
    const _atlasRowDH = Math.ceil(fontSize * 1.8 * pd2);
    const _atlasRowLH = _atlasRowDH / pd2;
    let _maxDW = 0;
    for (const rc of rowCache.values()) {
      const dw = Math.ceil((rc.totalW + _PAD * 2) * pd2);
      if (dw > _maxDW) _maxDW = dw;
    }
    if (!state._numAtlas) {
      state._numAtlas = document.createElement('canvas');
      state._numAtlasCtx = state._numAtlas.getContext('2d');
      state._numTint = document.createElement('canvas');
      state._numTintCtx = state._numTint.getContext('2d');
    }
    const aCvs = state._numAtlas, aCtx = state._numAtlasCtx;
    const tCvs = state._numTint, tCtx = state._numTintCtx;
    const _nRows = rowCache.size;
    const _needH = _atlasRowDH * _nRows;
    if (aCvs.width < _maxDW || aCvs.height < _needH) {
      aCvs.width = Math.max(aCvs.width, _maxDW);
      aCvs.height = Math.max(aCvs.height, _needH);
    }
    aCtx.clearRect(0, 0, _maxDW, _needH);
    aCtx.font = boldFont;
    aCtx.textAlign = 'center';
    aCtx.textBaseline = 'middle';
    aCtx.fillStyle = '#fff';
    // Tint canvas must cover full atlas for batch tinting
    if (tCvs.width < _maxDW || tCvs.height < _needH) {
      tCvs.width = Math.max(tCvs.width, _maxDW);
      tCvs.height = Math.max(tCvs.height, _needH);
    }
    const rowMeta = new Map();
    let _ri = 0;
    for (const [iy, rc] of rowCache) {
      const midYD = _ri * _atlasRowDH + _atlasRowDH / 2;
      let x = _PAD;
      if (rc.isNeg) {
        aCtx.setTransform(pd2 * MINUS_SQ, 0, 0, pd2, pd2 * (x + rc.minusW / 2), midYD);
        aCtx.fillText('\u2212', 0, 0);
        x += rc.minusW;
      }
      for (const ch of rc.chars) {
        if (ch.sq < 1) {
          aCtx.setTransform(pd2 * ch.sq, 0, 0, pd2, pd2 * (x + ch.w / 2), midYD);
          aCtx.fillText(ch.ch, 0, 0);
        } else {
          aCtx.setTransform(pd2, 0, 0, pd2, 0, 0);
          aCtx.fillText(ch.ch, x + ch.w / 2, midYD / pd2);
        }
        x += ch.w;
      }
      const dw = Math.ceil((rc.totalW + _PAD * 2) * pd2);
      rowMeta.set(iy, { ri: _ri, dw, lw: dw / pd2, tw: rc.totalW });
      _ri++;
    }
    aCtx.setTransform(1, 0, 0, 1, 0, 0);

    // Helper: tint full atlas to a single color (2 ops, called once per unique color)
    function tintAtlas(r, g, b) {
      tCtx.globalCompositeOperation = 'copy';
      tCtx.drawImage(aCvs, 0, 0, _maxDW, _needH, 0, 0, _maxDW, _needH);
      tCtx.globalCompositeOperation = 'source-in';
      tCtx.fillStyle = `rgb(${r},${g},${b})`;
      tCtx.fillRect(0, 0, _maxDW, _needH);
    }

    // Helper: stamp a single row from tinted atlas (1 drawImage, no composite switch)
    function stampTinted(iy, cx, cy) {
      const m = rowMeta.get(iy);
      if (!m) return;
      const srcY = m.ri * _atlasRowDH;
      ctx.drawImage(tCvs, 0, srcY, m.dw, _atlasRowDH,
        cx - m.tw / 2 - _PAD, cy + yShift - _atlasRowLH / 2,
        m.lw, _atlasRowLH);
    }

    // Build transform color map for inactive numerals
    const transformColors = new Map();
    if (showIntermediates) {
      const steps = state.steps;
      if (steps.length >= 2) {
        for (let k = 1; k < steps.length; k++) {
          if (k < steps.length - 1 && state.stepEyes.ops[k - 1] === false) continue;
          if (k === steps.length - 1 && !state.stepEyes.y) continue;
          const prevStep = steps[k - 1];
          const curStep = steps[k];
          const col = getStepColor(curStep);
          const cr = red(col), cg = green(col), cb = blue(col);
          for (let ix = ix0; ix <= ix1; ix++) {
            const cx = ix * xStep * eS;
            let v0t, v1t;
            try { v0t = prevStep.fn(cx); } catch { continue; }
            if (!Number.isFinite(v0t)) continue;
            if (isDelta) v0t = v0t - cx;
            if (!Number.isFinite(v0t)) continue;
            try { v1t = curStep.fn(cx); } catch { continue; }
            if (!Number.isFinite(v1t)) continue;
            if (isDelta) v1t = v1t - cx;
            if (!Number.isFinite(v1t)) continue;
            const iyLo = Math.round(Math.min(v0t, v1t) / yStep);
            const iyHi = Math.round(Math.max(v0t, v1t) / yStep);
            for (let iy = iyLo; iy <= iyHi; iy++) {
              const key = ix * 131072 + iy;
              if (!pixels.has(key)) {
                transformColors.set(key, { r: cr, g: cg, b: cb });
              }
            }
          }
        }
      }
    }

    // Pre-compute active pixel colors
    const activeColors = new Map();
    const glowTintN = state.glowCurves;
    for (const [key, px] of pixels) {
      let fr, fg, fb;
      if (px.hasY) { fr = pR; fg = pG; fb = pB; }
      else { fr = px.r / px.count; fg = px.g / px.count; fb = px.b / px.count; }
      if (glowTintN) { [fr, fg, fb] = oklabMix(fr, fg, fb, 255, 255, 255, 0.3); }
      const gBoost = gridBoostMap.get(px.ix) || 0;
      if (gBoost > 0) {
        const t = gBoost * 0.5;
        [fr, fg, fb] = oklabBrighten(fr, fg, fb, t);
      }
      activeColors.set(key, { r: Math.round(fr), g: Math.round(fg), b: Math.round(fb) });
    }

    // --- Rendering: batch by color, tint atlas once per unique color ---

    // Collect all cells grouped by color (inactive first, active second for z-order)
    const inactiveBatches = new Map(); // colorKey → { r,g,b, cells:[] }
    const activeBatches = new Map();

    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        const key = ix * 131072 + iy;
        if (activeColors.has(key)) continue;
        const tc = transformColors.get(key);
        let cr, cg, cb;
        if (tc) {
          const blend = state.lightMode ? 0.65 : 0.55;
          [cr, cg, cb] = oklabMix(gutR, gutG, gutB, tc.r, tc.g, tc.b, blend);
          // Brighten transform-colored numerals at grid ticks (matches active pixel behavior)
          const gBoost = gridBoostMap.get(ix) || 0;
          if (gBoost > 0) {
            const t = gBoost * 0.35;
            [cr, cg, cb] = oklabBrighten(cr, cg, cb, t);
          }
        } else {
          cr = gutR; cg = gutG; cb = gutB;
        }
        const ck = (cr << 16) | (cg << 8) | cb;
        if (!inactiveBatches.has(ck)) inactiveBatches.set(ck, { r: cr, g: cg, b: cb, cells: [] });
        const scr = worldToScreen(_dx(ix), iy * yStep * yRatio);
        inactiveBatches.get(ck).cells.push({ ix, iy, x: scr.x, y: scr.y });
      }
    }

    if (activeColors.size > 0) {
      for (let ix = ix0; ix <= ix1; ix++) {
        for (let iy = iy0; iy <= iy1; iy++) {
          const key = ix * 131072 + iy;
          const ac = activeColors.get(key);
          if (!ac) continue;
          const ck = (ac.r << 16) | (ac.g << 8) | ac.b;
          if (!activeBatches.has(ck)) activeBatches.set(ck, { r: ac.r, g: ac.g, b: ac.b, cells: [] });
          const scr = worldToScreen(_dx(ix), iy * yStep * yRatio);
          activeBatches.get(ck).cells.push({ ix, iy, x: scr.x, y: scr.y });
        }
      }
    }

    // Helper: format a value for delta-mode Cartesian numeral display
    function _fmtCartVal(ix, iy) {
      const val = iy * yStep + ix * xStep * eS;
      const av = Math.abs(val);
      let t = av >= 100 ? Math.round(av).toString() : av >= 10 ? Math.round(av).toString() : av < 0.05 ? '0' : av.toFixed(1);
      return val < -0.005 ? '\u2212' + t : t;
    }

    // Draw inactive batches (tint atlas once per color, stamp all cells)
    for (const batch of inactiveBatches.values()) {
      if (isDelta) {
        ctx.fillStyle = `rgb(${batch.r},${batch.g},${batch.b})`;
        for (const c of batch.cells) ctx.fillText(_fmtCartVal(c.ix, c.iy), c.x, c.y + yShift);
      } else {
        tintAtlas(batch.r, batch.g, batch.b);
        for (const c of batch.cells) stampTinted(c.iy, c.x, c.y);
      }
    }
    // Draw active batches on top
    for (const batch of activeBatches.values()) {
      if (isDelta) {
        ctx.fillStyle = `rgb(${batch.r},${batch.g},${batch.b})`;
        for (const c of batch.cells) ctx.fillText(_fmtCartVal(c.ix, c.iy), c.x, c.y + yShift);
      } else {
        tintAtlas(batch.r, batch.g, batch.b);
        for (const c of batch.cells) stampTinted(c.iy, c.x, c.y);
      }
    }

    ctx.restore();
  }

  // --- 5. Expanded intermediate + subintermediate columns ---
  if (_hasExp) {
    const steps = state.steps;
    const ops = state.ops;
    const nOps = steps.length - 1;

    for (const srcIx of _sortedExp) {
      if (srcIx < ix0 - 1 || srcIx > ix1 + 1) continue;
      const baseX = _dx(srcIx); // display X of the source data column
      const evalX = srcIx * xStep * eS; // mathematical x at this column
      let relSlot = 1;

      for (let opIdx = 0; opIdx < nOps; opIdx++) {
        const step = steps[opIdx + 1];
        const col = getStepColor(step);
        const cr = red(col), cg = green(col), cb = blue(col);
        const intX = baseX + relSlot * xStep; // display world X
        // Evaluate start (previous step) and end (this step)
        let startFy, fy;
        try { startFy = steps[opIdx].fn(evalX); } catch { startFy = NaN; }
        try { fy = step.fn(evalX); } catch { fy = NaN; }
        if (isDelta) {
          if (Number.isFinite(startFy)) startFy = startFy - evalX;
          if (Number.isFinite(fy)) fy = fy - evalX;
        }

        // Tinted band between start and end y-values
        if (Number.isFinite(startFy) && Number.isFinite(fy)) {
          const sIy = Math.round(startFy / yStep);
          const eIy = Math.round(fy / yStep);
          const loIy = Math.min(sIy, eIy);
          const hiIy = Math.max(sIy, eIy);
          const bandTop = loIy * yStep - yStep / 2 + my;
          const bandBot = hiIy * yStep + yStep / 2 + my;
          const stripAlpha = state.lightMode ? 0.12 : 0.18;
          ctx.fillStyle = `rgba(${cr},${cg},${cb},${stripAlpha})`;
          ctx.fillRect(intX - xStep / 2 + mx, bandTop, cellW, bandBot - bandTop);
        }

        // Solid pixels at start and end positions
        if (!numerals) {
          if (Number.isFinite(startFy)) {
            const sIy = Math.round(startFy / yStep);
            ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
            ctx.fillRect(intX - xStep / 2 + mx, sIy * yStep - yStep / 2 + my, cellW, cellH);
          }
          if (Number.isFinite(fy)) {
            const eIy = Math.round(fy / yStep);
            ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
            ctx.fillRect(intX - xStep / 2 + mx, eIy * yStep - yStep / 2 + my, cellW, cellH);
          }
        } else {
          // Numeral mode: text at both start and end positions
          ctx.save();
          const pd2 = window.devicePixelRatio || 1;
          ctx.setTransform(pd2, 0, 0, pd2, 0, 0);
          ctx.font = `bold ${Math.max(4, cellW * view.scale * 0.9)}px 'JetBrains Mono', monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
          if (Number.isFinite(startFy)) {
            const sIy = Math.round(startFy / yStep);
            const scr = worldToScreen(intX, sIy * yStep * yRatio);
            const sv = sIy * yStep;
            const sav = Math.abs(sv);
            let stxt = sav >= 100 ? Math.round(sav).toString() : sav >= 10 ? Math.round(sav).toString() : sav < 0.05 ? '0' : sav.toFixed(1);
            if (sv < -0.005) stxt = '\u2212' + stxt;
            ctx.fillText(stxt, scr.x, scr.y);
          }
          if (Number.isFinite(fy)) {
            const eIy = Math.round(fy / yStep);
            const scr = worldToScreen(intX, eIy * yStep * yRatio);
            const ev = eIy * yStep;
            const eav = Math.abs(ev);
            let etxt = eav >= 100 ? Math.round(eav).toString() : eav >= 10 ? Math.round(eav).toString() : eav < 0.05 ? '0' : eav.toFixed(1);
            if (ev < -0.005) etxt = '\u2212' + etxt;
            ctx.fillText(etxt, scr.x, scr.y);
          }
          ctx.restore();
        }
        relSlot++;

        // Subintermediate columns for this operation
        const subKey = srcIx + ':' + opIdx;
        if (state.expandedSubCols.has(subKey) && opIdx < ops.length) {
          const prevFn = steps[opIdx].fn;
          const subItems = getSubintermediateFns(prevFn, ops[opIdx]);
          for (let si = 0; si < subItems.length; si++) {
            const subX = baseX + relSlot * xStep;
            const subCol = getStepColor(subItems[si].category);
            const sr = red(subCol), sg = green(subCol), sb = blue(subCol);

            // Evaluate sub start (prev sub or prevStep) and end (this sub)
            let subStartFy, sfy;
            const subStartFn = si === 0 ? prevFn : subItems[si - 1].fn;
            try { subStartFy = subStartFn(evalX); } catch { subStartFy = NaN; }
            try { sfy = subItems[si].fn(evalX); } catch { sfy = NaN; }
            if (isDelta) {
              if (Number.isFinite(subStartFy)) subStartFy = subStartFy - evalX;
              if (Number.isFinite(sfy)) sfy = sfy - evalX;
            }

            // Tinted band between sub start and end
            if (Number.isFinite(subStartFy) && Number.isFinite(sfy)) {
              const ssIy = Math.round(subStartFy / yStep);
              const seIy = Math.round(sfy / yStep);
              const loIy = Math.min(ssIy, seIy);
              const hiIy = Math.max(ssIy, seIy);
              const bandTop = loIy * yStep - yStep / 2 + my;
              const bandBot = hiIy * yStep + yStep / 2 + my;
              const subAlpha = state.lightMode ? 0.08 : 0.12;
              ctx.fillStyle = `rgba(${sr},${sg},${sb},${subAlpha})`;
              ctx.fillRect(subX - xStep / 2 + mx, bandTop, cellW, bandBot - bandTop);
            }

            // Solid pixels at sub start and end
            if (!numerals) {
              if (Number.isFinite(subStartFy)) {
                const ssIy = Math.round(subStartFy / yStep);
                ctx.fillStyle = `rgb(${sr},${sg},${sb})`;
                ctx.fillRect(subX - xStep / 2 + mx, ssIy * yStep - yStep / 2 + my, cellW, cellH);
              }
              if (Number.isFinite(sfy)) {
                const seIy = Math.round(sfy / yStep);
                ctx.fillStyle = `rgb(${sr},${sg},${sb})`;
                ctx.fillRect(subX - xStep / 2 + mx, seIy * yStep - yStep / 2 + my, cellW, cellH);
              }
            } else {
              ctx.save();
              const pd2 = window.devicePixelRatio || 1;
              ctx.setTransform(pd2, 0, 0, pd2, 0, 0);
              ctx.font = `bold ${Math.max(4, cellW * view.scale * 0.9)}px 'JetBrains Mono', monospace`;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillStyle = `rgb(${sr},${sg},${sb})`;
              if (Number.isFinite(subStartFy)) {
                const ssIy = Math.round(subStartFy / yStep);
                const scr = worldToScreen(subX, ssIy * yStep * yRatio);
                const sv = ssIy * yStep;
                const sav = Math.abs(sv);
                let stxt = sav >= 100 ? Math.round(sav).toString() : sav >= 10 ? Math.round(sav).toString() : sav < 0.05 ? '0' : sav.toFixed(1);
                if (sv < -0.005) stxt = '\u2212' + stxt;
                ctx.fillText(stxt, scr.x, scr.y);
              }
              if (Number.isFinite(sfy)) {
                const seIy = Math.round(sfy / yStep);
                const scr = worldToScreen(subX, seIy * yStep * yRatio);
                const sv = seIy * yStep;
                const sav = Math.abs(sv);
                let stxt = sav >= 100 ? Math.round(sav).toString() : sav >= 10 ? Math.round(sav).toString() : sav < 0.05 ? '0' : sav.toFixed(1);
                if (sv < -0.005) stxt = '\u2212' + stxt;
                ctx.fillText(stxt, scr.x, scr.y);
              }
              ctx.restore();
            }
            relSlot++;
          }
        }
      }
    }
  }

  ctx.restore();
}

/**
 * Draw Discrete-X scene: x is discretized into cells, but y is continuous.
 * For each x-cell center, evaluate f(x) and draw a horizontal bar spanning
 * the cell's x-width (minus margins) at the exact continuous y screen position.
 * No vertical connections between successive bars.
 */
function drawDiscreteXScene() {
  if (!state.fn) return;

  const { minX, maxX, minY, maxY } = getVisibleWorldBounds();
  const { xStep } = getDiscreteStep();
  const xMargin = DISCRETE_MODE_PIXEL_X_MARGIN;

  const ix0 = Math.floor(minX / xStep);
  const ix1 = Math.ceil(maxX / xStep);

  const isDelta = state.mode === "delta";
  const showYAxis = state.toggles.yaxis;
  const showIntermediates = state.toggles.intermediates;
  const eS = state.tauMode ? 2 * Math.PI : 1; // evaluation scale

  // --- Expansion displacement (same logic as drawDiscreteScene) ---
  const _hasExpX = state.expandedCols.size > 0 && state.steps.length > 1;
  const _sortedExpX = _hasExpX ? [...state.expandedCols].sort((a, b) => a - b) : [];
  const _insCountMapX = new Map();
  if (_hasExpX) {
    const nOps = state.steps.length - 1;
    for (const src of _sortedExpX) {
      let cnt = nOps;
      for (let opIdx = 0; opIdx < state.ops.length; opIdx++) {
        if (state.expandedSubCols.has(src + ':' + opIdx)) {
          cnt += getSubintermediateFns(state.steps[opIdx].fn, state.ops[opIdx]).length;
        }
      }
      _insCountMapX.set(src, cnt);
    }
  }
  function _dxX(ix) {
    if (!_hasExpX) return ix * xStep;
    let shift = 0;
    for (const src of _sortedExpX) {
      if (src >= ix) break;
      shift += _insCountMapX.get(src);
    }
    return ix * xStep + shift * xStep;
  }

  // --- Render using raw canvas for performance ---
  const ctx = drawingContext;
  const θ = view.rotation;
  const cosθ = Math.cos(θ), sinθ = Math.sin(θ);
  const pd = window.devicePixelRatio || 1;

  ctx.save();
  ctx.setTransform(
    pd * view.scale * cosθ, -pd * view.scale * sinθ,
    -pd * view.scale * sinθ, -pd * view.scale * cosθ,
    pd * view.originX, pd * view.originY
  );

  const { cellW, mx } = getDiscreteCellMetrics(xStep);
  const barThickness = 0.025; // world units — thin horizontal bar
  const numerals = state.numeralMode;

  // Compute discrete scene colors
  let inR, inG, inB;
  if (state.lightMode) {
    const bg = state.bgColorRGB || [245, 246, 250];
    inR = bg[0]; inG = bg[1]; inB = bg[2];
    // Fill gutter background (slightly darker version of background color)
    const gutR = Math.round(inR * 0.92);
    const gutG = Math.round(inG * 0.92);
    const gutB = Math.round(inB * 0.92);
    ctx.fillStyle = `rgb(${gutR},${gutG},${gutB})`;
    const gutLeft = _dxX(ix0) - xStep / 2;
    const gutW = _dxX(ix1) - _dxX(ix0) + xStep;
    ctx.fillRect(gutLeft, minY, gutW, maxY - minY);
  } else {
    inR = 18; inG = 20; inB = 28;
  }

  // Draw column strips (inactive tint)
  ctx.fillStyle = `rgb(${inR},${inG},${inB})`;
  for (let ix = ix0; ix <= ix1; ix++) {
    ctx.fillRect(_dxX(ix) - xStep / 2 + mx, minY, cellW, maxY - minY);
  }

  // Draw y-axis as a thin vertical line through x=0 cell if visible
  if (showYAxis) {
    const yAxisCol = getStepColor("y");
    ctx.strokeStyle = `rgb(${red(yAxisCol)},${green(yAxisCol)},${blue(yAxisCol)})`;
    ctx.lineWidth = 2 / view.scale;
    ctx.beginPath();
    ctx.moveTo(0, minY);
    ctx.lineTo(0, maxY);
    ctx.stroke();
  }

  // Y-step horizontal grid lines — use same multi-level fading as regular grid
  if (state.toggles.ygrid) {
    const yGridLevels = getYGridLevels();
    const gridLineW = 1 / view.scale; // ~1 screen pixel
    for (const lv of yGridLevels) {
      const a = state.lightMode ? lv.alpha * 0.12 : lv.alpha * 0.6;
      ctx.fillStyle = `rgba(0,0,0,${a.toFixed(4)})`;
      const iy0g = Math.floor(minY / lv.step);
      const iy1g = Math.ceil(maxY / lv.step);
      for (let iy = iy0g; iy <= iy1g; iy++) {
        const wy = iy * lv.step;
        for (let ix = ix0; ix <= ix1; ix++) {
          const left = _dxX(ix) - xStep / 2 + mx;
          ctx.fillRect(left, wy - gridLineW / 2, cellW, gridLineW);
        }
      }
    }
  }

  // Draw x-axis as a continuous line within x-cells (drawn AFTER grid so it sits on top)
  if (state.toggles.xaxis) {
    const xAxisCol = getStepColor("x");
    ctx.strokeStyle = `rgb(${red(xAxisCol)},${green(xAxisCol)},${blue(xAxisCol)})`;
    ctx.lineWidth = 2 / view.scale;
    ctx.beginPath();
    for (let ix = ix0; ix <= ix1; ix++) {
      const left = _dxX(ix) - xStep / 2 + mx;
      const right = left + cellW;
      ctx.moveTo(left, 0);
      ctx.lineTo(right, 0);
    }
    ctx.stroke();
  }

  // Pre-compute per-column grid boost factor (0 = no grid tick, up to 1 = major tick)
  const gridBoostMap = new Map();
  if (state.toggles.xgrid) {
    const xGL = getGridLevels();
    const cellSpan = xStep * eS; // world-space width of one discrete cell
    for (const lv of xGL) {
      if (lv.alpha < 0.01) continue;
      // Skip grid levels that match every column (not meaningful ticks)
      if (lv.step <= cellSpan * (1 + 1e-6)) continue;
      for (let ix = ix0; ix <= ix1; ix++) {
        const cx = ix * xStep * eS;
        if (Math.abs(cx / lv.step - Math.round(cx / lv.step)) > 1e-6) continue;
        const prev = gridBoostMap.get(ix) || 0;
        if (lv.alpha > prev) gridBoostMap.set(ix, lv.alpha);
      }
    }
  }

  // Helper: draw horizontal bars for a function (brighter at grid ticks)
  function drawBars(evalFn, colR, colG, colB, thickness) {
    const baseStyle = `rgb(${colR},${colG},${colB})`;
    for (let ix = ix0; ix <= ix1; ix++) {
      const cx = ix * xStep * eS;
      let fy;
      try { fy = evalFn(cx); } catch { continue; }
      if (!Number.isFinite(fy)) continue;
      if (isDelta) fy = fy - cx;
      if (!Number.isFinite(fy)) continue;
      const left = _dxX(ix) - xStep / 2 + mx;
      const gBoost = gridBoostMap.get(ix) || 0;
      if (gBoost > 0) {
        const t = gBoost * 0.5;
        const [br, bg, bb] = oklabBrighten(colR, colG, colB, t);
        ctx.fillStyle = `rgb(${br},${bg},${bb})`;
      } else {
        ctx.fillStyle = baseStyle;
      }
      ctx.fillRect(left, fy - thickness / 2, cellW, thickness);
    }
  }

  // Intermediate curves — bands always shown, bars only when not in numeral mode
  if (showIntermediates) {
    const steps = state.steps;

    // Transformation band fills: split into alternating sub-bands via subintermediates
    if (steps.length >= 2) {
      for (let k = 1; k < steps.length; k++) {
        // Respect eye visibility of the operator producing this band
        if (k < steps.length - 1 && state.stepEyes.ops[k - 1] === false) continue;
        if (k === steps.length - 1 && !state.stepEyes.y) continue;
        const prevStep = steps[k - 1];
        const curStep = steps[k];
        const col = getStepColor(curStep);
        const cr = red(col), cg = green(col), cb = blue(col);

        // Build ordered band boundary functions: [prev, sub1, sub2, …, target]
        const op = state.ops[k - 1];
        let bandFns = [prevStep.fn];
        if (op && state.toggles.subintermediates) {
          const subItems = getSubintermediateFns(prevStep.fn, op);
          bandFns = bandFns.concat(subItems.map(s => s.fn));
        }
        bandFns.push(curStep.fn);

        const bandAlphaA = state.lightMode ? 0.10 : 0.14;
        const bandAlphaB = state.lightMode ? 0.05 : 0.07;

        for (let ix = ix0; ix <= ix1; ix++) {
          const cx = ix * xStep * eS;
          const left = _dxX(ix) - xStep / 2 + mx;

          // Evaluate band boundary values (skip NaN subs, but prev & target are required)
          const gBoost = gridBoostMap.get(ix) || 0;
          const vals = [];
          let prevBad = false;
          // First: evaluate prev (required)
          let v0;
          try { v0 = bandFns[0](cx); } catch { prevBad = true; }
          if (!prevBad && !Number.isFinite(v0)) prevBad = true;
          if (!prevBad && isDelta) { v0 = v0 - cx; if (!Number.isFinite(v0)) prevBad = true; }
          if (prevBad) continue;
          vals.push(v0);
          // Middle: subs (NaN-returning ones are simply skipped)
          for (let fi = 1; fi < bandFns.length - 1; fi++) {
            let v;
            try { v = bandFns[fi](cx); } catch { continue; }
            if (!Number.isFinite(v)) continue;
            if (isDelta) v = v - cx;
            if (!Number.isFinite(v)) continue;
            vals.push(v);
          }
          // Last: evaluate target (required)
          let v1;
          let targetBad = false;
          try { v1 = bandFns[bandFns.length - 1](cx); } catch { targetBad = true; }
          if (!targetBad && !Number.isFinite(v1)) targetBad = true;
          if (!targetBad && isDelta) { v1 = v1 - cx; if (!Number.isFinite(v1)) targetBad = true; }
          if (targetBad) continue;
          vals.push(v1);
          if (vals.length < 2) continue;

          // Draw alternating sub-bands — brighter at grid ticks
          for (let b = 0; b < vals.length - 1; b++) {
            const v0 = vals[b], v1 = vals[b + 1];
            const lo = Math.min(v0, v1);
            const hi = Math.max(v0, v1);
            if (hi - lo < 1e-9) continue;
            const baBase = (b % 2 === 0) ? bandAlphaA : bandAlphaB;
            const ba = Math.min(1, baBase * (1 + gBoost * 0.75));
            ctx.fillStyle = `rgba(${cr},${cg},${cb},${ba.toFixed(4)})`;
            ctx.fillRect(left, lo, cellW, hi - lo);
          }
        }
      }
    }

    // Intermediate bars (skip in numeral mode)
    if (!numerals) {
      for (let k = 0; k < steps.length - 1; k++) {
        if (k === 0 && !state.stepEyes.x) continue;
        if (k > 0 && state.stepEyes.ops[k - 1] === false) continue;
        const step = steps[k];
        const col = getStepColor(step);
        drawBars(step.fn, red(col), green(col), blue(col), barThickness * 0.7);

        // Subintermediate bars
        if (state.toggles.subintermediates) {
          const nextOp = state.ops[k];
          if (nextOp && state.stepEyes.ops[k] !== false) {
            const subItems = getSubintermediateFns(step.fn, nextOp);
            for (const sub of subItems) {
              const subBarCol = getStepColor(sub.category);
              const sr = red(subBarCol), sg = green(subBarCol), sb = blue(subBarCol);
              for (let ix = ix0; ix <= ix1; ix++) {
                const cx = ix * xStep * eS;
                let fy;
                try { fy = sub.fn(cx); } catch { continue; }
                if (!Number.isFinite(fy)) continue;
                if (isDelta) fy = fy - cx;
                if (!Number.isFinite(fy)) continue;
                const left = _dxX(ix) - xStep / 2 + mx;
                const gBoost = gridBoostMap.get(ix) || 0;
                if (gBoost > 0) {
                  const t = gBoost * 0.5;
                  const [bsr, bsg, bsb] = oklabBrighten(sr, sg, sb, t);
                  ctx.fillStyle = `rgba(${bsr},${bsg},${bsb},0.55)`;
                } else {
                  ctx.fillStyle = `rgba(${sr},${sg},${sb},0.55)`;
                }
                ctx.fillRect(left, fy - barThickness * 0.35, cellW, barThickness * 0.5);
              }
            }
          }
        }
      }
    }
  }

  // Y-curve bars (skip in numeral mode)
  if (!numerals && state.stepEyes.y) {
    const plotCol = getPlotColor();
    drawBars(state.fn, red(plotCol), green(plotCol), blue(plotCol), barThickness);
  }

  // Glow pass in world space (gradient columns extending along y-axis)
  if (state.glowCurves) {
    const glowScreenPx = 60; // desired extent in screen pixels
    const glowWR = glowScreenPx / view.scale; // convert to world units
    const glowCanvasH = 128; // internal gradient resolution

    function makeGlowColumnW(cr, cg, cb, alphaS) {
      const peakAlpha = 0.50 * alphaS;
      const gc = document.createElement('canvas');
      gc.width = 1; gc.height = glowCanvasH;
      const gx = gc.getContext('2d');
      const gr = gx.createLinearGradient(0, 0, 0, glowCanvasH);
      gr.addColorStop(0, `rgba(${cr},${cg},${cb},0)`);
      gr.addColorStop(0.15, `rgba(${cr},${cg},${cb},${(peakAlpha * 0.02).toFixed(4)})`);
      gr.addColorStop(0.30, `rgba(${cr},${cg},${cb},${(peakAlpha * 0.08).toFixed(4)})`);
      gr.addColorStop(0.40, `rgba(${cr},${cg},${cb},${(peakAlpha * 0.25).toFixed(4)})`);
      gr.addColorStop(0.47, `rgba(${cr},${cg},${cb},${(peakAlpha * 0.70).toFixed(4)})`);
      gr.addColorStop(0.5, `rgba(${cr},${cg},${cb},${peakAlpha.toFixed(4)})`);
      gr.addColorStop(0.53, `rgba(${cr},${cg},${cb},${(peakAlpha * 0.70).toFixed(4)})`);
      gr.addColorStop(0.60, `rgba(${cr},${cg},${cb},${(peakAlpha * 0.25).toFixed(4)})`);
      gr.addColorStop(0.70, `rgba(${cr},${cg},${cb},${(peakAlpha * 0.08).toFixed(4)})`);
      gr.addColorStop(0.85, `rgba(${cr},${cg},${cb},${(peakAlpha * 0.02).toFixed(4)})`);
      gr.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      gx.fillStyle = gr;
      gx.fillRect(0, 0, 1, glowCanvasH);
      return gc;
    }

    function stampGlowW(evalFn, colObj, alphaS) {
      const cr = red(colObj), cg = green(colObj), cb = blue(colObj);
      const gc = makeGlowColumnW(cr, cg, cb, alphaS);
      // Pre-build boosted glow for grid ticks
      const boostedAlphaS = Math.min(1, alphaS * 2.0);
      const gcBoosted = makeGlowColumnW(cr, cg, cb, boostedAlphaS);
      const boostedGlowWR = glowWR * 1.5;
      for (let ix = ix0; ix <= ix1; ix++) {
        const cx = ix * xStep * eS;
        let fy;
        try { fy = evalFn(cx); } catch { continue; }
        if (!Number.isFinite(fy)) continue;
        if (isDelta) fy = fy - cx;
        if (!Number.isFinite(fy)) continue;
        const left = _dxX(ix) - xStep / 2 + mx;
        const gBoost = gridBoostMap.get(ix) || 0;
        if (gBoost > 0.01) {
          const r = glowWR + (boostedGlowWR - glowWR) * gBoost;
          ctx.drawImage(gcBoosted, 0, 0, 1, glowCanvasH, left, fy - r, cellW, 2 * r);
        } else {
          ctx.drawImage(gc, 0, 0, 1, glowCanvasH, left, fy - glowWR, cellW, 2 * glowWR);
        }
      }
      // Hairline (near-white with chroma hint) — skip in numeral mode
      if (!numerals) {
        const [hr, hg, hb] = oklabMix(cr, cg, cb, 255, 255, 255, 0.8);
        const hlThick = 1.5 / view.scale;
        for (let ix = ix0; ix <= ix1; ix++) {
          const cx = ix * xStep * eS;
          let fy;
          try { fy = evalFn(cx); } catch { continue; }
          if (!Number.isFinite(fy)) continue;
          if (isDelta) fy = fy - cx;
          if (!Number.isFinite(fy)) continue;
          const left = _dxX(ix) - xStep / 2 + mx;
          const gBoost = gridBoostMap.get(ix) || 0;
          const hlAlpha = Math.min(1, alphaS * (1 + gBoost * 0.5));
          ctx.fillStyle = `rgba(${hr | 0},${hg | 0},${hb | 0},${hlAlpha.toFixed(4)})`;
          ctx.fillRect(left, fy - hlThick / 2, cellW, hlThick);
        }
      }
    }

    // Intermediate glow
    if (showIntermediates) {
      const steps = state.steps;
      for (let k = 0; k < steps.length - 1; k++) {
        if (k === 0 && !state.stepEyes.x) continue;
        if (k > 0 && state.stepEyes.ops[k - 1] === false) continue;
        const step = steps[k];
        const sCol = getStepColor(step);
        stampGlowW(step.fn, sCol, 130 / 255);

        // Subintermediate glow (dimmer than intermediates)
        if (state.toggles.subintermediates) {
          const nextOp = state.ops[k];
          if (nextOp && state.stepEyes.ops[k] !== false) {
            const subItems = getSubintermediateFns(step.fn, nextOp);
            for (const sub of subItems) {
              const subGlowCol = getStepColor(sub.category);
              stampGlowW(sub.fn, subGlowCol, 80 / 255);
            }
          }
        }
      }
    }

    // Main curve glow
    if (state.stepEyes.y) {
      stampGlowW(state.fn, getPlotColor(), 1);
    }
  }

  // Numeral mode: draw y-values as text at active data points (discrete-X only)
  if (numerals) {
    ctx.save();
    const pd2 = window.devicePixelRatio || 1;
    ctx.setTransform(pd2, 0, 0, pd2, 0, 0);

    const isVertical = Math.abs(view.rotation + Math.PI / 2) < 0.1;

    // Calibrate font: in vertical mode, height must fit cellScreenW
    const cellScreenW = cellW * view.scale;
    const refSize = 100;
    ctx.font = `bold ${refSize}px 'JetBrains Mono', monospace`;
    const probe = ctx.measureText('8');
    const probeH = probe.actualBoundingBoxAscent + probe.actualBoundingBoxDescent;
    let fontSize;
    if (isVertical) {
      // Cell width on screen = vertical extent for text, so size by height
      fontSize = Math.max(4, refSize * (cellScreenW / probeH));
    } else {
      // Horizontal: size so text width fills cell
      const probeW3 = ctx.measureText('8.8').width;
      const dotW = ctx.measureText('.').width;
      const effW = probeW3 - dotW * 0.65;
      fontSize = Math.max(4, refSize * (cellScreenW / effW) * 0.92);
    }
    const boldFontDX = `bold ${fontSize}px 'JetBrains Mono', monospace`;
    ctx.font = boldFontDX;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Horizontal squeeze factors for compressed characters
    const MINUS_SQ_DX = 0.55;
    const DOT_SQ_DX = 0.35;
    const DEC_SQ_DX = 0.85;

    const plotCol = getPlotColor();
    const pcR = red(plotCol), pcG = green(plotCol), pcB = blue(plotCol);

    // Pre-measure bold char widths for squeeze rendering
    const boldMinusDX = ctx.measureText('\u2212').width;
    const boldDotDX = ctx.measureText('.').width;
    const boldDigitDX = {};
    for (let d = 0; d <= 9; d++) boldDigitDX[d] = ctx.measureText(String(d)).width;

    // Build text layout (squeeze factors) without drawing
    function buildLayout(str, isNeg) {
      const dotIdx = str.indexOf('.');
      const hasDot = dotIdx !== -1;
      let totalW = 0;
      const parts = [];
      if (isNeg) {
        const mw = boldMinusDX * MINUS_SQ_DX;
        parts.push({ ch: '\u2212', w: mw, sq: MINUS_SQ_DX });
        totalW += mw;
      }
      for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (hasDot && i >= dotIdx) {
          if (ch === '.') {
            const w = boldDotDX * DOT_SQ_DX;
            parts.push({ ch, w, sq: DOT_SQ_DX });
            totalW += w;
          } else {
            const bw = boldDigitDX[parseInt(ch)] || boldDotDX;
            const w = bw * DEC_SQ_DX;
            parts.push({ ch, w, sq: DEC_SQ_DX });
            totalW += w;
          }
        } else {
          const w = boldDigitDX[parseInt(ch)] || ctx.measureText(ch).width;
          parts.push({ ch, w, sq: 1 });
          totalW += w;
        }
      }
      return { parts, totalW };
    }

    // Collect all numeral draws (evaluate once, render in passes)
    const dxDraws = [];
    function collectNumeralBar(evalFn, colR, colG, colB) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const cx = ix * xStep * eS;
        let fy;
        try { fy = evalFn(cx); } catch { continue; }
        if (!Number.isFinite(fy)) continue;
        const displayVal = fy; // Cartesian y-value for numeral display
        if (isDelta) fy = fy - cx;
        if (!Number.isFinite(fy)) continue;

        const gBoost = gridBoostMap.get(ix) || 0;
        let fr = colR, fg = colG, fb = colB;
        if (state.glowCurves) { [fr, fg, fb] = oklabMix(fr, fg, fb, 255, 255, 255, 0.3); }
        if (gBoost > 0) {
          const t = gBoost * 0.5;
          [fr, fg, fb] = oklabBrighten(fr, fg, fb, t);
        }

        const absVal = Math.abs(displayVal);
        let text;
        if (absVal >= 100) text = Math.round(absVal).toString();
        else if (absVal >= 10) text = Math.round(absVal).toString();
        else if (absVal < 0.05) text = '0';
        else text = absVal.toFixed(1);
        const isNeg = displayVal < 0;
        const layout = buildLayout(text, isNeg);
        const scr = worldToScreen(_dxX(ix), fy);
        dxDraws.push({ layout, cx: scr.x, cy: scr.y, r: Math.round(fr), g: Math.round(fg), b: Math.round(fb) });
      }
    }

    // Collect intermediate numerals
    if (showIntermediates) {
      const steps = state.steps;
      for (let k = 0; k < steps.length - 1; k++) {
        if (k === 0 && !state.stepEyes.x) continue;
        if (k > 0 && state.stepEyes.ops[k - 1] === false) continue;
        const sCol = getStepColor(steps[k]);
        collectNumeralBar(steps[k].fn, red(sCol), green(sCol), blue(sCol));

        if (state.toggles.subintermediates) {
          const nextOp = state.ops[k];
          if (nextOp && state.stepEyes.ops[k] !== false) {
            const subItems = getSubintermediateFns(steps[k].fn, nextOp);
            for (const sub of subItems) {
              const subCol = getStepColor(sub.category);
              collectNumeralBar(sub.fn, red(subCol), green(subCol), blue(subCol));
            }
          }
        }
      }
    }

    // Collect Y-curve numerals
    if (state.stepEyes.y) {
      collectNumeralBar(state.fn, pcR, pcG, pcB);
    }

    // --- Rendering: atlas + batch-by-color (no fillText per data-point) ---

    if (dxDraws.length > 0) {
      const _PAD_DX = 2;
      const _rowDH = Math.ceil(fontSize * 1.8 * pd2);
      const _rowLH = _rowDH / pd2;
      const uniqueTexts = new Map();
      for (const d of dxDraws) {
        const key = d.layout.parts.map(p => p.ch).join('');
        d._ak = key;
        if (!uniqueTexts.has(key)) uniqueTexts.set(key, d.layout);
      }
      let _maxDW = 0;
      for (const lo of uniqueTexts.values()) {
        const dw = Math.ceil((lo.totalW + _PAD_DX * 2) * pd2);
        if (dw > _maxDW) _maxDW = dw;
      }
      if (!state._numAtlas) {
        state._numAtlas = document.createElement('canvas');
        state._numAtlasCtx = state._numAtlas.getContext('2d');
        state._numTint = document.createElement('canvas');
        state._numTintCtx = state._numTint.getContext('2d');
      }
      const aCvs = state._numAtlas, aCtx = state._numAtlasCtx;
      const tCvs = state._numTint, tCtx = state._numTintCtx;
      const _nTxt = uniqueTexts.size;
      const _needH = _rowDH * _nTxt;
      if (aCvs.width < _maxDW || aCvs.height < _needH) {
        aCvs.width = Math.max(aCvs.width, _maxDW);
        aCvs.height = Math.max(aCvs.height, _needH);
      }
      aCtx.clearRect(0, 0, _maxDW, _needH);
      aCtx.font = boldFontDX;
      aCtx.textAlign = 'center';
      aCtx.textBaseline = 'middle';
      aCtx.fillStyle = '#fff';
      // Tint canvas must cover full atlas for batch tinting
      if (tCvs.width < _maxDW || tCvs.height < _needH) {
        tCvs.width = Math.max(tCvs.width, _maxDW);
        tCvs.height = Math.max(tCvs.height, _needH);
      }
      const txtMeta = new Map();
      let _ri = 0;
      for (const [key, layout] of uniqueTexts) {
        const midYD = _ri * _rowDH + _rowDH / 2;
        let x = _PAD_DX;
        for (const p of layout.parts) {
          if (p.sq < 1) {
            aCtx.setTransform(pd2 * p.sq, 0, 0, pd2, pd2 * (x + p.w / 2), midYD);
            aCtx.fillText(p.ch, 0, 0);
          } else {
            aCtx.setTransform(pd2, 0, 0, pd2, 0, 0);
            aCtx.fillText(p.ch, x + p.w / 2, midYD / pd2);
          }
          x += p.w;
        }
        const dw = Math.ceil((layout.totalW + _PAD_DX * 2) * pd2);
        txtMeta.set(key, { ri: _ri, dw, lw: dw / pd2, tw: layout.totalW });
        _ri++;
      }
      aCtx.setTransform(1, 0, 0, 1, 0, 0);

      // Batch draws by color
      const dxBatches = new Map();
      for (const d of dxDraws) {
        const ck = (d.r << 16) | (d.g << 8) | d.b;
        if (!dxBatches.has(ck)) dxBatches.set(ck, { r: d.r, g: d.g, b: d.b, draws: [] });
        dxBatches.get(ck).draws.push(d);
      }

      for (const batch of dxBatches.values()) {
        // Tint full atlas once for this color
        tCtx.globalCompositeOperation = 'copy';
        tCtx.drawImage(aCvs, 0, 0, _maxDW, _needH, 0, 0, _maxDW, _needH);
        tCtx.globalCompositeOperation = 'source-in';
        tCtx.fillStyle = `rgb(${batch.r},${batch.g},${batch.b})`;
        tCtx.fillRect(0, 0, _maxDW, _needH);
        // Stamp all draws with this color
        for (const d of batch.draws) {
          const m = txtMeta.get(d._ak);
          if (!m) continue;
          const srcY = m.ri * _rowDH;
          ctx.drawImage(tCvs, 0, srcY, m.dw, _rowDH,
            d.cx - m.tw / 2 - _PAD_DX, d.cy - _rowLH / 2,
            m.lw, _rowLH);
        }
      }
    }

    ctx.restore();
  }

  // --- Expanded intermediate + subintermediate columns (discreteX) ---
  if (_hasExpX) {
    const steps = state.steps;
    const ops = state.ops;
    const nOps = steps.length - 1;

    for (const srcIx of _sortedExpX) {
      if (srcIx < ix0 - 1 || srcIx > ix1 + 1) continue;
      const baseX = _dxX(srcIx);
      const evalX = srcIx * xStep * eS;
      let relSlot = 1;

      for (let opIdx = 0; opIdx < nOps; opIdx++) {
        const step = steps[opIdx + 1];
        const col = getStepColor(step);
        const cr = red(col), cg = green(col), cb = blue(col);
        const intX = baseX + relSlot * xStep;
        // Evaluate start (previous step) and end (this step)
        let startFy, fy;
        try { startFy = steps[opIdx].fn(evalX); } catch { startFy = NaN; }
        try { fy = step.fn(evalX); } catch { fy = NaN; }
        if (isDelta) {
          if (Number.isFinite(startFy)) startFy = startFy - evalX;
          if (Number.isFinite(fy)) fy = fy - evalX;
        }

        // Tinted band between start and end y-values
        if (Number.isFinite(startFy) && Number.isFinite(fy)) {
          const lo = Math.min(startFy, fy);
          const hi = Math.max(startFy, fy);
          const stripAlpha = state.lightMode ? 0.12 : 0.18;
          ctx.fillStyle = `rgba(${cr},${cg},${cb},${stripAlpha})`;
          ctx.fillRect(intX - xStep / 2 + mx, lo - barThickness / 2, cellW, hi - lo + barThickness);
        }

        // Bars at start and end y
        if (Number.isFinite(startFy)) {
          ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
          ctx.fillRect(intX - xStep / 2 + mx, startFy - barThickness / 2, cellW, barThickness);
        }
        if (Number.isFinite(fy)) {
          ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
          ctx.fillRect(intX - xStep / 2 + mx, fy - barThickness / 2, cellW, barThickness);
        }
        relSlot++;

        // Subintermediate columns
        const subKey = srcIx + ':' + opIdx;
        if (state.expandedSubCols.has(subKey) && opIdx < ops.length) {
          const prevFn = steps[opIdx].fn;
          const subItems = getSubintermediateFns(prevFn, ops[opIdx]);
          for (let si = 0; si < subItems.length; si++) {
            const subX = baseX + relSlot * xStep;
            const subCol = getStepColor(subItems[si].category);
            const sr = red(subCol), sg = green(subCol), sb = blue(subCol);

            // Evaluate sub start and end
            let subStartFy, sfy;
            const subStartFn = si === 0 ? prevFn : subItems[si - 1].fn;
            try { subStartFy = subStartFn(evalX); } catch { subStartFy = NaN; }
            try { sfy = subItems[si].fn(evalX); } catch { sfy = NaN; }
            if (isDelta) {
              if (Number.isFinite(subStartFy)) subStartFy = subStartFy - evalX;
              if (Number.isFinite(sfy)) sfy = sfy - evalX;
            }

            // Tinted band between sub start and end
            if (Number.isFinite(subStartFy) && Number.isFinite(sfy)) {
              const lo = Math.min(subStartFy, sfy);
              const hi = Math.max(subStartFy, sfy);
              const subAlpha = state.lightMode ? 0.08 : 0.12;
              ctx.fillStyle = `rgba(${sr},${sg},${sb},${subAlpha})`;
              ctx.fillRect(subX - xStep / 2 + mx, lo - barThickness / 2, cellW, hi - lo + barThickness);
            }

            // Bars at sub start and end
            if (Number.isFinite(subStartFy)) {
              ctx.fillStyle = `rgb(${sr},${sg},${sb})`;
              ctx.fillRect(subX - xStep / 2 + mx, subStartFy - barThickness * 0.5, cellW, barThickness * 0.7);
            }
            if (Number.isFinite(sfy)) {
              ctx.fillStyle = `rgb(${sr},${sg},${sb})`;
              ctx.fillRect(subX - xStep / 2 + mx, sfy - barThickness * 0.5, cellW, barThickness * 0.7);
            }
            relSlot++;
          }
        }
      }
    }
  }

  ctx.restore();
}

/**
 * Draw cursor as a highlighted pixel cell in discrete mode.
 * Uses raw canvas setTransform so the pixel rotates with the coordinate system.
 */
function drawDiscreteCursor(cx, cy, world, xCol, yCol) {
  const { xStep, yStep } = getDiscreteStep();
  const xMargin = DISCRETE_MODE_PIXEL_X_MARGIN;
  const yMargin = DISCRETE_MODE_PIXEL_Y_MARGIN;

  const cellX = Math.round(world.x / xStep) * xStep;

  // In discreteX mode, y is continuous (exact); in full discrete, y is snapped
  const isDiscreteX = state.discreteMode === "discreteX";
  const cellY = isDiscreteX ? world.y : Math.round(world.y / yStep) * yStep;

  // Draw the highlighted pixel using raw canvas (rotates correctly)
  const ctx = drawingContext;
  const θ = view.rotation;
  const cosθ = Math.cos(θ), sinθ = Math.sin(θ);
  const pd = window.devicePixelRatio || 1;

  ctx.save();
  ctx.setTransform(
    pd * view.scale * cosθ, -pd * view.scale * sinθ,
    -pd * view.scale * sinθ, -pd * view.scale * cosθ,
    pd * view.originX, pd * view.originY
  );

  const { cellW, mx } = getDiscreteCellMetrics(xStep);
  const my = yStep * yMargin;
  const cellH = isDiscreteX ? 0.025 : yStep - 2 * my; // thin bar in discreteX

  ctx.fillStyle = 'rgba(255,255,255,0.7)';

  // Glow effect for cursor pixel when glow mode is on
  if (state.glowCurves) {
    ctx.shadowColor = 'rgba(255,255,255,0.6)';
    ctx.shadowBlur = 15;
  }

  ctx.fillRect(
    cellX - xStep / 2 + mx,
    isDiscreteX ? cellY - cellH / 2 : cellY - yStep / 2 + my,
    cellW, cellH
  );

  ctx.shadowBlur = 0;
  ctx.restore();

  // Labels in screen space with glass backgrounds
  const screenCenter = worldToScreen(cellX, cellY);
  const pixelScreenSize = cellW * view.scale;
  const labelOff = pixelScreenSize / 2 + 10;

  // In tau mode, show the tau-scaled eval x, not the visual position
  const evalCellX = state.tauMode ? cellX * (2 * Math.PI) : cellX;
  const xLabel = formatLiveX(evalCellX);
  const yLabel = isDiscreteX ? formatLiveNumber(cellY) : formatLiveNumber(Math.round(world.y / yStep) * yStep);

  // x-coordinate label: above in x-color
  drawGlassLabel(xLabel, screenCenter.x, screenCenter.y - labelOff,
    { col: xCol, alpha: 220, align: "center", baseline: "bottom", size: 12 });

  // y-coordinate label: to the right in y-color
  drawGlassLabel(yLabel, screenCenter.x + labelOff, screenCenter.y,
    { col: yCol, alpha: 220, align: "left", baseline: "center", size: 12 });
}

function drawYLabelsOnCurve(yAtX) {
  if (!state.fn) return;
  const { minX, maxX } = getVisibleWorldBounds();
  // In discrete modes, always use decimal grid levels (pixels are at decimal positions)
  let levels = isDiscreteAny() ? getYGridLevels() : getGridLevels();
  if (isDiscreteAny()) {
    const { xStep } = getDiscreteStep();
    levels = levels.filter(lv => lv.step >= xStep - 1e-9);
  }
  const yCol = getStepColor("y");
  const tickBaseCol = state.lightMode ? [30, 35, 50] : [230, 240, 255];

  push();
  for (const lv of levels) {
    const tickAlpha = lv.alpha * 160;
    const labelAlpha = lv.alpha * 200;
    if (tickAlpha < 1) continue;

    for (let x = Math.floor(minX / lv.step) * lv.step; x <= maxX; x += lv.step) {
      let y;
      try { y = yAtX(x); } catch { continue; }
      if (!Number.isFinite(y)) continue;

      const s = worldToScreen(x, y);
      if (s.x < -20 || s.x > width + 20 || s.y < -20 || s.y > height + 20) continue;

      // Smart placement: nudge label away from curve (above if curve going up-right, else below)
      const aboveY = s.y - 5;
      const belowY = s.y + 16;
      const useAbove = aboveY > 10;
      drawGlassLabel(formatNumber(y),
        s.x, useAbove ? aboveY : belowY,
        { col: yCol, alpha: labelAlpha, align: "center", baseline: useAbove ? "bottom" : "top", size: 11 });
    }
  }
  pop();
}

/**
 * Show x-value labels along the y=x identity line (or on the x-axis in delta mode).
 * For each x grid point, places the x-value label at (x, x) on the y=x diagonal,
 * except in delta mode where labels sit on the x-axis (y=0, the Δ=0 / identity line).
 */
function drawXLabelsOnCurve() {
  if (!state.fn) return;
  const { minX, maxX } = getVisibleWorldBounds();
  // In discrete modes, always use decimal grid levels (pixels are at decimal positions)
  let levels = isDiscreteAny() ? getYGridLevels() : getGridLevels();
  if (isDiscreteAny()) {
    const { xStep } = getDiscreteStep();
    levels = levels.filter(lv => lv.step >= xStep - 1e-9);
  }
  const xCol = getStepColor("x");
  const eS = (isDiscreteAny() && state.tauMode) ? 2 * Math.PI : 1;
  const isDelta = state.mode === "delta";

  push();
  for (const lv of levels) {
    const tickAlpha = lv.alpha * 160;
    const labelAlpha = lv.alpha * 200;
    if (tickAlpha < 1) continue;

    for (let x = Math.floor(minX / lv.step) * lv.step; x <= maxX; x += lv.step) {
      // In delta mode, place on x-axis (y=0, the identity / Δ=0 line);
      // otherwise on the y=x diagonal at (x, x*eS)
      const s = isDelta ? worldToScreen(x, 0) : worldToScreen(x, x * eS);
      if (s.x < -40 || s.x > width + 40 || s.y < -20 || s.y > height + 20) continue;

      // Place x-value label below the line
      drawGlassLabel(formatXLabel(x * eS),
        s.x, s.y + 5,
        { col: xCol, alpha: labelAlpha, align: "center", baseline: "top", size: 11 });
    }
  }
  pop();
}

function drawIntermediateCurves(transformFn) {
  const steps = state.steps;
  if (steps.length < 2) return;

  for (let k = 0; k < steps.length - 1; k++) {
    // Check eye visibility: k=0 is x, k>=1 is ops[k-1]
    if (k === 0 && !state.stepEyes.x) continue;
    if (k > 0 && state.stepEyes.ops[k - 1] === false) continue;

    const step = steps[k];
    const col = getStepColor(step);
    const fadedCol = color(red(col), green(col), blue(col), 130);

    if (transformFn) {
      drawCurve((x) => transformFn(step.fn(x), x), fadedCol, 1.5);
    } else {
      drawCurve((x) => step.fn(x), fadedCol, 1.5);
    }

    // Subintermediates between this step and the next
    if (k < steps.length - 1 && state.toggles.subintermediates) {
      const nextOp = state.ops[k]; // op that transforms step[k] → step[k+1]
      if (nextOp && state.stepEyes.ops[k] !== false) {
        const subItems = getSubintermediateFns(step.fn, nextOp);
        for (const sub of subItems) {
          const subBaseCol = getStepColor(sub.category);
          const subCol = color(red(subBaseCol), green(subBaseCol), blue(subBaseCol), 100);
          if (transformFn) {
            drawCurve((x) => transformFn(sub.fn(x), x), subCol, 1.0);
          } else {
            drawCurve((x) => sub.fn(x), subCol, 1.0);
          }
        }
      }
    }
  }
}

/**
 * Draw colored starbursts at each visible grid level for
 * intermediate step values. Uses the same continuous grid levels as gridlines.
 */
function drawIntermediateDots(transformFn) {
  const steps = state.steps;
  if (steps.length < 3) return;

  const { minX, maxX } = getVisibleWorldBounds();
  const levels = getGridLevels();

  for (const lv of levels) {
    if (lv.alpha < 0.01) continue;

    const iStart = Math.floor((minX - 1) / lv.step) * lv.step;
    for (let x = iStart; x <= maxX + 1; x += lv.step) {
      for (let k = 1; k < steps.length - 1; k++) {
        if (state.stepEyes.ops[k - 1] === false) continue;
        let v;
        try { v = steps[k].fn(x); } catch { continue; }
        if (!Number.isFinite(v)) continue;
        const yVal = transformFn ? transformFn(v, x) : v;
        if (!Number.isFinite(yVal)) continue;
        const pt = worldToScreen(x, yVal);
        const col = getStepColor(steps[k]);
        drawStarburst(pt.x, pt.y, col, 3.75, 255 * lv.alpha);

        // Subintermediate dots between step[k] and step[k+1]
        if (state.toggles.subintermediates) {
          const nextOp = state.ops[k];
          if (nextOp && state.stepEyes.ops[k] !== false) {
            const subItems = getSubintermediateFns(steps[k].fn, nextOp);
            for (const sub of subItems) {
              let sv;
              try { sv = sub.fn(x); } catch { continue; }
              if (!Number.isFinite(sv)) continue;
              const syVal = transformFn ? transformFn(sv, x) : sv;
              if (!Number.isFinite(syVal)) continue;
              const spt = worldToScreen(x, syVal);
              const subDotCol = getStepColor(sub.category);
              drawStarburst(spt.x, spt.y, subDotCol, 2.25, 180 * lv.alpha);
            }
          }
        }
      }
    }
  }
}

function drawCartesianCurve() {
  if (!state.fn) return;
  if (!state.stepEyes.y) return;
  drawCurve((x) => state.fn(x));
}

function drawDeltaCurveAndArrows() {
  if (!state.fn) return;

  // Curve: Δ(x) = f(x) - x (respect y eye visibility)
  if (state.stepEyes.y) {
    drawCurve((x) => state.fn(x) - x);
  }

  if (!state.toggles.arrows) return;

  const { minX, maxX } = getVisibleWorldBounds();
  const levels = getArrowGridLevels();
  const steps = state.steps;
  const θ = view.rotation;
  const xDirSx = Math.cos(θ);
  const xDirSy = Math.sin(θ);

  function drawDeltaArrowsAtStep(step, alphaScale) {
    for (let x = Math.floor((minX - 1) / step) * step; x <= maxX + 1; x += step) {
      const base = worldToScreen(x, 0);

      if (steps.length > 0) {
        drawKnotCircle(base.x, base.y, getStepColor("x"), undefined, 255 * alphaScale);

        let prevDelta = 0;
        let prevStepDelta = null;
        for (let k = 0; k < steps.length; k++) {
          let nextDelta;
          try { nextDelta = steps[k].fn(x) - x; } catch { nextDelta = NaN; }
          if (!Number.isFinite(nextDelta)) break;
          const stepDelta = nextDelta - prevDelta;
          const eyeVisible = k === 0 ? state.stepEyes.x !== false : state.stepEyes.ops[k - 1] !== false;
          if (!eyeVisible) { prevDelta = nextDelta; prevStepDelta = stepDelta; continue; }
          const a = worldToScreen(x, prevDelta);
          const b = worldToScreen(x, nextDelta);
          let off = 0;
          if (prevStepDelta !== null && prevStepDelta * stepDelta < 0) {
            off = stepDelta > 0 ? -5 : 5;
          }
          const col = getStepColor(steps[k]);
          drawArrowScreen(a.x + off * xDirSx, a.y - off * xDirSy, b.x + off * xDirSx, b.y - off * xDirSy,
            { col, alpha: 220 * alphaScale, strokeWeightPx: 2 });

          const dotCol = (k === steps.length - 1) ? getStepColor("y") : getStepColor(steps[k]);
          drawKnotCircle(b.x, b.y, dotCol, undefined, 255 * alphaScale);

          prevDelta = nextDelta;
          prevStepDelta = stepDelta;
        }
      } else {
        let delta;
        try { delta = state.fn(x) - x; } catch { delta = NaN; }
        if (!Number.isFinite(delta)) continue;
        const a = worldToScreen(x, 0);
        const b = worldToScreen(x, delta);
        const col = getDeltaArrowColor(delta);
        drawArrowScreen(a.x, a.y, b.x, b.y, { col, alpha: 220 * alphaScale, strokeWeightPx: 2 });
      }
    }
  }

  // Draw arrows at every grid level with continuous fading
  for (const lv of levels) {
    if (lv.alpha < 0.01) continue;
    drawDeltaArrowsAtStep(lv.step, lv.alpha);
  }
}

function drawNumberLinesAndArrows() {
  const showTicks = state.toggles.xgrid;
  const { minX, maxX } = getVisibleWorldBounds();
  const majorStep = getMajorStepWorld();
  const steps = state.steps;
  const maxGap = 100;
  const θ = view.rotation;
  // X-axis direction and perpendicular in screen space
  const xDir = { x: Math.cos(θ), y: -Math.sin(θ) };
  const perp = { x: Math.sin(θ), y: Math.cos(θ) };  // "up" perpendicular to x-axis
  const origin = worldToScreen(0, 0);

  let opSteps = steps;
  if (opSteps.length > 0 && opSteps[0].type === "x") {
    opSteps = opSteps.slice(1);
  }
  const opNumLines = opSteps.length > 0 ? opSteps.length + 1 : 2;
  const gapPx = Math.min(maxGap, Math.max(40, (height - 100) / Math.max(1, opNumLines - 1)));

  // Each line's anchor = origin + j * gapPx in the perp direction
  // At 0°: perp={0,1} so lines go downward (x top, y bottom = top-to-bottom reading)
  // At 90°: perp={1,0} so lines go rightward (x left, y right = left-to-right reading)
  function lineAnchor(j) {
    return {
      x: origin.x + perp.x * j * gapPx,
      y: origin.y + perp.y * j * gapPx,
    };
  }
  // Project a world x-value onto a specific number line j → screen point
  function xOnLine(xVal, j) {
    const sx = worldToScreen(xVal, 0);
    const anchor = lineAnchor(j);
    // sx gives the position along the x-axis direction from origin
    // We want that same offset applied from the line's anchor
    const dx = sx.x - origin.x;
    const dy = sx.y - origin.y;
    return { x: anchor.x + dx, y: anchor.y + dy };
  }

  function getLineColor(j) {
    if (j === 0) return getStepColor("x");
    if (j === opNumLines - 1) return getStepColor("y");
    if (opSteps.length > 0 && j - 1 < opSteps.length) return getStepColor(opSteps[j - 1]);
    return state.lightMode ? color(30, 35, 50, 170) : color(255, 255, 255, 170);
  }

  // Draw lines along x-axis direction
  const diagPx = Math.sqrt(width * width + height * height) + 100;
  strokeWeight(2);
  for (let j = 0; j < opNumLines; j++) {
    const lc = getLineColor(j);
    stroke(red(lc), green(lc), blue(lc), 200);
    const a = lineAnchor(j);
    line(a.x - xDir.x * diagPx, a.y - xDir.y * diagPx,
      a.x + xDir.x * diagPx, a.y + xDir.y * diagPx);
  }

  // Ticks with continuous fading
  if (showTicks) {
    const levels = getGridLevels();
    const tickBaseCol = state.lightMode ? [30, 35, 50] : [255, 255, 255];
    strokeWeight(1);
    for (const lv of levels) {
      const tAlpha = lv.alpha * 120;
      if (tAlpha < 1) continue;
      stroke(...tickBaseCol, tAlpha);
      for (let x = Math.floor(minX / lv.step) * lv.step; x <= maxX; x += lv.step) {
        for (let j = 0; j < opNumLines; j++) {
          const p = xOnLine(x, j);
          if (p.x < -60 || p.x > width + 60 || p.y < -60 || p.y > height + 60) continue;
          line(p.x - perp.x * 5, p.y - perp.y * 5, p.x + perp.x * 5, p.y + perp.y * 5);
        }
      }
    }
  }

  if (state.fn && state.toggles.arrows) {
    const levels = getArrowGridLevels();

    function drawParallelArrowsAtX(x, alphaScale) {
      if (opSteps.length > 0) {
        const values = [x];
        for (let k = 0; k < opSteps.length; k++) {
          let v;
          try { v = opSteps[k].fn(x); } catch { v = NaN; }
          if (!Number.isFinite(v)) break;
          values.push(v);
        }
        for (let j = 0; j < values.length - 1; j++) {
          if (state.stepEyes.ops[j] === false) continue;
          const s1 = xOnLine(values[j], j);
          const s2 = xOnLine(values[j + 1], j + 1);
          const col = getStepColor(opSteps[j]);
          drawArrowScreen(s1.x, s1.y, s2.x, s2.y, {
            col, alpha: 220 * alphaScale, strokeWeightPx: 2,
          });
          drawKnotCircle(s1.x, s1.y, getLineColor(j), undefined, 255 * alphaScale);
          drawKnotCircle(s2.x, s2.y, getLineColor(j + 1), undefined, 255 * alphaScale);
        }
      } else {
        let fx;
        try { fx = state.fn(x); } catch { fx = NaN; }
        if (!Number.isFinite(fx)) return;
        const p1 = xOnLine(x, 0);
        const p2 = xOnLine(fx, 1);
        const col = getDeltaArrowColor(fx - x);
        drawArrowScreen(p1.x, p1.y, p2.x, p2.y, { col, alpha: 220 * alphaScale, strokeWeightPx: 2 });
      }
    }

    for (const lv of levels) {
      if (lv.alpha < 0.01) continue;
      for (let x = Math.floor((minX - 1) / lv.step) * lv.step; x <= maxX + 1; x += lv.step) {
        drawParallelArrowsAtX(x, lv.alpha);
      }
    }
  }

  // Draw tick labels with glass backgrounds
  if (showTicks && state.toggles.xlabels) {
    const levels = getGridLevels();
    const xColNL = getStepColor("x");

    for (const lv of levels) {
      const labelAlpha = lv.alpha * 190;
      if (labelAlpha < 1) continue;

      for (let x = Math.floor(minX / lv.step) * lv.step; x <= maxX; x += lv.step) {
        for (let j = 0; j < opNumLines; j++) {
          const p = xOnLine(x, j);
          if (p.x < -60 || p.x > width + 60 || p.y < -60 || p.y > height + 60) continue;
          drawGlassLabel(formatXLabel(x),
            p.x + perp.x * 8, p.y + perp.y * 8 + (j === 0 ? 2 : -2),
            { col: xColNL, alpha: labelAlpha, align: "center", baseline: j === 0 ? "top" : "bottom", size: 11 });
        }
      }
    }
  }
}

function drawCartesianTransformArrows() {
  if (!state.fn) return;
  const { minX, maxX } = getVisibleWorldBounds();
  const levels = getArrowGridLevels();
  const steps = state.steps;
  const θ = view.rotation;
  const xDirSx = Math.cos(θ);
  const xDirSy = Math.sin(θ);

  function drawArrowsAtX(x, alphaScale) {
    if (steps.length > 0) {
      const values = [x];
      for (let k = 0; k < steps.length; k++) {
        let v;
        try { v = steps[k].fn(x); } catch { v = NaN; }
        if (!Number.isFinite(v)) break;
        values.push(v);
      }
      if (values.length < 2) return;

      let prevStepDelta = null;
      for (let j = 0; j < values.length - 1; j++) {
        const fromVal = values[j];
        const toVal = values[j + 1];
        const stepDelta = toVal - fromVal;
        const eyeVisible = j === 0 || state.stepEyes.ops[j - 1] !== false;
        if (!eyeVisible) { prevStepDelta = stepDelta; continue; }
        const a = worldToScreen(x, fromVal);
        const b = worldToScreen(x, toVal);
        let off = 0;
        if (prevStepDelta !== null && prevStepDelta * stepDelta < 0) {
          off = stepDelta > 0 ? -5 : 5;
        }
        const col = getStepColor(steps[j]);
        drawArrowScreen(a.x + off * xDirSx, a.y - off * xDirSy, b.x + off * xDirSx, b.y - off * xDirSy,
          { col, alpha: 220 * alphaScale, strokeWeightPx: 2 });
        prevStepDelta = stepDelta;
      }

      for (let j = 0; j < values.length; j++) {
        if (j === 0 && !state.stepEyes.x) continue;
        if (j === values.length - 1 && !state.stepEyes.y) continue;
        if (j > 0 && j < values.length - 1 && state.stepEyes.ops[j - 1] === false) continue;
        const pt = worldToScreen(x, values[j]);
        if (j === 0) drawKnotCircle(pt.x, pt.y, getStepColor("x"), undefined, 255 * alphaScale);
        else if (j === values.length - 1) drawKnotCircle(pt.x, pt.y, getStepColor("y"), undefined, 255 * alphaScale);
        else drawKnotCircle(pt.x, pt.y, getStepColor(steps[j - 1]), undefined, 255 * alphaScale);
      }
    } else {
      let fx;
      try { fx = state.fn(x); } catch { fx = NaN; }
      if (!Number.isFinite(fx)) return;
      const a = worldToScreen(x, x);
      const b = worldToScreen(x, fx);
      drawArrowScreen(a.x, a.y, b.x, b.y, { col: getStepColor("misc"), alpha: 200 * alphaScale, strokeWeightPx: 2 });
      drawKnotCircle(a.x, a.y, getStepColor("x"), undefined, 255 * alphaScale);
      drawKnotCircle(b.x, b.y, getStepColor("y"), undefined, 255 * alphaScale);
    }
  }

  // Draw arrows at every grid level with continuous fading
  for (const lv of levels) {
    if (lv.alpha < 0.01) continue;
    for (let x = Math.floor((minX - 1) / lv.step) * lv.step; x <= maxX + 1; x += lv.step) {
      drawArrowsAtX(x, lv.alpha);
    }
  }
}

function draw() {
  // Advance t parameter when playing
  window._gcT = state.t;
  if (state.tPlaying && state.usesT) {
    state.t += (deltaTime / 1000) * state.tSpeed;
    if (state.t > state.tMax) state.t = state.tMin;
    window._gcT = state.t;
    // Update slider UI
    const slider = document.getElementById('timeline-slider');
    if (slider) slider.value = state.t;
    const valEl = document.getElementById('timeline-value');
    if (valEl) valEl.textContent = 't = ' + state.t.toFixed(2);
  }

  if (state.bgColor && state.lightMode) {
    background(state.bgColor);
  } else if (isDiscreteAny() && !state.lightMode) {
    background(0);
  } else {
    background(state.lightMode ? 245 : 10, state.lightMode ? 246 : 14, state.lightMode ? 250 : 28);
  }

  const hov = state.hoveredToggle;

  // Glow helpers — disabled for performance (canvas shadowBlur is too expensive
  // with hundreds of shapes). Toggle hover preview still works via shouldPreview().
  function glowOn(key) { }
  function glowOff() { }

  // Determine effective visibility: ON if toggle is on, OR hovering an OFF toggle (preview)
  // But only preview if the toggle was already OFF (not just turned off by clicking)
  function shouldPreview(key) {
    const hovSet = Array.isArray(hov) ? hov : (hov ? [hov] : []);
    return hovSet.includes(key) && !state.toggles[key] && !state.toggleJustTurnedOff[key];
  }
  const showXGrid = state.toggles.xgrid || shouldPreview("xgrid");
  const showYGrid = state.toggles.ygrid || shouldPreview("ygrid");
  const showXAxis = state.toggles.xaxis || shouldPreview("xaxis");
  const showYAxis = state.toggles.yaxis || shouldPreview("yaxis");
  const showArrows = state.toggles.arrows || shouldPreview("arrows");
  const showIntermediates = state.toggles.intermediates || shouldPreview("intermediates");
  const showStarbursts = state.toggles.starbursts || shouldPreview("starbursts");

  // Temporarily override toggles so all drawing functions respect hover previews
  const savedToggles = { ...state.toggles };
  state.toggles.xgrid = showXGrid;
  state.toggles.ygrid = showYGrid;
  state.toggles.xaxis = showXAxis;
  state.toggles.yaxis = showYAxis;
  state.toggles.arrows = showArrows;
  state.toggles.intermediates = showIntermediates;
  state.toggles.starbursts = showStarbursts;
  // Label toggle previews
  if (shouldPreview("xlabels")) state.toggles.xlabels = true;
  if (shouldPreview("ylabels")) state.toggles.ylabels = true;

  // Note: state.stepEyes.x is NOT synced with the x-axis toggle.
  // The x-axis toggle controls only the axis line and its labels.
  // The y=x identity curve is controlled separately by stepEyes.x (via the eye button).

  if (state.mode === "numberLines") {
    // Number lines mode uses its own horizontal layout but respects rotation for worldToScreen
    drawNumberLinesAndArrows();
  } else if (state.discreteMode === "discrete") {
    // Full discrete mode: single unified pixel scene handles axes, curves, intermediates
    drawDiscreteScene();
    // Still draw axis labels (but not lines/ticks — handled by drawAxesAndLabels guards)
    drawAxesAndLabels(getMajorStepWorld());
    // Curve labels when axes are hidden
    const _eS1 = state.tauMode ? 2 * Math.PI : 1;
    const yFnDisc = state.mode === "delta" ? (x) => { const ex = x * _eS1; return state.fn(ex) - ex; } : (x) => state.fn(x * _eS1);
    if (state.toggles.ylabels && state.fn) drawYLabelsOnCurve(yFnDisc);
    if (state.toggles.xlabels && state.fn) drawXLabelsOnCurve();
  } else if (state.discreteMode === "discreteX") {
    // Discrete X mode: x is discretized, y is continuous (horizontal bars)
    drawDiscreteXScene();
    drawAxesAndLabels(getMajorStepWorld());
    // Curve labels
    const _eS2 = state.tauMode ? 2 * Math.PI : 1;
    const yFnDiscX = state.mode === "delta" ? (x) => { const ex = x * _eS2; return state.fn(ex) - ex; } : (x) => state.fn(x * _eS2);
    if (state.toggles.ylabels && state.fn) drawYLabelsOnCurve(yFnDiscX);
    if (state.toggles.xlabels && state.fn) drawXLabelsOnCurve();
  } else {
    // Grid lines glow on grid hover; axes drawn separately (y-axis has own glow)
    if (showXGrid || showYGrid) {
      drawGridLines();
    }
    drawAxesAndLabels(getMajorStepWorld());

    if (state.mode === "delta") {
      glowOn("intermediates");
      if (showIntermediates) {
        drawIntermediateCurves((val, x) => val - x);
        drawIntermediateDots((val, x) => val - x);
      }
      glowOff();

      glowOn("arrows");
      drawDeltaCurveAndArrows();
      glowOff();

      glowOn("yaxis");
      if (state.toggles.ylabels) drawYLabelsOnCurve((x) => state.fn(x) - x);
      glowOff();

      if (state.toggles.xlabels) drawXLabelsOnCurve();
    } else {
      glowOn("intermediates");
      if (showIntermediates) {
        drawIntermediateCurves();
        drawIntermediateDots();
      }
      glowOff();

      drawCartesianCurve();

      glowOn("arrows");
      if (state.mode === "cartesian" && showArrows) {
        drawCartesianTransformArrows();
      }
      glowOff();

      glowOn("yaxis");
      if (state.toggles.ylabels) drawYLabelsOnCurve((x) => state.fn(x));
      glowOff();

      if (state.toggles.xlabels) drawXLabelsOnCurve();
    }
  }

  // Restore original toggles
  state.toggles = savedToggles;

  // Cursor starburst (replaces system cursor on active graph area)
  // On mobile, use touch cursor position (offset above finger) instead of mouseX/mouseY
  const tc = window._mobileTouchCursor;
  const inputFocused = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');
  const isMobileCursor = tc && tc.active && document.body.classList.contains('mobile') && !inputFocused;
  const effectiveCursorX = isMobileCursor ? tc.x : mouseX;
  const effectiveCursorY = isMobileCursor ? tc.y : mouseY;
  const cursorOnCanvas = isMobileCursor
    ? (tc.x >= 0 && tc.x <= width && tc.y >= 0 && tc.y <= height)
    : (!inputFocused && isMouseOverCanvas() && !isOverUI());
  if (cursorOnCanvas) {
    document.body.style.cursor = isMobileCursor ? '' : 'none';
    // Temporarily override mouseX/mouseY for cursor drawing functions
    const savedMX = mouseX, savedMY = mouseY;
    window._p5Inst = this;
    mouseX = effectiveCursorX;
    mouseY = effectiveCursorY;
    if (!isDiscreteAny()) drawCursorToYCurve();
    drawCursorStarburst();
    let liveX = screenToWorld(effectiveCursorX, effectiveCursorY).x;
    if (isDiscreteAny()) {
      const { xStep } = getDiscreteStep();
      liveX = Math.round(liveX / xStep) * xStep;
      if (state.tauMode) liveX = liveX * (2 * Math.PI);
    }
    updateLiveOpValues(liveX);
    updateLiveDagValues(liveX);
    updateLatexDisplayLive(liveX);
    mouseX = savedMX;
    mouseY = savedMY;
  } else {
    document.body.style.cursor = '';
    updateLiveOpValues(null);
    updateLiveDagValues(null);
    updateLatexDisplayLive(null);
  }

  // ---- HUD overlay (HTML element) ----
  if (ui.hudEl && state.hudVisible) {
    const tl = screenToWorld(0, 0);
    const br = screenToWorld(width, height);
    const minX = formatNumber(Math.min(tl.x, br.x));
    const maxX = formatNumber(Math.max(tl.x, br.x));
    const minY = formatNumber(Math.min(tl.y, br.y));
    const maxY = formatNumber(Math.max(tl.y, br.y));

    let coordLine = state.mode === "numberLines"
      ? `x: [${minX}, ${maxX}] · ${formatNumber(view.scale)} px/u`
      : `x: [${minX}, ${maxX}] · y: [${minY}, ${maxY}] · ${formatNumber(view.scale)} px/u`;

    const statusHtml = state.statusText
      ? `<div class="hud-line${state.statusKind === 'error' ? ' hud-line--error' : ''}">${state.statusText}</div>`
      : "";
    ui.hudEl.innerHTML = statusHtml + `<div class="hud-line hud-line--coords">${coordLine}</div>`;
  }
}

