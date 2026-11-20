import { addressBar, contentPolicy, linkLimits, loadedFromHere, notFramed, passphraseNeeded, route, secureContext, selfTest, summarize, trustedTypes, type Check } from "./checks";
import { MAX_SECRET_BYTES, seal, toBase64Url, unlock } from "./crypto";
import { describeStatus, parseStatus, RECIPIENT_LINK, recipientLink, SENDER_LINK, senderLink, STATUS_GONE, type Status } from "./links";
import type { SceneMessage, SceneState } from "./scene";

type View = "compose" | "sealed" | "locked" | "revealed" | "gone";

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const secret = el<HTMLTextAreaElement>("secret");
const passphrase = el<HTMLInputElement>("passphrase");
const link = el<HTMLInputElement>("link");
const unlockPassphrase = el<HTMLInputElement>("unlock-passphrase");
const sharePassphrase = el<HTMLInputElement>("share-passphrase");
const revealed = el<HTMLTextAreaElement>("revealed");
const senderLinkField = el<HTMLInputElement>("sender-link");
const status = el("status");

const TTL_LABELS: Record<string, string> = { "300": "5 minutes", "3600": "1 hour", "86400": "1 day", "604800": "7 days" };
const hadFragment = !!location.hash;
let parsed = RECIPIENT_LINK.exec(location.hash);
const senderParsed = SENDER_LINK.exec(location.hash);
if (hadFragment) history.replaceState(null, "", "/");

// ---- the book ------------------------------------------------------------
// three.js runs in a worker that only receives the canvas, sizes and the
// name of the current state. It never sees a secret, a key or a link.
const scene = startScene();

function startScene(): (message: SceneMessage) => void {
  const stage = el("stage");
  const canvas = el<HTMLCanvasElement>("scene");
  const off = () => stage.classList.add("is-off");
  if (!("transferControlToOffscreen" in canvas) || typeof Worker === "undefined") return off(), () => {};
  try {
    const url = window.trustedTypes
      ? window.trustedTypes.createPolicy("shh", { createScriptURL: () => "/scene.js" }).createScriptURL("")
      : "/scene.js";
    const worker = new Worker(url as string, { type: "module" });
    const send = (message: SceneMessage, transfer: Transferable[] = []) => worker.postMessage(message, transfer);
    worker.onmessage = (event) => (event.data === "ready" ? stage.classList.add("is-live") : off());
    worker.onerror = off;

    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const offscreen = canvas.transferControlToOffscreen();
    send({ type: "init", canvas: offscreen, width: stage.clientWidth, height: stage.clientHeight, reduced: motion.matches }, [offscreen]);
    new ResizeObserver(() => send({ type: "resize", width: stage.clientWidth, height: stage.clientHeight })).observe(stage);
    document.addEventListener("visibilitychange", () => send({ type: "visible", on: !document.hidden }));
    let queued = false;
    window.addEventListener("pointermove", (event) => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        send({ type: "pointer", x: (event.clientX / innerWidth) * 2 - 1, y: (event.clientY / innerHeight) * 2 - 1 });
      });
    });
    return send;
  } catch {
    off();
    return () => {};
  }
}

const SCENE_FOR_VIEW: Record<View, SceneState> = { compose: "idle", sealed: "sealed", locked: "locked", revealed: "revealed", gone: "gone" };

// ---- views ---------------------------------------------------------------
function show(view: View, bookState: SceneState = SCENE_FOR_VIEW[view]) {
  for (const node of document.querySelectorAll<HTMLElement>("[data-view]")) node.hidden = node.dataset.view !== view;
  say("");
  scene({ type: "state", name: view === "compose" && (secret.value || document.activeElement === secret) ? "writing" : bookState });
  const target = view === "compose" ? secret : document.querySelector<HTMLElement>(`[data-view="${view}"] h2`);
  target?.focus();
}

function say(message: string, good = false) {
  status.textContent = message;
  status.classList.toggle("is-good", good);
}

function busy(form: HTMLFormElement, on: boolean) {
  for (const control of form.querySelectorAll<HTMLButtonElement>("button")) control.disabled = on;
}

