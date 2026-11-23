# Rendering: the float32 rules

Mochi2D performs four rendering operations in a fixed float32 order and
rounding. Each is mathematically the same as a simpler form, but not bit for
bit the same, and a simpler form changes channels by one level in some
pixels. With these four rules, Mochi2D's reference renders equal the
official renderer's pixel for pixel on the conformance catalog
([conformance.md](conformance.md)). This page specifies the rules as
Mochi2D implements them.

The rest of the pipeline needs no special rule:

- texture premultiplication and mip levels;
- the view transform;
- multiply and screen colors, and opacity;
- the blend factors of all three modes.

The code is in `src/core/render/sampling.ts` (rule V),
`src/core/render/mask-matrix.ts` (rules M and I) and `src/render/model/`
(the shaders and the renderer). Tests:

- `test/render-rules.test.ts` checks the CPU side;
- the render hashes (`test/golden/deepseek-render-hashes.json`,
  `test/render-crafted.test.ts`) lock the images.

## Rule V: textures are sampled at v flipped twice

A `.moc3` file stores each vertex's texture v with its origin at the
image's top, as a float32 value `v_file`. Mochi2D flips v twice, rounding to
float32 each time, so the texture is sampled at

```
v_sample = f32(1 − f32(1 − v_file))
```

with each subtraction rounded to float32. That is not always `v_file`.
For a small `v_file`, the first subtraction loses low bits that the second
can't restore:

| | float32 | value |
| --- | --- | --- |
| `v_file` | `0x3DCCCCCD` | 0.100000001490116… |
| `f32(1 − v_file)` | `0x3F666666` | 0.89999997615814… |
| `v_sample` | `0x3DCCCCD0` | 0.10000002384186…, 3 units in the last place above |

From 0.5 up, `1 − v` is exact and nothing changes. On DeepSeek-chan, 14,506
of 58,967 vertices are sampled at a v other than their stored one.

**In Mochi2D:** the UVs are transformed once, when a model's meshes are
uploaded (`sampledUvs`). That covers every draw, mask meshes drawn into a
mask buffer included. u is used as stored.

## Rule M: mask coordinates through float32 matrices

### What a mask's coordinates are

A clipping mask maps an output-space point p to coordinates t in its mask
texture, per axis:

```
t = s · (p − b) + ℓ
```

- **b** is the corner the mapping starts from: the lower-left corner of the
  mask group's box, or that minus the 5 % margin when the box doesn't fit
  the buffer.
- **s** is the scale to texture units: canvas pixels per unit over the
  buffer size, or 1 / (1.1 · extent) with the margin.
- **ℓ** is the corner of the mask's region in its texture: 0 for a mask
  buffer of its own, the region's corner for a mask atlas.

Each of b, s and ℓ is a float32 value.

### How Mochi2D applies it

Mochi2D never subtracts first. It builds two 4 × 4 affine matrices on the CPU
and applies each in the vertex shader as `A·p + c`, a product and a sum:

```
texture matrix:  T(ℓ) · S(s) · T(−b)
clip matrix:     T(−1, −1) · S(2, 2) · T(ℓ) · S(s) · T(−b)
```

T is a translation and S a scale.

- The texture matrix gives the coordinate at which a masked draw samples
  the mask.
- The clip matrix places mask meshes in the mask buffer when it is drawn
  (`2t − 1`).

### The order of composition

1. The product starts from the identity, and the factors are multiplied
   on from left to right. Every intermediate matrix is stored in float32.
2. Each entry of a product is the sum over the inner index, in increasing
   order: `Σₖ a[r][k] · b[k][c]` for k = 0, 1, 2, 3.
3. Each term is the product of two float32 values, which is exact in
   double. The first term starts the sum, and each further term is added
   with the sum rounded once to float32.

### What that gives

