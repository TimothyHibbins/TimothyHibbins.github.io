// Dynamic Go — a visual reimagining of Go
// Stones are starburst-shaped and merge into chains

const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

let game, display;
let boardSize = 9;

function setup() {
  createCanvas(windowWidth, windowHeight);
  textFont('sans-serif');
  newGame(boardSize);
}

function newGame(size) {
  boardSize = size;
  game = new GoGame(size);
  display = new BoardDisplay(game);
}

// Color palette
const BG = '#ffffff';
const GRID_COL = [240, 240, 240];
const BLUE = { fill: [50, 120, 255], stroke: [30, 90, 220], name: 'Blue', light: [180, 210, 255] };
const GREEN = { fill: [20, 200, 80], stroke: [10, 160, 60], name: 'Green', light: [160, 235, 185] };
const SHARED_LIGHT = [180, 230, 230];

function colorFor(c) { return c === BLACK ? BLUE : GREEN; }

function draw() {
  background(BG);
  display.draw();
}

function mousePressed() {
  if (mouseButton === LEFT) {
    // Check timeline bar click first
    if (display && display.handleTimelineClick(mouseX, mouseY)) return;
    const pos = display.screenToBoard(mouseX, mouseY);
    if (pos) game.playMove(pos.x, pos.y);
  }
}

function keyPressed() {
  if (key === 'p' || key === 'P') game.playPass();
  if (key === 'n' || key === 'N') newGame(boardSize);
  if (key === '1') newGame(9);
  if (key === '2') newGame(13);
  if (key === '3') newGame(19);
  if (keyCode === LEFT_ARROW) game.timelineBack();
  if (keyCode === RIGHT_ARROW) game.timelineForward();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}


// =========================================
//              GAME LOGIC
// =========================================

class GoGame {
  constructor(size) {
    this.size = size;
    this.board = Array.from({ length: size }, () => Array(size).fill(EMPTY));
    this.currentPlayer = BLACK;
    this.captures = { [BLACK]: 0, [WHITE]: 0 };
    this.previousBoard = null;
    this.consecutivePasses = 0;
    this.gameOver = false;

    // Timeline: array of snapshots, index points to current position
    this.history = [this._snapshot()];
    this.historyIndex = 0;
  }

  _snapshot() {
    return {
      board: this.board.map(r => [...r]),
      currentPlayer: this.currentPlayer,
      captures: { ...this.captures },
      previousBoard: this.previousBoard ? this.previousBoard.map(r => [...r]) : null,
      consecutivePasses: this.consecutivePasses,
      gameOver: this.gameOver,
    };
  }

  _restore(snap) {
    this.board = snap.board.map(r => [...r]);
    this.currentPlayer = snap.currentPlayer;
    this.captures = { ...snap.captures };
    this.previousBoard = snap.previousBoard ? snap.previousBoard.map(r => [...r]) : null;
    this.consecutivePasses = snap.consecutivePasses;
    this.gameOver = snap.gameOver;
  }

  _pushState() {
    // Truncate any future states if we branched
    this.history.length = this.historyIndex + 1;
    this.history.push(this._snapshot());
    this.historyIndex = this.history.length - 1;
  }

