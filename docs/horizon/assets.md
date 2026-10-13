# Horizon: assets

`make horizon-assets` builds the Classic modules with the Horizon palettes into
`packages/web/public/horizon/` (contract §14). Anchors, nav, floor plans, colliders and wall ids are
the Classic ones; the validator's `horizon` profile checks the set and that its anchor ids equal
Classic's. The Classic build never touches this directory and vice versa.
