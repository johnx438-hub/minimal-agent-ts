import { existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

import { tryParseJobReportPath } from '../spawn/job-paths.js';
import { clampJobReportContent, patchJobMeta } from '../spawn/job-store.js';
import type { AgentConfig, ToolDefinition } from '../types.js';
import {
  formatVisionAttachToolResult,
  isImagePath,
  resolveVisionPolicy,
  visionCapabilityHint,
  visionRefFromPath,
} from '../vision.js';
import { formatFileMeta } from './file-hash.js';
import { resolveReadablePath, resolveWritablePath, sliceLines } from './path-utils.js';
import { decodeWriteFileContent } from './tool-args.js';
import { formatWriteToolResult } from './write-display.js';

export const READ_WRITE_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a text file (offset/limit for large files). ' +
        'For image paths (.png/.jpg/.gif/.webp): on a vision-capable profile, attaches the image for the next model turn (browser screenshots, UI checks). ' +
        'Without vision, returns a short hint to switch profile or use TUI @path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative to cwd or absolute)' },
          offset: { type: 'integer', description: '1-based start line (optional, text only)' },
          limit: { type: 'integer', description: 'Max lines to read (optional, text only)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Write or overwrite a text file. For HTML, CSS, JSON, or other text with many quotes/backslashes, prefer content_b64 (UTF-8 base64) instead of content — especially above ~4KB.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          content: {
            type: 'string',
            description: 'Full file content (UTF-8). Fine for small/plain text.',
          },
          content_b64: {
            type: 'string',
            description:
              'Base64-encoded UTF-8 file content. Prefer for HTML, large payloads, or strings with unescaped quotes.',
          },
        },
        required: ['path'],
      },
    },
  },
];

const MAX_READ_CHARS = 8000;

function handleReadImage(
  requestedPath: string,
  absFile: string,
  config: AgentConfig,
): string {
  const policy = resolveVisionPolicy(config.llmPluginConfig?.vision);
  const supportsVision = config.llm?.supportsVision === true;

  if (!policy.enabled || !supportsVision) {
    return visionCapabilityHint({
      profileName: config.llm?.profileName,
      supportsVision,
      visionEnabled: policy.enabled,
    });
  }

  if (!existsSync(absFile)) {
    return `error: image not found: ${requestedPath}`;
  }
  let st;
  try {
    st = statSync(absFile);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `error: cannot stat image: ${msg}`;
  }
  if (!st.isFile()) {
    return `error: not a file: ${requestedPath}`;
  }
  if (st.size > policy.max_bytes_per_image) {
    return (
      `error: image too large (${st.size} > ${policy.max_bytes_per_image} bytes). ` +
      'Compress/resize or raise vision.max_bytes_per_image.'
    );
  }

  // Prefer path relative to cwd for session-friendly vision_refs.
  let refPath = requestedPath;
  try {
    const rel = relative(config.cwd, absFile);
    if (rel && !rel.startsWith('..')) {
      refPath = rel;
    } else {
      refPath = absFile;
    }
  } catch {
    refPath = absFile;
  }

  const ref = visionRefFromPath(refPath);
  const note =
    `ok: image registered for next model turn (${ref.mime ?? 'image'}, ${st.size} bytes). ` +
    `Path: ${refPath}. Describe or act on the attached image pixels.`;
  return formatVisionAttachToolResult(ref, note);
}

export async function runReadWriteTool(
  name: string,
  args: Record<string, unknown>,
  config: AgentConfig,
): Promise<string | null> {
  switch (name) {
    case 'read_file': {
      const path = String(args.path ?? '');
      let file: string;
      try {
        file = await resolveReadablePath(config, path, `read_file: ${path}`);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return '[aborted]';
        }
        const msg = err instanceof Error ? err.message : String(err);
        return `error: ${msg}`;
      }

      // Image paths: attach for multimodal next turn (or hint if vision off).
      if (isImagePath(file) || isImagePath(path)) {
        return handleReadImage(path, file, config);
      }

      const raw = await readFile(file, 'utf8');
      const offset = args.offset === undefined ? undefined : Number(args.offset);
      const limit = args.limit === undefined ? undefined : Number(args.limit);
      const body = sliceLines(raw, offset, limit);
      const meta = formatFileMeta(raw);
      const truncated =
        body.length > MAX_READ_CHARS
          ? `${body.slice(0, MAX_READ_CHARS)}\n...(truncated)`
          : body;
      return truncated + meta;
    }

    case 'write_file': {
      const path = String(args.path ?? '');
      const decoded = decodeWriteFileContent(args);
      if (!decoded.ok) return decoded.error;
      const content = decoded.content;
      let file: string;
      try {
        file = resolveWritablePath(config.cwd, path);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `error: ${msg}`;
      }

      let previous: string | null = null;
      try {
        previous = await readFile(file, 'utf8');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          const msg = err instanceof Error ? err.message : String(err);
          return `error: cannot read ${path}: ${msg}`;
        }
      }

      await mkdir(dirname(file), { recursive: true });

      // Job report.md soft cap (64 MiB) — same path agents use for code_review / spawn reports.
      let toWrite = content;
      let reportNote = '';
      const jobId = tryParseJobReportPath(config.cwd, file);
      if (jobId) {
        const clamped = clampJobReportContent(content);
        toWrite = clamped.content;
        patchJobMeta(jobId, {
          report_truncated: clamped.truncated,
          report_bytes: clamped.written_bytes,
        });
        if (clamped.truncated) {
          reportNote =
            ` [report_truncated original=${clamped.original_bytes} written=${clamped.written_bytes}]`;
        }
      }

      await writeFile(file, toWrite, 'utf8');
      const byteSize = Buffer.byteLength(toWrite, 'utf8');
      const result = formatWriteToolResult(path, byteSize, previous, toWrite);
      return reportNote ? `${result}${reportNote}` : result;
    }

    default:
      return null;
  }
}