// Central paths/config for the comms. Kept tiny on purpose.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// deploy/comms/
export const ROOT = join(__dirname, "..");

// Dedicated archive DB (separate from ZeroClaw's memory DB, by design).
export const DATA_DIR = process.env.COMMS_DATA_DIR ?? join(ROOT, "data");
export const ARCHIVE_DB = process.env.COMMS_ARCHIVE_DB ?? join(DATA_DIR, "archive.db");

// Where the WhatsApp (Baileys) auth/session state lives (phase 2).
export const WA_AUTH_DIR = process.env.COMMS_WA_AUTH_DIR ?? join(DATA_DIR, "wa-auth");

// Transcriber service (parakeet). Empty = transcription disabled (audio stays "[audio]").
export const TRANSCRIBER_URL = process.env.TRANSCRIBER_URL ?? "";

// ── Email (IMAP/SMTP, on-demand) ───────────────────────────────────────────
export interface EmailAccount {
  name: string; // short label used in tools (e.g. "personal")
  user: string; // full address
  pass: string; // Gmail app password
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
}

// EMAIL_ACCOUNTS_JSON = '[{"name":"personal","user":"a@gmail.com","pass":"app-pw"}, ...]'
// (imap/smtp default to Gmail). Empty = email disabled.
export const EMAIL_ACCOUNTS: EmailAccount[] = (() => {
  const raw = process.env.EMAIL_ACCOUNTS_JSON;
  if (!raw) return [];
  try {
    return (JSON.parse(raw) as any[]).map((a) => ({
      name: a.name,
      user: a.user,
      pass: a.pass,
      imapHost: a.imap_host ?? "imap.gmail.com",
      imapPort: a.imap_port ?? 993,
      smtpHost: a.smtp_host ?? "smtp.gmail.com",
      smtpPort: a.smtp_port ?? 587,
    }));
  } catch (e) {
    console.error("EMAIL_ACCOUNTS_JSON invalid:", e);
    return [];
  }
})();

// Only headers within this window are backfilled on startup (bodies never stored).
export const EMAIL_BACKFILL_DAYS = Number(process.env.EMAIL_BACKFILL_DAYS ?? 180);
export const EMAIL_POLL_SECS = Number(process.env.EMAIL_POLL_SECS ?? 180);