  timelineBack() {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      this._restore(this.history[this.historyIndex]);
    }
  }

  timelineForward() {
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this._restore(this.history[this.historyIndex]);
    }
  }

  timelineGoTo(idx) {
    if (idx >= 0 && idx < this.history.length) {
      this.historyIndex = idx;
      this._restore(this.history[idx]);
    }
  }

  opponent(c) {
    return c === BLACK ? WHITE : BLACK;
  }

  inBounds(x, y) {
    return x >= 0 && x < this.size && y >= 0 && y < this.size;
  }

  neighbors(x, y) {
    const result = [];
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const nx = x + dx, ny = y + dy;
      if (this.inBounds(nx, ny)) result.push([nx, ny]);
    }
    return result;
  }

  getGroup(x, y) {
    const color = this.board[x][y];
    if (color === EMPTY) return [];
    const group = [];
    const visited = new Set();
    const stack = [[x, y]];
    while (stack.length > 0) {
      const [cx, cy] = stack.pop();
      const key = cx * 100 + cy;
      if (visited.has(key)) continue;
      visited.add(key);
      group.push([cx, cy]);
      for (const [nx, ny] of this.neighbors(cx, cy)) {
        if (!visited.has(nx * 100 + ny) && this.board[nx][ny] === color) {
          stack.push([nx, ny]);
        }
      }
    }
    return group;
  }

  countLiberties(group) {
    const liberties = new Set();
    for (const [x, y] of group) {
      for (const [nx, ny] of this.neighbors(x, y)) {
        if (this.board[nx][ny] === EMPTY) liberties.add(nx * 100 + ny);
      }
    }
    return liberties.size;
  }

  copyBoard() {
    return this.board.map(row => [...row]);
  }

  boardsEqual(a, b) {
    for (let i = 0; i < this.size; i++)
      for (let j = 0; j < this.size; j++)
        if (a[i][j] !== b[i][j]) return false;
    return true;
  }

  placeStone(x, y) {
    if (this.gameOver) return false;
    if (!this.inBounds(x, y)) return false;
    if (this.board[x][y] !== EMPTY) return false;

    const color = this.currentPlayer;
    const opp = this.opponent(color);
    const saved = this.copyBoard();

    this.board[x][y] = color;

    // Capture opponent groups with zero liberties
    let captured = 0;
    for (const [nx, ny] of this.neighbors(x, y)) {
      if (this.board[nx][ny] === opp) {
        const group = this.getGroup(nx, ny);
        if (this.countLiberties(group) === 0) {
          for (const [gx, gy] of group) {
            this.board[gx][gy] = EMPTY;
            captured++;
          }
        }
      }
    }

    // Suicide check
    if (this.countLiberties(this.getGroup(x, y)) === 0) {
      this.board = saved;
      return false;
    }

    // Ko check
    if (this.previousBoard && this.boardsEqual(this.board, this.previousBoard)) {
      this.board = saved;
      return false;
    }

    this.captures[color] += captured;
    this.previousBoard = saved;
    this.consecutivePasses = 0;
    this.currentPlayer = opp;
    return true;
  }

  playMove(x, y) {
    if (this.placeStone(x, y)) {
      this._pushState();
      return true;
    }
    return false;
  }

  pass() {
    if (this.gameOver) return;
    this.consecutivePasses++;
    this.currentPlayer = this.opponent(this.currentPlayer);
    if (this.consecutivePasses >= 2) this.gameOver = true;
  }

  playPass() {
    if (this.gameOver) return;
    this.pass();
    this._pushState();
  }

  calculateTerritory() {
    const territory = Array.from({ length: this.size }, () => Array(this.size).fill(EMPTY));
    const visited = Array.from({ length: this.size }, () => Array(this.size).fill(false));

    for (let i = 0; i < this.size; i++) {
      for (let j = 0; j < this.size; j++) {
        if (this.board[i][j] === EMPTY && !visited[i][j]) {
          const region = [];
          const borderColors = new Set();
          const stack = [[i, j]];

          while (stack.length > 0) {
            const [cx, cy] = stack.pop();
            if (visited[cx][cy]) continue;
            visited[cx][cy] = true;
            region.push([cx, cy]);
            for (const [nx, ny] of this.neighbors(cx, cy)) {
              if (this.board[nx][ny] === EMPTY && !visited[nx][ny]) {
                stack.push([nx, ny]);
              } else if (this.board[nx][ny] !== EMPTY) {
                borderColors.add(this.board[nx][ny]);
              }
            }
          }

          if (borderColors.size === 1) {
            const owner = [...borderColors][0];
            for (const [rx, ry] of region) territory[rx][ry] = owner;
          }
        }
      }
    }
    return territory;
  }

  // Returns per-direction arm state: 'connected' | 'open' | 'blocked'
  // connected = same-color neighbor, open = empty (liberty), blocked = opponent/edge
  getArmStates(x, y) {
    const c = this.board[x][y];
    if (c === EMPTY) return null;
    const dirs = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
    const result = {};
    for (const [name, [dx, dy]] of Object.entries(dirs)) {
      const nx = x + dx, ny = y + dy;
      if (!this.inBounds(nx, ny)) result[name] = 'blocked';
      else if (this.board[nx][ny] === c) result[name] = 'connected';
      else if (this.board[nx][ny] === EMPTY) result[name] = 'open';
      else result[name] = 'blocked';
    }
    return result;
  }

  // Arm states for a hypothetical stone at (x,y)
  getHypotheticalArmStates(x, y, color) {
    const dirs = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
    const result = {};
    for (const [name, [dx, dy]] of Object.entries(dirs)) {
      const nx = x + dx, ny = y + dy;
      if (!this.inBounds(nx, ny)) result[name] = 'blocked';
      else if (this.board[nx][ny] === color) result[name] = 'connected';
      else if (this.board[nx][ny] === EMPTY) result[name] = 'open';
      else result[name] = 'blocked';
    }
    return result;
  }

  // Build a map of all liberties: for each empty cell, which player colors touch it
  getLibertyMap() {
    const libMap = Array.from({ length: this.size }, () => Array(this.size).fill(null));
    for (let x = 0; x < this.size; x++) {
      for (let y = 0; y < this.size; y++) {
        if (this.board[x][y] !== EMPTY) continue;
        const touchingColors = new Set();
        for (const [nx, ny] of this.neighbors(x, y)) {
          if (this.board[nx][ny] !== EMPTY) touchingColors.add(this.board[nx][ny]);
        }
        if (touchingColors.size > 0) {
          libMap[x][y] = { colors: touchingColors };
        }
      }
    }
    return libMap;
  }

  // Arm states for a liberty pebble: connect toward stones that use it,
  // and toward other liberties with overlapping owners
  getLibertyArmStates(x, y, colors) {
    const dirs = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
    const result = {};
    for (const [name, [dx, dy]] of Object.entries(dirs)) {
      const nx = x + dx, ny = y + dy;
      if (!this.inBounds(nx, ny)) {
        result[name] = 'blocked';
      } else if (this.board[nx][ny] !== EMPTY && colors.has(this.board[nx][ny])) {
        result[name] = 'connected';
      } else {
        result[name] = 'blocked';
      }
    }
    return result;
  }
}


