-- Cleaned layer: turns raw JSON rows into typed columns, separates bad rows and removes duplicates.
-- Reads `raw_rows` (only raw files not processed yet) and `current_applications` (what is saved).
-- Produces `all_row_ids`, `cleaned_rows`, `already_saved_rows` and `rejected_rows`.
-- Every raw row must end up in exactly one of `cleaned_rows`, `already_saved_rows` or `rejected_rows`.

-- ── Helpers ─────────────────────────────────────────────────────────────────

-- Trims whitespace and turns blank text into NULL.
CREATE OR REPLACE TEMP MACRO clean_text(t) AS
  NULLIF(regexp_replace(t, '^\s+|\s+$', '', 'g'), '');

-- Lowercase with spaces, commas and the rupee sign removed: '₹1,250,000' -> '1250000'.
CREATE OR REPLACE TEMP MACRO compact(t) AS
  regexp_replace(lower(t), '[₹,\s]', '', 'g');

-- CTC in lakhs per annum. A plain number of 1000 or more is taken as rupees, otherwise as lakhs.
CREATE OR REPLACE TEMP MACRO parse_ctc_lpa(t) AS
  CASE
    WHEN regexp_full_match(compact(t), '[0-9]+(\.[0-9]+)?(lpa|lakhs?)')
      THEN ROUND(TRY_CAST(regexp_extract(compact(t), '^[0-9.]+') AS DOUBLE), 2)
    WHEN regexp_full_match(compact(t), '[0-9]+(\.[0-9]+)?')
      THEN CASE
             WHEN TRY_CAST(compact(t) AS DOUBLE) >= 1000 THEN ROUND(TRY_CAST(compact(t) AS DOUBLE) / 100000, 2)
             ELSE ROUND(TRY_CAST(compact(t) AS DOUBLE), 2)
           END
  END;

-- Notice period in days. A month counts as 30 days.
CREATE OR REPLACE TEMP MACRO parse_notice_days(t) AS
  CASE
    WHEN compact(t) = 'immediate' THEN 0
    WHEN regexp_full_match(compact(t), '[0-9]+(d|days?)?')
      THEN TRY_CAST(regexp_extract(compact(t), '^[0-9]+') AS INTEGER)
    WHEN regexp_full_match(compact(t), '[0-9]+months?')
      THEN TRY_CAST(regexp_extract(compact(t), '^[0-9]+') AS INTEGER) * 30
  END;

-- Experience in years: '3', '3 yrs', '3 years 6 months' or 'Fresher'.
CREATE OR REPLACE TEMP MACRO parse_experience_years(t) AS
  CASE
    WHEN compact(t) = 'fresher' THEN 0.0
    WHEN regexp_full_match(compact(t), '[0-9]+(\.[0-9]+)?(yrs?|years?)?')
      THEN TRY_CAST(regexp_extract(compact(t), '^[0-9.]+') AS DOUBLE)
    WHEN regexp_full_match(compact(t), '[0-9]+(yrs?|years?)[0-9]+months?')
      THEN ROUND(
        TRY_CAST(regexp_extract(compact(t), '^([0-9]+)', 1) AS DOUBLE)
        + TRY_CAST(regexp_extract(compact(t), '([0-9]+)months?$', 1) AS DOUBLE) / 12, 1)
  END;

CREATE OR REPLACE TEMP MACRO standard_city(t) AS
  CASE lower(clean_text(t))
    WHEN 'bangalore' THEN 'Bengaluru'
    WHEN 'gurgaon' THEN 'Gurugram'
    ELSE upper(left(clean_text(t), 1)) || lower(substr(clean_text(t), 2))
  END;

CREATE OR REPLACE TEMP MACRO standard_skill(t) AS
  CASE lower(clean_text(t))
    WHEN 'python' THEN 'Python'
    WHEN 'sql' THEN 'SQL'
    WHEN 'pyspark' THEN 'PySpark'
    WHEN 'powerbi' THEN 'Power BI'
    WHEN 'power bi' THEN 'Power BI'
    WHEN 'azure' THEN 'Azure'
    WHEN 'excel' THEN 'Excel'
    WHEN 'databricks' THEN 'Databricks'
    ELSE clean_text(t)
  END;

-- ── Step 1: give every source the same column names ─────────────────────────

CREATE OR REPLACE TEMP VIEW mapped AS
SELECT
  _file_hash || ':' || _sheet_name || ':' || _row_number AS row_id,
  raw_json,
  _source_file AS source_file,
  _sheet_name AS sheet_name,
  _row_number AS row_number,
  _ingested_at AS ingested_at,
  CASE WHEN _sheet_name IN ('Naukri', 'LinkedIn', 'Referrals') THEN _sheet_name ELSE 'Unknown' END AS source,
  clean_text(COALESCE(json_extract_string(raw_json, '$."Candidate Name"'), json_extract_string(raw_json, '$."Full Name"'), json_extract_string(raw_json, '$."Name"'))) AS name_text,
  clean_text(COALESCE(json_extract_string(raw_json, '$."Email ID"'), json_extract_string(raw_json, '$."E-mail"'), json_extract_string(raw_json, '$."Email"'))) AS email_text,
  clean_text(COALESCE(json_extract_string(raw_json, '$."Current CTC"'), json_extract_string(raw_json, '$."CTC (LPA)"'), json_extract_string(raw_json, '$."Salary"'))) AS ctc_text,
  clean_text(COALESCE(json_extract_string(raw_json, '$."Notice Period"'), json_extract_string(raw_json, '$."Notice"'), json_extract_string(raw_json, '$."Notice Period (Days)"'))) AS notice_text,
  clean_text(COALESCE(json_extract_string(raw_json, '$."Total Exp"'), json_extract_string(raw_json, '$."Experience (Years)"'), json_extract_string(raw_json, '$."Experience"'))) AS experience_text,
  clean_text(COALESCE(json_extract_string(raw_json, '$."Key Skills"'), json_extract_string(raw_json, '$."Skills"'), json_extract_string(raw_json, '$."Skill Set"'))) AS skills_text,
  clean_text(COALESCE(json_extract_string(raw_json, '$."City"'), json_extract_string(raw_json, '$."Location"'), json_extract_string(raw_json, '$."Current City"'))) AS city_text,
  clean_text(COALESCE(json_extract_string(raw_json, '$."Applied On"'), json_extract_string(raw_json, '$."Application Date"'), json_extract_string(raw_json, '$."Referred On"'))) AS applied_text,
  clean_text(json_extract_string(raw_json, '$."Referred By"')) AS referred_by
