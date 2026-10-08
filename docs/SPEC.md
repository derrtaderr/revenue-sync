# revenue-sync: v0.1 spec

Billing and product usage land on the HubSpot company, reconciled, so post-sale decisions run
on numbers that agree.

## The problem

A RevOps or CS owner at a 75 to 300 person B2B SaaS company runs HubSpot as the CRM and Stripe
for billing, usually with no data warehouse. "Is this account healthy, when does it renew, how
much do they pay, are they using it" is answered from three tabs: the Stripe dashboard, a product
usage export, and the HubSpot company record. The CRM numbers, where they exist at all, were
typed in at close and drift from what billing says. Nobody can tell which number is right, so
renewal and expansion calls start with an argument about the data.

## Scope (v0.1)

1. **Read Stripe** (customers, subscriptions with `status=all`, open invoices, products) with
   the user's own key from `STRIPE_API_KEY`. Paginate with `starting_after` / `has_more`. Pin the
   `Stripe-Version` header so the shapes this tool reads cannot change under it.
2. **Read product usage from a CSV** (`account_id,user_id,date[,domain]`, one row per user
   activity). Postgres is deferred (see Non-scope).
3. **Resolve** every Stripe customer and every usage account to exactly one HubSpot company:
   - an explicit mapping file entry wins (`mapping.csv`: `source,source_id,hubspot_company_id`);
   - otherwise a domain match against the company `domain` and `hs_additional_domains`;
   - otherwise the record is **unmatched**: reported, never written, never guessed.
   - Two companies on one domain is **ambiguous**: refused, with both candidates (id and name)
     named. A free mail domain (gmail.com and similar) never domain-matches.
4. **Compute metrics from one definitions file** (`src/definitions.mjs`): MRR, ARR, plan,
   billing status, renewal date, seat count, outstanding amount, billing currency, active users
   30d, usage trend. Each definition carries its plain-words description, which generates
   `docs/metrics.md` and the README metrics table.
5. **Build one local account model** (`<dir>/model.json`, versioned contract in
   `schema/account-model.v1.json`, documented in `docs/account-model.md`). The model is the
   product; later tools (health alerts, a QBR generator) read it.
6. **`plan`** prints every HubSpot write (company, property, old → new) and every property it
   would create. Writes nothing to HubSpot.
7. **`sync`** creates the missing custom properties (group `revenue_sync`), then writes in
   batches of up to 100 with a journal, retries 429 and 5xx with backoff, and resumes a crashed
   run without writing a batch twice. A re-run with no billing change writes nothing.
8. **`reconcile`** re-reads HubSpot and exits 3, naming every company where a CRM value
   disagrees with billing, with both values. This is the headline: a check that can fail.