// =========================================
//            BOARD DISPLAY
// =========================================

class BoardDisplay {
  constructor(game) {
    this.game = game;
  }

  recalcLayout() {
    const uiMargin = 70;
    const padding = 40;
    const available = min(width - padding * 2, height - uiMargin - padding);
    this.cellSize = available / (this.game.size + 1);
    this.offsetX = (width - (this.game.size - 1) * this.cellSize) / 2;
    this.offsetY = uiMargin + (height - uiMargin - (this.game.size - 1) * this.cellSize) / 2;

    // Pebble geometry
    this.sq = this.cellSize * 0.40;  // center square half-extent
    this.bw = this.sq;               // bridge half-width = square half-extent
    this.h = this.cellSize * 0.5;   // half-cell (midpoint reach)
  }

  boardToScreen(bx, by) {
    return {
      x: this.offsetX + bx * this.cellSize,
      y: this.offsetY + by * this.cellSize
    };
  }

  screenToBoard(mx, my) {
    const bx = Math.round((mx - this.offsetX) / this.cellSize);
    const by = Math.round((my - this.offsetY) / this.cellSize);
    if (bx >= 0 && bx < this.game.size && by >= 0 && by < this.game.size) {
      return { x: bx, y: by };
    }
    return null;
  }

  draw() {
    this.recalcLayout();
    this.drawBoard();
    this.drawLiberties();
    this.drawStones();
    this.drawHover();
    this.drawTimeline();
    this.drawUI();
  }

  // --- Shared drawing primitive ---
  //
  //  Draws a center square + rectangular bridges in each direction.
  //  armColors: { up, down, left, right } — each is a color array or null (no bridge).

  drawCell(cx, cy, centerColor, armColors) {
    const { sq, bw, h } = this;
    const ov = 0.5; // overlap to eliminate hairline gaps
    noStroke();
    rectMode(CORNERS);

    // Draw bridges first (extending slightly into center area)
    if (armColors.up) {
      fill(armColors.up);
      rect(cx - bw, cy - h, cx + bw, cy - sq + ov);
    }
    if (armColors.right) {
      fill(armColors.right);
      rect(cx + sq - ov, cy - bw, cx + h, cy + bw);
    }
    if (armColors.down) {
      fill(armColors.down);
      rect(cx - bw, cy + sq - ov, cx + bw, cy + h);
    }
    if (armColors.left) {
      fill(armColors.left);
      rect(cx - h, cy - bw, cx - sq + ov, cy + bw);
    }

    // Central square on top (covers overlap area)
    fill(centerColor);
    rect(cx - sq, cy - sq, cx + sq, cy + sq);
  }

