// Ingester entrypoint (always-on service): WhatsApp ingestion + MCP server +
// background embedding loop (keeps the semantic index up to date).
import { openDb, getUnembedded, storeEmbeddings } from "./db.js";
import { startWhatsApp, sendWhatsApp } from "./whatsapp.js";
import { startMcpHttp } from "./mcp-server.js";
import { VectorIndex } from "./vector-index.js";
import { initEmbedder, embedPassages, vecToBlob } from "./embeddings.js";
import { ARCHIVE_DB } from "./config.js";

const MCP_PORT = Number(process.env.MCP_PORT ?? 8765);
const MCP_HOST = process.env.MCP_HOST ?? "127.0.0.1";
const EMBED_BATCH = Number(process.env.EMBED_BATCH ?? 64);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const db = openDb();
console.log(`archive: ${ARCHIVE_DB}`);

const index = new VectorIndex(db);
index.load();
console.log(`vector index loaded: ${index.size()} embeddings`);

console.log("loading embedding model…");
await initEmbedder();

await startWhatsApp(db);
// Outbound WhatsApp tool, exposed over MCP (gated by confirmation in ZeroClaw).
startMcpHttp(db, MCP_PORT, MCP_HOST, index, (to, txt) => sendWhatsApp(db, to, txt));

// Background: embed any message lacking a vector (initial backfill + new arrivals),
// add to the live index. Idle-sleeps when caught up.
(async function embedLoop() {
  for (;;) {
    try {
      const batch = getUnembedded(db, EMBED_BATCH);
      if (batch.length === 0) {
        await sleep(15000);
        continue;
      }
      const vecs = await embedPassages(batch.map((b) => b.body));
      storeEmbeddings(
        db,
        batch.map((b, i) => ({ rowid: b.rowid, vec: vecToBlob(vecs[i]) })),
      );
      for (let i = 0; i < batch.length; i++) index.add(batch[i].rowid, vecs[i]);
      if (index.size() % (EMBED_BATCH * 10) === 0) console.log(`embedded so far: ${index.size()}`);
    } catch (e) {
      console.error("embed loop error:", e);
      await sleep(5000);
    }
  }
})();

console.log("comms running (ingest + MCP + embeddings) — Ctrl+C to stop");
process.stdin.resume();
