/**
 * Chatly Mail v1.0 — free demo webmail.
 *
 * Stack: Node.js + Express + SQLite (node:sqlite, built in).
 * No native modules, no build step. SQLite file keeps everything persistent.
 *
 * DEMO LIMITATION (shown in the UI too): addresses like you@mail.chatly.app
 * exist only inside this app. No domain is owned yet, so mail can never be
 * sent to, or received from, real external inboxes (Gmail, etc.).
 *
 * Config (env vars):
 *   PORT     — port to listen on (default 3000)
 *   DB_PATH  — SQLite file path (default ./data/mail.db)
 *
 * Auth: HttpOnly session cookie. Session token also accepted via
 *   - JSON body field  {token: "..."}
 *   - query string     ?token=...
 *   - header           Authorization: Bearer <token>
 *
 * NOTE: like Chatly, error responses never use 5xx — the hosting edge proxy
 * swallows 5xx and substitutes its own error page. Clients read the JSON
 * `error` field, never the status code.
 */
import express from 'express';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

// ---------------------------------------------------------------- config

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'mail.db');
const SESSION_COOKIE = 'chatlymail_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAIL_DOMAIN = 'mail.chatly.app';
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const MAX_SUBJECT_LEN = 200;
const MAX_BODY_LEN = 50000;

const addressOf = (username) => `${username}@${MAIL_DOMAIN}`;

// ---------------------------------------------------------------- database

mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    is_read INTEGER NOT NULL DEFAULT 0,
    is_draft INTEGER NOT NULL DEFAULT 0,
    deleted_by_sender INTEGER NOT NULL DEFAULT 0,
    deleted_by_recipient INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_emails_inbox
    ON emails(recipient_id, is_draft, deleted_by_recipient, updated_at);
  CREATE INDEX IF NOT EXISTS idx_emails_sent
    ON emails(sender_id, is_draft, deleted_by_sender, updated_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

// ---------------------------------------------------------------- auth helpers

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored || '').split(':');
  if (!saltHex || !hashHex) return false;
  const hash = scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

function newSession(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').run(userId, Date.now());
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, Date.now() + SESSION_TTL_MS);
  return token;
}

function userFromToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const row = db
    .prepare(
      'SELECT s.user_id, u.username, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'
    )
    .get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { id: row.user_id, username: row.username, address: addressOf(row.username) };
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function tokenFromReq(req) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[SESSION_COOKIE]) return cookies[SESSION_COOKIE];
  if (req.body && typeof req.body.token === 'string') return req.body.token;
  if (typeof req.query.token === 'string') return req.query.token;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

function requireAuth(req, res, next) {
  const user = userFromToken(tokenFromReq(req));
  if (!user) return res.status(401).json({ error: 'not_authenticated', message: 'Please log in.' });
  req.user = user;
  next();
}

function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Resolve a "to" value (username or full address) to a user row.
function resolveRecipient(to) {
  const raw = String(to || '').trim();
  if (!raw) return { error: 'missing_recipient', message: 'Enter a recipient.' };
  let username = raw;
  const at = raw.lastIndexOf('@');
  if (at > 0) {
    const domain = raw.slice(at + 1).toLowerCase();
    if (domain !== MAIL_DOMAIN) {
      return {
        error: 'external_address',
        message: `Demo limitation: "${raw}" is outside this app. You can only write to addresses ending in @${MAIL_DOMAIN}.`,
      };
    }
    username = raw.slice(0, at);
  }
  if (!USERNAME_RE.test(username)) {
    return { error: 'bad_recipient', message: `"${raw}" is not a valid Chatly Mail address.` };
  }
  const row = db.prepare('SELECT id, username FROM users WHERE username = ?').get(username);
  if (!row) {
    return { error: 'unknown_recipient', message: `No Chatly Mail user "${addressOf(username)}" yet.` };
  }
  return { user: { id: row.id, username: row.username, address: addressOf(row.username) } };
}

function emailJson(row, me) {
  const sender = db.prepare('SELECT username FROM users WHERE id = ?').get(row.sender_id);
  const recipient = row.recipient_id
    ? db.prepare('SELECT username FROM users WHERE id = ?').get(row.recipient_id)
    : null;
  return {
    id: row.id,
    from: addressOf(sender.username),
    from_username: sender.username,
    to: recipient ? addressOf(recipient.username) : null,
    to_username: recipient ? recipient.username : null,
    subject: row.subject,
    body: row.body,
    is_read: Boolean(row.is_read),
    is_draft: Boolean(row.is_draft),
    mine: row.sender_id === me.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ---------------------------------------------------------------- app

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(process.cwd(), 'public')));

