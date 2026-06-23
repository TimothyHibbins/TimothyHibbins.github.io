/* =========================================================================
   Atmosphere Column simulation
   - Many small molecules pack the column visibly. Gravity gives a clear
     barometric density profile (thick at bottom, fading toward the top).
   - Each greenhouse molecule (CO2) is overlaid with a small magnifying
     lens that shows the atoms, bonds, element labels, and bond
     oscillation at a magnified scale. The lens doubles as the absorption
     cross-section.
   - Atoms are squished together (heavy overlap) rather than ball-and-stick.
     Molecules rotate freely (each has its own angular velocity θ̇).
   - Photon absorption deposits the photon's energy as a kinetic-energy
     kick on the CO2 molecule plus a visible bond vibration. There is
     NO automatic re-emission timer — the absorbed energy spreads via
     collisions to neighbouring molecules. Spontaneous emission still
     occurs at a rate that scales with KE (hot molecules emit more often),
     so on average the energy returns to the radiation field. This is the
     "collisional de-excitation faster than radiative" regime of real CO2.
   - Atoms are colored by molecular KE using an inferno-style palette
     (dark purple → red → orange → yellow). Distinct from the rainbow
     photon palette so they don't visually clash.
   - User: hold the smokestack to emit CO2, hold the tree to absorb CO2.
   ========================================================================= */

// --- Molecule type definitions ---------------------------------------------

const MOL_TYPES = {
  CO2: {
    isGreenhouse: true,
    atoms: [
      { dx: -2.2, dy: 0, label: 'O' },
      { dx:  0,   dy: 0, label: 'C' },
      { dx:  2.2, dy: 0, label: 'O' },
    ],
    bonds: [[0, 1], [1, 2]],
    atomRadius: 2.0,       // adjacent atoms overlap by ~1.5px
    collisionRadius: 5,
  },
  N2: {
    isGreenhouse: false,
    atoms: [
      { dx: -1.1, dy: 0, label: 'N' },
      { dx:  1.1, dy: 0, label: 'N' },
    ],
    bonds: [[0, 1]],
    atomRadius: 1.8,        // atoms now overlap heavily (centres 2.2 apart, radii 3.6 → 1.4 overlap)
    collisionRadius: 3,
  },
  O2: {
    isGreenhouse: false,
    atoms: [
      { dx: -1.1, dy: 0, label: 'O' },
      { dx:  1.1, dy: 0, label: 'O' },
    ],
    bonds: [[0, 1]],
    atomRadius: 1.8,
    collisionRadius: 3,
  },
};

// --- Counts and physics constants ------------------------------------------

const MAX_ALT_KM = 10;
const N_BANDS = 10;
const KM_PER_BAND = MAX_ALT_KM / N_BANDS;

const N_N2 = 380;
const N_O2 = 100;
const N_CO2_INIT = 40;
const MAX_GH = 500;
const MAX_PHOTONS = 350;

// Tunable parameters — exposed in the settings panel below. Kept as `let`
// so sliders can update them at runtime.
let SUN_PHOTON_INTERVAL = 5;
let PHOTON_SPEED = 4;

// Gravity tuned so the column spans ~3 scale heights → density visibly thins
// toward the top.
let GRAVITY = 0.002;

// --- Energy / temperature mapping ------------------------------------------

// Energy unit is (px/frame)². Map to Kelvin linearly:
//   T(K) = BASE_TEMP_K + KE_TO_KELVIN * avg_KE
const BASE_TEMP_K = 100;
const KE_TO_KELVIN = 220;

// Photon absorption: energy deposited into the CO2's vibrational mode
// (NOT directly into translational KE). The vibration is then released to
// neighbours via collisions (collisional de-excitation) — see resolveCollisions.
const VIBRATION_FRAMES = 30;
// On collision involving a vibrating CO2: this fraction of its vibration
// energy transfers to the partner's translational KE.
let COLLISION_DEACTIVATION_FRAC = 0.85;
// On collision involving CO2 with a sufficiently energetic partner, this is
// the probability of thermally exciting the CO2's vibration (reverse
// pathway — microscopic reversibility). Without this, the only emission
// path would be the photon that just got absorbed; we need a way for
// generic gas heat to eventually re-radiate as IR.
let THERMAL_EXCITE_PROB = 0.18;
// Energy quantum transferred from translational KE to CO2 vibration during a
// thermal excitation event.
const THERMAL_EXCITE_QUANTUM = 0.12;
// Minimum collision relative-velocity² for thermal excitation to be possible.
const THERMAL_EXCITE_VREL2 = 0.4;

// IR absorption band (frequencies in [0,1] units).
const GH_ABSORB_BAND_LOW = 0.05;
const GH_ABSORB_BAND_HIGH = 0.30;

