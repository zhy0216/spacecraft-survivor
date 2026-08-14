# Round 7 enemy rigs and brood-carrier boss

This round adds production cutout parts for every enemy except the already-rigged swarm leech, plus a complete replacement Boss. Nano Banana Pro produced the source art and Seedance 2 supplied motion references; the runtime animation is the project's lightweight FK particle rig, not video playback.

## Runtime outputs

- `assets/game/fal-round-7/enemies/tail-maggot/`: head, neck, body, tail
- `assets/game/fal-round-7/enemies/charging-beetle/`: body, head, left/right leg assemblies
- `assets/game/fal-round-7/enemies/spore-cannon/`: body, siphon, anchor limb, pod cluster
- `assets/game/fal-round-7/enemies/boss-brood-carrier/`: body, head, mirrored left/right leg, egg sac, iris
- `assets/game/fal-round-7/enemies/boss-brood-carrier.png`: full-sprite fallback
- `assets/generated/fal/round-7/results/rig-rest-pose.png`: assembled rest-pose review sheet

## Spend

- Nano Banana Pro / edit: 7 successful images × $0.15 = **$1.05**.
- Seedance 2: 4 clips × 4 seconds. The local price endpoint reports **$0.014 per unit** but the result receipts do not expose billed units. Nominally treating one second as one unit gives **$0.224**.
- Nominal successful-call total: **$1.274**, far below the $50 cap. Two rejected 422 validation attempts are not counted.

## Image prompts

### Boss candidate 01 — selected

Model: `fal-ai/nano-banana-pro`  
Request: `01a00125-5c67-7fa2-a3c6-809c127321fe`

> Use case: stylized-concept. Asset type: single top-down boss sprite for STARWRECK. Primary request: redesign the final boss as an original colossal brood-carrier war beetle that visibly produces smaller alien attackers. Scene/backdrop: perfectly flat solid #00ff00 chroma-key background for local removal. Subject: one complete gigantic alien beetle queen-warship, strict orthographic top-down view, front points exactly toward the top edge, enormous broad armored wedge head, six thick articulated legs, layered dark crimson and black-violet chitin, bright hot-orange fissures, a huge exposed magenta brood abdomen, four clearly readable glowing egg sacs and two opening spawn vents along the rear flanks, central pulsing hatch that looks capable of releasing small creatures. Style/medium: premium painterly science-fiction game sprite, crisp controlled material rendering, strong silhouette readable at gameplay scale, enemy organic technology, no player-like machinery. Composition/framing: single full creature centered, nearly fills the square but keeps 10 percent clean padding, symmetrical mass with slightly asymmetric battle damage, all limbs fully visible, no perspective foreshortening. Color palette: dark crimson, black-violet, magenta tissue, hot orange glow only; absolutely no blue, cyan, teal, green, silver-blue, or cool player-faction armor. Constraints: background must be exactly uniform #00ff00 with no shadow, gradient, texture, floor, reflection, smoke, glow spill, or lighting variation; do not use #00ff00 in the creature; one creature only; no larvae outside the body; no text, letters, numbers, logo, border, HUD, or watermark. Avoid: ordinary Earth beetle, cute queen, generic robot, tank, spaceship cockpit, side view, three-quarter view, blue armor.

### Boss candidate 02 — alternate

Model: `fal-ai/nano-banana-pro`  
Request: `01a00127-4b13-7163-ab75-77451611d20f`

> Use case: stylized-concept. Asset type: single top-down boss sprite for STARWRECK. Primary request: one original colossal brood-forge war beetle boss, darker and more alien than an Earth insect, visibly built to summon lesser creatures. Scene/backdrop: perfectly flat solid #00ff00 chroma-key background. Subject: strict orthographic top-down creature with its armored wedge face pointing exactly toward the top edge; six heavy articulated legs; a split asymmetric black-violet and deep-crimson carapace; a huge exposed rear brood foundry with four glowing magenta egg sacs, two open side vents, and a central iris hatch; hot orange internal cracks; thick armored silhouette with battle damage. Style/medium: premium painterly science-fiction game sprite, crisp edges and simplified large shapes that remain readable when small. Composition/framing: single full creature centered with generous clean padding, all limbs visible, no perspective, no shadow. Color palette: deep crimson, burgundy, black-violet, magenta flesh and hot orange emission only; absolutely no blue, cyan, teal, green, cool gray or silver-blue on the creature. Constraints: uniform #00ff00 background with no texture, gradient, floor, reflection, cast shadow, smoke, or glow spill; no green inside creature; no separate larvae; no text, logo, watermark, border, HUD. Avoid: cute, clean robot, ordinary beetle, tank, player spaceship, blue armor, side view, three-quarter view.

