/**
 * Test harness for engine-core.js
 * Run with: node test-engine.js
 *
 * No test framework dependency on purpose - this needs to run anywhere,
 * including eventually inside SillyTavern's extension environment where
 * pulling in a full test runner isn't practical. Plain assertions + a
 * pass/fail tally.
 */

import {
  EngineError,
  DiceRoller,
  rollDie,
  parseFormula,
  evaluateFormula,
  ManualOverride,
  staticCheck,
  opposedCheck,
  formatResult,
} from './engine-core.js';

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, description) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(description);
    console.log(`  FAIL: ${description}`);
  }
}

function assertEqual(actual, expected, description) {
  assert(actual === expected, `${description} (expected ${expected}, got ${actual})`);
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

// A deterministic dice roller for reproducible tests - overrides Math.random
// only within the scope of these tests.
function withFixedRandom(sequence, fn) {
  let i = 0;
  const original = Math.random;
  Math.random = () => {
    const v = sequence[i % sequence.length];
    i++;
    return v;
  };
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

// =============================================================================
section('Dice: range and statistical sanity');
// =============================================================================
{
  let min = Infinity, max = -Infinity, sum = 0;
  const trials = 50000;
  for (let i = 0; i < trials; i++) {
    const v = rollDie(6);
    min = Math.min(min, v);
    max = Math.max(max, v);
    sum += v;
  }
  assert(min === 1, 'd6 minimum result is 1');
  assert(max === 6, 'd6 maximum result is 6');
  const avg = sum / trials;
  assert(Math.abs(avg - 3.5) < 0.05, `d6 average over ${trials} rolls is close to 3.5 (got ${avg.toFixed(3)})`);

  // Custom die (d60, since Astralis uses it)
  const roller = new DiceRoller();
  const { rolls, total } = roller.roll(1, 60);
  assert(rolls.length === 1, 'roll(1, 60) returns exactly one roll');
  assert(total >= 1 && total <= 60, `d60 result ${total} is within 1-60`);

  assert.throws = undefined; // no-op, just documenting style
  try {
    rollDie(0);
    assert(false, 'rollDie(0) should throw EngineError');
  } catch (e) {
    assert(e instanceof EngineError, 'rollDie(0) throws EngineError');
  }
}

// =============================================================================
section('Formula parsing: design doc examples');
// =============================================================================
{
  // "2d6 + Strength" - from the Formula Evaluator section of the design doc
  withFixedRandom([0.5, 0.5], () => {
    // 0.5 on a d6 -> floor(0.5*6)+1 = 4
    const { total, breakdown } = evaluateFormula('2d6 + Strength', { Strength: 10 }, new DiceRoller());
    assertEqual(total, 18, '"2d6 + Strength" with fixed 4+4 dice and Strength=10 equals 18');
    assert(breakdown.some(b => b.label === '2d6'), 'breakdown includes the "2d6" component');
    assert(breakdown.some(b => b.label === 'Strength' && b.value === 10), 'breakdown includes Strength: 10');
  });

  // "d60 + INT + 0.5*BLS" - the Astralis-style example from the design doc
  withFixedRandom([40 / 60], () => {
    // 40/60 on d60 -> floor((40/60)*60)+1 = 41
    const { total, breakdown } = evaluateFormula('d60 + INT + 0.5*BLS', { INT: 34, BLS: 30 }, new DiceRoller());
    assertEqual(total, 41 + 34 + 15, '"d60 + INT + 0.5*BLS" evaluates correctly (roll 41, INT 34, half of BLS 30 = 15)');
    assert(breakdown.some(b => b.label === '0.5 x BLS' && b.value === 15), 'breakdown collapses "0.5*BLS" into a single "0.5 x BLS: 15" entry');
  });

  // Case-insensitive stat matching (STR vs Strength)
  {
    const { total } = evaluateFormula('str + 5', { STR: 20 }, new DiceRoller());
    assertEqual(total, 25, 'stat lookup is case-insensitive ("str" matches "STR")');
  }

  // Unknown stat should throw, not silently evaluate to 0 or NaN
  try {
    evaluateFormula('Strength + UnknownStat', { Strength: 10 }, new DiceRoller());
    assert(false, 'unknown stat should throw');
  } catch (e) {
    assert(e instanceof EngineError, 'referencing an undefined stat throws EngineError rather than silently returning NaN/0');
  }
}

// =============================================================================
section('Formula parsing: the exact Talia Pounce example from the design doc');
// =============================================================================
{
  // "Strength + 0.5 Agility + d60"  -- note: implicit multiplication, no '*'
  // Design doc: Strength +32, Agility x0.5 +18 (so Agility=36), roll 41, total 91
  withFixedRandom([40 / 60], () => {
    const stats = { Strength: 32, Agility: 36 };
    const { total, breakdown } = evaluateFormula('Strength + 0.5 Agility + d60', stats, new DiceRoller());
    assertEqual(total, 32 + 18 + 41, 'Talia\'s "Strength + 0.5 Agility + d60" implicit-multiplication formula equals 91 (matches design doc example exactly)');
    assert(breakdown.some(b => b.label === '0.5 x Agility' && b.value === 18), 'implicit "0.5 Agility" (no asterisk) parses as multiplication, not an error');
  });
}

// =============================================================================
section('Implicit multiplication and parentheses');
// =============================================================================
{
  const { total: t1 } = evaluateFormula('2(3+4)', {}, new DiceRoller());
  assertEqual(t1, 14, '"2(3+4)" implicit multiplication with parens equals 14');

  const { total: t2 } = evaluateFormula('(Strength + Agility) / 2', { Strength: 40, Agility: 60 }, new DiceRoller());
  assertEqual(t2, 50, '"(Strength + Agility) / 2" equals 50');

  try {
    evaluateFormula('5 / 0', {}, new DiceRoller());
    assert(false, 'division by zero should throw');
  } catch (e) {
    assert(e instanceof EngineError, 'division by zero throws EngineError');
  }
}

// =============================================================================
section('Static check (2d6 + Strength vs DC 15)');
// =============================================================================
{
  withFixedRandom([0.9, 0.9], () => {
    // 0.9 on d6 -> floor(0.9*6)+1 = 6, so 2d6 = 12
    const result = staticCheck({
      formula: '2d6 + Strength',
      stats: { Strength: 5 },
      dc: 15,
      diceRoller: new DiceRoller(),
    });
    assertEqual(result.actorTotal, 17, 'static check total is 17 (12 from dice + 5 Strength)');
    assertEqual(result.outcome, 'SUCCESS', '17 vs DC 15 is a SUCCESS');
    assertEqual(result.margin, 2, 'margin is total - dc = 2');
  });

  withFixedRandom([0.0, 0.0], () => {
    // 0.0 on d6 -> floor(0*6)+1 = 1, so 2d6 = 2
    const result = staticCheck({
      formula: '2d6 + Strength',
      stats: { Strength: 5 },
      dc: 15,
      diceRoller: new DiceRoller(),
    });
    assertEqual(result.actorTotal, 7, 'low roll: total is 7 (2 from dice + 5 Strength)');
    assertEqual(result.outcome, 'FAILURE', '7 vs DC 15 is a FAILURE');
  });
}

// =============================================================================
section('Opposed check (Talia Pounce vs a target defense formula)');
// =============================================================================
{
  withFixedRandom([40 / 60, 0.5], () => {
    const result = opposedCheck({
      actorFormula: 'Strength + 0.5 Agility + d60',
      actorStats: { Strength: 32, Agility: 36 },
      targetFormula: 'd60 + Reflex',
      targetStats: { Reflex: 20 },
      diceRoller: new DiceRoller(),
    });
    // actor: 32 + 18 + 41 = 91
    // target: d60 with 0.5 -> 31, + 20 = 51
    assertEqual(result.actorTotal, 91, 'opposed check actor total is 91');
    assertEqual(result.targetTotal, 51, 'opposed check target total is 51');
    assertEqual(result.outcome, 'SUCCESS', 'actor beats target -> SUCCESS');
    assertEqual(result.margin, 40, 'margin is actorTotal - targetTotal');
  });
}

// =============================================================================
section('Manual overrides - must be clearly flagged, never silent');
// =============================================================================
{
  const forced = ManualOverride.forceTotal(75, 'Testing the override path');
  assertEqual(forced.total, 75, 'forceTotal returns the exact forced value');
  assert(forced.manualOverride === true, 'forceTotal sets manualOverride: true');
  assert(forced.breakdown[0].label === 'MANUAL OVERRIDE', 'forceTotal breakdown is explicitly labeled, not disguised as a normal roll');

  const forcedFail = ManualOverride.forceOutcome('FAILURE', 'Narrative needs this to fail');
  assertEqual(forcedFail.outcome, 'FAILURE', 'forceOutcome sets the outcome directly, no roll performed');
  assert(forcedFail.forcedOutcome === true, 'forceOutcome is distinguishable from a numeric override via forcedOutcome flag');

  try {
    ManualOverride.forceOutcome('MAYBE');
    assert(false, 'forceOutcome should reject invalid outcome values');
  } catch (e) {
    assert(e instanceof EngineError, 'forceOutcome("MAYBE") throws EngineError - only SUCCESS/FAILURE allowed');
  }

  // Verify an override plugged into staticCheck is still clearly flagged
  const overriddenCheck = staticCheck({ dc: 15, override: ManualOverride.forceTotal(99, 'DM fiat') });
  assert(overriddenCheck.manualOverride === true, 'a staticCheck using an override still carries the manualOverride flag through');
}

// =============================================================================
section('formatResult - matches design-doc RESULT block style');
// =============================================================================
{
  withFixedRandom([40 / 60], () => {
    const stats = { Strength: 32, Agility: 36 };
    const result = opposedCheck({
      actorFormula: 'Strength + 0.5 Agility + d60',
      actorStats: stats,
      targetFormula: '50',
      targetStats: {},
      diceRoller: new DiceRoller(),
    });
    const text = formatResult(result, 'Pounce');
    console.log('\n--- Sample RESULT block ---');
    console.log(text);
    console.log('--- end sample ---\n');
    assert(text.includes('Action: Pounce'), 'formatResult includes the action name');
    assert(text.includes('Total: 91'), 'formatResult includes the correct total');
    assert(text.includes('Result: SUCCESS'), 'formatResult includes the outcome line');
  });
}

// =============================================================================
console.log(`\n\n${'='.repeat(50)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach(f => console.log(`  - ${f}`));
  process.exit(1);
} else {
  console.log('\nAll tests passed.');
  process.exit(0);
}