async function api(path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown>; date: number | null }> {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  // The server's own clock, so that an expiry can be checked without trusting this device's.
  return { status: response.status, body: await response.json().catch(() => ({})), date: Date.parse(response.headers.get("date") ?? "") || null };
}

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const TROUBLE: Record<number, string> = {
  429: "Too many requests from your network. Wait a minute and try again.",
  503: "The vault is full right now. Try again later.",
};
const trouble = (code: number) => TROUBLE[code] ?? "Something went wrong. Nothing was shared. Try again.";

async function copy(text: string, field: HTMLInputElement | HTMLTextAreaElement) {
  try {
    await navigator.clipboard.writeText(text);
    say("Copied.", true);
  } catch {
    field.select();
    say("Select the text and copy it yourself.");
  }
}

// ---- writing a secret ----------------------------------------------------
const compose = el<HTMLFormElement>("compose");

const bookFollowsWriting = () => scene({ type: "state", name: secret.value || document.activeElement === secret ? "writing" : "idle" });
secret.addEventListener("focus", bookFollowsWriting);
secret.addEventListener("blur", bookFollowsWriting);
let lastPulse = 0;
secret.addEventListener("input", () => {
  // A bare, throttled "something was typed" tick: no characters, no length.
  if (performance.now() - lastPulse < 90) return;
  lastPulse = performance.now();
  scene({ type: "pulse" });
});
secret.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) compose.requestSubmit();
});

// A nudge, not a warning: guesses are limited to five and each one goes through the server.
const SHORT_PASSPHRASE = 8;
function hintPassphrase() {
  const short = passphrase.value.length > 0 && passphrase.value.length < SHORT_PASSPHRASE;
  const text = short ? "That is a short passphrase. A guesser gets only five tries, each checked by the server, so it still works. Leaving the field blank generates a strong one." : "";
  const hint = el("passphrase-short");
  if (hint.textContent !== text) hint.textContent = text;
}
passphrase.addEventListener("input", hintPassphrase);

compose.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!secret.value) return say("Write a secret first."), secret.focus();
  if (new TextEncoder().encode(secret.value).length > MAX_SECRET_BYTES) return say("That is too long. The limit is 16 KB of text.");
  const ttl = new FormData(compose).get("ttl") as string;
  const opens = Number(new FormData(compose).get("opens"));

  busy(compose, true);
  say("");
  scene({ type: "state", name: "sealing" });
  try {
    const phrase = passphrase.value || toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    const { linkKey, auth, data } = await seal(secret.value, phrase);
    const result = await api("/api/secrets", { data, auth, ttl: Number(ttl), opens });
    if (result.status !== 201 || typeof result.body.id !== "string") {
      scene({ type: "state", name: "writing" });
      return say(trouble(result.status));
    }
    secret.value = "";
    passphrase.value = "";
    hintPassphrase();
    link.value = recipientLink(location.origin, result.body.id, linkKey);
    sharePassphrase.value = phrase;
    el("sealed-text").textContent =
      opens === 1 ? "Send this link to one person. It opens once, then the secret is destroyed." : `This link opens ${opens} times, then the secret is destroyed. Everyone who opens it uses one.`;
    el("sealed-note").textContent =
      `Opened or not, it expires in ${TTL_LABELS[ttl]}. Send the passphrase through a different, verified channel.`;
    // For the shield: what was chosen, to hold against what the server says it stored. The
    // proof the link would give without a passphrase is worked out here and goes nowhere.
    const mine: NonNullable<typeof made> = { opens, expiresAt: result.date === null ? null : result.date + Number(ttl) * 1000, proof: auth, bareProof: undefined };
    made = mine;
    known = undefined;
    void unlock(linkKey).then((bare) => ((mine.bareProof = bare.auth), drawShield()), () => {});
    const token = result.body.sender;
    senderLinkField.value = typeof token === "string" ? senderLink(location.origin, result.body.id, token) : "";
    showSealed(true, typeof token === "string" ? { id: result.body.id, token } : null);
  } catch {
    scene({ type: "state", name: "writing" });
    say(trouble(0));
  } finally {
    busy(compose, false);
  }
});

