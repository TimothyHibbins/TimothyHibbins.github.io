let matchData;     // Will store the currently displayed match data
let allMatchIds = []; // Will store all unique match IDs

// Lazy loading: store CSV and metadata
let csvText = '';  // Full CSV text kept in memory
let csvHeaders = []; // CSV header row
let matchMetadata = {}; // Map: {match_id: {startLine: X, endLine: Y}}

// Specify which match to visualize
let matchSpecifier = '20250116-M-Australian_Open-R64-Learner_Tien-Daniil_Medvedev';
let currentMatchId = matchSpecifier;
let currentMatches = [];
let matchesRendered = 0;
const MATCHES_BATCH_SIZE = 50;

let JetBrainsMonoBold;
let dataLoaded = false;
let fullDataLoaded = false;

// Global variables used in visualization (initialized in parseMatchData)
let tennisMatch;
let layers = [];
let scoresnake;

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

  scoresnake = new ScoresnakeChart();
  scoresnake.update(tennisMatch);
  dataLoaded = true;

  // Set up basic search interface with loading message
  setupSearchInterfaceLoading();

  // Update progress to show CSV download is starting
  let progressText = document.getElementById('progress-text');
  let progressBar = document.getElementById('progress-bar');
  if (progressText) {
    progressText.textContent = 'Downloading match database...';
  }
  if (progressBar) {
    progressBar.style.width = '0%';
  }

  // Download CSV with progress tracking
  fetch('charting-m-points-2020s.csv')
    .then(response => {
      const contentLength = response.headers.get('content-length');
      const total = parseInt(contentLength, 10);
      let loaded = 0;

      const reader = response.body.getReader();
      const chunks = [];

      return new ReadableStream({
        start(controller) {
          function push() {
            reader.read().then(({ done, value }) => {
              if (done) {
                controller.close();
                return;
              }

              loaded += value.byteLength;
              chunks.push(value);

              // Update download progress
              if (total) {
                const percent = Math.round((loaded / total) * 100);
                if (progressBar) {
                  progressBar.style.width = percent + '%';
                }
                if (progressText) {
                  progressText.textContent = `Downloading match database... ${percent}%`;
                }
              }

              controller.enqueue(value);
              push();
            });
          }
          push();
        }
      });
    })
    .then(stream => new Response(stream))
    .then(response => response.text())
    .then(csvText => {
      // Immediately update UI for parsing phase
      if (progressText) {
        progressText.textContent = 'Parsing CSV data...';
      }
      if (progressBar) {
        progressBar.style.transition = 'none';
        progressBar.style.width = '0%';
        setTimeout(() => {
          progressBar.style.transition = 'width 0.3s ease';
        }, 50);
      }

      // Parse CSV in chunks to avoid blocking
      parseCSVAsync(csvText);
    })
    .catch(error => {
      console.error('Error loading CSV:', error);
      if (progressText) {
        progressText.textContent = 'Error loading match database';
      }
    });
}

