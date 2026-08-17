# Seraphim (dsh-seraphim)

One DeepSeek Harness plugin that merges five native LLM providers into a
single **Settings → Seraphim** section:

| Provider | Route | Models |
| --- | --- | --- |
| Claude Code | `claude-code` | Claude Opus 5 / Sonnet 5 / Opus 4.x / Sonnet 4.x / Haiku 4.5 via Claude.ai OAuth |
| FreeBuff | `freebuff` | Free Codebuff models (DeepSeek V4 Flash / MiMo V2.5 / GPT-5.6 Luna / …) |
| Command Code | `commandcode` | Command Code AI models with plan filtering |
| ZED | `zed` | Zed.dev cloud LLM (Anthropic / OpenAI / Google / xAI) |
| Codex | `codex` | OpenAI Codex models (GPT-5.6 Sol/Terra/Luna / GPT-5.5 / GPT-5.4 / GPT-5.4 Mini / GPT-5.3 Codex Spark) via ChatGPT OAuth |

## What changed vs. the five original plugins

- **One package** (`dsh-seraphim`) replaces `dsh-claude-code`, `dsh-freebuff`,
  `dsh-commandcode`, `dsh-zed`, and `dsh-codex-connect`.
- The five provider cards no longer appear under **Settings → Plugins**;
  they live under a single **Settings → Seraphim** section (same slot pattern
  as the "Memory System" section from dsh-mnemon).
- Auth endpoints are unchanged (`/plugins/<provider>/auth/*`), so existing
  stored credentials under `~/.dsh` are reused as-is.

## Architecture

- `cordis.patch.yml` installs ONE host row (`llm-seraphim`) whose config is a
  per-provider map (`config.providers["claude-code"]`, `["freebuff"]`,
  `["commandcode"]`, `["zed"]`, `["codex"]`).
- `lib/index.js` re-exports the five provider modules (`lib/providers/*.js`)
  and its `apply(ctx, config)` fans out to each provider's own `apply()` with
  its own config slice. Each provider keeps its own settings namespace and
  adapter registration, so model picker entries behave exactly as before.
- `lib/client.js` registers a `settings.section` slot (`id: "seraphim"`,
  order 20) that renders all five account cards.

## Codex notes

- The Codex provider talks to the same backend the official `codex` CLI uses
  (`chatgpt.com/backend-api/codex/responses`), via PKCE browser OAuth against
  `auth.openai.com`. Credentials are stored per-account under
  `~/.dsh/.codex-credentials.json` (access + refresh token, account id, plan).
- The card shows the account's weekly Codex quota (`wham/usage`) and lets you
  add/remove multiple ChatGPT accounts; the adapter rotates accounts and
  refreshes access tokens automatically (10-day expiry).
- The configured model catalog is the fallback; on first authenticated use the
  provider fetches your real catalog from `/backend-api/codex/models` (10-min
  cache) so the picker shows exactly what your plan can run.

## Install into a DSH profile

```bash
dsh plugin --profile web add dsh-seraphim
```

Or manually: add `"dsh-seraphim": "link:<abs-path>"` to the profile's
`package.json` dependencies, add `"dsh-seraphim"` to `dsh.profile.bundles`,
and remove the five old plugin entries. Then rebuild web client bundles
(`pnpm run build` at the DSH checkout if needed) and restart the web GUI.

## License

MIT
