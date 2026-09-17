const LINK_PATTERN = /\[[^\]]*\]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)/g;

const DOC_ID_PATTERN = /^(source|derived)\/[a-z0-9][a-z0-9._/-]*$/i;

/** 抽出正文里指向其它文档的链接，解析成文档 id。 */
export function extractLinkIds(body: string, fromId: string): string[] {
  const ids = new Set<string>();

  // 代码块与行内代码里的链接是示例，不算引用。
  const prose = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');

  for (const match of prose.matchAll(LINK_PATTERN)) {
    const id = resolveDocId(match[1] ?? '', fromId);

    if (id) {
      ids.add(id);
    }
  }

  return [...ids].sort();
}

/** 把 markdown 链接解析成同项目内的文档 id；外链、锚点、越界路径返回 undefined。 */
export function resolveDocId(href: string, fromId: string): string | undefined {
  const raw = href.split('#')[0]!.split('?')[0]!.trim();

  if (!raw || raw.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    return undefined;
  }

  const base = raw.startsWith('/') ? raw.slice(1) : `${dirname(fromId)}/${raw}`;
  const normalized = normalize(base);

  if (!normalized) {
    return undefined;
  }

  const id = normalized.replace(/\.md$/i, '');
  return DOC_ID_PATTERN.test(id) ? id : undefined;
}

function dirname(id: string): string {
  const index = id.lastIndexOf('/');
  return index === -1 ? '' : id.slice(0, index);
}

function normalize(path: string): string | undefined {
  const segments: string[] = [];

  for (const segment of path.split('/')) {
    if (!segment || segment === '.') {
      continue;
    }

    if (segment === '..') {
      if (segments.length === 0) {
        return undefined;
      }

      segments.pop();
      continue;
    }

    segments.push(segment);
  }

  return segments.join('/');
}

export function isDocId(value: string): boolean {
  return DOC_ID_PATTERN.test(value);
}
