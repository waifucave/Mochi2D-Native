/**
 * The agent docs: the client configurations in docs/agent-api.md parse and
 * start the built server, llms.txt follows the llms.txt layout, and the
 * public docs do not link into cleanroom/ (the public copy ships without it).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(__dirname, "..");
const agentDoc = readFileSync(join(root, "docs", "agent-api.md"), "utf8");

/** The fenced code blocks of a Markdown text with the given language. */
function blocks(markdown: string, lang: string): string[] {
  const out: string[] = [];
  const re = new RegExp("^```" + lang + "\\n([\\s\\S]*?)^```$", "gm");
  for (let m = re.exec(markdown); m; m = re.exec(markdown)) out.push(m[1]!);
  return out;
}

describe("the agent docs", () => {
  it("hold client configurations that start the MCP server", () => {
    const configs = blocks(agentDoc, "json").map(
      (b) =>
        JSON.parse(b) as Record<
          string,
          Record<string, { command: string; args: string[]; type?: string }>
        >,
    );
    expect(configs.length).toBeGreaterThanOrEqual(4);
    for (const c of configs) {
      const servers = c.mcpServers ?? c.servers;
      expect(servers, JSON.stringify(c)).toBeDefined();
      const s = servers!.mochi2d!;
      expect(s.command).toBe("node");
      expect(s.args[0]).toBe("/path/to/Mochi2D/dist/tools/mochi2d-mcp.js");
      expect(s.args.slice(1).every((a, i) => (i % 2 === 0 ? a === "--root" : true))).toBe(true);
    }
    const toml = blocks(agentDoc, "toml");
    expect(toml).toHaveLength(1);
    expect(toml[0]).toContain('args = ["/path/to/Mochi2D/dist/tools/mochi2d-mcp.js", "--root"');
    for (const sh of blocks(agentDoc, "sh"))
      for (const line of sh.split("\n").filter((l) => /^(npx|node|claude) /.test(l)))
        expect(line, line).not.toMatch(/npx (?!--no-install|mochi2d|playwright|@model)/);
  });

  it("have an llms.txt in the llms.txt layout", () => {
    const llms = readFileSync(join(root, "llms.txt"), "utf8");
    const lines = llms.split("\n");
    expect(lines[0]).toBe("# Mochi2D");
    expect(lines[2]).toMatch(
      /^> Mochi2D is an open-source runtime for models made with Live2D Cubism/,
    );
    expect(llms).toMatch(/\n## Docs\n\n(- \[[^\]]+\]\([^)]+\): .+\n)+/);
    for (const [, target] of llms.matchAll(/\]\(([^)]+)\)/g))
      expect(() => readFileSync(join(root, target!)), target).not.toThrow();
    for (const tool of agentDoc.matchAll(/^\| `([a-z_0-9]+)` \|/gm))
      expect(llms, tool[1]).toContain(`\`${tool[1]}\``);
  });

  it("do not link into cleanroom/", () => {
    const files = [
      "README.md",
      "llms.txt",
      ...readdirSync(join(root, "docs")).map((f) => join("docs", f)),
    ];
    for (const f of files)
      expect(readFileSync(join(root, f), "utf8"), f).not.toMatch(/cleanroom\/(inbox|reports)/);
  });
});
