'use strict';

// ─── Chart constants ────────────────────────────────────────────────────────
const CHART = {
    BAR_W: 4,    // bar width in px
    BAR_GAP: 1,    // gap between bars in px
    SEASON_GAP: 12,   // extra horizontal space between seasons in px
    MAX_H: 85,   // maximum bar height / depth in px (= 100%)
    AXIS_Y: 100,  // y-coordinate of the x-axis line inside the SVG
    SVG_H: 215,  // total SVG height
    PAD_L: 2,    // left padding inside each subject SVG
    PAD_R: 6,    // right padding
    LABEL_H: 20,   // approximate height of the subject-label div above each SVG
};

// ─── Public entry point ─────────────────────────────────────────────────────

/**
 * Render the chart into #chart-container.
 *
 * @param {Array}  questions  - from parseProfile()
 * @param {Object} pctLookup  - from parseSeason(), merged across all season files
 */
function renderChart(questions, pctLookup) {
    const container = document.getElementById('chart-container');
    container.innerHTML = '';

    // Attach % correct to each question; keep all questions (null pct if no season data)
    const matched = questions.map(q => {
        const key = `${q.season}-${q.matchDay}-${q.questionNum}`;
        return { ...q, pct: key in pctLookup ? pctLookup[key] : null };
    }).filter(q => q.pct !== null);

    if (!matched.length) {
        const msg = document.createElement('p');
        msg.className = 'chart-empty';
        msg.textContent = 'No % correct data found for questions in this profile. '
            + 'Try the Subject Seasons or Timeline views.';
        container.appendChild(msg);
        return;
    }

    // Group by subject
    const subjectMap = new Map();
    for (const q of matched) {
        if (!subjectMap.has(q.subject)) subjectMap.set(q.subject, []);
        subjectMap.get(q.subject).push(q);
    }

    // Sort each group chronologically
    for (const qs of subjectMap.values()) {
        qs.sort((a, b) => a.season - b.season || a.matchDay - b.matchDay || a.questionNum - b.questionNum);
    }

    // Sort subjects alphabetically
    const subjects = [...subjectMap.keys()].sort();

    const tooltip = document.getElementById('tooltip');

    for (const subject of subjects) {
        container.appendChild(buildSubjectGroup(subject, subjectMap.get(subject), tooltip));
    }

    renderYAxis(); // uses defaults: CHART.LABEL_H offset, CHART.SVG_H height
    renderCorrectWrongLegend();
}

// ─── Y-axis ──────────────────────────────────────────────────────────────────

// labelOffset = pixels of non-chart content above the SVG (subject labels in grouped mode, 0 otherwise).
// singleAxis  = true → draw only the upward direction (% correct 0→100%).
// axisY / maxH override CHART defaults (used by SBC mode).
function renderYAxis(labelOffset = CHART.LABEL_H, svgH = CHART.SVG_H, singleAxis = false, axisY = CHART.AXIS_Y, maxH = CHART.MAX_H, flipped = false) {
    const wrapper = document.getElementById('y-axis-wrapper');
    if (!wrapper) return;
    wrapper.innerHTML = '';

    const NS = 'http://www.w3.org/2000/svg';
    const totalH = labelOffset + svgH;
    const W = 40;
    const TICK_RIGHT = W;

    // y positions inside the axis SVG (offset by labelOffset)
    const yOf = svgY => labelOffset + svgY;

    const ticks = singleAxis ? [
        { svgY: axisY - maxH, label: flipped ? '0%' : '100%' },
        { svgY: axisY - maxH * 0.75, label: flipped ? '25%' : '75%' },
        { svgY: axisY - maxH * 0.5, label: '50%' },
        { svgY: axisY - maxH * 0.25, label: flipped ? '75%' : '25%' },
        { svgY: axisY, label: flipped ? '100%' : '0%' },
    ] : [
        { svgY: axisY - maxH, label: '100%' },
        { svgY: axisY - maxH / 2, label: '50%' },
        { svgY: axisY, label: '0%' },
        { svgY: axisY + maxH / 2, label: '50%' },
        { svgY: axisY + maxH, label: '100%' },
    ];

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', W);
    svg.setAttribute('height', totalH);
    svg.id = 'y-axis-svg';

    for (const { svgY, label } of ticks) {
        const y = yOf(svgY);

        const tick = document.createElementNS(NS, 'line');
        tick.setAttribute('x1', TICK_RIGHT - 4); tick.setAttribute('y1', y);
        tick.setAttribute('x2', TICK_RIGHT); tick.setAttribute('y2', y);
        tick.setAttribute('class', 'y-tick');
        svg.appendChild(tick);

        const text = document.createElementNS(NS, 'text');
        text.setAttribute('x', TICK_RIGHT - 7);
        text.setAttribute('y', y + 4);   // +4 for optical vertical centering
        text.setAttribute('text-anchor', 'end');
        text.setAttribute('class', 'y-axis-label');
        text.textContent = label;
        svg.appendChild(text);
    }

    // Vertical axis line
    const vLine = document.createElementNS(NS, 'line');
    vLine.setAttribute('x1', TICK_RIGHT); vLine.setAttribute('y1', yOf(axisY - maxH));
    vLine.setAttribute('x2', TICK_RIGHT); vLine.setAttribute('y2', yOf(singleAxis ? axisY : axisY + maxH));
    vLine.setAttribute('class', 'y-tick');
    svg.appendChild(vLine);

    wrapper.appendChild(svg);
}

// ─── Subject group builder ───────────────────────────────────────────────────