// Magnifying lens for CO2 molecules. The lens magnifies everything within
// a small region around the CO2 (true magnifying glass: also shows nearby
// N2/O2 molecules and any photons inside its field of view).
//   sourceR = LENS_R / MAGNIFICATION  // radius of the source patch in world
//   max-extent of CO2 atoms in lens   = (max_dx + atomRadius) * MAGNIFICATION
// Tuned so the CO2 fits inside the lens with room for rotation + vibration.
const LENS_R = 16;
const MAGNIFICATION = 2.8;
// Geometric absorption cross-section: a photon within this radius of a CO2
// centre is absorbed. Smaller than the visual lens so a fraction of IR
// always escapes — otherwise the rolling-average emission altitude is
// undefined (everything stays trapped as KE).
let ABSORPTION_R = 9;

// Ground physics
let groundTemp = 285;
const GROUND_HEAT_CAPACITY = 80;
let GROUND_EMIT_K = 5e-11;
let GROUND_HEAT_LOSS_PER_EMIT = 1.2;
let GROUND_ACCOMMODATION = 0.22;
let GROUND_HEAT_GAIN_PER_PHOTON = 1.5;

// Spontaneous IR emission rate (per frame). Scales with molecule KE above a
// threshold — hot molecules emit more often. This is the only way energy
// leaves the atmosphere; with the collision-thermalisation model, absorbed
// energy stays in the gas as KE until a stochastic spontaneous emission.
// Spontaneous emission rate (per frame per unit vibrationEnergy). The
// only way IR returns to the radiation field is via a vibrationally-excited
// CO2 emitting before its next collision.
let SPONT_EMIT_K = 0.06;

const ROLLING_AVG_SIZE = 50;

// Band temperature smoothing (heavy — settles over a few seconds)
const MIN_BAND_SAMPLE = 6;
const BAND_TEMP_SMOOTH = 0.008;

const CELL_SIZE = 16;

// --- Layout (recomputed on resize) -----------------------------------------

let LEFT_MARGIN, RIGHT_PANEL, SKY_TOP, GROUND_HEIGHT;
let groundY, columnTop, columnHeight;
let columnLeft, columnRight, columnWidth;
let bandHeight;
let smokestackBox, treeBox;

// --- State -----------------------------------------------------------------

let photons = [];
let molecules = [];
let emissionAltitudes = [];
let smokestackHeld = false;
let treeHeld = false;
let treePulse = 0;
let stackPulse = 0;
let smoothedBandTemps = null;

// --- Utility ----------------------------------------------------------------

function yToAltKm(y) { return ((groundY - y) / columnHeight) * MAX_ALT_KM; }
function altKmToY(km) { return groundY - (km / MAX_ALT_KM) * columnHeight; }
function yToBandIndex(y) {
  let i = Math.floor(yToAltKm(y) / KM_PER_BAND);
  if (i < 0) i = 0;
  if (i >= N_BANDS) i = N_BANDS - 1;
  return i;
}

function bandTemperatureK(i) {
  let total = 0, count = 0;
  for (const m of molecules) {
    if (yToBandIndex(m.y) !== i) continue;
    total += 0.5 * (m.vx * m.vx + m.vy * m.vy);
    count++;
  }
  if (count < MIN_BAND_SAMPLE) return null;
  return BASE_TEMP_K + KE_TO_KELVIN * (total / count);
}

function rawBandTemperatures() {
  const raw = [];
  for (let i = 0; i < N_BANDS; i++) raw[i] = bandTemperatureK(i);
  const result = raw.slice();
  for (let i = 0; i < N_BANDS; i++) {
    if (result[i] != null) continue;
    let below = i - 1, above = i + 1;
    while (below >= 0 && raw[below] == null) below--;
    while (above < N_BANDS && raw[above] == null) above++;
    if (below < 0 && above >= N_BANDS) result[i] = BASE_TEMP_K + 100;
    else if (below < 0) result[i] = raw[above];
    else if (above >= N_BANDS) result[i] = raw[below];
    else result[i] = raw[below] + (raw[above] - raw[below]) * (i - below) / (above - below);
  }
  return result;
}

function updateSmoothedBandTemps() {
  const raw = rawBandTemperatures();
  if (!smoothedBandTemps) { smoothedBandTemps = raw.slice(); return; }
  for (let i = 0; i < N_BANDS; i++) {
    smoothedBandTemps[i] += (raw[i] - smoothedBandTemps[i]) * BAND_TEMP_SMOOTH;
  }
}

function kToCelsius(k) { return k - 273; }

// Photon color: rainbow, darkened so all hues are visible against white.
function freqToColor(f) {
  let h, s, l;
  if (f < 0.08)      { h = 0;   s = 75; l = 20 + f * 180; }
  else if (f > 0.95) { h = 290; s = 75; l = 35; }
  else               { h = f * 280; s = 90; l = 42; }
  return `hsl(${h}, ${s}%, ${l}%)`;
}

