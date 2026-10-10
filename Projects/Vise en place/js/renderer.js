// SVG diagram renderer: turns a recipe document into positioned lines,
// utensil/process rectangles and step labels. The TIME axis runs vertically
// (top to bottom, `topMargin`/`bottomMargin`); the LANE axis is a literal 1-D
// map of a simplified kitchen counter (left to right, `leftMargin`/
// `rightMargin`) -- zones are fixed background bands, utensils are permanent
// fixtures placed within a zone, and ingredients have a real `x` position on
// that same line rather than an abstract lane index.
(function (global) {
    'use strict';

    const SVG_NS = 'http://www.w3.org/2000/svg';

    const LAYOUT = {
        columnWidth: 190,
        leftMargin: 50,
        rightMargin: 24,
        topMargin: 100,
        bottomMargin: 20,
        // A vertical gutter along the left edge holds the draggable/
        // renameable time-step handles + guide lines (horizontal, spanning
        // the lane axis, since time itself runs downward).
        headerX: 6,
        headerWidth: 22,
        // Space at the very top reserved for zone name labels; utensil
        // fixtures (permanent, full-height) start just below this.
        zoneHeaderHeight: 18,
        utensilTop: 26,
        stepHandleRadius: 11,
        // A process rect exactly matches its utensil's fixed width -- no
        // poke/padding needed since the utensil is no longer sized from its
        // contained lines.
        // Ingredient/merge name tags stack in tiers above their birth row so
        // several starting in the same row (very common at row 0) don't
        // overlap each other horizontally -- see layoutLineLabels().
        labelLineHeight: 14,
        labelBaseGap: 10,
        labelMinGap: 8,
        // Thin grab-strips along a utensil's left/right edges or a
        // process's top/bottom edges, for resizing by dragging the edge
        // itself rather than a separate handle floating off to the side.
        edgeHandleSize: 8,
        // A "move" always bends over this same fixed span of time, however
        // far apart its surrounding columns happen to be -- the rest of
        // that gap on either side stays flat, so moves read as a consistent
        // "this is how long a move takes" rather than stretching/squashing
        // to whatever the neighbouring columns' spacing happens to be. A
        // merge convergence uses this exact same fixed height too (see the
        // line-path loop below) -- both are just "a bend", differing only
        // in what triggers one.
        moveHeight: 28
    };

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


        model.ingredients.forEach(ing => {
            lines.set(ing.id, {
                id: ing.id,
                name: ing.name,
                quantity: ing.quantity,
                color: ing.color,
                thickness: ing.thickness,
                birth: ing.startTimeStepIndex || 0,
                death: lastCol,
                endsInMerge: false,
                xChanges: [{ col: ing.startTimeStepIndex || 0, x: ing.x || 0 }],
                thicknessChanges: [{ col: ing.startTimeStepIndex || 0, thickness: ing.thickness }],
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
                        if (l) { l.death = c; l.endsInMerge = true; }
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
                        xChanges: [{ col: c, x: step.outputX || 0 }],
                        thicknessChanges: [{ col: c, thickness: step.outputThickness || 10 }],
                        kind: 'merge'
                    });
                } else if (step.type === 'add') {
                    // Keeps the base line's own identity going forward --
                    // no new line is born, the absorbed line just dies here
                    // and the base's own thickness steps up from this
                    // column on (see `getThicknessAt`).
                    const added = lines.get(step.addedLineId);
                    if (added) { added.death = c; added.endsInMerge = true; }
                    const base = lines.get(step.baseLineId);
                    if (base) {
                        const newThickness = step.newThickness || base.thickness;
                        base.thicknessChanges.push({ col: c, thickness: newThickness });
                        base.thickness = newThickness;
                    }
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
    // redirected to their output's x only at the exact merge column, so
    // multiple lines visually converge to one point.
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
                    if (outEntry) {
                        step.inputLineIds.forEach(inId => {
                            if (layout[inId]) layout[inId] = { x: outEntry.x, thickness: layout[inId].thickness };
                        });
                    }
                } else if (step.type === 'add') {
                    // The absorbed line visually converges into the base
                    // line's own position at this exact column, same idea
                    // as a merge input converging into its output.
                    const baseEntry = layout[step.baseLineId];
                    if (baseEntry && layout[step.addedLineId]) {
                        layout[step.addedLineId] = { x: baseEntry.x, thickness: layout[step.addedLineId].thickness };
                    }
                }
            });
            layouts.push(layout);
        }
        return layouts;
    }

    // A column's y is whatever it was dragged to (see js/interact.js) --
    // columns/rows are NOT forced to equal spacing.
    function rowY(model, c) {
        const ts = model.timeSteps[c];
        return LAYOUT.topMargin + (ts ? ts.x : 0);
    }

    function computeDiagramSize(model, layouts) {
        let maxOffset = 0;
        layouts.forEach(layout => {
            Object.values(layout).forEach(entry => {
                maxOffset = Math.max(maxOffset, entry.x + entry.thickness / 2);
            });
        });
        (model.zones || []).forEach(z => { maxOffset = Math.max(maxOffset, z.x + z.width); });
        (model.utensils || []).forEach(u => { maxOffset = Math.max(maxOffset, u.x + u.width); });
        const height = rowY(model, model.timeSteps.length - 1) + LAYOUT.bottomMargin;
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

    // Fits a colour-matched pill background rect to a text node's actual
    // rendered box (fully rounded ends, true "badge" look) -- the text must
    // already be attached to the live, visible SVG for `getBBox()` to
    // return real measurements, so callers append both first and call this
    // once the text's final position is settled.
    function sizePillLabel(rect, textEl, padX, padY) {
        let bbox;
        try { bbox = textEl.getBBox(); } catch (err) { return; }
        if (!bbox || (!bbox.width && !bbox.height)) return;
        const height = bbox.height + padY * 2;
        rect.setAttribute('x', bbox.x - padX);
        rect.setAttribute('y', bbox.y - padY);
        rect.setAttribute('width', bbox.width + padX * 2);
        rect.setAttribute('height', height);
        rect.setAttribute('rx', height / 2);
        rect.setAttribute('ry', height / 2);
    }

    // Ingredient/merge name tags stack in tiers above their birth row so
    // several starting in the same row (very common at row 0) don't
    // overlap each other horizontally. Requires the text nodes to already be
    // in the (live) document so `getComputedTextLength()` reflects the real
    // rendered width -- callers append with a placeholder position first.
    function layoutLineLabels(model, labelEntries) {
        const groups = new Map();
        labelEntries.forEach(entry => {
            const key = entry.birthCol;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(entry);
        });
        groups.forEach(group => {
            group.sort((a, b) => a.laneX - b.laneX);
            const tierRight = [];
            group.forEach(entry => {
                let width;
                try { width = entry.text.getComputedTextLength(); } catch (err) { width = entry.text.textContent.length * 6.5; }
                const half = width / 2 + LAYOUT.labelMinGap / 2;
                let tier = tierRight.findIndex(r => r <= entry.laneX - half);
                if (tier === -1) { tier = tierRight.length; tierRight.push(entry.laneX + half); }
                else tierRight[tier] = entry.laneX + half;
                entry.tier = tier;
            });
            const rowTop = rowY(model, group[0].birthCol) - LAYOUT.labelBaseGap;
            group.forEach(entry => {
                const y = rowTop - entry.tier * LAYOUT.labelLineHeight;
                entry.text.setAttribute('y', y);
                if (entry.leader) {
                    entry.leader.setAttribute('x1', entry.laneX);
                    entry.leader.setAttribute('y1', y + 4);
                    entry.leader.setAttribute('x2', entry.laneX);
                    entry.leader.setAttribute('y2', rowY(model, group[0].birthCol));
                }
                if (entry.pillRect) sizePillLabel(entry.pillRect, entry.text, 7, 3);
            });
        });
    }

    function renderDiagram(model, svg, opts) {
        opts = opts || {};
        const lines = buildLines(model);
        const layouts = computeLayouts(model, lines);
        const size = computeDiagramSize(model, layouts);

        clear(svg);
        svg.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`);
        svg.setAttribute('width', size.width);
        svg.setAttribute('height', size.height);

        const defs = svgEl('defs', {});
        const zoneLayer = svgEl('g', { class: 'layer-zones' });
        const timeStepLayer = svgEl('g', { class: 'layer-timesteps' });
        const utensilLayer = svgEl('g', { class: 'layer-utensils' });
        const lineLayer = svgEl('g', { class: 'layer-lines' });
        const processLayer = svgEl('g', { class: 'layer-processes' });
        const labelLayer = svgEl('g', { class: 'layer-labels' });
        svg.appendChild(defs);
        svg.appendChild(zoneLayer);
        svg.appendChild(timeStepLayer);
        svg.appendChild(utensilLayer);
        svg.appendChild(lineLayer);
        svg.appendChild(processLayer);
        svg.appendChild(labelLayer);
        // Leader lines (dashed) always paint before every name tag, so a
        // later-drawn line's leader can never sit on top of an earlier
        // line's text even when they cross paths near the tiered labels.
        const leaderLayer = svgEl('g', { class: 'layer-leaders' });
        const nameLayer = svgEl('g', { class: 'layer-names' });
        labelLayer.appendChild(leaderLayer);
        labelLayer.appendChild(nameLayer);

        // Zones -- fixed background bands spanning the full height, a
        // literal 1-D map of the kitchen that utensils/ingredients sit on.
        (model.zones || []).forEach(z => {
            const x0 = laneX(z.x), x1 = laneX(z.x + z.width);
            zoneLayer.appendChild(svgEl('rect', {
                x: x0, y: 0, width: x1 - x0, height: size.height,
                class: 'zone-band', 'data-kind': 'zone', 'data-id': z.id
            }));
            zoneLayer.appendChild(svgEl('line', {
                x1: x0, y1: 0, x2: x0, y2: size.height, class: 'zone-divider'
            }));
            const label = svgEl('text', {
                x: x0 + 6, y: 13, class: 'zone-label', 'data-kind': 'zone', 'data-id': z.id
            });
            label.textContent = z.name;
            zoneLayer.appendChild(label);
        });

        // Repositioning a row is now done by dragging one of its own step
        // labels directly (see js/interact.js) rather than a separate
        // handle in the left gutter.
        const addY = rowY(model, model.timeSteps.length - 1) + LAYOUT.columnWidth / 2;
        const addHandle = svgEl('rect', {
            x: LAYOUT.headerX, y: addY - 16, width: LAYOUT.headerWidth, height: 32, rx: 5,
            class: 'timestep-add', 'data-kind': 'add-timestep'
        });
        const addText = svgEl('text', {
            x: LAYOUT.headerX + LAYOUT.headerWidth / 2, y: addY + 4, 'text-anchor': 'middle',
            class: 'timestep-add-label', 'data-kind': 'add-timestep'
        });
        addText.textContent = '+';
        timeStepLayer.appendChild(addHandle);
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
                rx: 6, fill: u.color || '#999999',
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
            const label = svgEl('text', {
                x: x0 + 6, y: y0 + 14, class: 'utensil-label', 'data-kind': 'utensil', 'data-id': u.id
            });
            label.textContent = u.name;
            utensilLayer.appendChild(label);
        });

        // Processes -- an overlay matching their utensil's fixed width, just
        // for the process's own time range. Thin edge-strips along the
        // top/bottom let you grab an edge directly to change just the start
        // or end, same pattern as a utensil's left/right edges.
        model.processes.forEach(p => {
            const u = model.utensils.find(x => x.id === p.utensilId);
            if (!u) return;
            const x0 = laneX(u.x), x1 = laneX(u.x + u.width);
            const y0 = rowY(model, p.startTimeStepIndex), y1 = rowY(model, p.endTimeStepIndex);
            processLayer.appendChild(svgEl('rect', {
                x: x0, y: y0, width: Math.max(x1 - x0, 4), height: Math.max(y1 - y0, 4),
                rx: 4, fill: p.color || '#ffcc66', 'fill-opacity': p.opacity != null ? p.opacity : 0.4,
                class: 'process-rect', 'data-kind': 'process', 'data-id': p.id
            }));
            const eh = LAYOUT.edgeHandleSize;
            processLayer.appendChild(svgEl('rect', {
                x: x0, y: y0, width: Math.max(x1 - x0, 4), height: eh,
                class: 'process-edge', 'data-kind': 'process-edge', 'data-edge': 'top', 'data-id': p.id
            }));
            processLayer.appendChild(svgEl('rect', {
                x: x0, y: y1 - eh, width: Math.max(x1 - x0, 4), height: eh,
                class: 'process-edge', 'data-kind': 'process-edge', 'data-edge': 'bottom', 'data-id': p.id
            }));
            const label = svgEl('text', {
                x: x0 + 6, y: y0 + 14, class: 'process-label', 'text-anchor': 'start',
                'data-kind': 'process-label', 'data-id': p.id
            });
            label.textContent = p.label || '';
            processLayer.appendChild(label);
            // Always render a sublabel node (even if empty, as a faint
            // placeholder) so there's always something to double-click to
            // add one, not just to edit an existing one.
            const sub = svgEl('text', {
                x: x0 + 6, y: y0 + 27, class: p.sublabel ? 'process-sublabel' : 'process-sublabel process-sublabel-empty',
                'text-anchor': 'start', 'data-kind': 'process-sublabel', 'data-id': p.id
            });
            sub.textContent = p.sublabel || '+ sublabel';
            processLayer.appendChild(sub);
        });

        // Ingredient / merged lines -- rendered as a FILLED RIBBON (flat
        // top/bottom caps, not rounded), not a stroked centreline: this is
        // a literal spacetime diagram of a 1-D space, so "thickness" means
        // how much of the horizontal SPACE axis a line occupies, not a
        // stroke width perpendicular to wherever its path happens to be
        // pointing (which would visually distort as a line bends through a
        // move). The ribbon's left/right edges are each built from the
        // exact same bend/stop logic as a plain centreline would be, just
        // offset by +/- half the line's own thickness at each point -- so
        // the VERTICAL span of any bend (move, merge, or an `add`
        // widening) is always the same fixed height for every line
        // regardless of how thick it is; only the horizontal offset
        // differs.
        const labelEntries = [];
        lines.forEach(line => {
            // Walk this line's OWN real stops: its birth, each of its own
            // move columns, every point its OWN thickness changes (an
            // `add`), then wherever it dies -- NOT every row in the shared
            // global timeline (see buildLines/getThicknessAt). A move, a
            // merge convergence, and an `add` widening all get the same
            // fixed-height bend treatment (`bend: true`); only a line
            // simply running out of recipe with nothing happening to it is
            // a plain straight stop.
            const stopMap = new Map();
            stopMap.set(line.birth, false);
            line.xChanges.forEach(ch => { if (ch.col > line.birth) stopMap.set(ch.col, true); });
            line.thicknessChanges.forEach(ch => { if (ch.col > line.birth) stopMap.set(ch.col, true); });
            const endsInMerge = !!line.endsInMerge;
            if (!stopMap.has(line.death)) stopMap.set(line.death, endsInMerge);
            else if (endsInMerge) stopMap.set(line.death, true);
            const stops = Array.from(stopMap.entries()).sort((a, b) => a[0] - b[0]).map(([col, bend]) => ({ col, bend }));

            // Each edge point is `{x,y}` plus (except the very first) how
            // it connects to the PREVIOUS point -- a plain `L`, or a `C`
            // carrying its own two control points -- built once per side
            // so the right edge can be re-walked backwards (reversing each
            // curve's own control points) when stitching the two into one
            // closed ribbon outline below.
            const leftPts = [], rightPts = [];
            for (let i = 0; i < stops.length - 1; i++) {
                const c0 = stops[i].col, c1 = stops[i + 1].col;
                const from = layouts[c0] && layouts[c0][line.id];
                const to = layouts[c1] && layouts[c1][line.id];
                if (!from || !to) continue;
                const x0 = laneX(from.x), x1 = laneX(to.x);
                const y0 = rowY(model, c0), y1 = rowY(model, c1);
                const half0 = from.thickness / 2, half1 = to.thickness / 2;
                if (!leftPts.length) {
                    leftPts.push({ x: x0 - half0, y: y0 });
                    rightPts.push({ x: x0 + half0, y: y0 });
                }
                // A move/merge/add always bends over the exact same fixed
                // span ending at its own row, full stop -- never clamped
                // against y0, so it never depends on where any other step
                // (or even this line's own previous point) happens to sit.
                // If the actual gap is smaller than that span, the control
                // point just lands outside [y0,y1]: still a single valid
                // segment starting at y0 (there's nowhere else for it to
                // start), but shaped as if the bend had its full height.
                const isBend = stops[i + 1].bend && (x0 !== x1 || half0 !== half1);
                if (isBend) {
                    const bendY0 = y1 - LAYOUT.moveHeight;
                    if (bendY0 > y0) {
                        leftPts.push({ x: x0 - half0, y: bendY0 });
                        rightPts.push({ x: x0 + half0, y: bendY0 });
                    }
                    const my = (bendY0 + y1) / 2;
                    leftPts.push({ x: x1 - half1, y: y1, cp1: { x: x0 - half0, y: my }, cp2: { x: x1 - half1, y: my } });
                    rightPts.push({ x: x1 + half1, y: y1, cp1: { x: x0 + half0, y: my }, cp2: { x: x1 + half1, y: my } });
                } else {
                    const my = (y0 + y1) / 2;
                    leftPts.push({ x: x1 - half1, y: y1, cp1: { x: x0 - half0, y: my }, cp2: { x: x1 - half1, y: my } });
                    rightPts.push({ x: x1 + half1, y: y1, cp1: { x: x0 + half0, y: my }, cp2: { x: x1 + half1, y: my } });
                }
            }

            if (leftPts.length > 1) {
                let d = `M ${leftPts[0].x} ${leftPts[0].y}`;
                for (let i = 1; i < leftPts.length; i++) {
                    const p = leftPts[i];
                    d += p.cp1 ? ` C ${p.cp1.x} ${p.cp1.y}, ${p.cp2.x} ${p.cp2.y}, ${p.x} ${p.y}` : ` L ${p.x} ${p.y}`;
                }
                // Flat bottom cap across to the right edge, then walk the
                // right edge back UP to the top (reversing each curve's
                // own control points) and a flat top cap back to the
                // start -- one closed, flat-capped ribbon outline, filled
                // solid instead of stroked.
                const rightLast = rightPts[rightPts.length - 1];
                d += ` L ${rightLast.x} ${rightLast.y}`;
                for (let i = rightPts.length - 1; i > 0; i--) {
                    const p = rightPts[i], prev = rightPts[i - 1];
                    d += p.cp1 ? ` C ${p.cp2.x} ${p.cp2.y}, ${p.cp1.x} ${p.cp1.y}, ${prev.x} ${prev.y}` : ` L ${prev.x} ${prev.y}`;
                }
                d += ` L ${leftPts[0].x} ${leftPts[0].y} Z`;
                lineLayer.appendChild(svgEl('path', {
                    d,
                    fill: line.color,
                    stroke: 'none',
                    class: 'ingredient-line',
                    'data-kind': 'line',
                    'data-id': line.id
                }));
            }
            // name/quantity tag above the line's birth row (tiered afterwards
            // via layoutLineLabels to avoid colliding with neighbours that
            // share the same birth row), with a thin leader line back down
            // to the line's actual starting point. A colour-matched pill
            // background sits behind the (plain white) text instead of
            // colouring the text itself -- `sizePillLabel` fits it to the
            // text's real rendered box once layoutLineLabels below has
            // settled its final tiered position.
            const startEntry = layouts[line.birth][line.id];
            if (startEntry) {
                const laneXPos = laneX(startEntry.x);
                const leader = svgEl('line', { class: 'line-name-leader', 'data-kind': 'line-leader', 'data-id': line.id });
                leader.style.stroke = line.color;
                leaderLayer.appendChild(leader);
                const pillRect = svgEl('rect', { class: 'pill-label-bg', 'data-kind': 'line-pill', 'data-id': line.id });
                pillRect.style.fill = line.color;
                nameLayer.appendChild(pillRect);
                const text = svgEl('text', {
                    x: laneXPos,
                    y: rowY(model, line.birth) - LAYOUT.labelBaseGap,
                    'text-anchor': 'middle',
                    class: 'line-name',
                    'data-kind': 'line',
                    'data-id': line.id,
                    'data-line-kind': line.kind
                });
                text.textContent = line.quantity ? `${line.name} (${line.quantity})` : line.name;
                nameLayer.appendChild(text);
                labelEntries.push({ birthCol: line.birth, laneX: laneXPos, text, leader, pillRect });
            }
        });
        layoutLineLabels(model, labelEntries);

        // "+ Add Ingredient" ghost label pinned near the top of the header
        // gutter (not tied to row 0, since tiered ingredient labels can
        // stack up well above row 0's own y and would otherwise collide).
        const addIngredientText = svgEl('text', {
            x: LAYOUT.headerX + LAYOUT.headerWidth + 6, y: LAYOUT.zoneHeaderHeight + 14, 'text-anchor': 'start',
            class: 'add-ingredient-label', 'data-kind': 'add-ingredient'
        });
        addIngredientText.textContent = '+ Add Ingredient';
        labelLayer.appendChild(addIngredientText);

        // Step labels (label/move actions) -- sit directly on the line,
        // offset to the side so they don't overlap the line itself. A
        // column can hold several (one per unrelated line sharing that
        // moment), each keyed by its own step id rather than the column's.
        // A colour-matched pill sits behind the (plain white) text, same
        // treatment as a line's own name tag, instead of colouring the
        // text itself.
        model.timeSteps.forEach((ts, c) => {
            (ts.steps || []).forEach(step => {
                if (step.type !== 'label' && step.type !== 'move') return;
                const line = lines.get(step.lineId);
                if (!line) return;
                const layout = layouts[c];
                const entry = layout && layout[step.lineId];
                if (!entry) return;
                const pillRect = svgEl('rect', { class: 'pill-label-bg', 'data-kind': 'step-pill', 'data-id': step.id });
                pillRect.style.fill = line.color;
                labelLayer.appendChild(pillRect);
                const text = svgEl('text', {
                    x: laneX(entry.x),
                    y: rowY(model, c) + 4,
                    'text-anchor': 'middle',
                    class: 'step-label',
                    'data-kind': 'step',
                    'data-id': step.id
                });
                text.textContent = step.type === 'move' ? (step.text || 'Move') : (step.text || '');
                labelLayer.appendChild(text);
                sizePillLabel(pillRect, text, 6, 3);
            });
        });

        return { lines, layouts, size };
    }

    global.VEP = global.VEP || {};
    global.VEP.renderer = {
        LAYOUT, buildLines, getXAt, computeLayouts, rowY, laneX, computeDiagramSize,
        renderDiagram
    };
})(window);

