// ════════════════════════════════════════════════════════════════
//  PerfectColors — full-screen OKLCH palette builder
//  Ported from the Scoresnake Tennis Match Visualiser color picker
// ════════════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────
var savedColors = [];      // [{L, C, h, selected: bool}]
var cursorL = 0.65;        // lightness controlled by scroll wheel
var themeLight = false;

// Gamut view: 0=silhouette, 1=edges, 2=wireframe, 3=opaque
var gamutMode = 0;
var gamutModeLabels = ['Silhouette', 'Edges', 'Wireframe', 'Opaque'];

// Editing mode: when true, mouse/scroll moves the selected color
var editingColor = false;

// Orbit angles for 3D view
var isoTheta = -Math.PI / 4;   // horizontal rotation (azimuth)
var isoPhi = Math.PI / 5.5;    // vertical tilt (elevation)

// Drag state
var draggingOrbit = false;
var orbitLastX = 0, orbitLastY = 0;

// Canvas & context
var canvas, ctx, W, H;

// ── OKLCH → sRGB conversion ──────────────────────────────────
function oklchToRgb(L, C, h) {
    var hRad = h * Math.PI / 180;
    var a = C * Math.cos(hRad);
    var b = C * Math.sin(hRad);
    var l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    var m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    var s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    var l = l_ * l_ * l_;
    var m = m_ * m_ * m_;
    var s = s_ * s_ * s_;
    var r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    var g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    var bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
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
    return '#' + [r, g, b].map(function (v) { return v.toString(16).padStart(2, '0'); }).join('');
}

// Check if OKLCH maps to valid sRGB
function oklchInGamut(L, C, h) {
    var hRad = h * Math.PI / 180;
    var a = C * Math.cos(hRad);
    var b = C * Math.sin(hRad);
    var l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    var m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    var s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    var l = l_ * l_ * l_;
    var m = m_ * m_ * m_;
    var s = s_ * s_ * s_;
    var r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    var g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    var bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
    return r >= -0.001 && r <= 1.001 && g >= -0.001 && g <= 1.001 && bl >= -0.001 && bl <= 1.001;
}

// Binary search for max in-gamut chroma at given L and hue
function maxChroma(L, hue) {
    var lo = 0, hi = 0.4;
    for (var i = 0; i < 20; i++) {
        var mid = (lo + hi) / 2;
        if (oklchInGamut(L, mid, hue)) lo = mid; else hi = mid;
    }
    return lo;
}

// ── Gamut profile precomputation ─────────────────────────────
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

// Fix pedestal artifact: taper gamut profile chroma at extreme L values
(function taperGamutExtremes() {
    var taperN = 5;
    for (var h = 0; h < 360; h++) {
        var prof = _gamutProfileLC[h];
        for (var i = 0; i < taperN; i++) {
            prof[i] *= i / taperN;
            prof[_gamutProfileSteps - 1 - i] *= i / taperN;
        }
    }
})();

// Max chroma across all hues (for scaling)
var polarMaxC = 0;
(function () {
    for (var h = 0; h < 360; h++)
        if (_absoluteMaxC[h] > polarMaxC) polarMaxC = _absoluteMaxC[h];
    polarMaxC *= 1.08;
})();

// ── 3D Projection ────────────────────────────────────────────
var isoChromaScale = 620;
var isoLScale = 420;
var isoCx, isoCy;

function isoProject(ca, cb, L) {
    var rx = ca * Math.cos(isoTheta) - cb * Math.sin(isoTheta);
    var ry = ca * Math.sin(isoTheta) + cb * Math.cos(isoTheta);
    var sx = isoCx + rx * isoChromaScale;
    var sy = isoCy - ry * Math.sin(isoPhi) * isoChromaScale - (L - 0.5) * Math.cos(isoPhi) * isoLScale;
    return { x: sx, y: sy };
}

function isoProjectLCH(L, C, h) {
    var hRad = h * Math.PI / 180;
    return isoProject(C * Math.cos(hRad), C * Math.sin(hRad), L);
}

function isoDepth(L, C, h) {
    var hRad = h * Math.PI / 180;
    var ca = C * Math.cos(hRad), cb = C * Math.sin(hRad);
    var ry = ca * Math.sin(isoTheta) + cb * Math.cos(isoTheta);
    return ry * Math.cos(isoPhi) - (L - 0.5) * Math.sin(isoPhi);
}

