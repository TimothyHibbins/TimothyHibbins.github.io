// Earth-only rocket simulation, in two flavours:
//
//   ?mode=free   just the rocket, the Earth and gravity light (no moon), with
//                none of the essay machinery below
//   (default)    the 'reaching orbit' section
//
// The moon exists as a massless, invisible body so the shared code paths keep
// working, but it exerts no gravity and is never drawn. The gravity-light
// image is generated at setup for the earth-only field (it's radially
// symmetric, so it's built from a 1D profile).
//
// In the 'reaching orbit' section each essay unit is tied to a sim state, and
// the sim shows what that state calls for (the target altitude, the trajectory
// projection, a target orbit band). The states run in reading order:
//
//   start       the target altitude to climb to before burning prograde
//   climbed     reached that altitude (projection switches on)
//   orbit       the projected trajectory is a full orbit
//   impulse     Impulse Mode is available, with a fixed burn duration
//   firedUp     burned radially outward after orbiting (before prograde)
//   apoRaised   a prograde burn raised the apoapsis
//   circHigher  circularised at a higher altitude
//   lowered     a retrograde burn lowered the periapsis
//   uncapped    the whole orbit is lowered; burn duration is now free, and
//               target band 1 appears
//   band1done   held band 1
//   band2       target band 2 appears
//   band2done   held band 2
//   band3       target band 3 appears
//   done        held band 3
//
// Scrolling to a unit puts the sim in its state, in either direction. Flying
// can advance the state: each transition is armed only from the state(s)
// before it and fires on the rising edge of its condition (so a condition
// that is already true when a state is entered doesn't fire at once), and
// posts the matching event so the essay moves to that unit.

const FREE_MODE = new URLSearchParams(window.location.search).get('mode') === 'free';

const ALTITUDE_MILESTONE = 90;

// target orbit bands: [periapsis floor, apoapsis ceiling] altitudes
const ORBIT_BANDS = [
    [200, 290],
    [400, 510],
    [115, 180]
];
const BAND_HOLD_REQUIRED = 90;
let bandHoldFrames = 0;

const STATE_ORDER = ['start', 'climbed', 'orbit', 'impulse', 'firedUp', 'apoRaised',
    'circHigher', 'lowered', 'uncapped', 'band1done', 'band2', 'band2done',
    'band3', 'done'];

// the burn length (in simulation frames) of an Impulse Mode burn while the
// reader only controls its direction
const FIXED_BURN_FRAMES = 15;

// orbit snapshots the conditions are measured against
let refApo = 0;
let refPeri = 0;
let refApoCirc = 0;
let refPeriCirc = 0;

let essayState = null;
let pendingEssayState = null;
let slide3Ready = false;
let prevConds = {};

function finiteOr0(x) {
    return Number.isFinite(x) ? x : 0;
}

function postEssayEvent(type) {
    window.parent.postMessage({ type: type }, "*");
}

function stateIndex() {
    return STATE_ORDER.indexOf(essayState);
}

// which target band (1-3) the current state displays, 0 for none. A band
// stays up through the unit that congratulates it, until the next appears.
function activeBand() {
    switch (essayState) {
        case 'uncapped':
        case 'band1done': return 1;
        case 'band2':
        case 'band2done': return 2;
        case 'band3':
        case 'done': return 3;
    }
    return 0;
}

// states in which the band is the live target (being held), mapped to what
// holding it leads to
const BAND_TARGETS = {
    uncapped: { to: 'band1done', event: 'targetBand1' },
    band2: { to: 'band2done', event: 'targetBand2' },
    band3: { to: 'done', event: 'targetBand3' }
};

const TRANSITIONS = {
    start: [{ to: 'climbed', event: 'altitudeReached', cond: condAltitude }],
    climbed: [{ to: 'orbit', event: 'orbitAchieved', cond: condOrbit }],
    impulse: [
        { to: 'firedUp', event: 'firedUp', cond: condFiredUp },
        { to: 'apoRaised', event: 'apoapsisRaised', cond: condApoRaised }
    ],
    firedUp: [{ to: 'apoRaised', event: 'apoapsisRaised', cond: condApoRaised }],
    apoRaised: [{ to: 'circHigher', event: 'circularisedHigher', cond: condCircularised }],
    circHigher: [{ to: 'lowered', event: 'orbitLowered', cond: condLowered }],
    lowered: [{ to: 'uncapped', event: 'apoapsisLowered', cond: condApoLowered }]
};

function shipAltitude() {
    return p5.Vector.dist(ship.posHistory[T], bodies[0].pos) - bodies[0].radius;
}

