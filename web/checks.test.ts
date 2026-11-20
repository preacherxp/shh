import { expect, test } from "bun:test";
import { addressBar, contentPolicy, linkLimits, loadedFromHere, notFramed, passphraseNeeded, route, secureContext, selfTest, summarize, trustedTypes, type Check } from "./checks";
import { seal, unlock } from "./crypto";
import type { Status } from "./links";

const HERE = "https://shh.example";
// The policy server.ts sends, word for word.
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types shh";
const outcome = (check: Check) => check.outcome;

test("a secure context passes, an insecure one fails and says what to do", () => {
  expect(secureContext(true, "https:")).toEqual({ id: "secure", outcome: "pass", text: "This page was loaded over HTTPS." });
  expect(secureContext(true, "http:")).toMatchObject({ outcome: "pass", text: expect.stringContaining("this computer") }); // localhost
  expect(secureContext(false, "http:")).toMatchObject({ outcome: "fail", text: expect.stringContaining("Open it over HTTPS") });
  expect(outcome(secureContext(undefined, "https:"))).toBe("unknown");
});

test("the self-test seals and opens a throwaway value with the real functions", async () => {
  expect(await selfTest()).toMatchObject({ id: "crypto", outcome: "pass" });
});

test("the self-test cannot be given a secret, and makes up a new value every time", async () => {
  expect(selfTest.length).toBe(0); // no parameter a secret, link or passphrase could travel in
  const seen: Array<{ text: string; passphrase: string }> = [];
  const spied = {
    available: true,
    seal: (text: string, passphrase = "") => (seen.push({ text, passphrase }), seal(text, passphrase)),
    unlock,
  };
  expect(outcome(await selfTest(spied))).toBe("pass");
  expect(outcome(await selfTest(spied))).toBe("pass");
  expect(seen.length).toBe(2);
  for (const { text, passphrase } of seen) {
    expect(text).toMatch(/^shh self-test [A-Za-z0-9_-]{16}$/);
    expect(passphrase).toMatch(/^[A-Za-z0-9_-]{16}$/);
  }
  expect(seen[0]!.text).not.toBe(seen[1]!.text);
  expect(seen[0]!.passphrase).not.toBe(seen[1]!.passphrase);
});

test("the self-test fails when encryption is missing, broken or not really encrypting", async () => {
  const fails = async (tools: Partial<Parameters<typeof selfTest>[0]>) => outcome(await selfTest({ seal, unlock, available: true, ...tools }));
  expect(await fails({ available: false })).toBe("fail");
  expect(await fails({ seal: async () => { throw new Error("no"); } })).toBe("fail");
  // Opens to something else.
  expect(await fails({ unlock: async (key, phrase) => ({ ...(await unlock(key, phrase)), open: async () => "something else" }) })).toBe("fail");
  // The proof from the link does not match the one that was sent.
  expect(await fails({ unlock: async (key, phrase) => ({ ...(await unlock(key, phrase)), auth: "x" }) })).toBe("fail");
  // "Encryption" that stores the text as it is.
  const plain = (text: string) => btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  expect(await fails({
    seal: async (text) => ({ linkKey: "k", auth: "a", data: plain(text) }),
    unlock: async () => ({ auth: "a", open: async (data) => atob(data.replace(/-/g, "+").replace(/_/g, "/")) }),
  })).toBe("fail");
  expect((await selfTest({ seal, unlock, available: false })).text).toContain("Use a current browser over HTTPS");
});

test("a framed page fails", () => {
  expect(outcome(notFramed(true))).toBe("pass");
  expect(notFramed(false)).toMatchObject({ outcome: "fail", text: expect.stringContaining("Open it in its own tab") });
  expect(outcome(notFramed(undefined))).toBe("unknown");
});

test("a key left in the address bar fails", () => {
  expect(outcome(addressBar(""))).toBe("pass");
  expect(outcome(addressBar("#"))).toBe("pass");
  expect(addressBar(`#${"a".repeat(22)}.${"b".repeat(43)}.p`)).toMatchObject({ outcome: "fail", text: expect.stringContaining("Close this tab") });
});