// Unproject screen coordinates at a given L to OKLCH (hue, chroma)
function screenToLCH(mx, my, L) {
    // Invert the projection: for a given L, solve for (ca, cb) from (sx, sy)
    // sx = isoCx + (ca*cos(θ) - cb*sin(θ)) * scale
    // sy = isoCy - (ca*sin(θ) + cb*cos(θ))*sin(φ)*scale - (L-0.5)*cos(φ)*lScale
    var adjY = isoCy - my - (L - 0.5) * Math.cos(isoPhi) * isoLScale;
    var px = (mx - isoCx) / isoChromaScale;
    var py = adjY / (Math.sin(isoPhi) * isoChromaScale);
    // px = ca*cos(θ) - cb*sin(θ)
    // py = ca*sin(θ) + cb*cos(θ)
    // Invert rotation:
    var ca = px * Math.cos(isoTheta) + py * Math.sin(isoTheta);
    var cb = -px * Math.sin(isoTheta) + py * Math.cos(isoTheta);
    var C = Math.sqrt(ca * ca + cb * cb);
    var h = ((Math.atan2(cb, ca) * 180 / Math.PI) + 360) % 360;
    return { L: L, C: C, h: h };
}

// ── Auto-fit projection ──────────────────────────────────────
function autoFit() {
    var margin = 60;
    var fitW = W - margin * 2;
    var fitH = H - margin * 2;
    var kL = 0.685;

    var minPx = Infinity, maxPx = -Infinity, minPy = Infinity, maxPy = -Infinity;
    for (var h = 0; h < 360; h += 10) {
        for (var li = 0; li < _gamutProfileSteps; li += 10) {
            var L = li / (_gamutProfileSteps - 1);
            var C = _gamutProfileLC[h][li];
            if (C < 0.001) continue;
            var hRad = h * Math.PI / 180;
            var ca = C * Math.cos(hRad), cb = C * Math.sin(hRad);
            var rx = ca * Math.cos(isoTheta) - cb * Math.sin(isoTheta);
            var ry = ca * Math.sin(isoTheta) + cb * Math.cos(isoTheta);
            var px = rx;
            var py = -(ry * Math.sin(isoPhi) + (L - 0.5) * Math.cos(isoPhi) * kL);
            if (px < minPx) minPx = px;
            if (px > maxPx) maxPx = px;
            if (py < minPy) minPy = py;
            if (py > maxPy) maxPy = py;
        }
    }
    // Include axis endpoints
    var pts = [{ ca: 0, cb: 0, L: 0.05 }, { ca: 0, cb: 0, L: 0.99 }];
    for (var i = 0; i < pts.length; i++) {
        var rx = 0, ry = 0;
        var py = -(ry * Math.sin(isoPhi) + (pts[i].L - 0.5) * Math.cos(isoPhi) * kL);
        if (0 < minPx) minPx = 0;
        if (0 > maxPx) maxPx = 0;
        if (py < minPy) minPy = py;
        if (py > maxPy) maxPy = py;
    }

    var extW = maxPx - minPx || 0.001;
    var extH = maxPy - minPy || 0.001;
    var scaleX = fitW / extW;
    var scaleY = fitH / extH;
    isoChromaScale = Math.min(scaleX, scaleY);
    isoLScale = isoChromaScale * kL;

    var midPx = (minPx + maxPx) / 2;
    var midPy = (minPy + maxPy) / 2;
    isoCx = W / 2 - midPx * isoChromaScale;
    isoCy = H / 2 - midPy * isoChromaScale;
}

// ── Mouse state ──────────────────────────────────────────────
var mouseX = 0, mouseY = 0;
var mouseOnCanvas = false;

function getMouseLCH() {
    return screenToLCH(mouseX, mouseY, cursorL);
}

