# Scene rule (three.js)

| Do                                                                                         | Don't                                                  |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Reuse geometries/materials from the shared cache in `adapters/three/office.ts`                            | Create a new geometry/material per avatar or per frame |
| `dispose()` geometries, materials and remove CSS2D elements when an avatar is removed      | Leave detached objects in memory                       |
| Take colors only from `shared/src/status-colors.ts`                                        | Hard-code status colors in web code                    |
| Take positions only from `app/layout.ts`                                                       | Compute desk positions inside avatar/scene code        |
| Keep `update(dt)` allocation-free (reuse vectors)                                          | `new Vector3()` inside the render loop                 |
| Stay within budget: 200 agents at 60 fps on a laptop (`POST /api/mock?n=200` in mock mode) | Ship a scene change without checking the budget        |
| Verify visually with `/run-office` + screenshot                                            | Call a scene change done from tests alone              |

The scene is an adapter: `web/src/adapters/three/scene.ts` implements the `SceneView` port. What to show comes from the controller (`sync(agents, layout)`, `select(id)`). Picks go back through `onPick`. Keep decisions out of the scene.
