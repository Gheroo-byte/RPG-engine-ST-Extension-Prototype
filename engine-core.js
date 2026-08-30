/**
 * RPG Engine Core
 * ================
 * World-agnostic deterministic mechanics engine.
 *
 * This module has ZERO dependency on SillyTavern, a live model, or any
 * particular world's stat names. It is pure JS and can be tested entirely
 * in isolation (see test-engine.js). Per the design doc, world-specific
 * stat names (Strength/Agility/... vs STR/DEX/CON/...) are never hardcoded
 * anywhere in here - they are just keys in a `stats` object supplied at
 * call time.
 *
 * What this file DOES provide:
 *   - DiceRoller: configurable dice (d4..d100, custom sides), real RNG
 *   - Formula tokenizer/parser/evaluator: "2d6 + Strength", "d60 + INT + 0.5*BLS"
 *   - OpposedCheck / StaticCheck: the two first-class rule types
 *   - Manual overrides: force a roll or a result, clearly flagged as such
 *   - Breakdown generation: every roll returns a human-readable component
 *     breakdown (Roll: 41, Strength: +32, Agility x0.5: +18, Total: 91),
 *     matching the RESULT block format from the design doc.
 *
 * What this file explicitly does NOT do (later chunks, per dev order):
 *   - No UI
 *   - No persistence/save-load
 *   - No SillyTavern integration (manifest.json, index.js entry, getContext())
 *   - No narrator/AI communication
 *   - No natural-language lore parsing
 *
 * ---------------------------------------------------------------------------
 * FORMULA GRAMMAR
 * ---------------------------------------------------------------------------
 * A formula is a string like:
 *   "2d6 + Strength"
 *   "d60 + INT + 0.5*BLS"
 *   "Strength + 0.5 Agility + d60"          (implicit multiplication: "0.5 Agility")
 *   "(Strength + Agility) / 2 + d20"
 *   "STR - 5"
 *
 * Grammar (recursive descent):
 *   expression := term (('+' | '-') term)*
 *   term       := factor (('*' | '/') factor)*
 *   factor     := NUMBER | DICE | STAT | '(' expression ')' | ('-') factor
 *   DICE       := [N]'d'M   e.g. d60, 2d6, 1d20
 *   STAT       := identifier matched case-insensitively against the stats
 *                 object supplied at evaluation time
 *   Implicit multiplication is supported between a NUMBER and a following
 *   STAT or DICE or '(' with no operator between them (e.g. "0.5 Agility",
 *   "2(Strength+1)"), since the design doc's own examples use this form.
 * ---------------------------------------------------------------------------
 */

// =============================================================================
// SECTION 1: DICE
// =============================================================================

/**
 * Rolls a single die with `sides` faces. Uses a real uniform RNG.
 * Exposed separately from DiceRoller so it's trivially mockable in tests.
 */
function rollDie(sides) {
  if (!Number.isInteger(sides) || sides < 1) {
    throw new EngineError(`Invalid die size: d${sides}. Must be a positive integer.`);
  }
  return Math.floor(Math.random() * sides) + 1;
}

class DiceRoller {
  /**
   * @param {object} [config] - optional custom dice registry, e.g. { d60: 60 }
   *   Standard dice (d4,d6,d8,d10,d12,d20,d100) are always available;
   *   this lets a world register additional/custom ones (d60 for Astralis).
   */
  constructor(config = {}) {
    this.customDice = { ...config };
  }

  registerDie(name, sides) {
    if (!/^d\d+$/i.test(name)) {
      throw new EngineError(`Custom die name must look like "d60", got "${name}"`);
    }
    this.customDice[name.toLowerCase()] = sides;
  }

  /** Roll `count` dice of `sides` faces, return { rolls: [..], total } */
  roll(count, sides) {
    const rolls = [];
    for (let i = 0; i < count; i++) rolls.push(rollDie(sides));
    return { rolls, total: rolls.reduce((a, b) => a + b, 0) };
  }
}

// =============================================================================
// SECTION 2: ERRORS
// =============================================================================

class EngineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EngineError';
  }
}

// =============================================================================
// SECTION 3: TOKENIZER
// =============================================================================

const TOKEN_TYPES = {
  NUMBER: 'NUMBER',
  DICE: 'DICE',
  IDENT: 'IDENT',
  PLUS: 'PLUS',
  MINUS: 'MINUS',
  STAR: 'STAR',
  SLASH: 'SLASH',
  LPAREN: 'LPAREN',
  RPAREN: 'RPAREN',
  EOF: 'EOF',
};

