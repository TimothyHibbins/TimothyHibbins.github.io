let M = 75; // pixels per metre


let steeringWheelAngle = 0;
let handGripLevel = 0; // between 0 and 1
let currentAngle;

let HAND_MODE = "hand mode";
let ARROW_MODE = "arrow mode";
let MODES = [
  HAND_MODE,
  ARROW_MODE
];
let selectedMode = 0;

let steeringWheelLock;

const MAX_ACCEL = 10 * M; // metres per second? per second acceleration at full throttle
let throttle = 0; // throttle applied between zero and one
let v = 0; // forward speed in pixels

const MAX_BRAKE = 20 * M; // metres per second per second deacceleration at full braking
let brake = 0; // brake applied between zero and one

let zoom = 0.15;

let leftWheelAngle = 0;
let rightWheelAngle = 0;

let prevLS = false;

let justStarted = true;

let carPosOnScreen;
let steeringWheelDisplayCentre;
let steeringWheelDisplayRadius;

FRONT_LEFT = "front left";
FRONT_RIGHT = "front right";
REAR_LEFT = "rear left";
REAR_RIGHT = "rear right";


let skidLines = {
  [FRONT_LEFT]: false,
  [FRONT_RIGHT]: false,
  [REAR_LEFT]: false,
  [REAR_RIGHT]: false,
};

let fullTurnToDisplacementRatio = -12;


let car = {};

let steeringWheelRadius = 75;



let dt = 1 / 60;




// --- grip params (tune these) ---
let mu = 0.9;               // friction coefficient (0.6..1.2 typical)
let skidLateralGain = 0.6;  // how much sideways velocity we add when skidding (0..1)
let g = 9.81;               // gravity (m/s^2)


let track;

// gamepad buttons

const R3 = 11;

const DPAD_UP = 12;
const DPAD_DOWN = 13;
const DPAD_LEFT = 14;
const DPAD_RIGHT = 15;

const X_BUTTON = 0;
const CIRCLE_BUTTON = 1;
const SQUARE_BUTTON = 2;
const TRIANGLE_BUTTON = 3;

let gamepadButtonMappings;
let prevGamepadButtonState = {};

function preload() {
  img = loadImage("wheel.png");
}



