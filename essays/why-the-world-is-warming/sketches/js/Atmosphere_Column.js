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
      { dx: -1.18, dy: 0, label: 'O' },
      { dx: 0, dy: 0, label: 'C' },
      { dx: 1.18, dy: 0, label: 'O' },
    ],
    bonds: [[0, 1], [1, 2]],
    atomRadius: 1.1,
    collisionRadius: 2.7,
  },
  N2: {
    isGreenhouse: false,
    atoms: [
      { dx: -0.63, dy: 0, label: 'N' },
      { dx: 0.63, dy: 0, label: 'N' },
    ],
    bonds: [[0, 1]],
    atomRadius: 1.0,
    collisionRadius: 1.58,
  },
  O2: {
    isGreenhouse: false,
    atoms: [
      { dx: -0.63, dy: 0, label: 'O' },
      { dx: 0.63, dy: 0, label: 'O' },
    ],
    bonds: [[0, 1]],
    atomRadius: 1.0,
    collisionRadius: 1.58,
  },
};

// --- Counts and physics constants ------------------------------------------

const MAX_ALT_KM = 10;
const N_BANDS = 10;
const KM_PER_BAND = MAX_ALT_KM / N_BANDS;

// Mix of greenhouse and non-greenhouse gases. CO2 fraction is much higher
// than real Earth (~0.04%) so we get a visible greenhouse effect within
// the small viewport, but not 100% so emission altitude can land in the
// middle of the column and the heat-tracking visualisation has variety.
// Counts are deliberately HIGH (and the molecules correspondingly SMALL) so
// that each altitude band holds many molecules — the band-temperature read is
// a mean over that population, so more molecules per band = a much steadier,
// less flickery temperature at every altitude. The sizes are shrunk in step so
// the gas stays dilute and the tuned opacity/conduction are preserved.
const N_N2 = 620;
const N_O2 = 200;
const N_CO2_INIT = 190;
const MAX_GH = 560;
let MAX_PHOTONS = 6000;

// Tunable parameters — exposed in the settings panel below. Kept as `let`
// so sliders can update them at runtime.
let SUN_PHOTON_INTERVAL = 10;
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
// centre is absorbed. Calibrated (with N_CO2_INIT) so that, at the target
// surface temperature of ~15 °C, the IR escaping to space balances the
// incoming sunlight — i.e. radiative equilibrium lands at 15 °C. Larger values
// make the atmosphere more opaque (hotter equilibrium); smaller values let
// more IR escape (cooler equilibrium). Kept above the photon's per-step travel
// (PHOTON_SPEED × DT_MAX) so fast photons can't tunnel through a CO2 between
// steps. Opacity ≈ N_CO2 × ABSORPTION_R, so it is reduced in step with the
// higher CO2 count to keep the same equilibrium.
let ABSORPTION_R = 4.2;

// --- Physical ground: a surface layer of vibrating, radiating atoms ---------
// The ground is no longer a scalar temperature reservoir. It is a row of
// "surface atoms", each a 2-D harmonic oscillator pinned to a home site by a
// spring. Gas molecules collide with them elastically (so thermal
// accommodation EMERGES from momentum exchange rather than a fudge factor);
// each atom radiates IR stochastically in proportion to its kinetic energy and
// absorbs any photon that reaches the ground, gaining that energy as motion.
// The ground temperature shown to the user is simply the mean kinetic energy
// of these atoms mapped through the SAME KE→Kelvin relation as the gas, so the
// whole column shares one energy currency and conserves it automatically:
// emitting a photon removes exactly its energy from an atom's KE, absorbing one
// adds exactly its energy, and the only net sink is a photon escaping to space,
// balanced by the incoming sunlight — true radiative equilibrium.
let groundAtoms = [];            // active surface oscillators (built at setup).
let groundStartX = 0;            // x of the first surface atom (lattice origin).
let groundTemp = 287;            // DERIVED each step from the atoms' mean KE;
// kept as a variable so sky-tint / stats code
// can read it unchanged.
const GROUND_ATOM_MASS = 2;      // close to a gas molecule (mass 1) so a single
// bounce exchanges a good fraction of energy —
// i.e. the gas and ground thermally couple, as
// a real surface and the air do.
const GROUND_ATOM_R = 1.4;       // collision + draw radius — same size as the
// atoms that make up the gas molecules.
const GROUND_ATOM_SPACING = 3.0; // close-packed: a continuous solid surface.
const GROUND_CELL_H = 1.0;       // horizontal half-range of the cell each
const GROUND_CELL_V = 1.0;       // surface atom rattles within. TIGHT cells
// mean strongly-bonded atoms with only a small
// vibration — the visible effect of a stiff
// bond — and, crucially, the cell walls are
// FIXED, so they can do no net work and the
// ground stays strictly energy-conserving. (A
// literal spring, by contrast, resonantly
// pumps energy out of the gas collisions and
// the whole column runs away to millions of
// degrees — so we bind the atoms this way
// instead.)
let GROUND_EMIT_RATE = 0.014;    // per-atom IR emission probability per unit KE
// per step — the ground's only energy sink,
// balanced against the incoming sunlight.
// (Scaled down vs a coarse lattice because the
// close-packed surface has many more atoms.)
const GROUND_INIT_KE = 0.6;      // seed kinetic energy per surface atom — set
// near the equilibrium value so the ground
// starts at roughly the right temperature
// instead of cooling down from a hot transient.

// Spontaneous IR emission rate (per frame). Scales with molecule KE above a
// threshold — hot molecules emit more often. This is the only way energy
// leaves the atmosphere; with the collision-thermalisation model, absorbed
// energy stays in the gas as KE until a stochastic spontaneous emission.
// Spontaneous emission rate (per frame per unit vibrationEnergy). The
// only way IR returns to the radiation field is via a vibrationally-excited
// CO2 emitting before its next collision.
//
// The rate is ALTITUDE-DEPENDENT, and this is what gives the column a stable
// vertical temperature gradient. Two competing fates for an excited CO2:
// collisional discharge (heats neighbouring gas — conduction) vs spontaneous
// emission (re-radiates). This MD gas conducts heat far too efficiently (a
// few hundred fast molecules in a small box), so a uniform emission rate is
// swamped and the column equilibrates isothermal. To let radiation win we
// raise the emission rate with altitude:
//   • Near the ground (low): emission is rare, so absorbed IR is handed to
//     neighbours by collisions — the air tracks the surface temperature and
//     the collisional-transfer story stays visible (smokestack region).
//   • Aloft (high): emission dominates, radiating energy to space faster than
//     conduction can refill it, so the upper layers run genuinely cold.
// The result is an emergent, monotonic, radiative-style lapse rate (steeper /
// hotter near the ground) rather than the isothermal state pure conduction
// would impose.
let SPONT_EMIT_LOW = 0.12;
let SPONT_EMIT_HIGH = 3.4;
const SPONT_RAMP_LOW_KM = 0.5;
const SPONT_RAMP_HIGH_KM = 4.0;
function spontRateAt(altKm) {
  const f = constrain(
    (altKm - SPONT_RAMP_LOW_KM) / (SPONT_RAMP_HIGH_KM - SPONT_RAMP_LOW_KM),
    0, 1);
  return SPONT_EMIT_LOW + (SPONT_EMIT_HIGH - SPONT_EMIT_LOW) * f;
}

