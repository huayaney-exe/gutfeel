# Auditing a gutfeel run

Every number gutfeel reports has to be traceable to the exact text the participant saw and the exact answer it gave. This guide tells an auditor (a person, or a more capable agent) where that record lives and how to check it.

## The run folder

```
<run>/
├── surface.json       surface@1 · the server's tools/list and instructions, verbatim, hashed
├── missions.json      the missions and materials, written blind to the tools
├── jobmap.json        jobmap@1 · claimed jobs (from descriptions) · needed jobs (blind) · the join
├── protocol.json      protocol@1 · frozen before the first decision; every other file is checked against its hashes
├── walks.jsonl        event stream: one line per step, one per walk_end (what the live page draws)
├── traces/
│   └── walk-NNN.json  trace@1 · the full record of one walk (below)
├── blobs/
│   └── <sha256>.json  large payloads stored once: the tool criteria Jev chooses from, each tool schema the hands saw
└── writes.jsonl       every write the run made on the target, for cleanup
```

No key or token is ever written to any of these files.

## trace@1: one walk, in full

```jsonc
{
  "$contract": "trace@1",
  "protocol_hash": "…",                 // must equal protocol.json → hash
  "walk": 7, "job": "capture-idea",
  "mission": { "text": "guarda esta idea", "lang": "es", "style": "terse" },
  "materials": { "idea": "…" },
  "goal": ["pm_add_work_item"], "R": 2, "should_stop": false,
  "outcome": "done", "path": ["pm_get_state", "pm_add_work_item"],
  "metrics": { "S": 2, "N": 2, "R": 2, "lostness": 0, "errors": 0, "dead_ends": 0 },
  "steps": [
    {
      "step": 1, "at": "2026-10-08T…",
      "jev":   { "endpoint": "…/decisions", "request": { "model": "…", "state": "<full text the participant saw>",
                 "questions": { "next": { "type": "choice", "instructions": "What do you do next?", "criteria": { "$blob": "<sha256>" } } } },
                 "status": 200, "response": { "model": "typesafe/jev-1.13-…", "answers": { "next": { "choice": "…", "probabilities": { … }, "confidence": … } } },
                 "ms": 412, "attempts": 1 },
      "hands": { "request": { "model": "…", "messages": [ … ], "tools": [ { "$blob": "<sha256>" } ] }, "response": { … }, "ms": … },
      "mcp":   { "request": { "jsonrpc": "2.0", "method": "tools/call", "params": { "name": "…", "arguments": { … } } },
                 "status": 200, "response": { "result": { "content": [ … ] } }, "ms": … },
      "chosen": "pm_get_state", "executed": true, "goal_hit": false, "is_error": false, "dead_end": null
    }
  ]
}
```

Steps that weren't executed carry a `note` that says why: guarded (not on the allowlist), loop (same tool, same arguments), hands failed, server call failed, participant call failed.

## What to check

An audit should be able to answer each of these from the files alone.

1. **The inputs are the frozen ones.** Hash `surface.json` (without `hash`/`captured_at`) and `missions.json` the same way the protocol did, and compare with `protocol.json`. A mismatch voids the run.
2. **The participant saw only what the method allows.** In every `jev.request.state`: the frame label, the server instructions verbatim, the mission, the materials, and the transcript of earlier calls. Nothing else. The criteria blob holds only the tools' own descriptions and parameters, plus the three option labels from `protocol.frame`.
3. **The transcript is faithful.** Each step's state should contain the previous steps' `called:` arguments and `got:` results, cut only by the limits in the protocol (3,000 characters per result, last 12,000 overall).
4. **The decision is the participant's.** `chosen` must equal `jev.response.answers.next.choice`. The hands never choose a tool. Their request names the chosen tool and forces it.
5. **Arguments and decisions are attributed separately.** If an error comes from the arguments (an invalid UUID, a wrong enum), that's a hands error, not a decision error. Compare `hands.response` with the tool schema in the blob.
6. **The outcome follows the rules.** Apply `protocol.outcome_rules` and `protocol.goals` to the steps, and you should get the same `outcome`, `S`, `N`, `R` and `lostness`.
7. **Invalid is not failed.** Walks marked `invalid` must have a harness or infrastructure cause in their notes (a failed participant call, a context overflow, an unparseable response). They're excluded from the server's numbers, never counted against it.
8. **Writes are accounted for.** Every executed non-read-only call appears in `writes.jsonl`.

## For an auditing agent

Start from `protocol.json`, then `walks.jsonl` (`walk_end` lines give each walk's outcome and path), then open `traces/walk-NNN.json` for any walk you want to examine, resolving each `{"$blob": h}` from `blobs/h.json`. The live page shows the same record: click any ribbon, tool or outcome, then a walk.

Runs recorded before traces existed (pilot 002 and earlier) only have `walks.jsonl`. Their results are cut to 1,200 characters, and the participant, hands and server payloads weren't kept. The live page labels them *partial record*.
