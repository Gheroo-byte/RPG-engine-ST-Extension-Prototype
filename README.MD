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

### Narrative Resolution

Mechanical actions follow a two-stage process:

1. The narrator writes up to the point where an action requires mechanical resolution.
2. Generation pauses.
3. A fast AI identifies the mechanical action.
4. The RPG engine resolves the action.
5. The result is returned to the narrator.
6. The narrator continues the scene using the actual mechanical result.

This prevents the narrator from describing an outcome before the RPG engine has determined it.

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
