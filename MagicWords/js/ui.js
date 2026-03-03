/**
 * UI controller for MagicWords.
 *
 * Layout:
 *   Syntax tree grows upward from the current sentence.
 *   Typed text sits on the current line.
 *   Suggestions appear directly below the word being typed.
 *
 * Shift+Tab toggles raw mode (direct character input, no matching).
 */

import { loadDictionary } from './dictionary.js';
import { findMatches } from './matcher.js';
import { tagWord, inferTense } from './grammar.js';
import { buildTree, splitClauses } from './parser.js';

// ═══════════════════════════════════════════════════════════════════════════
// POS → CSS colour variable mapping
// ═══════════════════════════════════════════════════════════════════════════

const POS_COLOR = {
    NOUN: 'var(--pos-noun)',
    PRON: 'var(--pos-pron)',
    ADJ: 'var(--pos-adj)',
    DET: 'var(--pos-det)',
    NUM: 'var(--pos-num)',
    ADV: 'var(--pos-adv)',
    VERB: 'var(--pos-verb)',
    AUX: 'var(--pos-aux)',
    PREP: 'var(--pos-prep)',
    CONJ: 'var(--pos-conj)',
    INTJ: 'var(--pos-intj)',
    PART: 'var(--pos-part)',
    SBAR: 'var(--pos-sbar)',
    NP: 'var(--pos-noun)',
    VP: 'var(--pos-verb)',
    PP: 'var(--pos-prep)',
    S: 'var(--pos-default)',
};

function posColor(pos) {
    return POS_COLOR[pos] || 'var(--pos-default)';
}

// ═══════════════════════════════════════════════════════════════════════════
// DOM HANDLES
// ═══════════════════════════════════════════════════════════════════════════

const spacerEl = document.getElementById('spacer');
const completedAboveEl = document.getElementById('completed-above');
const completedBelowEl = document.getElementById('completed-below');
const priorClausesEl = document.getElementById('prior-clauses');
const committedEl = document.getElementById('committed');
const bufferInlineEl = document.getElementById('buffer-inline');
const caretEl = document.getElementById('caret');
const ghostCompEl = document.getElementById('ghost-completion');
const inlineInfoEl = document.getElementById('inline-info');
const currentLineWrap = document.getElementById('current-line-wrap');
const currentSentenceNumEl = document.getElementById('current-sentence-num');
const posRowEl = document.getElementById('pos-row');
const committedAfterEl = document.getElementById('committed-after');
const suggestionsEl = document.getElementById('suggestions');
const syntaxTreeEl = document.getElementById('syntax-tree');
const promptEl = document.getElementById('prompt');
const statusEl = document.getElementById('status');
const posToggleEl = document.getElementById('pos-toggle');
const alignToggleEl = document.getElementById('align-toggle');

// ═══════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════

/** @type {import('./dictionary.js').Dictionary | null} */
let dict = null;

/** Keystroke buffer: array of { char, timestamp }. */
let buffer = [];

/** Words committed in the current sentence. */
let currentSentenceWords = [];

/** POS tags for the current sentence (parallel to currentSentenceWords). */
let currentSentencePOS = [];

/** All completed sentences: { words: string[], pos: string[] } */
let completedSentences = [];

/** Current matches for the buffer. */
let currentMatches = [];

/** Which alternative candidate is selected (0 = top/inline). */
let selectedCandidate = 0;

/** Raw mode: type characters directly, no prediction. Toggled by Shift+Tab. */
let rawMode = false;

/** Raw-mode accumulated text for the current word. */
let rawBuffer = '';

/** Has user started typing at all? (controls prompt visibility) */
let hasStarted = false;

/** Whether to colour the text itself by POS (true) or only labels (false). */
let colorTextMode = false;

/** Set of expanded tree node paths (for collapsible bar trees). */
let expandedTreePaths = new Set(['']);

/** Editing slot: sentences before this index appear above, the rest below. */
let activeSentenceSlot = 0;

/** Currently hovered word element (for replacement editing). */
let hoveredWordEl = null;
let hoveredSentenceIdx = -1;
let hoveredWordIdx = -1;

/** Insertion point in the current sentence (null = end). */
let insertionPoint = null;

/** Whether a sentence is actively being edited (vs. passive viewing mode). */
let sentenceActive = true;

/** Index of the currently selected/active word in the current sentence. */
let activeWordIdx = null;

/** Tense popover state: { wordIdx, sentenceIdx, forms, currentIdx, el } or null. */
let tenseHoverState = null;

const tensePopoverEl = document.getElementById('tense-popover');
const definitionPanelEl = document.getElementById('definition-panel');

/** Cache for fetched definitions: word → { meanings, phonetic } or null. */
const definitionCache = new Map();

/** Currently displayed definition word. */
let definitionWord = null;

// ═══════════════════════════════════════════════════════════════════════════
// RENDERING
// ═══════════════════════════════════════════════════════════════════════════

function render() {
    // Clear hover state — renderCompleted() destroys old spans so
    // mouseleave never fires and hoveredWordEl would go stale.
    hoveredWordEl = null;
    hoveredSentenceIdx = -1;
    hoveredWordIdx = -1;

    if (sentenceActive) {
        currentLineWrap.style.display = '';
        renderCurrentLine();
        renderSyntaxTree();
        renderSuggestions();
    } else {
        currentLineWrap.style.display = 'none';
        syntaxTreeEl.innerHTML = '';
        priorClausesEl.innerHTML = '';
    }
    renderCompleted();
    adjustVerticalPosition();
    if (sentenceActive) {
        requestAnimationFrame(() => positionBars());
    }
}

/**
 * Keep #current-line-wrap pinned at 1/3 from the viewport top (2/3 up
 * the screen).  Adjusts the spacer height dynamically; when content
 * above the line exceeds the target, scrolls the page instead.
 */
function adjustVerticalPosition() {
    const targetY = window.innerHeight / 3;

    // Collapse spacer to measure natural layout position
    spacerEl.style.height = '0px';

    const naturalY = currentLineWrap.getBoundingClientRect().top;
    const needed = targetY - naturalY;

    if (needed > 0) {
        spacerEl.style.height = needed + 'px';
    } else {
        // Content taller than targetY – scroll to keep line at target
        const currentTop = currentLineWrap.getBoundingClientRect().top;
        if (Math.abs(currentTop - targetY) > 5) {
            window.scrollTo(0, window.scrollY + (currentTop - targetY));
        }
    }
}

/**
 * Render completed sentences: earlier ones above the current line,
 * later ones below (only visible when editing within the sequence).
 * Trees are NOT shown for completed sentences — only for the current one.
 */
function renderCompleted() {
    completedAboveEl.innerHTML = '';
    completedBelowEl.innerHTML = '';

    for (let si = 0; si < completedSentences.length; si++) {
        let targetEl, displayNum;
        if (sentenceActive) {
            targetEl = si < activeSentenceSlot ? completedAboveEl : completedBelowEl;
            displayNum = si < activeSentenceSlot ? si + 1 : si + 2;
        } else {
            targetEl = completedAboveEl;
            displayNum = si + 1;
        }
        const { words, pos } = completedSentences[si];

        const container = document.createElement('div');
        container.className = 'completed-sentence';

        // ── Sentence words row ───────────────────────────────────
        const row = document.createElement('div');
        row.className = 'sentence-row';

        const num = document.createElement('span');
        num.className = 'sentence-num';
        num.textContent = String(displayNum);
        row.appendChild(num);

        const p = document.createElement('p');
        p.className = 'sentence';
        // Compute clause breaks for line-break display
        let sentClauseBreaks = new Set();
        if (words.length > 1) {
            const sentTree = buildTree(words, pos);
            if (sentTree) {
                const sentClauses = splitClauses(sentTree);
                if (sentClauses.length > 1) {
                    for (let ci = 1; ci < sentClauses.length; ci++) {
                        const firstIdx = Math.min(...sentClauses[ci].wordIndices);
                        sentClauseBreaks.add(firstIdx);
                    }
                }
            }
        }

        for (let wi = 0; wi < words.length; wi++) {
            if (sentClauseBreaks.has(wi)) {
                p.appendChild(document.createElement('br'));
            } else if (wi > 0) {
                p.appendChild(document.createTextNode(' '));
            }
            const span = document.createElement('span');
            span.className = 'word';
            span.textContent = words[wi];
            span.dataset.sentence = String(si);
            span.dataset.word = String(wi);
            if (colorTextMode && pos[wi]) {
                span.style.color = posColor(pos[wi]);
            }
            span.addEventListener('mouseenter', () => onWordHoverEnter(span, si, wi));
            span.addEventListener('mouseleave', () => onWordHoverLeave(span));
            span.addEventListener('click', () => {
                sentenceActive = true;
                reenterSentence(si, wi);
            });
            // Verb tense hover: wheel handler
            if (pos[wi] === 'VERB' || pos[wi] === 'AUX') {
                span.addEventListener('wheel', (e) => {
                    if (!tenseHoverState) return;
                    e.preventDefault();
                    cycleTense(e.deltaY > 0 ? 1 : -1);
                }, { passive: false });
            }
            p.appendChild(span);
        }
        row.appendChild(p);
        container.appendChild(row);
        targetEl.appendChild(container);
    }
}

/**
 * Render the current line: committed words + inline keystrokes + caret.
 * For multi-clause sentences, prior (completed) clauses go into
 * #prior-clauses as text only. Active clause words split at insertion point.
 */
