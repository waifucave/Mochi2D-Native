/**
 * The viewer: a menu bar (File, Edit, Display, Animation) and four areas. The
 * menu area shows one panel at a time, chosen from its drop-down
 * (parameters, parts, items, lip sync). The resource tree lists what is
 * loaded, the settings area shows the selected item, and the model view
 * shows the model with its frame rate and events.
 */
import { MemoryFileSource, OverlayFileSource, type FileSource } from "../core/io/file-source.js";
import { classifyModelFile } from "../core/io/model-files.js";
import {
  HttpFileSource,
  sourceFromDataTransfer,
  sourceFromFileList,
  sourceFromUrl,
  sourceFromZip,
} from "../platform/browser-sources.js";
import { formatBytes } from "../render/gl/gpu-memory.js";
import { Stage, cssColorToHex, parseHexColor } from "../lib/stage.js";
import type { StageModel } from "../lib/stage-model.js";
import { formatFrameStats } from "../lib/frame-stats.js";
import { DEFAULT_MASK_SETTING, LiveModel, type MaskSetting } from "../lib/live-model.js";
import { loadLiveModel } from "../lib/load.js";
import { bindGestures } from "../lib/gestures.js";
import {
  TEXTURE_BUDGET_CHOICES,
  defaultMaxPixelRatio,
  deviceProfile,
  parseTextureBudget,
  resolveTextureBudget,
  type TextureBudgetSetting,
} from "../lib/texture-budget.js";
import { loadMoc } from "../core/moc/model.js";
import { compareMocModels } from "../core/moc/compare.js";
import { parameterGroupIds } from "../core/settings/model-settings.js";
import { MockModel } from "./mock-model.js";
import { SliderList } from "./controls/slider-list.js";
import { AudioPanel } from "./audio-panel.js";
import { describeRenderStats, formatRenderStats } from "./controls/render-stats.js";
import { AnimationUi } from "./animation-panel.js";
import { initLayout } from "./layout.js";
import { initMenus } from "./menus.js";
import { ItemsUi } from "./items-panel.js";
import { ResourceTree, buildResources, type ResourceNode } from "./resources.js";
import { SettingsArea } from "./settings-views.js";
import { EditSession } from "./editing.js";
import type { ItemEntry } from "../lib/items/item-layer.js";
import type { ModelRuntime } from "../runtime/model-runtime.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>("canvas");
const stageEl = $<HTMLElement>("stage");
const statusEl = $<HTMLElement>("status");
const sampleOffer = $<HTMLElement>("sample-offer");
const noticeEl = $<HTMLElement>("stage-notice");
const maskSizeEl = $<HTMLSelectElement>("mask-size");
maskSizeEl.value = DEFAULT_MASK_SETTING;
const device = deviceProfile();
const menus = initMenus(document.querySelector(".menubar")!);
const layout = initLayout(device, menus);

function setStatus(text: string, error = false): void {
  statusEl.textContent = text;
  statusEl.title = text;
  statusEl.classList.toggle("error", error);
}

// ---- settings kept between visits (a convenience; failures are ignored) ---------

