-- Average CTC (lakhs per annum) by city and source.
-- ctc_reported shows how many applications the average is based on, since CTC is optional.
SELECT
  c.city_name,
  s.source_name,
  count(*) AS applications,
  count(f.ctc_lpa) AS ctc_reported,
  round(avg(f.ctc_lpa), 2) AS avg_ctc_lpa
FROM fact_application AS f
JOIN dim_city AS c ON f.city_key = c.city_key
JOIN dim_source AS s ON f.source_key = s.source_key
GROUP BY c.city_name, s.source_name
ORDER BY avg_ctc_lpa DESC NULLS LAST, c.city_name, s.source_name;
