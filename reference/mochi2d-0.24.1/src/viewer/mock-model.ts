/**
 * A stand-in model for building the viewer before model evaluation exists.
 * It has data-driven parameters and parts and draws a handful of textured,
 * wobbling grid meshes whose vertices are streamed every frame.
 * Nothing here is Live2D-specific.
 */
import { GeometryStream, type MeshSlot } from "../render/gl/geometry-stream.js";
import { ShaderProgram } from "../render/gl/shader.js";
import { createTexture2D, deleteTexture2D, type Texture2D } from "../render/gl/texture.js";
import { BlendStateCache, BLEND_PREMULTIPLIED_OVER } from "../render/gl/blend-state.js";
import { makeDemoTexturePixels } from "../render/demo/textured-triangles.js";
import type { GpuMemoryTracker } from "../render/gl/gpu-memory.js";
import type { ParameterInfo, PartInfo, StageModel } from "../lib/stage-model.js";

const VS = `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aUv;
uniform vec2 uScale;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aPos * uScale, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec4 uTint;    // premultiplied
uniform float uOpacity;
out vec4 outColor;
void main() {
  vec4 c = texture(uTex, vUv);
  outColor = vec4(c.rgb * uTint.rgb, c.a) * uTint.a * uOpacity;
}`;

const SIDE = 12;
const PART_COUNT = 6;

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

export class MockModel implements StageModel {
  readonly name = "Mock model";
  readonly parameters: ParameterInfo[];
  readonly parts: PartInfo[];
  private readonly values = new Map<string, number>();
  private readonly opacities = new Map<string, number>();
  private readonly program: ShaderProgram;
  private readonly stream: GeometryStream;
  private readonly slots: MeshSlot[] = [];
  private readonly texture: Texture2D;
  private readonly blend: BlendStateCache;
  private readonly positions = new Float32Array(SIDE * SIDE * 2);
  private time = 0;

  constructor(
    readonly gl: WebGL2RenderingContext,
    private readonly memory?: GpuMemoryTracker,
  ) {
    this.parameters = [
      {
        id: "mock.rotation",
        label: "Rotation",
        min: -180,
        max: 180,
        default: 0,
        group: "Transform",
      },
      { id: "mock.scale", label: "Scale", min: 0.2, max: 2, default: 1, group: "Transform" },
      { id: "mock.spread", label: "Spread", min: 0, max: 1, default: 0.55, group: "Transform" },
      {
        id: "mock.wave.amplitude",
        label: "Wave amplitude",
        min: 0,
        max: 1,
        default: 0.3,
        group: "Animation",
      },
      {
        id: "mock.wave.speed",
        label: "Wave speed",
        min: 0,
        max: 5,
        default: 1,
        group: "Animation",
      },
      { id: "mock.hue", label: "Hue shift", min: 0, max: 1, default: 0, group: "Color" },
      { id: "mock.saturation", label: "Saturation", min: 0, max: 1, default: 0.45, group: "Color" },
    ];
    // Extra inert parameters so the list behaves like a real model's.
    for (let i = 1; i <= 33; i++) {
      this.parameters.push({
        id: `mock.extra.${String(i).padStart(2, "0")}`,
        label: `Extra ${i}`,
        min: i % 3 === 0 ? -30 : -1,
        max: i % 3 === 0 ? 30 : 1,
        default: 0,
        group: "Extra (inert)",
      });
    }
    this.parts = Array.from({ length: PART_COUNT }, (_, i) => ({
      id: `mock.part.${i}`,
      label: `Part ${i + 1}`,
      defaultOpacity: 1,
    }));
    for (const p of this.parameters) this.values.set(p.id, p.default);
    for (const p of this.parts) this.opacities.set(p.id, p.defaultOpacity);

    this.program = new ShaderProgram(gl, VS, FS, "mock model");
    this.texture = createTexture2D(gl, makeDemoTexturePixels(64), {
      alpha: "premultiplied",
      filter: "linear",
      ...(memory ? { memory } : {}),
      label: "mock texture",
    });
    this.blend = new BlendStateCache(gl);
    this.stream = new GeometryStream(
      gl,
      [
        { name: "position", location: 0, components: 2, usage: "stream" },
        { name: "uv", location: 1, components: 2, usage: "static" },
      ],
      { ...(memory ? { memory } : {}), label: "mock geometry" },
    );
    const indices: number[] = [];
    for (let y = 0; y < SIDE - 1; y++) {
      for (let x = 0; x < SIDE - 1; x++) {
        const i = y * SIDE + x;
        indices.push(i, i + 1, i + SIDE, i + 1, i + SIDE + 1, i + SIDE);
      }
    }
    const uvs = new Float32Array(SIDE * SIDE * 2);
    for (let y = 0; y < SIDE; y++) {
      for (let x = 0; x < SIDE; x++) {
        uvs[(y * SIDE + x) * 2] = x / (SIDE - 1);
        uvs[(y * SIDE + x) * 2 + 1] = y / (SIDE - 1);
      }
    }
    for (let p = 0; p < PART_COUNT; p++) {
      const slot = this.stream.addMesh(SIDE * SIDE, indices);
      this.stream.setAttribute(slot, "uv", uvs);
      this.slots.push(slot);
    }
  }

