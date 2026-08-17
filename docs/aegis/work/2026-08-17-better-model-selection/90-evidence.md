# Better Model Selection - Evidence

## Source and runtime evidence

### Verification receipt

- Evidence action / check performed: focused source, config, provider-flags, SlotCore, bundle, diff, Aegis workspace, and live HTTP/boot-manifest checks.
- Result / exit status: all focused checks passed; workspace bundle/check passed; live GUI returned HTTP 200 and served the recomposed plugin graph.
- Covered scope: host settings schema/registration, static client bundle execution, slot priority/fallback semantics, existing provider compatibility checks, served client injection graph, and source-level UI states.
- Uncovered scope: browser DOM interaction, screenshots, manual keyboard navigation, mobile viewport behavior, and visual contrast measurement.
- Residual risk: full UI acceptance remains unobserved; source-level controls and responsive CSS are present.
- Confidence grade: B for source/runtime verification, C for full UI acceptance.

- `node --check lib/client.js` and `node --check lib/index.js`: passed after the current picker/settings edits.
- `node preview/client-bundle-check.mjs`: passed; factory loads, bundle id is `dsh-seraphim`, and feature markers are present.
- `node preview/test-seraphim-config.mjs`: passed; `seraphim` namespace, Schemastery boolean/default, and host registration contract pass.
- `node preview/test-provider-flags.mjs`: passed; existing provider flag store/route/adapter checks pass.
- `node preview/test-slot-priority.mjs`: passed; installed `SlotCore` confirms the explicit `-10` custom entry wins over native priority `0`, and disposing it restores the native entry.
- UI delivery gate source review: picker trigger and model/provider rows use 44px minimum targets; Escape, outside-click, focus restoration, loading, empty, catalog error, selection error, locked, and responsive single-column mobile states are present. Focus-visible CSS uses the DSH brand outline token. Settings writes now show a pending state and compare the post-write snapshot to the requested value, surfacing rejected/unavailable writes; stale catalog groups keep an alert and retry action; zero-model providers show an explicit empty state.
- `git diff --check`: passed; only the known LF/CRLF warning for `lib/index.js` was emitted.
- Installed DSH source inspection confirms model slot is a session-scoped single slot, lower priorities win, `slots.inject()` owns declaration lifetime, and `ModelDirectory` is the shared selection source.
- Live `http://127.0.0.1:43900/` responds 200 after restarting the existing DSH Desktop process. Its boot manifest advertises `dsh-seraphim` revision `031d41c21c94` with the updated five-service client injection list, including `@deepseek-ai/dsh-client-ui-model-selection`; the served bundle contains the latest settings-write feedback, stale-catalog alert, empty-provider state, optional-settings guard, and priority marker.
- No `pnpm run dev:web` or other client watcher process is running. The plugin package has no build script; the active profile resolves it directly through `link:E:/Project/Seraphim AIO`. Static client artifact reload is therefore verified through the existing Desktop restart, not a replacement server.

## Residual evidence gap

- No browser automation, DOM interaction, screenshot, or manual keyboard/mobile session was available in this tool context. The live HTTP/boot-artifact check proves the updated bundle is served, not every visual interaction path; confidence is B for source/runtime verification and C for full UI acceptance.