function buildSubjectGroup(subject, qs, tooltip) {
    const { BAR_W, BAR_GAP, SEASON_GAP, MAX_H, AXIS_Y, SVG_H, PAD_L, PAD_R } = CHART;
    const NS = 'http://www.w3.org/2000/svg';

    // ── First pass: compute x positions and season spans ──────────────────────
    const barPositions = [];   // [{ x, q }]
    const seasonSpans = [];   // [{ season, x1, x2 }]  (x2 = right edge of last bar)

    let x = PAD_L;
    let prevSeason = null;
    let seasonStart = PAD_L;

    for (const q of qs) {
        if (prevSeason !== null && q.season !== prevSeason) {
            // Close previous season span (x2 = right edge of last bar = x − BAR_GAP)
            seasonSpans.push({ season: prevSeason, x1: seasonStart, x2: x - BAR_GAP });
            // Open next season after the gap
            seasonStart = x + SEASON_GAP;
            x += SEASON_GAP;
        } else if (prevSeason === null) {
            seasonStart = x;
        }

        barPositions.push({ x, q });
        x += BAR_W + BAR_GAP;
        prevSeason = q.season;
    }

    // Close the final season span
    if (prevSeason !== null) {
        seasonSpans.push({ season: prevSeason, x1: seasonStart, x2: x - BAR_GAP });
    }

    const svgWidth = x + PAD_R;

    // ── Build DOM ──────────────────────────────────────────────────────────────
    const wrapper = document.createElement('div');
    wrapper.className = 'subject-group';

    const labelDiv = document.createElement('div');
    labelDiv.className = 'subject-label';
    labelDiv.textContent = subject;
    wrapper.appendChild(labelDiv);

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', svgWidth);
    svg.setAttribute('height', SVG_H);
    svg.setAttribute('class', 'subject-chart');
    svg.style.overflow = 'visible';  // allow season labels to overhang

    // Background fill for the bar area
    const bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('x', 0);
    bg.setAttribute('y', AXIS_Y - MAX_H);
    bg.setAttribute('width', svgWidth);
    bg.setAttribute('height', MAX_H * 2);
    bg.setAttribute('class', 'bar-bg');
    svg.appendChild(bg);

    // 50% guide lines (above and below axis)
    const MID = MAX_H / 2;
    for (const gy of [AXIS_Y - MID, AXIS_Y + MID]) {
        const gl = document.createElementNS(NS, 'line');
        gl.setAttribute('x1', 0); gl.setAttribute('y1', gy);
        gl.setAttribute('x2', svgWidth); gl.setAttribute('y2', gy);
        gl.setAttribute('class', 'grid-line');
        svg.appendChild(gl);
    }

    // X-axis
    const axis = document.createElementNS(NS, 'line');
    axis.setAttribute('x1', 0); axis.setAttribute('y1', AXIS_Y);
    axis.setAttribute('x2', svgWidth); axis.setAttribute('y2', AXIS_Y);
    axis.setAttribute('class', 'x-axis');
    svg.appendChild(axis);

    // Season dividers (between spans) and season labels (below bars)
    const LABEL_Y = AXIS_Y + MAX_H + 13;

    for (let i = 0; i < seasonSpans.length; i++) {
        const span = seasonSpans[i];

        // Divider line between this season and the next
        if (i < seasonSpans.length - 1) {
            const nextSpan = seasonSpans[i + 1];
            const divX = (span.x2 + nextSpan.x1) / 2;

            const divider = document.createElementNS(NS, 'line');
            divider.setAttribute('x1', divX); divider.setAttribute('y1', AXIS_Y - MAX_H);
            divider.setAttribute('x2', divX); divider.setAttribute('y2', AXIS_Y + MAX_H);
            divider.setAttribute('class', 'season-divider');
            svg.appendChild(divider);
        }

        // Season label centred within its span
        const midX = (span.x1 + span.x2) / 2;
        const lbl = document.createElementNS(NS, 'text');
        lbl.setAttribute('x', midX);
        lbl.setAttribute('y', LABEL_Y);
        lbl.setAttribute('class', 'season-label');
        lbl.setAttribute('text-anchor', 'middle');
        lbl.textContent = `LL${span.season}`;
        svg.appendChild(lbl);
    }

    // ── Draw bars ──────────────────────────────────────────────────────────────
    for (const { x: bx, q } of barPositions) {
        const barValue = q.correct ? (100 - q.pct) : q.pct;
        const barHeight = Math.max(1, (barValue / 100) * MAX_H);

        const rect = document.createElementNS(NS, 'rect');
        rect.setAttribute('x', bx);
        rect.setAttribute('y', q.correct ? AXIS_Y - barHeight : AXIS_Y);
        rect.setAttribute('width', BAR_W);
        rect.setAttribute('height', barHeight);
        rect.setAttribute('class', q.correct ? 'bar-correct' : 'bar-wrong');
        rect.style.cursor = 'pointer';

        const tipHTML = buildTooltipHTML(q);
        rect.addEventListener('mousemove', e => showTooltip(tooltip, e, tipHTML));
        rect.addEventListener('mouseleave', () => hideTooltip(tooltip));
        rect.addEventListener('click', () => window.open(q.questionUrl, '_blank', 'noopener,noreferrer'));

        svg.appendChild(rect);
    }

    wrapper.appendChild(svg);
    return wrapper;
}

// ─── Tooltip helpers ─────────────────────────────────────────────────────────

function buildTooltipHTML(q) {
    // Build tooltip DOM safely: only use innerHTML for static/numeric strings;
    // user-supplied question text is assigned via textContent.
    const wrap = document.createElement('div');

    const titleLine = document.createElement('div');
    titleLine.className = 'tip-title';
    const bold = document.createElement('strong');
    bold.textContent = q.subject;
    const meta = document.createElement('span');
    meta.className = 'tip-meta';
    meta.textContent = `  LL${q.season} MD${q.matchDay} Q${q.questionNum}`;
    titleLine.appendChild(bold);
    titleLine.appendChild(meta);
    wrap.appendChild(titleLine);

    const resultLine = document.createElement('div');
    resultLine.className = q.correct ? 'tip-correct' : 'tip-wrong';
    if (q.correct) {
        resultLine.textContent = q.pct !== null
            ? `✓ Correct — ${q.pct}% of players got it right`
            : '✓ Correct';
    } else {
        resultLine.textContent = q.pct !== null
            ? `✗ Wrong — ${q.pct}% of players got it right`
            : '✗ Wrong';
    }
    wrap.appendChild(resultLine);

    const textLine = document.createElement('div');
    textLine.className = 'tip-text';
    textLine.textContent = q.questionText;   // user data — assigned via textContent
    wrap.appendChild(textLine);

    if (q.answer) {
        const answerLine = document.createElement('div');
        answerLine.className = 'tip-answer';
        answerLine.textContent = `Answer: ${q.answer}`;
        wrap.appendChild(answerLine);
    }

    return wrap.innerHTML;
}

