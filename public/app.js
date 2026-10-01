/* Chatly Mail — front-end. Demo webmail, all data lives on our own server. */
'use strict';

const $ = (id) => document.getElementById(id);
const views = ['view-auth', 'view-mail', 'view-read', 'view-compose'];
const DOMAIN = 'mail.chatly.app';

let me = null;            // {username, address}
let folder = 'inbox';
let currentEmail = null;  // email being read
let editingDraftId = null;
let pollTimer = null;

function show(name) {
  for (const v of views) $(v).hidden = v !== name;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now - 864e5).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return time;
  if (yesterday) return 'Yesterday';
  return d.toLocaleDateString() + ' ' + time;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
  });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok || (data && data.error)) {
    throw new Error((data && data.message) || `Request failed (${res.status})`);
  }
  return data;
}

/* ---------------- auth ---------------- */

let mode = 'login';

$('tab-login').onclick = () => setMode('login');
$('tab-register').onclick = () => setMode('register');

function setMode(m) {
  mode = m;
  $('tab-login').classList.toggle('active', m === 'login');
  $('tab-register').classList.toggle('active', m === 'register');
  $('btn-auth').textContent = m === 'login' ? 'Log in' : 'Sign up';
  $('auth-error').hidden = true;
}

$('input-username').addEventListener('input', (e) => {
  $('addr-preview').textContent = e.target.value.trim() || 'you';
});

$('form-auth').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('input-username').value.trim();
  const password = $('input-password').value;
  const err = $('auth-error');
  err.hidden = true;
  $('btn-auth').disabled = true;
  try {
    const data = await api(mode === 'login' ? '/api/login' : '/api/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    me = { username: data.username, address: data.address };
    enterMailbox();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    $('btn-auth').disabled = false;
  }
});

$('btn-logout').onclick = async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
  me = null;
  stopPolling();
  show('view-auth');
};

async function boot() {
  try {
    const data = await api('/api/me');
    me = { username: data.username, address: data.address };
    enterMailbox();
  } catch {
    show('view-auth');
  }
}

/* ---------------- mailbox ---------------- */

function enterMailbox() {
  $('my-address').textContent = me.address;
  show('view-mail');
  loadFolder('inbox');
  startPolling();
}

document.querySelectorAll('.folder').forEach((btn) => {
  btn.onclick = () => loadFolder(btn.dataset.folder);
});

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (!$('view-mail').hidden) loadFolder(folder, true);
  }, 15000);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function loadFolder(f, silent = false) {
  folder = f;
  document.querySelectorAll('.folder').forEach((b) => b.classList.toggle('active', b.dataset.folder === f));
  try {
    const data = await api(`/api/emails?folder=${encodeURIComponent(f)}`);
    const badge = $('badge-inbox');
    badge.hidden = !data.unread;
    badge.textContent = data.unread > 99 ? '99+' : String(data.unread);
    renderList(data.emails);
  } catch (ex) {
    if (!silent) {
      $('mail-list').innerHTML = '';
      const p = $('mail-empty');
      p.hidden = false;
      p.textContent = 'Could not load mail: ' + ex.message;
    }
  }
}

function renderList(emails) {
  const ul = $('mail-list');
  ul.innerHTML = '';
  const empty = $('mail-empty');
  if (!emails.length) {
    empty.hidden = false;
    empty.innerHTML =
      folder === 'inbox' ? 'Your inbox is empty.<br>Ask a friend to sign up and write to you!' :
      folder === 'sent' ? 'Nothing sent yet.<br>Tap ✎ to write your first message.' :
      'No drafts.<br>Start a message and tap 💾 to save it here.';
    return;
  }
  empty.hidden = true;
  for (const m of emails) {
    const li = document.createElement('li');
    li.className = 'mail-item' + (folder === 'inbox' && !m.is_read ? ' unread' : '');
    const who = folder === 'sent' ? m.to : m.from;
    const draftTag = m.is_draft ? '<span class="mail-draft-tag">DRAFT</span>' : '';
    li.innerHTML =
      `<div class="mail-row"><span class="mail-from">${esc(who || '(no recipient)')}</span>` +
      `<span class="mail-date">${esc(fmtDate(m.updated_at))}</span></div>` +
      `<div class="mail-subject">${draftTag}${esc(m.subject || '(no subject)')}</div>` +
      `<div class="mail-preview">${esc((m.body || '').slice(0, 80))}</div>`;
    li.onclick = () => (m.is_draft ? openDraft(m.id) : openEmail(m.id));
    ul.appendChild(li);
  }
}

/* ---------------- reader ---------------- */

async function fetchEmail(id) {
  const data = await api(`/api/emails/${id}`);
  return data.email;
}

