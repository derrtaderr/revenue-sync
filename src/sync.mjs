// sync: create any missing properties, then write the plan to HubSpot in journaled batches.
// A crashed run is resumed before anything new is planned: batches the journal marks done are
// skipped without a request, and every other batch is re-read from HubSpot first so only values
// that still differ are sent. Writes are absolute values, so even a re-sent batch is harmless.

import { DEFINITIONS, PROPERTY_GROUP, scopedDefinitions, unlinkedValue } from './definitions.mjs';
import { planWrites, sameValue, toHubSpot } from './plan.mjs';
import { BATCH_LIMIT } from './hubspot.mjs';
import { ApiError } from './http.mjs';
import { openJournal } from './journal.mjs';
import { readSnapshot, writeJson, SNAPSHOT_SCHEMA, SNAPSHOT_VERSION } from './store.mjs';
import { join } from 'node:path';

export const COMPANY_PROPERTIES = ['name', 'domain', 'hs_additional_domains', ...DEFINITIONS.map((d) => d.property)];
const DEF_BY_PROPERTY = new Map(DEFINITIONS.map((d) => [d.property, d]));

export const currentFrom = (companies) => new Map(companies.map((c) => [String(c.id), c.properties ?? {}]));
export const readCurrent = async (hubspot) => currentFrom(await hubspot.listCompanies(COMPANY_PROPERTIES));

export async function ensureProperties(hubspot, { create }) {
  const missingGroup = !(await hubspot.getGroup(PROPERTY_GROUP.name));
  const missing = [];
  for (const d of DEFINITIONS) if (!(await hubspot.getProperty(d.property))) missing.push(d.property);
  if (create && (missingGroup || missing.length)) {
    if (missingGroup) await hubspot.createGroup({ name: PROPERTY_GROUP.name, label: PROPERTY_GROUP.label });
    for (const name of missing) {
      const d = DEF_BY_PROPERTY.get(name);
      await hubspot.createProperty({ name: d.property, label: d.label, description: d.description, type: d.type, fieldType: d.fieldType, groupName: PROPERTY_GROUP.name });
    }
  }
  return { missing, missingGroup };
}

function toBatches(writes) {
  const byCompany = new Map();
  for (const w of writes) {
    if (!byCompany.has(w.company_id)) byCompany.set(w.company_id, {});
    byCompany.get(w.company_id)[w.property] = w.new;
  }
  const inputs = [...byCompany].map(([id, properties]) => ({ id, properties }));
  const batches = [];
  for (let i = 0; i < inputs.length; i += BATCH_LIMIT) batches.push({ n: batches.length + 1, inputs: inputs.slice(i, i + BATCH_LIMIT) });
  return batches;
}

const count = (inputs) => inputs.reduce((n, i) => n + Object.keys(i.properties).length, 0);

const GONE = 'OBJECT_NOT_FOUND (deleted or merged in HubSpot)';
const refusedWhole = (err) => err instanceof ApiError && [400, 404, 409].includes(err.status);

// Re-reads the batch's companies, drops any HubSpot no longer has (reported, not retried), and
// keeps only the values HubSpot still lacks.
async function verifyInputs(hubspot, inputs, rejected, landed) {
  const live = currentFrom(await hubspot.batchRead(inputs.map((i) => i.id), [...new Set(inputs.flatMap((i) => Object.keys(i.properties)))]));
  const out = [];
  for (const i of inputs) {
    if (!live.has(i.id)) { rejected.push({ id: i.id, reason: GONE }); continue; }
    const properties = Object.fromEntries(Object.entries(i.properties).filter(([p, v]) => !sameValue(DEF_BY_PROPERTY.get(p), live.get(i.id)[p], v)));
    if (Object.keys(properties).length) out.push({ id: i.id, properties });
    else landed.add(i.id);
  }
  return out;
}

async function sendBatches(hubspot, journal, run, batches, done, { verify, dir }) {
  let written = 0;
  const rejected = [];
  const landed = new Set();
  for (const b of batches) {
    if (done.has(b.n)) continue;
    // On resume, this batch may have landed before the crash: send only what HubSpot still lacks.
    let inputs = verify ? await verifyInputs(hubspot, b.inputs, rejected, landed) : b.inputs;
    if (inputs.length) {
      let r;
      try {
        r = await hubspot.batchUpdate(inputs);
      } catch (err) {
        // HubSpot may refuse a whole batch (not a 207) when one id was deleted or merged. Re-read,
        // drop what is gone, and try once more; a second refusal stops with the recovery step.
        if (!refusedWhole(err)) throw err;
        inputs = await verifyInputs(hubspot, inputs, rejected, landed);
        try {
          r = inputs.length ? await hubspot.batchUpdate(inputs) : { ok: [], failed: [] };
        } catch (again) {
          if (!refusedWhole(again)) throw again;
          throw new ApiError(`${again.message} HubSpot refused batch ${b.n} twice, after dropping deleted companies. To abandon this run, delete ${join(dir ?? '.', 'journal.jsonl')}; the next sync plans again from live values (safe: every write sets an absolute value).`, again.status);
        }
      }
      for (const id of r.ok) landed.add(id);
      written += count(inputs.filter((i) => r.ok.includes(i.id)));
      rejected.push(...r.failed);
    }
    journal.done(run, b.n);
  }
  journal.complete(run);
  return { written, rejected, landed };
}