function setup() {
  createCanvas(windowWidth, windowHeight);

  gamepadButtonMappings = {
    [CIRCLE_BUTTON]: () => cycleMode(),
    // [DPAD_UP]: () => cameraFOV += radians(5),
    // [DPAD_DOWN]: () => cameraFOV -= radians(5),
    // [DPAD_LEFT]: () => changeSens(-1),
    // [DPAD_RIGHT]: () => changeSens(1),

    // [CIRCLE_BUTTON]: () => toggle(overlaysToDisplay, "gamepadOverlay")
  }

  steeringWheelLock = TAU * 1.2; // can perform two full rotations of the wheel either way before it locks



  car.pos = createVector(0, 0);

  car.ICR_pos = false;

  car.lateralVel = 0; // sideways speed in pixels/sec (positive = left)


  car.heading = radians(0);

  car.rackWidth = M * 1.5;
  car.steeringColumnLength = M * 2;
  car.steeringArmLength = M / 2;

  car.tireWidth = M / 2;


  car.frontAxelY = -car.steeringColumnLength - M * 0.6;



  car.rearAxelY = car.steeringColumnLength + M * 0.6;

  car.wheelbase = car.rearAxelY - car.frontAxelY;

  car.trackWidth = M * 4;

  car.fullTurnToDisplacementRatio = -20;
  car.rackDisplacement = (steeringWheelAngle / TAU) * fullTurnToDisplacementRatio;


  car.leftWheelPivot = createVector(-car.trackWidth / 2, car.frontAxelY);
  car.rightWheelPivot = createVector(car.trackWidth / 2, car.frontAxelY);


  car.rearLeftWheel = createVector(-car.trackWidth / 2, car.rearAxelY);
  car.rearRightWheel = createVector(car.trackWidth / 2, car.rearAxelY);


  let A = car.rearAxelY - car.frontAxelY;
  let O = car.trackWidth / 2;

  let H = sqrt(sq(O) + sq(A));

  let test = asin(O / H);// - TAU/4;
  // console.log(degrees(test));

  car.neutralSteeringArmAngle = test;


  let meetingPoint = car.leftWheelPivot.copy().add(createVector(0, car.steeringArmLength).rotate(-car.neutralSteeringArmAngle));
  car.tieRodLength = dist(meetingPoint.x, meetingPoint.y, -car.rackWidth / 2, -car.steeringColumnLength);

  carPosOnScreen = createVector(width / 2, height * 2 / 3);
  steeringWheelDisplayCentre = createVector(width / 2, height * 5 / 6);
  steeringWheelDisplayRadius = height / 10;

  track = [

    // Monaco
    new Turn(360101.02078975295, 0.07896110894552388, RIGHT_HANDER),
    new Turn(17354.878700783545, 0.5541687775400661, RIGHT_HANDER),
    new Turn(1868.756196787337, 0.7238925018032576, LEFT_HANDER),
    new Turn(6529.469903181356, 0.4571919934601417, RIGHT_HANDER),
    new Turn(1552.6850066380373, 1.835439816499032, RIGHT_HANDER),
    new Turn(2902.9488551045083, 0.7842722293958156, LEFT_HANDER),
    new Turn(468379.67883282877, 0.05962402916261788, LEFT_HANDER),
    new Turn(31162.40762747087, 0.343620642673476, RIGHT_HANDER),
    new Turn(5719.252920534313, 0.5832831941114889, LEFT_HANDER),
    new Turn(47692.27049186423, 0.40134658000507417, RIGHT_HANDER),
    new Turn(29069.030226330506, 0.5358709667944502, LEFT_HANDER),
    new Turn(6793.0531400683785, 1.5170940361596965, LEFT_HANDER),
    new Turn(357849.1497830284, 0.026306743889464516, LEFT_HANDER),
    new Turn(9099.45867576991, 1.2719971383293078, RIGHT_HANDER),
    new Turn(601549.5661226813, 0.040275797671434195, RIGHT_HANDER),
    new Turn(3489.1391859080386, 1.1770024972141306, RIGHT_HANDER),
    new Turn(2861.7169572352764, 1.4868744523023774, RIGHT_HANDER),
    new Turn(7739.936601408139, 0.9393790484134577, LEFT_HANDER),
    new Turn(13534.524107504709, 0.40315748227380876, RIGHT_HANDER),
    new Turn(1544.4087187867324, -2.966019185603406, LEFT_HANDER),
    new Turn(34263.670161790425, 0.21084949970923478, LEFT_HANDER),
    new Turn(3370.893282647503, 1.6885825764588318, RIGHT_HANDER),
    new Turn(11239.868747608722, 0.7416765439144127, RIGHT_HANDER),
    new Turn(4070.9972250614437, 1.5940628346791559, RIGHT_HANDER),
    new Turn(355890.5140136667, 0.07499379998693516, RIGHT_HANDER),
    new Turn(29786.056014086378, 0.7662754912402688, RIGHT_HANDER),
    new Turn(104003.82788703231, 0.4134578604417608, RIGHT_HANDER),
    new Turn(1606.4261808452159, 1.6393577503256256, LEFT_HANDER),
    new Turn(1362.0795711089745, 1.521215786604327, RIGHT_HANDER),
    new Turn(7252.186534198938, 0.6569410049314163, RIGHT_HANDER),
    new Turn(6353.248147465008, 0.5165470627876683, LEFT_HANDER),
    new Turn(996242.9562154525, 0.031925803787656866, LEFT_HANDER),
    new Turn(2484.571962213284, 0.6980199089391976, LEFT_HANDER),
    new Turn(19553.561490867676, 1.1310467865026468, LEFT_HANDER),
    new Turn(5199.005567920678, 0.7897416366437144, LEFT_HANDER),
    new Turn(2014.1154878510642, 1.1571372095977572, RIGHT_HANDER),
    new Turn(108780.0224477731, 0.16668274610053702, LEFT_HANDER),
    new Turn(2180.397915813115, 1.5913979422892062, RIGHT_HANDER),
    new Turn(1838.404712248336, 1.4810805104328566, LEFT_HANDER),
    new Turn(24993.24914148657, 0.8709299037574135, LEFT_HANDER),
    new Turn(3890.934843214987, 0.4511564339439602, LEFT_HANDER),
    new Turn(2810.6955276339913, 1.2609400065141299, RIGHT_HANDER),
    new Turn(2487.5345206009965, 1.4656601942052494, RIGHT_HANDER),
    new Turn(207243.49356662, 0.040642367719148746, RIGHT_HANDER),
    new Turn(2486.810313523372, 1.9111283728480555, RIGHT_HANDER),
    new Turn(5658.257939436994, 1.151520606098606, LEFT_HANDER),
    new Turn(3344.4636286069667, 0.7302326140478155, RIGHT_HANDER),
    new Turn(53324.03530122656, 0.1762438819371315, LEFT_HANDER),
    new Turn(39512.779944379356, 0.4447317499154917, RIGHT_HANDER),

  ];

}

