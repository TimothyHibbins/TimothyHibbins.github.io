'use strict';

// ─── Persistent state ─────────────────────────────────────────────────────────
let _data = null;      // { playerName, questions, pctLookup }
let _subjectOrder = null;      // ordered array of active subjects
let _titleCase = false;        // whether to render answer text in title case

// ─── Shared profile loader ───────────────────────────────────────────────────
async function _loadProfileText(profileText, label) {
    const { playerName, questions } = parseProfile(profileText);

    if (!questions.length) {
        setStatus('No question history found in the profile. Make sure you uploaded the full profile page (with the Question History tab included).', 'error');
        return;
    }

    const pctLookup = (typeof LL_PCT !== 'undefined') ? LL_PCT : {};

    // Annotate questions with pre-built answers (from answers.js global LL_ANSWERS)
    const answerSource = (typeof LL_ANSWERS !== 'undefined') ? LL_ANSWERS : {};
    for (const q of questions) {
        const key = `${q.season}-${q.matchDay}-${q.questionNum}`;
        if (key in answerSource) q.answer = answerSource[key];
    }

    // Drop seasons that have no answers at all (e.g. current in-progress season)
    const seasonsWithAnswers = new Set(
        Object.keys(answerSource).map(k => parseInt(k.split('-')[0], 10))
    );
    const filtered = questions.filter(q => seasonsWithAnswers.has(q.season));
    const droppedSeasons = [...new Set(questions.map(q => q.season))]
        .filter(s => !seasonsWithAnswers.has(s));

    clearLabels();
    _subjectOrder = null;  // reset when new data is loaded
    _data = { playerName, questions: filtered, pctLookup };
    renderView();

    const pctCount = filtered.filter(
        q => (`${q.season}-${q.matchDay}-${q.questionNum}`) in pctLookup
    ).length;
    const ansCount = filtered.filter(q => q.answer).length;
    const parts = [`${label || playerName}: ${filtered.length} questions.`];
    if (pctCount) parts.push(`${pctCount} with % correct data.`);
    if (ansCount) parts.push(`${ansCount} with answers.`);
    if (droppedSeasons.length) parts.push(`(Season${droppedSeasons.length > 1 ? 's' : ''} ${droppedSeasons.join(', ')} excluded — no answers yet.)`);
    setStatus(parts.join(' '), 'ok');
}

// ─── Auto-load on file selection ──────────────────────────────────────────────
document.getElementById('profile-input').addEventListener('change', async () => {
    const profileInput = document.getElementById('profile-input');
    if (!profileInput.files.length) return;
    setStatus('Parsing…', '');
    try {
        const profileText = await readFileAsText(profileInput.files[0]);
        await _loadProfileText(profileText, profileInput.files[0].name);
    } catch (err) {
        setStatus(`Error: ${err.message}`, 'error');
        console.error(err);
    }
});

// ─── Title case button ───────────────────────────────────────────────────────
document.getElementById('btn-title-case').addEventListener('click', () => {
    _titleCase = !_titleCase;
    document.getElementById('btn-title-case').classList.toggle('active', _titleCase);
    if (_data) { renderGrid(_data.questions, _data.pctLookup, _subjectOrder, _titleCase); renderLabels(); }
});

// ─── Rendering ────────────────────────────────────────────────────────────────
function renderView() {
    document.getElementById('chart-section').classList.remove('hidden');
    document.getElementById('view-toggle').classList.remove('hidden');
    renderSubjectTray();
    renderGrid(_data.questions, _data.pctLookup, _subjectOrder, _titleCase);
    renderLabels();
}

// ─── Subject tray ─────────────────────────────────────────────────────────────
function reRenderAnswers() {
    renderGrid(_data.questions, _data.pctLookup, _subjectOrder, _titleCase);
    renderLabels();
}

function renderSubjectTray() {
    const tray = document.getElementById('subject-tray');
    if (!_data) { tray.classList.add('hidden'); return; }

    const allSubjects = [...new Set(_data.questions.map(q => q.subject))].sort();
    if (_subjectOrder === null) _subjectOrder = [...allSubjects];

    const activeSet = new Set(_subjectOrder);
    tray.classList.remove('hidden');
    tray.innerHTML = '';

    // Toggle-all button
    const allActive = _subjectOrder.length === allSubjects.length;
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'tray-toggle-all';
    toggleBtn.textContent = allActive ? 'Hide all' : 'Show all';
    toggleBtn.addEventListener('click', () => {
        _subjectOrder = allActive ? [] : [...allSubjects];
        renderSubjectTray();
        reRenderAnswers();
    });
    tray.appendChild(toggleBtn);

    // One chip per subject — click to toggle shown/hidden
    for (const subj of allSubjects) {
        const active = activeSet.has(subj);
        const el = document.createElement('span');
        el.className = active ? 'tray-chip tray-chip--active' : 'tray-chip tray-chip--inactive';
        el.textContent = subj;
        el.dataset.subject = subj;
        if (active && typeof subjectColor === 'function') {
            const c = subjectColor(subj);
            el.style.borderColor = c;
            el.style.color = c;
        }
        el.addEventListener('click', () => {
            if (active) {
                _subjectOrder = _subjectOrder.filter(s => s !== subj);
            } else {
                _subjectOrder = [..._subjectOrder, subj];
            }
            renderSubjectTray();
            reRenderAnswers();
        });
        tray.appendChild(el);
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result);
        reader.onerror = () => reject(new Error(`Could not read "${file.name}"`));
        reader.readAsText(file);
    });
}

function setStatus(msg, type) {
    const el = document.getElementById('status-msg');
    el.textContent = msg;
    el.className = 'status ' + (type || '');
}

// ─── Auto-load default profile ────────────────────────────────────────────────
(async () => {
    try {
        const res = await fetch('LL%20Profile_%20HibbinsT.html');
        if (!res.ok) return; // file not present — silently skip
        const text = await res.text();
        await _loadProfileText(text, 'Default profile');
    } catch (e) {
        // Network or parse error — silently ignore so the upload UI still works
    }
})();

