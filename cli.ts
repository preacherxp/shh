#!/usr/bin/env bun
// shh from the command line: the same encryption (web/crypto.ts) and the same API as the
// page, without loading any JavaScript from the server. No dependencies.
import { closeSync, openSync, writeSync } from "node:fs";
import { parseArgs } from "node:util";
import { MAX_SECRET_BYTES, seal, toBase64Url, unlock } from "./web/crypto";
import { describeStatus, parseStatus, RECIPIENT_LINK, recipientLink, SENDER_LINK, senderLink, STATUS_GONE } from "./web/links";

const DEFAULT_URL = "https://shh.purecode.sh";
const TTLS: Record<string, [seconds: number, words: string]> = { "5m": [300, "5 minutes"], "1h": [3600, "1 hour"], "1d": [86_400, "1 day"], "7d": [604_800, "7 days"] };
const EXIT = { done: 0, failed: 1, usage: 2, wrong: 3, gone: 4 };

const HELP = `shh: share a secret through a link that expires and opens once.
The secret is encrypted on this machine. The server only stores ciphertext.

Usage:
  shh send    [--expires 5m|1h|1d|7d] [--opens 1-10] [--passphrase] [--url URL]
  shh open    [LINK]
  shh status  [SENDER-LINK]
  shh destroy [SENDER-LINK] [--yes]

send     Reads the secret from standard input, never from an argument:
           printf %s "$TOKEN" | shh send --expires 1h
         At a terminal it asks for one hidden line instead. One trailing newline is dropped.
         Prints the recipient link, the passphrase and the sender's private link, one per
         line, each with a label. Everything else goes to standard error.
open     Asks for the link without echo, then for the passphrase without echo, and prints
         only the secret to standard output. When standard input is piped, the link is
         read from its first line and the passphrase from the next one.
         A LINK argument also works, but it stays in your shell history and shows in the
         process list, where other users of this machine can read it. Prefer the prompt.
status   Shows whether the secret was opened. Takes the sender's private link like open does.
destroy  Destroys the secret now, opened or not. Asks first unless --yes is given.

Options:
  -e, --expires     when the link expires: 5m, 1h, 1d or 7d (default 5m)
  -n, --opens       how many times it can be opened: 1 to 10 (default 1)
  -p, --passphrase  ask for your own passphrase without echo, instead of generating one
  -u, --url         the server to send to (default ${DEFAULT_URL}); https only,
                    except http://localhost and http://127.0.0.1
  -y, --yes         destroy without asking
  -h, --help        show this help

Exit codes: 0 done, 1 failed, 2 wrong usage, 3 wrong passphrase, 4 gone, expired or destroyed.
The hidden prompts need a terminal on macOS or Linux; piped input works everywhere.
`;

export type Io = {
  /** Everything piped to standard input, or null when standard input is a terminal. */
  input(): Promise<string | null>;
  /** One line typed at the terminal (not standard input); null when there is no terminal. */
  ask(question: string, hidden: boolean): Promise<string | null>;
  out(text: string): void;
  err(text: string): void;
  fetch(url: string, init: RequestInit): Promise<Response>;
  timeoutMs?: number;
};

/** The origin to talk to, or null unless it is https. Plain http is allowed for this machine only. */
export function safeOrigin(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (url.username || url.password || url.pathname !== "/" || url.search) return null;
  return url.origin;
}

class Stop extends Error {
  constructor(readonly code: number, readonly say: string) {
    super("stop"); // the words are for the person; nothing secret is ever put in them
  }
}

export async function run(argv: string[], io: Io): Promise<number> {
  try {
    return await main(argv, io);
  } catch (error) {
    // Deliberately not the error's own text: it could quote a link or an address.
    io.err(`${error instanceof Stop ? error.say : "Something went wrong. Nothing more was sent."}\n`);
    return error instanceof Stop ? error.code : EXIT.failed;
  }
}

