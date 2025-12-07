/*

Bugs to fix:
- include overshoot in snapback detection (DONE mostly)

- framerate drop from 3D globe lines (vectors?)


Features to implement:

- flickstick like movement on full lock

- pitch-based sensitivity to correct for shorter lines of latitude

- pixel screenspace / geodesic-based aiming ?



Features DONE:
- differential X and Y sensitivity
- smoothing
- pitch and bearing displayed on screen

*/


// ===== CONFIG =====
const GRAVITY = 1.2;
const JUMP_FORCE = 50;
const PLAYER_RADIUS = 24;   // horizontal collision radius (XZ)
const PLAYER_HEIGHT = 100;  // player's height (vertical)
const GROUND_Y = 0;         // ground top

// Perspective parameters
let cameraFOV; // vertical field of view
let aspect;
let near;
let far;

let flickstickActive = false;
let flickstickStartingYaw;
let flickstickStartingStickHeading;

let overlaysToDisplay = {
  textOverlay: true,
  gamepadOverlay: false
}

let forward;
let right;
let up;
let lookAtPoint;
let camPos;


let north;
let east;
let worldUp;


//
let radius;


// Input data
let moveInput;

let mouseActive = false;

prevRSX = false;
prevRSY = false;
prevInwardsVec = false;

let rs; // right stick raw input
let currentNeutral; // the nonzero raw input that is being recieved from the thumbstick in a neutral state (the drift)
let zero; // the pitch and yaw that the thumbstick position will be used to calculate a deviation from



// Smoothing
let rsSmoothed;
const smoothing = 0.4; // 0 = very smooth/slow, 1 = no smoothing

let snappingBack = false;

// Sensitivity
mouseSensitivityX = 0.5;
mouseSensitivityY = 0.5;

let gamepadMoveSensitivity = 7;   // movement speed for left stick

// Input Modes
const REGULAR = "regular";
const TIMSTICK = "timstick";

const MOUSE = "mouse";

const MODES = [
  REGULAR,
  TIMSTICK,
  MOUSE,
];
let selectedMode = 1;


// keys
const FORWARD_KEY  = 87; // W
const BACKWARD_KEY = 83; // S
const LEFT_KEY     = 65; // A
const RIGHT_KEY    = 68; // D


// gamepad buttons

const R3 = 11;

const DPAD_UP      =  12;
const DPAD_DOWN    =  13;
const DPAD_LEFT    =  14;
const DPAD_RIGHT   =  15;

const X_BUTTON = 0;
const CIRCLE_BUTTON = 1;
const SQUARE_BUTTON = 2;
const TRIANGLE_BUTTON = 3;




const TRUE_MAX_STICK_INPUT = 1.07;


let gamepadButtonMappings = {};
let prevGamepadButtonState = {};

let sens = {};


let boxes = [];

// ========== PLAYER ==========
let player = {
  position: null,   // feet position
  cameraHeight: -100,
  pitch: 0,
  yaw: 0,
  velY: 0,
  grounded: true
};
let speed = 7;


// Canvases
let c;
let hud


let cam;

let img;
let inconsolata;


let lastFrameTime;
let dt;

function preload() {
  
  img = loadImage('citrus_orchard_road_puresky.jpg');
  
  inconsolata = loadFont("Inconsolata-VariableFont_wdth,wght.ttf");
  
}

