/**
 * The viewer's responsive layout. On wide screens the menu area, the model
 * view, the resource tree and the settings area sit side by side. On narrow
 * screens (phones) the view has the screen: the three areas are a bottom
 * sheet behind the Panels button, one at a time (tabs in the sheet's header
 * choose it); the menus open under the toolbar, and the stage bar shows its
 * secondary controls on request. CSS does the layout; this toggles the
 * classes and keeps ARIA state in step.
 */
import type { DeviceProfile } from "../lib/texture-budget.js";
import type { Menus } from "./menus.js";

export interface Layout {
  /** The narrow (phone) layout is active. */
  readonly narrow: boolean;
  closeMenus(): void;
  /** A model was loaded: close the open menu. */
  modelLoaded(): void;
  setPanels(open: boolean): void;
  /** Which area the phone sheet shows. */
  showSheet(area: SheetArea): void;
}

export type SheetArea = "menu" | "resources" | "settings";

const NARROW = "(max-width: 720px)";

export function initLayout(device: DeviceProfile, menus: Menus): Layout {
  const body = document.body;
  const query = globalThis.matchMedia?.(NARROW);
  const panelsBtn = document.getElementById("toggle-panels") as HTMLButtonElement;
  const barBtn = document.getElementById("toggle-bar") as HTMLButtonElement;
  const bar = document.querySelector<HTMLElement>(".stage-bar")!;
  const hint = document.getElementById("open-hint");
  body.classList.toggle("touch", device.mobile);
  if (hint && device.mobile)
    hint.textContent =
      device.reason === "iPhone" || device.reason === "iPad"
        ? "On iPhone and iPad, open the model as a .zip (from the Files app) or by URL: Safari cannot open folders."
        : "Open the model as a .zip, a folder, or by URL.";

  const setPanels = (open: boolean) => {
    body.classList.toggle("panels-open", open);
    panelsBtn.setAttribute("aria-expanded", String(open));
  };
  const sheet = document.getElementById("sidebar")!;
  const tabs = [...document.querySelectorAll<HTMLButtonElement>(".sheet-tabs [data-sheet]")];
  const showSheet = (area: SheetArea) => {
    if (sheet.dataset.sheet !== area) sheet.scrollTop = 0;
    sheet.dataset.sheet = area;
    for (const t of tabs) t.setAttribute("aria-selected", String(t.dataset.sheet === area));
  };
  for (const t of tabs) t.addEventListener("click", () => showSheet(t.dataset.sheet as SheetArea));
  const layout: Layout = {
    get narrow() {
      return query?.matches ?? false;
    },
    closeMenus: () => menus.close(),
    modelLoaded: () => menus.close(),
    setPanels,
    showSheet,
  };
  // A menu and the sheet are never open together.
  menus.onChange = (id) => {
    if (id) setPanels(false);
  };
  panelsBtn.addEventListener("click", () => {
    const on = !body.classList.contains("panels-open");
    setPanels(on);
    if (on) menus.close();
  });
  barBtn.addEventListener("click", () => {
    const on = !bar.classList.contains("expanded");
    bar.classList.toggle("expanded", on);
    barBtn.setAttribute("aria-expanded", String(on));
  });
  document.querySelector(".sheet-close")?.addEventListener("click", () => setPanels(false));
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setPanels(false);
  });
  return layout;
}
