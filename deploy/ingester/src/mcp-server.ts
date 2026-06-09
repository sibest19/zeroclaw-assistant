// MCP server (Streamable HTTP) exposing the message archive to ZeroClaw.
// Read-only retrieval tools; ZeroClaw's agent (gpt-5.5) does the summarizing.
import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type Database from "better-sqlite3";
import { searchMessages, recentChats, recentMessages, getThread, type MessageRow } from "./db.js";
import type { VectorIndex } from "./vector-index.js";

const HOURS = 3_600_000;

// FTS5 MATCH-safe query: keep word chars, quote each token (implicit AND).
function ftsQuery(raw: string): string {
  const toks = raw.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (toks.length === 0) return '""';
  return toks.map((t) => `"${t}"`).join(" ");
}

function fmt(m: MessageRow): string {
  const when = new Date(m.ts).toISOString().slice(0, 16).replace("T", " ");
  const via = m.origin === "assistant" ? " (inviato via assistente)" : "";
  const who = m.direction === "out" ? `io${via}` : m.sender_name || m.sender || "?";
  const chat = m.chat_name || m.chat_id;
  const body = (m.body ?? "").replace(/\s+/g, " ").slice(0, 500);
  return `[${when}] (${chat}) ${who}: ${body}`;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export function buildMcpServer(db: Database.Database, index?: VectorIndex): McpServer {
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

  return server;
}

// Stateful Streamable-HTTP: initialize creates a session (mcp-session-id),
// subsequent requests reuse the same transport. Required by real MCP clients.
export function startMcpHttp(
  db: Database.Database,
  port: number,
  host = "127.0.0.1",
  index?: VectorIndex,
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
      const server = buildMcpServer(db, index);
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
