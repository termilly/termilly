# Phone check-in — threat model and design

Phone check-in lets you look at your terminals from a phone on the same network: which ones are working, which
agents wait for you, and their recent output. If you allow it, the phone can also answer an agent's permission
prompt. It is **off by default**.

## What it protects

- The contents of your terminals: output, commands, folder names.
- Control of your terminals: anything that types into them.

## Who it defends against

| Adversary | Defence |
|---|---|
| Anyone on the internet | Nothing listens until you turn it on. When it is on, it listens only on your local network address. There's no relay, no cloud service, no port forwarding and no UPnP. |
| A device on your network that isn't paired | Every API request must be encrypted and authenticated with a key that only paired phones have. Anything else gets an empty `403`. The page the server hands out holds no data. |
| Someone listening on the Wi-Fi (passive) | Every request and answer is sealed with AES-256-GCM using the phone's own key. The key is never sent over the network: it travels inside the QR code, in the URL **fragment** (`#…`), which browsers don't send to the server. |
| Replaying a captured request | Each request carries a timestamp, which must be within 60 seconds, and a random nonce. Nonces already seen are rejected. |
| A lost or stolen phone | Settings › Phone check-in lists paired phones; **Remove** deletes that phone's key at once. Turning check-in off stops the server. |
| A paired phone (or its thief) typing commands | A phone is read-only by default. "Let phones answer prompts" is a separate opt-in. Even then, a phone can only press **Approve** (Enter) or **Reject** (Esc), and only in a terminal whose agent is waiting for an answer. It can't type text. |
| Secrets in terminal output | Output sent to the phone is redacted first (the same redaction as history), and only the last 60 lines of one terminal at a time. |

## What it does *not* defend against

- **An active attacker on your local network**, one who can change the HTTP traffic. The page is served over
  plain `http://` (browsers won't run their crypto API on a LAN address without a certificate, and a self-signed
  certificate only trains people to click through warnings). Such an attacker could change the page as it
  loads and steal the key from the fragment. Use check-in on networks you trust (home, office), not on public
  Wi-Fi. This is the price of having no server or certificate to manage. A later version could pin a
  certificate in an installed app.
- A compromised phone or PC.

## Pairing

1. Settings › Phone check-in › **Pair a phone** creates a phone id and a random 256-bit key on the PC, and shows
   them as a QR code: `http://<PC's LAN address>:<port>/#<id>.<key>`.
2. You scan it with the phone's camera. The page keeps the id and key in that browser's local storage, and
   strips the fragment from the address bar.
3. On the PC the phone is listed as paired (name it after the phone). The QR code is shown only while the
   dialog is open, and an unused pairing expires after 5 minutes.

Keys are stored sealed with the vault key (`checkin.json` next to `keys.json`), like the other secrets.

## Wire format

`POST /api` with `{"d": "<phone id>", "n": "<nonce, base64>", "c": "<ciphertext, base64>"}`. The ciphertext is
`AES-256-GCM(key, nonce, plaintext, aad = phone id)` of `{"t": <ms>, "op": "state" | "output" | "answer", …}`.
The answer is `{"n", "c"}` under the same key with a new nonce. A request that fails any check (unknown id, bad
tag, old timestamp, reused nonce, malformed) gets `403` with an empty body, so a probe learns nothing.

## Settings

- **Phone check-in:** off / on. The server listens only while it's on.
- **Let phones answer prompts:** off by default.
- **Port:** 8765 by default. Windows asks once whether to allow it on private networks.
- The paired phones, with Remove.
