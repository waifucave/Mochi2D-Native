/**
 * A model's motion sounds: which formats a view plays (WAV by default,
 * compressed ones with `sounds: { compressed: true }`), and the diagnostic
 * for every sound it skips, at load and when it was to play; in a page
 * (headless Chromium) and through the command line.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { motionSoundWarnings, skippedSoundReason, soundFormat } from "../src/anim/sound-format.js";
import { parseModelSettings } from "../src/core/settings/model-settings.js";
import { loadPlaywright, launchChromium } from "../tools/lib/browser.js";
import { startStaticServer, type RunningServer } from "../tools/lib/static-server.js";
import type { Browser, Page } from "../tools/lib/playwright-types.js";
import { wavFile } from "./support/motion-sync.js";

const root = resolve(__dirname, "..");
const enc = (s: string) => new TextEncoder().encode(s);
const MP3 = Uint8Array.from([...enc("ID3"), 4, 0, 0, 0, 0, 0, 0, ...new Array(64).fill(0)]);
const OGG = Uint8Array.from([...enc("OggS"), ...new Array(60).fill(0)]);
const FLAC = Uint8Array.from([...enc("fLaC"), ...new Array(60).fill(0)]);

/** The sample's settings with a Talk group: one motion with an MP3, one with a WAV-named MP3. */
function settingsWithSounds(): Record<string, unknown> {
  const s = JSON.parse(readFileSync(join(root, "samples/mochi/mochi.model3.json"), "utf8"));
  s.FileReferences.Motions.Talk = [
    { File: "motions/idle.motion3.json", Sound: "voice.mp3" },
    { File: "motions/idle.motion3.json", Sound: "named.wav" },
    { File: "motions/idle.motion3.json", Sound: "real.wav" },
  ];
  return s;
}

describe("sound formats and the diagnostics", () => {
  it("tells formats apart from their first bytes", () => {
    expect(soundFormat(wavFile([new Float32Array(10)], 16000))).toBe("wav");
    expect(soundFormat(MP3)).toBe("mp3");
    expect(soundFormat(Uint8Array.from([0xff, 0xfb, 0x90, 0x00]))).toBe("mp3");
    expect(soundFormat(OGG)).toBe("ogg");
    expect(soundFormat(FLAC)).toBe("flac");
    expect(soundFormat(Uint8Array.from([0xff, 0xf1, 0x50, 0x80]))).toBe("aac");
    expect(soundFormat(new Uint8Array(16))).toBe("unknown");
  });

  it("skips compressed sounds unless allowed, and says why", () => {
    const wav = wavFile([new Float32Array(10)], 16000);
    expect(skippedSoundReason(wav)).toBeNull();
    expect(skippedSoundReason(MP3)).toMatch(
      /^an MP3 file: a model's motion sounds play only as WAV/,
    );
    expect(skippedSoundReason(OGG)).toMatch(/^an Ogg file/);
    expect(skippedSoundReason(FLAC, { compressed: true })).toBeNull();
    expect(skippedSoundReason(new Uint8Array(16))).toBe("not a WAV file");
  });

  it("names, at load, the sounds that won't play", () => {
    const settings = parseModelSettings(enc(JSON.stringify(settingsWithSounds())));
    expect(motionSoundWarnings(settings)).toEqual([
      expect.stringMatching(/^voice\.mp3: motion sound not played: not named \.wav/),
    ]);
    expect(motionSoundWarnings(settings, { compressed: true })).toEqual([]);
    expect(motionSoundWarnings(settings, { played: false })).toHaveLength(3);
  });
});

let hasBrowser = existsSync(join(root, "dist/web/harness.html"));
try {
  loadPlaywright();
} catch {
  hasBrowser = false;
}