const store = {
  get(key: string): string | null {
    try {
      // Settings saved before the rename used the "lively2d." prefix.
      return localStorage.getItem(`mochi2d.${key}`) ?? localStorage.getItem(`lively2d.${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(`mochi2d.${key}`, value);
    } catch {
      // storage unavailable (private mode, blocked)
    }
  },
};

// Texture budget: "auto" picks a smaller budget on phones and tablets.
const budgetEl = $<HTMLSelectElement>("texture-budget");
let textureBudget: TextureBudgetSetting = parseTextureBudget(store.get("textureBudget"));
{
  const auto = resolveTextureBudget("auto", device);
  const opts: [string, string][] = [
    ["auto", `auto (${auto.label.replace(/ \(auto: .*\)$/, "")}, ${device.reason})`],
    ...TEXTURE_BUDGET_CHOICES.map((m): [string, string] => [String(m), `${m} MiB`]),
    ["full", "full size"],
  ];
  budgetEl.replaceChildren(...opts.map(([value, label]) => new Option(label, value)));
  budgetEl.value = String(textureBudget);
  if (budgetEl.value !== String(textureBudget)) {
    textureBudget = "auto";
    budgetEl.value = "auto";
  }
}

// ---- the menu area: one panel at a time ------------------------------------------

const panelSelect = $<HTMLSelectElement>("menu-panel");
function showPanel(name: string): void {
  panelSelect.value = name;
  for (const p of document.querySelectorAll<HTMLElement>("#menu-area [data-panel]"))
    p.hidden = p.dataset.panel !== name;
  store.set("panel", name);
}
panelSelect.addEventListener("change", () => showPanel(panelSelect.value));
showPanel(
  [...panelSelect.options].some((o) => o.value === store.get("panel"))
    ? store.get("panel")!
    : "parameters",
);

// ---- stage, model and controls ------------------------------------------------

let stage: Stage | null = null;
let model: StageModel | null = null;
let parameterList: SliderList | null = null;
let partList: SliderList | null = null;
const showHitAreas = $<HTMLInputElement>("show-hit-areas");
const audio = new AudioPanel(setStatus, store);
$<HTMLElement>("panel-audio").replaceChildren(audio.element);
const animUi = new AnimationUi({
  setStatus,
  model: () => model,
  playSound: (label, bytes) => void audio.playBytes(label, bytes),
  parameterList: () => parameterList,
  menu: $<HTMLElement>("panel-animation"),
  status: $<HTMLElement>("anim-status"),
  showHitAreas: () => showHitAreas.checked,
  overlay: $<HTMLCanvasElement>("overlay"),
  canvas,
});
// Lip sync (3s) analyses the WAV file the audio panel plays, from the same frame on.
audio.onPlay = (label, bytes) => {
  if (!(model instanceof LiveModel) || !model.animator.lipSync) return;
  if (!model.startLipSync(bytes))
    setStatus(`${label}: no lip sync (only linear-PCM WAV files are analysed, 3s.1)`);
};
audio.onStop = () => {
  if (model instanceof LiveModel) model.startLipSync(null);
};
// While the microphone runs, its loudness drives the main model's lip sync
// (not reference behavior), alongside a sound the model plays.
audio.onLiveLipSync = (lip) => {
  if (model instanceof LiveModel) model.runtime.setLiveLipSync(lip);
};
audio.lipSyncNote = () => {
  if (!(model instanceof LiveModel)) return null;
  const lip = model.runtime.animator.lipSync;
  if (!lip) return "this model has no lip-sync parameter";
  if (!model.effect("lipSync")) return "lip sync is off (Animation menu)";
  return `drives ${lipSyncGroup(model).join(", ")}`;
};
audio.activeNote = () => activeLipSync();

/** The parameters volume lip sync drives: the LipSync group, or the viewer's fallback. */
function lipSyncGroup(m: LiveModel): string[] {
  const ids = parameterGroupIds(m.runtime.animator.settings, "LipSync");
  return ids.length ? ids : m.lipSyncFallback ? [m.lipSyncFallback] : [];
}

/** Which lip sync moves the mouth now. */
function activeLipSync(): string {
  if (!(model instanceof LiveModel)) return "Active: none (no model).";
  const rt = model.runtime;
  const tick = rt.motionSync;
  if (tick && rt.effect("motionSync"))
    return `Active: motion sync, setting "${tick.setting.name || tick.setting.id}" (${tick.source === "live" ? "live audio" : "a sound"}).`;
  const lip = rt.animator.lipSync;
  if (lip && rt.effect("lipSync") && (lip.playing || lip.liveSource))
    return `Active: volume lip sync of ${lipSyncGroup(model).join(", ")} (${lip.liveSource ? "microphone" : "a sound"}).`;
  return "Active: none.";
}

try {
  stage = new Stage(canvas, { maxPixelRatio: defaultMaxPixelRatio(device) });
  model = new MockModel(stage.gl, stage.memory);
  stage.model = model;
  stage.background = parseHexColor(cssColorToHex(getComputedStyle(stageEl).backgroundColor));
  $<HTMLInputElement>("bg-color").value = cssColorToHex(getComputedStyle(stageEl).backgroundColor);
  stage.start();
} catch (e) {
  setStatus(String(e), true);
}

/** Loads a model for drawing with the viewer's texture budget and mask setting. */
function loadForStage(source: FileSource, settingsPath: string, reuse?: ModelRuntime) {
  if (!stage) throw new Error("WebGL2 is not available");
  return loadLiveModel(stage.gl, source, settingsPath, {
    textureBudget: resolveTextureBudget(textureBudget, device).bytes,
    ...(device.constrained ? { decodeWorkers: 1 } : {}),
    masks: maskSizeEl.value as MaskSetting,
    memory: stage.memory,
    ...(reuse ? { reuse } : {}),
  });
}

// Items: further models placed over the main model.
const itemsUi = stage
  ? new ItemsUi({
      gl: stage.gl,
      panel: $<HTMLElement>("panel-items"),
      canvas,
      overlay: $<HTMLCanvasElement>("overlay"),
      setStatus,
      load: loadForStage,
      changed: () => {
        updateControlsTargets();
        // Items added while Display › Mipmapping is off sample as the model does.
        if (!mipmaps.checked) for (const it of itemsUi?.items ?? []) applyMipmaps(it.entry.live);
      },
    })
  : null;
/** The pins survive the next main-model load (after a lost GPU context). */
let keepPinsOnNextLoad = false;

// Whose parameters and parts the panels show: the main model or an item.
const controlsTarget = document.createElement("select");
controlsTarget.title = "Show the parameters and parts of the main model or of an item";
/** The item whose controls are shown, or null for the main model. */
let controlsItem: ItemEntry | null = null;
controlsTarget.addEventListener("change", () => {
  const i = Number(controlsTarget.value);
  controlsItem = i < 0 ? null : (itemsUi?.items[i]?.entry ?? null);
  const target = controlsItem ? controlsItem.live : model;
  if (target) buildModelControls(target);
});
function updateControlsTargets(): void {
  const items = itemsUi?.items ?? [];
  controlsTarget.replaceChildren(
    new Option("Main model", "-1"),
    ...items.map((it, i) => new Option(`Item: ${it.label}`, String(i))),
  );
  const index = controlsItem ? items.findIndex((it) => it.entry === controlsItem) : -1;
  if (index < 0) controlsItem = null;
  controlsTarget.value = String(index);
  // Showing the main model: rebuild, so the list appears or goes with the items.
  if (!controlsItem && model) buildModelControls(model);
}

function buildModelControls(m: StageModel): void {
  parameterList = new SliderList({
    items: m.parameters,
    get: (id) => m.getParameter(id),
    set: (id, v) => m.setParameter(id, v),
    searchPlaceholder: "Search parameters…",
  });
  partList = new SliderList({
    items: m.parts.map((p) => ({
      id: p.id,
      label: p.label,
      min: 0,
      max: 1,
      default: p.defaultOpacity,
    })),
    get: (id) => m.getPartOpacity(id),
    set: (id, v) => m.setPartOpacity(id, v),
    searchPlaceholder: "Search parts…",
  });
  const note = (text: string) => {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = text;
    return p;
  };
  const targets = itemsUi?.items.length ? [controlsTarget] : [];
  $<HTMLElement>("panel-parameters").replaceChildren(
    ...targets,
    note(
      m instanceof LiveModel
        ? `${m.parameters.length} parameters`
        : `${m.name}: placeholder data (no model loaded).`,
    ),
    parameterList.element,
  );
  $<HTMLElement>("panel-parts").replaceChildren(partList.element);
}
if (model) buildModelControls(model);

// Playback controls.
const playBtn = $<HTMLButtonElement>("play-toggle");
const timeEl = $<HTMLElement>("clock-time");
function syncPlayButton(): void {
  const playing = stage?.clock.playing ?? false;
  playBtn.textContent = playing ? "❚❚" : "▶";
  playBtn.title = playing ? "Pause (Space)" : "Play (Space)";
}
playBtn.addEventListener("click", () => {
  stage?.clock.toggle();
  syncPlayButton();
});
$<HTMLButtonElement>("step").addEventListener("click", () => {
  stage?.clock.step();
  syncPlayButton();
});
$<HTMLSelectElement>("speed").addEventListener("change", (ev) => {
  if (stage) stage.clock.speed = Number((ev.target as HTMLSelectElement).value);
});
window.addEventListener("keydown", (e) => {
  // Ctrl+S (⌘S): export the model settings.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
    e.preventDefault();
    exportSettings();
    return;
  }
  const t = e.target as HTMLElement;
  if (t.closest("input, select, textarea, button")) return;
  if (e.key === " ") {
    e.preventDefault();
    stage?.clock.toggle();
    syncPlayButton();
  } else if (e.key === ".") {
    stage?.clock.step();
    syncPlayButton();
  }
});
syncPlayButton();

// ---- the Display menu ----------------------------------------------------------

$<HTMLInputElement>("bg-color").addEventListener("input", (ev) => {
  if (stage) stage.background = parseHexColor((ev.target as HTMLInputElement).value);
});
$<HTMLInputElement>("bg-transparent").addEventListener("change", (ev) => {
  const on = (ev.target as HTMLInputElement).checked;
  if (stage) stage.transparent = on;
  stageEl.classList.toggle("checker", on);
});
$<HTMLButtonElement>("screenshot").addEventListener("click", () => {
  if (!stage) return;
  void stage.screenshot().then((png) => {
    download(
      new Blob([png as BlobPart], { type: "image/png" }),
      `mochi2d-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
    );
    setStatus(`Screenshot saved (${canvas.width}×${canvas.height})`);
  });
});
const fpsEl = $<HTMLElement>("fps-display");
const eventsEl = $<HTMLElement>("event-display");
const showFps = $<HTMLInputElement>("show-fps");
const showEvents = $<HTMLInputElement>("show-events");
const syncIndicators = () => {
  fpsEl.hidden = !showFps.checked;
  eventsEl.hidden = !showEvents.checked;
};
showFps.addEventListener("change", syncIndicators);
showEvents.addEventListener("change", syncIndicators);
syncIndicators();
// Mipmapping: trilinear minification through the mip levels, or bilinear from level 0.
const mipmaps = $<HTMLInputElement>("show-mipmaps");
function applyMipmaps(m: LiveModel): void {
  if (!stage) return;
  const gl = stage.gl;
  for (const t of m.textures) {
    gl.bindTexture(gl.TEXTURE_2D, t.texture.texture);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      mipmaps.checked ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR,
    );
  }
  gl.bindTexture(gl.TEXTURE_2D, null);
  m.runtime.touch();
}
mipmaps.addEventListener("change", () => {
  if (model instanceof LiveModel) applyMipmaps(model);
  for (const it of itemsUi?.items ?? []) applyMipmaps(it.entry.live);
});