function renderCurrentLine() {
    priorClausesEl.innerHTML = '';
    committedEl.innerHTML = '';
    committedAfterEl.innerHTML = '';

    const words = currentSentenceWords;
    const pos = currentSentencePOS;

    // Effective insertion point
    const ip = (insertionPoint !== null && insertionPoint <= words.length)
        ? insertionPoint : words.length;

    // Parse clauses for the current sentence
    let clauses = null;
    if (words.length > 1) {
        const tree = buildTree(words, pos);
        if (tree) {
            const parsed = splitClauses(tree);
            if (parsed.length > 1) clauses = parsed;
        }
    }

    // Helper to create a word span with click + hover handlers
    const makeWordSpan = (wi) => {
        const span = document.createElement('span');
        span.className = 'committed-word';
        span.dataset.idx = String(wi);
        span.textContent = words[wi];
        if (activeWordIdx === wi) {
            span.classList.add('active-word');
            span.classList.add('editing');
        }
        if (colorTextMode && pos[wi]) {
            span.style.color = posColor(pos[wi]);
        }
        span.addEventListener('mouseenter', () => onCurrentWordHoverEnter(span, wi));
        span.addEventListener('mouseleave', () => onCurrentWordHoverLeave(span));
        span.addEventListener('click', (e) => {
            e.stopPropagation();
            activeWordIdx = wi;
            setInsertionPoint(wi + 1);
            // Fetch and show definition for the clicked word
            showDefinition(words[wi]);
        });
        // Verb tense hover: wheel handler
        if (pos[wi] === 'VERB' || pos[wi] === 'AUX') {
            span.addEventListener('wheel', (e) => {
                if (!tenseHoverState) return;
                e.preventDefault();
                cycleTense(e.deltaY > 0 ? 1 : -1);
            }, { passive: false });
        }
        return span;
    };

    if (clauses && clauses.length > 1) {
        // ── Prior clauses: just text, no trees ──────────────
        for (let ci = 0; ci < clauses.length - 1; ci++) {
            const clause = clauses[ci];
            const block = document.createElement('div');
            block.className = 'prior-clause';

            const textLine = document.createElement('div');
            textLine.className = 'prior-clause-text';
            for (let j = 0; j < clause.wordIndices.length; j++) {
                const wi = clause.wordIndices[j];
                if (j > 0) textLine.appendChild(document.createTextNode(' '));
                textLine.appendChild(makeWordSpan(wi));
            }

            block.appendChild(textLine);
            priorClausesEl.appendChild(block);
        }

        // ── Active clause words → split at insertion point ──
        const activeCl = clauses[clauses.length - 1];
        for (let j = 0; j < activeCl.wordIndices.length; j++) {
            const wi = activeCl.wordIndices[j];
            const targetEl = (wi < ip) ? committedEl : committedAfterEl;
            if (targetEl.childNodes.length > 0) {
                targetEl.appendChild(document.createTextNode(' '));
            }
            targetEl.appendChild(makeWordSpan(wi));
        }
    } else {
        // ── Single clause: split at insertion point ─────────
        for (let i = 0; i < words.length; i++) {
            const targetEl = (i < ip) ? committedEl : committedAfterEl;
            if (targetEl.childNodes.length > 0) {
                targetEl.appendChild(document.createTextNode(' '));
            }
            targetEl.appendChild(makeWordSpan(i));
        }
    }

    // Trailing space after committed words (before buffer/caret)
    if (committedEl.childNodes.length > 0) {
        committedEl.appendChild(document.createTextNode(' '));
    }

    // Leading space in committed-after (after ghost/caret)
    if (committedAfterEl.childNodes.length > 0) {
        committedAfterEl.insertBefore(
            document.createTextNode(' '), committedAfterEl.firstChild);
    }

    // Update current sentence number
    if (words.length > 0 || buffer.length > 0 || rawBuffer.length > 0) {
        currentSentenceNumEl.textContent = String(activeSentenceSlot + 1);
    } else {
        currentSentenceNumEl.textContent = '';
    }

    // Is the cursor in the middle of the sentence?
    const isInsertingInMiddle = ip < words.length;

    // Inline keystrokes — coloured by top match POS
    const topPOS = (!rawMode && currentMatches.length > 0)
        ? (currentMatches[selectedCandidate] || currentMatches[0]).pos
        : null;

    if (rawMode && rawBuffer.length > 0) {
        bufferInlineEl.textContent = capitalizeIfNeeded(rawBuffer);
        bufferInlineEl.style.color = '';
    } else if (buffer.length > 0) {
        const typed = buffer.map(k => k.char).join('');
        bufferInlineEl.textContent = capitalizeIfNeeded(typed);
        bufferInlineEl.style.color = topPOS ? posColor(topPOS) : '';
    } else {
        bufferInlineEl.textContent = '';
        bufferInlineEl.style.color = '';
    }

    // Ghost completion (only at end, not when inserting in middle)
    if (!rawMode && buffer.length > 0 && currentMatches.length > 0 && !isInsertingInMiddle) {
        const top = currentMatches[selectedCandidate] || currentMatches[0];
        const full = capitalizeIfNeeded(top.word);
        const typed = capitalizeIfNeeded(buffer.map(k => k.char).join(''));
        const rest = full.slice(typed.length);
        ghostCompEl.textContent = rest.length > 0 ? rest : '';
        ghostCompEl.style.color = posColor(top.pos);
        ghostCompEl.style.opacity = '0.45';
    } else {
        ghostCompEl.textContent = '';
        ghostCompEl.style.color = '';
        ghostCompEl.style.opacity = '';
    }

    // Inline info — tense (hide when inserting in middle)
    if (!isInsertingInMiddle && currentSentenceWords.length > 0 && buffer.length === 0) {
        const tense = inferTense(currentSentenceWords, currentSentencePOS);
        inlineInfoEl.textContent = tense !== 'UNKNOWN' ? tense : '';
    } else {
        inlineInfoEl.textContent = '';
    }
}

/**
 * Render suggested alternatives below the current word being typed.
 * Each suggestion is plain text, left-aligned to the buffer start.
 */
function renderSuggestions() {
    suggestionsEl.innerHTML = '';
    suggestionsEl.style.marginLeft = '';

    // Show prompt when nothing is happening
    if (!hasStarted) {
        suggestionsEl.appendChild(promptEl);
        promptEl.classList.remove('hidden');
        return;
    }

    if (rawMode || currentMatches.length <= 1 || buffer.length === 0) return;

    const max = Math.min(currentMatches.length, 8);

    for (let i = 1; i < max; i++) {
        const m = currentMatches[i];
        const div = document.createElement('div');
        div.className = i === selectedCandidate ? 'suggestion selected' : 'suggestion';
        div.dataset.index = String(i);
        div.textContent = capitalizeIfNeeded(m.word);
        div.style.color = posColor(m.pos);
        div.addEventListener('click', () => commitWord(i));
        suggestionsEl.appendChild(div);
    }

    // Position aligned to the start of the current word
    requestAnimationFrame(() => positionSuggestionsUnderWord());
}

/** Align the suggestions dropdown under the current word being typed. */
function positionSuggestionsUnderWord() {
    const wrapRect = currentLineWrap.getBoundingClientRect();
    const bufRect = bufferInlineEl.getBoundingClientRect();
    if (bufRect.width === 0) return;
    const offset = bufRect.left - wrapRect.left;
    suggestionsEl.style.marginLeft = offset + 'px';
}

/** Capitalize word if needed (sentence-initial, standalone 'I', I-contractions). */
function capitalizeIfNeeded(word) {
    if (currentSentenceWords.length === 0) {
        return word.charAt(0).toUpperCase() + word.slice(1);
    }
    // Always capitalize standalone 'I' and I-contractions (I'm, I've, I'll, I'd)
    const lc = word.toLowerCase();
    if (lc === 'i' || /^i[''\u2019]/.test(lc)) {
        return 'I' + word.slice(1);
    }
    return word;
}

// ═══════════════════════════════════════════════════════════════════════════
// LABEL MAPS
// ═══════════════════════════════════════════════════════════════════════════

/** Full human-readable names for phrase labels. */
const FULL_LABEL = {
    NP: 'Noun Phrase',
    VP: 'Verb Phrase',
    PP: 'Prepositional Phrase',
    ADVP: 'Adverb Phrase',
    ADJP: 'Adjective Phrase',
    S: 'Clause',
    SBAR: 'Clause',
    NOUN: 'Noun',
    PRON: 'Pronoun',
    VERB: 'Verb',
    AUX: 'Auxiliary',
    ADJ: 'Adjective',
    ADV: 'Adverb',
    DET: 'Determiner',
    PREP: 'Preposition',
    CONJ: 'Conjunction',
    PART: 'Particle',
    NUM: 'Number',
    INTJ: 'Interjection',
    PUNCT: 'Punctuation',
};

/** Return the best label text for a bar, using full name if it fits. */
function labelText(abbr) {
    return FULL_LABEL[abbr] || abbr;
}

// ═══════════════════════════════════════════════════════════════════════════
// VERB CONJUGATION + TENSE POPOVER
// ═══════════════════════════════════════════════════════════════════════════

