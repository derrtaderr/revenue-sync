# The warehouse row contract

`--billing-sql FILE` and `--usage-sql FILE` read billing and usage from BigQuery with SQL you
write and own. This page is the contract for what those queries must **output**. revenue-sync
checks every column and every row against it before anything is computed, and stops (exit 1,
nothing written) naming the file, the row and the column when a row breaks it.

The rows become exactly the records the Stripe API source produces, so every rule in
`docs/metrics.md` applies unchanged, including the ones that refuse to write a number rather
than write a wrong one.

## Billing: one result set, one row per object

Each row says what it is in `record`, and carries every column below (a column a record does not
use is NULL). Use `UNION ALL` of one `SELECT` per record kind; `examples/bigquery/` has two
complete queries.

| Record kind | One row per | Links to |
|---|---|---|
| `customer` | billing customer | |
| `subscription` | subscription | `customer_id` |
| `item` | subscription item (a price and a quantity) | `subscription_id` |
| `discount` | coupon applied to a whole subscription | `subscription_id` |
| `open_invoice` | open invoice with money still owed | `customer_id` |

Rules every row is checked against:

- **Amounts are integers in the currency's minor unit**, as in the Stripe API: 6500 is $65.00,
  12345 in KWD is 12.345. Money columns are NUMERIC, BIGNUMERIC or INT64. FLOAT64 is refused,
  because a float cannot carry an exact amount. `amount_off` and `amount_remaining` must be whole
  numbers (19.99 is refused: it is almost always dollars where cents were meant). `unit_amount`
  may carry decimals, as Stripe's `unit_amount_decimal` does.
- **Timestamps** are TIMESTAMP. Dates come out in UTC.
- **Ids** are STRING or INT64 and must be unique per record kind: `customer_id` on customer rows, `subscription_id` on subscription rows, `item_id`, `discount_id` and `invoice_id`. A join that repeats a row (a discount joined twice, an item fanned out by a price history table) is refused, never counted twice. A subscription must name a
  customer row, an item or discount a subscription row, an open invoice a customer row.
- **Enumerated columns** accept the listed values in any case.
- A NULL in a column a record needs, a missing column, or a wrong type stops the run. The boolean flags (`customer_discount`, `cancel_at_period_end`, `collection_paused`, `item_discounted`) are needed on their rows: a NULL there is not read as FALSE. The table says what NULL means for every column a row may leave NULL.
- **Values Stripe cannot produce stop the run too:** a `quantity` that is fractional or negative, an
  `interval_count` or `transform_divide_by` below 1, a `percent_off` that is not more than 0 and at
  most 100, a discount row without exactly one of `percent_off` and `amount_off` (neither, both, or
  an `amount_off` of 0), a negative `unit_amount`, `amount_off` or `amount_remaining`, and a subscription with no
  item rows (Stripe subscriptions always have one, so a missing item is a join or load gap, never
  MRR 0). The one exception is a `canceled` or `incomplete_expired` subscription: it can never
  bill again and no value reads its items, so it may arrive with none and counts only toward
  billing status `canceled`.

