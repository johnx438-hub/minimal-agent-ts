/**
 * Upload composer attachments into agent-visible workspace/gui-inbox via REST.
 * CompleteAttachment content carries cwd-relative paths (file parts).
 */

import type {
  AttachmentAdapter,
  CompleteAttachment,
  PendingAttachment,
} from "@assistant-ui/react";

import { getMinimalToken, minimalFetch } from "./client";

const MAX_BYTES = 25 * 1024 * 1024;

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("read_failed"));
        return;
      }
      const i = result.indexOf("base64,");
      resolve(i >= 0 ? result.slice(i + 7) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("read_failed"));
    reader.readAsDataURL(file);
  });
}

function guessType(file: File): PendingAttachment["type"] {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("text/") || /\.(md|txt|json|csv|ts|tsx|js|py)$/i.test(file.name)) {
    return "document";
  }
  return "file";
}

export type PathInboxAdapterOptions = {
  getSessionId?: () => string | null;
  getToken?: () => string;
};

/**
 * Any file → upload on send → content file part with data = relative path.
 */
export function createPathInboxAttachmentAdapter(
  opts?: PathInboxAdapterOptions,
): AttachmentAdapter {
  return {
    // assistant-ui only treats accept === "*" as accept-all.
    // "*/*" is parsed as MIME "*/…" and rejects image/png etc.
    accept: "*",

    async add({ file }) {
      if (file.size > MAX_BYTES) {
        throw new Error(`附件超过 ${Math.floor(MAX_BYTES / (1024 * 1024))}MB 限制`);
      }
      if (file.size === 0) {
        throw new Error("空文件");
      }
      return {
        id: crypto.randomUUID(),
        type: guessType(file),
        name: file.name,
        contentType: file.type || "application/octet-stream",
        file,
        status: { type: "requires-action", reason: "composer-send" },
      } satisfies PendingAttachment;
    },

    async send(attachment): Promise<CompleteAttachment> {
      const file = attachment.file;
      if (!file) {
        throw new Error("missing file");
      }
      const data_base64 = await fileToBase64(file);
      const session_id = opts?.getSessionId?.() ?? null;
      const token = opts?.getToken?.() ?? getMinimalToken();

      const res = await minimalFetch<{
        paths?: string[];
        files?: Array<{ path: string }>;
      }>("/v1/uploads", {
        method: "POST",
        token,
        body: JSON.stringify({
          filename: attachment.name || file.name,
          data_base64,
          session_id: session_id || undefined,
        }),
      });

      const path =
        res.paths?.[0] ||
        res.files?.[0]?.path ||
        "";
      if (!path) {
        throw new Error("upload returned no path");
      }

      return {
        id: attachment.id,
        type: attachment.type,
        name: attachment.name,
        contentType: attachment.contentType,
        content: [
          {
            type: "file",
            filename: attachment.name,
            mimeType: file.type || "application/octet-stream",
            // Agent-visible cwd-relative path (not base64)
            data: path,
          },
        ],
        status: { type: "complete" },
      };
    },

    async remove() {
      // Files stay in gui-inbox for the agent; no remote delete on chip remove
    },
  };
}

/** Collect uploaded paths from AppendMessage content + attachments. */
export function pathsFromAppendMessage(message: {
  content?: readonly { type: string; data?: string; text?: string }[];
  attachments?: readonly {
    content?: readonly { type: string; data?: string }[];
  }[];
}): string[] {
  const out: string[] = [];
  const take = (data: string | undefined) => {
    const p = data?.trim();
    if (!p) return;
    // Prefer path-looking values (workspace/…); skip data URLs
    if (p.startsWith("data:")) return;
    if (!out.includes(p)) out.push(p);
  };

  for (const part of message.content ?? []) {
    if (part.type === "file" && "data" in part) take(part.data);
  }
  for (const att of message.attachments ?? []) {
    for (const part of att.content ?? []) {
      if (part.type === "file" && "data" in part) take(part.data);
    }
  }
  return out;
}

export function formatTaskWithAttachments(
  text: string,
  paths: string[],
): string {
  const body = text.trim();
  if (!paths.length) return body;
  const block = [
    "[attachments · files saved under workspace/gui-inbox]",
    ...paths.map((p) => `- ${p}`),
  ].join("\n");
  return body ? `${body}\n\n${block}` : block;
}

const ATTACH_BLOCK_RE =
  /\n*\n?\[attachments[^\]]*\]\s*\n((?:[ \t]*-[ \t]*\S[^\n]*\n?)*)\s*$/i;

/** Split user-visible text from agent-only attachment path block. */
export function splitAttachmentBlock(raw: string): {
  displayText: string;
  paths: string[];
} {
  const text = (raw ?? "").replace(/\r\n/g, "\n");
  const m = text.match(ATTACH_BLOCK_RE);
  if (!m) return { displayText: text.trim(), paths: [] };
  const paths = (m[1] ?? "")
    .split("\n")
    .map((l) => l.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean);
  const displayText = text.slice(0, m.index).trim();
  return { displayText, paths };
}

export function attachmentsFromPaths(
  paths: string[],
): Array<{
  id: string;
  name: string;
  path: string;
  type: "image" | "document" | "file";
}> {
  return paths.map((path, i) => {
    const name = path.split("/").pop() || path;
    const lower = name.toLowerCase();
    const type: "image" | "document" | "file" = /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(
      lower,
    )
      ? "image"
      : /\.(md|txt|json|csv|pdf|docx?)$/i.test(lower)
        ? "document"
        : "file";
    return {
      id: `att_${i}_${name}`,
      name,
      path,
      type,
    };
  });
}

/** Build CompleteAttachment-like rows for convertMessage / Thread chips. */
export function toThreadAttachments(
  items: Array<{
    id: string;
    name: string;
    path: string;
    contentType?: string;
    type?: "image" | "document" | "file";
  }>,
) {
  return items.map((a) => ({
    id: a.id,
    type: a.type ?? "file",
    name: a.name,
    contentType: a.contentType,
    status: { type: "complete" as const },
    content: [
      {
        type: "file" as const,
        filename: a.name,
        mimeType: a.contentType || "application/octet-stream",
        data: a.path,
      },
    ],
  }));
}
