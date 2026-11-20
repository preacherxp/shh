import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, safeOrigin, type Io } from "./cli";
import { createApp } from "./server";
import { seal, unlock } from "./web/crypto";
import { recipientLink } from "./web/links";

const publicDir = mkdtempSync(join(tmpdir(), "shh-cli-test-"));
writeFileSync(join(publicDir, "index.html"), "<!doctype html><title>shh</title>");
afterAll(() => rmSync(publicDir, { recursive: true, force: true }));

const BASE = "http://127.0.0.1:3000";
let clock = 1_000_000;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  clock = 1_000_000;
  app = createApp({ publicDir, now: () => clock });
});
afterEach(() => app.close());

type Sent = { url: string; method: string; body: string };
/** Runs the client against the app in this process. `input` is piped standard input; `answers` are typed at the terminal. */
async function shh(args: string[], { input = null as string | null, answers = [] as string[], fetch = undefined as Io["fetch"] | undefined, timeoutMs = undefined as number | undefined } = {}) {
  const out: string[] = [], err: string[] = [], asked: Array<{ question: string; hidden: boolean }> = [], sent: Sent[] = [];
  const code = await run(args, {
    input: async () => input,
    ask: async (question, hidden) => (asked.push({ question, hidden }), answers.length ? answers.shift()! : null),
    out: (text) => void out.push(text),
    err: (text) => void err.push(text),
    fetch: fetch ?? (async (url, init) => {
      sent.push({ url, method: init.method ?? "GET", body: typeof init.body === "string" ? init.body : "" });
      return app.fetch(new Request(url, init), "203.0.113.7");
    }),
    timeoutMs,
  });
  return { code, out: out.join(""), err: err.join(""), asked, sent };
}
/** Sends a secret with the client and picks the three labelled values out of standard output. */
async function send(secret: string, args: string[] = [], answers: string[] = []) {
  const result = await shh(["send", "--url", BASE, ...args], { input: secret, answers });
  const field = (label: string) => new RegExp(`^${label}: (.+)$`, "m").exec(result.out)?.[1] ?? "";
  return { ...result, link: field("Recipient link"), passphrase: field("Passphrase"), sender: field("Sender's private link") };
}
const post = (path: string, body: object) =>
  app.fetch(new Request(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), "198.51.100.9");

