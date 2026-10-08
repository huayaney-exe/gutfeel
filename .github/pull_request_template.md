## Why

<!-- The reason for this change. The diff already shows what changed. -->

## Chunk / issue

<!-- e.g. C3 · participants, or #12 -->

## Method checklist

- [ ] `pnpm typecheck` and `pnpm test` pass
- [ ] Both control servers still behave as expected: every planted defect caught, the clean server passes
- [ ] No text a participant sees changed, **or** there's a new `frame@N` with a frame-sensitivity run attached
- [ ] Any change to a contract's shape bumps its version and includes a migration note
- [ ] No secrets in fixtures, contracts or logs
