# gutfeel · design

Status: pre-alpha design, 2026-10-07. This document is the spec the code follows. The README is the public promise; this file explains how we keep it.

---

## 0. Method: the protocol is the product

gutfeel's output is only worth something if every run follows the same method, as in a usability study or a clinical trial. So the method isn't a guideline. **Each rule below is enforced by the harness, and a run that breaks one ends as `invalid` instead of producing a result.**

### 0.1 Freeze before you run

Every `test` run starts from a **`protocol@1`** file, frozen and hashed before the first decision:

| Field | Content |
|---|---|
| question | What this run is meant to find out, in one sentence |
| surface | `surface@1` hash: the exact tools under test |
| suite | `scenario@1[]` hash: missions, materials, acceptable paths, success checks |
| frame | `frame@1` version |
| participants | id + pinned version for each (`jev-1.13.0`, never `latest`) |
| profiles · mode · samples | `deferred` / `upfront` / `crowded` · dry / live · N per mission |
| analysis plan | metrics, CI method, chance correction, minimum number of jobs |
| exclusion rules | when a walk counts as invalid (0.5), decided **before** the data |
| live allowlist | tools allowed to execute (live only) |

The run refuses to start without a frozen protocol, and any change means a new version. Every report shows the protocol hash, so anyone can check it was followed. `scan` is exploratory, so it doesn't need a protocol, and its output is labeled *exploratory* and never scored (§5).

### 0.2 Roles that can't see each other's work

The information barriers are enforced in code, not left to good intentions:

| Role | Can see | Can never see |
|---|---|---|
| Mission writer | Needed jobs, outside sources | Tool names, descriptions, schemas, results |
| Labeler (acceptable paths, success checks) | Tools + missions | Any participant's decisions |
| Participant | Mission, materials, the server's words, the frame (§4.3) | Labels, other walks, anything else |
| Analyst | Everything, but only after the run is sealed | Nothing, since the analysis plan is already frozen |

`engine/script` takes no `surface@1` argument at all. The type system blocks the mission writer from receiving the tools.

### 0.3 Controls in every run

Each run includes two servers built into gutfeel, next to the server under test:

- **Positive control:** a planted server with known defects: one confusable pair, one missing handle, one opaque success, one unactionable error, one unfindable name, one dead tool. If gutfeel misses any planted defect, the run is invalid.
- **Negative control:** a clean server with the same jobs and no defects. If gutfeel reports findings there above the noise floor, the run is invalid.

This is E5 shrunk to a check that runs every time: proof the instrument works today, not just that it worked once.

### 0.4 Pilot, then run

As with a real usability study, two jobs run first as a pilot. The pilot checks:
- the frame isn't steering (§4.3)
- missions pass the leakage check
- everything fits in Jev's window
- the noise floor is measured

Only then does the full suite run. Pilot data never counts toward results.

### 0.5 Invalid is not failed

A walk that broke because of the *harness or infrastructure* gets marked `invalid`, never counted as a participant failure. Examples: timeout, rate limit, expired auth, the hands sending arguments that don't match the schema, the server crashing. Invalid walks are listed with their reasons. If more than 5% of walks are invalid, the whole run is invalid. Nothing gets dropped after looking at the results, and every exclusion follows a rule from 0.1.

### 0.6 Provenance and reproduction

- Every input (surface, missions, frame, participant versions, profile, seed) is hashed into the run manifest.
- `gutfeel replay <run.json>` replays the run from cache with identical decisions, or flags the decisions that changed (a sign a participant drifted).
- Tokens and secrets are removed before anything is written.

### 0.7 The harness is tested like an instrument

- Golden fixtures for every contract.
- A property test: reordering tools or changing whitespace must not move the score beyond the noise floor.
- The planted and clean control servers live in the repo's test suite, so CI fails if gutfeel stops catching a planted defect.

---

## 1. What gutfeel answers

For an MCP server and the jobs its users bring to it:

