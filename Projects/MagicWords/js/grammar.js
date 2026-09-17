/**
 * Part-of-Speech tagging and sentence grammar model.
 *
 * Tags words using a lookup table for common words + suffix heuristics.
 * Provides POS transition probabilities to predict what word category
 * should come next given what's already been typed.
 */

// ═══════════════════════════════════════════════════════════════════════════
// POS CATEGORIES
// ═══════════════════════════════════════════════════════════════════════════

/** @enum {string} */
export const POS = {
    NOUN: 'NOUN',
    VERB: 'VERB',
    ADJ: 'ADJ',
    ADV: 'ADV',
    DET: 'DET',   // the, a, an, this, that, some, ...
    PREP: 'PREP',  // in, on, at, to, for, with, ...
    CONJ: 'CONJ',  // and, but, or, so, yet, ...
    PRON: 'PRON',  // I, you, he, she, it, we, they, ...
    AUX: 'AUX',   // is, was, have, had, will, can, ...
    INTJ: 'INTJ',  // oh, wow, hey, ...
    NUM: 'NUM',    // one, two, first, second, ...
    PART: 'PART',  // not, to (infinitive), 's
};

// ═══════════════════════════════════════════════════════════════════════════
// FUNCTION WORD LOOKUP  (~400 most common function words)
// ═══════════════════════════════════════════════════════════════════════════

/** @type {Map<string, string>} word → POS */
const KNOWN_POS = new Map();

/** Function-word POS tags that should NOT be overwritten by content words. */
const FUNCTION_POS = new Set(['DET', 'PRON', 'PREP', 'CONJ', 'AUX', 'PART', 'INTJ']);

/**
 * Register words with a POS tag.
 * Function words (DET, PRON, PREP, CONJ, AUX, PART, INTJ) are "sticky" —
 * once registered, they won't be overwritten by content-word tags
 * (NOUN, VERB, ADJ, ADV, NUM).
 */
function tag(pos, ...words) {
    const isContentTag = !FUNCTION_POS.has(pos);
    for (const w of words) {
        const existing = KNOWN_POS.get(w);
        // Don't let content tags (NOUN/VERB/ADJ/ADV) overwrite function tags
        if (existing && FUNCTION_POS.has(existing) && isContentTag) continue;
        KNOWN_POS.set(w, pos);
    }
}

// Determiners
tag(POS.DET,
    'the', 'a', 'an', 'this', 'that', 'these', 'those', 'my', 'your', 'his', 'her', 'its',
    'our', 'their', 'some', 'any', 'no', 'every', 'each', 'all', 'both', 'few', 'many',
    'much', 'several', 'such', 'what', 'which', 'whose', 'another', 'other', 'either',
    'neither', 'enough');

// Pronouns
tag(POS.PRON,
    'i', 'me', 'myself', 'you', 'yourself', 'yourselves', 'he', 'him', 'himself',
    'she', 'her', 'herself', 'it', 'itself', 'we', 'us', 'ourselves', 'they', 'them',
    'themselves', 'who', 'whom', 'whose', 'what', 'which', 'that', 'this', 'these',
    'those', 'one', 'ones', 'someone', 'something', 'somebody', 'anyone', 'anything',
    'anybody', 'everyone', 'everything', 'everybody', 'no one', 'nothing', 'nobody',
    'mine', 'yours', 'his', 'hers', 'ours', 'theirs', 'whoever', 'whatever', 'whichever');

// Prepositions
tag(POS.PREP,
    'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by', 'about', 'into', 'through',
    'during', 'before', 'after', 'above', 'below', 'between', 'under', 'over', 'of',
    'against', 'along', 'among', 'around', 'behind', 'beside', 'beyond', 'down',
    'except', 'inside', 'near', 'off', 'onto', 'outside', 'past', 'since', 'toward',
    'towards', 'until', 'up', 'upon', 'within', 'without', 'across', 'despite',
    'throughout', 'unlike', 'via', 'per', 'plus', 'versus');

// Conjunctions
tag(POS.CONJ,
    'and', 'but', 'or', 'nor', 'so', 'yet', 'although', 'because', 'since',
    'unless', 'while', 'whereas', 'whether', 'however', 'therefore', 'moreover',
    'furthermore', 'nevertheless', 'meanwhile', 'otherwise', 'instead', 'besides',
    'thus', 'hence', 'accordingly', 'still', 'though', 'than', 'if', 'when', 'where',
    'whenever', 'wherever', 'once');

