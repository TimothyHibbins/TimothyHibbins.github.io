

/*

Bugs to fix:
- Check showing for movement hover when it shouldn't
- Checkmate # showing when it shouldn't ( a piece could move in to block)

Things to add:
- colour object
  - different colour possibilities?
    - orange / cyan
    - green / purple
    - different colors for different pieces

- move tree??
- sandbox mode
- save and import positions 

- show captured pieces
  - with point advantage
  
- proper disambiguation for move notation

- buttons for controlling history
- keyboard input

- dynamic piece shapes
  - dynamic king check?

- render
  - gems
  - lasers
    - different laser types?

- sound
  - each move should have a unique sound effect based on
    - piece moving
    - piece color
    - departure and destination node
    - piece captured
    - check
- played quickly this would result in a sonification of the whole game

- faces



- each piece has dictionary for possible directions
- for line pieces, directions can be lists
- each entry in the dictionary / list can be:
  - ply
  - out of bounds
  - defending
  - blocked by KING (king can't be defended)

*/

const PAWN = "PAWN";
const KNIGHT = "KNIGHT";
const BISHOP = "BISHOP";
const ROOK = "ROOK";
const QUEEN = "QUEEN";
const KING = "KING";

const BLOCKED = "blocked";
const PLY = "ply";
const OUT_OF_BOUNDS = "out of bounds"

bkR = "bkR";
bkN = "bkN";
bkB = "bkB";
bK = "bK";
bQ = "bQ";
bqB = "bqB";
bqN = "bqN";
bqR = "bqR";

baP = "baP";
bbP = "bbP";
bcP = "bcP";
bdP = "bdP";
beP = "beP";
bfP = "bfP";
bgP = "bgP";
bhP = "bhP";

wkR = "wkR";
wkN = "wkN";
wkB = "wkB";
wK = "wK";
wQ = "wQ";
wqB = "wqB";
wqN = "wqN";
wqR = "wqR";

waP = "waP";
wbP = "wbP";
wcP = "wcP";
wdP = "wdP";
weP = "weP";
wfP = "wfP";
wgP = "wgP";
whP = "whP";

const WHITE = 0;
const BLACK = 1;

CHECK = "check";
CHECKMATE = "checkmate";
STALEMATE = "stalemate";

MAIN = "main";
DIAGONAL_A = "diagonal a";
DIAGONAL_B = "diagonal b";
KNIGHT_LINES = "knight lines";

FLAG = "flag";

N_RANKS = 8;
N_FILES = 8;

LAST_RANK = N_RANKS - 1;
LAST_FILE = N_FILES - 1;

const clamp = (num, min, max) => Math.min(Math.max(num, min), max);


// var laserNodes;

function setup() {
  createCanvas(windowWidth, windowHeight);

  userStartAudio(); // Required to enable audio
  osc = new p5.Oscillator('triangle');
  env = new p5.Envelope();

  // Envelope: attack, decay, sustain, release (seconds)
  env.setADSR(0.01, 0.1, 0.1, 0.2);
  env.setRange(0.2, 0); // volume range

  osc.start();
  osc.amp(0);


  // Colours
  grooveColor = color("rgb(239,239,239)");

  diagonalGrooveColors = [
    color("#F6F6F6"),
    color("#E6E6E6"),
  ];

  knightColorsVerticalStretch = [
    color("#B8B8B8"),
    color("#979797"),
    color("#686868"),
    color("#292929"),
  ];
  knightColorsHorizontalStretch = [
    color("#B8B8B8"),
    color("#979797"),
    color("#686868"),
    color("#292929"),
  ];

  vertexColor = color("#FFFFFF");

  colorScheme = {
    [WHITE]: {

      laser: {

        [MAIN]: color("#FF7068"),
        [DIAGONAL_A]: color("#FF7D68"),
        [DIAGONAL_B]: color("#FF688D"),
        [KNIGHT_LINES]: color("#FFAC68"),

      },

      piece: {

        [MAIN]: color("#FF2B1C"),
        [DIAGONAL_A]: color("#FF531C"),
        [DIAGONAL_B]: color("#FF1C5B"),
        [KNIGHT_LINES]: color("#FF831C"),

      },

      illegal: {

        [MAIN]: color("#CF2E23"),
        [DIAGONAL_A]: color("#CF5323"),
        [DIAGONAL_B]: color("#CF2359"),
        [KNIGHT_LINES]: color("#CF9523"),

      },

      outline: {

        [MAIN]: color("#991F16"),
        [DIAGONAL_A]: color("#994416"),
        [DIAGONAL_B]: color("#991648"),
        [KNIGHT_LINES]: color("#996D16"),

      },

      threat: color("#F7A39D"),
      selection: color("#FFA038"),
    },
    [BLACK]: {

      laser: {

        [MAIN]: color("#61D3FF"),
        [DIAGONAL_A]: color("#6191FF"),
        [DIAGONAL_B]: color("#61EEFF"),
        [KNIGHT_LINES]: color("#61FFBD"),

      },

      piece: {

        [MAIN]: color("#26B8E7"),
        [DIAGONAL_A]: color("#2682E7"),
        [DIAGONAL_B]: color("#26E0E7"),
        [KNIGHT_LINES]: color("#26E7B1"),

      },

      illegal: {

        [MAIN]: color("#198EB3"),
        [DIAGONAL_A]: color("#1962B3"),
        [DIAGONAL_B]: color("#19B3AE"),
        [KNIGHT_LINES]: color("#19B39E"),

      },

      outline: {

        [MAIN]: color("#146A92"),
        [DIAGONAL_A]: color("#144C92"),
        [DIAGONAL_B]: color("#146A92"),
        [KNIGHT_LINES]: color("#149292"),

      },

      threat: color("#89C7EE"),
      selection: color("#21F7FF"),
    }
  };

  selectionColor = color("#21F7FF");

  laserNodes = [];

  for (let rank = 0; rank < N_RANKS; rank++) {

    laserNodes.push([]);

    for (let file = 0; file < N_FILES; file++) {

      laserNodes[rank].push({ [BLACK]: [], [WHITE]: [] });

    }
  }


  // Movesets
  Pawn.moveset = [];
  Knight.moveset = [

    createVector(1, 2),
    createVector(2, 1),
    createVector(2, -1),
    createVector(1, -2),
    createVector(-1, -2),
    createVector(-2, -1),
    createVector(-2, 1),
    createVector(-1, 2),

  ];
  Rook.moveset = [

    createVector(0, -1), // North

    createVector(-1, 0), // West

    createVector(0, 1), // South

    createVector(1, 0), // East

  ];
  Bishop.moveset = [

    createVector(-1, -1), // North West

    createVector(-1, 1), // South West

    createVector(1, 1), // South East

    createVector(1, -1), // North East

  ];
  Queen.moveset = [

    createVector(0, -1), // North

    createVector(-1, -1), // North West

    createVector(-1, 0), // West

    createVector(-1, 1), // South West

    createVector(0, 1), // South

    createVector(1, 1), // South East

    createVector(1, 0), // East

    createVector(1, -1), // North East

  ];
  King.moveset = [

    createVector(0, -1), // North

    createVector(-1, -1), // North West

    createVector(-1, 0), // West

    createVector(-1, 1), // South West

    createVector(0, 1), // South

    createVector(1, 1), // South East

    createVector(1, 0), // East

    createVector(1, -1), // North East

  ];


  // Notation
  fileLetters = [
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
    "g",
    "h",
  ];
  rankNumbers = [
    "8",
    "7",
    "6",
    "5",
    "4",
    "3",
    "2",
    "1",
  ];
  pieceLetters = {
    [PAWN]: "",
    [ROOK]: "R",
    [KNIGHT]: "N",
    [BISHOP]: "B",
    [QUEEN]: "Q",
    [KING]: "K",
  }

  letterToPiece = Object.fromEntries(
    Object.entries(pieceLetters).map(([piece, letter]) => [letter, piece])
  );

  fileFrequencies = [
    261.63,
    293.66,
    329.63,
    349.23,
    392.00,
    440.00,
    493.88,
    523.25,
  ];
  rankFrequencies = [
    261.63,
    293.66,
    329.63,
    349.23,
    392.00,
    440.00,
    493.88,
    523.25,
  ];

  //   | Note | Scientific Name | Frequency (Hz) |
  // | ---- | --------------- | -------------- |
  // | C    | C4              | 261.63         |
  // | D    | D4              | 293.66         |
  // | E    | E4              | 329.63         |
  // | F    | F4              | 349.23         |
  // | G    | G4              | 392.00         |
  // | A    | A4              | 440.00         |
  // | B    | B4              | 493.88         |
  // | C    | C5              | 523.25         |


  // Board display setup
  unit = height / 11;

  margin = 10;



  boardSidelength = height - 2 * margin;
  boardX = width / 2 - (boardSidelength / 2);
  boardY = margin;

  spacing = boardSidelength / (N_RANKS - 1 + 1);

  boardEdge = spacing / 2;

  boardCornerRadius = spacing / 3;

  nodeSize = spacing * 0.80;
  pieceSize = nodeSize * 0.75;


  // Game objects
  currentPlyIndex = 0;
  hoverPlyIndex = -1;
  selectedPlyIndex = 0;

  pieceObjects = {

    byID: {
      [wkR]: new Rook(WHITE),
      [wkN]: new Knight(WHITE),
      [wkB]: new Bishop(WHITE),
      [wK]: new King(WHITE),
      [wQ]: new Queen(WHITE),
      [wqB]: new Bishop(WHITE),
      [wqN]: new Knight(WHITE),
      [wqR]: new Rook(WHITE),

      [waP]: new Pawn(WHITE),
      [wbP]: new Pawn(WHITE),
      [wcP]: new Pawn(WHITE),
      [wdP]: new Pawn(WHITE),
      [weP]: new Pawn(WHITE),
      [wfP]: new Pawn(WHITE),
      [wgP]: new Pawn(WHITE),
      [whP]: new Pawn(WHITE),

      [bkR]: new Rook(BLACK),
      [bkN]: new Knight(BLACK),
      [bkB]: new Bishop(BLACK),
      [bK]: new King(BLACK),
      [bQ]: new Queen(BLACK),
      [bqB]: new Bishop(BLACK),
      [bqN]: new Knight(BLACK),
      [bqR]: new Rook(BLACK),

      [baP]: new Pawn(BLACK),
      [bbP]: new Pawn(BLACK),
      [bcP]: new Pawn(BLACK),
      [bdP]: new Pawn(BLACK),
      [beP]: new Pawn(BLACK),
      [bfP]: new Pawn(BLACK),
      [bgP]: new Pawn(BLACK),
      [bhP]: new Pawn(BLACK),
    },
    all: [],
    [BLACK]: [],
    [WHITE]: []

  }
  shadowPieceObjects = deepCopy(pieceObjects);

  positionHistory = [new Position()];

  gamePlies = [false];


  plyOptions = {
    byNode: [
      [[], [], [], [], [], [], [], [],],
      [[], [], [], [], [], [], [], [],],
      [[], [], [], [], [], [], [], [],],
      [[], [], [], [], [], [], [], [],],
      [[], [], [], [], [], [], [], [],],
      [[], [], [], [], [], [], [], [],],
      [[], [], [], [], [], [], [], [],],
      [[], [], [], [], [], [], [], [],],
    ]
  }

  updatePieceObjectsFromPosition(pieceObjects, positionHistory[currentPlyIndex]);
  updatePlyOptions(positionHistory[currentPlyIndex]);




  // Selection
  departureVertex = false;
  hoverNode = false;
  selectedPly = false;
  pawnPromotionSelectionPhase = false;


  // this is really hacky and not ideal
  pawnPromotionPieceOptions = {
    [WHITE]: [

      new Queen(WHITE),
      new Knight(WHITE),
      new Rook(WHITE),
      new Bishop(WHITE),

    ],

    [BLACK]: [

      new Queen(BLACK),
      new Knight(BLACK),
      new Rook(BLACK),
      new Bishop(BLACK),

    ],
  };

  pawnPromotionOptionHover = false;


  coordinatesVisible = { [FLAG]: false };
  buttons = [

    new Button(boardX + boardSidelength + margin * 2, height - margin - spacing / 2, spacing * 3, spacing / 2, "Visible Coordinates", coordinatesVisible)

  ];

}


