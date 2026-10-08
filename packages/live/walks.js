// gutfeel live · walks view.
// A step-layered flow: column 0 is the mission, column k holds the tools chosen at step k, the last column
// holds how each walk ended. Ribbons carry walks from one step to the next and take the color of the
// outcome of the walks they carry, so a green ribbon is a path that reached the goal.
// Shares globals with index.html: $, esc, meta, t0, timer.

const OUTCOMES = ['done', 'stalled', 'wrong', 'guarded', 'loop', 'max_steps', 'error_stuck', 'invalid', 'running'];
const OC = { done: '#1a7f37', stalled: '#8c8c8c', wrong: '#cf222e', guarded: '#8c8c8c', loop: '#b26b00', max_steps: '#8c8c8c', error_stuck: '#b26b00', invalid: '#b26b00', running: '#d4d4d0' };
const OG = { done: '●', stalled: '‖', wrong: '✕', guarded: '⊘', loop: '↻', max_steps: '…', error_stuck: '!', invalid: '?', running: '·' };
const OL = { done: 'reached the goal', stalled: 'stopped before the goal', wrong: 'wrong for this mission', guarded: 'hit a guarded tool', loop: 'looped', max_steps: 'ran out of steps', error_stuck: 'stuck on an error', invalid: 'invalid (harness)', running: 'in progress' };
const NS2 = 'http://www.w3.org/2000/svg';
const mk = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS2, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (parent) parent.appendChild(e); return e; };
const short = (t) => (t === 'ask_user' ? 'ask the person' : t === 'answer_directly' ? 'reply, no tool' : t === 'stop' ? 'stop' : t.replace(/^pm_/, ''));

let WS = { walks: new Map(), order: [], total: 0, focus: 'all', highlight: null, selected: null, latest: null };
let drawQueued = false;

function W_init() {
  $('graphWrap').innerHTML = `<div style="display:grid;grid-template-columns:250px 1fr;height:100%">
    <div id="wjobs" style="border-right:1px solid #e3e3e1;overflow:auto;padding:10px 0"></div>
    <div id="wflowWrap" style="position:relative;overflow-x:auto;overflow-y:hidden"><svg id="wflow"></svg>
      <div id="wlegend" style="position:absolute;left:18px;top:8px;color:#9a9a96;font-size:10.5px"></div></div></div>`;
  $('tabs').innerHTML = `<button class="on">walks · every call runs for real · max ${meta.max_steps} steps</button>`;
  W_draw();
}

function walksInFocus() {
  const all = WS.order.map((id) => WS.walks.get(id));
  return WS.focus === 'all' ? all : all.filter((w) => w.job === WS.focus);
}

