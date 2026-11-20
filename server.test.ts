import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientKey, createApp } from "./server";
import { seal, unlock } from "./web/crypto";

const publicDir = mkdtempSync(join(tmpdir(), "shh-test-"));
writeFileSync(join(publicDir, "index.html"), "<!doctype html><title>shh</title>");
writeFileSync(join(publicDir, "scene.js"), "// scene");
afterAll(() => rmSync(publicDir, { recursive: true, force: true })); // the test runner does not fire "exit" handlers

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

test("two service instances sharing one database honor the same open budget", async () => {
  const dbPath = join(publicDir, "shared.sqlite");
  const first = createApp({ publicDir, dbPath });
  const second = createApp({ publicDir, dbPath });
  const post = (path: string, body: object) => new Request(`http://shh.test${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const created = await first.fetch(post("/api/secrets", { data: "dGVzdA", ttl: 300, auth: AUTH, opens: 2 }));
    const { id } = await created.json() as { id: string };
    const read = (instance: typeof first) => instance.fetch(post(`/api/secrets/${id}/reveal`, { auth: AUTH }));
    const responses = await Promise.all([read(first), read(second), read(first)]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 200, 404]);
    const successful = await Promise.all(responses.filter(r => r.ok).map(r => r.json() as Promise<{ remaining: number }>));
    expect(successful.map(body => body.remaining).sort()).toEqual([0, 1]);
  } finally {
    first.close();
    second.close();
  }
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

// ---- sender controls -----------------------------------------------------
type Status = { state: string; opened: number; opensLeft: number; firstOpenedAt: number | null; lastOpenedAt: number | null; endedAt: number | null; expiresAt: number };
const WRONG = "B".repeat(43);
async function share(overrides: Record<string, unknown> = {}, target = app, ip?: string) {
  const response = await target.fetch(
    new Request("http://shh.test/api/secrets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: "c2VjcmV0", auth: AUTH, ttl: 3600, ...overrides }) }),
    ip ?? "203.0.113.7",
  );
  return (await response.json()) as { id: string; sender: string };
}
const status = async (id: string, sender: string, action = "status") => {
  const response = await call(`/api/secrets/${id}/${action}`, { sender });
  return { code: response.status, body: (await response.json()) as Status };
};
const answer = async (response: Response | Promise<Response>) => {
  const r = await response;
  return { status: r.status, body: await r.text(), headers: [...r.headers].sort() };
};

test("the sender's token reports the status and nothing else", async () => {
  const { id, sender } = await share();
  expect(sender).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(sender).not.toBe(id);
  const waiting = await status(id, sender);
  expect(waiting.code).toBe(200);
  expect(waiting.body).toEqual({ state: "waiting", opened: 0, opensLeft: 1, firstOpenedAt: null, lastOpenedAt: null, endedAt: null, expiresAt: 1_000_000 + 3_600_000 });

  clock += 5_000;
  await call(`/api/secrets/${id}/reveal`, { auth: AUTH });
  clock += 5_000;
  const opened = await status(id, sender);
  expect(opened.body).toEqual({ state: "opened", opened: 1, opensLeft: 0, firstOpenedAt: 1_005_000, lastOpenedAt: 1_005_000, endedAt: 1_005_000, expiresAt: 1_000_000 + 3_600_000 });
  expect(JSON.stringify(opened.body)).not.toContain("c2VjcmV0");

  clock = 1_000_000 + 3_600_000; // the tombstone lasts until the original expiry, no longer
  expect((await status(id, sender)).code).toBe(404);
});

test("the status counts every open of a link that allows several", async () => {
  const { id, sender } = await share({ opens: 3 });
  const seen: Status[] = [];
  for (let i = 0; i < 3; i++) {
    clock += 1_000;
    await call(`/api/secrets/${id}/reveal`, { auth: AUTH });
    seen.push((await status(id, sender)).body);
  }
  expect(seen.map((s) => [s.state, s.opened, s.opensLeft, s.firstOpenedAt, s.lastOpenedAt, s.endedAt])).toEqual([
    ["waiting", 1, 2, 1_001_000, 1_001_000, null],
    ["waiting", 2, 1, 1_001_000, 1_002_000, null],
    ["opened", 3, 0, 1_001_000, 1_003_000, 1_003_000],
  ]);
});

test("the sender can destroy a secret at once, for good, and twice", async () => {
  const { id, sender } = await share({ opens: 3 });
  clock += 1_000;
  await call(`/api/secrets/${id}/reveal`, { auth: AUTH });
  clock += 1_000;
  const destroyed = await status(id, sender, "destroy");
  expect(destroyed.code).toBe(200);
  expect(destroyed.body).toEqual({ state: "destroyed", opened: 1, opensLeft: 0, firstOpenedAt: 1_001_000, lastOpenedAt: 1_001_000, endedAt: 1_002_000, expiresAt: 1_000_000 + 3_600_000 });
  expect((await call(`/api/secrets/${id}/reveal`, { auth: AUTH })).status).toBe(404);
  expect((await call(`/api/secrets/${id}`)).status).toBe(404);

  clock += 1_000;
  expect((await status(id, sender, "destroy")).body).toEqual(destroyed.body); // idempotent
  expect((await status(id, sender)).body).toEqual(destroyed.body);

  const unopened = await share();
  expect((await status(unopened.id, unopened.sender, "destroy")).body).toMatchObject({ state: "destroyed", opened: 0, firstOpenedAt: null });
  expect((await call(`/api/secrets/${unopened.id}/reveal`, { auth: AUTH })).status).toBe(404);

  const read = await share(); // already opened for the last time: nothing left to destroy, the record stays true
  await call(`/api/secrets/${read.id}/reveal`, { auth: AUTH });
  expect((await status(read.id, read.sender, "destroy")).body).toMatchObject({ state: "opened", opened: 1 });
});

test("the status says when wrong passphrases destroyed the secret", async () => {
  const { id, sender } = await share({ opens: 2 });
  await call(`/api/secrets/${id}/reveal`, { auth: AUTH });
  clock += 2_000;
  for (let i = 0; i < 5; i++) await call(`/api/secrets/${id}/reveal`, { auth: WRONG });
  expect((await status(id, sender)).body).toMatchObject({ state: "burned", opened: 1, opensLeft: 0, endedAt: 1_002_000 });
  expect((await status(id, sender, "destroy")).body).toMatchObject({ state: "burned" });
});

test("to a recipient, a tombstone is the same as a secret that never existed", async () => {
  const missing = "A".repeat(22);
  const opened = await share();
  await call(`/api/secrets/${opened.id}/reveal`, { auth: AUTH });
  const destroyed = await share();
  await status(destroyed.id, destroyed.sender, "destroy");
  const burned = await share();
  for (let i = 0; i < 5; i++) await call(`/api/secrets/${burned.id}/reveal`, { auth: WRONG });

  for (const { id, sender } of [opened, destroyed, burned]) {
    expect((await status(id, sender)).code).toBe(200); // the tombstone is there for the sender
    expect(await answer(call(`/api/secrets/${id}`))).toEqual(await answer(call(`/api/secrets/${missing}`)));
    for (const auth of [AUTH, WRONG]) {
      expect(await answer(call(`/api/secrets/${id}/reveal`, { auth }))).toEqual(await answer(call(`/api/secrets/${missing}/reveal`, { auth })));
    }
    expect((await status(id, sender)).body.opened).toBe(id === opened.id ? 1 : 0); // and asking changed nothing
  }
});

test("the two tokens are independent: neither does the other's job", async () => {
  const sealed = await seal("hunter2", "tuesday");
  const { id, sender } = await share({ data: sealed.data, auth: sealed.auth });
  const missing = "A".repeat(22);

  // The access proof, the link key and a guess are all "unknown secret" to the sender endpoints.
  for (const token of [sealed.auth, sealed.linkKey, WRONG]) {
    for (const action of ["status", "destroy"]) {
      expect(await answer(call(`/api/secrets/${id}/${action}`, { sender: token }))).toEqual(await answer(call(`/api/secrets/${missing}/${action}`, { sender: token })));
    }
  }
  // The sender's token is just a wrong passphrase to the recipient endpoint, and no response carries ciphertext.
  const asReader = await call(`/api/secrets/${id}/reveal`, { auth: sender });
  expect(asReader.status).toBe(403);
  for (const action of ["status", "destroy"]) {
    for (const body of [{ sender }, { auth: sealed.auth }, { sender, auth: sealed.auth }]) {
      const text = await (await call(`/api/secrets/${id}/${action}`, body)).text();
      expect(text).not.toContain(sealed.data);
      expect(text).not.toContain("data");
    }
  }
  for (const bad of [{}, { sender: "short" }, { sender: 7 }, { auth: sender }]) expect((await call(`/api/secrets/${id}/status`, bad)).status).toBe(400);
  expect((await call(`/api/secrets/${id}/status`)).status).toBe(405);
  expect((await call(`/api/secrets/${id}/destroy`)).status).toBe(405);
  expect((await call(`/api/secrets/${id}/other`, { sender })).status).toBe(404);
});

test("wrong sender tokens are rate limited and never use up the passphrase attempts", async () => {
  const { id, sender } = await share();
  for (let i = 0; i < 100; i++) {
    const action = i % 2 ? "status" : "destroy";
    expect((await call(`/api/secrets/${id}/${action}`, { sender: WRONG }, "198.51.100.9")).status).toBe(404);
  }
  expect((await status(id, sender)).body).toMatchObject({ state: "waiting", opensLeft: 1 });
  const guess = await call(`/api/secrets/${id}/reveal`, { auth: WRONG });
  expect(await guess.json()).toEqual({ error: "wrong", remaining: 4 }); // all five attempts were still there
  expect((await call(`/api/secrets/${id}/reveal`, { auth: AUTH })).status).toBe(200);

  for (let i = 0; i < 20; i++) await call(`/api/secrets/${id}/status`, { sender: WRONG }, "198.51.100.9");
  expect((await call(`/api/secrets/${id}/status`, { sender: WRONG }, "198.51.100.9")).status).toBe(429);
  expect((await call(`/api/secrets/${id}/destroy`, { sender }, "198.51.100.9")).status).toBe(429);
  expect((await status(id, sender)).code).toBe(200); // someone else is unaffected
});

test("tombstones count toward the limit on stored secrets until they expire", async () => {
  const small = createApp({ publicDir, now: () => clock, maxSecrets: 3 });
  const post = (path: string, body: object, ip: string) =>
    small.fetch(new Request(`http://shh.test${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), ip);
  try {
    const made = await Promise.all([1, 2, 3].map((n) => share({ ttl: 300 }, small, `192.0.2.${n}`)));
    await post(`/api/secrets/${made[0]!.id}/reveal`, { auth: AUTH }, "192.0.2.1");
    await post(`/api/secrets/${made[1]!.id}/destroy`, { sender: made[1]!.sender }, "192.0.2.2");
    for (let i = 0; i < 5; i++) await post(`/api/secrets/${made[2]!.id}/reveal`, { auth: WRONG }, "192.0.2.3");
    const full = await post("/api/secrets", { data: "c2VjcmV0", auth: AUTH, ttl: 300 }, "192.0.2.4");
    expect(full.status).toBe(503); // three tombstones, no live secret, still full
    clock += 300_000;
    expect((await post("/api/secrets", { data: "c2VjcmV0", auth: AUTH, ttl: 300 }, "192.0.2.4")).status).toBe(201);
  } finally {
    small.close();
  }
});

test("expired tombstones are purged with everything else", async () => {
  const dbPath = join(publicDir, "purge.sqlite");
  const filed = createApp({ publicDir, dbPath, now: () => clock });
  const rows = () => {
    const db = new Database(dbPath, { readonly: true });
    const n = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM secrets").get()!.n;
    db.close();
    return n;
  };
  try {
    const short = await share({ ttl: 300 }, filed);
    await share({ ttl: 3600 }, filed);
    await filed.fetch(new Request(`http://shh.test/api/secrets/${short.id}/destroy`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sender: short.sender }) }));
    filed.sweep();
    expect(rows()).toBe(2);
    clock += 300_000;
    filed.sweep();
    expect(rows()).toBe(1);
  } finally {
    filed.close();
  }
});

