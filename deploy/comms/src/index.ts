// comms entrypoint (always-on service): WhatsApp + email ingestion + MCP server +
// background embedding loop (keeps the semantic index up to date).
import {
  openDb,
  getUnembedded,
  storeEmbeddings,
  backfillChatNames,
  purgeEmailAccountsNotIn,
} from "./db.js";
import { startWhatsApp, sendWhatsApp } from "./whatsapp.js";
import { startEmail, fetchEmailBody, sendEmail, searchEmail } from "./email.js";
import { startMcpHttp } from "./mcp-server.js";
import { VectorIndex } from "./vector-index.js";
import { initEmbedder, embedPassages, vecToBlob } from "./embeddings.js";
import { ARCHIVE_DB, EMAIL_ACCOUNTS } from "./config.js";

const MCP_PORT = Number(process.env.MCP_PORT ?? 8765);
const MCP_HOST = process.env.MCP_HOST ?? "127.0.0.1";
const EMBED_BATCH = Number(process.env.EMBED_BATCH ?? 64);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const db = openDb();
console.log(`archive: ${ARCHIVE_DB}`);

// Backfill 1:1 chat names from existing incoming messages (group names come from
// groupFetchAllParticipating on WhatsApp connect).
console.log(`backfilled ${backfillChatNames(db)} 1:1 chat name(s)`);

// Drop email archived under an account name that's no longer configured (renamed
// or removed): wipes its rows + embeddings + refs so the new name starts fresh.
// Runs BEFORE the vector index loads, so orphan vectors never enter memory.
if (EMAIL_ACCOUNTS.length) {
  const purged = purgeEmailAccountsNotIn(
    db,
    EMAIL_ACCOUNTS.map((a) => a.name),
  );
  if (purged) console.log(`purged ${purged} email row(s) from renamed/removed account(s)`);
}

const index = new VectorIndex(db);
index.load();
console.log(`vector index loaded: ${index.size()} embeddings`);

console.log("loading embedding model…");
await initEmbedder();

await startWhatsApp(db);
await startEmail(db); // background IMAP header poll per account (no-op if unconfigured)

// Outbound actions exposed over MCP. Sends are gated by confirmation in ZeroClaw;
// email_leggi (on-demand body fetch) is read-only.
startMcpHttp(db, MCP_PORT, MCP_HOST, index, {
  sendWa: (to, txt) => sendWhatsApp(db, to, txt),
  readEmail: (account, uid, mailbox) => fetchEmailBody(account, uid, mailbox),
  sendEmail: (account, to, subject, txt) => sendEmail(account, to, subject, txt),
  searchEmail: (account, query, limit) => searchEmail(account, query, limit),
});

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
