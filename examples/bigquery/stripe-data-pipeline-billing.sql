-- revenue-sync billing from Stripe Data Pipeline in BigQuery.
--
-- Data Pipeline delivers Stripe data to your own project as the datasets `stripe` (live mode)
-- and `stripe_testmode` (sandboxes); every table has merchant_id, and a full load lands every 3
-- hours (docs.stripe.com/data/access-data-in-warehouse,
-- docs.stripe.com/data/access-data-in-warehouse/data-warehouses). Replace `your-project`, pick
-- the dataset, and put your Stripe account id in the `account` CTE.
--
-- Columns marked [doc] appear in Stripe's own example queries (docs.stripe.com/data/query-billing-data).
-- Columns marked [unverified] follow Data Pipeline's naming (nested API fields flattened with
-- underscores) but have NOT been checked against a live share: check each in the schema browser
-- (docs.stripe.com/data/schema) before the first run. A wrong name or type fails the query or the
-- row contract loudly.
--
-- Every join is a LEFT JOIN and every table is filtered by merchant_id, so a row whose price,
-- discount or coupon is missing comes through with NULLs the row contract refuses, instead of
-- being dropped (an inner join would drop it: a missing price would understate MRR, a missing
-- coupon would write an undiscounted one). What no query can see is a customer missing from the
-- load altogether; with STRIPE_API_KEY set, reconcile's cross-source check catches that.
--
-- Handled: statuses, quantities, per-unit prices, intervals and interval counts, period ends,
-- transform_quantity, tax_behavior, open invoices, product names, subscription-level coupons
-- (percent, amount, duration, discount end), three-decimal currencies (amounts pass through in
-- minor units).
-- Flagged: every coupon's product restriction. No Data Pipeline column for a coupon's applies_to
-- is documented, so this query emits a NULL applies_to, and revenue-sync flags a company with a
-- coupon (money values not written) exactly as the Stripe path does when it cannot read a
-- restriction. If you know your coupons are unrestricted, emit '' instead.
WITH
  account AS (SELECT 'acct_REPLACE_WITH_YOUR_ACCOUNT_ID' AS id),
  -- Every contract column, typed, all NULL. Each record kind below replaces the columns it uses.
  blank AS (
    SELECT
      CAST(NULL AS STRING) AS record,
      CAST(NULL AS STRING) AS customer_id,
      CAST(NULL AS STRING) AS customer_name,
      CAST(NULL AS STRING) AS customer_email,
      CAST(NULL AS STRING) AS customer_domain,
      CAST(NULL AS BOOL) AS customer_discount,
      CAST(NULL AS STRING) AS subscription_id,
      CAST(NULL AS STRING) AS status,
      CAST(NULL AS STRING) AS currency,
      CAST(NULL AS BOOL) AS cancel_at_period_end,
      CAST(NULL AS TIMESTAMP) AS cancel_at,
      CAST(NULL AS BOOL) AS collection_paused,
      CAST(NULL AS STRING) AS item_id,
      CAST(NULL AS STRING) AS price_id,
      CAST(NULL AS STRING) AS product_id,
      CAST(NULL AS STRING) AS product_name,
      CAST(NULL AS STRING) AS price_nickname,
      CAST(NULL AS NUMERIC) AS unit_amount,
      CAST(NULL AS STRING) AS billing_interval,
      CAST(NULL AS INT64) AS interval_count,
      CAST(NULL AS STRING) AS usage_type,
      CAST(NULL AS STRING) AS billing_scheme,
      CAST(NULL AS STRING) AS tax_behavior,
      CAST(NULL AS INT64) AS transform_divide_by,
      CAST(NULL AS STRING) AS transform_round,
      CAST(NULL AS INT64) AS quantity,
      CAST(NULL AS TIMESTAMP) AS current_period_end,
      CAST(NULL AS BOOL) AS item_discounted,
      CAST(NULL AS STRING) AS discount_id,
      CAST(NULL AS STRING) AS coupon_id,
      CAST(NULL AS NUMERIC) AS percent_off,
      CAST(NULL AS NUMERIC) AS amount_off,
      CAST(NULL AS STRING) AS duration,
      CAST(NULL AS TIMESTAMP) AS discount_end,
      CAST(NULL AS STRING) AS applies_to,
      CAST(NULL AS STRING) AS invoice_id,
      CAST(NULL AS NUMERIC) AS amount_remaining
  ),
  subs AS (
    SELECT s.*
    FROM `your-project.stripe_testmode.subscriptions` AS s          -- [doc] id, customer_id, status, discounts
    WHERE s.merchant_id = (SELECT id FROM account)
  ),
  -- subscriptions.discounts is a comma-separated list of discount ids [doc].
  sub_discounts AS (
    SELECT subs.id AS subscription_id, subs.merchant_id AS merchant_id, TRIM(discount_id) AS discount_id
    FROM subs CROSS JOIN UNNEST(SPLIT(subs.discounts, ',')) AS discount_id
    WHERE subs.discounts IS NOT NULL AND TRIM(discount_id) != ''
  )
