import { GlError } from "./context.js";

/** A VAO with a dynamic position buffer, a static UV buffer and an index buffer. */
export class TexturedMesh {
  readonly vao: WebGLVertexArrayObject;
  private readonly positions: WebGLBuffer;
  private readonly uvs: WebGLBuffer;
  private readonly indices: WebGLBuffer;
  readonly indexCount: number;

  constructor(
    readonly gl: WebGL2RenderingContext,
    positions: Float32Array,
    uvs: Float32Array,
    indices: Uint16Array,
    readonly positionLocation = 0,
    readonly uvLocation = 1,
  ) {
    const vao = gl.createVertexArray();
    const p = gl.createBuffer();
    const u = gl.createBuffer();
    const i = gl.createBuffer();
    if (!vao || !p || !u || !i) throw new GlError("Failed to create mesh buffers (context lost?)");
    this.vao = vao;
    this.positions = p;
    this.uvs = u;
    this.indices = i;
    this.indexCount = indices.length;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, p);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, u);
    gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(uvLocation);
    gl.vertexAttribPointer(uvLocation, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, i);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  updatePositions(positions: Float32Array): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positions);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  draw(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.positions);
    gl.deleteBuffer(this.uvs);
    gl.deleteBuffer(this.indices);
  }
}
