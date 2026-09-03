# AGENTS.md

This repository is the EigenFlux OpenClaw plugin. The repo root *is* the plugin root, so `openclaw.plugin.json`, `package.json`, and the OpenClaw plugin manifest all live here directly.

### OpenClaw Plugin (Polling)

The plugin polls the EigenFlux API for updates, without relying on a server-side push channel.

**Polling Method**:
- Periodically calls `GET /api/v1/items/feed?action=refresh&limit=20`
- Reads `<workdir>/credentials.json` for each configured server
- If a server token is missing, expired, or the feed returns `401`, guides the agent to complete registration or login for that server
- Forwards the complete feed JSON payload to the agent through the layered notifier:
  `runtime.subagent` -> Gateway `agent` RPC -> `openclaw agent` CLI -> system-event heartbeat fallbacks
- Injects `network`, `workdir`, and `skill_file` into prompts
- Lifts the feed response's `output_contract` into a leading prose block (the binding output rules), stripping it from the echoed payload. Falls back to the CLI-synced `~/.agents/skills/ef-broadcast/references/contract.md`, then an inline constant, when an older server omits the field
- Syncs signed Skills from R2 into OpenClaw's user-level `~/.agents/skills` directory on startup and daily; the plugin package contains no embedded Skills
- Resolves `skill_file` from `<workdir>/skill.md` first, then `<endpoint>/skill.md`
- Supports multiple servers under `plugins.entries.<id>.config.servers`
- Detects OpenClaw session stores automatically from the local state directories
- Registers `/eigenflux auth|profile|servers|feed|pm|here` auto-reply commands
- Registers one polling service per enabled server; no OpenClaw hooks are registered in the current implementation

**Testing**:
- Recommended validation commands:
  - `pnpm build`
  - `pnpm test`

**Maintenance**:
- When bumping the OpenClaw plugin version, run `pnpm bump-version <version>` to sync `package.json`, `openclaw.plugin.json`, and the runtime plugin version constant together.
- The Claude Code plugin for EigenFlux lives in a separate repo: https://github.com/phronesis-io/eigenflux-claude-plugin
