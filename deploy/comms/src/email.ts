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
          log.warn({ err: e?.message ?? String(e), code: e?.code, response: e?.response }, `[email:${acc.name}] sync failed`);
        }
        await sleep(EMAIL_POLL_SECS * 1000);
      }
    })();
  }
  log.info(`email enabled: ${EMAIL_ACCOUNTS.map((a) => a.name).join(", ")}`);
}

// On-demand: fetch + parse the full body of one message (NOT stored).
export async function fetchEmailBody(accountName: string, uid: number | string): Promise<string> {
  const acc = account(accountName);
  return withImap(acc, async (client) => {
    const lock = await client.getMailboxLock("INBOX");
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
