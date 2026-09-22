# Harness mechanics the kit relies on

## Codex facts (verified live, 2026-09-20)

- Codex reads the SAME `skills/<name>/SKILL.md` folders (the open
  agentskills spec) — all five kit skills were auto-discovered from
  the installed plugin unchanged, namespaced `proto:*` there too.
- Plugin + marketplace: root `plugin.json` (agent-plugins.org
  schema, hooks path under `extensions."com.openai"`) +
  `.agents/plugins/marketplace.json`; `codex plugin marketplace add
  <path|repo>` then `codex plugin add proto@proto-kit` — verified
  from the local path; cache at `~/.codex/plugins/cache/`.
- Hooks: same JSON shape as Claude's, `$PLUGIN_ROOT` env — but they
  run ONLY after the user passes the one-time "Hooks need review"
  trust prompt (interactive; untrusted hooks are silently skipped,
  headless included), and the `[features] hooks = true` gate must be
  on. Verified: the SessionStart health line printed in an
  interactive session after trusting.
- Agent roles are TOML in `~/.codex/agents/` (plugins don't ship
  them; setup installs `codex-agents/*.toml`) — all four proto roles
  listed by the session for `spawn_agent` after install.
- MCP: `[mcp_servers.<name>]` in `~/.codex/config.toml` with `url` +
  `http_headers_helper` (the kit's `tools/mcp-headers.mjs` reads
  `~/.proto/config.json`) — verified: a Codex session called the
  proto server's `whoami` through it. Headless `codex exec` denies MCP calls
  under its default approval policy; `--sandbox
  danger-full-access` (or interactive approval) permits them.
- NO push wake exists (nothing like the Monitor tool): an idle Codex
  session cannot be woken by process output. An interactive session
  running the listen skill polls `feed-tail` in a background terminal (`--once` for
  spot checks); unattended operation uses `tools/feed-drive.mjs`,
  which resumes the saved conversation per command
  (`codex exec resume <session-id>` — verified fresh→resume with
  offset commits against a stub).

# Claude Code mechanics

Verified facts about the harness, so skills stand on stated ground
instead of re-deriving it. One heading per mechanism; each carries how
and when it was verified. Re-verify against the installed binary when a
skill starts behaving oddly after a CLI update — these are empirical
facts about a moving target, not API contracts.

## Background Bash wakes the agent on EXIT only

A `run_in_background` Bash task re-invokes the agent when the command
exits — not on interim output. In `-p` runs, background Bash tasks are
terminated ~5s after the final result; they do not hold the session
open.

Verified: official docs (code.claude.com/docs/en/tools-reference.md,
…/headless.md) + this harness's own tool contract, 2026-09-20.

## The Monitor tool wakes the agent per OUTPUT LINE

`Monitor` streams a command's stdout: each line arrives as an
in-session notification that wakes the agent between turns — no
polling. Lines within ~200ms batch into one notification.
`persistent: true` gives session-length watches (interactive).

Verified empirically, 2026-09-20: a headless agent monitored an
emitter that logged its own emission epochs and appended a timestamp on
each notification — emissions 666/670/674 → reactions 670/674/677
(reaction N landed seconds after emission N and before the emitter
exited). Batch-at-exit would have clustered all reactions after 678.

## A headless (-p) session stays alive while a watch is armed

While a Monitor watch is active, a `claude -p` run keeps waiting and
keeps responding to what the watch reports, instead of ending at the
first final message.

Verified: the experiment above ran to completion inside one `claude -p`
invocation; docs confirm (…/headless.md), 2026-09-20.

## Watch timeouts in -p, and re-arming across them

Monitor timeout is 5 min by default, 30 min max interactive, **10 min
max in `-p` runs**. Plugin `monitors.json` monitors are
interactive-only. An always-on headless agent therefore lives by
RE-ARMING: watch ends → end notification wakes the agent → it arms a
fresh watch.

Verified empirically, 2026-09-20: three consecutive 18s watches in one
`claude -p` session; events emitted at 788/808/828 were reacted to at
811/832 — the 828 event was caught by a re-armed watch after the first
had expired (~813), and the session outlived every individual watch,
finishing its protocol. Caps: official docs (…/tools-reference.md,
…/headless.md).

## Lines emitted while no watch is armed are LOST to the watch

`tail -n0 -f` (and any monitor command) only sees output produced
after it starts. In the re-arm experiment, the event emitted ~6s in —
before the agent finished arming the first watch — was never
delivered.

Consequence: a durable command feed must be an append-only file with
the consumer replaying from a stored offset on each (re-)arm; the file
is the buffer across watch gaps, agent restarts, and reboots.

Verified empirically (the missed first event above), 2026-09-20.

## The monitored command is KILLED when its watch ends

Monitor kills its command at timeout. A process that must outlive
watches (anything holding a port) must not be the monitored command —
run it under `tools/supervise.mjs` and monitor a file it writes.

Verified: documented Monitor semantics ("Timeout → killed"),
2026-09-20; motivates the courier's listener-writes-file shape.

## Session identity in headless runs

- `claude -p --output-format json` returns one result object carrying
  `session_id` (observed live: a trivial prompt returned
  `"session_id":"2f2fe70b-…"`).
- `--output-format stream-json` events carry `session_id` too — the
  very first stream event of a run already has it.
- `-r/--resume <session-id>` continues that conversation, headless or
  interactive.

Verified empirically, 2026-09-20, capped by the cross-run memory pair:
run A (`claude -p`) was told "Remember the word pineapple"; run B
(`claude -p --resume <captured id>`) asked what the word was and
answered `"result":"pineapple"` — content that only exists if run B
truly continued run A's conversation.

