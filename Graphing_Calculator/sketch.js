/* Graphing Calculator (Draft)
 * - p5.js renderer
 * - Pan (drag), zoom (wheel), reset view
 * - Expression compiler with a whitelist of identifiers
 */

let canvas;

const ui = {
  exprEl: null,
  modeButtons: [],
  plotEl: null,
  statusEl: null,
  canvasWrapEl: null,
  infoBtn: null,
  infoPopup: null,
  resetOverlay: null,
  graphTogglesEl: null,
  hudEl: null,
};

const view = {
  originX: 0,
  originY: 0,
  scale: 80, // pixels per 1 world unit
};

const state = {
  isPanning: false,
  panStartMouseX: 0,
  panStartMouseY: 0,
  panStartOriginX: 0,
  panStartOriginY: 0,

  mode: "cartesian",
  fn: null,
  lastExpr: "",
  steps: [],
  ops: [], // editable operation list (without leading x step)
  hasPlotted: false,
  viewDirty: false, // true after pan/zoom
  lightMode: false,
  theme: "auto", // "light", "dark", "auto"
  toggles: { grid: true, yaxis: true, arrows: true, intermediates: false },
  hoveredToggle: null, // which toggle key is being hovered (for glow effect)
  toggleJustTurnedOff: {}, // tracks toggles recently clicked OFF (prevents immediate hover preview)
  stepEyes: { x: true, ops: [], y: true }, // per-step visibility (eye toggles)
  hoveredStep: null, // "x" | "op-0" | "op-1" | ... | "y" (for glow)
  statusText: "",
  statusKind: "info",
};

function setStatus(message, kind = "info") {
  state.statusText = message || "";
  state.statusKind = kind;
}

function setStatusForCurrentMode() {
  if (!state.fn) return;
  const expr = state.lastExpr || ui.exprEl?.value || "";
  if (state.mode === "cartesian") {
    setStatus(`Plotting y = ${expr}`, "info");
  } else if (state.mode === "delta") {
    setStatus(`Plotting Δ(x) = f(x) − x for f(x) = ${expr}`, "info");
  } else if (state.mode === "numberLines") {
    setStatus(`Mapping x → f(x) for f(x) = ${expr}`, "info");
  }
}

function resetView() {
  view.originX = width * 0.5;
  view.originY = height * 0.5;
  view.scale = 80;
}

function screenToWorld(sx, sy) {
  return {
    x: (sx - view.originX) / view.scale,
    y: (view.originY - sy) / view.scale,
  };
}

function worldToScreen(wx, wy) {
  return {
    x: view.originX + wx * view.scale,
    y: view.originY - wy * view.scale,
  };
}

function niceGridStep(pxPerUnit) {
  // Pick a world-space step so that grid lines are roughly 25–80px apart.
  const targetPx = 45;
  const raw = targetPx / Math.max(1e-9, pxPerUnit); // world units
  const pow10 = Math.pow(10, Math.floor(Math.log10(raw)));
  const candidates = [1, 2, 5, 10].map((m) => m * pow10);

  let best = candidates[0];
  let bestScore = Infinity;
  for (const c of candidates) {
    const px = c * pxPerUnit;
    const score = Math.abs(px - targetPx);
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }

  return best;
}

function drawGridLines() {
  const minorStep = niceGridStep(view.scale);

  const topLeft = screenToWorld(0, 0);
  const botRight = screenToWorld(width, height);

  const minX = Math.min(topLeft.x, botRight.x);
  const maxX = Math.max(topLeft.x, botRight.x);
  const minY = Math.min(topLeft.y, botRight.y);
  const maxY = Math.max(topLeft.y, botRight.y);

  const majorStep = minorStep * 5;

  const xCol = getStepColor("x");
  const yCol = getStepColor("y");

  strokeWeight(1);

  // Vertical lines
  for (let x = Math.floor(minX / minorStep) * minorStep; x <= maxX; x += minorStep) {
    const sx = worldToScreen(x, 0).x;
    const isMajor = Math.abs((x / majorStep) - Math.round(x / majorStep)) < 1e-9;
    const alpha = isMajor ? 40 : 16;
    stroke(red(xCol), green(xCol), blue(xCol), alpha);
    line(sx, 0, sx, height);
  }

  // Horizontal lines
  for (let y = Math.floor(minY / minorStep) * minorStep; y <= maxY; y += minorStep) {
    const sy = worldToScreen(0, y).y;
    const isMajor = Math.abs((y / majorStep) - Math.round(y / majorStep)) < 1e-9;
    const alpha = isMajor ? 40 : 16;
    stroke(red(yCol), green(yCol), blue(yCol), alpha);
    line(0, sy, width, sy);
  }
}

function computeVisibleDomainRange() {
  if (!state.fn) return { domainMin: -Infinity, domainMax: Infinity, rangeMin: -Infinity, rangeMax: Infinity };
  const { minX, maxX } = getVisibleWorldBounds();
  let domainMin = Infinity, domainMax = -Infinity;
  let rangeMin = Infinity, rangeMax = -Infinity;
  const samples = 500;
  const step = (maxX - minX) / samples;
  for (let i = 0; i <= samples; i++) {
    const x = minX + i * step;
    let y;
    try { y = state.fn(x); } catch { continue; }
    if (!Number.isFinite(y)) continue;
    if (x < domainMin) domainMin = x;
    if (x > domainMax) domainMax = x;
    if (y < rangeMin) rangeMin = y;
    if (y > rangeMax) rangeMax = y;
  }
  return { domainMin, domainMax, rangeMin, rangeMax };
}

function drawAxesAndLabels(majorStep) {
  // Axes
  const showYAxis = state.toggles.yaxis;
  const xAxisColor = getStepColor("x");
  const yAxisColor = getStepColor("y");
  const tickAlpha = state.lightMode ? 80 : 120;
  const tickColor = state.lightMode ? color(0, 0, 0, tickAlpha) : color(255, 255, 255, tickAlpha);

  const xAxisY = worldToScreen(0, 0).y;
  const yAxisX = worldToScreen(0, 0).x;

  const dr = state.fn ? computeVisibleDomainRange() : null;

  // x-axis — clipped to domain (respects eye visibility)
  strokeWeight(2);
  if (state.stepEyes.x && xAxisY >= 0 && xAxisY <= height) {
    // Apply glow if hovering x step
    if (state.hoveredStep === "x") {
      drawingContext.shadowBlur = 32;
      drawingContext.shadowColor = state.lightMode
        ? "rgba(0, 80, 255, 0.75)"
        : "rgba(100, 180, 255, 0.85)";
    }
    stroke(red(xAxisColor), green(xAxisColor), blue(xAxisColor), 220);
    if (dr && Number.isFinite(dr.domainMin) && Number.isFinite(dr.domainMax)) {
      const sx1 = worldToScreen(dr.domainMin, 0).x;
      const sx2 = worldToScreen(dr.domainMax, 0).x;
      line(Math.max(0, sx1), xAxisY, Math.min(width, sx2), xAxisY);
    } else {
      line(0, xAxisY, width, xAxisY);
    }
    drawingContext.shadowBlur = 0;
    drawingContext.shadowColor = "transparent";
  }
  // y-axis — clipped to range (with selective glow)
  if (showYAxis && yAxisX >= 0 && yAxisX <= width) {
    // Apply glow if hovering y-axis toggle OR hovering y step
    if (state.hoveredToggle === "yaxis" || state.hoveredStep === "y") {
      drawingContext.shadowBlur = 32;
      drawingContext.shadowColor = state.lightMode
        ? "rgba(0, 80, 255, 0.75)"
        : "rgba(100, 180, 255, 0.85)";
    }
    stroke(red(yAxisColor), green(yAxisColor), blue(yAxisColor), 220);
    if (dr && Number.isFinite(dr.rangeMin) && Number.isFinite(dr.rangeMax)) {
      const sy1 = worldToScreen(0, dr.rangeMax).y;
      const sy2 = worldToScreen(0, dr.rangeMin).y;
      line(yAxisX, Math.max(0, sy1), yAxisX, Math.min(height, sy2));
    } else {
      line(yAxisX, 0, yAxisX, height);
    }
    drawingContext.shadowBlur = 0;
    drawingContext.shadowColor = "transparent";
  }

  // Labels
  const topLeft = screenToWorld(0, 0);
  const botRight = screenToWorld(width, height);

  const minX = Math.min(topLeft.x, botRight.x);
  const maxX = Math.max(topLeft.x, botRight.x);
  const minY = Math.min(topLeft.y, botRight.y);
  const maxY = Math.max(topLeft.y, botRight.y);

  textFont("ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace");
  textSize(12);
  const labelCol = state.lightMode ? [30, 35, 50, 190] : [230, 240, 255, 190];
  fill(...labelCol);
  noStroke();

  // x tick labels along x-axis (or bottom if axis offscreen)
  const labelY = (xAxisY >= 16 && xAxisY <= height - 16) ? xAxisY + 14 : height - 10;
  const labelXForY = (yAxisX >= 40 && yAxisX <= width - 40) ? yAxisX + 6 : 8;

  // x ticks
  stroke(tickColor);
  strokeWeight(1);
  for (let x = Math.floor(minX / majorStep) * majorStep; x <= maxX; x += majorStep) {
    const s = worldToScreen(x, 0);
    if (s.x < -50 || s.x > width + 50) continue;

    const ty = (xAxisY >= 0 && xAxisY <= height) ? xAxisY : labelY;
    line(s.x, ty - 4, s.x, ty + 4);

    noStroke();
    fill(...labelCol);
    text(formatNumber(x), s.x + 4, labelY);
    stroke(tickColor);
  }

  // y ticks
  if (showYAxis) {
    for (let y = Math.floor(minY / majorStep) * majorStep; y <= maxY; y += majorStep) {
      const s = worldToScreen(0, y);
      if (s.y < -50 || s.y > height + 50) continue;

      const tx = (yAxisX >= 0 && yAxisX <= width) ? yAxisX : labelXForY;
      line(tx - 4, s.y, tx + 4, s.y);

      noStroke();
      fill(...labelCol);
      text(formatNumber(y), tx + 8, s.y - 4);
      stroke(tickColor);
    }
  }
}

function formatNumber(v) {
  // Keep labels compact.
  const av = Math.abs(v);
  if (av === 0) return "0";
  if (av >= 1000 || av < 0.001) return v.toExponential(1);
  const s = v.toFixed(3);
  return s.replace(/\.?0+$/, "");
}

function getPlotColor() {
  const [r, g, b] = hexToRgb(userColors.curve);
  return color(r, g, b);
}

function getDeltaArrowColor(delta) {
  // Use a neutral color for arrows — step-typed coloring is preferred
  return state.lightMode ? color(80, 90, 110, 200) : color(180, 195, 220, 200);
}

function getVisibleWorldBounds() {
  const topLeft = screenToWorld(0, 0);
  const botRight = screenToWorld(width, height);
  return {
    minX: Math.min(topLeft.x, botRight.x),
    maxX: Math.max(topLeft.x, botRight.x),
    minY: Math.min(topLeft.y, botRight.y),
    maxY: Math.max(topLeft.y, botRight.y),
  };
}

function getMajorStepWorld() {
  const minorStep = niceGridStep(view.scale);
  return minorStep * 5;
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}

/* ======= Single source of truth for all op/badge/toolbox colours ======= */
const OP_COLORS = {
  x: "#4682dc",
  y: "#5ac878",
  addSub: "#dc5050",
  mulDiv: "#e6963c",
  exp: "#e6c030",   // exponential-related: power, root, b^x, log, ln, exp, 10^x
  trig: "#a064c8",   // sin, cos, tan, asin, acos, atan
  misc: "#8892a8",   // abs, floor, ceil, round
  curve: "#5ac878",
};
const userColors = OP_COLORS;

/* Classify an op into a colour category */
const TRIG_FNS = new Set(["sin", "cos", "tan", "asin", "acos", "atan"]);
const EXP_FNS = new Set(["exp", "ln", "log"]);

function getOpCategory(op) {
  if (op.type === "add" || op.type === "sub") return "addSub";
  if (op.type === "mul" || op.type === "div") return "mulDiv";
  const fn = getFunctionName(op);
  if (fn) {
    if (TRIG_FNS.has(fn)) return "trig";
    if (EXP_FNS.has(fn)) return "exp";
    return "misc";
  }
  if (getPowerExponent(op) !== null) return "exp";
  if (getRootN(op) !== null) return "exp";
  if (getExpBase(op) !== null) return "exp";
  if (getLogBase(op) !== null) return "exp";
  if (op.label === "10^x") return "exp";
  return "misc";
}

// Map raw op type strings ("add","mul","other") to OP_COLORS keys
function resolveTypeToCategory(type) {
  if (type === "add" || type === "sub") return "addSub";
  if (type === "mul" || type === "div") return "mulDiv";
  return "misc";
}