function playMoveSound(rank, file) {

  playNote(rankFrequencies[rank], 0);
  playNote(fileFrequencies[file], 150);
}

function playNote(freq, delayMs) {
  setTimeout(() => {
    osc.freq(freq);
    env.play(osc);
  }, delayMs);
}


class Button {

  constructor(x, y, w, h, txt, toggleVariable) {

    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
    this.txt = txt;
    this.toggleVariable = toggleVariable;

  }

  checkIfMouseInside() {

    if (mouseX > this.x && mouseX < this.x + this.w &&
      mouseY > this.y && mouseY < this.y + this.h) {

      return true;

    } else {

      return false;

    }


  }

  draw() {


    let word;
    if (this.toggleVariable[FLAG]) {
      word = "ON";
      fill(selectionColor);

    } else {
      word = "OFF";
      noFill();

    }

    if (this.checkIfMouseInside()) {
      strokeWeight(3);
    } else {
      strokeWeight(1);
    }

    stroke(0);
    rectMode(CORNER);
    rect(this.x, this.y, this.w, this.h);

    noStroke();
    fill(0);
    textAlign(CENTER);




    text(this.txt + ": " + word, this.x + this.w / 2, this.y + this.h / 2);


  }


}

class LightweightPiece {

  constructor(id, type, pieceColor, hasMoved = false) {

    this.id = id;
    this.type = type;
    this.pieceColor = pieceColor;
    this.hasMoved = hasMoved;

  }

}

class Position {

  constructor() {

    this.board = [

      [
        new LightweightPiece(bqR, ROOK, BLACK),
        new LightweightPiece(bqN, KNIGHT, BLACK),
        new LightweightPiece(bqB, BISHOP, BLACK),
        new LightweightPiece(bQ, QUEEN, BLACK),
        new LightweightPiece(bK, KING, BLACK),
        new LightweightPiece(bkB, BISHOP, BLACK),
        new LightweightPiece(bkN, KNIGHT, BLACK),
        new LightweightPiece(bkR, ROOK, BLACK),
      ],
      [
        new LightweightPiece(baP, PAWN, BLACK),
        new LightweightPiece(bbP, PAWN, BLACK),
        new LightweightPiece(bcP, PAWN, BLACK),
        new LightweightPiece(bdP, PAWN, BLACK),
        new LightweightPiece(beP, PAWN, BLACK),
        new LightweightPiece(bfP, PAWN, BLACK),
        new LightweightPiece(bgP, PAWN, BLACK),
        new LightweightPiece(bhP, PAWN, BLACK),
      ],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      [
        new LightweightPiece(waP, PAWN, WHITE),
        new LightweightPiece(wbP, PAWN, WHITE),
        new LightweightPiece(wcP, PAWN, WHITE),
        new LightweightPiece(wdP, PAWN, WHITE),
        new LightweightPiece(weP, PAWN, WHITE),
        new LightweightPiece(wfP, PAWN, WHITE),
        new LightweightPiece(wgP, PAWN, WHITE),
        new LightweightPiece(whP, PAWN, WHITE),
      ],
      [
        new LightweightPiece(wqR, ROOK, WHITE),
        new LightweightPiece(wqN, KNIGHT, WHITE),
        new LightweightPiece(wqB, BISHOP, WHITE),
        new LightweightPiece(wQ, QUEEN, WHITE),
        new LightweightPiece(wK, KING, WHITE),
        new LightweightPiece(wkB, BISHOP, WHITE),
        new LightweightPiece(wkN, KNIGHT, WHITE),
        new LightweightPiece(wkR, ROOK, WHITE),
      ],

    ];

    this.playersCapturedPieces = {
      [WHITE]: [],
      [BLACK]: []
    };

    this.playerToMove = WHITE;
    this.opponent = BLACK;

    this.enPassantTarget = null;

    this.status = getStatus(this);

    // this.castlingRights = {[WHITE]: }    

  }

}

