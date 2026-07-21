#!/usr/bin/env node
/**
 * BETA CLI — interactive TUI (default entry).
 * Usage: minimal-agent [--cwd dir] [--allow-web] …
 */
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'tui', 'main.js');
await import(pathToFileURL(entry).href);
