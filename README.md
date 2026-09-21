# proto-kit

Proto's installable surface — everything a customer's machine runs. The
cloud product lives in the `proto` repo; this repo is what their coding
agent installs and drives.

## Layout

| Path | What it is |
| --- | --- |
| `template/library/` | The design-system library viewer: a raw-HTML app the import fills with extracted tokens, type styles, and components. Scaffolded to `~/.proto/<product>/library/`, served locally, framed by the Proto app. |
| `template/workspace-react/`, `template/workspace-vue/` | The prototype workspace scaffolds, one per framework (create-prototype picks by the source repo's framework): vite + the rig adapter (source-aliased via `PROTO_PACKAGES` until the rig packages publish), `prototype.json`, comment markers, `modern-screenshot` (the rig lazy-imports it for comment capture), and license-clean in-component SVG placeholder art. |
| `tools/` | Deterministic helpers. `serve.mjs` (static server with CORS + no-store + `?ls` listing, for anything the laptop serves), `supervise.mjs` (detached start/stop/status supervisor with crash-restart, for the dev server + tunnel pair), `courier.mjs` + `courier-http.mjs` (the website→laptop doorbell: bearer-authed enumerated commands validated onto a durable feed; the HTTP transport is one swappable file), `feed-tail.mjs` + `agent-launch.mjs` (the always-on product agent's feed watch and resume-aware launcher; protocol in `skills/product-agent/`), `cdp/` (the CDP reading/verification toolkit absorbed from replicate: attach, wireframe, capture, pixel diff), `verify-markers.mjs` (checks a workspace's `data-proto-id` coverage), `fake-import/` (plays a recorded design-system import against a library folder, for demos and UI work). |
| `skills/` | The agent protocols. `setup/` (account link + find-the-source-from-scraps → config.json/product.json), `import-design-system/` (source repo + live page over CDP → the library contract), `create-prototype/` (brief → workspace with states, explorations, markers), `serve/` (tunnel provisioning + supervised serving + recovery). |
| `docs/` | `library-contract.md` — the frozen manifest/progress/components contract both the fake driver and the real import write. |
| `cli/` | (soon) The `proto` CLI. |

A plugin manifest will wrap `skills/` + `tools/` for Claude Code's
marketplace; the same content transforms into Cursor rules. The core stays
harness-neutral: markdown protocols + plain scripts.

## Install (Claude Code or Codex — the repo is its own marketplace for both)

```sh
# Claude Code
claude plugin marketplace add proto-labs-inc/proto-kit
claude plugin install proto@proto-kit
# Codex (CLI or the desktop app; trust the hooks when asked)
codex plugin marketplace add proto-labs-inc/proto-kit
codex plugin add proto@proto-kit
```

Then, in any session — terminal, the Claude Code desktop app, or the
Codex app: `/proto:setup` (Claude) or `$setup` (Codex) links your
account, finds your product's code, and flows into the design-system
import. A session-start hook prints one health line per product
(serving/courier) once `~/.proto` exists. The skills and tools are
one shared set; only the packaging differs per harness
(`.claude-plugin/` + `hooks/` + `agents/` + `monitors/` for Claude;
`plugin.json` + `codex-hooks/` + `codex-agents/` for Codex, where
setup also writes the MCP entry and installs the agent roles).

## The laptop layout this kit produces

```
~/.proto/
├─ config.json              account link (app origin, account, auth, rig source) — shape in skills/setup
└─ <product>/               one per product being prototyped
   ├─ product.json          source pointers (repo path, remote, live URL)
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
