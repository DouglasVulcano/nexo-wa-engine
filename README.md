# nexo-wa-engine

WhatsApp engine for [Nexo](https://nexofordev.com). It wraps [Baileys](https://github.com/WhiskeySockets/Baileys) (pinned) and runs as an Electron `utilityProcess`, talking to Nexo only through the versioned message protocol below.

Copyright (C) 2026 Douglas Vulcano.

**License: GPL-3.0-only.** The bundle includes `libsignal` (GPL-3.0). Nexo itself is proprietary and does not contain this code: the app downloads the release asset of this repository on first use and starts it as a separate process. The full license text is in [LICENSE](LICENSE); third-party notices (every bundled dependency and its license text) are in `THIRD_PARTY_LICENSES.txt` inside each release.

This is an unofficial client of the WhatsApp Web protocol. It can break when WhatsApp changes the protocol and the linked number can be restricted; use is meant for 1:1 conversations with people who already talk to you. Using an unofficial client may violate the WhatsApp Terms of Service. This project is not affiliated with, sponsored or endorsed by WhatsApp or Meta; WhatsApp is a trademark of Meta Platforms, Inc.

## Build

```
npm install
npm run build      # dist/wa-baileys.mjs + dist/manifest.json
npm run typecheck
npm run pack       # dist/wa-baileys-<version>.tgz, prints size and SHA-256
```

The bundle is one ESM file with every dependency inlined and Node built-ins only (no native modules; `sharp` and `@img/*` are not installed, see `.npmrc`). Release asset name: `wa-baileys-<version>.tgz`, URL `https://github.com/DouglasVulcano/nexo-wa-engine/releases/download/v<version>/wa-baileys-<version>.tgz`.

Archive root: `manifest.json`, `wa-baileys.mjs`, `wa-baileys.mjs.LEGAL.txt`, `THIRD_PARTY_LICENSES.txt`, `LICENSE`, `README.md`.

`manifest.json`: `{ "engine": "wa-baileys", "version", "protocol", "baileys", "entry" }`. The app starts `entry` only if `protocol` equals its own.

## Protocol (version 1)

The app forks `entry` with `utilityProcess.fork` and exchanges JSON messages over the process port. The engine never imports from the app and has no database, vault or listener: it talks to WhatsApp servers and to the app only. The authoritative types are in [`src/protocol.ts`](src/protocol.ts); any incompatible change bumps `PROTOCOL_VERSION`.

Wire messages (`WireMessage`):

| `t` | direction | payload |
| --- | --- | --- |
| `ready` | engine to app, once at boot | `protocol`, `engine`, `version` |
| `call` | both ways | `rid`, `method`, `args` |
| `ret` | answer to a `call` | `rid`, `ok: true, value` or `ok: false, code, message` |
| `event` | engine to app | one `EngineEvent` |

Calls the app makes (`EngineCalls`): `start({pairingPhone?})`, `stop`, `logout`, `sendText({to, text, options})`, `revoke({to, messageId})`, `presence({to, presence})`, `subscribe({to})`, `markRead({to, ids})`, `lookup({phone})`, `profilePic({to})`. Calls fail with code `not-connected` until the socket is open.

Calls the engine makes (`AppCalls`), to persist the Signal session that the app encrypts and stores: `auth:get({scope, names})`, `auth:set({entries})`, `auth:clear`, `auth:paired({paired})`. Values are opaque strings.

Events (`EngineEvent`): `connection` (status `starting | qr | connecting | connected | reconnecting | closed | logged-out | error`, own number, attempt, error), `qr` (raw QR string or pairing code, expiry), `message`, `status` (ticks), `delete`, `presence`, `identity` (PN to LID), `contact-update`, `sync`. Messages are normalized (kind, text, media metadata, quote, status); raw WhatsApp payloads never leave the engine. Addresses are `{ jid, lid, phone }` with any field possibly null.

Message content is never logged: the Baileys logger is silent and the app forks the process without stdio.
