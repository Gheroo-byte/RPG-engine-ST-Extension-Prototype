/**
 * RPG Engine - Check/Combat Resolver (pure, host-independent)
 * ============================================================
 * The generic, ruleset-aware check/opposed-check resolver. Like engine-core.js
 * and stats.js, this module has ZERO dependency on SillyTavern, the DOM, or any
 * specific world. It depends only on engine-core.js (dice + formula) and is
 * driven entirely by the *active ruleset's* check profile.
 *
 * THE CONTRACT
 * ------------
 * This module provides the CAPABILITY to resolve stat-composed checks, opposed
 * checks, pass/partial/fail bands, tier-gap modifiers, natural-roll behavior,
 * and damage — but NONE of those mechanics are universal. A ruleset opts into
 * them by declaring a `check` profile. A ruleset with no `check` profile gets
 * the most generic binary pass/fail resolution and inherits nothing else.
 *
 * Shattered Dominion's d60/d80/tier/damage rules live in rulesets.js as DATA,
 * never as engine behavior here. D&D does not inherit them.
 *
 * ALTERNATIVE STATS (`CON/STR`)
 * -----------------------------
 * A formula may contain a `/`-joined alternative group such as `CON/STR` in the
 * TARGET slot. This is normalized BEFORE evaluation into an explicit choice:
 * the group is split into `[CON, STR]`, a single stat is selected (explicitly
 * supplied by the caller, else the first alternative), and that stat name is
 * substituted into the formula. The result always reports both `alternatives`
 * and `selected` so nothing is silently optimized. `/` remains division inside
 * the generic formula language — alternative-stat syntax is ONLY recognized
 * here at the check normalization boundary, never inside engine-core.
 *
 * AUTHORITY BOUNDARY
 * ------------------
 * Dice randomness comes ONLY from `DiceRoller` (engine-core.js). This module
 * never generates randomness and never mutates character state.
 */

import { evaluateFormula, DiceRoller, EngineError } from './engine-core.js';

// =============================================================================
// ALTERNATIVE-STAT NORMALIZATION
// =============================================================================

/**
 * Detect `/`-joined alternative stat groups in a formula and split them into
 * their component names. Only a contiguous run of bare identifiers joined by
 * `/` (with optional whitespace) is treated as an alternative group; any `/`
 * that participates in an arithmetic expression (numbers, parentheses,
 * coefficients) is left alone as division.
 *
 * @param {string} formula
 * @returns {string[]} Array of alternative groups (each string like "CON/STR"),
 *                     or empty when none are present.
 */
function findAlternativeGroups(formula) {
  const groups = [];
  // Match identifier runs joined by '/': "CON/STR", "CON / STR", "DEX / AGI".
  const re = /[A-Za-z_][A-Za-z0-9_]*\s*(\/\s*[A-Za-z_][A-Za-z0-9_]*)+/g;
  let m;
  while ((m = re.exec(formula)) !== null) {
    groups.push(m[0]);
  }
  return groups;
}

/**
 * Normalize a formula that may contain `/`-joined alternative stat groups into
 * `{ formula, alternative }`.
 *
 * `alternative` is `null` when no `/`-group is present; otherwise it is
 * `{ alternatives: string[], selected?: string }` where `alternatives` is the
 * list of component stat names (e.g. ['CON','STR']) and `selected`, if
 * provided, names which alternative the caller chose.
 *
 * Returns the formula with each group replaced by the selected stat name.
 *
 * The choice is REQUIRED and explicit: if an alternative group is present but no
 * `selected` name is supplied (or the supplied name is not one of the
 * alternatives), this throws EngineError. Nothing is silently auto-selected —
 * neither the first nor the highest stat.
 */
export function normalizeAlternativeStats(formula, { selected } = {}) {
  if (typeof formula !== 'string') {
    throw new EngineError('Formula must be a string.');
  }
  const groups = findAlternativeGroups(formula);
  if (groups.length === 0) return { formula, alternative: null };

  let normalized = formula;
  let alternative = null;
  for (const group of groups) {
    const alternatives = group.split('/').map((s) => s.trim());

    let chosen = null;
    if (typeof selected === 'string' && selected.trim() !== '') {
      chosen = alternatives.find((a) => a.toLowerCase() === selected.trim().toLowerCase()) ?? null;
    }
    if (chosen === null) {
      throw new EngineError(
        `Alternative stat group "${group}" requires an explicit selection (one of: ${alternatives.join(', ')}).`,
      );
    }

    // Replace only this exact group occurrence.
    normalized = normalized.replace(group, chosen);

    // One alternative group per slot is documented; record the first (and
    // primary) one for the caller. Additional groups remain normalized too.
    if (alternative === null) {
      alternative = { alternatives, selected: chosen };
    }
  }
  return { formula: normalized, alternative };
}

