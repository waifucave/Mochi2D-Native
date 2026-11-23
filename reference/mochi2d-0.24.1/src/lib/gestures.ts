/**
 * Pointer gestures on a canvas, for mouse, pen and touch alike: tap, double
 * tap, one-pointer drag, two-finger pinch (zoom about the fingers' center and
 * pan with it), wheel zoom, and hover. {@link GestureTracker} is the pure
 * logic; {@link bindGestures} feeds it from DOM pointer and wheel events.
 *
 * All positions are in the canvas's drawing-buffer pixels ("image pixels"),
 * y down.
 */

export interface PressInfo {
  /** 0 primary, 1 middle, 2 secondary. */
  button: number;
  shift: boolean;
  /** Ctrl (or ⌘ on macOS) held. */
  ctrl?: boolean;
  alt?: boolean;
  pointerType: string;
}

/**
 * What a one-pointer drag does, decided when the pointer goes down. "item"
 * moves an item (see `MochiView.addItem`).
 */
export type DragMode = "look" | "pan" | "item" | "none";

export interface GestureHandlers {
  /** A pointer went down; returns what dragging it does. */
  press?(x: number, y: number, info: PressInfo): DragMode;
  /** The pressed pointer moved (dx, dy since the last move). */
  drag?(x: number, y: number, dx: number, dy: number, mode: DragMode): void;
  /** The drag ended (pointer up or cancelled, or a second finger came down). */
  release?(mode: DragMode): void;
  /** A press and release without moving. */
  tap?(x: number, y: number, info: PressInfo): void;
  /** A second tap close in time and place to the previous one (instead of `tap`). */
  doubleTap?(x: number, y: number, info: PressInfo): void;
  /** Two fingers: zoom by `factor` about (cx, cy), and move by (dx, dy). */
  pinch?(factor: number, cx: number, cy: number, dx: number, dy: number): void;
  /** Wheel or trackpad zoom by `factor` about (x, y). */
  wheel?(factor: number, x: number, y: number): void;
  /** A mouse moved over the canvas with no button pressed. */
  hover?(x: number, y: number): void;
  /** The mouse left the canvas. */
  leave?(): void;
}

export interface GestureOptions {
  /** Movement (image pixels) below which a press still counts as a tap. Default 6. */
  slop?: number;
  /** Longest press that counts as a tap, ms. Default 500. */
  tapTime?: number;
  /** Longest gap between the taps of a double tap, ms. Default 350. */
  doubleTapTime?: number;
  /** Largest distance between the taps of a double tap (image pixels). Default 30. */
  doubleTapDistance?: number;
}

interface Pointer {
  id: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  startTime: number;
  info: PressInfo;
}

/** Gesture recognition from abstract pointer events (no DOM). */
export class GestureTracker {
  private readonly pointers = new Map<number, Pointer>();
  private mode: DragMode = "none";
  /** The current press may still become a tap. */
  private tapCandidate = false;
  /** A second finger joined: no tap or drag until every pointer is up. */
  private multi = false;
  private pinchLast: { d: number; cx: number; cy: number } | null = null;
  private lastTap: { x: number; y: number; t: number } | null = null;
  private readonly o: Required<GestureOptions>;

  constructor(
    private readonly h: GestureHandlers,
    options: GestureOptions = {},
  ) {
    this.o = {
      slop: options.slop ?? 6,
      tapTime: options.tapTime ?? 500,
      doubleTapTime: options.doubleTapTime ?? 350,
      doubleTapDistance: options.doubleTapDistance ?? 30,
    };
  }

  /** Scales the distance thresholds (e.g. by the device pixel ratio). */
  setScale(scale: number, base: GestureOptions = {}): void {
    this.o.slop = (base.slop ?? 6) * scale;
    this.o.doubleTapDistance = (base.doubleTapDistance ?? 30) * scale;
  }

  get active(): boolean {
    return this.pointers.size > 0;
  }

  down(id: number, x: number, y: number, t: number, info: PressInfo): void {
    if (this.pointers.has(id)) return;
    const p: Pointer = { id, x, y, startX: x, startY: y, startTime: t, info };
    this.pointers.set(id, p);
    if (this.pointers.size === 1) {
      this.multi = false;
      this.tapCandidate = true;
      this.mode = this.h.press?.(x, y, info) ?? "none";
    } else if (this.pointers.size === 2) {
      // A second finger turns the gesture into a pinch.
      if (this.mode !== "none") this.h.release?.(this.mode);
      this.mode = "none";
      this.tapCandidate = false;
      this.multi = true;
      this.pinchLast = this.pinchState();
    }
  }

  move(id: number, x: number, y: number): void {
    const p = this.pointers.get(id);
    if (!p) return;
    const dx = x - p.x;
    const dy = y - p.y;
    p.x = x;
    p.y = y;
    if (this.pointers.size >= 2) {
      const s = this.pinchState();
      const last = this.pinchLast;
      if (s && last && last.d > 0)
        this.h.pinch?.(s.d / last.d, s.cx, s.cy, s.cx - last.cx, s.cy - last.cy);
      this.pinchLast = s;
      return;
    }
    if (this.multi) return;
    if (Math.hypot(x - p.startX, y - p.startY) > this.o.slop) this.tapCandidate = false;
    if (this.mode !== "none") this.h.drag?.(x, y, dx, dy, this.mode);
  }

