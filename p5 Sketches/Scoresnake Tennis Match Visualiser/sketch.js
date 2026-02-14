let matchData;     // Will store the currently displayed match data

let matchSpecifier = '20250116-M-Australian_Open-R64-Learner_Tien-Daniil_Medvedev';
let currentMatchId = matchSpecifier;

let JetBrainsMonoBold;
let dataLoaded = false;
let fullDataLoaded = false;

// Global variables used in visualization (initialized in parseMatchData)
let tennisMatch;
let currentScoresnake;

// Sound effect — pre-rendered ping buffers.
// Pitches snap to a pentatonic scale so rapid adjacent pings
// always sound harmonious (no dissonant semitones).
let _pingBuffers = {};  // keyed by frequency, lazily created

// Two octaves of C major pentatonic (C D E G A), spanning ~262–1047 Hz.
// Any pair of these notes sounds consonant together.
const _pentatonicFreqs = [
  261.6, 293.7, 329.6, 392.0, 440.0,   // C4 D4 E4 G4 A4
  523.3, 587.3, 659.3, 784.0, 880.0,   // C5 D5 E5 G5 A5
  1047                                   // C6
];

function _getOrCreatePingBuffer(ctx, freq) {
  let key = Math.round(freq);
  if (_pingBuffers[key]) return _pingBuffers[key];

  let sampleRate = ctx.sampleRate;
  let duration = 0.065;   // 65 ms — slightly longer for warmth at lower pitch
  let attack = 0.005;     // 5 ms fade-in
  let release = 0.055;    // 55 ms fade-out
  let hold = duration - attack - release;
  let len = Math.ceil(sampleRate * duration);
  let buf = ctx.createBuffer(1, len, sampleRate);
  let data = buf.getChannelData(0);
  let amp = 0.08;         // gentle volume — frequent sounds should be subtle

  for (let i = 0; i < len; i++) {
    let t = i / sampleRate;

    // Cosine-shaped envelope — rounder and more natural than linear
    let envelope;
    if (t < attack) {
      envelope = 0.5 * (1 - Math.cos(Math.PI * t / attack));          // smooth in
    } else if (t < attack + hold) {
      envelope = 1;
    } else {
      let fade = (t - attack - hold) / release;
      envelope = 0.5 * (1 + Math.cos(Math.PI * fade));                // smooth out
    }

    // Pure sine + a very quiet octave overtone for a bit of warmth
    let fundamental = Math.sin(2 * Math.PI * freq * t);
    let octave = Math.sin(2 * Math.PI * freq * 2 * t) * 0.12;
    data[i] = (fundamental + octave) * envelope * amp;
  }

  _pingBuffers[key] = buf;
  return buf;
}

function playHoverPing(pitchHint) {
  let ctx = getAudioContext();
  if (ctx.state !== 'running') return;

  // Map 0–1 to a pentatonic scale note
  let t = (pitchHint !== undefined) ? pitchHint : Math.random();
  let idx = Math.round(t * (_pentatonicFreqs.length - 1));
  let freq = _pentatonicFreqs[idx];

  let buf = _getOrCreatePingBuffer(ctx, freq);
  let src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
}

// ─── Game hover sound ───────────────────────────────────────────
// Deeper, slightly longer single tone — marks game boundaries.
// Same pentatonic scale shifted down one octave, with a touch of
// fifth-harmonic warmth to distinguish it from point pings.
let _gameBuffers = {};

function _getOrCreateGameBuffer(ctx, freq) {
  let key = Math.round(freq);
  if (_gameBuffers[key]) return _gameBuffers[key];

  let sampleRate = ctx.sampleRate;
  let duration = 0.11;     // 110 ms — noticeably longer than a point ping
  let attack = 0.008;
  let release = 0.09;
  let hold = duration - attack - release;
  let len = Math.ceil(sampleRate * duration);
  let buf = ctx.createBuffer(1, len, sampleRate);
  let data = buf.getChannelData(0);
  let amp = 0.06;

  for (let i = 0; i < len; i++) {
    let t = i / sampleRate;
    let envelope;
    if (t < attack) {
      envelope = 0.5 * (1 - Math.cos(Math.PI * t / attack));
    } else if (t < attack + hold) {
      envelope = 1;
    } else {
      let fade = (t - attack - hold) / release;
      envelope = 0.5 * (1 + Math.cos(Math.PI * fade));
    }
    let fundamental = Math.sin(2 * Math.PI * freq * t);
    let octave = Math.sin(2 * Math.PI * freq * 2 * t) * 0.15;
    let fifth = Math.sin(2 * Math.PI * freq * 1.5 * t) * 0.08;
    data[i] = (fundamental + octave + fifth) * envelope * amp;
  }

  _gameBuffers[key] = buf;
  return buf;
}

function playGameHoverPing(pitchHint) {
  let ctx = getAudioContext();
  if (ctx.state !== 'running') return;

  let t = (pitchHint !== undefined) ? pitchHint : Math.random();
  let idx = Math.round(t * (_pentatonicFreqs.length - 1));
  let freq = _pentatonicFreqs[idx] / 2;   // one octave below point pings

  let buf = _getOrCreateGameBuffer(ctx, freq);
  let src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
}

// ─── Set hover sound ────────────────────────────────────────────
// Warm pentatonic chord (root + 3rd + 6th) shifted one octave down —
// marks set boundaries.  Three voices sum to a gentle, consonant pad.
let _setBuffers = {};

function _getOrCreateSetBuffer(ctx, freqs) {
  let key = freqs.map(f => Math.round(f)).join('_');
  if (_setBuffers[key]) return _setBuffers[key];

  let sampleRate = ctx.sampleRate;
  let duration = 0.22;     // 220 ms — lingers longer than game or point
  let attack = 0.015;
  let release = 0.18;
  let hold = duration - attack - release;
  let len = Math.ceil(sampleRate * duration);
  let buf = ctx.createBuffer(1, len, sampleRate);
  let data = buf.getChannelData(0);
  let amp = 0.035;         // per voice — 3 voices ≈ 0.105 peak

  for (let i = 0; i < len; i++) {
    let t = i / sampleRate;
    let envelope;
    if (t < attack) {
      envelope = 0.5 * (1 - Math.cos(Math.PI * t / attack));
    } else if (t < attack + hold) {
      envelope = 1;
    } else {
      let fade = (t - attack - hold) / release;
      envelope = 0.5 * (1 + Math.cos(Math.PI * fade));
    }
    let sample = 0;
    for (let freq of freqs) {
      sample += Math.sin(2 * Math.PI * freq * t);
      sample += Math.sin(2 * Math.PI * freq * 2 * t) * 0.1;
    }
    data[i] = sample * envelope * amp;
  }

  _setBuffers[key] = buf;
  return buf;
}

function playSetHoverPing(pitchHint) {
  let ctx = getAudioContext();
  if (ctx.state !== 'running') return;

  let t = (pitchHint !== undefined) ? pitchHint : Math.random();
  let idx = Math.round(t * (_pentatonicFreqs.length - 1));

  // Triad from pentatonic: root + 2 steps + 4 steps, all one octave down.
  // e.g. C4→E4→A4 becomes C3→E3→A3 — a gentle Am-family voicing.
  let root = _pentatonicFreqs[idx] / 2;
  let third = _pentatonicFreqs[Math.min(idx + 2, _pentatonicFreqs.length - 1)] / 2;
  let fifth = _pentatonicFreqs[Math.min(idx + 4, _pentatonicFreqs.length - 1)] / 2;

  let buf = _getOrCreateSetBuffer(ctx, [root, third, fifth]);
  let src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
}

