// Newton's cannonball, as a slingshot on a tower.
//
// Each essay unit that matters is tied to a sim state (see applyUnitState):
// 'ready:N' is the launch-ready slingshot at power N, 'landed:N' the aftermath
// of that launch, plus ghost variants. Scrolling to a unit puts the sim in
// its state, in both directions; completed shots post outcome events that
// move the essay to the matching landing unit. Orbit outcomes fire when the
// orbit completes.
//
// The physics uses exact closed-form solutions: outside the Earth each ball
// follows a Keplerian conic evaluated from Kepler's equation; inside it (in
// ghost mode) gravity for a uniform-density Earth is linear in r, so motion
// is an exact 2D harmonic oscillator — ellipses centred on the Earth's
// centre. Segments are stitched at surface crossings, where the two force
// laws agree.
//
// Every new shot also re-fires all previously slung balls (faint, in their
// stage colours) and re-drops the dropped ball, each with a flight timer
// that freezes when it lands.
//
// shared.js is loaded first purely for its mobile touch plumbing
// (disableMobileGestureConflicts and the touch->mouse forwarding); all of its
// input handlers are overridden below.

let earthR = 2000;
const TARGET_FPS = 60; // flight times are shown in seconds at this framerate
let surfaceG = 0.01;
let mu; // gravitational parameter = surfaceG * earthR^2
let omega; // interior (uniform density) oscillation frequency = sqrt(mu / earthR^3)
let landR; // radius at which balls touch down

let towerH = 69;
let ballRadius = 6;

// Cats stand in for the balls: cat.svg, scaled so its head circle (outer edge
// of the stroke) matches the ball's radius, with the magenta fill recoloured
// to the ball's colour. Until the file has loaded, plain circles are drawn.
const CAT_FILL = '#ed1e79';
const CAT = { w: 1013.522, h: 878.763, cx: 505.123, cy: 458.697, r: 413.565 + 6.5 };
let catSvg = null;
const catSprites = {}; // one rasterised sprite per colour
fetch('cat.svg').then(r => r.text()).then(t => { catSvg = t; }).catch(() => { });

function catSprite(col) {

    if (!catSvg) return null;

    let hex = '#' + [red(col), green(col), blue(col)]
        .map(v => round(v).toString(16).padStart(2, '0')).join('');
    let entry = catSprites[hex];

    if (!entry) {
        entry = catSprites[hex] = { canvas: null };
        let svg = catSvg.replace(new RegExp(CAT_FILL, 'gi'), hex)
            .replace('<svg ', '<svg width="' + CAT.w + '" height="' + CAT.h + '" ');
        let img = new Image();
        img.onload = () => {
            let c = document.createElement('canvas');
            c.width = 512;
            c.height = Math.round(512 * CAT.h / CAT.w);
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            entry.canvas = c;
        };
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    }

    return entry.canvas;

}

// a cat centred on (x, y), kept upright on screen whatever the camera's rotation
function drawCat(x, y, col, alphaValue) {

    let sprite = catSprite(col);

    if (!sprite) {
        noStroke();
        fill(red(col), green(col), blue(col), alphaValue);
        circle(x, y, ballRadius * 2);
        return;
    }

    let k = ballRadius / CAT.r;
    push();
    translate(x, y);
    rotate(-cam.rot);
    drawingContext.globalAlpha = alphaValue / 255;
    drawingContext.drawImage(sprite, -CAT.cx * k, -CAT.cy * k, CAT.w * k, CAT.h * k);
    pop();

}

let towerAngle = -Math.PI / 2; // tower at the top of the earth
let towerBase, towerTop, upDir, rightDir;

let prongBase, prongUp, prongDn; // the slingshot fork, rotated 90° onto the tower
let slingRelease; // prong-tip level: ball rest + release point
let dropArmEnd; // the arm on the other side holding the dropped ball
let launchDir; // exactly tangential at the release point (visually due right)

let vCircular;
let powerLevels = [];
let stage = 0;
let shotCount = 0;
let ghostMode = false;

// the essay state the sim currently mirrors, e.g. 'ready:2' or 'landed:2'
let simState = null;
let pendingState = null; // arrives before setup() has run
let simInitialised = false;

window.onEssayLineActive = function (data) {

    if (!data || !data.state) return;

    if (!simInitialised) {
        pendingState = data.state;
        return;
    }

    applyUnitState(data.state);

};

// the surface-removed section is a sequence of "play" scenes rather than
// launches: nothing more is slung, the reader presses play to watch the
// dropped ball, then every earlier launch, complete its orbit(s)
const GHOST_PHASES = {
    'ghost-ready': 0, // the ground becomes a ghost
    'ghost-drop': 1, // play follows the dropped ball
    'ghost-dropped': 2, // ...which has completed its orbit
    'ghost-failed': 3, // play follows every earlier launch (and the drop)
    'ghost-failed-done': 4 // ...which have all completed their orbits
};

function parseUnitState(key) {

    let last = powerLevels.length - 1;

    if (key in GHOST_PHASES) {
        let phase = GHOST_PHASES[key];
        return {
            kind: (phase === 2 || phase === 4) ? 'landed' : 'ready',
            stage: last, ghost: true, phase: phase
        };
    }

    let [kind, n] = key.split(':');
    return { kind: kind, stage: Math.min(parseInt(n, 10) || 0, last), ghost: false, phase: -1 };

}

function applyUnitState(key) {

    if (key === simState) return;

    let from = simState ? parseUnitState(simState) : null;
    let target = parseUnitState(key);
    simState = key;

    let oldStage = stage;

    // the usual step forward — a landed shot to the next upgrade — keeps the
    // reader's own shots on screen; anything else is rebuilt from scratch
    let forwardStep = from && from.kind === 'landed' && target.kind === 'ready' &&
        !from.ghost && (target.ghost ? target.stage === from.stage : target.stage === from.stage + 1);

    // within the ghost scenes: arming the next play button needs no rebuild
    let ghostStep = from && from.ghost && target.ghost && (
        (from.phase <= 1 && target.phase <= 1) ||
        (from.phase === 2 && target.phase === 3));

    if (forwardStep || ghostStep) {
        if (shotState !== 'ready') finalizeShot();
        stage = target.stage;
        ghostMode = target.ghost;
    } else {
        rebuildState(target);
    }

    wideReady = !target.ghost && target.kind === 'landed';

    if (!target.ghost && stage !== oldStage) {
        upgradeMessage = stage > oldStage ? "Slingshot upgraded!" : "Slingshot downgraded.";
        upgradeMessageTimer = 160;
    } else if (target.phase === 0 && forwardStep) {
        upgradeMessage = "The ground is now a ghost — balls fall straight through!";
        upgradeMessageTimer = 240;
    }

}

// reproduce a state from scratch: the earlier shots are replayed at full
// power instantly (the physics is closed form), so a landing unit shows its
// landed shot and a launch unit shows the slingshot freshly armed
function rebuildState(target) {

    if (shotState !== 'ready') resetShot();

    balls = [];
    ghostTrails = [];
    pastShots = [];
    orbitMarks = [];
    shotCount = 0;
    lastShotBounds = null;
    donePhase = null;
    ghostRunMode = null;

    let last = powerLevels.length - 1;
    let plain;

    if (target.ghost) {
        plain = last + 1; // every plain stage
    } else {
        plain = target.stage + (target.kind === 'landed' ? 1 : 0);
    }

    // a landed target leaves its own shot on screen
    let keepLast = target.kind === 'landed' && !target.ghost;

    ghostMode = false;
    for (let s = 0; s < plain; s++) {
        replayShot(s, keepLast && s === plain - 1);
    }

    if (target.ghost) {
        ghostMode = true;
        if (target.phase >= 2) replayGhostRun('drop', target.phase === 2);
        if (target.phase >= 4) replayGhostRun('all', true);
    }

    stage = target.stage;
    ghostMode = target.ghost;

}