function isKingInCheck(position) {

  updatePieceObjectsFromPosition(shadowPieceObjects, position);

  let king;
  let opponent;
  if (position.playerToMove == WHITE) {
    king = shadowPieceObjects.byID[wK];
    opponent = BLACK;
  } else if (position.playerToMove == BLACK) {
    king = shadowPieceObjects.byID[bK];
    opponent = WHITE;
  }

  for (let shadowPiece of shadowPieceObjects[opponent]) {

    for (let threatNode of shadowPiece.threatNodes) {

      if (threatNode.x == king.file && threatNode.y == king.rank) {

        // king is in check
        return true;

      }

    }

  }

  return false;

}

function getStatus(position) {

  let status = null;
  if (isKingInCheck(position)) {
    status = CHECK;
  }

  updatePieceObjectsFromPosition(shadowPieceObjects, position);

  let hasLegalPlies = false;
  for (let shadowPiece of shadowPieceObjects[position.playerToMove]) {

    let shadowPiecePlies = getLegalPlies(shadowPiece, position, shadowPieceObjects);

    if (shadowPiecePlies.length > 0) {
      hasLegalPlies = true;
      break;
    }

  }



  if (!hasLegalPlies) {

    if (status == CHECK) {
      status = CHECKMATE;
    } else {
      status = STALEMATE;
    }
  }

  return status;
}

function swapPlayerToMove(position) {
  if (position.playerToMove == WHITE) {
    position.playerToMove = BLACK;
    position.opponent = WHITE;
  } else if (position.playerToMove == BLACK) {
    position.playerToMove = WHITE;
    position.opponent = BLACK;
  }
}

class Ply {

  constructor(position, piece, departureFile, departureRank, destinationFile, destinationRank, capturedPieceID = false, castling = false, pawnPromotion = false, promotedPiece = false) {

    this.position = position;
    this.piece = piece;
    this.departureFile = departureFile;
    this.departureRank = departureRank;
    this.destinationFile = destinationFile;
    this.destinationRank = destinationRank;
    this.capturedPieceID = capturedPieceID;

    this.castling = castling;

    this.pawnPromotion = pawnPromotion;
    this.promotedPiece = promotedPiece;

  }

  makePly(position) {

    if (position.board[this.departureRank][this.departureFile].hasMoved == false) {

      position.board[this.departureRank][this.departureFile].hasMoved = true;

      // handling en passant
      if (position.board[this.departureRank][this.departureFile].type == PAWN) {

        let rankDirection = this.piece.rankDirection;

        if (this.destinationRank != this.departureRank + rankDirection) {

          position.enPassantTarget = { x: this.departureFile, y: this.departureRank + rankDirection };

        }



      }

    }

    position.board[this.destinationRank][this.destinationFile] = position.board[this.departureRank][this.departureFile];

    position.board[this.departureRank][this.departureFile] = null;

    //     if (this.capturedPieceID) {

    //       positionHistory[currentPlyIndex].playersCapturedPieces[piece..push(capturedPiece);

    //     }

    // Castling
    if (this.castling) {

      // If King moves to g file
      if (this.destinationFile == 6) {

        // Castling Kingside (Kingside Rook moves to the f file)

        position.board[this.destinationRank][5] = position.board[this.departureRank][7];

        position.board[this.departureRank][7] = null;

      }
      // If King moves to c file
      else if (this.destinationFile == 2) {

        // Castling Queenside (Queenside Rook moves to the d file)

        position.board[this.destinationRank][3] = position.board[this.departureRank][0];

        position.board[this.departureRank][0] = null;

      }

    }

    // Pawn Promotion
    if (this.pawnPromotion) {

      position.board[this.destinationRank][this.destinationFile].type = this.promotedPiece;

    }

  }

}

function plyNotation(ply, resultingPosition) {


  // Castling
  if (ply.castling) {

    // If King moves to g file
    if (ply.destinationFile == 6) {

      // Castling Kingside (Kingside Rook moves to the f file)

      return "O-O";

    }
    // If King moves to c file
    else if (ply.destinationFile == 2) {

      // Castling Queenside (Queenside Rook moves to the d file)

      return "O-O-O";

    }

  }

  let capture = "";

  if (ply.capturedPieceID) {
    capture = "x";
  }

  let promotion = "";
  if (ply.promotedPiece) {

    promotion = pieceLetters[ply.promotedPiece];

  }

  let status = "";

  if (resultingPosition.status == CHECK) {
    status = "+";
  } else if (resultingPosition.status == CHECKMATE) {
    status = "#";
  }

  let type = ply.piece.type;

  return pieceLetters[type] + capture + fileLetters[ply.destinationFile] + rankNumbers[ply.destinationRank] + promotion + status;

}




var samplePGN = `
[Event "Let\\'s Play!"]
[Site "Chess.com"]
[Date "2025.11.06"]
[Round "?"]
[White "TimothyHibbins"]
[Black "rosy_imi"]
[Result "*"]
[TimeControl "1/259200"]
[WhiteElo "432"]
[BlackElo "768"]
[Termination "unterminated"]
[ECO "C60"]
[Link "https://www.chess.com/game/daily/886514433"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 Qf6 4. d3 d6 5. Bg5 Qe6 6. O-O a6 7. Bc4 Qd7 8. Nc3
f6 9. Be3 b5 10. Bd5 Bb7 11. d4 O-O-O 12. Qd3 Na5 *
`;

//
function extractMoveText(pgn) {
  const lines = pgn.split(/\r\n|\r|\n/);

  return lines
    .filter(line => !line.trim().startsWith('['))   // keep only non-tag lines
    .join(' ')                                       // flatten
    .replace(/\s+/g, ' ')                            // collapse whitespace
    .trim();
}