SELECT blank.* REPLACE (
  'customer' AS record,
  c.id AS customer_id,                                                -- [doc]
  c.name AS customer_name,                                            -- [unverified]
  c.email AS customer_email,                                          -- [doc]
  (SELECT m.value FROM `your-project.stripe_testmode.customers_metadata` AS m
     WHERE m.merchant_id = c.merchant_id AND m.customer_id = c.id AND m.key = 'domain' LIMIT 1) AS customer_domain,  -- [unverified] metadata.domain
  c.discount_coupon_id IS NOT NULL AS customer_discount)              -- [unverified]
FROM blank CROSS JOIN `your-project.stripe_testmode.customers` AS c
WHERE c.merchant_id = (SELECT id FROM account)
UNION ALL
SELECT blank.* REPLACE (
  'subscription' AS record,
  s.customer_id AS customer_id,
  s.id AS subscription_id,
  s.status AS status,
  s.currency AS currency,                                             -- [unverified]
  s.cancel_at_period_end AS cancel_at_period_end,                     -- [unverified]
  s.cancel_at AS cancel_at,                                           -- [unverified]
  s.pause_collection_behavior IS NOT NULL AS collection_paused)       -- [unverified]
FROM blank CROSS JOIN subs AS s
UNION ALL
SELECT blank.* REPLACE (
  'item' AS record,
  si.subscription_id AS subscription_id,                              -- [doc]
  si.id AS item_id,                                                   -- [doc]
  si.price_id AS price_id,                                            -- [doc]
  si.price_product_id AS product_id,                                  -- [doc]
  pr.name AS product_name,                                            -- [doc] products.name
  p.nickname AS price_nickname,                                       -- [unverified]
  CAST(p.unit_amount AS NUMERIC) AS unit_amount,                      -- [unverified] minor units
  p.recurring_interval AS billing_interval,                           -- [unverified]
  p.recurring_interval_count AS interval_count,                       -- [unverified]
  p.recurring_usage_type AS usage_type,                               -- [unverified]
  p.billing_scheme AS billing_scheme,                                 -- [unverified]
  p.tax_behavior AS tax_behavior,                                     -- [unverified]
  p.transform_quantity_divide_by AS transform_divide_by,              -- [unverified]
  p.transform_quantity_round AS transform_round,                      -- [unverified]
  si.quantity AS quantity,                                            -- [unverified]
  si.current_period_end AS current_period_end,                        -- [unverified] on the item since API 2025-03-31
  IFNULL(si.discounts, '') != '' AS item_discounted)                  -- [unverified]
FROM blank
CROSS JOIN `your-project.stripe_testmode.subscription_items` AS si
LEFT JOIN `your-project.stripe_testmode.prices` AS p                  -- [doc] prices.id
  ON p.id = si.price_id AND p.merchant_id = si.merchant_id
LEFT JOIN `your-project.stripe_testmode.products` AS pr               -- [doc]
  ON pr.id = si.price_product_id AND pr.merchant_id = si.merchant_id
WHERE si.merchant_id = (SELECT id FROM account)
UNION ALL
SELECT blank.* REPLACE (
  'discount' AS record,
  sd.subscription_id AS subscription_id,
  sd.discount_id AS discount_id,                                      -- [doc] subscriptions.discounts
  co.id AS coupon_id,                                                 -- [doc]
  CAST(co.percent_off AS NUMERIC) AS percent_off,                     -- [doc]
  CAST(co.amount_off AS NUMERIC) AS amount_off,                       -- [doc] minor units
  co.currency AS currency,                                            -- [unverified]
  co.duration AS duration,                                            -- [unverified]
  d.`end` AS discount_end,                                            -- [unverified]
  CAST(NULL AS STRING) AS applies_to)                                 -- not documented: flagged
FROM blank
CROSS JOIN sub_discounts AS sd
LEFT JOIN `your-project.stripe_testmode.discounts` AS d               -- [doc] id, coupon_id
  ON d.id = sd.discount_id AND d.merchant_id = sd.merchant_id
LEFT JOIN `your-project.stripe_testmode.coupons` AS co                -- [doc]
  ON co.id = d.coupon_id AND co.merchant_id = sd.merchant_id
UNION ALL
SELECT blank.* REPLACE (
  'open_invoice' AS record,
  i.customer_id AS customer_id,                                       -- [unverified]
  i.id AS invoice_id,                                                 -- [doc]
  i.currency AS currency,                                             -- [doc]
  CAST(i.amount_remaining AS NUMERIC) AS amount_remaining)            -- [unverified]
FROM blank CROSS JOIN `your-project.stripe_testmode.invoices` AS i
WHERE i.merchant_id = (SELECT id FROM account) AND i.status = 'open' AND i.amount_remaining > 0
