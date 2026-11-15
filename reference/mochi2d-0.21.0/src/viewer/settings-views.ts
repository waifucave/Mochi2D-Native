/**
 * The settings area: details and settings of the item selected in the
 * resource tree.
 *
 * - The model settings: the files it ties together, groups, hit areas, notes.
 * - The `.moc3` (the model-file inspector): statistics, then parameters, parts,
 *   art meshes (picking one makes it flash in the view), offscreens and the
 *   draw order now.
 * - A texture: its sizes and a preview.
 * - The physics: the rate in use, and per setting its particles, inputs
 *   (sideways and angle) and outputs.
 * - A motion: its group, fades (the settings', else the file's, else 1000 ms),
 *   loop playback, sound and motion-sync setting, frame rate, events, and its
 *   curve graph.
 * - An expression: its fades (the file's, else 500 ms) and values by blend.
 * - The pose, the user data, the display information.
 * - The motion-sync settings, with a preview: a WAV file through a setting.
 */
import type { FileSource } from "../core/io/file-source.js";
import type { ModelSettings } from "../core/settings/model-settings.js";
import { parseMotion, type Motion } from "../anim/motion.js";
import { parseExpression } from "../anim/expression.js";
import type { Expression, ExpressionBlend } from "../anim/expression.js";
import { LiveModel } from "../lib/live-model.js";
import { CurveGraph } from "./curves.js";
import type { ResourceNode } from "./resources.js";
import type { MocDifference } from "../core/moc/compare.js";
import type { EditSession } from "./editing.js";
import { poseWarnings, switchedValue, type ExpressionDraft, type PoseDraft } from "./edit-files.js";

/** Default fades the viewer uses when a file gives none (milliseconds). */
export const DEFAULT_FADES = { motion: 1000, expression: 500, pose: 500 } as const;

export interface SettingsContext {
  source(): FileSource | null;
  settings(): ModelSettings | null;
  /** Settings files of the folder, for switching. */
  settingsFiles(): string[];
  settingsPath(): string | null;
  switchSettings(path: string): void;
  live(): LiveModel | null;
  setStatus(text: string, error?: boolean): void;
  playMotion(node: ResourceNode, options: { loop: boolean }): Promise<void>;
  playExpression(node: ResourceNode): Promise<void>;
  /** Makes an art mesh flash in the view. */
  flash(meshId: string): void;
  exportSettings(): void;
  /** Notes about the loaded model (effects, warnings). */
  notes(): string[];
  /** Which lip sync drives the mouth now, in words. */
  activeLipSync(): string;
  /** The open model's edits, or null. */
  edits(): EditSession | null;
  /**
   * After an edit: the unsaved marks again, and with `tree` the resource
   * tree from the edited settings, selecting the node `select` finds.
   */
  edited(o: { tree?: boolean; select?: (n: ResourceNode) => boolean }): void;
  /** Shows an expression being edited (at once, without its fade-in). */
  preview(exp: Expression): void;
  /** The folder's sound files, by path in the source. */
  soundFiles(): string[];
  /** The names of the model's motion-sync settings. */
  motionSyncNames(): string[];
  /** Downloads one edited file. */
  exportFile(path: string): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children);
  return e;
};

const short = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const ms = (seconds: number) => `${Math.round(seconds * 1000)} ms`;

/** A fade time from a file where a negative value or none means the default. */
function fileFade(value: unknown, defaultMs: number): string {
  if (typeof value === "number" && value >= 0) return `${ms(value)} (file)`;
  return typeof value === "number"
    ? `${defaultMs} ms (default: the file's is negative)`
    : `${defaultMs} ms (default: the file has none)`;
}

/** A two-column table of rows. */
function table(head: string[], rows: (string | number | Node)[][], className = ""): HTMLElement {
  const t = el("table", { className: `kv ${className}` });
  if (head.length) t.append(el("thead", {}, el("tr", {}, ...head.map((h) => el("th", {}, h)))));
  const body = el("tbody");
  for (const r of rows)
    body.append(el("tr", {}, ...r.map((c) => el("td", {}, c instanceof Node ? c : String(c)))));
  t.append(body);
  return t;
}

/** A collapsible section whose content is built when first opened (long lists). */
function lazySection(title: string, build: () => HTMLElement, open = false): HTMLElement {
  const d = el("details", { className: "section" });
  d.append(el("summary", {}, title));
  let built = false;
  const fill = () => {
    if (built || !d.open) return;
    built = true;
    d.append(build());
  };
  d.addEventListener("toggle", fill);
  if (open) {
    d.open = true;
    fill();
  }
  return d;
}

const empty = (text: string) => el("p", { className: "empty" }, text);

/** Puts text on the clipboard (with the older copy command where the API is unavailable). */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Not allowed here (an insecure page, or no permission): the copy command.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  if (!ok) throw new Error("copy refused");
}

export class SettingsArea {
  private node: ResourceNode | null = null;
  /** Viewer-only loop playback per motion (not exported). */
  private readonly loops = new Map<string, boolean>();
  private activeLine: HTMLElement | null = null;
  private preview: { stop(): void } | null = null;

  constructor(
    private readonly title: HTMLElement,
    private readonly body: HTMLElement,
    private readonly ctx: SettingsContext,
  ) {}

  /** The node shown, or null. */
  get shown(): ResourceNode | null {
    return this.node;
  }

  clear(text = "Select an item in Resources to see its settings."): void {
    this.node = null;
    this.activeLine = null;
    this.title.textContent = "Settings";
    this.body.replaceChildren(empty(text));
  }