/** Irregular verb table: base → { past, pp, s (3sg), ing }. */
const IRREG = {
    'be': { past: 'was', pp: 'been', s: 'is', ing: 'being' },
    'have': { past: 'had', pp: 'had', s: 'has', ing: 'having' },
    'do': { past: 'did', pp: 'done', s: 'does', ing: 'doing' },
    'go': { past: 'went', pp: 'gone', s: 'goes', ing: 'going' },
    'see': { past: 'saw', pp: 'seen', s: 'sees', ing: 'seeing' },
    'take': { past: 'took', pp: 'taken', s: 'takes', ing: 'taking' },
    'get': { past: 'got', pp: 'gotten', s: 'gets', ing: 'getting' },
    'make': { past: 'made', pp: 'made', s: 'makes', ing: 'making' },
    'come': { past: 'came', pp: 'come', s: 'comes', ing: 'coming' },
    'know': { past: 'knew', pp: 'known', s: 'knows', ing: 'knowing' },
    'think': { past: 'thought', pp: 'thought', s: 'thinks', ing: 'thinking' },
    'say': { past: 'said', pp: 'said', s: 'says', ing: 'saying' },
    'give': { past: 'gave', pp: 'given', s: 'gives', ing: 'giving' },
    'find': { past: 'found', pp: 'found', s: 'finds', ing: 'finding' },
    'tell': { past: 'told', pp: 'told', s: 'tells', ing: 'telling' },
    'become': { past: 'became', pp: 'become', s: 'becomes', ing: 'becoming' },
    'write': { past: 'wrote', pp: 'written', s: 'writes', ing: 'writing' },
    'run': { past: 'ran', pp: 'run', s: 'runs', ing: 'running' },
    'eat': { past: 'ate', pp: 'eaten', s: 'eats', ing: 'eating' },
    'begin': { past: 'began', pp: 'begun', s: 'begins', ing: 'beginning' },
    'break': { past: 'broke', pp: 'broken', s: 'breaks', ing: 'breaking' },
    'speak': { past: 'spoke', pp: 'spoken', s: 'speaks', ing: 'speaking' },
    'choose': { past: 'chose', pp: 'chosen', s: 'chooses', ing: 'choosing' },
    'drive': { past: 'drove', pp: 'driven', s: 'drives', ing: 'driving' },
    'fly': { past: 'flew', pp: 'flown', s: 'flies', ing: 'flying' },
    'grow': { past: 'grew', pp: 'grown', s: 'grows', ing: 'growing' },
    'draw': { past: 'drew', pp: 'drawn', s: 'draws', ing: 'drawing' },
    'throw': { past: 'threw', pp: 'thrown', s: 'throws', ing: 'throwing' },
    'fall': { past: 'fell', pp: 'fallen', s: 'falls', ing: 'falling' },
    'feel': { past: 'felt', pp: 'felt', s: 'feels', ing: 'feeling' },
    'keep': { past: 'kept', pp: 'kept', s: 'keeps', ing: 'keeping' },
    'leave': { past: 'left', pp: 'left', s: 'leaves', ing: 'leaving' },
    'meet': { past: 'met', pp: 'met', s: 'meets', ing: 'meeting' },
    'pay': { past: 'paid', pp: 'paid', s: 'pays', ing: 'paying' },
    'sell': { past: 'sold', pp: 'sold', s: 'sells', ing: 'selling' },
    'send': { past: 'sent', pp: 'sent', s: 'sends', ing: 'sending' },
    'sit': { past: 'sat', pp: 'sat', s: 'sits', ing: 'sitting' },
    'stand': { past: 'stood', pp: 'stood', s: 'stands', ing: 'standing' },
    'win': { past: 'won', pp: 'won', s: 'wins', ing: 'winning' },
    'build': { past: 'built', pp: 'built', s: 'builds', ing: 'building' },
    'buy': { past: 'bought', pp: 'bought', s: 'buys', ing: 'buying' },
    'catch': { past: 'caught', pp: 'caught', s: 'catches', ing: 'catching' },
    'cut': { past: 'cut', pp: 'cut', s: 'cuts', ing: 'cutting' },
    'hold': { past: 'held', pp: 'held', s: 'holds', ing: 'holding' },
    'lose': { past: 'lost', pp: 'lost', s: 'loses', ing: 'losing' },
    'put': { past: 'put', pp: 'put', s: 'puts', ing: 'putting' },
    'read': { past: 'read', pp: 'read', s: 'reads', ing: 'reading' },
    'spend': { past: 'spent', pp: 'spent', s: 'spends', ing: 'spending' },
    'teach': { past: 'taught', pp: 'taught', s: 'teaches', ing: 'teaching' },
    'bring': { past: 'brought', pp: 'brought', s: 'brings', ing: 'bringing' },
    'fight': { past: 'fought', pp: 'fought', s: 'fights', ing: 'fighting' },
    'hear': { past: 'heard', pp: 'heard', s: 'hears', ing: 'hearing' },
    'lead': { past: 'led', pp: 'led', s: 'leads', ing: 'leading' },
    'show': { past: 'showed', pp: 'shown', s: 'shows', ing: 'showing' },
    'sing': { past: 'sang', pp: 'sung', s: 'sings', ing: 'singing' },
    'sleep': { past: 'slept', pp: 'slept', s: 'sleeps', ing: 'sleeping' },
    'swim': { past: 'swam', pp: 'swum', s: 'swims', ing: 'swimming' },
    'wear': { past: 'wore', pp: 'worn', s: 'wears', ing: 'wearing' },
    'rise': { past: 'rose', pp: 'risen', s: 'rises', ing: 'rising' },
    'ride': { past: 'rode', pp: 'ridden', s: 'rides', ing: 'riding' },
    'shake': { past: 'shook', pp: 'shaken', s: 'shakes', ing: 'shaking' },
    'forget': { past: 'forgot', pp: 'forgotten', s: 'forgets', ing: 'forgetting' },
    'hide': { past: 'hid', pp: 'hidden', s: 'hides', ing: 'hiding' },
    'blow': { past: 'blew', pp: 'blown', s: 'blows', ing: 'blowing' },
    'strike': { past: 'struck', pp: 'struck', s: 'strikes', ing: 'striking' },
    'wake': { past: 'woke', pp: 'woken', s: 'wakes', ing: 'waking' },
    'drink': { past: 'drank', pp: 'drunk', s: 'drinks', ing: 'drinking' },
    'lie': { past: 'lay', pp: 'lain', s: 'lies', ing: 'lying' },
    'ring': { past: 'rang', pp: 'rung', s: 'rings', ing: 'ringing' },
    'bite': { past: 'bit', pp: 'bitten', s: 'bites', ing: 'biting' },
    'set': { past: 'set', pp: 'set', s: 'sets', ing: 'setting' },
    'let': { past: 'let', pp: 'let', s: 'lets', ing: 'letting' },
    'hurt': { past: 'hurt', pp: 'hurt', s: 'hurts', ing: 'hurting' },
    'hit': { past: 'hit', pp: 'hit', s: 'hits', ing: 'hitting' },
    'shut': { past: 'shut', pp: 'shut', s: 'shuts', ing: 'shutting' },
};

/** Reverse lookup: inflected form → base word. */
const FORM_TO_BASE = new Map();
for (const [base, forms] of Object.entries(IRREG)) {
    for (const form of [base, forms.past, forms.pp, forms.s, forms.ing]) {
        if (!FORM_TO_BASE.has(form)) FORM_TO_BASE.set(form, base);
    }
}

/** Aux paradigms for cycling (separate from main verbs). */
const AUX_PARADIGMS = {
    'is': ['is', 'was', 'will be'],
    'am': ['am', 'was', 'will be'],
    'are': ['are', 'were', 'will be'],
    'was': ['was', 'is', 'will be'],
    'were': ['were', 'are', 'will be'],
    'has': ['has', 'had', 'will have'],
    'have': ['have', 'had', 'will have'],
    'had': ['had', 'has', 'will have'],
    'do': ['do', 'did', 'will do'],
    'does': ['does', 'did', 'will do'],
    'did': ['did', 'do', 'will do'],
    'will': ['will', 'would', 'shall'],
    'would': ['would', 'will', 'could'],
    'can': ['can', 'could', 'will'],
    'could': ['could', 'can', 'would'],
    'shall': ['shall', 'should', 'will'],
    'should': ['should', 'shall', 'would'],
    'may': ['may', 'might', 'can'],
    'might': ['might', 'may', 'could'],
    'must': ['must', 'had to', 'will have to'],
};

/** Labels for tense forms. */
const TENSE_LABELS = ['Base', '3sg Present', 'Past', 'Progressive'];
const AUX_LABELS = ['Present', 'Past', 'Future/Alt'];

/** Modal families for VP-level tense cycling. */
const MODALS = new Set(['can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must']);
const MODAL_FUTURE = {
    'can': 'can', 'could': 'can', 'will': 'will', 'would': 'will',
    'shall': 'shall', 'should': 'shall', 'may': 'may', 'might': 'may', 'must': 'must',
};
const BE_FORMS_SET = new Set(['be', 'is', 'am', 'are', 'was', 'were', 'been', 'being']);
const HAVE_FORMS_SET = new Set(['have', 'has', 'had']);

/** Get base form of a verb from any inflected form. */
function getVerbBase(word) {
    const lc = word.toLowerCase();
    if (FORM_TO_BASE.has(lc)) return FORM_TO_BASE.get(lc);

    // Regular verb heuristics
    if (lc.endsWith('ied')) return lc.slice(0, -3) + 'y';
    if (lc.endsWith('ing')) {
        const stem = lc.slice(0, -3);
        if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
            return stem.slice(0, -1);
        }
        if (stem.length >= 2 && !/[aeiou]$/.test(stem)) {
            return stem + 'e';
        }
        return stem;
    }
    if (lc.endsWith('ed')) {
        const stem = lc.slice(0, -2);
        if (stem.endsWith('i')) return stem.slice(0, -1) + 'y';
        if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2]) return stem.slice(0, -1);
        if (stem.length > 0 && !stem.endsWith('e')) return stem;
        return lc.slice(0, -1);
    }
    if (lc.endsWith('ies')) return lc.slice(0, -3) + 'y';
    if (lc.endsWith('es') && !lc.endsWith('ses') && !lc.endsWith('zes'))
        return lc.slice(0, -2);
    if (lc.endsWith('s') && !lc.endsWith('ss'))
        return lc.slice(0, -1);
    return lc;
}

