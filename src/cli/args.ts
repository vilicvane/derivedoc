const BOOLEAN_FLAGS = new Set(['open', 'json', 'help', 'version', 'dev']);
const VALUE_FLAGS = new Set(['port', 'host', 'kind', 'base-revision', 'content', 'doc-dir']);

const SHORT_FLAGS = new Map<string, string>([
  ['-p', 'port'],
  ['-h', 'help'],
  ['-v', 'version'],
]);

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

export interface ParsedArgs {
  positionals: string[];
  options: Map<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options = new Map<string, string | boolean>();

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;

    if (arg === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (arg.startsWith('--')) {
      const [name, inlineValue] = splitFlag(arg.slice(2));

      if (BOOLEAN_FLAGS.has(name)) {
        options.set(name, inlineValue === undefined ? true : parseBoolean(inlineValue, name));
        continue;
      }

      if (!VALUE_FLAGS.has(name)) {
        throw new CliError(`未知参数：--${name}`);
      }

      if (inlineValue !== undefined) {
        options.set(name, inlineValue);
        continue;
      }

      options.set(name, takeValue(argv, ++index, `--${name}`));
      continue;
    }

    if (arg.startsWith('-') && arg.length === 2) {
      const alias = SHORT_FLAGS.get(arg);

      if (!alias) {
        throw new CliError(`未知参数：${arg}`);
      }

      if (BOOLEAN_FLAGS.has(alias)) {
        options.set(alias, true);
        continue;
      }

      options.set(alias, takeValue(argv, ++index, arg));
      continue;
    }

    positionals.push(arg);
  }

  return {positionals, options};
}

function takeValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];

  if (value === undefined) {
    throw new CliError(`${flag} 缺少取值`);
  }

  return value;
}

function splitFlag(raw: string): [string, string | undefined] {
  const index = raw.indexOf('=');
  return index === -1 ? [raw, undefined] : [raw.slice(0, index), raw.slice(index + 1)];
}

function parseBoolean(value: string, name: string): boolean {
  if (value === 'true' || value === '1') {
    return true;
  }

  if (value === 'false' || value === '0') {
    return false;
  }

  throw new CliError(`--${name} 只接受 true/false`);
}
