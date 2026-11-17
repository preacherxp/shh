// shh: one-time secret links. The server only ever stores ciphertext; the key
// lives in the URL fragment and never reaches it. No runtime dependencies.
import { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

const TTLS = new Set([300, 3600, 86_400, 604_800]); // seconds
const MAX_DATA = 24_000; // base64url chars; fits a padded 16 KiB secret
const MAX_BODY = 32 * 1024;
const MAX_SECRETS = 10_000; // disk-fill backstop
const MAX_ATTEMPTS = 5; // wrong passphrases before the secret is destroyed
const MAX_OPENS = 10; // how many times the sender may allow a link to be opened
const ID = /^[A-Za-z0-9_-]{22}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const DATA = /^[A-Za-z0-9_-]+$/;

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types shh",
  "Strict-Transport-Security": "max-age=63072000",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "X-Robots-Tag": "noindex, nofollow",
};
// The three.js worker only draws. Its own policy takes away all network access.
const WORKER_CSP = "default-src 'none'";
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

type Asset = { body: Uint8Array<ArrayBuffer>; type: string; etag: string };

function loadAssets(dir: string): Map<string, Asset> {
  const assets = new Map<string, Asset>();
  for (const name of readdirSync(dir)) {
    const type = TYPES[extname(name)];
    if (!type) continue;
    const body = new Uint8Array(readFileSync(join(dir, name)));
    const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 22)}"`;
    assets.set(name === "index.html" ? "/" : `/${name}`, { body, type, etag });
  }
  return assets;
}

/** Rate-limit key: the IPv4 address, or the /64 for IPv6 (one customer, not one address). */
export function clientKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back] : front;
  return groups.slice(0, 4).map((group) => parseInt(group, 16).toString(16)).join(":");
}

function limiter(max: number, windowMs: number) {
  const hits = new Map<string, { count: number; reset: number }>();
  return {
    allow(key: string, now: number): boolean {
      const hit = hits.get(key);
      if (!hit || hit.reset <= now) {
        hits.set(key, { count: 1, reset: now + windowMs });
        return true;
      }
      return ++hit.count <= max;
    },
    sweep(now: number) {
      for (const [key, hit] of hits) if (hit.reset <= now) hits.delete(key);
    },
  };
}

const sha256 = (text: string) => new Uint8Array(createHash("sha256").update(text).digest());