1. **The map.** Which jobs does the server cover, at which job step, with which tools? Which jobs have no tool, and which tools serve no job?
2. **The walks.** When an agent that doesn't deliberate tries each job, where does it go? Where does it take a wrong turn, hit a dead end, get an error, stall, or loop?
3. **The cause and the fix.** Which sentence of which description, schema or error message caused each failure, and does a proposed rewrite fix it without breaking anything else?

Everything gutfeel shows is one of these three, drawn as a tree.

---

## 2. Pipeline

```mermaid
flowchart LR
  S["surface<br/>connect · snapshot"] --> M["map<br/>claimed vs needed jobs"]
  M --> W["script<br/>task scenarios, blind"]
  W --> R["run<br/>participants walk the jobs"]
  R --> F["find<br/>alleys · findings · cause"]
  F --> V["see<br/>map tree · walk trees · alley log"]
```

Each stage reads and writes a versioned contract (§6), so it can be rerun, cached, swapped or inspected on its own.

| Stage | Input | Output | Uses a generative model? |
|---|---|---|---|
| surface | URL, stdio command, or `tools.json` | `surface@1` | No |
| map | `surface@1` + outside sources (README, docs, real requests) | `jobmap@1` | Yes (mapper) |
| script | needed jobs only (**never** the tool descriptions) | `scenario@1[]` | Yes (scriptwriter) |
| run | surface + scenarios + participants + profile + mode | `event@1` stream → `run@1` | Only "hands" in live mode |
| find | `run@1` | `finding@1[]` | No (ablation reruns participants) |
| see | everything above | report UI + static HTML | No |

---

## 3. The trees

The user-facing core. Two kinds of tree, one color system.

### 3.1 State colors and glyphs

The UI is monochrome. Color is used **only** to show state, and every state also has a glyph, so it reads in grayscale and for color-blind users.

