// The run engine behind `gutfeel live`: renders what the participant sees, asks Jev, judges the answer.
// Reads a run folder: surface.json · missions.json · protocol.json (frozen) · jobmap.json (optional).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

export type Tool = { name: string; description: string; inputSchema?: any };
export type Mission = { text: string; lang: string; style: string };
export type Job = { id: string; statement?: string; missions: Mission[]; materials?: Record<string, string> };
export type Verdict = 'done' | 'wrong' | 'unfindable' | 'stalled' | 'invalid';
export type Decision = {
  type: 'decision'; seq: number; job: string; mission: string; mission_idx: number; lang: string;
  profile: 'upfront' | 'deferred'; rep: number; chosen: string | null; p: number;
  top: [string, number][]; visible: string[] | 'all'; verdict: Verdict; model?: string; reason?: unknown;
};

export const NONTOOL = ['ask_user', 'answer_directly', 'stop'];
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function loadRun(dir: string) {
  const read = (f: string) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
  const surface = read('surface.json');
  const missions = read('missions.json');
  const protocol = read('protocol.json');
  const jobmap = existsSync(`${dir}/jobmap.json`) ? read('jobmap.json') : null;

  // The protocol gate: a run only starts from the exact inputs that were frozen.
  const { hash: _h, captured_at: _c, ...surfaceBody } = surface;
  const drift = {
    surface: sha(JSON.stringify(surfaceBody)) !== protocol.surface_hash,
    missions: sha(JSON.stringify(missions)) !== protocol.suite_hash,
  };
  if (drift.surface || drift.missions) throw new Error(`inputs differ from the frozen protocol ${JSON.stringify(drift)}`);

  return { dir, surface, missions, protocol, jobmap, tools: surface.tools as Tool[], jobs: missions.jobs as Job[] };
}
export type Run = ReturnType<typeof loadRun>;

function renderParams(schema: any): string {
  const props = schema?.properties ?? {};
  const req = new Set<string>(schema?.required ?? []);
  const lines = Object.entries<any>(props).map(([k, v]) => {
    const type = v.enum ? `one of ${v.enum.join('|')}` : (v.type ?? 'any');
    return `- ${k} (${type}${req.has(k) ? ', required' : ''})${v.description ? `: ${v.description}` : ''}`;
  });
  return lines.length ? `\nParameters:\n${lines.join('\n')}` : '';
}

const tok = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .split(/[^a-z0-9ñ]+/).filter((w) => w.length > 1);