9. **Warehouse sources** (BigQuery first): billing and usage from the user's own SQL, behind the
   same source interface as Stripe and the CSV, and a cross-source reconcile (see "Warehouse
   sources").
10. **`seed`** builds a realistic Stripe TEST-mode dataset and the matching usage CSV, and
   refuses any key that does not start `sk_test_` or `rk_test_`. With `--hubspot` it also
   creates the matching HubSpot companies (only the ones whose domain is not already there).

## Non-scope (v0.1)

- **Postgres usage source.** Deferred. Speaking the Postgres wire protocol without a dependency
  is a project of its own, and the zero-dependency rule is load-bearing for a tool that holds a
  billing key. The README gives a one-line `psql \copy` recipe that writes the CSV this tool
  reads, which covers the same need.
- Other billing systems (Chargebee, Recurly), other CRMs, contacts or deals as targets.
- Writing anything back to Stripe (seed aside, which only runs on a test key).
- Metered and tiered prices: the account is flagged `unsupported_price` and its money values are
  not computed or written, rather than written wrong.
- Currency conversion. Mixed currency on one company is flagged `mixed_currency`, never summed.
- A scheduler, a UI, hosting, telemetry.

## Commands

```
node bin/revenue-sync.mjs seed      [--usage-out FILE] [--hubspot]
node bin/revenue-sync.mjs plan      [--usage FILE] [--mapping FILE] [--dir DIR] [--as-of DATE]
node bin/revenue-sync.mjs sync      [--usage FILE] [--mapping FILE] [--dir DIR] [--as-of DATE]
node bin/revenue-sync.mjs reconcile [--usage FILE] [--mapping FILE] [--dir DIR] [--as-of DATE] [--strict]
node bin/revenue-sync.mjs help
```

`plan`, `sync` and `reconcile` also take `--billing-sql FILE`, `--usage-sql FILE`,
`--bigquery-project ID` and `--bigquery-location LOC` (see "Warehouse sources").

Secrets come only from the environment (`STRIPE_API_KEY`, `HUBSPOT_TOKEN`), which can be
loaded from a gitignored `.env` with Node's own `node --env-file=.env` (Node 20.6+). There is no
flag for either, so they stay out of shell history and `ps`.

Exit codes: 0 ok; 1 usage or setup problem (nothing written) or unexpected error; 2 Stripe or
HubSpot API error; 3 `reconcile` found a disagreement (or, with `--strict`, an unmatched,
ambiguous or flagged record), or `sync` had writes HubSpot rejected; 4 a local file could not be
written after work began.

## Design decisions

### Diff against live HubSpot, with the last synced snapshot as a witness

The brief asked for "diff against the last synced snapshot so a re-run writes nothing." This
build diffs the desired value against the **live HubSpot value**, which it reads anyway to
resolve domains, and keeps the last synced snapshot as a witness:

- A re-run writes nothing, because after a sync the live value equals the desired value.
- A value someone edited by hand in HubSpot is corrected on the next sync (a snapshot-only diff
  would never notice it and `reconcile` would fail forever).
- `plan` marks a write `(edited in HubSpot since last sync)` when the live value differs from
  the snapshot, so a hand edit is never overwritten silently.

This is a divergence from the brief's wording, called out for confirmation.

### Mapping file overrides domain match

The brief says "domain match first, explicit mapping file second." Read as an order of
precedence, a wrong domain match could never be corrected. This build treats the mapping file
as the override (an explicit human decision beats an inference) and domain match as the default.
Called out for confirmation.

### A company that drops out: unlinked, cleared, and caught

A company can stop resolving after it was synced: its Stripe customer is deleted, the
customer's email moves to another domain, a mapping row is removed, a duplicate HubSpot company
makes its domain ambiguous, or the mapping file starts sending the record to two companies.
Before this rule its old `rs_*` values stayed forever and `reconcile` passed.

The rule (one behaviour, every trigger): any HubSpot company that holds a non-empty in-scope
`rs_*` value but is not in the model's accounts is an **unlinked candidate**. Candidates are
found by reading HubSpot. Whether a candidate may be cleared depends on the unlink guard below,
which uses what `synced.json` recorded.

- `plan` lists it (`Unlinked: name (HubSpot id): reason`) and plans the writes; `sync` clears
  every in-scope `rs_*` value and sets `rs_billing_status` to `unlinked`.
- `reconcile` fails (exit 3) while an unlinked company still holds values, naming each value
  against the empty value billing now implies.
- Once cleared, `reconcile` lists it as `Unlinked, values cleared` and passes; `--strict` fails
  on it, like any other refused record.
- The model carries the list as `unlinked` (an optional field added within version 1).

Each trigger has an end-to-end test in `test/e2e.test.mjs`.

### Coupon product restrictions

`applies_to` comes from the coupons list (`expand[]=data.applies_to`), because inside a
subscription it would be a 5-level expand. A coupon with `applies_to.products` naming products
only reduces those items.

What Stripe sends was checked live on 2026-10-07 (see "Verified live"): an **unrestricted coupon
has no `applies_to` key at all**, even in the expanded list; a restricted one has
`applies_to: {"products": ["prod_..."]}`. The rule, keyed on whether the coupon is in the list:

- **In the expanded coupons list, no `applies_to` key:** unrestricted. (Before the live check this was
  read as "restriction unreadable" and flagged, so on real Stripe every company with a coupon got
  no MRR.)
- **In the list, `applies_to` is `null` or `{products: []}`:** unrestricted (a coupon restricted to
  nothing would not be on a subscription).
- **In the list, `applies_to` present but malformed** (not an object, or `products` not an array
  of strings): flagged `unsupported_discount`, money values not written.
- **Not in the list** (deleted, or the list was not read): flagged, since its restriction cannot
  be read.

A customer-level discount (`customer.discount`) applies to every subscription of that customer
that carries no discount of its own. When a customer has one and **any** of its billing
subscriptions carries no discount, the run rate cannot be read from the subscriptions, so the
company is flagged (m12; before, only "every subscription bare" was flagged, so a customer
with one discounted and one bare subscription went unflagged). When every billing subscription
carries its own discount the customer-level discount is taken not to apply; that precedence is
from Stripe's docs and is not yet verified live.

A subscription or open invoice with no `customer` id (Stripe's Accounts v2 bills an account
through `customer_account: "acct_..."`) cannot be attributed by this tool, which reads v1
customers. Rather than drop it silently it is listed as an unmatched Stripe record naming the
`customer_account` (m13). The shape is from Stripe's docs; no Accounts v2 object has been
read live.

### The unlink guard

Clearing is destructive, and the first version cleared on any run that saw fewer links: a sync
without `--mapping` wiped a mapped paying customer, a key for another Stripe account (or a
proxy returning an empty list) unlinked every company with exit 0. Clearing now needs evidence
that this run could have seen the link that is missing (`src/unlink.mjs`).

`synced.json` records, per company, how it was linked (`stripe`, `usage`, `mapping`) and, once,
the Stripe account id that wrote the portal (`GET /v1/account`, which returns the key's own
account). The bare form was confirmed live on 2026-10-07 with a full `sk_test_` secret key (200,
`id: acct_...`). Whether a **restricted** key can read it is not verified: if it cannot, every
unlink is held as "could not be identified", which is safe but means automatic unlinking needs
the full secret key (or `--allow-unlink`).

A candidate is **held** (left untouched, listed as `Held, not unlinked: ... reason`, counted as
not checked by `reconcile`, failing only `--strict`) when:

1. it was linked by a mapping row and this run has no `--mapping`; always, even with
   `--allow-unlink` ("not given" means untouched, the same rule as `--usage`);
2. it was linked by usage and this run has no `--usage`; always (a usage-only company no longer
   flaps between `none` and `unlinked`);
3. this state folder has no record of how it was linked; unless `--allow-unlink`;
4. the Stripe account cannot be read (a restricted key without account access gets 403 and is
   reported as "could not be identified") or differs from the recorded one; unless
   `--allow-unlink`, which also records the new account. Two Stripe accounts writing one portal
   therefore never clear each other's companies.

Then the **guard** counts the candidates that would be cleared. `sync` refuses (exit 5, nothing
written, not even property creation) when Stripe returned no customers while companies are
linked, or when more than 2 companies and more than 10 percent of the linked companies would be
unlinked in one run. `plan` prints the verdict first. `--allow-unlink` overrides it.

Why 10 percent and 2: a nightly run at a 75 to 300 person SaaS company sees a handful of churned
accounts, a small fraction of the book. A tenth of the book disappearing overnight is far more
often a wrong key, a wrong account, a filtered proxy or a broken mapping file than real churn,
and the cost of pausing a real mass churn for one confirmation is a single re-run. The floor of
2 keeps a small portal (where one churn is more than 10 percent) from needing the flag for
ordinary churn. Both are constants (`GUARD_SHARE`, `GUARD_MIN`) to revisit after live use.

A page that is not a list (no `data` array or no boolean `has_more` on Stripe, no `results`
array on HubSpot) is an error, so fetch weirdness can never read as "the customers are gone".

**What a guard refusal does not write (m11).** Decision: keep the refusal all-or-nothing.
The guard trips when the run's inputs look wrong (Stripe returned no customers, or a tenth of
the book vanished at once), which is the signature of a wrong key, a wrong account or a
filtered proxy. The non-clearing updates in that same run are computed from the same suspect
inputs, so writing them would be writing from a run the tool has just declared untrustworthy
(a wrong Stripe account would put another account's MRR on every company that still matches).
A partial write would also leave HubSpot half on the old inputs and half on the new. The cost
is one re-run. The refusal message now says what was not written: the N companies it would
have unlinked, the M other value updates across K companies, and that no property was created.

### A sync without the mapping file it was synced with (F3)

The unlink guard holds a company linked **only** by a mapping row when `--mapping` is missing.
It did not cover a company linked by **both** a domain and a mapping row: without `--mapping`
the domain link keeps the company in the model, so it is not an unlink candidate, and the
mapped customer's revenue silently drops out (live-shaped repro: 2490 becomes 2000, exit 0).

Rule: `sync` refuses before fetching anything when `synced.json` records a `mapping` link for any
company and the run has no `--mapping`. Exit **1**, the existing code for "a usage or setup
problem found before anything was fetched": the check reads only the local state folder, so it
runs before any request, and nothing is fetched or written. Exit 5 is kept for the guard, which
needs Stripe and HubSpot to decide. `--allow-unlink` does not bypass it (the same "not given
means untouched" rule as the held mapping case). A team that really stopped using a mapping file
passes an empty one (header only): the run then knows the rows are gone, and the companies they
linked go through the normal unlink path and guard. `plan` without `--mapping` in the same
situation runs (it writes nothing) and prints the same warning first.

`--usage` gets no such refusal, and the reason is checked rather than assumed: without `--usage`
the usage properties are out of scope (left untouched, not written, not compared), and usage
links never feed a money value, so a sync without `--usage` cannot change a usage-derived value.
A usage-only company is already held. `test/e2e.test.mjs` pins that a sync without `--usage`
after usage links writes no usage property.

### The pre-public pass

The pre-public review found four places where the README or a message promised more than the
code guarantees. Each is fixed in the copy AND narrowed in the code, so a stranger who believes
the README cannot put a wrong number in their CRM without being told.

**I1. "Forgetting a flag cannot clear anything" held within one state folder only.** The F3
refusal reads `synced.json`, so it only knew what syncs from the same `--dir` recorded. A sync
with `--mapping` by hand, then a cron `sync` from `$HOME` (a different default `./.revenue-sync`)
without `--mapping`, found no history, refused nothing, and dropped Globex from 2490 to 2000
with exit 0; the warning went to stdout only, the next `reconcile` from that folder found a
`synced.json` and passed, and `run.log` recorded only exit codes. Decision:

1. **`sync` refuses** (exit 1, after reading Stripe and HubSpot, before any write) when the state
   folder has no record (no `synced.json` and no `journal.jsonl`; an interrupted first sync
   leaves a journal and resumes), HubSpot already holds a non-empty `rs_*` value on any
   company, and the run has no `--mapping`. The message says to run with the `--dir` that sync
   used (and the same `--mapping`). The escape needs no new flag: the existing header-only
   mapping file. With no record in the folder every unlink is held, so it clears nothing; the
   message sends the user to `plan` with that file first, to see what changes. `--allow-unlink`
   does not bypass it.
2. `plan` and `reconcile` in the same situation run (they write nothing) and warn that the
   portal holds values this folder has no record of: mapping links recorded elsewhere are
   unknown here, and a churned company is held with its old values instead of cleared.
3. Every warning goes to stderr, so `run.log` records it with the run's line.
4. `plan`, `sync` and `reconcile` print which state folder they use and whether it has history
   (`State folder: /abs/path (last sync 2026-10-07T09:00:00.000Z).` or
   `(no sync recorded here yet)`).
5. The README scopes the promise to one state folder, says the folder must persist between runs
   (CI runners and containers start empty), and tells cron to pass an absolute `--dir`.

**I2. The F3 escape is one destructive step.** An empty mapping file makes the companies it
linked go through the unlink path. The refusal (and the README) now send the user to
`plan --mapping` with the empty file first, to see what it would clear, before `sync` with it.

**I3. `reconcile` without `--mapping` after a mapped sync goes false-red, and its advice loops.**
It compared without the mapping rows (Globex: HubSpot 2490, billing 2000), exited 3, and said
"Run plan ... then sync", and that sync refuses. `reconcile` now gets the same check `plan` has:
the same warning first, and when it fails in that state its verdict tells the user to run
`reconcile` again with the same `--mapping` file instead of sending them to `plan` and `sync`.
It still compares and still exits 3, so nothing is hidden: it only stops giving advice that
cannot work.

**I4. A Stripe account that cannot be read.** The README said "if it cannot, nothing breaks".
False: every unlink is held, so a churned customer (deleted in Stripe) keeps its last MRR in
HubSpot and plain `reconcile` exits 0 (held companies fail only `--strict`). The README now says
exactly that. And `plan`, `sync` and `reconcile` say it on every run, from the first, on stderr
(so `run.log` records it), whenever `GET /v1/account` gives no id: `Warning: the Stripe account could not be
identified (reason). A company whose Stripe customer is deleted keeps its last values in HubSpot
(held, not unlinked) and plain reconcile still exits 0 on it. Use the full secret key, or clear
real churn with sync --allow-unlink.`

**Minors.**

- **m-a.** `applies_to: {}` and `{products: null}` are flagged `unsupported_discount`, as the
  rule above says ("`products` not an array of strings"); before they read as unrestricted.
- **m-b.** The live re-run is recorded: the quickstart was re-run live on the fixed pre-release
  build on 2026-10-07; Northwind 1300 and Soylent 420 landed, matching an independent
  recomputation, and `reconcile` exited 0 on 77 values. "Verified live" row 1 says so.
- **m-c.** README and SPEC agree: a restricted key is unverified for every endpoint, not only
  `GET /v1/account`.
- **m-d.** `help` and the missing-key message recommend the full `sk_test_` secret key from a
  sandbox, and `help` gives the F3 escape (`plan --mapping` an empty file first).
- **m-e.** `sync` records each linked company's name in `synced.json` (`names`, optional within
  version 1), and the F3 refusal reads names from there first, then `model.json`, then the id. A
  `model.json` overwritten by another run no longer degrades the refusal to bare ids.
- **m-f.** `synced.json` is checked on read: not JSON, not an object, another `schema` or
  `version`, or `synced_at`, `values`, `links`, `names` or `stripe_account` in the wrong shape gives exit 1 before anything is fetched, naming
  the file and what to do (move it aside; the next sync then has no record, so unlinks are held).
  Never `Unexpected error ... is not a function`.
- **m-i.** `seed`'s `Next:` line carries `--env-file=.env`. `plan` against a portal with no
  companies prints one message (HubSpot has no companies to match; create them, or
  `seed --hubspot` on a test portal), not "Nothing to write" next to "Run sync". A mapping row
  whose Stripe customer is not in the Stripe account (or whose usage account is not in the
  `--usage` file, when one is given) is reported as `Skipped mapping CSV line N`, so `--strict`
  fails on it, instead of being ignored. `reconcile` while the unlink guard would refuse says so
  and names `--allow-unlink` instead of only "run plan, then sync".

### Journal and resume

`sync` writes `<dir>/journal.jsonl`: one `plan` line holding every planned write grouped into
batches, then one `done` line per batch HubSpot accepted, then `complete`. A crash leaves a
journal with no `complete`. The next `sync` resumes that run instead of starting a new one:

- batches marked `done` are skipped without another request;
- the batch in flight at the crash is re-read from HubSpot first, and only properties whose live
  value still differs are sent, so a batch that landed before its `done` line was written is
  not written twice;
- the snapshot is written only after `complete`.

Writes are absolute values (set property to X), so even the worst case (a batch re-sent) is
harmless; the journal makes it not happen.

### Retry

One HTTP layer for both APIs: retry 429 and 5xx up to 5 times, honour `Retry-After` (refuse to
wait longer than 60 seconds), otherwise exponential backoff; network errors retry the same way.
Stripe POSTs (seed only) carry an `Idempotency-Key`, so a retried create never duplicates. Error
messages are built from status codes and endpoint paths only, never from headers or bodies, so
a key cannot leak through an error.

### Money

Stripe returns amounts as integers in the currency's minor unit. The computation works in
minor units but not in integers: normalising an annual price to a month (divide by 12) and
applying a percent-off give fractions, so intermediate values are floating point and are rounded
to a whole minor unit once, at the end, before conversion to major units. The minor unit is per
currency (docs.stripe.com/currencies): two decimals by default, none for the zero-decimal list,
three (thousandths) for BHD, JOD, KWD, OMR and TND. UGX and ISK are flagged
`unsupported_currency`: the same Stripe page lists them as zero-decimal and then says they are
"represented as a two-decimal value", so the tool does not guess. A HubSpot number is compared
numerically to within half a thousandth, so `1250` and `1250.00` agree and `12.345` and `12.349`
do not.

### Properties written

All in the property group `revenue_sync` (label "Revenue sync"), prefixed `rs_` so they can
never collide with a property the portal already has. Created on `sync` only, never on `plan`.

## Prior art and the gap

**Internal.** A search of the author's own repositories found no existing Stripe-to-HubSpot sync or
account model. Two sibling builds were read and reused:

- `monday-pipeline-brief`: the HubSpot client shape (token only in the Authorization header,
  errors built from status and path, paging on `paging.next.after`, injected `fetch` and
  `sleep`), the CLI shape (everything external injected so the whole CLI runs under test), the
  lint gate, and the README-is-tested pattern.
- `webhook-engine`: the idempotency discipline (claim, then complete; never mark done before
  the work succeeded), which is the shape of the sync journal here.

**HubSpot's own Stripe apps.** There are two, and neither does this job.
- Stripe as a payment processor for HubSpot payments and quotes (needs Revenue Hub). It is a
  way to take money inside HubSpot, not a sync of an existing Stripe billing setup.
  (knowledge.hubspot.com/payment-processing/use-stripe-with-hubspot)
- The HubSpot-built "Stripe Data Sync" app. Per HubSpot's knowledge base it syncs Stripe
  customers to **contacts** (matched on email), invoices and products one way, and subscriptions
  and payments one way into **custom objects**, which need an Enterprise tier; custom field
  mappings need Operations Hub. Conflicts are settled by "choose the app to prioritize". No
  official page we found describes writing MRR or ARR to the **company**, any company rollup
  across several Stripe customers, combining product usage, or flagging a disagreement.
  (ecosystem.hubspot.com/marketplace/listing/stripe-data-sync,
  knowledge.hubspot.com/integrations/match-records-in-data-sync,
  knowledge.hubspot.com/subscriptions/migrate-stripe-subscriptions-to-hubspot). This is "not
  found", not "proven absent".

**Hightouch and Census.** Both are warehouse-first reverse ETL. Hightouch sources are
warehouses, databases, files and BI tools; Stripe is not a source, so Stripe data must land in a
warehouse first (hightouch.com/docs/sources/overview; free tier of 2 syncs, then usage-priced,
hightouch.com/pricing). Census now redirects to Fivetran "Activations", which activates data "in
your data warehouse or lake", priced per monthly active row (fivetran.com/pricing).

**The gap.** The target buyer has no warehouse. The existing options either need one (two hops
plus a warehouse plus a modelling layer) or sync to contacts and custom objects without a
company-level number, without usage, and without a check that fails when the CRM and billing
disagree. This tool is the no-warehouse path to company-level numbers plus that check, with the
metric definitions in one readable file.

## API shapes this build reads (checked 2026-10-07)

Stripe, pinned with `Stripe-Version: 2026-09-30.endive`:
- Lists page with `limit` (max 100), `starting_after`, `has_more` (docs.stripe.com/api/subscriptions/list).
- Subscriptions list excludes canceled unless `status=all` (same page).
- `current_period_end` lives on each subscription item since `2025-03-31.basil`, not on the
  subscription (docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end).
- `discounts` is an array (singular `discount` removed in basil); since `2025-09-30.clover` the
  coupon is at `discount.source.coupon` and is expanded with
  `expand[]=data.discounts.source.coupon`, exactly the 4-level expand limit
  (docs.stripe.com/changelog/clover/2025-09-30/add-discount-source-property, docs.stripe.com/expand).
- Invoice subscription id is `invoice.parent.subscription_details.subscription`; this build
  reads `amount_remaining`, `currency`, `customer` on `status=open` invoices
  (docs.stripe.com/api/invoices/object).
- Errors `{error:{type,code,message}}`; 429 may carry `Stripe-Rate-Limited-Reason`; sandbox
  limit 25 requests per second (docs.stripe.com/api/errors, docs.stripe.com/rate-limits).
- `Idempotency-Key` on POST (docs.stripe.com/api/idempotent_requests); key prefixes `sk_test_`,
  `rk_test_`, `sk_live_`, `rk_live_` (docs.stripe.com/keys).
- Seeding: `discounts[0][coupon]` (the `coupon` parameter was removed in basil);
  `collection_method=send_invoice` with `days_until_due` activates without a payment method
  (docs.stripe.com/api/subscriptions/create).

HubSpot CRM v3:
- Companies list pages on `paging.next.after`; batch update takes at most 100 inputs and
  answers 207 with `errors[]` on partial failure (developers.hubspot.com/docs/api-reference/crm-companies-v3/guide).
  The 207 shape was confirmed live on 2026-10-07 (see "Verified live"); it is still handled
  defensively: any input not in `results` counts as failed.
- `domain` plus `hs_additional_domains` (semicolon separated) (same page).
- Properties: `POST /crm/v3/properties/companies` needs `name`, `label`, `type`, `fieldType`,
  `groupName`; a missing property GETs 404; groups via `POST /crm/v3/properties/companies/groups`
  (developers.hubspot.com/docs/api-reference/crm-properties-v3/guide). Dates are written
  `YYYY-MM-DD`; numbers as plain decimals.
- Rate limits 100 to 190 requests per 10 seconds for private apps and service keys; 429 has no
  documented `Retry-After`, so the client backs off on its own and honours one if present
  (developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines,
  developers.hubspot.com/docs/api-reference/error-handling). Search is avoided (5 per second,
  no rate-limit headers, indexing lag); companies are listed and matched locally.
- Scopes: `crm.objects.companies.read`, `crm.objects.companies.write`,
  `crm.schemas.companies.read`, `crm.schemas.companies.write`. Which schema scope the property
  create call needs is not stated exactly in the docs, so the README asks for both.

Everything above is exercised against in-process fakes that reproduce these shapes. The fakes
were corrected on 2026-10-07 to the shapes a live run returned (next section).

## Verified live (2026-10-07)

Run by the maintainer against a real Stripe test-mode account (full `sk_test_` secret key) and a
real HubSpot test portal, from a fresh clone of the pre-release build. Each finding below is
encoded in the fakes and pinned by a test; the test suite itself makes no live calls.

| # | Finding | Before the live check | Encoded as |
|---|---|---|---|
| 1 | An unrestricted coupon has **no `applies_to` key**, in `GET /v1/coupons?expand[]=data.applies_to` and in retrieve-with-expand. A restricted coupon returns `applies_to: {"products": ["prod_..."]}` in both. Unexpanded retrieve omits the key for both. | **Bug.** A missing key was read as "restriction unreadable", so every company with an unrestricted coupon was flagged and got no MRR (live: Northwind should be 1300, Soylent 420). | The fake omits the key for unrestricted coupons and honours `expand[]` on retrieve; `src/definitions.mjs` reads "in the list, no key" as unrestricted. Fixed after the live check and confirmed by the live re-run on the pre-release build: Northwind 1300 and Soylent 420 landed. |
| 2 | HubSpot batch update with one missing id: HTTP 207, `status: COMPLETE`, `numErrors: 1`, `errors: [{status: "error", category: "OBJECT_NOT_FOUND", context: {ids: ["..."]}}]`, the good id in `results`. | Handled correctly already. | The fake returns exactly this error object; a test pins the body. |
| 3 | `GET /v1/account` answers 200 with `id: acct_...` for a full `sk_test_` secret key. | Assumed from docs. | Pinned. **A restricted key is unverified.** |
| 4 | Property group plus 10 property creation, 64 writes, an idempotent second sync (nothing written), `reconcile` exit 0; a hand edit in HubSpot made `reconcile` exit 3 naming "HubSpot says 1500, billing says 2000", `plan` marked the hand edit, and `sync` restored it. | Worked. | Already covered by `test/e2e.test.mjs`. |
| 5 | A deleted Stripe customer whose company is still linked by usage keeps the link (`rs_billing_status` none, MRR 0); it is not unlinked. | Worked, undocumented. | Pinned in `test/e2e.test.mjs`; stated in the README under "How a record finds its company". |
| 6 | Every written MRR matched an independent recomputation from raw Stripe data: Initrode 2166.67, Globex 2000, Umbrella 1140, Vandelay 0, Hooli (trialing) 0. | Worked. | The quickstart test asserts each value. |

**Re-run after the fixes (2026-10-07, on the fixed pre-release build).** The maintainer re-ran
the live quickstart: Northwind 1300 and Soylent 420 landed (the coupon companies row 1
had left without MRR), matching an independent recomputation from the raw Stripe data, and
`reconcile` exited 0 on 77 values.

Not verified live: a restricted Stripe key (any endpoint), live-mode data, an Accounts v2
customer, a customer-level discount, `past_due` and `unpaid` subscriptions.

### BigQuery (2026-10-08)

Run by the maintainer from a fresh clone of the pre-release warehouse build, against a real
BigQuery project with a dedicated service account created for the run, using the
`cloud-platform.read-only` token scope, the real Stripe test-mode account above, and the real
HubSpot test portal. The roles it was granted were not checked, so the run does not
show that the README's two roles (BigQuery Job User, BigQuery Data Viewer) are sufficient on their
own; they stay a recommendation.

| # | Finding | Before the live check | Encoded as |
|---|---|---|---|
| 7 | A `jobs.query` dry run returns `statementType`, and a `SELECT` then runs. | From the discovery document only. | The fake's dry run answers `statementType`; the SELECT-only refusal stands unchanged. |
| 8 | The `cloud-platform.read-only` scope runs query jobs (`jobs.query`); `getQueryResults` was not exercised live (the small demo queries most likely completed in the first `jobs.query` answer), so paging and polling are verified against the fake only. | Open; `auth/bigquery` was held in reserve as a fallback. | No fallback scope is needed or requested. A 403 whose reason says the token's scope is insufficient now says "token scope" rather than naming IAM roles (divergence 31). |
| 9 | Real TableCell encodings for the column types the demo queries output decoded with no errors. Types the demo does not output (BIGNUMERIC, FLOAT64, DATETIME, RECORD, REPEATED) were not seen live. | From the documents only. | Already the fake's encoding; pinned by `test/bigquery.test.mjs`. |
| 10 | `examples/bigquery/demo-billing.sql` and `demo-usage.sql` compile and run on BigQuery: 11 customers, 12 subscriptions, 2 open invoices, 7 usage accounts. | The `blank.* REPLACE` pattern and the literal STRUCT arrays were unverified GoogleSQL. | `test/warehouse-e2e.test.mjs` runs the demo's literals through a parser of the file against the fakes; the header of each demo file records the live run. |
| 11 | `plan` exit 0 (8 matched; the ambiguous and mixed-currency cases refused or flagged as designed); `sync` wrote 70 values; a second `sync` wrote nothing; every written MRR matched an independent recomputation from the raw Stripe data. | Expected from the fakes. | Covered by `test/warehouse-e2e.test.mjs`. |
| 12 | `reconcile` exit 3 with the cross-source check failing on exactly one company, whose Stripe customer had been deleted on purpose beforehand (warehouse 2000, Stripe 0): a correct catch. `run.log` recorded `billing=bigquery data=demo cross=fail`. | Expected from the fakes. | Covered by `test/warehouse-e2e.test.mjs` and `test/cross-source.test.mjs`. |

Not verified live on BigQuery: the Stripe Data Pipeline example (a Data Pipeline share is a paid
Stripe feature), so its `[unverified]` column names stay unverified, and so does whether Data
Pipeline's `subscription_items` table keeps the items of a canceled subscription (divergence 29
is written so that either answer is safe).

