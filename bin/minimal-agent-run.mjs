#!/usr/bin/env node
/**
 * BETA CLI — headless one-shot task.
 * Usage: minimal-agent-run "your task" [--allow-shell] …
 */
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'main.js');
await import(pathToFileURL(entry).href);