const TURN = "turn";
const STRAIGHT = "straight";

const LEFT_HANDER = -1;
const RIGHT_HANDER = 1;

class TrackSegment {

  constructor(segmentType) {
    this.segmentType = segmentType;
  }

}

class Turn extends TrackSegment {

  constructor(radius, angle, direction) {

    super(TURN);

    this.radius = radius;
    this.angle = angle;
    this.direction = direction;


  }

}

class Straight extends TrackSegment {

  constructor(length) {

    super(STRAIGHT);

    this.length = length;

  }


}

function drawTrack(x, y, track) {

  strokeWeight(M * 30);
  strokeCap(SQUARE);
  stroke("#727272C6");
  noFill();

  push();

  translate(x, y)

  for (let [i, trackSegment] of track.entries()) {

    if (trackSegment.segmentType == STRAIGHT) {

      line(0, 0, 0, -trackSegment.length);

      translate(0, -trackSegment.length);

    } else if (trackSegment.segmentType == TURN) {

      // console.log(trackSegment);
      let angles = {
        [LEFT_HANDER]: { start: -trackSegment.angle, stop: 0 },
        [RIGHT_HANDER]: { start: TAU / 2, stop: TAU / 2 + trackSegment.angle },
      }

      // draw red and white curbs
      strokeWeight(M * 35);

      let anglePerColourSwitch = radians(1);
      const RED = "red";
      const WHITE = "white";

      if (i == -1) {

        let currentColor = RED;

        for (
          let a = angles[trackSegment.direction].start;
          a < angles[trackSegment.direction].stop;
          a += trackSegment.direction * anglePerColourSwitch
        ) {

          if (currentColor == RED) {
            stroke("#ff2121ff");
            currentColor = WHITE;
          } else {
            stroke("#e7e7e7ff");
            currentColor = RED;
          }



          arc(trackSegment.radius * trackSegment.direction, 0,
            trackSegment.radius * 2, trackSegment.radius * 2,
            a,
            a + anglePerColourSwitch);


        }

      }



      strokeWeight(M * 31);
      stroke("#e5e5e5ff");
      arc(trackSegment.radius * trackSegment.direction, 0,
        trackSegment.radius * 2, trackSegment.radius * 2,
        angles[trackSegment.direction].start,
        angles[trackSegment.direction].stop);

      strokeWeight(M * 30);
      stroke("#727272ff");
      arc(trackSegment.radius * trackSegment.direction, 0,
        trackSegment.radius * 2, trackSegment.radius * 2,
        angles[trackSegment.direction].start,
        angles[trackSegment.direction].stop);






      translate(trackSegment.radius * trackSegment.direction, 0);
      rotate(trackSegment.angle * trackSegment.direction);
      translate(-trackSegment.radius * trackSegment.direction, 0);

    }

  }

  pop();

}

function angleDiff(a, b) {
  return atan2(sin(a - b), cos(a - b));
}

function drawSteeringWheel(pos, angle, radius) {

  // strokeWeight(radius / 4);
  // noFill();

  push();
  translate(pos.x, pos.y);
  rotate(angle);

  // circle(0, 0, radius * 2);
  // line(-radius, 0, radius, 0);
  // line(0, 0, 0, 0 + radius);
  image(img, -125, -125, 250, 250);

  pop();



}

function resetCar() {
  car.pos.set(0, 0);

  car.lateralVel = 0;

  v = 0;

  car.heading = radians(0);

}

