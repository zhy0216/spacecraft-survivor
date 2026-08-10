# STARWRECK audio assets

Generated on 2026-08-10 with `genmedia v0.7.0`.

- Background music: `fal-ai/lyria2`
- Sound effects: `sonilo/v1.1/text-to-sound-effects`
- Source downloads: `generated/`
- Runtime mix: `../game/audio/`

The background track was generated as a 48 kHz stereo WAV, then turned into a
30.77-second loop by crossfading its final two seconds into its opening two
seconds. The runtime MP3 is loudness-normalized to -18 LUFS.

The sound effects cover all audio bus events: four weapon families, kill,
hull/spark damage, salvage collection, upgrade, module placement, broadside,
elite warning, boss warning, and ship explosion. Runtime copies are trimmed to
the useful transient, faded at the tail, converted to 44.1 kHz mono PCM, and
mixed at event-specific gains in `src/render/audio.ts`.

The generated source files are retained so the mix can be rebuilt or adjusted
without spending another generation request.
