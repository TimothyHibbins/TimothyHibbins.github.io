/**
 * Simple constituency parser for English.
 *
 * Takes POS-tagged words and groups them into a hierarchical phrase
 * structure tree (NP, VP, PP, S, SBAR) using greedy left-to-right reductions.
 *
 * Tree node: { label: string, children: TreeNode[], word?: string }
 * Leaf node: { label: string, word: string, children: [] }
 *
 * The top-level buildTree() returns a tree where clauses are explicit
 * SBAR / S nodes.  The companion splitClauses() extracts a flat list
 * of clause objects for multi-line rendering.
 */

import { tagWordAll } from './grammar.js';

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function is(node, ...labels) {
    return labels.includes(node.label);
}

/** Subordinating conjunctions that open a clause boundary. */
const SCONJ = new Set([
    'whether', 'if', 'because', 'since', 'although', 'though', 'unless',
    'while', 'whereas', 'when', 'where', 'whenever', 'wherever', 'once',
    'before', 'after', 'until', 'that', 'so',
]);

/** Coordinating conjunctions that can join clauses. */
const CCONJ = new Set(['or', 'and', 'but', 'nor', 'yet']);

// ═══════════════════════════════════════════════════════════════════════════
// CONTEXT-DEPENDENT DISAMBIGUATION
// ═══════════════════════════════════════════════════════════════════════════

/** Words that function as verb particles ("stay up", "turn off", etc.) */
const VERB_PARTICLES = new Set([
    'up', 'down', 'in', 'out', 'on', 'off', 'over', 'away', 'back', 'through',
    'along', 'around', 'about', 'across', 'ahead', 'apart', 'aside', 'forward',
]);

/** Degree adverbs that modify adjectives/adverbs ("too late", "very big"). */
const DEGREE_ADVS = new Set([
    'too', 'very', 'so', 'really', 'quite', 'rather', 'pretty', 'extremely',
    'incredibly', 'absolutely', 'completely', 'especially', 'particularly',
    'remarkably', 'terribly', 'awfully', 'somewhat', 'fairly', 'slightly',
]);

/**
 * Re-tag nodes based on local context before phrase grouping.
 */
function disambiguate(nodes) {
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const prev = i > 0 ? nodes[i - 1] : null;
        const next = i + 1 < nodes.length ? nodes[i + 1] : null;

        // PREP → PART after VERB when the word is a known particle
        // and is NOT followed by DET/NOUN/PRON/NUM (true prepositional object)
        if (
            node.label === 'PREP' && node.word &&
            VERB_PARTICLES.has(node.word.toLowerCase()) &&
            prev && is(prev, 'VERB')
        ) {
            if (!next || !is(next, 'DET', 'NOUN', 'PRON', 'NUM')) {
                node.label = 'PART';
            }
        }

        // VERB → ADJ before NOUN when preceded by DET/ADJ ("the running water")
        if (
            node.label === 'VERB' && next &&
            is(next, 'NOUN') && prev && is(prev, 'DET', 'ADJ')
        ) {
            node.label = 'ADJ';
        }

        // NOUN → ADJ after copula 'be' forms ("is kind", "should be kind", "was happy")
        if (
            node.label === 'NOUN' && prev &&
            (is(prev, 'AUX') || is(prev, 'VERB')) &&
            prev.word && /^(be|is|am|are|was|were|been|being)$/i.test(prev.word)
        ) {
            // Only retag if the word is plausibly ADJ
            const lw = node.word ? node.word.toLowerCase() : '';
            const adjSuffixes = /(?:ful|less|ous|ive|able|ible|ant|ent|al|ial|ic|ish|ary|ory|ly|y|ed)$/;
            const possibleTags = tagWordAll(lw);
            if (adjSuffixes.test(lw) || possibleTags.includes('ADJ')) {
                node.label = 'ADJ';
            }
        }

        // VERB → NOUN after DET/ADJ ("the slings", "a building")
        // (only if not already retagged to ADJ above)
        if (
            node.label === 'VERB' && prev &&
            is(prev, 'DET', 'ADJ')
        ) {
            node.label = 'NOUN';
        }
    }
    return nodes;
}

// ═══════════════════════════════════════════════════════════════════════════
// PHRASE GROUPING PASSES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Group adverb phrases:
 *   degree-ADV + ADV → ADVP          ("too quickly", "very well")
 *   degree-ADV + ADJ (no NOUN) → ADVP ("too late", "so long")
 */