/** Events shown on the view as motions fire them (the newest at the bottom). */
function showEvent(value: string): void {
  const li = document.createElement("li");
  li.textContent = value;
  eventsEl.append(li);
  while (eventsEl.childElementCount > 5) eventsEl.firstElementChild!.remove();
  setTimeout(() => li.remove(), 4000);
}

// Per-frame UI updates (throttled where it touches the DOM a lot).
const statsEl = $<HTMLElement>("frame-stats");
let uiAccum = 0;
stage?.onFrame(({ realDt, time }) => {
  audio.update(realDt);
  animUi.drawOverlay();
  itemsUi?.drawOverlay();
  uiAccum += realDt;
  if (uiAccum >= 0.25) {
    uiAccum = 0;
    animUi.refresh();
    itemsUi?.refresh();
    settingsArea.refresh();
    const snap = stage!.stats.snapshot();
    const s = formatFrameStats(snap);
    fpsEl.textContent = `${snap.fps.toFixed(1)} fps`;
    let live = "";
    let details = "";
    if (model instanceof LiveModel) {
      const input = {
        stats: model.renderer.stats,
        animationMs: model.lastAnimationMs,
        evaluationMs: model.lastEvaluationMs,
        updateMs: model.lastUpdateMs,
        idle: stage!.idle,
      };
      live = ` · ${formatRenderStats(input)}`;
      details = describeRenderStats(input);
    }
    statsEl.title = details;
    statsEl.textContent = `${s}${live} · GPU ${formatBytes(stage!.memory.total)}`;
    timeEl.textContent = `${time.toFixed(2)} s`;
    parameterList?.refresh();
    partList?.refresh();
  }
});

// ---- model sources -------------------------------------------------------------

