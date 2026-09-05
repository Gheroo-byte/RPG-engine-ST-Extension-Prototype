/**
 * RPG Engine - Statistics Layer (pure, host-independent)
 * =======================================================
 * The modular statistics foundation. This module has ZERO dependency on
 * SillyTavern, the DOM, or any specific world's stat names. It depends only on
 * engine-core.js for formula evaluation.
 *
 * CONCEPTS
 * --------
 * A "ruleset" is pure configuration/data:
 *   {
 *     base: { StatName: { min?, max?, cap?, potential? } },  // primary stats
 *     derived: { ValueName: { formula } }                    // derived stats
 *   }
 *
 * A "character" is runtime state carrying concrete values keyed off a ruleset:
 *   {
 *     base: { StatName: { value } },       // base/core values
 *     modifiers: [ { stat, amount, until? } ],
 *   }
 *
 * Definitions and values are strictly separated: a ruleset says what stats
 * exist and how they are shaped; a character says what the values are.
 *
 * API
 * ---
 *   validateRuleset(ruleset)
 *   createStat(ruleset, name, def?)
 *   getBaseStatNames(ruleset)
 *   getStatCap(ruleset, statName)
 *   createCharacter(ruleset, baseValues?)
 *   getStat(character, name)
 *   setStat(character, name, value)
 *   modifyStat(character, name, amount)
 *   addModifier(character, mod)
 *   getAppliedModifiers(character, name, now?)
 *   getEffectiveStats(character, ruleset, now?)
 *   serializeCharacter(character) / deserializeCharacter(json)
 */

import { evaluateFormula, EngineError } from './engine-core.js';

// =============================================================================
// ERRORS
// =============================================================================

/** Errors thrown by the statistics layer. */
export class StatsError extends Error {
  constructor(message, { stat, details } = {}) {
    super(message);
    this.name = 'StatsError';
    if (stat) this.stat = stat;
    if (details) this.details = details;
  }
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Coerce a stored stat definition to its numeric value. Accepts both the
 *  legacy bare-number form and the structured { value } form for tolerance. */
function statValue(def) {
  if (typeof def === 'number') return def;
  if (isPlainObject(def) && typeof def.value === 'number') return def.value;
  return null;
}

/** Normalize a base stat value into a structured { value } object. */
function normalizeBaseEntry(def, statName) {
  const value = statValue(def);
  if (value === null) {
    throw new StatsError(`Stat "${statName}" has no numeric value.`, { stat: statName });
  }
  return { value };
}

// =============================================================================
// VALIDATION
// =============================================================================

/**
 * Validate a ruleset object. Throws StatsError with a useful message on the
 * first problem found. Checks that base/derived are objects, stat names are
 * non-empty strings, and each derived stat has a string formula.
 */
export function validateRuleset(ruleset) {
  if (!isPlainObject(ruleset)) {
    throw new StatsError('Ruleset must be an object.');
  }
  if (!isPlainObject(ruleset.base)) {
    throw new StatsError('Ruleset is missing a "base" stats object.');
  }
  for (const [name, def] of Object.entries(ruleset.base)) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new StatsError('Stat names must be non-empty strings.', { details: name });
    }
    if (def !== undefined && !isPlainObject(def)) {
      throw new StatsError(`Base stat "${name}" definition must be an object.`, { stat: name });
    }
  }
  if (ruleset.derived !== undefined && !isPlainObject(ruleset.derived)) {
    throw new StatsError('Ruleset "derived" must be an object.');
  }
  for (const [name, def] of Object.entries(ruleset.derived ?? {})) {
    if (typeof def?.formula !== 'string') {
      throw new StatsError(`Derived stat "${name}" must have a string "formula".`, { stat: name });
    }
  }
  return true;
}

/**
 * Extract the names of every stat referenced by a formula, matching the
 * identifier rules of engine-core's tokenizer (letters, then letters/digits).
 *
 * Dice notation is excluded: any token matching `[n]dN` (e.g. `d6`, `d20`,
 * `d60`, `2d6`, `4d8`) is a die roll, not a stat reference, and must never be
 * reported as a dependency.
 */
export function extractStatReferences(formula) {
  if (typeof formula !== 'string') return new Set();
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  const found = new Set();
  let m;
  while ((m = re.exec(formula)) !== null) {
    const token = m[0];
    // Skip die-roll tokens: optional leading count digits then 'd' + sides.
    if (/^\d*d\d+$/i.test(token)) continue;
    found.add(token);
  }
  return found;
}

/**
 * Topologically sort the derived stats so their dependencies resolve in any
 * declaration order. Returns an ordered array of derived stat names.
 * Throws StatsError on a missing dependency or a dependency cycle.
 */
