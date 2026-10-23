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
    // `opts.bg`/`opts.color` make it blend into a colour-matched pill label
    // instead of looking like a separate floating input box (no border,
    // same colour/shape as the pill it's replacing). `opts.hideEls` names
    // the exact SVG element(s) being edited (the text, and its own pill if
    // it has one) -- hidden for the duration. `opts.rect` (a plain
    // `{left,top,width,height}`, NOT read off the text node itself -- SVG
    // `<text>` bboxes can collapse to near-zero height in this renderer)
    // sizes/positions the input to EXACTLY replace them, so it reads as
    // the cursor landing directly in the label rather than a new box
    // appearing over it.
    function editTextInPlace(clientX, clientY, currentValue, onCommit, onDelete, opts) {
        opts = opts || {};
        closePopover();
        const wrap = document.createElement('div');
        wrap.className = 'inline-edit-wrap';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'inline-edit-input';
        input.value = currentValue;
        if (opts.placeholder) input.placeholder = opts.placeholder;
        // Copy the ACTUAL rendered SVG text's own computed font straight
        // across, rather than a hardcoded guess per call site -- otherwise
        // the input can end up a slightly different size/weight than the
        // label it's replacing, reading as the text visibly changing the
        // moment you start editing it instead of staying exactly in place.
        if (opts.sourceEl) {
            const cs = getComputedStyle(opts.sourceEl);
            input.style.fontSize = cs.fontSize;
            input.style.fontWeight = cs.fontWeight;
            input.style.fontStyle = cs.fontStyle;
            input.style.fontFamily = cs.fontFamily;
            input.style.letterSpacing = cs.letterSpacing;
        } else {
            if (opts.fontSize) input.style.fontSize = opts.fontSize;
            if (opts.fontStyle) input.style.fontStyle = opts.fontStyle;
            if (opts.fontWeight) input.style.fontWeight = opts.fontWeight;
        }
        if (opts.bg) {
            input.classList.add('inline-edit-input--pill');
            input.style.background = opts.bg;
            input.style.color = opts.color || '#fff';
        } else if (opts.transparent) {
            input.classList.add('inline-edit-input--transparent');
            if (opts.color) input.style.color = opts.color;
        }
        const hideEls = (opts.hideEls || []).filter(Boolean);
        const rect = opts.rect && opts.rect.width ? opts.rect : null;
        if (rect) {
            wrap.style.left = `${rect.left}px`;
            wrap.style.top = `${rect.top}px`;
            wrap.style.transform = 'none';
            input.style.height = `${rect.height}px`;
            input.style.lineHeight = `${rect.height}px`;
            hideEls.forEach(el => { el.style.visibility = 'hidden'; });
        } else {
            wrap.style.left = `${clientX}px`;
            wrap.style.top = `${clientY}px`;
            wrap.style.transform = opts.anchor === 'end' ? 'translate(-100%, -50%)'
                : opts.anchor === 'middle' ? 'translate(-50%, -50%)' : 'translate(0, -50%)';
        }
        const resize = () => {
            const chWidth = Math.max(input.value.length, 3);
            input.style.width = rect && rect.width ? `${Math.max(rect.width, chWidth * 7)}px` : `${chWidth}ch`;
        };
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
            hideEls.forEach(el => { el.style.visibility = ''; });
        }
        function onKey(e) {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { e.preventDefault(); cleanup(); }
            else if (e.key === 'Tab' && opts.onTab) { e.preventDefault(); commit(); opts.onTab(); }
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
            if (key === 'cut' || key === 'timer') btn.classList.add('cut-btn');
            if (key === 'timer') btn.classList.add('timer-btn');
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
    // Also stashed so the Delete/Backspace key can trigger the exact same
    // action without needing to click the small floating button itself.
    let currentDeleteAction = null;
    function showDeleteButton(clientX, clientY, onClick) {
        currentDeleteAction = onClick;
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
        if (key === 'delete') currentDeleteAction = null;
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

    // Delete/Backspace deletes whatever is currently selected -- same
    // action as clicking its own floating delete button, just without
    // needing to aim for the small "x". Ignored while an inline-edit input
    // (or any other text field) is focused, so Backspace still just edits
    // text as normal there instead of deleting the whole selected element.
    document.addEventListener('keydown', e => {
        if (e.key !== 'Delete' && e.key !== 'Backspace') return;
        if (!currentDeleteAction) return;
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
        e.preventDefault();
        currentDeleteAction();
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

        // Rows are uniform discrete bands -- which one contains a given
        // absolute SVG y (clamped to the first/last row).
        function nearestColumnIndex(absoluteY) {
            const idx = Math.floor((absoluteY - R.LAYOUT.topMargin) / R.rowH(model));
            return Math.max(0, Math.min(idx, model.timeSteps.length - 1));
        }

        function stopDrag() {
            document.removeEventListener('mousemove', onDragMove);
            document.removeEventListener('mouseup', onDragEnd);
            drag = null;
            draggingLineId = null;
        }

        // Reorders a column toward the discrete step row nearest a given
        // absolute y, one neighbour-swap per call (mousemove fires often
        // enough for this to track the cursor). Time is discrete now -- a
        // column's y is purely its array index, so "repositioning" is just
        // reordering; there is no continuous x to store. Operates on an
        // index, returning the (possibly new) one.
        function repositionColumn(idx, absoluteY) {
            const target = nearestColumnIndex(absoluteY);
            if (target < idx) { M.swapTimeSteps(model, idx, idx - 1); return idx - 1; }
            if (target > idx) { M.swapTimeSteps(model, idx, idx + 1); return idx + 1; }
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

        // Finds the `split` step (and its new ingredient's entry) which gave
        // birth to a given line id.
        function findSplitOutput(lineId) {
            for (const ts of model.timeSteps) {
                for (const s of (ts.steps || [])) {
                    if (s.type === 'split' && s.output && s.output.lineId === lineId) return { step: s, output: s.output };
                }
            }
            return null;
        }

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
            // Dropping inside an existing row's band shares that row; the
            // upper/lower quarter of a row band instead inserts a new row
            // just above/below it, so a new row can still be created even
            // though rows are flush with no gaps between them.
            const rh = R.rowH(model);
            const rel = (absoluteY - R.LAYOUT.topMargin) / rh;
            const row = Math.floor(rel);
            const frac = rel - row;
            const clamped = Math.max(minCol, Math.min(row, maxCol));
            if (row >= minCol && row <= maxCol && frac >= 0.25 && frac <= 0.75) {
                M.addStepAt(model, clamped, step);
                return clamped;
            }
            const insertIndex = Math.max(minCol, Math.min(frac < 0.5 ? row : row + 1, maxCol + 1));
            M.insertStepColumn(model, insertIndex, step);
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
            const newTs = M.insertColumnAt(model, col + 1, step);
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
        // An `add` step's label has no free text and no horizontal position
        // of its own -- the only thing you can do with it is move it in
        // TIME (vertical-only, reusing the same column-reposition mechanics
        // as every other vertical drag) or, with no real movement, select
        // it so it can be deleted.
        function startAddStepDrag(e, stepId) {
            e.preventDefault();
            e.stopPropagation();
            drag = { type: 'add-step', stepId, startClientX: e.clientX, startClientY: e.clientY, moved: false };
            document.addEventListener('mousemove', onDragMove);
            document.addEventListener('mouseup', onDragEnd);
        }
        function addStepDragMove(e) {
            if (!drag.moved) {
                const dist = Math.hypot(e.clientX - drag.startClientX, e.clientY - drag.startClientY);
                if (dist < 4) return;
                drag.moved = true;
                recordHistory();
                const found = findStep(drag.stepId);
                drag.col = found ? ensureOwnColumn(found.step) : -1;
            }
            timeStepDragMove(e);
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
                const node = svg.querySelector(`text[data-kind="line"][data-line-kind="ingredient"][data-part="name"][data-id="${CSS.escape(selected.id)}"]`);
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
                const labelNode = svg.querySelector(`text[data-kind="utensil"][data-id="${CSS.escape(selected.id)}"]`);
                const pos = labelNode
                    ? svgToClient(svg, parseFloat(labelNode.getAttribute('x')), parseFloat(labelNode.getAttribute('y')))
                    : svgToClient(svg, R.laneX(u.x) + 6, R.LAYOUT.utensilLabelBandTop + R.LAYOUT.utensilLabelBandHeight / 2 + 4);
                showColorSwatch(pos.x - 16, pos.y, u.color, v => { u.color = v; refresh(); renderSelectionUi(); }, recordHistory);
                showDeleteButton(pos.x - 16, pos.y - 20, () => { recordHistory(); M.removeUtensil(model, u.id); deselect(); refresh(); });
            } else if (selected.kind === 'process') {
                const p = model.processes.find(x => x.id === selected.id);
                const u = p && model.utensils.find(x => x.id === p.utensilId);
                if (!p || !u) { selected = null; return; }
                const processNode = svg.querySelector(`rect[data-kind="process"][data-id="${CSS.escape(selected.id)}"]`);
                if (processNode) processNode.classList.add('is-selected');
                const pos = svgToClient(svg, R.laneX(u.x) + 6, R.rowY(model, p.startTimeStepIndex));
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
            } else if (selected.kind === 'row') {
                // A whole step row: deleting it closes the gap below it.
                const rowId = selected.id;
                const idx = model.timeSteps.findIndex(t => t.id === rowId);
                const cell = svg.querySelector(`rect[data-kind="step-number"][data-id="${CSS.escape(rowId)}"]`);
                if (idx < 0 || !cell) { selected = null; return; }
                cell.classList.add('is-selected');
                const pos = svgToClient(svg, R.LAYOUT.headerX + R.LAYOUT.stepNumberWidth + 14, R.rowY(model, idx));
                showDeleteButton(pos.x, pos.y, () => { recordHistory(); M.deleteRow(model, rowId); deselect(); refresh(); });
            } else if (selected.kind === 'addstep') {
                const found = findStep(selected.id);
                const node = svg.querySelector(`text[data-kind="add-step"][data-id="${CSS.escape(selected.id)}"]`);
                if (!found || !node) { selected = null; return; }
                const pos = svgToClient(svg, parseFloat(node.getAttribute('x')), parseFloat(node.getAttribute('y')));
                showDeleteButton(pos.x, pos.y - 20, () => { recordHistory(); M.removeStepById(model, found.step.id); deselect(); refresh(); });
            } else if (selected.kind === 'splitoutput') {
                const found = findSplitOutput(selected.id);
                const node = svg.querySelector(`text[data-kind="line"][data-line-kind="split"][data-id="${CSS.escape(selected.id)}"]`);
                if (!found || !node) { selected = null; return; }
                const { step, output } = found;
                const pathNode = svg.querySelector(`path[data-kind="line"][data-id="${CSS.escape(selected.id)}"]`);
                if (pathNode) pathNode.classList.add('is-selected');
                const pos = svgToClient(svg, parseFloat(node.getAttribute('x')), parseFloat(node.getAttribute('y')));
                showColorSwatch(pos.x - 10, pos.y - 16, output.color, v => { output.color = v; refresh(); renderSelectionUi(); }, recordHistory);
                showThicknessAdjuster(pos.x + 10, pos.y - 16, e2 => {
                    e2.preventDefault(); e2.stopPropagation();
                    recordHistory();
                    drag = { type: 'thickness', startY: e2.clientY, startVal: output.thickness, onChange: v => { output.thickness = v; refresh(); renderSelectionUi(); } };
                    document.addEventListener('mousemove', onDragMove);
                    document.addEventListener('mouseup', onDragEnd);
                });
                showDeleteButton(pos.x, pos.y - 32, () => { recordHistory(); M.removeStepById(model, step.id); deselect(); refresh(); });
            }
        }

        // Combines a text node's own (reliable) horizontal span with a
        // pill rect's (reliable) vertical span into one rect for
        // `editTextInPlace` -- an SVG `<text>`'s own `getBoundingClientRect()`
        // height can collapse to near-zero in this renderer, so never used
        // directly for the input's height.
        function measureInlineRect(textNode, pillNode) {
            if (!textNode) return null;
            const textRect = textNode.getBoundingClientRect();
            const pillRect = pillNode ? pillNode.getBoundingClientRect() : textRect;
            return { left: textRect.left, top: pillRect.top, width: Math.max(textRect.width, 10), height: pillRect.height };
        }

        // Quantity and name are two separately clickable/editable parts
        // sharing one pill background (see renderer.js) -- each edit
        // targets just its own field, no more combined "Name (Qty)"
        // parsing. Only the specific text being edited is hidden (not the
        // shared pill, which stays put so the OTHER field keeps showing
        // normally alongside it) and the input itself is transparent, so
        // the cursor reads as landing directly inside the existing label.
        function editIngredientName(ing, clientX, clientY) {
            let pos = { x: clientX, y: clientY };
            const node = svg.querySelector(`text[data-kind="line"][data-line-kind="ingredient"][data-part="name"][data-id="${CSS.escape(ing.id)}"]`);
            const pillNode = svg.querySelector(`rect[data-kind="line-pill"][data-id="${CSS.escape(ing.id)}"]`);
            if (node) pos = svgToClient(svg, parseFloat(node.getAttribute('x')), parseFloat(node.getAttribute('y')));
            editTextInPlace(pos.x, pos.y, ing.name, val => { ing.name = val.trim(); refresh(); },
                () => { M.removeIngredient(model, ing.id); refresh(); },
                { anchor: 'middle', sourceEl: node, transparent: true, color: R.readableTextColor(ing.color), hideEls: [node], rect: measureInlineRect(node, pillNode), placeholder: 'ingredient name' });
        }
        function editIngredientQuantity(ing, clientX, clientY) {
            let pos = { x: clientX, y: clientY };
            const node = svg.querySelector(`text[data-kind="line"][data-line-kind="ingredient"][data-part="quantity"][data-id="${CSS.escape(ing.id)}"]`);
            const pillNode = svg.querySelector(`rect[data-kind="line-pill"][data-id="${CSS.escape(ing.id)}"]`);
            if (node) pos = svgToClient(svg, parseFloat(node.getAttribute('x')), parseFloat(node.getAttribute('y')));
            editTextInPlace(pos.x, pos.y, ing.quantity || '', val => { ing.quantity = val.trim(); refresh(); },
                null, {
                    anchor: 'middle', sourceEl: node, transparent: true, color: R.readableTextColor(ing.color),
                    hideEls: [node], rect: measureInlineRect(node, pillNode), placeholder: 'QTY',
                    onTab: () => editIngredientName(ing, clientX, clientY)
                });
        }

        function editMergeOutputName(lineId, clientX, clientY) {
            const idx = model.timeSteps.findIndex(ts => (ts.steps || []).some(s => s.type === 'merge' && s.outputLineId === lineId));
            if (idx < 0) return;
            const step = model.timeSteps[idx].steps.find(s => s.type === 'merge' && s.outputLineId === lineId);
            let pos = { x: clientX, y: clientY };
            const node = svg.querySelector(`text[data-kind="line"][data-line-kind="merge"][data-id="${CSS.escape(lineId)}"]`);
            const pillNode = svg.querySelector(`rect[data-kind="line-pill"][data-id="${CSS.escape(lineId)}"]`);
            if (node) pos = svgToClient(svg, parseFloat(node.getAttribute('x')), parseFloat(node.getAttribute('y')));
            editTextInPlace(pos.x, pos.y, step.outputName || '', val => { step.outputName = val.trim(); refresh(); },
                () => { M.removeStepById(model, step.id); refresh(); },
                { anchor: 'middle', sourceEl: node, bg: step.outputColor, color: R.readableTextColor(step.outputColor), hideEls: [pillNode, node], rect: measureInlineRect(node, pillNode) });
        }

        // A split output's own name (dblclick) -- deleting it drops the
        // WHOLE split (same as a merge), not just this one part.
        function editSplitOutputName(lineId, clientX, clientY) {
            const found = findSplitOutput(lineId);
            if (!found) return;
            const { step, output } = found;
            let pos = { x: clientX, y: clientY };
            const node = svg.querySelector(`text[data-kind="line"][data-line-kind="split"][data-id="${CSS.escape(lineId)}"]`);
            const pillNode = svg.querySelector(`rect[data-kind="line-pill"][data-id="${CSS.escape(lineId)}"]`);
            if (node) pos = svgToClient(svg, parseFloat(node.getAttribute('x')), parseFloat(node.getAttribute('y')));
            editTextInPlace(pos.x, pos.y, output.name || '', val => { output.name = val.trim(); refresh(); },
                () => { M.removeStepById(model, step.id); refresh(); },
                { anchor: 'middle', sourceEl: node, bg: output.color, color: R.readableTextColor(output.color), hideEls: [pillNode, node], rect: measureInlineRect(node, pillNode) });
        }

        // Editing an existing label/move step (dblclick its text on the line).
        function editStepText(stepId, clientX, clientY) {
            const found = findStep(stepId);
            if (!found) return;
            const { step, col } = found;
            const line = lines.get(step.lineId);
            let pos = { x: clientX, y: clientY };
            const entry = layouts[col] && layouts[col][step.lineId];
            if (entry) pos = svgToClient(svg, R.laneX(entry.x), R.rowY(model, col) + 4);
            const node = svg.querySelector(`text[data-kind="step"][data-id="${CSS.escape(stepId)}"]`);
            const pillNode = svg.querySelector(`rect[data-kind="step-pill"][data-id="${CSS.escape(stepId)}"]`);
            editTextInPlace(pos.x, pos.y, step.text || '', val => { step.text = val.trim(); refresh(); },
                () => { M.removeStepById(model, step.id); refresh(); },
                { anchor: 'middle', sourceEl: node, bg: line && line.color, color: line && R.readableTextColor(line.color), hideEls: [pillNode, node], rect: measureInlineRect(node, pillNode) });
        }

        // ---------- timers: a bold duration field to the left of a step's
        // label. Hover a label to get the timer button; dblclick the field to
        // edit it (empty removes it). ----------
        function editTimer(stepId, clientX, clientY) {
            const found = findStep(stepId);
            if (!found) return;
            const { step } = found;
            const sel = CSS.escape(stepId);
            const node = svg.querySelector(`text[data-kind="step-timer"][data-id="${sel}"]`);
            const pillNode = svg.querySelector(`rect[data-timer-step="${sel}"]`);
            const commit = val => {
                const secs = M.parseDuration(val);
                if (secs > 0) step.timer = secs; else delete step.timer;
                refresh();
            };
            if (node) {
                editTextInPlace(clientX, clientY, M.formatDuration(step.timer), commit, null, {
                    anchor: 'middle', sourceEl: node, transparent: true, color: node.style.fill,
                    hideEls: [node], rect: measureInlineRect(node, pillNode), placeholder: 'e.g. 15m'
                });
            } else {
                editTextInPlace(clientX, clientY, '', commit, null, { anchor: 'middle', placeholder: 'e.g. 15m', fontSize: '12px' });
            }
        }
        function timerStepForNode(node) {
            const kind = node.getAttribute('data-kind'), id = node.getAttribute('data-id');
            if (kind === 'step' || kind === 'add-step') { const f = findStep(id); return f && f.step; }
            for (const ts of model.timeSteps) {
                for (const s of (ts.steps || [])) {
                    if (kind === 'process-label' && s.type === 'process-start' && s.processId === id) return s;
                    if (kind === 'line' && node.getAttribute('data-line-kind') === 'merge' && s.type === 'merge' && s.outputLineId === id) return s;
                    if (kind === 'line' && node.getAttribute('data-line-kind') === 'split' && s.type === 'split' && s.output && s.output.lineId === id) return s;
                }
            }
            return null;
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

            const typeSel = mkEl('select', {}, ['label', 'merge', 'split'].map(t => mkEl('option', { value: t, text: t })));
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
                } else if (typeSel.value === 'split') {
                    // Peels ONE new ingredient off this line, which carries on
                    // unmoved (just thinner) -- the reverse of an `add`.
                    const nameInp = mkEl('input', { type: 'text', placeholder: 'e.g. reserved juice' });
                    body.appendChild(fieldRow('New ingredient', nameInp));
                    body.appendChild(addBtn('Add Step', () => {
                        const name = nameInp.value.trim();
                        if (!name) { alert('Enter a name for the new ingredient.'); return; }
                        recordHistory();
                        const source = lines.get(lineId);
                        const entry = layouts[col] && layouts[col][lineId];
                        const srcX = entry ? entry.x : 0;
                        const curT = entry ? entry.thickness : (source ? source.thickness : 10);
                        const outT = Math.max(1, Math.round(curT / 2));
                        const newT = Math.max(1, curT - outT);
                        // Rests a little way to the right of the line; drag its
                        // name sideways afterwards to put it anywhere.
                        const x = Math.max(0, srcX + newT / 2 + outT / 2 + 24);
                        placeStep(col, col + 1, R.LAYOUT.topMargin + columnX, {
                            id: M.genId('step'), type: 'split', sourceLineId: lineId,
                            output: { lineId: M.genId('line'), name, color: source ? source.color : '#888888', thickness: outT, x },
                            newThickness: newT
                        });
                        closePopover(); refresh();
                    }));
                    setTimeout(() => nameInp.focus(), 0);
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

        // Clicking over a utensil adds a process there, the way clicking over
        // an ingredient adds a step: the new process gets its OWN start row,
        // inserted before the clicked row (or after it if you clicked its
        // lower half), and spans a couple of rows below it.
        function addProcessOnUtensil(utensilId, clientX, clientY) {
            const u = model.utensils.find(x => x.id === utensilId);
            if (!u) return;
            const pt = toSvgPoint(svg, clientX, clientY);
            const rel = (pt.y - R.LAYOUT.topMargin) / R.rowH(model);
            if (rel < 0) return;
            const row = Math.floor(rel);
            const at = Math.max(0, Math.min(rel - row >= 0.5 ? row + 1 : row, model.timeSteps.length));
            recordHistory();
            const p = M.addProcess(model, { utensilId, startTimeStepIndex: at });
            refresh();
            editProcessLabel(p.id, clientX, clientY);
        }

        // A process label is one line, edited in place and styled like any step label.
        function editProcessLabel(id, clientX, clientY) {
            const p = model.processes.find(x => x.id === id);
            if (!p) return;
            let pos = { x: clientX, y: clientY };
            const node = svg.querySelector(`text[data-kind="process-label"][data-id="${CSS.escape(id)}"]`);
            const pillNode = svg.querySelector(`rect[data-kind="process-label-pill"][data-id="${CSS.escape(id)}"]`);
            if (node) pos = svgToClient(svg, parseFloat(node.getAttribute('x')), parseFloat(node.getAttribute('y')));
            editTextInPlace(pos.x, pos.y, p.label || '', val => { p.label = val.trim(); refresh(); }, null, {
                anchor: 'middle', sourceEl: node, bg: p.color, color: R.readableTextColor(p.color),
                hideEls: [pillNode, node], rect: measureInlineRect(node, pillNode), placeholder: 'process'
            });
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
            drag.col = repositionColumn(drag.col, pt.y);
            refresh();
        }

        // Dragging a left-gutter step number reorders that whole column
        // among the discrete rows (the number itself represents the column,
        // not any single step within it).
        function startColumnReorder(e, tsId) {
            e.preventDefault();
            e.stopPropagation();
            const col = model.timeSteps.findIndex(t => t.id === tsId);
            if (col < 0) return;
            drag = { type: 'col-reorder', col, tsId, moved: false };
            document.addEventListener('mousemove', onDragMove);
            document.addEventListener('mouseup', onDragEnd);
        }
        function columnReorderMove(e) {
            if (!drag.moved) { recordHistory(); drag.moved = true; }
            timeStepDragMove(e);
        }

        function editUtensil(id, clientX, clientY) {
            const u = model.utensils.find(x => x.id === id);
            if (!u) return;
            const node = svg.querySelector(`text[data-kind="utensil"][data-id="${CSS.escape(id)}"]`);
            let pos = { x: clientX, y: clientY };
            if (node) pos = svgToClient(svg, parseFloat(node.getAttribute('x')), parseFloat(node.getAttribute('y')));
            editTextInPlace(pos.x, pos.y, u.name, val => { u.name = val.trim(); refresh(); }, () => { M.removeUtensil(model, id); refresh(); }, { anchor: 'start', sourceEl: node });
        }

        // ---------- utensils are permanent fixtures: drag the body sideways
        // to reposition sideways, grab a left/right edge to
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
        function startUtensilDrag(e, id, fromBody) {
            e.preventDefault();
            e.stopPropagation();
            const u = model.utensils.find(x => x.id === id);
            if (!u) return;
            const pt = toSvgPoint(svg, e.clientX, e.clientY);
            drag = {
                type: 'utensil', id, fromBody: !!fromBody, startSvgX: pt.x, startX: u.x, attachments: thingsOnUtensil(u),
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

        // ---------- processes: the start is a real step row, so dragging the
        // body or the label moves that row (the length in rows is kept); the
        // bottom edge resizes in whole rows. A plain click selects it (color,
        // opacity, delete); dblclick the label to rename. ----------
        function startProcessDrag(e, id) {
            e.preventDefault();
            e.stopPropagation();
            const p = model.processes.find(x => x.id === id);
            if (!p) return;
            drag = {
                type: 'process-shift', id, span: p.endTimeStepIndex - p.startTimeStepIndex,
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
            // One swap per move event; swapTimeSteps carries p.startTimeStepIndex along.
            repositionColumn(p.startTimeStepIndex, pt.y);
            p.endTimeStepIndex = Math.min(model.timeSteps.length - 1, p.startTimeStepIndex + drag.span);
            refresh();
        }
        function startProcessResize(e, id) {
            e.preventDefault();
            e.stopPropagation();
            const p = model.processes.find(x => x.id === id);
            if (!p) return;
            recordHistory();
            drag = { type: 'process-resize', id };
            document.addEventListener('mousemove', onDragMove);
            document.addEventListener('mouseup', onDragEnd);
        }
        function processResizeMove(e) {
            const p = model.processes.find(x => x.id === drag.id);
            if (!p) return;
            const pt = toSvgPoint(svg, e.clientX, e.clientY);
            p.endTimeStepIndex = Math.max(p.startTimeStepIndex, nearestColumnIndex(pt.y));
            refresh();
        }

        // ---------- click empty space in the utensil section to place a new
        // utensil fixture there ----------
        function addUtensilAtClick(e) {
            recordHistory();
            const pt = toSvgPoint(svg, e.clientX, e.clientY);
            const width = 70;
            const u = M.addUtensil(model, { x: Math.max(0, pt.x - R.LAYOUT.leftMargin - width / 2), width });
            refresh();
            editUtensil(u.id, e.clientX, e.clientY);
        }

        // ---------- click empty space in the ingredient band to create a
        // new ingredient right there / add time step ----------
        function addIngredientAtClick(e) {
            recordHistory();
            const pt = toSvgPoint(svg, e.clientX, e.clientY);
            const ing = M.addIngredient(model, Math.max(0, pt.x - R.LAYOUT.leftMargin));
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
            else if (drag.type === 'add-step') addStepDragMove(e);
            else if (drag.type === 'col-reorder') columnReorderMove(e);
            else if (drag.type === 'ingredient-pos') ingredientLabelDragMove(e);
            else if (drag.type === 'merge-pos') mergeLabelDragMove(e);
            else if (drag.type === 'split-pos') splitOutputDragMove(e);
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
            else if (drag && drag.type === 'add-step' && !drag.moved) selectItem('addstep', drag.stepId);
            else if (drag && drag.type === 'ingredient-pos' && !drag.moved) selectItem('ingredient', drag.id);
            else if (drag && drag.type === 'merge-pos' && !drag.axis) {
                const found = findStep(drag.stepId);
                if (found) selectItem('merge', found.step.outputLineId);
            }
            else if (drag && drag.type === 'split-pos' && !drag.axis) selectItem('splitoutput', drag.lineId);
            else if (drag && drag.type === 'col-reorder' && !drag.moved) selectItem('row', drag.tsId);
            else if (drag && drag.type === 'utensil' && !drag.moved) {
                if (drag.fromBody) addProcessOnUtensil(drag.id, e.clientX, e.clientY);
                else selectItem('utensil', drag.id);
            }
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

        // ---------- drag a split output's name tag -- sideways mutates its
        // OWN stored `x` directly (same idea as a merge's outputX), vertical
        // moves the whole split step in time ----------
        function startSplitOutputDrag(e, lineId) {
            e.preventDefault();
            e.stopPropagation();
            const found = findSplitOutput(lineId);
            if (!found) return;
            const pt = toSvgPoint(svg, e.clientX, e.clientY);
            drag = {
                type: 'split-pos', lineId, startSvgX: pt.x, startX: found.output.x || 0,
                startClientX: e.clientX, startClientY: e.clientY, axis: null
            };
            document.addEventListener('mousemove', onDragMove);
            document.addEventListener('mouseup', onDragEnd);
        }
        function splitOutputDragMove(e) {
            const found = findSplitOutput(drag.lineId);
            if (!found) return;
            const { step, output } = found;
            if (!drag.axis) {
                const dx = e.clientX - drag.startClientX, dy = e.clientY - drag.startClientY;
                if (Math.hypot(dx, dy) < 4) return;
                drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
                recordHistory();
                if (drag.axis === 'x') draggingLineId = drag.lineId;
                else drag.col = ensureOwnColumn(step);
            }
            if (drag.axis === 'y') { timeStepDragMove(e); return; }
            const pt = toSvgPoint(svg, e.clientX, e.clientY);
            output.x = Math.max(0, drag.startX + (pt.x - drag.startSvgX));
            refresh();
        }

        // ---------- attach listeners to the freshly-rendered SVG ----------
        // A line's name tag: drag EITHER its quantity or name pill sideways
        // to change the ingredient's own starting position directly (no
        // step inserted -- there's nothing before it to move away from);
        // dblclick edits whichever pill was clicked (quantity vs name) on
        // its own; a plain click (no real movement) selects it, revealing
        // its color swatch + thickness scrubber + delete button (see
        // renderSelectionUi above).
        svg.querySelectorAll('text[data-kind="line"][data-line-kind="ingredient"]').forEach(node => {
            const lineId = node.getAttribute('data-id');
            const ing = model.ingredients.find(i => i.id === lineId);
            if (!ing) return;
            node.addEventListener('mousedown', e => startIngredientLabelDrag(e, ing));
            node.addEventListener('dblclick', e => {
                e.stopPropagation();
                if (node.getAttribute('data-part') === 'quantity') editIngredientQuantity(ing, e.clientX, e.clientY);
                else editIngredientName(ing, e.clientX, e.clientY);
            });
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
        // A split output's name tag: drag sideways to reposition it (its
        // own stored `x`, same idea as a merge's `outputX`), vertically to
        // move the whole split to a different point in time; a plain click
        // (no movement) selects it (color/thickness/delete-whole-split).
        svg.querySelectorAll('text[data-kind="line"][data-line-kind="split"]').forEach(node => {
            const lineId = node.getAttribute('data-id');
            if (!findSplitOutput(lineId)) return;
            node.addEventListener('mousedown', e => startSplitOutputDrag(e, lineId));
            node.addEventListener('dblclick', e => { e.stopPropagation(); editSplitOutputName(lineId, e.clientX, e.clientY); });
        });
        svg.querySelectorAll('[data-kind="add-timestep"]').forEach(node => {
            node.addEventListener('click', addTimeStepAction);
        });
        svg.querySelectorAll('[data-kind="step-number"]').forEach(node => {
            node.addEventListener('mousedown', e => startColumnReorder(e, node.getAttribute('data-id')));
        });
        svg.querySelectorAll('[data-kind="ingredient-create-band"]').forEach(node => {
            node.addEventListener('click', addIngredientAtClick);
        });
        svg.querySelectorAll('[data-kind="utensil-create-band"]').forEach(node => {
            node.addEventListener('click', addUtensilAtClick);
        });
        // A utensil: drag it sideways to reposition, dblclick to rename. Its
        // name (in the utensil section) selects it on click (color + delete);
        // clicking its body adds a process there.
        svg.querySelectorAll('[data-kind="utensil"]').forEach(node => {
            const fromBody = node.tagName.toLowerCase() === 'rect';
            node.addEventListener('mousedown', e => startUtensilDrag(e, node.getAttribute('data-id'), fromBody));
            node.addEventListener('dblclick', e => { e.stopPropagation(); editUtensil(node.getAttribute('data-id'), e.clientX, e.clientY); });
        });
        svg.querySelectorAll('[data-kind="utensil-edge"]').forEach(node => {
            node.addEventListener('mousedown', e => startUtensilResize(e, node.getAttribute('data-id'), node.getAttribute('data-edge')));
        });
        svg.querySelectorAll('[data-kind="step"]').forEach(node => {
            node.addEventListener('mousedown', e => startStepDrag(e, node.getAttribute('data-id')));
            node.addEventListener('dblclick', e => { e.stopPropagation(); editStepText(node.getAttribute('data-id'), e.clientX, e.clientY); });
        });
        // An `add` step's label/pill -- vertical-only reposition drag, click
        // (no movement) selects it for deletion; no free text to edit.
        svg.querySelectorAll('[data-kind="add-step"]').forEach(node => {
            node.addEventListener('mousedown', e => startAddStepDrag(e, node.getAttribute('data-id')));
        });
        // A process: drag its body or label to move its start row, grab the
        // bottom edge to change its length; click selects, dblclick the label renames.
        svg.querySelectorAll('[data-kind="process"]').forEach(node => {
            node.addEventListener('mousedown', e => startProcessDrag(e, node.getAttribute('data-id')));
        });
        svg.querySelectorAll('[data-kind="process-label"]').forEach(node => {
            node.addEventListener('mousedown', e => startProcessDrag(e, node.getAttribute('data-id')));
            node.addEventListener('dblclick', e => { e.stopPropagation(); editProcessLabel(node.getAttribute('data-id'), e.clientX, e.clientY); });
        });
        svg.querySelectorAll('[data-kind="process-edge"]').forEach(node => {
            node.addEventListener('mousedown', e => startProcessResize(e, node.getAttribute('data-id')));
        });
        // Timer field: dblclick edits it.
        svg.querySelectorAll('[data-kind="step-timer"]').forEach(node => {
            node.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
            node.addEventListener('dblclick', e => { e.stopPropagation(); editTimer(node.getAttribute('data-id'), e.clientX, e.clientY); });
        });
        // Hovering any step label without a timer offers a small timer button
        // just left of it.
        svg.querySelectorAll('[data-kind="step"], [data-kind="add-step"], [data-kind="process-label"], text[data-kind="line"][data-line-kind="merge"], text[data-kind="line"][data-line-kind="split"]').forEach(node => {
            node.addEventListener('mousemove', e => {
                if (drag) return;
                const step = timerStepForNode(node);
                if (!step || step.timer > 0) return;
                const pill = svg.querySelector(`rect.pill-label-bg[data-id="${CSS.escape(node.getAttribute('data-id'))}"]`);
                if (!pill) return;
                const r = pill.getBoundingClientRect();
                const y = r.top + r.height / 2;
                showHoverButton('timer', r.left - 14, y, '\u23F1', () => { hideHoverButton('timer'); editTimer(step.id, r.left - 14, y); });
                registerHoverOrigin('timer', e.clientX, e.clientY);
            });
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
                const keys = R.buildLineGeometry(model, line, layouts);
                if (keys.length < 2) return null;
                const clampedY = Math.min(Math.max(pt.y, keys[0].y), keys[keys.length - 1].y);
                // The step row the pointer is over, within the line's own life.
                const col = Math.max(line.birth, Math.min(nearestColumnIndex(clampedY), line.death));
                const x = R.laneX(R.lineXAtY(keys, clampedY));
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
                const isMergingAway = hit.col === line.death && !!deathStep;
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
        // A plain click on empty background deselects whatever's selected
        // (every other element's own mousedown handler already stops
        // propagation, so this only ever fires for genuinely empty space --
        // utensil/ingredient creation now live in their own dedicated bands
        // above, not a dblclick on the background itself).
        svg.addEventListener('mousedown', () => deselect());

        // Cook mode re-applies its row focus after every re-render.
        if (typeof svg._vepAfterRender === 'function') svg._vepAfterRender();

        renderSelectionUi();
    }

    global.VEP = global.VEP || {};
    global.VEP.interact = { bindAll, closePopover };
})(window);
