// ====== Match Data Layer ======
// Data loading, CSV parsing, match ID parsing, filtering

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
    totalFiles: 6,
    loadedFiles: 0,
    currentFile: '',
    totalMatches: 0
};

let parsedMatchCache = {};

const ROUND_PATTERN = /^(F|SF|QF|R\d{1,3}|RR\d?|BR|Q\d|PQ|PO|ER)$/i;

// Round selector constants
const ROUND_ORDER = ['Q1', 'Q2', 'Q3', 'R128', 'R64', 'R32', 'R16', 'QF', 'SF', 'F'];
const ROUND_FULL_NAMES = {
    'Q1': 'Qualifying R1',
    'Q2': 'Qualifying R2',
    'Q3': 'Qualifying R3',
    'R128': 'First round',
    'R64': 'Second round',
    'R32': 'Third round',
    'R16': 'Fourth round',
    'QF': 'Quarterfinals',
    'SF': 'Semifinals',
    'F': 'Final'
};

// State for round selector
let roundSelectorMin = 'Q1'; // default: include all rounds from qualifiers through final

function getRoundFullName(roundCode) {
    if (!roundCode) return '';
    let upper = roundCode.toUpperCase();
    if (ROUND_FULL_NAMES[upper]) return ROUND_FULL_NAMES[upper];
    if (/^Q\d$/i.test(roundCode)) return 'Qualifiers';
    if (/^RR\d?$/i.test(roundCode)) return 'Round Robin';
    if (/^BR$/i.test(roundCode)) return 'Bronze Medal';
    if (/^PQ$/i.test(roundCode)) return 'Pre-Qualifying';
    if (/^PO$/i.test(roundCode)) return 'Play-off';
    return roundCode;
}

function isStandardRound(roundCode) {
    return ROUND_ORDER.includes(roundCode.toUpperCase());
}

