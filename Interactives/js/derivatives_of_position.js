
// JS adaptation of Forbes' Kalman filter implementation.
class KalmanFilter {
  

  constructor(initial_state, initial_covariance) {
    this.state = initial_state;
    this.covariance = initial_covariance;
  }     
  
  predict_state(state_transition_model, process_noise) {
    
    var state = math.multiply(state_transition_model, this.state);
    var cov = math.add(math.multiply(math.multiply(state_transition_model, this.covariance), math.transpose(state_transition_model)), process_noise);
    
    return [state, cov];
    

  }
  
  update_state(observation, observation_model, observation_noise) {
    
    var innovation = math.subtract(observation, math.multiply( observation_model, this.state));
    var innovation_covariance = math.add(math.multiply(observation_model,  math.multiply(this.covariance, math.transpose(observation_model))),  observation_noise);
    var kalman_gain = math.multiply(this.covariance, math.multiply(math.transpose(observation_model), math.inv(innovation_covariance)));
    
    
    var state = math.add(this.state, math.multiply(kalman_gain, innovation));
    var cov = math.multiply(math.subtract(math.identity(this.covariance.size()[0]),  math.multiply(kalman_gain, observation_model)), this.covariance);

    return [state, cov];
  
  }
  
  get_new_state(
      observation,
      observation_model,
      observation_noise,
      process_noise,
      state_transition_model,
  ) {
  
    [this.state, this.covariance] = this.predict_state(state_transition_model, process_noise);
    [this.state, this.covariance] = this.update_state(observation, observation_model, observation_noise);
    

    return [this.state, this.covariance];
        
  }
  
}

var init_state;
 
