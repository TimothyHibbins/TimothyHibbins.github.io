let matchData;     // Will store the currently displayed match data
let allMatchIds = []; // Will store all unique match IDs from points files

// Cache for points files to avoid re-downloading
let pointsFileCache = {
  'men-2020s': { csvText: null, loaded: false },
  'men-2010s': { csvText: null, loaded: false },
  'men-to-2009': { csvText: null, loaded: false },
  'women-2020s': { csvText: null, loaded: false },
  'women-2010s': { csvText: null, loaded: false },
  'women-to-2009': { csvText: null, loaded: false }
};

let loadingStats = {
  totalFiles: 6, // Only 6 points files needed
  loadedFiles: 0,
  currentFile: '',
  totalMatches: 0
};

// Specify which match to visualize
let matchSpecifier = '20250116-M-Australian_Open-R64-Learner_Tien-Daniil_Medvedev';
let currentMatchId = matchSpecifier;
let currentMatches = [];
let matchesRendered = 0;
const MATCHES_BATCH_SIZE = 50;

let activeSearchField = null;
let currentFacetOptions = [];
let parsedMatchCache = {};
let validatedFields = {}; // Track which fields have validated (exact) values
let searchPlayers = []; // Backend array state - holds up to 2 player names

// Sync the array state to the visual fields
function syncPlayersToUI() {
  let searchPlayer1 = document.getElementById('search-player1');
  let searchPlayer2 = document.getElementById('search-player2');
  let playerFields = document.getElementById('player-fields');
  
  if (!searchPlayer1 || !searchPlayer2) return;
  
  // Update field values
  searchPlayer1.value = searchPlayers[0] || '';
  searchPlayer2.value = searchPlayers[1] || '';
  
  // Update visibility - show player2 field when we have ANY players (so it's ready for the second)
  if (searchPlayers.length > 0) {
    searchPlayer2.classList.remove('player-field-hidden');
    if (playerFields) {
      playerFields.classList.add('player2-visible');
      playerFields.classList.add('player1-has-content');
    }
  } else {
    searchPlayer2.classList.add('player-field-hidden');
    if (playerFields) {
      playerFields.classList.remove('player2-visible');
      playerFields.classList.remove('player1-has-content');
    }
  }
  
  // Update validation styling
  if (validatedFields['search-player1']) {
    searchPlayer1.classList.add('field-validated');
  } else {
    searchPlayer1.classList.remove('field-validated');
  }
  if (validatedFields['search-player2']) {
    searchPlayer2.classList.add('field-validated');
  } else {
    searchPlayer2.classList.remove('field-validated');
  }
}

// Sync UI changes back to the array (for when user types)
function syncUIToPlayers() {
  let searchPlayer1 = document.getElementById('search-player1');
  let searchPlayer2 = document.getElementById('search-player2');
  
  if (!searchPlayer1 || !searchPlayer2) return;
  
  let newPlayers = [];
  if (searchPlayer1.value.trim()) {
    newPlayers.push(searchPlayer1.value.trim());
  }
  if (searchPlayer2.value.trim()) {
    newPlayers.push(searchPlayer2.value.trim());
  }
  
  // Only update the array if it actually changed
  // This prevents clearing validation state unnecessarily
  let arrayChanged = newPlayers.length !== searchPlayers.length || 
    newPlayers.some((player, index) => player !== searchPlayers[index]);
  
  if (arrayChanged) {
    searchPlayers = newPlayers;
  }
}

// Smart player addition from current match clicks
function addPlayerToSearchFromMatch(playerName) {
  // Clear any preview data first
  let searchPlayer1 = document.getElementById('search-player1');
  let searchPlayer2 = document.getElementById('search-player2');
  [searchPlayer1, searchPlayer2].forEach(field => {
    if (field && field.dataset.originalValue !== undefined) {
      delete field.dataset.originalValue;
    }
    if (field) field.style.color = '';
  });
  
  // Don't add if it's already in the array
  if (searchPlayers.includes(playerName)) {
    return;
  }
  
  if (searchPlayers.length === 0) {
    // First player
    searchPlayers = [playerName];
    validatedFields['search-player1'] = true;
    validatedFields['search-player2'] = false; // Ensure player2 not marked as validated
  } else if (searchPlayers.length === 1) {
    // Second player - preserve player1 validation if it was validated
    searchPlayers = [searchPlayers[0], playerName];
    // Keep player1 validation state as is (might already be validated)
    validatedFields['search-player2'] = true;
  } else {
    // Both filled - replace second player, keep player1 validation state
    searchPlayers = [searchPlayers[0], playerName];
    validatedFields['search-player2'] = true;
  }
  
  // Sync to UI and trigger search
  syncPlayersToUI();
  handleSearchInput();
}

let JetBrainsMonoBold;
let dataLoaded = false;
let fullDataLoaded = false;

// Global variables used in visualization (initialized in parseMatchData)
let tennisMatch;
let layers = [];
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
  // Initialize preview tracking variables
  window.currentSelectedMatch = null;
  window.currentlyDisplayedMatch = null;
  
  // Canvas is now 60% width to accommodate search pane
  let canvas = createCanvas(windowWidth * 0.6, windowHeight);
  canvas.parent('sketch-pane');

  // Initialize graphics layers
  layers = [
    createGraphics(windowWidth * 0.6, windowHeight), // 0 - background
    createGraphics(windowWidth * 0.6, windowHeight), // 1 - unused
    createGraphics(windowWidth * 0.6, windowHeight)  // 2 - snake
  ];

  matchX = width / 2, matchY = 50;

  // Parse and display the default match immediately
  parseMatchData();

  // Determine if this is best of 3 or best of 5
  let maxSetsWon = Math.max(tennisMatch.setsInMatchWonByPlayer[1], tennisMatch.setsInMatchWonByPlayer[2]);
  SETS_TO_WIN_MATCH = maxSetsWon; // 2 for best of 3, 3 for best of 5

  // ScoresnakeChart will be created in draw() when needed
  dataLoaded = true;

  // Set up basic search interface with loading message
  setupSearchInterfaceLoading();

  // Update progress to show download is starting
  updateProgress(0, 'Starting download of match databases...');

  // Load all CSV files
  loadAllMatchData();
}

// Unified progress update function
function updateProgress(percent, message) {
  let progressText = document.getElementById('progress-text');
  let progressBar = document.getElementById('progress-bar');
  
  if (progressText) progressText.textContent = message;
  if (progressBar) progressBar.style.width = percent + '%';
}

// Load all match databases
async function loadAllMatchData() {
  try {
    updateProgress(10, 'Loading tennis match database...');
    
    // Define points file URLs - load all of them to get match IDs
    window.pointsFileUrls = {
      'men-2020s': 'https://raw.githubusercontent.com/JeffSackmann/tennis_MatchChartingProject/master/charting-m-points-2020s.csv',
      'men-2010s': 'https://raw.githubusercontent.com/JeffSackmann/tennis_MatchChartingProject/master/charting-m-points-2010s.csv',
      'men-to-2009': 'https://raw.githubusercontent.com/JeffSackmann/tennis_MatchChartingProject/master/charting-m-points-to-2009.csv',
      'women-2020s': 'https://raw.githubusercontent.com/JeffSackmann/tennis_MatchChartingProject/master/charting-w-points-2020s.csv',
      'women-2010s': 'https://raw.githubusercontent.com/JeffSackmann/tennis_MatchChartingProject/master/charting-w-points-2010s.csv',
      'women-to-2009': 'https://raw.githubusercontent.com/JeffSackmann/tennis_MatchChartingProject/master/charting-w-points-to-2009.csv'
    };

    const pointsFiles = [
      { key: 'men-2020s', url: window.pointsFileUrls['men-2020s'], description: 'Men 2020s matches' },
      { key: 'men-2010s', url: window.pointsFileUrls['men-2010s'], description: 'Men 2010s matches' },
      { key: 'men-to-2009', url: window.pointsFileUrls['men-to-2009'], description: 'Men pre-2010 matches' },
      { key: 'women-2020s', url: window.pointsFileUrls['women-2020s'], description: 'Women 2020s matches' },
      { key: 'women-2010s', url: window.pointsFileUrls['women-2010s'], description: 'Women 2010s matches' },
      { key: 'women-to-2009', url: window.pointsFileUrls['women-to-2009'], description: 'Women pre-2010 matches' }
    ];

    // Load all points files and extract match IDs
    for (let i = 0; i < pointsFiles.length; i++) {
      const file = pointsFiles[i];
      
      updateProgress(
        10 + (i / pointsFiles.length) * 80,
        `Loading ${file.description}...`
      );

      const csvText = await downloadCSVFile(file.url);
      
      // Cache the points file for later use
      pointsFileCache[file.key] = {
        csvText: csvText,
        loaded: true
      };
      
      // Extract match IDs from this points file
      const matchIds = extractMatchIdsFromPointsFile(csvText);
      allMatchIds.push(...matchIds);
      
      loadingStats.loadedFiles++;
    }

    // Remove duplicates and sort
    allMatchIds = [...new Set(allMatchIds)].sort();
    loadingStats.totalMatches = allMatchIds.length;
    
    // Data is now fully loaded
    fullDataLoaded = true;
    
    // Set up search interface (now that data is loaded)
    setupSearchInterface();

    updateProgress(
      100,
      `${loadingStats.totalMatches} matches ready (${loadingStats.loadedFiles} files loaded)`
    );

  } catch (error) {
    console.error('Error loading match databases:', error);
    updateProgress(0, 'Error loading match databases');
  }
}

// Extract unique match IDs from a points CSV file
function extractMatchIdsFromPointsFile(csvText) {
  const lines = csvText.split('\n');
  const matchIds = new Set();
  
  // Skip header row
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line) {
      const columns = line.split(',');
      if (columns[0]) {
        matchIds.add(columns[0]);
      }
    }
  }
  
  return Array.from(matchIds);
}

