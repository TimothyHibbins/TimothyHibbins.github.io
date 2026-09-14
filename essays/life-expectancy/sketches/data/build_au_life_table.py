#!/usr/bin/env python3
"""
Builds au_life_table.json from ABS "Historical Population, 2021" datacubes
(https://www.abs.gov.au/statistics/people/population/historical-population/latest-release).

Inputs (place in ./raw/, downloaded directly from the ABS release page):
  - HPDC6_LifeExpectancy.xlsx  -> Table 5 (male qx by single age) and
                                   Table 9 (female qx by single age), both
                                   "Probability of dying between exact age x
                                   and exact age x+1", Australia, 1881 onwards.
  - HPDC4_Births.xlsx          -> Table 1, "Births registered by sex, states
                                   and territories, 1824 onwards" (we use the
                                   Person/Australia total row).

Output: au_life_table.json, a compact grid used by the hex-Lexis engine:
  years  : 5-yr-spaced calendar years, e.g. [1906, 1911, ..., 2026]
  ages   : 5-yr-spaced ages,          e.g. [0, 5, ..., 100]
  qx     : qx[yearIndex][ageIndex] = probability that a person who reaches
           `age` in `year` dies before reaching `age+5`, combined-sex
           average, using that period's ABS life table (nearest available
           period is reused where the requested year has no exact match).
  births : { year: totalAustralianBirthsInThe5YearWindowStartingThatYear }

Approximations (see essay project plan for context):
  - ABS's own qx periods are irregular (decade averages pre-1920, then
    1920-1922, ..., then near-annual from 1993-1995 onward) and only run to
    2019-2021; we snap each grid year to its nearest available ABS period,
    and hold the latest period constant for any requested years beyond it.
  - "Combined sex" qx is an unweighted average of the male and female ABS qx
    columns, since ABS doesn't publish a combined-sex qx table.
  - The 100+ age band's 5-year mortality is derived by assuming the ABS
    open-ended qx(100) is a constant annual hazard applied 5 times.
"""

import json
import re
from pathlib import Path

import openpyxl

RAW_DIR = Path(__file__).parent / "raw"
OUT_PATH = Path(__file__).parent / "au_life_table.json"

YEAR_START, YEAR_END, YEAR_STEP = 1906, 2026, 10
AGE_START, AGE_END, AGE_STEP = 0, 100, 10


def parse_period_label(label):
    """'1985-1987' -> (1985, 1987); '1920-1922' -> (1920, 1922)."""
    m = re.match(r"^(\d{4})-(\d{4})$", str(label))
    if not m:
        return None
    return int(m.group(1)), int(m.group(2))


def load_qx_table(path, sheet_name):
    """Returns (periods: list of (startYear, endYear, colIndex)), qx: {age: [values aligned to periods]}."""
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    rows = list(wb[sheet_name].iter_rows(values_only=True))
    header = rows[4]
    periods = []
    for col, label in enumerate(header):
        parsed = parse_period_label(label)
        if parsed:
            periods.append((parsed[0], parsed[1], col))

    qx_by_age = {}
    for row in rows[5:]:
        age = row[0]
        if not isinstance(age, (int, float)):
            continue
        qx_by_age[int(age)] = [row[col] for (_, _, col) in periods]
    return periods, qx_by_age


def nearest_period_index(periods, target_year):
    """Index into `periods` whose center year is closest to target_year."""
    best_i, best_dist = 0, None
    for i, (start, end, _col) in enumerate(periods):
        center = (start + end) / 2
        dist = abs(center - target_year)
        if best_dist is None or dist < best_dist:
            best_i, best_dist = i, dist
    return best_i


def qx_single_age(qx_by_age, periods, age, year, fallback_age=AGE_END):
    """Single-year qx for `age` in `year`, snapping to the nearest ABS period
    and, if that period's value is missing, searching outward for one that
    isn't."""
    age = min(age, fallback_age)
    values = qx_by_age.get(age)
    if values is None:
        return None
    order = sorted(range(len(periods)), key=lambda i: abs(((periods[i][0] + periods[i][1]) / 2) - year))
    for i in order:
        v = values[i]
        if v is not None:
            return v
    return None


def band_mortality(qx_by_age_avg, periods, age_start, year):
    """Probability of dying within the age band [age_start, age_start+AGE_STEP)
    during the AGE_STEP-yr window starting at `year`, from single-year qx."""
    if age_start >= AGE_END:
        q100 = qx_single_age(qx_by_age_avg, periods, AGE_END, year)
        if q100 is None:
            return 1.0
        survive_one_year = 1 - q100
        return 1 - survive_one_year ** AGE_STEP

    survive = 1.0
    for a in range(age_start, age_start + AGE_STEP):
        q = qx_single_age(qx_by_age_avg, periods, a, year)
        if q is None:
            q = 0.0
        survive *= (1 - q)
    return 1 - survive


def load_births_by_year(path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    rows = list(wb["Table 1"].iter_rows(values_only=True))
    header = rows[4]
    total_row = next(r for r in rows[5:] if r[0] == "Person" and str(r[1]).startswith("Australia"))
    births = {}
    for col in range(2, len(header)):
        year = header[col]
        if isinstance(year, str):
            m = re.match(r"^(\d{4})", year)
            year = int(m.group(1)) if m else None
        if isinstance(year, int) and isinstance(total_row[col], (int, float)):
            births[year] = int(total_row[col])
    return births


def main():
    male_periods, male_qx = load_qx_table(RAW_DIR / "HPDC6_LifeExpectancy.xlsx", "Table 5")
    female_periods, female_qx = load_qx_table(RAW_DIR / "HPDC6_LifeExpectancy.xlsx", "Table 9")
    assert male_periods == female_periods, "male/female qx tables use different period columns"

    # Combined-sex qx (unweighted average of male/female) per age & period.
    combined_qx = {}
    for age in male_qx:
        combined_qx[age] = [
            None if (m is None or f is None) else (m + f) / 2
            for m, f in zip(male_qx[age], female_qx[age])
        ]

    births_by_year = load_births_by_year(RAW_DIR / "HPDC4_Births.xlsx")

    years = list(range(YEAR_START, YEAR_END + 1, YEAR_STEP))
    ages = list(range(AGE_START, AGE_END + 1, AGE_STEP))

    qx_grid = [
        [band_mortality(combined_qx, male_periods, age_start, year) for age_start in ages]
        for year in years
    ]

    births = {}
    for year in years:
        window = range(year, year + YEAR_STEP)
        values = [births_by_year[y] for y in window if y in births_by_year]
        births[str(year)] = sum(values) if values else None

    # Single-year resolution for smooth survival curve calculations
    single_years = list(range(1900, 2027))
    single_ages = list(range(0, 101))
    single_qx = [
        [round(qx_single_age(combined_qx, male_periods, a, y), 6) for a in single_ages]
        for y in single_years
    ]
    single_births = {str(y): births_by_year.get(y) for y in single_years}

    out = {
        "meta": {
            "source": "ABS Historical Population, 2021 (HPDC4 Births, HPDC6 Life expectancy)",
            "yearStep": YEAR_STEP,
            "ageStep": AGE_STEP,
        },
        "years": years,
        "ages": ages,
        "qx": qx_grid,
        "births": births,
        "singleYears": single_years,
        "singleAges": single_ages,
        "singleQx": single_qx,
        "singleBirths": single_births,
    }
    OUT_PATH.write_text(json.dumps(out))
    print(f"Wrote {OUT_PATH} ({OUT_PATH.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
