'use strict';

// ─── Persistent state ─────────────────────────────────────────────────────────
let _data = null;      // { playerName, questions, pctLookup }
let _view = 'answers'; // 'answers' | 'subjectseasons' | 'timeline' | 'subjects'
let _axisFlipped = true;      // true = hard questions (low %) at top
let _subjectOrder = null;      // ordered array of active subjects for Answers view

// ─── Load button ──────────────────────────────────────────────────────────────
document.getElementById('load-btn').addEventListener('click', async () => {
    const profileInput = document.getElementById('profile-input');

    if (!profileInput.files.length) {
        setStatus('Please select a player profile HTML file.', 'error');
        return;
    }

    setStatus('Parsing files…', '');

    try {
        const profileText = await readFileAsText(profileInput.files[0]);
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

        _subjectOrder = null;  // reset when new data is loaded
        _data = { playerName, questions, pctLookup };
        renderView();

        const pctCount = questions.filter(
            q => (`${q.season}-${q.matchDay}-${q.questionNum}`) in pctLookup
        ).length;
        const ansCount = questions.filter(q => q.answer).length;
        const parts = [`${questions.length} questions in profile.`];
        if (pctCount) parts.push(`${pctCount} with % correct data.`);
        if (ansCount) parts.push(`${ansCount} with answers.`);
        setStatus(parts.join(' '), 'ok');
    } catch (err) {
        setStatus(`Error: ${err.message}`, 'error');
        console.error(err);
    }
});

// ─── View toggle buttons ──────────────────────────────────────────────────────
document.getElementById('btn-answers').addEventListener('click', () => {
    if (_view === 'answers') return;
    _view = 'answers';
    updateToggleButtons();
    if (_data) renderView();
});

document.getElementById('btn-subjectseasons').addEventListener('click', () => {
    if (_view === 'subjectseasons') return;
    _view = 'subjectseasons';
    updateToggleButtons();
    if (_data) renderView();
});

document.getElementById('btn-timeline').addEventListener('click', () => {
    if (_view === 'timeline') return;
    _view = 'timeline';
    updateToggleButtons();
    if (_data) renderView();
});

document.getElementById('btn-subjects').addEventListener('click', () => {
    if (_view === 'subjects') return;
    _view = 'subjects';
    updateToggleButtons();
    if (_data) renderView();
});

// ─── Flip axis button ─────────────────────────────────────────────────────────
document.getElementById('btn-flip-axis').addEventListener('click', () => {
    _axisFlipped = !_axisFlipped;
    updateFlipButton();
    if (_data && (_view === 'timeline' || _view === 'subjectseasons')) renderView();
});

// ─── Rendering ────────────────────────────────────────────────────────────────
function renderView() {
    document.getElementById('chart-section').classList.remove('hidden');
    document.getElementById('view-toggle').classList.remove('hidden');
    if (_view === 'answers') {
        renderSubjectTray();
        renderAnswers(_data.questions, _data.pctLookup, _axisFlipped, _subjectOrder);
    } else {
        document.getElementById('subject-tray').classList.add('hidden');
        if (_view === 'subjectseasons') {
            renderBySubjectSeason(_data.questions, _data.pctLookup, _axisFlipped);
        } else if (_view === 'timeline') {
            renderTimeline(_data.questions, _data.pctLookup, _axisFlipped);
        } else {
            renderChart(_data.questions, _data.pctLookup);
        }
    }
}

function updateToggleButtons() {
    document.getElementById('btn-answers').classList.toggle('active', _view === 'answers');
    document.getElementById('btn-subjectseasons').classList.toggle('active', _view === 'subjectseasons');
    document.getElementById('btn-timeline').classList.toggle('active', _view === 'timeline');
    document.getElementById('btn-subjects').classList.toggle('active', _view === 'subjects');
    updateFlipButton();
}

function updateFlipButton() {
    const btn = document.getElementById('btn-flip-axis');
    const axisViews = _view === 'answers' || _view === 'timeline' || _view === 'subjectseasons';
    btn.style.display = axisViews ? '' : 'none';
    btn.classList.toggle('active', !_axisFlipped); // active = "normal" (not flipped)
    btn.title = _axisFlipped
        ? 'Currently: hard questions at top — click to put easy questions at top'
        : 'Currently: easy questions at top — click to put hard questions at top';
}

// ─── Subject tray ─────────────────────────────────────────────────────────────
function reRenderAnswers() {
    renderAnswers(_data.questions, _data.pctLookup, _axisFlipped, _subjectOrder);
}

function renderSubjectTray() {
    const tray = document.getElementById('subject-tray');
    if (!_data) { tray.classList.add('hidden'); return; }

    const allSubjects = [...new Set(_data.questions.map(q => q.subject))].sort();
    if (_subjectOrder === null) _subjectOrder = [];

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

