# RPG Engine — Project Status

## Current Status

🚧 **Early Development — Modular RPG Foundation**

The project is currently developing the foundation of a self-contained RPG runtime implemented as a SillyTavern extension.

The immediate focus is the **modular statistics system and the architecture required to support configurable RPG rulesets**.

The project is **not yet a complete RPG engine**. Major systems such as combat, inventory, quests, effects, automated narrative synchronization, and external integrations remain planned work.

The goal is to build an **independent RPG engine that happens to use SillyTavern as its current host environment**, rather than building a collection of RPG features that depend on other SillyTavern extensions.

---

# Architectural Direction

The RPG extension is intended to own the complete RPG mechanics pipeline.

```text
                         SILLYTAVERN
                              │
                              ▼
                    ┌────────────────────┐
                    │   RPG EXTENSION    │
                    │                    │
                    │    RPG ENGINE      │
                    │         │          │
                    │   STATE MANAGER    │
                    │         │          │
                    │   STATE SYNC       │
                    │         │          │
                    │   EVENT SYSTEM     │
                    │         │          │
                    │   OPTIONAL AI      │
                    │                    │
                    │      UI / HUD      │
                    └────────────────────┘
                              │
                              ▼
                       NARRATOR / CHAT
```

SillyTavern provides the host environment and access to conversation functionality.

The RPG extension provides the RPG rules, state, calculations, and mechanical authority.

---

# Core Principle

The **RPG Engine is the authoritative source of mechanical truth**.

AI systems may:

- Detect potential mechanical events in narrative text.
- Classify actions.
- Extract structured information.
- Propose mechanical commands.

AI systems must not:

- Directly modify RPG state.
- Decide dice results.
- Calculate authoritative damage.
- Determine authoritative stat changes.
- Invent mechanical outcomes.
- Override engine rules.

All authoritative mechanical changes must pass through the RPG Engine.

```text
Narrative
    ↓
Event Detection
    ↓
Structured Event
    ↓
Validation
    ↓
RPG Engine
    ↓
Authoritative Result
    ↓
State Update
```

---

# Current Development Focus

## Modular Statistics System

The current development priority is the creation of a **modular, configurable statistics system**.

The system should allow RPG rulesets to define their own statistics without requiring the engine's core code to be rewritten for each world.

The statistics architecture should eventually support:

- Configurable stat definitions.
- Primary/core attributes.
- Derived statistics.
- Configurable formulas.
- Stat ranges.
- Modifiers.
- Temporary modifiers.
- Permanent modifiers.
- Stat dependencies.
- Validation.
- Runtime stat creation where appropriate.
- Ruleset-specific statistics.
- Programmatic stat access.
- Programmatic stat modification.
- Serialization and persistence.
- Clear separation between stat definitions and character state.

The statistics system is still under active development.

The exact API, data structures, formulas, and implementation details remain subject to development and testing.

---

# World-Agnostic Rules

The RPG engine should remain **world-agnostic**.

A world or RPG profile should define the statistics, formulas, mechanics, and vocabulary used by that particular ruleset.

For example, one ruleset may define:

```text
Strength
Agility
Endurance
Intelligence
Perception
Willpower
Charisma
Resonance
```

while another ruleset may define an entirely different collection of statistics.

The engine itself should not assume that a particular world uses a specific stat such as Resonance, Blessing, Strength, or any other world-specific mechanic.

World-specific mechanics should be represented through configuration/data wherever practical rather than being hard-coded into the engine.

---

# RPG Engine

The engine is intended to provide the authoritative mechanical runtime.

Planned responsibilities include:

- Character statistics.
- Derived statistics.
- Dice systems.
- Formula evaluation.
- Modifiers.
- Difficulty checks.
- Combat resolution.
- Damage calculation.
- Status effects.
- Level progression.
- Classes.
- Skills.
- Inventory.
- Equipment.
- Items.
- Quests.
- Mechanical flags.
- Persistent character state.
- World mechanical state.
- Saving and loading.
- State history / audit information.
- Import/export of RPG configurations.