function mousePressed() {
  // Resume audio context on first click (browser requirement)
  let ctx = getAudioContext();
  if (ctx.state === 'suspended') ctx.resume();
}

function preload() {
  // Only load the font in preload - load CSV async later
  JetBrainsMonoBold = loadFont('JetBrainsMono-Bold.ttf',
    () => { }, // success callback
    () => { JetBrainsMonoBold = null; } // error callback - use default font
  );

  // Load just the default match data synchronously for immediate display
  matchData = loadTable('tien versus medvedev.csv', 'csv', 'header');
}

function setup() {

  window.currentSelectedMatch = null;
  window.currentlyDisplayedMatch = null;

  // Canvas is now 60% width to accommodate search pane
  let canvas = createCanvas(windowWidth * 0.6, windowHeight);
  canvas.parent('sketch-pane');

  matchX = width / 2, matchY = 50;

  // Parse and display the default match immediately
  parseMatchData();

  // Determine if this is best of 3 or best of 5
  let maxSetsWon = Math.max(tennisMatch.setsWonByPlayer[1], tennisMatch.setsWonByPlayer[2]);
  SETS_TO_WIN_MATCH = maxSetsWon; // 2 for best of 3, 3 for best of 5

  // ScoresnakeChart will be created in draw() when needed
  dataLoaded = true;

  // Set up tab switching
  setupTabs();

  // Set up basic search interface with loading message
  setupSearchInterfaceLoading();

  // Update progress to show download is starting
  updateProgress(0, 'Starting download of match databases...');

  // Load all CSV files
  loadAllMatchData();
}

function loadMatch(matchId, options = { setCurrent: true }) {
  try {

    if (options.setCurrent) {
      matchSpecifier = matchId;
      currentMatchId = matchId;
      // Also track for preview system
      window.currentSelectedMatch = matchId;
      window.currentlyDisplayedMatch = matchId;
    }

    // Load match data lazily from CSV
    loadMatchById(matchId, function () {

      // Check if we have valid match data
      if (matchData.getRowCount() === 0) {
        console.error('No data found for match:', matchId);
        return; // Skip if no data found
      }

      // Parse the match data into an easily accessible object
      parseMatchData();

      // Check if parsing was successful
      if (!tennisMatch || !tennisMatch.sets || tennisMatch.sets.length === 0) {
        console.error('Parsing failed for match:', matchId, 'tennisMatch:', tennisMatch);
        return; // Skip if parsing failed
      }

      // Determine if this is best of 3 or best of 5
      let maxSetsWon = Math.max(tennisMatch.setsWonByPlayer[1], tennisMatch.setsWonByPlayer[2]);
      SETS_TO_WIN_MATCH = maxSetsWon; // 2 for best of 3, 3 for best of 5

      // Create new scoresnake visualization
      currentScoresnake = new ScoresnakeChart(tennisMatch);

      if (options.setCurrent) {
        updateMatchDisplay(matchId);
      }

      // Redraw (works even when noLoop() is active)
      if (dataLoaded) {
        redraw();
      }
    });
  } catch (e) {
    // Enhanced error logging
    console.error('Error loading match ' + matchId + ':', e);
    console.error('Stack trace:', e.stack);
  }
}


let matchX;
let matchY;
let scaleFactor;

POINTS_TO_WIN_GAME = 4;
GAMES_TO_WIN_SET = 6;
SETS_TO_WIN_MATCH = 3;

let pointSquareSize = 5;

let gameGap = pointSquareSize;
let gameSize = pointSquareSize * POINTS_TO_WIN_GAME;
let gameSizePlusGap = gameSize + gameGap;

let setSize = gameSizePlusGap * GAMES_TO_WIN_SET - gameGap;
let setGap = pointSquareSize * 4 + gameGap;
let setSizePlusGap = setSize + setGap;

let timelineHeight = 150;

let matchSize = setSizePlusGap * SETS_TO_WIN_MATCH;

let pointScoreText = ["0", "15", "30", "40"];

// Axis mapping for players
let pAxes = {
  1: "y",
  2: "x"
}

function axisToPlayer(axis) {
  return Number(
    Object.keys(pAxes).find(player => pAxes[player] === axis)
  );
}

POINT_WON_AGAINST_SERVE = "against serve";
POINT_WON_ON_SERVE = "on serve";

INACTIVE = "inactive";
ACTIVE_SET = "active set";
ACTIVE_GAME = "active game";

pointSquareColorScheme = {
  [INACTIVE]: "#202020",
  [ACTIVE_SET]: "#505050",
  [ACTIVE_GAME]: "#8f8f8f",

  [POINT_WON_ON_SERVE]: { 1: "#A423B7", 2: "#00A300" },
  [POINT_WON_AGAINST_SERVE]: { 1: "#ff00f2", 2: "#0cdc58" }
};

function localMouse() {
  let inv = drawingContext.getTransform().inverse();
  let pt = new DOMPoint(mouseX, mouseY).matrixTransform(inv);
  return { x: pt.x, y: pt.y };
}



class Connector {
  constructor(x, y, pW, pL, thickness = pointSquareSize, winnerAxisIsX = true) {

    this.x = x;
    this.y = y;
    this.pW = pW;
    this.pL = pL;
    this.thickness = thickness;
    this.winnerAxisIsX = winnerAxisIsX;

  }

  drawConnector(pos) {

    let { x, y, pW, pL, thickness, winnerAxisIsX } = this;

    x += pos.x;
    y += pos.y;

    fill(100);

    // l = loser axis
    // w = winner axis

    let s = pointSquareSize;

    let points = [
      { l: pL, w: pW },
      { l: pL, w: pW + thickness / 3 },
      { l: 0, w: pW + thickness / 3 },
      { l: 0, w: pW + thickness },
      { l: s, w: pW + thickness },
      { l: s, w: pW + thickness * 2 / 3 },
      { l: pL + s, w: pW + thickness * 2 / 3 },
      { l: pL + s, w: pW }
    ];

    push();
    translate(x, y);

    beginShape();

    for (let pt of points) {
      if (winnerAxisIsX) {
        vertex(pt.w, pt.l);
      } else {
        vertex(pt.l, pt.w);
      }
    }

    endShape();

    pop();

  }

}

class PointSquare {
  constructor() {
    this.state = INACTIVE;
  }

  draw(x, y) {

    stroke(0);
    fill(pointSquareColorScheme[this.state]);
    strokeWeight(0.25);

    rect(x, y, pointSquareSize, pointSquareSize);

  }


}

class Game {
  constructor(tiles = POINTS_TO_WIN_GAME) {
    this.active = false;
    this.tailSize = 0;

    this.pointSquares = [];

    for (let p1 = 0; p1 < tiles; p1++) {
      this.pointSquares.push([]);
      for (let p2 = 0; p2 < tiles; p2++) {
        this.pointSquares[p1].push(new PointSquare());
      }
    }

    this.tiles = tiles;
  }

