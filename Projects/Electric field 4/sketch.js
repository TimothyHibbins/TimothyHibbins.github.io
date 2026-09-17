function setup() {

  createCanvas(windowWidth, windowHeight);

  paused = false;

  charge1 = new Charge(createVector(width / 2, height / 2), createVector(0, 0.7), createVector(0, 0), 0.0001);

  spacing = width / 40;

  // Speed of Light
  c = 3;

  max_signals = 100;//sqrt( sq(width) + sq(height) ) / c;

  signals = [];
  testCharges = [];



  mousePos = createVector(0, 0);
  mouseVel = createVector(0, 0);
  mouseAcc = createVector(0, 0);

  mousePrevPos = createVector(0, 0);
  mousePrevVel = createVector(0, 0);


  for (var x = 0; x < width; x += spacing) {
    for (var y = 0; y < height; y += spacing) {

      testCharges.push(new TestCharge(x, y));

    }
  }

}

class Charge {

  constructor(pos, vel, acc, attractive_force_strength) {

    this.pos = pos;
    this.vel = vel;
    this.acc = acc;


    this.attractor = this.pos.copy();
    this.attractive_force_strength = attractive_force_strength;

  }

  render() {

    var arrow_scale = 10000;

    stroke('#EC2A2A');
    line(this.pos.x,
      this.pos.y,
      this.pos.x + this.acc.x * arrow_scale,
      this.pos.y + this.acc.y * arrow_scale
    )

    // Draws vector arrowhead
    push();

    translate(this.pos.x + this.acc.x * arrow_scale, this.pos.y + this.acc.y * arrow_scale);
    rotate(this.acc.heading());

    noStroke();
    fill('#EC2A2A')
    triangle(0, 4.5, 8, 0, 0, -4.5);

    pop();

    fill('#EC2A2A')
    noStroke();
    ellipseMode(CENTER);
    circle(this.pos.x, this.pos.y, 30);

    textAlign(CENTER, CENTER);
    textSize(25);
    fill(255);
    text('+', this.pos.x - 1, this.pos.y);


  }

  update() {


    this.acc = createVector(0, 0);
    this.acc = p5.Vector.sub(this.attractor, this.pos).mult(this.attractive_force_strength);
    // if (mouseIsPressed) {
    //   this.acc = p5.Vector.sub(mousePos, this.pos).mult(this.attractive_force_strength);
    // }

    //print(this.acc.mag());

    this.vel.add(this.acc);

    this.pos.add(this.vel);

    signals.push(new Signal(this.pos.copy(), this.acc.copy()));
    //print(signals.length);
  }

}

class TestCharge {

  constructor(x, y) {

    this.pos = createVector(x, y);
    this.vec = createVector(0, 0);
    this.origin = createVector(50, 50);

  }

  render() {

    let x = this.pos.x;
    let y = this.pos.y;

    // strokeWeight(0.5);
    // stroke('#A7E0FF');
    // line(x, y, this.origin.x, this.origin.y);

    // Draws point
    noStroke();
    fill('#FFD0D0');
    circle(x, y, 4);

    let strength = min(this.vec.mag() * 2, 1);

    if (this.vec.mag() > 0) {
      let arrowVec = this.vec.copy().normalize().mult((strength * spacing) - 10);

      // Draws vector line
      strokeWeight(3);

      stroke(0, 100, 200, 255 * strength);
      fill(0, 100, 200, 255 * strength);


      //line(x, y, x+arrowVec.x, y+arrowVec.y);

      // Draws vector arrowhead
      push();

      translate(x, y);
      rotate(this.vec.heading());

      line(0, 0, spacing * 0.5, 0);

      noStroke();
      triangle(spacing, 0, spacing * 0.5, spacing / 4, spacing * 0.5, -spacing / 4);

      pop();
    }

  }
}

class Signal {

  constructor(origin, vec) {

    this.origin = origin;
    this.vec = vec;
    this.radius = 0;

  }

  render() {

    ellipseMode(CENTER);

    noFill();

    stroke(0, 0, 0, 50);
    strokeWeight(0.5);

    colorMode(RGB);

    //stroke(255*(this.heading/360), 255, 255);

    circle(this.origin.x, this.origin.y, this.radius * 2);

    //print("working");

  }

  update() {

    this.radius += c;

  }
}

function draw() {

  if (!paused) {

    background(255);

    mousePos.set(mouseX, mouseY);

    //   mouseVel.set(mousePos.copy().sub(mousePrevPos));

    //   mouseAcc.set(mouseVel.copy().sub(mousePrevVel));

    for (var s = 0; s < signals.length; s++) {

      signals[s].render();
      signals[s].update();

    }

    if (signals.length > max_signals) {

      signals.shift();

    }

    //print(signals.length);

    for (var t = 0; t < testCharges.length; t++) {

      testCharges[t].render();


      // the following implements binary search to find the closest signal

      let minPossibleIndex = 0;
      let maxPossibleIndex = signals.length - 1;

      let index = null;

      let antiCrashTimer = 0;
      while ((minPossibleIndex != maxPossibleIndex) && antiCrashTimer < 100 && signals.length > 0) {
        antiCrashTimer += 1;


        index = minPossibleIndex + floor((maxPossibleIndex - minPossibleIndex) / 2);

        // distance between the test charge and the origin of the guessed signal
        let distance = signals[index].origin.dist(testCharges[t].pos);

        let range = signals[index].radius;

        // if test charge is within range of the test signal
        if (range >= distance) {

          if (index == minPossibleIndex) {
            break;
          } else {
            // correct index must be either this or higher (this signal or later signal)
            minPossibleIndex = index;
          }

        } else { // reaching else means the test charge is beyond the range of the test signal

          // correct index must be lower (earlier signal)

          // if the earliest signal is not in range, then no signal is
          if (index == 0) {
            index = null;
            break;
          } else { // if this signal was not in range, then the latest possible signal is the one just before this
            //index -= 1;
            maxPossibleIndex = index;
          }

        }

      }

      // if there is NO signal in range, set vector to (0, 0)
      if (index == null) {

        testCharges[t].vec.set(0, 0);

      } else { // else, set vector based on the signal with this index

        let distance = signals[index].origin.dist(testCharges[t].pos);

        let vecFromSignalOriginToTestCharge = p5.Vector.sub(signals[index].origin, testCharges[t].pos);

        let effectVec = createVector(0, 0);

        if (signals[index].vec.mag() > 0) {
          let theta = signals[index].vec.angleBetween(vecFromSignalOriginToTestCharge);

          let componentMag = sin(abs(theta));

          // would be reverse if charge was negative
          if (theta > 0) {

            theta += TAU / 4;

          } else if (theta < 0) {

            theta -= TAU / 4;

          }

          effectVec = signals[index].vec.copy().rotate(theta).mult(componentMag / (distance / spacing / 500));
        }

        // angle between signal vector and line between signal origin and test charge


        testCharges[t].vec.set(effectVec);
        testCharges[t].origin = signals[index].origin.copy();

      }

    }

    // mousePrevPos.set(mousePos.copy());
    // mousePrevVel.set(mouseVel.copy());

    charge1.render();
    charge1.update();
    // charge1.x = mouseX;
    // charge1.y = mouseY;
    // charge1.pos.set(mouseX, mouseY);

  }

  fill(0);
  rect(50, 50, frameRate(), 10);
}

function mouseClicked() {
  paused = !paused;
  //saveGif('light_test', 5)
}