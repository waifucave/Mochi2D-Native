/**
 * Float32 arctangent, sine and cosine of the classic C math library lineage,
 * ported to TypeScript from musl libc (src/math: atan2f.c, atanf.c, sinf.c,
 * cosf.c, __sindf.c, __cosdf.c, __rem_pio2f.c, __rem_pio2_large.c), which
 * took them from FreeBSD's msun. General math code: each function gives the
 * same float32 result as the C original, bit for bit, including where that
 * is not the correctly rounded value. See THIRD_PARTY_NOTICES.md.
 *
 * Original notice, preserved as it asks (__rem_pio2_large.c reads
 * "Developed at SunSoft"):
 *
 * ====================================================
 * Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
 *
 * Developed at SunPro, a Sun Microsystems, Inc. business.
 * Permission to use, copy, modify, and distribute this
 * software is freely granted, provided that this notice
 * is preserved.
 * ====================================================
 *
 * Conversion to float by Ian Lance Taylor, Cygnus Support, ian@cygnus.com;
 * optimized and debugged by Bruce D. Evans. musl (1.2.6) is Copyright ©
 * 2005-2020 Rich Felker, et al., under the MIT license.
 *
 * Float operations (C's `float` arithmetic, FLT_EVAL_METHOD 0) round to
 * float32 after each operation (Math.fround); `double` operations are
 * JavaScript's own.
 */
const fr = Math.fround;

const scratch = new DataView(new ArrayBuffer(4));
/** The bits of a float32. */
function bits(x: number): number {
  scratch.setFloat32(0, x);
  return scratch.getUint32(0);
}
/** The float32 with these bits. */
function fromBits(u: number): number {
  scratch.setUint32(0, u >>> 0);
  return scratch.getFloat32(0);
}

// ---------------------------------------------------------------- atan2f

const PI = fromBits(0x40490fdb); // 3.1415927410e+00
const PI_LO = fromBits(0xb3bbbd2e); // -8.7422776573e-08

const ATANHI = [0x3eed6338, 0x3f490fda, 0x3f7b985e, 0x3fc90fda].map(fromBits);
const ATANLO = [0x31ac3769, 0x33222168, 0x33140fb4, 0x33a22168].map(fromBits);
const AT = [
  3.3333328366e-1, -1.9999158382e-1, 1.4253635705e-1, -1.0648017377e-1, 6.1687607318e-2,
].map(fr);

/** atanf(x): x a float32. */
export function atanf(x: number): number {
  let ix = bits(x);
  const sign = ix >>> 31;
  ix &= 0x7fffffff;
  let id: number;
  if (ix >= 0x4c800000) {
    // |x| >= 2**26
    if (Number.isNaN(x)) return x;
    const z = fr(ATANHI[3]! + 2 ** -120);
    return sign ? -z : z;
  }
  if (ix < 0x3ee00000) {
    // |x| < 0.4375
    if (ix < 0x39800000) return x; // |x| < 2**-12
    id = -1;
  } else {
    x = Math.abs(x);
    if (ix < 0x3f980000) {
      // |x| < 1.1875
      if (ix < 0x3f300000) {
        // 7/16 <= |x| < 11/16
        id = 0;
        x = fr(fr(fr(2 * x) - 1) / fr(2 + x));
      } else {
        // 11/16 <= |x| < 19/16
        id = 1;
        x = fr(fr(x - 1) / fr(x + 1));
      }
    } else if (ix < 0x401c0000) {
      // |x| < 2.4375
      id = 2;
      x = fr(fr(x - 1.5) / fr(1 + fr(1.5 * x)));
    } else {
      // 2.4375 <= |x| < 2**26
      id = 3;
      x = fr(-1 / x);
    }
  }
  // End of the argument reduction.
  const z = fr(x * x);
  const w = fr(z * z);
  // Odd and even parts of the sum of aT[i]·z^(i+1).
  const s1 = fr(z * fr(AT[0]! + fr(w * fr(AT[2]! + fr(w * AT[4]!)))));
  const s2 = fr(w * fr(AT[1]! + fr(w * AT[3]!)));
  if (id < 0) return fr(x - fr(x * fr(s1 + s2)));
  const r = fr(ATANHI[id]! - fr(fr(fr(x * fr(s1 + s2)) - ATANLO[id]!) - x));
  return sign ? -r : r;
}

