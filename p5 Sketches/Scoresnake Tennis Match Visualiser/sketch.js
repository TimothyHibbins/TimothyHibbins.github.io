let matchData;     // Will store the currently displayed match data

let matchSpecifier = '20250116-M-Australian_Open-R64-Learner_Tien-Daniil_Medvedev';
let currentMatchId = matchSpecifier;

let JetBrainsMonoBold;
let dataLoaded = false;
let fullDataLoaded = false;

// Global variables used in visualization (initialized in parseMatchData)
let tennisMatch;
let currentScoresnake;

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
  let maxSetsWon = Math.max(tennisMatch.setsInMatchWonByPlayer[1], tennisMatch.setsInMatchWonByPlayer[2]);
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
      let maxSetsWon = Math.max(tennisMatch.setsInMatchWonByPlayer[1], tennisMatch.setsInMatchWonByPlayer[2]);
      SETS_TO_WIN_MATCH = maxSetsWon; // 2 for best of 3, 3 for best of 5

      // Create new scoresnake visualization
      currentScoresnake = new ScoresnakeChart();
      currentScoresnake.update(tennisMatch);

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

POINT_WON_BY_P1_AGAINST_SERVE = "p1 against serve";
POINT_WON_BY_P2_AGAINST_SERVE = "p2 against serve";

POINT_WON_BY_P1_ON_SERVE = "p1 on serve";
POINT_WON_BY_P2_ON_SERVE = "p2 on serve";

INACTIVE = "inactive";
ACTIVE_SET = "active set";
ACTIVE_GAME = "active game";

pointSquareColorScheme = {
  [INACTIVE]: "#202020",
  [ACTIVE_SET]: "#505050",
  [ACTIVE_GAME]: "#8f8f8f",
  [POINT_WON_BY_P1_ON_SERVE]: "#A423B7",
  [POINT_WON_BY_P1_AGAINST_SERVE]: "#F442FF",
  [POINT_WON_BY_P2_ON_SERVE]: "#00A300",
  [POINT_WON_BY_P2_AGAINST_SERVE]: "#00FF00"
};



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
      1: new Array(GAMES_TO_WIN_SET).fill(gameSizePlusGap),  // Offsets for player 1's games
      2: new Array(GAMES_TO_WIN_SET).fill(gameSizePlusGap)   // Offsets for player 2's games
    }

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

    let offset = {
      1: 0,
      2: 0
    }

    for (let p1_gamesWon = 0; p1_gamesWon < this.games.length; p1_gamesWon++) {

      offset[2] = 0;

      textFont(JetBrainsMonoBold);
      textSize(14);
      noStroke();
      textAlign(CENTER, CENTER);

      let gapToChart = 15;

      for (let p2_gamesWon = 0; p2_gamesWon < this.games[p1_gamesWon].length; p2_gamesWon++) {


        fill(255);
        if (!this.active[1][p1_gamesWon]) {
          fill(255, 255, 255, 75);
        }

        if (
          (p2_gamesWon == 0 && p1_gamesWon < GAMES_TO_WIN_SET) ||
          (p1_gamesWon == GAMES_TO_WIN_SET && p2_gamesWon == GAMES_TO_WIN_SET - 1 && this.active[1][p1_gamesWon])

        ) {

          if (pAxes[1] == "x") {
            push();
            translate(x + offset[axisToPlayer("x")], y + offset[axisToPlayer("y")] - gapToChart);
            rotate(-TAU / 8);
            text(p1_gamesWon, 0, 0);
            pop();

            for (let i = 0; i < pointScoreText.length; i++) {

              textAlign(CENTER, CENTER);
              textSize(5);

              push();
              translate(x + offset[axisToPlayer("x")] + i * pointSquareSize, y + offset[axisToPlayer("y")] - 3);
              rotate(-TAU / 4)
              text(pointScoreText[i], 0, 0);

              pop();

            }


          } else {
            push();
            translate(x + offset[axisToPlayer("x")] - gapToChart, y + offset[axisToPlayer("y")]);
            rotate(-TAU / 8);
            text(p1_gamesWon, 0, 0);
            pop();

            for (let i = 0; i < pointScoreText.length; i++) {

              textAlign(CENTER, CENTER);
              textSize(5);

              push();
              translate(x + offset[axisToPlayer("x")] - 3, y + offset[axisToPlayer("y")] + i * pointSquareSize);
              // rotate(TAU / 4);


              text(pointScoreText[i], 0, 0);

              pop();

            }
          }

        }



        if (
          (p1_gamesWon == 0 && p2_gamesWon < GAMES_TO_WIN_SET) ||
          (p2_gamesWon == GAMES_TO_WIN_SET && p1_gamesWon == GAMES_TO_WIN_SET - 1 && this.active[2][p2_gamesWon])

        ) {

          textFont(JetBrainsMonoBold);
          textSize(14);
          fill(255);
          noStroke();
          textAlign(CENTER, CENTER);

          if (!this.active[2][p2_gamesWon]) {
            fill(255, 255, 255, 75);
          }

          if (pAxes[2] == "x") {
            push();
            translate(x + offset[axisToPlayer("x")], y + offset[axisToPlayer("y")] - gapToChart);
            rotate(-TAU / 8);
            text(p2_gamesWon, 0, 0);
            pop();

            for (let i = 0; i < pointScoreText.length; i++) {

              textAlign(CENTER, CENTER);
              textSize(5);

              push();
              translate(x + offset[axisToPlayer("x")] + i * pointSquareSize, y + offset[axisToPlayer("y")] - 3);
              rotate(-TAU / 4)
              text(pointScoreText[i], 0, 0);

              pop();

            }

          } else {
            push();
            translate(x + offset[axisToPlayer("x")] - gapToChart, y + offset[axisToPlayer("y")]);
            rotate(-TAU / 8);
            text(p2_gamesWon, 0, 0);
            pop();

            for (let i = 0; i < pointScoreText.length; i++) {

              textAlign(CENTER, CENTER);
              textSize(5);

              push();
              translate(x + offset[axisToPlayer("x")] - 3, y + offset[axisToPlayer("y")] + i * pointSquareSize);
              // rotate(TAU / 4);


              text(pointScoreText[i], 0, 0);

              pop();

            }

          }
        }

        let game = this.games[p1_gamesWon][p2_gamesWon];

        if (!game || (p1_gamesWon == GAMES_TO_WIN_SET && !this.active[1][p1_gamesWon]) || (p2_gamesWon == GAMES_TO_WIN_SET && !this.active[2][p2_gamesWon])) {
          offset[2] += this.gameOffsets[2][p2_gamesWon];
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

        game.draw(x + offset[axisToPlayer("x")], y + offset[axisToPlayer("y")], b);

        offset[2] += this.gameOffsets[2][p2_gamesWon];

      }

      offset[1] += this.gameOffsets[1][p1_gamesWon];
    }
  }

}

