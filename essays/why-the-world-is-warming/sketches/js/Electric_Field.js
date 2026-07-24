// Electric Field Ripples — page 4 demo: "Whenever an electron velshifts, it
// produces a ripple in the electric field which, when it reaches another
// charge, forces it to velshift the same way."
//
// Two like charges sit at rest. CLICK to fling the left charge toward the
// cursor: that single velshift launches an expanding ripple, drawn as a shell
// of transverse field arrows. When the ripple reaches the right charge it
// pushes it the same way. Press R to reset.

const C = 180;             // ripple (wave) speed, px/s
const FIELD_GAIN = 24;     // field arrow strength from p1's retarded velshift
const RESPONSE_GAIN = 60;  // how hard the ripple shoves the responder charge
const ARROW_MAX = 16;      // constant max arrow length (the clamp)
const KICK = 1200;         // impulse acceleration toward cursor on click, px/s²
const KICK_TIME = 0.28;    // how long the kick lasts, s

let scaleSlider, gammaSlider, densitySlider;
let lastGap = -1;

let t = 0;
let testCharges = [];
let p1, p2;                // left = driven, right = responder
let hist1 = [], hist2 = []; // accel/pos history of each charge (retarded field)
let kick = null;           // active kick { ax, ay, until }

function setup() {
  createCanvas(windowWidth, windowHeight);
  buildControls();
  layout();
  resetSim();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  layout();
  resetSim();
}

function buildControls() {
  scaleSlider = createSlider(0.5, 6, 2.2, 0.1);
  scaleSlider.position(14, 14); scaleSlider.style('width', '160px');
  gammaSlider = createSlider(1, 5, 2.4, 0.1);
  gammaSlider.position(14, 40); gammaSlider.style('width', '160px');
  densitySlider = createSlider(14, 50, 26, 1);
  densitySlider.position(14, 66); densitySlider.style('width', '160px');
}

function gridGap() { return densitySlider ? densitySlider.value() : 26; }

function resetSim() {
  p1 = { x: width * 0.5 - 150, y: height / 2, vx: 0, vy: 0 };
  p2 = { x: width * 0.5 + 150, y: height / 2, vx: 0, vy: 0 };
  hist1 = []; hist2 = [];
  kick = null;
  t = 0;
}

function layout() {
  const gap = gridGap();
  lastGap = gap;
  testCharges = [];
  for (let gx = gap; gx < width - gap / 2; gx += gap) {
    for (let gy = gap; gy < height - gap / 2; gy += gap) {
      testCharges.push({ x: gx, y: gy });
    }
  }
}

function mousePressed() {
  // Fling p1 toward the cursor: a brief, strong velshift that radiates a pulse.
  const dx = mouseX - p1.x, dy = mouseY - p1.y;
  const d = Math.max(1, Math.hypot(dx, dy));
  kick = { ax: KICK * dx / d, ay: KICK * dy / d, until: t + KICK_TIME };
}

function keyPressed() {
  if (key === 'r' || key === 'R') resetSim();
}

// Acceleration of p1 right now: one full sine pulse toward the cursor (out and
// back), so it ends a single velshift with no leftover velocity. After that p1
// only moves when p2's returning ripple reaches it.
function p1Accel() {
  if (!kick || t >= kick.until) return { ax: 0, ay: 0 };
  const phase = 1 - (kick.until - t) / KICK_TIME;   // 0..1 over the pulse
  const s = Math.sin(TWO_PI * phase);
  return { ax: kick.ax * s, ay: kick.ay * s };
}

// Find p1's recorded state at a retarded time; null if the ripple hasn't
// travelled that far yet.
function sampleRetarded(tr) {
  if (tr < 0 || history.length === 0) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].t <= tr) return history[i];
  }
  return null;
}

// Find a charge's recorded state at a retarded time; null if the ripple hasn't
// travelled that far yet.
function sampleRetarded(hist, tr) {
  if (tr < 0 || hist.length === 0) return null;
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i].t <= tr) return hist[i];
  }
  return null;
}

// Transverse (radiated) field acceleration felt at (x,y) from a source whose
// retarded state is `src`, with response strength `gain`.
function radiatedAccel(x, y, src, gain) {
  if (!src) return { ax: 0, ay: 0 };
  const dx = x - src.x, dy = y - src.y;
  const r = Math.max(30, Math.hypot(dx, dy));
  const ux = dx / r, uy = dy / r;
  const proj = src.ax * ux + src.ay * uy;
  // Radiated field of a positive charge opposes its transverse acceleration, so
  // a like charge is pushed the OPPOSITE way to the source's velshift.
  return { ax: -(src.ax - proj * ux) * gain / r, ay: -(src.ay - proj * uy) * gain / r };
}

