// Checks that a site serves exactly the files this checkout builds.
//
//   bun scripts/verify-live.ts [base URL]      default: https://shh.purecode.sh
//
// It builds into a temporary directory (dist/ is not touched), fetches every built
// file from the site with a plain GET, and compares SHA-256 hashes. Exit code 0 means
// every file matched. The comparison is only valid for the same commit, the locked
// dependencies and the pinned Bun version: see "Verify the live site" in the README.
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server";

const root = join(import.meta.dir, "..");
const DEFAULT_URL = "https://shh.purecode.sh";
// Headers a proxy or CDN adds on the way. The Bun server sends none of them.
const INTERMEDIARY = ["server", "via", "x-cache", "x-served-by", "cf-ray", "cf-cache-status", "x-amz-cf-id", "x-vercel-id", "x-nf-request-id", "fly-request-id", "x-azure-ref"];

export type Report = {
  files: Array<{ path: string; built: string; served: string | null; note: string }>;
  headers: Array<{ name: string; expected: string; received: string | null }>;
  intermediaries: Array<{ name: string; value: string }>;
  ok: boolean;
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Builds this checkout into a new temporary directory and returns its path. */
export async function build(): Promise<string> {
  const out = join(mkdtempSync(join(tmpdir(), "shh-verify-")), "dist");
  const child = Bun.spawn([process.execPath, join(root, "build.ts"), out], { cwd: root, stdout: "ignore", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error("build failed");
  return out;
}

/** Compares every file in `dir` with what `base` serves. Only plain GET requests are made. */
export async function verify(dir: string, base: string, get: (url: string) => Promise<Response> = (url) => fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) })): Promise<Report> {
  // The same server code, serving the same build in this process, says which headers to expect.
  const local = createApp({ publicDir: dir });
  const report: Report = { files: [], headers: [], intermediaries: [], ok: true };
  try {
    for (const name of readdirSync(dir).sort()) {
      const path = name === "index.html" ? "/" : `/${name}`;
      const built = sha256(readFileSync(join(dir, name)));
      const expected = await local.fetch(new Request(`http://local${path}`));
      if (expected.status !== 200) continue; // not a file the server would serve
      let served: string | null = null;
      let note = "";
      try {
        const response = await get(`${base}${path}`);
        if (response.status === 200) served = sha256(new Uint8Array(await response.arrayBuffer()));
        else note = `HTTP ${response.status}`;
        if (path === "/") {
          for (const [header, value] of expected.headers) {
            if (!["content-type", "cache-control", "etag", "content-length", "date"].includes(header)) report.headers.push({ name: header, expected: value, received: response.headers.get(header) });
          }
          for (const header of INTERMEDIARY) {
            const value = response.headers.get(header);
            if (value) report.intermediaries.push({ name: header, value });
          }
        }
      } catch {
        note = "no answer";
      }
      report.files.push({ path, built, served, note });
      if (served !== built) report.ok = false;
    }
  } finally {
    local.close();
  }
  report.files.sort((a, b) => (a.path < b.path ? -1 : 1));
  if (report.files.length === 0) report.ok = false;
  return report;
}

export function render(report: Report, base: string): string {
  const short = (hash: string | null) => (hash ? hash.slice(0, 12) : "-");
  const width = Math.max(...report.files.map((file) => file.path.length), 4);
  const lines = [`${"file".padEnd(width)}  result  built         served`];
  for (const file of report.files) {
    const result = file.served === file.built ? "match " : "DIFFER";
    lines.push(`${file.path.padEnd(width)}  ${result}  ${short(file.built)}  ${short(file.served)}${file.note ? `  (${file.note})` : ""}`);
  }
  lines.push("", `Security headers received with ${base}/ (information only):`);
  for (const header of report.headers) {
    const verdict = header.received === null ? "MISSING" : header.received === header.expected ? "as this repository's server sends it" : `DIFFERENT: ${header.received}`;
    lines.push(`  ${header.name}: ${verdict}`);
  }
  if (report.headers.length === 0) lines.push("  none could be read");
  lines.push("", "Intermediaries (information only):");
  for (const header of report.intermediaries) lines.push(`  ${header.name}: ${header.value}`);
  lines.push(
    report.intermediaries.length
      ? "  The shh server sends none of these headers, so the answer came through at least one proxy or CDN. Whoever runs it can change the page."
      : "  No proxy or CDN announced itself in the headers. One that stays silent cannot be detected this way.",
  );
  const differing = report.files.filter((file) => file.served !== file.built).length;
  lines.push("", report.ok ? `All ${report.files.length} files match: the site serves what this checkout builds.` : `${differing} of ${report.files.length} files differ: the site is NOT serving what this checkout builds.`);
  return lines.join("\n");
}

if (import.meta.main) {
  let base: string;
  try {
    const url = new URL(process.argv[2] ?? DEFAULT_URL);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("scheme");
    base = url.origin;
  } catch {
    console.error("Usage: bun scripts/verify-live.ts [base URL]");
    process.exit(2);
  }
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stderr: "ignore" });
    return result.exitCode === 0 ? result.stdout.toString().trim() : null;
  };
  const commit = git("rev-parse", "--short", "HEAD");
  const changes = git("status", "--porcelain");
  const pinned = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { packageManager?: string }).packageManager?.replace("bun@", "");
  console.log(`Comparing ${base} with a build of this checkout`);
  console.log(`  commit: ${commit ?? "unknown"}${changes ? " plus uncommitted changes" : ""}`);
  console.log(`  Bun: ${Bun.version}${pinned && pinned !== Bun.version ? ` (the repository pins ${pinned}: a different bundler version can produce different bytes, so a mismatch may only mean that)` : ""}`);
  console.log("");

  const dir = await build();
  try {
    const report = await verify(dir, base);
    console.log(render(report, base));
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
}