test("everything the page loaded must come from this site", () => {
  const own = [`${HERE}/style.css`, `${HERE}/app.js`, `${HERE}/scene.js`, `${HERE}/vt323.woff2`, `${HERE}/app.js`];
  expect(loadedFromHere(HERE, [`${HERE}/app.js`], own)).toEqual({ id: "origin", outcome: "pass", text: "Everything this page loaded, its script and its worker included, came from this site." });
  // The worker is only mentioned when the browser listed it.
  expect(loadedFromHere(HERE, [`${HERE}/app.js`], own.filter((address) => !address.endsWith("/scene.js"))).text).toBe("Everything this page loaded, its script included, came from this site.");

  // Another site, in the resources or as a script element: fail, naming it.
  expect(loadedFromHere(HERE, [`${HERE}/app.js`], [...own, "https://cdn.example/x.js"])).toMatchObject({ outcome: "fail", text: expect.stringContaining("cdn.example") });
  expect(outcome(loadedFromHere(HERE, [`${HERE}/app.js`, "https://evil.example/a.js"], own))).toBe("fail");
  expect(outcome(loadedFromHere(HERE, [`${HERE}/app.js`], [...own, "http://shh.example/app.js"]))).toBe("fail"); // same host, not the same origin
  expect(outcome(loadedFromHere(HERE, [`${HERE}/app.js`], [...own, "data:text/javascript,alert(1)"]))).toBe("fail");
  expect(outcome(loadedFromHere(HERE, [`${HERE}/app.js`, ""], own))).toBe("fail"); // a script written into the page

  // Could not determine: its own neutral state, never a pass.
  expect(outcome(loadedFromHere(HERE, [`${HERE}/app.js`], null))).toBe("unknown");
  expect(outcome(loadedFromHere(HERE, [`${HERE}/app.js`], []))).toBe("unknown");
  expect(outcome(loadedFromHere(HERE, [`${HERE}/app.js`], [`${HERE}/style.css`]))).toBe("unknown"); // the list does not even show our own script
  // A browser extension is the reader's own choice: said plainly, neither pass nor fail.
  expect(loadedFromHere(HERE, [`${HERE}/app.js`], [...own, "chrome-extension://abcdef/inject.js"])).toMatchObject({ outcome: "unknown", text: expect.stringContaining("browser extension") });
  expect(outcome(loadedFromHere(HERE, [`${HERE}/app.js`, "moz-extension://abcdef/x.js"], own))).toBe("unknown");
  expect(outcome(loadedFromHere(HERE, [`${HERE}/app.js`], [...own, "chrome-extension://abcdef/x.js", "https://cdn.example/x.js"]))).toBe("fail"); // another site still fails
});

test("the content policy must be as strict as the one the server sends", () => {
  expect(outcome(contentPolicy(CSP))).toBe("pass");
  expect(outcome(contentPolicy(undefined))).toBe("unknown"); // could not be read
  expect(outcome(contentPolicy(null))).toBe("fail"); // none sent
  expect(outcome(contentPolicy(""))).toBe("fail");
  for (const weaker of [
    CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
    CSP.replace("script-src 'self'", "script-src 'self' https://cdn.example"),
    CSP.replace("script-src 'self'; ", ""),
    CSP.replace("default-src 'none'", "default-src *"),
    CSP.replace("connect-src 'self'", "connect-src *"),
    "default-src 'self'",
  ]) {
    expect([weaker, outcome(contentPolicy(weaker))]).toEqual([weaker, "fail"]);
  }
  expect(contentPolicy("default-src *").text).toContain("Do not use this copy");
});

test("Trusted Types pass only when required and supported, and are neutral where unsupported", () => {
  expect(outcome(trustedTypes(true, CSP))).toBe("pass");
  expect(outcome(trustedTypes(false, CSP))).toBe("unknown");
  expect(outcome(trustedTypes(true, undefined))).toBe("unknown");
  expect(outcome(trustedTypes(true, null))).toBe("fail");
  expect(outcome(trustedTypes(true, CSP.replace("require-trusted-types-for 'script'; ", "")))).toBe("fail");
});