function setup() {
  
  
  
  
  c = createCanvas(windowWidth, windowHeight, WEBGL);
  c.id("worldCanvas");
  
  // create HUD canvas
  hud = new p5((s) => {
    s.setup = () => {
      let h = s.createCanvas(windowWidth, windowHeight);
      h.id("hudCanvas");
      s.clear();
    };
    s.draw = () => {}; // we draw manually below
  });
  
  
  aspect = width / height;
  
  let desiredHorizontalFOV = radians(90);
  cameraFOV = desiredHorizontalFOV / aspect;
  
  
  near = 0.1;
  far = 10000;
  perspective(cameraFOV, aspect, near, far);
  
  radius = 50//50 / tan(cameraFOV/2);
  
  worldUp = createVector(0, 1, 0);
  north = createVector(cos(player.pitch) * sin(player.yaw),
    sin(player.pitch),
    -cos(player.pitch) * cos(player.yaw)
  );
  east = north.copy();
  east = rotateVectorAroundAxis(east, worldUp, TAU/4);
  
  up = worldUp.copy(); // world up
  
  cam = createCamera();
  
  textFont(inconsolata);
  textSize(26);
  textAlign(CENTER);
  
  lastFrameTime = millis();
  dt = 0;
  
  player.position = createVector(0, 0, 0); // feet at ground
  moveInput = createVector(0, 0, 0);
  
  zero = createVector(0, 0);
  
  rsSmoothed = createVector(0, 0);
  
  
  
  sens = {

    [MOUSE]: {x: 0.5, y: 0.5, increment: 0.05},
    [REGULAR]: {x: 0.1, y: 0.1, increment: 0.01},
    [TIMSTICK]: {x: cameraFOV*aspect/2, y: cameraFOV/2, increment: radians(10)},

  }

  generateBoxes();

  document.addEventListener('pointerlockchange', () => {
    const canvas = document.querySelector('canvas');
    if (document.pointerLockElement === canvas) {
      mouseActive = true;
      noCursor();
    } else {
      mouseActive = false;
      cursor();
    }
  });
  
  currentNeutral = createVector(0, 0);
  
  
  
  gamepadButtonMappings = {
    [R3]: () => cycleMode(),
    [DPAD_UP]: () => cameraFOV += radians(5),
    [DPAD_DOWN]: () => cameraFOV -= radians(5),
    [DPAD_LEFT]: () => changeSens(-1),
    [DPAD_RIGHT]: () => changeSens(1),
    
    [CIRCLE_BUTTON]: () => toggle(overlaysToDisplay, "gamepadOverlay")
  }

}

function toggle(obj, key) {
  obj[key] = !obj[key];
}

function changeSens(amt) {
  
  sens[MODES[selectedMode]].x += amt * sens[MODES[selectedMode]].increment;
  sens[MODES[selectedMode]].y += amt * sens[MODES[selectedMode]].increment;
  
}

function cycleMode() {
  selectedMode += 1;
  if (selectedMode >= MODES.length) selectedMode = 0;
  
  zero.x = player.yaw;
  zero.y = player.pitch;
}

function windowResized() {
  oldHeight = height;
  
  resizeCanvas(windowWidth, windowHeight);
  
  aspect = width / height;
  cameraFOV *= height / oldHeight;
  sens[TIMSTICK].y = cameraFOV / 2;
  sens[TIMSTICK].x = sens[TIMSTICK].y * aspect;
  
  hud.resizeCanvas(windowWidth, windowHeight);
}

// ========== BOX CLASS ==========
class Box {
  constructor(position, boxWidth, boxHeight, boxDepth, yRotation) {
    this.position = position.copy(); // bottom y
    this.boxWidth = boxWidth;
    this.boxHeight = boxHeight;
    this.boxDepth = boxDepth;
    this.yRotation = yRotation;
    this.halfW = boxWidth / 2;
    this.halfD = boxDepth / 2;
  }

  draw() {
    push();
    translate(this.position.x, this.position.y - this.boxHeight / 2, this.position.z);
    rotateY(this.yRotation);
    noStroke();
    specularMaterial("#FFFFFF");
    metalness(50);
    shininess(75);
    box(this.boxWidth, this.boxHeight, this.boxDepth);
    pop();
  }

  topY() {
    return this.position.y + this.boxHeight;
  }

  closestPointXZ(px, pz) {
    let dx = px - this.position.x;
    let dz = pz - this.position.z;
    let c = cos(-this.yRotation);
    let s = sin(-this.yRotation);
    let localX = c * dx - s * dz;
    let localZ = s * dx + c * dz;

    let clampedX = constrain(localX, -this.halfW, this.halfW);
    let clampedZ = constrain(localZ, -this.halfD, this.halfD);

    let wx = cos(this.yRotation) * clampedX - sin(this.yRotation) * clampedZ + this.position.x;
    let wz = sin(this.yRotation) * clampedX + cos(this.yRotation) * clampedZ + this.position.z;

    return createVector(wx, wz);
  }
}

