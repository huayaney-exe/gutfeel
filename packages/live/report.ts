// The hand-off: when a run ends, write a complete report into the run folder (REPORT.md for reading,
// report.json for machines) and the prompt that sends a regular agent to analyze it.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Run } from './engine';

const AUDIT = resolve(import.meta.dir, '../../docs/AUDIT.md');
const NONTOOL = new Set(['ask_user', 'answer_directly', 'stop']);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '—');
const short = (t: string) => t.replace(/^pm_/, '');
const OUT: Record<string, string> = { done: '● reached the goal', stalled: '‖ stopped before the goal', wrong: '✕ wrong for the mission', guarded: '⊘ guarded tool', loop: '↻ looped', max_steps: '… ran out of steps', error_stuck: '! stuck on an error', invalid: '? invalid (harness)' };

export function buildReport(run: Run) {
  const dir = resolve(run.dir);
  const { protocol, surface, jobmap } = run;
  const isWalks = !!protocol.goals;
  const recFile = join(dir, isWalks ? 'walks.jsonl' : 'events.jsonl');
  if (!existsSync(recFile)) return null;
  const events = readFileSync(recFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const traced = existsSync(join(dir, 'traces')) && readdirSync(join(dir, 'traces')).length > 0;
  const models = [...new Set(events.map((e) => e.model).filter(Boolean))];
  const L: string[] = [];
  const head = `# gutfeel report · ${surface.server.name}${surface.server.version ? `@${surface.server.version}` : ''}`;
  L.push(head, '',
    `| | |`, `|---|---|`,
    `| run folder | \`${dir}\` |`,
    `| protocol | \`${protocol.hash}\` (${protocol.$contract}, frozen ${protocol.frozen_at}) |`,
    `| mode | ${isWalks ? `walks · every call executed · max ${protocol.max_steps} steps` : 'first click · nothing executed'} |`,
    `| participant | ${models.join(', ') || 'jev'} |`,
    ...(isWalks ? [`| hands | ${protocol.hands?.backend ?? 'openrouter'} · ${protocol.hands?.model} (fill arguments only; never choose the tool) |`] : []),
    `| surface | ${surface.tools.length} tools · server instructions ${surface.server.instructions.length} chars |`,
    `| evidence | ${traced ? '`traces/walk-NNN.json` (trace@1, one full record per walk) · `blobs/`' : '`walks.jsonl` only (partial record: results cut, payloads not kept)'} |`,
    `| audit guide | \`${AUDIT}\` |`,
    `| generated | ${new Date().toISOString()} |`, '');

  const summary: any = { server: surface.server.name, protocol: protocol.hash, mode: isWalks ? 'walks' : 'first-click', run_folder: dir };

  if (isWalks) {
    const steps = events.filter((e) => e.type === 'step'), ends = events.filter((e) => e.type === 'walk_end');
    const valid = ends.filter((e) => e.outcome !== 'invalid'), done = valid.filter((e) => e.outcome === 'done');
    const calls = steps.filter((s) => s.chosen && !NONTOOL.has(s.chosen));
    const by: Record<string, number> = {}; for (const s of calls) by[s.chosen] = (by[s.chosen] ?? 0) + 1;
    const shares = Object.entries(by).sort((a, b) => b[1] - a[1]);
    const hhi = shares.reduce((a, [, n]) => a + (n / (calls.length || 1)) ** 2, 0);
    const lost = valid.filter((e) => e.lostness != null).map((e) => e.lostness);
    Object.assign(summary, { walks: ends.length, invalid: ends.length - valid.length, goal_reached: done.length, calls_per_walk: +avg(valid.map((e) => e.S)).toFixed(2),
      calls_to_goal: +avg(done.map((e) => e.S)).toFixed(2), lostness: +avg(lost).toFixed(2), hhi: +hhi.toFixed(3), distinct_tools: shares.length, tool_count: surface.tools.length });
    L.push('## Summary', '',
      `- **Reached the goal:** ${done.length}/${valid.length} (${pct(done.length, valid.length)}) · ${ends.length - valid.length} invalid walks excluded (harness, not server)`,
      `- **Tool calls per walk:** ${summary.calls_per_walk} · ${summary.calls_to_goal} in walks that reached the goal`,
      `- **Lostness** (Smith, 0 = shortest path): ${summary.lostness}`,
      `- **Concentration** (HHI over calls): ${summary.hhi} · top: ${shares.slice(0, 3).map(([t, n]) => `\`${t}\` ${pct(n, calls.length)}`).join(', ')}`,
      `- **Tools used:** ${shares.length} of ${surface.tools.length}`, '');

    L.push('## Per job', '', '| job | walks | reached | calls | shortest (R) | lostness | outcomes |', '|---|---|---|---|---|---|---|');
    const jobs: any[] = [];
    for (const j of run.jobs) {
      const es = ends.filter((e) => e.job === j.id); if (!es.length) continue;
      const v = es.filter((e) => e.outcome !== 'invalid'), d = v.filter((e) => e.outcome === 'done');
      const oc: Record<string, number> = {}; for (const e of es) oc[e.outcome] = (oc[e.outcome] ?? 0) + 1;
      const l = v.filter((e) => e.lostness != null).map((e) => e.lostness);
      const row = { job: j.id, statement: (j as any).statement ?? '', walks: es.length, reached: d.length, calls: +avg(v.map((e) => e.S)).toFixed(1), R: protocol.goals[j.id]?.R ?? null, lostness: +avg(l).toFixed(2), outcomes: oc };
      jobs.push(row);
      L.push(`| ${j.id} | ${es.length} | ${d.length}/${v.length} | ${row.calls} | ${row.R ?? '—'} | ${row.lostness} | ${Object.entries(oc).map(([k, n]) => `${k} ${n}`).join(' · ')} |`);
    }
    summary.jobs = jobs; L.push('');

    L.push('## Paths per job', '', 'Each distinct path with how many walks took it and how they ended. Walk ids point to `traces/walk-NNN.json`.', '');
    summary.paths = {};
    for (const j of run.jobs) {
      const es = ends.filter((e) => e.job === j.id); if (!es.length) continue;
      const groups = new Map<string, any[]>();
      for (const e of es) { const k = `${e.path.map(short).join(' → ') || '(no tool)'}|${e.outcome}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(e); }
      L.push(`### ${j.id}`, `_${(j as any).statement ?? ''}_ · goal: ${(protocol.goals[j.id]?.goal ?? []).map((t: string) => `\`${t}\``).join(', ') || 'ask or stop'}`, '');
      summary.paths[j.id] = [];
      for (const [k, g] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
        const [p, o] = k.split('|');
        L.push(`- ${OUT[o] ?? o} ×${g.length} · ${p} · walks ${g.map((e) => e.walk).join(', ')}`);
        summary.paths[j.id].push({ path: p, outcome: o, walks: g.map((e) => e.walk) });
      }
      L.push('');
    }

    const alleys = new Map<string, { kind: string; tool: string; msg: string; walks: number[] }>();
    for (const s of steps) if (s.is_error || s.dead_end) {
      const msg = String(s.result ?? '').replace(/\s+/g, ' ').slice(0, 160);
      const k = `${s.chosen}|${s.is_error ? 'error' : `dead end · ${s.dead_end}`}|${msg.slice(0, 80)}`;
      const a = alleys.get(k) ?? alleys.set(k, { kind: s.is_error ? 'error' : `dead end · ${s.dead_end}`, tool: s.chosen, msg, walks: [] }).get(k)!; a.walks.push(s.walk);
    }
    summary.alleys = [...alleys.values()].sort((a, b) => b.walks.length - a.walks.length);
    L.push('## Alley log', '', 'Every error and dead end, grouped by tool, kind and message.', '');
    if (!alleys.size) L.push('None.', '');
    for (const a of summary.alleys) L.push(`- **${a.tool}** · ${a.kind} · ×${a.walks.length} · walks ${a.walks.join(', ')}`, `  > ${a.msg}`);
    L.push('', '## Tool use', '', '| tool | calls |', '|---|---|', ...shares.map(([t, n]) => `| \`${t}\` | ${n} |`), '');
    const unused = surface.tools.map((t: any) => t.name).filter((n: string) => !by[n]);
    L.push(`Never called (${unused.length}): ${unused.map((t: string) => `\`${t}\``).join(', ') || 'none'}`, '');
  } else {
    const ds = events.filter((e) => e.participant === 'jev');
    const right = (e: any) => { const lb = protocol.labels?.[e.job]; if (!lb) return false; return lb.should_stop ? ['ask_user', 'stop'].includes(e.chosen) : lb.first_step.includes(e.chosen); };
    L.push('## Summary', '');
    for (const prof of protocol.profiles) { const x = ds.filter((e) => e.profile === prof && e.state !== 'invalid'); L.push(`- **${prof}:** ${x.filter(right).length}/${x.length} first steps inside the acceptable set (${pct(x.filter(right).length, x.length)})`); }
    L.push('');
  }

  if (jobmap) {
    L.push('## Map', '', `- **Steps no tool serves:** ${jobmap.uncovered.length}`, ...jobmap.uncovered.slice(0, 40).map((u: any) => `  - ${u.job} · ${u.step} · ${u.what}`),
      `- **Tools no needed job uses:** ${jobmap.dead_tools.map((t: string) => `\`${t}\``).join(', ') || 'none'}`,
      `- **Steps with competing tools:** ${jobmap.overlaps.map((o: any) => `${o.job}/${o.step}: ${o.tools.map((t: string) => `\`${t}\``).join(' · ')}`).join('; ') || 'none'}`, '');
  }

  L.push('## For the analyzing agent', '',
    '1. Treat this file as the index, not the verdict. The evidence is in the traces.',
    `2. Follow \`${AUDIT}\` to check the run: frozen inputs, what the participant saw, decision vs argument failures, outcomes against the protocol's rules.`,
    '3. Write findings: job · evidence (walk ids, the exact tool description, schema field or error text involved) · severity 0–4 · the specific change to the server\'s own words that would fix it · how a rerun would show the fix worked.',
    '4. Walks marked invalid are harness failures. Never count them against the server.', '');

  const md = L.join('\n');
  writeFileSync(join(dir, 'REPORT.md'), md);
  writeFileSync(join(dir, 'report.json'), JSON.stringify(summary, null, 2));
  const prompt = handoff(surface.server.name, dir, traced);
  return { path: join(dir, 'REPORT.md'), json: join(dir, 'report.json'), prompt };
}

export function handoff(server: string, dir: string, traced: boolean) {
  return `The agentic usability analysis of ${server} finished.

Full report: ${join(dir, 'REPORT.md')}
Run folder: ${dir}
Evidence: ${traced ? `${join(dir, 'traces')} (one full record per walk, trace@1; large payloads in ${join(dir, 'blobs')})` : `${join(dir, 'walks.jsonl')} (partial record)`}
How to audit it: ${AUDIT}

Read the report, then audit the paths in the evidence. Produce findings, each with: the job, the evidence (walk ids and the exact tool description, schema field or error text involved), a severity from 0 to 4, and the specific change to the server's own words that would fix it. Keep decision failures separate from argument failures, and treat walks marked invalid as harness failures, not server failures.`;
}
