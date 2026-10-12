# Parallel work rule — fan out by default

Work on agent-office is split across **parallel subagents** whenever a task touches two or more independent areas (assets, core, adapters, desktop, renderer logic, renderer adapters, docs). A single-area change or one under ~150 lines is done directly. The skill `/parallel-work` has the checklist and the agent prompt template.

## 1. The lead goes first, alone

| Do (lead, before launching agents)                                                                                                                                                                      | Don't                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Write the **shared contract**: docs (`docs/*.md`), shared types (`packages/shared`, `packages/web/src/app/office-types.ts`), port interfaces, IPC/HTTP shapes                                           | Let agents invent interfaces each other depend on                 |
| **Pre-install every dependency** (`pnpm add`)                                                                                                                                                           | Let two agents run `pnpm` concurrently (it corrupts the lockfile) |
| Make all **shared-config** edits: `package.json`, lockfile, `pnpm-workspace.yaml`, `Makefile`, `vitest.config.ts`, `tsconfig*`, `.dependency-cruiser.cjs`, CI workflows, `.gitattributes`, `.gitignore` | Hand shared config to an agent                                    |

## 2. Disjoint ownership

| Do                                                                                                                                                                                  | Don't                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Give every agent an explicit list of **owned files**, **forbidden files**, the **contract sections** it follows, its **verification commands**, and a **word-capped report** format | Launch an agent with "fix whatever you find" |
| Split along the hexagon: one agent per layer/package area                                                                                                                           | Give two agents the same file                |
| Use `isolation: "worktree"` when ownership can't be disjoint; the lead merges                                                                                                       | Hope concurrent edits to one file work out   |

## 3. Inside an agent

| Agents do                                                                 | Agents never                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| TDD, ≥70% coverage, the security and architecture rules — all still apply | `pnpm add/install`, edit shared config, `git add/commit/push` |
| Run **targeted** tests, `typecheck` and `pnpm arch`                       | Run the full suite or `make check` (others are mid-change)    |
| Report failures in other agents' files                                    | "Fix" another agent's files or tests                          |
| Develop against the contract + fixtures when a producer isn't done yet    | Block idle waiting; finish with stand-ins and report          |

## 4. Phases follow dependencies

contract → **producers in parallel** (assets, backend, pure logic) → **consumers** (adapters, integration; may start early against the contract) → **lead verification** → docs/screenshots.

## 5. Coordination and verification

| Do                                                                                                                      | Don't                                          |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Relay cross-agent facts through the lead (`SendMessage`)                                                                | Let agents coordinate implicitly through files |
| Make contract changes as the lead, additive only, and broadcast them to every affected agent                            | Let one agent change a shared contract         |
| After each phase: `make check`, `make build test-ui`, `pnpm arch`, plus a visual review (screenshots) for UI/asset work | Declare done from agent reports alone          |
| Route fixes back to the owning agent                                                                                    | Patch an active agent's files behind its back  |
| Keep ≤ 5 agents running at once                                                                                         | Spawn more because "it's faster"               |

**Plan mode pauses background agents.** Avoid entering it while agents run; if you must, resume each one with `SendMessage` afterwards.