interface LoadedFolder {
  source: FileSource;
  /** Files known in the folder (if enumerable), plus extra files added later. */
  files: string[];
  settings: string[];
  activeSettings?: string;
}

let current: LoadedFolder | null = null;
const extraFiles = new MemoryFileSource("added files");
/** Where files added with File › Add files… (or dropped loose) are listed. */
const ADDED = "+added/";

// ---- the resource tree and the settings area --------------------------------------

const tree = new ResourceTree({
  root: $<HTMLElement>("resource-tree"),
  onSelect: (node, byUser) => {
    void settingsArea.show(node);
    // On a phone, picking a file shows its settings in the sheet.
    if (byUser && layout.narrow && !node.children) layout.showSheet("settings");
  },
  onActivate: (node) => {
    if (node.kind === "motion") void playNode(node);
    else if (node.kind === "expression" && node.path) void animUi.playExpression(node.path);
  },
  onContext: (node) => {
    if (node.kind === "motion") void settingsArea.show(node, "curves");
  },
});

function liveModel(): LiveModel | null {
  return model instanceof LiveModel ? model : null;
}

/** Plays a motion of the tree: its settings entry's fades and sound, the viewer's loop. */
function playNode(node: ResourceNode, loop: boolean = settingsArea.loopsFor(node)): Promise<void> {
  const e = node.entry;
  const dir = current?.activeSettings ? current.activeSettings.replace(/[^/]*$/, "") : "";
  return animUi.playMotion(node.path!, {
    loop,
    ...(e?.fadeInTime !== undefined && e.fadeInTime >= 0 ? { fadeIn: e.fadeInTime } : {}),
    ...(e?.fadeOutTime !== undefined && e.fadeOutTime >= 0 ? { fadeOut: e.fadeOutTime } : {}),
    ...(e?.sound ? { sound: `${dir}${e.sound}` } : {}),
  });
}

/** Flashes an art mesh of the main model in the view (its tint blinks for a moment). */
const flashing = new Map<
  string,
  { timer: number; before: [number, number, number, number] | null }
>();
function flash(meshId: string): void {
  const live = liveModel();
  if (!live) return;
  const rt = live.runtime;
  // A flash still running keeps the tint it found, not its own red.
  const old = flashing.get(meshId);
  if (old) clearInterval(old.timer);
  const before = old ? old.before : rt.getTint(meshId);
  const restore = () => (before ? rt.setTint(meshId, before) : rt.clearTint(meshId));
  let n = 0;
  const timer = window.setInterval(() => {
    n++;
    if (n > 8) {
      clearInterval(timer);
      flashing.delete(meshId);
      restore();
      return;
    }
    if (n % 2) rt.setTint(meshId, [1, 0.25, 0.25, 1]);
    else restore();
  }, 160);
  flashing.set(meshId, { timer, before });
  setStatus(`Flashing ${meshId}`);
}

const settingsArea: SettingsArea = new SettingsArea(
  $<HTMLElement>("settings-title"),
  $<HTMLElement>("settings-body"),
  {
    source: () => edits?.source ?? current?.source ?? null,
    settings: () => edits?.settings ?? liveModel()?.loaded.settings ?? null,
    settingsFiles: () => current?.settings ?? [],
    settingsPath: () => current?.activeSettings ?? null,
    switchSettings: (path) => {
      if (current) void guarded("Switching model", () => openSource(current!.source, path));
    },
    live: liveModel,
    setStatus,
    playMotion: (node, o) => playNode(node, o.loop),
    playExpression: async (node) => {
      if (node.path) await animUi.playExpression(node.path);
    },
    flash,
    exportSettings: () => exportSettings(),
    notes: () => animUi.notes(),
    activeLipSync,
    edits: () => edits,
    edited: (o) => afterEdit(o),
    preview: (exp) => liveModel()?.playExpression({ ...exp, fadeIn: 0 }),
    soundFiles: () => byKind("sound"),
    motionSyncNames: () =>
      liveModel()?.runtime.bundle.motionSync?.settings.map((s) => s.name || s.id) ?? [],
    exportFile: (path) => void exportFile(path),
  },
);

// ---- editing ----------------------------------------------------------------------

/** The open model's edits (kept when the same model loads again). */
let edits: EditSession | null = null;

/** After an edit: the unsaved marks, and with `tree` the tree from the edited settings. */
function afterEdit(o: { tree?: boolean; select?: (n: ResourceNode) => boolean }): void {
  if (o.tree) renderResources(o.select);
  refreshMarks();
}

/** Marks what changed since the last export, and names what the export gives. */
function refreshMarks(): void {
  const e = edits;
  for (const n of tree.all()) {
    if (!e || !n.path) continue;
    const on = e.unsaved.has(n.path) || (n.kind === "motion" && e.editedMotions.has(n.path));
    if (on || tree.isUnsaved(n.key)) tree.markUnsaved(n.key, on);
  }
  const plan = e?.exportPlan();
  exportLabel.textContent = !plan
    ? "Export model settings (.model3.json)"
    : plan.zip
      ? `Export changes (${plan.name})`
      : `Export ${plan.name}`;
  newPose.disabled = !e || e.posePath !== null;
  newExpression.disabled = !e;
}

