/**
 * The viewer's menu bar (File, Edit, Display, Animation): a button per menu
 * opens its popup. One popup is open at a time; while one is open, pointing
 * at another menu's button opens that one. A click outside, Escape or a
 * chosen command closes it. Controls inside a popup (check boxes, selects,
 * fields) keep it open while they are used.
 */
export interface Menus {
  /** Closes the open menu, if any. */
  close(): void;
  /** Opens one menu by its button's ID. */
  open(buttonId: string): void;
  /** The open menu's button ID, or null. */
  readonly openId: string | null;
  /** Called when a menu opens or closes (the layout closes other sheets then). */
  onChange: ((openId: string | null) => void) | null;
}

export function initMenus(root: HTMLElement): Menus {
  const buttons = [...root.querySelectorAll<HTMLButtonElement>(".menu-button")];
  const popupOf = (b: HTMLButtonElement) =>
    document.getElementById(b.getAttribute("aria-controls") ?? "") as HTMLElement | null;
  let openId: string | null = null;

  const set = (id: string | null) => {
    if (id === openId) return;
    openId = id;
    for (const b of buttons) {
      const on = b.id === id;
      b.setAttribute("aria-expanded", String(on));
      popupOf(b)?.classList.toggle("open", on);
    }
    // The phone layout styles the File menu through this class (see style.css).
    document.body.classList.toggle("open-menu", id === "toggle-open");
    menus.onChange?.(id);
  };

  const menus: Menus = {
    close: () => set(null),
    open: (id) => set(id),
    get openId() {
      return openId;
    },
    onChange: null,
  };

  for (const b of buttons) {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      set(openId === b.id ? null : b.id);
    });
    b.addEventListener("pointerenter", (e) => {
      if (openId && openId !== b.id && (e as PointerEvent).pointerType === "mouse") set(b.id);
    });
    const popup = popupOf(b);
    // Commands close the menu; controls that keep a state (inputs, selects) do not.
    popup?.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("button.menu-item, .recent-list button")) set(null);
    });
  }
  document.addEventListener("pointerdown", (e) => {
    if (!openId) return;
    const t = e.target as HTMLElement;
    if (t.closest(".menu")) return;
    set(null);
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && openId) set(null);
  });
  return menus;
}
