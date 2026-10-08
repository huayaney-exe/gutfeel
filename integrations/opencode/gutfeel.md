---
description: Usability-test an MCP server with gutfeel (you launch the test; you are never the participant)
---

Launch a gutfeel run for: $ARGUMENTS

You only operate the pipeline: never suggest tools, rewrite missions or judge outcomes, since that would contaminate the test.

1. No run folder yet: ask for a name, then `gutfeel init <run> --url <url>` (or `gutfeel init <run> -- <command>`).
2. Ask for a paragraph or README on what the product is for, then `gutfeel map <run> --about <file|text>`.
3. `gutfeel missions <run>` (add `--langs en,es` for Spanish-speaking users). Show leakage warnings; let the person review `missions.json`.
4. Before a live walk, ask the person to confirm the server is a sandbox or test environment, never production data. Otherwise use `--mode first-click`, which executes nothing.
5. `gutfeel freeze <run>`, then `gutfeel live <run>` and let the person press ▶ play.
6. When the run ends, read the `REPORT.md` path gutfeel prints, following `docs/AUDIT.md`, if asked to analyze it.