// ---- Step colors (for arrows and boxes): use OP_COLORS single source of truth ----
// Accepts a category key ("x","y","addSub","exp",…) OR a step/op object (with .type/.label)
function getStepColor(typeOrOp) {
  let cat;
  if (typeof typeOrOp === "object" && typeOrOp !== null) {
    // For special step types like "x"/"y" that exist directly in OP_COLORS
    cat = OP_COLORS[typeOrOp.type] ? typeOrOp.type : getOpCategory(typeOrOp);
  } else {
    cat = OP_COLORS[typeOrOp] ? typeOrOp : resolveTypeToCategory(typeOrOp);
  }
  const hex = OP_COLORS[cat] || OP_COLORS.misc;
  const [r, g, b] = hexToRgb(hex);
  return color(r, g, b);
}

// ---- Expression parser: tokenize -> AST -> linearized steps ----
const TOK = {
  NUM: "NUM",
  VAR_X: "VAR_X",
  IDENT: "IDENT",
  PLUS: "PLUS",
  MINUS: "MINUS",
  STAR: "STAR",
  SLASH: "SLASH",
  STARSTAR: "STARSTAR",
  LPAREN: "LPAREN",
  RPAREN: "RPAREN",
  COMMA: "COMMA",
  EOF: "EOF",
};

function tokenize(str) {
  const s = str.replace(/\s+/g, "").replace(/\^/g, "**");
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === "+") {
      tokens.push({ type: TOK.PLUS });
      i++;
    } else if (s[i] === "-") {
      tokens.push({ type: TOK.MINUS });
      i++;
    } else if (s[i] === "*") {
      if (s[i + 1] === "*") {
        tokens.push({ type: TOK.STARSTAR });
        i += 2;
      } else {
        tokens.push({ type: TOK.STAR });
        i++;
      }
    } else if (s[i] === "/") {
      tokens.push({ type: TOK.SLASH });
      i++;
    } else if (s[i] === "(") {
      tokens.push({ type: TOK.LPAREN });
      i++;
    } else if (s[i] === ")") {
      tokens.push({ type: TOK.RPAREN });
      i++;
    } else if (s[i] === ",") {
      tokens.push({ type: TOK.COMMA });
      i++;
    } else if (/[0-9.]/.test(s[i])) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      const num = parseFloat(s.slice(i, j));
      if (!Number.isFinite(num)) throw new Error("Invalid number");
      tokens.push({ type: TOK.NUM, value: num });
      i = j;
    } else if (/[a-zA-Z_]/.test(s[i])) {
      let j = i;
      while (j < s.length && /[a-zA-Z0-9_]/.test(s[j])) j++;
      const id = s.slice(i, j);
      if (id === "x") tokens.push({ type: TOK.VAR_X });
      else tokens.push({ type: TOK.IDENT, value: id });
      i = j;
    } else {
      i++;
    }
  }
  tokens.push({ type: TOK.EOF });
  return tokens;
}

function parseExpression(tokens) {
  let pos = 0;
  function cur() {
    return tokens[pos] || { type: TOK.EOF };
  }
  function consume(ty) {
    if (cur().type === ty) {
      pos++;
      return true;
    }
    return false;
  }

  function expr() {
    let left = term();
    while (cur().type === TOK.PLUS || cur().type === TOK.MINUS) {
      const op = cur().type === TOK.PLUS ? "+" : "-";
      pos++;
      const right = term();
      left = { type: "binary", op, left, right };
    }
    return left;
  }

  function term() {
    let left = factor();
    while (cur().type === TOK.STAR || cur().type === TOK.SLASH) {
      const op = cur().type === TOK.STAR ? "*" : "/";
      pos++;
      const right = factor();
      left = { type: "binary", op, left, right };
    }
    return left;
  }

  function factor() {
    return power();
  }

  function power() {
    let left = unary();
    if (consume(TOK.STARSTAR)) {
      const right = power();
      return { type: "binary", op: "**", left, right };
    }
    return left;
  }

  function unary() {
    if (consume(TOK.PLUS)) return unary();
    if (consume(TOK.MINUS)) return { type: "binary", op: "-", left: { type: "num", value: 0 }, right: unary() };
    return postfix();
  }

  function postfix() {
    const p = primary();
    if (cur().type === TOK.LPAREN) {
      pos++;
      const arg = expr();
      if (!consume(TOK.RPAREN)) throw new Error("Expected )");
      return { type: "call", fn: p.type === "ident" ? p.value : null, arg };
    }
    return p;
  }

  function primary() {
    if (consume(TOK.LPAREN)) {
      const e = expr();
      if (!consume(TOK.RPAREN)) throw new Error("Expected )");
      return e;
    }
    if (cur().type === TOK.NUM) {
      const v = cur().value;
      pos++;
      return { type: "num", value: v };
    }
    if (cur().type === TOK.VAR_X) {
      pos++;
      return { type: "var", name: "x" };
    }
    if (cur().type === TOK.IDENT) {
      const value = cur().value;
      pos++;
      return { type: "ident", value };
    }
    throw new Error("Unexpected token");
  }

  const ast = expr();
  if (cur().type !== TOK.EOF) throw new Error("Unexpected token");
  return ast;
}

function exprString(node) {
  if (!node) return "";
  if (node.type === "num") return String(node.value);
  if (node.type === "var") return "x";
  if (node.type === "ident") return node.value;
  if (node.type === "binary") {
    const left = exprString(node.left);
    const right = exprString(node.right);
    const needParenLeft = node.left.type === "binary" && precedence(node.left.op) < precedence(node.op);
    const needParenRight = node.right.type === "binary" && precedence(node.right.op) <= precedence(node.op);
    return (needParenLeft ? "(" + left + ")" : left) + node.op + (needParenRight ? "(" + right + ")" : right);
  }
  if (node.type === "call") {
    const fn = node.fn || exprString(node.arg);
    return fn + "(" + exprString(node.arg) + ")";
  }
  return "";
}

function precedence(op) {
  if (op === "+" || op === "-") return 1;
  if (op === "*" || op === "/") return 2;
  if (op === "**") return 3;
  return 0;
}

const ALLOWED_IDS = new Set([
  "x", "pi", "e", "sin", "cos", "tan", "asin", "acos", "atan",
  "sqrt", "abs", "ln", "log", "exp", "floor", "ceil", "round",
]);

/**
 * Check whether an AST subtree contains a reference to x.
 */
function astContainsX(node) {
  if (!node) return false;
  if (node.type === "var") return true;
  if (node.type === "binary") return astContainsX(node.left) || astContainsX(node.right);
  if (node.type === "call") return astContainsX(node.arg);
  return false;
}

function linearize(node) {
  const steps = [];

  function pushStep(type, label, expr, operand, applyToExpr) {
    steps.push({ type, label, expr, operand: operand || null, applyToExpr: applyToExpr || null });
  }

  /**
   * Recursively linearize the AST, always following the branch that contains x.
   * For commutative binary ops where x is on the right, we swap sides so
   * left is always the x-containing branch.
   */
  function go(n) {
    if (!n) return "";
    if (n.type === "num") {
      pushStep("other", String(n.value), String(n.value));
      return String(n.value);
    }
    if (n.type === "var") {
      pushStep("x", "x", "x");
      return "x";
    }
    if (n.type === "ident") {
      if (!ALLOWED_IDS.has(n.value)) throw new Error("Unknown identifier " + n.value);
      pushStep("other", n.value, n.value);
      return n.value;
    }
    if (n.type === "binary") {
      const leftHasX = astContainsX(n.left);
      const rightHasX = astContainsX(n.right);

      if (n.op === "+" || n.op === "-") {
        // If x is only on the right side for +, swap: a+f(x) => f(x)+a
        if (!leftHasX && rightHasX && n.op === "+") {
          const xExpr = go(n.right);
          const otherStr = exprString(n.left);
          const label = "+ " + otherStr;
          const expr = "(" + xExpr + ")+(" + otherStr + ")";
          pushStep("add", label, expr, otherStr, (prev) => "(" + prev + ")+(" + otherStr + ")");
          return expr;
        }
        // If x is only on the right for -, rewrite: a - f(x) => negate(f(x)) + a
        // i.e. operate on x branch first, then handle the subtraction
        if (!leftHasX && rightHasX && n.op === "-") {
          // a - f(x) = -(f(x) - a) ... but that changes semantics.
          // Better: a - f(x) => f(x) * (-1) + a
          const xExpr = go(n.right);
          const otherStr = exprString(n.left);
          // Negate: multiply by -1
          const negExpr = "(" + xExpr + ")*(-1)";
          pushStep("mul", "× −1", negExpr, "-1", (prev) => "(" + prev + ")*(-1)");
          // Then add the constant
          const expr = "(" + negExpr + ")+(" + otherStr + ")";
          pushStep("add", "+ " + otherStr, expr, otherStr, (prev) => "(" + prev + ")+(" + otherStr + ")");
          return expr;
        }
        // Normal case: x on left
        const leftExpr = go(n.left);
        const rightStr = exprString(n.right);
        const label = (n.op === "+" ? "+ " : "− ") + rightStr;
        const expr = "(" + leftExpr + ")" + n.op + "(" + rightStr + ")";
        const op = n.op;
        pushStep(n.op === "+" ? "add" : "sub", label, expr, rightStr, (prev) => "(" + prev + ")" + op + "(" + rightStr + ")");
        return expr;
      }
      if (n.op === "*" || n.op === "/") {
        // If x is only on the right for *, swap: a*f(x) => f(x)*a
        if (!leftHasX && rightHasX && n.op === "*") {
          const xExpr = go(n.right);
          const otherStr = exprString(n.left);
          const label = "× " + otherStr;
          const expr = "(" + xExpr + ")*(" + otherStr + ")";
          pushStep("mul", label, expr, otherStr, (prev) => "(" + prev + ")*(" + otherStr + ")");
          return expr;
        }
        // If x is only on the right for /, rewrite: a / f(x) => f(x)^(-1) * a
        if (!leftHasX && rightHasX && n.op === "/") {
          const xExpr = go(n.right);
          const otherStr = exprString(n.left);
          // Reciprocal: raise to -1
          const recipExpr = "(" + xExpr + ")**(-1)";
          pushStep("other", "^ −1", recipExpr, "-1", (prev) => "(" + prev + ")**(-1)");
          // Then multiply
          const expr = "(" + recipExpr + ")*(" + otherStr + ")";
          pushStep("mul", "× " + otherStr, expr, otherStr, (prev) => "(" + prev + ")*(" + otherStr + ")");
          return expr;
        }
        // Normal case: x on left
        const leftExpr = go(n.left);
        const rightStr = exprString(n.right);
        const label = (n.op === "*" ? "× " : "/ ") + rightStr;
        const expr = "(" + leftExpr + ")" + n.op + "(" + rightStr + ")";
        const op = n.op;
        pushStep(n.op === "*" ? "mul" : "div", label, expr, rightStr, (prev) => "(" + prev + ")" + op + "(" + rightStr + ")");
        return expr;
      }
      if (n.op === "**") {
        const leftExpr = go(n.left);
        const rightStr = exprString(n.right);
        const rightVal = n.right.type === "num" ? n.right.value : null;
        const isInt = rightVal !== null && Number.isInteger(rightVal) && rightVal >= 2;
        const isX = n.left.type === "var";
        if (isX && isInt) {
          const label = "^ " + rightStr;
          const expr = "(" + leftExpr + ")**(" + rightStr + ")";
          pushStep("other", label, expr, rightStr, (prev) => "(" + prev + ")**(" + rightStr + ")");
          return expr;
        }
        const label = "^ " + rightStr;
        const expr = "(" + leftExpr + ")" + "**" + "(" + rightStr + ")";
        pushStep("other", label, expr, rightStr, (prev) => "(" + prev + ")**(" + rightStr + ")");
        return expr;
      }
    }
    if (n.type === "call") {
      const argExpr = go(n.arg);
      const fnName = n.fn || "?";
      const label = fnName + "()";
      const expr = fnName + "(" + argExpr + ")";
      pushStep("other", label, expr, null, (prev) => fnName + "(" + prev + ")");
      return expr;
    }
    return exprString(n);
  }

  go(node);
  return steps;
}

/**
 * Replace ** operators with safePow() calls, handling balanced parentheses.
 * Ensures negative bases with non-integer exponents produce real results.
 */
