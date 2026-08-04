# fal.ai round 1

First-pass visual assets generated for STARWRECK with `genmedia v0.7.0`.

- Investigation and evaluation: `docs/investigations/2026-08-02-fal-ai-game-assets.md`
- Reproducible Gate B prompt set: `results/gate-b-jobs.json`
- Cost ledger: `results/ledger.json`
- Raw fal responses: `results/*.json`

For enemies, towers, and supports:

- `*-source.png` is the original solid chroma-key output from FLUX 2 Pro.
- The matching file without `-source` is the locally processed RGBA candidate.
- `assets/game/fal-round-1/` contains the centered 128×128 runtime derivatives wired into Pixi.

Review sheets:

- `results/contact-enemies.png`
- `results/contact-towers.png`
- `results/contact-supports.png`
- `results/contact-64px.png`

Runtime integration:

- `src/render/generatedAssets.ts` owns the numeric type → texture mapping and per-file load fallback.
- `assets/game/fal-round-1/backgrounds/starwreck-nebula.webp` is a darkened, defocused derivative of
  the approved battle atmosphere probe with a locally composited sparse star field. It is rendered in
  screen space with subtle parallax so it never competes with the warm enemy silhouettes.
- `ships/scrapper-hull-source.svg` is the locally authored core-hull production source used when the
  built-in image generator was unavailable. Its runtime PNG sits behind the real deck grid, so future
  welded cells can still change the playable ship silhouette instead of being trapped inside one fixed sprite.
- Enemy art remains split across the existing four `ParticleContainer`s; position and facing are dynamic,
  while texture, tint, and scale stay static.
- Tower/support art is rebuilt only when `deck.revision` changes. Tower sprites then follow the real
  `cell.turretOffset`; support sprites stay fixed in ship-local space.
- Missing enemy textures fall back to the procedural silhouettes. Missing module textures leave the
  existing type-colored deck cell visible.
