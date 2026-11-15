/**
 * The resource tree: everything the viewer has loaded for the model, as a
 * tree. The model settings file, with under it the `.moc3`, the textures, the
 * physics, the motions by group, the expressions, the pose, the user data,
 * the motion-sync settings and the display information. Selecting an item
 * shows its settings in the settings area; double-clicking a motion or an
 * expression plays it; right-clicking a motion shows its curves. Items
 * changed in the viewer carry an asterisk until they are exported.
 */
import { dirnameOf, joinPath } from "../core/io/file-source.js";
import { classifyModelFile } from "../core/io/model-files.js";
import type { ModelSettings, MotionEntry } from "../core/settings/model-settings.js";

export type ResourceKind =
  | "settings"
  | "moc"
  | "textures"
  | "texture"
  | "physics"
  | "motions"
  | "motionGroup"
  | "motion"
  | "expressions"
  | "expression"
  | "pose"
  | "userData"
  | "motionSync"
  | "displayInfo";

export interface ResourceNode {
  kind: ResourceKind;
  /** A stable key: the kind and the file path, or the group. */
  key: string;
  label: string;
  /** The file's path in the source, for files. */
  path?: string;
  /** Motions: the settings group and the index in it (none: a file the settings do not list). */
  group?: string;
  index?: number;
  entry?: MotionEntry;
  /** Textures: the index. */
  texture?: number;
  children?: ResourceNode[];
}

/** What the tree shows: a folder's files and, once loaded, the model settings. */
export interface ResourceSource {
  label: string;
  files: string[];
  settingsPath?: string;
  settings?: ModelSettings;
}

export interface ResourceTreeOptions {
  root: HTMLElement;
  /** A node was selected: by the user (a click), or by the viewer. */
  onSelect(node: ResourceNode, byUser: boolean): void;
  /** Double-click or Enter: play a motion or an expression. */
  onActivate(node: ResourceNode): void;
  /** Right-click (a motion's curve graph). */
  onContext(node: ResourceNode): void;
}

const short = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The tree's nodes for a folder and its settings. */
export function buildResources(src: ResourceSource): ResourceNode[] {
  const s = src.settings;
  const dir = src.settingsPath ? dirnameOf(src.settingsPath) : "";
  const resolve = (p: string) => joinPath(dir, p);
  const byKind = (kind: string) => src.files.filter((p) => classifyModelFile(p) === kind);
  const file = (kind: ResourceKind, path: string, label = short(path)): ResourceNode => ({
    kind,
    key: `${kind}:${path}`,
    label,
    path,
  });
  const children: ResourceNode[] = [];
  if (s) {
    children.push(file("moc", resolve(s.moc)));
    children.push({
      kind: "textures",
      key: "textures",
      label: "Textures",
      children: s.textures.map((t, i) => ({
        ...file("texture", resolve(t), `${i}: ${short(t)}`),
        texture: i,
      })),
    });
    if (s.physics) children.push(file("physics", resolve(s.physics)));
  }
  // Motions: the settings' groups, then the folder's files they do not list.
  const listed = new Set<string>();
  const groups: ResourceNode[] = [];
  for (const g of s?.motions ?? []) {
    groups.push({
      kind: "motionGroup",
      key: `group:${g.group}`,
      label: g.group,
      group: g.group,
      children: g.entries.map((entry, i) => {
        const path = resolve(entry.file);
        listed.add(path);
        return {
          ...file("motion", path),
          key: `motion:${g.group}:${i}`,
          group: g.group,
          index: i,
          entry,
        };
      }),
    });
  }
  const unlisted = byKind("motion").filter((p) => !listed.has(p));
  // Without groups in the settings, the folder's motions sit under Motions itself.
  if (unlisted.length && groups.length)
    groups.push({
      kind: "motionGroup",
      key: "group:",
      label: "Not in the settings",
      children: unlisted.map((p) => file("motion", p)),
    });
  else for (const p of unlisted) groups.push(file("motion", p));
  children.push({ kind: "motions", key: "motions", label: "Motions", children: groups });
  // Expressions: the named ones, then unlisted files.
  const named = new Set<string>();
  const expressions: ResourceNode[] = (s?.expressions ?? []).map((e) => {
    const path = resolve(e.file);
    named.add(path);
    return file("expression", path, e.name);
  });
  for (const p of byKind("expression")) if (!named.has(p)) expressions.push(file("expression", p));
  children.push({
    kind: "expressions",
    key: "expressions",
    label: "Expressions",
    children: expressions,
  });
  if (s?.pose) children.push(file("pose", resolve(s.pose)));
  if (s?.userData) children.push(file("userData", resolve(s.userData)));
  if (s?.motionSync) children.push(file("motionSync", resolve(s.motionSync)));
  if (s?.displayInfo) children.push(file("displayInfo", resolve(s.displayInfo)));
  const top: ResourceNode = src.settingsPath
    ? { ...file("settings", src.settingsPath), children }
    : { kind: "settings", key: "settings:", label: src.label, children };
  return [top];
}