el("copy-link").addEventListener("click", () => copy(link.value, link));
el("copy-passphrase").addEventListener("click", () => copy(sharePassphrase.value, sharePassphrase));
const togglePassphrase = el<HTMLButtonElement>("toggle-passphrase");
function displayPassphrase(visible: boolean) {
  sharePassphrase.type = visible ? "text" : "password";
  togglePassphrase.setAttribute("aria-pressed", String(visible));
}
togglePassphrase.addEventListener("click", () => displayPassphrase(sharePassphrase.type === "password"));
link.addEventListener("focus", () => link.select());
el("again").addEventListener("click", () => {
  watch(null);
  made = null;
  known = undefined;
  drawShield();
  link.value = "";
  sharePassphrase.value = "";
  senderLinkField.value = "";
  displayPassphrase(false);
  compose.reset();
  hintPassphrase();
  show("compose");
});

// ---- the sender's view ---------------------------------------------------
// The sender's token can read the status and destroy the secret, nothing else.
// The book is told nothing about any of this: it stays on "sealed" throughout.
const track = el("track");
const destroy = el<HTMLButtonElement>("destroy");
const destroyConfirm = el("destroy-confirm");
let watched: { id: string; token: string } | null = null;
let pollTimer: number | undefined;
let polls = 0;
let asking = false;

el("copy-sender-link").addEventListener("click", () => copy(senderLinkField.value, senderLinkField));
senderLinkField.addEventListener("focus", () => senderLinkField.select());

/** The sealed view, either right after sealing or when the sender's private link is opened later. */
function showSealed(justSealed: boolean, sender: { id: string; token: string } | null) {
  el("sealed-title").textContent = justSealed ? "Sealed" : "Your secret's status";
  el("share").hidden = !justSealed;
  el("sender-keep").hidden = !justSealed;
  el("sender-refresh").hidden = justSealed;
  el("sender").hidden = !sender;
  show("sealed");
  watch(sender);
}

function watch(sender: { id: string; token: string } | null) {
  window.clearTimeout(pollTimer);
  watched = sender;
  polls = 0;
  askToDestroy(false);
  destroy.hidden = false;
  tell(sender ? "Checking the status." : "");
  if (sender) void ask("status");
}

function tell(text: string) {
  if (track.textContent !== text) track.textContent = text; // an unchanged line is not read out again
}

function askToDestroy(on: boolean) {
  destroyConfirm.hidden = !on;
  destroy.hidden = on;
}

// Gentle: every 5 seconds for the first minute, then every 15, then once a minute, and never in a hidden tab.
function pollLater(delay = polls < 12 ? 5_000 : polls < 36 ? 15_000 : 60_000) {
  window.clearTimeout(pollTimer);
  if (watched && !document.hidden) pollTimer = window.setTimeout(() => void ask("status"), delay);
}
document.addEventListener("visibilitychange", () => pollLater(1_000));

async function ask(action: "status" | "destroy") {
  const target = watched;
  if (!target || asking) return;
  asking = true;
  window.clearTimeout(pollTimer);
  polls++;
  let delay: number | undefined;
  try {
    const result = await api(`/api/secrets/${target.id}/${action}`, { sender: target.token });
    if (watched !== target) return; // the sender moved on while this was in the air
    const state = result.status === 200 ? parseStatus(result.body) : null;
    if (state) tell(describeStatus(state, when));
    else if (result.status === 404) tell(STATUS_GONE);
    else throw new Error("unexpected answer");
    known = state;
    drawShield();
    if (state?.state !== "waiting") {
      // Final: nothing more will change, so stop asking and take the button away.
      const held = document.activeElement === destroy || destroyConfirm.contains(document.activeElement);
      watched = null;
      askToDestroy(false);
      destroy.hidden = true;
      if (held || action === "destroy") el("sealed-title").focus(); // do not leave the keyboard on a control that just disappeared
    }
  } catch {
    if (watched !== target) return;
    delay = 60_000;
    if (action === "destroy") say("Could not destroy it just now. Check your connection and try again.");
    else if (polls === 1) tell("Could not check the status. Trying again in a minute.");
  } finally {
    asking = false;
  }
  pollLater(delay);
}

destroy.addEventListener("click", () => {
  askToDestroy(true);
  el("destroy-no").focus(); // the safe answer first
});
el("destroy-no").addEventListener("click", () => {
  askToDestroy(false);
  destroy.focus();
});
destroyConfirm.addEventListener("keydown", (event) => {
  if (event.key === "Escape") el("destroy-no").click();
});
el("destroy-yes").addEventListener("click", async () => {
  say("");
  for (const control of destroyConfirm.querySelectorAll("button")) control.disabled = true;
  while (asking) await new Promise((done) => setTimeout(done, 50)); // let a status check that is in the air land first
  await ask("destroy");
  for (const control of destroyConfirm.querySelectorAll("button")) control.disabled = false;
});

