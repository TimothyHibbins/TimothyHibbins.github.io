/*

Fixed bugs:
- false 'orbit' depicted when it should be collission course when setting low velocity
  - something wrong with collision detection in projectTrajectory
    - nope this is actually caused by it detecting an orbit because the angle hasn't changed after 50 frames
- orbital extension glitch


Bugs to fix:
- peripasis apoapsis flickering
- showing trajectory relative to moon even outside of hillsphere when trajectory type is collission and there doesn't appear to be a complete moon orbit
- orbit not updating to collision course without boost



- arrow behind ship?

Feature to-do list:
- orbital description HUD
  - elliptical:
    - eccentricity, periapsis, apoapsis, period
  - escape:
  - collision trajectory
    - time to impact, impact velocity

- quick launch

- dynamic camera

- reset button

- night vision sound effect when you turn on the gravity light (like in Animal Well)

- music plays according to orbit
  - sonified force vector

- live framerate visualiser diagnostic

- bubble appearance for hill sphere


Finished features:
- prebake lunar movement
- collision detection for planet
- ship HUD
  - velocity, altitude relative to planet
- scroll backwards in time
- show velocity and gravitational force vectors
- add orbital velocity when launching from the moon + relative velocity when calculating crash
- visualise gravity
- instantaneous impulse control
  - show projection for how orbit will *shift* as you boost

*/

const KEYS = 'keys';
const MOUSE = 'mouse'
let controlMode = KEYS;

let cameraMode;

let rollingFrameRateAverage;

let G = 75 // gravitational constant

let paused = false;

let launched = false;

let crashedOut = false;

let displayPathChange = false;

let framesToSkip = 0;

let T = 0;

let particles = [];

let particlePulseFrequency = 300;
let particleTimer = particlePulseFrequency;

let bodies = [];

let ship;

let closestBody = 0;

let camera;

let moonOrbit = [];
let moonOrbitVelHistory = [];
let moonHillSphereRadius;

let gravitationalFieldHistory = [];

let gridSize;


let rocketColor;
let earthColor;
let moonColor;

let gap = 100;

let exhaustPlumeLengthRandomCycle = [];


let accArrowScale = 40000;
let velArrowScale = 100;


let gravFieldImg;
let polarImg;

let stars = [];

let instantaneousMode = false;

let framerateHistory = [];
let dt;
let lastFrameTime;

let frameDT;

let gravLights = false;
let showTrajectory = false;
let showTrajectoryDescription = false;
let showArrows = false;



function drawFramerateHistory(x, y) {

    let xScale = 150;
    let yScale = 1;

    let duration = 2;

    noStroke();
    fill(255);

    let i = 0;
    let w = (duration * xScale)

    for (let frame of framerateHistory) {

        // if (frameCount % 2 == 0) {
        //   if (i % 2 == 0) {
        //     fill(200);
        //   } else {
        //     fill(255);
        //   }
        // } else {
        //   if (i % 2 == 0) {
        //     fill(255);
        //   } else {
        //     fill(200);
        //   }
        // }

        if (w < x) {
            framerateHistory.splice(i + 1);
        }

        rect(x + w, y + (yScale / 1 / 60), (frame.dt) * xScale, -(yScale / frame.dt));
        w -= (frame.dt * xScale);
        i++;

    }
}

function generatePolarCoordinateImage() {

    polarBuffer = createGraphics(180, gridSize);
    polarBuffer.loadPixels();

    for (let theta = 0; theta < 180; theta++) {

        for (let alt = 0; alt < gridSize; alt++) {

            let pos = p5.Vector.fromAngle(-TAU / 4 + radians(theta));
            pos.setMag(alt);

            let earthGrav = bodies[0].getGravitationalAcceleration(pos);
            let moonGrav = bodies[1].getGravitationalAcceleration(pos, moonOrbit[0 % moonOrbit.length]);
            let netGrav = p5.Vector.add(earthGrav, moonGrav);

            let mix = lerpColor(earthColor, moonColor, moonGrav.mag() / netGrav.mag());

            let gMax = 0.007;
            let gMin = 0.00005; // small value to avoid log(0)

            let g = netGrav.mag(); // your per-pixel g

            // Linearize using log2
            let normalized = (Math.log10(g + gMin) - Math.log10(gMin)) /
                (Math.log10(gMax) - Math.log10(gMin));

            // Clamp to 0–1
            normalized = constrain(normalized, 0, 1);

            // surface grav = 0.005

            let idx = 4 * (theta + alt * 180);

            polarBuffer.pixels[idx] = red(mix);
            polarBuffer.pixels[idx + 1] = green(mix);
            polarBuffer.pixels[idx + 2] = blue(mix);

            polarBuffer.pixels[idx + 3] = normalized * 255;

        }

    }

    polarBuffer.updatePixels();
    save(polarBuffer, 'png');

}