function tokenize(formula) {
  const tokens = [];
  let i = 0;
  const s = formula.trim();

  while (i < s.length) {
    const c = s[i];

    if (/\s/.test(c)) { i++; continue; }

    if (c === '+') { tokens.push({ type: TOKEN_TYPES.PLUS }); i++; continue; }
    if (c === '-') { tokens.push({ type: TOKEN_TYPES.MINUS }); i++; continue; }
    if (c === '*') { tokens.push({ type: TOKEN_TYPES.STAR }); i++; continue; }
    if (c === '/') { tokens.push({ type: TOKEN_TYPES.SLASH }); i++; continue; }
    if (c === '(') { tokens.push({ type: TOKEN_TYPES.LPAREN }); i++; continue; }
    if (c === ')') { tokens.push({ type: TOKEN_TYPES.RPAREN }); i++; continue; }

    // Dice notation: optional digits, 'd' or 'D', digits. e.g. d60, 2d6
    const diceMatch = s.slice(i).match(/^(\d*)[dD](\d+)/);
    if (diceMatch) {
      const count = diceMatch[1] ? parseInt(diceMatch[1], 10) : 1;
      const sides = parseInt(diceMatch[2], 10);
      tokens.push({ type: TOKEN_TYPES.DICE, count, sides, raw: diceMatch[0] });
      i += diceMatch[0].length;
      continue;
    }

    // Number (integer or decimal)
    const numMatch = s.slice(i).match(/^\d+(\.\d+)?/);
    if (numMatch) {
      tokens.push({ type: TOKEN_TYPES.NUMBER, value: parseFloat(numMatch[0]) });
      i += numMatch[0].length;
      continue;
    }

    // Identifier (stat name): letters, digits, underscore, not starting with digit
    const identMatch = s.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (identMatch) {
      tokens.push({ type: TOKEN_TYPES.IDENT, name: identMatch[0] });
      i += identMatch[0].length;
      continue;
    }

    throw new EngineError(`Unexpected character "${c}" in formula: "${formula}"`);
  }

  tokens.push({ type: TOKEN_TYPES.EOF });
  return tokens;
}

// =============================================================================
// SECTION 4: PARSER (recursive descent -> AST)
// =============================================================================
// AST node shapes:
//   { kind: 'num', value }
//   { kind: 'dice', count, sides, raw }
//   { kind: 'stat', name }
//   { kind: 'neg', node }
//   { kind: 'bin', op: '+'|'-'|'*'|'/', left, right }

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() { return this.tokens[this.pos]; }
  next() { return this.tokens[this.pos++]; }

  expect(type) {
    const t = this.next();
    if (t.type !== type) {
      throw new EngineError(`Expected ${type} but got ${t.type} at position ${this.pos - 1}`);
    }
    return t;
  }

  parse() {
    const node = this.parseExpression();
    this.expect(TOKEN_TYPES.EOF);
    return node;
  }

  parseExpression() {
    let node = this.parseTerm();
    while (this.peek().type === TOKEN_TYPES.PLUS || this.peek().type === TOKEN_TYPES.MINUS) {
      const op = this.next().type === TOKEN_TYPES.PLUS ? '+' : '-';
      const right = this.parseTerm();
      node = { kind: 'bin', op, left: node, right };
    }
    return node;
  }

  parseTerm() {
    let node = this.parseImplicitMul();
    while (this.peek().type === TOKEN_TYPES.STAR || this.peek().type === TOKEN_TYPES.SLASH) {
      const op = this.next().type === TOKEN_TYPES.STAR ? '*' : '/';
      const right = this.parseImplicitMul();
      node = { kind: 'bin', op, left: node, right };
    }
    return node;
  }

  /**
   * Handles implicit multiplication: "0.5 Agility", "2(Strength+1)", "0.5d60".
   * A factor immediately followed by another factor (no explicit * or /)
   * is treated as multiplication - matches the design doc's own examples
   * like "0.5 Agility".
   */
  parseImplicitMul() {
    let node = this.parseFactor();
    while (this.startsFactor(this.peek())) {
      const right = this.parseFactor();
      node = { kind: 'bin', op: '*', left: node, right };
    }
    return node;
  }

  startsFactor(token) {
    return (
      token.type === TOKEN_TYPES.NUMBER ||
      token.type === TOKEN_TYPES.DICE ||
      token.type === TOKEN_TYPES.IDENT ||
      token.type === TOKEN_TYPES.LPAREN
    );
  }

  parseFactor() {
    const t = this.peek();

    if (t.type === TOKEN_TYPES.MINUS) {
      this.next();
      return { kind: 'neg', node: this.parseFactor() };
    }
    if (t.type === TOKEN_TYPES.NUMBER) {
      this.next();
      return { kind: 'num', value: t.value };
    }
    if (t.type === TOKEN_TYPES.DICE) {
      this.next();
      return { kind: 'dice', count: t.count, sides: t.sides, raw: t.raw };
    }
    if (t.type === TOKEN_TYPES.IDENT) {
      this.next();
      return { kind: 'stat', name: t.name };
    }
    if (t.type === TOKEN_TYPES.LPAREN) {
      this.next();
      const node = this.parseExpression();
      this.expect(TOKEN_TYPES.RPAREN);
      return node;
    }

    throw new EngineError(`Unexpected token ${t.type} while parsing formula`);
  }
}

