var selected_molecule;

var molecules;

var electric_field;

var rest_length = 150;

var initial_x = 0;

var k = 0.005;

var f = 0;

function draw_spring(pointA, pointB, w, spirals) {
  //fill(0);
  //rect(x, y-w/2, l, w);
  
  let l = p5.Vector.dist(pointA, pointB);
  let x = pointA.x;
  let y = pointA.y;
  
  push();
    
  translate(x, y);
  rotate(p5.Vector.sub(pointB, pointA).heading());
  
  stroke(0);
  noFill();
  strokeWeight(1.5);
  beginShape();
  for (let p = 0; p < l; p++) {
    curveVertex(p, sin(p/l*TAU*spirals)*w/2);
  }
  endShape();
  
  pop();
  
}

class Molecule {
  constructor(name, atoms, bonds) {
    
    this.name = name
    this.atoms = atoms;
    this.bonds = bonds;
    
  }
  
  render() {
    
    for (let i = 0; i < this.bonds.length; i++) {
      let atomA = this.atoms[this.bonds[i][0]-1];
      let atomB = this.atoms[this.bonds[i][1]-1];
      
      stroke('#202020');
      strokeWeight(10);
      //line(atomA.pos.x, atomA.pos.y, atomB.pos.x, atomB.pos.y);
      draw_spring(atomA.pos, atomB.pos, 40, 15)
      
    }
    
    for (let i = 0; i < this.atoms.length; i++ ) {
      this.atoms[i].render();
    }
    
  }
  
  apply_bonds() {
    for (let i = 0; i < this.bonds.length; i++) {
      apply_bond(this.atoms[this.bonds[i][0]-1], this.atoms[this.bonds[i][1]-1], this.bonds[i][2]);
    }
  }
  
  apply_electric_field() {
    for (let i = 0; i < this.bonds.length; i++) {
      this.atoms[i].acc.add(p5.Vector.mult(electric_field, this.atoms[i].charge));
    }
  }
  
  reset_acc() {
    for (let i = 0; i < this.atoms.length; i++ ) {
      this.atoms[i].acc.mult(0);
    }
  }
  
  update() {
    for (let i = 0; i < this.atoms.length; i++ ) {
      this.atoms[i].update();
    }
  }
}

class Atom {
  constructor(pos, vel, acc, charge) {
    
    this.pos = pos;
    this.vel = vel;
    this.acc = acc;
    this.charge = charge;
    
    this.bearing = 0;
    
    let colour = '#0';
    if (this.charge > 0) {
      colour = '#F02718'
    } else if (this.charge < 0) {
      colour = '#12A0E0';
    }
    
    this.colour = colour;
    
  }
  
  render() {
    fill(255);
    
    stroke(this.colour);
    
    strokeWeight(10);
    circle(this.pos.x, this.pos.y, 100);
    
    
    // draws electric field vector
    
    
    
    let electric_force = p5.Vector.mult(electric_field, this.charge);
    
    if (electric_force.mag() > 0) {
      let x = electric_force.x;
      let y = electric_force.y;

      let arrow_scale = 700;
      let arrow_head_length = 8;
      let arrow_head_base = 9;

      strokeWeight(3);
      line(this.pos.x, this.pos.y, this.pos.x+(x*700), this.pos.y+(y*700));


      // Draws vector arrowhead
      push();

      translate(this.pos.x+x*arrow_scale, this.pos.y+y*arrow_scale);
      rotate(electric_force.heading());

      noStroke();
      fill(this.colour);

      triangle(0,arrow_head_base/2,arrow_head_length,0,0,-arrow_head_base/2);

      pop();
    }
    
    
    
  }
  
  update() {
    //this.acc ;
    this.vel.add(this.acc);
    this.pos.add(this.vel);

  }

}

