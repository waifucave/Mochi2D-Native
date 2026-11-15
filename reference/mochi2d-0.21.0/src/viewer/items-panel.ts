/**
 * The viewer's items: adding further models as items,
 * the Items panel (placement, front or behind, pinning, opacity, effects),
 * dragging items on the canvas, the anchor overlay, and Mochi2D's item
 * layout file.
 */
import { resolveSettingsPath } from "../runtime/bundle.js";
import { currentFormatName } from "../core/format-names.js";
import type { FileSource } from "../core/io/file-source.js";
import type { LiveModel } from "../lib/live-model.js";
import type { ModelRuntime } from "../runtime/model-runtime.js";
import { ItemLayer, type ItemEntry } from "../lib/items/item-layer.js";
import { readItemSettings } from "../lib/items/item-settings.js";
import { applyAffine, canvasRect, type ItemPlacement } from "../lib/items/placement.js";

export interface ItemsUiOptions {
  gl: WebGL2RenderingContext;
  panel: HTMLElement;
  canvas: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  setStatus(text: string, error?: boolean): void;
  /** Loads a model for drawing with the viewer's texture and mask settings. */
  load(source: FileSource, settingsPath: string, reuse?: ModelRuntime): Promise<LiveModel>;
  /** The items changed (added, removed, renamed): e.g. rebuild a "controls for" list. */
  changed(): void;
}

interface ViewerItem {
  entry: ItemEntry;
  source: FileSource;
  settingsPath: string;
  label: string;
  row: HTMLElement | null;
  refresh: (() => void) | null;
}

const LAYOUT_FORMAT = "mochi2d-item-layout/1";

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
};

export class ItemsUi {
  readonly layer: ItemLayer;
  readonly items: ViewerItem[] = [];
  private selected: ViewerItem | null = null;
  private drag: { item: ViewerItem; repin: boolean } | null = null;
  private readonly dragToggle: HTMLInputElement;
  private readonly list: HTMLElement;

  constructor(private readonly opts: ItemsUiOptions) {
    this.layer = new ItemLayer(opts.gl);
    this.dragToggle = el("input", { type: "checkbox", checked: true });
    this.list = el("div", { className: "items-list" });
    const exportBtn = el("button", {
      type: "button",
      className: "btn small",
      textContent: "Export layout",
    });
    exportBtn.addEventListener("click", () => this.exportLayout());
    const importInput = el("input", {
      type: "file",
      accept: ".json,application/json",
      hidden: true,
    });
    importInput.addEventListener("change", () => {
      const f = importInput.files?.[0];
      importInput.value = "";
      if (f) void f.text().then((t) => this.importLayout(t));
    });
    const importBtn = el(
      "label",
      { className: "btn small", textContent: "Import layout…" },
      importInput,
    );
    opts.panel.replaceChildren(
      el(
        "p",
        { className: "empty" },
        "Drag an item, or its anchor cross, to move it; a pinned item is pinned again where it is dropped.",
      ),
      el(
        "div",
        { className: "row wrap" },
        el("label", { className: "check" }, this.dragToggle, " drag items"),
        exportBtn,
        importBtn,
      ),
      this.list,
    );
  }

  /** The main model the items sit on (pins are released when it changes, unless kept). */
  attach(main: LiveModel | null, keepPins = false): void {
    this.layer.attach(main, { keepPins });
    this.render();
  }

  // ------------------------------------------------------------- adding

  async add(source: FileSource, entry?: string): Promise<void> {
    if (!this.layer.model) throw new Error("load a model before adding items");
    const settingsPath = resolveSettingsPath(source, entry);
    const live = await this.opts.load(source, settingsPath);
    live.update(0);
    const settings = await readItemSettings(source, settingsPath);
    const e = this.layer.add(live, settings);
    const item: ViewerItem = {
      entry: e,
      source,
      settingsPath,
      label: settingsPath
        .split("/")
        .pop()!
        .replace(/\.model3\.json$/i, ""),
      row: null,
      refresh: null,
    };
    this.items.push(item);
    this.selected = item;
    this.render();
    this.opts.changed();
    this.opts.setStatus(
      `Item ${item.label}: ${live.runtime.model.meshes.ids.length} drawables` +
        (settings
          ? `, item settings from ${settings.file} (head angles forwarded)`
          : ", no item settings"),
    );
  }

