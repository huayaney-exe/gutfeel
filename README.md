<!-- DRAFT v2 · after the panel review (docs/PANEL.md). Written README-first: nothing below is built yet, and the Status section says so. Do not launch until "What we found" and "How we know it works" contain real results. -->

<h1 align="center">gutfeel</h1>

<p align="center">
  <strong>AX vibe checks for MCP servers, measured.</strong><br/>
  Usability testing for agents: map every path an agent takes through your tools,<br/>
  see where it gets lost, and test the fix before you ship it.
</p>

<p align="center">
  <img alt="status" src="https://img.shields.io/badge/status-pre--alpha-orange" />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue" />
  <img alt="keys" src="https://img.shields.io/badge/keys-BYOK%20%C2%B7%20optional-black" />
</p>

<!-- HERO: a real gutfeel report from a real server. Not a mockup. -->

```bash
npx gutfeel https://mcp.your-server.com          # remote server
npx gutfeel -- node dist/server.js               # local stdio server
npx gutfeel --tools tools.json                   # just the tool list
```

The first run needs no API keys. You get a report in your browser: which of your tools agents can't find, which ones they confuse with each other, and which decisions only a reasoning model gets right.

---

## What we found

<!-- Fill this with real results from the first public reports. For each finding: the server, the two tools that were confused, the request phrasing, and the probabilities. Nothing invented. -->

---

## Why

**Frontier models don't save bad tool design. They hide it.** A reasoning model reads every description, rules out the wrong ones and works around confusing design. Your test passes. Then a cheaper model, a fast path, or an agent with 40 other servers loaded hits the same tools and misses.

**And agents often don't see your descriptions at all.** Claude Code loads MCP tools on demand by default: the model starts with only tool names and server instructions, then searches. If your tool can't be *found* by name, its description never gets read.