/** atan2f(y, x): y and x float32. */
export function atan2f(y: number, x: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return fr(x + y);
  let ix = bits(x);
  let iy = bits(y);
  if (ix === 0x3f800000) return atanf(y); // x = 1.0
  const m = ((iy >>> 31) & 1) | ((ix >>> 30) & 2); // 2·sign(x) + sign(y)
  ix &= 0x7fffffff;
  iy &= 0x7fffffff;
  // y = 0
  if (iy === 0) {
    if (m === 0 || m === 1) return y; // atan(±0, +anything) = ±0
    return m === 2 ? PI : -PI; // atan(+0, −anything) = π, atan(−0, −anything) = −π
  }
  // x = 0
  if (ix === 0) return m & 1 ? -fr(PI / 2) : fr(PI / 2);
  // x infinite
  if (ix === 0x7f800000) {
    if (iy === 0x7f800000) {
      const q = fr(PI / 4);
      const q3 = fr(fr(3 * PI) / 4);
      return [q, -q, q3, -q3][m]!;
    }
    return [0, -0, PI, -PI][m]!;
  }
  // |y/x| > 2**26
  if (ix + (26 << 23) < iy || iy === 0x7f800000) return m & 1 ? -fr(PI / 2) : fr(PI / 2);
  // z = atan(|y/x|), with the correct underflow
  const z = m & 2 && iy + (26 << 23) < ix ? 0 : atanf(Math.abs(fr(y / x)));
  switch (m) {
    case 0:
      return z; // atan(+, +)
    case 1:
      return -z; // atan(−, +)
    case 2:
      return fr(PI - fr(z - PI_LO)); // atan(+, −)
    default:
      return fr(fr(z - PI_LO) - PI); // atan(−, −)
  }
}

// ------------------------------------------------------------ sinf, cosf

// |sin(x)/x − s(x)| < 2**−37.5 and |cos(x) − c(x)| < 2**−34.1 (double kernels).
const S1 = -0x15555554cbac77 * 2 ** -55;
const S2 = 0x111110896efbb2 * 2 ** -59;
const S3 = -0x1a00f9e2cae774 * 2 ** -65;
const S4 = 0x16cd878c3b46a7 * 2 ** -71;
const C0 = -0x1ffffffd0c5e81 * 2 ** -54;
const C1 = 0x155553e1053a42 * 2 ** -57;
const C2 = -0x16c087e80f1e27 * 2 ** -62;
const C3 = 0x199342e0ee5069 * 2 ** -68;

function sindf(x: number): number {
  const z = x * x;
  const w = z * z;
  const r = S3 + z * S4;
  const s = z * x;
  return fr(x + s * (S1 + z * S2) + s * w * r);
}

function cosdf(x: number): number {
  const z = x * x;
  const w = z * z;
  const r = C2 + z * C3;
  return fr(1.0 + z * C0 + w * C1 + w * z * r);
}

// Small multiples of π/2 in double precision.
const PIO2_1X = 1 * (Math.PI / 2);
const PIO2_2X = 2 * (Math.PI / 2);
const PIO2_3X = 3 * (Math.PI / 2);
const PIO2_4X = 4 * (Math.PI / 2);

/** sinf(x): x a float32. */
export function sinf(x: number): number {
  let ix = bits(x);
  const sign = ix >>> 31;
  ix &= 0x7fffffff;
  if (ix <= 0x3f490fda) {
    // |x| ~<= π/4
    if (ix < 0x39800000) return x; // |x| < 2**−12
    return sindf(x);
  }
  if (ix <= 0x407b53d1) {
    // |x| ~<= 5π/4
    if (ix <= 0x4016cbe3) return sign ? -cosdf(x + PIO2_1X) : cosdf(x - PIO2_1X); // ~<= 3π/4
    return sindf(sign ? -(x + PIO2_2X) : -(x - PIO2_2X));
  }
  if (ix <= 0x40e231d5) {
    // |x| ~<= 9π/4
    if (ix <= 0x40afeddf) return sign ? cosdf(x + PIO2_3X) : -cosdf(x - PIO2_3X); // ~<= 7π/4
    return sindf(sign ? x + PIO2_4X : x - PIO2_4X);
  }
  if (ix >= 0x7f800000) return x - x; // sin(Inf or NaN) is NaN
  const [n, y] = remPio2f(x);
  switch (n & 3) {
    case 0:
      return sindf(y);
    case 1:
      return cosdf(y);
    case 2:
      return sindf(-y);
    default:
      return -cosdf(y);
  }
}