/** Shows the folder's resources (and the loaded settings' groups, once loaded). */
function renderResources(select?: (n: ResourceNode) => boolean): void {
  if (!current) {
    tree.set([]);
    settingsArea.clear();
    return;
  }
  const live = liveModel();
  const loaded =
    live && current.activeSettings ? (edits?.settings ?? live.loaded.settings) : undefined;
  tree.set(
    buildResources({
      label: current.source.label,
      files: current.files,
      ...(current.activeSettings ? { settingsPath: current.activeSettings } : {}),
      ...(loaded ? { settings: loaded } : {}),
    }),
  );
  animUi.setSource(edits?.source ?? current.source);
  const source = current.source;
  audio.setFolderSounds(byKind("sound"), (p) => source.read(p));
  const wanted = select ? tree.find(select) : undefined;
  if (wanted) tree.select(wanted);
  else if (!tree.selection) {
    const top = tree.all()[0];
    if (top) tree.select(top);
  } else void settingsArea.show(tree.selection);
  refreshMarks();
}

function byKind(kind: string): string[] {
  return (current?.files ?? []).filter((p) => classifyModelFile(p) === kind);
}

// ---- export (Ctrl+S) -----------------------------------------------------------

function download(blob: Blob, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

const exportBtn = $<HTMLButtonElement>("export-settings");
const exportLabel = exportBtn.querySelector<HTMLElement>(".label")!;
exportBtn.addEventListener("click", () => exportSettings());
/** The last export (for tests and the console): its name, its files, and its text when JSON. */
let lastExport: { name: string; text: string; files: string[]; data: Uint8Array } | null = null;

function downloadExport(out: { name: string; data: Uint8Array; type: string; files: string[] }) {
  const json = out.type === "application/json";
  lastExport = {
    name: out.name,
    text: json ? new TextDecoder().decode(out.data) : "",
    files: out.files,
    data: out.data,
  };
  download(new Blob([out.data as BlobPart], { type: out.type }), out.name);
}

/**
 * Ctrl+S: the model settings, or the one changed file; with several changed
 * files, a .zip of the settings and every changed file.
 */
function exportSettings(): void {
  if (!edits || !liveModel() || !current?.activeSettings) {
    setStatus("Open a model first: the model settings are exported from it", true);
    return;
  }
  const out = edits.export();
  downloadExport(out);
  edits.saved();
  for (const n of tree.all()) tree.markUnsaved(n.key, false);
  refreshMarks();
  setStatus(
    `Exported ${out.name}${out.files.length > 1 ? ` (${out.files.join(", ")})` : ""}` +
      (out.added ? ` (${out.added} expression file(s) added to the settings)` : ""),
  );
}

/** One edited file on its own (an expression's or the pose's Export button). */
async function exportFile(path: string): Promise<void> {
  if (!edits) return;
  downloadExport(await edits.exportFile(path));
  refreshMarks();
  setStatus(`Exported ${path.slice(path.lastIndexOf("/") + 1)}`);
}

const newExpression = $<HTMLButtonElement>("new-expression");
newExpression.addEventListener("click", () => {
  const branch = tree.find((n) => n.kind === "expressions");
  if (!branch) return;
  tree.select(branch, true);
  // The expressions' settings have the name field.
  void settingsArea
    .show(branch)
    .then(() =>
      document
        .querySelector<HTMLInputElement>("#settings-body [data-field=new-expression-name]")
        ?.focus(),
    );
});

const newPose = $<HTMLButtonElement>("new-pose");
newPose.addEventListener("click", () => {
  if (!edits || edits.posePath) return;
  edits.createPose();
  afterEdit({ tree: true, select: (n) => n.kind === "pose" });
  setStatus("New pose: give parts group numbers in its settings");
});

window.addEventListener("beforeunload", (e) => {
  if (!tree.anyUnsaved && !edits?.dirty) return;
  e.preventDefault();
  e.returnValue = "";
});

// ---- recent files ---------------------------------------------------------------

interface RecentEntry {
  /** "url": a URL to load; "listed": a path in models/index.json. */
  kind: "url" | "listed";
  ref: string;
}
const recentEl = $<HTMLElement>("recent-list");
function recent(): RecentEntry[] {
  try {
    const v = JSON.parse(store.get("recent") ?? "[]") as RecentEntry[];
    return Array.isArray(v) ? v.filter((e) => e && typeof e.ref === "string") : [];
  } catch {
    return [];
  }
}
function remember(entry: RecentEntry): void {
  const list = [entry, ...recent().filter((e) => e.kind !== entry.kind || e.ref !== entry.ref)];
  store.set("recent", JSON.stringify(list.slice(0, 8)));
  renderRecent();
}
function renderRecent(): void {
  const list = recent();
  recentEl.replaceChildren(
    ...list.map((e) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "menu-item";
      b.textContent = e.ref;
      b.title = e.kind === "url" ? `Load ${e.ref}` : `Open ${e.ref} from the Models list`;
      b.addEventListener(
        "click",
        () => void (e.kind === "url" ? openUrl(e.ref) : openListedModel(e.ref)),
      );
      return b;
    }),
  );
  if (!list.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Models opened by URL or from the Models list appear here.";
    recentEl.append(p);
  }
}
renderRecent();

/**
 * Whether opening another model may go ahead: with edits not exported, the
 * user is asked first (as when closing the page).
 */
function mayDiscardEdits(): boolean {
  if (!edits?.dirty) return true;
  return window.confirm(
    "The open model has changes that are not exported. Open another model and lose them?",
  );
}

