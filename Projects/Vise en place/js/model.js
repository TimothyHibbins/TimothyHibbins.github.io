// Data model, schema helpers, and the built-in example recipe.
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


    // The built-in example recipe is authored directly in the app (saved/
    // loaded as plain recipe JSON, see `example.vep.json` in this folder)
    // rather than constructed from helper calls -- embedded here verbatim
    // so "Load Example" doesn't depend on a separate fetch (the app must
    // keep working opened directly via `file://`). Returns a fresh deep
    // copy each time so repeated loads never share mutable state.
    const EXAMPLE_RECIPE = {"version":9,"title":"Thai Red Curry Duck V2","timeSteps":[{"id":"t-l72xrr2y","label":"","steps":[{"id":"step-h4r2w8s5","type":"move","lineId":"rice","newX":50,"text":"rinse"}]},{"id":"t-0yxnsh3j","label":"","steps":[{"id":"step-xd9i1zag","type":"move","lineId":"rice","newX":925,"text":"add to saucepan"}]},{"id":"t-v39o1zns","label":"","steps":[{"id":"step-i77hb0ih","type":"label","lineId":"pineapple","text":"drain, reserving 3tsp juice"}]},{"id":"t-cdf53b76","label":"","steps":[{"id":"step-03203b12","type":"process-start","processId":"p-uzyh0cl7"}]},{"id":"t-n2as7684","label":"","steps":[{"id":"step-89cadwh6","type":"label","lineId":"lemongrass","text":"trim end"}]},{"id":"t-2xqw61np","label":"","steps":[{"id":"step-0mcrarwh","type":"move","lineId":"pineapple","newX":1072.3629150390625,"text":"scatter"}]},{"id":"t-vftm89c0","label":"","steps":[{"id":"step-9ihp3bo2","type":"label","lineId":"lemongrass","text":"peel, chop coarsely"}]},{"id":"t-z7dufkv7","label":"","steps":[{"id":"step-16jhdt8q","type":"label","lineId":"garlic","text":"chop coarsely"}]},{"id":"t-njjz01so","label":"","steps":[{"id":"step-xtgvixoo","type":"label","lineId":"shallot","text":"chop coarsely"}]},{"id":"t-lza91pz3","label":"","steps":[{"id":"step-o23h30eq","type":"label","lineId":"coriander","text":"pick leaves"}]},{"id":"t-230b1604","label":"","steps":[{"id":"step-5a89f04d","type":"process-start","processId":"p-okkibr61"}]},{"id":"t-z9m8cyc7","label":"","steps":[{"id":"step-k66n718n","type":"label","lineId":"coriander","text":"chop coarsely"}]},{"id":"t-mjw4i288","label":"","steps":[{"id":"step-q72ziv8k","type":"merge","inputLineIds":["lemongrass","garlic","shallot","coriander","galangal","fishsauce"],"outputLineId":"paste","outputName":"paste","outputX":540.9580993652344,"outputColor":"#8a5a2a","outputThickness":27}]},{"id":"t-d0hmhmik","label":"","steps":[{"id":"step-nlgat2e4","type":"move","lineId":"duck","newX":1040,"text":"place"}]},{"id":"t-gqi9n6qt","label":"","steps":[{"id":"step-bnrtrj3l","type":"move","lineId":"paste","newX":795,"text":"add"}]},{"id":"t-6f203d6b","label":"","steps":[{"id":"step-e7c333c5","type":"process-start","processId":"p-aytnd83c"}]},{"id":"t-323ba587","label":"","steps":[{"id":"step-268f9673","type":"process-start","processId":"p-4dfhd997"}]},{"id":"t-kshbwoyv","label":"","steps":[{"id":"step-92l2a38c","type":"merge","inputLineIds":["paste","coconutmilk","cherrytomatoes"],"outputLineId":"curry","outputName":"curry sauce","outputX":795,"outputColor":"#d9822b","outputThickness":45}]},{"id":"t-d60f86b6","label":"","steps":[{"id":"step-38bec26f","type":"process-start","processId":"p-gq645qta"}]},{"id":"t-zcecxc77","label":"","steps":[{"id":"step-dj6eznw3","type":"label","lineId":"pakchoy","text":"quarter"}]},{"id":"t-vs0kb2d7","label":"","steps":[{"id":"step-sfrw009v","type":"add","baseLineId":"curry","addedLineId":"pakchoy","newThickness":51}]},{"id":"t-n2g9gm1h","label":"","steps":[{"id":"step-q50s2qx4","type":"move","lineId":"duck","newX":370.90521240234375,"text":"move"}]},{"id":"t-nwk643bk","label":"","steps":[{"id":"step-wgdp7sj9","type":"label","lineId":"duck","text":"shred"}]},{"id":"t-h2h96nf2","label":"","steps":[{"id":"step-jvsosxqh","type":"move","lineId":"pineapple","newX":841.707763671875,"text":"Move"}]},{"id":"t-qc1x4zt5","label":"","steps":[{"id":"step-qoxa6jr0","type":"label","lineId":"lime","text":"cut into wedges"}]},{"id":"t-r9flg9r6","label":"","steps":[{"id":"step-rqvxslmh","type":"add","baseLineId":"curry","addedLineId":"pineapple","newThickness":57}]},{"id":"t-caof2za2","label":"","steps":[{"id":"step-lekkevss","type":"add","baseLineId":"curry","addedLineId":"duck","newThickness":66}]},{"id":"t-3styp833","label":"","steps":[{"id":"step-6tqgjtbg","type":"move","lineId":"rice","newX":1244.106689453125,"text":"add"}]},{"id":"t-1wbva9qa","label":"","steps":[{"id":"step-nahit3rl","type":"move","lineId":"curry","newX":1203.866943359375,"text":"add"}]},{"id":"t-369tsub4","label":"","steps":[{"id":"step-6jcb5451","type":"move","lineId":"lime","newX":1160.4080810546875,"text":"add"}]}],"ingredients":[{"id":"rice","name":"jasmine rice","quantity":"150g","color":"#f2efe4","thickness":7,"x":115.54971313476562,"startTimeStepIndex":0},{"id":"lime","name":"lime","quantity":"1","color":"#8bc93a","thickness":6,"x":217.17608642578125,"startTimeStepIndex":0},{"id":"galangal","name":"red galangal seasoning","quantity":"15g","color":"#8a2a2a","thickness":4,"x":474.1269836425781,"startTimeStepIndex":0},{"id":"fishsauce","name":"fish sauce","quantity":"20ml","color":"#8a6a52","thickness":4,"x":451.01080322265625,"startTimeStepIndex":0},{"id":"coconutmilk","name":"coconut milk","quantity":"200g","color":"#cfe9ee","thickness":6,"x":605.7532806396484,"startTimeStepIndex":0},{"id":"cherrytomatoes","name":"cherry tomatoes","quantity":"400g","color":"#d43b2b","thickness":6,"x":598.7328491210938,"startTimeStepIndex":0},{"id":"pakchoy","name":"pak choy","quantity":"1 bunch","color":"#4fcf5a","thickness":6,"x":247.26231384277344,"startTimeStepIndex":0},{"id":"pineapple","name":"pineapple slices","quantity":"225g","color":"#e8d34a","thickness":6,"x":498.40838623046875,"startTimeStepIndex":0},{"id":"duck","name":"slow-cooked duck legs","quantity":"2","color":"#c48a6a","thickness":9,"x":636.0789184570312,"startTimeStepIndex":0},{"id":"lemongrass","name":"lemongrass","quantity":"1 stalk","color":"#f0e79a","thickness":5,"x":287.27667236328125,"startTimeStepIndex":0},{"id":"garlic","name":"garlic clove","quantity":"1","color":"#e6d98a","thickness":4,"x":322.27667236328125,"startTimeStepIndex":0},{"id":"shallot","name":"shallot","quantity":"1","color":"#e0559e","thickness":5,"x":358.0814514160156,"startTimeStepIndex":0},{"id":"coriander","name":"coriander","quantity":"1 bunch","color":"#3fae4a","thickness":5,"x":388.252685546875,"startTimeStepIndex":0}],"utensils":[{"id":"u-board","name":"chopping board","color":"#f5d5b8","x":195.65036010742188,"width":238.06463623046875},{"id":"u-foodproc","name":"food processor","color":"#9a9a9a","x":518.0982055664062,"width":44.1102294921875},{"id":"u-pan","name":"medium frying pan","color":"#15110d","x":730,"width":130},{"id":"u-saucepan","name":"saucepan","color":"#7a7a7a","x":880,"width":90},{"id":"u-oven","name":"oven tray","color":"#3a3a3a","x":1000,"width":110},{"id":"u-plate","name":"plate","color":"#e8e8e2","x":1170,"width":90}],"processes":[{"id":"p-aytnd83c","utensilId":"u-pan","label":"1-2 minutes med-high","color":"#8a4a2a","opacity":0.35,"startTimeStepIndex":15,"endTimeStepIndex":19},{"id":"p-gq645qta","utensilId":"u-pan","label":"6-7 minutes med-low","color":"#e0a83a","opacity":0.35,"startTimeStepIndex":18,"endTimeStepIndex":20},{"id":"p-okkibr61","utensilId":"u-oven","label":"5 minutes 190C","color":"#e0a83a","opacity":0.35,"startTimeStepIndex":10,"endTimeStepIndex":12},{"id":"p-4dfhd997","utensilId":"u-oven","label":"15 minutes 190C","color":"#e0a83a","opacity":0.35,"startTimeStepIndex":16,"endTimeStepIndex":19},{"id":"p-uzyh0cl7","utensilId":"u-saucepan","label":"15 minutes simmer","color":"#dedede","opacity":0.35,"startTimeStepIndex":3,"endTimeStepIndex":14}],"rowHeight":20};

    function createExampleRecipe() {
        return JSON.parse(JSON.stringify(EXAMPLE_RECIPE));
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
        SCHEMA_VERSION, DEFAULT_ROW_HEIGHT, genId, createEmptyRecipe, createExampleRecipe, isValidRecipe, migrateRecipe,
        addIngredient, removeIngredient,
        addTimeStep, insertColumnAt, insertStepColumn, addStepAt, removeStepById,
        swapTimeSteps, deleteTimeStep, deleteRow,
        addUtensil, removeUtensil, addProcess, removeProcess
    };
})(window);
