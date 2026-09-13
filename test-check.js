/**
 * RPG Engine - Check Resolver + Narrator roll_check tool tests (host-independent)
 * ===============================================================================
 * Plain Node, no framework, no SillyTavern, no DOM.
 * Exercises check.js (alternative stats, resolveCheck, natural/tier/damage, ruleset
 * isolation) and ai-tools.js roll_check adapter + ai-store.js dispatch.
 *
 * Deterministic rolls via an injectable DiceRoller so tests assert ranges/arithmetic,
 * never a particular random result.
 */

import {
  resolveCheck,
  normalizeAlternativeStats,
} from './check.js';
import { roll_check, roll_dice, NARRATOR_TOOLS, getTool, dispatchToolCall } from './ai-tools.js';
import { dispatchNarratorTool, listNarratorTools } from './ai-store.js';
import { RULESETS } from './rulesets.js';

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, label) { if (cond) { passed++; } else { failed++; failures.push(`  ✗ ${label}`); } }
function assertEqual(actual, expected, label) {
  let ok;
  if (Array.isArray(actual) && Array.isArray(expected)) { ok = actual.length === expected.length && actual.every((v, i) => Object.is(v, expected[i])); }
  else { ok = Object.is(actual, expected); }
  if (ok) passed++;
  else failures.push(`  ✗ ${label}\n      expected ${JSON.stringify(expected)}\n      actual ${JSON.stringify(actual)}`);
}
function assertThrows(fn, label) { try { fn(); failed++; failures.push(`  ✗ ${label} (expected throw)`); } catch { passed++; } }

const SD = RULESETS['shattered-dominion'];
const DND = RULESETS['dnd'];
const KAEL = RULESETS['kaelrath'];

// Deterministic roller (returns fixed sequence).
function fixedRoller(seq) {
  let i = 0;
  return {
    roll(count, sides) {
      const rolls = [];
      for (let k = 0; k < count; k++) rolls.push(seq[i++ % seq.length]);
      return { rolls, total: rolls.reduce((a, b) => a + b, 0) };
    },
  };
}

console.log('=== check.js + roll_check + dispatch tests ===\n');

// ── alternative-stat normalization: REQUIRED explicit choice ────────────────
{
  // No / group -> alternative null (division unaffected by alt logic).
  const none = normalizeAlternativeStats('d60 + STR + 0.5*INT', {});
  assertEqual(none.alternative, null, 'no / group => alternative null');

  // '/' with numbers stays division (NOT an alternative group).
  const div = normalizeAlternativeStats('INT / 2 + STR', {});
  assertEqual(div.alternative, null, 'INT/2 is division, not an alternative group');

  // Missing selection -> validation error (NEVER silently auto-select).
  assertThrows(() => normalizeAlternativeStats('d80 + CON/STR + Mod', {}),
    'CON/STR without selection throws');

  // Explicit CON selection.
  const con = normalizeAlternativeStats('d80 + CON/STR + Mod', { selected: 'CON' });
  assertEqual(con.formula, 'd80 + CON + Mod', 'selected=CON normalizes to CON');
  assertEqual(con.alternative.alternatives, ['CON', 'STR'], 'alternatives = [CON, STR]');
  assertEqual(con.alternative.selected, 'CON', 'selected reported as CON');

  // Explicit STR selection.
  const str = normalizeAlternativeStats('d80 + CON/STR + Mod', { selected: 'STR' });
  assertEqual(str.formula, 'd80 + STR + Mod', 'selected=STR normalizes to STR');
  assertEqual(str.alternative.selected, 'STR', 'selected reported as STR');

  // Invalid selection -> error.
  assertThrows(() => normalizeAlternativeStats('d80 + CON/STR + Mod', { selected: 'WIS' }),
    'invalid selected=WIS throws');
}

