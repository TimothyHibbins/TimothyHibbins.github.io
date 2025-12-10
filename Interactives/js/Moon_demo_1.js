function setup() {
    createCanvas(windowWidth, windowHeight);
    textAlign(CENTER, CENTER);
    textSize(32);
}

function mouseWheel(event) {
    event.preventDefault()
}

function draw() {
    background(255, 100, 0);
    fill(0);
    text(`
Test
    `, width / 2, height / 2);
}