export function orderDerivedStats(ruleset) {
  const derived = ruleset?.derived ?? {};
  const names = Object.keys(derived);
  // Available identifiers: base stat names + derived stat names.
  const baseNames = new Set(Object.keys(ruleset?.base ?? {}));
  const allNames = new Set([...baseNames, ...names]);

  const deps = new Map(); // name -> Set of referenced derived names (not base)
  for (const name of names) {
    const refs = extractStatReferences(derived[name].formula);
    const dep = new Set();
    for (const ref of refs) {
      if (ref === name) continue;
      if (!allNames.has(ref)) {
        throw new StatsError(
          `Derived stat "${name}" references unknown stat "${ref}".`,
          { stat: name, details: { ref } },
        );
      }
      if (names.includes(ref)) {
        dep.add(ref);
      }
    }
    deps.set(name, dep);
  }

  // Kahn's algorithm (deterministic, insertion order) with cycle detection.
  const sorted = [];
  const inDegree = new Map();
  for (const name of names) inDegree.set(name, 0);
  for (const [name, dep] of deps) {
    for (const d of dep) inDegree.set(d, inDegree.get(d) + 1);
  }

  const queue = [...names].filter((n) => inDegree.get(n) === 0);
  while (queue.length > 0) {
    const name = queue.shift();
    sorted.push(name);
    for (const [other, dep] of deps) {
      if (dep.has(name)) {
        inDegree.set(other, inDegree.get(other) - 1);
        if (inDegree.get(other) === 0) queue.push(other);
      }
    }
  }

  if (sorted.length !== names.length) {
    const cyclic = names.filter((n) => !sorted.includes(n));
    throw new StatsError(
      `Circular dependency detected among derived stats: ${cyclic.join(', ')}.`,
      { details: { cyclic } },
    );
  }

  return sorted;
}

// =============================================================================
// RULESET STAT CONFIGURATION
// =============================================================================

/** Get the base stat names declared by a ruleset, in declaration order. */
export function getBaseStatNames(ruleset) {
  return Object.keys(ruleset?.base ?? {});
}

/** Look up the cap definition for a stat within its ruleset (may be null). */
export function getStatCap(ruleset, statName) {
  return ruleset?.base?.[statName]?.cap ?? null;
}

/** Register (or replace) a base stat definition on a ruleset. */
export function createStat(ruleset, name, def = {}) {
  validateRuleset(ruleset);
  if (typeof name !== 'string' || name.trim() === '') {
    throw new StatsError('Stat name must be a non-empty string.');
  }
  if (!isPlainObject(def)) {
    throw new StatsError(`Definition for "${name}" must be an object.`, { stat: name });
  }
  ruleset.base[name] = def;
  return ruleset;
}

// =============================================================================
// CHARACTER STATE
// =============================================================================

/**
 * Create a character with base values initialized from a ruleset. `baseValues`
 * is an optional map of stat name -> number (or { value }) overrides; stats
 * not provided default to 0. Missing stats are ignored (not created).
 */
export function createCharacter(ruleset, baseValues = {}) {
  validateRuleset(ruleset);
  const base = {};
  for (const name of Object.keys(ruleset.base)) {
    const supplied = baseValues[name];
    const value = statValue(supplied) ?? 0;
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new StatsError(`Initial value for "${name}" must be a number.`, { stat: name });
    }
    base[name] = { value };
  }
  return { base, modifiers: [] };
}

function ensureBase(character, name) {
  if (!character || !isPlainObject(character.base)) {
    throw new StatsError('Character must have a "base" stats object.');
  }
  if (!Object.hasOwn(character.base, name)) {
    throw new StatsError(`Stat "${name}" does not exist on this character.`, { stat: name });
  }
}

/** Get a character's base stat value. */
export function getStat(character, name) {
  ensureBase(character, name);
  const value = statValue(character.base[name]);
  if (value === null) {
    throw new StatsError(`Stat "${name}" has no numeric value.`, { stat: name });
  }
  return value;
}

function validateNumeric(value, statName) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new StatsError(`Value for "${statName}" must be a finite number.`, { stat: statName });
  }
  return value;
}

/** Set a character's base stat value (validating it is numeric). */
export function setStat(character, name, value) {
  ensureBase(character, name);
  validateNumeric(value, name);
  character.base[name] = { value };
  return value;
}

/** Add `amount` to a character's base stat value. */
export function modifyStat(character, name, amount) {
  ensureBase(character, name);
  validateNumeric(amount, name);
  const current = getStat(character, name);
  return setStat(character, name, current + amount);
}

// =============================================================================
// MODIFIERS
// =============================================================================

/**
 * Add a modifier to a character. A modifier is:
 *   { stat: string, amount: number, until?: timestamp, permanent?: bool }
 * Temporary modifiers expire when `now > until` (if `until` is set); permanent
 * modifiers never expire. `amount` is additive.
 */