The engine should eventually expose programmatic operations such as:

```text
rpg.roll()
rpg.attack()
rpg.levelUp()
rpg.createItem()
rpg.modifyStat()
rpg.addEffect()
rpg.getCharacter()
rpg.saveState()
```

The exact API is not finalized.

---

# State Management

RPG state is separate from narrative and lore knowledge.

The RPG system should own **mechanical state** such as:

- HP.
- MP.
- XP.
- Level.
- Statistics.
- Effects.
- Inventory.
- Equipment.
- Cooldowns.
- Combat state.
- Quest state.
- Mechanical flags.

Narrative knowledge does not need to be duplicated into the RPG engine.

Lore, character descriptions, history, relationships, world knowledge, and other narrative information may remain in SillyTavern's existing lore and memory systems.

The RPG engine should retrieve or receive only the information required for mechanical operation.

---

# State Synchronization

State Synchronization will connect the RPG runtime to SillyTavern's conversation.

Its intended responsibilities include:

1. Detecting relevant SillyTavern events.
2. Determining whether an RPG-related event may have occurred.
3. Passing relevant text/events to an event parser.
4. Converting recognized events into structured commands.
5. Sending validated commands to the RPG Engine.
6. Applying resulting state changes.
7. Making authoritative results available to the narrator.

State synchronization should be configurable.

Potential modes include:

- Off.
- Manual.
- Assistant messages only.
- Relevant events only.
- Fully automatic.

This system is planned work and is not yet considered complete.

---

# Optional AI Layer

The RPG extension may provide an optional AI service for event extraction and interpretation.

The AI layer exists primarily to translate narrative information into structured events.

Example:

```text
Narrator:

"After defeating the beast, you feel your experience surge.
You have reached level 5."

                ↓

Optional AI

                ↓

{
    "event": "level_up",
    "target": "player",
    "amount": 1
}

                ↓

RPG Engine

                ↓

Validate
Calculate
Update State
Generate Result
```

The AI does not perform the authoritative RPG calculation.

The AI provider should eventually be configurable.

Potential providers include:

- Google.
- NVIDIA.
- OpenRouter.
- Local models.
- Other compatible APIs.

The RPG engine must remain functional without an AI service.

---

# Event System

The extension should eventually provide its own internal event bus rather than relying on another SillyTavern extension for orchestration.

Potential events include:

```text
LEVEL_UP
STAT_CHANGED
XP_CHANGED
ITEM_ACQUIRED
ITEM_REMOVED
ITEM_EQUIPPED
ITEM_UNEQUIPPED
EFFECT_APPLIED
EFFECT_EXPIRED
COMBAT_STARTED
COMBAT_ENDED
DAMAGE_DEALT
CHARACTER_DEFEATED
QUEST_STARTED
QUEST_UPDATED
QUEST_COMPLETED
LOCATION_CHANGED
```

Other systems should be able to subscribe to these events.

For example:

```text
LEVEL_UP
   ├── State Manager
   ├── Quest System
   ├── UI / HUD
   └── Persistence
```

This allows the RPG extension to provide its own orchestration layer.

The internal event system is planned architecture and is not yet considered complete.

---

# Flowchart Relationship