function parseCSVAsync(csvData) {
  // Store CSV globally for lazy loading
  csvText = csvData;
  let lines = csvText.split('\n');
  csvHeaders = lines[0].split(',');

  let currentIndex = 1; // Skip header row
  const CHUNK_SIZE = 10000; // Process 10000 lines at a time (faster since we're just scanning)

  let progressText = document.getElementById('progress-text');
  let progressBar = document.getElementById('progress-bar');

  // Track match IDs and their line ranges
  let matchIdObj = {};
  let matchIdsArray = [];
  let previousMatchId = null;
  let matchStartLine = null;
  let matchIdIndex = csvHeaders.indexOf('match_id');

  function parseChunk() {
    let endIndex = Math.min(currentIndex + CHUNK_SIZE, lines.length);

    // Scan this chunk for match boundaries
    for (let i = currentIndex; i < endIndex; i++) {
      if (lines[i].trim()) {
        // Extract match ID from this row
        let cells = lines[i].split(',');
        if (matchIdIndex >= 0 && cells[matchIdIndex]) {
          let matchId = cells[matchIdIndex].trim().replace(/^"|"$/g, '');

          // If we encounter a new match, finalize the previous one
          if (previousMatchId && matchId !== previousMatchId) {
            matchMetadata[previousMatchId] = {
              startLine: matchStartLine,
              endLine: i - 1
            };
          }

          // Start tracking this match if it's new
          if (!matchIdObj[matchId]) {
            matchIdObj[matchId] = true;
            matchIdsArray.push(matchId);
            matchStartLine = i;
          }

          previousMatchId = matchId;
        }
      }
    }

    currentIndex = endIndex;

    // Update parsing progress
    let percent = Math.round((currentIndex / lines.length) * 100);
    if (progressBar) {
      progressBar.style.width = percent + '%';
    }
    if (progressText) {
      progressText.textContent = `Scanning matches: ${matchIdsArray.length} found (${percent}%)`;
    }

    if (currentIndex < lines.length) {
      // More lines to parse
      setTimeout(parseChunk, 0);
    } else {
      // Finalize the last match
      if (previousMatchId && matchStartLine !== null) {
        matchMetadata[previousMatchId] = {
          startLine: matchStartLine,
          endLine: lines.length - 1
        };
      }

      // Scanning complete
      allMatchIds = matchIdsArray;
      setupSearchInterface();
      fullDataLoaded = true;

      if (progressText) {
        progressText.textContent = `${matchIdsArray.length} matches ready`;
      }
    }
  }

  parseChunk();
}

// Load a specific match by ID from the stored CSV
function loadMatchById(matchId, callback) {
  if (!matchMetadata[matchId]) {
    console.error('Match not found:', matchId);
    return;
  }

  let metadata = matchMetadata[matchId];
  let lines = csvText.split('\n');

  // Extract just the lines for this match
  let matchLines = [];
  for (let i = metadata.startLine; i <= metadata.endLine; i++) {
    if (lines[i] && lines[i].trim()) {
      matchLines.push(lines[i]);
    }
  }

  // Build mini table
  let miniTableData = csvHeaders.join(',') + '\n' + matchLines.join('\n');

  loadTable(
    'data:text/csv;charset=utf-8,' + encodeURIComponent(miniTableData),
    'csv',
    'header',
    function (table) {
      matchData = table;
      if (callback) callback();
    },
    function (error) {
      console.error('Error loading match:', matchId, error);
    }
  );
}

function loadMatch(matchId, options = { setCurrent: true }) {
  try {
    if (options.setCurrent) {
      matchSpecifier = matchId;
      currentMatchId = matchId;
    }

    // Load match data lazily from CSV
    loadMatchById(matchId, function () {
      // Check if we have valid match data
      if (matchData.getRowCount() === 0) {
        return; // Skip if no data found
      }

      // Parse the match data into an easily accessible object
      parseMatchData();

      // Check if parsing was successful
      if (!tennisMatch || !tennisMatch.sets || tennisMatch.sets.length === 0) {
        return; // Skip if parsing failed
      }

      // Determine if this is best of 3 or best of 5
      let maxSetsWon = Math.max(tennisMatch.setsInMatchWonByPlayer[1], tennisMatch.setsInMatchWonByPlayer[2]);
      SETS_TO_WIN_MATCH = maxSetsWon; // 2 for best of 3, 3 for best of 5

      // Update the scoresnake visualization
      scoresnake = new ScoresnakeChart();
      scoresnake.update(tennisMatch);

      if (options.setCurrent) {
        updateMatchDisplay(matchId);
      }

      // Redraw (works even when noLoop() is active)
      if (dataLoaded) {
        redraw();
      }
    });
  } catch (e) {
    // Silently catch errors for incomplete/invalid matches during loading
    console.warn('Error loading match ' + matchId + ':', e);
  }
}

function previewMatch(matchId) {
  loadMatch(matchId, { setCurrent: false });
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
    displayElement.appendChild(createMatchRow(matchId));
  }
}

