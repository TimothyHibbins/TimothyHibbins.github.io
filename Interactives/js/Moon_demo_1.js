function setup() {
    const container = document.getElementById("p5canvas");
    const w = container.clientWidth;
    const h = container.clientHeight;

    const cnv = createCanvas(w, h);
    cnv.parent(container);
    textAlign(CENTER, CENTER);
    textSize(32);
}

function draw() {
    background(255, 100, 0);
    fill(0);
    text("moon", width / 2, height / 2);
}