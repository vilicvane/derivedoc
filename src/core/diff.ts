export interface DiffLine {
  type: 'same' | 'add' | 'remove';
  text: string;
}

export interface DiffSummary {
  added: number;
  removed: number;
}

const MAX_CELLS = 4_000_000;

/** 行级差异；文档规模不大时用 LCS，过大就退化成整体替换。 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');

  if (a.length * b.length > MAX_CELLS) {
    return [
      ...a.map(text => ({type: 'remove' as const, text})),
      ...b.map(text => ({type: 'add' as const, text})),
    ];
  }

  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        a[i] === b[j]
          ? table[(i + 1) * cols + j + 1]! + 1
          : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({type: 'same', text: a[i]!});
      i++;
      j++;
    } else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) {
      lines.push({type: 'remove', text: a[i]!});
      i++;
    } else {
      lines.push({type: 'add', text: b[j]!});
      j++;
    }
  }

  while (i < a.length) {
    lines.push({type: 'remove', text: a[i++]!});
  }

  while (j < b.length) {
    lines.push({type: 'add', text: b[j++]!});
  }

  return lines;
}

export function summarizeDiff(lines: readonly DiffLine[]): DiffSummary {
  let added = 0;
  let removed = 0;

  for (const line of lines) {
    if (line.type === 'add') {
      added++;
    } else if (line.type === 'remove') {
      removed++;
    }
  }

  return {added, removed};
}

export function formatSummary(summary: DiffSummary): string {
  if (summary.added === 0 && summary.removed === 0) {
    return '无变化';
  }

  return `+${summary.added} −${summary.removed}`;
}

const GIT_HEADER = /^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename )/;

/** 把 `git diff` 输出解析成可渲染的行。 */
export function parseGitDiff(text: string): DiffLine[] {
  const lines: DiffLine[] = [];

  for (const raw of text.split('\n')) {
    if (raw === '') {
      continue;
    }

    if (GIT_HEADER.test(raw)) {
      continue;
    }

    if (raw.startsWith('@@')) {
      lines.push({type: 'same', text: raw});
      continue;
    }

    if (raw.startsWith('+')) {
      lines.push({type: 'add', text: raw.slice(1)});
      continue;
    }

    if (raw.startsWith('-')) {
      lines.push({type: 'remove', text: raw.slice(1)});
      continue;
    }

    lines.push({type: 'same', text: raw.startsWith(' ') ? raw.slice(1) : raw});
  }

  return lines;
}
