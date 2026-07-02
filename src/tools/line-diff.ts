/** Line-granularity unified diff for TUI display (not a full Myers implementation). */

export type DiffOp = { type: 'ctx' | 'del' | 'add'; line: string };

const CONTEXT = 2;

/** LCS table for line arrays. */
function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp;
}

/** Backtrack LCS into delete/add/context ops (delete before add on mismatch). */
export function diffLineOps(oldText: string, newText: string): DiffOp[] {
  if (oldText === '') {
    return newText.replace(/\r\n/g, '\n').split('\n').map((line) => ({ type: 'add', line }));
  }
  if (newText === '') {
    return oldText.replace(/\r\n/g, '\n').split('\n').map((line) => ({ type: 'del', line }));
  }

  const a = oldText.replace(/\r\n/g, '\n').split('\n');
  const b = newText.replace(/\r\n/g, '\n').split('\n');
  const dp = lcsTable(a, b);
  const ops: DiffOp[] = [];
  let i = a.length;
  let j = b.length;
  const stack: DiffOp[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      stack.push({ type: 'ctx', line: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({ type: 'add', line: b[j - 1] });
      j--;
    } else if (i > 0) {
      stack.push({ type: 'del', line: a[i - 1] });
      i--;
    }
  }

  while (stack.length > 0) ops.push(stack.pop()!);
  return ops;
}

function groupHunks(ops: DiffOp[]): DiffOp[][] {
  const hunks: DiffOp[][] = [];
  let current: DiffOp[] = [];
  let inChange = false;

  const flush = (): void => {
    if (current.length > 0) {
      hunks.push(current);
      current = [];
    }
    inChange = false;
  };

  for (let idx = 0; idx < ops.length; idx++) {
    const op = ops[idx];
    if (op.type === 'ctx') {
      if (inChange) {
        let tail = 0;
        while (idx + tail < ops.length && ops[idx + tail].type === 'ctx') tail++;
        const ctxTail = Math.min(CONTEXT, tail);
        for (let t = 0; t < ctxTail; t++) current.push(ops[idx + t]);
        idx += ctxTail - 1;
        flush();
      }
      continue;
    }
    inChange = true;
    if (current.length === 0) {
      let head = 0;
      while (head < CONTEXT && idx - head - 1 >= 0 && ops[idx - head - 1].type === 'ctx') {
        current.unshift(ops[idx - head - 1]);
        head++;
      }
    }
    current.push(op);
  }
  flush();
  return hunks;
}

export interface UnifiedDiffOptions {
  path: string;
  oldText: string;
  newText: string;
  maxLines?: number;
  /** Prefix for synthetic labels (e.g. /dev/null for new files). */
  oldLabel?: string;
  newLabel?: string;
}

export function buildUnifiedLineDiff(opts: UnifiedDiffOptions): string {
  const {
    path,
    oldText,
    newText,
    maxLines = 48,
    oldLabel = `a/${path}`,
    newLabel = `b/${path}`,
  } = opts;

  const ops = diffLineOps(oldText, newText);
  const hunks = groupHunks(ops);
  const out: string[] = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  let used = 2;

  if (hunks.length === 0) {
    out.push(' (unchanged)');
    return out.join('\n');
  }

  for (const hunk of hunks) {
    if (used >= maxLines) {
      out.push(`… (remaining hunks omitted)`);
      break;
    }
    out.push(`@@ ${path} @@`);
    used++;
    for (const op of hunk) {
      if (used >= maxLines) {
        out.push('… (hunk truncated)');
        break;
      }
      const prefix = op.type === 'del' ? '-' : op.type === 'add' ? '+' : ' ';
      out.push(`${prefix} ${op.line}`);
      used++;
    }
  }

  return out.join('\n');
}