// KE → color: inferno-style palette so it's clearly distinct from photons.
const KE_COLOR_STOPS = [
  [18, 0, 50],     // 0.0 — near-black dark purple
  [76, 12, 110],   // 0.25 — deep purple
  [184, 40, 70],   // 0.5 — red
  [240, 130, 30],  // 0.75 — orange
  [252, 222, 90],  // 1.0 — yellow
];
function keToColor(ke, alpha) {
  const t = constrain((ke - 0.15) / 1.4, 0, 1);
  const segs = KE_COLOR_STOPS.length - 1;
  const seg = Math.min(Math.floor(t * segs), segs - 1);
  const localT = t * segs - seg;
  const a = KE_COLOR_STOPS[seg], b = KE_COLOR_STOPS[seg + 1];
  return [
    a[0] + (b[0] - a[0]) * localT,
    a[1] + (b[1] - a[1]) * localT,
    a[2] + (b[2] - a[2]) * localT,
    alpha,
  ];
}

function sampleSunFreq() {
  let u1 = Math.random(), u2 = Math.random();
  let g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return constrain(0.6 + g * 0.18, 0.32, 0.99);
}
function sampleGroundEmitFreq() {
  const peak = constrain((groundTemp - 200) / 800, 0.06, 0.28);
  let u1 = Math.random(), u2 = Math.random();
  let g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return constrain(peak + g * 0.04, 0.04, 0.30);
}

function maxwellBoltzmannVel(T_K) {
  const sigma = Math.sqrt(Math.max(0, (T_K - BASE_TEMP_K)) / KE_TO_KELVIN);
  if (!isFinite(sigma) || sigma <= 0) return { vx: 0, vy: 0 };
  return { vx: randomGaussian(0, sigma), vy: randomGaussian(0, sigma) };
}

// --- Setup ------------------------------------------------------------------

function setup() {
  createCanvas(windowWidth, windowHeight);
  computeLayout();
  initMolecules();

  window.atmoState = () => {
    const temps = smoothedBandTemps || rawBandTemperatures();
    let totalKE = 0;
    for (const m of molecules) totalKE += 0.5 * (m.vx*m.vx + m.vy*m.vy);
    return {
      groundTempC: (groundTemp - 273).toFixed(1),
      ghCount: molecules.filter(m => m.isGreenhouse).length,
      avgEmissionAltKm: emissionAltitudes.length
        ? (emissionAltitudes.reduce((a, b) => a + b, 0) / emissionAltitudes.length).toFixed(2)
        : '0',
      bandTempsC: temps.map(t => (t - 273).toFixed(1)),
      photonCount: photons.length,
      molCount: molecules.length,
      avgKE: (totalKE / molecules.length).toFixed(3),
    };
  };
  window.atmoForceSmokestack = (on) => { smokestackHeld = on; };
  window.atmoForceTree = (on) => { treeHeld = on; };
  window.atmoTreeAbsorb = () => absorbCO2NearTree();
}

function computeLayout() {
  LEFT_MARGIN = 50;
  RIGHT_PANEL = 130;
  SKY_TOP = 20;
  GROUND_HEIGHT = 55;

  groundY = height - GROUND_HEIGHT;
  columnTop = SKY_TOP;
  columnHeight = groundY - columnTop;
  columnLeft = LEFT_MARGIN;
  columnRight = width - RIGHT_PANEL;
  columnWidth = columnRight - columnLeft;
  bandHeight = columnHeight / N_BANDS;

  const stackBaseW = 28, stackBaseH = 32, stackChimneyH = 18;
  const stackX = columnLeft + 50;
  smokestackBox = {
    x: stackX, y: groundY - stackBaseH - stackChimneyH,
    w: stackBaseW + 14, h: stackBaseH + stackChimneyH,
    chimneyTopX: stackX + 22, chimneyTopY: groundY - stackBaseH - stackChimneyH,
  };

  const treeX = columnRight - 70;
  const treeTrunkH = 22, treeLeavesR = 22;
  treeBox = {
    x: treeX, y: groundY - treeTrunkH - treeLeavesR * 2,
    w: treeLeavesR * 2, h: treeTrunkH + treeLeavesR * 2,
    canopyCx: treeX + treeLeavesR,
    canopyCy: groundY - treeTrunkH - treeLeavesR,
    canopyR: treeLeavesR,
  };
}

function makeMolecule(type, x, y, T_K) {
  if (x === undefined) x = random(columnLeft + 10, columnRight - 10);
  if (y === undefined) y = random(columnTop + 10, groundY - 10);
  if (T_K === undefined) T_K = 250;
  const v = maxwellBoltzmannVel(T_K);
  return {
    type,
    isGreenhouse: MOL_TYPES[type].isGreenhouse,
    x, y, vx: v.vx, vy: v.vy,
    // Rotation: random initial angle, gentle initial spin.
    theta: random(TWO_PI),
    omega: randomGaussian(0, 0.06),
    // Bond-vibration energy (separate from translational KE). Only CO2 uses
    // this. Increased by photon absorption and by thermal collisions;
    // decreased by collisional de-excitation and by spontaneous emission.
    vibrationEnergy: 0,
    vibrationFlash: 0,       // visual animation timer (frames)
    vibrationPhase: 0,
  };
}

