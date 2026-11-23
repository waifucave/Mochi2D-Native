/**
 * The render harness's model files, from the local server that opened the
 * page: like `HttpFileSource`, but a read the server refused (a file past a
 * cap, a path not allowed, a damaged zip entry) throws the server's own typed
 * error, which it sends in a response header, instead of "not found".
 */
import { FileNotFoundError, normalizePath, type FileSource } from "../core/io/file-source.js";
import { FileBudget, readResponse } from "../core/io/file-limits.js";
import { ERROR_HEADER, wireErrorFromHeader } from "../platform/wire-errors.js";

export class ServedFileSource implements FileSource {
  private readonly budget = new FileBudget();
  constructor(
    readonly baseUrl: string,
    readonly label: string,
  ) {}
  list(): undefined {
    return undefined;
  }
  async read(path: string): Promise<Uint8Array> {
    const key = normalizePath(path);
    const url = new URL(key.split("/").map(encodeURIComponent).join("/"), this.baseUrl);
    const res = await fetch(url);
    const refused = wireErrorFromHeader(res.headers.get(ERROR_HEADER));
    if (refused) {
      await res.body?.cancel().catch(() => {});
      throw refused;
    }
    if (res.status === 404) throw new FileNotFoundError(path, this.label);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return readResponse(res, key, this.budget);
  }
}
