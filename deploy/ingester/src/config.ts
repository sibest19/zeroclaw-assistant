// Central paths/config for the ingester. Kept tiny on purpose.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// deploy/ingester/
export const ROOT = join(__dirname, "..");

// Dedicated archive DB (separate from ZeroClaw's memory DB, by design).
export const DATA_DIR = process.env.INGESTER_DATA_DIR ?? join(ROOT, "data");
export const ARCHIVE_DB = process.env.INGESTER_ARCHIVE_DB ?? join(DATA_DIR, "archive.db");

// Where the WhatsApp (Baileys) auth/session state lives (phase 2).
export const WA_AUTH_DIR = process.env.INGESTER_WA_AUTH_DIR ?? join(DATA_DIR, "wa-auth");

// Transcriber service (parakeet). Empty = transcription disabled (audio stays "[audio]").
export const TRANSCRIBER_URL = process.env.TRANSCRIBER_URL ?? "";
