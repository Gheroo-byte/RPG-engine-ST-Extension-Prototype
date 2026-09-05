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
 * PRESERVED UNCHANGED:
 *   - engine-core.js (the pure formula/dice/check engine)
 *   - the persistence mechanism (getSettings/saveSettings + backfill)
 */

import { evaluateFormula, EngineError, DiceRoller } from './engine-core.js';
import { RULESETS, SCHEMA_VERSION } from './rulesets.js';

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
  // activeRuleset: id of the currently selected system
  activeRuleset: 'kaelrath',
  // characters: [{ id, name, ruleset, base: {statName: {value, potential?}},
  //                resources: {}, effects: [] }]
  characters: [],
  // selectedCharacterId: id of the character shown in the Formula Tester
  selectedCharacterId: null,
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

/** Get a ruleset definition by id. */
function getRuleSet(id) {
  return getSettings().rulesets?.[id] ?? null;
}

/** Get the currently active ruleset. */
function getActiveRuleSet() {
  const settings = getSettings();
  return settings.rulesets?.[settings.activeRuleset] ?? null;
}

/** Get the base stat names declared by a ruleset, in order. */
function getBaseStatNames(ruleset) {
  return Object.keys(ruleset?.base ?? {});
}

/** Look up the cap definition for a stat within its ruleset (may be null). */
function getStatCap(ruleset, statName) {
  return ruleset?.base?.[statName]?.cap ?? null;
}

/**
 * Lazy-compute derived values for a ruleset against a set of base numbers.
 * Mutates and returns `numbers` by injecting resolved derived keys, using a
 * fixpoint loop so derived values that reference other derived values still
 * resolve regardless of declaration order. Pure - nothing is persisted.
 */
function computeDerived(ruleset, numbers) {
  const derived = ruleset?.derived || {};
  const keys = Object.keys(derived);
  let progress = true;
  while (progress) {
    progress = false;
    for (const name of keys) {
      if (!(name in numbers)) {
        try {
          numbers[name] = evaluateFormula(derived[name].formula, numbers, new DiceRoller()).total;
          progress = true;
        } catch (err) {
          // Dependency not resolvable yet (or a malformed formula) - skip until
          // a later pass; this keeps one bad/forward formula from aborting all.
        }
      }
    }
  }
  return numbers;
}

/**
 * Resolve a character's effective stat numbers: base values (from the
 * structured character.base) plus lazy-computed derived values from the
 * character's ruleset. Returns a flat { statName: number } map suitable for
 * evaluateFormula()/staticCheck()/opposedCheck().
 */
function getCharacterEffectiveStats(character) {
  const ruleset = getRuleSet(character?.ruleset);
  const numbers = {};
  for (const [name, def] of Object.entries(character?.base ?? {})) {
    numbers[name] = Number(typeof def === 'object' ? def.value : def) || 0;
  }
  return computeDerived(ruleset, numbers);
}

