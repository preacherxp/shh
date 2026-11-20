// The shield's checks. A check passes or fails only on something this page tested a
// moment ago; "unknown" means the browser did not let it tell, and is never shown as a pass.
// These are pure functions: app.ts gathers the facts and draws the results.
import { fromBase64Url, seal, toBase64Url, unlock } from "./crypto";
import type { Status } from "./links";

export type Outcome = "pass" | "fail" | "unknown";
export type Check = { id: string; outcome: Outcome; text: string };

const check = (id: string, outcome: Outcome, text: string): Check => ({ id, outcome, text });

export function secureContext(isSecure: boolean | undefined, protocol: string): Check {
  if (isSecure === undefined) return check("secure", "unknown", "This browser does not say whether the page was loaded securely.");
  if (!isSecure) return check("secure", "fail", "This page was not loaded securely. Open it over HTTPS.");
  return check("secure", "pass", protocol === "https:" ? "This page was loaded over HTTPS." : "This page is served from this computer, which the browser treats as secure.");
}

/**
 * Seals and opens a throwaway value with the same functions that handle a real secret.
 * It takes no secret, link or passphrase: everything it encrypts is made up here.
 */
export async function selfTest(tools: { seal: typeof seal; unlock: typeof unlock; available: boolean } = { seal, unlock, available: !!globalThis.crypto?.subtle }): Promise<Check> {
  if (!tools.available) return check("crypto", "fail", "This browser has no built-in encryption here, so shh cannot work. Use a current browser over HTTPS.");
  try {
    const random = () => toBase64Url(crypto.getRandomValues(new Uint8Array(12)));
    const throwaway = `shh self-test ${random()}`;
    const phrase = random();
    const sealed = await tools.seal(throwaway, phrase);
    const stored = new TextDecoder("latin1").decode(fromBase64Url(sealed.data));
    const keys = await tools.unlock(sealed.linkKey, phrase);
    const opened = await keys.open(sealed.data);
    if (opened !== throwaway || keys.auth !== sealed.auth || stored.includes(throwaway)) throw new Error("self-test");
    return check("crypto", "pass", "The browser's built-in encryption works: a throwaway value was sealed and opened again with shh's own code.");
  } catch {
    return check("crypto", "fail", "The browser's encryption failed its self-test. Do not use this page; try a current browser.");
  }
}

export function notFramed(isTop: boolean | undefined): Check {
  if (isTop === undefined) return check("frame", "unknown", "The browser did not say whether this page is inside another page.");
  return isTop ? check("frame", "pass", "This page is not inside another page's frame.") : check("frame", "fail", "This page is shown inside another page. Open it in its own tab.");
}

/** Only for a page that arrived with a key in its address. */
export function addressBar(hash: string): Check {
  return hash === "" || hash === "#"
    ? check("address", "pass", "The key has been taken out of the address bar.")
    : check("address", "fail", "The key is still in the address bar. Close this tab when you are done, and do not bookmark or share its address.");
}

const EXTENSION = /^(chrome|moz|safari-web|ms-browser)-extension:$/;

/**
 * `scripts` is the address of every script element ("" for an inline one); `resources`
 * is every address the browser says the page loaded, or null if it does not say.
 */
export function loadedFromHere(origin: string, scripts: string[], resources: string[] | null): Check {
  const all = [...scripts.filter(Boolean), ...(resources ?? [])];
  let extensions = 0;
  const foreign = new Set<string>();
  for (const address of all) {
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      foreign.add("an unreadable address");
      continue;
    }
    if (EXTENSION.test(url.protocol)) extensions++;
    else if (url.origin !== origin) foreign.add(url.host || url.protocol);
  }
  if (scripts.includes("")) return check("origin", "fail", "There is a script written into this page, which shh never does. Do not use this copy.");
  if (foreign.size) return check("origin", "fail", `This page loaded something from another site (${[...foreign].slice(0, 3).join(", ")}). shh loads nothing from elsewhere. Do not use this copy.`);
  if (extensions) return check("origin", "unknown", "A browser extension added something to this page. Extensions can read what you type here; use a private window if you do not trust yours.");
  // Without the page's own script in the list, the list says nothing.
  if (!resources || !resources.includes(`${origin}/app.js`)) return check("origin", "unknown", "The browser did not say what this page loaded.");
  const what = resources.includes(`${origin}/scene.js`) ? "its script and its worker" : "its script";
  return check("origin", "pass", `Everything this page loaded, ${what} included, came from this site.`);
}