function drawSpeedometer(x, y, diameter) {

  let radius = diameter / 2;

  fill("#000000ff");
  circle(x, y, diameter);
  fill("#646464ff");
  circle(x, y, diameter / 10);

  fill("#1cf5f9ff");
  text("km/h", x, y + diameter / 2 - diameter / 6);

  stroke("#1cf5f9ff");
  strokeWeight(2);
  noFill();
  // arc(x, y, diameter * 0.8, diameter * 0.8, radians(90 + 45), radians(45));

  let maxSpeed = 200;
  let start = -135;
  let stop = 135;
  let angularRange = stop - start;
  let ticks = 10;
  let angularIncrementPerTick = angularRange / ticks;
  let tick = 0;

  for (let a = start; a <= stop; a += angularIncrementPerTick) {
    push();
    translate(x, y);
    rotate(radians(a));
    translate(0, -radius * 0.8);

    line(0, 0, 0, -radius * 0.05);

    translate(0, radius * 0.15)
    rotate(-radians(a));
    textSize(15);
    textAlign(CENTER, CENTER);
    noStroke();
    fill("#1cf5f9ff");
    text(tick / ticks * maxSpeed, 0, 0);

    pop();

    tick += 1;
  }

  let currentSpeed = v / M * 3600 / 1000;

  push();
  translate(x, y);
  rotate(radians(start + (currentSpeed / maxSpeed * angularRange)));
  fill("#ff1d1dff");
  noStroke();
  triangle(
    0, -radius,
    radius / 30, radius * 0.2,
    -radius / 30, radius * 0.2
  );
  pop();




}

function cycleMode() {
  selectedMode += 1;
  if (selectedMode >= MODES.length) selectedMode = 0;
}

function updateGamepad() {
  const gps = navigator.getGamepads();
  if (!gps) return;

  const gp = gps[0];
  if (!gp) return;



  gp.buttons.forEach((btn, i) => {
    const wasPressed = prevGamepadButtonState[i] || false;
    const isPressed = btn.pressed;

    // Button was pressed this frame *but not* last frame
    const justPressed = isPressed && !wasPressed;

    if (justPressed && gamepadButtonMappings[i]) {
      gamepadButtonMappings[i]();    // call your anonymous function
    }

    // Store for next frame
    prevGamepadButtonState[i] = isPressed;
  });



}

function updateSteeringAndThrottleFromInput() {


  currentAngle = false;
  let prevAngle = false;

  let gamepads = navigator.getGamepads();
  if (gamepads[0]) {
    let gp = gamepads[0];


    let leftTrigger = gp.buttons[6].value;
    brake = leftTrigger;

    let rightTrigger = gp.buttons[7].value;
    // console.log(rightTrigger);
    throttle = rightTrigger;


    let ls = createVector(gp.axes[0], gp.axes[1]);// left stick
    // let rs = createVector(gp.axes[2], gp.axes[3]);// right stick

    if (ls.mag() > 0.3) {
      handGripLevel = constrain(ls.mag(), 0, 1);
      currentAngle = ls.heading();
      prevAngle = false;
    } else {
      handGripLevel = 0;
    }

    if (ls.mag() > 0.95) {

      if (justStarted) {
        justStarted = false;
      } else if (prevLS) {

        currentAngle = ls.heading();
        prevAngle = prevLS.heading();

      }

    } else {

      justStarted = true;

    }



    prevLS = ls.copy();


  } else if (mouseIsPressed) {

    if (justStarted) {
      justStarted = false;
    } else {
      currentAngle = createVector(mouseX - steeringWheelDisplayCentre.x, mouseY - steeringWheelDisplayCentre.y).heading();

      prevAngle = createVector(pmouseX - steeringWheelDisplayCentre.x, pmouseY - steeringWheelDisplayCentre.y).heading();


    }

  }

  if (MODES[selectedMode] == HAND_MODE) {

    if (currentAngle && prevAngle) {
      steeringWheelAngle += angleDiff(currentAngle, prevAngle);

      steeringWheelAngle = constrain(steeringWheelAngle, -steeringWheelLock, steeringWheelLock);
    } else {

      steeringWheelAngle *= 1 - 0.05 * (1 - handGripLevel);

      if (abs(steeringWheelAngle) < radians(2)) {
        steeringWheelAngle = 0;
      }

    }

  } else if (MODES[selectedMode] == ARROW_MODE) {

    if (currentAngle) {

      if (currentAngle < TAU / 4) {
        steeringWheelAngle = TAU / 4 + currentAngle;
      } else {
        steeringWheelAngle = - TAU / 2 + (currentAngle - TAU / 4);
      }


    } else {
      steeringWheelAngle = 0;
    }

  }




}

