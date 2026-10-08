# Metric definitions

<!-- Generated from src/definitions.mjs by `npm run gen`. Edit the definitions, not this file. -->

Every value revenue-sync writes to a HubSpot company, in the property group `revenue_sync` ("Revenue sync"). Each is computed in exactly one place, src/definitions.mjs, and this page is generated from it.

## MRR

Property `rs_mrr`, number, money (in the billing currency).

Monthly recurring revenue. For every active or past_due subscription on any Stripe customer matched to the company: each item's unit price times its billed quantity (for a per-pack price with transform_quantity, the quantity divided into packs and rounded the way the price says), converted to a month (a yearly price divided by 12, every 3 months divided by 3, weekly times 52 over 12, daily times 365 over 12), then reduced by subscription-level discounts that recur (percent-off first, then amount-off spread over the billing interval, never below zero). A coupon limited to some products (Stripe's applies_to) only reduces those products, and an amount-off never takes more than they are worth; when a coupon's product limits cannot be read, money values are flagged instead. Once-only and ended discounts are ignored. Trialing, canceled, unpaid, paused and incomplete subscriptions, and active ones with collection paused (pause_collection), count as zero. Pre-tax: exclusive and unspecified prices are taken as they are, and a tax-inclusive price is flagged because the tax inside it cannot be read from the price. Left unwritten, and flagged, when the company is billed in more than one currency, in UGX or ISK, or has a metered, tiered, item-discounted or tax-inclusive price, or a customer-level discount that any of its subscriptions does not show, or a subscription whose item list Stripe truncated.

## ARR

Property `rs_arr`, number, money (in the billing currency).

Annual recurring revenue: MRR times 12, computed before MRR is rounded, so an annual plan reads back as its exact yearly price. Flagged and left unwritten in the same cases as MRR.

## Billing currency

Property `rs_billing_currency`, text.

The ISO currency code (USD, EUR) that MRR, ARR and the outstanding amount are in: the one currency of the company's active and past_due subscriptions and open invoices. Empty when there are none, and empty and flagged when there is more than one.

## Outstanding amount

Property `rs_outstanding_amount`, number, money (in the billing currency).

What the company still owes: the sum of amount_remaining on every open Stripe invoice of its matched customers, in the billing currency. Draft, paid, void and uncollectible invoices are not counted. Flagged and left unwritten when the open invoices are in another currency.

## Plan

Property `rs_plan`, text.

The names of the Stripe products on the company's live subscriptions (active, past_due or trialing), biggest monthly amount first, joined with a plus sign. Falls back to the price nickname, then the price id, when the product has no name. Empty when nothing is live.

## Billing status

Property `rs_billing_status`, text.

One word for the company's billing state, the state that most needs attention winning: unpaid, then past_due, then active, then canceling (every active subscription is set to cancel), then trialing, then paused (including an active subscription with collection paused), then canceled. none when Stripe has no subscription for the company. sync writes unlinked (and clears every other revenue-sync value) on a company that held values but that no Stripe customer or usage account resolves to any more.

## Renewal date

Property `rs_renewal_date`, date (YYYY-MM-DD).

The next date money is due to renew: the earliest current period end on a live subscription (active, past_due or trialing) that is not set to cancel. For a trial that is the date it converts. Empty when every live subscription is set to cancel, or nothing is live.

## Seats

Property `rs_seat_count`, number.

The total quantity across every item of the company's live subscriptions (active, past_due or trialing). For per-seat pricing that is the seats paid for; a flat item with quantity 1 adds one.

## Active users (30 days)

Property `rs_active_users_30d`, number.

Distinct user_id values in the usage CSV for the company's matched usage accounts, active on any day in the 30 days ending on the as-of date (the as-of date included). Empty, not zero, when no usage account is matched to the company.

## Usage trend

Property `rs_usage_trend`, text.

Distinct active users in the last 30 days compared with the 30 days before that: up when it rose by 10 percent or more, down when it fell by 10 percent or more, flat in between, new when there were no users before and some now, none when there were none in either window. Empty when no usage account is matched.