// ---- the shield ----------------------------------------------------------
// What this page can test about itself, when it loads and again each time the panel opens.
// The checks never read the secret or the passphrase, send nothing but a plain request for
// this page's own address, and the book hears nothing about them.
const shield = el<HTMLButtonElement>("shield");
const shieldPanel = el("shield-panel");
const shieldOpeners = [...document.querySelectorAll<HTMLButtonElement>("[data-opens-shield]")];
let shieldOpener: HTMLElement = shield;
let selfTested: Check | undefined; // undefined while it runs
let siteHeaders: { csp: string | null; server: string | null; via: string | null } | null | undefined; // undefined while asking, null if unreadable
let inspecting = false;
let made: { opens: number; expiresAt: number | null; proof: string; bareProof: string | undefined } | null = null; // the link sealed in this tab
let known: Status | null | undefined; // the server's latest word on it

/** Every check that applies right now. A string stands for one that is still running. */
function currentChecks(): Array<Check | string> {
  let isTop: boolean | undefined;
  let resources: string[] | null = null;
  try {
    isTop = window.top === window.self;
    resources = performance.getEntriesByType("resource").map((entry) => entry.name);
  } catch {
    // left unknown
  }
  const csp = siteHeaders ? siteHeaders.csp : undefined;
  return [
    secureContext(window.isSecureContext, location.protocol),
    selfTested ?? "Testing the browser's built-in encryption.",
    notFramed(isTop),
    ...(hadFragment ? [addressBar(location.hash)] : []),
    loadedFromHere(location.origin, [...document.scripts].map((script) => script.src), resources),
    ...(siteHeaders === undefined ? ["Reading this site's security headers."] : [contentPolicy(csp), trustedTypes(!!window.trustedTypes, csp)]),
    ...(made ? [linkLimits(made, known, when), passphraseNeeded(made.bareProof, made.proof)] : []),
  ];
}

const VERDICT = { pass: "Passed", fail: "Failed", unknown: "Not checked", pending: "Checking" };

function drawShield() {
  const items = currentChecks();
  const overall = summarize(items.filter((item) => typeof item !== "string"), items.filter((item) => typeof item === "string").length);
  shield.dataset.state = overall.state;
  if (el("shield-label").textContent !== overall.label) el("shield-label").textContent = overall.label;
  if (shieldPanel.hidden) return;
  el("checks").replaceChildren(
    ...items.map((item) => {
      const outcome = typeof item === "string" ? "pending" : item.outcome;
      const row = document.createElement("li");
      const verdict = document.createElement("strong");
      const words = document.createElement("span");
      row.dataset.outcome = outcome;
      verdict.className = "verdict";
      verdict.textContent = VERDICT[outcome]; // the state in words, not by colour alone
      words.textContent = typeof item === "string" ? item : item.text;
      row.append(verdict, " ", words);
      return row;
    }),
  );
  const summary = overall.state === "pending" ? "" : `${overall.label}.`;
  if (el("checks-summary").textContent !== summary) el("checks-summary").textContent = summary;
  el("shield-route").textContent = route(siteHeaders ?? undefined);
}

async function inspect() {
  if (inspecting) return;
  inspecting = true;
  selfTested = undefined;
  siteHeaders = undefined;
  drawShield();
  const headers = fetch("/", { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" }).then(
    (response) => (response.ok ? { csp: response.headers.get("content-security-policy"), server: response.headers.get("server"), via: response.headers.get("via") } : null),
    () => null,
  );
  await Promise.all([selfTest().then((result) => ((selfTested = result), drawShield())), headers.then((result) => ((siteHeaders = result), drawShield()))]);
  inspecting = false;
}

function openShield(from: HTMLElement) {
  shieldOpener = from;
  shieldPanel.hidden = false;
  for (const button of shieldOpeners) button.setAttribute("aria-expanded", "true");
  void inspect(); // "just now" means now
  drawShield();
  el("shield-title").focus();
}
function closeShield() {
  shieldPanel.hidden = true;
  for (const button of shieldOpeners) button.setAttribute("aria-expanded", "false");
  (shieldOpener.getClientRects().length ? shieldOpener : shield).focus(); // back to where the reader came from
}
for (const button of shieldOpeners) button.addEventListener("click", () => (button === shield && !shieldPanel.hidden ? closeShield() : openShield(button)));
el("shield-close").addEventListener("click", closeShield);
for (const node of [shield, shieldPanel]) {
  node.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !shieldPanel.hidden) closeShield();
  });
}