class ScoresnakeChart {
  constructor() {
    // this.matchData = matchData;

    this.connectors = [];

    this.setOffsets = {
      1: new Array(SETS_TO_WIN_MATCH).fill(setSizePlusGap),  // Offsets for player 1's sets
      2: new Array(SETS_TO_WIN_MATCH).fill(setSizePlusGap)   // Offsets for player 2's sets
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

    this.mousePosVec = createVector(0, 0);

  }

  draw(pos) {

    this.recalculateTargetScale();

    this.maxX = lerp(this.maxX, this.targetMaxX, 0.1);
    this.maxY = lerp(this.maxY, this.targetMaxY, 0.1);

    this.minX = lerp(this.minX, this.targetMinX, 0.1);
    this.minY = lerp(this.minY, this.targetMinY, 0.1);

    push();
    translate(matchX, matchY);
    rotate(TAU / 8);

    pos.x -= this.minX;
    pos.y -= this.minY;

    let side = height / 2 - matchY;

    let hyp = dist(0, 0, side, side);

    scaleFactor = hyp / max(this.maxX, this.maxY);

    scale(scaleFactor);



    for (let connector of this.connectors) {
      connector.drawConnector(pos);
    }

    let offset = {
      1: 0,
      2: 0
    };

    for (let p1_setsWon = 0; p1_setsWon < SETS_TO_WIN_MATCH; p1_setsWon++) {

      offset[2] = 0;

      textFont(JetBrainsMonoBold);
      textSize(24);
      fill(255);
      noStroke();
      textAlign(CENTER, CENTER);

      let gapToChart = 40;

      if (pAxes[1] == "x") {
        push();
        translate(pos.x + offset[axisToPlayer("x")], pos.y + offset[axisToPlayer("y")] - gapToChart);
        rotate(-TAU / 8);
        text(p1_setsWon, 0, 0);
        pop();
      } else {
        push();
        translate(pos.x + offset[axisToPlayer("x")] - gapToChart, pos.y + offset[axisToPlayer("y")]);
        rotate(-TAU / 8);
        text(p1_setsWon, 0, 0);
        pop();
      }

      for (let p2_setsWon = 0; p2_setsWon < SETS_TO_WIN_MATCH; p2_setsWon++) {

        if (p1_setsWon == 0) {

          textFont(JetBrainsMonoBold);
          textSize(24);
          fill(255);
          noStroke();
          textAlign(CENTER, CENTER);

          if (pAxes[2] == "x") {
            push();
            translate(pos.x + offset[axisToPlayer("x")], pos.y + offset[axisToPlayer("y")] - gapToChart);
            rotate(-TAU / 8);
            text(p2_setsWon, 0, 0);
            pop();
          } else {
            push();
            translate(pos.x + offset[axisToPlayer("x")] - gapToChart, pos.y + offset[axisToPlayer("y")]);
            rotate(-TAU / 8);
            text(p2_setsWon, 0, 0);
            pop();
          }

        }


        let set = this.sets[p1_setsWon][p2_setsWon];





        set.draw(pos.x + offset[axisToPlayer("x")], pos.y + offset[axisToPlayer("y")]);

        offset[2] += this.setOffsets[2][p2_setsWon];

      }

      offset[1] += this.setOffsets[1][p1_setsWon];

    }

    this.updateHoverVars();



    if (this.hoverSet != null) {
      push();
      translate(this.mousePosVec.x, this.mousePosVec.y);
      scale(1 / scaleFactor);
      rotate(-TAU / 8);

      fill(0);
      stroke(255);
      strokeWeight(2);
      rect(0, 0, 200, 100);

      textAlign(LEFT, TOP);

      noStroke();
      fill(255);
      textSize(20);
      text(`${this.hoverSet[1]}, ${this.hoverSet[2]}`, 10, 20);

      pop();
    }


    pop();

  }

  update(matchData) {

    let s = pointSquareSize;

    let setPos = createVector(0, 0);

    for (let set of matchData.sets) {

      let gamePos = createVector(0, 0);

      // Guard against out-of-bounds set indices
      let p1Sets = set.setsInMatchWonByPlayerSoFar[1];
      let p2Sets = set.setsInMatchWonByPlayerSoFar[2];
      if (!this.sets[p1Sets] || !this.sets[p1Sets][p2Sets]) continue;
      let currentSet = this.sets[p1Sets][p2Sets];

      currentSet.active[1][0] = true;
      currentSet.active[2][0] = true;

      for (let [g, game] of set.games.entries()) {

        // Guard against out-of-bounds game indices
        let p1Games = game.gamesInSetWonByPlayerSoFar[1];
        let p2Games = game.gamesInSetWonByPlayerSoFar[2];
        if (!currentSet.games[p1Games] || !currentSet.games[p1Games][p2Games]) continue;
        let currentGame = currentSet.games[p1Games][p2Games];

        currentGame.active = true;

        let pointPos = createVector(0, 0);

        for (let point of game.points) {

          let displayGame = currentGame;


          // growing the tail and adding new point squares if the number of points in the game exceeds the initial tiles (e.g. due to deuce)
          if (displayGame.pointSquares.length - 1 < max(point.pointsInGameWonByPlayerSoFar[1], point.pointsInGameWonByPlayerSoFar[2])) {

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
              state = POINT_WON_BY_P1_ON_SERVE;
            } else {
              state = POINT_WON_BY_P1_AGAINST_SERVE;
            }
          } else if (point.winner == 2) {
            if (point.server == 2) {
              state = POINT_WON_BY_P2_ON_SERVE;
            } else {
              state = POINT_WON_BY_P2_AGAINST_SERVE;
            }
          }

          displayGame.pointSquares[point.pointsInGameWonByPlayerSoFar[1]][point.pointsInGameWonByPlayerSoFar[2]].state = state;

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

        if (game.gamesInSetWonByPlayerSoFar[l] >= GAMES_TO_WIN_SET - 1 || game.gamesInSetWonByPlayerSoFar[w] < GAMES_TO_WIN_SET - 1) {
          currentSet.active[w][game.gamesInSetWonByPlayerSoFar[w] + 1] = true;
        }


        let sGame = currentGame;

        sGame.tailSize = pointPos[pAxes[w]] / s - sGame.tiles;

        gameOffsets[w][game.gamesInSetWonByPlayerSoFar[w]] = max(
          gameOffsets[w][game.gamesInSetWonByPlayerSoFar[w]],
          pointPos[pAxes[w]] + gameGap
        );

        gameOffsets[l][game.gamesInSetWonByPlayerSoFar[l]] = max(
          gameOffsets[l][game.gamesInSetWonByPlayerSoFar[l]],
          pointPos[pAxes[w]] + gameGap // have to account for tail protruding in both axes directions, so use winner's pointPos for both winner and loser offsets
        );

        if (!game.points[game.points.length - 1].isSetWinningPoint) {

          gamePos[pAxes[w]] += gameOffsets[w][game.gamesInSetWonByPlayerSoFar[w]];

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

      setOffsets[w][set.setsInMatchWonByPlayerSoFar[w]] = max(
        setOffsets[w][set.setsInMatchWonByPlayerSoFar[w]],
        gamePos[pAxes[w]] + setGap
      );

      setOffsets[l][set.setsInMatchWonByPlayerSoFar[l]] = max(
        setOffsets[l][set.setsInMatchWonByPlayerSoFar[l]],
        gamePos[pAxes[l]] + setGap
      );

      setPos[pAxes[set.winner]] += setOffsets[w][set.setsInMatchWonByPlayerSoFar[w]];

    }

    this.recalculateTargetScale();
    this.maxX = this.targetMaxX;
    this.maxY = this.targetMaxY;


  }

  recalculateTargetScale() {

    if (this.zoomedSet != null) {
      this.targetMaxX = this.setOffsets[axisToPlayer("x")][this.zoomedSet[axisToPlayer("x")]];
      this.targetMaxY = this.setOffsets[axisToPlayer("y")][this.zoomedSet[axisToPlayer("y")]];
    } else {
      this.targetMaxX = this.setOffsets[axisToPlayer("x")].reduce((acc, curr) => acc + curr, 0);
      this.targetMaxY = this.setOffsets[axisToPlayer("y")].reduce((acc, curr) => acc + curr, 0);
    }


    this.targetMinX = 0;
    this.targetMinY = 0;

    if (this.zoomedSet != null) {

      for (let sX = 0; sX < this.zoomedSet[axisToPlayer("x")]; sX++) {

        this.targetMinX += this.setOffsets[axisToPlayer("x")][sX];

      }

      for (let sY = 0; sY < this.zoomedSet[axisToPlayer("y")]; sY++) {

        this.targetMinY += this.setOffsets[axisToPlayer("y")][sY];

      }

    }

  }

  updateHoverVars() {

    this.mousePosVec = createVector(mouseX, mouseY);

    this.mousePosVec.x -= matchX;
    this.mousePosVec.y -= matchY;

    this.mousePosVec.rotate(-TAU / 8);

    this.mousePosVec.mult(1 / scaleFactor);




    let testPos = { 1: 0, 2: 0 };

    this.hoverSet = null;

    p1SetLoop: for (let s1 = 0; s1 < this.sets.length; s1++) {

      testPos[1] += this.setOffsets[1][s1];
      testPos[2] = 0;

      p2SetLoop: for (let s2 = 0; s2 < this.sets[s1].length; s2++) {

        testPos[2] += this.setOffsets[2][s2];

        if (this.mousePosVec.x + this.minX < testPos[axisToPlayer("x")] && this.mousePosVec.y + this.minY < testPos[axisToPlayer("y")]) {
          this.hoverSet = { 1: s1, 2: s2 };
          break p1SetLoop;
        }

      }
    }

  }

}

// Parse CSV data into a nested hierarchical object
function parseMatchData() {
  // Create the match object with nested structure
  tennisMatch = {
    matchId: '',
    player1: '',
    player2: '',
    sets: []  // Array of set objects
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
        setsInMatchWonByPlayerSoFar: { 1: set1, 2: set2 },  // Sets won by each player at start of this set
        gamesInSetWonByPlayer: null,  // Will be set after processing all games
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
        gamesInSetWonByPlayerSoFar: null,  // Will be calculated after determining winner
        pointsInGameWonByPlayer: null,  // Will be set after processing all points
        points: []     // Array of point objects
      });
      currentGameIndex++;
      lastGameNumber = gameNumber;
    }

    // Count points won in current game so far (BEFORE this point)
    let currentGame = tennisMatch.sets[currentSetIndex].games[currentGameIndex];
    let pointsInGameWonByPlayerSoFar = { 1: 0, 2: 0 };

    for (let existingPoint of currentGame.points) {
      if (existingPoint.winner === 1) pointsInGameWonByPlayerSoFar[1]++;
      else if (existingPoint.winner === 2) pointsInGameWonByPlayerSoFar[2]++;
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
      notes: row.getString('Notes'),
      winner: pointWinner,
      pointsInGameWonByPlayerSoFar: pointsInGameWonByPlayerSoFar  // Points won by each player BEFORE this point
    };

    // Add point to the current game
    tennisMatch.sets[currentSetIndex].games[currentGameIndex].points.push(point);
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

        // Set the final pointsInGameWonByPlayer (soFar count + this point's winner)
        let finalCount = {
          1: game.points[game.points.length - 1].pointsInGameWonByPlayerSoFar[1],
          2: game.points[game.points.length - 1].pointsInGameWonByPlayerSoFar[2]
        };
        if (game.winner === 1) finalCount[1]++;
        else if (game.winner === 2) finalCount[2]++;
        game.pointsInGameWonByPlayer = finalCount;
      }

