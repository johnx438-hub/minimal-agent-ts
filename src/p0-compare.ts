import { resolve } from 'node:path';

import {
  compareP0Runs,
  findP0Run,
  loadP0Runs,
  p0TelemetryDir,
} from './p0-telemetry.js';

function formatNum(value: number | null): string {
  if (value === null) return '-';
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatDeltaPct(value: number | null): string {
  if (value === null) return '-';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

function formatDeltaAbs(value: number | null): string {
  if (value === null) return '-';
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatNum(value)}`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value.padEnd(width);
}

function main(): void {
  const cwd = process.cwd();
  const runs = loadP0Runs(cwd);
  if (runs.length === 0) {
    console.error(`No P0 runs at ${resolve(p0TelemetryDir(cwd), 'runs.jsonl')}`);
    console.error('Run with P0_TELEMETRY=1 to collect metrics.');
    process.exit(1);
  }

  const baselineId = process.argv[2];
  const candidateId = process.argv[3];

  let baseline = baselineId ? findP0Run(runs, baselineId) : runs.at(-2);
  let candidate = candidateId ? findP0Run(runs, candidateId) : runs.at(-1);

  if (baselineId && !baseline) {
    console.error(`Baseline run not found: ${baselineId}`);
    process.exit(1);
  }
  if (candidateId && !candidate) {
    console.error(`Candidate run not found: ${candidateId}`);
    process.exit(1);
  }
  if (!candidate) {
    console.error('Need at least one run to compare.');
    process.exit(1);
  }
  if (!baseline) {
    console.error('Need at least two runs to compare (or pass baseline + candidate run_id).');
    process.exit(1);
  }
  if (baseline.run_id === candidate.run_id) {
    console.error('Baseline and candidate must be different runs.');
    process.exit(1);
  }

  const result = compareP0Runs(baseline, candidate);
  const labelWidth = Math.max(
    'metric'.length,
    ...result.metrics.map((m) => m.label.length),
  );

  console.log(`P0 compare: ${result.baseline_id} -> ${result.candidate_id}`);
  console.log(
    `${pad('metric', labelWidth)}  baseline  candidate  delta%    delta`,
  );

  for (const metric of result.metrics) {
    const row = [
      pad(metric.label, labelWidth),
      pad(formatNum(metric.baseline), 8),
      pad(formatNum(metric.candidate), 9),
      pad(formatDeltaPct(metric.delta_pct), 8),
      formatDeltaAbs(metric.delta_abs),
    ];
    console.log(row.join('  '));
  }
}

main();