  draw(x, y, b = 30) {

    // console.log(`Drawing game at (${x}, ${y}) with tailSize ${tailSize} and point tiles ${xTiles} x ${yTiles}`);

    stroke(20);
    fill(b);
    strokeWeight(0.25);

    let s = pointSquareSize;

    for (let p1_pts = 0; p1_pts < this.pointSquares.length; p1_pts++) {
      for (let p2_pts = 0; p2_pts < this.pointSquares[p1_pts].length; p2_pts++) {



        if (this.pointSquares[p1_pts][p2_pts] != null) {

          if (pAxes[1] == "x") {
            this.pointSquares[p1_pts][p2_pts].draw(x + p1_pts * s, y + p2_pts * s);
          } else {
            this.pointSquares[p1_pts][p2_pts].draw(x + p2_pts * s, y + p1_pts * s);
          }
        }

      }
    }

    fill(255);

    if (this.tiles > POINTS_TO_WIN_GAME) {
      for (let i = 0; i < this.tiles; i++) {

        textAlign(RIGHT, CENTER);
        textSize(5);

        push();
        translate(x + i * pointSquareSize + pointSquareSize / 2, y - 3);
        rotate(-TAU / 4);
        text(i, 0, 0);

        pop();

        textAlign(LEFT, CENTER);
        push();
        translate(x - 3, y + i * pointSquareSize + pointSquareSize / 2);
        text(i, 0, 0);

        pop();

      }
    }

    let tX = x + this.tiles * s;
    let tY = y + this.tiles * s;

    for (let layer = 0; layer < this.tailSize; layer++) {
      // fill(b);
      // rect(tX + layer * s, tY + layer * s, s, s);
      // rect(tX + layer * s, tY + (layer - 1) * s, s, s);
      // rect(tX + (layer - 1) * s, tY + layer * s, s, s);

      if (this.tiles > POINTS_TO_WIN_GAME) {

        textAlign(RIGHT, CENTER);
        textSize(5);
        fill(255);

        push();
        translate(tX + layer * s + pointSquareSize / 2, tY + (layer - 1) * s - 3);
        rotate(-TAU / 4);
        text(this.tiles + layer, 0, 0);

        pop();

        textAlign(LEFT, CENTER);
        push();
        translate(tX + (layer - 1) * s - 3, tY + layer * s + pointSquareSize / 2);
        text(this.tiles + layer, 0, 0);

        pop();

      }

    }

  }

}

class TennisSet {
  constructor(tiebreakerSet = false) {

    this.tiebreakerSet = tiebreakerSet;

    this.gameOffsets = {
      1: new Array(GAMES_TO_WIN_SET).fill(gameSize),  // Offsets for player 1's games
      2: new Array(GAMES_TO_WIN_SET).fill(gameSize)   // Offsets for player 2's games
    }

    this.gameOffsets[1].push(gameSize);
    this.gameOffsets[2].push(gameSize);

    this.active = {
      1: new Array(GAMES_TO_WIN_SET + 1).fill(false),
      2: new Array(GAMES_TO_WIN_SET + 1).fill(false)
    }

    // this.games[p1_gamesWon][p2_gamesWon]
    this.games = [];

    for (let p1_gamesWon = 0; p1_gamesWon < GAMES_TO_WIN_SET + 1; p1_gamesWon++) {
      this.games.push([]);

      if (p1_gamesWon < GAMES_TO_WIN_SET) {
        for (let p2_gamesWon = 0; p2_gamesWon < GAMES_TO_WIN_SET; p2_gamesWon++) {
          this.games[p1_gamesWon].push(new Game());
        }

        if (p1_gamesWon < GAMES_TO_WIN_SET - 1) {
          this.games[p1_gamesWon].push(null);
        } else {
          this.games[p1_gamesWon].push(new Game());
        }
      } else {
        for (let p2_gamesWon = 0; p2_gamesWon < GAMES_TO_WIN_SET; p2_gamesWon++) {
          if (p2_gamesWon < GAMES_TO_WIN_SET - 1) {
            this.games[p1_gamesWon].push(null);
          } else {
            this.games[p1_gamesWon].push(new Game());
          }
        }

        let nPoints = 7;
        if (this.tiebreakerSet) {
          nPoints = 10;
        }
        this.games[p1_gamesWon].push(new Game(nPoints)); // Tiebreak game with 7 points to win
      }

    }



  }

  draw(x, y) {

    let setDimensions = {
      1: this.gameOffsets[1].reduce((acc, curr) => acc + curr, 0),
      2: this.gameOffsets[2].reduce((acc, curr) => acc + curr, 0)
    }


    // draw score axis labels
    for (let [p, q] of [[1, 2], [2, 1]]) {

      let offset = {
        1: 0,
        2: 0
      }



      for (let g = 0; g < this.games.length; g++) {


        let special = 0;
        if (g == this.games.length - 1) {
          if (this.active[p][g]) {

          } else {
            continue;
          }
        }

        let gapToChart = 15;
        textFont(JetBrainsMonoBold);
        textSize(14);
        noStroke();
        textAlign(CENTER, CENTER);

        fill(pointSquareColorScheme[POINT_WON_AGAINST_SERVE][p]);

        if (!this.active[p][g]) {
          fill(pointSquareColorScheme[POINT_WON_ON_SERVE][p]);
        }

        let pOffset = { [p]: gameSize, [q]: 0 };

        let textOffset = { [p]: 0, [q]: -gapToChart };
        fill(pointSquareColorScheme[POINT_WON_AGAINST_SERVE][p]);

        push();

        let lineEndPoint = { [p]: 0, [q]: setDimensions[p] };

        translate(x + offset[axisToPlayer("x")], y + offset[axisToPlayer("y")]);

        translate(
          pOffset[axisToPlayer("x")],
          pOffset[axisToPlayer("y")]);

        stroke(pointSquareColorScheme[POINT_WON_AGAINST_SERVE][p]);
        strokeWeight(0.5);
        line(0, 0, lineEndPoint[axisToPlayer("x")], lineEndPoint[axisToPlayer("y")]);
        noStroke();

        translate(
          textOffset[axisToPlayer("x")],
          textOffset[axisToPlayer("y")]);



        rotate(-TAU / 8);
        text(g + 1, 0, 0);
        pop();

        for (let i = 0; i < pointScoreText.length; i++) {

          textAlign(CENTER, CENTER);
          textSize(5);

          let gapToChart = 3;

          let pOffset = { [p]: i * pointSquareSize, [q]: 0 };

          let textOffset = { [p]: 0, [q]: -gapToChart };

          let lineEndPoint = { [p]: 0, [q]: setDimensions[p] };

          push();

          translate(x + offset[axisToPlayer("x")] + pOffset[axisToPlayer("x")], y + offset[axisToPlayer("y")] + pOffset[axisToPlayer("y")]);

          stroke(pointSquareColorScheme[POINT_WON_ON_SERVE][p]);
          strokeWeight(0.25);
          line(0, 0, lineEndPoint[axisToPlayer("x")], lineEndPoint[axisToPlayer("y")]);
          noStroke();

          translate(textOffset[axisToPlayer("x")], textOffset[axisToPlayer("y")]);

          if (pAxes[p] == "x") {

            rotate(-TAU / 4)

          }

          text(pointScoreText[i], 0, 0);

          pop();

        }

        offset[p] += this.gameOffsets[p][g] + gameGap;

      }



    }


    let offset = {
      1: 0,
      2: 0
    }
    for (let p1_gamesWon = 0; p1_gamesWon < this.games.length; p1_gamesWon++) {

      offset[2] = 0;

      for (let p2_gamesWon = 0; p2_gamesWon < this.games[p1_gamesWon].length; p2_gamesWon++) {

        let game = this.games[p1_gamesWon][p2_gamesWon];

        if (!game || (p1_gamesWon == GAMES_TO_WIN_SET && !this.active[1][p1_gamesWon]) || (p2_gamesWon == GAMES_TO_WIN_SET && !this.active[2][p2_gamesWon])) {
          offset[2] += this.gameOffsets[2][p2_gamesWon] + gameGap;
          continue;
        }

        let b;

        if (game.active) {
          b = 110;
        } else if (this.active[1][p1_gamesWon] && this.active[2][p2_gamesWon]) {
          b = 50;
        } else {
          b = 20;
        }

        // game.draw(x + offset[axisToPlayer("x")], y + offset[axisToPlayer("y")], b);

        offset[2] += this.gameOffsets[2][p2_gamesWon] + gameGap;

      }

      offset[1] += this.gameOffsets[1][p1_gamesWon] + gameGap;
    }
  }

}

