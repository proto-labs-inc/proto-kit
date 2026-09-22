# proto-kit

Proto's installable surface — everything a customer's machine runs. The
cloud codebase lives in the `proto` repo; this repo is what their coding
agent installs and drives.

## Layout

| Path | What it is |
| --- | --- |
| `template/library/` | The design-system library viewer: a raw-HTML app the import fills with extracted tokens, type styles, and components. Scaffolded to `~/.proto/<codebase>/library/`, served locally, framed by the Proto app. |
| `template/workspace-react/`, `template/workspace-vue/` | The prototype workspace scaffolds, one per framework (create-prototype picks by the source repo's framework): vite + the rig adapter (source-aliased via `PROTO_PACKAGES` until the rig packages publish), `prototype.json`, comment markers, `modern-screenshot` (the rig lazy-imports it for comment capture), and license-clean in-component SVG placeholder art. |
| `tools/` | Deterministic helpers. `serve.mjs` (static server with CORS + no-store + `?ls` listing, for anything the laptop serves), `supervise.mjs` (detached start/stop/status supervisor with crash-restart, for the dev server + tunnel pair), `courier.mjs` + `courier-http.mjs` (the website→laptop doorbell: bearer-authed enumerated commands validated onto a durable feed; the HTTP transport is one swappable file), `feed-tail.mjs` + `agent-launch.mjs` (the feed watch and resume-aware fallback launcher for the session running the listen skill; protocol in `skills/listen/`), `publish.mjs` (uploads a workspace's built output folder to a fresh published path over presigned PUT URLs; the workspace's own build script produces the folder), `cdp/` (the CDP reading/verification toolkit absorbed from replicate: attach, wireframe, capture, pixel diff), `verify-markers.mjs` (checks a workspace's `data-proto-id` coverage), `fake-import/` (plays a recorded design-system import against a library folder, for demos and UI work). |
| `skills/` | The agent protocols. `setup/` (account link + find-the-source-from-scraps → config.json/codebase.json), `import-design-system/` (source repo + live page over CDP → the library contract), `create-prototype/` (brief → workspace with states, explorations, markers), `serve/` (tunnel provisioning + supervised serving + recovery), `publish-library/` (publish the library on demand), `listen/` (the session that runs it listens for website commands from the courier feed). |
| `docs/` | `library-contract.md` — the frozen manifest/progress/components contract both the fake driver and the real import write. |
| `cli/` | (soon) The `proto` CLI. |

Plugin manifests wrap `skills/` + `tools/` for Claude Code, Codex, and
Cursor. The core stays harness-neutral: markdown protocols + plain scripts.

## Install

Sign in to Proto and copy the setup prompt from the gallery. Paste it
into your coding agent, in Claude Code, Codex, or Cursor. It installs
the Proto plugin for that agent and sets everything up: your account,
your codebase, your design system.

Manual install, if you prefer the commands yourself:

```sh
# Claude Code
claude plugin marketplace add proto-labs-inc/proto-kit
claude plugin install proto@proto-kit \
  --config app_url=https://<your proto domain> \
  --config provision_secret=<your provisioning secret>
# Codex (CLI or the desktop app; trust the hooks when asked)
codex plugin marketplace add proto-labs-inc/proto-kit
codex plugin add proto@proto-kit
```

If the plugin is already installed, update it first so it is on the
latest version. Claude Code: `claude plugin marketplace update
proto-kit && claude plugin update proto@proto-kit`. Codex: `codex
plugin marketplace upgrade proto-kit && codex plugin add
proto@proto-kit`. Cursor: update it from the Customize panel.

Then run `/proto:setup` (Claude Code) or `$setup` (Codex) in any
session. On Codex, setup writes the MCP server entry and installs the
agent roles itself. The skills and tools are one shared set; only the
packaging differs per harness (`.claude-plugin/` + `hooks/` +
`agents/` + `monitors/` for Claude; `plugin.json` + `codex-hooks/` +
`codex-agents/` for Codex; `.cursor-plugin/` for Cursor). A
session-start hook prints one health line per codebase once `~/.proto`
exists.

## The laptop layout this kit produces

```
~/.proto/
├─ config.json              account link (app origin, account, auth, rig source) — shape in skills/setup
└─ <codebase>/               one per codebase being prototyped
   ├─ codebase.json          source pointers (repo path, remote, live URL)
   ├─ library/              design-system viewer + extracted pieces
   ├─ prototypes/<slug>/    prototype workspaces (vite + rig + prototype.json)
   ├─ imports/<run>/        import working artifacts (wireframes, verify stages)
   └─ run/<slug>/           serving state per prototype (spec, pids, logs) — owned by supervise.mjs
```

## Demo: watch a design system populate

```sh
# scaffold a library and serve it
cp -r template/library /tmp/demo-library
node tools/serve.mjs /tmp/demo-library 5210

# in another terminal: play the fake import into it
node tools/fake-import/run.mjs /tmp/demo-library

# open http://localhost:5210 and watch it fill in
```
