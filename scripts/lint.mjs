// Zero-dependency lint gate: syntax-check every .mjs, no em dashes in README prose, no runtime
// dependencies, no maker-internal paths and no secret-shaped strings in any file.
// Usage: node scripts/lint.mjs [root]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url));
const problems = [];

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    if (f === '.git' || f === 'node_modules' || f === '.DS_Store' || f === '.revenue-sync') return [];
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(root);

for (const file of files.filter((f) => f.endsWith('.mjs'))) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) problems.push(`syntax error in ${relative(root, file)}\n${r.stderr.trim()}`);
}

readFileSync(join(root, 'README.md'), 'utf8').split('\n').forEach((line, i) => {
  if (line.includes('—')) problems.push(`README.md:${i + 1} has an em dash`);
});

const EXHAUST = [/\/Users\//, /\/home\/[a-z]/];
const SECRET = [/\b[sr]k_live_[A-Za-z0-9]{8,}/, /\bpat-[a-z]{2}\d-[0-9a-f]{8}-[0-9a-f]{4}/];
for (const file of files) {
  const rel = relative(root, file);
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (EXHAUST.some((re) => re.test(line))) problems.push(`${rel}:${i + 1} has a maker-internal path`);
    if (SECRET.some((re) => re.test(line))) problems.push(`${rel}:${i + 1} has a secret-shaped string; build test tokens at runtime`);
  });
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (Object.keys(pkg.dependencies ?? {}).length) problems.push('package.json has runtime dependencies; this project ships with none');

if (problems.length) {
  process.stderr.write(`${problems.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('lint ok\n');
