/**
 * Shared, growable vertex / index buffers for many small meshes whose data
 * changes every frame.
 *
 * All meshes live in one set of buffers bound to a single VAO: each vertex
 * attribute has its own buffer, and indices are stored as 32-bit values already
 * offset by the mesh's first vertex. Writing a mesh's data only touches a CPU
 * staging array and marks the range dirty. {@link GeometryStream.upload} sends
 * all dirty ranges to the GPU once per frame, merging neighbouring ranges, so a
 * frame that updates hundreds of meshes costs a handful of `bufferSubData` calls.
 */
import { GlError } from "./context.js";
import type { GpuMemoryTracker } from "./gpu-memory.js";

export interface AttributeSpec {
  /** Name used with {@link GeometryStream.setAttribute}. */
  name: string;
  /** Shader attribute location. */
  location: number;
  /** Floats per vertex. */
  components: 1 | 2 | 3 | 4;
  /** How often the data changes: maps to STREAM_DRAW / DYNAMIC_DRAW / STATIC_DRAW. */
  usage?: "stream" | "dynamic" | "static";
}

export interface MeshSlot {
  readonly index: number;
  /** First vertex of this mesh in the shared buffers. */
  readonly vertexStart: number;
  readonly vertexCount: number;
  /** First element of this mesh in the shared index buffer. */
  readonly indexStart: number;
  readonly indexCount: number;
}

export interface GeometryStreamStats {
  meshes: number;
  vertices: number;
  indices: number;
  /** Bytes sent by the last {@link GeometryStream.upload}. */
  uploadedBytes: number;
  /** GL upload calls issued by the last {@link GeometryStream.upload}. */
  uploadCalls: number;
  /** Bytes currently allocated on the GPU (nominal). */
  gpuBytes: number;
}

/** Half-open element ranges, merged when they touch or nearly touch. */
class DirtyRanges {
  private ranges: [number, number][] = [];

  add(start: number, end: number): void {
    if (end > start) this.ranges.push([start, end]);
  }

  /** Sorted, merged ranges. Gaps smaller than `mergeGap` elements are bridged. */
  take(mergeGap: number): [number, number][] {
    const r = this.ranges.sort((a, b) => a[0] - b[0]);
    const out: [number, number][] = [];
    for (const [s, e] of r) {
      const last = out[out.length - 1];
      if (last && s <= last[1] + mergeGap) last[1] = Math.max(last[1], e);
      else out.push([s, e]);
    }
    this.ranges = [];
    return out;
  }

  get empty(): boolean {
    return this.ranges.length === 0;
  }
}

interface Stream<T extends Float32Array | Uint32Array> {
  buffer: WebGLBuffer;
  data: T;
  /** Elements allocated on the GPU (0 = needs full re-specification). */
  gpuElements: number;
  dirty: DirtyRanges;
  usage: number;
  target: number;
}

const MERGE_GAP_BYTES = 4096;

export class GeometryStream {
  readonly vao: WebGLVertexArrayObject;
  private readonly attributes: (AttributeSpec & { stream: Stream<Float32Array> })[];
  private readonly byName = new Map<string, AttributeSpec & { stream: Stream<Float32Array> }>();
  private readonly indices: Stream<Uint32Array>;
  private readonly slots: MeshSlot[] = [];
  private vertexCount = 0;
  private indexCount = 0;
  private vertexCapacity: number;
  private indexCapacity: number;
  private lastUploadBytes = 0;
  private lastUploadCalls = 0;
  private readonly memory: GpuMemoryTracker | undefined;
  private readonly label: string;

