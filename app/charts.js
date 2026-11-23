/*
 * GEO Engine charts: small, dependency-free SVG builders.
 *
 * Every function returns an SVG (or HTML) string. Colours are CSS custom
 * properties from styles.css, so light and dark mode come for free. Hover
 * details use a data-tt attribute that app.js turns into a floating tooltip;
 * the line chart's crosshair is pure CSS (.hx:hover).
 *
 * Loaded as a plain <script> in the browser (window.GEO_CHARTS) and as a
 * CommonJS module under Node for tests (tests/charts.test.js).
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.GEO_CHARTS = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const r1 = n => Math.round(n * 10) / 10;

  // Rounded-up axis maximum: 0-100 data gets a clean 20/25/50 step ceiling.
  function niceMax(values, floor) {
    const max = Math.max(floor || 0, ...values.filter(v => typeof v === 'number' && isFinite(v)));
    if (max <= 0) return 10;
    const step = max <= 20 ? 5 : max <= 50 ? 10 : 20;
    return Math.min(100, Math.ceil(max / step) * step) || step;
  }

  // Points for a polyline across width w, height h, values on 0..yMax.
  function scalePoints(values, w, h, yMax, padX) {
    const px = padX || 0;
    const n = values.length;
    return values.map((v, i) => [
      r1(n === 1 ? w / 2 : px + (i * (w - 2 * px)) / (n - 1)),
      r1(h - (Math.max(0, Math.min(yMax, v)) / yMax) * h),
    ]);
  }

  // Tiny trend line for a KPI tile. Last point gets a dot.
  function sparkline(values, opts) {
    const o = Object.assign({ w: 96, h: 28, color: 'var(--viz-1)' }, opts);
    if (!values || values.length < 2) return '';
    const lo = Math.min(...values), hi = Math.max(...values);
    const span = hi - lo || 1;
    const pts = values.map((v, i) => [r1(2 + (i * (o.w - 4)) / (values.length - 1)), r1(o.h - 3 - ((v - lo) / span) * (o.h - 6))]);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0] + ' ' + p[1]).join('');
    const area = d + 'L' + pts[pts.length - 1][0] + ' ' + o.h + 'L' + pts[0][0] + ' ' + o.h + 'Z';
    const last = pts[pts.length - 1];
    return '<svg class="spark" width="' + o.w + '" height="' + o.h + '" viewBox="0 0 ' + o.w + ' ' + o.h + '" aria-hidden="true">' +
      '<path d="' + area + '" fill="' + o.color + '" opacity=".12"/>' +
      '<path d="' + d + '" fill="none" stroke="' + o.color + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="3" fill="' + o.color + '" stroke="var(--surface)" stroke-width="2"/></svg>';
  }

  // Progress ring with the value in the middle. pct 0..100 (null = no data).
  function ring(pct, opts) {
    const o = Object.assign({ size: 64, stroke: 7, color: 'var(--viz-1)', label: '' }, opts);
    const rad = (o.size - o.stroke) / 2;
    const circ = 2 * Math.PI * rad;
    const has = typeof pct === 'number' && isFinite(pct);
    const p = has ? Math.max(0, Math.min(100, pct)) : 0;
    const c = o.size / 2;
    return '<svg class="ring" width="' + o.size + '" height="' + o.size + '" viewBox="0 0 ' + o.size + ' ' + o.size + '" role="img" aria-label="' + esc(o.label || (has ? p + '%' : '–')) + '">' +
      '<circle cx="' + c + '" cy="' + c + '" r="' + r1(rad) + '" fill="none" stroke="var(--track)" stroke-width="' + o.stroke + '"/>' +
      (p > 0 ? '<circle cx="' + c + '" cy="' + c + '" r="' + r1(rad) + '" fill="none" stroke="' + o.color + '" stroke-width="' + o.stroke + '" stroke-linecap="round" ' +
        'stroke-dasharray="' + r1((circ * p) / 100) + ' ' + r1(circ) + '" transform="rotate(-90 ' + c + ' ' + c + ')"/>' : '') +
      '<text x="50%" y="50%" dy=".35em" text-anchor="middle" class="ring-t" style="font-size:' + Math.round(o.size * 0.24) + 'px">' + (has ? Math.round(p) + (o.unit === undefined ? '%' : o.unit) : '–') + '</text></svg>';
  }

  /*
   * Line chart over weeks with an optional 95% band, event markers and a
   * hover crosshair. data = { values:[n], labels:[str], ci:[{lo,hi}]|null,
   * markers:{index: letter}, tips:[str] (tooltip per point), alt }.
   */
  function lineChart(data, opts) {
    const o = Object.assign({ w: 720, h: 240, color: 'var(--viz-1)', unit: '%' }, opts);
    const vals = data.values || [];
    if (!vals.length) return '';
    const m = { t: 16, r: 16, b: 28, l: 36 };
    const iw = o.w - m.l - m.r, ih = o.h - m.t - m.b;
    const ci = data.ci && data.ci.length === vals.length ? data.ci : null;
    const yMax = niceMax(vals.concat(ci ? ci.map(c => c.hi) : []), 10);
    const pts = scalePoints(vals, iw, ih, yMax, vals.length === 1 ? 0 : 6);
    const X = i => r1(m.l + pts[i][0]);
    const Y = v => r1(m.t + ih - (Math.max(0, Math.min(yMax, v)) / yMax) * ih);
    const step = yMax <= 20 ? 5 : yMax <= 50 ? 10 : 20;
    const ticks = [];
    for (let t = 0; t <= yMax; t += step) ticks.push(t);
    let s = '<svg class="lc" viewBox="0 0 ' + o.w + ' ' + o.h + '" role="img" aria-label="' + esc(data.alt || '') + '">';
    ticks.forEach(t => {
      s += '<line x1="' + m.l + '" x2="' + (o.w - m.r) + '" y1="' + Y(t) + '" y2="' + Y(t) + '" class="' + (t === 0 ? 'axis' : 'grid') + '"/>' +
        '<text x="' + (m.l - 8) + '" y="' + Y(t) + '" dy=".32em" text-anchor="end" class="tick">' + t + o.unit + '</text>';
    });
    if (ci) {
      const top = ci.map((c, i) => X(i) + ' ' + Y(c.hi)).join('L');
      const bottom = ci.map((c, i) => X(i) + ' ' + Y(c.lo)).reverse().join('L');
      s += '<path d="M' + top + 'L' + bottom + 'Z" fill="' + o.color + '" opacity=".12"/>';
    }
    const line = vals.map((v, i) => (i ? 'L' : 'M') + X(i) + ' ' + Y(v)).join('');
    s += '<path d="' + line + 'L' + X(vals.length - 1) + ' ' + Y(0) + 'L' + X(0) + ' ' + Y(0) + 'Z" fill="url(#lcfill)"/>' +
      '<defs><linearGradient id="lcfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + o.color + '" stop-opacity=".22"/><stop offset="1" stop-color="' + o.color + '" stop-opacity="0"/></linearGradient></defs>' +
      '<path d="' + line + '" fill="none" stroke="' + o.color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';
    // x labels: at most ~8, always the last one.
    const every = Math.max(1, Math.ceil(vals.length / 8));
    (data.labels || []).forEach((lab, i) => {
      if (i % every && i !== vals.length - 1) return;
      s += '<text x="' + X(i) + '" y="' + (o.h - 8) + '" text-anchor="middle" class="tick">' + esc(lab) + '</text>';
    });
    const markers = data.markers || {};
    Object.keys(markers).forEach(k => {
      const i = Number(k);
      if (i < 0 || i >= vals.length) return;
      s += '<line x1="' + X(i) + '" x2="' + X(i) + '" y1="' + m.t + '" y2="' + (m.t + ih) + '" class="evline"/>' +
        '<g class="evmark"><circle cx="' + X(i) + '" cy="' + (m.t + 2) + '" r="8"/><text x="' + X(i) + '" y="' + (m.t + 2) + '" dy=".34em" text-anchor="middle">' + esc(markers[k]) + '</text></g>';
    });
    // Hover columns: a wide transparent hit area per point, a guide line and a dot.
    const colW = vals.length > 1 ? iw / (vals.length - 1) : iw;
    vals.forEach((v, i) => {
      const tip = (data.tips && data.tips[i]) || ((data.labels ? data.labels[i] + ': ' : '') + v + o.unit);
      s += '<g class="hx" data-tt="' + esc(tip) + '" tabindex="0">' +
        '<rect x="' + r1(X(i) - colW / 2) + '" y="' + m.t + '" width="' + r1(colW) + '" height="' + ih + '" fill="transparent"/>' +
        '<line x1="' + X(i) + '" x2="' + X(i) + '" y1="' + m.t + '" y2="' + (m.t + ih) + '" class="guide"/>' +
        '<circle cx="' + X(i) + '" cy="' + Y(v) + '" r="' + (i === vals.length - 1 ? 4.5 : 4) + '" fill="' + o.color + '" stroke="var(--surface)" stroke-width="2" class="' + (i === vals.length - 1 ? 'pt last' : 'pt') + '"/></g>';
    });
    return s + '</svg>';
  }

  /*
   * Horizontal bar list: rows = [{ label, sub, value (0..100|null), color, tip }].
   * HTML rather than SVG so long labels wrap naturally.
   */
  function barList(rows, opts) {
    const o = Object.assign({ unit: '%' }, opts);
    return '<div class="bars">' + rows.map(r => {
      const has = typeof r.value === 'number';
      return '<div class="bar-row" data-tt="' + esc(r.tip || '') + '"><div class="bar-l"><span>' + esc(r.label) + '</span>' + (r.sub ? '<span class="bar-sub">' + esc(r.sub) + '</span>' : '') + '</div>' +
        '<div class="bar-t"><div style="width:' + (has ? Math.max(1.5, Math.min(100, r.value)) : 0) + '%;background:' + (r.color || 'var(--viz-1)') + '"></div></div>' +
        '<span class="bar-v">' + (has ? r.value + o.unit : '–') + '</span></div>';
    }).join('') + '</div>';
  }

  // One stacked 100% bar: parts = [{ value, color, label }]. 2px gaps between parts.
  function stackBar(parts) {
    const total = parts.reduce((a, p) => a + p.value, 0);
    if (!total) return '<div class="stack empty"></div>';
    return '<div class="stack">' + parts.filter(p => p.value > 0).map(p =>
      '<div style="flex:' + p.value + ' 1 0;background:' + p.color + '" data-tt="' + esc(p.label + ': ' + p.value + ' (' + Math.round((p.value / total) * 100) + '%)') + '"></div>').join('') + '</div>';
  }

  // Small histogram of 0-100 scores in fixed 20-point buckets.
  function histogram(scores, opts) {
    const o = Object.assign({ buckets: 5, h: 72, color: v => (v < 50 ? 'var(--critical)' : 'var(--viz-1)'), tip: (lo, hi, n) => lo + '–' + hi + ': ' + n }, opts);
    const size = 100 / o.buckets;
    const counts = Array.from({ length: o.buckets }, () => 0);
    scores.forEach(v => { counts[Math.min(o.buckets - 1, Math.floor(v / size))]++; });
    const max = Math.max(1, ...counts);
    return '<div class="hist" style="height:' + o.h + 'px">' + counts.map((n, i) => {
      const lo = Math.round(i * size), hi = Math.round((i + 1) * size);
      return '<div data-tt="' + esc(o.tip(lo, hi, n)) + '"><div class="hb" style="height:' + Math.max(n ? 6 : 2, Math.round((n / max) * (o.h - 18))) + 'px;background:' + (n ? o.color(lo) : 'var(--track)') + '"></div><span>' + lo + '</span></div>';
    }).join('') + '</div>';
  }

  return { niceMax, scalePoints, sparkline, ring, lineChart, barList, stackBar, histogram, esc };
});