// ── the flow ──
function W_draw() {
  drawQueued = false;
  W_jobs();
  const svg = $('wflow'); if (!svg) return;
  const wrap = $('wflowWrap');
  const H = wrap.clientHeight - 30;
  let W = wrap.clientWidth;
  svg.setAttribute('height', H + 30); svg.innerHTML = '';
  const walks = walksInFocus();
  if (!walks.length) { mk('text', { x: 24, y: 40, fill: '#6b6b6b' }, svg).textContent = 'Press ▶ play. Each walk will draw its path here, step by step.'; return; }

  // columns: 0 = mission root, 1..K = steps, K+1 = outcome
  const K = Math.max(1, ...walks.map((w) => w.steps.length));
  const cols = Array.from({ length: K + 2 }, () => new Map());
  const node = (c, key, label, kind) => { let n = cols[c].get(key); if (!n) cols[c].set(key, n = { c, key, label, kind, walks: [], err: 0, dead: 0, out: [], in: [] }); return n; };
  const links = new Map();
  for (const w of walks) {
    const outcome = w.end ? w.end.outcome : 'running';
    let prev = node(0, 'root', WS.focus !== 'all' ? WS.focus : WS.highlight ? WS.highlight : `${walks.length} walks`, 'root'); prev.walks.push(w);
    w.steps.forEach((s, i) => {
      const n = node(i + 1, s.chosen ?? '?', s.chosen ? short(s.chosen) : 'invalid', 'tool');
      n.walks.push(w); if (s.is_error) n.err++; if (s.dead_end) n.dead++;
      const lk = `${prev.c}|${prev.key}>${n.c}|${n.key}|${outcome}`;
      const L = links.get(lk) ?? links.set(lk, { a: prev, b: n, outcome, walks: [] }).get(lk); L.walks.push(w);
      prev = n;
    });
    const end = node(K + 1, outcome, OL[outcome], 'outcome'); end.walks.push(w);
    const lk = `${prev.c}|${prev.key}>${K + 1}|${outcome}|${outcome}`;
    const L = links.get(lk) ?? links.set(lk, { a: prev, b: end, outcome, walks: [] }).get(lk); L.walks.push(w);
  }

  // layout
  const top = 34, gap = 8, barW = 9, left = 18, labelRoom = 190;
  const colTotals = cols.map((m) => [...m.values()].reduce((a, n) => a + n.walks.length, 0));
  const maxNodes = Math.max(...cols.map((m) => m.size));
  const unit = Math.max(1.2, Math.min(60, (H - top * 2 - gap * maxNodes) / Math.max(...colTotals)));
  const colGap = Math.max(150, (W - left - labelRoom - barW) / (K + 1));
  W = left + colGap * (K + 1) + barW + labelRoom;
  svg.setAttribute('width', W);
  const colX = (c) => left + c * colGap;
  cols.forEach((m, c) => {
    const ns = [...m.values()];
    if (c === K + 1) ns.sort((a, b) => OUTCOMES.indexOf(a.key) - OUTCOMES.indexOf(b.key));
    else ns.sort((a, b) => b.walks.length - a.walks.length);
    const used = ns.reduce((a, n) => a + n.walks.length * unit, 0) + gap * (ns.length - 1);
    let y = top + Math.max(0, (H - top * 2 - used) / 2);
    for (const n of ns) { n.x = colX(c); n.y = y; n.h = Math.max(2, n.walks.length * unit); n.oy = y; n.iy = y; y += n.h + gap; }
  });

  // ribbons: stack ports in the order of the opposite end, so ribbons don't cross needlessly
  const L = [...links.values()];
  const byA = new Map(), byB = new Map();
  for (const l of L) { (byA.get(l.a) ?? byA.set(l.a, []).get(l.a)).push(l); (byB.get(l.b) ?? byB.set(l.b, []).get(l.b)).push(l); }
  for (const [n, ls] of byA) { ls.sort((p, q) => p.b.y - q.b.y || OUTCOMES.indexOf(p.outcome) - OUTCOMES.indexOf(q.outcome)); let y = n.y; for (const l of ls) { l.y0 = y; y += l.walks.length * unit; } }
  for (const [n, ls] of byB) { ls.sort((p, q) => p.a.y - q.a.y || OUTCOMES.indexOf(p.outcome) - OUTCOMES.indexOf(q.outcome)); let y = n.y; for (const l of ls) { l.y1 = y; y += l.walks.length * unit; } }
  const gRib = mk('g', {}, svg), gNode = mk('g', {}, svg);
  const sel = WS.selected ?? (WS.highlight ? new Set(walks.filter((w) => w.job === WS.highlight).map((w) => w.id)) : null);
  for (const l of L) {
    const h = l.walks.length * unit, x0 = l.a.x + barW, x1 = l.b.x, mx = (x0 + x1) / 2;
    const d = `M${x0},${l.y0} C${mx},${l.y0} ${mx},${l.y1} ${x1},${l.y1} L${x1},${l.y1 + h} C${mx},${l.y1 + h} ${mx},${l.y0 + h} ${x0},${l.y0 + h} Z`;
    const on = !sel || l.walks.some((w) => sel.has(w.id));
    const p = mk('path', { d, fill: OC[l.outcome], 'fill-opacity': on ? (sel ? 0.62 : 0.42) : 0.05, stroke: 'none', style: 'cursor:pointer' }, gRib);
    mk('title', {}, p).textContent = `${l.a.label} → ${l.b.label} · ${l.walks.length} walk${l.walks.length > 1 ? 's' : ''} · ${OL[l.outcome]}`;
    p.onclick = () => W_select(l.walks, `${l.a.label} → ${l.b.label}`);
  }
  for (const m of cols) for (const n of m.values()) {
    const lit = !sel || n.kind === 'root' || n.walks.some((w) => sel.has(w.id));
    const litN = sel ? n.walks.filter((w) => sel.has(w.id)).length : n.walks.length;
    const fill = !lit ? '#dcdcd8' : n.kind === 'outcome' ? OC[n.key] : '#111';
    const r = mk('rect', { x: n.x, y: n.y, width: barW, height: n.h, fill, style: 'cursor:pointer' }, gNode);
    r.onclick = () => W_select(n.walks, n.label);
    mk('title', {}, r).textContent = `${n.label} · ${n.walks.length}`;
    const room = n.kind === 'tool' ? Math.max(8, Math.floor((colGap - barW - 34) / 6.6)) : 999;
    const small = WS.focus === 'all' && n.h < 9 && n.kind === 'tool' && !(sel && lit);
    if (small) continue;
    const ty = n.y + Math.min(n.h, 22) / 2 + 4;
    const onPath = sel && lit;
    const t = mk('text', { x: n.x + barW + 5, y: ty, fill: !lit ? '#cfcfcb' : n.kind === 'outcome' ? OC[n.key] : '#111', 'font-size': onPath ? 11.5 : 11, 'font-weight': onPath ? 700 : 400,
      stroke: '#fafaf9', 'stroke-width': onPath ? 4.5 : 3, 'paint-order': 'stroke', 'stroke-linejoin': 'round', style: 'cursor:pointer' }, gNode);
    t.onclick = () => W_select(n.walks, n.label);
    const lab = n.label.length > room ? n.label.slice(0, room - 1) + '…' : n.label;
    t.textContent = `${n.kind === 'outcome' ? OG[n.key] + ' ' : ''}${lab}`;
    const extra = [sel && lit ? `${litN}/${n.walks.length}` : `${n.walks.length}`];
    if (n.err) extra.push(`! ${n.err}`); if (n.dead) extra.push(`⊣ ${n.dead}`);
    const t2 = mk('tspan', { fill: '#9a9a96', dx: 6 }, t); t2.textContent = extra.join(' · ');
    if (WS.latest && n.kind === 'tool' && n.key === WS.latest.chosen && n.c === WS.latest.step && (WS.focus === 'all' || WS.focus === WS.latest.job)) {
      const ring = mk('rect', { x: n.x - 3, y: n.y - 3, width: barW + 6, height: n.h + 6, fill: 'none', stroke: '#111', 'stroke-width': 1.5 }, gNode);
      ring.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 700, fill: 'forwards' });
    }
  }
  // step headers
  for (let c = 0; c <= K + 1; c++) mk('text', { x: colX(c), y: H + 16, fill: '#9a9a96', 'font-size': 10 }, svg).textContent = c === 0 ? 'mission' : c === K + 1 ? 'outcome' : `step ${c}`;
  $('wlegend').textContent = 'width = walks · color = how they ended · small tools hidden in all-jobs view (hover the bar) · click anything to open its walks';
}
function W_queue() { if (!drawQueued) { drawQueued = true; setTimeout(W_draw, 120); } }

