import {parse as parseYaml, stringify as stringifyYaml} from 'yaml';

import {DocStoreError} from './errors.ts';

export interface ParsedDoc {
  frontmatter: Record<string, unknown>;
  body: string;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n)?(?:\r?\n)?/;

export function parseDoc(text: string): ParsedDoc {
  const match = FRONTMATTER_PATTERN.exec(text);

  if (!match) {
    return {frontmatter: {}, body: text};
  }

  let frontmatter: unknown;

  try {
    frontmatter = parseYaml(match[1] ?? '') ?? {};
  } catch (error) {
    throw new DocStoreError('invalid_content', `frontmatter 不是合法 YAML：${String(error)}`);
  }

  if (typeof frontmatter !== 'object' || frontmatter === null || Array.isArray(frontmatter)) {
    throw new DocStoreError('invalid_content', 'frontmatter 必须是键值对');
  }

  return {
    frontmatter: frontmatter as Record<string, unknown>,
    body: text.slice(match[0].length),
  };
}

export function serializeDoc(frontmatter: Record<string, unknown>, body: string): string {
  const keys = Object.keys(frontmatter);

  if (keys.length === 0) {
    return body;
  }

  const yaml = stringifyYaml(frontmatter).trimEnd();
  return `---\n${yaml}\n---\n\n${body.replace(/^\n+/, '')}`;
}

/** 取文档标题：优先 frontmatter.title，其次首个一级标题，最后回落到 id。 */
export function resolveTitle(
  frontmatter: Record<string, unknown>,
  body: string,
  fallback: string,
): string {
  const title = frontmatter['title'];

  if (typeof title === 'string' && title.trim()) {
    return title.trim();
  }

  const heading = /^#[ \t]+(.+)$/m.exec(body);
  return heading?.[1]?.trim() || fallback;
}
