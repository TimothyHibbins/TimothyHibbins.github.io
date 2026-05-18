const TRACKED_TEXT_SHADOW = '-1px 0 0 #000, 1px 0 0 #000, 0 -1px 0 #000, 0 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000';

const GREYSCALE_STOPS = [
    [78, 82, 87],
    [128, 132, 138],
    [184, 188, 194],
    [232, 235, 239]
];

// Purple-to-orange heatmap for contiguous-packed cells.
const PACKED_HEATMAP_STOPS = [
    [118, 30, 200],   // deep violet (low values)
    [196, 58, 168],   // magenta-purple
    [241, 97, 50],    // red-orange
    [255, 162, 30]    // orange-yellow (high values)
];

// Highlight colours for the packed display. Must contrast well against the
// purple-to-orange heatmap, so we use greens / cyans / yellow-greens.
const PACKED_HIGHLIGHT_COLORS = {
    write: [50, 230, 100],   // bright green
    origin: [40, 210, 210],   // cyan
    decompress: [50, 230, 100],   // bright green
    scan: [200, 240, 45],   // yellow-green
    predicted: [200, 240, 45],   // yellow-green
    next: [40, 210, 210],   // cyan
    compare: [255, 255, 255],  // white fallback
};

const TRACK_ROLE_COLORS = {
    origin: [92, 141, 255],
    predicted: [255, 160, 84],
    next: [172, 130, 255],
    left: [90, 150, 255],
    right: [255, 110, 170],
    pivot: [255, 190, 92],
    min: [55, 185, 145],
    max: [255, 88, 116],
    scan: [178, 128, 255],
    anchor: [112, 203, 95],
    key: [255, 145, 110],
    write: [255, 122, 74],
    decompress: [255, 122, 74],
    current: [0, 188, 212],
    compare: [120, 175, 255]
};

const ROLE_LABELS = {
    origin: 'Origin',
    predicted: 'Predicted Index',
    next: 'Step Toward Gap',
    left: 'Left Compare',
    right: 'Right Compare',
    pivot: 'Pivot',
    min: 'Min',
    max: 'Max',
    scan: 'Scan/Index Check',
    anchor: 'Anchor',
    key: 'Key',
    write: 'Write',
    current: 'Current',
    compare: 'Compare'
};

const ROLE_DISPLAY_ORDER = [
    'origin', 'predicted', 'next', 'scan', 'left', 'right', 'pivot',
    'min', 'max', 'anchor', 'key', 'write', 'current', 'compare'
];

const SORT_RUN_TIMEOUT_MS = 1200;
const SORT_RUN_MAX_TICKS = 250000;
const SORTLAB_CACHE_KEY = 'sortlab.cache.v1';

function clampChannel(value) {
    return Math.max(0, Math.min(255, Math.round(value)));
}

function interpolateRgb(stops, t) {
    if (t <= 0) {
        return [...stops[0]];
    }
    if (t >= 1) {
        return [...stops[stops.length - 1]];
    }

    const scaled = t * (stops.length - 1);
    const index = Math.floor(scaled);
    const localT = scaled - index;
    const start = stops[index];
    const end = stops[index + 1];

    return [
        clampChannel(start[0] + (end[0] - start[0]) * localT),
        clampChannel(start[1] + (end[1] - start[1]) * localT),
        clampChannel(start[2] + (end[2] - start[2]) * localT)
    ];
}

function mixRgb(base, overlay, alpha) {
    return [
        clampChannel(base[0] * (1 - alpha) + overlay[0] * alpha),
        clampChannel(base[1] * (1 - alpha) + overlay[1] * alpha),
        clampChannel(base[2] * (1 - alpha) + overlay[2] * alpha)
    ];
}