// The schema exactly as it was before sender controls existed.
const OLD_SCHEMA = `
  CREATE TABLE IF NOT EXISTS secrets (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    auth_hash BLOB NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    opens_left INTEGER NOT NULL DEFAULT 1
  ) STRICT;
`;
const hash = (text: string) => new Uint8Array(createHash("sha256").update(text).digest());

test("a database from before sender controls is migrated in place and its links keep working", async () => {
  const dbPath = join(publicDir, "old.sqlite");
  const old = new Database(dbPath);
  old.exec(`PRAGMA secure_delete = ON; ${OLD_SCHEMA}`);
  const insert = old.query("INSERT INTO secrets (id, data, auth_hash, expires_at, opens_left) VALUES (?, ?, ?, ?, ?)");
  const once = "a".repeat(22), twice = "b".repeat(22), guessed = "c".repeat(22), stale = "d".repeat(22);
  insert.run(once, "b25jZQ", hash(AUTH), clock + 300_000, 1);
  insert.run(twice, "dHdpY2U", hash(AUTH), clock + 300_000, 2);
  insert.run(guessed, "Z3Vlc3NlZA", hash(AUTH), clock + 300_000, 1);
  old.exec(`UPDATE secrets SET attempts = 4 WHERE id = '${guessed}'`);
  insert.run(stale, "c3RhbGU", hash(AUTH), clock - 1, 1);
  old.close();

  let migrated = createApp({ publicDir, dbPath, now: () => clock });
  const post = (path: string, body?: object) =>
    migrated.fetch(new Request(`http://shh.test${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}));
  try {
    // Old links answer as before, and none of them has a sender token.
    expect(await (await post(`/api/secrets/${twice}`)).json()).toEqual({ opens: 2 });
    expect(await (await post(`/api/secrets/${twice}/reveal`, { auth: AUTH })).json()).toEqual({ data: "dHdpY2U", remaining: 1 });
    expect((await post(`/api/secrets/${stale}`)).status).toBe(404);
    const unknown = await answer(post(`/api/secrets/${"z".repeat(22)}/status`, { sender: WRONG }));
    for (const id of [once, twice, guessed, stale]) {
      expect(await answer(post(`/api/secrets/${id}/status`, { sender: WRONG }))).toEqual(unknown);
      expect((await post(`/api/secrets/${id}/destroy`, { sender: "A".repeat(43) })).status).toBe(404);
    }

    // Starting again on the migrated file changes nothing.
    migrated.close();
    migrated = createApp({ publicDir, dbPath, now: () => clock });
    expect(await (await post(`/api/secrets/${twice}/reveal`, { auth: AUTH })).json()).toEqual({ data: "dHdpY2U", remaining: 0 });
    expect((await post(`/api/secrets/${twice}/reveal`, { auth: AUTH })).status).toBe(404);
    expect(await (await post(`/api/secrets/${once}/reveal`, { auth: AUTH })).json()).toEqual({ data: "b25jZQ", remaining: 0 });
    expect(await (await post(`/api/secrets/${guessed}/reveal`, { auth: WRONG })).json()).toEqual({ error: "wrong", remaining: 0 });
    expect((await post(`/api/secrets/${guessed}/reveal`, { auth: AUTH })).status).toBe(404);

    // New secrets in the same file get sender controls.
    const fresh = await share({}, migrated);
    await post(`/api/secrets/${fresh.id}/reveal`, { auth: AUTH });
    expect(await (await post(`/api/secrets/${fresh.id}/status`, { sender: fresh.sender })).json()).toMatchObject({ state: "opened", opened: 1 });

    // Old secrets leave no tombstone; an older server reading this file sees the new tombstone as expired
    // and can still write to the table.
    const peek = new Database(dbPath);
    expect(peek.query<{ id: string }, []>("SELECT id FROM secrets").all().map((row) => row.id)).toEqual([fresh.id]);
    expect(peek.query("SELECT data, auth_hash, attempts, opens_left FROM secrets WHERE id = ? AND expires_at > ?").get(fresh.id, clock)).toBeNull();
    peek.query("INSERT INTO secrets (id, data, auth_hash, expires_at, opens_left) VALUES (?, ?, ?, ?, ?)").run("e".repeat(22), "b2xk", hash(AUTH), clock + 300_000, 1);
    peek.close();
    expect(await (await post(`/api/secrets/${"e".repeat(22)}/reveal`, { auth: AUTH })).json()).toEqual({ data: "b2xk", remaining: 0 });
  } finally {
    migrated.close();
  }
});

test("wiping removes the ciphertext from the database file, and the sender's token was never in it", async () => {
  const dir = mkdtempSync(join(publicDir, "wipe-"));
  const dbPath = join(dir, "db.sqlite");
  const filed = createApp({ publicDir, dbPath, now: () => clock });
  const post = (path: string, body: object) =>
    filed.fetch(new Request(`http://shh.test${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  // Every file SQLite keeps next to the database (journal, write-ahead log) is searched too.
  const filesWith = (needle: string) => readdirSync(dir).filter((name) => readFileSync(join(dir, name)).includes(needle));
  // A long value is split across overflow pages, so look for short windows of it, not the whole string.
  const windows = (data: string) => [0, 0.25, 0.5, 0.75].map((at) => data.slice(Math.floor(at * (data.length - 48)), Math.floor(at * (data.length - 48)) + 48)).concat(data.slice(-48));
  const ends: Record<string, (made: { id: string; sender: string }) => Promise<unknown>> = {
    "the last open": ({ id }) => post(`/api/secrets/${id}/reveal`, { auth: AUTH }),
    "a destroy": ({ id, sender }) => post(`/api/secrets/${id}/destroy`, { sender }),
    "too many wrong passphrases": async ({ id }) => {
      for (let i = 0; i < 5; i++) await post(`/api/secrets/${id}/reveal`, { auth: WRONG });
    },
  };
  try {
    for (const size of [384, 24_000]) { // one that fits in a page, one that needs overflow pages
      for (const [name, end] of Object.entries(ends)) {
        const data = randomBytes(size).toString("base64url").slice(0, size);
        await share({ data: "bmVpZ2hib3Vy" }, filed); // neighbours, so the row is not alone on its page
        const made = await share({ data }, filed);
        await share({ data: "bmVpZ2hib3Vy" }, filed);
        for (const window of windows(data)) expect(filesWith(window)).toEqual(["db.sqlite"]); // the search does find it while it is stored
        expect(filesWith(made.sender)).toEqual([]);

        await end(made);
        for (const window of windows(data)) expect([name, size, filesWith(window)]).toEqual([name, size, []]);
        expect(await (await post(`/api/secrets/${made.id}/status`, { sender: made.sender })).json()).toMatchObject({ state: expect.stringMatching(/opened|destroyed|burned/) });
      }
    }
    expect(readdirSync(dir)).toEqual(["db.sqlite"]); // no journal or write-ahead file is left behind
  } finally {
    filed.close();
  }
});

test("a database left in write-ahead mode is switched back, so wiped ciphertext does not linger in the log", async () => {
  const dir = mkdtempSync(join(publicDir, "wal-"));
  const dbPath = join(dir, "db.sqlite");
  const wal = new Database(dbPath);
  wal.exec(`PRAGMA journal_mode = WAL; ${OLD_SCHEMA}`);
  wal.close();
  const filed = createApp({ publicDir, dbPath, now: () => clock });
  try {
    const data = randomBytes(600).toString("base64url");
    const made = await share({ data }, filed);
    await filed.fetch(new Request(`http://shh.test/api/secrets/${made.id}/reveal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ auth: AUTH }) }));
    expect(readdirSync(dir).filter((name) => readFileSync(join(dir, name)).includes(data.slice(100, 148)))).toEqual([]);
    expect(readdirSync(dir)).not.toContain("db.sqlite-wal"); // an empty index file may stay; the log itself is gone
    const peek = new Database(dbPath, { readonly: true });
    expect(peek.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    peek.close();
  } finally {
    filed.close();
  }
});

test("two service instances agree on the status, and a destroy on one stops reads on the other", async () => {
  const dbPath = join(publicDir, "shared-sender.sqlite");
  const first = createApp({ publicDir, dbPath, now: () => clock });
  const second = createApp({ publicDir, dbPath, now: () => clock });
  const post = (instance: typeof first, path: string, body: object) =>
    instance.fetch(new Request(`http://shh.test${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  try {
    const { id, sender } = await share({ opens: 4 }, first);
    const responses = await Promise.all([
      post(first, `/api/secrets/${id}/reveal`, { auth: AUTH }),
      post(second, `/api/secrets/${id}/reveal`, { auth: AUTH }),
      post(second, `/api/secrets/${id}/destroy`, { sender }),
      post(first, `/api/secrets/${id}/reveal`, { auth: AUTH }),
      post(first, `/api/secrets/${id}/destroy`, { sender }),
    ]);
    const reads = responses.filter((r, i) => [0, 1, 3].includes(i) && r.ok).length;
    const final = (await (await post(first, `/api/secrets/${id}/status`, { sender })).json()) as Status;
    expect(final).toMatchObject({ state: "destroyed", opened: reads, opensLeft: 0 });
    expect((await (await post(second, `/api/secrets/${id}/status`, { sender })).json())).toEqual(final);
    expect((await post(second, `/api/secrets/${id}/reveal`, { auth: AUTH })).status).toBe(404);
  } finally {
    first.close();
    second.close();
  }
});