const ROLLING_AVG_SIZE = 50;

// Band temperature smoothing (heavy — settles over a few seconds)
const MIN_BAND_SAMPLE = 6;
const BAND_TEMP_SMOOTH = 0.008;

const CELL_SIZE = 10;

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

// Display-only temperature relabelling. The physics runs in an internal energy
// unit (px/frame)² mapped to Kelvin via BASE_TEMP_K / KE_TO_KELVIN. These two
// display constants linearly remap the SETTLED kinetic-energy profile onto a
// realistic Celsius scale (surface air ≈ +15 °C, top of column ≈ −50 °C)
// WITHOUT altering any physics — a pure "zoom + shift" of the readout. The
// physics keeps using BASE_TEMP_K / KE_TO_KELVIN everywhere.
const DISP_BASE_K = 185;
const DISP_SLOPE = 183;
function physKToDisplayC(physK) {
  const ke = (physK - BASE_TEMP_K) / KE_TO_KELVIN;
  return DISP_BASE_K + DISP_SLOPE * ke - 273;
}

// Photon color: rainbow, darkened so all hues are visible against white.
// HSL → RGB conversion. We compute RGB explicitly rather than returning an
// "hsl(...)" CSS string because p5's color parsing of HSL strings was
// silently failing in some setups (ground IR photons rendering near-white
// instead of red). Returning [r, g, b] guarantees correct color.
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = constrain(s, 0, 1);
  l = constrain(l, 0, 1);
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function freqToColor(f) {
  let h, s, l;
  if (f < 0.30) {
    // IR — saturated, deep red. Visible against the white background.
    h = 5 + f * 60;      // 5° (deep red) → ~23° (red-orange) over the IR band
    s = 1.0;
    l = 0.48;
  } else if (f > 0.95) {
    h = 290; s = 0.85; l = 0.40;
  } else {
    h = f * 280; s = 0.90; l = 0.42;
  }
  return hslToRgb(h, s, l);
}

// All atoms render in default black. Element identity is conveyed by the
// letter labels inside the lens at magnification, not by atom color.
const ATOM_DEFAULT_COLOR = [18, 18, 18];
function atomColor(label) {
  return ATOM_DEFAULT_COLOR;
}

// KE → color: still used for the per-band temperature heatmap column on the
// right, but no longer applied to molecules themselves.
const KE_COLOR_STOPS = [
  [18, 0, 50], [76, 12, 110], [184, 40, 70], [240, 130, 30], [252, 222, 90],
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

// Continuous thermal colour for an individual molecule, keyed to its
// translational kinetic energy (i.e. its temperature). The SAME scale is used
// for greenhouse and inert molecules: a molecule heated by ANY collision
// (greenhouse de-excitation or an ordinary energetic bump) warms toward red,
// and cools smoothly back to a faint blue-grey as it shares that energy on.
const MOL_HEAT_STOPS = [
  [165, 178, 200, 105],   // cool: faint blue-grey, low opacity
  [232, 150, 70, 210],    // warm: orange
  [255, 45, 45, 255],     // hot: bright red
];
function molThermalColor(ke) {
  const t = constrain((ke - 0.2) / 1.1, 0, 1);
  const segs = MOL_HEAT_STOPS.length - 1;
  const seg = Math.min(Math.floor(t * segs), segs - 1);
  const lt = t * segs - seg;
  const a = MOL_HEAT_STOPS[seg], b = MOL_HEAT_STOPS[seg + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * lt),
    Math.round(a[1] + (b[1] - a[1]) * lt),
    Math.round(a[2] + (b[2] - a[2]) * lt),
    Math.round(a[3] + (b[3] - a[3]) * lt),
  ];
}

function sampleSunFreq() {
  let u1 = Math.random(), u2 = Math.random();
  let g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return constrain(0.6 + g * 0.18, 0.32, 0.99);
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

  window.atmoForceSmokestack = (on) => { smokestackHeld = on; };
  window.atmoForceTree = (on) => { treeHeld = on; };
  window.atmoTreeAbsorb = () => absorbCO2NearTree();

  buildSettingsPanel();
  buildPlaybackBar();
}

// --- Playback controls -----------------------------------------------------
// A row of buttons docked at the bottom-centre of the viewport: pause and a
// few speed presets. simSpeed is the global multiplier on physics steps per
// draw call.

const PLAYBACK_SPEEDS = [
  { label: '⏸', value: 0 },
  { label: '⅛×', value: 0.125 },
  { label: '¼×', value: 0.25 },
  { label: '½×', value: 0.5 },
  { label: '1×', value: 1 },
  { label: '2×', value: 2 },
  { label: '4×', value: 4 },
];

function buildPlaybackBar() {
  const bar = createDiv('');
  bar.style('position', 'fixed');
  bar.style('bottom', '8px');
  bar.style('left', '50%');
  bar.style('transform', 'translateX(-50%)');
  bar.style('display', 'flex');
  bar.style('gap', '4px');
  bar.style('padding', '5px 8px');
  bar.style('background', 'rgba(255,255,255,0.9)');
  bar.style('border', '1px solid rgba(0,0,0,0.15)');
  bar.style('border-radius', '20px');
  bar.style('box-shadow', '0 2px 6px rgba(0,0,0,0.1)');
  bar.style('z-index', '1000');
  bar.style('font-family', 'Helvetica, Arial, sans-serif');

  const buttons = [];
  PLAYBACK_SPEEDS.forEach(s => {
    const btn = createButton(s.label);
    btn.parent(bar);
    btn.style('min-width', '32px');
    btn.style('padding', '4px 8px');
    btn.style('border-radius', '12px');
    btn.style('background', '#fff');
    btn.style('cursor', 'pointer');
    btn.style('font-size', '12px');
    btn.style('font-weight', '500');
    btn.mousePressed(() => {
      simSpeed = s.value;
      updateButtonStyles();
    });
    buttons.push({ btn, value: s.value });
  });

  function updateButtonStyles() {
    buttons.forEach(({ btn, value }) => {
      const active = value === simSpeed;
      btn.style('background', active ? '#2563eb' : '#fff');
      btn.style('color', active ? '#fff' : '#222');
      btn.style('border', active ? '1px solid #2563eb' : '1px solid #ccc');
    });
  }
  updateButtonStyles();
}