## Divergences from the brief

Each of these is a decision taken during the build that the brief did not settle. All are open for
confirmation.

1. **Diff target.** The brief says "diff against the last synced snapshot". This build diffs
   against live HubSpot values and keeps the snapshot as a witness that marks hand edits (see
   Design decisions). Effect: a hand edit is corrected on the next sync instead of persisting.
2. **Mapping precedence.** The brief says "domain match first, explicit mapping file second". A
   mapping row overrides a domain match here, so a wrong match can be corrected.
3. **`seed --hubspot` creates companies.** The brief has seed build Stripe data and a usage CSV.
   A stranger's empty HubSpot test portal has no companies to match, so `--hubspot` (opt-in)
   creates the ten fictional `.example` companies that are missing, including one deliberate
   duplicate domain to show the ambiguous refusal.
4. **Three metrics beyond the brief's list:** `rs_billing_currency` (the money values are
   meaningless without it), `rs_billing_status` (one word for past_due, canceling, trialing) and
   `rs_outstanding_amount` (the only use of the invoices the brief asks to pull).
5. **`metadata.domain` on a Stripe customer** beats its email domain, for customers billed at a
   personal or agency address.
6. **`reconcile` passes with refusals listed;** `--strict` fails on them. Otherwise the seeded
   data (which contains refusals on purpose) could never reach the activation event.
