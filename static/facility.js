/* Jamii Tekelezi — facility per-metric reporting page (vanilla JS) */
"use strict";

const $ = (id) => document.getElementById(id);

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function fmtMonth(ym) {
  const y = ym.slice(0, 4);
  const m = parseInt(ym.slice(4, 6), 10) - 1;
  return `${MONTH_NAMES[m] || "?"} ${y}`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

function formatNum(v) {
  if (typeof v === "number") return v.toLocaleString("en-US");
  return String(v ?? "\u2014");
}

function showError(msg) {
  $("loading").classList.add("hidden");
  const b = $("status-banner");
  b.className = "status-banner error";
  b.textContent = msg;
  b.classList.remove("hidden");
}

async function load() {
  const q = new URLSearchParams(location.search);
  const fid = q.get("facility_id");
  const period = q.get("period") || "202607";
  const scope = q.get("scope") || "daraja";
  if (!fid) {
    showError("Missing facility_id parameter.");
    return;
  }
  try {
    const res = await fetch(
      `/api/facility-metrics?facility_id=${encodeURIComponent(fid)}&period=${period}&scope=${encodeURIComponent(scope)}&cb=${Date.now()}`,
    );
    const d = await res.json();
    render(d);
  } catch (err) {
    showError(`Failed to load: ${escapeHtml(err.message)}`);
  }
}

function render(d) {
  $("loading").classList.add("hidden");
  if (!d || d.error) {
    showError((d && d.error) || "Failed to load facility metrics.");
    return;
  }
  const f = d.facility;
  const body = $("facility-body");

  $("fac-title").textContent = f.name;
  $("fac-sub").textContent =
    `${f.county_name} · ${f.subcounty_name} · ${f.ward_name} · ` +
    `${fmtMonth(d.period)} · Version ${d.version} metrics only`;

  body.innerHTML = `
    <div class="card fac-hero">
      <div>
        <h2>${escapeHtml(f.name)}</h2>
        <p class="muted">
          ${escapeHtml(f.county_name)} · ${escapeHtml(f.subcounty_name)} ·
          ${escapeHtml(f.ward_name)} · ${fmtMonth(d.period)} period
        </p>
      </div>
      <a class="btn" href="/">← Back to dashboard</a>
    </div>

    <div class="cards-grid">
      ${d.forms
        .map((fm) => {
          const pct = fm.total_metrics
            ? Math.round((100 * fm.reported_metrics) / fm.total_metrics)
            : 0;
          const cls = pct >= 80 ? "good" : pct >= 50 ? "warn" : "bad";
          return `
        <div class="card overview-card" data-form="${fm.key}">
          <h3>${escapeHtml(fm.title)} <span class="version-badge">v${escapeHtml(fm.version || "")}</span></h3>
          <div class="big-rate ${fm.total_metrics ? cls : "muted"}">${fm.total_metrics ? pct + "%" : "—"}</div>
          <div class="ov-stats">
            <span>${fm.reported_metrics} / ${fm.total_metrics} metrics reported</span>
            ${fm.unreported_metrics.length ? `<span>${fm.unreported_metrics.length} not reported</span>` : "<span>All metrics reported</span>"}
          </div>
          <div class="mini-bar"><div class="mini-fill" style="width:${pct}%"></div></div>
        </div>`;
        })
        .join("")}
    </div>

    ${d.forms.map(renderForm).join("")}
    <p class="muted small">
      Values are summed across disaggregations (category option combos) for the
      selected month. Only ${escapeHtml(d.version)}-version metrics of each
      dataset are tracked — older/newer elements are ignored.
    </p>`;

  body.querySelectorAll("[data-form]").forEach((el) => {
    el.addEventListener("click", () => {
      document
        .querySelectorAll(".form-metric-card")
        .forEach((c) => c.classList.remove("focused"));
      const card = document.getElementById(`fm-${el.dataset.form}`);
      if (card) {
        card.classList.add("focused");
        card.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });
}

function renderForm(fm) {
  const total = fm.total_metrics || 0;
  const reported = fm.reported_metrics || 0;
  const pct = total ? Math.round((100 * reported) / total) : 0;

  const rows = (fm.metrics || [])
    .map((m) => {
      const val = m.reported
        ? `<span class="metric-value ok">${formatNum(m.value)}${m.raw_count > 1 ? ` <span class="muted small">(\u03a3 ${m.raw_count})</span>` : ""}</span>`
        : `<span class="metric-unreported">Not reported</span>`;
      return `<tr class="${m.reported ? "" : "metric-miss"}">
        <td class="metric-name">${escapeHtml(m.name)}</td>
        <td class="num">${val}</td>
      </tr>`;
    })
    .join("");

  return `
    <div class="card form-metric-card" id="fm-${fm.key}">
      <div class="fhead">
        <div>
          <h3>${escapeHtml(fm.title)} <span class="version-badge">v${escapeHtml(fm.version || "")}</span></h3>
          <p class="muted small">${escapeHtml(fm.dataset_name || "")}</p>
        </div>
        <div class="fstats">
          <div class="big-rate ${total ? (pct >= 80 ? "good" : pct >= 50 ? "warn" : "bad") : "muted"}">${total ? pct + "%" : "—"}</div>
          <div class="muted small">${reported} of ${total} metrics reported</div>
          <div class="mini-bar"><div class="mini-fill" style="width:${pct}%"></div></div>
        </div>
      </div>
      <div class="fmetric-count">
        <span class="pill ${!total ? "mute" : reported === total ? "ok" : reported > 0 ? "warn-pill" : "bad"}">
          ${total ? `${reported} of ${total} metrics reported` : "No tracked metrics"}
        </span>
        <span class="muted small">Tracked version: ${escapeHtml(fm.version || "")}</span>
      </div>
      ${
        total
          ? `
      <table class="metric-table coverage-table">
        <thead><tr><th>Metric</th><th class="num">Value</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
          : `<p class="muted">No tracked metrics for this dataset.</p>`
      }
    </div>`;
}

document.addEventListener("DOMContentLoaded", load);
