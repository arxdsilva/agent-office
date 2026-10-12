## Why

<!-- What problem does this solve? -->

## Checklist

- [ ] Built test-first (red → green → refactor)
- [ ] `make check` is green: arch (hexagonal dependency rule) + coverage ≥70% on touched packages
- [ ] New driven-port implementations pass the port's contract suite
- [ ] E2E test added/updated for behavior changes (`packages/adapters/test/`)
- [ ] App/UI changes covered by `make test-ui` (Playwright Electron) and a screenshot below
- [ ] Public contracts (HTTP, IPC, hook output) changed additively only; README tables updated
- [ ] `.claude/rules/PRIVACY_SECURITY.md` respected (Electron checklist, `textContent` only, no raw transcript logging)

## Screenshots

<!-- For scene/UI changes -->