function replacePowWithSafe(s) {
  let result = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '*' && i + 1 < s.length && s[i + 1] === '*') {
      // Found **. Extract left operand from result, right from remaining.
      let left;
      if (result.endsWith(')')) {
        let depth = 1, j = result.length - 2;
        while (j >= 0 && depth > 0) {
          if (result[j] === ')') depth++;
          if (result[j] === '(') depth--;
          j--;
        }
        j++;
        left = result.substring(j);
        result = result.substring(0, j);
      } else {
        let j = result.length - 1;
        while (j >= 0 && /[a-zA-Z0-9_.]/.test(result[j])) j--;
        j++;
        left = result.substring(j);
        result = result.substring(0, j);
      }
      i += 2; // skip **
      let right;
      if (i < s.length && s[i] === '(') {
        let depth = 1, j = i + 1;
        while (j < s.length && depth > 0) {
          if (s[j] === '(') depth++;
          if (s[j] === ')') depth--;
          j++;
        }
        right = s.substring(i, j);
        i = j;
      } else {
        let j = i;
        if (j < s.length && s[j] === '-') j++;
        while (j < s.length && /[a-zA-Z0-9_.]/.test(s[j])) j++;
        right = s.substring(i, j);
        i = j;
      }
      result += 'safePow(' + left + ',' + right + ')';
    } else {
      result += s[i];
      i++;
    }
  }
  return result;
}

function compileNormalizedExpr(normalized) {
  let jsExpr = normalized
    .replace(/\bpi\b/g, "PI")
    .replace(/\be\b/g, "E")
    .replace(/\blog\b/g, "log10")
    .replace(/\bln\b/g, "log");
  jsExpr = replacePowWithSafe(jsExpr);
  const body =
    '"use strict";' +
    "function safePow(b,e){if(b>=0||e===Math.floor(e))return Math.pow(b,e);return Math.pow(-b,e);}" +
    "const sin=Math.sin, cos=Math.cos, tan=Math.tan;" +
    "const asin=Math.asin, acos=Math.acos, atan=Math.atan;" +
    "const sqrt=Math.sqrt, abs=Math.abs;" +
    "const exp=Math.exp, floor=Math.floor, ceil=Math.ceil, round=Math.round;" +
    "const log=Math.log;" +
    "const log10=(Math.log10?Math.log10:(t)=>Math.log(t)/Math.LN10);" +
    "const PI=Math.PI, E=Math.E;" +
    "return (" + jsExpr + ");";
  return new Function("x", body);
}

function parseAndLinearize(exprRaw) {
  const expr = (exprRaw ?? "").trim();
  if (!expr) return { steps: [], ops: [], fullExpr: "" };
  const normalized = expr.replace(/\s+/g, "").replace(/\^/g, "**");
  const identifiers = normalized.match(/[a-zA-Z_]+/g) || [];
  for (const id of identifiers) {
    if (id !== "x" && !ALLOWED_IDS.has(id)) return { steps: [], ops: [], fullExpr: normalized };
  }
  try {
    const tokens = tokenize(expr);
    const ast = parseExpression(tokens);
    const steps = linearize(ast);
    const fullExpr = steps.length > 0 ? steps[steps.length - 1].expr : normalized;
    const fns = steps.map((s) => ({ ...s, fn: compileNormalizedExpr(s.expr) }));
    // Extract ops (skip leading x step)
    const ops = fns.filter((s) => s.type !== "x").map((s) => ({
      type: s.type, label: s.label, operand: s.operand,
      applyToExpr: s.applyToExpr,
    }));
    return { steps: fns, ops, fullExpr };
  } catch {
    return { steps: [], ops: [], fullExpr: normalized };
  }
}

function rebuildStepsFromOps(ops) {
  let expr = "x";
  const steps = [{ type: "x", label: "x", expr: "x", fn: compileNormalizedExpr("x"), operand: null, applyToExpr: null }];
  for (const op of ops) {
    expr = op.applyToExpr(expr);
    steps.push({ ...op, expr, fn: compileNormalizedExpr(expr) });
  }
  return steps;
}

function swapOp(op) {
  // Arithmetic swap
  const arithSwap = { add: "sub", sub: "add", mul: "div", div: "mul" };
  const newType = arithSwap[op.type];
  if (newType) {
    const labelPrefixes = { add: "+ ", sub: "− ", mul: "× ", div: "/ " };
    const opChars = { add: "+", sub: "-", mul: "*", div: "/" };
    const opChar = opChars[newType];
    return {
      type: newType,
      label: labelPrefixes[newType] + op.operand,
      operand: op.operand,
      applyToExpr: (prev) => "(" + prev + ")" + opChar + "(" + op.operand + ")",
    };
  }
  // Special label swaps
  if (op.label === "x²") {
    return {
      type: "other", label: "sqrt()", operand: null,
      applyToExpr: (prev) => "sqrt(" + prev + ")",
    };
  }
  // b^x swap: base-exponential to log_base
  const expBase = getExpBase(op);
  if (expBase !== null) {
    if (expBase === "10") return {
      type: "other", label: "log()", operand: null,
      applyToExpr: (prev) => "log(" + prev + ")",
    };
    return {
      type: "other",
      label: "log_" + expBase + "()",
      operand: expBase,
      applyToExpr: (prev) => "ln(" + prev + ")/ln(" + expBase + ")",
    };
  }
  // log_b swap: back to b^x
  const logBase = getLogBase(op);
  if (logBase !== null) {
    return {
      type: "other",
      label: logBase + "^x",
      operand: logBase,
      applyToExpr: (prev) => "(" + logBase + ")**(" + prev + ")",
    };
  }
  // Function swap (sin↔asin, cos↔acos, etc.)
  const fnName = getFunctionName(op);
  if (fnName && FUNC_INVERSES[fnName]) {
    const invName = FUNC_INVERSES[fnName];
    // Special cases that aren't simple function wraps
    if (invName === "x^2") {
      return {
        type: "other", label: "x²", operand: null,
        applyToExpr: (prev) => "(" + prev + ")**2",
      };
    }
    if (invName === "10^x") {
      return {
        type: "other", label: "10^x", operand: null,
        applyToExpr: (prev) => "10**(" + prev + ")",
      };
    }
    return {
      type: "other",
      label: invName + "()",
      operand: null,
      applyToExpr: (prev) => invName + "(" + prev + ")",
    };
  }
  // Power swap: ^ N ↔ ⁿ√ N (keep operand, change operation)
  const exp = getPowerExponent(op);
  if (exp !== null) {
    return {
      type: "other",
      label: "ⁿ√ " + exp,
      operand: exp,
      applyToExpr: (prev) => "(" + prev + ")**(1/(" + exp + "))",
    };
  }
  // Root swap: ⁿ√ N → ^ N
  const rootN = getRootN(op);
  if (rootN !== null) {
    return {
      type: "other",
      label: "^ " + rootN,
      operand: rootN,
      applyToExpr: (prev) => "(" + prev + ")**(" + rootN + ")",
    };
  }
  return null;
}

const FUNC_INVERSES = {
  sin: "asin", asin: "sin",
  cos: "acos", acos: "cos",
  tan: "atan", atan: "tan",
  sqrt: "x^2",
  ln: "exp", exp: "ln",
  log: "10^x",
};

function getFunctionName(op) {
  if (op.type !== "other") return null;
  const m = op.label.match(/^([a-zA-Z_]+)\(\)$/);
  return m ? m[1] : null;
}

/**
 * Check if an op is a power/exponent step (label like "^ 3").
 * Returns the exponent string if so, null otherwise.
 */
function getPowerExponent(op) {
  if (op.type !== "other") return null;
  const m = op.label.match(/^\^\s*(.+)$/);
  return m ? m[1].trim() : null;
}

function getRootN(op) {
  if (op.type !== "other") return null;
  const m = op.label.match(/^ⁿ√\s*(.+)$/);
  return m ? m[1].trim() : null;
}

function getExpBase(op) {
  if (op.type !== "other") return null;
  const m = op.label.match(/^(.+)\^x$/);
  return m ? m[1].trim() : null;
}

function getLogBase(op) {
  if (op.type !== "other") return null;
  const m = op.label.match(/^log_(.+)\(\)$/);
  return m ? m[1].trim() : null;
}

function getInverseFunctionLabel(op) {
  if (op.label === "x²") return "sqrt()";
  const expBase = getExpBase(op);
  if (expBase !== null) {
    if (expBase === "10") return "log()";
    return "log_" + expBase + "()";
  }
  const logBase = getLogBase(op);
  if (logBase !== null) return logBase + "^x";
  const fnName = getFunctionName(op);
  if (fnName) {
    const inv = FUNC_INVERSES[fnName];
    if (inv === "x^2") return "x²";
    if (inv === "10^x") return "10^x";
    return inv ? inv + "()" : null;
  }
  const exp = getPowerExponent(op);
  if (exp !== null) return "ⁿ√ " + exp;
  const rootN = getRootN(op);
  if (rootN !== null) return "^ " + rootN;
  return null;
}

function applyOpsChange() {
  try {
    const steps = rebuildStepsFromOps(state.ops);
    state.steps = steps;
    state.fn = steps.length > 0 ? steps[steps.length - 1].fn : null;
    // Sync the text input with the current ops
    syncInputFromOps();
    renderStepRepresentation();
    setStatusForCurrentMode();
  } catch (err) {
    setStatus(err?.message ?? String(err), "error");
  }
}

/**
 * Build a clean display expression from ops, with parallel color information.
 * Returns { text, spans } where spans is [{text, color, isBracket}].
 */
function buildDisplayExpr(ops) {
  const spans = [];
  const xColor = userColors.x;
  spans.push({ text: "x", color: xColor, isBracket: false });
  let prevPrec = 999; // x is a primary, highest precedence

  for (const op of ops) {
    const colorHex = userColors[getColorKeyForOp(op)] || "#aaa";

    if (op.type === "add" || op.type === "sub") {
      const sym = op.type === "add" ? "+" : "-";
      const operand = op.operand || "";
      spans.push({ text: sym, color: colorHex, isBracket: false });
      spans.push({ text: operand, color: colorHex, isBracket: false });
      prevPrec = 1;
    } else if (op.type === "mul" || op.type === "div") {
      const sym = op.type === "mul" ? "*" : "/";
      const operand = op.operand || "";
      if (prevPrec < 2) {
        spans.splice(0, 0, { text: "(", color: colorHex, isBracket: true });
        spans.push({ text: ")", color: colorHex, isBracket: true });
      }
      spans.push({ text: sym, color: colorHex, isBracket: false });
      // Wrap operand in parens if it has lower-precedence operators
      if (/[+\-]/.test(operand) && !/^\d/.test(operand)) {
        spans.push({ text: "(", color: colorHex, isBracket: true });
        spans.push({ text: operand, color: colorHex, isBracket: false });
        spans.push({ text: ")", color: colorHex, isBracket: true });
      } else {
        spans.push({ text: operand, color: colorHex, isBracket: false });
      }
      prevPrec = 2;
    } else {
      const fnName = getFunctionName(op);
      if (fnName) {
        spans.splice(0, 0, { text: fnName + "(", color: colorHex, isBracket: false });
        spans.push({ text: ")", color: colorHex, isBracket: false });
        prevPrec = 999;
      } else if (op.label === "x²") {
        if (prevPrec < 3) {
          spans.splice(0, 0, { text: "(", color: colorHex, isBracket: true });
          spans.push({ text: ")", color: colorHex, isBracket: true });
        }
        spans.push({ text: "^2", color: colorHex, isBracket: false });
        prevPrec = 3;
      } else if (getExpBase(op) !== null) {
        const base = op.operand || getExpBase(op);
        spans.splice(0, 0, { text: base + "^(", color: colorHex, isBracket: false });
        spans.push({ text: ")", color: colorHex, isBracket: false });
        prevPrec = 999;
      } else if (getLogBase(op) !== null) {
        const base = op.operand || getLogBase(op);
        spans.splice(0, 0, { text: "ln(", color: colorHex, isBracket: false });
        spans.push({ text: ")/ln(" + base + ")", color: colorHex, isBracket: false });
        prevPrec = 999;
      } else if (op.label === "^ −1" || op.label === "^ -1") {
        if (prevPrec < 3) {
          spans.splice(0, 0, { text: "(", color: colorHex, isBracket: true });
          spans.push({ text: ")", color: colorHex, isBracket: true });
        }
        spans.push({ text: "^(-1)", color: colorHex, isBracket: false });
        prevPrec = 3;
      } else if (getPowerExponent(op) !== null) {
        const expStr = op.operand || getPowerExponent(op);
        if (prevPrec < 3) {
          spans.splice(0, 0, { text: "(", color: colorHex, isBracket: true });
          spans.push({ text: ")", color: colorHex, isBracket: true });
        }
        spans.push({ text: "^", color: colorHex, isBracket: false });
        spans.push({ text: expStr, color: colorHex, isBracket: false });
        prevPrec = 3;
      } else if (getRootN(op) !== null) {
        const rootN = op.operand || getRootN(op);
        if (prevPrec < 3) {
          spans.splice(0, 0, { text: "(", color: colorHex, isBracket: true });
          spans.push({ text: ")", color: colorHex, isBracket: true });
        }
        spans.push({ text: "^(1/", color: colorHex, isBracket: false });
        spans.push({ text: rootN, color: colorHex, isBracket: false });
        spans.push({ text: ")", color: colorHex, isBracket: false });
        prevPrec = 3;
      } else {
        spans.push({ text: op.label, color: colorHex, isBracket: false });
        prevPrec = 0;
      }
    }
  }

  const text = spans.map(s => s.text).join('');
  return { text, spans };
}

