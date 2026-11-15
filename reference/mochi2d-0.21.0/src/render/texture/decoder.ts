/**
 * Image decoding off the main thread: a small pool of workers running
 * createImageBitmap. Each worker decodes one image at a time, which bounds the
 * peak memory used by decoding. Falls back to createImageBitmap on the calling
 * thread (still asynchronous) when workers are unavailable, and when a worker
 * fails (for example when a content security policy blocks Blob workers).
 */
import type { AlphaMode } from "../../core/image/alpha.js";
import {
  DECODE_WORKER_SOURCE,
  bitmapOptions,
  createBitmap,
  type DecodeRequest,
  type DecodeResponse,
} from "./decode-protocol.js";

export interface DecodeOptions {
  mime?: string;
  /** Alpha convention of the bitmap. Default "straight". */
  alpha?: AlphaMode;
  /** Decode directly at this size. */
  resize?: { width: number; height: number };
}

export interface DecodedImage {
  bitmap: ImageBitmap;
  /** Milliseconds spent in createImageBitmap. */
  ms: number;
  on: "worker" | "main";
}

/** Decodes on the current thread. */
export async function decodeImageHere(
  bytes: Uint8Array,
  opts: DecodeOptions = {},
): Promise<DecodedImage> {
  const t0 = performance.now();
  const bitmap = await createBitmap(
    new Blob([bytes as BlobPart], { type: opts.mime ?? "image/png" }),
    bitmapOptions({
      alpha: opts.alpha ?? "straight",
      ...(opts.resize ? { resize: opts.resize } : {}),
    }),
  );
  return { bitmap, ms: performance.now() - t0, on: "main" };
}

let workerUrl: string | null = null;
/** One Blob URL for the worker code, shared by every decoder. */
function decodeWorkerUrl(): string {
  workerUrl ??= URL.createObjectURL(new Blob([DECODE_WORKER_SOURCE], { type: "text/javascript" }));
  return workerUrl;
}

interface Pending {
  resolve: (d: DecodedImage) => void;
  reject: (e: Error) => void;
  /** The caller's bytes and options, to decode here if the worker fails. */
  bytes: Uint8Array;
  opts: DecodeOptions;
}

interface Slot {
  worker: Worker;
  busy: boolean;
}

export class ImageDecoder {
  private readonly slots: Slot[] = [];
  private readonly queue: { req: DecodeRequest; pending: Pending }[] = [];
  private readonly pending = new Map<number, { pending: Pending; slot: Slot }>();
  private nextId = 1;
  /** Why workers are not used, if they aren't. */
  readonly fallbackReason: string | undefined;

  constructor(options: { workers?: number; useWorkers?: boolean } = {}) {
    const want = Math.max(
      1,
      options.workers ?? Math.min(2, globalThis.navigator?.hardwareConcurrency ?? 2),
    );
    let reason: string | undefined;
    if (options.useWorkers === false) reason = "disabled";
    else if (typeof Worker === "undefined") reason = "Worker is not available";
    if (!reason) {
      try {
        for (let i = 0; i < want; i++) {
          const worker = new Worker(decodeWorkerUrl());
          const slot: Slot = { worker, busy: false };
          worker.onmessage = (ev: MessageEvent<DecodeResponse>) => this.onMessage(slot, ev.data);
          worker.onerror = (ev) => this.onWorkerError(slot, ev.message || "worker error");
          this.slots.push(slot);
        }
      } catch (e) {
        reason = `cannot start workers: ${(e as Error).message}`;
        this.dispose();
      }
    }
    this.fallbackReason = reason;
  }

  get usesWorkers(): boolean {
    return this.slots.length > 0;
  }

  /** Decodes `bytes`. The buffer is copied before transfer, so the caller keeps it. */
  decode(bytes: Uint8Array, opts: DecodeOptions = {}): Promise<DecodedImage> {
    if (!this.usesWorkers) return decodeImageHere(bytes, opts);
    const copy = bytes.slice().buffer;
    const req: DecodeRequest = {
      id: this.nextId++,
      bytes: copy,
      mime: opts.mime ?? "image/png",
      options: bitmapOptions({
        alpha: opts.alpha ?? "straight",
        ...(opts.resize ? { resize: opts.resize } : {}),
      }),
    };
    return new Promise<DecodedImage>((resolve, reject) => {
      this.queue.push({ req, pending: { resolve, reject, bytes, opts } });
      this.pump();
    });
  }

  private pump(): void {
    for (const slot of this.slots) {
      if (slot.busy) continue;
      const next = this.queue.shift();
      if (!next) return;
      slot.busy = true;
      this.pending.set(next.req.id, { pending: next.pending, slot });
      slot.worker.postMessage(next.req, [next.req.bytes]);
    }
  }

  private onMessage(slot: Slot, res: DecodeResponse): void {
    const p = this.pending.get(res.id);
    slot.busy = false;
    if (p) {
      this.pending.delete(res.id);
      if (res.ok) p.pending.resolve({ bitmap: res.bitmap, ms: res.ms, on: "worker" });
      else p.pending.reject(new Error(`Image decode failed: ${res.error}`));
    }
    this.pump();
  }

  /** A failed worker is retired; its requests (and, without workers left, the queue) decode here. */
  private onWorkerError(slot: Slot, message: string): void {
    slot.worker.terminate();
    this.slots.splice(this.slots.indexOf(slot) >>> 0, 1);
    const here = (p: Pending) => decodeImageHere(p.bytes, p.opts).then(p.resolve, p.reject);
    for (const [id, p] of this.pending) {
      if (p.slot === slot) {
        this.pending.delete(id);
        void here(p.pending);
      }
    }
    if (this.slots.length === 0) {
      this.lastWorkerError = message;
      for (const q of this.queue.splice(0)) void here(q.pending);
    }
    this.pump();
  }

  /** Why the last worker failed, if every worker has. */
  lastWorkerError: string | undefined;

  dispose(): void {
    for (const s of this.slots) s.worker.terminate();
    this.slots.length = 0;
    for (const p of this.pending.values()) p.pending.reject(new Error("ImageDecoder disposed"));
    this.pending.clear();
    for (const q of this.queue) q.pending.reject(new Error("ImageDecoder disposed"));
    this.queue.length = 0;
  }
}
