import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientKey, createApp } from "./server";
import { seal, unlock } from "./web/crypto";

const publicDir = mkdtempSync(join(tmpdir(), "shh-test-"));
writeFileSync(join(publicDir, "index.html"), "<!doctype html><title>shh</title>");
writeFileSync(join(publicDir, "scene.js"), "// scene");
process.on("exit", () => rmSync(publicDir, { recursive: true, force: true }));

let clock = 1_000_000;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  clock = 1_000_000;
  app = createApp({ publicDir, now: () => clock });
});
afterEach(() => app.close());

const AUTH = "A".repeat(43);
const call = (path: string, body?: unknown, ip = "203.0.113.7", headers: Record<string, string> = {}) =>
  app.fetch(
    new Request(`http://shh.test${path}`, body === undefined ? { headers } : { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }),
    ip,
  );
async function create(overrides: Record<string, unknown> = {}, ip?: string) {
  const response = await call("/api/secrets", { data: "c2VjcmV0", auth: AUTH, ttl: 3600, ...overrides }, ip);
  return { response, id: ((await response.json()) as { id?: string }).id! };
}

test("a secret can be read exactly once", async () => {
  const { response, id } = await create();
  expect(response.status).toBe(201);
  expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  const waiting = await call(`/api/secrets/${id}`);
  expect(waiting.status).toBe(200);
  expect(await waiting.json()).toEqual({ opens: 1 });

  const first = await call(`/api/secrets/${id}/reveal`, { auth: AUTH });
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ data: "c2VjcmV0", remaining: 0 });

  expect((await call(`/api/secrets/${id}/reveal`, { auth: AUTH })).status).toBe(404);
  expect((await call(`/api/secrets/${id}`)).status).toBe(404);
});

test("a link can allow several opens, and no more", async () => {
  const { id } = await create({ opens: 3 });
  for (const remaining of [2, 1, 0]) {
    expect(await (await call(`/api/secrets/${id}`)).json()).toEqual({ opens: remaining + 1 });
    const response = await call(`/api/secrets/${id}/reveal`, { auth: AUTH });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: "c2VjcmV0", remaining });
  }
  expect((await call(`/api/secrets/${id}/reveal`, { auth: AUTH })).status).toBe(404);
});

test("a multi-open link still expires and still dies after too many wrong passphrases", async () => {
  const guessed = await create({ opens: 5 });
  await call(`/api/secrets/${guessed.id}/reveal`, { auth: AUTH });
  for (let i = 0; i < 5; i++) await call(`/api/secrets/${guessed.id}/reveal`, { auth: "B".repeat(43) });
  expect((await call(`/api/secrets/${guessed.id}/reveal`, { auth: AUTH })).status).toBe(404);

  const expired = await create({ opens: 5, ttl: 300 });
  await call(`/api/secrets/${expired.id}/reveal`, { auth: AUTH });
  clock += 300_000;
  expect((await call(`/api/secrets/${expired.id}/reveal`, { auth: AUTH })).status).toBe(404);
});

test("the full browser flow round-trips through the server", async () => {
  const sealed = await seal("hunter2", "tuesday");
  const { id } = await create({ data: sealed.data, auth: sealed.auth });
  const keys = await unlock(sealed.linkKey, "tuesday");
  const revealed = (await (await call(`/api/secrets/${id}/reveal`, { auth: keys.auth })).json()) as { data: string };
  expect(await keys.open(revealed.data)).toBe("hunter2");
});

test("wrong passphrases are counted, then the secret is destroyed", async () => {
  const { id } = await create();
  const wrong = { auth: "B".repeat(43) };
  for (const remaining of [4, 3, 2, 1, 0]) {
    const response = await call(`/api/secrets/${id}/reveal`, wrong);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "wrong", remaining });
  }
  expect((await call(`/api/secrets/${id}/reveal`, { auth: AUTH })).status).toBe(404);
});

