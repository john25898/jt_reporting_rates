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
KHIS_USER = env("KHIS_USERNAME", "Tom Hastings")
KHIS_PASS = env("KHIS_PASSWORD", "N3sh!8112")

# ---- App server ----------------------------------------------------------
HOST = env("JT_HOST", "0.0.0.0")
PORT = int(env("JT_PORT", "5070"))

# ---- Paths ---------------------------------------------------------------
DATA_DIR = os.path.join(BASE_DIR, "data")
CACHE_DIR = os.path.join(BASE_DIR, "cache")
DATASET_IDS_CACHE = os.path.join(CACHE_DIR, "dataset_ids.json")
RATES_CACHE_DIR = os.path.join(CACHE_DIR, "rates")
VALUES_CACHE_DIR = os.path.join(CACHE_DIR, "values")  # per-facility form values
BULK_CACHE_DIR = os.path.join(CACHE_DIR, "bulk")  # county-wide metric values (few calls)
COMMODITY_CACHE_DIR = os.path.join(CACHE_DIR, "commodity")  # county tracer commodities
DEFAULT_PERIOD_CACHE = os.path.join(CACHE_DIR, "default_period.json")  # latest closed month

# ---- Facility rosters (scope selector) -----------------------------------
# Each roster is a county/sub-county/ward/facility cascade in the same
# 8-column schema. Every id is a KHIS (Kenya HIS) national UID so the
# hierarchy lines up with what the analytics/dataValueSets APIs return.
#
#   daraja  — the 259 Daraja-supported facilities (15 counties), plus the
#             handful of JT sites that are no longer in the Daraja census.
#   jt      — the original 200 Jamii Tekelezi facilities (4 counties).
SCOPES = [
    {
        "key": "daraja",
        "label": "Daraja Facilities",
        "csv": os.path.join(DATA_DIR, "daraja_filters.csv"),
    },
    {
        "key": "jt",
        "label": "Jamii Tekelezi Facilities",
        "csv": os.path.join(DATA_DIR, "jamii_tekelezi_filters.csv"),
    },
]
SCOPES_BY_KEY = {s["key"]: s for s in SCOPES}
DEFAULT_SCOPE = env("JT_DEFAULT_SCOPE", "daraja")


def filters_csv(scope=None):
    """Absolute path of the roster CSV for a scope key (defaults to default)."""
    s = SCOPES_BY_KEY.get(scope or DEFAULT_SCOPE) or SCOPES[0]
    return s["csv"]


def normalize_scope(scope=None):
    """Coerce an arbitrary scope value to a known scope key."""
    return (scope or DEFAULT_SCOPE) if (scope in SCOPES_BY_KEY) else DEFAULT_SCOPE


# Backwards-compatible default roster (used by khis_client warmly paths).
FILTERS_CSV = filters_csv()

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
# returns. KHIS completeness data for them runs from 2025-01 onward. Every
# month from that start through the CURRENT calendar month is offered (so the
# newest month is always selectable, even while it is still open).
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


def _now_ym():
    import datetime as _dt
    return _dt.date.today().strftime("%Y%m")


PERIODS = _months("202501", _now_ym())

# Fallback used ONLY when KHIS is unreachable and no previous closure check is
# cached — the normal path auto-resolves the latest *closed* month at runtime
# (khis_client), so the dashboard always opens on the most recent month that
# actually has data (today that is 202607; August 2026 is still open on KHIS).
# Set JT_DEFAULT_PERIOD to pin a specific month and skip auto-detection.
DEFAULT_PERIOD = env("JT_DEFAULT_PERIOD", "202607")

# ---- The only dataset versions tracked -----------------------------------
# The JT app tracks exactly these three form versions:
#   MOH 643 B - 2023 · MOH 729 - 2023 · MOH 730 B - 2023
# KHIS element names embed revision years (e.g. 'Rev 2023', 'Revision 2017',
# 'Rev 2026'); only metrics belonging to this target revision are tracked —
# older/newer elements carried inside the same dataset are ignored.
TARGET_REVISION = "2023"

