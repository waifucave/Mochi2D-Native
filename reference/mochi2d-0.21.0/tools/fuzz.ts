#!/usr/bin/env node
/**
 * npm run fuzz -- [--iterations N] [--target name,…] [--seed S] [--time-limit ms]
 *                 [--hang ms] [--out dir]
 *
 * The long fuzzing run of the loaders (tools/lib/fuzz.ts): N mutated inputs
 * per target (default 20000), each target in a child process run with
 * --expose-gc so that memory is measured, under a watchdog: a child that
 * makes no progress for `--hang` milliseconds (default 30000) is stopped, its
 * input recorded as a hang, and the target resumes with the next inputs.
 * Failing inputs go to `--out` (default out/fuzz), one file each, with
 * failures.json listing them. Exits 1 if anything failed.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, repoRoot } from "./lib/cli.js";
import { TARGETS, fuzz, type FuzzFailure } from "./lib/fuzz.js";

interface Record_ {
  target: string;
  reason: string;
  file: string;
  ms: number;
}

async function child(
  target: string,
  seed: number,
  iterations: number,
  out: string,
  timeLimit: number,
) {
  const t = TARGETS.find((x) => x.name === target);
  if (!t) throw new Error(`unknown target ${target}`);
  const current = join(out, `${target}.current`);
  const failures = await fuzz(t, {
    iterations,
    seed,
    timeLimit,
    before: (input, i) => {
      writeFileSync(current, input);
      if (i % 200 === 0) process.stdout.write(`progress ${i}\n`);
    },
  });
  for (const f of failures) process.stdout.write(`failure ${JSON.stringify(encode(f))}\n`);
  process.stdout.write("done\n");
}

const encode = (f: FuzzFailure) => ({ ...f, input: Buffer.from(f.input).toString("base64") });

/** Runs one target's inputs in a child, restarting it after a hang; returns the failures. */
async function runTarget(
  name: string,
  o: { seed: number; iterations: number; out: string; timeLimit: number; hang: number },
): Promise<Record_[]> {
  const records: Record_[] = [];
  const save = (reason: string, input: Uint8Array, ms: number) => {
    const file = join(o.out, `${name}-${records.length}.bin`);
    writeFileSync(file, input);
    records.push({ target: name, reason, file, ms });
    console.log(`  ${name}: ${reason}`);
  };
  let seed = o.seed;
  let left = o.iterations;
  const self = fileURLToPath(import.meta.url);
  while (left > 0) {
    const batch = left;
    const done = await new Promise<{ ran: number; hung: boolean }>((resolveRun) => {
      const p = spawn(
        process.execPath,
        [
          "--expose-gc",
          self,
          "--child",
          name,
          "--seed",
          String(seed),
          "--iterations",
          String(batch),
          "--out",
          o.out,
          "--time-limit",
          String(o.timeLimit),
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      let ran = 0;
      let buffer = "";
      const current = join(o.out, `${name}.current`);
      const watchdog = setInterval(() => {
        const since = existsSync(current) ? Date.now() - statSync(current).mtimeMs : 0;
        if (since > o.hang) {
          clearInterval(watchdog);
          save(`hang: no progress for ${o.hang} ms`, readFileSync(current), since);
          p.kill("SIGKILL");
        }
      }, 1000);
      p.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.startsWith("progress ")) ran = Number(line.slice(9));
          else if (line.startsWith("failure ")) {
            const f = JSON.parse(line.slice(8)) as FuzzFailure & { input: string };
            save(f.reason, Buffer.from(f.input, "base64"), f.ms);
          }
        }
      });
      p.on("exit", (code, signal) => {
        clearInterval(watchdog);
        if (signal === "SIGKILL") resolveRun({ ran, hung: true });
        else {
          if (code !== 0)
            save(`the child exited with ${code} (out of memory?)`, readFileSync(current), 0);
          resolveRun({ ran: batch, hung: false });
        }
      });
    });
    left -= done.hung ? Math.max(1, done.ran) : done.ran;
    seed += 7919; // a fresh sequence for what is left after a hang
  }
  return records;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const out = resolve(
    typeof args.options.out === "string" ? args.options.out : join(repoRoot(), "out", "fuzz"),
  );
  const num = (k: string, d: number) =>
    typeof args.options[k] === "string" ? Number(args.options[k]) : d;
  mkdirSync(out, { recursive: true });
  if (typeof args.options.child === "string")
    return child(
      args.options.child,
      num("seed", 1),
      num("iterations", 1000),
      out,
      num("time-limit", 2000),
    );
  const names =
    typeof args.options.target === "string"
      ? args.options.target.split(",")
      : TARGETS.map((t) => t.name);
  const o = {
    seed: num("seed", 1),
    iterations: num("iterations", 20000),
    out,
    timeLimit: num("time-limit", 2000),
    hang: num("hang", 30000),
  };
  const all: Record_[] = [];
  for (const name of names) {
    const t0 = Date.now();
    const records = await runTarget(name, o);
    all.push(...records);
    console.log(
      `${name}: ${o.iterations} inputs, ${records.length} failures, ${((Date.now() - t0) / 1000).toFixed(0)} s`,
    );
  }
  writeFileSync(join(out, "failures.json"), JSON.stringify(all, null, 2) + "\n");
  console.log(`${all.length} failures in all; inputs and failures.json in ${out}`);
  if (all.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