test("send and open round-trip with a generated passphrase, and the link opens once", async () => {
  const sent = await send("hunter2 – zażółć gęślą jaźń 🔑\n");
  expect(sent.code).toBe(0);
  // Standard output is exactly the three labelled lines, so nothing else can be mistaken for them.
  expect(sent.out.split("\n")).toEqual([`Recipient link: ${sent.link}`, `Passphrase: ${sent.passphrase}`, `Sender's private link: ${sent.sender}`, ""]);
  expect(sent.link).toMatch(/^http:\/\/127\.0\.0\.1:3000\/#[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\.p$/);
  expect(sent.passphrase).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(sent.sender).toMatch(/^http:\/\/127\.0\.0\.1:3000\/#sender\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  expect(sent.err).toContain("opens once and expires in 5 minutes");
  expect(sent.asked).toEqual([]);

  const opened = await shh(["open"], { input: `${sent.link}\n${sent.passphrase}\n` });
  expect(opened.code).toBe(0);
  expect(opened.out).toBe("hunter2 – zażółć gęślą jaźń 🔑"); // only the secret; one trailing newline was dropped on the way in
  expect(opened.err).toBe("It has been destroyed on the server. This link will not open again.\n");

  const again = await shh(["open"], { input: `${sent.link}\n${sent.passphrase}\n` });
  expect(again.code).toBe(4);
  expect(again.out).toBe("");
  expect(again.err).toBe("This secret was already opened, or it expired. Ask the sender to share it again.\n");
});

test("a passphrase typed at the terminal is asked for twice without echo and never printed", async () => {
  const sent = await send("correct horse", ["--passphrase", "--opens", "2", "--expires", "1h"], ["tuesday afternoon", "tuesday afternoon"]);
  expect(sent.code).toBe(0);
  expect(sent.asked).toEqual([{ question: "Passphrase (hidden): ", hidden: true }, { question: "Passphrase again: ", hidden: true }]);
  expect(sent.out).not.toContain("Passphrase");
  expect(sent.out + sent.err).not.toContain("tuesday afternoon");
  expect(sent.err).toContain("opens 2 times and expires in 1 hour");

  // At a terminal: the link and the passphrase are both asked for without echo.
  const opened = await shh(["open"], { answers: [sent.link, "tuesday afternoon"] });
  expect(opened.asked).toEqual([{ question: "Link (hidden): ", hidden: true }, { question: "Passphrase (hidden): ", hidden: true }]);
  expect(opened.out).toBe("correct horse");
  expect(opened.err).toBe("This link can be opened one more time. After that the secret is destroyed.\n");

  // The link may also be an argument (the help warns about it); the passphrase is then the first piped line.
  expect((await shh(["open", sent.link], { input: "tuesday afternoon\n" })).out).toBe("correct horse");

  const mismatch = await send("correct horse", ["--passphrase"], ["tuesday", "wednesday"]);
  expect(mismatch.code).toBe(2);
  expect(mismatch.sent).toEqual([]); // nothing left this machine
  expect((await send("correct horse", ["--passphrase"])).code).toBe(2); // no terminal to ask on
});

test("a wrong passphrase reports the tries left, as the page does", async () => {
  const sent = await send("hunter2");
  const piped = await shh(["open"], { input: `${sent.link}\nnot it\n` });
  expect(piped.code).toBe(3);
  expect(piped.out).toBe("");
  expect(piped.err).toBe("Wrong passphrase. 4 tries left before the secret is destroyed.\n");

  // At a terminal it asks again, and the right passphrase still opens the secret.
  const typed = await shh(["open", sent.link], { answers: ["nope", "", "still not", sent.passphrase] });
  expect(typed.code).toBe(0);
  expect(typed.out).toBe("hunter2");
  expect(typed.err).toBe(
    "Wrong passphrase. 3 tries left before the secret is destroyed.\nType the passphrase first.\nWrong passphrase. 2 tries left before the secret is destroyed.\n" +
      "It has been destroyed on the server. This link will not open again.\n",
  );

  const burned = await send("hunter2");
  const guesses = await shh(["open", burned.link], { answers: ["a", "b", "c", "d", "e", "f"] });
  expect(guesses.code).toBe(3);
  expect(guesses.err).toEndWith("Wrong passphrase. 1 try left before the secret is destroyed.\nToo many wrong passphrases. The secret was destroyed. Ask the sender to share it again.\n");
  expect(guesses.asked.length).toBe(5);
  expect((await shh(["open"], { input: `${burned.link}\n${burned.passphrase}\n` })).code).toBe(4);
  expect((await shh(["status"], { input: burned.sender })).out).toContain("after too many wrong passphrases");

  const unattended = await send("hunter2");
  const needsTerminal = await shh(["open"], { input: `${unattended.link}\n` }); // a passphrase is needed and there is nobody to ask
  expect([needsTerminal.code, needsTerminal.err]).toEqual([2, "There is no terminal to ask on. Pipe the input instead; see shh --help.\n"]);
  expect((await shh(["open"], { input: `${unattended.link}\n${unattended.passphrase}\n` })).out).toBe("hunter2"); // and no attempt was used up
});

test("links expire for the client too", async () => {
  const sent = await send("hunter2", ["--expires", "5m"]);
  clock += 299_000;
  expect((await shh(["status"], { input: sent.sender })).code).toBe(0);
  clock += 1_000;
  const late = await shh(["open"], { input: `${sent.link}\n${sent.passphrase}\n` });
  expect(late.code).toBe(4);
  expect(late.asked).toEqual([]); // it does not ask for a passphrase it cannot use
  const status = await shh(["status"], { input: sent.sender });
  expect(status.code).toBe(4);
  expect(status.err).toBe("This secret is gone or has expired. There is nothing left to check or destroy.\n");
  expect((await shh(["destroy", "--yes"], { input: sent.sender })).code).toBe(4);
});

test("expiry and opens match what the server allows", async () => {
  for (const [expires, seconds] of [["5m", 300], ["1h", 3600], ["1d", 86_400], ["7d", 604_800]] as const) {
    const sent = await send("hunter2", ["-e", expires, "-n", "10"]);
    const id = /#sender\.([^.]+)\.(.+)$/.exec(sent.sender)!;
    expect(await (await post(`/api/secrets/${id[1]}/status`, { sender: id[2] })).json()).toMatchObject({ state: "waiting", opensLeft: 10, expiresAt: clock + seconds * 1000 });
  }
  for (const bad of [["--expires", "2h"], ["--expires", "300"], ["--opens", "0"], ["--opens", "11"], ["--opens", "two"], ["--opens", "1.5"], ["--bogus"], ["--expires"]]) {
    const refused = await send("hunter2", bad);
    expect([bad, refused.code, refused.sent]).toEqual([bad, 2, []]);
  }
});

test("status and destroy work with the sender's private link", async () => {
  const sent = await send("hunter2", ["--opens", "3"]);
  const waiting = await shh(["status"], { input: `${sent.sender}\n` });
  expect(waiting.code).toBe(0);
  expect(waiting.out).toStartWith("Not opened yet. 3 opens left. It expires on ");
  expect((await shh(["status"], { answers: [sent.sender] })).asked).toEqual([{ question: "Sender's private link (hidden): ", hidden: true }]);

  await shh(["open"], { input: `${sent.link}\n${sent.passphrase}\n` });
  expect((await shh(["status", sent.sender])).out).toMatch(/^Opened once, on .+\. 2 opens left\. It expires on .+\.\n$/);

  // destroy asks first: anything but "yes" leaves the secret alone, and without a terminal --yes is required.
  const declined = await shh(["destroy"], { input: sent.sender, answers: ["no"] });
  expect(declined.code).toBe(1);
  expect(declined.asked).toEqual([{ question: "Destroy this secret now? The link stops working for everyone, and this cannot be undone. Type yes to confirm: ", hidden: false }]);
  expect(declined.err).toBe("Nothing was destroyed.\n");
  expect(declined.sent).toEqual([]);
  const unattended = await shh(["destroy"], { input: sent.sender });
  expect(unattended.code).toBe(2);
  expect(unattended.sent).toEqual([]);
  expect((await shh(["status", sent.sender])).out).toContain("2 opens left");

  const destroyed = await shh(["destroy"], { input: sent.sender, answers: ["Yes"] });
  expect(destroyed.code).toBe(0);
  expect(destroyed.out).toMatch(/^Destroyed with the sender's link on .+\. Before that it was opened once, on .+\.\n$/);
  expect((await shh(["destroy", "--yes"], { input: sent.sender })).out).toBe(destroyed.out); // again: same answer
  expect((await shh(["status"], { input: sent.sender })).out).toBe(destroyed.out);
  expect((await shh(["open"], { input: `${sent.link}\n${sent.passphrase}\n` })).code).toBe(4);

  // Each link only does its own job, and the client says which is which without sending anything.
  const mixedUp = await shh(["open"], { input: sent.sender });
  expect([mixedUp.code, mixedUp.sent]).toEqual([2, []]);
  expect(mixedUp.err).toContain("It cannot open the secret");
  const other = await send("hunter2");
  const wrongWay = await shh(["destroy", "--yes"], { input: other.link });
  expect([wrongWay.code, wrongWay.sent]).toEqual([2, []]);
  expect((await shh(["open"], { input: `${other.link}\n${other.passphrase}\n` })).out).toBe("hunter2");
});

test("links made by the page open in the client, and links made by the client open in the page", async () => {
  // The page's path: seal() in the browser, POST, then the link is put together by recipientLink().
  const sealed = await seal("from the page", "tuesday");
  const created = (await (await post("/api/secrets", { data: sealed.data, auth: sealed.auth, ttl: 3600, opens: 1 })).json()) as { id: string };
  const fromPage = await shh(["open"], { input: `${recipientLink(BASE, created.id, sealed.linkKey)}\ntuesday\n` });
  expect([fromPage.code, fromPage.out]).toEqual([0, "from the page"]);

  // A link issued before passphrases became the default: no ".p", so nothing is asked.
  const old = await seal("from an old link");
  const legacy = (await (await post("/api/secrets", { data: old.data, auth: old.auth, ttl: 3600 })).json()) as { id: string };
  const fromOld = await shh(["open"], { input: `${BASE}/#${legacy.id}.${old.linkKey}` });
  expect([fromOld.code, fromOld.out, fromOld.asked]).toEqual([0, "from an old link", []]);

  // The page's path for opening: split the fragment as the page does, unlock(), POST the proof, open().
  const sent = await send("from the client");
  const [, id, linkKey, needsPassphrase] = /^#([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})(\.p)?$/.exec(new URL(sent.link).hash)!;
  expect(needsPassphrase).toBe(".p");
  const keys = await unlock(linkKey!, sent.passphrase);
  const revealed = (await (await post(`/api/secrets/${id}/reveal`, { auth: keys.auth })).json()) as { data: string };
  expect(await keys.open(revealed.data)).toBe("from the client");
});

test("only https servers are talked to, except this machine", async () => {
  expect(safeOrigin("https://shh.purecode.sh")).toBe("https://shh.purecode.sh");
  expect(safeOrigin("https://shh.example:8443/")).toBe("https://shh.example:8443");
  expect(safeOrigin("http://localhost:3000")).toBe("http://localhost:3000");
  expect(safeOrigin("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000");
  for (const bad of ["http://shh.purecode.sh", "http://localhost.example.com", "http://127.0.0.1.example.com", "http://192.168.1.5:3000", "ftp://localhost", "https://user:pw@shh.example", "https://shh.example/path", "https://shh.example/?a=1", "shh.example", ""]) {
    expect([bad, safeOrigin(bad)]).toEqual([bad, null]);
  }

  const plain = await shh(["send", "--url", "http://shh.example"], { input: "hunter2" });
  expect([plain.code, plain.sent]).toEqual([2, []]);
  for (const command of ["open", "status", "destroy"]) {
    const link = command === "open" ? `http://shh.example/#${"a".repeat(22)}.${"b".repeat(43)}.p` : `http://shh.example/#sender.${"a".repeat(22)}.${"b".repeat(43)}`;
    const refused = await shh([command, "--yes"], { input: link });
    expect([command, refused.code, refused.sent]).toEqual([command, 2, []]);
    expect(refused.err).toBe("That link does not point to an https shh server, so nothing was sent to it.\n");
  }
});

test("the secret never comes from an argument, and help and usage errors behave", async () => {
  const argument = await shh(["send", "hunter2", "--url", BASE]);
  expect([argument.code, argument.sent]).toEqual([2, []]);
  expect(argument.err).not.toContain("hunter2");
  expect((await shh(["send", "--url", BASE], { input: "" })).code).toBe(2);
  expect((await shh(["send", "--url", BASE], { input: "a".repeat(16 * 1024 + 1) })).code).toBe(2);
  const typed = await shh(["send", "--url", BASE], { answers: ["typed at the terminal"] }); // standard input is a terminal
  expect(typed.asked).toEqual([{ question: "Secret (hidden, one line): ", hidden: true }]);
  expect(typed.code).toBe(0);

  const help = await shh(["--help"]);
  expect([help.code, help.err]).toEqual([0, ""]);
  expect(help.out).toContain("it stays in your shell history and shows in the\n         process list"); // the warning about a LINK argument
  expect(help.out).toContain("Exit codes: 0 done, 1 failed, 2 wrong usage, 3 wrong passphrase, 4 gone, expired or destroyed.");
  const bare = await shh([]);
  expect([bare.code, bare.out]).toEqual([2, ""]);
  expect((await shh(["frobnicate"])).code).toBe(2);
  expect((await shh(["open", "a", "b"])).code).toBe(2);
  for (const junk of ["not a link", `${BASE}/#too-short`, `${BASE}/`]) expect((await shh(["open"], { input: junk })).code).toBe(2);
});

test("timeouts and network failures end cleanly, and an older server without sender links still works", async () => {
  const never: Io["fetch"] = (_url, init) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)));
  const slow = await shh(["send", "--url", BASE], { input: "hunter2", fetch: never, timeoutMs: 30 });
  expect([slow.code, slow.out, slow.err]).toEqual([1, "", "The server did not answer in time. Try again.\n"]);

  const down = await shh(["send", "--url", BASE], { input: "hunter2", fetch: async (url) => { throw new Error(`connect ECONNREFUSED ${url}`); } });
  expect([down.code, down.out, down.err]).toEqual([1, "", "Could not reach the server. Check the address and your connection.\n"]);

  const requests: RequestInit[] = [];
  const older = await shh(["send", "--url", BASE], { input: "hunter2", fetch: async (_url, init) => (requests.push(init), Response.json({ id: "a".repeat(22) }, { status: 201 })) });
  expect(older.code).toBe(0);
  expect(older.out.split("\n").map((line) => line.split(": ")[0])).toEqual(["Recipient link", "Passphrase", ""]);
  expect(older.err).toContain("no sender's private link");
  expect(requests[0]!.redirect).toBe("error"); // a redirect is never followed

  for (const [status, words] of [[429, "Too many requests"], [503, "full right now"], [500, "did not accept"]] as const) {
    const refused = await shh(["send", "--url", BASE], { input: "hunter2", fetch: async () => Response.json({ error: "x" }, { status }) });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(words);
  }
});

test("no secret, passphrase or key appears in a request address, an error message or the wrong stream", async () => {
  const secret = "s3cret-value-that-must-not-leak";
  const phrase = "a-passphrase-that-must-not-leak";
  const sent = await send(secret, ["--passphrase"], [phrase, phrase]);
  const [, , linkKey] = /^#([^.]+)\.([^.]+)\.p$/.exec(new URL(sent.link).hash)!;
  const [, , senderToken] = /^#sender\.([^.]+)\.(.+)$/.exec(new URL(sent.sender).hash)!;
  const private_ = [secret, phrase, linkKey!, senderToken!];

  const failing: Io["fetch"] = async (url, init) => { throw new Error(`boom ${url} ${String(init.body)}`); };
  const runs = [
    sent,
    await shh(["status"], { input: sent.sender }),
    await shh(["open"], { input: `${sent.link}\nwrong-${phrase}\n` }),
    await shh(["open", sent.link], { answers: [`also-wrong-${phrase}`, phrase] }),
    await shh(["destroy", "--yes"], { input: sent.sender }),
    await shh(["open"], { input: `${sent.link}\n${phrase}\n` }),
    await shh(["open"], { input: `${sent.link}\n${phrase}\n`, fetch: failing }),
    await shh(["status", sent.sender], { fetch: failing }),
    await shh(["send", "--url", BASE, "--passphrase"], { input: secret, answers: [phrase, phrase], fetch: failing }),
    await shh(["send", secret]),
    await shh(["open", sent.link.replace("#", "#x")]),
    await shh(["status", sent.link]),
    await shh(["open", sent.sender]),
    await shh(["open", `http://shh.example/${new URL(sent.link).hash}`]),
    await shh(["--bogus", secret]),
  ];
  for (const [index, result] of runs.entries()) {
    for (const value of private_) expect([index, result.err.includes(value)]).toEqual([index, false]); // standard error never carries any of them
    for (const request of result.sent) {
      expect(new URL(request.url).search).toBe("");
      expect(new URL(request.url).hash).toBe("");
      for (const value of private_) expect(request.url).not.toContain(value); // only the id is ever in a path
      for (const value of [secret, phrase, linkKey!]) expect(request.body).not.toContain(value); // the server never gets these at all
      if (!/\/(status|destroy)$/.test(request.url)) expect(request.body).not.toContain(senderToken!);
    }
  }
  // Standard output carries a secret only for a successful open, and links only for send.
  expect(runs.map((result) => result.out.includes(secret))).toEqual([false, false, false, true, false, false, false, false, false, false, false, false, false, false, false]);
  expect(runs.slice(1).some((result) => result.out.includes(linkKey!) || result.out.includes(senderToken!) || result.out.includes(phrase))).toBe(false);
});

test("the real command reads standard input, talks over HTTP and sets its exit code", async () => {
  const live = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req, srv) => app.fetch(req, srv.requestIP(req)?.address) });
  const cli = async (args: string[], stdin: string) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), ...args], { stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, err, code };
  };
  try {
    const sent = await cli(["send", "--url", `http://127.0.0.1:${live.port}`], "hunter2\n");
    expect(sent.code).toBe(0);
    const [link, passphrase, sender] = sent.out.trimEnd().split("\n").map((line) => line.slice(line.indexOf(": ") + 2));
    expect((await cli(["status"], sender!)).out).toStartWith("Not opened yet. 1 open left.");
    expect(await cli(["open"], `${link}\nwrong\n`)).toMatchObject({ code: 3, out: "" });
    expect(await cli(["open"], `${link}\n${passphrase}\n`)).toMatchObject({ code: 0, out: "hunter2" });
    expect((await cli(["open"], `${link}\n${passphrase}\n`)).code).toBe(4);
    expect((await cli(["--help"], "")).out).toStartWith("shh: share a secret");
    expect((await cli(["send", "--url", "http://shh.example"], "hunter2")).code).toBe(2);
  } finally {
    await live.stop(true);
  }
});
