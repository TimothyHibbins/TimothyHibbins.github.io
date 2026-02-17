#!/usr/bin/env python3
"""Patch sketch.js: rewrite graph section of drawStripView, add third strip, update handlers."""

FILE = '/Users/timothyhibbins/Desktop/Website/TimothyHibbins.github.io/p5 Sketches/Scoresnake Tennis Match Visualiser/sketch.js'

with open(FILE, 'r') as f:
    code = f.read()

lines = code.split('\n')

# ── 1. Add _stripPerHueTradeoff after _stripSwapped ──
for i, line in enumerate(lines):
    if 'var _stripSwapped = false;' in line:
        lines.insert(i + 1, 'var _stripPerHueTradeoff = new Array(36).fill(180); // per-column tradeoff sliders')
        break

# Re-join and re-split to get correct indices
code = '\n'.join(lines)
lines = code.split('\n')

# ── 2. Find drawStripView and replace it entirely ──
# Find "  function drawStripView() {"
start_idx = None
for i, line in enumerate(lines):
    if line.strip() == 'function drawStripView() {':
        start_idx = i
        break

# Find the closing brace: next "  }" followed by "  // ──── Input handling"
end_idx = None
for i in range(start_idx, len(lines)):
    if '// ──── Input handling ────' in lines[i]:
        end_idx = i
        break

new_drawStripView = r'''  function drawStripView() {
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
      let p2dark = computeStripP2Dark(h1d, h2);
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

    // Mode toggle (clickable)
    let modeLabel = _stripSacrificeBoth ? '\u25B8 Chroma + Lightness' : '\u25B8 Chroma only';
    ctx.font = '11px -apple-system, sans-serif';
    let mtMetrics = ctx.measureText(modeLabel);
    modeToggleW = mtMetrics.width + 12;
    modeToggleX = gxL + gPlotW / 2 - modeToggleW / 2;
    modeToggleY = gyT - 42;
    ctx.fillStyle = _themeLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)';
    ctx.beginPath();
    ctx.roundRect(modeToggleX, modeToggleY, modeToggleW, modeToggleH, 4);
    ctx.fill();
    ctx.fillStyle = subtleColor;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(modeLabel, gxL + gPlotW / 2, modeToggleY + modeToggleH / 2);
  }
'''

new_lines = new_drawStripView.strip().split('\n')
lines[start_idx:end_idx] = new_lines

code = '\n'.join(lines)

# ── 3. Update mousedown handler for third strip + graph drag updating P2 ──
# Find and update mousedown strip section
old_mousedown_strip = '''    if (_displayMode === 'strip') {
      let p = canvasCoords(e);
      // Check mode toggle click
      if (p.x >= modeToggleX && p.x <= modeToggleX + modeToggleW && p.y >= modeToggleY && p.y <= modeToggleY + modeToggleH) {
        _stripSacrificeBoth = !_stripSacrificeBoth;
        // Recompute P2 with new mode
        let h1d = ((Math.round(_playerHue1) % 360) + 360) % 360;
        if (_colorPickerLocked) _playerHue2 = computeStripP2(h1d, _stripTradeoff).h2;
        applyHues();
        return;
      }
      // Check if click is on the Pareto graph area
      if (p.x >= gxL && p.x <= gxR && p.y >= gyT && p.y <= gyB) {
        draggingGraph = true;
        let frac = Math.max(0, Math.min(1, (p.x - gxL) / (gxR - gxL)));
        _stripTradeoff = Math.round(frac * 180);
        applyHues();
        return;
      }
      let padX = 30, cellW = (stripW - padX) / 36;
      let col = Math.floor((p.x - padX) / cellW);
      if (col >= 0 && col < 36) {
        _playerHue1 = _stripHues[col];
        let h1d = ((Math.round(_playerHue1) % 360) + 360) % 360;
        if (_colorPickerLocked) _playerHue2 = computeStripP2(h1d, _stripTradeoff).h2;
        checkDetent(1, _playerHue1);
        applyHues();
      }
      return;
    }'''

