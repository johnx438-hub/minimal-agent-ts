import { hashResult } from '../action-store.js';

export function hashFileContent(content: string): string {
  return hashResult(content);
}

const FILE_META_RE = /\n\[file_meta hash=([a-f0-9]+) lines=(\d+)\]\s*$/;

/** Strip trailing read_file metadata block if present. */
export function stripFileMeta(text: string): string {
  return text.replace(FILE_META_RE, '');
}

export function formatFileMeta(content: string): string {
  const lines = content.split('\n').length;
  return `\n[file_meta hash=${hashFileContent(content)} lines=${lines}]`;
}