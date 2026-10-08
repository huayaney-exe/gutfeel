// Multi-step walks: the participant (Jev) picks every step, the hands fill arguments, the server runs the call
// for real, and the result goes back into the transcript verbatim. Live only: there is no fake history.
//
// Every exchange is recorded in full (trace@1), so a later auditor, human or agent, can re-derive each
// decision: what the participant saw, what it answered, what the hands sent, what the server returned.
// Large repeated payloads (the tool criteria, tool schemas) are stored once under blobs/<sha256>.json.
// Keys and tokens never enter a trace.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type { Job, Mission, Run } from './engine';

export type StepState = 'continue' | 'done' | 'wrong' | 'stalled' | 'loop' | 'max_steps' | 'error_stuck' | 'guarded' | 'invalid';
export type Step = {
  type: 'step'; walk: number; job: string; mission: string; step: number; chosen: string | null; p: number;
  top: [string, number][]; args?: unknown; result?: string; is_error?: boolean; dead_end?: string | null;
  executed: boolean; goal_hit: boolean; model?: string;
};
export type WalkEnd = {
  type: 'walk_end'; walk: number; job: string; mission: string; outcome: StepState;
  path: string[]; S: number; N: number; R: number; lostness: number | null; errors: number; dead_ends: number; reason?: string;
};
type Exchange = { endpoint: string; request: unknown; status: number | null; response: unknown; ms: number; attempts: number };
type TraceStep = { step: number; at: string; jev: Exchange; hands?: Exchange; mcp?: Exchange; chosen: string | null; executed: boolean; goal_hit: boolean; is_error?: boolean; dead_end?: string | null; note?: string };

const NONTOOL = ['ask_user', 'answer_directly', 'stop'];
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function renderParams(schema: any): string {
  const props = schema?.properties ?? {};
  const req = new Set<string>(schema?.required ?? []);
  const lines = Object.entries<any>(props).map(([k, v]) => {
    const type = v.enum ? `one of ${v.enum.join('|')}` : (v.type ?? 'any');
    return `- ${k} (${type}${req.has(k) ? ', required' : ''})${v.description ? `: ${v.description}` : ''}`;
  });
  return lines.length ? `\nParameters:\n${lines.join('\n')}` : '';
}

// A result is a dead end when it ran fine but leaves nothing to move forward with.
function deadEnd(text: string): string | null {
  const t = text.trim();
  if (t.length < 3) return 'empty';
  try {
    const j = JSON.parse(t);
    if (j && typeof j === 'object' && Object.keys(j).length <= 1 && ('ok' in j || 'success' in j)) return 'opaque-success';
    const arrays = Object.values(j ?? {}).filter(Array.isArray) as unknown[][];
    if (arrays.length && arrays.every((a) => a.length === 0)) return 'empty';
    if (j?.truncated === true && !j?.cursor && !j?.next_cursor) return 'truncated-no-cursor';
  } catch { /* plain text results are judged by length only */ }
  return null;
}

export type WalkKeys = { jev: string; hands: string; mcp: { url: string; token: string } };