function initMolecules() {
  molecules = [];
  for (let i = 0; i < N_N2; i++) molecules.push(makeMolecule('N2'));
  for (let i = 0; i < N_O2; i++) molecules.push(makeMolecule('O2'));
  for (let i = 0; i < N_CO2_INIT; i++) molecules.push(makeMolecule('CO2'));
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  computeLayout();
  for (const m of molecules) {
    const cr = MOL_TYPES[m.type].collisionRadius;
    if (m.x < columnLeft + cr) m.x = columnLeft + cr;
    if (m.x > columnRight - cr) m.x = columnRight - cr;
    if (m.y < columnTop + cr) m.y = columnTop + cr;
    if (m.y > groundY - cr) m.y = groundY - cr;
  }
}

// --- Main loop --------------------------------------------------------------

function draw() {
  background(255);

  if (photons.length < MAX_PHOTONS && frameCount % SUN_PHOTON_INTERVAL === 0) {
    spawnSunPhoton();
  }

  const groundEmitProb = GROUND_EMIT_K * Math.pow(groundTemp, 4);
  let budget = groundEmitProb;
  while (budget > 0 && photons.length < MAX_PHOTONS) {
    if (random() < budget) emitGroundPhoton();
    budget -= 1;
  }

  // Spontaneous IR emission from a vibrationally-excited CO2. Rate scales
  // with the molecule's vibrationEnergy; the emitted photon carries away
  // that energy and the molecule's vibration relaxes to zero.
  for (const m of molecules) {
    if (!m.isGreenhouse) continue;
    if (m.vibrationEnergy <= 0) continue;
    const p = SPONT_EMIT_K * m.vibrationEnergy;
    if (random() < p && photons.length < MAX_PHOTONS) {
      const freq = constrain(m.vibrationEnergy, 0.05, 0.30);
      const ang = random(TWO_PI);
      const startOffset = ABSORPTION_R + 2;
      photons.push({
        x: m.x + cos(ang) * startOffset,
        y: m.y + sin(ang) * startOffset,
        vx: cos(ang) * PHOTON_SPEED, vy: sin(ang) * PHOTON_SPEED,
        freq, source: 'gas',
        lastGhAltKm: yToAltKm(m.y),
        energy: freq, dead: false,
      });
      m.vibrationEnergy = 0;
      m.vibrationFlash = 8;  // brief afterglow then bonds settle
    }
  }

  for (const m of molecules) updateMolecule(m);
  resolveCollisions();

  for (let i = photons.length - 1; i >= 0; i--) {
    updatePhoton(photons[i]);
    if (photons[i].dead) photons.splice(i, 1);
  }

  if (smokestackHeld
      && molecules.filter(m => m.isGreenhouse).length < MAX_GH
      && frameCount % 4 === 0) {
    emitCO2FromStack();
    stackPulse = 8;
  }
  if (stackPulse > 0) stackPulse--;

  if (treeHeld && frameCount % 5 === 0) {
    absorbCO2NearTree();
  }
  if (treePulse > 0) treePulse--;

  if (groundTemp < 180) groundTemp = 180;
  updateSmoothedBandTemps();

  drawSpaceAndSky();
  drawColumnBackground();
  drawAltitudeAxis();
  drawTemperatureColumn();
  drawGround();
  drawSmokestack();
  drawTree();
  drawMolecules();
  drawCO2Lenses();
  drawPhotons();
  drawStats();
}

// --- Molecule physics -------------------------------------------------------

function updateMolecule(m) {
  m.vy += GRAVITY;
  m.x += m.vx;
  m.y += m.vy;
  m.theta += m.omega;
  // While vibrationally excited, keep the bond-oscillation animation alive.
  // After the energy leaves (via collision or emission) the flash counter
  // decays for a brief afterglow.
  if (m.isGreenhouse && m.vibrationEnergy > 0) {
    m.vibrationFlash = VIBRATION_FRAMES;
    m.vibrationPhase += 0.55;
  } else if (m.vibrationFlash > 0) {
    m.vibrationFlash--;
    m.vibrationPhase += 0.4;
  }

  const cr = MOL_TYPES[m.type].collisionRadius;
  if (m.x < columnLeft + cr)  { m.x = columnLeft + cr;  m.vx = -m.vx; }
  if (m.x > columnRight - cr) { m.x = columnRight - cr; m.vx = -m.vx; }
  if (m.y < columnTop + cr)   { m.y = columnTop + cr;   m.vy = -m.vy; }
  if (m.y > groundY - cr) {
    m.y = groundY - cr;
    m.vy = -Math.abs(m.vy);
    // Thermal accommodation with the ground
    const targetKE = (groundTemp - BASE_TEMP_K) / KE_TO_KELVIN;
    if (targetKE > 0) {
      const ke = 0.5 * (m.vx * m.vx + m.vy * m.vy);
      const newKE = lerp(ke, targetKE, GROUND_ACCOMMODATION);
      const scale = ke > 0 ? Math.sqrt(Math.max(0, newKE) / ke) : 0;
      m.vx *= scale; m.vy *= scale;
      groundTemp -= (newKE - ke) * KE_TO_KELVIN / GROUND_HEAT_CAPACITY;
    }
  }
}

