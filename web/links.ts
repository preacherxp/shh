// The two kinds of link and the wording of a secret's status, shared by the
// page and the command line client so that both read and say the same thing.
//
// recipient  /#<id>.<linkKey>[.p]      opens the secret (".p": a passphrase is needed too)
// sender     /#sender.<id>.<token>     reads the status and destroys; it cannot open anything

export const RECIPIENT_LINK = /^#([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})(\.p)?$/;
export const SENDER_LINK = /^#sender\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

export const recipientLink = (origin: string, id: string, linkKey: string) => `${origin}/#${id}.${linkKey}.p`;
export const senderLink = (origin: string, id: string, token: string) => `${origin}/#sender.${id}.${token}`;

export type Status = {
  state: "waiting" | "opened" | "destroyed" | "burned";
  opened: number;
  opensLeft: number;
  firstOpenedAt: number | null;
  lastOpenedAt: number | null;
  endedAt: number | null;
  expiresAt: number;
};

const STATES = ["waiting", "opened", "destroyed", "burned"];

/** Checks the server's answer before anything is shown from it. */
export function parseStatus(body: Record<string, unknown>): Status | null {
  const count = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0;
  const time = (value: unknown) => value === null || count(value);
  if (typeof body.state !== "string" || !STATES.includes(body.state)) return null;
  if (!count(body.opened) || !count(body.opensLeft) || !count(body.expiresAt)) return null;
  if (!time(body.firstOpenedAt) || !time(body.lastOpenedAt) || !time(body.endedAt)) return null;
  return body as Status;
}

/** One or two plain sentences for the sender. `when` turns a timestamp into words. */
export function describeStatus(status: Status, when: (ms: number) => string): string {
  const at = (ms: number | null) => (ms === null ? "an unknown time" : when(ms));
  const opened =
    status.opened === 0 ? ""
    : status.opened === 1 ? `opened once, on ${at(status.firstOpenedAt)}`
    : `opened ${status.opened} times, first on ${at(status.firstOpenedAt)} and last on ${at(status.lastOpenedAt)}`;
  const sentence = (text: string) => `${text[0]!.toUpperCase()}${text.slice(1)}.`;
  const before = opened ? sentence(`before that it was ${opened}`) : "It was never opened.";
  switch (status.state) {
    case "waiting":
      return `${opened ? sentence(opened) : "Not opened yet."} ${status.opensLeft === 1 ? "1 open" : `${status.opensLeft} opens`} left. It expires on ${when(status.expiresAt)}.`;
    case "opened":
      return `${sentence(opened || "opened")} That used the last open, so the stored secret is gone.`;
    case "destroyed":
      return `Destroyed with the sender's link on ${at(status.endedAt)}. ${before}`;
    case "burned":
      return `Destroyed on ${at(status.endedAt)} after too many wrong passphrases. ${before}`;
  }
}

export const STATUS_GONE = "This secret is gone or has expired. There is nothing left to check or destroy.";
