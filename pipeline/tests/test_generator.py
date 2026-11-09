import random

from openpyxl import load_workbook

from generate.generate_candidate_files import UPDATE_DATE, write_update_workbook, write_workbook
from datetime import date


def cells(path):
    book = load_workbook(path, read_only=True)
    try:
        return {sheet.title: [list(row) for row in sheet.iter_rows(values_only=True)] for sheet in book.worksheets}
    finally:
        book.close()


def test_same_seed_gives_the_same_workbook(tmp_path):
    write_workbook(tmp_path / "a.xlsx", 20, random.Random(7), date(2026, 7, 1))
    write_workbook(tmp_path / "b.xlsx", 20, random.Random(7), date(2026, 7, 1))
    assert cells(tmp_path / "a.xlsx") == cells(tmp_path / "b.xlsx")


def test_every_generated_email_uses_a_reserved_domain(tmp_path):
    write_workbook(tmp_path / "a.xlsx", 100, random.Random(1), date(2026, 7, 1))
    for rows in cells(tmp_path / "a.xlsx").values():
        for row in rows:
            for value in row:
                if isinstance(value, str) and "@" in value and "example.com" not in value.lower():
                    assert value.endswith("@"), value  # deliberately broken emails like 'name@'


def test_update_file_repeats_people_with_a_later_date(tmp_path):
    write_workbook(tmp_path / "a.xlsx", 60, random.Random(3), date(2026, 7, 1))
    write_update_workbook(tmp_path / "a.xlsx", tmp_path / "update.xlsx", random.Random(3), changed=5, new=2)
    original = {row[1] for row in cells(tmp_path / "a.xlsx")["Naukri"] if row and row[1]}
    update = cells(tmp_path / "update.xlsx")["Naukri"][1:]
    assert len(update) == 7
    assert sum(row[1] in original for row in update[:5]) == 5
    assert all(row[7].date() == UPDATE_DATE for row in update[:5])