export function makeEngine(run: Run) {
  const { tools, protocol, surface } = run;
  const frame = protocol.frame;
  const rendered = new Map(tools.map((t) => [t.name, `${t.description}${renderParams(t.inputSchema)}`]));

  // bm25 over name + description + parameter names, the fields tool search indexes
  const docs = tools.map((t) => tok(`${t.name.replace(/_/g, ' ')} ${t.description} ${Object.keys(t.inputSchema?.properties ?? {}).join(' ')}`));
  const avgdl = docs.reduce((a, d) => a + d.length, 0) / docs.length;
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  const bm25 = (query: string) => {
    const q = tok(query), N = docs.length;
    return tools.map((t, i) => {
      let s = 0;
      for (const w of q) {
        const f = docs[i].filter((x) => x === w).length; if (!f) continue;
        const n = df.get(w) ?? 0;
        s += Math.log(1 + (N - n + 0.5) / (n + 0.5)) * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * docs[i].length / avgdl));
      }
      return { name: t.name, score: s };
    }).sort((a, z) => z.score - a.score);
  };

  const state = (job: Job, m: Mission) => {
    const mat = job.materials && Object.keys(job.materials).length
      ? `\n      (${Object.entries(job.materials).map(([k, v]) => `${k}: ${v}`).join(', ')})` : '';
    return `${frame.instructions_label}\n${surface.server.instructions}\n\nuser: ${m.text}${mat}`;
  };

  const verdict = (jobId: string, chosen: string | null, profile: string, visible: string[] | 'all'): Verdict => {
    if (!chosen) return 'invalid';
    const L = protocol.labels[jobId];
    if (L.should_stop) return chosen === 'ask_user' || chosen === 'stop' ? 'done' : 'wrong';
    if (L.first_step.includes(chosen)) return 'done';
    if (profile === 'deferred' && visible !== 'all' && !L.first_step.some((t: string) => visible.includes(t))) return 'unfindable';
    if (NONTOOL.includes(chosen)) return 'stalled';
    return 'wrong';
  };

  async function jev(key: string, s: string, options: string[]) {
    const criteria: Record<string, string> = {};
    for (const o of options) criteria[o] = rendered.get(o) ?? frame.option_labels[o];
    const direct = key.startsWith('sk-or-') === false;
    const url = direct ? 'https://api.typesafe.ai/v1/systemone' : 'https://openrouter.ai/api/alpha/decisions';
    const model = direct ? 'jev-latest' : '~typesafe/jev-latest';
    const body = JSON.stringify({ model, state: s, questions: { next: { type: 'choice', instructions: frame.instruction, criteria } } });
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body });
      if (r.status === 429 || r.status >= 500) { await Bun.sleep(1500 * (attempt + 1)); continue; }
      const j: any = await r.json();
      if (!r.ok) return { invalid: true as const, reason: { status: r.status, error: j?.error ?? j } };
      return { invalid: false as const, answer: j.answers.next, model: j.model as string };
    }
    return { invalid: true as const, reason: 'retries exhausted' };
  }

  // One unit of work per (mission × profile × rep). Yields decisions as they land.
  async function live(key: string, emit: (d: Decision) => void, signal: { stopped: boolean }) {
    const units: { job: Job; m: Mission; idx: number; profile: 'upfront' | 'deferred'; rep: number }[] = [];
    for (const job of run.jobs) job.missions.forEach((m, idx) => {
      for (const profile of protocol.profiles) for (let rep = 0; rep < protocol.samples; rep++) units.push({ job, m, idx, profile, rep });
    });
    let seq = 0, next = 0;
    const worker = async () => {
      while (next < units.length && !signal.stopped) {
        const u = units[next++];
        const top5 = bm25(u.m.text).slice(0, 5).map((r) => r.name);
        const options = u.profile === 'upfront' ? [...tools.map((t) => t.name), ...NONTOOL] : [...top5, ...NONTOOL];
        const visible: string[] | 'all' = u.profile === 'upfront' ? 'all' : top5;
        const r = await jev(key, state(u.job, u.m), options);
        const base = { type: 'decision' as const, seq: seq++, job: u.job.id, mission: u.m.text, mission_idx: u.idx, lang: u.m.lang, profile: u.profile, rep: u.rep, visible };
        if (r.invalid) { emit({ ...base, chosen: null, p: 0, top: [], verdict: 'invalid', reason: r.reason }); continue; }
        const probs = Object.entries<number>(r.answer.probabilities).sort((a, b) => b[1] - a[1]);
        emit({ ...base, chosen: r.answer.choice, p: r.answer.probabilities[r.answer.choice] ?? 0, top: probs.slice(0, 5),
          verdict: verdict(u.job.id, r.answer.choice, u.profile, visible), model: r.model });
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    return units.length;
  }

  // Replays a recorded events.jsonl from an earlier run, re-judged under the current protocol.
  function recorded(): Decision[] {
    const file = `${run.dir}/events.jsonl`;
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      .filter((e) => e.participant === 'jev')
      .map((e, seq) => {
        const visible = e.visible ?? 'all';
        const probs = Object.entries<number>(e.distribution ?? {}).sort((a, b) => b[1] - a[1]);
        return { type: 'decision' as const, seq, job: e.job, mission: e.mission, mission_idx: e.mission_idx, lang: e.lang,
          profile: e.profile, rep: e.rep, chosen: e.chosen ?? null, p: e.distribution?.[e.chosen] ?? 0, top: probs.slice(0, 5),
          visible, verdict: e.state === 'invalid' ? 'invalid' : verdict(e.job, e.chosen, e.profile, visible), model: e.model };
      });
  }

  const total = run.jobs.reduce((a, j) => a + j.missions.length, 0) * protocol.profiles.length * protocol.samples;
  return { live, recorded, total };
}

// What the UI needs to draw the map before the first decision lands.
export function meta(run: Run) {
  const used: string[] = [];
  const order = (n: string) => { if (!used.includes(n)) used.push(n); };
  const jm = run.jobmap;
  for (const j of run.jobs) {
    const steps = jm?.jobs.find((x: any) => x.id === j.id)?.steps ?? [];
    for (const s of steps) for (const t of s.tools) order(t);
    for (const t of run.protocol.labels[j.id]?.first_step ?? []) order(t);
  }
  const dead = run.tools.map((t) => t.name).filter((n) => !used.includes(n));
  return {
    server: run.surface.server.name, version: run.surface.server.version, tool_count: run.tools.length,
    protocol: run.protocol.hash, frame: run.protocol.frame.version, profiles: run.protocol.profiles, samples: run.protocol.samples,
    jobs: run.jobs.map((j) => ({ id: j.id, statement: j.statement ?? '', missions: j.missions.length, should_stop: !!run.protocol.labels[j.id]?.should_stop })),
    tools: [...used, ...dead].map((name) => ({ name, dead: dead.includes(name) })),
    nontool: NONTOOL,
    has_recording: existsSync(`${run.dir}/events.jsonl`),
  };
}