function showTooltip(tooltip, e, html) {
    tooltip.innerHTML = html;
    tooltip.classList.remove('hidden');
    positionTooltip(tooltip, e);
}

function hideTooltip(tooltip) {
    tooltip.classList.add('hidden');
}

function positionTooltip(tooltip, e) {
    const PAD = 14;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;

    let left = e.clientX + PAD;
    let top = e.clientY + PAD;

    if (left + tw > vw - 8) left = e.clientX - tw - PAD;
    if (top + th > vh - 8) top = e.clientY - th - PAD;

    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
}

// ─── Subject color palette ────────────────────────────────────────────────────

const SUBJECT_COLORS = {
    'AMER HIST': '#e63946',
    'ART': '#4895ef',
    'BUS/ECON': '#2d936c',
    'CLASS MUSIC': '#9b5de5',
    'CURR EVENTS': '#f77f00',
    'FILM': '#00b4d8',
    'FOOD/DRINK': '#c1121f',
    'GAMES/SPORT': '#06d6a0',
    'GEOGRAPHY': '#7b2fbe',
    'LANGUAGE': '#fb8500',
    'LIFESTYLE': '#ef476f',
    'LITERATURE': '#1d7ebc',
    'MATH': '#6d6875',
    'POP MUSIC': '#e9c46a',
    'SCIENCE': '#40916c',
    'TELEVISION': '#7209b7',
    'THEATRE': '#2a9d8f',
    'WORLD HIST': '#e76f51',
};
const SUBJECT_FALLBACK = '#888';

function subjectColor(s) { return SUBJECT_COLORS[s] || SUBJECT_FALLBACK; }

// ─── Timeline constants ───────────────────────────────────────────────────────

const TL = {
    DOT_R: 5,
    JITTER_STEP: 11,
    MAX_JITTER_STEPS: 2,
    COL_W: 38,
    COL_GAP: 4,
    SEASON_GAP: 22,
    PAD_L: 10,
    PAD_R: 10,
    AXIS_Y: 265,
    MAX_H: 250,
    SVG_H: 315,
    get MD_TICK_Y1() { return this.AXIS_Y + 3; },
    get MD_TICK_Y2() { return this.AXIS_Y + 9; },
    get MD_LABEL_Y() { return this.AXIS_Y + 20; },
    get SEASON_LABEL_Y() { return this.AXIS_Y + 32; },
};

// ─── Subject-by-season column constants ─────────────────────────────────────────────

const SBC = {
    DOT_R: 6,
    JITTER_STEP: 14,
    MAX_JITTER_STEPS: 2,
    COL_W: 52,
    COL_GAP: 4,
    SUBJ_GAP: 16,
    PAD_L: 10,
    PAD_R: 10,
    AXIS_Y: 330,
    MAX_H: 315,
    SVG_H: 385,
    get SEASON_TICK_Y1() { return this.AXIS_Y + 3; },
    get SEASON_TICK_Y2() { return this.AXIS_Y + 9; },
    get SEASON_LABEL_Y() { return this.AXIS_Y + 19; },
    get SUBJ_LABEL_Y() { return this.AXIS_Y + 35; },
};

// ─── Timeline renderer ────────────────────────────────────────────────────────

