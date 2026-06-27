/** Local embedding for Zvec index (384-dim, all-MiniLM-L6-v2). */

export const EMBEDDING_DIM = 384;

export type EmbedMode = 'model' | 'hash' | 'off';

let embedMode: EmbedMode = 'off';
let pipeline: ((text: string, opts: object) => Promise<{ data: Float32Array }>) | null = null;
let loadPromise: Promise<EmbedMode> | null = null;

function hashEmbed(text: string, dim = EMBEDDING_DIM): number[] {
  const vec = new Array<number>(dim).fill(0);
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);

  for (const token of tokens) {
    let h = 2166136261;
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = h % dim;
    const sign = (h & 1) === 0 ? 1 : -1;
    vec[idx] += sign;
  }

  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return vec.map((v) => v / norm);
}

/** Lazy-load MiniLM; falls back to hash vectors when model download fails. */
export async function ensureEmbeddings(): Promise<EmbedMode> {
  if (embedMode !== 'off') return embedMode;
  if (process.env.ENABLE_EMBEDDINGS === '0') {
    embedMode = 'hash';
    return embedMode;
  }
  if (loadPromise) return loadPromise;

  loadPromise = (async (): Promise<EmbedMode> => {
    try {
      const { pipeline: createPipeline } = await import('@xenova/transformers');
      pipeline = (await createPipeline(
        'feature-extraction',
        'Xenova/all-MiniLM-L6-v2',
      )) as typeof pipeline;
      embedMode = 'model';
    } catch {
      embedMode = 'hash';
    }
    return embedMode;
  })();

  return loadPromise;
}

export function getEmbedMode(): EmbedMode {
  return embedMode;
}

export async function embedText(text: string): Promise<number[]> {
  const mode = await ensureEmbeddings();
  if (mode === 'hash') return hashEmbed(text);

  try {
    const out = await pipeline!(text.slice(0, 8000), { pooling: 'mean', normalize: true });
    const data = out.data;
    const vec = Array.from(data as ArrayLike<number>);
    if (vec.length !== EMBEDDING_DIM) {
      return hashEmbed(text);
    }
    return vec;
  } catch {
    return hashEmbed(text);
  }
}