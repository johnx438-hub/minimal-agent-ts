import { existsSync, mkdirSync } from 'node:fs';

import {
  ZVecCollectionSchema,
  ZVecCreateAndOpen,
  ZVecDataType,
  ZVecIndexType,
  ZVecMetricType,
  ZVecOpen,
  type ZVecCollection,
} from '@zvec/zvec';

import { listActions } from './action-store.js';
import { embedText, ensureEmbeddings } from './embedding.js';
import type { ActionBlock } from './types.js';
import { agentMemoryDir, ensureSessionsDir } from './workspace.js';
const COLLECTION_NAME = 'agent_memory';

let collection: ZVecCollection | null = null;
let initFailed = false;
let boundMemoryDir: string | null = null;

/** Close cached zvec collection (e.g. after workspace root changes). */
export function resetZvecCollection(): void {
  collection = null;
  initFailed = false;
  boundMemoryDir = null;
}

export function isZvecEnabled(): boolean {
  return process.env.ENABLE_ZVEC !== '0';
}

export function buildIndexContent(block: ActionBlock): string {
  return [
    `tool:${block.tool_name}`,
    `args:${block.args_json}`,
    `result:${block.result_text.slice(0, 4000)}`,
    `files:${block.files_touched.join(',')}`,
  ].join('\n');
}

function escapeFilterString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function createSchema(): ZVecCollectionSchema {
  return new ZVecCollectionSchema({
    name: COLLECTION_NAME,
    vectors: {
      name: 'embedding',
      dataType: ZVecDataType.VECTOR_FP32,
      dimension: 384,
      indexParams: {
        indexType: ZVecIndexType.FLAT,
        metricType: ZVecMetricType.COSINE,
      },
    },
    fields: [
      {
        name: 'session_id',
        dataType: ZVecDataType.STRING,
        indexParams: { indexType: ZVecIndexType.INVERT },
      },
      {
        name: 'task_id',
        dataType: ZVecDataType.STRING,
        indexParams: { indexType: ZVecIndexType.INVERT },
      },
      {
        name: 'tool_name',
        dataType: ZVecDataType.STRING,
        indexParams: { indexType: ZVecIndexType.INVERT },
      },
      {
        name: 'action_id',
        dataType: ZVecDataType.STRING,
        indexParams: { indexType: ZVecIndexType.INVERT },
      },
      { name: 'turn_number', dataType: ZVecDataType.INT32 },
      { name: 'timestamp', dataType: ZVecDataType.INT64 },
      {
        name: 'content',
        dataType: ZVecDataType.STRING,
        indexParams: { indexType: ZVecIndexType.FTS },
      },
    ],
  });
}

function getCollection(): ZVecCollection | null {
  if (!isZvecEnabled() || initFailed) return null;

  const indexDir = agentMemoryDir();
  if (collection && boundMemoryDir === indexDir) return collection;

  if (collection && boundMemoryDir !== indexDir) {
    resetZvecCollection();
  }

  try {
    ensureSessionsDir();
    if (!existsSync(indexDir)) {
      mkdirSync(indexDir, { recursive: true });
    }

    collection = existsSync(indexDir)
      ? ZVecOpen(indexDir)
      : ZVecCreateAndOpen(indexDir, createSchema());
    boundMemoryDir = indexDir;
    return collection;
  } catch {
    initFailed = true;
    collection = null;
    boundMemoryDir = null;
    return null;
  }
}

export async function upsertActionIndex(block: ActionBlock): Promise<void> {
  const col = getCollection();
  if (!col) return;

  const content = buildIndexContent(block);
  const embedding = await embedText(content);

  col.upsertSync({
    id: block.action_id,
    vectors: { embedding },
    fields: {
      session_id: block.session_id,
      task_id: block.task_id,
      tool_name: block.tool_name,
      action_id: block.action_id,
      turn_number: block.turn_number,
      timestamp: block.timestamp,
      content,
    },
  });
}

export function indexActionAsync(block: ActionBlock): void {
  if (!isZvecEnabled()) return;
  void import('./action-index-queue.js').then((m) => m.enqueueActionIndex(block));
}

function buildFilter(sessionId?: string, taskId?: string): string | undefined {
  const parts: string[] = [];
  if (sessionId) parts.push(`session_id = '${escapeFilterString(sessionId)}'`);
  if (taskId) parts.push(`task_id = '${escapeFilterString(taskId)}'`);
  return parts.length > 0 ? parts.join(' AND ') : undefined;
}

/** Hybrid vector + FTS search; returns action_ids best-first. */
export async function searchActions(opts: {
  query: string;
  sessionId?: string;
  taskId?: string;
  topk?: number;
}): Promise<string[]> {
  const col = getCollection();
  if (!col) return [];

  await ensureEmbeddings();

  const query = opts.query.trim();
  if (!query) return [];

  const topk = opts.topk ?? 5;
  const filter = buildFilter(opts.sessionId, opts.taskId);

  try {
    const queryEmbedding = await embedText(query);

    const results = col.multiQuerySync({
      queries: [
        {
          fieldName: 'embedding',
          vector: queryEmbedding,
          numCandidates: Math.max(topk * 4, 20),
        },
        {
          fieldName: 'content',
          fts: { matchString: query },
          numCandidates: Math.max(topk * 4, 20),
        },
      ],
      topk,
      filter,
      outputFields: ['action_id', 'session_id', 'tool_name'],
      rerank: { type: 'weighted', weights: [0.45, 0.55] },
    });

    return results.map((doc) => String(doc.fields.action_id ?? doc.id));
  } catch {
    try {
      const ftsOnly = col.querySync({
        fieldName: 'content',
        fts: { matchString: query },
        topk,
        filter,
        outputFields: ['action_id'],
        params: { indexType: ZVecIndexType.FTS },
      });
      return ftsOnly.map((doc) => String(doc.fields.action_id ?? doc.id));
    } catch {
      return [];
    }
  }
}

/** Backfill index from cold-storage JSON files (best-effort). */
export async function syncIndexFromStore(sessionId?: string): Promise<number> {
  if (!isZvecEnabled()) return 0;

  const blocks = listActions(sessionId);
  let count = 0;
  for (const block of blocks) {
    try {
      await upsertActionIndex(block);
      count++;
    } catch {
      /* skip broken entries */
    }
  }
  return count;
}

export function scheduleIndexSync(sessionId?: string): void {
  void syncIndexFromStore(sessionId);
}