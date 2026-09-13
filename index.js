/**
 * RPG Engine - Extension Entry Point
 * ====================================
 * Registration pattern verified against official docs.ST.app documentation
 * (SillyTavern.getContext() + renderExtensionTemplateAsync + append to
 * #extensions_settings2) - not guessed.
 *
 * DATA MODEL (schemaVersion 1):
 *   Settings persist via extensionSettings[MODULE_NAME] using the verified
 *   extensionSettings + saveSettingsDebounced() pattern.
 *
 *   schemaVersion: 1
 *   rulesets:        { [rulesetId]: { id, displayName, base: {statName: def},
 *                      derived: { valueName: {formula} } } }   (see rulesets.js)
 *   activeRuleset:   rulesetId of the currently active system
 *   characters:      [{ id, name, ruleset, base: { statName: {value, potential?} },
 *                       resources: {}, effects: [] }]
 *   selectedCharacterId: id of the character shown in the Formula Tester
 *
 *   A base stat is ALWAYS a structured object: { value, potential? }.
 *   D&D/Kaelrath simply omit `potential`. Derived values are lazy-computed
 *   from the active ruleset and current character data (never persisted here).
 *   Cap enforcement is NOT implemented yet; the schema carries the data needed
 *   to validate later once progression/effects are designed.
 *
 * SCOPE OF THIS STEP (schema/data layer only):
 *   - characters/rulesets persistable per the schema above
 *   - derived values resolved lazily by the active ruleset
 *   - existing prototype UI code paths updated ONLY to read/write this schema
 *   - no new UI, no progression, no effects, no combat integration
 *
 * The modular statistics logic now lives in stats.js (pure, host-independent).
 * index.js keeps only SillyTavern-specific concerns (ruleset lookup from
 * persisted settings, UI, events) and delegates derived/effective-stat
 * resolution to the stats layer.
 *
 * AI SERVICE LAYER (read-only first slice):
 *   The AI Service layer is split exactly like the stats layer:
 *     - ai-core.js  = pure models (slots, permissions, action vocabulary, proposal
 *                     validation). No ST, no DOM, no mutation.
 *     - ai-store.js = ST-coupled (persist slots, resolve connection, dispatch via
 *                     ST-native AI infra).
 *   index.js is the ONLY place that runs a slot and renders its text. The first
 *   slice is strictly READ-ONLY: the AI receives a snapshot copy of engine state
 *   and returns text. It never receives mutation functions and never mutates
 *   state. The engine (engine-core.js + stats.js) remains authoritative.
 *
 * PRESERVED UNCHANGED:
 *   - engine-core.js (the pure formula/dice/check engine)
 *   - stats.js (the pure statistics layer)
 *   - rulesets.js (the ruleset definitions)
 *   - the persistence mechanism (getSettings/saveSettings + backfill)
 */

import { evaluateFormula, EngineError, DiceRoller } from './engine-core.js';
import { RULESETS, SCHEMA_VERSION } from './rulesets.js';
import { getEffectiveStats, getStatCap, getBaseStatNames } from './stats.js';
import { getSlots, getSlot, dispatchSlot } from './ai-store.js';
import { parseProposals } from './ai-core.js';
import { registerNarratorFunctionTools } from './narrator-tools-st.js';

const MODULE_NAME = 'rpg-engine';

// Path to this extension's template folder, relative to how SillyTavern serves
// user extensions. This extension is installed through SillyTavern's native
// user-extension installer, which places it in
//   data/<user>/extensions/<folder>/   (served at /extensions/<folder>/)
// so renderExtensionTemplateAsync must be given the PLAIN folder name, NOT a
// "third-party/..." path. The "third-party/" prefix is only used for legacy
// bundled extensions that live under public/scripts/extensions/third-party/;
// using it here made ST request the (nonexistent) bundled path, causing a 404.
//
// The folder name below must match the installed user-extension folder, which
// the native installer derives from the repository name.
const EXTENSION_FOLDER = 'third-party/RPG-engine-ST-Extension-Prototype';

// =============================================================================
// DEFAULT SETTINGS (schema template)
// =============================================================================
// NOTE: defaultSettings is only a *template*, frozen at the top level so nothing
// mutates it by accident. Every value is cloned out of it via deepClone() -
// never shared by reference - so nested objects can never be aliased across
// callers. RULESETS is imported fresh from rulesets.js as the default data.