async function openSource(base: FileSource, entry?: string): Promise<void> {
  if (!mayDiscardEdits()) {
    setStatus("Kept the open model and its changes");
    return;
  }
  // Loose files added with "Add files…" stay available across model switches.
  const source =
    base instanceof OverlayFileSource
      ? base
      : new OverlayFileSource(base.label, [base, extraFiles]);
  const files = [...(source.list() ?? (entry ? [entry] : []))];
  const settings = files.filter((p) => classifyModelFile(p) === "settings");
  const active = entry ?? settings[0];
  sampleOffer.hidden = true;
  current = {
    source,
    files,
    settings,
    ...(active !== undefined ? { activeSettings: active } : {}),
  };
  settingsArea.stopPreview();
  renderResources();
  if (!active) {
    setStatus(`Opened ${source.label}: no *.model3.json found`, true);
    return;
  }
  await showModel(source, active);
}

/** Loads the settings file, its .moc3 and textures, and shows the evaluated model. */
async function showModel(source: FileSource, settingsPath: string): Promise<void> {
  if (!stage) throw new Error("WebGL2 is not available");
  setStatus(`Loading ${settingsPath}…`);
  const t0 = performance.now();
  const budget = resolveTextureBudget(textureBudget, device);
  // Premultiplied on the GPU with a full mip chain, as in reference renders,
  // but downscaled (visibly) to the texture budget.
  const live = await loadForStage(source, settingsPath);
  try {
    live.update(0);
  } catch (e) {
    live.dispose();
    throw e;
  }
  model?.dispose();
  model = live;
  stage.model = live;
  if (!mipmaps.checked) applyMipmaps(live);
  live.onFrame = (frame) => {
    for (const e of frame.events) showEvent(e);
  };
  if (audio.liveLipSync) live.runtime.setLiveLipSync(audio.liveLipSync);
  itemsUi?.attach(live, keepPinsOnNextLoad);
  keepPinsOnNextLoad = false;
  controlsItem = null;
  controlsTarget.value = "-1";
  buildModelControls(live);
  if (edits?.isFor(source, settingsPath)) edits.attach(live);
  else
    edits = new EditSession(
      settingsPath,
      live.loaded.settings.raw,
      source,
      // Added files aren't next to the settings, so the export can't refer to them.
      () => (current?.files ?? []).filter((p) => !p.startsWith(ADDED)),
      live,
    );
  animUi.attach(live);
  exportBtn.disabled = false;
  renderResources();
  // Files with draw-order keys outside their group's range load, as in the
  // official runtime; the notice names the objects (C12 decision).
  const loadWarnings = live.loaded.model.loadWarnings;
  const drawOrders = loadWarnings.length
    ? `Draw orders outside their group's range (drawn by the evaluated value): ${loadWarnings
        .slice(0, 3)
        .map((w) => w.replace(/; drawn by the evaluated value$/, ""))
        .join("; ")}${loadWarnings.length > 3 ? `; and ${loadWarnings.length - 3} more` : ""}.`
    : null;
  const notices = [live.textureNotice, drawOrders].filter((n): n is string => n !== null);
  noticeEl.textContent = notices.join(" ");
  noticeEl.hidden = notices.length === 0;
  const m = live.loaded.model;
  const textures = live.textures;
  const scaled = textures.filter((t) => t.scale < 1).length;
  const warnings = live.warnings.length;
  setStatus(
    `${settingsPath}: moc3 v${m.version}, ${m.meshes.ids.length} drawables, ${m.parameters.ids.length} parameters, ` +
      `${textures.length} textures${scaled ? ` (${scaled} downscaled to ${budget.label})` : ""} — loaded in ${Math.round(performance.now() - t0)} ms, ` +
      `evaluation ${live.lastEvaluationMs.toFixed(1)} ms, ${live.renderer.layered ? "layered" : "direct"} pipeline` +
      (warnings ? ` — ${warnings} file problem(s), see the model settings` : ""),
    warnings > 0,
  );
  layout.modelLoaded();
}

// After a lost GPU context (phones free GPU memory of background tabs), load again.
if (stage) {
  stage.onContextLost = () =>
    setStatus("The GPU context was lost; waiting for it to return…", true);
  stage.onContextRestored = () => {
    if (!stage) return;
    model?.dispose();
    model = new MockModel(stage.gl, stage.memory);
    stage.model = model;
    const c = current;
    if (c?.activeSettings)
      void guarded("Reloading after the GPU context was restored", async () => {
        await itemsUi?.restore();
        keepPinsOnNextLoad = true;
        await showModel(c.source, c.activeSettings!);
      });
  };
}