// O(N) spatial-hash collision resolution.
function resolveCollisions() {
  const grid = new Map();
  for (let i = 0; i < molecules.length; i++) {
    const m = molecules[i];
    const cx = Math.floor(m.x / CELL_SIZE);
    const cy = Math.floor(m.y / CELL_SIZE);
    const key = cx * 100000 + cy;
    let bucket = grid.get(key);
    if (!bucket) { bucket = []; grid.set(key, bucket); }
    bucket.push(i);
  }
  for (let i = 0; i < molecules.length; i++) {
    const a = molecules[i];
    const cx = Math.floor(a.x / CELL_SIZE);
    const cy = Math.floor(a.y / CELL_SIZE);
    const rA = MOL_TYPES[a.type].collisionRadius;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const key = (cx + dx) * 100000 + (cy + dy);
        const bucket = grid.get(key);
        if (!bucket) continue;
        for (const j of bucket) {
          if (j <= i) continue;
          const b = molecules[j];
          const ddx = b.x - a.x, ddy = b.y - a.y;
          const d2 = ddx * ddx + ddy * ddy;
          const rsum = rA + MOL_TYPES[b.type].collisionRadius;
          if (d2 > rsum * rsum || d2 < 1e-6) continue;
          const d = Math.sqrt(d2);
          const nx = ddx / d, ny = ddy / d;
          const dvx = a.vx - b.vx, dvy = a.vy - b.vy;
          const vrel = dvx * nx + dvy * ny;
          if (vrel > 0) {
            a.vx -= vrel * nx; a.vy -= vrel * ny;
            b.vx += vrel * nx; b.vy += vrel * ny;
          }
          const overlap = (rsum - d) / 2;
          a.x -= nx * overlap; a.y -= ny * overlap;
          b.x += nx * overlap; b.y += ny * overlap;

          handleVibrationCoupling(a, b, vrel);
        }
      }
    }
  }
}

// Collision-mediated transfer between CO2 bond-vibration energy and the
// translational KE of the gas. Two pathways:
//   1. Collisional de-excitation: a vibrationally-excited CO2 hands most of
//      its vibration energy to its collision partner's translational motion.
//   2. Thermal excitation (reverse path): an energetic collision can excite
//      a non-vibrating CO2's bonds, drawing energy from the partner's KE.
function handleVibrationCoupling(a, b, vrel) {
  // Pathway 1: discharge of an excited CO2 to its partner.
  if (a.isGreenhouse && a.vibrationEnergy > 0) {
    dischargeVibration(a, b);
  }
  if (b.isGreenhouse && b.vibrationEnergy > 0) {
    dischargeVibration(b, a);
  }

  // Pathway 2: thermal excitation of CO2 by an energetic non-excited collision.
  if (vrel * vrel < THERMAL_EXCITE_VREL2) return;
  if (a.isGreenhouse && a.vibrationEnergy === 0
      && Math.random() < THERMAL_EXCITE_PROB) {
    thermallyExciteCO2(a, b);
  }
  if (b.isGreenhouse && b.vibrationEnergy === 0
      && Math.random() < THERMAL_EXCITE_PROB) {
    thermallyExciteCO2(b, a);
  }
}

function dischargeVibration(co2, partner) {
  const transferred = co2.vibrationEnergy * COLLISION_DEACTIVATION_FRAC;
  co2.vibrationEnergy -= transferred;
  if (co2.vibrationEnergy < 1e-4) co2.vibrationEnergy = 0;
  // Add as translational KE of the partner.
  const pKE = 0.5 * (partner.vx * partner.vx + partner.vy * partner.vy);
  const newKE = pKE + transferred;
  if (pKE > 1e-6) {
    const scale = Math.sqrt(newKE / pKE);
    partner.vx *= scale; partner.vy *= scale;
  } else {
    const ang = Math.random() * TWO_PI, sp = Math.sqrt(2 * newKE);
    partner.vx = Math.cos(ang) * sp; partner.vy = Math.sin(ang) * sp;
  }
  co2.vibrationFlash = Math.max(co2.vibrationFlash, 6);  // brief afterglow
}

function thermallyExciteCO2(co2, partner) {
  const pKE = 0.5 * (partner.vx * partner.vx + partner.vy * partner.vy);
  if (pKE < THERMAL_EXCITE_QUANTUM) return;
  // Take a quantum of energy from partner's KE.
  const scale = Math.sqrt((pKE - THERMAL_EXCITE_QUANTUM) / pKE);
  partner.vx *= scale; partner.vy *= scale;
  co2.vibrationEnergy += THERMAL_EXCITE_QUANTUM;
  co2.vibrationFlash = VIBRATION_FRAMES;
  co2.vibrationPhase = 0;
}

// --- Photon physics --------------------------------------------------------

function spawnSunPhoton() {
  const x = random(columnLeft + 5, columnRight - 5);
  const freq = sampleSunFreq();
  photons.push({
    x, y: columnTop + 1,
    vx: 0, vy: PHOTON_SPEED,
    freq, source: 'sun',
    lastGhAltKm: -1,
    energy: freq, dead: false,
  });
}

