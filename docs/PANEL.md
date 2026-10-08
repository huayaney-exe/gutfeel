# gutfeel · panel review · 2026-10-07

Five independent reviewers, each given the README draft and the full design:
1. Anthropic tool-use researcher
2. Eval scientist
3. UX researcher
4. MCP ecosystem insider (including a survey of what already exists)
5. Red-team skeptic

Sources are as the reviewers reported them. **Verify each one before citing it in the launch.**

---

## Verdict

**Unanimous: the idea is valuable, but the pitch as written won't survive an expert reader.** The central sentence, "if a model that can't think picks the wrong tool, the problem is your tools", is a hypothesis nobody has measured, and three parts of the design break under scrutiny. What does survive is narrower and better positioned:

> **gutfeel tests whether agents can *find* and *tell apart* your tools without deliberating. It reports where cheap, instinctive models split from a reasoning model, and it tests a rewrite before you ship it.** Every claim is checked against real agents, and the checks are published.

---

## Where all reviewers agreed (5/5 or 4/5)

| # | Finding | Change |
|---|---|---|
| 1 | **The core claim is unvalidated.** Nobody has shown that Jev's errors predict real agents' errors. A tool router built on Jev reportedly picks the right tool 95% of the time across 649 tools, against Sonnet's 99%, which undercuts "a model that can't think." | Validation comes first and is the launch content: a perturbation chart plotting how Jev's score changes against how Claude's success changes, for each defect type. |
| 2 | **Multi-step dry mode doesn't hold together.** With nothing executing, step 2 onward depends on an invented history. Lostness and recovery can't be defined. | Dry mode becomes a **per-step first-click test**: the correct earlier steps are given, and only the next decision is scored. Lostness and recovery are reported only for live runs or replayed real results. |
| 3 | **A single proprietary participant is fragile.** Jev's limits as reported: 32k-token context, a 255-option cap, no generated arguments, prone to "indirection and large irrelevant state." A free baseline (BM25 or embeddings) might match it. | A **panel of participants**: BM25, embeddings, Jev (the default), a small open model, Haiku with thinking off, plus a reasoning control. To stay the default, Jev must beat embeddings by at least 0.05 AUROC. |
| 4 | **Letter grades and a ranked leaderboard are a liability.** A–F grades already exist elsewhere (Glama, mcpx). Grading someone else's MCP with an unvalidated measure invites the rebuttal "Claude uses it fine." Prisma ships its own MCP, so there's a conflict of interest. | **No grades, no ranking.** Publish *AX reports* instead: 14-day preview for the maintainer, right of reply, pinned and reproducible runs, conflict disclosed, Praxis reported first. |
| 5 | **Grading paths contradicts Anthropic's own guidance** ("grade what the agent produced, not the path it took"). | Each step accepts a **set** of acceptable tools. Rename dry "completion" to "decision accuracy". |

## What each lens added

**Anthropic tool-use researcher: faithfulness to how Claude actually sees a server.**
- Claude Code defers MCP tools by default. Only tool names and server instructions load up front; the model searches (BM25/regex) and receives 5 tool schemas per search. So the first test is **findability**, before any choice between tools.
- Every test needs three presentation profiles: *deferred*, *full upfront*, and *crowded* (with a pack of distractor tools from popular servers).
- Include the server's **`instructions`** (Praxis relies on them) and the full schemas.
- Add answer options: "answer directly", "ask the user", and several tools at once (parallel calls).
- Parameter legibility deserves its own test: wrong arguments are about half of all failures.

**Eval scientist: the chain from "Jev picked X" to a score.**
- Ground truth in `scan` mode would just be Jev agreeing with a reasoning model. So `scan` reports **diagnostics only, never a grade**.
- Use bootstrap confidence intervals clustered by job, correct for chance (1/k with k tools), and require at least 30 jobs before showing any summary number.
- Fix the scoring formula on a development split before scoring anything public.
- Measure a noise floor: how many decisions flip under trivial edits (whitespace, reordering tools).
- Labeling: two annotators per item, Krippendorff's α ≥ 0.80.

**UX researcher: getting the method right.**
- The right anchor is a **tree test** (findability of labels, with visual design removed) plus a **first-click test** (correct first step: 87% vs 46% task success). The five-second test is only a metaphor.
- Use the **cognitive walkthrough's four questions** as the failure taxonomy.
- The gulf of evaluation (whether the agent understands what happened) was missing. Test it in dry mode with fixtures and injected faults:
  - **Result comprehension:** does the agent understand what the tool returned?
  - **Error triage:** given an error, does it retry, fix an argument, switch tools, ask the user, or stop?
  - **Silent failures:** does it notice empty results, truncation, a bare `ok`?
- Use Nielsen's severity scale (0–4).
- **Ablation:** remove a sentence from a description and see how much the choice moves. This replaces think-aloud, since reasoning traces aren't faithful accounts of why a model chose.
- **Verify the rewrite (RITE loop):** test a fix before shipping it, with no regressions on neighboring jobs.