function renderNextMatchBatch(dropdown) {
  if (!dropdown || matchesRendered >= currentMatches.length) return;

  let searchDateYear = document.getElementById('search-date-year');
  let searchDateMonth = document.getElementById('search-date-month');
  let searchDateDay = document.getElementById('search-date-day');
  let searchGender = document.getElementById('search-gender');
  let searchTournament = document.getElementById('search-tournament');
  let searchRound = document.getElementById('search-round');
  let searchPlayer1 = document.getElementById('search-player1');
  let searchPlayer2 = document.getElementById('search-player2');
  let playerFields = document.getElementById('player-fields');

  let nextChunk = currentMatches.slice(matchesRendered, matchesRendered + MATCHES_BATCH_SIZE);
  nextChunk.forEach(matchId => {
    let item = document.createElement('div');
    item.className = 'dropdown-item dropdown-item-match';
    item.appendChild(createMatchRow(matchId));

    item.addEventListener('mouseenter', function () {
      previewMatch(matchId);
    });

    item.addEventListener('click', function () {
      loadMatch(matchId);
      if (searchDateYear) searchDateYear.value = '';
      if (searchDateMonth) searchDateMonth.value = '';
      if (searchDateDay) searchDateDay.value = '';
      if (searchGender) searchGender.value = '';
      if (searchTournament) searchTournament.value = '';
      if (searchRound) searchRound.value = '';
      if (searchPlayer1) searchPlayer1.value = '';
      if (searchPlayer2) {
        searchPlayer2.value = '';
        searchPlayer2.classList.add('player-field-hidden');
      }
      if (playerFields) playerFields.classList.remove('player2-visible');
      handleSearchInput();
    });

    dropdown.appendChild(item);
  });

  matchesRendered += nextChunk.length;
}

function parseMatchId(matchId) {
  let parts = matchId.split('-');
  if (parts.length < 6) {
    return null;
  }

  let date = parts[0] || '';
  let year = date.slice(0, 4);
  let month = date.slice(4, 6);
  let day = date.slice(6, 8);

  return {
    year,
    month,
    day,
    gender: parts[1] || '',
    tournament: parts[2] || '',
    round: parts[3] || '',
    player1: parts[4] || '',
    player2: parts[5] || ''
  };
}

function createMatchRow(matchId) {
  let data = parseMatchId(matchId);
  let row = document.createElement('div');
  row.className = 'match-row';

  if (!data) {
    let fallback = document.createElement('div');
    fallback.className = 'match-cell';
    fallback.textContent = matchId;
    row.appendChild(fallback);
    return row;
  }

  let dateCell = document.createElement('div');
  dateCell.className = 'date-container match-date';
  dateCell.dataset.field = 'date';
  dateCell.dataset.year = data.year;
  dateCell.dataset.month = data.month;
  dateCell.dataset.day = data.day;
  dateCell.title = 'Click to add this to search filters';

  let year = document.createElement('span');
  year.className = 'match-date-part year';
  year.textContent = data.year;

  let month = document.createElement('span');
  month.className = 'match-date-part month';
  month.textContent = data.month;

  let day = document.createElement('span');
  day.className = 'match-date-part day';
  day.textContent = data.day;

  dateCell.appendChild(year);
  dateCell.appendChild(month);
  dateCell.appendChild(day);
  row.appendChild(dateCell);

  let gender = document.createElement('div');
  gender.className = 'match-cell centered';
  gender.textContent = data.gender;
  gender.dataset.field = 'gender';
  gender.dataset.value = data.gender;
  gender.title = 'Click to add this to search filters';
  row.appendChild(gender);

  let tournament = document.createElement('div');
  tournament.className = 'match-cell';
  tournament.textContent = data.tournament.replace(/_/g, ' ');
  tournament.dataset.field = 'tournament';
  tournament.dataset.value = data.tournament;
  tournament.title = 'Click to add this to search filters';
  row.appendChild(tournament);

  let round = document.createElement('div');
  round.className = 'match-cell';
  round.textContent = data.round;
  round.dataset.field = 'round';
  round.dataset.value = data.round;
  round.title = 'Click to add this to search filters';
  row.appendChild(round);

  let players = document.createElement('div');
  players.className = 'match-cell match-players';

  let player1 = document.createElement('span');
  player1.className = 'match-player';
  player1.textContent = data.player1.replace(/_/g, ' ');
  player1.dataset.field = 'player1';
  player1.dataset.value = data.player1;
  player1.title = 'Click to add this to search filters';

  let sep = document.createElement('span');
  sep.className = 'player-sep';
  sep.textContent = ' vs ';

  let player2 = document.createElement('span');
  player2.className = 'match-player';
  player2.textContent = data.player2.replace(/_/g, ' ');
  player2.dataset.field = 'player2';
  player2.dataset.value = data.player2;
  player2.title = 'Click to add this to search filters';

  players.appendChild(player1);
  players.appendChild(sep);
  players.appendChild(player2);
  row.appendChild(players);

  return row;
}