7. **`past_due` and `unpaid` are not seeded.** Stripe reaches them only after a failed payment
   over time (test clocks), which the zero-dependency seed does not drive; they are covered by
   unit tests and the fakes.
8. **Postgres deferred** (see Non-scope), with the `psql \copy` recipe in the README.
9. **Unlinked companies are cleared, but only behind the unlink guard.** A company that held
   revenue-sync values and no longer resolves gets every value cleared and `rs_billing_status`
   set to `unlinked`, so a stale MRR is not read as current. Review showed clearing without a
   guard is worse than a stale value: one run with a missing `--mapping`, another Stripe
   account, or an empty response cleared paying customers. Clearing now requires known
   provenance, the source that made the link, the same Stripe account, and a run that is not a
   mass unlink (see "The unlink guard"); otherwise the company is held and reported. The
   thresholds (more than 2 companies and more than 10 percent) and the account-identity rule are
   an open decision.
10. **Without a usage source (`--usage` or `--usage-sql`), usage properties are left untouched** (not blanked), and `reconcile`
    says usage was not checked.
11. **A sync without `--mapping` refuses (exit 1) when the last sync recorded mapping links**
    (F3). Escape: run `plan --mapping` with an empty file first to see what it clears,
    then `sync` with the same empty file. Exit 1 rather than 5 because it is decided
    from the local state folder before anything is fetched.
