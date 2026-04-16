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
const GRID_COL = [247, 247, 247];
const BLOCKED_BRIDGE = [200, 200, 200];
const BLUE = { fill: [50, 120, 255], stroke: [30, 90, 220], name: 'Blue', light: [215, 232, 255] };
const GREEN = { fill: [20, 200, 80], stroke: [10, 160, 60], name: 'Green', light: [205, 243, 218] };
const SHARED_LIGHT = [215, 240, 240];

function colorFor(c) { return c === BLACK ? BLUE : GREEN; }

function draw() {
  background(BG);
  display.draw();
}

function mousePressed() {
  if (mouseButton === LEFT) {
    // Check timeline bar click first
    if (display && display.handleTimelineClick(mouseX, mouseY)) return;
    // Timeline mode: click stone to go to that move
    if (display && display.timelineMode) {
      const pos = display.screenToBoard(mouseX, mouseY);
      if (pos) {
        const mi = game.moveIndex[pos.x][pos.y];
        if (mi > 0 && mi < game.history.length) {
          game.timelineGoTo(mi);
        }
      }
      return;
    }
    const pos = display.screenToBoard(mouseX, mouseY);
    if (pos) game.playMove(pos.x, pos.y);
  }
}

function keyPressed() {
  if (key === 'p' || key === 'P') game.playPass();
  if (key === 'n' || key === 'N') newGame(boardSize);
  if (key === '0') newGame(5);
  if (key === '1') newGame(9);
  if (key === '2') newGame(13);
  if (key === '3') newGame(19);
  if (key === 't' || key === 'T') display.timelineMode = !display.timelineMode;
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
    this.moveIndex = Array.from({ length: size }, () => Array(size).fill(-1)); // which move placed each stone
    this.currentPlayer = BLACK;
    this.captures = { [BLACK]: 0, [WHITE]: 0 };
    this.previousBoard = null;
    this.consecutivePasses = 0;
    this.gameOver = false;
    this.moveCount = 0;

    // Timeline: array of snapshots, index points to current position
    this.history = [this._snapshot()];
    this.historyIndex = 0;
    this.moveCoords = [null]; // parallel to history: {x,y} or null (pass/initial)
  }

  _snapshot() {
    return {
      board: this.board.map(r => [...r]),
      moveIndex: this.moveIndex.map(r => [...r]),
      currentPlayer: this.currentPlayer,
      captures: { ...this.captures },
      previousBoard: this.previousBoard ? this.previousBoard.map(r => [...r]) : null,
      consecutivePasses: this.consecutivePasses,
      gameOver: this.gameOver,
      moveCount: this.moveCount,
    };
  }

  _restore(snap) {
    this.board = snap.board.map(r => [...r]);
    this.moveIndex = snap.moveIndex.map(r => [...r]);
    this.currentPlayer = snap.currentPlayer;
    this.captures = { ...snap.captures };
    this.previousBoard = snap.previousBoard ? snap.previousBoard.map(r => [...r]) : null;
    this.consecutivePasses = snap.consecutivePasses;
    this.gameOver = snap.gameOver;
    this.moveCount = snap.moveCount;
  }

  _pushState() {
    // Truncate any future states if we branched
    this.history.length = this.historyIndex + 1;
    this.moveCoords.length = this.historyIndex + 1;
    this.history.push(this._snapshot());
    this.moveCoords.push(null);
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
    const savedMoveIndex = this.moveIndex.map(r => [...r]);

    this.board[x][y] = color;
    this.moveCount++;
    this.moveIndex[x][y] = this.moveCount;

    // Capture opponent groups with zero liberties
    let captured = 0;
    for (const [nx, ny] of this.neighbors(x, y)) {
      if (this.board[nx][ny] === opp) {
        const group = this.getGroup(nx, ny);
        if (this.countLiberties(group) === 0) {
          for (const [gx, gy] of group) {
            this.board[gx][gy] = EMPTY;
            this.moveIndex[gx][gy] = -1;
            captured++;
          }
        }
      }
    }

    // Suicide check
    if (this.countLiberties(this.getGroup(x, y)) === 0) {
      this.board = saved;
      this.moveIndex = savedMoveIndex;
      this.moveCount--;
      return false;
    }

    // Ko check
    if (this.previousBoard && this.boardsEqual(this.board, this.previousBoard)) {
      this.board = saved;
      this.moveIndex = savedMoveIndex;
      this.moveCount--;
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
      this.moveCoords[this.historyIndex] = { x, y };
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
    this.timelineMode = false;
    this._timelinePreviewIdx = null; // history index being previewed
  }

  recalcLayout() {
    const uiMargin = 70;
    const padding = 40;
    const bottomMargin = this.game.history.length > 1 ? 85 : padding;
    const availH = height - uiMargin - bottomMargin;
    const availW = width - padding * 2;
    const available = min(availW, availH);
    this.cellSize = available / (this.game.size + 1);
    this.offsetX = (width - (this.game.size - 1) * this.cellSize) / 2;
    this.offsetY = uiMargin + (availH - (this.game.size - 1) * this.cellSize) / 2;

    // Pebble geometry
    this.sq = this.cellSize * 0.38;  // center square half-extent
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

    // In timeline mode, handle preview
    if (this.timelineMode) {
      this._updateTimelinePreview();
    } else {
      this._timelinePreviewIdx = null;
    }

    // If previewing, temporarily restore that state for drawing
    const previewing = this._timelinePreviewIdx !== null;
    let savedSnap = null;
    if (previewing) {
      savedSnap = this.game._snapshot();
      this.game._restore(this.game.history[this._timelinePreviewIdx]);
    }

    this.drawBoard();
    this.drawLiberties();
    this.drawStones();

    // Restore real state before drawing hover/UI
    if (previewing) {
      this.game._restore(savedSnap);
    }

    if (!this.timelineMode) {
      this.drawHover();
    }
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
            armColors[dir] = libInfo ? col.light : null;
          } else if (arms[dir] === 'blocked') {
            // Check if blocked by opponent stone (mutual block = darkened bridge)
            const [dx, dy] = dirVecs[dir];
            const nx = x + dx, ny = y + dy;
            if (this.game.inBounds(nx, ny) && this.game.board[nx][ny] !== EMPTY
                && this.game.board[nx][ny] !== c) {
              armColors[dir] = BLOCKED_BRIDGE;
            } else {
              armColors[dir] = null;
            }
          } else {
            armColors[dir] = null;
          }
        }

        this.drawCell(p.x, p.y, col.fill, armColors);
      }
    }
  }

  // --- Hover preview (shows full post-placement state) ---

  drawHover() {
    if (this.game.gameOver) return;
    const pos = this.screenToBoard(mouseX, mouseY);
    if (!pos) return;
    if (this.game.board[pos.x][pos.y] !== EMPTY) return;

    // Simulate the move to show resulting board state
    const c = this.game.currentPlayer;
    const sim = new GoGame(this.game.size);
    sim.board = this.game.board.map(r => [...r]);
    sim.moveIndex = this.game.moveIndex.map(r => [...r]);
    sim.currentPlayer = c;
    sim.captures = { ...this.game.captures };
    sim.previousBoard = this.game.previousBoard ? this.game.previousBoard.map(r => [...r]) : null;
    sim.moveCount = this.game.moveCount;

    if (!sim.placeStone(pos.x, pos.y)) return; // illegal move

    // Draw the simulated liberties and stones with a pulsing opacity
    const pulse = 0.3 + 0.15 * sin(frameCount * 0.08);
    const dirVecs = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
    const simLibMap = sim.getLibertyMap();

    // Draw changed liberties
    const realLibMap = this.game.getLibertyMap();
    for (let x = 0; x < sim.size; x++) {
      for (let y = 0; y < sim.size; y++) {
        const simInfo = simLibMap[x][y];
        const realInfo = realLibMap[x][y];
        // Only draw liberties that are new or changed
        const simStr = simInfo ? [...simInfo.colors].sort().join(',') : '';
        const realStr = realInfo ? [...realInfo.colors].sort().join(',') : '';
        if (simStr === realStr) continue;
        if (!simInfo) continue;

        const p = this.boardToScreen(x, y);
        const baseCol = this._libertyColorSim(simInfo);
        const ghostCol = baseCol.map(v => Math.round(lerp(255, v, pulse)));

        const armColors = {};
        for (const dir of ['up', 'down', 'left', 'right']) {
          const [dx, dy] = dirVecs[dir];
          const nx = x + dx, ny = y + dy;
          if (sim.inBounds(nx, ny) && sim.board[nx][ny] !== EMPTY
              && simInfo.colors.has(sim.board[nx][ny])) {
            const stoneLight = colorFor(sim.board[nx][ny]).light;
            armColors[dir] = stoneLight.map(v => Math.round(lerp(255, v, pulse)));
          } else {
            armColors[dir] = null;
          }
        }
        this.drawCell(p.x, p.y, ghostCol, armColors);
      }
    }

    // Draw the new stone + changed stones with pulse
    for (let x = 0; x < sim.size; x++) {
      for (let y = 0; y < sim.size; y++) {
        const sc = sim.board[x][y];
        if (sc === EMPTY) continue;
        // Only draw cells that differ from real board
        if (this.game.board[x][y] === sc) {
          // Check if arms changed (neighbor captured, etc.)
          const realArms = this.game.getArmStates(x, y);
          const simArms = sim.getArmStates(x, y);
          let armsChanged = false;
          if (realArms && simArms) {
            for (const dir of ['up', 'down', 'left', 'right']) {
              if (realArms[dir] !== simArms[dir]) { armsChanged = true; break; }
            }
          }
          if (!armsChanged) continue;
        }

        const p = this.boardToScreen(x, y);
        const col = colorFor(sc);
        const arms = sim.getArmStates(x, y);

        // New stone pulses, existing stones with changed arms don't
        const isNew = this.game.board[x][y] === EMPTY;
        const t = isNew ? pulse : 1.0;
        const centerCol = col.fill.map(v => Math.round(lerp(255, v, t)));

        const armColors = {};
        for (const dir of ['up', 'down', 'left', 'right']) {
          if (arms[dir] === 'connected') {
            armColors[dir] = centerCol;
          } else if (arms[dir] === 'open') {
            const [dx, dy] = dirVecs[dir];
            const libInfo = simLibMap[x + dx][y + dy];
            if (libInfo) {
              armColors[dir] = col.light.map(v => Math.round(lerp(255, v, t)));
            } else {
              armColors[dir] = null;
            }
          } else if (arms[dir] === 'blocked') {
            const [dx, dy] = dirVecs[dir];
            const nx = x + dx, ny = y + dy;
            if (sim.inBounds(nx, ny) && sim.board[nx][ny] !== EMPTY && sim.board[nx][ny] !== sc) {
              armColors[dir] = BLOCKED_BRIDGE;
            } else {
              armColors[dir] = null;
            }
          } else {
            armColors[dir] = null;
          }
        }

        this.drawCell(p.x, p.y, centerCol, armColors);
      }
    }
  }

  _libertyColorSim(libInfo) {
    if (libInfo.colors.size === 1) {
      return colorFor([...libInfo.colors][0]).light;
    }
    return SHARED_LIGHT;
  }

  // --- Timeline mode ---

  _updateTimelinePreview() {
    const pos = this.screenToBoard(mouseX, mouseY);
    if (!pos) { this._timelinePreviewIdx = null; return; }
    const mi = this.game.moveIndex[pos.x][pos.y];
    if (mi > 0 && mi < this.game.history.length) {
      this._timelinePreviewIdx = mi;
    } else {
      this._timelinePreviewIdx = null;
    }
  }

  // --- Timeline (thumbnail strip) ---

  drawTimeline() {
    const g = this.game;
    const total = g.history.length;
    if (total <= 1) return;

    const thumbSize = 50;
    const gap = 6;
    const stepW = thumbSize + gap;
    const viewR = 2; // show 5×5 region around each move
    const barY = height - thumbSize - 25;
    const barX = 40;
    const visibleW = width - 80;

    // Auto-scroll: center current move in view
    const numMoves = total - 1;
    const totalW = numMoves * stepW - gap;
    let scrollX;
    if (totalW <= visibleW) {
      scrollX = (visibleW - totalW) / 2;
    } else {
      const currentCenter = max(0, g.historyIndex - 1) * stepW + thumbSize / 2;
      scrollX = visibleW / 2 - currentCenter;
      scrollX = constrain(scrollX, visibleW - totalW, 0);
    }

    // Store layout for click handling
    this._tlBarX = barX;
    this._tlBarY = barY;
    this._tlThumbSize = thumbSize;
    this._tlStepW = stepW;
    this._tlScrollX = scrollX;
    this._tlVisibleW = visibleW;
    this._tlTotal = total;

    const savedSnap = g._snapshot();
    noStroke();
    rectMode(CORNERS);

    for (let i = 1; i < total; i++) {
      const tx = barX + (i - 1) * stepW + scrollX;

      // Skip offscreen thumbnails
      if (tx + thumbSize < barX || tx > barX + visibleW) continue;

      const mc = g.moveCoords[i];
      const isCurrent = i === g.historyIndex;

      // Thumbnail background
      fill(isCurrent ? 230 : 248);
      noStroke();
      rect(tx, barY, tx + thumbSize, barY + thumbSize, 4);

      if (mc) {
        g._restore(g.history[i]);

        const miniCell = thumbSize / (viewR * 2 + 1);
        const ms = miniCell * 0.38;

        // Grid layer
        fill(GRID_COL);
        for (let dx = -viewR; dx <= viewR; dx++) {
          for (let dy = -viewR; dy <= viewR; dy++) {
            const bx = mc.x + dx, by = mc.y + dy;
            if (!g.inBounds(bx, by)) continue;
            const px = tx + (dx + viewR) * miniCell + miniCell / 2;
            const py = barY + (dy + viewR) * miniCell + miniCell / 2;
            rect(px - ms, py - ms, px + ms, py + ms);
            if (dx < viewR && g.inBounds(bx + 1, by)) {
              rect(px + ms, py - ms, px + miniCell - ms, py + ms);
            }
            if (dy < viewR && g.inBounds(bx, by + 1)) {
              rect(px - ms, py + ms, px + ms, py + miniCell - ms);
            }
          }
        }

        // Stone layer
        for (let dx = -viewR; dx <= viewR; dx++) {
          for (let dy = -viewR; dy <= viewR; dy++) {
            const bx = mc.x + dx, by = mc.y + dy;
            if (!g.inBounds(bx, by)) continue;
            if (g.board[bx][by] === EMPTY) continue;
            const px = tx + (dx + viewR) * miniCell + miniCell / 2;
            const py = barY + (dy + viewR) * miniCell + miniCell / 2;
            const col = colorFor(g.board[bx][by]);

            fill(col.fill);
            rect(px - ms, py - ms, px + ms, py + ms);

            // Bridges to same-color neighbors
            for (const [ddx, ddy] of [[1,0],[0,1],[-1,0],[0,-1]]) {
              const ndx = dx + ddx, ndy = dy + ddy;
              if (abs(ndx) > viewR || abs(ndy) > viewR) continue;
              const nbx = bx + ddx, nby = by + ddy;
              if (!g.inBounds(nbx, nby)) continue;
              if (g.board[nbx][nby] !== g.board[bx][by]) continue;
              if (ddx === 1)  rect(px + ms, py - ms, px + miniCell - ms, py + ms);
              if (ddx === -1) rect(px - miniCell + ms, py - ms, px - ms, py + ms);
              if (ddy === 1)  rect(px - ms, py + ms, px + ms, py + miniCell - ms);
              if (ddy === -1) rect(px - ms, py - miniCell + ms, px + ms, py - ms);
            }

            // Highlight the moved stone
            if (bx === mc.x && by === mc.y) {
              stroke(255);
              strokeWeight(1.5);
              noFill();
              rect(px - ms - 1, py - ms - 1, px + ms + 1, py + ms + 1);
              noStroke();
            }
          }
        }
      } else {
        // Pass
        textSize(9);
        fill(150);
        noStroke();
        textAlign(CENTER, CENTER);
        text('Pass', tx + thumbSize / 2, barY + thumbSize / 2);
      }

      // Current position arrow
      if (isCurrent) {
        fill(40);
        noStroke();
        const ax = tx + thumbSize / 2;
        triangle(ax - 5, barY - 3, ax + 5, barY - 3, ax, barY - 9);
      }
    }

    g._restore(savedSnap);

    // Move label
    noStroke();
    textSize(10);
    textAlign(CENTER, TOP);
    fill(120);
    text(`Move ${g.historyIndex} / ${total - 1}`, width / 2, barY + thumbSize + 4);
  }

  handleTimelineClick(mx, my) {
    const g = this.game;
    if (!this._tlTotal || this._tlTotal <= 1) return false;
    const { _tlBarX: barX, _tlBarY: barY, _tlThumbSize: ts,
            _tlStepW: stepW, _tlScrollX: scrollX, _tlVisibleW: visW, _tlTotal: total } = this;

    if (my >= barY - 10 && my <= barY + ts + 5 && mx >= barX && mx <= barX + visW) {
      for (let i = 1; i < total; i++) {
        const tx = barX + (i - 1) * stepW + scrollX;
        if (mx >= tx && mx <= tx + ts) {
          g.timelineGoTo(i);
          return true;
        }
      }
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
    text('P: Pass  |  N: New  |  0/1/2/3: Size  |  T: Timeline  |  \u2190\u2192: Undo/Redo', m, m + lh * 3);

    // Timeline mode indicator
    if (this.timelineMode) {
      textSize(lh * 0.85);
      fill(200, 100, 50);
      textAlign(RIGHT, TOP);
      text('TIMELINE MODE', width - m, m);
      textAlign(LEFT, TOP);
    }

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