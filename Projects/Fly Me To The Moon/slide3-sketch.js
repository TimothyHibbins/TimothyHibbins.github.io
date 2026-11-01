// Earth-only rocket simulation for the 'reaching orbit' section.
//
// The moon exists as a massless, invisible body so the shared code paths keep
// working, but it exerts no gravity and is never drawn. The gravity-light
// image is generated at setup for the earth-only field (it's radially
// symmetric, so it's built from a 1D profile).
//
// The sketch watches the reader's flying and posts milestone events to the
// essay page, which reveals the matching paragraphs:
//   altitudeReached     high enough for a pure prograde burn to reach orbit
//   orbitAchieved       projected trajectory is a full orbit
//   firedUp             burned radially outward after orbiting (before prograde)
//   apoapsisRaised      prograde burn raised the apoapsis
//   circularisedHigher  circularised at a higher altitude
//   orbitLowered        brought the orbit back down with retrograde burns
//
// After orbitLowered, target orbit bands appear: match your orbit to each
// band (first one, then further out, then further in).

const ALTITUDE_MILESTONE = 90;

let milestones = {
    altitude: false,
    orbit: false,
    firedUp: false,
    apoRaised: false,
    circHigher: false,
    lowered: false
};

let apoAtOrbit = 0;
let periAtOrbit = 0;
let apoAtCircularised = 0;

// target orbit bands: [periapsis floor, apoapsis ceiling] altitudes
const ORBIT_BANDS = [
    [200, 290],
    [400, 510],
    [115, 180]
];
let bandStage = 0; // 0: none yet, 1-3: active band, 4: all done
let bandHoldFrames = 0;
const BAND_HOLD_REQUIRED = 90;

function postEssayEvent(type) {
    window.parent.postMessage({ type: type }, "*");
}

function setup() {

    pixelDensity(1);
    createCanvas(windowWidth, windowHeight);
    disableMobileGestureConflicts();

    gravLights = true;
    showTrajectory = false; // turned on when the projection paragraph reveals
    showTrajectoryDescription = true;

    moonEnabled = false;

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

    polarImg = loadImage("polar.png");

    // // hypot
    gridSize = round(Math.sqrt(width * width + height * height));

    moonHillSphereRadius = 0;

    gravFieldImg = generateEarthOnlyGravityField();

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

//
// Milestone detection
//

function updateMilestones() {

    if (!launched || crashedOut) return;

    let m = milestones;
    let alt = p5.Vector.dist(ship.posHistory[T], bodies[0].pos) - bodies[0].radius;

    if (!m.altitude && alt > ALTITUDE_MILESTONE) {
        m.altitude = true;
        showTrajectory = true; // "we're going to add a projection of your trajectory"
        postEssayEvent('altitudeReached');
    }

    if (!m.orbit && m.altitude && ship.trajectoryType == 'Orbit' && ship.periapsisAlt > 15) {
        m.orbit = true;
        apoAtOrbit = ship.apoapsisAlt;
        periAtOrbit = ship.periapsisAlt;
        postEssayEvent('orbitAchieved');
    }

    if (!m.orbit) return;

    let boosting = ship.boostingHistory[T];

    if (boosting && !m.apoRaised) {

        let orientation = ship.orientationHistory[T];
        let radialOut = ship.posHistory[T].copy().sub(bodies[0].pos);
        let vel = ship.velHistory[T];

        let angleToUp = abs(p5.Vector.angleBetween(orientation, radialOut));
        let angleToPrograde = abs(p5.Vector.angleBetween(orientation, vel));

        // tried firing 'up' before firing prograde
        if (!m.firedUp && angleToUp < TAU / 12) {
            m.firedUp = true;
            postEssayEvent('firedUp');
        }

        // prograde burn that raised the apoapsis
        if (angleToPrograde < TAU / 10 && ship.apoapsisAlt > apoAtOrbit + 40) {
            m.apoRaised = true;
            postEssayEvent('apoapsisRaised');
        }
    }

    if (m.apoRaised && !m.circHigher && ship.trajectoryType == 'Orbit') {

        let rPeri = ship.periapsisAlt + bodies[0].radius;
        let rApo = ship.apoapsisAlt + bodies[0].radius;
        let ecc = (rApo - rPeri) / (rApo + rPeri);

        // circular-ish orbit, meaningfully higher than the first one
        if (ecc < 0.08 && ship.periapsisAlt > periAtOrbit + 40) {
            m.circHigher = true;
            apoAtCircularised = ship.apoapsisAlt;
            postEssayEvent('circularisedHigher');
        }
    }

    if (m.circHigher && !m.lowered) {

        // only burns change the orbit, so a clearly lower apoapsis means
        // retrograde burns brought the orbit down
        if (ship.apoapsisAlt < apoAtCircularised - 40 && ship.trajectoryType == 'Orbit') {
            m.lowered = true;
            bandStage = 1;
            postEssayEvent('orbitLowered');
        }
    }

    if (bandStage >= 1 && bandStage <= 3) {

        let band = ORBIT_BANDS[bandStage - 1];
        let inBand = ship.trajectoryType == 'Orbit' &&
            ship.periapsisAlt >= band[0] && ship.apoapsisAlt <= band[1];

        if (inBand) {
            bandHoldFrames++;
            if (bandHoldFrames >= BAND_HOLD_REQUIRED) {
                bandStage++;
                bandHoldFrames = 0;
            }
        } else {
            bandHoldFrames = 0;
        }
    }

}

// drawn by shared drawFrame inside the camera transform
function drawWorldOverlay() {

    if (bandStage < 1 || bandStage > 3) return;

    let band = ORBIT_BANDS[bandStage - 1];
    let rMid = bodies[0].radius + (band[0] + band[1]) / 2;

    let inBand = ship.trajectoryType == 'Orbit' &&
        ship.periapsisAlt >= band[0] && ship.apoapsisAlt <= band[1];

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
    text("target orbit " + bandStage + "/3" + (inBand ? " — hold it!" : ""),
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
        if (instantaneousMode) {
            ship.instantaneousModeUpdate();

            if (rocketPointerActive()) {
                instantaneousMode = false;
                paused = false;
                T++;
            }
        }
        drawFrame();
    }

    rollingFrameRateAverage = ((rollingFrameRateAverage * 19) + frameRate()) / 20;

    let now = millis();
    dt = (now - lastFrameTime) / 1000; // dt in seconds
    lastFrameTime = now;

    drawTimeline();

}
