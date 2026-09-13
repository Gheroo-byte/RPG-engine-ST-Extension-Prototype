/**
 * RPG Engine - Narrator AI Tools (pure, host-independent)
 * ========================================================
 * The narrator-facing tool layer. Like ai-core.js, this module has ZERO
 * dependency on SillyTavern, the DOM, or any specific world. It provides the
 * tools a narrator model may call, and DOES NOT perform network I/O or mutate
 * RPG state beyond a dice roll.
 *
 * AUTHORITY BOUNDARY
 * ------------------
 * There is exactly ONE authoritative dice implementation: `DiceRoller` in
 * engine-core.js. The `roll_dice` tool here is a THIN ADAPTER that:
 *   1. validates the requested dice expression (untrusted narrator input),
 *   2. calls the existing DiceRoller,
 *   3. returns a structured, authoritative result.
 *
 * Randomness is never generated here — only inside DiceRoller.
 *
 * TOOL SHAPE
 * ----------
 * A tool is `{ name, description, parameters, execute }`:
 *   - name / description / parameters are the model-facing declaration.
 *   - execute(arguments) performs the actual work and returns a structured result.
 */

import { DiceRoller, EngineError } from './engine-core.js';
import { resolveCheck } from './check.js';

/**
 * Dispatch a narrator tool call by name, returning the tool's structured result.
 * This is the single pure entry point the ST glue (ai-store.js) uses to run a
 * tool the narrator requested. It deliberately knows nothing about ST.
 *
 * @param {string} name      Tool name (e.g. "roll_dice", "roll_check").
 * @param {object} args      Tool arguments.
 * @param {DiceRoller} [rolling] Injectable roller for tests.
 * @returns {object} The tool's structured result (throws EngineError on unknown tool / bad args).
 */
export function dispatchToolCall(name, args, roller) {
  const tool = NARRATOR_TOOLS[name];
  if (!tool) throw new EngineError(`Unknown narrator tool "${name}".`);
  return tool.execute(args, roller);
}

// =============================================================================
// LIMITS (conservative, explicit)
// =============================================================================

/** Maximum number of dice a single call may request. */
const MAX_DICE_COUNT = 100;

/** Maximum number of sides a single die may have. */
const MAX_DIE_SIDES = 100000;

// =============================================================================
// EXPRESSION VALIDATION + PARSING
// =============================================================================

/**
 * Parses a dice expression of the v1-supported form `XdY`, `XdY+Z`, `XdY-Z`.
 * Returns `{ count, sides, modifier }` or throws EngineError. No eval/Function;
 * a single anchored regex + integer validation is the only parsing performed.
 *
 * @param {string} expression
 * @returns {{ count: number, sides: number, modifier: number }}
 */
function parseDiceExpression(expression) {
  if (typeof expression !== 'string') {
    throw new EngineError('Dice expression must be a string.');
  }

  const trimmed = expression.trim();
  if (trimmed === '') {
    throw new EngineError('Dice expression is empty.');
  }

  // Anchored: exactly `<count>d<sides>` optionally followed by a single
  // signed integer modifier. No dice pools, no nesting, no operators.
  const match = trimmed.match(/^(\d+)d(\d+)([+-]\d+)?$/i);
  if (!match) {
    throw new EngineError(
      `Malformed dice expression "${trimmed}". Expected "XdY", "XdY+Z", or "XdY-Z" (e.g. 2d20+5).`,
    );
  }

  const count = parseInt(match[1], 10);
  const sides = parseInt(match[2], 10);
  const modifier = match[3] ? parseInt(match[3], 10) : 0;

  // Guard leading-zero / integer overflow edge cases implicitly covered by the
  // regex, but validate ranges explicitly here.
  if (count < 1 || count > MAX_DICE_COUNT) {
    throw new EngineError(`Dice count must be between 1 and ${MAX_DICE_COUNT}; got ${count}.`);
  }
  if (sides < 1 || sides > MAX_DIE_SIDES) {
    throw new EngineError(`Die sides must be between 1 and ${MAX_DIE_SIDES}; got ${sides}.`);
  }

  return { count, sides, modifier };
}

// =============================================================================
// roll_dice TOOL
// =============================================================================

/**
 * Execute a dice roll for the narrator. Validates input, rolls via the single
 * authoritative DiceRoller, and returns a structured result.
 *
 * @param {object} args      Tool arguments: { expression: string }
 * @param {DiceRoller} [rollFn] Injectable roller for testing; defaults to a fresh DiceRoller.
 * @returns {{ expression: string, rolls: number[], modifier: number, total: number }}
 */
function executeRollDice(args, roller) {
  const expression = (args && typeof args === 'object' ? args.expression : undefined);
  const parsed = parseDiceExpression(expression);

  const diceRoller = roller ?? new DiceRoller();
  const { rolls, total: diceTotal } = diceRoller.roll(parsed.count, parsed.sides);

  return {
    expression: (typeof expression === 'string' ? expression : '').trim(),
    rolls,
    modifier: parsed.modifier,
    total: diceTotal + parsed.modifier,
  };
}

/**
 * The narrator-facing `roll_dice` tool declaration. This is the single source
 * of truth for what the model sees (name/description/parameters) and how it is
 * executed.
 */