function emitGroundPhoton() {
  const x = random(columnLeft + 5, columnRight - 5);
  const y = groundY - 2;
  const freq = sampleGroundEmitFreq();
  const ang = -HALF_PI + random(-1.0, 1.0);
  photons.push({
    x, y,
    vx: cos(ang) * PHOTON_SPEED, vy: sin(ang) * PHOTON_SPEED,
    freq, source: 'ground',
    lastGhAltKm: -1,
    energy: freq, dead: false,
  });
  groundTemp -= GROUND_HEAT_LOSS_PER_EMIT;
}

function updatePhoton(p) {
  p.x += p.vx; p.y += p.vy;

  if (p.x < columnLeft)  { p.x = columnLeft;  p.vx = -p.vx; }
  if (p.x > columnRight) { p.x = columnRight; p.vx = -p.vx; }

  if (p.y < columnTop - 4) {
    const alt = p.lastGhAltKm >= 0 ? p.lastGhAltKm : 0;
    recordEmissionAltitude(alt);
    p.dead = true; return;
  }

  if (p.y > groundY) {
    groundTemp += p.energy * GROUND_HEAT_GAIN_PER_PHOTON;
    p.dead = true; return;
  }

  // Geometric absorption: IR photon hitting a CO2's lens area is captured.
  if (p.freq >= GH_ABSORB_BAND_LOW && p.freq <= GH_ABSORB_BAND_HIGH) {
    const R = ABSORPTION_R;
    const R2 = R * R;
    let bestM = null, bestD = R2;
    for (const m of molecules) {
      if (!m.isGreenhouse) continue;
      const dx = m.x - p.x, dy = m.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD) { bestD = d2; bestM = m; }
    }
    if (bestM) {
      // Deposit photon energy into the CO2's vibrational mode (NOT directly
      // into translational KE). The vibration is released to neighbours via
      // collisions in resolveCollisions(), or to a new photon via
      // spontaneous emission — whichever fires first.
      bestM.vibrationEnergy += p.energy;
      bestM.vibrationFlash = VIBRATION_FRAMES;
      bestM.vibrationPhase = 0;
      p.dead = true;
      return;
    }
  }
}

function recordEmissionAltitude(altKm) {
  emissionAltitudes.push(altKm);
  if (emissionAltitudes.length > ROLLING_AVG_SIZE) emissionAltitudes.shift();
}

function emitCO2FromStack() {
  const x = smokestackBox.chimneyTopX + random(-4, 4);
  const y = smokestackBox.chimneyTopY;
  const m = makeMolecule('CO2', x, y, 350);
  m.vx = random(-1, 1);
  m.vy = -random(1.5, 2.5);
  molecules.push(m);
}

function absorbCO2NearTree() {
  let bestIdx = -1, bestD = Infinity;
  for (let i = 0; i < molecules.length; i++) {
    const m = molecules[i];
    if (!m.isGreenhouse) continue;
    const dx = m.x - treeBox.canopyCx, dy = m.y - treeBox.canopyCy;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; bestIdx = i; }
  }
  if (bestIdx >= 0) molecules.splice(bestIdx, 1);
  treePulse = 14;
}

// --- Drawing ----------------------------------------------------------------

function drawSpaceAndSky() {
  noStroke();
  fill(245);
  rect(0, 0, width, SKY_TOP);
}
function drawColumnBackground() {
  noStroke();
  fill(252);
  rect(columnLeft, columnTop, columnWidth, columnHeight);
}

function drawAltitudeAxis() {
  stroke(100);
  strokeWeight(1);
  line(columnLeft, columnTop, columnLeft, groundY);
  noStroke();
  fill(80);
  textFont('Menlo');
  textSize(10);
  textAlign(RIGHT, CENTER);
  for (let k = 0; k <= MAX_ALT_KM; k += 2) {
    const y = altKmToY(k);
    stroke(140);
    line(columnLeft - 4, y, columnLeft, y);
    noStroke();
    text(k + ' km', columnLeft - 7, y);
  }
}

function drawTemperatureColumn() {
  const xCol = columnRight + 8;
  textFont('Menlo');
  textSize(10);
  textAlign(LEFT, CENTER);
  noStroke();
  fill(120);
  textAlign(LEFT, BOTTOM);
  text('TEMP', xCol, columnTop - 4);
  textAlign(LEFT, CENTER);
  const temps = smoothedBandTemps || rawBandTemperatures();
  for (let i = N_BANDS - 1; i >= 0; i--) {
    const yMid = altKmToY((i + 0.5) * KM_PER_BAND);
    const T = temps[i];
    const C = kToCelsius(T);
    const tNorm = constrain((T - 200) / 130, 0, 1);
    // Match the KE color palette for the temperature swatches.
    const [r, g, b] = keToColor(tNorm * 1.4 + 0.15, 255);
    fill(r, g, b);
    rect(xCol, yMid - bandHeight / 2 + 1, 14, bandHeight - 2, 2);
    fill(60);
    noStroke();
    text(`${C >= 0 ? '+' : ''}${C.toFixed(0)}\u00b0`, xCol + 18, yMid);
  }
}

