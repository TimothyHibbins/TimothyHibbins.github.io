let allMatchData;  // Will store all matches from CSV
let matchData;     // Will store the filtered match data
let allMatchIds = []; // Will store all unique match IDs

// Specify which match to visualize
let matchSpecifier = '20250116-M-Australian_Open-R64-Learner_Tien-Daniil_Medvedev';

let JetBrainsMonoBold;
let dataLoaded = false;
let fullDataLoaded = false;

function preload() {
  // Only load the font in preload - load CSV async later
  JetBrainsMonoBold = loadFont('JetBrainsMono-Bold.ttf', 
    () => {}, // success callback
    () => { JetBrainsMonoBold = null; } // error callback - use default font
  );
  
  // Load just the default match data synchronously for immediate display
  matchData = loadTable('tien versus medvedev.csv', 'csv', 'header');
}

function setup() {
  // Canvas is now 60% width to accommodate search pane
  let canvas = createCanvas(windowWidth * 0.6, windowHeight);
  canvas.parent('sketch-pane');

  bgLayer = createGraphics(windowWidth * 0.6, windowHeight);


  layers = [
    // 0 - background
    createGraphics(windowWidth * 0.6, windowHeight),
    // 1
    createGraphics(windowWidth * 0.6, windowHeight),
    // 2 - snake
    createGraphics(windowWidth * 0.6, windowHeight),

  ];

  // Parse and display the default match immediately
  parseMatchData();
  scoresnake = new ScoresnakeChart();
  scoresnake.update(tennisMatch);
  dataLoaded = true;
  
  // Set up basic search interface with loading message
  setupSearchInterfaceLoading();
  
  // Now load the full CSV asynchronously
  loadTable('charting-m-points-2020s.csv', 'csv', 'header', function(table) {
    allMatchData = table;
    // Extract match IDs in chunks to avoid blocking the UI
    extractMatchIdsAsync();
  });
}

function extractMatchIdsAsync() {
  let matchIdObj = {};
  let currentIndex = 0;
  const CHUNK_SIZE = 1000; // Process 1000 rows at a time
  
  function processChunk() {
    let endIndex = Math.min(currentIndex + CHUNK_SIZE, allMatchData.getRowCount());
    
    for (let i = currentIndex; i < endIndex; i++) {
      let matchId = allMatchData.getRow(i).getString('match_id');
      matchIdObj[matchId] = true;
    }
    
    currentIndex = endIndex;
    
    if (currentIndex < allMatchData.getRowCount()) {
      // More rows to process - schedule next chunk
      setTimeout(processChunk, 0);
    } else {
      // Done processing all rows
      allMatchIds = Object.keys(matchIdObj);
      setupSearchInterface();
      fullDataLoaded = true;
    }
  }
  
  processChunk();
}

function filterMatchData(table, matchId) {
  // Create a new table with the same columns
  let filteredTable = new p5.Table();

  // Copy column structure
  for (let col of table.columns) {
    filteredTable.addColumn(col);
  }

  // Iterate through rows and collect only those matching the matchId
  let foundMatch = false;
  for (let i = 0; i < table.getRowCount(); i++) {
    let row = table.getRow(i);
    let currentMatchId = row.getString('match_id');

    if (currentMatchId === matchId) {
      foundMatch = true;
      let newRow = filteredTable.addRow();
      for (let col of table.columns) {
        newRow.set(col, row.get(col));
      }
    } else if (foundMatch) {
      // We've passed the end of our match, stop looking
      break;
    }
  }

  return filteredTable;
}

function extractMatchIds() {
  // Extract all unique match IDs from the CSV
  let matchIdObj = {};
  for (let i = 0; i < allMatchData.getRowCount(); i++) {
    let matchId = allMatchData.getRow(i).getString('match_id');
    matchIdObj[matchId] = true;
  }
  allMatchIds = Object.keys(matchIdObj);
}

function loadMatch(matchId) {
  // Update the match specifier
  matchSpecifier = matchId;

  // Filter the data for the specified match
  matchData = filterMatchData(allMatchData, matchSpecifier);

  // Parse the match data into an easily accessible object
  parseMatchData();

  // Update the scoresnake visualization
  scoresnake = new ScoresnakeChart();
  scoresnake.update(tennisMatch);

  // Update the display
  updateMatchDisplay(matchId);

  // Redraw (works even when noLoop() is active)
  if (dataLoaded) {
    redraw();
  }
}

