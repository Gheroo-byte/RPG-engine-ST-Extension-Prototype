/**
 * RPG Engine - Narrator Tool Registration Bridge (SillyTavern-coupled)
 * ====================================================================
 * The thin glue that registers the narrator-facing tools (roll_dice, roll_check)
 * with SillyTavern's native function-calling system so the narrator LLM can
 * optionally invoke them during chat completion.
 *
 * This module intentionally contains NO dice logic and NO resolution logic. It:
 *   - pulls each tool's model-facing schema from the PURE ai-tools.js registry,
 *   - maps a tool's schema into SillyTavern's `registerFunctionTool` shape,
 *   - wires each tool's `action` to the ST-coupled `dispatchNarratorTool`.
 *
 * SillyTavern's native tool-call loop handles interception, execution, and the
 * continuation lifecycle; we do NOT build a custom second-pass loop and we do
 * NOT construct `generateRaw({ tools })` manually.
 *
 * OPTIONALITY
 * -----------
 * `shouldRegister()` returns `isToolCallingSupported()`, so when function
 * calling is unavailable (wrong API source, or the user hasn't enabled it), the
 * tools are simply not offered to the model. The narrator chooses whether to
 * call a tool; nothing here forces tool use on every response.
 */

import { NARRATOR_TOOLS } from './ai-tools.js';
import { dispatchNarratorTool } from './ai-store.js';

/**
 * Build a single SillyTavern function-tool definition from a pure tool entry.
 *
 * @param {object} tool  A pure tool: { name, description, parameters, execute }.
 * @returns {object} ST-ready definition (name, description, parameters with
 *                   $schema, action returns a JSON string, shouldRegister).
 */
function buildStToolDefinition(tool) {
  return {
    name: tool.name,
    displayName: tool.name,
    description: tool.description,
    parameters: {
      $schema: 'http://json-schema.org/draft-04/schema#',
      type: 'object',
      properties: tool.parameters?.properties ?? {},
      required: tool.parameters?.required ?? [],
    },
    // `action` is the ONE place ST hands us a tool call. It must return a
    // string. We delegate to the existing dispatch path and JSON-encode the
    // structured result so ST can feed it back to the model.
    action: (args) => {
      try {
        const result = dispatchNarratorTool(tool.name, args);
        return JSON.stringify(result);
      } catch (err) {
        return JSON.stringify({ error: err?.message ?? String(err) });
      }
    },
    // Only offer the tool when ST function calling is actually available.
    shouldRegister: () => true,
  };
}

/**
 * Register all narrator tools with SillyTavern's function-calling system.
 *
 * @param {object} [context] ST context (defaults to SillyTavern.getContext()).
 *                           Injectable for tests.
 * @returns {object[]} The array of registered tool definitions (for inspection).
 */
export function registerNarratorFunctionTools(context) {
  const ctx = context ?? (typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null);
  if (!ctx || typeof ctx.registerFunctionTool !== 'function') {
    // ST version doesn't expose function tools; degrade gracefully (no tools).
    return [];
  }

  const registered = [];
  for (const tool of Object.values(NARRATOR_TOOLS)) {
    const def = buildStToolDefinition(tool);

    // Wire optionality to ST's availability check when it exists.
    if (typeof ctx.isToolCallingSupported === 'function') {
      def.shouldRegister = () => ctx.isToolCallingSupported();
    }

    ctx.registerFunctionTool(def);
    registered.push(def);
  }
  return registered;
}

/**
 * Build the ST tool definitions WITHOUT registering them (for tests and for any
 * host that needs to inspect/merge tool schemas explicitly).
 *
 * @returns {object[]} ST-ready tool definitions (same shape as registerX).
 */
export function buildNarratorToolDefinitions() {
  return Object.values(NARRATOR_TOOLS).map(buildStToolDefinition);
}