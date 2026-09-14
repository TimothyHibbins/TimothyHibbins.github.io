/* Lexis Bar Engine Example 1 — Full Lexis diagram with annual 1yr x 1yr cells,
   color-coded by age-specific mortality rate (q_x). Instantiates LexisHexEngine
   and wires it to p5 lifecycle and mouse/touch handlers. */

let engine;

function setup() {
    const canvas = createCanvas(windowWidth, windowHeight);
    canvas.parent(document.querySelector('main'));
    pixelDensity(Math.min(2, window.devicePixelRatio || 1));

    engine = new LexisHexEngine({
        dataUrl: 'data/au_life_table.json',
        minBirthYear: 1890,
        maxBirthYear: 2026,
        presentYear: 2026,
        resolution: 10,
        cellSize: 24,
        bgColor: '#f0f0f0',
        initialView: { centerYear: 1970, centerAge: 40, scale: 1.2 },
    });
    engine.attachP5(this === window ? window : this);
    engine.resize(width, height);
    engine.load().then(() => {
        buildResolutionControl(engine);
        redraw();
    });

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

function mouseMoved() {
    if (!engine || !engine.ready) return;
    engine.handleHover(mouseX, mouseY);
    redraw();
}

function mousePressed() {
    if (!engine || !engine.ready) return;
    engine.handlePressStart(mouseX, mouseY);
}

function mouseDragged() {
    if (!engine || !engine.ready) return;
    engine.handlePressMove(mouseX, mouseY);
    engine.handleHover(mouseX, mouseY);
    redraw();
}

function mouseReleased() {
    if (!engine) return;
    engine.handlePressEnd();
}

function mouseWheel(event) {
    if (!engine || !engine.ready) return false;
    engine.handleWheelZoom(event.delta, mouseX, mouseY);
    redraw();
    return false;
}

function touchStarted() {
    if (!engine || !engine.ready) return false;
    if (touches.length === 1) {
        engine.handlePressStart(touches[0].x, touches[0].y);
        engine.handleHover(touches[0].x, touches[0].y);
    } else if (touches.length === 2) {
        engine.handlePressEnd();
    }
    redraw();
    return false;
}

function touchMoved() {
    if (!engine || !engine.ready) return false;
    if (touches.length === 1) {
        engine.handlePressMove(touches[0].x, touches[0].y);
        engine.handleHover(touches[0].x, touches[0].y);
    } else if (touches.length === 2) {
        const [a, b] = touches;
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
        engine.handlePinch(dist, midX, midY);
    }
    redraw();
    return false;
}

function touchEnded() {
    if (!engine) return false;
    engine.handlePressEnd();
    engine.handlePinchEnd();
    return false;
}

function buildResolutionControl(eng) {
    const container = document.createElement('div');
    container.className = 'resolution-toggle-bar';
    container.style.cssText = `
    position: fixed;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(255, 255, 255, 0.92);
    border: 1px solid rgba(0, 0, 0, 0.15);
    border-radius: 20px;
    padding: 3px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
    display: flex;
    gap: 4px;
    z-index: 1000;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  `;

    const options = [
        { label: '10-Year', value: 10 },
        { label: '5-Year', value: 5 },
        { label: '1-Year', value: 1 },
    ];

    const buttons = [];
    options.forEach(opt => {
        const btn = document.createElement('button');
        btn.textContent = opt.label;
        btn.style.cssText = `
      padding: 4px 12px;
      font-size: 11px;
      font-weight: 600;
      border: none;
      border-radius: 16px;
      cursor: pointer;
      transition: all 0.2s ease;
    `;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            eng.setResolution(opt.value);
            updateStyles();
        });
        container.appendChild(btn);
        buttons.push({ btn, value: opt.value });
    });

    function updateStyles() {
        const cur = eng.resolution || 10;
        buttons.forEach(({ btn, value }) => {
            if (value === cur) {
                btn.style.background = '#0284c7';
                btn.style.color = '#ffffff';
                btn.style.boxShadow = '0 1px 3px rgba(0,0,0,0.2)';
            } else {
                btn.style.background = 'transparent';
                btn.style.color = '#444444';
                btn.style.boxShadow = 'none';
            }
        });
    }

    document.body.appendChild(container);
    updateStyles();
}