/** Conjugate a verb base to all forms. */
function conjugateVerb(base) {
    if (IRREG[base]) {
        const f = IRREG[base];
        return [
            { label: TENSE_LABELS[0], word: base },
            { label: TENSE_LABELS[1], word: f.s },
            { label: TENSE_LABELS[2], word: f.past },
            { label: TENSE_LABELS[3], word: f.ing },
        ];
    }
    let s, past, ing;
    if (/(?:sh|ch|x|z|s)$/.test(base)) s = base + 'es';
    else if (/[^aeiou]y$/.test(base)) s = base.slice(0, -1) + 'ies';
    else s = base + 's';

    if (base.endsWith('e')) past = base + 'd';
    else if (/[^aeiou]y$/.test(base)) past = base.slice(0, -1) + 'ied';
    else past = base + 'ed';

    if (base.endsWith('ie')) ing = base.slice(0, -2) + 'ying';
    else if (base.endsWith('e') && !base.endsWith('ee')) ing = base.slice(0, -1) + 'ing';
    else ing = base + 'ing';

    return [
        { label: TENSE_LABELS[0], word: base },
        { label: TENSE_LABELS[1], word: s },
        { label: TENSE_LABELS[2], word: past },
        { label: TENSE_LABELS[3], word: ing },
    ];
}

/** Get tense forms for any verb/aux word. Returns { forms, currentIdx }. */
function getTenseForms(word, posTag) {
    const lc = word.toLowerCase().replace(/[.,!?]+$/, '');

    // Auxiliary paradigm
    if (posTag === 'AUX' && AUX_PARADIGMS[lc]) {
        const paradigm = AUX_PARADIGMS[lc];
        const forms = paradigm.map((w, i) => ({ label: AUX_LABELS[i] || 'Alt', word: w }));
        const currentIdx = 0;
        return { forms, currentIdx };
    }

    // Main verb conjugation
    const base = getVerbBase(lc);
    const forms = conjugateVerb(base);
    let currentIdx = forms.findIndex(f => f.word === lc);
    if (currentIdx < 0) currentIdx = 0;
    return { forms, currentIdx };
}

/** Show the tense popover near an element. */
function showTensePopover(wordIdx, sentenceIdx, anchorEl) {
    const words = sentenceIdx >= 0 ? completedSentences[sentenceIdx].words : currentSentenceWords;
    const posTags = sentenceIdx >= 0 ? completedSentences[sentenceIdx].pos : currentSentencePOS;
    const word = words[wordIdx];
    const posTag = posTags[wordIdx];
    if (!word) return;
    if (posTag !== 'VERB' && posTag !== 'AUX') return;

    const { forms, currentIdx } = getTenseForms(word, posTag);
    if (forms.length < 2) return;

    tenseHoverState = { wordIdx, sentenceIdx, forms, currentIdx, el: anchorEl };
    renderTensePopoverContent();

    // Position near the anchor
    const rect = anchorEl.getBoundingClientRect();
    tensePopoverEl.style.left = rect.left + 'px';
    tensePopoverEl.style.top = (rect.bottom + 6) + 'px';
    tensePopoverEl.classList.add('visible');
}

/** Update popover content to reflect current tense selection. */
function renderTensePopoverContent() {
    if (!tenseHoverState) return;
    const { forms, currentIdx } = tenseHoverState;

    tensePopoverEl.innerHTML = '';
    for (let i = 0; i < forms.length; i++) {
        const div = document.createElement('div');
        div.className = 'tense-item' + (i === currentIdx ? ' active' : '');
        const lbl = document.createElement('span');
        lbl.className = 'tense-label';
        lbl.textContent = forms[i].label;
        const w = document.createElement('span');
        w.className = 'tense-word';
        w.textContent = forms[i].word;
        div.appendChild(lbl);
        div.appendChild(w);
        tensePopoverEl.appendChild(div);
    }
    const hint = document.createElement('span');
    hint.className = 'tense-hint';
    hint.textContent = 'scroll to change';
    tensePopoverEl.appendChild(hint);
}

/** Close the tense popover. */
function closeTensePopover() {
    tenseHoverState = null;
    tensePopoverEl.classList.remove('visible');
    tensePopoverEl.innerHTML = '';
}

/** Cycle tense form by direction (+1 or -1). Updates word in-place. */
function cycleTense(direction) {
    if (!tenseHoverState) return;
    const { forms, currentIdx, wordIdx, sentenceIdx, el } = tenseHoverState;
    const newIdx = (currentIdx + direction + forms.length) % forms.length;
    tenseHoverState.currentIdx = newIdx;

    const newWord = forms[newIdx].word;

    // Update the data array
    if (sentenceIdx >= 0) {
        const s = completedSentences[sentenceIdx];
        const oldWord = s.words[wordIdx];
        const trailing = oldWord.match(/[.,!?]+$/);
        s.words[wordIdx] = newWord + (trailing ? trailing[0] : '');
    } else {
        const oldWord = currentSentenceWords[wordIdx];
        const trailing = oldWord.match(/[.,!?]+$/);
        currentSentenceWords[wordIdx] = newWord + (trailing ? trailing[0] : '');
    }

    // Update DOM directly (avoid full re-render which loses hover)
    if (el && el.tagName) {
        const oldText = el.textContent;
        const trailing = oldText.match(/[.,!?]+$/);
        el.textContent = newWord + (trailing ? trailing[0] : '');
    }

    renderTensePopoverContent();
}

// ═══════════════════════════════════════════════════════════════════════════
// VP-LEVEL TENSE CYCLING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Analyse the verb chain within a VP bracket and return tense alternatives.
 * Each alternative is an array of words that replace the chain.
 * Returns null if the pattern is unrecognised (falls back to word-level).
 */
function getVPChainForms(vpWordIndices, words, posTags) {
    const chainIndices = vpWordIndices.filter(i => posTags[i] === 'AUX' || posTags[i] === 'VERB');
    if (chainIndices.length === 0) return null;

    const chainWords = chainIndices.map(i => words[i].toLowerCase().replace(/[.,!?]+$/, ''));
    const first = chainWords[0];

    // Helper: get pp for a base verb
    const pp = (base) => IRREG[base] ? IRREG[base].pp : (base.endsWith('e') ? base + 'd' : base + 'ed');
    const ing = (base) => IRREG[base] ? IRREG[base].ing : (base.endsWith('e') && !base.endsWith('ee') ? base.slice(0, -1) + 'ing' : base + 'ing');
    const s3 = (base) => IRREG[base] ? IRREG[base].s : (/(?:sh|ch|x|z|s)$/.test(base) ? base + 'es' : /[^aeiou]y$/.test(base) ? base.slice(0, -1) + 'ies' : base + 's');
    const past = (base) => IRREG[base] ? IRREG[base].past : (base.endsWith('e') ? base + 'd' : /[^aeiou]y$/.test(base) ? base.slice(0, -1) + 'ied' : base + 'ed');

    // ── Single verb: "runs", "ate", "sleeping" ──────────────
    if (chainIndices.length === 1) {
        const base = getVerbBase(first);
        return {
            labels: ['Present', 'Past', 'Future'],
            chains: [
                [s3(base)],
                [past(base)],
                ['will', base],
            ],
            indices: chainIndices,
            currentIdx: first === past(base) ? 1 : 0,
        };
    }

    // ── Modal + base: "should be", "can run" ────────────────
    if (MODALS.has(first) && chainWords.length === 2) {
        const mainBase = getVerbBase(chainWords[1]);
        const futureModal = MODAL_FUTURE[first] || first;
        return {
            labels: ['Present', 'Past', 'Future'],
            chains: [
                [first, mainBase],
                [first, 'have', pp(mainBase)],
                [futureModal, mainBase],
            ],
            indices: chainIndices,
            currentIdx: 0,
        };
    }

    // ── Modal + have + pp: "should have been" ───────────────
    if (MODALS.has(first) && chainWords.length >= 3 && chainWords[1] === 'have') {
        const mainBase = getVerbBase(chainWords[2]);
        const futureModal = MODAL_FUTURE[first] || first;
        return {
            labels: ['Present', 'Past', 'Future'],
            chains: [
                [first, mainBase],
                [first, 'have', pp(mainBase)],
                [futureModal, mainBase],
            ],
            indices: chainIndices,
            currentIdx: 1,
        };
    }

    // ── Modal + be + -ing: "should be running" ──────────────
    if (MODALS.has(first) && chainWords.length >= 3 && BE_FORMS_SET.has(chainWords[1])) {
        const mainBase = getVerbBase(chainWords[chainWords.length - 1]);
        const futureModal = MODAL_FUTURE[first] || first;
        return {
            labels: ['Present', 'Past', 'Future'],
            chains: [
                [first, 'be', ing(mainBase)],
                [first, 'have', 'been', ing(mainBase)],
                [futureModal, 'be', ing(mainBase)],
            ],
            indices: chainIndices,
            currentIdx: 0,
        };
    }

    // ── be + -ing: progressive "is running" ─────────────────
    if (BE_FORMS_SET.has(first) && chainWords.length >= 2 && chainWords[chainWords.length - 1].endsWith('ing')) {
        const mainBase = getVerbBase(chainWords[chainWords.length - 1]);
        const cIdx = ['was', 'were'].includes(first) ? 1 : 0;
        return {
            labels: ['Present', 'Past', 'Future'],
            chains: [
                ['is', ing(mainBase)],
                ['was', ing(mainBase)],
                ['will', 'be', ing(mainBase)],
            ],
            indices: chainIndices,
            currentIdx: cIdx,
        };
    }

    // ── have + pp: perfect "has gone" ───────────────────────
    if (HAVE_FORMS_SET.has(first) && chainWords.length >= 2) {
        const mainBase = getVerbBase(chainWords[chainWords.length - 1]);
        const cIdx = first === 'had' ? 1 : 0;
        return {
            labels: ['Present', 'Past', 'Future'],
            chains: [
                ['has', pp(mainBase)],
                ['had', pp(mainBase)],
                ['will', 'have', pp(mainBase)],
            ],
            indices: chainIndices,
            currentIdx: cIdx,
        };
    }

    return null; // unrecognised — fall back to word-level
}