// ── job list ──
function W_jobs() {
  const box = $('wjobs'); if (!box) return;
  const all = WS.order.map((id) => WS.walks.get(id));
  const row = (id, label, ws) => {
    const ends = ws.filter((w) => w.end), ok = ends.filter((w) => w.end.outcome === 'done').length;
    const calls = ends.length ? (ends.reduce((a, w) => a + w.end.S, 0) / ends.length).toFixed(1) : '—';
    const lost = ends.filter((w) => w.end.lostness != null); const L = lost.length ? (lost.reduce((a, w) => a + w.end.lostness, 0) / lost.length).toFixed(2) : '—';
    const bar = OUTCOMES.map((o) => { const n = ends.filter((w) => w.end.outcome === o).length; return n ? `<i style="display:inline-block;height:4px;width:${(100 * n) / Math.max(ws.length, 1)}%;background:${OC[o]}"></i>` : ''; }).join('');
    return `<div data-j="${esc(id)}" style="padding:6px 14px;cursor:pointer;${WS.highlight === id || (WS.focus === id && id !== 'all') ? 'background:#f1f1ee;box-shadow:inset 3px 0 0 #111;' : ''}">
      <div style="display:flex;justify-content:space-between;gap:6px"><b style="font-weight:${WS.focus === id || WS.highlight === id ? 700 : 500}">${WS.highlight === id ? '▸ ' : ''}${esc(label)}</b><span style="color:#6b6b6b">${ends.length ? `${ok}/${ends.length}` : ''}${id !== 'all' ? ` <span data-only="${esc(id)}" title="show only this job" style="color:${WS.focus === id ? '#111' : '#b9b9b5'};margin-left:6px">only</span>` : ''}</span></div>
      <div style="display:flex;background:#ececea;margin:4px 0 3px">${bar}</div>
      <div style="color:#9a9a96;font-size:10.5px">${ends.length ? `${calls} calls · lostness ${L}` : `${ws.length ? 'running…' : ''}`}</div></div>`;
  };
  box.innerHTML = row('all', 'all jobs', all) + meta.jobs.map((j) => row(j.id, j.id, all.filter((w) => w.job === j.id))).join('');
  box.querySelector(`[data-j="${CSS.escape(WS.highlight ?? '')}"]`)?.scrollIntoView({ block: 'nearest' });
  box.querySelectorAll('[data-j]').forEach((d) => d.onclick = (ev) => {
    const id = d.dataset.j;
    if (ev.target.dataset.only) { WS.focus = WS.focus === id ? 'all' : id; WS.highlight = null; }
    else if (id === 'all') { WS.focus = 'all'; WS.highlight = null; }
    else { WS.highlight = WS.highlight === id ? null : id; WS.focus = 'all'; }
    WS.selected = null; W_draw(); W_metrics();
    if (WS.highlight) { const ws = walksInFocus().filter((w) => w.job === WS.highlight); W_list(ws, WS.highlight); }
  });
}

