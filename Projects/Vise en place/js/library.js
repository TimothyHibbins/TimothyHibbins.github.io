// The recipe folder: bundled recipes (recipes/recipes.js) plus the user's own
// recipes, with any edits kept in localStorage (a bundled recipe that has been
// edited shows its edited copy).
(function (global) {
    'use strict';

    const KEY = 'vise-en-place.library.v2';
    const OLD_DRAFT_KEY = 'vise-en-place.draft.v1';
    const M = () => global.VEP.model;

    function readStore() {
        try {
            const store = JSON.parse(localStorage.getItem(KEY));
            if (store && store.recipes) return store;
        } catch (err) { /* fall through to a fresh store */ }
        return { recipes: {}, importedDraft: false };
    }
    function writeStore(store) {
        try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (err) { /* best effort */ }
    }

    // The single-recipe autosave from before the folder existed becomes a
    // normal entry so nobody loses work.
    function importOldDraft(store) {
        if (store.importedDraft) return;
        store.importedDraft = true;
        try {
            const raw = localStorage.getItem(OLD_DRAFT_KEY);
            const doc = raw && JSON.parse(raw);
            if (doc && M().isValidRecipe(doc)) store.recipes['local-imported'] = doc;
        } catch (err) { /* ignore a corrupt draft */ }
        writeStore(store);
    }

    const bundled = () => global.VEP_RECIPE_FOLDER || [];
    const isBundled = id => bundled().some(b => b.id === id);

    function copyOf(doc) {
        return M().migrateRecipe(JSON.parse(JSON.stringify(doc)));
    }

    function list() {
        const store = readStore();
        importOldDraft(store);
        const items = bundled().map(b => ({ id: b.id, bundled: true, recipe: copyOf(store.recipes[b.id] || b.recipe) }));
        Object.keys(store.recipes).forEach(id => {
            if (!isBundled(id)) items.push({ id, bundled: false, recipe: copyOf(store.recipes[id]) });
        });
        return items;
    }

    function get(id) {
        const store = readStore();
        const b = bundled().find(x => x.id === id);
        const doc = store.recipes[id] || (b && b.recipe);
        return doc ? copyOf(doc) : null;
    }

    function save(id, model) {
        const store = readStore();
        store.recipes[id] = model;
        writeStore(store);
    }

    function create() {
        const id = M().genId('local');
        save(id, M().createEmptyRecipe());
        return id;
    }

    // Deletes a user's recipe, or reverts an edited bundled one to the original.
    function remove(id) {
        const store = readStore();
        delete store.recipes[id];
        writeStore(store);
    }

    global.VEP = global.VEP || {};
    global.VEP.library = { list, get, save, create, remove, isBundled };
})(window);
