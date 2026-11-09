import sqlite3
from datetime import date
from pathlib import Path

import pytest
from openpyxl import Workbook

from ingest.load_raw_files import run_ingestion
from transform.build_cleaned import ReconciliationError, build_cleaned, check_every_row_accounted
from transform.delta_io import read_table

NAUKRI = ["Candidate Name", "Email ID", "Current CTC", "Notice Period", "Total Exp", "Key Skills", "City", "Applied On"]
GOOD = ["Asha Rao", "asha@example.com", "12 LPA", "30 days", "3 yrs", "Python", "Jaipur", "2026-07-10"]


def add_file(tmp_path, sheets, name):
    """Saves a workbook in the landing folder and loads it through the real raw step."""
    landing = tmp_path / "landing"
    landing.mkdir(exist_ok=True)
    book = Workbook()
    book.remove(book.active)
    for sheet_name, rows in sheets.items():
        sheet = book.create_sheet(sheet_name)
        for row in rows:
            sheet.append(row)
    book.save(landing / name)
    run_ingestion(landing, tmp_path / "raw", tmp_path / "ops.db")


def clean(tmp_path, **kwargs):
    return build_cleaned(tmp_path / "raw", tmp_path / "cleaned", tmp_path / "ops.db", **kwargs)


def tables(tmp_path, version=None):
    cleaned = read_table(tmp_path / "cleaned" / "candidate_applications", version=version).to_pylist()
    rejected = read_table(tmp_path / "cleaned" / "rejected_rows").to_pylist()
    return cleaned, rejected


def run(tmp_path, sheets, name="a.xlsx"):
    """Loads one workbook, cleans it, and returns (summary, cleaned rows, rejected rows)."""
    add_file(tmp_path, sheets, name)
    summary = clean(tmp_path)
    return (summary, *tables(tmp_path))


def with_value(column, value, email="asha@example.com"):
    row = list(GOOD)
    row[NAUKRI.index(column)] = value
    if column != "Email ID":
        row[NAUKRI.index("Email ID")] = email
    return row


# ── Cleaning rules ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("value, expected", [
    ("12.5 LPA", 12.5), ("12.5 lakhs", 12.5), (1250000, 12.5), ("₹1,250,000", 12.5), (12.5, 12.5),
    ("Not disclosed", None), (None, None),
])
def test_ctc_formats(tmp_path, value, expected):
    _, cleaned, _ = run(tmp_path, {"Naukri": [NAUKRI, with_value("Current CTC", value)]})
    assert cleaned[0]["ctc_lpa"] == expected


@pytest.mark.parametrize("value, expected", [
    ("30 days", 30), (45, 45), ("15d", 15), ("2 months", 60), ("Immediate", 0), (None, None),
])
def test_notice_formats(tmp_path, value, expected):
    _, cleaned, _ = run(tmp_path, {"Naukri": [NAUKRI, with_value("Notice Period", value)]})
    assert cleaned[0]["notice_days"] == expected


@pytest.mark.parametrize("value, expected", [
    (4, 4.0), ("4 yrs", 4.0), ("3 years 6 months", 3.5), ("Fresher", 0.0), (None, None),
])
def test_experience_formats(tmp_path, value, expected):
    _, cleaned, _ = run(tmp_path, {"Naukri": [NAUKRI, with_value("Total Exp", value)]})
    assert cleaned[0]["experience_years"] == expected


@pytest.mark.parametrize("value", ["2026-07-10", "10/07/2026", "10-Jul-26", date(2026, 7, 10)])
def test_date_formats(tmp_path, value):
    _, cleaned, _ = run(tmp_path, {"Naukri": [NAUKRI, with_value("Applied On", value)]})
    assert cleaned[0]["applied_on"] == date(2026, 7, 10)


def test_email_city_and_skills_are_standardised(tmp_path):
    row = with_value("City", " bangalore ", email=" ASHA@EXAMPLE.COM ")
    row[NAUKRI.index("Key Skills")] = "python; powerbi | Power BI, SQL"
    _, cleaned, _ = run(tmp_path, {"Naukri": [NAUKRI, row]})
    assert cleaned[0]["email"] == "asha@example.com"
    assert cleaned[0]["city"] == "Bengaluru"
    assert list(cleaned[0]["skills"]) == ["Power BI", "Python", "SQL"]


@pytest.mark.parametrize("column, value, reason", [
    ("Email ID", None, "MISSING_EMAIL"),
    ("Email ID", "asha@", "INVALID_EMAIL"),
    ("Candidate Name", None, "MISSING_NAME"),
    ("Applied On", "not a date", "INVALID_APPLIED_DATE"),
    ("Applied On", None, "INVALID_APPLIED_DATE"),
    ("Current CTC", "ask HR", "UNREADABLE_CTC"),
    ("Notice Period", "soon", "UNREADABLE_NOTICE"),
    ("Total Exp", "many", "UNREADABLE_EXPERIENCE"),
])
def test_bad_rows_are_rejected_with_a_reason(tmp_path, column, value, reason):
    summary, cleaned, rejected = run(tmp_path, {"Naukri": [NAUKRI, with_value(column, value)]})
    assert cleaned == []
    assert list(rejected[0]["reject_reasons"]) == [reason]
    assert rejected[0]["row_number"] == 2 and "raw_json" in rejected[0]