/** Show VP-level tense popover. */
function showVPTensePopover(vpWordIndices, sentenceIdx, words, posTags, anchorEl) {
    const vpForms = getVPChainForms(vpWordIndices, words, posTags);
    if (!vpForms) {
        // Fall back to word-level for head verb
        const headIdx = vpWordIndices.find(i => posTags[i] === 'AUX' || posTags[i] === 'VERB');
        if (headIdx !== undefined) showTensePopover(headIdx, sentenceIdx, anchorEl);
        return;
    }

    tenseHoverState = {
        type: 'vp',
        vpForms,
        sentenceIdx,
        el: anchorEl,
        currentIdx: vpForms.currentIdx,
    };
    renderVPTensePopoverContent();

    const rect = anchorEl.getBoundingClientRect();
    tensePopoverEl.style.left = rect.left + 'px';
    tensePopoverEl.style.top = (rect.bottom + 6) + 'px';
    tensePopoverEl.classList.add('visible');
}

/** Render VP tense popover content. */
function renderVPTensePopoverContent() {
    if (!tenseHoverState || tenseHoverState.type !== 'vp') return;
    const { vpForms } = tenseHoverState;
    const { labels, chains, currentIdx } = vpForms;

    tensePopoverEl.innerHTML = '';
    for (let i = 0; i < chains.length; i++) {
        const div = document.createElement('div');
        div.className = 'tense-item' + (i === currentIdx ? ' active' : '');
        const lbl = document.createElement('span');
        lbl.className = 'tense-label';
        lbl.textContent = labels[i];
        const w = document.createElement('span');
        w.className = 'tense-word';
        w.textContent = chains[i].join(' ');
        div.appendChild(lbl);
        div.appendChild(w);
        tensePopoverEl.appendChild(div);
    }
    const hint = document.createElement('span');
    hint.className = 'tense-hint';
    hint.textContent = 'scroll to change';
    tensePopoverEl.appendChild(hint);
}

/** Cycle VP-level tense. Splices words in/out of the sentence. */
function cycleVPTense(direction) {
    if (!tenseHoverState || tenseHoverState.type !== 'vp') return;
    const { vpForms, sentenceIdx } = tenseHoverState;
    const { chains, indices } = vpForms;

    const newIdx = (vpForms.currentIdx + direction + chains.length) % chains.length;
    vpForms.currentIdx = newIdx;
    tenseHoverState.currentIdx = newIdx;

    const newChain = chains[newIdx];
    const sWords = sentenceIdx >= 0 ? completedSentences[sentenceIdx].words : currentSentenceWords;
    const sPos = sentenceIdx >= 0 ? completedSentences[sentenceIdx].pos : currentSentencePOS;

    const firstIdx = Math.min(...indices);

    // Preserve trailing punctuation from the last old word
    const lastOldIdx = Math.max(...indices);
    const trailing = sWords[lastOldIdx]?.match(/[.,!?]+$/);

    // Remove old chain words (descending order)
    const sorted = [...indices].sort((a, b) => b - a);
    for (const idx of sorted) {
        sWords.splice(idx, 1);
        sPos.splice(idx, 1);
    }

    // Insert new chain words at firstIdx
    for (let j = newChain.length - 1; j >= 0; j--) {
        let w = newChain[j];
        if (j === newChain.length - 1 && trailing) w += trailing[0];
        const pos = (j === newChain.length - 1 && !MODALS.has(w) && !BE_FORMS_SET.has(w) && !HAVE_FORMS_SET.has(w))
            ? 'VERB' : 'AUX';
        sWords.splice(firstIdx, 0, w);
        sPos.splice(firstIdx, 0, pos);
    }

    // Update indices for the new chain
    vpForms.indices = newChain.map((_, j) => firstIdx + j);

    renderVPTensePopoverContent();
    render();
}

// ═══════════════════════════════════════════════════════════════════════════
// EXTERNAL DICTIONARY DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════

const DICT_API = 'https://api.dictionaryapi.dev/api/v2/entries/en/';

/** Fetch definition from the Free Dictionary API. Returns cached if available. */
async function fetchDefinition(word) {
    const lc = word.toLowerCase().replace(/[.,!?:;]+$/, '');
    if (definitionCache.has(lc)) return definitionCache.get(lc);

    try {
        const resp = await fetch(DICT_API + encodeURIComponent(lc));
        if (!resp.ok) {
            definitionCache.set(lc, null);
            return null;
        }
        const data = await resp.json();
        if (!Array.isArray(data) || data.length === 0) {
            definitionCache.set(lc, null);
            return null;
        }
        const entry = data[0];
        const result = {
            word: entry.word || lc,
            phonetic: entry.phonetic || (entry.phonetics?.[0]?.text) || '',
            meanings: (entry.meanings || []).slice(0, 3).map(m => ({
                pos: m.partOfSpeech || '',
                definitions: (m.definitions || []).slice(0, 2).map(d => d.definition),
            })),
        };
        definitionCache.set(lc, result);
        return result;
    } catch {
        definitionCache.set(lc, null);
        return null;
    }
}

/** Show definition panel for the given word. */
async function showDefinition(word) {
    if (!word || !definitionPanelEl) return;
    const lc = word.toLowerCase().replace(/[.,!?:;]+$/, '');
    if (lc === definitionWord) return; // already showing
    definitionWord = lc;

    // Show loading state
    definitionPanelEl.innerHTML = '<span class="def-loading">Looking up \u201c' + lc + '\u201d\u2026</span>';
    definitionPanelEl.classList.add('visible');

    const def = await fetchDefinition(lc);

    // Check we're still showing the same word
    if (definitionWord !== lc) return;

    if (!def || def.meanings.length === 0) {
        definitionPanelEl.innerHTML = '<span class="def-loading">No definition found.</span>';
        setTimeout(() => {
            if (definitionWord === lc) hideDefinitionPanel();
        }, 1500);
        return;
    }

    let html = '<span class="def-word">' + def.word + '</span>';
    if (def.phonetic) html += '<span class="def-phonetic">' + def.phonetic + '</span>';

    let num = 0;
    for (const m of def.meanings) {
        html += '<span class="def-pos">' + m.pos + '</span>';
        for (const d of m.definitions) {
            num++;
            html += '<div class="def-meaning"><span class="def-meaning-num">' + num + '.</span> ' + d + '</div>';
        }
    }

    definitionPanelEl.innerHTML = html;
    definitionPanelEl.classList.add('visible');
}

/** Hide the definition panel. */
function hideDefinitionPanel() {
    if (!definitionPanelEl) return;
    definitionPanelEl.classList.remove('visible');
    definitionPanelEl.innerHTML = '';
    definitionWord = null;
}

// ═══════════════════════════════════════════════════════════════════════════
// BRACE TREE RENDERING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Flatten a tree node into bar descriptors.
 * Each phrase node → { label, level, firstWordIdx, lastWordIdx, headIdx }.
 * Each leaf → { label, wordIdx }.
 * headIdx = the word index of the phrase's "head" (e.g. NOUN in NP).
 */

/** Map phrase label → POS tags that serve as head. */
const HEAD_POS = {
    NP: new Set(['NOUN', 'PRON', 'NUM']),
    VP: new Set(['VERB', 'AUX']),
    PP: new Set(['PREP']),
    ADVP: new Set(['ADV']),
    ADJP: new Set(['ADJ']),
};

function flattenTree(node, bars, leaves) {
    const isLeaf = node.word !== undefined && (!node.children || node.children.length === 0);

    if (isLeaf) {
        if (node.wordIdx !== undefined) {
            leaves.push({ label: node.label, wordIdx: node.wordIdx });
        }
        return { firstIdx: node.wordIdx ?? 0, lastIdx: node.wordIdx ?? 0, level: 0, headIdx: node.wordIdx ?? -1 };
    }

    let minIdx = Infinity, maxIdx = -Infinity, maxChildLevel = 0;
    let headIdx = -1;
    const headSet = HEAD_POS[node.label];

    for (const child of node.children) {
        const info = flattenTree(child, bars, leaves);
        if (info.firstIdx < minIdx) minIdx = info.firstIdx;
        if (info.lastIdx > maxIdx) maxIdx = info.lastIdx;
        if (info.level > maxChildLevel) maxChildLevel = info.level;

        // Find head: first leaf child whose POS matches the phrase type
        if (headIdx < 0 && headSet) {
            const childIsLeaf = child.word !== undefined && (!child.children || child.children.length === 0);
            if (childIsLeaf && headSet.has(child.label)) {
                headIdx = child.wordIdx ?? -1;
            }
        }
    }
    // Fallback: if no direct leaf head found, use rightmost child's head for NP, leftmost for VP
    if (headIdx < 0) {
        headIdx = minIdx; // fallback to first word
    }

    const level = maxChildLevel + 1;
    bars.push({ label: node.label, level, firstIdx: minIdx, lastIdx: maxIdx, headIdx });
    return { firstIdx: minIdx, lastIdx: maxIdx, level, headIdx };
}

