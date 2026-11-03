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
const TOUCH = 'touch'; // the on-screen control ring (pressed with a finger or the mouse)
let controlMode = KEYS;

const TIMELINE_FRAMES_PER_PIXEL = 5;

// true while a press that started inside the control ring is held
let joystickActive = false;

// info about the essay's currently active line, sent by the parent essay page;
// sketches can define window.onEssayLineActive(data) to react to changes
let essayActiveLine = null;

window.addEventListener('message', (event) => {
    let data = event.data;
    if (data && data.type === 'essayLineActive') {
        essayActiveLine = data;
        if (typeof window.onEssayLineActive === 'function') {
            window.onEssayLineActive(data);
        }
    }
});

// timeline scrubbing (click/drag or touch over the timeline strip)
// only interactive in sketches that actually call drawTimeline()
let timelineEnabled = false;
// the timeline is hidden everywhere for now; with it off, nothing reserves
// the strip at the bottom of the screen (camera, joystick, scrubbing)
const TIMELINE_VISIBLE = false;
let timelineScrub = {
    active: false,
    lastX: 0,
    accum: 0,
    moved: 0
};

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


// Every colour the simulations share lives here. Bodies are drawn in their
// lighter shade whenever gravity lighting is on (the glow behind them is
// already their saturated colour).
const PALETTE = {
    rocket: '#ff00b3ff',
    earth: '#00ffffff',
    moon: '#ffff00ff',
    earthLight: '#a3ffffff',
    moonLight: '#ffff90ff',
    hiddenBody: '#ffff9000',
    fire: '#ff7fd2b2',
    window: '#e5a3d0ff',
    trajectory: '#ff57fcd6',
    thrust: '#ff9f1cff',
    white: '#ffffffff'
};

let rocketColor;
let earthColor;
let moonColor;
let paletteColors = {};

// call once p5 is ready (in setup)
function initPalette() {
    for (let name in PALETTE) {
        paletteColors[name] = color(PALETTE[name]);
    }
    rocketColor = paletteColors.rocket;
    earthColor = paletteColors.earth;
    moonColor = paletteColors.moon;
}

// the fill for a body kind ('earth', 'moon' or 'hiddenBody')
function bodyColor(kind) {
    if (kind === 'hiddenBody') return paletteColors.hiddenBody;
    return gravLights ? paletteColors[kind + 'Light'] : paletteColors[kind];
}
let gap = 100;

let exhaustPlumeLengthRandomCycle = [];


// arrows depict change over 100 frames:
// - the velocity arrow is the positional change over 100 frames (v * 100)
// - acceleration arrows are the change in the velocity arrow over 100 frames
//   ((a * 100) * velArrowScale)
let velArrowScale = 100;
let accArrowScale = 100 * velArrowScale;

// arrow display modes
const ARROWS_TIP_TO_TIP = 'tipToTip'; // forces out from the ship, parallelogram to the net point
const ARROWS_INWARD = 'inward'; // everything pointing in towards the ship
let arrowMode = ARROWS_TIP_TO_TIP;


let gravFieldImg;
let polarImg;

let stars = [];

// The one sky shared by every sketch, so stars sit at the same scale relative
// to the Earth everywhere. Positions and sizes are generated in Earth radii
// (a seeded generator keeps it identical each time) and scaled to the sketch's
// own Earth radius. Sizes match the rocket sketches' 0.3–3.5 units at R = 100.
const STAR_FIELD_HALF_EXTENT = 12; // in Earth radii
const STAR_FIELD_DENSITY = 13; // stars per square Earth radius