def test_a_row_can_have_several_reasons(tmp_path):
    row = with_value("Applied On", "not a date")
    row[NAUKRI.index("Email ID")] = "bad-email"
    _, _, rejected = run(tmp_path, {"Naukri": [NAUKRI, row]})
    assert sorted(rejected[0]["reject_reasons"]) == ["INVALID_APPLIED_DATE", "INVALID_EMAIL"]


def test_duplicates_keep_the_latest_application(tmp_path):
    old = with_value("Applied On", "2026-07-01")
    new = with_value("Applied On", "2026-07-20")
    summary, cleaned, rejected = run(tmp_path, {"Naukri": [NAUKRI, new, old]})
    assert [row["applied_on"] for row in cleaned] == [date(2026, 7, 20)]
    assert list(rejected[0]["reject_reasons"]) == ["DUPLICATE_ROW"] and rejected[0]["row_number"] == 3
    assert summary["reject_reasons"] == {"DUPLICATE_ROW": 1}


def test_duplicate_email_case_is_still_a_duplicate(tmp_path):
    summary, cleaned, _ = run(tmp_path, {"Naukri": [NAUKRI, list(GOOD), with_value("Email ID", "ASHA@example.com")]})
    assert len(cleaned) == 1 and summary["reject_reasons"] == {"DUPLICATE_ROW": 1}


def test_same_person_from_two_sources_is_kept_twice(tmp_path):
    linkedin = ["Full Name", "E-mail", "CTC (LPA)", "Notice", "Experience (Years)", "Skills", "Location", "Application Date"]
    _, cleaned, _ = run(tmp_path, {"Naukri": [NAUKRI, list(GOOD)], "LinkedIn": [linkedin, list(GOOD)]})
    assert sorted(row["source"] for row in cleaned) == ["LinkedIn", "Naukri"]
    assert all(row["ctc_lpa"] == 12.0 for row in cleaned)


def test_unknown_headers_are_rejected_not_lost(tmp_path):
    summary, cleaned, rejected = run(tmp_path, {"Naukri": [["Nm", "Mail", "Pay"], ["Asha", "a@example.com", "5"]]})
    assert cleaned == []
    assert "MISSING_EMAIL" in rejected[0]["reject_reasons"]
    assert summary["raw_rows"] == summary["inserted"] + summary["rejected_rows"] == 1


# ── Safety check ──────────────────────────────────────────────────────────────

def test_every_raw_row_ends_up_in_exactly_one_output(tmp_path):
    summary, cleaned, rejected = run(tmp_path, {"Naukri": [NAUKRI, list(GOOD), list(GOOD), with_value("Email ID", "bad")]})
    ids = [row["row_id"] for row in cleaned] + [row["row_id"] for row in rejected]
    assert len(ids) == len(set(ids)) == summary["raw_rows"] == 3


@pytest.mark.parametrize("cleaned_ids, rejected_ids, saved_ids", [
    (["a"], ["b"], []),            # row c is lost
    (["a", "b"], ["b", "c"], []),  # row b appears twice
    (["a", "b"], ["c"], ["c"]),    # row c is both rejected and already saved
    (["a", "b"], ["c", "d"], []),  # row d did not come from raw
])
def test_reconciliation_catches_lost_and_repeated_rows(cleaned_ids, rejected_ids, saved_ids):
    with pytest.raises(ReconciliationError):
        check_every_row_accounted(["a", "b", "c"], cleaned_ids, rejected_ids, saved_ids)


def test_failed_check_keeps_the_previous_version(tmp_path, monkeypatch):
    run(tmp_path, {"Naukri": [NAUKRI, list(GOOD)]})
    before = read_table(tmp_path / "cleaned" / "candidate_applications").to_pylist()

    def fail(*_):
        raise ReconciliationError("forced")
    monkeypatch.setattr("transform.build_cleaned.check_every_row_accounted", fail)
    add_file(tmp_path, {"Naukri": [NAUKRI, with_value("Current CTC", "20 LPA", email="ravi@example.com")]}, "b.xlsx")
    with pytest.raises(ReconciliationError):
        clean(tmp_path)
    assert read_table(tmp_path / "cleaned" / "candidate_applications").to_pylist() == before


def test_no_raw_files_gives_a_clear_error(tmp_path):
    with pytest.raises(FileNotFoundError, match="raw loader"):
        clean(tmp_path)