const when = (ms: number) => `T${ms}`;
const waiting: Status = { state: "waiting", opened: 0, opensLeft: 2, firstOpenedAt: null, lastOpenedAt: null, endedAt: null, expiresAt: 4_600_000 };

test("a new link's limits pass only when the server confirms what the sender chose", () => {
  const asked = { opens: 2, expiresAt: 4_600_000 };
  expect(linkLimits(asked, waiting, when)).toEqual({ id: "limits", outcome: "pass", text: "The server confirms the limits you chose: 2 opens left, and it expires on T4600000." });
  expect(outcome(linkLimits(asked, { ...waiting, opened: 1, opensLeft: 1, firstOpenedAt: 1, lastOpenedAt: 1 }, when))).toBe("pass"); // one used, one left
  expect(outcome(linkLimits(asked, { ...waiting, expiresAt: 4_620_000 }, when))).toBe("pass"); // within the clock's margin

  expect(linkLimits(asked, { ...waiting, opensLeft: 10 }, when)).toMatchObject({ outcome: "fail", text: expect.stringContaining("Destroy this link") });
  expect(outcome(linkLimits(asked, { ...waiting, expiresAt: 4_600_000 + 3_600_000 }, when))).toBe("fail"); // kept an hour longer than asked
  expect(outcome(linkLimits(asked, { ...waiting, expiresAt: 4_600_000 - 60_000 }, when))).toBe("fail");

  expect(outcome(linkLimits(asked, undefined, when))).toBe("unknown"); // no answer yet
  expect(outcome(linkLimits(asked, null, when))).toBe("unknown"); // gone
  expect(outcome(linkLimits(asked, { ...waiting, state: "opened", opened: 2, opensLeft: 0 }, when))).toBe("unknown");
  expect(outcome(linkLimits({ opens: 2, expiresAt: null }, waiting, when))).toBe("unknown"); // nothing to compare the expiry with
  expect(outcome(linkLimits({ opens: 2, expiresAt: null }, { ...waiting, opensLeft: 3 }, when))).toBe("fail");
});

test("the passphrase check compares the proof the link alone would give with the one that was stored", async () => {
  const sealed = await seal("hunter2", "tuesday");
  expect(outcome(passphraseNeeded((await unlock(sealed.linkKey)).auth, sealed.auth))).toBe("pass");
  const bare = await seal("hunter2");
  expect(passphraseNeeded((await unlock(bare.linkKey)).auth, bare.auth)).toMatchObject({ outcome: "fail", text: expect.stringContaining("without a passphrase") });
  expect(outcome(passphraseNeeded(undefined, sealed.auth))).toBe("unknown");
});

test("the shield only says passed when every check passed", () => {
  const pass: Check = { id: "a", outcome: "pass", text: "" }, fail: Check = { id: "b", outcome: "fail", text: "" }, unknown: Check = { id: "c", outcome: "unknown", text: "" };
  expect(summarize([pass, pass], 0)).toEqual({ state: "pass", label: "All 2 checks passed" });
  expect(summarize([pass, pass], 1)).toEqual({ state: "pending", label: "Checking this page" }); // never passed while something is still running
  expect(summarize([], 2).state).toBe("pending");
  expect(summarize([pass, unknown], 0)).toEqual({ state: "partial", label: "1 check passed, 1 not checked" });
  expect(summarize([], 0).state).toBe("partial"); // nothing checked is not a pass
  expect(summarize([pass, fail, unknown], 0)).toEqual({ state: "fail", label: "1 check failed" });
  expect(summarize([pass, fail, fail], 3)).toEqual({ state: "fail", label: "2 checks failed" }); // a failure shows at once
});

test("intermediaries are reported only when the headers name one", () => {
  expect(route({ server: "cloudflare", via: "1.1 Caddy" })).toContain('server "cloudflare", via "1.1 Caddy"');
  expect(route({ server: null, via: "1.1 Caddy" })).toContain('through on its way to you: via "1.1 Caddy".');
  expect(route({ server: null, via: null })).toBe("");
  expect(route(undefined)).toBe("");
});