function condAltitude() {
    return shipAltitude() > ALTITUDE_MILESTONE;
}

function condOrbit() {
    return ship.trajectoryType == 'Orbit' && ship.periapsisAlt > 15;
}

function burnAngles() {
    let orientation = ship.orientationHistory[T];
    let radialOut = ship.posHistory[T].copy().sub(bodies[0].pos);
    let vel = ship.velHistory[T];
    return {
        up: abs(p5.Vector.angleBetween(orientation, radialOut)),
        prograde: abs(p5.Vector.angleBetween(orientation, vel))
    };
}

// tried firing 'up' before firing prograde
function condFiredUp() {
    return ship.boostingHistory[T] && burnAngles().up < TAU / 12;
}

// prograde burn that raised the apoapsis
function condApoRaised() {
    return ship.boostingHistory[T] && burnAngles().prograde < TAU / 10 &&
        ship.apoapsisAlt > refApo + 40;
}

// circular-ish orbit, meaningfully higher than the first one
function condCircularised() {

    if (ship.trajectoryType != 'Orbit') return false;

    let rPeri = ship.periapsisAlt + bodies[0].radius;
    let rApo = ship.apoapsisAlt + bodies[0].radius;
    let ecc = (rApo - rPeri) / (rApo + rPeri);

    return ecc < 0.08 && ship.periapsisAlt > refPeri + 40;
}

// only burns change the orbit, so a clearly lower periapsis means a
// retrograde burn brought the orbit down
function condLowered() {
    return ship.trajectoryType == 'Orbit' && ship.periapsisAlt < refPeriCirc - 40;
}

// ...and once the apoapsis has followed, the whole orbit is lower
function condApoLowered() {
    return condLowered() && ship.apoapsisAlt < refApoCirc - 40;
}

function inActiveBand() {

    let n = activeBand();
    if (n === 0) return false;

    let band = ORBIT_BANDS[n - 1];
    return ship.trajectoryType == 'Orbit' &&
        ship.periapsisAlt >= band[0] && ship.apoapsisAlt <= band[1];

}

function evaluateConds(state) {
    let result = {};
    for (let t of TRANSITIONS[state] || []) {
        result[t.event] = !!t.cond();
    }
    return result;
}

// the orbit snapshots that later conditions are measured against. Reaching
// a state by flying only refreshes the snapshot that state introduces;
// scrolling to a state takes them all from the orbit as it is now.
function snapshotRefs(name, viaEvent) {

    if (!ship) return;

    if (!viaEvent || name === 'orbit') {
        refApo = finiteOr0(ship.apoapsisAlt);
        refPeri = finiteOr0(ship.periapsisAlt);
    }
    if (!viaEvent || name === 'circHigher') {
        refApoCirc = finiteOr0(ship.apoapsisAlt);
        refPeriCirc = finiteOr0(ship.periapsisAlt);
    }

}

// viaEvent: reached by flying rather than by scrolling
function enterState(name, viaEvent) {

    // scrolling away from an impulse that's being aimed abandons it
    if (!viaEvent) {
        cancelImpulse();
    }

    essayState = name;
    bandHoldFrames = 0;

    let index = stateIndex();
    showTrajectory = index >= STATE_ORDER.indexOf('climbed');

    impulse.available = index >= STATE_ORDER.indexOf('impulse');
    impulse.fixedFrames = index >= STATE_ORDER.indexOf('uncapped') ? null : FIXED_BURN_FRAMES;

    snapshotRefs(name, viaEvent);
    snapshotRefsOnBurnEnd = viaEvent && impulse.phase === 'burning';

    // reaching a state by scrolling mustn't fire what's already true; reaching
    // one by flying lets an already-true condition follow on straight away
    prevConds = (ship && launched && !viaEvent) ? evaluateConds(name) : {};

}

// a state reached mid-burn measures its snapshots from the finished burn
let snapshotRefsOnBurnEnd = false;

window.onImpulseBurnEnd = function () {
    if (snapshotRefsOnBurnEnd) {
        snapshotRefs(essayState, true);
        snapshotRefsOnBurnEnd = false;
    }
};

window.onImpulseBurnFrame = function () {
    updateMilestones();
};

window.onEssayLineActive = function (data) {

    if (FREE_MODE || !data || !data.state) return;
    if (STATE_ORDER.indexOf(data.state) < 0) return;

    if (!slide3Ready) {
        pendingEssayState = data.state;
        return;
    }

    if (data.state !== essayState) {
        enterState(data.state, false);
    }

};