function rgbToString(rgb) {
    return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

function getGreyscaleRgb(value, minValue, maxValue) {
    if (value === null || value === undefined || Number.isNaN(value)) {
        return [241, 245, 249];
    }
    const span = maxValue - minValue;
    const t = span <= 0 ? 0 : (value - minValue) / span;
    return interpolateRgb(GREYSCALE_STOPS, t);
}

function getPackedHeatmapRgb(value, minValue, maxValue) {
    if (value === null || value === undefined || Number.isNaN(value)) {
        return [60, 20, 100]; // dark purple for unknown/null
    }
    const span = maxValue - minValue;
    const t = span <= 0 ? 0 : (value - minValue) / span;
    return interpolateRgb(PACKED_HEATMAP_STOPS, t);
}

function getRoleAccentColor(role) {
    return TRACK_ROLE_COLORS[role] || TRACK_ROLE_COLORS.compare;
}

function getTextRgb(baseRgb) {
    const luminance = 0.2126 * baseRgb[0] + 0.7152 * baseRgb[1] + 0.0722 * baseRgb[2];
    const delta = luminance > 145 ? -28 : 32;

    return [
        clampChannel(baseRgb[0] + delta),
        clampChannel(baseRgb[1] + delta),
        clampChannel(baseRgb[2] + delta)
    ];
}

function setCellLabelContent(item, label) {
    const text = label === null || label === undefined ? '' : String(label);
    item.classList.remove('split-value-item');
    item.textContent = text;
}

// Renders a single cell as a 32-bit heatmap display — same visual language as contiguous-packed mode.
// isHighlighted: bright bits + text overlay; otherwise dimmed bits only.
function renderCellBitGrid(item, value, colorMin, colorMax, isHighlighted, labelText, heatmapValue = value, options = {}) {
    item.style.padding = '0';
    item.textContent = '';
    const root = document.createElement('div');
    root.className = 'packed-word-root';
    const numVal = Number(value);
    const heatVal = Number(heatmapValue);
    const heatmapRgb = getPackedHeatmapRgb(heatVal, colorMin, colorMax);
    const highlightSentinelBit = Boolean(options && options.highlightSentinelBit);
    const overwrittenWord = typeof (options && options.overwrittenWord) === 'boolean'
        ? Boolean(options.overwrittenWord)
        : (highlightSentinelBit && (((numVal >>> 31) & 1) === 1));
    const overwriteMarkerBit = Number.isFinite(options && options.overwriteMarkerBit)
        ? Math.max(0, Math.min(31, Math.floor(options.overwriteMarkerBit)))
        : 31;
    const showOverwriteMarker = Boolean(options && options.showOverwriteMarker);
    const overwriteFlippedThisRow = Boolean(options && options.overwriteFlippedThisRow);
    const hasLabelText = String(labelText ?? '').trim().length > 0;
    const stripeAsEmptySlots = overwrittenWord && !hasLabelText;
    const slotGroupBits = Number.isFinite(options && options.slotGroupBits)
        ? Math.max(0, Math.floor(options.slotGroupBits))
        : 0;
    const activeSpanBits = Number.isFinite(options && options.activeSpanBits)
        ? Math.max(1, Math.min(32, Math.floor(options.activeSpanBits)))
        : 32;
    const slotSegments = overwrittenWord && Array.isArray(options && options.slotSegments)
        ? options.slotSegments
        : null;
    const labelStartBit = Number.isFinite(options && options.labelStartBit)
        ? Math.max(0, Math.min(31, Math.floor(options.labelStartBit)))
        : 0;
    const highlightedBitRange = (options && options.highlightedBitRange
        && Number.isFinite(options.highlightedBitRange.start)
        && Number.isFinite(options.highlightedBitRange.width))
        ? {
            start: Math.max(0, Math.min(31, Math.floor(options.highlightedBitRange.start))),
            width: Math.max(1, Math.min(32, Math.floor(options.highlightedBitRange.width)))
        }
        : null;

    const findSlotSegment = (bit) => {
        if (!slotSegments) return null;
        for (let i = 0; i < slotSegments.length; i += 1) {
            const seg = slotSegments[i];
            if (!seg) continue;
            const start = Math.max(0, Math.min(31, Math.floor(seg.startBit || 0)));
            const width = Math.max(1, Math.min(32 - start, Math.floor(seg.width || 1)));
            if (bit >= start && bit < start + width) return seg;
        }
        return null;
    };

    for (let bit = 0; bit < 32; bit++) {
        const bitVal = (numVal >>> bit) & 1;
        const inActiveSpan = bit < activeSpanBits;
        const effectiveHighlight = isHighlighted && (!highlightedBitRange
            || (bit >= highlightedBitRange.start && bit < highlightedBitRange.start + highlightedBitRange.width));
        let rgb = effectiveHighlight
            ? (bitVal ? mixRgb(heatmapRgb, [0, 0, 0], 0.15) : mixRgb(heatmapRgb, [0, 0, 0], 0.35))
            : (bitVal ? mixRgb(heatmapRgb, [0, 0, 0], 0.72) : mixRgb(heatmapRgb, [0, 0, 0], 0.82));

        const slotSeg = findSlotSegment(bit);
        if (slotSeg) {
            const slotColorRgb = getPackedHeatmapRgb(Number(slotSeg.colorValue), colorMin, colorMax);
            if (slotSeg.filled) {
                rgb = effectiveHighlight
                    ? (bitVal ? mixRgb(slotColorRgb, [0, 0, 0], 0.18) : mixRgb(slotColorRgb, [0, 0, 0], 0.38))
                    : (bitVal ? mixRgb(slotColorRgb, [0, 0, 0], 0.74) : mixRgb(slotColorRgb, [0, 0, 0], 0.84));
            } else {
                const group = Number.isFinite(slotSeg.slot) ? slotSeg.slot : 0;
                rgb = (group % 2 === 0)
                    ? (effectiveHighlight ? [44, 48, 58] : [34, 38, 48])
                    : (effectiveHighlight ? [36, 40, 50] : [28, 32, 42]);
            }
        }

        // For overwritten predictive words, color only the active slot span.
        // Bits outside that span should look like empty slot regions.
        if (overwrittenWord && hasLabelText && !inActiveSpan) {
            const group = slotGroupBits > 0 ? Math.floor(bit / slotGroupBits) : 0;
            rgb = (group % 2 === 0)
                ? (effectiveHighlight ? [28, 31, 37] : [20, 22, 28])
                : (effectiveHighlight ? [22, 25, 31] : [15, 17, 23]);
        }

        // In predictive mode, make zero-bit slot regions easier to read by
        // alternating subtle dark greys per slot-sized group.
        if (stripeAsEmptySlots && slotGroupBits > 0 && bitVal === 0) {
            const group = Math.floor(bit / slotGroupBits);
            rgb = (group % 2 === 0)
                ? (effectiveHighlight ? [44, 48, 58] : [34, 38, 48])
                : (effectiveHighlight ? [36, 40, 50] : [28, 32, 42]);
        }

        // Keep the underlying value bit unchanged; overwrite status is shown via
        // a dedicated overlay marker so value bit patterns remain visually stable.
        const seg = document.createElement('span');
        seg.className = 'packed-word-seg packed-word-seg-value';
        seg.style.gridRow = '1';
        seg.style.gridColumn = String(bit + 1);
        seg.style.backgroundColor = rgbToString(rgb);
        if (showOverwriteMarker && bit === overwriteMarkerBit) {
            seg.style.boxShadow = 'none';
        }
        seg.style.borderRight = '1px solid rgba(0,0,0,0.35)';
        root.appendChild(seg);
    }
    if (showOverwriteMarker) {
        const marker = document.createElement('span');
        marker.className = 'packed-word-seg';
        marker.style.gridRow = '1';
        marker.style.gridColumn = `${overwriteMarkerBit + 1} / span 1`;
        marker.style.justifySelf = 'center';
        marker.style.width = '70%';
        marker.style.background = overwriteFlippedThisRow
            ? 'rgba(184, 255, 140, 0.92)'
            : (overwrittenWord
                ? 'rgba(64, 232, 120, 0.78)'
                : 'repeating-linear-gradient(to bottom, rgba(18,110,56,0.88) 0 2px, rgba(10,72,38,0.88) 2px 4px)');
        marker.style.boxShadow = overwriteFlippedThisRow
            ? 'inset 0 0 0 1px rgba(235,255,200,1)'
            : (overwrittenWord
                ? 'inset 0 0 0 1px rgba(168,255,204,0.98)'
                : 'inset 0 0 0 1px rgba(80,180,118,0.95)');
        marker.style.zIndex = '1';
        marker.style.pointerEvents = 'none';
        root.appendChild(marker);
    }
    if (isHighlighted && labelText !== null && labelText !== undefined) {
        const text = String(labelText).trim();
        if (text) {
            const overlay = document.createElement('span');
            overlay.className = 'packed-word-seg packed-word-seg-text-overlay';
            overlay.style.gridRow = '1';
            const labelSpanBits = highlightedBitRange
                ? Math.max(1, Math.min(32 - highlightedBitRange.start, highlightedBitRange.width))
                : (Number.isFinite(options && options.labelSpanBits)
                    ? Math.max(1, Math.min(32, Math.floor(options.labelSpanBits)))
                    : 32);
            const effectiveLabelStartBit = highlightedBitRange ? highlightedBitRange.start : labelStartBit;
            const labelStart = Math.max(1, Math.min(32, effectiveLabelStartBit + 1));
            overlay.style.gridColumn = `${labelStart} / span ${labelSpanBits}`;
            overlay.textContent = text;
            overlay.style.color = rgbToString(heatmapRgb);
            overlay.style.fontWeight = 'bold';
            overlay.style.textShadow = TRACKED_TEXT_SHADOW;
            // Fit text to slot width; never ellipsize slot labels.
            const ratio = labelSpanBits / Math.max(1, text.length);
            const fitSize = Math.max(5, Math.min(14, Math.floor(ratio * 6)));
            overlay.style.fontSize = `${fitSize}px`;
            overlay.style.overflow = 'visible';
            overlay.style.textOverflow = 'clip';
            overlay.style.whiteSpace = 'nowrap';
            root.appendChild(overlay);
        }
    }
    item.appendChild(root);
}

// Renders ALL packed word cells as a SINGLE element with one (n×32)-column grid.
// Separates BACKGROUND fragments (exact bit ranges, no text) from TEXT OVERLAYS
// (transparent, spanning the full valueBits range, z-index:1) so text is always
// centred over the complete value width regardless of word-boundary position.
// trackedSet: Set of array indices that are currently highlighted.
// trackedMap: Map<logicalValueIdx, primaryRole> — logical value slots currently written/read.
function renderContiguousPackedFullRow(item, step, n, predictiveBits, colorMinValue, colorMaxValue, trackedMap) {
    item.textContent = '';
    item.style.backgroundColor = '#111';
    item.style.border = 'none';

    const root = document.createElement('div');
    root.className = 'packed-word-root';
    root.style.background = '#111';
    root.style.gridTemplateColumns = `repeat(${n * 32}, minmax(0, 1fr))`;

    const valueBits = (predictiveBits && Number.isFinite(predictiveBits.valueBits))
        ? predictiveBits.valueBits : 0;
    const totalBits = n * 32;
    const occupied = new Array(totalBits).fill(false);

    // Build a map for count-lane tracking (count cells being written this step).
    const countTrackedMap = new Map();
    if (Array.isArray(step.trackedIndices)) {
        for (const entry of step.trackedIndices) {
            if (entry.lane === 'count') countTrackedMap.set(entry.index, entry.role);
        }
    }

    const parseNumericToken = (token) => {
        const stripped = String(token).replace(/^~/, '').split('×')[0].trim();
        const num = Number(stripped);
        return Number.isFinite(num) ? num : null;
    };
    const parseMetaToken = (token) => {
        const match = /^@(\d+):(\d+):(.*)$/.exec(String(token).trim());
        if (!match) return null;
        return { bitOffset: Number(match[1]), bitWidth: Number(match[2]), label: match[3] };
    };

    // Per-bit coloured segment.
    //   borderLeft – draw a value/region separator on the first bit of the segment.
    //   isCount    – slight dimming to visually distinguish the count region.
    //   directBits – when provided, read bit values from this integer rather than
    //                step.values (used for src: placeholders where values[] is zero).
    //   accentColor – when non-null the cell is highlighted: blend accent into background;
    //                 otherwise apply extra darkening so highlighted cells stand out.
    const appendBitSegment = (tokenNum, globalStart, globalWidth, extraClass, borderLeft = false, isCount = false, directBits = null, accentColor = null) => {
        if (globalStart < 0 || globalStart >= totalBits) return;
        const heatmapRgb = tokenNum !== null
            ? getPackedHeatmapRgb(tokenNum, colorMinValue, colorMaxValue)
            : [60, 20, 100];
        for (let i = 0; i < globalWidth; i++) {
            const bitGlobal = globalStart + i;
            if (bitGlobal >= totalBits) break;
            const wIdx = Math.floor(bitGlobal / 32);
            const bitPos = bitGlobal % 32;
            const bitVal = directBits !== null
                ? ((directBits >>> i) & 1)
                : ((Number(step.values[wIdx]) >>> bitPos) & 1);
            let rgb;
            // Mix toward black only — keeps full saturation, only changes brightness.
            // Same absolute brightness delta (BIT_DELTA) in both highlighted and non states.
            const BIT_DARK = isCount ? 0.88 : 0.82;
            const BIT_LIGHT = isCount ? 0.60 : 0.55;
            if (accentColor) {
                rgb = bitVal === 1
                    ? mixRgb(heatmapRgb, [0, 0, 0], 0.15)
                    : mixRgb(heatmapRgb, [0, 0, 0], 0.50);
            } else {
                rgb = bitVal === 1
                    ? mixRgb(heatmapRgb, [0, 0, 0], BIT_LIGHT)
                    : mixRgb(heatmapRgb, [0, 0, 0], BIT_DARK);
            }
            const seg = document.createElement('span');
            seg.className = `packed-word-seg ${extraClass}`;
            seg.style.gridRow = '1';
            seg.style.gridColumn = String(bitGlobal + 1);
            seg.style.backgroundColor = rgbToString(rgb);
            seg.style.borderRight = '1px solid rgba(0,0,0,0.35)';
            if (borderLeft && i === 0) {
                seg.style.borderLeft = '2px solid rgba(0,0,0,0.65)';
            }
            occupied[bitGlobal] = true;
            root.appendChild(seg);
        }
    };

    // Text overlay — only rendered when the cell is actively tracked (accentColor != null).
    // Colour = midpoint between the 1-bit and 0-bit heatmap colours for this token.
    const appendTextOverlay = (label, valueStart, valueWidth, accentColor, heatRgb = null) => {
        if (!accentColor) return;
        const actualWidth = Math.min(valueWidth, totalBits - valueStart);
        if (actualWidth <= 0 || valueStart < 0 || valueStart >= totalBits) return;
        const displayText = String(label).replace(/^~/, '').trim();
        if (!displayText) return;
        const overlay = document.createElement('span');
        overlay.className = 'packed-word-seg packed-word-seg-text-overlay';
        overlay.style.gridRow = '1';
        overlay.style.gridColumn = `${valueStart + 1} / span ${actualWidth}`;
        overlay.textContent = displayText;
        overlay.style.color = heatRgb ? rgbToString(heatRgb) : 'rgba(255,255,255,0.95)';
        overlay.style.fontWeight = 'bold';
        overlay.style.textShadow = TRACKED_TEXT_SHADOW;
        const ratio = actualWidth / Math.max(1, displayText.length);
        overlay.style.fontSize = ratio >= 3 ? '14px' : ratio >= 2 ? '11px' : ratio >= 1.5 ? '9px' : '7px';
        root.appendChild(overlay);
    };

    for (let wordIdx = 0; wordIdx < n; wordIdx++) {
        const value = step.values[wordIdx];
        if (value === null || value === undefined) continue;
        const displayLabel = Array.isArray(step.displayValues) ? step.displayValues[wordIdx] : undefined;
        const splitLabel = splitDisplayLabel(displayLabel, value);
        const cleanPrimary = String(splitLabel.primary || '').trim();

        // Plain (src: or final phase) — wordIdx is both word index and logical value index.
        if (cleanPrimary.startsWith('src:') || (!cleanPrimary.includes('@') && cleanPrimary !== '')) {
            const label = cleanPrimary.startsWith('src:') ? cleanPrimary.slice(4) : cleanPrimary;
            const tokenNum = parseNumericToken(label);
            const role = trackedMap ? trackedMap.get(wordIdx) : null;
            const accentColor = role ? (PACKED_HIGHLIGHT_COLORS[role] || PACKED_HIGHLIGHT_COLORS.compare) : null;
            // For src: tokens the backing array was zeroed; show bits of the label value.
            // For final-phase tokens the array holds the real value; read from step.values.
            const isSrc = cleanPrimary.startsWith('src:');
            appendBitSegment(tokenNum, wordIdx * 32, 32, 'packed-word-seg-value', wordIdx > 0, false, isSrc ? tokenNum : null, accentColor);
            const heatRgb = tokenNum !== null ? getPackedHeatmapRgb(tokenNum, colorMinValue, colorMaxValue) : null;
            appendTextOverlay(label, wordIdx * 32, 32, accentColor, heatRgb);
            continue;
        }

        // Packed value tokens — global bit offsets.
        // Pass 1: per-bit background for every token (leading + continuation).
        const primaryTokens = cleanPrimary ? cleanPrimary.split(/\s+/).filter(Boolean) : [];
        primaryTokens.forEach((token) => {
            const meta = parseMetaToken(token);
            if (!meta) return;
            const isContinuation = String(meta.label).startsWith('~');
            const tokenNum = parseNumericToken(meta.label);
            const logicalIdx1 = valueBits > 0 ? Math.floor(meta.bitOffset / valueBits) : wordIdx;
            const role1 = trackedMap ? trackedMap.get(logicalIdx1) : null;
            const tokenAccent = role1 ? (PACKED_HIGHLIGHT_COLORS[role1] || PACKED_HIGHLIGHT_COLORS.compare) : null;
            const sep = !isContinuation && meta.bitOffset > 0;
            appendBitSegment(tokenNum, meta.bitOffset, meta.bitWidth, 'packed-word-seg-value', sep, false, null, tokenAccent);
        });

        // Pass 2: one text overlay per leading (non-~) token spanning full valueBits.
        // KEY FIX: look up trackedMap by LOGICAL value index = bitOffset / valueBits,
        // NOT by word array index. Multiple logical values share the same word when
        // valueBits < 32, so wordIdx would map to the wrong highlight.
        primaryTokens.forEach((token) => {
            const meta = parseMetaToken(token);
            if (!meta || String(meta.label).startsWith('~')) return;
            const logicalIdx = valueBits > 0 ? Math.floor(meta.bitOffset / valueBits) : wordIdx;
            const role = trackedMap ? trackedMap.get(logicalIdx) : null;
            const accentColor = role ? (PACKED_HIGHLIGHT_COLORS[role] || PACKED_HIGHLIGHT_COLORS.compare) : null;
            const overlayWidth = valueBits > 0 ? valueBits : meta.bitWidth;
            const tokenNum2 = parseNumericToken(meta.label);
            const heatRgb2 = tokenNum2 !== null ? getPackedHeatmapRgb(tokenNum2, colorMinValue, colorMaxValue) : null;
            appendTextOverlay(String(meta.label || '').trim(), meta.bitOffset, overlayWidth, accentColor, heatRgb2);
        });

        // Count/bin tokens — skip bits already claimed by value tokens.
        // Bit offsets in display metadata are always PHYSICAL positions in step.values[],
        // so we read directly from step.values — no directBits override needed.
        const cleanSecondary = String(splitLabel.secondary || '').trim();
        const secondaryTokens = cleanSecondary ? cleanSecondary.split(',').map((s) => s.trim()).filter(Boolean) : [];
        secondaryTokens.forEach((token) => {
            const meta = parseMetaToken(token);
            if (!meta) return;
            for (let b = meta.bitOffset; b < meta.bitOffset + meta.bitWidth; b++) {
                if (b >= 0 && b < totalBits && occupied[b]) return;
            }
            const tokenNum = parseNumericToken(meta.label);
            // Determine if this count bucket is being written this step.
            let countAccent = null;
            if (countTrackedMap.size > 0 && predictiveBits && predictiveBits.packedBits != null) {
                const tailStart = predictiveBits.packedBits;
                let key = -1;
                if (predictiveBits.layout === 'direct' && predictiveBits.countBits > 0) {
                    key = Math.round((meta.bitOffset - tailStart) / predictiveBits.countBits);
                } else if (predictiveBits.layout === 'bins') {
                    // Bins use variable-width slots; track key = slot's bit offset directly.
                    key = meta.bitOffset;
                }
                if (key >= 0) {
                    const role = countTrackedMap.get(key);
                    if (role) countAccent = PACKED_HIGHLIGHT_COLORS[role] || PACKED_HIGHLIGHT_COLORS.write;
                }
            }
            appendBitSegment(tokenNum, meta.bitOffset, meta.bitWidth, 'packed-word-seg-count', true, true, null, countAccent);
            if (countAccent) {
                const countLabelText = String(meta.label || '').trim();
                const countHeatRgb = tokenNum !== null ? getPackedHeatmapRgb(tokenNum, colorMinValue, colorMaxValue) : null;
                appendTextOverlay(countLabelText, meta.bitOffset, meta.bitWidth, countAccent, countHeatRgb);
            }
        });
    }

    // Add thin separator spans for any unoccupied (zeroed) bit positions so the
    // bit grid is uniform — zero regions otherwise have no borders at all.
    for (let b = 0; b < totalBits; b++) {
        if (!occupied[b]) {
            const zeroSep = document.createElement('span');
            zeroSep.style.gridRow = '1';
            zeroSep.style.gridColumn = String(b + 1);
            zeroSep.style.borderRight = '1px solid rgba(0,0,0,0.40)';
            root.appendChild(zeroSep);
        }
    }

    item.appendChild(root);
}

function splitDisplayLabel(label, fallbackValue) {
    const baseText = label === null || label === undefined ? String(fallbackValue ?? '') : String(label);
    const separatorIndex = baseText.indexOf('|');
    if (separatorIndex === -1) {
        return { primary: baseText, secondary: '' };
    }
    return {
        primary: baseText.slice(0, separatorIndex).trim(),
        secondary: baseText.slice(separatorIndex + 1).trim()
    };
}

function resolvePredictivePrimaryValue(rawValue, splitLabel, predictiveBits, minValue) {
    const primaryNum = Number(splitLabel.primary);
    if (Number.isFinite(primaryNum)) {
        return primaryNum;
    }

    if (
        predictiveBits
        && Number.isFinite(predictiveBits.valueBits)
        && predictiveBits.valueBits > 0
        && predictiveBits.valueBits < 31
        && Number.isFinite(minValue)
    ) {
        const valueBits = predictiveBits.valueBits;
        const valueMask = (1 << valueBits) - 1;
        const relVal = (Number(rawValue) >>> 0) & valueMask;
        return relVal + Number(minValue);
    }

    const secondaryMatch = String(splitLabel.secondary || '').match(/-?\d+(?:\.\d+)?/);
    if (secondaryMatch) {
        const secondaryNum = Number(secondaryMatch[0]);
        if (Number.isFinite(secondaryNum)) {
            return secondaryNum;
        }
    }

    const rawNum = Number(rawValue);
    return Number.isFinite(rawNum) ? rawNum : 0;
}

function resolvePredictiveCellLabel(rawValue, splitLabel, predictiveBits, minValue) {
    const primaryText = String(splitLabel.primary || '').trim();
    if (primaryText) {
        return primaryText;
    }

    const secondaryText = String(splitLabel.secondary || '').trim();
    if (secondaryText) {
        const ownerMatch = secondaryText.match(/^(-?\d+)\s*[x\u00d7]\s*(\d+)/i);
        if (ownerMatch) {
            return `${ownerMatch[1]}x${ownerMatch[2]}`;
        }
        const basisMatch = secondaryText.match(/^basis\s*:\s*(-?\d+)/i);
        if (basisMatch) {
            return `b:${basisMatch[1]}`;
        }
        const countMatch = secondaryText.match(/^count\s*:\s*(-?\d+)/i);
        if (countMatch) {
            return `c:${countMatch[1]}`;
        }
        return secondaryText;
    }

    return String(resolvePredictivePrimaryValue(rawValue, splitLabel, predictiveBits, minValue));
}

function resolvePredictiveColorValue(rawValue, splitLabel, predictiveBits, minValue) {
    const primaryText = String(splitLabel.primary ?? '').trim();
    const primaryNum = primaryText ? Number(primaryText) : NaN;
    if (Number.isFinite(primaryNum)) {
        return primaryNum;
    }

    const secondaryText = String(splitLabel.secondary || '').trim();
    if (secondaryText) {
        const ownerMatch = secondaryText.match(/^(-?\d+)\s*[x\u00d7]\s*\d+/i);
        if (ownerMatch) {
            const ownerValue = Number(ownerMatch[1]);
            if (Number.isFinite(ownerValue)) return ownerValue;
        }
        // Metadata cells (basis/count) should not be colour-mapped as array values.
        if (/^(basis|count)\s*:/i.test(secondaryText)) {
            return Number.isFinite(minValue) ? minValue : 0;
        }
    }

    return resolvePredictivePrimaryValue(rawValue, splitLabel, predictiveBits, minValue);
}

function renderContiguousPackedWordCell(item, wordIndex, primaryText, secondaryText, predictiveBits, colorMinValue, colorMaxValue) {
    item.classList.add('main-packed-cell', 'packed-word-cell');
    item.textContent = '';
    // Use solid dark background. This ensures any sub-pixel gap between adjacent
    // packed cells shows as dark (matching the zero-bit fill), not white.
    item.style.backgroundColor = '#111';
    item.style.border = 'none';

    const root = document.createElement('div');
    root.className = 'packed-word-root';
    // Zero bits are represented by the root's own dark background — no individual
    // zero-fill span elements needed, which also eliminates sub-pixel gaps.
    root.style.background = '#111';

    const wordStart = wordIndex * 32;
    // valueBits from predictiveBits lets us determine the majority fragment for
    // cross-boundary values so the label appears in the wider fragment only.
    const valueBits = (predictiveBits && Number.isFinite(predictiveBits.valueBits))
        ? predictiveBits.valueBits : 0;
    // occupied is only needed to prevent secondary (count) tokens from overlapping
    // value tokens – it is no longer used for zero-fill.
    const occupied = new Array(32).fill(false);

    // Extract numeric value from a label, handling ~val continuation markers.
    const parseNumericToken = (token) => {
        const stripped = String(token).replace(/^~/, '').split('×')[0].trim();
        const num = Number(stripped);
        return Number.isFinite(num) ? num : null;
    };

    const parseMetaToken = (token) => {
        const match = /^@(\d+):(\d+):(.*)$/.exec(String(token).trim());
        if (!match) return null;
        return { bitOffset: Number(match[1]), bitWidth: Number(match[2]), label: match[3] };
    };

    // Place a segment in the single row.
    // For cross-boundary values the label only appears in the fragment that covers
    // at least half of the total value width (valueBits), centering text visually.
    const appendSeg = (label, localStartBit, span, extraClass) => {
        const localStart = Math.max(0, localStartBit);
        const localEnd = Math.min(32, localStartBit + span);
        const actualSpan = localEnd - localStart;
        if (actualSpan <= 0) return;
        const seg = document.createElement('span');
        seg.className = `packed-word-seg ${extraClass}`;
        seg.style.gridRow = '1';
        seg.style.gridColumn = `${localStart + 1} / span ${actualSpan}`;
        const displayText = String(label).replace(/^~/, '').trim();
        // Show text only in the leading fragment (no ~ prefix).
        // Continuation tokens (~label) mark the portion of a cross-word-boundary
        // value that spills into the next word — suppress their text so the label
        // appears exactly once, in the word where the value starts.
        const showText = !String(label).startsWith('~');
        seg.textContent = showText ? displayText : '';
        const tokenNum = parseNumericToken(label);
        if (tokenNum !== null) {
            const rgb = getGreyscaleRgb(tokenNum, colorMinValue, colorMaxValue);
            seg.style.backgroundColor = rgbToString(rgb);
            seg.style.color = showText ? rgbToString(getTextRgb(rgb)) : 'transparent';
        }
        // Scale font to fit the fragment width.
        if (showText && displayText.length > 0) {
            const ratio = actualSpan / displayText.length;
            seg.style.fontSize = ratio >= 3 ? '14px' : ratio >= 2 ? '11px' : ratio >= 1.5 ? '9px' : '7px';
        }
        for (let b = localStart; b < localEnd; b++) occupied[b] = true;
        root.appendChild(seg);
    };

    // fillZero is no longer used – the root background provides zero-bit fill.

    const cleanPrimary = String(primaryText || '').trim();

    // Plain final-phase value or source word: full-width single cell.
    if (cleanPrimary.startsWith('src:') || (!cleanPrimary.includes('@') && cleanPrimary !== '')) {
        const label = cleanPrimary.startsWith('src:') ? cleanPrimary.slice(4) : cleanPrimary;
        appendSeg(label, 0, 32, 'packed-word-seg-value');
        item.appendChild(root);
        return;
    }

    // Primary tokens: packed value segments placed by exact bit position.
    const primaryTokens = cleanPrimary ? cleanPrimary.split(/\s+/).filter(Boolean) : [];
    primaryTokens.forEach((token) => {
        const meta = parseMetaToken(token);
        if (!meta) return;
        appendSeg(String(meta.label || '').trim(), meta.bitOffset - wordStart, meta.bitWidth, 'packed-word-seg-value');
    });

    // Secondary tokens: count/bin segments placed in unoccupied columns only.
    // (Value segments take priority; counts are skipped if bits were overwritten.)
    const cleanSecondary = String(secondaryText || '').trim();
    const secondaryTokens = cleanSecondary ? cleanSecondary.split(',').map((s) => s.trim()).filter(Boolean) : [];
    secondaryTokens.forEach((token) => {
        const meta = parseMetaToken(token);
        if (!meta) return;
        const localStart = meta.bitOffset - wordStart;
        const localEnd = localStart + meta.bitWidth;
        for (let b = Math.max(0, localStart); b < Math.min(32, localEnd); b++) {
            if (occupied[b]) return; // value token already here — skip
        }
        appendSeg(String(meta.label || '').trim(), localStart, meta.bitWidth, 'packed-word-seg-count');
    });

    // Add separator spans for unoccupied bit positions.
    for (let b = 0; b < 32; b++) {
        if (!occupied[b]) {
            const zeroSep = document.createElement('span');
            zeroSep.style.gridRow = '1';
            zeroSep.style.gridColumn = String(b + 1);
            zeroSep.style.borderRight = '1px solid rgba(0,0,0,0.40)';
            root.appendChild(zeroSep);
        }
    }

    item.appendChild(root);
}

function toFullBinary32(intValue) {
    return (intValue >>> 0).toString(2).padStart(32, '0');
}

function formatBinaryValue(value, predictiveCountingMode = false) {
    if (!Number.isFinite(value)) {
        return '';
    }

    if (Number.isInteger(value)) {
        return `0b${toFullBinary32(value)}`;
    }

    return '';
}

function formatContiguousTailBitsForWord(cell, wordIndex, predictiveBits) {
    if (!predictiveBits || predictiveBits.mode !== 'contiguousPacked') {
        return formatBinaryValue(cell, true);
    }
    const packedBits = Number.isFinite(predictiveBits.packedBits) ? predictiveBits.packedBits : 0;
    const wordStart = wordIndex * 32;
    const wordEnd = wordStart + 32;
    const tailStart = Math.max(packedBits, wordStart);
    const tailEnd = wordEnd;
    if (tailStart >= tailEnd) {
        return '<span class="delta-tooltip-meta">no synthetic bits in this word</span>';
    }

    const localStart = tailStart - wordStart;
    const localEnd = tailEnd - wordStart;
    const word = cell >>> 0;
    const fullBits = toFullBinary32(word);
    const packedInWord = Math.max(0, Math.min(wordEnd, packedBits) - wordStart);
    const tailLen = localEnd - localStart;
    const tailPart = fullBits.slice(0, tailLen);
    const packedPart = fullBits.slice(tailLen);

    const tailRange = `${tailStart}-${tailEnd - 1}`;
    const packedRange = packedInWord > 0
        ? `${wordStart}-${wordStart + packedInWord - 1}`
        : 'none';

    return `<span class="delta-tooltip-meta">tail/count bits [${tailRange}]</span><br>` +
        `<span class="bin-bits-count">${tailPart}</span>` +
        `<span class="delta-tooltip-meta"> packed bits [${packedRange}]</span><br>` +
        `<span class="bin-bits-orig">${packedPart}</span>`;
}

function getDeltaBucketAnchorRel(bucketIndex, bucketCount, range) {
    if (bucketCount <= 1 || range <= 0) {
        return 0;
    }
    return Math.round((bucketIndex / (bucketCount - 1)) * range);
}

function getDeltaBucketPerfectValue(bucketIndex, bucketCount, minValue, maxValue) {
    const min = Number.isFinite(minValue) ? minValue : 0;
    const max = Number.isFinite(maxValue) ? maxValue : min;
    const range = max - min;
    return min + getDeltaBucketAnchorRel(bucketIndex, bucketCount, range);
}

function decodeDeltaBucketSlots(cell, bucketIndex, bucketCount, predictiveBits, minValue, maxValue) {
    const slotsPerCell = Number.isFinite(predictiveBits && predictiveBits.slotsPerCell)
        ? predictiveBits.slotsPerCell
        : 0;
    const valueBits = Number.isFinite(predictiveBits && predictiveBits.valueBits)
        ? predictiveBits.valueBits
        : 0;
    const deltaBits = Number.isFinite(predictiveBits && predictiveBits.deltaBits)
        ? predictiveBits.deltaBits
        : 0;
    const countBits = Number.isFinite(predictiveBits && predictiveBits.countBits)
        ? predictiveBits.countBits
        : 0;
    const deltaMax = Number.isFinite(predictiveBits && predictiveBits.deltaMax)
        ? predictiveBits.deltaMax
        : 0;
    const flagMode = Boolean(predictiveBits && predictiveBits.flagMode);

    if (slotsPerCell <= 0 || deltaBits <= 0) {
        return [];
    }
    if (!flagMode && countBits <= 0) {
        return [];
    }

    // In displacement-chain mode, count-table cells (bits 31-30 = 11) must not be
    // decoded as slot data — they are compacted (relVal, count) entries.
    if (valueBits === 0 && ((cell >>> 0) >>> 30) === 3) return [];

    const min = Number.isFinite(minValue) ? minValue : 0;
    const max = Number.isFinite(maxValue) ? maxValue : min;
    const range = max - min;
    const anchorRel = getDeltaBucketAnchorRel(bucketIndex, bucketCount, range);

    const pairBits = flagMode ? (deltaBits + 1) : (deltaBits + countBits);
    const deltaMask = (1 << deltaBits) - 1;
    const pairMask = (1 << pairBits) - 1;

    const slots = [];

    if (flagMode) {
        const flagBit = 1 << deltaBits;
        let s = 0;
        while (s < slotsPerCell) {
            const shift = valueBits + s * pairBits;
            const word = shift < 32 ? (((cell >>> 0) >>> shift) & pairMask) : 0;
            if (word === 0) {
                slots.push({
                    slot: s, label: '', colorValue: min, isEmpty: true,
                    deltaEnc: 0, delta: 0, count: 0, representedValue: null, valid: false
                });
                s += 1;
                continue;
            }
            const storedDelta = word & deltaMask;
            const hasFlag = Boolean(word & flagBit);
            const deltaEnc = storedDelta - 1;
            const delta = deltaEnc - deltaMax;
            const rel = anchorRel + delta;
            const valid = rel >= 0 && rel <= range;
            const absValue = rel + min;

            if (hasFlag && s + 1 < slotsPerCell) {
                const countShift = valueBits + (s + 1) * pairBits;
                const count = countShift < 32 ? (((cell >>> 0) >>> countShift) & pairMask) : 0;
                // Delta+flag slot
                slots.push({
                    slot: s,
                    label: valid ? `${absValue} \u00d7${count}` : `? \u00d7${count}`,
                    colorValue: valid ? absValue : min,
                    isEmpty: false, deltaEnc, delta, count,
                    representedValue: valid ? absValue : null, valid
                });
                // Count slot (same colour as its delta pair)
                slots.push({
                    slot: s + 1, label: '',
                    colorValue: valid ? absValue : min,
                    isEmpty: false, deltaEnc, delta, count,
                    representedValue: valid ? absValue : null, valid, isCountSlot: true
                });
                s += 2;
            } else if (!hasFlag) {
                slots.push({
                    slot: s,
                    label: valid ? `${absValue}` : '?',
                    colorValue: valid ? absValue : min,
                    isEmpty: false, deltaEnc, delta, count: 1,
                    representedValue: valid ? absValue : null, valid
                });
                s += 1;
            } else {
                // Malformed: flag=1 but no adjacent slot. Treat as empty.
                slots.push({
                    slot: s, label: '', colorValue: min, isEmpty: true,
                    deltaEnc: 0, delta: 0, count: 0, representedValue: null, valid: false
                });
                s += 1;
            }
        }
    } else {
        const countMask = (1 << countBits) - 1;
        for (let slot = 0; slot < slotsPerCell; slot += 1) {
            const shift = valueBits + slot * pairBits;
            const word = (cell >>> shift) & pairMask;
            const count = (word >>> deltaBits) & countMask;
            if (count <= 0) {
                slots.push({
                    slot,
                    label: '',
                    colorValue: min,
                    isEmpty: true,
                    deltaEnc: 0,
                    delta: 0,
                    count: 0,
                    representedValue: null,
                    valid: false
                });
                continue;
            }

            const deltaEnc = word & deltaMask;
            const delta = deltaEnc - deltaMax;
            const rel = anchorRel + delta;
            const valid = rel >= 0 && rel <= range;
            const absValue = rel + min;
            slots.push({
                slot,
                label: valid ? `${absValue} \u00d7${count}` : `? \u00d7${count}`,
                colorValue: valid ? absValue : min,
                isEmpty: false,
                deltaEnc,
                delta,
                count,
                representedValue: valid ? absValue : null,
                valid
            });
        }
    }

    return slots;
}

function getDeltaSlotVisualInfo(cell, bucketIndex, bucketCount, predictiveBits, minValue, maxValue) {
    if (!predictiveBits || predictiveBits.mode !== 'deltaMicrobucket') {
        return null;
    }
    const slotsPerCell = Number.isFinite(predictiveBits.slotsPerCell) ? predictiveBits.slotsPerCell : 0;
    const valueBits = Number.isFinite(predictiveBits.valueBits) ? predictiveBits.valueBits : 0;
    const deltaBits = Number.isFinite(predictiveBits.deltaBits) ? predictiveBits.deltaBits : 0;
    const countBits = Number.isFinite(predictiveBits.countBits) ? predictiveBits.countBits : 0;
    const pairBits = Number.isFinite(predictiveBits.pairBits) ? predictiveBits.pairBits : deltaBits + countBits;
    if (slotsPerCell <= 0 || pairBits <= 0) return null;

    // In displacement-chain mode (valueBits === 0), bit 31 is the sentinel that
    // marks a cell as converted. Raw cells (bit 31 clear) must never show slot
    // stripes — their bits 0..30 are just a relative integer, not slot data.
    if (valueBits === 0 && (((cell >>> 0) >>> 31) & 1) === 0) return null;

    // Count-table cells (bits 31-30 = 11): compacted (relVal, count) — show label only.
    if (valueBits === 0 && ((cell >>> 0) >>> 30) === 3) {
        const ctMin = Number.isFinite(minValue) ? minValue : 0;
        const relVal = (cell >>> 0) & 0xFFFFF;
        const count = ((cell >>> 0) >>> 20) & 0x3FF;
        const absVal = relVal + ctMin;
        return {
            slotSegments: [],
            labelStartBit: 0,
            labelSpanBits: 31,
            trackStartBit: 0,
            trackSpanBits: 31,
            slotLabel: `${absVal}\u00d7${count}`
        };
    }

    const slots = decodeDeltaBucketSlots(cell, bucketIndex, bucketCount, predictiveBits, minValue, maxValue);
    const slotSegments = [];
    for (let slot = 0; slot < slotsPerCell; slot += 1) {
        const s = slots[slot] || { isEmpty: true, colorValue: minValue };
        slotSegments.push({
            slot,
            startBit: valueBits + slot * pairBits,
            width: pairBits,
            filled: !s.isEmpty,
            colorValue: s.colorValue
        });
    }

    const firstFilled = slotSegments.find((seg) => seg.filled) || null;
    // For sentinel cells (bit 31 set) with no filled slots yet, still return
    // slot info so the renderer draws the empty-slot stripe pattern.
    const isSentinel = (((cell >>> 0) >>> 31) & 1) === 1;
    if (!firstFilled && !isSentinel) return null;
    const chosenSlot = firstFilled ? (slots.find((s) => s && s.slot === firstFilled.slot) || null) : null;
    return {
        slotSegments,
        labelStartBit: firstFilled ? firstFilled.startBit : 0,
        labelSpanBits: firstFilled ? firstFilled.width : pairBits,
        trackStartBit: firstFilled ? firstFilled.startBit : 0,
        trackSpanBits: firstFilled ? firstFilled.width : pairBits,
        slotLabel: chosenSlot && chosenSlot.label ? String(chosenSlot.label) : ''
    };
}

function getDeltaChangedSlotIndex(currentCell, previousCell, bucketIndex, bucketCount, predictiveBits, minValue, maxValue) {
    if (!predictiveBits || predictiveBits.mode !== 'deltaMicrobucket') return null;
    // In displacement-chain mode (valueBits===0), a raw previous cell (bit31=0) cannot be
    // decoded as slot data — treat it as all-empty so the first filled slot is reported.
    const valueBits = Number.isFinite(predictiveBits.valueBits) ? predictiveBits.valueBits : 0;
    // Count-table cells (bits 31-30 = 11) are not slot cells; skip slot comparison.
    if (valueBits === 0 && (((currentCell >>> 0) >>> 30) === 3 || ((previousCell >>> 0) >>> 30) === 3)) {
        return null;
    }
    if (valueBits === 0 && ((previousCell >>> 0) >>> 31) === 0) {
        const currentSlots = decodeDeltaBucketSlots(currentCell, bucketIndex, bucketCount, predictiveBits, minValue, maxValue);
        for (let s = 0; s < currentSlots.length; s += 1) {
            if (currentSlots[s] && !currentSlots[s].isEmpty) return s;
        }
        return null;
    }
    const currentSlots = decodeDeltaBucketSlots(currentCell, bucketIndex, bucketCount, predictiveBits, minValue, maxValue);
    const previousSlots = decodeDeltaBucketSlots(previousCell, bucketIndex, bucketCount, predictiveBits, minValue, maxValue);
    const slotCount = Math.max(currentSlots.length, previousSlots.length);
    for (let slot = 0; slot < slotCount; slot += 1) {
        const c = currentSlots[slot] || { count: 0, deltaEnc: 0 };
        const p = previousSlots[slot] || { count: 0, deltaEnc: 0 };
        if ((c.count || 0) !== (p.count || 0) || (c.deltaEnc || 0) !== (p.deltaEnc || 0)) {
            return slot;
        }
    }
    return null;
}

function formatDeltaBucketSections(cell, bucketIndex, bucketCount, predictiveBits, minValue, maxValue) {
    const slotsPerCell = Number.isFinite(predictiveBits && predictiveBits.slotsPerCell)
        ? predictiveBits.slotsPerCell : 0;
    const valueBits = Number.isFinite(predictiveBits && predictiveBits.valueBits)
        ? predictiveBits.valueBits : 0;
    const deltaBits = Number.isFinite(predictiveBits && predictiveBits.deltaBits)
        ? predictiveBits.deltaBits : 0;
    const countBits = Number.isFinite(predictiveBits && predictiveBits.countBits)
        ? predictiveBits.countBits : 0;
    const deltaMax = Number.isFinite(predictiveBits && predictiveBits.deltaMax)
        ? predictiveBits.deltaMax : 0;
    const min = Number.isFinite(minValue) ? minValue : 0;
    const max = Number.isFinite(maxValue) ? maxValue : min;
    const range = max - min;

    if (slotsPerCell <= 0 || valueBits <= 0 || deltaBits <= 0 || countBits <= 0) {
        const fb = formatBinaryValue(cell, true);
        return { valueHtml: String(cell), binaryHtml: fb };
    }

    const anchorRel = getDeltaBucketAnchorRel(bucketIndex, bucketCount, range);
    const perfectValue = getDeltaBucketPerfectValue(bucketIndex, bucketCount, minValue, maxValue);
    const pairBits = deltaBits + countBits;
    const usedBits = valueBits + slotsPerCell * pairBits;
    const bits = toFullBinary32(cell);

    let cursor = 32;
    const origPart = bits.slice(cursor - valueBits, cursor);
    cursor -= valueBits;
    const origVal = parseInt(origPart, 2) + min;

    const slotParts = [];
    for (let slot = 0; slot < slotsPerCell; slot += 1) {
        const deltaPart = bits.slice(cursor - deltaBits, cursor);
        cursor -= deltaBits;
        const countPart = bits.slice(cursor - countBits, cursor);
        cursor -= countBits;
        const deltaEncVal = parseInt(deltaPart, 2);
        const countVal = parseInt(countPart, 2);
        const delta = deltaEncVal - deltaMax;
        const repRel = anchorRel + delta;
        const repAbs = (countVal > 0 && repRel >= 0 && repRel <= range) ? repRel + min : null;
        slotParts.push({ slot, deltaPart, countPart, deltaEncVal, countVal, delta, repAbs });
    }

    const unusedLen = usedBits < 32 ? 32 - usedBits : 0;
    const unusedPart = unusedLen > 0 ? bits.slice(0, unusedLen) : '';

    // Build ordered segment descriptors (left-to-right in display)
    const segs = [];
    if (unusedPart) {
        segs.push({ bits: unusedPart, css: 'delta-bits-unused', label: 'unused', decoded: null, repr: null, highlight: false });
    }
    for (let i = slotParts.length - 1; i >= 0; i -= 1) {
        const p = slotParts[i];
        segs.push({ bits: p.countPart, css: 'delta-bits-count', label: `S${p.slot}.count`, decoded: String(p.countVal), repr: null, highlight: false });
        segs.push({
            bits: p.deltaPart, css: 'delta-bits-delta', label: `S${p.slot}.delta`,
            decoded: p.countVal > 0 ? `enc=${p.deltaEncVal} \u0394=${p.delta}` : null,
            repr: p.countVal > 0 ? (p.repAbs !== null ? `\u2192 ${p.repAbs}` : '\u2192 ?') : null,
            highlight: false
        });
    }
    segs.push({ bits: origPart, css: 'delta-bits-orig', label: 'orig', decoded: String(origVal), repr: null, highlight: true });

    // Binary HTML: annotation row (labels only, aligning to bits below) + continuous bits row
    const annCols = segs.map((s) => {
        const n = s.bits.length;
        return `<span class="delta-ann-col ${s.css}" style="width:${n}ch">` +
            `<span class="delta-segment-label">${s.label}</span></span>`;
    }).join('');

    const bitsSpans = segs.map((s) => `<span class="${s.css}">${s.bits}</span>`).join('');

    const binaryHtml =
        `<span class="delta-binary-wrapper">` +
        `<span class="delta-bits-row">${bitsSpans}</span>` +
        `</span>` +
        `<br><span class="delta-tooltip-meta">perfect=${perfectValue}\u00a0\u00a0deltaBias=${deltaMax}\u00a0\u00a0range=${range}</span>`;

    // Value HTML: same columns, decoded values only, orig column highlighted
    const valCols = segs.map((s) => {
        const highlightClass = s.highlight ? ' delta-val-highlight' : '';
        const decodedSpan = s.decoded !== null
            ? `<span class="delta-segment-value">${s.decoded}</span>`
            : `<span class="delta-segment-value delta-val-empty">\u2014</span>`;
        const reprSpan = s.repr !== null ? `<span class="delta-segment-repr">${s.repr}</span>` : '';
        return `<span class="delta-val-col ${s.css}${highlightClass}" style="width:${s.bits.length}ch">` +
            `<span class="delta-segment-label">${s.label}</span>${decodedSpan}${reprSpan}</span>`;
    }).join('');

    const valueHtml = `<span class="delta-val-row">${valCols}</span>`;

    return { valueHtml, binaryHtml };
}


// Returns an HTML string with three colour-coded <span> sections for the three
// bit fields that the predictive counting algorithm packs into each integer:
//   binCount   (high bits) — how many of this value exist
//   binRelVal  (mid bits)  — which relative value this bin counts
//   origRelVal (low bits)  — original value at this array index (never changed)
function formatBinaryValueSectioned(cell, valueBits, countShift) {
    const bits = (cell >>> 0).toString(2).padStart(32, '0');
    // In the 32-char string MSB is at position 0, LSB at position 31.
    const binCountPart = bits.slice(0, 32 - countShift);           // high bits
    const binRelPart = bits.slice(32 - countShift, 32 - valueBits); // mid bits
    const origRelPart = bits.slice(32 - valueBits);               // low bits
    return `0b<span class="bin-bits-count">${binCountPart}</span>` +
        `<span class="bin-bits-relval">${binRelPart}</span>` +
        `<span class="bin-bits-orig">${origRelPart}</span>`;
}

function buildCellTooltip(stepIndex, laneLabel, index, labelText, binaryText) {
    return {
        header: `step ${stepIndex + 1}, ${laneLabel}[${index}]`,
        value: labelText || '',
        binary: binaryText || ''
    };
}

function applyCellTooltipData(item, tooltipData) {
    if (!item || !tooltipData) {
        return;
    }
    item.dataset.tooltipHeader = tooltipData.header || '';
    item.dataset.tooltipValue = tooltipData.value || '';
    item.dataset.tooltipBinary = tooltipData.binary || '';
}

function clearCellTooltipData(item) {
    if (!item) {
        return;
    }
    delete item.dataset.tooltipHeader;
    delete item.dataset.tooltipValue;
    delete item.dataset.tooltipBinary;
}

function getDisplayColorValue(rawValue, splitLabel, predictiveCountingMode, predictiveBits = null, minValue = undefined) {
    if (!predictiveCountingMode) {
        return rawValue;
    }

    // In predictive counting mode the raw cell value may have bin metadata packed
    // into its high bits (all cells remain integers). Always derive the display
    // color from the primary label, which the algorithm already decoded.
    return resolvePredictiveColorValue(rawValue, splitLabel, predictiveBits, minValue);
}

let sharedCellTooltip = null;

function ensureSharedCellTooltip() {
    if (sharedCellTooltip) {
        return sharedCellTooltip;
    }

    const tooltip = document.createElement('div');
    tooltip.className = 'cell-tooltip';
    tooltip.innerHTML = `
        <div class="cell-tooltip-header"></div>
        <div class="cell-tooltip-row"><span class="cell-tooltip-label">Value</span><span class="cell-tooltip-value"></span></div>
        <div class="cell-tooltip-row cell-tooltip-binary-row"><span class="cell-tooltip-label">Binary</span><span class="cell-tooltip-binary"></span></div>
    `;
    document.body.appendChild(tooltip);
    sharedCellTooltip = tooltip;
    return tooltip;
}

const ALGO_CODE_LINES = {
    bubble: [
        { t: 'arr[' }, { t: 'j', r: 'left' }, { t: '] > arr[' },
        { t: 'j+1', r: 'right' }, { t: ']' }
    ],
    selection: [
        { t: 'arr[' }, { t: 'j', r: 'scan' }, { t: '] < arr[' },
        { t: 'minIdx', r: 'min' }, { t: ']' }
    ],
    insertion: [
        { t: 'arr[' }, { t: 'j', r: 'left' }, { t: '] > ' }, { t: 'key', r: 'right' }
    ],
    merge: [
        { t: 'left[' }, { t: 'l', r: 'left' }, { t: '] ≤ right[' },
        { t: 'r', r: 'right' }, { t: ']' }
    ],
    quick: [
        { t: 'arr[' }, { t: 'left', r: 'left' }, { t: '] vs arr[' },
        { t: 'right', r: 'right' }, { t: '] p=' }, { t: 'pivot', r: 'pivot' }
    ]
};

function getPredictiveCountingCodeSegments(roles, parts) {
    // Phase 2b compress: bit-pack CT entries leftward into fewer words
    if (parts && parts.has('compress')) {
        if (roles.has('scan') && roles.has('write')) {
            return [
                { t: 'compress ct[' }, { t: 'src', r: 'scan' }, { t: '] \u2192 packed[' },
                { t: 'dst', r: 'write' }, { t: ']' }
            ];
        }
        return [{ t: 'compress ct \u2192 packed' }];
    }
    // Phase 2 collect: compress slot counts left into count-table cells
    if (parts && parts.has('collect')) {
        if (roles.has('scan') && roles.has('write')) {
            return [
                { t: 'compact count[' }, { t: 'src', r: 'scan' }, { t: '] \u2192 ct[' },
                { t: 'dst', r: 'write' }, { t: ']' }
            ];
        }
        return [{ t: 'compact count \u2192 ct[dst]' }];
    }
    // Phase 1 displacement chain: bin/orig parts — must come before generic scan+write
    if (parts && (parts.has('bin') || parts.has('orig'))) {
        if (roles.has('scan') && roles.has('write')) {
            return [
                { t: 'chain arr[' }, { t: 'src', r: 'scan' }, { t: '] \u2192 slot[' },
                { t: 'dst', r: 'write' }, { t: ']' }
            ];
        }
    }
    // Phase 3 expand: right-to-left expansion from count-table cells
    if (parts && parts.has('expand')) {
        if (roles.has('scan') && roles.has('write')) {
            return [
                { t: 'expand ct[' }, { t: 'src', r: 'scan' }, { t: '] \u2192 arr[' },
                { t: 'dst', r: 'write' }, { t: ']' }
            ];
        }
    }
    if (roles.has('origin') && roles.has('write') && roles.has('scan')) {
        return [
            { t: 'slot probe ' }, { t: 'v', r: 'origin' }, { t: ' @[' },
            { t: 'scan', r: 'scan' }, { t: '] write[' },
            { t: 'w', r: 'write' }, { t: ']' }
        ];
    }
    if (roles.has('scan') && roles.has('write')) {
        return [
            { t: 'expand count[' }, { t: 'scan', r: 'scan' }, { t: '] -> arr[' },
            { t: 'w', r: 'write' }, { t: ']' }
        ];
    }
    if (roles.has('origin') && roles.has('write')) {
        return [
            { t: 'pack delta/count for ' }, { t: 'v', r: 'origin' }, { t: ' -> [' },
            { t: 'w', r: 'write' }, { t: ']' }
        ];
    }
    if (roles.has('origin') && roles.has('predicted') && roles.has('scan')) {
        return [
            { t: 'probe ' }, { t: 'v', r: 'origin' }, { t: ' -> [' },
            { t: 'p', r: 'predicted' }, { t: '] @ [' },
            { t: 'scan', r: 'scan' }, { t: ']' }
        ];
    }
    if (roles.has('origin') && roles.has('predicted')) {
        return [
            { t: 'pack ' }, { t: 'v', r: 'origin' }, { t: '→[' },
            { t: 'p', r: 'predicted' }, { t: ']' }
        ];
    }
    if (roles.has('scan') && (roles.has('min') || roles.has('max'))) {
        return [
            { t: 'arr[' }, { t: 'i', r: 'scan' }, { t: '] vs ' },
            { t: 'min', r: 'min' }, { t: '…' }, { t: 'max', r: 'max' }
        ];
    }
    // Single-role cases for contiguous packed sweeps
    if (roles.has('decompress')) {
        return [
            { t: 'strip/decomp -> arr[' }, { t: 'i', r: 'decompress' }, { t: ']' }
        ];
    }
    if (roles.has('origin')) {
        return [
            { t: 'scan v=' }, { t: 'origin', r: 'origin' }
        ];
    }
    if (roles.has('write')) {
        return [
            { t: 'write slot pair -> [' }, { t: 'w', r: 'write' }, { t: ']' }
        ];
    }
    return [{ t: 'delta slot counting…' }];
}

function getPredictionCodeSegments(roles) {
    if (roles.has('origin') && roles.has('predicted')) {
        return [
            { t: 'arr[' }, { t: 'scan', r: 'scan' }, { t: ']==' },
            { t: 'origin', r: 'origin' }, { t: '?→[' },
            { t: 'predicted', r: 'predicted' }, { t: ']' }
        ];
    }
    if (roles.has('origin') && roles.has('next')) {
        return [
            { t: 'shift ' }, { t: 'origin', r: 'origin' }, { t: '→' }, { t: 'next', r: 'next' }
        ];
    }
    if (roles.has('scan') && (roles.has('min') || roles.has('max'))) {
        return [
            { t: 'arr[' }, { t: 'i', r: 'scan' }, { t: '] vs ' },
            { t: 'min', r: 'min' }, { t: '…' }, { t: 'max', r: 'max' }
        ];
    }
    if (roles.has('min') || roles.has('max')) {
        return [
            { t: '[0] ' }, { t: 'min', r: 'min' },
            { t: '↔[n-1] ' }, { t: 'max', r: 'max' }
        ];
    }
    if (roles.has('origin')) {
        return [{ t: 'check ' }, { t: 'origin', r: 'origin' }];
    }
    return [{ t: 'compare…' }];
}

function buildCodeLineHTML(algorithmName, trackedIndices) {
    const roles = new Set(trackedIndices.map((t) => t.role));
    const roleColorMap = new Map();
    trackedIndices.forEach(({ role }) => {
        if (!roleColorMap.has(role)) {
            roleColorMap.set(role, rgbToString(getRoleAccentColor(role)));
        }
    });
    const parts = new Set(trackedIndices.map((t) => t.part).filter(Boolean));
    const segments = algorithmName === 'prediction'
        ? getPredictionCodeSegments(roles)
        : algorithmName === 'predictiveCounting'
            ? getPredictiveCountingCodeSegments(roles, parts)
            : (ALGO_CODE_LINES[algorithmName] || [{ t: algorithmName }]);
    return segments.map((seg) => {
        if (seg.r && roleColorMap.has(seg.r)) {
            const color = roleColorMap.get(seg.r);
            return `<span style="color:${color};font-weight:bold;text-shadow:${TRACKED_TEXT_SHADOW}">${seg.t}</span>`;
        }
        return seg.t;
    }).join('');
}

function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

const JS_TOKEN_REGEX = /\/\/.*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|try|catch|throw|true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b/g;

function highlightJsLine(line) {
    let output = '';
    let cursor = 0;
    let match;

    while ((match = JS_TOKEN_REGEX.exec(line)) !== null) {
        const token = match[0];
        const index = match.index;
        output += escapeHtml(line.slice(cursor, index));

        let cls = 'code-token';
        if (token.startsWith('//')) {
            cls += ' code-token-comment';
        } else if (token.startsWith('"') || token.startsWith('\'') || token.startsWith('`')) {
            cls += ' code-token-string';
        } else if (/^\d/.test(token)) {
            cls += ' code-token-number';
        } else {
            cls += ' code-token-keyword';
        }

        output += `<span class="${cls}">${escapeHtml(token)}</span>`;
        cursor = index + token.length;
    }

    output += escapeHtml(line.slice(cursor));
    return output;
}

function renderHighlightedCodeHtml(code) {
    const lines = String(code || '').replace(/\r\n/g, '\n').split('\n');
    const digits = Math.max(2, String(lines.length).length);
    return lines.map((line, index) => {
        const htmlLine = line.length > 0 ? highlightJsLine(line) : '&nbsp;';
        return `<div class="code-line"><span class="code-line-number" style="min-width:${digits}ch">${index + 1}</span><span class="code-line-text">${htmlLine}</span></div>`;
    }).join('');
}

function normalizeDisplayedFunctionCode(fnSource) {
    let text = String(fnSource || '').replace(/\r\n/g, '\n');

    // Methods stringify as "name(args) { ... }"; show explicit function form.
    if (/^\s*sort\s*\(/.test(text)) {
        text = text.replace(/^\s*sort\s*\(/, 'function sort(');
    }

    const lines = text.split('\n');
    if (lines.length <= 1) return text;

    // Keep signature at column 0, dedent body based on lines after the first.
    let minBodyIndent = Infinity;
    for (let i = 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line.trim()) continue;
        const m = line.match(/^\s*/);
        const indent = m ? m[0].length : 0;
        if (indent < minBodyIndent) minBodyIndent = indent;
    }
    if (!Number.isFinite(minBodyIndent) || minBodyIndent <= 0) {
        return lines.join('\n');
    }

    const out = [lines[0].trimStart()];
    for (let i = 1; i < lines.length; i += 1) {
        const line = lines[i];
        out.push(line.trim() ? line.slice(minBodyIndent) : '');
    }
    return out.join('\n');
}

function getCellPalette(value, colorMin, colorMax, roles = []) {
    const baseRgb = getPackedHeatmapRgb(value, colorMin, colorMax);
    const primaryRole = roles.length > 0 ? roles[0] : null;
    const accentRgb = primaryRole ? getRoleAccentColor(primaryRole) : null;
    // Dim base toward black for non-highlighted; boost for highlighted.
    const bgRgb = accentRgb
        ? mixRgb(baseRgb, [0, 0, 0], 0.15)
        : mixRgb(baseRgb, [0, 0, 0], 0.45);
    // Text: midpoint between 1-bit and 0-bit brightness of this hue.
    const textRgb = accentRgb
        ? mixRgb(baseRgb, [0, 0, 0], 0.33)
        : mixRgb(baseRgb, [0, 0, 0], 0.68);
    return {
        background: rgbToString(bgRgb),
        text: accentRgb ? rgbToString(accentRgb) : rgbToString(textRgb)
    };
}

function getLegendPalette(role) {
    const baseRgb = interpolateRgb(GREYSCALE_STOPS, 0.65);
    const accentRgb = getRoleAccentColor(role);
    return {
        background: rgbToString(baseRgb),
        text: rgbToString(accentRgb)
    };
}

class SortSimulator {
    constructor(index, onRemove, onAlgorithmChange) {
        this.index = index;
        this.onRemove = onRemove;
        this.onAlgorithmChange = onAlgorithmChange;
        this.showCodeColumn = true;
        this.root = this.createMarkup();
        this.cacheElements();
        this.setupEventListeners();
    }

    createMarkup() {
        const card = document.createElement('article');
        card.className = 'simulator-card';
        card.innerHTML = `
            <div class="simulator-header">
                <div class="controls">
                    <select class="algorithm-select" aria-label="Sorting algorithm">
                        <option value="bubble">Bubble Sort</option>
                        <option value="selection">Selection Sort</option>
                        <option value="insertion">Insertion Sort</option>
                        <option value="merge">Merge Sort</option>
                        <option value="quick">Quick Sort</option>
                        <option value="prediction">Prediction Sort</option>
                        <option value="predictiveCounting">Predictive Counting Sort</option>
                    </select>
                    <div class="trace-range-controls">
                        <span class="trace-range-label">Rows</span>
                        <input class="trace-range-input trace-range-start" type="number" min="0" placeholder="from" aria-label="Copy trace from row">
                        <span class="trace-range-sep">-</span>
                        <input class="trace-range-input trace-range-end" type="number" min="0" placeholder="to" aria-label="Copy trace to row">
                    </div>
                    <button class="copy-trace-btn" type="button">Copy Trace</button>
                </div>
                <button class="remove-btn" type="button">Remove</button>
            </div>

            <div class="simulator-main">
                <div class="code-display">
                    <pre class="code-output"></pre>
                </div>

                <div class="simulator-visual-column">
                    <div class="visualization-area">
                        <div class="grid-container"></div>
                    </div>

                    <div class="stats-bar">
                        <span class="stat-pill">Comparisons: <strong class="stat-comparisons">0</strong></span>
                        <span class="stat-pill">Index Checks: <strong class="stat-index-checks">0</strong></span>
                        <span class="stat-pill">Swaps: <strong class="stat-swaps">0</strong></span>
                        <span class="mode-badge" style="display:none"></span>
                    </div>
                </div>
            </div>
        `;
        return card;
    }

    cacheElements() {
        this.algorithmSelect = this.root.querySelector('.algorithm-select');
        this.traceRangeStart = this.root.querySelector('.trace-range-start');
        this.traceRangeEnd = this.root.querySelector('.trace-range-end');
        this.copyTraceBtn = this.root.querySelector('.copy-trace-btn');
        this.removeBtn = this.root.querySelector('.remove-btn');
        this.legendBar = this.root.querySelector('.legend-bar');
        this.visualizationArea = this.root.querySelector('.visualization-area');
        this.gridContainer = this.root.querySelector('.grid-container');
        this.statsComparisons = this.root.querySelector('.stat-comparisons');
        this.statsIndexChecks = this.root.querySelector('.stat-index-checks');
        this.statsSwaps = this.root.querySelector('.stat-swaps');
        this.modeBadge = this.root.querySelector('.mode-badge');
        this.codeOutput = this.root.querySelector('.code-output');
    }

    setupEventListeners() {
        this.algorithmSelect.addEventListener('change', () => this.onAlgorithmChange());
        this.copyTraceBtn.addEventListener('click', () => this.copyTrace());
        this.removeBtn.addEventListener('click', () => this.onRemove(this));
        this.gridContainer.addEventListener('mouseover', (event) => this.handleGridTooltip(event));
        this.gridContainer.addEventListener('mousemove', (event) => this.handleGridTooltip(event));
        this.gridContainer.addEventListener('mouseout', (event) => this.handleGridTooltipLeave(event));
        this.gridContainer.addEventListener('scroll', () => this.hideGridTooltip());
    }

    handleGridTooltip(event) {
        const cell = event.target.closest('.item');
        if (!cell || !this.gridContainer.contains(cell)) {
            this.hideGridTooltip();
            return;
        }

        const header = cell.dataset.tooltipHeader || '';
        const value = cell.dataset.tooltipValue || '';
        const binary = cell.dataset.tooltipBinary || '';
        if (!header && !value && !binary) {
            this.hideGridTooltip();
            return;
        }

        const tooltip = ensureSharedCellTooltip();
        const headerEl = tooltip.querySelector('.cell-tooltip-header');
        const valueEl = tooltip.querySelector('.cell-tooltip-value');
        const binaryEl = tooltip.querySelector('.cell-tooltip-binary');
        const valueRow = tooltip.querySelector('.cell-tooltip-row');
        const binaryRow = tooltip.querySelector('.cell-tooltip-binary-row');

        headerEl.textContent = header;
        valueEl.innerHTML = value;    // may contain <span> sections (delta value row)
        binaryEl.innerHTML = binary;  // may contain <span> sections
        valueRow.style.display = value ? 'grid' : 'none';
        binaryRow.style.display = binary ? 'grid' : 'none';

        tooltip.classList.add('is-visible');

        const offset = 16;
        const maxLeft = window.innerWidth - tooltip.offsetWidth - 8;
        const maxTop = window.innerHeight - tooltip.offsetHeight - 8;
        const left = Math.max(8, Math.min(event.clientX + offset, maxLeft));
        const top = Math.max(8, Math.min(event.clientY + offset, maxTop));
        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;
    }

    handleGridTooltipLeave(event) {
        const toElement = event.relatedTarget;
        if (toElement && this.gridContainer.contains(toElement)) {
            return;
        }
        this.hideGridTooltip();
    }

    hideGridTooltip() {
        if (!sharedCellTooltip) {
            return;
        }
        sharedCellTooltip.classList.remove('is-visible');
    }

    buildTraceExport(startRow = null, endRow = null) {
        if (!this.lastRun) {
            return '';
        }

        const { algorithmName, inputList, steps, stats, predictiveBits } = this.lastRun;
        const predictiveMode = predictiveBits && predictiveBits.mode ? predictiveBits.mode : '';
        const lines = [];
        lines.push('SORTLAB_TRACE_V1');
        lines.push(`algorithm=${algorithmName}`);
        if (predictiveMode) {
            lines.push(`mode=${predictiveMode}`);
        }
        lines.push(`input=${inputList.join(',')}`);
        lines.push(`comparisons=${stats.comparisons ?? 0}`);
        lines.push(`indexChecks=${stats.indexChecks ?? 0}`);
        lines.push(`swaps=${stats.swaps ?? 0}`);
        const includePackedRaw = algorithmName === 'predictiveCounting';
        lines.push(includePackedRaw
            ? 'row|cmp|chk|swp|values|packedRaw|written'
            : 'row|cmp|chk|swp|values|written');

        const decodePredictiveValues = (step) => {
            if (!Array.isArray(step.values)) return '';
            if (!Array.isArray(step.displayValues)) return step.values.join(',');
            const minForStep = Number.isFinite(step.minValue) ? step.minValue : this.lastRun.colorMinValue;
            return step.values.map((rawValue, idx) => {
                const displayLabel = step.displayValues[idx];
                const splitLabel = splitDisplayLabel(displayLabel, rawValue);
                return resolvePredictiveCellLabel(rawValue, splitLabel, predictiveBits, minForStep);
            }).join(',');
        };

        steps.forEach((step, row) => {
            if (startRow !== null && row < startRow) {
                return;
            }
            if (endRow !== null && row > endRow) {
                return;
            }

            const snapshot = step.statsSnapshot || {};
            const cmp = snapshot.comparisons ?? '';
            const chk = snapshot.indexChecks ?? '';
            const swp = snapshot.swaps ?? '';
            const values = algorithmName === 'predictiveCounting'
                ? decodePredictiveValues(step)
                : (Array.isArray(step.values) ? step.values.join(',') : '');
            const packedRaw = includePackedRaw && Array.isArray(step.values)
                ? step.values.join(',')
                : '';
            const written = Array.isArray(step.writtenValues)
                ? step.writtenValues.map((isWritten) => (isWritten ? '1' : '0')).join('')
                : '';
            if (includePackedRaw) {
                lines.push(`${row}|${cmp}|${chk}|${swp}|${values}|${packedRaw}|${written}`);
            } else {
                lines.push(`${row}|${cmp}|${chk}|${swp}|${values}|${written}`);
            }
        });

        return lines.join('\n');
    }

    flashCopyStatus(label) {
        const original = this.copyTraceBtn.textContent;
        this.copyTraceBtn.textContent = label;
        window.setTimeout(() => {
            this.copyTraceBtn.textContent = original;
        }, 900);
    }

    fallbackCopyText(text) {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.setAttribute('readonly', 'readonly');
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        textArea.style.pointerEvents = 'none';
        textArea.style.left = '-9999px';
        document.body.appendChild(textArea);

        textArea.focus();
        textArea.select();
        textArea.setSelectionRange(0, textArea.value.length);

        let copied = false;
        try {
            copied = document.execCommand('copy');
        } catch (error) {
            copied = false;
        }

        document.body.removeChild(textArea);
        return copied;
    }

    async copyTrace() {
        const startRaw = this.traceRangeStart.value.trim();
        const endRaw = this.traceRangeEnd.value.trim();
        let startRow = startRaw === '' ? null : Number.parseInt(startRaw, 10);
        let endRow = endRaw === '' ? null : Number.parseInt(endRaw, 10);

        if (Number.isNaN(startRow)) {
            startRow = null;
        }
        if (Number.isNaN(endRow)) {
            endRow = null;
        }

        if (startRow !== null && endRow !== null && startRow > endRow) {
            const tmp = startRow;
            startRow = endRow;
            endRow = tmp;
        }

        const text = this.buildTraceExport(startRow, endRow);
        if (!text) {
            this.flashCopyStatus('No Trace');
            return;
        }

        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                this.flashCopyStatus('Copied');
                return;
            }

            const copied = this.fallbackCopyText(text);
            this.flashCopyStatus(copied ? 'Copied' : 'Copy Failed');
        } catch (error) {
            const copied = this.fallbackCopyText(text);
            this.flashCopyStatus(copied ? 'Copied' : 'Copy Failed');
        }
    }

    renderGrid(steps, colorMinValue, colorMaxValue, predictiveBits = null) {
        this.gridContainer.innerHTML = '';
        const laneCount = Array.isArray(steps) && steps[0] && Array.isArray(steps[0].values)
            ? steps[0].values.length
            : 0;
        const visualWidth = this.visualizationArea ? this.visualizationArea.clientWidth : 0;
        const fallbackBitWidth = 2;
        const fittedBitWidth = (laneCount > 0 && visualWidth > 0)
            ? Math.max(1, Math.floor((visualWidth - 2) / Math.max(1, laneCount * 32)))
            : fallbackBitWidth;
        const bitWidthPx = fittedBitWidth;
        const cellWidthPx = bitWidthPx * 32;
        this.gridContainer.style.setProperty('--bit-width-px', `${bitWidthPx}px`);
        this.gridContainer.style.setProperty('--cell-width-px', `${cellWidthPx}px`);
        const predictiveCountingMode = this.algorithmSelect.value === 'predictiveCounting';
        const hasOpColumns = steps.some((step) => step.statsSnapshot !== undefined);
        const renderCodeToggle = hasOpColumns;
        const renderCodeColumn = hasOpColumns && this.showCodeColumn;
        const hasAuxLane = steps.some((step) => Array.isArray(step.auxValues));
        const hasCarryLane = steps.some((step) => step.carryValue !== undefined);
        const hasVariableLane = steps.some((step) => step.minValue !== undefined || step.maxValue !== undefined);
        const isContiguousPackedMode = Boolean(predictiveBits && predictiveBits.mode === 'contiguousPacked');
        // In-place predictive counting should be visualized in array order only.
        // Do not render a separate synthetic/count lane.
        const hasSyntheticLane = false;
        const isDeltaSyntheticMode = Boolean(hasSyntheticLane && predictiveBits && predictiveBits.mode === 'deltaMicrobucket');
        const isDeltaMicrobucketMainMode = Boolean(predictiveCountingMode && predictiveBits && predictiveBits.mode === 'deltaMicrobucket');
        const firstDeltaSlotWriteRow = isDeltaMicrobucketMainMode
            ? steps.findIndex((s) => Array.isArray(s && s.trackedIndices)
                && s.trackedIndices.some((t) =>
                    t
                    && (t.lane === undefined || t.lane === 'main')
                    && t.part === 'bin'
                    && t.role === 'write'))
            : -1;
        // First step where Phase 2b compression appears. All rows from this index onward
        // are "post-count" — the overwrite-armed marker should be suppressed for them,
        // including the final row which carries no tracked indices of its own.
        const firstCompressRow = isDeltaMicrobucketMainMode
            ? steps.findIndex((s) => Array.isArray(s && s.trackedIndices)
                && s.trackedIndices.some((t) =>
                    t
                    && (t.lane === undefined || t.lane === 'main')
                    && t.part === 'compress'))
            : -1;
        const deltaSlotsPerBucket = isDeltaSyntheticMode && Number.isFinite(predictiveBits.slotsPerCell)
            ? Math.max(1, predictiveBits.slotsPerCell)
            : 1;

        let template = `repeat(${steps[0].values.length}, var(--cell-width-px))`;

        if (renderCodeToggle) {
            template = renderCodeColumn
                ? 'minmax(28px, 28px) minmax(160px, 260px) 10px ' + template
                : 'minmax(28px, 28px) 10px ' + template;
        }

        const mainLaneStartCol = renderCodeToggle
            ? (renderCodeColumn ? 4 : 3)
            : 1;
        const codeToggleCol = renderCodeToggle ? 1 : null;
        const codeLineCol = renderCodeToggle && renderCodeColumn ? 2 : null;
        const opDividerCol = renderCodeToggle ? (renderCodeColumn ? 3 : 2) : null;

        if (hasAuxLane) {
            template += ` 10px repeat(${steps[0].values.length}, var(--cell-width-px))`;
        }

        if (hasCarryLane) {
            template += ' 10px minmax(34px, 34px)';
        }

        if (hasVariableLane) {
            template += ' 10px minmax(34px, 34px) minmax(34px, 34px)';
        }

        if (hasSyntheticLane) {
            template += ` 10px repeat(${steps[0].values.length}, var(--cell-width-px))`;
        }

        const headerRow = document.createElement('div');
        headerRow.className = 'grid-row header-row';
        headerRow.style.gridTemplateColumns = template;

        if (renderCodeToggle) {
            const toggleCell = document.createElement('div');
            toggleCell.className = 'item op-item header-item code-toggle-cell';
            toggleCell.style.gridColumn = String(codeToggleCol);
            const toggleBtn = document.createElement('button');
            toggleBtn.type = 'button';
            toggleBtn.className = 'code-col-toggle';
            toggleBtn.textContent = this.showCodeColumn ? '◀' : '▶';
            toggleBtn.title = this.showCodeColumn ? 'Hide code column' : 'Show code column';
            toggleBtn.setAttribute('aria-label', toggleBtn.title);
            toggleBtn.addEventListener('click', () => this.toggleCodeColumn());
            toggleCell.appendChild(toggleBtn);
            headerRow.appendChild(toggleCell);

            if (renderCodeColumn) {
                const headerCell = document.createElement('div');
                headerCell.className = 'item op-item header-item code-line-cell';
                headerCell.style.gridColumn = String(codeLineCol);
                headerCell.textContent = 'Code';
                headerRow.appendChild(headerCell);
            }

            const divider = document.createElement('div');
            divider.className = 'lane-divider';
            divider.style.gridColumn = String(opDividerCol);
            headerRow.appendChild(divider);
        }

        for (let i = 0; i < steps[0].values.length; i++) {
            const headerCell = document.createElement('div');
            headerCell.className = 'item header-item';
            headerCell.textContent = i;
            headerRow.appendChild(headerCell);
        }

        if (hasAuxLane) {
            const divider = document.createElement('div');
            divider.className = 'lane-divider';
            headerRow.appendChild(divider);

            for (let i = 0; i < steps[0].values.length; i++) {
                const headerCell = document.createElement('div');
                headerCell.className = 'item header-item';
                headerCell.textContent = `a${i}`;
                headerRow.appendChild(headerCell);
            }
        }

        if (hasCarryLane) {
            const divider = document.createElement('div');
            divider.className = 'lane-divider';
            headerRow.appendChild(divider);

            const carryHeader = document.createElement('div');
            carryHeader.className = 'item header-item';
            carryHeader.textContent = 'C';
            headerRow.appendChild(carryHeader);
        }

        if (hasVariableLane) {
            const divider = document.createElement('div');
            divider.className = 'lane-divider';
            headerRow.appendChild(divider);

            const minHeader = document.createElement('div');
            minHeader.className = 'item header-item';
            minHeader.textContent = 'Min';
            headerRow.appendChild(minHeader);

            const maxHeader = document.createElement('div');
            maxHeader.className = 'item header-item';
            maxHeader.textContent = 'Max';
            headerRow.appendChild(maxHeader);
        }

        if (hasSyntheticLane) {
            const divider = document.createElement('div');
            divider.className = 'lane-divider';
            headerRow.appendChild(divider);

            for (let i = 0; i < steps[0].values.length; i++) {
                const headerCell = document.createElement('div');
                headerCell.className = 'item header-item';
                if (isDeltaSyntheticMode) {
                    headerCell.innerHTML =
                        `<span class="delta-header-index">${i}</span>` +
                        `<span class="delta-header-perfect">${getDeltaBucketPerfectValue(i, steps[0].values.length, colorMinValue, colorMaxValue)}</span>`;
                } else {
                    headerCell.textContent = i;
                }
                headerRow.appendChild(headerCell);
            }
        }

        this.gridContainer.appendChild(headerRow);

        steps.forEach((step, stepIndex) => {
            const row = document.createElement('div');
            row.className = 'grid-row';
            row.style.gridTemplateColumns = template;

            // True for all rows from the first compress step onward (including the
            // final sorted row, which carries no tracked indices of its own).
            const isPostCountPhase = isDeltaMicrobucketMainMode
                && firstCompressRow !== -1
                && stepIndex >= firstCompressRow;
            // Highlight every cell in the first and last rows so the full array state
            // is visible at a glance regardless of which algorithm is running.
            // Restrict to pure display steps (trackedIndices empty) so that an
            // operation step that happens to be at index 0 or N-1 is not force-highlighted.
            // createStepCollector always starts with trackedIndices:[] and finalize() always
            // ends with trackedIndices:[], so the real bookend rows still get highlighted.
            const isFirstOrLastRow = (stepIndex === 0 || stepIndex === steps.length - 1)
                && (step.trackedIndices == null || step.trackedIndices.length === 0);

            // Pre-compute source→destination pairs for spanning lines across all phases.
            const slotChainPairs = [];
            if (isDeltaMicrobucketMainMode) {
                // Helper: resolve the bit range for a tracked entry.
                // Explicit bitOffset/bitWidth takes priority; a slot index falls back to
                // predictiveBits.valueBits + slot * pairBits; otherwise full cell (0,32).
                const valBitsP = predictiveBits && Number.isFinite(predictiveBits.valueBits) ? predictiveBits.valueBits : 0;
                const prBitsP  = predictiveBits && Number.isFinite(predictiveBits.pairBits)  ? predictiveBits.pairBits  : 0;
                const entryBitRange = (t) => {
                    if (Number.isFinite(t.bitOffset) && Number.isFinite(t.bitWidth))
                        return { bitOffset: t.bitOffset, bitWidth: t.bitWidth };
                    if (Number.isFinite(t.slot) && prBitsP > 0)
                        return { bitOffset: valBitsP + t.slot * prBitsP, bitWidth: prBitsP };
                    return { bitOffset: 0, bitWidth: 32 };
                };
                const extractPairs = (srcPart, srcRole, dstPart, dstRole) => {
                    const srcEntries = (step.trackedIndices || [])
                        .filter((t) => t && t.part === srcPart && t.role === srcRole);
                    const dstEntries = (step.trackedIndices || [])
                        .filter((t) => t && t.part === dstPart && t.role === dstRole);
                    for (let pi = 0; pi < Math.min(srcEntries.length, dstEntries.length); pi++) {
                        const se = srcEntries[pi], de = dstEntries[pi];
                        if (se.index !== de.index) {
                            const sbr = entryBitRange(se), dbr = entryBitRange(de);
                            slotChainPairs.push({
                                src: se.index, dst: de.index,
                                srcPart,
                                srcBitOffset: sbr.bitOffset, srcBitWidth: sbr.bitWidth,
                                dstBitOffset: dbr.bitOffset, dstBitWidth: dbr.bitWidth,
                            });
                        }
                    }
                };
                extractPairs('orig', 'scan', 'bin', 'write');        // Phase 1
                extractPairs('collect', 'scan', 'collect', 'write'); // Phase 2
                extractPairs('compress', 'scan', 'compress', 'write'); // Phase 2b
                extractPairs('expand', 'scan', 'expand', 'write'); // Phase 3
            }

            const rolesByLane = {
                main: new Map(),
                aux: new Map(),
                carry: new Map(),
                vars: new Map()
            };
            // partsByLane.main: index -> { allBin, allOrig }
            //   allBin=true  => every tracked entry for this index has part:'bin'  => skip main-lane highlight
            //   allOrig=true => every tracked entry for this index has part:'orig' => skip bins-lane highlight
            const partsByLane = { main: new Map() };

            (step.trackedIndices || []).forEach(({ index, role, lane, part, slot, bitOffset, bitWidth }) => {
                const laneKey = lane === 'aux'
                    ? 'aux'
                    : lane === 'carry'
                        ? 'carry'
                        : lane === 'vars'
                            ? 'vars'
                            : 'main';
                if (!rolesByLane[laneKey].has(index)) {
                    rolesByLane[laneKey].set(index, []);
                }
                rolesByLane[laneKey].get(index).push(role);

                if (laneKey === 'main') {
                    if (!partsByLane.main.has(index)) {
                        partsByLane.main.set(index, { allBin: true, allOrig: true, slot: undefined, bitOffset: undefined, bitWidth: undefined });
                    }
                    const pe = partsByLane.main.get(index);
                    if (part !== 'bin') pe.allBin = false;
                    if (part !== 'orig') pe.allOrig = false;
                    if (Number.isFinite(slot)) pe.slot = slot;
                    if (Number.isFinite(bitOffset)) pe.bitOffset = bitOffset;
                    if (Number.isFinite(bitWidth)) pe.bitWidth = bitWidth;
                    if (part) pe.part = part;
                }
            });

            if (renderCodeToggle) {
                const toggleCell = document.createElement('div');
                toggleCell.className = 'item op-item code-toggle-cell';
                toggleCell.style.gridColumn = String(codeToggleCol);
                row.appendChild(toggleCell);

                if (renderCodeColumn) {
                    const codeCell = document.createElement('div');
                    codeCell.className = 'item op-item code-line-cell';
                    codeCell.style.gridColumn = String(codeLineCol);
                    codeCell.innerHTML = buildCodeLineHTML(this.algorithmSelect.value, step.trackedIndices || []);
                    row.appendChild(codeCell);
                }

                const divider = document.createElement('div');
                divider.className = 'lane-divider';
                divider.style.gridColumn = String(opDividerCol);
                row.appendChild(divider);
            }

            if (isContiguousPackedMode) {
                // ── Contiguous packed mode: ONE element spanning all value columns ──
                // Using a single DOM element with an (n×32)-column grid eliminates
                // every sub-pixel boundary that would otherwise appear between separate
                // per-index items. Array indices are meaningless at the bit level.
                const n = step.values.length;
                const packedItem = document.createElement('div');
                packedItem.className = 'item main-packed-cell packed-word-cell';
                packedItem.style.gridColumn = `span ${n}`;
                // Build a map of tracked array indices → primary role for the renderer.
                const trackedMap = new Map();
                step.values.forEach((_, idx) => {
                    const allRoles = rolesByLane.main.get(idx) || [];
                    const pe = partsByLane.main.get(idx);
                    if (allRoles.length > 0 && !(pe && pe.allBin)) trackedMap.set(idx, allRoles[0]);
                });
                renderContiguousPackedFullRow(packedItem, step, n, predictiveBits, colorMinValue, colorMaxValue, trackedMap);
                if (trackedMap.size > 0) {
                    packedItem.classList.add('tracked-cell');
                    row.style.zIndex = '100';
                }
                row.appendChild(packedItem);
            } else {
                // Collect main-lane items for the connection bar post-pass.
                const mainLaneItemsByIndex = new Map(); // index -> { item, colorValue }

                step.values.forEach((value, index) => {
                    const item = document.createElement('div');
                    item.className = 'item';
                    const previousValue = (stepIndex > 0 && steps[stepIndex - 1] && Array.isArray(steps[stepIndex - 1].values))
                        ? steps[stepIndex - 1].values[index]
                        : undefined;
                    const isWritten = Array.isArray(step.writtenValues) ? Boolean(step.writtenValues[index]) : false;
                    const displayLabel = Array.isArray(step.displayValues) ? step.displayValues[index] : undefined;
                    const splitLabel = splitDisplayLabel(displayLabel, value);
                    if (value === null || value === undefined) {
                        item.classList.add('empty-item');
                        item.textContent = '';
                        clearCellTooltipData(item);
                        mainLaneItemsByIndex.set(index, { item, colorValue: null });
                    } else {
                        const colorValue = getDisplayColorValue(
                            value,
                            splitLabel,
                            predictiveCountingMode,
                            predictiveBits,
                            step.minValue
                        );
                        const allRoles = rolesByLane.main.get(index) || [];
                        // Suppress main-lane highlight if this index is only being used for bin metadata.
                        const pe = partsByLane.main.get(index);
                        const roles = (pe && pe.allBin) ? [] : allRoles;
                        const highlightedBitRange = (pe && Number.isFinite(pe.bitOffset) && Number.isFinite(pe.bitWidth))
                            ? { start: pe.bitOffset, width: pe.bitWidth }
                            : null;

                        const deltaChangedSlotIndex = isDeltaMicrobucketMainMode
                            ? (Number.isFinite(pe && pe.slot)
                                ? pe.slot
                                : getDeltaChangedSlotIndex(
                                    value,
                                    previousValue,
                                    index,
                                    step.values.length,
                                    predictiveBits,
                                    step.minValue,
                                    step.maxValue
                                ))
                            : null;
                        let deltaSlotVisualInfo = predictiveCountingMode
                            ? getDeltaSlotVisualInfo(
                                value,
                                index,
                                step.values.length,
                                predictiveBits,
                                step.minValue,
                                step.maxValue
                            )
                            : null;
                        if (deltaSlotVisualInfo && Number.isFinite(deltaChangedSlotIndex)) {
                            const pairBits = Number.isFinite(predictiveBits && predictiveBits.pairBits)
                                ? predictiveBits.pairBits
                                : 0;
                            const valueBits = Number.isFinite(predictiveBits && predictiveBits.valueBits)
                                ? predictiveBits.valueBits
                                : 0;
                            if (pairBits > 0) {
                                const changedSlotLabel = decodeDeltaBucketSlots(
                                    value,
                                    index,
                                    step.values.length,
                                    predictiveBits,
                                    step.minValue,
                                    step.maxValue
                                ).find((s) => s && s.slot === deltaChangedSlotIndex);
                                if (changedSlotLabel && changedSlotLabel.label) {
                                    deltaSlotVisualInfo.slotLabel = String(changedSlotLabel.label);
                                }
                                deltaSlotVisualInfo.labelStartBit = valueBits + deltaChangedSlotIndex * pairBits;
                                deltaSlotVisualInfo.labelSpanBits = pairBits;
                                deltaSlotVisualInfo.trackStartBit = valueBits + deltaChangedSlotIndex * pairBits;
                                deltaSlotVisualInfo.trackSpanBits = pairBits;
                            }
                        }
                        // If the display label is CT-format ("value|value×count") or a raw
                        // scan-source override ("value|") — i.e. the pipe is not at index 0 —
                        // but the underlying cell is a slot-cell, getDeltaSlotVisualInfo will
                        // have decoded it with the slot's actual contents.  Clear those segments
                        // so the cell renders as a plain value (label-driven, not slot-driven).
                        if (deltaSlotVisualInfo && deltaSlotVisualInfo.slotSegments && deltaSlotVisualInfo.slotSegments.length > 0) {
                            const dlStr = String(displayLabel ?? '');
                            const pipeIdx = dlStr.indexOf('|');
                            if (pipeIdx > 0) {
                                deltaSlotVisualInfo.slotSegments = [];
                            }
                        }
                        // If this step carries explicit per-position packed segment data,
                        // use it to override slotSegments (or create synthetic visual info
                        // so packed words with bit31=0 still get per-segment coloring).
                        const posSeg = step.packedSegmentData ? (step.packedSegmentData[index] || null) : null;
                        if (posSeg && posSeg.length > 0) {
                            if (deltaSlotVisualInfo) {
                                deltaSlotVisualInfo.slotSegments = posSeg;
                            } else {
                                deltaSlotVisualInfo = {
                                    slotSegments: posSeg,
                                    labelStartBit: 0,
                                    labelSpanBits: 32,
                                    trackStartBit: 0,
                                    trackSpanBits: 32,
                                    // Non-empty slotLabel keeps stripeAsEmptySlots=false so
                                    // segment colours show on both 0 and 1 bits.
                                    slotLabel: String(splitLabel.primary || splitLabel.secondary || '').trim()
                                };
                            }
                        }
                        const slotWriteTarget = Boolean(
                            isDeltaMicrobucketMainMode
                            && pe
                            && pe.allBin
                            && Array.isArray(allRoles)
                            && allRoles.includes('write')
                        );
                        // Force-highlight every cell on the first and last rows.
                        const forceHighlight = isFirstOrLastRow && colorValue !== null;

                        if (isContiguousPackedMode && displayLabel !== undefined && String(displayLabel).includes('|')) {
                            renderContiguousPackedWordCell(
                                item, index, splitLabel.primary, splitLabel.secondary,
                                predictiveBits, colorMinValue, colorMaxValue
                            );
                        } else {
                            // deltaChangedSlotIndex, deltaSlotVisualInfo, slotWriteTarget already computed above.
                            const predictiveOverwritten = predictiveCountingMode
                                ? ((predictiveBits && predictiveBits.mode === 'deltaMicrobucket')
                                    ? Boolean(deltaSlotVisualInfo)
                                    : ((((Number(value) >>> 0) >>> 31) & 1) === 1))
                                : false;
                            const previousPredictiveOverwritten = predictiveCountingMode
                                ? ((predictiveBits && predictiveBits.mode === 'deltaMicrobucket')
                                    ? Boolean(getDeltaSlotVisualInfo(
                                        previousValue,
                                        index,
                                        step.values.length,
                                        predictiveBits,
                                        step.minValue,
                                        step.maxValue
                                    ))
                                    : ((((Number(previousValue) >>> 0) >>> 31) & 1) === 1))
                                : false;
                            const overwriteFlippedThisRow = predictiveOverwritten && !previousPredictiveOverwritten;
                            const overwriteMarkerArmed = predictiveCountingMode && !isPostCountPhase && (
                                (isDeltaMicrobucketMainMode
                                    ? (firstDeltaSlotWriteRow !== -1 && stepIndex >= firstDeltaSlotWriteRow)
                                    : true)
                            );
                            // In displacement-chain mode (valueBits===0): suppress labels on
                            // raw unprocessed cells (displayLabel has '|', bit31 clear) and on
                            // empty sentinel cells (bit31 set, no filled slots).
                            const isDeltaChainMode = isDeltaMicrobucketMainMode && predictiveBits && predictiveBits.valueBits === 0;
                            // A raw displacement cell is one whose display label has nothing
                            // after the '|' (the format "value|" or just "|").  CT-format
                            // strings like "32222|32222×4" have content after the pipe and
                            // must NOT be treated as raw — they should render with solid colour
                            // even when the underlying value is packed bits (bit31 = 0).
                            const isRawDisplacementCell = isDeltaChainMode && !predictiveOverwritten
                                && String(displayLabel ?? '').includes('|')
                                && !String(displayLabel ?? '').split('|').slice(1).join('|').trim();
                            const isEmptySlotCell = isDeltaChainMode && predictiveOverwritten
                                && !String((deltaSlotVisualInfo && deltaSlotVisualInfo.slotLabel) || '').trim();
                            // When the display label explicitly provides a decoded value AND secondary content
                            // (e.g. CT format "32|32×4"), prefer it over any slot-decoded label that might
                            // misinterpret raw packed-bits data as a CT or slot cell.
                            const dlForLabel = String(displayLabel ?? '');
                            const dlPipeIdx = dlForLabel.indexOf('|');
                            const hasExplicitValueDisplay = dlPipeIdx > 0
                                && Boolean(dlForLabel.slice(dlPipeIdx + 1).trim());
                            const primaryLabel = predictiveCountingMode
                                ? ((isRawDisplacementCell || isEmptySlotCell)
                                    ? ''
                                    : ((deltaSlotVisualInfo && String(deltaSlotVisualInfo.slotLabel || '').trim()
                                        && !hasExplicitValueDisplay
                                        && (slotWriteTarget || ((value >>> 0) >>> 30) === 3))
                                        ? String(deltaSlotVisualInfo.slotLabel)
                                        : resolvePredictiveCellLabel(value, splitLabel, predictiveBits, step.minValue)))
                                : splitLabel.primary;
                            // Predictive mode: draw live in-place bits from raw cell word,
                            // but colour by decoded logical value for readability.
                            renderCellBitGrid(
                                item,
                                value,
                                colorMinValue,
                                colorMaxValue,
                                roles.length > 0 || slotWriteTarget || forceHighlight,
                                primaryLabel,
                                colorValue,
                                {
                                    highlightSentinelBit: predictiveCountingMode,
                                    overwrittenWord: predictiveOverwritten,
                                    showOverwriteMarker: overwriteMarkerArmed,
                                    overwriteFlippedThisRow,
                                    overwriteMarkerBit: 31,
                                    slotGroupBits: (() => {
                                        if (!predictiveCountingMode || !predictiveBits) return 0;
                                        if (predictiveBits.mode === 'deltaMicrobucket' && Number.isFinite(predictiveBits.pairBits)) {
                                            return predictiveBits.pairBits;
                                        }
                                        return Number.isFinite(predictiveBits.valueBits) ? predictiveBits.valueBits : 0;
                                    })(),
                                    activeSpanBits: (() => {
                                        if (predictiveOverwritten && deltaSlotVisualInfo) {
                                            return 32;
                                        }
                                        if (!predictiveCountingMode || !predictiveBits || !Number.isFinite(predictiveBits.valueBits)) return 32;
                                        return predictiveOverwritten
                                            ? Math.max(1, Math.min(32, Math.floor(predictiveBits.valueBits)))
                                            : 32;
                                    })(),
                                    labelSpanBits: (() => {
                                        if (deltaSlotVisualInfo && Number.isFinite(deltaSlotVisualInfo.labelSpanBits)) {
                                            return Math.max(1, Math.min(32, Math.floor(deltaSlotVisualInfo.labelSpanBits)));
                                        }
                                        if (!predictiveCountingMode || !predictiveBits || !Number.isFinite(predictiveBits.valueBits)) return 32;
                                        return predictiveOverwritten
                                            ? Math.max(1, Math.min(32, Math.floor(predictiveBits.valueBits)))
                                            : 32;
                                    })(),
                                    labelStartBit: deltaSlotVisualInfo && Number.isFinite(deltaSlotVisualInfo.labelStartBit)
                                        ? Math.max(0, Math.min(31, Math.floor(deltaSlotVisualInfo.labelStartBit)))
                                        : 0,
                                    slotSegments: deltaSlotVisualInfo && Array.isArray(deltaSlotVisualInfo.slotSegments)
                                        ? deltaSlotVisualInfo.slotSegments
                                        : null,
                                    highlightedBitRange
                                }
                            );
                        }

                        let mainBinary;
                        let mainValueHtml;
                        if (predictiveBits && predictiveBits.mode === 'deltaMicrobucket') {
                            const mainSections = formatDeltaBucketSections(
                                value, index, step.values.length,
                                predictiveBits, colorMinValue, colorMaxValue
                            );
                            mainBinary = mainSections.binaryHtml;
                            mainValueHtml = mainSections.valueHtml;
                        } else {
                            mainBinary = formatBinaryValue(value, predictiveCountingMode);
                            const predictiveLabel = predictiveCountingMode
                                ? resolvePredictiveCellLabel(value, splitLabel, predictiveBits, step.minValue)
                                : splitLabel.primary;
                            mainValueHtml = `<span class="delta-val-row">` +
                                `<span class="delta-val-col delta-bits-orig delta-val-highlight">` +
                                `<span class="delta-segment-label">orig</span>` +
                                `<span class="delta-segment-value">${predictiveLabel}</span>` +
                                `</span></span>`;
                        }
                        applyCellTooltipData(item, buildCellTooltip(stepIndex, 'main', index, mainValueHtml, mainBinary));

                        if (roles.length > 0 || forceHighlight) {
                            item.classList.add('tracked-cell');
                            // In displacement-chain mode, scan-only source cells in a chain pair
                            // use the spanning line instead of the per-cell ::after line —
                            // UNLESS the tracked entry carries an explicit bit range (packed word
                            // source in Phase 3 expand), in which case the per-cell underline is
                            // still needed to show which bits within the cell are the active pair.
                            const isChainSrcCell = isDeltaMicrobucketMainMode
                                && allRoles.includes('scan')
                                && !allRoles.includes('write')
                                && slotChainPairs.some((p) => p.src === index)
                                && !(pe && pe.part === 'compress')
                                && !(pe && Number.isFinite(pe.bitOffset) && Number.isFinite(pe.bitWidth));
                            // Only add the per-cell top-line indicator when this cell has a real
                            // role (not just force-highlighted as part of the first/last row).
                            if (!isChainSrcCell && roles.length > 0) {
                                item.classList.add('main-tracked-cell');
                            }
                            const trackRgb = getPackedHeatmapRgb(Number(colorValue), colorMinValue, colorMaxValue);
                            item.style.setProperty('--track-line-color', rgbToString(trackRgb));
                            if (predictiveCountingMode && predictiveBits && Number.isFinite(predictiveBits.valueBits)) {
                                // Explicit per-bit tracked range takes priority (Phase 2b dest / Phase 3 source).
                                if (pe && Number.isFinite(pe.bitOffset) && Number.isFinite(pe.bitWidth)) {
                                    item.style.setProperty('--track-span-start', String(pe.bitOffset));
                                    item.style.setProperty('--track-span-bits', String(pe.bitWidth));
                                } else {
                                    const deltaSlotVisualInfo = getDeltaSlotVisualInfo(
                                        value,
                                        index,
                                        step.values.length,
                                        predictiveBits,
                                        step.minValue,
                                        step.maxValue
                                    );
                                    if (deltaSlotVisualInfo) {
                                        item.style.setProperty('--track-span-start', String(deltaSlotVisualInfo.trackStartBit || 0));
                                        item.style.setProperty('--track-span-bits', String(deltaSlotVisualInfo.trackSpanBits || 32));
                                    } else {
                                        const word = Number(value) >>> 0;
                                        const overwritten = ((word >>> 31) & 1) === 1;
                                        const spanBits = overwritten
                                            ? Math.max(1, Math.min(32, Math.floor(predictiveBits.valueBits)))
                                            : 32;
                                        item.style.setProperty('--track-span-start', '0');
                                        item.style.setProperty('--track-span-bits', String(spanBits));
                                    }
                                }
                            } else {
                                item.style.removeProperty('--track-span-start');
                                item.style.removeProperty('--track-span-bits');
                            }
                        } else if (slotWriteTarget && Number.isFinite(deltaChangedSlotIndex)) {
                            // Bin-only write into a specific slot: highlight just that slot segment.
                            item.classList.add('tracked-cell');
                            item.classList.add('main-tracked-cell');
                            const trackRgb = getPackedHeatmapRgb(Number(colorValue), colorMinValue, colorMaxValue);
                            item.style.setProperty('--track-line-color', rgbToString(trackRgb));
                            const pairBitsVal = predictiveBits && Number.isFinite(predictiveBits.pairBits)
                                ? predictiveBits.pairBits : 0;
                            const valueBitsVal = predictiveBits && Number.isFinite(predictiveBits.valueBits)
                                ? predictiveBits.valueBits : 0;
                            if (pairBitsVal > 0) {
                                item.style.setProperty('--track-span-start', String(valueBitsVal + deltaChangedSlotIndex * pairBitsVal));
                                item.style.setProperty('--track-span-bits', String(pairBitsVal));
                            } else {
                                item.style.removeProperty('--track-span-start');
                                item.style.removeProperty('--track-span-bits');
                            }
                        }

                        mainLaneItemsByIndex.set(index, { item, colorValue });
                    }

                    if (isWritten) {
                        item.classList.add('written-index');
                    }

                    row.appendChild(item);
                });

                // ── Connection line ────────────────────────────────────────────────────
                // Absolutely-positioned grid children: placed by grid-column but take zero
                // layout space (position:absolute within the position:relative .grid-row).
                // left/right use sub-column bit precision via --cell-width-px so the bar
                // starts at the source slot's bit offset and ends at the destination slot's
                // bit end, rather than at a whole-column boundary.
                for (const { src, dst, srcPart, srcBitOffset, srcBitWidth, dstBitOffset, dstBitWidth } of slotChainPairs) {
                    const srcEntry = mainLaneItemsByIndex.get(src);
                    const dstEntry = mainLaneItemsByIndex.get(dst);
                    if (!dstEntry) continue;
                    // For Phase 1 (orig→bin): srcEntry has the placed-value override via buildDv(),
                    // so use it to get the correct colour for the value being displaced.
                    // For all other phases (compress, expand): dstEntry holds the written absolute
                    // value and was the correct colour source before the Phase-1 fix.
                    const colorEntry = (srcPart === 'orig' && srcEntry && Number.isFinite(srcEntry.colorValue))
                        ? srcEntry : dstEntry;
                    if (colorEntry.colorValue === null) continue;
                    const connectRgb = getPackedHeatmapRgb(Number(colorEntry.colorValue), colorMinValue, colorMaxValue);
                    const lo = Math.min(src, dst);
                    const hi = Math.max(src, dst);
                    const srcIsLo = src < dst;
                    // Bit start for the leftmost (lo) column, bit end for the rightmost (hi).
                    const loBitStart = srcIsLo ? (srcBitOffset || 0) : (dstBitOffset || 0);
                    const hiSideOffset = srcIsLo ? (dstBitOffset || 0) : (srcBitOffset || 0);
                    const hiSideWidth  = srcIsLo ? (dstBitWidth  || 32) : (srcBitWidth  || 32);
                    const hiBitEnd = Math.min(hiSideOffset + hiSideWidth, 32);
                    const spanner = document.createElement('div');
                    spanner.style.position = 'absolute';
                    // Include the hi column in the grid span so the bar reaches it.
                    spanner.style.gridColumn = `${mainLaneStartCol + lo} / ${mainLaneStartCol + hi + 1}`;
                    spanner.style.gridRow = '1';
                    spanner.style.top = '0';
                    spanner.style.height = '2px';
                    spanner.style.background = rgbToString(connectRgb);
                    // Sub-column offsets: left trims to the slot start, right trims to the slot end.
                    spanner.style.left  = `calc(${loBitStart} / 32 * var(--cell-width-px))`;
                    spanner.style.right = `calc((32 - ${hiBitEnd}) / 32 * var(--cell-width-px))`;
                    spanner.style.pointerEvents = 'none';
                    spanner.style.zIndex = '200';
                    row.appendChild(spanner);
                    // Retroactively align the dst cell's highlight line colour with the connector
                    // so it reflects the value being placed rather than the first slot entry.
                    if (dstEntry && dstEntry.item.classList.contains('main-tracked-cell')) {
                        dstEntry.item.style.setProperty('--track-line-color', rgbToString(connectRgb));
                    }
                }

                const trackedEntries = [...mainLaneItemsByIndex.entries()]
                    .filter(([, v]) => v.colorValue !== null && v.item.classList.contains('tracked-cell'))
                    .sort((a, b) => a[0] - b[0]);

                if (trackedEntries.length >= 1) row.style.zIndex = '100';
            } // end else (non-packed mode)

            if (hasAuxLane) {
                const divider = document.createElement('div');
                divider.className = 'lane-divider';
                row.appendChild(divider);

                const auxValues = Array.isArray(step.auxValues)
                    ? step.auxValues
                    : new Array(step.values.length).fill(null);

                auxValues.forEach((value, index) => {
                    const item = document.createElement('div');
                    item.className = 'item aux-item';

                    if (value === null || value === undefined) {
                        item.classList.add('empty-item');
                        item.textContent = '';
                        clearCellTooltipData(item);
                    } else {
                        const roles = rolesByLane.aux.get(index) || [];
                        renderCellBitGrid(item, value, colorMinValue, colorMaxValue, roles.length > 0, String(value));
                        const auxBinary = formatBinaryValue(value, false);
                        applyCellTooltipData(item, buildCellTooltip(stepIndex, 'aux', index, String(value), auxBinary));
                        if (roles.length > 0) {
                            item.classList.add('tracked-cell');
                        }
                    }

                    row.appendChild(item);
                });
            }

            if (hasCarryLane) {
                const divider = document.createElement('div');
                divider.className = 'lane-divider';
                row.appendChild(divider);

                const carryItem = document.createElement('div');
                carryItem.className = 'item carry-item';
                const carryValue = step.carryValue;

                if (carryValue === null || carryValue === undefined) {
                    carryItem.classList.add('empty-item');
                    carryItem.textContent = '';
                    clearCellTooltipData(carryItem);
                } else {
                    const roles = rolesByLane.carry.get(0) || [];
                    renderCellBitGrid(carryItem, carryValue, colorMinValue, colorMaxValue, roles.length > 0, String(carryValue));
                    const carryBinary = formatBinaryValue(carryValue, false);
                    applyCellTooltipData(carryItem, buildCellTooltip(stepIndex, 'carry', 0, String(carryValue), carryBinary));
                    if (roles.length > 0) {
                        carryItem.classList.add('tracked-cell');
                    }
                }

                row.appendChild(carryItem);
            }

            if (hasVariableLane) {
                const divider = document.createElement('div');
                divider.className = 'lane-divider';
                row.appendChild(divider);

                const variableValues = [step.minValue, step.maxValue];
                variableValues.forEach((variableValue, index) => {
                    const variableItem = document.createElement('div');
                    variableItem.className = 'item variable-item';

                    if (variableValue === null || variableValue === undefined) {
                        variableItem.classList.add('empty-item');
                        variableItem.textContent = '';
                        clearCellTooltipData(variableItem);
                    } else {
                        const roles = rolesByLane.vars.get(index) || [];
                        renderCellBitGrid(variableItem, variableValue, colorMinValue, colorMaxValue, roles.length > 0, String(variableValue));
                        const variableBinary = formatBinaryValue(variableValue, false);
                        applyCellTooltipData(variableItem, buildCellTooltip(stepIndex, 'vars', index, String(variableValue), variableBinary));
                        if (roles.length > 0) {
                            variableItem.classList.add('tracked-cell');
                        }
                    }

                    row.appendChild(variableItem);
                });
            }

            if (hasSyntheticLane) {
                const divider = document.createElement('div');
                divider.className = 'lane-divider';
                row.appendChild(divider);

                step.values.forEach((value, index) => {
                    const synItem = document.createElement('div');
                    synItem.className = 'item syn-item';

                    const displayLabel = Array.isArray(step.displayValues) ? step.displayValues[index] : undefined;
                    const splitLabel = splitDisplayLabel(displayLabel, value);
                    const synLabel = splitLabel.secondary;  // e.g. "7 ×3" or ""

                    if (isDeltaSyntheticMode) {
                        const synRolesAll = rolesByLane.main.get(index) || [];
                        const synPe = partsByLane.main.get(index);
                        const synRoles = (synPe && synPe.allOrig) ? [] : synRolesAll;
                        synItem.classList.add('delta-bucket');
                        synItem.style.setProperty('--slot-count', String(deltaSlotsPerBucket));

                        const slots = decodeDeltaBucketSlots(
                            value,
                            index,
                            step.values.length,
                            predictiveBits,
                            colorMinValue,
                            colorMaxValue
                        );

                        for (let slotIndex = 0; slotIndex < deltaSlotsPerBucket; slotIndex += 1) {
                            const slotData = slots[slotIndex] || { label: '', colorValue: colorMinValue, isEmpty: true };
                            const slotEl = document.createElement('div');
                            slotEl.className = 'delta-slot';

                            if (slotData.isEmpty) {
                                slotEl.classList.add('delta-slot-empty');
                                slotEl.textContent = '';
                            } else {
                                const slotPalette = getCellPalette(
                                    slotData.colorValue,
                                    colorMinValue,
                                    colorMaxValue,
                                    synRoles
                                );
                                slotEl.style.backgroundColor = slotPalette.background;
                                slotEl.style.color = slotPalette.text;
                                slotEl.style.setProperty('--cell-text', slotPalette.text);
                                slotEl.textContent = slotData.label;
                            }

                            synItem.appendChild(slotEl);
                        }

                        const nonEmptyLabels = slots
                            .filter((slot) => !slot.isEmpty && slot.label)
                            .map((slot) => slot.label);
                        const bucketLabel = nonEmptyLabels.join(', ');
                        const perfectValue = getDeltaBucketPerfectValue(
                            index,
                            step.values.length,
                            colorMinValue,
                            colorMaxValue
                        );
                        const actualValue = splitLabel.primary;
                        const sections = formatDeltaBucketSections(
                            value,
                            index,
                            step.values.length,
                            predictiveBits,
                            colorMinValue,
                            colorMaxValue
                        );
                        applyCellTooltipData(synItem, buildCellTooltip(stepIndex, 'bucket', index, sections.valueHtml, sections.binaryHtml));

                        if (synRoles.length > 0) {
                            synItem.style.fontWeight = 'bold';
                            synItem.style.textShadow = TRACKED_TEXT_SHADOW;
                            synItem.classList.add('tracked-cell');
                        }
                    } else if (predictiveBits && predictiveBits.mode === 'contiguousPacked') {
                        const synRolesAll = rolesByLane.main.get(index) || [];
                        const synPe = partsByLane.main.get(index);
                        const synRoles = (synPe && synPe.allOrig) ? [] : synRolesAll;

                        const packedBits = Number.isFinite(predictiveBits.packedBits) ? predictiveBits.packedBits : 0;
                        const wordStart = index * 32;
                        const wordEnd = wordStart + 32;
                        const packedInWord = Math.max(0, Math.min(wordEnd, packedBits) - wordStart);
                        const packedPct = `${(packedInWord / 32) * 100}%`;

                        synItem.classList.add('bitspace-cell');
                        const bitBar = document.createElement('div');
                        bitBar.className = 'bitspace-bar';
                        bitBar.style.setProperty('--packed-pct', packedPct);
                        synItem.appendChild(bitBar);

                        const valueSummary = synLabel || `packed=${packedInWord}b; tail=${32 - packedInWord}b`;
                        const synBinary = formatContiguousTailBitsForWord(value, index, predictiveBits);
                        applyCellTooltipData(synItem, buildCellTooltip(stepIndex, 'bits', index, valueSummary, synBinary));

                        if (synRoles.length > 0) {
                            synItem.style.fontWeight = 'bold';
                            synItem.style.textShadow = TRACKED_TEXT_SHADOW;
                            synItem.classList.add('tracked-cell');
                        }
                    } else if (!synLabel) {
                        synItem.classList.add('empty-item');
                        synItem.textContent = '';
                        clearCellTooltipData(synItem);
                    } else {
                        // Color by the bin value (left of " ×"), falls back to colorMinValue
                        const binValueStr = synLabel.split(' ×')[0];
                        const binColor = Number(binValueStr);
                        const synRolesAll = rolesByLane.main.get(index) || [];
                        // Suppress bins-lane highlight if this index is only being used for orig value.
                        const synPe = partsByLane.main.get(index);
                        const synRoles = (synPe && synPe.allOrig) ? [] : synRolesAll;
                        const synColorValue = Number.isFinite(binColor) ? binColor : colorMinValue;
                        renderCellBitGrid(synItem, synColorValue, colorMinValue, colorMaxValue, synRoles.length > 0, synLabel);
                        const synBinary = (predictiveBits && predictiveBits.mode === 'overlay3')
                            ? formatBinaryValueSectioned(value, predictiveBits.valueBits, predictiveBits.countShift)
                            : formatBinaryValue(value, true);
                        applyCellTooltipData(synItem, buildCellTooltip(stepIndex, 'bins', index, synLabel, synBinary));
                        if (synRoles.length > 0) {
                            synItem.classList.add('tracked-cell');
                        }
                    }

                    row.appendChild(synItem);
                });
            }

            this.gridContainer.appendChild(row);
        });

        if (this.codeOutput && this.visualizationArea) {
            const tableHeight = Math.max(0, Math.round(this.visualizationArea.getBoundingClientRect().height));
            if (tableHeight > 0) {
                this.codeOutput.style.height = `${tableHeight}px`;
            }
        }
    }

    renderRunError(error, algorithmName, inputList) {
        console.groupCollapsed('[SortLab] Algorithm run failed');
        console.log('simulatorIndex:', this.index);
        console.log('algorithm:', algorithmName);
        console.log('input:', inputList);
        if (error && error.details) {
            console.log('details:', error.details);
        }
        console.error(error);
        console.groupEnd();

        this.gridContainer.innerHTML = '';
        if (this.legendBar) {
            this.legendBar.innerHTML = '';
        }
        const errorPanel = document.createElement('div');
        errorPanel.className = 'run-error';
        errorPanel.textContent = `Run failed: ${error && error.message ? error.message : 'Unknown error'}. Check the console.`;
        this.gridContainer.appendChild(errorPanel);

        this.lastRun = null;
        this.renderStats({ comparisons: 0, indexChecks: 0, swaps: 0 }, null);
        this.renderAlgorithmCode(algorithmName);
    }

    renderLegend(steps) {
        if (!this.legendBar) {
            return;
        }
        this.legendBar.innerHTML = '';

        const usedRoles = new Set();
        steps.forEach((step) => {
            (step.trackedIndices || []).forEach((entry) => {
                if (entry && entry.role) {
                    usedRoles.add(entry.role);
                }
            });
        });

        const orderedRoles = ROLE_DISPLAY_ORDER.filter((role) => usedRoles.has(role));
        if (orderedRoles.length === 0) {
            return;
        }

        orderedRoles.forEach((role) => {
            const chip = document.createElement('span');
            chip.className = 'legend-chip';

            const swatch = document.createElement('span');
            swatch.className = 'legend-swatch';
            const palette = getLegendPalette(role);
            swatch.style.backgroundColor = palette.background;
            swatch.style.color = palette.text;
            swatch.textContent = '■';

            const label = document.createElement('span');
            label.className = 'legend-label';
            label.textContent = ROLE_LABELS[role] || role;

            chip.appendChild(swatch);
            chip.appendChild(label);
            this.legendBar.appendChild(chip);
        });
    }

    getComparisonDisplaySteps(steps) {
        if (!Array.isArray(steps) || steps.length === 0) {
            return [];
        }

        const arraysEqual = (a, b) => {
            if (!Array.isArray(a) && !Array.isArray(b)) {
                return true;
            }
            if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
                return false;
            }
            for (let i = 0; i < a.length; i += 1) {
                if (a[i] !== b[i]) {
                    return false;
                }
            }
            return true;
        };

        const trackedIndicesEqual = (a, b) => {
            if (!Array.isArray(a) && !Array.isArray(b)) {
                return true;
            }
            if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
                return false;
            }
            for (let i = 0; i < a.length; i += 1) {
                const left = a[i] || {};
                const right = b[i] || {};
                if (left.index !== right.index || left.role !== right.role || left.lane !== right.lane) {
                    return false;
                }
            }
            return true;
        };

        const displaySteps = [];
        let previousStep = null;

        steps.forEach((step, index) => {
            const comparisons = step && step.statsSnapshot
                ? (step.statsSnapshot.comparisons ?? 0)
                : 0;

            const indexChecks = step && step.statsSnapshot
                ? (step.statsSnapshot.indexChecks ?? 0)
                : 0;

            const reads = step && step.statsSnapshot
                ? (step.statsSnapshot.reads ?? 0)
                : 0;

            const writes = step && step.statsSnapshot
                ? (step.statsSnapshot.writes ?? 0)
                : 0;

            const swaps = step && step.statsSnapshot
                ? (step.statsSnapshot.swaps ?? 0)
                : 0;

            if (index === 0) {
                displaySteps.push(step);
                previousStep = step;
                return;
            }

            const previousComparisons = previousStep && previousStep.statsSnapshot
                ? (previousStep.statsSnapshot.comparisons ?? 0)
                : 0;
            const previousIndexChecks = previousStep && previousStep.statsSnapshot
                ? (previousStep.statsSnapshot.indexChecks ?? 0)
                : 0;
            const previousReads = previousStep && previousStep.statsSnapshot
                ? (previousStep.statsSnapshot.reads ?? 0)
                : 0;
            const previousWrites = previousStep && previousStep.statsSnapshot
                ? (previousStep.statsSnapshot.writes ?? 0)
                : 0;
            const previousSwaps = previousStep && previousStep.statsSnapshot
                ? (previousStep.statsSnapshot.swaps ?? 0)
                : 0;

            const statsAdvanced = comparisons > previousComparisons
                || indexChecks > previousIndexChecks
                || reads > previousReads
                || writes > previousWrites
                || swaps > previousSwaps;

            const stateChanged = !arraysEqual(step.values, previousStep ? previousStep.values : null)
                || !arraysEqual(step.auxValues, previousStep ? previousStep.auxValues : null)
                || !arraysEqual(step.writtenValues, previousStep ? previousStep.writtenValues : null)
                || !arraysEqual(step.displayValues, previousStep ? previousStep.displayValues : null)
                || step.carryValue !== (previousStep ? previousStep.carryValue : undefined)
                || step.minValue !== (previousStep ? previousStep.minValue : undefined)
                || step.maxValue !== (previousStep ? previousStep.maxValue : undefined)
                || !trackedIndicesEqual(step.trackedIndices, previousStep ? previousStep.trackedIndices : null);

            if (statsAdvanced || stateChanged) {
                displaySteps.push(step);
                previousStep = step;
            }
        });

        const finalStep = steps[steps.length - 1];
        if (displaySteps[displaySteps.length - 1] !== finalStep) {
            displaySteps.push(finalStep);
        }

        return displaySteps;
    }

    toggleCodeColumn() {
        this.showCodeColumn = !this.showCodeColumn;
        if (this.lastRun) {
            const displaySteps = this.getComparisonDisplaySteps(this.lastRun.steps);
            this.renderGrid(displaySteps, this.lastRun.colorMinValue, this.lastRun.colorMaxValue, this.lastRun.predictiveBits);
        }
    }

    renderFromList(list, colorMinValue, colorMaxValue) {
        const algorithmName = this.algorithmSelect.value;
        let runResult;

        try {
            runResult = Algorithms[algorithmName].sort([...list], {
                maxRuntimeMs: SORT_RUN_TIMEOUT_MS,
                maxTicks: SORT_RUN_MAX_TICKS
            });
        } catch (error) {
            this.renderRunError(error, algorithmName, [...list]);
            return;
        }

        const steps = Array.isArray(runResult) ? runResult : runResult.steps;
        const stats = Array.isArray(runResult)
            ? { comparisons: 0, indexChecks: 0, swaps: 0 }
            : runResult.stats;
        this.lastRun = {
            algorithmName,
            inputList: [...list],
            steps,
            stats,
            colorMinValue,
            colorMaxValue,
            predictiveBits: runResult.predictiveBits || null
        };
        const displaySteps = this.getComparisonDisplaySteps(steps);
        this.renderLegend(displaySteps);
        this.renderGrid(displaySteps, colorMinValue, colorMaxValue, this.lastRun.predictiveBits);
        this.renderStats(stats, this.lastRun.predictiveBits);
        this.renderAlgorithmCode(algorithmName);
    }

    renderAlgorithmCode(algorithmName) {
        const algorithm = Algorithms[algorithmName];
        let code = '';
        if (algorithm && typeof algorithm.sort === 'function') {
            code = normalizeDisplayedFunctionCode(algorithm.sort.toString());
        } else if (algorithm && typeof algorithm.code === 'string') {
            code = algorithm.code;
        }
        this.codeOutput.innerHTML = renderHighlightedCodeHtml(code);
    }

    renderStats(stats, predictiveBits = null) {
        this.statsComparisons.textContent = stats.comparisons.toLocaleString();
        this.statsIndexChecks.textContent = (stats.indexChecks ?? 0).toLocaleString();
        this.statsSwaps.textContent = stats.swaps.toLocaleString();
        if (this.modeBadge) {
            const mode = predictiveBits && predictiveBits.mode;
            if (mode) {
                const labels = {
                    contiguousPacked: 'Contiguous Packed',
                    directPacked: 'Direct Packed',
                    deltaMicrobucket: 'Delta Microbucket',
                    overlay3: 'Overlay',
                    sentinelFlagChain: 'Sentinel Flag Chain',
                    sentinelFlagChainFallback: 'Sentinel Flag Chain Fallback'
                };
                this.modeBadge.textContent = labels[mode] || mode;
                this.modeBadge.dataset.mode = mode;
                this.modeBadge.style.display = '';
            } else {
                this.modeBadge.style.display = 'none';
            }
        }
    }
}

