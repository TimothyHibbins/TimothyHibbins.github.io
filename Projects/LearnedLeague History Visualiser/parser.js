'use strict';

/**
 * Parse a player's profile HTML page saved from learneague.com/profiles.php.
 *
 * The question history is stored in ul.mktree inside the #QuestionHistory tab.
 * Each top-level <li> represents a subject category; inside it, a table.qh
 * holds one row per question the player has seen.
 *
 * @param {string} htmlText - Raw HTML text of the profile page
 * @returns {{ playerName: string, questions: Array }}
 */
function parseProfile(htmlText) {
    const doc = new DOMParser().parseFromString(htmlText, 'text/html');

    const nameEl = doc.querySelector('h1.namecss');
    const playerName = nameEl ? nameEl.textContent.trim() : 'Unknown Player';

    const questions = [];
    const subjectItems = doc.querySelectorAll('ul.mktree > li');

    for (const li of subjectItems) {
        const catSpan = li.querySelector('span.catname');
        if (!catSpan) continue;
        const subject = catSpan.textContent.trim();

        const rows = li.querySelectorAll('table.qh tr');
        for (const row of rows) {
            // Skip header rows
            if (row.closest('thead')) continue;

            const cells = row.querySelectorAll('td');
            if (cells.length < 3) continue;

            // Three links in the first cell: season / match day / question
            const links = cells[0].querySelectorAll('a');
            if (links.length < 3) continue;

            // Use getAttribute to get raw href values (DOMParser resolves against
            // about:blank, so .href would give malformed absolute URLs)
            const seasonHref = links[0].getAttribute('href') || '';
            const mdHref = links[1].getAttribute('href') || '';
            const qHref = links[2].getAttribute('href') || '';

            const seasonMatch = seasonHref.match(/seasons\.php\?(\d+)/);
            const mdMatch = mdHref.match(/match\.php\?(\d+)&(\d+)/);
            const qMatch = qHref.match(/question\.php\?(\d+)&(\d+)&(\d+)/);

            if (!seasonMatch || !mdMatch || !qMatch) continue;

            const season = parseInt(seasonMatch[1], 10);
            const matchDay = parseInt(mdMatch[2], 10);
            const questionNum = parseInt(qMatch[3], 10);

            // The SVG check/cross icon has aria-label="Check" or aria-label="X"
            const svg = cells[2].querySelector('svg');
            const correct = svg ? svg.getAttribute('aria-label') === 'Check' : false;

            // Question text – textContent strips any inner HTML tags (e.g. <I>)
            const questionText = cells[1].textContent.trim();

            const questionUrl = `https://www.learnedleague.com/question.php?${season}&${matchDay}&${questionNum}`;

            questions.push({ subject, season, matchDay, questionNum, questionText, correct, questionUrl });
        }
    }

    return { playerName, questions };
}

/**
 * Parse a season's home page HTML saved from learneague.com/league.php.
 * Extracts the % of players who answered each question correctly.
 *
 * The MDTable has columns: Match Day | Date | CA | Forf | 9(6) | 0(0) | Q1..Q6
 * Each Q cell has a CSS class like q80 (= 80% correct) and a link with the
 * same number as text.
 *
 * @param {string} htmlText - Raw HTML text of the season home page
 * @returns {Object.<string, number>}  key = "season-md-q", value = % correct
 */
function parseSeason(htmlText) {
    const doc = new DOMParser().parseFromString(htmlText, 'text/html');
    const lookup = {};

    // Season number is in the <h1 class="matchday"> heading, e.g. "LL107 Home"
    const h1 = doc.querySelector('h1.matchday');
    if (!h1) return lookup;
    const seasonMatch = h1.textContent.match(/LL(\d+)/);
    if (!seasonMatch) return lookup;
    const season = parseInt(seasonMatch[1], 10);

    // Find the match-day table (first MDTable; the rundles one has class "rundles")
    const mdTable = doc.querySelector('table.MDTable:not(.rundles)');
    if (!mdTable) return lookup;

    const rows = mdTable.querySelectorAll('tr');
    for (const row of rows) {
        if (row.closest('thead') || row.closest('tfoot')) continue;

        const cells = row.querySelectorAll('td');
        // We need at least 12 columns: MD, Date, CA, Forf, 9(6), 0(0), Q1–Q6
        if (cells.length < 12) continue;

        // First cell must contain a match.php link to identify the match day
        const mdLink = cells[0].querySelector('a');
        if (!mdLink) continue;
        const mdHref = mdLink.getAttribute('href') || '';
        const mdMatch = mdHref.match(/match\.php\?(\d+)&(\d+)/);
        if (!mdMatch) continue;
        const md = parseInt(mdMatch[2], 10);

        // Columns 6–11 are Q1–Q6 (0-indexed)
        for (let q = 1; q <= 6; q++) {
            const cell = cells[5 + q];
            if (!cell) continue;

            // Primary: CSS class q{pct} e.g. "q80"
            const classMatch = (cell.className || '').match(/\bq(\d+)\b/);
            if (classMatch) {
                lookup[`${season}-${md}-${q}`] = parseInt(classMatch[1], 10);
                continue;
            }

            // Fallback: the link text inside the cell is the same number
            const link = cell.querySelector('a');
            if (link) {
                const pct = parseInt(link.textContent.trim(), 10);
                if (!isNaN(pct)) lookup[`${season}-${md}-${q}`] = pct;
            }
        }
    }

    return lookup;
}

/**
 * Parse a TrivialStudies "study" page saved for a Learned League season.
 * Save the page from: https://www.trivialstudies.com/study_1212{season}&shuffle=false
 *
 * Each question cell has id="question_N" and its text contains the line
 * "Season: X - Day: Y - Question: Z". The answer is inside a sibling
 * <div id="ans_N"><b>ANSWER</b></div> (hidden by default on the live page).
 *
 * @param {string} htmlText - Raw HTML text of the TrivialStudies study page
 * @returns {Object.<string, string>}  key = "season-md-q", value = answer text
 */
function parseTrivialStudies(htmlText) {
    const doc = new DOMParser().parseFromString(htmlText, 'text/html');
    const lookup = {};

    const qCells = doc.querySelectorAll('[id^="question_"]');
    for (const cell of qCells) {
        const idx = cell.id.slice('question_'.length);
        const ansDiv = doc.getElementById('ans_' + idx);
        if (!ansDiv) continue;

        // Extract season / day / question number from the embedded metadata line
        const m = cell.textContent.match(/Season:\s*(\d+)\s*-\s*Day:\s*(\d+)\s*-\s*Question:\s*(\d+)/);
        if (!m) continue;  // Skip Midseason Classic and other non-standard entries

        const key = `${parseInt(m[1], 10)}-${parseInt(m[2], 10)}-${parseInt(m[3], 10)}`;
        const bold = ansDiv.querySelector('b');
        if (bold) lookup[key] = bold.textContent.trim();
    }

    return lookup;
}
