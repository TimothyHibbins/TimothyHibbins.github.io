// The recipe folder view: one column of recipes, each a name above a
// vertically compressed rendering of the recipe (no step numbers or labels).
(function (global) {
    'use strict';

    // Row height used for folder renderings (the editor's rows are taller).
    const COMPACT_ROW_HEIGHT = 6;

    function mk(tag, cls, text) {
        const el = document.createElement(tag);
        if (cls) el.className = cls;
        if (text != null) el.textContent = text;
        return el;
    }

    function render(container, items, handlers) {
        container.textContent = '';

        const create = mk('button', 'folder-new', '+ Create new recipe');
        create.addEventListener('click', handlers.onCreate);
        container.appendChild(create);

        items.forEach(item => {
            const entry = mk('article', 'recipe-entry');
            entry.tabIndex = 0;
            const head = mk('div', 'recipe-entry-head');
            head.appendChild(mk('h2', 'recipe-entry-title', item.recipe.title || 'Untitled Recipe'));
            if (!item.bundled) {
                const del = mk('button', 'recipe-entry-del', 'Delete');
                del.addEventListener('click', e => { e.stopPropagation(); handlers.onDelete(item.id, item.recipe.title); });
                head.appendChild(del);
            }
            entry.appendChild(head);
            const thumb = mk('div', 'recipe-thumb');
            entry.appendChild(thumb);
            entry.addEventListener('click', () => handlers.onOpen(item.id));
            entry.addEventListener('keydown', e => { if (e.key === 'Enter') handlers.onOpen(item.id); });
            container.appendChild(entry);

            // Must be in the live document so text can be measured.
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            thumb.appendChild(svg);
            item.recipe.__compactRowHeight = COMPACT_ROW_HEIGHT;
            global.VEP.renderer.renderDiagram(item.recipe, svg, { thumbnail: true });
            svg.removeAttribute('width');
            svg.removeAttribute('height');
        });
    }

    global.VEP = global.VEP || {};
    global.VEP.folder = { render };
})(window);
