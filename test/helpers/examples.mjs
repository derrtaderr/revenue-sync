// The README's sample output, produced by a real run of the CLI against the fakes. The README
// test compares the README with this, so the example cannot drift from what the tool prints.
import { main } from '../../src/cli.mjs';
import { makeWorld } from './world.mjs';

export async function reconcileExample() {
  const w = makeWorld();
  await w.run(main, ['seed', '--hubspot']);
  await w.run(main, ['sync', '--usage', 'usage.csv']);
  const nw = w.hubspot.companies.find((c) => c.properties.name === 'Northwind Analytics');
  nw.properties.rs_mrr = '1500';
  nw.properties.rs_seat_count = '30';
  const r = await w.run(main, ['reconcile', '--usage', 'usage.csv']);
  return { code: r.code, out: r.out.replace(/cus_\w+/g, 'cus_...').split(w.cwd).join('/path/to/revenue-sync') };
}