class SortLabApp {
    constructor() {
        this.simulators = [];
        this.counter = 0;
        this.listMode = 'sequence';
        this.compactVisualsEnabled = true;
        this.orderedList = [];
        this.shuffledList = [];
        this.draggedIndex = null;

        this.simulatorsContainer = document.getElementById('simulators');
        this.addSimulatorBtn = document.getElementById('add-simulator-btn');
        this.compactViewToggle = document.getElementById('compact-view-toggle');
        this.globalListLengthInput = document.getElementById('global-list-length');
        this.globalListMinInput = document.getElementById('global-list-min');
        this.globalListMaxInput = document.getElementById('global-list-max');
        this.sequenceBtn = document.getElementById('sequence-btn');
        this.randomDistributionBtn = document.getElementById('random-distribution-btn');
        this.shuffleBtn = document.getElementById('shuffle-btn');
        this.copyShuffledBtn = document.getElementById('copy-shuffled-btn');
        this.pasteShuffledBtn = document.getElementById('paste-shuffled-btn');
        this.orderedListLabel = document.getElementById('ordered-list-label');
        this.orderedListContainer = document.getElementById('ordered-list');
        this.shuffledListContainer = document.getElementById('shuffled-list');

        this.restoreCachedInputs();
        this.setupEventListeners();
        this.restoreCachedList();
        this.restoreCachedSimulators();
    }

