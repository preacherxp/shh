// A very small driver for an installed Chrome, speaking the DevTools protocol
// over Bun's built-in WebSocket. Development only: no dependency, no download.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CANDIDATES = [
  process.env.SHH_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  Bun.which("google-chrome"),
  Bun.which("google-chrome-stable"),
  Bun.which("chromium"),
  Bun.which("chromium-browser"),
];
export const chromePath = CANDIDATES.find((path): path is string => !!path && existsSync(path)) ?? null;

type Pending = { resolve(value: Record<string, unknown>): void; reject(error: Error): void };
type Message = { id?: number; method?: string; sessionId?: string; params?: Record<string, any>; result?: Record<string, unknown>; error?: { message: string } };

export type Page = {
  /** Everything the browser complained about: console errors, uncaught exceptions, CSP and Trusted Types violations. */
  problems: string[];
  /** Runs an expression in the page and returns its value. */
  run<T = unknown>(expression: string): Promise<T>;
  /** Waits until the expression is truthy, then returns its value. */
  until<T = unknown>(expression: string, timeoutMs?: number): Promise<T>;
  /** Presses a key as a keyboard would, for example "Tab", "Enter" or "Escape". */
  press(key: string): Promise<void>;
  /** Types text into the focused element as a keyboard would. */
  type(text: string): Promise<void>;
  /** Makes this the visible tab; the others become hidden, as when a person switches tabs. */
  front(): Promise<void>;
  /** Sets the size of the page in CSS pixels, and how many device pixels each one gets. */
  viewport(width: number, height: number, scale?: number): Promise<void>;
  screenshot(path: string, wholePage?: boolean): Promise<void>;
  close(): Promise<void>;
};

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Tab: { code: "Tab", keyCode: 9 },
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Escape: { code: "Escape", keyCode: 27 },
  " ": { code: "Space", keyCode: 32, text: " " },
};

export async function launch(path: string): Promise<{ open(url: string): Promise<Page>; close(): Promise<void> }> {
  const profile = mkdtempSync(join(tmpdir(), "shh-chrome-"));
  const chrome = Bun.spawn(
    [path, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--window-size=1100,1400", "about:blank"],
    { stdout: "ignore", stderr: "pipe" },
  );

  // Chrome prints the address of its debugging socket on standard error.
  let printed = "";
  const reader = chrome.stderr.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + 20_000;
  let address: string | undefined;
  while (!address && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    printed += decoder.decode(value, { stream: true });
    address = /DevTools listening on (ws:\/\/\S+)/.exec(printed)?.[1];
  }
  void reader.cancel().catch(() => {});
  if (!address) {
    chrome.kill();
    rmSync(profile, { recursive: true, force: true });
    throw new Error("Chrome did not start");
  }

  const socket = new WebSocket(address);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("could not connect to Chrome"));
  });
  let nextId = 0;
  const pending = new Map<number, Pending>();
  const listeners = new Map<string, (method: string, params: Record<string, any>) => void>();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as Message;
    if (message.id !== undefined) {
      const waiting = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiting?.reject(new Error(message.error.message));
      else waiting?.resolve(message.result ?? {});
    } else if (message.method && message.sessionId) {
      listeners.get(message.sessionId)?.(message.method, message.params ?? {});
    }
  };
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<Record<string, any>>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });

  async function open(url: string): Promise<Page> {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const problems: string[] = [];
    listeners.set(sessionId, (method, params) => {
      if (method === "Runtime.exceptionThrown") problems.push(`exception: ${params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text}`);
      if (method === "Runtime.consoleAPICalled" && (params.type === "error" || params.type === "warning")) problems.push(`console.${params.type}: ${JSON.stringify(params.args?.map((arg: { value?: unknown; description?: string }) => arg.value ?? arg.description))}`);
      // A 403 or 404 from the API is an answer, not a problem; everything else at error level is.
      if (method === "Log.entryAdded" && params.entry?.source !== "network" && (params.entry?.level === "error" || params.entry?.source === "security")) problems.push(`${params.entry.source}: ${params.entry.text}`);
    });
    for (const domain of ["Runtime", "Log", "Page"]) await send(`${domain}.enable`, {}, sessionId);
    await send("Page.navigate", { url }, sessionId);

    const run = async <T>(expression: string): Promise<T> => {
      const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (exceptionDetails) throw new Error(`page script failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
      return result.value as T;
    };
    return {
      problems,
      run,
      async until<T>(expression: string, timeoutMs = 10_000): Promise<T> {
        const end = Date.now() + timeoutMs;
        for (;;) {
          const value = await run<T>(expression).catch(() => undefined); // the page may be between documents
          if (value) return value;
          if (Date.now() > end) throw new Error(`timed out waiting for: ${expression}`);
          await Bun.sleep(50);
        }
      },
      async press(key) {
        const info = KEYS[key];
        if (!info) throw new Error(`unknown key ${key}`);
        const event = { key, code: info.code, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode };
        await send("Input.dispatchKeyEvent", { type: info.text ? "keyDown" : "rawKeyDown", text: info.text, ...event }, sessionId);
        await send("Input.dispatchKeyEvent", { type: "keyUp", ...event }, sessionId);
      },
      async type(text) {
        await send("Input.insertText", { text }, sessionId);
      },
      async front() {
        await send("Page.bringToFront", {}, sessionId);
      },
      async viewport(width, height, scale = 1) {
        await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false }, sessionId);
      },
      async screenshot(file, wholePage = true) {
        const clip = wholePage ? { ...(await run<{ width: number; height: number }>("({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })")), x: 0, y: 0, scale: 1 } : undefined;
        const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: wholePage, clip }, sessionId);
        await Bun.write(file, Buffer.from(data, "base64"));
      },
      async close() {
        listeners.delete(sessionId);
        await send("Target.closeTarget", { targetId });
      },
    };
  }

  return {
    open,
    async close() {
      await send("Browser.close").catch(() => {});
      socket.close();
      await Promise.race([chrome.exited, Bun.sleep(3_000)]);
      chrome.kill();
      await chrome.exited;
      rmSync(profile, { recursive: true, force: true });
    },
  };
}