12. **A guard refusal stays all-or-nothing** (m11): no non-clearing update is written
    from a run whose inputs tripped the guard; the message counts what was not written.
13. **A sync from a state folder with no record, on a portal that already holds values, without
    `--mapping`, refuses (exit 1) before any write.** The escape is the header-only mapping
    file, which clears nothing while the folder has no record; `plan` with it first shows what
    changes.
14. **`reconcile` without `--mapping` after a mapped sync still compares and exits 3** (I3); it warns first and its advice says to re-run with the same `--mapping`, rather than
    skipping the mapped companies.
15. **A mapping row naming a customer Stripe does not have is a skipped CSV row** (m-i),
    reported like any bad row; `--strict` fails on it.
16. **The billing contract is long form** (one row per customer, subscription, item, discount or
    open invoice, told apart by `record`) rather than one wide row per item: several discounts per
    subscription, customers with no subscription and open invoices need no arrays, and the same
    contract ports to Snowflake unchanged.
17. **Money columns refuse FLOAT64, and `amount_off` and `amount_remaining` refuse non-whole
    values** (19.99 is almost always dollars where cents were meant). The brief did not ask; a
    silent factor of 100 is the failure this tool exists to prevent.
18. **Any `errors` entry in a 200 BigQuery answer fails the read**, though Google says some may be
    warnings.
19. **A BigQuery 400 or 404 shows Google's message** (truncated, token-redacted), unlike the Stripe
    and HubSpot clients, which build messages from status and path only. A user cannot fix SQL
    without the error text, and it describes the query, not a credential.
20. **The warehouse unlink identity includes a hash of the SQL**, so the first `sync` after a query
    edit holds unlinks until `--allow-unlink`.
21. **The cross-source check runs whenever `--billing-sql` is given and `STRIPE_API_KEY` is set**,
    with no extra flag. A company in only one source disagrees unless its MRR there is 0. It
    compares MRR and currency, not every metric.
22. **The interval column is `billing_interval`**, because `INTERVAL` is a reserved word in
    GoogleSQL and `AS interval` would need backticks in every user query.
23. **OAuth scope `https://www.googleapis.com/auth/cloud-platform.read-only`**, least privilege,
    listed by the discovery document for both methods, plus a dry run that refuses anything but a
    `SELECT`. Settled by the live run (2026-10-08, "Verified live" row 8): the read-only scope runs
    query jobs, so no broader fallback scope is kept.
24. **Every query is dry-run first and refused unless BigQuery says it is a `SELECT`**, on top of
    the read-only scope: a key that can write (a reused Data Editor key) still cannot run DML or DDL
    through this tool.
25. **Values Stripe cannot produce are refused** (fractional or negative quantity, `interval_count`
    below 1, `percent_off` outside (0, 100], negative amounts, a subscription with no item, a
    repeating discount with no end), and the boolean flags are required on their rows: a NULL is
    never read as FALSE.
26. **A cross-source check that compared nothing fails** (every company flagged, or no company),
    and the verdict says "N of M companies compared".