/**
 * Reconstruct a human-readable expression from state.ops
 * and update the text input to match.
 */
function syncInputFromOps() {
  if (!ui.exprEl || !state.ops.length) return;
  const { text, spans } = buildDisplayExpr(state.ops);
  ui.exprEl.value = text;
  state.lastExpr = text;
  state.displaySpans = spans;
  updateInputOverlay();
}

/**
 * Build a colored overlay that shows each part of the expression
 * colored by its corresponding step type.
 */
function updateInputOverlay() {
  if (!ui.exprOverlay || !ui.exprEl) return;
  const text = ui.exprEl.value;
  if (!text || !state.ops.length || state.ops.length < 1) {
    ui.exprOverlay.innerHTML = "";
    return;
  }

  // If we have pre-built spans from buildDisplayExpr, use them
  if (state.displaySpans && state.displaySpans.length) {
    ui.exprOverlay.innerHTML = state.displaySpans
      .map(s => {
        const opacity = s.isBracket ? 0.35 : 1;
        return '<span style="color:' + s.color + ';opacity:' + opacity + '">' + escapeHtml(s.text) + '</span>';
      })
      .join('');
    return;
  }

  // Fallback: color from ops
  const ops = state.ops;
  const spans = [];
  spans.push({ text: "x", color: getStepColorHex("x") });
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const hex = userColors[getColorKeyForOp(op)] || "#aaa";
    if (op.type === "add") { spans.push({ text: "+", color: hex }); spans.push({ text: op.operand || "", color: hex }); }
    else if (op.type === "sub") { spans.push({ text: "-", color: hex }); spans.push({ text: op.operand || "", color: hex }); }
    else if (op.type === "mul") { spans.push({ text: "*", color: hex }); spans.push({ text: op.operand || "", color: hex }); }
    else if (op.type === "div") { spans.push({ text: "/", color: hex }); spans.push({ text: op.operand || "", color: hex }); }
    else {
      const fnName = getFunctionName(op);
      if (fnName) {
        spans.splice(0, 0, { text: fnName + "(", color: hex });
        spans.push({ text: ")", color: hex });
      } else if (op.label.startsWith("^")) {
        spans.push({ text: "^", color: hex }); spans.push({ text: op.operand || "", color: hex });
      } else {
        spans.push({ text: op.label, color: hex });
      }
    }
  }
  ui.exprOverlay.innerHTML = spans
    .map(s => '<span style="color:' + s.color + '">' + escapeHtml(s.text) + '</span>')
    .join('');
}

function getStepColorHex(typeOrKey) {
  return OP_COLORS[typeOrKey] || OP_COLORS[resolveTypeToCategory(typeOrKey)] || OP_COLORS.misc;
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function getOpSymbol(step) {
  switch (step.type) {
    case "add": return "+";
    case "sub": return "−";
    case "mul": return "×";
    case "div": return "/";
    default: return null;
  }
}

function getInverseOpSymbol(step) {
  switch (step.type) {
    case "add": return "−";
    case "sub": return "+";
    case "mul": return "/";
    case "div": return "×";
    default: return null;
  }
}

function getOpValue(step) {
  if (step.type === "add" || step.type === "sub") {
    return step.label.replace(/^[+−]\s*/, "");
  }
  if (step.type === "mul" || step.type === "div") {
    return step.label.replace(/^[×/]\s*/, "");
  }
  return null;
}

function getInverseType(type) {
  if (type === "add") return "sub";
  if (type === "sub") return "add";
  if (type === "mul") return "div";
  if (type === "div") return "mul";
  return type;
}

function getColorKeyForOp(op) {
  return getOpCategory(op);
}

function renderStepRepresentation() {
  const el = document.getElementById("step-rep");
  if (!el) return;
  el.innerHTML = "";
  const ops = state.ops;
  if (!ops.length) {
    el.classList.add("step-rep--empty");
    return;
  }
  el.classList.remove("step-rep--empty");

  // Sync stepEyes.ops length with current ops
  while (state.stepEyes.ops.length < ops.length) state.stepEyes.ops.push(true);
  state.stepEyes.ops.length = ops.length;

  const flow = document.createElement("div");
  flow.className = "step-flow";

  // SVG eye icon generators
  function eyeOpenSvg(col) {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="' + col + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  }
  function eyeClosedSvg(col) {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="' + col + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  }

  function getEyeColor(stepKey) {
    if (stepKey === "x") return OP_COLORS.x;
    if (stepKey === "y") return OP_COLORS.y;
    const idx = parseInt(stepKey);
    if (!isNaN(idx) && state.ops[idx]) return OP_COLORS[getOpCategory(state.ops[idx])] || OP_COLORS.misc;
    return OP_COLORS.misc;
  }

  // Helper: create an eye toggle button for a step
  function createEyeBtn(stepKey, isVisible) {
    const btn = document.createElement("button");
    btn.className = "eye-btn" + (isVisible ? " eye-btn--on" : "");
    btn.type = "button";
    const col = getEyeColor(stepKey);
    btn.innerHTML = isVisible ? eyeOpenSvg(col) : eyeClosedSvg(col);
    btn.title = isVisible ? "Hide" : "Show";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (stepKey === "x") {
        state.stepEyes.x = !state.stepEyes.x;
        btn.classList.toggle("eye-btn--on", state.stepEyes.x);
        btn.innerHTML = state.stepEyes.x ? eyeOpenSvg(col) : eyeClosedSvg(col);
        btn.title = state.stepEyes.x ? "Hide" : "Show";
      } else if (stepKey === "y") {
        state.stepEyes.y = !state.stepEyes.y;
        btn.classList.toggle("eye-btn--on", state.stepEyes.y);
        btn.innerHTML = state.stepEyes.y ? eyeOpenSvg(col) : eyeClosedSvg(col);
        btn.title = state.stepEyes.y ? "Hide" : "Show";
      } else {
        const idx = parseInt(stepKey);
        state.stepEyes.ops[idx] = !state.stepEyes.ops[idx];
        btn.classList.toggle("eye-btn--on", state.stepEyes.ops[idx]);
        btn.innerHTML = state.stepEyes.ops[idx] ? eyeOpenSvg(col) : eyeClosedSvg(col);
        btn.title = state.stepEyes.ops[idx] ? "Hide" : "Show";
      }
    });
    return btn;
  }

  // Helper: wrap an element with an eye button in a column
  function wrapWithEye(element, stepKey, isVisible) {
    const col = document.createElement("div");
    col.className = "step-col";
    col.appendChild(element);
    const eye = createEyeBtn(stepKey, isVisible);
    col.appendChild(eye);
    // Hover: set hoveredStep for glow effect
    col.addEventListener("mouseenter", () => {
      state.hoveredStep = stepKey;
    });
    col.addEventListener("mouseleave", () => {
      if (state.hoveredStep === stepKey) state.hoveredStep = null;
    });
    return col;
  }

  // x endpoint
  const xBox = document.createElement("div");
  xBox.className = "step-endpoint step-box--x";
  xBox.textContent = "x";
  flow.appendChild(wrapWithEye(xBox, "x", state.stepEyes.x));

  let dragSrcIdx = null;
  let dragPreviewOps = null;
  let dragClone = null;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  function makeArrowCol() {
    const col = document.createElement("div");
    col.className = "step-arrows-col";
    col.innerHTML = '<div class="connector-fwd"></div><div class="connector-inv"></div>';
    return col;
  }

  // ---- Drag-to-slide value handler ----
  function attachValDragHandler(valRow, opIdx) {
    valRow.style.cursor = "ew-resize";
    valRow.style.userSelect = "none";
    valRow.style.touchAction = "none";

    let slideActive = false;
    let slideStartX = 0;
    let slideStartVal = 0;

    valRow.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const op = state.ops[opIdx];
      const numVal = parseFloat(op.operand);
      if (isNaN(numVal)) return; // can't slide non-numeric operands

      slideActive = true;
      slideStartX = e.clientX;
      slideStartVal = numVal;
      valRow.setPointerCapture(e.pointerId);
      valRow.classList.add("op-block__val--sliding");
    });

    valRow.addEventListener("pointermove", (e) => {
      if (!slideActive) return;
      const dx = e.clientX - slideStartX; // right = positive
      // Sensitivity: scale relative to the magnitude of the value
      const magnitude = Math.max(Math.abs(slideStartVal), 1);
      const sensitivity = magnitude * 0.01;
      let newVal = slideStartVal + dx * sensitivity;
      // Snap to nice values: round to reasonable precision
      const decimals = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : magnitude >= 1 ? 2 : 3;
      newVal = parseFloat(newVal.toFixed(decimals));

      const op = state.ops[opIdx];
      const newOperand = String(newVal);
      if (newOperand === op.operand) return;

      // Rebuild the op with the new operand
      const labelPrefixes = { add: "+ ", sub: "− ", mul: "× ", div: "/ " };
      const opChars = { add: "+", sub: "-", mul: "*", div: "/" };
      if (labelPrefixes[op.type]) {
        state.ops[opIdx] = {
          type: op.type,
          label: labelPrefixes[op.type] + newOperand,
          operand: newOperand,
          applyToExpr: (prev) => "(" + prev + ")" + opChars[op.type] + "(" + newOperand + ")",
        };
      } else if (getPowerExponent(op) !== null) {
        state.ops[opIdx] = {
          type: "other",
          label: "^ " + newOperand,
          operand: newOperand,
          applyToExpr: (prev) => "(" + prev + ")**(" + newOperand + ")",
        };
      } else if (getRootN(op) !== null) {
        state.ops[opIdx] = {
          type: "other",
          label: "ⁿ√ " + newOperand,
          operand: newOperand,
          applyToExpr: (prev) => "(" + prev + ")**(1/(" + newOperand + "))",
        };
      } else if (getExpBase(op) !== null) {
        state.ops[opIdx] = {
          type: "other",
          label: newOperand + "^x",
          operand: newOperand,
          applyToExpr: (prev) => "(" + newOperand + ")**(" + prev + ")",
        };
      } else if (getLogBase(op) !== null) {
        state.ops[opIdx] = {
          type: "other",
          label: "log_" + newOperand + "()",
          operand: newOperand,
          applyToExpr: (prev) => "ln(" + prev + ")/ln(" + newOperand + ")",
        };
      } else {
        return; // can't slide this type
      }

      // Update display in real time
      valRow.textContent = newOperand;
      try {
        const steps = rebuildStepsFromOps(state.ops);
        state.steps = steps;
        state.fn = steps.length > 0 ? steps[steps.length - 1].fn : null;
        setStatusForCurrentMode();
      } catch { }
    });

    const endSlide = () => {
      if (!slideActive) return;
      slideActive = false;
      valRow.classList.remove("op-block__val--sliding");
      syncInputFromOps();
      renderStepRepresentation();
    };
    valRow.addEventListener("pointerup", endSlide);
    valRow.addEventListener("pointercancel", endSlide);
  }

  function buildOpBlock(op, i) {
    const opBlock = document.createElement("div");
    const fwdSym = getOpSymbol(op);
    const invSym = getInverseOpSymbol(op);
    const val = getOpValue(op);
    const isSimple = fwdSym !== null;

    // Use category for CSS class so colours match OP_COLORS
    const cat = getOpCategory(op);
    opBlock.className = "op-block op-block--" + cat;
    opBlock.dataset.idx = String(i);

    // Delete button (top-right, shown on hover)
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "op-block__delete";
    deleteBtn.innerHTML = "&times;";
    deleteBtn.title = "Remove";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(opBlock.dataset.idx);
      state.ops.splice(idx, 1);
      state.stepEyes.ops.splice(idx, 1);
      applyOpsChange();
    });
    opBlock.appendChild(deleteBtn);

    // Build swap handler
    function addSwapBtn() {
      const swapBtn = document.createElement("button");
      swapBtn.className = "op-block__swap";
      swapBtn.title = "Swap forward/inverse";
      swapBtn.textContent = "⇅";
      swapBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = parseInt(opBlock.dataset.idx);
        const swapped = swapOp(state.ops[idx]);
        if (swapped) {
          state.ops[idx] = swapped;
          applyOpsChange();
        }
      });
      opBlock.appendChild(swapBtn);
    }

    if (isSimple) {
      const fwdRow = document.createElement("div");
      fwdRow.className = "op-block__fwd";
      fwdRow.textContent = fwdSym;
      opBlock.appendChild(fwdRow);

      if (val) {
        const valRow = document.createElement("div");
        valRow.className = "op-block__val";
        valRow.textContent = val;
        attachValDragHandler(valRow, i);
        opBlock.appendChild(valRow);
      }

      const invRow = document.createElement("div");
      invRow.className = "op-block__inv";
      invRow.textContent = invSym;
      opBlock.appendChild(invRow);
      addSwapBtn();
    } else {
      const exp = getPowerExponent(op);
      const rootN = getRootN(op);
      const expBaseVal = getExpBase(op);
      const logBaseVal = getLogBase(op);
      const invLabel = getInverseFunctionLabel(op);

      if (exp !== null || rootN !== null) {
        // Power or root op: show fwd/value/inv layout
        const valStr = exp || rootN;
        const isRoot = rootN !== null;
        const fwdRow = document.createElement("div");
        fwdRow.className = "op-block__fwd";
        fwdRow.textContent = isRoot ? "ⁿ√" : "^";
        opBlock.appendChild(fwdRow);

        const valRow = document.createElement("div");
        valRow.className = "op-block__val";
        valRow.textContent = valStr;
        attachValDragHandler(valRow, i);
        opBlock.appendChild(valRow);

        const invRow = document.createElement("div");
        invRow.className = "op-block__inv";
        invRow.textContent = isRoot ? "^" : "ⁿ√";
        opBlock.appendChild(invRow);
        addSwapBtn();
      } else if (expBaseVal !== null) {
        // b^x op: draggable base value
        const fwdRow = document.createElement("div");
        fwdRow.className = "op-block__fwd";
        fwdRow.textContent = "b^x";
        opBlock.appendChild(fwdRow);

        const valRow = document.createElement("div");
        valRow.className = "op-block__val";
        valRow.textContent = expBaseVal;
        attachValDragHandler(valRow, i);
        opBlock.appendChild(valRow);

        const invRow = document.createElement("div");
        invRow.className = "op-block__inv";
        invRow.textContent = invLabel || "log_b";
        opBlock.appendChild(invRow);
        addSwapBtn();
      } else if (logBaseVal !== null) {
        // log_b op: draggable base value
        const fwdRow = document.createElement("div");
        fwdRow.className = "op-block__fwd";
        fwdRow.textContent = "log_b";
        opBlock.appendChild(fwdRow);

        const valRow = document.createElement("div");
        valRow.className = "op-block__val";
        valRow.textContent = logBaseVal;
        attachValDragHandler(valRow, i);
        opBlock.appendChild(valRow);

        const invRow = document.createElement("div");
        invRow.className = "op-block__inv";
        invRow.textContent = invLabel || "b^x";
        opBlock.appendChild(invRow);
        addSwapBtn();
      } else if (invLabel) {
        const fwdRow = document.createElement("div");
        fwdRow.className = "op-block__fwd";
        fwdRow.textContent = op.label;
        opBlock.appendChild(fwdRow);

        const invRow = document.createElement("div");
        invRow.className = "op-block__inv";
        invRow.textContent = invLabel;
        opBlock.appendChild(invRow);
        addSwapBtn();
      } else {
        const labelRow = document.createElement("div");
        labelRow.className = "op-block__label";
        labelRow.textContent = op.label;
        opBlock.appendChild(labelRow);
      }
    }
    return opBlock;
  }

  function rebuildFlowPreview(previewOps) {
    while (flow.children.length > 1) flow.removeChild(flow.lastChild);
    for (let i = 0; i < previewOps.length; i++) {
      flow.appendChild(makeArrowCol());
      const block = buildOpBlock(previewOps[i], i);
      attachDragHandlers(block);
      if (dragSrcIdx !== null) {
        const origOp = state.ops[dragSrcIdx];
        if (previewOps[i] === origOp) block.classList.add("op-block--dragging");
      }
      const vis = state.stepEyes.ops[i] !== false;
      flow.appendChild(wrapWithEye(block, String(i), vis));
    }
    flow.appendChild(makeArrowCol());
    const yBox = document.createElement("div");
    yBox.className = "step-endpoint step-box--y";
    yBox.textContent = "y";
    flow.appendChild(wrapWithEye(yBox, "y", state.stepEyes.y));
  }

  // ---- Pointer-event drag system (iOS-like) ----
  function onDragMove(e) {
    if (dragSrcIdx === null || !dragClone) return;
    dragClone.style.left = (e.clientX - dragOffsetX) + "px";
    dragClone.style.top = (e.clientY - dragOffsetY) + "px";
    // Hit test: temporarily hide clone to see what's underneath
    dragClone.style.display = "none";
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    dragClone.style.display = "";
    const target = hit?.closest(".op-block");
    if (target && target.dataset.idx !== undefined) {
      const dstIdx = parseInt(target.dataset.idx);
      if (dstIdx !== dragSrcIdx) {
        const preview = [...state.ops];
        const moved = preview.splice(dragSrcIdx, 1)[0];
        preview.splice(dstIdx, 0, moved);
        if (!dragPreviewOps || dragPreviewOps.length !== preview.length ||
          !dragPreviewOps.every((o, k) => o === preview[k])) {
          dragPreviewOps = preview;
          rebuildFlowPreview(preview);
        }
      }
    }
  }

  function onDragEnd() {
    document.removeEventListener("pointermove", onDragMove);
    document.removeEventListener("pointerup", onDragEnd);
    if (dragClone) { dragClone.remove(); dragClone = null; }
    if (dragPreviewOps) {
      state.ops = dragPreviewOps;
      dragPreviewOps = null;
      dragSrcIdx = null;
      try {
        const steps = rebuildStepsFromOps(state.ops);
        state.steps = steps;
        state.fn = steps.length > 0 ? steps[steps.length - 1].fn : null;
        syncInputFromOps();
        setStatusForCurrentMode();
      } catch (err) {
        setStatus(err?.message ?? String(err), "error");
      }
    } else {
      dragSrcIdx = null;
    }
    renderStepRepresentation();
  }

  function attachDragHandlers(opBlock) {
    opBlock.style.touchAction = "none"; // prevent touch scroll interference
    opBlock.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.op-block__swap')) return;
      if (e.target.closest('.op-block__delete')) return;
      if (e.target.closest('.eye-btn')) return;
      if (e.target.closest('.op-block__val')) return;
      e.preventDefault();
      e.stopPropagation();
      dragSrcIdx = parseInt(opBlock.dataset.idx);
      dragPreviewOps = null;
      const rect = opBlock.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
      // Create a floating clone that follows the pointer (iOS-style)
      dragClone = opBlock.cloneNode(true);
      dragClone.style.cssText =
        "position:fixed;z-index:9999;pointer-events:none;" +
        "width:" + rect.width + "px;height:" + rect.height + "px;" +
        "left:" + rect.left + "px;top:" + rect.top + "px;" +
        "opacity:0.92;box-shadow:0 10px 30px rgba(0,0,0,0.35);" +
        "transform:scale(1.06);transition:none;border-radius:6px;";
      document.body.appendChild(dragClone);
      opBlock.classList.add("op-block--dragging");
      document.addEventListener("pointermove", onDragMove);
      document.addEventListener("pointerup", onDragEnd);
    });
  }

  for (let i = 0; i < ops.length; i++) {
    flow.appendChild(makeArrowCol());
    const opBlock = buildOpBlock(ops[i], i);
    attachDragHandlers(opBlock);
    flow.appendChild(wrapWithEye(opBlock, String(i), state.stepEyes.ops[i]));
  }

  // Final arrow column
  flow.appendChild(makeArrowCol());

  // y endpoint
  const yBox = document.createElement("div");
  yBox.className = "step-endpoint step-box--y";
  yBox.textContent = "y";
  flow.appendChild(wrapWithEye(yBox, "y", state.stepEyes.y));

  el.appendChild(flow);
}

