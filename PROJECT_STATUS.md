# Project Status
**Last updated:** 2026-08-30

## Purpose
A world/profile-driven RPG mechanics extension for SillyTavern. It should run alongside a chat (not hijack it), with the user as campaign-creator and eventually the occasional "🎲 Run Explosion" moment.

## Current Status
- [x] Repo scaffolded (RPG-engine-ST-extension → prototype)
- [x] Core deterministic engine (formulas, dice, checks, overrides)
- [x] 37/37 tests passing
- [x] UI shell (9 sections + master drawer) registered in SillyTavern
- [x] Settings persistence proved (Enabled toggle survives reload)
- [ ] Character/Rules/Effects real data
- [ ] Narrator integration (two-pass ACTION → RESULT)

## What Works Today
| Piece | File | Notes |
|-------|------|-------|
| Formula tester | index.js | Sends a formula to engine-core.js and renders the result breakdown |
| Master enable toggle | index.js | Persisted via `extensionSettings`; demonstrated by page reload |
| Drawer expand/collapse | index.js | Works on all 9 sections |
| Stats system | index.js + rulesets.js | Ruleset-based, structured `{ value, potential? }` stats, lazy derived values |
| Path handling | index.js | `EXTENSION_FOLDER = 'third-party/RPG-engine-ST-Extension-Prototype'` verified against ST 1.18 source |

## What's intentionally not built yet
- Real character CRUD beyond the form (e.g. importing from SillyTavern persona)
- Rules (named actions → opposed/static/freeform)
- Effects (buffs/debuffs, timers)
- Save/export/import (with `schemaVersion`)
- Any chat/narrator integration

## Design Notes
See README and `rulesets.js` header for the layered architecture:
`BASE → POTENTIAL/CAP → DERIVED → MODIFIERS → ACTION FORMULAS`.
The engine does not know the * lore concepts* (what Resonance means, etc.), only the data names and numeric relationships.