export class ResourceTree {
  private nodes: ResourceNode[] = [];
  private selected: string | null = null;
  private readonly unsaved = new Set<string>();
  private readonly rows = new Map<string, HTMLButtonElement>();
  private readonly collapsed = new Set<string>();

  constructor(private readonly opts: ResourceTreeOptions) {}

  /** The selected node, or null. */
  get selection(): ResourceNode | null {
    return this.selected ? (this.find((n) => n.key === this.selected) ?? null) : null;
  }

  /** Whether any item is changed and not exported. */
  get anyUnsaved(): boolean {
    return this.unsaved.size > 0;
  }

  /** Every node, depth first. */
  all(): ResourceNode[] {
    const out: ResourceNode[] = [];
    const walk = (list: ResourceNode[]) => {
      for (const n of list) {
        out.push(n);
        if (n.children) walk(n.children);
      }
    };
    walk(this.nodes);
    return out;
  }

  find(pred: (n: ResourceNode) => boolean): ResourceNode | undefined {
    return this.all().find(pred);
  }

  /** Shows new nodes, keeping the selection (by key) when it still exists. */
  set(nodes: ResourceNode[]): void {
    this.nodes = nodes;
    const keys = new Set(this.all().map((n) => n.key));
    for (const k of [...this.unsaved]) if (!keys.has(k)) this.unsaved.delete(k);
    if (this.selected && !keys.has(this.selected)) this.selected = null;
    this.render();
  }

  /** Selects a node (and tells the owner). */
  select(node: ResourceNode | null, byUser = false): void {
    this.selected = node?.key ?? null;
    for (const [key, row] of this.rows) {
      const on = key === this.selected;
      row.classList.toggle("selected", on);
      row.setAttribute("aria-selected", String(on));
    }
    if (node) this.opts.onSelect(node, byUser);
  }

  /** Marks a node changed (an asterisk after its name) or exported. */
  markUnsaved(key: string, on: boolean): void {
    if (on) this.unsaved.add(key);
    else this.unsaved.delete(key);
    const row = this.rows.get(key);
    if (row) row.classList.toggle("unsaved", on);
  }

  isUnsaved(key: string): boolean {
    return this.unsaved.has(key);
  }

  private render(): void {
    const root = this.opts.root;
    root.replaceChildren();
    this.rows.clear();
    const list = (nodes: ResourceNode[], depth: number, into: HTMLElement) => {
      for (const n of nodes) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = `tree-row kind-${n.kind}`;
        row.setAttribute("role", "treeitem");
        row.style.setProperty("--depth", String(depth));
        row.dataset.key = n.key;
        row.title = n.path ?? n.label;
        const label = document.createElement("span");
        label.className = "tree-label";
        label.textContent = n.label;
        row.append(label);
        if (n.kind === "motion" || n.kind === "expression") row.classList.add("anim-item");
        if (n.kind === "motion" && n.group !== undefined)
          row.title = `${n.group}[${n.index}]: ${n.path}`;
        if (n.children) {
          row.classList.add("branch");
          row.setAttribute("aria-expanded", String(!this.collapsed.has(n.key)));
          const count = document.createElement("span");
          count.className = "tree-count";
          count.textContent = String(n.kind === "motions" ? countLeaves(n) : n.children.length);
          if (n.kind !== "settings") row.append(count);
        }
        row.classList.toggle("selected", n.key === this.selected);
        row.classList.toggle("unsaved", this.unsaved.has(n.key));
        row.addEventListener("click", () => {
          if (n.children && n.kind !== "settings" && this.selected === n.key) {
            // A second click on a selected branch folds it.
            if (this.collapsed.has(n.key)) this.collapsed.delete(n.key);
            else this.collapsed.add(n.key);
            this.render();
            return;
          }
          this.select(n, true);
        });
        row.addEventListener("dblclick", () => this.opts.onActivate(n));
        row.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            this.opts.onActivate(n);
          }
        });
        row.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          this.select(n, true);
          this.opts.onContext(n);
        });
        into.append(row);
        this.rows.set(n.key, row);
        if (n.children && !this.collapsed.has(n.key)) {
          // Motions and expressions keep the IDs the viewer has always had.
          const group = document.createElement("div");
          group.setAttribute("role", "group");
          group.className = "tree-group";
          if (n.kind === "motions") group.id = "panel-motions";
          if (n.kind === "expressions") group.id = "panel-expressions";
          if (n.children.length === 0) {
            const p = document.createElement("p");
            p.className = "empty tree-empty";
            p.style.setProperty("--depth", String(depth + 1));
            p.textContent = "None found.";
            group.append(p);
          }
          list(n.children, depth + 1, group);
          into.append(group);
        }
      }
    };
    list(this.nodes, 0, root);
  }
}

function countLeaves(n: ResourceNode): number {
  return n.children ? n.children.reduce((a, c) => a + (c.children ? countLeaves(c) : 1), 0) : 1;
}
