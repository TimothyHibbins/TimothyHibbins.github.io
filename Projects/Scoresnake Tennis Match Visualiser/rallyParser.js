// Rally notation parser
// Decodes Jeff Sackmann's Match Charting Project notation into structured shot objects

const SHOT_TYPES = {
    'f': { name: 'forehand', side: 'forehand', category: 'groundstroke' },
    'b': { name: 'backhand', side: 'backhand', category: 'groundstroke' },
    'r': { name: 'forehand slice', side: 'forehand', category: 'slice' },
    's': { name: 'backhand slice', side: 'backhand', category: 'slice' },
    'v': { name: 'forehand volley', side: 'forehand', category: 'volley' },
    'z': { name: 'backhand volley', side: 'backhand', category: 'volley' },
    'o': { name: 'overhead', side: 'forehand', category: 'overhead' },
    'p': { name: 'backhand overhead', side: 'backhand', category: 'overhead' },
    'u': { name: 'forehand drop shot', side: 'forehand', category: 'dropshot' },
    'y': { name: 'backhand drop shot', side: 'backhand', category: 'dropshot' },
    'l': { name: 'forehand lob', side: 'forehand', category: 'lob' },
    'm': { name: 'backhand lob', side: 'backhand', category: 'lob' },
    'h': { name: 'forehand half-volley', side: 'forehand', category: 'halfvolley' },
    'i': { name: 'backhand half-volley', side: 'backhand', category: 'halfvolley' },
    'j': { name: 'forehand swinging volley', side: 'forehand', category: 'swingingvolley' },
    'k': { name: 'backhand swinging volley', side: 'backhand', category: 'swingingvolley' },
    't': { name: 'trick shot', side: 'unknown', category: 'trickshot' },
    'q': { name: 'unknown shot', side: 'unknown', category: 'unknown' }
};

const DIRECTION_NAMES = {
    '1': 'to forehand side',
    '2': 'down the middle',
    '3': 'to backhand side',
    '0': 'unknown direction'
};

const SERVE_DIRECTION_NAMES = {
    '4': 'out wide',
    '5': 'body',
    '6': 'down the T',
    '0': 'unknown direction'
};

const ERROR_TYPES = {
    'n': 'into the net',
    'w': 'wide',
    'd': 'long',
    'x': 'wide and long',
    '!': 'shanked',
    'e': 'unknown error',
    'g': 'foot fault'
};

const RETURN_DEPTH = {
    '7': 'shallow',       // within service boxes
    '8': 'mid-court',     // behind service line, closer to service line than baseline
    '9': 'deep',          // closer to baseline
    '0': 'unknown depth'
};

/**
 * Parse a point's notation into a structured rally object.
 *
 * @param {object} point - A point object from tennisMatch (has .first, .second, .server, .winner, .notes)
 * @returns {object} rally - { serves: [...], shots: [...], outcome, notes }
 */
