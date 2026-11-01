// Data model and schema helpers.
(function (global) {
    'use strict';

    const SCHEMA_VERSION = 9;

    // Height (px) of one discrete step row; stored per recipe as
    // `model.rowHeight` so the user's fine-tuning persists.
    const DEFAULT_ROW_HEIGHT = 20;

    function genId(prefix) {
        const rand = (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID().slice(0, 8)
            : Math.random().toString(36).slice(2, 10);
        return `${prefix}-${rand}`;
    }

    // The lane axis is a plain 1-D line across the page. Utensils are
    // permanent fixtures with an `x`/`width` on it (no time range of their
    // own); ingredients have a definite `x` on the same line, moved by
    // dragging.

    // A time step is one discrete row (its y is just its array index). A
    // column holds a `.steps` ARRAY -- several unrelated things (different
    // lines' moves/labels/merges) can share one row, as in a real kitchen.
    function createEmptyRecipe() {
        return {
            version: SCHEMA_VERSION,
            title: 'Untitled Recipe',
            rowHeight: DEFAULT_ROW_HEIGHT,
            timeSteps: [
                { id: genId('t'), label: '', steps: [] },
                { id: genId('t'), label: '', steps: [] }
            ],
            ingredients: [],
            utensils: [],
            processes: []
        };
    }


    // "15", "15m", "1h 30m", "90s", "1:30", "1:30:00" -> seconds (0 = invalid/empty).
    // A bare number means minutes.
    function parseDuration(str) {
        const s = String(str == null ? '' : str).trim().toLowerCase();
        if (!s) return 0;
        if (/^\d+(?::\d+){1,2}$/.test(s)) {
            const p = s.split(':').map(Number);
            return p.length === 2 ? p[0] * 60 + p[1] : p[0] * 3600 + p[1] * 60 + p[2];
        }
        if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 60);
        const re = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|mins?|minutes?|s|secs?|seconds?)\b/g;
        let total = 0, any = false, m;
        while ((m = re.exec(s))) {
            any = true;
            const v = parseFloat(m[1]), u = m[2][0];
            total += u === 'h' ? v * 3600 : u === 'm' ? v * 60 : v;
        }
        return any ? Math.round(total) : 0;
    }
    function formatDuration(sec) {
        sec = Math.max(0, Math.ceil(sec));
        const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
        const pad = n => String(n).padStart(2, '0');
        return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    }

    function isValidRecipe(doc) {
        return !!doc && typeof doc === 'object' && Array.isArray(doc.timeSteps) && Array.isArray(doc.ingredients)
            && Array.isArray(doc.utensils) && Array.isArray(doc.processes);
    }

    global.VEP = global.VEP || {};
    // ---------- shared mutation helpers (used by in-context canvas editing) ----------
    function addIngredient(model, x) {
        const maxX = model.ingredients.reduce((m, i) => Math.max(m, i.x || 0), 0);
        const ing = {
            id: genId('ing'), name: '', quantity: '',
            color: '#888888', thickness: 6, x: x != null ? x : maxX + 30, startTimeStepIndex: 0
        };
        model.ingredients.push(ing);
        return ing;
    }


    function removeIngredient(model, id) {
        model.ingredients = model.ingredients.filter(i => i.id !== id);
        model.timeSteps.forEach(ts => {
            ts.steps = (ts.steps || []).filter(s => {
                if ((s.type === 'label' || s.type === 'move') && s.lineId === id) return false;
                if (s.type === 'merge' && (s.inputLineIds.includes(id) || s.outputLineId === id)) return false;
                if (s.type === 'add' && (s.baseLineId === id || s.addedLineId === id)) return false;
                if (s.type === 'split' && (s.sourceLineId === id || s.output.lineId === id)) return false;
                return true;
            });
        });
    }

    function addTimeStep(model) {
        const newTs = { id: genId('t'), label: '', steps: [] };
        model.timeSteps.push(newTs);
        return newTs;
    }

    // Splices a brand new row in at `index` and shifts every later
    // process/ingredient reference along by one slot (utensils are
    // permanent fixtures with no time-based reference to shift).
    function insertColumnAt(model, index, step) {
        const newTs = { id: genId('t'), label: '', steps: step ? [step] : [] };
        model.timeSteps.splice(index, 0, newTs);
        const remap = i => (i >= index ? i + 1 : i);
        model.processes.forEach(p => { p.startTimeStepIndex = remap(p.startTimeStepIndex); p.endTimeStepIndex = remap(p.endTimeStepIndex); });
        model.ingredients.forEach(i => { if ((i.startTimeStepIndex || 0) >= index) i.startTimeStepIndex += 1; });
        return newTs;
    }

    // Which line ids a step permanently kills off at its own column (a
    // merge's inputs, or an add's absorbed line) -- null
    // if it doesn't kill anything (label/move/process boundaries just
    // reference a line without ending it).
    function deadLineIdsForStep(step) {
        if (!step) return null;
        if (step.type === 'merge') return step.inputLineIds;
        if (step.type === 'add') return [step.addedLineId];
        return null;
    }

    // A merge (or add) permanently ends the line(s) it kills at that column
    // -- any later step that still references one of them (a stale
    // move/label, or an old merge/add that used to consume it further
    // downstream) is now invalid and must be dropped, cascading to
    // whatever THAT merge went on to produce too (its output line never
    // comes into existence either). Only the offending step is dropped --
    // anything else still sharing that same column/moment is untouched.
    function invalidateFutureLineUses(model, afterIndex, lineIds) {
        const dead = new Set(lineIds);
        for (let i = afterIndex + 1; i < model.timeSteps.length; i++) {
            const ts = model.timeSteps[i];
            if (!ts.steps || !ts.steps.length) continue;
            ts.steps = ts.steps.filter(step => {
                if ((step.type === 'label' || step.type === 'move') && dead.has(step.lineId)) return false;
                if (step.type === 'merge' && step.inputLineIds.some(id => dead.has(id))) {
                    dead.add(step.outputLineId);
                    return false;
                }
                if (step.type === 'add' && (dead.has(step.baseLineId) || dead.has(step.addedLineId))) return false;
                if (step.type === 'split' && dead.has(step.sourceLineId)) {
                    dead.add(step.output.lineId);
                    return false;
                }
                return true;
            });
        }
    }

    // Attaches a step directly to an ALREADY-EXISTING column (sharing
    // whatever else -- if anything -- already happens at that same moment)
    // instead of giving it a dedicated new one. This is how two unrelated
    // lines' events end up genuinely simultaneous rather than being forced
    // apart into separate rows.
    function addStepAt(model, index, step) {
        const ts = model.timeSteps[index];
        if (!ts) return null;
        // A process start owns its row outright -- put this one on a new row below it.
        if ((ts.steps || []).some(s => s.type === 'process-start')) return insertStepColumn(model, index + 1, step);
        ts.steps = ts.steps || [];
        ts.steps.push(step);
        const deadIds = deadLineIdsForStep(step);
        if (deadIds) invalidateFutureLineUses(model, index, deadIds);
        return ts;
    }

    // Removes a single step (wherever it lives) without touching anything
    // else sharing that same column -- the column itself stays even if it
    // ends up empty (just a plain spacer again).
    function removeStepById(model, stepId) {
        for (let i = 0; i < model.timeSteps.length; i++) {
            const ts = model.timeSteps[i];
            if (!ts.steps) continue;
            const idx = ts.steps.findIndex(s => s.id === stepId);
            if (idx < 0) continue;
            const step = ts.steps[idx];
            ts.steps.splice(idx, 1);
            const deadIds = deadLineIdsForStep(step);
            if (deadIds) invalidateFutureLineUses(model, i, deadIds);
            return step;
        }
        return null;
    }

    // Inserts a brand new row holding `step` at `index`. Callers that want a
    // step to share an EXISTING row (so two unrelated lines' events can be
    // genuinely simultaneous) should use `addStepAt` instead.
    function insertStepColumn(model, index, step) {
        const newTs = insertColumnAt(model, index, step);
        const deadIds = deadLineIdsForStep(step);
        if (deadIds) invalidateFutureLineUses(model, index, deadIds);
        return newTs;
    }

    // Brings an older recipe (saved draft or file) up to the current schema
    // in place. Each stage is idempotent for data already at that version, so
    // this is safe to run on every load.
    //  v7: discrete rows -- drop per-column `.x`, strip process boundary
    //      columns and empty spacer rows, remap every stored row index.
    //  v8: a process start is a real step -- it gets its own dedicated row,
    //      and the old sublabel is folded into the single one-line label.
    function migrateRecipe(doc) {
        if (!doc) return doc;
        const v = doc.version || 0;
        if (v < 7) migrateToRows(doc);
        if (v < 8) migrateToProcessSteps(doc);
        if (v < 9) migrateToSingleSplit(doc);
        if (!doc.rowHeight) doc.rowHeight = DEFAULT_ROW_HEIGHT;
        doc.version = SCHEMA_VERSION;
        return doc;
    }

    //  v9: kitchen zones are gone (and utensils' `zoneId`); a split now peels
    //      ONE new ingredient off a line that carries on unmoved, so the old
    //      multi-output split becomes one single-output split per output.
    function migrateToSingleSplit(doc) {
        delete doc.zones;
        (doc.utensils || []).forEach(u => { delete u.zoneId; });
        (doc.timeSteps || []).forEach(ts => {
            const out = [];
            (ts.steps || []).forEach(s => {
                if (s.type !== 'split' || !Array.isArray(s.outputs)) { out.push(s); return; }
                s.outputs.forEach((o, i) => {
                    out.push({
                        id: i === 0 ? s.id : genId('step'), type: 'split', sourceLineId: s.sourceLineId,
                        output: { lineId: o.lineId, name: o.name, color: o.color, thickness: o.thickness, x: o.x },
                        newThickness: s.newThickness || null
                    });
                });
            });
            ts.steps = out;
        });
    }

    function migrateToRows(doc) {
        const cols = doc.timeSteps;
        const procStart = {}, procEnd = {};
        cols.forEach((ts, i) => (ts.steps || []).forEach(s => {
            if (s.type === 'process-start') procStart[s.processId] = i;
            if (s.type === 'process-end') procEnd[s.processId] = i;
        }));
        cols.forEach(ts => {
            ts.steps = (ts.steps || []).filter(s => s.type !== 'process-start' && s.type !== 'process-end');
        });
        const keep = cols.map(ts => ts.steps.length > 0);
        const newIndex = [];
        let n = 0;
        cols.forEach((ts, i) => { newIndex[i] = keep[i] ? n++ : -1; });
        const last = Math.max(0, n - 1);
        const nextKept = i => { for (let k = Math.max(i, 0); k < cols.length; k++) if (keep[k]) return k; return -1; };
        const priorKept = i => { for (let k = Math.min(i, cols.length - 1); k >= 0; k--) if (keep[k]) return k; return -1; };
        (doc.processes || []).forEach(p => {
            const os = procStart[p.id] != null ? procStart[p.id] : p.startTimeStepIndex;
            const oe = procEnd[p.id] != null ? procEnd[p.id] : p.endTimeStepIndex;
            let s = nextKept(os) >= 0 ? newIndex[nextKept(os)] : -1;
            if (s < 0) s = priorKept(os) >= 0 ? newIndex[priorKept(os)] : 0;
            let e = priorKept(oe) >= 0 ? newIndex[priorKept(oe)] : -1;
            if (e < 0) e = nextKept(oe) >= 0 ? newIndex[nextKept(oe)] : last;
            if (e <= s) e = Math.min(s + 1, last);
            p.startTimeStepIndex = s;
            p.endTimeStepIndex = e;
        });
        (doc.ingredients || []).forEach(ing => {
            const k = nextKept(ing.startTimeStepIndex || 0);
            ing.startTimeStepIndex = k >= 0 ? newIndex[k] : 0;
        });
        doc.timeSteps = cols.filter((ts, i) => keep[i]);
        if (!doc.timeSteps.length) doc.timeSteps = [{ id: genId('t'), label: '', steps: [] }];
        doc.timeSteps.forEach(ts => { delete ts.x; });
    }

    function migrateToProcessSteps(doc) {
        (doc.processes || []).forEach(p => {
            p.label = [p.label, p.sublabel].filter(Boolean).join(' ');
            delete p.sublabel;
            const has = doc.timeSteps.some(ts => (ts.steps || []).some(s => s.type === 'process-start' && s.processId === p.id));
            if (has) return;
            const idx = Math.max(0, Math.min(p.startTimeStepIndex || 0, doc.timeSteps.length));
            // insertColumnAt also shifts this process's own indices down a
            // row, so put its start back on the row it just created.
            insertColumnAt(doc, idx, { id: genId('step'), type: 'process-start', processId: p.id });
            p.startTimeStepIndex = idx;
        });
    }

    // Swaps two adjacent (or arbitrary) time-step rows and remaps every
    // process/ingredient reference to either index (the steps themselves
    // travel with their row object).
    function swapTimeSteps(model, a, b) {
        const ts = model.timeSteps;
        if (b < 0 || b >= ts.length || a === b) return;
        [ts[a], ts[b]] = [ts[b], ts[a]];
        const remap = idx => (idx === a ? b : idx === b ? a : idx);
        model.processes.forEach(p => { p.startTimeStepIndex = remap(p.startTimeStepIndex); p.endTimeStepIndex = remap(p.endTimeStepIndex); });
        model.ingredients.forEach(i => { i.startTimeStepIndex = remap(i.startTimeStepIndex || 0); });
        // A process never ends above its own start row.
        model.processes.forEach(p => { if (p.endTimeStepIndex < p.startTimeStepIndex) p.endTimeStepIndex = p.startTimeStepIndex; });
    }

    function deleteTimeStep(model, idx) {
        model.timeSteps.splice(idx, 1);
        const last = model.timeSteps.length - 1;
        const remap = i => Math.max(0, Math.min(i > idx ? i - 1 : i, last));
        model.processes.forEach(p => {
            p.startTimeStepIndex = remap(p.startTimeStepIndex);
            p.endTimeStepIndex = Math.max(p.startTimeStepIndex, remap(p.endTimeStepIndex >= idx ? p.endTimeStepIndex - 1 : p.endTimeStepIndex));
        });
        model.ingredients.forEach(i => { if (i.startTimeStepIndex > idx) i.startTimeStepIndex -= 1; });
    }

    // Deletes a whole step row: every step on it (a process start takes its
    // process with it), then the row itself, so later rows close the gap
    // instead of leaving an empty numbered row.
    function deleteRow(model, tsId) {
        const idx = model.timeSteps.findIndex(t => t.id === tsId);
        if (idx < 0) return;
        (model.timeSteps[idx].steps || []).slice().forEach(s => {
            if (s.type === 'process-start') removeProcess(model, s.processId);
            else removeStepById(model, s.id);
        });
        const j = model.timeSteps.findIndex(t => t.id === tsId);
        if (j >= 0) deleteTimeStep(model, j);
        if (!model.timeSteps.length) model.timeSteps.push({ id: genId('t'), label: '', steps: [] });
    }

    // Utensils are permanent fixtures -- no time range, just a fixed spot
    // (`x`/`width`) on the lane axis.
    function addUtensil(model, opts) {
        opts = opts || {};
        const u = {
            id: opts.id || genId('u'), name: opts.name || 'New Utensil', color: opts.color || '#999999',
            x: opts.x != null ? opts.x : 0, width: opts.width != null ? opts.width : 80
        };
        model.utensils.push(u);
        return u;
    }

    function removeUtensil(model, id) {
        model.utensils = model.utensils.filter(u => u.id !== id);
        model.processes.filter(p => p.utensilId === id).forEach(p => removeProcess(model, p.id));
    }

    // A process fills its utensil's full width. Its START is a real step: a
    // dedicated row of its own (holding the one-line label) that no other
    // step may share. Its END is just an index onto any later row, so its
    // length is measured in whole rows.
    function addProcess(model, opts) {
        opts = opts || {};
        const p = {
            id: opts.id || genId('p'), utensilId: opts.utensilId || null,
            label: opts.label || 'process',
            color: opts.color || '#ffcc66', opacity: opts.opacity != null ? opts.opacity : 0.35,
            startTimeStepIndex: 0, endTimeStepIndex: 0
        };
        const at = Math.max(0, Math.min(opts.startTimeStepIndex != null ? opts.startTimeStepIndex : model.timeSteps.length, model.timeSteps.length));
        insertColumnAt(model, at, { id: genId('step'), type: 'process-start', processId: p.id });
        p.startTimeStepIndex = at;
        p.endTimeStepIndex = Math.min(model.timeSteps.length - 1, at + (opts.span != null ? opts.span : 2));
        model.processes.push(p);
        return p;
    }

    // Removing a process also removes its start row (if nothing else lives
    // there) so no empty row is left behind.
    function removeProcess(model, id) {
        model.processes = model.processes.filter(p => p.id !== id);
        for (let i = 0; i < model.timeSteps.length; i++) {
            const ts = model.timeSteps[i];
            const k = (ts.steps || []).findIndex(s => s.type === 'process-start' && s.processId === id);
            if (k < 0) continue;
            ts.steps.splice(k, 1);
            if (!ts.steps.length) deleteTimeStep(model, i);
            break;
        }
    }

    global.VEP = global.VEP || {};
    global.VEP.model = {
        parseDuration, formatDuration,
        SCHEMA_VERSION, DEFAULT_ROW_HEIGHT, genId, createEmptyRecipe, isValidRecipe, migrateRecipe,
        addIngredient, removeIngredient,
        addTimeStep, insertColumnAt, insertStepColumn, addStepAt, removeStepById,
        swapTimeSteps, deleteTimeStep, deleteRow,
        addUtensil, removeUtensil, addProcess, removeProcess
    };
})(window);