function generateGravitationalFieldBuffer() {

    // Precompute the field into an offscreen buffer
    fieldBuffer = createGraphics(gridSize, gridSize);
    fieldBuffer.loadPixels();

    for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize / 2 + 1; x++) {
            let gravAtPoint = {
                pos: createVector(x - gridSize / 2, y - gridSize / 2),
                earthGrav: false,
                moonGrav: false,
                netGrav: false
            };

            gravAtPoint.earthGrav = bodies[0].getGravitationalAcceleration(gravAtPoint.pos);
            gravAtPoint.moonGrav = bodies[1].getGravitationalAcceleration(gravAtPoint.pos);
            gravAtPoint.netGrav = p5.Vector.add(gravAtPoint.earthGrav, gravAtPoint.moonGrav);

            let mix = lerpColor(earthColor, moonColor, gravAtPoint.moonGrav.mag() / gravAtPoint.netGrav.mag());

            let idx = 4 * (x + y * gridSize);

            // Encode as grayscale (or color map)
            fieldBuffer.pixels[idx] = red(mix);
            fieldBuffer.pixels[idx + 1] = green(mix);
            fieldBuffer.pixels[idx + 2] = blue(mix);

            let gMax = 0.007;
            let gMin = 0.00005; // small value to avoid log(0)

            let g = gravAtPoint.netGrav.mag(); // your per-pixel g

            // Linearize using log2
            let normalized = (Math.log10(g + gMin) - Math.log10(gMin)) /
                (Math.log10(gMax) - Math.log10(gMin));

            // Clamp to 0–1
            normalized = constrain(normalized, 0, 1);

            fieldBuffer.pixels[idx + 3] = normalized * 255;

            // surface grav = 0.005
        }
    }

    // mirror
    for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize / 2; x++) {

            let mirrorIdx = 4 * ((gridSize / 2 - x) + y * gridSize)

            let idx = 4 * ((gridSize / 2 + x) + y * gridSize);

            fieldBuffer.pixels[idx] = fieldBuffer.pixels[mirrorIdx];
            fieldBuffer.pixels[idx + 1] = fieldBuffer.pixels[mirrorIdx + 1];
            fieldBuffer.pixels[idx + 2] = fieldBuffer.pixels[mirrorIdx + 2];
            fieldBuffer.pixels[idx + 3] = fieldBuffer.pixels[mirrorIdx + 3];

        }
    }

    fieldBuffer.updatePixels();

    save(fieldBuffer, 'png');

}

// prebaked for easy lookup when projecting ship trajectory
function generateMoonOrbit() {

    let v = sqrt(bodies[0].getGravitationalAcceleration(bodies[1].pos).mag() * p5.Vector.dist(bodies[0].pos, bodies[1].pos));

    let moon = {
        pos: bodies[1].pos.copy(),
        vel: createVector(v, 0),
    }



    moonOrbit.push(moon.pos.copy());
    moonOrbitVelHistory.push(moon.vel.copy());

    for (let lT = 0; lT < 25000; lT++) {

        moon.vel.add(bodies[0].getGravitationalAcceleration(moon.pos))
        moon.pos.add(moon.vel);

        moonOrbit.push(moon.pos.copy());
        moonOrbitVelHistory.push(moon.vel.copy());


        if (lT > 50 &&
            abs(p5.Vector.angleBetween(
                moonOrbit[0].copy().sub(bodies[0].pos),
                moon.pos.copy().sub(bodies[0].pos)
            ))
            <= TAU / 360 && moon.pos.x > 0) {

            break;
        }

    }




}


class Ship {
    constructor(startingPos, l) {

        this.bodyLandedOn = bodies[0];
        this.landingPos = startingPos.copy().sub(bodies[0].pos);


        this.posHistory = [startingPos];
        this.velHistory = [createVector(0, 0)];
        this.accHistory = [createVector(0, 0)];
        this.orientationHistory = [p5.Vector.fromAngle(-TAU / 4)];
        this.boostingHistory = [false];

        this.rocketAcc = 0.007;

        this.length = l;
        this.sWidth = this.length / 3;

        this.apoapsis = this.posHistory[0].copy();
        this.periapsis = this.posHistory[0].copy();
        this.periapsisAlt = false;
        this.apoapsisAlt = false;

        this.trajectoryType = false;
        this.shipOrbitingMoon = false;
        this.shipOrbitingMoonEndOfFirstOrbit = false;

    }