// Download a single CSV file with progress tracking
async function downloadCSVFile(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.text();
}

// Load a specific match by ID from the appropriate CSV source
function loadMatchById(matchId, callback) {
  
  // Determine which period this match belongs to based on date
  const dateStr = matchId.substring(0, 8); // YYYYMMDD
  const year = parseInt(dateStr.substring(0, 4));
  const gender = matchId.includes('-M-') ? 'men' : 'women';
  
  let period;
  if (year >= 2020) {
    period = '2020s';
  } else if (year >= 2010) {
    period = '2010s';
  } else {
    period = 'to-2009';
  }
  
  // Load the points file for this match
  if (!window.pointsFileUrls) {
    console.warn('Points file URLs not yet initialized');
    return;
  }
  const pointsUrl = window.pointsFileUrls[`${gender}-${period}`];
  const cacheKey = `${gender}-${period}`;
  
  if (!pointsUrl) {
    console.error('No points file URL found for:', gender + '-' + period);
    updateProgress(0, 'Error: Points file not available for this time period');
    return;
  }

  // Check cache first
  if (pointsFileCache[cacheKey].loaded) {
    // Use cached data
    extractMatchFromPointsData(matchId, pointsFileCache[cacheKey].csvText, callback);
    return;
  }

  // Download and cache if not already loaded
  fetch(pointsUrl)
    .then(response => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return response.text();
    })
    .then(csvText => {
      // Cache the data
      pointsFileCache[cacheKey] = {
        csvText: csvText,
        loaded: true
      };
      
      extractMatchFromPointsData(matchId, csvText, callback);
    })
    .catch(error => {
      console.error('Error loading points file:', error);
    });
}

// Extract a specific match from points CSV data
function extractMatchFromPointsData(matchId, csvText, callback) {
  const lines = csvText.split('\n');
  const headers = lines[0].split(',');
  
  // Find all lines belonging to this match
  const matchLines = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line) {
      const columns = line.split(',');
      if (columns[0] === matchId) {
        matchLines.push(line);
      }
    }
  }
  
  if (matchLines.length === 0) {
    // Show user-friendly message
    updateProgress(0, `No point-by-point data available for this match. Try another match.`);
    
    // Try to load a random match that has data instead
    setTimeout(() => {
      findAndLoadRandomMatchWithData();
    }, 2000);
    
    return;
  }
  
  // Build table data
  const tableData = headers.join(',') + '\n' + matchLines.join('\n');
  
  loadTable(
    'data:text/csv;charset=utf-8,' + encodeURIComponent(tableData),
    'csv',
    'header',
    function (table) {
      matchData = table;
      if (callback) callback();
    },
    function (error) {
      console.error('Error loading points table:', error);
    }
  );
}

// Helper function to find and load a random match that has actual point data
function findAndLoadRandomMatchWithData() {
  // Try a few recent matches (more likely to have point data)
  const recentMatches = allMatchIds.filter(id => {
    const year = parseInt(id.substring(0, 4));
    return year >= 2020; // Focus on recent matches
  });
  
  if (recentMatches.length === 0) {
    if (allMatchIds.length > 0) {
      const randomMatch = allMatchIds[Math.floor(Math.random() * allMatchIds.length)];
      loadMatch(randomMatch);
    }
    return;
  }
  
  // Try loading a random recent match
  const randomMatch = recentMatches[Math.floor(Math.random() * recentMatches.length)];
  
  // Update progress to show what we're doing
  updateProgress(50, `Searching for match data: ${randomMatch.substring(0, 20)}...`);
  
  loadMatch(randomMatch);
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

// Extract unique match IDs from a points CSV file
function extractMatchIdsFromPointsFile(csvText) {
  const lines = csvText.split('\n');
  const matchIds = new Set();
  
  // Skip header row
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line) {
      const columns = line.split(',');
      if (columns[0]) {
        matchIds.add(columns[0]);
      }
    }
  }
  
  return Array.from(matchIds);
}

function updatePlayer1Width(input, playerFields) {
  if (!input) return;
  let isSplit = playerFields && (playerFields.classList.contains('player2-visible') || playerFields.classList.contains('player1-has-content'));
  if (!isSplit) {
    input.style.width = '';
    return;
  }
  let style = window.getComputedStyle(input);
  if (!input._measureSpan) {
    let span = document.createElement('span');
    span.style.position = 'absolute';
    span.style.visibility = 'hidden';
    span.style.whiteSpace = 'pre';
    span.style.pointerEvents = 'none';
    document.body.appendChild(span);
    input._measureSpan = span;
  }
  let span = input._measureSpan;
  // Copy all computed font and text styles
  span.style.fontFamily = style.fontFamily;
  span.style.fontWeight = style.fontWeight;
  span.style.fontSize = style.fontSize;
  span.style.letterSpacing = style.letterSpacing;
  span.style.fontStyle = style.fontStyle;
  span.style.textTransform = style.textTransform;
  span.style.textDecoration = style.textDecoration;
  span.style.padding = style.padding;
  span.style.border = style.border;
  span.style.boxSizing = style.boxSizing;
  // Only measure the text itself, not the comma or space
  span.textContent = input.value || ' ';
  let width = span.getBoundingClientRect().width;
  // Remove any minimum width, and set width exactly to measured value (no rounding)
  input.style.minWidth = '0';
  input.style.width = width + 'px';
}

function syncPlayer2Visibility(searchPlayer1, searchPlayer2, playerFields) {
  if (!searchPlayer1 || !searchPlayer2) return;
  if (searchPlayer1.value.trim() === '') {
    searchPlayer2.value = '';
    syncUIToPlayers(); // Sync to backend array
    searchPlayer2.classList.add('player-field-hidden');
    if (playerFields) {
      playerFields.classList.remove('player2-visible');
      playerFields.classList.remove('player1-has-content');
    }
  } else {
    if (playerFields) playerFields.classList.add('player1-has-content');
  }
  updatePlayer1Width(searchPlayer1, playerFields);
}

function updateMatchDisplay(matchId) {
  let displayElement = document.getElementById('match-display');
  if (displayElement) {
    displayElement.innerHTML = '';
    displayElement.appendChild(createMatchRow(matchId, true)); // true = current match display
  }
}

function renderNextMatchBatch(dropdown) {
  if (!dropdown || matchesRendered >= currentMatches.length) return;

  let searchDateYear = document.getElementById('search-date-year');
  let searchTournament = document.getElementById('search-tournament');
  let searchPlayer1 = document.getElementById('search-player1');
  let searchPlayer2 = document.getElementById('search-player2');
  let playerFields = document.getElementById('player-fields');

  let nextChunk = currentMatches.slice(matchesRendered, matchesRendered + MATCHES_BATCH_SIZE);
  nextChunk.forEach(matchId => {
    let item = document.createElement('div');
    item.className = 'dropdown-item dropdown-item-match';
    item.appendChild(createMatchRow(matchId, false)); // false = dropdown item

    item.addEventListener('mouseenter', function () {
      previewMatch(matchId);
    });

    // Remove individual mouseleave - handled at container level to prevent flicker

    item.addEventListener('click', function () {
      // Set this as the selected match
      window.currentSelectedMatch = matchId;
      window.currentlyDisplayedMatch = matchId;
      loadMatch(matchId);
      if (searchDateYear) searchDateYear.value = '';
      if (searchTournament) searchTournament.value = '';
      if (searchPlayer1) {
        searchPlayer1.value = '';
        syncUIToPlayers(); // Sync to backend array
      }
      if (searchPlayer2) {
        searchPlayer2.value = '';
        syncUIToPlayers(); // Sync to backend array
        searchPlayer2.classList.add('player-field-hidden');
      }
      if (playerFields) playerFields.classList.remove('player2-visible');
      handleSearchInput();
    });

    dropdown.appendChild(item);
  });

  matchesRendered += nextChunk.length;
}

const ROUND_PATTERN = /^(F|SF|QF|R\d{1,3}|RR\d?|BR|Q\d|ER)$/i;

// Round selector constants
const ROUND_ORDER = ['Q1', 'Q2', 'Q3', 'R128', 'R64', 'R32', 'R16', 'QF', 'SF', 'F'];
const ROUND_FULL_NAMES = {
  'Q1': 'Qualifying R1',
  'Q2': 'Qualifying R2',
  'Q3': 'Qualifying R3',
  'R128': 'Round of 128',
  'R64': 'Round of 64',
  'R32': 'Round of 32',
  'R16': 'Round of 16',
  'QF': 'Quarterfinals',
  'SF': 'Semifinals',
  'F': 'Final'
};

// State for round selector: which minimum round is selected, and whether "other" is included
let roundSelectorMin = 'Q1'; // default: include all standard rounds including qualies
let roundOtherEnabled = true;  // default: include "other" rounds too

function getRoundFullName(roundCode) {
  if (!roundCode) return '';
  let upper = roundCode.toUpperCase();
  if (ROUND_FULL_NAMES[upper]) return ROUND_FULL_NAMES[upper];
  // For other round types, provide descriptive names
  if (/^RR\d?$/i.test(roundCode)) return 'Round Robin';
  if (/^BR$/i.test(roundCode)) return 'Bronze Medal';
  if (/^ER$/i.test(roundCode)) return 'Early Round';
  return roundCode;
}

function isStandardRound(roundCode) {
  return ROUND_ORDER.includes(roundCode.toUpperCase());
}

