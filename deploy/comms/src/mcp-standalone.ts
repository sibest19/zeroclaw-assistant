// MCP-only entry: opens the archive READ-ONLY and serves MCP over HTTP, with the
// semantic index loaded from existing embeddings. Use to test MCP↔ZeroClaw
// without running the full comms. (No embed loop — read-only.)
import Database from "better-sqlite3";
import { ARCHIVE_DB } from "./config.js";
import { startMcpHttp } from "./mcp-server.js";
import { VectorIndex } from "./vector-index.js";
import { initEmbedder } from "./embeddings.js";

const MCP_PORT = Number(process.env.MCP_PORT ?? 8765);
const MCP_HOST = process.env.MCP_HOST ?? "127.0.0.1";

const db = new Database(ARCHIVE_DB, { readonly: true });
db.pragma("journal_mode = WAL");
console.log(`MCP-only (readonly) over ${ARCHIVE_DB}`);

const index = new VectorIndex(db);
index.load();
console.log(`vector index loaded: ${index.size()} embeddings`);
await initEmbedder();

startMcpHttp(db, MCP_PORT, MCP_HOST, index);
process.stdin.resume();
