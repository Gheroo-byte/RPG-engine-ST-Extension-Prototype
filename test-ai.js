/**
 * RPG Engine - AI Service Core tests (host-independent)
 * ======================================================
 * Plain Node, no framework, no SillyTavern, no DOM — matches test-stats.js in
 * style. Exercises ONLY the pure ai-core.js surface:
 *
 *   - valid slot shape
 *   - invalid permission rejected
 *   - supported permissions are exactly read-only / suggest / exec-gated
 *   - read-only proposal parsing produces no executable proposals
 *   - mutating proposals are rejected under read-only
 *   - action vocabulary is exposed/validated without requiring SillyTavern
 *   - malformed slot data is handled safely
 *
 * Run:  node test-ai.js
 */

import {
  PERMISSION_LEVELS,
  ACTION_VERBS,
  validateSlot,
  parseProposals,
  validateProposal,
} from './ai-core.js';

let passed = 0;
let failed = 0;
const failures = [];

function assertEqual(actual, expected, label) {
  const ok = Object.is(actual, expected);
  if (ok) {
    passed++;
  } else {
    failed++;
    failures.push(`  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

function assertTrue(cond, label) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(`  ✗ ${label}\n      expected truthy, got falsy`);
  }
}

function assertThrows(fn, label) {
  try {
    fn();
    failed++;
    failures.push(`  ✗ ${label}\n      expected throw, none occurred`);
  } catch {
    passed++;
  }
}

// Helper to build a minimal valid read-only slot.
function roSlot(overrides = {}) {
  return {
    id: 'slot-test',
    label: 'Test',
    purpose: 'test slot',
    enabled: true,
    permission: 'read-only',
    connection: { source: 'default' },
    ...overrides,
  };
}

console.log('=== ai-core.js tests ===\n');

// ── valid slot shape ─────────────────────────────────────────────────────────
validateSlot(roSlot());
assertTrue(true, 'validateSlot accepts a valid read-only slot');

// ── invalid permission rejected ──────────────────────────────────────────────
assertThrows(() => validateSlot(roSlot({ permission: 'god-mode' })), 'validateSlot rejects unknown permission "god-mode"');
assertThrows(() => validateSlot(roSlot({ permission: 'read_only' })), 'validateSlot rejects mis-cased "read_only"');
assertThrows(() => validateSlot(roSlot({ permission: 7 })), 'validateSlot rejects non-string permission');

// ── supported permissions are exactly read-only / suggest / exec-gated ───────
const permissionKeys = Object.values(PERMISSION_LEVELS).sort();
assertEqual(
  JSON.stringify(permissionKeys),
  JSON.stringify(['exec-gated', 'read-only', 'suggest'].sort()),
  'PERMISSION_LEVELS values are exactly read-only / suggest / exec-gated',
);
assertTrue(!('ALLOW' in PERMISSION_LEVELS), 'no extraneous ALLOW permission');
assertTrue(!('EXECUTE' in PERMISSION_LEVELS), 'no extraneous EXECUTE permission');

// each supported permission is accepted as a valid slot permission
validateSlot(roSlot({ permission: 'read-only' }));
validateSlot(roSlot({ permission: 'suggest' }));
validateSlot(roSlot({ permission: 'exec-gated' }));
assertTrue(true, 'all three supported permissions are accepted by validateSlot');

// ── read-only proposal parsing produces no executable proposals ─────────────
const roEmpty = parseProposals('{"actions":[{"verb":"set_stat"}]}', roSlot());
assertEqual(Array.isArray(roEmpty), true, 'parseProposals returns an array for read-only');
assertEqual(roEmpty.length, 0, 'parseProposals returns empty array for read-only slot');

// ── mutating proposals are rejected under read-only ─────────────────────────
const mutating = validateProposal({ verb: 'set_stat', args: { stat: 'STR', amount: 5 } }, roSlot());
assertEqual(mutating.ok, false, 'mutating proposal under read-only is rejected');
assertTrue(Array.isArray(mutating.errors) && mutating.errors.length > 0, 'read-only mutating rejection includes an error message');

// any verb (even informational) is rejected under read-only
const describe = validateProposal({ verb: 'describe_state' }, roSlot());
assertEqual(describe.ok, false, 'even informational proposal under read-only is rejected');

// ── action vocabulary is exposed/validated without SillyTavern ──────────────
assertTrue(ACTION_VERBS && typeof ACTION_VERBS === 'object', 'ACTION_VERBS is exposed');
assertEqual(typeof ACTION_VERBS.SET_STAT, 'string', 'ACTION_VERBS.set_stat is a string verb');

// unknown verb rejected under suggest (the parser would not produce it, but
// validateProposal must still guard)
const badVerb = validateProposal({ verb: 'nuke_everything' }, roSlot({ permission: 'suggest' }));
assertEqual(badVerb.ok, false, 'unknown verb rejected under suggest');

// valid non-mutating verb accepted under suggest (confirm shape-independent)
const suggestDescribe = validateProposal({ verb: 'describe_state' }, roSlot({ permission: 'suggest' }));
assertEqual(suggestDescribe.ok, true, 'describe_state accepted under suggest');

// mutating verb under suggest flags confirmationRequired but is a valid proposal
const suggestMutate = validateProposal({ verb: 'set_stat', args: { stat: 'STR', amount: 5 } }, roSlot({ permission: 'suggest' }));
assertEqual(suggestMutate.ok, true, 'set_stat accepted as a proposal under suggest');
assertEqual(suggestMutate.confirmationRequired, true, 'mutating proposal under suggest requires confirmation');

// ── malformed slot data handled safely ──────────────────────────────────────
assertThrows(() => validateSlot(null), 'validateSlot(null) throws');
assertThrows(() => validateSlot({}), 'validateSlot({}) throws (missing id)');
assertThrows(() => validateSlot({ id: 'x' }), 'validateSlot missing label throws');
assertThrows(() => validateSlot({ id: 'x', label: 'y', enabled: 'yes' }), 'validateSlot non-boolean enabled throws');
assertThrows(() => validateSlot({ id: 'x', label: 'y', connection: 'not-object' }), 'validateSlot non-object connection throws');

// parseProposals with malformed slot: should not throw
let parseResult;
try {
  parseResult = parseProposals('anything', null);
  assertTrue(true, 'parseProposals(null slot) does not throw');
} catch {
  failed++;
  failures.push('  ✗ parseProposals(null slot) threw unexpectedly');
}
if (parseResult) {
  assertEqual(parseResult.length, 0, 'parseProposals(null slot) returns empty array');
}

// validateProposal with malformed proposal: safe
const noVerb = validateProposal({}, roSlot({ permission: 'suggest' }));
assertEqual(noVerb.ok, false, 'proposal without verb rejected');

const nullProposal = validateProposal(null, roSlot({ permission: 'suggest' }));
assertEqual(nullProposal.ok, false, 'null proposal rejected under suggest');

const badArgs = validateProposal({ verb: 'set_stat', args: 'STR' }, roSlot({ permission: 'suggest' }));
assertEqual(badArgs.ok, false, 'non-object args rejected under suggest');

// ── results ────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(f);
  process.exit(1);
}
console.log('All AI core tests passed.');