    drawShipBody(x, y, alphaValue, ghost = false) {

        let l = this.length;
        let w = this.sWidth;

        push();
        translate(x, y);
        rotate(this.orientationHistory[T].heading() + TAU / 4);

        noStroke();
        if (this.boostingHistory[T]) {

            let trailLength = l * 2 * exhaustPlumeLengthRandomCycle[T % exhaustPlumeLengthRandomCycle.length];
            let t = trailLength;

            let fireColor = color('#ff7fd2b2');
            // fireColor.setAlpha(alphaValue);
            if (ghost) {
                fireColor.setRed(0)
            };
            fill(fireColor);
            beginShape();
            vertex(0, t);
            vertex(-w / 2.5, l / 2.5);
            vertex(w / 2.5, l / 2.5);
            vertex(0, t);
            endShape();
        }

        let hullColor = rocketColor;
        hullColor.setAlpha(alphaValue);
        if (ghost) {
            hullColor.setRed(0)
        };
        fill(hullColor);
        rectMode(CENTER);
        //rect(x, y, l/3, l);

        //left fin
        beginShape();
        vertex(-w / 1.5, l / 2);

        bezierVertex(
            -w / 1.5, l / 2,
            -w / 2, l / 5,
            -w / 3, l / 5
        );
        vertex(-w / 3, l / 2.5);
        bezierVertex(
            -w / 2, l / 2.5,
            -w / 1.5, l / 2,
            -w / 1.5, l / 2
        );

        endShape();

        //right fin
        beginShape();
        vertex(w / 1.5, l / 2);

        bezierVertex(
            w / 1.5, l / 2,
            w / 2, l / 5,
            w / 3, l / 5
        );
        vertex(w / 3, l / 2.5);
        bezierVertex(
            w / 2, l / 2.5,
            w / 1.5, l / 2,
            w / 1.5, l / 2
        );

        endShape();


        // hull
        beginShape();

        //tip of the nose cone
        vertex(0, -l / 2);
        bezierVertex(
            -w / 2, -l / 3,
            -w, 0,
            -w / 3, l / 2.5
        );

        vertex(w / 3, l / 2.5);

        bezierVertex(
            w, 0,
            w / 2, -l / 3,
            0, -l / 2
        );

        endShape();

        let windowColor = color('#e5a3d0ff')
        // if (ghost) {
        //   windowColor.setRed(0)
        // };
        fill(windowColor);
        circle(0, 0, l / 3.5);

        pop();

    }

    drawTrajectory() {
        strokeWeight(1);

        let lineColor = color("#ff57fcd6");
        let frameSkip = 5;


        for (let PT = 0; PT < this.posHistory.length; PT++) {

            // if (PT < T) {
            //   stroke("#36f725ff");
            //   point(this.posHistory[PT].x, this.posHistory[PT].y);
            // }


            if (PT > T) {

                let posRelativeToMoon = p5.Vector.sub(this.posHistory[PT], moonOrbit[PT % moonOrbit.length]);
                let drawInHillSphere = false;
                if (posRelativeToMoon.mag() < moonHillSphereRadius || (this.shipOrbitingMoon && PT < this.shipOrbitingMoonEndOfFirstOrbit)) {
                    drawInHillSphere = true;
                }

                strokeWeight(3);
                stroke(lineColor);
                lineColor.setAlpha(255);



                if (PT + frameSkip < this.posHistory.length) {

                    if (PT % frameSkip == 0) {

                        if (drawInHillSphere) {

                            let nextPosRelativeToMoon = p5.Vector.sub(this.posHistory[PT + frameSkip], moonOrbit[(PT + frameSkip) % moonOrbit.length])

                            line(bodies[1].pos.x + posRelativeToMoon.x, bodies[1].pos.y + posRelativeToMoon.y,
                                bodies[1].pos.x + nextPosRelativeToMoon.x, bodies[1].pos.y + nextPosRelativeToMoon.y);

                            lineColor.setAlpha(50);
                            stroke(lineColor);

                        }

                        line(this.posHistory[PT].x, this.posHistory[PT].y,
                            this.posHistory[PT + frameSkip].x, this.posHistory[PT + frameSkip].y);



                    }

                } else if (PT != this.posHistory.length - 1) {

                    if (drawInHillSphere) {

                        let nextPosRelativeToMoon = p5.Vector.sub(this.posHistory[this.posHistory.length - 1], moonOrbit[(this.posHistory.length - 1) % moonOrbit.length])

                        line(bodies[1].pos.x + posRelativeToMoon.x, bodies[1].pos.y + posRelativeToMoon.y,
                            bodies[1].pos.x + nextPosRelativeToMoon.x, bodies[1].pos.y + nextPosRelativeToMoon.y);

                        lineColor.setAlpha(50);
                        stroke(lineColor);

                    }

                    line(this.posHistory[PT].x, this.posHistory[PT].y,
                        this.posHistory[this.posHistory.length - 1].x, this.posHistory[this.posHistory.length - 1].y);

                }

                // if (PT % 50 == 0) {
                //   drawArrow(this.posHistory[PT], p5.Vector.add(this.posHistory[PT], this.velHistory[PT].copy().mult(velArrowScale)));
                // }

                // // stroke("#d8ff58ff");
                // point(this.posHistory[PT].x, this.posHistory[PT].y);


            }


            // if ((T + i) % 100 == 0) {
            //   this.drawShipBody(projection.pos.x, projection.pos.y, 60, true);
            // } else if ((T + i) % 10 == 0) {
            //   this.drawShipBody(projection.pos.x, projection.pos.y, 10, true);
            // }


            // this.drawShipBody(projection_pos.x, projection_pos.y, 10 * ((i%100)/100), true);


        }
    }

