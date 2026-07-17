/**
 * SPEC_VISION: multimodal user images — refs on disk, materialize for API.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';

import type {
  ChatMessage,
  ContentPart,
  MessageContent,
  VisionRef,
} from './types.js';
import { isPathUnderRoot } from './workspace.js';

export interface VisionPolicyConfig {
  enabled?: boolean;
  max_images_per_message?: number;
  max_bytes_per_image?: number;
  default_detail?: 'auto' | 'low' | 'high';
  allow_remote_url?: boolean;
  /** degrade = text fallback for failed images; throw = fail the request */
  materialize_fail?: 'degrade' | 'throw';
}

export const DEFAULT_VISION_POLICY = {
  enabled: true,
  max_images_per_message: 4,
  max_bytes_per_image: 5_242_880,
  default_detail: 'auto' as const,
  allow_remote_url: false,
  materialize_fail: 'degrade' as const,
};

/** Rough token placeholders for budget (SPEC_VISION §5). */
export const VISION_TOKEN_ESTIMATE_LOW = 85;
export const VISION_TOKEN_ESTIMATE_HIGH = 1100;

const MIME_BY_EXT: Record<string, VisionRef['mime']> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export function resolveVisionPolicy(
  raw?: VisionPolicyConfig | null,
): Required<VisionPolicyConfig> {
  return {
    ...DEFAULT_VISION_POLICY,
    ...raw,
    max_images_per_message:
      raw?.max_images_per_message ?? DEFAULT_VISION_POLICY.max_images_per_message,
    max_bytes_per_image:
      raw?.max_bytes_per_image ?? DEFAULT_VISION_POLICY.max_bytes_per_image,
    default_detail: raw?.default_detail ?? DEFAULT_VISION_POLICY.default_detail,
    allow_remote_url:
      raw?.allow_remote_url ?? DEFAULT_VISION_POLICY.allow_remote_url,
    materialize_fail:
      raw?.materialize_fail ?? DEFAULT_VISION_POLICY.materialize_fail,
    enabled: raw?.enabled !== false,
  };
}

/** Flatten content to plain text (for logs, intent, estimates of text layer). */
export function getMessageText(content: MessageContent): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

/** Safe string view of content (non-string → joined text parts only). */
export function contentAsString(content: MessageContent | undefined): string {
  return getMessageText(content ?? null);
}

export function countImageParts(content: MessageContent): number {
  if (!Array.isArray(content)) return 0;
  return content.filter((p) => p.type === 'image_url').length;
}

export function estimateVisionTokens(msg: ChatMessage): number {
  let n = 0;
  if (Array.isArray(msg.content)) {
    for (const p of msg.content) {
      if (p.type === 'image_url') {
        const d = p.image_url.detail ?? 'auto';
        n += d === 'low' ? VISION_TOKEN_ESTIMATE_LOW : VISION_TOKEN_ESTIMATE_HIGH;
      }
    }
  }
  if (msg.vision_refs?.length) {
    for (const ref of msg.vision_refs) {
      const d = ref.detail ?? 'auto';
      n += d === 'low' ? VISION_TOKEN_ESTIMATE_LOW : VISION_TOKEN_ESTIMATE_HIGH;
    }
  }
  return n;
}

export function guessMimeFromPath(path: string): VisionRef['mime'] | undefined {
  return MIME_BY_EXT[extname(path).toLowerCase()];
}

export function visionRefFromPath(
  path: string,
  opts?: { detail?: VisionRef['detail']; mime?: VisionRef['mime'] },
): VisionRef {
  return {
    path,
    mime: opts?.mime ?? guessMimeFromPath(path),
    detail: opts?.detail ?? 'auto',
  };
}

/** True when path extension looks like a supported image type. */
export function isImagePath(path: string): boolean {
  return guessMimeFromPath(path) !== undefined;
}

/**
 * Tool → next-turn vision bridge.
 * Tool results stay text for pointerize/transcript; agent loop parses this
 * marker and injects a user message with vision_refs for materialize.
 */
export const VISION_ATTACH_MARKER = '[vision_attach]';