// ========== WORLD GENERATION ==========
function generateBoxes() {
  boxes = [];
  for (let i = 0; i < 20; i++) {
    let dir = random(TAU);
    let distToCentre = random(400, 3000);
    let pos2d = rotateMoveVector(createVector(distToCentre, 0, 0), dir);
    let bottomY = 0;
    let boxRotation = random(TAU);
    let size = random(50, 300);
    let h = random(50, 800);
    boxes.push(new Box(createVector(pos2d.x, bottomY, pos2d.z), size, h, size, boxRotation));
  }
}

// ========== INPUT ==========
// =======================
// GET INPUT
// =======================
function getMoveInput() {
  // Reset moveInput
  moveInput.set(0, 0, 0);

  // Keyboard WASD
  if (keyIsDown(87)) moveInput.z -= 1; // W
  if (keyIsDown(83)) moveInput.z += 1; // S
  if (keyIsDown(65)) moveInput.x -= 1; // A
  if (keyIsDown(68)) moveInput.x += 1; // D

  // Gamepad
  let gamepads = navigator.getGamepads();
  if (gamepads[0]) {
    let gp = gamepads[0];

    // Left stick controls movement
    let lsX = gp.axes[0];
    let lsY = gp.axes[1];
    // Apply deadzone
    if (abs(lsX) > 0.15) moveInput.x += lsX * gamepadMoveSensitivity;
    if (abs(lsY) > 0.15) moveInput.z += lsY * gamepadMoveSensitivity;

  }

  // Normalize movement so diagonal isn't faster
  if (moveInput.mag() > 0) moveInput.normalize();
}

// =======================
// CAMERA CONTROL (in draw())
// =======================
function updateCameraFromInput() {
  // Mouse movement
  if (mouseActive) {
    player.yaw += radians(movedX * mouseSensitivityX);
    player.pitch += radians(movedY * mouseSensitivityY);
  }

  // Gamepad right stick for camera
  let gamepads = navigator.getGamepads();
  if (gamepads[0]) {
    let gp = gamepads[0];
    
    rs = createVector(gp.axes[2], gp.axes[3]);
    
    
    // forcibly circularise input
    // if (rs.mag() > 1) {
    //   rs.normalize();
    // }

    
    if (MODES[selectedMode] == REGULAR) {
      const rsDeadzone = 0.05;
    
      // Right stick camera
      if (abs(rs.x) > rsDeadzone) player.yaw += (rs.x-rsDeadzone) * (sens[REGULAR].x*(1+rsDeadzone));
      if (abs(rs.y) > rsDeadzone) player.pitch += (rs.y-rsDeadzone) * (sens[REGULAR].y*(1+rsDeadzone));
      
    } else if (MODES[selectedMode] == TIMSTICK) {
      
      if (prevRSX == false || prevRSY == false) {
        
        prevRSX = rs.x;
        prevRSY = rs.y;
        
      }

      let inwardsVec = createVector(-rs.x, -rs.y);
      if (!prevInwardsVec) prevInwardsVec = inwardsVec;

      // let velDisplayDiameter = 100;
      // drawVelDisplay(vel, inwardsVec, width-velDisplayDiameter/2, velDisplayDiameter/2, velDisplayDiameter);

      // snapback detection
      if (inwardsVec.mag() < prevInwardsVec.mag() * 0.8) {
        snappingBack = true;
        console.log(snappingBack);
        
        
        
        smoothRx = 0;
        smoothRy = 0;
        
      } else if (snappingBack == true) {
        
        
        // if stick has stopped moving
        if (rs.x == prevRSX || rs.y == prevRSY) {
          
          snappingBack = false;
          
          zero.x = player.yaw;
          zero.y = player.pitch;
          currentNeutral = rs.copy();
          
        
//         console.log(currentNeutral);
        }
        
        // exponential smoothing
        rsSmoothed.x = rs.x;
        rsSmoothed.y = rs.y;
        
        
      } else {
        
        
        
        if (flickstickActive) {
          
          player.yaw = flickstickStartingYaw + (rs.heading() - flickstickStartingStickHeading);
          console.log("flickstick active");
          
        } else {
          
          player.yaw = zero.x + (rsSmoothed.x - currentNeutral.x) * sens[TIMSTICK].x;
          
          // console.log(zero.x, rsSmoothed.x, currentNeutral.x);

          player.pitch = zero.y + (rsSmoothed.y - currentNeutral.y) * sens[TIMSTICK].y;
          
        }
        
        // if stick in edge activation ring
        if (rs.mag() > 0.95) {
          
          if (!flickstickActive) {
            flickstickActive = true;
            flickstickStartingYaw = player.yaw;
            flickstickStartingStickHeading = rs.heading();
          }
          
        } else {
          if (flickstickActive) {
            flickstickActive = false;
            zero.x = player.yaw - rs.x * sens[TIMSTICK].x;
            zero.y = player.pitch - rs.y * sens[TIMSTICK].x;
            currentNeutral.x = 0;
            currentNeutral.y = 0;
          }
          
        }
        
      }
      


      prevInwardsVec = inwardsVec;

      prevRSX = rs.x;
      prevRSY = rs.y;
      
      // exponential smoothing
      rsSmoothed.x = rsSmoothed.x + (rs.x - rsSmoothed.x) * smoothing;
      rsSmoothed.y = rsSmoothed.y + (rs.y - rsSmoothed.y) * smoothing;
      
    }
    

  }

  // Clamp pitch
  player.pitch = constrain(player.pitch, radians(-89), radians(89));
}

