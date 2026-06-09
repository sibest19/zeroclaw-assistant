// WhatsApp Web ingestion via Baileys. Links its OWN device (separate from any
// ZeroClaw link), captures live messages + initial history sync, and writes
// everything into the dedicated archive. Read-only by default; sending is added
// in a later phase behind the MCP tool.
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import pino from "pino";
import type Database from "better-sqlite3";
import { insertMessage, setChatUnread, updateMessageBody, type MessageRow } from "./db.js";
import { WA_AUTH_DIR, TRANSCRIBER_URL } from "./config.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

// Extract human-readable text from the many WhatsApp message shapes.
function extractBody(msg: WAMessage): string | null {
  const m = msg.message;
  if (!m) return null;
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    (m.audioMessage ? "[audio]" : null) ??
    (m.imageMessage ? "[image]" : null) ??
    (m.videoMessage ? "[video]" : null) ??
    (m.documentMessage ? `[document: ${m.documentMessage.fileName ?? "file"}]` : null) ??
    (m.stickerMessage ? "[sticker]" : null) ??
    null
  );
}

function toRow(msg: WAMessage): MessageRow | null {
  const chat_id = msg.key.remoteJid ?? undefined;
  const ext_id = msg.key.id ?? undefined;
  if (!chat_id || !ext_id) return null;
  if (chat_id === "status@broadcast") return null; // skip status updates

  const body = extractBody(msg);
  const tsRaw = Number(msg.messageTimestamp ?? 0);
  const ts = tsRaw > 0 ? tsRaw * 1000 : Date.now();
  const fromMe = !!msg.key.fromMe;

  return {
    ext_id,
    source: "whatsapp",
    chat_id,
    chat_name: msg.pushName ?? null,
    sender: fromMe ? "me" : (msg.key.participant ?? chat_id).split("@")[0],
    sender_name: msg.pushName ?? null,
    direction: fromMe ? "out" : "in",
    ts,
    body,
    attachments_json: null,
    raw_json: null,
  };
}

export async function startWhatsApp(db: Database.Database): Promise<WASocket> {
  const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  log.info({ version }, "starting WhatsApp (Baileys)");

  const sock = makeWASocket({
    version,
    auth: state,
    logger: log as any,
    printQRInTerminal: false, // we render the QR ourselves below
    syncFullHistory: true, // pull chat history on first link
    markOnlineOnConnect: false, // stay invisible; we only observe
  });

  sock.ev.on("creds.update", saveCreds);

  // Download a voice note, send it to the transcriber, replace its "[audio]"
  // placeholder with the transcript (the embed loop then re-indexes it).
  // Fire-and-forget: never blocks ingestion; failures leave the placeholder.
  const transcribeAudio = async (msg: WAMessage): Promise<void> => {
    const extId = msg.key.id;
    if (!extId || !TRANSCRIBER_URL) return;
    try {
      const buf = (await downloadMediaMessage(
        msg,
        "buffer",
        {},
        { logger: log as any, reuploadRequest: sock.updateMediaMessage },
      )) as Buffer;
      const resp = await fetch(TRANSCRIBER_URL, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(buf),
      });
      if (!resp.ok) {
        log.warn(`transcribe HTTP ${resp.status} for ${extId}`);
        return;
      }
      const { text } = (await resp.json()) as { text?: string };
      if (text && text.trim()) {
        updateMessageBody(db, "whatsapp", extId, text.trim());
        log.info(`transcribed voice note ${extId} (${text.trim().length} chars)`);
      }
    } catch (e) {
      log.warn({ err: String(e) }, `voice-note transcription failed for ${extId}`);
    }
  };

  sock.ev.on("connection.update", (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      console.log("\nScan this QR in WhatsApp > Linked Devices > Link a device:\n");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      log.info("WhatsApp connected — ingesting");
    }
    if (connection === "close") {
      const code = (lastDisconnect?.error as any)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      log.warn({ code, loggedOut }, "WhatsApp connection closed");
      if (!loggedOut) {
        setTimeout(() => startWhatsApp(db).catch((e) => log.error(e, "reconnect failed")), 3000);
      } else {
        log.error("logged out — delete the wa-auth dir and re-link");
      }
    }
  });

  // Live messages.
  sock.ev.on("messages.upsert", ({ messages }) => {
    let n = 0;
    for (const msg of messages) {
      const row = toRow(msg);
      if (!row) continue;
      if (!insertMessage(db, row)) continue; // dedup: skip already-seen
      n++;
      // New voice note → transcribe in background, replacing the "[audio]" body.
      if (msg.message?.audioMessage && TRANSCRIBER_URL) void transcribeAudio(msg);
    }
    if (n) log.info(`ingested ${n} live message(s)`);
  });

  // Initial / incremental history sync (old chats + their unread counts).
  sock.ev.on("messaging-history.set", ({ messages, chats }) => {
    let n = 0;
    for (const msg of messages) {
      const row = toRow(msg);
      if (row && insertMessage(db, row)) n++;
    }
    for (const c of chats ?? []) {
      if (c.id && typeof c.unreadCount === "number") setChatUnread(db, c.id, c.unreadCount);
    }
    if (n) log.info(`ingested ${n} message(s) from history sync`);
  });

  // Live unread-count updates per chat.
  const applyChatUnread = (chats: Array<{ id?: string | null; unreadCount?: number | null }>) => {
    for (const c of chats) {
      if (c.id && typeof c.unreadCount === "number") setChatUnread(db, c.id, c.unreadCount);
    }
  };
  sock.ev.on("chats.upsert", (chats) => applyChatUnread(chats as any));
  sock.ev.on("chats.update", (updates) => applyChatUnread(updates as any));

  return sock;
}
