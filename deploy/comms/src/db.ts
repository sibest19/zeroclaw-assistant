// Dedicated message archive (SQLite + FTS5). Shared by the comms (writer)
// and the MCP server (reader). WAL mode lets the always-on comms write while
// the MCP server reads concurrently.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ARCHIVE_DB } from "./config.js";

export type Source = "whatsapp" | "email";
export type Direction = "in" | "out";
// 'sync'      = captured from WhatsApp/IMAP (incoming, or sent by Simone elsewhere)
// 'assistant' = sent on Simone's behalf BY this assistant (via OpenClaw/MCP)
export type Origin = "sync" | "assistant";

export interface MessageRow {
  ext_id: string;
  source: Source;
  chat_id: string;
  chat_name?: string | null;
  sender?: string | null;
  sender_name?: string | null;
  direction: Direction;
  ts: number;
  body?: string | null;
  attachments_json?: string | null;
  raw_json?: string | null;
  origin?: Origin; // default 'sync'
  is_read?: 0 | 1 | null; // for incoming: read by Simone? best-effort. null = unknown
  chat_display?: string | null; // resolved chat name (contact/group), joined from chats
  edited_at?: number | null; // last edit time (ms), null = never edited
  deleted_at?: number | null; // revoke/delete time (ms), null = not deleted; body kept
  revision?: number | null; // number of edits applied (0 = original)
}

const SCHEMA_VERSION = 3;
// FTS5 tokenizer: fold diacritics so "perche" matches "perché", etc. (Italian).
const FTS_TOKENIZER = "unicode61 remove_diacritics 2";

export function openDb(path: string = ARCHIVE_DB): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

function columnExists(db: Database.Database, table: string, col: string): boolean {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).some((c) => c.name === col);
}

function ftsHasDiacritics(db: Database.Database): boolean {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE name='messages_fts'").get() as
    | { sql: string }
    | undefined;
  return !!row && /remove_diacritics/.test(row.sql);
}

