# Contributing to gutfeel

Thanks for helping. gutfeel is a measuring instrument, so contributions are held to its method. A clever change that weakens the method will be declined, however good the code is.

## The most valuable contributions

1. **Missions.** Real requests, phrased the way people actually ask, in any language. Requests from real users of an MCP server are worth more than anything we can write ourselves.
2. **Suites.** Labeled task scenarios for a public MCP server: missions, materials, acceptable paths and success checks. They live in `suites/<server>/`.
3. **Control defects.** New kinds of defect to plant in the positive control server. A failure mode gutfeel can't catch yet is a bug report on the instrument.
4. **Code.** Pick a chunk from the [build order](docs/DESIGN.md#13-build-order).

## Rules for missions (non-negotiable)

| Rule | ✓ | ✗ |
|---|---|---|
| The user's words, not the product's | `dale luz verde a esta idea` (Spanish: "give this idea the green light") | `commit the work item` |
| A goal, not steps | `create an account` | `look up the email, then create the user` |
| No tool vocabulary | `who's on my team?` | `list members` |
| Missing data goes in materials | `create an account` + `email: ana@example.com` | `create an account for ana@example.com with the signup tool` |
| Short, as people type | `invite ana` | a paragraph of background |

**Write missions without looking at the server's tool descriptions.** If you already know the tools well, ask someone who doesn't to write them. Every mission goes through the leakage check, and the ones that fail get rewritten.

**Label separately from writing.** Acceptable paths and success checks are added by someone who didn't write the missions. Two labelers per suite, with disagreements settled before the suite is merged.

## Rules for code

- **TypeScript strict.** `pnpm typecheck` and `pnpm test` must pass.
- **`packages/core` stays pure.** No network, filesystem or clock calls.
- **Contracts are versioned.** Changing the shape of a contract means bumping its version (`run@1` → `run@2`) with a migration note. Never change a contract silently.
- **The harness tests itself.** A change that touches `run`, `participants` or `find` must still catch every planted defect and pass the clean control.
- **gutfeel's words are frozen.** Changing anything a participant sees that gutfeel wrote (the frame, option labels, probe questions) requires a new `frame@N` and a frame-sensitivity run, attached to the PR.
- **No secrets in fixtures or contracts.** Headers and tokens are removed before anything is written.

## Commits and PRs

- Use [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `docs:`, `chore:`). Each commit is one logical change, and its message explains *why*.
- Keep PRs small, and say which chunk or issue a PR addresses.
- For results-affecting changes, include before and after runs on the control servers.

## Disputing a published report

If you maintain a server that gutfeel has reported on, use the [report dispute form](https://github.com/huayaney-exe/gutfeel/issues/new?template=report_dispute.yml). Disputes are handled before anything else, and corrections are published next to the original report.

## Conduct

This project follows our [Code of Conduct](CODE_OF_CONDUCT.md).
