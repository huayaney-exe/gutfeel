// Multi-step walks: the participant (Jev) picks every step, the hands fill arguments, the server runs the call
// for real, and the result goes back into the transcript verbatim. Live only: there is no fake history.
import { appendFileSync } from 'node:fs';
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

const NONTOOL = ['ask_user', 'answer_directly', 'stop'];
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

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
  const jevUrl = keys.jev.startsWith('sk-or-') ? 'https://openrouter.ai/api/alpha/decisions' : 'https://api.typesafe.ai/v1/systemone';
  const jevModel = keys.jev.startsWith('sk-or-') ? '~typesafe/jev-latest' : 'jev-latest';

  async function retry<T>(f: () => Promise<Response>, parse: (r: Response) => Promise<T>): Promise<T | { failed: unknown }> {
    for (let a = 0; a < 4; a++) {
      const r = await f();
      if (r.status === 429 || r.status >= 500) { await Bun.sleep(1200 * (a + 1)); continue; }
      if (!r.ok) return { failed: { status: r.status, body: cut(await r.text(), 400) } };
      return parse(r);
    }
    return { failed: 'retries exhausted' };
  }

  const jev = (state: string) => retry(
    () => fetch(jevUrl, { method: 'POST', headers: { authorization: `Bearer ${keys.jev}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: jevModel, state, questions: { next: { type: 'choice', instructions: frame.instruction,
        criteria: Object.fromEntries([...tools.map((t) => [t.name, rendered.get(t.name)!]), ...NONTOOL.map((o) => [o, frame.option_labels[o]])]) } } }) }),
    async (r) => r.json() as Promise<any>,
  );

  const hands = (mission: string, materials: string, transcript: string, toolName: string) => {
    const t = byName.get(toolName)!;
    const { $schema, ...schema } = t.inputSchema ?? {};
    return retry(
      () => fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${keys.hands}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: protocol.hands.model, max_tokens: 6000, temperature: 0,
          tools: [{ type: 'function', function: { name: t.name, description: t.description, parameters: { type: 'object', ...schema } } }],
          tool_choice: { type: 'function', function: { name: t.name } },
          messages: [{ role: 'system', content: protocol.hands.frame },
            { role: 'user', content: `request: ${mission}${materials}\n\nso far:\n${transcript || '(nothing yet)'}` }] }) }),
      async (r) => {
        const j: any = await r.json(); const call = j.choices?.[0]?.message?.tool_calls?.[0];
        if (!call) return { failed: 'hands returned no call' };
        try { return JSON.parse(call.function.arguments || '{}'); } catch { return { failed: `hands returned unparseable arguments (${j.choices?.[0]?.finish_reason})` }; }
      },
    );
  };

  let rpc = 0;
  const call = (name: string, args: unknown) => retry(
    () => fetch(keys.mcp.url, { method: 'POST', headers: { authorization: `Bearer ${keys.mcp.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }) }),
    async (r) => {
      const raw = await r.text();
      let json: any;
      try { json = raw.trim().startsWith('{') ? JSON.parse(raw) : JSON.parse(raw.split('\n').filter((l) => l.startsWith('data:')).pop()!.slice(5)); }
      catch { return { failed: `unparseable server response: ${cut(raw, 200)}` }; }
      if (json.error) return { text: JSON.stringify(json.error), isError: true };
      return { text: (json.result?.content ?? []).map((c: any) => c.text ?? '').join('\n'), isError: !!json.result?.isError };
    },
  );

  async function walk(id: number, job: Job, m: Mission, emit: (e: Step | WalkEnd) => void, signal: { stopped: boolean }) {
    const goal: string[] = protocol.goals[job.id]?.goal ?? [];
    const R: number = protocol.goals[job.id]?.R ?? 0;
    const shouldStop = !!protocol.labels?.[job.id]?.should_stop || job.id === 'ambiguous';
    const materials = job.materials && Object.keys(job.materials).length
      ? `\n      (${Object.entries(job.materials).map(([k, v]) => `${k}: ${v}`).join(', ')})` : '';
    let transcript = '';
    const path: string[] = [], seen = new Set<string>();
    let outcome: StepState = 'max_steps', goalHit = false, wroteSomething = false, errors = 0, deadEnds = 0, lastError = false;

    for (let step = 1; step <= protocol.max_steps && !signal.stopped; step++) {
      const state = `${frame.instructions_label}\n${surface.server.instructions}\n\nuser: ${m.text}${materials}${transcript ? `\n\n${transcript.slice(-12000)}` : ''}`;
      const r: any = await jev(state);
      if ('failed' in r) { emit({ type: 'step', walk: id, job: job.id, mission: m.text, step, chosen: null, p: 0, top: [], executed: false, goal_hit: false, result: JSON.stringify(r.failed) }); outcome = 'invalid'; break; }
      const a = r.answers.next;
      const top = Object.entries<number>(a.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 5) as [string, number][];
      const base = { type: 'step' as const, walk: id, job: job.id, mission: m.text, step, chosen: a.choice as string, p: a.probabilities[a.choice] ?? 0, top, model: r.model };

      if (NONTOOL.includes(a.choice)) {
        emit({ ...base, executed: false, goal_hit: false });
        if (shouldStop) outcome = wroteSomething ? 'wrong' : (a.choice === 'answer_directly' ? 'stalled' : 'done');
        else outcome = goalHit ? 'done' : 'stalled';
        break;
      }
      path.push(a.choice);
      if (!allow.has(a.choice)) {
        const hit = goal.includes(a.choice);
        emit({ ...base, executed: false, goal_hit: hit });
        if (hit) goalHit = true;
        outcome = shouldStop ? 'wrong' : hit || goalHit ? 'done' : 'guarded';
        break;
      }
      const args: any = await hands(m.text, materials, transcript.slice(-12000), a.choice);
      if (args && 'failed' in args) { emit({ ...base, executed: false, goal_hit: false, result: JSON.stringify(args.failed) }); outcome = 'invalid'; break; }
      const sig = `${a.choice}:${JSON.stringify(args)}`;
      if (seen.has(sig)) { emit({ ...base, args, executed: false, goal_hit: false }); outcome = 'loop'; break; }
      seen.add(sig);
      const res: any = await call(a.choice, args);
      if ('failed' in res) { emit({ ...base, args, executed: false, goal_hit: false, result: JSON.stringify(res.failed) }); outcome = 'invalid'; break; }
      const isError = res.isError || /"error"\s*:|"ok"\s*:\s*false/.test(res.text.slice(0, 400));
      const de = isError ? null : deadEnd(res.text);
      if (isError) errors++; if (de) deadEnds++;
      lastError = isError;
      if (writes.has(a.choice) && !isError) { wroteSomething = true; appendFileSync(writesLog, JSON.stringify({ at: new Date().toISOString(), tool: a.choice, args, result: cut(res.text, 600) }) + '\n'); }
      const hit = !isError && goal.includes(a.choice);
      if (hit) goalHit = true;
      emit({ ...base, args, result: cut(res.text, 1200), is_error: isError, dead_end: de, executed: true, goal_hit: hit });
      transcript += `${transcript ? '\n\n' : ''}called: ${a.choice} ${JSON.stringify(args)}\ngot: ${cut(res.text, 3000)}`;
      if (shouldStop && wroteSomething) { outcome = 'wrong'; break; }
      if (step === protocol.max_steps) outcome = goalHit ? 'done' : lastError ? 'error_stuck' : 'max_steps';
    }
    const S = path.length, N = new Set(path).size;
    const lostness = S > 0 && R > 0 && N > 0 ? Math.sqrt((N / S - 1) ** 2 + (R / N - 1) ** 2) : null;
    emit({ type: 'walk_end', walk: id, job: job.id, mission: m.text, outcome, path, S, N, R, lostness, errors, dead_ends: deadEnds });
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

  return { all, walks: run.jobs.reduce((a, j) => a + j.missions.length, 0) * protocol.samples };
}
