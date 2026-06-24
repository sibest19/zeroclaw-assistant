// Email (IMAP/SMTP) — on-demand. We store ONLY headers (from/subject/date) in the
// archive as source='email' rows (light semantic on subjects via the embed loop);
// bodies are fetched live and never persisted. Sending goes via SMTP (confirmed).
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import pino from "pino";
import type Database from "better-sqlite3";
import { insertMessage } from "./db.js";
import {
  EMAIL_ACCOUNTS,
  EMAIL_BACKFILL_DAYS,
  EMAIL_POLL_SECS,
  type EmailAccount,
} from "./config.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function account(name: string): EmailAccount {
  const a = EMAIL_ACCOUNTS.find((x) => x.name === name);
  if (!a) throw new Error(`unknown email account: ${name}`);
  return a;
}

async function withImap<T>(acc: EmailAccount, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: acc.imapHost,
    port: acc.imapPort,
    secure: true,
    auth: { user: acc.user, pass: acc.pass },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => {});
  }
}

// Fetch INBOX headers since N days ago and store them (dedup on Message-ID).
async function syncAccount(
  db: Database.Database,
  acc: EmailAccount,
  sinceDays: number,
): Promise<void> {
  await withImap(acc, async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const since = new Date(Date.now() - sinceDays * 86_400_000);
      const uids = (await client.search({ since }, { uid: true })) || [];
      if (!uids.length) return;
      let n = 0;
      for await (const msg of client.fetch(uids, { envelope: true }, { uid: true })) {
        const env = msg.envelope;
        if (!env) continue;
        const from = env.from?.[0];
        const inserted = insertMessage(db, {
          ext_id: env.messageId || `${acc.name}:${msg.uid}`,
          source: "email",
          chat_id: from?.address || acc.user, // group by sender
          chat_name: from?.name || from?.address || null,
          sender: from?.address || null,
          sender_name: from?.name || null,
          direction: "in",
          ts: env.date ? new Date(env.date).getTime() : Date.now(),
          body: env.subject || "(senza oggetto)",
          attachments_json: null,
          raw_json: JSON.stringify({ account: acc.name, uid: msg.uid }),
        });
        if (inserted) n++;
      }
      if (n) log.info(`[email:${acc.name}] +${n} header(s)`);
    } finally {
      lock.release();
    }
  });
}

// Start a background poll loop per account: initial bounded backfill, then incremental.
export async function startEmail(db: Database.Database): Promise<void> {
  if (!EMAIL_ACCOUNTS.length) {
    log.info("email disabled (no EMAIL_ACCOUNTS_JSON)");
    return;
  }
  for (const acc of EMAIL_ACCOUNTS) {
    (async function loop() {
      let first = true;
      for (;;) {
        try {
          await syncAccount(db, acc, first ? EMAIL_BACKFILL_DAYS : 2);
          if (first) log.info(`[email:${acc.name}] backfill done`);
          first = false;
        } catch (e: any) {
          log.warn(
            { err: e?.message ?? String(e), code: e?.code, response: e?.response },
            `[email:${acc.name}] sync failed`,
          );
        }
        await sleep(EMAIL_POLL_SECS * 1000);
      }
    })();
  }
  log.info(`email enabled: ${EMAIL_ACCOUNTS.map((a) => a.name).join(", ")}`);
}

// Gmail "All Mail" mailbox path (localized, e.g. "[Gmail]/Tutti i messaggi"),
// resolved via the \All special-use flag. Falls back to the English default.
async function allMailPath(client: ImapFlow): Promise<string> {
  const boxes = await client.list();
  const all = boxes.find((b) => b.specialUse === "\\All");
  return all?.path ?? "[Gmail]/All Mail";
}

export interface EmailHit {
  account: string;
  uid: number;
  mailbox: string;
  from: string | null;
  fromName: string | null;
  subject: string;
  date: number;
}

// Provider-neutral search criteria. ZeroClaw speaks only this; the per-provider
// translation (Gmail X-GM-RAW vs standard IMAP SEARCH) lives below. All fields
// are ANDed; `text` is a free-text term matched against headers+body. `since`
// is inclusive, `before` is exclusive (IMAP/Gmail semantics). `hasAttachment`
// is honoured on Gmail and silently ignored where IMAP can't express it.
export interface EmailQuery {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  since?: Date;
  before?: Date;
  hasAttachment?: boolean;
}

function hasCriteria(q: EmailQuery): boolean {
  return Boolean(q.from || q.to || q.subject || q.text || q.since || q.before || q.hasAttachment);
}

// Live search across the WHOLE mailbox (no archive, no age limit, body included).
// Takes provider-neutral criteria: on Gmail it builds an X-GM-RAW query over the
// All-Mail mailbox; on other providers (e.g. iCloud) it runs standard IMAP SEARCH
// across the selectable folders. Each hit carries its own `mailbox`, so
// fetchEmailBody must be called with the returned value.
export async function searchEmail(
  accountName: string,
  q: EmailQuery,
  limit = 30,
): Promise<EmailHit[]> {
  const acc = account(accountName);
  if (!hasCriteria(q)) return []; // never run an unbounded "match everything" search
  return withImap(acc, async (client) => {
    return client.capabilities.has("X-GM-EXT-1")
      ? gmailSearch(client, acc, q, limit)
      : imapSearch(client, acc, q, limit);
  });
}