// View: dragging looks (with cursor tracking on); Ctrl-, shift-, middle- or
// right-drag moves the model, as does any drag with cursor tracking off; two
// fingers pinch-zoom and move; the wheel (plain or with Alt) zooms about the
// cursor; a tap hit-tests; a double tap resets the view.
bindGestures(canvas, {
  press: (x, y, info) => {
    if (!(model instanceof LiveModel)) return "none";
    const moves = info.shift || info.ctrl === true;
    if (info.button === 0 && !moves && itemsUi?.press(x, y)) return "item";
    if (info.button === 0 && !moves && model.effect("look")) {
      model.lookAtPixel(x, y, canvas.width, canvas.height);
      return "look";
    }
    return "pan";
  },
  drag: (x, y, dx, dy, mode) => {
    if (!(model instanceof LiveModel)) return;
    if (mode === "item") itemsUi?.dragBy(dx, dy);
    else if (mode === "look") model.lookAtPixel(x, y, canvas.width, canvas.height);
    else model.panBy(dx, dy, canvas.width, canvas.height);
  },
  release: (mode) => {
    if (mode === "look" && model instanceof LiveModel) model.releaseLook();
    if (mode === "item") itemsUi?.release();
  },
  tap: (x, y) => {
    if (!(model instanceof LiveModel)) return;
    const h = model.hitsAt(x, y, canvas.width, canvas.height);
    setStatus(
      h.hitAreas.length
        ? `Hit areas: ${h.hitAreas.join(", ")}`
        : model.loaded.settings.hitAreas.length
          ? `No hit area here${h.topDrawable ? ` (topmost drawable: ${h.topDrawable})` : ""}`
          : h.topDrawable
            ? `Topmost drawable here: ${h.topDrawable} (the settings define no hit areas)`
            : "Nothing here",
    );
  },
  doubleTap: () => {
    if (model instanceof LiveModel) model.resetView();
  },
  pinch: (factor, cx, cy, dx, dy) => {
    if (!(model instanceof LiveModel)) return;
    model.zoomAt(factor, cx, cy, canvas.width, canvas.height);
    model.panBy(dx, dy, canvas.width, canvas.height);
  },
  wheel: (factor, x, y) => {
    if (model instanceof LiveModel) model.zoomAt(factor, x, y, canvas.width, canvas.height);
  },
});
// Alt+wheel zooms as the plain wheel does (some systems scroll sideways with Alt).
canvas.addEventListener(
  "wheel",
  (e) => {
    if (!e.altKey || e.deltaY !== 0 || e.deltaX === 0 || !(model instanceof LiveModel)) return;
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) * canvas.width) / Math.max(1, r.width);
    const y = ((e.clientY - r.top) * canvas.height) / Math.max(1, r.height);
    model.zoomAt(Math.exp(-e.deltaX * 0.0015), x, y, canvas.width, canvas.height);
  },
  { passive: true },
);
maskSizeEl.addEventListener("change", () => {
  if (model instanceof LiveModel) model.setMasks(maskSizeEl.value as MaskSetting);
});
budgetEl.addEventListener("change", () => {
  textureBudget = parseTextureBudget(budgetEl.value);
  store.set("textureBudget", String(textureBudget));
  const c = current;
  if (c?.activeSettings && model instanceof LiveModel)
    void guarded("Reloading textures", () => showModel(c.source, c.activeSettings!));
});

async function guarded(what: string, fn: () => Promise<void>): Promise<void> {
  setStatus(`${what}…`);
  try {
    await fn();
  } catch (e) {
    console.error(e);
    // Our typed errors (a file past its cap, a damaged file) say what they are.
    const text =
      e instanceof Error ? (e.name === "Error" ? e.message : `${e.name}: ${e.message}`) : String(e);
    setStatus(`${what} failed: ${text}`, true);
  }
}

// ---- the File menu --------------------------------------------------------------

$<HTMLInputElement>("pick-folder").addEventListener("change", (ev) => {
  const input = ev.target as HTMLInputElement;
  if (input.files?.length)
    void guarded("Opening folder", () => openSource(sourceFromFileList(input.files!)));
  input.value = "";
  layout.closeMenus();
});

$<HTMLInputElement>("pick-zip").addEventListener("change", (ev) => {
  const input = ev.target as HTMLInputElement;
  const f = input.files?.[0];
  if (f)
    void guarded("Opening zip", async () =>
      openSource(sourceFromZip(f.name, new Uint8Array(await f.arrayBuffer()))),
    );
  input.value = "";
  layout.closeMenus();
});

/** Adds loose files (motions, expressions, sounds) to the current model. */
async function addFiles(files: Iterable<File>): Promise<number> {
  let n = 0;
  for (const f of files) {
    const path = `${ADDED}${f.name}`;
    extraFiles.set(path, new Uint8Array(await f.arrayBuffer()));
    if (current && !current.files.includes(path)) current.files.push(path);
    n++;
  }
  renderResources();
  return n;
}

$<HTMLInputElement>("pick-extra").addEventListener("change", (ev) => {
  const input = ev.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = "";
  layout.closeMenus();
  void guarded("Adding files", async () => setStatus(`Added ${await addFiles(files)} file(s)`));
});

function openUrl(url: string): Promise<void> {
  return guarded("Loading URL", async () => {
    const { source, entry } = await sourceFromUrl(url);
    await openSource(source, entry);
    remember({ kind: "url", ref: url });
  });
}

$<HTMLFormElement>("url-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const url = $<HTMLInputElement>("url-input").value.trim();
  layout.closeMenus();
  if (url) void openUrl(url);
});

$<HTMLFormElement>("item-url-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const url = $<HTMLInputElement>("item-url").value.trim();
  if (url)
    void guarded("Adding item", async () => {
      const { source, entry } = await sourceFromUrl(url);
      await itemsUi?.add(source, entry);
    });
});

// Items from a folder, a zip or the models list.
$<HTMLInputElement>("pick-item-folder").addEventListener("change", (ev) => {
  const input = ev.target as HTMLInputElement;
  const files = input.files ? [...input.files] : [];
  input.value = "";
  if (files.length)
    void guarded("Adding item", async () => itemsUi?.add(sourceFromFileList(files)));
});
$<HTMLInputElement>("pick-item-zip").addEventListener("change", (ev) => {
  const input = ev.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = "";
  if (f)
    void guarded("Adding item", async () =>
      itemsUi?.add(sourceFromZip(f.name, new Uint8Array(await f.arrayBuffer()))),
    );
});

// ---- the Edit menu --------------------------------------------------------------

$<HTMLButtonElement>("edit-reset").addEventListener("click", () => {
  const m = model;
  if (m instanceof LiveModel) m.runtime.resetParameters();
  else if (m) for (const p of m.parameters) m.setParameter(p.id, p.default);
  setStatus("Parameters reset to their defaults");
});
$<HTMLButtonElement>("edit-stop").addEventListener("click", () => {
  animUi.stopMotions();
  setStatus("Motions stopped");
});

