import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../server";
import { build, render, verify } from "./verify-live";

const dist = join(import.meta.dir, "../dist");
const snapshot = () => (existsSync(dist) ? readdirSync(dist).map((name) => `${name} ${statSync(join(dist, name)).mtimeMs}`).join("\n") : "absent");
const before = snapshot();

let dir: string; // a fresh build, made the way the script makes it
let tampered: string; // the same build with one byte of app.js changed and one font missing
const servers: Array<{ stop(force: boolean): Promise<void> }> = [];
const seen: Array<{ method: string; path: string; query: string; body: boolean }> = [];

function serve(publicDir: string, extra: Record<string, string> = {}): string {
  const app = createApp({ publicDir });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({ method: req.method, path: url.pathname, query: url.search, body: (await req.clone().arrayBuffer()).byteLength > 0 });
      const response = await app.fetch(req);
      for (const [name, value] of Object.entries(extra)) response.headers.set(name, value);
      return response;
    },
  });
  servers.push({ stop: async (force) => (await server.stop(force), app.close()) });
  return `http://127.0.0.1:${server.port}`;
}

beforeAll(async () => {
  dir = await build();
  tampered = join(dir, "../tampered");
  cpSync(dir, tampered, { recursive: true });
  writeFileSync(join(tampered, "app.js"), `${await Bun.file(join(dir, "app.js")).text()} `);
  rmSync(join(tampered, "vt323.woff2"));
});
afterAll(async () => {
  for (const server of servers) await server.stop(true);
  rmSync(join(dir, ".."), { recursive: true, force: true });
});

test("a site serving this build matches file for file, using only plain GET requests", async () => {
  const base = serve(dir);
  const report = await verify(dir, base);
  expect(report.ok).toBe(true);
  expect(report.files.map((file) => file.path)).toEqual(["/", "/app.js", "/favicon.svg", "/jersey-15.woff2", "/jetbrains-mono.woff2", "/scene.js", "/stars.svg", "/style.css", "/vt323.woff2"]);
  for (const file of report.files) expect(file.served).toBe(file.built);
  expect(report.headers.map((header) => header.name)).toContain("content-security-policy");
  for (const header of report.headers) expect(header.received).toBe(header.expected);
  expect(report.intermediaries).toEqual([]);

  const text = render(report, base);
  expect(text).toContain("All 9 files match");
  expect(text).toContain("No proxy or CDN announced itself");
  expect(text).not.toContain("DIFFER");

  expect(seen.length).toBe(9);
  for (const request of seen) expect([request.method, request.query, request.body]).toEqual(["GET", "", false]);
  expect(seen.some((request) => request.path.startsWith("/api"))).toBe(false);
});

test("one changed byte, a missing file, a weakened header and a proxy are all reported", async () => {
  const base = serve(tampered, { "content-security-policy": "default-src *", server: "cloudflare", via: "1.1 Caddy" });
  const report = await verify(dir, base);
  expect(report.ok).toBe(false);
  const differing = report.files.filter((file) => file.served !== file.built);
  expect(differing.map((file) => [file.path, file.note])).toEqual([["/app.js", ""], ["/vt323.woff2", "HTTP 404"]]);
  expect(report.headers.find((header) => header.name === "content-security-policy")).toMatchObject({ received: "default-src *" });
  expect(report.intermediaries).toEqual([{ name: "server", value: "cloudflare" }, { name: "via", value: "1.1 Caddy" }]);

  const text = render(report, base);
  expect(text).toMatch(/\/app\.js +DIFFER/);
  expect(text).toMatch(/\/style\.css +match/);
  expect(text).toContain("content-security-policy: DIFFERENT: default-src *");
  expect(text).toContain("via: 1.1 Caddy");
  expect(text).toContain("2 of 9 files differ");
});

test("a site that does not answer is a mismatch, not a pass", async () => {
  const report = await verify(dir, "http://127.0.0.1:1"); // nothing listens there
  expect(report.ok).toBe(false);
  expect(report.files.every((file) => file.served === null && file.note === "no answer")).toBe(true);
});

test("the build is reproducible, and verifying leaves dist/ alone", async () => {
  const second = await build();
  try {
    const hashes = async (from: string) => Object.fromEntries(await Promise.all(readdirSync(from).sort().map(async (name) => [name, Bun.hash(await Bun.file(join(from, name)).bytes()).toString(16)])));
    expect(await hashes(second)).toEqual(await hashes(dir)); // two builds in two different directories, byte for byte
  } finally {
    rmSync(join(second, ".."), { recursive: true, force: true });
  }
  expect(snapshot()).toBe(before);
});
