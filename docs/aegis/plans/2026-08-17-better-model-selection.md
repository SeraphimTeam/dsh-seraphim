# Better Model Selection — Implementation Plan

## Goal

Add the Seraphim-exclusive **Better Model Selection** toggle and a two-pane composer model picker:

- Settings → Seraphim exposes a persisted toggle, defaulting off.
- When on, the composer model seat shows providers with their existing Seraphim logos in the left pane and the selected provider's models in the right pane.
- Model and reasoning-effort changes continue through DSH's existing per-session model directory.
- When off, the shipped DSH model picker remains the visible composer control.
- `/model` remains the shipped popup command.

The user approved this design in-session on 2026-08-17. A reversible pre-feature checkpoint was pushed as commit `8822bb02` on `origin/main`.

## Architecture

Seraphim owns only the feature configuration and its UI contribution. The DSH model-selection service remains the canonical source of provider groups, model metadata, current selection, and effort metadata.

The custom composer entry is an additive Seraphim browser contribution to the existing `conversation.input.model` single slot. DSH's static single-slot registry sorts lower numeric priorities first, so Seraphim uses explicit priority `-10` only while the setting is enabled, shadowing the shipped priority-`0` entry. On disable, the Seraphim registration is disposed and the shipped entry becomes active again. The dynamic runner's automatic priority allocator does not apply to this statically bundled plugin.

The existing native `/model` command is retained as-is. This is an external/user-facing compatibility path, not duplicate model state: both surfaces read and write the same `ModelDirectory` instance for each session.

## Tech Stack

- ESM JavaScript, React 18 JSX runtime, Cordis client slots.
- `@deepseek-ai/schemastery` for host settings schema.
- `@deepseek-ai/dsh-settings` for persisted settings registration and live updates.
- `@deepseek-ai/dsh-client-ui-settings`'s `settingsScope` client service for the same namespace; no second persistence route is needed.
- Inline styles plus DSH theme CSS variables; existing Seraphim logo data URIs.
- Node `node:test`-style `.mjs` preview checks already used by this repository.

## Baseline / Authority Refs

- `README.md`: Seraphim merges five providers and owns the Settings → Seraphim section; provider model picker entries otherwise behave as native DSH entries.
- `lib/index.js`: current Seraphim host owner and provider-flags route pattern.
- `lib/client.js`: current Seraphim settings section, logo registry, and client bundle entry.
- DSH inspected runtime evidence:
  - `@deepseek-ai/dsh-client-ui-model-selection/lib/client.js`: shipped `conversation.input.model` owner, `ModelDirectory` injected face, shared `/model` command, provider groups, effort metadata, and slot priority behavior.
  - `@deepseek-ai/dsh-client-web-react/lib/index.js`: higher-priority single-slot entries shadow lower-priority entries; session slot entries receive injected faces and owner props.
  - `@deepseek-ai/dsh-settings/lib/index.js`: `ctx.settings.register()` / `installSettingsSection()` live settings contract.
  - `@deepseek-ai/dsh-cordis-client-runner/lib/client.js`: `conversation.input.model` is a session-scoped single slot with `locked` owner props.
  - `@deepseek-ai/dsh-host-apiproxy/lib/index.js`: provider groups are `{id, name, models}` and models include descriptions/reasoning metadata.
- `docs/aegis/BASELINE-GOVERNANCE.md`: project-local Aegis baseline and ownership rules.

Baseline status: **aligned**, with no Design Defect or Implementation Drift found. No existing project `DESIGN.md`, ADR, or architecture baseline was present; visual work is therefore a draft without direction, with ENERGY 1 / RHYTHM 1 / MOTION 1, constrained by the existing DSH theme and Seraphim visual language.

## Compatibility Boundary

- Default/off behavior must remain the shipped native composer picker.
- Existing `/model` behavior must remain unchanged.
- Existing provider logos, provider IDs, model IDs, model descriptions, effort IDs, and selection payloads must not be redefined.
- Provider adapters, credentials, provider enable/disable flags, and model catalogs must not be changed by this feature.
- Failed setting persistence must not leave the UI in a misleading enabled state.
- Settings service absence must preserve current Seraphim UI behavior and must not crash the plugin.
- A model selection must submit exactly `{provider, model}` plus `reasoningEffort` only when selected, using the existing injected `select` function.
- The feature must not add a second model-directory cache or a second `/model` command.
- Rollback boundary: reset to `8822bb02` if the feature cannot be verified or causes regressions.

## TDD Route

