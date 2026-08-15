# STARWRECK 《星骸》

A warship you weld together tile by tile, turning in an endless bug swarm to bring your broadside to bear.
Space survivors-like × deck-space puzzle (Backpack-like).

- Game design doc: [GDD.md](GDD.md) (Chinese)
- MVP task breakdown: [todos/](todos/README.md) (Chinese)
- 中文版:[README.zh.md](README.zh.md)

## Quick Start

```bash
npm install
npm run dev        # http://localhost:5173 —— the playable build, jump right in
npm test           # unit tests: RNG / object pool / spatial hash / World determinism / i18n quality gates
npm run test:i18n  # i18n gates only (also part of npm test)
npm run build      # tsc type-check + production build
```

## Current Status: Complete Playable MVP

Title screen (continue last run / start new run / settings) → two base towers drop at random (tower types and slots both drawn from the run seed) → deck-mowing combat (4 legs + elite + boss) → three-choice upgrades / refit every two minutes (dry-dock shop, free reroll, paid repair) → results into the codex → meta progression unlocks new towers and edicts.

In battle: `Esc` pauses (resume / save & quit / restart run / retry / settings / mute); `?seed=123` reproduces the same run — same seed, same starting towers.

### Saves

Three separate storage keys, each independent:

| | Key | What | Written when |
|---|---|---|---|
| Meta progress | `starwreck.progress.v1` | cross-run unlocks, cumulative counters | end of every run |
| Run save | `starwreck.run.v1` | **the entire true state of this run** (incl. rng cursor and entities on the field) | upgrade/refit pause, pause, page hidden |
| Settings | `starwreck.settings.v1` | volume/mute/screen shake/damage numbers/hit-stop | on every change |

The run save has a single slot, overwritten each time, and **deleted when the run ends** (keep it around and the title-screen "Continue" would lead into a battle that is already over).
The exact schema and field table live in the file header of [`src/sim/runSave.ts`](src/sim/runSave.ts) — what to persist follows the "what is true state" checklist of `World.checksum()` item by item. Acceptance criterion: **after loading, the checksum is unchanged — and stays unchanged every frame thereafter** (that's what `runSave.test.ts` pins down).

### Settings

Every option is wired to a real effect (volume → `render/audio`, screen shake & damage numbers → `Renderer.setEffects`, kill hit-stop → the freeze window in `main`); no decorative toggles. Title and pause share the same settings screen.

### Run Log & Upload

Every run records a **run log** (`src/sim/runLog.ts`) from its very first frame: kills one by one, every upgrade/reroll/shop transaction, every transition (leg / boss / hit / sunk / run end). It is write-only: never read back, not part of the checksum, not in saves. "Upload this run's log" (U) on the results card POSTs the timeline + outcome readouts to the configured endpoint.

Production runs on Cloudflare Workers: the static game is served by Workers Static Assets, and `POST /api/logs` validates and writes each run's JSON log to the private R2 bucket `starwreck-run-logs`. The D1 database `starwreck-logs` only holds monthly hard-quota counters: at most 1 MiB per log, at most 5,000 logs per month with no more than 4 GB total body; hitting either cap rejects the R2 write. R2 logs are deleted automatically after 30 days by a lifecycle rule, and there is no public read API. `starwreck.logEndpoint.v1` still overrides the default same-origin endpoint for local analyzer debugging.

```bash
npm run cf:types    # regenerate Worker binding types after wrangler config changes
npm run test:worker # validate upload & hard quotas against Workers runtime + local R2/D1
npm run deploy      # build & deploy static assets, Worker, R2 and D1 bindings
```

**Dev mode**: append `?debug` to the URL to restore the greybox tuning panel (entity counts, feel parameters, wave readouts, 1000-enemy stress test) and the `· dev` tab.
`?seed=123` sets the seed — two runs with the same seed must produce the same checksum at the same tick.
`?locale=pseudo` (dev mode only) switches to the **pseudo language** (`en-XA`): English copy inflates 30–40% in place, for layout stress testing.

## Languages / i18n

Supports **Simplified Chinese (zh-CN, default)** and **English (en)**; the `Auto` setting follows the system language.
The language setting lives at **Title / Pause → Settings → Language** (three-way cycle: Auto → 简体中文 → English); the preference persists, applies instantly, and switching mid-battle never interrupts the run.

Full rules for adding player-facing copy, the glossary, pseudo-language usage and the manual acceptance checklist: [`docs/i18n.md`](docs/i18n.md). In one line: **all copy goes through `t()`, written in both languages, translation strings only ever go into `textContent`, and sim/data/core never touch i18n** — enforced by the i18n quality gates in `npm test` (hardcoded-Chinese AST scan / key & interpolation parity / dependency boundary / cross-language determinism / storage regression).

## Three Architecture Laws

1. **`sim/` is pure logic, never imports pixi/DOM** — in exchange for determinism, Node unit tests, and swappable rendering.
2. **Fixed 60 Hz timestep** (`core/loop.ts`); the render layer interpolates between each entity's prev/cur positions using alpha.
3. **Entities are plain objects from an object pool; two UI layers**: in-world UI is Pixi (ParticleContainer), menus/cards/panels are DOM (`#ui` overlay).

## Directory

```
src/core     loop, seeded RNG, object pool, spatial hash, input
src/sim      world state & rules (pure TS, no render deps)
src/render   Pixi rendering, camera, greybox textures
src/ui       DOM overlay: title, pause, HUD, upgrades, refit shop, codex, game over, debug panel
src/data     numeric content config (towers / enemies / waves / edicts / affixes / economy)
src/i18n     locale resources & quality gates (zh-CN / en, pseudo)
worker/      Cloudflare Worker: POST /api/logs → R2 + D1 quotas
todos/       MVP issue breakdown & implementation order
docs/        i18n guide, design investigations
```

## Auto-balance CLI

```bash
npm run balance              # solve the numeric tables and run the seven judge tests as the acceptance gate
npm run balance -- --dry-run # print the solution without writing files or running tests
```
