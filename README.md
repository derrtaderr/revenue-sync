# revenue-sync

Stripe billing and product usage, or your warehouse, written to the HubSpot company and reconciled against the source.

![A hand edit in HubSpot caught by reconcile, which names the company and both numbers, then synced back](docs/demo/revenue-sync.gif)

```bash
git clone https://github.com/derrtaderr/revenue-sync
cd revenue-sync
node scripts/demo.mjs
```

The demo needs no keys and runs the real CLI against stand-ins for Stripe and HubSpot. A real run needs a Stripe test key and a HubSpot token, set up in the five minute quickstart below.

Ask "is this account healthy, when does it renew, how much do they pay, are they using it" at a B2B SaaS company on HubSpot and Stripe, and the answer lives in three tabs: the Stripe dashboard, a product usage export, and the HubSpot company. The numbers in HubSpot were typed in at close and have drifted since. Nobody can tell which number is right, so every renewal call starts with an argument about the data.

revenue-sync puts billing and usage on the HubSpot company, computed from one definitions file, and then checks them. `reconcile` re-reads HubSpot and fails, naming every company and both numbers, whenever the CRM disagrees with what billing says. It runs on your machine with your own keys, needs no data warehouse (and reads BigQuery if you have one, checking the warehouse against Stripe), and has zero dependencies.

**v0.1, early.** Every Stripe and HubSpot call is tested against in-process fakes that reproduce the shapes in Stripe's and HubSpot's current API documentation (Stripe API version `2026-09-30.endive`, HubSpot CRM v3), corrected to what a real run returned. On 2026-10-07 the full quickstart (seed, plan, sync, reconcile, a hand edit caught and restored) was run against a real Stripe test-mode account with a full secret key and a real HubSpot test portal, and every MRR it wrote matched a recomputation from the raw Stripe data. On 2026-10-08 the BigQuery path was run the same way, against a real BigQuery project (see "Warehouse limitations"). It has not yet been run on live-mode Stripe data, or with a Stripe restricted key. Try it on a Stripe sandbox and a HubSpot test portal first. Please report problems in GitHub Issues, and when `reconcile` first exits 0 for you, post its line from `run.log` in GitHub Discussions; that is how we know it works beyond our tests.

## What a failed reconcile looks like

Someone edited Northwind's MRR and seat count by hand in HubSpot. This is the real output of `reconcile` on the seeded test data after that edit (exit code 3):

<!-- reconcile-output:start -->
```text
Read 11 Stripe customers, 12 subscriptions, 11 open invoices; 10 HubSpot companies; 9 usage accounts.
Matched 8 companies. Refused: 2 unmatched, 2 ambiguous. Flagged: 1.

State folder: /path/to/revenue-sync/.revenue-sync (last sync 2026-10-07T09:00:00.000Z).

2 values disagree across 1 company.

Northwind Analytics (HubSpot 100)
  MRR (rs_mrr): HubSpot says 1500, billing says 1300
  Seats (rs_seat_count): HubSpot says 30, billing says 25

Not checked: Stark Biotech (HubSpot 107) MRR, ARR, Outstanding amount: subscriptions and open invoices are in EUR and USD; amounts are not converted or summed
Refused, never written: stripe cus_... (Pied Piper): gmail.com is a free mail domain; add a mapping row
Refused, never written: usage acct_7731 (acct_7731): no domain to match on and no mapping row
Refused, never written: stripe cus_... (Massive Dynamic): matches Massive Dynamic (108) and Massive Dynamic (old record) (109); add a mapping row
Refused, never written: usage massive (massive): matches Massive Dynamic (108) and Massive Dynamic (old record) (109); add a mapping row

Reconcile failed. Run plan to see the writes that would fix this, then sync.
```
<!-- reconcile-output:end -->

`plan` then shows `rs_mrr: 1500 → 1300 (edited in HubSpot since the last sync)`, and `sync` puts it back.

## Five minute quickstart

