-- revenue-sync demo billing: literal rows, no tables, so it runs free in the BigQuery sandbox
-- (which does not run DML, so nothing can be loaded there anyway). The companies and amounts
-- mirror `seed`, and dates are relative to the day you run it, as seed's are. Run within 14
-- days of `seed --hubspot` (while seed's Hooli trial is still a trial in Stripe, and before
-- seed's 3-month Soylent discount ends), and this query and Stripe give the same MRR for every
-- company, so reconcile's cross-source check should pass. The test suite checks exactly that
-- against the fakes, through a parser of this file (its own literals and column mapping). It was
-- run on BigQuery on 2026-10-08: it compiled, returned 11 customers, 12 subscriptions and 2 open
-- invoices, and the cross-source check failed on exactly one company, whose Stripe customer had
-- been deleted on purpose. Change Northwind's quantity from 25 to 30 to watch it fail
-- (warehouse 1560, Stripe 1300).
--
-- Output columns are the contract in docs/warehouse.md.
WITH
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
  customers AS (
    SELECT * FROM UNNEST([
      STRUCT('cus_demo_northwind' AS id, 'Northwind Analytics' AS name, 'ap@northwind.example' AS email),
      ('cus_demo_globex', 'Globex Logistics', 'finance@globex.example'),
      ('cus_demo_initrode', 'Initrode Health', 'billing@initrode.example'),
      ('cus_demo_umbrella', 'Umbrella Freight', 'ops@umbrella.example'),
      ('cus_demo_hooli', 'Hooli Robotics', 'it@hooli.example'),
      ('cus_demo_vandelay', 'Vandelay Imports', 'art@vandelay.example'),
      ('cus_demo_soylent', 'Soylent Foods', 'ar@soylent.example'),
      ('cus_demo_stark_us', 'Stark Biotech (US)', 'ap@stark.example'),
      ('cus_demo_stark_eu', 'Stark Biotech (EU)', 'eu-billing@stark.example'),
      ('cus_demo_massive', 'Massive Dynamic', 'billing@massive.example'),
      ('cus_demo_piedpiper', 'Pied Piper', 'richard.pp@gmail.com')
    ])
  ),
  subscriptions AS (
    SELECT * FROM UNNEST([
      STRUCT('sub_demo_northwind' AS id, 'cus_demo_northwind' AS customer_id, 'active' AS status, 'usd' AS currency),
      ('sub_demo_globex', 'cus_demo_globex', 'active', 'usd'),
      ('sub_demo_initrode', 'cus_demo_initrode', 'active', 'usd'),
      ('sub_demo_umbrella_1', 'cus_demo_umbrella', 'active', 'usd'),
      ('sub_demo_umbrella_2', 'cus_demo_umbrella', 'active', 'usd'),
      ('sub_demo_hooli', 'cus_demo_hooli', 'trialing', 'usd'),
      ('sub_demo_vandelay', 'cus_demo_vandelay', 'canceled', 'usd'),
      ('sub_demo_soylent', 'cus_demo_soylent', 'active', 'usd'),
      ('sub_demo_stark_us', 'cus_demo_stark_us', 'active', 'usd'),
      ('sub_demo_stark_eu', 'cus_demo_stark_eu', 'active', 'eur'),
      ('sub_demo_massive', 'cus_demo_massive', 'active', 'usd'),
      ('sub_demo_piedpiper', 'cus_demo_piedpiper', 'active', 'usd')
    ])
  ),
  -- unit_amount in minor units (cents): 6500 is $65.00 a seat a month.
  items AS (
    SELECT * FROM UNNEST([
      STRUCT('si_demo_1' AS id, 'sub_demo_northwind' AS subscription_id, 'price_demo_growth_monthly' AS price_id, 'prod_demo_growth' AS product_id, 'Growth' AS product_name, NUMERIC '6500' AS unit_amount, 'month' AS billing_interval, 1 AS interval_count, 25 AS quantity, TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 MONTH)) AS current_period_end),
      ('si_demo_2', 'sub_demo_globex', 'price_demo_scale_annual', 'prod_demo_scale', 'Scale', NUMERIC '2400000', 'year', 1, 1, TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 12 MONTH))),
      ('si_demo_3', 'sub_demo_initrode', 'price_demo_growth_annual', 'prod_demo_growth', 'Growth', NUMERIC '65000', 'year', 1, 40, TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 12 MONTH))),
      ('si_demo_4', 'sub_demo_umbrella_1', 'price_demo_starter_monthly', 'prod_demo_starter', 'Starter', NUMERIC '49000', 'month', 1, 1, TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 MONTH))),
      ('si_demo_5', 'sub_demo_umbrella_2', 'price_demo_growth_monthly', 'prod_demo_growth', 'Growth', NUMERIC '6500', 'month', 1, 10, TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 MONTH))),
      ('si_demo_6', 'sub_demo_hooli', 'price_demo_growth_monthly', 'prod_demo_growth', 'Growth', NUMERIC '6500', 'month', 1, 15, TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 14 DAY))),
      ('si_demo_7', 'sub_demo_vandelay', 'price_demo_starter_monthly', 'prod_demo_starter', 'Starter', NUMERIC '49000', 'month', 1, 1, TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 MONTH))),
      ('si_demo_8', 'sub_demo_soylent', 'price_demo_growth_monthly', 'prod_demo_growth', 'Growth', NUMERIC '6500', 'month', 1, 8, TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 MONTH))),
      ('si_demo_9', 'sub_demo_stark_us', 'price_demo_growth_monthly', 'prod_demo_growth', 'Growth', NUMERIC '6500', 'month', 1, 12, TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 MONTH))),
      ('si_demo_10', 'sub_demo_stark_eu', 'price_demo_growth_monthly_eur', 'prod_demo_growth', 'Growth', NUMERIC '6000', 'month', 1, 6, TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 MONTH))),
      ('si_demo_11', 'sub_demo_massive', 'price_demo_growth_monthly', 'prod_demo_growth', 'Growth', NUMERIC '6500', 'month', 1, 5, TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 MONTH))),
      ('si_demo_12', 'sub_demo_piedpiper', 'price_demo_starter_monthly', 'prod_demo_starter', 'Starter', NUMERIC '49000', 'month', 1, 1, TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 MONTH)))
    ])
  ),
  discounts AS (
    SELECT * FROM UNNEST([
      STRUCT('sub_demo_northwind' AS subscription_id, 'di_demo_northwind' AS discount_id, 'DEMO_PARTNER20' AS coupon_id, NUMERIC '20' AS percent_off, CAST(NULL AS NUMERIC) AS amount_off, CAST(NULL AS STRING) AS currency, 'forever' AS duration, CAST(NULL AS TIMESTAMP) AS discount_end),
      ('sub_demo_soylent', 'di_demo_soylent', 'DEMO_LAUNCH100', NULL, NUMERIC '10000', 'usd', 'repeating', TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 3 MONTH)))
    ])
  ),
  open_invoices AS (
    SELECT * FROM UNNEST([
      STRUCT('in_demo_globex' AS id, 'cus_demo_globex' AS customer_id, 'usd' AS currency, NUMERIC '2400000' AS amount_remaining),
      ('in_demo_northwind', 'cus_demo_northwind', 'usd', NUMERIC '162500')
    ])
  )
