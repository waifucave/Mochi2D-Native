# Fuzz corpora

Starting corpora for the fuzz targets, one folder each: `moc/` for
`fuzz_moc`, `json/` for `fuzz_json`, `anim/` for `fuzz_anim`, `model/` for
`fuzz_model` (one file of the synthetic model folder of
`tests/support/model_folder.hpp`, its index first). CI's fuzz job
starts from them, and the unit tests replay the seeds.

They hold:

- the seeds that the unit test binary writes (`mochi2d_tests --write-seeds
  <dir>`): small synthetic `.moc3` files of versions 1–5, written field by
  field with the library's own writer (`tests/support/tiny_model.hpp`), and
  hand-written scenario, settings, motion, expression, physics, pose, user
  data and display info files and a generated WAV sound; for `model/`, each
  file of the model folder, and its physics file at Mochi2D 0.16.0's rates
  whose steps never ended (`1e+308`, `1e309`, `5e-324`);
- inputs that libFuzzer found from those seeds (with AddressSanitizer and
  UndefinedBehaviorSanitizer), merged with `-merge=1` into a smallest set
  that keeps their coverage. File names are libFuzzer's content hashes.

No model data of any third party is involved, and nothing comes from a test
model or is derived from one.

## How they are made

```sh
fuzz/corpus/update.sh 600   # seconds per target; needs Clang with libFuzzer
```

The script builds the seeds and the fuzz targets in a temporary folder,
fuzzes each target from the seeds and the current corpus, and replaces the
folder with the merged result. Inputs are limited to 6 KB for `moc/` (the
seed models' size; about 3.0 MB in all) and 16 KB for the others (about
1.2 MB together), after a long run of 45 minutes per target.