function replayGhostRun(mode, keepOnScreen) {

    startGhostRun(mode);

    let guard = 0;
    while (!stepGhostRunOnce() && guard++ < maxFlightFrames + 10) { }

    if (keepOnScreen) {
        shotState = 'done';
        donePhase = 'zoomout';
        doneTimer = 0;
        markCompletedOrbits();
        return;
    }

    finalizeShot();

}

function replayShot(s, keepOnScreen) {

    stage = s;
    launchShot(powerLevels[s]);

    let guard = 0;
    while (!stepFlightOnce() && guard++ < maxFlightFrames + 10) { }

    if (keepOnScreen) {
        shotState = 'done';
        donePhase = 'zoomout';
        doneTimer = 0;
        markCompletedOrbits();
        return;
    }

    finalizeShot();

}

let shotState = 'ready'; // 'ready' | 'releasing' | 'flying' | 'done'
let donePhase = null; // 'linger' (hold the chase view) | 'zoomout'
let doneTimer = 0;
let launchStage = 0; // stage at the moment of launch, for outcome events
let wideReady = false; // after a shot, ready-state stays zoomed out until the next upgrade
let releaseProgress = 0;
const RELEASE_FRAMES = 6;
let pendingRelease = null; // { pulledPos, v }

let draggingSling = false;
let pullDist = 0;

let fastForward = false;

let slingBallPos; // resting/dragged position while ready

let balls = [];
let pastShots = []; // { v, col } of all previous slung shots
let ghostTrails = [];

let sweptAngle = 0;
let prevHeading = 0;
let flightFrames = 0;
let maxFlightFrames = 30000;

let upgradeMessageTimer = 0;
let upgradeMessage = "";

let cam = { x: 0, y: 0, scale: 1, rot: 0 };
let shotBounds = null; // bbox of the current shot's flight, for the camera
let lastShotBounds = null; // kept after the shot ends, for the re-armed wide view

let ghostRunMode = null; // 'drop' | 'all' while a surface-removed play scene is on screen
let ghostFit = null; // bbox of the scene's complete orbits, known in advance
let orbitMarks = []; // apogee/perigee markers on completed orbits

let slingStars = [];

let earthColorSling, dropColorSling;
let stageColors = [];
let gravityImg;
const GRAV_IMG_WORLD_RADIUS = 8000;
const GRAV_IMG_SIZE = 1000;


function setup() {

    pixelDensity(1);
    createCanvas(windowWidth, windowHeight);
    textFont(SIM_FONT);
    disableMobileGestureConflicts();

    mu = surfaceG * earthR * earthR;
    omega = Math.sqrt(mu / (earthR * earthR * earthR));
    landR = earthR + ballRadius;

    upDir = p5.Vector.fromAngle(towerAngle);
    rightDir = createVector(-upDir.y, upDir.x);

    towerBase = upDir.copy().mult(earthR);
    towerTop = upDir.copy().mult(earthR + towerH);

    // slingshot rotated 90°: handle attaches to the tower top, prongs open
    // rightward above and below the flight line; the ball rests at prong level
    prongBase = p5.Vector.add(towerTop, rightDir.copy().mult(10));
    prongUp = p5.Vector.add(prongBase, rightDir.copy().mult(8)).add(upDir.copy().mult(7));
    prongDn = p5.Vector.add(prongBase, rightDir.copy().mult(8)).sub(upDir.copy().mult(7));
    slingRelease = p5.Vector.add(towerTop, rightDir.copy().mult(18));

    // the arm on the other side holds the ball to be dropped, at the same
    // altitude so equal fall times really are equal
    dropArmEnd = p5.Vector.sub(towerTop, rightDir.copy().mult(18));

    // launch exactly tangentially (the release point sits a hair off the
    // tower's radial, and a horizontal launch there would not be at apoapsis)
    launchDir = createVector(-slingRelease.y, slingRelease.x).normalize();

    //
    // Stage speeds, in closed form. A tangential launch is a launch from
    // apoapsis, so landing at r = landR after sweeping φ requires
    //   e = (r0 - landR) / (r0 - landR cos φ),  v = sqrt(mu (1-e) / r0)
    //
    let r0 = slingRelease.mag();

    let eFar = (r0 - landR) / (r0 - landR * Math.cos(radians(170)));
    let vFar = Math.sqrt(mu * (1 - eFar) / r0);

    vCircular = Math.sqrt(mu / r0);

    powerLevels = [
        0.6, // lands at the same time as the dropped ball
        2,
        3,
        3.9, // noticeably later and further
        vFar, // reaches the far side of the planet
        vCircular, // low circular orbit
        vCircular * 1.18 // eccentric orbit
    ];

    earthColorSling = color(PALETTE.earthLight);

    // rocket hue throughout: the resting/launched ball gains saturation and
    // brightness with each upgrade; the stationary drop ball stays pale
    colorMode(HSB, 360, 100, 100);
    for (let s = 0; s < powerLevels.length; s++) {
        let t = s / (powerLevels.length - 1);
        stageColors.push(color(318, 40 + 60 * t, 55 + 45 * t));
    }
    dropColorSling = color(318, 18, 90);
    colorMode(RGB, 255, 255, 255, 255);

    gravityImg = generateSlingGravityField();

    // the shared sky (same scale relative to the Earth as in the rocket
    // sketches), bucketed by size and brightness so each frame draws a few
    // batched passes
    let skyBuckets = {};
    for (let s of generateStarField(earthR)) {
        let sizeBucket = min(5, floor((s.size / (earthR / 100) - 0.3) / 3.2 * 6));
        let brightBucket = min(2, floor((s.brightness - 100) / 155 * 3));
        let key = sizeBucket * 3 + brightBucket;
        if (!skyBuckets[key]) {
            skyBuckets[key] = {
                weight: (0.3 + (sizeBucket + 0.5) * 3.2 / 6) * earthR / 100,
                alpha: 100 + (brightBucket + 0.5) * 155 / 3,
                pts: []
            };
        }
        skyBuckets[key].pts.push(s.x, s.y);
    }
    slingStars = Object.values(skyBuckets);

    cam.x = towerTop.x;
    cam.y = towerTop.y;
    cam.scale = 1;
    cam.rot = 0;

    resetShot();

    simInitialised = true;
    applyUnitState(pendingState || 'ready:0');

}

