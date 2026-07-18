/**
 * Readonly static file helpers for Web UI + workspace preview.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
};

function contentType(filePath: string): string {
  return MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** Resolve path under root; null if escapes. */
export function safeJoin(root: string, reqPath: string): string | null {
  const cleaned = reqPath.replace(/^\/+/, '').replace(/\0/g, '');
  const full = normalize(join(root, cleaned));
  const rootResolved = resolve(root);
  const rel = relative(rootResolved, full);
  if (rel.startsWith('..') || rel.startsWith(sep) || rel === '..') {
    return null;
  }
  return full;
}

/** Browser GUIs (e.g. Next on :3000) call this API cross-origin. */
export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export function applyCors(res: ServerResponse): void {
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    res.setHeader(k, v);
  }
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const data = JSON.stringify(body);
  applyCors(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

export function sendFile(
  res: ServerResponse,
  filePath: string,
  status = 200,
): void {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  const st = statSync(filePath);
  applyCors(res);
  res.writeHead(status, {
    'Content-Type': contentType(filePath),
    'Content-Length': st.size,
    'Cache-Control': 'no-store',
  });
  createReadStream(filePath).pipe(res);
}

export function tryServeStatic(
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
  root: string,
  indexName = 'index.html',
): boolean {
  let rel = decodeURIComponent(urlPath.split('?')[0] || '/');
  if (rel === '/' || rel === '') rel = `/${indexName}`;
  if (rel.endsWith('/')) rel = `${rel}${indexName}`;

  const filePath = safeJoin(root, rel.replace(/^\//, ''));
  if (!filePath) {
    sendJson(res, 403, { error: 'path_escape' });
    return true;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return false;
  }
  sendFile(res, filePath);
  return true;
}