function setupSearchInterfaceLoading() {
  let searchDateYear = document.getElementById('search-date-year');
  let searchDateMonth = document.getElementById('search-date-month');
  let searchDateDay = document.getElementById('search-date-day');
  let searchGender = document.getElementById('search-gender');
  let searchTournament = document.getElementById('search-tournament');
  let searchRound = document.getElementById('search-round');
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
    const emptyMsg = document.createElement('div');
    emptyMsg.className = 'dropdown-empty-message';
    emptyMsg.textContent = 'Type in the search bar fields to filter matches';
    dropdown.appendChild(emptyMsg);
  }

  if (searchPlayer1) {
    updatePlayer1Width(searchPlayer1, playerFields);
    searchPlayer1.addEventListener('input', function () {
      syncPlayer2Visibility(searchPlayer1, searchPlayer2, playerFields);
      updatePlayer1Width(searchPlayer1, playerFields);
    });
    syncPlayer2Visibility(searchPlayer1, searchPlayer2, playerFields);
    updatePlayer1Width(searchPlayer1, playerFields);
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
        if (searchDateMonth) searchDateMonth.value = dateCell.dataset.month || '';
        if (searchDateDay) searchDateDay.value = dateCell.dataset.day || '';
        handleSearchInput();
        return;
      }

      if (cell && cell.dataset.field) {
        let field = cell.dataset.field;
        if (field === 'gender' && searchGender) {
          searchGender.value = cell.dataset.value || '';
        } else if (field === 'tournament' && searchTournament) {
          searchTournament.value = (cell.dataset.value || '').replace(/_/g, ' ');
        } else if (field === 'round' && searchRound) {
          searchRound.value = cell.dataset.value || '';
        } else if (field === 'player1' && searchPlayer1) {
          searchPlayer1.value = (cell.dataset.value || '').replace(/_/g, ' ');
        } else if (field === 'player2' && searchPlayer2) {
          let value = (cell.dataset.value || '').replace(/_/g, ' ');
          if (searchPlayer1 && searchPlayer1.value.trim() === '') {
            searchPlayer1.value = value;
            updatePlayer1Width(searchPlayer1, playerFields);
          } else {
            searchPlayer2.value = value;
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
      } else if ((field.id === 'search-date-month' || field.id === 'search-date-day') && field.value.length === 1) {
        field.value = '0' + field.value;
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
      searchDateMonth,
      searchDateDay,
      searchGender,
      searchTournament,
      searchRound,
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
      } else if ((field.id === 'search-date-month' || field.id === 'search-date-day') && field.value.length === 1) {
        field.value = '0' + field.value;
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
      (currentField.id === 'search-date-year' || currentField.id === 'search-date-month' || currentField.id === 'search-date-day') &&
      currentField.value.length > 0 && nextField) {
      e.preventDefault();
      e.stopPropagation();
      completeDateField(currentField);
      nextField.focus();
      return;
    }
  });

  setupDateFieldAutoAdvance(searchDateYear, searchDateMonth, null, 4);
  setupDateFieldAutoAdvance(searchDateMonth, searchDateDay, searchDateYear, 2);
  setupDateFieldAutoAdvance(searchDateDay, searchGender, searchDateMonth, 2);

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
  [searchDateYear, searchDateMonth, searchDateDay, searchGender, searchTournament, searchRound, searchPlayer1, searchPlayer2]
    .filter(Boolean)
    .forEach(input => {
      input.addEventListener('input', handleSearchInput);
    });

}