test("a wrong guess does not burn the secret for the real reader", async () => {
  const { id } = await create();
  await call(`/api/secrets/${id}/reveal`, { auth: "B".repeat(43) });
  expect((await call(`/api/secrets/${id}/reveal`, { auth: AUTH })).status).toBe(200);
});

test("unopened secrets expire", async () => {
  const { id } = await create({ ttl: 300 });
  clock += 299_000;
  expect((await call(`/api/secrets/${id}`)).status).toBe(200);
  clock += 1_000;
  expect((await call(`/api/secrets/${id}`)).status).toBe(404);
  expect((await call(`/api/secrets/${id}/reveal`, { auth: AUTH })).status).toBe(404);
});

test("bad input is rejected", async () => {
  for (const bad of [{ ttl: 1 }, { ttl: "3600" }, { data: "" }, { data: "not base64!" }, { data: "a".repeat(24_001) }, { auth: "short" }, { opens: 0 }, { opens: 11 }, { opens: 1.5 }, { opens: "2" }]) {
    expect((await create(bad)).response.status).toBe(400);
  }
  const form = await app.fetch(new Request("http://shh.test/api/secrets", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ data: "c2VjcmV0", auth: AUTH, ttl: 3600 }) }));
  expect(form.status).toBe(400); // other sites can only send "simple" content types
  expect((await call("/api/secrets/not-an-id")).status).toBe(404);
  expect((await call("/api/secrets")).status).toBe(405);
});

test("creating secrets is rate limited per client", async () => {
  for (let i = 0; i < 30; i++) expect((await create()).response.status).toBe(201);
  expect((await create()).response.status).toBe(429);
  expect((await create({}, "198.51.100.9")).response.status).toBe(201); // someone else is unaffected
  clock += 3_600_001;
  expect((await create()).response.status).toBe(201);
});

test("the proxy's client address is only trusted when configured", async () => {
  const proxied = createApp({ publicDir, now: () => clock, trustProxy: true });
  const send = (target: typeof app, forwarded: string) =>
    target.fetch(new Request("http://shh.test/api/secrets", { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": forwarded }, body: JSON.stringify({ data: "c2VjcmV0", auth: AUTH, ttl: 3600 }) }), "10.0.0.2");
  for (let i = 0; i < 30; i++) await send(proxied, "203.0.113.7");
  expect((await send(proxied, "203.0.113.7")).status).toBe(429);
  expect((await send(proxied, "spoofed, 198.51.100.9")).status).toBe(201); // last hop wins, set by Caddy
  proxied.close();

  for (let i = 0; i < 30; i++) await send(app, `192.0.2.${i}`);
  expect((await send(app, "192.0.2.99")).status).toBe(429); // header ignored: all one client
});

test("pages carry strict security headers and the worker has no network", async () => {
  const page = await call("/");
  expect(page.status).toBe(200);
  const csp = page.headers.get("content-security-policy")!;
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toContain("unsafe");
  expect(page.headers.get("referrer-policy")).toBe("no-referrer");
  expect(page.headers.get("x-content-type-options")).toBe("nosniff");
  expect(page.headers.get("strict-transport-security")).toContain("max-age=");

  expect((await call("/scene.js")).headers.get("content-security-policy")).toBe("default-src 'none'");
  expect((await create()).response.headers.get("cache-control")).toBe("no-store");

  const cached = await call("/", undefined, undefined, { "If-None-Match": page.headers.get("etag")! });
  expect(cached.status).toBe(304);
  expect((await call("/../server.ts")).status).toBe(404);
  expect((await call("/health")).status).toBe(200);
});

test("rate-limit keys group an IPv6 customer, not a single address", () => {
  expect(clientKey("203.0.113.7")).toBe("203.0.113.7");
  expect(clientKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
  expect(clientKey("2001:db8:12:3400::1")).toBe(clientKey("2001:0db8:0012:3400:ffff:ffff:ffff:ffff"));
  expect(clientKey("2001:db8:12:3400::1")).not.toBe(clientKey("2001:db8:12:3401::1"));
  expect(clientKey("::1")).toBe("0:0:0:0");
});