- Mode: off
- Decision: skipped
- Strict authority: not applicable; the user did not request strict test-first TDD.
- Test posture: post-change regression plus client bundle execution checks.
- Reason: the feature crosses host settings, live slot registration, and browser rendering; focused regression checks provide proportional coverage without inventing a strict RED/GREEN workflow.
- Verification: run the new config/route checks, existing provider-flags checks, client factory smoke test, syntax/import checks, and a built Web GUI smoke test after rebuilding the affected client artifact.

## Verification

Focused checks:

```powershell
node preview/test-seraphim-config.mjs
node preview/test-provider-flags.mjs
node preview/test-slot-priority.mjs
node preview/client-bundle-check.mjs
node --check lib/index.js
node --check lib/client.js
```

Build/deployment checks:

```powershell
pnpm run build
```

Then restart DSH Web if required by the active watcher/runtime and verify `http://127.0.0.1:<detected-port>` after refresh:

1. Settings → Seraphim shows Better Model Selection off by default.
2. Enabling it persists after reopening Settings/reloading the GUI.
3. Composer picker opens as provider-left/model-right panes, with all five existing logos.
4. Selecting a provider changes only the right pane.
5. Selecting a model updates the current model and closes/restores focus.
6. Models with reasoning metadata expose effort choices and preserve the selected effort.
7. Disabling the toggle restores the native picker.
8. `/model` remains usable in both modes.
9. Keyboard Escape, focus restoration, disabled/locked state, loading, empty, and error states are functional.

## Aegis Visibility

Planning is useful because this is a medium/high cross-module UI change: Seraphim must own a live persisted toggle and shadow an existing DSH single-slot owner without duplicating the model-selection source of truth.

## Plan Basis

Approved design above, current repository/runtime inspection, and pushed rollback checkpoint `8822bb02`.

## BaselineUsageDraft

- Required baseline refs: `README.md`, `lib/index.js`, `lib/client.js`, DSH model-selection/runtime/settings sources listed above.
- Delivered context refs: current conversation design approval and runtime inspection outputs.
- Acknowledged before plan refs: all required refs were read before task decomposition.
- Cited in plan refs: yes, in Baseline / Authority Refs and Architecture.
- Missing refs: no project DESIGN.md, ADR, CONTEXT.md, or owner baseline.
- Decision: continue.

## Requirement Ready Check

- Requirement source refs: user request and approved design in-session.
- Goals and scope refs: Goal and Architecture sections above.
- User / scenario refs: click composer selector; choose provider; choose model; configure toggle in Seraphim.
- Requirement item refs: toggle persistence/default; two-pane provider/model flow; logos; native fallback; shared DSH selection.
- Acceptance / verification criteria refs: Verification section above.
- Open blocker questions: none.
- Decision: ready.

## Files

Create:

- `lib/providers/seraphim-config.js`: Seraphim-owned schema/default for `betterModelSelection`; no independent file persistence, because DSH settings already owns the plugin namespace persistence contract.
- `preview/test-seraphim-config.mjs`: host settings registration and config default regression checks.

Modify:

- `lib/index.js`: register the Seraphim settings namespace through DSH's existing settings owner; no duplicate browser route.
- `lib/client.js`: include the public settings/model-selection client services in the client graph; add the Settings toggle; add live feature state; add the shadow composer slot contribution; implement the two-pane picker and its states; update English copy and CSS.
- `package.json`: add `@deepseek-ai/dsh-client-ui-model-selection` to the client injection graph so `modelDirectories` is an explicit upstream service; keep the existing settings client package in the graph.
- `preview/client-bundle-check.mjs`: assert the new client bundle still loads and exports correctly; keep this a smoke check, not a DOM renderer.
- `README.md`: document the toggle and native fallback only if the final behavior is user-facing enough to require installation/use notes.

No DSH checkout files are modified. No provider adapter files are modified.

## Change Necessity

- User-visible need: the current native picker groups models in one list and does not offer the requested provider-first navigation.
- No-change / non-code option: changing README/config text cannot change composer interaction; patching DSH checkout would violate Seraphim ownership and complicate distribution.
- Why code change is necessary: the feature needs a live Seraphim setting, conditional slot registration, and a new React interaction.
- Minimum change boundary: Seraphim host settings registration plus `lib/client.js` custom composer slot; reuse DSH settings, model-directory, and selection contracts.
- Decision: code-change.

## Existence Check