function compileExpression(exprRaw) {
  const expr = (exprRaw ?? "").trim();
  if (!expr) throw new Error("Enter an expression, e.g. sin(x) or x^2.");

  // Disallow obviously dangerous/irrelevant characters up-front.
  // Allowed: letters, numbers, underscore, whitespace, basic operators, parentheses, comma, dot for decimals.
  if (/[^a-zA-Z0-9_\s+\-*/^().,]/.test(expr)) {
    throw new Error("Unsupported character detected. Use numbers, x, operators (+-*/^), and functions like sin(x).");
  }

  // Normalize
  let normalized = expr.replace(/\s+/g, "");
  normalized = normalized.replace(/\^/g, "**");

  const allowed = new Set([
    "x",
    "pi",
    "e",
    "sin",
    "cos",
    "tan",
    "asin",
    "acos",
    "atan",
    "sqrt",
    "abs",
    "ln",
    "log",
    "exp",
    "floor",
    "ceil",
    "round",
  ]);

  // Validate identifiers
  const identifiers = normalized.match(/[a-zA-Z_]+/g) ?? [];
  for (const id of identifiers) {
    if (!allowed.has(id)) {
      throw new Error(`Unknown identifier "${id}". Try sin, cos, tan, sqrt, ln, log, pi, e, x.`);
    }
  }

  // Replace constants and function aliases where needed.
  // We avoid "Math." in the user expression entirely and provide a local scope instead.
  let jsExpr = normalized
    .replace(/\bpi\b/g, "PI")
    .replace(/\be\b/g, "E")
    .replace(/\blog\b/g, "log10")
    .replace(/\bln\b/g, "log");
  jsExpr = replacePowWithSafe(jsExpr);

  const body =
    '"use strict";' +
    "function safePow(b,e){if(b>=0||e===Math.floor(e))return Math.pow(b,e);return Math.pow(-b,e);}" +
    "const sin=Math.sin, cos=Math.cos, tan=Math.tan;" +
    "const asin=Math.asin, acos=Math.acos, atan=Math.atan;" +
    "const sqrt=Math.sqrt, abs=Math.abs;" +
    "const exp=Math.exp, floor=Math.floor, ceil=Math.ceil, round=Math.round;" +
    "const log=Math.log;" +
    "const log10=(Math.log10 ? Math.log10 : (t)=>Math.log(t)/Math.LN10);" +
    "const PI=Math.PI, E=Math.E;" +
    "return (" +
    jsExpr +
    ");";

  // If this throws, we surface as a user error.
  const fn = new Function("x", body);

  // Sanity test: evaluate at x=0 to catch immediate syntax issues.
  // (Some expressions are undefined at 0; that's OK as long as it's a number or Infinity/NaN.)
  // eslint-disable-next-line no-unused-vars
  fn(0);

  return fn;
}

function plotFunction() {
  const expr = ui.exprEl?.value ?? "";
  try {
    const fn = compileExpression(expr);
    state.fn = fn;
    state.lastExpr = expr;
    const { steps, ops } = parseAndLinearize(expr);
    state.steps = steps;
    state.ops = ops;
    state.stepEyes.ops = ops.map(() => true); // reset eye visibility for new ops
    renderStepRepresentation();
    setStatusForCurrentMode();
    // Build display spans and color the input
    if (ops.length > 0) {
      const { text, spans } = buildDisplayExpr(ops);
      state.displaySpans = spans;
      ui.exprEl.value = text;
      state.lastExpr = text;
    } else {
      state.displaySpans = null;
    }
    updateInputOverlay();
    // After first successful plot, show the info button
    if (!state.hasPlotted) {
      state.hasPlotted = true;
      if (ui.infoBtn) ui.infoBtn.style.display = "";
    }
  } catch (err) {
    state.fn = null;
    state.steps = [];
    state.ops = [];
    renderStepRepresentation();
    setStatus(err?.message ?? String(err), "error");
  }
  // Flash the plot button
  if (ui.plotEl) {
    ui.plotEl.classList.add("btn--flash");
    setTimeout(() => ui.plotEl.classList.remove("btn--flash"), 300);
  }
}

