/* Graphing Calculator (Draft)
 * - p5.js renderer
 * - Pan (drag), zoom (wheel), reset view
 * - Expression compiler with a whitelist of identifiers
 */

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
  toggles: { xgrid: true, ygrid: true, xaxis: false, yaxis: false, arrows: true, intermediates: true, subintermediates: true, starbursts: true, xlabels: true, ylabels: true },
  glowCurves: true, // when true, curves are 1px bright with coloured glow (continuous/discreteX only)
  hoveredToggle: null, // which toggle key is being hovered (for glow effect)
  toggleJustTurnedOff: {}, // tracks toggles recently clicked OFF (prevents immediate hover preview)
  tauMode: false, // when true, x-axis is in τ units (1 τ = 2π)
  discreteMode: "discreteX", // "continuous", "discreteX", or "discrete"
  numeralMode: true, // when true, discrete pixels show numeral values instead of solid fills
  stepEyes: { x: true, ops: [], y: true }, // per-step visibility (eye toggles)
  stepEyeMode: false, // mobile: show eye toggles inside op boxes
  hoveredStep: null, // "x" | "op-0" | "op-1" | ... | "y" (for glow)
  statusText: "",
  statusKind: "info",
  t: 0,
  tMin: 0,
  tMax: 10,
  tSpeed: 1,
  tPlaying: true,
  usesT: false,
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
  const bottomH = toggleBar ? toggleBar.getBoundingClientRect().height : 0;
  view.originX = width * 0.5;
  view.originY = topH + (height - topH - bottomH) * 0.5;
  view.scale = 80;
  view.rotation = 0;
  // Sync rotation button UI
  if (ui.rotBtns) ui.rotBtns.forEach(b => {
    b.classList.toggle("mode-btn--active", parseFloat(b.dataset.rot) === 0);
  });
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

  // Restrict y gridlines to visible function range
  const dr = state.fn ? computeVisibleDomainRange() : null;
  const yGridMin = (dr && Number.isFinite(dr.rangeMin)) ? dr.rangeMin : minY;
  const yGridMax = (dr && Number.isFinite(dr.rangeMax)) ? dr.rangeMax : maxY;

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

function computeVisibleDomainRange() {
  if (!state.fn) return { domainMin: -Infinity, domainMax: Infinity, rangeMin: -Infinity, rangeMax: Infinity };
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
  return { domainMin, domainMax, rangeMin, rangeMax };
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
};
const userColors = OP_COLORS;

/* Classify an op into a colour category */
const TRIG_FNS = new Set(["sin", "cos", "tan", "asin", "acos", "atan"]);
const EXP_FNS = new Set(["exp", "ln", "log"]);