function initSchema(db: Database.Database): void {
  // Fresh DBs get the full v2 shape directly; existing DBs are migrated below.
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      rowid            INTEGER PRIMARY KEY,
      ext_id           TEXT NOT NULL,
      source           TEXT NOT NULL,
      chat_id          TEXT NOT NULL,
      chat_name        TEXT,
      sender           TEXT,
      sender_name      TEXT,
      direction        TEXT NOT NULL,
      ts               INTEGER NOT NULL,
      body             TEXT,
      attachments_json TEXT,
      raw_json         TEXT,
      origin           TEXT NOT NULL DEFAULT 'sync',
      is_read          INTEGER,
      edited_at        INTEGER,
      deleted_at       INTEGER,
      revision         INTEGER NOT NULL DEFAULT 0,
      ingested_at      INTEGER NOT NULL,
      UNIQUE(source, ext_id)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, ts);
    CREATE INDEX IF NOT EXISTS idx_messages_ts      ON messages(ts);

    -- Audit trail of message edits and deletions (one row per change). The
    -- messages row holds the CURRENT state (edited body / deleted flag); these
    -- rows preserve what was there before, so history is recoverable.
    CREATE TABLE IF NOT EXISTS message_revisions (
      id            INTEGER PRIMARY KEY,
      message_rowid INTEGER NOT NULL REFERENCES messages(rowid) ON DELETE CASCADE,
      kind          TEXT NOT NULL,          -- 'edit' | 'delete'
      prev_body     TEXT,                   -- body before the change
      new_body      TEXT,                   -- body after the change (NULL for delete)
      changed_at    INTEGER NOT NULL,       -- when WhatsApp reported the change (ms)
      recorded_at   INTEGER NOT NULL        -- when we wrote this row (ms)
    );
    CREATE INDEX IF NOT EXISTS idx_revisions_msg     ON message_revisions(message_rowid, changed_at);
    CREATE INDEX IF NOT EXISTS idx_revisions_changed ON message_revisions(changed_at);

    CREATE TABLE IF NOT EXISTS chats (
      chat_id      TEXT PRIMARY KEY,
      source       TEXT NOT NULL,
      name         TEXT,
      is_group     INTEGER NOT NULL DEFAULT 0,
      last_ts      INTEGER,
      unread_count INTEGER
    );

    -- One embedding vector per message body (rowid = messages.rowid). Stored as
    -- a Float32 BLOB; the in-memory index brute-forces cosine for KNN.
    CREATE TABLE IF NOT EXISTS embeddings (
      rowid INTEGER PRIMARY KEY,
      vec   BLOB NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      body, content='messages', content_rowid='rowid', tokenize='${FTS_TOKENIZER}'
    );
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, body) VALUES('delete', old.rowid, old.body);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, body) VALUES('delete', old.rowid, old.body);
      INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
    END;
  `);

  const ver = db.pragma("user_version", { simple: true }) as number;
  if (ver < SCHEMA_VERSION) migrate(db, ver);
}

function migrate(db: Database.Database, from: number): void {
  db.transaction(() => {
    // v1 → v2: new columns on existing tables + better FTS tokenizer.
    if (!columnExists(db, "messages", "origin")) {
      db.exec("ALTER TABLE messages ADD COLUMN origin TEXT NOT NULL DEFAULT 'sync'");
    }
    if (!columnExists(db, "messages", "is_read")) {
      db.exec("ALTER TABLE messages ADD COLUMN is_read INTEGER");
    }
    if (!columnExists(db, "chats", "unread_count")) {
      db.exec("ALTER TABLE chats ADD COLUMN unread_count INTEGER");
    }
    // origin column now guaranteed to exist (fresh or migrated) → safe to index.
    db.exec("CREATE INDEX IF NOT EXISTS idx_messages_origin ON messages(origin)");
    if (!ftsHasDiacritics(db)) {
      db.exec(`
        DROP TABLE IF EXISTS messages_fts;
        CREATE VIRTUAL TABLE messages_fts USING fts5(
          body, content='messages', content_rowid='rowid', tokenize='${FTS_TOKENIZER}'
        );
        INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
      `);
    }
    // v2 → v3: edit/deletion tracking columns (message_revisions table is created
    // unconditionally in initSchema via CREATE IF NOT EXISTS).
    if (!columnExists(db, "messages", "edited_at")) {
      db.exec("ALTER TABLE messages ADD COLUMN edited_at INTEGER");
    }
    if (!columnExists(db, "messages", "deleted_at")) {
      db.exec("ALTER TABLE messages ADD COLUMN deleted_at INTEGER");
    }
    if (!columnExists(db, "messages", "revision")) {
      db.exec("ALTER TABLE messages ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
    }
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}

// Idempotent insert (dedup on source+ext_id). Returns true if a new row landed.
export function insertMessage(db: Database.Database, m: MessageRow): boolean {
  const info = db
    .prepare(
      `
    INSERT INTO messages
      (ext_id, source, chat_id, chat_name, sender, sender_name, direction, ts, body,
       attachments_json, raw_json, origin, is_read, ingested_at)
    VALUES
      (@ext_id, @source, @chat_id, @chat_name, @sender, @sender_name, @direction, @ts, @body,
       @attachments_json, @raw_json, @origin, @is_read, @ingested_at)
    ON CONFLICT(source, ext_id) DO NOTHING
  `,
    )
    .run({
      ext_id: m.ext_id,
      source: m.source,
      chat_id: m.chat_id,
      chat_name: m.chat_name ?? null,
      sender: m.sender ?? null,
      sender_name: m.sender_name ?? null,
      direction: m.direction,
      ts: m.ts,
      body: m.body ?? null,
      attachments_json: m.attachments_json ?? null,
      raw_json: m.raw_json ?? null,
      origin: m.origin ?? "sync",
      is_read: m.is_read ?? null,
      ingested_at: Date.now(),
    });
  if (info.changes > 0) {
    db.prepare(
      `
      INSERT INTO chats (chat_id, source, name, is_group, last_ts)
      VALUES (@chat_id, @source, @name, @is_group, @ts)
      ON CONFLICT(chat_id) DO UPDATE SET
        -- keep an already-resolved name (contact/group via setChatName); only fill if empty.
        name = COALESCE(chats.name, excluded.name),
        last_ts = MAX(COALESCE(chats.last_ts, 0), excluded.last_ts)
    `,
    ).run({
      chat_id: m.chat_id,
      source: m.source,
      // For a 1:1 chat, an INCOMING message's sender name IS the contact's name →
      // a good chat name. Never for groups (sender ≠ group) or outgoing (= Simone).
      // setChatName (group subjects, saved contacts) still wins via COALESCE.
      name: m.direction === "in" && !m.chat_id.includes("@g.us") ? (m.sender_name ?? null) : null,
      is_group: m.chat_id.includes("@g.us") ? 1 : 0,
      ts: m.ts,
    });
  }
  return info.changes > 0;
}

// Record a message the assistant sent on Simone's behalf (origin='assistant').
// Called by the send tool; the WhatsApp echo later dedups on (source, ext_id).
export function recordAssistantSend(
  db: Database.Database,
  m: Omit<MessageRow, "direction" | "origin">,
): boolean {
  return insertMessage(db, { ...m, direction: "out", origin: "assistant" });
}

// Update per-chat unread count (reliable signal from WhatsApp chat events).
export function setChatUnread(db: Database.Database, chatId: string, unread: number): void {
  db.prepare(
    `
    INSERT INTO chats (chat_id, source, is_group, unread_count)
    VALUES (@chat_id, 'whatsapp', @is_group, @unread)
    ON CONFLICT(chat_id) DO UPDATE SET unread_count = @unread
  `,
  ).run({ chat_id: chatId, is_group: chatId.includes("@g.us") ? 1 : 0, unread });
}

// Replace a message body (e.g. audio placeholder -> transcript). The UPDATE
// trigger refreshes FTS; we drop its embedding so the embed loop re-indexes the
// new text. Returns true if the message existed.
export function updateMessageBody(
  db: Database.Database,
  source: Source,
  extId: string,
  text: string,
): boolean {
  const row = db
    .prepare("SELECT rowid FROM messages WHERE source = ? AND ext_id = ?")
    .get(source, extId) as { rowid: number } | undefined;
  if (!row) return false;
  db.prepare("UPDATE messages SET body = ? WHERE rowid = ?").run(text, row.rowid);
  db.prepare("DELETE FROM embeddings WHERE rowid = ?").run(row.rowid);
  return true;
}

// Mark a specific message read/unread (best-effort, from receipts).
export function markRead(db: Database.Database, source: Source, extId: string, read: 0 | 1): void {
  db.prepare("UPDATE messages SET is_read = @read WHERE source = @source AND ext_id = @ext_id").run(
    { read, source, ext_id: extId },
  );
}

// Record an edit: append a revision (prev → new) and update the live body to the
// latest text. The UPDATE trigger refreshes FTS; we drop the embedding so the new
// text is re-indexed. No-op if the message is unknown or the body is unchanged.
export function recordEdit(
  db: Database.Database,
  source: Source,
  extId: string,
  newBody: string,
  changedAt: number,
): boolean {
  const row = db
    .prepare("SELECT rowid, body FROM messages WHERE source = ? AND ext_id = ?")
    .get(source, extId) as { rowid: number; body: string | null } | undefined;
  if (!row) return false;
  if ((row.body ?? "") === newBody) return false; // identical → ignore (echo)
  db.transaction(() => {
    db.prepare(
      `INSERT INTO message_revisions (message_rowid, kind, prev_body, new_body, changed_at, recorded_at)
       VALUES (?, 'edit', ?, ?, ?, ?)`,
    ).run(row.rowid, row.body ?? null, newBody, changedAt, Date.now());
    db.prepare(
      "UPDATE messages SET body = ?, edited_at = ?, revision = revision + 1 WHERE rowid = ?",
    ).run(newBody, changedAt, row.rowid);
    db.prepare("DELETE FROM embeddings WHERE rowid = ?").run(row.rowid);
  })();
  return true;
}

// Mark a message deleted (revoked). Keeps the body so Simone can still read what
// was removed; records a 'delete' revision. Idempotent (no-op if already deleted
// or unknown).
export function markDeleted(
  db: Database.Database,
  source: Source,
  extId: string,
  deletedAt: number,
): boolean {
  const row = db
    .prepare("SELECT rowid, body, deleted_at FROM messages WHERE source = ? AND ext_id = ?")
    .get(source, extId) as
    | { rowid: number; body: string | null; deleted_at: number | null }
    | undefined;
  if (!row || row.deleted_at != null) return false;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO message_revisions (message_rowid, kind, prev_body, new_body, changed_at, recorded_at)
       VALUES (?, 'delete', ?, NULL, ?, ?)`,
    ).run(row.rowid, row.body ?? null, deletedAt, Date.now());
    db.prepare("UPDATE messages SET deleted_at = ? WHERE rowid = ?").run(deletedAt, row.rowid);
  })();
  return true;
}

