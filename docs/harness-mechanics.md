# Harness mechanics the kit relies on

## One workflow on every harness

Claude Code, Codex, and Cursor run requested work in the active conversation.
A website work prompt identifies a persisted brief and its action; the agent
reads it through authenticated MCP and reports progress outward. See
`work-handoff.md`. No skill installs a listener, opens a command socket, watches
a feed, binds a chat for delivery, or launches a headless session.

Questions return promptly with a durable checkpoint and are answered in chat.
A local component request is checked during active import work only. Serving
supervisors stay alive independently to run dev servers, tunnels, and
heartbeats; this is serving, not unattended agent work.

## Packaging

All harnesses share `skills/<name>/SKILL.md`, `tools/`, and `template/`.
Resolve tool paths from the installed plugin root, not a guessed newest cache.

### Codex

- The manifest is `.codex-plugin/plugin.json`; the marketplace is
  `.agents/plugins/marketplace.json`. The manifest version must change for
  source changes to reach an existing versioned installation.
- Inspect `codex plugin marketplace list --json` and preserve the chosen
  source. A local marketplace is re-added without pulling or replacing it.
- Resolve the installed root from `codex plugin add proto@proto-kit`.
  Run `tools/codex-install.mjs` there to synchronize the MCP bridge and supported
  roles; `--check` is read-only. Removed kit-owned listener roles are archived,
  never left in the discovered roles directory.
- MCP uses `node <installed-kit>/tools/mcp-stdio.mjs`. The bridge selects the
  laptop credential for each call; a fixed Authorization header would pin a
  multi-team laptop to one credential.
- Session-start and post-edit hooks retain health and marker checks. Respect
  the host's hook trust/approval requirements; skipped hooks are not evidence
  of a broken service.
- Debug reporting retains read-only transcript lookup and explicit consent,
  without conversation binding or message delivery.

### Claude Code

- `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` package
  the complete repository. Skills and tools resolve through
  `${CLAUDE_PLUGIN_ROOT}`.
- `hooks/hooks.json` supplies health and marker checks with string commands.
  `agents/` contains scoped build/import/verification roles only.
- `.mcp.json` runs the shared stdio bridge. Credential linking occurs after
  plugin installation and chooses the credential per call.
- The manifest omits a version, so the marketplace commit drives updates.
  No monitors or persistent listener agents are bundled.

### Cursor

- `.cursor-plugin/`, `cursor-hooks/`, and `cursor-agents/` package the same
  workflow. Skills/agents live in the installed plugin folder.
- For a local plugin folder, update its source without discarding local work.
  A marketplace install refreshes through the Customize panel.
- Reload the window after an update so the new plugin is discovered.
- The bundled stdio MCP bridge reads the linked account configuration. Serving
  and publishing do not depend on chat liveness or an inbound command channel.

## Retirement

Older versions may have installed command-delivery processes and roles.
`tools/retire-legacy-runs.mjs` inventories them without mutation by default.
Only an explicitly authorized `--apply` retires verified process identities
and archives their run data. Unknown ownership is a blocker, not permission to
kill a process. Unrelated interactive conversations, library/prototype serving
runs, and credentials remain untouched.

There is no feature flag that restores remote delivery. Historical mechanics
are available in Git history, not as instructions to revive a retired path.
