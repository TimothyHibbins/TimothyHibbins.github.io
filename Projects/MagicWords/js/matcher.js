/**
 * Sequence-based matching engine for MagicWords.
 *
 * Matches dictionary words whose beginning matches the typed characters
 * (strict prefix).  Words are ranked by frequency and grammar fitness.
 * No chording, no bag-of-characters, no QWERTY proximity — sequence is king.
 */

import { grammarBoost } from './grammar.js';
import { tagWord } from './grammar.js';

// ═══════════════════════════════════════════════════════════════════════════
// TUNING
// ═══════════════════════════════════════════════════════════════════════════

const W = {
    /** Frequency bonus (common words rank higher). */
    frequency: 15,
    /** Grammar boost (POS prediction from sentence context). */
    grammar: 30,
    /** Bonus when typed chars exactly equal a complete word. */
    exactMatch: 40,
    /** Per-char penalty for completion length beyond typed prefix. */
    completionLength: 1.2,
};

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} MatchResult
 * @property {string} word
 * @property {number} score
 * @property {number} coverage       always 1 for prefix matches
 * @property {string} pos            POS tag
 * @property {Object} details
 */

/**
 * Find words beginning with the typed character sequence.
 *
 * @param {import('./dictionary.js').Dictionary} dict
 * @param {Array<{char:string, timestamp:number}>} buffer
 * @param {string[]} sentenceWords  Committed words in the current sentence
 * @param {string[]} sentencePOS    POS tags of committed words
 * @param {number} [topN=10]
 * @returns {MatchResult[]}
 */
export function findMatches(dict, buffer, sentenceWords, sentencePOS, topN) {
    topN = topN || 10;
    if (buffer.length === 0 || dict.entries.length === 0) return [];

    const typed = buffer.map(k => k.char).join('').toLowerCase();
    const results = [];

    for (let i = 0; i < dict.entries.length; i++) {
        const entry = dict.entries[i];

        // Strict prefix filter — sequence is king
        if (!entry.word.startsWith(typed)) continue;

        // Skip very long words
        if (entry.word.length > typed.length + 20) continue;

        const freq = entry.frequency * W.frequency;
        const gram = grammarBoost(entry.word, sentenceWords, sentencePOS) * W.grammar;
        const exact = (entry.word === typed) ? W.exactMatch : 0;
        const completionPenalty = Math.max(0, entry.word.length - typed.length) * W.completionLength;

        const score = freq + gram + exact - completionPenalty;

        results.push({
            word: entry.word,
            score,
            coverage: 1,
            pos: entry.pos,
            details: {
                frequencyBonus: freq,
                grammarBoost: gram,
                exactBonus: exact,
                completionPenalty,
            },
        });
    }

    results.sort((a, b) => b.score - a.score);

    // ── Fallback: always include the typed text itself as a candidate ──
    // This ensures words missing from the dictionary can still be committed.
    if (typed.length >= 2) {
        const alreadyHas = results.some(r => r.word === typed);
        if (!alreadyHas) {
            const pos = tagWord(typed);
            const gram = grammarBoost(typed, sentenceWords, sentencePOS) * W.grammar;
            results.push({
                word: typed,
                score: gram - 2,   // lower than real matches but still selectable
                coverage: 1,
                pos,
                details: { frequencyBonus: 0, grammarBoost: gram, exactBonus: 0, completionPenalty: 0 },
            });
        }
    }

    return results.slice(0, topN);
}