const defaultSettings = Object.freeze({
  enabled: true,
  schemaVersion: SCHEMA_VERSION,
  // rulesets: { [rulesetId]: { id, displayName, base, derived } } (rulesets.js)
  rulesets: RULESETS,
  // activeRuleset: id of the currently selected system. D&D 5e is the default
  // world for a fresh configuration; existing persisted settings are untouched.
  activeRuleset: 'dnd',
  // characters: [{ id, name, ruleset, base: {statName: {value, potential?}},
  //                resources: {}, effects: [] }]
  characters: [],
  // selectedCharacterId: id of the character shown in the Formula Tester
  selectedCharacterId: null,
  // customDice: { "d60": 60, ... } — persisted declaration of custom dice a
  // world has registered (name -> sides). Standard dice are always available.
  customDice: {},
  // aiSlots: seeded lazily by ai-store.js (getSlots). Kept out of the frozen
  // template so ai-store remains the single source of truth for slot defaults.
});

/** Deep clone helper (safe for plain data: no functions/Dates involved). */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Gets (and lazily initializes) this extension's persistent settings object.
 * Each default key is backfilled with its own deep clone if missing - a single
 * mechanism that handles BOTH first-time initialization and upgrading older
 * saves that lack newly-added keys, without sharing references to the frozen
 * template. Stale old keys (e.g. the previous worldProfiles shape) are left in
 * place untouched - no destructive migration on this step.
 */
function getSettings() {
  const { extensionSettings } = SillyTavern.getContext();
  if (!extensionSettings[MODULE_NAME] || typeof extensionSettings[MODULE_NAME] !== 'object') {
    extensionSettings[MODULE_NAME] = {};
  }
  for (const [key, value] of Object.entries(defaultSettings)) {
    if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
      extensionSettings[MODULE_NAME][key] = deepClone(value);
    }
  }
  return extensionSettings[MODULE_NAME];
}

/** Save settings (debounced). */
function saveSettings() {
  const { saveSettingsDebounced } = SillyTavern.getContext();
  saveSettingsDebounced();
}

/** Generate a simple unique ID. */
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}

/** Escape HTML for safe insertion. */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// =============================================================================
// RULESET / STAT HELPERS (data layer)
// =============================================================================

/** Look up a ruleset definition by id from persisted settings. */
function getRuleSet(id) {
  const settings = getSettings();
  return settings.rulesets?.[id] ?? null;
}

/** Get the currently active ruleset, resolving to the rulesets map. */
function getActiveRuleSet() {
  const settings = getSettings();
  return settings.rulesets?.[settings.activeRuleset] ?? null;
}

/** Resolve a character's effective stats via the pure statistics layer. */
function getCharacterEffectiveStats(character) {
  const ruleset = getRuleSet(character?.ruleset);
  if (!ruleset) {
    // No ruleset -> just base values, no derived resolution.
    const numbers = {};
    for (const [name, def] of Object.entries(character?.base ?? {})) {
      numbers[name] = Number(typeof def === 'object' ? def.value : def) || 0;
    }
    return numbers;
  }
  return getEffectiveStats(character, ruleset);
}

/** Get a character by ID. */
function getCharacterById(id) {
  const settings = getSettings();
  return settings.characters.find((c) => c.id === id);
}

/** Get the currently selected character (for the Formula Tester). */
function getSelectedCharacter() {
  const settings = getSettings();
  if (!settings.selectedCharacterId) return null;
  return getCharacterById(settings.selectedCharacterId);
}

/** Stats source for the Formula Tester: selected character or demo fallback. */
function getFormulaTesterStats() {
  const char = getSelectedCharacter();
  if (char) {
    return getCharacterEffectiveStats(char);
  }
  return {
    STR: 20, DEX: 52, CON: 24, CHA: 8, INT: 34, BLS: 30, LCK: 14,
    Strength: 32, Agility: 36, Endurance: 24, Intelligence: 34, Perception: 18, Willpower: 20, Charisma: 8,
  };
}

// =============================================================================
// AI SLOTS DRAWER (read-only first slice)
// =============================================================================

/**
 * Build a READ-ONLY snapshot of engine state for an AI request. This is a deep
 * clone (JSON roundtrip) so the AI layer, however badly behaved, cannot reach
 * back into live engine objects. It contains only plain data; no functions.
 */
function buildAiSnapshot() {
  const settings = getSettings();
  const activeRuleset = getActiveRuleSet();
  const rulesetSummary = activeRuleset
    ? {
        id: activeRuleset.id,
        displayName: activeRuleset.displayName,
        base: Object.keys(activeRuleset.base ?? {}),
        derived: Object.keys(activeRuleset.derived ?? {}),
      }
    : null;

  const characters = (settings.characters ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    ruleset: c.ruleset,
    effectiveStats: getCharacterEffectiveStats(c),
  }));

  // JSON roundtrip: guarantees a plain, detached, JSON-safe copy.
  return JSON.parse(JSON.stringify({
    schemaVersion: settings.schemaVersion,
    activeRuleset: settings.activeRuleset,
    rulesetSummary,
    characters,
    selectedCharacterId: settings.selectedCharacterId,
  }));
}