function roundPassesFilter(roundCode) {
  if (!roundCode) return true;
  let upper = roundCode.toUpperCase();
  if (isStandardRound(upper)) {
    let minIndex = ROUND_ORDER.indexOf(roundSelectorMin);
    let roundIndex = ROUND_ORDER.indexOf(upper);
    return roundIndex >= minIndex;
  } else {
    // Non-standard round: only passes if "Other" is enabled
    return roundOtherEnabled;
  }
}

function updateRoundSelectorUI() {
  let buttons = document.querySelectorAll('#round-selector .round-btn:not(.round-other)');
  let otherBtn = document.querySelector('#round-selector .round-other');
  let minIndex = ROUND_ORDER.indexOf(roundSelectorMin);
  
  buttons.forEach(btn => {
    let round = btn.dataset.round;
    let index = ROUND_ORDER.indexOf(round);
    btn.classList.remove('round-active', 'round-in-range');
    if (index === minIndex) {
      btn.classList.add('round-active');
    } else if (index > minIndex) {
      btn.classList.add('round-in-range');
    }
  });
  
  if (otherBtn) {
    otherBtn.classList.remove('round-active', 'round-in-range');
    if (roundOtherEnabled) {
      otherBtn.classList.add('round-in-range');
    }
  }
}

function parseMatchId(matchId) {
  if (!matchId) return null;
  if (parsedMatchCache[matchId]) return parsedMatchCache[matchId];

  let parts = matchId.split('-');
  if (parts.length < 4) return null;

  let date = parts[0] || '';
  let year = date.slice(0, 4);
  let month = date.slice(4, 6);
  let day = date.slice(6, 8);
  let gender = parts[1] || '';

  // Find the round by scanning from index 2 for a known round pattern
  let roundIndex = -1;
  for (let i = 2; i < parts.length; i++) {
    if (ROUND_PATTERN.test(parts[i])) {
      roundIndex = i;
      break;
    }
  }

  if (roundIndex === -1) {
    // Fallback: assume tournament=parts[2], round=parts[3], rest are players
    let tournament = parts[2] || '';
    let round = parts[3] || '';
    let player1 = parts[4] || '';
    let player2 = parts.slice(5).join('-') || '';
    let result = { year, month, day, gender, tournament, round, player1, player2 };
    parsedMatchCache[matchId] = result;
    return result;
  }

  let tournament = parts.slice(2, roundIndex).join('-');
  let round = parts[roundIndex];

  // Split remaining parts into player1 and player2
  let playerParts = parts.slice(roundIndex + 1);
  let player1 = '';
  let player2 = '';

  if (playerParts.length === 0) {
    // No players
  } else if (playerParts.length === 1) {
    player1 = playerParts[0];
  } else if (playerParts.length === 2 && playerParts[0].includes('_') && playerParts[1].includes('_')) {
    // Simple common case: First_Last-First_Last
    player1 = playerParts[0];
    player2 = playerParts[1];
  } else {
    // Complex case: accumulate parts for player1 until we have an underscore,
    // then the next part with an underscore starts player2
    let accumulated = [];
    let foundFirstPlayerUnderscore = false;
    let splitIndex = playerParts.length; // default: all parts are player1

    for (let i = 0; i < playerParts.length; i++) {
      accumulated.push(playerParts[i]);
      if (!foundFirstPlayerUnderscore) {
        if (accumulated.join('-').includes('_')) {
          foundFirstPlayerUnderscore = true;
        }
      } else {
        // Already found player1's underscore; if this part has underscore, it starts player2
        if (playerParts[i].includes('_')) {
          splitIndex = i;
          break;
        }
      }
    }

    player1 = playerParts.slice(0, splitIndex).join('-');
    player2 = playerParts.slice(splitIndex).join('-');
  }

  let result = { year, month, day, gender, tournament, round, player1, player2 };
  parsedMatchCache[matchId] = result;
  return result;
}

