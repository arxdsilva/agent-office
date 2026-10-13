# Scene adapters

One `SceneView` port (`packages/web/src/ports.ts`), three renderers behind `SceneHost`:
Classic 3D (`adapters/three`), 2D RPG (`adapters/pixel`) and Minimal (`adapters/minimal`, a static
DOM hierarchy fed by `setRoster`; docs/minimal-mode.md).
The two spatial renderers draw the same director plans and send picks and semantic interactions
(`onPickInteraction`, `INTERACTION_KINDS`) back to the controller; Minimal sends picks only. None
holds business logic.
Switching modes never restarts agents or changes sessions; `SceneHost` replays the cached state
(layout, plans, selection, graphics, wall mode) into the new scene.