function handleSearchInput() {
  let searchDateYear = document.getElementById('search-date-year');
  let searchDateMonth = document.getElementById('search-date-month');
  let searchDateDay = document.getElementById('search-date-day');
  let searchGender = document.getElementById('search-gender');
  let searchTournament = document.getElementById('search-tournament');
  let searchRound = document.getElementById('search-round');
  let searchPlayer1 = document.getElementById('search-player1');
  let searchPlayer2 = document.getElementById('search-player2');
  let playerFields = document.getElementById('player-fields');
  let dropdown = document.getElementById('dropdown');
  let matchCountBar = document.getElementById('match-count-bar');
  let matchCountText = document.getElementById('match-count-text');

  let yearValue = searchDateYear.value;
  syncPlayer2Visibility(searchPlayer1, searchPlayer2, playerFields);
  updatePlayer1Width(searchPlayer1, playerFields);
  let monthValue = searchDateMonth.value;
  let dayValue = searchDateDay.value;

  if (yearValue.length === 2) {
    yearValue = '20' + yearValue;
  }

  if (monthValue.length === 1) {
    monthValue = '0' + monthValue;
  }
  if (dayValue.length === 1) {
    dayValue = '0' + dayValue;
  }

  let dateSearch = (yearValue + monthValue + dayValue).toLowerCase();
  let genderSearch = searchGender.value.toLowerCase();
  let tournamentSearch = searchTournament.value.toLowerCase().replace(/\s+/g, '_');
  let roundSearch = searchRound.value.toLowerCase().replace(/\s+/g, '_');
  let player1Search = (searchPlayer1 ? searchPlayer1.value : '').toLowerCase().replace(/\s+/g, '_');
  let player2Search = (searchPlayer2 ? searchPlayer2.value : '').toLowerCase().replace(/\s+/g, '_');

  let hasAnyInput = dateSearch || genderSearch || tournamentSearch || roundSearch || player1Search || player2Search;

  if (!hasAnyInput) {
    dropdown.classList.remove('dropdown-hidden');
    dropdown.innerHTML = '<div class="dropdown-item dropdown-item-text" style="color: #666;">Type in the search bar fields to filter matches</div>';
    currentMatches = [];
    matchesRendered = 0;
    if (searchPlayer2) {
      searchPlayer2.classList.add('player-field-hidden');
      searchPlayer2.value = '';
    }
    if (playerFields) playerFields.classList.remove('player2-visible');
    if (matchCountBar && matchCountText) {
      matchCountText.textContent = 'Matching: 0';
      matchCountBar.classList.remove('match-count-hidden');
    }
    if (currentMatchId) {
      previewMatch(currentMatchId);
    }
    return;
  }

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

  let matches = allMatchIds.filter(matchId => {
    let parts = matchId.toLowerCase().split('-');
    if (parts.length < 6) return false;

    let date = parts[0];
    let gender = parts[1];
    let tournament = parts[2];
    let round = parts[3];
    let player1 = parts[4];
    let player2 = parts[5];

    let dateOk = !dateSearch || date.includes(dateSearch);
    let genderOk = !genderSearch || gender.includes(genderSearch);
    let tournamentOk = !tournamentSearch || tournament.includes(tournamentSearch);
    let roundOk = !roundSearch || round.includes(roundSearch);

    let playersOk = true;
    if (player1Search && !player2Search) {
      playersOk = player1.includes(player1Search) || player2.includes(player1Search);
    } else if (player2Search && !player1Search) {
      playersOk = player1.includes(player2Search) || player2.includes(player2Search);
    } else if (player1Search && player2Search) {
      playersOk = (player1.includes(player1Search) && player2.includes(player2Search)) ||
        (player1.includes(player2Search) && player2.includes(player1Search));
    }

    return dateOk && genderOk && tournamentOk && roundOk && playersOk;
  });

  matches.sort((a, b) => a.localeCompare(b));

  if (matches.length > 0) {
    dropdown.innerHTML = '';
    dropdown.classList.remove('dropdown-hidden');
    if (matchCountBar && matchCountText) {
      matchCountText.textContent = `Matching: ${matches.length}`;
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
      matchCountText.textContent = 'Matching: 0';
      matchCountBar.classList.remove('match-count-hidden');
    }
  }
}

