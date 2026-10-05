# Daraja & Jamii Tekelezi — Facility Reporting Rates

An **independent** web application that reports facility reporting rates and
tracer commodity consumption/balances for three MOH datasets from the national
Kenya HIS (KHIS):

| Form             | Dataset (KHIS)                                 |
| ---------------- | ---------------------------------------------- |
| MOH 643 B - 2023 | Lab / diagnostic commodity consumption (FCDRR) |
| MOH 729 - 2023   | Monthly ART / patient summary                  |
| MOH 730 B - 2023 | ARV & OI commodity consumption (CDRR)          |

Reporting rate = **dataset completeness** (actual reports / expected reports)
computed by KHIS for each facility.

This app is **fully independent** of `train/` (CHAK VISTA). It has its own
folder, its own Flask app, its own `.env`, its own copies of the facility
hierarchy CSVs, and its own disk cache. It does not import anything from
`train/`.

## Quick start

```bash
cd jt_reporting_rates
pip install -r requirements.txt
python app.py
```

Open http://localhost:5070

- Default port: **5070** (override with `JT_PORT`)
- KHIS credentials come from `.env` (`KHIS_BASE_URL`, `KHIS_USERNAME`,
  `KHIS_PASSWORD`) or process environment.

## Facility rosters (scopes)

Two rosters ship with the app; the **Scope** dropdown switches between them and
every filter, figure and chart re-resolves against the selected roster.

| Scope key | Label                       | Facilities | Counties |
| --------- | --------------------------- | ---------- | -------- |
| `daraja`  | Daraja Facilities (default) | 262        | 15       |
| `jt`      | Jamii Tekelezi Facilities   | 200        | 4        |

- `data/daraja_filters.csv` — the Daraja-supported facilities (Embu, Meru,
  Nyandarua, Tharaka Nithi, Kitui, Kiambu, Makueni, Narok, Kirinyaga,
  Machakos, Nyeri, Kajiado, Laikipia, Muranga, Nakuru).
- `data/jamii_tekelezi_filters.csv` — the original Jamii Tekelezi sites
  (Embu, Meru, Nyandarua, Tharaka Nithi).

Every id in both rosters is a KHIS national UID, so the hierarchy lines up with
what the analytics / `dataValueSets` APIs return. Override the default roster
with `JT_DEFAULT_SCOPE`, or per request via `?scope=daraja|jt`.

## Features

- **Roster + cascade filter**: Scope (Daraja / Jamii Tekelezi) → County →
  Sub-County → Ward → specific facility, plus a month selector.
- **Three independent MOH sections** (tabs): MOH 643 B, MOH 729, MOH 730 B —
  each with its own summary cards (expected/actual reports, facilities
  reported, overall reporting rate), per-metric coverage and a per-facility
  detail table with rate bars and reported/not-reported status pills.
- **Overview tab** comparing the three forms side by side, plus county and
  facility matrices.
- **Tracer commodity tracker** (homepage): each tracer is tracked individually
  with **consumed this month** and **closing balance**, plus reporting coverage.
  Clicking a tracer lists every facility in scope with that commodity's full
  column set (beginning balance, received, consumed, losses, adjustments, days
  out of stock, requested, expiring).
  - ARV tracers (MOH 730 B): TLD 90s / 30s, TAFLD 90s, TDF/FTC 30s, PaLD 90s,
    NVP suspension 100 ml / 240 ml, AZT 300 mg 60s, AZT liquid 100 ml / 240 ml.
  - Laboratory tracers (MOH 643 B): Rapid HIV 1+2 Test 1 / 2 / 3,
    HIV / Syphilis dual-kit, DBS filter papers (bundles), PPT (pcs).

  Figures are **sums across facilities**; each pack size stays a separate
  element so different units are never mixed. Totals are only ever displayed
  for the tracers listed above.

- **Resilience**: KHIS responses are cached on disk (12h TTL), so the UI still
  renders cached data if KHIS is down or slow. Dataset IDs are auto-resolved
  from KHIS by name and cached for 7 days. A failed KHIS call is never cached,
  so a transient outage cannot freeze a false "no data".

### How commodity values are read

Commodity consumption/balances are **not** separate data elements. Each
commodity is one _row_ of the form; the row's columns are
**categoryOptionCombos** of a supply-chain category combo:

| Dataset  | Category combo                  | Combo id      | Columns |
| -------- | ------------------------------- | ------------- | ------- |
| MOH 730B | `MoH 730A revision 2017`        | `Bnu4wQSxChd` | 11      |
| MOH 643B | `MOH 643 B FCDRR revision 2023` | `uBarsk8tZ3G` | 13      |

The dataset's own `categoryCombo` is the _attribute_ option combo, not the
column, so it must not be used for this mapping. Column mappings live in
`config.COMMODITY_COLUMNS`. County-wide `dataValueSets` calls with
`children=true` fetch every facility in one request per dataset.

## API

All endpoints accept `?scope=daraja|jt`, `?period=YYYYMM` and the hierarchy
filters `county_id` / `subcounty_id` / `ward_id` / `facility_id`.

| Endpoint                                       | Description                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET /api/health`                              | Health check                                                                   |
| `GET /api/locations`                           | Available scopes, filter hierarchy, KHIS reachability, dataset IDs, periods    |
| `GET /api/reporting-rates`                     | Per-facility expected/actual/rate for all three MOH forms                      |
| `GET /api/metrics-summary`                     | Per-metric reporting coverage for the tracked 2023-version metrics             |
| `GET /api/facility-metrics?facility_id=…`      | One facility's per-metric detail                                               |
| `GET /api/commodities`                         | Per-tracer totals (consumed + closing balance) and coverage, grouped ARV / LAB |
| `GET /api/commodity-facilities?commodity_id=…` | Per-facility values for every column of one tracer                             |

## Structure

```
jt_reporting_rates/
├── app.py            # Flask app + endpoints
├── config.py         # config, KHIS creds, MOH form + commodity definitions, rosters
├── khis_client.py    # KHIS client + completeness/commodity fetch + disk cache
├── data/
│   ├── daraja_filters.csv             # 262-facility Daraja roster (15 counties)
│   └── jamii_tekelezi_filters.csv     # 200-facility Jamii Tekelezi roster
├── static/
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   ├── facility.html
│   └── facility.js
├── cache/            # disk cache (dataset IDs, rates, bulk values, commodities)
├── .env              # KHIS credentials (gitignored)
└── requirements.txt
```
