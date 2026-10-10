// Data model, schema helpers, and the built-in example recipe.
(function (global) {
    'use strict';

    const SCHEMA_VERSION = 6;

    // Default spacing (px) between newly-created columns -- mirrors
    // renderer.js's LAYOUT.columnWidth but kept decoupled (model.js doesn't
    // depend on renderer.js). Each column has its own draggable `.x`, so
    // real spacing is whatever the user drags it to, not a fixed grid.
    const DEFAULT_STEP_SPACING = 190;

    function genId(prefix) {
        const rand = (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID().slice(0, 8)
            : Math.random().toString(36).slice(2, 10);
        return `${prefix}-${rand}`;
    }

    // The lane axis is a literal 1-D map of a simplified kitchen: fixed
    // zones (countertop/sink/stovetop/oven) laid out left-to-right, each
    // spanning a fixed pixel range. Utensils are permanent fixtures placed
    // within a zone (no time range of their own -- they're just "there" for
    // the whole recipe); ingredients have a definite `x` position on this
    // same line, moved by dragging rather than picked from an abstract lane.
    function defaultZones() {
        return [
            { id: 'sink', name: 'Sink', x: 0, width: 100 },
            { id: 'countertop', name: 'Countertop', x: 100, width: 600 },
            { id: 'stovetop', name: 'Stovetop', x: 710, width: 270 },
            { id: 'oven', name: 'Oven', x: 990, width: 150 },
            { id: 'table', name: 'Table', x: 1150, width: 120 }
        ];
    }

    // A time step is a single point in the timeline; a "step" (action) is
    // something that happens there. A column holds a `.steps` ARRAY, not a
    // single nullable slot -- several unrelated things (different lines'
    // moves/labels/merges) can genuinely share the same moment, same as in
    // a real kitchen. An empty array is just a plain spacer. `.x` is the
    // column's draggable position along the timeline (px, before
    // LAYOUT.topMargin is added) -- columns are NOT forced to equal width.
    function createEmptyRecipe() {
        return {
            version: SCHEMA_VERSION,
            title: 'Untitled Recipe',
            zones: defaultZones(),
            timeSteps: [
                { id: genId('t'), label: '', steps: [], x: 0 },
                { id: genId('t'), label: '', steps: [], x: DEFAULT_STEP_SPACING }
            ],
            ingredients: [],
            utensils: [],
            processes: []
        };
    }


    // `steps` may be a single step object (the common case) or an array of
    // several sharing this one column/moment.
    function col(label, steps) {
        const list = steps ? (Array.isArray(steps) ? steps : [steps]) : [];
        return { id: genId('t'), label: label || '', steps: list };
    }
    function labelStep(lineId, text) { return { id: genId('step'), type: 'label', lineId, text }; }
    function moveStep(lineId, newX, text) { return { id: genId('step'), type: 'move', lineId, newX, text: text || 'Move' }; }
    // A combined ingredient gets its own real colour/thickness, same as a
    // raw ingredient -- editable afterwards via the same controls, not
    // derived from its inputs at render time.
    function mergeStep(inputLineIds, outputLineId, outputName, outputX, outputColor, outputThickness) {
        return {
            id: genId('step'), type: 'merge', inputLineIds, outputLineId, outputName, outputX,
            outputColor: outputColor || '#888888', outputThickness: outputThickness || 10
        };
    }
    // An "add" keeps the base line's own identity (name/colour) going
    // forward -- no new line is born, only the absorbed line dies here.
    // This is what the common "drag one ingredient onto an existing one"
    // gesture creates (the existing one survives, just gets thicker from
    // here on); an explicit named `mergeStep` (the "+Step > merge"
    // checkbox form) is for deliberately combining several things into a
    // brand new identity instead.
    function addStep(baseLineId, addedLineId, newThickness) {
        return { id: genId('step'), type: 'add', baseLineId, addedLineId, newThickness };
    }

    // Recreation of the original hand-drawn duck/pineapple/pak choy curry
    // prototype recipe, ported onto the kitchen-zone model: every ingredient
    // starts out on the Countertop (anything that needs chopping starts
    // right on the Chopping Board there), aromatics merge at the Food
    // Processor, the curry comes together in the Pan and rice in the
    // Saucepan (both on the Stovetop), duck & pineapple merge on the Oven
    // Tray, and everything finally travels to a Plate in the Table zone.
    function createExampleRecipe() {
        const timeSteps = [
            col(), // 0: start
            col('', labelStep('lemongrass', 'Trim end')), // 1
            col('', labelStep('coriander', 'Pick leaves')), // 2
            col('', labelStep('pineapple', 'Drain, reserving 3tsp juice')), // 3
            col('', moveStep('rice', 50, 'Rinse')), // 4
            col('', labelStep('lemongrass', 'Peel, chop coarsely')), // 5
            col('', labelStep('garlic', 'Chop coarsely')), // 6
            col('', labelStep('shallot', 'Chop coarsely')), // 7
            col('', labelStep('coriander', 'Chop coarsely')), // 8
            col('', mergeStep(['lemongrass', 'garlic', 'shallot', 'coriander', 'galangal', 'fishsauce'], 'paste', 'Aromatic paste', 380, '#8a5a2a', 27)), // 9
            col('', moveStep('rice', 925, 'Add to saucepan')), // 10
            col('', labelStep('pakchoy', 'Quarter')), // 11
            col('', moveStep('paste', 795, 'Add to pan')), // 12
            col('', mergeStep(['paste', 'coconutmilk', 'cherrytomatoes', 'pakchoy'], 'curry', 'Curry sauce', 795, '#d9822b', 45)), // 13
            col('', moveStep('duck', 1040, 'Place on tray')), // 14
            col('', moveStep('pineapple', 1045, 'Place on tray')), // 15
            col('', mergeStep(['duck', 'pineapple'], 'roast', 'Duck & pineapple', 1040, '#c48a6a', 15)), // 16
            col('', labelStep('curry', 'Reduce heat')), // 17
            col('', labelStep('roast', 'Turn tray')), // 18
            col('', moveStep('roast', 1210, 'Move to plate')), // 19
            col('', labelStep('lime', 'Cut into wedges')), // 20
            col('', mergeStep(['curry', 'roast', 'lime'], 'plate', 'Plated dish', 1210, '#d9822b', 66)) // 21
        ];
        // Non-uniform column spacing: the early prep phase (mostly solo
        // label steps) can stay tight, but the back half needs real room
        // between neighbouring columns since 5 processes each inject their
        // own start/end boundary column nearby -- packed too tight, those
        // auto-inserted columns collide with each other on the timeline.
        const colX = [0, 18, 36, 54, 80, 98, 116, 134, 152, 180, 220, 270, 320, 380, 440, 500, 560, 630, 700, 770, 840, 960];
        timeSteps.forEach((ts, i) => { ts.x = colX[i]; });

        // Everything starts on the Countertop -- the 4 ingredients that get
        // chopped (lemongrass/garlic/shallot/coriander) start right on the
        // Chopping Board; galangal/fishsauce are seasonings added straight
        // in, so they just sit elsewhere on the counter alongside the rest.
        const ingredients = [
            { id: 'rice', name: 'Jasmine rice', quantity: '150g', color: '#f2efe4', thickness: 7, x: 460, startTimeStepIndex: 0 },
            { id: 'lime', name: 'Lime', quantity: '1', color: '#8bc93a', thickness: 6, x: 490, startTimeStepIndex: 0 },
            { id: 'galangal', name: 'Red galangal seasoning', quantity: '15g', color: '#8a2a2a', thickness: 4, x: 520, startTimeStepIndex: 0 },
            { id: 'fishsauce', name: 'Fish sauce', quantity: '20ml', color: '#8a6a52', thickness: 4, x: 550, startTimeStepIndex: 0 },
            { id: 'coconutmilk', name: 'Coconut milk', quantity: '200g', color: '#cfe9ee', thickness: 6, x: 580, startTimeStepIndex: 0 },
            { id: 'cherrytomatoes', name: 'Cherry tomatoes', quantity: '400g', color: '#d43b2b', thickness: 6, x: 610, startTimeStepIndex: 0 },
            { id: 'pakchoy', name: 'Pak choy', quantity: '1 bunch', color: '#4fcf5a', thickness: 6, x: 640, startTimeStepIndex: 0 },
            { id: 'pineapple', name: 'Pineapple slices', quantity: '225g', color: '#e8d34a', thickness: 6, x: 665, startTimeStepIndex: 0 },
            { id: 'duck', name: 'Slow-cooked duck legs', quantity: '2', color: '#c48a6a', thickness: 9, x: 690, startTimeStepIndex: 0 },
            { id: 'lemongrass', name: 'Lemongrass', quantity: '1 stalk', color: '#f0e79a', thickness: 5, x: 140, startTimeStepIndex: 0 },
            { id: 'garlic', name: 'Garlic clove', quantity: '1', color: '#e6d98a', thickness: 4, x: 175, startTimeStepIndex: 0 },
            { id: 'shallot', name: 'Shallot', quantity: '1', color: '#e0559e', thickness: 5, x: 210, startTimeStepIndex: 0 },
            { id: 'coriander', name: 'Coriander', quantity: '1 bunch', color: '#3fae4a', thickness: 5, x: 245, startTimeStepIndex: 0 }
        ];

        const model = { version: SCHEMA_VERSION, title: 'Duck, Pineapple & Pak Choy Curry', zones: defaultZones(), timeSteps, ingredients, utensils: [], processes: [] };

        const board = addUtensil(model, { id: 'u-board', name: 'Chopping Board', color: '#8a6a4a', zoneId: 'countertop', x: 120, width: 160 });
        const foodproc = addUtensil(model, { id: 'u-foodproc', name: 'Food Processor', color: '#9a9a9a', zoneId: 'countertop', x: 300, width: 160 });
        const pan = addUtensil(model, { id: 'u-pan', name: 'Pan', color: '#5a4a3a', zoneId: 'stovetop', x: 730, width: 130 });
        const saucepan = addUtensil(model, { id: 'u-saucepan', name: 'Saucepan', color: '#7a7a7a', zoneId: 'stovetop', x: 880, width: 90 });
        const oven = addUtensil(model, { id: 'u-oven', name: 'Oven Tray', color: '#3a3a3a', zoneId: 'oven', x: 1000, width: 110 });
        const plate = addUtensil(model, { id: 'u-plate', name: 'Plate', color: '#e8e8e2', zoneId: 'table', x: 1170, width: 90 });

        addProcess(model, { utensilId: pan.id, label: '1-2 Minutes', sublabel: 'Med-High', color: '#8a4a2a', opacity: 0.35, startX: timeSteps[13].x + 22, endX: timeSteps[17].x - 22 });
        addProcess(model, { utensilId: pan.id, label: '6-7 Minutes', sublabel: 'Med-Low', color: '#e0a83a', opacity: 0.35, startX: timeSteps[17].x + 22, endX: timeSteps[21].x - 22 });
        addProcess(model, { utensilId: oven.id, label: '5 Minutes', sublabel: '190C', color: '#e0a83a', opacity: 0.35, startX: timeSteps[16].x + 22, endX: timeSteps[18].x - 22 });
        addProcess(model, { utensilId: oven.id, label: '15 Minutes', sublabel: '190C', color: '#e0a83a', opacity: 0.35, startX: timeSteps[18].x + 22, endX: timeSteps[21].x - 44 });
        addProcess(model, { utensilId: saucepan.id, label: '15 Minutes', sublabel: 'Simmer', color: '#dedede', opacity: 0.35, startX: timeSteps[10].x + 22, endX: timeSteps[21].x - 66 });

        return model;
    }

    function isValidRecipe(doc) {
        return !!doc && typeof doc === 'object' && Array.isArray(doc.timeSteps) && Array.isArray(doc.ingredients)
            && Array.isArray(doc.utensils) && Array.isArray(doc.processes) && Array.isArray(doc.zones);
    }

    global.VEP = global.VEP || {};
    // ---------- shared mutation helpers (used by in-context canvas editing) ----------
    function addIngredient(model) {
        const maxX = model.ingredients.reduce((m, i) => Math.max(m, i.x || 0), 0);
        const ing = {
            id: genId('ing'), name: 'New Ingredient', quantity: '',
            color: '#888888', thickness: 6, x: maxX + 30, startTimeStepIndex: 0
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
                return true;
            });
        });
    }

    function addTimeStep(model) {
        const ts = model.timeSteps;
        const lastX = ts.length ? ts[ts.length - 1].x : 0;
        const newTs = { id: genId('t'), label: '', steps: [], x: ts.length ? lastX + DEFAULT_STEP_SPACING : 0 };
        ts.push(newTs);
        return newTs;
    }

    // Splices a brand new column in at `index` with a given `x`, and shifts
    // every later process/ingredient reference along by one slot (utensils
    // are permanent fixtures with no time-based reference to shift).
    function insertColumnAt(model, index, step, x) {
        const newTs = { id: genId('t'), label: '', steps: step ? [step] : [], x };
        model.timeSteps.splice(index, 0, newTs);
        const remap = i => (i >= index ? i + 1 : i);
        model.processes.forEach(p => { p.startTimeStepIndex = remap(p.startTimeStepIndex); p.endTimeStepIndex = remap(p.endTimeStepIndex); });
        model.ingredients.forEach(i => { if ((i.startTimeStepIndex || 0) >= index) i.startTimeStepIndex += 1; });
        return newTs;
    }

    // Which line ids a step permanently kills off at its own column (a
    // merge's inputs, or an add's absorbed line) -- null if it doesn't kill
    // anything (label/move/process boundaries just reference a line
    // without ending it).
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

    // A "step" only ever exists as part of its own dedicated column -- adding
    // one inserts a brand new column right where it happens. The new
    // column's x defaults to the midpoint of its neighbours (giving the
    // timeline naturally variable column widths), or an explicit
    // `preferredX` (e.g. wherever the user was hovering) clamped to stay
    // strictly between them. Callers that want to let a step share an
    // EXISTING nearby column instead (so two unrelated lines' events can be
    // genuinely simultaneous) should use `addStepAt` there instead of this.
    function insertStepColumn(model, index, step, preferredX) {
        const ts = model.timeSteps;
        const prevX = ts[index - 1] ? ts[index - 1].x : 0;
        const nextX = ts[index] ? ts[index].x : prevX + DEFAULT_STEP_SPACING;
        let x = (prevX + nextX) / 2;
        if (preferredX != null) {
            const margin = Math.min(4, (nextX - prevX) / 4);
            x = Math.min(Math.max(preferredX, prevX + margin), nextX - margin);
        }
        const newTs = insertColumnAt(model, index, step, x);
        const deadIds = deadLineIdsForStep(step);
        if (deadIds) invalidateFutureLineUses(model, index, deadIds);
        return newTs;
    }

    // Same, but the caller already knows exactly what x it wants (e.g. a
    // process boundary being created at a specific hovered/dragged point) --
    // the array index is derived from where that x sorts in.
    function insertStepColumnAtX(model, x, step) {
        const ts = model.timeSteps;
        let index = ts.length;
        for (let i = 0; i < ts.length; i++) {
            if (ts[i].x > x) { index = i; break; }
        }
        return insertColumnAt(model, index, step, x);
    }

    // Swaps two adjacent (or arbitrary) time-step columns and remaps every
    // process reference to either index (the embedded step just goes along
    // with its column automatically since it's part of the same object).
    function swapTimeSteps(model, a, b) {
        const ts = model.timeSteps;
        if (b < 0 || b >= ts.length || a === b) return;
        [ts[a], ts[b]] = [ts[b], ts[a]];
        const remap = idx => (idx === a ? b : idx === b ? a : idx);
        model.processes.forEach(p => { p.startTimeStepIndex = remap(p.startTimeStepIndex); p.endTimeStepIndex = remap(p.endTimeStepIndex); });
    }

    function deleteTimeStep(model, idx) {
        model.timeSteps.splice(idx, 1);
        const remap = i => (i > idx ? i - 1 : i);
        model.processes = model.processes.filter(p => p.startTimeStepIndex !== idx && p.endTimeStepIndex !== idx);
        model.processes.forEach(p => { p.startTimeStepIndex = remap(p.startTimeStepIndex); p.endTimeStepIndex = remap(p.endTimeStepIndex); });
        model.ingredients.forEach(i => { if (i.startTimeStepIndex > idx) i.startTimeStepIndex -= 1; });
        // A deleted column might have been a (other) process's start or end,
        // orphaning its OTHER boundary step -- clear those out.
        const processIds = new Set(model.processes.map(p => p.id));
        model.timeSteps.forEach(ts => {
            ts.steps = (ts.steps || []).filter(s =>
                !((s.type === 'process-start' || s.type === 'process-end') && !processIds.has(s.processId)));
        });
    }

    // Utensils are permanent kitchen fixtures -- no time range, just a fixed
    // spot (`x`/`width`) within a `zoneId`.
    function addUtensil(model, opts) {
        opts = opts || {};
        const u = {
            id: opts.id || genId('u'), name: opts.name || 'New Utensil', color: opts.color || '#999999',
            zoneId: opts.zoneId || (model.zones[0] && model.zones[0].id) || null,
            x: opts.x != null ? opts.x : 0, width: opts.width != null ? opts.width : 80
        };
        model.utensils.push(u);
        return u;
    }

    function removeUtensil(model, id) {
        model.utensils = model.utensils.filter(u => u.id !== id);
        model.processes.filter(p => p.utensilId === id).forEach(p => removeProcess(model, p.id));
    }

    // A process always fills its utensil's full height (no lane range of
    // its own); its start/end are their own dedicated steps too, same as a
    // utensil's, created immediately at `startX`/`endX`.
    function addProcess(model, opts) {
        opts = opts || {};
        const p = {
            id: opts.id || genId('p'), utensilId: opts.utensilId || null,
            label: opts.label || 'Duration', sublabel: opts.sublabel || '',
            color: opts.color || '#ffcc66', opacity: opts.opacity != null ? opts.opacity : 0.35,
            startTimeStepIndex: 0, endTimeStepIndex: 0
        };
        model.processes.push(p);
        const startX = opts.startX != null ? opts.startX : 0;
        const endX = opts.endX != null ? opts.endX : startX + DEFAULT_STEP_SPACING;
        const startTs = insertStepColumnAtX(model, startX, { id: genId('step'), type: 'process-start', processId: p.id });
        const endTs = insertStepColumnAtX(model, endX, { id: genId('step'), type: 'process-end', processId: p.id });
        p.startTimeStepIndex = model.timeSteps.indexOf(startTs);
        p.endTimeStepIndex = model.timeSteps.indexOf(endTs);
        return p;
    }

    function removeProcess(model, id) {
        model.processes = model.processes.filter(p => p.id !== id);
        model.timeSteps.forEach(ts => {
            ts.steps = (ts.steps || []).filter(s =>
                !((s.type === 'process-start' || s.type === 'process-end') && s.processId === id));
        });
    }

    global.VEP = global.VEP || {};
    global.VEP.model = {
        SCHEMA_VERSION, genId, createEmptyRecipe, createExampleRecipe, isValidRecipe,
        addIngredient, removeIngredient,
        addTimeStep, insertColumnAt, insertStepColumn, insertStepColumnAtX, addStepAt, removeStepById,
        swapTimeSteps, deleteTimeStep,
        addUtensil, removeUtensil, addProcess, removeProcess
    };
})(window);
