import { GlError } from "./context.js";

export class ShaderCompileError extends GlError {
  constructor(
    readonly stage: "vertex" | "fragment",
    readonly log: string,
    readonly source: string,
    readonly label?: string,
  ) {
    super(
      `${label ? `[${label}] ` : ""}${stage} shader failed to compile:\n${log.trim()}\n--- source ---\n${numberLines(source, log)}`,
    );
    this.name = "ShaderCompileError";
  }
}

export class ProgramLinkError extends GlError {
  constructor(
    readonly log: string,
    readonly label?: string,
  ) {
    super(`${label ? `[${label}] ` : ""}program failed to link:\n${log.trim()}`);
    this.name = "ProgramLinkError";
  }
}

/** Prefixes source lines with numbers and marks lines referenced by the log. */
function numberLines(source: string, log: string): string {
  const bad = new Set<number>();
  for (const m of log.matchAll(/\d+:(\d+)/g)) bad.add(Number(m[1]));
  return source
    .split("\n")
    .map((line, i) => `${bad.has(i + 1) ? ">>" : "  "}${String(i + 1).padStart(4)}| ${line}`)
    .join("\n");
}

export function compileShader(
  gl: WebGL2RenderingContext,
  stage: "vertex" | "fragment",
  source: string,
  label?: string,
): WebGLShader {
  const shader = gl.createShader(stage === "vertex" ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER);
  if (!shader) throw new GlError(`createShader(${stage}) returned null (context lost?)`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "(no log)";
    gl.deleteShader(shader);
    throw new ShaderCompileError(stage, log, source, label);
  }
  return shader;
}

/** A linked program with cached attribute and uniform locations. */
export class ShaderProgram {
  readonly program: WebGLProgram;
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();
  private readonly attribs = new Map<string, number>();

  constructor(
    readonly gl: WebGL2RenderingContext,
    vertexSource: string,
    fragmentSource: string,
    readonly label?: string,
    attribBindings: Record<string, number> = {},
  ) {
    const vs = compileShader(gl, "vertex", vertexSource, label);
    let fs: WebGLShader;
    try {
      fs = compileShader(gl, "fragment", fragmentSource, label);
    } catch (e) {
      gl.deleteShader(vs);
      throw e;
    }
    const program = gl.createProgram();
    if (!program) throw new GlError("createProgram returned null (context lost?)");
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    for (const [name, loc] of Object.entries(attribBindings))
      gl.bindAttribLocation(program, loc, name);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? "(no log)";
      gl.deleteProgram(program);
      throw new ProgramLinkError(log, label);
    }
    this.program = program;
  }

  use(): this {
    this.gl.useProgram(this.program);
    return this;
  }

  /** Uniform location; `null` if the uniform is unused/optimized out. */
  uniform(name: string): WebGLUniformLocation | null {
    let loc = this.uniforms.get(name);
    if (loc === undefined) {
      loc = this.gl.getUniformLocation(this.program, name);
      this.uniforms.set(name, loc);
    }
    return loc;
  }

  /** Attribute location; -1 if unused. */
  attrib(name: string): number {
    let loc = this.attribs.get(name);
    if (loc === undefined) {
      loc = this.gl.getAttribLocation(this.program, name);
      this.attribs.set(name, loc);
    }
    return loc;
  }

  dispose(): void {
    this.gl.deleteProgram(this.program);
  }
}
