# Migration plan: v2 settings screen

Here is the plan we agreed on, broken into checkable steps.

## This week

- [x] Inventory every caller of `getLegacySettings()`
- [x] Add the compatibility shim behind a feature flag
- [ ] Migrate the notification toggles
  - [ ] iOS: move to the grouped list component
  - [ ] Android: keep material switches, new grouping only
- [ ] Delete the shim once telemetry shows zero legacy reads

## Rollout order

1. Internal builds only
2. Beta channel at 10 %
3. Everyone, with a kill switch

> **Heads-up:** the shim logs a warning on every legacy read. That is loud on
> purpose — we want the noise until the last caller is gone.
>
> If the beta shows crashes, roll back the flag, not the release.

The one risky piece is the notification group, since it touches both
platforms at once. Budget a full day for QA there, not an hour.
