// Newton's cannonball, as a slingshot on a tower.
//
// Two balls sit on a tower on a zoomed-in (visually flat) Earth. One ball is
// in a slingshot that can only be pulled back left, orthogonal to 'down', so
// it releases due right. Each completed shot upgrades the slingshot: landing
// with the dropped ball, landing later and further, reaching the far side of
// the planet, grazing past the antipode to arrive back at the slingshot after
// a near-full orbit, a circular orbit, and an eccentric orbit. After that,
// balls fall *through* the Earth as if orbiting a point mass, showing that
// all falling is just incomplete orbits.
//
// The physics uses exact closed-form solutions: outside the Earth each ball
// follows a Keplerian conic evaluated from Kepler's equation; inside it (in
// ghost mode) gravity for a uniform-density Earth is linear in r, so motion
// is an exact 2D harmonic oscillator — ellipses centred on the Earth's
// centre. Segments are stitched at surface crossings, where the two force
// laws agree. Energy and momentum are conserved exactly: a dropped ball
// passes straight through to the antipode at the same altitude, and sideways
// velocity widens that path into ever-fatter centred ellipses until the
// orbit clears the surface entirely.
//
// Every new shot also re-fires all previously slung balls (faint) and
// re-drops the dropped ball, each with a flight timer that freezes when it
// lands.
//
// shared.js is loaded first purely for its mobile touch plumbing
// (disableMobileGestureConflicts and the touch->mouse forwarding); all of its
// input handlers are overridden below.

let earthR = 2000;
let surfaceG = 0.01;
let mu; // gravitational parameter = surfaceG * earthR^2
let omega; // interior (uniform density) oscillation frequency = sqrt(mu / earthR^3)
let landR; // radius at which balls touch down

let towerH = 60;
let ballRadius = 6;

let towerAngle = -Math.PI / 2; // tower at the top of the earth
let towerBase, towerTop, upDir, rightDir;

let slingAnchor; // handle / intersection of the Y
let slingRelease; // level with the prong tips: ball rest + release point
let launchDir; // exactly tangential at the release point (visually due right)
let dropAnchor;

let vCircular;
let powerLevels = [];
let stage = 0;
let shotCount = 0;
let ghostMode = false; // balls pass through the earth (point-mass orbits)

// upgrades are gated by how far the reader has scrolled in the essay: ids of
// paragraphs they have passed map to the highest stage allowed
let unlockedStage = 0;
let ghostUnlocked = false;

// essay paragraph id -> slingshot capability
// 'immediate' stages apply as soon as the paragraph is reached; the
// progressive block ('sling-up-match') upgrades one stage per shot instead
const UNLOCKS = {
    'sling-up-1': { cap: 1, jumpTo: 1 },
    'sling-up-2': { cap: 2, jumpTo: 2 },
    'sling-up-match': { cap: 6, jumpTo: 3 },
    'sling-up-ecc': { cap: 7, jumpTo: 7 },
    'sling-ghost': { ghost: true }
};

window.onEssayLineActive = function (data) {

    if (!data || !data.passedIds) return;

    let jumped = false;

    for (let id of data.passedIds) {
        let u = UNLOCKS[id];
        if (!u) continue;

        if (u.cap !== undefined && u.cap > unlockedStage) {
            unlockedStage = u.cap;
        }

        if (u.jumpTo !== undefined && u.jumpTo > stage) {
            stage = u.jumpTo;
            jumped = true;
        }

        if (u.ghost && !ghostUnlocked) {
            ghostUnlocked = true;
            if (!ghostMode) {
                ghostMode = true;
                upgradeMessage = "The ground is now a ghost — balls fall straight through!";
                upgradeMessageTimer = 240;
            }
        }
    }

    if (jumped) {
        upgradeMessage = "Slingshot upgraded!";
        upgradeMessageTimer = 160;
    }

};

let shotState = 'ready'; // 'ready' | 'flying' | 'done'
let doneTimer = 0;
let draggingSling = false;
let pullDist = 0;
let maxPull = 110;