/** Compares two .moc3 files and shows the differences in the settings area. */
async function compareFiles(files: File[]): Promise<void> {
  if (files.length !== 2) {
    setStatus("Choose exactly two .moc3 files to compare", true);
    return;
  }
  const [a, b] = await Promise.all(
    files.map(async (f) => loadMoc(new Uint8Array(await f.arrayBuffer()))),
  );
  const diffs = compareMocModels(a!, b!);
  settingsArea.showComparison(files[0]!.name, files[1]!.name, diffs);
  if (layout.narrow) {
    layout.setPanels(true);
    layout.showSheet("settings");
  }
  setStatus(`${files[0]!.name} and ${files[1]!.name}: ${diffs.length} difference(s)`);
}
$<HTMLInputElement>("pick-compare").addEventListener("change", (ev) => {
  const input = ev.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = "";
  layout.closeMenus();
  void guarded("Comparing", () => compareFiles(files));
});

// ---- drag and drop ----------------------------------------------------------------

let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth++;
  stageEl.classList.add("dragging");
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) stageEl.classList.remove("dragging");
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  stageEl.classList.remove("dragging");
  const dt = e.dataTransfer;
  if (!dt) return;
  // Loose files without a folder: two .moc3 files are compared; motions,
  // expressions and sounds are added to the open model.
  const items = [...dt.items];
  const folders = items.some((i) => i.webkitGetAsEntry?.()?.isDirectory);
  const files = [...dt.files];
  if (!folders && files.length) {
    const kinds = files.map((f) => classifyModelFile(f.name));
    if (files.length === 2 && kinds.every((k) => k === "moc")) {
      void guarded("Comparing", () => compareFiles(files));
      return;
    }
    if (current && kinds.every((k) => k === "motion" || k === "expression" || k === "sound")) {
      void guarded("Adding files", async () => setStatus(`Added ${await addFiles(files)} file(s)`));
      return;
    }
  }
  void guarded("Opening dropped files", async () => openSource(await sourceFromDataTransfer(dt)));
});

// Models listed in models/index.json next to the page: served by the dev and
// viewer servers (assets/models/ and vetted repository folders), or written by
// the static build for the folders it includes.
const modelSelect = $<HTMLSelectElement>("model-select");
const itemSelect = $<HTMLSelectElement>("item-select");
itemSelect.hidden = true;
const modelsBase = new URL("models/", location.href);
let modelIndex: string[] = [];
const modelIndexReady = (async () => {
  try {
    const res = await fetch(new URL("index.json", modelsBase));
    if (!res.ok) throw new Error();
    const { files } = (await res.json()) as { files: string[] };
    modelIndex = files;
    for (const p of files.filter((f) => classifyModelFile(f) === "settings")) {
      modelSelect.append(new Option(p, p));
      itemSelect.append(new Option(p, p));
    }
    modelSelect.hidden = false;
    itemSelect.hidden = false;
  } catch {
    modelSelect.hidden = true;
  }
})();

/** A model listed in models/index.json, with its folder's file list. */
function listedSource(settings: string): { source: FileSource; entry: string } {
  const dir = settings.includes("/") ? settings.slice(0, settings.lastIndexOf("/") + 1) : "";
  const files = modelIndex.filter((f) => f.startsWith(dir)).map((f) => f.slice(dir.length));
  const http = new HttpFileSource(
    new URL(dir, modelsBase).href,
    dir.replace(/\/$/, "") || "models",
  );
  const source: FileSource = { label: http.label, list: () => files, read: (p) => http.read(p) };
  return { source, entry: settings.slice(dir.length) };
}

/** Opens a model listed in models/index.json. */
async function openListedModel(settings: string): Promise<void> {
  await modelIndexReady;
  const { source, entry } = listedSource(settings);
  return guarded("Opening model", async () => {
    await openSource(source, entry);
    remember({ kind: "listed", ref: settings });
  });
}

itemSelect.addEventListener("change", () => {
  const settings = itemSelect.value;
  itemSelect.value = "";
  if (!settings) return;
  const { source, entry } = listedSource(settings);
  void guarded("Adding item", async () => itemsUi?.add(source, entry));
});

modelSelect.addEventListener("change", () => {
  const settings = modelSelect.value;
  layout.closeMenus();
  if (settings) void openListedModel(settings);
});

// ?model=<path in models/index.json, or a URL of a *.model3.json or .zip> opens a model at start.
const requested = new URLSearchParams(location.search).get("model");

// With no model open, the sample model «Mochi» (samples/mochi/ in the
// repository, or mochi/ in a static build that includes it) is one click away.
const sampleButton = $<HTMLButtonElement>("open-sample");
void modelIndexReady.then(() => {
  const sample = modelIndex.find((f) => /(^|\/)mochi\/mochi\.model3\.json$/.test(f));
  if (!sample || requested || current) return;
  sampleOffer.hidden = false;
  sampleButton.onclick = () => void openListedModel(sample);
});
if (requested)
  void modelIndexReady.then(() => {
    if (modelIndex.includes(requested)) {
      modelSelect.value = requested;
      return openListedModel(requested);
    }
    return openUrl(requested);
  });

// Expose for debugging in the console.
Object.assign(window, {
  mochi2dViewer: {
    get current() {
      return current;
    },
    extraFiles,
    stage,
    get model() {
      return model;
    },
    itemsUi,
    audio,
    animUi,
    tree,
    settingsArea,
    menus,
    device,
    layout,
    get lastExport() {
      return lastExport;
    },
    get edits() {
      return edits;
    },
  },
});
