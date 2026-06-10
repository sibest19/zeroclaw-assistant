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
import {
  insertMessage,
  setChatUnread,
  setChatName,
  updateMessageBody,
  recordAssistantSend,
  type MessageRow,
} from "./db.js";
import { WA_AUTH_DIR, TRANSCRIBER_URL } from "./config.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

// Current live socket — reassigned on every (re)connect so outbound sends always
// use a valid session even after Baileys reconnects.
let currentSock: WASocket | null = null;

// Send a WhatsApp message on Simone's behalf and record it as origin='assistant'.
// `to` may be a JID (…@s.whatsapp.net / …@g.us) or a phone number (digits).
export async function sendWhatsApp(
  db: Database.Database,
  to: string,
  text: string,
): Promise<{ jid: string; id: string | null }> {
  if (!currentSock) throw new Error("WhatsApp not connected");
  const jid = to.includes("@") ? to : `${to.replace(/\D/g, "")}@s.whatsapp.net`;
  const sent = await currentSock.sendMessage(jid, { text });
  const id = sent?.key?.id ?? null;
  if (id) {
    // Record now (origin=assistant). The echo via messages.upsert dedups on ext_id.
    recordAssistantSend(db, {
      ext_id: id,
      source: "whatsapp",
      chat_id: jid,
      chat_name: null,
      sender: "me",
      sender_name: "me",
      ts: Date.now(),
      body: text,
      attachments_json: null,
      raw_json: null,
    });
  }
  return { jid, id };
}

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
  currentSock = sock; // expose for outbound sends (refreshed on every reconnect)

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
      // Baileys doesn't re-emit group metadata on reconnect → fetch subjects now.
      sock
        .groupFetchAllParticipating()
        .then((groups) => {
          let n = 0;
          for (const [jid, meta] of Object.entries(groups)) {
            const subject = (meta as any)?.subject;
            if (subject) {
              setChatName(db, jid, subject);
              n++;
            }
          }
          if (n) log.info(`resolved ${n} group name(s)`);
        })
        .catch((e) => log.warn({ err: String(e) }, "groupFetchAllParticipating failed"));
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

  // Resolve display names so search results / send-confirmations show contact and
  // group NAMES instead of raw JIDs.
  const applyContacts = (
    contacts: Array<{
      id?: string | null;
      name?: string | null;
      notify?: string | null;
      verifiedName?: string | null;
    }>,
  ) => {
    for (const c of contacts ?? []) {
      if (c?.id) setChatName(db, c.id, c.name || c.verifiedName || c.notify || null);
    }
  };
  const applyChats = (
    chats: Array<{ id?: string | null; name?: string | null; unreadCount?: number | null }>,
  ) => {
    for (const c of chats ?? []) {
      if (!c?.id) continue;
      if (typeof c.unreadCount === "number") setChatUnread(db, c.id, c.unreadCount);
      if (c.name) setChatName(db, c.id, c.name); // group subject / chat name
    }
  };
  const applyGroups = (groups: Array<{ id?: string | null; subject?: string | null }>) => {
    for (const g of groups ?? []) {
      if (g?.id && g.subject) setChatName(db, g.id, g.subject);
    }
  };

  sock.ev.on("contacts.upsert", (c) => applyContacts(c as any));
  sock.ev.on("contacts.update", (c) => applyContacts(c as any));
  sock.ev.on("chats.upsert", (c) => applyChats(c as any));
  sock.ev.on("chats.update", (c) => applyChats(c as any));
  sock.ev.on("groups.upsert", (g) => applyGroups(g as any));
  sock.ev.on("groups.update", (g) => applyGroups(g as any));

  // Initial / incremental history sync (old chats + names + their unread counts).
  sock.ev.on("messaging-history.set", ({ messages, chats, contacts }) => {
    let n = 0;
    for (const msg of messages) {
      const row = toRow(msg);
      if (row && insertMessage(db, row)) n++;
    }
    applyChats(chats as any);
    applyContacts(contacts as any);
    if (n) log.info(`ingested ${n} message(s) from history sync`);
  });

  return sock;
}
