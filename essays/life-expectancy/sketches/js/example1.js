/* Example 1 — Australian Survival Curves: compares Period vs Cohort survival
   curves using single-year mortality data from 1900 to 2026. Instantiates
   SurvivalCurveEngine and wires it to p5's global-mode lifecycle + mouse/touch input. */

let engine;

function setup() {
    const canvas = createCanvas(windowWidth, windowHeight);
    canvas.parent(document.querySelector('main'));
    pixelDensity(Math.min(2, window.devicePixelRatio || 1));

    engine = new SurvivalCurveEngine({
        dataUrl: 'data/au_life_table.json',
        initialYear: 1906,
        bgColor: '#f0f0f0',
    });
    engine.attachP5(this === window ? window : this);
    engine.resize(width, height);
    engine.load().then(() => redraw());

    // Hover highlight should clear as soon as the pointer leaves the canvas —
    // p5 has no global mouseOut callback, so listen on the element directly.
    canvas.elt.addEventListener('mouseleave', () => {
        if (!engine) return;
        engine.handleHoverEnd();
        redraw();
    });

    noLoop();
}

function draw() {
    if (engine && engine.ready) engine.draw();
    else {
        background('#f0f0f0');
        noStroke();
        fill(0, 90);
        textAlign(CENTER, CENTER);
        text('Loading Australian life-table data…', width / 2, height / 2);
    }
}

function windowResized() {
    resizeCanvas(windowWidth, windowHeight);
    if (engine) engine.resize(width, height);
    redraw();
}

// --- Hover & Drag / Touch Input ---

function mouseMoved() {
    if (!engine || !engine.ready) return;
    engine.handleHover(mouseX, mouseY);
    redraw();
}

function mousePressed() {
    if (!engine || !engine.ready) return;
    engine.handlePressStart(mouseX, mouseY);
    redraw();
}

function mouseDragged() {
    if (!engine || !engine.ready) return;
    engine.handlePressMove(mouseX, mouseY);
    redraw();
}

function mouseReleased() {
    if (!engine) return;
    engine.handlePressEnd();
    redraw();
}

function touchStarted() {
    if (!engine || !engine.ready) return false;
    if (touches.length > 0) {
        engine.handlePressStart(touches[0].x, touches[0].y);
        redraw();
    }
    return false;
}

function touchMoved() {
    if (!engine || !engine.ready) return false;
    if (touches.length > 0) {
        engine.handlePressMove(touches[0].x, touches[0].y);
        redraw();
    }
    return false;
}

function touchEnded() {
    if (!engine) return false;
    engine.handlePressEnd();
    redraw();
    return false;
}