// ── Drawing ──────────────────────────────────────────────────
function draw() {
    W = canvas.width = window.innerWidth * devicePixelRatio;
    H = canvas.height = window.innerHeight * devicePixelRatio;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    W = window.innerWidth;
    H = window.innerHeight;

    autoFit();

    var bgColor = themeLight ? '#e0ddd8' : '#0a0a0c';
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, W, H);

    var textColor = themeLight ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.85)';
    var subtleColor = themeLight ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.5)';
    // Grid colors: inside gamut is more visible, outside is dimmer
    var gridColorInside = themeLight ? 'rgba(0,0,0,0.13)' : 'rgba(255,255,255,0.18)';
    var gridColorOutside = themeLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.05)';

    // ── Grid: chroma circles at mid-lightness ──
    // Each segment is colored based on whether that point is inside the gamut
    var gridChromaStep = 0.05;
    for (var cr = gridChromaStep; cr <= polarMaxC; cr += gridChromaStep) {
        var prevSp = null;
        for (var a = 0; a <= 360; a += 5) {
            var sp = isoProjectLCH(0.5, cr, a);
            if (prevSp) {
                var inGamut = oklchInGamut(0.5, cr, a);
                ctx.strokeStyle = inGamut ? gridColorInside : gridColorOutside;
                ctx.setLineDash(inGamut ? [] : [4, 4]);
                ctx.lineWidth = 0.9;
                ctx.beginPath(); ctx.moveTo(prevSp.x, prevSp.y); ctx.lineTo(sp.x, sp.y); ctx.stroke();
            }
            prevSp = sp;
        }
    }

    // Vertical lightness lines at cardinal hues
    for (var h = 0; h < 360; h += 30) {
        var mc = _absoluteMaxC[h] * 0.7;
        if (mc < 0.01) continue;
        // Draw segmented: check in-gamut along each step
        var prevSp = null;
        for (var li = 25; li <= 95; li += 5) {
            var L = li / 100;
            var sp = isoProjectLCH(L, mc, h);
            if (prevSp) {
                var inGamut = oklchInGamut(L, mc, h);
                ctx.strokeStyle = inGamut ? gridColorInside : gridColorOutside;
                ctx.setLineDash(inGamut ? [] : [4, 4]);
                ctx.lineWidth = 0.9;
                ctx.beginPath(); ctx.moveTo(prevSp.x, prevSp.y); ctx.lineTo(sp.x, sp.y); ctx.stroke();
            }
            prevSp = sp;
        }
    }

    // Ellipse outlines at key lightness levels
    var labelLevels = [0.3, 0.5, 0.7, 0.9];
    for (var gl = 0; gl < labelLevels.length; gl++) {
        var lev = labelLevels[gl];
        var prevSp = null;
        for (var a = 0; a <= 360; a += 3) {
            var sp = isoProjectLCH(lev, 0.1, a);
            if (prevSp) {
                var inGamut = oklchInGamut(lev, 0.1, a);
                ctx.strokeStyle = inGamut ? gridColorInside : gridColorOutside;
                ctx.setLineDash(inGamut ? [] : [4, 4]);
                ctx.lineWidth = 1.0;
                ctx.beginPath(); ctx.moveTo(prevSp.x, prevSp.y); ctx.lineTo(sp.x, sp.y); ctx.stroke();
            }
            prevSp = sp;
        }
        var labelPt = isoProjectLCH(lev, 0.12, 330);
        ctx.fillStyle = subtleColor;
        ctx.font = '9px -apple-system, sans-serif';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText('L=' + lev.toFixed(1), labelPt.x + 4, labelPt.y);
    }

    ctx.setLineDash([]);

    // Vertical axis line
    ctx.strokeStyle = themeLight ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    var axBot = isoProjectLCH(0.15, 0, 0);
    var axTop = isoProjectLCH(0.95, 0, 0);
    ctx.beginPath();
    ctx.moveTo(axBot.x, axBot.y);
    ctx.lineTo(axTop.x, axTop.y);
    ctx.stroke();

    // L=0.5 center tick
    var axMid = isoProjectLCH(0.5, 0, 0);
    ctx.beginPath();
    ctx.arc(axMid.x, axMid.y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = themeLight ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.35)';
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

    // ── Gamut volume ──
    drawGamutVolume();

    // ── Current lightness surface + ring ──
    // In edit mode, show at the selected color's L instead
    var ringL = cursorL;
    if (editingColor) {
        var selIdx = getSelectedIndex();
        if (selIdx >= 0) ringL = savedColors[selIdx].L;
    }
    drawLightnessSurface(ringL);
    drawLightnessRing(ringL);

    // ── Saved color dots ──
    for (var i = 0; i < savedColors.length; i++) {
        var sc = savedColors[i];
        var sp = isoProjectLCH(sc.L, sc.C, sc.h);
        var rgb = oklchToRgb(sc.L, sc.C, sc.h);
        var r = sc.selected ? 12 : 8;

        // Shadow
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, r + 2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fill();

        // Color fill
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')';
        ctx.fill();

        // Border
        ctx.strokeStyle = sc.selected
            ? (themeLight ? 'rgba(0,0,0,0.9)' : 'rgba(255,255,255,0.95)')
            : (themeLight ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.3)');
        ctx.lineWidth = sc.selected ? 3 : 1.5;
        ctx.stroke();

        // Label inside dot
        if (sc.label) {
            var luma = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
            ctx.fillStyle = luma > 140 ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.95)';
            ctx.font = 'bold ' + (r - 1) + 'px -apple-system, sans-serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(sc.label, sp.x, sp.y);
        }

        // Hex label for selected
        if (sc.selected) {
            var hex = rgbToHex(rgb.r, rgb.g, rgb.b);
            ctx.fillStyle = textColor;
            ctx.font = 'bold 10px -apple-system, sans-serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
            ctx.fillText(hex, sp.x, sp.y - r - 5);
            ctx.fillStyle = subtleColor;
            ctx.font = '9px -apple-system, sans-serif';
            ctx.fillText('L=' + sc.L.toFixed(2) + ' C=' + sc.C.toFixed(3) + ' h=' + Math.round(sc.h) + '°', sp.x, sp.y - r - 17);
        }
    }

    // ── Cursor (current mouse position color) ──
    if (mouseOnCanvas && !draggingOrbit) {
        // In edit mode, the cursor shows where the selected color will move to
        var editIdx = editingColor ? getSelectedIndex() : -1;
        var targetL = editIdx >= 0 ? savedColors[editIdx].L : cursorL;
        var curLCH = screenToLCH(mouseX, mouseY, targetL);
        var curC = Math.min(curLCH.C, maxChroma(targetL, curLCH.h));
        if (curC > 0.001) {
            var curSp = isoProjectLCH(targetL, curC, curLCH.h);
            var curRgb = oklchToRgb(targetL, curC, curLCH.h);

            // Crosshair lines
            ctx.setLineDash([4, 4]);
            ctx.strokeStyle = themeLight ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.25)';
            ctx.lineWidth = 1;
            var axisPt = isoProjectLCH(targetL, 0, 0);
            ctx.beginPath(); ctx.moveTo(curSp.x, curSp.y); ctx.lineTo(axisPt.x, axisPt.y); ctx.stroke();
            ctx.setLineDash([]);

            // Cursor dot (pulsing border in edit mode)
            var dotR = editingColor ? 12 : 10;
            ctx.beginPath();
            ctx.arc(curSp.x, curSp.y, dotR, 0, Math.PI * 2);
            ctx.fillStyle = 'rgb(' + curRgb.r + ',' + curRgb.g + ',' + curRgb.b + ')';
            ctx.fill();
            if (editingColor) {
                ctx.strokeStyle = themeLight ? 'rgba(0,0,0,0.9)' : 'rgba(255,255,255,0.95)';
                ctx.lineWidth = 3;
                ctx.setLineDash([4, 3]);
                ctx.stroke();
                ctx.setLineDash([]);
            } else {
                ctx.strokeStyle = themeLight ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.7)';
                ctx.lineWidth = 2;
                ctx.stroke();
            }

            // Cursor info
            var hex = rgbToHex(curRgb.r, curRgb.g, curRgb.b);
            ctx.fillStyle = textColor;
            ctx.font = 'bold 11px -apple-system, sans-serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
            ctx.fillText(hex, curSp.x, curSp.y - dotR - 5);
            ctx.fillStyle = subtleColor;
            ctx.font = '9px -apple-system, sans-serif';
            ctx.fillText('L=' + targetL.toFixed(2) + ' C=' + curC.toFixed(3) + ' h=' + Math.round(curLCH.h) + '°', curSp.x, curSp.y - dotR - 17);
            if (editingColor) {
                ctx.fillStyle = themeLight ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.65)';
                ctx.font = 'bold 9px -apple-system, sans-serif';
                ctx.textAlign = 'center'; ctx.textBaseline = 'top';
                ctx.fillText('EDITING — Space to confirm, Esc to cancel', curSp.x, curSp.y + dotR + 6);
            }
        }
    }

    // ── Lightness indicator bar (right edge) ──
    drawLightnessBar();

    // ── Orbit widgets ──
    drawOrbitWidgets();

    // ── Caption ──
    ctx.font = '9px -apple-system, sans-serif';
    ctx.fillStyle = themeLight ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.3)';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText('OKLCH · angle = hue, radius = chroma, height = lightness', W / 2, H - 42);
}

