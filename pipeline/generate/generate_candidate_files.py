"""Generate messy, made-up recruiter workbooks for the ingestion pipeline.

Each workbook has one sheet per hiring source, and each source uses its own column names and
formats, like real exports do. All people are synthetic and every email uses a reserved domain.

Usage (from the pipeline folder):
  python -m generate.generate_candidate_files --files 3 --rows 200
  python -m generate.generate_candidate_files --update-from candidates_001.xlsx
"""
from __future__ import annotations

import argparse
import random
import re
from datetime import date, timedelta
from pathlib import Path

from openpyxl import Workbook, load_workbook

from config import LANDING_DIR

FIRST_NAMES = ["Aarav", "Diya", "Kabir", "Meera", "Rohan", "Sara", "Vivaan", "Anaya", "Ishaan", "Nisha"]
LAST_NAMES = ["Sharma", "Verma", "Iyer", "Khan", "Patel", "Gupta", "Reddy", "Das", "Mehta", "Nair"]
SKILLS = ["Python", "python", "SQL", "PySpark", "Power BI", "powerbi", "Azure", "Excel", "Databricks"]
CITIES = ["Jaipur", "jaipur ", "Bengaluru", "Bangalore", "Pune", "Gurugram", "Gurgaon"]

# Same fields, different headers per source: this is the schema drift later layers must resolve.
SHEET_COLUMNS = {
    "Naukri": ["Candidate Name", "Email ID", "Current CTC", "Notice Period", "Total Exp", "Key Skills", "City", "Applied On"],
    "LinkedIn": ["Full Name", "E-mail", "CTC (LPA)", "Notice", "Experience (Years)", "Skills", "Location", "Application Date"],
    "Referrals": ["Name", "Email", "Salary", "Notice Period (Days)", "Experience", "Skill Set", "Current City", "Referred On", "Referred By"],
}


def messy_ctc(rng: random.Random) -> object:
    lpa = round(rng.uniform(3, 18), 1)
    return rng.choice([f"{lpa} LPA", f"{lpa} lakhs", int(lpa * 100000), f"₹{int(lpa * 100000):,}", lpa, "Not disclosed", None])


def messy_notice(rng: random.Random) -> object:
    days = rng.choice([0, 15, 30, 60, 90])
    return rng.choice([f"{days} days", days, f"{days // 30} months", "Immediate" if days == 0 else f"{days}d", None])


def messy_experience(rng: random.Random) -> object:
    years = rng.randint(0, 8)
    return rng.choice([years, f"{years} yrs", f"{years} years {rng.randint(0, 11)} months", "Fresher" if years == 0 else str(years)])


def messy_date(rng: random.Random, start: date) -> object:
    day = start + timedelta(days=rng.randint(0, 90))
    return rng.choices(
        [day, day.strftime("%d/%m/%Y"), day.strftime("%Y-%m-%d"), day.strftime("%d-%b-%y"), "not a date"],
        weights=[30, 30, 20, 17, 3],
    )[0]


def messy_email(rng: random.Random, name: str) -> object:
    local = name.lower().replace(" ", ".") + str(rng.randint(1, 9999))
    email = f"{local}@example.com"
    return rng.choices(
        [email, email.upper(), f" {email} ", local, f"{local}@", None],
        weights=[80, 6, 6, 3, 3, 2],
    )[0]


def build_row(rng: random.Random, sheet: str, start: date) -> list:
    name = f"{rng.choice(FIRST_NAMES)} {rng.choice(LAST_NAMES)}"
    skills = rng.choice([", ", "; ", " | "]).join(rng.sample(SKILLS, rng.randint(1, 4)))
    row = [
        name, messy_email(rng, name), messy_ctc(rng), messy_notice(rng), messy_experience(rng),
        skills, rng.choice(CITIES), messy_date(rng, start),
    ]
    if sheet == "Referrals":
        row.append(f"{rng.choice(FIRST_NAMES)} {rng.choice(LAST_NAMES)}")
    return row


def write_workbook(path: Path, rows_per_sheet: int, rng: random.Random, start: date) -> None:
    book = Workbook()
    book.remove(book.active)
    for sheet, columns in SHEET_COLUMNS.items():
        ws = book.create_sheet(sheet)
        # Recruiters often put a title above the table, so the header is not always on row 1.
        if rng.random() < 0.5:
            ws.append([f"{sheet} export - generated {start.isoformat()}"])
            ws.append([])
        ws.append(columns)
        previous = None
        for _ in range(rows_per_sheet):
            row = build_row(rng, sheet, start)
            if previous and rng.random() < 0.03:
                row = list(previous)  # exact duplicate row
            ws.append(row)
            previous = row
            if rng.random() < 0.02:
                ws.append([])  # stray blank row
    book.create_sheet("Notes")  # an empty sheet ingestion should ignore
    book.save(path)


UPDATE_DATE = date(2026, 10, 15)  # later than every first-round application
CLEAN_EMAIL = re.compile(r"[a-z.]+[0-9]+@example\.com")


def write_update_workbook(source: Path, path: Path, rng: random.Random, changed: int = 20, new: int = 10) -> None:
    """A later Naukri export: some people from `source` with a new CTC and date, plus some new people."""
    book = load_workbook(source, read_only=True)
    try:
        rows = [list(row) for row in book["Naukri"].iter_rows(values_only=True)]
    finally:
        book.close()
    header_index = next(i for i, row in enumerate(rows) if row and row[0] == "Candidate Name")
    people = {row[1]: row for row in rows[header_index + 1:] if row and isinstance(row[1], str) and CLEAN_EMAIL.fullmatch(row[1])}

    columns = SHEET_COLUMNS["Naukri"]
    update = Workbook()
    sheet = update.active
    sheet.title = "Naukri"
    sheet.append(columns)
    for email in rng.sample(sorted(people), min(changed, len(people))):
        row = list(people[email][:len(columns)])
        row[2] = f"{round(rng.uniform(8, 25), 1)} LPA"  # new CTC
        row[7] = UPDATE_DATE  # applied again, later
        sheet.append(row)
    for _ in range(new):
        sheet.append(build_row(rng, "Naukri", UPDATE_DATE))
    update.save(path)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--files", type=int, default=3)
    parser.add_argument("--rows", type=int, default=200, help="rows per sheet")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--out", type=Path, default=LANDING_DIR)
    parser.add_argument("--update-from", metavar="FILE",
                        help="instead, write a later update file based on this workbook in --out")
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(args.seed)  # nosec B311 - makes fake test data, not security values
    if args.update_from:
        source = args.out / Path(args.update_from).name  # only files inside the landing folder
        number = 1
        while (args.out / f"candidates_update_{number:03d}.xlsx").exists():
            number += 1
        path = args.out / f"candidates_update_{number:03d}.xlsx"
        write_update_workbook(source, path, rng)
        print(f"wrote {path}")
        return

    start = date(2026, 7, 1)
    for number in range(1, args.files + 1):
        path = args.out / f"candidates_{number:03d}.xlsx"
        write_workbook(path, args.rows, rng, start)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
