"""Config for the Jamii Tekelezi Reporting Rates app.

INDEPENDENT system — lives outside train/ (CHAK VISTA). Reads KHIS
credentials from its own .env (KHIS_*) or process environment.
"""
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def _load_env(path):
    env = {}
    if os.path.exists(path):
        # utf-8-sig tolerates a UTF-8 BOM (PowerShell Set-Content writes one)
        with open(path, encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env


_ENV = _load_env(os.path.join(BASE_DIR, ".env"))


def env(key, default=None):
    return os.environ.get(key, _ENV.get(key, default))


# ---- KHIS (Kenya HIS) credentials --------------------------------------
KHIS_BASE = env("KHIS_BASE_URL", "https://hiskenya.dha.go.ke/api").rstrip("/")
KHIS_USER = env("KHIS_USERNAME", "rgngumo")
KHIS_PASS = env("KHIS_PASSWORD", "Advisorychs123!")

# ---- App server ----------------------------------------------------------
HOST = env("JT_HOST", "0.0.0.0")
PORT = int(env("JT_PORT", "5070"))

# ---- Paths ---------------------------------------------------------------
DATA_DIR = os.path.join(BASE_DIR, "data")
CACHE_DIR = os.path.join(BASE_DIR, "cache")
FILTERS_CSV = os.path.join(DATA_DIR, "jamii_tekelezi_filters.csv")
DATASET_IDS_CACHE = os.path.join(CACHE_DIR, "dataset_ids.json")
RATES_CACHE_DIR = os.path.join(CACHE_DIR, "rates")

# ---- The three MOH reporting forms ---------------------------------------
# Each is a separate dataset in KHIS; reporting rate = dataset completeness.
# ds_id values verified on KHIS (hiskenya.dha.go.ke, DHIS2 2.40.9.1):
#   NQNojl5zVko = MOH 643B FCDRR Revision 2023   (monthly, ~9244 OUs)
#   BD4tTSw9y64 = MoH 729B Facility - F'MAPS Revision 2023 (monthly, ~3981 OUs)
#   UDZ4RKvvYRt = MoH 730B Facility - CDRR Revision 2023    (monthly, ~4011 OUs)
MOH_FORMS = [
    {"key": "moh643", "title": "MOH 643 B - 2023", "search": ["643"], "ds_id": "NQNojl5zVko"},
    {"key": "moh729", "title": "MOH 729 - 2023", "search": ["729"], "ds_id": "BD4tTSw9y64"},
    {"key": "moh730", "title": "MOH 730 B - 2023", "search": ["730"], "ds_id": "UDZ4RKvvYRt"},
]

# Periods offered in the UI. The three "Revision 2023" forms are MONTHLY
# returns; KHIS completeness data for them runs from 2025-01 (2024-10 for
# 729B/730B) to the latest complete month (2026-07).
def _months(start_ym, end_ym):
    out = []
    y, m = int(start_ym[:4]), int(start_ym[4:])
    ey, em = int(end_ym[:4]), int(end_ym[4:])
    while (y, m) <= (ey, em):
        out.append(f"{y}{m:02d}")
        m += 1
        if m > 12:
            m = 1
            y += 1
    return out


PERIODS = _months("202501", "202608")
DEFAULT_PERIOD = "202607"

# ---- KHIS request behaviour ----------------------------------------------
KHIS_TIMEOUT = 150
KHIS_RETRIES = 2
RATE_CACHE_TTL_SECONDS = 12 * 3600  # cache reporting-rate payloads for 12h
IDS_CACHE_TTL_SECONDS = 7 * 24 * 3600  # dataset-id resolution for 7 days