    drawTrajectoryDescription(pos, offset) {

        fill(rocketColor);
        noStroke();
        textFont("menlo");
        textAlign(LEFT, BOTTOM);

        let projectionDuration = this.posHistory.length - T;

        if (this.trajectoryType == 'Orbit') {

            text("Orbit\n" +
                "Period: " + round(projectionDuration / 100, 1) + " hectoframes",
                pos.x + offset, pos.y - offset);

            text(
                "Periapsis: " + round(this.periapsisAlt) + "px",
                this.periapsis.x + offset, this.periapsis.y + offset);

            text(
                "Apoapsis: " + round(this.apoapsisAlt) + "px",
                this.apoapsis.x + offset, this.apoapsis.y + offset);

            // periapsis
            let surfaceIntersect = bodies[0].getSurfaceIntersectForAltitudeLine(this.periapsis);
            strokeWeight(1);
            stroke(rocketColor);
            line(surfaceIntersect.x, surfaceIntersect.y, this.periapsis.x, this.periapsis.y);

            // apoapsis
            surfaceIntersect = bodies[0].getSurfaceIntersectForAltitudeLine(this.apoapsis);
            strokeWeight(1);
            stroke(rocketColor);
            line(surfaceIntersect.x, surfaceIntersect.y, this.apoapsis.x, this.apoapsis.y);

        } else if (this.trajectoryType == 'Collision Course') {

            text("Collision Course\n" +
                "Time to impact: : " + round(projectionDuration / 100, 1) + " hectoframes\n" +
                "Impact velocity: " + round(this.velHistory[T].mag() * 100, 1) + " px/hectoframe",
                pos.x + offset, pos.y - offset);

            // } else {
            //   camera.minX = ship.pos.x;
            //   camera.maxX = ship.pos.x;

            //   camera.minY = ship.pos.y;
            //   camera.maxY = ship.pos.y;
        }

        if (this.shipOrbitingMoon) {

            text("Orbiting Moon\n" +
                "Period: " + round(this.shipOrbitingMoonEndOfFirstOrbit - T / 100, 1) + " hectoframes",
                pos.x + offset + 150, pos.y - offset);

        }
    }

    drawArrows(pos) {

        strokeWeight(2);

        let moonPos = moonOrbit[T % moonOrbit.length];

        let arrowsFromShip = false;
        let arrowsFromVel = false;


        let accArrowEndpoint = this.accHistory[T].copy().mult(accArrowScale);

        let earthGravArrowEndpoint = bodies[0].getGravitationalAcceleration(pos).mult(accArrowScale);
        let moonGravArrowEndpoint = bodies[1].getGravitationalAcceleration(pos, moonPos).mult(accArrowScale);

        let boostForceArrow = accArrowEndpoint.copy().sub(p5.Vector.add(earthGravArrowEndpoint, moonGravArrowEndpoint));

        let velArrowEndpoint = this.velHistory[T].copy().mult(velArrowScale);

        // Draw force arrows from ship

        if (arrowsFromShip) {
            stroke(earthColor);
            drawArrow(pos, p5.Vector.add(pos, earthGravArrowEndpoint));

            stroke(moonColor);
            drawArrow(pos, p5.Vector.add(pos, moonGravArrowEndpoint));

            stroke(rocketColor);
            drawArrow(pos, p5.Vector.add(pos, boostForceArrow));

            stroke("#fff");
            drawArrow(pos, p5.Vector.add(pos, accArrowEndpoint));

        }

        // draw velocity arrow from ship
        stroke(rocketColor);
        drawArrow(pos, p5.Vector.add(pos, velArrowEndpoint));

        if (arrowsFromVel) {
            let startPos = p5.Vector.add(pos, velArrowEndpoint);


            // Draw acceleration arrows end to end from end of velocity arrow
            stroke("#fff");
            drawArrow(startPos, p5.Vector.add(startPos, accArrowEndpoint));


            stroke(earthColor);
            drawArrow(startPos, p5.Vector.add(startPos, earthGravArrowEndpoint));

            startPos.add(earthGravArrowEndpoint);

            stroke(moonColor);
            drawArrow(startPos, p5.Vector.add(startPos, moonGravArrowEndpoint));

            startPos.add(moonGravArrowEndpoint);

            stroke(rocketColor);
            drawArrow(startPos, p5.Vector.add(startPos, boostForceArrow));
        }
    }

    draw() {

        let pos = this.posHistory[T];

        camera.minY = pos.x;
        camera.maxY = pos.y;

        if (showTrajectory) {
            this.drawTrajectory();
        }

        let offset = this.length / 2;

        if (showTrajectoryDescription) {
            this.drawTrajectoryDescription(pos, offset);
        }

        if (showArrows) {
            this.drawArrows(pos);
        }

        fill('#ffffff');
        noStroke();
        textFont("menlo");
        textAlign(LEFT, TOP);

        text("Alt: " + round(p5.Vector.dist(pos, bodies[closestBody].pos) - bodies[closestBody].radius) + " px", pos.x + offset, pos.y + offset);

        // fill("#00ff22ff");

        // offset = 3;
        // text(
        //   "\nVel: " + round(ship.vel.mag() * 100) + " px/hectoframe" + "\nAcc: " + ship.acc.mag(),
        //   velArrowEndpoint.x + offset, velArrowEndpoint.y);


        this.drawShipBody(pos.x, pos.y, 255);

    }

