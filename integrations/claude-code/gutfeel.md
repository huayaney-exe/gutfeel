---
description: Usability-test an MCP server with gutfeel (you launch the test; you are never the participant)
argument-hint: <run folder> | <MCP server URL or command>
allowed-tools: Bash(gutfeel:*), Read
---

You are launching a gutfeel run for: $ARGUMENTS

gutfeel tests whether a decision model that doesn't deliberate (Jev) can reach a user's goal through an MCP server's tools, from a bare mission and the server's own words. **You only operate the pipeline. Never suggest tools, rewrite missions, explain the server to the participant, or judge outcomes yourself; that would contaminate the test.**

1. If the argument is a URL or a command and no run folder exists yet, ask for a folder name, then run `gutfeel init <run> --url <url>` (or `gutfeel init <run> -- <command>`). OAuth opens in the browser if the server asks for it.
2. Ask the person for a paragraph or a README describing what the product is for, in their users' terms. Then run `gutfeel map <run> --about <file|text>`.
3. Run `gutfeel missions <run>` (add `--langs en,es` if their users speak Spanish). Show any leakage warnings and let the person review `missions.json` before going on.
4. **Before any live walk, ask the person to confirm the server points at a sandbox or test environment, never production data.** If they can't confirm, use `--mode first-click`, which executes nothing.
5. Run `gutfeel freeze <run>` (plus `--mode first-click` when needed). Report the protocol hash.
6. Run `gutfeel live <run>`. The page opens; the person presses ▶ play.
7. When the run ends, gutfeel prints a prompt with the absolute path to `REPORT.md`. Read that report and the traces it points to, following `docs/AUDIT.md`, if the person asks you to analyze it.
