// One-off: embed all message bodies that don't yet have a vector.
// Run with `npm run backfill`. Safe to re-run / resume (skips already-embedded).
import { openDb, countUnembedded, getUnembedded, storeEmbeddings } from "./db.js";
import { embedPassages, vecToBlob, initEmbedder } from "./embeddings.js";

const BATCH = Number(process.env.EMBED_BATCH ?? 64);

const db = openDb();
console.log("loading embedding model…");
await initEmbedder();

let remaining = countUnembedded(db);
const total = remaining;
console.log(`${total} message(s) to embed`);

let done = 0;
while (remaining > 0) {
  const batch = getUnembedded(db, BATCH);
  if (batch.length === 0) break;
  const vecs = await embedPassages(batch.map((b) => b.body));
  storeEmbeddings(
    db,
    batch.map((b, i) => ({ rowid: b.rowid, vec: vecToBlob(vecs[i]) })),
  );
  done += batch.length;
  remaining = countUnembedded(db);
  if (done % (BATCH * 10) === 0 || remaining === 0) {
    console.log(`embedded ${done}/${total} (${Math.round((done / total) * 100)}%)`);
  }
}

db.close();
console.log("backfill complete.");