function drawGround() {
  noStroke();
  const tNorm = constrain((groundTemp - 240) / 90, 0, 1);
  const col = lerpColor(color('#6e4a2e'), color('#a85a2a'), tNorm);
  fill(col);
  rect(0, groundY, width, GROUND_HEIGHT);
  stroke(0, 30);
  line(columnLeft, groundY, columnRight, groundY);
  noStroke();
}

function drawSmokestack() {
  const b = smokestackBox;
  const baseH = 32, chimneyH = 18, baseW = 28;
  const baseX = b.x;
  const baseY = groundY - baseH;
  noStroke();
  fill('#444');
  rect(baseX, baseY, baseW, baseH);
  fill(stackPulse > 0 ? '#a44' : '#555');
  rect(baseX + 18, baseY - chimneyH, 10, chimneyH);
  const btnY = baseY + baseH / 2 - 5;
  fill(smokestackHeld ? '#ffb74d' : '#aaa');
  rect(baseX + 6, btnY, 12, 10, 2);
  fill(255, 230);
  textFont('Menlo');
  textSize(9);
  textAlign(CENTER, TOP);
  text('hold to emit CO\u2082', baseX + baseW / 2, groundY + GROUND_HEIGHT - 14);
}

function drawTree() {
  const t = treeBox;
  noStroke();
  fill('#5a3a1c');
  rect(t.canopyCx - 4, groundY - 22, 8, 22);
  if (treePulse > 0 || treeHeld) {
    fill(180, 230, 180);
    circle(t.canopyCx, t.canopyCy, t.canopyR * 2 + 8 + ((treePulse + frameCount) % 6));
  }
  fill(treeHeld ? '#5cb85c' : '#3a7a3a');
  circle(t.canopyCx, t.canopyCy, t.canopyR * 2);
  fill(255, 230);
  textFont('Menlo');
  textSize(9);
  textAlign(CENTER, TOP);
  text('hold to absorb CO\u2082', t.canopyCx, groundY + GROUND_HEIGHT - 14);
}

function computeAtomPositions(m, scale, vibration) {
  const def = MOL_TYPES[m.type];
  const out = [];
  const n = def.atoms.length;
  const cosT = cos(m.theta), sinT = sin(m.theta);
  for (let i = 0; i < n; i++) {
    const a = def.atoms[i];
    let bondOffset = 0;
    if (vibration !== 0) {
      if (n >= 3) {
        if (i === 0) bondOffset = -vibration;
        else if (i === n - 1) bondOffset = vibration;
      } else if (n === 2) {
        bondOffset = (i === 0 ? -1 : 1) * vibration * 0.5;
      }
    }
    const dxL = (a.dx + bondOffset) * scale;
    const dyL = a.dy * scale;
    out.push({
      x: m.x + dxL * cosT - dyL * sinT,
      y: m.y + dxL * sinT + dyL * cosT,
      label: a.label,
    });
  }
  return out;
}

// Base-scale rendering. All molecules drawn first; CO2 also gets a bright
// outline ring at this scale so it's always findable in the crowd.
const CO2_OUTLINE_COLOR = '#16a34a';   // vivid green — distinct from KE
                                       // (purple→yellow) and photon (rainbow)
                                       // palettes
const CO2_OUTLINE_R = 6;
function drawMolecules() {
  // First: outline rings around every CO2 at base scale.
  noFill();
  stroke(CO2_OUTLINE_COLOR);
  strokeWeight(1.5);
  for (const m of molecules) {
    if (!m.isGreenhouse) continue;
    circle(m.x, m.y, CO2_OUTLINE_R * 2);
  }
  // Then: the atoms themselves.
  for (const m of molecules) drawMoleculeAt(m, m.x, m.y, 1);
}

// Magnifying lens — only rendered for CO2 that are currently vibrating
// (i.e. holding absorbed photon energy that hasn't yet been re-emitted or
// transferred to a neighbour). This focuses the user's attention on the
// active interaction sites.
function drawCO2Lenses() {
  textFont('Helvetica');
  textAlign(CENTER, CENTER);
  textStyle(BOLD);

  const ctx = drawingContext;
  const sourceR = LENS_R / MAGNIFICATION;
  const sourceR2 = sourceR * sourceR;

  for (const co2 of molecules) {
    if (!co2.isGreenhouse) continue;
    // Only show the lens while the CO2 is excited or in its brief afterglow.
    if (co2.vibrationEnergy <= 0 && co2.vibrationFlash <= 0) continue;

    // Slightly tinted background masks the base-scale rendering inside the lens
    noStroke();
    fill(255, 252, 245, 240);
    circle(co2.x, co2.y, LENS_R * 2);

    // Clip subsequent drawing to the lens circle.
    ctx.save();
    ctx.beginPath();
    ctx.arc(co2.x, co2.y, LENS_R, 0, TWO_PI);
    ctx.clip();

    // Draw every molecule whose centre falls within the source patch (plus a
    // small slack so partial molecules at the edge still appear).
    for (const m of molecules) {
      const ox = m.x - co2.x;
      const oy = m.y - co2.y;
      const d2 = ox * ox + oy * oy;
      if (d2 > sourceR2 * 1.6) continue;
      drawMoleculeAt(m, co2.x + ox * MAGNIFICATION, co2.y + oy * MAGNIFICATION, MAGNIFICATION);
    }

    // Photons inside the source patch too — they appear as larger spots.
    for (const p of photons) {
      const ox = p.x - co2.x;
      const oy = p.y - co2.y;
      const d2 = ox * ox + oy * oy;
      if (d2 > sourceR2 * 1.6) continue;
      drawPhotonAt(p, co2.x + ox * MAGNIFICATION, co2.y + oy * MAGNIFICATION, MAGNIFICATION);
    }

    ctx.restore();

    // Lens rim drawn after clipping is released. Use the highlight green so
    // the lens reads as "the same molecule as the outlined one".
    noFill();
    stroke(CO2_OUTLINE_COLOR);
    strokeWeight(1.5);
    circle(co2.x, co2.y, LENS_R * 2);
  }
  textStyle(NORMAL);
}