function setup() {

    pixelDensity(1);
    createCanvas(windowWidth, windowHeight);
    disableMobileGestureConflicts();

    gravLights = true;
    showTrajectory = false; // switched on by the essay state
    showTrajectoryDescription = true;

    moonEnabled = false;

    // without the moon there's no chaos: afford a long projection window so
    // high orbits (the outer target band) can complete and be recognised
    maxProjectionFrames = 14000;

    rocketColor = color("#ff00b3ff");
    earthColor = color("#00ffffff");
    moonColor = color("#ffff00ff");

    bodies.push(new Body(createVector(0, 0), 100, 1, color("#a3ffffff"))); // Earth
    bodies.push(new Body(createVector(0, -25 * 17), 0.0001, 0, color("#ffff9000"))); // massless, invisible stand-in moon

    let l = 30;
    ship = new Ship(createVector(bodies[0].pos.x, bodies[0].pos.y - bodies[0].radius - l / 2), l);

    camera = new Camera();

    generateMoonOrbit();

    rollingFrameRateAverage = frameRate();

    // // hypot
    gridSize = round(Math.sqrt(width * width + height * height));

    moonHillSphereRadius = 0;

    gravFieldImg = generateEarthOnlyGravityField();
    polarImg = generateEarthOnlyPolarImage();

    for (let i = 0; i < 3000; i++) {

        stars.push(
            new Star(
                createVector(
                    random(-gridSize / 2, gridSize / 2), random(-gridSize / 2, gridSize / 2)
                ),
                random(100, 255),
                random(0.3, 3.5)
            )
        );

    }

    for (let i = 0; i < 100; i++) {
        exhaustPlumeLengthRandomCycle.push(random(0.9, 1.1));
    }

    lastFrameTime = millis();
    dt = 0;

    slide3Ready = true;
    impulse.exclusive = !FREE_MODE;
    if (!FREE_MODE) {
        enterState(pendingEssayState || 'start', false);
    }

}

// the earth-only field is radially symmetric: build the alpha profile once
// per integer radius and paint it over the buffer
function generateEarthOnlyGravityField() {

    let buffer = createGraphics(gridSize, gridSize);
    buffer.pixelDensity(1);
    buffer.loadPixels();

    let gMax = 0.007;
    let gMin = 0.00005;
    let logMin = Math.log10(gMin);
    let logRange = Math.log10(gMax) - logMin;

    let er = red(earthColor), eg = green(earthColor), eb = blue(earthColor);

    let maxR = Math.ceil(gridSize * 0.7072) + 2;
    let alphaByR = new Array(maxR);
    for (let r = 0; r < maxR; r++) {
        let g = G * bodies[0].mass / Math.max(r, 1) ** 2;
        let normalized = (Math.log10(g + gMin) - logMin) / logRange;
        alphaByR[r] = constrain(normalized, 0, 1) * 255;
    }

    let half = gridSize / 2;
    for (let y = 0; y < gridSize; y++) {
        let dy = y - half;
        for (let x = 0; x < gridSize; x++) {
            let dx = x - half;
            let r = Math.round(Math.sqrt(dx * dx + dy * dy));
            let idx = 4 * (x + y * gridSize);
            buffer.pixels[idx] = er;
            buffer.pixels[idx + 1] = eg;
            buffer.pixels[idx + 2] = eb;
            buffer.pixels[idx + 3] = alphaByR[Math.min(r, maxR - 1)];
        }
    }

    buffer.updatePixels();
    return buffer;
}

// earth-only version of the timeline's polar image: without the moon the
// field is independent of the angle, so every column shares one profile
function generateEarthOnlyPolarImage() {

    let buffer = createGraphics(180, gridSize);
    buffer.pixelDensity(1);
    buffer.loadPixels();

    let gMax = 0.007;
    let gMin = 0.00005;
    let logMin = Math.log10(gMin);
    let logRange = Math.log10(gMax) - logMin;

    let er = red(earthColor), eg = green(earthColor), eb = blue(earthColor);

    for (let alt = 0; alt < gridSize; alt++) {
        let g = G * bodies[0].mass / Math.max(alt, 1) ** 2;
        let normalized = constrain((Math.log10(g + gMin) - logMin) / logRange, 0, 1);
        let a = normalized * 255;
        for (let theta = 0; theta < 180; theta++) {
            let idx = 4 * (theta + alt * 180);
            buffer.pixels[idx] = er;
            buffer.pixels[idx + 1] = eg;
            buffer.pixels[idx + 2] = eb;
            buffer.pixels[idx + 3] = a;
        }
    }

    buffer.updatePixels();
    return buffer;
}

//
// State transitions, driven by flying
//