describe.skipIf(!hasBrowser)("in a page: MochiView (headless Chromium)", () => {
  let server: RunningServer;
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    server = await startStaticServer(root, root, 0, "127.0.0.1", { models: false });
    browser = await launchChromium();
    page = await browser.newPage({ viewport: { width: 320, height: 320 } });
    await page.goto(new URL("dist/web/harness.html", server.url).href, { waitUntil: "load" });
  }, 90000);
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  }, 60000);

  it("reports every skipped motion sound, at load and at play", async () => {
    const wav = Array.from(wavFile([new Float32Array(1600)], 16000));
    const result = (await page.evaluate(`(async () => {
      const base = ${JSON.stringify(server.url)};
      const lib = await import(base + "dist/lib/mochi2d.js");
      const canvas = document.createElement("canvas");
      canvas.style.width = "200px";
      canvas.style.height = "200px";
      document.body.append(canvas);
      const view = new lib.MochiView(canvas);
      const files = {};
      for (const f of ["mochi.moc3", "mochi.physics3.json", "mochi.cdi3.json", "motions/idle.motion3.json", "mochi.4096/texture_00.png"])
        files[f] = new Uint8Array(await (await fetch(base + "samples/mochi/" + f)).arrayBuffer());
      files["mochi.model3.json"] = new TextEncoder().encode(${JSON.stringify(JSON.stringify(settingsWithSounds()))});
      files["voice.mp3"] = new Uint8Array(${JSON.stringify(Array.from(MP3))});
      files["named.wav"] = new Uint8Array(${JSON.stringify(Array.from(MP3))});
      files["real.wav"] = new Uint8Array(${JSON.stringify(wav)});
      const model = await view.load({ files });
      const atLoad = [...model.warnings];
      await model.startMotion("Talk", 1);
      view.advance(0.1);
      await new Promise((r) => setTimeout(r, 200));
      const atPlay = [...model.warnings];
      const trusting = await view.load({ files }, { sounds: { compressed: true } });
      const trusted = [...trusting.warnings];
      const item = await view.addItem({ files });
      const itemWarnings = [...item.runtime.warnings];
      view.dispose();
      return { atLoad, atPlay, trusted, itemWarnings };
    })()`)) as Record<string, string[]>;
    expect(result.atLoad).toEqual([
      expect.stringMatching(/^voice\.mp3: motion sound not played: not named \.wav/),
    ]);
    // The WAV-named MP3 is reported when it was to play.
    expect(result.atPlay).toContainEqual(
      expect.stringMatching(
        /^named\.wav: motion sound not played: an MP3 file: a model's motion sounds play only as WAV/,
      ),
    );
    expect(result.trusted).toEqual([]);
    // Items play no motion sounds of their own: each is named.
    expect(result.itemWarnings!.filter((w) => /items play no motion sounds/.test(w))).toHaveLength(
      3,
    );
  }, 120000);
});

const CLI = join(root, "dist", "tools", "mochi2d.js");
describe.skipIf(!existsSync(CLI))("through the command line", () => {
  let dir = "";
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("describe prints the motion sounds a view would skip", () => {
    dir = mkdtempSync(join(tmpdir(), "mochi2d-sounds-"));
    cpSync(join(root, "samples/mochi"), dir, { recursive: true });
    writeFileSync(join(dir, "mochi.model3.json"), JSON.stringify(settingsWithSounds()));
    writeFileSync(join(dir, "voice.mp3"), MP3);
    writeFileSync(join(dir, "named.wav"), MP3);
    writeFileSync(join(dir, "real.wav"), wavFile([new Float32Array(1600)], 16000));
    const r = spawnSync(process.execPath, [CLI, "describe", dir], { cwd: root, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(
      /warnings:\n(.*\n)*\s+voice\.mp3: motion sound not played: an MP3 file/,
    );
    expect(r.stdout).toMatch(/named\.wav: motion sound not played: an MP3 file.* \(in a view\)/);
    expect(r.stdout).not.toMatch(/real\.wav: motion sound/);
  }, 60_000);
});