function renderTimeline(questions, pctLookup, flipped = false) {
    const container = document.getElementById('chart-container');
    container.innerHTML = '';

    // Filter to questions with season stats — required for y-axis positioning
    const matched = [];
    for (const q of questions) {
        const key = `${q.season}-${q.matchDay}-${q.questionNum}`;
        if (key in pctLookup) matched.push({ ...q, pct: pctLookup[key] });
    }

    if (!matched.length) {
        const msg = document.createElement('p');
        msg.className = 'chart-empty';
        msg.textContent = 'No % correct data found for questions in this profile.'
            + ' The Answers view works without season data.';
        container.appendChild(msg);
        return;
    }

    // Sort chronologically
    matched.sort((a, b) => a.season - b.season || a.matchDay - b.matchDay || a.questionNum - b.questionNum);

    const { DOT_R, JITTER_STEP, MAX_JITTER_STEPS, COL_W, COL_GAP, SEASON_GAP,
        PAD_L: PL, PAD_R: PR, SVG_H: TLSVGH,
        AXIS_Y, MAX_H,
        MD_TICK_Y1, MD_TICK_Y2, MD_LABEL_Y, SEASON_LABEL_Y } = TL;

    // ── Group questions into per-match-day columns (preserves chronological order) ─
    const columns = [];
    const colMap = new Map();
    for (const q of matched) {
        const k = `${q.season}-${q.matchDay}`;
        if (!colMap.has(k)) {
            const col = { season: q.season, md: q.matchDay, qs: [] };
            columns.push(col);
            colMap.set(k, col);
        }
        colMap.get(k).qs.push(q);
    }

    // ── Assign column centre x positions ────────────────────────────────────────
    let xLeft = PL;
    let prevSeason = null;
    const seasonSpans = [];
    let seasonX1 = null;

    for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        if (i === 0) {
            seasonX1 = xLeft;
        } else if (col.season !== prevSeason) {
            seasonSpans.push({ season: prevSeason, x1: seasonX1, x2: xLeft });
            xLeft += SEASON_GAP;
            seasonX1 = xLeft;
        } else {
            xLeft += COL_GAP;
        }
        col.cx = xLeft + COL_W / 2;
        xLeft += COL_W;
        prevSeason = col.season;
    }
    if (prevSeason !== null) seasonSpans.push({ season: prevSeason, x1: seasonX1, x2: xLeft });

    const svgWidth = xLeft + PR;

    // ── Compute y (% correct going upward) and jitter x ────────────────────────
    for (const col of columns) {
        for (const q of col.qs) {
            q._cy = flipped
                ? AXIS_Y - ((100 - q.pct) / 100) * MAX_H
                : AXIS_Y - (q.pct / 100) * MAX_H;
        }
        col.qs.sort((a, b) => a._cy - b._cy);
        jitterDots(col.qs, col.cx, DOT_R, JITTER_STEP, MAX_JITTER_STEPS);
    }

    // ── Build SVG ────────────────────────────────────────────────────────────────
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', svgWidth);
    svg.setAttribute('height', TLSVGH);
    svg.setAttribute('class', 'timeline-chart');
    svg.style.overflow = 'visible';

    // Background (above axis only — height = % correct going up)
    svgEl(svg, NS, 'rect', { x: 0, y: AXIS_Y - MAX_H, width: svgWidth, height: MAX_H, class: 'bar-bg' });

    // 25 / 50 / 75% guide lines
    for (const frac of [0.25, 0.5, 0.75])
        svgEl(svg, NS, 'line', { x1: 0, y1: AXIS_Y - MAX_H * frac, x2: svgWidth, y2: AXIS_Y - MAX_H * frac, class: 'grid-line' });

    // X-axis (0% line)
    svgEl(svg, NS, 'line', { x1: 0, y1: AXIS_Y, x2: svgWidth, y2: AXIS_Y, class: 'x-axis' });

    // Subtle vertical column guides
    for (const col of columns) {
        svgEl(svg, NS, 'line', { x1: col.cx, y1: AXIS_Y - MAX_H, x2: col.cx, y2: AXIS_Y, class: 'col-guide' });
    }

    // Season dividers and labels
    for (let i = 0; i < seasonSpans.length; i++) {
        const span = seasonSpans[i];
        if (i < seasonSpans.length - 1) {
            const divX = span.x2 + SEASON_GAP / 2;
            svgEl(svg, NS, 'line', { x1: divX, y1: AXIS_Y - MAX_H, x2: divX, y2: AXIS_Y + 14, class: 'season-divider' });
        }
        const midX = (span.x1 + span.x2) / 2;
        const lbl = document.createElementNS(NS, 'text');
        lbl.setAttribute('x', midX);
        lbl.setAttribute('y', SEASON_LABEL_Y);
        lbl.setAttribute('text-anchor', 'middle');
        lbl.setAttribute('class', 'season-label');
        lbl.textContent = `LL${span.season}`;
        svg.appendChild(lbl);
    }

    // MD ticks + label for every match day
    for (const col of columns) {
        svgEl(svg, NS, 'line', { x1: col.cx, y1: MD_TICK_Y1, x2: col.cx, y2: MD_TICK_Y2, class: 'md-tick' });
        const t = document.createElementNS(NS, 'text');
        t.setAttribute('x', col.cx);
        t.setAttribute('y', MD_LABEL_Y);
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('class', 'md-label');
        t.textContent = col.md;
        svg.appendChild(t);
    }

    // Dots — rendered last so they sit above gridlines
    const tooltip = document.getElementById('tooltip');
    for (const col of columns) {
        for (const q of col.qs) {
            const g = buildDotGroup(NS, q._cx, q._cy, DOT_R, subjectColor(q.subject), q.correct);
            g.setAttribute('class', 'tl-dot');
            g.setAttribute('data-subject', q.subject);
            g.style.cursor = 'pointer';
            const tipHTML = buildTooltipHTML(q);
            g.addEventListener('mousemove', e => showTooltip(tooltip, e, tipHTML));
            g.addEventListener('mouseleave', () => hideTooltip(tooltip));
            g.addEventListener('click', () => window.open(q.questionUrl, '_blank', 'noopener,noreferrer'));
            svg.appendChild(g);
        }
    }

    container.appendChild(svg);

    renderYAxis(0, TLSVGH, true, AXIS_Y, MAX_H, flipped);

    const subjects = [...new Set(matched.map(q => q.subject))].sort();
    renderColorLegend(subjects, svg);
}
// ─── Subject-by-season renderer ─────────────────────────────────────────────────────

