-- The 3 most listed skills in each city. DENSE_RANK keeps ties, so a city can show more than 3 rows.
WITH skill_counts AS (
  SELECT c.city_name, k.skill_name, count(*) AS applications
  FROM bridge_application_skill AS b
  JOIN fact_application AS f ON b.application_key = f.application_key
  JOIN dim_city AS c ON f.city_key = c.city_key
  JOIN dim_skill AS k ON b.skill_key = k.skill_key
  GROUP BY c.city_name, k.skill_name
),
ranked AS (
  SELECT *, dense_rank() OVER (PARTITION BY city_name ORDER BY applications DESC) AS skill_rank
  FROM skill_counts
)
SELECT city_name, skill_rank, skill_name, applications
FROM ranked
WHERE skill_rank <= 3
ORDER BY city_name, skill_rank, skill_name;