  up(id: number, t: number): void {
    const p = this.pointers.get(id);
    if (!p) return;
    this.pointers.delete(id);
    if (this.pointers.size >= 2) {
      this.pinchLast = this.pinchState();
      return;
    }
    if (this.pointers.size === 1) {
      // One finger of a pinch lifted: wait for the other.
      this.pinchLast = null;
      return;
    }
    if (this.multi) {
      this.multi = false;
      return;
    }
    if (this.mode !== "none") this.h.release?.(this.mode);
    this.mode = "none";
    if (this.tapCandidate && t - p.startTime <= this.o.tapTime) {
      const prev = this.lastTap;
      if (
        prev &&
        t - prev.t <= this.o.doubleTapTime &&
        Math.hypot(p.x - prev.x, p.y - prev.y) <= this.o.doubleTapDistance
      ) {
        this.lastTap = null;
        if (this.h.doubleTap) this.h.doubleTap(p.x, p.y, p.info);
        else this.h.tap?.(p.x, p.y, p.info);
      } else {
        this.lastTap = { x: p.x, y: p.y, t };
        this.h.tap?.(p.x, p.y, p.info);
      }
    }
    this.tapCandidate = false;
  }

  /** The pointer was taken away (e.g. by a browser gesture): no tap. */
  cancel(id: number): void {
    if (!this.pointers.has(id)) return;
    this.tapCandidate = false;
    this.up(id, Infinity);
  }

  wheel(deltaY: number, x: number, y: number, pinch: boolean): void {
    this.h.wheel?.(Math.exp(-deltaY * (pinch ? 0.01 : 0.0015)), x, y);
  }

  hover(x: number, y: number): void {
    if (this.pointers.size === 0) this.h.hover?.(x, y);
  }

  leave(): void {
    if (this.pointers.size === 0) this.h.leave?.();
  }

  private pinchState(): { d: number; cx: number; cy: number } | null {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return null;
    return { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  }
}

/**
 * Feeds a {@link GestureTracker} from a canvas's pointer and wheel events.
 * Thresholds are given in CSS pixels and scaled to the drawing buffer.
 * Returns a function that removes the listeners.
 */
export function bindGestures(
  canvas: HTMLCanvasElement,
  handlers: GestureHandlers,
  options: GestureOptions & {
    /** Handle the wheel (and trackpad pinch). Default true. */
    wheel?: boolean;
  } = {},
): () => void {
  const tracker = new GestureTracker(handlers, options);
  const scale = () => canvas.width / Math.max(1, canvas.clientWidth);
  const pos = (e: MouseEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [
      ((e.clientX - r.left) * canvas.width) / Math.max(1, r.width),
      ((e.clientY - r.top) * canvas.height) / Math.max(1, r.height),
    ];
  };
  const onDown = (e: PointerEvent) => {
    if (e.button > 2) return;
    tracker.setScale(scale(), options);
    const [x, y] = pos(e);
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // not capturable (synthetic events)
    }
    tracker.down(e.pointerId, x, y, e.timeStamp, {
      button: e.button,
      shift: e.shiftKey,
      ctrl: e.ctrlKey || e.metaKey,
      alt: e.altKey,
      pointerType: e.pointerType,
    });
    if (e.pointerType !== "mouse") e.preventDefault();
  };
  const onMove = (e: PointerEvent) => {
    const [x, y] = pos(e);
    if (tracker.active) tracker.move(e.pointerId, x, y);
    else if (e.pointerType === "mouse") tracker.hover(x, y);
  };
  const onUp = (e: PointerEvent) => tracker.up(e.pointerId, e.timeStamp);
  const onCancel = (e: PointerEvent) => tracker.cancel(e.pointerId);
  const onLeave = (e: PointerEvent) => {
    if (e.pointerType === "mouse") tracker.leave();
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const [x, y] = pos(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1;
    tracker.wheel(e.deltaY * unit, x, y, e.ctrlKey);
  };
  const prevent = (e: Event) => e.preventDefault();
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onCancel);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("contextmenu", prevent);
  // Safari's own pinch events would zoom the page.
  canvas.addEventListener("gesturestart", prevent);
  canvas.addEventListener("gesturechange", prevent);
  const wheel = options.wheel ?? true;
  if (wheel) canvas.addEventListener("wheel", onWheel, { passive: false });
  return () => {
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("pointercancel", onCancel);
    canvas.removeEventListener("pointerleave", onLeave);
    canvas.removeEventListener("contextmenu", prevent);
    canvas.removeEventListener("gesturestart", prevent);
    canvas.removeEventListener("gesturechange", prevent);
    if (wheel) canvas.removeEventListener("wheel", onWheel);
  };
}
