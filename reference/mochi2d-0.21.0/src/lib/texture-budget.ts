/**
 * Texture memory budgets for interactive use. A model's textures, with their
 * mip chains, are scaled down together to fit the budget, and the viewer says
 * so visibly (texture-notice.ts). Reference renders never use a budget.
 *
 * DeepSeek-chan needs about 789 MiB at full size, which many phones cannot
 * hold, so constrained devices get a smaller default.
 */

const MiB = 1024 * 1024;

/** Budget for phones, tablets and devices reporting ≤ 4 GiB of memory. */
export const CONSTRAINED_TEXTURE_BUDGET = 256 * MiB;
/** Budget for other devices. */
export const DEFAULT_TEXTURE_BUDGET = 1024 * MiB;

/** What the budget choice looks at. Every field is optional, so it works with partial information. */
export interface DeviceInfo {
  userAgent?: string;
  /** `navigator.userAgentData.mobile`, where the browser has it. */
  mobile?: boolean;
  /** `navigator.maxTouchPoints`. */
  maxTouchPoints?: number;
  /** `navigator.platform`. */
  platform?: string;
  /** `navigator.deviceMemory` in GiB (Chromium only; rounded down by the browser). */
  deviceMemory?: number;
}

export interface DeviceProfile {
  /** A phone or tablet. */
  mobile: boolean;
  /** Mobile, or reporting at most 4 GiB of memory. */
  constrained: boolean;
  /** Why, in a few words. */
  reason: string;
}

/** Reads {@link DeviceInfo} from the browser's navigator. */
export function currentDeviceInfo(): DeviceInfo {
  const nav = globalThis.navigator as
    (Navigator & { userAgentData?: { mobile?: boolean }; deviceMemory?: number }) | undefined;
  if (!nav) return {};
  const info: DeviceInfo = {
    userAgent: nav.userAgent,
    maxTouchPoints: nav.maxTouchPoints,
    platform: nav.platform,
  };
  if (typeof nav.userAgentData?.mobile === "boolean") info.mobile = nav.userAgentData.mobile;
  if (typeof nav.deviceMemory === "number") info.deviceMemory = nav.deviceMemory;
  return info;
}

/** Classifies a device as mobile and/or memory-constrained. */
export function deviceProfile(info: DeviceInfo = currentDeviceInfo()): DeviceProfile {
  const ua = info.userAgent ?? "";
  // iPadOS reports a desktop Mac user agent, but has touch points.
  const ipad =
    /Macintosh|MacIntel/.test(ua + (info.platform ?? "")) && (info.maxTouchPoints ?? 0) > 1;
  const mobile = info.mobile === true || /iPhone|iPad|iPod|Android|Mobile/i.test(ua) || ipad;
  const lowMemory = info.deviceMemory !== undefined && info.deviceMemory <= 4;
  return {
    mobile,
    constrained: mobile || lowMemory,
    reason: mobile
      ? ipad
        ? "iPad"
        : /iPhone|iPod/.test(ua)
          ? "iPhone"
          : "mobile device"
      : lowMemory
        ? `${info.deviceMemory} GiB device memory`
        : "desktop",
  };
}

/** A budget choice: "auto" (by device), "full" (no budget), or a size in MiB. */
export type TextureBudgetSetting = "auto" | "full" | number;

/** The budget choices the viewer offers, in MiB. */
export const TEXTURE_BUDGET_CHOICES: readonly number[] = [128, 256, 512, 1024];

export interface ResolvedBudget {
  /** Bytes, or undefined for no budget. */
  bytes: number | undefined;
  /** For display, e.g. "256 MiB (auto: iPhone)". */
  label: string;
}

/** Resolves a budget setting for a device. */
export function resolveTextureBudget(
  setting: TextureBudgetSetting,
  profile: DeviceProfile = deviceProfile(),
): ResolvedBudget {
  if (setting === "full") return { bytes: undefined, label: "full size" };
  if (setting === "auto") {
    const bytes = profile.constrained ? CONSTRAINED_TEXTURE_BUDGET : DEFAULT_TEXTURE_BUDGET;
    return { bytes, label: `${bytes / MiB} MiB (auto: ${profile.reason})` };
  }
  if (!(setting > 0)) throw new RangeError(`texture budget ${setting} MiB is not positive`);
  return { bytes: setting * MiB, label: `${setting} MiB` };
}

/** Parses a stored or user-given setting ("auto", "full" or a number of MiB). */
export function parseTextureBudget(text: string | null | undefined): TextureBudgetSetting {
  if (text === "full") return "full";
  const n = Number(text);
  return text && Number.isFinite(n) && n > 0 ? n : "auto";
}

/** Pixel-ratio limit for the drawing buffer: 2 on mobile devices (their screens are often 3×). */
export function defaultMaxPixelRatio(profile: DeviceProfile = deviceProfile()): number {
  return profile.mobile ? 2 : Infinity;
}