function parseRally(point) {
    let rally = {
        serves: [],          // Array of serve objects (1 or 2)
        shots: [],           // Array of shot objects (the rally itself, including the return)
        outcome: null,       // { type: 'winner'|'unforcedError'|'forcedError'|'ace'|'unreturnable'|'doubleFault'|'pointPenalty', player: 1|2 }
        totalShots: 0,       // Total shots in the rally (serves + rally shots)
        serverWon: point.server === point.winner
    };

    let firstServeCode = (point.first || '').trim();
    let secondServeCode = (point.second || '').trim();

    // Handle special codes
    if (firstServeCode === 'S') {
        rally.outcome = { type: 'serverWon', description: 'Point awarded to server (missed/unknown)' };
        rally.totalShots = 0;
        return rally;
    }
    if (firstServeCode === 'R') {
        rally.outcome = { type: 'returnerWon', description: 'Point awarded to returner (missed/unknown)' };
        rally.totalShots = 0;
        return rally;
    }
    if (firstServeCode === 'P') {
        rally.outcome = { type: 'pointPenalty', description: 'Point penalty against server', player: point.server === 1 ? 2 : 1 };
        rally.totalShots = 0;
        return rally;
    }
    if (firstServeCode === 'Q') {
        rally.outcome = { type: 'pointPenalty', description: 'Point penalty against returner', player: point.server };
        rally.totalShots = 0;
        return rally;
    }
    if (firstServeCode === 'V') {
        // Time violation - server loses first serve
        rally.serves.push({
            shotNumber: 1,
            hitter: point.server,
            isServe: true,
            serveNumber: 1,
            in: false,
            direction: null,
            directionName: null,
            fault: 'time violation',
            serveAndVolley: false,
            lets: 0,
            ace: false,
            unreturnable: false
        });
        // Continue to second serve if present
        if (secondServeCode) {
            parseServeAndRally(secondServeCode, 2, point, rally);
        }
        rally.totalShots = rally.serves.length + rally.shots.length;
        return rally;
    }

    // Parse first serve
    if (firstServeCode) {
        let firstServeResult = parseServeAndRally(firstServeCode, 1, point, rally);

        // If first serve was a fault, parse second serve
        if (firstServeResult.fault && secondServeCode) {
            parseServeAndRally(secondServeCode, 2, point, rally);
        }
        // If first serve was a fault and no second serve code, it's unusual (data issue)
        else if (firstServeResult.fault && !secondServeCode) {
            rally.outcome = { type: 'doubleFault', description: 'Double fault (missing second serve data)' };
        }
    }

    // If we have no outcome yet but the last serve was a fault (double fault)
    if (!rally.outcome && rally.serves.length === 2 && rally.serves[1].fault) {
        rally.outcome = {
            type: 'doubleFault',
            description: `Double fault (${rally.serves[1].fault})`,
            player: point.server === 1 ? 2 : 1  // returner wins
        };
    }

    rally.totalShots = rally.serves.length + rally.shots.length;
    return rally;
}

/**
 * Parse a serve+rally code string (the contents of a "1st" or "2nd" cell).
 * Adds serve and shots to the rally object. Returns the serve info.
 */
function parseServeAndRally(code, serveNumber, point, rally) {
    let pos = 0;
    let server = point.server;
    let returner = server === 1 ? 2 : 1;

    // Count lets
    let lets = 0;
    while (pos < code.length && code[pos] === 'c') {
        lets++;
        pos++;
    }

    // Parse serve direction
    let serveDirection = null;
    let serveDirectionName = null;
    if (pos < code.length && '0456'.includes(code[pos])) {
        serveDirection = code[pos];
        serveDirectionName = SERVE_DIRECTION_NAMES[serveDirection] || null;
        pos++;
    }

    // Check for serve-and-volley indicator
    let serveAndVolley = false;
    if (pos < code.length && code[pos] === '+') {
        serveAndVolley = true;
        pos++;
    }

    // Check for ace
    if (pos < code.length && code[pos] === '*') {
        let serve = {
            shotNumber: rally.serves.length + 1,
            hitter: server,
            isServe: true,
            serveNumber: serveNumber,
            in: true,
            direction: serveDirection,
            directionName: serveDirectionName,
            fault: null,
            serveAndVolley: serveAndVolley,
            lets: lets,
            ace: true,
            unreturnable: false
        };
        rally.serves.push(serve);
        rally.outcome = {
            type: 'ace',
            description: `Ace ${serveDirectionName || ''}`.trim(),
            player: server
        };
        return { fault: false };
    }

    // Check for unreturnable
    if (pos < code.length && code[pos] === '#') {
        let serve = {
            shotNumber: rally.serves.length + 1,
            hitter: server,
            isServe: true,
            serveNumber: serveNumber,
            in: true,
            direction: serveDirection,
            directionName: serveDirectionName,
            fault: null,
            serveAndVolley: serveAndVolley,
            lets: lets,
            ace: false,
            unreturnable: true
        };
        rally.serves.push(serve);
        rally.outcome = {
            type: 'unreturnable',
            description: `Unreturnable serve ${serveDirectionName || ''}`.trim(),
            player: server
        };
        return { fault: false };
    }

    // Check for serve fault
    let faultType = null;
    if (pos < code.length && 'nwdxge!'.includes(code[pos])) {
        faultType = code[pos];
        pos++;

        let serve = {
            shotNumber: rally.serves.length + 1,
            hitter: server,
            isServe: true,
            serveNumber: serveNumber,
            in: false,
            direction: serveDirection,
            directionName: serveDirectionName,
            fault: ERROR_TYPES[faultType] || faultType,
            serveAndVolley: serveAndVolley,
            lets: lets,
            ace: false,
            unreturnable: false
        };
        rally.serves.push(serve);
        return { fault: true };
    }

    // Serve is in — add it and parse the rally
    let serve = {
        shotNumber: rally.serves.length + 1,
        hitter: server,
        isServe: true,
        serveNumber: serveNumber,
        in: true,
        direction: serveDirection,
        directionName: serveDirectionName,
        fault: null,
        serveAndVolley: serveAndVolley,
        lets: lets,
        ace: false,
        unreturnable: false
    };
    rally.serves.push(serve);

    // Now parse rally shots from current position
    parseRallyShots(code, pos, point, rally);

    return { fault: false };
}

