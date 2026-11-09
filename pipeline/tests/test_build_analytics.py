"""Analytics layer, data checks and reports, on a small dataset whose answers are known by hand."""
import hashlib
from datetime import date

import duckdb
import pytest
from openpyxl import Workbook

from checks.data_checks import ANALYTICS_TABLES, analytics_problems, check_analytics, check_cleaned
from ingest.load_raw_files import run_ingestion
from transform.build_analytics import DataCheckError, build_analytics
from transform.build_cleaned import build_cleaned
from transform.delta_io import read_table, table_exists
from transform.run_report import run_report

NAUKRI = ["Candidate Name", "Email ID", "Current CTC", "Notice Period", "Total Exp", "Key Skills", "City", "Applied On"]
LINKEDIN = ["Full Name", "E-mail", "CTC (LPA)", "Notice", "Experience (Years)", "Skills", "Location", "Application Date"]
REFERRALS = ["Name", "Email", "Salary", "Notice Period (Days)", "Experience", "Skill Set", "Current City", "Referred On", "Referred By"]

SHEETS = {
    "Naukri": [NAUKRI,
               ["Asha Rao", "asha@example.com", "12 LPA", "30 days", 3, "Python, SQL", "Jaipur", "2026-07-10"],
               ["Ravi Kumar", "ravi@example.com", None, None, 2, "Excel", None, "2026-07-20"]],
    "LinkedIn": [LINKEDIN, ["Asha Rao", "asha@example.com", "14 LPA", "30 days", 3, "Python", "Jaipur", "2026-07-12"]],
    "Referrals": [REFERRALS, ["Meera Iyer", "meera@example.com", "8 LPA", "Immediate", 1, "Python, Power BI", "Pune",
                              "2026-07-13", "Asha Rao"]],
}


def build(tmp_path, sheets=SHEETS):
    landing = tmp_path / "landing"
    landing.mkdir(exist_ok=True)
    book = Workbook()
    book.remove(book.active)
    for name, rows in sheets.items():
        sheet = book.create_sheet(name)
        for row in rows:
            sheet.append(row)
    book.save(landing / "a.xlsx")
    run_ingestion(landing, tmp_path / "raw", tmp_path / "ops.db")
    build_cleaned(tmp_path / "raw", tmp_path / "cleaned", tmp_path / "ops.db")
    return build_analytics(tmp_path / "cleaned", tmp_path / "analytics", tmp_path / "ops.db")


def table(tmp_path, name):
    return read_table(tmp_path / "analytics" / name).to_pylist()


# ── Star schema ───────────────────────────────────────────────────────────────

def test_table_sizes_match_the_known_data(tmp_path):
    summary = build(tmp_path)
    assert summary == {
        "dim_candidate": 3, "dim_source": 3, "dim_city": 3, "dim_skill": 4,
        "dim_date": 11,  # 10 July to 20 July
        "fact_application": 4, "bridge_application_skill": 6,
    }


def test_one_person_through_two_sources_is_one_candidate_and_two_applications(tmp_path):
    build(tmp_path)
    asha = hashlib.sha256(b"asha@example.com").hexdigest()
    assert sum(row["candidate_key"] == asha for row in table(tmp_path, "fact_application")) == 2
    assert [row["full_name"] for row in table(tmp_path, "dim_candidate") if row["candidate_key"] == asha] == ["Asha Rao"]


def test_missing_city_maps_to_unknown(tmp_path):
    build(tmp_path)
    assert sorted(row["city_name"] for row in table(tmp_path, "dim_city")) == ["Jaipur", "Pune", "Unknown"]


def test_no_email_appears_anywhere_in_analytics(tmp_path):
    build(tmp_path)
    for name in ANALYTICS_TABLES:
        for row in table(tmp_path, name):
            assert not any(isinstance(value, str) and "@" in value for value in row.values()), name


def test_date_dimension_has_monday_week_starts(tmp_path):
    build(tmp_path)
    days = {row["full_date"]: row for row in table(tmp_path, "dim_date")}
    assert days[date(2026, 7, 10)]["week_start"] == date(2026, 7, 6)
    assert days[date(2026, 7, 13)]["week_start"] == date(2026, 7, 13)
    assert days[date(2026, 7, 10)]["date_key"] == 20260710


def test_keys_are_the_same_after_a_rebuild(tmp_path):
    build(tmp_path)
    first = sorted(row["application_key"] for row in table(tmp_path, "fact_application"))
    build_analytics(tmp_path / "cleaned", tmp_path / "analytics", tmp_path / "ops.db")
    assert sorted(row["application_key"] for row in table(tmp_path, "fact_application")) == first


# ── Data checks ───────────────────────────────────────────────────────────────

def test_checks_pass_on_good_data(tmp_path):
    build(tmp_path)
    assert check_analytics(tmp_path / "analytics", tmp_path / "cleaned") == []
    assert check_cleaned(tmp_path / "cleaned", tmp_path / "raw", tmp_path / "ops.db") == []