function updateMilestones() {

    if (FREE_MODE || !launched || crashedOut) return;

    for (let t of TRANSITIONS[essayState] || []) {

        let now = !!t.cond();
        let rising = now && !prevConds[t.event];
        prevConds[t.event] = now;

        if (rising) {
            enterState(t.to, true);
            postEssayEvent(t.event);
            return;
        }
    }

    let target = BAND_TARGETS[essayState];
    if (target) {

        if (inActiveBand()) {
            bandHoldFrames++;
            if (bandHoldFrames >= BAND_HOLD_REQUIRED) {
                enterState(target.to, true);
                postEssayEvent(target.event);
            }
        } else {
            bandHoldFrames = 0;
        }
    }

}

// drawn by shared drawFrame inside the camera transform
function drawWorldOverlay() {

    if (FREE_MODE) return;

    // the altitude to climb to before firing prograde
    if (essayState === 'start') {
        noFill();
        stroke(48, 255, 144, 180);
        strokeWeight(1.5);
        drawingContext.setLineDash([8, 10]);
        circle(bodies[0].pos.x, bodies[0].pos.y, (bodies[0].radius + ALTITUDE_MILESTONE) * 2);
        drawingContext.setLineDash([]);
    }

    let n = activeBand();
    if (n < 1) return;

    let band = ORBIT_BANDS[n - 1];
    let rMid = bodies[0].radius + (band[0] + band[1]) / 2;
    let inBand = inActiveBand();

    noFill();
    stroke(48, 255, 144, inBand ? 70 : 35);
    strokeWeight(band[1] - band[0]);
    circle(bodies[0].pos.x, bodies[0].pos.y, rMid * 2);

    stroke(48, 255, 144, 160);
    strokeWeight(1);
    circle(bodies[0].pos.x, bodies[0].pos.y, (bodies[0].radius + band[0]) * 2);
    circle(bodies[0].pos.x, bodies[0].pos.y, (bodies[0].radius + band[1]) * 2);

    noStroke();
    fill(48, 255, 144, 220);
    textFont("menlo");
    textAlign(CENTER, BOTTOM);
    let note = BAND_TARGETS[essayState] ? (inBand ? " — hold it!" : "") : " ✓";
    text("target orbit " + n + "/3" + note,
        bodies[0].pos.x, bodies[0].pos.y - (bodies[0].radius + band[1]) - 6);

}

function draw() {

    //
    // Updating state
    //

    if (boostInputActive() && ship.getFuelRemaining() > 0) {
        launched = true;
    }

    if (framesToSkip < 0) {

        if (abs(framesToSkip) >= T) {
            framesToSkip = -T;
        }

        while (framesToSkip < -1) {
            T--;

            framesToSkip += 1;
        }

        if (T == 0) {
            launched = false;
        }

    } else {

        outer:
        while (framesToSkip) {

            bodies[1].pos = moonOrbit[T % moonOrbit.length].copy();

            ship.update();

            if (launched) {

                // checking for landing or crash (earth only)
                let body = bodies[0];
                if (p5.Vector.dist(ship.posHistory[T], body.pos) - body.radius < ship.length / 2) {

                    let landingVelocityThreshold = 0.5;

                    let impactVelocity = ship.velHistory[T].copy();
                    let upright = ship.posHistory[T].copy().sub(body.pos.copy()).normalize().mult(body.radius + ship.length / 2);
                    let landingAngle = p5.Vector.angleBetween(ship.orientationHistory[T], upright);

                    if (impactVelocity.mag() <= landingVelocityThreshold &&
                        landingAngle < TAU / 8) {

                        ship.velHistory[T].set(0, 0);
                        ship.orientationHistory[T].set(upright.copy().normalize());
                        ship.posHistory[T].set(body.pos.copy().add(upright));

                        launched = false;
                        ship.landingPos = upright;
                        ship.bodyLandedOn = body;

                    } else {
                        crashedOut = true;
                        paused = true;
                    }

                    break outer;
                }

            }

            updateMilestones();

            framesToSkip -= 1;

            if (framesToSkip == 0) {
                drawFrame();
            }

            T++;
        }

    }

    framesToSkip = 0;

    if (!paused) {
        if (timelineScrubActive()) {
            // hold playback while scrubbing; just render the current frame
            drawFrame();
        } else {
            framesToSkip = 1;
        }
    } else {
        updateImpulseMode();
        drawFrame();
    }

    rollingFrameRateAverage = ((rollingFrameRateAverage * 19) + frameRate()) / 20;

    let now = millis();
    dt = (now - lastFrameTime) / 1000; // dt in seconds
    lastFrameTime = now;

    drawTimeline();

}