export function formatVisionAttachToolResult(
  ref: VisionRef,
  note: string,
): string {
  const payload = JSON.stringify({
    path: ref.path,
    mime: ref.mime,
    detail: ref.detail ?? 'auto',
  });
  return `${VISION_ATTACH_MARKER}${payload}\n${note}`;
}

/** Parse first vision_attach marker in a tool result (or null). */
export function parseVisionAttachFromToolOutput(
  output: string,
): VisionRef | null {
  const idx = output.indexOf(VISION_ATTACH_MARKER);
  if (idx < 0) return null;
  const rest = output.slice(idx + VISION_ATTACH_MARKER.length);
  const line = rest.split('\n', 1)[0]?.trim() ?? '';
  if (!line) return null;
  try {
    const obj = JSON.parse(line) as {
      path?: string;
      mime?: VisionRef['mime'];
      detail?: VisionRef['detail'];
    };
    if (!obj.path?.trim()) return null;
    return visionRefFromPath(obj.path.trim(), {
      mime: obj.mime,
      detail: obj.detail,
    });
  } catch {
    return null;
  }
}

export function collectVisionAttachesFromToolOutputs(
  outputs: string[],
): VisionRef[] {
  const refs: VisionRef[] = [];
  const seen = new Set<string>();
  for (const out of outputs) {
    const ref = parseVisionAttachFromToolOutput(out);
    if (!ref?.path) continue;
    if (seen.has(ref.path)) continue;
    seen.add(ref.path);
    refs.push(ref);
  }
  return refs;
}

/** User message injected after tools so the next LLM turn can see pixels. */
export function buildVisionAttachUserMessage(refs: VisionRef[]): ChatMessage {
  const lines = refs.map((r) => `- ${r.path ?? r.remote_url ?? '?'}`);
  return {
    role: 'user',
    content:
      'Attached image(s) for vision (from tools — inspect the image pixels in this message):\n' +
      lines.join('\n'),
    vision_refs: refs,
  };
}

export function visionCapabilityHint(opts: {
  profileName?: string;
  supportsVision?: boolean;
  visionEnabled?: boolean;
}): string {
  if (opts.visionEnabled === false) {
    return (
      'error: vision is disabled (agent.json vision.enabled=false). ' +
      'Enable vision or attach images manually in TUI with @path.png'
    );
  }
  if (!opts.supportsVision) {
    const p = opts.profileName ?? 'current profile';
    return (
      `error: profile "${p}" has no vision (supports_vision≠true). ` +
      'Switch to a vision profile (e.g. /profile kimi-main) then read_file the image path again, ' +
      'or attach manually with @path.png / /image path'
    );
  }
  return 'error: vision not available';
}

export function visionRefFromUrl(
  url: string,
  opts?: { detail?: VisionRef['detail'] },
): VisionRef {
  return {
    remote_url: url,
    detail: opts?.detail ?? 'auto',
  };
}

export interface MaterializeVisionOptions {
  cwd: string;
  policy?: VisionPolicyConfig | null;
  /** Extra readable roots (grants). */
  readableRoots?: string[];
}

function canReadPath(
  abs: string,
  cwd: string,
  roots: string[] | undefined,
): boolean {
  if (isPathUnderRoot(cwd, abs)) return true;
  for (const r of roots ?? []) {
    if (isPathUnderRoot(r, abs)) return true;
  }
  return false;
}

/**
 * Expand vision_refs into OpenAI-style content parts for the API.
 * Does not mutate the original message's vision_refs for disk.
 */
export function materializeVisionMessage(
  msg: ChatMessage,
  opts: MaterializeVisionOptions,
): ChatMessage {
  const policy = resolveVisionPolicy(opts.policy);
  const refs = msg.vision_refs ?? [];

  if (!policy.enabled || refs.length === 0) {
    if (msg.vision_refs) {
      const { vision_refs: _v, ...rest } = msg;
      return rest;
    }
    return msg;
  }

  const caption = getMessageText(msg.content) || '(image)';
  const parts: ContentPart[] = [{ type: 'text', text: caption }];
  const limited = refs.slice(0, policy.max_images_per_message);
  if (refs.length > policy.max_images_per_message) {
    parts.push({
      type: 'text',
      text: `[vision: truncated ${refs.length - policy.max_images_per_message} image(s) over max_images_per_message=${policy.max_images_per_message}]`,
    });
  }

  for (const ref of limited) {
    try {
      const part = materializeOneRef(ref, opts, policy);
      parts.push(part);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (policy.materialize_fail === 'throw') throw err;
      parts.push({
        type: 'text',
        text: `[image load failed: ${ref.path ?? ref.remote_url ?? '?'} (${reason})]`,
      });
    }
  }

  const { vision_refs: _drop, ...rest } = msg;
  return { ...rest, content: parts };
}