// =============================================================================
// RESOLVER
// =============================================================================

/**
 * Resolve a ruleset-aware check.
 *
 * @param {object} params
 * @param {object} params.ruleset       The active ruleset (carries an optional `.check` profile).
 * @param {object} params.actor         { formula, stats, alternatives?, tier? }
 * @param {object} params.target        { formula, stats, alternatives?, tier? } (opposed) or
 *                                       { dc } (static).
 * @param {object} [params.difficulty]  Context passed to damage formulas (e.g. { difficulty: 2 }).
 * @param {DiceRoller} [params.diceRoller]
 * @returns {object} Structured result (see below).
 */
export function resolveCheck(params) {
  const { ruleset, actor, target, difficulty = {}, diceRoller } = params;

  if (!actor || typeof actor !== 'object') throw new EngineError('resolveCheck requires an actor.');
  if (!target || typeof target !== 'object') throw new EngineError('resolveCheck requires a target or dc.');

  const roller = diceRoller ?? new DiceRoller();
  const profile = ruleset?.check ?? null;

  // ── Normalize alternative stats on both formulas ──────────────────────────
  const actorNorm = normalizeAlternativeStats(actor.formula, actor);
  const isOpposed = typeof target.formula === 'string';
  const targetNorm = isOpposed ? normalizeAlternativeStats(target.formula, target) : null;

  // ── Resolve actor ─────────────────────────────────────────────────────────
  const actorEval = evaluateFormula(actorNorm.formula, actor.stats ?? {}, roller);

  // ── Resolve target (opposed) or fixed DC (static) ─────────────────────────
  let targetTotal;
  let targetBreakdown = [];
  let targetRawRolls = [];
  let dc = null;
  if (isOpposed) {
    const tgt = evaluateFormula(targetNorm.formula, target.stats ?? {}, roller);
    targetTotal = tgt.total;
    targetBreakdown = tgt.breakdown;
    targetRawRolls = extractDieRolls(tgt.breakdown);
  } else {
    dc = target.dc;
    targetTotal = dc;
  }

  // ── Tier-gap modifier (profile-driven) ────────────────────────────────────
  let tierGapModifier = 0;
  let tierGapApplied = null;
  if (profile?.tierGap && typeof actor.tier === 'number' && typeof target.tier === 'number') {
    const perTier = profile.tierGap.perTier ?? 0;
    // "+5 per tier BELOW target, -5 per tier ABOVE target":
    // actor below target => (target.tier - actor.tier) > 0 => positive bonus.
    tierGapModifier = (target.tier - actor.tier) * perTier;
    tierGapApplied = { perTier, delta: target.tier - actor.tier, modifier: tierGapModifier };
  }

  const actorTotal = actorEval.total + tierGapModifier;

  // ── Outcome classification ─────────────────────────────────────────────────
  const outcome = classifyOutcome(profile, actorTotal, targetTotal);

  // ── Natural-roll behavior (profile-driven) ────────────────────────────────
  const actorRawRolls = extractDieRolls(actorEval.breakdown);
  const natural = applyNaturalRules(profile, actorRawRolls, actorEval, actorTotal, targetTotal);

  // ── Damage (profile-driven) ───────────────────────────────────────────────
  const damage = computeDamage(profile, {
    actorTotal,
    targetTotal,
    outcome: natural.outcome ?? outcome.outcome,
    margin: natural.margin ?? outcome.margin,
    difficulty: difficulty.difficulty ?? 0,
  }, roller);

  return {
    type: isOpposed ? 'opposed' : 'static',
    ruleset: ruleset?.id ?? null,
    outcome: natural.outcome ?? outcome.outcome,
    actorTotal: roundInt(actorTotal),
    actorBreakdown: actorEval.breakdown,
    actorRolls: actorRawRolls,
    targetTotal: isOpposed ? roundInt(targetTotal) : undefined,
    targetBreakdown: isOpposed ? targetBreakdown : undefined,
    targetRolls: isOpposed ? targetRawRolls : undefined,
    dc: isOpposed ? undefined : dc,
    margin: natural.margin ?? outcome.margin,
    tierGap: tierGapApplied,
    alternative: {
      actor: actorNorm.alternative,
      target: isOpposed ? targetNorm.alternative : null,
    },
    natural: natural.detail ?? null,
    damage: damage ?? null,
  };
}

