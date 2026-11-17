import { expect, test } from "bun:test";
import { fromBase64Url, MAX_SECRET_BYTES, seal, unlock } from "./crypto";

test("a sealed secret opens with the link key", async () => {
  const secret = "hunter2 – zażółć gęślą jaźń 🔑";
  const sealed = await seal(secret);
  const keys = await unlock(sealed.linkKey);
  expect(keys.auth).toBe(sealed.auth);
  expect(await keys.open(sealed.data)).toBe(secret);
});

test("a passphrase is required when one was set", async () => {
  const sealed = await seal("hunter2", "tuesday");
  const right = await unlock(sealed.linkKey, "tuesday");
  expect(right.auth).toBe(sealed.auth);
  expect(await right.open(sealed.data)).toBe("hunter2");

  for (const guess of ["", "wednesday"]) {
    const wrong = await unlock(sealed.linkKey, guess);
    expect(wrong.auth).not.toBe(sealed.auth);
    await expect(wrong.open(sealed.data)).rejects.toThrow();
  }
});

test("the wrong link key cannot open a secret", async () => {
  const sealed = await seal("hunter2");
  const other = await seal("something else");
  await expect((await unlock(other.linkKey)).open(sealed.data)).rejects.toThrow();
});

test("every secret gets its own key, and nothing sent to the server contains it", async () => {
  const first = await seal("hunter2");
  const second = await seal("hunter2");
  expect(first.linkKey).not.toBe(second.linkKey);
  expect(first.data).not.toBe(second.data);
  expect(first.auth).not.toBe(first.linkKey);
  expect(first.data).not.toContain(first.linkKey);
});

test("ciphertext length hides the secret length", async () => {
  const short = await seal("a");
  const longer = await seal("a".repeat(200));
  expect(fromBase64Url(short.data).length).toBe(12 + 256 + 16);
  expect(longer.data.length).toBe(short.data.length);
});

test("empty and oversized secrets are refused", async () => {
  await expect(seal("")).rejects.toThrow(RangeError);
  await expect(seal("a".repeat(MAX_SECRET_BYTES + 1))).rejects.toThrow(RangeError);
  const biggest = await seal("a".repeat(MAX_SECRET_BYTES));
  expect(biggest.data.length).toBeLessThanOrEqual(24_000); // the server's limit
});