function drawCar(c) {

  push();

  translate(car.pos.x, car.pos.y);
  rotate(car.heading);

  c.rackDisplacement = (steeringWheelAngle / TAU) * fullTurnToDisplacementRatio;

  let leftTieRodRackConnection = createVector(-c.rackWidth / 2 + c.rackDisplacement, -c.steeringColumnLength);
  let rightTieRodRackConnection = createVector(c.rackWidth / 2 + c.rackDisplacement, -c.steeringColumnLength);

  let AC = leftTieRodRackConnection.x - car.leftWheelPivot.x;
  let AD = car.steeringArmLength;
  let DB = car.tieRodLength;
  let CB = leftTieRodRackConnection.y - car.leftWheelPivot.y;

  let H = sqrt(sq(CB) + sq(AC)); // hypotenuse

  // console.log(DB, AC, CB, H);

  let theta = asin(CB / H);

  let phi = acos(
    (sq(H) + sq(AD) - sq(DB)) /
    (2 * H * AD)
  );


  leftWheelAngle = -TAU / 4 + theta + phi + car.neutralSteeringArmAngle;


  AC = rightTieRodRackConnection.x - car.rightWheelPivot.x;
  AD = car.steeringArmLength;
  DB = car.tieRodLength;
  CB = rightTieRodRackConnection.y - car.rightWheelPivot.y;

  H = sqrt(sq(CB) + sq(AC)); // hypotenuse

  // console.log(DB, AC, CB, H);

  theta = asin(CB / H);

  phi = acos(
    (sq(H) + sq(AD) - sq(DB)) /
    (2 * H * AD)
  );

  rightWheelAngle = TAU / 4 - theta - phi - car.neutralSteeringArmAngle;




  // body
  fill("#ffffffff");
  noStroke();
  rect(-c.trackWidth / 4, c.frontAxelY, c.trackWidth / 2, c.rearAxelY - c.frontAxelY);


  strokeWeight(M * 0.07);
  // front axel
  stroke("#f5f5f5ff");
  line(-c.trackWidth / 2, c.frontAxelY, c.trackWidth / 2, c.frontAxelY);

  // rear axel
  line(-c.trackWidth / 2, c.rearAxelY, c.trackWidth / 2, c.rearAxelY);


  stroke("#FF00E7");
  strokeWeight(M * 0.02);

  // rear axel
  line(-M * 50, c.rearAxelY, M * 50, c.rearAxelY);


  strokeWeight(M * 0.15);
  stroke("#8BC34A");


  // rack
  line(-c.rackWidth / 2 + c.rackDisplacement, -c.steeringColumnLength, c.rackWidth / 2 + c.rackDisplacement, -c.steeringColumnLength);

  stroke("#E91E63");


  // Steering column/shaft
  line(0, 0, 0, -c.steeringColumnLength);

  stroke("#3F51B5");

  let leftSteeringArmTieRodConnection = car.leftWheelPivot.copy().add(createVector(0, c.steeringArmLength).rotate(-c.neutralSteeringArmAngle + leftWheelAngle));
  // left wheel steering arm
  line(car.leftWheelPivot.x, car.leftWheelPivot.y,
    leftSteeringArmTieRodConnection.x, leftSteeringArmTieRodConnection.y);

  let rightSteeringArmTieRodConnection = car.rightWheelPivot.copy().add(createVector(0, c.steeringArmLength).rotate(c.neutralSteeringArmAngle + rightWheelAngle));
  // right wheel steering arm
  line(car.rightWheelPivot.x, car.rightWheelPivot.y,
    rightSteeringArmTieRodConnection.x, rightSteeringArmTieRodConnection.y);

  stroke("#3CFF0F");
  strokeWeight(M * 0.03);
  let leftTest = car.leftWheelPivot.copy().add(createVector(0, M * 10).rotate(-c.neutralSteeringArmAngle + leftWheelAngle));
  line(car.leftWheelPivot.x, car.leftWheelPivot.y,
    leftTest.x, leftTest.y);

  let rightTest = car.rightWheelPivot.copy().add(createVector(0, M * 10).rotate(c.neutralSteeringArmAngle + rightWheelAngle));
  line(car.rightWheelPivot.x, car.rightWheelPivot.y,
    rightTest.x, rightTest.y);

  strokeWeight(M * 0.1);
  stroke("#21E7E0");
  // left tie rod
  line(leftSteeringArmTieRodConnection.x, leftSteeringArmTieRodConnection.y,
    leftTieRodRackConnection.x, leftTieRodRackConnection.y);

  // right tie rod
  line(rightSteeringArmTieRodConnection.x, rightSteeringArmTieRodConnection.y,
    rightTieRodRackConnection.x, rightTieRodRackConnection.y);


  stroke("#000000");
  // left wheel pivot
  point(car.leftWheelPivot.x, car.leftWheelPivot.y);

  // right wheel pivot
  point(car.rightWheelPivot.x, car.rightWheelPivot.y);

  let tireRadius = M * 0.75;
  let tireWidth = M / 2;




  push();
  translate(car.leftWheelPivot.x, car.leftWheelPivot.y);
  rotate(leftWheelAngle);
  stroke("#FF00E7");
  strokeWeight(M * 0.02);
  line(-M * 50, 0, M * 50, 0);

  translate(-car.leftWheelPivot.x, -car.leftWheelPivot.y);
  // left wheel

  noStroke();
  fill(0);
  rect(car.leftWheelPivot.x - tireWidth, car.leftWheelPivot.y - tireRadius, tireWidth, tireRadius * 2, 5);

  pop();

  push()
  translate(car.rightWheelPivot.x, car.rightWheelPivot.y);



  rotate(rightWheelAngle);

  stroke("#FF00E7");
  strokeWeight(M * 0.02);
  line(-M * 50, 0, M * 50, 0);

  translate(-car.rightWheelPivot.x, -car.rightWheelPivot.y);

  noStroke();
  fill(0);

  // right wheel
  rect(car.rightWheelPivot.x, car.rightWheelPivot.y - tireRadius, tireWidth, tireRadius * 2, 5);

  pop();

  // rear wheels


  noStroke();
  fill(0);

  // rear left
  rect(-c.trackWidth / 2 - tireWidth, c.rearAxelY - tireRadius, tireWidth, tireRadius * 2, 5);

  // rear right
  rect(c.trackWidth / 2, c.rearAxelY - tireRadius, tireWidth, tireRadius * 2, 5);


  fill(255);
  stroke(0);
  text(round(degrees(leftWheelAngle), 1) + "°", car.leftWheelPivot.x, car.leftWheelPivot.y);
  text(round(degrees(rightWheelAngle), 1) + "°", car.rightWheelPivot.x, car.rightWheelPivot.y);

  let steeringWheelPos = createVector(0, 0);
  stroke("#000000");
  drawSteeringWheel(steeringWheelPos, steeringWheelAngle, M);

  pop();


}