function setup() {
  ui.exprEl = document.getElementById("expr");
  ui.modeButtons = Array.from(document.querySelectorAll(".mode-btn"));
  ui.plotEl = document.getElementById("plot");
  ui.statusEl = document.getElementById("status");
  ui.canvasWrapEl = document.getElementById("canvas-wrap");
  ui.infoBtn = document.getElementById("info-btn");
  ui.infoPopup = document.getElementById("info-popup");
  ui.graphTogglesEl = document.getElementById("graph-toggles");

  // Create colored overlay for input expression
  if (ui.exprEl) {
    const controlLabel = ui.exprEl.closest(".control") || ui.exprEl.parentElement;
    controlLabel.style.position = "relative";
    const overlay = document.createElement("div");
    overlay.className = "expr-color-overlay";
    overlay.id = "expr-overlay";
    controlLabel.appendChild(overlay);
    ui.exprOverlay = overlay;

    // Position overlay to match the input's left edge within the control
    const positionOverlay = () => {
      const ctrlRect = controlLabel.getBoundingClientRect();
      const inputRect = ui.exprEl.getBoundingClientRect();
      const leftOffset = inputRect.left - ctrlRect.left;
      overlay.style.left = leftOffset + "px";
      overlay.style.right = "0";
    };
    positionOverlay();
    window.addEventListener("resize", positionOverlay);

    // Sync overlay scroll/position with input
    ui.exprEl.addEventListener("scroll", () => {
      overlay.scrollLeft = ui.exprEl.scrollLeft;
    });
    // Clear overlay when user types (manual input overrides ops sync)
    ui.exprEl.addEventListener("input", () => {
      overlay.innerHTML = "";
    });
  }

  // --- Canvas sizing: fill entire viewport ---
  const w = window.innerWidth;
  const h = window.innerHeight;

  canvas = createCanvas(w, h);
  canvas.parent("canvas-wrap");

  // Create reset view overlay button (will be placed inside toggle bar)
  const resetOverlay = document.createElement("button");
  resetOverlay.className = "reset-overlay";
  resetOverlay.textContent = "Reset view";
  resetOverlay.style.display = "none";
  resetOverlay.addEventListener("click", () => {
    resetView();
    state.viewDirty = false;
    resetOverlay.style.display = "none";
  });
  ui.resetOverlay = resetOverlay;

  resetView();

  // ---- UI wiring ----
  ui.plotEl?.addEventListener("click", plotFunction);

  if (ui.modeButtons.length) {
    const active = ui.modeButtons.find((b) => b.classList.contains("mode-btn--active")) || ui.modeButtons[0];
    state.mode = active?.dataset.mode || "cartesian";
    ui.modeButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.mode || "cartesian";
        state.mode = mode;
        ui.modeButtons.forEach((b) => b.classList.toggle("mode-btn--active", b === btn));
        setStatusForCurrentMode();
      });
    });
  }

  ui.exprEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      plotFunction();
    }
  });

  // Info button toggle
  ui.infoBtn?.addEventListener("click", () => {
    const popup = ui.infoPopup;
    if (popup) popup.classList.toggle("info-popup--visible");
  });
  document.addEventListener("click", (e) => {
    if (ui.infoPopup?.classList.contains("info-popup--visible") &&
      !ui.infoPopup.contains(e.target) && e.target !== ui.infoBtn) {
      ui.infoPopup.classList.remove("info-popup--visible");
    }
  });

  // ---- Settings gear (FMTTM-style) ----
  setupSettingsGear();

  // ---- Fullscreen button ----
  setupFullscreenButton();

  // ---- Toggle bar (bottom of graph) ----
  buildToggleBar();

  // ---- HUD overlay (top-right, below topbar) ----
  const hudEl = document.createElement("div");
  hudEl.className = "graph-hud";
  hudEl.id = "graph-hud";
  ui.canvasWrapEl.appendChild(hudEl);
  ui.hudEl = hudEl;

  // ---- Dynamic mode-toggle positioning ----
  const topbar = document.querySelector('.topbar');
  const modeToggle = document.getElementById('mode-toggle-overlay');
  function updateOverlayPositions() {
    if (!topbar) return;
    const h = topbar.getBoundingClientRect().height;
    if (modeToggle) modeToggle.style.top = (h + 12) + "px";
  }
  updateOverlayPositions();
  if (topbar) new ResizeObserver(updateOverlayPositions).observe(topbar);

  // ---- Toolbox (right of step flow) ----
  buildToolbox();

  // First plot
  plotFunction();
}

/* ========== Toolbox: drag-and-drop function/operator palette ========== */

const TOOLBOX_ITEMS = {
  add: { type: "add", operand: "1" },
  sub: { type: "sub", operand: "1" },
  mul: { type: "mul", operand: "2" },
  div: { type: "div", operand: "2" },
  power: { type: "power", operand: "2" },
  root: { type: "root", operand: "2" },
  basePow: { type: "basePow", operand: "2" },
  sin: { type: "function", fn: "sin" },
  cos: { type: "function", fn: "cos" },
  tan: { type: "function", fn: "tan" },
  asin: { type: "function", fn: "asin" },
  acos: { type: "function", fn: "acos" },
  atan: { type: "function", fn: "atan" },
  abs: { type: "function", fn: "abs" },
  ln: { type: "function", fn: "ln" },
  log10: { type: "function", fn: "log" },
  exp: { type: "function", fn: "exp" },
  floor: { type: "function", fn: "floor" },
  ceil: { type: "function", fn: "ceil" },
  round: { type: "function", fn: "round" },
};

function createOpFromToolboxItem(item) {
  const opChars = { add: "+", sub: "-", mul: "*", div: "/" };
  const labelPrefixes = { add: "+ ", sub: "− ", mul: "× ", div: "/ " };

  if (opChars[item.type]) {
    const operand = item.operand;
    return {
      type: item.type,
      label: labelPrefixes[item.type] + operand,
      operand: operand,
      applyToExpr: (prev) => "(" + prev + ")" + opChars[item.type] + "(" + operand + ")",
    };
  }
  if (item.type === "power") {
    const operand = item.operand;
    return {
      type: "other",
      label: "^ " + operand,
      operand: operand,
      applyToExpr: (prev) => "(" + prev + ")**(" + operand + ")",
    };
  }
  if (item.type === "root") {
    const operand = item.operand;
    return {
      type: "other",
      label: "\u207F\u221A " + operand,
      operand: operand,
      applyToExpr: (prev) => "(" + prev + ")**(1/(" + operand + "))",
    };
  }
  if (item.type === "basePow") {
    const operand = item.operand;
    return {
      type: "other",
      label: operand + "^x",
      operand: operand,
      applyToExpr: (prev) => "(" + operand + ")**(" + prev + ")",
    };
  }
  if (item.type === "function") {
    return {
      type: "other",
      label: item.fn + "()",
      operand: null,
      applyToExpr: (prev) => item.fn + "(" + prev + ")",
    };
  }
  return null;
}

function buildToolbox() {
  const tbx = document.getElementById("toolbox");
  if (!tbx) return;

  // Map data-cat attribute to OP_COLORS keys
  const catToKey = { arith: "addSub", exp: "exp", trig: "trig", misc: "misc" };

  const allItems = tbx.querySelectorAll(".toolbox__item[data-tool]");
  for (let k = 0; k < allItems.length; k++) {
    const el = allItems[k];
    const key = el.getAttribute("data-tool");
    const def = TOOLBOX_ITEMS[key];
    if (!def) continue;

    // Color by data-cat attribute, using OP_COLORS single source of truth
    const cat = el.getAttribute("data-cat") || "misc";
    // For arith, use specific sub-colour based on tool key
    let c;
    if (cat === "arith") {
      if (key === "add" || key === "sub") c = OP_COLORS.addSub;
      else if (key === "mul" || key === "div") c = OP_COLORS.mulDiv;
      else c = OP_COLORS.misc;
    } else {
      c = OP_COLORS[catToKey[cat]] || OP_COLORS.misc;
    }
    el.style.borderColor = c;
    el.style.color = c;

    attachToolboxDrag(el, def);
  }
}

function attachToolboxDrag(el, itemDef) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const op = createOpFromToolboxItem(itemDef);
    if (!op) return;

    // Build a full badge ghost (like the op-block in the step sequence)
    const cat = getOpCategory(op);
    const ghost = document.createElement("div");
    ghost.className = "op-block op-block--" + cat;
    // Populate with forward / value / inverse structure
    const fwdSym = getOpSymbol(op);
    const invSym = getInverseOpSymbol(op);
    const val = getOpValue(op);
    if (fwdSym !== null) {
      const fwd = document.createElement("div"); fwd.className = "op-block__fwd"; fwd.textContent = fwdSym; ghost.appendChild(fwd);
      if (val) { const v = document.createElement("div"); v.className = "op-block__val"; v.textContent = val; ghost.appendChild(v); }
      const inv = document.createElement("div"); inv.className = "op-block__inv"; inv.textContent = invSym; ghost.appendChild(inv);
    } else {
      const invLabel = getInverseFunctionLabel(op);
      const fwd = document.createElement("div"); fwd.className = "op-block__fwd"; fwd.textContent = op.label; ghost.appendChild(fwd);
      if (invLabel) { const inv = document.createElement("div"); inv.className = "op-block__inv"; inv.textContent = invLabel; ghost.appendChild(inv); }
    }

    const rect = el.getBoundingClientRect();
    ghost.style.cssText =
      "position:fixed;z-index:9999;pointer-events:none;" +
      "left:" + rect.left + "px;top:" + rect.top + "px;" +
      "opacity:0.85;box-shadow:0 8px 24px rgba(0,0,0,0.3);" +
      "transform:scale(1.05);transition:none;";
    document.body.appendChild(ghost);
    // Measure ghost after append so we can centre it during drag
    const gw = ghost.offsetWidth;
    const gh = ghost.offsetHeight;

    let insertIdx = state.ops.length; // default: append to end
    let hoveredBlock = null;

    const onMove = (ev) => {
      ghost.style.left = (ev.clientX - gw / 2) + "px";
      ghost.style.top = (ev.clientY - gh / 2) + "px";

      // Detect insertion point in the step flow
      ghost.style.display = "none";
      const hit = document.elementFromPoint(ev.clientX, ev.clientY);
      ghost.style.display = "";

      // Clear previous hover
      if (hoveredBlock) {
        hoveredBlock.classList.remove("op-block--dragover");
        hoveredBlock = null;
      }

      const target = hit?.closest(".op-block");
      if (target && target.dataset.idx !== undefined) {
        insertIdx = parseInt(target.dataset.idx) + 1;
        target.classList.add("op-block--dragover");
        hoveredBlock = target;
      } else {
        // Check if over y endpoint or after last op
        const yTarget = hit?.closest(".step-box--y");
        if (yTarget) {
          insertIdx = state.ops.length;
        } else {
          const xTarget = hit?.closest(".step-box--x");
          if (xTarget) {
            insertIdx = 0;
          }
        }
      }
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      ghost.remove();
      if (hoveredBlock) hoveredBlock.classList.remove("op-block--dragover");

      // Insert the op
      state.ops.splice(insertIdx, 0, op);
      state.stepEyes.ops.splice(insertIdx, 0, true);
      applyOpsChange();
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });
}

/* ========== Fullscreen button ========== */

function setupFullscreenButton() {
  const btn = document.getElementById("fullscreen-btn");
  if (!btn) return;

  const expandSVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
  const compressSVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';

  btn.innerHTML = expandSVG;

  btn.addEventListener("click", () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => { });
    } else {
      document.exitFullscreen();
    }
  });

  document.addEventListener("fullscreenchange", () => {
    btn.innerHTML = document.fullscreenElement ? compressSVG : expandSVG;
  });
}

/* ========== Settings gear (FMTTM-style) ========== */

function setupSettingsGear() {
  const gear = document.getElementById("settingsGear");
  const menu = document.getElementById("settingsMenu");
  if (!gear || !menu) return;

  let menuOpen = false;
  let hoverTimeout = null;

  function openSettingsMenu() {
    menuOpen = true;
    menu.classList.add("show");
    gear.classList.add("menu-open");
    clearTimeout(hoverTimeout);
  }

  function closeSettingsMenu() {
    menuOpen = false;
    menu.classList.remove("show");
    gear.classList.remove("menu-open");
    clearTimeout(hoverTimeout);
  }

  function toggleSettingsMenu() {
    if (menuOpen) {
      closeSettingsMenu();
      gear.classList.remove("spin");
      gear.classList.add("spin-reverse");
      gear.addEventListener("animationend", () => gear.classList.remove("spin-reverse"), { once: true });
    } else {
      openSettingsMenu();
      gear.classList.remove("spin-reverse");
      gear.classList.add("spin");
      gear.addEventListener("animationend", () => gear.classList.remove("spin"), { once: true });
    }
  }

  gear.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleSettingsMenu();
  });

  // Hover behavior with delay
  const hoverZone = [gear, menu];
  hoverZone.forEach((el) => {
    el.addEventListener("mouseenter", () => {
      clearTimeout(hoverTimeout);
      hoverTimeout = setTimeout(openSettingsMenu, 300);
    });
    el.addEventListener("mouseleave", () => {
      clearTimeout(hoverTimeout);
      hoverTimeout = setTimeout(closeSettingsMenu, 500);
    });
  });

  // Close when clicking outside
  document.addEventListener("click", (e) => {
    if (menuOpen && !menu.contains(e.target) && e.target !== gear) {
      closeSettingsMenu();
    }
  });

  // ---- Theme buttons ----
  const themeLight = document.getElementById("themeLight");
  const themeDark = document.getElementById("themeDark");
  const themeAuto = document.getElementById("themeAuto");

  function setTheme(theme) {
    state.theme = theme;
    document.querySelectorAll(".theme-btn").forEach((b) => b.classList.remove("active"));
    if (theme === "light") {
      themeLight?.classList.add("active");
      state.lightMode = true;
      document.body.classList.add("light");
    } else if (theme === "dark") {
      themeDark?.classList.add("active");
      state.lightMode = false;
      document.body.classList.remove("light");
    } else {
      // auto
      themeAuto?.classList.add("active");
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      state.lightMode = !prefersDark;
      document.body.classList.toggle("light", state.lightMode);
    }
    try { localStorage.setItem("gc-theme", theme); } catch { }
  }

  themeLight?.addEventListener("click", () => setTheme("light"));
  themeDark?.addEventListener("click", () => setTheme("dark"));
  themeAuto?.addEventListener("click", () => setTheme("auto"));

  // Auto theme: respond to system changes
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.theme === "auto") setTheme("auto");
  });

  // ---- Background color buttons ----
  const bgColors = {
    colorDefault: null,
    colorOffwhite: "#F8F8F8",
    colorSolarised: "#FDF6E3",
    colorFT: "#FFF1E5",
  };

  function setBackgroundColor(id) {
    document.querySelectorAll(".color-btn").forEach((b) => b.classList.remove("active"));
    document.getElementById(id)?.classList.add("active");
    const col = bgColors[id];
    if (col) {
      document.body.style.setProperty("--body-bg", col);
    } else {
      document.body.style.removeProperty("--body-bg");
    }
    try { localStorage.setItem("gc-bg-color", id); } catch { }
  }

  Object.keys(bgColors).forEach((id) => {
    document.getElementById(id)?.addEventListener("click", () => setBackgroundColor(id));
  });

  // Restore from localStorage
  try {
    const savedTheme = localStorage.getItem("gc-theme");
    if (savedTheme) setTheme(savedTheme);
    else setTheme("auto");

    const savedBg = localStorage.getItem("gc-bg-color");
    if (savedBg) setBackgroundColor(savedBg);
  } catch {
    setTheme("auto");
  }
}