You need Node 20.6 or newer (for `--env-file`), a Stripe account, and a HubSpot portal where you may create a private app or service key. Use a Stripe **sandbox** and, ideally, a HubSpot **test or developer portal**: `seed --hubspot` creates ten fictional companies there.

1. **Clone it** with the first two lines of the block at the top. There is nothing to install.
2. **Get a Stripe test key.** In the Stripe dashboard, open your sandbox, then Developers, then API keys, and copy the secret key (it starts `sk_test_`). `seed` refuses any key that does not start `sk_test_` or `rk_test_`.
3. **Get a HubSpot token.** Settings, then Development (or Integrations), then create a service key or private app with these four scopes: `crm.objects.companies.read`, `crm.objects.companies.write`, `crm.schemas.companies.read`, `crm.schemas.companies.write`. Copy the token (it starts `pat-`).
4. **Put both in a `.env` file** in the repo folder. `.env` is gitignored. Replace each placeholder with your real value; as shown, the tool rejects them on purpose.
   ```bash
   STRIPE_API_KEY=paste your sk_test key here
   HUBSPOT_TOKEN=paste your pat token here
   ```
5. **Seed, plan, sync, reconcile.**
   ```bash
   node --env-file=.env bin/revenue-sync.mjs seed --hubspot
   node --env-file=.env bin/revenue-sync.mjs plan --usage usage.csv
   node --env-file=.env bin/revenue-sync.mjs sync --usage usage.csv
   node --env-file=.env bin/revenue-sync.mjs reconcile --usage usage.csv
   ```
   `seed` creates eleven test customers (annual and monthly plans, per-seat quantities, a percent and an amount discount, a trial, a cancellation, two subscriptions on one customer, a customer billed in EUR, a customer on a gmail address) and writes `usage.csv`. `plan` prints every write and changes nothing. `sync` creates the properties and writes. `reconcile` exits 0 when every value it checked agrees. On the seeded data it says `Checked values agree` and lists what it did not check (the deliberate refusals below); it only says `HubSpot agrees with billing and usage` when nothing was left unchecked. Run `sync` again and it writes nothing.

   The seeded data includes records that are refused on purpose (the gmail customer, the two "Massive Dynamic" companies sharing one domain, the EUR plus USD company), so you can see what a refusal looks like. `reconcile --strict` fails on them; plain `reconcile` lists them and passes.

## Using it on your own data

- **Stripe key.** In test mode, use the full secret key (`sk_test_`); that is what was verified. Automatic unlinking (clearing a company whose customer is gone) needs the key to read `GET /v1/account`, so the tool can tell a deleted customer from a different Stripe account; the full secret key can. A restricted key has not been run against Stripe at all, so it is unverified for every endpoint: by Stripe's docs, read access to Customers, Subscriptions, Invoices, Products and Coupons (Developers, API keys, Create restricted key) should cover the lists `plan`, `sync` and `reconcile` read, and whether it can read `GET /v1/account`, and which permission grants it, is unknown. If it cannot, every unlink is held: a customer that churned (deleted in Stripe) keeps its last MRR and other values on its HubSpot company, listed as `Held, not unlinked`, and plain `reconcile` still exits 0 on it (`--strict` fails). `plan`, `sync` and `reconcile` say so on every run, and you clear real churn with `sync --allow-unlink`. Use a live key only once you trust the test run.
- **Usage CSV** (`--usage FILE`): one row per user activity, with columns `account_id,user_id,date` and optionally `domain`. `date` is `YYYY-MM-DD` or an ISO timestamp. A login log, an events export or a daily-active table all fit. From Postgres, for example:
  ```bash
  psql "$DATABASE_URL" -c "\copy (select account_id, user_id, event_date as date, account_domain as domain from activity where event_date > now() - interval '60 days') to 'usage.csv' csv header"
  ```
  Without a usage source (`--usage`, or `--usage-sql` from a warehouse), the two usage properties are left exactly as they are in HubSpot (not written, not cleared, not compared), and `reconcile` says usage was not checked.
