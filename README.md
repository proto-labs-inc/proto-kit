# proto-kit

Proto's installable surface: everything a customer's machine runs. The
cloud product lives in the `proto` repo; this repo is what their coding
agent installs and drives.

## Layout

```
skills/          the agent protocols, one per skill
tools/           the deterministic scripts skills run
template/        the app scaffolds copied to a laptop
agents/          subagent roles, Claude Code format
codex-agents/    the same roles, Codex format
cursor-agents/   the same roles, Cursor format
hooks/           Claude Code hook declarations
codex-hooks/     Codex hook declarations
cursor-hooks/    Cursor hook declarations
monitors/        the Claude Code courier-feed monitor
docs/            frozen contracts, hard-won facts
assets/          the logo plugin manifests reference
```

Plugin manifests wrap `skills/` + `tools/` for Claude Code, Codex and
Cursor; the core stays harness-neutral.

### skills/

- `setup/`: link the laptop and the source repo, write codebase.json.
- `import-design-system/`: read the source repo and live page, fill the library.
- `create-prototype/`: brief to workspace: states, variant sets, previews, markers.
- `create-variant-set/`: add a new variant set to an existing prototype.
- `add-variants/`: add variants to a set that already exists.
- `edit-variant/`: change one existing variant.
- `serve/`: provision the tunnel, supervise serving, recover it.
- `create-pr-plan/`: decompose prototype work into ordered pull-request slices.
- `implement-pr-plan/`: build plan entries, link PRs and previews back.
- `publish-library/`: publish the library on demand.
- `listen/`: take the website's commands off the feed.
- `update/`: update the plugin, then repair what the update leaves stale.

### tools/

The library and the import:

- `library.mjs`: the one writer of the library contract, atomic and locked.
- `host-library.mjs`: scaffold, install, tunnel and supervised run, one call.
- `verify-replica.mjs`: capture the live element, render the replica, diff them.
- `pictures.mjs`: logos, icons, charts and background images taken from the page as files, never redrawn.
- `verify-markers.mjs`: check a workspace's `data-proto-id` coverage.
- `fake-import/run.mjs`: play a recorded import into a library app.

A prototype build (`docs/build-read.md`):

- `proto-build.mjs`: the whole copy of the reference page in one command, then the parts list.
- `build-stream.mjs`: the build's events to the site (read, curate, name, phase, focus), and its questions: ask, await the answer, or pass on one given in the terminal.
- `copy-gate.mjs`: a copy over its gate, retried once, then the copy-gate question on the site.
- `scaffold.mjs`, `replicate.mjs`: the workspace from the read; every leaf copied, checked and composed.
- `variant-set.mjs`: a variant set's skeleton, one stub per variant for the units.
- `check-states.mjs`: every state and variant loaded headless; errors, rect sanity, the untouched parts against the read.
- `previews.mjs`: the variant previews from real renders, into the manifest.
- `check-part.mjs`: one copied part checked against the page, its passes streamed.

Serving and publishing:

- `serve.mjs`: static server, CORS and no-store, port 0.
- `supervise.mjs`: detached supervisor keeping dev server and tunnel alive.
- `publish.mjs`: upload a built folder over presigned PUTs.
- `publish-library.mjs`: build and publish the library in one serialised call.
- `prototype-heartbeat.mjs`: beat while a prototype's or library's run is up.
- `heartbeat.mjs`: the beat loop those share.
- `health.mjs`: the session-start check, one line per codebase.
- `codebase-icon.mjs`: upload the product's favicon and set it as the codebase's icon.
- `repair-runs.mjs`: bring every run spec up to this version of the kit.
- `migrate-rig.mjs`: move prototypes scaffolded before the rig was on npm onto `@proto-labs-inc/*`.

The courier and the feed:

- `courier.mjs`: validate the website's commands onto a durable feed.
- `questions.mjs`: a build's answers taken from the feed; a stray one routed and dropped.
- `courier-relay.mjs`: the courier's transport, one WebSocket to the site's relay.
- `courier-http.mjs`: the courier's local-only port, for this laptop's own checks.
- `feed-tail.mjs`: follow one codebase's feed from the committed offset.
- `feed-watch-all.mjs`: follow every codebase's feed at once, for monitors.
- `agent-launch.mjs`: resume-aware headless launcher for a listen session.
- `codex-thread.mjs`: which live Codex thread is this session (by a token it printed).
- `feed-queue.mjs`: the Codex wake, queueing each command into the session the user has open.
- `feed-drive.mjs`: the Codex last resort, resuming its saved conversation headlessly.

Talking to the app, and the harness hooks:

- `mcp-call.mjs`: MCP-over-HTTP client, the one reader of `~/.proto/config.json`.
- `mcp-stdio.mjs`: that same transport as a stdio MCP server, choosing the credential per call.
- `link-laptop.mjs`: redeem the setup document's code and save this laptop's token.
- `hooks/post-edit-markers.mjs`: re-run the marker check on an edited workspace file.
- `hooks/cursor-session-start.mjs`, `hooks/cursor-post-tool-use.mjs`: those two checks, Cursor's shape.

`cdp/`, the browser toolkit:

