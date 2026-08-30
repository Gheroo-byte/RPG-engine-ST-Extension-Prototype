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
 * STILL NOT WIRED:
 *   - No narrator/chat integration
 *   - No real character/world state (only the Enabled toggle persists)
 *   - Every other drawer (World, Characters, Stats, Rules, Effects,
 *     Save/Load, Settings, Event Log) is still inert placeholder content
 * Keeping each addition narrow and isolated on purpose, so a failure can
 * be traced to the specific piece that changed, not "everything at once."
 */

import { evaluateFormula, EngineError, DiceRoller } from './engine-core.js';

const MODULE_NAME = 'rpg-engine';
const EXTENSION_FOLDER = 'third-party/RPG-engine-ST-extension';

/**
 * Demo stats for the Formula Tester, since the real Stats/Characters system
 * (drawers still say "No profile loaded" / "0 tracked") doesn't exist yet.
 * Not arbitrary numbers - these are Kris Talionis's actual stats (for
 * Astralis-style formulas) and the design doc's own Talia Pounce example
 * (for generic-named formulas), both already verified in test-engine.js.
 * This object gets deleted once real character data is wired in.
 */
const DEMO_STATS = {
  // Astralis-style (Kris Talionis, verified against his real sheet)
  STR: 20, DEX: 52, CON: 24, CHA: 8, INT: 34, BLS: 30, LCK: 14,
  // Generic/Kaelrath-style (design doc's Talia Pounce example)
  Strength: 32, Agility: 36, Endurance: 24, Intelligence: 34, Perception: 18, Willpower: 20, Charisma: 8,
};

// =============================================================================
// PERSISTENT SETTINGS
// =============================================================================
// Pattern verified against official docs.ST.app AND cross-checked against
// multiple real shipped extensions (Lovense-Cloud, Stable Diffusion, the
// core connection-manager extension) - all use this identical shape, so
// confidence here is high, not a single-source guess.
//
// This is step 3 of the dev order (Persistent State Management), started
// deliberately small: proving the save/load mechanism works on the
// simplest possible piece of data (the Enabled toggle) before building
// real character/world state on top of it.

const defaultSettings = Object.freeze({
  enabled: true,
});

/** Gets (and lazily initializes) this extension's persistent settings
 *  object. Also backfills any new default keys added in later versions,
 *  so upgrading the extension doesn't wipe out a user's existing saved
 *  values. */
function getSettings() {
  const { extensionSettings } = SillyTavern.getContext();
  if (!extensionSettings[MODULE_NAME]) {
    extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
  }
  for (const key of Object.keys(defaultSettings)) {
    if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
      extensionSettings[MODULE_NAME][key] = defaultSettings[key];
    }
  }
  return extensionSettings[MODULE_NAME];
}

/**
 * Populates the #rpg-connection-status element with live info pulled
 * from SillyTavern.getContext(). This is the "prove we're actually
 * connected" diagnostic - if this shows real, current data, the
 * extension loaded and is talking to ST correctly. If it shows an
 * error or never appears at all, that's an immediate, obvious signal
 * something's wrong with THIS file specifically.
 */
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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/** Wires up click-to-expand/collapse on every .rpg-drawer section. */
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

/** Wires the master enable/disable checkbox to real persistence: reads
 *  the saved value on load, writes it back (debounced) on every change.
 *  This is the first real state that survives a page reload - proof the
 *  persistence mechanism itself works before building real character/
 *  world state on top of it. */
function wireMasterToggle() {
  const toggle = document.getElementById('rpg-engine-master-toggle');
  if (!toggle) return;

  const { saveSettingsDebounced } = SillyTavern.getContext();
  const settings = getSettings();

  // Reflect the saved value on load - without this, the checkbox would
  // always show "checked" regardless of what was actually saved.
  toggle.checked = settings.enabled;

  toggle.addEventListener('change', () => {
    settings.enabled = toggle.checked;
    saveSettingsDebounced();
    console.log(`[${MODULE_NAME}] Master toggle set to: ${toggle.checked} (saved)`);
  });
}

/**
 * Wires the Formula Tester box (Dice section) to actually call
 * evaluateFormula() from engine-core.js. This is the first real bridge
 * between the UI shell and the deterministic engine - everything before
 * this point was UI-only or engine-only, verified separately.
 */
function wireFormulaTester() {
  const input = document.getElementById('rpg-formula-test-input');
  const button = document.getElementById('rpg-formula-test-run');
  const output = document.getElementById('rpg-formula-test-output');
  if (!input || !button || !output) {
    console.warn(`[${MODULE_NAME}] Formula Tester elements not found - skipping wiring.`);
    return;
  }

  // These were placeholder-disabled in settings.html; enable them now
  // that there's real behavior behind them.
  input.disabled = false;
  button.disabled = false;

  const runTest = () => {
    const formula = input.value.trim();
    if (!formula) {
      output.textContent = '// enter a formula above, e.g. d60 + INT + 0.5*BLS';
      return;
    }

    try {
      const { total, breakdown } = evaluateFormula(formula, DEMO_STATS, new DiceRoller());
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
  // Also allow Enter key from the input field, since mobile users
  // won't always want to reach for a separate button.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runTest();
  });
}

// DiceRoller is a fresh, stateless instance per test run - no need to
// persist it, formulas evaluate independently each time.
async function init() {
  console.log(`[${MODULE_NAME}] Initializing...`);

  try {
    const context = SillyTavern.getContext();
    const settingsHtml = await context.renderExtensionTemplateAsync(EXTENSION_FOLDER, 'settings', {});
    $('#extensions_settings2').append(settingsHtml);

    wireDrawers();
    wireMasterToggle();
    wireFormulaTester();
    renderConnectionStatus();

    // Re-render connection status on key chat events, so the readout
    // stays live rather than showing a stale snapshot from page load.
    const { eventSource, event_types } = context;
    if (eventSource && event_types) {
      eventSource.on(event_types.CHAT_CHANGED, renderConnectionStatus);
      eventSource.on(event_types.MESSAGE_RECEIVED, renderConnectionStatus);
      eventSource.on(event_types.APP_READY, renderConnectionStatus);
    }

    console.log(`[${MODULE_NAME}] Loaded successfully.`);
  } catch (err) {
    console.error(`[${MODULE_NAME}] FAILED TO LOAD:`, err);
    // Fail loudly but don't throw further - a broken RPG engine extension
    // should never be able to take down the rest of SillyTavern with it.
  }
}

// SillyTavern extensions initialize once the app is ready, not on raw
// page load, so context/eventSource are guaranteed to exist by the time
// init() runs.
jQuery(async () => {
  init();
});