**Rewriting descriptions blindly can backfire.** In a study of 856 MCP tools, improved descriptions raised success by a median of 5.85 points, but added 67% more steps and *made things worse in about 1 out of 6 cases* ([Smelly, 2026](https://arxiv.org/abs/2602.14878)). You need to measure what a change actually does.

gutfeel measures it.

---

## What it is: a tree test of your tool list

UX researchers have used **tree testing** for decades. They strip the visual design away from a site, give people a task and only the menu labels, and measure whether they can find the right place. Their **first click** predicts task success: 87% when it's right, 46% when it's wrong.

Your MCP's tool list is that menu, and an agent is the person looking for something in it. gutfeel runs a tree test on your tool list with **participants that don't deliberate**: they read the request, look at your tools, and choose.

The participants are a panel, not one model:

| Participant | What it is | Role |
|---|---|---|
| `bm25` | Keyword search, the same mechanism as tool search | Findability floor, free |
| `embed` | Embedding similarity | Free baseline |
| **`jev`** | [Jev](https://pydantic.dev/docs/ai/models/typesafe/): a calibrated classifier that picks one option and doesn't generate text | Default participant |
| `small` | A small open model, or Haiku with thinking off | The cheap agent |
| `reasoner` | A reasoning model | Control group: the expert user |

A failure counts as a finding only when it repeats across phrasings, and gutfeel always shows which participants split from which.

Each participant sees your server the way real clients show it:

| Profile | What the participant sees |
|---|---|
| `deferred` | Tool names + server instructions → a search → the 5 best matching tools (Claude Code's default) |
| `upfront` | Every tool, with full descriptions and schemas |
| `crowded` | Your tools mixed in with a pack of tools from popular servers |

---

## What it measures

| Metric | Question | Walkthrough step* |
|---|---|---|
| **Findability** | Does a search find the right tool among its top 5? | Is the action visible? |
| **Decision accuracy** | Given the right steps so far, does the next pick fall within the set of acceptable tools? | Is the action linked to the goal? |
| **Distinguishability** | Which tool pairs get confused, and by how much? | Is the action linked to the goal? |
| **Argument legibility** | Does the right value go into the right parameter? | Is the action linked to the goal? |
| **Result comprehension** | After reading a real result: done, partial, or failed? | Is progress visible? |
| **Error triage** | Given an error: retry, fix an argument, switch tools, ask the user, or stop? | Is progress visible? |
| **Silent failures** | Does it notice an empty result, truncation, or a bare `ok`? | Is progress visible? |
| **Panel divergence** | Where do the participants that don't deliberate split from the reasoning model? | — |

\* From the four questions of a cognitive walkthrough (Wharton et al., 1994). Every finding is tagged with the step where the agent failed.

Every summary number has a 95% confidence interval, clustered by job and corrected for chance. With 50 tools, guessing would get 2% right, and the reported number accounts for that. Below 30 jobs, gutfeel shows findings but no summary numbers.

Some things can only be measured live, against your own sandbox: **completion** (checked against the real final state), **lostness** ([Smith, 1996](https://measuringu.com/lostness/)) and **recovery**.

---

## Findings, not grades

Every finding tells you what to rewrite, and proves the rewrite works:

```
F-<id> · severity <0–4> · frequency <x> [<CI>] · <hard failure | detour | recoverable>
Job:          <task scenario> · step <n> · walkthrough step: <which>
Evidence:     <k>/<n> phrasings → <wrong tool> (p̄ <p>) instead of <right tool> (p̄ <p>)
Participants: fails in <jev, small> · passes in <reasoner>
Cause:        <tool>.description, sentence <n>: removing it shifts the choice by <Δp>
Fix:          <proposed rewrite>
Verified:     rewrite → <k'>/<n> (<Δ>) · no regressions in <m> neighboring jobs or in the reasoning model
```

The last line is the point. gutfeel reruns the test on your proposed rewrite before you ship it, so you don't end up as one of the 1-in-6 rewrites that make things worse.

---

## Modes

| Command | What it does | Gives a score? |
|---|---|---|
| `gutfeel scan` | Zero setup. Findability, confused tool pairs, margins, claimed-vs-needed job coverage, panel divergence | **No.** Diagnostics only |
| `gutfeel test` | A labeled suite of task scenarios (two annotators, acceptable-path sets, a held-out split) | Yes, with confidence intervals |
| `gutfeel diff` | Which decisions flipped between two versions of your tools, above a measured noise floor | — |
| `gutfeel test --live` | Actually runs the tools against **your own sandbox**. Only tools marked `readOnlyHint: true` are allowed unless you add others explicitly | Completion, lostness, recovery |

Task scenarios are written **without seeing your tool descriptions**, phrased the way users actually ask, in more than one language. Any scenario that copies your wording is rejected, so your tools are never tested against themselves.

---

## In CI

```yaml
- uses: gutfeel/action@v0
  with:
    server: node dist/server.js
    suite: ./gutfeel/
```

Every PR that touches your tools gets a comment listing which decisions flipped, with the causing sentence and the participants affected.

---

## How we know it works

A measurement nobody has checked is just a vibe with a number on it. Before any public report, gutfeel has to pass these experiments, and we publish the results either way:

| | Question | Passes if |
|---|---|---|
| **E1** | Do edits guided by gutfeel help real agents? (vs random rewording, vs adding text to every description, on held-out tasks) | Small and mid-size models improve by ≥5 points; frontier models lose no more than 1 point; tokens grow no more than 15% |
| **E2** | Which participant best predicts real agents' failures? | Jev beats embedding similarity by ≥0.05 AUROC, or it stops being the default |
| **E3** | Is it reliable? | Rankings agree (Kendall τ) ≥0.9 between runs and ≥0.8 between independently generated scenario sets; calibration error <0.1 |
| **E4** | Does dry-run accuracy predict live completion? | r ≥ 0.7 |
| **E5** | Does it catch deliberate damage? | The score drops step by step as descriptions are degraded |

<!-- Results go here. Including the defect classes where gutfeel and Claude disagree. -->

---

## Reports, not rankings

We publish **AX reports** on popular public MCP servers. AX means agent experience. The rules:
- **Dry mode only.**
- **Open methods:** scenarios, seeds and raw probability distributions are published.
- **14-day preview** for maintainers, with a **right of reply**.
- **No rankings and no letter grades.**

Prisma maintains an MCP server, Praxis. Its report goes out first, and it isn't treated any differently.

---

## Related work

| | What it does | How gutfeel differs |
|---|---|---|
| [AgentDX](https://github.com/agentdx/agentdx) | Tool-selection, parameter and recovery benchmark; 0–100 score | Writes its scenarios *from your tool definitions*. gutfeel writes them blind and checks for leaked wording |
| [mcp-evals](https://github.com/mclenhard/mcp-evals) | LLM-as-judge evals, GitHub Action | Judges outputs. gutfeel tests the tool surface itself, decision by decision |
| [mcpx](https://github.com/sameenchand/mcpx), mcplint | Static rules, A–F grade | Rules on text. gutfeel measures behavior |
| MCP-Bench, MCP-Universe, MCPMark | Model benchmarks | Fix the tools, compare models. gutfeel fixes the participants and compares tool designs |
| [Smelly (2026)](https://arxiv.org/abs/2602.14878) | Description smells, 856 tools | gutfeel checks whether a fix actually helps, before you ship it |

Method: tree testing and first-click testing (Bailey & Wolfson, 2009), cognitive walkthrough (Wharton et al., 1994), lostness (Smith, 1996), severity ratings (Nielsen, 1995). Guidance followed: Anthropic's [writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) and [evals for agents](https://anthropic.com/engineering/demystifying-evals-for-ai-agents) ("grade the outcome, not the path"), which is why every step accepts a *set* of correct tools.

---

## Open formats

Every stage reads and writes versioned JSON. Each run records the participant versions it used, so results can be reproduced and compared over time.

`surface@1` · `jobmap@1` · `scenario@1` · `event@1` · `run@1` · `finding@1`

## Keys

Optional, and never stored. `bm25`, `embed` and `small` run locally. Add `TYPESAFE_API_KEY` for Jev (also available through [Cloudflare](https://developers.cloudflare.com/ai/models/typesafe/jev/)) and `ANTHROPIC_API_KEY` for the reasoning control group.

---

## Status

Pre-alpha. This README is the spec.

- [ ] Contracts and metrics, with confidence intervals
- [ ] Participant panel + `deferred` / `upfront` / `crowded` profiles
- [ ] `scan`: findability, confusion pairs, job coverage
- [ ] Task scenarios written blind + leakage check
- [ ] Evaluation probes: result comprehension, error triage, silent failures
- [ ] Findings with cause and verified rewrites
- [ ] Validation E1–E5, published
- [ ] Local report UI
- [ ] `--live` with a read-only allowlist · GitHub Action
- [ ] First AX reports

---

<p align="center">
  Made in LATAM by <a href="https://getprisma.lat">Prisma</a> · Greenhouse Labs LLC · MIT
</p>