function createMatchRow(matchId, isCurrentMatch = false) {
  let data = getMatchMetadata(matchId);
  let row = document.createElement('div');
  row.className = 'match-row';

  if (!data) {
    let fallback = document.createElement('div');
    fallback.className = 'match-cell';
    fallback.textContent = matchId;
    row.appendChild(fallback);
    return row;
  }

  // Extract consistent data from summary or parsed match ID
  let date = data.Date || (data.year + data.month + data.day);
  let year = date.slice(0, 4);
  let month = date.slice(4, 6);
  let day = date.slice(6, 8);
  let gender = data.match_id ? (data.match_id.includes('-M-') ? 'M' : 'W') : data.gender;
  let tournament = (data.Tournament || data.tournament || '').replace(/_/g, ' ');
  let round = data.Round || data.round || '';
  let player1 = (data['Player 1'] || data.player1 || '').replace(/_/g, ' ');
  let player2 = (data['Player 2'] || data.player2 || '').replace(/_/g, ' ');

  let dateCell = document.createElement('div');
  dateCell.className = 'date-container match-date';
  dateCell.dataset.field = 'date';
  dateCell.dataset.year = year;
  dateCell.style.cursor = 'pointer';
  
  // Add hover highlighting and custom tooltip only for current match display
  if (isCurrentMatch) {
    dateCell.addEventListener('mouseenter', function(e) {
      if (!fullDataLoaded) return; // Prevent permanent previews before data loads
      showCustomTooltip(e, 'Click to fill date field');
      highlightMatchField(dateCell, 'date');
      previewFieldValue('search-date-year', year);
    });
    dateCell.addEventListener('mouseleave', function() {
      hideCustomTooltip();
      unhighlightMatchField(dateCell, 'date');
      clearFieldPreviews(['search-date-year']);
    });
  }
  
  dateCell.addEventListener('click', function() {
    // Clear any preview data first
    let field = document.getElementById('search-date-year');
    if (field && field.dataset.originalValue !== undefined) {
      delete field.dataset.originalValue;
    }
    if (field) field.style.color = '';
    
    // Set the actual value
    document.getElementById('search-date-year').value = year;
    // Mark date field as validated and add styling
    validatedFields['search-date-year'] = true;
    document.getElementById('search-date-year').classList.add('field-validated');
    handleSearchInput();
  });

  let yearSpan = document.createElement('span');
  yearSpan.className = 'match-date-part year';
  yearSpan.textContent = year;

  dateCell.appendChild(yearSpan);
  row.appendChild(dateCell);

  let tournamentCell = document.createElement('div');
  tournamentCell.className = 'match-cell';
  tournamentCell.dataset.field = 'tournament';
  tournamentCell.dataset.value = tournament.replace(/ /g, '_');
  tournamentCell.style.cursor = 'pointer';

  let tournamentText = document.createElement('span');
  tournamentText.textContent = tournament;
  tournamentCell.appendChild(tournamentText);

  // Append round description in italic
  if (round) {
    let roundDesc = document.createElement('span');
    roundDesc.className = 'round-description';
    roundDesc.textContent = getRoundFullName(round);
    tournamentCell.appendChild(roundDesc);
  }
  
  // Add hover highlighting and custom tooltip only for current match display
  if (isCurrentMatch) {
    tournamentCell.addEventListener('mouseenter', function(e) {
      if (!fullDataLoaded) return; // Prevent permanent previews before data loads
      showCustomTooltip(e, 'Click to fill tournament field');
      highlightMatchField(tournamentCell, 'tournament');
      previewFieldValue('search-tournament', tournament);
    });
    tournamentCell.addEventListener('mouseleave', function() {
      hideCustomTooltip();
      unhighlightMatchField(tournamentCell, 'tournament');
      clearFieldPreviews(['search-tournament']);
    });
  }
  
  tournamentCell.addEventListener('click', function() {
    // Clear any preview data first
    let field = document.getElementById('search-tournament');
    if (field.dataset.originalValue !== undefined) {
      delete field.dataset.originalValue;
    }
    field.style.color = '';
    
    // Set the actual value
    field.value = tournament;
    // Mark tournament field as validated and add styling
    validatedFields['search-tournament'] = true;
    field.classList.add('field-validated');
    handleSearchInput();
  });
  row.appendChild(tournamentCell);

  let players = document.createElement('div');
  players.className = 'match-cell match-players';
  players.style.position = 'relative';

  let player1Span = document.createElement('span');
  player1Span.className = 'match-player';
  player1Span.textContent = player1;
  player1Span.dataset.field = 'player1';
  player1Span.dataset.value = player1.replace(/ /g, '_');

  let sep = document.createElement('span');
  sep.className = 'player-sep';
  sep.textContent = ' vs ';

  let player2Span = document.createElement('span');
  player2Span.className = 'match-player';
  player2Span.textContent = player2;
  player2Span.dataset.field = 'player2';
  player2Span.dataset.value = player2.replace(/ /g, '_');

  players.appendChild(player1Span);
  players.appendChild(sep);
  players.appendChild(player2Span);

  // Add hover areas only for current match display
  if (isCurrentMatch) {
    // Calculate the position of 'vs' to split hover areas properly  
    let sepWidth = sep.offsetWidth || 20; // fallback width
    let player1Width = player1Span.offsetWidth || 100;
    let vsStart = player1Width + 4; // 4px for any spacing
    let vsCenter = vsStart + (sepWidth / 2);
    let leftWidth = `${vsCenter}px`;
    let rightStart = `${vsCenter}px`;
    
    // Create invisible overlay for left half (player 1)
    let player1Overlay = document.createElement('div');
    player1Overlay.style.position = 'absolute';
    player1Overlay.style.left = '0';
    player1Overlay.style.top = '0';
    player1Overlay.style.width = leftWidth;
    player1Overlay.style.height = '100%';
    player1Overlay.style.cursor = 'pointer';
    player1Overlay.style.zIndex = '1';
    
    player1Overlay.addEventListener('mouseenter', function(e) {
      if (!fullDataLoaded) return; // Prevent permanent previews before data loads
      
      showCustomTooltip(e, 'Click to add player');
      highlightMatchField(player1Span, 'player1');
      
      let searchPlayer1 = document.getElementById('search-player1');
      let searchPlayer2 = document.getElementById('search-player2');
      
      // Check for duplicates - allow highlight/tooltip but prevent preview
      let isDuplicate = searchPlayers.some(p => 
        p.toLowerCase().replace(/\s+/g, '_') === player1.toLowerCase().replace(/\s+/g, '_')
      );
      
      if (!isDuplicate) {
        // Only show preview if not duplicate
        if (!searchPlayer1.value.trim()) {
          previewFieldValue('search-player1', player1);
        } else if (!searchPlayer2.value.trim()) {
          previewFieldValue('search-player2', player1);
        } else {
          previewFieldValue('search-player2', player1);
        }
      }
    });
    player1Overlay.addEventListener('mouseleave', function() {
      hideCustomTooltip();
      unhighlightMatchField(player1Span, 'player1');
      clearFieldPreviews(['search-player1', 'search-player2']);
    });
    player1Overlay.addEventListener('click', function() {
      addPlayerToSearchFromMatch(player1);
    });
    
    // Create invisible overlay for right half (player 2)
    let player2Overlay = document.createElement('div');
    player2Overlay.style.position = 'absolute';
    player2Overlay.style.left = rightStart;
    player2Overlay.style.top = '0';
    player2Overlay.style.right = '0';
    player2Overlay.style.height = '100%';
    player2Overlay.style.cursor = 'pointer';
    player2Overlay.style.zIndex = '1';
    
    player2Overlay.addEventListener('mouseenter', function(e) {
      if (!fullDataLoaded) return; // Prevent permanent previews before data loads
      
      showCustomTooltip(e, 'Click to add player');
      highlightMatchField(player2Span, 'player2');
      
      let searchPlayer1 = document.getElementById('search-player1');
      let searchPlayer2 = document.getElementById('search-player2');
      
      // Check for duplicates - allow highlight/tooltip but prevent preview
      let isDuplicate = searchPlayers.some(p => 
        p.toLowerCase().replace(/\s+/g, '_') === player2.toLowerCase().replace(/\s+/g, '_')
      );
      
      if (!isDuplicate) {
        // Only show preview if not duplicate
        if (!searchPlayer1.value.trim()) {
          previewFieldValue('search-player1', player2);
        } else if (!searchPlayer2.value.trim()) {
          previewFieldValue('search-player2', player2);
        } else {
          previewFieldValue('search-player2', player2);
        }
      }
    });
    player2Overlay.addEventListener('mouseleave', function() {
      hideCustomTooltip();
      unhighlightMatchField(player2Span, 'player2');
      clearFieldPreviews(['search-player1', 'search-player2']);
    });
    player2Overlay.addEventListener('click', function() {
      addPlayerToSearchFromMatch(player2);
    });
    
    // Create invisible overlay for middle "vs" area (both players)
    let vsOverlay = document.createElement('div');
    vsOverlay.style.position = 'absolute';
    vsOverlay.style.left = '0';
    vsOverlay.style.top = '0';
    vsOverlay.style.right = '0';
    vsOverlay.style.height = '100%';
    vsOverlay.style.cursor = 'pointer';
    vsOverlay.style.zIndex = '2'; // Higher than individual overlays
    vsOverlay.style.pointerEvents = 'none'; // Initially disabled
    
    // Only enable vs overlay in the middle "vs" area
    let enableVsOverlay = function() {
      let sepRect = sep.getBoundingClientRect();
      let playersRect = players.getBoundingClientRect();
      let sepLeft = sepRect.left - playersRect.left;
      let sepRight = sepRect.right - playersRect.left;
      
      vsOverlay.style.left = `${sepLeft}px`;
      vsOverlay.style.width = `${sepRight - sepLeft}px`;
      vsOverlay.style.pointerEvents = 'auto';
    };
    
    vsOverlay.addEventListener('mouseenter', function(e) {
      if (!fullDataLoaded) return; // Prevent permanent previews before data loads
      
      // Always allow vs hover - clicking will overwrite both fields anyway
      showCustomTooltip(e, 'Click to add both players');
      highlightMatchField(player1Span, 'player1');
      highlightMatchField(player2Span, 'player2');
      
      // Preview players without adding extra "vs" (UI already shows vs)
      previewFieldValue('search-player1', player1);
      previewFieldValue('search-player2', player2);
    });
    
    vsOverlay.addEventListener('mouseleave', function() {
      hideCustomTooltip();
      unhighlightMatchField(player1Span, 'player1');
      unhighlightMatchField(player2Span, 'player2');
      clearFieldPreviews(['search-player1', 'search-player2']);
    });
    
    vsOverlay.addEventListener('click', function() {
      // Clear any preview data first
      let searchPlayer1 = document.getElementById('search-player1');
      let searchPlayer2 = document.getElementById('search-player2');
      
      [searchPlayer1, searchPlayer2].forEach(field => {
        if (field && field.dataset.originalValue !== undefined) {
          delete field.dataset.originalValue;
        }
        if (field) field.style.color = '';
      });
      
      // Set both players - p1 in first field, p2 in second field 
      searchPlayer1.value = player1;
      searchPlayer2.value = player2;
      
      // Make sure player2 field is visible
      let playerFields = document.getElementById('player-fields');
      searchPlayer2.classList.remove('player-field-hidden');
      if (playerFields) playerFields.classList.add('player2-visible');
      
      // Update backend array to match both players
      searchPlayers = [player1, player2];
      syncPlayersToUI();
      
      // Mark both player fields as validated
      validatedFields['search-player1'] = true;
      validatedFields['search-player2'] = true;
      searchPlayer1.classList.add('field-validated');
      searchPlayer2.classList.add('field-validated');
      
      handleSearchInput();
    });
    
    // Add overlays after a brief delay to ensure proper sizing
    setTimeout(() => {
      // Recalculate positions after DOM has settled
      let sepRect = sep.getBoundingClientRect();
      let playersRect = players.getBoundingClientRect();
      let sepCenterFromLeft = (sepRect.left + sepRect.width/2) - playersRect.left;
      
      player1Overlay.style.width = `${sepCenterFromLeft}px`;
      player2Overlay.style.left = `${sepCenterFromLeft}px`;
      
      players.appendChild(player1Overlay);
      players.appendChild(player2Overlay);
      
      // Enable and add vs overlay
      enableVsOverlay();
      players.appendChild(vsOverlay);
    }, 1);
  }

  row.appendChild(players);

  return row;
}

// Custom tooltip system
function showCustomTooltip(event, text) {
  const tooltip = document.getElementById('custom-tooltip');
  if (!tooltip) return;
  
  tooltip.textContent = text;
  tooltip.classList.remove('hidden');
  
  // Position tooltip near cursor
  const rect = event.target.getBoundingClientRect();
  tooltip.style.left = (rect.left + rect.width / 2) + 'px';
  tooltip.style.top = (rect.top - 35) + 'px';
}

function hideCustomTooltip() {
  const tooltip = document.getElementById('custom-tooltip');
  if (!tooltip) return;
  
  tooltip.classList.add('hidden');
}

// Match field highlighting system
function highlightMatchField(element, fieldType) {
  // Highlight the match field element text only
  element.style.color = '#4ade80';  // green-400
  
  // Highlight corresponding search label text
  const labels = document.querySelectorAll('.search-label');
  let labelIndex;
  
  switch(fieldType) {
    case 'date': labelIndex = 0; break;
    case 'tournament': labelIndex = 1; break;
    case 'round': labelIndex = 2; break;
    case 'player1':
    case 'player2': labelIndex = 3; break;
  }
  
  if (labels[labelIndex]) {
    labels[labelIndex].style.color = '#4ade80';
  }
}

function unhighlightMatchField(element, fieldType) {
  // Remove highlight from match field element
  element.style.color = '';
  
  // Remove highlight from corresponding search label
  const labels = document.querySelectorAll('.search-label');
  let labelIndex;
  
  switch(fieldType) {
    case 'date': labelIndex = 0; break;
    case 'tournament': labelIndex = 1; break;
    case 'round': labelIndex = 2; break;
    case 'player1':
    case 'player2': labelIndex = 3; break;
  }
  
  if (labels[labelIndex]) {
    labels[labelIndex].style.color = '';
  }
}

// Field preview system for search inputs
function previewFieldValue(fieldId, value) {
  const field = document.getElementById(fieldId);
  if (!field) return;
  
  // Store original value if not already stored
  if (!field.dataset.originalValue) {
    field.dataset.originalValue = field.value;
  }
  
  // Show preview value
  field.value = value;
  field.style.color = 'rgba(74, 222, 128, 0.6)';
  
  // Special handling for player2 field - make it visible if previewing
  if (fieldId === 'search-player2') {
    let searchPlayer2 = document.getElementById('search-player2');
    let playerFields = document.getElementById('player-fields');
    if (searchPlayer2 && searchPlayer2.classList.contains('player-field-hidden')) {
      // Store original visibility state
      if (!searchPlayer2.dataset.originallyHidden) {
        searchPlayer2.dataset.originallyHidden = 'true';
      }
      // Make visible for preview
      searchPlayer2.classList.remove('player-field-hidden');
      if (playerFields) playerFields.classList.add('player2-visible');
    }
  }
  
  // For player fields, bypass the normal handleSearchInput to avoid array sync override
  if (fieldId === 'search-player1' || fieldId === 'search-player2') {
    // Directly trigger search logic without syncing
    triggerSearchWithCurrentValues();
  } else {
    // Trigger search update for preview
    handleSearchInput();
  }
}