// Auxiliaries & modals
tag(POS.AUX,
    'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'having',
    'do', 'does', 'did',
    'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
    'need', 'dare', 'ought', 'cannot',
    "can't", "won't", "wouldn't", "couldn't", "shouldn't", "mustn't",
    // Archaic contractions
    'tis', "'tis", 'twas', "'twas");

// Common verbs (base forms + common inflections)
tag(POS.VERB,
    'get', 'got', 'getting', 'gets', 'gotten',
    'make', 'made', 'making', 'makes',
    'go', 'goes', 'went', 'going', 'gone',
    'take', 'took', 'taken', 'taking', 'takes',
    'come', 'came', 'coming', 'comes',
    'see', 'saw', 'seen', 'seeing', 'sees',
    'know', 'knew', 'known', 'knowing', 'knows',
    'think', 'thought', 'thinking', 'thinks',
    'say', 'said', 'saying', 'says',
    'give', 'gave', 'given', 'giving', 'gives',
    'find', 'found', 'finding', 'finds',
    'tell', 'told', 'telling', 'tells',
    'ask', 'asked', 'asking', 'asks',
    'use', 'used', 'using', 'uses',
    'work', 'worked', 'working', 'works',
    'call', 'called', 'calling', 'calls',
    'try', 'tried', 'trying', 'tries',
    'keep', 'kept', 'keeping', 'keeps',
    'let', 'letting', 'lets',
    'begin', 'began', 'begun', 'beginning', 'begins',
    'show', 'showed', 'shown', 'showing', 'shows',
    'hear', 'heard', 'hearing', 'hears',
    'play', 'played', 'playing', 'plays',
    'run', 'ran', 'running', 'runs',
    'move', 'moved', 'moving', 'moves',
    'live', 'lived', 'living', 'lives',
    'believe', 'believed', 'believing', 'believes',
    'bring', 'brought', 'bringing', 'brings',
    'happen', 'happened', 'happening', 'happens',
    'write', 'wrote', 'written', 'writing', 'writes',
    'sit', 'sat', 'sitting', 'sits',
    'stand', 'stood', 'standing', 'stands',
    'lose', 'lost', 'losing', 'loses',
    'pay', 'paid', 'paying', 'pays',
    'meet', 'met', 'meeting', 'meets',
    'include', 'included', 'including', 'includes',
    'continue', 'continued', 'continuing', 'continues',
    'set', 'setting', 'sets',
    'learn', 'learned', 'learning', 'learns',
    'change', 'changed', 'changing', 'changes',
    'lead', 'led', 'leading', 'leads',
    'understand', 'understood', 'understanding', 'understands',
    'watch', 'watched', 'watching', 'watches',
    'follow', 'followed', 'following', 'follows',
    'stop', 'stopped', 'stopping', 'stops',
    'create', 'created', 'creating', 'creates',
    'speak', 'spoke', 'spoken', 'speaking', 'speaks',
    'read', 'reading', 'reads',
    'spend', 'spent', 'spending', 'spends',
    'grow', 'grew', 'grown', 'growing', 'grows',
    'open', 'opened', 'opening', 'opens',
    'walk', 'walked', 'walking', 'walks',
    'win', 'won', 'winning', 'wins',
    'teach', 'taught', 'teaching', 'teaches',
    'offer', 'offered', 'offering', 'offers',
    'remember', 'remembered', 'remembering', 'remembers',
    'consider', 'considered', 'considering', 'considers',
    'appear', 'appeared', 'appearing', 'appears',
    'buy', 'bought', 'buying', 'buys',
    'wait', 'waited', 'waiting', 'waits',
    'serve', 'served', 'serving', 'serves',
    'die', 'died', 'dying', 'dies',
    'send', 'sent', 'sending', 'sends',
    'build', 'built', 'building', 'builds',
    'stay', 'stayed', 'staying', 'stays',
    'fall', 'fell', 'fallen', 'falling', 'falls',
    'cut', 'cutting', 'cuts',
    'reach', 'reached', 'reaching', 'reaches',
    'kill', 'killed', 'killing', 'kills',
    'remain', 'remained', 'remaining', 'remains',
    'suggest', 'suggested', 'suggesting', 'suggests',
    'raise', 'raised', 'raising', 'raises',
    'pass', 'passed', 'passing', 'passes',
    'sell', 'sold', 'selling', 'sells',
    'require', 'required', 'requiring', 'requires',
    'report', 'reported', 'reporting', 'reports',
    'decide', 'decided', 'deciding', 'decides',
    'pull', 'pulled', 'pulling', 'pulls',
    'develop', 'developed', 'developing', 'develops',
    'catch', 'caught', 'catching', 'catches',
    'put', 'putting', 'puts',
    'eat', 'ate', 'eaten', 'eating', 'eats',
    'hold', 'held', 'holding', 'holds',
    'want', 'wanted', 'wanting', 'wants',
    'need', 'needed', 'needing', 'needs',
    'like', 'liked', 'liking', 'likes',
    'seem', 'seemed', 'seeming', 'seems',
    'start', 'started', 'starting', 'starts',
    'help', 'helped', 'helping', 'helps',
    'turn', 'turned', 'turning', 'turns',
    'leave', 'left', 'leaving', 'leaves',
    'feel', 'felt', 'feeling', 'feels',
    'look', 'looked', 'looking', 'looks',
    'carry', 'carried', 'carrying', 'carries',
    'cause', 'caused', 'causing', 'causes',
    'allow', 'allowed', 'allowing', 'allows',
    'expect', 'expected', 'expecting', 'expects',
    'produce', 'produced', 'producing', 'produces',
    'break', 'broke', 'broken', 'breaking', 'breaks',
    'receive', 'received', 'receiving', 'receives',
    'agree', 'agreed', 'agreeing', 'agrees',
    'support', 'supported', 'supporting', 'supports',
    'hit', 'hitting', 'hits',
    'cover', 'covered', 'covering', 'covers',
    'pick', 'picked', 'picking', 'picks',
    'handle', 'handled', 'handling', 'handles',
    'fight', 'fought', 'fighting', 'fights',
    'throw', 'threw', 'thrown', 'throwing', 'throws',
    'choose', 'chose', 'chosen', 'choosing', 'chooses',
    'close', 'closed', 'closing', 'closes',
    'drive', 'drove', 'driven', 'driving', 'drives',
    'rise', 'rose', 'risen', 'rising', 'rises',
    'draw', 'drew', 'drawn', 'drawing', 'draws',
    'love', 'loved', 'loving', 'loves',
    'add', 'added', 'adding', 'adds',
    'join', 'joined', 'joining', 'joins',
    'apply', 'applied', 'applying', 'applies',
    'enjoy', 'enjoyed', 'enjoying', 'enjoys',
    'save', 'saved', 'saving', 'saves',
    'fill', 'filled', 'filling', 'fills',
    'face', 'faced', 'facing', 'faces',
    'kill', 'killed', 'killing', 'kills',
    'exist', 'existed', 'existing', 'exists',
    'suffer', 'suffered', 'suffering', 'suffers',
    'end', 'ended', 'ending', 'ends',
    'bear', 'bore', 'borne', 'bearing', 'bears',
    'oppose', 'opposed', 'opposing', 'opposes',
    'cross', 'crossed', 'crossing', 'crosses',
    'fear', 'feared', 'fearing', 'fears',
    'sleep', 'slept', 'sleeping', 'sleeps',
    'sing', 'sang', 'sung', 'singing', 'sings',
    'lie', 'lay', 'lain', 'lying', 'lies',
    'fly', 'flew', 'flown', 'flying', 'flies',
    'hang', 'hung', 'hanging', 'hangs',
    'finish', 'finished', 'finishing', 'finishes',
    'wonder', 'wondered', 'wondering', 'wonders',
    'matter', 'mattered', 'mattering', 'matters',
    'manage', 'managed', 'managing', 'manages',
    'test', 'tested', 'testing', 'tests',
);