### Tail maggot parts

Model: `fal-ai/nano-banana-pro/edit`  
Request: `01a00127-481c-7aa1-a567-654956f0a824`

> Use case: precise-object-edit. Asset type: cutout animation part sheet for a top-down game enemy. Input image: the approved tail maggot enemy sprite, identity and palette reference. Primary request: decompose this exact same creature into four clean reusable opaque parts for a lightweight FK skeleton: (1) armored horned head with jaws, (2) short neck segment, (3) one complete mid-body armored segment suitable for repeating four times, (4) tapered curved tail tip. Preserve the original dark crimson, burgundy and warm orange bioluminescent palette, painterly rendering, scale language and top-down orthographic view. Layout: 2 by 2 grid with no lines and no labels; head top-left facing upward, neck top-right facing upward, body segment bottom-left facing upward, tail tip bottom-right facing upward. Each part must be fully separated from every other part by a wide gap, complete with clean overlapping joint ends, no missing edges, no extra anatomy. Scene/backdrop: perfectly flat uniform #00ff00 chroma-key background. Constraints: change only decomposition and layout; keep creature identity and materials; exactly four parts; no assembled creature; no duplicate parts; no shadows, gradients, texture, floor, reflections, glow spill, text, letters, numbers, border, logo, watermark; do not use green inside parts.

### Charging beetle parts

Model: `fal-ai/nano-banana-pro/edit`  
Request: `01a00127-4855-7823-9929-8fa27d445a1e`

> Use case: precise-object-edit. Asset type: cutout animation part sheet for a top-down game enemy. Input image: the approved charging beetle enemy sprite, identity and palette reference. Primary request: decompose this exact same creature into four clean reusable opaque parts for a lightweight FK skeleton: (1) rear abdomen and thorax core, (2) massive forward wedge head and carapace shield, (3) one complete left articulated leg with root joint, (4) one complete right articulated leg with root joint. Preserve the original dark crimson, scarlet and hot orange bioluminescent palette, painterly rendering and strict top-down orthographic view. Layout: 2 by 2 grid with no lines and no labels; abdomen top-left pointing upward, head shield top-right pointing upward, left leg bottom-left with root toward center, right leg bottom-right with root toward center. Every part fully separated by a wide gap, complete edges, rounded overlap at joints, no extra anatomy. Scene/backdrop: perfectly flat uniform #00ff00 chroma-key background. Constraints: exactly four parts; no assembled creature; no duplicates; preserve identity and materials; no blue, cyan or teal; no shadows, gradients, texture, floor, reflections, glow spill, text, letters, numbers, border, logo, watermark; do not use green in parts.

### Spore cannon parts

Model: `fal-ai/nano-banana-pro/edit`  
Request: `01a00127-4831-7011-bef9-8a4aba8a1ed6`

> Use case: precise-object-edit. Asset type: cutout animation part sheet for a top-down game enemy. Input image: the approved spore cannon enemy sprite, identity and palette reference. Primary request: decompose this exact same creature into four clean reusable opaque parts for a lightweight FK skeleton: (1) central ribbed body and spore sac, (2) large dorsal mortar siphon barrel with a round root, (3) one complete splayed anchor limb suitable for rotating and repeating three times, (4) one glowing side spore-pod cluster. Preserve the exact violet, dark crimson, magenta and warm orange palette, painterly rendering and strict top-down orthographic view. Layout: 2 by 2 grid with no lines and no labels; body top-left with front upward, siphon top-right pointing upward, anchor limb bottom-left with root pointing toward center, pod cluster bottom-right. Every part fully separated by a wide gap, complete edges and clean overlap joints. Scene/backdrop: perfectly flat uniform #00ff00 chroma-key background. Constraints: exactly four parts; no assembled creature; no duplicates; preserve identity; absolutely no blue, cyan or teal; no shadows, gradients, texture, floor, reflection, glow spill, text, letters, numbers, border, logo, watermark; do not use green inside parts.

### Boss part sheet

Model: `fal-ai/nano-banana-pro/edit`  
Request: `01a00129-4931-7d12-b18d-ba342d890b3a`