/**
 * Resolve the slot config and run one read-only Ruleset Assistant request:
 * snapshot → dispatch → display the raw text. This is the single shared
 * execution path used by BOTH the legacy AI Slots drawer and the modern
 * AI Assistant tab. No mutation happens here.
 *
 * @param {string} slotId      The AI slot id (e.g. 'slot-ruleset-assistant').
 * @param {HTMLElement|null} outputEl  Element to write the final text/error into.
 * @param {(status:string)=>void} [onStatus] Called with a working status ("contacting...") if provided.
 */
async function runRulesetAssistant(slotId, outputEl, onStatus) {
  const settings = getSettings();
  const slot = getSlot(settings, slotId);
  if (!slot) {
    console.warn(`[${MODULE_NAME}] AI slot "${slotId}" not found.`);
    return null;
  }
  if (!slot.enabled) return null;
  if (slot.permission !== 'read-only') {
    // First slice: only read-only slots are runnable. This is a hard gate.
    console.warn(`[${MODULE_NAME}] Slot "${slot.id}" is not read-only; not runnable in this slice.`);
    return null;
  }

  if (typeof onStatus === 'function') onStatus('contacting');
  if (outputEl) outputEl.textContent = '// contacting AI...';

  try {
    const snapshot = buildAiSnapshot();
    const request = {
      systemPrompt:
        'You are a ruleset/rules assistant for a tabletop RPG engine. ' +
        'Explain the provided game state clearly and precisely. ' +
        'You are strictly READ-ONLY: you may inspect and explain, but you ' +
        'must never propose or perform any change to game state. Return plain text.',
      userPrompt:
        'Here is the current game state (read-only snapshot):\n' +
        JSON.stringify(snapshot, null, 2) +
        '\n\nExplain the active ruleset and current character stats in plain language.',
    };

    const text = await dispatchSlot(slot, request, {});
    // Read-only slots must yield no proposals; this is a defense in depth.
    const proposals = parseProposals(text, slot);
    if (proposals.length > 0) {
      console.warn(`[${MODULE_NAME}] Read-only slot produced proposals; ignoring them.`, proposals);
    }

    const out = text || '(no response)';
    if (outputEl) outputEl.textContent = out;
    return out;
  } catch (err) {
    console.error(`[${MODULE_NAME}] AI slot run failed:`, err);
    const msg = `// error: ${err?.message || err}`;
    if (outputEl) outputEl.textContent = msg;
    return msg;
  }
}

// =============================================================================
// WAND ENTRY + POPUP (four-tab control center)
// =============================================================================
// The popup is a separate template from settings.html and uses distinct
// `rpg-popup-*` IDs so it never collides with the legacy settings panel,
// which remains fully functional. These popup-specific functions reuse the
// shared engine/settings helpers but do NOT call the legacy `wire*`/`render*`
// Drawer functions (those target settings.html IDs).

/**
 * Append an "RPG Engine" entry into SillyTavern's Wand/Extensions menu
 * (#extensionsMenu). This is the verified third-party pattern (see Memory
 * Books): a plain DOM append into the global menu element, retried until the
 * menu exists.
 */
function createWandEntry() {
  const menu = document.getElementById('extensionsMenu');
  if (!menu) {
    setTimeout(createWandEntry, 500);
    return;
  }
  if (document.getElementById('rpg-menu-item-container')) return;

  menu.insertAdjacentHTML('beforeend', `
    <div id="rpg-menu-item-container" class="extension_container interactable" tabindex="0">
      <div id="rpg-menu-item" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
        <div class="fa-fw fa-solid fa-dice-d20 extensionsMenuExtensionButton"></div>
        <span>RPG Engine</span>
      </div>
    </div>
  `);
}

/** Toggle tab visibility + active styling within the popup root. */
function popupSwitchTab(root, tabName) {
  root.querySelectorAll('.rpg-tab').forEach((t) => {
    t.classList.toggle('rpg-tab-active', t.dataset.tab === tabName);
  });
  root.querySelectorAll('.rpg-tab-panel').forEach((p) => {
    p.classList.toggle('rpg-tab-panel-active', p.dataset.panel === tabName);
  });
}

/** Wire the popup tab bar (popup-scoped). */
function popupWireTabs(root) {
  root.querySelectorAll('.rpg-tab').forEach((tab) => {
    tab.addEventListener('click', () => popupSwitchTab(root, tab.dataset.tab));
  });
}

/** Wire the popup's collapsible drawers (popup-scoped). */
function popupWireDrawers(root) {
  root.querySelectorAll('.rpg-drawer').forEach((drawer) => {
    const toggle = drawer.querySelector('.rpg-drawer-toggle');
    if (!toggle) return;
    toggle.addEventListener('click', () => drawer.classList.toggle('open'));
  });
}