// Common adjectives
tag(POS.ADJ,
    'good', 'better', 'best', 'bad', 'worse', 'worst',
    'great', 'big', 'small', 'large', 'little', 'long', 'short', 'old', 'young',
    'new', 'high', 'low', 'early', 'late', 'important', 'different', 'same',
    'able', 'available', 'possible', 'likely', 'free', 'clear', 'sure',
    'real', 'right', 'wrong', 'true', 'false', 'full', 'empty', 'open', 'closed',
    'hard', 'easy', 'fast', 'slow', 'strong', 'weak', 'hot', 'cold', 'warm', 'cool',
    'dark', 'light', 'bright', 'deep', 'wide', 'narrow', 'thin', 'thick',
    'beautiful', 'happy', 'sad', 'angry', 'afraid', 'certain', 'common',
    'simple', 'special', 'recent', 'public', 'private', 'local', 'national',
    'political', 'social', 'economic', 'human', 'final', 'major', 'military',
    'natural', 'physical', 'serious', 'significant', 'similar', 'various',
    'whole', 'current', 'necessary', 'particular', 'single', 'entire',
    'general', 'specific', 'popular', 'traditional', 'poor', 'rich',
    'nice', 'pretty', 'dead', 'alive', 'ready', 'safe', 'sorry', 'busy',
    'complete', 'perfect', 'impossible', 'interesting', 'terrible',
    'wonderful', 'amazing', 'incredible', 'familiar', 'strange', 'normal',
    'obvious', 'primary', 'appropriate', 'basic', 'critical', 'essential',
    'effective', 'excellent', 'foreign', 'huge', 'independent', 'original',
    'positive', 'negative', 'potential', 'professional', 'responsible',
    'successful', 'useful', 'valuable', 'complex', 'broad', 'firm',
    'powerful', 'quiet', 'sharp', 'rare', 'relevant', 'sweet',
    'last', 'next', 'main', 'own', 'key', 'due', 'prior', 'further', 'mere',
    'extra', 'junior', 'senior', 'overall', 'gross', 'net', 'average',
    // Colours
    'red', 'blue', 'green', 'white', 'black', 'yellow', 'brown', 'gray', 'grey',
    'orange', 'purple', 'pink', 'golden', 'silver',
    // Common adjectives that suffix rules mistagg
    'lazy', 'tiny', 'ugly', 'dirty', 'funny', 'crazy', 'silly', 'fancy',
    'hungry', 'lucky', 'guilty', 'holy', 'shy', 'sly', 'dry', 'wet',
    'wild', 'soft', 'loud', 'rough', 'smooth', 'flat', 'round', 'raw',
    'plain', 'bare', 'blind', 'brave', 'calm', 'cruel', 'fierce', 'gentle',
    'grand', 'keen', 'mild', 'odd', 'pale', 'proud', 'rude', 'vast', 'weird',
    'tired', 'scared', 'bored', 'pleased', 'worried', 'confused', 'excited',
    'relaxed', 'surprised', 'satisfied', 'disappointed', 'convinced',
    // Adjectives that are also nouns (context-dependent)
    'kind', 'mean', 'fit', 'present', 'content', 'minute', 'just', 'sound',
    // Comparatives and superlatives (that suffix rules might miss)
    'nobler', 'noblest', 'lesser', 'greater', 'greater', 'fewer', 'older',
    'elder', 'wider', 'purer');