function clearFieldPreviews(fieldIds) {
  fieldIds.forEach(fieldId => {
    const field = document.getElementById(fieldId);
    if (!field) return;
    
    // Restore original value
    if (field.dataset.originalValue !== undefined) {
      field.value = field.dataset.originalValue;
      delete field.dataset.originalValue;
    }
    
    // Reset text color
    field.style.color = '';
    
    // Special handling for player2 field - restore visibility if it was originally hidden
    if (fieldId === 'search-player2' && field.dataset.originallyHidden) {
      let playerFields = document.getElementById('player-fields');
      field.classList.add('player-field-hidden');
      if (playerFields) playerFields.classList.remove('player2-visible');
      delete field.dataset.originallyHidden;
    }
  });
  
  // Trigger search update after clearing previews
  handleSearchInput();
}

// Add debouncing for preview
let previewTimeout = null;
let currentPreviewMatch = null;

// Preview match on hover - temporarily update visualization only
function previewMatch(matchId) {
  // Clear any existing preview timeout
  if (previewTimeout) {
    clearTimeout(previewTimeout);
  }
  
  // Don't re-preview the same match
  if (currentPreviewMatch === matchId) {
    return;
  }
  
  // Debounce the preview to avoid rapid-fire hovers
  previewTimeout = setTimeout(() => {
    currentPreviewMatch = matchId;
    
    // Store current state for restoration
    if (!window.currentSelectedMatch) {
      window.currentSelectedMatch = currentMatchId;
    }
    
    // Load and display the match temporarily (don't change currentMatchId)
    loadMatchById(matchId, () => {
      // Check if this is still the match we want to preview (avoid race conditions)
      if (currentPreviewMatch === matchId && matchData && matchData.getRowCount() > 0) {
        try {
          // Parse and create temporary visualization
          parseMatchData();
          if (tennisMatch) {
            currentScoresnake = new ScoresnakeChart();
            currentScoresnake.update(tennisMatch);
            redraw();
          }
        } catch (e) {
          console.warn('Preview failed for match:', matchId, e.message);
        }
      }
    });
  }, 50); // Fast preview since CSV is cached
}

// Revert to the selected match when hover ends
function stopPreview() {
  currentPreviewMatch = null;
  if (previewTimeout) {
    clearTimeout(previewTimeout);
    previewTimeout = null;
  }
  
  // Restore the originally selected match visualization
  if (window.currentSelectedMatch) {
    loadMatchById(window.currentSelectedMatch, () => {
      // Check if we're still in "restore" mode (no active preview)
      if (currentPreviewMatch === null && matchData && matchData.getRowCount() > 0) {
        parseMatchData();
        if (tennisMatch) {
          currentScoresnake = new ScoresnakeChart();
          currentScoresnake.update(tennisMatch);
          redraw();
        }
      }
    });
  }
}

// Lightweight display update for previews
function updateMatchDisplayInfo(matchId, metadata) {
  let displayElement = document.getElementById('match-display');
  if (displayElement) {
    displayElement.innerHTML = '';
    displayElement.appendChild(createMatchRow(matchId, true)); // true = current match display
  }
}

// Update the tennis match visualization
function updateMatchVisualization() {
  if (matchData && typeof parseMatchData === 'function') {
    try {
      parseMatchData();
      
      // Create new scoresnake chart with match data
      if (tennisMatch) {
        currentScoresnake = new ScoresnakeChart();
        currentScoresnake.update(tennisMatch);
      }
      
      redraw(); // Trigger p5.js redraw
    } catch (error) {
      console.error('Error updating match visualization:', error);
    }
  }
}

function setupSearchInterfaceLoading() {
  let searchDateYear = document.getElementById('search-date-year');
  let searchTournament = document.getElementById('search-tournament');
  let searchPlayer1 = document.getElementById('search-player1');
  let searchPlayer2 = document.getElementById('search-player2');
  let playerFields = document.getElementById('player-fields');
  let loadingIndicator = document.getElementById('loading-indicator');
  let searchScroll = document.getElementById('search-scroll');
  let dropdown = document.getElementById('dropdown');
  let matchDisplay = document.getElementById('match-display');

  // Show loading indicator
  updateMatchDisplay(matchSpecifier);
  loadingIndicator.classList.remove('loading-hidden');

  if (dropdown) {
    dropdown.classList.remove('dropdown-hidden');
    dropdown.innerHTML = '';
    // Just show loading message during setup - actual matches shown after data loads
    const emptyMsg = document.createElement('div');
    emptyMsg.className = 'dropdown-empty-message';
    emptyMsg.textContent = 'Loading matches...';
    dropdown.appendChild(emptyMsg);
  }

  if (searchPlayer1) {
    updatePlayer1Width(searchPlayer1, playerFields);
    searchPlayer1.addEventListener('input', function () {
      syncPlayer2Visibility(searchPlayer1, searchPlayer2, playerFields);
      updatePlayer1Width(searchPlayer1, playerFields);
      // Refresh player2 dropdown if it's focused to show updated excluded options
      if (activeSearchField === 'search-player2' && dropdown && matchCountBar && matchCountText) {
        renderFacetedDropdown('search-player2', dropdown, matchCountBar, matchCountText);
      }
    });
    syncPlayer2Visibility(searchPlayer1, searchPlayer2, playerFields);
    updatePlayer1Width(searchPlayer1, playerFields);
  }

  if (searchPlayer2) {
    searchPlayer2.addEventListener('input', function () {
      // Refresh player1 dropdown if it's focused to show updated excluded options
      if (activeSearchField === 'search-player1' && dropdown && matchCountBar && matchCountText) {
        renderFacetedDropdown('search-player1', dropdown, matchCountBar, matchCountText);
      }
    });
  }

  if (searchScroll && dropdown && matchDisplay) {
    let syncScroll = () => {
      let left = searchScroll.scrollLeft;
      dropdown.scrollLeft = left;
      matchDisplay.scrollLeft = left;
    };

    searchScroll.addEventListener('scroll', syncScroll);
    syncScroll();
  }

  if (dropdown) {
    dropdown.addEventListener('mouseleave', function () {
      if (currentMatchId) {
        previewMatch(currentMatchId);
      }
    });

    dropdown.addEventListener('scroll', function () {
      let nearBottom = dropdown.scrollTop + dropdown.clientHeight >= dropdown.scrollHeight - 40;
      if (nearBottom) {
        renderNextMatchBatch(dropdown);
      }
    });
  }

  if (matchDisplay) {
    matchDisplay.addEventListener('click', function (e) {
      let dateCell = e.target.closest('.match-date');
      let cell = e.target.closest('.match-cell, .match-player');

      if (dateCell && dateCell.dataset.field === 'date') {
        if (searchDateYear) searchDateYear.value = dateCell.dataset.year || '';
        handleSearchInput();
        return;
      }

      if (cell && cell.dataset.field) {
        let field = cell.dataset.field;
        if (field === 'tournament' && searchTournament) {
          searchTournament.value = (cell.dataset.value || '').replace(/_/g, ' ');
        } else if (field === 'player1' && searchPlayer1) {
          searchPlayer1.value = (cell.dataset.value || '').replace(/_/g, ' ');
          syncUIToPlayers(); // Sync to backend array
        } else if (field === 'player2' && searchPlayer2) {
          let value = (cell.dataset.value || '').replace(/_/g, ' ');
          if (searchPlayer1 && searchPlayer1.value.trim() === '') {
            searchPlayer1.value = value;
            syncUIToPlayers(); // Sync to backend array
            updatePlayer1Width(searchPlayer1, playerFields);
          } else {
            searchPlayer2.value = value;
            syncUIToPlayers(); // Sync to backend array
            searchPlayer2.classList.remove('player-field-hidden');
            if (playerFields) playerFields.classList.add('player2-visible');
            updatePlayer1Width(searchPlayer1, playerFields);
          }
          syncPlayer2Visibility(searchPlayer1, searchPlayer2, playerFields);
        }
        handleSearchInput();
      }
    });
  }


  // Set up date field auto-advance
  function setupDateFieldAutoAdvance(field, nextField, prevField, maxLength) {
    // Helper function to auto-complete field value
    function completeFieldValue() {
      if (field.id === 'search-date-year' && field.value.length === 2) {
        field.value = '20' + field.value;
      }
    }

    field.addEventListener('input', function (e) {
      // Remove spaces
      this.value = this.value.replace(/\s/g, '');

      // Auto-advance when filled
      if (this.value.length === maxLength && nextField) {
        nextField.focus();
      }
    });

    field.addEventListener('keydown', function (e) {
      // Prevent space
      if (e.key === ' ') {
        e.preventDefault();
        completeFieldValue();
        if (nextField) nextField.focus();
      }
      // Tab also advances
      if (e.key === 'Tab' && !e.shiftKey && nextField) {
        e.preventDefault();
        completeFieldValue();
        nextField.focus();
      }
      // Enter completes and advances
      if (e.key === 'Enter' && nextField) {
        e.preventDefault();
        completeFieldValue();
        nextField.focus();
      }
    });

    // Also complete when field loses focus
    field.addEventListener('blur', function () {
      completeFieldValue();
    });
  }

  // Use window event listener to handle arrow keys for all search fields
  window.addEventListener('keydown', function (e) {
    // Define all search fields in order
    const searchFields = [
      searchDateYear,
      searchTournament,
      searchPlayer1,
      searchPlayer2 && !searchPlayer2.classList.contains('player-field-hidden') ? searchPlayer2 : null
    ].filter(Boolean);

    // Check if current target is one of our search fields
    const currentIndex = searchFields.findIndex(field => field === e.target);
    if (currentIndex === -1) return; // Not a search field, ignore

    const currentField = searchFields[currentIndex];
    const nextField = searchFields[currentIndex + 1] || null;
    const prevField = searchFields[currentIndex - 1] || null;

    // Helper to auto-complete date field values
    function completeDateField(field) {
      if (field.id === 'search-date-year' && field.value.length === 2) {
        field.value = '20' + field.value;
      }
    }

    // Arrow keys for empty fields
    if ((e.key === 'ArrowRight' || e.key === 'Right') && currentField.value.length === 0 && nextField) {
      e.preventDefault();
      e.stopPropagation();
      nextField.focus();
      return;
    }
    if ((e.key === 'ArrowLeft' || e.key === 'Left') && currentField.value.length === 0 && prevField) {
      e.preventDefault();
      e.stopPropagation();
      prevField.focus();
      return;
    }

    // Arrow right on non-empty date fields - complete and advance
    if ((e.key === 'ArrowRight' || e.key === 'Right') &&
      currentField.id === 'search-date-year' &&
      currentField.value.length > 0 && nextField) {
      e.preventDefault();
      e.stopPropagation();
      completeDateField(currentField);
      nextField.focus();
      return;
    }
  });

  // Set up year field auto-completion
  if (searchDateYear) {
    searchDateYear.addEventListener('input', function (e) {
      // Remove spaces
      this.value = this.value.replace(/\s/g, '');

      // Auto-complete 2-digit year to 20XX
      if (this.value.length === 2) {
        this.value = '20' + this.value;
        // Auto-advance to tournament field
        if (searchTournament) {
          searchTournament.focus();
        }
      }
    });
  }

  if (searchPlayer1) {
    searchPlayer1.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && searchPlayer2) {
        if (searchPlayer1.value.trim() === '') return;
        e.preventDefault();
        searchPlayer2.classList.remove('player-field-hidden');
        if (playerFields) playerFields.classList.add('player2-visible');
        updatePlayer1Width(searchPlayer1, playerFields);
        searchPlayer2.focus();
      }
    });
  }


  // Set up random match button (disabled until data loads)
  let randomMatchBtn = document.getElementById('random-match-btn');
  if (randomMatchBtn) {
    randomMatchBtn.disabled = true;
    randomMatchBtn.addEventListener('click', function () {
      if (allMatchIds.length > 0) {
        let randomIndex = Math.floor(Math.random() * allMatchIds.length);
        let randomMatchId = allMatchIds[randomIndex];
        loadMatch(randomMatchId);
      }
    });
  }

  // Set up fullscreen button
  let fullscreenBtn = document.getElementById('fullscreen-btn');
  if (fullscreenBtn) {
    // Function to update button text based on fullscreen state
    function updateFullscreenButton() {
      let btnText = fullscreenBtn.querySelector('.text');
      if (document.fullscreenElement) {
        btnText.textContent = 'Exit Fullscreen';
      } else {
        btnText.textContent = 'Fullscreen';
      }
    }

    // Toggle fullscreen on click
    fullscreenBtn.addEventListener('click', function () {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen();
      } else {
        document.exitFullscreen();
      }
    });

    // Update button text when fullscreen state changes
    document.addEventListener('fullscreenchange', updateFullscreenButton);
  }

  // Allow typing immediately - will show empty results until data loads
  [searchDateYear, searchTournament, searchPlayer1, searchPlayer2]
    .filter(Boolean)
    .forEach(input => {
      input.addEventListener('input', function() {
        // Clear validation when user types manually
        if (validatedFields[this.id]) {
          delete validatedFields[this.id];
          this.classList.remove('field-validated');
        }
        handleSearchInput();
      });
    });

  // Track focused field for faceted dropdown
  ['search-date-year', 'search-tournament', 'search-player1', 'search-player2'].forEach(id => {
    let field = document.getElementById(id);
    if (!field) return;
    field.addEventListener('focus', function () {
      activeSearchField = this.id;
      handleSearchInput();
    });
    field.addEventListener('blur', function () {
      let blurredId = this.id;
      setTimeout(() => {
        if (activeSearchField === blurredId) {
          activeSearchField = null;
          handleSearchInput();
        }
      }, 150);
    });
  });

  // Capture-phase handler for Enter/Tab autocomplete on faceted options
  window.addEventListener('keydown', function (e) {
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
      const searchFieldIds = ['search-date-year', 'search-tournament', 'search-player1', 'search-player2'];
      if (searchFieldIds.includes(e.target.id) && activeSearchField && currentFacetOptions && currentFacetOptions.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        fillFieldAndAdvance(activeSearchField, currentFacetOptions[0]);
      }
    }
  }, true);

}