// ── Gamut volume rendering (4 modes) ─────────────────────────
var _gamutMaskCanvas = null;
var _gamutOverlayCanvas = null;

function buildGamutQuads() {
    var gHsteps = 72;
    var gLsteps = _gamutProfileSteps;
    var gamutQuads = [];

    for (var hi = 0; hi < gHsteps; hi++) {
        var h0 = hi * 360 / gHsteps;
        var h1g = ((hi + 1) % gHsteps) * 360 / gHsteps;
        var hIdx0 = Math.round(h0) % 360;
        var hIdx1 = Math.round(h1g) % 360;
        var prof0 = _gamutProfileLC[hIdx0], prof1 = _gamutProfileLC[hIdx1];
        for (var li = 0; li < gLsteps - 1; li++) {
            var L0 = li / (gLsteps - 1), L1 = (li + 1) / (gLsteps - 1);
            var C00 = prof0[li], C01 = prof0[li + 1];
            var C10 = prof1[li], C11 = prof1[li + 1];
            if (C00 < 0.001 && C01 < 0.001 && C10 < 0.001 && C11 < 0.001) continue;
            var sp00 = isoProjectLCH(L0, C00, h0), sp01 = isoProjectLCH(L1, C01, h0);
            var sp10 = isoProjectLCH(L0, C10, h1g), sp11 = isoProjectLCH(L1, C11, h1g);
            var d = (isoDepth(L0, C00, h0) + isoDepth(L1, C01, h0)
                + isoDepth(L0, C10, h1g) + isoDepth(L1, C11, h1g)) / 4;
            gamutQuads.push({ sp00: sp00, sp01: sp01, sp10: sp10, sp11: sp11, d: d, h0: h0, h1g: h1g, L0: L0, L1: L1, C00: C00, C01: C01, C10: C10, C11: C11 });
        }
    }
    gamutQuads.sort(function (a, b) { return b.d - a.d; });
    return gamutQuads;
}