- **Mapping CSV** (`--mapping FILE`): `source,source_id,hubspot_company_id`, where `source` is `stripe` (a Stripe customer id) or `usage` (a usage `account_id`). A mapping row always wins over domain matching. It is how you place a customer billed at a free mail address, settle two companies on one domain, or override a wrong match. Once a sync has used a mapping file, `sync` refuses (exit 1, before fetching anything) to run without one, because a company linked by both a domain and a mapping row would otherwise quietly lose the mapped revenue. To stop using the file, first run `plan --mapping` with an empty file (just the header line) to see what that clears, then run `sync` with the same empty file.
- **State folder** (`--dir DIR`, default `./.revenue-sync`): `model.json` (the account model), `synced.json` (what the last sync wrote), `journal.jsonl` (the sync journal) and `run.log` (one line per run: the command, its exit code, and `data=seed`, `real` or `mixed` for what the Stripe account held; on a warehouse run also `billing=bigquery`, `data=demo` for the bundled demo query, and on `reconcile` `cross=pass`, `fail` or `skipped`). Nothing is sent anywhere except Stripe and HubSpot. New folders are created 0700 and new files 0600, because they hold billing data; a folder that already exists keeps its permissions. The state folder must persist between runs: it is the only record of how each company was linked. On a CI runner or in a container that starts empty, keep it on a mounted volume or cache it between runs; a run in a fresh folder knows nothing of past syncs, so a company whose Stripe customer was deleted is held with its old values instead of cleared, and `sync` without `--mapping` refuses on a portal that already holds values.
- **As-of date** (`--as-of YYYY-MM-DD`, default today in UTC): the day the 30-day usage windows end.
- **Schedule it.** Run `sync` then `reconcile` nightly from cron with absolute paths (`which node` gives the node path), passing an absolute `--dir` (cron starts in your home folder, so the default `./.revenue-sync` would be a different, empty state folder) and the same absolute `--usage` and `--mapping` files every time, refreshed before the run. Exit code 3 from `reconcile` is the alert, and exit 5 from `sync` means it refused to unlink (below). Within one state folder, forgetting a flag cannot clear anything: a `sync` without the `--mapping` file the last sync used refuses with exit 1, and a company linked by usage is held on a run without a usage source, `--usage` or `--usage-sql` (usage never feeds a money value, so nothing else changes). That protection is the state folder's record, so a `sync` from a folder with no record, on a portal that already holds revenue-sync values, without `--mapping`, refuses with exit 1 before writing anything, and `plan` and `reconcile` warn. If you really have no mapping file, run `plan --mapping` with an empty file (just the header line) first, then `sync` with it; with no record in the folder it clears nothing. `plan`, `sync` and `reconcile` print the state folder they use.
- **Unlink guard.** A company that stops resolving is cleared and marked `unlinked`, but only when the run could have seen its link: same Stripe account as the last sync (read from `GET /v1/account`; a restricted key that may not read the account holds every unlink), the source that linked it was given, and the state folder knows how it was linked. Otherwise it is held and listed. `sync` refuses (exit 5, nothing written) when Stripe returns no customers while companies are linked, or when more than 2 companies and more than 10 percent of linked companies would be unlinked in one run; `plan` shows the verdict first. Pass `--allow-unlink` when the companies really are gone or the Stripe account really changed.

## Using a warehouse

If billing and product usage already live in BigQuery, revenue-sync can read them there instead of from Stripe and a CSV. You write the SQL; its output columns are a contract (`docs/warehouse.md`) that every row is checked against. The rows become the same records the Stripe path produces, so matching, the metric definitions, `plan`, `sync`, `reconcile`, the journal and the unlink guard all work exactly as above, including every refusal.