/** Render the popup "Current World" overview from real persisted state. */
function popupRenderWorldOverview(root) {
  const overview = root.querySelector('#rpg-popup-world-overview');
  if (!overview) return;

  const settings = getSettings();
  const ruleset = getActiveRuleSet();

  if (!ruleset) {
    overview.innerHTML = `
      <div class="rpg-world-card">
        <div class="rpg-world-name">No World Selected</div>
        <div class="rpg-world-id">Start a world to begin tracking stats and dice.</div>
        <div class="rpg-world-facts">
          <span class="rpg-world-fact">No active ruleset</span>
        </div>
      </div>
    `;
    return;
  }

  const baseNames = getBaseStatNames(ruleset);
  const derivedNames = Object.keys(ruleset.derived ?? {});
  const customDice = Object.keys(settings.customDice ?? {});
  const charCount = (settings.characters ?? []).filter((c) => c.ruleset === ruleset.id).length;

  overview.innerHTML = `
    <div class="rpg-world-card">
      <div class="rpg-world-name">${escapeHtml(ruleset.displayName || ruleset.id)}</div>
      <div class="rpg-world-id">${escapeHtml(ruleset.id)}</div>
      <div class="rpg-world-facts">
        <span class="rpg-world-fact">${baseNames.length} base stats</span>
        <span class="rpg-world-fact">${derivedNames.length} derived stats</span>
        <span class="rpg-world-fact">${customDice.length} custom dice</span>
        <span class="rpg-world-fact">${charCount} characters</span>
      </div>
    </div>
    <div class="rpg-world-card">
      <div class="rpg-world-name" style="font-size:0.95em;">Base Stats</div>
      <div class="rpg-world-facts">
        ${baseNames.length ? baseNames.map((n) => `<span class="rpg-world-fact">${escapeHtml(n)}</span>`).join('') : '<span class="rpg-world-fact">none</span>'}
      </div>
    </div>
    <div class="rpg-world-card">
      <div class="rpg-world-name" style="font-size:0.95em;">Derived Stats</div>
      <div class="rpg-world-facts">
        ${derivedNames.length ? derivedNames.map((n) => `<span class="rpg-world-fact">${escapeHtml(n)}</span>`).join('') : '<span class="rpg-world-fact">none</span>'}
      </div>
    </div>
  `;
}

/** Render the popup connection status (popup-scoped). */
function popupRenderConnectionStatus(root) {
  const statusEl = root.querySelector('#rpg-popup-connection-status');
  if (!statusEl) return;
  try {
    const context = SillyTavern.getContext();
    const chatId = context.chatId ?? '(no active chat)';
    const characterName = context.characters?.[context.characterId]?.name ?? '(no character loaded)';
    statusEl.innerHTML = `
      <span class="rpg-status-ok">● Connected</span>
      <span class="rpg-status-detail">Character: ${escapeHtml(characterName)}</span>
      <span class="rpg-status-detail">Chat ID: ${escapeHtml(String(chatId))}</span>
    `;
  } catch (err) {
    statusEl.innerHTML = `<span class="rpg-status-error">● Connection error</span><span class="rpg-status-detail">${escapeHtml(err.message || String(err))}</span>`;
  }
}

/** Render the popup master-toggle state (popup-scoped). */
function popupWireMasterToggle(root) {
  const toggle = root.querySelector('#rpg-popup-master-toggle');
  if (!toggle) return;
  const settings = getSettings();
  toggle.checked = settings.enabled;
  toggle.addEventListener('change', () => {
    settings.enabled = toggle.checked;
    saveSettings();
  });
}

/** Render the popup ruleset selector (popup-scoped). */
function popupRenderWorldSelector(root) {
  const select = root.querySelector('#rpg-popup-world-profile-select');
  const summary = root.querySelector('#rpg-popup-world-summary');
  if (!select) return;

  const settings = getSettings();
  const options = Object.values(settings.rulesets || {})
    .map((r) => `<option value="${escapeHtml(r.id)}" ${r.id === settings.activeRuleset ? 'selected' : ''}>${escapeHtml(r.displayName)}</option>`)
    .join('');
  select.innerHTML = options;
  select.disabled = false;
  if (summary) {
    const active = getActiveRuleSet();
    summary.textContent = active ? active.displayName : 'No profile loaded';
  }
}

/** Wire the popup ruleset selector change (popup-scoped). */
function popupWireWorldSelector(root) {
  const select = root.querySelector('#rpg-popup-world-profile-select');
  if (!select) return;
  select.addEventListener('change', () => {
    const settings = getSettings();
    settings.activeRuleset = select.value;
    saveSettings();
    popupRenderWorldSelector(root);
    popupRenderWorldOverview(root);
    popupRenderStatsList(root);
    popupRenderDerivedList(root);
    popupRenderCharactersList(root);
  });
}

