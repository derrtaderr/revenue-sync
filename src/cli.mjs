// Command-line entry. Everything the outside world provides (env, fetch, clock, streams, cwd) is
// injected, so the whole CLI runs under test with fake Stripe and HubSpot and no real keys.

import { readFileSync, writeFileSync, appendFileSync, accessSync, constants, openSync, closeSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ApiError } from './http.mjs';
import { createStripeClient, validStripeKey, BAD_KEY_MESSAGE } from './stripe.mjs';
import { createHubSpotClient, validToken, BAD_TOKEN_MESSAGE } from './hubspot.mjs';
import { createStripeBillingSource, createCsvUsageSource, createWarehouseBillingSource, createWarehouseUsageSource } from './sources.mjs';
import { loadServiceAccount, createTokenProvider, CredentialsError } from './google-auth.mjs';
import { createBigQueryClient } from './bigquery.mjs';
import { ContractError } from './warehouse.mjs';
import { parseMapping } from './mapping.mjs';
import { buildModel } from './model.mjs';
import { formatPlan, planWrites } from './plan.mjs';
import { COMPANY_PROPERTIES, currentFrom, ensureProperties, runSync } from './sync.mjs';
import { reconcile, formatReconcile, problemLabel } from './reconcile.mjs';
import { compareSources, formatCrossSource } from './cross-source.mjs';
import { DEFINITIONS } from './definitions.mjs';
import { runSeed, seedUsageCsv, SeedRefused } from './seed.mjs';
import { applyUnlinkPolicy } from './unlink.mjs';
import { ensureDir, writeJson, readJson, readSnapshot, FILE_MODE } from './store.mjs';
import { validDate } from './usage.mjs';

const CMD = 'node bin/revenue-sync.mjs';
export const DEFAULT_DIR = '.revenue-sync';

export function usage() {
  return `revenue-sync: Stripe billing and product usage on the HubSpot company, reconciled

Usage:
  ${CMD} seed [--usage-out FILE] [--hubspot]
      Build a Stripe TEST-mode dataset and a matching usage CSV (default usage.csv).
      Refuses any key that is not sk_test_ or rk_test_. --hubspot also creates the
      matching HubSpot companies that are missing (needs HUBSPOT_TOKEN).
  ${CMD} plan [--usage FILE] [--mapping FILE] [--dir DIR] [--as-of YYYY-MM-DD]
      Print every HubSpot write (company, property, old → new). Writes nothing to HubSpot.
  ${CMD} sync [same options as plan]
      Create any missing properties, then write the plan. A re-run writes nothing;
      an interrupted run resumes without writing anything twice.
  ${CMD} reconcile [same options as plan] [--strict]
      Re-read HubSpot and exit 3 naming every value that disagrees with billing.
      --strict also fails on unmatched, ambiguous, flagged or skipped records.
  ${CMD} help

  plan, sync and reconcile can read billing and usage from BigQuery instead:
      --billing-sql FILE      Billing from your own SQL (columns in docs/warehouse.md), not Stripe.
                              reconcile then also compares warehouse MRR with Stripe when
                              STRIPE_API_KEY is set, and exits 3 naming every company that differs.
      --usage-sql FILE        Usage from your own SQL: account_id, user_id, date[, domain].
      --bigquery-project ID   Default: the project_id in the service account key.
      --bigquery-location LOC The job location (US, EU, a region). Default: BigQuery's.

Options:
  --usage FILE     Product usage CSV: account_id,user_id,date[,domain]
  --mapping FILE   Explicit mapping CSV: source,source_id,hubspot_company_id
                   Once a sync has used one, sync refuses to run without it. To stop using
                   it, run plan --mapping with an empty file (header only) first to see
                   what that clears, then sync with the same empty file.
  --dir DIR        State folder (account model, journal, last sync). Default ./${DEFAULT_DIR}
                   It is the only record of past syncs. Use the same folder every run, and
                   keep it between runs; give an absolute path from cron.
  --as-of DATE     The date usage windows end on. Default today (UTC).
  --allow-unlink   Clear companies that no longer resolve even when the unlink guard would
                   refuse (no Stripe customers, more than 2 companies and 10 percent at once,
                   a different or unreadable Stripe account, or no record of how one was linked).

Environment (never a flag, so keys stay out of shell history). For BigQuery, also
GOOGLE_APPLICATION_CREDENTIALS (path to a service account key JSON) or GOOGLE_SERVICE_ACCOUNT_JSON;
the service account needs BigQuery Job User and BigQuery Data Viewer. Keep both in a gitignored .env
file and load it with Node 20.6+: node --env-file=.env bin/revenue-sync.mjs plan
  STRIPE_API_KEY   Stripe secret or restricted key. Start with the full secret key from a
                   Stripe sandbox (sk_test_), which is what was verified; seed needs a test
                   key with write access.
                   Automatic unlinking needs the key to read GET /v1/account (verified for
                   a full secret key; unverified for a restricted key, which holds unlinks).
  HUBSPOT_TOKEN    HubSpot service key or private app token with crm.objects.companies.read,
                   crm.objects.companies.write, crm.schemas.companies.read and
                   crm.schemas.companies.write.

Exit codes: 0 ok, 1 usage or setup problem (nothing written), 2 Stripe or HubSpot error,
3 reconcile disagreement or HubSpot rejected a write, 4 a local file could not be written,
5 sync refused to unlink (nothing written; see --allow-unlink).
`;
}