| Column | Types | Needed by | Meaning |
|---|---|---|---|
| `record` | STRING | every row | `customer`, `subscription`, `item`, `discount`, `open_invoice`. Which kind of row this is. |
| `customer_id` | STRING, INT64 | customer, subscription, open_invoice | The billing customer id (Stripe cus_ id when the data comes from Stripe). A mapping row with source stripe places it. NULL on other rows. |
| `customer_name` | STRING | none | Shown in refusals. NULL: refusals show the email or the id instead. |
| `customer_email` | STRING | none | Its domain is matched when customer_domain is NULL. NULL: there is no email domain to match on. |
| `customer_domain` | STRING | none | Matched against the HubSpot company domain first (Stripe metadata.domain). NULL: the email domain is matched. |
| `customer_discount` | BOOL | customer | TRUE when the customer has a customer-level discount; flags money values when a subscription does not show its own. NULL on other rows. |
| `subscription_id` | STRING, INT64 | subscription, item, discount | The subscription the row belongs to. NULL on other rows. |
| `status` | STRING | subscription | `active`, `past_due`, `unpaid`, `canceled`, `incomplete`, `incomplete_expired`, `trialing`, `paused`. Stripe subscription status. NULL on other rows. |
| `currency` | STRING | subscription, open_invoice | ISO code, any case: the subscription currency, the invoice currency, or an amount-off coupon currency. NULL on a discount is fine for percent-off; an amount-off coupon with NULL currency is flagged. NULL on other rows. |
| `cancel_at_period_end` | BOOL | subscription | TRUE when set to cancel at period end. NULL on other rows. |
| `cancel_at` | TIMESTAMP | none | When it is set to cancel, if it is. NULL: not set to cancel on a date. |
| `collection_paused` | BOOL | subscription | TRUE when payment collection is paused (Stripe pause_collection); counts as zero MRR. NULL on other rows. |
| `item_id` | STRING, INT64 | item | The subscription item id. NULL on other rows. |
| `price_id` | STRING, INT64 | item | The price id. NULL on other rows. |
| `product_id` | STRING, INT64 | item | The product id (coupons restrict by it). NULL on other rows. |
| `product_name` | STRING | none | The plan name; falls back to price_nickname, then price_id. NULL: price_nickname, then price_id, names the plan. |
| `price_nickname` | STRING | none | The price nickname. NULL: no nickname. |
| `unit_amount` | NUMERIC, BIGNUMERIC, INT64 | none | Per-unit price in minor units; NULL for a tiered or custom price (flagged). |
| `billing_interval` | STRING | item | `day`, `week`, `month`, `year`. Billing interval. NULL on other rows. |
| `interval_count` | INT64, NUMERIC | item | Intervals between bills (3 for quarterly). NULL on other rows. |
| `usage_type` | STRING | item | `licensed`, `metered`. metered is flagged. NULL on other rows. |
| `billing_scheme` | STRING | item | `per_unit`, `tiered`. tiered is flagged. NULL on other rows. |
| `tax_behavior` | STRING | item | `exclusive`, `inclusive`, `unspecified`. inclusive is flagged. NULL on other rows. |
| `transform_divide_by` | INT64, NUMERIC | none | Per-pack pricing (Stripe transform_quantity.divide_by). NULL: priced per unit, not per pack. |
| `transform_round` | STRING | none | `up`, `down`. How packs round; needed with transform_divide_by. NULL unless transform_divide_by is set. |
| `quantity` | INT64, NUMERIC | item | Quantity (seats). NULL on other rows. |
| `current_period_end` | TIMESTAMP | item | The item's current period end (renewal date). NULL on other rows. |
| `item_discounted` | BOOL | item | TRUE when the item carries its own discount; flagged. NULL on other rows. |
| `discount_id` | STRING, INT64 | discount | The discount id (Stripe di_), unique: a discount row repeated by a join is refused, never applied twice. NULL on other rows. |
| `coupon_id` | STRING, INT64 | discount | The coupon id. NULL on other rows. |
| `percent_off` | NUMERIC, BIGNUMERIC, INT64, FLOAT64 | none | Percent off, or NULL. NULL: not a percent-off coupon. |
| `amount_off` | NUMERIC, BIGNUMERIC, INT64 | none | Amount off per invoice in minor units, or NULL. NULL: not an amount-off coupon. |
| `duration` | STRING | discount | `forever`, `once`, `repeating`. Coupon duration. NULL on other rows. |
| `discount_end` | TIMESTAMP | none | When a repeating discount ends. NULL: the discount does not end; a repeating discount must have one. |
| `applies_to` | STRING | none | Product restriction: NULL means not read (money values flagged), empty means unrestricted, else comma-separated product ids. |
| `invoice_id` | STRING, INT64 | open_invoice | An open invoice id. NULL on other rows. |
| `amount_remaining` | NUMERIC, BIGNUMERIC, INT64 | open_invoice | What is still owed on the open invoice, in minor units. NULL on other rows. |

### What a NULL or a flag does, and why

- `unit_amount` NULL, `billing_scheme` tiered, or `usage_type` metered: the company's money values
  are flagged `unsupported_price` and not written (the monthly amount cannot be known in advance).
- `tax_behavior` inclusive: flagged `tax_inclusive_price` (MRR is pre-tax).
- `item_discounted` TRUE, or `customer_discount` TRUE while a subscription has no discount row:
  flagged `unsupported_discount`.
- `applies_to` NULL on a discount: the coupon's product restriction was not read, so the company is
  flagged `unsupported_discount`, the same as a Stripe coupon whose restriction cannot be read.
  Emit `''` for an unrestricted coupon, or `'prod_a,prod_b'` for a restricted one.
- UGX or ISK, or more than one currency on one company: flagged, never guessed or summed.

## Usage: one row per user activity

The same columns as the usage CSV. A row with a NULL `account_id` or `user_id`, or a date that
cannot be read, is skipped and reported as `Skipped usage query row N`, as a bad CSV line is.

| Column | Types | Required | Meaning |
|---|---|---|---|
| `account_id` | STRING, INT64 | yes | The product account. |
| `user_id` | STRING, INT64 | yes | The user who was active. |
| `date` | DATE, TIMESTAMP, DATETIME, STRING | yes | The day of the activity (UTC for a TIMESTAMP). |
| `domain` | STRING | no | Optional: the account's domain, matched against HubSpot. |

## Matching and the mapping file

A billing customer is matched exactly as a Stripe customer is: a mapping row with `source`
`stripe` and its `customer_id` wins, then `customer_domain`, then the domain of
`customer_email`. In the account model its id is listed under `stripe_customer_ids` (the field
name is kept for version 1; it means billing customer ids). A usage `account_id` is matched as
a CSV usage account is.

## The unlink guard

The billing source's identity is `bigquery:<project>:<first 16 hex of the SHA-256 of the SQL
file>`. A sync from another project, another query, or Stripe after BigQuery holds every unlink
until `sync --allow-unlink`, which records the new identity. Editing the SQL changes the
identity on purpose: a mass "churn" right after a query edit is far more often a filter mistake.
