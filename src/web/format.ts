import type {GitChange} from './types.ts';

/** git 状态码翻成界面上的字：新增 / 修改 / 删除 / 改名。 */
export function statusLabel(change: GitChange): string {
  const code = change.index !== ' ' && change.index !== '?' ? change.index : change.worktree;

  switch (code) {
    case '?':
    case 'A':
      return '新增';
    case 'M':
      return '修改';
    case 'D':
      return '删除';
    case 'R':
      return '改名';
    default:
      return code;
  }
}

/** 时间戳给界面看的形式：`9月17日 22:41`。 */
export function formatTime(iso: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 提交信息草稿：改动文件自己拟一句。 */
export function draftMessage(changes: GitChange[]): string {
  if (changes.length === 0) {
    return '';
  }

  const [first] = changes;
  return changes.length === 1
    ? `更新 ${first!.path}`
    : `更新 ${first!.path} 等 ${changes.length} 个文档`;
}

/** 路径太长时留尾部的完整层级——工作区靠目录名区分，截头比截尾有用。 */
export function shortenPath(path: string, max = 26): string {
  if (path.length <= max) {
    return path;
  }

  const parts = path.split('/').filter(Boolean);
  let tail = '';

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index] ?? '';
    const next = tail ? `${part}/${tail}` : part;

    if (tail && next.length + 1 > max) {
      break;
    }

    tail = next;
  }

  return `…/${tail}`;
}