class UsageError extends Error {}

const VALUE_FLAGS = ['usage', 'mapping', 'dir', 'as-of', 'usage-out', 'billing-sql', 'usage-sql', 'bigquery-project', 'bigquery-location'];

class GuardRefused extends Error {}
// A setup problem found after reading Stripe and HubSpot, before any write: exit 1.
class SetupRefused extends Error {}
const BOOL_FLAGS = ['strict', 'hubspot', 'allow-unlink'];

function parseFlags(args, allowed) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const m = /^--([a-z-]+)(?:=(.*))?$/s.exec(a);
    if (a === '--help' || a === '-h') { flags.help = true; continue; }
    if (!m || !allowed.includes(m[1])) throw new UsageError(`Unknown option "${a}"`);
    const name = m[1];
    if (BOOL_FLAGS.includes(name)) { flags[name] = true; continue; }
    const value = m[2] ?? args[++i];
    if (!value) throw new UsageError(`--${name} needs a value`);
    flags[name] = value;
  }
  return flags;
}

export function pathValue(value, home, cwd) {
  const unquoted = /^(["'])(.*)\1$/s.exec(value)?.[2] ?? value;
  return resolve(cwd, unquoted.replace(/^~(?=$|[\\/])/, home));
}

// No message printed or logged may carry a secret, even one inside an unexpected exception.
export function redact(text, env = {}) {
  let out = String(text);
  for (const secret of [env.STRIPE_API_KEY, env.HUBSPOT_TOKEN, env.GOOGLE_SERVICE_ACCOUNT_JSON]) {
    const s = secret?.trim();
    if (s && s.length >= 6) out = out.split(s).join('[redacted]');
  }
  return out
    .replace(/\b[sr]k_(test|live)_[A-Za-z0-9]+/g, '[redacted]')
    .replace(/\bpat-[a-z0-9]+-[0-9a-f-]{8,}/gi, '[redacted]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted]')
    .replace(/\bya29\.[\w.-]+/g, '[redacted]');
}

const today = (now) => now.toISOString().slice(0, 10);

// Every key problem is reported at once, so a first run does not fail twice in a row.
function keys(env, { needHubSpot = true, needStripe = true } = {}) {
  const stripeKey = env.STRIPE_API_KEY?.trim();
  const token = env.HUBSPOT_TOKEN?.trim();
  const errors = [];
  if (needStripe && !stripeKey) errors.push('STRIPE_API_KEY is not set. Put a Stripe secret key in .env (start with the full secret key from a Stripe sandbox, sk_test_) and run with node --env-file=.env (see the README quickstart).');
  else if (needStripe && !validStripeKey(stripeKey)) errors.push(BAD_KEY_MESSAGE);
  if (needHubSpot && !token) errors.push('HUBSPOT_TOKEN is not set. Put a HubSpot service key or private app token in .env and run with node --env-file=.env (see the README quickstart).');
  else if (needHubSpot && !validToken(token)) errors.push(BAD_TOKEN_MESSAGE);
  return errors.length ? { error: errors.join('\n') } : { stripeKey, token };
}

function readInput(file, what, parse, ctx) {
  if (!file) return null;
  const path = pathValue(file, ctx.home ?? homedir(), ctx.cwd);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new UsageError(err.code === 'ENOENT' ? `The ${what} file ${path} does not exist.` : `Cannot read the ${what} file ${path} (${err.code ?? 'error'}).`);
  }
  try {
    return parse(text);
  } catch (err) {
    throw new UsageError(`${err.message} (${path})`);
  }
}

function summary(model) {
  const flagged = model.accounts.filter((a) => a.blocked.length).length;
  const s = model.sources;
  const wh = s.billing?.source === 'bigquery';
  return [
    `Read ${s.stripe.customers} ${wh ? 'billing' : 'Stripe'} customers, ${s.stripe.subscriptions} subscriptions, ${s.stripe.open_invoices} open invoices${wh ? ' from BigQuery' : ''}; ${s.hubspot.companies} HubSpot companies; ${s.usage.accounts} usage accounts.`,
    `Matched ${model.accounts.length} companies. Refused: ${model.unmatched.length} unmatched, ${model.ambiguous.length} ambiguous. Flagged: ${flagged}.`,
    '',
    '',
  ].join('\n');
}

// Said on every run, not only once a churned company is held: with an unreadable account every
// unlink is held and plain reconcile passes on it (pre-public review I4).
function accountWarning(stripeAccount) {
  if (stripeAccount?.id) return '';
  return `Warning: the Stripe account could not be identified (${stripeAccount?.reason ?? 'unknown'}). A company whose Stripe customer is deleted keeps its last values in HubSpot (held, not unlinked), and plain reconcile still exits 0 on it. Use the full secret key, or clear real churn with sync --allow-unlink.\n\n`;
}

// Which state folder this run uses, and whether it has history, so a run from the wrong folder
// (cron from $HOME with a relative default --dir) is visible in its own output (pre-public review I1).
function stateLine(dir) {
  const snap = readSnapshot(join(dir, 'synced.json'));
  return `State folder: ${dir} (${snap ? `last sync ${snap.synced_at ?? 'at an unknown time'}` : 'no sync recorded here yet'}).\n\n`;
}

// The F3 refusal and the unlink holds only know what this state folder recorded. A folder with no
// history on a portal that already holds values may be the wrong folder (pre-public review I1).
// A state folder has a record once a sync finished (synced.json) or started (journal.jsonl: an
// interrupted first sync wrote values and resumes from the journal).
const hasHistory = (dir) => !!readSnapshot(join(dir, 'synced.json')) || existsSync(join(dir, 'journal.jsonl'));

const holdingValues = (current) => [...current.values()].filter((p) => DEFINITIONS.some((d) => String(p[d.property] ?? '').trim() !== '')).length;

function historyWarning(dir, current) {
  if (hasHistory(dir)) return '';
  const holding = holdingValues(current);
  if (!holding) return '';
  return `Warning: ${holding} HubSpot ${holding === 1 ? 'company already holds' : 'companies already hold'} revenue-sync values, but this state folder has no record of a sync. Mapping or usage links recorded by a sync from another state folder are unknown here, so a company linked by a mapping row there loses what that row put on it, and a company whose Stripe customer is deleted is held with its old values instead of cleared. If these values came from another state folder, pass that --dir (and the same --mapping); the state folder must persist between runs.\n\n`;
}

function refusals(model) {
  const lines = [];
  for (const u of model.unmatched) lines.push(`Unmatched, not written: ${u.source} ${u.source_id} (${u.label}): ${u.reason}`);
  for (const u of model.ambiguous) lines.push(`Ambiguous, not written: ${u.source} ${u.source_id} (${u.label}): matches ${u.candidates.map((c) => `${c.name} (${c.id})`).join(' and ')}; add a mapping row`);
  for (const u of (model.unlinked ?? []).filter((x) => x.held)) lines.push(`Held, not unlinked: ${u.hubspot_company_name} (HubSpot ${u.hubspot_company_id}): ${u.held}`);
  for (const u of (model.unlinked ?? []).filter((x) => !x.held)) lines.push(`Unlinked: ${u.hubspot_company_name} (HubSpot ${u.hubspot_company_id}): ${u.reason}. ${u.cleared ? 'Its values are already cleared.' : model.unlink_guard && !model.unlink_guard.ok ? 'The unlink guard is refusing this run, so it will be cleared only if sync is run with --allow-unlink.' : 'sync clears its revenue-sync values and sets rs_billing_status to unlinked.'}`);
  for (const a of model.accounts.filter((x) => x.blocked.length)) lines.push(`Flagged, money values not written: ${a.hubspot_company_name} (HubSpot ${a.hubspot_company_id}): ${a.flags.map((f) => f.detail).join('; ')}`);
  for (const p of model.input_problems) lines.push(`Skipped ${problemLabel(p, model.sources?.usage?.source)}: ${p.reason}`);
  return lines.length ? `${lines.join('\n')}\n\n` : '';
}

async function loadModel(flags, ctx, k, dir) {
  const asOf = flags['as-of'] ?? today(ctx.now);
  if (!validDate(asOf) || validDate(asOf) !== asOf) throw new UsageError(`--as-of must be a date as YYYY-MM-DD, got ${JSON.stringify(asOf)}`);
  const io = { fetch: ctx.fetch, sleep: ctx.sleep, random: ctx.random };
  const warehouse = warehouseSetup(flags, ctx, io);
  const usageSource = warehouse?.usage ?? readInput(flags.usage, 'usage', (text) => createCsvUsageSource({ text }), ctx);
  const mapping = readInput(flags.mapping, 'mapping', parseMapping, ctx) ?? parseMapping(null);
  const billing = warehouse?.billing ?? createStripeBillingSource({ client: createStripeClient({ key: k.stripeKey, ...io }) });
  if (ctx.state && billing.kind !== 'stripe') ctx.state.billing = billing.kind;
  const hubspot = createHubSpotClient({ token: k.token, ...io });
  const { customers, subscriptions, invoices, products, coupons } = await billing.read();
  const companies = await hubspot.listCompanies(COMPANY_PROPERTIES);
  // seed (Stripe customers seed tagged) or demo (the bundled demo query's cus_demo_ ids), so the
  // activation line in run.log tells a tutorial run from real data.
  const tutorial = billing.kind === 'stripe' ? 'seed' : 'demo';
  const seeded = customers.filter((x) => (billing.kind === 'stripe' ? x.metadata?.revenue_sync_seed : /^cus_demo_/.test(x.id))).length;
  if (ctx.state) ctx.state.data = !customers.length ? 'none' : seeded === customers.length ? tutorial : seeded ? 'mixed' : 'real';
  const stripeAccount = await billing.identity();
  const usage = usageSource ? await usageSource.read() : null;
  const current = currentFrom(companies);
  const built = buildModel({ companies, customers, subscriptions, invoices, products, coupons, usage, mapping: Object.assign(mapping, { provided: !!flags.mapping }), asOf, generatedAt: ctx.now });
  // Which sources ran (optional fields within model version 1).
  built.sources.billing = { source: billing.kind };
  if (usageSource) built.sources.usage.source = usageSource.kind;
  const model = applyUnlinkPolicy({
    model: built, current, snapshot: readSnapshot(join(dir, 'synced.json')), stripeAccount, customersCount: customers.length,
    // Any usage source counts (--usage or --usage-sql): the question is whether usage was read.
    provided: { mapping: !!flags.mapping, usage: !!usageSource }, allowUnlink: !!flags['allow-unlink'],
  });
  writeJson(join(dir, 'model.json'), model);
  return { model, hubspot, current, stripeAccount, companies, usage, mapping, asOf, io };
}

// --billing-sql and --usage-sql: the SQL files, the service account key and the project are all
// checked here, before any request, so a setup mistake never costs a query.
function warehouseSetup(flags, ctx, io) {
  if (flags.usage && flags['usage-sql']) throw new UsageError('--usage and --usage-sql cannot both be given: usage comes from one source.');
  if (!flags['billing-sql'] && !flags['usage-sql']) {
    const stray = ['bigquery-project', 'bigquery-location'].find((f) => flags[f]);
    if (stray) throw new UsageError(`--${stray} only applies with --billing-sql or --usage-sql.`);
    return null;
  }
  const sqlText = (text) => {
    if (!text.trim()) throw new Error('is empty');
    return text;
  };
  const billingSql = readInput(flags['billing-sql'], 'billing SQL', sqlText, ctx);
  const usageSql = readInput(flags['usage-sql'], 'usage SQL', sqlText, ctx);
  let key;
  try {
    key = loadServiceAccount(ctx.env, (p) => readFileSync(pathValue(p, ctx.home ?? homedir(), ctx.cwd), 'utf8'));
  } catch (err) {
    if (err instanceof CredentialsError) throw new UsageError(err.message);
    throw err;
  }
  const project = flags['bigquery-project'] ?? key.project_id;
  if (!project) throw new UsageError('No BigQuery project: pass --bigquery-project, or use a service account key that names its project_id.');
  const tokens = createTokenProvider({ key, ...io, now: () => ctx.now.getTime() });
  const client = createBigQueryClient({ tokens, project, location: flags['bigquery-location'], ...io });
  return {
    billing: billingSql && createWarehouseBillingSource({ client, sql: billingSql, project, where: flags['billing-sql'] }),
    usage: usageSql && createWarehouseUsageSource({ client, sql: usageSql, where: flags['usage-sql'] }),
  };
}

class FileError extends Error {}

function prepareDir(flags, ctx) {
  const dir = pathValue(flags.dir ?? DEFAULT_DIR, ctx.home ?? homedir(), ctx.cwd);
  try {
    ensureDir(dir);
    accessSync(dir, constants.W_OK | constants.R_OK);
  } catch (err) {
    throw new UsageError(`Cannot use the state folder ${dir} (${err.code ?? 'error'}). Choose one you can read and write with --dir.`);
  }
  // A damaged synced.json stops the run here, before anything is fetched (pre-public review m-f).
  try {
    readSnapshot(join(dir, 'synced.json'));
  } catch (err) {
    throw new UsageError(err.message);
  }
  return dir;
}

function guardLine(model) {
  const g = model.unlink_guard;
  if (!g) return '';
  if (!g.ok) return `Unlink guard: sync will refuse: ${g.reason}. Nothing will be written unless sync is run with --allow-unlink.\n\n`;
  if (g.reason) return `Unlink guard: ${g.reason}.\n\n`;
  return g.would_unlink ? `Unlink guard: ok (${g.would_unlink} of ${g.linked} linked companies would be unlinked).\n\n` : '';
}

// Companies the last sync linked through the mapping file. A run without --mapping would drop
// what those rows put on them, silently when the company is also linked by domain (F3).
function mappingLinked(dir) {
  const snap = readSnapshot(join(dir, 'synced.json'));
  const links = snap?.links ?? {};
  const ids = Object.keys(links).filter((id) => links[id].includes('mapping'));
  if (!ids.length) return null;
  // Names come from synced.json first (sync records them); model.json is a fallback for state
  // folders synced before names were recorded, and it may be overwritten or damaged (pre-public review m-e).
  let model = null;
  try { model = readJson(join(dir, 'model.json')); } catch { /* unreadable: fall back to ids */ }
  const fromModel = new Map((Array.isArray(model?.accounts) ? model.accounts : []).map((a) => [a?.hubspot_company_id, a?.hubspot_company_name]));
  const name = (id) => snap.names?.[id] || (typeof fromModel.get(id) === 'string' && fromModel.get(id)) || `HubSpot ${id}`;
  const list = ids.map(name).join(', ');
  return `the last sync linked ${ids.length} ${ids.length === 1 ? 'company' : 'companies'} through the mapping file (${list}), but this run has no --mapping`;
}

const billingKeys = (flags, ctx) => keys(ctx.env, { needStripe: !flags['billing-sql'] });

async function commandPlan(flags, ctx, dir) {
  const k = billingKeys(flags, ctx);
  if (k.error) throw new UsageError(k.error);
  const missingMapping = !flags.mapping && mappingLinked(dir);
  if (missingMapping) ctx.stderr.write(`Warning: ${missingMapping}, so this plan leaves out what the mapping rows put on them, and sync will refuse to run.\n\n`);
  const { model, hubspot, current, stripeAccount } = await loadModel(flags, ctx, k, dir);
  const props = await ensureProperties(hubspot, { create: false });
  const plan = planWrites({ model, current, snapshot: readSnapshot(join(dir, 'synced.json')) });
  ctx.stderr.write(accountWarning(stripeAccount) + historyWarning(dir, current));
  const head = summary(model) + stateLine(dir) + refusals(model) + guardLine(model);
  if (!model.sources.hubspot.companies) {
    ctx.stdout.write(`${head}HubSpot has no companies, so nothing can be matched or written (sync would only create the revenue_sync properties). Create the companies in HubSpot, or run seed --hubspot on a test portal, then run plan again.\n`);
    return 0;
  }
  ctx.stdout.write(head + formatPlan(plan, { missingProperties: props.missing, missingGroup: props.missingGroup }));
  ctx.stdout.write(plan.writes.length || props.missing.length ? 'Run sync to write this.\n' : '');
  return 0;
}

// One sync at a time per state folder: the journal and snapshot assume a single writer.
function acquireLock(dir, ctx) {
  const file = join(dir, 'sync.lock');
  let fd;
  try {
    fd = openSync(file, 'wx', FILE_MODE);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    let held = {};
    try { held = JSON.parse(readFileSync(file, 'utf8')); } catch { /* unreadable lock */ }
    throw new UsageError(`Another sync is running (pid ${held.pid ?? 'unknown'}, since ${held.since ?? 'unknown'}). If no sync is running, delete ${file} and run again.`);
  }
  writeFileSync(fd, `${JSON.stringify({ pid: process.pid, since: ctx.now.toISOString() })}\n`);
  closeSync(fd);
  return () => rmSync(file, { force: true });
}

async function commandSync(flags, ctx, dir) {
  const k = billingKeys(flags, ctx);
  if (k.error) throw new UsageError(k.error);
  const missingMapping = !flags.mapping && mappingLinked(dir);
  if (missingMapping) {
    const why = missingMapping.charAt(0).toUpperCase() + missingMapping.slice(1);
    throw new UsageError(`${why}. Without it, those companies would lose what the mapping rows put on them. Pass the same --mapping file. If you stopped using a mapping file, first run plan --mapping with an empty file (header only: source,source_id,hubspot_company_id) to see what that clears; then run sync with the same empty file. The companies it linked go through the unlink guard.`);
  }
  const release = acquireLock(dir, ctx);
  try {
    return await syncLocked(flags, ctx, dir, k);
  } finally {
    release();
  }
}

// All-or-nothing (docs/SPEC.md, "What a guard refusal does not write"): the other updates were
// computed from the same inputs that tripped the guard, so they are not written either.
function notWritten(model, current, dir) {
  const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  const other = planWrites({ model, current, snapshot: readSnapshot(join(dir, 'synced.json')) }).writes.filter((w) => !w.unlinked);
  const companies = new Set(other.map((w) => w.company_id)).size;
  return `Nothing was written to HubSpot: not the ${n(model.unlink_guard.would_unlink, 'company', 'companies')} it would unlink, not the ${n(other.length, 'other value update', 'other value updates')} across ${n(companies, 'company', 'companies')}, and no property was created.`;
}

// A sync from a state folder with no record, on a portal that already holds values, without
// --mapping, may be cron in the wrong folder: it would drop what mapping rows recorded elsewhere
// put on a company. Refused before any write. The escape is the existing header-only mapping
// file: with no record here every unlink is held, so it clears nothing.
function noHistoryRefusal(flags, dir, current) {
  if (flags.mapping || hasHistory(dir)) return null;
  const holding = holdingValues(current);
  if (!holding) return null;
  return `This state folder (${dir}) has no record of a sync, but ${holding} HubSpot ${holding === 1 ? 'company already holds' : 'companies already hold'} revenue-sync values, and this run has no --mapping. If those values came from a sync in another state folder, this run would drop what its mapping rows put on companies that also match by domain. Run with the --dir that sync used (and the same --mapping). If there is no mapping file, first run plan --mapping with an empty file (header only: source,source_id,hubspot_company_id) to see what changes, then run sync with the same empty file; with no record here, no company is cleared. Nothing was written to HubSpot.`;
}

async function syncLocked(flags, ctx, dir, k) {
  const { model, hubspot, current, stripeAccount } = await loadModel(flags, ctx, k, dir);
  const refused = noHistoryRefusal(flags, dir, current);
  if (refused) throw new SetupRefused(refused);
  ctx.stderr.write(accountWarning(stripeAccount) + historyWarning(dir, current));
  ctx.stdout.write(summary(model) + stateLine(dir) + refusals(model));
  if (!model.unlink_guard.ok) throw new GuardRefused(`Refused to unlink: ${model.unlink_guard.reason}. ${notWritten(model, current, dir)} ${model.sources.billing?.source === 'bigquery' ? 'Check that the billing SQL and BigQuery project are the ones this portal was synced from and that the query returned every customer' : 'Check that STRIPE_API_KEY is the account this portal was synced from and that Stripe answered normally'}; if the companies really are gone, run sync again with --allow-unlink.`);
  ctx.stdout.write(guardLine(model));
  const props = await ensureProperties(hubspot, { create: true });
  if (props.missing.length) ctx.stdout.write(`Created ${props.missingGroup ? 'the property group revenue_sync and ' : ''}${props.missing.length} ${props.missing.length === 1 ? 'property' : 'properties'}: ${props.missing.join(', ')}\n\n`);
  const runId = `${ctx.now.toISOString()}-${process.pid}`;
  const r = await runSync({ hubspot, model, current, dir, runId, now: ctx.now, stripeAccount, allowUnlink: !!flags['allow-unlink'] });
  if (r.resumed) ctx.stdout.write(`Resumed an interrupted sync (run ${r.resumed}) before planning anything new.\n`);
  if (r.plan.writes.length) ctx.stdout.write(formatPlan(r.plan).replace(/\n[^\n]*across[^\n]*\n$/, '\n'));
  for (const x of r.rejected) ctx.stdout.write(`HubSpot rejected the write to ${x.company_name || 'company'} (HubSpot ${x.company_id}): ${x.reason}\n`);
  ctx.stdout.write(r.written ? `Wrote ${r.written} ${r.written === 1 ? 'value' : 'values'} to HubSpot.\n` : 'Nothing to write: HubSpot already matches billing and usage.\n');
  return r.rejected.length ? 3 : 0;
}

async function commandReconcile(flags, ctx, dir) {
  const k = billingKeys(flags, ctx);
  if (k.error) throw new UsageError(k.error);
  const missingMapping = !flags.mapping && mappingLinked(dir);
  if (missingMapping) ctx.stderr.write(`Warning: ${missingMapping}, so what the mapping rows put on them is compared without those rows. Pass the same --mapping file the last sync used.\n\n`);
  // With a warehouse billing source and a Stripe key, reconcile also checks the two billing
  // sources against each other (docs/SPEC.md, "Cross-source reconcile").
  const crossCheck = !!flags['billing-sql'] && !!k.stripeKey;
  if (crossCheck && !validStripeKey(k.stripeKey)) throw new UsageError(BAD_KEY_MESSAGE);
  const loaded = await loadModel(flags, ctx, k, dir);
  const { model, current, stripeAccount } = loaded;
  const r = reconcile({ model, current, strict: !!flags.strict });
  let cross = null;
  if (crossCheck) {
    const stripe = await createStripeBillingSource({ client: createStripeClient({ key: k.stripeKey, ...loaded.io }) }).read();
    const fromStripe = buildModel({ companies: loaded.companies, ...stripe, usage: loaded.usage, mapping: loaded.mapping, asOf: loaded.asOf, generatedAt: ctx.now });
    cross = compareSources({ warehouse: model, stripe: fromStripe });
  }
  ctx.stderr.write(accountWarning(stripeAccount) + historyWarning(dir, current));
  ctx.stdout.write(summary(model) + stateLine(dir) + formatReconcile(r, { missingMapping: !!missingMapping }));
  if (flags['billing-sql']) ctx.state.cross = !cross ? 'skipped' : cross.ok ? 'pass' : 'fail';
  if (cross) ctx.stdout.write(`\n${formatCrossSource(cross)}`);
  else if (flags['billing-sql']) ctx.stdout.write('Stripe was not compared: STRIPE_API_KEY is not set. Set it to also check warehouse MRR against Stripe.\n');
  return r.ok && (!cross || cross.ok) ? 0 : 3;
}

async function commandSeed(flags, ctx) {
  const k = keys(ctx.env, { needHubSpot: !!flags.hubspot });
  if (k.error) throw new UsageError(k.error);
  const io = { fetch: ctx.fetch, sleep: ctx.sleep, random: ctx.random };
  const stripe = createStripeClient({ key: ctx.env.STRIPE_API_KEY?.trim(), ...io });
  const hubspot = flags.hubspot ? createHubSpotClient({ token: k.token, ...io }) : null;
  const usageFile = pathValue(flags['usage-out'] ?? 'usage.csv', ctx.home ?? homedir(), ctx.cwd);
  let r;
  try {
    r = await runSeed({ stripe, key: ctx.env.STRIPE_API_KEY?.trim(), hubspot });
  } catch (err) {
    if (err instanceof SeedRefused) throw new UsageError(err.message);
    throw err;
  }
  ctx.stdout.write(r.alreadySeeded
    ? 'Stripe test data was already seeded; nothing new was created in Stripe.\n'
    : `Created in Stripe (test mode): ${r.created.customers} customers, ${r.created.subscriptions} subscriptions, ${r.created.prices} prices, ${r.created.coupons} coupons.\n`);
  if (hubspot) ctx.stdout.write(`Created ${r.hubspotCreated} HubSpot ${r.hubspotCreated === 1 ? 'company' : 'companies'}.\n`);
  try {
    writeFileSync(usageFile, seedUsageCsv(flags['as-of'] ?? today(ctx.now)), { mode: FILE_MODE });
  } catch (err) {
    throw new FileError(`Could not write the usage CSV to ${usageFile} (${err.code ?? 'error'}). The Stripe data was created; re-run seed to write the file.`);
  }
  ctx.stdout.write(`Wrote the matching usage CSV to ${usageFile}\nNext: node --env-file=.env bin/revenue-sync.mjs plan --usage ${flags['usage-out'] ?? 'usage.csv'}\n`);
  return 0;
}

const COMMANDS = {
  seed: { flags: ['usage-out', 'hubspot', 'as-of'], run: (f, ctx) => commandSeed(f, ctx), state: false },
  plan: { flags: ['usage', 'mapping', 'dir', 'as-of', 'allow-unlink', 'billing-sql', 'usage-sql', 'bigquery-project', 'bigquery-location'], run: commandPlan, state: true },
  sync: { flags: ['usage', 'mapping', 'dir', 'as-of', 'allow-unlink', 'billing-sql', 'usage-sql', 'bigquery-project', 'bigquery-location'], run: commandSync, state: true },
  reconcile: { flags: ['usage', 'mapping', 'dir', 'as-of', 'strict', 'allow-unlink', 'billing-sql', 'usage-sql', 'bigquery-project', 'bigquery-location'], run: commandReconcile, state: true },
};

// One line per run. data= says whether Stripe held only seed customers, so the activation event
// (the first reconcile that exits 0, on seeded or real data) can be read straight from this file.
function appendRunLog(dir, ctx, command, code, messages, state) {
  try {
    const text = messages.join(' ').replace(/\s+/g, ' ').trim();
    const data = `${state.data ? ` data=${state.data}` : ''}${state.billing ? ` billing=${state.billing}` : ''}${state.cross ? ` cross=${state.cross}` : ''}`;
    appendFileSync(join(dir, 'run.log'), `${ctx.now.toISOString()} ${command} exit=${code}${data}${text ? ` ${redact(text, ctx.env)}` : ''}\n`, { mode: FILE_MODE });
  } catch (err) {
    ctx.stderr.write(`Warning: could not add a line to ${join(dir, 'run.log')} (${err.code ?? 'error'}).\n`);
  }
}

export async function main(argv, ctx) {
  const [command, ...rest] = argv;
  const messages = [];
  const stderr = { write: (s) => { messages.push(s); return ctx.stderr.write(redact(s, ctx.env)); } };
  const state = {};
  const c = { ...ctx, stderr, state };
  let dir = null;
  let code = 1;
  try {
    if (!command || command === 'help' || command === '--help' || command === '-h') { ctx.stdout.write(usage()); return (code = 0); }
    const spec = COMMANDS[command];
    if (!spec) throw new UsageError(`Unknown command "${command}"`);
    const flags = parseFlags(rest, spec.flags);
    if (flags.help) { ctx.stdout.write(usage()); return (code = 0); }
    if (spec.state) dir = prepareDir(flags, c);
    code = await spec.run(flags, c, dir);
    return code;
  } catch (err) {
    if (err instanceof UsageError) {
      stderr.write(`${err.message}\n${/^Unknown (command|option)/.test(err.message) ? `\n${usage()}` : 'Nothing was fetched or written.\n'}`);
      return (code = 1);
    }
    if (err instanceof ApiError) {
      const after = {
        sync: 'Nothing was written to HubSpot by the failed step. If a sync was under way, the next sync resumes it without writing anything twice.',
        seed: 'Anything seed created before this error stays. Re-running seed within 24 hours finishes the job without duplicates.',
      }[command] ?? 'Nothing was written to HubSpot.';
      stderr.write(`${err.message}\n${after}\n`);
      return (code = 2);
    }
    if (err instanceof SetupRefused || err instanceof ContractError) {
      stderr.write(`${err.message}\n`);
      return (code = 1);
    }
    if (err instanceof GuardRefused) {
      stderr.write(`${err.message}\n`);
      return (code = 5);
    }
    if (err instanceof FileError || err?.code === 'EACCES' || err?.code === 'ENOSPC' || err?.code === 'EROFS') {
      stderr.write(`${err.message}\n`);
      return (code = 4);
    }
    stderr.write(`Unexpected error: ${err?.message ?? err}\n`);
    return (code = 1);
  } finally {
    if (dir) appendRunLog(dir, ctx, command, code, messages, state);
  }
}
