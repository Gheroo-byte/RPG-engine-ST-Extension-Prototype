# SillyTavern RPG Engine

A configurable, world-agnostic RPG engine built as a SillyTavern extension.

The goal is to provide a persistent mechanical RPG system that works alongside an AI narrator without requiring the narrator to perform RPG calculations or carry the entire game's mechanical state in its context.

## Project Status

🚧 Early development — architecture and foundation being established.

## Core Architecture

The engine is designed around the following pipeline:

SillyTavern Data  
→ Lore Parser / Indexer  
→ RPG Knowledge  
→ RPG Engine  
→ Structured Communication  
→ Narrator AI

### RPG Engine

The deterministic engine handles:

- Character stats and derived statistics
- Dice and configurable dice types
- Formula evaluation
- Modifiers
- Difficulty checks
- Combat calculations
- Damage
- Status effects
- Leveling
- Persistent character and world state
- Inventory and equipment
- Saving and loading
- Audit history and state changes
- Import/export of RPG configurations

### AI Integration

A small, fast AI can act as a mechanical interpreter between the narrator and the RPG engine.

Its job is to identify explicit mechanical actions or state changes from narrative text and translate them into structured commands.

The fast AI does not determine game mechanics or perform calculations.

The RPG engine remains the authoritative source for mechanical results.

### Narrative Resolution — Engine Tools / Actions

The intended narrative architecture is **Narrator ⇄ RPG Engine tools/actions**, not a two-pass,
pause-and-resume generation loop. The narrator requests mechanical operations while generating;
the engine resolves them authoritatively and returns a structured result the narrator can continue from:

1. Narrator requests an action (roll/check, attack, damage, use item, modify state, check stat, etc.).
2. Engine validates the request.
3. Engine executes it and computes the authoritative result.
4. Engine returns the result to the narrator.
5. Narrator continues naturally using the actual mechanical result.

The narrator stays responsible for prose, interpretation, and scene narration. The RPG engine stays
responsible for authoritative mechanics, calculations, state, formulas, rolls, modifiers, and validation.

Implementation of the tools/actions bridge is a later phase (validate-then-execute). A fast AI connection
profile may be used for engine-side background tasks (intent detection, item parsing, ambiguous request
interpretation, structured-data extraction) using the main narrator connection as the fallback, but it is
not inserted into every narrator action.

## World Profiles

The engine is intended to be world-agnostic.

Different worlds can define completely different mechanics.

Example:

**Kaelrath**
- Strength
- Agility
- Endurance
- Intelligence
- Perception
- Willpower
- Charisma
- Resonance

**Shattered Dominion**
- Strength
- Agility
- Endurance
- Intelligence
- Perception
- Willpower
- Charisma
- Blessing

World profiles can be imported, exported, modified, and switched without changing the engine itself.

## Dynamic Inventory

Items are not required to exist in a massive predefined database.

Items can be introduced naturally during a campaign.

For example:

```text
Item received x1 Gloves of Power
When equipped: +1 STR
