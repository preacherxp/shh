import { MAX_SECRET_BYTES, seal, toBase64Url, unlock } from "./crypto";
import type { SceneMessage, SceneState } from "./scene";

type View = "compose" | "sealed" | "locked" | "revealed" | "gone";

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const secret = el<HTMLTextAreaElement>("secret");
const passphrase = el<HTMLInputElement>("passphrase");
const link = el<HTMLInputElement>("link");
const unlockPassphrase = el<HTMLInputElement>("unlock-passphrase");
const sharePassphrase = el<HTMLInputElement>("share-passphrase");
const revealed = el<HTMLTextAreaElement>("revealed");
const status = el("status");

const TTL_LABELS: Record<string, string> = { "300": "5 minutes", "3600": "1 hour", "86400": "1 day", "604800": "7 days" };
const LINK = /^#([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})(\.p)?$/;
const hadFragment = !!location.hash;
let parsed = LINK.exec(location.hash);
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

async function api(path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

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
    link.value = `${location.origin}/#${result.body.id}.${linkKey}.p`;
    sharePassphrase.value = phrase;
    el("sealed-text").textContent =
      opens === 1 ? "Send this link to one person. It opens once, then the secret is destroyed." : `This link opens ${opens} times, then the secret is destroyed. Everyone who opens it uses one.`;
    el("sealed-note").textContent =
      `Opened or not, it expires in ${TTL_LABELS[ttl]}. Send the passphrase through a different, verified channel.`;
    show("sealed");
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
  link.value = "";
  sharePassphrase.value = "";
  displayPassphrase(false);
  compose.reset();
  show("compose");
});

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
  parsed = null;
  for (const field of [secret, passphrase, link, sharePassphrase, unlockPassphrase, revealed]) field.value = "";
});
window.addEventListener("pageshow", (event) => { if (event.persisted) location.reload(); });
addEventListener("hashchange", () => location.reload());

// ---- start ---------------------------------------------------------------
if (!hadFragment) {
  show("compose");
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

declare global {
  interface Window {
    trustedTypes?: { createPolicy(name: string, rules: { createScriptURL(input: string): string }): { createScriptURL(input: string): unknown } };
  }
}