## Broken-session heuristic for resumed runs

A resumed run that dies with a non-zero exit and ZERO parsed stream
events did not run — treat the session as corrupt/gone: record the
break, retry once on a fresh session, keep the queue moving. A run
that produced events and then failed is an ordinary failure, not a
session break.

Verified with a stub agent emulating both behaviors, 2026-09-20.

## What the proto plugin runs — and what it never does

A plugin's skills and hooks run **inside a session**; nothing a
plugin ships keeps running on its own. In this kit: the session-start
hook is a read-only health printout; the **supervisor** is a detached
process the serve skill starts (it, not the plugin, keeps serving
alive); the listening session, in fallback mode, is a separate
persistent `claude` session the launcher starts under that
supervisor. Uninstalling the
plugin stops none of them; a reboot stops all of them (no boot
persistence, by decision — MAA-130).

Verified: plugin docs (hooks/skills are session-scoped; monitors are
interactive-session-only) + this kit's own architecture, 2026-09-20.

## Plugin packaging facts

- Skills at `skills/<name>/SKILL.md` are auto-discovered — no
  `skills` field needed in plugin.json; minimal manifest is
  `{name, version, description}` at `.claude-plugin/plugin.json`.
- Installed skills are namespaced `/proto:<skill>`; `/plugin list`
  shows what's installed.
- The whole repo ships as the plugin (source `"./"`), tools and
  templates included; skills and hooks reach it via
  `${CLAUDE_PLUGIN_ROOT}`.
- Plugin hooks live at `hooks/hooks.json` (default location,
  auto-loaded).
- A bundled `.mcp.json` substitutes `${user_config.<key>}` in
  url/headers/env from the plugin's `userConfig` (declared in
  plugin.json; the user is prompted at enable time, `sensitive`
  fields masked) — this is how the kit ships its `proto` server
  without a domain in code. Plugin MCP tools are scoped
  `mcp__plugin_<plugin>_<server>__<tool>`. `${VAR}` shell-env
  expansion also works, with a denylist of credential vars
  (ANTHROPIC_API_KEY etc.) that read as empty in remote
  urls/headers.
- Plugin monitors, empirically (2026-09-20): `when: "always"` works
  end to end — the monitor process auto-started in a fresh
  interactive session from the installed cache, and an appended feed
  line arrived as a Monitor event the session acted on.
  `when: "on-skill-invoke:<skill>"` did NOT start the monitor
  when the skill (then named product-agent, now `listen`) was
  invoked as /proto:product-agent — verified on
  BOTH the CLI build (2.1.267) and the Desktop app's embedded engine
  (2.1.274), with the skill's invocation confirmed in-pane.
  The kit ships on-skill-invoke (correct semantics; `always` would
  deliver courier commands to every unrelated session) and the
  listen skill's manual Monitor arming is the load-bearing
  path in BOTH interactive and headless sessions until upstream
  honors the trigger.
- Plugin hooks: use STRING commands
  (`"command": "node \"${CLAUDE_PLUGIN_ROOT}/…\""`). The docs
  recommend exec-form arrays, but on 2026-09-20 an array-form
  SessionStart hook silently did not fire on CLI 2.1.267 while the
  identical string form did (A/B, one field flipped). On the Desktop
  app's embedded engine (2.1.274) BOTH forms fire — the array bug is
  fixed upstream; string works everywhere, so string ships.
- The Desktop app embeds its own Claude Code build (found under
  ~/Library/Application Support/Claude/claude-code/<version>/) and
  shares ~/.claude state — user-scope plugins, hooks, and skills all
  load in it. Verified live against 2.1.274: SessionStart health
  hook fires; the listen skill (then /proto:product-agent) invokes. Plugin monitors (`monitors/monitors.json`, `when:
  "always" | "on-skill-invoke:<skill>"`) deliver stdout lines as
  notifications but run in INTERACTIVE sessions only — headless
  flows must arm the Monitor tool themselves.
- Plugin agents (`agents/<name>.md`) are namespaced
  `<plugin>:<name>`; `claude --agent <plugin>:<name>` runs a session
  as that agent. Plugin agents may not declare hooks, mcpServers, or
  permissionMode.
- Omitting `version` from plugin.json makes the git SHA drive
  updates — every push is an update; a `version` field pins users
  until it's bumped.
- `${CLAUDE_PLUGIN_DATA}` (~/.claude/plugins/data/<id>/) persists
  across plugin updates; the cache copy does not.
- A repo is its own marketplace via
  `.claude-plugin/marketplace.json` (`plugins: [{name, source:
  "./"}]`); add with `claude plugin marketplace add <path|owner/repo>`,
  install with `claude plugin install <plugin>@<marketplace>`,
  validate with `claude plugin validate <dir>`.
- Trust is per plugin source, one unit — no per-server approval
  gates on install.

Verified: official plugin/marketplace docs + the live install of this
kit on this machine, 2026-09-20.

## CLI gotchas

- `--allowed-tools` is VARIADIC: `--allowed-tools "Bash,Monitor"
  "<prompt>"` swallows the prompt as a tool name and then errors
  "Input must be provided…". Bind with `=`
  (`--allowed-tools=Bash,Monitor`) or put the prompt first. (Hit live,
  2026-09-20.)
- `-p` with `--output-format stream-json` was run with `--verbose` in
  every verification here; several stream flags are documented as
  stream-json-only.
