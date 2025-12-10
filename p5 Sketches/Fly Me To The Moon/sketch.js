/*

Bugs to fix:
- -0.1 hf bug when scrolling back to start


Feature to-do list:
- orbital description HUD
  - elliptical:
    - eccentricity, periapsis, apoapsis, period
  - escape:
  - collision trajectory
    - time to impact, impact velocity

- show projection for how orbit will *shift* as you boost
- dynamic camera
- visualise gravity
- show velocity and gravitational force vectors
- reset button


Finished features:
- collision detection for planet
- ship HUD
  - velocity, altitude relative to planet
- scroll backwards in time

*/



var G = 75 // gravitational constant

var paused = false;

var launched = false;

var crashed_out = false;

var display_path_change = false;

var framesToSkip = 0;

var T = 0;

var particles = [];

var particle_pulse_frequency = 300;
var particle_timer = particle_pulse_frequency;

var bodies = [];

function setup() {

  createCanvas(windowWidth, windowHeight);
  fullscreen(true);


  bodies.push(new Body(createVector(400, 400), 100, 1, color('#21CC43'))); // Earth
  // bodies.push(new Body(createVector(width/5, height/5), 50, 0.25, color('#FFEB3B'))); // Moon

  l = 50;
  ship = new Ship(createVector(bodies[0].pos.x, bodies[0].pos.y - bodies[0].radius - l / 2), l);

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

    this.rocket_acc = 0.01;
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

  }

  drawShipBody(x, y, alphaValue, ghost = false) {

    var l = this.length;
    var w = this.s_width;

    push();
    translate(x, y);
    rotate(this.orientation.heading() + TAU / 4);

    noStroke();
    if (this.boosting) {

      var trail_length = l * (random(0.9, 1.2));
      var t = trail_length;

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

    var projection = new Projection(this.pos.copy(), this.vel.copy());

    var initial_pos = projection.pos.copy();

    var periapsis = this.pos.copy();

    var closest_body = 0;
    var periapsis_alt = 0;
    for (var b = 0; b < bodies.length; b++) {
      let distToBody = this.pos.dist(bodies[b].pos);
      if (distToBody < periapsis_alt) {
        periapsis_alt = distToBody;
        closest_body = b;
      }

    }
    var apoapsis = this.pos.copy();
    var apoapsis_alt = 0;

    strokeWeight(1);

    var lineColor = color('#00F6FF');
    stroke(lineColor);

    var trajectory = '';
    for (var i = 0; i < 5000; i++) {

      if (i > 50) {
        if (p5.Vector.dist(initial_pos, projection.pos) < 5) {
          trajectory = 'Orbit';
          break;
        }
      }

      let r = p5.Vector.sub(bodies[closest_body].pos, projection.pos);
      let alt = r.mag() - bodies[closest_body].radius;

      if (alt < this.length / 2) {
        trajectory = 'Collision Course';
        break;
      }

      if (alt < periapsis_alt) {
        periapsis = projection.pos.copy();
        periapsis_alt = alt;
      } else if (alt > apoapsis_alt) {
        apoapsis = projection.pos.copy();
        apoapsis_alt = alt;
      }

      projection.vel.add(getGravitationalAcceleration(projection));
      projection.pos.add(projection.vel);

      point(projection.pos.x, projection.pos.y);

      if ((T + i) % 100 == 0) {
        this.drawShipBody(projection.pos.x, projection.pos.y, 60, true);
      } else if ((T + i) % 10 == 0) {
        this.drawShipBody(projection.pos.x, projection.pos.y, 10, true);
      }


      // this.drawShipBody(projection_pos.x, projection_pos.y, 10 * ((i%100)/100), true);


    }


    let offset = this.length / 2;
    stroke('#00F6FF');
    noFill();
    textFont("menlo");
    textAlign(LEFT, BOTTOM);

    if (trajectory == 'Orbit') {

      text("Orbit\n" +
        "Period: " + round(i / 100, 1) + " hectoframes\n" +
        "Periapsis: " + round(periapsis_alt) + "px\n" +
        "Apoapsis: " + round(apoapsis_alt) + "px",
        this.pos.x + offset, this.pos.y - offset);

    } else if (trajectory == 'Collision Course') {

      text("Collision Course\n" +
        "Time to impact: : " + round(i / 100, 1) + " hectoframes\n" +
        "Impact velocity: " + round(projection.vel.mag(), 2) + " px/hectoframes",
        this.pos.x + offset, this.pos.y - offset);

    }

    if (this.boosting & display_path_change) {

      for (var j = 0; j < 20; j += 2) {

        projection.pos = this.pos.copy();
        projection.vel = this.vel.copy();

        initial_pos = projection.pos.copy();

        strokeWeight(1);
        lineColor.setAlpha(alpha(lineColor) - 20);
        stroke(lineColor);

        for (var i = 0; i < 5000; i++) {

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

          projection.vel.add(getGravitationalAcceleration(projection.pos));

          if (i <= j) {
            projection.vel.add(this.orientation.copy().mult(this.rocket_acc));
          }

          projection.pos.add(projection.vel);

          point(projection.pos.x, projection.pos.y);

        }
      }

    }

    this.drawShipBody(this.pos.x, this.pos.y, 255);

  }

  update() {

    if (mouseIsPressed) {
      this.boosting = true;
      this.vel.add(this.orientation.copy().mult(this.rocket_acc));
    } else {
      this.boosting = false;
    }


    this.pos.add(this.vel)


    var cursorPos = createVector(mouseX, mouseY);

    cursorPos.sub(this.pos);

    // line(this.pos.x, this.pos.y, this.pos.x+(this.orientation.x*10), this.pos.y+(this.orientation.y*10))
    // console.log(this.orientation.heading());

    var angle = p5.Vector.angleBetween(this.orientation, cursorPos);

    var amt = TAU / 100;

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

class Body {

  constructor(pos, radius, mass, b_color) {
    this.pos = pos;
    this.radius = radius;
    this.b_color = b_color;
    this.mass = mass;
  }

  draw() {

    fill(this.b_color);
    noStroke();
    circle(this.pos.x, this.pos.y, this.radius * 2);

  }

}

function getGravitationalAcceleration(object) {

  let acceleration = createVector(0, 0);
  for (var b = 0; b < bodies.length; b++) {
    let r = p5.Vector.sub(bodies[b].pos, object.pos);

    let force = G * bodies[b].mass / r.magSq();
    acceleration.add(r.normalize().mult(force));
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

    this.vel.add(getGravitationalAcceleration(this));

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
  // return false;
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

  stroke('#ffffff');
  noFill();
  textFont("menlo");
  let tString = "T = " + round(T / 100, 1) + " hectoframes since launch";
  if (paused) {
    tString += " (PAUSED)";
  }
  textAlign(LEFT, TOP);
  text(tString, 30, 30);

  for (var b = 0; b < bodies.length; b++) {
    bodies[b].draw();
  }

  ship.draw();

  for (var i = 0; i < particles.length; i++) {
    particles[i].draw();
  }

  let offset = ship.length / 2;
  stroke('#ffffff');
  noFill();
  textFont("menlo");
  textAlign(LEFT, TOP);
  text("Alt: " + round(p5.Vector.dist(ship.pos, bodies[0].pos) - bodies[0].radius) + " px" +
    "\nVel: " + round(ship.vel.mag() * 100) + " px/hectoframe",
    ship.pos.x + offset, ship.pos.y + offset);

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

      ship.vel.add(getGravitationalAcceleration(ship));

      ship.update();
      for (var b = 0; b < bodies.length; b++) {
        if (p5.Vector.dist(ship.pos, bodies[b].pos) - bodies[b].radius < ship.length / 2) {
          paused = true;
          crashed_out = true;
          break;
        }
      }


      //       if (T % particle_pulse_frequency == 0) {
      //         // horizontal gridlines
      //         for (var y = 0; y < height; y+= height/10) {
      //           for (var x = 0; x < height; x+= height/100) {
      //               particles.push(new Particle(createVector(x, y)));
      //           }
      //         }
      //         // vertical gridlines
      //         for (var x = 0; x < height; x+= height/10) {
      //           for (var y = 0; y < height; y+= height/100) {
      //               particles.push(new Particle(createVector(x, y)));
      //           }
      //         }


      //       }
      particles.push(new Particle(createVector(random(0, width), random(0, height))));


      for (var i = 0; i < particles.length; i++) {
        particles[i].update();

      }

      for (var i = 0; i < particles.length; i++) {
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

}