FROM raw_rows;

-- ── Step 2: convert text into proper types ──────────────────────────────────

CREATE OR REPLACE TEMP VIEW parsed AS
SELECT
  *,
  name_text AS full_name,
  lower(email_text) AS email,
  CASE WHEN lower(ctc_text) = 'not disclosed' THEN NULL ELSE ctc_text END AS ctc_value_text,
  parse_ctc_lpa(ctc_text) AS ctc_lpa,
  parse_notice_days(notice_text) AS notice_days,
  parse_experience_years(experience_text) AS experience_years,
  standard_city(city_text) AS city,
  CAST(try_strptime(applied_text, ['%Y-%m-%d', '%d/%m/%Y', '%d-%b-%y']) AS DATE) AS applied_on,
  list_sort(list_distinct(list_transform(
    list_filter(regexp_split_to_array(skills_text, '[,;|]'), lambda s: clean_text(s) IS NOT NULL),
    lambda s: standard_skill(s)
  ))) AS skills
FROM mapped;

-- ── Step 3: list everything wrong with each row ─────────────────────────────
-- Required: name, a valid email and a valid applied date.
-- Optional: CTC, notice and experience may be blank, but a value that cannot be read is rejected.

CREATE OR REPLACE TEMP VIEW validated AS
SELECT
  *,
  list_filter([
    CASE WHEN full_name IS NULL THEN 'MISSING_NAME' END,
    CASE WHEN email IS NULL THEN 'MISSING_EMAIL' END,
    CASE WHEN email IS NOT NULL AND NOT regexp_full_match(email, '[^\s@]+@[^\s@]+\.[^\s@]+') THEN 'INVALID_EMAIL' END,
    CASE WHEN applied_on IS NULL THEN 'INVALID_APPLIED_DATE' END,
    CASE WHEN ctc_value_text IS NOT NULL AND ctc_lpa IS NULL THEN 'UNREADABLE_CTC' END,
    CASE WHEN notice_text IS NOT NULL AND notice_days IS NULL THEN 'UNREADABLE_NOTICE' END,
    CASE WHEN experience_text IS NOT NULL AND experience_years IS NULL THEN 'UNREADABLE_EXPERIENCE' END
  ], lambda reason: reason IS NOT NULL) AS reject_reasons
FROM parsed;

-- ── Step 4: rank valid rows so only the latest per person and source is kept ─

CREATE OR REPLACE TEMP VIEW ranked AS
SELECT
  *,
  ROW_NUMBER() OVER (
    PARTITION BY email, source
    ORDER BY applied_on DESC, ingested_at DESC, source_file DESC, row_number DESC
  ) AS version_rank
FROM validated
WHERE len(reject_reasons) = 0;

-- ── Step 5: compare each winning row with what is already saved ─────────────
-- `current_applications` holds the saved table (empty on the first run).
--   insert        : nobody with this email and source is saved yet
--   update        : this row is newer than the saved one, so it replaces it
--   already_saved : this exact row is already saved (a rerun after a crash)
--   stale         : the saved row is newer, so this one is rejected

CREATE OR REPLACE TEMP VIEW classified AS
SELECT
  r.*,
  CASE
    WHEN c.row_id IS NULL THEN 'insert'
    WHEN c.row_id = r.row_id THEN 'already_saved'
    WHEN r.applied_on > c.applied_on
      OR (r.applied_on = c.applied_on AND r.ingested_at > c.ingested_at) THEN 'update'
    ELSE 'stale'
  END AS action
FROM ranked AS r
LEFT JOIN current_applications AS c
  ON r.email = c.email AND r.source = c.source
WHERE r.version_rank = 1;

-- ── Final outputs ───────────────────────────────────────────────────────────

CREATE OR REPLACE TEMP VIEW all_row_ids AS
SELECT row_id FROM mapped;

-- Rows to MERGE into the saved table, with what each one will do.
CREATE OR REPLACE TEMP VIEW cleaned_rows AS
SELECT
  row_id, source, full_name, email, ctc_lpa, notice_days, experience_years, skills, city,
  applied_on, referred_by, source_file, sheet_name, row_number, ingested_at, action
FROM classified
WHERE action IN ('insert', 'update');

CREATE OR REPLACE TEMP VIEW already_saved_rows AS
SELECT row_id FROM classified WHERE action = 'already_saved';

CREATE OR REPLACE TEMP VIEW rejected_rows AS
SELECT row_id, reject_reasons, raw_json, source_file, sheet_name, row_number, ingested_at
FROM validated
WHERE len(reject_reasons) > 0
UNION ALL
SELECT row_id, ['DUPLICATE_ROW'] AS reject_reasons, raw_json, source_file, sheet_name, row_number, ingested_at
FROM ranked
WHERE version_rank > 1
UNION ALL
SELECT row_id, ['OLDER_THAN_SAVED'] AS reject_reasons, raw_json, source_file, sheet_name, row_number, ingested_at
FROM classified
WHERE action = 'stale';
