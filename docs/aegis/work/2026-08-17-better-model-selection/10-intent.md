# Better Model Selection - Intent

## TaskIntentDraft

- Requested outcome: Implement and verify the approved Seraphim provider-first model picker with a persisted toggle and native fallback
- Goal: Implement and verify the approved Seraphim provider-first model picker with a persisted toggle and native fallback
- Success evidence:
- `lib/providers/seraphim-config.js` owns a false-default Schemastery setting.
- `lib/index.js` registers the `seraphim` namespace through DSH settings.
- The browser binds the same namespace through `settingsScope` and never creates a second persistence route.
- The custom composer slot is conditional and native fallback remains available.
- Focused checks and live artifact verification pass. Browser interaction, screenshot, and mobile/keyboard session evidence remains an explicit residual gap in this tool context.
- Stop condition: Stop when success evidence is satisfied or a blocker/risk requires pause.
- Non-goals:
- no DSH checkout edits
- no provider adapter or `/model` command changes
- Scope: Seraphim host settings namespace, browser Settings toggle, conditional composer model slot, focused and Web GUI verification
- Change kinds:
- feature
- Risk hints:
- `lib/client.js` is already oversized; keep picker code bounded and do not refactor unrelated provider cards.
- Slot priority and live settings composition must be verified in the actual profile.

## BaselineReadSetHint

- none

## BaselineUsageDraft

- Required baseline refs:
- none
- Acknowledged before plan:
- none
- Cited in plan:
- none
- Missing refs:
- none
- Advisory decision: continue

## ImpactStatementDraft

- Compatibility boundary: Compatibility boundary not yet refined.
- Affected layers:
- none
- Owners:
- none
- Invariants:
- none
- Non-goals:
- none

These records are Method Pack drafts / hints, not authoritative runtime decisions.