// Build one EmailHit from a fetched message envelope.
function hitFromEnvelope(acc: EmailAccount, mailbox: string, msg: any): EmailHit | null {
  const env = msg.envelope;
  if (!env) return null;
  const from = env.from?.[0];
  return {
    account: acc.name,
    uid: msg.uid,
    mailbox,
    from: from?.address ?? null,
    fromName: from?.name ?? null,
    subject: env.subject || "(senza oggetto)",
    date: env.date ? new Date(env.date).getTime() : Date.now(),
  };
}

const gmDate = (d: Date) => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
const gmQuote = (s: string) => (/\s/.test(s) ? `"${s}"` : s);

// Translate neutral criteria into a Gmail X-GM-RAW query string.
function toGmRaw(q: EmailQuery): string {
  const parts: string[] = [];
  if (q.from) parts.push(`from:${gmQuote(q.from)}`);
  if (q.to) parts.push(`to:${gmQuote(q.to)}`);
  if (q.subject) parts.push(`subject:${gmQuote(q.subject)}`);
  if (q.hasAttachment) parts.push("has:attachment");
  if (q.since) parts.push(`after:${gmDate(q.since)}`);
  if (q.before) parts.push(`before:${gmDate(q.before)}`);
  if (q.text) parts.push(q.text);
  return parts.join(" ");
}

// Translate neutral criteria into an ImapFlow SEARCH object. `hasAttachment` has
// no standard-IMAP equivalent and is dropped.
function toImapCriteria(q: EmailQuery): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  if (q.from) c.from = q.from;
  if (q.to) c.to = q.to;
  if (q.subject) c.subject = q.subject;
  if (q.text) c.text = q.text;
  if (q.since) c.since = q.since;
  if (q.before) c.before = q.before;
  return c;
}

// Gmail: full-mailbox, body-aware search via the X-GM-RAW extension.
async function gmailSearch(
  client: ImapFlow,
  acc: EmailAccount,
  q: EmailQuery,
  limit: number,
): Promise<EmailHit[]> {
  const box = await allMailPath(client);
  const lock = await client.getMailboxLock(box);
  try {
    const uids = (await client.search({ gmraw: toGmRaw(q) }, { uid: true })) || [];
    if (!uids.length) return [];
    const pick = uids.slice(-limit).reverse(); // newest first, capped
    const hits: EmailHit[] = [];
    for await (const msg of client.fetch(pick, { envelope: true }, { uid: true })) {
      const h = hitFromEnvelope(acc, box, msg);
      if (h) hits.push(h);
    }
    return hits;
  } finally {
    lock.release();
  }
}

// Non-Gmail fallback: standard IMAP SEARCH over each selectable folder (skipping
// Trash/Junk/Drafts), merged newest-first and capped.
async function imapSearch(
  client: ImapFlow,
  acc: EmailAccount,
  q: EmailQuery,
  limit: number,
): Promise<EmailHit[]> {
  const criteria = toImapCriteria(q);
  if (!Object.keys(criteria).length) return []; // only hasAttachment was set
  const skip = new Set(["\\Trash", "\\Junk", "\\Drafts"]);
  const boxes = (await client.list()).filter(
    (b) => !b.flags?.has("\\Noselect") && !(b.specialUse && skip.has(b.specialUse)),
  );
  const hits: EmailHit[] = [];
  for (const box of boxes) {
    const lock = await client.getMailboxLock(box.path);
    try {
      const uids = (await client.search(criteria as any, { uid: true })) || [];
      if (!uids.length) continue;
      const pick = uids.slice(-limit).reverse();
      for await (const msg of client.fetch(pick, { envelope: true }, { uid: true })) {
        const h = hitFromEnvelope(acc, box.path, msg);
        if (h) hits.push(h);
      }
    } finally {
      lock.release();
    }
  }
  hits.sort((a, b) => b.date - a.date);
  return hits.slice(0, limit);
}

// On-demand: fetch + parse the full body of one message (NOT stored). `mailbox`
// defaults to INBOX (archive results) but accepts the All-Mail path for hits
// coming from searchEmail.
export async function fetchEmailBody(
  accountName: string,
  uid: number | string,
  mailbox = "INBOX",
): Promise<string> {
  const acc = account(accountName);
  return withImap(acc, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) return "(messaggio non trovato)";
      const parsed = await simpleParser(msg.source as Buffer);
      const text = parsed.text || parsed.html?.toString().replace(/<[^>]+>/g, " ") || "";
      return text.trim().slice(0, 8000);
    } finally {
      lock.release();
    }
  });
}

// Send an email via the account's SMTP (Gmail app password).
export async function sendEmail(
  accountName: string,
  to: string,
  subject: string,
  text: string,
): Promise<{ messageId: string; accepted: string[] }> {
  const acc = account(accountName);
  const transport = nodemailer.createTransport({
    host: acc.smtpHost,
    port: acc.smtpPort,
    secure: acc.smtpPort === 465,
    auth: { user: acc.user, pass: acc.pass },
  });
  const info = await transport.sendMail({ from: acc.user, to, subject, text });
  return { messageId: info.messageId, accepted: (info.accepted as string[]) ?? [] };
}