// ====== Search helpers ======

function getSearchValues() {
  let searchDateYear = document.getElementById('search-date-year');
  let searchTournament = document.getElementById('search-tournament');
  let searchPlayer1 = document.getElementById('search-player1');
  let searchPlayer2 = document.getElementById('search-player2');

  let yearValue = searchDateYear ? searchDateYear.value : '';
  if (yearValue.length === 2) yearValue = '20' + yearValue;

  // Get gender from radio buttons
  let selectedGender = document.querySelector('input[name="gender"]:checked');
  let genderValue = selectedGender ? selectedGender.value : 'all';
  if (genderValue === 'all') genderValue = '';

  return {
    date: yearValue.toLowerCase(),
    year: yearValue.toLowerCase(),
    gender: genderValue.toLowerCase(),
    tournament: searchTournament ? searchTournament.value.toLowerCase().replace(/\s+/g, '_') : '',
    player1: searchPlayer1 ? searchPlayer1.value.toLowerCase().replace(/\s+/g, '_') : '',
    player2: searchPlayer2 ? searchPlayer2.value.toLowerCase().replace(/\s+/g, '_') : '',
  };
}

function filterMatchesWith(sv) {
  return allMatchIds.filter(matchId => {
    // Parse match ID directly since we have all match IDs from points files
    let parsed = parseMatchId(matchId);
    if (!parsed) return false;

    // Use substring match for date (don't use validation for partial dates)
    let dateOk = !sv.date || parsed.year.includes(sv.date);
    
    let genderOk = !sv.gender || parsed.gender.toLowerCase() === sv.gender;
    let tournamentOk = !sv.tournament || (validatedFields['search-tournament'] ? 
      parsed.tournament.toLowerCase() === sv.tournament : parsed.tournament.toLowerCase().includes(sv.tournament));
    let roundOk = roundPassesFilter(parsed.round);

    let playersOk = true;
    if (sv.player1 && !sv.player2) {
      if (validatedFields['search-player1']) {
        playersOk = parsed.player1.toLowerCase() === sv.player1 || parsed.player2.toLowerCase() === sv.player1;
      } else {
        playersOk = parsed.player1.toLowerCase().includes(sv.player1) || parsed.player2.toLowerCase().includes(sv.player1);
      }
    } else if (sv.player2 && !sv.player1) {
      if (validatedFields['search-player2']) {
        playersOk = parsed.player1.toLowerCase() === sv.player2 || parsed.player2.toLowerCase() === sv.player2;
      } else {
        playersOk = parsed.player1.toLowerCase().includes(sv.player2) || parsed.player2.toLowerCase().includes(sv.player2);
      }
    } else if (sv.player1 && sv.player2) {
      if (validatedFields['search-player1'] && validatedFields['search-player2']) {
        playersOk = (parsed.player1.toLowerCase() === sv.player1 && parsed.player2.toLowerCase() === sv.player2) ||
          (parsed.player1.toLowerCase() === sv.player2 && parsed.player2.toLowerCase() === sv.player1);
      } else {
        playersOk = (parsed.player1.toLowerCase().includes(sv.player1) && parsed.player2.toLowerCase().includes(sv.player2)) ||
          (parsed.player1.toLowerCase().includes(sv.player2) && parsed.player2.toLowerCase().includes(sv.player1));
      }
    }

    return dateOk && genderOk && tournamentOk && roundOk && playersOk;
  });
}

function filterMatchesExcluding(excludeFieldId) {
  let sv = getSearchValues();
  switch (excludeFieldId) {
    case 'search-date-year': {
      let searchDateYear = document.getElementById('search-date-year');
      let y = excludeFieldId === 'search-date-year' ? '' : (searchDateYear ? searchDateYear.value : '');
      if (y.length === 2) y = '20' + y;
      sv.date = y.toLowerCase();
      break;
    }
    case 'search-tournament': sv.tournament = ''; break;
    case 'search-player1': sv.player1 = ''; break;
    case 'search-player2': sv.player2 = ''; break;
  }
  return filterMatchesWith(sv);
}

// Get match metadata by parsing match ID
function getMatchMetadata(matchId) {
  return parseMatchId(matchId);
}

function extractFieldValues(data, fieldId) {
  // If data is a match ID string, convert it to metadata object
  if (typeof data === 'string') {
    data = getMatchMetadata(data);
  }
  
  if (!data) return [];

  switch (fieldId) {
    case 'search-date-year': 
      return [data.Date ? data.Date.slice(0, 4) : (data.year || '')];
    case 'search-tournament': 
      let tournament = data.Tournament || data.tournament || '';
      // Normalize tournament names in dropdown to show with spaces but handle underscores in filtering
      return [tournament];
    case 'search-player1':
      // Get the value in player2 field to exclude it
      let player2Input = document.getElementById('search-player2');
      let excludePlayer2 = player2Input ? player2Input.value.replace(/\s+/g, '_') : '';
      let players1 = [
        (data['Player 1'] || data.player1 || '').replace(/\s+/g, '_'),
        (data['Player 2'] || data.player2 || '').replace(/\s+/g, '_')
      ].filter(p => p && p !== excludePlayer2);
      return players1;
    case 'search-player2':
      // Get the value in player1 field to exclude it
      let player1Input = document.getElementById('search-player1');
      let excludePlayer1 = player1Input ? player1Input.value.replace(/\s+/g, '_') : '';
      let players2 = [
        (data['Player 1'] || data.player1 || '').replace(/\s+/g, '_'),
        (data['Player 2'] || data.player2 || '').replace(/\s+/g, '_')
      ].filter(p => p && p !== excludePlayer1);
      return players2;
    default: return [];
  }
}