// Common adverbs
tag(POS.ADV,
    'not', 'very', 'also', 'just', 'only', 'really', 'still', 'already', 'even',
    'often', 'always', 'never', 'sometimes', 'usually', 'again', 'here', 'there',
    'now', 'then', 'today', 'tomorrow', 'yesterday', 'soon', 'later', 'ago',
    'too', 'quite', 'rather', 'almost', 'enough', 'well', 'badly',
    'quickly', 'slowly', 'easily', 'simply', 'suddenly', 'finally',
    'actually', 'probably', 'certainly', 'perhaps', 'maybe', 'indeed',
    'clearly', 'obviously', 'apparently', 'especially', 'particularly',
    'generally', 'normally', 'recently', 'usually', 'frequently', 'immediately',
    'together', 'away', 'back', 'forward', 'ahead', 'above', 'below',
    'nearly', 'extremely', 'absolutely', 'completely', 'entirely',
    'directly', 'relatively', 'slightly', 'significantly', 'simply', 'merely',
    'essentially', 'basically', 'honestly', 'seriously', 'literally',
    'definitely', 'surely', 'anyway', 'instead', 'nevertheless', 'however',
    'therefore', 'thus', 'hence', 'meanwhile', 'otherwise', 'moreover',
    'furthermore', 'besides', 'nonetheless', 'regardless', 'everywhere',
    'nowhere', 'somewhere', 'anywhere', 'somehow', 'somewhat', 'ever');

// Interjections
tag(POS.INTJ,
    'oh', 'ah', 'wow', 'hey', 'hi', 'hello', 'goodbye', 'bye', 'yes', 'no',
    'yeah', 'okay', 'ok', 'please', 'thanks', 'sorry', 'ugh', 'hmm', 'oops',
    'ouch', 'yay', 'hooray', 'alas', 'bravo', 'cheers', 'well');

// Numbers
tag(POS.NUM,
    'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
    'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty',
    'seventy', 'eighty', 'ninety', 'hundred', 'thousand', 'million', 'billion',
    'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth',
    'ninth', 'tenth', 'once', 'twice', 'half', 'quarter', 'double', 'triple',
    'zero');

// Particles
tag(POS.PART, 'not', "n't", 'to');