/** Get a character by ID. */
function getCharacterById(id) {
  const settings = getSettings();
  return settings.characters.find(c => c.id === id);
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
// CONNECTION STATUS
// =============================================================================

/** Populate the live connection-status readout from SillyTavern.getContext(). */
function renderConnectionStatus() {
  const statusEl = document.getElementById('rpg-connection-status');
  if (!statusEl) return;

  try {
    const context = SillyTavern.getContext();
    const chatId = context.chatId ?? '(no active chat)';
    const characterName = context.characters?.[context.characterId]?.name ?? '(no character loaded)';
    const messageCount = context.chat?.length ?? 0;

    statusEl.innerHTML = `
      <span class="rpg-status-ok">● Connected</span>
      <span class="rpg-status-detail">Character: ${escapeHtml(characterName)}</span>
      <span class="rpg-status-detail">Messages in chat: ${messageCount}</span>
      <span class="rpg-status-detail">Chat ID: ${escapeHtml(String(chatId))}</span>
    `;
  } catch (err) {
    statusEl.innerHTML = `
      <span class="rpg-status-error">● Connection error</span>
      <span class="rpg-status-detail">${escapeHtml(err.message || String(err))}</span>
    `;
    console.error(`[${MODULE_NAME}] Failed to read SillyTavern context:`, err);
  }
}

/** Wire up click-to-expand/collapse on every .rpg-drawer section. */
function wireDrawers() {
  const drawers = document.querySelectorAll('.rpg-drawer');
  drawers.forEach((drawer) => {
    const toggle = drawer.querySelector('.rpg-drawer-toggle');
    if (!toggle) return;
    toggle.addEventListener('click', () => {
      drawer.classList.toggle('open');
    });
  });
}

/** Wire the master enable/disable checkbox to real persistence. */
function wireMasterToggle() {
  const toggle = document.getElementById('rpg-engine-master-toggle');
  if (!toggle) return;

  const settings = getSettings();
  toggle.checked = settings.enabled;

  toggle.addEventListener('change', () => {
    settings.enabled = toggle.checked;
    saveSettings();
    console.log(`[${MODULE_NAME}] Master toggle set to: ${toggle.checked} (saved)`);
  });
}

// =============================================================================
// CHARACTERS DRAWER
// =============================================================================

/** Render the characters list (reads the new `character.base` schema). */
function renderCharactersList() {
  const listEl = document.getElementById('rpg-character-list');
  const summaryEl = document.getElementById('rpg-characters-summary');
  if (!listEl) return;

  const settings = getSettings();
  const characters = settings.characters;

  if (summaryEl) {
    summaryEl.textContent = characters.length === 1 ? '1 character' : `${characters.length} characters`;
  }

  if (characters.length === 0) {
    listEl.innerHTML = '<div class="rpg-empty-state">No characters tracked yet. Click "+ Add Character" to create one.</div>';
    return;
  }

  listEl.innerHTML = characters.map(char => {
    const statChips = Object.entries(char.base || {}).map(([k, def]) => {
      const v = (def && typeof def === 'object') ? (def.value ?? def) : def;
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
          <button class="rpg-btn rpg-btn-small rpg-char-select" data-id="${escapeHtml(char.id)}" ${char.id === settings.selectedCharacterId ? 'disabled' : ''}>
            ${char.id === settings.selectedCharacterId ? '✓ Active' : 'Select for Tester'}
          </button>
          <button class="rpg-btn rpg-btn-small rpg-char-edit" data-id="${escapeHtml(char.id)}">Edit</button>
          <button class="rpg-btn rpg-btn-small rpg-btn-danger rpg-char-delete" data-id="${escapeHtml(char.id)}">Delete</button>
        </div>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('.rpg-char-select').forEach(btn => {
    btn.addEventListener('click', () => selectCharacter(btn.dataset.id));
  });
  listEl.querySelectorAll('.rpg-char-edit').forEach(btn => {
    btn.addEventListener('click', () => openCharacterEditor(btn.dataset.id));
  });
  listEl.querySelectorAll('.rpg-char-delete').forEach(btn => {
    btn.addEventListener('click', () => deleteCharacter(btn.dataset.id));
  });
}

/** Select a character for the Formula Tester. */
function selectCharacter(id) {
  const settings = getSettings();
  settings.selectedCharacterId = id;
  saveSettings();
  renderCharactersList();
  renderFormulaTesterStats();
  console.log(`[${MODULE_NAME}] Selected character for Formula Tester: ${id}`);
}

/** Open the character editor modal (reads/writes the new `base` schema). */
function openCharacterEditor(id) {
  const char = getCharacterById(id);
  const isNew = !char;
  // The editor must show the stat names of the character's OWN ruleset (for
  // edits) or the active ruleset (for new characters). Previously it always
  // used the active ruleset, which - when editing a character whose ruleset
  // differs from the active one - showed the wrong stat names and, on save,
  // wrote wrong-named entries into char.base, corrupting the character.
  const editorRuleSet = (char?.ruleset && getRuleSet(char.ruleset)) || getActiveRuleSet();
  const statNames = getBaseStatNames(editorRuleSet);

  const statsHtml = statNames.map(name => {
    const value = char?.base?.[name]?.value ?? 0;
    return `
      <div class="rpg-stat-input-row">
        <label>${escapeHtml(name)}</label>
        <input type="number" class="rpg-input-full rpg-stat-value" data-stat="${escapeHtml(name)}" value="${value}" step="1">
      </div>
    `;
  }).join('');

  const settings = getSettings();
  // One option per ruleset. For a new character, default the selection to the
  // active ruleset; for an existing character, to its own ruleset. (Single
  // source of options - avoids the active ruleset appearing twice.)
  const worldSelectValue = char?.ruleset ?? settings.activeRuleset;
  const rulesetOptions = Object.values(settings.rulesets || {})
    .map(r => `<option value="${escapeHtml(r.id)}" ${r.id === worldSelectValue ? 'selected' : ''}>${escapeHtml(r.displayName)}</option>`)
    .join('');

  const modalHtml = `
    <div id="rpg-char-modal" class="rpg-modal-overlay">
      <div class="rpg-modal">
        <h3>${isNew ? 'Add Character' : 'Edit Character'}</h3>
        <div class="rpg-form-group">
          <label for="rpg-char-name">Name</label>
          <input type="text" id="rpg-char-name" class="rpg-input-full" value="${escapeHtml(char?.name || '')}" placeholder="Character name">
        </div>
        <div class="rpg-form-group">
          <label for="rpg-char-world">Ruleset</label>
          <select id="rpg-char-world" class="rpg-input-full" ${!isNew ? 'disabled' : ''}>
            ${rulesetOptions}
          </select>
        </div>
        <div class="rpg-form-group">
          <label>Stats</label>
          <div id="rpg-char-stats-inputs">${statsHtml}</div>
        </div>
        <div class="rpg-button-row">
          <button id="rpg-char-save" class="rpg-btn">${isNew ? 'Add' : 'Save'}</button>
          <button id="rpg-char-cancel" class="rpg-btn">Cancel</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHtml);

  const modal = document.getElementById('rpg-char-modal');
  const saveBtn = document.getElementById('rpg-char-save');
  const cancelBtn = document.getElementById('rpg-char-cancel');
  const nameInput = document.getElementById('rpg-char-name');
  const worldSelect = document.getElementById('rpg-char-world');

  const closeModal = () => modal.remove();

  saveBtn.addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) { alert('Name is required'); return; }

    const settings = getSettings();

    if (isNew) {
      const base = {};
      modal.querySelectorAll('.rpg-stat-value').forEach(input => {
        base[input.dataset.stat] = { value: parseFloat(input.value) || 0 };
      });
      const newChar = {
        id: generateId(),
        name,
        ruleset: worldSelect.value,
        base,
        resources: {},
        effects: [],
      };
      settings.characters.push(newChar);
      settings.selectedCharacterId = newChar.id;
    } else {
      char.name = name;
      if (!char.base) char.base = {};
      modal.querySelectorAll('.rpg-stat-value').forEach(input => {
        const statName = input.dataset.stat;
        if (!char.base[statName]) char.base[statName] = { value: 0 };
        char.base[statName].value = parseFloat(input.value) || 0;
        // potential is preserved here (not exposed in the UI yet)
      });
    }

    saveSettings();
    renderCharactersList();
    renderFormulaTesterStats();
    closeModal();
  });

  cancelBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveBtn.click(); });
}

/** Delete a character. */
function deleteCharacter(id) {
  if (!confirm('Delete this character? This cannot be undone.')) return;

  const settings = getSettings();
  settings.characters = settings.characters.filter(c => c.id !== id);
  if (settings.selectedCharacterId === id) {
    settings.selectedCharacterId = settings.characters[0]?.id || null;
  }
  saveSettings();
  renderCharactersList();
  renderFormulaTesterStats();
}

/** Wire the Characters drawer buttons. */
function wireCharactersDrawer() {
  const addBtn = document.getElementById('rpg-char-add');
  const importBtn = document.getElementById('rpg-char-import-from-persona');

  if (addBtn) {
    addBtn.disabled = false;
    addBtn.addEventListener('click', () => openCharacterEditor(null));
  }
  if (importBtn) {
    // TODO: Import from ST persona
    importBtn.disabled = false;
    importBtn.addEventListener('click', () => alert('Import from Persona — not yet implemented'));
  }
}

// =============================================================================
// STATS DRAWER (stat definitions for the active ruleset)
// =============================================================================

/** Render the Stats drawer against the active ruleset's base definitions. */
function renderStatsDrawer() {
  const listEl = document.getElementById('rpg-stats-list');
  const summaryEl = document.getElementById('rpg-stats-summary');
  const selectEl = document.getElementById('rpg-stats-world-profile-select');
  if (!listEl || !selectEl) return;

  const settings = getSettings();
  const rulesets = settings.rulesets || {};
  const active = getActiveRuleSet();
  const statNames = getBaseStatNames(active);

  selectEl.innerHTML = Object.values(rulesets)
    .map(r => `<option value="${escapeHtml(r.id)}" ${r.id === settings.activeRuleset ? 'selected' : ''}>${escapeHtml(r.displayName)}</option>`)
    .join('');
  selectEl.disabled = false;

  if (summaryEl) {
    summaryEl.textContent = `${statNames.length} stats defined`;
  }

  if (statNames.length === 0) {
    listEl.innerHTML = '<div class="rpg-empty-state">No stats defined for this ruleset. Click "+ Add Stat" to create one.</div>';
    return;
  }

  listEl.innerHTML = statNames.map(name => `
    <div class="rpg-stat-def-item" data-name="${escapeHtml(name)}">
      <input type="text" class="rpg-input-full rpg-stat-name-input" value="${escapeHtml(name)}" data-stat="${escapeHtml(name)}">
      <div class="rpg-button-row" style="margin-top: 4px;">
        <button class="rpg-btn rpg-btn-small rpg-stat-rename" data-stat="${escapeHtml(name)}">Rename</button>
        <button class="rpg-btn rpg-btn-small rpg-btn-danger rpg-stat-delete" data-stat="${escapeHtml(name)}">Delete</button>
      </div>
    </div>
  `).join('');

  listEl.querySelectorAll('.rpg-stat-rename').forEach(btn => {
    btn.addEventListener('click', () => renameStat(btn.dataset.stat));
  });
  listEl.querySelectorAll('.rpg-stat-delete').forEach(btn => {
    btn.addEventListener('click', () => deleteStat(btn.dataset.stat));
  });
}

/** Add a new base stat to the active ruleset. */
function addStat() {
  const settings = getSettings();
  const ruleset = getActiveRuleSet();
  if (!ruleset) return;

  const baseName = 'NewStat';
  let name = baseName;
  let i = 1;
  while (Object.hasOwn(ruleset.base, name)) {
    name = `${baseName}${i++}`;
  }
  ruleset.base[name] = {};
  saveSettings();
  renderStatsDrawer();
  renderCharactersList();
}

/** Rename a base stat (updates all characters using that ruleset). */
function renameStat(oldName) {
  const settings = getSettings();
  const ruleset = getActiveRuleSet();
  if (!ruleset?.base || !Object.hasOwn(ruleset.base, oldName)) return;

  const newName = prompt(`Rename "${oldName}" to:`, oldName);
  if (!newName || newName.trim() === '' || newName === oldName) return;
  const trimmed = newName.trim();

  if (Object.hasOwn(ruleset.base, trimmed)) {
    alert('A stat with that name already exists.');
    return;
  }

  ruleset.base[trimmed] = ruleset.base[oldName];
  delete ruleset.base[oldName];

  settings.characters.forEach(char => {
    if (char.ruleset === settings.activeRuleset && char.base && Object.hasOwn(char.base, oldName)) {
      char.base[trimmed] = char.base[oldName];
      delete char.base[oldName];
    }
  });

  const selectedChar = getSelectedCharacter();
  if (selectedChar && selectedChar.ruleset === settings.activeRuleset) {
    renderFormulaTesterStats();
  }

  saveSettings();
  renderStatsDrawer();
  renderCharactersList();
}

/** Delete a base stat (removes from all characters using that ruleset). */
function deleteStat(statName) {
  const settings = getSettings();
  const ruleset = getActiveRuleSet();
  if (!ruleset?.base || !Object.hasOwn(ruleset.base, statName)) return;

  if (!confirm(`Delete stat "${statName}"? This will remove it from all characters in this ruleset.`)) return;

  delete ruleset.base[statName];

  settings.characters.forEach(char => {
    if (char.ruleset === settings.activeRuleset && char.base) {
      delete char.base[statName];
    }
  });

  saveSettings();
  renderStatsDrawer();
  renderCharactersList();
  renderFormulaTesterStats();
}

/** Wire the Stats drawer buttons and the ruleset selector. */
function wireStatsDrawer() {
  const selectEl = document.getElementById('rpg-stats-world-profile-select');
  const addBtn = document.getElementById('rpg-stats-add');

  if (selectEl) {
    selectEl.addEventListener('change', () => {
      const settings = getSettings();
      settings.activeRuleset = selectEl.value;
      const selectedChar = getSelectedCharacter();
      if (selectedChar && selectedChar.ruleset !== settings.activeRuleset) {
        settings.selectedCharacterId = settings.characters.find(c => c.ruleset === settings.activeRuleset)?.id || null;
      }
      saveSettings();
      renderStatsDrawer();
      renderCharactersList();
      renderFormulaTesterStats();
    });
  }

  if (addBtn) {
    addBtn.disabled = false;
    addBtn.addEventListener('click', addStat);
  }
}

// =============================================================================
// FORMULA TESTER
// =============================================================================

/** Render the Formula Tester stat preview (base + lazy derived values). */
function renderFormulaTesterStats() {
  const stats = getFormulaTesterStats();
  const previewEl = document.getElementById('rpg-formula-test-stats-preview');
  if (!previewEl) return;

  const entries = Object.entries(stats);
  if (entries.length === 0) {
    previewEl.innerHTML = '<span class="rpg-empty-state">No stats available</span>';
    return;
  }

  previewEl.innerHTML = entries.map(([k, v]) =>
    `<span class="rpg-stat-chip">${escapeHtml(k)}: ${v}</span>`
  ).join('');
}

/** Wire the Formula Tester to evaluateFormula() via the selected character. */
function wireFormulaTester() {
  const input = document.getElementById('rpg-formula-test-input');
  const button = document.getElementById('rpg-formula-test-run');
  const output = document.getElementById('rpg-formula-test-output');
  if (!input || !button || !output) {
    console.warn(`[${MODULE_NAME}] Formula Tester elements not found - skipping wiring.`);
    return;
  }

  input.disabled = false;
  button.disabled = false;

  renderFormulaTesterStats();

  const runTest = () => {
    const formula = input.value.trim();
    if (!formula) {
      output.textContent = '// enter a formula above, e.g. d60 + INT + 0.5*BLS';
      return;
    }

    try {
      const stats = getFormulaTesterStats();
      const { total, breakdown } = evaluateFormula(formula, stats, new DiceRoller());
      const lines = breakdown.map((b) => {
        const sign = typeof b.value === 'number' && b.value >= 0 ? '+' : '';
        return `${b.label}: ${sign}${b.value}`;
      });
      lines.push(`Total: ${total}`);
      output.textContent = lines.join('\n');
    } catch (err) {
      if (err instanceof EngineError) {
        output.textContent = `Error: ${err.message}`;
      } else {
        output.textContent = `Unexpected error: ${err.message || String(err)}`;
        console.error(`[${MODULE_NAME}] Formula Tester unexpected error:`, err);
      }
    }
  };

  button.addEventListener('click', runTest);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runTest();
  });
}

// =============================================================================
// INITIALIZATION
// =============================================================================

async function init() {
  console.log(`[${MODULE_NAME}] Initializing...`);

  try {
    const context = SillyTavern.getContext();
    const settingsHtml = await context.renderExtensionTemplateAsync(EXTENSION_FOLDER, 'settings', {});
    $('#extensions_settings2').append(settingsHtml);

    wireDrawers();
    wireMasterToggle();
    wireCharactersDrawer();
    wireStatsDrawer();
    wireFormulaTester();
    renderConnectionStatus();
    renderCharactersList();
    renderStatsDrawer();

    const { eventSource, event_types } = context;
    if (eventSource && event_types) {
      eventSource.on(event_types.CHAT_CHANGED, renderConnectionStatus);
      eventSource.on(event_types.MESSAGE_RECEIVED, renderConnectionStatus);
      eventSource.on(event_types.APP_READY, renderConnectionStatus);
    }

    console.log(`[${MODULE_NAME}] Loaded successfully.`);
  } catch (err) {
    console.error(`[${MODULE_NAME}] FAILED TO LOAD:`, err);
  }
}

jQuery(async () => {
  init();
});