/** Render the popup stats list (popup-scoped). */
function popupRenderStatsList(root) {
  const listEl = root.querySelector('#rpg-popup-stats-list');
  const summaryEl = root.querySelector('#rpg-popup-stats-summary');
  if (!listEl) return;

  const ruleset = getActiveRuleSet();
  const statNames = getBaseStatNames(ruleset);
  if (summaryEl) summaryEl.textContent = `${statNames.length} stats defined`;

  if (!ruleset || statNames.length === 0) {
    listEl.innerHTML = '<div class="rpg-empty-state">No stats defined.</div>';
    return;
  }

  listEl.innerHTML = statNames.map((name) => `
    <div class="rpg-stat-def-item" data-name="${escapeHtml(name)}">
      <span class="rpg-stat-name">${escapeHtml(name)}</span>
      <div class="rpg-button-row" style="margin-top: 4px;">
        <button class="rpg-btn rpg-btn-small rpg-popup-stat-rename" data-stat="${escapeHtml(name)}">Rename</button>
        <button class="rpg-btn rpg-btn-small rpg-btn-danger rpg-popup-stat-delete" data-stat="${escapeHtml(name)}">Delete</button>
      </div>
    </div>
  `).join('');

  listEl.querySelectorAll('.rpg-popup-stat-rename').forEach((btn) => {
    btn.addEventListener('click', () => popupRenameStat(root, btn.dataset.stat));
  });
  listEl.querySelectorAll('.rpg-popup-stat-delete').forEach((btn) => {
    btn.addEventListener('click', () => popupDeleteStat(root, btn.dataset.stat));
  });
}

/** Render the popup derived-stats list (popup-scoped, read-only). */
function popupRenderDerivedList(root) {
  const listEl = root.querySelector('#rpg-popup-derived-list');
  const summaryEl = root.querySelector('#rpg-popup-derived-summary');
  if (!listEl) return;

  const ruleset = getActiveRuleSet();
  const derived = Object.keys(ruleset?.derived ?? {});
  if (summaryEl) summaryEl.textContent = `${derived.length} derived stats`;

  if (derived.length === 0) {
    listEl.innerHTML = '<div class="rpg-empty-state">No derived stats defined.</div>';
    return;
  }

  listEl.innerHTML = derived.map((name) => `
    <div class="rpg-stat-def-item">
      <span class="rpg-dice-name">${escapeHtml(name)}</span>
      <div class="rpg-placeholder-note">formula: ${escapeHtml(ruleset.derived[name].formula)}</div>
    </div>
  `).join('');
}

/** Add a base stat to the active ruleset (popup-scoped). */
function popupAddStat(root) {
  const ruleset = getActiveRuleSet();
  if (!ruleset) return;
  let name = 'NewStat';
  let i = 1;
  while (Object.hasOwn(ruleset.base, name)) name = `NewStat${i++}`;
  ruleset.base[name] = {};
  saveSettings();
  popupRenderStatsList(root);
  popupRenderWorldOverview(root);
}

/** Rename a base stat (popup-scoped). */
function popupRenameStat(root, oldName) {
  const settings = getSettings();
  const ruleset = getActiveRuleSet();
  if (!ruleset?.base || !Object.hasOwn(ruleset.base, oldName)) return;
  const newName = prompt(`Rename "${oldName}" to:`, oldName);
  if (!newName || newName.trim() === '' || newName === oldName) return;
  const trimmed = newName.trim();
  if (Object.hasOwn(ruleset.base, trimmed)) { alert('A stat with that name already exists.'); return; }
  ruleset.base[trimmed] = ruleset.base[oldName];
  delete ruleset.base[oldName];
  settings.characters.forEach((char) => {
    if (char.ruleset === settings.activeRuleset && char.base && Object.hasOwn(char.base, oldName)) {
      char.base[trimmed] = char.base[oldName];
      delete char.base[oldName];
    }
  });
  saveSettings();
  popupRenderStatsList(root);
  popupRenderCharactersList(root);
  popupRenderWorldOverview(root);
}

/** Delete a base stat (popup-scoped). */
function popupDeleteStat(root, statName) {
  const settings = getSettings();
  const ruleset = getActiveRuleSet();
  if (!ruleset?.base || !Object.hasOwn(ruleset.base, statName)) return;
  if (!confirm(`Delete stat "${statName}"? This will remove it from all characters in this ruleset.`)) return;
  delete ruleset.base[statName];
  settings.characters.forEach((char) => {
    if (char.ruleset === settings.activeRuleset && char.base) delete char.base[statName];
  });
  saveSettings();
  popupRenderStatsList(root);
  popupRenderCharactersList(root);
  popupRenderWorldOverview(root);
}

