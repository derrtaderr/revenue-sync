-- revenue-sync usage from your own product events. Adapt the table and column names to your
-- warehouse; the OUTPUT column names are the contract (docs/warehouse.md). One row per user per
-- active day is enough; 60 days covers the two 30-day windows the usage trend compares.
SELECT
  e.account_id AS account_id,
  e.user_id AS user_id,
  DATE(e.event_timestamp) AS date,
  a.primary_domain AS domain
FROM `your-project.product.events` AS e
LEFT JOIN `your-project.product.accounts` AS a ON a.id = e.account_id
WHERE e.event_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 60 DAY)
GROUP BY account_id, user_id, date, domain
