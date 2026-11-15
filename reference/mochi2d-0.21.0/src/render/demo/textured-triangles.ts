/**
 * Demo scene: a few textured, alpha-blended triangles drawn with a procedurally
 * generated texture. Deterministic, so it doubles as a smoke test for the
 * WebGL2 helpers and the headless rendering harness.
 */
import { createTexture2D, type Texture2D } from "../gl/texture.js";
import { ShaderProgram } from "../gl/shader.js";
import { TexturedMesh } from "../gl/mesh.js";
import { assertNoGlError } from "../gl/context.js";
import { multiply3, rotation3, scaling3, translation3, type Mat3 } from "../../core/math/mat3.js";

const VS = `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aUv;
uniform mat3 uTransform;
out vec2 vUv;
void main() {
  vec3 p = uTransform * vec3(aPos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  vUv = aUv;
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec4 uTint;
out vec4 outColor;
void main() {
  // Texture is premultiplied; tint is applied as a premultiplied color.
  vec4 c = texture(uTex, vUv);
  outColor = vec4(c.rgb * uTint.rgb, c.a) * uTint.a;
}`;

/** RGBA8 checkerboard with a horizontal alpha ramp and colored quadrants. */
export function makeDemoTexturePixels(size = 64): {
  width: number;
  height: number;
  data: Uint8Array;
} {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const check = ((x >> 3) + (y >> 3)) & 1;
      const qx = x < size / 2 ? 0 : 1;
      const qy = y < size / 2 ? 0 : 1;
      data[i] = check ? 255 : qx ? 40 : 200;
      data[i + 1] = check ? 255 : qy ? 180 : 60;
      data[i + 2] = check ? 255 : qx ^ qy ? 220 : 30;
      data[i + 3] = Math.round(96 + (159 * x) / (size - 1));
    }
  }
  return { width: size, height: size, data };
}

export interface DemoScene {
  draw(time?: number): void;
  dispose(): void;
}

export function createTexturedTrianglesScene(gl: WebGL2RenderingContext): DemoScene {
  const program = new ShaderProgram(gl, VS, FS, "demo-textured-triangles");
  const texture: Texture2D = createTexture2D(gl, makeDemoTexturePixels(), {
    premultiplyAlpha: true,
    filter: "nearest",
  });
  // A quad (two triangles) and a single triangle, in local [-1, 1] space.
  const quad = new TexturedMesh(
    gl,
    new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]),
    new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    new Uint16Array([0, 1, 2, 0, 2, 3]),
  );
  const tri = new TexturedMesh(
    gl,
    new Float32Array([0, 1, -0.87, -0.5, 0.87, -0.5]),
    new Float32Array([0.5, 0, 0, 1, 1, 1]),
    new Uint16Array([0, 1, 2]),
  );

  const instances: {
    mesh: TexturedMesh;
    transform: (t: number) => Mat3;
    tint: [number, number, number, number];
  }[] = [
    {
      mesh: quad,
      transform: () => multiply3(translation3(-0.35, 0.3), scaling3(0.5, 0.5)),
      tint: [1, 1, 1, 1],
    },
    {
      mesh: tri,
      transform: (t) =>
        multiply3(translation3(0.35, 0.25), multiply3(rotation3(0.3 + t), scaling3(0.5, 0.5))),
      tint: [1, 0.6, 0.6, 0.9],
    },
    {
      mesh: quad,
      transform: (t) =>
        multiply3(
          translation3(0.05, -0.35),
          multiply3(rotation3(-0.5 - t * 0.5), scaling3(0.55, 0.3)),
        ),
      tint: [0.5, 0.8, 1, 0.75],
    },
  ];

  return {
    draw(time = 0) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      program.use();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture.texture);
      gl.uniform1i(program.uniform("uTex"), 0);
      for (const inst of instances) {
        gl.uniformMatrix3fv(program.uniform("uTransform"), false, inst.transform(time));
        gl.uniform4fv(program.uniform("uTint"), inst.tint);
        inst.mesh.draw();
      }
      gl.disable(gl.BLEND);
      assertNoGlError(gl, "demo draw");
    },
    dispose() {
      quad.dispose();
      tri.dispose();
      gl.deleteTexture(texture.texture);
      program.dispose();
    },
  };
}