**MCP ecosystem insider: what already exists.**
- The closest competitor is **AgentDX** (`agentdx bench`: tool selection, parameters, error recovery, 0–100 score). It writes its scenarios *from the tool definitions*, which is exactly the leakage gutfeel guards against.
- Others in the space: mcp-evals (LLM-as-judge, GitHub Action, PR comments), static linters (mcplint, mcpx, mcp-lint), Glama's quality grades, and benchmarks that hold the tools fixed (MCP-Bench, MCP-Universe, MCPMark).
- **What's actually new:** a deliberately non-reasoning, calibrated participant; the margin at every decision; and the Jev-versus-reasoning-model gap on the same blind scenarios.
- **Key paper: "MCP Tool Descriptions Are Smelly!"** 97% of 856 tools have smells. Fixing them blindly improves success by a median of +5.85 points, but adds 67% more steps and **makes things worse 16.67% of the time**. This is gutfeel's strongest argument: rewrite *verified* before you ship.
- Entry friction:
  - Support stdio (`npx gutfeel -- <cmd>`), `--tools tools.json`, and auth headers.
  - Allow a first run with no key.
  - Jev is also available on Cloudflare at $0.042 per million input tokens, with no data retention.
- Live-mode safety should use an **allowlist** of tools marked `readOnlyHint: true`. The planned `destructiveHint` blocklist fails because that hint defaults to true and annotations from untrusted servers can't be trusted.

**Red-team skeptic: the version that survives.**
- What Jev measures is **lexical findability**, not overall usability. Optimizing only for Jev pushes maintainers toward keyword-stuffed descriptions.
- The "hesitation" metric penalizes tools that are intentionally similar (e.g., `get_issue` vs `list_issues`).
- "Reasoning dependency" is confounded: the reasoning control differs from Jev in reasoning, argument filling and reading results all at once.
- Three must-fix risks:
  1. No evidence the results transfer to real agents.
  2. Dependence on one proprietary model.
  3. The public leaderboard.

## Where reviewers disagreed

| Topic | Positions | Resolution |
|---|---|---|
| Headline number | Ecosystem: "% reasoning-dependent" as the badge. Skeptic: confounded. Anthropic: rename it "proxy agreement". | Report it as **panel divergence**, per decision, with the caveat stated. It becomes the badge only if experiment E1 passes. |
| Praxis on the public reports | Skeptic: exclude it. Ecosystem: report it first, publicly. | Report it first, with no ranking. **Luis decides**, since publishing exposes tool descriptions (anti-distillation rule). Note that any MCP client can already read them. |
| Buzzwords | Skeptic: cut AX, vibe-check, System 1. Ecosystem: AX and System 1 land; JTBD doesn't. | Superseded 2026-10-08: "vibe check" was dropped from the vocabulary as unprofessional; the hook is "Usability testing for MCP servers." Originally: keep AX and "vibe-checking" in the hook. Rigor goes in the Validation section. JTBD becomes "task scenarios". Drop "five-second test" and letter grades. |

## Experiments that must pass before launch

| # | Question | Experiment | Passes if |
|---|---|---|---|
| E1 | Does it transfer to real agents? | Edits guided by gutfeel vs random rewordings vs "augment every description", on 10+ servers. Measure end-to-end success on held-out tasks with Sonnet, Haiku and an open ~8B model. | Small and medium models gain ≥5 points; frontier models lose no more than 1 point; tokens grow no more than 15%. |
| E2 | Which participant? | Jev vs BM25 vs embeddings vs Haiku (no thinking) vs a small open model: AUROC for predicting real agents' failures. | Jev beats embeddings by ≥0.05, or it stops being the default. |
| E3 | Is it reliable? | Two independent runs, and two independently generated scenario sets. Check calibration of the probabilities. | Kendall τ ≥0.9 between runs, ≥0.8 between scenario sets; calibration error (ECE) <0.1 before hesitation is ever shown. |
| E4 | Does dry predict live? | Dry per-step accuracy vs live completion, on sandboxed servers. | r ≥0.7. Otherwise dry mode is reported as first-click only. |
| E5 | Does it detect damage? | Deliberately degrade descriptions in steps. | The score drops monotonically. |

**Publish negative results.** For an Anthropic audience, one defect class where Jev and Claude disagree, shown honestly, builds more credibility than a clean leaderboard.

## Sources reported by the panel

Anthropic: [writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) · [advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use) · [demystifying evals](https://anthropic.com/engineering/demystifying-evals-for-ai-agents) · [tool search docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) · [Claude Code tool search](https://code.claude.com/docs/en/agent-sdk/tool-search)
MCP: [tools spec](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) · [tool annotations post](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/)
Research: [MCP descriptions are smelly](https://arxiv.org/abs/2602.14878) · [HumanMCP](https://arxiv.org/html/2602.23367) · [RAG-MCP](https://www.alphaxiv.org/abs/2505.03275) · [τ-bench](https://arxiv.org/pdf/2406.12045) · [Measuring What Matters](https://arxiv.org/abs/2511.04703) · [self-bias in LLM-built benchmarks](https://arxiv.org/abs/2509.26600) · [lostness validation](https://measuringu.com/lostness/)
Landscape: [AgentDX](https://github.com/agentdx/agentdx) · [mcp-evals](https://github.com/mclenhard/mcp-evals) · [mcpx](https://github.com/sameenchand/mcpx) · [Glama TDQS](https://glama.ai/blog/2026-04-03-tool-definition-quality-score-tdqs) · [jev-mcp-router](https://github.com/ini8labs/jev-mcp-router)
Jev: [Pydantic docs](https://pydantic.dev/docs/ai/models/typesafe/) · [Cloudflare](https://developers.cloudflare.com/ai/models/typesafe/jev/) · [API notes](https://flaviocopes.com/jev/)