function updateMatchDisplay(matchId) {
  let displayElement = document.getElementById('match-display');
  if (displayElement) {
    displayElement.textContent = matchId;
  }
}

function setupSearchInterfaceLoading() {
  let searchInput = document.getElementById('search-input');
  let loadingIndicator = document.getElementById('loading-indicator');
  
  // Show loading indicator
  updateMatchDisplay(matchSpecifier);
  loadingIndicator.classList.remove('loading-hidden');
  
  // Allow typing immediately - will show empty results until data loads
  searchInput.addEventListener('input', handleSearchInput);
}

function handleSearchInput() {
  let searchInput = document.getElementById('search-input');
  let dropdown = document.getElementById('dropdown');
  let searchTerm = searchInput.value.toLowerCase();

  if (searchTerm.length === 0) {
    dropdown.classList.add('dropdown-hidden');
    return;
  }

  // If data not loaded yet, show "loading" message in dropdown
  if (!fullDataLoaded) {
    dropdown.innerHTML = '<div class="dropdown-item" style="cursor: default; color: #666;">Loading match database...</div>';
    dropdown.classList.remove('dropdown-hidden');
    return;
  }

  // Fuzzy filter: match if search term appears anywhere in match ID
  let matches = allMatchIds.filter(matchId =>
    matchId.toLowerCase().includes(searchTerm)
  );

  // Sort matches by relevance (starts with search term first)
  matches.sort((a, b) => {
    let aLower = a.toLowerCase();
    let bLower = b.toLowerCase();
    let aStarts = aLower.startsWith(searchTerm);
    let bStarts = bLower.startsWith(searchTerm);

    if (aStarts && !bStarts) return -1;
    if (!aStarts && bStarts) return 1;
    return a.localeCompare(b);
  });

  // Display matches in dropdown
  if (matches.length > 0) {
    dropdown.innerHTML = '';
    dropdown.classList.remove('dropdown-hidden');

    // Limit to top 20 matches
    matches.slice(0, 20).forEach((matchId, index) => {
      let item = document.createElement('div');
      item.className = 'dropdown-item';
      item.textContent = matchId;

      // Add hover handler to load match on mouseover
      item.addEventListener('mouseenter', function () {
        loadMatch(matchId);
      });

      // Add click handler
      item.addEventListener('click', function () {
        loadMatch(matchId);
        searchInput.value = '';
        dropdown.classList.add('dropdown-hidden');
      });

      dropdown.appendChild(item);
    });

    // Automatically load the top candidate
    loadMatch(matches[0]);
  } else {
    dropdown.classList.add('dropdown-hidden');
  }
}

function setupSearchInterface() {
  let loadingIndicator = document.getElementById('loading-indicator');
  let dropdown = document.getElementById('dropdown');
  let searchInput = document.getElementById('search-input');

  // Hide loading indicator now that data is loaded
  loadingIndicator.classList.add('loading-hidden');
  
  // If user already typed something, update results
  if (searchInput.value.length > 0) {
    handleSearchInput();
  }

  // Close dropdown when clicking outside
  document.addEventListener('click', function (e) {
    if (!searchInput.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.add('dropdown-hidden');
    }
  });
}

POINTS_TO_WIN_GAME = 4;
GAMES_TO_WIN_SET = 6;
SETS_TO_WIN_MATCH = 3;


let scoresnake;

let layers = [];

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

class Game {
  constructor(tiles = POINTS_TO_WIN_GAME) {
    this.active = false;
    this.tailSize = 0;

    this.tiles = tiles;
  }