// --- Settings panel ---------------------------------------------------------
// HTML overlay (created via p5 createButton/createDiv/createSlider) so we get
// real native sliders. Toggle visibility from a gear button in the top-right.

let settingsPanelEl = null;
let settingsOpen = false;

function buildSettingsPanel() {
  // Toggle button
  const btn = createButton('⚙');  // gear glyph
  btn.style('position', 'fixed');
  btn.style('top', '8px');
  btn.style('right', '8px');
  btn.style('width', '30px');
  btn.style('height', '30px');
  btn.style('border-radius', '50%');
  btn.style('border', '1px solid rgba(0,0,0,0.15)');
  btn.style('background', 'rgba(255,255,255,0.85)');
  btn.style('cursor', 'pointer');
  btn.style('font-size', '16px');
  btn.style('line-height', '1');
  btn.style('z-index', '1001');
  btn.mousePressed(() => {
    settingsOpen = !settingsOpen;
    if (settingsPanelEl) {
      settingsPanelEl.style('display', settingsOpen ? 'block' : 'none');
    }
  });

  // Panel
  const panel = createDiv('');
  settingsPanelEl = panel;
  panel.style('position', 'fixed');
  panel.style('top', '46px');
  panel.style('right', '8px');
  panel.style('width', '230px');
  panel.style('max-height', '85vh');
  panel.style('overflow-y', 'auto');
  panel.style('padding', '10px 12px 14px 12px');
  panel.style('background', 'rgba(255,255,255,0.96)');
  panel.style('border', '1px solid rgba(0,0,0,0.15)');
  panel.style('border-radius', '4px');
  panel.style('box-shadow', '0 2px 8px rgba(0,0,0,0.15)');
  panel.style('font-family', 'Helvetica, Arial, sans-serif');
  panel.style('font-size', '11px');
  panel.style('color', '#222');
  panel.style('z-index', '1000');
  panel.style('display', 'none');

  const header = createDiv('Parameters');
  header.parent(panel);
  header.style('font-weight', 'bold');
  header.style('font-size', '12px');
  header.style('margin', '0 0 8px 0');
  header.style('color', '#222');

  function addParam(label, min, max, step, getter, setter, formatter) {
    const row = createDiv('');
    row.parent(panel);
    row.style('margin-bottom', '8px');
    const lab = createDiv('');
    lab.parent(row);
    lab.style('display', 'flex');
    lab.style('justify-content', 'space-between');
    lab.style('margin-bottom', '2px');
    const name = createSpan(label);
    name.parent(lab);
    const val = createSpan(formatter(getter()));
    val.parent(lab);
    val.style('color', '#666');
    const slider = createSlider(min, max, getter(), step);
    slider.parent(row);
    slider.style('width', '100%');
    slider.input(() => {
      setter(slider.value());
      val.html(formatter(getter()));
    });
  }

  const f2 = v => Number(v).toFixed(2);
  const f3 = v => Number(v).toFixed(3);
  const fi = v => String(Math.round(v));
  const fSci = v => v.toExponential(1);

  addParam('Gravity', 0, 0.012, 0.0001,
    () => GRAVITY, v => GRAVITY = v, f3);
  addParam('Sun emission rate', 1, 30, 1,
    () => 60 / SUN_PHOTON_INTERVAL, v => SUN_PHOTON_INTERVAL = Math.max(1, Math.round(60 / v)),
    v => fi(v) + '/s');
  addParam('Absorption radius (px)', 2, 24, 1,
    () => ABSORPTION_R, v => ABSORPTION_R = v, fi);
  addParam('Spont. emission (aloft)', 0.1, 8, 0.1,
    () => SPONT_EMIT_HIGH, v => SPONT_EMIT_HIGH = v, f2);
  addParam('Thermal excite prob.', 0, 1, 0.01,
    () => THERMAL_EXCITE_PROB, v => THERMAL_EXCITE_PROB = v, f2);
  addParam('Collision deactivation', 0, 1, 0.01,
    () => COLLISION_DEACTIVATION_FRAC, v => COLLISION_DEACTIVATION_FRAC = v, f2);
  addParam('Ground emit rate', 0.005, 0.30, 0.005,
    () => GROUND_EMIT_RATE, v => GROUND_EMIT_RATE = v, f3);

  // --- Visibility toggles ---
  const visHeader = createDiv('Visibility');
  visHeader.parent(panel);
  visHeader.style('font-weight', 'bold');
  visHeader.style('font-size', '12px');
  visHeader.style('margin', '10px 0 6px 0');
  visHeader.style('color', '#222');

  function addToggle(label, getter, setter) {
    const row = createDiv('');
    row.parent(panel);
    row.style('margin-bottom', '4px');
    row.style('display', 'flex');
    row.style('align-items', 'center');
    row.style('gap', '6px');
    row.style('cursor', 'pointer');
    const cb = createCheckbox('', getter());
    cb.parent(row);
    cb.style('margin', '0');
    cb.changed(() => setter(cb.checked()));
    const lab = createSpan(label);
    lab.parent(row);
    lab.style('user-select', 'none');
    lab.elt.addEventListener('click', () => {
      cb.checked(!cb.checked());
      setter(cb.checked());
    });
  }

  addToggle('Show IR light', () => showIRLight, v => showIRLight = v);
  addToggle('Show visible/UV light', () => showVisibleLight, v => showVisibleLight = v);
  addToggle('Show non-greenhouse gas', () => showNonGHGases, v => showNonGHGases = v);
  addToggle('Show heat colouring', () => showHeatColouring, v => showHeatColouring = v);

  const note = createDiv('Changes apply live. Click the gear to close.');
  note.parent(panel);
  note.style('margin-top', '8px');
  note.style('color', '#888');
  note.style('font-size', '10px');
  note.style('font-style', 'italic');
}

