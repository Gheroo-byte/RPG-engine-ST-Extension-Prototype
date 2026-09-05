/**
 * RPG Engine - AI Service Core (pure, host-independent)
 * ======================================================
 * The AI Service foundation. Like stats.js, this module has ZERO dependency on
 * SillyTavern, the DOM, or any specific world/lore. It defines the *models*
 * (slot shape, permission levels, action vocabulary, proposal validation) but
 * performs NO network I/O and NO state mutation.
 *
 * AUTHORITY BOUNDARY (enforced by design, not convention)
 * ------------------------------------------------------
 * This module is a *proposal generator*, never an *authority*:
 *   - It knows how to DESCRIBE an AI slot and its permission level.
 *   - It knows how to PARSE and VALIDATE structured action proposals.
 *   - It has NO write path to RPG state. It cannot call setStat/modifyStat or
 *     otherwise mutate characters/rulesets — those functions belong to
 *     engine-core.js and stats.js, which this module neither imports nor
 *     re-exports.
 *
 * The RPG engine (engine-core.js + stats.js) remains authoritative for
 * mechanical state, calculations, validation, dice, stat changes, and outcomes.
 * The only bridge between an AI proposal and engine execution is the ST-glue
 * layer (index.js / ai-store.js), which MUST validate every proposal against
 * the real engine before executing anything.
 *
 * CONCEPTS
 * --------
 * A "slot" is a serializable AI service configuration:
 *   {
 *     id: string,
 *     label: string,
 *     purpose: string,            // free-form role/purpose, NOT a fixed enum
 *     enabled: bool,
 *     permission: 'read-only' | 'suggest' | 'exec-gated',
 *     connection: { source, ... }, // host-owned connection spec (see ai-store.js)
 *   }
 *
 * Slot count is NOT hardcoded here. A default UI may seed 7 slots, but the
 * engine treats slots as an arbitrary array and never references a number.
 *
 * Permission levels (conceptual policy; enforcement lives in ST glue):
 *   - 'read-only' : may inspect state and produce text; no proposals, no mutation.
 *   - 'suggest'   : may propose engine actions; never executes them.
 *   - 'exec-gated': may propose actions that are executed only after explicit
 *                   confirmation/validation by the engine (future slice).
 *
 * API
 * ---
 *   PERMISSION_LEVELS
 *   ACTION_VERBS
 *   validateSlot(slot)
 *   parseProposals(rawText, slot)
 *   validateProposal(proposal, slot)
 */

// =============================================================================
// PERMISSION LEVELS
// =============================================================================

/** Recognized permission levels. Enforcement is host-side; this is the model. */
export const PERMISSION_LEVELS = Object.freeze({
  READ_ONLY: 'read-only',
  SUGGEST: 'suggest',
  EXEC_GATED: 'exec-gated',
});

const VALID_PERMISSIONS = new Set(Object.values(PERMISSION_LEVELS));

// =============================================================================
// ACTION VOCABULARY
// =============================================================================

/**
 * The closed set of structured engine-action verbs the AI may eventually
 * propose. This is a *model* of the vocabulary, not the engine functions
 * themselves (those live in engine-core.js / stats.js).
 *
 * In the first vertical slice (read-only only), NO mutating verb is reachable:
 * read-only slots short-circuit parseProposals and return no actions. The
 * mutating verbs below are declared but intentionally inert until execution
 * support lands in a later slice.
 */
export const ACTION_VERBS = Object.freeze({
  // Informational (non-mutating) — allowed in proposals only as descriptions.
  DESCRIBE_STATE: 'describe_state',
  EXPLAIN_RULE: 'explain_rule',
  SUGGEST_OUTCOME: 'suggest_outcome',
  // Mutating (proposal-only; never executed by this module).
  SET_STAT: 'set_stat',
  MODIFY_STAT: 'modify_stat',
  ADD_MODIFIER: 'add_modifier',
  ROLL_CHECK: 'roll_check',
  RESOLVE_OUTCOME: 'resolve_outcome',
});

/** Verbs that, if ever executed, would change mechanical state. */
const MUTATING_VERBS = new Set([
  ACTION_VERBS.SET_STAT,
  ACTION_VERBS.MODIFY_STAT,
  ACTION_VERBS.ADD_MODIFIER,
  ACTION_VERBS.ROLL_CHECK,
  ACTION_VERBS.RESOLVE_OUTCOME,
]);

// =============================================================================
// VALIDATION (slot shape)
// =============================================================================

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validate an AI slot object. Throws Error with a useful message on the first
 * problem. Returns true when valid.
 *
 * Note: `connection` is intentionally NOT deeply validated here — it is a
 * host-owned object (SilentTavern connection profile id, preset, etc.) that the
 * ST-glue layer owns and understands. The pure layer only requires that slots
 * carry a `connection` object (or omit it entirely).
 */