async function main(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        expires: { type: "string", short: "e", default: "5m" },
        opens: { type: "string", short: "n", default: "1" },
        passphrase: { type: "boolean", short: "p", default: false },
        url: { type: "string", short: "u", default: DEFAULT_URL },
        yes: { type: "boolean", short: "y", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch {
    throw new Stop(EXIT.usage, "Unknown or incomplete option. Run shh --help.");
  }
  const { values: options, positionals } = parsed;
  const [command, argument, ...extra] = positionals;
  if (options.help || command === "help") return io.out(HELP), EXIT.done;
  if (!command) return io.err(HELP), EXIT.usage;
  if (extra.length) throw new Stop(EXIT.usage, "Too many arguments. Run shh --help.");

  const api = async (base: string, path: string, body?: unknown) => {
    let response: Response;
    try {
      response = await io.fetch(`${base}${path}`, {
        method: body ? "POST" : "GET",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error", // never follow the request somewhere else
        signal: AbortSignal.timeout(io.timeoutMs ?? 20_000),
      });
    } catch (error) {
      const late = error instanceof Error && error.name === "TimeoutError";
      throw new Stop(EXIT.failed, late ? "The server did not answer in time. Try again." : "Could not reach the server. Check the address and your connection.");
    }
    const answer: unknown = await response.json().catch(() => null);
    const fields = answer && typeof answer === "object" ? (answer as Record<string, unknown>) : {};
    if (response.status === 429) throw new Stop(EXIT.failed, "Too many requests from your network. Wait a minute and try again.");
    if (response.status === 503) throw new Stop(EXIT.failed, "The server is full right now. Try again later.");
    return { status: response.status, body: fields };
  };

  // Piped input is read once, and only when something is actually needed from it.
  let piped: string[] | null | undefined;
  const nextLine = async (): Promise<string | undefined> => {
    if (piped === undefined) piped = (await io.input())?.split(/\r?\n/) ?? null;
    return piped?.shift() || undefined;
  };
  const need = async (question: string, hidden = true): Promise<string> => {
    const answer = await io.ask(question, hidden);
    if (answer === null) throw new Stop(EXIT.usage, "There is no terminal to ask on. Pipe the input instead; see shh --help.");
    return answer;
  };
  /** Takes a link from the argument, the pipe or a hidden prompt, and splits it. Never echoes it back. */
  const takeLink = async (pattern: RegExp, question: string, wrongKind: string) => {
    const text = (argument ?? (await nextLine()) ?? (await need(question))).trim();
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new Stop(EXIT.usage, "That is not a shh link. Copy the whole link again.");
    }
    const base = safeOrigin(url.origin + url.pathname + url.search);
    if (!base) throw new Stop(EXIT.usage, "That link does not point to an https shh server, so nothing was sent to it.");
    const match = pattern.exec(url.hash);
    if (!match && (pattern === SENDER_LINK ? RECIPIENT_LINK : SENDER_LINK).test(url.hash)) throw new Stop(EXIT.usage, wrongKind);
    if (!match) throw new Stop(EXIT.usage, "That link is incomplete. Copy the whole link again.");
    return { base, id: match[1]!, key: match[2]!, needsPassphrase: !!match[3] };
  };
  const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  if (command === "send") {
    if (argument !== undefined) throw new Stop(EXIT.usage, "send reads the secret from standard input, never from an argument. Run shh --help.");
    const ttl = TTLS[options.expires];
    const opens = Number(options.opens);
    if (!ttl) throw new Stop(EXIT.usage, "--expires must be 5m, 1h, 1d or 7d.");
    if (!/^\d+$/.test(options.opens) || opens < 1 || opens > 10) throw new Stop(EXIT.usage, "--opens must be a number from 1 to 10.");
    const base = safeOrigin(options.url);
    if (!base) throw new Stop(EXIT.usage, "--url must be an https address (http only for localhost or 127.0.0.1), without a path.");

    const given = await io.input();
    const secret = given === null ? await need("Secret (hidden, one line): ") : given.replace(/\r?\n$/, "");
    if (!secret) throw new Stop(EXIT.usage, "There is no secret on standard input. Nothing was sent.");
    if (new TextEncoder().encode(secret).length > MAX_SECRET_BYTES) throw new Stop(EXIT.usage, "That is too long. The limit is 16 KB of text.");

    let phrase = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    if (options.passphrase) {
      phrase = await need("Passphrase (hidden): ");
      if (!phrase) throw new Stop(EXIT.usage, "The passphrase was empty. Nothing was sent.");
      if ((await need("Passphrase again: ")) !== phrase) throw new Stop(EXIT.usage, "The two passphrases differ. Nothing was sent.");
    }

    const { linkKey, auth, data } = await seal(secret, phrase);
    const result = await api(base, "/api/secrets", { data, auth, ttl: ttl[0], opens });
    const { id, sender } = result.body;
    if (result.status !== 201 || typeof id !== "string") throw new Stop(EXIT.failed, "The server did not accept the secret. Nothing was shared.");

    io.out(`Recipient link: ${recipientLink(base, id, linkKey)}\n`);
    if (!options.passphrase) io.out(`Passphrase: ${phrase}\n`);
    if (typeof sender === "string") io.out(`Sender's private link: ${senderLink(base, id, sender)}\n`);
    io.err(
      `Sealed. The link opens ${opens === 1 ? "once" : `${opens} times`} and expires in ${ttl[1]}, opened or not.\n` +
        `Send the ${options.passphrase ? "passphrase you typed" : "passphrase"} through a different, verified channel.\n` +
        (typeof sender === "string"
          ? "Keep the sender's private link for yourself: it shows whether the secret was opened and can destroy it. It cannot open the secret.\n"
          : "This server is older and gave no sender's private link, so there is no status or destroy for this secret.\n"),
    );
    return EXIT.done;
  }

  if (command === "open") {
    const link = await takeLink(RECIPIENT_LINK, "Link (hidden): ", "That is a sender's private link. It cannot open the secret; use shh status or shh destroy with it.");
    const gone = "This secret was already opened, or it expired. Ask the sender to share it again.";
    if ((await api(link.base, `/api/secrets/${link.id}`)).status === 404) throw new Stop(EXIT.gone, gone);
    for (;;) {
      let phrase = "";
      let typed = false;
      if (link.needsPassphrase) {
        const line = await nextLine();
        typed = line === undefined;
        phrase = line ?? (await need("Passphrase (hidden): "));
        if (!phrase) {
          io.err("Type the passphrase first.\n");
          continue;
        }
      }
      const keys = await unlock(link.key, phrase);
      const result = await api(link.base, `/api/secrets/${link.id}/reveal`, { auth: keys.auth });
      const left = Number(result.body.remaining) || 0;
      if (result.status === 200 && typeof result.body.data === "string") {
        const secret = await keys.open(result.body.data).catch(() => {
          throw new Stop(EXIT.failed, "The server's answer could not be decrypted. One open was used.");
        });
        io.out(secret);
        io.err(left ? `This link can be opened ${left === 1 ? "one more time" : `${left} more times`}. After that the secret is destroyed.\n` : "It has been destroyed on the server. This link will not open again.\n");
        return EXIT.done;
      }
      if (result.status === 404) throw new Stop(EXIT.gone, gone);
      if (result.status !== 403) throw new Stop(EXIT.failed, "Something went wrong. The secret is still safe. Try again.");
      if (left === 0) throw new Stop(EXIT.wrong, "Too many wrong passphrases. The secret was destroyed. Ask the sender to share it again.");
      const warning = `Wrong passphrase. ${left} ${left === 1 ? "try" : "tries"} left before the secret is destroyed.`;
      if (!typed) throw new Stop(EXIT.wrong, warning); // a piped passphrase is not asked for again
      io.err(`${warning}\n`);
    }
  }

  if (command === "status" || command === "destroy") {
    const link = await takeLink(SENDER_LINK, "Sender's private link (hidden): ", "That is the recipient's link. status and destroy need the sender's private link.");
    if (command === "destroy" && !options.yes) {
      const answer = await io.ask("Destroy this secret now? The link stops working for everyone, and this cannot be undone. Type yes to confirm: ", false);
      if (answer === null) throw new Stop(EXIT.usage, "There is no terminal to confirm on. Use --yes to destroy without asking.");
      if (answer.trim().toLowerCase() !== "yes") throw new Stop(EXIT.failed, "Nothing was destroyed.");
    }
    const result = await api(link.base, `/api/secrets/${link.id}/${command}`, { sender: link.key });
    const status = result.status === 200 ? parseStatus(result.body) : null;
    if (status) return io.out(`${describeStatus(status, when)}\n`), EXIT.done;
    if (result.status === 404) throw new Stop(EXIT.gone, STATUS_GONE);
    throw new Stop(EXIT.failed, command === "destroy" ? "Could not destroy it. Try again." : "Could not check the status. Try again.");
  }

  throw new Stop(EXIT.usage, "Unknown command. Run shh --help.");
}