async function openDraft(id) {
  stopPolling();
  try {
    const m = await fetchEmail(id);
    openCompose({
      to: m.to_username || '',
      subject: m.subject,
      body: m.body,
      draftId: m.id,
      title: 'Edit draft',
    });
  } catch (ex) {
    alert(ex.message);
    startPolling();
  }
}

async function openEmail(id) {
  stopPolling();
  try {
    const m = await fetchEmail(id);
    currentEmail = m;
    $('read-subject').textContent = m.subject || '(no subject)';
    $('read-from').textContent = m.from;
    $('read-to').textContent = m.to || '(no recipient)';
    $('read-date').textContent = fmtDate(m.created_at);
    $('read-body').textContent = m.body || '';
    $('btn-reply').style.display = m.is_draft ? 'none' : '';
    show('view-read');
  } catch (ex) {
    alert(ex.message);
    startPolling();
  }
}

$('btn-back-read').onclick = () => {
  currentEmail = null;
  show('view-mail');
  loadFolder(folder, true);
  startPolling();
};

$('btn-delete-read').onclick = async () => {
  if (!currentEmail) return;
  if (!confirm('Delete this message?')) return;
  const f = currentEmail.is_draft ? 'drafts' : (currentEmail.mine ? 'sent' : 'inbox');
  try {
    await api(`/api/emails/${currentEmail.id}?folder=${f}`, { method: 'DELETE' });
  } catch (ex) {
    alert(ex.message);
    return;
  }
  $('btn-back-read').onclick();
};

$('btn-reply').onclick = () => {
  if (!currentEmail || currentEmail.is_draft) return;
  const m = currentEmail;
  openCompose({
    to: m.from_username,
    subject: m.subject.toLowerCase().startsWith('re:') ? m.subject : 'Re: ' + m.subject,
    body: `\n\n— — —\nOn ${fmtDate(m.created_at)}, ${m.from} wrote:\n${m.body}`,
  });
};

/* ---------------- compose ---------------- */

$('btn-compose').onclick = () => openCompose({});

function openCompose({ to = '', subject = '', body = '', draftId = null, title = 'New message' } = {}) {
  stopPolling();
  editingDraftId = draftId;
  $('compose-title').textContent = title;
  $('compose-to').value = to;
  $('compose-subject').value = subject;
  $('compose-body').value = body;
  $('compose-error').hidden = true;
  show('view-compose');
}

$('btn-back-compose').onclick = () => {
  editingDraftId = null;
  show('view-mail');
  loadFolder(folder, true);
  startPolling();
};

let suggestTimer = null;
$('compose-to').addEventListener('input', (e) => {
  clearTimeout(suggestTimer);
  const q = e.target.value.trim();
  suggestTimer = setTimeout(async () => {
    const dl = $('addr-suggestions');
    dl.innerHTML = '';
    if (q.length < 2 || q.includes('@')) return;
    try {
      const data = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
      for (const u of data.users) {
        const opt = document.createElement('option');
        opt.value = u.username;
        opt.label = u.address;
        dl.appendChild(opt);
      }
    } catch { /* ignore */ }
  }, 300);
});

function collectCompose() {
  return {
    to: $('compose-to').value.trim(),
    subject: $('compose-subject').value.trim(),
    body: $('compose-body').value,
  };
}

function composeError(msg) {
  const el = $('compose-error');
  el.textContent = msg;
  el.hidden = false;
}

$('btn-save-draft').onclick = async () => {
  const { to, subject, body } = collectCompose();
  $('compose-error').hidden = true;
  if (!to && !subject && !body.trim()) {
    composeError('Write something before saving a draft.');
    return;
  }
  try {
    if (editingDraftId) {
      await api(`/api/emails/${editingDraftId}`, {
        method: 'PUT',
        body: JSON.stringify({ to, subject, body, draft: true }),
      });
    } else {
      const data = await api('/api/emails', {
        method: 'POST',
        body: JSON.stringify({ to, subject, body, draft: true }),
      });
      editingDraftId = data.email.id;
      $('compose-title').textContent = 'Edit draft';
    }
    composeError('');
    $('compose-error').hidden = true;
    alert('Draft saved.');
  } catch (ex) {
    composeError(ex.message);
  }
};

$('form-compose').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { to, subject, body } = collectCompose();
  $('compose-error').hidden = true;
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    if (editingDraftId) {
      // persist edits first (PUT only works on drafts), then send
      await api(`/api/emails/${editingDraftId}`, {
        method: 'PUT',
        body: JSON.stringify({ to, subject, body }),
      });
      await api(`/api/emails/${editingDraftId}/send`, { method: 'POST', body: '{}' });
    } else {
      await api('/api/emails', {
        method: 'POST',
        body: JSON.stringify({ to, subject, body }),
      });
    }
    editingDraftId = null;
    show('view-mail');
    loadFolder('sent');
    startPolling();
  } catch (ex) {
    composeError(ex.message);
  } finally {
    btn.disabled = false;
  }
});

boot();