  draw(x, y, b = 30) {

    // console.log(`Drawing game at (${x}, ${y}) with tailSize ${tailSize} and point tiles ${xTiles} x ${yTiles}`);

    stroke(20);
    fill(b);
    strokeWeight(0.25);

    let s = pointSquareSize;

    for (let p1_pts = 0; p1_pts < this.tiles; p1_pts++) {
      for (let p2_pts = 0; p2_pts < this.tiles; p2_pts++) {

        rect(x + p1_pts * s, y + p2_pts * s, s, s);

      }
    }

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
      rect(tX + layer * s, tY + layer * s, s, s);
      rect(tX + layer * s, tY + (layer - 1) * s, s, s);
      rect(tX + (layer - 1) * s, tY + layer * s, s, s);

      if (this.tiles > POINTS_TO_WIN_GAME) {

        textAlign(RIGHT, CENTER);
        textSize(5);

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

class Set {
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
            translate(x + offset[axisToPlayer("x")] + gameSize / 2, y + offset[axisToPlayer("y")] - gapToChart);
            rotate(-TAU / 8);
            text(p1_gamesWon, 0, 0);
            pop();

            for (let i = 0; i < pointScoreText.length; i++) {

              textAlign(CENTER, CENTER);
              textSize(5);

              push();
              translate(x + offset[axisToPlayer("x")] + i * pointSquareSize + pointSquareSize / 2, y + offset[axisToPlayer("y")] - 3);
              rotate(-TAU / 4)
              text(pointScoreText[i], 0, 0);

              pop();

            }


          } else {
            push();
            translate(x + offset[axisToPlayer("x")] - gapToChart, y + offset[axisToPlayer("y")] + gameSize / 2);
            rotate(-TAU / 8);
            text(p1_gamesWon, 0, 0);
            pop();

            for (let i = 0; i < pointScoreText.length; i++) {

              textAlign(CENTER, CENTER);
              textSize(5);

              push();
              translate(x + offset[axisToPlayer("x")] - 3, y + offset[axisToPlayer("y")] + i * pointSquareSize + pointSquareSize / 2);
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
            translate(x + offset[axisToPlayer("x")] + gameSize / 2, y + offset[axisToPlayer("y")] - gapToChart);
            rotate(-TAU / 8);
            text(p2_gamesWon, 0, 0);
            pop();

            for (let i = 0; i < pointScoreText.length; i++) {

              textAlign(CENTER, CENTER);
              textSize(5);

              push();
              translate(x + offset[axisToPlayer("x")] + i * pointSquareSize + pointSquareSize / 2, y + offset[axisToPlayer("y")] - 3);
              rotate(-TAU / 4)
              text(pointScoreText[i], 0, 0);

              pop();

            }

          } else {
            push();
            translate(x + offset[axisToPlayer("x")] - gapToChart, y + offset[axisToPlayer("y")] + gameSize / 2);
            rotate(-TAU / 8);
            text(p2_gamesWon, 0, 0);
            pop();

            for (let i = 0; i < pointScoreText.length; i++) {

              textAlign(CENTER, CENTER);
              textSize(5);

              push();
              translate(x + offset[axisToPlayer("x")] - 3, y + offset[axisToPlayer("y")] + i * pointSquareSize + pointSquareSize / 2);
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
          this.sets[p1_setsWon].push(new Set(true));
        } else {
          this.sets[p1_setsWon].push(new Set());
        }
      }
    }

  }

  draw(x, y) {

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
        translate(x + offset[axisToPlayer("x")] + setSize / 2, y + offset[axisToPlayer("y")] - gapToChart);
        rotate(-TAU / 8);
        text(p1_setsWon, 0, 0);
        pop();
      } else {
        push();
        translate(x + offset[axisToPlayer("x")] - gapToChart, y + offset[axisToPlayer("y")] + setSize / 2);
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
            translate(x + offset[axisToPlayer("x")] + setSize / 2, y + offset[axisToPlayer("y")] - gapToChart);
            rotate(-TAU / 8);
            text(p2_setsWon, 0, 0);
            pop();
          } else {
            push();
            translate(x + offset[axisToPlayer("x")] - gapToChart, y + offset[axisToPlayer("y")] + setSize / 2);
            rotate(-TAU / 8);
            text(p2_setsWon, 0, 0);
            pop();
          }

        }


        let set = this.sets[p1_setsWon][p2_setsWon];





        set.draw(x + offset[axisToPlayer("x")], y + offset[axisToPlayer("y")]);

