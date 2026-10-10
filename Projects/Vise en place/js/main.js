// App entry point: wires toolbar actions to the model and renderer. Everything
// else (ingredients, time steps, steps, utensils, processes) is edited
// directly on the canvas -- see js/interact.js.
(function () {
    'use strict';

    const svg = document.getElementById('diagram');
    const app = {
        model: window.VEP.io.loadDraft() || window.VEP.model.createEmptyRecipe(),
        rerender() {
            window.VEP.renderer.renderDiagram(app.model, svg);
            window.VEP.interact.bindAll(svg, app.model, app.rerender);
            window.VEP.io.saveDraft(app.model);
        }
    };

    // ---------- undo / redo: a plain stack of whole-model JSON snapshots.
    // `window.VEP.history.record()` is called by interact.js once per
    // logical action (a whole drag, a whole text edit, a whole color-picker
    // session) right before it mutates anything, so one undo always undoes
    // one whole gesture rather than one intermediate frame of it. ----------
    const MAX_HISTORY = 100;
    const undoStack = [];
    const redoStack = [];
    function snapshotJSON() { return JSON.stringify(app.model); }
    function recordHistory() {
        undoStack.push(snapshotJSON());
        if (undoStack.length > MAX_HISTORY) undoStack.shift();
        redoStack.length = 0;
    }
    function undo() {
        if (!undoStack.length) return;
        redoStack.push(snapshotJSON());
        app.model = JSON.parse(undoStack.pop());
        app.rerender();
    }
    function redo() {
        if (!redoStack.length) return;
        undoStack.push(snapshotJSON());
        app.model = JSON.parse(redoStack.pop());
        app.rerender();
    }
    window.VEP.history = { record: recordHistory, undo, redo };
    document.addEventListener('keydown', e => {
        const mod = e.metaKey || e.ctrlKey;
        if (!mod) return;
        const key = e.key.toLowerCase();
        if (key === 'z' && e.shiftKey) { e.preventDefault(); redo(); }
        else if (key === 'z') { e.preventDefault(); undo(); }
        else if (key === 'y') { e.preventDefault(); redo(); }
    });

    app.rerender();

    document.getElementById('newBtn').addEventListener('click', () => {
        if (!confirm('Start a new blank recipe? Unsaved changes will be lost.')) return;
        recordHistory();
        app.model = window.VEP.model.createEmptyRecipe();
        app.rerender();
    });

    document.getElementById('exampleBtn').addEventListener('click', () => {
        if (!confirm('Load the built-in example recipe? Unsaved changes will be lost.')) return;
        recordHistory();
        app.model = window.VEP.model.createExampleRecipe();
        app.rerender();
    });

    document.getElementById('saveBtn').addEventListener('click', () => {
        window.VEP.io.saveRecipe(app.model);
    });

    document.getElementById('loadInput').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        try {
            recordHistory();
            app.model = await window.VEP.io.loadRecipeFromFile(file);
            app.rerender();
        } catch (err) {
            alert(`Could not load recipe: ${err.message}`);
        }
    });

    document.getElementById('exportImageBtn').addEventListener('click', () => {
        const filename = `${(app.model.title || 'recipe').replace(/[^a-z0-9-_ ]/gi, '').trim() || 'recipe'}.png`;
        window.VEP.io.exportImage(svg, filename);
    });

    document.getElementById('titleInput').addEventListener('change', (e) => {
        recordHistory();
        app.model.title = e.target.value;
        window.VEP.io.saveDraft(app.model);
    });
    document.getElementById('titleInput').value = app.model.title || '';
})();