function groupADVPs(nodes) {
    const out = [];
    let i = 0;
    while (i < nodes.length) {
        if (
            is(nodes[i], 'ADV') && nodes[i].word &&
            DEGREE_ADVS.has(nodes[i].word.toLowerCase())
        ) {
            const next = i + 1 < nodes.length ? nodes[i + 1] : null;
            if (next && is(next, 'ADV')) {
                out.push({ label: 'ADVP', children: [nodes[i], next] });
                i += 2;
                continue;
            }
            if (next && is(next, 'ADJ')) {
                const afterAdj = i + 2 < nodes.length ? nodes[i + 2] : null;
                if (!afterAdj || !is(afterAdj, 'NOUN', 'NUM')) {
                    const advNode = { ...next, label: 'ADV' };
                    if (next.children) advNode.children = [...next.children];
                    out.push({ label: 'ADVP', children: [nodes[i], advNode] });
                    i += 2;
                    continue;
                }
            }
        }
        out.push(nodes[i]);
        i++;
    }
    return out;
}

/**
 * Group noun phrases:
 *   PRON → NP
 *   DET? ADJ* (NOUN|NUM) → NP
 */
function groupNPs(nodes) {
    const out = [];
    let i = 0;
    while (i < nodes.length) {
        if (is(nodes[i], 'PRON')) {
            out.push({ label: 'NP', children: [nodes[i]] });
            i++;
            continue;
        }
        if (is(nodes[i], 'DET', 'ADJ', 'NOUN', 'NUM')) {
            const group = [];
            if (i < nodes.length && is(nodes[i], 'DET')) {
                group.push(nodes[i]); i++;
            }
            while (i < nodes.length && is(nodes[i], 'ADJ')) {
                group.push(nodes[i]); i++;
            }
            if (i < nodes.length && is(nodes[i], 'NOUN', 'NUM')) {
                group.push(nodes[i]); i++;
                // Absorb NP coordination: NOUN and/or NOUN  ("slings and arrows")
                while (
                    i + 1 < nodes.length &&
                    is(nodes[i], 'CONJ') && nodes[i].word &&
                    CCONJ.has(nodes[i].word.toLowerCase()) &&
                    is(nodes[i + 1], 'NOUN', 'ADJ', 'NUM')
                ) {
                    group.push(nodes[i]); i++; // CONJ
                    while (i < nodes.length && is(nodes[i], 'ADJ')) {
                        group.push(nodes[i]); i++;
                    }
                    if (i < nodes.length && is(nodes[i], 'NOUN', 'NUM')) {
                        group.push(nodes[i]); i++;
                    }
                }
                // Absorb post-nominal PP ("arrows of fortune")
                while (i < nodes.length && is(nodes[i], 'PP')) {
                    group.push(nodes[i]); i++;
                }
                out.push({ label: 'NP', children: group });
            } else if (group.length >= 2) {
                out.push({ label: 'NP', children: group });
            } else {
                out.push(...group);
            }
            continue;
        }
        out.push(nodes[i]);
        i++;
    }
    return out;
}

/**
 * Group prepositional phrases: PREP + NP → PP
 */
function groupPPs(nodes) {
    const out = [];
    let i = 0;
    while (i < nodes.length) {
        if (is(nodes[i], 'PREP') && i + 1 < nodes.length) {
            const next = nodes[i + 1];
            if (is(next, 'NP')) {
                out.push({ label: 'PP', children: [nodes[i], next] });
                i += 2; continue;
            }
            if (is(next, 'NOUN', 'PRON', 'NUM')) {
                const np = { label: 'NP', children: [next] };
                out.push({ label: 'PP', children: [nodes[i], np] });
                i += 2; continue;
            }
        }
        out.push(nodes[i]);
        i++;
    }
    return out;
}

/**
 * Group infinitive phrases: PART(to) + VERB … → VP
 * Absorbs the PART and everything through the verb's complements.
 */
function groupInfinitives(nodes) {
    const out = [];
    let i = 0;
    while (i < nodes.length) {
        if (
            is(nodes[i], 'PART') && nodes[i].word &&
            nodes[i].word.toLowerCase() === 'to' &&
            i + 1 < nodes.length && is(nodes[i + 1], 'VERB')
        ) {
            const group = [nodes[i]];
            i++;
            // Collect the VP-like contents: VERB, then complements
            if (i < nodes.length && is(nodes[i], 'VERB')) {
                group.push(nodes[i]); i++;
            }
            // Complements: NP, PP, ADVP, ADJ, ADV, bare NOUN/PRON/NUM
            while (
                i < nodes.length &&
                is(nodes[i], 'NP', 'PP', 'ADVP', 'ADJ', 'ADV', 'NOUN', 'PRON', 'NUM')
            ) {
                group.push(nodes[i]); i++;
            }
            out.push({ label: 'VP', children: group });
            continue;
        }
        out.push(nodes[i]);
        i++;
    }
    return out;
}