- Proposed new surface: Seraphim config schema and custom composer picker component.
- Existing owner / reuse candidate: DSH Settings service, DSH `conversation.input.model` slot, DSH `ModelDirectory`, existing Seraphim `LOGOS` and Settings section.
- Why existing surface is insufficient: the native picker is shipped UI and cannot provide a Seraphim-exclusive toggle or provider-first two-pane visual; DSH's model-directory service is sufficient for data and selection.
- Creation proof: new config is needed for persistence and live enablement; new picker is needed for the approved interaction. No new model owner/cache/command is created.
- Entropy / retirement impact: one conditional shadow entry adds a bounded UI path; the native entry remains the explicit off-mode compatibility path and is not retired.
- Decision: add-with-proof for the config and picker UI; reuse-existing for data, selection, logos, `/model`, settings persistence, and slot infrastructure.

## Architecture Integrity Lens

- Invariant: one canonical model directory and selection command per session.
- Canonical owner / contract: DSH `ModelDirectory` / `conversation.input.model` plus DSH settings persistence; Seraphim owns only feature config and rendering.
- Responsibility overlap: avoided; the picker must not fetch catalogs, resolve IDs, or write model state itself.
- Higher-level simplification: use a conditional high-priority slot registration rather than patching DSH source or replacing the entire conversation composer.
- Retirement / falsifier: if DSH slot priority cannot safely restore the native entry on disable, stop and use the profile-level composition boundary rather than adding a second active picker.
- Verdict: proceed with conditional existing-slot shadowing.

## Plan Pressure Test

- Owner / contract / retirement: explicit; Seraphim setting and picker own UI, DSH owns data/selection, native entry remains off-mode fallback.
- Architecture integrity / higher-level path: preserved via injected model-directory face and slot priority.
- Verification scope: host settings registration, bundle load, source syntax, settings fallback, UI state, live Web GUI.
- Task executability: exact files and commands are listed below; runtime owner behavior is verified from installed DSH artifacts.
- Pressure result: proceed.

## Complexity Budget

- Artifact class: Source Complexity + Test Complexity + Decision / Plan Complexity.
- Target files / artifacts: existing `lib/client.js` (1,759 lines), `lib/index.js` (139 lines), new config/test files, this plan.
- Current pressure: `lib/client.js` is over the 1,200-line strong signal and contains unrelated Settings card UI; adding a new responsibility in place would be risky.
- Projected post-change pressure: high because the repository's current browser bundle is a single generated-style file and the picker is implemented inline; the feature remains bounded to one clearly delimited owner section.
- Budget result: at-risk but accepted for this slice.
- Planned governance: retain the inline picker in `lib/client.js` for bundle-wrapper compatibility; do not refactor unrelated provider-card code during this feature. Extract only in a follow-up change if the repository adopts a supported multi-module client build boundary.

## Execution Readiness View

- Intent Lock: implement the approved Better Model Selection toggle and provider-first two-pane picker.
- Scope Fence: Seraphim files only; no provider adapter changes, no DSH checkout edits, no `/model` redesign.
- Baseline Lock: checkpoint `8822bb02`; DSH installed runtime contracts inspected and cited above.
- Approved Behavior: off by default; persisted toggle; on-mode provider-left/model-right picker; logos; shared model/effort selection; native fallback.
- Owner / Contract Constraints: DSH model directory and selection payloads remain canonical; Seraphim conditional slot shadow only.
- Compatibility Boundary: native picker and `/model` unchanged when off and always available as fallback.
- Retirement Boundary: no destructive retirement; native entry is retained as compatibility behavior.
- Task Batches: config contract → picker UI/wiring → focused verification → build/Web GUI verification.
- Test Obligations: settings/config defaults; provider/model selection payloads; effort selection; disabled/loading/error/empty states; client bundle load; native fallback presence.
- Review Gates: inspect diff for duplicated catalog/selection owners; run focused checks before build; perform UI Delivery Gate before completion.
- Drift / Rewind Rules: if DSH runtime contract differs from inspected evidence, stop implementation and return to design; if UI cannot restore native entry, reset to `8822bb02` or revise the approach; do not patch DSH checkout.
- Evidence Required Before Completion: command outputs, git diff/status, built artifact check, live GUI smoke after refresh, antislop PASS report.
- Advisory Boundary: method-pack execution guidance only; not authoritative completion authority.

## Tasks

### Task 1 — Add Seraphim live config ownership

**Implementation note:** the initial route draft was retired after runtime inspection; DSH's `settingsScope` is the canonical browser transport, so no `/plugins/seraphim/config` route is part of the final implementation.