// A single edit/deletion event, joined with its chat + sender for display.
export interface RevisionRow {
  kind: "edit" | "delete";
  prev_body: string | null;
  new_body: string | null;
  changed_at: number;
  chat_id: string;
  chat_display: string | null;
  sender_name: string | null;
  sender: string | null;
  direction: Direction;
}

// Recent edits & deletions across all chats (audit feed), most recent first.
export function recentRevisions(
  db: Database.Database,
  opts: { since?: number; limit?: number } = {},
): RevisionRow[] {
  const since = opts.since ?? 0;
  const limit = opts.limit ?? 100;
  return db
    .prepare(
      `
    SELECT r.kind, r.prev_body, r.new_body, r.changed_at,
           m.chat_id, m.sender_name, m.sender, m.direction,
           c.name AS chat_display
    FROM message_revisions r
    JOIN messages m ON m.rowid = r.message_rowid
    LEFT JOIN chats c ON c.chat_id = m.chat_id
    WHERE r.changed_at >= @since
    ORDER BY r.changed_at DESC LIMIT @limit
  `,
    )
    .all({ since, limit }) as RevisionRow[];
}

// Resolve/refresh a chat's display name (contact name or group subject). No-op for
// empty names; creates the chat row if needed.
export function setChatName(
  db: Database.Database,
  chatId: string,
  name: string | null | undefined,
): void {
  const n = (name ?? "").trim();
  if (!n) return;
  db.prepare(
    `
    INSERT INTO chats (chat_id, source, name, is_group)
    VALUES (@chat_id, 'whatsapp', @name, @is_group)
    ON CONFLICT(chat_id) DO UPDATE SET name = @name
  `,
  ).run({ chat_id: chatId, name: n, is_group: chatId.includes("@g.us") ? 1 : 0 });
}