function generateStarField(earthRadius) {

    let seed = 20240607;
    const rand = () => {
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    let n = round(STAR_FIELD_DENSITY * sq(2 * STAR_FIELD_HALF_EXTENT));
    let unit = earthRadius / 100;
    let field = [];
    for (let i = 0; i < n; i++) {
        field.push({
            x: (rand() * 2 - 1) * STAR_FIELD_HALF_EXTENT * earthRadius,
            y: (rand() * 2 - 1) * STAR_FIELD_HALF_EXTENT * earthRadius,
            brightness: 100 + rand() * 155,
            size: (0.3 + rand() * 3.2) * unit
        });
    }
    return field;
}

function generateRocketStars() {
    return generateStarField(100).map(s =>
        new Star(createVector(s.x, s.y), s.brightness, s.size));
}

// prerendered buffer holding the stars and moon-orbit dots, which are
// static in world space (rebuilding them every frame is slow on mobile)
let staticWorldBuffer = false;
let staticWorldBufferHalf = 0;

function buildStaticWorldBuffer() {

    let half = STAR_FIELD_HALF_EXTENT * 100;
    for (let p of moonOrbit) {
        half = max(half, abs(p.x) + 2, abs(p.y) + 2);
    }
    half = ceil(half);

    let pg = createGraphics(half * 2, half * 2);
    pg.pixelDensity(1);
    pg.push();
    pg.translate(half, half);

    for (let star of stars) {
        pg.strokeWeight(star.size);
        pg.stroke(star.brightness);
        pg.point(star.pos.x, star.pos.y);
    }

    pg.strokeWeight(1);
    pg.stroke(red(moonColor), green(moonColor), blue(moonColor), 25);
    if (moonEnabled) {
        for (let p of moonOrbit) {
            pg.point(p.x, p.y);
        }
    }

    pg.pop();

    staticWorldBuffer = pg;
    staticWorldBufferHalf = half;

}

// only the part of the buffer on screen is drawn, which keeps this cheap on mobile
function drawStaticWorldBuffer() {

    let half = staticWorldBufferHalf;
    let s = camera.scaleFactor;
    let c = camera.centredObject.pos;

    let x0 = constrain(c.x - width / 2 / s - 2, -half, half);
    let x1 = constrain(c.x + width / 2 / s + 2, -half, half);
    let y0 = constrain(c.y - camera.visibleCenterY() / s - 2, -half, half);
    let y1 = constrain(c.y + (height - camera.visibleCenterY()) / s + 2, -half, half);

    if (x1 <= x0 || y1 <= y0) return;

    image(staticWorldBuffer, x0, y0, x1 - x0, y1 - y0,
        x0 + half, y0 + half, x1 - x0, y1 - y0);

}

// smoothed framerate readout, shown on touch devices to chase performance
let fpsSmoothed = 0;

function drawFpsIndicator() {

    if (!isTouchDevice()) return;

    let current = frameRate();
    fpsSmoothed = fpsSmoothed ? lerp(fpsSmoothed, current, 0.05) : current;

    push();
    noStroke();
    fill(255, 160);
    textFont('menlo');
    textSize(12);
    textAlign(LEFT, BOTTOM);
    text(round(fpsSmoothed) + " fps", 10, height - 10);
    pop();

}

// Impulse Mode is what pausing becomes once it is available: time stops, the
// reader aims a burn (direction and length) while the projection previews it,
// then locks it in. The burn then plays out with time still paused, and only
// then does the simulation resume.
//
// The control circle is a map of impulses: each point of it stands for an
// impulse (a burn direction and length in frames), and dragging slides the map
// so the impulse under the circle's centre is the one selected. The edge of
// the circle is IMPULSE_FRAMES_PER_REACH frames from the centre at zoom 1
// (pinch or scroll to zoom), and the map can be dragged without limit.
const IMPULSE_FRAMES_PER_REACH = 40;
const IMPULSE_ZOOM_MIN = 0.2;
const IMPULSE_ZOOM_MAX = 20;

// frames from the centre to the edge of the circle at the current zoom
function impulseReach() {
    return IMPULSE_FRAMES_PER_REACH / impulse.zoom;
}

function zoomImpulseMap(factor) {
    impulse.zoom = constrain(impulse.zoom * factor, IMPULSE_ZOOM_MIN, IMPULSE_ZOOM_MAX);
}
// The map is a lattice of impulses: point (ix, iy) stands for the impulse
// (ix, iy) * spacing, n of them across the circle. Outcomes are cached per
// point, so dragging only computes newly exposed points. Points are filled
// coarse-to-fine, and a block of the lattice whose four corners share an
// outcome (same kind and contour level) isn't refined: its interior is
// interpolated, so the work follows the boundaries and contours, not the area.
// The paused map has IMPULSE_MAP_CELLS across; the live one (under the control
// while time runs) IMPULSE_LIVE_CELLS, rebuilt in the background.
const IMPULSE_MAP_CELLS = 80;
const IMPULSE_LIVE_CELLS = 40;
const IMPULSE_MAP_BUDGET_MS = 10;
const IMPULSE_LIVE_BUDGET_MS = 5;
const IMPULSE_MAP_HORIZON = 4000;

// Apoapsis contours step by 40% of the distance (in body radii); everything
// beyond ~40 Earth radii shares one level, bound orbits and escapes are separated
const APO_LEVEL_STEP = Math.log(1.4);
const APO_LEVEL_CAP = Math.floor(Math.log(40) / APO_LEVEL_STEP);

// impact speed (relative to the body) up to which a landing is safe
const LANDING_SPEED = 0.5;

const OUTCOME_PLAIN = 0;
const OUTCOME_EARTH_ORBIT = 1;
const OUTCOME_MOON_ORBIT = 2;
const OUTCOME_ESCAPE = 3;

let impulse = {
    available: false, // Impulse Mode can be entered (by pausing)
    exclusive: false, // ...and the essay now treats it as the way to burn (hint text only)
    mapAlways: false, // the impulse map shows in the control from the start, without the ship diagram
    phase: 'off', // 'off' | 'aiming' | 'burning'
    snapshot: null, // the ship's real future, kept while a hypothetical one is shown
    wasPaused: false,
    dir: null, // chosen burn direction (unit vector), once there is one
    frames: 0, // chosen burn length
    center: null, // the impulse (in frames, world axes) under the circle's centre
    dragging: false,
    zoom: 1, // pinch / scroll scale of the map
    pinch: null, // distance between two fingers, while pinching
    lastX: 0,
    lastY: 0,
    waitForRelease: false, // a burn was locked in by a press that is still held
    burnStep: 0
};


let framerateHistory = [];
let dt;
let lastFrameTime;

let frameDT;

let gravLights = false;
let showTrajectory = false;
let showTrajectoryDescription = false;
let showArrows = false;

// when false the moon exists as a massless, invisible body so shared code
// paths still work, but nothing moon-related is drawn
let moonEnabled = true;

// how far ahead trajectories are projected, in frames; 0 means one moon orbit
// (sketches without the moon can afford a longer window for high orbits)
let maxProjectionFrames = 0;

// frames of burn available; sketches may set a finite budget in setup()
let maxFuel = Infinity;

// when true the ship keeps its initial orientation and only the burn is controllable
let orientationLocked = false;



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

        this.initialPos = startingPos.copy();
        this.initialOrientation = p5.Vector.fromAngle(-TAU / 4);

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

    // restore the ship to its construction state (landing spots and histories
    // accumulated during flight would otherwise leak into the next run)
    reset() {
        this.bodyLandedOn = bodies[0];
        this.landingPos = this.initialPos.copy().sub(bodies[0].pos);

        this.posHistory = [this.initialPos.copy()];
        this.velHistory = [createVector(0, 0)];
        this.accHistory = [createVector(0, 0)];
        this.orientationHistory = [this.initialOrientation.copy()];
        this.boostingHistory = [false];

        this.apoapsis = this.initialPos.copy();
        this.periapsis = this.initialPos.copy();
        this.periapsisAlt = false;
        this.apoapsisAlt = false;

        this.trajectoryType = false;
        this.shipOrbitingMoon = false;
        this.shipOrbitingMoonEndOfFirstOrbit = false;
    }

    // frames of burn left at time T, derived from the boost history so that
    // scrubbing the timeline and resetting stay consistent automatically
    getFuelRemaining() {
        if (maxFuel == Infinity) {
            return Infinity;
        }

        let burned = 0;
        let end = min(T, this.boostingHistory.length - 1);
        for (let i = 0; i <= end; i++) {
            if (this.boostingHistory[i]) {
                burned++;
            }
        }

        return max(0, maxFuel - burned);
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

            let fireColor = color(PALETTE.fire);
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

        let windowColor = color(PALETTE.window)
        // if (ghost) {
        //   windowColor.setRed(0)
        // };
        fill(windowColor);
        circle(0, 0, l / 3.5);

        pop();

    }

    // path: positions by frame (this ship's own by default); alpha scales
    // the whole line (Impulse Mode draws the hypothetical path fainter)
    drawTrajectory(path = this.posHistory, orbitingMoon = this.shipOrbitingMoon,
        orbitingMoonEnd = this.shipOrbitingMoonEndOfFirstOrbit, alpha = 255) {

        let lineColor = color(PALETTE.trajectory);
        let frameSkip = 5;
        let len = path.length;

        // only visit the frames that are actually drawn: multiples of
        // frameSkip after T, plus a final partial segment to the end
        let start = (floor(T / frameSkip) + 1) * frameSkip;

        for (let PT = start; PT < len; PT += frameSkip) {

            let next = min(PT + frameSkip, len - 1);
            if (next <= PT) {
                break;
            }

            let posRelativeToMoon = p5.Vector.sub(path[PT], moonOrbit[PT % moonOrbit.length]);
            let drawInHillSphere = posRelativeToMoon.mag() < moonHillSphereRadius ||
                (orbitingMoon && PT < orbitingMoonEnd);

            strokeWeight(3);
            lineColor.setAlpha(alpha);
            stroke(lineColor);

            if (drawInHillSphere) {

                let nextPosRelativeToMoon = p5.Vector.sub(path[next], moonOrbit[next % moonOrbit.length]);

                line(bodies[1].pos.x + posRelativeToMoon.x, bodies[1].pos.y + posRelativeToMoon.y,
                    bodies[1].pos.x + nextPosRelativeToMoon.x, bodies[1].pos.y + nextPosRelativeToMoon.y);

                lineColor.setAlpha(alpha * 50 / 255);
                stroke(lineColor);

            }

            line(path[PT].x, path[PT].y, path[next].x, path[next].y);

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

        } else if (this.trajectoryType == 'Safe Landing' || this.trajectoryType == 'Impact') {

            let title = this.trajectoryType == 'Safe Landing' ?
                "Safe Landing Trajectory" : "Impact Trajectory (Too Fast To Land)";

            text(title + "\n" +
                "Time to impact: " + round(projectionDuration / 100, 1) + " hectoframes\n" +
                "Impact velocity: " + round(this.impactSpeed * 100, 1) + " px/hectoframe",
                pos.x + offset, pos.y - offset);

        } else if (this.trajectoryType == 'Escape') {

            let r = p5.Vector.dist(pos, bodies[0].pos);
            let escapeSpeed = Math.sqrt(2 * G * bodies[0].mass / r);

            text("Escape Trajectory\n" +
                "Speed: " + round(this.velHistory[T].mag() * 100, 1) + " px/hectoframe\n" +
                "Escape velocity here: " + round(escapeSpeed * 100, 1) + " px/hectoframe",
                pos.x + offset, pos.y - offset);

        }

        if (this.shipOrbitingMoon && this.moonPeri) {

            let moonPos = bodies[1].pos;
            let lunarOnly = this.trajectoryType == 'Lunar Orbit';

            text("Lunar Orbit\n" +
                "Period: " + round(this.moonOrbitPeriod / 100, 1) + " hectoframes",
                pos.x + offset + (lunarOnly ? 0 : 150 / camera.scaleFactor), pos.y - offset);

            for (let [label, rel, alt] of [
                ["Periapsis", this.moonPeri, this.moonPeriAlt],
                ["Apoapsis", this.moonApo, this.moonApoAlt]]) {

                let point = p5.Vector.add(moonPos, rel);
                let surface = bodies[1].getSurfaceIntersectForAltitudeLine(point);

                noStroke();
                text(label + ": " + round(alt) + "px", point.x + offset, point.y + offset);

                strokeWeight(1);
                stroke(rocketColor);
                line(surface.x, surface.y, point.x, point.y);

            }

        }
    }

    drawArrows(pos) {

        textFont("menlo");
        textAlign(LEFT, CENTER);

        let moonPos = moonOrbit[T % moonOrbit.length];

        let gravity = bodies[0].getGravitationalAcceleration(pos)
            .add(bodies[1].getGravitationalAcceleration(pos, moonPos));

        let burning = this.boostingHistory[T];
        let thrust = burning ? this.accHistory[T].copy().sub(gravity) : false;

        let net = gravity.copy();
        if (thrust) {
            net.add(thrust);
        }

        if (arrowMode == ARROWS_INWARD) {
            this.drawArrowsInward(pos, gravity, thrust, net);
        } else {
            this.drawArrowsTipToTip(pos, gravity, thrust, net);
        }
    }

    // forces come out from the ship; faint copies of each force extend from
    // the other's tip, completing the parallelogram at the net point, which a
    // dotted line connects to a net force arrow at the tip of the velocity
    // arrow (showing how the net force is about to shift the velocity)
    drawArrowsTipToTip(pos, gravity, thrust, net) {

        let labelOffset = 10;

        let earthR = red(earthColor), earthG = green(earthColor), earthB = blue(earthColor);
        let rocketR = red(rocketColor), rocketG = green(rocketColor), rocketB = blue(rocketColor);

        let gravTip = p5.Vector.add(pos, gravity.copy().mult(accArrowScale));

        drawFatArrow(pos, gravTip, color(earthR, earthG, earthB), 2, 10, 10);
        noStroke();
        fill(earthR, earthG, earthB);
        text("gravity", gravTip.x + labelOffset, gravTip.y);

        let netPoint = p5.Vector.add(pos, net.copy().mult(accArrowScale));

        if (thrust) {

            let thrustTip = p5.Vector.add(pos, thrust.copy().mult(accArrowScale));

            drawFatArrow(pos, thrustTip, paletteColors.thrust, 2, 10, 10);
            noStroke();
            fill(paletteColors.thrust);
            text("thrust", thrustTip.x + labelOffset, thrustTip.y);

            // faint copies completing the parallelogram at the net point
            let faintThrust = color(red(paletteColors.thrust), green(paletteColors.thrust), blue(paletteColors.thrust), 90);
            drawFatArrow(gravTip, netPoint, faintThrust, 2, 10, 10);
            drawFatArrow(thrustTip, netPoint, color(earthR, earthG, earthB, 90), 2, 10, 10);

        }

        // velocity out from the ship
        let velTip = p5.Vector.add(pos, this.velHistory[T].copy().mult(velArrowScale));

        drawFatArrow(pos, velTip, color(rocketR, rocketG, rocketB), 2, 10, 10);
        noStroke();
        fill(rocketR, rocketG, rocketB);
        text("velocity", velTip.x + labelOffset, velTip.y);

        // net force from the tip of the velocity arrow
        let netVelTip = p5.Vector.add(velTip, net.copy().mult(accArrowScale));

        drawFatArrow(velTip, netVelTip, color(255), 3, 13, 13);
        noStroke();
        fill(255);
        text("net force", netVelTip.x + labelOffset, netVelTip.y);

        // dotted connector from the parallelogram's net point to the net
        // force arrow at the velocity tip
        drawingContext.setLineDash([3, 8]);
        stroke(255, 120);
        strokeWeight(2);
        line(netPoint.x, netPoint.y, netVelTip.x, netVelTip.y);
        drawingContext.setLineDash([]);

    }

    // alternate mode: every arrow points in towards the ship with its triangle
    // tip centred on it; the ship body is drawn afterwards, covering the tips
    drawArrowsInward(pos, gravity, thrust, net) {

        let labelOffset = 10;

        let drawInwardArrow = (vector, scale, r, g, b, alphaValue, thickness, headSize, label) => {

            let tail = p5.Vector.sub(pos, vector.copy().mult(scale));
            if (p5.Vector.dist(tail, pos) < 2) {
                return;
            }

            drawFatArrow(tail, pos, color(r, g, b, alphaValue), thickness, headSize, headSize);

            noStroke();
            fill(r, g, b, 230);
            text(label, tail.x + labelOffset, tail.y);
        };

        // net force: thicker and behind the individual forces
        drawInwardArrow(net, accArrowScale, 255, 255, 255, 70, 13, 26, "net force");

        drawInwardArrow(gravity, accArrowScale,
            red(earthColor), green(earthColor), blue(earthColor), 110, 7, 16, "gravity");

        if (thrust) {
            drawInwardArrow(thrust, accArrowScale, 255, 159, 28, 110, 7, 16, "thrust");
        }

        drawInwardArrow(this.velHistory[T], velArrowScale,
            red(rocketColor), green(rocketColor), blue(rocketColor), 110, 7, 16, "velocity");
    }

    draw() {

        let pos = this.posHistory[T];

        if (impulse.phase === 'aiming' && impulse.snapshot) {

            // the real projection stays as it is; what the burn would do
            // is drawn over it, fainter
            let real = impulse.snapshot;
            if (showTrajectory) {
                this.drawTrajectory(real.pos, real.shipOrbitingMoon,
                    real.shipOrbitingMoonEndOfFirstOrbit);
            }
            if (impulse.dir && impulse.frames > 0) {
                this.drawTrajectory(this.posHistory, this.shipOrbitingMoon,
                    this.shipOrbitingMoonEndOfFirstOrbit, showTrajectory ? 110 : 255);
            }

        } else if (showTrajectory) {
            this.drawTrajectory();
        }

        let offset = this.length / 2;

        // the trajectory type only means something once the projected
        // trajectory itself is on screen
        if (showTrajectoryDescription && showTrajectory) {
            this.drawTrajectoryDescription(pos, offset);
        }

        // the inward mode hides its arrow tips behind the ship, so it draws
        // first; the tip-to-tip mode draws over the ship (after it, below)
        if (showArrows && arrowMode == ARROWS_INWARD) {
            this.drawArrows(pos);
        }

        fill('#ffffff');
        noStroke();
        textFont("menlo");
        textAlign(LEFT, TOP);

        text("Alt: " + round(p5.Vector.dist(pos, bodies[closestBody].pos) - bodies[closestBody].radius) + " px", pos.x + offset, pos.y + offset);

        let fuelString;
        if (maxFuel == Infinity) {
            fuelString = "∞";
        } else {
            fuelString = round(100 * this.getFuelRemaining() / maxFuel) + "%";
        }
        fill(rocketColor);
        text("Fuel: " + fuelString, pos.x + offset, pos.y + offset + 18 / camera.scaleFactor);

        // fill("#00ff22ff");

        // offset = 3;
        // text(
        //   "\nVel: " + round(ship.vel.mag() * 100) + " px/hectoframe" + "\nAcc: " + ship.acc.mag(),
        //   velArrowEndpoint.x + offset, velArrowEndpoint.y);


        this.drawShipBody(pos.x, pos.y, 255);

        if (showArrows && arrowMode != ARROWS_INWARD) {
            this.drawArrows(pos);
        }

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
        this.moonPeriAlt = false;
        this.moonApoAlt = false;
        this.moonLapStart = false;
        this.moonOrbitPeriod = false;

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

            if (initialMoonT != false && !this.shipOrbitingMoon && i > 0) {
                // If it has passed a certain length of time and we are more or less back where we started, then we have completed an orbit and can end the projection

                cumulativeAngularChangeAroundMoon += this.angleAboutMoon(i);
                this.trackMoonApsis(i);

                if (abs(cumulativeAngularChangeAroundMoon) >= TAU) {
                    this.shipOrbitingMoon = true;
                    this.shipOrbitingMoonEndOfFirstOrbit = i;
                    this.moonOrbitPeriod = i - this.moonLapStart;

                }
            }



        }


        // start is correct, but it is skipping over the end too

        outer:
        for (let i = this.posHistory.length; (i - T < (maxProjectionFrames || moonOrbit.length)) && !this.projectionEndsInCollision(); i++) {

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

                cumulativeAngularChangeAroundMoon += this.angleAboutMoon(i);
                this.trackMoonApsis(i);

                if (abs(cumulativeAngularChangeAroundMoon) >= TAU) {
                    this.shipOrbitingMoon = true;
                    this.shipOrbitingMoonEndOfFirstOrbit = i;
                    this.moonOrbitPeriod = i - this.moonLapStart;

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

                    let impact = this.velHistory[i].copy();
                    if (b == 1) {
                        impact.sub(moonOrbitVelHistory[i % moonOrbitVelHistory.length]);
                    }
                    this.impactSpeed = impact.mag();
                    this.trajectoryType = this.impactSpeed <= LANDING_SPEED ? 'Safe Landing' : 'Impact';

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

        if (this.shipOrbitingMoon && (this.trajectoryType === false || this.trajectoryType === 'Orbit')) {
            this.trajectoryType = 'Lunar Orbit';
        } else if (this.trajectoryType === false) {
            // unresolved: still unbound about the Earth where the projection ends
            let end = this.posHistory.length - 1;
            let r = p5.Vector.dist(this.posHistory[end], bodies[0].pos);
            let speed = this.velHistory[end].mag();
            if (speed * speed / 2 - G * bodies[0].mass / r >= 0) {
                this.trajectoryType = 'Escape';
            }
        }

    }

    // the angle swept about the Moon between frames i - 1 and i (the Moon
    // having moved, as it does)
    angleAboutMoon(i) {
        let len = moonOrbit.length;
        return p5.Vector.angleBetween(
            this.posHistory[i].copy().sub(moonOrbit[i % len]),
            this.posHistory[i - 1].copy().sub(moonOrbit[(i - 1) % len])
        );
    }

    // closest and furthest points of the lap about the Moon, relative to it
    trackMoonApsis(i) {

        let rel = this.posHistory[i].copy().sub(moonOrbit[i % moonOrbit.length]);
        let alt = rel.mag() - bodies[1].radius;

        if (this.moonLapStart === false) {
            this.moonLapStart = i;
            this.moonPeriAlt = this.moonApoAlt = alt;
            this.moonPeri = this.moonApo = rel;
            return;
        }

        if (alt < this.moonPeriAlt) {
            this.moonPeriAlt = alt;
            this.moonPeri = rel;
        } else if (alt > this.moonApoAlt) {
            this.moonApoAlt = alt;
            this.moonApo = rel;
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

            // the landed ship rides the body: the next frame's position and velocity
            let next = (T + 1) % moonOrbit.length;
            if (this.bodyLandedOn == bodies[1]) {
                this.posHistory.push(this.landingPos.copy().add(moonOrbit[next]));
                this.velHistory.push(moonOrbitVelHistory[next].copy());
            } else {
                this.posHistory.push(this.landingPos.copy().add(this.bodyLandedOn.pos));
                this.velHistory.push(this.velHistory[T].copy());
            }




            this.accHistory.push(createVector(0, 0));
            this.boostingHistory.push(false);
            this.orientationHistory.push(this.orientationHistory[T].copy());

            return;
        }

        let turnVel = TAU / 50;
        let amt = false;

        if (orientationLocked) {

            // section-controlled: the ship keeps its initial orientation

        } else if (controlMode == TOUCH) {

            if (joystickActive) {
                let j = getJoystickGeometry();
                let dir = createVector(mouseX - j.x, mouseY - j.y);

                if (dir.mag() > 0) {
                    // turning is instantaneous: rotate all the way to the pressed direction
                    amt = p5.Vector.angleBetween(this.orientationHistory[T], dir);
                }
            }

        } else if (controlMode == KEYS) {

            if (keyIsDown(LEFT_ARROW)) {
                amt = -turnVel / 1.5;
            } else if (keyIsDown(RIGHT_ARROW)) {
                amt = turnVel / 1.5;
            }

        }

        let boost = boostInputActive();
        if (boost && this.getFuelRemaining() <= 0) {
            boost = false;
        }

        this.projectTrajectory(boost, amt);

    }

    projectionEndsInCollision() {
        return this.trajectoryType == 'Safe Landing' || this.trajectoryType == 'Impact';
    }

    // everything projected from T on (and the state at T that a burn changes)
    snapshotFuture() {

        let snap = {
            pos: this.posHistory.slice(),
            vel: this.velHistory.slice(),
            acc: this.accHistory.slice(),
            boosting: this.boostingHistory.slice(),
            orientation: this.orientationHistory.slice(),
            trajectoryType: this.trajectoryType,
            impactSpeed: this.impactSpeed,
            periapsis: this.periapsis.copy(),
            periapsisAlt: this.periapsisAlt,
            apoapsis: this.apoapsis.copy(),
            apoapsisAlt: this.apoapsisAlt,
            shipOrbitingMoon: this.shipOrbitingMoon,
            shipOrbitingMoonEndOfFirstOrbit: this.shipOrbitingMoonEndOfFirstOrbit,
            moon: {
                periAlt: this.moonPeriAlt, apoAlt: this.moonApoAlt,
                peri: this.moonPeri && this.moonPeri.copy(), apo: this.moonApo && this.moonApo.copy(),
                lapStart: this.moonLapStart, period: this.moonOrbitPeriod
            }
        };

        // T is edited in place by a burn; later frames are rebuilt
        for (let key of ['pos', 'vel', 'acc', 'orientation']) {
            snap[key][T] = snap[key][T].copy();
        }

        return snap;

    }

    restoreFuture(snap) {

        this.posHistory = snap.pos.slice();
        this.velHistory = snap.vel.slice();
        this.accHistory = snap.acc.slice();
        this.boostingHistory = snap.boosting.slice();
        this.orientationHistory = snap.orientation.slice();

        this.posHistory[T] = snap.pos[T].copy();
        this.velHistory[T] = snap.vel[T].copy();
        this.accHistory[T] = snap.acc[T].copy();
        this.orientationHistory[T] = snap.orientation[T].copy();

        this.trajectoryType = snap.trajectoryType;
        this.impactSpeed = snap.impactSpeed;
        this.periapsis = snap.periapsis.copy();
        this.periapsisAlt = snap.periapsisAlt;
        this.apoapsis = snap.apoapsis.copy();
        this.apoapsisAlt = snap.apoapsisAlt;
        this.shipOrbitingMoon = snap.shipOrbitingMoon;
        this.shipOrbitingMoonEndOfFirstOrbit = snap.shipOrbitingMoonEndOfFirstOrbit;
        this.moonPeriAlt = snap.moon.periAlt;
        this.moonApoAlt = snap.moon.apoAlt;
        this.moonPeri = snap.moon.peri && snap.moon.peri.copy();
        this.moonApo = snap.moon.apo && snap.moon.apo.copy();
        this.moonLapStart = snap.moon.lapStart;
        this.moonOrbitPeriod = snap.moon.period;

    }

    // Re-plan the burn at T: the whole burn compressed into the step into T
    // (burnFrames of thrust at once), re-projected. Safe to repeat as the
    // aim changes, since the step is always redone from the previous frame.
    applyImpulse(dir, burnFrames) {

        this.orientationHistory[T] = dir.copy();
        this.projectTrajectory(this.getFuelRemaining() > 0, 0, burnFrames);

    }

}

// rocket thrust sound: procedural brown noise, faded in while burning
// (requires p5.sound; pages without the library are silently skipped)
let thrustNoise = null;

function updateThrustSound(active) {

    if (typeof p5.Noise === 'undefined') return;

    if (!thrustNoise) {
        if (!active) return;
        thrustNoise = new p5.Noise('brown');
        thrustNoise.amp(0);
        thrustNoise.start();
    }

    thrustNoise.amp(active ? 0.25 : 0, 0.12);
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

// thick shaft with a filled triangular head whose tip sits exactly at p2
function drawFatArrow(p1, p2, arrowColor, thickness, headLength, headWidth) {

    let dir = p5.Vector.sub(p2, p1);
    let len = dir.mag();
    if (len < 0.5) {
        return;
    }
    dir.div(len);

    let effHead = min(headLength, len);
    let base = p5.Vector.sub(p2, dir.copy().mult(effHead));
    let perp = createVector(-dir.y, dir.x).mult(headWidth / 2);

    if (len > effHead) {
        stroke(arrowColor);
        strokeWeight(thickness);
        line(p1.x, p1.y, base.x, base.y);
    }

    noStroke();
    fill(arrowColor);
    triangle(p2.x, p2.y,
        base.x + perp.x, base.y + perp.y,
        base.x - perp.x, base.y - perp.y);

}

class Body {

    constructor(pos, radius, mass, kind) {
        this.pos = pos;
        this.radius = radius;
        this.kind = kind;
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

        fill(bodyColor(this.kind));
        noStroke();
        circle(this.pos.x, this.pos.y, this.radius * 2);

    }

}

class Camera {

    constructor() {

        this.centredObject = bodies[0];
        this.scaleFactor = 1;

    }

    // the visible area excludes the timeline strip at the bottom
    visibleBottom() {
        return timelineEnabled ? getTimelineTop() : height;
    }

    visibleCenterY() {
        return this.visibleBottom() / 2;
    }

    // Centred on the Earth, zoomed out just far enough that the ship sits
    // inside the visible area inset by a uniform margin. When the moon is in
    // the simulation its whole orbit must also fit within the visible area
    // itself, which fixes a zoom limit that doesn't depend on where the moon
    // currently is (so its motion never changes the zoom).
    updateScaleFactor() {

        let margin = height / 10;
        let centre = this.centredObject.pos;
        let scaleFactor = 1;

        let halfW = width / 2 - margin;
        let halfH = this.visibleCenterY() - margin;
        let shipPos = ship.posHistory[T];
        let dx = abs(shipPos.x - centre.x) + ship.length / 2;
        let dy = abs(shipPos.y - centre.y) + ship.length / 2;
        scaleFactor = min(scaleFactor, halfW / dx, halfH / dy);

        if (moonEnabled) {
            let reach = this.moonOrbitReach() + 4;
            scaleFactor = min(scaleFactor,
                (width / 2) / reach, this.visibleCenterY() / reach);
        }

        this.scaleFactor = scaleFactor;

    }

    // furthest the moon's disc gets from the centre over its whole orbit
    moonOrbitReach() {

        if (this.moonReach === undefined || this.moonReachFor !== moonOrbit.length) {
            let far = 0;
            for (let pos of moonOrbit) {
                far = max(far, p5.Vector.dist(pos, this.centredObject.pos));
            }
            this.moonReach = far + bodies[1].radius;
            this.moonReachFor = moonOrbit.length;
        }

        return this.moonReach;

    }

    applyToMatrix() {

        this.updateScaleFactor();

        push();
        translate(width / 2, this.visibleCenterY());

        scale(this.scaleFactor);

        translate(-this.centredObject.pos.x, -this.centredObject.pos.y);

    }

    worldToScreen(x, y) {

        x = (x - this.centredObject.pos.x) * this.scaleFactor + width / 2;
        y = (y - this.centredObject.pos.y) * this.scaleFactor + this.visibleCenterY();

        return { x: x, y: y };

    }

    screenToWorld(x, y) {

        x = (x - width / 2) / this.scaleFactor + this.centredObject.pos.x;
        y = (y - this.visibleCenterY()) / this.scaleFactor + this.centredObject.pos.y;

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

// The wheel no longer scrubs time; inside the impulse circle it zooms the map
function mouseWheel(event) {

    if (impulse.phase === 'aiming') {
        let j = getJoystickGeometry();
        if (dist(mouseX, mouseY, j.x, j.y) <= j.r) {
            zoomImpulseMap(exp(-event.delta * 0.002));
            return false;
        }
    }
    return false;
}

function isTouchDevice() {
    return ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
}

function getTimelineTop() {
    return height - height / 10;
}

function pointerOverTimeline(x = mouseX, y = mouseY) {
    return timelineEnabled && y >= getTimelineTop();
}

// The control ring sits at the bottom of the screen: horizontally centred on
// touch screens, off to the right on desktop.
// (The essay page places its Next control at the ring's top-right corner
// from the same numbers; keep positionNextBtn() in index.html in step.)
function getJoystickGeometry() {
    let r = min(width, height) / 5.5;

    let bottomLimit = (timelineEnabled ? getTimelineTop() : height);

    // on desktop, leave room beside the ring for the Next control at its corner
    let x = isTouchDevice() ? width / 2 : width - r * 1.4 - 12;
    let y = bottomLimit - r - 12;

    // the reset button is a triangle fitted to the bottom-left corner of
    // the ring's bounding box, sized so it doesn't overlap the ring (max leg
    // length is r * (2 - sqrt(2)))
    let cornerSize = r * 0.55;

    return {
        x: x,
        y: y,
        r: r,
        inner: controlIsDonut() ? r * 0.6 : 0, // the hole holding the ship diagram
        cornerSize: cornerSize,
        resetX: x - r,
        resetY: y + r
    };
}

// the control is a ring around the ship until Impulse Mode takes over, when
// it becomes a whole circle (a map of impulses) and the ship goes away
function controlIsDonut() {
    return impulse.phase !== 'aiming';
}

// presses that count as using the control (the hole is inert)
function pointInControl(px, py) {
    let j = getJoystickGeometry();
    let d = dist(px, py, j.x, j.y);
    return d <= j.r && d >= j.inner;
}


// pointer input that should drive the rocket (never timeline presses)
function rocketPointerActive() {
    if (timelineScrub.active || impulse.waitForRelease) {
        return false;
    }

    return joystickActive;
}

function boostInputActive() {
    return keyIsDown(UP_ARROW) || rocketPointerActive();
}

//
// Impulse Mode
//

// in flight and clear of the ground (lift-off still needs held thrust), or
// resting on the Moon, where the only way off is an impulse
function impulseInFlight() {

    if (crashedOut) return false;

    if (!launched) {
        if (!moonEnabled || ship.bodyLandedOn !== bodies[1]) return false;
        let moon = bodies[1];
        return p5.Vector.dist(ship.posHistory[T], moon.pos) - moon.radius < ship.length;
    }

    let body = bodies[0];
    return p5.Vector.dist(ship.posHistory[T], body.pos) - body.radius > ship.length * 2;

}

function impulseCanStart() {
    return impulse.available && impulse.phase === 'off' && impulseInFlight();
}

function enterImpulse() {

    if (!impulseCanStart()) return false;

    impulse.wasPaused = paused;
    paused = true;
    framesToSkip = 0; // the frame already queued would move T past the snapshot
    impulse.snapshot = ship.snapshotFuture();
    impulse.phase = 'aiming';
    impulse.dir = null;
    impulse.frames = 0;
    impulse.center = createVector(0, 0);
    impulse.dragging = false;
    impulse.pinch = null;
    impulse.zoom = 1;
    impulse.map = null;
    return true;

}

// pausing and Impulse Mode are one idea: where Impulse Mode is available,
// pausing enters it (and resuming leaves it); otherwise this is a plain pause
function togglePause() {

    if (crashedOut || impulse.phase === 'burning') return;

    if (impulse.phase === 'aiming') {
        cancelImpulse(true);
    } else if (paused) {
        paused = false;
    } else if (!enterImpulse()) {
        paused = true;
    }

}

// abandon the aimed burn, putting the real projection back (resume: also
// hand time back, as when the reader exits; scrubbing keeps it paused)
function cancelImpulse(resume = false) {

    if (impulse.phase !== 'aiming') return;

    if (impulse.snapshot) {
        ship.restoreFuture(impulse.snapshot);
    }
    impulse.snapshot = null;
    impulse.phase = 'off';
    impulse.dir = null;
    impulse.frames = 0;
    impulse.center = null;
    impulse.dragging = false;
    impulse.pinch = null;

    if (resume) {
        paused = impulse.wasPaused;
    }

}

function lockImpulse() {

    if (impulse.phase !== 'aiming' || !impulse.dir || impulse.frames < 1) return false;

    let dir = impulse.dir.copy();
    let frames = impulse.frames;

    // the burn plays from the real projection
    ship.restoreFuture(impulse.snapshot);
    impulse.snapshot = null;

    impulse.dir = dir;
    impulse.frames = frames;
    impulse.burnStep = 0;
    impulse.phase = 'burning';
    impulse.dragging = false;
    impulse.waitForRelease = mouseIsPressed;
    launched = true; // a burn from the Moon's surface is the lift-off
    return true;

}

// the selected impulse is the one under the circle's centre
function aimImpulse() {

    let c = impulse.center;

    if (!c || c.mag() < 0.5) {
        impulse.dir = null;
        impulse.frames = 0;
        return;
    }

    impulse.dir = c.copy().normalize();
    impulse.frames = round(c.mag());

}

// dragging slides the map under the circle's centre, so what was under the
// pointer stays under it
function dragImpulseMap() {

    let j = getJoystickGeometry();
    let k = impulseReach() / j.r;

    impulse.center.x -= (mouseX - impulse.lastX) * k;
    impulse.center.y -= (mouseY - impulse.lastY) * k;
    impulse.lastX = mouseX;
    impulse.lastY = mouseY;

}

function startDraggingImpulseMap() {
    impulse.dragging = true;
    impulse.lastX = mouseX;
    impulse.lastY = mouseY;
}

// Outcome cells are [r, g, b, kind, ln(Moon apoapsis / Moon radius) when about
// the Moon, ln(Earth apoapsis / Earth radius) or null for "work it out from
// the orbit", plain class]. The plain class tells safe landings from impacts,
// on the Earth from the Moon. Contour levels are derived from the logs.
function impactOutcome(color, speed, onMoon) {
    let safe = speed <= LANDING_SPEED;
    let shade = safe ? 1 : 0.28;
    return [color[0] * shade, color[1] * shade, color[2] * shade, OUTCOME_PLAIN, 0, null,
        (onMoon ? 2 : 0) + (safe ? 1 : 0)];
}

// Orbits are a flat fill (the ship's hue about the Earth, tinted towards the
// Moon's about the Moon); an unbound path about the Earth is an escape. About
// the Moon the level is the Moon apoapsis contour; about the Earth, apo is the
// apoapsis actually flown (null: use the osculating one, as the orbit was
// never completed).
function orbitOutcome(palette, aboutMoon, apo, bodyRadius) {

    let s = palette.ship, m = palette.moon;

    if (aboutMoon) {
        let log = Math.log(max(apo, bodyRadius) / bodyRadius);
        return [s[0] * 0.25 + m[0] * 0.2, s[1] * 0.25 + m[1] * 0.2, s[2] * 0.25 + m[2] * 0.2,
            OUTCOME_MOON_ORBIT, log, null, 0];
    }
    if (apo === Infinity) {
        return [14, 14, 40, OUTCOME_ESCAPE, 0, Infinity, 0];
    }
    let log = apo === null ? null : Math.log(max(apo, bodyRadius) / bodyRadius);
    return [s[0] * 0.4, s[1] * 0.4, s[2] * 0.4, OUTCOME_EARTH_ORBIT, 0, log, 0];

}

// ln(apoapsis / Earth radius) of the orbit the ship would be on about the
// Earth alone after the impulse (Infinity if unbound), clamped to the surface
function earthApoapsisLog(pos, vel, dv) {

    let earth = bodies[0];
    let mu = G * earth.mass;
    let rx = pos.x - earth.pos.x, ry = pos.y - earth.pos.y;
    let wx = vel.x + dv.x, wy = vel.y + dv.y;
    let r = Math.hypot(rx, ry);
    let energy = (wx * wx + wy * wy) / 2 - mu / r;
    if (energy >= 0) return Infinity;

    let h = rx * wy - ry * wx;
    let a = -mu / (2 * energy);
    let ecc = Math.sqrt(max(0, 1 + 2 * energy * h * h / (mu * mu)));
    return Math.log(max(a * (1 + ecc), earth.radius) / earth.radius);

}

// Where would the ship be headed after an impulse, as an outcome cell:
//   safe landing      the body's colour
//   impact            a darker version of the body's colour
//   orbit             about the Earth or about the Moon
//   escape            unbound from the Earth
// Without the Moon this is a two-body estimate about the Earth; with it, the
// burn is flown through the same Earth + Moon dynamics as the projection, and
// the Earth apoapsis is the one reached on that flight (for an orbit lap).
// Paths that don't complete an orbit (impacts, wide orbits) use the osculating
// apoapsis about the Earth.
function impulseOutcome(pos, vel, dv, palette) {
    let out = moonEnabled ? impulseTrajectoryOutcome(pos, vel, dv, palette) :
        impulseKeplerOutcome(pos, vel, dv, palette);
    if (out[5] === null) out[5] = earthApoapsisLog(pos, vel, dv);
    return out;
}

function impulseKeplerOutcome(pos, vel, dv, palette) {

    let px = pos.x, py = pos.y;
    let vx = vel.x + dv.x, vy = vel.y + dv.y;

    let body = bodies[0];
    let bx = body.pos.x, by = body.pos.y;

    let rx = px - bx, ry = py - by;
    let wx = vx, wy = vy;
    let r = Math.hypot(rx, ry);
    let mu = G * body.mass;
    let energy = (wx * wx + wy * wy) / 2 - mu / r;
    let h = rx * wy - ry * wx;
    let ecc = Math.sqrt(max(0, 1 + 2 * energy * h * h / (mu * mu)));

    let peri, apo;
    if (energy < 0) {
        let a = -mu / (2 * energy);
        peri = a * (1 - ecc);
        apo = a * (1 + ecc);
    } else {
        let a = mu / (2 * max(energy, 1e-9));
        peri = a * (ecc - 1);
        apo = Infinity;
    }

    let approaching = energy < 0 || (rx * wx + ry * wy) < 0;
    if (peri < body.radius && approaching) {
        return impactOutcome(palette.earth, Math.sqrt(max(0, 2 * (energy + mu / body.radius))));
    }

    return orbitOutcome(palette, false, apo, body.radius);

}

// the radial band the Moon sweeps through, with its radius as margin
let moonBand = null;

function moonDistanceBand() {
    if (!moonBand || moonBand.len !== moonOrbit.length) {
        let lo = Infinity, hi = 0;
        for (let i = 0; i < moonOrbit.length; i += 20) {
            let d = dist(moonOrbit[i].x, moonOrbit[i].y, bodies[0].pos.x, bodies[0].pos.y);
            lo = min(lo, d);
            hi = max(hi, d);
        }
        moonBand = { len: moonOrbit.length, lo: lo - bodies[1].radius, hi: hi + bodies[1].radius };
    }
    return moonBand;
}

// Fly the burn through the same Earth + Moon dynamics as the trajectory
// projection and classify where it ends up, with the same rules: a landing or
// impact within half a ship length of a surface, a lap of the Earth (orbit
// about the Earth) or a lap of the Moon while inside its hill sphere (orbit
// about the Moon), whichever comes first. Escapes and anything that doesn't
// resolve within the projection horizon count as unbound.
function impulseTrajectoryOutcome(pos, vel, dv, palette) {

    let earth = bodies[0], moonBody = bodies[1];
    let muE = G * earth.mass, muM = G * moonBody.mass;
    let ex = earth.pos.x, ey = earth.pos.y;
    let len = moonOrbit.length;
    let horizon = Math.min(maxProjectionFrames || len, IMPULSE_MAP_HORIZON);
    let escapeR = moonDistanceBand().hi * 3;
    let escapeR2 = escapeR * escapeR;
    let hill2 = moonHillSphereRadius * moonHillSphereRadius;
    let earthHit = sq(earth.radius + ship.length / 2);
    let moonHit = sq(moonBody.radius + ship.length / 2);

    let x = pos.x, y = pos.y;
    let vx = vel.x + dv.x, vy = vel.y + dv.y;

    let prevEarthAngle = Math.atan2(y - ey, x - ex);
    let sweptEarth = 0;
    let r0 = Math.hypot(x - ex, y - ey);
    let maxEarthR = r0;

    let inHill = false;
    let prevMoonAngle = 0;
    let sweptMoon = 0;
    let maxMoonR = 0;

    for (let i = T + 1; i <= T + horizon; i++) {

        let m = moonOrbit[i % len];

        let rx = ex - x, ry = ey - y;
        let r2 = rx * rx + ry * ry;
        let f = muE / (r2 * Math.sqrt(r2));
        let ax = rx * f, ay = ry * f;

        let mx = m.x - x, my = m.y - y;
        let d2 = mx * mx + my * my;
        f = muM / (d2 * Math.sqrt(d2));
        ax += mx * f;
        ay += my * f;

        vx += ax; vy += ay;
        x += vx; y += vy;

        mx = x - m.x; my = y - m.y;
        d2 = mx * mx + my * my;
        if (d2 < moonHit) {
            let mv = moonOrbitVelHistory[i % len];
            return impactOutcome(palette.moon, Math.hypot(vx - mv.x, vy - mv.y), true);
        }

        rx = x - ex; ry = y - ey;
        r2 = rx * rx + ry * ry;
        if (r2 < earthHit) return impactOutcome(palette.earth, Math.hypot(vx, vy));
        if (r2 > escapeR2) break;

        let r = Math.sqrt(r2);
        if (r > maxEarthR) maxEarthR = r;

        let a = Math.atan2(ry, rx);
        let da = Math.abs(a - prevEarthAngle);
        sweptEarth += da > Math.PI ? TAU - da : da;
        prevEarthAngle = a;
        if (sweptEarth > TAU) return orbitOutcome(palette, false, maxEarthR, earth.radius);

        if (d2 < hill2) {

            let moonAngle = Math.atan2(my, mx);
            let d = Math.sqrt(d2);

            if (!inHill) {
                inHill = true;
                sweptMoon = 0;
                maxMoonR = d;
            } else {
                da = Math.abs(moonAngle - prevMoonAngle);
                sweptMoon += da > Math.PI ? TAU - da : da;
                if (d > maxMoonR) maxMoonR = d;
            }
            prevMoonAngle = moonAngle;

            if (sweptMoon >= TAU) return orbitOutcome(palette, true, maxMoonR, moonBody.radius);

        } else {
            inHill = false;
        }
    }

    // unresolved: unbound from the Earth, or a wide orbit still on its first lap
    let energy = (vx * vx + vy * vy) / 2 - muE / Math.hypot(x - ex, y - ey);
    return orbitOutcome(palette, false, energy >= 0 ? Infinity : null, earth.radius);

}

// A new map of impulses for the ship's state at T: pos and vel are its
// position and velocity, n the lattice points across the circle, and reach the
// impulse (in frames of burn) from the circle's centre to its edge.
function makeImpulseMap(pos, vel, n, reach) {

    let colour = c => [red(c), green(c), blue(c)];

    return {
        n: n,
        coarse: max(2, n / 20), // the lattice step of the first pass
        spacing: 2 * reach / n,
        cells: new Map(),
        pos: pos.copy(),
        vel: vel.copy(),
        palette: {
            ship: colour(rocketColor),
            earth: colour(color(bodyColor('earth'))),
            moon: colour(color(bodyColor('moon')))
        },
        curLog: earthApoapsisLog(pos, vel, { x: 0, y: 0 }),
        canvas: document.createElement('canvas'),
        window: null,
        doneFor: ''
    };

}

function latticeKey(ix, iy) {
    return (ix + 32768) * 65536 + (iy + 32768);
}

// two outcomes that need no refining between them: the same kind of outcome
// (contours are found by interpolating the apoapsis between the points)
function sameOutcome(a, b) {
    return a[3] === b[3] && (a[3] !== OUTCOME_PLAIN || a[6] === b[6]);
}

// Computes, within budgetMs, the points of the map that are missing around the
// impulse at the (frames-of-burn) centre; true once nothing is left to do.
function fillImpulseMap(map, centre, budgetMs) {

    let spacing = map.spacing;
    let cx = centre.x / spacing, cy = centre.y / spacing;
    let half = map.n / 2;
    let size = map.n + 3;
    let ix0 = Math.floor(cx - half) - 1, iy0 = Math.floor(cy - half) - 1;
    map.window = { ix0: ix0, iy0: iy0, nx: size, ny: size, spacing: spacing };

    let windowKey = ix0 + ',' + iy0;
    if (map.doneFor === windowKey) return true;

    let deadline = performance.now() + budgetMs;
    let dv = { x: 0, y: 0 };
    let cells = map.cells;
    let out = false;

    let compute = (ix, iy) => {
        let k = latticeKey(ix, iy);
        if (!cells.has(k)) {
            dv.x = ix * spacing * ship.rocketAcc;
            dv.y = iy * spacing * ship.rocketAcc;
            cells.set(k, impulseOutcome(map.pos, map.vel, dv, map.palette));
        }
    };

    // first pass: a coarse lattice reaching past the circle, so that every
    // block touching it has its corners
    let step = map.coarse;
    let reachSq = sq(half + step * 2);
    for (let iy = Math.floor(iy0 / step) * step; iy < iy0 + size + step; iy += step) {
        for (let ix = Math.floor(ix0 / step) * step; ix < ix0 + size + step; ix += step) {
            if (sq(ix - cx) + sq(iy - cy) > reachSq || cells.has(latticeKey(ix, iy))) continue;
            if (performance.now() > deadline) return false;
            compute(ix, iy);
        }
    }

    // then halve the blocks that aren't uniform, down to single points
    for (let s = step / 2; s >= 1; s /= 2) {

        let S = s * 2;
        let blockSq = sq(half + S);

        for (let by = Math.floor(iy0 / S) * S; by < iy0 + size; by += S) {
            for (let bx = Math.floor(ix0 / S) * S; bx < ix0 + size; bx += S) {

                if (sq(bx + s - cx) + sq(by + s - cy) > blockSq) continue;

                let a = cells.get(latticeKey(bx, by)), b = cells.get(latticeKey(bx + S, by));
                let c = cells.get(latticeKey(bx, by + S)), d = cells.get(latticeKey(bx + S, by + S));
                if (!a || !b || !c || !d) continue; // inside a block already found uniform

                if (sameOutcome(a, b) && sameOutcome(a, c) && sameOutcome(a, d)) continue;

                for (let [ix, iy] of [[bx + s, by], [bx, by + s], [bx + S, by + s], [bx + s, by + S], [bx + s, by + s]]) {
                    if (cells.has(latticeKey(ix, iy))) continue;
                    if (performance.now() > deadline) return false;
                    compute(ix, iy);
                }
            }
        }
    }

    map.doneFor = windowKey;
    map.version = (map.version || 0) + 1;
    return true;

}

// the paused map, around the selected impulse
function updateImpulseMap() {

    let key = impulse.zoom.toFixed(4) + ',' + T;
    let map = impulse.map;

    if (!map || map.key !== key) {
        let snap = impulse.snapshot;
        map = impulse.map = makeImpulseMap(snap.pos[T], snap.vel[T], IMPULSE_MAP_CELLS, impulseReach());
        map.key = key;
    }

    fillImpulseMap(map, impulse.center, IMPULSE_MAP_BUDGET_MS);
    return map;

}

// Where Impulse Mode can be entered, a live map sits beneath the control, for
// the impulses available now. It is rebuilt in the background a slice per frame
// and swapped in when complete, so it trails the ship by a few frames.
function liveImpulseVisible() {
    return impulse.available && impulse.phase === 'off' && (impulse.mapAlways || impulseInFlight());
}

function updateLiveImpulseMap() {

    let live = impulse.live;
    if (!live) live = impulse.live = { shown: null, build: null };

    let zoomKey = impulse.zoom.toFixed(4);

    if (!live.build) {
        // a still ship (paused) needs no new map
        if (live.shown && live.shown.key === zoomKey + ',' + T) return live.shown;
        live.build = makeImpulseMap(ship.posHistory[T], ship.velHistory[T], IMPULSE_LIVE_CELLS, impulseReach());
        live.build.key = zoomKey + ',' + T;
    }

    if (fillImpulseMap(live.build, { x: 0, y: 0 }, IMPULSE_LIVE_BUDGET_MS)) {
        live.shown = live.build;
        live.build = null;
    }
    return live.shown;

}

// the cell at a lattice point; where none was computed, one made from the
// corners of the smallest computed block around it (the nearest corner's
// outcome, with the apoapsis interpolated)
function latticeCell(map, ix, iy) {

    let c = map.cells.get(latticeKey(ix, iy));
    if (c) return c;

    for (let step = 2; step <= map.coarse; step *= 2) {

        let x0 = Math.floor(ix / step) * step, y0 = Math.floor(iy / step) * step;
        let a = map.cells.get(latticeKey(x0, y0)), b = map.cells.get(latticeKey(x0 + step, y0));
        let d = map.cells.get(latticeKey(x0, y0 + step)), e = map.cells.get(latticeKey(x0 + step, y0 + step));
        if (!a || !b || !d || !e) continue;

        let fx = (ix - x0) / step, fy = (iy - y0) / step;
        let near = fy < 0.5 ? (fx < 0.5 ? a : b) : (fx < 0.5 ? d : e);
        let apo = near[5], moonApo = near[4];
        if (isFinite(a[5] + b[5] + d[5] + e[5])) {
            apo = (a[5] * (1 - fx) + b[5] * fx) * (1 - fy) + (d[5] * (1 - fx) + e[5] * fx) * fy;
        }
        if (a[3] === OUTCOME_MOON_ORBIT && b[3] === a[3] && d[3] === a[3] && e[3] === a[3]) {
            moonApo = (a[4] * (1 - fx) + b[4] * fx) * (1 - fy) + (d[4] * (1 - fx) + e[4] * fx) * fy;
        }
        return [near[0], near[1], near[2], near[3], moonApo, apo, near[6]];

    }
    return null;

}

function earthApoapsisLevel(c) {
    return c[5] === Infinity ? 9999 : min(floor(c[5] / APO_LEVEL_STEP), APO_LEVEL_CAP);
}

function moonApoapsisLevel(c) {
    return floor(c[4] / APO_LEVEL_STEP);
}

// The window of cells to pixels, with contours:
//   white      Earth apoapsis, everywhere but where orbiting the Moon
//   pale gold  Moon apoapsis, where orbiting the Moon
//   pink       the boundary between orbiting the Earth and the Moon
//   green and orange: the apoapsis of the current (no impulse) and selected
//              impulse, wherever that value is crossed
function renderImpulseMap(map, win, curLog, selLog) {

    let canvas = map.canvas;
    if (canvas.width !== win.nx || canvas.height !== win.ny) {
        canvas.width = win.nx;
        canvas.height = win.ny;
    }
    let ctx = canvas.getContext('2d');
    let image = ctx.createImageData(win.nx, win.ny);
    let data = image.data;

    let grid = new Array(win.nx * win.ny);
    for (let j = 0; j < win.ny; j++) {
        for (let i = 0; i < win.nx; i++) {
            grid[j * win.nx + i] = latticeCell(map, win.ix0 + i, win.iy0 + j);
        }
    }

    let crosses = (a, b, t) => isFinite(t) && (a - t) * (b - t) < 0;

    // the colour of the boundary line between a cell and one neighbour, or null
    let edge = (c, o) => {
        if (!o) return null;
        let moonC = c[3] === OUTCOME_MOON_ORBIT, moonO = o[3] === OUTCOME_MOON_ORBIT;
        if (moonC !== moonO && (c[3] === OUTCOME_EARTH_ORBIT || o[3] === OUTCOME_EARTH_ORBIT)) {
            return [255, 90, 200, 1];
        }
        if (crosses(c[5], o[5], selLog) && !moonC && !moonO) return [255, 160, 40, 1];
        if (crosses(c[5], o[5], curLog) && !moonC && !moonO) return [90, 255, 120, 1];
        if (moonC && moonO) {
            return moonApoapsisLevel(c) !== moonApoapsisLevel(o) ? [255, 240, 170, 0.6] : null;
        }
        if (!moonC && !moonO && earthApoapsisLevel(c) !== earthApoapsisLevel(o)) {
            return [255, 255, 255, 0.55];
        }
        return null;
    };

    for (let j = 0; j < win.ny; j++) {
        for (let i = 0; i < win.nx; i++) {

            let c = grid[j * win.nx + i];
            let p = (j * win.nx + i) * 4;
            if (!c) {
                data[p] = data[p + 1] = data[p + 2] = 10;
                data[p + 3] = 255;
                continue;
            }

            let r = c[0], g = c[1], b = c[2];

            let line = edge(c, i + 1 < win.nx ? grid[j * win.nx + i + 1] : null);
            let down = edge(c, j + 1 < win.ny ? grid[(j + 1) * win.nx + i] : null);
            if (down && (!line || down[3] === 1)) line = down;

            if (line) {
                let a = line[3];
                r = r * (1 - a) + line[0] * a;
                g = g * (1 - a) + line[1] * a;
                b = b * (1 - a) + line[2] * a;
            }

            data[p] = r;
            data[p + 1] = g;
            data[p + 2] = b;
            data[p + 3] = 255;
        }
    }

    ctx.putImageData(image, 0, 0);
    return canvas;

}

// once per paused frame: preview the aim, or play the locked burn
function updateImpulseMode() {

    if (impulse.phase === 'aiming') {

        aimImpulse();

        if (impulse.dir && impulse.frames > 0) {
            ship.applyImpulse(impulse.dir, impulse.frames);
        } else {
            ship.restoreFuture(impulse.snapshot);
        }
        // the hypothetical burn isn't happening yet: no flame, no thrust sound
        ship.boostingHistory[T] = false;

    } else if (impulse.phase === 'burning') {

        impulse.burnStep++;
        ship.applyImpulse(impulse.dir, impulse.frames * impulse.burnStep / impulse.frames);

        if (typeof window.onImpulseBurnFrame === 'function') {
            window.onImpulseBurnFrame();
        }

        if (impulse.burnStep >= impulse.frames) {
            impulse.phase = 'off';
            paused = false;
            if (typeof window.onImpulseBurnEnd === 'function') {
                window.onImpulseBurnEnd();
            }
            T++;
        }

    }

}

// the Burn and Resume buttons stack to the left of the circle
function getImpulseButtons() {

    let j = getJoystickGeometry();
    let bw = max(60, min(130, j.x - j.r - 24));
    let bh = 40;
    let x = j.x - j.r - 12 - bw;

    return {
        burn: { x: x, y: j.y - bh - 5, w: bw, h: bh },
        cancel: { x: x, y: j.y + 5, w: bw, h: bh }
    };

}

function pointInRect(x, y, r) {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

// presses while aiming; true if the press was used
function handleImpulsePress() {

    let b = getImpulseButtons();
    if (pointInRect(mouseX, mouseY, b.cancel)) {
        cancelImpulse(true);
        return true;
    }
    if (pointInRect(mouseX, mouseY, b.burn)) {
        lockImpulse();
        return true;
    }

    if (pointInControl(mouseX, mouseY)) {
        startDraggingImpulseMap();
        return true;
    }

    return false;

}

function timelineScrubActive() {
    return timelineScrub.active;
}

// drag the timeline like scrubbing in video software:
// dragging right moves the strip right, i.e. backwards in time
function scrubTimelineBy(dxPixels) {

    timelineScrub.accum += -dxPixels * TIMELINE_FRAMES_PER_PIXEL;

    let frames = Math.trunc(timelineScrub.accum);
    if (frames == 0) {
        return;
    }
    timelineScrub.accum -= frames;

    if (frames > 0) {
        if (launched && !crashedOut) {
            framesToSkip += frames;
        }
    } else {
        framesToSkip += frames;
        crashedOut = false;
    }
}

function resetSimulation() {
    T = 0;
    launched = false;
    crashedOut = false;
    paused = false;
    impulse.phase = 'off';
    impulse.snapshot = null;
    impulse.dir = null;
    impulse.center = null;
    impulse.dragging = false;
    impulse.waitForRelease = false;
    impulse.live = null;
    ship.reset();
}

function mousePressed() {

    // browsers require a user gesture before audio can start
    if (typeof userStartAudio === 'function') {
        userStartAudio();
    }

    if (pointerOverTimeline()) {
        timelineScrub.active = true;
        timelineScrub.lastX = mouseX;
        timelineScrub.accum = 0;
        timelineScrub.moved = 0;
        cancelImpulse();
        return false;
    }

    if (impulse.phase === 'burning') {
        return false;
    }

    let j = getJoystickGeometry();
    let dCenter = dist(mouseX, mouseY, j.x, j.y);

    if (dCenter > j.r) {
        if (dist(mouseX, mouseY, j.resetX, j.resetY) <= j.cornerSize) {
            resetSimulation();
            return false;
        }
    }

    if (impulse.phase === 'aiming') {
        handleImpulsePress();
        return false;
    }

    // the hole in the ring is the pause control: where Impulse Mode is
    // available, pausing enters it, and the same press can already start
    // sliding the map
    if (dCenter < j.inner) {
        let wasPaused = paused;
        togglePause();
        if (impulse.phase === 'aiming' && !wasPaused) {
            startDraggingImpulseMap();
        }
        return false;
    }

    // presses on the ring boost; anywhere else on the screen does nothing
    if (pointInControl(mouseX, mouseY)) {
        joystickActive = true;
        controlMode = TOUCH;
    }

    return false;

}

function mouseDragged() {

    if (timelineScrub.active) {
        timelineScrub.moved += abs(mouseX - timelineScrub.lastX);
        scrubTimelineBy(mouseX - timelineScrub.lastX);
        timelineScrub.lastX = mouseX;
        return false;
    }

    if (impulse.phase === 'aiming' && impulse.dragging) {
        dragImpulseMap();
        return false;
    }

}

function mouseReleased() {

    // a tap (press without dragging) on the timeline toggles pause
    if (timelineScrub.active && timelineScrub.moved < 5 && !crashedOut) {
        paused = !paused;
    }

    joystickActive = false;
    timelineScrub.active = false;
    timelineScrub.accum = 0;
    impulse.dragging = false;
    impulse.pinch = null;
    impulse.waitForRelease = false;

}

// p5 only falls back to the mouse handlers via browser-emulated mouse events,
// which iOS Safari doesn't fire during press-and-hold or drags. Defining the
// touch handlers makes p5 call these directly on real touches (with
// mouseX/mouseY already updated to the touch position).
function touchDistance() {
    return dist(touches[0].x, touches[0].y, touches[1].x, touches[1].y);
}

function touchStarted() {
    if (impulse.phase === 'aiming' && touches.length >= 2) {
        impulse.pinch = touchDistance();
        impulse.dragging = false;
        return false;
    }
    mousePressed();
    return false;
}

function touchMoved() {
    if (impulse.pinch && touches.length >= 2) {
        let d = touchDistance();
        if (d > 0) zoomImpulseMap(d / impulse.pinch);
        impulse.pinch = d;
        return false;
    }
    mouseDragged();
    return false;
}

function touchEnded() {
    if (impulse.pinch) {
        if (touches.length < 2) impulse.pinch = null;
        impulse.dragging = false;
        return false;
    }
    mouseReleased();
    return false;
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

    if (key == 'i' || key == 'I' || key == 'p' || key == 'P') {
        togglePause();
    }

    if (keyCode == ESCAPE) {
        cancelImpulse(true);
    }

    if (key == 'r') {
        resetSimulation();
    }

    if (key == 'd') {
        displayPathChange = !displayPathChange; // toggles
    }
}


function drawFrame() {

    background(0);

    updateThrustSound((!paused || impulse.phase === 'burning') && !crashedOut && launched &&
        !timelineScrub.active && ship.boostingHistory[T] === true);

    // Camera

    // centred on body, but zooming in/out to keep ship trajectory inside a bounding box on screen
    // camera.drawBbox();
    camera.applyToMatrix();

    // in-sim text stays the same size on screen whatever the zoom
    textSize(12 / camera.scaleFactor);

    // Rendering in camera

    // stars and moon-orbit dots (prerendered, static in world space)
    if (!staticWorldBuffer) {
        buildStaticWorldBuffer();
    }
    drawStaticWorldBuffer();

    if (gravLights) {
        push();
        // translate(-width / 2, -height / 2);
        rotate((T % moonOrbit.length / moonOrbit.length * TAU));

        image(gravFieldImg, -gravFieldImg.width / 2, -gravFieldImg.height / 2);
        pop();
    }

    // draw hill sphere boundary
    if (moonEnabled) {
        noFill();
        strokeWeight(1);
        stroke(red(moonColor), green(moonColor), blue(moonColor), 25);
        circle(bodies[1].pos.x, bodies[1].pos.y, moonHillSphereRadius * 2);
    }


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

    // sketches can draw extra world-space elements (e.g. target orbit bands)
    if (typeof window.drawWorldOverlay === 'function') {
        window.drawWorldOverlay();
    }

    // camera
    pop();

    drawVirtualJoystick();

    drawImpulseHUD();

    drawFpsIndicator();

}

function drawVirtualJoystick() {

    let j = getJoystickGeometry();

    push();

    // transparent base: a ring around the ship's diagram (a full disc once
    // Impulse Mode takes over)
    let ctx = drawingContext;
    ctx.save();
    ctx.fillStyle = "rgba(255, 255, 255, " + (joystickActive ? 0.08 : 0.04) + ")";
    ctx.beginPath();
    ctx.arc(j.x, j.y, j.r, 0, TAU);
    if (j.inner > 0) {
        ctx.moveTo(j.x + j.inner, j.y);
        ctx.arc(j.x, j.y, j.inner, 0, TAU, true);
    }
    ctx.fill("evenodd");
    ctx.restore();

    let aiming = impulse.phase === 'aiming' && impulse.center;
    let live = !aiming && liveImpulseVisible();

    // the map of impulses, clipped to the circle: each cell is the outcome of
    // the impulse it stands for. While aiming it fills the circle; otherwise it
    // shows beneath the ring and the ship's diagram.
    if (aiming || live) {

        let map = aiming ? updateImpulseMap() : updateLiveImpulseMap();
        let centre = aiming ? impulse.center : { x: 0, y: 0 };
        let state = aiming ? { pos: impulse.snapshot.pos[T], vel: impulse.snapshot.vel[T] } :
            { pos: ship.posHistory[T], vel: ship.velHistory[T] };

        if (map && map.window) {
            drawImpulseMapImage(j, ctx, map, centre, aiming ? state : null);
        }

        drawImpulseOverlays(j, ctx, centre, state, aiming);

        if (live && !impulse.mapAlways) {
            // dim the hole, the pause control, behind the ship's diagram
            ctx.save();
            ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
            ctx.beginPath();
            ctx.arc(j.x, j.y, j.inner, 0, TAU);
            ctx.fill();
            ctx.restore();
        }

    }

    if (!aiming) {

        // transparent rocket at the center, showing the current orientation
        if (!(live && impulse.mapAlways)) {
            drawingContext.save();
            drawingContext.globalAlpha = joystickActive ? 0.55 : live ? 0.6 : 0.3;

            translate(j.x, j.y);
            scale(j.r / ship.length);
            ship.drawShipBody(0, 0, 255);

            drawingContext.restore();
        }

        // a paused ship: a play symbol over its diagram
        if (paused && impulse.phase === 'off') {
            let q = j.inner * 0.35;
            noStroke();
            fill(255, 200);
            triangle(j.x - q * 0.7, j.y - q, j.x - q * 0.7, j.y + q, j.x + q, j.y);
        }

        // marker for where the joystick is being pressed
        if (joystickActive) {
            let d = createVector(mouseX - j.x, mouseY - j.y);
            d.limit(j.r);
            noStroke();
            fill(255, 80);
            circle(j.x + d.x, j.y + d.y, j.r / 3);
        }

    }

    noFill();
    stroke(255, joystickActive || aiming ? 90 : 50);
    strokeWeight(2);
    circle(j.x, j.y, j.r * 2);
    if (j.inner > 0) {
        stroke(255, joystickActive ? 60 : 30);
        circle(j.x, j.y, j.inner * 2);
    }

    if (aiming) {

        // the selected impulse sits under the centre; a cross marks where
        // no impulse at all would be
        stroke(255, 230);
        strokeWeight(2);
        circle(j.x, j.y, j.r * 0.16);

        let zx = j.x - impulse.center.x / impulseReach() * j.r;
        let zy = j.y - impulse.center.y / impulseReach() * j.r;
        if (dist(zx, zy, j.x, j.y) < j.r - 6) {
            let q = j.r * 0.06;
            stroke(255, 160);
            strokeWeight(1.5);
            line(zx - q, zy, zx + q, zy);
            line(zx, zy - q, zx, zy + q);
        }

    }

    let s = j.cornerSize;

    // reset button: triangle fitted to the bottom-left corner of the ring's bounding box
    stroke(255, 70);
    strokeWeight(2);
    fill(255, 15);
    triangle(j.resetX, j.resetY,
        j.resetX + s, j.resetY,
        j.resetX, j.resetY - s);

    // circular-arrow glyph
    let cx = j.resetX + s * 0.33;
    let cy = j.resetY - s * 0.33;
    let d = s * 0.5;
    let a1 = TAU * 0.35;
    noFill();
    arc(cx, cy, d, d, -TAU * 0.4, a1);

    let ax = cx + cos(a1) * d / 2;
    let ay = cy + sin(a1) * d / 2;
    let back = a1 + TAU / 4 + TAU / 2; // pointing back along the arc
    let hl = s * 0.18;
    line(ax, ay, ax + cos(back - 0.5) * hl, ay + sin(back - 0.5) * hl);
    line(ax, ay, ax + cos(back + 0.5) * hl, ay + sin(back + 0.5) * hl);

    if (aiming) {
        drawImpulseButtons();
    }

    pop();

}

// the map's image, positioned so that the impulse at the circle's centre
// sits under its middle; the picture is only redrawn when its contents change
function drawImpulseMapImage(j, ctx, map, centre, state) {

    let win = map.window;
    let reach = map.spacing * map.n / 2;
    let k = j.r / reach;

    // the dynamic contour: the apoapsis of the selected impulse
    let selLog = NaN;
    if (state) {
        selLog = earthApoapsisLog(state.pos, state.vel,
            { x: centre.x * ship.rocketAcc, y: centre.y * ship.rocketAcc });
    }

    let renderKey = [map.cells.size, win.ix0, win.iy0, isFinite(selLog) ? selLog.toFixed(4) : selLog].join();
    if (map.renderKey !== renderKey) {
        renderImpulseMap(map, win, map.curLog, selLog);
        map.renderKey = renderKey;
    }

    let cell = win.spacing * k;

    ctx.save();
    ctx.beginPath();
    ctx.arc(j.x, j.y, j.r, 0, TAU);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(map.canvas,
        j.x + ((win.ix0 - 0.5) * win.spacing - centre.x) * k,
        j.y + ((win.iy0 - 0.5) * win.spacing - centre.y) * k,
        win.nx * cell, win.ny * cell);
    ctx.restore();

}

function niceStep(x) {
    let p = Math.pow(10, Math.floor(Math.log10(x)));
    let m = x / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

// Drawn over the map; none of it needs the simulation, only the geometry of
// impulse against velocity. The circle is a window onto impulse space; the
// velocity after an impulse is the current velocity plus the impulse, so
//   - the new velocity sits under the circle's centre,
//   - the current velocity sits where no impulse would be,
//   - zero velocity is the origin of the velocity rings, a fixed offset from
//     the current velocity.
// Colours: green is the current state, orange the selected impulse.
function drawImpulseOverlays(j, ctx, c, state, detail) {

    let vel = state.vel, pos = state.pos;
    let acc = ship.rocketAcc;
    let reach = impulseReach();
    let k = j.r / reach; // pixels per frame of burn
    let vk = k / acc; // pixels per unit of velocity

    let cur = { x: j.x - c.x * k, y: j.y - c.y * k };
    let origin = { x: cur.x - vel.x * vk, y: cur.y - vel.y * vk };

    let speed = Math.hypot(vel.x, vel.y);
    let newSpeed = Math.hypot(vel.x + c.x * acc, vel.y + c.y * acc);
    let dvSize = Math.hypot(c.x, c.y);
    let earth = bodies[0];
    let escape = Math.sqrt(2 * G * earth.mass / Math.hypot(pos.x - earth.pos.x, pos.y - earth.pos.y));

    const GREEN = [90, 255, 120], ORANGE = [255, 160, 40], BLUE = [130, 180, 255], RED = [255, 110, 110];

    let rings = (o, stepPx) => {
        let d = Math.hypot(o.x - j.x, o.y - j.y);
        let m0 = max(1, Math.ceil((d - j.r) / stepPx));
        let m1 = min(Math.floor((d + j.r) / stepPx), m0 + 60);
        for (let m = m0; m <= m1; m++) circle(o.x, o.y, 2 * m * stepPx);
    };

    let arrow = (from, to, col) => {
        stroke(col[0], col[1], col[2], 230);
        strokeWeight(2);
        line(from.x, from.y, to.x, to.y);
        let a = Math.atan2(to.y - from.y, to.x - from.x);
        let h = 8;
        line(to.x, to.y, to.x - Math.cos(a - 0.4) * h, to.y - Math.sin(a - 0.4) * h);
        line(to.x, to.y, to.x - Math.cos(a + 0.4) * h, to.y - Math.sin(a + 0.4) * h);
    };

    push();
    noFill();

    ctx.save();
    ctx.beginPath();
    ctx.arc(j.x, j.y, j.r, 0, TAU);
    ctx.clip();

    // velocity rings about zero velocity, and Δv rings about the current velocity
    if (detail) {
        stroke(BLUE[0], BLUE[1], BLUE[2], 70);
        strokeWeight(1);
        rings(origin, niceStep(reach * acc / 2) * vk);

        ctx.setLineDash([4, 4]);
        stroke(255, 50);
        rings(cur, niceStep(reach / 4) * k);

        // the dynamic rings: current and new speed, the Δv, and escape speed
        stroke(RED[0], RED[1], RED[2], 150);
        circle(origin.x, origin.y, 2 * escape * vk);
        stroke(ORANGE[0], ORANGE[1], ORANGE[2], 200);
        circle(cur.x, cur.y, 2 * dvSize * k);
        ctx.setLineDash([]);
        stroke(GREEN[0], GREEN[1], GREEN[2], 200);
        circle(origin.x, origin.y, 2 * speed * vk);
        stroke(ORANGE[0], ORANGE[1], ORANGE[2], 200);
        circle(origin.x, origin.y, 2 * newSpeed * vk);
    }

    // the prograde / retrograde axis: the line of the current velocity
    let u = speed > 1e-6 ? { x: vel.x / speed, y: vel.y / speed } : null;
    if (u) {
        ctx.setLineDash([2, 5]);
        stroke(255, detail ? 130 : 90);
        strokeWeight(1.5);
        line(cur.x - u.x * j.r * 4, cur.y - u.y * j.r * 4, cur.x + u.x * j.r * 4, cur.y + u.y * j.r * 4);
        ctx.setLineDash([]);
    }

    if (detail) {
        arrow(origin, cur, GREEN);
        arrow(origin, { x: j.x, y: j.y }, ORANGE);
    }

    ctx.restore();

    // the labels (and the axis labels outside the circle) are for aiming
    if (!detail) {
        pop();
        return;
    }

    // labels, kept inside the circle and outlined to stay readable
    textSize(11);
    textAlign(CENTER, CENTER);
    let ringLabel = (o, radius, deg, str, col) => {
        let a = deg * Math.PI / 180;
        let px = j.x + Math.cos(a) * j.r * 0.62, py = j.y + Math.sin(a) * j.r * 0.62;
        let vx = px - o.x, vy = py - o.y;
        let l = Math.hypot(vx, vy);
        if (l < 1) return;
        let qx = o.x + vx / l * radius, qy = o.y + vy / l * radius;
        if (Math.hypot(qx - j.x, qy - j.y) > j.r - 14) return;
        stroke(0, 190);
        strokeWeight(3);
        fill(col[0], col[1], col[2]);
        text(str, qx, qy);
    };
    ringLabel(origin, speed * vk, -135, "speed now", GREEN);
    ringLabel(origin, newSpeed * vk, -45, "new speed", ORANGE);
    ringLabel(cur, dvSize * k, 45, "Δv", ORANGE);
    ringLabel(origin, escape * vk, 135, "escape", RED);

    // axis labels sit outside the circle where the axis leaves it
    if (u) {
        let b = (cur.x - j.x) * u.x + (cur.y - j.y) * u.y;
        let cc = sq(cur.x - j.x) + sq(cur.y - j.y) - j.r * j.r;
        let disc = b * b - cc;
        if (disc >= 0) {
            let root = Math.sqrt(disc);
            let end = (t, str, sgn) => {
                let ex = cur.x + u.x * t, ey = cur.y + u.y * t;
                let w = textWidth(str);
                let off = 8 + Math.abs(u.x) * w / 2 + Math.abs(u.y) * 7;
                stroke(0, 190);
                strokeWeight(3);
                fill(255, 230);
                text(str, ex + sgn * u.x * off, ey + sgn * u.y * off);
            };
            end(-b + root, "Prograde", 1);
            end(-b - root, "Retrograde", -1);
        }
    }

    pop();

}

function drawImpulseButtons() {

    let b = getImpulseButtons();
    let ready = impulse.dir && impulse.frames > 0;

    textAlign(CENTER, CENTER);
    textSize(16);

    stroke(255, 120);
    strokeWeight(2);
    fill(255, 20);
    rect(b.cancel.x, b.cancel.y, b.cancel.w, b.cancel.h, 8);
    noStroke();
    fill(255, 200);
    text("Resume", b.cancel.x + b.cancel.w / 2, b.cancel.y + b.cancel.h / 2);

    stroke(255, ready ? 200 : 60);
    strokeWeight(2);
    fill(255, ready ? 60 : 8);
    rect(b.burn.x, b.burn.y, b.burn.w, b.burn.h, 8);
    noStroke();
    fill(255, ready ? 255 : 90);
    text("Burn", b.burn.x + b.burn.w / 2, b.burn.y + b.burn.h / 2);

}

// hints and the state of the burn being set up
function drawImpulseHUD() {

    if (!impulse.available || (!impulseInFlight() && impulse.phase === 'off')) return;

    push();
    noStroke();
    textAlign(CENTER, TOP);
    textSize(16);

    let x = width / 2;
    let y = 12;
    let touch = isTouchDevice();

    if (impulse.phase === 'aiming') {

        fill(255, 230);
        if (impulse.dir && impulse.frames > 0) {
            text("PAUSED — burn of " + impulse.frames + " frames", x, y);
        } else {
            text("PAUSED — drag the circle to choose an impulse", x, y);
        }
        if (!touch) {
            fill(255, 140);
            text("P or Esc to resume", x, y + 22);
        }

    } else if (impulse.phase === 'burning') {

        fill(255, 230);
        text("BURNING", x, y);

    } else if (impulse.phase === 'off' && impulse.exclusive) {

        fill(255, 120);
        text(touch ? "Press the centre of the circle to set up an impulse" : "Click the centre of the circle (or press P) to set up an impulse", x, y);

    }

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

    if (!TIMELINE_VISIBLE) return;

    timelineEnabled = true;

    push();
    clip(timelineMask);

    let h = height / 10;
    fill(0);
    rect(0, height - h, width, h);

    framesPerPixel = TIMELINE_FRAMES_PER_PIXEL;

    sliceMinAlt = 0;
    sliceMaxAlt = floor(bodies[0].radius + ship.apoapsisAlt + 100);

    // only draw the slices that are actually on screen (1px per framesPerPixel frames)
    let anchor = T - (T % framesPerPixel);
    let halfSpanFrames = (ceil(width / 2) + 1) * framesPerPixel;
    let PTstart = max(0, anchor - halfSpanFrames);
    let PTend = min(ship.posHistory.length, anchor + halfSpanFrames);

    for (let PT = PTstart; PT < PTend; PT += framesPerPixel) {

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
        stroke(bodyColor('earth'));

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
    if (impulse.phase !== 'off') {
        tString += " (IMPULSE MODE)";
    }
    textAlign(LEFT, TOP);
    text(tString, x, height - h);

    pop();

}

// Injected so this applies wherever this script is embedded, regardless of host page CSS
function disableMobileGestureConflicts() {
    const style = document.createElement('style');
    style.textContent = `
        html, body, canvas {
            touch-action: none;
            -webkit-user-select: none;
            user-select: none;
            -webkit-touch-callout: none;
        }
    `;
    document.head.appendChild(style);

    // if iOS cancels a touch (e.g. a system gesture), release any held inputs
    const releaseHeldInputs = () => {
        joystickActive = false;
        timelineScrub.active = false;
        timelineScrub.accum = 0;
        impulse.dragging = false;
    };
    window.addEventListener('touchcancel', releaseHeldInputs);

    // iOS Safari often fails to deliver touch events to listeners bound to an
    // iframe's window, which is where p5 attaches its handlers. When embedded
    // (e.g. the essay page), forward touches from the canvas element itself to
    // p5's handlers, and stop propagation so browsers that do deliver them to
    // the window don't handle each touch twice.
    if (window.self !== window.top && isTouchDevice()) {
        const canvas = document.querySelector('canvas');

        for (const type of ['touchstart', 'touchmove', 'touchend']) {
            canvas.addEventListener(type, (e) => {
                const handler = p5.instance._events[type];
                if (handler) {
                    handler(e);
                }
                e.stopPropagation();
            }, { passive: false });
        }

        canvas.addEventListener('touchcancel', (e) => {
            releaseHeldInputs();
            e.stopPropagation();
        });
    }
}