// =============================================================================
// OUTCOME CLASSIFICATION
// =============================================================================

/**
 * Classify actor total vs target total into outcome bands. The bands are
 * profile-driven; a ruleset with no `check.bands` uses the generic binary
 * pass/fail (>= target → SUCCESS, else FAILURE).
 */
function classifyOutcome(profile, actorTotal, targetTotal) {
  const margin = roundClean(actorTotal - targetTotal);
  const bands = profile?.bands ?? null;

  if (bands && typeof bands.partialWithin === 'number') {
    // Three-band: pass / partial / fail.
    if (margin >= 0) return { outcome: 'PASS', margin };
    if (margin >= -bands.partialWithin) return { outcome: 'PARTIAL', margin };
    return { outcome: 'FAIL', margin };
  }

  // Generic binary.
  return { outcome: actorTotal >= targetTotal ? 'SUCCESS' : 'FAILURE', margin };
}

// =============================================================================
// NATURAL-ROLL RULES
// =============================================================================

/**
 * Extract individual die results from an evaluateFormula breakdown.
 * Multi-die entries carry a `rolls` array; single-die entries (label "d60")
 * carry only their scalar `value` (the lone roll). Both are surfaced so
 * natural-roll rules can inspect a natural 1/60 on a single die.
 */
function extractDieRolls(breakdown) {
  const rolls = [];
  for (const entry of breakdown ?? []) {
    if (Array.isArray(entry.rolls)) {
      rolls.push(...entry.rolls);
    } else if (entry && typeof entry.label === 'string' && /^[0-9]*[dD][0-9]+$/.test(entry.label.trim()) && typeof entry.value === 'number') {
      // A single die (e.g. "d60") is reported as a bare value, not a rolls array.
      rolls.push(entry.value);
    }
  }
  return rolls;
}

/**
 * Apply natural-roll rules from a profile. Returns `{ outcome?, margin?,
 * detail? }`; when no profile natural rules exist, returns `{}` so the base
 * classification stands.
 */
function applyNaturalRules(profile, rolls, actorEval, actorTotal, targetTotal) {
  const natural = profile?.natural ?? null;
  if (!natural) return {};
  if (rolls.length === 0) return {};

  // A natural roll is the single die result for the relevant die (e.g. d60).
  // We look for a roll equal to the crit/fumble face.
  const critFace = natural.critFace;
  const fumbleFace = natural.fumbleFace;

  if (typeof critFace === 'number' && rolls.some((r) => r === critFace)) {
    return {
      outcome: natural.critOutcome ?? 'PASS',
      margin: roundClean(actorTotal - targetTotal),
      detail: { kind: 'natural', face: critFace, guaranteed: true },
    };
  }
  if (typeof fumbleFace === 'number' && rolls.some((r) => r === fumbleFace)) {
    return {
      outcome: natural.fumbleOutcome ?? 'FAIL',
      margin: roundClean(actorTotal - targetTotal),
      detail: { kind: 'fumble', face: fumbleFace, critical: true },
    };
  }
  return {};
}

// =============================================================================
// DAMAGE
// =============================================================================

/**
 * Compute damage from a profile's damage formulas. Both formulas are evaluated
 * via the same safe `evaluateFormula` path against a context map exposing the
 * resolved totals/margin/difficulty as stat-like names.
 */
function computeDamage(profile, ctx, roller) {
  const dmg = profile?.damage ?? null;
  if (!dmg) return null;

  const stats = {
    Roll: ctx.actorTotal,
    Target: ctx.targetTotal,
    Margin: ctx.margin,
    Difficulty: ctx.difficulty,
  };

  const result = {};

  if (typeof dmg.dealt === 'string') {
    result.dealt = roundToNearest(evaluateFormula(dmg.dealt, stats, roller).total);
  }
  if (typeof dmg.taken === 'string') {
    result.taken = roundToNearest(evaluateFormula(dmg.taken, stats, roller).total);
  }
  return result;
}

// =============================================================================
// ROUNDING HELPERS
// =============================================================================

/** Round to nearest whole number, .5 rounds UP (matches SD HP/CHI rule). */
function roundToNearest(n) {
  if (!Number.isFinite(n)) return n;
  return Math.round(n); // Math.round rounds .5 UP (toward +infinity).
}

function roundInt(n) {
  return Number.isInteger(n) ? n : Math.round(n);
}

function roundClean(n) {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 1000) / 1000;
}