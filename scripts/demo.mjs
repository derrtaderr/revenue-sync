// A no-key demo: the real CLI (src/cli.mjs main) run against the in-process Stripe and HubSpot
// stand-ins the test suite uses, in a temporary folder that is removed afterwards. Nothing is
// sent anywhere and nothing is written to the folder it is run from.
// Usage: node scripts/demo.mjs
// REVENUE_SYNC_DEMO_PACE_MS sets the pause between beats (default PACE_MS; 0 turns pacing off).
import { rmSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { makeWorld } from '../test/helpers/world.mjs';

export const PACE_MS = 700;
export const HOLD_MS = 2400; // the pause after reconcile catches the edit
const ISSUES = 'https://github.com/derrtaderr/revenue-sync/issues';
const CMD = 'node bin/revenue-sync.mjs';

function nodeIsNewEnough(version) {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  return major > 20 || (major === 20 && minor >= 6);
}

const last = (l) => l.slice(-1);
// The disagreements, from "N values disagree" to the blank line after them, then the verdict.
const disagreements = (l) => {
  const a = l.findIndex((x) => /disagrees? across/.test(x));
  const b = l.indexOf('', a + 2);
  return [...l.slice(a, b + 1), l.at(-1)];
};
// The company heading and its writes, from the first block of writes.
const writes = (l) => {
  const a = l.findIndex((x) => /^\S.*\(HubSpot \d+\)$/.test(x));
  const b = l.indexOf('', a);
  return [...l.slice(a, b), l.at(-1).startsWith('Run sync') ? l.at(-2) : l.at(-1)];
};

export async function runDemo({ write, writeErr, sleep, version = process.version, cli, pace = PACE_MS, hold = HOLD_MS }) {
  const out = (s = '') => write(`${s}\n`);
  const fail = (why) => {
    writeErr(`demo failed: ${why}\nThe demo needs Node 20.6 or newer (this is ${version}). If that is not it, please open an issue at ${ISSUES} with this output.\n`);
    return 1;
  };
  if (!nodeIsNewEnough(version)) return fail(`Node ${version} is too old`);
  const main = cli ?? (await import('../src/cli.mjs')).main;
  const w = makeWorld();
  // Prints the command, the lines pick() keeps from its real output (verbatim), and its exit code
  // unless a kept line already states it.
  async function step(argv, expectCode, pick) {
    out(`$ ${CMD} ${argv.join(' ')}`);
    const r = await w.run(main, argv);
    const shown = r.out ? pick(r.out.trimEnd().split('\n')) : [];
    for (const l of shown) out(l);
    if (!shown.some((l) => new RegExp(`\\bExit ${r.code};`).test(l))) out(`exit ${r.code}`);
    if (r.code !== expectCode) throw new Error(`expected exit ${expectCode} from ${argv[0]}, got ${r.code}${r.err ? `\n${r.err.trimEnd()}` : ''}`);
  }
  try {
    out('revenue-sync demo, the real CLI on stand-ins for Stripe and HubSpot.');
    out('No keys, nothing leaves this machine. Key lines of each step shown.');
    out();
    await sleep(pace);
    await step(['seed', '--hubspot'], 0, (l) => l.slice(1, 2));
    await sleep(pace);
    await step(['sync', '--usage', 'usage.csv'], 0, last);
    out();
    await sleep(pace);
    const nw = w.hubspot.companies.find((c) => c.properties.name === 'Northwind Analytics');
    nw.properties.rs_mrr = '1500';
    nw.properties.rs_seat_count = '30';
    out('Someone edits Northwind Analytics by hand in HubSpot.');
    out();
    await sleep(pace);
    await step(['reconcile', '--usage', 'usage.csv'], 3, disagreements);
    await sleep(hold);
    out();
    await step(['plan', '--usage', 'usage.csv'], 0, writes);
    await sleep(pace);
    await step(['sync', '--usage', 'usage.csv'], 0, last);
    await sleep(pace);
    await step(['reconcile', '--usage', 'usage.csv'], 0, last);
    return 0;
  } catch (e) {
    return fail(e.message);
  } finally {
    rmSync(w.cwd, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const raw = process.env.REVENUE_SYNC_DEMO_PACE_MS;
  const pace = raw === undefined || raw === '' ? PACE_MS : Number(raw);
  process.exitCode = await runDemo({
    write: (s) => process.stdout.write(s),
    writeErr: (s) => process.stderr.write(s),
    sleep: (ms) => (ms > 0 ? delay(ms) : Promise.resolve()),
    pace,
    hold: pace === 0 ? 0 : HOLD_MS,
  });
}
