# Testing rule — TDD, ≥70% unit coverage

## TDD is mandatory for behavior changes

1. **Red** — write a failing test and run it; confirm it fails for the expected reason.
2. **Green** — write the minimum code to make it pass.
3. **Refactor** — clean up with tests green.

No production code without a red test first. Bug fixes start with a test that reproduces the bug.

## Coverage bar

- Aim for **≥70%** statements/branches/functions/lines on every package you touch — measured on
  the **whole package**, not just new lines.
- `make coverage` enforces it. The task is **not done** while any package is below 70%.

Excluded from the threshold (rendering-only, covered by the Playwright smoke test instead), listed
in `vitest.config.ts`: `packages/web/src/{main,office,avatar,controls,panel}.ts`. Do not widen this
list without saying so in the PR.

## Layers

| Layer    | Where                                                                 | Tool                                       | Must                                                                                                        |
| -------- | --------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Unit     | `packages/*/src/**/*.test.ts`, `hooks/*.test.ts`, `scripts/*.test.ts` | vitest                                     | No network, no real `~/.claude` or `~/.agent-office` — use `os.tmpdir()` fixtures; time injected, not faked |
| E2E      | `packages/server/test/e2e.*.test.ts`                                  | vitest + real server on port 0 + real `ws` | Every behavior change ships one                                                                             |
| UI smoke | `packages/web/e2e/*.spec.ts`                                          | Playwright (Chromium)                      | Every UI behavior change ships a case                                                                       |

## Do / Don't

| Do                                                                      | Don't                                           |
| ----------------------------------------------------------------------- | ----------------------------------------------- |
| Fixtures shaped like real transcripts with **invented** content         | Copy real transcript content into fixtures      |
| A 1–3 line comment before each request in E2E tests saying what and why | Bare URL sequences no one can read              |
| `it.concurrent` only with no shared state                               | Share stores or servers across concurrent tests |
| Pass `now` into store/sweep functions                                   | Rely on wall-clock sleeps for logic tests       |
