# Engine bindings: design note

What bindings for Unity (C# through P/Invoke), Godot
(GDExtension) and Unreal need from Mochi2D Native: threading, the
motion-sync input, the render path with an engine's own textures and
command buffers, and what a binding wraps. Design only: the bindings come
later, each in its own repository, over the C API (`include/mochi2d.h`) of
a released library. Nothing here changes the library; where a binding
needed something the C API lacked, it is listed at the end (now added).

## 1. One shape for all three

Every binding has the same three layers:

1. **The native layer**: the C API as it is, `mochi2d` as a shared library
   (Unity, Godot) or static library (Unreal, which links modules
   statically on consoles and mobile). No C++ types cross it; handles are
   opaque, statuses and `m2d_error` report failures, and every object is
   created with an allocator the binding chooses: the engine's own
   (`FMemory`, Godot's `memalloc`) or the default (malloc, free).
2. **A thin wrapper per language**: handles in owning objects (C#
   `SafeHandle`, Godot `RefCounted`, Unreal `TUniquePtr` with a deleter),
   statuses turned into the engine's errors, strings as UTF-8.
3. **The engine-facing part**: a component or node that owns a model, an
   instance, an animator and a renderer path, ticks them each frame, and
   draws with the engine's renderer.

The order of a frame, the same in every engine:

```
game thread                         render thread / command buffer
-----------                         ------------------------------
m2d_animator_update(dt)             (previous frame's draw)
  → parameters, part opacities
m2d_instance_evaluate
copy out what the draw needs:
  vertices of changed drawables,
  the frame plan (m2d_render_plan)
hand both to the render thread  →   upload vertices; execute the plan
```

## 2. Threading

The library's rules (design §3): objects are independent; one object is
used from one thread at a time; a model is shared read-only. No global
state, no thread started except the software renderer's optional workers.
For bindings this means:

- **Animator, instance and plan belong to the game thread** (Unity's main
  thread, Godot's main or a `WorkerThreadPool` task per model, Unreal's game
  thread or a task per actor). Many models can be ticked in parallel, one
  task per model, with no locking: the library has nothing shared to lock.
- **The render thread never touches the instance.** At the end of a tick
  the binding copies what the draw needs into a buffer owned by the
  render side: the vertices of the drawables that changed
  (`m2d_instance_copy_changed_vertices`, §6) and the plan's operations
  (a flat array of `m2d_render_op`, plain data). Unity's `CommandBuffer`, Godot's `RenderingServer` calls and
  Unreal's `ENQUEUE_RENDER_COMMAND` all take such a copy. Double buffering
  is enough; nothing waits on the GPU.
- **The GL backend** is for hosts that draw with OpenGL themselves (Godot's
  Compatibility renderer, Unity's GLES3 and OpenGL Core players, desktop
  tools): it runs on the thread where the host's context is current, with
  the instance evaluated before. A binding that evaluates on the game
  thread and draws on a render thread uses the plan path instead, or
  hands the evaluated instance across with a fence (the instance is then
  the render thread's until the draw returns).
- **The software renderer** is for thumbnails, tests and servers; its
  workers are the only threads the library starts, and `threads = 1` keeps
  everything on the caller.

## 3. The motion-sync input

Engines deliver microphone or voice-chat audio on their own audio thread:
Unity's `OnAudioFilterRead` (or a `Microphone` clip polled from the main
thread), Godot's `AudioEffectCapture` (read from the main thread) or an
`AudioStreamGenerator`, Unreal's `Audio::FAudioCapture` callback or a
submix listener.

- `m2d_motion_sync_input_push(input, samples, count)` may be called from
  that audio thread while frames run on the game thread; everything else
  belongs to the game thread. The push copies into a fixed span made at
  creation (`capacity` seconds) and never allocates or locks; when full,
  the oldest samples are dropped and counted
  (`m2d_motion_sync_input_dropped`). Mono `float` samples at the input's
  rate: a binding mixes down and passes the engine's rate when it creates
  the input; motion sync resamples as Mochi2D does.
- Lip sync from levels (`m2d_live_input`) has the same rule: push from the
  audio thread, read on the game thread.
- Sounds with a playback clock (a voice line played by the engine): the
  binding hands the decoded sound to the animator and the engine's playback
  position each frame, so the mouth follows what is heard even when the
  engine's audio runs ahead or stalls.
- A binding never calls the motion-sync analysis on the audio thread: it
  runs in the animator's frame, at Mochi2D's analysis rate.

## 4. The render path with an engine's own textures and command buffers

Two paths, by what the engine allows:

**The plan path** (every engine; Vulkan, Metal, Direct3D 11 and 12,
console APIs): the binding executes the frame plan with the engine's own
objects. The plan is the backend-neutral interface (design §8.10): per
frame, the operations Mochi2D's WebGL2 renderer performs, in order:

| operation | what the binding does |
|---|---|
| `CLEAR` | clear the target (the engine's render texture, premultiplied) |
| `BUILD_MASK` | into a square mask texture (RGBA8 or R8, linear, clamped): scissor, clear to 1, draw the mask meshes red-only with blend ZERO, ONE_MINUS_SRC_ALPHA |
| `OPEN_LAYER` | a frame-sized RGBA8 render texture, cleared to 0 |
| `COPY_DESTINATION` | copy the layer into a second texture (advanced blends read it) |
| `DRAW_MESH` | one draw: the drawable's vertices and triangles, its texture, the blend state, the uniforms of the op, culling |
| `COMPOSITE` | a full-screen triangle reading the layer one to one |

What the binding owns: the textures (from the model's PNGs, prepared as
`m2d_texture_create` prepares them, or the engine's own import with
premultiplied alpha and the exact mips if it wants Mochi2D's look), one
vertex buffer for all drawables (positions dynamic, UVs static from
`m2d_model_drawable_texture_uvs`), one index buffer (from
`m2d_model_drawable_indices`), the two mask textures, the layers, the
destination copy and the two shader pairs (mesh and full-screen, each with
and without the advanced blend). The shaders are the GL backend's GLSL
(`src/render/gl/gl_renderer.cpp`), which ports to HLSL and to engine shader
graphs line by line; the uniforms are the op's fields. All of it lives in
the engine's allocators, as the engine's own resources, so the engine's
memory tracking, streaming and device-loss handling apply.

- **Unity**: a `CommandBuffer` per model, rebuilt from the plan each frame
  (or cached while the plan's shape is the same), executed by a URP
  `ScriptableRenderPass` or HDRP custom pass, or `Graphics.ExecuteCommandBuffer`
  into a `RenderTexture` shown by a quad. `Mesh` with `MeshUpdateFlags` for
  the vertex upload, `MaterialPropertyBlock` per draw for the uniforms,
  `BlendMode` states as shader keywords or render-state blocks.
- **Godot**: a `SubViewport` (or `RenderingServer` canvas items with
  `CanvasItemMaterial` blend modes for the direct pipeline) for the target;
  masks and layers as `RenderingServer` viewports or, with the Forward+ or
  Mobile renderer, a `RenderingDevice` path (compute and draw lists) that
  executes the plan directly. With the Compatibility renderer (OpenGL ES 3),
  the binding can call the GL backend inside a `RenderingServer`
  callback with Godot's context current.
- **Unreal**: an RDG pass sequence (`FRDGBuilder`) per model on the render
  thread: render targets for masks and layers from the RDG pool, global
  shaders for the two programs, `TStaticBlendState` per blend kind, the
  vertex data in an `FRDGBuffer` uploaded from the copy. The output is a
  render target sampled by a material (a plane, a widget, a niagara
  sprite).

**The GL backend path** (engines that draw with OpenGL ES 3.0 or desktop
OpenGL 3.3 and hand over their context): `m2d_gl_renderer_create` with the
engine's loader, `m2d_gl_renderer_draw` into the engine's framebuffer. It
owns its GL objects and restores a predictable state, but a binding must
re-bind its own state afterwards (programs, vertex arrays, blend).

Either way the result is premultiplied: engines composite it with ONE,
ONE_MINUS_SRC_ALPHA, or un-premultiply in their material.

**The Vulkan backend path** (engines that hand over their
Vulkan device and a command buffer: Godot's Forward+ and Mobile renderers
through `RenderingDevice`'s driver handles, Unity's native rendering
plugins with `IUnityGraphicsVulkan`, Unreal's `IVulkanDynamicRHI`):
`m2d_vk_renderer_create` with the engine's `vkGetInstanceProcAddr`,
instance, physical device, device and queue; `m2d_vk_renderer_draw` records
into the engine's command buffer and draws into the engine's image (a
render texture), leaving it in the layout the engine asks for. Its
programs are the same text compiled to SPIR-V, which a plan executor can
also take (`m2d_render_shader_spirv`).

The Metal and Direct3D 11 backends are executors of the same plan, so a
binding written for the plan path works with them too.

## 5. What a binding wraps

| layer | C API | Unity | Godot | Unreal |
|---|---|---|---|---|
| model and package | `m2d_package_*`, `m2d_model_*` with a file callback | `ScriptableObject` asset imported from the folder | `Resource` with an `EditorImportPlugin` | `UObject` asset with a factory |
| instance and animator | `m2d_instance_*`, `m2d_animator_*` | `MonoBehaviour` ticking in `Update` | `Node2D`/`Node3D` in `_process` | `UActorComponent` in `TickComponent` |
| parameters, motions, expressions, look, physics | `m2d_animator_*`, `m2d_motion_*` | properties, an animator-state bridge | exported properties, signals for motion ends and events | `UPROPERTY`s, Blueprint nodes, delegates |
| lip sync and motion sync | `m2d_live_input_*`, `m2d_motion_sync_*`, `m2d_voice_profile_*` | audio filter component | `AudioEffectCapture` reader | audio capture component |
| hit areas, user data | `m2d_model_*`, `m2d_user_data_*` | raycast helper | `Area2D` helper | collision helper |
| rendering | `m2d_render_plan_*` (or `m2d_gl_renderer_*`) | `CommandBuffer` executor | `RenderingDevice` / canvas executor | RDG executor |
| allocation | `m2d_allocator` | default | `memalloc` | `FMemory` |

Platform packaging: Unity plugins per platform (`.dll`, `.so`, `.dylib`,
static `.a` for iOS with `__Internal`), Godot `.gdextension` with a library
per platform, Unreal a third-party module with prebuilt static libraries
per platform. The library has no dependencies, so every package is one
library and one header.

## 6. The C API's additions for bindings (done)

- **Vertex versions and the instance serial:**
  `m2d_instance_drawable_vertex_version(instance, index)` changes whenever
  an evaluation may have written the drawable's vertices (equal versions,
  equal vertices); `m2d_instance_serial(instance)` is a number no other
  instance of the process has had, since a new instance can take a
  destroyed one's address. A cache is keyed on both.
- **The bulk copy of changed vertices:**
  `m2d_instance_copy_changed_vertices(instance, &sync, out, capacity,
  changed, &count)` copies the drawables that changed since the last call
  with `sync` (all of them for another instance) into one buffer in the
  model's vertex layout (`m2d_model_vertex_total`,
  `m2d_model_drawable_vertex_offset`), and lists them, so the render side
  uploads only those ranges. `m2d_vertex_sync` holds the serial and the
  caller's version array, and starts with its `size`.
- **A size field in the op struct:** `m2d_render_op.size` (and
  `m2d_render_op_size()`) is the library's `sizeof(m2d_render_op)`; a C#
  or Unreal declaration compares it with its own at load. (The mask
  build's buffer side is now `buffer_size`.)
- **The shader sources:** `m2d_render_shader_source(program, stage,
  dialect)` gives the GL backend's text (the mesh, mesh-advanced, layer,
  layer-advanced and mask programs; GLSL ES 3.00 or GLSL 3.30), the same
  string the backend compiles, for plan executors to port.

A tick, with them:

```c
m2d_animator_update(animator, instance, dt, &frame, &err);
m2d_render_plan_frame(plan, instance, &render_frame, w, h, &err);
m2d_instance_copy_changed_vertices(instance, &sync, staging, staging_floats, changed, &n, ...);
const m2d_render_op* ops = m2d_render_plan_ops(plan, &op_count);
/* hand staging[changed ranges] and a copy of ops to the render thread */
```