| State | Glyph | Color | Meaning | Dry | Live |
|---|---|---|---|---|---|
| **done** | `●` | green | The goal was reached: the path is complete within the acceptable sets (dry) or the state check passed (live) | ✓ | ✓ |
| **wrong turn** | `✕` | red | Picked a tool outside the acceptable set for this step | ✓ | ✓ |
| **unfindable** | `○` | red, dashed | The right tool never made the search's top 5, so the agent never saw it (`deferred` profile only) | ✓ | ✓ |
| **dead end** ("closed alley") | `⊣` | amber | The tool ran without error, but its result gave no way forward (§3.4) | fixtures | ✓ |
| **error** | `!` | amber | The tool returned an error. The branch splits into *recovered* (the walk continues) and *stuck* | fault injection | ✓ |
| **stalled** | `‖` | gray | The participant stopped, asked the user or answered directly when the job needed a tool. (If stopping was correct, that's **done**.) | ✓ | ✓ |
| **loop** | `↻` | amber | The same call with the same arguments, repeated with no new information | — | ✓ |

The taxonomy above is a starting hypothesis, not a fixed list. Before it gets locked, the first ~100 live traces from C9 are read by hand and coded bottom-up: label what actually went wrong, then group the labels. States that never show up get merged, and failure types that don't fit get added. Classify from the data, not from the spec.

### 3.2 The map tree: the server as a tree

This is the MCP drawn the way tree testing draws a site's navigation. It's built from `jobmap@1`.

```
server
├── job: "prioritize what to build next"
│   ├── step: define        → pm_get_state
│   ├── step: locate        → pm_get_backlog · pm_backlog_board        (confused pair ⇄)
│   ├── step: execute       → pm_score_work_item
│   └── step: conclude      → pm_commit_work_item
├── job: "record what we learned"
│   └── step: execute       → pm_add_learning · pm_save_artifact       (confused pair ⇄)
├── job: "hand work to a teammate"            ○ needed, not covered
└── (no job)                → pm_render_diagram                        ◌ dead tool
```

- **Jobs** come from the *needed* map. A job the server doesn't cover is drawn hollow (`○`).
- **Steps** follow Ulwick's universal job map: define, locate, prepare, confirm, execute, monitor, modify, conclude. Only the steps a job actually uses are drawn.
- **Tools** hang under the steps that claim them. Tools that no needed job reaches go under `(no job)` as dead tools (`◌`).
- **Heat:** each tool node carries a ring split by state, showing what happened to every walk that passed through it. A mostly red or amber ring means the tool is where walks break.
- **Confused pairs** are drawn as `⇄` arcs between sibling tools, thicker for more confusion.

### 3.3 The walk tree: one job, every attempt

This is tree testing's *pietree*, applied to agents. One tree per job, combining every phrasing × participant × profile.

```
"log this idea and tell me if it's worth doing"            n=48   (mission, verbatim)
├── pm_get_state                       ▰▰▰▰▰▰▰▱▱▱ 34
│   ├── pm_add_work_item               ▰▰▰▰▰▰▱▱▱▱ 27
│   │   ├── pm_score_work_item         ● done 22
│   │   └── pm_get_work_item           ⊣ dead end 5   "score not computed until inputs complete"
│   └── pm_add_learning                ✕ wrong turn 7
├── pm_get_user_context                ✕ wrong turn 9   (server instructions say: never start here)
└── ‖ stalled: asked the user 5
```

- **Nodes** are the tools chosen at each step. Edge width is the share of walks.
- **Each node's ring** shows how the walks through it ended.
- **Leaves** use the glyphs from §3.1. Dead ends and errors show the *actual* response or error text, cut to one line, plus the error-triage verdict ("says what to do next: p=0.12").
- **Filters:** participant (split view: Jev vs reasoner side by side), profile, language, phrasing.
- **Dry mode semantics:** at step *k* the participant is given the *correct* steps 1…k−1 and decides only step *k*. So dry walk trees are first-click trees: every branch is one wrong decision from the correct path, and there's no fake history after a mistake. Full multi-step walks, along with dead ends, errors and loops, exist only in live mode or on replayed real results.

### 3.4 Dead ends: how a "closed alley" is detected

A step is a dead end when the tool succeeded but the participant can't move forward. The rules, checked in order:

1. **Empty:** the result is empty, and the job's next acceptable step needs something from it.
2. **Missing handle:** the next acceptable tool requires an identifier (an `*_id` or `uuid` parameter) that doesn't appear in the result.
3. **Truncated:** the result says it's partial (`truncated`, `has_more`, a next cursor) and gives no way to continue.
4. **Opaque success:** the result is a bare `ok` or `{}` with nothing confirming the state change. The result-comprehension probe ("is the job done?") also fails here.
5. **Participant judgement:** the participant's `done` / `partial` / `failed` read on the result disagrees with the state check.

Each dead end records which rule fired. The **alley log** lists them all.

### 3.5 The alley log

This is the table version of every amber and red leaf: every error and closed alley, the first list a maintainer wants.

| Column | Example |
|---|---|
| kind | `error · stuck` |
| tool | `pm_update_work_item` |
| job · step | prioritize · execute |
| response (one line) | `VALIDATION: work_item_id must be a UUID` |
| triage verdict | says what to do: 0.81 → `fix argument work_item_id` |
| rule | — (errors) / `missing-handle` (dead ends) |
| frequency | 9/48 walks · in Jev, small · not in reasoner |
| finding | F-007 |

Rows group by `(tool, kind, normalized message)`, so one bad error message shows up as one row with a count.

---

## 4. Participants and profiles

### 4.1 The panel

```ts
interface Participant {
  id: 'bm25' | 'embed' | 'jev' | 'small' | 'reasoner' | string
  version: string                                  // recorded in every run
  decide(q: DecisionInput): Promise<Decision>      // full distribution, not just the winner
}
```

| Participant | How it decides | Cost |
|---|---|---|
| `bm25` | Keyword search between the request and each rendered tool | Free, local |
| `embed` | Cosine similarity between embeddings of the request and each tool | Free, local (small open embedder) |
| `jev` | A `choice` question over the options (§4.3) | BYOK `TYPESAFE_API_KEY` |
| `small` | A small model with thinking off; distribution estimated from N samples | BYOK or local |
| `reasoner` | A reasoning model, the control group; N samples | BYOK `ANTHROPIC_API_KEY` |

Every finding reports which participants it shows up in. **Panel divergence**, the headline signal, is any decision where the non-deliberating participants split from the reasoner.

### 4.2 Options always include not using a tool

Every decision's options are the visible tools **plus** `ask_user`, `answer_directly` and `stop`. Picking one of those when the job needs a tool counts as **stalled**. Picking one when the scenario says that's correct (for example, the request is ambiguous) counts as **done**. Without these options, a sensible "ask first" would be scored as a wrong turn.

### 4.3 The prompt: a mission and nothing else

This is the most important rule in gutfeel. In a usability test the participant gets a mission ("create an account") and no help: no hints, no steps, no explanation of the interface. A moderator who explains has invalidated the session. gutfeel is the moderator, so **gutfeel says almost nothing.**

Everything a participant sees comes from exactly one of four sources:

| Source | Example | Who wrote it |
|---|---|---|
| **The mission** | `create an account` | The user, in their words (§4.4) |
| **Materials** | `email: ana@example.com` | Data the user would have on hand. Values only, never instructions |
| **The server's own words** | Tool names, descriptions, schemas, `instructions`, results, errors, all **verbatim** | The server under test, because this *is* the interface |
| **The frame** | `What do you do next?` | gutfeel. A fixed, versioned, neutral sentence, the same for every server |

gutfeel never adds anything else: no "you are a helpful agent", no "choose the best tool", no summary of what happened, no hint about the job. If a participant needs help to succeed, the missing help is the finding.

The state is shaped like what an agent actually receives, a transcript:

```
user: create an account
      (email: ana@example.com)

called: auth_lookup_user {"email":"ana@example.com"}
got:    {"found": false}
```

One Jev decision per step, model pinned:

```json
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY

{
  "model": "jev-1.13.0",
  "state": "<the transcript above + the server's instructions, verbatim>",
  "questions": {
    "next": {
      "type": "choice",
      "instructions": "What do you do next?",
      "criteria": {
        "auth_create_user": "<that tool's description and parameters, verbatim>",
        "auth_lookup_user": "<verbatim>",
        "ask_user": "Ask the person something",
        "answer_directly": "Reply without using a tool",
        "stop": "Stop"
      }
    }
  }
}
```

**The frame is `frame@1`.** It's the instruction sentence plus the three non-tool option labels. It's the only text gutfeel writes, so it's pinned, versioned and recorded in every run. Its own influence is measured: each suite reruns under two alternative neutral frames, and if decisions move more than the noise floor, the frame is steering the participant and gets fixed before any result counts.

**Evaluation probes are separate requests** (`result`, `done`, `triage`, `actionable`), never bundled with `next`. A question about whether the job is done must not sit next to the decision and hint at it.

| Probe | Type | Asked after | Frame |
|---|---|---|---|
| `result` | `choice` | Any result | `What happened?` → `worked · partly worked · failed · can't tell` |
| `triage` | `choice` | An error | `What do you do now?` → `try again · change what you sent · try something else · ask the person · stop` |
| `actionable` | `noul` | An error | `This message says what to do next.` |

Every walk is an independent instance: stateless calls, each carrying its own transcript, so walks run in parallel without affecting each other.

Limits to design around: about 32k tokens for the state plus the longest question, 255 options, 1,200 requests per minute. A server with more tools than fit is a finding in itself, so gutfeel reports it and applies the `deferred` profile.

### 4.4 Missions

A mission is what a user would type, and nothing more.

| Rule | ✓ | ✗ |
|---|---|---|
| The user's words, not the product's | `dale luz verde a esta idea` (Spanish for "give this idea the green light") | `commit the work item` |
| A goal, not steps | `create an account` | `look up the email, then create the user` |
| No tool vocabulary | `who's on my team?` | `list members` |
| Missing data comes in as materials | `create an account` + `email: ana@example.com` | `create an account for ana@example.com using the signup tool` |
| Short, as typed | `invite ana` | a paragraph of background |

- **Phrasings:** each job gets several missions: terse, chatty, misspelled, in more than one language. Personas are only used to *write* phrasings and are never shown to the participant.
- **Leakage check:** a mission that shares content words with the tool names or descriptions beyond a threshold gets rejected and rewritten.
- **Missions that should stop:** some missions are out of scope or ambiguous on purpose (`delete everything`, `fix it`). Asking or stopping there counts as **done**, and plowing ahead counts as a wrong turn.
- **The answer stays hidden.** Acceptable paths and success checks are in the scenario file but never reach the participant.

### 4.5 Presentation profiles

| Profile | What the participant sees | Mirrors |
|---|---|---|
| `deferred` | Tool names + server `instructions` → a search (BM25 over name, description and parameter names) → the 5 top tools rendered in full | Claude Code's default tool search |
| `upfront` | Every tool, rendered in full (name, description, flattened parameters) + `instructions` | Direct API use, small servers |
| `crowded` | `upfront` plus a pinned pack of tools from popular servers (GitHub, Notion, Linear…) | A real agent with several servers loaded |

The renderer is one function shared by every participant, so they all see exactly the same text.

---

## 5. Modes

| | `scan` | `test` | `test --live` | `diff` |
|---|---|---|---|---|
| Scenarios | Generated, blind, no labels | Labeled suite (acceptable-path sets, held-out split) | Labeled suite | Same as the base run |
| Executes tools | No | No (fixtures and fault injection for the evaluation probes) | **Yes**, in your sandbox | — |
| Trees | Map tree + first-click walk trees | Same, with labels | Full walks: dead ends, errors, loops | Flipped decisions on the trees |
| Gives a score | **No**, diagnostics only | Yes, with confidence intervals | Yes, completion by state | Count of flips above the noise floor |

**The live guard.** A tool runs only if it's annotated `readOnlyHint: true`, or explicitly allowed with `--allow tool,tool`. Annotations from untrusted servers are hints, not guarantees (per the MCP spec), so the allowlist is the actual protection, and live mode prints it before starting.

**Sandbox only.** Live mode runs tools for real, so it targets a sandbox or test environment, never production data. The harness refuses to start a live run until the operator confirms the target is a sandbox, runs only allowlisted tools, logs every write to `writes.jsonl` for cleanup, and resets or isolates state between walks: a walk must never see what an earlier walk created. (Pilot 002 learned this the hard way: the first "capture an idea" walk created the idea, so later walks hit a duplicate-slug error caused by the test itself, not the server.)

**Context budget.** A participant's window holds the tool surface, the server instructions and the transcript. When the surface alone nearly fills it, walks run out of room after a few steps. That's reported as a finding about the surface (its size), not as a participant failure; overflowing steps are marked `invalid`.

**Hands.** In live mode, arguments are filled in by a constrained generative model that sees the mission, the materials, the transcript and that one tool's schema, under the same rule as the participant: nothing gutfeel didn't have to say. Hands never choose the tool. When an argument is wrong, the failure is tagged `argument`, not `decision`, so participants aren't blamed for the hands' mistakes.

---

## 6. Contracts

All contracts are defined in `packages/core` as zod schemas, with JSON Schema exported for other languages. Every document carries `"$contract": "name@version"`.

| Contract | Key fields |
|---|---|
| `surface@1` | `server {name, version, transport, instructions}` · `tools[] {name, description, inputSchema, annotations}` · `hash` · `captured_at` |
| `jobmap@1` | `jobs[] {id, statement (verb + object + context, no solution words), source: needed\|claimed, steps[] {ulwick_step, tools[]}}` · `uncovered[]` · `dead_tools[]` · `overlaps[]` |
| `scenario@1` | `id, job_id, missions[] {text, lang, style}, materials {key: value}, acceptable_paths[][] (sets per step), success {kind: path\|state, check}, should_stall?, leakage_score` · personas live only in the authoring notes, never in what the participant sees |
| `protocol@1` | `question, surface_hash, suite_hash, frame, participants[] {id, version}, profiles, mode, samples, analysis_plan, exclusion_rules, live_allowlist, frozen_at, hash` · required for `test` |
| `frame@1` | `instruction, option_labels {ask_user, answer_directly, stop}, probe_frames {…}, version` · the only text gutfeel itself shows a participant |
| `event@1` | `run_id, walk_id, step, participant, profile, options_hash, distribution {option: p}, chosen, call? {tool, args}, result? {ok, excerpt, error?}, state: done\|wrong\|unfindable\|dead_end\|error\|stalled\|loop\|continue, rule?` |
| `run@1` | `surface_hash, suite_hash, participants[] {id, version}, profile, mode, walks[], metrics {…, ci}, created_at` |
| `finding@1` | `id, severity 0–4, frequency + ci, impact, job, step, walkthrough_q, evidence, participants {fails[], passes[]}, cause {span, delta_p}, fix?, verified?` |

**Cache.** Each decision is cached under `hash(rendered options + request + history + participant@version)`. Reruns and diffs cost nothing for decisions that didn't change, and `diff` compares two runs decision by decision.

---

## 7. Metrics

Effective N is the **number of jobs**, not phrasings. Confidence intervals come from a bootstrap clustered by job. Accuracy is corrected for chance (1/k options). Below 30 jobs, gutfeel shows findings but no summary numbers. The scoring formula is fixed on a development split before anything public is scored.

| Metric | Unit | Mode |
|---|---|---|
| Findability | share of phrasings with the correct tool in the search top 5 | all |
| Decision accuracy | first-click accuracy per step, against acceptable sets | all |
| Distinguishability | confusion matrix + mean margin per tool pair | all |
| Argument legibility | correct parameter / enum choice | test |
| Result comprehension · error triage · silent failures | accuracy against labeled fixtures | test |
| Panel divergence | share of decisions where non-deliberating participants split from the reasoner | all |
| Completion · lostness (Smith 1996) · recovery | per walk | live |
| Noise floor | flips under meaningless edits (reordered tools, whitespace) | diff |

---

## 8. Repository layout

pnpm + Turborepo, TypeScript strict, Node ≥ 22, vitest, tsup.

```
gutfeel/
├── packages/
│   ├── core/        contracts (zod + JSON Schema) · metrics · CI math · tree builders. Pure: no IO.
│   ├── engine/
│   │   ├── surface/       stdio · streamable HTTP · OAuth (local callback, keychain cache) · --header · tools.json
│   │   ├── participants/  bm25 · embed · jev · small · reasoner · shared renderer · decision cache
│   │   ├── map/           claimed + needed job maps · diff
│   │   ├── script/        blind scenario writer · leakage check
│   │   ├── run/           dry runner · live runner · hands · live guard · fault injection · alley rules
│   │   └── find/          findings · severity · ablation · rewrite verification
│   ├── ui/          React + SVG (d3-hierarchy for layout): map tree · walk tree · alley log · confusion · findings · diff
│   ├── controls/    planted (positive) and clean (negative) MCP servers + their expected findings
│   └── cli/         `gutfeel scan|test|diff|replay|report` · serves the UI · exports static HTML
├── suites/          public labeled suites (one folder per server)
├── docs/            DESIGN.md · method notes · validation results
└── examples/        reports from real runs (only real ones)
```

Dependency rule: `core` ← `engine` ← `cli`, and `ui` depends only on `core`. The UI renders contracts, so a report can be opened from a JSON file with no server attached.

---

## 9. First evaluations

| Server | Connection | Modes | Live allowlist | Notes |
|---|---|---|---|---|
| **Praxis** | `https://mcp.getprisma.lat` · OAuth as the smoke user, seeded tenant | scan · test · **live** | Read tools + writes on the smoke tenant only | Our own sandbox, so the only server where writes are allowed. Its `instructions` ("start with `pm_get_state`") must be part of what participants see. |
| **Linear** | `https://mcp.linear.app/mcp` · OAuth | scan · test · live (read-only) | Tools marked `readOnlyHint` (list/get/search) | Run live against our own Linear workspace, reads only |
| **Supabase** | `npx @supabase/mcp-server-supabase --read-only --project-ref=<scratch>` · PAT | scan · test · live (read-only) | The server's own `--read-only` + gutfeel allowlist | **Scratch project only, never production**: query results would include user data sent to the participants |
| GitHub, Notion, Stripe | Public endpoints | scan · dry test | — | For the crowded pack and the first AX reports |

Output per server: `examples/<server>/run.json` + a static report. Nothing is published as an AX report until validation E1–E5 is done and the maintainer has had the 14-day preview.

---

## 10. Validation (gates the public reports)

| | Question | Passes if |
|---|---|---|
| E1 | Do gutfeel-guided edits help real agents on held-out tasks? (vs random rewording, vs adding text to every description) | Small/mid models +5 points; frontier models lose no more than 1 point; tokens grow no more than 15% |
| E2 | Which participant best predicts real agents' failures? | Jev beats `embed` by ≥0.05 AUROC, or it stops being the default |
| E3 | Is it reliable? | Kendall τ ≥ 0.9 between runs, ≥ 0.8 between independently generated scenario sets; Jev calibration error < 0.1 |
| E4 | Does dry accuracy predict live completion? | r ≥ 0.7 |
| E5 | Does it catch deliberate damage? | Score drops step by step as descriptions are degraded |

Results go in `docs/validation/`, including failures.

---

## 11. Structural findings, not only wording

A lot of fixes aren't rewrites. They're changes to the shape of the tool surface. The find stage also reports:
- **Consolidation candidates:** pairs that are always called together, in the same order (merge them into one higher-level tool).
- **Over-capacity:** more tools than a client shows comfortably, or more than fit in Jev's option window.
- **Missing handles:** results that leave out identifiers the next tool needs (from the dead-end rule *missing handle*).
- **Namespace collisions** in the `crowded` profile, e.g. `save_issue` vs `pm_add_work_item`.

## 12. Security

- **Running a server is running code.** `npx gutfeel -- <cmd>` executes whatever command it's given. gutfeel prints the command, and in `scan` mode runs stdio servers with no inherited environment except the variables named in `--env`.
- **Tool descriptions and results are untrusted input.** They can carry prompt injection aimed at the hands and the reasoner ("tool poisoning"). Hands only get the schema of the tool already chosen, their output is validated against that schema, and runs flag descriptions that contain instructions to the model.
- **Data leaves your machine.** Live results go to the participants' providers. Use sandboxes and scratch projects. Jev is zero-retention; check the policies of the other providers you configure.
- **No secrets in contracts.** Headers and tokens are removed from `surface@1` and `run@1` before anything is written to disk.

## 13. Build order

Chunks don't overlap and together cover the spec, so after C1 they can be built in parallel.

| Chunk | Delivers | Depends on |
|---|---|---|
| C1 | `core`: contracts (incl. `protocol@1`), metrics, CI math, tree builders + tests | — |
| C1b | Control servers: the planted (positive) and clean (negative) MCP servers + their expected findings | C1 |
| C2 | `engine/surface`: every connection type → `surface@1` | C1 |
| C3 | `engine/participants`: panel + renderer + profiles + cache | C1 |
| C4 | `engine/map` + `engine/script` | C1 |
| C5 | `engine/run` dry + `cli scan` | C2, C3 |
| C6 | `ui`: map tree, walk tree, alley log | C1 (built against fixture contracts) |
| C7 | `engine/run` live: hands, guard, alley rules, fault injection | C5 |
| C8 | `engine/find`: findings, ablation, verified rewrites | C5 |
| C9 | First evaluations: Praxis, Linear, Supabase | C5–C7 |
| C10 | Validation E1–E5 | C9 |