function setup() {
  myCanvas2 = document.getElementById("myCanvas")
  createCanvas(myCanvas2.offsetWidth, myCanvas2.offsetHeight, myCanvas2);
  //fullscreen(true);
  
  molecules = [
    new Molecule('Carbon Dioxide (CO2)',
    [
      new Atom(createVector(width/2 - rest_length - initial_x, height/2), createVector(0, 0), createVector(0, 0), -1),
      new Atom(createVector(width/2, height/2), createVector(0, 0.5), createVector(0, 0), 2),
      new Atom(createVector(width/2 + rest_length + initial_x, height/2), createVector(0, 0), createVector(0, 0), -1)
      
    ],
    [
      [2, 1, createVector(-150, 0)],
      [2, 3, createVector(150, 0)]
    ]),
    
    new Molecule('Water (H20)',
    [
      new Atom(createVector(width/2 - 100, height/2+60), createVector(0, 1), createVector(0, 0), -1),
      new Atom(createVector(width/2, height/2), createVector(0, 0), createVector(0, 0), 1),
      new Atom(createVector(width/2 + 100, height/2+60), createVector(0, 1), createVector(0, 0), -1)
      
    ],
    [
      [2, 1, createVector(-100, 60)],
      [2, 3, createVector(100, 60)]
    ]),
    
    new Molecule('Dinitrogen (N2)',
    [
      new Atom(createVector(width/2 - rest_length/2, height/2), createVector(0, 0), createVector(0, 0), 1),
      new Atom(createVector(width/2 + rest_length/2, height/2), createVector(0, 0), createVector(0, 0), 1),
      
    ],
    [
      [1, 2]
    ]),
  ];

  
  electric_field = createVector(0, 0);
  
  selected_molecule = molecules[0];
}

function apply_bond(atomA, atomB, bondVector) {
  
//   let distance_between_atoms = p5.Vector.dist(atomA.pos, atomB.pos);
  
//   let x = distance_between_atoms - rest_length;
  
//   let force = -k * x;
  let target_point_for_atomB = p5.Vector.add(atomA.pos, bondVector);//p5.Vector.rotate(bondVector,  atomA.bearing));
  let target_point_for_atomA = p5.Vector.add(atomB.pos, p5.Vector.mult(bondVector, -1));
  //print(target_point.mag());
  
  
  stroke('#FFC107');
  strokeWeight(1);
  //line(atomA.pos.x, atomA.pos.y, target_point_for_atomB.x, target_point_for_atomB.y);
  strokeWeight(15);
  //point(target_point_for_atomB.x, target_point_for_atomB.y);
  
  let force_for_atom_B = p5.Vector.sub(atomB.pos, target_point_for_atomB).mult(-k);
  let force_for_atom_A = p5.Vector.sub(atomA.pos, target_point_for_atomA).mult(-k);
  
  atomB.acc.add(force_for_atom_B);
  atomA.acc.add(force_for_atom_A);
  
  
  // atomA.acc.add(p5.Vector.sub(atomA.pos, atomB.pos).normalize().mult(force));
  // atomB.acc.add(p5.Vector.sub(atomB.pos, atomA.pos).normalize().mult(force));
  
}

function update_electric_field() {
  f = mouseX/width;
  
  if (mouseIsPressed) {
    
    electric_field = createVector(0.05*sin(f * frameCount), 0);
    
  } else {
    electric_field = createVector(0, 0);
  }
}

function draw() {
  background(255);
  
  noStroke();
  fill(0);
  textSize(15);
  textFont('Helvetica');
  textAlign(LEFT, TOP);
  text('Click to cast light on the molecule. \nControl the frequency by moving the mouse left or right.', 30, height-80);
  
  textAlign(CENTER);
  text(selected_molecule.name, width/2, height/4);
  
  textAlign(LEFT, TOP);
  text(round(f*getTargetFrameRate(), 1)+' cycles per second', mouseX, mouseY-10);
  
  for (let i = 0; i < 10; i++) {
    let x = i * width / 10;
    let y = height - 30;
    
    noStroke();
    text(round(i / 10*getTargetFrameRate(), 1)+' Hz', x, y);
    stroke(0);
    strokeWeight(1);
    line(x, y, x, height);
  }
  
  update_electric_field();

  selected_molecule.render();
  
  selected_molecule.reset_acc();
  
  selected_molecule.apply_electric_field();
  
  selected_molecule.apply_bonds();
  
  selected_molecule.update();
  
}