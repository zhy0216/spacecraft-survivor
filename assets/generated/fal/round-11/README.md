# Round 11 — Boss Seedance 2 motion reference

This round uses genmedia with `bytedance/seedance-2.0/image-to-video` to make a more
alive reference for the Boss cutout rig. The clip is reference-only: gameplay still uses
the deterministic FK particle skeleton in `src/render/enemyRig.ts`, so replays never
depend on video playback or a remote asset.

## Output

- `boss-brood-carrier-seedance2-vivid.mp4` — 4 s, 640×640, 24 fps, audio disabled.
- `preview/boss-motion-strip-vivid.png` — four-frame review strip.
- `results/boss-brood-carrier-seedance2.json` — genmedia request/seed metadata.

## Prompt

> Locked strict orthographic top-down camera. Animate the same colossal brood-carrier war beetle as a living boss sprite reference: heavy articulated legs move in an organic alternating gait with delayed follow-through, the abdomen subtly expands and contracts asymmetrically, four magenta brood sacs pulse in staggered sequence, the central orange iris opens and closes with a slow breathing rhythm, tiny armor plates flex without changing the silhouette. Keep the exact character identity, warm crimson black-violet magenta and hot-orange palette, crisp game-sprite rendering, centered framing, no camera motion, no zoom, no perspective change, no morphing, no extra creatures, no text. Motion should feel weighty, alive, and readable at gameplay scale.