function buildGamutMask(gamutQuads) {
    if (!_gamutMaskCanvas) _gamutMaskCanvas = document.createElement('canvas');
    if (_gamutMaskCanvas.width !== W || _gamutMaskCanvas.height !== H) {
        _gamutMaskCanvas.width = W; _gamutMaskCanvas.height = H;
    }
    var maskCtx = _gamutMaskCanvas.getContext('2d');
    maskCtx.clearRect(0, 0, W, H);
    maskCtx.fillStyle = '#ffffff';
    for (var qi = 0; qi < gamutQuads.length; qi++) {
        var q = gamutQuads[qi];
        maskCtx.beginPath();
        maskCtx.moveTo(q.sp00.x, q.sp00.y); maskCtx.lineTo(q.sp01.x, q.sp01.y);
        maskCtx.lineTo(q.sp11.x, q.sp11.y); maskCtx.lineTo(q.sp10.x, q.sp10.y);
        maskCtx.closePath();
        maskCtx.fill();
    }
}

function drawColoredWire(alpha, lineW) {
    var gHsteps = 72;
    var gLsteps = _gamutProfileSteps;
    // L-latitude contours
    for (var li = 2; li < gLsteps - 1; li += 4) {
        var L = li / (gLsteps - 1);
        var prevSp = null;
        for (var hi2 = 0; hi2 <= gHsteps; hi2++) {
            var h = (hi2 % gHsteps) * 360 / gHsteps;
            var hIdx = Math.round(h) % 360;
            var C = _gamutProfileLC[hIdx][li];
            if (C < 0.001) { prevSp = null; continue; }
            var sp = isoProjectLCH(L, C, h);
            if (prevSp) {
                var rgb = oklchToRgb(L, C, h);
                ctx.strokeStyle = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + alpha + ')';
                ctx.lineWidth = lineW;
                ctx.beginPath(); ctx.moveTo(prevSp.x, prevSp.y); ctx.lineTo(sp.x, sp.y); ctx.stroke();
            }
            prevSp = sp;
        }
    }
    // H-meridian lines
    for (var hi2 = 0; hi2 < gHsteps; hi2 += 6) {
        var h = hi2 * 360 / gHsteps;
        var hIdx = Math.round(h) % 360;
        var prof = _gamutProfileLC[hIdx];
        var prevSp = null;
        for (var li = 0; li < gLsteps; li++) {
            var L = li / (gLsteps - 1), C = prof[li];
            if (C < 0.001) { prevSp = null; continue; }
            var sp = isoProjectLCH(L, C, h);
            if (prevSp) {
                var rgb = oklchToRgb(L, C, h);
                ctx.strokeStyle = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + alpha + ')';
                ctx.lineWidth = lineW;
                ctx.beginPath(); ctx.moveTo(prevSp.x, prevSp.y); ctx.lineTo(sp.x, sp.y); ctx.stroke();
            }
            prevSp = sp;
        }
    }
}

