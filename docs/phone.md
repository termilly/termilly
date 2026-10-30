# Termilly on your phone: design and threat model

Termilly can serve a small app to phones on your network: your workspaces and terminals live, the agents that wait
for you (Approve, Reject or a reply), any terminal live, and alerts on a locked phone when an agent needs you. With
**Allow typing** on, the phone can also type into a terminal. Termilly serves it itself: there's no account, no relay
and no cloud service of ours. It is **off by default** (Settings › Phone).

## How it fits together

- **The server** (`Phone/PhoneServer.cs`) listens on one port (8765 by default), on this PC's private network address
  only. It speaks HTTPS to the app, and plain HTTP for one thing only: the setup page and Termilly's certificate,
  which a new phone needs before it can trust HTTPS.
- **The certificate.** Termilly makes its own certificate authority (ECDSA P-256) once, and from it a server
  certificate for this PC's addresses and name, valid for 397 days and replaced on its own when the address changes
  or it nears its end. Each phone installs and trusts the authority once.
- **Pairing.** Settings › Phone shows a code (8 characters, good for 5 minutes and 10 tries). The phone's app sends
  it and gets a random 256-bit token in a `Secure; HttpOnly; SameSite=Strict` cookie. Termilly keeps only the
  token's SHA-256.
- **Live.** A paired phone opens one WebSocket (`/api/live`). It gets the page's picture of the terminals as it
  changes, and, for the terminal it shows, what it printed lately and then what it prints. While a phone shows a
  terminal, the terminal takes the phone's size on the PC too (the PC says **On the phone**), so its output fits the
  phone; it gets its own size back when no phone shows it.
- **Alerts** go through the phone's own push service (Apple's or Google's) as Web Push, encrypted end to end
  (RFC 8291) and signed with Termilly's own VAPID key.

The authority's key, the server certificate, the VAPID key and the paired phones are kept sealed with the vault key
(`phone.json` next to `keys.json`), like the other secrets. While the vault is locked, the app says so and shows
nothing.

## What it protects

- The contents of your terminals: output, commands, folder names.
- Control of your terminals: anything that types into them, or answers an agent.

## Who it defends against

| Adversary | Defence |
|---|---|
| Anyone on the internet | Nothing listens until you turn it on, and then only on a private network address (10/8, 172.16/12, 192.168/16, and 100.64/10 for Tailscale). There's no relay, no port forwarding and no UPnP. |
| Someone on your network, listening or changing traffic | Everything but the setup page is HTTPS with Termilly's certificate. A phone that trusts Termilly's authority won't accept anyone else's certificate for the PC. |
| A device on your network that isn't paired | Without a paired phone's token, the app gets nothing but "pair first". A pairing code expires after 5 minutes or 10 wrong tries. |
| A web page in the phone's browser | The cookie is `SameSite=Strict`, so another site can't use it, and the app's pages forbid scripts from elsewhere (CSP). |
| A lost or stolen phone | Settings › Phone lists the paired phones; **Remove** forgets one at once and closes its connection. Turning the feature off stops the server. |
| A paired phone (or its thief) typing commands | Typing is off by default (**Allow typing**). Without it, a phone can only answer an agent that is waiting: Approve, Approve and don't ask again, Reject, or a reply, and Termilly checks it's still waiting before typing anything. Terminals tagged prod ask on the phone first. |
| Apple or Google | An alert is encrypted for that phone alone; the push service sees only that one was sent, when, and how big. **Hide details in alerts** leaves even the terminal's name out. Alert text is redacted (the same redaction as history) and cut to 180 characters. |

## What it does *not* defend against

- **A paired, unlocked phone in someone else's hands.** It sees what you'd see. Remove it in Settings.
- **Secrets printed in a terminal you show on the phone.** Terminal output reaches the phone as it is, over HTTPS;
  only alerts are redacted.
- **A compromised PC.** Whoever controls the PC controls Termilly's authority key, and a phone trusts that authority.
  Its certificate isn't limited to your network's addresses, so such an attacker could use it to intercept other
  sites on a phone that trusts it. Remove the profile from the phone (Settings › General › VPN & Device Management on
  an iPhone) when you stop using the feature.
- **The setup page** is plain HTTP, so someone changing traffic on your network could hand a new phone their own
  certificate instead. Set up phones on a network you trust. The setup page checks live whether the phone already
  trusts Termilly's HTTPS before it lets you continue; never tap through a "not private" warning.
- A compromised phone.

## Setting up a phone

1. Settings › Phone: turn it on, then scan the setup QR code with the phone.
2. Download and install Termilly's certificate. On an iPhone, install the downloaded profile (Settings shows
   **Profile Downloaded**), then turn it on in General › About › Certificate Trust Settings. On Android, install it as
   a **CA certificate**.
3. Open Termilly (the setup page enables the button once the phone trusts it), add it to the Home Screen, open it
   from there, and type the pairing code from Settings › Phone.
4. Turn on alerts in the app. On an iPhone, alerts need iOS 16.4 or later and the Home Screen app.

If the phone ever warned that the connection wasn't private and you tapped through, clear that exception (on an
iPhone: Settings › Safari › Clear History and Website Data) and finish step 2.

## Settings

- **Termilly on your phone:** off / on. The server listens only while it's on. Windows asks once whether to allow it on private
  networks.
- **Port:** 8765 by default.
- **Alerts:** when I'm away (Termilly isn't the window in front, or the PC has had no input for a minute), always,
  or off.
- **Hide details in alerts** and **Allow typing:** off by default.
- The paired phones, with Remove, and **Test alert**.
