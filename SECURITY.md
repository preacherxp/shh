# Security

## Reporting a vulnerability

Report it privately: open the repository's **Security** tab on GitHub and select **Report a vulnerability**. Please do not open a public issue or pull request for a security problem. Include what you found, how to reproduce it, and which commit or deployment you tested.

## In scope

- The code in this repository: the server (`server.ts`), the page (`web/`), the command line client (`cli.ts`) and the build and verify scripts.
- Anything that lets someone read a secret without both the link and its passphrase, read or recover a secret after it was opened for the last time, destroyed or expired, open a link more often than the sender allowed, or get around the limit of five wrong passphrases.
- Anything that lets the sender's private link do more than read the status and destroy the secret, or lets someone without that link use the sender controls.
- Ways to make the page send a secret, link, passphrase or key anywhere, including bypasses of its Content-Security-Policy or Trusted Types.
- The deployment at `https://shh.purecode.sh` serving something other than a build of this repository.

## Out of scope

- A recipient who keeps, copies or forwards the secret after opening it.
- Someone who already holds both the link and the passphrase.
- Denial of service by volume, and reports that only say a rate limit exists or could be lower.
- Problems that need a compromised browser, operating system or browser extension on the sender's or recipient's device.

## Trust assumptions

The browser encrypts the secret, and the key stays in the part of the link after `#`, so the server stores only ciphertext it cannot read. That holds only if the JavaScript the browser runs is the code in this repository: the host, and any proxy or CDN that terminates TLS in front of it, can serve different code, so you trust them or you remove them from the picture. `bun scripts/verify-live.ts` compares a site with a build of this repository, and the command line client avoids loading code from the server at all; both are described in the [README](README.md).
