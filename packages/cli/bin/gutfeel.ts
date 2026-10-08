#!/usr/bin/env bun
// gutfeel · usability testing for MCP servers.
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AuthRequired, accessToken, authorize, snapshot, type Target } from '../src/mcp';
import { MODELS, pickBackend } from '../src/model';
import { banner } from '../src/banner';
import { claimedMap, freeze, jobmap, joinMaps, leakage, neededMap, writeMissions } from '../src/stages';

const ROOT = resolve(import.meta.dir, '../../..');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const [cmd, ...rest] = Bun.argv.slice(2);
const flag = (name: string, fallback?: string) => { const i = rest.indexOf(`--${name}`); return i > -1 ? rest[i + 1] : fallback; };
const has = (name: string) => rest.includes(`--${name}`);
const dirArg = () => { const d = rest.find((a) => !a.startsWith('--') && rest[rest.indexOf(a) - 1]?.startsWith('--') !== true); if (!d) fail('missing <run folder>'); return resolve(d!); };
const read = (dir: string, f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const write = (dir: string, f: string, v: unknown) => writeFileSync(join(dir, f), JSON.stringify(v, null, 2));
function fail(msg: string): never { console.error(`gutfeel: ${msg}`); process.exit(1); }
const step = (s: string) => console.log(`\x1b[2m·\x1b[0m ${s}`);

const HELP = `  gutfeel init <run> --url <https://…/mcp>      snapshot a remote server (OAuth or --header "Authorization: Bearer …")
  gutfeel init <run> -- <command> [args…]       snapshot a local stdio server
  gutfeel map <run> --about <file|text>         claimed jobs (from the tools) vs needed jobs (blind to the tools)
  gutfeel missions <run> [--langs en,es] [--per-job 6]
                                                missions written blind to the tools, plus a leakage check
  gutfeel freeze <run> [--mode walks|first-click] [--allow tool,tool] [--max-steps 8]
                                                freeze the protocol: goals and labels from the map, inputs hashed
  gutfeel live <run>                            open the live page; press ▶ play
  gutfeel report <run>                          (re)write REPORT.md and print the prompt that hands it to an agent
  gutfeel install-commands [--claude] [--opencode] [--gemini]
                                                add /gutfeel to your agent clients

  Writing roles run on Claude Code (your subscription, isolated) or OpenRouter (OPENROUTER_API_KEY).
  The participant is Jev: TYPESAFE_API_KEY or OPENROUTER_API_KEY.
  Live walks run every call for real: sandbox or test environment only, never production data.`;

async function main() {
  switch (cmd) {
    case 'init': {
      const dir = dirArg(); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '.gitignore'), '.auth.json\n');
      const sep = rest.indexOf('--');
      const target: Target = sep > -1 ? { kind: 'stdio', command: rest.slice(sep + 1) } : { kind: 'http', url: flag('url') ?? fail('--url or -- <command> is required') };
      if (target.kind === 'http' && flag('header')) { const h = flag('header')!; const i = h.indexOf(':'); target.headers = { [h.slice(0, i).trim()]: h.slice(i + 1).trim() }; }
      step(`connecting to ${target.kind === 'http' ? target.url : target.command.join(' ')}`);
      let surface;
      try { surface = await snapshot(target); }
      catch (e) {
        if (!(e instanceof AuthRequired) || target.kind !== 'http') throw e;
        const tok = await authorize(target.url, join(dir, '.auth.json'));
        surface = await snapshot({ ...target, headers: { ...target.headers, authorization: `Bearer ${tok.access_token}` } });
      }
      write(dir, 'surface.json', surface);
      write(dir, 'target.json', target.kind === 'http' ? { kind: 'http', url: target.url } : { kind: 'stdio', command: target.command });
      console.log(`\n${surface.server.name} · ${surface.tools.length} tools · ${surface.tools.filter((t) => (t.annotations as any)?.readOnlyHint).length} read-only · instructions ${surface.server.instructions.length} chars`);
      console.log(`next: gutfeel map ${rest[0]} --about <README or a paragraph on what the product is for>`);
      break;
    }
    case 'map': {
      const dir = dirArg(); const surface = read(dir, 'surface.json');
      const aboutArg = flag('about') ?? (existsSync(join(dir, 'about.md')) ? join(dir, 'about.md') : fail('--about <file|text> is required'));
      const about = existsSync(aboutArg) ? readFileSync(aboutArg, 'utf8') : aboutArg;
      writeFileSync(join(dir, 'about.md'), about);
      const b = pickBackend(flag('backend')); const model = MODELS[b].writer;
      step(`mapping with ${b} (${model}): claimed jobs read the tools, needed jobs never see them`);
      const [claimed, needed] = await Promise.all([claimedMap(b, model, surface), neededMap(b, model, about, Number(flag('jobs', '12')))]);
      step('joining needed steps to the tools that claim them');
      const joined = await joinMaps(b, model, needed, claimed);
      const jm = jobmap(surface, claimed, needed, joined, `${b}:${model}`);
      write(dir, 'jobmap.json', jm);
      console.log(`\n${jm.jobs.length} needed jobs · ${jm.uncovered.length} steps without a tool · ${jm.dead_tools.length} tools no needed job uses · ${jm.overlaps.length} steps with competing tools`);
      console.log(`next: gutfeel missions ${rest[0]}`);
      break;
    }
    case 'missions': {
      const dir = dirArg(); const jm = read(dir, 'jobmap.json'); const about = readFileSync(join(dir, 'about.md'), 'utf8');
      const b = pickBackend(flag('backend')); const model = MODELS[b].writer;
      step(`writing missions with ${b} (${model}), blind to the tools`);
      const jobs = await writeMissions(b, model, about, jm.needed.map((j: any) => ({ id: j.id, statement: j.statement })), (flag('langs', 'en') as string).split(','), Number(flag('per-job', '6')));
      const missions = { $contract: 'missions@1', written_by: `${b}:${model} · blind to the tools`, jobs };
      const leaks = leakage(jobs, read(dir, 'surface.json'));
      write(dir, 'missions.json', missions);
      console.log(`\n${jobs.length} jobs · ${jobs.reduce((a, j) => a + j.missions.length, 0)} missions · ${leaks.length} reuse tool-name words${leaks.length ? ' (review before freezing):' : ''}`);
      for (const l of leaks.slice(0, 8)) console.log(`  ${l.job}: "${l.text}" → ${l.words.join(', ')}`);
      console.log(`next: review missions.json, then gutfeel freeze ${rest[0]}`);
      break;
    }
    case 'freeze': {
      const dir = dirArg();
      const surface = read(dir, 'surface.json'), missions = read(dir, 'missions.json'), jm = read(dir, 'jobmap.json'), target = read(dir, 'target.json');
      const mode = (flag('mode', 'walks') as 'walks' | 'first-click');
      if (mode === 'walks' && target.kind !== 'http') fail('live walks currently support HTTP servers; use --mode first-click for stdio servers');
      const b = pickBackend(flag('backend'));
      const p = freeze(surface, missions, jm, { mode, maxSteps: Number(flag('max-steps', '8')), allow: (flag('allow') ?? '').split(',').filter(Boolean),
        hands: { backend: b, model: MODELS[b].hands }, target: target.url ?? null });
      write(dir, 'protocol.json', p);
      for (const f of ['surface.json', 'missions.json', 'jobmap.json', 'protocol.json']) chmodSync(join(dir, f), 0o444);
      console.log(`\nprotocol frozen · ${p.hash.slice(0, 12)} · ${mode}${mode === 'walks' ? ` · ${(p as any).live_allowlist.length} tools may execute (read-only + --allow)` : ''}`);
      console.log(`inputs are now read-only. Any change means a new run folder.\nnext: gutfeel live ${rest[0]}`);
      break;
    }
    case 'live': {
      const dir = dirArg();
      const env: Record<string, string> = { ...process.env as Record<string, string> };
      const tok = await accessToken(join(dir, '.auth.json'));
      if (tok) env.MCP_TOKEN = tok;
      const server = Bun.spawn(['bun', join(ROOT, 'packages/live/server.ts'), '--dir', dir, '--port', flag('port', '4321')!, '--open'], { env, stdout: 'inherit', stderr: 'inherit' });
      await server.exited;
      break;
    }
    case 'report': {
      const dir = dirArg();
      const { loadRun } = await import('../../live/engine');
      const { buildReport } = await import('../../live/report');
      const r = buildReport(loadRun(dir));
      if (!r) fail('no recorded run in this folder yet');
      console.log(`report: ${r.path}\n\n── hand-off ──\n${r.prompt}`);
      break;
    }
    case 'install-commands': {
      const all = !has('claude') && !has('opencode') && !has('gemini');
      const src = join(ROOT, 'integrations');
      const targets: [boolean, string, string][] = [
        [all || has('claude'), join(src, 'claude-code/gutfeel.md'), join(homedir(), '.claude/commands/gutfeel.md')],
        [all || has('opencode'), join(src, 'opencode/gutfeel.md'), join(homedir(), '.config/opencode/command/gutfeel.md')],
        [all || has('gemini'), join(src, 'gemini/gutfeel.toml'), join(homedir(), '.gemini/commands/gutfeel.toml')],
      ];
      for (const [on, from, to] of targets) if (on) { mkdirSync(dirname(to), { recursive: true }); cpSync(from, to); console.log(`installed ${to}`); }
      console.log(banner(VERSION));
      console.log('  In your agent: /gutfeel <run folder or MCP server>. The agent only launches the test; it is never the participant.\n');
      break;
    }
    case '--version': case '-v': case 'version': console.log(banner(VERSION)); break;
    default: console.log(banner(VERSION)); console.log(HELP);
  }
}
main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
