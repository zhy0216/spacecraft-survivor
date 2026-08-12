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

## Round 2 (2026-08-12): salvage/XP pickup

`collect-0.wav` read as a coin: its energy sat at a 1977 Hz spectral centroid
with 20-39% of it above 3 kHz, and it rang for 0.74 s. STARWRECK already has a
coin currency (star coins, credited straight on kill with no pickup sound at
all), so the XP pickup had to stop borrowing that timbre.

`collect-1.wav` replaces it, generated with `sonilo/v1.1/text-to-sound-effects`
(`duration: 1`, `audio_format: wav`) from:

> soft warm synth blip pickup, short rounded tone with a quick upward bend,
> mellow wooden marimba character with a soft breathy tail, quick decay, dry,
> no metal, no bell, no reverb

Five candidates were generated; this one was the only one with a real pickup
envelope (the others were flat one-second drones). The runtime copy is trimmed
to 0.46 s, faded in over 4 ms and out on a quarter-sine tail from 0.16 s,
downmixed to 44.1 kHz mono PCM and normalized to 0.80 peak:

```bash
ffmpeg -i generated/collect-1.wav \
  -af "atrim=0:0.46,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.004,afade=t=out:st=0.16:d=0.30:curve=qsin,volume=1.3125" \
  -ac 1 -ar 44100 -c:a pcm_s16le ../game/audio/sfx/collect.wav
```

Result: 365 Hz fundamental, ~340 Hz centroid, 89-94% of the energy below
500 Hz. Its bus gain in `src/render/audio.ts` moved 0.17 -> 0.20 to hold the
same A-weighted loudness two octaves lower.
