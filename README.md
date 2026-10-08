# proto-kit

Proto's installable surface: everything a customer's machine runs. The
cloud product lives in the `proto` repo; this repo is what their coding
agent installs and drives.

Work starts and resumes in the active coding-agent conversation on Claude Code,
Codex, and Cursor. Website actions provide copyable prompts; progress and
published results flow outward. There is no remote command-delivery service,
listener skill, or experimental opt-in. See `docs/work-handoff.md`.

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
docs/            frozen contracts, hard-won facts
assets/          the logo plugin manifests reference
```

Plugin manifests wrap `skills/` + `tools/` for Claude Code, Codex and
Cursor; the core stays harness-neutral.

### skills/

- `setup/`: link the laptop and the source repo, write codebase.json.
- `import-design-system/`: read the source repo and live page, fill the library.
- `create-prototype/`: brief to workspace: one direction, preview states, markers.
- `create-variant-set/`: add a new variant set to an existing prototype.
- `add-variants/`: add variants to a set that already exists.
- `edit-variant/`: change one existing variant.
- `serve/`: provision the tunnel, supervise serving, recover it.
- `create-pr-plan/`: decompose prototype work into ordered pull-request slices.
- `implement-pr-plan/`: build plan entries, link PRs and previews back.
- `publish-library/`: publish the library on demand.
- `update/`: update the plugin, then repair what the update leaves stale.
- `debug/`: send Proto a debug report now, with a headline; the agent uses it on its own too.
- `analyze-trace/`: read a session's debug trace, flag what went wrong or could be better, and say what to change in the kit.

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
- `build-stream.mjs`: outbound build events and resumable questions answered in the active conversation.
- `copy-gate.mjs`: one automatic copy retry, then a saved chat decision checkpoint; required choices never time out.
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
- `debug-report.mjs`: session snapshots to Proto: `send` now, `watch` every ten minutes in the background.
- `codebase-icon.mjs`: upload the product's favicon and set it as the codebase's icon.
- `repair-runs.mjs`: bring every run spec up to this version of the kit.
- `migrate-rig.mjs`: move prototypes scaffolded before the rig was on npm onto `@proto-labs-inc/*`.

Questions and retirement:

- `chat-questions.mjs`: durable questions and idempotent answers in the build directory.
- `retire-legacy-runs.mjs`: dry-run inventory and explicit safe archival of obsolete command-delivery runs; never a startup path.
- `codex-install.mjs`: synchronize MCP and supported roles, retaining recoverable role archives.

Talking to the app, and the harness hooks:

- `mcp-call.mjs`: MCP-over-HTTP client, the one reader of `~/.proto/config.json`.
- `mcp-stdio.mjs`: that same transport as a stdio MCP server, choosing the credential per call.
- `link-laptop.mjs`: redeem the setup document's code and save this laptop's token.
- `hooks/post-edit-markers.mjs`: re-run the marker check on an edited workspace file.
- `hooks/cursor-session-start.mjs`, `hooks/cursor-post-tool-use.mjs`: those two checks, Cursor's shape.
- `trace.mjs`, `trace-read.mjs`, `trace-transcript.mjs`: debug traces of every Proto session in `~/.proto/traces/`: the transcript as a page and as markdown, the time, and flags an agent or a person puts on steps; `hooks/trace-hook.mjs` keeps them current after each turn, for all three harnesses.

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

### hooks/, codex-hooks/, cursor-hooks/

- `hooks/hooks.json`, `codex-hooks/hooks.json`, `cursor-hooks/hooks.json`: the health line, marker check, debug reporting and trace sync, per harness.

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
claude plugin marketplace add proto-labs-inc/proto-kit#release && claude plugin install proto@proto-kit
# Codex (CLI or the desktop app; trust the hooks when asked)
codex plugin marketplace add proto-labs-inc/proto-kit --ref release && codex plugin add proto@proto-kit
# Cursor (local plugin folder; see the Cursor section below)
git clone --branch release https://github.com/proto-labs-inc/proto-kit ~/.cursor/plugins/local/proto, then run "Developer: Reload Window" in Cursor.
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
git -C ~/.cursor/plugins/local/proto pull --ff-only origin release, then run "Developer: Reload Window" in Cursor (or Refresh in the Customize panel for a marketplace install).
```

These update commands assume the marketplace already tracks `release`.
For an existing main or local registration, follow the migration in
`skills/update/SKILL.md` first. Normal updates always use GitHub release;
local installs require an explicit request for that operation. Local source
folders and their edits are preserved when switching registrations.
Resolve the installed root and run `node <installed-kit>/tools/codex-install.mjs`
on Codex; `--check` verifies MCP and role synchronization.

Then run `/proto:setup` (Claude Code) or `$setup` (Codex) in any
session; in Cursor, type `/` in the chat and pick the Proto setup
skill, or paste the setup prompt. On Codex, setup writes the MCP
server entry and supported roles using `tools/codex-install.mjs`. The skills and
tools are one shared set; only the packaging differs per harness
(`.claude-plugin/` + `hooks/` + `agents/` for Claude;
`.codex-plugin/plugin.json` + `codex-hooks/` + `codex-agents/` for Codex;
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
├─ traces/<session>/        one per agent session that used Proto: its transcripts, transcript.html and transcript.md, report.md, flags.json (tools/trace.mjs)
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

## Debug report destination

Debug reports (automatic and manual) go to `https://prototypes.fun`, even
when the linked product app or `PROTO_APP` points to a local development
server. They use the existing laptop login; R2 storage credentials belong
only on the hosted server. Reports remain available to authorized staff.
Begin and finish use the same team credential throughout an upload. A login
refused by the hosted service fails visibly in the telemetry log; it does
not fall back to the development server. For isolated reporter tests only,
`PROTO_REPORT_APP` explicitly selects a different reporting origin.

## License

MIT. See [LICENSE](LICENSE).

## Automated kit releases

Copied prompts check the installed kit locally before downloading an update.
The local check compares against the prompt’s release version; copy a fresh
prompt when testing a newly published release. The update skill resumes the
original request after the version check or installation succeeds.

Push or merge source changes to `main`. The Publish Proto release workflow
runs checks, generates a fresh version, and advances `release` with a normal
fast-forward push. No agent or developer has to bump a manifest. Main is the
source branch; installations track release. Do not commit directly to release.

CI stamps the Codex, portable, and Cursor manifests together and records the
source commit and GitHub run ID in `.proto-release.json`. Versions retain the
existing 14-digit UTC format for compatibility with the cloud API, and always
advance past the previous release even when runs occur in the same second.
Rerunning a published source reuses its release commit, allowing registration
retries without a new version. Stale runs cannot roll back the release branch.

Failures before the release push leave the previous package available. Cloud
registration happens afterward in the same workflow; if it fails, the package
is available but cloud update notices lag. Rerun that workflow to retry.

Activation: merge this workflow into main, allow its `contents: write` token
to create/update release, and verify the first run. Existing
`PROTO_APP_URL` and `PROTO_KIT_RELEASE_TOKEN` configure cloud registration.
Protect release from human pushes while allowing this workflow to advance it.
Update the cloud setup-command producer alongside this change and migrate
existing marketplace registrations to release. Never fall back to main.
