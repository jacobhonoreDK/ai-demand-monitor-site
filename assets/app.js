/* AI Demand Monitor – frontend. Læser data/scores.json, data/manual.json og data/run_log.json. */
(function () {
  "use strict";

  const NF = (d) => new Intl.NumberFormat("da-DK", { minimumFractionDigits: d, maximumFractionDigits: d });
  const STATUS_LABEL = { active: "Aktiv", stale: "Forældet", insufficient: "Opbygger historik", missing: "Mangler data" };
  const LAYER_KEYS = ["volume", "price", "capacity", "cloud", "capex"];
  const GPU_ORDER = ["H100", "H200", "B200", "B300"];
  const state = { scores: null, manual: null, runlog: null, openLayer: null, charts: {} };

  // ---------------------------------------------------------------- hjælpere
  const $ = (id) => document.getElementById(id);
  function el(tag, attrs, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null) continue;
      if (k === "class") n.className = v;
      else if (k === "style") n.style.cssText = v;
      else n.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null) continue;
      n.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
    return n;
  }
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const num = (v, d = 1) => (v == null || isNaN(v) ? "–" : NF(d).format(v));
  const signed = (v, d = 1) => (v == null || isNaN(v) ? "–" : (v > 0 ? "+" : v < 0 ? "−" : "") + NF(d).format(Math.abs(v)));

  function fmtValue(v, unit) {
    if (v == null) return "–";
    if (unit === "%") return signed(v, 1) + " %";
    if (unit === "pp") return signed(v, 1) + " pp";
    if (unit === "ratio") return num(v, 2);
    if (unit === "antal") return num(v, 0);
    return num(v, 2);
  }

  function compact(v, unit) {
    if (v == null) return "–";
    const a = Math.abs(v);
    const scale = (div, suffix, d = 1) => num(v / div, d) + " " + suffix;
    let s;
    if (a >= 1e15) s = scale(1e15, "brd.", 2);
    else if (a >= 1e12) s = scale(1e12, "bio.", 2);
    else if (a >= 1e9) s = scale(1e9, "mia.", 1);
    else if (a >= 1e6) s = scale(1e6, "mio.", 1);
    else s = num(v, a < 10 ? 2 : 0);
    if (unit === "USD") return s + " USD";
    if (unit === "KRW") return s + " KRW";
    if (unit === "kTWD") return num(v / 1e6, 1) + " mia. TWD";
    if (unit === "pct") return num(v, 0) + " %";
    if (unit && unit.startsWith("tokens")) return s + " " + unit;
    if (unit && unit.startsWith("USD/")) return num(v, 2) + " " + unit;
    return s;
  }

  const fmtDate = (s) => (s ? new Date(s + (s.length === 10 ? "T00:00:00" : "")).toLocaleDateString("da-DK", { day: "numeric", month: "short", year: "numeric" }) : "–");
  const shortDate = (s) => new Date(s + "T00:00:00").toLocaleDateString("da-DK", { day: "numeric", month: "short" });
  const monthDate = (s) => new Date(s + "T00:00:00").toLocaleDateString("da-DK", { month: "short", year: "2-digit" });

  function scoreColor(score) {
    if (score == null) return css("--neutral");
    if (score > 0.5) return css("--pos");
    if (score < -0.5) return css("--neg");
    return css("--axis");
  }

  function healthBand(h) {
    if (h == null) return "Ingen data";
    if (h >= 65) return "Over normalt";
    if (h >= 55) return "Lidt over normalt";
    if (h > 45) return "Normalt niveau";
    if (h > 35) return "Lidt under normalt";
    return "Under normalt";
  }

  // ---------------------------------------------------------------- tooltip (sparklines)
  const tip = () => $("tooltip");
  function showTip(evt, strong, label) {
    const t = tip();
    t.replaceChildren(el("strong", {}, strong), el("div", { class: "muted" }, label));
    t.hidden = false;
    const x = Math.min(evt.clientX + 12, window.innerWidth - t.offsetWidth - 8);
    t.style.left = x + "px";
    t.style.top = evt.clientY + 14 + "px";
  }
  const hideTip = () => { tip().hidden = true; };

  // ---------------------------------------------------------------- sparkline (SVG)
  function sparkline(points, opts) {
    const { ref = 0, min, max, format = (v) => num(v, 2), height = 32 } = opts || {};
    const W = 300, H = height, pad = 4;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("preserveAspectRatio", "none");
    const vals = points.map((p) => p.v).filter((v) => v != null);
    if (!vals.length) return svg;
    const lo = min != null ? min : Math.min(ref, ...vals);
    const hi = max != null ? max : Math.max(ref, ...vals);
    const span = hi - lo || 1;
    const x = (i) => pad + (i / Math.max(points.length - 1, 1)) * (W - 2 * pad);
    const y = (v) => H - pad - ((v - lo) / span) * (H - 2 * pad);
    const refLine = document.createElementNS(ns, "line");
    Object.entries({ x1: 0, x2: W, y1: y(ref), y2: y(ref), stroke: css("--grid"), "stroke-width": 1, "vector-effect": "non-scaling-stroke" })
      .forEach(([k, v]) => refLine.setAttribute(k, v));
    svg.appendChild(refLine);
    let d = "", pen = false;
    points.forEach((p, i) => {
      if (p.v == null) { pen = false; return; }
      d += (pen ? "L" : "M") + x(i).toFixed(1) + " " + y(p.v).toFixed(1) + " ";
      pen = true;
    });
    const path = document.createElementNS(ns, "path");
    Object.entries({ d, fill: "none", stroke: css("--accent"), "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round", "vector-effect": "non-scaling-stroke" })
      .forEach(([k, v]) => path.setAttribute(k, v));
    svg.appendChild(path);
    // hover: nærmeste punkt
    svg.addEventListener("pointermove", (e) => {
      const r = svg.getBoundingClientRect();
      const i = Math.round(((e.clientX - r.left) / r.width) * (points.length - 1));
      const p = points[Math.max(0, Math.min(points.length - 1, i))];
      if (p) showTip(e, p.v == null ? "–" : format(p.v), fmtDate(p.d));
    });
    svg.addEventListener("pointerleave", hideTip);
    return svg;
  }

  // ---------------------------------------------------------------- Chart.js fælles
  const crosshair = {
    id: "crosshair",
    afterDatasetsDraw(chart) {
      const a = chart.tooltip && chart.tooltip.getActiveElements();
      if (!a || !a.length) return;
      const { ctx, chartArea } = chart;
      const x = a[0].element.x;
      ctx.save();
      ctx.strokeStyle = css("--axis");
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
      ctx.restore();
    },
  };

  function baseOptions(yFormat, extra) {
    const text2 = css("--text-2"), grid = css("--grid");
    return Object.assign({
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: css("--surface"), borderColor: css("--axis"), borderWidth: 1,
          titleColor: text2, bodyColor: css("--text"), padding: 10, boxWidth: 14, boxHeight: 2,
          usePointStyle: false, titleFont: { weight: "normal" }, bodyFont: { weight: "600" },
          callbacks: { label: (c) => ` ${yFormat(c.parsed.y)}  ${c.dataset.label}` },
        },
      },
      scales: {
        x: { grid: { display: false }, border: { color: css("--axis") }, ticks: { color: text2, maxRotation: 0, autoSkipPadding: 16 } },
        y: { grid: { color: grid }, border: { display: false }, ticks: { color: text2, callback: (v) => yFormat(v) } },
      },
    }, extra || {});
  }

  function lineDataset(label, data, color, few) {
    return {
      label, data, borderColor: color, backgroundColor: color, borderWidth: 2, tension: 0.15,
      pointRadius: few ? 4 : 0, pointHoverRadius: 5, pointBorderColor: css("--surface"), pointBorderWidth: 2,
      spanGaps: true,
    };
  }

  function mkChart(id, config) {
    if (state.charts[id]) state.charts[id].destroy();
    const ctx = $(id);
    if (!ctx || !window.Chart) return null;
    config.plugins = [crosshair];
    state.charts[id] = new Chart(ctx, config);
    return state.charts[id];
  }

  function legend(target, items) {
    $(target).replaceChildren(...items.map(([label, color]) => el("span", {}, el("i", { style: `background:${color}` }), label)));
  }

  function tableView(target, headers, rows) {
    const t = el("table", { class: "data-table" },
      el("thead", {}, el("tr", {}, headers.map((h) => el("th", {}, h)))),
      el("tbody", {}, rows.map((r) => el("tr", {}, r.map((c, i) => el("td", { class: i ? "num" : null }, c))))));
    $(target).replaceChildren(t);
  }

  // ---------------------------------------------------------------- oversigt
  function renderHeader() {
    const s = state.scores, rl = state.runlog;
    const last = rl && rl.last_run ? ` · seneste kørsel ${new Date(rl.last_run.at).toLocaleString("da-DK", { dateStyle: "medium", timeStyle: "short" })}` : "";
    $("asof").textContent = `Data pr. ${fmtDate(s.as_of)}${last}`;
  }

  function renderHero() {
    const s = state.scores, h = s.health.score;
    $("health-value").textContent = h == null ? "–" : num(h, 0);
    $("health-band").textContent = healthBand(h);
    const ls = Object.values(s.layers);
    const used = ls.filter((l) => l.score != null);
    const wUsed = used.reduce((a, l) => a + l.weight, 0), wAll = ls.reduce((a, l) => a + l.weight, 0);
    $("health-coverage").textContent = `Beregnet på ${used.length} af ${ls.length} lag (${num((wUsed / wAll) * 100, 0)} % af lagvægten)`;
    const pts = s.health.history.map((p) => ({ d: p.date, v: p.score }));
    $("health-spark").replaceChildren(sparkline(pts, { ref: 50, min: 0, max: 100, height: 48, format: (v) => num(v, 0) }));
    $("summary-text").textContent = s.summary;
  }

  function renderSignals() {
    const colors = { red: css("--critical"), orange: css("--serious"), green: css("--good") };
    const order = (x) => (x.active === true ? 0 : x.active === null ? 2 : 1);
    const items = [...state.scores.signals].sort((a, b) => order(a) - order(b)).map((sg) => {
      const stateLabel = sg.active === true ? "Aktiv" : sg.active === false ? "Ikke aktiv" : "Utilstrækkelige data";
      const cls = sg.active === true ? "signal active" : sg.active === false ? "signal inactive" : "signal inactive-unknown";
      return el("li", { class: cls, style: `--sig-color:${colors[sg.level]}` },
        el("span", { class: "sig-emoji", "aria-hidden": "true" }, sg.emoji),
        el("strong", {}, sg.title),
        el("span", { class: "sig-state" }, stateLabel),
        // "Utilstrækkelige data" står allerede i status-pillen; vis kun forklaringen
        el("span", { class: "sig-detail" }, sg.active === null ? sg.detail.replace(/^Utilstrækkelige data\s*/, "").replace(/^\((.*)\)$/, "$1") || "–" : sg.detail),
        sg.explain ? el("details", { class: "sig-why" }, el("summary", {}, "Hvad betyder signalet?"), el("p", {}, sg.explain)) : null);
    });
    $("signals").replaceChildren(...items);
  }

  function renderLayers() {
    const s = state.scores;
    const arrows = { up: "↑", down: "↓", flat: "→" };
    const cards = LAYER_KEYS.filter((k) => s.layers[k]).map((k) => {
      const l = s.layers[k];
      const scoreEl = l.score == null
        ? el("div", { class: "layer-score na" }, "Opbygger historik")
        : el("div", { class: "layer-score" }, signed(l.score, 2), l.direction ? el("span", { class: "arrow", title: "Retning over 4 uger" }, arrows[l.direction]) : null);
      const pts = l.history.map((p) => ({ d: p.date, v: p.score }));
      const btn = el("button", {
        class: "layer", type: "button", "aria-expanded": String(state.openLayer === k),
        "aria-controls": "layer-detail", style: `--layer-color:${scoreColor(l.score)}`,
      },
        el("span", { class: "layer-name" }, l.name),
        l.description ? el("span", { class: "layer-q" }, l.description.split("?")[0] + "?") : null,
        scoreEl,
        el("div", { class: "layer-spark", "aria-hidden": "true" }, sparkline(pts, { ref: 0, min: -3, max: 3, format: (v) => signed(v, 2) })),
        el("div", { class: "layer-cov" }, `${l.active}/${l.total} indikatorer aktive · vægt ${num(l.weight * 100, 0)} %`),
        el("div", { class: "cov-bar" }, el("span", { style: `width:${(l.coverage_weight * 100).toFixed(0)}%` })));
      btn.addEventListener("click", () => {
        state.openLayer = state.openLayer === k ? null : k;
        renderLayers();
        renderLayerDetail();
        if (state.openLayer) $("layer-detail").scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
      return btn;
    });
    $("layers").replaceChildren(...cards);
  }

  function renderLayerDetail() {
    const box = $("layer-detail");
    Object.keys(state.charts).filter((k) => k.startsWith("ind-")).forEach((k) => { state.charts[k].destroy(); delete state.charts[k]; });
    const k = state.openLayer;
    if (!k) { box.hidden = true; box.replaceChildren(); return; }
    const s = state.scores, l = s.layers[k];
    const close = el("button", { class: "ghost-btn", type: "button" }, "Luk");
    close.addEventListener("click", () => { state.openLayer = null; renderLayers(); renderLayerDetail(); });
    const cards = l.indicators.map((id) => indicatorCard(id, s.indicators[id]));
    const intro = el("div", { class: "detail-intro" },
      l.description ? el("p", {}, l.description) : null,
      l.reading ? el("p", { class: "muted small" }, l.reading) : null);
    box.replaceChildren(
      el("div", { class: "detail-head" },
        el("div", {}, el("h3", {}, l.name), el("p", { class: "muted small", style: "margin:2px 0 0" },
          l.score == null ? "Ingen aktive indikatorer endnu." : `Lagscore ${signed(l.score, 2)} (vægtet gennemsnit af fortegnsjusterede z-scorer, ±3)`)),
        close),
      intro,
      el("div", { class: "ind-grid" }, cards));
    box.hidden = false;
    l.indicators.forEach((id) => drawIndicatorChart(id, s.indicators[id]));
  }

  function indicatorCard(id, ind) {
    const st = ind.scored === false && ind.status === "active" ? "Kun signal" : STATUS_LABEL[ind.status];
    const chipCls = ind.status === "active" ? "chip active" : ind.status === "stale" ? "chip stale" : "chip";
    let reason = null;
    if (ind.status === "stale") reason = `Seneste observation ${fmtDate(ind.last_date)} er for gammel – udeladt af scoren.`;
    if (ind.status === "insufficient") reason = `${ind.obs_count || ind.series.length} observation(er) – kræver mere historik før z-score.`;
    if (ind.status === "missing") reason = "Ingen data endnu.";
    const last = ind.series.length ? ind.series[ind.series.length - 1] : null;
    return el("article", { class: `ind is-${ind.status}` },
      el("div", { class: "ind-top" }, el("span", { class: "ind-name" }, ind.name), el("span", { class: chipCls }, st)),
      el("div", { class: "ind-nums" },
        el("div", {}, el("span", { class: "k" }, "Seneste værdi"), el("span", { class: "v" }, fmtValue(ind.last_value, ind.unit))),
        el("div", {}, el("span", { class: "k" }, "z-score"), el("span", { class: "v" }, ind.z == null ? "–" : signed(ind.z, 2))),
        el("div", {}, el("span", { class: "k" }, "Bidrag"), el("span", { class: "v" }, ind.contribution == null ? "–" : signed(ind.contribution, 2)))),
      ind.series.length > 1 ? el("div", { class: "ind-chart" }, el("canvas", { id: "ind-" + id, "aria-label": ind.name })) : null,
      ind.explain ? el("p", { class: "ind-explain" }, ind.explain) : null,
      el("div", { class: "ind-meta" },
        reason ? el("p", {}, reason) : null,
        el("p", {}, `Fortegn ${ind.polarity > 0 ? "+1" : "−1"}: ${ind.polarity_note}`),
        el("p", {}, `Kilde: ${ind.source} · periode ${fmtDate(ind.last_date)}` +
          (last && last.available && last.available !== last.date ? ` · offentlig ${fmtDate(last.available)}` : ""))));
  }

  function drawIndicatorChart(id, ind) {
    if (ind.series.length < 2) return;
    const ser = ind.series.slice(-60);
    const freq = ind.frequency;
    const labels = ser.map((p) => (freq === "weekly" ? shortDate(p.date) : monthDate(p.date)));
    const color = ind.status === "active" ? css("--s1") : css("--stale");
    const opts = baseOptions((v) => fmtValue(v, ind.unit));
    opts.plugins.tooltip.callbacks = {
      title: (c) => fmtDate(ser[c[0].dataIndex].date),
      label: (c) => {
        const p = ser[c.dataIndex];
        return ` ${fmtValue(p.value, ind.unit)}   z = ${p.z == null ? "–" : signed(p.z, 2)}`;
      },
    };
    opts.scales.x.ticks.maxTicksLimit = 5;
    opts.scales.y.ticks.maxTicksLimit = 4;
    state.charts["ind-" + id] = mkChart("ind-" + id, {
      type: "line",
      data: { labels, datasets: [lineDataset(ind.name, ser.map((p) => p.value), color, ser.length < 12)] },
      options: opts,
    });
  }

  function renderVolumeChart() {
    // Begge linjer fra samme kilde: de 20 største modeller per uge (volumen og estimeret forbrug)
    const vs = state.scores.charts.volume_vs_spend || [];
    const dates = vs.map((p) => p.date);
    const vol = vs.map((p) => p.volume_index);
    const sp = vs.map((p) => p.spend_index);
    const s1 = css("--s1"), s2 = css("--s2");
    const fmt = (v) => num(v, 0);
    const opts = baseOptions(fmt);
    opts.plugins.tooltip.callbacks = {
      title: (x) => "Uge til " + fmtDate(dates[x[0].dataIndex]),
      label: (x) => ` ${num(x.parsed.y, 0)}  ${x.dataset.label}`,
      afterBody: (x) => {
        const p = vs[x[0].dataIndex];
        return p ? `Gns. pris $${num(p.blended_usd_per_mtok, 2)} per 1M tokens` : "";
      },
    };
    opts.scales.y.type = "logarithmic";
    opts.scales.y.ticks.callback = (v) => (/^[125]0*$/.test(String(v)) ? fmt(v) : "");
    mkChart("chart-volume", {
      type: "line",
      data: { labels: dates.map(shortDate), datasets: [lineDataset("Tokenvolumen", vol, s1, vs.length < 6), lineDataset("Estimeret forbrug (USD)", sp, s2, vs.length < 6)] },
      options: opts,
    });
    legend("legend-volume", [["Tokenvolumen", s1], ["Estimeret forbrug (USD)", s2]]);
    const last = vs[vs.length - 1];
    $("note-volume").textContent = vs.length < 4
      ? `Forbrugsserien opbygges: ${vs.length} uge(r) med prisdata.`
      : `Siden ${fmtDate(dates[0])}: volumen ×${num(last.volume_index / 100, 1)}, forbrug ×${num(last.spend_index / 100, 1)} – ` +
        `gennemsnitsprisen per token er faldet ${num((1 - last.spend_index / last.volume_index) * 100, 0)} %. ` +
        "Logaritmisk akse. De 20 største modeller på OpenRouter per uge; historik før okt. 2026 fra arkiverede sider.";
    tableView("table-chart-volume", ["Uge til", "Volumen (indeks)", "Forbrug (indeks)", "USD per 1M tokens"],
      vs.map((p) => [fmtDate(p.date), num(p.volume_index, 1), num(p.spend_index, 1), "$" + num(p.blended_usd_per_mtok, 3)]).reverse());
  }

  function renderGpuChart() {
    const g = state.scores.charts.gpu_prices || {};
    const gpus = GPU_ORDER.filter((k) => g[k] && g[k].length);
    const dates = [...new Set(gpus.flatMap((k) => g[k].map((p) => p.date)))].sort();
    const colors = [css("--s1"), css("--s2"), css("--s3"), css("--s4")];
    const few = dates.length < 6;
    const ds = gpus.map((k) => {
      const m = Object.fromEntries(g[k].map((p) => [p.date, p.median]));
      return lineDataset(k, dates.map((d) => (m[d] == null ? null : m[d])), colors[GPU_ORDER.indexOf(k)], few);
    });
    const fmt = (v) => "$" + num(v, 2);
    const opts = baseOptions(fmt);
    opts.plugins.tooltip.callbacks = { title: (x) => fmtDate(dates[x[0].dataIndex]), label: (x) => ` ${fmt(x.parsed.y)}  ${x.dataset.label}` };
    opts.scales.y.beginAtZero = true;
    opts.scales.x.offset = few;  // få målinger: centrér punkterne i stedet for at klemme dem mod kanten
    mkChart("chart-gpu", { type: "line", data: { labels: dates.map(shortDate), datasets: ds }, options: opts });
    legend("legend-gpu", gpus.map((k) => [k, colors[GPU_ORDER.indexOf(k)]]));
    $("note-gpu").textContent = dates.length < 8
      ? `Historikken opbygges: ${dates.length} måling(er) siden ${fmtDate(dates[0])}. Kapacitetslaget scorer først efter ca. 12 ugentlige målinger.`
      : "";
    const prov = state.scores.charts.gpu_prices_by_provider || [];
    tableView("table-chart-gpu", ["Udbyder · GPU · type (seneste måling)", "USD/GPU-time", "Lager / dato"],
      prov.sort((a, b) => GPU_ORDER.indexOf(a.gpu) - GPU_ORDER.indexOf(b.gpu) || a.provider.localeCompare(b.provider))
        .map((r) => [`${r.provider} · ${r.gpu} · ${r.price_type.replace("_", "-")}`, r.usd_per_gpu_hr == null ? "–" : "$" + num(r.usd_per_gpu_hr, 2), r.availability || (r.n_offers != null ? r.n_offers + " tilbud" : fmtDate(r.date))]));
  }

  function renderMarket() {
    const m = state.scores.market_control, box = $("market");
    if (!m || !m.available) { box.replaceChildren(el("p", { class: "muted" }, "Ingen markedsdata.")); return; }
    const tiles = Object.entries(m.relative_return_pp).map(([t, v]) =>
      el("div", { class: "tile" }, el("div", { class: "k" }, `${t} vs. SPY`), el("div", { class: "v" }, v == null ? "–" : signed(v, 1) + " pp")));
    box.replaceChildren(
      el("p", { style: "margin:0" }, el("strong", {}, m.text)),
      el("div", { class: "market-grid" }, tiles),
      el("p", { class: "muted small", style: "margin:0" },
        `Relativt afkast over ${m.lookback_days} dage. Markedets z-score ${m.market_z == null ? "–" : signed(m.market_z, 2)} ` +
        `(relativ styrke mod egen 52-ugers historik) mod fundamental z-score ${m.fundamental_z == null ? "–" : signed(m.fundamental_z, 2)}.`));
  }

  // ---------------------------------------------------------------- manuelle input
  function renderManual() {
    const m = state.manual;
    const tbl = $("manual-table");
    if (!m) { tbl.replaceChildren(el("tr", {}, el("td", {}, "data/manual.json mangler – kør python -m pipeline.manual"))); return; }
    const layerName = (n) => (state.scores && state.scores.layers[LAYER_KEYS[n - 1]] ? state.scores.layers[LAYER_KEYS[n - 1]].name : "Lag " + n);
    const rows = Object.entries(m.series).sort((a, b) => (b[1].status.due - a[1].status.due) || (a[1].layer - b[1].layer));
    let due = 0;
    const body = rows.map(([key, s]) => {
      const pts = s.points || [];
      const last = pts[pts.length - 1];
      if (s.status.due) due++;
      const src = last && /^https?:\/\//.test(last.source) ? el("a", { href: last.source, target: "_blank", rel: "noopener noreferrer" }, "kilde") : "–";
      const val = !last ? "–" : s.kind === "guidance" ? `${last.company} ${compact(last.value, s.unit)}` : compact(last.value, s.unit);
      return el("tr", { class: s.status.due ? "due" : null },
        el("td", {}, el("strong", {}, s.description), el("div", { class: "muted small" }, key)),
        el("td", {}, layerName(s.layer)),
        el("td", { class: "num" }, last ? fmtDate(last.period_end) : "–"),
        el("td", { class: "num" }, val),
        el("td", {}, last && last.confidence ? last.confidence : "–"),
        el("td", {}, src),
        el("td", {}, el("span", { class: "status-pill" }, s.status.due ? "⚠ Mangler" : "✓ Opdateret"),
          s.status.reason ? el("div", { class: "muted small" }, s.status.reason) : null));
    });
    tbl.replaceChildren(
      el("thead", {}, el("tr", {}, ["Serie", "Lag", "Seneste periode", "Seneste værdi", "Sikkerhed", "Kilde", "Status"].map((h) => el("th", {}, h)))),
      el("tbody", {}, body));
    const b = $("manual-badge");
    b.hidden = due === 0;
    b.textContent = due;
    b.title = `${due} serier mangler opdatering`;
  }

  // ---------------------------------------------------------------- datastatus
  function renderStatus() {
    const rl = state.runlog, tbl = $("sources-table");
    const icon = { ok: "✓ OK", warning: "⚠ Advarsel", skipped: "⏭ Sprunget over", failed: "✕ Fejlet" };
    let failed = 0;
    if (!rl) {
      tbl.replaceChildren(el("tr", {}, el("td", {}, "data/run_log.json mangler.")));
    } else {
      const rows = Object.values(rl.sources).sort((a, b) => a.source.localeCompare(b.source)).map((r) => {
        if (r.status === "failed") failed++;
        const added = r.datasets ? Object.entries(r.datasets).map(([k, v]) => `${k}: +${v.added}`).join(", ") : "";
        const msgs = [r.error, ...(r.warnings || []).slice(0, 4)].filter(Boolean);
        return el("tr", {},
          el("td", {}, el("strong", {}, r.source)),
          el("td", {}, el("span", { class: "status-pill" }, icon[r.status] || r.status)),
          el("td", { class: "num" }, new Date(r.started_at).toLocaleString("da-DK", { dateStyle: "short", timeStyle: "short" })),
          el("td", {}, added || "–"),
          el("td", {}, msgs.length ? msgs.map((m) => el("div", { class: "muted small" }, m)) : "–"));
      });
      const post = Object.entries(rl.postprocess || {}).map(([k, v]) => {
        if (v.status === "failed") failed++;
        return el("tr", {}, el("td", {}, el("strong", {}, k)), el("td", {}, el("span", { class: "status-pill" }, icon[v.status] || v.status)),
          el("td", { class: "num" }, new Date(v.at).toLocaleString("da-DK", { dateStyle: "short", timeStyle: "short" })), el("td", {}, "–"), el("td", {}, v.error || "–"));
      });
      tbl.replaceChildren(
        el("thead", {}, el("tr", {}, ["Kilde", "Status", "Kørt", "Nye records", "Fejl og advarsler"].map((h) => el("th", {}, h)))),
        el("tbody", {}, rows, post));
    }
    const b = $("status-badge");
    b.hidden = failed === 0;
    b.textContent = failed;

    const inds = Object.entries(state.scores.indicators).filter(([, v]) => v.status !== "active");
    $("excluded-table").replaceChildren(
      el("thead", {}, el("tr", {}, ["Indikator", "Lag", "Status", "Seneste periode"].map((h) => el("th", {}, h)))),
      el("tbody", {}, inds.map(([, v]) => el("tr", {},
        el("td", {}, v.name), el("td", {}, state.scores.layers[v.layer].name),
        el("td", {}, STATUS_LABEL[v.status]), el("td", { class: "num" }, fmtDate(v.last_date))))));
  }

  // ---------------------------------------------------------------- faner, tema, tabeller
  function setupTabs() {
    document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      ["overview", "manual", "status", "explain"].forEach((t) => { $("panel-" + t).hidden = t !== b.dataset.tab; });
      try { sessionStorage.setItem("adm-tab", b.dataset.tab); } catch (e) { /* ignoreres */ }
    }));
    let saved = null;
    try { saved = sessionStorage.getItem("adm-tab"); } catch (e) { /* ignoreres */ }
    if (saved && $("tab-" + saved)) $("tab-" + saved).click();
    // Links i teksten, der skifter fane (fx "Hvad betyder tallet?")
    document.querySelectorAll("[data-goto]").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      $("tab-" + a.dataset.goto).click();
      const target = document.querySelector(a.getAttribute("href"));
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  }

  function setupTheme() {
    let saved = null;
    try { saved = localStorage.getItem("adm-theme"); } catch (e) { /* ignoreres */ }
    if (saved) document.documentElement.dataset.theme = saved;
    $("theme-toggle").addEventListener("click", () => {
      const dark = document.documentElement.dataset.theme
        ? document.documentElement.dataset.theme === "dark"
        : matchMedia("(prefers-color-scheme: dark)").matches;
      const next = dark ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem("adm-theme", next); } catch (e) { /* ignoreres */ }
      renderAll();
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (!document.documentElement.dataset.theme) renderAll(); });
  }

  function setupTableToggles() {
    document.querySelectorAll("[data-table-for]").forEach((b) => b.addEventListener("click", () => {
      const t = $("table-" + b.dataset.tableFor);
      t.hidden = !t.hidden;
      b.textContent = t.hidden ? "Vis tabel" : "Skjul tabel";
    }));
  }

  // ---------------------------------------------------------------- forklaring
  function renderExplain() {
    const s = state.scores;
    const layers = LAYER_KEYS.filter((k) => s.layers[k]).map((k) => {
      const l = s.layers[k];
      const inds = l.indicators.map((id) => s.indicators[id]).map((ind) =>
        el("li", {},
          el("strong", {}, ind.name), " – ", ind.explain || "",
          el("div", { class: "meta" },
            `${ind.polarity > 0 ? "Højere er godt" : "Lavere er godt"}: ${ind.polarity_note} · Kilde: ${ind.source} · ` +
            `${ind.scored === false ? "Indgår ikke i scoren (bruges af signal)" : "Vægt " + num(ind.weight, 1)} · Status: ${STATUS_LABEL[ind.status]}`)));
      return el("div", { class: "explain-layer" },
        el("h3", {}, l.name, el("span", { class: "muted" }, `vægt ${num(l.weight * 100, 0)} % af Health`)),
        el("p", {}, l.description || ""),
        el("p", { class: "muted small" }, l.reading || ""),
        el("ul", { class: "explain-ind" }, inds));
    });
    $("explain-layers").replaceChildren(...layers);
    $("explain-signals").replaceChildren(el("ul", { class: "explain-ind" }, s.signals.map((sg) =>
      el("li", {}, el("strong", {}, `${sg.emoji} ${sg.title}`), " – ", sg.explain || ""))));
  }

  function renderAll() {
    if (!state.scores) return;
    renderHeader(); renderHero(); renderSignals(); renderLayers(); renderLayerDetail();
    renderVolumeChart(); renderGpuChart(); renderMarket(); renderManual(); renderStatus(); renderExplain();
  }

  async function load(path) {
    const r = await fetch(path, { cache: "no-store" });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  }

  async function init() {
    setupTheme(); setupTabs(); setupTableToggles();
    const [s, m, rl] = await Promise.allSettled([load("data/scores.json"), load("data/manual.json"), load("data/run_log.json")]);
    if (s.status !== "fulfilled") {
      const e = $("load-error");
      e.textContent = "Kunne ikke indlæse data/scores.json. Kør pipelinen (python -m pipeline.run) og åbn siden via en webserver. " + (s.reason ? s.reason.message : "");
      e.hidden = false;
      $("asof").textContent = "Ingen data";
      return;
    }
    state.scores = s.value;
    state.manual = m.status === "fulfilled" ? m.value : null;
    state.runlog = rl.status === "fulfilled" ? rl.value : null;
    if (!window.Chart) {
      const e = $("load-error");
      e.textContent = "Grafbiblioteket (Chart.js) kunne ikke indlæses. Tal og tabeller vises stadig.";
      e.hidden = false;
    }
    renderAll();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