# ---- KHIS request behaviour ----------------------------------------------
KHIS_TIMEOUT = 150
KHIS_RETRIES = 2
RATE_CACHE_TTL_SECONDS = 12 * 3600  # cache reporting-rate payloads for 12h
IDS_CACHE_TTL_SECONDS = 7 * 24 * 3600  # dataset-id resolution for 7 days
ELEMENTS_CACHE_TTL_SECONDS = 30 * 24 * 3600  # dataset data-element list for 30 days
BULK_CACHE_TTL_SECONDS = 12 * 3600  # county-wide metric value payloads for 12h
DEFAULT_PERIOD_TTL_SECONDS = 24 * 3600  # re-check latest-closed-month daily
BULK_MIN_FACILITIES = 30  # use county-wide bulk fetch above this many facilities

# --------------------------------------------------------------------------
# Tracer commodity consumption & balances
# --------------------------------------------------------------------------
# IMPORTANT KHIS data model note
# -----------------------------
# The MOH 730B (ARV) and MOH 643B (FCDRR / lab) datasets do NOT carry
# "consumption" or "closing balance" as separate data elements. Each
# commodity data element holds a full *row* of the form, and the row's
# columns are modelled as categoryOptionCombos of a supply-chain category
# combo:
#
#   MOH 730B -> categoryCombo "MoH 730A revision 2017"        (Bnu4wQSxChd)
#   MOH 643B -> categoryCombo "MOH 643 B FCDRR revision 2023" (uBarsk8tZ3G)
#
# A submitted value therefore arrives as
#   {dataElement, categoryOptionCombo, attributeOptionCombo, value}
# and the categoryOptionCombo id is what tells us which column it belongs to.
# Verified live on KHIS (hiskenya.dha.go.ke) — see COMMODITY_COLUMNS below.
COMMODITY_COLUMNS = {
    "moh730": [
        {"key": "beginning", "label": "Beginning balance", "short": "Begin", "coc": "jWmWT3Nvq1P"},
        {"key": "received", "label": "Received this month", "short": "Received", "coc": "XmKrTgYAPoi"},
        {"key": "consumed", "label": "Consumed (issued this month)", "short": "Consumed", "coc": "yP6vevc91WZ"},
        {"key": "closing", "label": "Closing balance (physical count)", "short": "Closing", "coc": "GvjV9gy3OOc"},
        {"key": "losses", "label": "Losses & wastage", "short": "Losses", "coc": "b11dZBeBzRE"},
        {"key": "adj_pos", "label": "Positive adjustments", "short": "Adj +", "coc": "LeyPc0LYjLg"},
        {"key": "adj_neg", "label": "Negative adjustments", "short": "Adj −", "coc": "O9yaDegYywr"},
        {"key": "days_oos", "label": "Days out of stock", "short": "Days OOS", "coc": "aDZLiIaG8gC"},
        {"key": "requested", "label": "Requested for resupply", "short": "Requested", "coc": "R4B7KIT1mch"},
        {"key": "expiring", "label": "Expiring in < 6 months", "short": "Expiring <6m", "coc": "r9aTy1gRXUC"},
    ],
    "moh643": [
        {"key": "beginning", "label": "Beginning balance", "short": "Begin", "coc": "nYbaIepy1Ob"},
        {"key": "received", "label": "Received (KEMSA / central)", "short": "Recd KEMSA", "coc": "q3D7NV70xRZ"},
        {"key": "received_other", "label": "Received (other sources)", "short": "Recd other", "coc": "iDoJtfFQZtZ"},
        {"key": "consumed", "label": "Total quantity used", "short": "Used", "coc": "GT5l1WUnIUy"},
        {"key": "tests", "label": "Tests done", "short": "Tests", "coc": "UzCsJyaAlMZ"},
        {"key": "closing", "label": "Closing balance (physical count)", "short": "Closing", "coc": "v5kk7lj7Ydn"},
        {"key": "losses", "label": "Losses & wastage", "short": "Losses", "coc": "o4CtkM4yc3G"},
        {"key": "qaqc", "label": "QA / QC and repeats", "short": "QA/QC", "coc": "fWYFc0H8UZQ"},
        {"key": "adj_pos", "label": "Positive adjustments", "short": "Adj +", "coc": "grvxQgJ2Ojc"},
        {"key": "adj_neg", "label": "Negative adjustments", "short": "Adj −", "coc": "A9LdZPZmKmN"},
        {"key": "days_oos", "label": "Days out of stock", "short": "Days OOS", "coc": "KN70RDRtqSC"},
        {"key": "requested", "label": "Requested for resupply", "short": "Requested", "coc": "ZpphwoaNrA8"},
        {"key": "expiring", "label": "Expiring in < 6 months", "short": "Expiring <6m", "coc": "lFgZAMaQcT6"},
    ],
}