        offset[2] += this.setOffsets[2][p2_setsWon];

      }

      offset[1] += this.setOffsets[1][p1_setsWon];

    }

  }

  update(matchData) {

    layers[2].clear();
    layers[0].clear();

    let s = pointSquareSize;

    let setPos = createVector(0, 0);

    for (let set of matchData.sets) {

      let gamePos = createVector(0, 0);

      this.sets[set.setsInMatchWonByPlayerSoFar[1]][set.setsInMatchWonByPlayerSoFar[2]].active[1][0] = true;
      this.sets[set.setsInMatchWonByPlayerSoFar[1]][set.setsInMatchWonByPlayerSoFar[2]].active[2][0] = true;

      for (let [g, game] of set.games.entries()) {


        this.sets[set.setsInMatchWonByPlayerSoFar[1]][set.setsInMatchWonByPlayerSoFar[2]].
          games[game.gamesInSetWonByPlayerSoFar[1]][game.gamesInSetWonByPlayerSoFar[2]].active = true;

        let pointPos = createVector(0, 0);

        for (let point of game.points) {

          if (point.winner == 1) {
            if (point.server == 1) {
              layers[2].fill("#A423B7");
            } else {
              layers[2].fill("#F442FF");
            }
          } else if (point.winner == 2) {
            if (point.server == 2) {
              layers[2].fill("#00A300");
            } else {
              layers[2].fill("#00FF00");
            }
          }

          layers[2].strokeWeight(0.25);
          layers[2].stroke(20);

          layers[2].rect(setPos.x + gamePos.x + pointPos.x, setPos.y + gamePos.y + pointPos.y, s, s);

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

        let gameOffsets = this.sets[set.setsInMatchWonByPlayerSoFar[1]][set.setsInMatchWonByPlayerSoFar[2]].gameOffsets;

        if (game.gamesInSetWonByPlayerSoFar[l] >= GAMES_TO_WIN_SET - 1 || game.gamesInSetWonByPlayerSoFar[w] < GAMES_TO_WIN_SET - 1) {
          this.sets[set.setsInMatchWonByPlayerSoFar[1]][set.setsInMatchWonByPlayerSoFar[2]].active[w][game.gamesInSetWonByPlayerSoFar[w] + 1] = true;
        }


        let sGame = this.sets[set.setsInMatchWonByPlayerSoFar[1]][set.setsInMatchWonByPlayerSoFar[2]].
          games[game.gamesInSetWonByPlayerSoFar[1]][game.gamesInSetWonByPlayerSoFar[2]]

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

          drawConnector(
            setPos.x + gX,
            setPos.y + gY,
            pointPos[pAxes[w]],
            pointPos[pAxes[l]],
            t,
            (pAxes[w] == "x")
          );

        } else {

          drawConnector(
            setPos.x,
            setPos.y,
            gamePos[pAxes[w]] + pointPos[pAxes[w]],
            gamePos[pAxes[l]] + pointPos[pAxes[l]],
            setGap,
            (pAxes[w] == "x")
          );

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


  }
}

// Parse CSV data into a nested hierarchical object
function parseMatchData() {
  // Create the match object with nested structure
  window.tennisMatch = {
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

function drawConnector(x, y, pW, pL, thickness = pointSquareSize, winnerAxisIsX = true) {


  layers[0].fill(100);

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

  layers[0].push();
  layers[0].translate(x, y);

  layers[0].beginShape();

  for (let pt of points) {
    if (winnerAxisIsX) {
      layers[0].vertex(pt.w, pt.l);
    } else {
      layers[0].vertex(pt.l, pt.w);
    }
  }

  layers[0].endShape();

  layers[0].pop();

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
  
  layers[1].clear();
  // layers[0].clear();
  // layers[3].clear();


  fill(255);
  textSize(32);
  if (JetBrainsMonoBold) textFont(JetBrainsMonoBold);
  textAlign(LEFT, TOP);

  text(`${tennisMatch.player1}`, 50, 50);

  textAlign(RIGHT, TOP);

  text(`${tennisMatch.player2}`, width - 50, 50);

  // stroke(255);
  // strokeWeight(1);
  // line(width / 2, 0, width / 2, height);

  let matchX = width / 2, matchY = 50;


  push();
  translate(matchX, matchY);
  rotate(TAU / 8);

  image(layers[0], 0, 0);

  scoresnake.draw(0, 0);

  image(layers[2], 0, 0);

  // for (let layer of layers) {

  //   image(layer, 0, 0);

  // }

  pop();



  // noLoop();

}