function getColumnIndex(fieldId) {
  switch (fieldId) {
    case 'search-date-year':
      return 0;
    case 'search-tournament': return 1;
    case 'search-player1':
    case 'search-player2':
      return 2;
    default: return -1;
  }
}

function formatFacetValue(value, fieldId) {
  if (fieldId === 'search-tournament' || fieldId === 'search-player1' || fieldId === 'search-player2') {
    return value.replace(/_/g, ' ');
  }
  return value;
}

function renderFacetedDropdown(focusedFieldId, dropdown, matchCountBar, matchCountText) {
  let baseMatches = filterMatchesExcluding(focusedFieldId);

  let valueCounts = {};
  let valueMatchIds = {};

  baseMatches.forEach(matchId => {
    // Use the match ID directly - extractFieldValues will handle metadata lookup
    let values = extractFieldValues(matchId, focusedFieldId);
    values.forEach(value => {
      if (!value) return;
      if (!valueCounts[value]) {
        valueCounts[value] = 0;
        valueMatchIds[value] = [];
      }
      if (!valueMatchIds[value].includes(matchId)) {
        valueCounts[value]++;
        valueMatchIds[value].push(matchId);
      }
    });
  });

  // Filter by partial text in focused field
  let focusedInput = document.getElementById(focusedFieldId);
  let partialText = focusedInput ? focusedInput.value.toLowerCase().replace(/\s+/g, '_') : '';

  if (focusedFieldId === 'search-date-year' && partialText.length === 2) {
    partialText = '20' + partialText;
  }

  let filteredValues = Object.keys(valueCounts).filter(value => {
    if (!partialText) return true;
    // Normalize both the value and partial text for comparison
    let normalizedValue = value.toLowerCase().replace(/\s+/g, '_');
    return normalizedValue.includes(partialText);
  });

  // Sort by count descending
  filteredValues.sort((a, b) => valueCounts[b] - valueCounts[a]);

  // Store for autocomplete
  currentFacetOptions = filteredValues;

  // Count unique matches (not sum of per-value counts, which would double-count for player fields)
  let uniqueMatchIds = {};
  filteredValues.forEach(v => valueMatchIds[v].forEach(id => { uniqueMatchIds[id] = true; }));
  let totalCount = Object.keys(uniqueMatchIds).length;

  if (matchCountBar && matchCountText) {
    let matchWord = totalCount === 1 ? 'match' : 'matches';
    matchCountText.textContent = `Matching: ${totalCount} ${matchWord}`;
    matchCountBar.classList.remove('match-count-hidden');
  }

  dropdown.innerHTML = '';
  dropdown.classList.remove('dropdown-hidden');

  if (filteredValues.length === 0) {
    const emptyMsg = document.createElement('div');
    emptyMsg.className = 'dropdown-empty-message';
    emptyMsg.textContent = 'No matching options';
    dropdown.appendChild(emptyMsg);
    return;
  }

  let colIndex = getColumnIndex(focusedFieldId);

  filteredValues.forEach(value => {
    let group = createFacetGroup(value, valueCounts[value], valueMatchIds[value], focusedFieldId, colIndex);
    dropdown.appendChild(group);
  });
}

function createFacetGroup(value, count, matchIds, focusedFieldId, colIndex) {
  let group = document.createElement('div');
  group.className = 'facet-group';

  let matchesDiv = document.createElement('div');
  matchesDiv.className = 'facet-matches facet-collapsed';

  let toggleBtn;

  function toggleExpand(e) {
    e.preventDefault();
    let isExpanded = !matchesDiv.classList.contains('facet-collapsed');
    if (isExpanded) {
      matchesDiv.classList.add('facet-collapsed');
      if (toggleBtn) toggleBtn.textContent = '\u25B6';
    } else {
      matchesDiv.classList.remove('facet-collapsed');
      if (toggleBtn) toggleBtn.textContent = '\u25BC';
      if (matchesDiv.children.length === 0) {
        loadFacetMatches(matchesDiv, matchIds);
      }
    }
  }

  let bar = document.createElement('div');
  bar.className = 'facet-bar';

  const colCount = 5;
  for (let i = 0; i < colCount; i++) {
    let cell = document.createElement('div');
    cell.className = 'facet-cell';

    if (i === colIndex) {
      cell.classList.add('facet-active-cell');

      let valueBtn = document.createElement('button');
      valueBtn.className = 'facet-value-btn';
      valueBtn.textContent = formatFacetValue(value, focusedFieldId);

      let countSpan = document.createElement('span');
      countSpan.className = 'facet-count';
      countSpan.textContent = count;

      toggleBtn = document.createElement('button');
      toggleBtn.className = 'facet-toggle-btn';
      toggleBtn.textContent = '\u25B6';

      cell.appendChild(valueBtn);
      cell.appendChild(countSpan);
      cell.appendChild(toggleBtn);

      valueBtn.addEventListener('mousedown', function (e) {
        e.preventDefault();
        fillFieldAndAdvance(focusedFieldId, value);
      });

      toggleBtn.addEventListener('mousedown', toggleExpand);
    }

    bar.appendChild(cell);
  }

  bar.addEventListener('mousedown', function (e) {
    if (e.target.classList.contains('facet-value-btn')) return;
    toggleExpand(e);
  });

  group.appendChild(bar);
  group.appendChild(matchesDiv);

  return group;
}

function loadFacetMatches(container, matchIds) {
  matchIds.sort((a, b) => a.localeCompare(b));
  matchIds.forEach(matchId => {
    let item = document.createElement('div');
    item.className = 'dropdown-item dropdown-item-match';
    item.appendChild(createMatchRow(matchId, false)); // false = dropdown item

    item.addEventListener('mouseenter', function () {
      previewMatch(matchId);
    });

    // Remove individual mouseleave - handled at container level to prevent flicker

    item.addEventListener('click', function () {
      loadMatch(matchId);
      ['search-date-year', 'search-tournament'].forEach(id => {
        let el = document.getElementById(id);
        if (el) el.value = '';
      });
      // Clear backend array and sync to UI
      searchPlayers = [];
      validatedFields['search-player1'] = false;
      validatedFields['search-player2'] = false;
      syncPlayersToUI();
      activeSearchField = null;
      handleSearchInput();
    });

    container.appendChild(item);
  });
}

function fillFieldAndAdvance(fieldId, value) {
  let input = document.getElementById(fieldId);
  if (!input) return;

  if (fieldId === 'search-tournament' || fieldId === 'search-player1' || fieldId === 'search-player2') {
    input.value = value.replace(/_/g, ' ');
  } else {
    input.value = value;
  }

  // Mark field as validated (exact value entered)
  validatedFields[fieldId] = true;
  input.classList.add('field-validated');

  if (fieldId === 'search-player1') {
    let searchPlayer1 = document.getElementById('search-player1');
    let searchPlayer2 = document.getElementById('search-player2');
    let playerFields = document.getElementById('player-fields');
    syncPlayer2Visibility(searchPlayer1, searchPlayer2, playerFields);
    updatePlayer1Width(searchPlayer1, playerFields);
  }

  const fieldOrder = [
    'search-date-year',
    'search-tournament',
    'search-player1', 'search-player2'
  ];

  let currentIndex = fieldOrder.indexOf(fieldId);
  let nextField = null;

  if (currentIndex >= 0 && currentIndex < fieldOrder.length - 1) {
    let nextFieldId = fieldOrder[currentIndex + 1];
    nextField = document.getElementById(nextFieldId);

    if (nextFieldId === 'search-player2') {
      let searchPlayer2 = document.getElementById('search-player2');
      let playerFields = document.getElementById('player-fields');
      if (searchPlayer2) {
        searchPlayer2.classList.remove('player-field-hidden');
        if (playerFields) playerFields.classList.add('player2-visible');
        let searchPlayer1 = document.getElementById('search-player1');
        updatePlayer1Width(searchPlayer1, playerFields);
      }
    }
  }

  if (nextField) {
    nextField.focus();
  } else {
    activeSearchField = null;
    input.blur();
    handleSearchInput();
  }
}

// ====== Main search handler ======

// Trigger search without syncing arrays (for previews)
function triggerSearchWithCurrentValues() {
  let searchPlayer1 = document.getElementById('search-player1');
  let searchPlayer2 = document.getElementById('search-player2');
  let playerFields = document.getElementById('player-fields');
  let dropdown = document.getElementById('dropdown');
  let matchCountBar = document.getElementById('match-count-bar');
  let matchCountText = document.getElementById('match-count-text');

  // Just do layout updates without array syncing
  updatePlayer1Width(searchPlayer1, playerFields);

  if (!fullDataLoaded) {
    dropdown.innerHTML = '<div class="dropdown-item dropdown-item-text" style="color: #666;">Loading match database...</div>';
    dropdown.classList.remove('dropdown-hidden');
    currentMatches = [];
    matchesRendered = 0;
    if (matchCountBar && matchCountText) {
      matchCountText.textContent = 'Matching: ...';
      matchCountBar.classList.remove('match-count-hidden');
    }
    return;
  }

  // During preview, we want flat results, not faceted dropdowns - skip activeSearchField logic 
  
  // Check for input and show flat results
  let sv = getSearchValues();
  let hasAnyInput = sv.date || sv.gender || sv.tournament || sv.round || sv.player1 || sv.player2;

  // Always show all matches when no input (instead of empty message)
  let matches;
  if (!hasAnyInput) {
    matches = allMatchIds.slice(); // Clone the array
  } else {
    matches = filterMatchesWith(sv);
  }
  
  matches.sort((a, b) => a.localeCompare(b));

  if (matches.length > 0) {
    dropdown.innerHTML = '';
    dropdown.classList.remove('dropdown-hidden');
    if (matchCountBar && matchCountText) {
      let matchWord = matches.length === 1 ? 'match' : 'matches';
      if (!hasAnyInput) {
        matchCountText.textContent = `Matching: ${matches.length} ${matchWord} - type in fields to filter`;
      } else {
        matchCountText.textContent = `Matching: ${matches.length} ${matchWord}`;
      }
      matchCountBar.classList.remove('match-count-hidden');
    }
    currentMatches = matches;
    matchesRendered = 0;
    renderNextMatchBatch(dropdown);
  } else {
    dropdown.innerHTML = '<div class="dropdown-item dropdown-item-text" style="color: #666;">No matches</div>';
    dropdown.classList.remove('dropdown-hidden');
    currentMatches = [];
    matchesRendered = 0;
    if (matchCountBar && matchCountText) {
      matchCountText.textContent = 'Matching: 0 matches';
      matchCountBar.classList.remove('match-count-hidden');
    }
  }
}