function getOpCategory(op) {
  if (op.type === "add" || op.type === "sub") return "addSub";
  if (op.type === "mul" || op.type === "div") return "mulDiv";
  const fn = getFunctionName(op);
  if (fn) {
    if (TRIG_FNS.has(fn)) return "trig";
    if (EXP_FNS.has(fn)) return "exp";
    return "misc";
  }
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
  if (!expr) return { steps: [], ops: [], fullExpr: "" };
  const normalized = expr.replace(/\s+/g, "").replace(/\^/g, "**");
  const identifiers = normalized.match(/[a-zA-Z_]+/g) || [];
  for (const id of identifiers) {
    if (id !== "x" && !ALLOWED_IDS.has(id)) return { steps: [], ops: [], fullExpr: normalized };
  }
  try {
    const tokens = tokenize(expr);
    const ast = parseExpression(tokens);
    const steps = linearize(ast);
    const fullExpr = steps.length > 0 ? steps[steps.length - 1].expr : normalized;
    const fns = steps.map((s) => ({ ...s, fn: compileNormalizedExpr(s.expr) }));
    // Extract ops (skip leading x step)
    const ops = fns.filter((s) => s.type !== "x").map((s) => ({
      type: s.type, label: s.label, operand: s.operand,
      applyToExpr: s.applyToExpr,
    }));
    return { steps: fns, ops, fullExpr };
  } catch {
    return { steps: [], ops: [], fullExpr: normalized };
  }
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
  return m ? m[1] : null;
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

function applyOpsChange() {
  try {
    const steps = rebuildStepsFromOps(state.ops);
    state.steps = steps;
    state.fn = steps.length > 0 ? steps[steps.length - 1].fn : null;
    // Sync the text input with the current ops
    syncInputFromOps();
    renderStepRepresentation();
    setStatusForCurrentMode();
    // Resize the expression input to fit updated content
    autoSizeInput();
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

  for (const op of ops) {
    const colorHex = userColors[getColorKeyForOp(op)] || "#aaa";

    if (op.type === "add" || op.type === "sub") {
      const sym = op.type === "add" ? " + " : " - ";
      const operand = op.operand || "";
      spans.push({ text: sym, color: colorHex, isBracket: false });
      spans.push({ text: operand, color: colorHex, isBracket: false });
      prevPrec = 1;
    } else if (op.type === "mul" || op.type === "div") {
      const sym = op.type === "mul" ? " * " : " / ";
      const operand = op.operand || "";
      if (prevPrec < 2) {
        spans.splice(0, 0, { text: "(", color: colorHex, isBracket: true });
        spans.push({ text: ")", color: colorHex, isBracket: true });
      }
      spans.push({ text: sym, color: colorHex, isBracket: false });
      // Wrap operand in parens if it has lower-precedence operators
      if (/[+\-]/.test(operand) && !/^\d/.test(operand)) {
        spans.push({ text: "(", color: colorHex, isBracket: true });
        spans.push({ text: operand, color: colorHex, isBracket: false });
        spans.push({ text: ")", color: colorHex, isBracket: true });
      } else {
        spans.push({ text: operand, color: colorHex, isBracket: false });
      }
      prevPrec = 2;
    } else {
      const fnName = getFunctionName(op);
      if (fnName) {
        spans.splice(0, 0, { text: fnName + "(", color: colorHex, isBracket: false });
        spans.push({ text: ")", color: colorHex, isBracket: false });
        prevPrec = 999;
      } else if (op.label === "x²") {
        if (prevPrec < 3) {
          spans.splice(0, 0, { text: "(", color: colorHex, isBracket: true });
          spans.push({ text: ")", color: colorHex, isBracket: true });
        }
        spans.push({ text: "^2", color: colorHex, isBracket: false });
        prevPrec = 3;
      } else if (getExpBase(op) !== null) {
        const base = op.operand || getExpBase(op);
        spans.splice(0, 0, { text: base + "^(", color: colorHex, isBracket: false });
        spans.push({ text: ")", color: colorHex, isBracket: false });
        prevPrec = 999;
      } else if (getLogBase(op) !== null) {
        const base = op.operand || getLogBase(op);
        spans.splice(0, 0, { text: "ln(", color: colorHex, isBracket: false });
        spans.push({ text: ")/ln(" + base + ")", color: colorHex, isBracket: false });
        prevPrec = 999;
      } else if (op.label === "^ −1" || op.label === "^ -1") {
        if (prevPrec < 3) {
          spans.splice(0, 0, { text: "(", color: colorHex, isBracket: true });
          spans.push({ text: ")", color: colorHex, isBracket: true });
        }
        spans.push({ text: "^(-1)", color: colorHex, isBracket: false });
        prevPrec = 3;
      } else if (getPowerExponent(op) !== null) {
        const expStr = op.operand || getPowerExponent(op);
        if (prevPrec < 3) {
          spans.splice(0, 0, { text: "(", color: colorHex, isBracket: true });
          spans.push({ text: ")", color: colorHex, isBracket: true });
        }
        spans.push({ text: "^", color: colorHex, isBracket: false });
        spans.push({ text: expStr, color: colorHex, isBracket: false });
        prevPrec = 3;
      } else if (getRootN(op) !== null) {
        const rootN = op.operand || getRootN(op);
        if (prevPrec < 3) {
          spans.splice(0, 0, { text: "(", color: colorHex, isBracket: true });
          spans.push({ text: ")", color: colorHex, isBracket: true });
        }
        spans.push({ text: "^(1/", color: colorHex, isBracket: false });
        spans.push({ text: rootN, color: colorHex, isBracket: false });
        spans.push({ text: ")", color: colorHex, isBracket: false });
        prevPrec = 3;
      } else if (getModOperand(op) !== null) {
        const modVal = op.operand || getModOperand(op);
        if (prevPrec < 2) {
          spans.splice(0, 0, { text: "(", color: colorHex, isBracket: true });
          spans.push({ text: ")", color: colorHex, isBracket: true });
        }
        spans.push({ text: " % ", color: colorHex, isBracket: false });
        spans.push({ text: modVal, color: colorHex, isBracket: false });
        prevPrec = 2;
      } else {
        spans.push({ text: op.label, color: colorHex, isBracket: false });
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
  const text = ui.exprEl.value;
  if (!text) {
    ui.exprOverlay.innerHTML = "";
    if (controlEl) controlEl.classList.remove('has-overlay');
    return;
  }

  // If we have pre-built spans from buildDisplayExpr (after Enter/plotFunction), use them
  if (state.displaySpans && state.displaySpans.length) {
    const spanText = state.displaySpans.map(s => s.text).join('');
    if (spanText === text) {
      ui.exprOverlay.innerHTML = state.displaySpans
        .map(s => {
          const opacity = s.isBracket ? 0.35 : 1;
          return '<span style="color:' + s.color + ';opacity:' + opacity + '">' + escapeHtml(s.text) + '</span>';
        })
        .join('');
      if (controlEl) controlEl.classList.add('has-overlay');
      return;
    }
  }

  // Live coloring: tokenize the raw text and color by token type
  const spans = colorizeRawExpr(text);
  if (spans.length > 0) {
    ui.exprOverlay.innerHTML = spans
      .map(s => '<span style="color:' + s.color + (s.opacity ? ';opacity:' + s.opacity : '') + '">' + escapeHtml(s.text) + '</span>')
      .join('');
    if (controlEl) controlEl.classList.add('has-overlay');
  } else {
    ui.exprOverlay.innerHTML = "";
    if (controlEl) controlEl.classList.remove('has-overlay');
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
    case "div": return "/";
    default: return null;
  }
}

function getInverseOpSymbol(step) {
  switch (step.type) {
    case "add": return "−";
    case "sub": return "+";
    case "mul": return "/";
    case "div": return "×";
    default: return null;
  }
}

function getOpValue(step) {
  if (step.type === "add" || step.type === "sub") {
    return step.label.replace(/^[+−]\s*/, "");
  }
  if (step.type === "mul" || step.type === "div") {
    return step.label.replace(/^[×/]\s*/, "");
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

function renderStepRepresentation() {
  const el = document.getElementById("step-rep");
  const label = document.getElementById("step-rep-label");
  if (!el) return;
  el.innerHTML = "";
  const ops = state.ops;

  // Always show the sequence (at minimum x → y)
  el.classList.remove("step-rep--empty");
  if (label) label.style.display = "";

  // Sync stepEyes.ops length with current ops
  while (state.stepEyes.ops.length < ops.length) state.stepEyes.ops.push(true);
  state.stepEyes.ops.length = ops.length;

  const flow = document.createElement("div");
  flow.className = "step-flow";

  // SVG eye icon generators
  function eyeOpenSvg(col) {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="' + col + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  }
  function eyeClosedSvg(col) {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="' + col + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  }

  function getEyeColor(stepKey) {
    if (stepKey === "x") return OP_COLORS.x;
    if (stepKey === "y") return OP_COLORS.y;
    const idx = parseInt(stepKey);
    if (!isNaN(idx) && state.ops[idx]) return OP_COLORS[getOpCategory(state.ops[idx])] || OP_COLORS.misc;
    return OP_COLORS.misc;
  }

  // Helper: create an eye toggle button for a step
  function createEyeBtn(stepKey, isVisible) {
    const btn = document.createElement("button");
    btn.className = "eye-btn" + (isVisible ? " eye-btn--on" : "");
    btn.type = "button";
    const col = getEyeColor(stepKey);
    btn.innerHTML = isVisible ? eyeOpenSvg(col) : eyeClosedSvg(col);
    btn.title = isVisible ? "Hide" : "Show";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (stepKey === "x") {
        state.stepEyes.x = !state.stepEyes.x;
        btn.classList.toggle("eye-btn--on", state.stepEyes.x);
        btn.innerHTML = state.stepEyes.x ? eyeOpenSvg(col) : eyeClosedSvg(col);
        btn.title = state.stepEyes.x ? "Hide" : "Show";
      } else if (stepKey === "y") {
        state.stepEyes.y = !state.stepEyes.y;
        btn.classList.toggle("eye-btn--on", state.stepEyes.y);
        btn.innerHTML = state.stepEyes.y ? eyeOpenSvg(col) : eyeClosedSvg(col);
        btn.title = state.stepEyes.y ? "Hide" : "Show";
      } else {
        const idx = parseInt(stepKey);
        state.stepEyes.ops[idx] = !state.stepEyes.ops[idx];
        btn.classList.toggle("eye-btn--on", state.stepEyes.ops[idx]);
        btn.innerHTML = state.stepEyes.ops[idx] ? eyeOpenSvg(col) : eyeClosedSvg(col);
        btn.title = state.stepEyes.ops[idx] ? "Hide" : "Show";
      }
    });
    return btn;
  }

  // Helper: wrap an element with an eye button in a column
  function wrapWithEye(element, stepKey, isVisible) {
    const col = document.createElement("div");
    col.className = "step-col";
    col.appendChild(element);
    // In eye mode, the eye is inside the box; skip standalone eye below
    if (!state.stepEyeMode) {
      const eye = createEyeBtn(stepKey, isVisible);
      col.appendChild(eye);
    }
    // Hover: set hoveredStep for glow effect
    col.addEventListener("mouseenter", () => {
      state.hoveredStep = stepKey;
    });
    col.addEventListener("mouseleave", () => {
      if (state.hoveredStep === stepKey) state.hoveredStep = null;
    });
    return col;
  }

  // x endpoint
  const xBox = document.createElement("div");
  xBox.className = "step-endpoint step-box--x";
  xBox.dataset.liveRole = "x";
  if (state.stepEyeMode) {
    xBox.appendChild(createEyeBtn("x", state.stepEyes.x));
    xBox.classList.add("step-endpoint--eye-mode");
  } else {
    xBox.textContent = "x";
  }
  flow.appendChild(wrapWithEye(xBox, "x", state.stepEyes.x));

  let dragSrcIdx = null;
  let dragCurrIdx = null;
  let dragPreviewOps = null;
  let dragClone = null;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let dragSwapTime = 0;

  function makeArrowCol() {
    const col = document.createElement("div");
    col.className = "step-arrows-col";
    const arrowR = '<svg width="10" height="8" viewBox="0 0 10 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,1 8,4 4,7"/></svg>';
    const arrowL = '<svg width="10" height="8" viewBox="0 0 10 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6,1 2,4 6,7"/></svg>';
    col.innerHTML = '<div class="connector-fwd">' + arrowR + '</div><div class="connector-inv">' + arrowL + '</div>';
    return col;
  }

  // ---- Drag-to-slide value handler ----
  function attachValDragHandler(valRow, opIdx) {
    valRow.style.cursor = "ew-resize";
    valRow.style.userSelect = "none";
    valRow.style.touchAction = "none";

    let slideActive = false;
    let slideStartX = 0;
    let slideStartY = 0;
    let slideStartVal = 0;
    let slideDirection = null; // 'horizontal' or 'vertical' — decided after threshold

    valRow.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const op = state.ops[opIdx];
      const numVal = parseFloat(op.operand);
      if (isNaN(numVal)) return; // can't slide non-numeric operands

      slideActive = true;
      slideStartX = e.clientX;
      slideStartY = e.clientY;
      slideStartVal = numVal;
      slideDirection = null;
      valRow.setPointerCapture(e.pointerId);
      valRow.classList.add("op-block__val--sliding");
    });

    valRow.addEventListener("pointermove", (e) => {
      if (!slideActive) return;
      const dx = e.clientX - slideStartX;
      const dy = e.clientY - slideStartY;
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);

      // Determine direction on first significant movement
      if (slideDirection === null && (absDx > 8 || absDy > 8)) {
        slideDirection = absDy > absDx ? 'vertical' : 'horizontal';
      }

      // If vertical swipe detected, cancel slide and trigger swap
      if (slideDirection === 'vertical' && _isMobile && dy > 30 && absDy > absDx * 1.5) {
        slideActive = false;
        slideDirection = null;
        valRow.classList.remove("op-block__val--sliding");
        try { valRow.releasePointerCapture(e.pointerId); } catch {}
        // Trigger swap
        const swapped = swapOp(state.ops[opIdx]);
        if (swapped) {
          state.ops[opIdx] = swapped;
          applyOpsChange();
        }
        return;
      }

      // Only do horizontal val-slide if direction is horizontal (or undecided)
      if (slideDirection === 'vertical') return;
      // Sensitivity: scale relative to the magnitude of the value
      const magnitude = Math.max(Math.abs(slideStartVal), 1);
      const sensitivity = magnitude * 0.01;
      let newVal = slideStartVal + dx * sensitivity;
      // Snap to nice values: round to reasonable precision
      const decimals = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : magnitude >= 1 ? 2 : 3;
      newVal = parseFloat(newVal.toFixed(decimals));

      const op = state.ops[opIdx];
      const newOperand = String(newVal);
      if (newOperand === op.operand) return;

      // Rebuild the op with the new operand
      const labelPrefixes = { add: "+ ", sub: "− ", mul: "× ", div: "/ " };
      const opChars = { add: "+", sub: "-", mul: "*", div: "/" };
      if (labelPrefixes[op.type]) {
        state.ops[opIdx] = {
          type: op.type,
          label: labelPrefixes[op.type] + newOperand,
          operand: newOperand,
          applyToExpr: (prev) => "(" + prev + ")" + opChars[op.type] + "(" + newOperand + ")",
        };
      } else if (getPowerExponent(op) !== null) {
        state.ops[opIdx] = {
          type: "other",
          label: "^ " + newOperand,
          operand: newOperand,
          applyToExpr: (prev) => "(" + prev + ")**(" + newOperand + ")",
        };
      } else if (getRootN(op) !== null) {
        state.ops[opIdx] = {
          type: "other",
          label: "ⁿ√ " + newOperand,
          operand: newOperand,
          applyToExpr: (prev) => "(" + prev + ")**(1/(" + newOperand + "))",
        };
      } else if (getExpBase(op) !== null) {
        state.ops[opIdx] = {
          type: "other",
          label: newOperand + "^x",
          operand: newOperand,
          applyToExpr: (prev) => "(" + newOperand + ")**(" + prev + ")",
        };
      } else if (getLogBase(op) !== null) {
        state.ops[opIdx] = {
          type: "other",
          label: "log_" + newOperand + "()",
          operand: newOperand,
          applyToExpr: (prev) => "ln(" + prev + ")/ln(" + newOperand + ")",
        };
      } else if (getModOperand(op) !== null) {
        state.ops[opIdx] = {
          type: "other",
          label: "% " + newOperand,
          operand: newOperand,
          applyToExpr: (prev) => "mod(" + prev + "," + newOperand + ")",
        };
      } else {
        return; // can't slide this type
      }

      // Update display in real time
      valRow.textContent = newOperand;
      try {
        const steps = rebuildStepsFromOps(state.ops);
        state.steps = steps;
        state.fn = steps.length > 0 ? steps[steps.length - 1].fn : null;
        syncInputFromOps();
        setStatusForCurrentMode();
      } catch { }
    });

    const endSlide = () => {
      if (!slideActive) return;
      slideActive = false;
      valRow.classList.remove("op-block__val--sliding");
      syncInputFromOps();
      renderStepRepresentation();
    };
    valRow.addEventListener("pointerup", endSlide);
    valRow.addEventListener("pointercancel", endSlide);
  }

  function buildOpBlock(op, i) {
    const opBlock = document.createElement("div");
    const fwdSym = getOpSymbol(op);
    const invSym = getInverseOpSymbol(op);
    const val = getOpValue(op);
    const isSimple = fwdSym !== null;

    // Use category for CSS class so colours match OP_COLORS
    const cat = getOpCategory(op);
    opBlock.className = "op-block op-block--" + cat;
    opBlock.dataset.idx = String(i);

    // Delete button (top-right, shown on hover)
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "op-block__delete";
    deleteBtn.innerHTML = "&times;";
    deleteBtn.title = "Remove";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      // Clear any active delete preview first
      clearDeletePreview();
      const idx = parseInt(opBlock.dataset.idx);
      const cx = e.clientX, cy = e.clientY;

      state.ops.splice(idx, 1);
      state.stepEyes.ops.splice(idx, 1);
      applyOpsChange();

      // Cursor-based approach: after DOM rebuild, find whatever op-block
      // is now under the cursor and activate its delete-preview state
      requestAnimationFrame(() => {
        const el = document.elementFromPoint(cx, cy);
        if (!el) return;
        const ob = el.closest('.op-block');
        if (ob) {
          const newIdx = parseInt(ob.dataset.idx);
          const delBtn = ob.querySelector('.op-block__delete');
          // Force-show the delete button (CSS :hover may not re-fire)
          if (delBtn) delBtn.style.display = 'flex';
          // Activate delete preview for the op now under cursor
          enterDeletePreview(newIdx);
          ob.classList.add('op-block--delete-preview');
          // Clean up when mouse actually leaves this op-block
          const cleanup = () => {
            clearDeletePreview();
            ob.classList.remove('op-block--delete-preview');
            if (delBtn) delBtn.style.display = '';
            ob.removeEventListener('mouseleave', cleanup);
          };
          ob.addEventListener('mouseleave', cleanup);
        }
      });
    });
    // Delete preview on hover
    deleteBtn.addEventListener("mouseenter", () => {
      const idx = parseInt(opBlock.dataset.idx);
      enterDeletePreview(idx);
      opBlock.classList.add("op-block--delete-preview");
    });
    deleteBtn.addEventListener("mouseleave", () => {
      clearDeletePreview();
      opBlock.classList.remove("op-block--delete-preview");
    });
    opBlock.appendChild(deleteBtn);

    // Build swap handler
    function addSwapBtn() {
      const swapBtn = document.createElement("button");
      swapBtn.className = "op-block__swap";
      swapBtn.title = "Swap forward/inverse";
      swapBtn.textContent = "⇅";
      swapBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = parseInt(opBlock.dataset.idx);
        const swapped = swapOp(state.ops[idx]);
        if (swapped) {
          state.ops[idx] = swapped;
          applyOpsChange();
        }
      });
      opBlock.appendChild(swapBtn);
    }

    if (isSimple) {
      const fwdRow = document.createElement("div");
      fwdRow.className = "op-block__fwd";
      fwdRow.textContent = val ? fwdSym + "\u00A0" + val : fwdSym;
      fwdRow.dataset.liveSym = fwdSym;
      if (val) fwdRow.dataset.liveOperand = val;
      opBlock.appendChild(fwdRow);

      if (val) {
        const valRow = document.createElement("div");
        valRow.className = "op-block__val";
        valRow.textContent = val;
        attachValDragHandler(valRow, i);
        opBlock.appendChild(valRow);
      } else {
        const spacer = document.createElement("div");
        spacer.className = "op-block__val op-block__val--empty";
        opBlock.appendChild(spacer);
      }

      const invRow = document.createElement("div");
      invRow.className = "op-block__inv";
      invRow.textContent = val ? invSym + "\u00A0" + val : invSym;
      invRow.dataset.liveSym = invSym;
      if (val) invRow.dataset.liveOperand = val;
      opBlock.appendChild(invRow);
      addSwapBtn();
    } else {
      const exp = getPowerExponent(op);
      const rootN = getRootN(op);
      const expBaseVal = getExpBase(op);
      const logBaseVal = getLogBase(op);
      const invLabel = getInverseFunctionLabel(op);

      if (exp !== null || rootN !== null) {
        // Power or root op: show fwd/value/inv layout
        const valStr = exp || rootN;
        const isRoot = rootN !== null;
        const fwdRow = document.createElement("div");
        fwdRow.className = "op-block__fwd";
        // Power: [sym] [operand]; Root exception: [operand] [sym]
        fwdRow.textContent = isRoot ? (valStr + "\u00A0ⁿ√") : ("^" + "\u00A0" + valStr);
        fwdRow.dataset.liveSym = isRoot ? "ⁿ√" : "^";
        fwdRow.dataset.liveOperand = valStr;
        if (isRoot) fwdRow.dataset.liveOrder = "root";
        opBlock.appendChild(fwdRow);

        const valRow = document.createElement("div");
        valRow.className = "op-block__val";
        valRow.textContent = valStr;
        attachValDragHandler(valRow, i);
        opBlock.appendChild(valRow);

        const invRow = document.createElement("div");
        invRow.className = "op-block__inv";
        // Power inv is root (exception); Root inv is power (normal)
        invRow.textContent = isRoot ? ("^" + "\u00A0" + valStr) : (valStr + "\u00A0ⁿ√");
        invRow.dataset.liveSym = isRoot ? "^" : "ⁿ√";
        invRow.dataset.liveOperand = valStr;
        if (!isRoot) invRow.dataset.liveOrder = "root";
        opBlock.appendChild(invRow);
        addSwapBtn();
      } else if (expBaseVal !== null) {
        // b^x op: draggable base value
        const fwdRow = document.createElement("div");
        fwdRow.className = "op-block__fwd";
        fwdRow.textContent = "b^x";
        opBlock.appendChild(fwdRow);

        const valRow = document.createElement("div");
        valRow.className = "op-block__val";
        valRow.textContent = expBaseVal;
        attachValDragHandler(valRow, i);
        opBlock.appendChild(valRow);

        const invRow = document.createElement("div");
        invRow.className = "op-block__inv";
        invRow.textContent = invLabel || "log_b";
        opBlock.appendChild(invRow);
        addSwapBtn();
      } else if (logBaseVal !== null) {
        // log_b op: draggable base value
        const fwdRow = document.createElement("div");
        fwdRow.className = "op-block__fwd";
        fwdRow.textContent = "log_b";
        opBlock.appendChild(fwdRow);

        const valRow = document.createElement("div");
        valRow.className = "op-block__val";
        valRow.textContent = logBaseVal;
        attachValDragHandler(valRow, i);
        opBlock.appendChild(valRow);

        const invRow = document.createElement("div");
        invRow.className = "op-block__inv";
        invRow.textContent = invLabel || "b^x";
        opBlock.appendChild(invRow);
        addSwapBtn();
      } else if (getModOperand(op) !== null) {
        // mod op: show fwd=% val, draggable val, no inverse
        const modVal = getModOperand(op);
        const fwdRow = document.createElement("div");
        fwdRow.className = "op-block__fwd";
        fwdRow.textContent = "%\u00A0" + modVal;
        fwdRow.dataset.liveSym = "%";
        fwdRow.dataset.liveOperand = modVal;
        opBlock.appendChild(fwdRow);

        const valRow = document.createElement("div");
        valRow.className = "op-block__val";
        valRow.textContent = modVal;
        attachValDragHandler(valRow, i);
        opBlock.appendChild(valRow);

        const spacer = document.createElement("div");
        spacer.className = "op-block__inv";
        spacer.textContent = "mod";
        opBlock.appendChild(spacer);
      } else if (invLabel) {
        const fwdRow = document.createElement("div");
        fwdRow.className = "op-block__fwd";
        fwdRow.textContent = op.label;
        opBlock.appendChild(fwdRow);

        const spacer = document.createElement("div");
        spacer.className = "op-block__val op-block__val--empty";
        opBlock.appendChild(spacer);

        const invRow = document.createElement("div");
        invRow.className = "op-block__inv";
        invRow.textContent = invLabel;
        opBlock.appendChild(invRow);
        addSwapBtn();
      } else {
        const labelRow = document.createElement("div");
        labelRow.className = "op-block__label";
        labelRow.textContent = op.label;
        opBlock.appendChild(labelRow);
      }
    }
    // Tag fwd/inv rows for live value overlay
    const fwd = opBlock.querySelector('.op-block__fwd');
    const inv = opBlock.querySelector('.op-block__inv');
    if (fwd) { fwd.dataset.liveRole = 'fwd'; fwd.dataset.liveDefault = fwd.textContent; }
    if (inv) { inv.dataset.liveRole = 'inv'; inv.dataset.liveDefault = inv.textContent; }
    return opBlock;
  }

  function rebuildFlowPreview(previewOps) {
    while (flow.children.length > 1) flow.removeChild(flow.lastChild);
    for (let i = 0; i < previewOps.length; i++) {
      flow.appendChild(makeArrowCol());
      const block = buildOpBlock(previewOps[i], i);
      attachDragHandlers(block);
      if (dragSrcIdx !== null) {
        const origOp = state.ops[dragSrcIdx];
        if (previewOps[i] === origOp) block.classList.add("op-block--dragging");
      }
      const vis = state.stepEyes.ops[i] !== false;
      flow.appendChild(wrapWithEye(block, String(i), vis));
    }
    flow.appendChild(makeArrowCol());
    const yBox = document.createElement("div");
    yBox.className = "step-endpoint step-box--y";
    yBox.textContent = "y";
    flow.appendChild(wrapWithEye(yBox, "y", state.stepEyes.y));
  }

  /* FLIP-animated rebuild: records old block rects, rebuilds DOM, then
     slides each block from its old position to its new one. */
  function animatedRebuildFlowPreview(newOps, prevOps) {
    // FIRST: record old positions keyed by op object reference
    const oldRects = new Map();
    flow.querySelectorAll('.op-block').forEach(block => {
      const idx = parseInt(block.dataset.idx);
      if (idx >= 0 && idx < prevOps.length) {
        oldRects.set(prevOps[idx], block.getBoundingClientRect());
      }
    });

    // Rebuild DOM (destroys old blocks)
    rebuildFlowPreview(newOps);

    // LAST + INVERT + PLAY
    flow.querySelectorAll('.op-block').forEach(block => {
      const idx = parseInt(block.dataset.idx);
      if (idx >= 0 && idx < newOps.length) {
        const oldRect = oldRects.get(newOps[idx]);
        if (oldRect) {
          const newRect = block.getBoundingClientRect();
          const dx = oldRect.left - newRect.left;
          if (Math.abs(dx) > 1) {
            block.style.transform = `translateX(${dx}px)`;
            block.style.transition = 'none';
            block.offsetHeight; // force reflow
            block.style.transition = 'transform 0.2s ease-out';
            block.style.transform = '';
            block.addEventListener('transitionend', () => {
              block.style.transition = '';
            }, { once: true });
          }
        }
      }
    });
  }

  // ---- Pointer-event drag system (iOS-like) ----
  const _isMobile = document.body.classList.contains('mobile');
  const _trashZone = document.getElementById('trash-zone');

  function onDragMove(e) {
    if (dragSrcIdx === null || !dragClone) return;
    dragClone.style.left = (e.clientX - dragOffsetX) + "px";
    dragClone.style.top = (e.clientY - dragOffsetY) + "px";

    // Mobile: check if over trash zone (bottom of screen)
    if (_isMobile && _trashZone) {
      const trashRect = _trashZone.getBoundingClientRect();
      const overTrash = e.clientY > trashRect.top;
      _trashZone.classList.toggle('hovering', overTrash);
    }

    // Hit test: temporarily hide clone to see what's underneath
    dragClone.style.display = "none";
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    dragClone.style.display = "";
    const target = hit?.closest(".op-block");
    if (target && target.dataset.idx !== undefined) {
      const dstIdx = parseInt(target.dataset.idx);
      if (dstIdx !== dragCurrIdx && Date.now() - dragSwapTime > 200) {
        const prevOps = dragPreviewOps || state.ops;
        // Always build from original state.ops
        const preview = [...state.ops];
        const [moved] = preview.splice(dragSrcIdx, 1);
        preview.splice(dstIdx, 0, moved);
        dragPreviewOps = preview;
        dragCurrIdx = dstIdx;
        dragSwapTime = Date.now();
        animatedRebuildFlowPreview(preview, prevOps);
        // Live-preview the reordered graph
        try {
          const previewSteps = rebuildStepsFromOps(preview);
          state.steps = previewSteps;
          state.fn = previewSteps.length > 0 ? previewSteps[previewSteps.length - 1].fn : null;
        } catch { /* keep old graph on error */ }
      }
    }
  }

  function onDragEnd(e) {
    document.removeEventListener("pointermove", onDragMove);
    document.removeEventListener("pointerup", onDragEnd);

    // Mobile: check if dropped on trash zone (bottom of screen)
    let deletedByTrash = false;
    if (_isMobile && _trashZone && dragSrcIdx !== null) {
      const trashRect = _trashZone.getBoundingClientRect();
      const dropY = e?.clientY ?? Infinity;
      if (dropY <= window.innerHeight && dropY > trashRect.top && _trashZone.classList.contains('hovering')) {
        deletedByTrash = true;
        const idx = dragSrcIdx;
        state.ops.splice(idx, 1);
        state.stepEyes.ops.splice(idx, 1);
        applyOpsChange();
      }
      _trashZone.classList.remove('visible', 'hovering');
      // Restore toolbox visibility
      const toolboxWrap = document.querySelector('.toolbox-wrapper');
      if (toolboxWrap) toolboxWrap.style.visibility = '';
    }

    if (dragClone) { dragClone.remove(); dragClone = null; }

    if (!deletedByTrash) {
      // Only apply reorder if item actually moved from its original position
      if (dragPreviewOps && dragCurrIdx !== dragSrcIdx) {
        state.ops = dragPreviewOps;
        dragPreviewOps = null;
        dragSrcIdx = null;
        dragCurrIdx = null;
        try {
          const steps = rebuildStepsFromOps(state.ops);
          state.steps = steps;
          state.fn = steps.length > 0 ? steps[steps.length - 1].fn : null;
          syncInputFromOps();
          setStatusForCurrentMode();
        } catch (err) {
          setStatus(err?.message ?? String(err), "error");
        }
      } else {
        // Dropped in original position or never moved — restore original graph
        if (dragPreviewOps) {
          try {
            const steps = rebuildStepsFromOps(state.ops);
            state.steps = steps;
            state.fn = steps.length > 0 ? steps[steps.length - 1].fn : null;
          } catch { /* ignore */ }
        }
        dragPreviewOps = null;
        dragSrcIdx = null;
        dragCurrIdx = null;
      }
    } else {
      dragPreviewOps = null;
      dragSrcIdx = null;
      dragCurrIdx = null;
    }
    renderStepRepresentation();
  }

  function attachDragHandlers(opBlock) {
    opBlock.style.touchAction = "none"; // prevent touch scroll interference

    // ---- Swipe-down-to-swap gesture (mobile) ----
    if (_isMobile) {
      let swipeStartY = null;
      let swipeStartX = null;
      let swipeTriggered = false;

      opBlock.addEventListener("pointerdown", (e) => {
        if (e.target.closest('.eye-btn') || e.target.closest('.op-block__val')) return;
        swipeStartY = e.clientY;
        swipeStartX = e.clientX;
        swipeTriggered = false;
      });

      const onSwipeMove = (e) => {
        if (swipeStartY === null || swipeTriggered) return;
        const dy = e.clientY - swipeStartY;
        const dx = Math.abs(e.clientX - swipeStartX);
        // Swipe down: vertical movement > 30px, more vertical than horizontal
        if (dy > 30 && dy > dx * 1.5) {
          swipeTriggered = true;
          const idx = parseInt(opBlock.dataset.idx);
          const swapped = swapOp(state.ops[idx]);
          if (swapped) {
            state.ops[idx] = swapped;
            applyOpsChange();
            // Brief flash feedback
            opBlock.style.transition = 'transform 0.15s';
            opBlock.style.transform = 'translateY(4px)';
            setTimeout(() => { opBlock.style.transform = ''; }, 150);
          }
          swipeStartY = null;
        }
      };

      opBlock.addEventListener("pointermove", onSwipeMove);
      opBlock.addEventListener("pointerup", () => { swipeStartY = null; });
      opBlock.addEventListener("pointercancel", () => { swipeStartY = null; });
    }

    // ---- Drag-to-reorder (+ drag-to-trash on mobile) ----
    opBlock.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.op-block__swap')) return;
      if (e.target.closest('.op-block__delete')) return;
      if (e.target.closest('.eye-btn')) return;
      if (e.target.closest('.op-block__val')) return;
      e.preventDefault();
      e.stopPropagation();

      // On mobile, use a hold delay to distinguish tap/swipe from drag
      if (_isMobile) {
        const holdTimer = setTimeout(() => {
          startDrag(e);
        }, 250); // 250ms hold to start drag

        const abortHold = () => {
          clearTimeout(holdTimer);
          opBlock.removeEventListener('pointermove', checkHoldAbort);
          opBlock.removeEventListener('pointerup', abortHold);
          opBlock.removeEventListener('pointercancel', abortHold);
        };
        const checkHoldAbort = (me) => {
          // If moved too much before hold timer, cancel drag (allow swipe)
          const dx = Math.abs(me.clientX - e.clientX);
          const dy = Math.abs(me.clientY - e.clientY);
          if (dx > 8 || dy > 8) abortHold();
        };
        opBlock.addEventListener('pointermove', checkHoldAbort);
        opBlock.addEventListener('pointerup', abortHold);
        opBlock.addEventListener('pointercancel', abortHold);
      } else {
        startDrag(e);
      }

      function startDrag(startEvt) {
        dragSrcIdx = parseInt(opBlock.dataset.idx);
        dragCurrIdx = dragSrcIdx;
        dragPreviewOps = null;
        const rect = opBlock.getBoundingClientRect();
        dragOffsetX = startEvt.clientX - rect.left;
        dragOffsetY = startEvt.clientY - rect.top;
        // Create a floating clone
        dragClone = opBlock.cloneNode(true);
        dragClone.style.cssText =
          "position:fixed;z-index:9999;pointer-events:none;" +
          "width:" + rect.width + "px;height:" + rect.height + "px;" +
          "left:" + rect.left + "px;top:" + rect.top + "px;" +
          "opacity:0.92;box-shadow:0 10px 30px rgba(0,0,0,0.35);" +
          "transform:scale(1.06);transition:none;border-radius:6px;" +
          "font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono','Courier New',monospace;font-size:0.9rem;";
        document.body.appendChild(dragClone);
        opBlock.classList.add("op-block--dragging");
        // Show trash zone on mobile (overlays toolbox area)
        if (_isMobile && _trashZone) {
          _trashZone.classList.add('visible');
          // Hide toolbox content but keep space (visibility:hidden preserves layout)
          const toolboxWrap = document.querySelector('.toolbox-wrapper');
          if (toolboxWrap) toolboxWrap.style.visibility = 'hidden';
        }
        document.addEventListener("pointermove", onDragMove);
        document.addEventListener("pointerup", onDragEnd);
      }
    });
  }

  for (let i = 0; i < ops.length; i++) {
    flow.appendChild(makeArrowCol());
    if (state.stepEyeMode) {
      // In eye mode: op-block just contains a large eye toggle
      const cat = getOpCategory(ops[i]);
      const eyeBlock = document.createElement("div");
      eyeBlock.className = "op-block op-block--" + cat + " op-block--eye-mode";
      eyeBlock.dataset.idx = String(i);
      eyeBlock.appendChild(createEyeBtn(String(i), state.stepEyes.ops[i]));
      flow.appendChild(wrapWithEye(eyeBlock, String(i), state.stepEyes.ops[i]));
    } else {
      const opBlock = buildOpBlock(ops[i], i);
      attachDragHandlers(opBlock);
      flow.appendChild(wrapWithEye(opBlock, String(i), state.stepEyes.ops[i]));
    }
  }

  // Final arrow column
  flow.appendChild(makeArrowCol());

  // y endpoint
  const yBox = document.createElement("div");
  yBox.className = "step-endpoint step-box--y";
  yBox.dataset.liveRole = "y";
  if (state.stepEyeMode) {
    yBox.appendChild(createEyeBtn("y", state.stepEyes.y));
    yBox.classList.add("step-endpoint--eye-mode");
  } else {
    yBox.textContent = "y";
  }
  flow.appendChild(wrapWithEye(yBox, "y", state.stepEyes.y));

  el.appendChild(flow);
}