  // --- Board grid (pebble-style lattice) ---

  drawBoard() {
    const { sq, bw } = this;
    const gc = GRID_COL;
    noStroke();
    rectMode(CORNERS);

    for (let x = 0; x < this.game.size; x++) {
      for (let y = 0; y < this.game.size; y++) {
        const p = this.boardToScreen(x, y);

        // Central square
        fill(gc);
        rect(p.x - sq, p.y - sq, p.x + sq, p.y + sq);

        // Right bridge (full span to next cell's center square)
        if (x < this.game.size - 1) {
          rect(p.x + sq, p.y - bw, p.x + this.cellSize - sq, p.y + bw);
        }
        // Down bridge (full span to next cell's center square)
        if (y < this.game.size - 1) {
          rect(p.x - bw, p.y + sq, p.x + bw, p.y + this.cellSize - sq);
        }
      }
    }
  }

  // --- Liberty color helper ---

  libertyColor(libInfo) {
    if (libInfo.colors.size === 1) {
      return colorFor([...libInfo.colors][0]).light;
    }
    return SHARED_LIGHT;
  }

  // --- Liberty pebbles ---

  drawLiberties() {
    const libMap = this.game.getLibertyMap();
    const dirVecs = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

    for (let x = 0; x < this.game.size; x++) {
      for (let y = 0; y < this.game.size; y++) {
        const info = libMap[x][y];
        if (!info) continue;

        const p = this.boardToScreen(x, y);
        const libCol = this.libertyColor(info);

        // Arms connect toward stones — bridge color matches that stone's light color
        const armColors = {};
        for (const dir of ['up', 'down', 'left', 'right']) {
          const [dx, dy] = dirVecs[dir];
          const nx = x + dx, ny = y + dy;
          if (this.game.inBounds(nx, ny) && this.game.board[nx][ny] !== EMPTY
            && info.colors.has(this.game.board[nx][ny])) {
            armColors[dir] = colorFor(this.game.board[nx][ny]).light;
          } else {
            armColors[dir] = null;
          }
        }

        this.drawCell(p.x, p.y, libCol, armColors);
      }
    }
  }

  // --- Stones ---

  drawStones() {
    const libMap = this.game.getLibertyMap();
    const dirVecs = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

    for (let x = 0; x < this.game.size; x++) {
      for (let y = 0; y < this.game.size; y++) {
        const c = this.game.board[x][y];
        if (c === EMPTY) continue;

        const p = this.boardToScreen(x, y);
        const col = colorFor(c);
        const arms = this.game.getArmStates(x, y);

        const armColors = {};
        for (const dir of ['up', 'down', 'left', 'right']) {
          if (arms[dir] === 'connected') {
            armColors[dir] = col.fill;
          } else if (arms[dir] === 'open') {
            const [dx, dy] = dirVecs[dir];
            const libInfo = libMap[x + dx][y + dy];
            // Bridge to liberty uses this stone's light color
            armColors[dir] = libInfo ? col.light : null;
          } else {
            armColors[dir] = null;
          }
        }

        this.drawCell(p.x, p.y, col.fill, armColors);
      }
    }
  }

  // --- Hover preview ---

  drawHover() {
    if (this.game.gameOver) return;
    const pos = this.screenToBoard(mouseX, mouseY);
    if (!pos) return;
    if (this.game.board[pos.x][pos.y] !== EMPTY) return;

    const p = this.boardToScreen(pos.x, pos.y);
    const c = this.game.currentPlayer;
    const col = colorFor(c);
    const arms = this.game.getHypotheticalArmStates(pos.x, pos.y, c);

    const pulse = 0.25 + 0.15 * sin(frameCount * 0.08);

    const ghostCenter = lerpColor(color(BG), color(col.fill), pulse);
    const armColors = {};
    for (const dir of ['up', 'down', 'left', 'right']) {
      if (arms[dir] === 'connected') {
        armColors[dir] = [red(ghostCenter), green(ghostCenter), blue(ghostCenter)];
      } else {
        armColors[dir] = null;
      }
    }

    this.drawCell(p.x, p.y, [red(ghostCenter), green(ghostCenter), blue(ghostCenter)], armColors);
  }

