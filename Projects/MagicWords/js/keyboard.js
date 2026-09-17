/**
 * QWERTY keyboard layout model.
 *
 * Provides key positions (with row stagger), neighbour detection, and
 * distance calculations.  Used by the matcher to explain accidental
 * keypresses near intended keys.
 */

const QWERTY_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const ROW_OFFSETS = [0, 0.25, 0.75]; // horizontal stagger in key-widths

/** @type {Map<string, [number, number]>} Continuous (x, y) per key. */
export const KEY_POSITIONS = new Map();

/** @type {Map<string, Set<string>>} Physically adjacent keys per key. */
export const QWERTY_NEIGHBORS = new Map();

// Build position map
for (let row = 0; row < QWERTY_ROWS.length; row++) {
    for (let col = 0; col < QWERTY_ROWS[row].length; col++) {
        KEY_POSITIONS.set(QWERTY_ROWS[row][col], [col + ROW_OFFSETS[row], row]);
    }
}

// Build adjacency map (threshold ≈ 1.6 key-widths)
const NEIGHBOR_THRESHOLD = 1.6;
for (const [key, [x1, y1]] of KEY_POSITIONS) {
    const neighbors = new Set();
    for (const [other, [x2, y2]] of KEY_POSITIONS) {
        if (key === other) continue;
        if (Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2) < NEIGHBOR_THRESHOLD) {
            neighbors.add(other);
        }
    }
    QWERTY_NEIGHBORS.set(key, neighbors);
}

/** True when `a` and `b` are physically adjacent on QWERTY. */
export function areNeighbors(a, b) {
    const s = QWERTY_NEIGHBORS.get(a.toLowerCase());
    return s ? s.has(b.toLowerCase()) : false;
}

/** Euclidean distance between two keys (in key-widths). */
export function keyDistance(a, b) {
    const pa = KEY_POSITIONS.get(a.toLowerCase());
    const pb = KEY_POSITIONS.get(b.toLowerCase());
    if (!pa || !pb) return Infinity;
    return Math.sqrt((pa[0] - pb[0]) ** 2 + (pa[1] - pb[1]) ** 2);
}