# ── MERGE: changing data across runs ─────────────────────────────────────────

def test_rerun_with_no_new_files_changes_nothing(tmp_path):
    run(tmp_path, {"Naukri": [NAUKRI, list(GOOD)]})
    summary = clean(tmp_path)
    assert summary["status"] == "no_new_files" and summary["delta_version"] == 0


def test_newer_application_updates_the_saved_row(tmp_path):
    run(tmp_path, {"Naukri": [NAUKRI, list(GOOD)]})
    newer = with_value("Applied On", "2026-10-15")
    newer[NAUKRI.index("Current CTC")] = "18 LPA"
    add_file(tmp_path, {"Naukri": [NAUKRI, newer]}, "update.xlsx")

    summary = clean(tmp_path)
    cleaned, _ = tables(tmp_path)
    assert (summary["inserted"], summary["updated"], summary["delta_version"]) == (0, 1, 1)
    assert [(row["ctc_lpa"], row["applied_on"]) for row in cleaned] == [(18.0, date(2026, 10, 15))]


def test_time_travel_shows_the_value_before_the_update(tmp_path):
    run(tmp_path, {"Naukri": [NAUKRI, list(GOOD)]})
    newer = with_value("Applied On", "2026-10-15")
    newer[NAUKRI.index("Current CTC")] = "18 LPA"
    add_file(tmp_path, {"Naukri": [NAUKRI, newer]}, "update.xlsx")
    clean(tmp_path)

    old, _ = tables(tmp_path, version=0)
    assert old[0]["ctc_lpa"] == 12.0


def test_older_application_is_rejected_and_saved_row_kept(tmp_path):
    run(tmp_path, {"Naukri": [NAUKRI, list(GOOD)]})
    add_file(tmp_path, {"Naukri": [NAUKRI, with_value("Applied On", "2026-06-01")]}, "late_export.xlsx")

    summary = clean(tmp_path)
    cleaned, rejected = tables(tmp_path)
    assert (summary["updated"], summary["reject_reasons"]) == (0, {"OLDER_THAN_SAVED": 1})
    assert cleaned[0]["applied_on"] == date(2026, 7, 10)
    assert [list(row["reject_reasons"]) for row in rejected] == [["OLDER_THAN_SAVED"]]


def test_new_person_in_a_later_file_is_inserted(tmp_path):
    run(tmp_path, {"Naukri": [NAUKRI, list(GOOD)]})
    add_file(tmp_path, {"Naukri": [NAUKRI, with_value("Current CTC", "9 LPA", email="ravi@example.com")]}, "b.xlsx")
    summary = clean(tmp_path)
    cleaned, _ = tables(tmp_path)
    assert (summary["inserted"], summary["updated"]) == (1, 0)
    assert sorted(row["email"] for row in cleaned) == ["asha@example.com", "ravi@example.com"]


def test_repeating_a_run_after_a_crash_adds_nothing_twice(tmp_path):
    """Simulates a crash after saving but before the run was recorded: the same files are processed again."""
    run(tmp_path, {"Naukri": [NAUKRI, list(GOOD), with_value("Email ID", "bad")]})
    before = tables(tmp_path)
    with sqlite3.connect(tmp_path / "ops.db") as ops:
        ops.execute("DELETE FROM cleaned_files")

    summary = clean(tmp_path)
    assert summary["already_saved"] == 1 and summary["inserted"] == summary["updated"] == 0
    after = tables(tmp_path)
    assert sorted(r["row_id"] for r in after[0]) == sorted(r["row_id"] for r in before[0])
    assert sorted(r["row_id"] for r in after[1]) == sorted(r["row_id"] for r in before[1])


def test_full_rebuild_gives_the_same_result_as_incremental_runs(tmp_path):
    run(tmp_path, {"Naukri": [NAUKRI, list(GOOD)]})
    newer = with_value("Applied On", "2026-10-15")
    add_file(tmp_path, {"Naukri": [NAUKRI, newer, with_value("Email ID", "x@")]}, "update.xlsx")
    clean(tmp_path)
    incremental = tables(tmp_path)

    summary = clean(tmp_path, full_rebuild=True)
    rebuilt = tables(tmp_path)
    assert summary["mode"] == "full_rebuild" and summary["new_files"] == 2
    assert sorted(r["row_id"] for r in rebuilt[0]) == sorted(r["row_id"] for r in incremental[0])
    # Incrementally, the July row was saved and later replaced, so it lives only in the Delta history.
    # In one rebuild both rows arrive together, so the July row is rejected as a duplicate instead.
    assert sorted(reason for r in incremental[1] for reason in r["reject_reasons"]) == ["INVALID_EMAIL"]
    assert sorted(reason for r in rebuilt[1] for reason in r["reject_reasons"]) == ["DUPLICATE_ROW", "INVALID_EMAIL"]
