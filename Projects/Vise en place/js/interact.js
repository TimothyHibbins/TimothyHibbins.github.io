// In-context canvas editing: drag-to-reorder ingredients, drag-to-reorder/
// rename time steps, drag-to-move/resize/rename utensils (incl. drawing new
// ones on empty canvas), all directly on the SVG instead of a sidebar form.
(function (global) {
    'use strict';

    let popoverEl = null;
    let outsideClickHandler = null;
    // Currently-selected item (click to select, click again/elsewhere to
    // deselect) -- persists across re-renders so selecting something then
    // editing it (which triggers a refresh) doesn't lose the selection.
    // `{ kind: 'ingredient'|'merge'|'utensil'|'process', id }` or null.
    let selected = null;
    // Id of whichever line is actively being repositioned sideways (lane
    // axis) right now, if any -- also persists across re-renders (a drag
    // spans many of them) so the freshly-rebuilt DOM can move that one
    // line's path to the end of its layer each time, keeping it drawn on
    // top of every other line while it's moving.
    let draggingLineId = null;

    function closePopover() {
        if (popoverEl) { popoverEl.remove(); popoverEl = null; }
        if (outsideClickHandler) { document.removeEventListener('mousedown', outsideClickHandler); outsideClickHandler = null; }
    }

    // Generic "no popup" inline text editor -- an input appears directly ON
    // TOP of the label being edited (same anchor/position/font as the SVG
    // text, not the click point), pre-filled and auto-selected; Enter or
    // clicking away commits, Escape cancels without saving. An optional
    // small "x" button deletes the underlying thing instead (replaces the
    // old popovers that were only ever a text field + a Delete button).
    function editTextInPlace(clientX, clientY, currentValue, onCommit, onDelete, opts) {
        opts = opts || {};
        closePopover();
        const wrap = document.createElement('div');
        wrap.className = 'inline-edit-wrap';
        wrap.style.left = `${clientX}px`;
        wrap.style.top = `${clientY}px`;
        wrap.style.transform = opts.anchor === 'end' ? 'translate(-100%, -50%)'
            : opts.anchor === 'middle' ? 'translate(-50%, -50%)' : 'translate(0, -50%)';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'inline-edit-input';
        input.value = currentValue;
        if (opts.fontSize) input.style.fontSize = opts.fontSize;
        if (opts.fontStyle) input.style.fontStyle = opts.fontStyle;
        if (opts.fontWeight) input.style.fontWeight = opts.fontWeight;
        const resize = () => { input.style.width = `${Math.max(input.value.length, 3)}ch`; };
        resize();
        input.addEventListener('input', resize);
        wrap.appendChild(input);
        if (onDelete) {
            const delBtn = document.createElement('button');
            delBtn.className = 'inline-edit-delete';
            delBtn.textContent = '\u00d7';
            delBtn.title = 'Delete';
            delBtn.addEventListener('mousedown', e => e.preventDefault());
            delBtn.addEventListener('click', e => { e.stopPropagation(); cleanup(); recordHistory(); onDelete(); });
            wrap.appendChild(delBtn);
        }
        document.body.appendChild(wrap);
        input.focus();
        input.select();
        function commit() {
            cleanup();
            recordHistory();
            onCommit(input.value);
        }
        function cleanup() {
            document.removeEventListener('mousedown', outsideHandler);
            wrap.remove();
        }
        function onKey(e) {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { e.preventDefault(); cleanup(); }
        }
        const outsideHandler = e => { if (!wrap.contains(e.target)) commit(); };
        input.addEventListener('keydown', onKey);
        input.addEventListener('mousedown', e => e.stopPropagation());
        setTimeout(() => document.addEventListener('mousedown', outsideHandler), 0);
    }

    function toSvgPoint(svg, clientX, clientY) {
        const ctm = svg.getScreenCTM();
        if (!ctm) return { x: clientX, y: clientY };
        const pt = svg.createSVGPoint();
        pt.x = clientX; pt.y = clientY;
        const p = pt.matrixTransform(ctm.inverse());
        return { x: p.x, y: p.y };
    }

    function svgToClient(svg, x, y) {
        const ctm = svg.getScreenCTM();
        if (!ctm) return { x, y };
        const pt = svg.createSVGPoint();
        pt.x = x; pt.y = y;
        const p = pt.matrixTransform(ctm);
        return { x: p.x, y: p.y };
    }

    function mkEl(tag, props, children) {
        const node = document.createElement(tag);
        if (props) Object.keys(props).forEach(k => {
            if (k === 'text') node.textContent = props[k];
            else if (k.startsWith('on')) node.addEventListener(k.slice(2), props[k]);
            else node.setAttribute(k, props[k]);
        });
        (children || []).forEach(c => c && node.appendChild(c));
        return node;
    }

    // ---------- floating "+ X" hover buttons (one persistent element per
    // role, reused across renders). Instead of a timer-based hide delay, the
    // caller tells us (via `registerHoverOrigin`) where the cursor actually
    // is while it's still over the source element -- a single document-wide
    // mousemove then keeps the button visible as long as the cursor stays
    // inside the rectangle spanning that origin point and the button itself
    // (i.e. you're actually dragging through the gap toward it), and hides
    // it the instant the cursor leaves that path. No lingering delay either
    // way, and the origin is independent of wherever the button itself is
    // drawn (which may be pinned to a fixed label position). ----------
    const hoverButtons = new Map();
    const hoverOrigins = new Map();

    function registerHoverOrigin(key, x, y) {
        hoverOrigins.set(key, { x, y });
    }

    function getHoverButton(key) {
        if (hoverButtons.has(key)) return hoverButtons.get(key);
        let btn;
        if (key === 'color') { btn = document.createElement('div'); btn.className = 'color-swatch'; }
        else if (key === 'thick') { btn = document.createElement('div'); btn.className = 'thickness-adjuster'; btn.textContent = '\u2195'; }
        else {
            btn = document.createElement('button');
            btn.className = 'hover-action-btn';
            if (key === 'cut') btn.classList.add('cut-btn');
            if (key === 'delete') btn.classList.add('delete-btn');
        }
        btn.style.display = 'none';
        document.body.appendChild(btn);
        hoverButtons.set(key, btn);
        return btn;
    }
    function showHoverButton(key, clientX, clientY, label, onClick) {
        const btn = getHoverButton(key);
        btn.textContent = label;
        btn.style.left = `${clientX}px`;
        btn.style.top = `${clientY}px`;
        btn.style.display = 'block';
        btn.onclick = e => { e.stopPropagation(); onClick(); };
    }
    // A persistent (not hover-corridor-tracked) delete button for the
    // currently-selected item -- shown/hidden purely by selection state.
    function showDeleteButton(clientX, clientY, onClick) {
        showHoverButton('delete', clientX, clientY, '\u00d7', onClick);
    }
    // A small color dot shown just to the left of a label -- clicking it
    // opens the OS native color picker (via a single shared, invisible
    // <input type=color>) instead of any custom popup. `onOpen` fires once
    // right as the picker opens (the natural point to record undo history --
    // the picker's own `input` events fire continuously while dragging its
    // sliders, so recording per-change there would flood the undo stack).
    function showColorSwatch(clientX, clientY, color, onChange, onOpen) {
        const el = getHoverButton('color');
        el.style.left = `${clientX}px`;
        el.style.top = `${clientY}px`;
        el.style.background = color || '#888';
        el.style.display = 'block';
        el.onclick = e => {
            e.stopPropagation();
            if (onOpen) onOpen();
            const input = getColorInputEl();
            input.value = toHexColor(color);
            input.oninput = e2 => onChange(e2.target.value);
            input.click();
        };
    }
    // A small vertical scrubber shown just to the left of a label -- the
    // caller supplies the mousedown handler (same pattern as the merge
    // handle) since actually adjusting the value needs the drag state
    // machine, which is scoped per-bindAll.
    function showThicknessAdjuster(clientX, clientY, onMouseDown) {
        const el = getHoverButton('thick');
        el.style.left = `${clientX}px`;
        el.style.top = `${clientY}px`;
        el.style.display = 'block';
        el.onmousedown = onMouseDown;
    }
    function hideHoverButton(key) {
        if (hoverButtons.has(key)) hoverButtons.get(key).style.display = 'none';
        hoverOrigins.delete(key);
    }
    function hideAllHoverButtons() {
        hoverButtons.forEach((btn, key) => hideHoverButton(key));
    }
    document.addEventListener('mousemove', e => {
        hoverOrigins.forEach((origin, key) => {
            const btn = hoverButtons.get(key);
            if (!btn || btn.style.display === 'none') { hoverOrigins.delete(key); return; }
            const r = btn.getBoundingClientRect();
            const margin = 14;
            const left = Math.min(origin.x, r.left) - margin;
            const right = Math.max(origin.x, r.right) + margin;
            const top = Math.min(origin.y, r.top) - margin;
            const bottom = Math.max(origin.y, r.bottom) + margin;
            if (e.clientX < left || e.clientX > right || e.clientY < top || e.clientY > bottom) hideHoverButton(key);
        });
    });

    // Single shared hidden native color input -- clicking a color swatch
    // just re-points this at the swatch's target and calls .click() to pop
    // open the browser/OS's own color picker.
    let colorInputEl = null;
    function getColorInputEl() {
        if (!colorInputEl) {
            colorInputEl = document.createElement('input');
            colorInputEl.type = 'color';
            colorInputEl.style.position = 'fixed';
            colorInputEl.style.opacity = '0';
            colorInputEl.style.pointerEvents = 'none';
            colorInputEl.style.width = '0';
            colorInputEl.style.height = '0';
            document.body.appendChild(colorInputEl);
        }
        return colorInputEl;
    }
    function toHexColor(color) {
        return /^#[0-9a-fA-F]{6}$/.test(color || '') ? color : '#888888';
    }

    // Records one undo step from the current model state -- a thin wrapper
    // so every mutation call site can just call this instead of reaching
    // into window.VEP.history directly (and so it's a no-op if history.js
    // somehow hasn't loaded yet). Called once per LOGICAL action (a whole
    // drag, a whole text edit, a whole color-picker session), not per
    // intermediate change, so one undo always undoes one whole gesture.
    function recordHistory() {
        if (global.VEP && global.VEP.history) global.VEP.history.record();
    }

    // ---------- floating drag ghost -- follows the cursor while dragging an
    // ingredient/merge line so it can be dropped far away onto a utensil ----------
    let dragGhostEl = null;
    function showDragGhost(text, color, clientX, clientY) {
        if (!dragGhostEl) {
            dragGhostEl = document.createElement('div');
            dragGhostEl.className = 'drag-ghost';
            document.body.appendChild(dragGhostEl);
        }
        dragGhostEl.textContent = text;
        dragGhostEl.style.borderColor = color || '#888';
        dragGhostEl.style.left = `${clientX}px`;
        dragGhostEl.style.top = `${clientY}px`;
        dragGhostEl.style.display = 'block';
    }
    function moveDragGhost(clientX, clientY) {
        if (!dragGhostEl) return;
        dragGhostEl.style.left = `${clientX}px`;
        dragGhostEl.style.top = `${clientY}px`;
    }
    function hideDragGhost() {
        if (dragGhostEl) dragGhostEl.style.display = 'none';
    }

    function bindAll(svg, model, refresh) {
        const R = global.VEP.renderer;
        const M = global.VEP.model;
        const lines = R.buildLines(model);
        const layouts = R.computeLayouts(model, lines);
        let drag = null;
        hideAllHoverButtons(); // the SVG was just rebuilt -- any hover target is gone

        // If a line is mid-move, the SVG was just rebuilt from scratch, so
        // re-apply its "render on top" treatment: move its path to the end
        // of its layer, which is the last-drawn (and thus topmost) element.
        if (draggingLineId) {
            const activeLineNode = svg.querySelector(`path[data-kind="line"][data-id="${CSS.escape(draggingLineId)}"]`);
            if (activeLineNode) activeLineNode.parentNode.appendChild(activeLineNode);
        }

        // Rows have a draggable, non-uniform y -- find whichever one sits
        // closest to a given absolute (post-topMargin) SVG y coordinate.
        function nearestColumnIndex(absoluteY) {
            let best = 0, bestDist = Infinity;
            model.timeSteps.forEach((ts, i) => {
                const d = Math.abs(R.rowY(model, i) - absoluteY);
                if (d < bestDist) { bestDist = d; best = i; }
            });
            return best;
        }

        // Which row-to-row segment of a line (birth..death-1) a given
        // absolute y falls within -- the largest row whose y is <= it.
        function segmentColumnAt(minCol, maxCol, absoluteY) {
            let col = minCol;
            for (let c = minCol; c <= maxCol; c++) {
                if (R.rowY(model, c) <= absoluteY) col = c; else break;
            }
            return Math.min(Math.max(col, minCol), maxCol);
        }

        function stopDrag() {
            document.removeEventListener('mousemove', onDragMove);
            document.removeEventListener('mouseup', onDragEnd);
            drag = null;
            draggingLineId = null;
        }

        // Sets a column's x and swaps it past a neighbour it's crossed (one
        // step per call, same as a plain time-step drag) so the array stays
        // in x-order -- the renderer walks columns by array index assuming
        // that order, so anything that frees a column to move past its
        // neighbours (a time-step drag, a process edge/body drag) needs to
        // keep it true rather than just clamping movement at the neighbour.
        function repositionColumn(idx, newX) {
            const ts = model.timeSteps[idx];
            ts.x = Math.max(0, newX);
            if (idx > 0 && ts.x < model.timeSteps[idx - 1].x) {
                M.swapTimeSteps(model, idx, idx - 1);
                idx--;
            } else if (idx < model.timeSteps.length - 1 && ts.x > model.timeSteps[idx + 1].x) {
                M.swapTimeSteps(model, idx, idx + 1);
                idx++;
            }
            return idx;
        }

        // Finds a step by its own id, wherever it lives (a column can now
        // hold several unrelated ones) -- returns its column index too,
        // since most callers need to know both.
        function findStep(stepId) {
            for (let i = 0; i < model.timeSteps.length; i++) {
                const step = (model.timeSteps[i].steps || []).find(s => s.id === stepId);
                if (step) return { step, col: i };
            }
            return null;
        }

        // How close (in absolute SVG y) a drop point needs to be to an
        // existing row to reuse it instead of creating a dedicated new one.
        const ROW_SNAP_TOLERANCE = 20;

        // Places a brand new step somewhere between (and including)
        // `minCol`/`maxCol` at the given absolute y -- if an existing row in
        // that range is close enough, the step is attached there (sharing
        // whatever else already happens at that moment) instead of always
        // forcing a dedicated new row in between. This is what lets two
        // unrelated lines' events genuinely happen "at the same time"
        // rather than always being wedged apart.
        function placeStep(minCol, maxCol, absoluteY, step) {
            minCol = Math.max(minCol, 0);
            maxCol = Math.min(maxCol, model.timeSteps.length - 1);
            if (minCol > maxCol) return null;
            let nearest = minCol, nearestDist = Infinity;
            for (let c = minCol; c <= maxCol; c++) {
                const d = Math.abs(R.rowY(model, c) - absoluteY);
                if (d < nearestDist) { nearestDist = d; nearest = c; }
            }
            if (nearestDist <= ROW_SNAP_TOLERANCE) {
                M.addStepAt(model, nearest, step);
                return nearest;
            }
            let insertIndex = maxCol + 1;
            for (let c = minCol; c <= maxCol; c++) {
                if (R.rowY(model, c) > absoluteY) { insertIndex = c; break; }
            }
            M.insertStepColumn(model, insertIndex, step, absoluteY - R.LAYOUT.topMargin);
            return insertIndex;
        }

        // Splits a step out into its own dedicated column if it's currently
        // sharing one with anything else, so dragging it vertically (see
        // timeStepDragMove) only ever moves ITSELF through time, never
        // whatever unrelated step(s) happen to also live on that row.
        // Returns the step's (possibly new) column index.
        function ensureOwnColumn(step) {
            const found = findStep(step.id);
            if (!found) return -1;
            const { col } = found;
            const ts = model.timeSteps[col];
            if (ts.steps.length <= 1) return col;
            const idx = ts.steps.indexOf(step);
            ts.steps.splice(idx, 1);
            const newTs = M.insertColumnAt(model, col + 1, step, ts.x);
            return model.timeSteps.indexOf(newTs);
        }

        // ---------- drag a line's hover-handle to move it, or drag it to
        // explicitly overlap another line to merge with it ----------
        // Which OTHER line (if any) is close enough, horizontally, to the
        // drop point at the given row to count as an explicit overlap --
        // "close enough" scales with both lines' stroke widths, so merging
        // only triggers when the poles would actually visually touch.
        function lineAtPoint(excludeId, col, ptX, draggedThickness) {
            const c = Math.max(0, Math.min(col, model.timeSteps.length - 1));
            let best = null, bestDist = Infinity;
            lines.forEach(l => {
                if (l.id === excludeId) return;
                if (c < l.birth || c > l.death) return;
                const entry = layouts[c][l.id];
                if (!entry) return;
                const threshold = (entry.thickness + (draggedThickness || 0)) / 2 + 3;
                const d = Math.abs(R.laneX(entry.x) - ptX);
                if (d <= threshold && d < bestDist) { bestDist = d; best = l; }
            });
            return best;
        }
        function startLineCombineDrag(e, lineId, clientY, col, columnX, onClick) {
            e.preventDefault();
            e.stopPropagation();
            drag = {
                type: 'linecombine', lineId, fixedClientY: clientY,
                startClientX: e.clientX, startClientY: e.clientY,
                col, columnX, moved: false, onClick
            };
            document.addEventListener('mousemove', onDragMove);
            document.addEventListener('mouseup', onDragEnd);
        }
        // Only the x-position (lane) matters while dragging -- y (time) stays
        // pinned to wherever the handle was originally grabbed. A plain click
        // (no real movement) doesn't count as a drag at all -- see
        // lineCombineDragEnd.
        function lineCombineDragMove(e) {
            if (!drag.moved) {
                const dist = Math.hypot(e.clientX - drag.startClientX, e.clientY - drag.startClientY);
                if (dist < 4) return;
                drag.moved = true;
                const line = lines.get(drag.lineId);
                showDragGhost(line ? line.name : drag.lineId, line ? line.color : null, e.clientX, drag.fixedClientY);
            }
            moveDragGhost(e.clientX, drag.fixedClientY);
        }
        function lineCombineDragEnd(e) {
            // No meaningful drag happened -- treat it as a click. A bare line
            // click opens the add-step form here; dragging an existing
            // instruction's own text has no click behaviour of its own (its
            // dblclick handler already edits/deletes it).
            if (!drag.moved) {
                if (drag.onClick) drag.onClick(e.clientX, e.clientY);
                return;
            }
            hideDragGhost();
            finishLineDrop(drag.lineId, drag.fixedClientY, e.clientX);
        }
        // Shared drop logic for "drag a line sideways" -- used both by a bare
        // line-path drag (pinned at the grabbed point) and by dragging an
        // existing instruction's text horizontally (pinned at its own row).
        function finishLineDrop(lineId, pinnedClientY, dropClientX) {
            const draggedLine = lines.get(lineId);
            if (!draggedLine) return;
            recordHistory();
            const pt = toSvgPoint(svg, dropClientX, pinnedClientY);
            const col = nearestColumnIndex(pt.y);
            const target = lineAtPoint(lineId, col, pt.x, draggedLine.thickness);
            if (target) {
                const lo = Math.max(target.birth, draggedLine.birth) + 1;
                const hi = Math.min(target.death, draggedLine.death);
                if (lo > hi) return;
                // Dropping one line onto another is an "add" -- the target
                // (the one already there) keeps its own identity/colour,
                // just gets thicker, rather than spawning a brand new named
                // combination every time. Both before and after stay the
                // SAME line/path, which also sidesteps a drop-shadow seam a
                // separate new line would otherwise show at the join.
                placeStep(lo, hi, pt.y, {
                    id: M.genId('step'), type: 'add', baseLineId: target.id, addedLineId: lineId,
                    newThickness: target.thickness + draggedLine.thickness
                });
            } else {
                const newX = pt.x - R.LAYOUT.leftMargin;
                placeStep(draggedLine.birth + 1, draggedLine.death, pt.y, { id: M.genId('step'), type: 'move', lineId, newX, text: 'Move' });
            }
            refresh();
        }
        // An existing instruction's label is a single free 2D drag: whichever
        // axis you actually move in first "wins" for the rest of the drag --
        // vertical repositions this row in TIME (same mechanics as the old
        // left-gutter handle, now gone); horizontal behaviour depends on the
        // step's own type. A plain click (no real movement either way) does
        // nothing extra -- dblclick already edits/deletes the instruction's
        // text.
        function startStepDrag(e, stepId) {
            e.preventDefault();
            e.stopPropagation();
            const found = findStep(stepId);
            if (!found) return;
            const { step } = found;
            // A move's label IS its destination -- dragging it sideways just
            // shifts where it already leads to, directly, rather than
            // inserting a brand new step (that's still what a bare `label`
            // step does, since it has no position of its own to shift).
            if (step.type === 'move') {
                const pt = toSvgPoint(svg, e.clientX, e.clientY);
                drag = {
                    type: 'move-step', stepId, startClientX: e.clientX, startClientY: e.clientY,
                    axis: null, startSvgX: pt.x, startNewX: step.newX
                };
            } else {
                drag = { type: 'step', stepId, lineId: step.lineId, startClientX: e.clientX, startClientY: e.clientY, axis: null };
            }
            document.addEventListener('mousemove', onDragMove);
            document.addEventListener('mouseup', onDragEnd);
        }
        function stepDragMove(e) {
            if (!drag.axis) {
                const dx = e.clientX - drag.startClientX, dy = e.clientY - drag.startClientY;
                if (Math.hypot(dx, dy) < 4) return;
                drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
                if (drag.axis === 'x') {
                    const line = lines.get(drag.lineId);
                    showDragGhost(line ? line.name : drag.lineId, line ? line.color : null, e.clientX, drag.startClientY);
                } else {
                    recordHistory();
                    const found = findStep(drag.stepId);
                    drag.col = found ? ensureOwnColumn(found.step) : -1;
                }
            }
            if (drag.axis === 'y') timeStepDragMove(e);
            else moveDragGhost(e.clientX, drag.startClientY);
        }
        // A move's destination shifts live as you drag (vertical still just
        // reorders the row in time, reusing the same mechanics as any other
        // step/column).
        function moveStepDragMove(e) {
            const found = findStep(drag.stepId);
            if (!found) return;
            const { step } = found;
            if (!drag.axis) {
                const dx = e.clientX - drag.startClientX, dy = e.clientY - drag.startClientY;
                if (Math.hypot(dx, dy) < 4) return;
                drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
                recordHistory();
                if (drag.axis === 'x') draggingLineId = step.lineId;
                else drag.col = ensureOwnColumn(step);
            }
            if (drag.axis === 'y') timeStepDragMove(e);
            else {
                const pt = toSvgPoint(svg, e.clientX, e.clientY);
                step.newX = Math.max(0, drag.startNewX + (pt.x - drag.startSvgX));
                refresh();
            }
        }
        function stepDragEnd(e) {
            if (drag.axis === 'x') {
                hideDragGhost();
                finishLineDrop(drag.lineId, drag.startClientY, e.clientX);
            }
        }
        // Hovering the last curving segment right before a merge (or an
        // add) shows a scissors button to detach just this one input -- it
        // then just continues straight on instead of curving into the
        // merge/add (a merge keeps its remaining inputs, or is dropped
        // entirely if fewer than 2 would be left; an add is just dropped
        // outright, since there's nothing left to keep).
        function cancelMergeInput(deathIndex, lineId) {
            const ts = model.timeSteps[deathIndex];
            const step = ts && (ts.steps || []).find(s =>
                (s.type === 'merge' && s.inputLineIds.includes(lineId)) ||
                (s.type === 'add' && s.addedLineId === lineId));
            if (!step) return;
            recordHistory();
            if (step.type === 'add') {
                M.removeStepById(model, step.id);
                refresh();
                return;
            }
            step.inputLineIds = step.inputLineIds.filter(id => id !== lineId);
            if (step.inputLineIds.length < 2) M.removeStepById(model, step.id);
            refresh();
        }

        // ---------- click an item to select it -- reveals its color/
        // thickness/opacity/delete controls (persistent, not hover-driven)
        // until you click it again or click elsewhere to deselect. Kept
        // deliberately separate from dragging: each selectable element only
        // calls this from its own drag-end handler when NO real movement
        // happened (see the `moved` flag on each drag type below). ----------
        function isSelected(kind, id) {
            return !!selected && selected.kind === kind && selected.id === id;
        }
        function selectItem(kind, id) {
            selected = isSelected(kind, id) ? null : { kind, id };
            renderSelectionUi();
        }
        function deselect() {
            if (!selected) return;
            selected = null;
            renderSelectionUi();
        }
        function renderSelectionUi() {
            hideHoverButton('color');
            hideHoverButton('thick');
            hideHoverButton('delete');
            if (!selected) return;
            if (selected.kind === 'ingredient') {
                const ing = model.ingredients.find(i => i.id === selected.id);
                const node = svg.querySelector(`text[data-kind="line"][data-line-kind="ingredient"][data-id="${CSS.escape(selected.id)}"]`);
                if (!ing || !node) { selected = null; return; }
                const pathNode = svg.querySelector(`path[data-kind="line"][data-id="${CSS.escape(selected.id)}"]`);
                if (pathNode) pathNode.classList.add('is-selected');
                const pos = svgToClient(svg, parseFloat(node.getAttribute('x')), parseFloat(node.getAttribute('y')));
                showColorSwatch(pos.x - 10, pos.y - 16, ing.color, v => { ing.color = v; refresh(); renderSelectionUi(); }, recordHistory);
                showThicknessAdjuster(pos.x + 10, pos.y - 16, e2 => {
                    e2.preventDefault(); e2.stopPropagation();
                    recordHistory();
                    drag = { type: 'thickness', startY: e2.clientY, startVal: ing.thickness, onChange: v => { ing.thickness = v; refresh(); renderSelectionUi(); } };
                    document.addEventListener('mousemove', onDragMove);
                    document.addEventListener('mouseup', onDragEnd);
                });
                showDeleteButton(pos.x, pos.y - 32, () => { recordHistory(); M.removeIngredient(model, ing.id); deselect(); refresh(); });
            } else if (selected.kind === 'merge') {
                const idx = model.timeSteps.findIndex(t => (t.steps || []).some(s => s.type === 'merge' && s.outputLineId === selected.id));
                const node = svg.querySelector(`text[data-kind="line"][data-line-kind="merge"][data-id="${CSS.escape(selected.id)}"]`);
                if (idx < 0 || !node) { selected = null; return; }
                const pathNode = svg.querySelector(`path[data-kind="line"][data-id="${CSS.escape(selected.id)}"]`);
                if (pathNode) pathNode.classList.add('is-selected');
                const step = model.timeSteps[idx].steps.find(s => s.type === 'merge' && s.outputLineId === selected.id);
                const pos = svgToClient(svg, parseFloat(node.getAttribute('x')), parseFloat(node.getAttribute('y')));
                // A combined ingredient gets the exact same colour/thickness
                // controls as a raw one -- it's a real line with its own
                // stored values now, not derived from its inputs.
                showColorSwatch(pos.x - 10, pos.y - 16, step.outputColor, v => { step.outputColor = v; refresh(); renderSelectionUi(); }, recordHistory);
                showThicknessAdjuster(pos.x + 10, pos.y - 16, e2 => {
                    e2.preventDefault(); e2.stopPropagation();
                    recordHistory();
                    drag = { type: 'thickness', startY: e2.clientY, startVal: step.outputThickness, onChange: v => { step.outputThickness = v; refresh(); renderSelectionUi(); } };
                    document.addEventListener('mousemove', onDragMove);
                    document.addEventListener('mouseup', onDragEnd);
                });
                showDeleteButton(pos.x, pos.y - 32, () => { recordHistory(); M.removeStepById(model, step.id); deselect(); refresh(); });
            } else if (selected.kind === 'utensil') {
                const u = model.utensils.find(x => x.id === selected.id);
                if (!u) { selected = null; return; }
                const utensilNode = svg.querySelector(`rect[data-kind="utensil"][data-id="${CSS.escape(selected.id)}"]`);
                if (utensilNode) utensilNode.classList.add('is-selected');
                const pos = svgToClient(svg, R.laneX(u.x) + 6, R.LAYOUT.utensilTop + 14);
                showColorSwatch(pos.x - 16, pos.y, u.color, v => { u.color = v; refresh(); renderSelectionUi(); }, recordHistory);
                showDeleteButton(pos.x - 16, pos.y - 20, () => { recordHistory(); M.removeUtensil(model, u.id); deselect(); refresh(); });
            } else if (selected.kind === 'process') {
                const p = model.processes.find(x => x.id === selected.id);
                const u = p && model.utensils.find(x => x.id === p.utensilId);
                if (!p || !u) { selected = null; return; }
                const processNode = svg.querySelector(`rect[data-kind="process"][data-id="${CSS.escape(selected.id)}"]`);
                if (processNode) processNode.classList.add('is-selected');
                const pos = svgToClient(svg, R.laneX(u.x) + 6, R.rowY(model, p.startTimeStepIndex) + 14);
                showColorSwatch(pos.x - 16, pos.y, p.color, v => { p.color = v; refresh(); renderSelectionUi(); }, recordHistory);
                showThicknessAdjuster(pos.x + 76, pos.y, e2 => {
                    e2.preventDefault(); e2.stopPropagation();
                    recordHistory();
                    const startVal = p.opacity != null ? p.opacity : 0.35;
                    drag = {
                        type: 'opacity', startY: e2.clientY, startVal,
                        onChange: v => { p.opacity = v; refresh(); renderSelectionUi(); }
                    };
                    document.addEventListener('mousemove', onDragMove);
                    document.addEventListener('mouseup', onDragEnd);
                });
                showDeleteButton(pos.x - 16, pos.y - 20, () => { recordHistory(); M.removeProcess(model, p.id); deselect(); refresh(); });
            }
        }

        // Name tag text doubles as both name+quantity ("Lime (1)") -- typing
        // a plain "name (qty)" pattern back in splits it, otherwise the whole
        // string just becomes the name and quantity is cleared. Edits happen
        // right on top of the label itself (its real anchor/position/font),
        // not wherever the dblclick happened to land.
        function editIngredientName(ing, clientX, clientY) {
            let pos = { x: clientX, y: clientY };
            const node = svg.querySelector(`text[data-kind="line"][data-line-kind="ingredient"][data-id="${CSS.escape(ing.id)}"]`);
            if (node) pos = svgToClient(svg, parseFloat(node.getAttribute('x')), parseFloat(node.getAttribute('y')));
            const current = ing.quantity ? `${ing.name} (${ing.quantity})` : ing.name;
            editTextInPlace(pos.x, pos.y, current, val => {
                const m = val.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
                if (m) { ing.name = m[1].trim(); ing.quantity = m[2].trim(); }
                else { ing.name = val.trim(); ing.quantity = ''; }
                refresh();
            }, () => { M.removeIngredient(model, ing.id); refresh(); }, { anchor: 'middle', fontStyle: 'italic', fontSize: '12px' });
        }

        function editMergeOutputName(lineId, clientX, clientY) {
            const idx = model.timeSteps.findIndex(ts => (ts.steps || []).some(s => s.type === 'merge' && s.outputLineId === lineId));
            if (idx < 0) return;
            const step = model.timeSteps[idx].steps.find(s => s.type === 'merge' && s.outputLineId === lineId);
            let pos = { x: clientX, y: clientY };
            const node = svg.querySelector(`text[data-kind="line"][data-line-kind="merge"][data-id="${CSS.escape(lineId)}"]`);
            if (node) pos = svgToClient(svg, parseFloat(node.getAttribute('x')), parseFloat(node.getAttribute('y')));
            editTextInPlace(pos.x, pos.y, step.outputName || '', val => { step.outputName = val.trim(); refresh(); },
                () => { M.removeStepById(model, step.id); refresh(); }, { anchor: 'middle', fontStyle: 'italic', fontSize: '12px' });
        }

        // Editing an existing label/move step (dblclick its text on the line).
        function editStepText(stepId, clientX, clientY) {
            const found = findStep(stepId);
            if (!found) return;
            const { step, col } = found;
            let pos = { x: clientX, y: clientY };
            const entry = layouts[col] && layouts[col][step.lineId];
            if (entry) pos = svgToClient(svg, R.laneX(entry.x), R.rowY(model, col) + 4);
            editTextInPlace(pos.x, pos.y, step.text || '', val => { step.text = val.trim(); refresh(); },
                () => { M.removeStepById(model, step.id); refresh(); }, { anchor: 'middle', fontSize: '11px' });
        }

        // Small creation form shown from clicking the line's hover-handle --
        // inserts a brand new row at `columnX` (wherever the user was
        // hovering along the line), not just the midpoint between its
        // neighbours. "Move" isn't offered here any more -- dragging the
        // handle sideways IS how you move a line now.
        function openAddStepPopover(lineId, col, columnX, clientX, clientY) {
            closePopover();
            const pop = mkEl('div', { class: 'inline-popover' });
            pop.style.left = `${clientX}px`;
            pop.style.top = `${clientY}px`;
            pop.addEventListener('mousedown', e => e.stopPropagation());

            const typeSel = mkEl('select', {}, ['label', 'merge'].map(t => mkEl('option', { value: t, text: t })));
            pop.appendChild(mkEl('label', { class: 'popover-field' }, [mkEl('span', { text: 'Step Type' }), typeSel]));
            const body = mkEl('div', {});
            pop.appendChild(body);

            function addBtn(text, onClick) {
                return mkEl('button', { class: 'popover-add-btn', text, onclick: onClick });
            }
            function fieldRow(label, input) {
                return mkEl('label', { class: 'popover-field' }, [mkEl('span', { text: label }), input]);
            }

            function rebuildBody() {
                body.innerHTML = '';
                if (typeSel.value === 'label') {
                    const textInp = mkEl('input', { type: 'text' });
                    body.appendChild(fieldRow('Text', textInp));
                    body.appendChild(addBtn('Add Step', () => {
                        if (!textInp.value.trim()) { alert('Enter text.'); return; }
                        recordHistory();
                        placeStep(col, col + 1, R.LAYOUT.topMargin + columnX, { id: M.genId('step'), type: 'label', lineId, text: textInp.value.trim() });
                        closePopover(); refresh();
                    }));
                    setTimeout(() => textInp.focus(), 0);
                } else {
                    const checkList = mkEl('div', { class: 'check-list' });
                    const checks = [];
                    lines.forEach(l => {
                        if (col < l.birth || col > l.death) return;
                        const cb = mkEl('input', { type: 'checkbox', value: l.id });
                        if (l.id === lineId) cb.checked = true;
                        checks.push(cb);
                        checkList.appendChild(mkEl('label', { class: 'check-item' }, [cb, document.createTextNode(` ${l.name}`)]));
                    });
                    body.appendChild(fieldRow('Inputs to merge', checkList));
                    const nameInp = mkEl('input', { type: 'text', value: 'Combined' });
                    body.appendChild(fieldRow('Output Name', nameInp));
                    body.appendChild(addBtn('Add Step', () => {
                        const ids = checks.filter(c => c.checked).map(c => c.value);
                        if (ids.length < 2) { alert('Select at least 2 lines to merge.'); return; }
                        recordHistory();
                        const entry = layouts[col] && layouts[col][lineId];
                        const outputX = entry ? entry.x : 0;
                        const inputLines = ids.map(id => lines.get(id)).filter(Boolean);
                        const outputColor = inputLines[0] ? inputLines[0].color : '#888888';
                        const outputThickness = inputLines.reduce((sum, l) => sum + l.thickness, 0) || 10;
                        placeStep(col, col + 1, R.LAYOUT.topMargin + columnX, {
                            id: M.genId('step'), type: 'merge', inputLineIds: ids, outputLineId: M.genId('line'),
                            outputName: nameInp.value.trim() || 'Combined', outputX, outputColor, outputThickness
                        });
                        closePopover(); refresh();
                    }));
                }
            }
            typeSel.addEventListener('change', rebuildBody);
            rebuildBody();

            document.body.appendChild(pop);
            popoverEl = pop;
            outsideClickHandler = e => { if (!pop.contains(e.target)) closePopover(); };
            setTimeout(() => document.addEventListener('mousedown', outsideClickHandler), 0);
        }

        // "+ Process" hover button (shown anywhere along a utensil, which is a
        // permanent fixture with no time range of its own) -- anchors the new
        // process's time range around the hovered row.
        function quickAddProcess(utensilId, columnX, clientX, clientY) {
            recordHistory();
            const u = model.utensils.find(x => x.id === utensilId);
            if (!u) return;
            const startX = columnX - R.LAYOUT.columnWidth / 4;
            const endX = columnX + R.LAYOUT.columnWidth * 0.75;
            const p = M.addProcess(model, { utensilId, startX, endX });
            refresh();
            editProcessLabel(p.id, clientX, clientY);
        }

        // Process label/sublabel edit in place -- color/opacity/delete now
        // live on the selection panel instead (click the process to select
        // it), so these two just handle their own text.
        function editProcessLabel(id, clientX, clientY) {
            const p = model.processes.find(x => x.id === id);
            if (!p) return;
            let pos = { x: clientX, y: clientY };
            const node = svg.querySelector(`text[data-kind="process-label"][data-id="${CSS.escape(id)}"]`);
            if (node) pos = svgToClient(svg, parseFloat(node.getAttribute('x')), parseFloat(node.getAttribute('y')));
            editTextInPlace(pos.x, pos.y, p.label || '', val => { p.label = val.trim(); refresh(); },
                null, { anchor: 'start', fontWeight: '700', fontSize: '12px' });
        }
        function editProcessSublabel(id, clientX, clientY) {
            const p = model.processes.find(x => x.id === id);
            if (!p) return;
            let pos = { x: clientX, y: clientY };
            const node = svg.querySelector(`text[data-kind="process-sublabel"][data-id="${CSS.escape(id)}"]`);
            if (node) pos = svgToClient(svg, parseFloat(node.getAttribute('x')), parseFloat(node.getAttribute('y')));
            editTextInPlace(pos.x, pos.y, p.sublabel || '', val => { p.sublabel = val.trim(); refresh(); },
                null, { anchor: 'start', fontWeight: '700', fontSize: '11px' });
        }

        // ---------- time step reorder (free-drag along the timeline --
        // columns are NOT equal width, so this sets an explicit x rather
        // than snapping to a uniform grid; crossing a neighbour swaps array
        // order so index order always matches x order). Reused by the
        // unified instruction drag above (vertical axis) -- there's no
        // dedicated left-gutter handle for this any more. Operates on
        // `drag.col` (an index, kept up to date as it swaps past
        // neighbours), not a column id -- the caller is responsible for
        // first splitting a shared step out into its own column via
        // `ensureOwnColumn` so this never drags unrelated steps along. ----------
        function timeStepDragMove(e) {
            if (drag.col == null || drag.col < 0) return;
            const pt = toSvgPoint(svg, e.clientX, e.clientY);
            drag.col = repositionColumn(drag.col, pt.y - R.LAYOUT.topMargin);
            refresh();
        }

        function editUtensil(id, clientX, clientY) {
            const u = model.utensils.find(x => x.id === id);
            if (!u) return;
            const pos = svgToClient(svg, R.laneX(u.x) + 6, R.LAYOUT.utensilTop + 14);
            editTextInPlace(pos.x, pos.y, u.name, val => { u.name = val.trim(); refresh(); }, () => { M.removeUtensil(model, id); refresh(); }, { anchor: 'start', fontWeight: '600', fontSize: '12px' });
        }

        // ---------- utensils are permanent fixtures: drag the body sideways
        // to reposition (within or across zones), grab a left/right edge to
        // resize, dblclick to rename ----------
        // Whichever ingredient starting positions / move-step / merge-step
        // targets currently sit within a utensil's own footprint are treated
        // as "on" it -- snapshotted once at drag start so they all shift by
        // the same delta as the utensil itself, rather than getting left
        // behind.
        function thingsOnUtensil(u) {
            const lo = u.x, hi = u.x + u.width;
            const items = [];
            model.ingredients.forEach(ing => {
                if ((ing.x || 0) >= lo && (ing.x || 0) <= hi) items.push({ obj: ing, key: 'x', start: ing.x || 0 });
            });
            model.timeSteps.forEach(ts => {
                (ts.steps || []).forEach(s => {
                    if (s.type === 'move' && s.newX >= lo && s.newX <= hi) items.push({ obj: s, key: 'newX', start: s.newX });
                    else if (s.type === 'merge' && s.outputX >= lo && s.outputX <= hi) items.push({ obj: s, key: 'outputX', start: s.outputX });
                });
            });
            return items;
        }
        function startUtensilDrag(e, id) {
            e.preventDefault();
            e.stopPropagation();
            const u = model.utensils.find(x => x.id === id);
            if (!u) return;
            const pt = toSvgPoint(svg, e.clientX, e.clientY);
            drag = {
                type: 'utensil', id, startSvgX: pt.x, startX: u.x, attachments: thingsOnUtensil(u),
                startClientX: e.clientX, startClientY: e.clientY, moved: false
            };
            document.addEventListener('mousemove', onDragMove);
            document.addEventListener('mouseup', onDragEnd);
        }
        function utensilDragMove(e) {
            if (!drag.moved) {
                if (Math.hypot(e.clientX - drag.startClientX, e.clientY - drag.startClientY) < 4) return;
                drag.moved = true;
                recordHistory();
            }
            const u = model.utensils.find(x => x.id === drag.id);
            if (!u) return;
            const pt = toSvgPoint(svg, e.clientX, e.clientY);
            const delta = pt.x - drag.startSvgX;
            u.x = Math.max(0, drag.startX + delta);
            const actualDelta = u.x - drag.startX;
            drag.attachments.forEach(a => { a.obj[a.key] = Math.max(0, a.start + actualDelta); });
            const center = u.x + u.width / 2;
            const zone = (model.zones || []).find(z => center >= z.x && center <= z.x + z.width);
            if (zone) u.zoneId = zone.id;
            refresh();
        }
        function startUtensilResize(e, id, edge) {
            e.preventDefault();
            e.stopPropagation();
            const u = model.utensils.find(x => x.id === id);
            if (!u) return;
            recordHistory();
            const pt = toSvgPoint(svg, e.clientX, e.clientY);
            drag = { type: 'utensil-resize', id, edge, startSvgX: pt.x, startX: u.x, startWidth: u.width };
            document.addEventListener('mousemove', onDragMove);
            document.addEventListener('mouseup', onDragEnd);
        }
        function utensilResizeMove(e) {
            const u = model.utensils.find(x => x.id === drag.id);
            if (!u) return;
            const pt = toSvgPoint(svg, e.clientX, e.clientY);
            const delta = pt.x - drag.startSvgX;
            if (drag.edge === 'left') {
                const maxX = drag.startX + drag.startWidth - 20;
                const newX = Math.max(0, Math.min(drag.startX + delta, maxX));
                u.width = drag.startWidth + (drag.startX - newX);
                u.x = newX;
            } else {
                u.width = Math.max(20, drag.startWidth + delta);
            }
            refresh();
        }

        // ---------- processes: drag the body to shift both start & end
        // together, grab a top/bottom edge to change just the start or
        // finish, dblclick to edit label/sublabel/color ----------
        function startProcessDrag(e, id) {
            e.preventDefault();
            e.stopPropagation();
            const p = model.processes.find(x => x.id === id);
            if (!p) return;
            const pt = toSvgPoint(svg, e.clientX, e.clientY);
            drag = {
                type: 'process-shift', id, startSvgY: pt.y,
                startStartX: model.timeSteps[p.startTimeStepIndex].x,
                startEndX: model.timeSteps[p.endTimeStepIndex].x,
                startClientX: e.clientX, startClientY: e.clientY, moved: false
            };
            document.addEventListener('mousemove', onDragMove);
            document.addEventListener('mouseup', onDragEnd);
        }
        function processDragMove(e) {
            if (!drag.moved) {
                if (Math.hypot(e.clientX - drag.startClientX, e.clientY - drag.startClientY) < 4) return;
                drag.moved = true;
                recordHistory();
            }
            const p = model.processes.find(x => x.id === drag.id);
            if (!p) return;
            const pt = toSvgPoint(svg, e.clientX, e.clientY);
            const delta = pt.y - drag.startSvgY;
            const span = drag.startEndX - drag.startStartX;
            const newStart = Math.max(0, drag.startStartX + delta);
            // Repositioning (not clamping against) each boundary independently
            // lets the whole process slide freely past unrelated columns,
            // swapping array order to match as it goes -- same mechanism as
            // dragging a plain time step.
            repositionColumn(p.startTimeStepIndex, newStart);
            repositionColumn(p.endTimeStepIndex, newStart + span);
            refresh();
        }
        function startProcessResize(e, id, edge) {
            e.preventDefault();
            e.stopPropagation();
            const p = model.processes.find(x => x.id === id);
            if (!p) return;
            recordHistory();
            const pt = toSvgPoint(svg, e.clientX, e.clientY);
            drag = {
                type: 'process-resize', id, edge, startSvgY: pt.y,
                startStartX: model.timeSteps[p.startTimeStepIndex].x,
                startEndX: model.timeSteps[p.endTimeStepIndex].x
            };
            document.addEventListener('mousemove', onDragMove);
            document.addEventListener('mouseup', onDragEnd);
        }
        function processResizeMove(e) {
            const p = model.processes.find(x => x.id === drag.id);
            if (!p) return;
            const pt = toSvgPoint(svg, e.clientX, e.clientY);
            const delta = pt.y - drag.startSvgY;
            // Only clamp against the process's OWN other edge (keep a
            // minimum gap) -- repositioning past any unrelated column swaps
            // it out of the way instead of just stopping dead against it.
            if (drag.edge === 'top') {
                const hi = model.timeSteps[p.endTimeStepIndex].x - 10;
                repositionColumn(p.startTimeStepIndex, Math.min(drag.startStartX + delta, hi));
            } else {
                const lo = model.timeSteps[p.startTimeStepIndex].x + 10;
                repositionColumn(p.endTimeStepIndex, Math.max(drag.startEndX + delta, lo));
            }
            refresh();
        }

        // ---------- dblclick empty zone space to place a new utensil fixture
        // there (utensils have no time range any more, just a fixed spot) ----------
        function addUtensilInZone(zoneId, clientX, clientY) {
            const zone = (model.zones || []).find(z => z.id === zoneId);
            if (!zone) return;
            recordHistory();
            const pt = toSvgPoint(svg, clientX, clientY);
            const width = 70;
            const x = Math.max(zone.x + 4, Math.min(pt.x - R.LAYOUT.leftMargin - width / 2, zone.x + zone.width - width - 4));
            const u = M.addUtensil(model, { zoneId, x, width });
            refresh();
            editUtensil(u.id, clientX, clientY);
        }

        // ---------- add ingredient / add time step ----------
        function addIngredientAndEdit(e) {
            recordHistory();
            const ing = M.addIngredient(model);
            refresh();
            editIngredientName(ing, e.clientX, e.clientY);
        }
        function addTimeStepAction() {
            recordHistory();
            M.addTimeStep(model);
            refresh();
        }

        function thicknessDragMove(e) {
            const delta = (drag.startY - e.clientY) / 4;
            const val = Math.max(1, Math.round(drag.startVal + delta));
            drag.onChange(val);
        }
        function opacityDragMove(e) {
            const delta = (drag.startY - e.clientY) / 200;
            const val = Math.max(0.05, Math.min(1, +(drag.startVal + delta).toFixed(2)));
            drag.onChange(val);
        }

        // ---------- unified drag dispatch ----------
        function onDragMove(e) {
            if (!drag) return;
            if (drag.type === 'step') stepDragMove(e);
            else if (drag.type === 'move-step') moveStepDragMove(e);
            else if (drag.type === 'ingredient-pos') ingredientLabelDragMove(e);
            else if (drag.type === 'merge-pos') mergeLabelDragMove(e);
            else if (drag.type === 'utensil') utensilDragMove(e);
            else if (drag.type === 'utensil-resize') utensilResizeMove(e);
            else if (drag.type === 'process-shift') processDragMove(e);
            else if (drag.type === 'process-resize') processResizeMove(e);
            else if (drag.type === 'linecombine') lineCombineDragMove(e);
            else if (drag.type === 'thickness') thicknessDragMove(e);
            else if (drag.type === 'opacity') opacityDragMove(e);
        }
        function onDragEnd(e) {
            if (drag && drag.type === 'step') stepDragEnd(e);
            else if (drag && drag.type === 'linecombine') lineCombineDragEnd(e);
            else if (drag && drag.type === 'ingredient-pos' && !drag.moved) selectItem('ingredient', drag.id);
            else if (drag && drag.type === 'merge-pos' && !drag.axis) {
                const found = findStep(drag.stepId);
                if (found) selectItem('merge', found.step.outputLineId);
            }
            else if (drag && drag.type === 'utensil' && !drag.moved) selectItem('utensil', drag.id);
            else if (drag && drag.type === 'process-shift' && !drag.moved) selectItem('process', drag.id);
            stopDrag();
        }

        // ---------- drag an ingredient's own name tag to change where it
        // starts (no step inserted, just the raw starting position) ----------
        function startIngredientLabelDrag(e, ing) {
            e.preventDefault();
            e.stopPropagation();
            const pt = toSvgPoint(svg, e.clientX, e.clientY);
            drag = {
                type: 'ingredient-pos', id: ing.id, startSvgX: pt.x, startX: ing.x || 0,
                startClientX: e.clientX, startClientY: e.clientY, moved: false
            };
            document.addEventListener('mousemove', onDragMove);
            document.addEventListener('mouseup', onDragEnd);
        }
        function ingredientLabelDragMove(e) {
            if (!drag.moved) {
                if (Math.hypot(e.clientX - drag.startClientX, e.clientY - drag.startClientY) < 4) return;
                drag.moved = true;
                recordHistory();
                draggingLineId = drag.id;
            }
            const ing = model.ingredients.find(i => i.id === drag.id);
            if (!ing) return;
            const pt = toSvgPoint(svg, e.clientX, e.clientY);
            ing.x = Math.max(0, drag.startX + (pt.x - drag.startSvgX));
            refresh();
        }

        // ---------- drag a combined/merged ingredient's name tag -- sideways
        // repositions it in its lane (mutating the merge step's outputX,
        // same idea as a raw ingredient's x), vertically it moves the merge
        // itself to a different point in time (same mechanics as any other
        // step/column drag) -- whichever axis you actually move in first wins
        // for the rest of the drag ----------
        function startMergeLabelDrag(e, step) {
            e.preventDefault();
            e.stopPropagation();
            const pt = toSvgPoint(svg, e.clientX, e.clientY);
            drag = {
                type: 'merge-pos', stepId: step.id, startSvgX: pt.x, startX: step.outputX || 0,
                startClientX: e.clientX, startClientY: e.clientY, axis: null
            };
            document.addEventListener('mousemove', onDragMove);
            document.addEventListener('mouseup', onDragEnd);
        }
        function mergeLabelDragMove(e) {
            const found = findStep(drag.stepId);
            if (!found) return;
            const { step } = found;
            if (!drag.axis) {
                const dx = e.clientX - drag.startClientX, dy = e.clientY - drag.startClientY;
                if (Math.hypot(dx, dy) < 4) return;
                drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
                recordHistory();
                if (drag.axis === 'x') draggingLineId = step.outputLineId;
                else drag.col = ensureOwnColumn(step);
            }
            if (drag.axis === 'y') { timeStepDragMove(e); return; }
            const pt = toSvgPoint(svg, e.clientX, e.clientY);
            step.outputX = Math.max(0, drag.startX + (pt.x - drag.startSvgX));
            refresh();
        }

        // ---------- attach listeners to the freshly-rendered SVG ----------
        // A line's name tag: drag it sideways to change the ingredient's own
        // starting position directly (no step inserted -- there's nothing
        // before it to move away from); dblclick renames in place; a plain
        // click (no real movement) selects it, revealing its color swatch +
        // thickness scrubber + delete button (see renderSelectionUi above).
        svg.querySelectorAll('text[data-kind="line"][data-line-kind="ingredient"]').forEach(node => {
            const lineId = node.getAttribute('data-id');
            const ing = model.ingredients.find(i => i.id === lineId);
            if (!ing) return;
            node.addEventListener('mousedown', e => startIngredientLabelDrag(e, ing));
            node.addEventListener('dblclick', e => { e.stopPropagation(); editIngredientName(ing, e.clientX, e.clientY); });
        });
        // A combined ingredient has its own editable color/thickness, same
        // as a raw one (see renderSelectionUi) -- dragging the label sideways
        // repositions the combined line in its lane (outputX), dragging it
        // vertically moves the merge itself to a different point in time.
        svg.querySelectorAll('text[data-kind="line"][data-line-kind="merge"]').forEach(node => {
            const lineId = node.getAttribute('data-id');
            let mergeStep = null;
            for (const ts of model.timeSteps) {
                mergeStep = (ts.steps || []).find(s => s.type === 'merge' && s.outputLineId === lineId);
                if (mergeStep) break;
            }
            if (!mergeStep) return;
            node.addEventListener('mousedown', e => startMergeLabelDrag(e, mergeStep));
            node.addEventListener('dblclick', e => { e.stopPropagation(); editMergeOutputName(lineId, e.clientX, e.clientY); });
        });
        svg.querySelectorAll('[data-kind="add-timestep"]').forEach(node => {
            node.addEventListener('click', addTimeStepAction);
        });
        svg.querySelectorAll('[data-kind="add-ingredient"]').forEach(node => {
            node.addEventListener('click', addIngredientAndEdit);
        });
        // A utensil: drag the body to reposition (within/across zones),
        // dblclick to rename; a plain click selects it (color + delete). The
        // "+ Process" hint stays hover-triggered (it's a creation action,
        // not one of the utensil's own attributes).
        svg.querySelectorAll('[data-kind="utensil"]').forEach(node => {
            node.addEventListener('mousedown', e => startUtensilDrag(e, node.getAttribute('data-id')));
            node.addEventListener('dblclick', e => { e.stopPropagation(); editUtensil(node.getAttribute('data-id'), e.clientX, e.clientY); });
            node.addEventListener('mousemove', e => {
                if (drag) return;
                const u = model.utensils.find(x => x.id === node.getAttribute('data-id'));
                if (!u) return;
                const pt = toSvgPoint(svg, e.clientX, e.clientY);
                const columnX = pt.y - R.LAYOUT.topMargin;
                const pos = svgToClient(svg, R.laneX(u.x), pt.y);
                showHoverButton('process', pos.x - 24, pos.y, '+ Process', () => quickAddProcess(u.id, columnX, pos.x - 60, pos.y));
                registerHoverOrigin('process', e.clientX, e.clientY);
            });
        });
        svg.querySelectorAll('[data-kind="utensil-edge"]').forEach(node => {
            node.addEventListener('mousedown', e => startUtensilResize(e, node.getAttribute('data-id'), node.getAttribute('data-edge')));
        });
        svg.querySelectorAll('[data-kind="step"]').forEach(node => {
            node.addEventListener('mousedown', e => startStepDrag(e, node.getAttribute('data-id')));
            node.addEventListener('dblclick', e => { e.stopPropagation(); editStepText(node.getAttribute('data-id'), e.clientX, e.clientY); });
        });
        // A process: drag the body to shift both ends together, grab an
        // edge to change just the start/finish; a plain click selects it
        // (color + opacity + delete). Its label/sublabel text edit in place.
        svg.querySelectorAll('[data-kind="process"]').forEach(node => {
            node.addEventListener('mousedown', e => startProcessDrag(e, node.getAttribute('data-id')));
        });
        svg.querySelectorAll('[data-kind="process-label"]').forEach(node => {
            node.addEventListener('dblclick', e => { e.stopPropagation(); editProcessLabel(node.getAttribute('data-id'), e.clientX, e.clientY); });
        });
        svg.querySelectorAll('[data-kind="process-sublabel"]').forEach(node => {
            node.addEventListener('dblclick', e => { e.stopPropagation(); editProcessSublabel(node.getAttribute('data-id'), e.clientX, e.clientY); });
        });
        svg.querySelectorAll('[data-kind="process-edge"]').forEach(node => {
            node.addEventListener('mousedown', e => startProcessResize(e, node.getAttribute('data-id'), node.getAttribute('data-edge')));
        });
        // Hovering the last curving segment right before a merge reveals a
        // scissors button to cancel just that input (it then just continues
        // straight on instead of curving into the merge). Dragging the line
        // path ITSELF (anywhere along it) moves/merges it -- grabbing its
        // instruction text (bound above) does the exact same thing, just
        // anchored to that step's own position instead of the cursor's.
        svg.querySelectorAll('path[data-kind="line"]').forEach(node => {
            const lineId = node.getAttribute('data-id');
            const line = lines.get(lineId);
            if (!line) return;
            function pointOnLine(clientX, clientY) {
                const pt = toSvgPoint(svg, clientX, clientY);
                const col = segmentColumnAt(line.birth, Math.max(line.death - 1, line.birth), pt.y);
                const from = layouts[col] && layouts[col][lineId];
                const to = layouts[col + 1] && layouts[col + 1][lineId];
                if (!from || !to) return null;
                const y0 = R.rowY(model, col), y1 = R.rowY(model, col + 1);
                const clampedY = Math.min(Math.max(pt.y, y0), y1);
                const t = y1 > y0 ? (clampedY - y0) / (y1 - y0) : 0;
                const x = R.laneX(from.x + (to.x - from.x) * t);
                return { col, clampedY, pos: svgToClient(svg, x, clampedY), newColumnX: clampedY - R.LAYOUT.topMargin };
            }
            node.addEventListener('mousemove', e => {
                if (drag) return;
                const hit = pointOnLine(e.clientX, e.clientY);
                if (!hit) return;
                const deathTs = model.timeSteps[line.death];
                const deathStep = deathTs && (deathTs.steps || []).find(s =>
                    (s.type === 'merge' && s.inputLineIds.includes(lineId)) ||
                    (s.type === 'add' && s.addedLineId === lineId));
                const isMergingAway = hit.col === line.death - 1 && !!deathStep;
                if (isMergingAway) {
                    showHoverButton('cut', hit.pos.x, hit.pos.y, '\u2702', () => cancelMergeInput(line.death, lineId));
                    registerHoverOrigin('cut', e.clientX, e.clientY);
                } else {
                    hideHoverButton('cut');
                }
            });
            node.addEventListener('mousedown', e => {
                const hit = pointOnLine(e.clientX, e.clientY);
                if (!hit) return;
                startLineCombineDrag(e, lineId, hit.pos.y, hit.col, hit.newColumnX, (clientX, clientY) => openAddStepPopover(lineId, hit.col, hit.newColumnX, clientX, clientY));
            });
        });
        // Double-click empty zone space to place a new utensil fixture there;
        // a plain click on empty space deselects whatever's selected (every
        // other element's own mousedown handler already stops propagation,
        // so this only ever fires for genuinely empty background).
        svg.querySelectorAll('rect[data-kind="zone"]').forEach(node => {
            node.addEventListener('dblclick', e => {
                e.stopPropagation();
                addUtensilInZone(node.getAttribute('data-id'), e.clientX, e.clientY);
            });
        });
        svg.addEventListener('mousedown', () => deselect());

        renderSelectionUi();
    }

    global.VEP = global.VEP || {};
    global.VEP.interact = { bindAll, closePopover };
})(window);