```bash
node --env-file=.env bin/revenue-sync.mjs plan --billing-sql billing.sql --usage-sql usage.sql
node --env-file=.env bin/revenue-sync.mjs sync --billing-sql billing.sql --usage-sql usage.sql
node --env-file=.env bin/revenue-sync.mjs reconcile --billing-sql billing.sql --usage-sql usage.sql
```

- `--billing-sql FILE` reads billing from your query instead of Stripe; `STRIPE_API_KEY` is then not needed for `plan` and `sync`.
- `--usage-sql FILE` reads usage from your query (`account_id, user_id, date[, domain]`) instead of `--usage FILE`. Use one or the other.
- `--bigquery-project ID` defaults to the `project_id` in the service account key. `--bigquery-location LOC` sets the job location (`US`, `EU` or a region) when your datasets need it.
- Credentials come from the environment only: `GOOGLE_APPLICATION_CREDENTIALS` (the path to a service account key JSON file) or `GOOGLE_SERVICE_ACCOUNT_JSON` (the JSON itself). The key and the access token are never printed or logged.
- The service account needs two roles: **BigQuery Job User** on the project (to run the query) and **BigQuery Data Viewer** on the datasets the SQL reads. The token asks only for the `cloud-platform.read-only` scope, and every query is checked first with a dry run: anything that is not a `SELECT` (an `INSERT`, a `DELETE`, a `CREATE TABLE`, a multi-statement script) is refused before it runs.
- Do not reuse the key you made for Stripe Data Pipeline. Stripe's setup gives that service account **BigQuery Data Editor** (and Job User) so Stripe can load data, which means it can also change or delete the `stripe` datasets. Make a separate service account with only the two read roles above.

**The cross-source check.** Keep `STRIPE_API_KEY` set as well and `reconcile` also reads Stripe and compares MRR per company between the warehouse and Stripe, separately from the HubSpot comparison. Every company where they differ is named with both numbers (`Northwind Analytics (HubSpot 100): warehouse says 1560 USD, Stripe says 1300 USD`) and `reconcile` fails with exit 3. A company flagged on either side is listed as not compared, and the verdict says how many of the companies were compared (`agree on MRR: 7 of 8 companies compared`); a run where every company is flagged compared nothing and fails rather than reading as agreement. The usual cause of a disagreement is a warehouse load behind Stripe (Stripe Data Pipeline loads every 3 hours); a persistent one means the billing SQL reads something Stripe does not.

**Stripe Data Pipeline.** `examples/bigquery/stripe-data-pipeline-billing.sql` maps Data Pipeline's BigQuery tables (`stripe` and `stripe_testmode` datasets) onto the contract. Each column it reads is marked as documented by Stripe or unverified; check the unverified ones in Stripe's schema browser before the first run. Every join is a LEFT JOIN and every table is filtered by `merchant_id`, so a missing price, discount or coupon row stops the run instead of quietly changing the number. It cannot read a coupon's product restriction (no documented column), so a company with a coupon is flagged rather than given a guessed MRR, as on the Stripe path. `examples/bigquery/product-usage.sql` is a starting point for usage from your own events table.

### BigQuery sandbox quickstart (free, no credit card)

1. Open the BigQuery console and create a project; the BigQuery sandbox lets you use it with no credit card and no billing account (10 GB storage, 1 TB of queries a month).
2. In IAM and Admin, Service Accounts, create a service account, grant it **BigQuery Job User** and **BigQuery Data Viewer** on the project, and create a JSON key. Save it outside the repo.
3. Add `GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json` to `.env`.
4. Run the demo queries, which select literal rows (no tables, so nothing to load and no cost):
   ```bash
   node --env-file=.env bin/revenue-sync.mjs plan --billing-sql examples/bigquery/demo-billing.sql --usage-sql examples/bigquery/demo-usage.sql
   ```
   The demo mirrors the seeded companies with dates relative to the day it runs. Within 14 days of the Stripe quickstart's `seed --hubspot` (while seed's Hooli trial is still a trial), `sync` and then `reconcile` (with `STRIPE_API_KEY` still set) should show the cross-source check passing. On 2026-10-08 the demo was run on BigQuery against a seeded Stripe test account and a HubSpot test portal: both queries compiled, `plan` matched 8 companies, `sync` wrote 70 values and a second `sync` wrote nothing, every MRR matched a recomputation from the raw Stripe data, and the cross-source check failed on exactly one company, the one whose Stripe customer had been deleted on purpose beforehand, which it named (warehouse 2000, Stripe 0, exit 3). The test suite checks the same flow against the seeded fakes. Change Northwind's quantity in `examples/bigquery/demo-billing.sql` from 25 to 30 and `reconcile` fails naming Northwind with both numbers.