function drawGamutVolume() {
    var gamutQuads = buildGamutQuads();
    buildGamutMask(gamutQuads);

    if (gamutMode <= 1) {
        // SILHOUETTE (mode 0) or EDGES (mode 1)
        var invertColor = themeLight ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.10)';
        if (!_gamutOverlayCanvas) _gamutOverlayCanvas = document.createElement('canvas');
        if (_gamutOverlayCanvas.width !== W || _gamutOverlayCanvas.height !== H) {
            _gamutOverlayCanvas.width = W; _gamutOverlayCanvas.height = H;
        }
        var ovCtx = _gamutOverlayCanvas.getContext('2d');
        ovCtx.clearRect(0, 0, W, H);
        ovCtx.fillStyle = invertColor;
        ovCtx.fillRect(0, 0, W, H);
        ovCtx.globalCompositeOperation = 'destination-out';
        ovCtx.drawImage(_gamutMaskCanvas, 0, 0);
        ovCtx.globalCompositeOperation = 'source-over';
        ctx.drawImage(_gamutOverlayCanvas, 0, 0);

        if (gamutMode === 1) {
            // EDGES: colored wireframe on top of silhouette
            drawColoredWire(0.7, 0.8);
        }
    } else if (gamutMode === 2) {
        // WIREFRAME: colored wireframe lines only
        drawColoredWire(0.9, 0.8);
    } else {
        // OPAQUE (mode 3): solid colored quads + subtle wireframe
        for (var qi = 0; qi < gamutQuads.length; qi++) {
            var q = gamutQuads[qi];
            var mH = (q.h0 + q.h1g) / 2, mL = (q.L0 + q.L1) / 2;
            var mC = (q.C00 + q.C01 + q.C10 + q.C11) / 4;
            var rgb = oklchToRgb(mL, Math.min(mC, maxChroma(mL, mH)), mH);
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

// ── Lightness surface (filled color disc at a given L) ───────
function getProfileChroma(L, hueIndex) {
    var li = L * (_gamutProfileSteps - 1);
    var li0 = Math.floor(li);
    var li1 = Math.min(li0 + 1, _gamutProfileSteps - 1);
    var t = li - li0;
    return _gamutProfileLC[hueIndex][li0] * (1 - t) + _gamutProfileLC[hueIndex][li1] * t;
}

function drawLightnessSurface(L) {
    var hueSteps = 120;
    var chromaSteps = 12;
    for (var hi = 0; hi < hueSteps; hi++) {
        var h0 = hi * 360 / hueSteps;
        var h1 = ((hi + 1) % hueSteps) * 360 / hueSteps;
        var hIdx0 = Math.round(h0) % 360;
        var hIdx1 = Math.round(h1) % 360;
        var mc0 = getProfileChroma(L, hIdx0);
        var mc1 = getProfileChroma(L, hIdx1);
        for (var ci = 0; ci < chromaSteps; ci++) {
            var f0 = ci / chromaSteps, f1 = (ci + 1) / chromaSteps;
            var C00 = mc0 * f0, C01 = mc0 * f1;
            var C10 = mc1 * f0, C11 = mc1 * f1;
            if (C01 < 0.001 && C11 < 0.001) continue;
            var sp00 = isoProjectLCH(L, C00, h0);
            var sp01 = isoProjectLCH(L, C01, h0);
            var sp10 = isoProjectLCH(L, C10, h1);
            var sp11 = isoProjectLCH(L, C11, h1);
            var mC = (C00 + C01 + C10 + C11) / 4;
            var dh = ((h1 - h0) + 360) % 360;
            var mH = (h0 + dh / 2) % 360;
            var rgb = oklchToRgb(L, mC, mH);
            ctx.beginPath();
            ctx.moveTo(sp00.x, sp00.y);
            ctx.lineTo(sp01.x, sp01.y);
            ctx.lineTo(sp11.x, sp11.y);
            ctx.lineTo(sp10.x, sp10.y);
            ctx.closePath();
            ctx.fillStyle = 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')';
            ctx.fill();
        }
    }
}

// ── Lightness ring (gamut boundary at current L) ─────────────
function drawLightnessRing(L) {
    var ringPts = [];
    for (var h = 0; h < 360; h++) {
        var C = maxChroma(L, h);
        var sp = isoProjectLCH(L, C, h);
        var rgb = oklchToRgb(L, C, h);
        ringPts.push({ x: sp.x, y: sp.y, C: C, rgb: rgb });
    }
    // Draw colored ring
    for (var i = 0; i < 360; i++) {
        var a = ringPts[i], b = ringPts[(i + 1) % 360];
        if (a.C < 0.001 && b.C < 0.001) continue;
        ctx.strokeStyle = 'rgb(' + a.rgb.r + ',' + a.rgb.g + ',' + a.rgb.b + ')';
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    // Label
    var labelPt = isoProjectLCH(L, maxChroma(L, 60) + 0.01, 60);
    ctx.fillStyle = themeLight ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.55)';
    ctx.font = '9px -apple-system, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('L=' + L.toFixed(2), labelPt.x + 6, labelPt.y);
}

// ── Lightness bar (right edge) ───────────────────────────────
function drawLightnessBar() {
    var barW = 16, barH = Math.min(H * 0.5, 300);
    var barX = W - 36, barY = (H - barH) / 2;

    // Background
    ctx.fillStyle = themeLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)';
    ctx.beginPath();
    ctx.roundRect(barX, barY, barW, barH, 4);
    ctx.fill();

    // Gradient fill (bottom=dark, top=bright)
    for (var i = 0; i < barH; i++) {
        var L = 1 - i / barH;
        var gray = Math.round(L * 255);
        ctx.fillStyle = 'rgb(' + gray + ',' + gray + ',' + gray + ')';
        ctx.fillRect(barX + 2, barY + i, barW - 4, 1);
    }

    // Current L indicator
    var indY = barY + (1 - cursorL) * barH;
    ctx.fillStyle = themeLight ? '#222' : '#fff';
    ctx.beginPath();
    ctx.moveTo(barX - 4, indY);
    ctx.lineTo(barX + 1, indY - 4);
    ctx.lineTo(barX + 1, indY + 4);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = themeLight ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.65)';
    ctx.font = '9px -apple-system, sans-serif';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(cursorL.toFixed(2), barX - 8, indY);
}