/**
 * Group verb phrases: (AUX)* (ADV)* VERB? (PART)* (NP|PP|ADVP|ADJ|ADV)* → VP
 */
function groupVPs(nodes) {
    const out = [];
    let i = 0;
    while (i < nodes.length) {
        if (is(nodes[i], 'AUX', 'VERB')) {
            const group = [];
            while (i < nodes.length && is(nodes[i], 'AUX')) {
                group.push(nodes[i]); i++;
            }
            while (i < nodes.length && is(nodes[i], 'ADV')) {
                group.push(nodes[i]); i++;
            }
            if (i < nodes.length && is(nodes[i], 'VERB')) {
                group.push(nodes[i]); i++;
            }
            while (i < nodes.length && is(nodes[i], 'PART')) {
                group.push(nodes[i]); i++;
            }
            while (
                i < nodes.length &&
                is(nodes[i], 'NP', 'PP', 'ADVP', 'ADJ', 'ADV', 'NOUN', 'PRON', 'NUM', 'VP')
            ) {
                group.push(nodes[i]); i++;
            }
            if (group.length >= 1) {
                out.push({ label: 'VP', children: group });
            }
            continue;
        }
        out.push(nodes[i]);
        i++;
    }
    return out;
}

/**
 * Group clause-level coordination:
 *   S/VP CONJ(and/or/but) S/VP → S with coordination
 * Also handles sequences like: VP , CONJ VP
 */