### Warehouse limitations

- Verified live on 2026-10-08, with a dedicated service account created for the run, using the `cloud-platform.read-only` token scope (the two roles above are the recommendation; the roles that account was granted were not checked): the token exchange, the `cloud-platform.read-only` scope running query jobs, the dry run reporting `statementType` before a `SELECT` runs, real result encodings decoding cleanly for the demo's column types, the demo queries, and `plan`, `sync` and `reconcile` including the cross-source check (see the sandbox quickstart). Every request and response shape is also tested against an in-process fake that reproduces what the API leaves out (no `rows` on an empty result, incomplete jobs, multi-page results).
- The Stripe Data Pipeline example has not been run: a Data Pipeline share is a paid Stripe feature. Its `[unverified]` column names stay unverified, and so does whether Data Pipeline keeps the items of a canceled subscription. Either way is safe: a `canceled` or `incomplete_expired` subscription with no item rows is read and adds nothing but billing status `canceled`, while a missing item on any subscription that can still bill stops the run.
- BigQuery only. Snowflake (SQL API v2 with key-pair auth) is the next source, behind the same contract.
- A query error is shown with Google's message so you can fix the SQL. A contract mistake (a missing column, a FLOAT64 amount, a NULL an item needs) stops the run with exit 1 naming the file, the row and the column, before anything is written.
- A table backed by Google Drive or Sheets (an external table over a spreadsheet) is not supported: reading it needs a Drive scope revenue-sync never requests, and BigQuery answers `accessDenied` ("getting Drive credentials"), which no IAM role fixes. revenue-sync says so instead of pointing at the roles. Copy the data into a native BigQuery table and query that.
- Editing the billing SQL changes its identity for the unlink guard, so the first `sync` after an edit holds any unlink until `--allow-unlink`.
- A `unit_amount` in dollars instead of cents (6500 written as 65) is a valid number to every row check, so the MRR comes out 100 times too small; only the cross-source check can catch it, by disagreeing with Stripe. `sync` does not run the cross-source check, so run `reconcile` with `STRIPE_API_KEY` set before the first `sync` from a new query, and after every query edit.
- A discount row your own SQL drops (an inner join from subscriptions to discounts or coupons that loses a row) leaves a valid result with one discount fewer, so no row check can see it, and the MRR comes out undiscounted, too high; only the cross-source check can catch it, by disagreeing with Stripe. Use LEFT JOINs, as the Data Pipeline example does, so a missing discount or coupon arrives as a NULL the contract refuses.
- A partial or stale load (a customer missing from the warehouse while Stripe still bills it) is invisible to the query. A company still linked by usage then gets MRR 0 and billing status `none` written, the same as a deleted Stripe customer on the Stripe path; a company linked only by billing goes through the unlink guard. The cross-source check names it (`warehouse has no record, Stripe says ...`), which is why `reconcile` with `STRIPE_API_KEY` belongs in the same nightly job as `sync`.

## Commands

