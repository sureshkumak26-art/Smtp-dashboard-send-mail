# SMTP Email Dashboard

Node.js SMTP email dashboard with admin login, email sending, logs, and dashboard-managed SMTP settings.

## Install

```bash
npm install
cp .env.example .env
nano .env
npm start
```

Open `http://YOUR_SERVER_IP:3000`.

## SMTP Setup

Login and open **SMTP Setup** in the sidebar. Configure host, port, username, password, sender address and security mode, then click **Save SMTP** and **Test Connection**.

Common settings:
- Port 587: STARTTLS (`secure=false`)
- Port 465: TLS (`secure=true`)

SMTP credentials entered in the dashboard are stored in the local SQLite database. The password is never returned by the settings API.

## Security

Change `ADMIN_PASSWORD` and `SESSION_SECRET` before production use. Put the app behind HTTPS and restrict dashboard access. Only send messages to recipients who have requested or consented to receive them, and follow your SMTP provider's policies and sending limits.