  constructor(
    readonly gl: WebGL2RenderingContext,
    attributes: AttributeSpec[],
    options: {
      initialVertices?: number;
      initialIndices?: number;
      memory?: GpuMemoryTracker;
      label?: string;
    } = {},
  ) {
    if (attributes.length === 0) throw new GlError("GeometryStream needs at least one attribute");
    this.vertexCapacity = Math.max(16, options.initialVertices ?? 4096);
    this.indexCapacity = Math.max(16, options.initialIndices ?? 8192);
    this.memory = options.memory;
    this.label = options.label ?? "geometry";
    const vao = gl.createVertexArray();
    if (!vao) throw new GlError("createVertexArray returned null (context lost?)");
    this.vao = vao;
    const usageOf = (u: AttributeSpec["usage"]) =>
      u === "static" ? gl.STATIC_DRAW : u === "dynamic" ? gl.DYNAMIC_DRAW : gl.STREAM_DRAW;

    gl.bindVertexArray(vao);
    this.attributes = attributes.map((spec) => {
      if (this.byName.has(spec.name)) throw new GlError(`Duplicate attribute "${spec.name}"`);
      const buffer = gl.createBuffer();
      if (!buffer) throw new GlError("createBuffer returned null (context lost?)");
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(spec.location);
      gl.vertexAttribPointer(spec.location, spec.components, gl.FLOAT, false, 0, 0);
      const a = {
        ...spec,
        stream: {
          buffer,
          data: new Float32Array(this.vertexCapacity * spec.components),
          gpuElements: 0,
          dirty: new DirtyRanges(),
          usage: usageOf(spec.usage),
          target: gl.ARRAY_BUFFER,
        },
      };
      this.byName.set(spec.name, a);
      return a;
    });
    const ib = gl.createBuffer();
    if (!ib) throw new GlError("createBuffer returned null (context lost?)");
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    this.indices = {
      buffer: ib,
      data: new Uint32Array(this.indexCapacity),
      gpuElements: 0,
      dirty: new DirtyRanges(),
      usage: gl.DYNAMIC_DRAW,
      target: gl.ELEMENT_ARRAY_BUFFER,
    };
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  get meshes(): readonly MeshSlot[] {
    return this.slots;
  }

  /**
   * Reserves space for a mesh. `indices` are local (0 … vertexCount-1) and are
   * stored offset by the mesh's first vertex.
   */
  addMesh(vertexCount: number, indices: ArrayLike<number>): MeshSlot {
    if (!Number.isInteger(vertexCount) || vertexCount < 0)
      throw new GlError(`Invalid vertex count ${vertexCount}`);
    this.ensureVertexCapacity(this.vertexCount + vertexCount);
    this.ensureIndexCapacity(this.indexCount + indices.length);
    const slot: MeshSlot = {
      index: this.slots.length,
      vertexStart: this.vertexCount,
      vertexCount,
      indexStart: this.indexCount,
      indexCount: indices.length,
    };
    this.slots.push(slot);
    this.vertexCount += vertexCount;
    this.indexCount += indices.length;
    this.setIndices(slot, indices);
    return slot;
  }

  /** Writes per-vertex data for one attribute of a mesh (`vertexCount × components` floats). */
  setAttribute(slot: MeshSlot, name: string, values: ArrayLike<number>): void {
    const a = this.byName.get(name);
    if (!a) throw new GlError(`Unknown attribute "${name}"`);
    const n = slot.vertexCount * a.components;
    if (values.length !== n) {
      throw new GlError(
        `Attribute "${name}" of mesh ${slot.index}: got ${values.length} floats, expected ${n}`,
      );
    }
    const start = slot.vertexStart * a.components;
    a.stream.data.set(values, start);
    a.stream.dirty.add(start, start + n);
  }

  /** Replaces a mesh's indices (same count as when it was added). */
  setIndices(slot: MeshSlot, indices: ArrayLike<number>): void {
    if (indices.length !== slot.indexCount) {
      throw new GlError(
        `Mesh ${slot.index}: got ${indices.length} indices, expected ${slot.indexCount}`,
      );
    }
    const d = this.indices.data;
    for (let i = 0; i < indices.length; i++) {
      const v = indices[i]!;
      if (!(v >= 0 && v < slot.vertexCount) || !Number.isInteger(v)) {
        throw new GlError(
          `Mesh ${slot.index}: index ${v} at ${i} is outside [0, ${slot.vertexCount})`,
        );
      }
      d[slot.indexStart + i] = slot.vertexStart + v;
    }
    this.indices.dirty.add(slot.indexStart, slot.indexStart + indices.length);
  }

  /** Removes all meshes (buffers keep their capacity). */
  clear(): void {
    this.slots.length = 0;
    this.vertexCount = 0;
    this.indexCount = 0;
  }

  /** Sends every dirty range to the GPU. Call once per frame before drawing. */
  upload(): void {
    const gl = this.gl;
    let bytes = 0;
    let calls = 0;
    const flush = <T extends Float32Array | Uint32Array>(s: Stream<T>, usedElements: number) => {
      gl.bindBuffer(s.target, s.buffer);
      if (s.gpuElements < s.data.length) {
        // (Re)allocate the GPU buffer at full CPU capacity and send everything used.
        gl.bufferData(s.target, s.data.byteLength, s.usage);
        s.gpuElements = s.data.length;
        if (usedElements > 0) {
          gl.bufferSubData(s.target, 0, s.data, 0, usedElements);
          bytes += usedElements * 4;
          calls++;
        }
        s.dirty.take(0);
        return;
      }
      if (s.dirty.empty) return;
      const ranges = s.dirty.take(MERGE_GAP_BYTES / 4);
      for (const [start, end0] of ranges) {
        const end = Math.min(end0, usedElements);
        if (end <= start) continue;
        gl.bufferSubData(s.target, start * 4, s.data, start, end - start);
        bytes += (end - start) * 4;
        calls++;
      }
    };
    // Element buffer binding is VAO state; bind the VAO so we don't disturb another one.
    gl.bindVertexArray(this.vao);
    for (const a of this.attributes) flush(a.stream, this.vertexCount * a.components);
    flush(this.indices, this.indexCount);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.lastUploadBytes = bytes;
    this.lastUploadCalls = calls;
    this.memory?.set(this, "buffer", this.label, this.gpuBytes());
  }

  /** Binds the VAO. Call before {@link draw}. */
  bind(): void {
    this.gl.bindVertexArray(this.vao);
  }

  /** Draws one mesh as triangles (the VAO must be bound). */
  draw(slot: MeshSlot): void {
    if (slot.indexCount === 0) return;
    this.gl.drawElements(
      this.gl.TRIANGLES,
      slot.indexCount,
      this.gl.UNSIGNED_INT,
      slot.indexStart * 4,
    );
  }

  /** Draws a contiguous run of meshes with one call (they must be adjacent slots). */
  drawRange(first: MeshSlot, last: MeshSlot): void {
    const count = last.indexStart + last.indexCount - first.indexStart;
    if (count > 0)
      this.gl.drawElements(this.gl.TRIANGLES, count, this.gl.UNSIGNED_INT, first.indexStart * 4);
  }

  unbind(): void {
    this.gl.bindVertexArray(null);
  }

  get stats(): GeometryStreamStats {
    return {
      meshes: this.slots.length,
      vertices: this.vertexCount,
      indices: this.indexCount,
      uploadedBytes: this.lastUploadBytes,
      uploadCalls: this.lastUploadCalls,
      gpuBytes: this.gpuBytes(),
    };
  }

  private gpuBytes(): number {
    let b = this.indices.gpuElements * 4;
    for (const a of this.attributes) b += a.stream.gpuElements * 4;
    return b;
  }

  private ensureVertexCapacity(n: number): void {
    if (n <= this.vertexCapacity) return;
    let cap = this.vertexCapacity;
    while (cap < n) cap *= 2;
    this.vertexCapacity = cap;
    for (const a of this.attributes) {
      const grown = new Float32Array(cap * a.components);
      grown.set(a.stream.data);
      a.stream.data = grown;
      a.stream.gpuElements = 0; // re-specify on next upload
    }
  }

  private ensureIndexCapacity(n: number): void {
    if (n <= this.indexCapacity) return;
    let cap = this.indexCapacity;
    while (cap < n) cap *= 2;
    this.indexCapacity = cap;
    const grown = new Uint32Array(cap);
    grown.set(this.indices.data);
    this.indices.data = grown;
    this.indices.gpuElements = 0;
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteVertexArray(this.vao);
    for (const a of this.attributes) gl.deleteBuffer(a.stream.buffer);
    gl.deleteBuffer(this.indices.buffer);
    this.memory?.delete(this);
  }
}