| Command | What it does |
|---|---|
| `seed [--usage-out FILE] [--hubspot]` | Builds the Stripe test dataset and writes the usage CSV (default `usage.csv`). Refuses any key that is not `sk_test_` or `rk_test_`, before any request. `--hubspot` also creates the seed companies whose domain is not already in HubSpot. Safe to re-run: it notices the data is there. |
| `plan [--usage FILE] [--mapping FILE] [--dir DIR] [--as-of DATE]` | Reads everything, saves the account model, and prints every HubSpot write as company, property, old → new, plus any property it would create. Writes nothing to HubSpot. |
| `sync` (same options as `plan`, plus `--allow-unlink`) | Creates any missing properties, then writes the plan in batches of up to 100 companies. Retries rate limits and server errors with backoff. Journaled: an interrupted run resumes on the next `sync` without writing anything twice. Holds `<dir>/sync.lock` while it runs, so two syncs on one state folder cannot overlap. |
| `reconcile` (same options, plus `--strict`) | Re-reads HubSpot and compares every property with billing and usage. Exits 3 naming every disagreement with both values. `--strict` also fails on unmatched, ambiguous, flagged or skipped records. |
| `help` | Shows usage. |

Keys come only from the environment (`STRIPE_API_KEY`, `HUBSPOT_TOKEN`), never from a flag, so they stay out of shell history. They are never printed, logged or written to the state folder.

## How a record finds its company

1. **A mapping row**, if there is one, wins.
2. Otherwise the **domain**: for a Stripe customer, `metadata.domain` if set, else the domain of its email; for a usage account, its `domain` column. It is matched against the HubSpot company `domain` and `hs_additional_domains`, after lower-casing and stripping `www.`, protocol and path. Subdomains are not folded: `eu.northwind.com` does not match `northwind.com`.
3. Otherwise it is **unmatched**.

Several Stripe customers (or usage accounts) on one company are added together.

A company stays linked while any record still resolves to it. If its Stripe customer is deleted but its usage account still matches, it keeps the link with `rs_billing_status` `none` and MRR `0` (seen on a live run); it is only unlinked when nothing resolves to it any more.

## What it refuses, and why

| Situation | What happens | Why |
|---|---|---|
| No company has the domain | Unmatched: listed, never written | A guessed match puts one customer's revenue on another company. |
| The customer's email is gmail.com, outlook.com and the like | Unmatched, even if some company has that domain | A free mail domain says nothing about the company. Add a mapping row. |
| A company that was synced stops resolving (customer deleted, domain changed, mapping row removed, now ambiguous) | Unlinked: `reconcile` fails while it still holds values; `sync` clears them and sets `rs_billing_status` to `unlinked` | An old MRR left on a company reads as current. |
| Two companies share the domain | Ambiguous: refused, both companies named | Picking one is a guess. Add a mapping row, or merge the duplicates. |
| The mapping file sends one id to two companies | Ambiguous: refused, both named | The file contradicts itself. |
| A company is billed in two currencies | MRR, ARR and outstanding amount flagged and not written | Summing EUR and USD gives a number that is true in no currency. |
| A metered or tiered price, a discount on a single item, or a customer-level discount that some of its subscriptions do not show | Money values flagged and not written | The monthly amount cannot be known in advance from the price alone. |
| A tax-inclusive price | Money values flagged and not written | MRR is pre-tax, and the tax inside an inclusive price is set on tax settings, not on the price. |
| Billing in UGX or ISK | Money values flagged and not written | Stripe documents these both as zero-decimal and as two-decimal amounts; a wrong guess is off by a factor of 100. |
| `seed` with a key that is not `sk_test_` or `rk_test_` | Refused before any request | Seeding creates customers and subscriptions. |

Flagged values are never cleared in HubSpot: the last good value stays, and `reconcile` lists the company as not checked rather than passing it silently.

## Metric definitions

Every number comes from one file, `src/definitions.mjs`, where each metric's plain-words meaning sits next to the code that computes it. This table and `docs/metrics.md` are generated from that file, and a test fails if they drift.