export function validateSlot(slot) {
  if (!isPlainObject(slot)) {
    throw new Error('AI slot must be an object.');
  }
  if (typeof slot.id !== 'string' || slot.id.trim() === '') {
    throw new Error('AI slot must have a non-empty string "id".');
  }
  if (typeof slot.label !== 'string' || slot.label.trim() === '') {
    throw new Error(`AI slot "${slot.id}" must have a non-empty string "label".`);
  }
  if (slot.purpose !== undefined && typeof slot.purpose !== 'string') {
    throw new Error(`AI slot "${slot.id}" "purpose" must be a string.`);
  }
  if (slot.enabled !== undefined && typeof slot.enabled !== 'boolean') {
    throw new Error(`AI slot "${slot.id}" "enabled" must be a boolean.`);
  }
  if (slot.permission !== undefined && !VALID_PERMISSIONS.has(slot.permission)) {
    throw new Error(
      `AI slot "${slot.id}" has unknown permission "${slot.permission}". ` +
      `Expected one of: ${[...VALID_PERMISSIONS].join(', ')}.`,
    );
  }
  if (slot.connection !== undefined && !isPlainObject(slot.connection)) {
    throw new Error(`AI slot "${slot.id}" "connection" must be an object.`);
  }
  return true;
}

// =============================================================================
// PROPOSAL PARSING
// =============================================================================

/**
 * Parse a raw AI text response into structured engine-action proposals.
 *
 * In the first vertical slice this ALWAYS returns an empty array:
 *   - read-only slots never produce proposals (enforced by the short-circuit),
 *   - the parser itself does not yet extract JSON action blocks.
 *
 * The function signature is stable so later slices can implement real
 * extraction without changing callers. The invariant is explicit: nothing this
 * function returns is authoritative, and nothing is ever executed by this
 * module.
 *
 * @param {string} rawText The raw AI response text.
 * @param {object} slot    The AI slot configuration.
 * @returns {object[]} Array of proposal objects (always [] in this slice).
 */
export function parseProposals(rawText, slot) {
  // Read-only slots cannot propose actions of any kind.
  if (!slot || slot.permission === PERMISSION_LEVELS.READ_ONLY) return [];

  // Structured extraction is a later slice. Until then, no proposals are
  // produced by any permission level.
  void rawText;
  return [];
}

// =============================================================================
// PROPOSAL VALIDATION
// =============================================================================

/**
 * Validate a single structured action proposal against a slot's permission
 * level. This is the pure-layer gate: it can reject proposals that would break
 * the authority boundary, but it NEVER executes them.
 *
 * Rules enforced here (host-side may layer more):
 *   - read-only slots cannot have any actions (proposal must be rejected).
 *   - mutating verbs under 'suggest' are allowed as proposals (they are never
 *     auto-executed), but are still flagged for confirmation.
 *   - unknown verbs are rejected.
 *   - 'exec-gated' proposals are flagged `confirmationRequired: true`.
 *
 * @param {object} proposal A proposal of shape `{ verb, args? }`.
 * @param {object} slot     The AI slot configuration.
 * @returns {{ ok: boolean, errors: string[], confirmationRequired?: boolean }}
 */
export function validateProposal(proposal, slot) {
  if (!isPlainObject(slot)) {
    return { ok: false, errors: ['AI slot must be an object.'] };
  }

  const permission = slot.permission ?? PERMISSION_LEVELS.READ_ONLY;

  // Read-only can never have a proposal at all.
  if (permission === PERMISSION_LEVELS.READ_ONLY) {
    return {
      ok: false,
      errors: ['Read-only slots cannot produce actionable proposals.'],
    };
  }

  if (!isPlainObject(proposal)) {
    return { ok: false, errors: ['Proposal must be an object.'] };
  }

  const errors = [];
  const verb = proposal.verb;
  if (typeof verb !== 'string' || verb === '') {
    errors.push('Proposal must have a non-empty string "verb".');
  } else if (!Object.values(ACTION_VERBS).includes(verb)) {
    errors.push(`Unknown action verb "${verb}".`);
  }

  if (proposal.args !== undefined && !isPlainObject(proposal.args)) {
    errors.push('Proposal "args" must be an object.');
  }

  // Mutating verbs under exec-gated require explicit confirmation.
  let confirmationRequired = false;
  if (MUTATING_VERBS.has(verb)) {
    confirmationRequired = permission === PERMISSION_LEVELS.EXEC_GATED || true;
  }

  return {
    ok: errors.length === 0,
    errors,
    ...(confirmationRequired ? { confirmationRequired: true } : {}),
  };
}