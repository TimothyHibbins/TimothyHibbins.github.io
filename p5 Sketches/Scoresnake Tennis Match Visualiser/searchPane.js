// ====== Search Pane UI ======
// All DOM building, event handling, search interface logic

let activeSearchField = null;
let currentFacetOptions = [];
let validatedFields = {};
let searchPlayers = [];
let genderPreviewOverride = null;

let currentMatches = [];
let matchesRendered = 0;
const MATCHES_BATCH_SIZE = 50;

// Add debouncing for preview
let previewTimeout = null;
let currentPreviewMatch = null;

// ====== Player sync ======

function syncPlayersToUI() {
    let searchPlayer1 = document.getElementById('search-player1');
    let searchPlayer2 = document.getElementById('search-player2');
    let playerFields = document.getElementById('player-fields');

    if (!searchPlayer1 || !searchPlayer2) return;

    searchPlayer1.value = searchPlayers[0] || '';
    searchPlayer2.value = searchPlayers[1] || '';

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

    let arrayChanged = newPlayers.length !== searchPlayers.length ||
        newPlayers.some((player, index) => player !== searchPlayers[index]);

    if (arrayChanged) {
        searchPlayers = newPlayers;
    }
}

function addPlayerToSearchFromMatch(playerName) {
    let searchPlayer1 = document.getElementById('search-player1');
    let searchPlayer2 = document.getElementById('search-player2');
    [searchPlayer1, searchPlayer2].forEach(field => {
        if (field && field.dataset.originalValue !== undefined) {
            delete field.dataset.originalValue;
        }
        if (field) field.style.color = '';
    });

    if (searchPlayers.includes(playerName)) {
        return;
    }

    if (searchPlayers.length === 0) {
        searchPlayers = [playerName];
        validatedFields['search-player1'] = true;
        validatedFields['search-player2'] = false;
    } else if (searchPlayers.length === 1) {
        searchPlayers = [searchPlayers[0], playerName];
        validatedFields['search-player2'] = true;
    } else {
        searchPlayers = [searchPlayers[0], playerName];
        validatedFields['search-player2'] = true;
    }

    syncPlayersToUI();
    handleSearchInput();
}

// ====== Progress ======

function updateProgress(percent, message) {
    let progressText = document.getElementById('progress-text');
    let progressBar = document.getElementById('progress-bar');

    if (progressText) progressText.textContent = message;
    if (progressBar) progressBar.style.width = percent + '%';
}

// ====== Player field layout ======

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
    span.textContent = input.value || ' ';
    let width = span.getBoundingClientRect().width;
    input.style.minWidth = '0';
    input.style.width = width + 'px';
}

function syncPlayer2Visibility(searchPlayer1, searchPlayer2, playerFields) {
    if (!searchPlayer1 || !searchPlayer2) return;
    if (searchPlayer1.value.trim() === '') {
        if (searchPlayer2.value.trim() !== '') {
            searchPlayer1.value = searchPlayer2.value;
            if (validatedFields['search-player2']) {
                validatedFields['search-player1'] = true;
                searchPlayer1.classList.add('field-validated');
                searchPlayer1._skipValidationClear = true;
                setTimeout(() => { searchPlayer1._skipValidationClear = false; }, 0);
            }
            validatedFields['search-player2'] = false;
            searchPlayer2.classList.remove('field-validated');
        }
        searchPlayer2.value = '';
        syncUIToPlayers();
        searchPlayer2.classList.add('player-field-hidden');
        if (playerFields) {
            playerFields.classList.remove('player2-visible');
            if (searchPlayer1.value.trim() !== '') {
                playerFields.classList.add('player1-has-content');
            } else {
                playerFields.classList.remove('player1-has-content');
            }
        }
    } else {
        if (playerFields) playerFields.classList.add('player1-has-content');
    }
    updatePlayer1Width(searchPlayer1, playerFields);
}

// ====== Match display ======