<!-- metrics:start -->
| Property | Metric | Definition |
|---|---|---|
| `rs_mrr` | MRR | Monthly recurring revenue. For every active or past_due subscription on any Stripe customer matched to the company: each item's unit price times its billed quantity (for a per-pack price with transform_quantity, the quantity divided into packs and rounded the way the price says), converted to a month (a yearly price divided by 12, every 3 months divided by 3, weekly times 52 over 12, daily times 365 over 12), then reduced by subscription-level discounts that recur (percent-off first, then amount-off spread over the billing interval, never below zero). A coupon limited to some products (Stripe's applies_to) only reduces those products, and an amount-off never takes more than they are worth; when a coupon's product limits cannot be read, money values are flagged instead. Once-only and ended discounts are ignored. Trialing, canceled, unpaid, paused and incomplete subscriptions, and active ones with collection paused (pause_collection), count as zero. Pre-tax: exclusive and unspecified prices are taken as they are, and a tax-inclusive price is flagged because the tax inside it cannot be read from the price. Left unwritten, and flagged, when the company is billed in more than one currency, in UGX or ISK, or has a metered, tiered, item-discounted or tax-inclusive price, or a customer-level discount that any of its subscriptions does not show, or a subscription whose item list Stripe truncated. |
| `rs_arr` | ARR | Annual recurring revenue: MRR times 12, computed before MRR is rounded, so an annual plan reads back as its exact yearly price. Flagged and left unwritten in the same cases as MRR. |
| `rs_billing_currency` | Billing currency | The ISO currency code (USD, EUR) that MRR, ARR and the outstanding amount are in: the one currency of the company's active and past_due subscriptions and open invoices. Empty when there are none, and empty and flagged when there is more than one. |
| `rs_outstanding_amount` | Outstanding amount | What the company still owes: the sum of amount_remaining on every open Stripe invoice of its matched customers, in the billing currency. Draft, paid, void and uncollectible invoices are not counted. Flagged and left unwritten when the open invoices are in another currency. |
| `rs_plan` | Plan | The names of the Stripe products on the company's live subscriptions (active, past_due or trialing), biggest monthly amount first, joined with a plus sign. Falls back to the price nickname, then the price id, when the product has no name. Empty when nothing is live. |
| `rs_billing_status` | Billing status | One word for the company's billing state, the state that most needs attention winning: unpaid, then past_due, then active, then canceling (every active subscription is set to cancel), then trialing, then paused (including an active subscription with collection paused), then canceled. none when Stripe has no subscription for the company. sync writes unlinked (and clears every other revenue-sync value) on a company that held values but that no Stripe customer or usage account resolves to any more. |
| `rs_renewal_date` | Renewal date | The next date money is due to renew: the earliest current period end on a live subscription (active, past_due or trialing) that is not set to cancel. For a trial that is the date it converts. Empty when every live subscription is set to cancel, or nothing is live. |
| `rs_seat_count` | Seats | The total quantity across every item of the company's live subscriptions (active, past_due or trialing). For per-seat pricing that is the seats paid for; a flat item with quantity 1 adds one. |
| `rs_active_users_30d` | Active users (30 days) | Distinct user_id values in the usage CSV for the company's matched usage accounts, active on any day in the 30 days ending on the as-of date (the as-of date included). Empty, not zero, when no usage account is matched to the company. |
| `rs_usage_trend` | Usage trend | Distinct active users in the last 30 days compared with the 30 days before that: up when it rose by 10 percent or more, down when it fell by 10 percent or more, flat in between, new when there were no users before and some now, none when there were none in either window. Empty when no usage account is matched. |
<!-- metrics:end -->

## What it writes to HubSpot

Only the ten properties above, on company records, in the property group `revenue_sync` ("Revenue sync"). Every name starts with `rs_`, so they cannot collide with a property your portal already has. `sync` creates them if they are missing; `plan` never does. It never creates, merges or deletes a company (outside `seed --hubspot`), and never touches any other property.

## The account model

