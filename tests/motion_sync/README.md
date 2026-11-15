# Motion sync: the neutral templates and the test sounds

## The neutral voice profile in the library

Without a voice profile, Mochi2D's motion-sync analysis compares each
window's spectrum with the templates of a neutral synthetic voice in four
sizes (pitch 105, 150, 205 and 270 Hz, formants scaled by 0.97, 1.06, 1.16
and 1.26): `neutralVoiceProfile()` in Mochi2D's
`src/anim/motion-sync/analysis.ts` synthesizes each vowel for 0.6 s with its
vowel synthesizer (`voice-synth.ts`, cascade formant resonators) and
calibrates on it.

The synthesizer's formant filters make test sounds only, so the
library does not synthesize at run time: it holds the profile as data,
`src/framework/motion_sync_neutral.cpp` (exact hexadecimal floating-point
values), and the synthesizer is test code (`tests/support/motion_sync_support.*`).

How the file is made, and how it is checked:

```sh
build/tests/mochi2d_make_neutral > src/framework/motion_sync_neutral.cpp
```

`mochi2d_make_neutral` (`make_neutral.cpp`) runs this project's port of the
synthesizer and the library's own `VoiceCalibration` exactly as
`neutralVoiceProfile()` does. The unit tests compare the committed table
with a fresh build of it (`motion_sync_analysis`), and the motion-sync
cross-check (`tests/crosscheck/motion_sync.sh`) compares
`mochi2d_make_neutral --json` with the JSON of Mochi2D's own
`neutralVoiceProfile()`, byte for byte. Nothing in it comes from a model.

## The test sounds

The unit tests (`tests/unit/motion_sync.inc`) and the fuzz seeds make their
sounds at run time with the same port: vowels of a male and a female voice,
glides between vowels, white and pink noise (Mochi2D's seeded mulberry32),
silence, a tone, bursts, and WAV files in every encoding the reader takes.
The cross-check makes its sounds with Mochi2D's own test support
(`test/support/motion-sync.ts`) and feeds the same WAV files to both
sides. None of them is committed, except the fuzz corpus's few seeds and
what libFuzzer found from them (`fuzz/corpus/README.md`).