// One-time backfill: name unnamed 1:1 chats from the latest INCOMING message's
// sender name (the contact). Groups are named separately from their subject.
export function backfillChatNames(db: Database.Database): number {
  const r = db
    .prepare(
      `
    UPDATE chats SET name = (
      SELECT m.sender_name FROM messages m
      WHERE m.chat_id = chats.chat_id AND m.direction = 'in' AND m.sender_name IS NOT NULL
      ORDER BY m.ts DESC LIMIT 1
    )
    WHERE name IS NULL AND chat_id NOT LIKE '%@g.us'
  `,
    )
    .run();
  return r.changes;
}

// Resolved display name for a chat (or null).
export function chatName(db: Database.Database, chatId: string): string | null {
  const row = db.prepare("SELECT name FROM chats WHERE chat_id = ?").get(chatId) as
    | { name: string | null }
    | undefined;
  return row?.name ?? null;
}

function ftsClause(): string {
  return "messages_fts MATCH @query AND m.ts >= @since";
}

export function searchMessages(
  db: Database.Database,
  query: string,
  opts: { since?: number; limit?: number } = {},
): MessageRow[] {
  const limit = opts.limit ?? 50;
  const since = opts.since ?? 0;
  return db
    .prepare(
      `
    SELECT m.*, c.name AS chat_display FROM messages_fts f
    JOIN messages m ON m.rowid = f.rowid
    LEFT JOIN chats c ON c.chat_id = m.chat_id
    WHERE ${ftsClause()}
    ORDER BY m.ts DESC LIMIT @limit
  `,
    )
    .all({ query, since, limit }) as unknown as MessageRow[];
}

