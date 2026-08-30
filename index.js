/**
 * RPG Engine - Extension Entry Point
 * ====================================
 * Registration pattern verified against official docs.ST.app documentation
 * (SillyTavern.getContext() + renderExtensionTemplateAsync + append to
 * #extensions_settings2) - not guessed.
 *
 * CURRENT SCOPE:
 *   - Load and display the settings panel (all 9 sections wrapped in one
 *     master drawer, matching other extensions' collapsed-by-default look)
 *   - Wire up drawer expand/collapse
 *   - Display a live connection status readout
 *   - Formula Tester calls evaluateFormula() from engine-core.js for real,
 *     against a small labeled demo stat set (see DEMO_STATS below)
 *   - Persistent settings (step 3 of the dev order, started small): the
 *     Enabled toggle now genuinely survives a page reload, using the
 *     verified extensionSettings + saveSettingsDebounced() pattern. This
 *     proves the persistence mechanism works before real character/world
 *     state gets built on top of it.
 *
 * NEW IN THIS BRANCH:
 *   - Character stats system: add/list/edit characters with modular stats
 *   - World profiles: define stat names per world (Kaelrath, Shattered Dominion, etc.)
 *   - All persisted via extensionSettings + saveSettingsDebounced()
 *   - Formula Tester uses the currently selected character's stats
 *
 * STILL NOT WIRED:
 *   - No narrator/chat integration
 *   - No Rules, Effects, Save/Load, Settings, Event Log drawers (placeholder)
 *   - No inventory, status effects, leveling
 * Keeping each addition narrow and isolated on purpose, so a failure can
 * be traced to the specific piece that changed, not "everything at once."
 */

import { evaluateFormula, EngineError, DiceRoller } from './engine-core.js';

const MODULE_NAME = 'rpg-engine';
const EXTENSION_FOLDER = 'third-party/RPG-engine-ST-extension';

// =============================================================================
// DEFAULT DATA STRUCTURES
// =============================================================================
// NOTE: defaultSettings is only a *template*. It is frozen at the top level
// so nothing ever mutates it by accident. Every value is cloned out of it via
// deepClone() - never shared by reference - so nested objects (worldProfiles,
// characters, etc.) can never be accidentally aliased across callers.

