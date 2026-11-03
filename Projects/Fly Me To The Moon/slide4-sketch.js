// Lunar section: the full Earth + Moon system with Impulse Mode (free burn
// length). The essay units map to simulation states:
//
//   start    a fresh flight from the Earth (also what scrolling back to the
//            first unit restores)
//   orbit    the ship is inside the Moon's hill sphere on an orbital
//            trajectory around it
//   landed   the ship has landed on the Moon
//
// Scrolling to the first unit resets the flight; scrolling forwards leaves
// it alone. Flying posts 'lunarOrbit' / 'lunarLanding', which move the essay
// to the matching unit.

let lunarState = 'start';
let pendingLunarState = null;
let slide4Ready = false;
let wasInLunarOrbit = false;

window.onEssayLineActive = function (data) {

    if (!data || !data.state) return;

    if (!slide4Ready) {
        pendingLunarState = data.state;
        return;
    }

    enterLunarState(data.state);

};

function enterLunarState(name) {

    if (name === lunarState) return;

    // the way back to the first unit is the way to try again
    if (name === 'start') {
        cancelImpulse();
        resetSimulation();
        wasInLunarOrbit = false;
    }

    lunarState = name;

}

function inLunarOrbit() {

    let moonPos = moonOrbit[T % moonOrbit.length];
    return ship.shipOrbitingMoon &&
        p5.Vector.dist(ship.posHistory[T], moonPos) < moonHillSphereRadius;

}

function checkLunarOrbit() {

    let now = !!launched && inLunarOrbit();

    if (now && !wasInLunarOrbit) {
        window.parent.postMessage({ type: 'lunarOrbit' }, '*');
        lunarState = 'orbit';
    }

    wasInLunarOrbit = now;

}

window.onImpulseBurnFrame = function () {
    checkLunarOrbit();
};

function setup() {

    pixelDensity(1);
    createCanvas(windowWidth, windowHeight);
    disableMobileGestureConflicts();

    gravLights = true;
    showTrajectory = true;
    showTrajectoryDescription = true;
    showArrows = true;

    impulse.available = true;
    impulse.exclusive = true;
    impulse.mapAlways = true;


    initPalette();

    bodies.push(new Body(createVector(0, 0), 100, 1, 'earth'));
    bodies.push(new Body(createVector(0, -25 * 17), 25, 0.1, 'moon'));

    let l = 30;
    ship = new Ship(createVector(bodies[0].pos.x, bodies[0].pos.y - bodies[0].radius - l / 2), l);

    camera = new Camera();

    generateMoonOrbit();

    rollingFrameRateAverage = frameRate();

    gravFieldImg = loadImage("gravitationalField.png");
    polarImg = loadImage("polar.png");

    // hypot
    gridSize = round(Math.sqrt(width * width + height * height));

    let a = p5.Vector.dist(bodies[0].pos, bodies[1].pos);
    let m1 = bodies[0].mass;
    let m2 = bodies[1].mass;
    moonHillSphereRadius = a * Math.cbrt(m2 / 3 * (m1 + m2));

    stars = generateRocketStars();

    for (let i = 0; i < 100; i++) {
        exhaustPlumeLengthRandomCycle.push(random(0.9, 1.1));
    }

    lastFrameTime = millis();
    dt = 0;

    slide4Ready = true;
    if (pendingLunarState) {
        enterLunarState(pendingLunarState);
    }

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

                // checking for landing or crash

                for (let body of bodies) {
                    if (p5.Vector.dist(ship.posHistory[T], body.pos) - body.radius < ship.length / 2) {

                        // if velocity below threshold and orientation has landing gear aligned with the ground, then the rocketship lands
                        // otherwise, it is a crash

                        let landingVelocityThreshold = 0.5;

                        let impactVelocity = ship.velHistory[T].copy();
                        if (body == bodies[1]) {
                            impactVelocity.sub(moonOrbitVelHistory[T % moonOrbitVelHistory.length]);
                        }
                        let upright = ship.posHistory[T].copy().sub(body.pos.copy()).normalize().mult(body.radius + ship.length / 2);
                        let landingAngle = p5.Vector.angleBetween(ship.orientationHistory[T], upright);

                        if (impactVelocity.mag() <= landingVelocityThreshold &&
                            landingAngle < TAU / 8) {

                            // reset velocity, position, and orientation based on landing spot
                            if (body == bodies[1]) {
                                ship.velHistory[T].set(moonOrbitVelHistory[T % moonOrbitVelHistory.length]);
                            } else {
                                ship.velHistory[T].set(0, 0);
                            }

                            ship.orientationHistory[T].set(upright.copy().normalize());
                            ship.posHistory[T].set(body.pos.copy().add(upright));

                            launched = false;
                            ship.landingPos = upright;
                            ship.bodyLandedOn = body;

                            if (body == bodies[1]) {
                                window.parent.postMessage({ type: 'lunarLanding' }, '*');
                                lunarState = 'landed';
                            }

                        } else {
                            crashedOut = true;
                            paused = true;
                        }

                        break outer;
                    }
                }

                checkLunarOrbit();

            }

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