/**
 * Parse the rally portion of a code string (after the serve).
 * Each shot: [type][modifiers][direction][depth?][ending?]
 */
function parseRallyShots(code, startPos, point, rally) {
    let pos = startPos;
    let server = point.server;
    let returner = server === 1 ? 2 : 1;

    // Shots alternate: returner hits first (the return), then server, then returner, etc.
    let currentHitter = returner;
    let shotIndex = 0;

    while (pos < code.length) {
        let shotType = null;
        let shotTypeName = null;
        let shotSide = null;
        let shotCategory = null;
        let direction = null;
        let directionName = null;
        let returnDepth = null;
        let returnDepthName = null;
        let isApproach = false;
        let netPosition = null;    // null = default, 'net' = at net, 'baseline' = at baseline
        let netCord = false;
        let stopVolley = false;
        let isWinner = false;
        let errorType = null;
        let errorTypeName = null;
        let isForced = null;       // true = forced error, false = unforced error, null = not an error
        let challengeStopped = false;

        // Read shot type letter
        if (pos < code.length && SHOT_TYPES[code[pos]]) {
            let typeChar = code[pos];
            shotType = typeChar;
            let info = SHOT_TYPES[typeChar];
            shotTypeName = info.name;
            shotSide = info.side;
            shotCategory = info.category;
            pos++;
        } else if (pos < code.length) {
            // Unknown character — skip it or break
            pos++;
            continue;
        } else {
            break;
        }

        // Read modifiers that come right after the shot type letter
        // + = approach shot
        if (pos < code.length && code[pos] === '+') {
            isApproach = true;
            pos++;
        }

        // - = at net, = = at baseline (position override)
        if (pos < code.length && code[pos] === '-') {
            netPosition = 'net';
            pos++;
        } else if (pos < code.length && code[pos] === '=') {
            netPosition = 'baseline';
            pos++;
        }

        // ; = net cord
        if (pos < code.length && code[pos] === ';') {
            netCord = true;
            pos++;
        }

        // ^ = stop volley / drop volley
        if (pos < code.length && code[pos] === '^') {
            stopVolley = true;
            pos++;
        }

        // Read direction (1, 2, 3, or 0)
        if (pos < code.length && '0123'.includes(code[pos])) {
            direction = code[pos];
            directionName = DIRECTION_NAMES[direction] || null;
            pos++;
        }

        // Read return depth (7, 8, 9) — only applies to service returns (first rally shot)
        if (shotIndex === 0 && pos < code.length && '789'.includes(code[pos])) {
            returnDepth = code[pos];
            returnDepthName = RETURN_DEPTH[returnDepth] || null;
            pos++;
        }
        // Also accept 0 for unknown depth on returns
        if (shotIndex === 0 && returnDepth === null && pos < code.length && code[pos] === '0' && direction !== null) {
            returnDepth = '0';
            returnDepthName = RETURN_DEPTH['0'];
            pos++;
        }

        // Check for winner (*)
        if (pos < code.length && code[pos] === '*') {
            isWinner = true;
            pos++;
        }

        // Check for challenge stopped (C)
        if (pos < code.length && code[pos] === 'C') {
            challengeStopped = true;
            pos++;
        }

        // Check for error type (n, w, d, x, !, e)
        if (pos < code.length && 'nwdx!e'.includes(code[pos])) {
            errorType = code[pos];
            errorTypeName = ERROR_TYPES[errorType] || errorType;
            pos++;
        }

        // Check for forced (#) or unforced (@) error
        if (pos < code.length && code[pos] === '@') {
            isForced = false;
            pos++;
        } else if (pos < code.length && code[pos] === '#') {
            isForced = true;
            pos++;
        }

        // Determine default court position based on shot category
        let courtPosition = netPosition;
        if (courtPosition === null) {
            if (['volley', 'halfvolley', 'swingingvolley', 'overhead'].includes(shotCategory)) {
                courtPosition = 'net';
            } else {
                courtPosition = 'baseline';
            }
        }

        let shot = {
            shotNumber: rally.serves.length + rally.shots.length + 1,
            rallyNumber: shotIndex + 1,   // 1-indexed position within rally (1 = return)
            hitter: currentHitter,
            isReturn: shotIndex === 0,
            type: shotType,
            typeName: shotTypeName,
            side: shotSide,
            category: shotCategory,
            direction: direction,
            directionName: directionName,
            returnDepth: returnDepth,
            returnDepthName: returnDepthName,
            isApproach: isApproach,
            courtPosition: courtPosition,
            netCord: netCord,
            stopVolley: stopVolley,
            isWinner: isWinner,
            isError: isForced !== null,
            errorType: errorTypeName,
            isForced: isForced,
            challengeStopped: challengeStopped
        };

        rally.shots.push(shot);

        // Determine outcome if this was the last shot
        if (isWinner) {
            rally.outcome = {
                type: 'winner',
                description: `${shotTypeName} winner${directionName ? ' ' + directionName : ''}`,
                player: currentHitter,
                shot: shot
            };
        } else if (isForced === false) {
            rally.outcome = {
                type: 'unforcedError',
                description: `Unforced error: ${shotTypeName}${errorTypeName ? ' ' + errorTypeName : ''}`,
                player: currentHitter === 1 ? 2 : 1,  // opponent wins on errors
                shot: shot
            };
        } else if (isForced === true) {
            rally.outcome = {
                type: 'forcedError',
                description: `Forced error: ${shotTypeName}${errorTypeName ? ' ' + errorTypeName : ''}`,
                player: currentHitter === 1 ? 2 : 1,  // opponent wins on errors
                shot: shot
            };
        } else if (challengeStopped) {
            rally.outcome = {
                type: 'challengeStopped',
                description: `Rally stopped for incorrect challenge`,
                player: currentHitter === 1 ? 2 : 1,  // opponent wins
                shot: shot
            };
        }

        // Alternate hitter
        currentHitter = currentHitter === 1 ? 2 : 1;
        shotIndex++;
    }
}

