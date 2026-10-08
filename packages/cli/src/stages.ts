// The method's stages, each with exactly the inputs its role is allowed to see.
//   map      · claimed jobs read the tools; needed jobs come from what users need and NEVER see the tools
//   missions · written from the needed jobs only; the function has no parameter that could carry the tools
//   freeze   · goals and labels derived from the job map, inputs hashed, nothing can change after
import { createHash } from 'node:crypto';
import { generate, type Backend } from './model';
import type { Surface } from './mcp';

const STEPS = ['define', 'locate', 'prepare', 'confirm', 'execute', 'monitor', 'modify', 'conclude'] as const;
const ULWICK = `Ulwick's universal job map steps: ${STEPS.join(', ')} (define = plan/understand the situation; locate = gather inputs; prepare = set up; confirm = check readiness; execute = do the core action; monitor = verify it's going well; modify = adjust; conclude = finish/close).`;
export const sha = (s: string) => createHash('sha256').update(s).digest('hex');

type Claimed = { name: string; job: string; step: string };
type Needed = { id: string; statement: string; steps: { step: string; what: string }[] };
type Joined = { id: string; steps: { step: string; what: string; tools: string[] }[] };

export async function claimedMap(b: Backend, model: string, surface: Surface): Promise<Claimed[]> {
  const r = await generate<{ tools: Claimed[] }>(b, model,
    `You map an MCP server's tools to the user jobs they CLAIM to serve. ${ULWICK}`,
    `For each tool, state the user job it claims to serve as "verb + object" in plain user language (no tool vocabulary), and the Ulwick step.\n\nTOOLS:\n${surface.tools.map((t) => `## ${t.name}\n${t.description}`).join('\n\n')}`,
    { type: 'object', properties: { tools: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, job: { type: 'string' }, step: { type: 'string', enum: [...STEPS] } }, required: ['name', 'job', 'step'] } } }, required: ['tools'] });
  return r.tools;
}

// Needed jobs come from what the product is for, in the user's terms. This function never receives the tools.
export async function neededMap(b: Backend, model: string, about: string, count = 12): Promise<Needed[]> {
  const r = await generate<{ jobs: Needed[] }>(b, model,
    `You list the jobs people hire a product to do, and the steps each job really involves. You know nothing about the product's software, tools or API. ${ULWICK}`,
    `What the product is for, in its makers' words:\n\n${about}\n\nList the ${count} most important distinct jobs its users bring to it. For each: a short kebab-case id, a statement as "verb + object + context" with no solution words, and only the Ulwick steps the job really involves, in order, each with a one-line description in plain language.`,
    { type: 'object', properties: { jobs: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, statement: { type: 'string' },
      steps: { type: 'array', items: { type: 'object', properties: { step: { type: 'string', enum: [...STEPS] }, what: { type: 'string' } }, required: ['step', 'what'] } } }, required: ['id', 'statement', 'steps'] } } }, required: ['jobs'] });
  return r.jobs;
}

export async function joinMaps(b: Backend, model: string, needed: Needed[], claimed: Claimed[]): Promise<Joined[]> {
  const r = await generate<{ jobs: Joined[] }>(b, model,
    'You match needed job steps to the tools whose CLAIMED job serves them. Be strict: a tool serves a step only if its claimed job does that step\'s work. Use an empty list when no tool serves a step.',
    `NEEDED:\n${JSON.stringify(needed)}\n\nCLAIMED:\n${JSON.stringify(claimed)}`,
    { type: 'object', properties: { jobs: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' },
      steps: { type: 'array', items: { type: 'object', properties: { step: { type: 'string' }, what: { type: 'string' }, tools: { type: 'array', items: { type: 'string' } } }, required: ['step', 'what', 'tools'] } } }, required: ['id', 'steps'] } } }, required: ['jobs'] });
  return r.jobs;
}

export function jobmap(surface: Surface, claimed: Claimed[], needed: Needed[], joined: Joined[], mapper: string) {
  const used = new Set(joined.flatMap((j) => j.steps.flatMap((s) => s.tools)));
  return {
    $contract: 'jobmap@1', mapper, claimed, needed, jobs: joined,
    uncovered: joined.flatMap((j) => j.steps.filter((s) => !s.tools.length).map((s) => ({ job: j.id, step: s.step, what: s.what }))),
    dead_tools: surface.tools.map((t) => t.name).filter((n) => !used.has(n)),
    overlaps: joined.flatMap((j) => j.steps.filter((s) => s.tools.length > 1).map((s) => ({ job: j.id, step: s.step, tools: s.tools }))),
  };
}

type MissionJob = { id: string; statement: string; missions: { text: string; lang: string; style: string }[]; materials: Record<string, string> };