  private param(id: string): number {
    return this.values.get(id) ?? 0;
  }

  getParameter(id: string): number {
    return this.param(id);
  }

  setParameter(id: string, value: number): void {
    const info = this.parameters.find((p) => p.id === id);
    if (!info) return;
    this.values.set(id, Math.min(info.max, Math.max(info.min, value)));
  }

  getPartOpacity(id: string): number {
    return this.opacities.get(id) ?? 1;
  }

  setPartOpacity(id: string, value: number): void {
    if (this.opacities.has(id)) this.opacities.set(id, Math.min(1, Math.max(0, value)));
  }

  update(_dt: number, time: number): void {
    this.time = time;
    const rot = (this.param("mock.rotation") * Math.PI) / 180;
    const scale = this.param("mock.scale");
    const spread = this.param("mock.spread");
    const amp = this.param("mock.wave.amplitude");
    const speed = this.param("mock.wave.speed");
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    for (let p = 0; p < PART_COUNT; p++) {
      const angle = (p / PART_COUNT) * Math.PI * 2;
      const cx = Math.cos(angle) * spread * 0.55;
      const cy = Math.sin(angle) * spread * 0.55;
      const size = 0.36;
      for (let y = 0; y < SIDE; y++) {
        for (let x = 0; x < SIDE; x++) {
          const u = x / (SIDE - 1) - 0.5;
          const v = y / (SIDE - 1) - 0.5;
          const wave = amp * 0.08 * Math.sin(this.time * speed * 2.5 + (u + v) * 6 + p);
          const lx = cx + u * size + wave;
          const ly = cy - v * size + wave * 0.5;
          const i = (y * SIDE + x) * 2;
          this.positions[i] = (lx * cos - ly * sin) * scale;
          this.positions[i + 1] = (lx * sin + ly * cos) * scale;
        }
      }
      this.stream.setAttribute(this.slots[p]!, "position", this.positions);
    }
  }

  draw(width: number, height: number): void {
    const gl = this.gl;
    this.stream.upload();
    const aspect = width / height;
    this.program.use();
    gl.uniform2f(
      this.program.uniform("uScale"),
      aspect > 1 ? 1 / aspect : 1,
      aspect > 1 ? 1 : aspect,
    );
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture.texture);
    gl.uniform1i(this.program.uniform("uTex"), 0);
    this.blend.invalidate();
    this.blend.apply(BLEND_PREMULTIPLIED_OVER);
    const hue = this.param("mock.hue");
    const sat = this.param("mock.saturation");
    this.stream.bind();
    for (let p = 0; p < PART_COUNT; p++) {
      const opacity = this.getPartOpacity(this.parts[p]!.id);
      if (opacity <= 0) continue;
      const [r, g, b] = hsvToRgb((hue + p / PART_COUNT) % 1, sat, 1);
      gl.uniform4f(this.program.uniform("uTint"), r, g, b, 1);
      gl.uniform1f(this.program.uniform("uOpacity"), opacity);
      this.stream.draw(this.slots[p]!);
    }
    this.stream.unbind();
    gl.disable(gl.BLEND);
    this.blend.invalidate();
  }

  dispose(): void {
    this.stream.dispose();
    this.program.dispose();
    deleteTexture2D(this.gl, this.texture, this.memory);
  }
}