/**
 * Live-update the step-flow UI with computed values at the cursor's x.
 * When xVal is null (cursor off canvas), revert to default labels.
 */
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

function updateLiveOpValues(xVal) {
  const flow = document.querySelector('.step-flow');
  if (!flow) return;

  const xEl = flow.querySelector('[data-live-role="x"]');
  const yEl = flow.querySelector('[data-live-role="y"]');
  const opBlocks = flow.querySelectorAll('.op-block');
  const arrowCols = flow.querySelectorAll('.step-arrows-col');

  if (xVal === null || !state.fn) {
    // Revert text to defaults (but keep connector colors)
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
    // Revert input overlay
    updateInputOverlay();
    return;
  }

  // Compute values through the forward chain
  const steps = state.steps;
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

  // Update the text input box with live values
  updateLiveInputOverlay(xVal, values);
}

/**
 * Update the input text overlay with live computed values.
 * Replaces 'x' with the current value and shows the result.
 */
function updateLiveInputOverlay(xVal, values) {
  if (!ui.exprOverlay || !ui.exprEl) return;
  if (!state.displaySpans || !state.displaySpans.length) return;

  const controlEl = ui.exprEl.closest('.control--expr');
  const yVal = values[values.length - 1];
  const xStr = formatLiveX(xVal);
  const yStr = Number.isFinite(yVal) ? formatLiveNumber(yVal) : '\u2014';

  // Rebuild the overlay from displaySpans, replacing 'x' with the live value
  const html = state.displaySpans.map(s => {
    const opacity = s.isBracket ? 0.35 : 1;
    if (s.text === 'x') {
      return '<span style="color:' + OP_COLORS.x + ';opacity:' + opacity + '">' + escapeHtml(xStr) + '</span>';
    }
    return '<span style="color:' + s.color + ';opacity:' + opacity + '">' + escapeHtml(s.text) + '</span>';
  }).join('');

  // Append " = yVal" in y-color
  const lastHex = state.ops.length > 0
    ? (OP_COLORS[getOpCategory(state.ops[state.ops.length - 1])] || OP_COLORS.misc)
    : OP_COLORS.x;
  const suffix = '<span style="color:var(--muted);opacity:0.5"> = </span><span style="color:' + OP_COLORS.y + '">' + escapeHtml(yStr) + '</span>';

  ui.exprOverlay.innerHTML = html + suffix;
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
  el.style.width = Math.max(180, needed + 32, overlayContentW + 20) + 'px';
}