    projectTrajectory(boost = false, orientationShift = false, boostThrottle = 1) {

        if (orientationShift) {
            this.orientationHistory[T].rotate(orientationShift);
            for (let FT = T + 1; FT < this.orientationHistory.length; FT++) {
                this.orientationHistory[FT] = this.orientationHistory[FT - 1].copy();
            }

        }

        if (boost) {
            this.posHistory.splice(T + 1);
            this.velHistory.splice(T + 1);
            this.accHistory.splice(T + 1);

            this.boostingHistory.splice(T + 1);
            this.orientationHistory.splice(T + 1);


            this.trajectoryType = false;

            // this.periapsis = this.pos.copy();



            this.shipOrbitingMoon = false;
            this.shipOrbitingMoonEndOfFirstOrbit = false;


            this.boostingHistory[T] = true;

            // undo original velocity and acceleration
            this.posHistory[T].sub(this.velHistory[T]);
            this.velHistory[T].sub(this.accHistory[T]);

            this.accHistory[T] = createVector(0, 0);

            this.accHistory[T].add(bodies[0].getGravitationalAcceleration(this.posHistory[T]));

            let moonPos = moonOrbit[T % moonOrbit.length];
            this.accHistory[T].add(bodies[1].getGravitationalAcceleration(this.posHistory[T], moonPos));

            // recalculate acceleration, with
            let rocketImpulse = this.orientationHistory[T].copy().mult(this.rocketAcc * boostThrottle);
            // console.log(this.acc_history[T]);
            this.accHistory[T].add(rocketImpulse);

            this.velHistory[T].add(this.accHistory[T]);
            this.posHistory[T].add(this.velHistory[T]);


            // camera.minX = this.posHistory[T].x;
            // camera.maxX = this.posHistory[T].x;


            this.periapsis = this.posHistory[T].copy();
            this.periapsisAlt = bodies[0].getAltitude(this.periapsis);

            this.apoapsis = this.posHistory[T].copy();
            this.apoapsisAlt = bodies[0].getAltitude(this.apoapsis);


        }

        //
        // Trajectory Projection
        //

        this.shipOrbitingMoon = false;
        this.shipOrbitingMoonEndOfFirstOrbit = false;

        let initialMoonT = false;
        let initialMoonPos = false;

        let cumulativeAngularChangeAroundEarth = 0;
        let cumulativeAngularChangeAroundMoon = 0;

        for (let i = T; i < this.posHistory.length; i++) {

            if (i > 0) {
                cumulativeAngularChangeAroundEarth += p5.Vector.angleBetween(
                    this.posHistory[i].copy().sub(bodies[0].pos),
                    this.posHistory[i - 1].copy().sub(bodies[0].pos)
                );
            }


            let moonPos = moonOrbit[i % moonOrbit.length];

            if (initialMoonT == false && this.posHistory[i].dist(moonPos) < moonHillSphereRadius) {
                initialMoonT = i;
                initialMoonPos = moonPos.copy();
                // console.log("past " + initialMoonT);
            }

            if (initialMoonT != false && !this.shipOrbitingMoon) {
                // If it has passed a certain length of time and we are more or less back where we started, then we have completed an orbit and can end the projection

                cumulativeAngularChangeAroundMoon += p5.Vector.angleBetween(
                    this.posHistory[i].copy().sub(bodies[1].pos),
                    this.posHistory[i - 1].copy().sub(bodies[1].pos)
                );

                if (abs(cumulativeAngularChangeAroundMoon) >= TAU) {
                    this.shipOrbitingMoon = true;
                    this.shipOrbitingMoonEndOfFirstOrbit = i;

                }
            }



        }


        // start is correct, but it is skipping over the end too

        outer:
        for (let i = this.posHistory.length; (i - T < moonOrbit.length) && !(this.trajectoryType == 'Collision Course'); i++) {

            this.posHistory.push(this.posHistory[i - 1].copy());
            this.velHistory.push(this.velHistory[i - 1].copy());
            this.accHistory.push(createVector(0, 0));
            this.boostingHistory.push(false);
            this.orientationHistory.push(this.orientationHistory[i - 1].copy());

            let moonPos = moonOrbit[i % moonOrbit.length];

            this.accHistory[i].add(bodies[0].getGravitationalAcceleration(this.posHistory[i]));
            this.accHistory[i].add(bodies[1].getGravitationalAcceleration(this.posHistory[i], moonPos));

            this.velHistory[i].add(this.accHistory[i]);

            this.posHistory[i].add(this.velHistory[i]);



            cumulativeAngularChangeAroundEarth += p5.Vector.angleBetween(
                this.posHistory[i].copy().sub(bodies[0].pos),
                this.posHistory[i - 1].copy().sub(bodies[0].pos)
            );

            if (abs(cumulativeAngularChangeAroundEarth) > TAU) {
                this.trajectoryType = 'Orbit';
                break outer;
            }


            if (initialMoonT == false && this.posHistory[i].dist(moonPos) < moonHillSphereRadius) {
                initialMoonT = i;
                initialMoonPos = moonPos.copy();
                // console.log(initialMoonT);
            }

            // trajectory detection

            // if (i - T > 50) {

            //   // If it has passed a certain length of time and we are more or less back where we started, then we have completed an orbit and can end the projection
            //   if (
            //     abs(p5.Vector.angleBetween(
            //       this.posHistory[T].copy().sub(bodies[0].pos),
            //       this.posHistory[i].copy().sub(bodies[0].pos)
            //     ))
            //     <= TAU / 360) {
            //     this.trajectoryType = 'Orbit';
            //     break outer;
            //   }

            // }

            if (initialMoonT != false && !this.shipOrbitingMoon && i - initialMoonT > 25) {
                // If it has passed a certain length of time and we are more or less back where we started, then we have completed an orbit and can end the projection

                cumulativeAngularChangeAroundMoon += p5.Vector.angleBetween(
                    this.posHistory[i].copy().sub(bodies[1].pos),
                    this.posHistory[i - 1].copy().sub(bodies[1].pos)
                );

                if (abs(cumulativeAngularChangeAroundMoon) >= TAU) {
                    this.shipOrbitingMoon = true;
                    this.shipOrbitingMoonEndOfFirstOrbit = i;

                }

            }

            for (let [b, body] of bodies.entries()) {
                // let r = p5.Vector.sub(body.pos, projection.pos);

                let alt;
                if (b == 1) {
                    alt = body.getAltitude(this.posHistory[i], moonPos);
                } else {
                    alt = body.getAltitude(this.posHistory[i]);


                    if (alt < this.periapsisAlt) {
                        this.periapsis = this.posHistory[i].copy();
                        this.periapsisAlt = alt;
                    } else if (alt > this.apoapsisAlt) {
                        this.apoapsis = this.posHistory[i].copy();
                        this.apoapsisAlt = alt;
                    }

                }

                if (alt < this.length / 2) {
                    this.trajectoryType = 'Collision Course';

                    break outer;
                }
            }

            // if (this.posHistory[i].x < camera.minX) {
            //   camera.minX = this.posHistory[i].x;
            // } else if (this.posHistory[i].x > camera.maxX) {
            //   camera.maxX = this.posHistory[i].x;
            // }

            // if (this.posHistory[i].y < camera.minY) {
            //   camera.minY = this.posHistory[i].y;
            // } else if (this.posHistory[i].y > camera.maxY) {
            //   camera.maxY = this.posHistory[i].y;
            // }


        }

    }