function rotateMoveVector(localVec, yaw) {
  let cosY = cos(yaw);
  let sinY = sin(yaw);
  let x = localVec.x * cosY - localVec.z * sinY;
  let z = localVec.x * sinY + localVec.z * cosY;
  return createVector(x, 0, z);
}

// ========== GAMEPAD ==========
function updateGamepad() {
  const gps = navigator.getGamepads();
  if (!gps) return;

  const gp = gps[0];
  if (!gp) return;

  const DEADZONE = 0.2;
  let lx = Math.abs(gp.axes[0]) > DEADZONE ? gp.axes[0] : 0;
  let ly = Math.abs(gp.axes[1]) > DEADZONE ? gp.axes[1] : 0;

  // // LEFT STICK: add to moveInput without overwriting
  // moveInput.x += lx;
  // moveInput.z += ly;

  if (moveInput.mag() > 1) moveInput.normalize();

  // // RIGHT STICK: camera rotation
  // const rx = Math.abs(gp.axes[2]) > DEADZONE ? gp.axes[2] : 0;
  // const ry = Math.abs(gp.axes[3]) > DEADZONE ? gp.axes[3] : 0;
  // const LOOK_SPEED = 2.0;
  // if (rx) player.yaw += radians(rx * LOOK_SPEED);
  // if (ry) player.pitch += radians(ry * LOOK_SPEED);

  // BUTTON 0: jump
  if (gp.buttons[0].pressed) tryJump();
  
  
  
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



// ========== JUMP ==========
function tryJump() {
  const jumpEpsilon = 12;
  const onGround = player.position.y >= GROUND_Y - jumpEpsilon && player.position.y <= GROUND_Y + jumpEpsilon;
  const onBox = checkStanding(player.position, jumpEpsilon);
  if (onGround || onBox) {
    player.velY = -JUMP_FORCE;
    player.grounded = false;
  }
}

function keyPressed() {
  if (key === ' ' || key === 'Space') tryJump();
}

// ========== COLLISION ==========
function resolveHorizontal(pos) {
  let px = pos.x;
  let pz = pos.z;

  for (let b of boxes) {
    let topY = b.topY();
    if (pos.y >= topY) continue;

    let closestX = constrain(px, b.position.x - b.boxWidth/2, b.position.x + b.boxWidth/2);
    let closestZ = constrain(pz, b.position.z - b.boxDepth/2, b.position.z + b.boxDepth/2);

    let dx = px - closestX;
    let dz = pz - closestZ;
    let distSq = dx*dx + dz*dz;

    if (distSq < PLAYER_RADIUS*PLAYER_RADIUS - 0.001) {
      let distP = sqrt(distSq);
      let nx = distP > 0.001 ? dx / distP : 1;
      let nz = distP > 0.001 ? dz / distP : 0;
      let pen = PLAYER_RADIUS - distP;
      px += nx * pen;
      pz += nz * pen;
    }
  }

  return createVector(px, pos.y, pz);
}

function checkLanding(prevY, pos) {
  for (let b of boxes) {
    let topY = b.topY();
    let closestX = constrain(pos.x, b.position.x - b.boxWidth/2, b.position.x + b.boxWidth/2);
    let closestZ = constrain(pos.z, b.position.z - b.boxDepth/2, b.position.z + b.boxDepth/2);

    let dx = pos.x - closestX;
    let dz = pos.z - closestZ;
    let distSq = dx*dx + dz*dz;

    if (distSq <= PLAYER_RADIUS*PLAYER_RADIUS) {
      if (prevY <= topY && pos.y >= topY) return topY;
    }
  }

  if (pos.y >= GROUND_Y) return GROUND_Y;
  return null;
}

function checkStanding(pos, eps) {
  for (let b of boxes) {
    let closest = b.closestPointXZ(pos.x, pos.z);
    let dx = pos.x - closest.x;
    let dz = pos.z - closest.z; // fixed: use .z for Z coordinate
    let distSq = dx*dx + dz*dz;
    if (distSq <= PLAYER_RADIUS * PLAYER_RADIUS) {
      let top = b.topY();
      if (pos.y >= top - eps && pos.y <= top + eps) return true;
    }
  }
  return false;
}

// ========== PLAYER UPDATE ==========
function updatePlayer() {
  // Gamepad input first
  updateGamepad();

  // WASD keyboard input
  getMoveInput();

  let horizMove = moveInput.mag() > 0
      ? rotateMoveVector(moveInput, player.yaw).mult(speed)
      : createVector(0,0,0);

  let desired = player.position.copy().add(horizMove);

  // Gravity
  let prevY = player.position.y;
  if (!player.grounded) player.velY += GRAVITY;
  desired.y += player.velY;

  // Landing
  let landedY = checkLanding(prevY, desired);
  if (landedY !== null) {
    desired.y = landedY;
    player.velY = 0;
    player.grounded = true;
  } else {
    player.grounded = false;
  }

  // Horizontal collisions
  desired = resolveHorizontal(desired);

  player.position.set(desired);
}

// ========== DRAW ==========
function draw() {
  
  let now = millis();
  dt = (now - lastFrameTime) / 1000; // dt in seconds
  // console.log(dt);
  lastFrameTime = now;
  
  panorama(img);
  imageLight(img);

  getMoveInput();                // moveInput is updated
  updatePlayer();            // apply movement + collision
  
  updateCameraFromInput();   // update yaw/pitch from mouse + right stick
  

  forward = createVector(
    cos(player.pitch) * sin(player.yaw),
    sin(player.pitch),
    -cos(player.pitch) * cos(player.yaw)
  );
  
  right = createVector(sin(player.yaw - HALF_PI), 0, -cos(player.yaw - HALF_PI));
  
  camPos = createVector(
    player.position.x,
    player.position.y + player.cameraHeight,
    player.position.z
  )
  
  lookAtPoint = p5.Vector.add(camPos, forward);

  camera(
    camPos.x,
    camPos.y,
    camPos.z,
    lookAtPoint.x,
    lookAtPoint.y,
    lookAtPoint.z,
    0, 1, 0
  );


  push();
  translate(0, GROUND_Y-50, 0);
  specularMaterial("#FFFFFF");
  metalness(50);
  shininess(75);
  noStroke();
  cylinder(3000, 100, 50, 50, false, true);
  pop();

  for (let b of boxes) b.draw();
  
  
  
    
  perspective(cameraFOV, aspect, near, far);
  
  
  drawHUD();
  drawHUDGlobe();
  strokeWeight(0.1);
  stroke("#FFFFFF54");

  for (let angle = 10; angle <= 50; angle += 10) {
    drawAngularGlobeRing(radians(angle));
  }

  if (overlaysToDisplay.gamepadOverlay == true) {
    drawInputRangeOverlay();
  }

}


//
// Drawing mapping of analog stick on screen
//
function drawInputRangeOverlay() {
  
  stroke("#FF5722");
  
  let rxOffset = 0;
  let ryOffset = 0;
  
  if (MODES[selectedMode] == TIMSTICK) {
    rxOffset = -rsSmoothed.x * sens[TIMSTICK].x;
    ryOffset = -rsSmoothed.y * sens[TIMSTICK].y;
  }
    
  drawAngularGlobeRing(sens[TIMSTICK].x*TRUE_MAX_STICK_INPUT, sens[TIMSTICK].y*TRUE_MAX_STICK_INPUT, rxOffset, ryOffset, sens[TIMSTICK].x, sens[TIMSTICK].y);

  // mag 1
  drawAngularGlobeRing(sens[TIMSTICK].x, sens[TIMSTICK].y, rxOffset, ryOffset);

  // mag 0.5
  let stickMag = 0.5;
  drawAngularGlobeRing(sens[TIMSTICK].x*stickMag, sens[TIMSTICK].y*stickMag, rxOffset, ryOffset);


  
  // horizontal
  drawLinearYawPitchCurve(
    rxOffset - sens[TIMSTICK].x,
    ryOffset,
    rxOffset + sens[TIMSTICK].x,
    ryOffset);
  
  // vertical
  drawLinearYawPitchCurve(
    rxOffset,
    ryOffset - sens[TIMSTICK].y,
    rxOffset,
    ryOffset + sens[TIMSTICK].y);
  
  // SW -> NE
  drawLinearYawPitchCurve(
    rxOffset + sens[TIMSTICK].x*TRUE_MAX_STICK_INPUT * cos(TAU*3/8),
    ryOffset + sens[TIMSTICK].y*TRUE_MAX_STICK_INPUT * sin(TAU*3/8),
    rxOffset + sens[TIMSTICK].x*TRUE_MAX_STICK_INPUT * cos(TAU*7/8),
    ryOffset + sens[TIMSTICK].y*TRUE_MAX_STICK_INPUT * sin(TAU*7/8)
  );
  
  // NW -> SE
  drawLinearYawPitchCurve(
    rxOffset + sens[TIMSTICK].x*TRUE_MAX_STICK_INPUT * cos(TAU*1/8),
    ryOffset + sens[TIMSTICK].y*TRUE_MAX_STICK_INPUT * sin(TAU*1/8),
    rxOffset + sens[TIMSTICK].x*TRUE_MAX_STICK_INPUT * cos(TAU*5/8),
    ryOffset + sens[TIMSTICK].y*TRUE_MAX_STICK_INPUT * sin(TAU*5/8)
  );

  strokeWeight(0.5);
  
  if (MODES[selectedMode] == TIMSTICK) {
    drawLinearYawPitchCurve(0, 0, rxOffset, ryOffset);
  } else if (MODES[selectedMode] == REGULAR) {
    drawLinearYawPitchCurve(0, 0, rs.x * sens[TIMSTICK].x, rs.y * sens[TIMSTICK].y);
  }
  
  
  
}




function drawHUD() {
  
  
  // draw HUD
  hud.clear();
  
  hud.noStroke();
  hud.fill(255);

  hud.textSize(20);
  hud.textFont(inconsolata)
  hud.text(
`HUD Overlay
Framerate ${round(frameRate())}
Vertical FOV: ${round(degrees(cameraFOV))}°
Timstick Sens: ${sens[TIMSTICK].x, sens[TIMSTICK].y}
Degrees per max flick: ${round(degrees(sens[TIMSTICK].x))}°, ${round(degrees(sens[TIMSTICK].y))}°
Smooth Rx: ${rsSmoothed.x}
Smooth Ry: ${rsSmoothed.y}
Mag: ${dist(0, 0, rsSmoothed.x, rsSmoothed.y)}`, 20, 40);

  // screen centre
  let cx = hud.width / 2;
  let cy = hud.height / 2;
  
//   // crosshair
//   let crosshairSize = 10;
//   hud.stroke("#0BF100");
//   hud.strokeWeight(2);
  
//   hud.line(cx - crosshairSize, cy, cx + crosshairSize, cy);
//   hud.line(cx, cy - crosshairSize, cx, cy + crosshairSize);
  
}




function positionFromPitchAndYaw(pitch, yaw, absolute=false) {
  let dir;
  
  if (absolute) {
    dir = north.copy();
    
    dir = rotateVectorAroundAxis(dir, east, pitch);
    dir = rotateVectorAroundAxis(dir, worldUp, yaw);
  } else {
    
    dir = forward.copy();
    
    dir = rotateVectorAroundAxis(dir, right, pitch);
    dir = rotateVectorAroundAxis(dir, up, yaw);
    
  }
  
  dir.normalize();
  
  return createVector(dir.x * radius, dir.y * radius, dir.z * radius);
  
}



function vertexFromPitchAndYaw(pitch, yaw, absolute=false) {
  let dir;
  
  if (absolute) {
    dir = north.copy();
    
    dir = rotateVectorAroundAxis(dir, east, pitch);
    dir = rotateVectorAroundAxis(dir, worldUp, yaw);
  } else {
    
    dir = forward.copy();
    
    dir = rotateVectorAroundAxis(dir, right, pitch);
    dir = rotateVectorAroundAxis(dir, up, yaw);
    
  }
  
  dir.normalize();
  
  vertex(dir.x * radius, dir.y * radius, dir.z * radius);
  
}

function drawAngularGlobeRing(yawTheta, pitchTheta=yawTheta, yawOffset=0, pitchOffset=0, yawClampAngle=false, pitchClampAngle=false, steps = 64) {
  push();
  translate(camPos.x, camPos.y, camPos.z);

  noFill();
  beginShape();
  for (let i = 0; i <= steps; i++) {
    let alpha = map(i, 0, steps, 0, TAU); // radial direction angle
    let dYaw = yawTheta * cos(alpha);
    let dPitch = pitchTheta * sin(alpha);
    
    if (yawClampAngle) {
      dYaw = constrain(dYaw, -yawClampAngle, yawClampAngle);
      dPitch = constrain(dPitch, -pitchClampAngle, pitchClampAngle);
    }
    
    dYaw += yawOffset;
    dPitch += pitchOffset;
    
    vertexFromPitchAndYaw(dPitch, dYaw);
  }
  endShape(CLOSE);

  pop();
}

// Draw a spherical curve where yaw and pitch each interpolate linearly.
// yawA, pitchA, yawB, pitchB are angular OFFSETS (radians) relative to current crosshair.
// steps = number of segments, radius = visual radius from head.
function drawLinearYawPitchCurve(yawA, pitchA, yawB, pitchB, absolute=false, steps = 64) {
  push();

  // center at camera/head
  translate(camPos.x, camPos.y, camPos.z);

  // we will compute directions directly from (player.yaw + yaw_t, player.pitch + pitch_t)
  noFill();

  beginShape();
  for (let i = 0; i <= steps; i++) {
    
    let yawOffset = map(i, 0, steps, yawA, yawB);
    let pitchOffset = map(i, 0, steps, pitchA, pitchB);

    vertexFromPitchAndYaw(pitchOffset, yawOffset, absolute);
  }
  endShape();

  pop();
}

function convertYawToBearing() {
  
  let yaw = player.yaw;
  
  while (yaw < 0) {
    yaw += TAU;
  }
  
  return round(degrees(yaw % TAU))
}

function drawHUDGlobe() {

  const steps = 36;
  const maxPitchAngle = TAU/4;
  const maxYawAngle = TAU/2;
  
//   push();
//   translate(worldPos.x, worldPos.y, worldPos.z);
  
//   strokeWeight(10);
//   point();
  
//   pop();
  
  let pitchColor = color("#FF9119");
  let yawColor = color("#17E438");
  
  
  
  billboardText(
    `${convertYawToBearing()}°`, 
    camPos.copy().add(forward.copy().mult(radius)),
    {alignY: TOP, alignX: LEFT, strokeColor: 0, strokeWeightVal: 0.3, fillColor: yawColor}
  );
  
  billboardText(
    `${round(degrees(player.pitch))}°`, 
    camPos.copy().add(forward.copy().mult(radius)),
    {alignY: BOTTOM, alignX: LEFT, strokeColor: 0, strokeWeightVal: 0.3, fillColor: pitchColor}
  );

  strokeWeight(0.1);
  stroke(red(yawColor), green(yawColor), blue(yawColor), 200);
  
  drawLinearYawPitchCurve(-maxYawAngle, 0, maxYawAngle, 0);
  
  
  stroke(red(pitchColor), green(pitchColor), blue(pitchColor), 200);
  drawLinearYawPitchCurve(0, -maxPitchAngle, 0, maxPitchAngle);
  
  
  
  // Latitude lines (fixed relative to horizon)
//   for (let i = -steps; i <= steps; i++) {
//     let pitchOffset = map(i, -steps, steps, -maxPitchAngle, maxPitchAngle);
    
//     drawLinearYawPitchCurve(-maxYawAngle, pitchOffset, maxYawAngle, pitchOffset, true);
//   }

//   // Longitude lines (constant yaw relative to camera)
//   for (let i = -steps; i <= steps; i++) {
//     let yawOffset = map(i, -steps, steps, -maxYawAngle, maxYawAngle);
    
//     drawLinearYawPitchCurve(yawOffset, -maxPitchAngle, yawOffset, maxPitchAngle, true);
//   }
  
}

// Convert a 3D world position (p5.Vector) to 2D screen coordinates
function worldToScreen(v) {
  // v is a p5.Vector in world coordinates
  const cam = this._renderer._curCamera; // current camera

  // Camera position and orientation
  const camPos = createVector(cam.eyeX, cam.eyeY, cam.eyeZ);
  const camCenter = createVector(cam.centerX, cam.centerY, cam.centerZ);
  const camUp = createVector(cam.upX, cam.upY, cam.upZ);

  // Build forward, right, and up vectors for camera
  const forward = p5.Vector.sub(camCenter, camPos).normalize();
  const right = forward.cross(camUp).normalize();
  const up = right.cross(forward).normalize();

  // Convert world position to camera space
  const rel = p5.Vector.sub(v, camPos);
  const xCam = rel.dot(right);
  const yCam = rel.dot(up);
  const zCam = rel.dot(forward);

  if (zCam <= 0) return null; // behind camera

  // Project using perspective
  const f = 1.0 / tan(cameraFOV / 2); // focal length
  const aspectRatio = width / height;
  const sx = (xCam / (zCam * aspectRatio)) * (width / 2) + width / 2;
  const sy = (-yCam / zCam) * (height / 2) + height / 2;

  return createVector(sx, sy);
}







function billboardText(txt, worldPos, options = {}) {
  const {
    size = 22,
    font = inconsolata,
    fillColor = 255,
    strokeColor = null,
    strokeWeightVal = 0,
    alignX = CENTER,
    alignY = CENTER
  } = options;

  // Project world -> screen
  const sp = worldToScreen(worldPos);
  if (!sp) return; // behind camera or invalid

  // Draw on HUD (2D canvas)
  hud.push();
  if (font) hud.textFont(font);
  hud.textSize(size);
  hud.textAlign(alignX, alignY);
  if (strokeColor !== null && strokeWeightVal > 0) {
    hud.stroke(strokeColor);
    hud.strokeWeight(strokeWeightVal);
  } else {
    hud.noStroke();
  }
  hud.fill(fillColor);

  // sp.x/sp.y are in pixel coordinates of the main canvas.
  hud.text(txt, sp.x, sp.y);
  // console.log(sp.x, sp.y);
  hud.pop();
}



// ------------------------
// Rodrigues rotation helper
// ------------------------
function rotateVectorAroundAxis(vec, axis, angle) {
  let cosA = cos(angle);
  let sinA = sin(angle);
  let dot = vec.dot(axis);
  let cross = vec.cross(axis);
  return p5.Vector.add(
    p5.Vector.add(p5.Vector.mult(vec, cosA), p5.Vector.mult(cross, sinA)),
    p5.Vector.mult(axis, dot * (1 - cosA))
  );
}

function mouseWheel(event) {
  
  cameraFOV += radians( 0.1 * Math.floor(event.delta/30) );
  
  perspective(cameraFOV, aspect, near, far);
  
}

function doubleClicked() {
  let canvas = document.querySelector('canvas');
  if (canvas.requestPointerLock) canvas.requestPointerLock();
  mouseActive = true;
  noCursor();
}


