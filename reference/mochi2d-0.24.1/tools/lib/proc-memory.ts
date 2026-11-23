/**
 * Resident memory of this process's descendants (Linux /proc only), grouped by
 * Chromium process type. Used to observe the headless browser's memory.
 */
import { readdirSync, readFileSync } from "node:fs";

export interface ProcessMemory {
  pid: number;
  type: string;
  rssBytes: number;
}

function readStatus(pid: number): { ppid: number; rss: number } | null {
  try {
    const text = readFileSync(`/proc/${pid}/status`, "utf8");
    const ppid = Number(/^PPid:\s+(\d+)/m.exec(text)?.[1] ?? NaN);
    const rssKb = Number(/^VmRSS:\s+(\d+)\s+kB/m.exec(text)?.[1] ?? 0);
    return Number.isFinite(ppid) ? { ppid, rss: rssKb * 1024 } : null;
  } catch {
    return null;
  }
}

function typeOf(pid: number): string {
  try {
    // Chromium rewrites its process title into one space-separated string.
    const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    const t = /--type=([\w-]+)/.exec(cmd)?.[1];
    if (t) return t;
    return /chrom/i.test(cmd) ? "browser" : "other";
  } catch {
    return "gone";
  }
}

/** Descendants of `root` (default: this process) with their RSS. Empty off Linux. */
export function descendantMemory(root = process.pid): ProcessMemory[] {
  let pids: number[];
  try {
    pids = readdirSync("/proc")
      .filter((n) => /^\d+$/.test(n))
      .map(Number);
  } catch {
    return [];
  }
  const info = new Map<number, { ppid: number; rss: number }>();
  for (const pid of pids) {
    const s = readStatus(pid);
    if (s) info.set(pid, s);
  }
  const children = new Map<number, number[]>();
  for (const [pid, s] of info) {
    const list = children.get(s.ppid) ?? [];
    list.push(pid);
    children.set(s.ppid, list);
  }
  const out: ProcessMemory[] = [];
  const stack = [...(children.get(root) ?? [])];
  while (stack.length) {
    const pid = stack.pop()!;
    out.push({ pid, type: typeOf(pid), rssBytes: info.get(pid)!.rss });
    stack.push(...(children.get(pid) ?? []));
  }
  return out;
}

/** Sums RSS by process type. */
export function memoryByType(list: ProcessMemory[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of list) out[p.type] = (out[p.type] ?? 0) + p.rssBytes;
  return out;
}

/** Samples descendant memory every `intervalMs` and tracks the peak total and per-type peaks. */
export class MemorySampler {
  peakTotal = 0;
  peakByType: Record<string, number> = {};
  samples = 0;
  private timer: NodeJS.Timeout | undefined;

  start(intervalMs = 50): this {
    this.sample();
    this.timer = setInterval(() => this.sample(), intervalMs);
    return this;
  }

  sample(): number {
    const byType = memoryByType(descendantMemory());
    let total = 0;
    for (const [t, b] of Object.entries(byType)) {
      total += b;
      if (b > (this.peakByType[t] ?? 0)) this.peakByType[t] = b;
    }
    if (total > this.peakTotal) this.peakTotal = total;
    this.samples++;
    return total;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.sample();
  }
}