// Common nouns (that might otherwise be mistagged by suffix rules)
tag(POS.NOUN,
    'time', 'year', 'people', 'way', 'day', 'man', 'woman', 'child', 'children',
    'world', 'life', 'hand', 'part', 'place', 'case', 'week', 'company', 'system',
    'program', 'question', 'work', 'government', 'number', 'night', 'point',
    'home', 'water', 'room', 'mother', 'area', 'money', 'story', 'fact', 'month',
    'lot', 'study', 'book', 'eye', 'job', 'word', 'business', 'issue',
    'side', 'kind', 'head', 'house', 'service', 'friend', 'father', 'power',
    'hour', 'game', 'line', 'member', 'law', 'car', 'city', 'community',
    'name', 'president', 'team', 'minute', 'idea', 'body', 'information',
    'back', 'parent', 'face', 'others', 'level', 'office', 'door', 'health',
    'person', 'art', 'war', 'history', 'party', 'result', 'change', 'morning',
    'reason', 'research', 'girl', 'guy', 'moment', 'air', 'teacher', 'force',
    'education', 'dog', 'cat', 'food', 'music', 'animal', 'family', 'school',
    'group', 'country', 'problem', 'plan', 'class', 'age', 'experience',
    'effort', 'matter', 'knowledge', 'language', 'control', 'rest', 'boy',
    'market', 'figure', 'death', 'fire', 'picture', 'season', 'table',
    'paper', 'attention', 'interest', 'view', 'voice', 'summer', 'center',
    'church', 'technology', 'nature', 'street', 'field', 'role', 'model',
    'news', 'size', 'price', 'pain', 'section', 'risk', 'data', 'color',
    'ground', 'form', 'past', 'future', 'love', 'hope', 'fear', 'anger',
    // Nouns ending in -ing (would otherwise match verb suffix rule)
    'king', 'ring', 'string', 'thing', 'spring', 'wing', 'sling', 'swing',
    'sting', 'fling', 'cling', 'sing', 'bring',
    'building', 'feeling', 'meaning', 'evening', 'beginning', 'opening',
    'ending', 'reading', 'meeting', 'setting', 'clothing', 'ceiling',
    'wedding', 'painting', 'warning', 'crossing', 'blessing', 'offering',
    'parking', 'funding', 'hearing', 'ruling', 'listing', 'recording',
    'shipping', 'flooring', 'railing', 'plumbing', 'wiring', 'roofing',
    'pudding', 'stuffing', 'icing', 'frosting', 'blessing', 'dwelling',
    'sibling', 'darling', 'duckling', 'seedling', 'sterling');

// ═══════════════════════════════════════════════════════════════════════════
// SUFFIX-BASED POS RULES (fallback for unknown words)
// ═══════════════════════════════════════════════════════════════════════════

/** @type {Array<[RegExp, string]>} Suffix patterns sorted longest-first. */
const SUFFIX_RULES = [
    // Noun suffixes
    [/tion$/, POS.NOUN],
    [/sion$/, POS.NOUN],
    [/ment$/, POS.NOUN],
    [/ness$/, POS.NOUN],
    [/ity$/, POS.NOUN],
    [/ance$/, POS.NOUN],
    [/ence$/, POS.NOUN],
    [/ship$/, POS.NOUN],
    [/ism$/, POS.NOUN],
    [/ist$/, POS.NOUN],
    [/dom$/, POS.NOUN],
    [/ure$/, POS.NOUN],
    [/age$/, POS.NOUN],
    [/ery$/, POS.NOUN],
    [/ory$/, POS.NOUN],
    [/ary$/, POS.NOUN],

    // Adjective suffixes
    [/ful$/, POS.ADJ],
    [/less$/, POS.ADJ],
    [/ous$/, POS.ADJ],
    [/ive$/, POS.ADJ],
    [/able$/, POS.ADJ],
    [/ible$/, POS.ADJ],
    [/ical$/, POS.ADJ],
    [/ial$/, POS.ADJ],
    [/al$/, POS.ADJ],
    [/ular$/, POS.ADJ],
    [/ish$/, POS.ADJ],
    [/ic$/, POS.ADJ],

    // Adverb
    [/ly$/, POS.ADV],

    // Verb suffixes
    [/ize$/, POS.VERB],
    [/ise$/, POS.VERB],
    [/ify$/, POS.VERB],
    [/ate$/, POS.VERB],
    [/ing$/, POS.VERB],
    [/(?<=.{2})ed$/, POS.VERB],  // min 4 chars to avoid 'red', 'bed'
];

// ═══════════════════════════════════════════════════════════════════════════
// POS TAGGER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Return the most likely POS tag for a word.
 * Uses the lookup table first, then suffix rules, then defaults to NOUN.
 * @param {string} word
 * @returns {string}
 */
