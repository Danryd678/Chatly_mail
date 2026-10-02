# Chatly Mail — webmail with real outbound sending

A simple webmail app. Sign up with a username and password; your address becomes
`username@mail.chatly.app`. Write to other app users, keep drafts, reply, delete.

> **Real sending.** Writing to a real address (e.g. `someone@gmail.com`) actually
> delivers it over the internet via SMTP, from the configured Gmail account.
> Replies land in that Gmail inbox — not in this app. Receiving from real
> inboxes still needs an owned domain (MX records), so inbound stays in-app only.

## Making real sending work

1. The server needs these env vars (same convention as the Chatly app):
   `SMTP_HOST`, `SMTP_PORT` (default 587), `SMTP_USER`, `SMTP_PASS`,
   `SMTP_FROM` (optional, defaults to `SMTP_USER`).
   With a Gmail account: host `smtp.gmail.com`, port `587`, user = your Gmail
   address, pass = a Gmail **app password** (created on that same account).
2. Set them on the hosting dashboard (Faable → the chatly-mail service →
   Variables/Environment), then redeploy/restart.
3. `/api/health` reports `real_send: true` when active; the app banner updates
   itself.

## Run it

```
npm install
npm start
```

Open http://localhost:3000 and sign up.

## Deploy free (Faable)

Faable's free tier hosts this at no cost (no card required), same as Chatly.

1. Push this folder to a GitHub repo (e.g. `Danryd678/chatly-mail`). Do NOT
   include `data/` or `node_modules/` (both are git-ignored).
2. In the Faable dashboard: **New service → connect the GitHub repo**.
   - Runtime: `Node`
   - Build command: `npm install`
   - Start command: `npm start`
   - Plan: free
3. When it says Live, you get a public URL like
   `https://chatly-mail-xxxx.faable.link`. Share it — everyone signs up with
   their own username and can mail each other.

Caveats of the free tier: the app sleeps after ~2h with no traffic (wakes on
the next visit), and the SQLite file may reset when the service restarts —
treat it as a demo.

## API

All endpoints are JSON under `/api/*`. Auth via the `chatlymail_session`
HttpOnly cookie (set on register/login), or pass the token as
`?token=`, `{token}` in the body, or `Authorization: Bearer <token>`.

| Method | Path | Purpose |
|---|---|---|
| POST | /api/register | `{username, password}` → creates user, returns token + address |
| POST | /api/login | `{username, password}` → returns token + address |
| POST | /api/logout | ends the session |
| GET | /api/me | current user |
| GET | /api/users/search?q= | find users to address mail to |
| GET | /api/emails?folder=inbox\|sent\|drafts | list a folder (also returns `unread` count) |
| GET | /api/emails/:id | read one (marks inbox mail as read) |
| POST | /api/emails | send (`{to, subject, body}`) or save draft (`{..., draft:true}`) |
| PUT | /api/emails/:id | update a draft |
| POST | /api/emails/:id/send | send a saved draft |
| DELETE | /api/emails/:id?folder= | delete from inbox/sent/drafts |
| GET | /api/health | `{ok, app, version, demo, domain}` |

Errors always carry a machine-readable `error` code and a human `message`,
and never use HTTP 5xx (the hosting edge proxy swallows 5xx responses).