    update() {

        if (!launched) {
            this.posHistory.splice(T + 1);
            this.velHistory.splice(T + 1);
            this.accHistory.splice(T + 1);

            this.boostingHistory.splice(T + 1);
            this.orientationHistory.splice(T + 1);


            this.trajectoryType = false;

            this.posHistory.push(this.landingPos.copy().add(this.bodyLandedOn.pos));


            if (this.bodyLandedOn == bodies[1]) {
                this.velHistory.push(moonOrbitVelHistory[T % moonOrbitVelHistory.length].copy());
            } else {
                this.velHistory.push(this.velHistory[T].copy());
            }




            this.accHistory.push(createVector(0, 0));
            this.boostingHistory.push(false);
            this.orientationHistory.push(this.orientationHistory[T].copy());

            return;
        }

        let turnVel = TAU / 50;
        let amt = false;

        if (controlMode == MOUSE) {
            let cursorPos = camera.screenToWorld(mouseX, mouseY);

            cursorPos.sub(this.posHistory[T]);

            // line(this.pos.x, this.pos.y, this.pos.x+(this.orientation.x*10), this.pos.y+(this.orientation.y*10))
            // console.log(this.orientation.heading());

            let angle = p5.Vector.angleBetween(this.orientationHistory[T], cursorPos);

            if (angle > 0) {
                amt = min(abs(angle), turnVel);
            } else if (angle < 0) {
                amt = -min(abs(angle), turnVel);
            }
        } else if (controlMode == KEYS) {

            if (keyIsDown(LEFT_ARROW)) {
                amt = -turnVel / 1.5;
            } else if (keyIsDown(RIGHT_ARROW)) {
                amt = turnVel / 1.5;
            }

        }

        this.projectTrajectory((mouseIsPressed || (keyIsDown(UP_ARROW))), amt);

    }

    instantaneousModeUpdate() {

        let cursorPos = camera.screenToWorld(mouseX, mouseY);

        cursorPos.sub(this.posHistory[T]);

        this.orientationHistory[T] = cursorPos.copy().normalize();

        let magDenominator = 3; // smaller means more sensitive

        let boostThrottle = cursorPos.copy().mag() / magDenominator;
        // console.log(boostThrottle);

        this.projectTrajectory(true, 0, boostThrottle);

    }

}

function drawArrow(p1, p2, headLength = 5) {

    line(p1.x, p1.y, p2.x, p2.y);

    push();
    translate(p2.x, p2.y);
    rotate(p2.copy().sub(p1.copy()).heading() - TAU / 4);

    line(0, 0, -headLength / 2, -headLength);
    line(0, 0, headLength / 2, -headLength);

    pop();

}

class Body {

    constructor(pos, radius, mass, bColor) {
        this.pos = pos;
        this.radius = radius;
        this.bColor = bColor;
        this.mass = mass;
    }

