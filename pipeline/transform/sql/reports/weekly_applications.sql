-- Applications per hiring source per week, with a running total for each source.
WITH weekly AS (
  SELECT d.week_start, s.source_name, count(*) AS applications
  FROM fact_application AS f
  JOIN dim_date AS d ON f.applied_date_key = d.date_key
  JOIN dim_source AS s ON f.source_key = s.source_key
  GROUP BY d.week_start, s.source_name
)
SELECT
  week_start,
  source_name,
  applications,
  sum(applications) OVER (
    PARTITION BY source_name ORDER BY week_start
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ) AS running_total
FROM weekly
ORDER BY source_name, week_start;
