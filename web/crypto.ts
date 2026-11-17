// Everything that touches a secret lives in this file and uses only the
// browser's built-in WebCrypto. Nothing here is sent anywhere by this module.
//
// linkKey  32 random bytes, kept in the URL fragment (never sent to the server)
// master   linkKey, or PBKDF2(passphrase, salt = linkKey) when a passphrase is set
// key      HKDF(master, "shh/v1/encrypt")  AES-256-GCM key, stays in the browser
// auth     HKDF(master, "shh/v1/auth")     proves to the server we may read once

const encoder = new TextEncoder();
const PAD_BLOCK = 256; // hide the exact secret length from the server
const PBKDF2_ITERATIONS = 600_000;
export const MAX_SECRET_BYTES = 16 * 1024;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKeys(linkKey: Uint8Array<ArrayBuffer>, passphrase: string) {
  let master = linkKey;
  if (passphrase) {
    const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
    master = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: linkKey, iterations: PBKDF2_ITERATIONS }, material, 256));
  }
  const hkdf = await crypto.subtle.importKey("raw", master, "HKDF", false, ["deriveKey", "deriveBits"]);
  const params = (info: string) => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: encoder.encode(info) });
  const key = await crypto.subtle.deriveKey(params("shh/v1/encrypt"), hkdf, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const auth = toBase64Url(new Uint8Array(await crypto.subtle.deriveBits(params("shh/v1/auth"), hkdf, 256)));
  return { key, auth };
}

/** Encrypts a secret. `data` and `auth` go to the server; `linkKey` goes only into the link. */
export async function seal(secret: string, passphrase = ""): Promise<{ linkKey: string; auth: string; data: string }> {
  const text = encoder.encode(secret);
  if (text.length === 0 || text.length > MAX_SECRET_BYTES) throw new RangeError("secret size");
  const padded = new Uint8Array(Math.ceil((text.length + 1) / PAD_BLOCK) * PAD_BLOCK);
  padded.set(text);
  padded[text.length] = 0x80;

  const linkKey = crypto.getRandomValues(new Uint8Array(32));
  const { key, auth } = await deriveKeys(linkKey, passphrase);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, padded));
  const data = new Uint8Array(iv.length + sealed.length);
  data.set(iv);
  data.set(sealed, iv.length);
  return { linkKey: toBase64Url(linkKey), auth, data: toBase64Url(data) };
}

/** Rebuilds the keys from a link. `auth` is sent to the server; `open` decrypts what comes back. */
export async function unlock(linkKey: string, passphrase = ""): Promise<{ auth: string; open(data: string): Promise<string> }> {
  const { key, auth } = await deriveKeys(fromBase64Url(linkKey), passphrase);
  return {
    auth,
    async open(data) {
      const bytes = fromBase64Url(data);
      const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12) }, key, bytes.subarray(12)));
      const end = padded.lastIndexOf(0x80);
      if (end < 0) throw new Error("bad padding");
      return new TextDecoder("utf-8", { fatal: true }).decode(padded.subarray(0, end));
    },
  };
}