The x entries (y is the same with y's numbers):

| Matrix | Scale entry | Translation entry |
| --- | --- | --- |
| texture | `sx` | `f32(f32(sx·(−bx)) + ℓx)` |
| clip | `f32(2·sx)` | `f32(f32(2·sx·(−bx)) + f32(2·ℓx − 1))` |

So the translation is not `s·b` subtracted later, and not `s·b` computed
in double and rounded once. On DeepSeek-chan's 49 mask groups, the clip
translation differs from that single rounding in 4.

### In Mochi2D

- `maskMatrices(map)` builds both matrices with this rounding
  (`multiplyF32`, `composeF32`).
- The shaders take them as `mat4` uniforms and compute
  `matrix * vec4(p, 0, 1)`.
- This holds for every mask: drawable masks, offscreen masks and the
  viewer's mask atlas, whose regions differ only in ℓ.

**Inside layers.** When an offscreen layer with a mask is composited, its
mask is looked up through rule I's matrix instead.

## Rule L: layers are read through a filtered quad

An offscreen layer is composited into the layer below it, and the model's
root layer onto the target. Each is drawn as a quad over the viewport:

- a triangle strip of 4 vertices, clip-space corners (−1, −1), (1, −1),
  (−1, 1), (1, 1);
- texture coordinates from 0 to 1 across it;
- the layer's texture sampled with linear filtering.

At each pixel center the interpolated coordinate is ideally a texel
center. On a real GPU it isn't always exactly there, so the bilinear
weights mix in a neighbour by a tiny amount. Over an opaque background,
that can change a channel by one level. An exact per-pixel texel fetch is
mathematically the same, but not bit for bit.

**In Mochi2D:** layer render targets filter linearly, and `LAYER_VS` draws
the quad.

## Rule I: a masked layer's mask through the inverse view matrix

When an offscreen layer that carries a mask is composited (rule L), the
mask is looked up with one matrix, applied to the quad's clip-space corners
(±1, ±1) and interpolated across the screen:

```
D = A · V⁻¹
```

1. **A** is the mask's texture matrix, composed by rule M from the mask
   group's box corner b, scale s and region ℓ.
2. **V** is the view matrix, output space → clip space: the scale and
   translation of the framing, as float32 entries. Its inverse **V⁻¹** is
   computed in double from those entries:
   - the 2 × 2 part (the 3 × 3 matrix's cofactors over its determinant);
   - the translation as minus that unrounded inverse times V's
     translation;
   - every entry then stored as float32.
3. **D** is the product A · V⁻¹, entry by entry as in rule M: the
   four-term sum in increasing inner index, each addition rounded to
   float32.
4. Each corner's mask coordinate is `D · (x, y, 0, 1)`, with x and y = ±1,
   and the rasterizer interpolates it.

Mapping the corners to output space first and then applying A is
mathematically the same, but the corner values differ in their last bits,
which can flip one-level roundings on mask edges. Rule M still matters
here: with A rounded once from double instead, some of those pixels come
back.

**Numeric vector.** A 512 × 512 view at (0.08, −0.5), 1,500 pixels per
unit, and the mask of a layer whose box needs the margin on both axes:

| Matrix | Scale x | Scale y | Translation x | Translation y |
| --- | --- | --- | --- | --- |
| V | `0x40BB8000` (5.859375) | `0x40BB8000` | `0xBEF00000` (−0.46875) | `0x403B8000` (2.9296875) |
| V⁻¹ | `0x3E2EC33E` (0.17066666…) | `0x3E2EC33E` | `0x3DA3D70A` (0.08) | `0xBF000000` (−0.5) |
| A | `0x40B877B1` | `0x3F53DA2E` | `0xBC39A3E4` | `0x3F507C75` |
| D | `0x3F7BDC14` | `0x3E109FDE` | `0x3EE65134` | `0x3ECD1EBC` |

D's x translation is `f32(f32(A.sx · V⁻¹.tx) + A.tx)` = 0.4498382806777954.
That is one unit in the last place above the exact 0.449838272605….
`test/render-rules.test.ts` reproduces the table from the crafted model
it comes from.

**In Mochi2D:** `layerMaskMatrix(map, viewMatrix(…))` builds D, and
`LAYER_VS` applies it to the quad's corners. With a view rotation (a
viewer setting; reference renders have none), V holds the rotation too,
each entry combined in double and rounded once. Mask generation is
unchanged: the masks are drawn with rule M's clip matrix.

## What is still open

Nothing known. With the four rules, Mochi2D's renders equal the reference
images in all 53 catalog render scenarios.

## Where the rules apply

Every path that draws a model uses the same renderer (`ModelRenderer`):

- `MochiView` and its items;
- `MochiSprite` in PixiJS;
- the render tool (`npm run render`), `NodeRenderer` and `renderToPng`;
- the viewer, including its mask atlas.

The atlas is an approximation that reference renders never use, but its
mask coordinates follow rule M too.