class ScoresnakeChart {
  constructor(matchData) {
    this.matchData = matchData;

    this.connectors = [];

    this.setOffsets = {
      1: new Array(SETS_TO_WIN_MATCH).fill(setSize),  // Offsets for player 1's sets
      2: new Array(SETS_TO_WIN_MATCH).fill(setSize)   // Offsets for player 2's sets
    }

    this.timeline = {
      setOffsets: [],  // Cumulative offsets for sets on the timeline
      gameOffsets: [], // Cumulative offsets for games on the timeline
      minX: 0,
      maxX: 0,
      targetMinX: 0,
      targetMaxX: 0
    }

    // this.sets[p1_setsWon][p2_setsWon]
    this.sets = [];

    for (let p1_setsWon = 0; p1_setsWon < SETS_TO_WIN_MATCH; p1_setsWon++) {

      this.sets.push([]);

      for (let p2_setsWon = 0; p2_setsWon < SETS_TO_WIN_MATCH; p2_setsWon++) {
        if (p1_setsWon == SETS_TO_WIN_MATCH - 1 && p2_setsWon == SETS_TO_WIN_MATCH - 1) {
          this.sets[p1_setsWon].push(new TennisSet(true));
        } else {
          this.sets[p1_setsWon].push(new TennisSet());
        }
      }
    }

    this.minX = 0;
    this.minY = 0;

    this.targetMinX = 0;
    this.targetMinY = 0;

    this.maxX = 1;
    this.maxY = 1;

    this.targetMaxX = 1;
    this.targetMaxY = 1;

    this.hoverSet = null;
    this.hoverGame = null;
    this.hoverPoint = null;

    this.zoomedSet = null;
    this.zoomedGame = null;

    this.mousePosVec = createVector(0, 0);

    this.update();

  }