function extractMoves(moveText) {
  return moveText
    .replace(/\d+\.(\.\.)?/g, '')                    // remove move numbers
    .replace(/x/g, '')                               // remove 'x'
    .replace(/\+/g, '')                              // remove '+' for check
    .replace(/#/g, '')                               // remove '#' for checkmate
    .trim()
    .split(/\s+/)
    .filter(tok => tok !== '*' && tok !== '1-0' && tok !== '0-1' && tok !== '1/2-1/2');
}

function loadGameFromPGN(pgnString) {

  plyStrings = extractMoves(extractMoveText(pgnString));

  // console.log(plyStrings);


  for (let plyString of plyStrings) {

    let pieceType;
    let destinationFile;
    let destinationRank;

    let rankDisambiguation;
    let fileDisambiguation;

    let selectedPly;

    // console.log(plyString);

    if (plyString == "O-O") {
      // castle kingside

      pieceType = KING;

      if (positionHistory[currentPlyIndex].playerToMove == WHITE) {

        destinationFile = 6;
        destinationRank = 7;

      } else {

        destinationFile = 6;
        destinationRank = 0;

      }

    } else if (plyString == "O-O-O") {

      pieceType = KING;

      if (positionHistory[currentPlyIndex].playerToMove == WHITE) {

        destinationFile = 2;
        destinationRank = 7;

      } else {

        destinationFile = 2;
        destinationRank = 0;

      }


    } else {

      var [body, lastTwo] = [plyString.slice(0, -2), plyString.slice(-2)];

      // console.log(body, lastTwo);

      destinationFile = fileLetters.indexOf(lastTwo[0]);
      destinationRank = rankNumbers.indexOf(lastTwo[1]);

      // record and strip disambiguation coordinates
      while (body.length > 0 && !(body[body.length - 1] in letterToPiece)) {

        let last = body[body.length - 1];

        // console.log(last);

        if (fileLetters.includes(last)) {
          fileDisambiguation = fileLetters.indexOf(last);
          console.log(fileDisambiguation);
        } else if (rankNumbers.includes(last)) {
          rankDisambiguation = rankNumbers.indexOf(last);
          console.log(rankDisambiguation);
        }

        body = body.slice(0, -1);

      }

      if (body[0] in letterToPiece) {
        pieceType = letterToPiece[body[0]];
      } else {
        pieceType = PAWN;
      }

      // console.log(pieceType);



    }

    // console.log(pieceType, destinationFile, destinationRank);

    for (let plyOption of plyOptions.byNode[destinationRank][destinationFile]) {

      if (plyOption.piece.type == pieceType &&
        (!fileDisambiguation || fileDisambiguation == plyOption.piece.file) &&
        (!rankDisambiguation || rankDisambiguation == plyOption.piece.rank)
      ) {

        selectedPly = plyOption;
        break;

      }

    }

    // console.log(selectedPly);
    lockInLegalPly(selectedPly);

  }

  return plyStrings;

}

function getPseudolegalPlies(piece, position, objects = pieceObjects) {

  let pieceCopy = piece;

  let pseudolegalPlies = [];

  for (let destination of piece.destinations) {

    let capturedPiece = false;
    if (position.board[destination.y][destination.x]) {
      capturedPiece = objects.byID[position.board[destination.y][destination.x].id];
    }

    pseudolegalPlies.push(new Ply(position, pieceCopy, piece.file, piece.rank, destination.x, destination.y, capturedPiece));
  }



  if (piece.type == PAWN) {

    // En passant

    for (let move of piece.captureMoveset) {

      let newFile = piece.file + move.x;
      let newRank = piece.rank + move.y;

      if (position.enPassantTarget &&
        position.enPassantTarget.x == newFile &&
        position.enPassantTarget.y == newRank) {

        let enPassantCandidate = position.board[piece.rank][newFile];

        if (enPassantCandidate &&
          enPassantCandidate.type == PAWN &&
          enPassantCandidate.pieceColor != piece.pieceColor
        ) {

          pseudolegalPlies.push(new Ply(position, pieceCopy, piece.file, piece.rank, newFile, newRank, enPassantCandidate.id));

        }

      }

    }


    // Pawn Promotion

    for (let ply of pseudolegalPlies) {

      if ((piece.pieceColor == WHITE && ply.destinationRank == 0) ||
        (piece.pieceColor == BLACK && ply.destinationRank == LAST_RANK)
      ) {


        ply.pawnPromotion = true;

      }
    }

  }

  // Castling

  /*
1. Neither the king nor the rook has previously moved.
2. There are no pieces between the king and the rook.
3. The king is not currently in check.
4. The king does not pass through or finish on a node that is attacked by an enemy piece.
*/

  if (piece.type == KING && piece.hasMoved == false) {

    // kingside
    let kingsideRookNodePiece = position.board[piece.rank][7];
    if (kingsideRookNodePiece &&
      kingsideRookNodePiece.type == ROOK &&
      kingsideRookNodePiece.hasMoved == false) {

      // ensure nodes between king and rook are empty
      if (!position.board[piece.rank][5] &&
        !position.board[piece.rank][6]) {

        pseudolegalPlies.push(new Ply(position, pieceCopy, piece.file, piece.rank, piece.file + 2, piece.rank, false, true));

      }

    }

    // queenside
    let queensideRookNodePiece = position.board[piece.rank][0];
    if (queensideRookNodePiece &&
      queensideRookNodePiece.type == ROOK &&
      queensideRookNodePiece.hasMoved == false) {

      // ensure nodes between king and rook are empty
      if (!position.board[piece.rank][1] &&
        !position.board[piece.rank][2] &&
        !position.board[piece.rank][3]) {

        pseudolegalPlies.push(new Ply(position, pieceCopy, piece.file, piece.rank, piece.file - 2, piece.rank, false, true));

      }

    }

  }

  return pseudolegalPlies;

}

function getLegalPlies(piece, position, objects = pieceObjects) {

  let legalPlies = [];
  let pseudolegalPlies = getPseudolegalPlies(piece, position, objects);

  mainLoop:
  for (let ply of pseudolegalPlies) {

    if (ply.castling) {

      // is king in check?
      if (position.status == CHECK) {
        continue mainLoop;
      }

      let opponent;
      if (position.playerToMove == WHITE) {
        opponent = BLACK;
      } else if (position.playerToMove == BLACK) {
        opponent = WHITE;
      }

      let transitFile;
      if (ply.destinationFile == 6) {
        // kingside
        transitFile = 5;
      } else if (ply.destinationFile == 2) {
        // queenside
        transitFile = 3;
      }

      updatePieceObjectsFromPosition(shadowPieceObjects, position);

      // is king passing through a current threat node when castling?
      for (let shadowPiece of shadowPieceObjects[opponent]) {

        for (let threatNode of shadowPiece.threatNodes) {

          if (threatNode.x == transitFile && threatNode.y == ply.departureRank) {

            continue mainLoop;

          }

        }
      }


    }

    let nextPosition = structuredClone(position);

    ply.makePly(nextPosition);

    if (!isKingInCheck(nextPosition)) {
      legalPlies.push(ply);
    }

  }

  return legalPlies;

}

function updatePlyOptions(position) {

  plyOptions.byNode = [
    [[], [], [], [], [], [], [], [],],
    [[], [], [], [], [], [], [], [],],
    [[], [], [], [], [], [], [], [],],
    [[], [], [], [], [], [], [], [],],
    [[], [], [], [], [], [], [], [],],
    [[], [], [], [], [], [], [], [],],
    [[], [], [], [], [], [], [], [],],
    [[], [], [], [], [], [], [], [],],
  ]

  for (let piece of pieceObjects[position.playerToMove]) {

    let plies = getLegalPlies(piece, position);

    piece.plies = plies;

    for (let ply of plies) {

      if (ply.castling) {
        // console.log("can castle", ply.destinationFile, ply.destinationRank, ply.piece.type);
      }

      plyOptions.byNode[ply.destinationRank][ply.destinationFile].push(ply);
    }

  }

  for (let piece of pieceObjects[position.opponent]) {

    let plies = getLegalPlies(piece, position);

    piece.plies = plies;

  }

  laserNodes = [];

  for (let rank = 0; rank < N_RANKS; rank++) {

    laserNodes.push([]);

    for (let file = 0; file < N_FILES; file++) {

      laserNodes[rank].push({ [BLACK]: [], [WHITE]: [] });

    }
  }

  for (let piece of pieceObjects[position.playerToMove]) {

    for (let move of piece.constructor.moveset) {

      let file = piece.file;
      let rank = piece.rank;

      for (let nodeStatus of piece.lasers[move]) {

        file += move.x;
        rank += move.y;

        if (coordsAreInsideChessboard(file, rank)) {

          laserNodes[rank][file][piece.pieceColor].push({ status: nodeStatus, piece: piece });

        }


      }

    }

  }

  for (let piece of pieceObjects[position.opponent]) {

    for (let move of piece.constructor.moveset) {

      let file = piece.file;
      let rank = piece.rank;

      for (let nodeStatus of piece.lasers[move]) {

        file += move.x;
        rank += move.y;

        if (coordsAreInsideChessboard(file, rank)) {

          laserNodes[rank][file][piece.pieceColor].push({ status: nodeStatus, piece: piece });

        }


      }

    }

  }


}

function updatePieceObjectsFromPosition(objects, position) {

  objects.all = [];
  objects[WHITE] = [];
  objects[BLACK] = [];

  for (let rank = 0; rank < position.board.length; rank++) {

    for (let file = 0; file < position.board[rank].length; file++) {

      let lightweightPiece = position.board[rank][file]

      if (lightweightPiece) {


        if (lightweightPiece.type != objects.byID[lightweightPiece.id].type) {

          if (lightweightPiece.type == PAWN) {

            objects.byID[lightweightPiece.id] = new Pawn(lightweightPiece.pieceColor);


          } else if (lightweightPiece.type == QUEEN) {

            objects.byID[lightweightPiece.id] = new Queen(lightweightPiece.pieceColor);

          } else if (lightweightPiece.type == ROOK) {

            objects.byID[lightweightPiece.id] = new Rook(lightweightPiece.pieceColor);

          } else if (lightweightPiece.type == BISHOP) {

            objects.byID[lightweightPiece.id] = new Bishop(lightweightPiece.pieceColor);

          } else if (lightweightPiece.type == KNIGHT) {

            objects.byID[lightweightPiece.id] = new Knight(lightweightPiece.pieceColor);

          }

        }

        let piece = objects.byID[lightweightPiece.id];

        piece.id = lightweightPiece.id;
        piece.file = file;
        piece.rank = rank;
        piece.hasMoved = lightweightPiece.hasMoved;

        objects.all.push(piece);
        objects[piece.pieceColor].push(piece);

      }

    }

  }

  for (let piece of objects.all) {
    piece.update(position);
  }

}

function deepCopy(obj, seen = new Map()) {
  // Handle primitives and functions directly
  if (obj === null || typeof obj !== "object") return obj;

  // Avoid infinite recursion on cycles
  if (seen.has(obj)) return seen.get(obj);

  // Create a new object with the same prototype
  const clone = Object.create(Object.getPrototypeOf(obj));
  seen.set(obj, clone);

  // Copy all properties
  for (let key of Object.keys(obj)) {
    clone[key] = deepCopy(obj[key], seen);
  }

  return clone;
}

function coordsAreInsideChessboard(file, rank) {
  if (0 <= file && file <= LAST_FILE &&
    0 <= rank && rank <= LAST_RANK) {
    return true;
  } else {
    return false;
  }
}

class Piece {

  constructor(pieceColor) {

    this.id = null;
    this.file = null;
    this.rank = null;
    this.pieceColor = pieceColor;

    this.destinations = [];
    this.laserDestinations = [];
    this.threatNodes = [];

    this.linePiece = false;


    // - each piece has dictionary for possible directions
    // - for line pieces, directions can be lists
    // - each entry in the dictionary / list can be:
    //   - ply
    //   - out of bounds
    //   - defending
    //   - blocked by KING (king can't be defended)

    this.lasers = {};

    this.plies = [];

  }

  draw(x = 0, y = 0) {

    let moveset;

    if (this.type == PAWN) {
      let midprong = 1;

      if ((this.pieceColor == WHITE && this.rank == LAST_RANK - 1) ||
        (this.pieceColor == BLACK && this.rank == 1)) {

        midprong = 2;

      }

      moveset = [
        createVector(-1, this.rankDirection),
        createVector(0, this.rankDirection * midprong),
        createVector(1, this.rankDirection),
      ];

    } else {

      moveset = this.constructor.moveset;

    }

    push();
    translate(x, y);


    strokeWeight(1);


    let anchorPointLength;
    if (this.linePiece) {
      anchorPointLength = nodeSize / 2;
    } else {
      anchorPointLength = nodeSize / 2 * 0.6;
    }

    let controlPointLength = nodeSize / 2 * 0.25;


    let angularWidth;
    if (this.type == KNIGHT) {
      angularWidth = TAU / 12;
      anchorPointLength = nodeSize / 2 * 0.5;
    } else {
      angularWidth = TAU / 8;
    }

    for (let [m, move] of moveset.entries()) {

      let c = MAIN;
      if (this.type == KNIGHT) {
        c = KNIGHT_LINES;
      } else if ((move.x != 0) && (move.y != 0)) {

        let diag = diagonalFromNode(this.file, this.rank);
        if (diag == 0) {
          c = DIAGONAL_A;
        } else {
          c = DIAGONAL_B;
        }

      }

      stroke(colorScheme[this.pieceColor].outline[c]);

      let newFile = this.file + move.x;
      let newRank = this.rank + move.y;

      let legal = false;
      let selected = false;

      if (this.plies) {
        for (let ply of this.plies) {
          if (newFile == ply.destinationFile &&
            newRank == ply.destinationRank) {


            legal = true;
            if (ply == selectedPly) {
              selected = true;
            }

          }
        }
      }


      if (legal) {

        if (selected) {
          fill(colorScheme[this.pieceColor].laser[c]);
        } else {
          fill(colorScheme[this.pieceColor].piece[c]);
        }


      } else if (coordsAreInsideChessboard(newFile, newRank)) {
        // let pc = colorScheme[this.pieceColor].piece;
        // let c = color(red(pc), green(pc), blue(pc), 150);
        fill(colorScheme[this.pieceColor].illegal[c]);
      } else {
        fill("#FFFFFF00");
      }


      beginShape();

      let anchorPoint = move.copy().mult(anchorPointLength);

      vertex(anchorPoint.x, anchorPoint.y);

      let p1 = move.copy().normalize().rotate(angularWidth / 2).mult(nodeSize * 0.25);

      vertex(p1.x, p1.y);

      vertex(0, 0);

      let p2 = move.copy().normalize().rotate(-angularWidth / 2).mult(nodeSize * 0.25);

      vertex(p2.x, p2.y);

      vertex(anchorPoint.x, anchorPoint.y);

      endShape();

    }

    // fill("#fff")
    // circle(0, 0, nodeSize * 0.2);

    pop();

  }

  update(position) {

    this.destinations = [];
    this.laserDestinations = [];
    this.threatNodes = [];

    this.lasers = {};

    for (let move of this.constructor.moveset) {

      this.lasers[move] = [];

      let rank = this.rank;
      let file = this.file;

      while (true) {

        file += move.x;
        rank += move.y;

        if (coordsAreInsideChessboard(file, rank)) {

          this.threatNodes.push(createVector(file, rank));

          let targetPiece = position.board[rank][file];

          // if blocked by piece of same color
          if (targetPiece && targetPiece.pieceColor == this.pieceColor) {

            this.laserDestinations.push(createVector(file, rank));

            this.lasers[move].push(BLOCKED);

            break;

          } else {

            this.destinations.push(createVector(file, rank));

            this.lasers[move].push(PLY);

            // if there is piece of opposite color
            if (targetPiece && targetPiece.pieceColor != this.pieceColor) {

              this.laserDestinations.push(createVector(file, rank));

              break;
            }


            if (!this.linePiece) {
              break;
            }

          }

        } else {

          file -= move.x;
          rank -= move.y;
          this.laserDestinations.push(createVector(file, rank));

          this.lasers[move].push(OUT_OF_BOUNDS);

          break;

        }

      }

    }

  }

}

class Pawn extends Piece {

  constructor(rank, file, pieceColor) {
    super(rank, file, pieceColor);

    this.type = PAWN;

    if (this.pieceColor == WHITE) {
      this.rankDirection = -1; // White pawns march north
    } else if (this.pieceColor == BLACK) {
      this.rankDirection = 1; // Black pawns march south
    }

    this.noncaptureMoveset = [
      createVector(0, this.rankDirection)
    ];

    this.captureMoveset = [
      createVector(-1, this.rankDirection),
      createVector(1, this.rankDirection),
    ];

  }

  update(position) {

    this.destinations = [];
    this.laserDestinations = [];
    this.threatNodes = [];

    this.lasers = {};

    for (let move of this.captureMoveset) {

      this.lasers[move] = [];

      let newFile = this.file + move.x;
      let newRank = this.rank + move.y;

      if (coordsAreInsideChessboard(newFile, newRank)) {

        this.threatNodes.push(createVector(newFile, newRank));
        this.laserDestinations.push(createVector(newFile, newRank));


        let targetPiece = position.board[newRank][newFile];

        // if there is a piece of opposite color to capture
        if (targetPiece && targetPiece.pieceColor != this.pieceColor) {

          this.destinations.push(createVector(newFile, newRank));

          this.lasers[move].push(PLY);

        } else {

          this.lasers[move].push(BLOCKED);

        }

      }

    }

    let newRank = this.rank + this.rankDirection;

    let move = createVector(0, this.rankDirection);

    this.lasers[move] = [];

    if (coordsAreInsideChessboard(this.file, newRank)) {

      // checks for blocking piece
      let targetPiece = position.board[newRank][this.file];

      if (!targetPiece) {
        this.destinations.push(createVector(this.file, newRank));
        this.lasers[move].push(PLY);

        // can move two forward from starting position
        if ((this.pieceColor == WHITE && this.rank == LAST_RANK - 1) ||
          (this.pieceColor == BLACK && this.rank == 1)) {

          newRank += this.rankDirection;

          // checks for blocking piece
          let targetPiece = position.board[newRank][this.file];

          if (!targetPiece) {
            this.destinations.push(createVector(this.file, newRank));
            this.lasers[move].push(PLY);

          } else {
            this.lasers[move].push(BLOCKED);
          }

        }

      } else {
        this.lasers[move].push(BLOCKED);
      }

    }

  }

}

class Rook extends Piece {

  constructor(rank, file, pieceColor) {
    super(rank, file, pieceColor);

    this.type = ROOK;

    this.linePiece = true;
    this.hasMoved = false;
  }

}

class Knight extends Piece {

  constructor(rank, file, pieceColor) {
    super(rank, file, pieceColor);

    this.type = KNIGHT;

  }

}

class Bishop extends Piece {

  constructor(rank, file, pieceColor) {
    super(rank, file, pieceColor);

    this.type = BISHOP;

    this.linePiece = true;
  }

}

class Queen extends Piece {

  constructor(rank, file, pieceColor) {
    super(rank, file, pieceColor);

    this.type = QUEEN;

    this.linePiece = true;
  }

}

class King extends Piece {

  constructor(rank, file, pieceColor) {
    super(rank, file, pieceColor);

    this.type = KING;
    this.hasMoved = false;

  }

}



// Drawing

function laserLine(x1, y1, x2, y2, thickness, laserColor) {

  let lowOpacityLaserColor = color(red(laserColor), green(laserColor), blue(laserColor), 25);
  stroke(lowOpacityLaserColor);
  strokeWeight(thickness * 4);
  line(x1 * spacing, y1 * spacing, x2 * spacing, y2 * spacing);

  lowOpacityLaserColor = color(red(laserColor), green(laserColor), blue(laserColor), 50);
  stroke(lowOpacityLaserColor);
  strokeWeight(thickness * 3);
  line(x1 * spacing, y1 * spacing, x2 * spacing, y2 * spacing);

  lowOpacityLaserColor = color(red(laserColor), green(laserColor), blue(laserColor), 100);
  stroke(lowOpacityLaserColor);
  strokeWeight(thickness * 2);
  line(x1 * spacing, y1 * spacing, x2 * spacing, y2 * spacing);

  stroke(laserColor);
  strokeWeight(thickness);
  line(x1 * spacing, y1 * spacing, x2 * spacing, y2 * spacing);

  stroke(255);
  strokeWeight(2);
  line(x1 * spacing, y1 * spacing, x2 * spacing, y2 * spacing);

}

function threatNode(piece, file, rank) {

  fill(colorScheme[piece.pieceColor].threat);
  noStroke();
  circle(file * spacing, rank * spacing, nodeSize * 0.2);

}

function drawGrid(directions, vertexRadius, dripLen, edgeLength, vertexColoringRule) {

  for (let rank = 0; rank < 8; rank++) {

    for (let file = 0; file < 8; file++) {

      fill(vertexColoringRule(file, rank));
      noStroke();

      circle(spacing * file, spacing * rank, vertexRadius * 2);

      for (let direction of directions) {

        let newFile = file + direction.x;
        let newRank = rank + direction.y;

        if (!coordsAreInsideChessboard(newFile, newRank)) {

          continue;

        }

        let cx = file * spacing;
        let cy = rank * spacing;

        //         let r = vertexRadius;


        let rotateVec = createVector(file, rank).sub(createVector(newFile, newRank));

        push();
        translate(cx, cy);
        rotate(rotateVec.heading() + TAU / 4);
        translate(-cx, -cy);

        //         noStroke();

        //         // circle(cx, cy, r*2);

        //         // Base point where the drip attaches (bottom of circle)
        //         let baseX = cx;
        //         let baseY = cy;

        //         // How far the drip extends
        //         let tipX = baseX;
        //         let tipY = baseY + dripLen;

        //         // Draw drip with bezier curves, sharp at the tip
        //         beginShape();
        //         vertex(baseX - r, baseY);               // left attach point
        //         bezierVertex(baseX - r/3, baseY+dripLen/5, 
        //                      tipX, tipY-dripLen/2, 
        //                      tipX, tipY);   // left curve to tip

        //         bezierVertex(tipX, tipY-dripLen/2, 
        //                      baseX + r/3, baseY+dripLen/5, 
        //                      baseX + r, baseY);          // right curve back up
        //         endShape(CLOSE);

        strokeWeight(1);
        stroke(vertexColoringRule(file, rank));



        line(cx, cy, cx, cy + edgeLength);

        pop();

      }


    }

  }

}

function mainVertexColoringRule(file, rank) {

  return grooveColor;

}

function diagonalFromNode(file, rank) {

  let C = 0;
  if (file % 2 != rank % 2) {
    C = 1;
  }

  return C;

}

function diagonalVertexColoringRule(file, rank) {

  return diagonalGrooveColors[diagonalFromNode(file, rank)];

}

function KnightVertexColoringRule(file, rank) {

  let C = (file + (rank % 2) * 2) % 4;
  return knightColorsHorizontalStretch[C];
}

function drawPlayerToMove() {

  let player;
  if (positionHistory[currentPlyIndex].playerToMove == WHITE) {
    player = "White";
  } else if (positionHistory[currentPlyIndex].playerToMove == BLACK) {
    player = "Black";
  }

  textSize(spacing / 4);
  fill(colorScheme[positionHistory[currentPlyIndex].playerToMove].piece);
  textAlign(CENTER, BOTTOM);
  text(player + " to move", boardSidelength / 2, spacing / 2);

}

function drawCoordinatesAtEdgeOfBoard() {

  fill(0);
  textSize(15);
  textAlign(CENTER, CENTER);

  // left of board
  for (let rank = 0; rank < N_RANKS; rank++) {

    text(rankNumbers[rank], 0 * spacing - spacing / 2, rank * spacing);

  }

  // right of board
  for (let rank = 0; rank < N_RANKS; rank++) {

    text(rankNumbers[rank], LAST_FILE * spacing + spacing / 2, rank * spacing);

  }

  // top of board
  for (let file = 0; file < N_FILES; file++) {

    text(fileLetters[file], file * spacing, 0 * spacing - spacing / 2);

  }

  // bottom of board
  for (let file = 0; file < N_FILES; file++) {

    text(fileLetters[file], file * spacing, LAST_RANK * spacing + spacing / 2);

  }

}

function drawCoordinatesOnEachVertex() {

  fill("#0000001C");
  stroke("#00000049");
  strokeWeight(1);
  textSize(nodeSize / 2);
  textAlign(CENTER, CENTER);

  for (let rank = 0; rank < N_RANKS; rank++) {

    for (let file = 0; file < N_FILES; file++) {

      text(fileLetters[file] + rankNumbers[rank], file * spacing, rank * spacing);

    }

  }

}

function vertexClips() {

  //  Vertices

  push()
  beginClip();

  fill("#F0F0F0");
  noStroke();

  for (let rank = 0; rank < 8; rank++) {

    for (var file = 0; file < 8; file++) {

      circle(spacing * file, spacing * rank, nodeSize / 2);
      // square(spacing*file - nodeSize / 2, spacing*rank - nodeSize / 2, nodeSize);

    }

  }

  endClip();

}

function drawBoard() {
  push();
  translate(boardX, boardY);

  noFill();
  stroke(0);
  strokeWeight(1);

  fill("#FFFFFF");
  rect(0, 0, boardEdge + spacing * 7 + boardEdge, boardEdge + spacing * 7 + boardEdge, boardCornerRadius);

  // drawPlayerToMove();


  push();
  translate(boardEdge, boardEdge);

  // drawCoordinatesAtEdgeOfBoard();


  // vertexClips();


  // Knight Grids

  let hypotenuse = sqrt(sq(spacing * 2) + sq(spacing * 1));

  // drawGrid(Knight.moveset, nodeSize/2/2/2, nodeSize/2, nodeSize/2);


  // Diagonal Grids
  drawGrid(Bishop.moveset, nodeSize / 2 / 2 / 2, nodeSize / 2, nodeSize / 2, diagonalVertexColoringRule);

  // Main Grid
  drawGrid(Rook.moveset, nodeSize / 2 / 2 / 2, nodeSize / 2, nodeSize / 2, mainVertexColoringRule);

  drawOutgoingLasers();

  drawPiecesOnBoard();

  drawIncomingLasers();

  drawSelection();

  if (coordinatesVisible[FLAG]) {
    drawCoordinatesOnEachVertex();
  }

  if (pawnPromotionSelectionPhase) {
    drawPawnPromotionOptionButtons();
  }



  pop(); // spacing translate

  pop(); // board translate

  if (selectedPly) {
    drawSelectedPlyNotation(mouseX + 10, mouseY + 10);
  }

}


function drawSelection() {

  stroke(colorScheme[positionHistory[currentPlyIndex].playerToMove].selection);
  noFill();
  strokeWeight(1);
  if (hoverNode) {
    circle(spacing * hoverNode.x, spacing * hoverNode.y, nodeSize);
  }

  strokeWeight(5);

  if (departureVertex) {
    circle(spacing * departureVertex.x, spacing * departureVertex.y, nodeSize);
  }

}

function getLaserColor(move, piece) {

  let c = MAIN;
  if (piece.type == KNIGHT) {
    c = KNIGHT_LINES;
  } else if ((move.x != 0) && (move.y != 0)) {

    let diag = diagonalFromNode(piece.file, piece.rank);
    if (diag == 0) {
      c = DIAGONAL_A;
    } else {
      c = DIAGONAL_B;
    }

  }

  return c;

}

function drawOutgoingLasers() {

  noStroke();

  rectMode(CENTER);

  for (let [p, piece] of pieceObjects.all.entries()) {

    let movesets = [piece.constructor.moveset];

    if (piece.type == PAWN) {
      movesets = [
        piece.captureMoveset,
        piece.noncaptureMoveset,
      ]
    }

    for (let moveset of movesets) {

      for (let move of moveset) {

        let file = piece.file;
        let rank = piece.rank;

        let prevFile = file;
        let prevRank = rank;

        for (let segment of piece.lasers[move]) {

          file += move.x;
          rank += move.y;

          let testVector = createVector(file, rank);
          testVector.sub(createVector(piece.file, piece.rank));

          let c = getLaserColor(move, piece);

          if (segment == PLY) {

            let plyVector;
            if (selectedPly) {
              plyVector = createVector(selectedPly.destinationFile, selectedPly.destinationRank);
              plyVector.sub(createVector(selectedPly.departureFile, selectedPly.departureRank));
            }

            if (selectedPly &&
              piece.file == selectedPly.piece.file &&
              piece.rank == selectedPly.piece.rank &&
              testVector.heading() == plyVector.heading() &&
              testVector.mag() <= plyVector.mag()
            ) {

              laserLine(prevFile, prevRank, file, rank, 10, colorScheme[piece.pieceColor].laser[c]);

            } else {

              laserLine(prevFile, prevRank, file, rank, 5, colorScheme[piece.pieceColor].laser[c]);

            }



          } else if (segment == BLOCKED) {
            laserLine(prevFile, prevRank, file, rank, 2, colorScheme[piece.pieceColor].laser[c]);
          }

          prevFile = file;
          prevRank = rank;

        }


      }

    }

  }

}

function drawPiecesOnBoard() {


  // Pieces

  rectMode(CORNER);


  for (let [p, piece] of pieceObjects.all.entries()) {

    push();
    translate(piece.file * spacing, piece.rank * spacing);

    piece.draw();

    // pop(); // mask
    pop(); // piece translate

  }

}

function drawSelectedPlyNotation(x, y) {

  textAlign(LEFT, TOP);
  textSize(30);
  fill(0);
  text(plyNotation(selectedPly, positionHistory[currentPlyIndex]), x, y);

}


function oldLaserNode() {

  let cx = threatNode.x * spacing;
  let cy = threatNode.y * spacing;

  let r = nodeSize * 0.2 / 2;
  if (piece.pieceColor == positionHistory[currentPlyIndex].playerToMove) {
    r = nodeSize * 0.1 / 2;
  }


  let rotateVec = threatNode.copy().sub(createVector(piece.file, piece.rank));

  push();
  translate(cx, cy);
  rotate(rotateVec.heading() + TAU / 4);
  translate(-cx, -cy);


  if (selectedPly &&
    selectedPly.piece.id == piece.id &&
    selectedPly.destinationFile == threatNode.x &&
    selectedPly.destinationRank == threatNode.y
  ) {
    fill(colorScheme[piece.pieceColor].selection);
  } else {
    fill(colorScheme[piece.pieceColor].threat);
  }


  noStroke();


  circle(cx, cy, r * 2);

  // Base point where the drip attaches (bottom of circle)
  let baseX = cx;
  let baseY = cy;

  // How far the drip extends
  let dripLen = nodeSize / 3;
  let tipX = baseX;
  let tipY = baseY + dripLen;

  // Draw drip with bezier curves, sharp at the tip
  beginShape();
  vertex(baseX - r, baseY);               // left attach point
  bezierVertex(baseX - r, baseY,
    tipX, baseY + dripLen / 3, tipX, tipY);   // left curve to tip
  bezierVertex(tipX, baseY + dripLen / 3,
    baseX + r, baseY,
    baseX + r, baseY);          // right curve back up
  endShape(CLOSE);

  strokeWeight(3);

  if (selectedPly &&
    selectedPly.piece.id == piece.id &&
    selectedPly.destinationFile == threatNode.x &&
    selectedPly.destinationRank == threatNode.y
  ) {
    stroke(colorScheme[piece.pieceColor].selection);
  } else {
    stroke(colorScheme[piece.pieceColor].threat);
  }


  line(cx, cy, cx, cy + nodeSize / 2);

  pop();
}


function zipAlternate(a, b) {
  const max = Math.max(a.length, b.length);
  const result = [];

  for (let i = 0; i < max; i++) {
    if (i < a.length) result.push(a[i]);
    if (i < b.length) result.push(b[i]);
  }

  return result;
}


function drawIncomingLasers() {

  let order;

  if (positionHistory[currentPlyIndex].playerToMove == WHITE) {
    order = [BLACK, WHITE];
  } else if (positionHistory[currentPlyIndex].playerToMove == BLACK) {
    order = [WHITE, BLACK];
  }


  for (let file = 0; file < N_FILES; file++) {

    for (let rank = 0; rank < N_RANKS; rank++) {

      combinedLaserNodes = zipAlternate(
        laserNodes[rank][file][order[0]],
        laserNodes[rank][file][order[1]]
      ).reverse();




      let diameter = 10 + 5 * (combinedLaserNodes.length - 1);

      for (let laserNode of combinedLaserNodes) {

        fill(255);

        let piece = laserNode.piece;

        let move = createVector(file - piece.file, rank - piece.rank);

        let c = colorScheme[laserNode.piece.pieceColor].laser[getLaserColor(move, piece)]

        let vec = move.copy().normalize().mult(0.5);


        if (laserNode.status == BLOCKED) {
          laserLine(file, rank, file - vec.x, rank - vec.y, 2, c);
        } else {
          laserLine(file, rank, file - vec.x, rank - vec.y, 5, c);
        }


        stroke(c);
        circle(file * spacing, rank * spacing, diameter);
        diameter -= 5;

      }

    }

  }
}


function drawAnnularSector(x, y, innerR, outerR, startAngle, stopAngle) {
  // Compute number of vertices based on arc length for performance
  let arcLength = stopAngle - startAngle;
  let segments = max(2, Math.ceil(arcLength / 10)); // 1 vertex per ~5 degrees
  let angleStep = arcLength / segments;

  angleMode(RADIANS);

  beginShape();
  // Outer arc
  for (let i = 0; i <= segments; i++) {
    let a = startAngle + i * angleStep;
    let rad = radians(a);
    vertex(x + cos(rad) * outerR, y + sin(rad) * outerR);
  }
  // Inner arc (backwards)
  for (let i = segments; i >= 0; i--) {
    let a = startAngle + i * angleStep;
    let rad = radians(a);
    vertex(x + cos(rad) * innerR, y + sin(rad) * innerR);
  }
  endShape(CLOSE);
}


// Move Table
function drawMoveTable() {

  let rowHeight = 35;

  let pieceScale = rowHeight / spacing;

  let x1 = boardX + boardSidelength + margin * 2;

  let x2 = x1 + rowHeight * 2;

  let columnWidth = rowHeight * 4;

  let y = margin;

  textAlign(LEFT, CENTER);
  textFont("Menlo");
  textSize(rowHeight * 0.5);

  y += rowHeight;
  fill("#000");
  noStroke();
  text("Moves:", x1, y);
  y += rowHeight;


  var flag = false;

  for (let [p, ply] of gamePlies.entries()) {

    let x;
    if (p % 2 == 0) {
      x = x1 + rowHeight * 2;

      let moveNumber = Math.floor(p / 2) + 1;

      text(moveNumber + ".", x1, y);

    } else {
      x = x1 + rowHeight * 2 + columnWidth;
    }

    if (mouseX > x - pieceSize / 2 && mouseX < x - pieceSize / 2 + columnWidth &&
      mouseY > y - rowHeight / 2 && mouseY < y + rowHeight / 2) {

      flag = true;

      if (hoverPlyIndex != p) {
        hoverPlyIndex = p;
        currentPlyIndex = hoverPlyIndex;
        updatePieceObjectsFromPosition(pieceObjects, positionHistory[currentPlyIndex]);
        updatePlyOptions(positionHistory[currentPlyIndex]);
      }



    }

    stroke(0);
    strokeWeight(1);
    fill(255);

    if (p == selectedPlyIndex) {
      strokeWeight(3);
    }

    if (p == hoverPlyIndex) {
      fill(colorScheme[positionHistory[hoverPlyIndex].playerToMove].selection);
    }


    rect(x - pieceSize / 2, y - rowHeight / 2, columnWidth, rowHeight);

    if (ply) {
      push();
      translate(x, y);
      scale(0.35);
      translate(-x, -y);
      ply.piece.draw(x, y);
      pop();
    }

    x += rowHeight * 0.75;

    fill("#000");
    noStroke();

    if (ply.piece) {
      text(plyNotation(ply, positionHistory[p + 1]), x, y);
    } else {
      text("?", x, y);
    }


    y += rowHeight / 2;

  }

  if ((flag == false) && (hoverPlyIndex != -1)) {

    hoverPlyIndex = -1;
    currentPlyIndex = selectedPlyIndex;
    updatePieceObjectsFromPosition(pieceObjects, positionHistory[currentPlyIndex]);
    updatePlyOptions(positionHistory[currentPlyIndex]);

  }


}


// Move Selection
function getMouseHoverNode() {


  for (let file = 0; file < N_FILES; file++) {
    for (let rank = 0; rank < N_RANKS; rank++) {

      if (mouseX > boardX + boardEdge + (file * spacing) - nodeSize / 2 &&
        mouseX < boardX + boardEdge + (file * spacing) + nodeSize / 2 &&
        mouseY > boardY + boardEdge + (rank * spacing) - nodeSize / 2 &&
        mouseY < boardY + boardEdge + (rank * spacing) + nodeSize / 2) {

        return createVector(file, rank);

      }

    }

  }

  return false;


}

function lockInLegalPly(ply) {

  ply.piece = deepCopy(ply.piece);

  if (ply.capturedPiece) {
    ply.capturedPiece = deepCopy(ply.capturedPiece);
  }

  // If current ply is at the end of the ply list
  if (!gamePlies[currentPlyIndex]) {

    gamePlies[currentPlyIndex] = ply;

  }
  // Otherwise (if overwriting existing move)
  else {

    gamePlies.splice(currentPlyIndex, gamePlies.length - currentPlyIndex, ply);


    positionHistory.splice(currentPlyIndex + 1, positionHistory.length - currentPlyIndex);

  }

  gamePlies.push(false);


  let newPosition = structuredClone(positionHistory[currentPlyIndex]);


  newPosition.enPassantTarget = null;
  // lock in legal move if it has been made
  ply.makePly(newPosition);
  playMoveSound(ply.destinationRank, ply.destinationFile);

  swapPlayerToMove(newPosition);
  newPosition.status = getStatus(newPosition);

  // Increment selected ply
  currentPlyIndex++;
  selectedPlyIndex++;

  positionHistory.push(newPosition);

  updatePieceObjectsFromPosition(pieceObjects, positionHistory[currentPlyIndex]);
  updatePlyOptions(positionHistory[currentPlyIndex]);

  // Reset selection
  hoverNode = false;

}

function updateHoverNode() {

  hoverNode = getMouseHoverNode();

  if (hoverNode) {

    if (plyOptions.byNode[hoverNode.y][hoverNode.x] != undefined) {

      let mousePos = createVector(mouseX, mouseY);
      let nodePos = createVector(boardX + boardEdge + spacing * hoverNode.x, boardY + boardEdge + spacing * hoverNode.y);

      strokeWeight(2);
      stroke(0);
      // line(mousePos.x, mousePos.y, nodePos.x, nodePos.y);

      let nodePosToMousePos = mousePos.copy().sub(nodePos);

      let closestPlyOption;
      let closestAngle;

      for (let plyOption of plyOptions.byNode[hoverNode.y][hoverNode.x]) {

        let departureNodePos = createVector(boardX + boardEdge + spacing * plyOption.departureFile, boardY + boardEdge + spacing * plyOption.departureRank);

        // line(nodePos.x, nodePos.y, departureNodePos.x, departureNodePos.y);

        let nodePosToDepartureNodePos = departureNodePos.copy().sub(nodePos);



        let angle = abs(p5.Vector.angleBetween(nodePosToMousePos, nodePosToDepartureNodePos));

        if (!closestPlyOption ||
          angle < closestAngle
        ) {

          closestPlyOption = plyOption;
          closestAngle = angle;
        }

      }

      selectedPly = closestPlyOption;

    }

  } else {

    selectedPly = false;

  }

}

function mouseWheel(event) {

  let targetPlyIndex = selectedPlyIndex + Math.floor(event.delta / 30);

  selectedPlyIndex = Math.min(positionHistory.length - 1, Math.max(0, targetPlyIndex));
  currentPlyIndex = selectedPlyIndex;

  updatePieceObjectsFromPosition(pieceObjects, positionHistory[currentPlyIndex]);
  updatePlyOptions(positionHistory[currentPlyIndex]);

}

function keyPressed() {


  navigator.clipboard.readText().then(txt => {

    try {
      loadGameFromPGN(txt);
    } catch (e) {
      console.error("myFunction error:", e);
    }

  });

}

function mouseClicked() {

  if (hoverPlyIndex != -1) {
    selectedPlyIndex = hoverPlyIndex;
    currentPlyIndex = selectedPlyIndex;
    updatePieceObjectsFromPosition(pieceObjects, positionHistory[currentPlyIndex]);
    updatePlyOptions(positionHistory[currentPlyIndex]);
  }

  for (let button of buttons) {


    if (button.checkIfMouseInside()) {
      button.toggleVariable[FLAG] = !button.toggleVariable[FLAG];
    }

  }

  if (pawnPromotionSelectionPhase) {

    if (pawnPromotionOptionHover) {

      pawnPromotionSelectionPhase = false;
      selectedPly.promotedPiece = pawnPromotionOptionHover;
      pawnPromotionOptionHover = false;

      lockInLegalPly(selectedPly);

    }

  }

  if (!hoverNode) {
    return;
  }

  if (selectedPly) {
    if (selectedPly.pawnPromotion && !selectedPly.promotedPiece) {

      pawnPromotionSelectionPhase = true;

    } else {

      lockInLegalPly(selectedPly);

    }
  }

}

function drawPawnPromotionOptionButtons() {

  strokeWeight(1);
  stroke(colorScheme[positionHistory[currentPlyIndex].playerToMove].selection);

  let margin = 10;
  let boxWidth = spacing * 2 - margin * 2;
  let boxHeight = spacing / 2 - margin / 2;

  let pieceDiameter = boxHeight;



  let pawnToPromote = selectedPly.piece;

  let x = selectedPly.destinationFile * spacing;
  let y = selectedPly.destinationRank * spacing + ((spacing - margin - boxHeight / 2) * pawnToPromote.rankDirection);

  rectMode(CENTER);
  rect(x, y, boxWidth, boxHeight, boardCornerRadius - margin);

  x -= boxWidth / 2 - pieceDiameter / 2;



  pawnPromotionOptionHover = false;
  for (let piece of pawnPromotionPieceOptions[pawnToPromote.pieceColor]) {

    if (dist(boardX + spacing + x, boardY + spacing + y, mouseX, mouseY) <= pieceDiameter / 2) {



      pawnPromotionOptionHover = piece.type;

    }


    push();
    translate(x, y);
    scale(0.35);
    translate(-x, -y);

    piece.draw(x, y);

    pop();

    if (pawnPromotionOptionHover == piece.type) {
      stroke(colorScheme[positionHistory[currentPlyIndex].playerToMove].selection);
      strokeWeight(2);
      circle(x, y, pieceDiameter - 5);

    }


    x += pieceDiameter;

  }

}

function draw() {

  background(255);

  drawBoard();

  if (!pawnPromotionSelectionPhase) {
    updateHoverNode();
  }

  drawMoveTable();

  for (let button of buttons) {

    button.draw();

  }

}