27. **A partial or stale warehouse load is disclosed, not refused (m7).** A company still linked by
    usage whose billing customer is missing from the load gets MRR 0 written, as a deleted Stripe
    customer does on the Stripe path (live finding 5). Not refused, because the tool cannot tell a
    missing row from real churn from the warehouse alone, a "MRR dropped to 0" hold would also hold
    every real cancellation, and the check that can tell (the cross-source comparison, which names
    the company with Stripe's number) already exists; the README tells warehouse users to run
    `reconcile` with `STRIPE_API_KEY` in the same job as `sync`. Open: a hold for "linked by billing
    last sync, no billing customer now" on warehouse sources only, if live use shows partial loads.
28. **`sync` does not run the cross-source check**; only `reconcile` does. A dollars-for-cents
    `unit_amount` passes every row check and is caught only by the cross-source check (README,
    "Warehouse limitations").
29. **A subscription with no item rows is refused unless its status is `canceled` or
    `incomplete_expired`** (I-C). Those two are terminal in Stripe: the subscription can never
    bill again, and the definitions read no item of a subscription in either status (MRR reads
    active and past_due; plan, seats and renewal read active, past_due and trialing; billing
    status reads the status column only). So an empty item list there changes no value, and a
    canceled subscription with no items writes billing status `canceled` and contributes no money
    value. A warehouse may well drop the items of a canceled subscription (whether Stripe Data
    Pipeline does is unverified), and refusing those would stop every run on real churn history.
    Every other status still refuses: active, past_due and trialing feed values, and unpaid,
    paused and incomplete can return to active on the same subscription, so an empty item list
    there is still a join or load gap. The refusal is written as "every status except the two
    terminal ones", so a status added to the contract later is refused by default. No fail-open
    path: the only subscriptions accepted without items are ones no metric reads items from.
30. **A discount row must carry exactly one of `percent_off` and `amount_off`, and `amount_off`
    must be more than 0** (m-A). Neither, both, or `amount_off` 0 is refused naming the row and
    the column. A Stripe coupon has exactly one, and a positive one; a row with neither would
    have counted as a discount of nothing, and one with both as a discount Stripe never applies.
31. **A BigQuery 403 whose reason says the token's scope is insufficient says "token scope"**
    (m-C): the error's `errors[].reason` `insufficientPermissions` or a `google.rpc.ErrorInfo`
    detail with reason `ACCESS_TOKEN_SCOPE_INSUFFICIENT` (cloud.google.com/apis/design/errors;
    Google's documentation, not seen live). Granting IAM roles cannot fix that, so the roles hint
    would send the user the wrong way. Any other 403 (for example `accessDenied`, the IAM
    permission-denied reason) keeps the hint naming BigQuery Job User and BigQuery Data Viewer.
32. **A discount row the user's own SQL drops is invisible to every row check** (m-B). An inner
    join from subscriptions to discounts or coupons that loses a row produces a valid result with
    one discount fewer, so MRR comes out undiscounted and too high. Only the cross-source check
    can catch it, by disagreeing with Stripe; the README says so, and the Data Pipeline example
    uses LEFT JOINs so a missing referent arrives as a NULL the contract refuses.
33. **Warehouse freshness is a known limitation, mitigated by `reconcile`, not a sync-time
    hold** (open design question, decided). Two options were weighed. (a) Read Stripe Data
    Pipeline's `data_load_times` before a sync: it is specific to one producer of the contract
    (the contract is source-agnostic and the SQL is the user's), its column names are unverified
    without a paid Data Pipeline share, and a fresh load can still be partial. (b) Hold a linked
    company whose warehouse MRR drops to 0 in one run: it also holds every real cancellation,
    which is most of what drops to 0, and adds a second unlink-style guard with its own escape
    flag. Neither is built. The mitigation is the existing one: `reconcile` with `STRIPE_API_KEY`
    in the same job as `sync` names any company where the warehouse and Stripe differ, a stale or
    partial load included (divergence 27). A user who wants a hard stop can put it in their own
    SQL: GoogleSQL's `ERROR()` fails the query when their freshness check fails, and a failed
    query writes nothing. Revisit if live use shows partial loads reaching HubSpot.
34. **A table backed by Google Drive or Sheets is not supported**. Querying one needs
    a Drive scope on the token, and this tool requests only `cloud-platform.read-only`; adding a
    Drive scope would let the key read the service account's Drive files, which is far beyond
    what a billing read needs. BigQuery answers 403 `accessDenied` with a message about "getting
    Drive credentials", which would otherwise get the IAM roles hint, the wrong advice. A 403
    whose message names Drive credentials says the table is Drive-backed and not supported, and to
    copy the data into a native table. The match is on the text "Drive credentials" in the error
    message, as BigQuery users report it; it is not from Google's reference docs and has not been
    seen live by this tool, so a reworded message falls back to the roles hint.

## Questions the author didn't ask

**Does `rs_mrr` match the MRR in Stripe Billing's own dashboard?** For an account with nothing
flagged, in one currency, with Stripe's default discount settings, it should; that is the first
thing to check on a live run. Stripe's definition (docs.stripe.com/billing/subscriptions/analytics,
"Monthly Recurring Revenue"; support.stripe.com, "Tax and application fee impact on MRR"),
compared point by point:

| Point | Stripe Billing | revenue-sync |
|---|---|---|
| Statuses | `active` and `past_due` count; `canceled` and `unpaid` are churn; trials excluded | Same |
| Tax | Excluded | Excluded; a tax-inclusive price is flagged, because the tax inside it is not on the price |
| Discounts | Configurable: subtract recurring discounts, subtract one-time discounts; permanent discounts always subtracted; applies to line-item and stacked coupons | Recurring (forever, and repeating until it ends) subtracted, once-only ignored, `applies_to` honoured; item-level discounts flagged |
| Metered prices | Excluded from MRR | Flagged: the account's money values are not written |
| Item-level trial offers | Only the trialing items are excluded | Not read: an `active` subscription with a trialing item counts in full. Open |
| `pause_collection` | Not stated on the page | Counts as zero and reads as `paused`, since nothing is being collected |
| Several currencies | Converted to one reporting currency | Refused: flagged `mixed_currency`, nothing summed |

**Customer balance and credit notes?** Excluded from MRR, which is a run rate from prices. The
outstanding amount is `amount_remaining` on open invoices, which already reflects credit notes
issued against those invoices and any balance applied when the invoice was finalised. Unapplied
customer credit (a negative customer `balance`) is not subtracted, so a customer holding credit
can show an outstanding amount it will never be asked to pay. Stated here rather than flagged;
a candidate for the next version.

**Should `rs_mrr` be a currency-typed HubSpot property?** Not in v0.1. HubSpot shows a currency
symbol from the portal's company currency, so a company billed in EUR in a USD portal would show
a dollar sign on a euro amount. The value stays a plain number with `rs_billing_currency` next to
it. A single-currency portal could switch the display on later; the exact HubSpot property
option for that has not been checked against the docs.

## Pre-public checklist

Completed before the first public release: build-process files removed, the lint and
private-reference scans run on the released tree, and the LICENSE confirmed.

## Warehouse sources (BigQuery first)

The target buyer above runs Stripe and HubSpot with no warehouse. A team that does run a warehouse
already has billing and product usage in it, and warehouse to CRM is the canonical reverse ETL
shape. The bigger true version of this tool is **one account model fed by any source, with a
reconcile across sources**: the warehouse is read as a billing source and a usage source that
produce the same normalized records the Stripe API and the usage CSV produce, and when both the
warehouse and Stripe are configured, `reconcile` checks them against each other.

### The source interface

A **billing source** returns `{ customers, subscriptions, invoices, products, coupons }` in the
shape `src/definitions.mjs` already reads (the Stripe API shape, endive), plus an `identity()`
for the unlink guard. A **usage source** returns `{ accounts, problems }`, the shape the usage
CSV reader already returns. Identity resolution, the definitions file, plan, sync, reconcile,
the journal and the unlink guard do not change with the source; each source's job is to produce
those records or fail. The Stripe and CSV paths were moved onto the interface first, with the
existing suite green at every step, before any BigQuery code.

Billing customers from any source are matched exactly as Stripe customers are (mapping row with
`source` `stripe`, then `customer_domain`, then the email domain), and their ids are listed in
the model's `stripe_customer_ids`; the field name is kept for version 1 compatibility and means
"billing customer ids". The model's optional `sources.billing` (added within version 1) says
which source ran.

### Commands and flags

```
node bin/revenue-sync.mjs plan|sync|reconcile --billing-sql FILE [--usage-sql FILE]
    [--bigquery-project ID] [--bigquery-location LOC] [the options above]
```

- `--billing-sql FILE` reads billing from BigQuery with the user's own SQL instead of from
  Stripe. `STRIPE_API_KEY` is then not needed for `plan` and `sync`.
- `--usage-sql FILE` reads usage from BigQuery instead of `--usage FILE` (the two are exclusive).
- `--bigquery-project` defaults to the `project_id` in the service account key;
  `--bigquery-location` is passed as the job location (BigQuery's default when omitted).
- Credentials: `GOOGLE_APPLICATION_CREDENTIALS` (path to a service account key JSON) or
  `GOOGLE_SERVICE_ACCOUNT_JSON` (the key JSON itself). Never a flag, never printed or logged;
  the private key and access token are redacted from every message.

### The row contract

The SQL files are the user's; their **output columns** are the contract, documented in
`docs/warehouse.md` and checked on every row. Billing is one result set in long form: each row has
a `record` column (`customer`, `subscription`, `item`, `discount`, `open_invoice`) and every
contract column (unused ones NULL). Amounts are integers in the currency's minor unit, as in the
Stripe API, typed NUMERIC, BIGNUMERIC or INT64; a FLOAT64 money column is refused, because a float
cannot carry an exact amount. A missing column, a wrong type, a NULL where the record needs a
value, an unknown enum value, or an id that appears twice (customer, subscription, item,
`discount_id` or invoice, so a join that fans a row out is refused rather than counted twice), a
value Stripe cannot produce (fractional or negative quantity, `interval_count` below 1, `percent_off`
outside (0, 100], a negative amount, a discount without exactly one of `percent_off` and a
positive `amount_off`), or a subscription with no item rows (unless it is `canceled` or
`incomplete_expired`, divergence 29) stops
the run with exit 1 naming the SQL file, the row and the column; nothing is written. Usage rows
are `account_id, user_id, date[, domain]`; a row with a NULL id or an unreadable date is skipped and
reported, as a bad CSV line is.

Fail-closed treatment is the Stripe path's, because the contract maps onto the records the
definitions already read: a metered or tiered price, an item-level discount, a tax-inclusive
price, UGX or ISK, more than one currency, or a customer-level discount that a subscription does
not show flags the company's money values. A discount whose product restriction was not read
(`applies_to` NULL) is flagged like a Stripe coupon whose restriction could not be read;
`applies_to` empty means unrestricted, and a comma-separated list of product ids restricts it.
`transform_divide_by` and `transform_round` price per pack as Stripe's `transform_quantity` does.
Three-decimal currencies (BHD, JOD, KWD, OMR, TND) are thousandths, as on the Stripe path.

### The worked example: Stripe Data Pipeline in BigQuery

`examples/bigquery/stripe-data-pipeline-billing.sql` maps Stripe Data Pipeline's BigQuery tables
onto the contract. Data Pipeline delivers to BigQuery as the datasets `stripe` (live) and
`stripe_testmode` (sandboxes) in the user's own project, every table carries `merchant_id`, and a
full load lands every 3 hours (docs.stripe.com/data/access-data-in-warehouse,
docs.stripe.com/data/access-data-in-warehouse/data-warehouses). The columns the example reads that
Stripe's docs show in example queries are `subscriptions.id`, `customer_id`, `status`,
`discounts` (comma-separated discount ids), `subscription_items.id`, `subscription_id`,
`price_id`, `price_product_id`, `customers.id`, `email`, `products.id`, `name`, `prices.id`,
`currency`, `discounts.id`, `coupon_id`, `coupons.id`, `amount_off`, `percent_off`
(docs.stripe.com/data/query-billing-data). The rest follow Data Pipeline's documented naming
(nested API fields flattened with underscores, for example `recurring_interval`) and **are not
verified against a live Data Pipeline share**; each is marked in the file, and the first live run
must check them in the schema browser (docs.stripe.com/data/schema).

What the example handles and what it flags:

- Handles: statuses, quantities, per-unit prices, intervals and interval counts, period ends,
  `transform_quantity`, `tax_behavior`, open invoices' `amount_remaining`, product names,
  subscription-level coupons (percent and amount, duration, discount end), three-decimal
  currencies (the amounts pass through in minor units).
- Flags: every coupon's product restriction (`applies_to` is emitted NULL, because no Data
  Pipeline column for it is documented), so a company with a coupon gets no money values until
  the user fills `applies_to`; this is the same treatment the Stripe path gives a restriction
  it cannot read. Customer-level discounts are emitted as `customer_discount` from
  `customers.discount_coupon_id` (unverified column).
- Joins: every join is a LEFT JOIN and every table is filtered by `merchant_id`, so a row whose
  price, discount or coupon is missing arrives with NULLs the row contract refuses, instead of
  being dropped by an inner join (which would understate MRR, or write an undiscounted one). A
  customer missing from the load altogether is invisible to any query; the cross-source check
  is what catches it.
- Not covered: Data Pipeline's freshness. A full load every 3 hours means a change in Stripe
  shows as a cross-source disagreement until the next load (see below).

`examples/bigquery/demo-billing.sql` and `demo-usage.sql` select literal rows (no tables), so the
BigQuery sandbox quickstart costs nothing and needs no data load; the sandbox does not run DML
(docs.cloud.google.com/bigquery/docs/sandbox). The demo's dates are relative to `CURRENT_DATE()`, as seed's are,
and `test/warehouse-e2e.test.mjs` feeds the demo's own literals and column mapping (read by
`test/helpers/demo-sql.mjs`) through the fake BigQuery against the seeded world and asserts the
cross-source check passes. The demo was run on BigQuery on 2026-10-08 ("Verified live" rows 10
to 12): it compiled, and the cross-source check failed on exactly one company, the one whose
Stripe customer had been deleted on purpose (a flagged company is not compared, so this is not a
claim that every other company was compared). Like seed's data it should pass within 14 days of `seed`
(Hooli's trial) and before seed's 3-month Soylent discount ends.

### Cross-source reconcile (the headline)

When `--billing-sql` is given and `STRIPE_API_KEY` is set, `reconcile` also reads Stripe, builds a
second account model from it with the same HubSpot companies, mapping and usage, and compares MRR
and billing currency per company, separate from the HubSpot comparison. Every company where the
warehouse and Stripe disagree is named with both values and fails the run (exit 3). A company
present in one source and not the other disagrees unless the present side's MRR is 0. A company
flagged in either source is listed as not compared; the verdict says "N of M companies compared", and a
run that compared nothing (every company flagged, or none at all) fails instead of reading as
agreement. Without `STRIPE_API_KEY`, `reconcile` says
Stripe was not compared. `sync` never runs this check. The most common real cause of a disagreement is freshness (a
warehouse load behind Stripe), which is exactly what a team needs to see before it trusts the
warehouse numbers in the CRM.

### The unlink guard on a warehouse source

The Stripe path records the Stripe account id that wrote the portal and holds unlinks when a run
reads another account. The warehouse equivalent is the billing source identity
`bigquery:<project>:<first 16 hex of the SHA-256 of the billing SQL file>`, stored in the same
`synced.json` slot. A run from another project, another query, or a different source (Stripe
after BigQuery, or the reverse) therefore holds every unlink until `--allow-unlink`, which also
records the new identity. Editing the SQL file changes the identity on purpose: an edited
query is exactly when a mass "churn" is most likely a filter mistake. The guard thresholds and
the "no customers" refusal apply unchanged.

### BigQuery API shapes this build reads (checked 2026-10-07)

From the BigQuery v2 discovery document (bigquery.googleapis.com/$discovery/rest?version=v2) and
the method pages:

- `POST https://bigquery.googleapis.com/bigquery/v2/projects/{projectId}/queries` with
  `query`, `useLegacySql: false` (the default is true), `location`, `timeoutMs`, `maxResults`
  (docs.cloud.google.com/bigquery/docs/reference/rest/v2/jobs/query).
- `jobComplete`: "If rows or totalRows are present, this will always be true. If this is false,
  totalRows will not be available." `totalRows` is a uint64 **string**. `pageToken`: "A
  non-empty token indicates that additional results are available." `rows` is present only when
  the query completes successfully and there are rows to return. `schema` is "present only when
  the query completes successfully".
- `GET .../projects/{projectId}/queries/{jobId}?pageToken=&location=&timeoutMs=` pages and polls
  (docs.cloud.google.com/bigquery/docs/reference/rest/v2/jobs/getQueryResults).
- Rows are `{f: [{v: ...}]}`; NULL is `{v: null}`; INT64, NUMERIC and BIGNUMERIC values are
  strings; TIMESTAMP is float64 seconds since the epoch, as a string, by default
  (`DataFormatOptions.timestampOutputFormat`, default FLOAT64, same discovery document);
  RECORD is `{v: {f: [...]}}` and REPEATED is `{v: [{v: ...}]}`.
- Errors: `{error: {code, message, errors: [{reason, message, domain, location}]}}`; job errors
  can also arrive in a 200 body's `errors` (docs.cloud.google.com/bigquery/docs/error-messages).
- Scope `https://www.googleapis.com/auth/cloud-platform.read-only`, which the discovery document
  lists for both jobs.query and getQueryResults. Live on 2026-10-08 it ran `jobs.query`;
  `getQueryResults` was not exercised live.
  Roles:
  BigQuery Job User and BigQuery Data Viewer (docs.cloud.google.com/bigquery/docs/access-control).
- **SELECT only.** Every query is first sent with `dryRun: true` ("BigQuery doesn't run the job";
  QueryRequest.dryRun), and the answer's `statementType` (QueryResponse.statementType, values such
  as `SELECT`, `INSERT`, `DELETE`, `MERGE`, `SCRIPT`) must be `SELECT`, or nothing runs. An answer
  without `statementType` is refused too. A dry run through jobs.query was seen live to fill
  `statementType` (2026-10-08).
- **requestId.** The real query carries one UUID `requestId` for the request and its retries.
  The discovery document says it makes mutating queries idempotent and that "read only queries can
  ignore this token", so a retried 5xx may still run, and bill, a second read; it is sent anyway.

OAuth2 for a service account (developers.google.com/identity/protocols/oauth2/service-account):
a JWT with header `{alg: RS256, typ: JWT, kid}` and claims `iss` (the service account email),
`scope`, `aud` `https://oauth2.googleapis.com/token`, `iat`, `exp` (at most one hour later),
signed with the key's private key (`node:crypto`, no dependency), base64url encoded, POSTed as
`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=...` to
`https://oauth2.googleapis.com/token`; the answer is `{access_token, token_type, expires_in}`, an
error is `{error, error_description}` (for example `invalid_grant`).

Fail-closed, as the Stripe client is: a page without `rows` while rows remain, a completed
response without `schema` or `totalRows`, a row count that does not add up to `totalRows`, a
`pageToken` that repeats, any `errors` entry in a response (Google says some may be warnings;
this tool does not guess which), a job still incomplete after the bounded wait (5 minutes), or
an unknown column type throws, and nothing is written. So does a dry run that does not report a
`SELECT`, before the real query is sent. An empty result is empty only when
BigQuery says `jobComplete: true` and `totalRows: "0"`. A 429 or 5xx is retried by the shared
HTTP layer. A query error's own message is shown (truncated), because a user cannot fix their
SQL without it; it describes the SQL, never a credential.

### What the fake BigQuery reproduces, including what the real API omits

The Stripe live run showed a fake that always sends a key the real API omits hides a bug. The
fake (`test/helpers/fake-bigquery.mjs`) therefore models the omissions as well as the shapes:
`rows` omitted entirely when `totalRows` is `"0"`; `jobComplete: false` with no `rows`,
`totalRows` or `schema`, then complete on a later `getQueryResults`; multi-page results with
`pageToken`; NULL as `{v: null}`; error bodies `{error: {code, message, errors[]}}`; token
endpoint errors `{error, error_description}`; a dry run answering `statementType` with no rows and
no job. It verifies the JWT signature with the public key
and checks every claim. Every shape is from the documents cited above; the dry run, the query,
the token exchange and the TableCell encodings for the demo's column types were confirmed by the live run on 2026-10-08
("Verified live", BigQuery). Whether that run paged or polled an incomplete job was not
recorded, so paging and polling remain verified against the fake only.

### Next source: Snowflake

Snowflake's SQL API v2 (`POST /api/v2/statements`, key-pair JWT auth, results in partitions) is
the next source, behind the same interface and the same row contract. Not built here.

### Warehouse gates

| Area | Gate |
|---|---|
| Source interface (Stripe, CSV) | `node --test test/sources.test.mjs` |
| Google service account auth | `node --test test/google-auth.test.mjs` |
| BigQuery client and decoding | `node --test test/bigquery.test.mjs` |
| Warehouse row contract | `node --test test/warehouse.test.mjs` |
| Cross-source reconcile | `node --test test/cross-source.test.mjs` |
| Warehouse end to end, unlink identity | `node --test test/warehouse-e2e.test.mjs` |

Each file joins the per-area gates table below in the commit that creates it.

## Per-area gates

Each area has a cheap gate: the test subset for that area, plus lint. The whole-repo gate runs
before every push. `test/spec.test.mjs` fails if a test file is missing from this table or the
table names a file that does not exist.

| Area | Gate |
|---|---|
| Lint, packaging, spec | `node --test test/lint.test.mjs test/package.test.mjs test/spec.test.mjs && npm run lint` |
| HTTP retry layer | `node --test test/http.test.mjs` |
| Stripe client | `node --test test/stripe.test.mjs` |
| HubSpot client | `node --test test/hubspot.test.mjs` |
| Domains and resolution | `node --test test/domain.test.mjs test/resolve.test.mjs` |
| CSV inputs (usage, mapping) | `node --test test/csv.test.mjs test/usage.test.mjs test/mapping.test.mjs` |
| Metric definitions | `node --test test/metrics.test.mjs test/definitions.test.mjs test/generated.test.mjs && npm run gen:check` |
| Account model contract | `node --test test/model.test.mjs test/contract.test.mjs` |
| Plan, sync, journal, state, unlink guard | `node --test test/plan.test.mjs test/sync.test.mjs test/journal.test.mjs test/store.test.mjs test/unlink.test.mjs` |
| Reconcile | `node --test test/reconcile.test.mjs` |
| Seed | `node --test test/seed.test.mjs` |
| Source interface (Stripe, CSV) | `node --test test/sources.test.mjs` |
| Google service account auth | `node --test test/google-auth.test.mjs` |
| BigQuery client and decoding | `node --test test/bigquery.test.mjs` |
| Warehouse row contract | `node --test test/warehouse.test.mjs` |
| Warehouse docs, examples, packaging | `node --test test/warehouse.test.mjs test/readme.test.mjs test/package.test.mjs && npm run lint` |
| Cross-source reconcile | `node --test test/cross-source.test.mjs test/warehouse-e2e.test.mjs` |
| Warehouse end to end, unlink identity | `node --test test/warehouse-e2e.test.mjs test/contract.test.mjs` |
| CLI, end to end, README, secrets | `node --test test/cli.test.mjs test/bin.test.mjs test/e2e.test.mjs test/readme.test.mjs test/token-leak.test.mjs && npm run gen:check` |
| Whole repo | `npm test && npm run lint && npm run gen:check` |

### Live-check gates (live findings and follow-ups)

| Item | Gate |
|---|---|
| Live 1: unrestricted coupon has no `applies_to` key | `node --test test/metrics.test.mjs test/stripe.test.mjs test/e2e.test.mjs && npm run gen:check` |
| Live 2: HubSpot 207 shape | `node --test test/hubspot.test.mjs test/sync.test.mjs` |
| Live 3 and F1: `GET /v1/account`, key advice | `node --test test/stripe.test.mjs test/readme.test.mjs` |
| Live 5 and 6: usage-linked deleted customer, recomputed MRRs | `node --test test/e2e.test.mjs` |
| F3: sync without `--mapping` after mapping links | `node --test test/e2e.test.mjs test/cli.test.mjs` |
| m11: guard refusal says what was not written | `node --test test/e2e.test.mjs` |
| m12: customer discount plus some bare subscriptions | `node --test test/metrics.test.mjs` |
| m13: Accounts v2 `customer_account` | `node --test test/model.test.mjs test/contract.test.mjs` |
| Spec and docs | `node --test test/spec.test.mjs test/readme.test.mjs test/generated.test.mjs && npm run gen:check && npm run lint` |

### BigQuery live-run follow-up gates

| Item | Gate |
|---|---|
| Live 7 to 12: BigQuery run recorded; README and demo wording | `node --test test/spec.test.mjs test/readme.test.mjs test/warehouse.test.mjs && npm run lint` |
| I-C: no-item refusal scoped to non-terminal statuses | `node --test test/warehouse.test.mjs` |
| m-A: a discount carries exactly one positive amount | `node --test test/warehouse.test.mjs` |
| m-B: a discount dropped by the user's SQL is disclosed | `node --test test/readme.test.mjs` |
| m-C: a 403 for token scope says token scope | `node --test test/bigquery.test.mjs` |
| m-D: the demo files say how they are tested and that they ran live | `node --test test/warehouse.test.mjs` |
| Live claims scoped to what ran; roles a recommendation; flow wording | `node --test test/spec.test.mjs test/readme.test.mjs test/warehouse.test.mjs && npm run lint` |
| A Drive or Sheets backed table is named, not sent to IAM | `node --test test/bigquery.test.mjs test/readme.test.mjs` |

### Pre-public review gates

| Item | Gate |
|---|---|
| I1: state folder line, no-history warning, README scope | `node --test test/e2e.test.mjs test/readme.test.mjs` |
| I2: refusal sends users to `plan --mapping` an empty file first | `node --test test/e2e.test.mjs test/readme.test.mjs` |
| I3: reconcile without `--mapping` after a mapped sync | `node --test test/e2e.test.mjs test/reconcile.test.mjs` |
| I4: unreadable Stripe account said up front; README copy | `node --test test/e2e.test.mjs test/readme.test.mjs` |
| m-a: `applies_to` `{}` and `{products: null}` flagged | `node --test test/metrics.test.mjs` |
| m-b, m-c: live re-run recorded; restricted key unverified everywhere | `node --test test/spec.test.mjs test/readme.test.mjs && npm run lint` |
| m-d: help and missing-key advice | `node --test test/cli.test.mjs` |
| m-e: refusal names survive an overwritten model.json | `node --test test/e2e.test.mjs test/sync.test.mjs` |
| m-f: corrupted synced.json | `node --test test/cli.test.mjs test/store.test.mjs` |
| m-i: seed Next line, empty portal, unknown mapping ids, reconcile under a guard refusal | `node --test test/cli.test.mjs test/e2e.test.mjs test/model.test.mjs test/reconcile.test.mjs` |
| Whole repo | `npm test && npm run lint && npm run gen:check` |

`npm run gen:check` exits non-zero when `docs/metrics.md` or the README metrics table is stale
against `src/definitions.mjs`; `test/generated.test.mjs` runs the same check inside `npm test`,
so a stale doc fails the suite. The README's reconcile example is compared with a real run by
`test/readme.test.mjs`.