function mousePressed() {

  justClicked = true;

}

function mouseWheel(e) {

  if (e.delta > 0) {
    zoom *= 1.1;
  } else {
    zoom *= 0.9;
  }

}

// ---------- helpers (put near the top of your file) ----------
function rotateVector(v, angle) {
  // rotate a p5.Vector v by 'angle' radians around the origin and return a new vector
  let r = createVector();
  r.x = v.x * cos(angle) - v.y * sin(angle);
  r.y = v.x * sin(angle) + v.y * cos(angle);
  return r;
}

// Robust line intersection using direction vectors (never uses tan)
function lineIntersection(p1, a1, p2, a2) {
  // p1, p2: objects/vectors with .x and .y
  // a1, a2: absolute angles in p5-space (radians), where (cos(a), sin(a)) is direction
  let ux = cos(a1), uy = sin(a1);
  let vx = cos(a2), vy = sin(a2);

  let denom = ux * vy - uy * vx;
  if (abs(denom) < 1e-9) return null; // nearly parallel

  let dx = p2.x - p1.x;
  let dy = p2.y - p1.y;

  // t solves p1 + t*u = p2 + s*v
  let t = (dx * vy - dy * vx) / denom;
  return { x: p1.x + ux * t, y: p1.y + uy * t };
}

function mix(a, b, t) { return a + (b - a) * t; }

