/**
 * ChordType — bag-of-characters typing input.
 *
 * Type letters in any order. The system matches them to words.
 * Press Space to commit the top match.
 */

(function () {
    'use strict';

    // ═══════════════════════════════════════════════════════════════════════════
    // QWERTY KEYBOARD MODEL
    // ═══════════════════════════════════════════════════════════════════════════

    const QWERTY_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
    const ROW_OFFSETS = [0, 0.25, 0.75];

    /** @type {Map<string, [number, number]>} */
    const KEY_POSITIONS = new Map();
    /** @type {Map<string, Set<string>>} */
    const QWERTY_NEIGHBORS = new Map();

    for (let row = 0; row < QWERTY_ROWS.length; row++) {
        for (let col = 0; col < QWERTY_ROWS[row].length; col++) {
            KEY_POSITIONS.set(QWERTY_ROWS[row][col], [col + ROW_OFFSETS[row], row]);
        }
    }

    const NEIGHBOR_THRESHOLD = 1.6;
    for (const [key, [x1, y1]] of KEY_POSITIONS) {
        const neighbors = new Set();
        for (const [other, [x2, y2]] of KEY_POSITIONS) {
            if (key === other) continue;
            const dist = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
            if (dist < NEIGHBOR_THRESHOLD) neighbors.add(other);
        }
        QWERTY_NEIGHBORS.set(key, neighbors);
    }

    function areNeighbors(a, b) {
        const s = QWERTY_NEIGHBORS.get(a.toLowerCase());
        return s ? s.has(b.toLowerCase()) : false;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DICTIONARY LOADER
    // ═══════════════════════════════════════════════════════════════════════════

    const TIER_SIZES = [500, 2000, 5000, Infinity];

    function letterBag(text) {
        const bag = new Map();
        for (const ch of text.toLowerCase()) {
            if (ch >= 'a' && ch <= 'z') {
                bag.set(ch, (bag.get(ch) || 0) + 1);
            }
        }
        return bag;
    }

    async function loadDictionary(url) {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('Failed to load dictionary: ' + resp.status);
        const text = await resp.text();

        const words = text
            .split('\n')
            .map(function (w) { return w.trim().toLowerCase(); })
            .filter(function (w) { return w.length > 0 && /^[a-z]+$/.test(w); });

        const seen = new Set();
        const entries = [];

        for (const w of words) {
            if (seen.has(w)) continue;
            seen.add(w);
            entries.push({
                word: w,
                frequency: 1 - entries.length / words.length,
                bag: letterBag(w),
                letterSet: new Set(w),
            });
        }

        const tierEnds = [];
        let accumulated = 0;
        for (const size of TIER_SIZES) {
            accumulated = Math.min(accumulated + size, entries.length);
            tierEnds.push(accumulated);
            if (accumulated >= entries.length) break;
        }

        return {
            entries: entries,
            tierEnds: tierEnds,
            tierCount: tierEnds.length,
            wordSet: seen,
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // MATCHING ENGINE
    // ═══════════════════════════════════════════════════════════════════════════

    const SIMULTANEOUS_MS = 80;

    const W = {
        coverage: 100,
        unexplainedExtra: 6,
        explainedExtra: 1,
        frequencyMax: 8,
        lengthMismatch: 5,
        perfectLengthBonus: 10,
        missingLetter: 20,
        ratioWeight: 30,
    };

    const TIER_EXPAND_THRESHOLD = 70;
    const MIN_COVERAGE = 0.6;

    function findMatches(dict, buffer, topN) {
        topN = topN || 10;
        if (buffer.length === 0 || dict.entries.length === 0) return [];

        var bufferText = buffer.map(function (k) { return k.char; }).join('');
        var bufBag = letterBag(bufferText);
        var bufLetterSet = new Set(bufBag.keys());
        var bufLen = bufferText.replace(/[^a-z]/gi, '').length;

        var allResults = [];
        var searchEnd = 0;

        for (var tier = 0; tier < dict.tierCount; tier++) {
            var tierEnd = dict.tierEnds[tier];

            for (var i = searchEnd; i < tierEnd; i++) {
                var entry = dict.entries[i];

                // Fast pre-filter
                var commonLetters = 0;
                for (const ch of entry.letterSet) {
                    if (bufLetterSet.has(ch)) commonLetters++;
                }
                if (commonLetters / entry.letterSet.size < MIN_COVERAGE) continue;
                if (entry.word.length > bufLen * 2 + 2) continue;

                var result = scoreWord(buffer, bufBag, bufLen, entry);
                if (result.coverage >= MIN_COVERAGE) {
                    allResults.push(result);
                }
            }

            searchEnd = tierEnd;

            if (allResults.length > 0) {
                allResults.sort(function (a, b) { return b.score - a.score; });
                var best = allResults[0];
                // Only stop expanding if the best match is high-scoring AND its length
                // is close to the buffer length (within 1 char). A short word like
                // "chat" shouldn't prevent finding "caught" in a later tier.
                var bestLenDiff = Math.abs(best.word.length - bufLen);
                if (best.score >= TIER_EXPAND_THRESHOLD && bestLenDiff <= 1) break;
            }
        }

        allResults.sort(function (a, b) { return b.score - a.score; });
        return allResults.slice(0, topN);
    }

    function scoreWord(buffer, bufBag, bufLen, entry) {
        var word = entry.word;
        var frequency = entry.frequency;
        var wordBag = entry.bag;

        // 1. Coverage
        var covered = 0;
        var total = 0;
        for (const [letter, need] of wordBag) {
            total += need;
            covered += Math.min(need, bufBag.get(letter) || 0);
        }
        var coverage = total > 0 ? covered / total : 0;
        var missingLetters = total - covered;

        // 2. Extra letters
        var extras = 0;
        for (const [letter, count] of bufBag) {
            extras += Math.max(0, count - (wordBag.get(letter) || 0));
        }

        // 3. Explain extras via QWERTY proximity and timing
        var usedBag = new Map();
        for (const [l, c] of wordBag) usedBag.set(l, c);

        var extraIndices = [];
        var wordIndices = [];

        for (var i = 0; i < buffer.length; i++) {
            var c = buffer[i].char.toLowerCase();
            if (c < 'a' || c > 'z') continue;
            var rem = usedBag.get(c) || 0;
            if (rem > 0) {
                usedBag.set(c, rem - 1);
                wordIndices.push(i);
            } else {
                extraIndices.push(i);
            }
        }

        var explainedByQwerty = 0;
        var explainedByTiming = 0;

        for (const idx of extraIndices) {
            var extraChar = buffer[idx].char.toLowerCase();
            var explained = false;

            for (const [letter] of wordBag) {
                if (areNeighbors(extraChar, letter)) {
                    explainedByQwerty++;
                    explained = true;
                    break;
                }
            }

            if (!explained) {
                for (const wi of wordIndices) {
                    if (Math.abs(buffer[wi].timestamp - buffer[idx].timestamp) < SIMULTANEOUS_MS) {
                        explainedByTiming++;
                        explained = true;
                        break;
                    }
                }
            }
        }

        var explainedExtras = explainedByQwerty + explainedByTiming;
        var unexplainedExtras = extras - explainedExtras;

        // 4. Composite score
        var coverageScore = coverage * W.coverage;
        var missingPenalty = missingLetters * W.missingLetter;
        var extraPenalty =
            unexplainedExtras * W.unexplainedExtra +
            explainedExtras * W.explainedExtra;
        var frequencyBonus = frequency * W.frequencyMax;

        var lengthDiff = Math.abs(word.length - bufLen);
        var lengthPenalty = lengthDiff * lengthDiff * W.lengthMismatch;
        var lengthBonus = lengthDiff === 0 ? W.perfectLengthBonus : 0;

        var shorter = Math.min(word.length, bufLen);
        var longer = Math.max(word.length, bufLen);
        var ratioPenalty = longer > 0 ? (1 - shorter / longer) * W.ratioWeight : 0;

        var score =
            coverageScore -
            missingPenalty -
            extraPenalty +
            frequencyBonus -
            lengthPenalty -
            ratioPenalty +
            lengthBonus;

        return {
            word: word,
            score: score,
            coverage: coverage,
            details: {
                coveredLetters: covered,
                totalLetters: total,
                extraLetters: extras,
                explainedByQwerty: explainedByQwerty,
                explainedByTiming: explainedByTiming,
                frequencyBonus: frequencyBonus,
                lengthPenalty: lengthPenalty,
            },
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // UI CONTROLLER
    // ═══════════════════════════════════════════════════════════════════════════

    var outputEl = document.getElementById('output');
    var bufferEl = document.getElementById('buffer');
    var candidatesEl = document.getElementById('candidates');
    var hintEl = document.getElementById('buffer-hint');
    var statsEl = document.getElementById('stats');

    var dict = null;
    var buffer = [];
    var committedWords = [];
    var selectedCandidate = 0;
    var currentMatches = [];
    var totalKeystrokesAllWords = 0;
    var totalCommittedChars = 0;

    // ── Timing clusters ─────────────────────────────────────────────────────

    var CLUSTER_GAP_MS = 100;
    var CLUSTER_COLORS = [
        'var(--cluster-1)',
        'var(--cluster-2)',
        'var(--cluster-3)',
        'var(--cluster-4)',
        'var(--cluster-5)',
    ];

    function clusterKeystrokes(keys) {
        if (keys.length === 0) return [];
        var clusters = [0];
        var current = 0;
        for (var i = 1; i < keys.length; i++) {
            if (keys[i].timestamp - keys[i - 1].timestamp > CLUSTER_GAP_MS) current++;
            clusters.push(current);
        }
        return clusters;
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    function renderBuffer() {
        bufferEl.innerHTML = '';
        if (buffer.length === 0) {
            hintEl.style.display = '';
            return;
        }
        hintEl.style.display = 'none';

        var clusters = clusterKeystrokes(buffer);

        buffer.forEach(function (k, i) {
            var span = document.createElement('span');
            span.className = 'key';
            span.textContent = k.char;
            span.style.setProperty(
                '--cluster-color',
                CLUSTER_COLORS[clusters[i] % CLUSTER_COLORS.length]
            );
            bufferEl.appendChild(span);
        });
    }

    function renderCandidates() {
        candidatesEl.innerHTML = '';

        if (!dict) {
            var li = document.createElement('li');
            li.className = 'no-match';
            li.textContent = 'Loading dictionary…';
            candidatesEl.appendChild(li);
            return;
        }

        currentMatches = findMatches(dict, buffer, 10);
        selectedCandidate = 0;

        if (currentMatches.length === 0 && buffer.length > 0) {
            var li = document.createElement('li');
            li.className = 'no-match';
            li.textContent = 'No matches';
            candidatesEl.appendChild(li);
            return;
        }

        currentMatches.forEach(function (m, i) {
            var li = document.createElement('li');
            li.className = i === selectedCandidate ? 'candidate selected' : 'candidate';
            li.dataset.index = String(i);

            var wordSpan = document.createElement('span');
            wordSpan.className = 'candidate-word';
            wordSpan.textContent = m.word;

            var scoreSpan = document.createElement('span');
            scoreSpan.className = 'candidate-score';
            var pct = Math.round(m.coverage * 100);
            scoreSpan.textContent = pct + '%';

            var barOuter = document.createElement('span');
            barOuter.className = 'score-bar-outer';
            var barInner = document.createElement('span');
            barInner.className = 'score-bar-inner';
            barInner.style.width = pct + '%';
            barOuter.appendChild(barInner);

            var detailSpan = document.createElement('span');
            detailSpan.className = 'candidate-detail';
            var d = m.details;
            var parts = [];
            if (d.extraLetters > 0) {
                parts.push('+' + d.extraLetters + ' extra');
                if (d.explainedByQwerty > 0) parts.push(d.explainedByQwerty + ' QWERTY');
                if (d.explainedByTiming > 0) parts.push(d.explainedByTiming + ' timing');
            }
            detailSpan.textContent = parts.join(' · ');

            li.appendChild(wordSpan);
            li.appendChild(barOuter);
            li.appendChild(scoreSpan);
            if (parts.length) li.appendChild(detailSpan);

            li.addEventListener('click', function () { commitWord(i); });

            candidatesEl.appendChild(li);
        });
    }

    function renderOutput() {
        if (committedWords.length === 0) {
            outputEl.innerHTML = '<span class="placeholder">Your text will appear here…</span>';
        } else {
            outputEl.textContent = committedWords.join(' ');
        }
    }

    function renderStats() {
        if (totalCommittedChars === 0) {
            statsEl.textContent = '';
            return;
        }
        var ratio = ((totalCommittedChars / totalKeystrokesAllWords) * 100).toFixed(0);
        var msg =
            committedWords.length + ' words · ' +
            totalKeystrokesAllWords + ' keystrokes → ' +
            totalCommittedChars + ' chars (' + ratio + '% efficiency)';
        var saved = totalCommittedChars - totalKeystrokesAllWords;
        if (saved > 0) msg += ' · ' + saved + ' chars saved!';
        statsEl.textContent = msg;
    }

    function render() {
        renderBuffer();
        renderCandidates();
        renderOutput();
        renderStats();
    }

    function renderCandidatesSelection() {
        var items = candidatesEl.querySelectorAll('.candidate');
        items.forEach(function (li, i) {
            li.classList.toggle('selected', i === selectedCandidate);
        });
    }

    // ── Actions ─────────────────────────────────────────────────────────────

    function commitWord(matchIndex) {
        if (typeof matchIndex !== 'number') matchIndex = 0;
        if (currentMatches.length === 0) return;
        var chosen = currentMatches[matchIndex];
        if (!chosen) return;

        var word = chosen.word;
        if (
            committedWords.length === 0 ||
            /[.!?]$/.test(committedWords[committedWords.length - 1])
        ) {
            word = word.charAt(0).toUpperCase() + word.slice(1);
        }

        committedWords.push(word);
        totalKeystrokesAllWords += buffer.length;
        totalCommittedChars += chosen.word.length;

        buffer = [];
        currentMatches = [];
        selectedCandidate = 0;
        render();
    }

    function undoLastWord() {
        if (committedWords.length === 0) return;
        committedWords.pop();
        render();
    }

    // ── Keyboard handling ───────────────────────────────────────────────────

    document.addEventListener('keydown', function (e) {
        if (e.metaKey || e.ctrlKey || e.altKey) return;

        switch (e.key) {
            case ' ':
                e.preventDefault();
                commitWord(selectedCandidate);
                break;

            case 'Backspace':
                e.preventDefault();
                if (buffer.length > 0) {
                    buffer.pop();
                    render();
                } else {
                    undoLastWord();
                }
                break;

            case 'Escape':
                e.preventDefault();
                buffer = [];
                render();
                break;

            case 'Tab':
                e.preventDefault();
                if (currentMatches.length > 0) {
                    selectedCandidate = (selectedCandidate + 1) % currentMatches.length;
                    renderCandidatesSelection();
                }
                break;

            case 'Enter':
                e.preventDefault();
                if (currentMatches.length > 0) {
                    commitWord(selectedCandidate);
                }
                if (committedWords.length > 0) {
                    committedWords[committedWords.length - 1] += '.';
                    render();
                }
                break;

            default:
                if (e.key.length === 1 && /[a-zA-Z]/.test(e.key)) {
                    e.preventDefault();
                    buffer.push({
                        char: e.key.toLowerCase(),
                        timestamp: performance.now(),
                    });
                    render();
                }
                break;
        }
    });

    // ── Init ────────────────────────────────────────────────────────────────

    render();

    loadDictionary('dictionary.txt')
        .then(function (d) {
            dict = d;
            hintEl.textContent =
                'Dictionary loaded (' +
                dict.entries.length.toLocaleString() +
                ' words). Start typing — press Space to commit.';
        })
        .catch(function (err) {
            console.error('Failed to load dictionary:', err);
            hintEl.textContent = 'Failed to load dictionary!';
        });
})();