/* ========== Toggle bar (bottom of graph) ========== */

const toggleDefs = [
  { key: "grid", label: "Grid", colorKey: "x" },
  { key: "yaxis", label: "Y-Axis", colorKey: "y" },
  { key: "arrows", label: "Transforms", colorKey: "curve" },
  { key: "intermediates", label: "Intermediates", colorKey: "other" },
];

function buildToggleBar() {
  const bar = ui.graphTogglesEl;
  if (!bar) return;
  bar.innerHTML = "";

  toggleDefs.forEach((def) => {
    const btn = document.createElement("button");
    btn.className = "graph-toggle-btn" + (state.toggles[def.key] ? " graph-toggle-btn--on" : "");
    btn.type = "button";
    btn.dataset.toggleKey = def.key;

    // Label
    const span = document.createElement("span");
    span.textContent = def.label;
    btn.appendChild(span);

    btn.addEventListener("click", () => {
      state.toggles[def.key] = !state.toggles[def.key];
      const isOn = state.toggles[def.key];
      btn.classList.toggle("graph-toggle-btn--on", isOn);
      if (!isOn) state.toggleJustTurnedOff[def.key] = true;
    });

    // Hover: set state so draw() can add glow AND preview hidden elements
    btn.addEventListener("mouseenter", () => { state.hoveredToggle = def.key; });
    btn.addEventListener("mouseleave", () => {
      if (state.hoveredToggle === def.key) state.hoveredToggle = null;
      delete state.toggleJustTurnedOff[def.key];
    });

    bar.appendChild(btn);
  });

  // Reset button inside bar (positioned absolutely via CSS)
  if (ui.resetOverlay) {
    bar.appendChild(ui.resetOverlay);
  }
}

function windowResized() {
  resizeCanvas(window.innerWidth, window.innerHeight);
}

function isMouseOverCanvas() {
  return mouseX >= 0 && mouseX <= width && mouseY >= 0 && mouseY <= height;
}

function isOverUI() {
  const topbar = document.querySelector('.topbar');
  const toggles = ui.graphTogglesEl;
  const settingsMenu = document.getElementById('settingsMenu');
  const modeOverlay = document.getElementById('mode-toggle-overlay');
  const els = [topbar, toggles, settingsMenu, modeOverlay];
  for (const el of els) {
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (mouseX >= r.left && mouseX <= r.right && mouseY >= r.top && mouseY <= r.bottom) return true;
  }
  return false;
}

function mousePressed() {
  if (!isMouseOverCanvas() || isOverUI()) return;
  state.isPanning = true;
  state.panStartMouseX = mouseX;
  state.panStartMouseY = mouseY;
  state.panStartOriginX = view.originX;
  state.panStartOriginY = view.originY;
}

function mouseDragged() {
  if (!state.isPanning) return;
  const dx = mouseX - state.panStartMouseX;
  const dy = mouseY - state.panStartMouseY;
  view.originX = state.panStartOriginX + dx;
  view.originY = state.panStartOriginY + dy;
  state.viewDirty = true;
  if (ui.resetOverlay) ui.resetOverlay.style.display = "";
}

function mouseReleased() {
  state.isPanning = false;
}

function mouseWheel(event) {
  if (!isMouseOverCanvas() || isOverUI()) return;

  // Zoom about cursor:
  const before = screenToWorld(mouseX, mouseY);
  const zoomFactor = Math.exp(-event.delta * 0.0012);
  const nextScale = constrain(view.scale * zoomFactor, 12, 1200);

  view.scale = nextScale;
  const after = screenToWorld(mouseX, mouseY);

  // Adjust origin so the world point under the cursor stays fixed.
  view.originX += (after.x - before.x) * view.scale;
  view.originY -= (after.y - before.y) * view.scale;

  state.viewDirty = true;
  if (ui.resetOverlay) ui.resetOverlay.style.display = "";

  return false;
}

function drawKnotCircle(cx, cy, col, radius) {
  radius = radius || 3.3;
  push();
  noStroke();
  fill(red(col), green(col), blue(col), 220);
  ellipse(cx, cy, radius * 2, radius * 2);
  pop();
}

function drawArrowScreen(x1, y1, x2, y2, options = {}) {
  const col = options.col ?? color(255);
  const alpha = options.alpha ?? 220;
  const strokeWeightPx = options.strokeWeightPx ?? 2;

  push();
  stroke(red(col), green(col), blue(col), alpha);
  strokeWeight(strokeWeightPx);
  noFill();
  line(x1, y1, x2, y2);
  pop();
}

function drawCurve(yAtX, curveCol, curveWeight) {
  const col = curveCol || getPlotColor();

  stroke(col);
  strokeWeight(curveWeight || 2);
  noFill();

  const maxJumpPx = Math.max(120, height * 0.6);

  let drawing = false;
  let prevSx = 0;
  let prevSy = 0;

  // Sample at ~1 pixel per step in screen-space.
  for (let sx = 0; sx <= width; sx += 1) {
    const wx = screenToWorld(sx, 0).x;

    let wy;
    try {
      wy = yAtX(wx);
    } catch {
      wy = NaN;
    }

    if (!Number.isFinite(wy)) {
      if (drawing) endShape();
      drawing = false;
      continue;
    }

    const s = worldToScreen(wx, wy);

    if (!drawing) {
      beginShape();
      vertex(s.x, s.y);
      drawing = true;
    } else {
      const jump = dist(prevSx, prevSy, s.x, s.y);
      if (jump > maxJumpPx) {
        endShape();
        beginShape();
      }
      vertex(s.x, s.y);
    }

    prevSx = s.x;
    prevSy = s.y;
  }

  if (drawing) endShape();
}

function drawYLabelsOnCurve(yAtX) {
  if (!state.fn) return;
  const { minX, maxX } = getVisibleWorldBounds();
  const majorStep = getMajorStepWorld();

  push();
  textFont("ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace");
  textSize(11);

  for (let x = Math.floor(minX / majorStep) * majorStep; x <= maxX; x += majorStep) {
    let y;
    try { y = yAtX(x); } catch { continue; }
    if (!Number.isFinite(y)) continue;

    const s = worldToScreen(x, y);
    if (s.x < -20 || s.x > width + 20 || s.y < -20 || s.y > height + 20) continue;

    // Small horizontal tick through the curve point
    stroke(...(state.lightMode ? [30, 35, 50, 160] : [230, 240, 255, 160]));
    strokeWeight(1);
    line(s.x - 5, s.y, s.x + 5, s.y);

    // Label
    noStroke();
    fill(...(state.lightMode ? [30, 35, 50, 200] : [230, 240, 255, 200]));
    textAlign(LEFT, BOTTOM);
    text(formatNumber(y), s.x + 7, s.y - 3);
  }
  pop();
}

function drawIntermediateCurves(transformFn) {
  const steps = state.steps;
  if (steps.length < 2) return;

  for (let k = 0; k < steps.length - 1; k++) {
    // Check eye visibility: k=0 is x, k>=1 is ops[k-1]
    if (k === 0 && !state.stepEyes.x) continue;
    if (k > 0 && state.stepEyes.ops[k - 1] === false) continue;

    const step = steps[k];
    const col = getStepColor(step);
    const fadedCol = color(red(col), green(col), blue(col), 130);

    // Apply glow if hovering this step
    const stepKey = k === 0 ? "x" : String(k - 1);
    if (state.hoveredStep === stepKey) {
      drawingContext.shadowBlur = 32;
      drawingContext.shadowColor = state.lightMode
        ? "rgba(0, 80, 255, 0.75)"
        : "rgba(100, 180, 255, 0.85)";
    }

    if (transformFn) {
      drawCurve((x) => transformFn(step.fn(x), x), fadedCol, 1.5);
    } else {
      drawCurve((x) => step.fn(x), fadedCol, 1.5);
    }

    drawingContext.shadowBlur = 0;
    drawingContext.shadowColor = "transparent";
  }
}

/**
 * Draw colored knot circles at each visible grid sub-step for
 * intermediate step values. Works in Cartesian or Delta mode.
 */
function drawIntermediateDots(transformFn) {
  const steps = state.steps;
  if (steps.length < 3) return; // need at least x + 1 op + final to have intermediates

  const { minX, maxX } = getVisibleWorldBounds();
  const majorStep = getMajorStepWorld();
  const subDiv = 4;
  const subStep = majorStep / subDiv;
  const iStart = Math.floor(minX / subStep) - 1;
  const iEnd = Math.ceil(maxX / subStep) + 1;

  for (let i = iStart; i <= iEnd; i++) {
    const x = i * subStep;
    // Draw dots for intermediate steps (skip first=x, skip last=y)
    for (let k = 1; k < steps.length - 1; k++) {
      // Check eye visibility for this op
      if (state.stepEyes.ops[k - 1] === false) continue;

      let v;
      try { v = steps[k].fn(x); } catch { continue; }
      if (!Number.isFinite(v)) continue;
      const yVal = transformFn ? transformFn(v, x) : v;
      if (!Number.isFinite(yVal)) continue;
      const pt = worldToScreen(x, yVal);
      drawKnotCircle(pt.x, pt.y, getStepColor(steps[k]), 2.5);
    }
  }
}

function drawCartesianCurve() {
  if (!state.fn) return;
  if (!state.stepEyes.y) return;

  // Apply glow if hovering y step
  if (state.hoveredStep === "y") {
    drawingContext.shadowBlur = 32;
    drawingContext.shadowColor = state.lightMode
      ? "rgba(0, 80, 255, 0.75)"
      : "rgba(100, 180, 255, 0.85)";
  }
  drawCurve((x) => state.fn(x));
  drawingContext.shadowBlur = 0;
  drawingContext.shadowColor = "transparent";
}

function drawDeltaCurveAndArrows() {
  if (!state.fn) return;

  // Curve: Δ(x) = f(x) - x (respect y eye visibility)
  if (state.stepEyes.y) {
    if (state.hoveredStep === "y") {
      drawingContext.shadowBlur = 32;
      drawingContext.shadowColor = state.lightMode
        ? "rgba(0, 80, 255, 0.75)"
        : "rgba(100, 180, 255, 0.85)";
    }
    drawCurve((x) => state.fn(x) - x);
    drawingContext.shadowBlur = 0;
    drawingContext.shadowColor = "transparent";
  }

  if (!state.toggles.arrows) return;

  const { minX, maxX } = getVisibleWorldBounds();
  const majorStep = getMajorStepWorld();
  const subDiv = 4;
  const subStep = majorStep / subDiv;
  const iStart = Math.floor(minX / subStep) - 1;
  const iEnd = Math.ceil(maxX / subStep) + 1;
  const steps = state.steps;

  for (let i = iStart; i <= iEnd; i += 1) {
    const x = i * subStep;
    const centerX = worldToScreen(x, 0).x;
    const baseY = worldToScreen(x, 0).y;

    if (steps.length > 0) {
      // Knot circle on x-axis (baseline)
      drawKnotCircle(centerX, baseY, getStepColor("x"));

      // Segmented arrows: one segment per step, colored by operation type, offset horizontally
      const n = steps.length;
      let prevDelta = 0; // baseline y = x
      let prevStepDelta = null;
      for (let k = 0; k < steps.length; k++) {
        let nextDelta;
        try {
          nextDelta = steps[k].fn(x) - x;
        } catch {
          nextDelta = NaN;
        }
        if (!Number.isFinite(nextDelta)) break;
        const stepDelta = nextDelta - prevDelta;
        // Eye visibility check
        const eyeVisible = k === 0 ? state.stepEyes.x !== false : state.stepEyes.ops[k - 1] !== false;
        if (!eyeVisible) { prevDelta = nextDelta; prevStepDelta = stepDelta; continue; }
        const aWorld = worldToScreen(x, prevDelta);
        const bWorld = worldToScreen(x, nextDelta);
        let offset = 0;
        if (prevStepDelta !== null && prevStepDelta * stepDelta < 0) {
          offset = stepDelta > 0 ? -5 : 5;
        }
        const ax = centerX + offset;
        const bx = centerX + offset;
        const col = getStepColor(steps[k]);
        drawArrowScreen(ax, aWorld.y, bx, bWorld.y, { col, alpha: 210, strokeWeightPx: 2 });

        // Knot circle on delta curve colored by step type
        const dotCol = (k === steps.length - 1) ? getStepColor("y") : getStepColor(steps[k]);
        drawKnotCircle(centerX, bWorld.y, dotCol);

        prevDelta = nextDelta;
        prevStepDelta = stepDelta;
      }
    } else {
      let delta;
      try {
        delta = state.fn(x) - x;
      } catch {
        delta = NaN;
      }
      if (!Number.isFinite(delta)) continue;
      const a = worldToScreen(x, 0);
      const b = worldToScreen(x, delta);
      const col = getDeltaArrowColor(delta);
      drawArrowScreen(a.x, a.y, b.x, b.y, { col, alpha: 210, strokeWeightPx: 2 });
    }
  }
}

