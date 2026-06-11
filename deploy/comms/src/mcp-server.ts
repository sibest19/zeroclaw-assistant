// MCP server (Streamable HTTP) exposing the message archive to ZeroClaw.
// Read-only retrieval tools; ZeroClaw's agent (gpt-5.5) does the summarizing.
import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type Database from "better-sqlite3";
import {
  searchMessages,
  recentChats,
  recentMessages,
  getThread,
  chatName,
  recentRevisions,
  type MessageRow,
  type RevisionRow,
} from "./db.js";
import type { VectorIndex } from "./vector-index.js";

const HOURS = 3_600_000;

// Display dates/times in Simone's timezone (configurable). Search/recent/thread
// results are formatted in local time, not UTC.
const DISPLAY_TZ = process.env.DISPLAY_TZ ?? "Europe/Rome";
const timeFmt = new Intl.DateTimeFormat("it-IT", {
  timeZone: DISPLAY_TZ,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
function localTime(ts: number): string {
  return timeFmt.format(new Date(ts));
}

// FTS5 MATCH-safe query: keep word chars, quote each token (implicit AND).
function ftsQuery(raw: string): string {
  const toks = raw.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (toks.length === 0) return '""';
  return toks.map((t) => `"${t}"`).join(" ");
}

function fmt(m: MessageRow): string {
  const when = localTime(m.ts);
  const body = (m.body ?? "").replace(/\s+/g, " ").slice(0, 500);
  if (m.source === "email") {
    // Header only (body fetched on demand). Expose account+uid for email_leggi.
    let ref = "";
    try {
      const r = JSON.parse(m.raw_json || "{}");
      if (r.account && r.uid != null) ref = `  «leggi: account=${r.account} uid=${r.uid}»`;
    } catch {}
    return `[${when}] 📧 email da ${m.sender_name || m.sender || "?"} — oggetto: ${body}${ref}`;
  }
  const via = m.origin === "assistant" ? " (inviato via assistente)" : "";
  const who = m.direction === "out" ? `io${via}` : m.sender_name || m.sender || "?";
  // Chat label = resolved contact/group name (from setChatName); JID as honest fallback.
  const name = m.chat_display || m.chat_id;
  // Show the JID too when a human name is displayed (agent needs it to act).
  const idref = m.chat_display ? `  ⟨${m.chat_id}⟩` : "";
  // Flag edited/deleted messages so they stand out (body shown is the latest text;
  // deleted messages keep their body). Use modifiche_recenti for the before/after.
  const flags =
    (m.deleted_at ? ` 🗑️[eliminato ${localTime(m.deleted_at)}]` : "") +
    (m.edited_at ? ` ✏️[modificato${m.revision && m.revision > 1 ? ` ×${m.revision}` : ""}]` : "");
  return `[${when}] (${name}) ${who}: ${body}${flags}${idref}`;
}

// Render one edit/deletion event with its before→after text.
function fmtRevision(r: RevisionRow): string {
  const when = localTime(r.changed_at);
  const who = r.direction === "out" ? "io" : r.sender_name || r.sender || "?";
  const chat = r.chat_display || r.chat_id;
  const clip = (s: string | null) => (s ?? "").replace(/\s+/g, " ").slice(0, 300);
  if (r.kind === "delete") {
    return `[${when}] 🗑️ ELIMINATO in (${chat}) da ${who}: "${clip(r.prev_body)}"`;
  }
  return `[${when}] ✏️ MODIFICATO in (${chat}) da ${who}: "${clip(r.prev_body)}" → "${clip(r.new_body)}"`;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

// Injected senders/readers (present only in the live comms, not the read-only
// MCP standalone).
export type SendWa = (to: string, text: string) => Promise<{ jid: string; id: string | null }>;
export type ReadEmail = (account: string, uid: number | string) => Promise<string>;
export type SendEmail = (
  account: string,
  to: string,
  subject: string,
  text: string,
) => Promise<{ messageId: string; accepted: string[] }>;

export interface CommsActions {
  sendWa?: SendWa;
  readEmail?: ReadEmail;
  sendEmail?: SendEmail;
}

export function buildMcpServer(
  db: Database.Database,
  index?: VectorIndex,
  actions: CommsActions = {},
): McpServer {
  const { sendWa, readEmail, sendEmail } = actions;
  const server = new McpServer({ name: "archivio-messaggi", version: "0.1.0" });

  server.registerTool(
    "cerca_messaggi",
    {
      description:
        "Ricerca per PAROLA ESATTA (full-text) nei messaggi. Usa quando cerchi un termine/nome preciso. Per argomenti/concetti usa invece cerca_semantica.",
      inputSchema: {
        query: z.string().describe("parole chiave esatte"),
        giorni: z.number().optional().describe("limita agli ultimi N giorni"),
        limit: z.number().optional().describe("max risultati (default 50)"),
      },
    },
    async ({ query, giorni, limit }) => {
      const since = giorni ? Date.now() - giorni * 24 * HOURS : 0;
      const rows = searchMessages(db, ftsQuery(query), { since, limit: limit ?? 50 });
      return text(rows.length ? rows.map(fmt).join("\n") : "nessun risultato");
    },
  );

  if (index) {
    server.registerTool(
      "cerca_semantica",
      {
        description:
          "Ricerca SEMANTICA (per significato) nei messaggi: trova conversazioni su un argomento anche senza la parola esatta (es. 'montagna' trova 'gita in vetta', 'rifugio'). Preferiscila per domande su temi/argomenti.",
        inputSchema: {
          query: z.string().describe("argomento o frase da cercare per significato"),
          giorni: z.number().optional().describe("limita agli ultimi N giorni"),
          limit: z.number().optional().describe("max risultati (default 30)"),
        },
      },
      async ({ query, giorni, limit }) => {
        const since = giorni ? Date.now() - giorni * 24 * HOURS : undefined;
        const rows = await index.search(query, limit ?? 30, { since });
        return text(rows.length ? rows.map(fmt).join("\n") : "nessun risultato");
      },
    );
  }

  server.registerTool(
    "messaggi_recenti",
    {
      description:
        "Tutti i messaggi in arrivo nelle ultime N ore, su tutte le chat. Usa per 'cosa è successo nell'ultima ora / oggi'.",
      inputSchema: {
        ore: z.number().optional().describe("finestra in ore (default 1)"),
        limit: z.number().optional().describe("max messaggi (default 200)"),
      },
    },
    async ({ ore, limit }) => {
      const since = Date.now() - (ore ?? 1) * HOURS;
      const rows = recentMessages(db, { since, limit: limit ?? 200 });
      return text(rows.length ? rows.map(fmt).join("\n") : "nessun messaggio nel periodo");
    },
  );

  server.registerTool(
    "chat_recenti",
    {
      description: "Elenco delle chat con attività recente e quanti messaggi, per orientarsi.",
      inputSchema: {
        ore: z.number().optional().describe("finestra in ore (default 24)"),
        limit: z.number().optional(),
      },
    },
    async ({ ore, limit }) => {
      const since = Date.now() - (ore ?? 24) * HOURS;
      const chats = recentChats(db, { since, limit: limit ?? 30 });
      return text(
        chats.length
          ? chats
              .map((c) => {
                const unread = c.unread_count ? `  [${c.unread_count} non letti]` : "";
                return `${c.n}×  ${c.name || c.chat_id}${unread}  (${c.chat_id})`;
              })
              .join("\n")
          : "nessuna chat attiva nel periodo",
      );
    },
  );

  server.registerTool(
    "leggi_thread",
    {
      description:
        "Ultimi messaggi di una chat specifica (per riassumere o cercare contesto). chat_id da chat_recenti/cerca.",
      inputSchema: {
        chat_id: z.string().describe("il chat_id (JID) della conversazione"),
        limit: z.number().optional().describe("quanti messaggi (default 100)"),
      },
    },
    async ({ chat_id, limit }) => {
      const rows = getThread(db, chat_id, { limit: limit ?? 100 }).reverse(); // chronological
      return text(rows.length ? rows.map(fmt).join("\n") : "thread vuoto o chat_id sconosciuto");
    },
  );

  server.registerTool(
    "modifiche_recenti",
    {
      description:
        "Messaggi WhatsApp MODIFICATI o ELIMINATI di recente (da quando il tracking è attivo). Per ogni voce: chi, quando, e il testo PRIMA→DOPO per le modifiche, o il testo eliminato. Usa per 'cosa hanno corretto/cancellato', 'cosa ho cancellato io'.",
      inputSchema: {
        ore: z.number().optional().describe("finestra in ore (default 168 = 7 giorni)"),
        limit: z.number().optional().describe("max voci (default 100)"),
      },
    },
    async ({ ore, limit }) => {
      const since = Date.now() - (ore ?? 168) * HOURS;
      const rows = recentRevisions(db, { since, limit: limit ?? 100 });
      return text(
        rows.length
          ? rows.map(fmtRevision).join("\n")
          : "nessuna modifica o eliminazione nel periodo",
      );
    },
  );

  if (sendWa) {
    server.registerTool(
      "invia_whatsapp",
      {
        description:
          "INVIA un messaggio WhatsApp per conto di Simone. Usala SOLO quando Simone lo chiede e dopo aver mostrato la bozza. (Richiede conferma.) Passa SEMPRE `nome` (nome leggibile del contatto/gruppo) così la conferma è chiara.",
        inputSchema: {
          destinatario: z
            .string()
            .describe("chat_id/JID (es. 39333...@s.whatsapp.net o ...@g.us) o numero con prefisso"),
          nome: z
            .string()
            .describe(
              "nome leggibile del destinatario (contatto o gruppo), mostrato nella conferma",
            ),
          testo: z.string().describe("il testo del messaggio da inviare"),
        },
      },
      async ({ destinatario, nome, testo }) => {
        const display = (nome || "").trim() || chatName(db, destinatario) || destinatario;
        const r = await sendWa(destinatario, testo);
        return text(`Inviato a ${display}${r.id ? ` (id ${r.id})` : ""}.`);
      },
    );
  }

  if (readEmail) {
    server.registerTool(
      "email_leggi",
      {
        description:
          "Scarica al volo il CORPO completo di una email (non è memorizzato). account+uid li trovi nei risultati di ricerca (righe 📧 email).",
        inputSchema: {
          account: z.string().describe("nome account (es. personal/work/cloud)"),
          uid: z.union([z.number(), z.string()]).describe("uid IMAP della mail"),
        },
      },
      async ({ account, uid }) => {
        const body = await readEmail(account, uid);
        return text(body || "(corpo vuoto)");
      },
    );
  }

  if (sendEmail) {
    server.registerTool(
      "email_invia",
      {
        description:
          "INVIA una email per conto di Simone. Usala SOLO quando Simone lo chiede e dopo aver mostrato la bozza. (Richiede conferma.)",
        inputSchema: {
          account: z.string().describe("account mittente (es. personal/work/cloud)"),
          a: z.string().describe("destinatario/i (indirizzo email)"),
          oggetto: z.string(),
          testo: z.string(),
        },
      },
      async ({ account, a, oggetto, testo }) => {
        const r = await sendEmail(account, a, oggetto, testo);
        return text(`Inviata da ${account} a ${r.accepted.join(", ") || a} (id ${r.messageId}).`);
      },
    );
  }

  return server;
}

// Stateful Streamable-HTTP: initialize creates a session (mcp-session-id),
// subsequent requests reuse the same transport. Required by real MCP clients.
export function startMcpHttp(
  db: Database.Database,
  port: number,
  host = "127.0.0.1",
  index?: VectorIndex,
  actions: CommsActions = {},
): void {
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport | undefined = sessionId
      ? transports[sessionId]
      : undefined;

    if (!transport && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport!;
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) delete transports[transport!.sessionId];
      };
      const server = buildMcpServer(db, index, actions);
      await server.connect(transport);
    }

    if (!transport) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "No valid session ID provided" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  });

  // GET (server→client SSE stream) and DELETE (session teardown) reuse the session.
  const bySession = async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? transports[sessionId] : undefined;
    if (!transport) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transport.handleRequest(req, res);
  };
  app.get("/mcp", bySession);
  app.delete("/mcp", bySession);

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.listen(port, host, () => {
    console.log(`MCP server (HTTP) on http://${host}:${port}/mcp`);
  });
}