var init_covariance = math.matrix([
    [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
]);

var state_transition_model = math.matrix([
  [1.0, 0.0, 1.0, 0.0, 0.0, 0.0],
  [0.0, 1.0, 0.0, 1.0, 0.0, 0.0],
  [0.0, 0.0, 1.0, 0.0, 1.0, 0.0],
  [0.0, 0.0, 0.0, 1.0, 0.0, 1.0],
  [0.0, 0.0, 0.0, 0.0, 1.0, 0.0],
  [0.0, 0.0, 0.0, 0.0, 0.0, 1.0],
]);
 

var obs_noise = 100;
var pos_noise = 1;
var vel_noise = 0.05;
var acc_noise = 0.05;

var observation_noise = math.matrix([
  [obs_noise, 0],
  [0, obs_noise],
]);

var process_noise = math.matrix([
  [pos_noise, 0.0, 0.0, 0.0, 0.0, 0.0],
  [0.0, pos_noise, 0.0, 0.0, 0.0, 0.0],
  [0.0, 0.0, vel_noise, 0.0, 0.0, 0.0],
  [0.0, 0.0, 0.0, vel_noise, 0.0, 0.0],
  [0.0, 0.0, 0.0, 0.0, acc_noise, 0.0],
  [0.0, 0.0, 0.0, 0.0, 0.0, acc_noise]
]);

// Position
var observation_model = math.matrix([
  [1, 0, 0, 0, 0, 0],
  [0, 1, 0, 0, 0, 0]
]);

var kf;

// 1 unit of Velocity is equal to this number of pixels on screen.
var VEL_SCALE = 25;

// 1 unit of Accelleration is equal to this number of pixels on screen.
var ACC_SCALE = 300;

// Used to track if we are currently directly controlling Position, Velocity, or Accelleration.
var mode = false;

var prevPosList;
var prevVelList;
var prevAccList;
var origin;
var displayVel;
var prevDisplayVel;

var PREV_LIST_LENGTH = 30;
var pos;
var prev_pos;
var prev_pos_2;
var prev_pos_3;

var pos_frame;
var vel_frame;
var acc_frame;

class Marker {
  
  constructor(x, y, origin, fillColor, parent) {
    this.pos = createVector(x, y);
    this.origin = origin
    this.radius = 25;
    this.highlighted = false;
    this.fillColor = fillColor;
    
    this.parent = parent;
  }
  
  draw() {
    
    
    var transp_color = color(this.fillColor.toString());
    transp_color.setAlpha(100);
    stroke(transp_color);
    strokeWeight(6);
    line(this.origin.x, this.origin.y, this.pos.x, this.pos.y);
    
    if (this.point_in_marker()) {
      strokeWeight(5);
      stroke(this.fillColor);
    } else {
      noStroke();
      
    }
    fill(this.fillColor);
    
    // pos = prevPosList.slice(-1)[0]
    circle(this.pos.x, this.pos.y, this.radius*2);
    
    stroke(0);
    strokeWeight(7);
    // left eye
    point(this.pos.x - this.radius/3, this.pos.y - this.radius/5);
    // right eye
    point(this.pos.x + this.radius/3, this.pos.y - this.radius/5);
    
    strokeWeight(4);
    arc(this.pos.x, this.pos.y, this.radius, this.radius, 30, 150);
  }
  
  point_in_marker() {
    
    var true_pos = createVector(
      this.parent.x + this.parent.w / 2 - (this.parent.w / 2 * this.parent.frame_scale) + (this.pos.x * this.parent.frame_scale),
      this.parent.y + this.parent.w / 2 - (this.parent.w / 2 * this.parent.frame_scale) + (this.pos.y * this.parent.frame_scale)
    );
    // print(this.parent.x);
    var distance = p5.Vector.dist(true_pos, createVector(mouseX, mouseY))
    
    if (distance < this.radius * this.parent.frame_scale) {
      return true;
    } else {
      return false;
    }
    
  }
  
}

class Frame {
  
  constructor(name, x, y, w, h, markerColor, color1, color2) {
    
    this.name = name;
    
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
    
    this.frame_scale = 1;
    
    this.origin = createVector(w/2, h/2);
    
    this.marker = new Marker(this.origin.x, this.origin.y, this.origin, markerColor, this);
    
    this.color1 = color1;
    this.color2 = color2;
    
  }
  
  draw(value) {
    var number_of_gridlines = 10;
    
    var x = this.x;
    var y = this.y;
  
    var L = this.w / number_of_gridlines;
    
    let distance = p5.Vector.dist(this.marker.pos, this.origin);
    
    let critical_distance = this.w/2 * 4/5;
    
    if (distance > critical_distance) {
      this.frame_scale = critical_distance / distance;
    } else {
      this.frame_scale = 1;
    }
    
    noStroke();
    fill(this.marker.fillColor);
    textSize(L*2/3);
    textFont('Menlo');
    // textStyle('bold')
    text(this.name + " " + value, this.x, this.y - 3);
    
    push();
    beginClip();
    
    square(x, y, this.w);
    endClip();
    
    // fill(0);
    // square(x, y, this.w)
    
    translate(x+this.w/2, y+this.w/2);
    scale(this.frame_scale);
    translate(-this.w/2, -this.w/2);
    
  
    noStroke();
    
    var start = -20;
    var stop = number_of_gridlines + 20;
    for (var i = start; i < stop; i++) {
      for (var j = start; j < stop; j++) {

        if (math.abs(i) % 2 != math.abs(j) % 2) {
          fill(this.color1);
        } else {
          fill(this.color2);
        }

        square(L*i, L*j, L);
      }
    }
    
    this.marker.draw();
    
    pop();
  
  }
  
}

function setup() {
  myCanvas = document.getElementById("p5canvas")
  createCanvas(myCanvas.offsetWidth, myCanvas.offsetHeight, myCanvas);
  
  prevPosList = [createVector(0, 0), createVector(0, 0)];
  prevVelList = [createVector(0, 0), createVector(0, 0)];
  prevAccList = [createVector(0, 0), createVector(0, 0)];
  
  displayVel = createVector(0, 0);
  prevDisplayVel = createVector(0, 0);
  
  
  vel = createVector(0, 0);
  acc = createVector(0, 0);
  
  
  var gap = width/30;
  var w = width/3 - gap*(2/3);
  
  var x = 0;
  var y = gap;
  
  pos = createVector(0, 0);
  
  prev_pos = pos.copy();
  prev_pos_2 = pos.copy();
  prev_pos_3 = pos.copy();
  
  pos_frame = new Frame('Position', x, y, w, w, color("#FF6200"), color("#FFF4ED"), color("#FFEDE2"));
  
  pos = pos_frame.marker.pos.copy();
  
  x += w + gap
  vel_frame = new Frame('Velocity', x, y, w, w, color("#4CAF50"), color("#F1FFE1"), color("#D1F0D0"));
  
  x += w + gap;
  acc_frame = new Frame('Velshift', x, y, w, w, color("#673AB7"), color("#FBE6FF"), color("#E6C0EC"));
  
  init_state = math.matrix([
      [pos.x], // pos_x
      [pos.y], // pos_y
      [0.0], // vel_x
      [0.0], // vel_y
      [0.0], // acc_x
      [0.0], // acc_y
  ]);
  
  kf = new KalmanFilter(init_state, init_covariance);
 
}

function draw() {
  background(255);
  
  if (mode == 'pos') {
    
    pos_frame.marker.pos.add(mouseX - pmouseX, mouseY - pmouseY);
    pos = pos_frame.marker.pos.copy();
    
  } else if (mode == 'vel') {
    
    vel_frame.marker.pos.add(mouseX - pmouseX, mouseY - pmouseY);
    
    vel = vel_frame.marker.pos.copy().sub(vel_frame.origin).div(VEL_SCALE);
    
    pos.set(pos_frame.marker.pos.x, pos_frame.marker.pos.y);
    
    pos.add(vel);
    
  } else if (mode == 'acc') {
    
    acc_frame.marker.pos.add(mouseX - pmouseX, mouseY - pmouseY);
    
    acc = acc_frame.marker.pos.copy().sub(acc_frame.origin).div(ACC_SCALE);
    
    vel.add(acc);
    
    pos.add(vel);
  }
  
  var observation = math.matrix(
    [
      [pos.x],
      [pos.y]
    ]
  );
  
  if (pos.equals(prev_pos) && pos.equals(prev_pos_2) && pos.equals(prev_pos_3)) {
    obs_noise = 0;
    // console.log("works");
  } else {
    obs_noise = 300 * vel.mag() / 3;
  }

  observation_noise = math.matrix([
    [obs_noise, 0],
    [0, obs_noise],
  ]);


  let [state, cov] = kf.get_new_state(
    observation,
    observation_model,
    observation_noise,
    process_noise,
    state_transition_model,
  );
  
  prev_pos_3 = prev_pos_2.copy();
  prev_pos_2 = prev_pos.copy();
  prev_pos = pos.copy();

  if (mode != "vel") {
    vel.set(state._data[2][0], state._data[3][0]);
  }
  
  if (mode != "acc") {
    acc.set(state._data[4][0], state._data[5][0]);
  }
  
  
//   prevPosList.push( pos.copy() );
  
//   if (mode != 'vel') {
//     vel = prevPosList.slice(-1)[0].copy()
//     vel.sub( prevPosList.slice(-2)[0] );
//   }
  
//   prevVelList.push( vel.copy() );
  
//   if (mode != 'acc') {
    
//     acc = prevVelList.slice(-1)[0].copy()
//     acc.sub(prevVelList.slice(-2)[0])
    
//   }
  
//   prevAccList.push( acc.copy() );
  
//   if (prevPosList.length > PREV_LIST_LENGTH) {
//     prevPosList.shift();
//   }
//   if (prevVelList.length > PREV_LIST_LENGTH) {
//     prevVelList.shift();
//   }
//   if (prevAccList.length > PREV_LIST_LENGTH) {
//     prevAccList.shift();
//   }
  
  if (mode != 'pos') {
    
    pos_frame.marker.pos.set(pos.x, pos.y);
    
  }
  
  angleMode(DEGREES);
  pos_from_origin = pos.copy().sub(pos_frame.origin);
  pos_frame.draw(round(pos_from_origin.mag()) + "px " + round(pos_from_origin.heading()) + "°");
  
//   if (mode != 'vel') {
//     displayVel = createVector(0, 0);

//     for (var i = 0; i < prevVelList.length; i++) {

//       displayVel.add( prevVelList[i]).copy();//.div( 1 + prevVelList.length - i );
//     }
    
//     displayVel.div(prevVelList.length);
    
//     displayVel.mult(VEL_SCALE);
//     vel_frame.marker.pos.set(vel_frame.origin.x + displayVel.x, vel_frame.origin.y + displayVel.y);
    
//   }
  displayVel = vel.copy();
  displayVel.mult(VEL_SCALE);
  vel_frame.marker.pos.set(vel_frame.origin.x + displayVel.x, vel_frame.origin.y + displayVel.y);
  
  vel_frame.draw(round(vel.mag()) + "px/frame");
  
//   if (mode != 'acc') {
//     displayAcc = createVector(0, 0);

//     for (var i = 0; i < prevAccList.length; i++) {
//       displayAcc.add( prevAccList[i] )
//     }

//     displayAcc.div(prevAccList.length);
    
//     displayAcc.mult(ACC_SCALE);
    
//     acc_frame.marker.pos.set(acc_frame.origin.x + displayAcc.x, acc_frame.origin.y + displayAcc.y);
    
//   }
  
{      
  displayAcc = acc.copy();
  displayAcc.mult(ACC_SCALE);
    
  acc_frame.marker.pos.set(acc_frame.origin.x + displayAcc.x, acc_frame.origin.y + displayAcc.y);}
  
  acc_frame.draw(round(acc.mag()) + "px/frame^2");
  
  // print(pos.x + ", " + pos.y + ", " + vel.x + ", " + vel.y);
  
}

function mousePressed() {
  if (pos_frame.marker.point_in_marker()) {
    mode = 'pos';
  } else if (vel_frame.marker.point_in_marker()) {
    mode = 'vel';
  } else if (acc_frame.marker.point_in_marker()) {
    mode = 'acc';
  }
}

function mouseReleased() {
  
  mode = false;
  
}