function parseFormula(formula) {
  return new Parser(tokenize(formula)).parse();
}

// =============================================================================
// SECTION 5: EVALUATOR
// =============================================================================
// Evaluates an AST against a `stats` object and a DiceRoller, producing both
// the final numeric value AND a human-readable breakdown array, e.g.:
//   [ { label: 'd60', value: 41 }, { label: 'Strength', value: 32 },
//     { label: '0.5 x Agility', value: 18 } ]
// This directly supports the RESULT-block formatting from the design doc.

function evaluateNode(node, stats, diceRoller, breakdown) {
  switch (node.kind) {
    case 'num':
      return node.value;

    case 'stat': {
      const key = Object.keys(stats).find(
        (k) => k.toLowerCase() === node.name.toLowerCase()
      );
      if (key === undefined) {
        throw new EngineError(`Unknown stat "${node.name}" - not present in supplied stats object`);
      }
      const value = stats[key];
      breakdown.push({ label: key, value });
      return value;
    }

    case 'dice': {
      const { rolls, total } = diceRoller.roll(node.count, node.sides);
      breakdown.push({
        label: node.raw,
        value: total,
        rolls: rolls.length > 1 ? rolls : undefined,
      });
      return total;
    }

    case 'neg': {
      const v = evaluateNode(node.node, stats, diceRoller, breakdown);
      return -v;
    }

    case 'bin': {
      // For multiplication specifically, we want a combined breakdown entry
      // like "0.5 x Agility: 18" rather than two separate lines, when one
      // side is a plain number (matches design-doc RESULT formatting).
      if (node.op === '*' && (node.left.kind === 'num' || node.right.kind === 'num')) {
        const numNode = node.left.kind === 'num' ? node.left : node.right;
        const otherNode = node.left.kind === 'num' ? node.right : node.left;
        const subBreakdown = [];
        const otherValue = evaluateNode(otherNode, stats, diceRoller, subBreakdown);
        const result = numNode.value * otherValue;
        const otherLabel = subBreakdown.length ? subBreakdown[0].label : describeNode(otherNode);
        breakdown.push({ label: `${numNode.value} x ${otherLabel}`, value: result });
        return result;
      }

      const left = evaluateNode(node.left, stats, diceRoller, breakdown);
      const right = evaluateNode(node.right, stats, diceRoller, breakdown);
      switch (node.op) {
        case '+': return left + right;
        case '-': return left - right;
        case '*': return left * right;
        case '/':
          if (right === 0) throw new EngineError('Division by zero in formula');
          return left / right;
        default:
          throw new EngineError(`Unknown operator "${node.op}"`);
      }
    }

    default:
      throw new EngineError(`Unknown AST node kind "${node.kind}"`);
  }
}

function describeNode(node) {
  if (node.kind === 'stat') return node.name;
  if (node.kind === 'dice') return node.raw;
  if (node.kind === 'num') return String(node.value);
  return '(...)';
}

/**
 * Evaluates a formula string against a stats object.
 * @param {string} formula - e.g. "d60 + INT + 0.5*BLS"
 * @param {object} stats - e.g. { INT: 34, BLS: 30 }
 * @param {DiceRoller} diceRoller
 * @returns {{ total: number, breakdown: Array<{label:string, value:number}> }}
 */
function evaluateFormula(formula, stats, diceRoller) {
  const ast = parseFormula(formula);
  const breakdown = [];
  const total = evaluateNode(ast, stats, diceRoller, breakdown);
  return { total: roundClean(total), breakdown };
}

/** Avoid floating point ugliness (0.1+0.2 etc) while preserving real decimals. */
function roundClean(n) {
  return Math.round(n * 1000) / 1000;
}

// =============================================================================
// SECTION 6: MANUAL OVERRIDES
// =============================================================================
// Per the design doc: overrides must be CLEARLY DISTINGUISHED from organic
// rolls, never silently presented as a normal roll. Every override carries
// a `manualOverride: true` flag and a `reason` in its result object.

class ManualOverride {
  /** Force a specific numeric total, bypassing formula evaluation entirely. */
  static forceTotal(value, reason = 'Manual override') {
    return {
      total: value,
      breakdown: [{ label: 'MANUAL OVERRIDE', value, reason }],
      manualOverride: true,
      reason,
    };
  }

