# proto-kit

Proto's installable surface: everything a customer's machine runs. The
cloud product lives in the `proto` repo; this repo is what their coding
agent installs and drives.

## Layout

| Path | What it is |
| --- | --- |
| `template/library/` | The design-system library viewer: a raw-HTML app the import fills with extracted tokens, type styles, and components. Scaffolded to `~/.proto/<codebase>/library/`, served locally, framed by the Proto app. |
| `template/workspace-react/`, `template/workspace-vue/` | The prototype workspace scaffolds, one per framework (create-prototype picks by the source repo's framework): vite + the rig adapter (source-aliased via `PROTO_PACKAGES` until the rig packages publish), `prototype.json`, comment markers, `modern-screenshot` (the rig lazy-imports it for comment capture), and license-clean in-component SVG placeholder art. |
| `tools/` | Deterministic helpers. `serve.mjs` (static server with CORS + no-store + `?ls` listing, for anything the laptop serves), `supervise.mjs` (detached start/stop/status supervisor with crash-restart, for the dev server + tunnel pair), `courier.mjs` + `courier-http.mjs` (the website-to-laptop doorbell: bearer-authed enumerated commands validated onto a durable feed; the HTTP transport is one swappable file), `feed-tail.mjs`, `feed-watch-all.mjs`, `agent-launch.mjs` and `feed-drive.mjs` (the feed watches for the session running the listen skill: one run dir, every codebase's at once as the plugin monitor, and the two headless fallbacks, the resume-aware Claude Code launcher and the Codex driver; protocol in `skills/listen/`), `prototype-heartbeat.mjs` + `heartbeat.mjs` (the liveness beat for a prototype's or the library's serving run, and the beat loop it shares with the courier), `publish.mjs` (uploads a workspace's built output folder, or the library, to a fresh published path over presigned PUT URLs; the workspace's own build script produces the folder), `health.mjs` (the session-start hook: one health line per codebase), `cdp/` (the CDP reading/verification toolkit absorbed from replicate: attach, wireframe, capture, pixel diff), `verify-markers.mjs` (checks a workspace's `data-proto-id` coverage), `verify-assets.mjs` (rejects malformed or non-UTF-8 SVG assets before serving or publishing), `hooks/` (the post-edit marker check and the Cursor hook adapters), `mcp-call.mjs` (the kit's own MCP-over-HTTP client and the one reader of `~/.proto/config.json`, for the plain processes that call the app), `mcp-stdio.mjs` (the same transport as a stdio MCP server, for hosts whose plugin config wants a local process: the Cursor plugin ships it), `mcp-headers.mjs` (prints the auth header for Codex's MCP config, so the credential stays in config.json), `fake-import/` (plays a recorded design-system import against a library folder, for demos and UI work). |
| `skills/` | The agent protocols. `setup/` (account link + find-the-source-from-scraps, writing config.json and codebase.json), `import-design-system/` (source repo + live page over CDP, writing the library contract), `create-prototype/` (brief to workspace with states, variant sets, static SVG previews, and markers), `serve/` (tunnel provisioning + supervised serving + recovery), `publish-library/` (publish the library on demand), `listen/` (the session that runs it listens for website commands from the courier feed). |
| `agents/`, `codex-agents/`, `cursor-agents/` | The subagent roles (importer, builder, verifier, and the headless listen session), one folder per harness format. |
| `hooks/`, `monitors/`, `codex-hooks/`, `cursor-hooks/` | Per-harness packaging: the session-start health line and the post-edit marker check as each harness declares hooks, plus the Claude Code `courier-feed` monitor. |
| `docs/` | `library-contract.md` (the frozen manifest/progress/components contract both the fake driver and the real import write), `harness-mechanics.md` (verified facts about Claude Code, Codex and Cursor that the skills stand on), `cdp-traps.md` (what bites when reading live pages over CDP). |
| `assets/` | The logo the plugin manifests reference. |

Plugin manifests wrap `skills/` + `tools/` for Claude Code, Codex, and
Cursor. The core stays harness-neutral: markdown protocols + plain scripts.

## Install

Sign in to Proto and copy the setup prompt from the gallery's setup
steps or its New prototype dialog. Paste it into your coding agent, in
Claude Code, Codex, or Cursor: one paste. The prompt is two lines, your
account and a one-time link. Your agent fetches the link and gets the
setup document: the plugin command for its harness, the app's address,
the credential, your codebase folder, your product page. It installs
the Proto plugin and runs its setup skill: your account, your codebase,
your design system. The link works once and expires after 15 minutes;
copy the prompt again for a fresh one.

Manual install, if you prefer the commands yourself. These are the
words the setup document carries, copied verbatim from the site's
`web/src/lib/setup-snippet.ts` (`installCommands`), which is the source:
change them there first. `<app>` and `<provisionSecret>` are the
document's `app` and `provisionSecret`.

```sh
# Claude Code
claude plugin marketplace add proto-labs-inc/proto-kit && claude plugin install proto@proto-kit --config app_url="<app>" --config provision_secret="<provisionSecret>"
# Codex (CLI or the desktop app; trust the hooks when asked)
codex plugin marketplace add proto-labs-inc/proto-kit && codex plugin add proto@proto-kit
# Cursor (local plugin folder; see the Cursor section below)
git clone https://github.com/proto-labs-inc/proto-kit ~/.cursor/plugins/local/proto, then run "Developer: Reload Window" in Cursor.
```

If the plugin is already installed, update it first so it is on the
latest version:

```sh
# Claude Code
claude plugin marketplace update proto-kit && claude plugin update proto@proto-kit
# Codex
codex plugin marketplace upgrade proto-kit && codex plugin add proto@proto-kit
# Cursor
git -C ~/.cursor/plugins/local/proto pull, then run "Developer: Reload Window" in Cursor (or Refresh in the Customize panel for a marketplace install).
```

Then run `/proto:setup` (Claude Code) or `$setup` (Codex) in any
session; in Cursor, type `/` in the chat and pick the Proto setup
skill, or paste the setup prompt. On Codex, setup writes the MCP
server entry and installs the agent roles itself. The skills and
tools are one shared set; only the packaging differs per harness
(`.claude-plugin/` + `hooks/` + `agents/` + `monitors/` for Claude;
`plugin.json` + `codex-hooks/` + `codex-agents/` for Codex;
`.cursor-plugin/` + `cursor-hooks/` + `cursor-agents/` for Cursor). A
session-start hook prints one health line per codebase once `~/.proto`
exists.

### Cursor

Cursor installs plugins from a marketplace or from a local folder.
This repository is its own marketplace (`.cursor-plugin/marketplace.json`),
so either path works.

**From the Customize panel.** Open **Customize** in Cursor's sidebar,
choose **From GitHub Repository**, paste
`https://github.com/proto-labs-inc/proto-kit`, and install **Proto**
(user scope is the usual choice). The plugin declares two values,
**Proto app URL** and **Provisioning secret**. Leave them empty:
setup writes both to `~/.proto/config.json` from the setup document,
and the plugin's Proto MCP server reads them from there.

**From a local folder.** Clone the kit into Cursor's local plugin
folder (the `git clone` line above), then run **Developer: Reload
Window** from the command palette. Proto appears in Customize under
Plugins. Nothing to configure: the MCP server reads
`~/.proto/config.json` once setup has written it. On Enterprise plans
an admin has to allow local plugin imports first.

**Updating.** For a Customize install, open the Proto plugin in
Customize and refresh it (a marketplace with auto refresh updates
itself). For the local folder, `git -C ~/.cursor/plugins/local/proto
pull --ff-only`. Then **Developer: Reload Window**.

**What Cursor gets.** The same skills, a session-start hook with the
health line and a post-edit hook with the marker check
(`cursor-hooks/hooks.json`), the `proto-importer`, `proto-builder`
and `proto-verifier` subagents (`cursor-agents/`), and the `proto`
MCP server as a stdio bridge (`tools/mcp-stdio.mjs`) to the app's
MCP endpoint. On a laptop with no `~/.proto/config.json` yet the
bridge starts with no tools and announces them once setup has written
the file; if they still do not show, toggle the Proto MCP server off
and on in Customize.

## The laptop layout this kit produces

```
~/.proto/
├─ config.json              account link (app origin, account, auth, rig source), shape in skills/setup
└─ <codebase>/               one per codebase being prototyped
   ├─ codebase.json          source pointers (repo path, remote, live URL)
   ├─ library/              design-system viewer + extracted pieces
   ├─ prototypes/<slug>/    prototype workspaces (vite + rig + prototype.json)
   ├─ imports/<run>/        import working artifacts (wireframes, verify stages)
   └─ run/<slug>/           serving state per prototype (spec, pids, logs), owned by supervise.mjs
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
