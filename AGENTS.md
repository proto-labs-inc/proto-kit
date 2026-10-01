# proto-kit

The Proto plugin for Claude Code, Codex and Cursor. Skills live in
`skills/`, the tools they run in `tools/`, the library and workspace
templates in `template/`.

## Every change pushed to main bumps the Codex version

Codex installs the plugin into
`~/.codex/plugins/cache/proto-kit/proto/<version>/`, keyed by the
`version` in `.codex-plugin/plugin.json`. A push that leaves that
string unchanged never reaches a laptop that already has it: `codex
plugin marketplace upgrade` and `codex plugin add` keep the copy they
have, and the user runs the old kit while believing they updated.

So in the same commit as any change to the kit, set it to the current
UTC time:

```sh
v="0.1.0+codex.$(date -u +%Y%m%d%H%M%S)"
sed -i '' "s/\"version\": \"0.1.0+codex.[0-9]*\"/\"version\": \"$v\"/" .codex-plugin/plugin.json
```

Claude Code needs nothing: its manifest has no version, so each
marketplace commit is a new one.
