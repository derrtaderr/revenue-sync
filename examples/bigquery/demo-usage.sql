-- revenue-sync demo usage: literal rows, no tables, free in the BigQuery sandbox. A few users per
-- seed company, active in the last 30 days, so the usage properties have values to write.
-- Output columns are the usage contract in docs/warehouse.md. The test suite runs it against the
-- fakes, through a parser of this file; it was run on BigQuery on 2026-10-08 and returned 7 usage
-- accounts.
SELECT
  a.account_id AS account_id,
  CONCAT(a.account_id, '-u', CAST(n AS STRING)) AS user_id,
  DATE_SUB(CURRENT_DATE(), INTERVAL MOD(n * 7, 28) DAY) AS date,
  a.domain AS domain
FROM UNNEST([
  STRUCT('northwind' AS account_id, 'northwind.example' AS domain, 20 AS users),
  ('globex', 'globex.example', 30),
  ('initrode', 'initrode.example', 25),
  ('umbrella', 'umbrella.example', 6),
  ('hooli', 'hooli.example', 9),
  ('soylent', 'soylent.example', 8),
  ('stark', 'stark.example', 13)
]) AS a
CROSS JOIN UNNEST(GENERATE_ARRAY(1, a.users)) AS n
