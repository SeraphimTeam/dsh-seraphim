# Better Model Selection - Reflection

## Current reflection

The implementation preserves the intended owners: DSH settings persistence and `ModelDirectory` remain canonical, while Seraphim contributes only the toggle and conditional composer UI. Static slot inspection proved `-10` is the correct shadow priority because the registry sorts lower priorities first; the dynamic runner's forced priority is not used by this static bundle. The browser code now guards a missing settings scope so the native entry remains available rather than crashing.

The focused source, bundle, and SlotCore checks pass. The active profile resolves the plugin through a local link, and restarting the existing DSH Desktop process recomposed the boot graph and served the updated client artifact at `http://127.0.0.1:43900`. The remaining evidence gap is browser-level interaction and screenshot coverage, not source composition. No DSH checkout files were modified.

## Complexity Closure

- Budget status: exceeded-and-governed
- Governed now: the oversized single-file client was kept bounded to the approved inline picker block; unrelated provider-card refactoring was not added.
- Deferred follow-up: extract the picker when the repository provides a supported multi-module client build boundary.
- Completion impact: needs-follow-up for maintainability, not blocking correctness.

## Governance Closure

- Repair Track: review findings for write feedback, stale catalog errors, and zero-model providers were repaired and reverified.
- Retirement Track: native DSH picker and `/model` remain retained compatibility owners; the Seraphim shadow is disposed when disabled. Retirement trigger is removal of the feature, which must delete the setting and shadow together.
- Residual Risk: browser interaction evidence remains unavailable.

Method Pack output does not grant completion authority.
