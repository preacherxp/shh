import { expect, test } from "bun:test";
import { describeStatus, parseStatus, RECIPIENT_LINK, recipientLink, SENDER_LINK, senderLink, type Status } from "./links";

const id = "a".repeat(22), key = "b".repeat(43);
const when = (ms: number) => `T${ms}`;
const base: Status = { state: "waiting", opened: 0, opensLeft: 1, firstOpenedAt: null, lastOpenedAt: null, endedAt: null, expiresAt: 9 };

test("the two kinds of link cannot be mistaken for each other", () => {
  const recipient = new URL(recipientLink("https://shh.example", id, key));
  const sender = new URL(senderLink("https://shh.example", id, key));
  expect(RECIPIENT_LINK.exec(recipient.hash)?.slice(1)).toEqual([id, key, ".p"]);
  expect(SENDER_LINK.exec(sender.hash)?.slice(1)).toEqual([id, key]);
  expect(RECIPIENT_LINK.test(sender.hash)).toBe(false); // a page from before sender links calls it incomplete, and sends nothing
  expect(SENDER_LINK.test(recipient.hash)).toBe(false);
  expect(RECIPIENT_LINK.exec(`#${id}.${key}`)?.[3]).toBeUndefined(); // links issued before passphrases still parse
  for (const link of [recipient, sender]) expect([link.pathname, link.search]).toEqual(["/", ""]); // everything sensitive is in the fragment
});

test("every state is described in plain words", () => {
  expect(describeStatus(base, when)).toBe("Not opened yet. 1 open left. It expires on T9.");
  expect(describeStatus({ ...base, opened: 2, opensLeft: 3, firstOpenedAt: 1, lastOpenedAt: 2 }, when)).toBe("Opened 2 times, first on T1 and last on T2. 3 opens left. It expires on T9.");
  expect(describeStatus({ ...base, state: "opened", opened: 1, opensLeft: 0, firstOpenedAt: 1, lastOpenedAt: 1, endedAt: 1 }, when)).toBe("Opened once, on T1. That used the last open, so the stored secret is gone.");
  expect(describeStatus({ ...base, state: "destroyed", opensLeft: 0, endedAt: 5 }, when)).toBe("Destroyed with the sender's link on T5. It was never opened.");
  expect(describeStatus({ ...base, state: "destroyed", opened: 1, opensLeft: 0, firstOpenedAt: 1, lastOpenedAt: 1, endedAt: 5 }, when)).toBe("Destroyed with the sender's link on T5. Before that it was opened once, on T1.");
  expect(describeStatus({ ...base, state: "burned", opensLeft: 0, endedAt: 5 }, when)).toBe("Destroyed on T5 after too many wrong passphrases. It was never opened.");
});

test("a status is only shown when the server's answer has the expected shape", () => {
  expect(parseStatus({ ...base })).toEqual(base);
  expect(parseStatus({ ...base, firstOpenedAt: 1, lastOpenedAt: 2, endedAt: 3 })).not.toBeNull();
  for (const bad of [{ state: "open" }, { state: undefined }, { opened: -1 }, { opened: "1" }, { opensLeft: 1.5 }, { expiresAt: null }, { firstOpenedAt: "now" }, { endedAt: {} }]) {
    expect([bad, parseStatus({ ...base, ...bad })]).toEqual([bad, null]);
  }
  expect(parseStatus({ error: "gone" })).toBeNull();
});