/** cosf(x): x a float32. */
export function cosf(x: number): number {
  let ix = bits(x);
  const sign = ix >>> 31;
  ix &= 0x7fffffff;
  if (ix <= 0x3f490fda) {
    // |x| ~<= π/4
    if (ix < 0x39800000) return 1; // |x| < 2**−12
    return cosdf(x);
  }
  if (ix <= 0x407b53d1) {
    // |x| ~<= 5π/4
    if (ix > 0x4016cbe3) return -cosdf(sign ? x + PIO2_2X : x - PIO2_2X); // ~> 3π/4
    return sign ? sindf(x + PIO2_1X) : sindf(PIO2_1X - x);
  }
  if (ix <= 0x40e231d5) {
    // |x| ~<= 9π/4
    if (ix > 0x40afeddf) return cosdf(sign ? x + PIO2_4X : x - PIO2_4X); // ~> 7π/4
    return sign ? sindf(-x - PIO2_3X) : sindf(x - PIO2_3X);
  }
  if (ix >= 0x7f800000) return x - x; // cos(Inf or NaN) is NaN
  const [n, y] = remPio2f(x);
  switch (n & 3) {
    case 0:
      return cosdf(y);
    case 1:
      return sindf(-y);
    case 2:
      return -cosdf(y);
    default:
      return sindf(y);
  }
}

// ------------------------------------------------------ argument reduction

const TOINT = 1.5 / Number.EPSILON;
const PIO4 = 0x1921fb6 * 2 ** -25; // 0x1.921fb6p-1
const INVPIO2 = 6.36619772367581382433e-1; // 53 bits of 2/π
const PIO2_1 = 1.5707963109016418457; // the first 25 bits of π/2
const PIO2_1T = 1.58932547735281966916e-8; // π/2 − PIO2_1

/** x rem π/2 in double, with the quadrant n: [n, y]. */
function remPio2f(x: number): [number, number] {
  const u = bits(x);
  const ix = u & 0x7fffffff;
  if (ix < 0x4dc90fdb) {
    // |x| ~< 2**28·(π/2), medium size: 25 + 53 bits of π are enough.
    let fn = x * INVPIO2 + TOINT - TOINT; // rint
    let n = fn | 0;
    let y = x - fn * PIO2_1 - fn * PIO2_1T;
    // Matters only with directed rounding.
    if (y < -PIO4) {
      n--;
      fn--;
      y = x - fn * PIO2_1 - fn * PIO2_1T;
    } else if (y > PIO4) {
      n++;
      fn++;
      y = x - fn * PIO2_1 - fn * PIO2_1T;
    }
    return [n, y];
  }
  if (ix >= 0x7f800000) return [0, x - x]; // inf or NaN
  // Scale x into [2**23, 2**24 − 1].
  const sign = u >>> 31;
  const e0 = (ix >>> 23) - (0x7f + 23); // ilogb(|x|) − 23, positive
  const tx = fromBits(ix - (e0 << 23));
  const [n, y] = remPio2Large(tx, e0);
  return sign ? [-n, -y] : [n, y];
}

/** 24-bit chunks of 2/π (enough for any float32 argument). */
const IPIO2 = [
  0xa2f983, 0x6e4e44, 0x1529fc, 0x2757d1, 0xf534dd, 0xc0db62, 0x95993c, 0x439041, 0xfe5163,
  0xabdebb, 0xc561b7, 0x246e3a, 0x424dd2, 0xe00649, 0x2eea09, 0xd1921c, 0xfe1deb, 0x1cb129,
  0xa73ee8, 0x8235f5, 0x2ebb44, 0x84e99c, 0x7026b4, 0x5f7e41, 0x3991d6, 0x398353, 0x39f49c,
  0x845f8b, 0xbdf928, 0x3b1ff8, 0x97ffde, 0x05980f, 0xef2f11, 0x8b5a0a, 0x6d1f6d, 0x367ecf,
  0x27cb09, 0xb74f46, 0x3f669e, 0x5fea2d, 0x7527ba, 0xc7ebe5, 0xf17b3d, 0x0739f7, 0x8a5292,
  0xea6bfb, 0x5fb11f, 0x8d5d08, 0x560330, 0x46fc7b, 0x6babf0, 0xcfbc20, 0x9af436, 0x1da9e3,
  0x91615e, 0xe61b08, 0x659985, 0x5f14a0, 0x68408d, 0xffd880, 0x4d7327, 0x310606, 0x1556ca,
  0x73a8c9, 0x60e27b, 0xc08c6b,
];

/** π/2 in 24-bit-wide doubles. */
const PIO2 = [
  1.57079625129699707031, 7.54978941586159635335e-8, 5.39030252995776476554e-15,
  3.28200341580791294123e-22, 1.27065575308067607349e-29, 1.22933308981111328932e-36,
  2.73370053816464559624e-44, 2.16741683877804819444e-51,
];

const scalbn = (x: number, n: number) => x * 2 ** n;
const i32 = (x: number) => x | 0; // C's (int32_t) of a double in range: truncation