function drawNumberLinesAndArrows() {
  const showTicks = state.toggles.grid;
  const { minX, maxX } = getVisibleWorldBounds();
  const majorStep = getMajorStepWorld();
  const steps = state.steps;
  const maxGap = 100;
  const yBottom = worldToScreen(0, 0).y;

  // Determine the effective operation steps (skip leading "x" identity step)
  let opSteps = steps;
  if (opSteps.length > 0 && opSteps[0].type === "x") {
    opSteps = opSteps.slice(1);
  }
  const opNumLines = opSteps.length > 0 ? opSteps.length + 1 : 2;
  const gapPx = Math.min(maxGap, Math.max(40, (height - 100) / Math.max(1, opNumLines - 1)));
  const yLines = [];
  for (let j = 0; j < opNumLines; j++) yLines.push(yBottom - j * gapPx);

  // Determine color for each number line
  function getLineColor(j) {
    if (j === 0) return getStepColor("x"); // first = x axis (blue)
    if (j === opNumLines - 1) return getStepColor("y"); // last = y axis (green)
    // intermediate: colored by the preceding operation arrow
    if (opSteps.length > 0 && j - 1 < opSteps.length) return getStepColor(opSteps[j - 1]);
    return state.lightMode ? color(30, 35, 50, 170) : color(255, 255, 255, 170);
  }

  // Draw horizontal lines colored by role
  strokeWeight(2);
  for (let j = 0; j < opNumLines; j++) {
    const lc = getLineColor(j);
    stroke(red(lc), green(lc), blue(lc), 200);
    line(0, yLines[j], width, yLines[j]);
  }

  if (showTicks) {
    const tickColor = state.lightMode ? color(30, 35, 50, 120) : color(255, 255, 255, 120);
    stroke(tickColor);
    strokeWeight(1);

    for (let x = Math.floor(minX / majorStep) * majorStep; x <= maxX; x += majorStep) {
      const sx = worldToScreen(x, 0).x;
      if (sx < -60 || sx > width + 60) continue;
      for (let j = 0; j < opNumLines; j++) {
        line(sx, yLines[j] - 5, sx, yLines[j] + 5);
      }
    }
  }

  if (state.fn && state.toggles.arrows) {
    const subDiv = 4;
    const subStep = majorStep / subDiv;
    const iStart = Math.floor(minX / subStep) - 1;
    const iEnd = Math.ceil(maxX / subStep) + 1;

    if (opSteps.length > 0) {
      // One line per effective step; arrows between lines colored by step type
      for (let i = iStart; i <= iEnd; i += 1) {
        const x = i * subStep;
        const values = [x];
        for (let k = 0; k < opSteps.length; k++) {
          let v;
          try {
            v = opSteps[k].fn(x);
          } catch {
            v = NaN;
          }
          if (!Number.isFinite(v)) break;
          values.push(v);
        }
        for (let j = 0; j < values.length - 1; j++) {
          // Eye visibility check
          if (state.stepEyes.ops[j] === false) continue;
          const s1 = worldToScreen(values[j], 0);
          const s2 = worldToScreen(values[j + 1], 0);
          const col = getStepColor(opSteps[j]);
          drawArrowScreen(s1.x, yLines[j], s2.x, yLines[j + 1], {
            col,
            alpha: 220,
            strokeWeightPx: 2,
          });
          drawKnotCircle(s1.x, yLines[j], getLineColor(j));
          drawKnotCircle(s2.x, yLines[j + 1], getLineColor(j + 1));
        }
      }
    } else {
      const yTop = yLines[1];
      for (let i = iStart; i <= iEnd; i += 1) {
        const x = i * subStep;
        let fx;
        try {
          fx = state.fn(x);
        } catch {
          fx = NaN;
        }
        if (!Number.isFinite(fx)) continue;
        const x1 = worldToScreen(x, 0).x;
        const x2 = worldToScreen(fx, 0).x;
        const col = getDeltaArrowColor(fx - x);
        drawArrowScreen(x1, yBottom, x2, yTop, { col, alpha: 220, strokeWeightPx: 2 });
      }
    }
  }

  // Draw tick labels last so they appear in front of circles
  if (showTicks) {
    textFont("ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace");
    textSize(12);
    noStroke();
    fill(...(state.lightMode ? [30, 35, 50, 190] : [230, 240, 255, 190]));

    for (let x = Math.floor(minX / majorStep) * majorStep; x <= maxX; x += majorStep) {
      const sx = worldToScreen(x, 0).x;
      if (sx < -60 || sx > width + 60) continue;
      for (let j = 0; j < opNumLines; j++) {
        text(formatNumber(x), sx + 4, yLines[j] + (j === 0 ? 10 : -12));
      }
    }
  }
}

function drawCartesianTransformArrows() {
  if (!state.fn) return;
  const { minX, maxX } = getVisibleWorldBounds();
  const majorStep = getMajorStepWorld();
  const subDiv = 4;
  const subStep = majorStep / subDiv;
  const iStart = Math.floor(minX / subStep) - 1;
  const iEnd = Math.ceil(maxX / subStep) + 1;
  const steps = state.steps;

  for (let i = iStart; i <= iEnd; i += 1) {
    const x = i * subStep;
    const centerX = worldToScreen(x, 0).x;

    if (steps.length > 0) {
      const values = [x];
      for (let k = 0; k < steps.length; k++) {
        let v;
        try {
          v = steps[k].fn(x);
        } catch {
          v = NaN;
        }
        if (!Number.isFinite(v)) break;
        values.push(v);
      }
      if (values.length < 2) continue;

      let prevStepDelta = null;
      for (let j = 0; j < values.length - 1; j++) {
        const fromVal = values[j];
        const toVal = values[j + 1];
        const stepDelta = toVal - fromVal;
        // Eye visibility check
        const eyeVisible = j === 0 || state.stepEyes.ops[j - 1] !== false;
        if (!eyeVisible) { prevStepDelta = stepDelta; continue; }
        const a = worldToScreen(x, fromVal);
        const b = worldToScreen(x, toVal);
        let offset = 0;
        if (prevStepDelta !== null && prevStepDelta * stepDelta < 0) {
          offset = stepDelta > 0 ? -5 : 5;
        }
        const col = getStepColor(steps[j]);
        drawArrowScreen(centerX + offset, a.y, centerX + offset, b.y, {
          col,
          alpha: 220,
          strokeWeightPx: 2,
        });
        prevStepDelta = stepDelta;
      }

      // Knot circles: baseline, intermediates, final
      for (let j = 0; j < values.length; j++) {
        // Eye visibility check for knots
        if (j === 0 && !state.stepEyes.x) continue;
        if (j === values.length - 1 && !state.stepEyes.y) continue;
        if (j > 0 && j < values.length - 1 && state.stepEyes.ops[j - 1] === false) continue;
        const pt = worldToScreen(x, values[j]);
        if (j === 0) drawKnotCircle(pt.x, pt.y, getStepColor("x"));
        else if (j === values.length - 1) drawKnotCircle(pt.x, pt.y, getStepColor("y"));
        else drawKnotCircle(pt.x, pt.y, getStepColor(steps[j - 1]));
      }
    } else {
      let fx;
      try {
        fx = state.fn(x);
      } catch {
        fx = NaN;
      }
      if (!Number.isFinite(fx)) continue;
      const a = worldToScreen(x, x);
      const b = worldToScreen(x, fx);
      const col = getStepColor("misc");
      drawArrowScreen(a.x, a.y, b.x, b.y, { col, alpha: 200, strokeWeightPx: 2 });
      drawKnotCircle(a.x, a.y, getStepColor("x"));
      drawKnotCircle(b.x, b.y, getStepColor("y"));
    }
  }
}

function draw() {
  background(state.lightMode ? 245 : 10, state.lightMode ? 246 : 14, state.lightMode ? 250 : 28);

  const hov = state.hoveredToggle;

  // Helper: enable glow if the given toggle key matches the hovered toggle
  function glowOn(key) {
    if (hov === key) {
      drawingContext.shadowBlur = 32;
      drawingContext.shadowColor = state.lightMode
        ? "rgba(0, 80, 255, 0.75)"
        : "rgba(100, 180, 255, 0.85)";
    }
  }
  function glowOff() {
    drawingContext.shadowBlur = 0;
    drawingContext.shadowColor = "transparent";
  }

  // Determine effective visibility: ON if toggle is on, OR hovering an OFF toggle (preview)
  // But only preview if the toggle was already OFF (not just turned off by clicking)
  function shouldPreview(key) {
    return hov === key && !state.toggles[key] && !state.toggleJustTurnedOff[key];
  }
  const showGrid = state.toggles.grid || shouldPreview("grid");
  const showYAxis = state.toggles.yaxis || shouldPreview("yaxis");
  const showArrows = state.toggles.arrows || shouldPreview("arrows");
  const showIntermediates = state.toggles.intermediates || shouldPreview("intermediates");

  // Temporarily override toggles so all drawing functions respect hover previews
  const savedToggles = { ...state.toggles };
  state.toggles.grid = showGrid;
  state.toggles.yaxis = showYAxis;
  state.toggles.arrows = showArrows;
  state.toggles.intermediates = showIntermediates;

  if (state.mode === "numberLines") {
    drawNumberLinesAndArrows();
  } else {
    // Grid lines glow on grid hover; axes drawn separately (y-axis has own glow)
    if (showGrid) {
      glowOn("grid");
      drawGridLines();
      glowOff();
    }
    drawAxesAndLabels(getMajorStepWorld());

    if (state.mode === "delta") {
      glowOn("intermediates");
      if (showIntermediates) {
        drawIntermediateCurves((val, x) => val - x);
        drawIntermediateDots((val, x) => val - x);
      }
      glowOff();

      glowOn("arrows");
      drawDeltaCurveAndArrows();
      glowOff();

      glowOn("yaxis");
      if (!showYAxis) drawYLabelsOnCurve((x) => state.fn(x) - x);
      glowOff();
    } else {
      glowOn("intermediates");
      if (showIntermediates) {
        drawIntermediateCurves();
        drawIntermediateDots();
      }
      glowOff();

      drawCartesianCurve();

      glowOn("arrows");
      if (state.mode === "cartesian" && showArrows) {
        drawCartesianTransformArrows();
      }
      glowOff();

      glowOn("yaxis");
      if (!showYAxis) drawYLabelsOnCurve((x) => state.fn(x));
      glowOff();
    }
  }

  // Restore original toggles
  state.toggles = savedToggles;

  // ---- HUD overlay (HTML element) ----
  if (ui.hudEl) {
    const tl = screenToWorld(0, 0);
    const br = screenToWorld(width, height);
    const minX = formatNumber(Math.min(tl.x, br.x));
    const maxX = formatNumber(Math.max(tl.x, br.x));
    const minY = formatNumber(Math.min(tl.y, br.y));
    const maxY = formatNumber(Math.max(tl.y, br.y));

    let coordLine = state.mode === "numberLines"
      ? `x: [${minX}, ${maxX}] · ${formatNumber(view.scale)} px/u`
      : `x: [${minX}, ${maxX}] · y: [${minY}, ${maxY}] · ${formatNumber(view.scale)} px/u`;

    const statusHtml = state.statusText
      ? `<div class="hud-line${state.statusKind === 'error' ? ' hud-line--error' : ''}">${state.statusText}</div>`
      : "";
    ui.hudEl.innerHTML = statusHtml + `<div class="hud-line hud-line--coords">${coordLine}</div>`;
  }
}