/** Wire the popup stats add button (popup-scoped). */
function popupWireStats(root) {
  const addBtn = root.querySelector('#rpg-popup-stats-add');
  if (addBtn) {
    addBtn.disabled = false;
    addBtn.addEventListener('click', () => popupAddStat(root));
  }
}

/** Render the popup custom dice list (popup-scoped; preserves d60 registration). */
function popupRenderCustomDiceList(root) {
  const listEl = root.querySelector('#rpg-popup-custom-dice-list');
  if (!listEl) return;
  const settings = getSettings();
  const entries = Object.entries(settings.customDice || {});
  if (entries.length === 0) {
    listEl.innerHTML = '<div class="rpg-empty-state">No custom dice registered.</div>';
    return;
  }
  listEl.innerHTML = entries.map(([name, sides]) => `
    <div class="rpg-dice-item" data-name="${escapeHtml(name)}">
      <span class="rpg-dice-name">${escapeHtml(name)}</span>
      <span class="rpg-dice-sides">d${sides}</span>
    </div>
  `).join('');
}

/** Wire the popup custom die registration (popup-scoped; mirrors e7c6acf). */
function popupWireDice(root) {
  const input = root.querySelector('#rpg-popup-custom-die-name');
  const button = root.querySelector('#rpg-popup-dice-add-custom');
  if (!input || !button) return;

  input.disabled = false;
  button.disabled = false;
  popupRenderCustomDiceList(root);

  const register = () => {
    const raw = input.value.trim();
    const match = raw.match(/^d(\d+)$/i);
    if (!match) {
      input.setCustomValidity('Enter a die name like "d60" (d followed by digits).');
      input.reportValidity();
      return;
    }
    const sides = parseInt(match[1], 10);
    if (!Number.isInteger(sides) || sides < 1) {
      input.setCustomValidity('Die sides must be a positive whole number (d0 is invalid).');
      input.reportValidity();
      return;
    }
    input.setCustomValidity('');
    const settings = getSettings();
    if (!settings.customDice) settings.customDice = {};
    settings.customDice[`d${sides}`] = sides;
    saveSettings();
    input.value = '';
    popupRenderCustomDiceList(root);
  };

  button.addEventListener('click', register);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') register(); });
}

