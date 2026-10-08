# The account model (version 1)

revenue-sync's product is not the sync. It is one local file, `<dir>/model.json`, that says for
every HubSpot company what billing and usage say about it, computed from one set of definitions,
plus every record that could not be placed and why. `plan`, `sync` and `reconcile` each build it fresh from Stripe, the usage file and HubSpot, and save it;
later tools (account health alerts, a QBR generator) should read it too, instead of calling
Stripe again.

This page is the contract. The machine-checkable form is `schema/account-model.v1.json` (JSON
Schema 2020-12), and a test validates real model output against it on every run. The metric
meanings live in `docs/metrics.md`, generated from `src/definitions.mjs`.

## Compatibility promise

- `schema` is always `revenue-sync.account-model` and `version` is an integer.
- Within one version, fields are only ever added in new optional places; nothing is renamed,
  removed or retyped. A reader that checks `version === 1` can rely on every field below.
- Any breaking change bumps `version` and ships a new schema file next to the old one.

## Top level

| Field | Type | Meaning |
|---|---|---|
| `schema` | string | Always `revenue-sync.account-model`. |
| `version` | integer | `1` for this contract. |
| `generated_at` | date-time | When the model was built (UTC). |
| `as_of` | `YYYY-MM-DD` | The date usage windows end on (`--as-of`, default today). |
| `sources` | object | What was read: `stripe` (`customers`, `subscriptions`, `open_invoices`), `usage` (`accounts`, and `provided`: false when no usage file was given, in which case the usage metrics are null and the HubSpot usage properties are left untouched), `hubspot` (`companies`), `mapping` (`provided`: whether a mapping file was given), and, added within version 1, `billing` (`source`: `stripe` or `bigquery`, which billing source ran; the `stripe` counts are that source's counts) and `usage.source` (`csv` or `bigquery`). Counts and flags, nothing else. |
| `accounts` | array | One record per HubSpot company that at least one Stripe customer or usage account resolved to, sorted by company name. |
| `unlinked` | array | Companies that hold revenue-sync values in HubSpot but that no Stripe customer or usage account resolves to any more (customer deleted, domain changed, mapping removed, now ambiguous). Each has `hubspot_company_id`, `hubspot_company_name`, a plain-words `reason`, `cleared` (true once its values are cleared and `rs_billing_status` reads `unlinked`), and `held` (null, or why this run leaves it untouched: it was linked by a mapping row or by usage and that source was not given, this state folder has no record of how it was linked, or the Stripe account is not the one recorded). `sync` clears them; `reconcile` fails while one still holds values. Added within version 1 as an optional field. |
| `unlink_guard` | object | Whether `sync` may unlink anything this run: `ok`, `linked` (companies currently holding live revenue-sync values), `would_unlink` (unlinked companies this run would clear), and `reason` (why it refuses, or why it proceeds anyway with `--allow-unlink`; null when nothing is unusual). `ok: false` means `sync` exits 5 and writes nothing. |
| `unmatched` | array | Stripe customers and usage accounts that resolved to no company, and Stripe subscriptions or open invoices with no customer id (Accounts v2 `customer_account`). Never written anywhere. |
| `ambiguous` | array | Records that resolved to more than one company. Refused, with the candidates. |
| `input_problems` | array | Rows of the usage or mapping CSV that were skipped: `file` (`usage` or `mapping`), `line`, `reason`. |

## An account

| Field | Type | Meaning |
|---|---|---|
| `hubspot_company_id` | string | The HubSpot record id. The key everything joins on. |
| `hubspot_company_name` | string | The company `name` property at the time of the run. |
| `domain` | string or null | The company's primary domain, normalised. |
| `stripe_customer_ids` | string[] | Every billing customer resolved to this company: Stripe customer ids, or the `customer_id` values of a warehouse billing source (the name is kept for version 1). A company may have several. |
| `usage_account_ids` | string[] | Every usage account resolved to this company. |
| `matched_by` | object | For each source id above, how it was placed: `domain` or `mapping`. |
| `metrics` | object | Every metric, keyed as below. `null` means "no value" (nothing to compute, or blocked). |
| `blocked` | string[] | Metric keys that were not computed because of a flag. These are never written to HubSpot and never reconciled. |
| `flags` | array | Why something was blocked: `code` (`mixed_currency`, `unsupported_price`, `unsupported_discount`, `unsupported_currency`, `tax_inclusive_price`, `truncated_items`) and a plain-words `detail`. |

### Metrics

Full definitions in `docs/metrics.md`.

| Key | Type | Notes |
|---|---|---|
| `mrr` | number or null | Major units of `currency` (dollars, not cents). |
| `arr` | number or null | `mrr` times 12, before rounding. |
| `currency` | string or null | Upper-case ISO code. |
| `outstanding_amount` | number or null | Major units of `currency`. |
| `plan` | string or null | Product names, biggest first, joined with ` + `. |
| `billing_status` | string | `unpaid`, `past_due`, `active`, `canceling`, `trialing`, `paused`, `canceled` or `none`. |
| `renewal_date` | string or null | `YYYY-MM-DD` (UTC). |
| `seat_count` | integer or null | Total quantity on live subscriptions. |
| `active_users_30d` | integer or null | `null` when no usage account is matched (not zero). |
| `usage_trend` | string or null | `up`, `down`, `flat`, `new` or `none`; `null` when no usage account is matched. |

## Refused records

Each entry in `unmatched` has `source` (`stripe` or `usage`), `source_id`, `label` (customer
name, else email, else id), `domain` (what it would have matched on, or null) and `reason` in
plain words. Each entry in `ambiguous` has the same fields plus `candidates`: every company it
could have been, as `id` and `name`. The fix for both is a row in the mapping file.

A Stripe subscription or open invoice that has no `customer` id (Stripe Accounts v2 bills an
account through `customer_account`) is listed in `unmatched` with `source` `stripe`, the
subscription or invoice id as `source_id`, `domain` null, and the `customer_account` in the
reason. This tool reads v1 customers only, so no mapping row can place it. The shape is from
Stripe's docs and has not been read from a live account.

## Reading it

```js
import { readFileSync } from 'node:fs';
const model = JSON.parse(readFileSync('.revenue-sync/model.json', 'utf8'));
if (model.schema !== 'revenue-sync.account-model' || model.version !== 1) throw new Error('unsupported model');
const atRisk = model.accounts.filter((a) => a.metrics.billing_status === 'past_due' || a.metrics.usage_trend === 'down');
```