/**
 * Measure word spans and position POS-tag row above + brace tree below.
 * Called in rAF after DOM is laid out.
 */
function positionBars() {
    const words = currentSentenceWords;
    const pos = currentSentencePOS;
    const wrapRect = currentLineWrap.getBoundingClientRect();

    // ── POS-tag row above current line ───────────────────────────────
    posRowEl.innerHTML = '';
    let hasAnyTag = false;

    if (words.length > 0) {
        const allWordSpans = [
            ...committedEl.querySelectorAll('.committed-word'),
            ...committedAfterEl.querySelectorAll('.committed-word'),
        ];

        for (const span of allWordSpans) {
            const idx = parseInt(span.dataset.idx);
            if (isNaN(idx) || !pos[idx]) continue;

            const rect = span.getBoundingClientRect();
            const cx = rect.left + rect.width / 2 - wrapRect.left;

            const tag = document.createElement('span');
            tag.className = 'pos-tag';
            tag.textContent = pos[idx];
            tag.style.left = cx + 'px';
            tag.style.color = posColor(pos[idx]);
            posRowEl.appendChild(tag);
            hasAnyTag = true;
        }

        // POS tag for predicted word
        if (!rawMode && buffer.length > 0 && currentMatches.length > 0) {
            const top = currentMatches[selectedCandidate] || currentMatches[0];
            const bufRect = bufferInlineEl.getBoundingClientRect();
            if (bufRect.width > 0) {
                const cx = bufRect.left + bufRect.width / 2 - wrapRect.left;
                const tag = document.createElement('span');
                tag.className = 'pos-tag predicted';
                tag.textContent = top.pos;
                tag.style.left = cx + 'px';
                tag.style.color = posColor(top.pos);
                posRowEl.appendChild(tag);
                hasAnyTag = true;
            }
        }
    }

    posRowEl.style.height = hasAnyTag ? '10px' : '0';

    // ── Brace tree below current line ────────────────────────────────
    const containers = document.querySelectorAll('.brace-tree');
    for (const container of containers) {
        const data = container._braceData;
        if (!data) continue;
        const { bars, wordIndices, getWordEl } = data;

        container.innerHTML = '';

        const containerRect = container.getBoundingClientRect();
        if (containerRect.width === 0) continue;

        // Measure word positions relative to the current-line-wrap
        const wordRects = new Map();
        for (const idx of wordIndices) {
            const el = getWordEl(idx);
            if (el) wordRects.set(idx, el.getBoundingClientRect());
        }
        if (wordRects.size === 0) continue;

        if (bars.length === 0) {
            container.style.height = '0';
            continue;
        }

        // Compress bar levels to be consecutive (level 1 = shallowest)
        const uniqueLevels = [...new Set(bars.map(b => b.level))].sort((a, b) => a - b);
        const levelMap = new Map();
        uniqueLevels.forEach((l, i) => levelMap.set(l, i + 1));

        const maxLevel = uniqueLevels.length;
        const ROW_HEIGHT = 12;
        const TOP_OVERLAP = 4; // px brackets extend above container into text area
        const LABEL_EXTRA = 10;
        const hasLabelBars = bars.some(b => b.label === 'S' || b.label === 'SBAR');
        const totalHeight = maxLevel * ROW_HEIGHT + (hasLabelBars ? LABEL_EXTRA : 0) + 2;
        container.style.height = totalHeight + 'px';
        container.style.position = 'relative';
        container.style.marginTop = -TOP_OVERLAP + 'px';

        // Sort bars deepest-first so shallow bars render on top
        const sortedBars = [...bars].sort((a, b) => b.level - a.level);

        for (const bar of sortedBars) {
            const firstRect = wordRects.get(bar.firstIdx);
            const lastRect = wordRects.get(bar.lastIdx);
            if (!firstRect || !lastRect) continue;

            const left = firstRect.left - containerRect.left;
            const right = lastRect.right - containerRect.left;
            const width = right - left;
            if (width < 2) continue;

            const displayLevel = levelMap.get(bar.level);
            // Horizontal part at bottom edge of this level's row
            const horizY = TOP_OVERLAP + displayLevel * ROW_HEIGHT;
            // All sides rise to top (into the overlap zone)
            const topY = 0;
            const bracketH = horizY;

            const color = posColor(bar.label);

            // SVG spans from top to the horizontal line
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('width', String(width));
            svg.setAttribute('height', String(bracketH));
            svg.classList.add('brace-svg');
            svg.style.left = left + 'px';
            svg.style.top = topY + 'px';

            // Build a <defs> with unique gradient ID for head-word highlight
            const gradId = 'hg' + bar.firstIdx + '_' + bar.level;
            const headRect = wordRects.get(bar.headIdx);
            let headX0 = 0, headX1 = 0;
            if (headRect && width > 0) {
                headX0 = Math.max(0, (headRect.left - containerRect.left - left) / width);
                headX1 = Math.min(1, (headRect.right - containerRect.left - left) / width);
            }

            // Solid fill colors via color-mix
            const fillLight = `color-mix(in srgb, ${color} 10%, var(--bg))`;
            const fillHead = `color-mix(in srgb, ${color} 25%, var(--bg))`;

            const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
            const grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
            grad.setAttribute('id', gradId);
            // Stops: light → head region (saturated) → light
            const makeStop = (offset, col) => {
                const s = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
                s.setAttribute('offset', String(offset));
                s.setAttribute('stop-color', col);
                return s;
            };
            if (headRect && headX0 < headX1) {
                grad.appendChild(makeStop(0, fillLight));
                grad.appendChild(makeStop(Math.max(0, headX0 - 0.01), fillLight));
                grad.appendChild(makeStop(headX0, fillHead));
                grad.appendChild(makeStop(headX1, fillHead));
                grad.appendChild(makeStop(Math.min(1, headX1 + 0.01), fillLight));
                grad.appendChild(makeStop(1, fillLight));
            } else {
                grad.appendChild(makeStop(0, fillLight));
                grad.appendChild(makeStop(1, fillLight));
            }
            defs.appendChild(grad);
            svg.appendChild(defs);

            // Curved radius at bottom corners
            const r = Math.min(5, width * 0.12, bracketH * 0.5);
            const d = `M 0,0 L 0,${bracketH - r} Q 0,${bracketH} ${r},${bracketH} `
                + `L ${width - r},${bracketH} Q ${width},${bracketH} ${width},${bracketH - r} L ${width},0`;

            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', d);
            path.style.stroke = color;
            path.style.fill = `url(#${gradId})`;
            svg.appendChild(path);

            // Hover → highlight covered word spans + VP tense popover
            const covered = wordIndices.filter(idx => idx >= bar.firstIdx && idx <= bar.lastIdx);
            svg.addEventListener('mouseenter', () => {
                svg.classList.add('bracket-active');
                for (const idx of covered) {
                    const w = getWordEl(idx);
                    if (w) w.classList.add('tree-hl');
                }
                // VP bracket: show VP-level tense popover
                if (bar.label === 'VP') {
                    showVPTensePopover(covered, -1, words, pos, svg);
                }
            });
            svg.addEventListener('mouseleave', () => {
                svg.classList.remove('bracket-active');
                for (const idx of covered) {
                    const w = getWordEl(idx);
                    if (w) w.classList.remove('tree-hl');
                }
                closeTensePopover();
            });
            // VP bracket: wheel cycles VP tense
            if (bar.label === 'VP') {
                svg.addEventListener('wheel', (e) => {
                    if (!tenseHoverState) return;
                    e.preventDefault();
                    if (tenseHoverState.type === 'vp') {
                        cycleVPTense(e.deltaY > 0 ? 1 : -1);
                    } else {
                        cycleTense(e.deltaY > 0 ? 1 : -1);
                    }
                }, { passive: false });
            }

            container.appendChild(svg);

            // ── Only show label for S/SBAR (clause/sentence) ─────
            if (bar.label === 'S' || bar.label === 'SBAR') {
                const label = document.createElement('span');
                label.className = 'brace-label';
                label.textContent = labelText(bar.label);
                label.style.color = color;
                label.style.left = (left + width / 2) + 'px';
                label.style.top = (horizY + 2) + 'px';
                container.appendChild(label);
            }
        }
    }

    // Re-adjust vertical position
    adjustVerticalPosition();
}

/**
 * Render the syntax tree for ALL clauses of the current sentence.
 * Prior clauses get trees appended to their .prior-clause blocks.
 * Active clause tree goes in #syntax-tree.
 * All phrase bars shown (NP, VP, PP, etc.), labels only for S/SBAR.
 */