/** Render the popup characters list (popup-scoped). */
function popupRenderCharactersList(root) {
  const listEl = root.querySelector('#rpg-popup-character-list');
  const summaryEl = root.querySelector('#rpg-popup-characters-summary');
  if (!listEl) return;

  const settings = getSettings();
  const characters = settings.characters;
  if (summaryEl) summaryEl.textContent = characters.length === 1 ? '1 character' : `${characters.length} characters`;

  if (characters.length === 0) {
    listEl.innerHTML = '<div class="rpg-empty-state">No characters tracked yet.</div>';
    return;
  }

  listEl.innerHTML = characters.map((char) => {
    const statChips = Object.entries(char.base || {}).map(([k, def]) => {
      const v = def && typeof def === 'object' ? def.value ?? def : def;
      return `<span class="rpg-stat-chip">${escapeHtml(k)}: ${v}</span>`;
    }).join('');
    return `
      <div class="rpg-character-item" data-id="${escapeHtml(char.id)}">
        <div class="rpg-character-header">
          <span class="rpg-character-name">${escapeHtml(char.name)}</span>
          <span class="rpg-character-world">${escapeHtml(getRuleSet(char.ruleset)?.displayName || char.ruleset)}</span>
        </div>
        <div class="rpg-character-stats-preview">${statChips}</div>
        <div class="rpg-character-actions">
          <button class="rpg-btn rpg-btn-small rpg-popup-char-edit" data-id="${escapeHtml(char.id)}">Edit</button>
          <button class="rpg-btn rpg-btn-small rpg-btn-danger rpg-popup-char-delete" data-id="${escapeHtml(char.id)}">Delete</button>
        </div>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('.rpg-popup-char-edit').forEach((btn) => {
    btn.addEventListener('click', () => popupOpenCharacterEditor(root, btn.dataset.id));
  });
  listEl.querySelectorAll('.rpg-popup-char-delete').forEach((btn) => {
    btn.addEventListener('click', () => popupDeleteCharacter(root, btn.dataset.id));
  });
}

/** Add a character (popup-scoped; keeps settings panel untouched). */
function popupOpenCharacterEditor(root, id) {
  const char = getCharacterById(id);
  const isNew = !char;
  const editorRuleSet = (char?.ruleset && getRuleSet(char.ruleset)) || getActiveRuleSet();
  const statNames = getBaseStatNames(editorRuleSet);
  const statsHtml = statNames.map((name) => {
    const value = char?.base?.[name]?.value ?? 0;
    return `
      <div class="rpg-stat-input-row">
        <label>${escapeHtml(name)}</label>
        <input type="number" class="rpg-input-full rpg-stat-value" data-stat="${escapeHtml(name)}" value="${value}" step="1">
      </div>
    `;
  }).join('');

  const settings = getSettings();
  const worldSelectValue = char?.ruleset ?? settings.activeRuleset;
  const rulesetOptions = Object.values(settings.rulesets || {})
    .map((r) => `<option value="${escapeHtml(r.id)}" ${r.id === worldSelectValue ? 'selected' : ''}>${escapeHtml(r.displayName)}</option>`)
    .join('');

  const modalHtml = `
    <div id="rpg-popup-char-modal" class="rpg-modal-overlay">
      <div class="rpg-modal">
        <h3>${isNew ? 'Add Character' : 'Edit Character'}</h3>
        <div class="rpg-form-group"><label for="rpg-popup-char-name">Name</label>
          <input type="text" id="rpg-popup-char-name" class="rpg-input-full" value="${escapeHtml(char?.name || '')}" placeholder="Character name"></div>
        <div class="rpg-form-group"><label for="rpg-popup-char-world">Ruleset</label>
          <select id="rpg-popup-char-world" class="rpg-input-full" ${!isNew ? 'disabled' : ''}>${rulesetOptions}</select></div>
        <div class="rpg-form-group"><label>Stats</label><div id="rpg-popup-char-stats-inputs">${statsHtml}</div></div>
        <div class="rpg-button-row">
          <button id="rpg-popup-char-save" class="rpg-btn">${isNew ? 'Add' : 'Save'}</button>
          <button id="rpg-popup-char-cancel" class="rpg-btn">Cancel</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHtml);

  const modal = document.getElementById('rpg-popup-char-modal');
  const saveBtn = document.getElementById('rpg-popup-char-save');
  const cancelBtn = document.getElementById('rpg-popup-char-cancel');
  const nameInput = document.getElementById('rpg-popup-char-name');
  const worldSelect = document.getElementById('rpg-popup-char-world');
  const closeModal = () => modal.remove();

  saveBtn.addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) { alert('Name is required'); return; }
    const s = getSettings();
    if (isNew) {
      const base = {};
      modal.querySelectorAll('.rpg-stat-value').forEach((inp) => { base[inp.dataset.stat] = { value: parseFloat(inp.value) || 0 }; });
      s.characters.push({ id: generateId(), name, ruleset: worldSelect.value, base, resources: {}, effects: [] });
    } else {
      char.name = name;
      if (!char.base) char.base = {};
      modal.querySelectorAll('.rpg-stat-value').forEach((inp) => {
        const sn = inp.dataset.stat;
        if (!char.base[sn]) char.base[sn] = { value: 0 };
        char.base[sn].value = parseFloat(inp.value) || 0;
      });
    }
    saveSettings();
    popupRenderCharactersList(root);
    popupRenderWorldOverview(root);
    closeModal();
  });

  cancelBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveBtn.click(); });
}

/** Delete a character (popup-scoped). */
function popupDeleteCharacter(root, id) {
  if (!confirm('Delete this character? This cannot be undone.')) return;
  const settings = getSettings();
  settings.characters = settings.characters.filter((c) => c.id !== id);
  if (settings.selectedCharacterId === id) settings.selectedCharacterId = settings.characters[0]?.id || null;
  saveSettings();
  popupRenderCharactersList(root);
  popupRenderWorldOverview(root);
}

/** Wire the popup characters add button (popup-scoped). */
function popupWireCharacters(root) {
  const addBtn = root.querySelector('#rpg-popup-char-add');
  if (addBtn) {
    addBtn.disabled = false;
    addBtn.addEventListener('click', () => popupOpenCharacterEditor(root, null));
  }
}

/** Render the popup formula-tester preview (popup-scoped). */
function popupRenderFormulaPreview(root) {
  const previewEl = root.querySelector('#rpg-popup-formula-test-stats-preview');
  if (!previewEl) return;
  const stats = getFormulaTesterStats();
  const entries = Object.entries(stats);
  if (entries.length === 0) {
    previewEl.innerHTML = '<span class="rpg-empty-state">No stats available</span>';
    return;
  }
  previewEl.innerHTML = entries.map(([k, v]) => `<span class="rpg-stat-chip">${escapeHtml(k)}: ${v}</span>`).join('');
}