// ── Orbit widgets ────────────────────────────────────────────
function drawOrbitWidgets() {
    var wMar = 14;
    var wLen = 80, wThick = 18;
    var widgetColor = themeLight ? 'rgba(0,0,0,' : 'rgba(255,255,255,';

    // Longitude widget (horizontal, bottom-left)
    var lonX = wMar, lonY = H - wMar - wThick;
    ctx.fillStyle = widgetColor + '0.08)';
    ctx.strokeStyle = widgetColor + '0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(lonX, lonY, wLen, wThick, 4);
    ctx.fill(); ctx.stroke();
    var lonFrac = ((isoTheta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / (2 * Math.PI);
    var lonKnobX = lonX + 4 + lonFrac * (wLen - 8);
    ctx.beginPath();
    ctx.arc(lonKnobX, lonY + wThick / 2, 4, 0, Math.PI * 2);
    ctx.fillStyle = widgetColor + '0.7)';
    ctx.fill();
    ctx.font = '8px -apple-system, sans-serif';
    ctx.fillStyle = widgetColor + '0.35)';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText('θ lon', lonX + wLen / 2, lonY - 3);

    // Latitude widget (vertical, above lon)
    var latX = wMar, latY = lonY - wLen - 24;
    ctx.fillStyle = widgetColor + '0.08)';
    ctx.strokeStyle = widgetColor + '0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(latX, latY, wThick, wLen, 4);
    ctx.fill(); ctx.stroke();
    var latFrac = 1 - isoPhi / (Math.PI / 2);
    var latKnobY = latY + 4 + latFrac * (wLen - 8);
    ctx.beginPath();
    ctx.arc(latX + wThick / 2, latKnobY, 4, 0, Math.PI * 2);
    ctx.fillStyle = widgetColor + '0.7)';
    ctx.fill();
    ctx.font = '8px -apple-system, sans-serif';
    ctx.fillStyle = widgetColor + '0.35)';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('φ lat', latX + wThick + 4, latY + wLen / 2);
}

// ── Interaction ──────────────────────────────────────────────
var defaultColors = [
    { L: 0.59, C: 0.0036, h: 19.3, selected: false, label: 'A' },
    { L: 0.63, C: 0.2117, h: 27.8, selected: false, label: 'B' },
    { L: 0.83, C: 0.0320, h: 164.4, selected: false, label: 'C' },
    { L: 0.67, C: 0.1672, h: 51.0, selected: false, label: 'D' },
    { L: 0.79, C: 0.1572, h: 81.6, selected: false, label: 'E' },
    { L: 0.83, C: 0.1207, h: 132.9, selected: false, label: 'F' },
    { L: 0.33, C: 0.0103, h: 351.2, selected: false, label: 'G' },
];

function init() {
    canvas = document.getElementById('main-canvas');
    ctx = canvas.getContext('2d');
    W = window.innerWidth;
    H = window.innerHeight;

    // Load default palette
    savedColors = defaultColors.map(function (c) { return { L: c.L, C: c.C, h: c.h, selected: c.selected, label: c.label }; });

    draw();

    // Mouse move
    canvas.addEventListener('mousemove', function (e) {
        mouseOnCanvas = true;
        mouseX = e.clientX;
        mouseY = e.clientY;

        if (draggingOrbit) {
            var dx = e.clientX - orbitLastX;
            var dy = e.clientY - orbitLastY;
            isoTheta += dx * 0.008;
            isoPhi = Math.max(0.05, Math.min(Math.PI / 2 - 0.05, isoPhi - dy * 0.008));
            orbitLastX = e.clientX;
            orbitLastY = e.clientY;
            _gamutMaskCanvas = null;
            _gamutOverlayCanvas = null;
        }
        requestDraw();
    });

    canvas.addEventListener('mouseleave', function () {
        mouseOnCanvas = false;
        requestDraw();
    });

    // Scroll wheel → lightness (edit mode adjusts selected color's L)
    canvas.addEventListener('wheel', function (e) {
        e.preventDefault();
        var delta = e.deltaY > 0 ? -0.02 : 0.02;
        if (editingColor) {
            var idx = getSelectedIndex();
            if (idx >= 0) {
                savedColors[idx].L = Math.max(0.01, Math.min(0.99, savedColors[idx].L + delta));
                savedColors[idx].C = Math.min(savedColors[idx].C, maxChroma(savedColors[idx].L, savedColors[idx].h));
            }
        } else {
            cursorL = Math.max(0.01, Math.min(0.99, cursorL + delta));
        }
        requestDraw();
    }, { passive: false });

    // Mouse down
    canvas.addEventListener('mousedown', function (e) {
        if (e.button === 0) {
            // Check if we clicked on a saved color
            var clickedIdx = hitTestSavedColors(e.clientX, e.clientY);
            if (clickedIdx >= 0) {
                // Toggle selection
                for (var i = 0; i < savedColors.length; i++) savedColors[i].selected = false;
                savedColors[clickedIdx].selected = true;
                editingColor = false;
                requestDraw();
                return;
            }
            // Deselect all
            for (var i = 0; i < savedColors.length; i++) savedColors[i].selected = false;
            editingColor = false;
            // Start orbit drag
            draggingOrbit = true;
            orbitLastX = e.clientX;
            orbitLastY = e.clientY;
            canvas.style.cursor = 'grabbing';
            requestDraw();
        }
    });

    canvas.addEventListener('mouseup', function (e) {
        if (e.button === 0 && draggingOrbit) {
            draggingOrbit = false;
            canvas.style.cursor = 'crosshair';
            requestDraw();
        }
    });

    // Keyboard
    document.addEventListener('keydown', function (e) {
        if (e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            if (editingColor) {
                // Confirm edit: move selected color to cursor position
                var idx = getSelectedIndex();
                if (idx >= 0 && mouseOnCanvas) {
                    var lch = screenToLCH(mouseX, mouseY, savedColors[idx].L);
                    var C = Math.min(lch.C, maxChroma(savedColors[idx].L, lch.h));
                    if (C > 0.001) {
                        savedColors[idx].C = C;
                        savedColors[idx].h = lch.h;
                    }
                }
                editingColor = false;
                requestDraw();
            } else {
                if (!mouseOnCanvas) return;
                addColorAtCursor();
            }
        } else if (e.key === 'Escape') {
            if (editingColor) {
                editingColor = false;
                requestDraw();
            }
        } else if (e.key === 'e' || e.key === 'E') {
            var idx = getSelectedIndex();
            if (idx >= 0) {
                editingColor = !editingColor;
                requestDraw();
            }
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            editingColor = false;
            deleteSelectedColor();
        }
    });

    // Theme toggle
    document.getElementById('theme-toggle').addEventListener('click', function () {
        themeLight = !themeLight;
        document.body.classList.toggle('theme-light', themeLight);
        this.textContent = themeLight ? '🌙' : '☀️';
        _gamutMaskCanvas = null;
        _gamutOverlayCanvas = null;
        requestDraw();
    });

    // Gamut mode button
    document.getElementById('gamut-mode-btn').addEventListener('click', function () {
        gamutMode = (gamutMode + 1) % 4;
        this.textContent = 'Gamut: ' + gamutModeLabels[gamutMode];
        _gamutMaskCanvas = null;
        _gamutOverlayCanvas = null;
        requestDraw();
    });

    // Export
    document.getElementById('export-btn').addEventListener('click', showExport);
    document.getElementById('close-export').addEventListener('click', function () {
        document.getElementById('export-modal').classList.add('hidden');
    });
    document.getElementById('copy-hex').addEventListener('click', function () {
        var text = document.getElementById('export-hex').value;
        navigator.clipboard.writeText(text);
        this.textContent = 'Copied!';
        var btn = this;
        setTimeout(function () { btn.textContent = 'Copy Hex'; }, 1200);
    });
    document.getElementById('copy-oklch').addEventListener('click', function () {
        var text = document.getElementById('export-oklch').value;
        navigator.clipboard.writeText(text);
        this.textContent = 'Copied!';
        var btn = this;
        setTimeout(function () { btn.textContent = 'Copy OKLCH'; }, 1200);
    });

    // Resize
    window.addEventListener('resize', function () {
        _gamutMaskCanvas = null;
        _gamutOverlayCanvas = null;
        requestDraw();
    });

    canvas.style.cursor = 'crosshair';
}

var _drawRequested = false;
function requestDraw() {
    if (!_drawRequested) {
        _drawRequested = true;
        requestAnimationFrame(function () {
            _drawRequested = false;
            draw();
        });
    }
}

function getSelectedIndex() {
    for (var i = 0; i < savedColors.length; i++) {
        if (savedColors[i].selected) return i;
    }
    return -1;
}

function addColorAtCursor() {
    var lch = getMouseLCH();
    var C = Math.min(lch.C, maxChroma(cursorL, lch.h));
    if (C < 0.001) return;
    // Deselect all and select the new one
    for (var i = 0; i < savedColors.length; i++) savedColors[i].selected = false;
    savedColors.push({ L: cursorL, C: C, h: lch.h, selected: true });
    requestDraw();
}

function deleteSelectedColor() {
    savedColors = savedColors.filter(function (c) { return !c.selected; });
    requestDraw();
}

function hitTestSavedColors(mx, my) {
    // Test in reverse order (topmost first)
    for (var i = savedColors.length - 1; i >= 0; i--) {
        var sc = savedColors[i];
        var sp = isoProjectLCH(sc.L, sc.C, sc.h);
        var dx = mx - sp.x;
        var dy = my - sp.y;
        var r = sc.selected ? 12 : 8;
        if (dx * dx + dy * dy <= (r + 4) * (r + 4)) return i;
    }
    return -1;
}

function showExport() {
    if (savedColors.length === 0) return;
    var hexLines = [];
    var oklchLines = [];
    for (var i = 0; i < savedColors.length; i++) {
        var c = savedColors[i];
        var rgb = oklchToRgb(c.L, c.C, c.h);
        hexLines.push(rgbToHex(rgb.r, rgb.g, rgb.b));
        oklchLines.push('oklch(' + (c.L * 100).toFixed(1) + '% ' + c.C.toFixed(4) + ' ' + c.h.toFixed(1) + ')');
    }
    document.getElementById('export-hex').value = hexLines.join('\n');
    document.getElementById('export-oklch').value = oklchLines.join('\n');
    document.getElementById('export-modal').classList.remove('hidden');
}

// ── Boot ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