      // Mark if this was a game-winning point
      if (game.points.length > 0) {
        game.points[game.points.length - 1].isGameWinningPoint = true;
      }

      // Set gamesInSetWonByPlayerSoFar to reflect state BEFORE this game
      game.gamesInSetWonByPlayerSoFar = { 1: gamesWonSoFar[1], 2: gamesWonSoFar[2] };

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

    // Set the final gamesInSetWonByPlayer
    set.gamesInSetWonByPlayer = { 1: p1GamesWon, 2: p2GamesWon };

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

  // Calculate final match score (sets won) and update setsInMatchWonByPlayerSoFar
  let setsWonSoFar = { 1: 0, 2: 0 };
  for (let set of tennisMatch.sets) {
    // Update setsInMatchWonByPlayerSoFar to reflect state BEFORE this set
    set.setsInMatchWonByPlayerSoFar = { 1: setsWonSoFar[1], 2: setsWonSoFar[2] };

    // Update sets won so far (after this set completes)
    if (set.winner === 1) setsWonSoFar[1]++;
    else if (set.winner === 2) setsWonSoFar[2]++;
  }
  tennisMatch.setsInMatchWonByPlayer = { 1: setsWonSoFar[1], 2: setsWonSoFar[2] };

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

  triangle(width / 2 - o, 0, 0, width / 2 - o, 0, 0);
  triangle(width - width / 2 + o, 0, width, width - width / 2 - o, width, 0);

  fill(255);
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

  // Player 1
  let player1Parts = tennisMatch.player1.split(' ');
  let player1Lines = getOptimalTwoLinesSplit(player1Parts);
  text(player1Lines.join('\n'), 50, 50);

  // Player 2 - keep LEFT alignment but calculate position from right edge
  let player2Parts = tennisMatch.player2.split(' ');
  let player2Lines = getOptimalTwoLinesSplit(player2Parts);
  let maxWidth = Math.max(textWidth(player2Lines[0]), textWidth(player2Lines[1]));

  text(player2Lines.join('\n'), width - 50 - maxWidth, 50);
}

function mouseWheel(event) {


  if (event.deltaY < 0) { // scrolling up
    if (currentScoresnake.hoverSet != null) {
      currentScoresnake.zoomedSet = currentScoresnake.hoverSet;
    }
  } else if (event.deltaY > 0) { // scrolling down
    currentScoresnake.zoomedSet = null;
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
    currentScoresnake = new ScoresnakeChart();
    currentScoresnake.update(tennisMatch);
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

  // Create new scoresnake with new dimensions
  if (dataLoaded && tennisMatch) {
    currentScoresnake = new ScoresnakeChart();
    currentScoresnake.update(tennisMatch);
    redraw();
  }
}