function computeLayout() {
  // The molecule column keeps the SAME width as before (LEFT_MARGIN +
  // RIGHT_PANEL is unchanged at 180) so the tuned physics box is unaffected;
  // we just shift it right to free a wide left margin for the temperature
  // graph, which now sits on the same side as the altitude axis.
  LEFT_MARGIN = 130;
  RIGHT_PANEL = 50;
  SKY_TOP = 20;
  GROUND_HEIGHT = 14;
  // Reserved strip at the very bottom for the floating playback bar, so it
  // never overlaps the simulation, the ground, or the temperature graph.
  const BOTTOM_UI = 50;

  groundY = height - GROUND_HEIGHT - BOTTOM_UI;
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
    vibrationMode: 0,        // 0=symmetric stretch, 1=asymmetric, 2=bending
    vibrationPhase: 0,
    // True for a non-greenhouse molecule that has just received energy from an
    // excited CO2 via collisional de-excitation. It is spotlighted (bright red,
    // full opacity) until it hands the energy back to a CO2 or cools to ambient.
    carryingHeat: false,
  };
}

function initMolecules() {
  molecules = [];
  for (let i = 0; i < N_N2; i++) molecules.push(makeMolecule('N2'));
  for (let i = 0; i < N_O2; i++) molecules.push(makeMolecule('O2'));
  for (let i = 0; i < N_CO2_INIT; i++) molecules.push(makeMolecule('CO2'));
  initGroundAtoms();
}

// --- Physical ground atoms --------------------------------------------------

// Build the active surface layer: one oscillator per lattice site spanning the
// molecule column, each pinned to a home on the surface line and seeded with a
// random thermal velocity.
function initGroundAtoms() {
  groundAtoms = [];
  groundStartX = columnLeft + GROUND_ATOM_SPACING * 0.5;
  const v0 = Math.sqrt(2 * GROUND_INIT_KE / GROUND_ATOM_MASS);
  for (let x = groundStartX; x <= columnRight; x += GROUND_ATOM_SPACING) {
    const a = random(TWO_PI);
    groundAtoms.push({
      homeX: x, homeY: groundY,
      x, y: groundY,
      vx: Math.cos(a) * v0, vy: Math.sin(a) * v0,
    });
  }
}

// Map an x-coordinate to the nearest surface-atom index.
function groundIndexAt(x) {
  let idx = Math.round((x - groundStartX) / GROUND_ATOM_SPACING);
  if (idx < 0) idx = 0;
  if (idx >= groundAtoms.length) idx = groundAtoms.length - 1;
  return idx;
}

// Advance every surface atom one step: it flies freely and reflects off the
// FIXED walls of its tight lattice cell (a billiard in a small box — strictly
// energy-conserving, and tight enough that the atom barely moves, so it reads
// as a strongly-bonded surface atom), then has a chance to radiate an IR photon
// (paying for it out of its own kinetic energy).
function stepGroundAtoms(dt) {
  for (const g of groundAtoms) {
    g.x += g.vx * dt;
    g.y += g.vy * dt;
    if (g.x < g.homeX - GROUND_CELL_H) { g.x = g.homeX - GROUND_CELL_H; g.vx = -g.vx; }
    else if (g.x > g.homeX + GROUND_CELL_H) { g.x = g.homeX + GROUND_CELL_H; g.vx = -g.vx; }
    if (g.y < g.homeY - GROUND_CELL_V) { g.y = g.homeY - GROUND_CELL_V; g.vy = -g.vy; }
    else if (g.y > g.homeY + GROUND_CELL_V) { g.y = g.homeY + GROUND_CELL_V; g.vy = -g.vy; }

    const ke = 0.5 * GROUND_ATOM_MASS * (g.vx * g.vx + g.vy * g.vy);
    if (ke > 1e-6 && photons.length < MAX_PHOTONS) {
      if (random() < GROUND_EMIT_RATE * ke * dt) {
        // Emit an IR quantum, capped at the energy the atom actually holds.
        let E = random(GH_ABSORB_BAND_LOW, GH_ABSORB_BAND_HIGH);
        if (E > ke) E = ke;
        const sc = Math.sqrt(Math.max(0, ke - E) / ke);
        g.vx *= sc; g.vy *= sc;
        emitGroundAtomPhoton(g.x, E);
      }
    }
  }
}

// Deposit a photon's energy into the surface atom nearest x, as added KE.
function absorbIntoGround(x, E) {
  if (!groundAtoms.length) return;
  const g = groundAtoms[groundIndexAt(x)];
  const ke = 0.5 * GROUND_ATOM_MASS * (g.vx * g.vx + g.vy * g.vy);
  const newKE = ke + E;
  if (ke > 1e-6) {
    const sc = Math.sqrt(newKE / ke);
    g.vx *= sc; g.vy *= sc;
  } else {
    const v = Math.sqrt(2 * E / GROUND_ATOM_MASS);
    const a = random(TWO_PI);
    g.vx = Math.cos(a) * v; g.vy = Math.sin(a) * v;
  }
}

// Thermalise a gas molecule with the surface atom nearest its x, via ONE
// elastic two-body collision along the vertical normal. This is a discrete
// event fired when the molecule bounces off the floor — NOT a continuous
// overlap — so it conserves energy exactly (like gas–gas collisions) and
// avoids the Fermi-acceleration pumping that a permanently-overlapping spring
// contact against a rigid floor would cause.
function exchangeWithGround(m) {
  if (!groundAtoms.length) return false;
  const g = groundAtoms[groundIndexAt(m.x)];
  const vrel = m.vy - g.vy;           // closing (downward) speed of gas vs atom
  if (vrel <= 0) return false;
  const jimp = (2 * vrel) / (1 + 1 / GROUND_ATOM_MASS);
  m.vy -= jimp;
  g.vy += jimp / GROUND_ATOM_MASS;
  return true;
}

// Ground "temperature" = mean kinetic energy of the surface atoms, mapped
// through the same KE→Kelvin relation the gas uses, so they share one scale.
function updateGroundTemp() {
  if (!groundAtoms.length) return;
  let s = 0;
  for (const g of groundAtoms) s += 0.5 * GROUND_ATOM_MASS * (g.vx * g.vx + g.vy * g.vy);
  groundTemp = BASE_TEMP_K + KE_TO_KELVIN * (s / groundAtoms.length);
}