// ---- opening a secret ----------------------------------------------------
const unlockForm = el<HTMLFormElement>("unlock");
let clearTimer: number | undefined;

unlockForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!parsed) return;
  const [, id, linkKey, needsPassphrase] = parsed;
  if (needsPassphrase && !unlockPassphrase.value) return say("Type the passphrase first."), unlockPassphrase.focus();

  busy(unlockForm, true);
  say("");
  try {
    const keys = await unlock(linkKey!, needsPassphrase ? unlockPassphrase.value : "");
    const result = await api(`/api/secrets/${id}/reveal`, { auth: keys.auth });
    if (result.status === 200 && typeof result.body.data === "string") {
      revealed.value = await keys.open(result.body.data);
      unlockPassphrase.value = "";
      const left = Number(result.body.remaining) || 0;
      el("revealed-note").textContent = left
        ? `This link can be opened ${left === 1 ? "one more time" : `${left} more times`}. After that the secret is destroyed.`
        : "It has been destroyed on the server. This link will not open again.";
      parsed = null;
      show("revealed", left ? "opened" : "revealed");
      clearTimer = window.setTimeout(clearRevealed, 60_000);
    } else if (result.status === 403 && Number(result.body.remaining) > 0) {
      const left = Number(result.body.remaining);
      scene({ type: "shake" });
      say(`Wrong passphrase. ${left} ${left === 1 ? "try" : "tries"} left before the secret is destroyed.`);
      unlockPassphrase.select();
    } else if (result.status === 403 || result.status === 404) {
      if (result.status === 403) el("gone-text").textContent = "Too many wrong passphrases. The secret was destroyed. Ask the sender to share it again.";
      show("gone");
    } else {
      say(result.status === 429 ? TROUBLE[429]! : "Something went wrong. The secret is still safe. Try again.");
    }
  } catch {
    say("Something went wrong. Check your connection and try again.");
  } finally {
    busy(unlockForm, false);
  }
});

el("copy-secret").addEventListener("click", () => copy(revealed.value, revealed));
function clearRevealed() {
  window.clearTimeout(clearTimer);
  revealed.value = "";
  show("compose");
  say("Secret cleared from this screen.");
}
el("clear-secret").addEventListener("click", clearRevealed);
addEventListener("pagehide", () => {
  window.clearTimeout(clearTimer);
  window.clearTimeout(pollTimer);
  parsed = null;
  watched = null;
  for (const field of [secret, passphrase, link, sharePassphrase, senderLinkField, unlockPassphrase, revealed]) field.value = "";
});
window.addEventListener("pageshow", (event) => { if (event.persisted) location.reload(); });
addEventListener("hashchange", () => location.reload());

// ---- start ---------------------------------------------------------------
if (!hadFragment) {
  show("compose");
} else if (senderParsed) {
  showSealed(false, { id: senderParsed[1]!, token: senderParsed[2]! });
} else if (!parsed) {
  el("gone-text").textContent = "This link is incomplete. Ask the sender to copy the whole link again.";
  show("gone");
} else {
  el("unlock-passphrase-field").hidden = !parsed[3];
  api(`/api/secrets/${parsed[1]}`).then(
    (result) => {
      const opens = Number(result.body.opens);
      if (opens === 1) el("locked-text").textContent = "Someone sent you a secret. It can be opened only once more and is then destroyed, so be ready to copy it.";
      else if (opens > 1) el("locked-text").textContent = `Someone sent you a secret. It can be opened ${opens} more times and is then destroyed. Opening it now uses one.`;
      show(result.status === 404 ? "gone" : "locked");
      if (result.status !== 404 && parsed?.[3]) unlockPassphrase.focus();
    },
    () => show("locked"), // offline or blocked: let them try; revealing reports the real error
  );
}

shield.hidden = false; // it only appears once there is a script to run the checks
void inspect();

declare global {
  interface Window {
    trustedTypes?: { createPolicy(name: string, rules: { createScriptURL(input: string): string }): { createScriptURL(input: string): unknown } };
  }
}
