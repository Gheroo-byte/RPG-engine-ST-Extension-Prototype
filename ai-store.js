/**
 * RPG Engine - AI Store (SillyTavern-coupled)
 * ============================================
 * The ST-specific half of the AI Service layer. Whereas ai-core.js is pure and
 * host-independent, this module owns the things that only make sense inside
 * SillyTavern:
 *   - persisting/reading slots from extensionSettings,
 *   - resolving a slot's connection spec into an actual ST AI call,
 *   - dispatching requests through ST's native AI infrastructure.
 *
 * This module NEVER mutates RPG state. It only talks to the AI and returns the
 * raw response text. Any structured engine actions in that text are proposals;
 * they are validated and executed by the index.js glue + engine-core/stats,
 * never here.
 *
 * Connection support (first vertical slice):
 *   - source: 'profile'  → ConnectionManagerRequestService.sendRequest (silent)
 *   - source: 'default'  → SillyTavern's generateRaw via the active connection
 *   - OpenAI/Ollama direct endpoints are intentionally NOT implemented yet.
 *
 * Imported by: index.js
 * Imports:     ai-core.js (pure)
 */

import { PERMISSION_LEVELS, validateSlot } from './ai-core.js';

// =============================================================================
// SLOT STORAGE
// =============================================================================

/** Default slot seed. The UI may show 7 slots, but the engine never hardcodes
 *  the count: this is just an initial seed of serializable slot objects. */
export function createDefaultSlots() {
  return [
    {
      id: 'slot-ruleset-assistant',
      label: 'Ruleset Assistant',
      purpose: 'Explain the active ruleset, stat meanings, and mechanical outcomes without changing anything.',
      enabled: true,
      permission: PERMISSION_LEVELS.READ_ONLY,
      connection: { source: 'default' },
    },
    {
      id: 'slot-rpg-assistant',
      label: 'RPG Assistant',
      purpose: 'General user help and interpretation.',
      enabled: false,
      permission: PERMISSION_LEVELS.READ_ONLY,
      connection: { source: 'default' },
    },
    {
      id: 'slot-state-interpreter',
      label: 'State Interpretation',
      purpose: 'Explain current character/stat state in plain language.',
      enabled: false,
      permission: PERMISSION_LEVELS.READ_ONLY,
      connection: { source: 'default' },
    },
    {
      id: 'slot-combat-analysis',
      label: 'Combat Analysis',
      purpose: 'Analyze combat situations.',
      enabled: false,
      permission: PERMISSION_LEVELS.READ_ONLY,
      connection: { source: 'default' },
    },
    {
      id: 'slot-narrative',
      label: 'Narrative Resolution',
      purpose: 'Assist with narrative resolution.',
      enabled: false,
      permission: PERMISSION_LEVELS.READ_ONLY,
      connection: { source: 'default' },
    },
    {
      id: 'slot-validation',
      label: 'Validation / Review',
      purpose: 'Review and validate mechanical proposals.',
      enabled: false,
      permission: PERMISSION_LEVELS.READ_ONLY,
      connection: { source: 'default' },
    },
    {
      id: 'slot-custom',
      label: 'Other AI Role',
      purpose: '',
      enabled: false,
      permission: PERMISSION_LEVELS.READ_ONLY,
      connection: { source: 'default' },
    },
  ];
}

/** Get the AI slots array from persisted settings, seeding defaults if absent. */
export function getSlots(settings) {
  if (!Array.isArray(settings?.aiSlots) || settings.aiSlots.length === 0) {
    settings.aiSlots = createDefaultSlots();
  }
  return settings.aiSlots;
}

/** Get a single slot by id, or null. */
export function getSlot(settings, slotId) {
  return getSlots(settings).find((s) => s.id === slotId) ?? null;
}

// =============================================================================
// CONNECTION RESOLUTION + DISPATCH
// =============================================================================

/** Resolve a slot's connection source to a supported value ('profile' or
 *  'default'). Unknown/unsupported sources fall back to 'default'. */
function resolveSource(connection) {
  const source = connection?.source;
  if (source === 'profile' || source === 'default') return source;
  return 'default';
}

/**
 * Dispatch a request through ST's native AI infrastructure for a given slot.
 * Returns the raw response text (a string). Never mutates RPG state; never
 * returns structured actions this module would treat as authoritative.
 *
 * @param {object} slot            The AI slot configuration.
 * @param {object} request         { systemPrompt: string, userPrompt: string }
 * @param {object} [options]       { maxTokens?: number, signal?: AbortSignal }
 * @returns {Promise<string>}      Raw response text.
 */
export async function dispatchSlot(slot, request, options = {}) {
  validateSlot(slot);

  const context = SillyTavern.getContext();
  const connection = slot.connection ?? {};
  const source = resolveSource(connection);

  const messages = [
    { role: 'system', content: request.systemPrompt ?? '' },
    { role: 'user', content: request.userPrompt ?? '' },
  ];

  if (source === 'profile' && connection.profileId) {
    const service = context.ConnectionManagerRequestService;
    if (service && typeof service.sendRequest === 'function') {
      const raw = await service.sendRequest(
        connection.profileId,
        messages,
        options.maxTokens,
        {
          stream: false,
          extractData: true,
          includePreset: true,
          includeInstruct: true,
          signal: options.signal,
        },
      );
      return collectText(raw);
    }
    // If profile service is unavailable, fall through to generateRaw.
  }

  // Default: generateRaw through the active connection. Read raw provider
  // output where possible so we don't depend on ST's dialogue cleanup.
  const generateRaw = context.generateRaw;
  if (typeof generateRaw === 'function') {
    const response = await generateRaw({
      prompt: request.userPrompt ?? '',
      systemPrompt: request.systemPrompt ?? '',
      bypassAll: true,
      ...(options.maxTokens ? { responseLength: options.maxTokens } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return collectText(response);
  }

  throw new Error('No ST AI generation function is available (generateRaw missing).');
}

/**
 * Normalize an ST AI response into a single string, tolerating the shapes
 * returned by different providers. Read-only and defensive.
 */
function collectText(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'function') {
    // Streaming function: consume best-effort (streaming is not yet used by
    // this slice, but stay tolerant).
    try {
      const it = raw();
      if (it && typeof it[Symbol.asyncIterator] === 'function') {
        let text = '';
        for (const chunk of it) {
          if (typeof chunk === 'string') text = chunk;
          else if (chunk && typeof chunk === 'object' && typeof chunk.text === 'string') text = chunk.text;
        }
        return text;
      }
    } catch (_) {
      /* fall through */
    }
    return '';
  }

  const r = raw;
  let text = r?.content
    ?? r?.message?.content
    ?? r?.choices?.[0]?.message?.content
    ?? r?.choices?.[0]?.text
    ?? null;

  if (text === null || text === undefined || text === '') {
    text = r?.reasoning
      ?? r?.message?.reasoning
      ?? r?.choices?.[0]?.message?.reasoning
      ?? r?.choices?.[0]?.message?.reasoning_content
      ?? '';
  }

  if (text && typeof text === 'object') text = JSON.stringify(text);
  return typeof text === 'string' ? text : '';
}