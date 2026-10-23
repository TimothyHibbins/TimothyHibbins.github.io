// SVG diagram renderer: turns a recipe document into positioned lines,
// utensil/process rectangles and step labels. The TIME axis runs vertically
// as discrete step rows below two header sections (utensils, then
// ingredients); the LANE axis is a plain 1-D line left to right
// (`leftMargin`/`rightMargin`). Utensils are permanent fixtures with an `x`
// on it, and ingredients have a real `x` on that same line.
(function (global) {
    'use strict';

    const SVG_NS = 'http://www.w3.org/2000/svg';

    const LAYOUT = {
        columnWidth: 190,
        leftMargin: 80,
        rightMargin: 24,
        // Generous enough to stack several tiers of pill labels above row 0
        // (very common -- most ingredients start there) without reaching up
        // into the utensil fixtures' own name labels sitting just below
        // `zoneHeaderHeight` (see labelLineHeight/pillPad below).
        topMargin: 170,
        bottomMargin: 20,
        // A vertical gutter along the left edge holds the draggable/
        // renameable time-step handles + guide lines (horizontal, spanning
        // the lane axis, since time itself runs downward).
        headerX: 6,
        headerWidth: 22,
        // Two header sections sit above the step rows: a utensil strip (also
        // the "click empty space to create a utensil" band) then the
        // ingredient section (bordered top/bottom, "click empty space to
        // create an ingredient"), which is where tiered name/quantity labels
        // stack. The ingredient section's height follows the number of label
        // tiers, so `topMargin`/`utensilTop` are recomputed on every render
        // (see renderDiagram) -- never a fixed number labels can overflow.
        headerTopPad: 4,
        utensilLabelBandHeight: 30,
        stepHandleRadius: 11,
        // A process rect exactly matches its utensil's fixed width -- no
        // poke/padding needed since the utensil is no longer sized from its
        // contained lines.
        // Ingredient/merge name tags stack in tiers above their birth row so
        // several starting in the same row (very common at row 0) don't
        // overlap each other horizontally -- see layoutLineLabels(). Must be
        // at least the pill's own rendered height (text + 2*pillPadY) or
        // adjacent tiers overlap VERTICALLY regardless of how much
        // horizontal clearance the packing itself reserves.
        labelLineHeight: 24,
        labelBaseGap: 10,
        labelMinGap: 8,
        // Padding around a label's text -- shared between sizing the
        // background rect and reserving horizontal clearance for it during
        // tiering (layoutLineLabels), so the two always agree on how wide a
        // label actually is on screen.
        pillPadX: 1,
        pillPadY: 1,
        // Sharp corners, like a highlighter stroke across text in a
        // document -- not a rounded pill/capsule at all.
        labelCornerRadius: 0,
        // Thin grab-strips along a utensil's left/right edges or a
        // process's top/bottom edges, for resizing by dragging the edge
        // itself rather than a separate handle floating off to the side.
        edgeHandleSize: 8,
        // Every bend (a move, a combine/add convergence, a split divergence)
        // spans exactly its own step row, top edge to bottom edge. Bends are
        // sampled as this many straight segments, bulge by `bendTrailBulge`
        // extra half-width mid-bend, and keep at least `bendMinPerp` px of
        // half-thickness PERPENDICULAR to their path -- a wide sideways move
        // across one short row is nearly horizontal, so its literal
        // horizontal thickness alone would be thinner than a pixel.
        bendTrailSteps: 14,
        bendTrailBulge: 4,
        bendMinPerp: 3,
        // Time is DISCRETE: every column is one step row, stacked flush like
        // table rows -- order is all that matters, not a continuous y. The
        // row height itself is user-adjustable per recipe (`model.rowHeight`,
        // see `rowH`); this is only the fallback/bounds.
        rowHeight: 20,
        minRowHeight: 14,
        maxRowHeight: 60,
        // Left gutter step-number cells.
        stepNumberWidth: 26,
        // Default width of the lane axis (grows to fit whatever is placed).
        laneWidth: 1270
    };
    // Header geometry; renderDiagram recomputes these (the ingredient
    // section grows with its label tiers) before anything is positioned.
    LAYOUT.utensilTop = LAYOUT.topMargin;
    LAYOUT.utensilLabelBandTop = LAYOUT.headerTopPad;
    LAYOUT.ingredientBandTop = LAYOUT.utensilLabelBandTop + LAYOUT.utensilLabelBandHeight;
    LAYOUT.ingredientBandBottom = LAYOUT.topMargin;

    // Every stored position (zone/utensil/ingredient x, a move's newX, a
    // merge's outputX) is an offset from `leftMargin` -- this is the only
    // place that offset is actually added, mirroring how `rowY` adds
    // `topMargin` to a column's stored `.x`.
    function laneX(offset) {
        return LAYOUT.leftMargin + (offset || 0);
    }

    function buildLines(model) {
        const lines = new Map();
        const lastCol = model.timeSteps.length - 1;


        // Ingredients exist from the very top (they are created in the
        // ingredient section, above the first step row), so they never have a
        // birth row of their own.
        model.ingredients.forEach(ing => {
            lines.set(ing.id, {
                id: ing.id,
                name: ing.name,
                quantity: ing.quantity,
                color: ing.color,
                thickness: ing.thickness,
                birth: 0,
                death: lastCol,
                endsInMerge: false,
                deathKind: null,
                xChanges: [{ col: 0, x: ing.x || 0 }],
                thicknessChanges: [{ col: 0, thickness: ing.thickness }],
                kind: 'ingredient'
            });
        });

        // Time steps hold a `.steps` ARRAY -- several unrelated lines' events
        // (moves/merges) can genuinely share one column/moment, so walking
        // them in column order still naturally processes everything in
        // chronological order without needing a separate sort.
        model.timeSteps.forEach((ts, c) => {
            (ts.steps || []).forEach(step => {
                if (step.type === 'move') {
                    const l = lines.get(step.lineId);
                    if (l) l.xChanges.push({ col: c, x: step.newX });
                } else if (step.type === 'merge') {
                    step.inputLineIds.forEach(id => {
                        const l = lines.get(id);
                        if (l) { l.death = c; l.endsInMerge = true; l.deathKind = 'merge'; }
                    });
                    lines.set(step.outputLineId, {
                        id: step.outputLineId,
                        name: step.outputName || '',
                        quantity: '',
                        color: step.outputColor || '#888888',
                        thickness: step.outputThickness || 10,
                        birth: c,
                        death: lastCol,
                        endsInMerge: false,
                        deathKind: null,
                        xChanges: [{ col: c, x: step.outputX || 0 }],
                        thicknessChanges: [{ col: c, thickness: step.outputThickness || 10 }],
                        kind: 'merge',
                        timerStepId: step.id,
                        timer: step.timer || 0
                    });
                } else if (step.type === 'add') {
                    // Keeps the base line's own identity going forward --
                    // no new line is born, the absorbed line just dies here
                    // and the base's own thickness steps up from this
                    // column on (see `getThicknessAt`).
                    const added = lines.get(step.addedLineId);
                    if (added) { added.death = c; added.endsInMerge = true; added.deathKind = 'add'; }
                    const base = lines.get(step.baseLineId);
                    if (base) {
                        const newThickness = step.newThickness || base.thickness;
                        base.thicknessChanges.push({ col: c, thickness: newThickness });
                        base.thickness = newThickness;
                    }
                } else if (step.type === 'split') {
                    // The time-reverse of an `add`: the source line carries on
                    // UNMOVED (just thinner, stepping down at the row's top
                    // edge) and a brand new ingredient is born touching it and
                    // diverges sideways to its own resting `x` (stored on the
                    // step, like a merge's `outputX`).
                    const source = lines.get(step.sourceLineId);
                    const o = step.output;
                    if (!o) return;
                    if (source) {
                        const cur = source.thicknessChanges[source.thicknessChanges.length - 1].thickness;
                        const newT = step.newThickness || Math.max(1, cur - (o.thickness || 1));
                        source.thicknessChanges.push({ col: c, thickness: newT, at: 'top' });
                        source.thickness = newT;
                    }
                    lines.set(o.lineId, {
                        id: o.lineId,
                        name: o.name || '',
                        quantity: '',
                        color: o.color || (source ? source.color : '#888888'),
                        thickness: o.thickness || 10,
                        birth: c,
                        death: lastCol,
                        endsInMerge: false,
                        deathKind: null,
                        xChanges: [{ col: c, x: o.x || 0 }],
                        thicknessChanges: [{ col: c, thickness: o.thickness || 10 }],
                        kind: 'split',
                        splitSourceId: step.sourceLineId,
                        timerStepId: step.id,
                        timer: step.timer || 0
                    });
                }
            });
        });
        lines.forEach(l => {
            l.xChanges.sort((a, b) => a.col - b.col);
            l.thicknessChanges.sort((a, b) => a.col - b.col);
        });
        return lines;
    }

    function getThicknessAt(line, col) {
        let t = line.thicknessChanges[0] ? line.thicknessChanges[0].thickness : line.thickness;
        for (const change of line.thicknessChanges) {
            if (change.col <= col) t = change.thickness; else break;
        }
        return t;
    }

    function getXAt(line, col) {
        let x = line.xChanges[0] ? line.xChanges[0].x : 0;
        for (const change of line.xChanges) {
            if (change.col <= col) x = change.x; else break;
        }
        return x;
    }

    // One layout entry per line per column, read straight off its own
    // directly-stored x (no abstract lane-to-pixel mapping needed any more --
    // a line's position on the counter IS its position); merge inputs are
    // packed side-by-side (each keeping its OWN thickness) into slots
    // across the output's full width, like a Sankey node, rather than all
    // independently converging onto the exact same centre point -- that
    // makes them visually touch edge-to-edge by the merge row instead of
    // overlapping, with the combined band's total width conserved
    // throughout (no sudden jump to the output's width right at the row).
    function computeLayouts(model, lines) {
        const layouts = [];
        for (let c = 0; c < model.timeSteps.length; c++) {
            const layout = {};
            lines.forEach(l => {
                if (c < l.birth || c > l.death) return;
                layout[l.id] = { x: getXAt(l, c), thickness: getThicknessAt(l, c) };
            });
            const steps = model.timeSteps[c].steps || [];
            steps.forEach(step => {
                if (step.type === 'merge') {
                    const out = lines.get(step.outputLineId);
                    const outEntry = out && layout[out.id];
                    if (!outEntry) return;
                    const inputs = step.inputLineIds.map(id => ({ id, entry: layout[id] })).filter(e => e.entry);
                    if (!inputs.length) return;
                    // Left-to-right by current position, so each input
                    // slots in on the same side it's already approaching
                    // from and nothing has to visually cross its neighbour.
                    inputs.sort((a, b) => a.entry.x - b.entry.x);
                    const totalWidth = inputs.reduce((sum, e) => sum + e.entry.thickness, 0) || outEntry.thickness;
                    let edge = outEntry.x - totalWidth / 2;
                    inputs.forEach(e => {
                        layout[e.id] = { x: edge + e.entry.thickness / 2, thickness: e.entry.thickness };
                        edge += e.entry.thickness;
                    });
                } else if (step.type === 'add') {
                    // Same idea with only one "input" -- it slides to touch
                    // whichever outer edge of the base's own (pre-add)
                    // width it's already closer to, rather than overlapping
                    // the base's centre. Must use the base's thickness just
                    // BEFORE this column, not `layout[baseLineId].thickness`
                    // (which already reflects the post-add value, since
                    // `getThicknessAt` includes this exact column) -- the
                    // base hasn't actually widened yet at the touch point.
                    const baseEntry = layout[step.baseLineId];
                    const addedEntry = layout[step.addedLineId];
                    if (!baseEntry || !addedEntry) return;
                    const baseLine = lines.get(step.baseLineId);
                    const baseOldThickness = baseLine ? getThicknessAt(baseLine, c - 1) : baseEntry.thickness;
                    const side = addedEntry.x < baseEntry.x ? -1 : 1;
                    const slotCenter = baseEntry.x + side * (baseOldThickness / 2 + addedEntry.thickness / 2);
                    layout[step.addedLineId] = { x: slotCenter, thickness: addedEntry.thickness };
                }
                // A split's outputs need no override here -- each one's own
                // `x` (set once, at creation time, see interact.js) is a
                // real stored resting position carried via its own
                // xChanges, exactly like a merge's `outputX`, not something
                // recomputed fresh every render.
            });
            layouts.push(layout);
        }
        return layouts;
    }

    // Discrete step rows. A row occupies [rowTop, rowTop + rowH]; row 0 starts
    // exactly where the ingredient band ends (`topMargin`). `rowY` is the
    // row's vertical CENTRE -- the anchor every line point, bend and step
    // label hangs off -- so it's purely a function of array order.
    function rowH(model) {
        const h = model && model.rowHeight;
        const v = Number.isFinite(h) ? h : LAYOUT.rowHeight;
        return Math.max(LAYOUT.minRowHeight, Math.min(LAYOUT.maxRowHeight, v));
    }
    function rowTop(model, c) {
        return LAYOUT.topMargin + c * rowH(model);
    }
    function rowY(model, c) {
        return rowTop(model, c) + rowH(model) / 2;
    }

    function computeDiagramSize(model, layouts) {
        let maxOffset = LAYOUT.laneWidth;
        layouts.forEach(layout => {
            Object.values(layout).forEach(entry => {
                maxOffset = Math.max(maxOffset, entry.x + entry.thickness / 2);
            });
        });
        (model.utensils || []).forEach(u => { maxOffset = Math.max(maxOffset, u.x + u.width); });
        // One extra row below the last step holds the "+" add-row cell.
        const height = rowTop(model, model.timeSteps.length + 1) + LAYOUT.bottomMargin;
        const width = laneX(maxOffset) + LAYOUT.rightMargin;
        return { width, height };
    }

    function svgEl(tag, attrs) {
        const el = document.createElementNS(SVG_NS, tag);
        if (attrs) Object.keys(attrs).forEach(k => el.setAttribute(k, attrs[k]));
        return el;
    }

    function clear(svg) {
        while (svg.firstChild) svg.removeChild(svg.firstChild);
    }

    // Picks whichever of black/white reads better on a given pill colour
    // (standard relative-luminance threshold) instead of always using
    // white, which disappears against light/pastel ingredient colours.
    function readableTextColor(bgColor) {
        const hex = /^#([0-9a-fA-F]{6})$/.exec(bgColor || '');
        if (!hex) return '#fff';
        const r = parseInt(hex[1].slice(0, 2), 16), g = parseInt(hex[1].slice(2, 4), 16), b = parseInt(hex[1].slice(4, 6), 16);
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        return luminance > 0.6 ? '#1a1a1a' : '#fff';
    }

    // Fits a colour-matched highlight rect to a text node's actual rendered
    // box (a thin rounded-rect, not a full pill/capsule) -- the text must
    // already be attached to the live, visible SVG for `getBBox()` to
    // return real measurements, so callers append both first and call this
    // once the text's final position is settled.
    function sizePillLabel(rect, textEl, padX, padY) {
        let bbox;
        try { bbox = textEl.getBBox(); } catch (err) { return; }
        if (!bbox || (!bbox.width && !bbox.height)) return;
        rect.setAttribute('x', bbox.x - padX);
        rect.setAttribute('y', bbox.y - padY);
        rect.setAttribute('width', bbox.width + padX * 2);
        rect.setAttribute('height', bbox.height + padY * 2);
        rect.setAttribute('rx', LAYOUT.labelCornerRadius);
        rect.setAttribute('ry', LAYOUT.labelCornerRadius);
    }

    // Measures the union bounding box of several text nodes and fits ONE
    // highlight rect around all of them together (thin rounded-rect, not a
    // full pill) -- used for a label whose parts (e.g. quantity + name)
    // share one background instead of each getting its own.
    function sizeGroupPill(rect, parts, padX, padY) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        parts.forEach(part => {
            let bbox;
            try { bbox = part.text.getBBox(); } catch (err) { return; }
            if (!bbox || (!bbox.width && !bbox.height)) return;
            minX = Math.min(minX, bbox.x);
            minY = Math.min(minY, bbox.y);
            maxX = Math.max(maxX, bbox.x + bbox.width);
            maxY = Math.max(maxY, bbox.y + bbox.height);
        });
        if (minX === Infinity) return null;
        rect.setAttribute('x', minX - padX);
        rect.setAttribute('y', minY - padY);
        rect.setAttribute('width', (maxX - minX) + padX * 2);
        rect.setAttribute('height', (maxY - minY) + padY * 2);
        rect.setAttribute('rx', LAYOUT.labelCornerRadius);
        rect.setAttribute('ry', LAYOUT.labelCornerRadius);
        return { minY: minY - padY, maxY: maxY + padY };
    }

    // ---- Line geometry ----------------------------------------------------
    // A line is a list of keyframes `{x, h, y, bend}` (x = lane offset, h =
    // half-thickness, y = absolute SVG y). A keyframe with `bend:false`
    // continues straight down from the previous one (plus an instant width
    // step if `h` differs at the same y); `bend:true` is an S-curve from the
    // previous keyframe to this one. Every event owns exactly one step row:
    // the bend runs from that row's top edge to its bottom edge.
    function buildLineGeometry(model, line, layouts) {
        const top = c => rowTop(model, c), bot = c => rowTop(model, c + 1);
        const keys = [];
        const first = layouts[line.birth] && layouts[line.birth][line.id];
        if (!first) return keys;
        let x = first.x, h = first.thickness / 2;
        // A combine's output starts where its inputs finish (row bottom);
        // everything else starts at its row's top edge.
        let y = line.kind === 'merge' ? bot(line.birth) : top(line.birth);
        if (line.kind === 'split') {
            // Born touching the side of the source it peels away from (whose
            // own thickness has already stepped down at this row's top),
            // then diverges out to its resting x across the split's row.
            const src = layouts[line.birth] && layouts[line.birth][line.splitSourceId];
            if (src) {
                const side = first.x < src.x ? -1 : 1;
                x = src.x + side * (src.thickness / 2 + first.thickness / 2);
            }
        }
        keys.push({ x, h, y, bend: false });
        if (line.kind === 'split') {
            keys.push({ x: first.x, h, y: bot(line.birth), bend: true });
            x = first.x;
            y = bot(line.birth);
        }
        const hasX = c => line.xChanges.some(ch => ch.col === c && ch.col > line.birth);
        const thickAt = c => line.thicknessChanges.find(ch => ch.col === c && ch.col > line.birth);
        for (let c = line.birth + 1; c <= line.death; c++) {
            if (c === line.death && (line.deathKind === 'merge' || line.deathKind === 'add')) {
                const slot = layouts[c] && layouts[c][line.id];
                if (!slot) return keys;
                if (y < top(c)) keys.push({ x, h, y: top(c), bend: false });
                keys.push({ x: slot.x, h, y: bot(c), bend: true });
                return keys;
            }
            const mv = hasX(c), tc = thickAt(c);
            if (!mv && !tc) continue;
            const nh = tc ? getThicknessAt(line, c) / 2 : h;
            if (mv) {
                const nx = getXAt(line, c);
                if (y < top(c)) keys.push({ x, h, y: top(c), bend: false });
                keys.push({ x: nx, h: nh, y: bot(c), bend: true });
                x = nx; h = nh; y = bot(c);
            } else {
                // A pure width change is an instant flat step, never a taper:
                // at the row's bottom edge (an add), or its top edge (a split).
                const yy = tc.at === 'top' ? top(c) : bot(c);
                if (y < yy) keys.push({ x, h, y: yy, bend: false });
                keys.push({ x, h: nh, y: yy, bend: false });
                h = nh; y = yy;
            }
        }
        const endY = bot(model.timeSteps.length - 1);
        if (y < endY) keys.push({ x, h, y: endY, bend: false });
        return keys;
    }

    // Lane offset of a line's centre at a given absolute y (clamped to the
    // line's own extent) -- same S-curve the ribbon is drawn with.
    function lineXAtY(keys, y) {
        if (!keys.length) return 0;
        if (y <= keys[0].y) return keys[0].x;
        for (let i = 1; i < keys.length; i++) {
            const a = keys[i - 1], b = keys[i];
            if (y <= b.y) {
                if (!b.bend || b.y === a.y) return a.x;
                const t = (y - a.y) / (b.y - a.y);
                return a.x + (b.x - a.x) * (3 * t * t - 2 * t * t * t);
            }
        }
        return keys[keys.length - 1].x;
    }

    // Closed, flat-capped ribbon outline for a line's keyframes: left edge
    // top-to-bottom, flat cap, right edge back up.
    function ribbonPath(keys) {
        const L = [], Rr = [];
        const push = (x, h, y) => { L.push({ x: laneX(x) - h, y }); Rr.push({ x: laneX(x) + h, y }); };
        push(keys[0].x, keys[0].h, keys[0].y);
        for (let i = 1; i < keys.length; i++) {
            const a = keys[i - 1], k = keys[i];
            if (!k.bend) {
                if (k.y > a.y) push(a.x, a.h, k.y);
                if (k.h !== a.h) push(k.x, k.h, k.y);
                continue;
            }
            const n = LAYOUT.bendTrailSteps, dy = k.y - a.y;
            for (let s = 1; s <= n; s++) {
                const t = s / n;
                const cx = a.x + (k.x - a.x) * (3 * t * t - 2 * t * t * t);
                const cy = a.y + dy * t;
                const half = a.h + (k.h - a.h) * t + LAYOUT.bendTrailBulge * Math.sin(Math.PI * t);
                // Slope of x over y, to keep a visible thickness
                // perpendicular to the path where it runs nearly sideways.
                const slope = dy > 0 ? (k.x - a.x) * (6 * t - 6 * t * t) / dy : 0;
                const len = Math.hypot(slope, 1);
                const nx = 1 / len, ny = -slope / len;
                const extra = Math.max(0, LAYOUT.bendMinPerp - half * nx) * Math.sin(Math.PI * t);
                L.push({ x: laneX(cx) - half - nx * extra, y: cy - ny * extra });
                Rr.push({ x: laneX(cx) + half + nx * extra, y: cy + ny * extra });
            }
        }
        let d = `M ${L[0].x} ${L[0].y}`;
        for (let i = 1; i < L.length; i++) d += ` L ${L[i].x} ${L[i].y}`;
        for (let i = Rr.length - 1; i >= 0; i--) d += ` L ${Rr[i].x} ${Rr[i].y}`;
        return d + ' Z';
    }

    // Raw-ingredient name tags stack in tiers above their birth row so
    // several starting in the same row (very common at row 0) don't overlap
    // horizontally. The text nodes must already be in the live document so
    // `getComputedTextLength()` is real. Each entry carries `.parts` (an
    // ingredient has quantity then name, each independently editable)
    // laid out side by side within ONE shared highlight (`entry.pillRect`);
    // bold vs regular weight (style.css) tells quantity from name.
    const LABEL_PART_GAP = 4;
    function measureEntry(entry) {
        entry._widths = entry.parts.map(part => {
            try { return part.text.getComputedTextLength(); } catch (err) { return part.text.textContent.length * 6.5; }
        });
        entry._innerWidth = entry._widths.reduce((sum, w) => sum + w, 0) + LABEL_PART_GAP * (entry.parts.length - 1);
    }
    function placeParts(entry, centreX, y) {
        let x = centreX - entry._innerWidth / 2;
        entry.parts.forEach((part, i) => {
            part.text.setAttribute('x', x + entry._widths[i] / 2);
            part.text.setAttribute('y', y);
            x += entry._widths[i] + LABEL_PART_GAP;
        });
    }
    function layoutLineLabels(model, labelEntries) {
        const groups = new Map();
        labelEntries.forEach(entry => {
            if (!groups.has(entry.birthCol)) groups.set(entry.birthCol, []);
            groups.get(entry.birthCol).push(entry);
        });
        groups.forEach(group => {
            group.sort((a, b) => a.laneX - b.laneX);
            const tierRight = [];
            group.forEach(entry => {
                measureEntry(entry);
                // Reserve the WHOLE highlight's width, not just the text.
                const half = entry._innerWidth / 2 + LAYOUT.pillPadX + LAYOUT.labelMinGap / 2;
                let tier = tierRight.findIndex(r => r <= entry.laneX - half);
                if (tier === -1) { tier = tierRight.length; tierRight.push(entry.laneX + half); }
                else tierRight[tier] = entry.laneX + half;
                entry.tier = tier;
            });
            const baseY = rowTop(model, group[0].birthCol) - LAYOUT.labelBaseGap;
            group.forEach(entry => {
                const y = baseY - entry.tier * LAYOUT.labelLineHeight;
                placeParts(entry, entry.laneX, y);
                if (entry.leader) {
                    entry.leader.setAttribute('x1', entry.laneX);
                    entry.leader.setAttribute('y1', y + 4);
                    entry.leader.setAttribute('x2', entry.laneX);
                    entry.leader.setAttribute('y2', rowTop(model, entry.birthCol));
                }
                sizeGroupPill(entry.pillRect, entry.parts, LAYOUT.pillPadX, LAYOUT.pillPadY);
            });
        });
    }

    // Combine/split output names sit ON their own step row (centred on the
    // row), nudged sideways only as far as needed to stop neighbours on the
    // same row overlapping.
    function layoutInRowLabels(model, entries) {
        const groups = new Map();
        entries.forEach(entry => {
            if (!groups.has(entry.rowCol)) groups.set(entry.rowCol, []);
            groups.get(entry.rowCol).push(entry);
        });
        groups.forEach((group, col) => {
            group.sort((a, b) => a.laneX - b.laneX);
            const y = rowY(model, col) + 4;
            let prevRight = -Infinity;
            group.forEach(entry => {
                measureEntry(entry);
                const left = Math.max(entry.laneX - entry._innerWidth / 2, prevRight + LAYOUT.labelMinGap + LAYOUT.pillPadX);
                placeParts(entry, left + entry._innerWidth / 2, y);
                prevRight = left + entry._innerWidth + LAYOUT.pillPadX;
                sizeGroupPill(entry.pillRect, entry.parts, LAYOUT.pillPadX, LAYOUT.pillPadY);
            });
        });
    }

    // How many label tiers the raw ingredients need at row 0 (same packing
    // as layoutLineLabels), measured with throwaway text nodes so the real
    // fonts apply. Drives the ingredient section's height.
    function measureIngredientTiers(model, svg) {
        const g = svgEl('g', { visibility: 'hidden' });
        svg.appendChild(g);
        const items = (model.ingredients || []).map(ing => {
            let w = LABEL_PART_GAP;
            [['quantity', ing.quantity || 'QTY'], ['name', ing.name || 'ingredient name']].forEach(([kind, text]) => {
                const t = svgEl('text', { class: 'line-name', 'data-part': kind });
                t.textContent = text;
                g.appendChild(t);
                try { w += t.getComputedTextLength(); } catch (err) { w += text.length * 6.5; }
            });
            return { x: laneX(ing.x || 0), w };
        }).sort((a, b) => a.x - b.x);
        svg.removeChild(g);
        const tierRight = [];
        items.forEach(it => {
            const half = it.w / 2 + LAYOUT.pillPadX + LAYOUT.labelMinGap / 2;
            const tier = tierRight.findIndex(r => r <= it.x - half);
            if (tier === -1) tierRight.push(it.x + half); else tierRight[tier] = it.x + half;
        });
        return Math.max(1, tierRight.length);
    }

    // A line's name tag (highlight + quantity/name text parts). `interactive`
    // tags carry the data-* hooks interact.js binds to; the row-focus copies
    // do not, so selectors never match them.
    function makeNameTag(line, leaderParent, nameParent, interactive) {
        const pillRect = svgEl('rect', interactive ? { class: 'pill-label-bg', 'data-kind': 'line-pill', 'data-id': line.id } : { class: 'pill-label-bg' });
        pillRect.style.fill = line.color;
        let leader = null;
        if (line.kind === 'ingredient') {
            leader = svgEl('line', interactive ? { class: 'line-name-leader', 'data-kind': 'line-leader', 'data-id': line.id } : { class: 'line-name-leader' });
            leader.style.stroke = line.color;
            leaderParent.appendChild(leader);
        }
        nameParent.appendChild(pillRect);
        const parts = [];
        const addPart = (content, partKind, isPlaceholder) => {
            const attrs = { 'text-anchor': 'middle', class: isPlaceholder ? 'line-name line-name--placeholder' : 'line-name', 'data-part': partKind };
            if (line.timer > 0) attrs['data-timer-step'] = line.timerStepId;
            if (interactive) Object.assign(attrs, { 'data-kind': 'line', 'data-id': line.id, 'data-line-kind': line.kind });
            const text = svgEl('text', attrs);
            text.style.fill = readableTextColor(line.color);
            text.textContent = content;
            nameParent.appendChild(text);
            parts.push({ text });
        };
        if (line.timer > 0) {
            pillRect.setAttribute('data-timer-step', line.timerStepId);
            const tAttrs = { 'text-anchor': 'middle', class: 'line-name step-timer', 'data-part': 'timer', 'data-timer-text': line.timerStepId, 'data-timer-step': line.timerStepId };
            if (interactive) Object.assign(tAttrs, { 'data-kind': 'step-timer', 'data-id': line.timerStepId });
            const timerText = svgEl('text', tAttrs);
            timerText.style.fill = readableTextColor(line.color);
            timerText.textContent = global.VEP.model.formatDuration(line.timer);
            nameParent.appendChild(timerText);
            parts.push({ text: timerText });
        }
        if (line.kind === 'ingredient' || line.quantity) addPart(line.quantity || 'QTY', 'quantity', !line.quantity);
        addPart(line.name || 'ingredient name', 'name', !line.name);
        return { leader, pillRect, parts };
    }

    // Cook-mode focus: every row except `row` dims and the current row gets an
    // outline; labels of steps in `activeSteps` (running timers) are cloned
    // above the dim so they stay bright. `row === n` means "finished" (all
    // dimmed). Pass `row = null` to clear. Non-interactive overlay.
    function drawRowFocus(model, svg, row, activeSteps) {
        const old = svg.querySelector('g.layer-hover');
        if (old) old.remove();
        const n = model.timeSteps.length;
        if (row == null || row < 0 || row > n) return;
        const W = parseFloat(svg.getAttribute('width')), H = parseFloat(svg.getAttribute('height'));
        const g = svgEl('g', { class: 'layer-hover' });
        svg.insertBefore(g, svg.querySelector('g.layer-separators'));
        const first = Math.round(rowTop(model, 0));
        if (row >= n) {
            g.appendChild(svgEl('rect', { x: 0, y: first, width: W, height: H - first, class: 'row-dim' }));
        } else {
            const a = Math.round(rowTop(model, row)), b = Math.round(rowTop(model, row + 1));
            if (a > first) g.appendChild(svgEl('rect', { x: 0, y: first, width: W, height: a - first, class: 'row-dim' }));
            if (H > b) g.appendChild(svgEl('rect', { x: 0, y: b, width: W, height: H - b, class: 'row-dim' }));
            g.appendChild(svgEl('rect', { x: 1, y: a, width: W - 2, height: b - a, class: 'row-current' }));
        }
        if (!activeSteps || !activeSteps.size) return;
        svg.querySelectorAll('[data-timer-step]').forEach(el => {
            if (el.closest('g.layer-hover') || !activeSteps.has(el.getAttribute('data-timer-step'))) return;
            const copy = el.cloneNode(true);
            ['data-kind', 'data-id', 'data-timer-step'].forEach(a => copy.removeAttribute(a));
            copy.style.visibility = '';
            g.appendChild(copy);
        });
    }

    function renderDiagram(model, svg, opts) {
        opts = opts || {};
        // Size the ingredient section to its label tiers FIRST: every row's y
        // hangs off `topMargin`.
        LAYOUT.utensilLabelBandTop = LAYOUT.headerTopPad;
        LAYOUT.ingredientBandTop = LAYOUT.utensilLabelBandTop + LAYOUT.utensilLabelBandHeight;
        const tiers = measureIngredientTiers(model, svg);
        LAYOUT.topMargin = LAYOUT.ingredientBandTop + tiers * LAYOUT.labelLineHeight + LAYOUT.labelBaseGap + 6;
        LAYOUT.ingredientBandBottom = LAYOUT.topMargin;
        LAYOUT.utensilTop = LAYOUT.topMargin;

        const lines = buildLines(model);
        const layouts = computeLayouts(model, lines);
        const size = computeDiagramSize(model, layouts);
        const laneEndX = size.width - LAYOUT.rightMargin;

        clear(svg);
        svg.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`);
        svg.setAttribute('width', size.width);
        svg.setAttribute('height', size.height);

        const defs = svgEl('defs', {});
        const creationLayer = svgEl('g', { class: 'layer-creation' });
        const utensilLabelLayer = svgEl('g', { class: 'layer-utensil-labels' });
        const timeStepLayer = svgEl('g', { class: 'layer-timesteps' });
        const utensilLayer = svgEl('g', { class: 'layer-utensils' });
        const lineLayer = svgEl('g', { class: 'layer-lines' });
        const processLayer = svgEl('g', { class: 'layer-processes' });
        const labelLayer = svgEl('g', { class: 'layer-labels' });
        const separatorLayer = svgEl('g', { class: 'layer-separators' });
        svg.appendChild(defs);
        svg.appendChild(creationLayer);
        svg.appendChild(utensilLabelLayer);
        svg.appendChild(timeStepLayer);
        svg.appendChild(utensilLayer);
        svg.appendChild(lineLayer);
        svg.appendChild(processLayer);
        svg.appendChild(labelLayer);
        // Row separators paint over EVERYTHING else.
        svg.appendChild(separatorLayer);
        // Leader lines (dashed) always paint before every name tag, so a
        // later-drawn line's leader can never sit on top of an earlier
        // line's text even when they cross paths near the tiered labels.
        const leaderLayer = svgEl('g', { class: 'layer-leaders' });
        const nameLayer = svgEl('g', { class: 'layer-names' });
        labelLayer.appendChild(leaderLayer);
        labelLayer.appendChild(nameLayer);

        // Two header sections, each with a labelled cell on the left and a
        // click-to-create band (see js/interact.js): utensils on top, and
        // below them the ingredient section marked by top/bottom borders
        // (where ingredient name tags tier upward from row 0). Processes are
        // never created here -- click over a utensil instead.
        const bandX0 = laneX(0), bandX1 = laneEndX;
        const ingH = LAYOUT.ingredientBandBottom - LAYOUT.ingredientBandTop;
        function sectionHeader(top, height, text) {
            creationLayer.appendChild(svgEl('rect', {
                x: LAYOUT.headerX, y: top, width: LAYOUT.leftMargin - LAYOUT.headerX - 6, height,
                class: 'section-header'
            }));
            const t = svgEl('text', {
                x: LAYOUT.headerX + (LAYOUT.leftMargin - LAYOUT.headerX - 6) / 2, y: top + height / 2,
                'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'section-header-label'
            });
            t.textContent = text;
            creationLayer.appendChild(t);
        }
        sectionHeader(LAYOUT.utensilLabelBandTop, LAYOUT.utensilLabelBandHeight, 'Utensils');
        sectionHeader(LAYOUT.ingredientBandTop, ingH, 'Ingredients');
        creationLayer.appendChild(svgEl('rect', {
            x: bandX0, y: LAYOUT.utensilLabelBandTop, width: Math.max(bandX1 - bandX0, 0), height: LAYOUT.utensilLabelBandHeight,
            class: 'utensil-create-band', 'data-kind': 'utensil-create-band'
        }));
        creationLayer.appendChild(svgEl('rect', {
            x: bandX0, y: LAYOUT.ingredientBandTop, width: Math.max(bandX1 - bandX0, 0), height: Math.max(ingH, 0),
            class: 'ingredient-create-band', 'data-kind': 'ingredient-create-band'
        }));
        creationLayer.appendChild(svgEl('line', {
            x1: bandX0, y1: LAYOUT.ingredientBandTop, x2: bandX1, y2: LAYOUT.ingredientBandTop, class: 'ingredient-band-border'
        }));
        creationLayer.appendChild(svgEl('line', {
            x1: bandX0, y1: LAYOUT.ingredientBandBottom, x2: bandX1, y2: LAYOUT.ingredientBandBottom, class: 'ingredient-band-border'
        }));

        // Discrete steps render as flush TABLE ROWS -- no padding between
        // them. Every row (numbered or not) gets a cell, built from the SAME
        // integer-rounded boundaries, so adjacent cells share an exact edge;
        // with `shape-rendering:crispEdges` (CSS) that leaves no sub-pixel
        // seam in Firefox. The row separators live in their own top layer.
        const nRows = model.timeSteps.length;
        const edge = c => Math.round(rowTop(model, c));
        const gridX1 = laneEndX;
        for (let c = 0; c <= nRows + 1; c++) {
            separatorLayer.appendChild(svgEl('line', {
                x1: LAYOUT.headerX, y1: edge(c), x2: gridX1, y2: edge(c), class: 'row-separator'
            }));
        }

        // Each row's number cell takes the colour of that row's step label
        // (a line's colour, or the process's colour for a process start).
        const rowColor = ts => {
            for (const s of (ts.steps || [])) {
                let owner = null;
                if (s.type === 'label' || s.type === 'move') owner = lines.get(s.lineId);
                else if (s.type === 'add') owner = lines.get(s.addedLineId);
                else if (s.type === 'merge') owner = lines.get(s.outputLineId);
                else if (s.type === 'split') owner = lines.get(s.output.lineId);
                else if (s.type === 'process-start') owner = model.processes.find(p => p.id === s.processId);
                if (owner && owner.color) return owner.color;
            }
            return null;
        };

        // Left-gutter row numbers: one cell per row, so the column has no
        // holes even for empty rows. Draggable to reorder (see interact.js).
        model.timeSteps.forEach((ts, c) => {
            const top = edge(c), h = edge(c + 1) - top;
            const colour = rowColor(ts);
            const cell = svgEl('rect', {
                x: LAYOUT.headerX, y: top, width: LAYOUT.stepNumberWidth, height: h,
                class: 'step-number-bg', 'data-kind': 'step-number', 'data-id': ts.id
            });
            const txt = svgEl('text', {
                x: LAYOUT.headerX + LAYOUT.stepNumberWidth / 2, y: top + h / 2,
                'text-anchor': 'middle', 'dominant-baseline': 'central',
                class: 'step-number', 'data-kind': 'step-number', 'data-id': ts.id
            });
            if (colour) {
                cell.style.fill = colour;
                txt.style.fill = readableTextColor(colour);
            }
            txt.textContent = String(c + 1);
            timeStepLayer.appendChild(cell);
            timeStepLayer.appendChild(txt);
        });

        // The "+" cell sits in the row right below the last step.
        const addTop = edge(nRows), addH = edge(nRows + 1) - addTop;
        timeStepLayer.appendChild(svgEl('rect', {
            x: LAYOUT.headerX, y: addTop, width: LAYOUT.stepNumberWidth, height: addH,
            class: 'timestep-add', 'data-kind': 'add-timestep'
        }));
        const addText = svgEl('text', {
            x: LAYOUT.headerX + LAYOUT.stepNumberWidth / 2, y: addTop + addH / 2,
            'text-anchor': 'middle', 'dominant-baseline': 'central',
            class: 'timestep-add-label', 'data-kind': 'add-timestep'
        });
        addText.textContent = '+';
        timeStepLayer.appendChild(addText);

        // Utensils -- permanent kitchen fixtures: a fixed x/width within
        // their zone, spanning the full time axis (no time range of their
        // own any more). Thin edge-strips along the left/right sides let you
        // grab an edge directly to resize instead of the whole body.
        model.utensils.forEach(u => {
            const x0 = laneX(u.x), x1 = laneX(u.x + u.width);
            const y0 = LAYOUT.utensilTop, y1 = size.height - LAYOUT.bottomMargin;
            utensilLayer.appendChild(svgEl('rect', {
                x: x0, y: y0, width: Math.max(x1 - x0, 4), height: Math.max(y1 - y0, 4),
                fill: u.color || '#999999',
                class: 'utensil-rect', 'data-kind': 'utensil', 'data-id': u.id
            }));
            const ew = LAYOUT.edgeHandleSize;
            utensilLayer.appendChild(svgEl('rect', {
                x: x0, y: y0, width: ew, height: Math.max(y1 - y0, 4),
                class: 'utensil-edge', 'data-kind': 'utensil-edge', 'data-edge': 'left', 'data-id': u.id
            }));
            utensilLayer.appendChild(svgEl('rect', {
                x: x1 - ew, y: y0, width: ew, height: Math.max(y1 - y0, 4),
                class: 'utensil-edge', 'data-kind': 'utensil-edge', 'data-edge': 'right', 'data-id': u.id
            }));
            const pillRect = svgEl('rect', { class: 'pill-label-bg', 'data-kind': 'utensil-pill', 'data-id': u.id });
            pillRect.style.fill = u.color || '#999999';
            utensilLabelLayer.appendChild(pillRect);
            const label = svgEl('text', {
                x: x0 + 6, y: LAYOUT.utensilLabelBandTop + LAYOUT.utensilLabelBandHeight / 2 + 4,
                'text-anchor': 'start', class: 'utensil-label', 'data-kind': 'utensil', 'data-id': u.id
            });
            label.style.fill = readableTextColor(u.color);
            label.textContent = u.name;
            utensilLabelLayer.appendChild(label);
            sizePillLabel(pillRect, label, LAYOUT.pillPadX, LAYOUT.pillPadY);
        });

        // Processes -- an overlay matching their utensil's fixed width from
        // the top of their START row (a dedicated step row holding the
        // process's one-line label, see the step-label pass below) down to
        // the bottom of their END row. Only the bottom edge is draggable, in
        // whole-row increments; the start is moved like any other step.
        model.processes.forEach(p => {
            const u = model.utensils.find(x => x.id === p.utensilId);
            if (!u) return;
            const x0 = laneX(u.x), x1 = laneX(u.x + u.width);
            const y0 = Math.round(rowTop(model, p.startTimeStepIndex));
            const y1 = Math.round(rowTop(model, p.endTimeStepIndex + 1));
            processLayer.appendChild(svgEl('rect', {
                x: x0, y: y0, width: Math.max(x1 - x0, 4), height: Math.max(y1 - y0, 4),
                fill: p.color || '#ffcc66', 'fill-opacity': p.opacity != null ? p.opacity : 0.4,
                class: 'process-rect', 'data-kind': 'process', 'data-id': p.id
            }));
            const eh = LAYOUT.edgeHandleSize;
            processLayer.appendChild(svgEl('rect', {
                x: x0, y: y1 - eh, width: Math.max(x1 - x0, 4), height: eh,
                class: 'process-edge', 'data-kind': 'process-edge', 'data-edge': 'bottom', 'data-id': p.id
            }));
        });

        // Ingredient / merged / split lines -- rendered as a FILLED RIBBON
        // (flat caps), not a stroked centreline: "thickness" is how much of
        // the horizontal space axis a line occupies. Every event on a line
        // (move, combine, split, add) owns exactly one step row and its bend
        // runs from that row's top edge to its bottom edge -- see
        // buildLineGeometry.
        const labelEntries = [];
        const inRowEntries = [];
        const linePaths = [];
        const geoms = new Map();
        lines.forEach(line => {
            const keys = buildLineGeometry(model, line, layouts);
            geoms.set(line.id, keys);
            if (keys.length > 1) {
                const pathEl = svgEl('path', {
                    d: ribbonPath(keys),
                    fill: line.color,
                    stroke: 'none',
                    class: 'ingredient-line',
                    'data-kind': 'line',
                    'data-id': line.id
                });
                // Collected, not appended yet, so stationary lines can be
                // drawn first and lines in motion layered on top.
                const moving = line.xChanges.length > 1 || line.splitSourceId != null
                    || line.deathKind === 'merge' || line.deathKind === 'add';
                linePaths.push({ el: pathEl, moving });
            }
            // Name tag: raw ingredients sit above their birth row (tiered,
            // with a leader down to the line); combine/split outputs sit on
            // their own step row instead.
            const startEntry = layouts[line.birth][line.id];
            if (!startEntry) return;
            const tag = makeNameTag(line, leaderLayer, nameLayer, true);
            const laneXPos = laneX(startEntry.x);
            if (line.kind === 'ingredient') {
                labelEntries.push({ birthCol: line.birth, laneX: laneXPos, leader: tag.leader, parts: tag.parts, pillRect: tag.pillRect });
            } else {
                inRowEntries.push({ rowCol: line.birth, laneX: laneXPos, parts: tag.parts, pillRect: tag.pillRect });
            }
        });
        // Stationary lines first, then moving ones on top.
        linePaths.forEach(p => { if (!p.moving) lineLayer.appendChild(p.el); });
        linePaths.forEach(p => { if (p.moving) lineLayer.appendChild(p.el); });
        layoutLineLabels(model, labelEntries);
        layoutInRowLabels(model, inRowEntries);

        // Step labels (label / move / add, plus a process's one-line start
        // label) -- centred on their own row, sat on the line they belong
        // to. Combine and split get no tag of their own: their output
        // names already sit on that row. A colour-matched highlight sits
        // behind the text, same as a line's name tag.
        // `timerStep` (optional): the step carrying a timer, shown as a bold
        // field to the left of the text inside the same highlight.
        function stepLabel(textKind, pillKind, id, cx, cy, text, colour, timerStep) {
            const pillRect = svgEl('rect', { class: 'pill-label-bg', 'data-kind': pillKind, 'data-id': id });
            pillRect.style.fill = colour;
            labelLayer.appendChild(pillRect);
            const hasTimer = !!(timerStep && timerStep.timer > 0);
            let timerT = null;
            if (hasTimer) {
                pillRect.setAttribute('data-timer-step', timerStep.id);
                timerT = svgEl('text', {
                    'text-anchor': 'middle', class: 'step-label step-timer', 'data-kind': 'step-timer',
                    'data-id': timerStep.id, 'data-timer-text': timerStep.id, 'data-timer-step': timerStep.id
                });
                timerT.style.fill = readableTextColor(colour);
                timerT.textContent = global.VEP.model.formatDuration(timerStep.timer);
                labelLayer.appendChild(timerT);
            }
            const attrs = {
                x: cx, y: cy + 4, 'text-anchor': 'middle',
                class: 'step-label', 'data-kind': textKind, 'data-id': id
            };
            if (hasTimer) attrs['data-timer-step'] = timerStep.id;
            const t = svgEl('text', attrs);
            t.style.fill = readableTextColor(colour);
            t.textContent = text;
            labelLayer.appendChild(t);
            if (timerT) {
                const tw = timerT.getComputedTextLength(), mw = t.getComputedTextLength();
                const left = cx - (tw + LABEL_PART_GAP + mw) / 2;
                timerT.setAttribute('x', left + tw / 2);
                timerT.setAttribute('y', cy + 4);
                t.setAttribute('x', left + tw + LABEL_PART_GAP + mw / 2);
                sizeGroupPill(pillRect, [{ text: timerT }, { text: t }], LAYOUT.pillPadX, LAYOUT.pillPadY);
            } else {
                sizePillLabel(pillRect, t, LAYOUT.pillPadX, LAYOUT.pillPadY);
            }
        }
        model.timeSteps.forEach((ts, c) => {
            const yC = rowY(model, c);
            (ts.steps || []).forEach(step => {
                if (step.type === 'add') {
                    const added = lines.get(step.addedLineId);
                    const base = lines.get(step.baseLineId);
                    if (!added || !base) return;
                    const keys = geoms.get(base.id);
                    if (!keys || !keys.length) return;
                    // `add-step` on both pill and text so one binding can
                    // pick them up for a vertical reposition drag / select.
                    stepLabel('add-step', 'add-step', step.id, laneX(lineXAtY(keys, yC)), yC, 'add', added.color, step);
                } else if (step.type === 'process-start') {
                    const p = model.processes.find(x => x.id === step.processId);
                    const u = p && model.utensils.find(x => x.id === p.utensilId);
                    if (!p || !u) return;
                    stepLabel('process-label', 'process-label-pill', p.id, laneX(u.x + u.width / 2), yC, p.label || 'process', p.color || '#ffcc66', step);
                } else if (step.type === 'label' || step.type === 'move') {
                    const line = lines.get(step.lineId);
                    const keys = line && geoms.get(line.id);
                    if (!keys || !keys.length) return;
                    stepLabel('step', 'step-pill', step.id, laneX(lineXAtY(keys, yC)), yC,
                        step.type === 'move' ? (step.text || 'Move') : (step.text || ''), line.color, step);
                }
            });
        });

        return { lines, layouts, size, geoms };
    }

    global.VEP = global.VEP || {};
    global.VEP.renderer = {
        LAYOUT, buildLines, getXAt, computeLayouts, buildLineGeometry, lineXAtY, drawRowFocus, rowY, rowTop, rowH, laneX, computeDiagramSize,
        readableTextColor, renderDiagram
    };
})(window);