let fastForward = false; // true while the fast-forward button is held

let slingBallPos; // resting/dragged position while ready

let balls = []; // balls in flight for the current shot
let pastVelocities = []; // release speeds of all previous slung shots
let ghostTrails = [];

let sweptAngle = 0;
let flightFrames = 0;
let maxFlightFrames = 30000;

let upgradeMessageTimer = 0;
let upgradeMessage = "";

let cam = { x: 0, y: 0, scale: 1 };

let earthColorSling, ballColorSling, dropColorSling;


function setup() {

    pixelDensity(1);
    createCanvas(windowWidth, windowHeight);
    disableMobileGestureConflicts();

    mu = surfaceG * earthR * earthR;
    omega = Math.sqrt(mu / (earthR * earthR * earthR));
    landR = earthR + ballRadius;

    upDir = p5.Vector.fromAngle(towerAngle);
    rightDir = createVector(-upDir.y, upDir.x);

    towerBase = upDir.copy().mult(earthR);
    towerTop = upDir.copy().mult(earthR + towerH);

    slingAnchor = p5.Vector.add(towerTop, rightDir.copy().mult(12));
    slingRelease = p5.Vector.add(slingAnchor, upDir.copy().mult(9));
    // the dropped ball rests at the same altitude as the sling release point,
    // so equal fall times really are equal
    dropAnchor = p5.Vector.sub(towerTop, rightDir.copy().mult(12)).add(upDir.copy().mult(9));

    // launch exactly tangentially (the release point sits a hair off the
    // tower's radial, and a horizontal launch there would not be at apoapsis)
    launchDir = createVector(-slingRelease.y, slingRelease.x).normalize();

    //
    // Stage speeds, in closed form. A tangential launch is a launch from
    // apoapsis, so r(true anomaly ν past apoapsis) = r0(1-e)/(1 - e cos ν),
    // and landing at r = landR after sweeping φ requires
    //   e = (r0 - landR) / (r0 - landR cos φ)
    // with launch speed v = sqrt(mu (1-e) / r0).
    //
    let r0 = slingRelease.mag();

    // lands most of the way to the far side of the planet (φ = 170°)
    let eFar = (r0 - landR) / (r0 - landR * Math.cos(radians(170)));
    let vFar = Math.sqrt(mu * (1 - eFar) / r0);

    // periapsis clears the ground over the antipode by a hair, so the ball
    // comes all the way back around and lands at the slingshot itself (a
    // ground landing can never sweep past the antipode: a tangential launch
    // is an apoapsis, and the orbit is symmetric about it)
    let qPass = landR + 6;
    let ePass = (r0 - qPass) / (r0 + qPass);
    let vPass = Math.sqrt(mu * (1 - ePass) / r0);

    vCircular = Math.sqrt(mu / r0);

    powerLevels = [
        0.6, // lands at the same time as the dropped ball
        2,
        3,
        3.9, // noticeably later and further
        vFar, // reaches the far side of the planet
        vPass, // grazes the antipode and returns to the slingshot
        vCircular, // low circular orbit
        vCircular * 1.18 // eccentric orbit
    ];

    earthColorSling = color("#a3ffffff");
    ballColorSling = color("#ff9f1c");
    dropColorSling = color("#00ffffff");

    cam.x = towerTop.x;
    cam.y = towerTop.y;
    cam.scale = 1;

    resetShot();

}

