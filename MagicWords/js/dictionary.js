/**
 * Streaming dictionary loader for MagicWords.
 *
 * Progressively loads a frequency-ranked word list using ReadableStream.
 * Words become searchable as they download — the top (most common) words
 * are available almost instantly while rarer words stream in behind.
 *
 * Each entry is tagged with a POS at load time using grammar.js.
 */

import { tagWord } from './grammar.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES  (documented via JSDoc for editor support)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} DictEntry
 * @property {string} word
 * @property {number} frequency   0–1, higher = more common
 * @property {string} pos         POS tag
 * @property {Map<string,number>} bag   letter → count
 * @property {Set<string>} letterSet    unique letters
 */

/**
 * @typedef {Object} Dictionary
 * @property {DictEntry[]} entries       All loaded entries (grows over time)
 * @property {Set<string>} wordSet       O(1) membership check
 * @property {boolean} loading           True while still streaming
 * @property {number} totalExpected      Estimated total words (set after load)
 * @property {function(): Promise<void>} ready  Resolves when fully loaded
 */

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/** Build a letter → count bag from a word. */
export function letterBag(text) {
    const bag = new Map();
    for (const ch of text.toLowerCase()) {
        if (ch >= 'a' && ch <= 'z') {
            bag.set(ch, (bag.get(ch) || 0) + 1);
        }
    }
    return bag;
}

// ═══════════════════════════════════════════════════════════════════════════
// STREAMING LOADER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Load a frequency-ranked word list progressively.
 *
 * The returned Dictionary object's `entries` array grows as data streams in.
 * Call `dict.ready` to await full completion.
 *
 * @param {string} url  Path to the word list (one word per line, most common first)
 * @param {function(number): void} [onProgress]  Called with entry count after each chunk
 * @returns {Dictionary}
 */
export function loadDictionary(url, onProgress) {
    const entries = [];
    const wordSet = new Set();
    let _resolve;
    const readyPromise = new Promise(resolve => { _resolve = resolve; });

    const dict = {
        entries,
        wordSet,
        loading: true,
        totalExpected: 0,
        ready: () => readyPromise,
    };

    // Start streaming in the background
    _streamLoad(url, dict, onProgress, _resolve);

    return dict;
}

/**
 * Internal: stream-fetch the word list and populate the dictionary.
 */
async function _streamLoad(url, dict, onProgress, resolve) {
    try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('Dictionary fetch failed: ' + resp.status);

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let totalWords = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); // keep the potentially-incomplete last line

            for (const line of lines) {
                const w = line.trim().toLowerCase();
                if (!w || !/^[a-z]+$/.test(w) || dict.wordSet.has(w)) continue;

                totalWords++;
                dict.wordSet.add(w);
                dict.entries.push({
                    word: w,
                    frequency: 0, // will normalise at the end
                    pos: tagWord(w),
                    bag: letterBag(w),
                    letterSet: new Set(w),
                });
            }

            // Yield to the UI thread between chunks
            if (onProgress) onProgress(dict.entries.length);
            await new Promise(r => setTimeout(r, 0));
        }

        // Handle any remaining partial line
        if (buffer.trim()) {
            const w = buffer.trim().toLowerCase();
            if (/^[a-z]+$/.test(w) && !dict.wordSet.has(w)) {
                dict.wordSet.add(w);
                dict.entries.push({
                    word: w,
                    frequency: 0,
                    pos: tagWord(w),
                    bag: letterBag(w),
                    letterSet: new Set(w),
                });
            }
        }

        // Normalise frequency scores: first word = 1.0, last = ~0.0
        const n = dict.entries.length;
        for (let i = 0; i < n; i++) {
            dict.entries[i].frequency = 1 - i / n;
        }

        // ── Generate inflected forms for better coverage ─────────────
        const inflections = [];
        for (let i = 0; i < n; i++) {
            const entry = dict.entries[i];
            const forms = _generateInflections(entry.word, entry.pos);
            for (const form of forms) {
                if (!dict.wordSet.has(form.word)) {
                    inflections.push({
                        word: form.word,
                        frequency: entry.frequency * 0.92,
                        pos: form.pos,
                        bag: letterBag(form.word),
                        letterSet: new Set(form.word),
                    });
                    dict.wordSet.add(form.word);
                }
            }
        }
        dict.entries.push(...inflections);

        dict.totalExpected = dict.entries.length;
        dict.loading = false;
    } catch (err) {
        console.error('Dictionary load error:', err);
        dict.loading = false;
    }

    resolve();
}

// ═══════════════════════════════════════════════════════════════════════════
// INFLECTION GENERATOR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate common inflected forms for a base word.
 * Nouns → plural.  Verbs → 3sg, past, progressive.
 * Adjectives (short) → comparative, superlative.
 *
 * @param {string} word
 * @param {string} pos
 * @returns {Array<{word: string, pos: string}>}
 */
function _generateInflections(word, pos) {
    const forms = [];
    const w = word;

    // ── -s / -es (noun plural or verb 3sg) ───────────────────────
    if ((pos === 'NOUN' || pos === 'VERB') && !w.endsWith('s') && !w.endsWith('ed')) {
        if (/(?:sh|ch|x|z)$/.test(w)) {
            forms.push({ word: w + 'es', pos });
        } else if (/[^aeiou]y$/.test(w) && w.length > 2) {
            forms.push({ word: w.slice(0, -1) + 'ies', pos });
        } else {
            forms.push({ word: w + 's', pos });
        }
    }

    if (pos === 'VERB') {
        // ── Past tense -ed ───────────────────────────────────────
        if (!w.endsWith('ed')) {
            if (w.endsWith('e')) {
                forms.push({ word: w + 'd', pos: 'VERB' });
            } else if (/[^aeiou]y$/.test(w) && w.length > 2) {
                forms.push({ word: w.slice(0, -1) + 'ied', pos: 'VERB' });
            } else {
                forms.push({ word: w + 'ed', pos: 'VERB' });
            }
        }

        // ── Progressive -ing ─────────────────────────────────────
        if (!w.endsWith('ing')) {
            if (w.endsWith('ie')) {
                forms.push({ word: w.slice(0, -2) + 'ying', pos: 'VERB' });
            } else if (w.endsWith('e') && !w.endsWith('ee') && w.length > 2) {
                forms.push({ word: w.slice(0, -1) + 'ing', pos: 'VERB' });
            } else {
                forms.push({ word: w + 'ing', pos: 'VERB' });
            }
        }
    }

    if (pos === 'ADJ' && w.length <= 7) {
        // ── Comparative -er, superlative -est ────────────────────
        if (w.endsWith('e')) {
            forms.push({ word: w + 'r', pos: 'ADJ' });
            forms.push({ word: w + 'st', pos: 'ADJ' });
        } else if (/[^aeiou]y$/.test(w) && w.length > 2) {
            forms.push({ word: w.slice(0, -1) + 'ier', pos: 'ADJ' });
            forms.push({ word: w.slice(0, -1) + 'iest', pos: 'ADJ' });
        } else {
            forms.push({ word: w + 'er', pos: 'ADJ' });
            forms.push({ word: w + 'est', pos: 'ADJ' });
        }
    }

    return forms.filter(f => /^[a-z]+$/.test(f.word));
}
