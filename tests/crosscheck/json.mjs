// JSON.parse's error messages, from Node, for the cross-check: random
// mutations of small JSON texts (escapes, Unicode, line breaks, numbers,
// literals, nesting), each with V8's message, or null when it parses.
//
// usage: node json.mjs <out.json> [cases]
import { writeFileSync } from "node:fs";

const out = process.argv[2] ?? "json-cases.json";
const N = Number(process.argv[3] ?? 20000);
let seed = Number(process.env.JSON_SEED ?? 12345);
const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
const pick = (a) => a[Math.floor(rnd() * a.length)];

const samples = [
  '{"Version": 3, "Meta": {"Duration": 1.5, "Fps": 30, "Loop": false}, "Curves": [{"Id": "A", "Segments": [0, 1, 0, 2.5e-3, -1]}]}',
  '[1, -0, 0.5, 1e10, 2E-5, -12.75, 0, 3]',
  '{"a": "x\\ny\\t\\"z\\\\", "b": "\\u00e9\\ud83d\\ude00\\u0041", "c": null, "d": true, "e": false}',
  '{\r\n  "k": [\r\n    1,\r\n    2\r\n  ],\n  "m": {"n": []}\r}',
  '["é", "😀", "日本語", "\\u2028", "a/b", "\\/"]',
  '{"FileReferences": {"Moc": "m.moc3", "Textures": ["t.png"]}, "Groups": [{"Name": "EyeBlink", "Ids": ["P"]}]}',
  '[[[[[]]]], {}, [{}], {"x": [{"y": {}}]}]',
  '"just a string with spaces"',
  '-123.456e+7',
  'true',
];
const inserts = ['"', "'", "{", "}", "[", "]", ",", ":", "\\", "u", "0", "1", "-", "+", ".", "e", "E", "x", "n", "t", "f",
  " ", "\t", "\n", "\r", "\r\n", "\u0001", "\u0000", "😀", "é", " ", " ", "/", "*", "NaN", "null", "tr", "1e", "\\u12"];

const cases = [];
const seen = new Set();
const add = (s) => {
  if (seen.has(s)) return;
  seen.add(s);
  let msg = null;
  try {
    JSON.parse(s);
  } catch (e) {
    msg = e.message;
  }
  cases.push({ in: s, msg });
};
for (const s of samples) add(s);
for (const s of ["", " ", "NaN", "Infinity", "undefined", "[object Object]", "nul", "{", "[", '"', "-", "01", "\\"]) add(s);
while (cases.length < N) {
  let s = pick(samples);
  const edits = 1 + Math.floor(rnd() * 3);
  for (let k = 0; k < edits; k++) {
    const i = Math.floor(rnd() * (s.length + 1));
    const r = rnd();
    if (r < 0.3) s = s.slice(0, i) + s.slice(i + 1);
    else if (r < 0.6) s = s.slice(0, i) + pick(inserts) + s.slice(i);
    else if (r < 0.8) s = s.slice(0, i) + pick(inserts) + s.slice(i + 1);
    else if (r < 0.9) s = s.slice(0, i);
    else s = s.slice(0, i) + s.slice(Math.max(0, i - 5), i) + s.slice(i);
  }
  // Sources come from UTF-8 bytes: never a lone surrogate.
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s)) continue;
  add(s);
}
writeFileSync(out, JSON.stringify(cases));
console.log(`${cases.length} JSON cases → ${out}`);