new_mousedown_strip = '''    if (_displayMode === 'strip') {
      let p = canvasCoords(e);
      let padX = 30, cellW = (stripW - padX) / 36;
      // Third strip vertical layout (must match drawStripView)
      let y_s3 = 80 + 100 + 30 + 18 + 30 + 100 + 6 + 2;  // y_p1b+p1BH+p1DH+gapH+p2DH+p2BH+gap+2
      let s3H = 100;
      // Check mode toggle click
      if (p.x >= modeToggleX && p.x <= modeToggleX + modeToggleW && p.y >= modeToggleY && p.y <= modeToggleY + modeToggleH) {
        _stripSacrificeBoth = !_stripSacrificeBoth;
        let h1d = ((Math.round(_playerHue1) % 360) + 360) % 360;
        let selIdx = hueToStripIdx(_playerHue1);
        if (_colorPickerLocked) _playerHue2 = computeStripP2(h1d, _stripPerHueTradeoff[selIdx]).h2;
        applyHues();
        return;
      }
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
    }'''

code = code.replace(old_mousedown_strip, new_mousedown_strip)

# ── 4. Update mouseup to also release slider drag ──
old_mouseup = '''  canvas.addEventListener('mouseup', function () {
    if (draggingGraph) {
      draggingGraph = false;
      canvas.style.cursor = '';
    }
  });'''

new_mouseup = '''  canvas.addEventListener('mouseup', function () {
    if (draggingGraph) {
      draggingGraph = false;
      canvas.style.cursor = '';
    }
    if (draggingSlider >= 0) {
      draggingSlider = -1;
      canvas.style.cursor = '';
    }
  });'''

code = code.replace(old_mouseup, new_mouseup)

# ── 5. Update mousemove for graph drag updating P2 + slider drag + third strip hover ──
old_mousemove_strip = '''    if (_displayMode === 'strip') {
      let p = canvasCoords(e);
      // Graph drag in progress
      if (draggingGraph) {
        let frac = Math.max(0, Math.min(1, (p.x - gxL) / (gxR - gxL)));
        _stripTradeoff = Math.round(frac * 180);
        canvas.style.cursor = 'grabbing';
        applyHues();
        return;
      }
      // Check graph hover for cursor
      if (p.x >= gxL && p.x <= gxR && p.y >= gyT && p.y <= gyB) {
        canvas.style.cursor = 'grab';
        return;
      }
      // Check mode toggle hover
      if (p.x >= modeToggleX && p.x <= modeToggleX + modeToggleW && p.y >= modeToggleY && p.y <= modeToggleY + modeToggleH) {
        canvas.style.cursor = 'pointer';
        return;
      }
      let padX = 30, cellW = (stripW - padX) / 36;
      let col = Math.floor((p.x - padX) / cellW);
      let newHH = (col >= 0 && col < 36) ? _stripHues[col] : -1;
      canvas.style.cursor = (newHH >= 0) ? 'pointer' : '';
      if (newHH !== hoverHue) { hoverHue = newHH; drawRing(); }
      return;
    }'''

new_mousemove_strip = '''    if (_displayMode === 'strip') {
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
      // Check mode toggle hover
      if (p.x >= modeToggleX && p.x <= modeToggleX + modeToggleW && p.y >= modeToggleY && p.y <= modeToggleY + modeToggleH) {
        canvas.style.cursor = 'pointer';
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
    }'''

code = code.replace(old_mousemove_strip, new_mousemove_strip)

# ── 6. Update wheel handler to use per-hue tradeoff ──
old_wheel_p2 = '''      if (_colorPickerLocked) _playerHue2 = computeStripP2(h1d, _stripTradeoff).h2;
      checkDetent(1, _playerHue1);
      applyHues();
      return;
    }
    scrollAccum += e.deltaY;'''

new_wheel_p2 = '''      let newIdx = hueToStripIdx(_playerHue1);
      if (_colorPickerLocked) _playerHue2 = computeStripP2(h1d, _stripPerHueTradeoff[newIdx]).h2;
      checkDetent(1, _playerHue1);
      applyHues();
      return;
    }
    scrollAccum += e.deltaY;'''

code = code.replace(old_wheel_p2, new_wheel_p2)

# ── 7. Add draggingSlider variable next to draggingGraph ──
code = code.replace(
    '  let draggingGraph = false;',
    '  let draggingGraph = false;\n  let draggingSlider = -1;  // index of column being slider-dragged, or -1'
)

with open(FILE, 'w') as f:
    f.write(code)

lines2 = code.split('\n')
print(f"Done. New file has {len(lines2)} lines")