// ---- auth ----

app.post('/api/register', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({
      error: 'bad_username',
      message: 'Username must be 3–20 characters: letters, numbers, underscore.',
    });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'bad_password', message: 'Password must be at least 6 characters.' });
  }
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) {
    return res.status(409).json({ error: 'username_taken', message: 'That username is taken — try another.' });
  }
  const info = db
    .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run(username, hashPassword(password), Date.now());
  const token = newSession(Number(info.lastInsertRowid));
  setSessionCookie(res, token);
  res.json({ token, username, address: addressOf(username) });
});

app.post('/api/login', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const row = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);
  if (!row || !verifyPassword(password, row.password_hash)) {
    return res.status(401).json({ error: 'bad_credentials', message: 'Wrong username or password.' });
  }
  const token = newSession(row.id);
  setSessionCookie(res, token);
  res.json({ token, username: row.username, address: addressOf(row.username) });
});

app.post('/api/logout', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenFromReq(req));
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ username: req.user.username, address: req.user.address, domain: MAIL_DOMAIN });
});

// ---- user lookup (for addressing mail) ----

app.get('/api/users/search', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim().replace(/[%_]/g, '');
  if (q.length < 2) return res.json({ users: [] });
  const rows = db
    .prepare("SELECT username FROM users WHERE username LIKE ? ESCAPE '\\' AND id != ? ORDER BY username LIMIT 10")
    .all(`%${q}%`, req.user.id);
  res.json({ users: rows.map((r) => ({ username: r.username, address: addressOf(r.username) })) });
});

// ---- folders ----

app.get('/api/emails', requireAuth, (req, res) => {
  const folder = String(req.query.folder || 'inbox');
  let rows;
  if (folder === 'sent') {
    rows = db
      .prepare(
        'SELECT * FROM emails WHERE sender_id = ? AND is_draft = 0 AND deleted_by_sender = 0 ORDER BY updated_at DESC LIMIT 100'
      )
      .all(req.user.id);
  } else if (folder === 'drafts') {
    rows = db
      .prepare(
        'SELECT * FROM emails WHERE sender_id = ? AND is_draft = 1 AND deleted_by_sender = 0 ORDER BY updated_at DESC LIMIT 100'
      )
      .all(req.user.id);
  } else {
    rows = db
      .prepare(
        'SELECT * FROM emails WHERE recipient_id = ? AND is_draft = 0 AND deleted_by_recipient = 0 ORDER BY updated_at DESC LIMIT 100'
      )
      .all(req.user.id);
  }
  const unread = db
    .prepare(
      'SELECT COUNT(*) AS n FROM emails WHERE recipient_id = ? AND is_draft = 0 AND is_read = 0 AND deleted_by_recipient = 0'
    )
    .get(req.user.id).n;
  res.json({ folder, unread, emails: rows.map((r) => emailJson(r, req.user)) });
});

app.get('/api/emails/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM emails WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found', message: 'Email not found.' });
  const isSender = row.sender_id === req.user.id && !row.deleted_by_sender;
  const isRecipient =
    row.recipient_id === req.user.id && !row.is_draft && !row.deleted_by_recipient;
  if (!isSender && !isRecipient) {
    return res.status(404).json({ error: 'not_found', message: 'Email not found.' });
  }
  if (isRecipient && !row.is_read) {
    db.prepare('UPDATE emails SET is_read = 1 WHERE id = ?').run(row.id);
    row.is_read = 1;
  }
  res.json({ email: emailJson(row, req.user) });
});

// ---- compose / send ----