/** One line from the terminal itself, which works even when standard input is a pipe. */
async function askTerminal(question: string, hidden: boolean): Promise<string | null> {
  let tty: number;
  try {
    tty = openSync("/dev/tty", "r+");
  } catch {
    return null;
  }
  try {
    writeSync(tty, question);
    // The shell turns echo off and always turns it back on, also after Ctrl-C.
    const read = `IFS= read -r line || exit 1; printf %s "$line"`;
    const script = hidden ? `saved=$(stty -g) || exit 1; trap 'stty "$saved"' EXIT; trap 'exit 130' INT TERM HUP; stty -echo; ${read}` : read;
    const child = Bun.spawn(["/bin/sh", "-c", script], { stdin: tty, stdout: "pipe", stderr: "ignore" });
    const [answer, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (hidden) writeSync(tty, "\n");
    return code === 0 ? answer : null;
  } finally {
    closeSync(tty);
  }
}

if (import.meta.main) {
  let wrote = "";
  process.exitCode = await run(process.argv.slice(2), {
    input: async () => (process.stdin.isTTY ? null : await Bun.stdin.text()),
    ask: askTerminal,
    out: (text) => {
      wrote = text;
      writeSync(1, text);
    },
    err: (text) => {
      // Keep a secret printed on a terminal apart from the note that follows it.
      if (process.stdout.isTTY && wrote && !wrote.endsWith("\n")) writeSync(2, "\n");
      wrote = "\n";
      writeSync(2, text);
    },
    fetch: (url, init) => fetch(url, init),
  });
}