function groupCoordination(nodes) {
    if (nodes.length < 3) return nodes;
    const out = [];
    let i = 0;
    while (i < nodes.length) {
        if (
            i + 2 < nodes.length &&
            is(nodes[i], 'S', 'VP', 'NP') &&
            is(nodes[i + 1], 'CONJ') &&
            nodes[i + 1].word && CCONJ.has(nodes[i + 1].word.toLowerCase()) &&
            is(nodes[i + 2], 'S', 'VP', 'NP')
        ) {
            // Coordinate same-type phrases
            const coordLabel = nodes[i].label === nodes[i + 2].label ? nodes[i].label : 'S';
            out.push({ label: coordLabel, children: [nodes[i], nodes[i + 1], nodes[i + 2]] });
            i += 3;
            continue;
        }
        out.push(nodes[i]);
        i++;
    }
    return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// CLAUSE SPLITTING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Split a flat sequence of nodes at subordinating/coordinating conjunctions
 * into separate clause segments before phrase-level grouping.
 *
 * Returns an array of { conjNode, nodes } where conjNode is the leading
 * conjunction (null for the first clause).
 */
function splitAtClauseBoundaries(leaves) {
    const clauses = [];
    let current = [];
    let currentConj = null;

    for (let i = 0; i < leaves.length; i++) {
        const node = leaves[i];
        const w = (node.word || '').toLowerCase();

        // Subordinating conjunction starts a new clause
        if (node.label === 'CONJ' && SCONJ.has(w)) {
            if (current.length > 0) {
                clauses.push({ conjNode: currentConj, nodes: current });
                current = [];
            }
            currentConj = node;
            continue;
        }

        // Coordinating conjunction between clauses (only if we already
        // have VP-level content on both sides)
        if (node.label === 'CONJ' && CCONJ.has(w)) {
            // Skip phrase-level coordination (noun AND noun, adj AND adj)
            const prevNode = current.length > 0 ? current[current.length - 1] : null;
            const nextNode = i + 1 < leaves.length ? leaves[i + 1] : null;
            if (
                prevNode && nextNode &&
                is(prevNode, 'NOUN', 'ADJ', 'NUM', 'ADV') &&
                is(nextNode, 'NOUN', 'ADJ', 'NUM', 'ADV')
            ) {
                current.push(node);
                continue;
            }

            // Look ahead: is there a VERB or AUX or PART(to)+VERB upcoming?
            const hasVerbAhead = lookAheadForVerb(leaves, i + 1);
            const hasVerbBehind = current.some(n =>
                is(n, 'VERB', 'AUX') || (is(n, 'PART') && n.word && n.word.toLowerCase() === 'to')
            );

            if (hasVerbBehind && hasVerbAhead && current.length > 0) {
                clauses.push({ conjNode: currentConj, nodes: current });
                current = [];
                currentConj = node;
                continue;
            }
        }

        current.push(node);
    }

    if (current.length > 0) {
        clauses.push({ conjNode: currentConj, nodes: current });
    }

    return clauses;
}

/** Look ahead from index i for a VERB/AUX within the next ~8 tokens. */
function lookAheadForVerb(nodes, startIdx) {
    const limit = Math.min(nodes.length, startIdx + 8);
    for (let j = startIdx; j < limit; j++) {
        if (is(nodes[j], 'VERB', 'AUX')) return true;
        // PART(to) + VERB = infinitive
        if (
            is(nodes[j], 'PART') && nodes[j].word &&
            nodes[j].word.toLowerCase() === 'to' &&
            j + 1 < limit && is(nodes[j + 1], 'VERB')
        ) return true;
    }
    return false;
}

/**
 * Parse a single clause's nodes through all phrase-grouping passes.
 */
function parseClause(nodes) {
    nodes = disambiguate(nodes);
    nodes = groupADVPs(nodes);
    nodes = groupNPs(nodes);
    nodes = groupPPs(nodes);
    nodes = groupNPs(nodes);   // pick up NPs with post-nominal PPs
    nodes = groupPPs(nodes);   // PPs created after first NP pass
    nodes = groupInfinitives(nodes);
    nodes = groupVPs(nodes);
    nodes = groupPPs(nodes);   // PPs after VP
    nodes = groupCoordination(nodes);
    if (nodes.length === 1) return nodes[0];
    return { label: 'S', children: nodes };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a constituency parse tree from arrays of words and POS tags.
 * Splits the sentence at clause boundaries and builds sub-trees for each.
 *
 * @param {string[]} words
 * @param {string[]} posTags
 * @returns {{ label: string, children: Array, word?: string } | null}
 */
export function buildTree(words, posTags) {
    if (!words || words.length === 0) return null;

    const leaves = [];
    for (let i = 0; i < words.length; i++) {
        const pos = posTags[i] || 'NOUN';
        if (pos === 'PUNCT') continue;
        leaves.push({ label: pos, word: words[i], wordIdx: i, children: [] });
    }

    if (leaves.length === 0) return null;
    if (leaves.length === 1) return leaves[0];

    // Split into clause segments
    const clauseSegments = splitAtClauseBoundaries(leaves);

    if (clauseSegments.length === 1 && !clauseSegments[0].conjNode) {
        // Single clause — no splitting needed
        return parseClause(leaves);
    }

    // Multiple clauses: build each, then combine
    const clauseNodes = [];
    for (const seg of clauseSegments) {
        const clauseTree = parseClause(seg.nodes);
        if (seg.conjNode) {
            // SBAR: conjunction + clause
            const sbarLabel = SCONJ.has((seg.conjNode.word || '').toLowerCase()) ? 'SBAR' : 'S';
            clauseNodes.push({ label: sbarLabel, children: [seg.conjNode, clauseTree] });
        } else {
            clauseNodes.push(clauseTree);
        }
    }

    if (clauseNodes.length === 1) return clauseNodes[0];
    return { label: 'S', children: clauseNodes };
}

/**
 * Extract clause segments from a tree for multi-line rendering.
 * Each clause has: { label, tree, wordIndices[] }
 *
 * @param {{ label: string, children: Array }} tree
 * @returns {Array<{ label: string, tree: object, wordIndices: number[] }>}
 */
export function splitClauses(tree) {
    if (!tree) return [];

    // If the root S has children that are S/SBAR, those are the clauses
    if (tree.label === 'S' && tree.children && tree.children.length > 1) {
        const allClausal = tree.children.every(c => is(c, 'S', 'SBAR', 'VP'));
        if (allClausal) {
            return tree.children.map(c => ({
                label: c.label,
                tree: c,
                wordIndices: collectWordIndices(c),
            }));
        }
    }

    // Single clause
    return [{ label: tree.label, tree, wordIndices: collectWordIndices(tree) }];
}

/** Collect all leaf wordIdx values from a tree node. */
function collectWordIndices(node) {
    const indices = [];
    if (node.wordIdx !== undefined) indices.push(node.wordIdx);
    if (node.children) {
        for (const child of node.children) {
            indices.push(...collectWordIndices(child));
        }
    }
    return indices;
}