    setupEventListeners() {
        this.addSimulatorBtn.addEventListener('click', () => this.addSimulator());
        this.compactViewToggle.addEventListener('click', () => this.toggleCompactVisuals());
        this.globalListLengthInput.addEventListener('input', () => this.handleLengthChange());
        this.globalListMinInput.addEventListener('input', () => this.handleRangeChange());
        this.globalListMaxInput.addEventListener('input', () => this.handleRangeChange());
        this.sequenceBtn.addEventListener('click', () => this.regenerateLists('sequence'));
        this.randomDistributionBtn.addEventListener('click', () => this.regenerateLists('linear-random'));
        this.shuffleBtn.addEventListener('click', () => this.shuffleCurrentList());
        this.copyShuffledBtn.addEventListener('click', () => this.copyShuffledList());
        this.pasteShuffledBtn.addEventListener('click', () => this.pasteShuffledList());
        window.addEventListener('resize', () => this.applyVisualizationScaling());

        this.updateCompactViewUi();
    }

    getCachedState() {
        try {
            const raw = window.localStorage.getItem(SORTLAB_CACHE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch (error) {
            return null;
        }
    }

    saveCachedState() {
        const listLength = Number.parseInt(this.globalListLengthInput.value, 10);
        const minValue = Number.parseInt(this.globalListMinInput.value, 10);
        const maxValue = Number.parseInt(this.globalListMaxInput.value, 10);
        const algorithms = this.simulators
            .map((simulator) => simulator.algorithmSelect.value)
            .filter((value) => typeof value === 'string' && value.length > 0);

        const payload = {
            listLength: Number.isFinite(listLength) ? listLength : null,
            minValue: Number.isFinite(minValue) ? minValue : null,
            maxValue: Number.isFinite(maxValue) ? maxValue : null,
            listMode: this.listMode,
            compactVisualsEnabled: this.compactVisualsEnabled,
            algorithms,
            shuffledList: Array.isArray(this.shuffledList) ? this.shuffledList : []
        };

        try {
            window.localStorage.setItem(SORTLAB_CACHE_KEY, JSON.stringify(payload));
        } catch (error) {
            // Ignore write failures (private mode/quota/etc.).
        }
    }

    restoreCachedInputs() {
        const cached = this.getCachedState();
        if (!cached) {
            return;
        }

        if (Number.isFinite(cached.listLength)) {
            this.globalListLengthInput.value = String(cached.listLength);
        }
        if (Number.isFinite(cached.minValue)) {
            this.globalListMinInput.value = String(cached.minValue);
        }
        if (Number.isFinite(cached.maxValue)) {
            this.globalListMaxInput.value = String(cached.maxValue);
        }
        if (typeof cached.compactVisualsEnabled === 'boolean') {
            this.compactVisualsEnabled = cached.compactVisualsEnabled;
        }
        if (cached.listMode === 'sequence' || cached.listMode === 'linear-random' || cached.listMode === 'pasted') {
            this.listMode = cached.listMode;
        }
    }

    restoreCachedList() {
        const cached = this.getCachedState();
        const cachedShuffled = cached && Array.isArray(cached.shuffledList)
            ? cached.shuffledList.map((value) => Number.parseInt(value, 10)).filter((value) => Number.isFinite(value))
            : [];

        if (cachedShuffled.length >= 5) {
            this.shuffledList = [...cachedShuffled];
            this.orderedList = [...cachedShuffled].sort((a, b) => a - b);
            this.globalListLengthInput.value = String(cachedShuffled.length);
            if (this.listMode === 'linear-random') {
                const range = this.getGeneratorRange();
                if (range) {
                    this.orderedListLabel.textContent = `Sorted random sample (${range.min} to ${range.max})`;
                }
            } else if (this.listMode === 'sequence') {
                const range = this.getGeneratorRange();
                if (range) {
                    this.orderedListLabel.textContent = `Complete sequence (${range.min} to ${range.max})`;
                }
            } else {
                this.orderedListLabel.textContent = 'From pasted sequence';
            }
            this.renderListPanels();
            this.renderAllSimulators();
            return;
        }

        this.regenerateLists(this.listMode);
    }

    restoreCachedSimulators() {
        const cached = this.getCachedState();
        const candidates = cached && Array.isArray(cached.algorithms) ? cached.algorithms : [];
        const validAlgorithms = new Set(['bubble', 'selection', 'insertion', 'merge', 'quick', 'prediction', 'predictiveCounting']);
        const restoredAlgorithms = candidates.filter((name) => validAlgorithms.has(name));
        const defaults = ['quick', 'prediction'];
        const algorithms = restoredAlgorithms.length > 0 ? restoredAlgorithms : defaults;

        algorithms.forEach((name) => this.addSimulator(name));
        this.saveCachedState();
    }

    addSimulator(initialAlgorithm = 'bubble') {
        this.counter += 1;
        const simulator = new SortSimulator(
            this.counter,
            (instance) => this.removeSimulator(instance),
            () => {
                this.renderAllSimulators();
                this.saveCachedState();
            }
        );

        simulator.algorithmSelect.value = initialAlgorithm;

        this.simulators.push(simulator);
        this.simulatorsContainer.insertBefore(simulator.root, this.addSimulatorBtn);
        this.updateRemoveButtonVisibility();
        this.updateSimulatorGridLayout();
        this.renderSimulator(simulator);
        this.applyVisualizationScaling();
        this.saveCachedState();
    }

    removeSimulator(instance) {
        if (this.simulators.length === 1) {
            return;
        }

        this.simulators = this.simulators.filter((simulator) => simulator !== instance);
        instance.root.remove();
        this.updateRemoveButtonVisibility();
        this.updateSimulatorGridLayout();
        this.applyVisualizationScaling();
        this.saveCachedState();
    }

    updateRemoveButtonVisibility() {
        const canRemove = this.simulators.length > 1;
        this.simulators.forEach((simulator) => {
            simulator.removeBtn.disabled = !canRemove;
            simulator.removeBtn.style.opacity = canRemove ? '1' : '0.5';
        });
    }

    updateSimulatorGridLayout() {
        const isSingleSimulator = this.simulators.length <= 1;
        this.simulatorsContainer.classList.toggle('single-simulator', isSingleSimulator);
        this.simulatorsContainer.style.setProperty(
            '--simulator-columns',
            String(Math.max(1, this.simulators.length))
        );
    }

    handleLengthChange() {
        const length = this.getListLength();
        if (length === null) {
            return;
        }

        this.regenerateLists(this.listMode);
    }

    handleRangeChange() {
        const range = this.getGeneratorRange();
        if (range === null) {
            return;
        }

        this.regenerateLists(this.listMode);
    }

    getListLength() {
        const listLength = parseInt(this.globalListLengthInput.value, 10);
        if (Number.isNaN(listLength) || listLength < 5 || listLength > 100) {
            return null;
        }
        return listLength;
    }

    getGeneratorRange() {
        const minValue = Number.parseInt(this.globalListMinInput.value, 10);
        const maxValue = Number.parseInt(this.globalListMaxInput.value, 10);
        if (Number.isNaN(minValue) || Number.isNaN(maxValue)) {
            return null;
        }

        if (minValue <= maxValue) {
            return { min: minValue, max: maxValue };
        }

        this.globalListMinInput.value = String(maxValue);
        this.globalListMaxInput.value = String(minValue);
        return { min: maxValue, max: minValue };
    }

    buildBoundedSequence(length, minValue, maxValue) {
        if (length <= 1) {
            return [minValue];
        }
        if (minValue === maxValue) {
            return new Array(length).fill(minValue);
        }

        const step = (maxValue - minValue) / (length - 1);
        const values = [];
        for (let index = 0; index < length; index += 1) {
            const rawValue = minValue + (step * index);
            const rounded = Math.round(rawValue);
            const clamped = Math.max(minValue, Math.min(maxValue, rounded));
            if (index === 0) {
                values.push(clamped);
            } else {
                values.push(Math.max(values[index - 1], clamped));
            }
        }

        values[0] = minValue;
        values[length - 1] = maxValue;
        return values;
    }

    regenerateLists(mode) {
        const length = this.getListLength();
        const range = this.getGeneratorRange();
        if (length === null || range === null) {
            return;
        }

        const { min: minValue, max: maxValue } = range;
        this.listMode = mode;
        if (mode === 'linear-random') {
            const randomValues = [];
            for (let i = 0; i < length; i++) {
                randomValues.push(minValue + Math.floor(Math.random() * (maxValue - minValue + 1)));
            }
            this.orderedList = [...randomValues].sort((a, b) => a - b);
            this.orderedListLabel.textContent = `Sorted random sample (${minValue} to ${maxValue})`;
        } else {
            this.orderedList = this.buildBoundedSequence(length, minValue, maxValue);
            this.orderedListLabel.textContent = `Complete sequence (${minValue} to ${maxValue})`;
        }

        this.shuffleCurrentList();
        this.saveCachedState();
    }

    shuffleCurrentList() {
        this.shuffledList = [...this.orderedList];
        for (let i = this.shuffledList.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.shuffledList[i], this.shuffledList[j]] = [this.shuffledList[j], this.shuffledList[i]];
        }

        this.renderListPanels();
        this.renderAllSimulators();
        this.saveCachedState();
    }

    async copyShuffledList() {
        const text = this.shuffledList.join(',');
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                return;
            }
        } catch (error) {
            // Fall through to legacy copy path.
        }

        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.setAttribute('readonly', 'readonly');
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        textArea.style.pointerEvents = 'none';
        textArea.style.left = '-9999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        textArea.setSelectionRange(0, textArea.value.length);
        document.execCommand('copy');
        document.body.removeChild(textArea);
    }

    pasteShuffledList() {
        const raw = window.prompt('Paste shuffled list (comma or space separated numbers):', this.shuffledList.join(','));
        if (raw === null) {
            return;
        }

        const values = raw
            .split(/[\s,]+/)
            .map((part) => part.trim())
            .filter((part) => part.length > 0)
            .map((part) => Number.parseInt(part, 10));

        if (values.length < 5 || values.some((value) => Number.isNaN(value))) {
            window.alert('Enter at least 5 valid integers.');
            return;
        }

        this.shuffledList = values;
        this.orderedList = [...values].sort((a, b) => a - b);
        this.listMode = 'pasted';
        this.globalListLengthInput.value = String(values.length);
        this.orderedListLabel.textContent = 'From pasted sequence';
        this.renderListPanels();
        this.renderAllSimulators();
        this.saveCachedState();
    }

    toggleCompactVisuals() {
        this.compactVisualsEnabled = !this.compactVisualsEnabled;
        this.updateCompactViewUi();
        this.applyVisualizationScaling();
        this.saveCachedState();
    }

    updateCompactViewUi() {
        document.body.classList.toggle('compact-visuals-enabled', this.compactVisualsEnabled);
        this.compactViewToggle.classList.toggle('is-active', this.compactVisualsEnabled);
        this.compactViewToggle.setAttribute('aria-pressed', String(this.compactVisualsEnabled));
        this.compactViewToggle.textContent = this.compactVisualsEnabled
            ? 'Fit Height: On'
            : 'Fit Height: Off';
    }

    renderListPanels() {
        const allValues = [...this.orderedList, ...this.shuffledList];
        const colorMinValue = Math.min(...allValues);
        const colorMaxValue = Math.max(...allValues);
        this.renderListPreview(this.orderedListContainer, this.orderedList, colorMinValue, colorMaxValue, false);
        this.renderListPreview(this.shuffledListContainer, this.shuffledList, colorMinValue, colorMaxValue, true);
    }

    renderListPreview(container, list, colorMinValue, colorMaxValue, interactive) {
        container.innerHTML = '';

        list.forEach((value, index) => {
            const chip = document.createElement('div');
            chip.className = 'list-chip';
            chip.style.position = 'relative';
            renderCellBitGrid(chip, value, colorMinValue, colorMaxValue, true, String(value));

            // Click to edit (any chip in either list)
            chip.addEventListener('click', (e) => {
                if (chip.querySelector('input')) return;
                chip.draggable = false;
                const inputEl = document.createElement('input');
                inputEl.type = 'number';
                inputEl.value = String(value);
                inputEl.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;background:#1c2128;border:2px solid #58a6ff;border-radius:0;color:#f0f6fc;font-size:13px;font-weight:700;text-align:center;z-index:10;padding:0;box-sizing:border-box;';
                chip.appendChild(inputEl);
                inputEl.focus();
                inputEl.select();
                let done = false;
                const commit = () => {
                    if (done) return;
                    done = true;
                    const newVal = Number.parseInt(inputEl.value, 10);
                    if (Number.isFinite(newVal)) {
                        if (interactive) {
                            this.shuffledList[index] = newVal;
                        } else {
                            this.orderedList[index] = newVal;
                            // Treat the ordered list edit as a new shuffled list
                            this.shuffledList = [...this.orderedList];
                        }
                        this.orderedList = [...this.shuffledList].sort((a, b) => a - b);
                        this.renderListPanels();
                        this.renderAllSimulators();
                        this.saveCachedState();
                    } else {
                        this.renderListPanels();
                    }
                };
                inputEl.addEventListener('blur', commit);
                inputEl.addEventListener('keydown', (ke) => {
                    if (ke.key === 'Enter') inputEl.blur();
                    if (ke.key === 'Escape') { done = true; this.renderListPanels(); }
                });
            });

            if (interactive) {
                chip.draggable = true;
                chip.dataset.index = index;
                chip.addEventListener('dragstart', (event) => this.handleDragStart(event));
                chip.addEventListener('dragenter', (event) => this.handleDragEnter(event));
                chip.addEventListener('dragover', (event) => this.handleDragOver(event));
                chip.addEventListener('dragleave', (event) => this.handleDragLeave(event));
                chip.addEventListener('drop', (event) => this.handleDrop(event));
                chip.addEventListener('dragend', (event) => this.handleDragEnd(event));
            }

            container.appendChild(chip);
        });
    }

    handleDragStart(event) {
        const chip = event.currentTarget;
        this.draggedIndex = Number(chip.dataset.index);
        chip.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
    }

    handleDragEnter(event) {
        event.preventDefault();
        event.currentTarget.classList.add('drop-target');
    }

    handleDragOver(event) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
    }

    handleDragLeave(event) {
        event.currentTarget.classList.remove('drop-target');
    }

    handleDrop(event) {
        event.preventDefault();
        const targetChip = event.currentTarget;
        const targetIndex = Number(targetChip.dataset.index);
        targetChip.classList.remove('drop-target');

        if (this.draggedIndex === null || targetIndex === this.draggedIndex) {
            return;
        }

        const nextList = [...this.shuffledList];
        const [movedValue] = nextList.splice(this.draggedIndex, 1);
        nextList.splice(targetIndex, 0, movedValue);
        this.shuffledList = nextList;
        this.draggedIndex = null;
        this.renderListPanels();
        this.renderAllSimulators();
        this.saveCachedState();
    }

    handleDragEnd(event) {
        event.currentTarget.classList.remove('dragging');
        this.clearDropTargets();
        this.draggedIndex = null;
    }

    clearDropTargets() {
        this.shuffledListContainer.querySelectorAll('.drop-target').forEach((chip) => {
            chip.classList.remove('drop-target');
        });
    }

    renderSimulator(simulator) {
        if (this.shuffledList.length === 0) {
            return;
        }

        const allValues = [...this.orderedList, ...this.shuffledList];
        const colorMinValue = Math.min(...allValues);
        const colorMaxValue = Math.max(...allValues);
        simulator.renderFromList(this.shuffledList, colorMinValue, colorMaxValue);
    }

    renderAllSimulators() {
        this.simulators.forEach((simulator) => {
            this.renderSimulator(simulator);
        });

        this.applyVisualizationScaling();
    }

    applyVisualizationScaling() {
        if (this.simulators.length === 0) {
            return;
        }

        // Reset to natural cell height before measuring, so we always scale from 22px baseline.
        this.simulators.forEach((simulator) => {
            simulator.gridContainer.style.removeProperty('--item-height');
        });

        const tallestGridHeight = this.simulators.reduce((maxHeight, simulator) => {
            return Math.max(maxHeight, simulator.gridContainer.scrollHeight);
        }, 0);

        if (tallestGridHeight === 0) {
            return;
        }

        if (!this.compactVisualsEnabled) {
            this.simulators.forEach((simulator) => {
                simulator.gridContainer.style.transform = '';
                simulator.gridContainer.style.removeProperty('--item-height');
                simulator.visualizationArea.style.height = `${tallestGridHeight}px`;
            });
            return;
        }

        const top = this.simulatorsContainer.getBoundingClientRect().top;
        const availableHeight = Math.max(180, window.innerHeight - top - 24);
        const scale = Math.min(1, availableHeight / tallestGridHeight);

        const scaledHeight = Math.max(1, tallestGridHeight * scale);
        // Keep rows readable in fit mode; ultra-thin rows cause text to visually overlap.
        const itemHeight = Math.max(8, Math.floor(22 * scale));
        this.simulators.forEach((simulator) => {
            simulator.gridContainer.style.transform = '';
            simulator.gridContainer.style.setProperty('--item-height', `${itemHeight}px`);
            simulator.visualizationArea.style.height = `${scaledHeight}px`;
        });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new SortLabApp();
});
