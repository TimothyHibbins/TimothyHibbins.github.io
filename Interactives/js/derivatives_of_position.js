var VEL_FACTOR = 10;

var ACC_FACTOR = 1000;

var mode = 'pos';

var prevPosList;
var prevVelList;
var prevAccList;
var origin;
var displayVel;
var prevDisplayVel;

var PREV_LIST_LENGTH = 10;
var pos;

var pos_frame;
var vel_frame;
var acc_frame;

class Marker {
  
  constructor(x, y, fillColor) {
    this.pos = createVector(x, y);
    this.radius = 25;
    this.highlighted = false;
    this.fillColor = fillColor;
  }
  
  draw() {
    
    if (this.point_in_marker()) {
      strokeWeight(5);
      stroke(this.fillColor);
    } else {
      noStroke();
      
    }
    fill(this.fillColor);
    
    // pos = prevPosList.slice(-1)[0]
    circle(this.pos.x, this.pos.y, this.radius*2);
  }
  
  point_in_marker() {
    
    var distance = p5.Vector.dist(this.pos, createVector(mouseX, mouseY))
    
    if (distance < this.radius) {
      return true;
    } else {
      return false;
    }
    
  }
  
}

class Frame {
  
  constructor(x, y, w, h, markerColor, color1, color2) {
    
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
    
    this.origin = createVector(x + w/2, y + h/2);
    
    this.marker = new Marker(this.origin.x, this.origin.y, markerColor);
    
    this.color1 = color1;
    this.color2 = color2;
    
  }
  
  draw() {
    var number_of_gridlines = 10;
    
    var x = this.x;
    var y = this.y;
  
    var L = this.w / number_of_gridlines;
  
    noStroke();

    for (var i = 0; i < number_of_gridlines; i++) {
      for (var j = 0; j < number_of_gridlines; j++) {

        if (i % 2 != j % 2) {
          fill(this.color1);
        } else {
          fill(this.color2);
        }

        square(x + L*i, y + L*j, L);
      }
    }
    
    this.marker.draw();
  
  }
  
}

function setup() {

  myCanvas = document.getElementById("p5canvas")
  createCanvas(myCanvas.offsetWidth, myCanvas.offsetHeight, myCanvas);
  
  origin = createVector(width/2, height/2);
  
  prevPosList = [createVector(0, 0), createVector(0, 0)];
  prevVelList = [createVector(0, 0), createVector(0, 0)];
  prevAccList = [createVector(0, 0), createVector(0, 0)];
  
  displayVel = createVector(0, 0);
  prevDisplayVel = createVector(0, 0);
  
  pos = origin.copy();
  vel = createVector(0, 0);
  acc = createVector(0, 0);
  
  pos_frame = new Frame(0, 0, width/3, width/3, "#FF6200", "#FFF4ED", "#FFEDE2");
  vel_frame = new Frame(width/3, 0, width/3, width/3, "#4CAF50", "#E5F3D7", "#DAF1BF");
  acc_frame = new Frame(width * 2/3, 0, width/3, width/3, "#673AB7", "#FBE6FF", "#E6C0EC");
 
}

function draw() {
  background(frameCount, 0, 0);
  // noCursor();
  
  pos_frame.draw();
  vel_frame.draw();
  acc_frame.draw();
  
  if (mode == 'pos') {
    pos.set(pos_frame.marker.pos.x, pos_frame.marker.pos.y);
  } else if (mode == 'vel') {
    
    vel = vel_frame.marker.pos.copy().sub(vel_frame.origin).div(VEL_FACTOR);
    
    pos.set(pos_frame.marker.pos.x, pos_frame.marker.pos.y);
    
    pos.add(vel);
    
    
  } else if (mode == 'acc') {
    
    acc = acc_frame.marker.pos.copy().sub(acc_frame.origin).div(ACC_FACTOR);
    
    vel.add(acc);
    
    
    pos.add(vel);
  }
  
  
  prevPosList.push( pos.copy() );
  
  if (prevPosList.length > PREV_LIST_LENGTH) {
    prevPosList.shift();
  }
  
  if (mode != 'vel') {
    vel = prevPosList.slice(-1)[0].copy()
    vel.sub( prevPosList.slice(-2)[0] );
  }
  
  prevVelList.push( vel.copy() );
  
  if (prevVelList.length > PREV_LIST_LENGTH) {
    prevVelList.shift();
  }
  
  if (mode != 'vel') {
    displayVel = createVector(0, 0);

    for (var i = 0; i < prevVelList.length; i++) {

      displayVel.add( prevVelList[i].copy().div( 1 + prevVelList.length - i ) );
    }
  }
  
  if (mode != 'acc') {
    prevAccList.push( prevVelList.slice(-1)[0].copy().sub(prevVelList.slice(-2)[0]) );
  }
  
  if (prevAccList.length > PREV_LIST_LENGTH) {
    prevAccList.shift();
  }
  
  
  if (mode != 'acc') {
    displayAcc = createVector(0, 0);

    for (var i = 0; i < prevAccList.length; i++) {
      displayAcc.add( prevAccList[i] )
    }

    displayAcc.div(prevAccList.length);
  }
  
  prevDisplayVel = displayVel.copy();
  
  if (mode != 'pos') {
    pos_frame.marker.pos.set(pos.x, pos.y);
  }
  
  displayVel.mult(VEL_FACTOR);
//   strokeWeight(3);
//   stroke("#8BC34A");
//   line(pos.x, pos.y, pos.x+displayVel.x, pos.y+displayVel.y);
  
  if (mode != 'vel') {
    vel_frame.marker.pos.set(vel_frame.origin.x + displayVel.x, vel_frame.origin.y + displayVel.y);
  }
  
  
  
  
  displayAcc.mult(ACC_FACTOR)
  
//   stroke("#9C27B0");
//   line(pos.x+displayVel.x, pos.y+displayVel.y, pos.x+displayVel.x+displayAcc.x, pos.y+displayVel.y+displayAcc.y);
  
//   noStroke();
//   textSize(30);
//   text("Acc.x: "+prevVelList.slice(-1)[0].x, 100, 100);
//   text("Acc.y: "+prevVelList.slice(-1)[0].y, 100, 130);
  
  if (mode != 'acc') {
    acc_frame.marker.pos.set(acc_frame.origin.x + displayAcc.x, acc_frame.origin.y + displayAcc.y);
  }
  
}


function mouseDragged() {
  
  // print("working")
  
  prev_mouse_pos = createVector(pmouseX, pmouseY);
  new_mouse_pos = createVector(mouseX, mouseY);
  
  if (pos_frame.marker.point_in_marker()) {
    pos_frame.marker.pos = new_mouse_pos.copy();
    mode = 'pos';
  } else if (vel_frame.marker.point_in_marker()) {
    vel_frame.marker.pos = new_mouse_pos.copy();
    mode = 'vel';
  } else if (acc_frame.marker.point_in_marker()) {
    acc_frame.marker.pos = new_mouse_pos.copy();
    mode = 'acc';
  }
  
  
}