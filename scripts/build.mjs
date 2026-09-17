import {rm} from 'node:fs/promises';
import path from 'node:path';

import {build} from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const outdir = path.join(root, 'bld/cli');
const outfile = path.join(outdir, 'main.js');

// 每次构建前清掉旧产物，避免残留的 chunk 混进来。
await rm(outdir, {recursive: true, force: true});

await build({
  entryPoints: [path.join(root, 'src/cli/main.ts')],
  outdir,
  entryNames: 'main',
  bundle: true,
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  platform: 'node',
  target: 'node24',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
});

console.log(`built ${path.relative(root, outfile)}`);