export const roll_dice = Object.freeze({
  name: 'roll_dice',
  description:
    'Roll standard tabletop dice and return the authoritative result. ' +
    'Call this BEFORE narrating or describing the roll\'s outcome; do not write ' +
    'any narrative, HUD, scene text, dialogue, or the roll\'s result until the tool returns. ' +
    'Treat the returned roll as authoritative — do not invent, estimate, or replace the returned result. ' +
    'Accepts "XdY", "XdY+Z", or "XdY-Z" (e.g. 1d20, 2d20, 3d8, 2d20+5, 1d20-2).',
  parameters: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      expression: Object.freeze({
        type: 'string',
        description: 'Dice expression in XdY, XdY+Z, or XdY-Z form.',
      }),
    }),
    required: Object.freeze(['expression']),
  }),
  execute: executeRollDice,
});

/**
 * Execute a ruleset-aware check via the generic resolver. The narrator supplies
 * formulas/alternatives and the ACTIVE ruleset's `check` profile (if any)
 * determines band/partial/natural/tier/damage semantics. `ruleset` may be a
 * ruleset object (from rulesets.js) carrying `.check`; if omitted, the generic
 * binary binary pass/fail path is used.
 *
 * @param {object} args       { ruleset?, actorFormula, targetFormula|dc,
 *                              actorStats?, targetStats?, actorAlternative?,
 *                              targetAlternative?, actorTier?, targetTier?,
 *                              difficulty? }
 */
function executeRollCheck(args, roller) {
  const safe = args && typeof args === 'object' ? args : {};

  if (typeof safe.actorFormula !== 'string' || safe.actorFormula.trim() === '') {
    throw new EngineError('roll_check requires a non-empty "actorFormula".');
  }

  const ruleset = safe.ruleset ?? null;

  const actor = {
    formula: safe.actorFormula,
    stats: safe.actorStats ?? {},
    tier: safe.actorTier,
  };
  if (safe.actorAlternative) actor.selected = safe.actorAlternative;

  let target;
  if (typeof safe.targetFormula === 'string' && safe.targetFormula.trim() !== '') {
    target = { formula: safe.targetFormula, stats: safe.targetStats ?? {}, tier: safe.targetTier };
    if (safe.targetAlternative) target.selected = safe.targetAlternative;
  } else if (typeof safe.dc === 'number') {
    target = { dc: safe.dc };
  } else {
    throw new EngineError('roll_check requires either "targetFormula" or "dc".');
  }

  return resolveCheck({
    ruleset,
    actor,
    target,
    difficulty: { difficulty: safe.difficulty ?? 0 },
    diceRoller: roller,
  });
}

/**
 * The narrator-facing `roll_check` tool. Ruleset-aware check/opposed resolution.
 */
export const roll_check = Object.freeze({
  name: 'roll_check',
  description:
    'Resolve a ruleset-aware check or opposed check with authoritative dice and rules. ' +
    'When a mechanical check governed by the active ruleset is needed, call this BEFORE ' +
    'writing any narrative, HUD, scene description, dialogue, or mechanical outcome. ' +
    'Do not narrate the result before the tool returns, and do not manually invent, estimate, ' +
    'or calculate the final mechanical result when this tool can resolve it. ' +
    'Treat the returned result as authoritative. After the tool returns, write the normal ' +
    'final response once. ' +
    'Accepts an actor formula, an opposed target formula or a fixed DC, optional ' +
    'alternative-stat selections, tiers, and difficulty. The active ruleset determines ' +
    'pass/partial/fail, natural-roll, tier-gap, and damage rules.',
  parameters: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      rulesetId: Object.freeze({ type: 'string', description: 'Ruleset id (optional; defaults to no profile / generic binary).' }),
      actorFormula: Object.freeze({ type: 'string', description: 'Actor roll formula, e.g. "d60 + STR + 0.5*INT + Mod".' }),
      targetFormula: Object.freeze({ type: 'string', description: 'Opposed target formula, e.g. "d80 + CON/STR + Mod".' }),
      dc: Object.freeze({ type: 'number', description: 'Static difficulty (alternative to targetFormula).' }),
      actorStats: Object.freeze({ type: 'object', description: 'Actor stat values (resolved via ruleset).' }),
      targetStats: Object.freeze({ type: 'object', description: 'Target stat values.' }),
      actorAlternative: Object.freeze({ type: 'string', description: 'Explicit alternative stat choice for actor formula (e.g. "STR").' }),
      targetAlternative: Object.freeze({ type: 'string', description: 'Explicit alternative stat choice for target formula (e.g. "STR").' }),
      actorTier: Object.freeze({ type: 'number', description: 'Actor tier (for tier-gap rules).' }),
      targetTier: Object.freeze({ type: 'number', description: 'Target tier (for tier-gap rules).' }),
      difficulty: Object.freeze({ type: 'number', description: 'Difficulty multiplier used by taken-damage formulas.' }),
    }),
    required: Object.freeze(['actorFormula']),
  }),
  execute: executeRollCheck,
});

/** Registry of all narrator-facing tools, keyed by tool name. */
export const NARRATOR_TOOLS = Object.freeze({
  roll_dice: roll_dice,
  roll_check: roll_check,
});

/** Look up a tool by name (case-sensitive), or null. */
export function getTool(name) {
  return NARRATOR_TOOLS[name] ?? null;
}

/**
 * Re-export the limit constants so tests/hosts can introspect them without
 * hard-coding magic numbers.
 */
export { MAX_DICE_COUNT, MAX_DIE_SIDES, parseDiceExpression };