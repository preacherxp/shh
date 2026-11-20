// The whole flow in a real browser. Opt-in: `bun run test:browser` (plain `bun test`
// does not pick this file up). Skipped when no Chrome is installed.
// SHH_E2E_URL points it at a server that is already running; SHH_E2E_SHOTS saves screenshots there.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { createApp } from "../server";
import { chromePath, launch, type Page } from "./chrome";

const dist = join(import.meta.dir, "../dist");
const ready = !!chromePath && (!!process.env.SHH_E2E_URL || existsSync(join(dist, "app.js")));
if (!chromePath) console.warn("No Chrome found; skipping the browser test.");
else if (!ready) console.warn("Run `bun run build` first; skipping the browser test.");

let browser: Awaited<ReturnType<typeof launch>>;
let server: ReturnType<typeof Bun.serve> | undefined;
let app: ReturnType<typeof createApp> | undefined;
let base = process.env.SHH_E2E_URL?.replace(/\/$/, "") ?? "";
const pages: Page[] = [];

beforeAll(async () => {
  if (!ready) return;
  if (!base) {
    const own = (app = createApp({ publicDir: dist }));
    server = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: (req, srv) => own.fetch(req, srv.requestIP(req)?.address) });
    base = `http://localhost:${server.port}`;
  }
  browser = await launch(chromePath!);
});
afterAll(async () => {
  await browser?.close();
  await server?.stop(true);
  app?.close();
});

async function open(url: string): Promise<Page> {
  const page = await browser.open(url);
  pages.push(page);
  return page;
}
const text = (id: string) => `document.getElementById(${JSON.stringify(id)}).textContent`;
const value = (id: string) => `document.getElementById(${JSON.stringify(id)}).value`;
const visible = (id: string) => `(() => { const node = document.getElementById(${JSON.stringify(id)}); return !!node && node.getClientRects().length > 0; })()`;
const click = (id: string) => `document.getElementById(${JSON.stringify(id)}).click()`;
const focus = (id: string) => `document.getElementById(${JSON.stringify(id)}).focus()`;
const focused = "document.activeElement.id";
const rows = `[...document.querySelectorAll("#checks li")].map((row) => row.textContent)`;
const label = `${text("shield-label")}`;
let shots = 0;
const shot = async (page: Page, name: string) => {
  if (process.env.SHH_E2E_SHOTS) await page.screenshot(join(process.env.SHH_E2E_SHOTS, `${String(++shots).padStart(2, "0")}-${name}.png`));
};

async function seal(page: Page, secret: string, passphrase = "", opens = "1") {
  await page.until(visible("secret"));
  await page.run(focus("secret"));
  await page.type(secret);
  if (passphrase) {
    await page.run(focus("passphrase"));
    await page.type(passphrase);
  }
  await page.run(`document.querySelector('input[name="opens"][value="${opens}"]').click()`);
  await page.run(`document.getElementById("compose").requestSubmit()`);
  await page.until(visible("link"), 20_000);
  return { link: await page.run<string>(value("link")), passphrase: await page.run<string>(value("share-passphrase")), sender: await page.run<string>(value("sender-link")) };
}

