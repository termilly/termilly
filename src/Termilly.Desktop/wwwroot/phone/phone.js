// Termilly's phone page. The QR code from Settings › Phone check-in opens it with "#<phone id>.<key>"; the key stays
// in this browser (the fragment is never sent to the server) and seals every request with AES-256-GCM. The server
// answers only requests sealed with a paired phone's key. docs/checkin.md has the design.

import { gcm } from './lib/noble/aes.js';

const STORE = 'termilly.checkin';
const REFRESH_MS = 4000;
/** AES-GCM's nonce, in bytes. */
const NONCE_BYTES = 12;
/** The server's answer to a request no paired phone's key sealed. */
const FORBIDDEN = 403;
/** What the page asks Termilly (the request's op; checkin.js answers them). */
const OP = Object.freeze({ state: 'state', output: 'output', answer: 'answer' });
/** The terminal states that wait for the user (store.js's activity kinds). */
const KIND = Object.freeze({ needs: 'needs', error: 'error' });
/** The page's element the list and the pane go in (phone/index.html). */
const MAIN_ID = 'main';
const enc = new TextEncoder();
const dec = new TextDecoder();
const main = document.getElementById(MAIN_ID);
const live = document.getElementById('live');

const b64 = bytes => btoa(String.fromCharCode(...bytes));
const unb64 = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function load() {
  // A fresh pairing from the QR code: keep it, and take the key out of the address bar.
  const fragment = location.hash.slice(1);
  if (/^[0-9a-f]{16}\.[\w-]{43}$/.test(fragment)) {
    const [id, key] = fragment.split('.');
    try { localStorage.setItem(STORE, JSON.stringify({ id, key })); } catch { /* private mode: this visit only */ }
    history.replaceState(null, '', location.pathname);
    return { id, key: unb64(key) };
  }
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? 'null');
    return saved ? { id: saved.id, key: unb64(saved.key) } : null;
  } catch {
    return null;
  }
}

const phone = load();

class NotPaired extends Error {}

async function call(op, args = {}) {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const aad = enc.encode(phone.id);
  const sealed = gcm(phone.key, nonce, aad).encrypt(enc.encode(JSON.stringify({ t: Date.now(), op, ...args })));
  const response = await fetch('/api', { method: 'POST', body: JSON.stringify({ d: phone.id, n: b64(nonce), c: b64(sealed) }) });
  if (response.status === FORBIDDEN) throw new NotPaired();
  if (!response.ok) throw new Error(`Termilly answered ${response.status}.`);
  const reply = await response.json();
  const answer = JSON.parse(dec.decode(gcm(phone.key, unb64(reply.n), aad).decrypt(unb64(reply.c))));
  if (!answer.ok) throw new Error(answer.error);
  return answer.result;
}

const view = { pane: null };
let timer = null;

function unpaired() {
  clearTimeout(timer);
  live.textContent = '';
  main.innerHTML = `<p>This phone isn't paired.</p>
    <p class="note">On your PC: Termilly › Settings › Phone check-in › Pair a phone, then scan the code with this phone's camera.</p>`;
}

function card(t, allowAnswer) {
  return `<button class="card${t.canAnswer ? ' needs' : ''}" data-pane="${esc(t.id)}">
    <div class="row"><span class="dot ${esc(t.kind)}"></span><span class="title">${esc(t.title)}</span></div>
    <div class="sub">${esc([t.activity, t.status, t.workspace].filter(Boolean).join(' · '))}</div>
    ${t.canAnswer && allowAnswer ? `<div class="actions">
      <span class="act approve" role="button" data-answer="approve">Approve</span>
      <span class="act reject" role="button" data-answer="reject">Reject</span></div>` : ''}
  </button>`;
}

async function showList() {
  const { terminals, allowAnswer } = await call(OP.state);
  const waiting = terminals.filter(t => t.kind === KIND.needs || t.kind === KIND.error);
  const rest = terminals.filter(t => !waiting.includes(t));
  main.innerHTML = (waiting.length ? `<h2>Waiting for you</h2>${waiting.map(t => card(t, allowAnswer)).join('')}` : '')
    + (rest.length || !waiting.length ? `<h2>Terminals</h2>${rest.map(t => card(t, allowAnswer)).join('') || '<p class="note">No terminals open.</p>'}` : '')
    + '<button class="forget" data-forget>Forget this PC</button>';
}

async function showPane(pane) {
  const [{ terminals, allowAnswer }, lines] = await Promise.all([call(OP.state), call(OP.output, { pane })]);
  const t = terminals.find(x => x.id === pane);
  if (!t) {
    view.pane = null;
    return showList();
  }
  main.innerHTML = `<button class="back" data-back>‹ All terminals</button>${card(t, allowAnswer)}
    <h2>Last ${lines.length} lines</h2><pre>${esc(lines.join('\n')) || ' '}</pre>`;
  main.querySelector('pre').scrollIntoView({ block: 'end' });
}

async function refresh() {
  clearTimeout(timer);
  try {
    await (view.pane ? showPane(view.pane) : showList());
    live.textContent = `updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  } catch (e) {
    if (e instanceof NotPaired) return unpaired();
    live.textContent = '';
    main.insertAdjacentHTML('afterbegin', `<p class="error">${esc(e.message)}</p>`);
  }
  timer = setTimeout(refresh, REFRESH_MS);
}

main.addEventListener('click', async e => {
  const answer = e.target.closest('[data-answer]');
  const card = e.target.closest('[data-pane]');
  if (answer && card) {
    e.stopPropagation();
    answer.textContent = '…';
    try {
      await call(OP.answer, { pane: card.dataset.pane, choice: answer.dataset.answer });
    } catch (err) {
      alert(err.message);
    }
    return refresh();
  }
  if (e.target.closest('[data-back]')) { view.pane = null; return refresh(); }
  if (e.target.closest('[data-forget]')) {
    try { localStorage.removeItem(STORE); } catch { /* nothing kept */ }
    return unpaired();
  }
  if (card) { view.pane = card.dataset.pane; refresh(); }
});

if (phone) refresh(); else unpaired();