**Files:** create `lib/providers/seraphim-config.js`, create `preview/test-seraphim-config.mjs`, modify `lib/index.js`.

**Why:** the toggle must be persisted in Seraphim's own configuration namespace and readable/writable by the browser without inventing a second persistence system.

**Change Necessity:** a UI-only local state would not survive reloads or coordinate with the host; the minimum host boundary is one schema/default and one DSH settings registration.

**Impact/Compatibility:** default resolved value is `{ betterModelSelection: false }`; missing settings service keeps the client fallback off. Existing provider-flags route and provider application behavior remain unchanged. The browser uses the public `settingsScope` transport instead of a second config route.

**Verification:**

```powershell
node preview/test-seraphim-config.mjs
node preview/test-provider-flags.mjs
node --check lib/index.js
```

**Steps:**

1. Define the smallest schemastery object in `lib/providers/seraphim-config.js`: `betterModelSelection` is a boolean with a false default; export the schema and namespace constants used by host wiring.
2. Register the `seraphim` namespace in `lib/index.js` with the merged host config as its base, so existing Seraphim config remains valid and missing toggle values resolve false.
3. Use `installSettingsSection` with no-op source/change hooks because the host plugin does not otherwise own a settings UI; this keeps persistence and document updates in DSH's settings provider.
4. Write `preview/test-seraphim-config.mjs` with a minimal schema contract check and a host wiring stub proving the namespace is registered with the false base.
5. Run the focused checks and inspect the diff for accidental changes to the provider-flags route.

### Task 2 — Implement the Seraphim two-pane picker as a conditional slot contribution

**Files:** create `lib/model-selection.js` if the bundle wrapper permits a clean module boundary; otherwise modify the delimited feature section of `lib/client.js`; modify `lib/client.js` and `package.json` only for wiring/injection declarations.

**Why:** this delivers the provider-first interaction while reusing DSH's live model directory.

**Change Necessity:** the shipped DSH component cannot be configured into the requested provider-left/model-right layout; a Seraphim-owned shadow entry is the minimum UI change.

**Impact/Compatibility:** register only when the live config is true. Use the injected face `{available,directory,load,select}` and `locked` owner prop. Never fetch models directly or parse provider/model IDs. On selection call `select({provider,model,...reasoningEffort})`; on rejection show an inline/toast error without changing source-of-truth state. When config becomes false, dispose the registration so the native entry wins.

**Verification:**

```powershell
node preview/client-bundle-check.mjs
node --check lib/client.js
```

**Steps:**

1. Extend the client injection list only with the services required for live config and the existing model-selection face; do not import DSH internals that are not public runtime services.
2. Bind `ctx.settingsScope` to the `seraphim` namespace, default false while loading/unavailable, and use its snapshot subscription plus `set("betterModelSelection", value)` write path.
3. Add a conditional `ctx.slots.inject("conversation.input.model", ...)` registration with a priority higher than the native entry. Keep registration/disposal in one effect tied to the feature flag so toggling off restores the native picker without a reload.
4. Implement the trigger using the existing current model/effort labels and the DSH theme variables. Render the menu as a two-column layout: provider list left, selected provider model list right. Each provider row renders its logo from `LOGOS` and its DSH provider name; each model row renders name/description and selection state.
5. Preserve the native effort behavior: if the selected model has reasoning metadata, render an effort control in the right pane or a compact sub-pane; submit the existing effort ID or omit it for provider default.
6. Implement loading, empty, provider-catalog failure, selection failure, locked, outside-click, Escape, arrow navigation, and trigger focus restoration states. Keep the menu within viewport bounds and do not add gradients, broad glow, or unnecessary elevation.
7. Add English copy keys for toggle title/description, provider/model pane labels, loading/empty/error/retry, and accessible names. Keep copy concise and use existing Seraphim terminology.
8. Re-run the client bundle factory check after the feature is wired.

### Task 3 — Wire the Settings toggle and source-of-truth updates

**Files:** modify `lib/client.js`, optionally `lib/model-selection.js` depending on Task 2 boundary, and `preview/client-bundle-check.mjs`.

**Why:** users need a discoverable Seraphim-exclusive control and the picker must react without restart.

**Change Necessity:** the existing Seraphim Settings section is the canonical UI owner for Seraphim configuration; a separate Settings tab would duplicate ownership.

**Impact/Compatibility:** preserve all existing provider cards, logos, switches, auth flows, and text. Add one clearly separated config row, not another provider card. Toggle is keyboard accessible and reports persistence errors.

