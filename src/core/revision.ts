import {createHash} from 'node:crypto';

/** 内容修订号：正文与 frontmatter 全文的哈希，用于乐观并发与变更判定。 */
export function computeRevision(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

export function nowIso(): string {
  return new Date().toISOString();
}