function draw() {
  const dt = Math.min(0.05, deltaTime / 1000);
  t += dt;
  if (densitySlider.value() !== lastGap) layout();

  // Each charge velshifts in response to the OTHER's retarded ripple. The right
  // charge moves when p1's pulse reaches it, and its own velshift radiates a
  // ripple back that later reaches p1. p1 also feels the user's kick.
  const f1 = radiatedAccel(p1.x, p1.y, sampleRetarded(hist2, t - dist(p1.x, p1.y, p2.x, p2.y) / C), RESPONSE_GAIN);
  const f2 = radiatedAccel(p2.x, p2.y, sampleRetarded(hist1, t - dist(p1.x, p1.y, p2.x, p2.y) / C), RESPONSE_GAIN);
  const ko = p1Accel();
  const a1x = f1.ax + ko.ax, a1y = f1.ay + ko.ay;
  const a2x = f2.ax, a2y = f2.ay;

  p1.vx += a1x * dt; p1.vy += a1y * dt;
  p2.vx += a2x * dt; p2.vy += a2y * dt;
  p1.x += p1.vx * dt; p1.y += p1.vy * dt;
  p2.x += p2.vx * dt; p2.y += p2.vy * dt;

  hist1.push({ t, x: p1.x, y: p1.y, ax: a1x, ay: a1y });
  hist2.push({ t, x: p2.x, y: p2.y, ax: a2x, ay: a2y });
  if (hist1.length > 4000) hist1.shift();
  if (hist2.length > 4000) hist2.shift();

  background(8, 9, 12);
  drawTestCharges();
  drawCharge(p1, p1.vx, p1.vy, true);
  drawCharge(p2, p2.vx, p2.vy, false);
  drawUI();
}

// Lattice of probe arrows showing the SUM of both charges' retarded fields.
function drawTestCharges() {
  for (const p of testCharges) {
    const r1 = Math.max(30, dist(p.x, p.y, p1.x, p1.y));
    const r2 = Math.max(30, dist(p.x, p.y, p2.x, p2.y));
    const a = radiatedAccel(p.x, p.y, sampleRetarded(hist1, t - r1 / C), FIELD_GAIN);
    const b = radiatedAccel(p.x, p.y, sampleRetarded(hist2, t - r2 / C), FIELD_GAIN);
    const fx = a.ax + b.ax, fy = a.ay + b.ay;
    if (Math.hypot(fx, fy) < 1e-3) { dot(p.x, p.y); continue; }
    drawArrow(p.x, p.y, fx, fy);
  }
}

function dot(x, y) {
  noStroke();
  fill(255, 105, 180, 200);
  circle(x, y, 3);
}

function drawArrow(x0, y0, fx, fy) {
  const len = Math.hypot(fx, fy) * scaleSlider.value();
  const ang = Math.atan2(fy, fx);
  const L = Math.min(len, ARROW_MAX);
  const mag = constrain(len / ARROW_MAX, 0, 1);
  const alpha = 12 + Math.pow(mag, gammaSlider.value()) * 243;
  dot(x0, y0);
  if (len < 1e-3) return;
  const x1 = x0 + Math.cos(ang) * L, y1 = y0 + Math.sin(ang) * L;
  stroke(120, 180, 255, alpha);
  strokeWeight(1.6);
  line(x0, y0, x1, y1);
  const hl = Math.max(5, L * 0.5);
  noStroke();
  fill(120, 180, 255, alpha);
  triangle(
    x1, y1,
    x1 - hl * Math.cos(ang - 0.5), y1 - hl * Math.sin(ang - 0.5),
    x1 - hl * Math.cos(ang + 0.5), y1 - hl * Math.sin(ang + 0.5)
  );
}

function drawCharge(p, vx, vy, isSource) {
  const v = Math.hypot(vx, vy);
  if (v > 4) {
    const ux = vx / v, uy = vy / v, L = constrain(v * 0.08, 8, 40);
    stroke(255, 210, 90); strokeWeight(3);
    line(p.x, p.y, p.x + ux * L, p.y + uy * L);
    noStroke(); fill(255, 210, 90);
    triangle(p.x + ux * (L + 6), p.y + uy * (L + 6),
      p.x + ux * L - uy * 5, p.y + uy * L + ux * 5,
      p.x + ux * L + uy * 5, p.y + uy * L - ux * 5);
  }
  noStroke();
  fill(isSource ? color(214, 74, 56) : color(230, 120, 90));
  circle(p.x, p.y, 22);
  stroke(255); strokeWeight(2.5);
  line(p.x - 6, p.y, p.x + 6, p.y);
  line(p.x, p.y - 6, p.x, p.y + 6);
  noStroke();
}

function drawUI() {
  fill(180);
  textFont('monospace'); textSize(11); textAlign(LEFT, CENTER);
  text('arrow scale', 184, 22);
  text('opacity curve', 184, 48);
  text('lattice density', 184, 74);
  textAlign(CENTER, TOP);
  fill(210);
  text('click to push the left charge toward the cursor   -   press R to reset', width / 2, 14);
}
