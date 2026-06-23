'use strict';

// ─── Label state ──────────────────────────────────────────────────────────────
// Each label: { x, y, w, rowH, text }
// x/y/w/rowH are in SVG coordinate space; x and w snap to columns.
let _labels = [];

function clearLabels() {
    _labels = [];
}

const _NS = 'http://www.w3.org/2000/svg';
const _DRAG_KEY = 'chart-label-new';

// ─── Re-draw all labels into the current SVG ─────────────────────────────────
function renderLabels() {
    const svg = document.querySelector('#chart-container svg.grid-svg');
    if (!svg) return;
    svg.querySelectorAll('.annotation-label-g').forEach(el => el.remove());
    for (const lbl of _labels) svg.appendChild(_makeLabelEl(lbl));
}

// ─── Find nearest bin from an SVG x-coordinate ───────────────────────────────
function _snapBin(svgX) {
    const layout = window._gridColBounds;
    if (!layout || !layout.bins.length) return null;
    return layout.bins.reduce((best, b) => {
        const bc = b.x + layout.colW / 2;
        const bestC = best.x + layout.colW / 2;
        return Math.abs(svgX - bc) < Math.abs(svgX - bestC) ? b : best;
    });
}

// ─── Build one annotation SVG <g> ────────────────────────────────────────────
function _makeLabelEl(lbl) {
    const g = document.createElementNS(_NS, 'g');
    g.setAttribute('class', 'annotation-label-g');
    g.style.cursor = 'move';

    const rect = document.createElementNS(_NS, 'rect');
    const txt = document.createElementNS(_NS, 'text');
    g.appendChild(rect);
    g.appendChild(txt);
    _applyLabelAttrs(g, lbl);

    // Right-click → delete
    g.addEventListener('contextmenu', e => {
        e.preventDefault();
        _labels = _labels.filter(l => l !== lbl);
        g.remove();
    });

    // Pointer: small move = drag; stationary = click-to-edit
    g.addEventListener('pointerdown', e => {
        e.preventDefault();
        e.stopPropagation();

        const svgEl = g.closest('svg');
        const svgRect = svgEl.getBoundingClientRect();
        const toX = cx => cx - svgRect.left;
        const toY = cy => cy - svgRect.top;

        const startPX = toX(e.clientX), startPY = toY(e.clientY);
        const startLX = lbl.x, startLY = lbl.y;
        let moved = false;

        const onMove = ev => {
            const dx = toX(ev.clientX) - startPX;
            const dy = toY(ev.clientY) - startPY;
            if (!moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) moved = true;
            if (!moved) return;

            // Snap x to nearest column; allow free y
            const midX = startLX + lbl.w / 2 + dx;
            const bin = _snapBin(midX);
            const layout = window._gridColBounds;
            if (bin && layout) {
                lbl.x = bin.x;
                lbl.w = layout.colW;
                lbl.rowH = bin.rowH;
            } else {
                lbl.x = startLX + dx;
            }
            lbl.y = startLY + dy;
            _applyLabelAttrs(g, lbl);
        };

        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            if (!moved) _openEditor(lbl, g);
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    });

    return g;
}

// ─── Update SVG element positions/sizes from lbl data ────────────────────────
function _applyLabelAttrs(g, lbl) {
    const h = Math.max(10, lbl.rowH || 16);
    const fs = Math.max(6, Math.min(9, h - 2));
    const rect = g.querySelector('rect');
    const txt = g.querySelector('text');

    rect.setAttribute('x', lbl.x);
    rect.setAttribute('y', lbl.y);
    rect.setAttribute('width', lbl.w);
    rect.setAttribute('height', h);
    rect.setAttribute('fill', 'white');
    rect.setAttribute('stroke', '#777');
    rect.setAttribute('stroke-width', '1');

    txt.setAttribute('x', lbl.x + 3);
    txt.setAttribute('y', lbl.y + h * 0.73);
    txt.setAttribute('fill', '#000');
    txt.setAttribute('font-size', fs);
    txt.setAttribute('font-weight', '700');
    txt.setAttribute('font-family', "Lato, 'Segoe UI', Arial, sans-serif");
    txt.textContent = lbl.text;
}

// ─── Inline editor using SVG <foreignObject> ─────────────────────────────────
function _openEditor(lbl, g) {
    const svg = g.closest('svg');
    const h = Math.max(10, lbl.rowH || 16);
    const fs = Math.max(6, Math.min(9, h - 2));

    const fo = document.createElementNS(_NS, 'foreignObject');
    fo.setAttribute('x', lbl.x);
    fo.setAttribute('y', lbl.y);
    fo.setAttribute('width', lbl.w);
    fo.setAttribute('height', h);
    fo.setAttribute('class', 'annotation-fo');

    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = lbl.text;
    inp.style.cssText = [
        'width:100%; height:100%; border:none;',
        'background:white; color:#000;',
        `font-size:${fs}px; font-weight:700;`,
        "font-family:Lato,'Segoe UI',Arial,sans-serif;",
        'padding:0 3px; box-sizing:border-box;',
        'outline:2px solid #4a90d9;',
    ].join(' ');
    fo.appendChild(inp);
    svg.appendChild(fo);

    // Hide SVG text while the input is visible
    g.querySelector('text').style.visibility = 'hidden';

    setTimeout(() => { inp.focus(); inp.select(); }, 10);

    const commit = () => {
        fo.remove();
        g.querySelector('text').style.visibility = '';
        const t = inp.value.trim();
        if (!t) {
            _labels = _labels.filter(l => l !== lbl);
            g.remove();
        } else {
            lbl.text = t;
            g.querySelector('text').textContent = t;
        }
    };

    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); inp.blur(); }
    });
}

// ─── Palette drag → drop onto chart ──────────────────────────────────────────
let _paletteOffset = { x: 0, y: 0 };

(function setupPalette() {
    document.querySelectorAll('.label-template').forEach(tmpl => {
        tmpl.addEventListener('dragstart', e => {
            const r = tmpl.getBoundingClientRect();
            _paletteOffset.x = e.clientX - r.left;
            _paletteOffset.y = e.clientY - r.top;
            e.dataTransfer.effectAllowed = 'copy';
            e.dataTransfer.setData('text/plain', _DRAG_KEY);
        });
    });

    const container = document.getElementById('chart-container');

    container.addEventListener('dragover', e => {
        if (e.dataTransfer.types.includes('text/plain')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        }
    });

    container.addEventListener('drop', e => {
        if (e.dataTransfer.getData('text/plain') !== _DRAG_KEY) return;
        e.preventDefault();

        const svg = container.querySelector('svg.grid-svg');
        if (!svg) return;

        const svgRect = svg.getBoundingClientRect();
        const dropX = e.clientX - svgRect.left;
        const dropY = e.clientY - svgRect.top - _paletteOffset.y;

        const layout = window._gridColBounds;
        const bin = _snapBin(dropX);
        const lbl = bin && layout
            ? { x: bin.x, y: dropY, w: layout.colW, rowH: bin.rowH, text: 'Label' }
            : { x: dropX - 30, y: dropY, w: 60, rowH: 16, text: 'Label' };

        _labels.push(lbl);
        const g = _makeLabelEl(lbl);
        svg.appendChild(g);

        setTimeout(() => _openEditor(lbl, g), 20);
    });
})();
