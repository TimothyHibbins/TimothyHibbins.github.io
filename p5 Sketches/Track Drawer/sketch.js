const M = 75;

let zoom = 0.0065;

const TURN = "turn";
const STRAIGHT = "straight";

const LEFT_HANDER = -1;
const RIGHT_HANDER = 1;

let track;

let initialAngle = 0;
let initialPos = false;

let lastTrackPoint;
let lastTrackPointAngle;
let endAngle;
let endPos;

let Xb;
let Yb;

let img;

function preload() {
  img = loadImage("Monte_Carlo_Formula_1_track_map.svg.png");
}

function setup() {
  createCanvas(windowWidth, windowHeight);

  track = [
    // new Turn(50 * M, radians(160), RIGHT_HANDER)
  ]
}

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

function drawTrack(x, y, startAngle, track) {

  endAngle = startAngle;
  endPos = createVector(x, y);




  strokeWeight(M * 30);
  strokeCap(SQUARE);
  stroke("#383838ff");
  noFill();

  push();

  translate(x, y);
  rotate(startAngle);

  for (const [i, trackSegment] of track.entries()) {
    // console.log(trackSegment);

    if (i == track.length - 1) {

      lastTrackPoint = endPos.copy();
      lastTrackPointAngle = endAngle;

    }

    if (trackSegment.segmentType == STRAIGHT) {

      line(0, 0, 0, -trackSegment.length);

      translate(0, -trackSegment.length);
      endPos.add(0, -trackSegment.length);

    } else if (trackSegment.segmentType == TURN) {

      let angles = {
        [LEFT_HANDER]: { start: -trackSegment.angle, stop: 0 },
        [RIGHT_HANDER]: { start: TAU / 2, stop: TAU / 2 + trackSegment.angle },
      }

      console
      arc(trackSegment.radius * trackSegment.direction, 0,
        trackSegment.radius * 2, trackSegment.radius * 2,
        angles[trackSegment.direction].start,
        angles[trackSegment.direction].stop);

      translate(trackSegment.radius * trackSegment.direction, 0);
      rotate(trackSegment.angle * trackSegment.direction);
      translate(-trackSegment.radius * trackSegment.direction, 0);


      // if (i == 0) {

      endPos.add(createVector(trackSegment.radius * trackSegment.direction, 0).rotate(endAngle));
      endPos.add(createVector(-trackSegment.radius * trackSegment.direction, 0).rotate(endAngle + trackSegment.angle * trackSegment.direction));

      // } else {

      //   endPos.add(createVector(trackSegment.radius * trackSegment.direction, 0));
      //   endPos.add(createVector(-trackSegment.radius * trackSegment.direction, 0).rotate(trackSegment.angle * trackSegment.direction));


      // }

      endAngle += trackSegment.angle * trackSegment.direction;

    }

  }

  pop();

}

function onceTrackStarted() {

  drawTrack(initialPos.x / zoom, initialPos.y / zoom, initialAngle, track);

  push();
  fill("#ff0000ff");
  noStroke();

  translate(endPos.x, endPos.y);
  rotate(endAngle);

  triangle(0, 0,
    0 - 10 / zoom, 0 + 30 / zoom,
    0 + 10 / zoom, 0 + 30 / zoom,
  );
  pop();

}

function mouseClicked() {

  if (initialPos == false) {
    initialPos = createVector(mouseX, mouseY);
  }

  track.push(new Turn(0, 0, 1));

}

function mouseWheel(e) {

  if (e.delta > 0) {
    initialAngle += radians(2);
  } else {
    initialAngle -= radians(2);
  }

}

function printTrackCode() {

  let output = "";

  for (let trackSegment of track) {

    let d = "RIGHT_HANDER";
    if (trackSegment.direction == LEFT_HANDER) {
      d = "LEFT_HANDER";
    }
    output += `new Turn(${trackSegment.radius}, ${trackSegment.angle}, ${d}),\n`;
  }

  console.log(output);


}

function keyPressed() {

  if (key == "p") {
    printTrackCode();
  } else if (key == "d") {
    console.log("working");
    // track.splice(track.length - 2, 2);
    track.pop();
  }


}

function draw() {
  background(255);

  let newWidth = width * 2 / 3;
  let aspect = img.height / img.width;
  let newHeight = newWidth * aspect;

  tint(255, 40);
  image(img, 0, 0, newWidth, newHeight);
  noTint(255, 150);

  push();
  scale(zoom);

  if (track.length > 0) {
    onceTrackStarted();

    pop();

    let Xa = 0;
    let Ya = 0;

    let mousePosRelativeToLastTrackPoint = createVector(mouseX - lastTrackPoint.x * zoom, mouseY - lastTrackPoint.y * zoom);
    mousePosRelativeToLastTrackPoint.rotate(-lastTrackPointAngle);

    Xb = mousePosRelativeToLastTrackPoint.x;
    Yb = mousePosRelativeToLastTrackPoint.y;

    let Xc = (

      (sq(Xa) - sq(Xb) - sq(Yb - Ya)) /
      (2 * (Xa - Xb))

    );
    let Yc = 0;

    track[track.length - 1].radius = abs(Xc / zoom);

    centreToStart = createVector(Xa - Xc, Ya - Yc);
    centreToEnd = createVector(Xb - Xc, Yb - Yc);

    let a;

    if (Xb > 0) {
      a = p5.Vector.angleBetween(centreToStart, centreToEnd);
      track[track.length - 1].direction = RIGHT_HANDER;
      // console.log("right", degrees(a));
    } else {
      a = p5.Vector.angleBetween(centreToEnd, centreToStart);
      track[track.length - 1].direction = LEFT_HANDER;
      // console.log("left", degrees(a));
    }

    track[track.length - 1].angle = a;

  } else {
    pop();

    push();
    fill("#ff0000ff");
    noStroke();

    translate(mouseX, mouseY);
    rotate(initialAngle);

    triangle(0, 0,
      0 - 10, 0 + 30,
      0 + 10, 0 + 30,
    );
    pop();

  }

}