[SillyTavern-Flowchart](https://github.com/bmen25124/SillyTavern-Flowchart) is **not a dependency** of this project.

Flowchart has been useful as a proof of concept for event-driven orchestration and has helped demonstrate capabilities that the RPG extension may eventually need to implement internally.

The intended architecture is:

```text
RPG Extension
      │
      ├── Works independently
      │
      └── Optional integration
               │
               ▼
            Flowchart
```

Not:

```text
RPG Extension
      │
      ▼
   Flowchart
      │
      ▼
    Works
```

The RPG extension may eventually expose hooks or events that other extensions, including Flowchart, can consume.

The RPG engine must remain fully functional without Flowchart or another orchestration extension.

---

# Narrative Resolution

The intended long-term interaction is:

```text
Narrator begins generation
        │
        ▼
Narrative reaches mechanical event
        │
        ▼
State Synchronization detects event
        │
        ▼
Optional AI extracts structured event
        │
        ▼
RPG Engine validates and resolves it
        │
        ▼
Authoritative result generated
        │
        ▼
Narrator receives result
        │
        ▼
Narrative continues
```

This prevents the narrator from becoming the authoritative source of mechanical outcomes.

This workflow is a long-term goal and is not currently complete.

---

# Dynamic Content

The engine should not require every possible NPC, item, or world object to exist in a giant predefined database.

Mechanical entities may be created dynamically during a campaign.

For example:

```text
Item received:

Gloves of Power
+1 Strength while equipped
```

The engine can create and track the mechanical representation while narrative details remain in the appropriate narrative/lore systems.

Dynamic content architecture will be developed alongside the core engine systems.

---

# Development Roadmap

## Phase 1 — Modular Foundation

**Current Phase**

- Basic extension structure.
- Core RPG engine prototype.
- Configurable ruleset foundation.
- Modular statistics architecture.
- Stat definitions.
- Derived-stat foundation.
- Formula system foundation.
- Modifier foundation.
- State architecture.
- Engine/UI separation.
- Initial testing framework.
- Formalize core engine APIs.

### Current Priority

The immediate priority is completing and stabilizing the **modular statistics system**.

Do not treat the statistics system as finished until its architecture, configuration model, calculations, validation, and API have been properly established and tested.

---

## Phase 2 — State Management

Planned:

- Character state manager.
- Persistent state storage.
- State serialization.
- State validation.
- State change history.
- Import/export.
- State recovery.

---

## Phase 3 — RPG Systems

Planned:

- Dice.
- Formula evaluation.
- Modifiers.
- Difficulty checks.
- Combat.
- Damage.
- Effects.
- Leveling.
- Classes.
- Skills.
- Inventory.
- Equipment.
- Items.
- Quests.

These systems should build on the modular foundation rather than introducing world-specific assumptions into the engine core.

---

## Phase 4 — Automation

Planned:

- SillyTavern event listeners.
- Internal event bus.
- Event classification.
- Structured event format.
- Optional AI adapter.
- Event validation.
- Automatic state synchronization.
- Configurable synchronization modes.

---

## Phase 5 — Narrative Integration

Planned:

- Mechanical result injection.
- Generation pause/resume.
- Narrator → Engine → Narrator workflow.
- Configurable synchronization behavior.
- Failure/recovery handling.

---

## Phase 6 — Integration and Extensibility

Planned:

- Public extension API.
- External extension hooks.
- Optional Flowchart integration.
- Additional AI providers.
- Local model support.
- Additional host integrations where practical.

---

# Design Goals

## Self-Contained

The RPG extension should work without Flowchart or another orchestration extension.

## Deterministic

Mechanical outcomes should be produced by the RPG engine rather than invented by the narrator AI.

## World-Agnostic

Different worlds should be able to use different statistics and rules without requiring the engine core to be rewritten.

## AI-Assisted, Not AI-Controlled

AI may interpret narrative information and propose events, but it does not own authoritative game state or mechanical resolution.

## Token-Efficient

Mechanical calculations and persistent state should be handled outside the narrator's context whenever practical.

## Extensible

Other SillyTavern extensions and external tools should eventually be able to interact with the RPG engine through documented events and APIs.

## Host-Independent in Principle

SillyTavern is the initial host environment, but the core RPG logic should remain sufficiently separated from SillyTavern-specific code that another host could potentially be supported later.

---

# Project Completion

The project should **not** be considered complete merely because the major systems listed in the roadmap exist.

Completion requires the core architecture and intended systems to be implemented, integrated, tested, and functioning together as a coherent self-contained RPG runtime.

Until then, this document should be treated as a description of:

- The current implementation state.
- The active development focus.
- The intended architecture.
- The planned development scope.

Status descriptions should be updated as implementation progresses.