function roundPassesFilter(roundCode) {
    if (!roundCode) return true;
    let upper = roundCode.toUpperCase();

    if (/^P[QO]$/i.test(upper)) upper = 'Q1';
    if (/^RR\d?$/i.test(upper)) upper = 'QF';
    if (/^BR$/i.test(upper)) upper = 'SF';

    if (isStandardRound(upper)) {
        let minIndex = ROUND_ORDER.indexOf(roundSelectorMin);
        let roundIndex = ROUND_ORDER.indexOf(upper);
        return roundIndex >= minIndex;
    } else {
        return true;
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

    let roundIndex = -1;
    for (let i = 2; i < parts.length; i++) {
        if (ROUND_PATTERN.test(parts[i])) {
            roundIndex = i;
            break;
        }
    }

    if (roundIndex === -1) {
        let tournament = parts[2] || '';
        let round = (parts[3] || '').trim();
        let player1 = parts[4] || '';
        let player2 = parts.slice(5).join('-') || '';
        let result = { year, month, day, gender, tournament, round, player1, player2 };
        parsedMatchCache[matchId] = result;
        return result;
    }

    let tournament = parts.slice(2, roundIndex).join('-');
    let round = parts[roundIndex].trim();

    let playerParts = parts.slice(roundIndex + 1);
    let player1 = '';
    let player2 = '';

    if (playerParts.length === 0) {
        // No players
    } else if (playerParts.length === 1) {
        player1 = playerParts[0];
    } else if (playerParts.length === 2 && playerParts[0].includes('_') && playerParts[1].includes('_')) {
        player1 = playerParts[0];
        player2 = playerParts[1];
    } else {
        let accumulated = [];
        let foundFirstPlayerUnderscore = false;
        let splitIndex = playerParts.length;

        for (let i = 0; i < playerParts.length; i++) {
            accumulated.push(playerParts[i]);
            if (!foundFirstPlayerUnderscore) {
                if (accumulated.join('-').includes('_')) {
                    foundFirstPlayerUnderscore = true;
                }
            } else {
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

function getMatchMetadata(matchId) {
    return parseMatchId(matchId);
}

// Extract unique match IDs from a points CSV file
function extractMatchIdsFromPointsFile(csvText) {
    const lines = csvText.split('\n');
    const matchIds = new Set();

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

// Download a single CSV file
async function downloadCSVFile(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response.text();
}

// Load all match databases
async function loadAllMatchData() {
    try {
        updateProgress(10, 'Loading tennis match database...');

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

        for (let i = 0; i < pointsFiles.length; i++) {
            const file = pointsFiles[i];

            updateProgress(
                10 + (i / pointsFiles.length) * 80,
                `Loading ${file.description}...`
            );

            const csvText = await downloadCSVFile(file.url);

            pointsFileCache[file.key] = {
                csvText: csvText,
                loaded: true
            };

            const matchIds = extractMatchIdsFromPointsFile(csvText);
            allMatchIds.push(...matchIds);

            loadingStats.loadedFiles++;
        }

        allMatchIds = [...new Set(allMatchIds)].sort();
        loadingStats.totalMatches = allMatchIds.length;

        fullDataLoaded = true;

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

// Load a specific match by ID from the appropriate CSV source
function loadMatchById(matchId, callback) {
    const dateStr = matchId.substring(0, 8);
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

    if (pointsFileCache[cacheKey].loaded) {
        extractMatchFromPointsData(matchId, pointsFileCache[cacheKey].csvText, callback);
        return;
    }

    fetch(pointsUrl)
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            return response.text();
        })
        .then(csvText => {
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
// NOTE: Uses p5's loadTable() for final CSV parsing
function extractMatchFromPointsData(matchId, csvText, callback) {
    const lines = csvText.split('\n');
    const headers = lines[0].split(',');

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
        updateProgress(0, `No point-by-point data available for this match. Try another match.`);

        setTimeout(() => {
            findAndLoadRandomMatchWithData();
        }, 2000);

        return;
    }

    const tableData = headers.join(',') + '\n' + matchLines.join('\n');

    // p5's loadTable is used here for compatibility with parseMatchData
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
    const recentMatches = allMatchIds.filter(id => {
        const year = parseInt(id.substring(0, 4));
        return year >= 2020;
    });

    if (recentMatches.length === 0) {
        if (allMatchIds.length > 0) {
            const randomMatch = allMatchIds[Math.floor(Math.random() * allMatchIds.length)];
            loadMatch(randomMatch);
        }
        return;
    }

    const randomMatch = recentMatches[Math.floor(Math.random() * recentMatches.length)];
    updateProgress(50, `Searching for match data: ${randomMatch.substring(0, 20)}...`);
    loadMatch(randomMatch);
}

// ====== Search/filter helpers ======

function getSearchValues() {
    let searchDateYear = document.getElementById('search-date-year');
    let searchTournament = document.getElementById('search-tournament');
    let searchPlayer1 = document.getElementById('search-player1');
    let searchPlayer2 = document.getElementById('search-player2');

    let yearValue = searchDateYear ? searchDateYear.value : '';
    if (yearValue.length === 2) yearValue = '20' + yearValue;

    let genderValue = '';
    if (typeof genderPreviewOverride === 'string') {
        genderValue = genderPreviewOverride;
    } else {
        let selectedBtn = document.querySelector('#gender-selector .gender-btn.gender-selected');
        genderValue = selectedBtn ? selectedBtn.dataset.gender : '';
    }

    return {
        date: yearValue.toLowerCase(),
        year: yearValue.toLowerCase(),
        gender: (genderValue || '').toLowerCase(),
        tournament: searchTournament ? searchTournament.value.toLowerCase().replace(/\s+/g, '_') : '',
        player1: searchPlayer1 ? searchPlayer1.value.toLowerCase().replace(/\s+/g, '_') : '',
        player2: searchPlayer2 ? searchPlayer2.value.toLowerCase().replace(/\s+/g, '_') : '',
    };
}

function filterMatchesWith(sv) {
    return allMatchIds.filter(matchId => {
        let parsed = parseMatchId(matchId);
        if (!parsed) return false;

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

function extractFieldValues(data, fieldId) {
    if (typeof data === 'string') {
        data = getMatchMetadata(data);
    }

    if (!data) return [];

    switch (fieldId) {
        case 'search-date-year':
            return [data.Date ? data.Date.slice(0, 4) : (data.year || '')];
        case 'search-tournament':
            let tournament = data.Tournament || data.tournament || '';
            return [tournament];
        case 'search-player1':
            let player2Input = document.getElementById('search-player2');
            let excludePlayer2 = player2Input ? player2Input.value.replace(/\s+/g, '_') : '';
            let players1 = [
                (data['Player 1'] || data.player1 || '').replace(/\s+/g, '_'),
                (data['Player 2'] || data.player2 || '').replace(/\s+/g, '_')
            ].filter(p => p && p !== excludePlayer2);
            return players1;
        case 'search-player2':
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
        case 'search-date-year': return 0;
        case 'search-tournament': return 1;
        case 'search-player1':
        case 'search-player2': return 2;
        default: return -1;
    }
}

function formatFacetValue(value, fieldId) {
    if (fieldId === 'search-tournament' || fieldId === 'search-player1' || fieldId === 'search-player2') {
        return value.replace(/_/g, ' ');
    }
    return value;
}
