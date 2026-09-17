import fs from 'node:fs/promises';
import path from 'node:path';

const FILE = '.derivedoc/selection.json';

/**
 * 界面上选中的一段文字，交给 agent 当上下文用。存在项目根下、不进版本库；
 * 只保留最近一次选择——它是「现在指哪儿」，不是历史。
 */
export interface DocSelection {
  /** 文档 id */
  doc: string;
  /** 起始行号，1 起 */
  from: number;
  /** 结束行号，含这一行 */
  to: number;
  /** 选中的原文 */
  quote: string;
  /** 记录时的文档修订号，用来判断选区是不是已经过期 */
  revision?: string;
  at: string;
  /** 从哪儿选的，目前只有 web */
  channel: string;
}

/** 读当前选区；没有、读不出来或内容空掉都返回 undefined。 */
export async function readSelection(root: string): Promise<DocSelection | undefined> {
  try {
    const raw = await fs.readFile(path.join(root, FILE), 'utf8');
    const parsed = JSON.parse(raw) as Partial<DocSelection>;

    if (typeof parsed.doc !== 'string' || typeof parsed.quote !== 'string' || !parsed.quote.trim()) {
      return undefined;
    }

    return {
      doc: parsed.doc,
      from: typeof parsed.from === 'number' ? parsed.from : 1,
      to: typeof parsed.to === 'number' ? parsed.to : 1,
      quote: parsed.quote,
      ...(typeof parsed.revision === 'string' ? {revision: parsed.revision} : {}),
      at: typeof parsed.at === 'string' ? parsed.at : new Date().toISOString(),
      channel: typeof parsed.channel === 'string' ? parsed.channel : 'web',
    };
  } catch {
    return undefined;
  }
}

export async function writeSelection(root: string, selection: DocSelection): Promise<void> {
  const file = path.join(root, FILE);

  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(selection, null, 2)}\n`, 'utf8');
}

export async function clearSelection(root: string): Promise<void> {
  await fs.rm(path.join(root, FILE), {force: true});
}
