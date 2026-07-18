/**
 * Local Web UI token auth (SPEC_WEB_UI).
 * Any listen port without a secret is an RCE surface for other local pages.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export function generateWebUiToken(): string {
  return randomBytes(24).toString('base64url');
}

export function resolveWebUiToken(explicit?: string): string {
  const fromEnv = process.env.MINIMAL_WEB_TOKEN?.trim();
  if (explicit?.trim()) return explicit.trim();
  if (fromEnv) return fromEnv;
  return generateWebUiToken();
}

function tokensEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Extract bearer or query token from HTTP request. */
export function extractRequestToken(
  req: IncomingMessage,
  url: URL,
): string | undefined {
  const auth = req.headers.authorization?.trim();
  if (auth?.toLowerCase().startsWith('bearer ')) {
    const t = auth.slice(7).trim();
    if (t) return t;
  }
  const q = url.searchParams.get('token')?.trim();
  return q || undefined;
}

export function checkToken(
  provided: string | undefined,
  expected: string,
): boolean {
  if (!provided || !expected) return false;
  return tokensEqual(provided, expected);
}