function renderBySubjectSeason(questions, pctLookup, flipped = false) {
    const container = document.getElementById('chart-container');
    container.innerHTML = '';

    const matched = [];
    for (const q of questions) {
        const key = `${q.season}-${q.matchDay}-${q.questionNum}`;
        if (key in pctLookup) matched.push({ ...q, pct: pctLookup[key] });
    }

    if (!matched.length) {
        const msg = document.createElement('p');
        msg.className = 'chart-empty';
        msg.textContent = 'No % correct data found for questions in this profile.'
            + ' The Answers view works without season data.';
        container.appendChild(msg);
        renderColorLegend([], null);
        return;
    }

    const { DOT_R, JITTER_STEP, MAX_JITTER_STEPS, COL_W, COL_GAP, SUBJ_GAP,
        PAD_L: PL, PAD_R: PR, SVG_H: SBCSVGH,
        AXIS_Y, MAX_H,
        SEASON_TICK_Y1, SEASON_TICK_Y2, SEASON_LABEL_Y: SBS_SEASON_LBL,
        SUBJ_LABEL_Y } = SBC;

    // ── Group: subject → season → questions ──────────────────────────────────────────
    const subjectMap = new Map();
    const seasonSet = new Set();
    for (const q of matched) {
        seasonSet.add(q.season);
        if (!subjectMap.has(q.subject)) subjectMap.set(q.subject, new Map());
        const sm = subjectMap.get(q.subject);
        if (!sm.has(q.season)) sm.set(q.season, []);
        sm.get(q.season).push(q);
    }
    const subjects = [...subjectMap.keys()].sort();
    const seasons = [...seasonSet].sort((a, b) => a - b);

    // ── Build columns + subject spans ─────────────────────────────────────────────
    const columns = []; // { subject, season, cx, qs[] }
    const subjectSpans = []; // { subject, x1, x2 }
    let xLeft = PL;

    for (const subject of subjects) {
        const subjX1 = xLeft;
        const seasonMap = subjectMap.get(subject);
        let first = true;
        for (const season of seasons) {
            const qs = seasonMap.get(season);
            if (!qs) continue;
            if (!first) xLeft += COL_GAP;
            columns.push({ subject, season, cx: xLeft + COL_W / 2, qs: [...qs] });
            xLeft += COL_W;
            first = false;
        }
        if (!first) {
            subjectSpans.push({ subject, x1: subjX1, x2: xLeft });
            xLeft += SUBJ_GAP;
        }
    }
    if (subjectSpans.length) xLeft -= SUBJ_GAP; // strip trailing gap

    const svgWidth = xLeft + PR;

    // ── Compute y + jitter ─────────────────────────────────────────────────────────
    for (const col of columns) {
        for (const q of col.qs) {
            q._cy = flipped
                ? AXIS_Y - ((100 - q.pct) / 100) * MAX_H
                : AXIS_Y - (q.pct / 100) * MAX_H;
        }
        col.qs.sort((a, b) => a._cy - b._cy);
        jitterDots(col.qs, col.cx, DOT_R, JITTER_STEP, MAX_JITTER_STEPS);
    }

    // ── Build SVG ────────────────────────────────────────────────────────────────
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', svgWidth);
    svg.setAttribute('height', SBCSVGH);
    svg.setAttribute('class', 'sbs-chart');
    svg.style.overflow = 'visible';

    svgEl(svg, NS, 'rect', { x: 0, y: AXIS_Y - MAX_H, width: svgWidth, height: MAX_H, class: 'bar-bg' });
    for (const frac of [0.25, 0.5, 0.75])
        svgEl(svg, NS, 'line', { x1: 0, y1: AXIS_Y - MAX_H * frac, x2: svgWidth, y2: AXIS_Y - MAX_H * frac, class: 'grid-line' });
    svgEl(svg, NS, 'line', { x1: 0, y1: AXIS_Y, x2: svgWidth, y2: AXIS_Y, class: 'x-axis' });

    // Column guides
    for (const col of columns)
        svgEl(svg, NS, 'line', { x1: col.cx, y1: AXIS_Y - MAX_H, x2: col.cx, y2: AXIS_Y, class: 'col-guide' });

    // Subject dividers
    for (let i = 0; i < subjectSpans.length - 1; i++) {
        const divX = subjectSpans[i].x2 + SUBJ_GAP / 2;
        svgEl(svg, NS, 'line', { x1: divX, y1: AXIS_Y - MAX_H, x2: divX, y2: AXIS_Y + 25, class: 'season-divider' });
    }

    // Season ticks + labels
    for (const col of columns) {
        svgEl(svg, NS, 'line', { x1: col.cx, y1: SEASON_TICK_Y1, x2: col.cx, y2: SEASON_TICK_Y2, class: 'md-tick' });
        const sl = document.createElementNS(NS, 'text');
        sl.setAttribute('x', col.cx); sl.setAttribute('y', SBS_SEASON_LBL);
        sl.setAttribute('text-anchor', 'middle'); sl.setAttribute('class', 'sbs-season-label');
        sl.textContent = `LL${col.season}`;
        svg.appendChild(sl);
    }

    // Subject group labels
    for (const span of subjectSpans) {
        const t = document.createElementNS(NS, 'text');
        t.setAttribute('x', (span.x1 + span.x2) / 2); t.setAttribute('y', SUBJ_LABEL_Y);
        t.setAttribute('text-anchor', 'middle'); t.setAttribute('class', 'sbs-subj-label');
        t.textContent = span.subject;
        svg.appendChild(t);
    }

    // Dots
    const tooltip = document.getElementById('tooltip');
    for (const col of columns) {
        for (const q of col.qs) {
            const g = buildDotGroup(NS, q._cx, q._cy, DOT_R, subjectColor(q.subject), q.correct);
            g.setAttribute('class', 'tl-dot');
            g.setAttribute('data-subject', q.subject);
            g.style.cursor = 'pointer';
            const tipHTML = buildTooltipHTML(q);
            g.addEventListener('mousemove', e => showTooltip(tooltip, e, tipHTML));
            g.addEventListener('mouseleave', () => hideTooltip(tooltip));
            g.addEventListener('click', () => window.open(q.questionUrl, '_blank', 'noopener,noreferrer'));
            svg.appendChild(g);
        }
    }

    container.appendChild(svg);
    renderYAxis(0, SBCSVGH, true, AXIS_Y, MAX_H, flipped);
    document.getElementById('chart-legend').innerHTML = '';
}
// ─── Dot group renderer (circle + tick or cross mark) ─────────────────────────

// Returns an SVG <g> containing the circle + a tick (correct) or cross (wrong).
function buildDotGroup(NS, cx, cy, r, color, correct) {
    const g = document.createElementNS(NS, 'g');

    const circle = document.createElementNS(NS, 'circle');
    circle.setAttribute('cx', cx);
    circle.setAttribute('cy', cy);
    circle.setAttribute('r', r);
    if (correct) {
        circle.setAttribute('fill', color);
    } else {
        circle.setAttribute('fill', '#111');
    }
    g.appendChild(circle);

    const s = r * 0.45; // mark scale
    const mark = document.createElementNS(NS, 'path');
    mark.setAttribute('fill', 'none');
    mark.setAttribute('stroke-linecap', 'round');
    mark.setAttribute('stroke-linejoin', 'round');
    mark.setAttribute('stroke-width', Math.max(1, r * 0.22));
    if (correct) {
        // Checkmark
        mark.setAttribute('d', `M ${cx - s} ${cy + s * 0.1} L ${cx - s * 0.15} ${cy + s} L ${cx + s * 1.1} ${cy - s * 0.8}`);
        mark.setAttribute('stroke', '#000');
    } else {
        // × cross in subject color
        mark.setAttribute('d', `M ${cx - s * 0.85} ${cy - s * 0.85} L ${cx + s * 0.85} ${cy + s * 0.85} M ${cx + s * 0.85} ${cy - s * 0.85} L ${cx - s * 0.85} ${cy + s * 0.85}`);
        mark.setAttribute('stroke', color);
    }
    g.appendChild(mark);

    return g;
}

// ─── Lightweight SVG element helper ──────────────────────────────────────────

function svgEl(parent, NS, tag, attrs) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    parent.appendChild(el);
    return el;
}

// ─── Jitter algorithm ─────────────────────────────────────────────────────────