# The two figures the homepage renders for every tracer.
COMMODITY_HIGHLIGHT_KEYS = ("consumed", "closing")

# Tracer commodities the dashboard tracks individually. Each entry is ONE
# KHIS data element (i.e. one pack size / presentation) so nothing is
# silently summed across different units.
COMMODITY_GROUPS = [
    {"key": "ARV", "label": "ARV tracer commodities", "form": "moh730",
     "form_title": "MOH 730 B - 2023", "unit_note": "packs / bottles issued & on hand"},
    {"key": "LAB", "label": "Laboratory tracer commodities", "form": "moh643",
     "form_title": "MOH 643 B - 2023", "unit_note": "tests / kits used & on hand"},
]

COMMODITY_TRACERS = [
    # ---- ARV tracers (MOH 730B Facility - CDRR) ----
    {"group": "ARV", "form": "moh730", "id": "EqZyS1EUSQc",
     "label": "TLD (TDF/3TC/DTG) 300/300/50mg — 90s"},
    {"group": "ARV", "form": "moh730", "id": "YpjdjMD6yeC",
     "label": "TLD (TDF/3TC/DTG) 300/300/50mg — 30s"},
    {"group": "ARV", "form": "moh730", "id": "CALM061sapC",
     "label": "TAFLD (TAF/3TC/DTG) 25/300/50mg — 90s"},
    {"group": "ARV", "form": "moh730", "id": "Ovk1BBcACSN",
     "label": "TDF/FTC (300/200mg) — 30s"},
    {"group": "ARV", "form": "moh730", "id": "i63W5Q15kKC",
     "label": "PaLD (ABC/3TC/DTG) 60/30/5mg — 90s"},
    {"group": "ARV", "form": "moh730", "id": "w96pwQ6povd",
     "label": "Nevirapine (NVP) suspension 10mg/ml — 100ml"},
    {"group": "ARV", "form": "moh730", "id": "SeDTXsB8p8g",
     "label": "Nevirapine (NVP) suspension 10mg/ml — 240ml"},
    {"group": "ARV", "form": "moh730", "id": "L9VlZFQZGbv",
     "label": "AZT 300mg tablets — 60s"},
    {"group": "ARV", "form": "moh730", "id": "KRY9yB58imr",
     "label": "AZT liquid 10mg/ml — 100ml"},
    {"group": "ARV", "form": "moh730", "id": "U3h59Gd6zNP",
     "label": "AZT liquid 10mg/ml — 240ml"},
    # ---- Laboratory tracers (MOH 643B FCDRR) ----
    {"group": "LAB", "form": "moh643", "id": "YOEPZvsPFPY",
     "label": "Rapid HIV 1+2 test kit — Test 1"},
    {"group": "LAB", "form": "moh643", "id": "NGzQCnV1mAG",
     "label": "Rapid HIV 1+2 test kit — Test 2"},
    {"group": "LAB", "form": "moh643", "id": "gSdD0f5RQuw",
     "label": "Rapid HIV 1+2 test kit — Test 3"},
    {"group": "LAB", "form": "moh643", "id": "gopZzm5wXbm",
     "label": "HIV / Syphilis dual-kit"},
    {"group": "LAB", "form": "moh643", "id": "eTEGUNOJeFJ",
     "label": "DBS filter papers (bundles)"},
]

# {(form, de_id): tracer dict} and {form: {coc_id: column_key}}
TRACER_BY_ELEMENT = {(t["form"], t["id"]): t for t in COMMODITY_TRACERS}
_COL_BY_COC = {
    form: {c["coc"]: c["key"] for c in cols}
    for form, cols in COMMODITY_COLUMNS.items()
}


def commodity_column_key(form, coc_id):
    """Map a categoryOptionCombo id to its column key (None when not tracked)."""
    return _COL_BY_COC.get(form, {}).get(coc_id)


def commodity_elements_for(form):
    return [t["id"] for t in COMMODITY_TRACERS if t["form"] == form]