function updateCarFromPhysics() {
  let wheelbase = car.wheelbase;
  let trackWidth = car.trackWidth;
  let phi = car.heading;       // 0 = North
  let pos = car.pos;

  // --- 1. Update speed ---
  v += throttle * MAX_ACCEL * dt;
  v -= brake * MAX_BRAKE * dt;
  v -= v / 300; // simple drag

  if (v < 0) {
    v = 0;
  }

  // --- 2. Compute world positions of front wheels ---
  let FL_world = p5.Vector.add(pos, rotateVector(car.leftWheelPivot.copy().add(-car.tireWidth / 2, 0), phi));
  let FR_world = p5.Vector.add(pos, rotateVector(car.rightWheelPivot.copy().add(car.tireWidth / 2, 0), phi));

  let RL_world = p5.Vector.add(pos, rotateVector(car.rearLeftWheel.copy().add(-car.tireWidth / 2, 0), phi));
  let RR_world = p5.Vector.add(pos, rotateVector(car.rearRightWheel.copy().add(car.tireWidth / 2, 0), phi));


  // --- 3. Wheel directions in world space ---
  let dirFL = phi + leftWheelAngle;
  let dirFR = phi + rightWheelAngle;

  // --- 4. Compute ICR ---
  let epsilon = 1e-6;
  let omega = 0;
  let turningRadius = Infinity;
  let ICR_pos = false;

  // Compute line slopes
  let a1 = tan(dirFL);
  let a2 = tan(dirFR);
  let b1 = FL_world.y - a1 * FL_world.x;
  let b2 = FR_world.y - a2 * FR_world.x;

  if (abs(a1 - a2) > epsilon) {
    let icrX = (b2 - b1) / (a1 - a2);
    let icrY = a1 * icrX + b1;
    ICR_pos = createVector(icrX, icrY);

    // Rear axle position
    let rear = p5.Vector.add(pos, createVector(0, car.rearAxelY).rotate(phi));
    let R = dist(rear.x, rear.y, icrX, icrY);
    turningRadius = max(R, 1e-6);

    omega = v / turningRadius;

    let rearToICR = p5.Vector.sub(ICR_pos, rear);
    let forwardVec = createVector(sin(phi), -cos(phi));
    let cross = forwardVec.x * rearToICR.y - forwardVec.y * rearToICR.x;
    if (cross < 0) omega = -omega;


  }

  // Store ICR for drawing
  car.ICR_pos = ICR_pos;

  // --- 5. Grip / lateral slip ---
  let a_req = isFinite(turningRadius) ? (v * v / turningRadius) : 0;
  let a_max_pixels = mu * g * M;

  if (a_req > a_max_pixels && a_req > 0) {
    let slipFactor = a_max_pixels / a_req; // 0..1
    omega *= slipFactor;

    let slipDirection = 1;
    if (omega > 0) {
      slipDirection = -1;
    }

    let exceed = 1 - slipFactor;
    car.lateralVel = mix(car.lateralVel, exceed * abs(v) * skidLateralGain * slipDirection, 0.2);
    sliding = true;

    skidLines[FRONT_LEFT].push(FL_world);
    skidLines[FRONT_RIGHT].push(FR_world);
    skidLines[REAR_LEFT].push(RL_world);
    skidLines[REAR_RIGHT].push(RR_world);

  } else {
    sliding = false;
    car.lateralVel = mix(car.lateralVel, 0, 0.12);
  }

  if (!isFinite(car.lateralVel)) car.lateralVel = 0;

  // --- 6. Update heading ---
  car.heading += omega * dt;


  // --- 7. Update position in world space ---
  let vx_world = v * sin(phi) + car.lateralVel * cos(phi);
  let vy_world = -v * cos(phi) + car.lateralVel * sin(phi);


  car.pos.x += vx_world * dt;
  car.pos.y += vy_world * dt;
}

function keyPressed() {
  if (key == "r") {
    resetCar();
  }
}