    getSurfaceIntersectForAltitudeLine(objectPos) {
        return this.pos.copy().add(objectPos.copy().sub(this.pos.copy()).normalize().mult(this.radius));
    }

    getAltitude(pos, bodyPos = this.pos) {
        return p5.Vector.dist(pos, bodyPos) - this.radius;
    }

    getGravitationalAcceleration(objectPos, bodyPos = this.pos) {
        let r = p5.Vector.sub(bodyPos, objectPos);

        let force = G * this.mass / r.magSq();

        return r.normalize().mult(force);
    }

    draw() {

        fill(this.bColor);
        noStroke();
        circle(this.pos.x, this.pos.y, this.radius * 2);

    }

}

class Camera {

    constructor() {

        let margin = height / 10




        this.cameraBboxMinX = margin;
        this.cameraBboxMaxX = width - margin;

        this.cameraBboxMinY = margin;
        this.cameraBboxMaxY = height - margin;

        this.centredObject = bodies[0];

        this.minX = ship.posHistory[T].x;
        this.maxX = ship.posHistory[T].x;

        this.minY = ship.posHistory[T].y;
        this.maxY = ship.posHistory[T].y;

        this.scaleFactor = 1;

    }

    drawBbox() {

        rectMode(CORNERS);
        noFill();
        stroke("#b3b3b3ff");
        strokeWeight(1);
        rect(this.cameraBboxMinX, this.cameraBboxMinY, this.cameraBboxMaxX, this.cameraBboxMaxY);


        rectMode(CORNER);

    }

    updateScaleFactor() {

        let scaleFactors = [];

        for (let [bound, box] of [[this.minX, this.cameraBboxMinX], [this.maxX, this.cameraBboxMaxX]]) {

            let distToBound = abs(this.centredObject.pos.x - bound);
            let maxDist = abs(width / 2 - box);


            if (distToBound > maxDist) {

                scaleFactors.push(maxDist / distToBound);

            } else {
                scaleFactors.push(1);
            }

        }

        for (let [bound, box] of [[this.minY, this.cameraBboxMinY], [this.maxY, this.cameraBboxMaxY]]) {

            let distToBound = abs(this.centredObject.pos.y - bound);
            let maxDist = abs(height / 2 - box);


            if (distToBound > maxDist) {

                scaleFactors.push(maxDist / distToBound);

            } else {
                scaleFactors.push(1);
            }

        }

        this.scaleFactor = min(scaleFactors);


    }

    applyToMatrix() {

        this.updateScaleFactor();

        push();
        translate(width / 2, height / 2);

        scale(this.scaleFactor);

        translate(-this.centredObject.pos.x, -this.centredObject.pos.y);

    }

    worldToScreen(x, y) {

        x = (x - this.centredObject.pos.x) * this.scaleFactor + width / 2;
        y = (y - this.centredObject.pos.y) * this.scaleFactor + height / 2;

        return { x: x, y: y };

    }

    screenToWorld(x, y) {

        x = (x - width / 2) / this.scaleFactor + this.centredObject.pos.x;
        y = (y - height / 2) / this.scaleFactor + this.centredObject.pos.y;

        return createVector(x, y);

    }

}

function getGravitationalAccelerationFromAllBodies(object) {

    let acceleration = createVector(0, 0);
    for (let body of bodies) {
        acceleration.add(body.getGravitationalAcceleration(object.pos));
    }

    return acceleration;

}

class Star {
    constructor(pos, brightness, size) {
        this.pos = pos;
        this.brightness = brightness;
        this.size = size;
    }

    draw() {
        strokeWeight(this.size);
        stroke(this.brightness);
        point(this.pos.x, this.pos.y);
    }
}

class Particle {
    constructor(pos) {
        this.pos = pos;
        this.vel = createVector(0, 0);
        this.timer = particleTimer;
    }

    update() {

        this.vel.add(getGravitationalAccelerationFromAllBodies(this));

        this.pos.add(this.vel);

        this.timer--;

    }

    draw() {
        let pointColor = color('#ffffff')
        //pointColor.setAlpha(255 * this.timer / particle_timer);
        stroke(pointColor);
        strokeWeight(2);
        point(this.pos.x, this.pos.y);
    }
}

function mouseWheel(event) {

    instantaneousMode = false;
    if (event.delta > 0 && launched && !crashedOut) {
        framesToSkip = event.delta;
    }

    else if (event.delta < 0) {
        framesToSkip = event.delta;
        crashedOut = false;
    }
    // Uncomment to prevent any default behavior.
    return false;
}

function mousePressed() {

    controlMode = MOUSE;

}


function windowResized() {
    resizeCanvas(windowWidth, windowHeight);
}

function keyPressed(event) {

    if (keyCode == LEFT_ARROW || keyCode == RIGHT_ARROW || keyCode == UP_ARROW) {
        controlMode = KEYS;

    }

    if (key == 'f') {
        fullscreen(true);
    }

    if (key == 'i') {
        paused = true;
        instantaneousMode = true;
    }

    if (key == 'r') {
        T = 0;
        launched = false;

    }

    if (key == 'p' & !crashedOut) {
        paused = !paused; // toggles
    }

    if (key == 'd') {
        displayPathChange = !displayPathChange; // toggles
    }
}