  remove(item: ViewerItem): void {
    const i = this.items.indexOf(item);
    if (i < 0) return;
    this.items.splice(i, 1);
    if (this.selected === item) this.selected = null;
    if (this.drag?.item === item) this.drag = null;
    this.layer.remove(item.entry);
    this.render();
    this.opts.changed();
  }

  /** After a lost GPU context: load each item's textures and renderer again. */
  async restore(): Promise<void> {
    this.layer.resetGpu();
    for (const item of this.items) {
      const old = item.entry.live;
      const fresh = await this.opts.load(item.source, item.settingsPath, old.runtime);
      old.dispose();
      item.entry.live = fresh;
      fresh.runtime.touch();
      fresh.update(0);
    }
    this.layer.touch();
  }

  // ---------------------------------------------------------- the panel

  private render(): void {
    this.list.replaceChildren(...this.items.map((item) => this.row(item)));
  }

  private row(item: ViewerItem): HTMLElement {
    const e = item.entry;
    const layer = this.layer;
    const num = (key: keyof ItemPlacement, step: number, label: string) => {
      const input = el("input", { type: "number", step: String(step), className: "num" });
      input.addEventListener("change", () => {
        const v = Number(input.value);
        if (!Number.isFinite(v)) return;
        if (e.pin && (key === "x" || key === "y" || key === "rotation")) layer.unpin(e);
        (e.placement as unknown as Record<string, number>)[key] = v;
        layer.touch();
        refresh();
      });
      return { input, wrap: el("label", { className: "field" }, label, input) };
    };
    const fields = {
      x: num("x", 0.01, "x"),
      y: num("y", 0.01, "y"),
      scale: num("scale", 0.05, "scale"),
      rotation: num("rotation", 1, "rotation °"),
      anchorX: num("anchorX", 0.01, "anchor x"),
      anchorY: num("anchorY", 0.01, "anchor y"),
    };
    // An art-mesh place (set through the library) shows as a third choice.
    const atMesh = el("option", { value: "mesh", disabled: true });
    const side = el(
      "select",
      {},
      el("option", { value: "front", textContent: "in front" }),
      el("option", { value: "behind", textContent: "behind" }),
      atMesh,
    );
    side.addEventListener("change", () => {
      e.placement.front = side.value === "front";
      e.placement.layer = null;
      layer.touch();
    });
    const opacity = el("input", { type: "range", min: "0", max: "1", step: "0.01" });
    opacity.addEventListener("input", () => {
      e.opacity = Number(opacity.value);
      layer.touch();
    });
    const pinBtn = el("button", { type: "button", className: "btn small" });
    pinBtn.addEventListener("click", () => {
      if (e.pin) layer.unpin(e);
      else if (!layer.pin(e))
        this.opts.setStatus(
          `${item.label}: nothing of the model is under the item's anchor to pin to`,
          true,
        );
      refresh();
    });
    const removeBtn = el("button", {
      type: "button",
      className: "btn small",
      textContent: "Remove",
    });
    removeBtn.addEventListener("click", () => this.remove(item));
    const effects = el("span", { className: "row wrap" });
    for (const name of ["physics", "breath", "eyeBlink"] as const) {
      if (!e.live.effectAvailable(name)) continue;
      const box = el("input", { type: "checkbox", checked: e.live.effect(name) });
      box.addEventListener("change", () => e.live.setEffect(name, box.checked));
      effects.append(el("label", { className: "check" }, box, ` ${name}`));
    }
    const pinInfo = el("p", { className: "empty" });
    const fed = el("p", { className: "empty" });
    const refresh = () => {
      const p = e.effectivePlacement(layer.model);
      for (const [key, f] of Object.entries(fields)) {
        if (document.activeElement === f.input) continue;
        const v = p[key as keyof typeof fields];
        f.input.value = String(Math.round(v * 10000) / 10000);
      }
      const at = p.layer ?? null;
      atMesh.textContent = at ? ("above" in at ? `above ${at.above}` : `below ${at.below}`) : "";
      atMesh.hidden = !at;
      side.value = at ? "mesh" : p.front ? "front" : "behind";
      if (document.activeElement !== opacity) opacity.value = String(e.opacity);
      pinBtn.textContent = e.pin ? "Unpin" : "Pin to model";
      pinInfo.textContent = e.pin
        ? `Pinned to ${e.pin.target.drawableId}, triangle ${e.pin.target.triangle} (weights ${e.pin.target.weights.map((w) => w.toFixed(3)).join(", ")})`
        : "Not pinned.";
      fed.textContent = e.settings
        ? `Head angles fed (×${fmt(e.settings.multiplier)}, +${fmt(e.settings.shift)}, smoothing ${fmt(e.settings.smoothing)}): ` +
          e.forwarded.map((v, k) => `${"XYZ"[k]} ${v === null ? "—" : v.toFixed(1)}`).join(", ")
        : "No ItemSettings: no inputs are forwarded.";
    };
    item.refresh = refresh;
    refresh();
    const head = el(
      "div",
      { className: "row wrap" },
      el("strong", { textContent: item.label, title: item.settingsPath }),
      side,
      pinBtn,
      removeBtn,
    );
    const row = el(
      "div",
      { className: "item-row" + (this.selected === item ? " selected" : "") },
      head,
      el("div", { className: "fields" }, ...Object.values(fields).map((f) => f.wrap)),
      el("label", { className: "field" }, "opacity ", opacity),
      effects,
      pinInfo,
      fed,
    );
    row.addEventListener("pointerdown", () => this.select(item));
    item.row = row;
    return row;
  }