function windowResized() {
  // Capture the OLD column bounds so we can map molecule positions across
  // the change. Without this, molecules placed at setup with a small initial
  // canvas stay clustered in a tiny corner of the resized canvas.
  const oldLeft = columnLeft, oldRight = columnRight;
  const oldTop = columnTop, oldBottom = groundY;
  const oldWidth = Math.max(1, oldRight - oldLeft);
  const oldHeight = Math.max(1, oldBottom - oldTop);

  resizeCanvas(windowWidth, windowHeight);
  computeLayout();
  initGroundAtoms();

  const newWidth = columnRight - columnLeft;
  const newHeight = groundY - columnTop;
  for (const m of molecules) {
    const cr = MOL_TYPES[m.type].collisionRadius;
    // Rescale position proportionally to the new column.
    const fx = (m.x - oldLeft) / oldWidth;
    const fy = (m.y - oldTop) / oldHeight;
    m.x = columnLeft + constrain(fx, 0, 1) * newWidth;
    m.y = columnTop + constrain(fy, 0, 1) * newHeight;
    if (m.x < columnLeft + cr) m.x = columnLeft + cr;
    if (m.x > columnRight - cr) m.x = columnRight - cr;
    if (m.y < columnTop + cr) m.y = columnTop + cr;
    if (m.y > groundY - cr) m.y = groundY - cr;
  }
  // Layout changed underneath the camera; reset to the fitted view.
  viewScale = 1; viewOffsetX = 0; viewOffsetY = 0; isPanning = false;
}

// --- Main loop --------------------------------------------------------------

// Playback control: simSpeed multiplies how much physics-TIME advances each
// frame. Physics now advances by a continuous timestep (dt) rather than a whole
// number of fixed steps, so slowing down stays smooth instead of frame-
// skipping (no stutter), and the overall pace is gentler. BASE_DT sets the
// comfortable default pace at 1×; DT_MAX caps each sub-step so fast speeds stay
// numerically stable.
//   0 = paused, ⅛…½ = slow motion, 1 = normal, 2–4 = fast forward
let simSpeed = 1.0;
const BASE_DT = 0.5;
const DT_MAX = 1.0;

// Visibility toggles — controlled from the settings panel.
let showIRLight = true;
let showVisibleLight = false;     // off by default: visible light is just a
// pass-through, distracting from the IR story
let showNonGHGases = true;
let showHeatColouring = true;
let stepCounter = 0;  // internal frame counter for physics, separate from p5's
// frameCount so it doesn't tick while paused
// Continuous cadence accumulators (replace the old `stepCounter % N` checks so
// emission timing scales correctly with a variable dt).
let sunPhotonClock = 0;
let stackEmitClock = 0;
let treeAbsorbClock = 0;

// --- Zoom / pan camera ------------------------------------------------------
// A view transform applied ONLY to the physical scene (column, ground,
// molecules, photons) so it can be inspected close-up. Axes, the temperature
// graph and the stats overlay are drawn in screen space and stay put.
let viewScale = 1;       // 1 = fit the whole column; >1 = zoomed in
let viewOffsetX = 0;     // screen-px translation applied before scaling
let viewOffsetY = 0;
let isPanning = false;
let panStartX = 0, panStartY = 0, panStartOffX = 0, panStartOffY = 0;
const VIEW_MAX_ZOOM = 8;

function draw() {
  background(255);

  // Advance physics by a continuous amount of time each frame. Slow speeds run
  // a single small sub-step (smooth slow-motion, no frame-skipping); fast
  // speeds split the work into capped sub-steps so the integrator stays stable.
  let remaining = simSpeed * BASE_DT;
  let guard = 0;
  while (remaining > 1e-6 && guard < 16) {
    const dt = Math.min(remaining, DT_MAX);
    stepPhysics(dt);
    remaining -= dt;
    guard++;
  }
  // Smoothed temperature display updates once per draw call (not per step),
  // so the panel looks the same regardless of playback speed.
  updateSmoothedBandTemps();

  drawSpaceAndSky();
  drawColumnBackground();
  drawAltitudeAxis();
  drawTemperatureGraph();
  // Everything below is the physical scene: drawn through the zoom/pan camera
  // and clipped to the column so it can be inspected close-up without
  // disturbing the axes, the graph or the stats overlay.
  beginSimCamera();
  drawGround();
  drawSmokestack();
  drawTree();
  drawMolecules();
  // Magnifying lenses disabled — too busy at high CO2 density. The molecule
  // shape + black/grey two-tone makes CO2 findable without them.
  // drawCO2Lenses();
  drawPhotons();
  endSimCamera();
  drawStats();
}

// One simulation step. All time-dependent physics goes here. References to
// frameCount are replaced by stepCounter so they advance with simulation
// time, not draw time — meaning sun emission cadence etc. correctly scale
// with playback speed.
function stepPhysics(dt) {
  stepCounter++;

  // Sunlight cadence via a continuous clock so it scales smoothly with dt.
  sunPhotonClock += dt;
  while (sunPhotonClock >= SUN_PHOTON_INTERVAL) {
    sunPhotonClock -= SUN_PHOTON_INTERVAL;
    if (photons.length < MAX_PHOTONS) spawnSunPhoton();
  }

  // Surface atoms vibrate and radiate IR (paying out of their own KE).
  stepGroundAtoms(dt);

  // Spontaneous IR emission from a vibrationally-excited CO2.
  for (const m of molecules) {
    if (!m.isGreenhouse) continue;
    if (m.vibrationEnergy <= 0) continue;
    const p = spontRateAt(yToAltKm(m.y)) * m.vibrationEnergy;
    if (random() < p * dt && photons.length < MAX_PHOTONS) {
      // The photon carries the molecule's ENTIRE vibrational energy (energy
      // conservation). `freq` is only a display/absorption-band label, so it
      // is clamped to the visible IR band — but `energy` is the true amount,
      // which is what every absorber/ground credits.
      const emitEnergy = m.vibrationEnergy;
      const freq = constrain(emitEnergy, 0.05, 0.30);
      const ang = random(TWO_PI);
      const startOffset = ABSORPTION_R + 2;
      photons.push({
        x: m.x + cos(ang) * startOffset,
        y: m.y + sin(ang) * startOffset,
        vx: cos(ang) * PHOTON_SPEED, vy: sin(ang) * PHOTON_SPEED,
        freq, source: 'gas',
        lastGhAltKm: yToAltKm(m.y),
        energy: emitEnergy, dead: false,
      });
      m.vibrationEnergy = 0;
      m.vibrationFlash = 8;
    }
  }

  for (const m of molecules) updateMolecule(m, dt);
  resolveCollisions();
  updateGroundTemp();

  for (let i = photons.length - 1; i >= 0; i--) {
    updatePhoton(photons[i], dt);
    if (photons[i].dead) photons.splice(i, 1);
  }

  if (smokestackHeld && molecules.filter(m => m.isGreenhouse).length < MAX_GH) {
    stackEmitClock += dt;
    while (stackEmitClock >= 4) { stackEmitClock -= 4; emitCO2FromStack(); stackPulse = 8; }
  } else {
    stackEmitClock = 0;
  }
  if (stackPulse > 0) stackPulse -= dt;

  if (treeHeld) {
    treeAbsorbClock += dt;
    while (treeAbsorbClock >= 5) { treeAbsorbClock -= 5; absorbCO2NearTree(); }
  } else {
    treeAbsorbClock = 0;
  }
  if (treePulse > 0) treePulse -= dt;
}