// ── SD check: full example d60 + STR + 0.5INT + Mod vs d80 + CON/STR + Mod ──
{
  const r = resolveCheck({
    ruleset: SD,
    actor: { formula: 'd60 + STR + 0.5*INT + Mod', stats: { STR: 4, INT: 10, Mod: 2 }, tier: 4 },
    target: { formula: 'd80 + CON/STR + Mod', stats: { CON: 5, STR: 6, Mod: 1 }, tier: 5, selected: 'STR' },
    difficulty: { difficulty: 2 },
    diceRoller: fixedRoller([41, 26]),
  });
  assertEqual(r.ruleset, 'shattered-dominion', 'SD check reports ruleset id');
  assertEqual(r.type, 'opposed', 'SD check is opposed');
  assertEqual(String(r.actorTotal), '57', 'actorTotal = 41+4+5+2+5(tier) = 57');
  assertEqual(String(r.targetTotal), '33', 'targetTotal = 26+6+1 = 33');
  assertEqual(r.outcome, 'PASS', 'outcome PASS');
  assertEqual(r.tierGap.modifier, 5, 'tier gap: actor 4 vs target 5 => +5');
  assertEqual(r.alternative.target.selected, 'STR', 'target alternative selected STR');
  assertEqual(r.damage !== null, true, 'SD damage computed');
}

// ── SD bands: pass / partial / fail boundaries ──────────────────────────────
{
  const pass = resolveCheck({ ruleset: SD, actor: { formula: 'd60', stats: {} }, target: { dc: 30 }, diceRoller: fixedRoller([30]) });
  assertEqual(pass.outcome, 'PASS', 'roll 30 vs dc 30 -> PASS (>= )');

  const partial = resolveCheck({ ruleset: SD, actor: { formula: 'd60', stats: {} }, target: { dc: 34 }, diceRoller: fixedRoller([31]) });
  assertEqual(partial.outcome, 'PARTIAL', 'roll 31 vs dc 34 -> PARTIAL (within 5)');

  const partEdge = resolveCheck({ ruleset: SD, actor: { formula: 'd60', stats: {} }, target: { dc: 35 }, diceRoller: fixedRoller([30]) });
  assertEqual(partEdge.outcome, 'PARTIAL', 'roll 30 vs dc 35 -> PARTIAL (exactly 5 within)');

  const fail = resolveCheck({ ruleset: SD, actor: { formula: 'd60', stats: {} }, target: { dc: 40 }, diceRoller: fixedRoller([34]) });
  assertEqual(fail.outcome, 'FAIL', 'roll 34 vs dc 40 -> FAIL (6 below, beyond partial)');
}

// ── SD natural 60 / natural 1 ────────────────────────────────────────────────
{
  const crit = resolveCheck({ ruleset: SD, actor: { formula: 'd60', stats: {} }, target: { dc: 999 }, diceRoller: fixedRoller([60]) });
  assertEqual(crit.outcome, 'PASS', 'natural 60 guarantees success');
  assertEqual(crit.natural.kind, 'natural', 'natural 60 reported');

  const fumble = resolveCheck({ ruleset: SD, actor: { formula: 'd60 + 1000', stats: {} }, target: { dc: 1 }, diceRoller: fixedRoller([1]) });
  assertEqual(fumble.outcome, 'FAIL', 'natural 1 forces failure despite huge bonus');
  assertEqual(fumble.natural.kind, 'fumble', 'natural 1 reported as fumble');
}

// ── SD tier-gap bidirection ──────────────────────────────────────────────────
{
  const below = resolveCheck({
    ruleset: SD,
    actor: { formula: 'd60', stats: {}, tier: 2 },
    target: { dc: 40, tier: 5 },
    diceRoller: fixedRoller([30]),
  });
  assertEqual(below.tierGap.modifier, 15, 'tier below target gives +5 per tier (+15)');

  const above = resolveCheck({
    ruleset: SD,
    actor: { formula: 'd60', stats: {}, tier: 6 },
    target: { dc: 40, tier: 3 },
    diceRoller: fixedRoller([30]),
  });
  assertEqual(above.tierGap.modifier, -15, 'tier above target gives -5 per tier (-15)');
}

