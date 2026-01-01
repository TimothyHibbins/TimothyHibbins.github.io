/*

Bugs to fix:
- peripasis apoapsis flickering


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





Finished features:
- prebake lunar movement
- collision detection for planet
- ship HUD
  - velocity, altitude relative to planet
- scroll backwards in time
- show velocity and gravitational force vectors

*/

let cameraMode;

let G = 75 // gravitational constant

let paused = false;

let launched = false;

let crashed_out = false;

let display_path_change = false;

let framesToSkip = 0;

let T = 0;

let particles = [];

let particle_pulse_frequency = 300;
let particle_timer = particle_pulse_frequency;

let bodies = [];

let ship;

let closest_body = 0;

let camera;

let moonOrbit = [];

function setup() {

  createCanvas(windowWidth, windowHeight);
  // fullscreen(true);


  bodies.push(new Body(createVector(0, 0), 100, 1, color('#21CC43'))); // Earth
  bodies.push(new Body(createVector(0, 25 * 30), 25, 0.05, color('#FFEB3B'))); // Moon

  let l = 30;
  ship = new Ship(createVector(bodies[0].pos.x, bodies[0].pos.y - bodies[0].radius - l / 2), l);

  camera = new Camera();

  generateMoonOrbit();

}

// prebaked for easy lookup when projecting ship trajectory
function generateMoonOrbit() {

  let moon = {
    pos: bodies[1].pos.copy(),
    vel: createVector(0.3, 0),
  }

  moonOrbit.push(moon.pos.copy());

  for (let lT = 0; lT < 25000; lT++) {



    moon.vel.add(bodies[0].getGravitationalAcceleration(moon))
    moon.pos.add(moon.vel);

    moonOrbit.push(moon.pos.copy());

    if (lT > 50 && moon.pos.dist(bodies[1].pos) < 3) {
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
  constructor(pos, l) {
    this.pos = pos;
    this.pos_history = [];

    this.vel = createVector(0, 0);
    this.vel_history = [];

    this.acc = createVector(0, 0);

    this.rocket_acc = 0.007;
    this.boosting = false;
    this.boosting_history = [];

    this.length = l;
    this.s_width = this.length / 3;
    this.orientation = p5.Vector.fromAngle(-TAU / 4);
    this.orientation_history = [];

    this.pos_history.push(this.pos.copy());
    this.vel_history.push(this.vel.copy());
    this.orientation_history.push(this.orientation.copy());
    this.boosting_history.push(this.boosting);

    this.apoapsis = this.pos.copy();
    this.periapsis = this.pos.copy();

  }

  drawShipBody(x, y, alphaValue, ghost = false) {

    let l = this.length;
    let w = this.s_width;

    push();
    translate(x, y);
    rotate(this.orientation.heading() + TAU / 4);

    noStroke();
    if (this.boosting) {

      let trail_length = l * (random(0.9, 1.2));
      let t = trail_length;

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

    let hullColor = color('#FFFFFF');
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

    let windowColor = color('#5EABCE')
    windowColor.setAlpha(alphaValue);
    if (ghost) {
      windowColor.setRed(0)
    };
    fill(windowColor);
    circle(0, 0, l / 3.5);

    pop();

  }

  draw() {

    this.periapsis = this.pos.copy();

    let periapsis_alt = 1000000;
    for (let b = 0; b < bodies.length; b++) {
      let distToBody = this.pos.dist(bodies[b].pos) - bodies[b].radius;
      if (distToBody < periapsis_alt) {
        periapsis_alt = distToBody;
        closest_body = b;
      }

    }

    // this.apoapsis = this.pos.copy();
    let apoapsis_alt = 0;


    //
    // Trajectory Projection
    //

    let projection = new Projection(this.pos.copy(), this.vel.copy());
    let initial_pos = projection.pos.copy();

    camera.minX = ship.pos.x;
    camera.maxX = ship.pos.x;

    camera.minY = ship.pos.y;
    camera.maxY = ship.pos.y;

    strokeWeight(1);

    let lineColor = color('#00F6FF');
    stroke(lineColor);

    let shipOrbitingMoon = false;

    let trajectory = '';
    let i;
    for (i = 0; i < 5000; i++) {

      let moonPos = moonOrbit[(T + i) % moonOrbit.length];

      let initialPosRelativeToMoon = initial_pos.copy().sub(moonPos.copy());
      let projectionPosRelativeToMoon = projection.pos.copy().sub(moonPos.copy());

      if (i > 50) {


        // If it has passed a certain length of time and we are more or less back where we started, then we have completed an orbit and can end the projection
        if (p5.Vector.dist(initial_pos, projection.pos) < 5) {
          trajectory = 'Orbit';
          break;
        }



        if (p5.Vector.dist(initialPosRelativeToMoon, projectionPosRelativeToMoon) < 5) {
          moonOrbit = true;
          console.log("moon orbit achieved");
        }

      }

      // let r = p5.Vector.sub(bodies[closest_body].pos, projection.pos);
      let alt = bodies[closest_body].getAltitude(projection.pos);

      // if (alt < this.length / 2) {
      //   trajectory = 'Collision Course';
      //   break;
      // }

      if (i > 5) {

        if (alt < periapsis_alt) {
          this.periapsis = projection.pos.copy();
          periapsis_alt = alt;
        } else if (alt > apoapsis_alt) {
          this.apoapsis = projection.pos.copy();
          apoapsis_alt = alt;
        }

      }

      if (projection.pos.x < camera.minX) {
        camera.minX = projection.pos.x;
      } else if (projection.pos.x > camera.maxX) {
        camera.maxX = projection.pos.x;
      }

      if (projection.pos.y < camera.minY) {
        camera.minY = projection.pos.y;
      } else if (projection.pos.y > camera.maxY) {
        camera.maxY = projection.pos.y;
      }

      projection.vel.add(bodies[0].getGravitationalAcceleration(projection));
      projection.vel.add(bodies[1].getGravitationalAcceleration(projection, moonPos));


      projection.pos.add(projection.vel);

      stroke(lineColor);
      point(projection.pos.x, projection.pos.y);

      stroke("#d8ff58ff");
      point(bodies[1].pos.x + projectionPosRelativeToMoon.x, bodies[1].pos.y + projectionPosRelativeToMoon.y);


      // if ((T + i) % 100 == 0) {
      //   this.drawShipBody(projection.pos.x, projection.pos.y, 60, true);
      // } else if ((T + i) % 10 == 0) {
      //   this.drawShipBody(projection.pos.x, projection.pos.y, 10, true);
      // }


      // this.drawShipBody(projection_pos.x, projection_pos.y, 10 * ((i%100)/100), true);


    }


    let offset = this.length / 2;
    fill('#00F6FF');
    noStroke();
    textFont("menlo");
    textAlign(LEFT, BOTTOM);

    if (trajectory == 'Orbit') {

      text("Orbit\n" +
        "Period: " + round(i / 100, 1) + " hectoframes",
        this.pos.x + offset, this.pos.y - offset);

      text(
        "Periapsis: " + round(periapsis_alt) + "px",
        this.periapsis.x + offset, this.periapsis.y + offset);

      text(
        "Apoapsis: " + round(apoapsis_alt) + "px",
        this.apoapsis.x + offset, this.apoapsis.y + offset);

      // periapsis
      let surfaceIntersect = bodies[closest_body].getSurfaceIntersectForAltitudeLine(this.periapsis);
      strokeWeight(1);
      stroke("#00F6FF");
      line(surfaceIntersect.x, surfaceIntersect.y, this.periapsis.x, this.periapsis.y);

      // apoapsis
      surfaceIntersect = bodies[closest_body].getSurfaceIntersectForAltitudeLine(this.apoapsis);
      strokeWeight(1);
      stroke("#00F6FF");
      line(surfaceIntersect.x, surfaceIntersect.y, this.apoapsis.x, this.apoapsis.y);

    } else if (trajectory == 'Collision Course') {

      text("Collision Course\n" +
        "Time to impact: : " + round(i / 100, 1) + " hectoframes\n" +
        "Impact velocity: " + round(projection.vel.mag() * 100, 1) + " px/hectoframe",
        this.pos.x + offset, this.pos.y - offset);

    } else {
      camera.minX = ship.pos.x;
      camera.maxX = ship.pos.x;

      camera.minY = ship.pos.y;
      camera.maxY = ship.pos.y;
    }

    if (this.boosting & display_path_change) {

      for (let j = 0; j < 20; j += 2) {

        projection.pos = this.pos.copy();
        projection.vel = this.vel.copy();

        initial_pos = projection.pos.copy();

        strokeWeight(1);
        lineColor.setAlpha(alpha(lineColor) - 20);
        stroke(lineColor);

        for (let i = 0; i < 5000; i++) {

          if (i > 50) {
            if (p5.Vector.dist(initial_pos, projection.pos) < 5) {
              trajectory = 'Orbit';
              break;
            }
          }

          if (p5.Vector.dist(projection.pos, bodies[closest_body].pos) - bodies[closest_body].radius < this.length / 2) {
            trajectory = 'Collision Course';
            break;
          }

          projection.vel.add(getGravitationalAccelerationFromAllBodies(projection));

          if (i <= j) {
            projection.vel.add(this.orientation.copy().mult(this.rocket_acc));
          }

          projection.pos.add(projection.vel);

          point(projection.pos.x, projection.pos.y);

        }
      }

    }


    stroke("#00ff22ff");
    let velArrowEndpoint = this.pos.copy().add(this.vel.copy().mult(200));
    drawArrow(this.pos, velArrowEndpoint);

    stroke("#ae00ffff");
    let accArrowEndpoint = velArrowEndpoint.copy().add(this.acc.copy().mult(20000));
    drawArrow(velArrowEndpoint, accArrowEndpoint);


    fill('#ffffff');
    noStroke();
    textFont("menlo");
    textAlign(LEFT, TOP);

    text("Alt: " + round(p5.Vector.dist(ship.pos, bodies[closest_body].pos) - bodies[closest_body].radius) + " px", ship.pos.x + offset, ship.pos.y + offset);


    fill("#00ff22ff");

    offset = 3;
    text(
      "\nVel: " + round(ship.vel.mag() * 100) + " px/hectoframe",
      velArrowEndpoint.x + offset, velArrowEndpoint.y);


    this.drawShipBody(this.pos.x, this.pos.y, 255);

  }

  update() {

    this.acc.set(0, 0);

    this.acc.add(getGravitationalAccelerationFromAllBodies(ship));

    if (mouseIsPressed) {
      this.boosting = true;
      this.acc.add(this.orientation.copy().mult(this.rocket_acc));
    } else {
      this.boosting = false;
    }

    this.vel.add(this.acc);
    this.pos.add(this.vel);


    let cursorPos = camera.screenToWorld(mouseX, mouseY);

    cursorPos.sub(this.pos);

    // line(this.pos.x, this.pos.y, this.pos.x+(this.orientation.x*10), this.pos.y+(this.orientation.y*10))
    // console.log(this.orientation.heading());

    let angle = p5.Vector.angleBetween(this.orientation, cursorPos);

    let amt = TAU / 100;

    if (abs(angle) > amt) {
      if (angle > 0) {
        this.orientation.rotate(amt);
      } else if (angle < 0) {
        this.orientation.rotate(-amt);
      }
    }

    this.pos_history.push(this.pos.copy());
    this.vel_history.push(this.vel.copy());
    this.orientation_history.push(this.orientation.copy());
    this.boosting_history.push(this.boosting);


  }
}

function drawArrow(p1, p2) {

  line(p1.x, p1.y, p2.x, p2.y);

  push();
  translate(p2.x, p2.y);
  rotate(p2.copy().sub(p1.copy()).heading() - TAU / 4);

  line(0, 0, -5, -10);
  line(0, 0, 5, -10);

  pop();

}

class Body {

  constructor(pos, radius, mass, b_color) {
    this.pos = pos;
    this.radius = radius;
    this.b_color = b_color;
    this.mass = mass;
  }

  getSurfaceIntersectForAltitudeLine(objectPos) {
    return this.pos.copy().add(objectPos.copy().sub(this.pos.copy()).normalize().mult(this.radius));
  }

  getAltitude(pos) {
    return p5.Vector.dist(pos, this.pos) - this.radius;
  }

  getGravitationalAcceleration(object, bodyPos = this.pos) {
    let r = p5.Vector.sub(bodyPos, object.pos);

    let force = G * this.mass / r.magSq();

    return r.normalize().mult(force);
  }

  draw() {

    fill(this.b_color);
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

    this.minX = ship.pos.x;
    this.maxX = ship.pos.x;

    this.minY = ship.pos.y;
    this.maxY = ship.pos.y;

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

  screenToWorld(x, y) {

    x = (x - width / 2) / this.scaleFactor + this.centredObject.pos.x;
    y = (y - height / 2) / this.scaleFactor + this.centredObject.pos.y;

    return createVector(x, y);

  }

}

function getGravitationalAccelerationFromAllBodies(object) {

  let acceleration = createVector(0, 0);
  for (let body of bodies) {
    acceleration.add(body.getGravitationalAcceleration(object));
  }

  return acceleration;

}

class Particle {
  constructor(pos) {
    this.pos = pos;
    this.vel = createVector(0, 0);
    this.timer = particle_timer;
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
  if (event.delta > 0 && launched && !crashed_out) {
    framesToSkip = event.delta;
  }

  else if (event.delta < 0) {
    framesToSkip = event.delta;
    crashed_out = false;
  }
  // Uncomment to prevent any default behavior.
  return false;
}

function keyPressed(event) {
  if (key == 'p' & !crashed_out) {
    paused = !paused; // toggles
  }

  if (key == 'd') {
    display_path_change = !display_path_change; // toggles
  }
}


function draw() {

  background(0);

  // Camera

  // centred on body, but zooming in/out to keep ship trajectory inside a bounding box on screen
  camera.drawBbox();
  camera.applyToMatrix();



  // Rendering in camera

  // draw moon orbit
  for (let i = 0; i < moonOrbit.length; i++) {

    let moonPos = moonOrbit[(T + i) % moonOrbit.length];
    stroke(bodies[1].b_color);
    point(moonPos.x, moonPos.y);

  }

  let a = p5.Vector.dist(bodies[0].pos, bodies[1].pos);
  let m1 = bodies[0].mass;
  let m2 = bodies[1].mass;

  // draw hill sphere boundary
  let R = a * Math.cbrt(m2 / 3 * (m1 + m2));

  circle(bodies[1].pos.x, bodies[1].pos.y, R);



  for (let b = 0; b < bodies.length; b++) {
    bodies[b].draw();
  }

  stroke("#fff");
  strokeWeight(1);
  let surfaceIntersect = bodies[closest_body].pos.copy().add(ship.pos.copy().sub(bodies[closest_body].pos.copy()).normalize().mult(bodies[closest_body].radius));
  line(surfaceIntersect.x, surfaceIntersect.y, ship.pos.x, ship.pos.y);

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

  if (crashed_out) {
    textAlign(RIGHT, TOP);
    text("You have crashed.", ship.pos.x - offset, ship.pos.y + offset);
  }

  if (mouseIsPressed) {
    launched = true;
  }

  if (framesToSkip < 0) {

    let length = ship.pos_history.length;

    if (abs(framesToSkip) >= length) {
      framesToSkip = -length;
    }

    while (framesToSkip < -1) {
      ship.pos_history.pop();
      ship.vel_history.pop();
      ship.orientation_history.pop();
      ship.boosting_history.pop();
      T--;

      framesToSkip += 1;
    }

    if (T == 0) {
      launched = false;
      ship.boosting = false;
    }

    length = ship.pos_history.length;

    ship.pos = ship.pos_history[length - 1].copy();
    ship.vel = ship.vel_history[length - 1].copy();
    ship.orientation = ship.orientation_history[length - 1].copy();
    ship.boosting = ship.boosting_history[length - 1];

  } else {

    while (framesToSkip) {

      bodies[1].pos = moonOrbit[T % moonOrbit.length].copy();

      ship.update();


      // checking for landing or crash

      for (let b = 0; b < bodies.length; b++) {
        if (p5.Vector.dist(ship.pos, bodies[b].pos) - bodies[b].radius < ship.length / 2) {

          // if velocity below threshold and orientation has landing gear aligned with the ground, then the rocketship lands
          // otherwise, it is a crash

          let landingVelocityThreshold = 0.5;

          let velocity = ship.vel.mag();
          let upright = ship.pos.copy().sub(bodies[b].pos.copy()).normalize();
          let landingAngle = p5.Vector.angleBetween(ship.orientation, upright);

          if (velocity <= landingVelocityThreshold &&
            landingAngle < TAU / 8) {

            // reset velocity, position, and orientation based on landing spot
            ship.vel.set(0, 0);
            ship.orientation.set(upright.copy());
            ship.pos.set(bodies[b].pos.copy().add(upright.copy().mult(bodies[b].radius + ship.length / 2)));

            launched = false;

          } else {
            crashed_out = true;
            paused = true;
          }

          // landed
          console.log(velocity, landingAngle);



          break;
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


  // screenspace HUD


  fill('#ffffff');
  noStroke();
  textFont("menlo");
  let tString = "T = " + round(T / 100, 1) + " hectoframes since launch";
  if (paused) {
    tString += " (PAUSED)";
  }
  textAlign(LEFT, TOP);
  text(tString, 30, 30);

}