/*

Bugs to fix:
- peripasis apoapsis flickering
- moon crash glitch


Feature to-do list:
- orbital description HUD
  - elliptical:
    - eccentricity, periapsis, apoapsis, period
  - escape:
  - collision trajectory
    - time to impact, impact velocity

- quick launch
- instantaneous impulse control

- show projection for how orbit will *shift* as you boost
- dynamic camera
- visualise gravity

- reset button


- night vision sound effect when you turn on the gravity light (like in Animal Well)


- music plays according to orbit


- live framerate visualiser diagnostic


- add orbital velocity when launching from the moon + relative velocity when calculating crash

- 


Finished features:
- prebake lunar movement
- collision detection for planet
- ship HUD
  - velocity, altitude relative to planet
- scroll backwards in time
- show velocity and gravitational force vectors

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
let moonHillSphereRadius;

let gravitationalFieldHistory = [];

let gridSize;


let rocketColor;
let earthColor;
let moonColor;

let gap = 100;


let accArrowScale = 40000;


let gravFieldImg;

function setup() {

  pixelDensity(1);
  createCanvas(windowWidth, windowHeight);
  // fullscreen(true);

  rocketColor = color("#ff00b3ff");
  earthColor = color("#00ffffff");
  moonColor = color("#ffff00ff");

  bodies.push(new Body(createVector(0, 0), 100, 1, color("#a3ffffff"))); // Earth
  bodies.push(new Body(createVector(0, -25 * 17), 25, 0.1, color("#ffff90ff"))); // Moon

  let l = 30;
  ship = new Ship(createVector(bodies[0].pos.x, bodies[0].pos.y - bodies[0].radius - l / 2), l);

  camera = new Camera();

  generateMoonOrbit();

  rollingFrameRateAverage = frameRate();

  gravFieldImg = loadImage("gravitationalField.png");

  // // hypot
  gridSize = round(Math.sqrt(width * width + height * height));

  let a = p5.Vector.dist(bodies[0].pos, bodies[1].pos);
  let m1 = bodies[0].mass;
  let m2 = bodies[1].mass;
  moonHillSphereRadius = a * Math.cbrt(m2 / 3 * (m1 + m2));

}

function generateGravitationalFieldBuffer() {

  return;

  // // Precompute the field into an offscreen buffer
  // fieldBuffer = createGraphics(gridSize, gridSize);
  // fieldBuffer.loadPixels();

  // for (let y = 0; y < gridSize; y++) {
  //   for (let x = 0; x < gridSize / 2 + 1; x++) {
  //     let gravAtPoint = {
  //       pos: createVector(x - gridSize / 2, y - gridSize / 2),
  //       earthGrav: false,
  //       moonGrav: false,
  //       netGrav: false
  //     };

  //     gravAtPoint.earthGrav = bodies[0].getGravitationalAcceleration(gravAtPoint.pos);
  //     gravAtPoint.moonGrav = bodies[1].getGravitationalAcceleration(gravAtPoint.pos);
  //     gravAtPoint.netGrav = p5.Vector.add(gravAtPoint.earthGrav, gravAtPoint.moonGrav);

  //     let mix = lerpColor(earthColor, moonColor, gravAtPoint.moonGrav.mag() / gravAtPoint.netGrav.mag());

  //     let idx = 4 * (x + y * gridSize);

  //     // Encode as grayscale (or color map)
  //     fieldBuffer.pixels[idx] = red(mix);
  //     fieldBuffer.pixels[idx + 1] = green(mix);
  //     fieldBuffer.pixels[idx + 2] = blue(mix);

  //     let gMax = 0.007;
  //     let gMin = 0.00005; // small value to avoid log(0)

  //     let g = gravAtPoint.netGrav.mag(); // your per-pixel g

  //     // Linearize using log2
  //     let normalized = (Math.log10(g + gMin) - Math.log10(gMin)) /
  //       (Math.log10(gMax) - Math.log10(gMin));

  //     // Clamp to 0–1
  //     normalized = constrain(normalized, 0, 1);

  //     fieldBuffer.pixels[idx + 3] = normalized * 255;

  //     // surface grav = 0.005
  //   }
  // }

  // // mirror
  // for (let y = 0; y < gridSize; y++) {
  //   for (let x = 0; x < gridSize / 2; x++) {

  //     let mirrorIdx = 4 * ((gridSize / 2 - x) + y * gridSize)

  //     let idx = 4 * ((gridSize / 2 + x) + y * gridSize);

  //     fieldBuffer.pixels[idx] = fieldBuffer.pixels[mirrorIdx];
  //     fieldBuffer.pixels[idx + 1] = fieldBuffer.pixels[mirrorIdx + 1];
  //     fieldBuffer.pixels[idx + 2] = fieldBuffer.pixels[mirrorIdx + 2];
  //     fieldBuffer.pixels[idx + 3] = fieldBuffer.pixels[mirrorIdx + 3];

  //   }
  // }

  // fieldBuffer.updatePixels();

  // save(fieldBuffer, 'png');

}

// prebaked for easy lookup when projecting ship trajectory
function generateMoonOrbit() {

  let v = sqrt(bodies[0].getGravitationalAcceleration(bodies[1].pos).mag() * p5.Vector.dist(bodies[0].pos, bodies[1].pos));

  let moon = {
    pos: bodies[1].pos.copy(),
    vel: createVector(v, 0),
  }



  moonOrbit.push(moon.pos.copy());

  for (let lT = 0; lT < 25000; lT++) {

    moon.vel.add(bodies[0].getGravitationalAcceleration(moon.pos))
    moon.pos.add(moon.vel);

    moonOrbit.push(moon.pos.copy());


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


class Projection {
  constructor(pos, vel) {
    this.pos = pos;
    this.vel = vel;
  }
}

class Ship {
  constructor(startingPos, l) {
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
    if (this.boosting) {

      let trailLength = l * (random(0.9, 1.2));
      let t = trailLength;

      let fireColor = color('#FF5722');
      fireColor.setAlpha(alphaValue);
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

    let windowColor = color('#000000ff')
    windowColor.setAlpha(alphaValue);
    if (ghost) {
      windowColor.setRed(0)
    };
    fill(windowColor);
    circle(0, 0, l / 3.5);

    pop();

  }

  draw() {

    let pos = this.posHistory[T];

    camera.minY = pos.x;
    camera.maxY = pos.y;

    strokeWeight(1);

    let lineColor = rocketColor;

    for (let PT = 0; PT < this.posHistory.length; PT++) {

      // if (PT < T) {
      //   stroke("#36f725ff");
      //   point(this.posHistory[PT].x, this.posHistory[PT].y);
      // }
      if (PT > T) {
        stroke(lineColor);
        point(this.posHistory[PT].x, this.posHistory[PT].y);

        stroke("#d8ff58ff");

        if (this.shipOrbitingMoon && PT < this.shipOrbitingMoonEndOfFirstOrbit) {
          let posRelativeToMoon = p5.Vector.sub(this.posHistory[PT], moonOrbit[PT % moonOrbit.length]);
          point(bodies[1].pos.x + posRelativeToMoon.x, bodies[1].pos.y + posRelativeToMoon.y);
        }
      }

      // if (this.shipOrbitingMoon) {

      // }


      // if ((T + i) % 100 == 0) {
      //   this.drawShipBody(projection.pos.x, projection.pos.y, 60, true);
      // } else if ((T + i) % 10 == 0) {
      //   this.drawShipBody(projection.pos.x, projection.pos.y, 10, true);
      // }


      // this.drawShipBody(projection_pos.x, projection_pos.y, 10 * ((i%100)/100), true);


    }

    let offset = this.length / 2;
    fill(rocketColor);
    noStroke();
    textFont("menlo");
    textAlign(LEFT, BOTTOM);

    let projectionDuration = this.posHistory.length - T;

    if (this.trajectoryType == 'Orbit') {

      text("Orbit\n" +
        "Period: " + round(projectionDuration / 100, 1) + " hectoframes",
        pos.x + offset, pos.y - offset);

      //   text(
      //     "Periapsis: " + round(this.periapsis_alt) + "px",
      //     this.periapsis.x + offset, this.periapsis.y + offset);

      //   text(
      //     "Apoapsis: " + round(this.apoapsis_alt) + "px",
      //     this.apoapsis.x + offset, this.apoapsis.y + offset);

      //   // periapsis
      //   let surfaceIntersect = bodies[closest_body].getSurfaceIntersectForAltitudeLine(this.periapsis);
      //   strokeWeight(1);
      //   stroke("#00F6FF");
      //   line(surfaceIntersect.x, surfaceIntersect.y, this.periapsis.x, this.periapsis.y);

      //   // apoapsis
      //   surfaceIntersect = bodies[closest_body].getSurfaceIntersectForAltitudeLine(this.apoapsis);
      //   strokeWeight(1);
      //   stroke("#00F6FF");
      //   line(surfaceIntersect.x, surfaceIntersect.y, this.apoapsis.x, this.apoapsis.y);

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

    strokeWeight(2);

    let moonPos = moonOrbit[T % moonOrbit.length];

    stroke("#fff");
    let accArrowEndpoint = pos.copy().add(this.accHistory[T].copy().mult(accArrowScale));
    drawArrow(this.posHistory[T], accArrowEndpoint);

    //earth grav
    stroke(earthColor);
    let earthGravArrowEndpoint = pos.copy().add(bodies[0].getGravitationalAcceleration(pos).mult(accArrowScale));
    drawArrow(this.posHistory[T], earthGravArrowEndpoint);

    stroke(moonColor);
    let moonGravArrowEndpoint = pos.copy().add(bodies[1].getGravitationalAcceleration(pos, moonPos).mult(accArrowScale));
    drawArrow(this.posHistory[T], moonGravArrowEndpoint);

    stroke(rocketColor);
    let velArrowEndpoint = pos.copy().add(this.velHistory[T].copy().mult(200));
    drawArrow(this.posHistory[T], velArrowEndpoint);

    stroke("#fff");
    drawArrow(velArrowEndpoint, p5.Vector.add(accArrowEndpoint, this.velHistory[T].copy().mult(200)));
    stroke(earthColor);
    drawArrow(velArrowEndpoint, p5.Vector.add(earthGravArrowEndpoint, this.velHistory[T].copy().mult(200)));
    stroke(moonColor);
    drawArrow(velArrowEndpoint, p5.Vector.add(moonGravArrowEndpoint, this.velHistory[T].copy().mult(200)));


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

  projectTrajectory(boost = false, orientationShift = false) {

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

      // this.periapsis_alt = 1000000;
      // for (let b = 0; b < bodies.length; b++) {
      //   let distToBody = this.pos.dist(bodies[b].pos) - bodies[b].radius;
      //   if (distToBody < this.periapsis_alt) {
      //     this.periapsis_alt = distToBody;
      //     closest_body = b;
      //   }

      // }

      // this.apoapsis = this.pos.copy();
      // this.apoapsis_alt = 0;

      // camera.minX = ship.pos.x;
      // camera.maxX = ship.pos.x;

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
      let rocketImpulse = this.orientationHistory[T].copy().mult(this.rocketAcc);
      // console.log(this.acc_history[T]);
      this.accHistory[T].add(rocketImpulse);

      this.velHistory[T].add(this.accHistory[T]);
      this.posHistory[T].add(this.velHistory[T]);


    }

    //
    // Trajectory Projection
    //

    this.shipOrbitingMoon = false;
    this.shipOrbitingMoonEndOfFirstOrbit = false;

    let initialMoonT = false;
    let initialMoonPos = false;

    for (let i = T; i < this.posHistory.length; i++) {

      let moonPos = moonOrbit[i % moonOrbit.length];

      if (initialMoonT == false && this.posHistory[i].dist(moonPos) < moonHillSphereRadius) {
        initialMoonT = i;
        initialMoonPos = moonPos.copy();
        break;
      }

    }

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


      if (initialMoonT == false && this.posHistory[i].dist(moonPos) < moonHillSphereRadius) {
        initialMoonT = i;
        initialMoonPos = moonPos.copy();
      }

      // trajectory detection

      if (i - T > 50) {

        // If it has passed a certain length of time and we are more or less back where we started, then we have completed an orbit and can end the projection
        if (
          abs(p5.Vector.angleBetween(
            this.posHistory[T].copy().sub(bodies[0].pos),
            this.posHistory[i].copy().sub(bodies[0].pos)
          ))
          <= TAU / 360) {
          this.trajectoryType = 'Orbit';
          break outer;
        }

      }

      if (initialMoonT != false && !this.shipOrbitingMoon && i - initialMoonT > 25) {
        // If it has passed a certain length of time and we are more or less back where we started, then we have completed an orbit and can end the projection

        console.log(initialMoonT, i);
        let angle = abs(p5.Vector.angleBetween(
          this.posHistory[initialMoonT].copy().sub(initialMoonPos),
          this.posHistory[i].copy().sub(moonPos)
        ))
        if (angle <= TAU / 360) {
          this.shipOrbitingMoon = true;
          this.shipOrbitingMoonEndOfFirstOrbit = i;

        }
      }

      for (let body of bodies) {
        // let r = p5.Vector.sub(body.pos, projection.pos);
        let alt = body.getAltitude(this.posHistory[i]);

        if (alt < this.length / 2) {
          this.trajectoryType = 'Collision Course';

          break outer;
        }
      }


    }

    // if (initialMoonT) {
    //   console.log(initialMoonT);
    // }


  }

  // orbitDetection() {

  // }

  //     let moonPos = moonOrbit[(T + i) % moonOrbit.length];

  // let initialPosRelativeToMoon = initial_pos.copy().sub(moonPos.copy());
  // let projectionPosRelativeToMoon = projection.pos.copy().sub(moonPos.copy());

  // if (i > 100) {

  //   // If it has passed a certain length of time and we are more or less back where we started, then we have completed an orbit and can end the projection

  //   if (
  //     abs(p5.Vector.angleBetween(
  //       initial_pos.copy().sub(bodies[0].pos),
  //       projection.pos.copy().sub(bodies[0].pos)
  //     ))
  //     <= TAU / 360) {
  //     this.trajectoryType = 'Orbit';
  //     break;
  //   }

  //   if (p5.Vector.dist(initialPosRelativeToMoon, projectionPosRelativeToMoon) < 5) {
  //     this.shipOrbitingMoon = true;
  //     console.log("moon orbit achieved");
  //   }

  // }


  //   // let r = p5.Vector.sub(bodies[closest_body].pos, projection.pos);
  //   let alt = bodies[closest_body].getAltitude(projection.pos);

  //   // if (alt < this.length / 2) {
  //   //   this.trajectoryType = 'Collision Course';
  //   //   break;
  //   // }

  //   if (i > 5) {

  //     if (alt < this.periapsis_alt) {
  //       this.periapsis = projection.pos.copy();
  //       this.periapsis_alt = alt;
  //     } else if (alt > this.apoapsis_alt) {
  //       this.apoapsis = projection.pos.copy();
  //       this.apoapsis_alt = alt;
  //     }

  //   }

  //   if (projection.pos.x < camera.minX) {
  //     camera.minX = projection.pos.x;
  //   } else if (projection.pos.x > camera.maxX) {
  //     camera.maxX = projection.pos.x;
  //   }

  //   if (projection.pos.y < camera.minY) {
  //     camera.minY = projection.pos.y;
  //   } else if (projection.pos.y > camera.maxY) {
  //     camera.maxY = projection.pos.y;
  //   }

  // }


  // }


  update() {


    let turnVel = TAU / 100;
    let amt = false;

    if (controlMode == MOUSE) {
      let cursorPos = camera.screenToWorld(mouseX, mouseY);

      cursorPos.sub(this.posHistory[T]);

      // line(this.pos.x, this.pos.y, this.pos.x+(this.orientation.x*10), this.pos.y+(this.orientation.y*10))
      // console.log(this.orientation.heading());

      let angle = p5.Vector.angleBetween(this.orientationHistory[T], cursorPos);

      if (abs(angle) > turnVel) {
        if (angle > 0) {
          amt = turnVel;
        } else if (angle < 0) {
          amt = -turnVel;
        }
      }
    } else if (controlMode == KEYS) {

      if (keyIsDown(LEFT_ARROW)) {
        amt = -turnVel / 2;
      } else if (keyIsDown(RIGHT_ARROW)) {
        amt = turnVel / 2;
      }

    }


    this.projectTrajectory((mouseIsPressed || (keyIsDown(UP_ARROW))), amt);

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

  getAltitude(pos) {
    return p5.Vector.dist(pos, this.pos) - this.radius;
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

function keyPressed(event) {

  if (keyCode == LEFT_ARROW || keyCode == RIGHT_ARROW || keyCode == UP_ARROW) {
    controlMode = KEYS;

  }

  if (key == 'p' & !crashedOut) {
    paused = !paused; // toggles
  }

  if (key == 'd') {
    displayPathChange = !displayPathChange; // toggles
  }
}


function draw() {

  background(0);




  // Camera

  // centred on body, but zooming in/out to keep ship trajectory inside a bounding box on screen
  // camera.drawBbox();
  camera.applyToMatrix();



  // Rendering in camera

  push();
  // translate(-width / 2, -height / 2);
  rotate((T % moonOrbit.length / moonOrbit.length * TAU));
  image(gravFieldImg, -gravFieldImg.width / 2, -gravFieldImg.height / 2);
  pop();

  // draw moon orbit
  for (let i = 0; i < moonOrbit.length; i++) {

    let moonPos = moonOrbit[(T + i) % moonOrbit.length];
    stroke(red(moonColor), green(moonColor), blue(moonColor), 25);
    point(moonPos.x, moonPos.y);

  }

  // draw hill sphere boundary
  noFill();
  circle(bodies[1].pos.x, bodies[1].pos.y, moonHillSphereRadius * 2);


  bodies[1].pos = moonOrbit[T % moonOrbit.length].copy();
  for (let b = 0; b < bodies.length; b++) {
    bodies[b].draw();
  }

  stroke("#fff");
  // strokeWeight(1);
  // let surfaceIntersect = bodies[0].pos.copy().add(ship.posHistory[T].copy().sub(bodies[0].pos.copy()).normalize().mult(bodies[0].radius));
  // line(surfaceIntersect.x, surfaceIntersect.y, ship.posHistory[T].x, ship.posHistory[T].y);

  ship.draw();

  strokeWeight(5);
  stroke("#fff");
  point(ship.apoapsis.x, ship.apoapsis.y);

  for (let i = 0; i < particles.length; i++) {
    particles[i].draw();
  }



  //
  // Updating state
  //

  offset = ship.length / 2;

  if (crashedOut) {
    noStroke();
    textAlign(RIGHT, TOP);
    text("You have crashed.", ship.posHistory[T].x - offset, ship.posHistory[T].y + offset);
  }

  if (mouseIsPressed || keyIsDown(UP_ARROW)) {
    launched = true;
  }

  if (framesToSkip < 0) {

    // let length = ship.pos_history.length;

    if (abs(framesToSkip) >= T) {
      framesToSkip = -T;
    }

    while (framesToSkip < -1) {
      //   ship.pos_history.pop();
      //   ship.vel_history.pop();
      //   ship.orientation_history.pop();
      //   ship.boosting_history.pop();
      T--;

      framesToSkip += 1;
    }

    if (T == 0) {
      launched = false;
      ship.boosting = false;
    }

    length = ship.posHistory.length;

    ship.pos = ship.posHistory[T].copy();
    ship.vel = ship.velHistory[T].copy();
    ship.orientation = ship.orientationHistory[T].copy();
    ship.boosting = ship.boostingHistory[T];

  } else {

    outer:
    while (framesToSkip) {

      bodies[1].pos = moonOrbit[T % moonOrbit.length].copy();

      ship.update();


      // checking for landing or crash

      for (let b = 0; b < bodies.length; b++) {
        if (p5.Vector.dist(ship.posHistory[T], bodies[b].pos) - bodies[b].radius < ship.length / 2) {

          // if velocity below threshold and orientation has landing gear aligned with the ground, then the rocketship lands
          // otherwise, it is a crash

          let landingVelocityThreshold = 0.5;

          let velocity = ship.velHistory[T].mag();
          let upright = ship.posHistory[T].copy().sub(bodies[b].pos.copy()).normalize();
          let landingAngle = p5.Vector.angleBetween(ship.orientationHistory[T], upright);

          if (velocity <= landingVelocityThreshold &&
            landingAngle < TAU / 8) {

            // reset velocity, position, and orientation based on landing spot
            ship.velHistory[T].set(0, 0);
            ship.orientationHistory[T].set(upright.copy());
            ship.posHistory[T].set(bodies[b].pos.copy().add(upright.copy().mult(bodies[b].radius + ship.length / 2)));

            launched = false;

          } else {
            crashedOut = true;
            paused = true;
          }

          // landed
          console.log(velocity, landingAngle);



          break outer;
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


      for (let i = 0; i < particles.length; i++) {
        particles[i].update();

      }

      for (let i = 0; i < particles.length; i++) {
        if (particles[i].timer <= 0) {
          particles.splice(i, 1);
        }
      }

      framesToSkip -= 1;

      T++;
    }

  }

  framesToSkip = 0;

  if (!paused && launched) {
    framesToSkip = 1;
  }




  // camera
  pop();


  rollingFrameRateAverage = ((rollingFrameRateAverage * 19) + frameRate()) / 20;


  // screenspace HUD


  fill('#ffffff');
  noStroke();
  textFont("menlo");
  let tString = "T = " + round(T / 100, 1) + " hectoframes since launch\nHistory: " + round(ship.posHistory.length / 100, 1) + "\nFPS: " + round(rollingFrameRateAverage, 0);
  if (paused) {
    tString += " (PAUSED)";
  }
  textAlign(LEFT, TOP);
  text(tString, 30, 30);


}