// How each company was linked (stripe, usage, mapping), so a later run can tell whether it could
// have seen a link that is now missing (src/unlink.mjs), and the Stripe account that wrote it.
function linkKinds(a) {
  const kinds = new Set();
  if (a.stripe_customer_ids?.length) kinds.add('stripe');
  if (a.usage_account_ids?.length) kinds.add('usage');
  if (Object.values(a.matched_by ?? {}).includes('mapping')) kinds.add('mapping');
  return [...kinds].sort();
}

function updateSnapshot(dir, model, landedOrUnchanged, now, { stripeAccount = null, allowUnlink = false } = {}) {
  const file = join(dir, 'synced.json');
  const prev = readSnapshot(file) ?? {};
  const previous = prev.values ?? {};
  const values = { ...previous };
  const links = { ...(prev.links ?? {}) };
  // Names, so a refusal read before anything is fetched can name companies (pre-public review m-e).
  const names = { ...(prev.names ?? {}) };
  for (const a of model.accounts) {
    if (!landedOrUnchanged.has(a.hubspot_company_id)) continue;
    names[a.hubspot_company_id] = a.hubspot_company_name;
    const v = { ...(previous[a.hubspot_company_id] ?? {}) };
    for (const d of scopedDefinitions(model)) if (!a.blocked.includes(d.key)) v[d.property] = toHubSpot(d, a.metrics[d.key]);
    values[a.hubspot_company_id] = v;
    const kinds = new Set([...linkKinds(a)]);
    // A source this run did not read keeps whatever link it recorded before.
    for (const k of links[a.hubspot_company_id] ?? []) if ((k === 'usage' && model.sources?.usage?.provided === false) || (k === 'mapping' && model.sources?.mapping?.provided === false)) kinds.add(k);
    links[a.hubspot_company_id] = [...kinds].sort();
  }
  for (const u of model.unlinked ?? []) {
    if (u.held || !landedOrUnchanged.has(u.hubspot_company_id)) continue;
    values[u.hubspot_company_id] = Object.fromEntries(scopedDefinitions(model).map((d) => [d.property, unlinkedValue(d)]));
    delete links[u.hubspot_company_id];
    delete names[u.hubspot_company_id];
  }
  const stripe_account = allowUnlink && stripeAccount?.id ? stripeAccount.id : prev.stripe_account ?? stripeAccount?.id ?? null;
  writeJson(file, { schema: SNAPSHOT_SCHEMA, version: SNAPSHOT_VERSION, synced_at: now.toISOString(), stripe_account, values, links, names });
}

export async function runSync({ hubspot, model, current, dir, runId, now = new Date(), stripeAccount = null, allowUnlink = false }) {
  const journal = openJournal(dir);
  let written = 0;
  const rejected = [];
  let resumed = null;

  const pending = journal.unfinished();
  if (pending) {
    resumed = pending.run;
    const r = await sendBatches(hubspot, journal, pending.run, pending.batches, pending.done, { verify: true, dir });
    written += r.written;
    rejected.push(...r.rejected);
    current = await readCurrent(hubspot);
  }

  const snapshot = readSnapshot(join(dir, 'synced.json'));
  const plan = planWrites({ model, current, snapshot });
  const batches = toBatches(plan.writes);
  const touched = new Set(plan.writes.map((w) => w.company_id));
  let landed = new Set();
  if (batches.length) {
    journal.start(runId, batches);
    const r = await sendBatches(hubspot, journal, runId, batches, new Set(), { verify: false, dir });
    written += r.written;
    rejected.push(...r.rejected);
    landed = r.landed;
  }
  const rejectedIds = new Set(rejected.map((x) => x.id));
  const good = new Set([...model.accounts, ...(model.unlinked ?? []).filter((u) => !u.held)].map((a) => a.hubspot_company_id).filter((id) => current.has(id) && !rejectedIds.has(id) && (!touched.has(id) || landed.has(id))));
  updateSnapshot(dir, model, good, now, { stripeAccount, allowUnlink });

  const names = new Map(model.accounts.map((a) => [a.hubspot_company_id, a.hubspot_company_name]));
  return {
    written,
    resumed,
    plan,
    rejected: rejected.map((x) => ({ company_id: x.id, company_name: names.get(x.id) ?? '', reason: x.reason })),
  };
}