export function tagWord(word) {
    const w = word.toLowerCase();

    // 1. Direct lookup
    const known = KNOWN_POS.get(w);
    if (known) return known;

    // 2. Suffix heuristics
    for (const [pattern, pos] of SUFFIX_RULES) {
        if (pattern.test(w)) return pos;
    }

    // 3. Words ending in -s often plural nouns (or 3rd person verbs —
    //    but nouns are more common as a default)
    if (w.endsWith('s') && w.length > 3) return POS.NOUN;

    // 4. Default: noun (most open-class words are nouns)
    return POS.NOUN;
}

/**
 * Return all plausible POS tags for a word (some words are ambiguous).
 * @param {string} word
 * @returns {string[]}
 */
export function tagWordAll(word) {
    const w = word.toLowerCase();
    const tags = new Set();

    const known = KNOWN_POS.get(w);
    if (known) tags.add(known);

    for (const [pattern, pos] of SUFFIX_RULES) {
        if (pattern.test(w)) tags.add(pos);
    }

    // -ing words can be verbs or adjectives
    if (w.endsWith('ing')) { tags.add(POS.VERB); tags.add(POS.ADJ); }
    // -ed words can be verbs or adjectives
    if (w.endsWith('ed')) { tags.add(POS.VERB); tags.add(POS.ADJ); }

    if (tags.size === 0) tags.add(POS.NOUN);
    return [...tags];
}

// ═══════════════════════════════════════════════════════════════════════════
// POS TRANSITION MODEL
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Bigram transition probabilities: P(nextPOS | prevPOS).
 * Derived from typical written English distributions.
 * Each row sums to ~1.0.
 *
 * Usage: TRANSITIONS[prevPOS][nextPOS] → probability
 *
 * Special key '_START' for sentence-initial position.
 */
export const TRANSITIONS = {
    _START: {
        DET: 0.28, PRON: 0.22, ADJ: 0.08, NOUN: 0.15,
        ADV: 0.08, VERB: 0.05, AUX: 0.06, PREP: 0.02,
        CONJ: 0.01, INTJ: 0.03, NUM: 0.02,
    },
    DET: {
        NOUN: 0.50, ADJ: 0.35, ADV: 0.05, NUM: 0.05,
        VERB: 0.02, NOUN: 0.50, PRON: 0.01, PREP: 0.01,
        CONJ: 0.01,
    },
    NOUN: {
        VERB: 0.25, AUX: 0.15, PREP: 0.20, CONJ: 0.10,
        DET: 0.03, ADV: 0.05, NOUN: 0.05, PRON: 0.05,
        ADJ: 0.05, PART: 0.02, NUM: 0.02,
    },
    PRON: {
        VERB: 0.30, AUX: 0.30, ADV: 0.10, NOUN: 0.05,
        PREP: 0.05, ADJ: 0.05, CONJ: 0.05, DET: 0.03,
        PRON: 0.02, PART: 0.03,
    },
    VERB: {
        DET: 0.18, NOUN: 0.15, ADV: 0.12, PREP: 0.15,
        ADJ: 0.10, PRON: 0.10, VERB: 0.05, AUX: 0.02,
        CONJ: 0.05, NUM: 0.03, PART: 0.03,
    },
    AUX: {
        VERB: 0.35, ADV: 0.20, ADJ: 0.10, NOUN: 0.08,
        DET: 0.08, PRON: 0.05, PREP: 0.05, PART: 0.05,
        AUX: 0.02, CONJ: 0.02,
    },
    ADJ: {
        NOUN: 0.55, ADJ: 0.10, CONJ: 0.08, PREP: 0.08,
        ADV: 0.05, VERB: 0.05, DET: 0.03, NOUN: 0.55,
        NUM: 0.02, PRON: 0.02,
    },
    ADV: {
        VERB: 0.25, ADJ: 0.25, ADV: 0.10, NOUN: 0.08,
        DET: 0.08, AUX: 0.08, PREP: 0.05, CONJ: 0.05,
        PRON: 0.03, NUM: 0.02,
    },
    PREP: {
        DET: 0.35, NOUN: 0.20, ADJ: 0.10, PRON: 0.12,
        VERB: 0.05, ADV: 0.05, NUM: 0.05, PREP: 0.03,
        AUX: 0.02, CONJ: 0.02,
    },
    CONJ: {
        DET: 0.20, PRON: 0.18, NOUN: 0.15, ADJ: 0.12,
        ADV: 0.10, VERB: 0.10, AUX: 0.05, PREP: 0.03,
        NUM: 0.03, CONJ: 0.02,
    },
    NUM: {
        NOUN: 0.50, ADJ: 0.10, PREP: 0.10, CONJ: 0.08,
        VERB: 0.05, DET: 0.05, ADV: 0.05, NUM: 0.03,
        PRON: 0.02, AUX: 0.02,
    },
    INTJ: {
        DET: 0.15, PRON: 0.20, NOUN: 0.15, VERB: 0.10,
        ADV: 0.10, ADJ: 0.08, AUX: 0.08, PREP: 0.05,
        CONJ: 0.04, INTJ: 0.03, NUM: 0.02,
    },
    PART: {
        VERB: 0.60, ADV: 0.15, ADJ: 0.10, NOUN: 0.05,
        DET: 0.03, PRON: 0.03, PREP: 0.02, AUX: 0.02,
    },
};