function draw() {
  background("#65ff96ff");


  updateSteeringAndThrottleFromInput();

  updateCarFromPhysics();

  if (!sliding) {

    skidLines[FRONT_LEFT] = [];
    skidLines[FRONT_RIGHT] = [];
    skidLines[REAR_LEFT] = [];
    skidLines[REAR_RIGHT] = [];

  }

  // Draw with camera
  push();

  translate(carPosOnScreen.x, carPosOnScreen.y);
  scale(zoom);
  rotate(-car.heading);
  translate(-car.pos.x, -car.pos.y);



  // noStroke();

  // gridUnit = M * 2;
  // for (let x = 0; x < ((width * 1.6 / zoom) / gridUnit); x++) {
  //   for (let y = 0; y < ((height * 1.8 / zoom) / gridUnit); y++) {

  //     let extra = 0;

  //     // checkerboard pattern
  //     if (abs(x) % 2 != abs(y) % 2) {
  //       fill("#ffe2b1ff");
  //       extra = 1;
  //     } else {
  //       fill("#ffa915ff");
  //     }

  //     rect(
  //       (car.pos.x - car.pos.x % (gridUnit * 2)) - carPosOnScreen.x * 1.6 / zoom + x * gridUnit,
  //       (car.pos.y - car.pos.y % (gridUnit * 2)) - carPosOnScreen.y * 1.8 / zoom + y * gridUnit,
  //       gridUnit, gridUnit
  //     );

  //   }
  // }

  fill("#FF0000");
  circle(10 * M, 10 * M, M);

  drawTrack(0, 0, track);


  // draw skid lines
  for (let wheelCode of [FRONT_LEFT, FRONT_RIGHT, REAR_LEFT, REAR_RIGHT]) {

    let prevPoint = false;
    for (let skidLinePoint of skidLines[wheelCode]) {

      stroke("#00000083");
      strokeWeight(car.tireWidth);

      if (prevPoint) {
        line(prevPoint.x, prevPoint.y, skidLinePoint.x, skidLinePoint.y);
      }

      prevPoint = skidLinePoint;

    }

  }



  if (car.ICR_pos) {

    stroke("#FF0000");
    strokeWeight(M);
    point(car.ICR_pos.x, car.ICR_pos.y);

  }

  drawCar(car);

  pop();



  // Fixed HUD

  drawSteeringWheel(steeringWheelDisplayCentre, steeringWheelAngle, steeringWheelDisplayRadius);

  // draw "hand"
  textAlign(CENTER);
  if (MODES[selectedMode] == HAND_MODE && currentAngle) {
    let handPos = p5.Vector.add(steeringWheelDisplayCentre, p5.Vector.fromAngle(currentAngle).mult(steeringWheelDisplayRadius));
    fill("#ffd000ff");
    strokeWeight(1);
    circle(handPos.x, handPos.y, 50 * handGripLevel);
    text(round(degrees(currentAngle), 1) + "°", handPos.x, handPos.y);

  }

  let s = steeringWheelDisplayRadius / 4;
  // draw arrow
  if (MODES[selectedMode] == ARROW_MODE && currentAngle) {
    fill("#22cfffff");
    strokeWeight(1);
    push();
    translate(steeringWheelDisplayCentre.x, steeringWheelDisplayCentre.y);
    rotate(steeringWheelAngle);
    translate(0, -steeringWheelDisplayRadius);
    triangle(0, -s, s / 2, 0, -s / 2, 0);

    pop();

  }



  let w = steeringWheelDisplayRadius / 4;
  let h = steeringWheelDisplayRadius * 2;

  fill("#006608ff");
  strokeWeight(1);
  stroke(0);
  rect(
    steeringWheelDisplayCentre.x + steeringWheelDisplayRadius * 1.5,
    steeringWheelDisplayCentre.y - steeringWheelDisplayRadius,
    w, h
  );

  fill("#660000ff");
  rect(
    steeringWheelDisplayCentre.x - steeringWheelDisplayRadius * 1.5 - w,
    steeringWheelDisplayCentre.y - steeringWheelDisplayRadius,
    w, h
  );

  noStroke();
  fill("#00ff15ff");
  rect(
    steeringWheelDisplayCentre.x + steeringWheelDisplayRadius * 1.5,
    steeringWheelDisplayCentre.y - steeringWheelDisplayRadius + (1 - throttle) * h,
    w, throttle * h
  );

  fill("#ff0000ff");
  rect(
    steeringWheelDisplayCentre.x - steeringWheelDisplayRadius * 1.5 - w,
    steeringWheelDisplayCentre.y - steeringWheelDisplayRadius + (1 - brake) * h,
    w, brake * h
  );



  drawSpeedometer(
    steeringWheelDisplayCentre.x + steeringWheelDisplayRadius * 3.3,
    steeringWheelDisplayCentre.y,
    steeringWheelRadius * 3
  );




  fill(255);
  stroke(0);
  strokeWeight(0);
  textSize(20);
  textAlign(CENTER, CENTER);
  text(round(degrees(steeringWheelAngle), 1) + "°", steeringWheelDisplayCentre.x, steeringWheelDisplayCentre.y);
  fill("#000000ff");
  text(round(v / M * 3600 / 1000) + " km/h", steeringWheelDisplayCentre.x, steeringWheelDisplayCentre.y + 50);

  // if (sliding) {
  //   text("sliding " + car.lateralVel, carPosOnScreen.x, carPosOnScreen.y + 75);
  // }

  stroke(0);
  textSize(25);
  strokeWeight(1.5);
  textAlign(LEFT, TOP);

  if (frameRate() > 50) {
    text("FPS: stable", 25, 25);
  } else {
    text(`FPS: ${round(frameRate())}`, 25, 25);
  }

  textAlign(LEFT);
  text("zoom: " + round(zoom, 1) + " ×", 25, 50);

  textAlign(RIGHT);
  text(
    `Controls:
R to reset car
Circle to change wheel control mode

Wheel Control Mode:
${MODES[selectedMode]}`, width - 25, 50);

  updateGamepad();



}