function updateMatchDisplay(matchId) {
    let displayElement = document.getElementById('match-display');
    if (displayElement) {
        displayElement.innerHTML = '';
        displayElement.appendChild(createMatchRow(matchId, true));
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
        item.appendChild(createMatchRow(matchId, false));

        item.addEventListener('mouseenter', function () {
            previewMatch(matchId);
        });

        item.addEventListener('click', function () {
            window.currentSelectedMatch = matchId;
            window.currentlyDisplayedMatch = matchId;
            loadMatch(matchId);
            if (searchDateYear) searchDateYear.value = '';
            if (searchTournament) searchTournament.value = '';
            if (searchPlayer1) {
                searchPlayer1.value = '';
                syncUIToPlayers();
            }
            if (searchPlayer2) {
                searchPlayer2.value = '';
                syncUIToPlayers();
                searchPlayer2.classList.add('player-field-hidden');
            }
            if (playerFields) playerFields.classList.remove('player2-visible');
            handleSearchInput();
        });

        dropdown.appendChild(item);
    });

    matchesRendered += nextChunk.length;
}

// ====== Round selector UI ======

function updateGenderSelectorUI() {
    // No-op: styling handled by .gender-selected class
}

function updateRoundSelectorUI(previewMin = null, previewOtherTypes = null, hoveredRound = null) {
    let buttons = document.querySelectorAll('#round-selector .round-btn');

    let activeMin = previewMin !== null ? previewMin : roundSelectorMin;
    let minIndex = ROUND_ORDER.indexOf(activeMin);
    let actualMinIndex = ROUND_ORDER.indexOf(roundSelectorMin);

    buttons.forEach(btn => {
        let round = btn.dataset.round;
        let index = ROUND_ORDER.indexOf(round);
        btn.classList.remove('round-in-range', 'round-preview-add', 'round-preview-remove');

        if (previewMin !== null && round !== hoveredRound) {
            let isCurrentlySelected = index >= actualMinIndex;
            let wouldBeSelected = index >= minIndex;

            if (wouldBeSelected) {
                if (isCurrentlySelected) {
                    btn.classList.add('round-in-range');
                } else {
                    btn.classList.add('round-preview-add');
                }
            } else {
                if (isCurrentlySelected) {
                    btn.classList.add('round-preview-remove');
                }
            }
        } else if (previewMin === null || round === hoveredRound) {
            if (index >= minIndex) {
                btn.classList.add('round-in-range');
            }
        }
    });
}