/** Wire the popup formula tester (popup-scoped; reuses DiceRoller/evaluateFormula). */
function popupWireFormulaTester(root) {
  const input = root.querySelector('#rpg-popup-formula-test-input');
  const button = root.querySelector('#rpg-popup-formula-test-run');
  const output = root.querySelector('#rpg-popup-formula-test-output');
  if (!input || !button || !output) return;

  input.disabled = false;
  button.disabled = false;
  popupRenderFormulaPreview(root);

  const runTest = () => {
    const formula = input.value.trim();
    if (!formula) { output.textContent = '// enter a formula above, e.g. d60 + INT + 0.5*BLS'; return; }
    try {
      const stats = getFormulaTesterStats();
      const diceRoller = new DiceRoller(getSettings().customDice || {});
      const { total, breakdown } = evaluateFormula(formula, stats, diceRoller);
      const lines = breakdown.map((b) => {
        const sign = typeof b.value === 'number' && b.value >= 0 ? '+' : '';
        return `${b.label}: ${sign}${b.value}`;
      });
      lines.push(`Total: ${total}`);
      output.textContent = lines.join('\n');
    } catch (err) {
      output.textContent = `Error: ${err?.message || String(err)}`;
    }
  };

  button.addEventListener('click', runTest);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') runTest(); });
}

/**
 * Wire the AI Assistant tab (popup-scoped). Reuses the shared
 * runRulesetAssistant() execution path instead of duplicating the legacy
 * Ruleset Assistant request logic. The Ruleset Assistant is run with the
 * dedicated slot id 'slot-ruleset-assistant'.
 */
function popupWireAiAssistant(root) {
  const input = root.querySelector('#rpg-popup-assistant-input');
  const sendBtn = root.querySelector('#rpg-popup-assistant-send');
  const output = root.querySelector('#rpg-popup-assistant-output');
  const status = root.querySelector('#rpg-popup-assistant-status');
  if (!input || !sendBtn || !output) return;

  input.disabled = false;
  sendBtn.disabled = false;
  if (status) status.textContent = 'Ready (read-only)';

  const run = async () => {
    const userText = input.value.trim();
    if (!userText) return;
    input.disabled = true;
    sendBtn.disabled = true;
    if (status) status.textContent = 'Contacting AI…';
    output.textContent = '// contacting AI...';
    try {
      await runRulesetAssistant('slot-ruleset-assistant', output, (s) => {
        if (status && s === 'contacting') status.textContent = 'Contacting AI…';
      });
    } finally {
      input.disabled = false;
      sendBtn.disabled = false;
      if (status) status.textContent = 'Ready (read-only)';
    }
  };

  sendBtn.addEventListener('click', run);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
}

/**
 * Open the four-tab RPG Engine popup. Renders popup.html into a SillyTavern
 * Popup (TEXT type, large/wide/vertical-scrolling), then wires the popup-scoped
 * tabs, drawers, and read-through/writes against the popup DOM only.
 */
async function openRpgPopup() {
  const context = SillyTavern.getContext();
  const html = await context.renderExtensionTemplateAsync(EXTENSION_FOLDER, 'popup', {});
  const content = $('<div></div>').append(html);

  const popup = new context.Popup(content, context.POPUP_TYPE.TEXT, '', {
    wide: true,
    large: true,
    allowVerticalScrolling: true,
    okButton: false,
    cancelButton: 'Close',
  });

  const root = popup.content;

  // Wire and render everything BEFORE showing: SillyTavern's Popup.show()
  // resolves only when the popup closes, so doing this after the await would
  // run against an already-dismissed dialog.
  popupWireTabs(root);
  popupWireDrawers(root);
  popupWireMasterToggle(root);
  popupWireWorldSelector(root);
  popupWireStats(root);
  popupWireDice(root);
  popupWireCharacters(root);
  popupWireFormulaTester(root);
  popupWireAiAssistant(root);

  popupRenderWorldOverview(root);
  popupRenderConnectionStatus(root);
  popupRenderWorldSelector(root);
  popupRenderStatsList(root);
  popupRenderDerivedList(root);
  popupRenderCustomDiceList(root);
  popupRenderCharactersList(root);

  await popup.show();
}

// =============================================================================
// INITIALIZATION
// =============================================================================

async function init() {
  console.log(`[${MODULE_NAME}] Initializing...`);

  try {
    // Register narrator function tools (roll_dice / roll_check) with ST's
    // native function-calling system. Optional: the narrator chooses to call.
    registerNarratorFunctionTools();

    // Register the Wand menu entry and bind it to open the popup control center.
    createWandEntry();
    $(document).on('click', '#rpg-menu-item', openRpgPopup);

    console.log(`[${MODULE_NAME}] Loaded successfully.`);
  } catch (err) {
    console.error(`[${MODULE_NAME}] FAILED TO LOAD:`, err);
  }
}

jQuery(async () => {
  init();
});