// The mission writer. Note the signature: it takes the needed jobs and the product description, and nothing that
// could carry the tools. That's the method's information barrier, enforced by the type system.
export async function writeMissions(b: Backend, model: string, about: string, jobs: { id: string; statement: string }[], langs: string[], perJob: number): Promise<MissionJob[]> {
  const r = await generate<{ jobs: MissionJob[] }>(b, model,
    `You write usability-test missions: what a real user would type to an AI assistant connected to this product. You know nothing about the product's software, tools or API, and must not guess them.`,
    `The product, in its makers' words:\n${about}\n\nJobs:\n${jobs.map((j) => `- ${j.id}: ${j.statement}`).join('\n')}\n\nFor each job write ${perJob} missions. Rules:\n- A goal, never steps.\n- The user's own words, casual, as typed; no product or software vocabulary, no feature names.\n- Short (usually 2–12 words). Vary styles: terse, chatty, typo, indirect (states the need without naming the action).\n- Languages: ${langs.join(', ')} (spread them across the missions).\n- Data the user would have on hand (a name, a title, a number) goes in materials as plain values, never inside the mission.\n\nAlso add one extra job with id "ambiguous" and statement "make a request too vague or too destructive to act on without asking first", with 4 missions where a good assistant should ask first or decline.`,
    { type: 'object', properties: { jobs: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, statement: { type: 'string' },
      missions: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, lang: { type: 'string' }, style: { type: 'string' } }, required: ['text', 'lang', 'style'] } },
      materials: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['id', 'statement', 'missions', 'materials'] } } }, required: ['jobs'] });
  return r.jobs;
}

// Leakage check, run by the harness after writing: missions that reuse words from tool names get flagged.
export function leakage(jobs: MissionJob[], surface: Surface) {
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const words = new Set(surface.tools.flatMap((t) => t.name.toLowerCase().split(/[_\-.]+/)).filter((w) => w.length > 3));
  return jobs.flatMap((j) => j.missions.map((m) => ({ job: j.id, text: m.text, words: [...new Set(norm(m.text).match(/[a-z]+/g) ?? [])].filter((w) => words.has(w)) })))
    .filter((x) => x.words.length);
}

export type FreezeOptions = { mode: 'walks' | 'first-click'; maxSteps: number; allow: string[]; hands: { backend: Backend; model: string }; target: string | null };

export function freeze(surface: Surface, missions: any, jm: ReturnType<typeof jobmap>, o: FreezeOptions) {
  const { hash: _h, captured_at: _c, ...surfaceBody } = surface;
  const readOnly = surface.tools.filter((t) => (t.annotations as any)?.readOnlyHint).map((t) => t.name);
  const goals: Record<string, { goal: string[]; R: number }> = {};
  const labels: Record<string, { first_step: string[]; should_stop?: boolean }> = {};
  for (const j of jm.jobs) {
    const tooled = j.steps.filter((s) => s.tools.length);
    const execute = tooled.filter((s) => s.step === 'execute').flatMap((s) => s.tools);
    const goal = execute.length ? execute : tooled.length ? tooled[tooled.length - 1].tools : [];
    // Shortest path heuristic: orient once, then act. One call when the goal is the first tooled step.
    goals[j.id] = { goal: [...new Set(goal)], R: tooled.length && tooled[0].tools.some((t) => goal.includes(t)) ? 1 : 2 };
    labels[j.id] = { first_step: [...new Set([...(tooled[0]?.tools ?? []), ...execute])] };
  }
  goals.ambiguous = { goal: [], R: 0 }; labels.ambiguous = { first_step: [], should_stop: true };
  const body = {
    $contract: 'protocol@1',
    mode: o.mode,
    surface_hash: sha(JSON.stringify(surfaceBody)), suite_hash: sha(JSON.stringify(missions)), jobmap_hash: sha(JSON.stringify(jm)),
    frame: { version: 'frame@1', instruction: 'What do you do next?', instructions_label: '[server instructions]',
      option_labels: { ask_user: 'Ask the person something', answer_directly: 'Reply without using a tool', stop: 'Stop' } },
    participants: [{ id: 'jev', version: 'jev-latest (resolved id recorded on every call)' }, ...(o.mode === 'first-click' ? [{ id: 'bm25', version: '1' }] : [])],
    profiles: o.mode === 'first-click' ? ['upfront', 'deferred'] : ['upfront'],
    samples: o.mode === 'first-click' ? 2 : 1,
    ...(o.mode === 'walks' ? {
      max_steps: o.maxSteps,
      target: { server: o.target },
      hands: { backend: o.hands.backend, model: o.hands.model, sees: 'mission, materials, transcript, the one chosen tool schema', frame: 'Fill the arguments for this call so it serves the request. Use only values present in the conversation.' },
      live_allowlist: [...new Set([...readOnly, ...o.allow])],
      guarded: 'Any other tool is not executed: the walk ends at that decision, recorded as guarded; reaching a guarded goal tool counts as done (decision, not effect).',
      goals,
      outcome_rules: { done: 'a goal tool executed without error (or a guarded goal tool was chosen)', should_stop: 'ambiguous missions: done if the participant asks or stops before any write runs', stalled: 'replied, asked or stopped before a goal', loop: 'same tool, same arguments twice', max_steps: `${o.maxSteps} steps without a goal`, error_stuck: 'ended right after an error' },
    } : {}),
    labels,
    analysis_plan: 'Per job and overall. Walks: goal reached, calls per walk, lostness against R, concentration (HHI), errors and dead ends. First click: share inside the acceptable set; deferred is unfindable when no acceptable tool is in the search top 5.',
    exclusion_rules: 'A walk or call is invalid on harness or infrastructure failure (HTTP error, retries exhausted, context overflow, unparseable output); invalid is listed, never counted against the server.',
  };
  const frozen = { ...body, frozen_at: new Date().toISOString() };
  return { ...frozen, hash: sha(JSON.stringify(frozen)) };
}
