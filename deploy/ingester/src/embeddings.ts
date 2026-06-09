// Local multilingual embeddings via transformers.js (ONNX, CPU). No API key,
// no data leaves the machine. Model: multilingual-e5-small (384-dim).
// e5 models expect "query: " / "passage: " prefixes.
import { pipeline, env } from "@huggingface/transformers";

// Persist the downloaded model in a stable cache dir (a Docker volume in prod) so
// it isn't re-downloaded on every container restart.
if (process.env.MODEL_CACHE_DIR) env.cacheDir = process.env.MODEL_CACHE_DIR;

const MODEL = process.env.EMBED_MODEL ?? "Xenova/multilingual-e5-small";
export const EMBED_DIM = 384;

// `any` avoids transformers.js's huge pipeline-overload union (TS2590).
let extractorP: Promise<any> | null = null;

function extractor(): Promise<any> {
  if (!extractorP) {
    extractorP = pipeline("feature-extraction", MODEL);
  }
  return extractorP;
}

// Warm up (downloads weights on first run). Call once at startup.
export async function initEmbedder(): Promise<void> {
  await extractor();
}

async function embed(texts: string[], prefix: "query" | "passage"): Promise<Float32Array[]> {
  const ex = await extractor();
  const inputs = texts.map((t) => `${prefix}: ${t.slice(0, 2000)}`);
  const out = await ex(inputs, { pooling: "mean", normalize: true });
  const data = out.tolist() as number[][];
  return data.map((v) => Float32Array.from(v));
}

export const embedQuery = (text: string) => embed([text], "query").then((a) => a[0]);
export const embedPassages = (texts: string[]) => embed(texts, "passage");

// Cosine similarity for L2-normalized vectors = dot product.
export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// (de)serialize a Float32Array to/from a SQLite BLOB.
export function vecToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
export function blobToVec(b: Buffer): Float32Array {
  // Copy out of the (possibly pooled) Buffer to own a standalone array.
  return Float32Array.from(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4));
}