// Render molecule m at an arbitrary screen position (cx, cy) with the given
// scale factor. Used both by the base-scale rendering (scale=1, cx=m.x,
// cy=m.y) and by the lens (scale=MAGNIFICATION, cx and cy remapped).
function drawMoleculeAt(m, cx, cy, scale) {
  const def = MOL_TYPES[m.type];
  const ke = 0.5 * (m.vx * m.vx + m.vy * m.vy);
  const alpha = (scale > 1 || m.isGreenhouse) ? 240 : 75;
  const [r, g, b, a] = keToColor(ke, alpha);

  let vib = 0;
  if (m.vibrationFlash > 0) vib = sin(m.vibrationPhase) * 1.2;

  const cosT = cos(m.theta), sinT = sin(m.theta);
  const n = def.atoms.length;
  const positions = [];
  for (let i = 0; i < n; i++) {
    const a = def.atoms[i];
    let bondOffset = 0;
    if (vib !== 0) {
      if (n >= 3) {
        if (i === 0) bondOffset = -vib;
        else if (i === n - 1) bondOffset = vib;
      } else if (n === 2) {
        bondOffset = (i === 0 ? -1 : 1) * vib * 0.5;
      }
    }
    const dxL = (a.dx + bondOffset) * scale;
    const dyL = a.dy * scale;
    positions.push({
      x: cx + dxL * cosT - dyL * sinT,
      y: cy + dxL * sinT + dyL * cosT,
      label: a.label,
    });
  }

  stroke(r, g, b, a * 0.85);
  strokeWeight(scale > 1.5 ? 2 : 0.8);
  for (const [i, j] of def.bonds) {
    line(positions[i].x, positions[i].y, positions[j].x, positions[j].y);
  }

  noStroke();
  const atomR = def.atomRadius * scale;
  if (scale > 1.5) {
    textSize(atomR);
  }
  for (const p of positions) {
    fill(r, g, b, a);
    circle(p.x, p.y, atomR * 2);
    // Letter labels only on the magnified view (legible there).
    if (scale > 1.5) {
      fill(255, 245);
      text(p.label, p.x, p.y + 0.3);
    }
  }
}

function drawPhotons() {
  noStroke();
  for (const p of photons) {
    fill(freqToColor(p.freq));
    circle(p.x, p.y, 5);
  }
}

function drawStats() {
  textFont('Menlo');
  textSize(11);
  textAlign(LEFT, TOP);
  noStroke();
  fill(50);
  const avgAlt = emissionAltitudes.length
    ? emissionAltitudes.reduce((a, b) => a + b, 0) / emissionAltitudes.length
    : 0;
  const gT = kToCelsius(groundTemp);
  const ghCount = molecules.filter(m => m.isGreenhouse).length;
  text(`Ground: ${gT.toFixed(0)}\u00b0C   |   Emission altitude: ${avgAlt.toFixed(1)} km   |   CO\u2082: ${ghCount}`,
       columnLeft, 4);
  if (emissionAltitudes.length > 4) {
    const y = altKmToY(avgAlt);
    stroke('#d34a4a');
    strokeWeight(1.5);
    drawingContext.setLineDash([4, 3]);
    line(columnLeft, y, columnRight, y);
    drawingContext.setLineDash([]);
    noStroke();
    fill('#d34a4a');
    textAlign(LEFT, BOTTOM);
    text(`avg emission: ${avgAlt.toFixed(1)} km`, columnLeft + 4, y - 1);
  }
}

// --- Input -----------------------------------------------------------------

function pointInBox(x, y, b) {
  return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
}

function mousePressed() {
  if (pointInBox(mouseX, mouseY, smokestackBox)) {
    smokestackHeld = true;
    return false;
  }
  if (pointInBox(mouseX, mouseY, treeBox)) {
    treeHeld = true;
    return false;
  }
}

function mouseReleased() {
  smokestackHeld = false;
  treeHeld = false;
}