function handleSearchInput() {
  let searchPlayer1 = document.getElementById('search-player1');
  let searchPlayer2 = document.getElementById('search-player2');
  let playerFields = document.getElementById('player-fields');
  let dropdown = document.getElementById('dropdown');
  let matchCountBar = document.getElementById('match-count-bar');
  let matchCountText = document.getElementById('match-count-text');

  // Check if we're in preview mode (any field has preview data)
  let isPreview = (searchPlayer1 && searchPlayer1.dataset.originalValue) || 
                  (searchPlayer2 && searchPlayer2.dataset.originalValue) ||
                  (document.getElementById('search-date-year') && document.getElementById('search-date-year').dataset.originalValue) ||
                  (document.getElementById('search-tournament') && document.getElementById('search-tournament').dataset.originalValue);

  // Only sync UI to array if this is NOT preview mode and user is actively typing
  if (!isPreview && (document.activeElement === searchPlayer1 || document.activeElement === searchPlayer2)) {
    syncUIToPlayers();
  }
  
  // Always sync array to UI to ensure proper display and validation
  if (!isPreview) {
    syncPlayersToUI();
  }
  
  // Legacy width update for layout
  updatePlayer1Width(searchPlayer1, playerFields);

  if (!fullDataLoaded) {
    dropdown.innerHTML = '<div class="dropdown-item dropdown-item-text" style="color: #666;">Loading match database...</div>';
    dropdown.classList.remove('dropdown-hidden');
    currentMatches = [];
    matchesRendered = 0;
    if (matchCountBar && matchCountText) {
      matchCountText.textContent = 'Matching: ...';
      matchCountBar.classList.remove('match-count-hidden');
    }
    return;
  }

  // If a field is focused, show faceted dropdown for that field
  if (activeSearchField) {
    // Don't show faceted options if the field is already validated
    if (validatedFields[activeSearchField]) {
      dropdown.innerHTML = '';
      dropdown.classList.remove('dropdown-hidden');
      const emptyMsg = document.createElement('div');
      emptyMsg.className = 'dropdown-empty-message';
      emptyMsg.textContent = 'Field validated - type to see new options';
      dropdown.appendChild(emptyMsg);
      return;
    }
    
    try {
      renderFacetedDropdown(activeSearchField, dropdown, matchCountBar, matchCountText);
    } catch (err) {
      console.error('Faceted dropdown error:', err);
      dropdown.innerHTML = '<div class="dropdown-item dropdown-item-text" style="color: #f66;">Error rendering options: ' + err.message + '</div>';
      dropdown.classList.remove('dropdown-hidden');
    }
    return;
  }

  // No focused field — check for input and show flat results
  let sv = getSearchValues();
  let hasAnyInput = sv.date || sv.gender || sv.tournament || sv.round || sv.player1 || sv.player2;

  // Always show all matches when no input (instead of empty message)
  let matches;
  if (!hasAnyInput) {
    matches = allMatchIds.slice(); // Clone the array
  } else {
    matches = filterMatchesWith(sv);
  }
  
  matches.sort((a, b) => a.localeCompare(b));

  if (matches.length > 0) {
    dropdown.innerHTML = '';
    dropdown.classList.remove('dropdown-hidden');
    if (matchCountBar && matchCountText) {
      let matchWord = matches.length === 1 ? 'match' : 'matches';
      if (!hasAnyInput) {
        matchCountText.textContent = `Matching: ${matches.length} ${matchWord} - type in fields to filter`;
      } else {
        matchCountText.textContent = `Matching: ${matches.length} ${matchWord}`;
      }
      matchCountBar.classList.remove('match-count-hidden');
    }
    currentMatches = matches;
    matchesRendered = 0;
    renderNextMatchBatch(dropdown);
  } else {
    dropdown.innerHTML = '<div class="dropdown-item dropdown-item-text" style="color: #666;">No matches</div>';
    dropdown.classList.remove('dropdown-hidden');
    currentMatches = [];
    matchesRendered = 0;
    if (matchCountBar && matchCountText) {
      matchCountText.textContent = 'Matching: 0 matches';
      matchCountBar.classList.remove('match-count-hidden');
    }
  }
}

function setupSearchInterface() {
  let loadingIndicator = document.getElementById('loading-indicator');
  let dropdown = document.getElementById('dropdown');
  let searchDateYear = document.getElementById('search-date-year');
  let searchTournament = document.getElementById('search-tournament');
  let searchPlayer1 = document.getElementById('search-player1');
  let searchPlayer2 = document.getElementById('search-player2');
  let randomMatchBtn = document.getElementById('random-match-btn');

  // Initialize backend array from any existing field values
  if (searchPlayer1.value || searchPlayer2.value) {
    syncUIToPlayers();
  }
  
  // Add event listeners for gender radio buttons
  let genderRadios = document.querySelectorAll('input[name="gender"]');
  genderRadios.forEach(radio => {
    radio.addEventListener('change', function() {
      handleSearchInput();
    });
  });
  
  // Add event listeners for round selector buttons
  document.querySelectorAll('#round-selector .round-btn:not(.round-other)').forEach(btn => {
    btn.addEventListener('click', function() {
      roundSelectorMin = this.dataset.round;
      updateRoundSelectorUI();
      handleSearchInput();
    });
  });
  
  let otherBtn = document.querySelector('#round-selector .round-other');
  if (otherBtn) {
    otherBtn.addEventListener('click', function() {
      roundOtherEnabled = !roundOtherEnabled;
      updateRoundSelectorUI();
      handleSearchInput();
    });
  }
  
  // Initialize round selector UI
  updateRoundSelectorUI();
  
  // Add event listeners for two-way binding with backend array
  if (searchPlayer1) {
    searchPlayer1.addEventListener('input', function() {
      // Remove validation when user starts typing manually
      if (validatedFields['search-player1']) {
        validatedFields['search-player1'] = false;
      }
      // Let handleSearchInput do the sync
    });
  }
  
  if (searchPlayer2) {
    searchPlayer2.addEventListener('input', function() {
      // Remove validation when user starts typing manually  
      if (validatedFields['search-player2']) {
        validatedFields['search-player2'] = false;
      }
      // Let handleSearchInput do the sync
    });
  }

  // Hide loading indicator now that data is loaded
  loadingIndicator.classList.add('loading-hidden');

  // Enable random match button
  if (randomMatchBtn) {
    randomMatchBtn.disabled = false;
  }

  // Add dropdown mouseleave handler to stop previews when leaving dropdown area
  if (dropdown) {
    dropdown.addEventListener('mouseleave', function () {
      stopPreview();
    });
  }

  // If user already typed something, update results, otherwise show all matches
  let hasInput = searchDateYear.value ||
    searchTournament.value || searchPlayer1.value || searchPlayer2.value;
  if (hasInput) {
    handleSearchInput();
  } else {
    // Show all matches initially after data loads
    handleSearchInput();
  }

  // Keep dropdown always visible (no close-on-click behavior)

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
        translate(pos.x + offset[axisToPlayer("x")] + setSize / 2, pos.y + offset[axisToPlayer("y")] - gapToChart);
        rotate(-TAU / 8);
        text(p1_setsWon, 0, 0);
        pop();
      } else {
        push();
        translate(pos.x + offset[axisToPlayer("x")] - gapToChart, pos.y + offset[axisToPlayer("y")] + setSize / 2);
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
            translate(pos.x + offset[axisToPlayer("x")] + setSize / 2, pos.y + offset[axisToPlayer("y")] - gapToChart);
            rotate(-TAU / 8);
            text(p2_setsWon, 0, 0);
            pop();
          } else {
            push();
            translate(pos.x + offset[axisToPlayer("x")] - gapToChart, pos.y + offset[axisToPlayer("y")] + setSize / 2);
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

    layers[2].clear();
    layers[0].clear();

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

          layers[2].strokeWeight(0.25);
          layers[2].stroke(20);

          // layers[2].rect(setPos.x + gamePos.x + pointPos.x, setPos.y + gamePos.y + pointPos.y, s, s);


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
  // Resize main canvas to 60% of new window width
  resizeCanvas(windowWidth * 0.6, windowHeight);

  // Resize all graphics layers
  for (let i = 0; i < layers.length; i++) {
    layers[i].remove();
    layers[i] = createGraphics(windowWidth * 0.6, windowHeight);
  }

  // Create new scoresnake with new dimensions
  if (dataLoaded && tennisMatch) {
    currentScoresnake = new ScoresnakeChart();
    currentScoresnake.update(tennisMatch);
    redraw();
  }
}