// gravity glow including the interior of the distributed-mass Earth:
// linear in r inside, inverse-square outside (radially symmetric, so it's
// built from a 1D profile at reduced resolution and drawn scaled up).
// normalisation reaches exactly zero at the image edge so there is no
// visible cutoff however far the camera zooms out
function generateSlingGravityField() {

    let buffer = createGraphics(GRAV_IMG_SIZE, GRAV_IMG_SIZE);
    buffer.pixelDensity(1);
    buffer.loadPixels();

    let worldPerPx = (2 * GRAV_IMG_WORLD_RADIUS) / GRAV_IMG_SIZE;

    let gMax = surfaceG;
    let gMin = gMax * 0.004;
    let gEdge = surfaceG * earthR * earthR / (GRAV_IMG_WORLD_RADIUS * GRAV_IMG_WORLD_RADIUS);
    let logEdge = Math.log10(gEdge + gMin);
    let logRange = Math.log10(gMax + gMin) - logEdge;

    let maxR = Math.ceil(GRAV_IMG_SIZE * 0.7072) + 2;
    let alphaByR = new Array(maxR);
    for (let rp = 0; rp < maxR; rp++) {
        let r = rp * worldPerPx;
        let g = r < earthR ? surfaceG * r / earthR : surfaceG * earthR * earthR / (r * r);
        let normalized = (Math.log10(g + gMin) - logEdge) / logRange;
        alphaByR[rp] = constrain(normalized, 0, 1) * 255;
    }

    let half = GRAV_IMG_SIZE / 2;
    for (let y = 0; y < GRAV_IMG_SIZE; y++) {
        let dy = y - half;
        for (let x = 0; x < GRAV_IMG_SIZE; x++) {
            let dx = x - half;
            let rp = Math.round(Math.sqrt(dx * dx + dy * dy));
            let idx = 4 * (x + y * GRAV_IMG_SIZE);
            buffer.pixels[idx] = 0;
            buffer.pixels[idx + 1] = 255;
            buffer.pixels[idx + 2] = 255;
            buffer.pixels[idx + 3] = alphaByR[Math.min(rp, maxR - 1)];
        }
    }

    buffer.updatePixels();
    return buffer;
}

function resetShot() {

    balls = [];
    slingBallPos = slingRelease.copy();

    shotState = 'ready';
    draggingSling = false;
    pendingRelease = null;
    pullDist = 0;
    sweptAngle = 0;
    flightFrames = 0;
    shotBounds = null;

}

//
// Exact two-body motion (elliptic; all slingshot speeds are far below escape)
//

function computeOrbit(pos0, vel0) {

    let r = pos0.mag();
    let v2 = vel0.magSq();
    let energy = v2 / 2 - mu / r;
    let a = -mu / (2 * energy); // semi-major axis
    let h = pos0.x * vel0.y - pos0.y * vel0.x; // angular momentum (z)

    if (abs(h) < 1e-7 * Math.sqrt(mu * r)) {

        // degenerate radial orbit: a straight line through the centre,
        // parametrised by the cycloid r = (rMax/2)(1 + cos θ),
        // t = C (θ + sin θ), with period 4πC
        let rMax = -mu / energy;
        let C = Math.sqrt(rMax * rMax * rMax / (8 * mu));

        let cosT = constrain(2 * r / rMax - 1, -1, 1);
        let theta0 = Math.acos(cosT);
        let vr = (pos0.x * vel0.x + pos0.y * vel0.y) / r;
        if (vr > 0) {
            theta0 = 4 * Math.PI - theta0;
        }

        return {
            radial: true,
            ux: pos0.x / r,
            uy: pos0.y / r,
            rMax: rMax,
            C: C,
            t0: C * (theta0 + Math.sin(theta0))
        };
    }

    let rv = pos0.x * vel0.x + pos0.y * vel0.y;
    let coef = v2 - mu / r;
    let ex = (coef * pos0.x - rv * vel0.x) / mu;
    let ey = (coef * pos0.y - rv * vel0.y) / mu;
    let e = Math.hypot(ex, ey);

    let px, py;
    if (e > 1e-6) {
        px = ex / e;
        py = ey / e;
    } else {
        px = pos0.x / r;
        py = pos0.y / r;
    }
    let sgn = h >= 0 ? 1 : -1;
    let qx = -py * sgn;
    let qy = px * sgn;

    // for a (near-)circular orbit the eccentric anomaly is ill-defined and
    // atan2 of rounding noise can land on the antipode; start at 'periapsis'
    let E0 = e > 1e-6 ? Math.atan2(rv / Math.sqrt(mu * a), 1 - r / a) : 0;

    return {
        radial: false,
        a: a,
        b: a * Math.sqrt(Math.max(0, 1 - e * e)),
        e: e,
        px: px, py: py, qx: qx, qy: qy,
        n: Math.sqrt(mu / (a * a * a)),
        M0: E0 - e * Math.sin(E0)
    };
}

// Kepler's equation M = E - e sin E, solved by bisection: f is monotonic and
// the root always lies in [M - e, M + e], so this is unconditionally robust
function solveKepler(M, e) {

    let lo = M - e;
    let hi = M + e;

    for (let i = 0; i < 48; i++) {
        let mid = (lo + hi) / 2;
        if (mid - e * Math.sin(mid) < M) {
            lo = mid;
        } else {
            hi = mid;
        }
    }

    return (lo + hi) / 2;
}