function resetShot() {

    balls = [];
    slingBallPos = slingRelease.copy();

    shotState = 'ready';
    draggingSling = false;
    pullDist = 0;
    sweptAngle = 0;
    flightFrames = 0;

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
            // ascending: place in the second half of the out-and-back
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

    // eccentricity vector
    let rv = pos0.x * vel0.x + pos0.y * vel0.y;
    let coef = v2 - mu / r;
    let ex = (coef * pos0.x - rv * vel0.x) / mu;
    let ey = (coef * pos0.y - rv * vel0.y) / mu;
    let e = Math.hypot(ex, ey);

    // perifocal frame: p towards periapsis, q 90° ahead in the direction of motion
    let px, py;
    if (e > 1e-9) {
        px = ex / e;
        py = ey / e;
    } else {
        px = pos0.x / r;
        py = pos0.y / r;
    }
    let sgn = h >= 0 ? 1 : -1;
    let qx = -py * sgn;
    let qy = px * sgn;

    // initial eccentric anomaly and mean anomaly
    let E0 = Math.atan2(rv / Math.sqrt(mu * a), 1 - r / a);

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
// even for the near-parabolic ellipses of barely-pulled ghost shots
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

        // invert t = C (θ + sin θ) by bisection (monotonic)
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
        // 2D harmonic oscillator: pos(t) = A cos(ωt) + B sin(ωt)
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

function launchShot() {

    let v = releaseSpeed();

    balls = [];

    // the new shot
    balls.push(makeBall(slingRelease, launchDir.copy().mult(v), ballColorSling, 255, 'primary'));

    // every previously slung ball fires again, faint
    for (let pv of pastVelocities) {
        balls.push(makeBall(slingRelease, launchDir.copy().mult(pv), ballColorSling, 90, 'past'));
    }

    // and the dropped ball drops again
    balls.push(makeBall(dropAnchor, createVector(0, 0), dropColorSling, 255, 'drop'));

    pastVelocities.push(v);

    shotState = 'flying';
    sweptAngle = 0;
    flightFrames = 0;

}

function currentMaxSpeed() {
    return powerLevels[stage];
}

function releaseSpeed() {
    return (pullDist / maxPull) * currentMaxSpeed();
}

function primaryBall() {
    return balls.find(b => b.kind === 'primary');
}

function dropBallOf() {
    return balls.find(b => b.kind === 'drop');
}

function stepBall(ball) {

    if (ball.landed) return;

    let oldPos = ball.pos;
    ball.t++;
    let newPos = segmentPositionAt(ball.seg, ball.t);

    if (ghostMode) {

        // hand over between the exterior Kepler and interior harmonic closed
        // forms at the surface, where the two force laws agree
        let wasIn = oldPos.mag() < earthR;
        let isIn = newPos.mag() < earthR;

        if (wasIn != isIn) {

            // bisect the crossing time on the current segment
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

    // keep the trail smooth through fast stretches: the closed forms can be
    // evaluated at fractional times
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

function endShot() {

    for (let ball of balls) {
        ghostTrails.push({ points: ball.trail, col: ball.col });
    }

    shotCount++;

    // upgrades only come as the reader scrolls on; within an unlocked block
    // ('keep upgrading the slingshot'), each shot advances one stage
    if (stage < unlockedStage) {
        stage++;
        upgradeMessage = "Slingshot upgraded!";
        upgradeMessageTimer = 160;
    }

    resetShot();

}

function updateFlight() {

    let primary = primaryBall();
    let drop = dropBallOf();

    let prevAngle = primary.pos.heading();

    for (let s = 0; s < stepsPerFrame(); s++) {

        for (let ball of balls) {
            stepBall(ball);
        }
        flightFrames++;

        let newAngle = primary.pos.heading();
        if (!primary.landed) {
            let d = newAngle - prevAngle;
            if (d > PI) d -= TAU;
            if (d < -PI) d += TAU;
            sweptAngle += d;
        }
        prevAngle = newAngle;

        if (flightFrames % 3 == 0) {
            for (let ball of balls) {
                if (!ball.landed) {
                    ball.trail.push(ball.pos.copy());
                }
            }
        }

        let orbitComplete = abs(sweptAngle) >= TAU;
        let mainOnesLanded = primary.landed && drop.landed;

        if (mainOnesLanded || orbitComplete || flightFrames > maxFlightFrames) {

            // linger for a moment so the result is readable before resetting
            shotState = 'done';
            doneTimer = 90;
            return;
        }
    }

}

//
// Camera
//

function updateCamera() {

    let targets = [towerTop];

    if (shotState === 'ready') {
        targets.push(slingBallPos, dropAnchor);
    } else {
        for (let ball of balls) {
            targets.push(ball.pos);
        }
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let t of targets) {
        minX = min(minX, t.x); maxX = max(maxX, t.x);
        minY = min(minY, t.y); maxY = max(maxY, t.y);
    }

    let cx = (minX + maxX) / 2;
    let cy = (minY + maxY) / 2;

    let spread = max(maxX - minX, maxY - minY, 180);
    let targetScale = min(width, height) * 0.7 / spread;
    targetScale = constrain(targetScale, 0.05, 1.6);

    cam.x = lerp(cam.x, cx, 0.08);
    cam.y = lerp(cam.y, cy, 0.08);
    cam.scale = lerp(cam.scale, targetScale, 0.08);

}

function slingWorldToScreen(x, y) {
    return {
        x: (x - cam.x) * cam.scale + width / 2,
        y: (y - cam.y) * cam.scale + height / 2
    };
}

function slingScreenToWorld(x, y) {
    return createVector(
        (x - width / 2) / cam.scale + cam.x,
        (y - height / 2) / cam.scale + cam.y
    );
}

//
// Rendering
//

function draw() {

    // safety: never leave fast-forward stuck on
    if (fastForward && !mouseIsPressed) {
        fastForward = false;
    }

    if (shotState === 'flying') {
        updateFlight();
    } else if (shotState === 'done') {
        doneTimer--;
        if (doneTimer <= 0) {
            endShot();
        }
    }

    updateCamera();

    background(0);

    push();
    translate(width / 2, height / 2);
    scale(cam.scale);
    translate(-cam.x, -cam.y);

    // earth
    noStroke();
    fill(earthColorSling);
    circle(0, 0, earthR * 2);

    if (ghostMode) {
        // mark the centre of the earth, the point mass everything orbits
        fill(0, 60);
        circle(0, 0, 24 / cam.scale);
    }

    // tower
    stroke("#b98157");
    strokeWeight(10);
    line(towerBase.x, towerBase.y, towerTop.x, towerTop.y);

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

        noStroke();
        fill(red(ball.col), green(ball.col), blue(ball.col), ball.alpha);
        circle(ball.pos.x, ball.pos.y, ballRadius * 2);

        // flight timer, frozen once landed
        textFont("menlo");
        textAlign(CENTER, BOTTOM);
        textSize(12 / cam.scale);
        text(ball.timer, ball.pos.x, ball.pos.y - (ballRadius + 4));
    }

    // projected path while aiming in ghost mode: the exact piecewise motion
    // (Kepler outside the surface, harmonic inside) sampled for one revolution
    if (ghostMode && draggingSling && pullDist > 4) {

        let m = makeBall(slingRelease, launchDir.copy().mult(releaseSpeed()), ballColorSling, 0, 'projection');

        let points = [slingRelease.copy()];
        let swept = 0;
        let prevAngle = slingRelease.heading();

        for (let i = 0; i < 7000 && abs(swept) < TAU * 0.999; i++) {

            stepBall(m);

            let a = m.pos.heading();
            let d = a - prevAngle;
            if (d > PI) d -= TAU;
            if (d < -PI) d += TAU;
            swept += d;
            prevAngle = a;

            if (i % 12 == 0) {
                points.push(m.pos.copy());
            }
        }

        stroke(255, 110);
        strokeWeight(1.5 / cam.scale);
        drawingContext.setLineDash([4 / cam.scale, 10 / cam.scale]);
        noFill();

        beginShape();
        for (let p of points) {
            vertex(p.x, p.y);
        }
        endShape();

        drawingContext.setLineDash([]);
    }

    // slingshot: fork whose prong tips are level with the resting ball, so
    // the elastic band pulls back horizontally
    let forkBase = p5.Vector.sub(slingAnchor, upDir.copy().mult(10));
    let prongL = p5.Vector.add(slingAnchor, rightDir.copy().mult(-7)).add(upDir.copy().mult(9));
    let prongR = p5.Vector.add(slingAnchor, rightDir.copy().mult(7)).add(upDir.copy().mult(9));

    stroke("#b98157");
    strokeWeight(4);
    line(forkBase.x, forkBase.y, slingAnchor.x, slingAnchor.y);
    line(slingAnchor.x, slingAnchor.y, prongL.x, prongL.y);
    line(slingAnchor.x, slingAnchor.y, prongR.x, prongR.y);

    if (shotState === 'ready') {

        stroke("#ffffff");
        strokeWeight(2);
        line(prongL.x, prongL.y, slingBallPos.x, slingBallPos.y);
        line(prongR.x, prongR.y, slingBallPos.x, slingBallPos.y);

        // resting balls
        noStroke();
        fill(ballColorSling);
        circle(slingBallPos.x, slingBallPos.y, ballRadius * 2);
        fill(dropColorSling);
        circle(dropAnchor.x, dropAnchor.y, ballRadius * 2);

    }

    pop();

    drawHud();

}

function getFFButton() {
    let w = min(230, width * 0.45);
    let h = 44;
    return { x: width - w - 12, y: height - h - 12, w: w, h: h };
}

function drawHud() {

    fill(255);
    noStroke();
    textFont("menlo");
    textAlign(LEFT, TOP);
    textSize(14);

    let power = "Slingshot power: " +
        (stage + 1) + "/" + powerLevels.length +
        " (v = " + nf(currentMaxSpeed(), 1, 2) + ")";
    if (ghostMode) {
        power += "  —  MAX + ghost balls";
    }

    text(power + "\nShots fired: " + shotCount, 14, 14);

    textAlign(CENTER, TOP);
    if (shotState === 'ready' && pullDist < 4) {
        fill(255, 200);
        let hint;
        if (ghostMode) {
            hint = "Balls now fall through the Earth.\nDrag the slingshot ball left and release.";
        } else if (stage >= unlockedStage) {
            hint = "Drag the slingshot ball left and release.\nKeep reading to upgrade the slingshot.";
        } else {
            hint = "Drag the slingshot ball left and release.";
        }
        text(hint, width / 2, 14);
    }

    if (upgradeMessageTimer > 0) {
        upgradeMessageTimer--;
        fill(255, 159, 28, min(255, upgradeMessageTimer * 4));
        textSize(18);
        text(upgradeMessage, width / 2, 44);
    }

    // hold-to-fast-forward button
    let b = getFFButton();
    stroke(255, fastForward ? 220 : 90);
    strokeWeight(2);
    fill(255, fastForward ? 60 : 15);
    rect(b.x, b.y, b.w, b.h, 10);

    noStroke();
    fill(255, fastForward ? 255 : 170);
    textAlign(CENTER, CENTER);
    textSize(14);
    text("≫ hold: fast-forward", b.x + b.w / 2, b.y + b.h / 2);

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

function mousePressed() {

    if (pointerOnFFButton()) {
        fastForward = true;
        return false;
    }

    if (shotState !== 'ready') return false;

    let w = pointerWorld();
    let grabRadius = max(30, 30 / cam.scale);
    if (p5.Vector.dist(w, slingBallPos) < grabRadius) {
        draggingSling = true;
    }

    return false;
}

function mouseDragged() {

    if (fastForward) return false;

    if (!draggingSling) return false;

    let w = pointerWorld();

    // clamp: the sling only pulls back left, orthogonal to 'down'
    let offset = p5.Vector.sub(w, slingRelease);
    pullDist = constrain(-offset.dot(rightDir), 0, maxPull);

    slingBallPos = p5.Vector.sub(slingRelease, rightDir.copy().mult(pullDist));

    return false;
}

function mouseReleased() {

    fastForward = false;

    if (!draggingSling) return false;
    draggingSling = false;

    if (pullDist > 8) {
        // the sling snaps the ball back to the release point and lets go
        // there, due right; past balls and the dropped ball go at the same
        // moment
        launchShot();
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