> Use case: precise-object-edit. Asset type: cutout animation part sheet for the final top-down boss. Input image: the approved colossal brood-carrier war beetle; preserve this exact identity, palette and rendering. Primary request: decompose the same creature into exactly six clean reusable opaque parts for a lightweight FK skeleton: (1) rear brood abdomen and thorax core without legs, (2) massive forward wedge head and upper carapace shield, (3) one complete left heavy articulated leg with root joint, (4) one complete right heavy articulated leg with root joint, (5) one glowing magenta egg sac organ suitable for repeating four times, (6) the central orange-magenta iris spawn hatch. Layout: clean 3 by 2 grid, no grid lines and no labels; top row abdomen core, head shield, left leg; bottom row right leg, egg sac, iris hatch. Keep each part fully separated by a wide gap, complete edges, rounded hidden overlap areas at joints, no missing pixels and no extra anatomy. Strict orthographic top-down view, front direction upward. Preserve dark crimson, black-violet, magenta flesh and hot orange glow; absolutely no blue, cyan, teal or cool metal. Scene/backdrop: perfectly flat uniform #00ff00 chroma-key background. Constraints: exactly six parts; no assembled creature; no duplicate sheet; no shadows, gradients, texture, floor, reflection, smoke, glow spill, text, letters, numbers, border, logo, HUD or watermark; do not use green inside any part.

### Boss supplemental organs

Model: `fal-ai/nano-banana-pro/edit`  
Request: `01a0012d-0434-7b91-b2e6-370ee516f0fd`

> Use case: precise-object-edit. Asset type: supplemental cutout parts for the approved top-down brood-carrier boss. Input image: preserve this exact boss identity and palette. Generate exactly three isolated production parts only: (1) one complete heavy articulated beetle leg, root joint at top and claw at bottom, (2) one single round glowing magenta-orange egg sac organ with a small dark tissue collar around its base, (3) one separate central orange-magenta iris spawn hatch with closed armored petals. Layout: large triangle with very wide empty gaps; leg alone on the left, egg sac alone upper-right, iris hatch alone lower-right. No assembled creature, no body, no head, no second leg, no extra organs, no duplicate. Strict top-down orthographic rendering; preserve dark crimson, black-violet, magenta and hot orange palette; no blue or cyan. Perfectly flat uniform #00ff00 chroma-key background with no shadow, gradient, texture, floor, reflection or glow spill. Each object fully separated with complete crisp edges. No text, letters, numbers, labels, border, logo, HUD or watermark; do not use green inside any part.

## Motion-reference prompts

All four clips use `bytedance/seedance-2.0/image-to-video`, 4 seconds, 640×640, 24 fps, audio disabled.

### Tail maggot

Request: `01a00129-4957-7fb3-854d-b05f5bee184b`, seed `28716830`

> Locked orthographic top-down camera. The same alien tail maggot crawls forward toward the top of frame in place: armored body segments make a smooth traveling S-wave from head to tail, tiny legs ripple in sequence, horned head dips once, tail whips with delayed follow-through. Preserve exact creature identity, silhouette, dark crimson and orange palette and sprite-like lighting. No camera motion, no rotation of the whole frame, no zoom, no morphing, no new limbs, no extra creatures, no text.

### Charging beetle

Request: `01a00129-496a-70c2-ba41-9b29730797c8`, seed `997111869`

> Locked orthographic top-down camera. The same charging beetle braces and prepares a charge while staying centered: six legs stomp in an alternating gait, the heavy wedge carapace lowers and compresses, orange fissures brighten, then the legs kick backward for one short forceful lunge pose without leaving frame. Preserve exact identity, silhouette, crimson palette and sprite rendering. No camera motion, no zoom, no whole-frame rotation, no morphing, no extra creatures, no text.

### Spore cannon

Request: `01a00129-4836-7301-a7fb-c46478ae1d6e`, seed `1096980091`

> Locked orthographic top-down camera. The same alien spore cannon remains anchored in place: three anchor limbs flex and grip in staggered rhythm, ribbed central body slowly inflates, magenta side pods pulse, the dorsal mortar siphon swells and recoils once as if firing. Preserve exact identity, silhouette, violet-crimson-orange palette and sprite rendering. No projectile, no camera motion, no zoom, no rotation of the whole creature, no morphing, no new limbs, no extra creatures, no text.

### Boss summon

Request: `01a00129-489c-7851-b2ac-8bf5eefd9a9e`, seed `16151772`

> Locked strict orthographic top-down camera on the same colossal brood-carrier war beetle. Heavy legs stomp slowly in alternating pairs, front wedge armor lowers with massive weight, four magenta egg sacs pulse one after another, the central orange brood iris opens and visibly ejects three tiny crimson larval silhouettes that crawl outward, then the iris closes. Preserve exact boss identity, warm crimson-violet-orange palette and full silhouette. Green backdrop may remain perfectly flat. No camera movement, no zoom, no perspective shift, no blue or cyan, no morphing, no extra boss, no text.