// ====== Match row builder ======

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

    if (isCurrentMatch) {
        dateCell.addEventListener('mouseenter', function (e) {
            if (!fullDataLoaded) return;
            showCustomTooltip(e, 'Click to fill date field');
            highlightMatchField(dateCell, 'date');
            previewFieldValue('search-date-year', year);
        });
        dateCell.addEventListener('mouseleave', function () {
            hideCustomTooltip();
            unhighlightMatchField(dateCell, 'date');
            clearFieldPreviews(['search-date-year']);
        });
    }

    dateCell.addEventListener('click', function () {
        let field = document.getElementById('search-date-year');
        if (field && field.dataset.originalValue !== undefined) {
            delete field.dataset.originalValue;
        }
        if (field) field.style.color = '';

        document.getElementById('search-date-year').value = year;
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

    if (round) {
        let roundDesc = document.createElement('span');
        roundDesc.className = 'round-description';
        let genderPrefix = gender === 'M' ? "Men's " : gender === 'W' ? "Women's " : '';
        roundDesc.textContent = genderPrefix + getRoundFullName(round);
        tournamentCell.appendChild(roundDesc);
    }

    if (isCurrentMatch) {
        tournamentCell.addEventListener('mouseenter', function (e) {
            if (!fullDataLoaded) return;
            showCustomTooltip(e, 'Click to fill tournament field');
            highlightMatchField(tournamentCell, 'tournament');
            previewFieldValue('search-tournament', tournament);
        });
        tournamentCell.addEventListener('mouseleave', function () {
            hideCustomTooltip();
            unhighlightMatchField(tournamentCell, 'tournament');
            clearFieldPreviews(['search-tournament']);
        });
    }

    tournamentCell.addEventListener('click', function () {
        let field = document.getElementById('search-tournament');
        if (field.dataset.originalValue !== undefined) {
            delete field.dataset.originalValue;
        }
        field.style.color = '';

        field.value = tournament;
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

    if (isCurrentMatch) {
        let sepWidth = sep.offsetWidth || 20;
        let player1Width = player1Span.offsetWidth || 100;
        let vsStart = player1Width + 4;
        let vsCenter = vsStart + (sepWidth / 2);
        let leftWidth = `${vsCenter}px`;
        let rightStart = `${vsCenter}px`;

        let player1Overlay = document.createElement('div');
        player1Overlay.style.position = 'absolute';
        player1Overlay.style.left = '0';
        player1Overlay.style.top = '0';
        player1Overlay.style.width = leftWidth;
        player1Overlay.style.height = '100%';
        player1Overlay.style.cursor = 'pointer';
        player1Overlay.style.zIndex = '1';

        player1Overlay.addEventListener('mouseenter', function (e) {
            if (!fullDataLoaded) return;

            showCustomTooltip(e, 'Click to add player');
            highlightMatchField(player1Span, 'player1');

            let searchPlayer1 = document.getElementById('search-player1');
            let searchPlayer2 = document.getElementById('search-player2');

            let isDuplicate = searchPlayers.some(p =>
                p.toLowerCase().replace(/\s+/g, '_') === player1.toLowerCase().replace(/\s+/g, '_')
            );

            if (!isDuplicate) {
                if (!searchPlayer1.value.trim()) {
                    previewFieldValue('search-player1', player1);
                } else if (!searchPlayer2.value.trim()) {
                    previewFieldValue('search-player2', player1);
                } else {
                    previewFieldValue('search-player2', player1);
                }
            }
        });
        player1Overlay.addEventListener('mouseleave', function () {
            hideCustomTooltip();
            unhighlightMatchField(player1Span, 'player1');
            clearFieldPreviews(['search-player1', 'search-player2']);
        });
        player1Overlay.addEventListener('click', function () {
            addPlayerToSearchFromMatch(player1);
        });

        let player2Overlay = document.createElement('div');
        player2Overlay.style.position = 'absolute';
        player2Overlay.style.left = rightStart;
        player2Overlay.style.top = '0';
        player2Overlay.style.right = '0';
        player2Overlay.style.height = '100%';
        player2Overlay.style.cursor = 'pointer';
        player2Overlay.style.zIndex = '1';

        player2Overlay.addEventListener('mouseenter', function (e) {
            if (!fullDataLoaded) return;

            showCustomTooltip(e, 'Click to add player');
            highlightMatchField(player2Span, 'player2');

            let searchPlayer1 = document.getElementById('search-player1');
            let searchPlayer2 = document.getElementById('search-player2');

            let isDuplicate = searchPlayers.some(p =>
                p.toLowerCase().replace(/\s+/g, '_') === player2.toLowerCase().replace(/\s+/g, '_')
            );

            if (!isDuplicate) {
                if (!searchPlayer1.value.trim()) {
                    previewFieldValue('search-player1', player2);
                } else if (!searchPlayer2.value.trim()) {
                    previewFieldValue('search-player2', player2);
                } else {
                    previewFieldValue('search-player2', player2);
                }
            }
        });
        player2Overlay.addEventListener('mouseleave', function () {
            hideCustomTooltip();
            unhighlightMatchField(player2Span, 'player2');
            clearFieldPreviews(['search-player1', 'search-player2']);
        });
        player2Overlay.addEventListener('click', function () {
            addPlayerToSearchFromMatch(player2);
        });

        let vsOverlay = document.createElement('div');
        vsOverlay.style.position = 'absolute';
        vsOverlay.style.left = '0';
        vsOverlay.style.top = '0';
        vsOverlay.style.right = '0';
        vsOverlay.style.height = '100%';
        vsOverlay.style.cursor = 'pointer';
        vsOverlay.style.zIndex = '2';
        vsOverlay.style.pointerEvents = 'none';

        let enableVsOverlay = function () {
            let sepRect = sep.getBoundingClientRect();
            let playersRect = players.getBoundingClientRect();
            let sepLeft = sepRect.left - playersRect.left;
            let sepRight = sepRect.right - playersRect.left;

            vsOverlay.style.left = `${sepLeft}px`;
            vsOverlay.style.width = `${sepRight - sepLeft}px`;
            vsOverlay.style.pointerEvents = 'auto';
        };

        vsOverlay.addEventListener('mouseenter', function (e) {
            if (!fullDataLoaded) return;

            showCustomTooltip(e, 'Click to add both players');
            highlightMatchField(player1Span, 'player1');
            highlightMatchField(player2Span, 'player2');

            previewFieldValue('search-player1', player1);
            previewFieldValue('search-player2', player2);
        });

        vsOverlay.addEventListener('mouseleave', function () {
            hideCustomTooltip();
            unhighlightMatchField(player1Span, 'player1');
            unhighlightMatchField(player2Span, 'player2');
            clearFieldPreviews(['search-player1', 'search-player2']);
        });

        vsOverlay.addEventListener('click', function () {
            let searchPlayer1 = document.getElementById('search-player1');
            let searchPlayer2 = document.getElementById('search-player2');

            [searchPlayer1, searchPlayer2].forEach(field => {
                if (field && field.dataset.originalValue !== undefined) {
                    delete field.dataset.originalValue;
                }
                if (field) field.style.color = '';
            });

            searchPlayer1.value = player1;
            searchPlayer2.value = player2;

            let playerFields = document.getElementById('player-fields');
            searchPlayer2.classList.remove('player-field-hidden');
            if (playerFields) playerFields.classList.add('player2-visible');

            searchPlayers = [player1, player2];
            syncPlayersToUI();

            validatedFields['search-player1'] = true;
            validatedFields['search-player2'] = true;
            searchPlayer1.classList.add('field-validated');
            searchPlayer2.classList.add('field-validated');

            handleSearchInput();
        });

        setTimeout(() => {
            let sepRect = sep.getBoundingClientRect();
            let playersRect = players.getBoundingClientRect();
            let sepCenterFromLeft = (sepRect.left + sepRect.width / 2) - playersRect.left;

            player1Overlay.style.width = `${sepCenterFromLeft}px`;
            player2Overlay.style.left = `${sepCenterFromLeft}px`;

            players.appendChild(player1Overlay);
            players.appendChild(player2Overlay);

            enableVsOverlay();
            players.appendChild(vsOverlay);
        }, 1);
    }

    row.appendChild(players);

    // For dropdown rows, highlight cells that match validated search fields
    if (!isCurrentMatch) {
        if (validatedFields['search-date-year']) {
            let searchYear = document.getElementById('search-date-year');
            if (searchYear && searchYear.value && year === searchYear.value) {
                yearSpan.style.color = '#4ade80';
            }
        }
        if (validatedFields['search-tournament']) {
            let searchTournament = document.getElementById('search-tournament');
            if (searchTournament && searchTournament.value) {
                let searchVal = searchTournament.value.toLowerCase().replace(/\s+/g, '_');
                let matchVal = tournament.toLowerCase().replace(/\s+/g, '_');
                if (matchVal === searchVal) {
                    tournamentText.style.color = '#4ade80';
                }
            }
        }
        if (validatedFields['search-player1'] || validatedFields['search-player2']) {
            let p1Field = document.getElementById('search-player1');
            let p2Field = document.getElementById('search-player2');
            let validatedPlayerNames = [];
            if (validatedFields['search-player1'] && p1Field && p1Field.value) {
                validatedPlayerNames.push(p1Field.value.toLowerCase().replace(/\s+/g, '_'));
            }
            if (validatedFields['search-player2'] && p2Field && p2Field.value) {
                validatedPlayerNames.push(p2Field.value.toLowerCase().replace(/\s+/g, '_'));
            }
            let p1Match = player1.toLowerCase().replace(/\s+/g, '_');
            let p2Match = player2.toLowerCase().replace(/\s+/g, '_');
            if (validatedPlayerNames.includes(p1Match)) {
                player1Span.style.color = '#4ade80';
            }
            if (validatedPlayerNames.includes(p2Match)) {
                player2Span.style.color = '#4ade80';
            }
        }
    }

    return row;
}

// ====== Tooltip system ======

function showCustomTooltip(event, text) {
    const tooltip = document.getElementById('custom-tooltip');
    if (!tooltip) return;

    tooltip.textContent = text;
    tooltip.classList.remove('hidden');

    const rect = event.target.getBoundingClientRect();
    tooltip.style.left = (rect.left + rect.width / 2) + 'px';
    tooltip.style.top = (rect.top - 35) + 'px';
}

function hideCustomTooltip() {
    const tooltip = document.getElementById('custom-tooltip');
    if (!tooltip) return;

    tooltip.classList.add('hidden');
}

// ====== Field highlighting ======

function highlightMatchField(element, fieldType) {
    element.style.color = '#4ade80';

    const labels = document.querySelectorAll('.search-label');
    let labelIndex;

    switch (fieldType) {
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
    element.style.color = '';

    const labels = document.querySelectorAll('.search-label');
    let labelIndex;

    switch (fieldType) {
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

// ====== Field preview system ======

function previewFieldValue(fieldId, value) {
    const field = document.getElementById(fieldId);
    if (!field) return;

    if (!field.dataset.originalValue) {
        field.dataset.originalValue = field.value;
    }

    field.value = value;
    field.style.color = 'rgba(74, 222, 128, 0.6)';

    if (fieldId === 'search-player2') {
        let searchPlayer2 = document.getElementById('search-player2');
        let playerFields = document.getElementById('player-fields');
        if (searchPlayer2 && searchPlayer2.classList.contains('player-field-hidden')) {
            if (!searchPlayer2.dataset.originallyHidden) {
                searchPlayer2.dataset.originallyHidden = 'true';
            }
            searchPlayer2.classList.remove('player-field-hidden');
            if (playerFields) playerFields.classList.add('player2-visible');
        }
    }

    if (fieldId === 'search-player1' || fieldId === 'search-player2') {
        triggerSearchWithCurrentValues();
    } else {
        handleSearchInput();
    }
}

function clearFieldPreviews(fieldIds) {
    fieldIds.forEach(fieldId => {
        const field = document.getElementById(fieldId);
        if (!field) return;

        if (field.dataset.originalValue !== undefined) {
            field.value = field.dataset.originalValue;
            delete field.dataset.originalValue;
        }

        field.style.color = '';

        if (fieldId === 'search-player2' && field.dataset.originallyHidden) {
            let playerFields = document.getElementById('player-fields');
            field.classList.add('player-field-hidden');
            if (playerFields) playerFields.classList.remove('player2-visible');
            delete field.dataset.originallyHidden;
        }
    });

    handleSearchInput();
}

// ====== Match preview ======

function previewMatch(matchId) {
    if (previewTimeout) {
        clearTimeout(previewTimeout);
    }

    if (currentPreviewMatch === matchId) {
        return;
    }

    previewTimeout = setTimeout(() => {
        currentPreviewMatch = matchId;

        if (!window.currentSelectedMatch) {
            window.currentSelectedMatch = currentMatchId;
        }

        loadMatchById(matchId, () => {
            if (currentPreviewMatch === matchId && matchData && matchData.getRowCount() > 0) {
                try {
                    parseMatchData();
                    if (tennisMatch) {
                        currentScoresnake = new ScoresnakeChart(tennisMatch);
                        redraw();
                    }
                } catch (e) {
                    console.warn('Preview failed for match:', matchId, e.message);
                }
            }
        });
    }, 50);
}

function stopPreview() {
    currentPreviewMatch = null;
    if (previewTimeout) {
        clearTimeout(previewTimeout);
        previewTimeout = null;
    }

    if (window.currentSelectedMatch) {
        loadMatchById(window.currentSelectedMatch, () => {
            if (currentPreviewMatch === null && matchData && matchData.getRowCount() > 0) {
                parseMatchData();
                if (tennisMatch) {
                    currentScoresnake = new ScoresnakeChart(tennisMatch);
                    redraw();
                }
            }
        });
    }
}

function updateMatchDisplayInfo(matchId, metadata) {
    let displayElement = document.getElementById('match-display');
    if (displayElement) {
        displayElement.innerHTML = '';
        displayElement.appendChild(createMatchRow(matchId, true));
    }
}

function updateMatchVisualization() {
    if (matchData && typeof parseMatchData === 'function') {
        try {
            parseMatchData();

            if (tennisMatch) {
                currentScoresnake = new ScoresnakeChart(tennisMatch);
            }

            redraw();
        } catch (error) {
            console.error('Error updating match visualization:', error);
        }
    }
}

// ====== Tabs ======

function setupTabs() {
    document.querySelectorAll('#tab-bar .tab-btn').forEach(btn => {
        btn.addEventListener('click', function () {
            let tabId = this.dataset.tab;

            document.querySelectorAll('#tab-bar .tab-btn').forEach(b => b.classList.remove('tab-active'));
            this.classList.add('tab-active');

            document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('tab-panel-active'));
            let panel = document.getElementById('tab-' + tabId);
            if (panel) panel.classList.add('tab-panel-active');
        });
    });

    let matchSearchTab = document.querySelector('.tab-btn[data-tab="match-search"]');
    if (matchSearchTab) matchSearchTab.click();

    let paneToggle = document.getElementById('pane-toggle');
    let sketchPane = document.getElementById('sketch-pane');
    if (paneToggle && sketchPane) {
        let resizeRaf = null;
        function animateResize() {
            if (typeof windowResized === 'function') windowResized();
            resizeRaf = requestAnimationFrame(animateResize);
        }
        paneToggle.addEventListener('click', function () {
            sketchPane.classList.toggle('pane-collapsed');
            if (resizeRaf) cancelAnimationFrame(resizeRaf);
            animateResize();
        });
        sketchPane.addEventListener('transitionend', function (e) {
            if (e.propertyName === 'width' && resizeRaf) {
                cancelAnimationFrame(resizeRaf);
                resizeRaf = null;
                if (typeof windowResized === 'function') windowResized();
            }
        });
    }
}

// ====== Search interface loading setup ======

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

    updateMatchDisplay(matchSpecifier);
    loadingIndicator.classList.remove('loading-hidden');

    if (dropdown) {
        dropdown.classList.remove('dropdown-hidden');
        dropdown.innerHTML = '';
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
            if (activeSearchField === 'search-player2' && dropdown && matchCountBar && matchCountText) {
                renderFacetedDropdown('search-player2', dropdown, matchCountBar, matchCountText);
            }
        });
        syncPlayer2Visibility(searchPlayer1, searchPlayer2, playerFields);
        updatePlayer1Width(searchPlayer1, playerFields);
    }

    if (searchPlayer2) {
        searchPlayer2.addEventListener('input', function () {
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
                    syncUIToPlayers();
                } else if (field === 'player2' && searchPlayer2) {
                    let value = (cell.dataset.value || '').replace(/_/g, ' ');
                    if (searchPlayer1 && searchPlayer1.value.trim() === '') {
                        searchPlayer1.value = value;
                        syncUIToPlayers();
                        updatePlayer1Width(searchPlayer1, playerFields);
                    } else {
                        searchPlayer2.value = value;
                        syncUIToPlayers();
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

    // Arrow key handling for search fields
    window.addEventListener('keydown', function (e) {
        const searchFields = [
            searchDateYear,
            searchTournament,
            searchPlayer1,
            searchPlayer2 && !searchPlayer2.classList.contains('player-field-hidden') ? searchPlayer2 : null
        ].filter(Boolean);

        const currentIndex = searchFields.findIndex(field => field === e.target);
        if (currentIndex === -1) return;

        const currentField = searchFields[currentIndex];
        const nextField = searchFields[currentIndex + 1] || null;
        const prevField = searchFields[currentIndex - 1] || null;

        function completeDateField(field) {
            if (field.id === 'search-date-year' && field.value.length === 2) {
                field.value = '20' + field.value;
                validatedFields['search-date-year'] = true;
                field.classList.add('field-validated');
            } else if (field.id === 'search-date-year' && field.value.length === 4) {
                validatedFields['search-date-year'] = true;
                field.classList.add('field-validated');
            }
        }

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

    // Year field auto-completion
    if (searchDateYear) {
        let yearLastActionWasDelete = false;

        searchDateYear.addEventListener('input', function (e) {
            yearLastActionWasDelete = e.inputType && (e.inputType.startsWith('delete') || e.inputType === 'historyUndo');

            this.value = this.value.replace(/\s/g, '');

            if (this.value.length === 2 && !yearLastActionWasDelete) {
                this.value = '20' + this.value;
                validatedFields['search-date-year'] = true;
                this.classList.add('field-validated');
                this._skipValidationClear = true;
                if (searchTournament) {
                    searchTournament.focus();
                }
            }

            if (this.value.length === 4 && !yearLastActionWasDelete) {
                validatedFields['search-date-year'] = true;
                this.classList.add('field-validated');
                this._skipValidationClear = true;
                if (searchTournament) {
                    searchTournament.focus();
                }
            }
        });

        searchDateYear.addEventListener('blur', function () {
            if (this.value.length === 4 && !validatedFields['search-date-year']) {
                validatedFields['search-date-year'] = true;
                this.classList.add('field-validated');
            }
            if (this.value.length === 2 && !yearLastActionWasDelete) {
                this.value = '20' + this.value;
                validatedFields['search-date-year'] = true;
                this.classList.add('field-validated');
                handleSearchInput();
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

    // Random match button
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

    // Fullscreen button
    let fullscreenBtn = document.getElementById('tab-bar-fullscreen');
    if (fullscreenBtn) {
        function updateFullscreenButton() {
            let btnText = fullscreenBtn.querySelector('.text');
            if (document.fullscreenElement) {
                btnText.textContent = 'Exit Fullscreen';
            } else {
                btnText.textContent = 'Fullscreen';
            }
        }

        fullscreenBtn.addEventListener('click', function () {
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen();
            } else {
                document.exitFullscreen();
            }
        });

        document.addEventListener('fullscreenchange', updateFullscreenButton);
    }

    // Input validation clearing
    [searchDateYear, searchTournament, searchPlayer1, searchPlayer2]
        .filter(Boolean)
        .forEach(input => {
            input.addEventListener('input', function () {
                if (this._skipValidationClear) {
                    handleSearchInput();
                    return;
                }
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

    // Capture-phase handler for Enter/Tab autocomplete
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

// ====== Faceted dropdown ======

function renderFacetedDropdown(focusedFieldId, dropdown, matchCountBar, matchCountText) {
    let baseMatches = filterMatchesExcluding(focusedFieldId);

    let valueCounts = {};
    let valueMatchIds = {};

    baseMatches.forEach(matchId => {
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

    let focusedInput = document.getElementById(focusedFieldId);
    let partialText = focusedInput ? focusedInput.value.toLowerCase().replace(/\s+/g, '_') : '';

    if (focusedFieldId === 'search-date-year' && partialText.length === 2) {
        partialText = '20' + partialText;
    }

    let filteredValues = Object.keys(valueCounts).filter(value => {
        if (!partialText) return true;
        let normalizedValue = value.toLowerCase().replace(/\s+/g, '_');
        return normalizedValue.includes(partialText);
    });

    filteredValues.sort((a, b) => valueCounts[b] - valueCounts[a]);

    currentFacetOptions = filteredValues;

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

            let inner = document.createElement('div');
            inner.className = 'facet-active-inner';

            let valueBtn = document.createElement('button');
            valueBtn.className = 'facet-value-btn';
            valueBtn.textContent = formatFacetValue(value, focusedFieldId);

            let countSpan = document.createElement('span');
            countSpan.className = 'facet-count';
            countSpan.textContent = count;

            toggleBtn = document.createElement('button');
            toggleBtn.className = 'facet-toggle-btn';
            toggleBtn.textContent = '\u25B6';

            inner.appendChild(valueBtn);
            inner.appendChild(countSpan);
            inner.appendChild(toggleBtn);
            cell.appendChild(inner);

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
        item.appendChild(createMatchRow(matchId, false));

        item.addEventListener('mouseenter', function () {
            previewMatch(matchId);
        });

        item.addEventListener('click', function () {
            loadMatch(matchId);
            ['search-date-year', 'search-tournament'].forEach(id => {
                let el = document.getElementById(id);
                if (el) el.value = '';
            });
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

    validatedFields[fieldId] = true;
    input.classList.add('field-validated');

    if (fieldId === 'search-player1' || fieldId === 'search-player2') {
        syncUIToPlayers();
    }

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

function triggerSearchWithCurrentValues() {
    let searchPlayer1 = document.getElementById('search-player1');
    let searchPlayer2 = document.getElementById('search-player2');
    let playerFields = document.getElementById('player-fields');
    let dropdown = document.getElementById('dropdown');
    let matchCountBar = document.getElementById('match-count-bar');
    let matchCountText = document.getElementById('match-count-text');

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

    let sv = getSearchValues();
    let hasAnyInput = sv.date || sv.gender || sv.tournament || sv.round || sv.player1 || sv.player2;

    let matches;
    if (!hasAnyInput) {
        matches = allMatchIds.slice();
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

    let isPreview = (searchPlayer1 && searchPlayer1.dataset.originalValue) ||
        (searchPlayer2 && searchPlayer2.dataset.originalValue) ||
        (document.getElementById('search-date-year') && document.getElementById('search-date-year').dataset.originalValue) ||
        (document.getElementById('search-tournament') && document.getElementById('search-tournament').dataset.originalValue);

    if (!isPreview && (document.activeElement === searchPlayer1 || document.activeElement === searchPlayer2)) {
        syncUIToPlayers();
    }

    if (!isPreview) {
        syncPlayersToUI();
    }

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

    if (activeSearchField) {
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

    let sv = getSearchValues();
    let hasAnyInput = sv.date || sv.gender || sv.tournament || sv.round || sv.player1 || sv.player2;

    let matches;
    if (!hasAnyInput) {
        matches = allMatchIds.slice();
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

// ====== Search interface post-data-load setup ======

function setupSearchInterface() {
    let loadingIndicator = document.getElementById('loading-indicator');
    let dropdown = document.getElementById('dropdown');
    let searchDateYear = document.getElementById('search-date-year');
    let searchTournament = document.getElementById('search-tournament');
    let searchPlayer1 = document.getElementById('search-player1');
    let searchPlayer2 = document.getElementById('search-player2');
    let randomMatchBtn = document.getElementById('random-match-btn');

    if (searchPlayer1.value || searchPlayer2.value) {
        syncUIToPlayers();
    }

    let genderRadios = document.querySelectorAll('input[name="gender"]');
    genderRadios.forEach(radio => {
        radio.addEventListener('change', function () {
            handleSearchInput();
        });
    });

    document.querySelectorAll('#round-selector .round-btn').forEach(btn => {
        btn.addEventListener('click', function () {
            roundSelectorMin = this.dataset.round;
            updateRoundSelectorUI();
            handleSearchInput();
        });

        btn.addEventListener('mouseenter', function () {
            if (!fullDataLoaded) return;

            let originalMin = roundSelectorMin;

            roundSelectorMin = this.dataset.round;
            updateRoundSelectorUI(this.dataset.round, null, this.dataset.round);
            handleSearchInput();

            roundSelectorMin = originalMin;
        });

        btn.addEventListener('mouseleave', function () {
            updateRoundSelectorUI();
            handleSearchInput();
        });
    });

    updateRoundSelectorUI();

    document.querySelectorAll('#gender-selector .gender-btn').forEach(btn => {
        btn.addEventListener('click', function () {
            document.querySelectorAll('#gender-selector .gender-btn').forEach(b => b.classList.remove('gender-selected'));
            this.classList.add('gender-selected');
            genderPreviewOverride = null;
            handleSearchInput();
        });

        btn.addEventListener('mouseenter', function () {
            if (!fullDataLoaded) return;
            genderPreviewOverride = this.dataset.gender.toLowerCase();
            handleSearchInput();
        });

        btn.addEventListener('mouseleave', function () {
            genderPreviewOverride = null;
            handleSearchInput();
        });
    });

    let dateContainer = document.getElementById('date-container');
    if (dateContainer && searchDateYear) {
        dateContainer.addEventListener('click', function (e) {
            if (e.target !== searchDateYear) {
                searchDateYear.focus();
            }
        });
    }

    [searchDateYear, searchTournament, searchPlayer1, searchPlayer2].forEach(field => {
        if (field) {
            field.addEventListener('mousedown', function (e) {
                if (this.value && validatedFields[this.id]) {
                    e.preventDefault();
                    this.focus();
                    this.select();
                    return;
                }
                if (!this.value || document.activeElement === this) return;

                let canvas = document.createElement('canvas');
                let ctx = canvas.getContext('2d');
                let style = window.getComputedStyle(this);
                ctx.font = style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily;
                let textWidth = ctx.measureText(this.value).width;

                let rect = this.getBoundingClientRect();
                let paddingLeft = parseFloat(style.paddingLeft) || 0;
                let clickX = e.clientX - rect.left - paddingLeft;

                if (style.textAlign === 'center') {
                    let contentWidth = rect.width - paddingLeft - (parseFloat(style.paddingRight) || 0);
                    let textStart = (contentWidth - textWidth) / 2;
                    if (clickX < textStart || clickX > textStart + textWidth) {
                        e.preventDefault();
                        this.focus();
                        this.select();
                        return;
                    }
                } else {
                    if (clickX > textWidth) {
                        e.preventDefault();
                        this.focus();
                        this.select();
                        return;
                    }
                }
            });
        }
    });

    if (searchPlayer1) {
        searchPlayer1.addEventListener('input', function () {
            if (this._skipValidationClear) {
                return;
            }
            if (validatedFields['search-player1']) {
                validatedFields['search-player1'] = false;
            }
        });
    }

    if (searchPlayer2) {
        searchPlayer2.addEventListener('input', function () {
            if (this._skipValidationClear) {
                return;
            }
            if (validatedFields['search-player2']) {
                validatedFields['search-player2'] = false;
            }
        });
    }

    loadingIndicator.classList.add('loading-hidden');

    if (randomMatchBtn) {
        randomMatchBtn.disabled = false;
    }

    if (dropdown) {
        dropdown.addEventListener('mouseleave', function () {
            stopPreview();
        });
    }

    let hasInput = searchDateYear.value ||
        searchTournament.value || searchPlayer1.value || searchPlayer2.value;
    if (hasInput) {
        handleSearchInput();
    } else {
        handleSearchInput();
    }
}