function liveParse() {
  const expr = ui.exprEl?.value ?? "";
  if (!expr.trim()) {
    state.fn = null;
    state.steps = [];
    state.ops = [];
    state.displaySpans = null;
    state.usesT = false;
    updateTimelineVisibility();
    renderStepRepresentation();
    updateInputOverlay();
    setStatus("", "info");
    return;
  }
  try {
    const fn = compileExpression(expr);
    state.fn = fn;
    state.lastExpr = expr;
    const { steps, ops } = parseAndLinearize(expr);
    state.steps = steps;
    state.ops = ops;
    state.stepEyes.ops = ops.map(() => true);
    // Detect t usage
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
  const expr = ui.exprEl?.value ?? "";
  try {
    const fn = compileExpression(expr);
    state.fn = fn;
    state.lastExpr = expr;
    const { steps, ops } = parseAndLinearize(expr);
    state.steps = steps;
    state.ops = ops;
    state.stepEyes.ops = ops.map(() => true);
    // Detect t usage
    const normalized = expr.replace(/\s+/g, "");
    state.usesT = /\bt\b/.test(normalized);
    updateTimelineVisibility();
    renderStepRepresentation();
    setStatusForCurrentMode();
    if (ops.length > 0) {
      const { text, spans } = buildDisplayExpr(ops);
      state.displaySpans = spans;
      ui.exprEl.value = text;
      state.lastExpr = text;
    } else {
      state.displaySpans = null;
    }
    updateInputOverlay();
    if (!state.hasPlotted) {
      state.hasPlotted = true;
      if (ui.infoBtn) ui.infoBtn.style.display = "";
    }
  } catch (err) {
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
    const positionOverlay = () => {
      const ctrlRect = controlLabel.getBoundingClientRect();
      const inputRect = ui.exprEl.getBoundingClientRect();
      const leftOffset = inputRect.left - ctrlRect.left;
      overlay.style.left = leftOffset + "px";
      overlay.style.right = "0";
    };
    positionOverlay();
    window.addEventListener("resize", positionOverlay);

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

  // Create reset view overlay button (will be placed inside toggle bar)
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

  // ---- Mobile: eye-icon visibility toggle panel ----
  setupMobileTogglePanel();

  // ---- Mobile: touch handlers for pinch-zoom and drag-pan ----
  setupTouchHandlers();

  // ---- Mobile: topbar collapse, pseudo-fullscreen, tap-to-show, bar positioning ----
  setupMobileBarControls();

  // ---- HUD overlay (top-right, below topbar) ----
  const hudEl = document.createElement("div");
  hudEl.className = "graph-hud";
  hudEl.id = "graph-hud";
  document.body.appendChild(hudEl);
  ui.hudEl = hudEl;

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
      label: item.fn + "()",
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

    const rect = el.getBoundingClientRect();
    ghost.style.cssText =
      "position:fixed;z-index:9999;pointer-events:none;" +
      "left:" + rect.left + "px;top:" + rect.top + "px;" +
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
      applyOpsChange();
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });
}