function orbitPositionAt(orbit, t) {

    if (orbit.radial) {

        let period = 4 * Math.PI * orbit.C;
        let tau = (orbit.t0 + t) % period;

        let guess = tau / orbit.C;
        let lo = Math.max(0, guess - 1.1);
        let hi = Math.min(4 * Math.PI, guess + 1.1);
        for (let i = 0; i < 44; i++) {
            let mid = (lo + hi) / 2;
            if (orbit.C * (mid + Math.sin(mid)) < tau) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let theta = (lo + hi) / 2;

        let r = orbit.rMax / 2 * (1 + Math.cos(theta));
        let side = (theta < Math.PI || theta > 3 * Math.PI) ? 1 : -1;

        return createVector(orbit.ux * r * side, orbit.uy * r * side);
    }

    let E = solveKepler(orbit.M0 + orbit.n * t, orbit.e);
    let x = orbit.a * (Math.cos(E) - orbit.e);
    let y = orbit.b * Math.sin(E);

    return createVector(
        x * orbit.px + y * orbit.qx,
        x * orbit.py + y * orbit.qy
    );
}

//
// Piecewise motion: exact Kepler outside the surface, exact harmonic motion
// (uniform-density interior gravity, linear in r) inside it
//

function makeSegment(pos, vel, tStart, interior) {

    if (interior) {
        return {
            type: 'shm',
            t0: tStart,
            ax: pos.x, ay: pos.y,
            bx: vel.x / omega, by: vel.y / omega
        };
    }

    return {
        type: 'kepler',
        t0: tStart,
        orbit: computeOrbit(pos, vel)
    };
}

function segmentPositionAt(seg, t) {

    let dt = t - seg.t0;

    if (seg.type === 'shm') {
        let c = Math.cos(omega * dt);
        let s = Math.sin(omega * dt);
        return createVector(seg.ax * c + seg.bx * s, seg.ay * c + seg.by * s);
    }

    return orbitPositionAt(seg.orbit, dt);
}

//
// Shots
//

function makeBall(pos, vel, col, alphaValue, kind) {
    return {
        seg: makeSegment(pos, vel, 0, pos.mag() < earthR),
        t: 0,
        pos: pos.copy(),
        trail: [pos.copy()],
        landed: false,
        timer: 0,
        col: col,
        alpha: alphaValue,
        kind: kind // 'primary' | 'past' | 'drop'
    };
}

function launchShot(v) {

    balls = [];

    balls.push(makeBall(slingRelease, launchDir.copy().mult(v), stageColors[stage], 255, 'primary'));

    // every previously slung ball fires again, faint, in its stage colour
    for (let past of pastShots) {
        balls.push(makeBall(slingRelease, launchDir.copy().mult(past.v), past.col, 90, 'past'));
    }

    balls.push(makeBall(dropArmEnd, createVector(0, 0), dropColorSling, 255, 'drop'));

    pastShots.push({ v: v, col: stageColors[stage] });

    launchStage = stage;
    shotState = 'flying';
    prevHeading = slingRelease.heading();
    sweptAngle = 0;
    flightFrames = 0;
    shotBounds = null;

}

function currentMaxPull() {
    // the draw-back length grows with each upgrade
    return 55 + stage * 12;
}

function currentMaxSpeed() {
    return powerLevels[stage];
}

function releaseSpeed() {
    return (pullDist / currentMaxPull()) * currentMaxSpeed();
}

function primaryBall() {
    return balls.find(b => b.kind === 'primary');
}

function dropBallOf() {
    return balls.find(b => b.kind === 'drop');
}

function expandShotBounds(p) {
    if (!shotBounds) {
        shotBounds = { minX: p.x, maxX: p.x, minY: p.y, maxY: p.y };
    } else {
        shotBounds.minX = min(shotBounds.minX, p.x);
        shotBounds.maxX = max(shotBounds.maxX, p.x);
        shotBounds.minY = min(shotBounds.minY, p.y);
        shotBounds.maxY = max(shotBounds.maxY, p.y);
    }
}

function stepBall(ball) {

    if (ball.landed) return;

    let oldPos = ball.pos;
    ball.t++;
    let newPos = segmentPositionAt(ball.seg, ball.t);

    if (ghostMode) {

        let wasIn = oldPos.mag() < earthR;
        let isIn = newPos.mag() < earthR;

        if (wasIn != isIn) {

            let lo = ball.t - 1;
            let hi = ball.t;
            for (let i = 0; i < 30; i++) {
                let mid = (lo + hi) / 2;
                if ((segmentPositionAt(ball.seg, mid).mag() < earthR) == wasIn) {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            let tc = (lo + hi) / 2;

            let pc = segmentPositionAt(ball.seg, tc);
            let h = 0.05;
            let vc = p5.Vector.sub(
                segmentPositionAt(ball.seg, tc + h),
                segmentPositionAt(ball.seg, tc - h)
            ).div(2 * h);

            ball.seg = makeSegment(pc, vc, tc, !wasIn);
            newPos = segmentPositionAt(ball.seg, ball.t);
        }
    }

    let jump = p5.Vector.dist(oldPos, newPos);
    if (jump > 20) {
        let extra = min(12, ceil(jump / 15));
        for (let k = 1; k < extra; k++) {
            let ft = ball.t - 1 + k / extra;
            if (ft > ball.seg.t0) {
                ball.trail.push(segmentPositionAt(ball.seg, ft));
            }
        }
    }

    ball.pos = newPos;
    ball.timer = ball.t;

    if (!ghostMode && ball.pos.mag() <= landR) {
        ball.pos.setMag(landR);
        ball.landed = true;
    }

}

// real time by default; 8x only while the reader holds the fast-forward button
function stepsPerFrame() {
    return fastForward ? 16 : 2;
}

// completed-shot outcomes reveal the matching essay paragraphs (based on the
// stage the shot was launched at)
function shotOutcomeEvent() {

    switch (launchStage) {
        case 0: return 'slingSameTime';
        case 1: return 'slingLonger';
        case 2: return 'slingCurving';
        case 3: return 'slingFurther';
        case 4: return 'slingFarSide';
        case 5: return 'slingCircular';
        case 6: return 'slingEccentric';
    }
    return null;
}

// archive the finished shot and re-arm the slingshot
function finalizeShot() {

    for (let ball of balls) {
        ghostTrails.push({ points: ball.trail, col: ball.col });
    }
    shotCount++;
    if (shotBounds) {
        lastShotBounds = shotBounds;
    }
    orbitMarks = [];
    resetShot();

}

// advance every ball one step; true once the shot is complete
function stepFlightOnce() {

    let primary = primaryBall();
    let drop = dropBallOf();

    for (let ball of balls) {
        stepBall(ball);
        expandShotBounds(ball.pos);
    }
    flightFrames++;

    let newAngle = primary.pos.heading();
    if (!primary.landed) {
        let d = newAngle - prevHeading;
        if (d > PI) d -= TAU;
        if (d < -PI) d += TAU;
        sweptAngle += d;
    }
    prevHeading = newAngle;

    if (flightFrames % 3 == 0) {
        for (let ball of balls) {
            if (!ball.landed) {
                ball.trail.push(ball.pos.copy());
            }
        }
    }

    let orbitComplete = abs(sweptAngle) >= TAU;
    let mainOnesLanded = primary.landed && drop.landed;

    return mainOnesLanded || orbitComplete || flightFrames > maxFlightFrames;

}

function updateFlight() {

    for (let s = 0; s < stepsPerFrame(); s++) {

        if (!stepFlightOnce()) continue;

        // the shot is complete (for orbits, the moment the orbit closes):
        // the sim is now in this stage's landed state, and the outcome event
        // moves the essay to the matching landing unit
        simState = 'landed:' + launchStage;
        markCompletedOrbits();

        let outcome = shotOutcomeEvent();
        if (outcome) {
            window.parent.postMessage({ type: outcome }, "*");
        }

        // hold the chase view for a beat, then relax out to the whole
        // trajectory; the slingshot re-arms in the wide view and only
        // zooms back in when the reader scrolls to the next upgrade
        shotState = 'done';
        wideReady = true;
        donePhase = 'linger';
        doneTimer = 70;
        return;
    }

}

//
// Surface-removed scenes: the dropped ball alone, then every earlier launch
// together with it, each run to the end of its orbit. Balls freeze (timer
// and all) when they complete, back at their starting apogee.
//

function makeGhostRunBalls(mode) {

    let list = [];

    if (mode === 'all') {
        for (let s = 0; s < powerLevels.length; s++) {
            let b = makeBall(slingRelease, launchDir.copy().mult(powerLevels[s]), stageColors[s], 255, 'launched');
            b.stage = s;
            list.push(b);
        }
    }

    list.push(makeBall(dropArmEnd, createVector(0, 0), dropColorSling, 255, 'drop'));

    for (let b of list) {
        b.swept = 0;
        b.prevHeading = b.pos.heading();
        b.apogees = 1; // the drop ball starts at its first apogee
        b.prevR = b.pos.mag();
        b.prevPrevR = null;
    }

    return list;

}

// advance every unfinished ball one step; true once all have completed
function stepGhostBalls(list) {

    let allDone = true;

    for (let ball of list) {

        if (ball.landed) continue;

        stepBall(ball);

        let r = ball.pos.mag();

        if (ball.kind === 'drop') {
            // a radial orbit has no sweep: complete on returning to the
            // starting apogee, the third apogee including that start
            if (ball.prevPrevR !== null && ball.prevR > ball.prevPrevR && ball.prevR > r) {
                ball.apogees++;
            }
            ball.prevPrevR = ball.prevR;
            ball.prevR = r;
            if (ball.apogees >= 3) ball.landed = true;
        } else {
            let a = ball.pos.heading();
            let d = a - ball.prevHeading;
            if (d > PI) d -= TAU;
            if (d < -PI) d += TAU;
            ball.swept += d;
            ball.prevHeading = a;
            if (abs(ball.swept) >= TAU) ball.landed = true;
        }

        if (ball.landed) {
            ball.trail.push(ball.pos.copy());
        } else {
            allDone = false;
        }
    }

    return allDone;

}

function startGhostRun(mode) {

    ghostMode = true;
    ghostRunMode = mode;
    shotBounds = null;

    // the finished scene is simulated ahead so the camera can glide out
    // towards a view that holds every complete orbit and the slingshot
    let ahead = makeGhostRunBalls(mode);
    let fit = null;
    let guard = 0;
    do {
        for (let b of ahead) {
            if (b.landed) continue;
            fit = fit || { minX: b.pos.x, maxX: b.pos.x, minY: b.pos.y, maxY: b.pos.y };
            fit.minX = min(fit.minX, b.pos.x); fit.maxX = max(fit.maxX, b.pos.x);
            fit.minY = min(fit.minY, b.pos.y); fit.maxY = max(fit.maxY, b.pos.y);
        }
    } while (!stepGhostBalls(ahead) && guard++ < maxFlightFrames);
    ghostFit = fit;

    balls = makeGhostRunBalls(mode);
    shotState = 'ghostrun';
    flightFrames = 0;
    donePhase = null;

}

// one frame of the scene; true once every orbit has completed
function stepGhostRunOnce() {

    let done = stepGhostBalls(balls);
    flightFrames++;

    for (let ball of balls) {
        expandShotBounds(ball.pos);
        if (flightFrames % 3 == 0 && !ball.landed) {
            ball.trail.push(ball.pos.copy());
        }
    }

    return done || flightFrames > maxFlightFrames;

}

function updateGhostRun() {

    for (let s = 0; s < stepsPerFrame(); s++) {

        if (!stepGhostRunOnce()) continue;

        let dropOnly = ghostRunMode === 'drop';
        simState = dropOnly ? 'ghost-dropped' : 'ghost-failed-done';
        markCompletedOrbits();

        window.parent.postMessage({ type: dropOnly ? 'slingGhost' : 'slingGhostAll' }, "*");

        shotState = 'done';
        donePhase = 'zoomout';
        doneTimer = 0;
        return;
    }

}

function startGhostRunFromButton() {

    if (shotState !== 'ready' || !ghostMode) return;

    let phase = GHOST_PHASES[simState];
    if (phase === 1) startGhostRun('drop');
    if (phase === 3) startGhostRun('all');

}

//
// Apogee and perigee markers for completed orbits (from the point those
// terms are introduced on)
//

// turning points of r along a trail, with hysteresis against noise;
// launches are tangential, so the start is itself an extreme if r moves off it
function orbitExtremes(trail) {

    const eps = 6;
    let apo = [], peri = [];
    let dir = 0;
    let candR = trail[0].mag();
    let candP = trail[0];
    let startP = trail[0];

    for (let p of trail) {

        let r = p.mag();

        if (dir === 0) {
            if (r > candR + eps) {
                peri.push(startP);
                dir = 1;
                candR = r; candP = p;
            } else if (r < candR - eps) {
                apo.push(startP);
                dir = -1;
                candR = r; candP = p;
            }
        } else if (dir === 1) {
            if (r > candR) {
                candR = r; candP = p;
            } else if (r < candR - eps) {
                apo.push(candP);
                dir = -1;
                candR = r; candP = p;
            }
        } else {
            if (r < candR) {
                candR = r; candP = p;
            } else if (r > candR + eps) {
                peri.push(candP);
                dir = 1;
                candR = r; candP = p;
            }
        }
    }

    if (dir === 1) apo.push(candP);
    if (dir === -1) peri.push(candP);

    const dedupe = (list) => {
        let out = [];
        for (let p of list) {
            if (!out.some(q => p5.Vector.dist(p, q) < 60)) out.push(p);
        }
        return out;
    };

    return { apo: dedupe(apo), peri: dedupe(peri) };

}

function markCompletedOrbits() {

    orbitMarks = [];

    let list;
    if (ghostMode && ghostRunMode) {
        list = balls;
    } else if (launchStage >= 6) {
        list = balls.filter(b => b.kind === 'primary');
    } else {
        return;
    }

    // one set of labels is enough: the most eccentric orbit on screen
    let labelled = list[list.length - 1];
    let launched = list.filter(b => b.kind === 'launched');
    if (launched.length > 0) labelled = launched[launched.length - 1];

    for (let b of list) {
        let ex = orbitExtremes(b.trail);
        orbitMarks.push({ apo: ex.apo, peri: ex.peri, col: b.col, label: b === labelled });
    }

}

//
// Camera. During a flight it chases the active ball, rotating so the ball's
// local 'down' stays screen-down and zooming just enough to keep the ball and
// the surface beneath it in frame. After landing it zooms out (unrotated) to
// show the whole trajectory, and when the next shot is prepared it swings
// back in on the slingshot. Ghost (surface-removed) runs use the wide view
// throughout.
//

function updateCamera() {

    let cx, cy, targetScale, targetRot = 0;
    // the closeup's zoom (tower at two thirds of the screen height) is the
    // most any view zooms in, so the flight and trajectory views open at the
    // same scale the stretch-back ends on
    let closeupScale = height * 2 / 3 / towerH;
    let maxScale = closeupScale;
    let posLerp = 0.08, scaleLerp = 0.08, rotLerp = 0.08;

    const fitBox = (minX, maxX, minY, maxY) => {
        cx = (minX + maxX) / 2;
        cy = (minY + maxY) / 2;
        let margin = height / 10; // the same inset on every side
        let spreadX = max(maxX - minX, towerH * 1.5);
        let spreadY = max(maxY - minY, towerH * 1.5);
        targetScale = min((width - 2 * margin) / spreadX, (height - 2 * margin) / spreadY);
    };

    // the surface-removed scene: the slingshot plus everything the balls have
    // covered so far, with the extent of every complete orbit blended in
    // over time, so the view opens out gradually to hold all of it
    const fitGhostScene = () => {
        let base = {
            minX: min(towerTop.x, towerBase.x, dropArmEnd.x),
            maxX: max(towerTop.x, towerBase.x, dropArmEnd.x),
            minY: min(towerTop.y, towerBase.y, dropArmEnd.y),
            maxY: max(towerTop.y, towerBase.y, dropArmEnd.y)
        };
        let box = { ...base };
        const include = (b) => {
            box.minX = min(box.minX, b.minX); box.maxX = max(box.maxX, b.maxX);
            box.minY = min(box.minY, b.minY); box.maxY = max(box.maxY, b.maxY);
        };
        if (shotBounds) include(shotBounds);
        if (ghostFit) {
            let e = constrain(flightFrames / 1500, 0, 1);
            e = e * e * (3 - 2 * e);
            include({
                minX: lerp(base.minX, min(base.minX, ghostFit.minX), e),
                maxX: lerp(base.maxX, max(base.maxX, ghostFit.maxX), e),
                minY: lerp(base.minY, min(base.minY, ghostFit.minY), e),
                maxY: lerp(base.maxY, max(base.maxY, ghostFit.maxY), e)
            });
        }
        fitBox(box.minX, box.maxX, box.minY, box.maxY);
    };

    // just the flown trajectory (plus the tower), not the whole planet
    const fitTrajectory = () => {
        let minX = towerTop.x, maxX = towerTop.x, minY = towerTop.y, maxY = towerTop.y;
        minX = min(minX, towerBase.x); maxX = max(maxX, towerBase.x);
        minY = min(minY, towerBase.y); maxY = max(maxY, towerBase.y);
        let b = shotBounds || lastShotBounds;
        if (b) {
            minX = min(minX, b.minX); maxX = max(maxX, b.maxX);
            minY = min(minY, b.minY); maxY = max(maxY, b.maxY);
        }
        fitBox(minX, maxX, minY, maxY);
    };

    // the tower fills two thirds of the screen height; the view only backs
    // off if the pulled-back sling would leave the screen sideways
    const fitCloseup = () => {
        let minX = Infinity, maxX = -Infinity;
        for (let p of [slingBallPos, slingRelease, dropArmEnd]) {
            minX = min(minX, p.x); maxX = max(maxX, p.x);
        }
        cx = (minX + maxX) / 2;
        cy = (towerBase.y + towerTop.y) / 2;
        let margin = height / 10;
        targetScale = min(height * 2 / 3 / towerH, (width - 2 * margin) / max(maxX - minX, 1));
        maxScale = 20;
    };

    let inFlight = (shotState === 'flying' || shotState === 'done');
    let ghostScene = shotState === 'ghostrun' || (shotState === 'done' && ghostRunMode);
    let chase = inFlight && !ghostScene &&
        (shotState === 'flying' || donePhase === 'linger');

    if (ghostScene) {

        // start on the slingshot and drift out, very slowly at first, to a
        // view holding the whole of every orbit alongside the slingshot
        fitGhostScene();
        posLerp = scaleLerp = 0.05;
        rotLerp = 0.03;

    } else if (chase) {

        // chase cam: the ball's 'down' stays screen-down; keep the ball and
        // the ground beneath it in view, with the ball locked to centre
        let primary = primaryBall();
        let pos = primary.pos;
        let r = pos.mag();
        let alt = max(0, r - earthR);
        let radial = pos.copy().div(max(r, 1));

        targetRot = -HALF_PI - pos.heading();

        let mid = p5.Vector.mult(radial, earthR + alt / 2);
        cx = mid.x;
        cy = mid.y;
        // at tower height this is exactly the closeup's zoom, easing out as
        // the ball climbs so ball and ground stay in frame
        targetScale = min(closeupScale, height * 0.7 / max(alt, towerH));

        // fast-forward covers ground quickly: lock the camera to the ball
        posLerp = fastForward ? 1 : 0.3;

    } else if (inFlight) {

        // landed shots relax out to just the flown trajectory
        fitTrajectory();
        posLerp = scaleLerp = rotLerp = 0.02;

    } else if (wideReady) {

        // re-armed after a shot: hold the post-shot view until the next upgrade
        fitTrajectory();

    } else {

        // close in on the slingshot for the next launch
        fitCloseup();
    }

    targetScale = constrain(targetScale, 0.02, maxScale);

    // Travel around the planet rather than straight through it: when both
    // the current and target view centres are out near the surface, blend
    // towards interpolating by angle and radius about the Earth's centre
    // (a straight line from one side of the Earth to the other would sweep
    // the view across the planet's interior).
    let rCur = Math.hypot(cam.x, cam.y);
    let rTar = Math.hypot(cx, cy);
    let outer = constrain((Math.min(rCur, rTar) - 400) / 800, 0, 1);

    let nx = lerp(cam.x, cx, posLerp);
    let ny = lerp(cam.y, cy, posLerp);
    let dAng = 0;

    if (outer > 0) {
        let aCur = Math.atan2(cam.y, cam.x);
        dAng = Math.atan2(cy, cx) - aCur;
        while (dAng > PI) dAng -= TAU;
        while (dAng < -PI) dAng += TAU;
        let aNew = aCur + dAng * posLerp;
        let rNew = lerp(rCur, rTar, posLerp);
        nx = lerp(nx, rNew * Math.cos(aNew), outer);
        ny = lerp(ny, rNew * Math.sin(aNew), outer);
    }

    cam.x = nx;
    cam.y = ny;

    // zoom evenly in log space
    cam.scale = Math.exp(lerp(Math.log(cam.scale), Math.log(targetScale), scaleLerp));

    // shortest-path rotation (turning with the direction of travel when the
    // two ways round are equally short)
    let d = targetRot - cam.rot;
    while (d > PI) d -= TAU;
    while (d < -PI) d += TAU;
    if (outer > 0.5 && Math.abs(Math.abs(d) - PI) < 0.5 && dAng !== 0) {
        d = -Math.sign(dAng) * Math.abs(d);
    }
    cam.rot += d * rotLerp;

    // however relaxed the glide, no ball (nor the slingshot) may leave the screen;
    // after a landing the ball that just came down must stay in frame too
    let zoomingOut = inFlight && !chase && !ghostScene;
    if (ghostScene || zoomingOut) {
        let c = Math.cos(cam.rot), sn = Math.sin(cam.rot);
        let m = height * 0.06;
        let needed = Infinity;
        let pts = ghostScene
            ? balls.filter(b => !b.landed).map(b => b.pos).concat([towerTop])
            : balls.filter(b => b.kind === 'primary').map(b => b.pos);
        for (let p of pts) {
            let dx = p.x - cam.x, dy = p.y - cam.y;
            let rx = dx * c - dy * sn;
            let ry = dx * sn + dy * c;
            needed = min(needed,
                (width / 2 - m) / max(abs(rx), 1),
                (height / 2 - m) / max(abs(ry), 1));
        }
        cam.scale = min(cam.scale, needed);
    }

}

function slingWorldToScreen(x, y) {
    let dx = (x - cam.x) * cam.scale;
    let dy = (y - cam.y) * cam.scale;
    let c = Math.cos(cam.rot), s = Math.sin(cam.rot);
    return {
        x: dx * c - dy * s + width / 2,
        y: dx * s + dy * c + height / 2
    };
}

function slingScreenToWorld(x, y) {
    let dx = x - width / 2;
    let dy = y - height / 2;
    let c = Math.cos(-cam.rot), s = Math.sin(-cam.rot);
    let rx = dx * c - dy * s;
    let ry = dx * s + dy * c;
    return createVector(rx / cam.scale + cam.x, ry / cam.scale + cam.y);
}

//
// Rendering
//

function draw() {

    if (fastForward && !mouseIsPressed) {
        fastForward = false;
    }

    if (shotState === 'releasing') {
        releaseProgress += 1 / RELEASE_FRAMES;
        if (releaseProgress >= 1) {
            launchShot(pendingRelease.v);
            pendingRelease = null;
        }
    } else if (shotState === 'flying') {
        updateFlight();
    } else if (shotState === 'ghostrun') {
        updateGhostRun();
    } else if (shotState === 'done') {
        // the finished shot stays on screen until the state changes (the
        // reader scrolls back, or on to the next upgrade); only ghost runs
        // can be re-grabbed for more free play
        if (doneTimer > 0) {
            doneTimer--;
            if (doneTimer <= 0 && donePhase === 'linger') {
                // now glide out, slowly, to the whole trajectory
                donePhase = 'zoomout';
                doneTimer = 260;
            }
        }
    }

    updateCamera();

    background(0);

    push();
    translate(width / 2, height / 2);
    rotate(cam.rot);
    scale(cam.scale);
    translate(-cam.x, -cam.y);

    // stars, batched by size and brightness (in world units, so they scale with
    // the Earth); one canvas path per bucket, skipping those off screen
    let starReach = Math.hypot(width, height) / 2 / cam.scale + 20;
    let ctx = drawingContext;
    noStroke();
    for (let bucket of slingStars) {
        let w = bucket.weight;
        ctx.fillStyle = "rgba(255,255,255," + (bucket.alpha / 255).toFixed(3) + ")";
        ctx.beginPath();
        for (let i = 0; i < bucket.pts.length; i += 2) {
            let sx = bucket.pts[i], sy = bucket.pts[i + 1];
            if (Math.abs(sx - cam.x) > starReach || Math.abs(sy - cam.y) > starReach) continue;
            ctx.rect(sx - w / 2, sy - w / 2, w, w);
        }
        ctx.fill();
    }

    // gravity glow, including the interior of the distributed-mass Earth
    image(gravityImg,
        -GRAV_IMG_WORLD_RADIUS, -GRAV_IMG_WORLD_RADIUS,
        2 * GRAV_IMG_WORLD_RADIUS, 2 * GRAV_IMG_WORLD_RADIUS);

    if (ghostMode) {

        // the surface becomes a dotted line (dashes in fixed world units, so
        // they don't change with zoom), revealing the gravity beneath
        noFill();
        stroke(48, 255, 144);
        strokeWeight(2 / cam.scale);
        drawingContext.setLineDash([60, 80]);
        circle(0, 0, earthR * 2);
        drawingContext.setLineDash([]);

    } else {
        noStroke();
        fill(earthColorSling);
        circle(0, 0, earthR * 2);
    }

    // tower up to ball level, with the drop arm on the far side
    stroke("#b98157");
    strokeWeight(10);
    line(towerBase.x, towerBase.y, towerTop.x, towerTop.y);
    strokeWeight(4);
    line(towerTop.x, towerTop.y, dropArmEnd.x, dropArmEnd.y);

    // ghost trails from previous shots
    noFill();
    strokeWeight(1.5 / cam.scale);
    for (let trail of ghostTrails) {
        stroke(red(trail.col), green(trail.col), blue(trail.col), 50);
        beginShape();
        for (let p of trail.points) {
            vertex(p.x, p.y);
        }
        endShape();
    }

    // active balls and their trails
    for (let ball of balls) {

        noFill();
        strokeWeight(2 / cam.scale);
        stroke(red(ball.col), green(ball.col), blue(ball.col), ball.alpha * 0.7);
        beginShape();
        for (let p of ball.trail) vertex(p.x, p.y);
        endShape();

        // altitude: a dashed white line down to the surface, as in the rocket sim
        if (ball.kind === 'primary' && !ball.landed) {
            let r = max(ball.pos.mag(), 1);
            let surface = p5.Vector.mult(ball.pos, earthR / r);
            drawDashedLine(surface.x, surface.y, ball.pos.x, ball.pos.y, color(255),
                max(PX_PER_UNIT, 4 / cam.scale), 1 / cam.scale);
        }

        drawCat(ball.pos.x, ball.pos.y, ball.col, ball.alpha);

        // labels stay upright regardless of the camera's rotation
        push();
        translate(ball.pos.x, ball.pos.y);
        rotate(-cam.rot);
        textFont(SIM_FONT);
        textSize(12 / cam.scale);
        textAlign(CENTER, BOTTOM);
        if (!ghostRunMode || ball.kind === 'drop') {
            text(secondsText(ball.timer), 0, -(ballRadius + 4));
        }
        if (ball.kind === 'primary') {
            textAlign(CENTER, TOP);
            text("Alt: " + unitsText(max(0, ball.pos.mag() - earthR)), 0, ballRadius + 6);
        }
        pop();
    }

    if (shotState === 'flying' || shotState === 'ghostrun') {
        let labelled = balls.find(b => b.kind === 'primary') ||
            balls.filter(b => b.kind === 'launched').pop() || dropBallOf();
        for (let ball of balls) {
            if (!ball.landed) drawBallArrows(ball, ball === labelled);
        }
    }

    drawOrbitMarks();

    // slingshot fork (rotated 90°, attached to the tower)
    stroke("#b98157");
    strokeWeight(4);
    line(towerTop.x, towerTop.y, prongBase.x, prongBase.y);
    line(prongBase.x, prongBase.y, prongUp.x, prongUp.y);
    line(prongBase.x, prongBase.y, prongDn.x, prongDn.y);

    if (shotState === 'ready' || shotState === 'releasing') {

        let ballPos = slingBallPos;
        if (shotState === 'releasing') {
            // a few frames of the sling snapping back before the launch
            let eased = releaseProgress * releaseProgress;
            ballPos = p5.Vector.lerp(pendingRelease.pulledPos, slingRelease, eased);
        }

        stroke("#ffffff");
        strokeWeight(2);
        line(prongUp.x, prongUp.y, ballPos.x, ballPos.y);
        line(prongDn.x, prongDn.y, ballPos.x, ballPos.y);

        drawCat(ballPos.x, ballPos.y, stageColors[stage], 255);
        drawCat(dropArmEnd.x, dropArmEnd.y, dropColorSling, 255);

    }

    pop();

    drawHud();

    if (!ghostMode) {
        drawSlingBar();
    }

    drawFpsIndicator();

}

const ARROW_GRAV_PX = 70; // screen length of a surface-gravity arrow
const ARROW_VEL_PX = 90; // screen length of a circular-orbit-speed arrow

// gravity, velocity and the net force (here, just gravity) for a flying ball,
// in the rocket sketch's tip-to-tip style; lengths are in screen pixels, in
// proportion to the real quantities, so they stay readable at any zoom
function drawBallArrows(ball, labelled) {

    let k = 1 / cam.scale;
    let fade = ball.alpha / 255;
    let pos = ball.pos;
    let r = max(pos.mag(), 1);

    let g = r >= earthR ? mu / (r * r) : mu * r / (earthR * earthR * earthR);
    let gravity = pos.copy().mult(-1 / r).mult(g / surfaceG * ARROW_GRAV_PX * k);

    let h = 0.05;
    let vel = p5.Vector.sub(segmentPositionAt(ball.seg, ball.t + h), segmentPositionAt(ball.seg, ball.t)).div(h);
    vel.mult(ARROW_VEL_PX / vCircular * k);

    let gravCol = color(163, 255, 255, 255 * fade);
    let velCol = color(255, 51, 171, 255 * fade);
    let netCol = color(255, 255, 255, 255 * fade);

    let gravTip = p5.Vector.add(pos, gravity);
    let velTip = p5.Vector.add(pos, vel);
    let netTip = p5.Vector.add(velTip, gravity);

    drawFatArrow(pos, gravTip, gravCol, 2 * k, 9 * k, 9 * k);
    drawFatArrow(pos, velTip, velCol, 2 * k, 9 * k, 9 * k);
    drawFatArrow(velTip, netTip, netCol, 3 * k, 11 * k, 11 * k);

    drawingContext.setLineDash([3 * k, 8 * k]);
    stroke(255, 120 * fade);
    strokeWeight(2 * k);
    line(gravTip.x, gravTip.y, netTip.x, netTip.y);
    drawingContext.setLineDash([]);

    if (labelled) {
        let labels = [["gravity", gravTip, gravCol], ["velocity", velTip, velCol], ["net force", netTip, netCol]];
        textFont(SIM_FONT);
        textSize(12 * k);
        textAlign(LEFT, CENTER);
        noStroke();
        for (let [label, tip, col] of labels) {
            push();
            translate(tip.x, tip.y);
            rotate(-cam.rot);
            fill(col);
            text(label, 10 * k, 0);
            pop();
        }
    }

}

function drawOrbitMarks() {

    let k = 1 / cam.scale;

    // as in the rocket sim: a dashed line from the surface out to the point,
    // labelled with its altitude (one label set, on the most eccentric orbit)
    for (let m of orbitMarks) {

        let kinds = [["Apogee", m.apo], ["Perigee", m.peri]];

        for (let [label, points] of kinds) {
            for (let p of points) {

                let lineCol = color(red(m.col), green(m.col), blue(m.col));
                let surface = p5.Vector.mult(p, earthR / max(p.mag(), 1));
                drawDashedLine(surface.x, surface.y, p.x, p.y, lineCol,
                    max(PX_PER_UNIT, 4 * k), 1.5 * k);

                if (m.label) {
                    push();
                    translate(p.x, p.y);
                    rotate(-cam.rot);
                    noStroke();
                    fill(lineCol);
                    textFont(SIM_FONT);
                    textSize(12 * k);
                    textAlign(LEFT, CENTER);
                    text(label + ": " + unitsText(p.mag() - earthR), 12 * k, 0);
                    if (label === "Apogee" && p === points[0] && m.peri.length) {
                        let e = eccentricityFromRadii(m.peri[0].mag(), p.mag());
                        text("Eccentricity: " + eccentricityText(e), 12 * k, 16 * k);
                    }
                    pop();
                }
            }
        }
    }

}

// the slingshot bar takes the place of the control circle: a horizontal track
// the width of the circle, with the handle at its right end until it is pulled
// left. The track is as long as the final stage's draw-back.
function getSlingBar() {
    let j = getJoystickGeometry();
    return { left: j.x - j.r, right: j.x + j.r, y: j.y, len: j.r * 2 };
}

function slingBarMaxPull() {
    return 55 + (powerLevels.length - 1) * 12;
}

function pointerOnSlingBar() {
    let b = getSlingBar();
    return mouseX >= b.left - 24 && mouseX <= b.right + 24 &&
        abs(mouseY - b.y) <= 36;
}

function dragSlingBarTo(x) {
    let b = getSlingBar();
    let wanted = (b.right - x) / b.len * slingBarMaxPull();

    // clamp: the sling only pulls back, up to this stage's draw-back
    pullDist = constrain(wanted, 0, currentMaxPull());
    slingBallPos = p5.Vector.sub(slingRelease, rightDir.copy().mult(pullDist));
}

function drawSlingBar() {

    let b = getSlingBar();
    let shownPull = shotState === 'releasing' ? pullDist * (1 - releaseProgress) : pullDist;
    let usable = currentMaxPull() / slingBarMaxPull() * b.len;
    let handleX = b.right - shownPull / slingBarMaxPull() * b.len;

    push();
    strokeCap(ROUND);
    noFill();

    // the part of the track this slingshot can reach, then the part that
    // later upgrades will open up
    stroke(255, 50);
    strokeWeight(6);
    line(b.left, b.y, b.right, b.y);
    stroke(255, 130);
    line(b.right - usable, b.y, b.right, b.y);

    let c = stageColors[stage];
    noStroke();
    fill(red(c), green(c), blue(c), draggingSling ? 255 : 210);
    circle(handleX, b.y, draggingSling ? 40 : 34);

    pop();

}

function getFFButton() {
    let w = 96;
    let h = 64;
    return { x: width - w - 14, y: height - h - 14, w: w, h: h };
}

// the play button for the surface-removed scenes: bottom centre, only
// while a scene is waiting to be played
function playButtonLabel() {
    if (shotState !== 'ready' || !ghostMode) return null;
    let phase = GHOST_PHASES[simState];
    if (phase === 1) return "Follow the dropped ball";
    if (phase === 3) return "Follow every launch";
    return null;
}

function getPlayButton() {
    let r = 34;
    return { x: width / 2, y: height - r - 22, r: r };
}

function drawHud() {

    fill(255);
    noStroke();
    textFont(SIM_FONT);
    textAlign(LEFT, TOP);
    textSize(14);

    let power = "Slingshot power: " +
        (stage + 1) + "/" + powerLevels.length +
        " (v = " + nf(currentMaxSpeed(), 1, 2) + ")";
    if (ghostMode) {
        power += "  —  ghost balls";
    }

    text(power + "\nShots fired: " + shotCount, 14, 14);

    textAlign(CENTER, TOP);
    if (shotState === 'ready' && pullDist < 4) {
        fill(255, 200);
        let hint;
        if (ghostMode) {
            hint = null;
        } else if (wideReady) {
            hint = "Drag the slingshot bar left and release.\nKeep reading to upgrade the slingshot.";
        } else {
            hint = "Drag the slingshot bar left and release.";
        }
        if (hint) text(hint, width / 2, 14);
    }

    if (upgradeMessageTimer > 0) {
        upgradeMessageTimer--;
        fill(255, 159, 28, min(255, upgradeMessageTimer * 4));
        textSize(18);
        text(upgradeMessage, width / 2, 44);
    }

    // fast-forward: a double triangle, held down
    let b = getFFButton();
    stroke(255, fastForward ? 220 : 90);
    strokeWeight(2);
    fill(255, fastForward ? 60 : 15);
    rect(b.x, b.y, b.w, b.h, 12);

    noStroke();
    fill(255, fastForward ? 255 : 190);
    let cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    let th = 26, tw = 22;
    triangle(cx - tw, cy - th / 2, cx - tw, cy + th / 2, cx, cy);
    triangle(cx, cy - th / 2, cx, cy + th / 2, cx + tw, cy);

    let playLabel = playButtonLabel();
    if (playLabel) {
        let pb = getPlayButton();
        stroke(255, 200);
        strokeWeight(2);
        fill(255, 40);
        circle(pb.x, pb.y, pb.r * 2);
        noStroke();
        fill(255);
        triangle(pb.x - pb.r * 0.28, pb.y - pb.r * 0.42,
            pb.x - pb.r * 0.28, pb.y + pb.r * 0.42,
            pb.x + pb.r * 0.5, pb.y);
        textAlign(CENTER, BOTTOM);
        textSize(13);
        text(playLabel, pb.x, pb.y - pb.r - 8);
    }

}

//
// Input: override the rocket-oriented handlers from shared.js
//

function pointerWorld() {
    return slingScreenToWorld(mouseX, mouseY);
}

function pointerOnFFButton() {
    let b = getFFButton();
    return mouseX >= b.x && mouseX <= b.x + b.w &&
        mouseY >= b.y && mouseY <= b.y + b.h;
}

function pointerOnPlayButton() {
    if (!playButtonLabel()) return false;
    let pb = getPlayButton();
    return dist(mouseX, mouseY, pb.x, pb.y) <= pb.r + 6;
}

function mousePressed() {

    unlockSoundtrack();

    if (pointerOnFFButton()) {
        fastForward = true;
        return false;
    }

    if (pointerOnPlayButton()) {
        startGhostRunFromButton();
        return false;
    }

    // surface-removed scenes are played, not launched
    if (ghostMode) return false;

    if (shotState !== 'ready') return false;

    if (pointerOnSlingBar()) {
        draggingSling = true;
        dragSlingBarTo(mouseX);
    }

    return false;
}

function mouseDragged() {

    if (fastForward) return false;

    if (!draggingSling) return false;

    dragSlingBarTo(mouseX);

    return false;
}

function mouseReleased() {

    fastForward = false;

    if (!draggingSling) return false;
    draggingSling = false;

    if (pullDist > 8) {
        // the sling snaps the ball back to the release point over a few
        // frames, then lets go due right; past balls and the dropped ball go
        // at the same moment
        pendingRelease = { pulledPos: slingBallPos.copy(), v: releaseSpeed() };
        releaseProgress = 0;
        shotState = 'releasing';
    } else {
        slingBallPos = slingRelease.copy();
        pullDist = 0;
    }

    return false;
}

function mouseWheel() {
    return false;
}

function keyPressed() {
    // no rocket controls here
}