/**
 * __rem_pio2_large with one input double (nx = 1) and 24-bit precision
 * (prec = 0), as __rem_pio2f calls it: [n, y].
 */
function remPio2Large(x0: number, e0: number): [number, number] {
  const jk = 3; // init_jk[0]
  const jp = jk;
  const jx = 0; // nx − 1
  let jv = i32((e0 - 3) / 24);
  if (jv < 0) jv = 0;
  let q0 = e0 - 24 * (jv + 1);
  const f = new Float64Array(20);
  const q = new Float64Array(20);
  const fq = new Float64Array(20);
  const iq = new Int32Array(20);
  // f[0] … f[jx + jk], where f[jx + jk] = ipio2[jv + jk]
  for (let i = 0, j = jv - jx, m = jx + jk; i <= m; i++, j++) f[i] = j < 0 ? 0 : IPIO2[j]!;
  for (let i = 0; i <= jk; i++) q[i] = x0 * f[jx + i]!;
  let jz = jk;
  let z: number;
  let n: number;
  let ih: number;
  let carry: number;
  for (;;) {
    // Distill q[] into iq[], reversed.
    z = q[jz]!;
    for (let i = 0, j = jz; j > 0; i++, j--) {
      const fw = i32(2 ** -24 * z);
      iq[i] = i32(z - 2 ** 24 * fw);
      z = q[j - 1]! + fw;
    }
    // n
    z = scalbn(z, q0);
    z -= 8 * Math.floor(z * 0.125); // trim off integers >= 8
    n = i32(z);
    z -= n;
    ih = 0;
    if (q0 > 0) {
      // iq[jz − 1] is needed to determine n
      const i = iq[jz - 1]! >> (24 - q0);
      n += i;
      iq[jz - 1] = iq[jz - 1]! - (i << (24 - q0));
      ih = iq[jz - 1]! >> (23 - q0);
    } else if (q0 === 0) ih = iq[jz - 1]! >> 23;
    else if (z >= 0.5) ih = 2;
    carry = 0;
    if (ih > 0) {
      // q > 0.5
      n += 1;
      for (let i = 0; i < jz; i++) {
        // 1 − q
        const j = iq[i]!;
        if (carry === 0) {
          if (j !== 0) {
            carry = 1;
            iq[i] = 0x1000000 - j;
          }
        } else iq[i] = 0xffffff - j;
      }
      if (q0 > 0) {
        // rare case: chance is 1 in 12
        if (q0 === 1) iq[jz - 1] = iq[jz - 1]! & 0x7fffff;
        else if (q0 === 2) iq[jz - 1] = iq[jz - 1]! & 0x3fffff;
      }
      if (ih === 2) {
        z = 1 - z;
        if (carry !== 0) z -= scalbn(1, q0);
      }
    }
    // Recompute if needed.
    if (z === 0) {
      let j = 0;
      for (let i = jz - 1; i >= jk; i--) j |= iq[i]!;
      if (j === 0) {
        let k = 1;
        while (iq[jk - k] === 0) k++; // the number of terms needed
        for (let i = jz + 1; i <= jz + k; i++) {
          f[jx + i] = IPIO2[jv + i]!;
          q[i] = x0 * f[jx + i]!;
        }
        jz += k;
        continue;
      }
    }
    break;
  }
  // Chop off zero terms.
  if (z === 0) {
    jz -= 1;
    q0 -= 24;
    while (iq[jz] === 0) {
      jz--;
      q0 -= 24;
    }
  } else {
    // Break z into 24 bits if necessary.
    z = scalbn(z, -q0);
    if (z >= 2 ** 24) {
      const fw = i32(2 ** -24 * z);
      iq[jz] = i32(z - 2 ** 24 * fw);
      jz += 1;
      q0 += 24;
      iq[jz] = fw;
    } else iq[jz] = i32(z);
  }
  // The 24-bit chunks as doubles.
  let fw = scalbn(1, q0);
  for (let i = jz; i >= 0; i--) {
    q[i] = fw * iq[i]!;
    fw *= 2 ** -24;
  }
  // PIo2[0 … jp]·q[jz … 0]
  for (let i = jz; i >= 0; i--) {
    let s = 0;
    for (let k = 0; k <= jp && k <= jz - i; k++) s += PIO2[k]! * q[i + k]!;
    fq[jz - i] = s;
  }
  // prec 0: compress fq[] into one double.
  let s = 0;
  for (let i = jz; i >= 0; i--) s += fq[i]!;
  return [n & 7, ih === 0 ? s : -s];
}