SELECT blank.* REPLACE ('customer' AS record, c.id AS customer_id, c.name AS customer_name, c.email AS customer_email, FALSE AS customer_discount)
FROM blank CROSS JOIN customers AS c
UNION ALL
SELECT blank.* REPLACE ('subscription' AS record, s.customer_id AS customer_id, s.id AS subscription_id, s.status AS status, s.currency AS currency, FALSE AS cancel_at_period_end, FALSE AS collection_paused)
FROM blank CROSS JOIN subscriptions AS s
UNION ALL
SELECT blank.* REPLACE (
  'item' AS record, i.subscription_id AS subscription_id, i.id AS item_id, i.price_id AS price_id, i.product_id AS product_id, i.product_name AS product_name,
  i.unit_amount AS unit_amount, i.billing_interval AS billing_interval, i.interval_count AS interval_count, 'licensed' AS usage_type, 'per_unit' AS billing_scheme,
  'exclusive' AS tax_behavior, i.quantity AS quantity, i.current_period_end AS current_period_end, FALSE AS item_discounted)
FROM blank CROSS JOIN items AS i
UNION ALL
SELECT blank.* REPLACE (
  'discount' AS record, d.subscription_id AS subscription_id, d.discount_id AS discount_id, d.coupon_id AS coupon_id, d.percent_off AS percent_off, d.amount_off AS amount_off,
  d.currency AS currency, d.duration AS duration, d.discount_end AS discount_end, '' AS applies_to)
FROM blank CROSS JOIN discounts AS d
UNION ALL
SELECT blank.* REPLACE ('open_invoice' AS record, o.customer_id AS customer_id, o.id AS invoice_id, o.currency AS currency, o.amount_remaining AS amount_remaining)
FROM blank CROSS JOIN open_invoices AS o