def checker_with(tmp_path, **replacements):
    """A DuckDB connection holding the saved tables, with some replaced by SQL to break them on purpose."""
    connection = duckdb.connect()
    connection.register("applications", read_table(tmp_path / "cleaned" / "candidate_applications"))
    for name in ANALYTICS_TABLES:
        connection.register(f"saved_{name}", read_table(tmp_path / "analytics" / name))
        connection.execute(f"CREATE VIEW {name} AS {replacements.get(name, f'SELECT * FROM saved_{name}')}")
    return connection


@pytest.mark.parametrize("name, broken_sql, expected", [
    ("dim_city", "SELECT * FROM saved_dim_city WHERE city_name <> 'Pune'", "no matching city"),
    ("dim_source", "SELECT * FROM saved_dim_source UNION ALL SELECT * FROM saved_dim_source", "repeated source_key"),
    ("fact_application", "SELECT * FROM saved_fact_application LIMIT 3", "fact rows differ"),
    ("bridge_application_skill", "SELECT * FROM saved_bridge_application_skill LIMIT 5", "skill links differ"),
    ("dim_date", "SELECT * FROM saved_dim_date WHERE full_date <> DATE '2026-07-20'", "no matching date"),
])
def test_checks_catch_broken_tables(tmp_path, name, broken_sql, expected):
    build(tmp_path)
    problems = analytics_problems(checker_with(tmp_path, **{name: broken_sql}))
    assert any(expected in problem for problem in problems), problems


def test_failed_check_saves_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr("transform.build_analytics.analytics_problems", lambda _: ["forced problem"])
    with pytest.raises(DataCheckError, match="forced problem"):
        build(tmp_path)
    assert not any(table_exists(tmp_path / "analytics" / name) for name in ANALYTICS_TABLES)


def test_empty_cleaned_table_is_refused(tmp_path):
    with pytest.raises(DataCheckError, match="empty"):
        build(tmp_path, {"Naukri": [NAUKRI, ["Asha", "not-an-email", "1", "1", 1, "x", "Jaipur", "2026-07-10"]]})


def test_cleaned_check_flags_a_mostly_rejected_batch(tmp_path):
    with pytest.raises(DataCheckError):
        build(tmp_path, {"Naukri": [NAUKRI, ["Asha", "bad", "1", "1", 1, "x", "Jaipur", "2026-07-10"]]})
    problems = check_cleaned(tmp_path / "cleaned", tmp_path / "raw", tmp_path / "ops.db")
    assert any("rejected 1 of 1 rows" in problem for problem in problems)


def test_cleaned_check_flags_raw_files_not_cleaned_yet(tmp_path):
    build(tmp_path)
    (tmp_path / "landing" / "b.csv").write_text("Name,Email,CTC\nZoya,zoya@example.com,5\n", encoding="utf-8")
    run_ingestion(tmp_path / "landing", tmp_path / "raw", tmp_path / "ops.db")
    problems = check_cleaned(tmp_path / "cleaned", tmp_path / "raw", tmp_path / "ops.db")
    assert any("not cleaned yet: 1" in problem for problem in problems)


# ── Reports ───────────────────────────────────────────────────────────────────

def report(tmp_path, name):
    return run_report(name, tmp_path / "analytics").to_pylist()


def test_weekly_report_counts_and_running_total(tmp_path):
    build(tmp_path)
    rows = [(r["source_name"], r["week_start"], r["applications"], int(r["running_total"]))
            for r in report(tmp_path, "weekly_applications")]
    assert rows == [
        ("LinkedIn", date(2026, 7, 6), 1, 1),
        ("Naukri", date(2026, 7, 6), 1, 1), ("Naukri", date(2026, 7, 20), 1, 2),
        ("Referrals", date(2026, 7, 13), 1, 1),
    ]


def test_ctc_report_shows_how_many_values_the_average_uses(tmp_path):
    build(tmp_path)
    rows = [(r["city_name"], r["source_name"], r["ctc_reported"], r["avg_ctc_lpa"])
            for r in report(tmp_path, "ctc_by_city_source")]
    assert rows == [("Jaipur", "LinkedIn", 1, 14.0), ("Jaipur", "Naukri", 1, 12.0),
                    ("Pune", "Referrals", 1, 8.0), ("Unknown", "Naukri", 0, None)]


def test_top_skills_keeps_ties(tmp_path):
    build(tmp_path)
    rows = [(r["city_name"], r["skill_rank"], r["skill_name"]) for r in report(tmp_path, "top_skills_by_city")]
    assert rows == [("Jaipur", 1, "Python"), ("Jaipur", 2, "SQL"),
                    ("Pune", 1, "Power BI"), ("Pune", 1, "Python"), ("Unknown", 1, "Excel")]


def test_notice_report_percentages_add_up_per_source(tmp_path):
    build(tmp_path)
    rows = [(r["source_name"], r["notice_bucket"], r["pct_of_source"]) for r in report(tmp_path, "notice_by_source")]
    assert rows == [("LinkedIn", "1-30 days", 100.0), ("Naukri", "1-30 days", 50.0),
                    ("Naukri", "Not given", 50.0), ("Referrals", "Immediate", 100.0)]


@pytest.mark.parametrize("name", ["../../etc/passwd", "weekly_applications.sql", "DROP TABLE x"])
def test_only_known_reports_can_run(tmp_path, name):
    with pytest.raises(ValueError, match="Unknown report"):
        run_report(name, tmp_path / "analytics")
