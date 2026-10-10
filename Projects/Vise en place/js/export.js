// Save/Load (JSON download + file import), localStorage autosave draft,
// and SVG->PNG image export.
(function (global) {
    'use strict';

    const DRAFT_KEY = 'vise-en-place.draft.v1';

    function downloadTextFile(filename, content, mime) {
        const blob = new Blob([content], { type: mime || 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
        URL.revokeObjectURL(url);
    }

    function saveRecipe(model) {
        const filename = `${(model.title || 'recipe').replace(/[^a-z0-9-_ ]/gi, '').trim() || 'recipe'}.vep.json`;
        downloadTextFile(filename, JSON.stringify(model, null, 2));
    }

    function loadRecipeFromFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const doc = JSON.parse(reader.result);
                    if (!global.VEP.model.isValidRecipe(doc)) {
                        reject(new Error('File does not look like a valid Vise en place recipe.'));
                        return;
                    }
                    resolve(doc);
                } catch (err) {
                    reject(err);
                }
            };
            reader.onerror = () => reject(reader.error);
            reader.readAsText(file);
        });
    }

    function saveDraft(model) {
        try {
            localStorage.setItem(DRAFT_KEY, JSON.stringify(model));
        } catch (err) {
            // localStorage unavailable or full -- autosave is best-effort only
        }
    }

    function loadDraft() {
        try {
            const raw = localStorage.getItem(DRAFT_KEY);
            if (!raw) return null;
            const doc = JSON.parse(raw);
            return global.VEP.model.isValidRecipe(doc) ? doc : null;
        } catch (err) {
            return null;
        }
    }

    function clearDraft() {
        try { localStorage.removeItem(DRAFT_KEY); } catch (err) { /* ignore */ }
    }

    // Serializes the live SVG element to a PNG download at a higher pixel
    // ratio for crisper exported images.
    function exportImage(svg, filename, scale) {
        scale = scale || 2;
        const width = parseFloat(svg.getAttribute('width'));
        const height = parseFloat(svg.getAttribute('height'));
        const clone = svg.cloneNode(true);
        clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

        const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        bgRect.setAttribute('x', '0');
        bgRect.setAttribute('y', '0');
        bgRect.setAttribute('width', String(width));
        bgRect.setAttribute('height', String(height));
        bgRect.setAttribute('fill', '#ffffff');
        clone.insertBefore(bgRect, clone.firstChild);

        const svgString = new XMLSerializer().serializeToString(clone);
        const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(svgBlob);

        const img = new Image();
        return new Promise((resolve, reject) => {
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = width * scale;
                canvas.height = height * scale;
                const ctx = canvas.getContext('2d');
                ctx.scale(scale, scale);
                ctx.drawImage(img, 0, 0, width, height);
                URL.revokeObjectURL(url);
                canvas.toBlob(blob => {
                    const pngUrl = URL.createObjectURL(blob);
                    const anchor = document.createElement('a');
                    anchor.href = pngUrl;
                    anchor.download = filename || 'recipe.png';
                    anchor.click();
                    URL.revokeObjectURL(pngUrl);
                    resolve();
                }, 'image/png');
            };
            img.onerror = reject;
            img.src = url;
        });
    }

    global.VEP = global.VEP || {};
    global.VEP.io = { saveRecipe, loadRecipeFromFile, saveDraft, loadDraft, clearDraft, exportImage, downloadTextFile };
})(window);
