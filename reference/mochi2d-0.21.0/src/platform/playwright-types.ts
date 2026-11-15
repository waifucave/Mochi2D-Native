/** The small subset of Playwright's API used here (it is not a typed dependency). */
export interface Playwright {
  chromium: {
    launch(opts?: {
      args?: string[];
      executablePath?: string;
      headless?: boolean;
    }): Promise<Browser>;
  };
}
export interface NewPageOptions {
  viewport?: { width: number; height: number } | null;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
  userAgent?: string;
}
export interface Route {
  fulfill(response: {
    status?: number;
    contentType?: string;
    body?: string | Buffer;
  }): Promise<void>;
  request(): { url(): string };
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
}
export interface Browser {
  newPage(opts?: NewPageOptions): Promise<Page>;
  close(): Promise<void>;
  version(): string;
}
/** A page's alert, confirm or prompt. */
export interface Dialog {
  type(): string;
  message(): string;
  accept(promptText?: string): Promise<void>;
  dismiss(): Promise<void>;
}
export interface Page {
  goto(
    url: string,
    opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" },
  ): Promise<unknown>;
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  evaluate<R>(expression: string): Promise<R>;
  route(url: string, handler: (route: Route) => void | Promise<void>): Promise<void>;
  /** Runs script source in every page load, before the page's own scripts. */
  addInitScript(script: string): Promise<void>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  touchscreen: { tap(x: number, y: number): Promise<void> };
  waitForFunction(
    fn: string,
    arg?: unknown,
    opts?: { timeout?: number; polling?: number | "raf" },
  ): Promise<unknown>;
  on(event: "console", cb: (msg: { type(): string; text(): string }) => void): void;
  on(event: "pageerror", cb: (err: Error) => void): void;
  on(event: "dialog", cb: (dialog: Dialog) => void): void;
  click(selector: string, opts?: { button?: "left" | "right" | "middle" }): Promise<void>;
  dblclick(selector: string): Promise<void>;
  check(selector: string): Promise<void>;
  keyboard: {
    press(key: string): Promise<void>;
    down(key: string): Promise<void>;
    up(key: string): Promise<void>;
  };
  fill(selector: string, value: string): Promise<void>;
  setInputFiles(
    selector: string,
    files: { name: string; mimeType: string; buffer: Uint8Array }[],
  ): Promise<void>;
  waitForSelector(selector: string, opts?: { timeout?: number }): Promise<unknown>;
  selectOption(selector: string, value: string): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  locator(selector: string): {
    count(): Promise<number>;
    boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  };
  mouse: {
    move(x: number, y: number, opts?: { steps?: number }): Promise<void>;
    down(): Promise<void>;
    up(): Promise<void>;
    click(x: number, y: number): Promise<void>;
    wheel(dx: number, dy: number): Promise<void>;
  };
  close(): Promise<void>;
}