export function addModifier(character, mod) {
  if (!character) throw new StatsError('Character is required for addModifier.');
  if (!isPlainObject(mod)) throw new StatsError('Modifier must be an object.');
  if (typeof mod.stat !== 'string' || mod.stat === '') {
    throw new StatsError('Modifier must target a stat name.');
  }
  if (typeof mod.amount !== 'number' || Number.isNaN(mod.amount)) {
    throw new StatsError('Modifier amount must be a finite number.', { stat: mod.stat });
  }
  const entry = { stat: mod.stat, amount: mod.amount };
  if (mod.until !== undefined) {
    if (typeof mod.until !== 'number' || Number.isNaN(mod.until)) {
      throw new StatsError('Modifier "until" must be a numeric timestamp.', { stat: mod.stat });
    }
    entry.until = mod.until;
  }
  if (mod.permanent) entry.permanent = true;
  if (!Array.isArray(character.modifiers)) character.modifiers = [];
  character.modifiers.push(entry);
  return entry;
}

/** Return the active modifiers for a stat at time `now` (defaults to Date.now).
 *  Permanent modifiers always apply; temporary ones apply only if not expired. */
export function getAppliedModifiers(character, name, now = Date.now()) {
  const all = character?.modifiers ?? [];
  return all.filter((m) => {
    if (m.stat !== name) return false;
    if (m.permanent) return true;
    if (m.until === undefined) return true;
    return m.until >= now;
  });
}

// =============================================================================
// EFFECTIVE + DERIVED STATS
// =============================================================================

/**
 * Compute a character's effective stats under a ruleset:
 *   - base values with active additive modifiers applied,
 *   - then all derived stats resolved in dependency order via the formula
 *     evaluator (derived can reference base stats and other derived stats).
 * Returns a flat { statName: number } map.
 *
 * @param {object} character Character runtime state.
 * @param {object} ruleset  Ruleset configuration.
 * @param {number} [now]    Timestamp for evaluating temporary modifiers.
 */
export function getEffectiveStats(character, ruleset, now = Date.now()) {
  validateRuleset(ruleset);

  const effective = {};
  for (const name of Object.keys(ruleset.base)) {
    let value = character?.base ? statValue(character.base[name]) : null;
    if (value === null) value = 0;
    for (const m of getAppliedModifiers(character, name, now)) {
      value += m.amount;
    }
    effective[name] = value;
  }

  const ordered = orderDerivedStats(ruleset);
  for (const name of ordered) {
    const { formula } = ruleset.derived[name];
    try {
      const { total } = evaluateFormula(formula, effective);
      effective[name] = total;
    } catch (err) {
      throw new StatsError(
        `Failed to evaluate derived stat "${name}" (${formula}): ${err?.message ?? err}`,
        { stat: name, details: { formula, cause: err } },
      );
    }
  }

  return effective;
}

// =============================================================================
// VALIDATION (ranges / caps)
// =============================================================================

/**
 * Validate a character's base values against a ruleset's configured ranges
 * (min/max) and caps. Returns an array of violation objects
 *   { stat, value, min?, max?, message } (empty if fully valid).
 * This reports rather than mutates, so caps can be surfaced without silently
 * rejecting state.
 */
export function validateCharacterStats(character, ruleset) {
  validateRuleset(ruleset);
  const violations = [];
  for (const [name, def] of Object.entries(ruleset.base)) {
    const value = character?.base ? statValue(character.base[name]) : null;
    if (value === null) continue;
    const min = def?.min;
    const max = def?.max;
    if (typeof min === 'number' && value < min) {
      violations.push({ stat: name, value, min, message: `Stat "${name}" ${value} is below minimum ${min}.` });
    }
    if (typeof max === 'number' && value > max) {
      violations.push({ stat: name, value, max, message: `Stat "${name}" ${value} exceeds maximum ${max}.` });
    }
    const cap = def?.cap;
    if (cap !== undefined && typeof cap === 'number' && value > cap) {
      violations.push({ stat: name, value, cap, message: `Stat "${name}" ${value} exceeds cap ${cap}.` });
    }
  }
  return violations;
}

// =============================================================================
// SERIALIZATION
// =============================================================================

/**
 * Serialize a ruleset/character state to a JSON-safe object. This snapshots the
 * current values; a character whose base entries are structured { value } is
 * already JSON-safe, but this normalizes any legacy bare-number form.
 */
export function serializeCharacter(character) {
  const base = {};
  for (const [name, def] of Object.entries(character?.base ?? {})) {
    base[name] = { value: statValue(def) ?? 0 };
  }
  return {
    base,
    modifiers: (character?.modifiers ?? []).map((m) => ({ ...m })),
  };
}

/** Deserialize a serialized character back into runtime shape. */
export function deserializeCharacter(json) {
  if (!isPlainObject(json)) {
    throw new StatsError('Serialized character must be an object.');
  }
  if (!isPlainObject(json.base)) {
    throw new StatsError('Serialized character is missing a "base" object.');
  }
  const base = {};
  for (const [name, def] of Object.entries(json.base)) {
    base[name] = { value: statValue(def) ?? 0 };
  }
  return {
    base,
    modifiers: (Array.isArray(json.modifiers) ? json.modifiers : []).map((m) => ({ ...m })),
  };
}