function drawFrame() {

    background(0);

    // Camera

    // centred on body, but zooming in/out to keep ship trajectory inside a bounding box on screen
    // camera.drawBbox();
    camera.applyToMatrix();

    // Rendering in camera

    strokeWeight(2);
    stroke(255);
    for (let star of stars) {
        star.draw();
    }

    if (gravLights) {
        push();
        // translate(-width / 2, -height / 2);
        rotate((T % moonOrbit.length / moonOrbit.length * TAU));

        image(gravFieldImg, -gravFieldImg.width / 2, -gravFieldImg.height / 2);
        pop();
    }

    // draw moon orbit
    for (let i = 0; i < moonOrbit.length; i++) {

        let moonPos = moonOrbit[(T + i) % moonOrbit.length];
        strokeWeight(1);
        stroke(red(moonColor), green(moonColor), blue(moonColor), 25);
        point(moonPos.x, moonPos.y);

    }

    // draw hill sphere boundary
    noFill();
    circle(bodies[1].pos.x, bodies[1].pos.y, moonHillSphereRadius * 2);


    bodies[1].pos = moonOrbit[T % moonOrbit.length].copy();
    for (let body of bodies) {
        body.draw();
    }

    stroke("#fff");
    // strokeWeight(1);
    // let surfaceIntersect = bodies[0].pos.copy().add(ship.posHistory[T].copy().sub(bodies[0].pos.copy()).normalize().mult(bodies[0].radius));
    // line(surfaceIntersect.x, surfaceIntersect.y, ship.posHistory[T].x, ship.posHistory[T].y);

    ship.draw();

    // strokeWeight(5);
    // stroke("#fff");
    // point(ship.apoapsis.x, ship.apoapsis.y);

    for (let i = 0; i < particles.length; i++) {
        particles[i].draw();
    }

    offset = ship.length / 2;

    if (crashedOut) {
        noStroke();
        textAlign(RIGHT, TOP);
        text("You have crashed.", ship.posHistory[T].x - offset, ship.posHistory[T].y + offset);
    }

    // camera
    pop();

}

function timelineMask() {
    let h = height / 10;
    // fill(0);
    noStroke();
    rect(0, height - h, width, h);
}

function drawPlayBack() {
    fill("#fff");
    let h = height / 10;
    let w = width / 3;
    rect(width / 2 - w / 2, height - h * 2, w, h);

    let playBackScale = 3;
    let playBackUnit = 1;
    let playBackUnitScale = width / 3 / 7;
    for (let i = -(playBackUnit * playBackScale); i <= (playBackUnit * playBackScale); i++) {

        let x = width / 2 - (i * playBackUnitScale);
        stroke(0);
        strokeWeight(2);
        line(x, height - h * 2, x, height - h);

    }
}

function drawTimeline() {

    push();
    clip(timelineMask);

    let h = height / 10;
    fill(0);
    rect(0, height - h, width, h);

    framesPerPixel = 5;

    sliceMinAlt = 0;
    sliceMaxAlt = floor(bodies[0].radius + ship.apoapsisAlt + 100);

    for (let PT = 0; PT < ship.posHistory.length; PT += framesPerPixel) {

        let x = width / 2 + (PT - (T - (T % framesPerPixel))) / framesPerPixel;

        relativePos = ship.posHistory[PT].copy().sub(bodies[0].pos);
        moonPosRelativeToEarth = moonOrbit[PT % moonOrbit.length].copy().sub(bodies[0].pos);

        theta = abs(p5.Vector.angleBetween(relativePos, moonPosRelativeToEarth));


        push();
        translate(x, height);
        scale(1, -1);

        //image(img, dx, dy, dWidth, dHeight, sx, sy, [sWidth], [sHeight], [fit], [xAlign], [yAlign])

        image(
            polarImg, // img
            0, 0, // dx, dy
            1, h, //dWidth, dHeight
            floor(degrees(theta)), 0, // sx, sy
            1, sliceMaxAlt // sWidth, sHeight
        );

        pop();
        stroke(bodies[0].bColor);

        line(x, height - (h * bodies[0].radius / sliceMaxAlt), x, height);


        stroke(rocketColor);
        let y = height - (h * 9 / 10 * p5.Vector.dist(bodies[0].pos, ship.posHistory[PT]) / sliceMaxAlt)
        line(x, y - 1, x, y + 1);


    }

    fill(0, 0, 0, 100);
    noStroke();
    rect(0, height - h, width, h / 10);

    noFill();
    let x = width / 2;
    stroke("#ffffffff");
    strokeWeight(1);
    line(x, height - h * 9 / 10, x, height);

    fill('#ffffff');
    noStroke();
    textFont("menlo");
    let tString = "T = " + round(T / 100, 1) + " hf";
    if (paused) {
        tString += " (PAUSED)";
    }
    if (instantaneousMode) {
        tString += " (INSTANTANEOUS MODE)";
    }
    textAlign(LEFT, TOP);
    text(tString, x, height - h);

    pop();

}