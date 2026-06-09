// In-memory vector index over the archive embeddings. Brute-force cosine KNN
// (vectors are L2-normalized → cosine = dot). Fine for tens/hundreds of k rows;
// swap for sqlite-vec later if the archive grows large.
import type Database from "better-sqlite3";
import { allEmbeddings, messagesByRowids, type MessageRow } from "./db.js";
import { blobToVec, dot, embedQuery } from "./embeddings.js";

export class VectorIndex {
  private ids: number[] = [];
  private vecs: Float32Array[] = [];

  constructor(private db: Database.Database) {}

  load(): void {
    const rows = allEmbeddings(this.db);
    this.ids = rows.map((r) => r.rowid);
    this.vecs = rows.map((r) => blobToVec(r.vec));
  }

  add(rowid: number, vec: Float32Array): void {
    this.ids.push(rowid);
    this.vecs.push(vec);
  }

  size(): number {
    return this.ids.length;
  }

  async search(query: string, k: number, opts: { since?: number } = {}): Promise<MessageRow[]> {
    if (this.vecs.length === 0) return [];
    const q = await embedQuery(query);
    const scored: Array<{ id: number; s: number }> = new Array(this.vecs.length);
    for (let i = 0; i < this.vecs.length; i++) scored[i] = { id: this.ids[i], s: dot(q, this.vecs[i]) };
    scored.sort((a, b) => b.s - a.s);

    // Take a generous top slice, then optionally filter by date and trim to k.
    const slice = scored.slice(0, Math.max(k * 4, k));
    const ids = slice.map((x) => x.id);
    const rank = new Map(ids.map((id, i) => [id, i]));
    let msgs = messagesByRowids(this.db, ids) as Array<MessageRow & { rowid: number }>;
    if (opts.since) msgs = msgs.filter((m) => m.ts >= opts.since!);
    msgs.sort((a, b) => (rank.get(a.rowid)! - rank.get(b.rowid)!));
    return msgs.slice(0, k);
  }
}
