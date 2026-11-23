# Third-party notices

Mochi2D Native's libraries (`mochi2d_core`, `mochi2d_framework`,
`mochi2d_render`, `mochi2d`) link nothing but the C++ standard library. They
contain two third-party components, fdlibm and musl's float32 arctangent,
sine and cosine. Their license files ship with the libraries:
`cmake --install` and the release packages put them in
`share/mochi2d/third_party/` (`fdlibm/LICENSE`, `musl/COPYRIGHT`), beside
this file. The command-line tool, which is not part of the packages, also
contains stb_image (below).

## fdlibm, as adapted by V8

`third_party/fdlibm/fdlibm.cpp` is V8's adaptation of fdlibm
(`src/base/ieee754.cc` of V8 12.4.254, the code behind Node's `Math`
functions), vendored so that `sin`, `cos`, `atan2`, `acos`, `cbrt`, `exp` and
the other transcendental functions give Mochi2D's results under Node, bit for
bit, on every platform. Changed only as its header says (namespace, local
definitions of V8's macros, the fdlibm `sin` and `cos` always). The full
notices are in `third_party/fdlibm/LICENSE`:

- fdlibm: Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
  Developed at SunSoft, a Sun Microsystems, Inc. business. Permission to
  use, copy, modify, and distribute this software is freely granted,
  provided that this notice is preserved.
- V8: Copyright 2014, the V8 project authors. All rights reserved. BSD
  3-clause license.

## musl (float32 arctangent, sine and cosine)

`third_party/musl/src/math/` holds eight files of musl 1.2.6
(https://musl.libc.org/), unchanged: `atan2f.c`, `atanf.c`, `sinf.c`,
`cosf.c`, `__sindf.c`, `__cosdf.c`, `__rem_pio2f.c` and
`__rem_pio2_large.c`, the float32 functions that Mochi2D 0.8.0 and later
use for rotations (from FreeBSD's msun; the float versions by Ian Lance
Taylor, Cygnus Support, debugged and optimized by Bruce D. Evans). They are
compiled as C with a small header of ours in place of musl's internal one
(`third_party/musl/README.md`). musl's license is in
`third_party/musl/COPYRIGHT`:

- musl: Copyright © 2005-2020 Rich Felker, et al. MIT license.
- The files carry Sun Microsystems' notice: Copyright (C) 1993 by Sun
  Microsystems, Inc. All rights reserved. Developed at SunPro, a Sun
  Microsystems, Inc. business. Permission to use, copy, modify, and
  distribute this software is freely granted, provided that this notice is
  preserved.

## stb_image

`third_party/stb/stb_image.h` (stb_image 2.30 by Sean Barrett,
https://github.com/nothings/stb, commit f58f558), unchanged, decodes PNG
textures in the command-line tool (`mochi2d-native render`; only its PNG
decoder is compiled). It is dual-licensed: the MIT license (Copyright (c)
2017 Sean Barrett) or public domain (the Unlicense), at the user's choice;
the text is in `third_party/stb/LICENSE`.

## The Vulkan headers (build time, not vendored)

The Vulkan backend (`src/render/vk/`) is compiled against the Vulkan headers
(`vulkan/vulkan_core.h`, Khronos Group, Apache-2.0 OR MIT) of the system or
the Vulkan SDK, when they are found; it uses their types and constants and
links no Vulkan loader. Nothing of them is copied into this repository.

## Used at test time only

`tests/crosscheck/` runs the project's own reference implementation to check
Mochi2D Native against it. Nothing of these is built into the libraries or
distributed with them.

| Component | License | Use |
| --- | --- | --- |
| Mochi2D (`reference/mochi2d-0.24.1/`), the project's own web runtime | MIT, Copyright (c) 2026 Mochi2D contributors | its conformance tool, render harness, judge and synthetic-model builder produce the cross-check's reference results |
| Playwright and the Chromium it installs (pre-installed locally; CI installs Playwright 1.63.0 globally) | Apache-2.0, BSD-3-Clause | run Mochi2D's render harness for the render cross-check |
| esbuild, TypeScript and the reference's other npm development dependencies (installed by `npm ci` in the reference folder, listed in its `package.json`) | MIT and other permissive licenses, see each package | build and run the reference's tools |
| Node.js | MIT | runs the reference's tools |
| Mesa (EGL, llvmpipe, lavapipe), installed from the system's packages (`libegl-mesa0`, `libegl-dev`, `libgl1-mesa-dri`, `mesa-vulkan-drivers`) | MIT | the headless OpenGL ES and OpenGL contexts of the GL backend's tests (`tests/gl/`) and a Vulkan driver for the Vulkan backend's (`tests/vk/`); the library itself links no GL or Vulkan library |
| ANGLE, built from source by `tests/gl/build_angle.sh` (branch chromium/8010), not vendored; for CI, `.github/workflows/angle.yml` attaches the built `libEGL.so`, `libGLESv2.so` and the Vulkan loader ANGLE builds (`libvulkan.so.1`, Khronos's Vulkan-Loader, Apache-2.0), with both licenses and the revision, to this repository's release `angle-chromium-8010` (test tooling, never part of the library) | BSD-3-Clause | the GL backend's tests on ANGLE's Vulkan backend over SwiftShader, the reference renders' configuration |
| SwiftShader's Vulkan driver, the one Playwright's Chromium ships (`vk_swiftshader_icd.json`, `libvk_swiftshader.so`) | Apache-2.0 | the Vulkan driver of those tests and of the Vulkan backend's |
| The Vulkan loader (`libvulkan1`, `libvulkan-dev`) | Apache-2.0 | the Vulkan backend's test host (`tests/vk/vk_render.cpp`) |
| SPIRV-Cross (`spirv-cross`), from the system's packages | Apache-2.0 | translates the programs' SPIR-V to the committed MSL and HLSL (`tests/gpu/make_shaders.sh`); builds do not need it |
| fxc, the Windows SDK's shader compiler, and WARP, Windows's Direct3D software rasterizer (both part of Windows and its SDK, not distributed) | Microsoft's terms for Windows and its SDK | fxc compiles the committed HLSL when the Direct3D 11 backend is built; WARP runs its tests |
| glslang (`glslangValidator`) and SPIRV-Tools (`spirv-val`), from the system's packages | BSD-3-Clause and others (glslang); Apache-2.0 (SPIRV-Tools) | compile the programs' Vulkan GLSL to the committed SPIR-V (`tests/vk/make_spirv.sh`) and check it; builds do not need them |