  draw(pos) {

    this.recalculateTargetScale();

    this.maxX = lerp(this.maxX, this.targetMaxX, 0.1);
    this.maxY = lerp(this.maxY, this.targetMaxY, 0.1);

    this.minX = lerp(this.minX, this.targetMinX, 0.1);
    this.minY = lerp(this.minY, this.targetMinY, 0.1);

    push();
    translate(matchX, matchY);


    let graphHeight = dist(0, 0, this.maxX - this.minX, this.maxY - this.minY);

    let scaleFactor = (height - matchY - timelineHeight) / graphHeight;


    let graphWidth = graphHeight;

    let xScaleFactor = min((width - matchY * 2) / graphWidth, scaleFactor * 1.4);

    scale(xScaleFactor, scaleFactor);

    rotate(TAU / 8);

    pos.x -= this.minX;
    pos.y -= this.minY;

    // for (let connector of this.connectors) {
    //   connector.drawConnector(pos);
    // }

    let px = axisToPlayer("x");
    let py = axisToPlayer("y");


    let setX = 0
    let setY = 0;

    let hover = false;
    let m = localMouse();

    let setHoverChange = false;
    let gameHoverChange = false;

    // draw the rallies and the snake itself
    for (let set of this.matchData.sets) {

      let gameX = 0
      let gameY = 0;

      if (
        !setHoverChange &&
        m.x < pos.x + setX + this.setOffsets[px][set.setsWon[px]]
        && m.y < pos.y + setY + this.setOffsets[py][set.setsWon[py]]
        && mouseY < height - timelineHeight
      ) {

        setHoverChange = true;

        if (this.hoverSet != set) {
          this.hoverSet = set;

          // pitch maps to position in match (low→high as match progresses)
          let firstPt = set.games[0] && set.games[0].points[0];
          let idx = firstPt ? this.matchData.allPoints.indexOf(firstPt) : 0;
          let pitchHint = idx / Math.max(this.matchData.allPoints.length - 1, 1);
          playSetHoverPing(pitchHint);
        }

        fill(100);
        rect(pos.x + setX, pos.y + setY,
          this.setOffsets[px][set.setsWon[px]],
          this.setOffsets[py][set.setsWon[py]]);

      }


      for (let game of set.games) {

        if (
          !gameHoverChange &&
          m.x < pos.x + setX + gameX + this.sets[set.setsWon[1]][set.setsWon[2]].gameOffsets[px][game.gamesWon[px]]
          && m.x > pos.x + setX + gameX
          && m.y < pos.y + setY + gameY + this.sets[set.setsWon[1]][set.setsWon[2]].gameOffsets[py][game.gamesWon[py]]
          && m.y > pos.y + setY + gameY
          && mouseY < height - timelineHeight
        ) {

          gameHoverChange = true;

          if (this.hoverGame != game) {
            this.hoverGame = game;

            // pitch maps to position in match (low→high as match progresses)
            let firstPt = game.points[0];
            let idx = firstPt ? this.matchData.allPoints.indexOf(firstPt) : 0;
            let pitchHint = idx / Math.max(this.matchData.allPoints.length - 1, 1);
            playGameHoverPing(pitchHint);
          }

          fill(200);
          rect(pos.x + setX + gameX, pos.y + setY + gameY,
            this.sets[set.setsWon[1]][set.setsWon[2]].gameOffsets[px][game.gamesWon[px]],
            this.sets[set.setsWon[1]][set.setsWon[2]].gameOffsets[py][game.gamesWon[py]]);

        }

        for (let point of game.points) {

          let pointX = point.pointsWon[px] * pointSquareSize;
          let pointY = point.pointsWon[py] * pointSquareSize;

          let s = pointSquareSize;
          let r = s / 1.5;


          let serveStatus;
          if (point.server == point.winner) {
            serveStatus = POINT_WON_ON_SERVE;
          } else {
            serveStatus = POINT_WON_AGAINST_SERVE;
          }

          fill(pointSquareColorScheme[serveStatus][point.winner]);

          if (point == this.hoverPoint) {
            fill(255);
          }

          if (!hover
            && m.x < pos.x + setX + gameX + pointX + s
            && m.x > pos.x + setX + gameX + pointX
            && m.y < pos.y + setY + gameY + pointY + s
            && m.y > pos.y + setY + gameY + pointY
            && mouseY < height - timelineHeight
          ) {

            hover = true;

            if (this.hoverPoint != point) {
              this.hoverPoint = point;

              // pitch maps to position in match (low→high as match progresses)
              let idx = this.matchData.allPoints.indexOf(point);
              let pitchHint = idx / (this.matchData.allPoints.length - 1);
              playHoverPing(pitchHint);
            }

          }

          square(
            pos.x + setX + gameX + pointX,
            pos.y + setY + gameY + pointY,
            s
          );


        }



        if (game.winner == px) {
          gameX += this.sets[set.setsWon[1]][set.setsWon[2]].gameOffsets[px][game.gamesWon[px]] + gameGap;
        } else {
          gameY += this.sets[set.setsWon[1]][set.setsWon[2]].gameOffsets[py][game.gamesWon[py]] + gameGap;
        }
      }

      if (set.winner == px) {
        setX += this.setOffsets[px][set.setsWon[px]] + setGap;
      } else {
        setY += this.setOffsets[py][set.setsWon[py]] + setGap;
      }

    }

    let matchDimensions = {
      1: this.setOffsets[1].reduce((acc, curr) => acc + curr, 0) + setGap * (SETS_TO_WIN_MATCH - 1),
      2: this.setOffsets[2].reduce((acc, curr) => acc + curr, 0) + setGap * (SETS_TO_WIN_MATCH - 1)
    };

    // draw score axis labels
    for (let [p, q] of [[1, 2], [2, 1]]) {

      let offset = {
        1: 0,
        2: 0
      }

      for (let s = 0; s < this.sets.length; s++) {

        // if (g == this.games.length - 1) {
        //   if (this.active[p][g]) {

        //   } else {
        //     continue;
        //   }
        // }

        let gapToChart = 40;
        textFont(JetBrainsMonoBold);
        textSize(24);
        noStroke();
        textAlign(CENTER, CENTER);

        fill(pointSquareColorScheme[POINT_WON_AGAINST_SERVE][p]);

        let pOffset = { [p]: this.setOffsets[p][s], [q]: 0 };

        let textOffset = { [p]: 0, [q]: -gapToChart };
        fill(pointSquareColorScheme[POINT_WON_AGAINST_SERVE][p]);

        push();

        let lineEndPoint = { [p]: 0, [q]: matchDimensions[q] };

        translate(pos.x + offset[axisToPlayer("x")], pos.y + offset[axisToPlayer("y")]);

        translate(
          pOffset[axisToPlayer("x")],
          pOffset[axisToPlayer("y")]);

        stroke(pointSquareColorScheme[POINT_WON_AGAINST_SERVE][p]);
        strokeWeight(0.5);
        line(0, 0, lineEndPoint[axisToPlayer("x")], lineEndPoint[axisToPlayer("y")]);
        noStroke();

        translate(
          textOffset[axisToPlayer("x")],
          textOffset[axisToPlayer("y")]);



        rotate(-TAU / 8);
        text(s + 1, 0, 0);
        pop();

        offset[p] += this.setOffsets[p][s] + setGap;

      }



    }

    let offset = {
      1: 0,
      2: 0
    };

    for (let p1_setsWon = 0; p1_setsWon < SETS_TO_WIN_MATCH; p1_setsWon++) {

      offset[2] = 0;

      for (let p2_setsWon = 0; p2_setsWon < SETS_TO_WIN_MATCH; p2_setsWon++) {

        let set = this.sets[p1_setsWon][p2_setsWon];

        set.draw(
          pos.x + offset[axisToPlayer("x")], pos.y + offset[axisToPlayer("y")]);

        offset[2] += this.setOffsets[2][p2_setsWon] + setGap;

      }

      offset[1] += this.setOffsets[1][p1_setsWon] + setGap;

    }

    pop();


    // timeline
    let w = width / this.matchData.allPoints.length / 10;

    let x = 0;


    fill(0);
    rect(0, height - timelineHeight, width, timelineHeight);


    this.timeline.targetMinX = 0;
    if (this.zoomedGame != null) {
      this.timeline.targetMinX = this.timeline.gameOffsets[this.zoomedGame.gameNumber - 1];
      this.timeline.targetMaxX = this.timeline.gameOffsets[this.zoomedGame.gameNumber];
    } else if (this.zoomedSet != null) {
      this.timeline.targetMinX = this.timeline.setOffsets[this.zoomedSet.setNumber - 1];
      this.timeline.targetMaxX = this.timeline.setOffsets[this.zoomedSet.setNumber];
    } else {
      this.timeline.targetMaxX = this.timeline.totalWidth;

    }

    // lerp the timeline min and max for smooth zooming
    this.timeline.minX = lerp(this.timeline.minX, this.timeline.targetMinX, 0.1);
    this.timeline.maxX = lerp(this.timeline.maxX, this.timeline.targetMaxX, 0.1);

    let timelineXscale = (width) / (this.timeline.maxX - this.timeline.minX);
    // console.log(timelineXscale);

    push();
    translate(-this.timeline.minX * timelineXscale, 0);
    scale(timelineXscale, 1);


    m = localMouse();

    let g = 0;
    let s = 0;

    for (let set of this.matchData.sets) {

      if (m.x > this.timeline.setOffsets[s] && m.x < this.timeline.setOffsets[s + 1] && m.y > height - timelineHeight && m.y < height) {

        setHoverChange = true;

        if (this.hoverSet != set) {
          this.hoverSet = set;

          // pitch maps to position in match (low→high as match progresses)
          let firstPt = set.games[0] && set.games[0].points[0];
          let idx = firstPt ? this.matchData.allPoints.indexOf(firstPt) : 0;
          let pitchHint = idx / Math.max(this.matchData.allPoints.length - 1, 1);
          playSetHoverPing(pitchHint);

        }

      }

      for (let game of set.games) {

        let gameX = this.timeline.gameOffsets[g];

        let pointX = 0;

        if (m.x > gameX && m.x < this.timeline.gameOffsets[g + 1] && m.y > height - timelineHeight && m.y < height) {

          gameHoverChange = true;

          if (this.hoverGame != game) {
            this.hoverGame = game;

            // pitch maps to position in match (low→high as match progresses)
            let firstPt = game.points[0];
            let idx = firstPt ? this.matchData.allPoints.indexOf(firstPt) : 0;
            let pitchHint = idx / Math.max(this.matchData.allPoints.length - 1, 1);
            playGameHoverPing(pitchHint);

          }

        }

        for (let point of game.points) {

          let amt = timelineHeight / 3;

          let h = timelineHeight - amt;
          if (set == this.hoverSet) {
            h += amt / 3;
          }
          if (game == this.hoverGame) {
            h += amt / 3;
          }
          if (point == this.hoverPoint) {
            h += amt / 3;
          }

          let serveStatus;
          if (point.server == point.winner) {
            serveStatus = POINT_WON_ON_SERVE;
          } else {
            serveStatus = POINT_WON_AGAINST_SERVE;
          }

          fill(pointSquareColorScheme[serveStatus][point.winner]);

          stroke(0);
          strokeWeight(0.1);
          rect(gameX + pointX, height - h, point.rally.totalShots, h);
          noStroke();

          if (m.x > gameX + pointX && m.x < gameX + pointX + point.rally.totalShots && m.y > height - h && m.y < height) {

            hover = true;

            if (this.hoverPoint != point) {
              this.hoverPoint = point;

              // pitch maps to position in match (low→high as match progresses)
              let idx = this.matchData.allPoints.indexOf(point);
              let pitchHint = idx / (this.matchData.allPoints.length - 1);
              playHoverPing(pitchHint);

            }

          }

          pointX += point.rally.totalShots;

        }
        g++;

      }

      s++;


    }

    pop();

    if (!setHoverChange) {
      this.hoverSet = null;
    }
    if (!gameHoverChange) {
      this.hoverGame = null;
    }
    if (!hover) {
      this.hoverPoint = null;
    }

    if (this.hoverPoint) {

      let rally = parseRally(this.hoverPoint);


      textSize(10);
      fill(255);
      noStroke();
      textAlign(LEFT, BOTTOM);
      textWithBackground(describeRally(rally), mouseX + 10, mouseY + 10);


    }


  }