// ── selection and the trace drawer ──
function W_list(walks, label) {
  const rows = walks.map((w) => `<div class="r" data-w="${w.id}" style="cursor:pointer"><span class="g" style="color:${OC[w.end?.outcome ?? 'running']}">${OG[w.end?.outcome ?? 'running']}</span><span class="m">${esc(w.mission)}</span><span>${esc(w.steps.map((s) => short(s.chosen ?? '?')).join(' → '))}</span></div>`).join('');
  $('now').innerHTML = `<div class="tag">${walks.length} walks · job</div><div class="mission" style="font-family:inherit;font-size:14px">${esc(label)}</div><div style="color:#6b6b6b">its paths are painted on the flow · click a walk to open its full record</div>`;
  $('feed').innerHTML = rows;
  $('feed').querySelectorAll('[data-w]').forEach((r) => r.onclick = () => W_trace(Number(r.dataset.w)));
}
function W_select(walks, label) {
  WS.selected = new Set(walks.map((w) => w.id)); W_draw();
  const rows = walks.map((w) => `<div class="r" data-w="${w.id}" style="cursor:pointer"><span class="g" style="color:${OC[w.end?.outcome ?? 'running']}">${OG[w.end?.outcome ?? 'running']}</span><span class="m">${esc(w.mission)}</span><span>${w.steps.length}</span></div>`).join('');
  $('now').innerHTML = `<div class="tag">${walks.length} walk${walks.length > 1 ? 's' : ''} through</div><div class="mission" style="font-family:inherit;font-size:14px">${esc(label)}</div><div style="color:#6b6b6b">click a walk to open its full record</div>`;
  $('feed').innerHTML = rows;
  $('feed').querySelectorAll('[data-w]').forEach((r) => r.onclick = () => W_trace(Number(r.dataset.w)));
}
async function W_trace(id) {
  const w = WS.walks.get(id);
  const t = await (await fetch(`/api/trace/${id}`)).json();
  const full = t.$contract === 'trace@1';
  const steps = full ? t.steps : (t.events ?? []).filter((e) => e.type === 'step');
  const block = (title, body, color = '#111') => `<div style="margin-top:6px"><div style="color:#9a9a96">${title}</div><pre style="white-space:pre-wrap;margin:2px 0 0;max-height:180px;overflow:auto;color:${color};background:#fafaf9;padding:6px">${esc(body)}</pre></div>`;
  const stepHtml = steps.map((s) => {
    if (full) {
      const ans = s.jev?.response?.answers?.next;
      const top = ans ? Object.entries(ans.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${v.toFixed(2)}  ${k}`).join('\n') : JSON.stringify(s.jev?.response).slice(0, 300);
      const args = s.hands?.response?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
      const res = s.mcp?.response?.result?.content?.map((c) => c.text).join('\n') ?? (s.mcp ? JSON.stringify(s.mcp.response) : '');
      return `<div style="border-top:1px solid #e3e3e1;padding:8px 0"><b>step ${s.step} · ${esc(s.chosen ?? '—')}</b> <span style="color:#9a9a96">${s.jev?.ms ?? ''}ms${s.note ? ' · ' + esc(s.note) : ''}</span>
        ${block('participant · top 5 (request: state + criteria blob ' + esc(s.jev?.request?.questions?.next?.criteria?.$blob?.slice(0, 10) ?? '') + '…)', top)}
        ${args ? block('hands · arguments', args) : ''}
        ${s.mcp ? block(`server · ${s.is_error ? 'error' : s.dead_end ? 'dead end · ' + s.dead_end : 'result'} · ${s.mcp.ms}ms`, res, s.is_error ? '#b26b00' : '#111') : ''}</div>`;
    }
    return `<div style="border-top:1px solid #e3e3e1;padding:8px 0"><b>step ${s.step} · ${esc(s.chosen ?? '—')}</b> <span style="color:#9a9a96">p ${s.p?.toFixed(2) ?? ''}</span>
      ${s.args ? block('arguments', JSON.stringify(s.args, null, 1)) : ''}${s.result ? block(s.is_error ? 'error (cut at 1,200 chars)' : 'result (cut at 1,200 chars)', s.result, s.is_error ? '#b26b00' : '#111') : ''}</div>`;
  }).join('');
  $('now').innerHTML = `<div class="tag">walk ${id} · ${esc(w?.job ?? '')} · ${esc(OL[w?.end?.outcome ?? 'running'])} · ${w?.end ? w.end.S + ' calls' : ''}</div>
    <div class="mission">“${esc(w?.mission ?? '')}”</div>
    <div style="color:${full ? '#1a7f37' : '#b26b00'}">${full ? `full record · trace@1 · <a href="/api/trace/${id}" target="_blank" style="color:inherit">open JSON</a>` : esc(t.note ?? 'partial record')}</div>`;
  $('feed').innerHTML = `<div style="padding:4px 20px 20px">${stepHtml}</div>`;
}

// ── counts and metrics ──
function W_counts() {
  const ends = WS.order.map((id) => WS.walks.get(id)).filter((w) => w.end);
  const c = {}; for (const w of ends) c[w.end.outcome] = (c[w.end.outcome] ?? 0) + 1;
  const T = WS.total || 1;
  $('prog').innerHTML = OUTCOMES.map((o) => `<i style="width:${(100 * (c[o] ?? 0)) / T}%;background:${OC[o]}"></i>`).join('');
  const steps = [...WS.walks.values()].reduce((a, w) => a + w.steps.length, 0);
  const secs = WS.endMs != null ? (WS.endMs / 1000).toFixed(1) : t0 ? ((Date.now() - t0) / 1000).toFixed(1) : '0.0';
  $('counts').innerHTML = `<span><b>${ends.length}</b> / ${WS.total || '—'} walks · ${steps} steps · ${secs}s</span>` +
    OUTCOMES.filter((o) => c[o]).map((o) => `<span><span class="g" style="color:${OC[o]}">${OG[o]}</span>${o.replace('_', ' ')} <b>${c[o]}</b></span>`).join('');
}
function W_metrics() {
  const ws = WS.highlight ? walksInFocus().filter((w) => w.job === WS.highlight) : walksInFocus(); const ends = ws.filter((w) => w.end).map((w) => w.end);
  if (!ends.length) { $('summary').classList.remove('on'); return; }
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const done = ends.filter((e) => e.outcome === 'done');
  const calls = ws.flatMap((w) => w.steps).filter((s) => s.chosen && !meta.nontool.includes(s.chosen));
  const by = {}; for (const s of calls) by[s.chosen] = (by[s.chosen] ?? 0) + 1;
  const tot = calls.length || 1, shares = Object.entries(by).sort((a, b) => b[1] - a[1]);
  const hhi = shares.reduce((a, [, n]) => a + (n / tot) ** 2, 0);
  const lost = ends.filter((e) => e.lostness != null).map((e) => e.lostness);
  const alleys = {}; for (const s of ws.flatMap((w) => w.steps)) if (s.is_error || s.dead_end) { const k = `${s.chosen}|${s.is_error ? '!' : '⊣'}|${(s.result ?? '').replace(/\s+/g, ' ').slice(0, 70)}`; alleys[k] = (alleys[k] ?? 0) + 1; }
  const alleyRows = Object.entries(alleys).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => { const [t, g, msg] = k.split('|'); return `<div class="row" title="${esc(msg)}"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:330px"><span class="g invalid">${g}</span>${esc(short(t))} <span style="color:#9a9a96">${esc(msg)}</span></span><b>${n}</b></div>`; }).join('');
  $('summary').innerHTML = `<h4>${WS.highlight ? esc(WS.highlight) : WS.focus === 'all' ? 'all jobs' : esc(WS.focus)} · ${ends.length} walks</h4>
    <div class="row"><span>reached the goal</span><span><b>${Math.round((100 * done.length) / ends.length)}%</b> (${done.length}/${ends.length})</span></div>
    <div class="row"><span>calls per walk · to goal · shortest</span><span><b>${avg(ends.map((e) => e.S)).toFixed(2)}</b> · ${avg(done.map((e) => e.S)).toFixed(2)} · ${avg(ends.filter((e) => e.R).map((e) => e.R)).toFixed(1)}</span></div>
    <div class="row"><span>lostness · 0 = shortest path</span><span><b>${avg(lost).toFixed(2)}</b></span></div>
    <div class="row"><span>concentration · HHI</span><span><b>${hhi.toFixed(2)}</b> · ${esc(short(shares[0]?.[0] ?? '—'))} ${Math.round((100 * (shares[0]?.[1] ?? 0)) / tot)}%</span></div>
    <div class="row"><span>distinct tools used</span><span><b>${shares.length}</b> of ${meta.tool_count}</span></div>
    ${alleyRows ? `<h4 style="margin-top:10px">alley log</h4>${alleyRows}` : ''}`;
  $('summary').classList.add('on');
}

// ── live current step ──
function W_now(s) {
  const bars = s.top.length ? s.top.map(([t, p]) => `<div class="b ${t === s.chosen ? 'chosen' : ''}"><span class="t">${esc(short(t))}</span><span class="track"><span class="fill" style="width:${(p * 100).toFixed(1)}%"></span></span><span>${p.toFixed(2)}</span></div>`).join('') : '';
  const what = s.chosen && meta.nontool.includes(s.chosen) ? 'chose not to call a tool' : s.executed === false ? (s.result ? 'call failed' : 'not executed') : s.is_error ? 'error' : s.dead_end ? `dead end · ${s.dead_end}` : s.goal_hit ? 'goal reached' : 'ran';
  $('now').innerHTML = `<div class="tag">${esc(s.job)} · walk ${s.walk} · step ${s.step}</div><div class="mission">“${esc(s.mission)}”</div><div class="bars">${bars}</div>
    <div class="verdict" style="color:${s.goal_hit ? '#1a7f37' : s.is_error || s.dead_end ? '#b26b00' : '#111'}">${esc(short(s.chosen ?? '—'))} · ${what}</div>
    ${s.result ? `<pre style="white-space:pre-wrap;margin:6px 0 0;max-height:70px;overflow:hidden;color:${s.is_error ? '#b26b00' : '#6b6b6b'}">${esc(s.result.slice(0, 240))}</pre>` : ''}`;
}

function W_on(e) {
  if (e.type === 'start') {
    WS = { walks: new Map(), order: [], total: e.total, focus: WS.focus, highlight: WS.highlight, selected: null, latest: null }; t0 = e.at;
    $('feed').innerHTML = ''; $('summary').classList.remove('on'); $('start').disabled = true;
    clearInterval(timer); timer = setInterval(W_counts, 250); W_queue();
  } else if (e.type === 'step') {
    let w = WS.walks.get(e.walk); if (!w) { w = { id: e.walk, job: e.job, mission: e.mission, steps: [], end: null }; WS.walks.set(e.walk, w); WS.order.push(e.walk); }
    w.steps.push(e); WS.latest = e; W_now(e); W_queue();
  } else if (e.type === 'walk_end') {
    let w = WS.walks.get(e.walk); if (!w) { w = { id: e.walk, job: e.job, mission: e.mission, steps: [], end: null }; WS.walks.set(e.walk, w); WS.order.push(e.walk); }
    w.end = e; W_counts(); W_metrics(); W_queue();
  } else if (e.type === 'end') { clearInterval(timer); WS.latest = null; WS.endMs = e.ms; handoffBox(e.report); W_counts(); W_metrics(); W_draw(); $('start').disabled = false; }
}
addEventListener('resize', () => { if (meta?.kind === 'walks') W_draw(); });