app.post('/api/emails', requireAuth, (req, res) => {
  const draft = req.body?.draft === true;
  const subject = String(req.body?.subject || '').slice(0, MAX_SUBJECT_LEN);
  const body = String(req.body?.body || '').slice(0, MAX_BODY_LEN);
  const toRaw = String(req.body?.to || '').trim();

  if (draft && !toRaw && !subject && !body) {
    return res.status(400).json({ error: 'empty_draft', message: 'Write something before saving a draft.' });
  }

  let recipientId = null;
  if (toRaw) {
    const resolved = resolveRecipient(toRaw);
    if (resolved.error) return res.status(422).json(resolved);
    if (resolved.user.id === req.user.id) {
      return res.status(400).json({ error: 'self_mail', message: 'You cannot send mail to yourself.' });
    }
    recipientId = resolved.user.id;
  } else if (!draft) {
    return res.status(400).json({ error: 'missing_recipient', message: 'Enter a recipient.' });
  }

  const now = Date.now();
  const info = db
    .prepare(
      'INSERT INTO emails (sender_id, recipient_id, subject, body, is_read, is_draft, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)'
    )
    .run(req.user.id, recipientId, subject, body, draft ? 1 : 0, now, now);
  const row = db.prepare('SELECT * FROM emails WHERE id = ?').get(info.lastInsertRowid);
  res.json({ email: emailJson(row, req.user) });
});

// Send a saved draft
app.post('/api/emails/:id/send', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM emails WHERE id = ?').get(req.params.id);
  if (!row || row.sender_id !== req.user.id || !row.is_draft || row.deleted_by_sender) {
    return res.status(404).json({ error: 'not_found', message: 'Draft not found.' });
  }
  const toRaw = String(req.body?.to || '').trim();
  let recipientId = row.recipient_id;
  if (toRaw) {
    const resolved = resolveRecipient(toRaw);
    if (resolved.error) return res.status(422).json(resolved);
    if (resolved.user.id === req.user.id) {
      return res.status(400).json({ error: 'self_mail', message: 'You cannot send mail to yourself.' });
    }
    recipientId = resolved.user.id;
  }
  if (!recipientId) {
    return res.status(400).json({ error: 'missing_recipient', message: 'Add a recipient before sending.' });
  }
  if (recipientId === req.user.id) {
    return res.status(400).json({ error: 'self_mail', message: 'You cannot send mail to yourself.' });
  }
  db.prepare('UPDATE emails SET is_draft = 0, recipient_id = ?, updated_at = ? WHERE id = ?').run(
    recipientId,
    Date.now(),
    row.id
  );
  const updated = db.prepare('SELECT * FROM emails WHERE id = ?').get(row.id);
  res.json({ email: emailJson(updated, req.user) });
});

// Update a draft
app.put('/api/emails/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM emails WHERE id = ?').get(req.params.id);
  if (!row || row.sender_id !== req.user.id || !row.is_draft || row.deleted_by_sender) {
    return res.status(404).json({ error: 'not_found', message: 'Draft not found.' });
  }
  const subject = String(req.body?.subject ?? row.subject).slice(0, MAX_SUBJECT_LEN);
  const body = String(req.body?.body ?? row.body).slice(0, MAX_BODY_LEN);
  const toRaw = req.body?.to !== undefined ? String(req.body.to).trim() : null;
  let recipientId = row.recipient_id;
  if (toRaw !== null) {
    if (!toRaw) {
      recipientId = null;
    } else {
      const resolved = resolveRecipient(toRaw);
      if (resolved.error) return res.status(422).json(resolved);
      recipientId = resolved.user.id;
    }
  }
  db.prepare('UPDATE emails SET subject = ?, body = ?, recipient_id = ?, updated_at = ? WHERE id = ?').run(
    subject,
    body,
    recipientId,
    Date.now(),
    row.id
  );
  const updated = db.prepare('SELECT * FROM emails WHERE id = ?').get(row.id);
  res.json({ email: emailJson(updated, req.user) });
});

// Delete (soft-delete from the folder it is viewed in)
app.delete('/api/emails/:id', requireAuth, (req, res) => {
  const folder = String(req.query.folder || '');
  const row = db.prepare('SELECT * FROM emails WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found', message: 'Email not found.' });
  if (row.sender_id === req.user.id && (folder === 'sent' || folder === 'drafts' || row.is_draft)) {
    db.prepare('UPDATE emails SET deleted_by_sender = 1 WHERE id = ?').run(row.id);
    return res.json({ ok: true });
  }
  if (row.recipient_id === req.user.id && !row.is_draft) {
    db.prepare('UPDATE emails SET deleted_by_recipient = 1 WHERE id = ?').run(row.id);
    return res.json({ ok: true });
  }
  return res.status(404).json({ error: 'not_found', message: 'Email not found.' });
});

// ---- health ----

app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'chatly-mail', version: '1.0.0', demo: true, domain: MAIL_DOMAIN });
});

app.listen(PORT, () => console.log(`Chatly Mail listening on port ${PORT}`));