  update() {

    matchData = this.matchData;

    let timelineOffset = 0;

    let s = pointSquareSize;

    let setPos = createVector(0, 0);

    for (let set of matchData.sets) {

      this.timeline.setOffsets.push(timelineOffset);

      let gamePos = createVector(0, 0);

      // Guard against out-of-bounds set indices
      let p1Sets = set.setsWon[1];
      let p2Sets = set.setsWon[2];
      if (!this.sets[p1Sets] || !this.sets[p1Sets][p2Sets]) continue;
      let currentSet = this.sets[p1Sets][p2Sets];

      currentSet.active[1][0] = true;
      currentSet.active[2][0] = true;

      for (let [g, game] of set.games.entries()) {

        this.timeline.gameOffsets.push(timelineOffset);

        // Guard against out-of-bounds game indices
        let p1Games = game.gamesWon[1];
        let p2Games = game.gamesWon[2];
        if (!currentSet.games[p1Games] || !currentSet.games[p1Games][p2Games]) continue;
        let currentGame = currentSet.games[p1Games][p2Games];

        currentGame.active = true;

        let pointPos = createVector(0, 0);

        for (let point of game.points) {

          timelineOffset += point.rally.totalShots;

          let displayGame = currentGame;


          // growing the tail and adding new point squares if the number of points in the game exceeds the initial tiles (e.g. due to deuce)
          if (displayGame.pointSquares.length - 1 < max(point.pointsWon[1], point.pointsWon[2])) {

            for (let p1 = 0; p1 < displayGame.pointSquares.length; p1++) {
              if (p1 < displayGame.pointSquares.length - 1) {
                displayGame.pointSquares[p1].push(null);
              } else {
                displayGame.pointSquares[p1].push(new PointSquare());

              }
            }

            displayGame.pointSquares.push([]);
            for (let p2 = 0; p2 < displayGame.pointSquares[0].length - 1; p2++) {
              if (p2 < displayGame.pointSquares[0].length - 2) {
                displayGame.pointSquares[displayGame.pointSquares.length - 1].push(null);
              } else {
                displayGame.pointSquares[displayGame.pointSquares.length - 1].push(new PointSquare());

              }
            }
            displayGame.pointSquares[displayGame.pointSquares.length - 1].push(new PointSquare());


          }
          let state;

          if (point.winner == 1) {
            if (point.server == 1) {
              state = POINT_WON_ON_SERVE[1];
            } else {
              state = POINT_WON_AGAINST_SERVE[1];
            }
          } else if (point.winner == 2) {
            if (point.server == 2) {
              state = POINT_WON_ON_SERVE[2];
            } else {
              state = POINT_WON_AGAINST_SERVE[2];
            }
          }

          displayGame.pointSquares[point.pointsWon[1]][point.pointsWon[2]].state = state;

          pointPos[pAxes[point.winner]] += s;

        }

        // winner
        let w = game.winner;
        // loser
        let l;
        if (w == 1) {
          l = 2;
        } else {
          l = 1;
        }



        let gX = gamePos.x; let gY = gamePos.y;

        let gameOffsets = currentSet.gameOffsets;

        if (game.gamesWon[l] >= GAMES_TO_WIN_SET - 1 || game.gamesWon[w] < GAMES_TO_WIN_SET - 1) {
          currentSet.active[w][game.gamesWon[w] + 1] = true;
        }


        let sGame = currentGame;

        sGame.tailSize = pointPos[pAxes[w]] / s - sGame.tiles;

        gameOffsets[w][game.gamesWon[w]] = max(
          gameOffsets[w][game.gamesWon[w]],
          pointPos[pAxes[w]]
        );

        gameOffsets[l][game.gamesWon[l]] = max(
          gameOffsets[l][game.gamesWon[l]],
          pointPos[pAxes[w]] // have to account for tail protruding in both axes directions, so use winner's pointPos for both winner and loser offsets
        );

        if (!game.points[game.points.length - 1].isSetWinningPoint) {

          gamePos[pAxes[w]] += gameOffsets[w][game.gamesWon[w]];

          noStroke();

          let t;
          if (pAxes[w] == "x") {
            t = (gamePos.x - pointPos[pAxes[w]]) - gX;
          } else {
            t = (gamePos.y - pointPos[pAxes[w]]) - gY;
          }

          this.connectors.push(new Connector(
            setPos.x + gX,
            setPos.y + gY,
            pointPos[pAxes[w]],
            pointPos[pAxes[l]],
            t,
            (pAxes[w] == "x")
          ));

        } else {

          this.connectors.push(new Connector(
            setPos.x,
            setPos.y,
            gamePos[pAxes[w]] + pointPos[pAxes[w]],
            gamePos[pAxes[l]] + pointPos[pAxes[l]],
            setGap,
            (pAxes[w] == "x")
          ));

          gamePos[pAxes[w]] += pointPos[pAxes[w]];

        }

      }

      // winner
      let w = set.winner;
      // loser
      let l;
      if (w == 1) {
        l = 2;
      } else {
        l = 1;
      }

      let setOffsets = this.setOffsets;

      setOffsets[w][set.setsWon[w]] = max(
        setOffsets[w][set.setsWon[w]],
        gamePos[pAxes[w]] + gameGap * 6
      );

      setOffsets[l][set.setsWon[l]] = max(
        setOffsets[l][set.setsWon[l]],
        gamePos[pAxes[l]] + gameGap * 6
      );

      setPos[pAxes[set.winner]] += setOffsets[w][set.setsWon[w]];

    }

    this.recalculateTargetScale();
    this.maxX = this.targetMaxX;
    this.maxY = this.targetMaxY;



    this.timeline.totalWidth = timelineOffset;
    this.timeline.maxX = timelineOffset;
    this.timeline.setOffsets.push(timelineOffset);
    this.timeline.gameOffsets.push(timelineOffset);

  }

  recalculateTargetScale() {

    // get min, build up
    this.targetMinX = 0;
    this.targetMinY = 0;


    let gameOffsets;

    if (this.zoomedSet != null) {
      for (let s = 0; s < this.zoomedSet.setsWon[axisToPlayer("x")]; s++) {
        this.targetMinX += this.setOffsets[axisToPlayer("x")][s] + setGap;
      }
      for (let s = 0; s < this.zoomedSet.setsWon[axisToPlayer("y")]; s++) {
        this.targetMinY += this.setOffsets[axisToPlayer("y")][s] + setGap;
      }

      if (this.zoomedGame != null) {

        gameOffsets = this.sets[this.zoomedSet.setsWon[1]][this.zoomedSet.setsWon[2]].gameOffsets;

        for (let g = 0; g < this.zoomedGame.gamesWon[axisToPlayer("x")]; g++) {
          this.targetMinX += gameOffsets[axisToPlayer("x")][g] + gameGap;
        }

        for (let g = 0; g < this.zoomedGame.gamesWon[axisToPlayer("y")]; g++) {
          this.targetMinY += gameOffsets[axisToPlayer("y")][g] + gameGap;
        }
      }
    }

    this.targetMaxX = this.targetMinX;
    this.targetMaxY = this.targetMinY;

    if (this.zoomedGame != null) {

      this.targetMaxX += gameOffsets[axisToPlayer("x")][this.zoomedGame.gamesWon[axisToPlayer("x")]];
      this.targetMaxY += gameOffsets[axisToPlayer("y")][this.zoomedGame.gamesWon[axisToPlayer("y")]];

    } else if (this.zoomedSet != null) {

      this.targetMaxX += this.setOffsets[axisToPlayer("x")][this.zoomedSet.setsWon[axisToPlayer("x")]];
      this.targetMaxY += this.setOffsets[axisToPlayer("y")][this.zoomedSet.setsWon[axisToPlayer("y")]];

    } else {
      for (let s = 0; s < this.setOffsets[axisToPlayer("x")].length; s++) {
        this.targetMaxX += this.setOffsets[axisToPlayer("x")][s] + setGap;
      }
      for (let s = 0; s < this.setOffsets[axisToPlayer("y")].length; s++) {
        this.targetMaxY += this.setOffsets[axisToPlayer("y")][s] + setGap;
      }
    }

  }

}

