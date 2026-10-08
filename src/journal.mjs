// The sync journal, <dir>/journal.jsonl: one `plan` line with every batch, a `done` line per
// batch HubSpot accepted, and `complete` at the end. A journal without `complete` is a run that
// crashed; the next sync resumes it. Like webhook-engine's reserve/complete, nothing is marked
// done until HubSpot has said so, so a crash can only ever leave a batch "maybe sent", which the
// resume re-reads from HubSpot before sending.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILE_MODE, ensureDir } from './store.mjs';

export function openJournal(dir) {
  const file = join(dir, 'journal.jsonl');
  const append = (entry) => appendFileSync(file, `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`, { mode: FILE_MODE });

  function entries() {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* a torn final write from a crash */ }
    }
    return out;
  }

  return {
    file,
    start(run, batches) {
      ensureDir(dir);
      writeFileSync(file, `${JSON.stringify({ type: 'plan', run, batches, at: new Date().toISOString() })}\n`, { mode: FILE_MODE });
    },
    done: (run, n) => append({ type: 'done', run, batch: n }),
    complete: (run) => append({ type: 'complete', run }),
    unfinished() {
      const all = entries();
      const plan = all.findLast((e) => e.type === 'plan');
      if (!plan) return null;
      const mine = all.filter((e) => e.run === plan.run);
      if (mine.some((e) => e.type === 'complete')) return null;
      return { run: plan.run, batches: plan.batches, done: new Set(mine.filter((e) => e.type === 'done').map((e) => e.batch)) };
    },
  };
}