  private select(item: ViewerItem): void {
    if (this.selected === item) return;
    this.selected = item;
    for (const i of this.items) i.row?.classList.toggle("selected", i === item);
  }

  /** Updates the panel's numbers (pinned items move with the model). */
  refresh(): void {
    for (const item of this.items) item.refresh?.();
  }

  // ------------------------------------------------------------ pointer

  /** A press on the canvas (drawing-buffer pixels): starts dragging an item under it. */
  press(px: number, py: number): boolean {
    const main = this.layer.model;
    if (!main || !this.dragToggle.checked || this.items.length === 0) return false;
    const c = this.opts.canvas;
    // An anchor cross within 12 CSS pixels, else the topmost item drawn there.
    const reach = (12 * c.width) / Math.max(1, c.clientWidth);
    let item = this.items.find((i) => {
      if (!i.entry.visible) return false;
      const p = i.entry.effectivePlacement(main);
      const [ax, ay] = main.toImage(p.x, p.y, c.width, c.height);
      return Math.hypot(ax - px, ay - py) <= reach;
    });
    if (!item) {
      const [x, y] = main.toModel(px, py, c.width, c.height);
      const entry = this.layer.itemAt(x, y);
      item = this.items.find((i) => i.entry === entry);
    }
    if (!item) return false;
    const entry = item.entry;
    const repin = entry.pin !== null;
    this.layer.unpin(entry);
    this.drag = { item, repin };
    this.select(item);
    return true;
  }

  dragBy(dx: number, dy: number): void {
    const main = this.layer.model;
    if (!main || !this.drag) return;
    const c = this.opts.canvas;
    const k = main.framing(c.width, c.height).k;
    const p = this.drag.item.entry.placement;
    p.x += dx / k;
    p.y -= dy / k;
    this.layer.touch();
  }

