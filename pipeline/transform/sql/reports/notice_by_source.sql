-- How long candidates from each source need before joining, as a share of that source.
WITH bucketed AS (
  SELECT
    s.source_name,
    CASE
      WHEN f.notice_days IS NULL THEN 'Not given'
      WHEN f.notice_days = 0 THEN 'Immediate'
      WHEN f.notice_days <= 30 THEN '1-30 days'
      WHEN f.notice_days <= 60 THEN '31-60 days'
      ELSE 'Over 60 days'
    END AS notice_bucket
  FROM fact_application AS f
  JOIN dim_source AS s ON f.source_key = s.source_key
)
SELECT
  source_name,
  notice_bucket,
  count(*) AS applications,
  round(100.0 * count(*) / sum(count(*)) OVER (PARTITION BY source_name), 1) AS pct_of_source
FROM bucketed
GROUP BY source_name, notice_bucket
ORDER BY source_name, notice_bucket;