  /** Force a pass/fail outcome without a numeric roll at all (FORCE_RESULT). */
  static forceOutcome(outcome, reason = 'Narrative override') {
    if (outcome !== 'SUCCESS' && outcome !== 'FAILURE') {
      throw new EngineError('forceOutcome requires outcome to be "SUCCESS" or "FAILURE"');
    }
    return {
      outcome,
      breakdown: [{ label: 'FORCED RESULT', value: outcome, reason }],
      manualOverride: true,
      forcedOutcome: true,
      reason,
    };
  }
}

// =============================================================================
// SECTION 7: RULE TYPES - StaticCheck and OpposedCheck
// =============================================================================
// These are the two first-class check types from the design doc.
// Both return a consistent result shape so downstream code (UI, narrator
// communication) doesn't need to special-case which type was used:
//
// {
//   type: 'static' | 'opposed',
//   actorTotal, actorBreakdown,
//   targetTotal, targetBreakdown,   (opposed only; static uses `dc` instead)
//   dc,                             (static only)
//   outcome: 'SUCCESS' | 'FAILURE',
//   margin: number                  (actorTotal - target, signed)
// }

/**
 * Static check: actor's formula result vs a fixed difficulty class.
 * e.g. "2d6 + Strength" vs DC 15
 */
function staticCheck({ formula, stats, dc, diceRoller, override = null }) {
  if (override) {
    return { type: 'static', dc, ...override, outcome: override.outcome ?? override.forcedOutcome ? override.outcome : (override.total >= dc ? 'SUCCESS' : 'FAILURE') };
  }
  const { total, breakdown } = evaluateFormula(formula, stats, diceRoller);
  const outcome = total >= dc ? 'SUCCESS' : 'FAILURE';
  return {
    type: 'static',
    actorTotal: total,
    actorBreakdown: breakdown,
    dc,
    outcome,
    margin: roundClean(total - dc),
  };
}

/**
 * Opposed check: actor's formula result vs target's formula result.
 * e.g. Talia's "Strength + 0.5*Agility + d60" vs Player's defense formula.
 */
function opposedCheck({ actorFormula, actorStats, targetFormula, targetStats, diceRoller, override = null }) {
  if (override) {
    return { type: 'opposed', ...override };
  }
  const actor = evaluateFormula(actorFormula, actorStats, diceRoller);
  const target = evaluateFormula(targetFormula, targetStats, diceRoller);
  const outcome = actor.total >= target.total ? 'SUCCESS' : 'FAILURE';
  return {
    type: 'opposed',
    actorTotal: actor.total,
    actorBreakdown: actor.breakdown,
    targetTotal: target.total,
    targetBreakdown: target.breakdown,
    outcome,
    margin: roundClean(actor.total - target.total),
  };
}

// =============================================================================
// SECTION 8: RESULT FORMATTING (matches design-doc RESULT block style)
// =============================================================================

/**
 * Formats an engine result into the plain-text RESULT block style from the
 * design doc, e.g.:
 *   RESULT
 *   Action: Pounce
 *   Roll: d60 -> 41
 *   Strength: +32
 *   Agility x0.5: +18
 *   Total: 91
 *   Result: SUCCESS
 */
function formatResult(result, actionName = null) {
  const lines = ['RESULT'];
  if (actionName) lines.push(`Action: ${actionName}`);

  if (result.manualOverride) {
    lines.push(`[MANUAL OVERRIDE - ${result.reason}]`);
    if (result.forcedOutcome) {
      lines.push(`Result: ${result.outcome} (forced, no roll performed)`);
      return lines.join('\n');
    }
    lines.push(`Total: ${result.total} (forced value)`);
    return lines.join('\n');
  }

  const breakdown = result.actorBreakdown || result.breakdown || [];
  for (const entry of breakdown) {
    const sign = typeof entry.value === 'number' && entry.value >= 0 ? '+' : '';
    lines.push(`${entry.label}: ${sign}${entry.value}`);
  }
  lines.push(`Total: ${result.actorTotal ?? result.total}`);

  if (result.type === 'static') {
    lines.push(`DC: ${result.dc}`);
  } else if (result.type === 'opposed') {
    lines.push(`Target Total: ${result.targetTotal}`);
    for (const entry of result.targetBreakdown || []) {
      const sign = typeof entry.value === 'number' && entry.value >= 0 ? '+' : '';
      lines.push(`  Target ${entry.label}: ${sign}${entry.value}`);
    }
  }

  lines.push(`Result: ${result.outcome}`);
  return lines.join('\n');
}

// =============================================================================
// EXPORTS
// =============================================================================

export {
  EngineError,
  DiceRoller,
  rollDie,
  tokenize,
  parseFormula,
  evaluateFormula,
  ManualOverride,
  staticCheck,
  opposedCheck,
  formatResult,
};