The product is the account model, not the sync. Every run saves `<dir>/model.json`: one record per HubSpot company with its Stripe customers, usage accounts, every metric, and every record that was refused and why. It is a versioned contract, documented in `docs/account-model.md` with a JSON Schema in `schema/account-model.v1.json`, so other tools (health alerts, a QBR generator) can read it instead of calling Stripe again.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Done. For `reconcile`, every value it checked agrees; anything it could not check is listed, and the verdict line says so. |
| 1 | A usage or setup problem found before anything was written (missing key, bad CSV, unknown option, a `sync` without the `--mapping` file the last sync used, a `sync` without `--mapping` from a state folder with no record on a portal that already holds values), or an unexpected error. |
| 2 | Stripe or HubSpot returned an error or could not be reached. Nothing more was written; an interrupted `sync` resumes next time, re-reading each pending batch and dropping companies that were deleted or merged meanwhile. If HubSpot refuses the same batch twice, the message says so: delete `<dir>/journal.jsonl` (the state folder's journal) to abandon that run, and the next `sync` plans again from live values (safe, since every write sets an absolute value). |
| 3 | `reconcile` found a disagreement (or, with `--strict`, a refused, flagged or skipped record), or HubSpot rejected some of the writes in a `sync`. |
| 4 | A local file could not be written after work began. |
| 5 | `sync` refused to unlink: Stripe returned no customers while companies are linked, or too many companies would be unlinked at once. Nothing was written, not even the other updates in that run (they came from the same suspect inputs); the message counts what was held back. Re-run with `--allow-unlink` if that is real. |

## Limitations

- Run once against a Stripe test-mode account and a HubSpot test portal (2026-10-07), and with BigQuery as the billing and usage source (2026-10-08); not yet on live-mode Stripe data or with a restricted key. All API behaviour is tested against fakes built from the official docs and corrected to the shapes that run returned.
- Billing from Stripe or from BigQuery (see "Using a warehouse"). No direct Chargebee, Recurly or Paddle client, and no CRM other than HubSpot.
- Usage comes from a CSV. A direct Postgres source is not built, because a Postgres client would be this tool's first dependency; the `psql \copy` line above produces the same file.
- No currency conversion. Mixed-currency companies are flagged, not summed.
- Metered and tiered prices and item-level discounts are flagged rather than priced.
- `past_due` and `unpaid` cannot be created by `seed` (Stripe only reaches them after a failed payment over time). They are covered by the unit tests, not the seeded data.
- Matching is exact on domain; subdomains and company renames need a mapping row.
- Stripe Accounts v2 customers (`customer_account` on a subscription or invoice, with no v1 customer) are not read: such a subscription is listed as unmatched rather than counted. Untested against a live account.
- Item-level trial offers are not read: an active subscription with one trialing item counts in full, where Stripe's own MRR leaves that item out.
- Unapplied customer credit (a negative Stripe customer balance) is not subtracted from the outstanding amount.
- Tax-inclusive prices, and UGX or ISK billing, are flagged rather than priced.
- HubSpot companies are read with the list endpoint, one page of 100 at a time. A portal with tens of thousands of companies works but is slow.

## How it compares

HubSpot's own Stripe Data Sync app syncs Stripe customers to contacts (matched on email) and subscriptions into custom objects, which need an Enterprise tier; we found no documentation of a company-level MRR or of any disagreement check. Hightouch and Census (now part of Fivetran) are reverse ETL from a warehouse, so Stripe data has to reach a warehouse first. revenue-sync is the path for a team with no warehouse that wants company-level numbers and a check that fails, and for a team with BigQuery it adds what reverse ETL does not: a check that the warehouse agrees with Stripe.

## Development

```bash
npm test          # node --test, no dependencies
npm run lint      # syntax, no em dashes in this README, no dependencies, no secret-shaped strings
npm run gen       # regenerate docs/metrics.md and the metrics table above
```

The design notes and the per-area test gates are in `docs/SPEC.md`.

MIT licensed.