// --- Molecule physics -------------------------------------------------------

function updateMolecule(m, dt) {
  m.vy += GRAVITY * dt;
  m.x += m.vx * dt;
  m.y += m.vy * dt;
  m.theta += m.omega * dt;
  // While vibrationally excited, keep the bond-oscillation animation alive.
  // After the energy leaves (via collision or emission) the flash counter
  // decays for a brief afterglow.
  if (m.isGreenhouse && m.vibrationEnergy > 0) {
    m.vibrationFlash = VIBRATION_FRAMES;
    m.vibrationPhase += 0.55 * dt;
  } else if (m.vibrationFlash > 0) {
    m.vibrationFlash -= dt;
    m.vibrationPhase += 0.4 * dt;
  }

  // A spotlighted carrier that has bled its extra energy back down to ambient
  // (through ordinary collisions) stops glowing even if it never met a CO2.
  if (m.carryingHeat && 0.5 * (m.vx * m.vx + m.vy * m.vy) < 0.45) {
    m.carryingHeat = false;
  }

  const cr = MOL_TYPES[m.type].collisionRadius;
  if (m.x < columnLeft + cr) { m.x = columnLeft + cr; m.vx = -m.vx; }
  if (m.x > columnRight - cr) { m.x = columnRight - cr; m.vx = -m.vx; }
  if (m.y < columnTop + cr) { m.y = columnTop + cr; m.vy = -m.vy; }
  // Hard floor: gas can't fall through the surface line. When it strikes, it
  // thermalises with the nearest surface atom through one elastic collision
  // (exchangeWithGround), so accommodation is emergent and energy-conserving.
  if (m.y > groundY - cr) {
    m.y = groundY - cr;
    if (!exchangeWithGround(m)) {
      if (m.vy > 0) m.vy = -m.vy;
    } else if (m.vy > 0) {
      // Still heading into the floor after the exchange — reflect so it leaves.
      m.vy = -m.vy;
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
  // A non-greenhouse partner now carries the CO2's released energy — light it
  // up until it passes it on (to a CO2) or cools back to ambient.
  if (!partner.isGreenhouse) partner.carryingHeat = true;
  co2.vibrationFlash = Math.max(co2.vibrationFlash, 6);  // brief afterglow
}

function thermallyExciteCO2(co2, partner) {
  const pKE = 0.5 * (partner.vx * partner.vx + partner.vy * partner.vy);
  if (pKE < THERMAL_EXCITE_QUANTUM) return;
  // Take a quantum of energy from partner's KE.
  const scale = Math.sqrt((pKE - THERMAL_EXCITE_QUANTUM) / pKE);
  partner.vx *= scale; partner.vy *= scale;
  // Energy has been handed back to a greenhouse molecule — stop spotlighting.
  partner.carryingHeat = false;
  co2.vibrationEnergy += THERMAL_EXCITE_QUANTUM;
  co2.vibrationFlash = VIBRATION_FRAMES;
  co2.vibrationPhase = 0;
  co2.vibrationMode = Math.floor(Math.random() * 3);
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

function emitGroundAtomPhoton(x, E) {
  const freq = constrain(E, GH_ABSORB_BAND_LOW, GH_ABSORB_BAND_HIGH);
  const ang = -HALF_PI + random(-1.0, 1.0);
  photons.push({
    x, y: groundY - 2,
    vx: cos(ang) * PHOTON_SPEED, vy: sin(ang) * PHOTON_SPEED,
    freq, source: 'ground',
    lastGhAltKm: -1,
    energy: E, dead: false,
  });
  // No reservoir bookkeeping here: the emitting atom already paid for this
  // photon by losing E from its own kinetic energy (see stepGroundAtoms).
}

function updatePhoton(p, dt) {
  p.x += p.vx * dt; p.y += p.vy * dt;

  if (p.x < columnLeft) { p.x = columnLeft; p.vx = -p.vx; }
  if (p.x > columnRight) { p.x = columnRight; p.vx = -p.vx; }

  if (p.y < columnTop - 4) {
    const alt = p.lastGhAltKm >= 0 ? p.lastGhAltKm : 0;
    recordEmissionAltitude(alt);
    p.dead = true; return;
  }

  if (p.y > groundY) {
    absorbIntoGround(p.x, p.energy);
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
      // Pick a vibration mode at random. In reality the mode that activates
      // depends on the photon's frequency relative to the CO2 absorption
      // bands (asymmetric stretch ~2350 cm⁻¹, bending ~667 cm⁻¹, symmetric
      // stretch is IR-inactive). That detail belongs in a dedicated demo;
      // here we just want all three modes to be visible.
      bestM.vibrationMode = Math.floor(Math.random() * 3);
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

function drawTemperatureGraph() {
  const temps = smoothedBandTemps || rawBandTemperatures();
  // Plotted in the left margin, on the same side as the altitude axis. The
  // vertical axis is altitude (shared with the column via altKmToY); the
  // horizontal axis is temperature, so the curve reads as temp-vs-height.
  const gLeft = 8;
  const gRight = columnLeft - 42;   // leave room for the km labels by the axis
  const gW = gRight - gLeft;
  const TMIN = -60, TMAX = 30;
  const tx = (C) => gLeft + ((constrain(C, TMIN, TMAX) - TMIN) / (TMAX - TMIN)) * gW;

  textFont('Menlo');
  noStroke();
  fill(120);
  textSize(10);
  textAlign(LEFT, BOTTOM);
  text('TEMP \u00b0C', gLeft, columnTop - 4);

  // Vertical reference lines + labels at a couple of round temperatures.
  textAlign(CENTER, TOP);
  textSize(8);
  for (const Cmark of [-50, 0]) {
    const x = tx(Cmark);
    stroke(228);
    strokeWeight(1);
    line(x, columnTop, x, groundY);
    noStroke();
    fill(150);
    text(Cmark + '\u00b0', x, groundY + GROUND_HEIGHT + 2);
  }

  // Temperature-vs-altitude curve.
  const pts = [];
  for (let i = 0; i < N_BANDS; i++) {
    const C = physKToDisplayC(temps[i]);
    pts.push({ x: tx(C), y: altKmToY((i + 0.5) * KM_PER_BAND), T: temps[i] });
  }
  // The ground temperature anchors the curve at the surface (altitude 0), so
  // the air gradient and the surface reading appear on one continuous plot.
  const groundPt = { x: tx(physKToDisplayC(groundTemp)), y: groundY, T: groundTemp };

  noFill();
  stroke(90);
  strokeWeight(1.5);
  beginShape();
  for (const p of pts) vertex(p.x, p.y);
  vertex(groundPt.x, groundPt.y);
  endShape();

  // Air-band markers, coloured with the same palette as the gas.
  noStroke();
  for (const p of pts) {
    const tNorm = constrain((p.T - 200) / 130, 0, 1);
    const [r, g, b] = keToColor(tNorm * 1.4 + 0.15, 255);
    fill(r, g, b);
    circle(p.x, p.y, 5);
  }

  // Ground marker — a distinct outlined square (vs the round air markers) so
  // it reads as "the surface", still tinted by its own temperature. It sits on
  // the 0 km axis line, so no extra label is needed.
  const gNorm = constrain((groundPt.T - 200) / 130, 0, 1);
  const [gr, gg, gb] = keToColor(gNorm * 1.4 + 0.15, 255);
  rectMode(CENTER);
  stroke(60);
  strokeWeight(1);
  fill(gr, gg, gb);
  square(groundPt.x, groundPt.y, 7);
  rectMode(CORNER);
  noStroke();
}

function drawGround() {
  const tNorm = constrain((groundTemp - 200) / 90, 0, 1);
  const colA = lerpColor(color('#6e4a2e'), color('#a85a2a'), tNorm);
  noStroke();
  const ar = GROUND_ATOM_R;
  // A thin solid base beneath the surface atoms, so the single live layer
  // reads as the top of solid ground rather than a row of floating dots.
  fill(lerpColor(color('#4a3320'), color('#6e3c1c'), tNorm));
  rect(columnLeft, groundY + ar, columnWidth, GROUND_HEIGHT - ar);
  // The ONE physically-simulated layer of surface atoms, drawn at their live
  // (spring-jiggled) positions — a single atomic layer on top of the solid.
  const colLive = lerpColor(colA, color(255), 0.18);
  fill(colLive);
  for (const g of groundAtoms) circle(g.x, g.y, ar * 2);
  // Faint surface line so the gas/ground boundary stays crisp.
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
const CO2_OUTLINE_COLOR = '#16a34a';   // vivid green
function drawMolecules() {
  for (const m of molecules) {
    if (!m.isGreenhouse && !showNonGHGases) continue;
    drawMoleculeAt(m, m.x, m.y, 1);
  }
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

    // Lens rim — neutral dark grey, NOT the CO2 highlight green. The green
    // is reserved for the outline on the molecule itself so that's the cue
    // for identifying a CO2.
    noFill();
    stroke(60, 110);
    strokeWeight(0.8);
    circle(co2.x, co2.y, LENS_R * 2);
  }
  textStyle(NORMAL);
}

// Render molecule m at an arbitrary screen position (cx, cy) with the given
// scale factor. Used both by the base-scale rendering (scale=1, cx=m.x,
// cy=m.y) and by the lens (scale=MAGNIFICATION, cx and cy remapped).
function drawMoleculeAt(m, cx, cy, scale) {
  const def = MOL_TYPES[m.type];

  // The bond-oscillation animation runs exactly while the molecule is holding
  // vibrational energy (an absorbed/transferred IR quantum). Once that energy
  // is discharged the molecule stops wiggling — so "wiggling" and "red" always
  // mean the same thing: currently excited.
  let vib = 0;
  if (m.vibrationEnergy > 0) vib = sin(m.vibrationPhase) * 1.4;

  const cosT = cos(m.theta), sinT = sin(m.theta);
  const n = def.atoms.length;
  const positions = [];
  const mode = m.vibrationMode || 0;
  for (let i = 0; i < n; i++) {
    const a = def.atoms[i];
    const off = vibrationOffset(n, mode, i, vib);
    const dxL = (a.dx + off.dx) * scale;
    const dyL = (a.dy + off.dy) * scale;
    positions.push({
      x: cx + dxL * cosT - dyL * sinT,
      y: cy + dxL * sinT + dyL * cosT,
      label: a.label,
    });
  }

  // Colour cue — a molecule's colour tracks its TEMPERATURE (translational
  // kinetic energy), on one continuous scale shared by every molecule. Cool =
  // faint blue-grey, hot = red. So heat picked up in a collision (whether from
  // a de-exciting CO2 or an ordinary energetic bump) shows up as a smooth warm-
  // up, and is then visibly lost again as the molecule shares it onward. The
  // separate "holding an absorbed IR quantum" state is shown by the bond
  // wiggle, not by colour, so the two cues stay independent.
  let bodyR, bodyG, bodyB, bodyA;
  if (showHeatColouring) {
    const ke = 0.5 * (m.vx * m.vx + m.vy * m.vy);
    [bodyR, bodyG, bodyB, bodyA] = molThermalColor(ke);
  } else if (m.isGreenhouse) {
    // Heat colouring off: neutral two-tone so CO2 is still distinguishable.
    bodyR = 40; bodyG = 40; bodyB = 40; bodyA = 255;
  } else {
    bodyR = 205; bodyG = 205; bodyB = 205; bodyA = 130;
  }

  // BONDS
  stroke(bodyR, bodyG, bodyB, bodyA);
  strokeWeight(scale > 1.5 ? 2 : 0.8);
  for (const [i, j] of def.bonds) {
    line(positions[i].x, positions[i].y, positions[j].x, positions[j].y);
  }

  // ATOMS
  noStroke();
  const atomR = def.atomRadius * scale;
  if (scale > 1.5) textSize(atomR);
  for (const p of positions) {
    fill(bodyR, bodyG, bodyB, bodyA);
    circle(p.x, p.y, atomR * 2);
    if (scale > 1.5) {
      fill(255, 245);
      text(p.label, p.x, p.y + 0.3);
    }
  }
}

// Per-atom offsets in body-frame for a given vibration mode at the current
// phase amplitude `vib` (signed, oscillates ±). Used by drawMoleculeAt.
//   n=3, mode 0 — SYMMETRIC STRETCH:    both O atoms swing outward together
//   n=3, mode 1 — ASYMMETRIC STRETCH:   both O atoms swing one way, C swings
//                                       the other (momentum-conserving wobble)
//   n=3, mode 2 — BENDING:              O atoms move perpendicular to bond
//                                       axis, C moves opposite to balance
//   n=2 — generic stretch (only one mode possible)
function vibrationOffset(n, mode, i, vib) {
  if (vib === 0) return { dx: 0, dy: 0 };
  if (n === 3) {
    if (mode === 0) {
      // Symmetric stretch: outer O atoms move outward in unison
      if (i === 0) return { dx: -vib, dy: 0 };
      if (i === 2) return { dx: vib, dy: 0 };
      return { dx: 0, dy: 0 };
    }
    if (mode === 1) {
      // Asymmetric stretch: both O move +x, C moves -x
      if (i === 0) return { dx: vib, dy: 0 };
      if (i === 1) return { dx: -vib * 0.7, dy: 0 };
      if (i === 2) return { dx: vib, dy: 0 };
    }
    if (mode === 2) {
      // Bending: O atoms move +y, C moves -y (in-plane bend)
      if (i === 0) return { dx: 0, dy: vib };
      if (i === 1) return { dx: 0, dy: -vib * 0.7 };
      if (i === 2) return { dx: 0, dy: vib };
    }
  }
  if (n === 2) {
    return { dx: (i === 0 ? -1 : 1) * vib * 0.5, dy: 0 };
  }
  return { dx: 0, dy: 0 };
}

// Photon rendering — solid coloured disc with a thin dark outline. RGB
// fill (not an "hsl(...)" CSS string) so the colour reliably renders in p5.
function drawPhotonAt(p, cx, cy, scale) {
  const isIR = p.freq < 0.30;
  const r = (isIR ? 4.5 : 4) * scale;
  const [pr, pg, pb] = freqToColor(p.freq);
  if (isIR) {
    // IR photons: no outline, lower opacity — they're numerous and we don't
    // want them to visually dominate the molecules.
    noStroke();
    fill(pr, pg, pb, 150);
  } else {
    // Non-IR (visible/UV) photons are faded — they're just transport that the
    // ground absorbs without atmospheric interaction.
    stroke(20, 20, 20, 55);
    strokeWeight(0.8 * scale);
    fill(pr, pg, pb, 55);
  }
  circle(cx, cy, r * 2);
}

function drawPhotons() {
  for (const p of photons) {
    const isIR = p.freq < 0.30;
    if (isIR && !showIRLight) continue;
    if (!isIR && !showVisibleLight) continue;
    drawPhotonAt(p, p.x, p.y, 1);
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
  const gT = physKToDisplayC(groundTemp);
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

// The rectangle the camera draws into and clips to (column + ground strip).
function viewportRect() {
  return { x: columnLeft, y: columnTop, w: columnWidth, h: (groundY + GROUND_HEIGHT) - columnTop };
}

function pointInViewport(x, y) {
  const r = viewportRect();
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

// Map a screen position to world (simulation) coordinates under the current
// camera, so hit-testing of in-scene objects keeps working while zoomed.
function screenToWorld(sx, sy) {
  return { x: (sx - viewOffsetX) / viewScale, y: (sy - viewOffsetY) / viewScale };
}

// Keep the zoom in range and stop panning from revealing anything outside the
// column. At viewScale === 1 both bounds collapse to 0, locking the fit view.
function clampView() {
  viewScale = constrain(viewScale, 1, VIEW_MAX_ZOOM);
  const r = viewportRect();
  viewOffsetX = constrain(viewOffsetX, (r.x + r.w) * (1 - viewScale), r.x * (1 - viewScale));
  viewOffsetY = constrain(viewOffsetY, (r.y + r.h) * (1 - viewScale), r.y * (1 - viewScale));
}

function beginSimCamera() {
  const r = viewportRect();
  const ctx = drawingContext;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  push();
  translate(viewOffsetX, viewOffsetY);
  scale(viewScale);
}

function endSimCamera() {
  pop();
  drawingContext.restore();
}

// Scroll to zoom toward the cursor; only inside the column (otherwise let the
// page scroll normally).
function mouseWheel(event) {
  if (!pointInViewport(mouseX, mouseY)) return;
  const w = screenToWorld(mouseX, mouseY);
  viewScale = constrain(viewScale * Math.exp(-event.delta * 0.0015), 1, VIEW_MAX_ZOOM);
  viewOffsetX = mouseX - w.x * viewScale;
  viewOffsetY = mouseY - w.y * viewScale;
  clampView();
  return false;   // prevent the page from scrolling
}

function mousePressed() {
  // Hit-test scene objects in world space so they stay clickable while zoomed.
  const w = screenToWorld(mouseX, mouseY);
  if (pointInBox(w.x, w.y, smokestackBox)) {
    smokestackHeld = true;
    return false;
  }
  if (pointInBox(w.x, w.y, treeBox)) {
    treeHeld = true;
    return false;
  }
  // Otherwise, a drag inside the zoomed column pans the view.
  if (viewScale > 1 && pointInViewport(mouseX, mouseY)) {
    isPanning = true;
    panStartX = mouseX; panStartY = mouseY;
    panStartOffX = viewOffsetX; panStartOffY = viewOffsetY;
    return false;
  }
}

function mouseDragged() {
  if (isPanning) {
    viewOffsetX = panStartOffX + (mouseX - panStartX);
    viewOffsetY = panStartOffY + (mouseY - panStartY);
    clampView();
    return false;
  }
}

function mouseReleased() {
  smokestackHeld = false;
  treeHeld = false;
  isPanning = false;
}
