// the gravity light switches on only for the essay unit that explains it
// and the force arrows appear from "Falling in Style" onwards
window.onEssayLineActive = function (data) {
    gravLights = !!data && data.state === 'gravity';
    showArrows = !!data && data.section >= 1;
};

let overshotPosted = false;

function setup() {

    pixelDensity(1);
    createCanvas(windowWidth, windowHeight);
    disableMobileGestureConflicts();

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


    // // hypot
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

            if (T < 2) overshotPosted = false;

            // flying past the far edge of the Moon's hill sphere: overshot
            if (launched && !overshotPosted &&
                p5.Vector.dist(ship.posHistory[T], bodies[0].pos) >
                p5.Vector.dist(bodies[1].pos, bodies[0].pos) + moonHillSphereRadius) {
                overshotPosted = true;
                window.parent.postMessage({ type: "overshot" }, "*");
            }

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
                                window.parent.postMessage(
                                    {
                                        type: "moonLanding"
                                    },
                                    "*"
                                );
                            }



                        } else {
                            crashedOut = true;
                            paused = true;

                            let msgType;

                            if (body == bodies[0]) {
                                msgType = "earthCrash";
                            } else if (body == bodies[1]) {
                                msgType = "moonCrash";
                            }
                            window.parent.postMessage(
                                {
                                    type: msgType
                                },
                                "*"
                            );

                        }

                        // landed
                        // console.log(impactVelocity.mag(), degrees(landingAngle));



                        break outer;
                    }
                }

            }

            //       if (T % particle_pulse_frequency == 0) {
            //         // horizontal gridlines
            //         for (let y = 0; y < height; y+= height/10) {
            //           for (let x = 0; x < height; x+= height/100) {
            //               particles.push(new Particle(createVector(x, y)));
            //           }
            //         }
            //         // vertical gridlines
            //         for (let x = 0; x < height; x+= height/10) {
            //           for (let y = 0; y < height; y+= height/100) {
            //               particles.push(new Particle(createVector(x, y)));
            //           }
            //         }


            //       }
            // particles.push(new Particle(createVector(random(0, width), random(0, height))));

            // for (let i = 0; i < particles.length; i++) {
            //   particles[i].update();

            // }

            // for (let i = 0; i < particles.length; i++) {
            //   if (particles[i].timer <= 0) {
            //     particles.splice(i, 1);
            //   }
            // }

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


    // screenspace HUD


    // fill('#ffffff');
    // noStroke();
    // textFont("menlo");
    // let tString = "T = " + round(T / 100, 1) + " hectoframes since launch\nHistory: " + round(ship.posHistory.length / 100, 1) + "\nFPS: " + round(rollingFrameRateAverage, 0);
    // if (paused) {
    //   tString += " (PAUSED)";
    // }
    // if (instantaneousMode) {
    //   tString += " (INSTANTANEOUS MODE)";
    // }
    // textAlign(LEFT, TOP);
    // text(tString, 30, 30);


    let now = millis();
    dt = (now - lastFrameTime) / 1000; // dt in seconds
    // console.log(dt);
    lastFrameTime = now;

    // framerateHistory.unshift({ rate: frameRate(), dt: dt });

    // drawFramerateHistory(10, 140);

    // drawPlayBack();

    // drawTimeline();


}