// ═══════════════════════════════════════════════════════════════════════════
// GRAMMAR-BASED PREDICTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Given the sentence typed so far, return a probability distribution over
 * what POS is most likely next.  Accepts both the word array and POS array
 * so that word-specific overrides (e.g. infinitive "to") can be applied.
 *
 * @param {string[]} words    - committed words in the current sentence
 * @param {string[]} posTags  - POS tags parallel to words
 * @returns {Object<string, number>} POS → probability
 */
export function predictNextPOS(words, posTags) {
    if (!posTags || posTags.length === 0) {
        return TRANSITIONS._START;
    }
    const lastPOS = posTags[posTags.length - 1];
    const lastWord = (words && words.length > 0)
        ? words[words.length - 1].toLowerCase().replace(/[.,!?]+$/, '')
        : '';

    // ── Word-specific overrides ──────────────────────────────────────────

    // After infinitive "to": almost always a verb
    if (lastWord === 'to' && lastPOS === 'PART') {
        return { VERB: 0.80, ADV: 0.15, ADJ: 0.05 };
    }

    // After modal auxiliaries: strongly favour a verb
    if (['can', 'could', 'will', 'would', 'shall', 'should',
        'may', 'might', 'must'].includes(lastWord) && lastPOS === 'AUX') {
        return { VERB: 0.55, ADV: 0.20, PART: 0.15, ADJ: 0.05, NOUN: 0.03, PREP: 0.02 };
    }

    return TRANSITIONS[lastPOS] || TRANSITIONS._START;
}

// ═══════════════════════════════════════════════════════════════════════════
// NUMBER AGREEMENT
// ═══════════════════════════════════════════════════════════════════════════

const SG_DETERMINERS = new Set([
    'a', 'an', 'this', 'that', 'each', 'every', 'another',
]);
const PL_DETERMINERS = new Set([
    'these', 'those', 'few', 'many', 'several', 'both',
]);
const SG_PRONOUNS = new Set(['i', 'he', 'she', 'it']);
const PL_PRONOUNS = new Set(['we', 'they']);
const SINGULAR_S_NOUNS = new Set([
    'news', 'politics', 'economics', 'mathematics', 'physics', 'linguistics',
    'athletics', 'gymnastics', 'statistics', 'bus', 'glass', 'grass', 'class',
    'pass', 'mass', 'gas', 'boss', 'loss', 'cross', 'dress', 'press',
    'stress', 'mess', 'chess', 'guess', 'kiss', 'miss', 'bliss', 'abyss',
]);
const IRREGULAR_PLURALS = new Set([
    'children', 'men', 'women', 'people', 'teeth', 'feet', 'mice', 'geese', 'oxen',
]);
const UNCOUNTABLE = new Set([
    'sheep', 'fish', 'deer', 'series', 'species', 'aircraft',
]);

/**
 * Detect the number context (SG / PL) from the current sentence by
 * scanning backwards for the most recent subject marker.
 *
 * @param {string[]} words
 * @param {string[]} posTags
 * @returns {'SG'|'PL'|null}
 */
export function detectNumber(words, posTags) {
    if (!words || words.length === 0) return null;
    for (let i = words.length - 1; i >= 0; i--) {
        const w = words[i].toLowerCase().replace(/[.,!?]+$/, '');
        const p = posTags[i];
        if (p === 'DET') {
            if (SG_DETERMINERS.has(w)) return 'SG';
            if (PL_DETERMINERS.has(w)) return 'PL';
            return null; // ambiguous (the, some, …)
        }
        if (p === 'PRON') {
            if (SG_PRONOUNS.has(w)) return 'SG';
            if (PL_PRONOUNS.has(w)) return 'PL';
            if (w === 'you') return 'PL'; // takes plural verb forms
            return null;
        }
        if (p === 'NOUN') {
            if (UNCOUNTABLE.has(w)) return null;
            if (IRREGULAR_PLURALS.has(w)) return 'PL';
            if (SINGULAR_S_NOUNS.has(w)) return 'SG';
            if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) return 'PL';
            return 'SG';
        }
        // Past a verb/aux we've left the subject
        if (p === 'VERB' || p === 'AUX') break;
    }
    return null;
}