function renderSyntaxTree() {
    syntaxTreeEl.innerHTML = '';
    // Clear any prior-clause brace trees
    for (const old of priorClausesEl.querySelectorAll('.brace-tree')) old.remove();

    const words = currentSentenceWords;
    const pos = currentSentencePOS;
    if (words.length === 0) return;

    const tree = buildTree(words, pos);
    if (!tree) return;

    const clauses = splitClauses(tree);

    for (let ci = 0; ci < clauses.length; ci++) {
        const clause = clauses[ci];
        const bars = [];
        const leaves = [];
        flattenTree(clause.tree, bars, leaves);

        if (ci < clauses.length - 1) {
            // Prior clause — add tree inside the prior-clause block
            const priorBlocks = priorClausesEl.querySelectorAll('.prior-clause');
            const block = priorBlocks[ci];
            if (!block) continue;

            const getWordEl = (wordIdx) => {
                return block.querySelector(`.committed-word[data-idx="${wordIdx}"]`);
            };

            const container = document.createElement('div');
            container.className = 'brace-tree';
            container._braceData = {
                bars,
                wordIndices: clause.wordIndices,
                getWordEl,
            };
            block.appendChild(container);
        } else {
            // Active clause — goes in #syntax-tree
            const getWordEl = (wordIdx) => {
                return committedEl.querySelector(`.committed-word[data-idx="${wordIdx}"]`)
                    || committedAfterEl.querySelector(`.committed-word[data-idx="${wordIdx}"]`);
            };

            const container = document.createElement('div');
            container.className = 'brace-tree';
            container._braceData = {
                bars,
                wordIndices: clause.wordIndices,
                getWordEl,
            };
            syntaxTreeEl.appendChild(container);
        }
    }
}


// ═══════════════════════════════════════════════════════════════════════════
// ACTIONS
// ═══════════════════════════════════════════════════════════════════════════

function updateMatches() {
    if (!dict || buffer.length === 0) {
        currentMatches = [];
        return;
    }
    currentMatches = findMatches(dict, buffer, currentSentenceWords, currentSentencePOS, 10);
    selectedCandidate = 0;
}

/**
 * Commit the selected match. If hovering over a word, replaces it.
 * If `suffix` is provided (e.g. ','), it is appended.
 */
function commitWord(matchIndex, suffix) {
    if (typeof matchIndex !== 'number') matchIndex = selectedCandidate;

    if (currentMatches.length === 0) return;
    const chosen = currentMatches[matchIndex];
    if (!chosen) return;

    let word = capitalizeIfNeeded(chosen.word);
    if (suffix) word += suffix;

    const newPOS = chosen.pos || tagWord(chosen.word);

    // If hovering over a word, replace it instead of appending
    if (hoveredWordEl && hoveredWordIdx >= 0) {
        replaceHoveredWord(word, newPOS);
        buffer = [];
        rawMode = false;
        rawBuffer = '';
        currentMatches = [];
        selectedCandidate = 0;
        expandedTreePaths = new Set(['']);
        return;
    }

    // If editing an active word (clicked on it), replace it
    if (activeWordIdx !== null && activeWordIdx < currentSentenceWords.length) {
        const oldWord = currentSentenceWords[activeWordIdx];
        const trailingPunct = oldWord.match(/[.,!?:;]+$/);
        currentSentenceWords[activeWordIdx] = word + (trailingPunct ? trailingPunct[0] : '');
        currentSentencePOS[activeWordIdx] = newPOS;
        activeWordIdx = null;
        insertionPoint = null;
        buffer = [];
        rawMode = false;
        rawBuffer = '';
        currentMatches = [];
        selectedCandidate = 0;
        expandedTreePaths = new Set(['']);
        hideDefinitionPanel();
        render();
        return;
    }

    const ip = (insertionPoint !== null && insertionPoint <= currentSentenceWords.length)
        ? insertionPoint : currentSentenceWords.length;

    currentSentenceWords.splice(ip, 0, word);
    currentSentencePOS.splice(ip, 0, newPOS);

    // Advance insertion point if we're inserting in the middle
    if (insertionPoint !== null) insertionPoint++;

    buffer = [];
    rawMode = false;
    rawBuffer = '';
    currentMatches = [];
    selectedCandidate = 0;
    expandedTreePaths = new Set(['']);
    render();
}

function commitRaw() {
    if (rawBuffer.length === 0) return;
    const word = capitalizeIfNeeded(rawBuffer);
    const newPOS = tagWord(rawBuffer);

    const ip = (insertionPoint !== null && insertionPoint <= currentSentenceWords.length)
        ? insertionPoint : currentSentenceWords.length;

    currentSentenceWords.splice(ip, 0, word);
    currentSentencePOS.splice(ip, 0, newPOS);

    if (insertionPoint !== null) insertionPoint++;

    rawBuffer = '';
    rawMode = false;
    expandedTreePaths = new Set(['']);
    render();
}

/**
 * End the current sentence with a punctuation mark.
 * If there's an uncommitted word, commit it first.
 */
function endSentence(punct) {
    punct = punct || '.';
    // Commit any pending word first
    if (rawMode && rawBuffer.length > 0) {
        commitRaw();
    } else if (buffer.length > 0 && currentMatches.length > 0) {
        commitWord(selectedCandidate);
    }

    if (currentSentenceWords.length > 0) {
        currentSentenceWords[currentSentenceWords.length - 1] += punct;
        completedSentences.splice(activeSentenceSlot, 0, {
            words: [...currentSentenceWords],
            pos: [...currentSentencePOS],
        });
        activeSentenceSlot++;
        currentSentenceWords = [];
        currentSentencePOS = [];
    }
    buffer = [];
    rawBuffer = '';
    rawMode = false;
    currentMatches = [];
    selectedCandidate = 0;
    insertionPoint = null;
    expandedTreePaths = new Set(['']);
    render();
}

function undoLastWord() {
    if (currentSentenceWords.length === 0) return;

    if (insertionPoint !== null && insertionPoint > 0 && insertionPoint <= currentSentenceWords.length) {
        // Remove word just before insertion point
        currentSentenceWords.splice(insertionPoint - 1, 1);
        currentSentencePOS.splice(insertionPoint - 1, 1);
        insertionPoint--;
    } else {
        // Normal: remove last word
        currentSentenceWords.pop();
        currentSentencePOS.pop();
    }
    expandedTreePaths = new Set(['']);
    render();
}

// ═══════════════════════════════════════════════════════════════════════════
// WORD HOVER + REPLACEMENT
// ═══════════════════════════════════════════════════════════════════════════

function onWordHoverEnter(span, sentenceIdx, wordIdx) {
    hoveredWordEl = span;
    hoveredSentenceIdx = sentenceIdx;
    hoveredWordIdx = wordIdx;
    span.classList.add('hovered');
    // Tense popover for verbs in completed sentences
    const pos = completedSentences[sentenceIdx]?.pos[wordIdx];
    if (pos === 'VERB' || pos === 'AUX') {
        showTensePopover(wordIdx, sentenceIdx, span);
    }
}

function onWordHoverLeave(span) {
    span.classList.remove('hovered');
    if (hoveredWordEl === span) {
        hoveredWordEl = null;
        hoveredSentenceIdx = -1;
        hoveredWordIdx = -1;
    }
    closeTensePopover();
}

function onCurrentWordHoverEnter(span, wordIdx) {
    hoveredWordEl = span;
    hoveredSentenceIdx = -1;
    hoveredWordIdx = wordIdx;
    span.classList.add('hovered');
    // Tense popover for verbs in current sentence
    const pos = currentSentencePOS[wordIdx];
    if (pos === 'VERB' || pos === 'AUX') {
        showTensePopover(wordIdx, -1, span);
    }
}

function onCurrentWordHoverLeave(span) {
    span.classList.remove('hovered');
    if (hoveredWordEl === span) {
        hoveredWordEl = null;
        hoveredSentenceIdx = -1;
        hoveredWordIdx = -1;
    }
    closeTensePopover();
}

function replaceHoveredWord(newWord, newPOS) {
    if (hoveredSentenceIdx >= 0) {
        const s = completedSentences[hoveredSentenceIdx];
        if (!s) { hoveredWordEl = null; hoveredSentenceIdx = -1; hoveredWordIdx = -1; return; }
        const oldWord = s.words[hoveredWordIdx];
        const trailingPunct = oldWord.match(/[.,!?]+$/);
        s.words[hoveredWordIdx] = newWord + (trailingPunct ? trailingPunct[0] : '');
        s.pos[hoveredWordIdx] = newPOS;
    } else {
        const oldWord = currentSentenceWords[hoveredWordIdx];
        const trailingPunct = oldWord.match(/[.,!?]+$/);
        currentSentenceWords[hoveredWordIdx] = newWord + (trailingPunct ? trailingPunct[0] : '');
        currentSentencePOS[hoveredWordIdx] = newPOS;
    }
    hoveredWordEl = null;
    hoveredSentenceIdx = -1;
    hoveredWordIdx = -1;
    render();
}