const directives = (csp: string) =>
  new Map(csp.split(";").map((part) => part.trim().split(/\s+/)).filter((words) => words[0]).map(([name, ...sources]) => [name!.toLowerCase(), sources.join(" ")]));

/** `csp` is the policy this site sends with the page: null if it sends none, undefined if it could not be read. */
export function contentPolicy(csp: string | null | undefined): Check {
  if (csp === undefined) return check("policy", "unknown", "Could not read this site's security headers just now.");
  const policy = directives(csp ?? "");
  const strict = policy.get("default-src") === "'none'" && policy.get("script-src") === "'self'" && policy.get("connect-src") === "'self'";
  return strict
    ? check("policy", "pass", "This site's content policy allows scripts from this site only, none written into the page, and connections to this site only.")
    : check("policy", "fail", "This site's content policy is weaker than the one in shh's code. Do not use this copy.");
}

export function trustedTypes(supported: boolean, csp: string | null | undefined): Check {
  if (!supported) return check("types", "unknown", "This browser does not support Trusted Types. The content policy still applies.");
  if (csp === undefined) return check("types", "unknown", "Could not read this site's security headers just now.");
  return directives(csp ?? "").get("require-trusted-types-for") === "'script'"
    ? check("types", "pass", "Trusted Types are required by this site's policy and supported by this browser.")
    : check("types", "fail", "This site's policy does not require Trusted Types, which shh's code always does. Do not use this copy.");
}

/**
 * What the sender chose against what the server says it stored.
 * `status` is undefined until the server has answered and null once the link is gone.
 */
export function linkLimits(asked: { opens: number; expiresAt: number | null }, status: Status | null | undefined, when: (ms: number) => string): Check {
  if (status === undefined) return check("limits", "unknown", "The server has not confirmed this link's limits yet.");
  if (status === null || status.state !== "waiting") return check("limits", "unknown", "This link has ended, so it has no limits left to check.");
  const opens = status.opened + status.opensLeft === asked.opens;
  if (!opens || (asked.expiresAt !== null && Math.abs(status.expiresAt - asked.expiresAt) > 30_000)) {
    return check("limits", "fail", "The server stored different limits from the ones you chose. Destroy this link and create a new one.");
  }
  const left = `${status.opensLeft === 1 ? "1 open" : `${status.opensLeft} opens`} left`;
  return asked.expiresAt === null
    ? check("limits", "unknown", `The server confirms ${left}. The expiry could not be compared; it says ${when(status.expiresAt)}.`)
    : check("limits", "pass", `The server confirms the limits you chose: ${left}, and it expires on ${when(status.expiresAt)}.`);
}

/** `bareProof` is the access proof the link would give with no passphrase; `proof` is the one the server holds. */
export function passphraseNeeded(bareProof: string | undefined, proof: string): Check {
  if (bareProof === undefined) return check("passphrase", "unknown", "Still checking that the passphrase is needed.");
  return bareProof !== proof
    ? check("passphrase", "pass", "The link alone does not open this secret: the passphrase is needed too.")
    : check("passphrase", "fail", "This link opens without a passphrase. Anyone who gets the link can read the secret.");
}

export type Overall = { state: "pending" | "pass" | "fail" | "partial"; label: string };

/** The shield's state at a glance. It only says "passed" when every check did. */
export function summarize(checks: Check[], pending: number): Overall {
  const count = (outcome: Outcome) => checks.filter((item) => item.outcome === outcome).length;
  const [passed, failed, unknown] = [count("pass"), count("fail"), count("unknown")];
  if (failed) return { state: "fail", label: failed === 1 ? "1 check failed" : `${failed} checks failed` };
  if (pending) return { state: "pending", label: "Checking this page" };
  if (unknown || !passed) return { state: "partial", label: `${passed} ${passed === 1 ? "check" : "checks"} passed, ${unknown} not checked` };
  return { state: "pass", label: `All ${passed} checks passed` };
}

/** What the response headers say the page passed through. Says nothing when they name nothing. */
export function route(headers: { server: string | null; via: string | null } | undefined): string {
  const named = [headers?.server && `server "${headers.server}"`, headers?.via && `via "${headers.via}"`].filter(Boolean);
  return named.length ? `The response headers name what this page passed through on its way to you: ${named.join(", ")}. shh's own server sends neither header.` : "";
}
