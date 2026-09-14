/* =========================================================================
   Lexis Bar Engine — shared interactive for the Life Expectancy essay
   ---------------------------------------------------------------------
   A plain square grid: x = calendar year, y = age, both in 5-year steps.
   Each birth cohort is drawn as a single 45° bar cutting across the grid
   (year and age always advance together, so the bar is exactly diagonal).
   The bar's width at each step is the surviving fraction of that cohort;
   within each year-age cell the bar is drawn at the width it ENTERED the
   cell with, split into a green (surviving to the next cell) core and a
   red/fading outer edge (those who die during that cell) — so the loss is
   visible for one step before the bar actually narrows.

   Usage (see example1.js / lexis-hex-example1.html):
     const engine = new LexisHexEngine(config);
     await engine.load();       // fetches the life-table JSON, runs the sim
     engine.attachP5(p5GlobalFns); // wires mouse/touch/wheel handlers
     // in draw(): engine.draw();
     // in windowResized(): engine.resize(width, height);

   Config shape — see DEFAULT_CONFIG below for all fields and defaults.
   ========================================================================= */

(function (global) {
  'use strict';

  const DEFAULT_CONFIG = {
    dataUrl: 'data/au_life_table.json',
    presentYear: 2026,
    minBirthYear: 1890,
    maxBirthYear: 2026,
    resolution: 10, // Default resolution: 10-Year steps (can be 1, 5, or 10)
    cellSize: 24, // width/height of 1 calendar year x 1 age step in world units
    colors: {
      gridLine: 'rgba(0,0,0,0.12)',
      gridLineDark: 'rgba(255,255,255,0.12)',
      yearHighlight: 'rgba(255, 179, 0, 0.14)',
      ageHighlight: 'rgba(0, 149, 255, 0.14)',
      cohortHighlightStroke: '#ffffff',
      axisText: 'rgba(0,0,0,0.65)',
      axisTextDark: 'rgba(255,255,255,0.7)',
      axisBg: 'rgba(240,240,240,0.95)',
      axisBgDark: 'rgba(22,22,22,0.95)',
    },
    // Initial pan/zoom
    initialView: { centerYear: 1970, centerAge: 40, scale: 1.2 },
    minScale: 0.05,
    maxScale: 6,
    axisMarginTop: 24,
    axisMarginLeft: 36,
    axisMarginBottom: 26,
    axisFontSize: 11,
    minLabelSpacingPx: 45,
  };

  function hslToRgb(h, s, l, a = 1.0) {
    h = ((h % 360) + 360) % 360;
    s = Math.max(0, Math.min(1, s));
    l = Math.max(0, Math.min(1, l));
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }
    return [
      Math.round((r + m) * 255),
      Math.round((g + m) * 255),
      Math.round((b + m) * 255),
      Math.round(a * 255)
    ];
  }

  // Map age-specific mortality rate q_x to a color theme using a LOGARITHMIC scale.
  // Mortality q_x ranges from ~0.0001 (youth) to ~0.50 (extreme old age).
  // On a log scale:
  //   q_x ~ 0.0001 -> Deep Indigo (240°)
  //   q_x ~ 0.0005 -> Cyan (195°)
  //   q_x ~ 0.002  -> Emerald Green (156°)
  //   q_x ~ 0.01   -> Lime / Yellow (110°)
  //   q_x ~ 0.05   -> Gold / Orange (65°)
  //   q_x ~ 0.20   -> Bright Orange-Red (26°)
  //   q_x ~ 0.50   -> Crimson (0°)
  // Within each cell:
  //   surviving : rich, saturated mid-tone (L = 45%, 100% opaque)
  //   dying     : bright, glowing highlight (L = 72%, 100% opaque)
  //   dead      : deep, dark shade (L = 15%, 100% opaque)
  function getMortalityColors(q) {
    const qMin = 0.0001;
    const qMax = 0.50;
    const logMin = Math.log10(qMin);
    const logMax = Math.log10(qMax);
    const logQ = Math.log10(Math.max(qMin, Math.min(qMax, q)));
    const t = Math.max(0, Math.min(1, (logQ - logMin) / (logMax - logMin)));

    const hue = 240 * (1 - t);

    return {
      surviving: hslToRgb(hue, 0.75, 0.45, 1.0),
      dying: hslToRgb(hue, 1.00, 0.72, 1.0),
      dead: hslToRgb(hue, 0.72, 0.36, 1.0),
      label: hslToRgb(hue, 0.95, 0.85, 1.0),
    };
  }

  class LexisHexEngine {
    constructor(config) {
      this.config = Object.assign({}, DEFAULT_CONFIG, config || {},
        { colors: Object.assign({}, DEFAULT_CONFIG.colors, (config && config.colors) || {}) });
      this.resolution = this.config.resolution || 10;
      this.data = null;
      this.cohorts = null; // cohorts[b] = { birthYear, cells: [{age, year, S_start, S_end, qx, R}, ...] }
      this.view = { x: 0, y: 0, scale: 1 };
      this.canvasW = 0;
      this.canvasH = 0;
      this._drag = null;
      this._pinch = null;
      this.ready = false;
      this.hover = null; // {year, age, birthYear, R} of cell under pointer
    }

    setResolution(res) {
      if (this.resolution === res) return;
      this.resolution = res;
      if (this.data) {
        this._simulate();
        if (this.p) this.p.redraw();
      }
    }

    async load() {
      const res = await fetch(this.config.dataUrl);
      this.data = await res.json();
      this._simulate();
      this._initView();
      this.ready = true;
    }

    _getSingleQx(year, age) {
      const { singleYears, singleQx } = this.data;
      const clampedYear = Math.max(singleYears[0], Math.min(singleYears[singleYears.length - 1], year));
      const clampedAge = Math.max(0, Math.min(100, age));
      const yIdx = clampedYear - singleYears[0];
      return singleQx[yIdx][clampedAge];
    }

    _getCohortSurvival(birthYear, age) {
      const { singleYears, singleQx } = this.data;
      const presentYear = this.config.presentYear;
      if (age <= 0) return 1.0;
      if (birthYear + age > presentYear) {
        // Unobserved future age for this cohort
        // Estimate using present-day (2026) period rates
        let S = 1.0;
        for (let a = 0; a < age; a++) {
          const yr = Math.min(presentYear, birthYear + a);
          const q = this._getSingleQx(yr, a);
          S *= (1 - q);
        }
        return S;
      }
      let S = 1.0;
      for (let a = 0; a < age; a++) {
        const q = this._getSingleQx(birthYear + a, a);
        S *= (1 - q);
      }
      return S;
    }

    _getSquareQx(year, age, R) {
      let survive = 1.0;
      for (let da = 0; da < R; da++) {
        const q = this._getSingleQx(year, age + da);
        survive *= (1 - q);
      }
      const q_band = 1 - survive;
      return R > 1 ? (1 - Math.pow(1 - q_band, 1 / R)) : q_band;
    }

    // Precompute per-cohort Lexis cells according to active resolution `R` (1, 5, or 10 years).
    // Cohort birth years are anchored to the first data year (e.g. 1900, 1910, 1920 ...) so the
    // grid starts exactly where the data does and includes every observed decade.
    _simulate() {
      const R = this.resolution || 10;
      const presentYear = this.config.presentYear;
      const dataStart = this.data.singleYears[0];
      this.dataStartYear = dataStart;

      const years = [];
      for (let yr = dataStart; yr <= presentYear; yr += R) {
        years.push(yr);
      }

      this.cohorts = [];
      for (const b of years) {
        const maxAge = Math.min(100, presentYear - b);
        if (maxAge <= 0) continue;

        // Compute single-year cumulative survival for this cohort
        const S_single = [1.0];
        for (let a = 0; a < maxAge; a++) {
          const q = this._getSingleQx(b + a, a);
          S_single.push(S_single[S_single.length - 1] * (1 - q));
        }

        // Group into R-year Lexis steps
        const cells = [];
        for (let a = 0; a < maxAge; a += R) {
          const aEnd = Math.min(maxAge, a + R);
          const S_start = S_single[a];
          const S_end = S_single[aEnd];
          const stepYears = aEnd - a;
          const q_band = S_start > 0 ? (1 - S_end / S_start) : 0;
          const q_annual = stepYears > 0 ? (1 - Math.pow(1 - q_band, 1 / stepYears)) : 0;

          cells.push({
            age: a,
            year: b + a,
            S_start,
            S_end,
            qx: q_annual,
            R: stepYears,
          });
        }
        this.cohorts.push({ birthYear: b, cells });
      }

      // Precompute single-year cumulative survival for EVERY integer birth year in range.
      // cohortSurvival[birthYear][age] = fraction of the cohort still alive at exact age.
      // Only observed cells (birthYear + age <= presentYear) are computed.
      this.cohortSurvival = {};
      for (let b = dataStart; b <= presentYear; b++) {
        const maxAge = Math.min(100, presentYear - b);
        const arr = new Float64Array(maxAge + 1);
        arr[0] = 1.0;
        for (let a = 0; a < maxAge; a++) {
          arr[a + 1] = arr[a] * (1 - this._getSingleQx(b + a, a));
        }
        this.cohortSurvival[b] = arr;
      }
    }

    // Cumulative survival of birth-cohort `birthYear` to exact `age` (observed cells only).
    // Returns null if the cohort/age lies outside the observed data window.
    _cohortS(birthYear, age) {
      const arr = this.cohortSurvival[birthYear];
      if (!arr) return null;
      if (age < 0 || age >= arr.length) return null;
      return arr[age];
    }

    _initView() {
      const iv = this.config.initialView;
      const center = this._cellCenter(iv.centerYear, iv.centerAge);
      this.view.scale = iv.scale;
      this.view.x = center.x;
      this.view.y = center.y;
    }

    resize(w, h) {
      this.canvasW = w;
      this.canvasH = h;
    }

    // --- Orthogonal grid: x = calendar year, y = age (increasing upward). ---
    _cellCenter(year, age) {
      const c = this.config.cellSize;
      return { x: c * (year - 1900), y: -c * age };
    }

    _worldToScreen(x, y) {
      const cx = this.canvasW / 2, cy = this.canvasH / 2;
      return {
        x: cx + (x - this.view.x) * this.view.scale,
        y: cy + (y - this.view.y) * this.view.scale,
      };
    }

    _screenToWorld(sx, sy) {
      const cx = this.canvasW / 2, cy = this.canvasH / 2;
      return {
        x: this.view.x + (sx - cx) / this.view.scale,
        y: this.view.y + (sy - cy) / this.view.scale,
      };
    }

    _pixelToCell(sx, sy) {
      const world = this._screenToWorld(sx, sy);
      const c = this.config.cellSize;
      const R = this.resolution || 10;
      const presentYear = this.config.presentYear;
      const dataStart = this.dataStartYear;

      const yearRaw = Math.floor(world.x / c) + 1900;
      const ageRaw = Math.floor(-world.y / c);
      if (ageRaw < 0 || ageRaw > 100 || yearRaw < dataStart || yearRaw > presentYear) return null;

      const yIdx = dataStart + Math.floor((yearRaw - dataStart) / R) * R;
      const aIdx = Math.floor(ageRaw / R) * R;
      // Which triangle within the square? Split by the cohort diagonal birthYear = yIdx - aIdx.
      const worldYear = world.x / c + 1900;
      const worldAge = -world.y / c;
      const bLow = yIdx - aIdx;
      const half = (worldYear - worldAge) >= bLow ? 'low' : 'up';
      const birthYear = half === 'low' ? bLow : bLow - R;
      return { year: yIdx, age: aIdx, birthYear, half, R };
    }

    handleHover(sx, sy) {
      this.hover = this._pixelToCell(sx, sy);
    }

    handleHoverEnd() {
      this.hover = null;
    }

    // --- p5 wiring: pan (drag) + zoom (wheel / pinch). Call once with the
    // global p5 instance/window so we can read mouseX/mouseY/touches etc. ---
    attachP5(p) {
      this.p = p;
    }

    handlePressStart(x, y) {
      this._drag = { startX: x, startY: y, viewX: this.view.x, viewY: this.view.y };
    }

    handlePressMove(x, y) {
      if (!this._drag) return;
      const dx = (x - this._drag.startX) / this.view.scale;
      const dy = (y - this._drag.startY) / this.view.scale;
      this.view.x = this._drag.viewX - dx;
      this.view.y = this._drag.viewY - dy;
    }

    handlePressEnd() {
      this._drag = null;
    }

    handleWheelZoom(deltaY, x, y) {
      const before = this._screenToWorld(x, y);
      const factor = Math.exp(-deltaY * 0.001);
      this.view.scale = Math.min(this.config.maxScale, Math.max(this.config.minScale, this.view.scale * factor));
      const after = this._screenToWorld(x, y);
      this.view.x += before.x - after.x;
      this.view.y += before.y - after.y;
    }

    handlePinch(dist, midX, midY) {
      if (this._pinch == null) { this._pinch = dist; return; }
      const before = this._screenToWorld(midX, midY);
      const factor = dist / this._pinch;
      this.view.scale = Math.min(this.config.maxScale, Math.max(this.config.minScale, this.view.scale * factor));
      const after = this._screenToWorld(midX, midY);
      this.view.x += before.x - after.x;
      this.view.y += before.y - after.y;
      this._pinch = dist;
    }

    handlePinchEnd() {
      this._pinch = null;
    }

    draw() {
      const p = this.p;
      if (!this.ready || !p) return;

      p.push();
      p.background(p.color(this.config.bgColor || '#f0f0f0'));

      this._drawPeriodSquares();
      this._drawGrid();
      this._drawYearRuler();
      this._drawAgeRuler();
      this._drawCohortLabels();
      p.pop();
    }

    _drawGrid() {
      const p = this.p;
      const cSize = this.config.cellSize;
      const R = this.resolution || 10;
      const presentYear = this.config.presentYear;
      const stroke = this.config.dark ? this.config.colors.gridLineDark : this.config.colors.gridLine;
      const dataStart = this.dataStartYear;
      p.stroke(stroke);
      p.strokeWeight(1);

      // Vertical grid lines anchored to the first data year (1900)
      for (let yr = dataStart; yr <= presentYear; yr += R) {
        const x = this._worldToScreen((yr - 1900) * cSize, 0).x;
        if (x < -50 || x > this.canvasW + 50) continue;
        p.line(x, 0, x, this.canvasH);
      }

      // Horizontal grid lines for ages (0, R, 2R, ...)
      for (let a = 0; a <= 100; a += R) {
        const y = this._worldToScreen(0, -a * cSize).y;
        if (y < -50 || y > this.canvasH + 50) continue;
        p.line(0, y, this.canvasW, y);
      }
    }

    // Draw Period-Age squares [Y, Y+R] x [A, A+R] colored by period mortality rate q_x(Y, A).
    // Each square is divided by its 45° cohort diagonal (BL -> TR) into two cohort triangles:
    //   lower-right triangle (BL,BR,TR) -> cohort born Y - A
    //   upper-left  triangle (BL,TL,TR) -> cohort born Y - A - R
    // Within each triangle the cohort's survival is split by lines of constant birth-year
    // (parallel to the cohort diagonal): dead hugs the low-birth-year (upper-left) edge and
    // survivors hug the high-birth-year (lower-right) edge — so a cohort keeps a continuous,
    // straight right edge and thins inward from the top-left as it ages.
    _drawPeriodSquares() {
      const p = this.p;
      const cSize = this.config.cellSize;
      const R = this.resolution || 10;
      const presentYear = this.config.presentYear;
      const dataStart = this.dataStartYear;
      const hover = this.hover;
      const dark = this.config.dark;
      const dimCol = dark ? [20, 20, 20, 155] : [244, 244, 244, 170];

      for (let yr = dataStart; yr + R <= presentYear; yr += R) {
        for (let a = 0; a <= 100 - R; a += R) {
          // Vertices carry their world birth-year (year - age) for diagonal clipping.
          const BL = this._vtx(yr, a);
          const BR = this._vtx(yr + R, a);
          const TL = this._vtx(yr, a + R);
          const TR = this._vtx(yr + R, a + R);

          // Viewport culling
          if (Math.max(BR.x, TR.x) < -10 || Math.min(BL.x, TL.x) > this.canvasW + 10 ||
            Math.max(BL.y, BR.y) < -10 || Math.min(TL.y, TR.y) > this.canvasH + 10) continue;

          const bLow = yr - a;       // lower-right triangle cohort (band birth-years [bLow, bLow+R])
          const bUp = yr - a - R;    // upper-left triangle cohort  (band birth-years [bUp, bUp+R])

          const sLowStart = this._cohortS(bLow, a);
          const sLowEnd = this._cohortS(bLow, a + R);
          const sUpStart = this._cohortS(bUp, a);
          const sUpEnd = this._cohortS(bUp, a + R);

          const hasLow = sLowStart != null && sLowEnd != null;
          const hasUp = sUpStart != null && sUpEnd != null;
          if (!hasLow && !hasUp) continue;

          const qx = this._getSquareQx(yr, a, R);
          const mCols = getMortalityColors(qx);
          const cellWidth = Math.abs(BR.x - BL.x);

          if (hasLow) this._fillCohortTriangle([BL, BR, TR], bLow, R, sLowStart, sLowEnd, mCols, cellWidth);
          if (hasUp) this._fillCohortTriangle([BL, TL, TR], bUp, R, sUpStart, sUpEnd, mCols, cellWidth);

          // Hover: keep triangles that share the pointer's cohort, year OR age; dim the rest.
          let lowBright = true, upBright = true;
          if (hover) {
            lowBright = bLow === hover.birthYear || yr === hover.year || a === hover.age;
            upBright = bUp === hover.birthYear || yr === hover.year || a === hover.age;
            const outlineW = Math.max(0.5, Math.min(2.4, cellWidth * 0.05));
            if (hasLow && !lowBright) { p.noStroke(); p.fill(...dimCol); p.triangle(BL.x, BL.y, BR.x, BR.y, TR.x, TR.y); }
            if (hasUp && !upBright) { p.noStroke(); p.fill(...dimCol); p.triangle(BL.x, BL.y, TL.x, TL.y, TR.x, TR.y); }
            if (hasLow && hover.year === yr && hover.age === a && hover.half === 'low') {
              p.noFill(); p.stroke('#ffffff'); p.strokeWeight(outlineW);
              p.triangle(BL.x, BL.y, BR.x, BR.y, TR.x, TR.y);
            }
            if (hasUp && hover.year === yr && hover.age === a && hover.half === 'up') {
              p.noFill(); p.stroke('#ffffff'); p.strokeWeight(outlineW);
              p.triangle(BL.x, BL.y, TL.x, TL.y, TR.x, TR.y);
            }
          }

          // Subtle 45° cohort diagonal
          p.stroke(this.config.dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.15)');
          p.strokeWeight(1);
          p.line(BL.x, BL.y, TR.x, TR.y);

          // Bold, bright q_x percentage label — constant size relative to its square.
          if (cellWidth > 24) {
            const labelAlpha = (hover && !lowBright && !upBright) ? 90 : 255;
            p.noStroke();
            p.fill(mCols.label[0], mCols.label[1], mCols.label[2], labelAlpha);
            p.textAlign(p.CENTER, p.CENTER);
            p.textStyle(p.BOLD);
            p.textSize(cellWidth * 0.16);

            const pctVal = qx * 100;
            let pctStr;
            if (pctVal < 0.1) pctStr = pctVal.toFixed(2) + '%';
            else if (pctVal < 10.0) pctStr = pctVal.toFixed(1) + '%';
            else pctStr = Math.round(pctVal) + '%';

            p.text(pctStr, (BL.x + TR.x) / 2, (BL.y + TR.y) / 2);
            p.textStyle(p.NORMAL);
          }
        }
      }
    }

    // Screen-space vertex tagged with its world birth-year (by = year - age).
    _vtx(year, age) {
      const cSize = this.config.cellSize;
      const s = this._worldToScreen((year - 1900) * cSize, -age * cSize);
      return { x: s.x, y: s.y, by: year - age };
    }

    // Fill one cohort triangle whose band spans birth-years [bLeft, bLeft+R]. Survival splits
    // the triangle with cuts of constant birth-year (parallel to the cohort diagonal):
    //   dead      birth-year in [bLeft,            bLeft + (1 - S_start) R]   (upper-left)
    //   dying     birth-year in [bLeft+(1-S_start)R, bLeft + (1 - S_end)  R]
    //   surviving birth-year in [bLeft+(1-S_end)  R, bLeft + R]               (lower-right)
    _fillCohortTriangle(tri, bLeft, R, S_start, S_end, mCols, cellWidth) {
      const p = this.p;
      if (cellWidth < 8) {
        p.noStroke();
        p.fill(...mCols.surviving);
        p.triangle(tri[0].x, tri[0].y, tri[1].x, tri[1].y, tri[2].x, tri[2].y);
        return;
      }
      const se = Math.max(0, Math.min(1, S_end));
      const ss = Math.max(se, Math.min(1, S_start));
      const tDead = bLeft + (1 - ss) * R;   // dead | dying boundary
      const tDying = bLeft + (1 - se) * R;   // dying | surviving boundary
      this._fillByBirthYear(tri, bLeft, tDead, mCols.dead);
      this._fillByBirthYear(tri, tDead, tDying, mCols.dying);
      this._fillByBirthYear(tri, tDying, bLeft + R, mCols.surviving);
    }

    // Clip convex polygon `poly` (vertices tagged with `.by`) to the birth-year slab
    // [byLo, byHi] and fill. Cuts fall on constant-birth-year lines (45° cohort diagonals).
    _fillByBirthYear(poly, byLo, byHi, col) {
      if (byHi - byLo < 1e-4) return;
      const clip = (pts, bc, keepGreaterEqual) => {
        const out = [];
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i], b = pts[(i + 1) % pts.length];
          const aIn = keepGreaterEqual ? a.by >= bc : a.by <= bc;
          const bIn = keepGreaterEqual ? b.by >= bc : b.by <= bc;
          if (aIn) out.push(a);
          if (aIn !== bIn) {
            const t = (bc - a.by) / (b.by - a.by);
            out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, by: bc });
          }
        }
        return out;
      };
      let c = clip(poly, byLo, true);       // keep by >= byLo
      if (c.length < 3) return;
      c = clip(c, byHi, false);              // keep by <= byHi
      if (c.length < 3) return;
      const p = this.p;
      p.noStroke();
      p.fill(...col);
      p.beginShape();
      for (const v of c) p.vertex(v.x, v.y);
      p.endShape(p.CLOSE);
    }

    // Smallest "every Nth" step so that consecutive ticks are at least
    // `minPx` apart on screen, given `pxSpacing` between adjacent grid lines.
    _pickStep(n, pxSpacing, minPx) {
      if (pxSpacing <= 0) return Math.max(1, n);
      return Math.max(1, Math.ceil(minPx / pxSpacing));
    }

    _drawYearRuler() {
      const p = this.p;
      const cSize = this.config.cellSize;
      const R = this.resolution || 10;
      const presentYear = this.config.presentYear;
      const marginTop = this.config.axisMarginTop;
      const marginLeft = this.config.axisMarginLeft;
      const hover = this.hover;
      const dark = this.config.dark;
      const axisBg = dark ? this.config.colors.axisBgDark : this.config.colors.axisBg;
      const axisText = dark ? this.config.colors.axisTextDark : this.config.colors.axisText;

      p.push();
      p.noStroke();
      p.fill(axisBg);
      p.rect(0, 0, this.canvasW, marginTop);
      p.textSize(this.config.axisFontSize);
      p.textAlign(p.CENTER, p.CENTER);

      const dataStart = this.dataStartYear;
      const yearStepPx = R * cSize * this.view.scale;
      const labelStepR = Math.max(1, Math.ceil(this.config.minLabelSpacingPx / yearStepPx));
      const yearTicks = new Set();
      for (let yr = dataStart; yr <= presentYear; yr += R * labelStepR) yearTicks.add(yr);
      if (hover) yearTicks.add(hover.year);

      for (const yr of yearTicks) {
        const x = this._worldToScreen((yr - 1900) * cSize, 0).x;
        if (x < marginLeft - 20 || x > this.canvasW + 20) continue;
        const isHover = hover && yr === hover.year;
        p.fill(isHover ? '#b8860b' : axisText);
        p.textStyle(isHover ? p.BOLD : p.NORMAL);
        p.text(yr, x, marginTop / 2);
      }
      p.pop();
    }

    _drawAgeRuler() {
      const p = this.p;
      const cSize = this.config.cellSize;
      const R = this.resolution || 10;
      const marginLeft = this.config.axisMarginLeft;
      const hover = this.hover;
      const dark = this.config.dark;
      const axisBg = dark ? this.config.colors.axisBgDark : this.config.colors.axisBg;
      const axisText = dark ? this.config.colors.axisTextDark : this.config.colors.axisText;

      p.push();
      p.noStroke();
      p.fill(axisBg);
      p.rect(0, 0, marginLeft, this.canvasH);
      p.textSize(this.config.axisFontSize);
      p.textAlign(p.CENTER, p.CENTER);

      const ageStepPx = R * cSize * this.view.scale;
      const labelStepR = Math.max(1, Math.ceil(this.config.minLabelSpacingPx / ageStepPx));
      const ageTicks = new Set();
      for (let a = 0; a <= 100; a += R * labelStepR) ageTicks.add(a);
      if (hover) ageTicks.add(hover.age);

      for (const a of ageTicks) {
        const y = this._worldToScreen(0, -a * cSize).y;
        if (y < -10 || y > this.canvasH + 10) continue;
        const isHover = hover && a === hover.age;
        p.fill(isHover ? '#0277bd' : axisText);
        p.textStyle(isHover ? p.BOLD : p.NORMAL);
        p.text(a, marginLeft / 2, y);
      }
      p.pop();
    }

    _drawCohortLabels() {
      const p = this.p;
      const cSize = this.config.cellSize;
      const R = this.resolution || 10;
      const presentYear = this.config.presentYear;
      const hover = this.hover;
      const dark = this.config.dark;
      const axisBg = dark ? this.config.colors.axisBgDark : this.config.colors.axisBg;
      const axisText = dark ? this.config.colors.axisTextDark : this.config.colors.axisText;
      const marginBottom = this.config.axisMarginBottom;

      p.push();
      p.noStroke();
      p.fill(axisBg);
      p.rect(0, this.canvasH - marginBottom, this.canvasW, marginBottom);
      p.textSize(this.config.axisFontSize);
      p.textAlign(p.CENTER, p.CENTER);

      const dataStart = this.dataStartYear;
      const yearStepPx = R * cSize * this.view.scale;
      const labelStepR = Math.max(1, Math.ceil(this.config.minLabelSpacingPx * 1.5 / yearStepPx));
      const candidates = new Set();
      for (let b = dataStart; b <= presentYear; b += R * labelStepR) candidates.add(b);
      if (hover && hover.birthYear) candidates.add(hover.birthYear);

      for (const b of candidates) {
        const isHover = hover && hover.birthYear === b;
        const screenX = this._worldToScreen((b - 1900) * cSize, 0).x;
        if (screenX < this.config.axisMarginLeft - 20 || screenX > this.canvasW + 20) continue;

        p.fill(isHover ? '#7c3aed' : axisText);
        p.textStyle(isHover ? p.BOLD : p.NORMAL);
        p.text('b.' + b, screenX, this.canvasH - marginBottom / 2);
      }
      p.pop();
    }
  }

  global.LexisHexEngine = LexisHexEngine;
})(window);