// Greedy beeswarm: place each dot at the column centre if possible,
// otherwise try ±jitterStep, ±2·jitterStep, … up to maxSteps.
function jitterDots(colDots, colCx, dotR, jitterStep, maxSteps) {
    const placed = []; // { cx, cy } of already-placed dots in this column
    for (const d of colDots) {
        let chosenCx = colCx;
        outer: for (let step = 0; step <= maxSteps; step++) {
            const candidates = step === 0
                ? [colCx]
                : [colCx + step * jitterStep, colCx - step * jitterStep];
            for (const c of candidates) {
                if (placed.every(p => Math.hypot(c - p.cx, d._cy - p.cy) >= dotR * 2 + 0.5)) {
                    chosenCx = c;
                    break outer;
                }
            }
        }
        placed.push({ cx: chosenCx, cy: d._cy });
        d._cx = chosenCx;
    }
}

// ─── Legend renderers ─────────────────────────────────────────────────────────

function renderColorLegend(subjects, tlSvg) {
    const legend = document.getElementById('chart-legend');
    legend.innerHTML = '';
    if (!subjects.length) return;

    const subtitle = document.createElement('p');
    subtitle.className = 'legend-subtitle';
    subtitle.textContent = tlSvg
        ? 'Height = % of players who got it right · Filled ✓ = you got it right · Dark ✕ = you got it wrong · Hover a subject to highlight · Click to open on learneague.com'
        : 'Bar height/depth = question difficulty · Correct above axis, wrong below · Hover for details · Click to open on learneague.com';
    legend.appendChild(subtitle);

    const grid = document.createElement('div');
    grid.className = 'color-legend-grid';

    for (const subject of subjects) {
        const item = document.createElement('div');
        item.className = 'color-legend-item';
        if (tlSvg) item.classList.add('color-legend-item--interactive');

        // SVG circle swatch (matches the dot style)
        const NS = 'http://www.w3.org/2000/svg';
        const sw = document.createElementNS(NS, 'svg');
        sw.setAttribute('width', 13); sw.setAttribute('height', 13);
        sw.style.flexShrink = '0';
        const circ = document.createElementNS(NS, 'circle');
        circ.setAttribute('cx', 6.5); circ.setAttribute('cy', 6.5);
        circ.setAttribute('r', 5.5);
        circ.setAttribute('fill', subjectColor(subject));
        sw.appendChild(circ);
        item.appendChild(sw);

        const name = document.createElement('span');
        name.className = 'color-name';
        name.textContent = subject;
        item.appendChild(name);

        // Highlight interaction — dim all other dots using inline styles (reliable cross-browser)
        if (tlSvg) {
            item.addEventListener('mouseenter', () => {
                tlSvg.querySelectorAll('.tl-dot').forEach(d => {
                    d.style.opacity = '0.07';
                    d.style.pointerEvents = 'none';
                });
                // Restore this subject's dots to default (CSS takes over when inline style is removed)
                const esc = subject.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                tlSvg.querySelectorAll(`.tl-dot[data-subject="${esc}"]`).forEach(d => {
                    d.style.opacity = '';
                    d.style.pointerEvents = '';
                });
            });
            item.addEventListener('mouseleave', () => {
                tlSvg.querySelectorAll('.tl-dot').forEach(d => {
                    d.style.opacity = '';
                    d.style.pointerEvents = '';
                });
            });
        }

        grid.appendChild(item);
    }

    legend.appendChild(grid);
}

function renderCorrectWrongLegend() {
    const legend = document.getElementById('chart-legend');
    // Build safely — no user data here
    legend.innerHTML = [
        '<span class="legend-correct"><span class="legend-swatch"></span>Correct — bar height = % who got it wrong</span>',
        '<span class="legend-wrong"><span class="legend-swatch"></span>Wrong — bar depth = % who got it right</span>',
        '<span class="legend-hint">Hover for question details · Click to open on learneague.com</span>',
    ].join('');
}

// ─── Answers view renderer ───────────────────────────────────────────────────
// Subject-Seasons layout: each question is a fixed-width label chip containing
// the answer text, positioned on the % correct y-axis.

