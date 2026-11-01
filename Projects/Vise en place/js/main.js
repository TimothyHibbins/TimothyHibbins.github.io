// App entry point: the recipe folder view, opening a recipe into the editor,
// and the header controls. Everything inside a recipe (ingredients, rows,
// steps, utensils, processes) is edited directly on the canvas -- see
// js/interact.js.
(function () {
    'use strict';

    const VEP = window.VEP;
    const svg = document.getElementById('diagram');
    const canvasWrap = document.getElementById('canvasWrap');
    const folderView = document.getElementById('folderView');
    const folderGrid = document.getElementById('folderGrid');
    const titleEl = document.getElementById('recipeTitle');
    const rowHeightInput = document.getElementById('rowHeightInput');
    const rowHeightOut = document.getElementById('rowHeightOut');
    const show = (id, on) => { document.getElementById(id).hidden = !on; };

    const app = {
        model: null,
        id: null,
        rerender() {
            if (!app.model) return;
            syncRowHeightControl();
            VEP.renderer.renderDiagram(app.model, svg);
            VEP.interact.bindAll(svg, app.model, app.rerender);
            VEP.library.save(app.id, app.model);
        }
    };

    document.getElementById('versionTag').textContent = window.VEP_VERSION;
    document.title = `Vise en place ${window.VEP_VERSION}`;

    // Keeps the slider showing whatever the CURRENT model's row height is
    // (the model gets swapped wholesale by undo).
    function syncRowHeightControl() {
        const h = VEP.renderer.rowH(app.model);
        rowHeightInput.value = h;
        rowHeightOut.textContent = h;
    }

    // ---------- undo / redo: a plain stack of whole-model JSON snapshots,
    // one per logical gesture (see interact.js). Cleared on switching recipe. ----------
    const MAX_HISTORY = 100;
    let undoStack = [];
    let redoStack = [];
    const snapshotJSON = () => JSON.stringify(app.model);
    function recordHistory() {
        if (!app.model) return;
        undoStack.push(snapshotJSON());
        if (undoStack.length > MAX_HISTORY) undoStack.shift();
        redoStack.length = 0;
    }
    function undo() {
        if (!undoStack.length || !app.model) return;
        redoStack.push(snapshotJSON());
        app.model = JSON.parse(undoStack.pop());
        app.rerender();
        syncTitle();
    }
    function redo() {
        if (!redoStack.length || !app.model) return;
        undoStack.push(snapshotJSON());
        app.model = JSON.parse(redoStack.pop());
        app.rerender();
        syncTitle();
    }
    function resetHistory() { undoStack = []; redoStack = []; }
    VEP.history = { record: recordHistory, undo, redo };
    document.addEventListener('keydown', e => {
        const mod = e.metaKey || e.ctrlKey;
        if (!mod || (document.activeElement && document.activeElement.isContentEditable)) return;
        const key = e.key.toLowerCase();
        if (key === 'z' && e.shiftKey) { e.preventDefault(); redo(); }
        else if (key === 'z') { e.preventDefault(); undo(); }
        else if (key === 'y') { e.preventDefault(); redo(); }
    });

    VEP.cook.init(svg, () => app.model);

    // ---------- views ----------
    function setTitle(text, editable) {
        titleEl.textContent = text;
        titleEl.contentEditable = editable ? 'true' : 'false';
        titleEl.classList.toggle('is-editable', editable);
        if (editable) titleEl.title = 'Click to rename'; else titleEl.removeAttribute('title');
    }
    function syncTitle() {
        if (app.model) setTitle(app.model.title || 'Untitled Recipe', true);
    }

    function showFolder() {
        VEP.cook.stop();
        VEP.interact.closePopover();
        app.model = null;
        app.id = null;
        resetHistory();
        canvasWrap.hidden = true;
        folderView.hidden = false;
        ['backBtn', 'cookBtn', 'exportImageBtn', 'rowHeightCtl'].forEach(id => show(id, false));
        setTitle('Recipes', false);
        VEP.folder.render(folderGrid, VEP.library.list(), {
            onOpen: openRecipe,
            onCreate: () => openRecipe(VEP.library.create()),
            onDelete: (id, title) => {
                if (!confirm(`Delete "${title || 'Untitled Recipe'}"? This cannot be undone.`)) return;
                VEP.library.remove(id);
                showFolder();
            }
        });
    }

    function openRecipe(id) {
        const model = VEP.library.get(id);
        if (!model) return;
        app.id = id;
        app.model = model;
        resetHistory();
        folderView.hidden = true;
        canvasWrap.hidden = false;
        ['backBtn', 'cookBtn', 'exportImageBtn', 'rowHeightCtl'].forEach(id2 => show(id2, true));
        syncTitle();
        app.rerender();
        canvasWrap.scrollTop = 0;
    }

    document.getElementById('backBtn').addEventListener('click', showFolder);

    // ---------- header controls ----------
    titleEl.addEventListener('focus', () => {
        const range = document.createRange();
        range.selectNodeContents(titleEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    });
    titleEl.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
        else if (e.key === 'Escape') { syncTitle(); titleEl.blur(); }
    });
    titleEl.addEventListener('blur', () => {
        window.getSelection().removeAllRanges();
        if (!app.model) return;
        const next = titleEl.textContent.trim() || 'Untitled Recipe';
        if (next !== app.model.title) {
            recordHistory();
            app.model.title = next;
            VEP.library.save(app.id, app.model);
        }
        syncTitle();
    });

    // One undo snapshot per slider gesture (pointer down), not per tick.
    rowHeightInput.addEventListener('pointerdown', recordHistory);
    rowHeightInput.addEventListener('keydown', e => {
        if (e.key.startsWith('Arrow') && !e.repeat) recordHistory();
    });
    rowHeightInput.addEventListener('input', () => {
        app.model.rowHeight = Number(rowHeightInput.value);
        app.rerender();
    });

    document.getElementById('exportImageBtn').addEventListener('click', () => {
        const filename = `${(app.model.title || 'recipe').replace(/[^a-z0-9-_ ]/gi, '').trim() || 'recipe'}.png`;
        VEP.io.exportImage(svg, filename);
    });

    const fullscreenBtn = document.getElementById('fullscreenBtn');
    const root = document.documentElement;
    fullscreenBtn.addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else if (root.requestFullscreen) root.requestFullscreen();
    });
    document.addEventListener('fullscreenchange', () => {
        fullscreenBtn.textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
    });
    if (!root.requestFullscreen) fullscreenBtn.hidden = true;

    showFolder();
})();