test.skipIf(!ready)("seal with a generated passphrase, open it elsewhere, and watch the sender's status change", async () => {
  const sender = await open(base);

  // The shield starts hollow and only reports what the checks found.
  await sender.until(visible("secret"));
  expect(await sender.until<string>(`${label}.startsWith("All") && ${label}`)).toBe("All 6 checks passed");
  expect(await sender.run(`document.getElementById("shield").dataset.state`)).toBe("pass");
  await shot(sender, "compose");
  // From the explanation under the button, by keyboard: the panel opens, takes the focus, and Escape gives it back.
  await sender.run(`document.querySelector('[data-view="compose"] [data-opens-shield]').focus()`);
  await sender.press("Enter");
  expect(await sender.until(visible("shield-panel"))).toBe(true);
  expect(await sender.run(focused)).toBe("shield-title");
  expect(await sender.run(`document.getElementById("shield").getAttribute("aria-expanded")`)).toBe("true");
  await sender.until(`${text("checks-summary")} === "All 6 checks passed."`);
  expect(await sender.run<string[]>(rows)).toEqual([
    "Passed This page is served from this computer, which the browser treats as secure.",
    "Passed The browser's built-in encryption works: a throwaway value was sealed and opened again with shh's own code.",
    "Passed This page is not inside another page's frame.",
    expect.stringMatching(/^Passed Everything this page loaded, its script (and its worker )?included, came from this site\.$/),
    "Passed This site's content policy allows scripts from this site only, none written into the page, and connections to this site only.",
    "Passed Trusted Types are required by this site's policy and supported by this browser.",
  ]);
  expect(await sender.run<string>(text("shield-route"))).toBe(""); // no proxy in front of a local server
  await shot(sender, "panel-compose");
  await sender.press("Escape");
  expect(await sender.run(visible("shield-panel"))).toBe(false);
  expect(await sender.run(`document.activeElement.textContent`)).toBe("How it's checked");

  const made = await seal(sender, "hunter2 – zażółć 🔑");
  await shot(sender, "sealed");
  // After sealing, two more checks: the server's own account of the limits, and that the passphrase is needed.
  expect(await sender.until<string>(`${label}.startsWith("All 8") && ${label}`)).toBe("All 8 checks passed");
  await sender.run(click("shield"));
  expect((await sender.until<string[]>(`${text("checks-summary")} === "All 8 checks passed." && ${rows}`)).slice(6)).toEqual([
    expect.stringMatching(/^Passed The server confirms the limits you chose: 1 open left, and it expires on .+\.$/),
    "Passed The link alone does not open this secret: the passphrase is needed too.",
  ]);
  await shot(sender, "panel-sealed");
  await sender.run(click("shield-close"));
  expect(await sender.run(focused)).toBe("shield");
  expect(made.link).toMatch(/\/#[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\.p$/);
  expect(made.sender).toMatch(/\/#sender\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  expect(made.passphrase).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(await sender.until<string>(`${text("track")}.startsWith("Not opened yet") && ${text("track")}`)).toContain("1 open left");
  expect(await sender.run(visible("destroy"))).toBe(true);

  const reader = await open(made.link);
  await reader.until(visible("unlock-passphrase"));
  expect(await reader.run("location.hash")).toBe(""); // the key has left the address bar
  expect(await reader.until<string>(`${label}.startsWith("All") && ${label}`)).toBe("All 7 checks passed"); // one more: the address bar
  await reader.run(click("shield"));
  expect(await reader.until<string[]>(`${text("checks-summary")} !== "" && ${rows}`)).toContain("Passed The key has been taken out of the address bar.");
  await shot(reader, "panel-reveal");
  await reader.run(focus("shield"));
  await reader.press("Escape");
  expect(await reader.run(visible("shield-panel"))).toBe(false);
  await reader.run(focus("unlock-passphrase"));
  await reader.type("not the passphrase");
  await reader.press("Enter");
  expect(await reader.until<string>(text("status"))).toBe("Wrong passphrase. 4 tries left before the secret is destroyed.");
  await shot(reader, "wrong-passphrase");
  await reader.run(`document.getElementById("unlock-passphrase").select()`);
  await reader.type(made.passphrase);
  await reader.press("Enter");
  await reader.until(visible("revealed"), 20_000);
  expect(await reader.run<string>(value("revealed"))).toBe("hunter2 – zażółć 🔑");

  // The sender's tab was hidden meanwhile, so it has not asked. Once it is visible again it finds out
  // on its own, then stops asking and takes the button away.
  expect(await sender.run("document.hidden")).toBe(true);
  expect(await sender.run<string>(text("track"))).toStartWith("Not opened yet");
  await sender.front();
  expect(await sender.until<string>(`${text("track")}.startsWith("Opened once") && ${text("track")}`, 15_000)).toContain("the stored secret is gone");
  expect(await sender.run(visible("destroy"))).toBe(false);
  await shot(sender, "opened");
}, 60_000);

test.skipIf(!ready)("seal with a typed passphrase, come back through the sender's link, and destroy it from the keyboard", async () => {
  const sender = await open(base);
  await sender.until(visible("secret"));
  await sender.run(focus("passphrase"));
  await sender.type("tue");
  expect(await sender.run<string>(text("passphrase-short"))).toContain("Leaving the field blank generates a strong one");
  await shot(sender, "short-passphrase");
  await sender.type("sday afternoon");
  expect(await sender.run<string>(text("passphrase-short"))).toBe("");
  await sender.run(`document.getElementById("passphrase").value = ""`);
  const made = await seal(sender, "correct horse", "tuesday", "2");
  expect(made.passphrase).toBe("tuesday");
  await sender.close();

  const later = await open(made.sender);
  expect(await later.until<string>(`${text("track")}.startsWith("Not opened yet") && ${text("track")}`)).toContain("2 opens left");
  expect(await later.run("location.hash")).toBe("");
  expect(await later.run(visible("link"))).toBe(false); // the sender's link shows the status, not the recipient's link
  expect(await later.run<string>(text("sealed-title"))).toBe("Your secret's status");
  await shot(later, "sender-link");
  expect(await later.until<string>(`${label}.startsWith("All") && ${label}`)).toBe("All 7 checks passed");
  await later.run(click("shield"));
  expect(await later.until<string[]>(`${text("checks-summary")} !== "" && ${rows}`)).toContain("Passed The key has been taken out of the address bar.");
  await shot(later, "panel-sender");
  await later.run(click("shield"));
  expect(await later.run(visible("shield-panel"))).toBe(false);

  // Keyboard only: Enter asks, focus lands on "Keep it", Escape backs out, then Tab to "Yes" and Enter.
  await later.run(focus("destroy"));
  await later.press("Enter");
  expect(await later.until(visible("destroy-confirm"))).toBe(true);
  expect(await later.run(focused)).toBe("destroy-no");
  await shot(later, "confirm");
  await later.press("Escape");
  expect(await later.run(visible("destroy-confirm"))).toBe(false);
  expect(await later.run(focused)).toBe("destroy");
  await later.press("Enter");
  await later.press("Tab");
  expect(await later.run(focused)).toBe("destroy-yes");
  await later.press("Enter");
  expect(await later.until<string>(`${text("track")}.startsWith("Destroyed") && ${text("track")}`)).toContain("It was never opened.");
  expect(await later.run(visible("destroy"))).toBe(false);
  expect(await later.run(visible("destroy-confirm"))).toBe(false);
  expect(await later.run(focused)).toBe("sealed-title");
  await shot(later, "destroyed");

  const reader = await open(made.link);
  expect(await reader.until<string>(`${visible("gone-text")} && ${text("gone-text")}`)).toContain("already opened, or it expired");

  const gone = await open(`${base}/#sender.${"A".repeat(22)}.${"A".repeat(43)}`);
  expect(await gone.until<string>(`${text("track")}.startsWith("This secret is gone") && ${text("track")}`)).toContain("gone or has expired");
  expect(await gone.run(visible("destroy"))).toBe(false);
}, 60_000);

// A browser treats a plain-http address on the network as insecure, so the shield has something to fail.
const lan = Object.values(networkInterfaces()).flat().find((address) => address?.family === "IPv4" && !address.internal)?.address;

test.skipIf(!ready || !lan || !!process.env.SHH_E2E_URL)("over plain http the shield fails, says so in words and says what to do", async () => {
  const page = await browser.open(`http://${lan}:${server!.port}`); // not in `pages`: this one is meant to have problems
  expect(await page.until<string>(`${label}.includes("failed") && ${label}`)).toBe("2 checks failed");
  expect(await page.run(`document.getElementById("shield").dataset.state`)).toBe("fail");
  await page.run(click("shield"));
  const listed = await page.until<string[]>(`${text("checks-summary")} !== "" && ${rows}`);
  expect(listed).toContain("Failed This page was not loaded securely. Open it over HTTPS.");
  expect(listed).toContain("Failed This browser has no built-in encryption here, so shh cannot work. Use a current browser over HTTPS.");
  expect(await page.run<string>(text("checks-summary"))).toBe("2 checks failed.");
  await shot(page, "panel-insecure");
}, 30_000);

test.skipIf(!ready)("the browser reported no Content-Security-Policy, Trusted Types or script problems", () => {
  expect(pages.length).toBeGreaterThan(0);
  expect(pages.flatMap((page) => page.problems)).toEqual([]);
});