export function makeWalker(run: Run, keys: WalkKeys, writesLog: string) {
  const { protocol, surface } = run;
  const tools = run.tools;
  const frame = protocol.frame;
  const allow = new Set<string>(protocol.live_allowlist);
  const writes = new Set(tools.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name));
  const rendered = new Map(tools.map((t) => [t.name, `${t.description}${renderParams(t.inputSchema)}`]));
  const byName = new Map(tools.map((t) => [t.name, t]));
  const viaOpenRouter = keys.jev.startsWith('sk-or-');
  const jevUrl = viaOpenRouter ? 'https://openrouter.ai/api/alpha/decisions' : 'https://api.typesafe.ai/v1/systemone';
  const jevModel = viaOpenRouter ? '~typesafe/jev-latest' : 'jev-latest';

  // Blob store for payloads that repeat on every call.
  const traceDir = `${run.dir}/traces`, blobDir = `${run.dir}/blobs`;
  for (const d of [traceDir, blobDir]) if (!existsSync(d)) mkdirSync(d, { recursive: true });
  const blob = (value: unknown) => {
    const text = JSON.stringify(value);
    const h = sha(text);
    const f = `${blobDir}/${h}.json`;
    if (!existsSync(f)) writeFileSync(f, text);
    return { $blob: h };
  };
  const criteria = Object.fromEntries([...tools.map((t) => [t.name, rendered.get(t.name)!]), ...NONTOOL.map((o) => [o, frame.option_labels[o]])]);
  const criteriaRef = blob(criteria);

  // One HTTP exchange with retries. Returns the parsed value plus the full exchange for the trace.
  async function exchange<T>(endpoint: string, init: RequestInit, recorded: unknown, parse: (raw: string) => T): Promise<{ value: T | { failed: unknown }; x: Exchange }> {
    const t0 = performance.now();
    let status: number | null = null, raw = '', attempts = 0;
    for (; attempts < 4; attempts++) {
      const r = await fetch(endpoint, init);
      status = r.status; raw = await r.text();
      if (r.status === 429 || r.status >= 500) { await Bun.sleep(1200 * (attempts + 1)); continue; }
      break;
    }
    const x: Exchange = { endpoint, request: recorded, status, response: (() => { try { return JSON.parse(raw); } catch { return raw; } })(), ms: Math.round(performance.now() - t0), attempts: attempts + 1 };
    if (status === null || status >= 400) return { value: { failed: { status, body: cut(raw, 400) } }, x };
    try { return { value: parse(raw), x }; } catch (e) { return { value: { failed: `unparseable response: ${String(e)}` }, x }; }
  }

  const jev = (state: string) => {
    const body = { model: jevModel, state, questions: { next: { type: 'choice', instructions: frame.instruction, criteria } } };
    return exchange(jevUrl, { method: 'POST', headers: { authorization: `Bearer ${keys.jev}`, 'content-type': 'application/json' }, body: JSON.stringify(body) },
      { ...body, questions: { next: { ...body.questions.next, criteria: criteriaRef } } },
      (raw) => JSON.parse(raw));
  };

  // The hands fill arguments for the tool the participant already chose. Two backends:
  //  · openrouter  · an API model (pay per call)
  //  · claude-code · the local `claude` CLI on the operator's own subscription, fully isolated:
  //                  no settings, no CLAUDE.md, no tools, no MCP, a fixed system prompt, structured output
  //                  constrained to the tool's input schema. Without isolation the CLI would load the
  //                  operator's whole context (~60k tokens) and leak it into the arguments.
  const hands = (mission: string, materials: string, transcript: string, toolName: string) => {
    const t = byName.get(toolName)!;
    const { $schema, ...schema } = t.inputSchema ?? {};
    const prompt = `request: ${mission}${materials}\n\nso far:\n${transcript || '(nothing yet)'}`;
    if (protocol.hands.backend === 'claude-code') return handsClaudeCode(t, { type: 'object', ...schema }, prompt);
    const tool = { type: 'function', function: { name: t.name, description: t.description, parameters: { type: 'object', ...schema } } };
    const messages = [{ role: 'system', content: protocol.hands.frame }, { role: 'user', content: prompt }];
    const body = { model: protocol.hands.model, max_tokens: 6000, temperature: 0, tools: [tool], tool_choice: { type: 'function', function: { name: t.name } }, messages };
    return exchange('https://openrouter.ai/api/v1/chat/completions',
      { method: 'POST', headers: { authorization: `Bearer ${keys.hands}`, 'content-type': 'application/json' }, body: JSON.stringify(body) },
      { ...body, tools: [blob(tool)] },
      (raw) => {
        const j = JSON.parse(raw); const c = j.choices?.[0]?.message?.tool_calls?.[0];
        if (!c) return { failed: 'hands returned no call' } as any;
        try { return JSON.parse(c.function.arguments || '{}'); } catch { return { failed: `hands returned unparseable arguments (${j.choices?.[0]?.finish_reason})` } as any; }
      });
  };

  async function handsClaudeCode(t: { name: string; description: string }, schema: object, prompt: string): Promise<{ value: any; x: Exchange }> {
    const system = `${protocol.hands.frame}\nTool: ${t.name}\n${t.description}`;
    const argv = ['claude', '-p', prompt, '--model', protocol.hands.model, '--system-prompt', system, '--json-schema', JSON.stringify(schema),
      '--output-format', 'json', '--setting-sources', '', '--tools', '', '--strict-mcp-config', '--no-session-persistence',
      '--disable-slash-commands', '--exclude-dynamic-system-prompt-sections'];
    const t0 = performance.now();
    const proc = Bun.spawn(argv, { cwd: '/tmp', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ANTHROPIC_API_KEY: '' } });
    const raw = await new Response(proc.stdout).text(); await proc.exited;
    let response: any = raw; try { response = JSON.parse(raw); } catch { /* keep raw text */ }
    const x: Exchange = { endpoint: 'claude-code (local CLI, operator subscription)', request: { model: protocol.hands.model, system: blob(system), prompt, schema: blob(schema) },
      status: proc.exitCode, response, ms: Math.round(performance.now() - t0), attempts: 1 };
    if (typeof response !== 'object' || response.is_error || !response.structured_output) return { value: { failed: `claude-code hands failed: ${cut(String(response?.result ?? raw), 200)}` }, x };
    return { value: response.structured_output, x };
  }

  let rpc = 0;
  const call = (name: string, args: unknown) => {
    const body = { jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } };
    return exchange(keys.mcp.url,
      { method: 'POST', headers: { authorization: `Bearer ${keys.mcp.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) },
      body,
      (raw) => {
        const json = raw.trim().startsWith('{') ? JSON.parse(raw) : JSON.parse(raw.split('\n').filter((l) => l.startsWith('data:')).pop()!.slice(5));
        if (json.error) return { text: JSON.stringify(json.error), isError: true };
        return { text: (json.result?.content ?? []).map((c: any) => c.text ?? '').join('\n'), isError: !!json.result?.isError };
      });
  };

  async function walk(id: number, job: Job, m: Mission, emit: (e: Step | WalkEnd) => void, signal: { stopped: boolean }) {
    const goal: string[] = protocol.goals[job.id]?.goal ?? [];
    const R: number = protocol.goals[job.id]?.R ?? 0;
    const shouldStop = !!protocol.labels?.[job.id]?.should_stop || job.id === 'ambiguous';
    const materials = job.materials && Object.keys(job.materials).length
      ? `\n      (${Object.entries(job.materials).map(([k, v]) => `${k}: ${v}`).join(', ')})` : '';
    let transcript = '';
    const path: string[] = [], seen = new Set<string>(), trace: TraceStep[] = [];
    const startedAt = new Date().toISOString();
    let outcome: StepState = 'max_steps', goalHit = false, wroteSomething = false, errors = 0, deadEnds = 0, lastError = false;

    for (let step = 1; step <= protocol.max_steps && !signal.stopped; step++) {
      const at = new Date().toISOString();
      const state = `${frame.instructions_label}\n${surface.server.instructions}\n\nuser: ${m.text}${materials}${transcript ? `\n\n${transcript.slice(-12000)}` : ''}`;
      const J = await jev(state);
      const r: any = J.value;
      if ('failed' in r) {
        trace.push({ step, at, jev: J.x, chosen: null, executed: false, goal_hit: false, note: 'participant call failed' });
        emit({ type: 'step', walk: id, job: job.id, mission: m.text, step, chosen: null, p: 0, top: [], executed: false, goal_hit: false, result: JSON.stringify(r.failed) });
        outcome = 'invalid'; break;
      }
      const a = r.answers.next;
      const top = Object.entries<number>(a.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 5) as [string, number][];
      const base = { type: 'step' as const, walk: id, job: job.id, mission: m.text, step, chosen: a.choice as string, p: a.probabilities[a.choice] ?? 0, top, model: r.model };

      if (NONTOOL.includes(a.choice)) {
        trace.push({ step, at, jev: J.x, chosen: a.choice, executed: false, goal_hit: false });
        emit({ ...base, executed: false, goal_hit: false });
        if (shouldStop) outcome = wroteSomething ? 'wrong' : (a.choice === 'answer_directly' ? 'stalled' : 'done');
        else outcome = goalHit ? 'done' : 'stalled';
        break;
      }
      path.push(a.choice);
      if (!allow.has(a.choice)) {
        const hit = goal.includes(a.choice);
        trace.push({ step, at, jev: J.x, chosen: a.choice, executed: false, goal_hit: hit, note: 'guarded: not on the live allowlist, not executed' });
        emit({ ...base, executed: false, goal_hit: hit });
        if (hit) goalHit = true;
        outcome = shouldStop ? 'wrong' : hit || goalHit ? 'done' : 'guarded';
        break;
      }
      const H = await hands(m.text, materials, transcript.slice(-12000), a.choice);
      const args: any = H.value;
      if (args && 'failed' in args) {
        trace.push({ step, at, jev: J.x, hands: H.x, chosen: a.choice, executed: false, goal_hit: false, note: 'hands failed' });
        emit({ ...base, executed: false, goal_hit: false, result: JSON.stringify(args.failed) }); outcome = 'invalid'; break;
      }
      const sig = `${a.choice}:${JSON.stringify(args)}`;
      if (seen.has(sig)) {
        trace.push({ step, at, jev: J.x, hands: H.x, chosen: a.choice, executed: false, goal_hit: false, note: 'loop: same tool, same arguments; not executed again' });
        emit({ ...base, args, executed: false, goal_hit: false }); outcome = 'loop'; break;
      }
      seen.add(sig);
      const C = await call(a.choice, args);
      const res: any = C.value;
      if ('failed' in res) {
        trace.push({ step, at, jev: J.x, hands: H.x, mcp: C.x, chosen: a.choice, executed: false, goal_hit: false, note: 'server call failed' });
        emit({ ...base, args, executed: false, goal_hit: false, result: JSON.stringify(res.failed) }); outcome = 'invalid'; break;
      }
      const isError = res.isError || /"error"\s*:|"ok"\s*:\s*false/.test(res.text.slice(0, 400));
      const de = isError ? null : deadEnd(res.text);
      if (isError) errors++; if (de) deadEnds++;
      lastError = isError;
      if (writes.has(a.choice) && !isError) { wroteSomething = true; appendFileSync(writesLog, JSON.stringify({ at: new Date().toISOString(), walk: id, tool: a.choice, args, result: cut(res.text, 600) }) + '\n'); }
      const hit = !isError && goal.includes(a.choice);
      if (hit) goalHit = true;
      trace.push({ step, at, jev: J.x, hands: H.x, mcp: C.x, chosen: a.choice, executed: true, goal_hit: hit, is_error: isError, dead_end: de });
      emit({ ...base, args, result: cut(res.text, 1200), is_error: isError, dead_end: de, executed: true, goal_hit: hit });
      transcript += `${transcript ? '\n\n' : ''}called: ${a.choice} ${JSON.stringify(args)}\ngot: ${cut(res.text, 3000)}`;
      if (shouldStop && wroteSomething) { outcome = 'wrong'; break; }
      if (step === protocol.max_steps) outcome = goalHit ? 'done' : lastError ? 'error_stuck' : 'max_steps';
    }
    const S = path.length, N = new Set(path).size;
    const lostness = S > 0 && R > 0 && N > 0 ? Math.sqrt((N / S - 1) ** 2 + (R / N - 1) ** 2) : null;
    const end: WalkEnd = { type: 'walk_end', walk: id, job: job.id, mission: m.text, outcome, path, S, N, R, lostness, errors, dead_ends: deadEnds };
    writeFileSync(`${traceDir}/walk-${String(id).padStart(3, '0')}.json`, JSON.stringify({
      $contract: 'trace@1', protocol_hash: protocol.hash, walk: id, job: job.id, mission: m, materials: job.materials ?? {},
      goal, R, should_stop: shouldStop, started_at: startedAt, ended_at: new Date().toISOString(),
      outcome, path, metrics: { S, N, R, lostness, errors, dead_ends: deadEnds }, steps: trace,
    }, null, 2));
    emit(end);
  }

  // A harness failure inside one walk marks that walk invalid; it never takes the run down.
  // `done` lists walk ids already finished in an earlier, interrupted run, so a resume skips them.
  async function all(emit: (e: Step | WalkEnd) => void, signal: { stopped: boolean }, done = new Set<number>(), concurrency = 4) {
    const units: { job: Job; m: Mission }[] = [];
    for (const job of run.jobs) for (const m of job.missions) for (let s = 0; s < protocol.samples; s++) units.push({ job, m });
    let next = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (next < units.length && !signal.stopped) {
        const i = next++; if (done.has(i)) continue;
        try { await walk(i, units[i].job, units[i].m, emit, signal); }
        catch (err) { emit({ type: 'walk_end', walk: i, job: units[i].job.id, mission: units[i].m.text, outcome: 'invalid', path: [], S: 0, N: 0, R: 0, lostness: null, errors: 0, dead_ends: 0, reason: String(err) } as WalkEnd); }
      }
    }));
    return units.length;
  }

  return { all, walks: run.jobs.reduce((a, j) => a + j.missions.length, 0) * protocol.samples, criteriaRef };
}