function renderAnswers(questions, pctLookup, flipped = false, subjectOrder = null) {
    const NS = 'http://www.w3.org/2000/svg';
    const container = document.getElementById('chart-container');
    container.innerHTML = '';
    document.getElementById('y-axis-wrapper').innerHTML = '';
    document.getElementById('chart-legend').innerHTML = '';

    // ── Layout constants ─────────────────────────────────────────────────────
    const LABEL_W = 130;   // fixed label width
    const H_PAD = 4;     // horizontal padding inside label
    const AVAIL_W = LABEL_W - 2 * H_PAD;  // 122 px of usable text width
    const FONT_1 = 8.5;   // single-line font size
    const FONT_2 = 7;     // two-line font size
    const CW_1 = 4.8;   // avg char width at FONT_1
    const CW_2 = 4.2;   // avg char width at FONT_2
    const MAX_RATIO = 1.3;   // allow up to 30 % textLength compression
    const H_1 = 13;    // single-line label height
    const H_2 = 19;    // two-line label height
    const COL_W = 14;    // dot-only column width
    const DOT_R = 3;     // dot radius
    const LABEL_SEP = 30;    // gap between dot area right edge and label strip
    const LABEL_GAP = 1;     // minimum vertical gap between adjacent chips
    const COL_GAP = 8;
    const SUBJ_GAP = 24;
    const PAD_L = 10;
    const PAD_R = 10;
    const chartH = Math.max(400, window.innerHeight - 200);
    const AXIS_Y = chartH - 50;
    const MAX_H = AXIS_Y - 15;
    const SVG_H = chartH;
    const CHART_TOP = AXIS_Y - MAX_H;
    const TICK_Y1 = AXIS_Y + 3;
    const TICK_Y2 = AXIS_Y + 9;
    const SEASON_LBL = AXIS_Y + 19;
    const SUBJ_LBL = AXIS_Y + 35;

    // ── Text-fitting helpers ──────────────────────────────────────────────────
    function splitAtMid(text) {
        const words = text.split(' ');
        if (words.length === 1) {
            const m = Math.ceil(text.length / 2);
            return [text.slice(0, m), text.slice(m)];
        }
        const target = text.length / 2;
        let best = 1, bestDiff = Infinity, cum = words[0].length;
        for (let i = 1; i < words.length; i++) {
            const diff = Math.abs(cum - target);
            if (diff < bestDiff) { bestDiff = diff; best = i; }
            cum += 1 + words[i].length;
        }
        return [words.slice(0, best).join(' '), words.slice(best).join(' ')];
    }

    function labelMetrics(answer) {
        if (!answer) return { lines: [''], h: H_1, fs: FONT_1, tl: null };
        const nw1 = answer.length * CW_1;
        if (nw1 <= AVAIL_W * MAX_RATIO) {
            return { lines: [answer], h: H_1, fs: FONT_1, tl: nw1 > AVAIL_W ? AVAIL_W : null };
        }
        const [l1, l2] = splitAtMid(answer);
        const nw2 = Math.max(l1.length, l2.length) * CW_2;
        if (nw2 <= AVAIL_W * MAX_RATIO) {
            return { lines: [l1, l2], h: H_2, fs: FONT_2, tl: nw2 > AVAIL_W ? AVAIL_W : null };
        }
        // Truncate as last resort
        const maxCh = Math.floor(AVAIL_W * MAX_RATIO / CW_1);
        return { lines: [answer.slice(0, maxCh - 1) + '\u2026'], h: H_1, fs: FONT_1, tl: AVAIL_W };
    }

    // ── Label placement: push overlapping chips apart, keep within chart ──────
    function resolveOverlaps(qs) {
        // qs already sorted by _cy ascending (top → bottom in SVG)
        const n = qs.length;
        if (n === 0) return;
        qs.forEach(q => { q.adjY = q._cy; });

        // Forward pass — push down
        for (let i = 1; i < n; i++) {
            const minY = qs[i - 1].adjY + (qs[i - 1].metrics.h + qs[i].metrics.h) / 2 + LABEL_GAP;
            if (qs[i].adjY < minY) qs[i].adjY = minY;
        }

        // Clamp last to chart bottom, then backward pass
        const last = n - 1;
        const maxBottom = AXIS_Y - qs[last].metrics.h / 2;
        if (qs[last].adjY > maxBottom) {
            qs[last].adjY = maxBottom;
            for (let i = last - 1; i >= 0; i--) {
                const maxY = qs[i + 1].adjY - (qs[i].metrics.h + qs[i + 1].metrics.h) / 2 - LABEL_GAP;
                if (qs[i].adjY > maxY) qs[i].adjY = maxY;
            }
        }

        // Clamp first to chart top, then forward pass
        const minTop = CHART_TOP + qs[0].metrics.h / 2;
        if (qs[0].adjY < minTop) {
            qs[0].adjY = minTop;
            for (let i = 1; i < n; i++) {
                const minY = qs[i - 1].adjY + (qs[i - 1].metrics.h + qs[i].metrics.h) / 2 + LABEL_GAP;
                if (qs[i].adjY < minY) qs[i].adjY = minY;
            }
        }
    }

    // ── Filter to questions that have % correct data ───────────────────────────
    const matched = [];
    for (const q of questions) {
        const key = `${q.season}-${q.matchDay}-${q.questionNum}`;
        if (key in pctLookup) matched.push({ ...q, pct: pctLookup[key] });
    }

    if (!matched.length) {
        const msg = document.createElement('p');
        msg.className = 'chart-empty';
        msg.textContent = 'No % correct data found for questions in this profile.';
        container.appendChild(msg);
        return;
    }

    // ── Group: subject → season → questions ───────────────────────────────────
    const subjectMap = new Map();
    const seasonSet = new Set();
    for (const q of matched) {
        seasonSet.add(q.season);
        if (!subjectMap.has(q.subject)) subjectMap.set(q.subject, new Map());
        const sm = subjectMap.get(q.subject);
        if (!sm.has(q.season)) sm.set(q.season, []);
        sm.get(q.season).push(q);
    }
    const allSubjects = [...subjectMap.keys()].sort();
    const subjects = subjectOrder
        ? subjectOrder.filter(s => subjectMap.has(s))
        : allSubjects;
    const seasons = [...seasonSet].sort((a, b) => a - b);

    // ── Build columns + subject spans ─────────────────────────────────────────
    const columns = [];
    const subjectSpans = [];
    let xLeft = PAD_L;

    for (const subject of subjects) {
        const subjX1 = xLeft;
        const seasonMap = subjectMap.get(subject);
        let first = true;
        for (const season of seasons) {
            const qs = seasonMap.get(season);
            if (!qs) continue;
            if (!first) xLeft += COL_GAP;
            columns.push({ subject, season, cx: xLeft + COL_W / 2, colLeft: xLeft, qs: [...qs] });
            xLeft += COL_W;
            first = false;
        }
        if (!first) {
            const dotsX2 = xLeft;
            const labelX = dotsX2 + LABEL_SEP;
            const totalX2 = labelX + LABEL_W;
            subjectSpans.push({ subject, x1: subjX1, dotsX2, labelX, x2: totalX2 });
            xLeft = totalX2 + SUBJ_GAP;
        }
    }
    if (subjectSpans.length) xLeft -= SUBJ_GAP;
    const svgWidth = xLeft + PAD_R;

    // ── Compute y positions and metrics ────────────────────────────────────
    for (const col of columns) {
        for (const q of col.qs) {
            q._cy = flipped
                ? AXIS_Y - ((100 - q.pct) / 100) * MAX_H
                : AXIS_Y - (q.pct / 100) * MAX_H;
            q.metrics = labelMetrics(q.answer);
        }
    }
    // Resolve overlaps per subject — each subject has its own label strip
    const subjLabelX = new Map(subjectSpans.map(s => [s.subject, s.labelX]));
    for (const span of subjectSpans) {
        const subjQs = columns
            .filter(col => col.subject === span.subject)
            .flatMap(col => col.qs);
        subjQs.sort((a, b) => a._cy - b._cy);
        resolveOverlaps(subjQs);
    }

    // ── Build SVG ──────────────────────────────────────────────────────────────
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', svgWidth);
    svg.setAttribute('height', SVG_H);
    svg.setAttribute('class', 'sbs-chart');
    svg.style.overflow = 'visible';

    svgEl(svg, NS, 'rect', { x: 0, y: CHART_TOP, width: svgWidth, height: MAX_H, class: 'bar-bg' });
    for (const frac of [0.25, 0.5, 0.75])
        svgEl(svg, NS, 'line', { x1: 0, y1: AXIS_Y - MAX_H * frac, x2: svgWidth, y2: AXIS_Y - MAX_H * frac, class: 'grid-line' });
    svgEl(svg, NS, 'line', { x1: 0, y1: AXIS_Y, x2: svgWidth, y2: AXIS_Y, class: 'x-axis' });

    // Subject dividers
    for (let i = 0; i < subjectSpans.length - 1; i++) {
        const divX = subjectSpans[i].x2 + SUBJ_GAP / 2;
        svgEl(svg, NS, 'line', { x1: divX, y1: CHART_TOP, x2: divX, y2: AXIS_Y + 25, class: 'season-divider' });
    }

    // Season ticks + labels
    for (const col of columns) {
        svgEl(svg, NS, 'line', { x1: col.cx, y1: TICK_Y1, x2: col.cx, y2: TICK_Y2, class: 'md-tick' });
        const sl = document.createElementNS(NS, 'text');
        sl.setAttribute('x', col.cx); sl.setAttribute('y', SEASON_LBL);
        sl.setAttribute('text-anchor', 'middle'); sl.setAttribute('class', 'sbs-season-label');
        sl.textContent = `LL${col.season}`;
        svg.appendChild(sl);
    }

    // Subject group labels
    for (const span of subjectSpans) {
        const t = document.createElementNS(NS, 'text');
        t.setAttribute('x', (span.x1 + span.x2) / 2); t.setAttribute('y', SUBJ_LBL);
        t.setAttribute('text-anchor', 'middle'); t.setAttribute('class', 'sbs-subj-label');
        t.textContent = span.subject;
        svg.appendChild(t);
    }

    // Dots (left, in columns) + diagonal leader lines + labels (right, aligned)
    const tooltip = document.getElementById('tooltip');

    // 1. Leader lines — drawn first, behind everything
    for (const col of columns) {
        const lx = subjLabelX.get(col.subject);
        for (const q of col.qs) {
            svgEl(svg, NS, 'line', {
                x1: col.cx, y1: q._cy,
                x2: lx, y2: q.adjY,
                class: 'ans-leader',
            });
        }
    }

    // 2. Dots at true data positions
    for (const col of columns) {
        for (const q of col.qs) {
            const color = subjectColor(q.subject);
            if (q.correct) {
                svgEl(svg, NS, 'circle', {
                    cx: col.cx, cy: q._cy, r: DOT_R,
                    fill: color,
                });
            } else {
                svgEl(svg, NS, 'circle', {
                    cx: col.cx, cy: q._cy, r: DOT_R,
                    fill: '#111',
                    stroke: color,
                    'stroke-width': '1.5',
                });
            }
        }
    }

    // 3. Label chips at per-subject fixed x
    for (const col of columns) {
        const lx = subjLabelX.get(col.subject);
        for (const q of col.qs) {
            const color = subjectColor(q.subject);
            const metrics = q.metrics;

            const g = document.createElementNS(NS, 'g');
            g.style.cursor = 'pointer';

            const rect = document.createElementNS(NS, 'rect');
            rect.setAttribute('x', lx);
            rect.setAttribute('y', q.adjY - metrics.h / 2);
            rect.setAttribute('width', LABEL_W);
            rect.setAttribute('height', metrics.h);
            rect.setAttribute('rx', 3);
            if (q.correct) {
                rect.setAttribute('fill', color);
                rect.setAttribute('fill-opacity', '0.85');
                rect.setAttribute('stroke', color);
                rect.setAttribute('stroke-width', '1');
            } else {
                rect.setAttribute('fill', '#1e1e1e');
                rect.setAttribute('stroke', color);
                rect.setAttribute('stroke-opacity', '0.7');
                rect.setAttribute('stroke-width', '1');
            }
            g.appendChild(rect);

            const textFill = q.correct ? '#111' : '#ddd';
            const textX = lx + H_PAD;
            if (metrics.lines.length === 1) {
                const t = document.createElementNS(NS, 'text');
                t.setAttribute('x', textX);
                t.setAttribute('y', q.adjY + metrics.fs * 0.36);
                t.setAttribute('font-size', metrics.fs);
                t.setAttribute('class', 'ans-text');
                if (metrics.tl) { t.setAttribute('textLength', AVAIL_W); t.setAttribute('lengthAdjust', 'spacingAndGlyphs'); }
                t.textContent = metrics.lines[0];
                t.setAttribute('fill', textFill);
                g.appendChild(t);
            } else {
                const lineH = metrics.fs * 1.3;
                metrics.lines.forEach((line, i) => {
                    const t = document.createElementNS(NS, 'text');
                    t.setAttribute('x', textX);
                    t.setAttribute('y', q.adjY - lineH * 0.5 + i * lineH + metrics.fs * 0.85);
                    t.setAttribute('font-size', metrics.fs);
                    t.setAttribute('class', 'ans-text');
                    if (metrics.tl) { t.setAttribute('textLength', AVAIL_W); t.setAttribute('lengthAdjust', 'spacingAndGlyphs'); }
                    t.textContent = line;
                    t.setAttribute('fill', textFill);
                    g.appendChild(t);
                });
            }

            const tipHTML = buildTooltipHTML(q);
            g.addEventListener('mousemove', e => showTooltip(tooltip, e, tipHTML));
            g.addEventListener('mouseleave', () => hideTooltip(tooltip));
            g.addEventListener('click', () => window.open(q.questionUrl, '_blank', 'noopener,noreferrer'));
            svg.appendChild(g);
        }
    }

    container.appendChild(svg);
    renderYAxis(0, SVG_H, true, AXIS_Y, MAX_H, flipped);
}
