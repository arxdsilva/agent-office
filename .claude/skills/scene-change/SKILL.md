---
name: scene-change
description: Change the agent-office 3D scene — layout/organization of zones and rows, desks, avatars, labels, animations, lighting, camera or walk controls. Use for any edit to packages/web/src/app/layout.ts, packages/web/src/adapters/three/*, or shared/src/grouping.ts.
---

# Change the 3D scene

Rules: `SCENE.md`, `TESTING.md`, `PRIVACY_SECURITY.md` (text via `textContent`).

1. **Organization or positions?** Start in pure code, test-first:
   - who goes where → `packages/shared/src/grouping.ts` (+ `grouping.test.ts`)
   - where desks are → `packages/web/src/app/layout.ts` (+ `layout.test.ts`); keep slots stable and subagents next to parents.
2. **Visuals** (`web/src/adapters/three/{scene,office,avatar,controls}.ts`): the scene implements the `SceneView` port — decisions stay in the controller; reuse cached geometries/materials, colors only from `STATUS_COLORS`, no allocations in `update()`, dispose on removal.
3. **Verify visually** with `/run-office`: overview framing (Fit), labels not overlapping, light and dark mode, walk mode collisions.
4. **Perf budget**: with `make dev-mock` running, `curl -X POST -H "authorization: Bearer $(cat ~/.agent-office/token)" 'http://127.0.0.1:4317/api/mock?n=200'` and confirm the scene stays smooth (~60 fps).
5. UI behavior change → add/adjust a spec in `packages/desktop/e2e/`; run `make build test-ui`.
6. `make check`.