- `chrome.mjs`: start or find the visible Proto window, unfocused.
- `headless.mjs`: the headless Chrome that replicas and diffs render in.
- `attach.mjs`: reuse a product tab; otherwise navigate a blank tab, or open one when none exists.
- `product-page.mjs`: prepare that tab for setup and print the page URL the import will read.
- `cdp.mjs`: minimal CDP client over Node's WebSocket, no dependencies.
- `capture.mjs`: clip screenshots behind a stability gate.
- `crop.mjs`: crop an element from the live page at 2x.
- `diff.mjs`: pixel diff two captures in node.
- `png.mjs`: decode and encode just enough PNG.
- `wireframe.mjs`: one labeled, depth-colored box per element of a tab.

### template/

- `library/`: the design-system library app the import fills.
- `workspace-react/`, `workspace-vue/`: the prototype scaffolds, vite plus the rig adapter.

### agents/, codex-agents/, cursor-agents/

The subagent roles, one file per harness format.

- `importer.md`, `proto-importer.toml`, `proto-importer.md`: extract one design-system unit.
- `builder.md`, `proto-builder.toml`, `proto-builder.md`: build inside one prototype workspace.
- `verifier.md`, `proto-verifier.toml`, `proto-verifier.md`: read-only checks of markers, pixels, state URLs.
- `part-fixer.md`, `proto-part-fixer.toml`, `proto-part-fixer.md`: fix one copied part of a prototype build.
- `variant-builder.md`, `proto-variant-builder.toml`, `proto-variant-builder.md`: write one variant of a set.
- `listen.md`, `proto-listen.toml`: the headless listen session, Claude Code and Codex.

### hooks/, codex-hooks/, cursor-hooks/, monitors/

- `hooks/hooks.json`, `codex-hooks/hooks.json`, `cursor-hooks/hooks.json`: the health line and marker check, per harness.
- `monitors/monitors.json`: the `courier-feed` monitor, armed when the listen skill starts.

### docs/

- `library-contract.md`: the frozen contract import and library app share.
- `harness-mechanics.md`: verified facts about Claude Code, Codex and Cursor.
- `cdp-traps.md`: what bites when reading live pages over CDP.
- `reviews/`: dated notes from reviewing a run.

### assets/

- `proto-logo.svg`, `proto-logo.png`: the logo the plugin manifests reference.

## Install

Sign in to Proto and copy the setup prompt from the gallery's setup
steps or its New prototype dialog. Paste it into your coding agent, in
Claude Code, Codex, or Cursor: one paste. The prompt contains your identity,
the complete setup document and a one-time linking code. Your agent installs
the plugin, whose setup helper exchanges the code for a per-laptop token
without exposing that durable token in chat. The document carries the app's
address, your codebase folder and your product page. The agent runs
the Proto plugin and runs its setup skill: your account, your codebase,
your design system. The code works once and expires after 10 minutes;
copy the prompt again for a fresh one.

Manual install, if you prefer the commands yourself. These are the
words the setup document carries, copied verbatim from the site's
`web/src/lib/setup-snippet.ts` (`installCommands`), which is the source:
change them there first. The plugin takes no credential at install time;
the setup code mints the laptop token afterward.

```sh
# Claude Code
claude plugin marketplace add proto-labs-inc/proto-kit && claude plugin install proto@proto-kit
# Codex (CLI or the desktop app; trust the hooks when asked)
codex plugin marketplace add proto-labs-inc/proto-kit && codex plugin add proto@proto-kit
# Cursor (local plugin folder; see the Cursor section below)
git clone https://github.com/proto-labs-inc/proto-kit ~/.cursor/plugins/local/proto, then run "Developer: Reload Window" in Cursor.
```

If the plugin is already installed, update it first so it is on the
latest version. `/proto:update` (Claude Code), `$update` (Codex) or
the Proto update skill (Cursor) runs the right one of these for the
agent it is in and then repairs the runs the old version left behind;
the commands themselves are:

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
(user scope is the usual choice). There is nothing to configure: setup
writes the app address and laptop token to `~/.proto/config.json`, and
the plugin's Proto MCP server reads them from there.

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
├─ config.json              laptop links (app origin, one credential per team, rig source), shape in skills/setup
└─ <codebase>/               one per codebase being prototyped
   ├─ codebase.json          the team that owns it and source pointers (repo path, remote, live URL)
   ├─ library/              the design-system library app; the import fills its public/
   ├─ prototypes/<slug>/    prototype workspaces (vite + rig + prototype.json)
   ├─ imports/<run>/        import working artifacts (wireframes, verify stages)
   └─ run/<slug>/           serving state per prototype (spec, pids, logs), owned by supervise.mjs
```

## Demo: watch a design system populate

```sh
# scaffold a library and serve it
cp -r template/library /tmp/demo-library
cd /tmp/demo-library && pnpm install --frozen-lockfile && pnpm dev

# in another terminal: play the fake import into it
node tools/fake-import/run.mjs /tmp/demo-library

# open the URL Vite prints and watch it fill in; press "Queue it" on
# the skipped card and the driver extracts it
```

## License

MIT. See [LICENSE](LICENSE).