/* ========== Fullscreen button ========== */

function setupFullscreenButton() {
  const btn = document.getElementById("fullscreen-btn");
  if (!btn) return;

  const expandSVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
  const compressSVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';

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

  btn.innerHTML = expandSVG;

  btn.addEventListener("click", () => {
    if (!getFS()) {
      requestFS(document.documentElement).catch(() => {
        // iOS Safari: no fullscreen API — try scrolling to hide address bar
        window.scrollTo(0, 1);
      });
    } else {
      exitFS().catch(() => {});
    }
  });

  // Listen for all vendor-prefixed fullscreenchange events
  ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach(evt => {
    document.addEventListener(evt, () => {
      btn.innerHTML = getFS() ? compressSVG : expandSVG;
    });
  });
}

/* ========== Settings gear (FMTTM-style) ========== */

function setupSettingsGear() {
  const gear = document.getElementById("settingsGear");
  const menu = document.getElementById("settingsMenu");
  if (!gear || !menu) return;

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

  // Hover behavior with delay
  const hoverZone = [gear, menu];
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
    // RGB → HSL
    const r1 = r / 255, g1 = g / 255, b1 = b / 255;
    const mx = Math.max(r1, g1, b1), mn = Math.min(r1, g1, b1);
    let h = 0, s = 0, l = (mx + mn) / 2;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r1) h = ((g1 - b1) / d + (g1 < b1 ? 6 : 0)) / 6;
      else if (mx === g1) h = ((b1 - r1) / d + 2) / 6;
      else h = ((r1 - g1) / d + 4) / 6;
    }
    const hDeg = Math.round(h * 360);
    // Accent: same hue, moderate sat, brighter
    const accentS = Math.max(35, Math.min(55, Math.round(s * 100 * 1.2)));
    const accentL = state.lightMode ? 38 : 62;
    const toggleA = state.lightMode ? 0.22 : 0.4;
    const toggleTxtL = state.lightMode ? 28 : 90;
    const glowA = state.lightMode ? 0.1 : 0.15;
    document.body.style.setProperty("--accent", `hsl(${hDeg}, ${accentS}%, ${accentL}%)`);
    document.body.style.setProperty("--toggle-active-bg", `hsla(${hDeg}, ${accentS}%, ${accentL}%, ${toggleA})`);
    document.body.style.setProperty("--toggle-active-color", `hsl(${hDeg}, ${accentS}%, ${toggleTxtL}%)`);
    document.body.style.setProperty("--toggle-glow-bg", `hsla(${hDeg}, ${accentS}%, ${accentL}%, ${glowA})`);
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
      const r = parseInt(col.slice(1,3),16), g = parseInt(col.slice(3,5),16), b = parseInt(col.slice(5,7),16);
      state.bgColorRGB = [r, g, b];
      // Only apply CSS overrides in light mode — dark mode uses its own palette
      if (state.lightMode) {
        document.body.style.setProperty("--body-bg", col);
        document.body.style.setProperty("--panel", col);
        document.body.style.setProperty("--panel2", col);
        document.body.style.setProperty("--settings-menu-bg", col);
        document.body.style.setProperty("--glass-bg", `rgba(${r},${g},${b},0.55)`);
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
      document.body.style.removeProperty("--topbar-bg");
      clearAccentOverrides();
    }
    try { localStorage.setItem("gc-bg-color", id); } catch { }
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
          const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
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

  // Reset button inside bar (positioned absolutely via CSS)
  if (ui.resetOverlay) {
    bar.appendChild(ui.resetOverlay);
  }
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
            const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
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
  const els = [topbar, toggles, settingsMenu, modeOverlay, timelineCtrl, mobilePanel, mobileEye, settingsGear, trashZoneEl];
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
  state.isPanning = false;
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
  drawingContext.shadowColor = 'rgba(255, 255, 255, 0.6)';
  drawingContext.shadowBlur = 18;

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

  drawingContext.shadowBlur = 0;

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
    pd * view.scale * cosθ,               -pd * view.scale * sinθ,
    -pd * view.scale * sinθ * yRatio,     -pd * view.scale * cosθ * yRatio,
    pd * view.originX,                     pd * view.originY
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
    const mutedHex = getComputedStyle(document.body).getPropertyValue('--muted').trim();
    const m = mutedHex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    gutR = m ? parseInt(m[1],16) : 90;
    gutG = m ? parseInt(m[2],16) : 98;
    gutB = m ? parseInt(m[3],16) : 120;
  } else {
    inR = 18; inG = 20; inB = 28;
    gutR = 0; gutG = 0; gutB = 0;
  }

  const numerals = state.numeralMode;

  // 4a. Gutter fill: cover entire visible grid area with gutter color (light mode)
  if (state.lightMode) {
    ctx.fillStyle = `rgb(${gutR},${gutG},${gutB})`;
    const gutLeft = ix0 * xStep - xStep / 2;
    const gutW = (ix1 - ix0 + 1) * xStep;
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
    ctx.fillRect(ix * xStep - xStep / 2 + mx, stripBot, cellW, stripH);
  }

  // 4a2. Carve horizontal gap bands between rows (O(rows)) for y-margin
  if (my > 0) {
    ctx.fillStyle = `rgb(${gutR},${gutG},${gutB})`;
    const bandLeft = ix0 * xStep - xStep / 2;
    const bandW = (ix1 - ix0 + 1) * xStep;
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
              ix * xStep - xStep / 2 + mx,
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
            ix * xStep - xStep / 2 + mx,
            worldY - r,
            cellW, 2 * r
          );
        } else {
          ctx.drawImage(gc, 0, 0, 1, glowCanvasH,
            ix * xStep - xStep / 2 + mx,
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
            ix * xStep - xStep / 2 + mx,
            -r,
            cellW, 2 * r
          );
        } else {
          ctx.drawImage(gc, 0, 0, 1, glowCanvasH,
            ix * xStep - xStep / 2 + mx,
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
        fr = fr * 0.7 + 255 * 0.3;
        fg = fg * 0.7 + 255 * 0.3;
        fb = fb * 0.7 + 255 * 0.3;
      }
      // Brighten at grid ticks (lerp toward white, preserving hue)
      const gBoost = gridBoostMap.get(px.ix) || 0;
      if (gBoost > 0) {
        const t = gBoost * 0.5;
        fr = fr + (255 - fr) * t;
        fg = fg + (255 - fg) * t;
        fb = fb + (255 - fb) * t;
      }
      ctx.fillStyle = `rgb(${Math.round(fr)},${Math.round(fg)},${Math.round(fb)})`;
      ctx.fillRect(
        px.ix * xStep - xStep / 2 + mx,
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
    const DOT_SQ   = 0.35;
    const DEC_SQ   = 0.85;

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
      state._numAtlas    = document.createElement('canvas');
      state._numAtlasCtx = state._numAtlas.getContext('2d');
      state._numTint     = document.createElement('canvas');
      state._numTintCtx  = state._numTint.getContext('2d');
    }
    const aCvs = state._numAtlas, aCtx = state._numAtlasCtx;
    const tCvs = state._numTint,  tCtx = state._numTintCtx;
    const _nRows = rowCache.size;
    const _needH = _atlasRowDH * _nRows;
    if (aCvs.width < _maxDW || aCvs.height < _needH) {
      aCvs.width  = Math.max(aCvs.width,  _maxDW);
      aCvs.height = Math.max(aCvs.height, _needH);
    }
    aCtx.clearRect(0, 0, _maxDW, _needH);
    aCtx.font         = boldFont;
    aCtx.textAlign    = 'center';
    aCtx.textBaseline = 'middle';
    aCtx.fillStyle    = '#fff';
    // Tint canvas must cover full atlas for batch tinting
    if (tCvs.width < _maxDW || tCvs.height < _needH) {
      tCvs.width  = Math.max(tCvs.width,  _maxDW);
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
      if (glowTintN) { fr = fr*0.7+255*0.3; fg = fg*0.7+255*0.3; fb = fb*0.7+255*0.3; }
      const gBoost = gridBoostMap.get(px.ix) || 0;
      if (gBoost > 0) {
        const t = gBoost * 0.5;
        fr = fr + (255 - fr) * t;
        fg = fg + (255 - fg) * t;
        fb = fb + (255 - fb) * t;
      }
      activeColors.set(key, { r: Math.round(fr), g: Math.round(fg), b: Math.round(fb) });
    }

    // --- Rendering: batch by color, tint atlas once per unique color ---

    // Collect all cells grouped by color (inactive first, active second for z-order)
    const inactiveBatches = new Map(); // colorKey → { r,g,b, cells:[] }
    const activeBatches   = new Map();

    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        const key = ix * 131072 + iy;
        if (activeColors.has(key)) continue;
        const tc = transformColors.get(key);
        let cr, cg, cb;
        if (tc) {
          const blend = state.lightMode ? 0.65 : 0.55;
          cr = Math.round(gutR + (tc.r - gutR) * blend);
          cg = Math.round(gutG + (tc.g - gutG) * blend);
          cb = Math.round(gutB + (tc.b - gutB) * blend);
        } else {
          cr = gutR; cg = gutG; cb = gutB;
        }
        const ck = (cr << 16) | (cg << 8) | cb;
        if (!inactiveBatches.has(ck)) inactiveBatches.set(ck, { r: cr, g: cg, b: cb, cells: [] });
        const scr = worldToScreen(ix * xStep, iy * yStep * yRatio);
        inactiveBatches.get(ck).cells.push({ iy, x: scr.x, y: scr.y });
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
          const scr = worldToScreen(ix * xStep, iy * yStep * yRatio);
          activeBatches.get(ck).cells.push({ iy, x: scr.x, y: scr.y });
        }
      }
    }

    // Draw inactive batches (tint atlas once per color, stamp all cells)
    for (const batch of inactiveBatches.values()) {
      tintAtlas(batch.r, batch.g, batch.b);
      for (const c of batch.cells) stampTinted(c.iy, c.x, c.y);
    }
    // Draw active batches on top
    for (const batch of activeBatches.values()) {
      tintAtlas(batch.r, batch.g, batch.b);
      for (const c of batch.cells) stampTinted(c.iy, c.x, c.y);
    }

    ctx.restore();
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
    // Fill gutter background (muted/text color)
    const mutedHex = getComputedStyle(document.body).getPropertyValue('--muted').trim();
    const m = mutedHex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    const gutR = m ? parseInt(m[1],16) : 90;
    const gutG = m ? parseInt(m[2],16) : 98;
    const gutB = m ? parseInt(m[3],16) : 120;
    ctx.fillStyle = `rgb(${gutR},${gutG},${gutB})`;
    const gutLeft = ix0 * xStep - xStep / 2;
    const gutW = (ix1 - ix0 + 1) * xStep;
    ctx.fillRect(gutLeft, minY, gutW, maxY - minY);
  } else {
    inR = 18; inG = 20; inB = 28;
  }

  // Draw column strips (inactive tint)
  ctx.fillStyle = `rgb(${inR},${inG},${inB})`;
  for (let ix = ix0; ix <= ix1; ix++) {
    ctx.fillRect(ix * xStep - xStep / 2 + mx, minY, cellW, maxY - minY);
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
          const left = ix * xStep - xStep / 2 + mx;
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
      const left = ix * xStep - xStep / 2 + mx;
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
      const left = ix * xStep - xStep / 2 + mx;
      const gBoost = gridBoostMap.get(ix) || 0;
      if (gBoost > 0) {
        const t = gBoost * 0.5;
        const br = Math.round(colR + (255 - colR) * t);
        const bg = Math.round(colG + (255 - colG) * t);
        const bb = Math.round(colB + (255 - colB) * t);
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
          const left = ix * xStep - xStep / 2 + mx;

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
                const left = ix * xStep - xStep / 2 + mx;
                const gBoost = gridBoostMap.get(ix) || 0;
                if (gBoost > 0) {
                  const t = gBoost * 0.5;
                  const bsr = Math.round(sr + (255 - sr) * t);
                  const bsg = Math.round(sg + (255 - sg) * t);
                  const bsb = Math.round(sb + (255 - sb) * t);
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
        const left = ix * xStep - xStep / 2 + mx;
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
        const hr = 255 * 0.8 + cr * 0.2, hg = 255 * 0.8 + cg * 0.2, hb = 255 * 0.8 + cb * 0.2;
        const hlThick = 1.5 / view.scale;
        for (let ix = ix0; ix <= ix1; ix++) {
          const cx = ix * xStep * eS;
          let fy;
          try { fy = evalFn(cx); } catch { continue; }
          if (!Number.isFinite(fy)) continue;
          if (isDelta) fy = fy - cx;
          if (!Number.isFinite(fy)) continue;
          const left = ix * xStep - xStep / 2 + mx;
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
    const DOT_SQ_DX   = 0.35;
    const DEC_SQ_DX   = 0.85;

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
        if (isDelta) fy = fy - cx;
        if (!Number.isFinite(fy)) continue;

        const gBoost = gridBoostMap.get(ix) || 0;
        let fr = colR, fg = colG, fb = colB;
        if (state.glowCurves) { fr = fr*0.7+255*0.3; fg = fg*0.7+255*0.3; fb = fb*0.7+255*0.3; }
        if (gBoost > 0) {
          const t = gBoost * 0.5;
          fr = fr + (255 - fr) * t; fg = fg + (255 - fg) * t; fb = fb + (255 - fb) * t;
        }

        const absVal = Math.abs(fy);
        let text;
        if (absVal >= 100) text = Math.round(absVal).toString();
        else if (absVal >= 10) text = Math.round(absVal).toString();
        else if (absVal < 0.05) text = '0';
        else text = absVal.toFixed(1);
        const isNeg = fy < 0;
        const layout = buildLayout(text, isNeg);
        const scr = worldToScreen(ix * xStep, fy);
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
        state._numAtlas    = document.createElement('canvas');
        state._numAtlasCtx = state._numAtlas.getContext('2d');
        state._numTint     = document.createElement('canvas');
        state._numTintCtx  = state._numTint.getContext('2d');
      }
      const aCvs = state._numAtlas, aCtx = state._numAtlasCtx;
      const tCvs = state._numTint,  tCtx = state._numTintCtx;
      const _nTxt = uniqueTexts.size;
      const _needH = _rowDH * _nTxt;
      if (aCvs.width < _maxDW || aCvs.height < _needH) {
        aCvs.width  = Math.max(aCvs.width,  _maxDW);
        aCvs.height = Math.max(aCvs.height, _needH);
      }
      aCtx.clearRect(0, 0, _maxDW, _needH);
      aCtx.font         = boldFontDX;
      aCtx.textAlign    = 'center';
      aCtx.textBaseline = 'middle';
      aCtx.fillStyle    = '#fff';
      // Tint canvas must cover full atlas for batch tinting
      if (tCvs.width < _maxDW || tCvs.height < _needH) {
        tCvs.width  = Math.max(tCvs.width,  _maxDW);
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
    mouseX = savedMX;
    mouseY = savedMY;
  } else {
    document.body.style.cursor = '';
    updateLiveOpValues(null);
  }

  // ---- HUD overlay (HTML element) ----
  if (ui.hudEl) {
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