export function recentChats(
  db: Database.Database,
  opts: { since?: number; limit?: number } = {},
): Array<{
  chat_id: string;
  name: string | null;
  source: string;
  last_ts: number;
  n: number;
  unread_count: number | null;
}> {
  const since = opts.since ?? 0;
  const limit = opts.limit ?? 30;
  return db
    .prepare(
      `
    SELECT c.chat_id, c.name, c.source, c.last_ts, c.unread_count,
           (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.chat_id AND m.ts >= @since) AS n
    FROM chats c
    WHERE c.last_ts >= @since
    ORDER BY c.last_ts DESC LIMIT @limit
  `,
    )
    .all({ since, limit }) as any[];
}

export function recentMessages(
  db: Database.Database,
  opts: { since?: number; limit?: number } = {},
): MessageRow[] {
  const since = opts.since ?? 0;
  const limit = opts.limit ?? 200;
  return db
    .prepare(
      `
    SELECT m.*, c.name AS chat_display FROM messages m
    LEFT JOIN chats c ON c.chat_id = m.chat_id
    WHERE m.ts >= @since ORDER BY m.ts DESC LIMIT @limit
  `,
    )
    .all({ since, limit }) as unknown as MessageRow[];
}

export function getThread(
  db: Database.Database,
  chatId: string,
  opts: { limit?: number } = {},
): MessageRow[] {
  const limit = opts.limit ?? 100;
  return db
    .prepare(
      `
    SELECT m.*, c.name AS chat_display FROM messages m
    LEFT JOIN chats c ON c.chat_id = m.chat_id
    WHERE m.chat_id = @chatId ORDER BY m.ts DESC LIMIT @limit
  `,
    )
    .all({ chatId, limit }) as unknown as MessageRow[];
}

// ── Embeddings (semantic search) ───────────────────────────────────────────

export function countUnembedded(db: Database.Database): number {
  return (
    db
      .prepare(
        `
    SELECT COUNT(*) c FROM messages m
    LEFT JOIN embeddings e ON e.rowid = m.rowid
    WHERE e.rowid IS NULL AND m.body IS NOT NULL AND m.body != ''
  `,
      )
      .get() as { c: number }
  ).c;
}

export function getUnembedded(
  db: Database.Database,
  limit: number,
): Array<{ rowid: number; body: string }> {
  return db
    .prepare(
      `
    SELECT m.rowid, m.body FROM messages m
    LEFT JOIN embeddings e ON e.rowid = m.rowid
    WHERE e.rowid IS NULL AND m.body IS NOT NULL AND m.body != ''
    LIMIT @limit
  `,
    )
    .all({ limit }) as Array<{ rowid: number; body: string }>;
}

export function storeEmbeddings(
  db: Database.Database,
  rows: Array<{ rowid: number; vec: Buffer }>,
): void {
  const stmt = db.prepare("INSERT OR REPLACE INTO embeddings (rowid, vec) VALUES (@rowid, @vec)");
  const tx = db.transaction((rs: Array<{ rowid: number; vec: Buffer }>) => {
    for (const r of rs) stmt.run(r);
  });
  tx(rows);
}

export function allEmbeddings(db: Database.Database): Array<{ rowid: number; vec: Buffer }> {
  return db.prepare("SELECT rowid, vec FROM embeddings").all() as Array<{
    rowid: number;
    vec: Buffer;
  }>;
}

export function messagesByRowids(db: Database.Database, rowids: number[]): MessageRow[] {
  if (rowids.length === 0) return [];
  const ph = rowids.map(() => "?").join(",");
  return db
    .prepare(`SELECT * FROM messages WHERE rowid IN (${ph})`)
    .all(...rowids) as unknown as MessageRow[];
}