function textWithBackground(str, x, y, padding = 6) {
  let lines = str.split('\n');
  let lineHeight = textAscent() + textDescent();
  let tw = Math.max(...lines.map(l => textWidth(l)));
  let th = lineHeight * lines.length;

  // Read current alignment from p5's internal state
  let hAlign = drawingContext.textAlign;  // "left", "center", "right"
  let vAlign = drawingContext.textBaseline; // "top", "middle", "alphabetic", "bottom"

  // Calculate background rect origin based on alignment
  let rx = x - padding;
  if (hAlign === 'center') rx = x - tw / 2 - padding;
  else if (hAlign === 'right') rx = x - tw - padding;

  let ry = y - padding;
  if (vAlign === 'top') ry = y - padding;
  else if (vAlign === 'middle') ry = y - th / 2 - padding;
  else if (vAlign === 'alphabetic' || vAlign === 'bottom') ry = y - th - padding;

  // Draw background
  fill(0, 200);
  noStroke();
  rect(rx, ry, tw + padding * 2, th + padding * 2);

  // Draw text at the same position with same alignment
  fill(255);
  text(str, x, y);
}

// Parse CSV data into a nested hierarchical object
function parseMatchData() {
  // Create the match object with nested structure
  tennisMatch = {
    matchId: '',
    player1: '',
    player2: '',
    sets: [],  // Array of set objects
    allPoints: []  // Flat sequence of all points in match order
  };

  // Extract match info from first row
  if (matchData.getRowCount() > 0) {
    let firstRow = matchData.getRow(0);
    tennisMatch.matchId = firstRow.getString('match_id');

    // Parse player names from match_id
    let parts = tennisMatch.matchId.split('-');
    if (parts.length >= 5) {
      tennisMatch.player1 = parts[parts.length - 2].replace(/_/g, ' ');
      tennisMatch.player2 = parts[parts.length - 1].replace(/_/g, ' ');
    }
  }

  // Sort rows by point number to handle out-of-order data
  let sortedRows = [];
  for (let i = 0; i < matchData.getRowCount(); i++) {
    sortedRows.push({
      index: i,
      pointNumber: matchData.getRow(i).getNum('Pt'),
      row: matchData.getRow(i)
    });
  }
  sortedRows.sort((a, b) => a.pointNumber - b.pointNumber);

  let currentSetIndex = -1;
  let currentGameIndex = -1;
  let lastGameNumber = -1;
  let lastSet1 = -1;
  let lastSet2 = -1;

  // Iterate through each point in sorted order
  for (let i = 0; i < sortedRows.length; i++) {
    let row = sortedRows[i].row;

    let games1 = row.getNum('Gm1');
    let games2 = row.getNum('Gm2');
    let gameNumber = row.getNum('Gm#');
    let set1 = row.getNum('Set1');
    let set2 = row.getNum('Set2');

    // Skip rows with backwards set progress (data errors in CSV)
    if (i > 0 && (set1 + set2) < (lastSet1 + lastSet2)) {
      continue;  // Skip this row entirely
    }

    // If starting a new set, save the final score of the previous set
    if (i > 0 && (set1 !== lastSet1 || set2 !== lastSet2)) {
      // Get the previous row's game scores (final score of completed set)
      let prevRow = sortedRows[i - 1].row;
      let finalGm1 = prevRow.getNum('Gm1');
      let finalGm2 = prevRow.getNum('Gm2');
      // console.log(`Saving final score for set ${currentSetIndex + 1} from prev row: ${finalGm1}-${finalGm2}`);
      tennisMatch.sets[currentSetIndex].games1 = finalGm1;
      tennisMatch.sets[currentSetIndex].games2 = finalGm2;

      // Determine set winner from Set1/Set2 transition
      // If Set1 increased, player 1 won; if Set2 increased, player 2 won
      if (set1 > lastSet1) {
        tennisMatch.sets[currentSetIndex].winner = 1;
      } else if (set2 > lastSet2) {
        tennisMatch.sets[currentSetIndex].winner = 2;
      }
    }

    // Create a new set when either Set1 or Set2 changes
    if (i === 0 || set1 !== lastSet1 || set2 !== lastSet2) {
      // console.log(`Creating set ${tennisMatch.sets.length + 1} at row ${i}: Set1=${set1}, Set2=${set2}, Gm1=${games1}, Gm2=${games2}`);
      tennisMatch.sets.push({
        setNumber: tennisMatch.sets.length + 1,
        games1: 0,  // Will be updated
        games2: 0,  // Will be updated
        winner: null,  // Will be set when set ends
        setsWon: { 1: set1, 2: set2 },  // Sets won by each player at start of this set
        gamesWonByPlayer: null,  // Will be set after processing all games
        games: []   // Array of game objects
      });
      currentSetIndex++;
      lastSet1 = set1;
      lastSet2 = set2;
      currentGameIndex = -1;
    }

    // Create a new game if needed
    if (gameNumber !== lastGameNumber) {
      tennisMatch.sets[currentSetIndex].games.push({
        gameNumber: gameNumber,
        server: row.getNum('Svr'),
        winner: null,  // Will be set when game ends
        gamesWon: null,  // Will be calculated after determining winner
        pointsWonByPlayer: null,  // Will be set after processing all points
        points: []     // Array of point objects
      });
      currentGameIndex++;
      lastGameNumber = gameNumber;
    }

    // Count points won in current game so far (BEFORE this point)
    let currentGame = tennisMatch.sets[currentSetIndex].games[currentGameIndex];
    let pointsWon = { 1: 0, 2: 0 };

    for (let existingPoint of currentGame.points) {
      if (existingPoint.winner === 1) pointsWon[1]++;
      else if (existingPoint.winner === 2) pointsWon[2]++;
    }

    // Get the winner of this point
    let pointWinner = row.getNum('PtWinner');

    // Create the point object
    let point = {
      number: row.getNum('Pt'),
      pointScore: row.getString('Pts'),
      server: row.getNum('Svr'),
      first: row.getString('1st'),
      second: row.getString('2nd'),
      winner: pointWinner,
      pointsWon: pointsWon,  // Points won by each player BEFORE this point
      setsWon: { 1: set1, 2: set2 },  // Sets won by each player at time of this point
      gamesWon: { 1: games1, 2: games2 }  // Games won in current set by each player at time of this point
    };

    // Parse rally notation into structured shot objects (replaces raw 'notes' field)
    point.rally = parseRally(point);

    // Add point to the current game and the flat allPoints array
    tennisMatch.sets[currentSetIndex].games[currentGameIndex].points.push(point);
    tennisMatch.allPoints.push(point);
  }

  // Set the final score for the last set (since there's no "next set" to trigger it)
  if (sortedRows.length > 0) {
    let lastRow = sortedRows[sortedRows.length - 1].row;
    tennisMatch.sets[currentSetIndex].games1 = lastRow.getNum('Gm1');
    tennisMatch.sets[currentSetIndex].games2 = lastRow.getNum('Gm2');

    // For the last set, we can't use Set1/Set2 to determine winner
    // (they show match score, not who won this set)
    // Winner will be determined later from game winners
  }

  // Determine game winners and calculate final counts
  for (let set of tennisMatch.sets) {
    let gamesWonSoFar = { 1: 0, 2: 0 };

    for (let g = 0; g < set.games.length; g++) {
      let game = set.games[g];

      // The winner is the winner of the last point
      if (game.points.length > 0) {
        game.winner = game.points[game.points.length - 1].winner;

        // Set the final pointsWonByPlayer (soFar count + this point's winner)
        let finalCount = {
          1: game.points[game.points.length - 1].pointsWon[1],
          2: game.points[game.points.length - 1].pointsWon[2]
        };
        if (game.winner === 1) finalCount[1]++;
        else if (game.winner === 2) finalCount[2]++;
        game.pointsWonByPlayer = finalCount;
      }

      // Mark if this was a game-winning point
      if (game.points.length > 0) {
        game.points[game.points.length - 1].isGameWinningPoint = true;
      }

      // Set gamesWon to reflect state BEFORE this game
      game.gamesWon = { 1: gamesWonSoFar[1], 2: gamesWonSoFar[2] };

      // Update games won so far (after this game completes)
      if (game.winner === 1) gamesWonSoFar[1]++;
      else if (game.winner === 2) gamesWonSoFar[2]++;
    }

    // Count game winners for this set
    let p1GamesWon = 0;
    let p2GamesWon = 0;

    for (let game of set.games) {
      if (game.winner === 1) p1GamesWon++;
      else if (game.winner === 2) p2GamesWon++;
    }

    // Set the final gamesWonByPlayer
    set.gamesWonByPlayer = { 1: p1GamesWon, 2: p2GamesWon };

    // For sets that don't have a winner yet, determine from game count
    if (set.winner === null) {
      if (p1GamesWon > p2GamesWon) {
        set.winner = 1;
      } else if (p2GamesWon > p1GamesWon) {
        set.winner = 2;
      }
    }

    // Mark set-winning points
    if (set.games.length > 0) {
      let lastGame = set.games[set.games.length - 1];
      if (lastGame.points.length > 0) {
        lastGame.points[lastGame.points.length - 1].isSetWinningPoint = true;
      }
    }
  }

  // Calculate final match score (sets won) and update setsWon
  let setsWonSoFar = { 1: 0, 2: 0 };
  for (let set of tennisMatch.sets) {
    // Update setsWon to reflect state BEFORE this set
    set.setsWon = { 1: setsWonSoFar[1], 2: setsWonSoFar[2] };

    // Update sets won so far (after this set completes)
    if (set.winner === 1) setsWonSoFar[1]++;
    else if (set.winner === 2) setsWonSoFar[2]++;
  }
  tennisMatch.setsWonByPlayer = { 1: setsWonSoFar[1], 2: setsWonSoFar[2] };

  //console.log(`Loaded match: ${tennisMatch.player1} vs ${tennisMatch.player2}`);
  //console.log(`Sets: ${tennisMatch.sets.length}`);
  for (let i = 0; i < tennisMatch.sets.length; i++) {
    //console.log(`  Set ${i + 1}: ${tennisMatch.sets[i].games1}-${tennisMatch.sets[i].games2}, winner: ${tennisMatch.sets[i].winner}`);
  }
  //console.log(`Total games: ${tennisMatch.sets.reduce((sum, set) => sum + set.games.length, 0)}`);
  //console.log(`Total points: ${tennisMatch.sets.reduce((sum, set) =>
  // sum + set.games.reduce((gSum, game) => gSum + game.points.length, 0), 0)
  // } `);
}

