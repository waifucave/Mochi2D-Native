/**
 * A data-driven, searchable list of sliders (used for parameters and part
 * opacities). Each row has a label, a range input, the numeric value and a
 * reset button; double-clicking a slider also resets it.
 */
export interface SliderItem {
  id: string;
  label: string;
  min: number;
  max: number;
  default: number;
  group?: string;
  step?: number;
}

export interface SliderListOptions {
  items: readonly SliderItem[];
  get(id: string): number;
  set(id: string, value: number): void;
  searchPlaceholder?: string;
  /** Called after any user change (slider, reset). */
  onChange?: () => void;
}

interface Row {
  item: SliderItem;
  el: HTMLElement;
  label: HTMLLabelElement;
  note: HTMLElement;
  input: HTMLInputElement;
  output: HTMLOutputElement;
  reset: HTMLButtonElement;
  groupEl: HTMLElement | null;
}

function formatValue(v: number, item: SliderItem): string {
  const span = item.max - item.min;
  const digits = span >= 100 ? 1 : span >= 10 ? 2 : 3;
  return v.toFixed(digits);
}

export class SliderList {
  readonly element: HTMLElement;
  private readonly rows: Row[] = [];
  private readonly search: HTMLInputElement;
  private readonly count: HTMLElement;
  private readonly list: HTMLElement;
  private dragging: string | null = null;

  constructor(private readonly opts: SliderListOptions) {
    const root = document.createElement("div");
    root.className = "slider-list";
    const tools = document.createElement("div");
    tools.className = "slider-tools";
    this.search = document.createElement("input");
    this.search.type = "search";
    this.search.placeholder = opts.searchPlaceholder ?? "Search…";
    this.search.addEventListener("input", () => this.applyFilter());
    this.count = document.createElement("span");
    this.count.className = "slider-count";
    const resetAll = document.createElement("button");
    resetAll.type = "button";
    resetAll.className = "btn small";
    resetAll.textContent = "Reset all";
    resetAll.addEventListener("click", () => this.resetAll());
    tools.append(this.search, this.count, resetAll);
    this.list = document.createElement("div");
    this.list.className = "slider-rows";
    root.append(tools, this.list);
    this.element = root;
    this.build();
  }

  private build(): void {
    let group: string | undefined;
    let groupEl: HTMLElement | null = null;
    for (const item of this.opts.items) {
      if (item.group !== undefined && item.group !== group) {
        group = item.group;
        groupEl = document.createElement("div");
        groupEl.className = "slider-group";
        groupEl.textContent = group;
        this.list.append(groupEl);
      }
      const el = document.createElement("div");
      el.className = "slider-row";
      const label = document.createElement("label");
      label.textContent = item.label;
      label.title = item.id;
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(item.min);
      input.max = String(item.max);
      input.step = String(item.step ?? (item.max - item.min) / 1000);
      input.setAttribute("aria-label", `${item.label} (${item.id})`);
      const output = document.createElement("output");
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "reset";
      reset.title = `Reset to ${item.default}`;
      reset.textContent = "↺";
      const note = document.createElement("span");
      note.className = "slider-note";
      note.hidden = true;
      label.append(note);
      const row: Row = { item, el, label, note, input, output, reset, groupEl };
      input.addEventListener("input", () => {
        this.opts.set(item.id, Number(input.value));
        this.updateRow(row);
        this.opts.onChange?.();
      });
      input.addEventListener("pointerdown", () => (this.dragging = item.id));
      input.addEventListener("pointerup", () => (this.dragging = null));
      input.addEventListener("dblclick", () => this.resetRow(row));
      reset.addEventListener("click", () => this.resetRow(row));
      el.append(label, input, output, reset);
      this.list.append(el);
      this.rows.push(row);
      this.updateRow(row);
    }
    this.applyFilter();
  }

  private resetRow(row: Row): void {
    this.opts.set(row.item.id, row.item.default);
    this.updateRow(row);
    this.opts.onChange?.();
  }

  private updateRow(row: Row): void {
    const v = this.opts.get(row.item.id);
    if (this.dragging !== row.item.id && Number(row.input.value) !== v) row.input.value = String(v);
    row.output.value = formatValue(v, row.item);
    row.reset.hidden = Math.abs(v - row.item.default) < 1e-9;
  }

  /**
   * Marks a row as driven by something else (e.g. physics): shows `note` and,
   * with `locked`, disables its controls. A null note clears the mark.
   */
  setNote(id: string, note: string | null, locked = false): void {
    for (const r of this.rows) {
      if (r.item.id !== id) continue;
      r.note.textContent = note ?? "";
      r.note.hidden = note === null;
      r.el.classList.toggle("driven", note !== null && locked);
      r.input.disabled = note !== null && locked;
      r.reset.disabled = r.input.disabled;
      r.label.title = note ? `${r.item.id} — ${note}` : r.item.id;
    }
  }

  /** Re-reads every value from the model (e.g. after animation changed them). */
  refresh(): void {
    for (const r of this.rows) this.updateRow(r);
  }

  resetAll(): void {
    for (const r of this.rows) this.opts.set(r.item.id, r.item.default);
    this.refresh();
    this.opts.onChange?.();
  }

  private applyFilter(): void {
    const q = this.search.value.trim().toLowerCase();
    let shown = 0;
    const visibleGroups = new Set<HTMLElement>();
    for (const r of this.rows) {
      const match =
        !q || r.item.id.toLowerCase().includes(q) || r.item.label.toLowerCase().includes(q);
      r.el.hidden = !match;
      if (match) {
        shown++;
        if (r.groupEl) visibleGroups.add(r.groupEl);
      }
    }
    for (const g of this.list.querySelectorAll<HTMLElement>(".slider-group"))
      g.hidden = !visibleGroups.has(g);
    this.count.textContent = q ? `${shown} / ${this.rows.length}` : `${this.rows.length}`;
  }
}
