// gutfeel live · a localhost window onto a run: start it, watch Jev walk the tools.
// Usage: bun packages/live/server.ts --dir <run folder> [--port 4321] [--open]
// Key: TYPESAFE_API_KEY or OPENROUTER_API_KEY from the environment (then the page only shows play),
// or typed into the page. Either way it stays in this process's memory and is never sent to the browser.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadRun, makeEngine, meta, type Decision } from './engine';
import { makeWalker } from './walk';

const arg = (name: string, fallback?: string) => {
  const i = Bun.argv.indexOf(`--${name}`);
  return i > -1 ? Bun.argv[i + 1] : fallback;
};
const dir = arg('dir');
if (!dir) { console.error('usage: bun packages/live/server.ts --dir <run folder> [--port 4321]'); process.exit(1); }
const port = Number(arg('port', '4321'));
const envKey = process.env.TYPESAFE_API_KEY || process.env.OPENROUTER_API_KEY || '';
const handsKey = process.env.OPENROUTER_API_KEY || '';
const mcpToken = process.env.MCP_TOKEN || '';

const run = loadRun(dir);
const engine = makeEngine(run);
const info = meta(run);

// Fan-out to every open page; late joiners get the backlog so a refresh never loses the picture.
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const enc = new TextEncoder();
let backlog: string[] = [];
let status: 'idle' | 'running' | 'finished' | 'stopped' = 'idle';
let signal = { stopped: false };

const send = (obj: unknown) => {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  backlog.push(line);
  for (const c of clients) { try { c.enqueue(enc.encode(line)); } catch { clients.delete(c); } }
};

async function start(mode: 'live' | 'replay', key: string | undefined, speedMs: number) {
  backlog = []; signal = { stopped: false }; status = 'running';
  const t0 = Date.now();
  const walks = info.kind === 'walks';
  send({ type: 'start', mode, kind: info.kind, total: walks ? makeWalkerTotal() : engine.total, at: t0 });
  if (walks) {
    const rec = `${dir}/walks.jsonl`;
    if (mode === 'live') {
      // Resume: keep finished walks, drop the partial steps of walks that never ended.
      const prior = existsSync(rec) ? readFileSync(rec, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
      const finished = new Set<number>(prior.filter((e) => e.type === 'walk_end' && e.outcome !== 'invalid').map((e) => e.walk));
      const keep = prior.filter((e) => finished.has(e.walk));
      writeFileSync(rec, keep.map((e) => JSON.stringify(e)).join('\n') + (keep.length ? '\n' : ''));
      for (const e of keep) send(e);
      const walker = makeWalker(run, { jev: key!, hands: handsKey || key!, mcp: { url: run.protocol.target.server, token: mcpToken } }, `${dir}/writes.jsonl`);
      await walker.all((e) => { appendFileSync(rec, JSON.stringify(e) + '\n'); send(e); }, signal, finished);
    } else {
      for (const line of readFileSync(rec, 'utf8').trim().split('\n')) {
        if (signal.stopped) break;
        const e = JSON.parse(line); send(e);
        if (e.type === 'step') await Bun.sleep(speedMs * 2);
      }
    }
  } else {
    const emit = (d: Decision) => send(d);
    if (mode === 'live') await engine.live(key!, emit, signal);
    else for (const d of engine.recorded()) { if (signal.stopped) break; emit(d); await Bun.sleep(speedMs); }
  }
  status = signal.stopped ? 'stopped' : 'finished';
  send({ type: 'end', status, ms: Date.now() - t0 });
}
const makeWalkerTotal = () => run.jobs.reduce((a, j) => a + j.missions.length, 0) * (run.protocol.samples ?? 1);

const html = await Bun.file(`${import.meta.dir}/index.html`).text();

Bun.serve({
  port,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/') return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (url.pathname === '/api/meta') return Response.json({ ...info, status, key_from_env: Boolean(envKey) });
    if (url.pathname === '/api/start' && req.method === 'POST') {
      if (status === 'running') return Response.json({ error: 'a run is already in progress' }, { status: 409 });
      const body = await req.json().catch(() => ({}));
      const mode = body.mode === 'live' ? 'live' : 'replay';
      const key = body.key || envKey;
      if (mode === 'live' && !key) return Response.json({ error: 'live mode needs a Jev key (TypeSafe or OpenRouter)' }, { status: 400 });
      if (mode === 'live' && info.kind === 'walks' && body.sandbox_ack !== true) return Response.json({ error: 'walks execute every call for real. Point gutfeel at a sandbox or test environment, never at production data, and confirm it to start.' }, { status: 400 });
      if (mode === 'live' && info.kind === 'walks' && (!mcpToken || !(handsKey || key?.startsWith('sk-or-')))) return Response.json({ error: 'walks need MCP_TOKEN for the target server and an OpenRouter key for the hands' }, { status: 400 });
      if (mode === 'replay' && !info.has_recording) return Response.json({ error: 'no recorded run in this folder' }, { status: 400 });
      start(mode, key, Math.max(10, Number(body.speed) || 90));
      return Response.json({ ok: true, mode });
    }
    if (url.pathname === '/api/stop' && req.method === 'POST') { signal.stopped = true; return Response.json({ ok: true }); }
    if (url.pathname === '/api/stream') {
      let ctrl: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(c) { ctrl = c; clients.add(c); for (const l of backlog) c.enqueue(enc.encode(l)); },
        cancel() { clients.delete(ctrl); },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } });
    }
    return new Response('not found', { status: 404 });
  },
});

console.log(`gutfeel live · ${info.server}@${info.version} · ${info.tool_count} tools · ${info.jobs.length} jobs · protocol ${String(info.protocol).slice(0, 12)}`);
console.log(`→ http://localhost:${port}${envKey ? '  (Jev key from environment)' : ''}`);
if (Bun.argv.includes('--open')) Bun.spawn([process.platform === 'darwin' ? 'open' : 'xdg-open', `http://localhost:${port}`]);