function drawNames() {

  fill(0, 0, 0, 200);

  let o = 40;

  triangle(width / 2 - o, 0, 0, height / 2 - o, 0, 0);
  triangle(width - width / 2 + o, 0, width, height - height / 2 - o, width, 0);


  textSize(32);
  if (JetBrainsMonoBold) textFont(JetBrainsMonoBold);
  textAlign(LEFT, TOP);

  // Helper function to split name into 2 lines optimally
  function getOptimalTwoLinesSplit(nameParts) {
    if (nameParts.length <= 2) {
      return nameParts;
    }

    // Try all possible ways to split into 2 lines
    let bestSplit = null;
    let minMaxWidth = Infinity;

    for (let i = 1; i < nameParts.length; i++) {
      let line1 = nameParts.slice(0, i).join(' ');
      let line2 = nameParts.slice(i).join(' ');
      let maxWidth = Math.max(textWidth(line1), textWidth(line2));

      if (maxWidth < minMaxWidth) {
        minMaxWidth = maxWidth;
        bestSplit = [line1, line2];
      }
    }

    return bestSplit;
  }

  fill(pointSquareColorScheme[POINT_WON_AGAINST_SERVE][1]);
  // Player 1
  let player1Parts = tennisMatch.player1.split(' ');
  let player1Lines = getOptimalTwoLinesSplit(player1Parts);
  text(player1Lines.join('\n'), 50, 50);

  fill(pointSquareColorScheme[POINT_WON_AGAINST_SERVE][2]);
  // Player 2 - keep LEFT alignment but calculate position from right edge
  let player2Parts = tennisMatch.player2.split(' ');
  let player2Lines = getOptimalTwoLinesSplit(player2Parts);
  let maxWidth = Math.max(textWidth(player2Lines[0]), textWidth(player2Lines[1]));

  text(player2Lines.join('\n'), width - 50 - maxWidth, 50);
}

function mouseWheel(event) {

  if (event.deltaY < 0) { // scrolling up
    if (currentScoresnake.zoomedSet == null) {

      currentScoresnake.zoomedSet = currentScoresnake.hoverSet;

    } else {

      if (currentScoresnake.zoomedGame == null) {

        // if hover set is the same as zoomed set, zoom into game -- otherwise just switch set without zooming into game
        if (currentScoresnake.zoomedSet == currentScoresnake.hoverSet) {

          currentScoresnake.zoomedGame = currentScoresnake.hoverGame;

        } else {
          currentScoresnake.zoomedSet = currentScoresnake.hoverSet;
        }

      } else {

        currentScoresnake.zoomedSet = currentScoresnake.hoverSet;
        currentScoresnake.zoomedGame = currentScoresnake.hoverGame;

      }

    }
  } else if (event.deltaY > 0) { // scrolling down

    if (currentScoresnake.zoomedGame != null) {
      currentScoresnake.zoomedGame = null;
    } else {
      currentScoresnake.zoomedSet = null;
    }
  }
}

function draw() {
  background(0);

  if (!dataLoaded) {
    // Show loading screen if somehow data isn't ready
    fill(255);
    textSize(48);
    textAlign(CENTER, CENTER);
    if (JetBrainsMonoBold) textFont(JetBrainsMonoBold);
    text('Loading...', width / 2, height / 2);
    return;
  }

  // Create ScoresnakeChart if we have match data
  if (dataLoaded && tennisMatch && !currentScoresnake) {
    currentScoresnake = new ScoresnakeChart(tennisMatch);
  }

  if (!tennisMatch || !currentScoresnake) {
    fill(255);
    textSize(24);
    textAlign(CENTER, CENTER);
    text('Error: Match data not loaded', width / 2, height / 2);
    return;
  }



  matchX = width / 2, matchY = 50;

  currentScoresnake.draw({ x: 0, y: 0 });

  drawNames();

}

function windowResized() {
  // Resize main canvas to actual sketch-pane width
  let sketchPaneEl = document.getElementById('sketch-pane');
  let paneWidth = sketchPaneEl ? sketchPaneEl.clientWidth : windowWidth * 0.6;
  resizeCanvas(paneWidth, windowHeight);

  // // Create new scoresnake with new dimensions
  // if (dataLoaded && tennisMatch) {
  //   currentScoresnake = new ScoresnakeChart();
  //   currentScoresnake.update(tennisMatch);
  //   redraw();
  // }
}