function navigateToSentence(sentenceIdx) {
    const aboveRows = completedAboveEl.querySelectorAll('.sentence-row');
    const belowRows = completedBelowEl.querySelectorAll('.sentence-row');
    const allRows = [...aboveRows, ...belowRows];
    if (allRows[sentenceIdx]) {
        allRows[sentenceIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function viewSentenceTree(sentenceIdx) {
    // Trees are now inline with each sentence, no navigation needed
}

function reenterSentence(sentenceIdx, wordIdx) {
    if (sentenceIdx < 0 || sentenceIdx >= completedSentences.length) return;

    const sentence = completedSentences[sentenceIdx];
    const words = [...sentence.words];
    const pos = [...sentence.pos];

    // Strip sentence-ending punctuation from last word
    const lastIdx = words.length - 1;
    words[lastIdx] = words[lastIdx].replace(/[.!?]+$/, '');

    // Remove from completed sentences
    completedSentences.splice(sentenceIdx, 1);

    // The editing slot is now at this index (sentences before it stay above)
    activeSentenceSlot = sentenceIdx;

    // Load ALL words — set insertion point after the clicked word
    currentSentenceWords = words;
    currentSentencePOS = pos;
    insertionPoint = wordIdx + 1;
    activeWordIdx = wordIdx;
    sentenceActive = true;

    // Reset state
    expandedTreePaths = new Set(['']);
    buffer = [];
    rawBuffer = '';
    rawMode = false;
    currentMatches = [];
    selectedCandidate = 0;
    closeTensePopover();

    render();
}

/**
 * Set cursor insertion point within the current sentence.
 * Clicking a committed word calls this with wordIdx + 1.
 */
function setInsertionPoint(idx) {
    insertionPoint = idx;
    activeWordIdx = idx > 0 ? idx - 1 : null;
    buffer = [];
    rawBuffer = '';
    rawMode = false;
    currentMatches = [];
    selectedCandidate = 0;
    render();
}

/**
 * Deactivate the current sentence: save it back to completed
 * and enter passive viewing mode.
 */
function deactivateSentence() {
    if (currentSentenceWords.length > 0) {
        const lastWord = currentSentenceWords[currentSentenceWords.length - 1];
        if (!/[.!?]$/.test(lastWord)) {
            currentSentenceWords[currentSentenceWords.length - 1] = lastWord + '.';
        }
        completedSentences.splice(activeSentenceSlot, 0, {
            words: [...currentSentenceWords],
            pos: [...currentSentencePOS],
        });
        currentSentenceWords = [];
        currentSentencePOS = [];
    }
    sentenceActive = false;
    buffer = [];
    rawBuffer = '';
    rawMode = false;
    currentMatches = [];
    selectedCandidate = 0;
    insertionPoint = null;
    activeWordIdx = null;
    expandedTreePaths = new Set(['']);
    closeTensePopover();
    hideDefinitionPanel();
    render();
}

// ═══════════════════════════════════════════════════════════════════════════
// POS TOGGLE
// ═══════════════════════════════════════════════════════════════════════════

function togglePOSColorMode() {
    colorTextMode = !colorTextMode;
    posToggleEl.classList.toggle('active', colorTextMode);
    render();
}

function toggleAlignMode() {
    const isLeft = document.documentElement.classList.toggle('left-align');
    alignToggleEl.classList.toggle('active', isLeft);
    localStorage.setItem('mw-align', isLeft ? 'left' : 'center');
    adjustVerticalPosition();
    requestAnimationFrame(() => positionBars());
}

// ═══════════════════════════════════════════════════════════════════════════
// KEYBOARD HANDLING
// ═══════════════════════════════════════════════════════════════════════════

function onKeyDown(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    // Prevent all default browser actions for single-char keys
    // (stops ' from opening Quick Find, / from triggering search, etc.)
    if (e.key.length === 1) {
        e.preventDefault();
        hasStarted = true;
        // Re-activate sentence mode if in passive viewing
        if (!sentenceActive) sentenceActive = true;
    }

    // Escape may fire even when inactive
    if (e.key === 'Escape') {
        e.preventDefault();
        if (!sentenceActive) return; // already inactive
        if (tenseHoverState) {
            closeTensePopover();
        } else if (buffer.length > 0 || insertionPoint !== null || activeWordIdx !== null) {
            buffer = [];
            currentMatches = [];
            selectedCandidate = 0;
            insertionPoint = null;
            activeWordIdx = null;
            hideDefinitionPanel();
            render();
        } else {
            deactivateSentence();
        }
        return;
    }

    // If not active, re-activate (non-char keys like Backspace, Tab, etc.)
    if (!sentenceActive && e.key !== 'Shift' && e.key !== 'Tab') {
        sentenceActive = true;
        render();
    }

    // ── Shift+Tab toggles raw mode ───────────────────────────────────────
    if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        rawMode = !rawMode;
        if (rawMode) {
            // Transfer buffer to raw
            rawBuffer = buffer.map(k => k.char).join('');
            buffer = [];
            currentMatches = [];
        } else {
            // Transfer raw back to buffer
            for (const ch of rawBuffer) {
                buffer.push({ char: ch, timestamp: performance.now() });
            }
            rawBuffer = '';
            updateMatches();
        }
        render();
        return;
    }

    // Ignore bare Shift
    if (e.key === 'Shift') return;

    // ── Raw mode: direct character input, no predictions ─────────────────
    if (rawMode) {
        if (e.key === ' ') {
            e.preventDefault();
            commitRaw();
        } else if (e.key === 'Backspace') {
            e.preventDefault();
            if (rawBuffer.length > 0) {
                rawBuffer = rawBuffer.slice(0, -1);
            } else {
                undoLastWord();
            }
            render();
        } else if (e.key === '.') {
            e.preventDefault();
            endSentence('.');
        } else if (e.key === '?' || e.key === '/') {
            e.preventDefault();
            endSentence('?');
        } else if (e.key === '!') {
            e.preventDefault();
            endSentence('!');
        } else if (e.key === 'Enter') {
            e.preventDefault();
            endSentence('.');
        } else if (e.key === ',') {
            e.preventDefault();
            if (rawBuffer.length > 0) {
                const word = capitalizeIfNeeded(rawBuffer);
                const rawIP = (insertionPoint !== null && insertionPoint <= currentSentenceWords.length)
                    ? insertionPoint : currentSentenceWords.length;
                currentSentenceWords.splice(rawIP, 0, word + ',');
                currentSentencePOS.splice(rawIP, 0, tagWord(rawBuffer));
                if (insertionPoint !== null) insertionPoint++;
                rawBuffer = '';
                render();
            }
        } else if (':;—–'.includes(e.key)) {
            e.preventDefault();
            if (rawBuffer.length > 0) {
                const word = capitalizeIfNeeded(rawBuffer);
                const rawIP = (insertionPoint !== null && insertionPoint <= currentSentenceWords.length)
                    ? insertionPoint : currentSentenceWords.length;
                currentSentenceWords.splice(rawIP, 0, word + e.key);
                currentSentencePOS.splice(rawIP, 0, tagWord(rawBuffer));
                if (insertionPoint !== null) insertionPoint++;
                rawBuffer = '';
                render();
            }
        } else if (e.key === "'") {
            e.preventDefault();
            rawBuffer += "'";
            render();
        } else if (e.key.length === 1 && /[a-zA-Z]/.test(e.key)) {
            e.preventDefault();
            rawBuffer += e.key.toLowerCase();
            render();
        }
        return;
    }

    // ── Normal (predictive) mode ─────────────────────────────────────────
    switch (e.key) {
        case ' ':
            e.preventDefault();
            commitWord(selectedCandidate);
            break;

        case ',':
            e.preventDefault();
            commitWord(selectedCandidate, ',');
            break;

        case ':':
        case ';':
        case '—':
        case '–':
            e.preventDefault();
            commitWord(selectedCandidate, e.key);
            break;

        case "'":
            // Allow apostrophe in words (contractions)
            e.preventDefault();
            buffer.push({
                char: "'",
                timestamp: performance.now(),
            });
            updateMatches();
            render();
            break;

        case '.':
            e.preventDefault();
            endSentence('.');
            break;

        case '?':
        case '/':
            e.preventDefault();
            endSentence('?');
            break;

        case '!':
            e.preventDefault();
            endSentence('!');
            break;

        case 'Backspace':
            e.preventDefault();
            if (buffer.length > 0) {
                buffer.pop();
                updateMatches();
                render();
            } else {
                undoLastWord();
            }
            break;

        case 'Escape':
            // Handled above the switch
            break;

        case 'Tab':
            e.preventDefault();
            if (currentMatches.length > 1) {
                selectedCandidate = (selectedCandidate + 1) % currentMatches.length;
                renderCurrentLine();
                renderSuggestions();
            }
            break;

        case 'Enter':
            e.preventDefault();
            endSentence('.');
            break;

        default:
            if (e.key.length === 1 && /[a-zA-Z]/.test(e.key)) {
                e.preventDefault();
                buffer.push({
                    char: e.key.toLowerCase(),
                    timestamp: performance.now(),
                });
                updateMatches();
                render();
            }
            break;
    }
}

function onKeyUp(e) {
    // No longer need shift tracking
}

// ═══════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════

export function init() {
    render();

    statusEl.textContent = 'Loading dictionary…';

    dict = loadDictionary('data/words.txt', (count) => {
        statusEl.textContent = 'Loading dictionary… ' + count.toLocaleString() + ' words';
    });

    dict.ready().then(() => {
        statusEl.textContent = dict.entries.length.toLocaleString() + ' words loaded';
        setTimeout(() => { statusEl.classList.add('fade'); }, 2000);
    });

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('resize', () => { adjustVerticalPosition(); requestAnimationFrame(() => positionBars()); });
    posToggleEl.addEventListener('click', togglePOSColorMode);

    // Align toggle — left-align is default
    if (alignToggleEl) {
        const savedAlign = localStorage.getItem('mw-align');
        const isLeft = savedAlign !== 'center';  // default to left
        if (isLeft) document.documentElement.classList.add('left-align');
        alignToggleEl.classList.toggle('active', isLeft);
        alignToggleEl.addEventListener('click', toggleAlignMode);
    }

    // Theme toggle
    const themeToggleEl = document.getElementById('theme-toggle');
    if (themeToggleEl) {
        // Restore saved theme
        const saved = localStorage.getItem('mw-theme');
        if (saved === 'light') document.documentElement.classList.add('light');
        themeToggleEl.classList.toggle('active', saved === 'light');

        themeToggleEl.addEventListener('click', () => {
            document.documentElement.classList.toggle('light');
            const isLight = document.documentElement.classList.contains('light');
            localStorage.setItem('mw-theme', isLight ? 'light' : 'dark');
            themeToggleEl.classList.toggle('active', isLight);
        });
    }
}