/**
 * Get a human-readable description of the full rally.
 * @param {object} rally - Output of parseRally()
 * @returns {string}
 */
function describeRally(rally) {
    let parts = [];

    for (let serve of rally.serves) {
        let desc = `Serve ${serve.serveNumber}`;
        if (serve.lets > 0) desc += ` (${serve.lets} let${serve.lets > 1 ? 's' : ''})`;
        if (serve.directionName) desc += ` ${serve.directionName}`;
        if (serve.serveAndVolley) desc += ' (serve & volley)';
        if (serve.ace) desc += ' — ACE';
        else if (serve.unreturnable) desc += ' — unreturnable';
        else if (serve.fault) desc += ` — fault (${serve.fault})`;
        else desc += ' — in';
        parts.push(desc);
    }

    for (let shot of rally.shots) {
        let desc = '';
        if (shot.isReturn) desc += 'Return: ';
        desc += shot.typeName;
        if (shot.isApproach) desc += ' (approach)';
        if (shot.stopVolley) desc += ' (drop volley)';
        if (shot.directionName) desc += ' ' + shot.directionName;
        if (shot.returnDepthName) desc += `, ${shot.returnDepthName}`;
        if (shot.netCord) desc += ' (net cord)';
        if (shot.isWinner) desc += ' — WINNER';
        if (shot.isForced === false) desc += ` — unforced error (${shot.errorType || 'unknown'})`;
        if (shot.isForced === true) desc += ` — forced error${shot.errorType ? ' (' + shot.errorType + ')' : ''}`;
        if (shot.challengeStopped) desc += ' — rally stopped (incorrect challenge)';
        parts.push(desc);
    }

    if (rally.outcome) {
        parts.push(`→ ${rally.outcome.description}`);
    }

    return parts.join('\n');
}
