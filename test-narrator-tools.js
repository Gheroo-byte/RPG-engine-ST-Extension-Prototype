/**
 * RPG Engine - Narrator Tool Registration Bridge tests (host-independent)
 * ======================================================================
 * Plain Node, no framework, no SillyTavern, no DOM. Exercises
 * narrator-tools-st.js by injecting a MOCK SillyTavern context.
 *
 * The bridge is deliberately a thin seam: it maps pure tool schemas onto the
 * SillyTavern `registerFunctionTool` shape and wires `action` to the existing
 * `dispatchNarratorTool`. Live ST generation (the native tool-call loop) is
 * only manually testable inside SillyTavern; here we assert everything that is
 * testable without a browser.
 */

import { registerNarratorFunctionTools, buildNarratorToolDefinitions } from './narrator-tools-st.js';
import { NARRATOR_TOOLS } from './ai-tools.js';

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, label) { if (cond) { passed++; } else { failed++; failures.push(`  ✗ ${label}`); } }
function assertEqual(actual, expected, label) {
  let ok;
  if (Array.isArray(actual) && Array.isArray(expected)) ok = actual.length === expected.length && actual.every((v, i) => Object.is(v, expected[i]));
  else ok = Object.is(actual, expected);
  if (ok) passed++;
  else failures.push(`  ✗ ${label}\n      expected ${JSON.stringify(expected)}\n      actual ${JSON.stringify(actual)}`);
}

/** Build a mock ST context capturing registered tools. */
function mockContext({ toolsSupported = true } = {}) {
  const registered = [];
  return {
    registered,
    registerFunctionTool(def) { registered.push(def); },
    isToolCallingSupported() { return toolsSupported; },
  };
}

console.log('=== narrator-tools-st.js bridge tests ===\n');

// ── schema building: correct names / descriptions / parameters ───────────────
{
  const defs = buildNarratorToolDefinitions();
  assertEqual(defs.length, 2, 'two tool definitions built');

  const names = defs.map((d) => d.name).sort();
  assertEqual(names, ['roll_check', 'roll_dice'], 'tool names are roll_dice and roll_check');

  const dice = defs.find((d) => d.name === 'roll_dice');
  assert(dice.description.length > 0, 'roll_dice has a description');
  assertEqual(dice.parameters.type, 'object', 'parameters.type is "object"');
  assertEqual(dice.parameters.$schema, 'http://json-schema.org/draft-04/schema#', 'parameters carries $schema draft-04');
  assertEqual(dice.parameters.required.includes('expression'), true, 'roll_dice requires "expression"');

  const check = defs.find((d) => d.name === 'roll_check');
  assertEqual(check.parameters.required.includes('actorFormula'), true, 'roll_check requires "actorFormula"');
  assert(check.parameters.properties.actorFormula, 'roll_check exposes actorFormula property');
  assert(check.parameters.properties.targetAlternative, 'roll_check exposes targetAlternative property');
  assert(check.parameters.properties.rulesetId, 'roll_check exposes rulesetId property');
}

// ── action() returns a JSON string and reaches the pure tool/resolver ────────
{
  const defs = buildNarratorToolDefinitions();
  const dice = defs.find((d) => d.name === 'roll_dice');
  const check = defs.find((d) => d.name === 'roll_check');

  // roll_dice action returns a JSON string with structured fields.
  const diceOut = dice.action({ expression: '1d20' });
  assertEqual(typeof diceOut, 'string', 'roll_dice action returns a string');
  const diceParsed = JSON.parse(diceOut);
  assert(Array.isArray(diceParsed.rolls) && diceParsed.rolls.length === 1, 'roll_dice result has 1 roll');
  assertEqual(typeof diceParsed.total, 'number', 'roll_dice result has numeric total');

  // roll_check action (static, generic binary) returns a JSON string.
  const checkOut = check.action({ actorFormula: '1d20+2', dc: 10 });
  assertEqual(typeof checkOut, 'string', 'roll_check action returns a string');
  const checkParsed = JSON.parse(checkOut);
  assert(checkParsed.outcome === 'SUCCESS' || checkParsed.outcome === 'FAILURE', 'roll_check result has a binary outcome');

  // Invalid input is captured as a JSON error string, not a thrown exception.
  const badOut = dice.action({ expression: 'not-a-die' });
  assertEqual(typeof badOut, 'string', 'invalid input still returns a string');
  const badParsed = JSON.parse(badOut);
  assert(badParsed.error, 'invalid input is reported as { error } not a throw');
}

// ── registerNarratorFunctionTools: registers both tools via ST API ───────────
{
  const ctx = mockContext({ toolsSupported: true });
  const registered = registerNarratorFunctionTools(ctx);

  assertEqual(ctx.registered.length, 2, 'two tools registered with ST');
  assertEqual(registered.length, 2, 'register returns the two definitions');
  const names = ctx.registered.map((d) => d.name).sort();
  assertEqual(names, ['roll_check', 'roll_dice'], 'registered names correct');

  // shouldRegister reflects isToolCallingSupported.
  const dice = ctx.registered.find((d) => d.name === 'roll_dice');
  assertEqual(dice.shouldRegister(), true, 'shouldRegister true when supported');

  // action wired to dispatch path (roll_dice works through the bridge).
  const out = dice.action({ expression: '2d6' });
  const parsed = JSON.parse(out);
  assertEqual(parsed.rolls.length, 2, 'bridge roll_dice action produces 2 rolls');
}

// ── optionality: tools omitted when function calling unavailable ─────────────
{
  const ctxOff = mockContext({ toolsSupported: false });
  registerNarratorFunctionTools(ctxOff);

  // Tools are still registered, but shouldRegister() === false → ST omits them.
  const dice = ctxOff.registered.find((d) => d.name === 'roll_dice');
  assertEqual(dice.shouldRegister(), false, 'shouldRegister false when unsupported');
  const check = ctxOff.registered.find((d) => d.name === 'roll_check');
  assertEqual(check.shouldRegister(), false, 'roll_check shouldRegister false when unsupported');
}

// ── graceful degradation: no registerFunctionTool → no throw, empty result ───
{
  const tolerant = registerNarratorFunctionTools({}); // no registerFunctionTool
  assertEqual(tolerant, [], 'missing registerFunctionTool → empty array, no throw');

  const nullCtx = registerNarratorFunctionTools(null);
  assertEqual(nullCtx, [], 'null context → empty array, no throw');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log('\nFailures:'); failures.forEach((f) => console.log(f)); process.exit(1); }
console.log('All narrator bridge tests passed.');