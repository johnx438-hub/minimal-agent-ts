import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { p0TelemetryDir } from './p0-telemetry.js';

function main(): void {
  const cwd = process.cwd();
  const summaryPath = resolve(p0TelemetryDir(cwd), 'summary.tsv');
  if (!existsSync(summaryPath)) {
    console.error(`No P0 summary at ${summaryPath}`);
    console.error('Run with P0_TELEMETRY=1 to collect metrics.');
    process.exit(1);
  }

  const lines = readFileSync(summaryPath, 'utf8').trim().split('\n');
  const tail = Math.max(1, Number(process.argv[2] ?? 10));
  const body = lines.slice(0, 1).concat(lines.slice(-tail));
  console.log(body.join('\n'));
}

main();