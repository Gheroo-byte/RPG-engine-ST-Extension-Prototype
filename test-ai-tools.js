/**
 * RPG Engine - Narrator AI Tools tests (host-independent)
 * ========================================================
 * Plain Node, no framework, no SillyTavern, no DOM.
 * Exercises the ai-tools.js narrator tool layer:
 *   - roll_dice is registered
 *   - basic expressions roll the correct number of dice within range
 *   - modifiers are applied
 *   - malformed / out-of-limit expressions are rejected
 *   - the tool delegates to the existing DiceRoller (mocked via injectable roller)
 */

import {
  roll_dice,
  NARRATOR_TOOLS,
  getTool,
  MAX_DICE_COUNT,
  MAX_DIE_SIDES,
} from './ai-tools.js';
import { DiceRoller, EngineError } from './engine-core.js';

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, label) {
  if (cond) { passed++; }
  else { failed++; failures.push(`  ✗ ${label}`); }
}

function assertEqual(actual, expected, label) {
  let ok;
  if (Array.isArray(actual) && Array.isArray(expected)) {
    ok = actual.length === expected.length && actual.every((v, i) => Object.is(v, expected[i]));
  } else {
    ok = Object.is(actual, expected);
  }
  if (ok) { passed++; }
  else {
    failed++;
    failures.push(`  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

function assertThrows(fn, label) {
  try { fn(); failed++; failures.push(`  ✗ ${label} (expected throw, none occurred)`); }
  catch { passed++; }
}

// A deterministic DiceRoller for mocking: returns a supplied sequence of rolls.
function fakeRoller(sequence) {
  let i = 0;
  return {
    roll(count, sides) {
      const rolls = [];
      for (let k = 0; k < count; k++) rolls.push(sequence[(i++) % sequence.length]);
      return { rolls, total: rolls.reduce((a, b) => a + b, 0) };
    },
  };
}

console.log('=== ai-tools.js tests ===\n');

// ── registration ─────────────────────────────────────────────────────────────
{
  assertEqual(typeof roll_dice.name, 'string', 'roll_dice has a name');
  assertEqual(roll_dice.name, 'roll_dice', 'tool name is "roll_dice"');
  assertEqual(NARRATOR_TOOLS.roll_dice, roll_dice, 'roll_dice is present in NARRATOR_TOOLS registry');
  assertEqual(getTool('roll_dice'), roll_dice, 'getTool("roll_dice") returns the tool');
  assertEqual(getTool('nope'), null, 'getTool of unknown tool returns null');
  assertEqual(roll_dice.parameters.required.includes('expression'), true, 'expression is a required parameter');
}

// ── basic expressions ────────────────────────────────────────────────────────
{
  const one = roll_dice.execute({ expression: '1d20' });
  assertEqual(one.rolls.length, 1, '1d20 rolls exactly 1 die');
  assert(one.rolls[0] >= 1 && one.rolls[0] <= 20, '1d20 result within 1..20');
  assertEqual(one.total, one.rolls[0], '1d20 total equals the single roll');
  assertEqual(one.modifier, 0, '1d20 has no modifier');
  assertEqual(one.expression, '1d20', 'expression echoed back');

  const two = roll_dice.execute({ expression: '2d20' });
  assertEqual(two.rolls.length, 2, '2d20 rolls exactly 2 dice');
  assert(two.rolls.every((r) => r >= 1 && r <= 20), '2d20 every result within 1..20');
  assertEqual(two.total, two.rolls[0] + two.rolls[1], '2d20 total is the sum of rolls');

  const four = roll_dice.execute({ expression: '4d6' });
  assertEqual(four.rolls.length, 4, '4d6 rolls exactly 4 dice');
  assert(four.rolls.every((r) => r >= 1 && r <= 6), '4d6 every result within 1..6');
  assertEqual(four.total, four.rolls.reduce((a, b) => a + b, 0), '4d6 total is the sum');
}

// ── modifiers ────────────────────────────────────────────────────────────────
{
  const plus = roll_dice.execute({ expression: '1d20+5' });
  assertEqual(plus.modifier, 5, '1d20+5 modifier is 5');
  assertEqual(plus.total, plus.rolls[0] + 5, '1d20+5 total = roll + 5');

  const plus2 = roll_dice.execute({ expression: '2d6+3' });
  assertEqual(plus2.modifier, 3, '2d6+3 modifier is 3');
  assertEqual(plus2.total, plus2.rolls[0] + plus2.rolls[1] + 3, '2d6+3 total = sum + 3');

  const minus = roll_dice.execute({ expression: '1d20-2' });
  assertEqual(minus.modifier, -2, '1d20-2 modifier is -2');
  assertEqual(minus.total, minus.rolls[0] - 2, '1d20-2 total = roll - 2');
}

// ── whitespace tolerance ─────────────────────────────────────────────────────
{
  const spaced = roll_dice.execute({ expression: '  3d8  ' });
  assertEqual(spaced.rolls.length, 3, 'whitespace-padded "3d8" still rolls 3 dice');
  assertEqual(spaced.expression, '3d8', 'expression is trimmed');
}

// ── the tool delegates to DiceRoller (mocked, deterministic) ────────────────
{
  const fixed = roll_dice.execute({ expression: '2d20+5' }, fakeRoller([14, 7]));
  assertEqual(fixed.rolls, [14, 7], 'mocked roller returns the exact [14, 7]');
  assertEqual(fixed.modifier, 5, 'mocked 2d20+5 modifier is 5');
  assertEqual(fixed.total, 26, 'mocked 2d20+5 total = 14+7+5 = 26');
}

// ── validation: malformed expressions rejected ──────────────────────────────
{
  assertThrows(() => roll_dice.execute({ expression: 'd20' }), 'missing die count "d20" rejected');
  assertThrows(() => roll_dice.execute({ expression: '20' }), 'bare number "20" rejected');
  assertThrows(() => roll_dice.execute({ expression: '2dd20' }), 'double-d "2dd20" rejected');
  assertThrows(() => roll_dice.execute({ expression: '2d' }), 'missing sides "2d" rejected');
  assertThrows(() => roll_dice.execute({ expression: '2d20foo' }), 'trailing garbage "2d20foo" rejected');
  assertThrows(() => roll_dice.execute({ expression: 'abc' }), 'non-numeric "abc" rejected');
  assertThrows(() => roll_dice.execute({ expression: '' }), 'empty expression rejected');
  assertThrows(() => roll_dice.execute({ expression: '   ' }), 'whitespace-only expression rejected');
  assertThrows(() => roll_dice.execute({}), 'missing expression arg rejected');
  assertThrows(() => roll_dice.execute({ expression: '2d20+5+1' }), 'malformed modifier "2d20+5+1" rejected');
  assertThrows(() => roll_dice.execute({ expression: '2d20+abc' }), 'non-integer modifier rejected');
  assertThrows(() => roll_dice.execute({ expression: '1d20*2' }), 'multiplication operator rejected');
}

// ── limits ───────────────────────────────────────────────────────────────────
{
  assertThrows(() => roll_dice.execute({ expression: `${MAX_DICE_COUNT + 1}d6` }), 'over-limit dice count rejected');
  assertThrows(() => roll_dice.execute({ expression: `1d${MAX_DIE_SIDES + 1}` }), 'over-limit die sides rejected');
  // Boundary values are accepted (within limits).
  const maxOk = roll_dice.execute({ expression: `1d${MAX_DIE_SIDES}` });
  assert(maxOk.rolls.length === 1, 'max allowed sides rolls 1 die without error');
}

// ── results ──────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(f));
  process.exit(1);
}
console.log('All narrator tool tests passed.');