  release(): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.repin && !this.layer.pin(d.item.entry))
      this.opts.setStatus(
        `${d.item.label}: dropped where nothing of the model is; it is no longer pinned`,
        true,
      );
    d.item.refresh?.();
  }

  /** Draws the selected item's outline and every item's anchor onto the overlay. */
  drawOverlay(): void {
    const main = this.layer.model;
    const ctx = this.opts.overlay.getContext("2d");
    if (!main || !ctx || this.items.length === 0) return;
    const c = this.opts.canvas;
    const dpr = c.width / Math.max(1, c.clientWidth);
    for (const item of this.items) {
      const e = item.entry;
      if (!e.visible) continue;
      const m = e.toMain(main);
      const toPx = (ix: number, iy: number) => {
        const [x, y] = applyAffine(m, ix, iy);
        return main.toImage(x, y, c.width, c.height);
      };
      const selected = item === this.selected;
      if (selected) {
        const r = canvasRect(e.live.runtime.model.canvas);
        ctx.beginPath();
        for (const [ix, iy] of [
          [r.left, r.top],
          [r.right, r.top],
          [r.right, r.bottom],
          [r.left, r.bottom],
        ] as const) {
          const [px, py] = toPx(ix, iy);
          ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.setLineDash([6 * dpr, 4 * dpr]);
        ctx.lineWidth = 1 * dpr;
        ctx.strokeStyle = "rgba(40, 120, 230, 0.8)";
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const p = e.effectivePlacement(main);
      const [ax, ay] = main.toImage(p.x, p.y, c.width, c.height);
      const s = 7 * dpr;
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = e.pin ? "rgba(230, 120, 20, 0.95)" : "rgba(40, 120, 230, 0.95)";
      ctx.beginPath();
      ctx.moveTo(ax - s, ay);
      ctx.lineTo(ax + s, ay);
      ctx.moveTo(ax, ay - s);
      ctx.lineTo(ax, ay + s);
      ctx.stroke();
    }
  }

  // ------------------------------------------------------------ layouts

  private exportLayout(): void {
    const main = this.layer.model;
    const layout = {
      format: LAYOUT_FORMAT,
      model: main?.name ?? null,
      items: this.items.map((i) => {
        const e = i.entry;
        const t = e.pin?.target;
        return {
          name: i.settingsPath,
          placement: e.effectivePlacement(main),
          opacity: e.opacity,
          visible: e.visible,
          pin: t ? { drawable: t.drawableId, triangle: t.triangle, weights: [...t.weights] } : null,
        };
      }),
    };
    const blob = new Blob([JSON.stringify(layout, null, 2) + "\n"], { type: "application/json" });
    const a = el("a", { href: URL.createObjectURL(blob), download: "item-layout.json" });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    this.opts.setStatus(`Exported the layout of ${this.items.length} item(s)`);
  }

  private importLayout(text: string): void {
    try {
      const layout = JSON.parse(text) as {
        format?: string;
        items?: {
          name: string;
          placement: ItemPlacement;
          opacity?: number;
          visible?: boolean;
          pin: { drawable: string; triangle: number; weights: number[] } | null;
        }[];
      };
      if (currentFormatName(layout.format) !== LAYOUT_FORMAT || !Array.isArray(layout.items))
        throw new Error(`not a ${LAYOUT_FORMAT} file`);
      const free = [...this.items];
      let placed = 0;
      let pinned = 0;
      for (const saved of layout.items) {
        const i = free.findIndex((item) => item.settingsPath === saved.name);
        if (i < 0) continue;
        const item = free.splice(i, 1)[0]!;
        const e = item.entry;
        this.layer.unpin(e);
        Object.assign(e.placement, saved.placement);
        e.opacity = saved.opacity ?? 1;
        e.visible = saved.visible ?? true;
        if (
          saved.pin &&
          this.layer.pinTo(e, saved.pin.drawable, saved.pin.triangle, saved.pin.weights)
        )
          pinned++;
        placed++;
      }
      this.layer.touch();
      this.refresh();
      this.opts.setStatus(
        `Layout applied to ${placed} of ${layout.items.length} item(s)${pinned ? `, ${pinned} pinned` : ""}` +
          (placed < layout.items.length
            ? " (add the missing items first: they are matched by settings path)"
            : ""),
      );
    } catch (e) {
      this.opts.setStatus(
        `Importing the layout failed: ${e instanceof Error ? e.message : String(e)}`,
        true,
      );
    }
  }
}

const fmt = (t: { x: number; y: number; z: number }) => `${t.x}/${t.y}/${t.z}`;