**Verification:**

```powershell
node preview/client-bundle-check.mjs
node --check lib/client.js
```

**Steps:**

1. Load the config alongside provider flags in `SeraphimSection`; default the feature to false until the host answers.
2. Render a compact settings row labeled **Better Model Selection**, with a short explanation that it changes the composer picker to provider-first navigation and a switch using the existing switch treatment.
3. Wire optimistic PUT/revert behavior and an inline error message without exposing credentials or other settings values.
4. Ensure the live flag drives the conditional slot registration and that remounting/reloading returns to the persisted value.
5. Update `preview/client-bundle-check.mjs` to assert the bundle still contains the toggle label, `settingsScope`, conditional model-slot wiring, and exactly one `exports.apply`.

### Task 4 — Run complete verification and UI delivery gate

**Files:** no new production owner; inspect all changed files; update `README.md` only if final user-facing use instructions are needed.

**Why:** cross-module UI work needs both source-level and live GUI evidence.

**Change Necessity:** verification is required to prove the native fallback, live setting, and shared model-selection contract rather than merely proving JavaScript parses.

**Impact/Compatibility:** no behavior changes beyond the approved toggle and its on-mode picker.

**Verification:**

```powershell
node preview/test-seraphim-config.mjs
node preview/test-provider-flags.mjs
node preview/client-bundle-check.mjs
node --check lib/index.js
node --check lib/client.js
pnpm run build
```

Then detect the currently running DSH Web GUI port from the DSH Desktop process, refresh the existing GUI URL, and verify Settings → Seraphim plus the composer picker in both modes. Do not start a replacement server.

**Steps:**

1. Review `git diff --check` and `git status --short`; ensure only intended Seraphim files and Aegis plan/workspace records changed.
2. Run every focused regression and syntax check above; investigate any non-zero exit before continuing.
3. Rebuild the affected Web artifact using the existing DSH checkout build process. Confirm the client bundle is served from the existing GUI, not a second server.
4. Verify the eight UI acceptance scenarios listed in the Verification section, including keyboard and error states.
5. Run the antislop core/UI Delivery Gate: intentional hierarchy, theme-derived palette, no generic gradient/glow/glass treatment, real behavior for every control, keyboard/focus support, responsive menu bounds, and no unexplained decoration. Report PASS/FAIL and fix failures before completion.
6. Commit the feature as one verified coherent commit, push it to `origin/main`, and record the final commit plus rollback checkpoint in the completion report.

## Risks

- The installed DSH runtime exposes `settingsScope` through `@deepseek-ai/dsh-client-ui-settings`; if the composed profile omits that service, the client must stay off and leave the native picker active rather than using untracked browser-only persistence.
- Slot priority semantics are verified in the installed runtime but must be checked in the actual composed graph; a failed restore on disable is a compatibility blocker.
- `lib/client.js` is already oversized; the picker should be extracted or kept as a bounded feature block, not accompanied by unrelated refactoring.
- Logo data URIs are large; reuse references and do not duplicate image payloads.
- The DSH Web GUI requires rebuilding affected artifacts and refreshing the existing URL; source edits alone do not prove runtime behavior.

## Retirement

No destructive retirement is planned. The native DSH composer picker and `/model` command remain active compatibility behavior. The only conditional shadow path is Seraphim's higher-priority composer entry, which is disposed when the setting is false. If the feature is later removed, delete the Seraphim config field and picker contribution together, then verify the native entry remains the sole active owner.

## Plan Self-Review

- Spec coverage: toggle, persistence/default, two panes, logos, model lists, effort, native fallback, `/model`, source-of-truth, keyboard/error states, and build verification each have task coverage.
- Placeholder scan: no implementation placeholder or unbounded instruction remains; runtime-dependent verification names exact evidence to collect.
- Type/contract consistency: selection payload follows DSH's inspected `{provider, model, reasoningEffort?}` contract; settings uses DSH settings registration rather than a second file.
- Compatibility: provider adapters and `/model` are explicitly unchanged; off mode is native.
- Change necessity: code-change boundary is stated for each source-edit task.
- Existence: new surfaces have proof; existing DSH services and Seraphim UI are reused.
- Complexity: the oversized client owner is governed by extraction/bounded block guidance.
- Architecture: one model directory and one selection source of truth remain canonical.
- Verification: focused commands, build, live GUI, and antislop gate are explicit.
- Retirement: no destructive deletion; conditional shadow has a clear disable path.