const defaultSettings = Object.freeze({
  enabled: true,
  // worldProfiles: { profileName: { statNames: ['STR', 'DEX', ...] } }
  worldProfiles: {
    'Kaelrath': { statNames: ['Strength', 'Agility', 'Endurance', 'Intelligence', 'Perception', 'Willpower', 'Charisma', 'Blessing'] },
    'Shattered Dominion': { statNames: ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'] },
  },
  // activeWorldProfile: name of the currently selected world profile
  activeWorldProfile: 'Kaelrath',
  // characters: [{ id, name, worldProfile, stats: { statName: value } }]
  characters: [],
  // selectedCharacterId: id of the character currently shown in Formula Tester
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
 * saves that lack newly-added keys. This avoids ever sharing a reference to
 * the frozen default objects, and avoids cloning the whole template only to
 * immediately backfill the same keys again.
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

/** Save settings (debounced) */
function saveSettings() {
  const { saveSettingsDebounced } = SillyTavern.getContext();
  saveSettingsDebounced();
}

/** Generate a simple unique ID */
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}

/** Escape HTML for safe insertion */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/** Get the stat names for the active world profile */
function getActiveStatNames() {
  const settings = getSettings();
  const profile = settings.worldProfiles[settings.activeWorldProfile];
  return profile ? [...profile.statNames] : [];
}

/** Get a character by ID */
function getCharacterById(id) {
  const settings = getSettings();
  return settings.characters.find(c => c.id === id);
}

/** Get the currently selected character (for Formula Tester) */
function getSelectedCharacter() {
  const settings = getSettings();
  if (!settings.selectedCharacterId) return null;
  return getCharacterById(settings.selectedCharacterId);
}

/** Get stats object for Formula Tester (selected character or demo fallback) */
function getFormulaTesterStats() {
  const char = getSelectedCharacter();
  if (char && char.stats) {
    return { ...char.stats };
  }
  // Fallback to demo stats if no character selected
  return {
    STR: 20, DEX: 52, CON: 24, CHA: 8, INT: 34, BLS: 30, LCK: 14,
    Strength: 32, Agility: 36, Endurance: 24, Intelligence: 34, Perception: 18, Willpower: 20, Charisma: 8,
  };
}

/** Render the connection status */
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

/** Wire the master enable/disable checkbox to real persistence */
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

/** ===========================================================================
 *  CHARACTERS DRAWER
 * ===========================================================================*/

/** Render the characters list */
function renderCharactersList() {
  const listEl = document.getElementById('rpg-character-list');
  const summaryEl = document.getElementById('rpg-characters-summary');
  if (!listEl) return;

  const settings = getSettings();
  const characters = settings.characters;

  // Update summary
  if (summaryEl) {
    summaryEl.textContent = characters.length === 1 ? '1 character' : `${characters.length} characters`;
  }

  if (characters.length === 0) {
    listEl.innerHTML = '<div class="rpg-empty-state">No characters tracked yet. Click "+ Add Character" to create one.</div>';
    return;
  }

  listEl.innerHTML = characters.map(char => `
    <div class="rpg-character-item" data-id="${escapeHtml(char.id)}">
      <div class="rpg-character-header">
        <span class="rpg-character-name">${escapeHtml(char.name)}</span>
        <span class="rpg-character-world">${escapeHtml(char.worldProfile)}</span>
      </div>
      <div class="rpg-character-stats-preview">
        ${Object.entries(char.stats || {}).map(([k, v]) => `<span class="rpg-stat-chip">${escapeHtml(k)}: ${v}</span>`).join('')}
      </div>
      <div class="rpg-character-actions">
        <button class="rpg-btn rpg-btn-small rpg-char-select" data-id="${escapeHtml(char.id)}" ${char.id === settings.selectedCharacterId ? 'disabled' : ''}>
          ${char.id === settings.selectedCharacterId ? '✓ Active' : 'Select for Tester'}
        </button>
        <button class="rpg-btn rpg-btn-small rpg-char-edit" data-id="${escapeHtml(char.id)}">Edit</button>
        <button class="rpg-btn rpg-btn-small rpg-btn-danger rpg-char-delete" data-id="${escapeHtml(char.id)}">Delete</button>
      </div>
    </div>
  `).join('');

  // Wire up buttons
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

/** Select a character for the Formula Tester */
function selectCharacter(id) {
  const settings = getSettings();
  settings.selectedCharacterId = id;
  saveSettings();
  renderCharactersList();
  renderFormulaTesterStats();
  console.log(`[${MODULE_NAME}] Selected character for Formula Tester: ${id}`);
}

/** Open the character editor modal */
function openCharacterEditor(id) {
  const char = getCharacterById(id);
  const isNew = !char;
  const statNames = getActiveStatNames();

  // Build stats inputs
  const statsHtml = statNames.map(name => {
    const value = char?.stats?.[name] ?? 0;
    return `
      <div class="rpg-stat-input-row">
        <label>${escapeHtml(name)}</label>
        <input type="number" class="rpg-input-full rpg-stat-value" data-stat="${escapeHtml(name)}" value="${value}" step="1">
      </div>
    `;
  }).join('');

  const modalHtml = `
    <div id="rpg-char-modal" class="rpg-modal-overlay">
      <div class="rpg-modal">
        <h3>${isNew ? 'Add Character' : 'Edit Character'}</h3>
        <div class="rpg-form-group">
          <label for="rpg-char-name">Name</label>
          <input type="text" id="rpg-char-name" class="rpg-input-full" value="${escapeHtml(char?.name || '')}" placeholder="Character name">
        </div>
        <div class="rpg-form-group">
          <label for="rpg-char-world">World Profile</label>
          <select id="rpg-char-world" class="rpg-input-full" ${!isNew ? 'disabled' : ''}>
            ${Object.keys(getSettings().worldProfiles).map(p => `<option value="${escapeHtml(p)}" ${char?.worldProfile === p ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}
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
    const stats = {};
    modal.querySelectorAll('.rpg-stat-value').forEach(input => {
      stats[input.dataset.stat] = parseFloat(input.value) || 0;
    });

    if (isNew) {
      const newChar = {
        id: generateId(),
        name,
        worldProfile: worldSelect.value,
        stats,
      };
      settings.characters.push(newChar);
      // Auto-select the new character
      settings.selectedCharacterId = newChar.id;
    } else {
      char.name = name;
      char.stats = stats;
      // World profile is locked for existing characters (would need migration)
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

/** Delete a character */
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

/** Wire the Characters drawer buttons */
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

/** ===========================================================================
 *  STATS DRAWER (World Profile stat definitions)
 * ===========================================================================*/

/** Render the Stats drawer */
function renderStatsDrawer() {
  const listEl = document.getElementById('rpg-stats-list');
  const summaryEl = document.getElementById('rpg-stats-summary');
  const selectEl = document.getElementById('rpg-stats-world-profile-select');
  if (!listEl || !selectEl) return;

  const settings = getSettings();
  const profile = settings.worldProfiles[settings.activeWorldProfile];
  const statNames = profile?.statNames || [];

  // Update world profile select
  selectEl.innerHTML = Object.keys(settings.worldProfiles).map(name =>
    `<option value="${escapeHtml(name)}" ${name === settings.activeWorldProfile ? 'selected' : ''}>${escapeHtml(name)}</option>`
  ).join('');
  selectEl.disabled = false;

  // Update summary
  if (summaryEl) {
    summaryEl.textContent = `${statNames.length} stats defined`;
  }

  // Render stat list
  if (statNames.length === 0) {
    listEl.innerHTML = '<div class="rpg-empty-state">No stats defined for this world profile. Click "+ Add Stat" to create one.</div>';
    return;
  }

  listEl.innerHTML = statNames.map((name, index) => `
    <div class="rpg-stat-def-item" data-name="${escapeHtml(name)}">
      <input type="text" class="rpg-input-full rpg-stat-name-input" value="${escapeHtml(name)}" data-index="${index}">
      <div class="rpg-button-row" style="margin-top: 4px;">
        <button class="rpg-btn rpg-btn-small rpg-stat-rename" data-index="${index}">Rename</button>
        <button class="rpg-btn rpg-btn-small rpg-btn-danger rpg-stat-delete" data-index="${index}">Delete</button>
      </div>
    </div>
  `).join('');

  // Wire up
  listEl.querySelectorAll('.rpg-stat-rename').forEach(btn => {
    btn.addEventListener('click', () => renameStat(parseInt(btn.dataset.index, 10)));
  });
  listEl.querySelectorAll('.rpg-stat-delete').forEach(btn => {
    btn.addEventListener('click', () => deleteStat(parseInt(btn.dataset.index, 10)));
  });
}

/** Add a new stat to the active world profile */
function addStat() {
  const settings = getSettings();
  const profile = settings.worldProfiles[settings.activeWorldProfile];
  if (!profile) return;

  const baseName = 'NewStat';
  let name = baseName;
  let i = 1;
  while (profile.statNames.includes(name)) {
    name = `${baseName}${i++}`;
  }
  profile.statNames.push(name);
  saveSettings();
  renderStatsDrawer();
  renderCharactersList(); // stat chips update
}

/** Rename a stat (updates all characters using that world profile) */
function renameStat(index) {
  const settings = getSettings();
  const profile = settings.worldProfiles[settings.activeWorldProfile];
  if (!profile || index < 0 || index >= profile.statNames.length) return;

  const oldName = profile.statNames[index];
  const newName = prompt(`Rename "${oldName}" to:`, oldName);
  if (!newName || newName.trim() === '' || newName === oldName) return;
  newName = newName.trim();

  // Check for collision
  if (profile.statNames.includes(newName)) {
    alert('A stat with that name already exists.');
    return;
  }

  // Update the stat definition
  profile.statNames[index] = newName;

  // Update all characters using this world profile
  settings.characters.forEach(char => {
    if (char.worldProfile === settings.activeWorldProfile && char.stats && Object.hasOwn(char.stats, oldName)) {
      char.stats[newName] = char.stats[oldName];
      delete char.stats[oldName];
    }
  });

  // If selected character was using this stat, refresh Formula Tester
  const selectedChar = getSelectedCharacter();
  if (selectedChar && selectedChar.worldProfile === settings.activeWorldProfile) {
    renderFormulaTesterStats();
  }

  saveSettings();
  renderStatsDrawer();
  renderCharactersList();
}

/** Delete a stat (removes from all characters using that world profile) */
function deleteStat(index) {
  const settings = getSettings();
  const profile = settings.worldProfiles[settings.activeWorldProfile];
  if (!profile || index < 0 || index >= profile.statNames.length) return;

  const name = profile.statNames[index];
  if (!confirm(`Delete stat "${name}"? This will remove it from all characters in this world profile.`)) return;

  // Remove from profile
  profile.statNames.splice(index, 1);

  // Remove from all characters using this world profile
  settings.characters.forEach(char => {
    if (char.worldProfile === settings.activeWorldProfile && char.stats && Object.hasOwn(char.stats, name)) {
      delete char.stats[name];
    }
  });

  saveSettings();
  renderStatsDrawer();
  renderCharactersList();
  renderFormulaTesterStats();
}

/** Wire the Stats drawer buttons */
function wireStatsDrawer() {
  const selectEl = document.getElementById('rpg-stats-world-profile-select');
  const addBtn = document.getElementById('rpg-stats-add');

  if (selectEl) {
    selectEl.addEventListener('change', () => {
      const settings = getSettings();
      settings.activeWorldProfile = selectEl.value;
      // Reset selected character if it doesn't belong to the new world
      const selectedChar = getSelectedCharacter();
      if (selectedChar && selectedChar.worldProfile !== settings.activeWorldProfile) {
        settings.selectedCharacterId = settings.characters.find(c => c.worldProfile === settings.activeWorldProfile)?.id || null;
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

/** ===========================================================================
 *  FORMULA TESTER
 * ===========================================================================*/

/** Render the Formula Tester with current character's stats */
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

/** Wire the Formula Tester box to evaluateFormula() from engine-core.js */
function wireFormulaTester() {
  const input = document.getElementById('rpg-formula-test-input');
  const button = document.getElementById('rpg-formula-test-run');
  const output = document.getElementById('rpg-formula-test-output');
  if (!input || !button || !output) {
    console.warn(`[${MODULE_NAME}] Formula Tester elements not found - skipping wiring.`);
    return;
  }

  // Enable the inputs
  input.disabled = false;
  button.disabled = false;

  // Initial stats preview
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

/** ===========================================================================
 *  INITIALIZATION
 * ===========================================================================*/

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

    // Re-render connection status on key chat events
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