/** Internal: is a noun word plural? Returns true/false/null. */
function isNounPlural(w) {
    if (UNCOUNTABLE.has(w)) return null;
    if (IRREGULAR_PLURALS.has(w)) return true;
    if (SINGULAR_S_NOUNS.has(w)) return false;
    if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) return true;
    return false;
}

/**
 * Return a multiplier (0.1 – 1.2) reflecting how well a candidate word
 * agrees with the expected number context.
 */
function numberFactor(word, pos, expected) {
    if (!expected) return 1.0;
    const w = word.toLowerCase();
    if (pos === 'NOUN') {
        const pl = isNounPlural(w);
        if (pl === null) return 1.0;
        if (expected === 'SG' && pl) return 0.15;
        if (expected === 'PL' && !pl) return 0.25;
        return 1.2;
    }
    if (pos === 'VERB') {
        const is3sg = w.endsWith('s') && !w.endsWith('ss') && w.length > 3;
        if (expected === 'SG' && !is3sg) return 0.6;
        if (expected === 'PL' && is3sg) return 0.2;
        return 1.1;
    }
    return 1.0;
}

/**
 * Compute a grammar boost for a candidate word given the sentence context.
 * Returns a value ≥ 0 where higher means the word fits better.
 *
 * @param {string}   word          - the candidate word
 * @param {string[]} sentenceWords - committed words so far
 * @param {string[]} sentencePOS   - POS tags of committed words
 * @returns {number}
 */
export function grammarBoost(word, sentenceWords, sentencePOS) {
    const predicted = predictNextPOS(sentenceWords, sentencePOS);
    const wordTags = tagWordAll(word);

    // Take the best (highest probability) tag match
    let best = 0;
    for (const t of wordTags) {
        const p = predicted[t] || 0;
        if (p > best) best = p;
    }

    // Apply number-agreement factor
    const numCtx = detectNumber(sentenceWords, sentencePOS);
    if (numCtx && best > 0) {
        best *= numberFactor(word, tagWord(word), numCtx);
    }

    return best;
}

// ═══════════════════════════════════════════════════════════════════════════
// TENSE DETECTION
// ═══════════════════════════════════════════════════════════════════════════

const PAST_AUX = new Set(['was', 'were', 'had', 'did', 'could', 'would', 'should', 'might']);
const PRESENT_AUX = new Set(['is', 'am', 'are', 'has', 'have', 'do', 'does', 'can', 'may', 'will', 'shall']);
const FUTURE_AUX = new Set(['will', 'shall']);

const PAST_INDICATORS = new Set([
    'yesterday', 'ago', 'previously', 'earlier', 'once', 'formerly', 'last',
]);
const FUTURE_INDICATORS = new Set([
    'tomorrow', 'soon', 'later', 'eventually', 'next', 'upcoming',
]);

/**
 * Infer the tense of the current sentence from committed words and POS tags.
 * Returns 'PAST', 'PRESENT', 'FUTURE', or 'UNKNOWN'.
 *
 * @param {string[]} words
 * @param {string[]} posTags
 * @returns {string}
 */
export function inferTense(words, posTags) {
    if (words.length === 0) return 'UNKNOWN';

    const lc = words.map(w => w.toLowerCase().replace(/[.,!?]$/, ''));

    // Check for future auxiliaries first (will/shall)
    for (const w of lc) {
        if (FUTURE_AUX.has(w)) return 'FUTURE';
    }

    // Check auxiliaries
    for (const w of lc) {
        if (PAST_AUX.has(w)) return 'PAST';
        if (PRESENT_AUX.has(w)) return 'PRESENT';
    }

    // Check adverb/time indicators
    for (const w of lc) {
        if (PAST_INDICATORS.has(w)) return 'PAST';
        if (FUTURE_INDICATORS.has(w)) return 'FUTURE';
    }

    // Check verb morphology
    for (let i = 0; i < lc.length; i++) {
        const w = lc[i];
        const pos = posTags[i];
        if (pos === 'VERB') {
            if (w.endsWith('ed') || w.endsWith('ought') || w.endsWith('ew') || w.endsWith('oke')) return 'PAST';
            if (w.endsWith('ing')) return 'PRESENT';
            if (w.endsWith('s') && !w.endsWith('ss')) return 'PRESENT';
        }
    }

    return 'UNKNOWN';
}
