/**
 * Test harness for stats.js (the modular statistics layer)
 * Run with: node test-stats.js
 *
 * No test framework dependency (matching test-engine.js). Plain assertions +
 * pass/fail tally. This proves the statistics layer works WITHOUT SillyTavern.
 */

import {
  StatsError,
  validateRuleset,
  createStat,
  getBaseStatNames,
  getStatCap,
  createCharacter,
  getStat,
  setStat,
  modifyStat,
  addModifier,
  getAppliedModifiers,
  getEffectiveStats,
  orderDerivedStats,
  validateCharacterStats,
  serializeCharacter,
  deserializeCharacter,
  extractStatReferences,
} from './stats.js';

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
  const ok = Object.is(actual, expected);
  if (ok) {
    passed++;
  } else {
    failed++;
    failures.push(description);
    console.log(`  FAIL: ${description} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

function assertThrowsStats(fn, description) {
  try {
    fn();
    failed++;
    failures.push(description);
    console.log(`  FAIL: ${description} (expected StatsError, but did not throw)`);
  } catch (e) {
    if (e instanceof StatsError) {
      passed++;
    } else {
      failed++;
      failures.push(description);
      console.log(`  FAIL: ${description} (expected StatsError, got ${e?.name ?? e})`);
    }
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

// =============================================================================
// A small, arbitrary ruleset - deliberately world-agnostic, invented names.
// =============================================================================
function makeRuleset() {
  return {
    base: {
      Vim: { min: 0, max: 100 },
      Dash: {},
      Grit: {},
    },
    derived: {
      // declare "Attack" before its dependencies to exercise ordering
      Attack: { formula: 'Vim + Dash' },
      MaxHit: { formula: 'Vim * 2 + Grit' },
      // derived that depends on another derived, declared first
      Total: { formula: 'MaxHit + Attack' },
    },
  };
}

function makeCharacter(ruleset, vals = {}) {
  return createCharacter(ruleset, vals);
}

// =============================================================================
section('Configurable stat definitions / arbitrary names');
// =============================================================================
{
  const rs = makeRuleset();
  assert(validateRuleset(rs) === true, 'validateRuleset accepts a well-formed ruleset');

  assert(Object.keys(rs.base).includes('Vim'), 'ruleset holds arbitrary base stat name "Vim"');
  assert(Object.keys(rs.base).includes('Dash'), 'ruleset holds arbitrary base stat name "Dash"');

  const rs2 = { base: { Foo: {}, Bar: {} }, derived: {} };
  assert(validateRuleset(rs2) === true, 'a ruleset with entirely different stat names is accepted');

  assertThrowsStats(() => validateRuleset(null), 'validateRuleset(null) throws StatsError');
  assertThrowsStats(() => validateRuleset({ base: null }), 'validateRuleset({base:null}) throws StatsError');
  assertThrowsStats(() => validateRuleset({}), 'validateRuleset({}) (missing base) throws StatsError');
  assertThrowsStats(
    () => validateRuleset({ base: { A: 'not-an-object' }, derived: {} }),
    'non-object base stat definition throws StatsError',
  );
}

// =============================================================================
section('createStat / ruleset stat registration / base name lookups');
// =============================================================================
{
  const rs = { base: {}, derived: {} };
  createStat(rs, 'Luck', { min: 0, max: 99 });
  assert(Object.keys(rs.base).includes('Luck'), 'createStat registers a new stat');

  createStat(rs, 'Luck', { min: 1, max: 99 });
  assert(rs.base.Luck.min === 1, 'createStat replaces an existing stat definition');

  assertThrowsStats(() => createStat(rs, '', {}), 'createStat refuses an empty stat name');
  assertThrowsStats(() => createStat(rs, 'X', 'bad'), 'createStat refuses a non-object definition');

  assert(getBaseStatNames(rs).includes('Luck'), 'getBaseStatNames lists registered base stats');
  assertEqual(getStatCap({ base: { Luck: { cap: 99 } } }, 'Luck'), 99, 'getStatCap reads a numeric cap');
  assertEqual(getStatCap({ base: { Luck: {} } }, 'Luck'), null, 'getStatCap returns null when no cap');
}

// =============================================================================
section('Base stat creation / access / set / modify');
// =============================================================================
{
  const rs = makeRuleset();
  const c = makeCharacter(rs, { Vim: 10, Dash: 5, Grit: 3 });

  assertEqual(getStat(c, 'Vim'), 10, 'getStat reads a base stat value');
  assertEqual(getStat(c, 'Dash'), 5, 'getStat reads a second base stat');
  assertEqual(getStat(c, 'Grit'), 3, 'getStat reads a supplied base value');

  const c2 = makeCharacter(rs);
  assertEqual(getStat(c2, 'Grit'), 0, 'unsupplied base value defaults to 0');

  setStat(c, 'Vim', 22);
  assertEqual(getStat(c, 'Vim'), 22, 'setStat updates a base stat value');

  modifyStat(c, 'Vim', 3);
  assertEqual(getStat(c, 'Vim'), 25, 'modifyStat adds an amount to a base stat');
  modifyStat(c, 'Vim', -5);
  assertEqual(getStat(c, 'Vim'), 20, 'modifyStat subtracts with a negative amount');

  assertThrowsStats(() => getStat(c, 'Nope'), 'getStat on a nonexistent stat throws StatsError');
  assertThrowsStats(() => setStat(c, 'Nope', 1), 'setStat on a nonexistent stat throws StatsError');
  assertThrowsStats(() => modifyStat(c, 'Nope', 1), 'modifyStat on a nonexistent stat throws StatsError');
  assertThrowsStats(() => setStat(c, 'Vim', 'NaN'), 'setStat refuses a non-number value');
  assertThrowsStats(() => modifyStat(c, 'Vim', NaN), 'modifyStat refuses a NaN amount');
}

// =============================================================================
section('Validation: ranges / caps');
// =============================================================================
{
  const rs = { base: { Vim: { min: 0, max: 100, cap: 90 } }, derived: {} };
  const c = createCharacter(rs, { Vim: 50 });
  assertEqual(validateCharacterStats(c, rs).length, 0, 'in-range value produces no violations');

  const over = createCharacter(rs, { Vim: 95 });
  assert(validateCharacterStats(over, rs).some((v) => v.stat === 'Vim'), 'value above max/cap produces a violation');

  const under = createCharacter(rs, { Vim: -1 });
  assert(validateCharacterStats(under, rs).some((v) => v.stat === 'Vim'), 'value below min produces a violation');
}

// =============================================================================
section('Derived stats: dependency resolution any order');
// =============================================================================
{
  const rs = {
    base: { Endurance: {}, Strength: {}, Agility: {} },
    derived: {
      MaxHP: { formula: 'Endurance * 10 + Strength * 2' },
      Attack: { formula: 'Strength + Agility' },
    },
  };
  const c = createCharacter(rs, { Endurance: 5, Strength: 3, Agility: 2 });
  const eff = getEffectiveStats(c, rs);
  assertEqual(eff.MaxHP, 56, 'MaxHP = Endurance*10 + Strength*2 (50 + 6)');
  assertEqual(eff.Attack, 5, 'Attack = Strength + Agility (3 + 2)');

  const rs2 = {
    base: { A: {}, B: {}, C: {} },
    derived: {
      Top: { formula: 'A + B + Bottom' },
      Bottom: { formula: 'C * 2' },
    },
  };
  const c2 = createCharacter(rs2, { A: 1, B: 2, C: 3 });
  const eff2 = getEffectiveStats(c2, rs2);
  assertEqual(eff2.Bottom, 6, 'out-of-order derived Bottom = C*2 resolves');
  assertEqual(eff2.Top, 9, 'out-of-order derived Top = A+B+Bottom resolves (1+2+6)');
}

// =============================================================================
section('Derived stats: dice notation in formulas');
// =============================================================================
{
  // A derived formula may contain a die roll; that die must NOT be treated as
  // a stat dependency (regression for the extractStatReferences dice bug).
  const rs = {
    base: { Power: {} },
    derived: { Strike: { formula: 'Power + d20' } },
  };
  const c = createCharacter(rs, { Power: 5 });
  const eff = getEffectiveStats(c, rs);
  // Strike equals Power + a d20 roll (1..20), so it is always in [6, 25].
  assert(
    typeof eff.Strike === 'number' && eff.Strike >= 6 && eff.Strike <= 25,
    `derived formula with dice resolves (Strike=${eff.Strike} in [6,25])`,
  );
  assertEqual(orderDerivedStats(rs).length, 1, 'dice-containing derived stat sorts without a missing-dep error');
}

// =============================================================================
section('Derived stats: multiple-level dependencies');
// =============================================================================
{
  const rs = {
    base: { A: {} },
    derived: {
      B: { formula: 'A + 1' },
      C: { formula: 'B + 1' },
      D: { formula: 'C + 1' },
    },
  };
  const c = createCharacter(rs, { A: 0 });
  const eff = getEffectiveStats(c, rs);
  assertEqual(eff.B, 1, 'level-1 derived B = A+1');
  assertEqual(eff.C, 2, 'level-2 derived C = B+1');
  assertEqual(eff.D, 3, 'level-3 derived D = C+1');
  assertEqual(orderDerivedStats(rs), ['B', 'C', 'D'], 'orderDerivedStats returns dependency-ordered names');
}

// =============================================================================
section('Derived stats: cycle and missing-dependency detection');
// =============================================================================
{
  const cycle = {
    base: { A: {} },
    derived: {
      X: { formula: 'Y + 1' },
      Y: { formula: 'X + 1' },
    },
  };
  assertThrowsStats(() => getEffectiveStats(createCharacter(cycle, { A: 0 }), cycle), 'circular dependency throws StatsError');
  assertThrowsStats(() => orderDerivedStats(cycle), 'orderDerivedStats detects a cycle');

  const missing = {
    base: { A: {} },
    derived: { Z: { formula: 'Nope + 1' } },
  };
  assertThrowsStats(() => getEffectiveStats(createCharacter(missing, { A: 0 }), missing), 'missing dependency throws StatsError');

  // extractStatReferences: stats detected, dice ignored
  const refs = extractStatReferences('Strength + 0.5 * Agility + d60');
  assert(refs.has('Strength') && refs.has('Agility'), 'extractStatReferences finds stat identifiers');
  assert(!refs.has('d60'), 'extractStatReferences ignores dice notation (d60)');

  const refs2 = extractStatReferences('2d6 + str + DEX');
  assert(!refs2.has('2d6'), 'extractStatReferences ignores dice notation (2d6)');
  assert(refs2.has('str') && refs2.has('DEX'), 'extractStatReferences detects stat names via case');
}

// =============================================================================
section('Modifiers: additive, multiple, temporary, permanent');
// =============================================================================
{
  const rs = { base: { Vim: {} }, derived: {} };
  const c = createCharacter(rs, { Vim: 10 });

  addModifier(c, { stat: 'Vim', amount: 5 });
  assertEqual(getAppliedModifiers(c, 'Vim').length, 1, 'modifier applies to its target stat');
  assertEqual(getEffectiveStats(c, rs).Vim, 15, 'single additive modifier raises effective Vim (10+5)');

  addModifier(c, { stat: 'Vim', amount: -3, permanent: true });
  assertEqual(getEffectiveStats(c, rs).Vim, 12, 'multiple additive modifiers combine (10+5-3)');

  const c2 = createCharacter(rs, { Vim: 10 });
  addModifier(c2, { stat: 'Vim', amount: 100, until: 1000 });
  assertEqual(getEffectiveStats(c2, rs, 500).Vim, 110, 'temporary modifier applies before expiry');
  assertEqual(getEffectiveStats(c2, rs, 1001).Vim, 10, 'temporary modifier expires after its "until" time');
  assertEqual(getAppliedModifiers(c2, 'Vim', 1001).length, 0, 'expired modifier is filtered out');

  assertThrowsStats(() => addModifier(c, { stat: '', amount: 1 }), 'modifier with empty stat name throws StatsError');
  assertThrowsStats(() => addModifier(c, { stat: 'Vim' }), 'modifier with missing amount throws StatsError');
  assertThrowsStats(() => addModifier(c, { stat: 'NotAStat', amount: 1, until: 'x' }), 'modifier with non-numeric until throws StatsError');
}

// =============================================================================
section('Effective stat calculation after modifiers + derived');
// =============================================================================
{
  const rs = {
    base: { Strength: {}, Agility: {} },
    derived: { Attack: { formula: 'Strength + Agility' } },
  };
  const c = createCharacter(rs, { Strength: 10, Agility: 5 });
  addModifier(c, { stat: 'Strength', amount: 4, permanent: true });
  const eff = getEffectiveStats(c, rs);
  assertEqual(eff.Strength, 14, 'effective Strength includes modifier (10+4)');
  assertEqual(eff.Attack, 19, 'derived Attack uses effective Strength (14+5)');
}

// =============================================================================
section('Serialization / restoration');
// =============================================================================
{
  const rs = makeRuleset();
  const c = createCharacter(rs, { Vim: 7, Dash: 4, Grit: 2 });
  addModifier(c, { stat: 'Vim', amount: 1, permanent: true });
  addModifier(c, { stat: 'Dash', amount: 2, until: 9999 });

  const json = serializeCharacter(c);
  const restored = deserializeCharacter(JSON.parse(JSON.stringify(json)));

  assertEqual(getStat(restored, 'Vim'), 7, 'serialized base value restores');
  assertEqual(getStat(restored, 'Dash'), 4, 'second serialized base value restores');
  assertEqual(restored.modifiers.length, 2, 'modifiers are serialized/restored');

  const eff = getEffectiveStats(restored, rs, 5000);
  assertEqual(eff.Vim, 8, 'effective after restore respects permanent modifier (7+1)');
  assertEqual(eff.Dash, 6, 'effective after restore respects in-window temporary modifier (4+2)');

  assertThrowsStats(() => deserializeCharacter(null), 'deserializeCharacter(null) throws StatsError');
  assertThrowsStats(() => deserializeCharacter({}), 'deserializeCharacter({}) throws StatsError (missing base)');
}

// =============================================================================
section('Ruleset-specific definitions (Shattered Dominion / Kaelrath / D&D shaped)');
// =============================================================================
{
  const sd = {
    base: { STR: {}, DEX: { cap: 60 } },
    derived: { 'Max HP': { formula: 'CON*10 + STR*2' }, 'Max CHI': { formula: 'BLS*10' } },
  };
  const kae = {
    base: { Strength: {}, Agility: {}, Endurance: {} },
    derived: { HP: { formula: 'Endurance*10 + Strength*2' } },
  };
  const dnd = { base: { Strength: {}, Dexterity: {} }, derived: {} };

  assert(validateRuleset(sd) === true, 'SD-shaped ruleset validates');
  assert(validateRuleset(kae) === true, 'Kaelrath-shaped ruleset validates');
  assert(validateRuleset(dnd) === true, 'D&D-shaped ruleset validates (no derived)');

  const kc = createCharacter(kae, { Strength: 3, Endurance: 5 });
  assertEqual(getEffectiveStats(kc, kae).HP, 56, 'Kaelrath HP derived value computes');
}

// =============================================================================
console.log(`\n\n${'='.repeat(50)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
} else {
  console.log('\nAll tests passed.');
  process.exit(0);
}