function materializeOneRef(
  ref: VisionRef,
  opts: MaterializeVisionOptions,
  policy: Required<VisionPolicyConfig>,
): ContentPart {
  const detail = ref.detail ?? policy.default_detail;

  if (ref.remote_url) {
    if (!policy.allow_remote_url) {
      throw new Error('remote image URLs are disabled (vision.allow_remote_url)');
    }
    const u = ref.remote_url.trim();
    if (!/^https:\/\//i.test(u)) {
      throw new Error('only https remote image URLs are allowed');
    }
    return {
      type: 'image_url',
      image_url: { url: u, detail },
    };
  }

  const rel = ref.path?.trim();
  if (!rel) {
    throw new Error('vision ref requires path or remote_url');
  }

  const abs = isAbsolute(rel) ? resolve(rel) : resolve(opts.cwd, rel);
  if (!canReadPath(abs, opts.cwd, opts.readableRoots)) {
    throw new Error(`path outside workspace: ${rel}`);
  }
  if (!existsSync(abs)) {
    throw new Error(`file not found: ${rel}`);
  }
  const st = statSync(abs);
  if (!st.isFile()) {
    throw new Error(`not a file: ${rel}`);
  }
  if (st.size > policy.max_bytes_per_image) {
    throw new Error(
      `image too large (${st.size} > ${policy.max_bytes_per_image} bytes)`,
    );
  }

  const mime = ref.mime ?? guessMimeFromPath(abs);
  if (!mime) {
    throw new Error(`unsupported image type: ${rel}`);
  }

  const dataUrl = readLocalImageAsDataUrl(abs, mime, policy.max_bytes_per_image);
  return {
    type: 'image_url',
    image_url: {
      url: dataUrl,
      detail,
    },
  };
}

/** path+mtime+size → data URL; avoids re-encoding the same screenshot every LLM turn. */
const localImageDataUrlCache = new Map<string, string>();
const LOCAL_IMAGE_CACHE_MAX = 32;

function readLocalImageAsDataUrl(
  abs: string,
  mime: NonNullable<VisionRef['mime']>,
  maxBytes: number,
): string {
  const st = statSync(abs);
  if (st.size > maxBytes) {
    throw new Error(`image too large (${st.size} > ${maxBytes} bytes)`);
  }
  const cacheKey = `${abs}\0${st.mtimeMs}\0${st.size}\0${mime}`;
  const hit = localImageDataUrlCache.get(cacheKey);
  if (hit) return hit;

  const buf = readFileSync(abs);
  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;

  if (localImageDataUrlCache.size >= LOCAL_IMAGE_CACHE_MAX) {
    const first = localImageDataUrlCache.keys().next().value;
    if (first !== undefined) localImageDataUrlCache.delete(first);
  }
  localImageDataUrlCache.set(cacheKey, dataUrl);
  return dataUrl;
}

/** Test hook: drop materialize cache between cases. */
export function clearLocalImageDataUrlCache(): void {
  localImageDataUrlCache.clear();
}

/** Build a user task message with optional vision refs (caption keeps path hints). */
export function buildUserTaskMessageWithVision(
  cwd: string,
  prompt: string,
  refs?: VisionRef[],
): ChatMessage {
  const base = `Working directory: ${cwd}\n\nTask:\n${prompt}`;
  if (!refs?.length) {
    return { role: 'user', content: base };
  }
  const hints = refs
    .map((r) => r.path ?? r.remote_url ?? '?')
    .map((p) => `[image: ${p}]`)
    .join(' ');
  return {
    role: 'user',
    content: `${base}\n\n${hints}`,
    vision_refs: refs,
  };
}