// ── SD damage: .5 rounds up ──────────────────────────────────────────────────
{
  // dealt = Roll + (Roll - Target) * (Roll / 20). Roll=21, Target=10
  //      = 21 + 11 * 1.05 = 21 + 11.55 = 32.55 -> round 33 (rounds up)
  const r = resolveCheck({
    ruleset: SD,
    actor: { formula: 'd60', stats: {} },
    target: { dc: 10 },
    diceRoller: fixedRoller([21]),
  });
  assertEqual(r.damage.dealt, 33, 'damage.dealt 32.55 rounds up to 33 (.5 rounds up)');
}

// ── Ruleset isolation: D&D / Kaelrath do NOT inherit SD ──────────────────────
{
  const d = resolveCheck({
    ruleset: DND,
    actor: { formula: '1d20 + STR', stats: { STR: 3 }, tier: 9 },
    target: { dc: 12, tier: 1 },
    diceRoller: fixedRoller([6]),
  });
  assertEqual(d.outcome, 'FAILURE', 'D&D generic SUCCESS/FAILURE (no PASS/PARTIAL)');
  assertEqual(d.tierGap, null, 'D&D no tier-gap');
  assertEqual(d.damage, null, 'D&D no damage');
  assertEqual(d.natural, null, 'D&D no natural-60');

  const k = resolveCheck({ ruleset: KAEL, actor: { formula: 'd60', stats: {} }, target: { dc: 10 }, diceRoller: fixedRoller([60]) });
  assertEqual(k.outcome, 'SUCCESS', 'Kaelrath generic binary (natural 60 does not auto-pass)');
  assertEqual(k.damage, null, 'Kaelrath no damage');
}

// ── roll_check tool adapter + d20/1d20/modifier expressions ──────────────────
{
  assertEqual(getTool('roll_check'), roll_check, 'roll_check registered');
  assertEqual(getTool('roll_dice'), roll_dice, 'roll_dice registered');
  assertEqual(Object.keys(NARRATOR_TOOLS).length, 2, 'registry has exactly 2 tools');

  const d20 = roll_check.execute({ actorFormula: 'd20', dc: 10 });
  const d1_20 = roll_check.execute({ actorFormula: '1d20', dc: 10 });
  assert(d20.actorTotal !== undefined && d1_20.actorTotal !== undefined, 'd20 and 1d20 both resolve');

  const m = roll_check.execute({ actorFormula: '1d20+4', dc: 20 });
  assert(Number.isFinite(m.actorTotal), '1d20+4 resolves to a finite total');

  const m2 = roll_check.execute({ actorFormula: '2d8-3', dc: 10 });
  assert(Number.isFinite(m2.actorTotal), '2d8-3 resolves');

  assertThrows(() => roll_check.execute({ actorFormula: 'd20' }), 'roll_check without target/dc throws');
}

// ── narrator dispatch path (ai-store.js): rulesetId → ruleset → resolver ────
{
  const tools = listNarratorTools();
  assert(Array.isArray(tools) && tools.length === 2, 'listNarratorTools returns 2 tools');
  const names = tools.map((t) => t.name);
  assert(names.includes('roll_dice') && names.includes('roll_check'), 'both tools listed');
  assert(tools.every((t) => !('execute' in t)), 'tool schemas do not expose execute');

  const r = dispatchNarratorTool('roll_check', {
    rulesetId: 'shattered-dominion',
    actorFormula: 'd60 + STR', actorStats: { STR: 2 },
    targetFormula: 'd80 + CON/STR + Mod', targetStats: { CON: 3, STR: 4, Mod: 1 }, targetAlternative: 'CON',
    actorTier: 4, targetTier: 5,
  }, fixedRoller([41, 26]));
  assertEqual(r.ruleset, 'shattered-dominion', 'dispatch resolves rulesetId to SD ruleset');
  assertEqual(r.outcome, 'PASS', 'dispatch reaches SD profile and classifies PASS');
  assertEqual(r.alternative.target.selected, 'CON', 'targetAlternative=CON selected via dispatch');

  assertThrows(() => dispatchToolCall('nope', {}), 'dispatchToolCall unknown tool throws');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log('\nFailures:'); failures.forEach((f) => console.log(f)); process.exit(1); }
console.log('All check/tool/dispatch tests passed.');