  /** Shows a node's settings (asynchronously for files that are read first). */
  async show(node: ResourceNode, view: "settings" | "curves" = "settings"): Promise<void> {
    this.node = node;
    this.activeLine = null;
    this.title.textContent = `${node.label}${view === "curves" ? " — curves" : ""}`;
    this.body.dataset.kind = node.kind;
    let content: HTMLElement;
    try {
      content = await this.render(node, view);
    } catch (e) {
      content = empty(`${node.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Another selection may have come while this one was being read.
    if (this.node !== node) return;
    this.body.replaceChildren(content);
  }

  /** Updates what changes while the model runs (a few times a second). */
  refresh(): void {
    if (this.activeLine) this.activeLine.textContent = this.ctx.activeLipSync();
  }

  private async read(path: string): Promise<Uint8Array> {
    const src = this.ctx.source();
    if (!src) throw new Error("no model is open");
    return src.read(path);
  }

  private async render(node: ResourceNode, view: "settings" | "curves"): Promise<HTMLElement> {
    const live = this.ctx.live();
    switch (node.kind) {
      case "settings":
        return this.settingsView();
      case "moc":
        return live ? this.mocView(live) : empty("Loading…");
      case "textures":
        return empty(`${node.children?.length ?? 0} textures. Select one for its preview.`);
      case "texture":
        return this.textureView(node, live);
      case "physics":
        return live ? this.physicsView(live) : empty("Loading…");
      case "motions":
      case "motionGroup":
        return empty(
          `${node.children?.length ?? 0} item(s). Double-click a motion to play it; right-click it for its curves.`,
        );
      case "motion":
        return view === "curves" ? this.curvesView(node, live) : this.motionView(node);
      case "expressions":
        return this.expressionsView(node);
      case "expression":
        return this.expressionView(node);
      case "pose":
        return live ? this.poseView(live, node) : empty("Loading…");
      case "userData":
        return live ? this.userDataView(live) : empty("Loading…");
      case "motionSync":
        return live ? this.motionSyncView(live) : empty("Loading…");
      case "displayInfo":
        return live ? this.displayInfoView(live) : empty("Loading…");
    }
  }

  // ------------------------------------------------------------ model settings

  private settingsView(): HTMLElement {
    const box = el("div", { className: "settings-view" });
    const s = this.ctx.settings();
    const files = this.ctx.settingsFiles();
    if (files.length > 1) {
      const sel = el("select", { title: "Settings files of the folder" });
      for (const f of files) sel.append(new Option(f, f, false, f === this.ctx.settingsPath()));
      sel.addEventListener("change", () => this.ctx.switchSettings(sel.value));
      box.append(el("label", { className: "field" }, "Settings file ", sel));
    }
    if (!s) {
      box.append(empty("The settings are not loaded."));
      return box;
    }
    const groups = s.groups.map((g) => [`${g.target} group ${g.name}`, g.ids.join(", ") || "—"]);
    box.append(
      table(
        [],
        [
          ["Model file", s.moc],
          ["Textures", String(s.textures.length)],
          ["Physics", s.physics ?? "—"],
          ["Pose", s.pose ?? "—"],
          ["User data", s.userData ?? "—"],
          ["Display info", s.displayInfo ?? "—"],
          ["Motion sync", s.motionSync ?? "—"],
          ["Expressions", String(s.expressions.length)],
          [
            "Motion groups",
            s.motions.map((g) => `${g.group} (${g.entries.length})`).join(", ") || "—",
          ],
          ["Hit areas", s.hitAreas.map((h) => h.name || h.id).join(", ") || "—"],
          ...groups,
        ],
      ),
    );
    const notes = this.ctx.notes();
    if (notes.length) box.append(el("p", { className: "empty notes" }, notes.join(" ")));
    const exp = el("button", { type: "button", className: "btn small" }, "Export");
    exp.title =
      "Ctrl+S: the model settings, or with several changed files a .zip of the settings and every changed file";
    exp.addEventListener("click", () => this.ctx.exportSettings());
    const row = el("div", { className: "row" }, exp);
    const edits = this.ctx.edits();
    if (edits && !edits.posePath) {
      const add = el("button", { type: "button", className: "btn small" }, "New pose");
      add.dataset.act = "new-pose";
      add.title = "A .pose3.json listing every part, referred to in the settings";
      add.addEventListener("click", () => {
        edits.createPose();
        this.ctx.edited({ tree: true, select: (n) => n.kind === "pose" });
      });
      row.append(add);
    }
    box.append(row);
    return box;
  }

  // ------------------------------------------------------- model-file inspector

  private mocView(live: LiveModel): HTMLElement {
    const m = live.loaded.model;
    const info = live.runtime.bundle.displayInfo;
    const names = new Map<string, string>();
    for (const p of info?.parameters ?? []) names.set(p.id, p.name);
    for (const p of info?.parts ?? []) names.set(p.id, p.name);
    const label = (id: string) => (names.get(id) ? `${names.get(id)} (${id})` : id);
    const warps = m.deformers.kind.filter((k) => k === 0).length;
    const box = el("div", { className: "inspector" });
    box.append(
      table(
        [],
        [
          ["File version", `${m.version}`],
          [
            "Canvas",
            `${m.canvas.width} × ${m.canvas.height} px, ${m.canvas.pixelsPerUnit} px per unit`,
          ],
          ["Parameters", m.parameters.ids.length],
          ["Parts", m.parts.ids.length],
          ["Art meshes", m.meshes.ids.length],
          [
            "Deformers",
            `${m.deformers.ids.length} (${warps} warp, ${m.deformers.ids.length - warps} rotation)`,
          ],
          ["Glues", m.glues.ids.length],
          ["Offscreens", m.offscreens.part.length],
          ["Masked art meshes", m.meshes.masks.filter((x) => x.length > 0).length],
          ["Pipeline", live.renderer.layered ? "layered" : "direct"],
        ],
      ),
    );
    const p = m.parameters;
    box.append(
      lazySection(`Parameters (${p.ids.length})`, () =>
        table(
          ["ID", "Min", "Default", "Max"],
          p.ids.map((id, i) => [label(id), p.min[i]!, p.defaults[i]!, p.max[i]!]),
        ),
      ),
    );
    box.append(
      lazySection(`Parts (${m.parts.ids.length})`, () =>
        table(
          ["ID", "Parent"],
          m.parts.ids.map((id, i) => [label(id), m.parts.ids[m.parts.parent[i]!] ?? "—"]),
        ),
      ),
    );
    box.append(
      lazySection(`Art meshes (${m.meshes.ids.length}): click one to make it flash`, () => {
        const list = el("div", { className: "mesh-list" });
        m.meshes.ids.forEach((id, d) => {
          const b = el("button", { type: "button", className: "link mesh-item" }, id);
          b.dataset.mesh = id;
          b.title = `texture ${m.meshes.texture[d]}, blend ${m.meshes.blendMode[d]}, ${m.meshes.vertexCount[d]} vertices, ${m.meshes.triangles[d]!.length / 3} triangles${m.meshes.masks[d]!.length ? `, masked by ${m.meshes.masks[d]!.length}` : ""}`;
          b.addEventListener("click", () => this.ctx.flash(id));
          list.append(b);
        });
        return list;
      }),
    );
    if (m.offscreens.part.length)
      box.append(
        lazySection(`Offscreens (${m.offscreens.part.length})`, () =>
          table(
            ["Owner part", "Blend", "Masks"],
            Array.from(m.offscreens.part, (part, o) => [
              label(m.parts.ids[part] ?? String(part)),
              m.offscreens.blendMode[o]!,
              m.offscreens.masks[o]!.length,
            ]),
          ),
        ),
      );
    box.append(
      lazySection("Draw order now", () => {
        const inst = live.runtime.instance;
        const order = m.meshes.ids
          .map((id, d) => ({
            id,
            pos: inst.drawableRenderOrder[d]!,
            value: inst.drawableDrawOrder[d]!,
          }))
          .sort((a, b) => a.pos - b.pos);
        return table(
          ["#", "Art mesh", "Draw order"],
          order.map((o) => [o.pos, o.id, o.value]),
        );
      }),
    );
    return box;
  }

  // ------------------------------------------------------------------ texture

  private async textureView(node: ResourceNode, live: LiveModel | null): Promise<HTMLElement> {
    const box = el("div", { className: "texture-view" });
    const t = live?.textures[node.texture ?? -1];
    if (t)
      box.append(
        table(
          [],
          [
            ["File", node.path ?? ""],
            ["Stored size", `${t.originalWidth} × ${t.originalHeight}`],
            [
              "Uploaded size",
              `${t.texture.width} × ${t.texture.height}${t.scale < 1 ? ` (scaled ${t.scale.toFixed(3)})` : ""}`,
            ],
          ],
        ),
      );
    if (node.path) {
      const bytes = await this.read(node.path);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" }));
      const img = el("img", {
        className: "texture-preview",
        alt: `Texture ${node.label}`,
        src: url,
      });
      img.addEventListener("load", () => setTimeout(() => URL.revokeObjectURL(url), 1000), {
        once: true,
      });
      box.append(img);
    }
    return box;
  }

  // ------------------------------------------------------------------ physics

  private physicsView(live: LiveModel): HTMLElement {
    const box = el("div", { className: "physics-view" });
    const rig = live.runtime.animator.physics;
    if (!rig) return empty("The physics file could not be read; see the model settings' notes.");
    const file = rig.file;
    const rate = live.runtime.physicsRate;
    const viewFps = live.lastFrame ? "the view's frame rate" : "the frame rate";
    const rateText =
      rate > 0
        ? `${rate} steps per second${rig.rate === null ? " (the file's Fps)" : " (set in the viewer)"}`
        : `one step per frame, at ${viewFps} (the file has no Fps)`;
    box.append(el("p", { className: "physics-rate" }, `Rate in use: ${rateText}`));
    const choose = el("select", { title: "The simulation rate (not exported)" });
    const options: [string, string][] = [
      ["", `the file's (${file.fps > 0 ? `${file.fps}` : "per frame"})`],
      ["0", "one step per frame"],
      ["30", "30 per second"],
      ["60", "60 per second"],
      ["120", "120 per second"],
    ];
    for (const [v, t] of options)
      choose.append(new Option(t, v, false, (rig.rate === null ? "" : String(rig.rate)) === v));
    choose.addEventListener("change", () => {
      live.runtime.setPhysicsRate(choose.value === "" ? null : Number(choose.value));
      void this.show(this.node!);
    });
    box.append(el("label", { className: "field" }, "Rate ", choose));
    const names = new Map(file.names.map((n) => [n.id, n.name]));
    const particles = file.settings.reduce((a, s) => a + s.particles.length, 0);
    box.append(
      table(
        [],
        [
          ["Groups", file.settings.length],
          ["Particles", particles],
          ["Inputs", file.settings.reduce((a, s) => a + s.inputs.length, 0)],
          ["Outputs", file.settings.reduce((a, s) => a + s.outputs.length, 0)],
        ],
      ),
    );
    box.append(
      lazySection(
        `Groups (${file.settings.length})`,
        () =>
          table(
            ["Group", "Stages", "Sideways inputs", "Angle inputs", "Outputs"],
            file.settings.map((s) => [
              names.get(s.id) ?? s.id,
              Math.max(0, s.particles.length - 1),
              s.inputs
                .filter((i) => i.type !== "Angle")
                .map((i) => i.source)
                .join(", ") || "—",
              s.inputs
                .filter((i) => i.type === "Angle")
                .map((i) => i.source)
                .join(", ") || "—",
              s.outputs.map((o) => o.destination).join(", ") || "—",
            ]),
            "wide",
          ),
        true,
      ),
    );
    return box;
  }

  // ------------------------------------------------------------------- motion

  private async loadMotion(
    node: ResourceNode,
  ): Promise<{ motion: Motion; raw: Record<string, unknown> }> {
    const bytes = await this.read(node.path!);
    const motion = parseMotion(bytes, node.path!);
    const raw = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    return { motion, raw };
  }

  private async motionView(node: ResourceNode): Promise<HTMLElement> {
    const { motion, raw } = await this.loadMotion(node);
    const meta = (raw.Meta ?? {}) as Record<string, unknown>;
    const entry = node.entry;
    const fade = (fromEntry: number | undefined, key: string) => {
      if (fromEntry !== undefined && fromEntry >= 0) return `${ms(fromEntry)} (settings)`;
      return fileFade(meta[key], DEFAULT_FADES.motion);
    };
    const box = el("div", { className: "motion-view" });
    box.append(
      table(
        [],
        [
          [
            "Group",
            node.group !== undefined
              ? `${node.group || "(no name)"} [${node.index}]`
              : "not in the settings",
          ],
          ["File", node.path!],
          ["Duration", `${motion.duration.toFixed(3)} s`],
          ["Frame rate", `${motion.fps} fps`],
          ["Loop flag in the file", meta.Loop === true ? "yes (not used in playback)" : "no"],
          [
            "Curves",
            `${motion.curves.length}${motion.ignoredCurves ? ` (${motion.ignoredCurves} ignored)` : ""}`,
          ],
          ["Fade-in", fade(entry?.fadeInTime, "FadeInTime")],
          ["Fade-out", fade(entry?.fadeOutTime, "FadeOutTime")],
          ["Sound", entry?.sound ?? "—"],
          ["Motion-sync setting", entry?.motionSync ?? "—"],
        ],
      ),
    );
    const editor = this.motionEditor(node, meta);
    if (editor) box.append(editor);
    const loop = el("input", { type: "checkbox", checked: this.loops.get(node.key) ?? false });
    loop.addEventListener("change", () => this.loops.set(node.key, loop.checked));
    const play = el("button", { type: "button", className: "btn small" }, "▶ Play");
    play.dataset.act = "play";
    play.addEventListener(
      "click",
      () => void this.ctx.playMotion(node, { loop: this.loops.get(node.key) ?? false }),
    );
    const curves = el("button", { type: "button", className: "btn small" }, "Curves");
    curves.addEventListener("click", () => void this.show(node, "curves"));
    box.append(
      el(
        "div",
        { className: "row wrap" },
        play,
        el(
          "label",
          { className: "check", title: "Viewer only, not exported" },
          loop,
          " loop playback",
        ),
        curves,
      ),
    );
    box.append(el("div", { className: "slider-group" }, `Events (${motion.events.length})`));
    box.append(
      motion.events.length
        ? table(
            ["Time", "Value"],
            motion.events.map((e) => [`${e.time.toFixed(3)} s`, e.value]),
          )
        : empty("No events."),
    );
    return box;
  }

  /**
   * The motion's settings entry, editable: its group (a new name makes a
   * group; blank takes it out of the settings), fades, sound and
   * motion-sync setting. A motion the settings don't list gets a group first.
   */
  private motionEditor(node: ResourceNode, meta: Record<string, unknown>): HTMLElement | null {
    const edits = this.ctx.edits();
    if (!edits || !node.path) return null;
    const path = node.path;
    const entry = node.entry;
    const at =
      node.group !== undefined && node.index !== undefined
        ? { group: node.group, index: node.index }
        : null;
    const same = (n: ResourceNode) =>
      n.kind === "motion" && n.path === path && n.group === at?.group && n.index === at?.index;
    const box = el("div", { className: "editor motion-editor" });
    box.append(el("div", { className: "slider-group" }, "Settings entry"));
    const field = (label: string, input: HTMLElement) =>
      el("label", { className: "field" }, `${label} `, input);

    const groups = el("datalist", { id: "motion-group-names" });
    for (const g of edits.settings.motions) groups.append(new Option(g.group, g.group));
    const group = el("input", {
      type: "text",
      value: at?.group ?? "",
      placeholder: "not in the settings",
    });
    group.setAttribute("list", groups.id);
    group.dataset.field = "group";
    group.addEventListener("change", () => {
      const name = group.value.trim();
      if (at) {
        const place = edits.moveMotion(at, name === "" ? null : name, path);
        this.ctx.edited({
          tree: true,
          select: (n) =>
            n.kind === "motion" &&
            n.path === path &&
            (place ? n.group === place.group && n.index === place.index : n.group === undefined),
        });
      } else if (name !== "") {
        const place = edits.addMotion(path, name);
        this.ctx.edited({
          tree: true,
          select: (n) => n.kind === "motion" && n.group === place.group && n.index === place.index,
        });
      }
    });
    box.append(groups, field("Group", group));

    const fromFile = (key: string) => {
      const v = meta[key];
      return typeof v === "number" && v >= 0
        ? `file: ${ms(v)}`
        : `default: ${DEFAULT_FADES.motion} ms`;
    };
    const fade = (key: "fadeIn" | "fadeOut", fileKey: string, current: number | undefined) => {
      const input = el("input", {
        type: "number",
        min: "0",
        step: "50",
        value: current !== undefined && current >= 0 ? String(Math.round(current * 1000)) : "",
        placeholder: fromFile(fileKey),
        disabled: !at,
      });
      input.dataset.field = key;
      input.title = "Milliseconds; blank: the file's (or the default)";
      input.addEventListener("change", () => {
        const text = input.value.trim();
        const v = text === "" ? null : Number(text) / 1000;
        if (!at || (v !== null && !(v >= 0))) return;
        edits.editMotion(at, { [key]: v }, path);
        this.ctx.edited({ tree: true, select: same });
      });
      return input;
    };
    box.append(
      field("Fade-in (ms)", fade("fadeIn", "FadeInTime", entry?.fadeInTime)),
      field("Fade-out (ms)", fade("fadeOut", "FadeOutTime", entry?.fadeOutTime)),
    );

    const choice = (
      key: "sound" | "motionSync",
      options: string[],
      current: string | undefined,
    ) => {
      const sel = el("select", { disabled: !at });
      sel.dataset.field = key;
      sel.append(new Option("(none)", ""));
      const all = current && !options.includes(current) ? [...options, current] : options;
      for (const o of all) sel.append(new Option(o, o, false, o === current));
      sel.addEventListener("change", () => {
        if (!at) return;
        edits.editMotion(at, { [key]: sel.value === "" ? null : sel.value }, path);
        this.ctx.edited({ tree: true, select: same });
      });
      return sel;
    };
    const sounds = this.ctx.soundFiles().map((p) => edits.relative(p));
    const sync = this.ctx.motionSyncNames();
    const syncSelect = choice("motionSync", sync, entry?.motionSync);
    if (!sync.length && !entry?.motionSync) {
      syncSelect.disabled = true;
      syncSelect.title = "The model has no motion-sync file";
    }
    box.append(
      field("Sound", choice("sound", sounds, entry?.sound)),
      field("Motion-sync setting", syncSelect),
    );
    if (!at) box.append(empty("Give it a group to list it in the model settings."));
    return box;
  }

  /** Whether a node's motion should loop when played from the tree. */
  loopsFor(node: ResourceNode): boolean {
    return this.loops.get(node.key) ?? false;
  }

  private async curvesView(node: ResourceNode, live: LiveModel | null): Promise<HTMLElement> {
    const { motion } = await this.loadMotion(node);
    const m = live?.loaded.model;
    const range = (target: string, id: string) => {
      if (target !== "Parameter" || !m) return { min: 0, max: 1 };
      const i = m.parameters.ids.indexOf(id);
      return i < 0 ? null : { min: m.parameters.min[i]!, max: m.parameters.max[i]! };
    };
    const graph = new CurveGraph(motion, range);
    const back = el("button", { type: "button", className: "btn small" }, "← Settings");
    back.addEventListener("click", () => void this.show(node));
    const box = el(
      "div",
      { className: "curves-view" },
      el("div", { className: "row" }, back),
      graph.element,
    );
    return box;
  }

  // --------------------------------------------------------------- expression

  /** The expressions branch: how many, and a new expression, named here. */
  private expressionsView(node: ResourceNode): HTMLElement {
    const box = el("div", { className: "expressions-view" });
    box.append(
      empty(
        `${node.children?.length ?? 0} expression(s). Double-click one to play it over the motions.`,
      ),
    );
    const edits = this.ctx.edits();
    if (!edits) return box;
    const name = el("input", { type: "text", placeholder: "Name of a new expression" });
    name.dataset.field = "new-expression-name";
    const add = el("button", { type: "button", className: "btn small" }, "New expression");
    add.dataset.act = "new-expression";
    const create = () => {
      try {
        const path = edits.createExpression(name.value);
        this.ctx.edited({
          tree: true,
          select: (n) => n.kind === "expression" && n.path === path,
        });
        this.ctx.setStatus(`New expression ${name.value.trim()}: check the parameters it sets`);
      } catch (e) {
        this.ctx.setStatus(e instanceof Error ? e.message : String(e), true);
      }
    };
    add.addEventListener("click", create);
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") create();
    });
    box.append(el("div", { className: "row wrap editor" }, name, add));
    return box;
  }

  private async expressionView(node: ResourceNode): Promise<HTMLElement> {
    const bytes = await this.read(node.path!);
    const raw = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const exp = parseExpression(bytes, node.path!);
    // Any number in the file counts (a negative fade-in keeps the expression
    // at weight 0); without one the viewer uses its default.
    const fade = (key: string) => {
      const v = raw[key];
      if (typeof v !== "number")
        return `${DEFAULT_FADES.expression} ms (default: the file has none)`;
      return key === "FadeInTime" && v < 0
        ? `${ms(v)} (file: the expression stays at weight 0)`
        : `${ms(v)} (file)`;
    };
    const box = el("div", { className: "expression-view" });
    const info = table(
      [],
      [
        ["File", node.path!],
        ["Fade-in", fade("FadeInTime")],
        ["Fade-out", fade("FadeOutTime")],
      ],
    );
    box.append(info);
    const play = el("button", { type: "button", className: "btn small" }, "▶ Play");
    play.addEventListener("click", () => void this.ctx.playExpression(node));
    const actions = el("div", { className: "row wrap" }, play);
    box.append(actions);
    const edits = this.ctx.edits();
    const live = this.ctx.live();
    if (!edits || !live) {
      box.append(
        table(
          ["Parameter", "Value", "Blend"],
          exp.parameters.map((p) => [p.id, p.value, p.blend]),
        ),
      );
      return box;
    }
    const exportBtn = el("button", { type: "button", className: "btn small" }, "Export .exp3.json");
    exportBtn.dataset.act = "export-file";
    exportBtn.addEventListener("click", () => this.ctx.exportFile(node.path!));
    actions.append(exportBtn);
    box.append(this.expressionEditor(node.path!, await edits.expression(node.path!), edits, live));
    return box;
  }

  /**
   * Every parameter with a check box (in the expression or not), its value
   * and its blend. An Add value is the parameter's value; right-clicking a
   * parameter switches it to Multiply (a factor, from 1) and back.
   */
  private expressionEditor(
    path: string,
    draft: ExpressionDraft,
    edits: EditSession,
    live: LiveModel,
  ): HTMLElement {
    const box = el("div", { className: "editor expression-editor" });
    const params = live.loaded.model.parameters;
    const names = new Map(
      (live.runtime.bundle.displayInfo?.parameters ?? []).map((p) => [p.id, p.name]),
    );
    const commit = async () => {
      const exp = await edits.setExpression(path, draft, DEFAULT_FADES.expression / 1000);
      this.ctx.preview(exp);
      this.ctx.edited({});
    };
    const fadeInput = (key: "fadeIn" | "fadeOut") => {
      const v = draft[key];
      const input = el("input", {
        type: "number",
        step: "50",
        value: v === null ? "" : String(Math.round(v * 1000)),
        placeholder: `default: ${DEFAULT_FADES.expression} ms`,
      });
      input.dataset.field = key;
      input.addEventListener("change", () => {
        const text = input.value.trim();
        const n = Number(text);
        if (text !== "" && !Number.isFinite(n)) return;
        draft[key] = text === "" ? null : n / 1000;
        void commit();
      });
      return input;
    };
    box.append(
      el("div", { className: "slider-group" }, "Edit"),
      el(
        "div",
        { className: "row wrap" },
        el("label", { className: "field" }, "Fade-in (ms) ", fadeInput("fadeIn")),
        el("label", { className: "field" }, "Fade-out (ms) ", fadeInput("fadeOut")),
      ),
    );
    // A new (empty) expression lists every parameter, so there is something to check.
    const all = el("input", { type: "checkbox", checked: draft.rows.length === 0 });
    all.dataset.field = "all-parameters";
    const filter = el("input", { type: "search", placeholder: "Filter parameters…" });
    box.append(
      el(
        "div",
        { className: "row wrap" },
        el("label", { className: "check" }, all, " every parameter"),
        filter,
      ),
      el(
        "p",
        { className: "empty" },
        "Add: the parameter's value. Multiply: a factor. Right-click a parameter to switch it to Multiply and back.",
      ),
    );
    const body = el("tbody");
    const t = el("table", { className: "kv wide edit-table" });
    t.append(
      el(
        "thead",
        {},
        el("tr", {}, ...["", "Parameter", "Value", "Blend"].map((h) => el("th", {}, h))),
      ),
      body,
    );
    box.append(t);
    const rowOf = (id: string) => draft.rows.find((r) => r.id === id);
    const render = () => {
      const q = filter.value.trim().toLowerCase();
      const ids = all.checked
        ? [...draft.rows.map((r) => r.id), ...params.ids.filter((id) => !rowOf(id))]
        : draft.rows.map((r) => r.id);
      body.replaceChildren(
        ...ids
          .filter(
            (id) => !q || id.toLowerCase().includes(q) || names.get(id)?.toLowerCase().includes(q),
          )
          .map((id) => line(id)),
      );
    };
    const line = (id: string): HTMLElement => {
      const r = rowOf(id);
      const i = params.ids.indexOf(id);
      const tr = el("tr");
      tr.dataset.param = id;
      tr.classList.toggle("multiply", r?.blend === "Multiply");
      const on = el("input", { type: "checkbox", checked: !!r });
      const value = el("input", {
        type: "number",
        step: "0.01",
        value: String(r ? r.value : edits.parameterDefault(id)),
      });
      if (i >= 0)
        value.title = `Range ${params.min[i]} to ${params.max[i]}, default ${params.defaults[i]}`;
      const blend = el("select");
      for (const b of ["Add", "Multiply", "Overwrite"]) blend.append(new Option(b, b));
      blend.value = r?.blend ?? "Add";
      const ensure = () => {
        let row = rowOf(id);
        if (!row) {
          row = { id, blend: blend.value as ExpressionBlend, value: Number(value.value) || 0 };
          draft.rows.push(row);
          on.checked = true;
        }
        return row;
      };
      const setBlend = (b: ExpressionBlend) => {
        const row = ensure();
        row.blend = b;
        row.value = switchedValue(id, b, (x) => edits.parameterDefault(x));
        blend.value = b;
        value.value = String(row.value);
        tr.classList.toggle("multiply", b === "Multiply");
        void commit();
      };
      on.addEventListener("change", () => {
        if (on.checked) ensure();
        else draft.rows = draft.rows.filter((x) => x.id !== id);
        void commit();
      });
      value.addEventListener("change", () => {
        const n = Number(value.value);
        if (!Number.isFinite(n)) return;
        ensure().value = n;
        void commit();
      });
      blend.addEventListener("change", () => setBlend(blend.value as ExpressionBlend));
      tr.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        setBlend(rowOf(id)?.blend === "Multiply" ? "Add" : "Multiply");
      });
      const label = names.get(id) ? `${names.get(id)} (${id})` : id;
      tr.append(
        el("td", {}, on),
        el("td", { title: id }, label),
        el("td", {}, value),
        el("td", {}, blend),
      );
      return tr;
    };
    all.addEventListener("change", render);
    filter.addEventListener("input", render);
    render();
    if (!draft.rows.length) all.click();
    return box;
  }

  // ---------------------------------------------------------- pose, user data

  private async poseView(live: LiveModel, node: ResourceNode): Promise<HTMLElement> {
    const edits = this.ctx.edits();
    const raw = (await this.read(node.path!).then(
      (b) => JSON.parse(new TextDecoder().decode(b)) as unknown,
      () => null,
    )) as Record<string, unknown> | null;
    const box = el("div", { className: "pose-view" });
    if (!edits) {
      const pose = live.runtime.bundle.pose;
      if (!pose) return empty("The pose file could not be read; see the model settings' notes.");
      const fade = fileFade(raw?.FadeInTime, DEFAULT_FADES.pose);
      box.append(el("p", {}, `Fade: ${fade}; ${pose.groups.length} group(s).`));
      box.append(
        table(
          ["Group", "Part", "Parent of"],
          pose.groups.flatMap((g, i) => g.map((e) => [i + 1, e.id, e.links.join(", ") || "—"])),
        ),
      );
      return box;
    }
    const draft = await edits.pose();
    const groups = new Set(draft.rows.flatMap((r) => (r.group === null ? [] : [r.group])));
    const status = el(
      "p",
      {},
      `Fade: ${fileFade(raw?.FadeInTime, DEFAULT_FADES.pose)}; ${groups.size} group(s).`,
    );
    box.append(status);
    const exportBtn = el(
      "button",
      { type: "button", className: "btn small" },
      "Export .pose3.json",
    );
    exportBtn.dataset.act = "export-file";
    exportBtn.addEventListener("click", () => this.ctx.exportFile(node.path!));
    box.append(el("div", { className: "row" }, exportBtn));
    box.append(this.poseEditor(draft, edits, live, status));
    return box;
  }

  /**
   * Every part with its group number (one part of a group shows at a time;
   * groups from the lowest number up) and the part it follows (a parent
   * shows and hides it), and the pose's fade.
   */
  private poseEditor(
    draft: PoseDraft,
    edits: EditSession,
    live: LiveModel,
    status: HTMLElement,
  ): HTMLElement {
    const box = el("div", { className: "editor pose-editor" });
    const names = new Map(
      (live.runtime.bundle.displayInfo?.parts ?? []).map((p) => [p.id, p.name]),
    );
    const warnings = el("ul", { className: "warnings" });
    const commit = async () => {
      await edits.setPose(draft);
      const w = poseWarnings(draft);
      warnings.replaceChildren(...w.map((x) => el("li", {}, x)));
      const n = new Set(draft.rows.flatMap((r) => (r.group === null ? [] : [r.group]))).size;
      const f = draft.fade;
      status.textContent = `Fade: ${f === null ? `${DEFAULT_FADES.pose} ms (default)` : ms(Math.max(0, f))}; ${n} group(s).`;
      this.ctx.edited({});
    };
    const fade = el("input", {
      type: "number",
      min: "0",
      step: "50",
      value: draft.fade === null ? "" : String(Math.round(draft.fade * 1000)),
      placeholder: `default: ${DEFAULT_FADES.pose} ms`,
    });
    fade.dataset.field = "fade";
    fade.addEventListener("change", () => {
      const text = fade.value.trim();
      const n = Number(text);
      if (text !== "" && !(n >= 0)) return;
      draft.fade = text === "" ? null : n / 1000;
      void commit();
    });
    const ids = el("datalist", { id: "pose-part-ids" });
    for (const r of draft.rows) ids.append(new Option(r.id, r.id));
    const filter = el("input", { type: "search", placeholder: "Filter parts…" });
    box.append(
      el("div", { className: "slider-group" }, "Edit"),
      el("label", { className: "field" }, "Fade (ms) ", fade),
      el(
        "p",
        { className: "empty" },
        "Group: a number; one part of a group shows at a time. Follows: a part of a group that this part shows and hides with.",
      ),
      warnings,
      ids,
      filter,
    );
    warnings.replaceChildren(...poseWarnings(draft).map((x) => el("li", {}, x)));
    const body = el("tbody");
    const t = el("table", { className: "kv wide edit-table" });
    t.append(
      el("thead", {}, el("tr", {}, ...["Part", "Group", "Follows"].map((h) => el("th", {}, h)))),
      body,
    );
    box.append(t);
    const line = (row: PoseDraft["rows"][number]): HTMLElement => {
      const tr = el("tr");
      tr.dataset.part = row.id;
      const group = el("input", {
        type: "number",
        min: "1",
        step: "1",
        value: row.group === null ? "" : String(row.group),
      });
      group.dataset.field = "group";
      group.addEventListener("change", () => {
        const text = group.value.trim();
        const n = Math.trunc(Number(text));
        if (text !== "" && !(n >= 1)) return;
        row.group = text === "" ? null : n;
        void commit();
      });
      const follows = el("input", { type: "text", value: row.parent ?? "", placeholder: "—" });
      follows.setAttribute("list", ids.id);
      follows.dataset.field = "follows";
      follows.addEventListener("change", () => {
        const text = follows.value.trim();
        if (text !== "" && (text === row.id || !draft.rows.some((r) => r.id === text))) {
          follows.setCustomValidity("Not another part of the model");
          follows.reportValidity();
          return;
        }
        follows.setCustomValidity("");
        row.parent = text === "" ? null : text;
        void commit();
      });
      const label = names.get(row.id) ? `${names.get(row.id)} (${row.id})` : row.id;
      const part = el("td", { title: row.id }, label);
      // Click a part to select it; Ctrl+C (⌘C) copies its ID.
      tr.tabIndex = -1;
      part.addEventListener("click", () => {
        for (const other of body.querySelectorAll("tr.selected"))
          other.classList.remove("selected");
        tr.classList.add("selected");
        tr.focus();
      });
      tr.addEventListener("keydown", (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "c" || e.target !== tr) return;
        e.preventDefault();
        void copyText(row.id).then(
          () => this.ctx.setStatus(`Copied ${row.id}`),
          () => this.ctx.setStatus(`Could not copy ${row.id}`, true),
        );
      });
      tr.append(part, el("td", {}, group), el("td", {}, follows));
      return tr;
    };
    const render = () => {
      const q = filter.value.trim().toLowerCase();
      body.replaceChildren(
        ...draft.rows
          .filter(
            (r) =>
              !q || r.id.toLowerCase().includes(q) || names.get(r.id)?.toLowerCase().includes(q),
          )
          .map(line),
      );
    };
    filter.addEventListener("input", render);
    render();
    return box;
  }

  private userDataView(live: LiveModel): HTMLElement {
    const u = live.runtime.bundle.userData;
    if (!u) return empty("The user data file could not be read; see the model settings' notes.");
    return u.all.length
      ? table(
          ["Target", "ID", "Value"],
          u.all.map((e) => [e.target, e.id, e.value]),
        )
      : empty("No user data.");
  }

  private displayInfoView(live: LiveModel): HTMLElement {
    const d = live.runtime.bundle.displayInfo;
    if (!d) return empty("The display information could not be read.");
    return table(
      [],
      [
        ["Parameter names", d.parameters.length],
        ["Parameter groups", d.parameterGroups.length],
        ["Part names", d.parts.length],
        ["Combined parameters", d.combinedParameters.length],
      ],
    );
  }

  // ---------------------------------------------------------------- motion sync

  private motionSyncView(live: LiveModel): HTMLElement {
    const file = live.runtime.bundle.motionSync;
    if (!file)
      return empty("The motion-sync file could not be read; see the model settings' notes.");
    const box = el("div", { className: "motion-sync-view" });
    box.append(
      table(
        ["Setting", "Analysis", "Parameters", "Blend", "Smoothing", "Rate"],
        file.settings.map((s) => [
          `${s.name || s.id}${s.usable ? "" : " (not supported)"}`,
          s.analysisType,
          s.parameters.map((p) => p.id).join(", "),
          s.blendRatio,
          s.smoothing,
          s.sampleRate,
        ]),
        "wide",
      ),
    );
    // Preview: a WAV file through a setting, with optional repeat.
    const setting = el("select", { title: "The setting to preview" });
    for (const s of file.settings.filter((x) => x.usable))
      setting.append(new Option(s.name || s.id, s.name || s.id));
    const pick = el("input", { type: "file", accept: ".wav,audio/wav" });
    pick.hidden = true;
    const pickLabel = el("label", { className: "btn small" }, "Load WAV…", pick);
    const name = el("span", { className: "mono" }, "no file");
    const repeat = el("input", { type: "checkbox" });
    const play = el("button", { type: "button", className: "btn small" }, "▶ Play");
    play.dataset.act = "motion-sync-play";
    const stop = el("button", { type: "button", className: "btn small" }, "■ Stop");
    let wav: { name: string; bytes: Uint8Array } | null = null;
    pick.addEventListener("change", async () => {
      const f = pick.files?.[0];
      if (!f) return;
      wav = { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
      name.textContent = f.name;
    });
    play.addEventListener("click", () => {
      if (!wav) return this.ctx.setStatus("Load a WAV file first", true);
      void this.previewMotionSync(live, wav, setting.value, () => repeat.checked);
    });
    stop.addEventListener("click", () => {
      this.preview?.stop();
      this.preview = null;
    });
    box.append(
      el("div", { className: "slider-group" }, "Preview"),
      el("div", { className: "row wrap" }, pickLabel, name),
      el(
        "div",
        { className: "row wrap" },
        el("label", { className: "field" }, "Setting ", setting),
        el("label", { className: "check" }, repeat, " repeat"),
        play,
        stop,
      ),
    );
    this.activeLine = el("p", { className: "active-lipsync" }, this.ctx.activeLipSync());
    box.append(this.activeLine);
    box.append(
      el(
        "p",
        { className: "empty" },
        "WAV files are read here; Mochi2D's own analysis drives the mouth, so the shapes are similar to, not the same as, other runtimes'.",
      ),
    );
    return box;
  }

  private async previewMotionSync(
    live: LiveModel,
    wav: { name: string; bytes: Uint8Array },
    setting: string,
    repeat: () => boolean,
  ): Promise<void> {
    this.preview?.stop();
    const ctx = new AudioContext();
    let stopped = false;
    const stop = () => {
      stopped = true;
      live.runtime.stopMotionSync();
      void ctx.close();
    };
    this.preview = { stop };
    try {
      const buffer = await ctx.decodeAudioData(wav.bytes.slice().buffer);
      const start = () => {
        if (stopped) return;
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        const t0 = ctx.currentTime + 0.05;
        const ok = live.runtime.startMotionSync(wav.bytes, {
          setting,
          clock: () => Math.max(0, ctx.currentTime - t0),
        });
        if (!ok) {
          this.ctx.setStatus("This model has no usable motion-sync setting", true);
          return stop();
        }
        src.onended = () => {
          if (!stopped && repeat()) start();
        };
        src.start(t0);
      };
      start();
      this.ctx.setStatus(`Motion sync: ${wav.name} through ${setting}`);
    } catch (e) {
      stop();
      this.ctx.setStatus(`${wav.name}: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  /** Shows the differences between two `.moc3` files (Edit › Compare). */
  showComparison(nameA: string, nameB: string, diffs: readonly MocDifference[]): void {
    this.node = null;
    this.activeLine = null;
    this.title.textContent = `Compare: ${nameA} and ${nameB}`;
    this.body.dataset.kind = "compare";
    const box = el("div", { className: "compare-view" });
    if (!diffs.length) {
      box.append(empty("No differences: the canvas, parts, parameters and art meshes match."));
      this.body.replaceChildren(box);
      return;
    }
    const fmt = (v: string | number | null) => (v === null ? "—" : String(v));
    box.append(
      el("p", {}, `${diffs.length} difference(s), by ID (A: ${nameA}, B: ${nameB}).`),
      table(
        ["What", "ID", "Property", "A", "B"],
        diffs.map((d) => [d.kind, d.id || "—", d.property, fmt(d.a), fmt(d.b)]),
        "wide",
      ),
    );
    this.body.replaceChildren(box);
  }

  /** Stops a running motion-sync preview (another model is shown). */
  stopPreview(): void {
    this.preview?.stop();
    this.preview = null;
  }
}

export { short as shortName };