function setupSearchInterface() {
  let loadingIndicator = document.getElementById('loading-indicator');
  let dropdown = document.getElementById('dropdown');
  let searchDateYear = document.getElementById('search-date-year');
  let searchDateMonth = document.getElementById('search-date-month');
  let searchDateDay = document.getElementById('search-date-day');
  let searchGender = document.getElementById('search-gender');
  let searchTournament = document.getElementById('search-tournament');
  let searchRound = document.getElementById('search-round');
  let searchPlayer1 = document.getElementById('search-player1');
  let searchPlayer2 = document.getElementById('search-player2');
  let randomMatchBtn = document.getElementById('random-match-btn');

  // Hide loading indicator now that data is loaded
  loadingIndicator.classList.add('loading-hidden');

  // Enable random match button
  if (randomMatchBtn) {
    randomMatchBtn.disabled = false;
  }

  // If user already typed something, update results
  let hasInput = searchDateYear.value || searchDateMonth.value || searchDateDay.value ||
    searchGender.value || searchTournament.value ||
    searchRound.value || searchPlayer1.value || searchPlayer2.value;
  if (hasInput) {
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
          this.sets[p1_setsWon].push(new Set(true));
        } else {
          this.sets[p1_setsWon].push(new Set());
        }
      }
    }

    this.minX = 0;
    this.minY = 0;

    this.targetMinX;
    this.targetMinY;

    this.maxX;
    this.maxY;

    this.targetMaxX;
    this.targetMaxY;

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

      this.sets[set.setsInMatchWonByPlayerSoFar[1]][set.setsInMatchWonByPlayerSoFar[2]].active[1][0] = true;
      this.sets[set.setsInMatchWonByPlayerSoFar[1]][set.setsInMatchWonByPlayerSoFar[2]].active[2][0] = true;

      for (let [g, game] of set.games.entries()) {


        this.sets[set.setsInMatchWonByPlayerSoFar[1]][set.setsInMatchWonByPlayerSoFar[2]].
          games[game.gamesInSetWonByPlayerSoFar[1]][game.gamesInSetWonByPlayerSoFar[2]].active = true;

        let pointPos = createVector(0, 0);

        for (let point of game.points) {

          layers[2].strokeWeight(0.25);
          layers[2].stroke(20);

          // layers[2].rect(setPos.x + gamePos.x + pointPos.x, setPos.y + gamePos.y + pointPos.y, s, s);


          let displayGame = this.sets[set.setsInMatchWonByPlayerSoFar[1]][set.setsInMatchWonByPlayerSoFar[2]].
            games[game.gamesInSetWonByPlayerSoFar[1]][game.gamesInSetWonByPlayerSoFar[2]];


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


    this.maxX = setPos.x;
    this.maxY = setPos.y;


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
    if (scoresnake.hoverSet != null) {
      scoresnake.zoomedSet = scoresnake.hoverSet;
    }
  } else if (event.deltaY > 0) { // scrolling down
    scoresnake.zoomedSet = null;
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

  if (!tennisMatch || !scoresnake) {
    fill(255);
    textSize(24);
    textAlign(CENTER, CENTER);
    text('Error: Match data not loaded', width / 2, height / 2);
    return;
  }



  matchX = width / 2, matchY = 50;

  scoresnake.draw({ x: 0, y: 0 });

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

  // Redraw visualization with new dimensions
  if (dataLoaded && scoresnake) {
    scoresnake.update(tennisMatch);
    redraw();
  }
}