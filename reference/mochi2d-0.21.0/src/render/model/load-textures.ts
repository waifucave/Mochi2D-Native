/** Loads a model's textures (paths from its settings file) through the texture pipeline. */
import { dirnameOf, joinPath, type FileSource } from "../../core/io/file-source.js";
import type { ModelSettings } from "../../core/settings/model-settings.js";
import { TextureLoader, type LoadedTexture, type TextureLoaderOptions } from "../texture/loader.js";

export async function loadModelTextures(
  gl: WebGL2RenderingContext,
  source: FileSource,
  settingsPath: string,
  settings: ModelSettings,
  options: TextureLoaderOptions = {},
): Promise<{ loader: TextureLoader; textures: LoadedTexture[] }> {
  const dir = dirnameOf(settingsPath);
  const files = await Promise.all(
    settings.textures.map(async (t) => ({ label: t, bytes: await source.read(joinPath(dir, t)) })),
  );
  const loader = new TextureLoader(gl, { alpha: "premultiplied", ...options });
  try {
    return { loader, textures: await loader.loadSet(files) };
  } catch (e) {
    loader.dispose();
    throw e;
  }
}
