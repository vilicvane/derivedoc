import fs from 'node:fs/promises';
import path from 'node:path';

const DIR = '.derivedoc/conversations';

export interface ConversationMessage {
  type: 'message';
  at: string;
  sessionId: string;
  turnId?: string;
  channel: string;
  text: string;
}

export interface ConversationCapture {
  type: 'capture';
  at: string;
  sessionId: string;
  turnId?: string;
  /** 这一轮被改动的文档 id */
  changed: string[];
  /** 思考过程的相对路径（没有产物时为空） */
  thinking?: string;
  elapsedMs: number;
  code: number;
}

export type ConversationEntry = ConversationMessage | ConversationCapture;

export interface ConversationRecord extends ConversationMessage {
  captures: ConversationCapture[];
}

function sessionFile(root: string, sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'unknown';
  return path.join(root, DIR, `${safe}.jsonl`);
}

/** 只追加：先记用户原话，捕获完再记一条结果，任何时候都不改写已有行。 */
export async function appendConversation(
  root: string,
  sessionId: string,
  entry: ConversationEntry,
): Promise<void> {
  const file = sessionFile(root, sessionId);
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
}

/** 读回对话记录：按会话分组，把捕获结果挂到对应的用户消息上。 */
export async function readConversations(root: string): Promise<ConversationRecord[]> {
  const dir = path.join(root, DIR);
  let files: string[];

  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }

  const records: ConversationRecord[] = [];

  for (const file of files.filter(name => name.endsWith('.jsonl'))) {
    let raw: string;

    try {
      raw = await fs.readFile(path.join(dir, file), 'utf8');
    } catch {
      continue;
    }

    const captures = new Map<string, ConversationCapture[]>();

    for (const line of raw.split('\n')) {
      if (!line.trim()) {
        continue;
      }

      let entry: ConversationEntry;

      try {
        entry = JSON.parse(line) as ConversationEntry;
      } catch {
        continue;
      }

      if (entry.type === 'capture') {
        const key = entry.turnId ?? entry.at;
        captures.set(key, [...(captures.get(key) ?? []), entry]);
      }
    }

    for (const line of raw.split('\n')) {
      if (!line.trim()) {
        continue;
      }

      let entry: ConversationEntry;

      try {
        entry = JSON.parse(line) as ConversationEntry;
      } catch {
        continue;
      }

      if (entry.type === 'message') {
        records.push({
          ...entry,
          captures: captures.get(entry.turnId ?? entry.at) ?? [],
        });
      }
    }
  }

  return records.sort((a, b) => b.at.localeCompare(a.at));
}