  // --- Timeline bar ---

  drawTimeline() {
    const g = this.game;
    const total = g.history.length;
    if (total <= 1) return;

    const barH = 20;
    const barY = height - barH - 15;
    const barX = 40;
    const barW = width - 80;

    // Track
    noStroke();
    fill(230);
    rect(barX, barY, barX + barW, barY + barH, 4);

    // Move notches + filled progress
    const stepW = barW / (total - 1);
    for (let i = 0; i < total; i++) {
      const x = barX + i * stepW;

      // Determine color for this move's notch
      if (i === 0) {
        fill(200);
      } else {
        // The player who played move i is the opponent of currentPlayer in snapshot i
        // Actually, snapshot i-1's currentPlayer is who made this move
        const snap = g.history[i - 1];
        const col = colorFor(snap.currentPlayer);
        if (i <= g.historyIndex) {
          fill(col.fill);
        } else {
          fill(col.light);
        }
      }

      const nW = max(3, min(stepW * 0.6, 12));
      rect(x - nW / 2, barY, x + nW / 2, barY + barH, 2);
    }

    // Current position marker
    const cx = barX + g.historyIndex * stepW;
    fill(40);
    noStroke();
    triangle(cx - 6, barY - 2, cx + 6, barY - 2, cx, barY - 9);

    // Label
    textSize(10);
    textAlign(CENTER, TOP);
    fill(120);
    text(`Move ${g.historyIndex} / ${total - 1}`, width / 2, barY + barH + 3);
  }

  handleTimelineClick(mx, my) {
    const g = this.game;
    const total = g.history.length;
    if (total <= 1) return false;

    const barH = 20;
    const barY = height - barH - 15;
    const barX = 40;
    const barW = width - 80;

    if (my >= barY - 10 && my <= barY + barH + 5 && mx >= barX - 10 && mx <= barX + barW + 10) {
      const ratio = constrain((mx - barX) / barW, 0, 1);
      const idx = Math.round(ratio * (total - 1));
      g.timelineGoTo(idx);
      return true;
    }
    return false;
  }

  // --- UI overlay ---

  drawUI() {
    noStroke();
    const m = 15;
    const lh = max(14, min(20, width * 0.022));
    textSize(lh);
    textAlign(LEFT, TOP);

    // Current player indicator
    const cur = colorFor(this.game.currentPlayer);
    fill(cur.fill);
    noStroke();
    const ir = lh * 0.45;
    ellipse(m + ir, m + ir, ir * 2);

    fill(60);
    text(
      cur.name + ' to play',
      m + ir * 2.8, m
    );

    // Captures
    textSize(lh * 0.85);
    fill(60);
    text(
      `Captures  \u2014  ${BLUE.name}: ${this.game.captures[BLACK]}   ${GREEN.name}: ${this.game.captures[WHITE]}`,
      m, m + lh * 1.6
    );

    // Keyboard hints
    textSize(max(10, lh * 0.7));
    fill(160);
    text('P: Pass  |  N: New  |  1/2/3: Size  |  \u2190\u2192: Undo/Redo', m, m + lh * 3);

    // Game over scoring
    if (this.game.gameOver) {
      const territory = this.game.calculateTerritory();
      let bScore = this.game.captures[BLACK];
      let wScore = this.game.captures[WHITE] + 6.5; // komi
      for (let i = 0; i < this.game.size; i++)
        for (let j = 0; j < this.game.size; j++) {
          if (territory[i][j] === BLACK) bScore++;
          if (territory[i][j] === WHITE) wScore++;
        }
      textSize(max(16, min(24, width * 0.028)));
      textAlign(CENTER, TOP);
      fill(240, 80, 80);
      text('Game Over', width / 2, m);
      textSize(lh * 0.85);
      fill(60);
      const winner = bScore > wScore ? BLUE.name : GREEN.name;
      text(
        `${BLUE.name}: ${bScore}  |  ${GREEN.name}: ${wScore} (incl. 6.5 komi)  |  ${winner} wins`,
        width / 2, m + lh * 1.6
      );
    }
  }
}