export function createApp(options: { dbPath?: string; publicDir?: string; now?: () => number; trustProxy?: boolean } = {}) {
  const now = options.now ?? Date.now;
  const assets = loadAssets(options.publicDir ?? join(import.meta.dir, "dist"));
  const db = new Database(options.dbPath ?? ":memory:");
  db.exec(`
    PRAGMA secure_delete = ON;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS secrets (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      auth_hash BLOB NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      opens_left INTEGER NOT NULL DEFAULT 1
    ) STRICT;
  `);
  const sql = {
    count: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM secrets"),
    insert: db.query("INSERT INTO secrets (id, data, auth_hash, expires_at, opens_left) VALUES (?, ?, ?, ?, ?)"),
    find: db.query<{ data: string; auth_hash: Uint8Array; attempts: number; opens_left: number }, [string, number]>(
      "SELECT data, auth_hash, attempts, opens_left FROM secrets WHERE id = ? AND expires_at > ?",
    ),
    take: db.query("DELETE FROM secrets WHERE id = ?"),
    open: db.query("UPDATE secrets SET opens_left = opens_left - 1 WHERE id = ?"),
    fail: db.query("UPDATE secrets SET attempts = attempts + 1 WHERE id = ?"),
    purge: db.query("DELETE FROM secrets WHERE expires_at <= ?"),
  };

  const apiLimit = limiter(120, 60_000);
  const createLimit = limiter(30, 3_600_000);

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...SECURITY_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
  const text = (status: number, body: string) =>
    new Response(body, { status, headers: { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

  async function readJson(req: Request): Promise<Record<string, unknown> | null> {
    // Requiring JSON forces a CORS preflight, so other sites cannot post here.
    if (!req.headers.get("content-type")?.startsWith("application/json")) return null;
    const body = await req.text();
    if (body.length > MAX_BODY) return null;
    try {
      const parsed: unknown = JSON.parse(body);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  async function create(req: Request, key: string): Promise<Response> {
    const body = await readJson(req);
    if (!body) return json(400, { error: "invalid" });
    const { data, auth, ttl, opens = 1 } = body;
    if (typeof data !== "string" || data.length > MAX_DATA || !DATA.test(data)) return json(400, { error: "invalid" });
    if (typeof auth !== "string" || !TOKEN.test(auth)) return json(400, { error: "invalid" });
    if (typeof ttl !== "number" || !TTLS.has(ttl)) return json(400, { error: "invalid" });
    if (typeof opens !== "number" || !Number.isInteger(opens) || opens < 1 || opens > MAX_OPENS) return json(400, { error: "invalid" });
    if (!createLimit.allow(key, now())) return json(429, { error: "slow-down" });
    sql.purge.run(now());
    if (sql.count.get()!.n >= MAX_SECRETS) return json(503, { error: "full" });
    const id = randomBytes(16).toString("base64url");
    sql.insert.run(id, data, sha256(auth), now() + ttl * 1000, opens);
    return json(201, { id });
  }

  // Take the write lock before checking the counter, including across Bun processes.
  const consume = db.transaction((id: string, given: Uint8Array) => {
    const row = sql.find.get(id, now());
    if (!row) return json(404, { error: "gone" });
    if (timingSafeEqual(given, row.auth_hash)) {
      if (row.opens_left <= 1) sql.take.run(id);
      else sql.open.run(id);
      return json(200, { data: row.data, remaining: Math.max(0, row.opens_left - 1) });
    }
    const remaining = MAX_ATTEMPTS - row.attempts - 1;
    if (remaining <= 0) sql.take.run(id);
    else sql.fail.run(id);
    return json(403, { error: "wrong", remaining: Math.max(0, remaining) });
  });

  async function reveal(req: Request, id: string): Promise<Response> {
    const body = await readJson(req);
    if (!body || typeof body.auth !== "string" || !TOKEN.test(body.auth)) return json(400, { error: "invalid" });
    return consume.immediate(id, sha256(body.auth));
  }

  async function fetch(req: Request, ip = "unknown"): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === "/health") return text(200, "ok");

    if (pathname.startsWith("/api/")) {
      const forwarded = options.trustProxy ? req.headers.get("x-forwarded-for")?.split(",").pop()?.trim() : undefined;
      const key = clientKey(forwarded || ip);
      if (!apiLimit.allow(key, now())) return json(429, { error: "slow-down" });
      if (pathname === "/api/secrets") return req.method === "POST" ? create(req, key) : json(405, { error: "method" });
      const match = /^\/api\/secrets\/([^/]+)(\/reveal)?$/.exec(pathname);
      if (!match || !ID.test(match[1]!)) return json(404, { error: "gone" });
      if (match[2]) return req.method === "POST" ? reveal(req, match[1]!) : json(405, { error: "method" });
      if (req.method !== "GET") return json(405, { error: "method" });
      const waiting = sql.find.get(match[1]!, now());
      return waiting ? json(200, { opens: waiting.opens_left }) : json(404, { error: "gone" });
    }

    if (req.method !== "GET" && req.method !== "HEAD") return text(405, "Method not allowed");
    const asset = assets.get(pathname);
    if (!asset) return text(404, "Not found");
    const headers: Record<string, string> = { ...SECURITY_HEADERS, "Content-Type": asset.type, "Cache-Control": "no-cache", ETag: asset.etag };
    if (pathname === "/scene.js") headers["Content-Security-Policy"] = WORKER_CSP;
    if (req.headers.get("if-none-match") === asset.etag) return new Response(null, { status: 304, headers });
    return new Response(req.method === "HEAD" ? null : asset.body, { headers });
  }

  return {
    fetch,
    sweep() {
      sql.purge.run(now());
      apiLimit.sweep(now());
      createLimit.sweep(now());
    },
    close: () => db.close(),
  };
}

if (import.meta.main) {
  const app = createApp({ dbPath: process.env.SHH_DB, trustProxy: process.env.SHH_TRUST_PROXY === "1" });
  const server = Bun.serve({
    hostname: process.env.SHH_HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 3000),
    maxRequestBodySize: MAX_BODY,
    fetch: (req, srv) => app.fetch(req, srv.requestIP(req)?.address),
  });
  const timer = setInterval(app.sweep, 60_000);
  const stop = () => {
    clearInterval(timer);
    void server.stop().then(() => {
      app.close();
      process.exit(0);
    });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  console.log(`shh listening on ${server.url}`); // the only thing this server ever logs
}
