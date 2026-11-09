-- Analytics layer: a star schema built from the cleaned applications.
-- Reads the view `applications` (the Cleaned table). Produces one view per output table.
--
-- Keys are hashes of each row's natural key (for example the city name), so the same city gets
-- the same key on every rebuild, and the fact table can find its dimension rows without a lookup.

CREATE OR REPLACE TEMP MACRO make_key(natural_key) AS left(sha256(natural_key), 16);

-- ── Dimensions ──────────────────────────────────────────────────────────────

-- One row per person. The email is stored only as a SHA-256 hash, so reports never show it.
CREATE OR REPLACE TEMP VIEW dim_candidate AS
SELECT
  sha256(email) AS candidate_key,
  arg_max(full_name, applied_on) AS full_name  -- the name on their latest application
FROM applications
GROUP BY email;

CREATE OR REPLACE TEMP VIEW dim_source AS
SELECT make_key(source) AS source_key, source AS source_name
FROM (SELECT DISTINCT source FROM applications);

-- A missing city becomes 'Unknown', so every application still joins to a city row.
CREATE OR REPLACE TEMP VIEW dim_city AS
SELECT make_key(city_name) AS city_key, city_name
FROM (SELECT DISTINCT COALESCE(city, 'Unknown') AS city_name FROM applications);

CREATE OR REPLACE TEMP VIEW dim_skill AS
SELECT make_key(skill_name) AS skill_key, skill_name
FROM (SELECT DISTINCT unnest(skills) AS skill_name FROM applications);

-- One row per calendar day from the first to the last application date.
CREATE OR REPLACE TEMP VIEW dim_date AS
SELECT
  CAST(strftime(day, '%Y%m%d') AS INTEGER) AS date_key,
  day AS full_date,
  dayname(day) AS day_name,
  CAST(date_trunc('week', day) AS DATE) AS week_start,  -- weeks start on Monday
  month(day) AS month_number,
  monthname(day) AS month_name,
  quarter(day) AS quarter,
  year(day) AS year
FROM (
  SELECT CAST(unnest(generate_series(min(applied_on), max(applied_on), INTERVAL 1 DAY)) AS DATE) AS day
  FROM applications
);

-- ── Fact and bridge ─────────────────────────────────────────────────────────

-- Grain: one row per application (one person through one hiring source).
CREATE OR REPLACE TEMP VIEW fact_application AS
SELECT
  make_key(email || '|' || source) AS application_key,
  sha256(email) AS candidate_key,
  make_key(source) AS source_key,
  make_key(COALESCE(city, 'Unknown')) AS city_key,
  CAST(strftime(applied_on, '%Y%m%d') AS INTEGER) AS applied_date_key,
  ctc_lpa,
  notice_days,
  experience_years,
  COALESCE(len(skills), 0) AS skill_count,
  row_id AS source_row_id  -- traces back to the raw file, sheet and row
FROM applications;

-- One application lists several skills, so skills sit in their own table (many-to-many).
CREATE OR REPLACE TEMP VIEW bridge_application_skill AS
SELECT make_key(email || '|' || source) AS application_key, make_key(skill_name) AS skill_key
FROM (SELECT email, source, unnest(skills) AS skill_name FROM applications);
