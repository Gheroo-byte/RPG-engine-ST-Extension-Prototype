/**
 * RPG Engine - Ruleset Definitions (data model)
 * =============================================
 * This module is the CLEAN, EXTENSIBLE data model for the stat engine.
 * It deliberately contains NO world/System lore or philosophy - only the
 * mechanical facts a ruleset needs:
 *   - which base stats exist and how each is shaped (optional potential/cap)
 *   - which derived values exist and how they are computed
 *
 * The universal engine never assumes every stat has a modifier, stars, a cap,
 * or is derived. Each ruleset declares which mechanisms it uses.
 *
 * Keep this file free of SillyTavern / UI / persistence dependencies.
 */

export const SCHEMA_VERSION = 1;

/**
 * Shattered Dominion Star Potential - explicit per-star data, NOT calculated
 * as a linear progression. The ruleset owns this mapping; a character only
 * stores its individual star `potential` for each stat.
 */
const STAR_TIERS = Object.freeze({
  0: { max: 7,   label: 'Ordinary' },
  1: { max: 15,  label: 'Talented' },
  2: { max: 25,  label: 'Skilled' },
  3: { max: 35,  label: 'Exceptional' },
  4: { max: 45,  label: 'Heroic' },
  5: { max: 60,  label: 'Legendary' },
  6: { max: 80,  label: 'Mythic' },
  7: { max: 100, label: 'Divine' },
});

/** A stat guarded by the Star Potential cap system. */
function starCap() {
  return { cap: { kind: 'stars', tiers: STAR_TIERS } };
}

/** A plain stat with no cap/potential mechanism (D&D, Kaelrath). */
function plainStat() {
  return {};
}

function buildBase(specs) {
  const out = {};
  for (const [name, def] of Object.entries(specs)) {
    out[name] = def;
  }
  return out;
}

export const RULESETS = Object.freeze({
  'shattered-dominion': Object.freeze({
    id: 'shattered-dominion',
    displayName: 'Shattered Dominion',
    base: Object.freeze(buildBase({
      STR: starCap(),
      DEX: starCap(),
      CON: starCap(),
      CHA: starCap(),
      INT: starCap(),
      BLS: starCap(),
      // SD rule: LCK is usable at its full star value immediately (no training).
      LCK: Object.freeze({ ...starCap(), alwaysActive: true }),
    })),
    derived: Object.freeze({
      'Max HP':  Object.freeze({ formula: 'CON*10 + STR*2' }),
      'Max CHI': Object.freeze({ formula: 'BLS*10' }),
    }),
  }),

  'kaelrath': Object.freeze({
    id: 'kaelrath',
    displayName: 'Kaelrath',
    base: Object.freeze(buildBase({
      Strength: plainStat(), Agility: plainStat(), Endurance: plainStat(),
      Intelligence: plainStat(), Perception: plainStat(), Willpower: plainStat(),
      Charisma: plainStat(), Resonance: plainStat(),
    })),
    derived: Object.freeze({
      'HP':      Object.freeze({ formula: 'Endurance*10 + Strength*2' }),
      'Stamina': Object.freeze({ formula: 'Endurance*8 + Strength*3 + Agility*3' }),
      // NOTE: Mana and Total Resonance are intentionally omitted until their
      // canonical formulas are provided. No guessed formulas here.
    }),
  }),

  'dnd': Object.freeze({
    id: 'dnd',
    displayName: 'D&D 5e',
    base: Object.freeze(buildBase({
      Strength: plainStat(), Dexterity: plainStat(), Constitution: plainStat(),
      Intelligence: plainStat(), Wisdom: plainStat(), Charisma: plainStat(),
    })),
    // Ability modifiers (floor((score-10)/2)) are deferred: engine-core.js does
    // not support a floor() function yet, and engine-core is preserved unchanged.
    derived: Object.freeze({}),
  }),
});