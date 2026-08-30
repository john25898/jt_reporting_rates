# Jamii Tekelezi — Facility Reporting Rates

An **independent** web application that reports facility reporting rates for
three MOH datasets from the national Kenya HIS (KHIS):

| Form             | Dataset (KHIS)                |
| ---------------- | ----------------------------- |
| MOH 643 B - 2023 | Annual health facility return |
| MOH 729 - 2023   | Annual health services return |
| MOH 730 B - 2023 | Annual ART/commodities return |

Reporting rate = **dataset completeness** (actual reports / expected reports)
computed by KHIS for each facility.

This app is **fully independent** of `train/` (CHAK VISTA). It has its own
folder, its own Flask app, its own `.env`, its own copy of the facility
hierarchy CSV, and its own disk cache. It does not import anything from
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

## Features

- **Cascade filter**: All Jamii Tekelezi facilities → County → Sub-County →
  Ward → specific facility (200 facilities across Embu, Meru, Nyandarua and
  Tharaka Nithi).
- **Three independent MOH sections** (tabs): MOH 643 B, MOH 729, MOH 730 B —
  each with its own summary cards (expected/actual reports, facilities
  reported, overall reporting rate) and a per-facility detail table with
  rate bars and reported/not-reported status pills.
- **Overview tab** comparing the three forms side by side.
- **Period selector** (annual periods; 2023 default).
- **Resilience**: KHIS responses are cached on disk (12h TTL), so the UI
  still renders cached rates if KHIS is down or slow. Dataset IDs are
  auto-resolved from KHIS by name and cached for 7 days.

## API

| Endpoint                                                                                  | Description                                                                                             |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                                                                         | Health check                                                                                            |
| `GET /api/locations`                                                                      | Filter hierarchy (counties, sub-counties, wards, facilities) + KHIS reachability + resolved dataset IDs |
| `GET /api/reporting-rates?period=2023&county_id=…&subcounty_id=…&ward_id=…&facility_id=…` | Per-facility expected/actual/rate for all three MOH forms                                               |

## Structure

```
jt_reporting_rates/
├── app.py            # Flask app + endpoints
├── config.py         # config, KHIS creds, MOH form definitions
├── khis_client.py    # KHIS client + completeness analytics + disk cache
├── data/
│   └── jamii_tekelezi_filters.csv   # authoritative facility hierarchy
├── static/
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── cache/            # disk cache (dataset IDs, reporting rates, OU map)
├── .env              # KHIS credentials (gitignored)
└── requirements.txt
```
