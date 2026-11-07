# proto-kit

Proto's installable surface for copied prototypes. The cloud product and
the Proto desktop app live in the `proto` repo; this repo is what a
maker's coding agent installs to link the laptop and keep editing,
serving and publishing prototypes that were copied into standalone
workspaces under `~/.proto`.

New prototypes are not copied any more. They are forks: the desktop app
runs the maker's own dev server and the agent writes alternates as
islands in the maker's app (`packages/islands` in the `proto` repo),
following the islands brief Proto sends with each message. That flow
uses nothing in this kit.

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

- `setup/`: install or update the plugin, connect the MCP server, and repair
  this laptop's local Proto records.
- `create-variant-set/`: add a new variant set to an existing prototype.
- `add-variants/`: add variants to a set that already exists.
- `edit-variant/`: change one existing variant.
- `serve/`: supervise the local dev server, publish, recover it.
- `create-pr-plan/`: decompose prototype work into ordered pull-request slices.
- `implement-pr-plan/`: build plan entries, link PRs and previews back.
- `publish-library/`: publish a previously imported library on demand.
- `update/`: update the plugin, then repair what the update leaves stale.
- `analyze-trace/`: read a session's debug trace, flag what went wrong or could be better, and say what to change in the kit.

### tools/

The library (existing imports only):

- `host-library.mjs`: scaffold, install and supervised local run, one call.

Editing a copied prototype:

- `variant-manifest.mjs`: the guarded writer of `public/prototype.json` variant sets.
- `variant-set.mjs`: a variant set's skeleton, one stub per variant for the units.
- `check-states.mjs`: every state and variant loaded headless; errors and rect sanity.
- `previews.mjs`: the variant previews from real renders, into the manifest.
- `look.mjs`, `click.mjs`: render a state or variant, click a control and report what changed.
- `verify-markers.mjs`: check a workspace's `data-proto-id` coverage.
- `build-stream.mjs`: resumable questions on a brief, answered in the active conversation.
- `sketch.mjs`, `reference-research.mjs`: references for a variant set (`docs/sketch.md`, `docs/variant-references.md`).

Serving and publishing:

- `serve.mjs`: static server, CORS and no-store, port 0.
- `supervise.mjs`: detached supervisor keeping the dev server alive.
- `publish.mjs`: upload a built folder over presigned PUTs.
- `publish-library.mjs`: build and publish the library in one serialised call.
- `auto-publish.mjs`: at the end of each agent turn, build and publish every served prototype and library that changed.
- `health.mjs`: the session-start check, one line per codebase.
- `codebase-icon.mjs`: upload the product's favicon and set it as the codebase's icon.
- `update-rig.mjs`: move a copied workspace onto the rig version the app advertises.
- `repair-runs.mjs`: bring every run spec up to this version of the kit.
- `migrate-rig.mjs`: move prototypes scaffolded before the rig was on npm onto `@proto-labs-inc/*`.

Questions and retirement:

- `chat-questions.mjs`: durable questions and idempotent answers in the build directory.
- `retire-legacy-runs.mjs`: dry-run inventory and explicit safe archival of obsolete command-delivery runs; never a startup path.
- `codex-install.mjs`: synchronize MCP and supported roles, retaining recoverable role archives.

Talking to the app, and the harness hooks:

- `mcp-call.mjs`: MCP-over-HTTP client, the one reader of `~/.proto/config.json`.
- `mcp-stdio.mjs`: that same transport as a stdio MCP server, choosing the credential per call.
- `hooks/post-edit-markers.mjs`: re-run the marker check on an edited workspace file.
- `hooks/cursor-session-start.mjs`, `hooks/cursor-post-tool-use.mjs`: those two checks, Cursor's shape.
- `trace.mjs`, `trace-read.mjs`, `trace-transcript.mjs`: debug traces of every Proto session in `~/.proto/traces/`: the transcript as a page and as markdown, the time, and flags an agent or a person puts on steps; `hooks/trace-hook.mjs` keeps them current after each turn, for all three harnesses.

`cdp/`, the browser toolkit:

- `chrome.mjs`: start or find the visible Proto window, unfocused.
- `headless.mjs`: the headless Chrome that replicas and diffs render in.
- `attach.mjs`: reuse a product tab; otherwise navigate a blank tab, or open one when none exists.
- `product-page.mjs`: acquire an owned window on a product page.
- `cdp.mjs`: minimal CDP client over Node's WebSocket, no dependencies.
- `capture.mjs`: clip screenshots behind a stability gate.
- `crop.mjs`: crop an element from the live page at 2x.
- `diff.mjs`: pixel diff two captures in node.
- `png.mjs`: decode and encode just enough PNG.
- `wireframe.mjs`: one labeled, depth-colored box per element of a tab.

### template/

- `library/`: the design-system library app existing imports render in.
- `workspace-react/`, `workspace-vue/`: the scaffolds copied prototypes were made from, vite plus the rig adapter; the rig migrations are tested against them.

### agents/, codex-agents/, cursor-agents/

The subagent roles, one file per harness format.

- `verifier.md`, `proto-verifier.toml`, `proto-verifier.md`: read-only checks of markers, pixels, state URLs.
- `variant-builder.md`, `proto-variant-builder.toml`, `proto-variant-builder.md`: write one variant of a set.

### hooks/, codex-hooks/, cursor-hooks/

- `hooks/hooks.json`, `codex-hooks/hooks.json`, `cursor-hooks/hooks.json`: the health line, marker check, trace sync and auto-publish, per harness.

### docs/

- `library-contract.md`: the frozen format of an imported library, which the library app renders.
- `harness-mechanics.md`: verified facts about Claude Code, Codex and Cursor.
- `work-handoff.md`: website brief prompts, including rebuilding one section of a copied prototype.
- `variant-*.md`, `sketch.md`: how variant work and its references are done.
- `background-browser.md`: the headless source-browser policy.
- `reviews/`: dated notes from reviewing a run.

### assets/

- `proto-logo.svg`, `proto-logo.png`: the logo the plugin manifests reference.

## Install

Install the Proto app for Mac and sign in. The app installs and updates this
plugin for Claude Code, links the laptop (its credential goes to
`~/.proto/config.json`), and connects codebases when you choose their folder.

Manual install, if you prefer the commands yourself. The plugin takes no
credential at install time; signing in to the Proto app links the laptop.

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
(`cursor-hooks/hooks.json`), the `proto-variant-builder` and
`proto-verifier` subagents (`cursor-agents/`), and the `proto`
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
   ├─ library/              an earlier import's design-system library app
   ├─ prototypes/<slug>/    copied prototype workspaces (vite + rig + prototype.json)
   └─ run/<slug>/           serving state per prototype (spec, pids, logs), owned by supervise.mjs
```

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
Documentation-only commits pushed to `main` also publish a new kit version.

CI stamps the Codex, portable, and Cursor manifests together and records the
source commit and GitHub run ID in `.proto-release.json`. Versions retain the
existing 14-digit UTC format for compatibility with the cloud API, and always
advance past the previous release even when runs occur in the same second.
Rerunning a published source reuses its release commit, allowing registration
retries without a new version. Stale runs cannot roll back the release branch.

Every other source branch publishes the same way to `preview/<branch>`: each
push gets a fresh version, and `.proto-release.json` records the branch. Those
builds are not registered with the cloud. A Vercel preview of the proto branch
with the same name reads `preview/<branch>/.proto-release.json` from GitHub and
names that build and branch in its prompts; the update skill installs it and
moves back to `release` on the next prompt from a site that names no branch.
Deleting the source branch deletes its preview branch. So a feature that spans
both repos uses the same branch name in both.

Failures before the release push leave the previous package available. Cloud
registration happens afterward in the same workflow; if it fails, the package
is available but cloud update notices lag. Rerun that workflow to retry.

The app's `kit_releases` table supplies the required version in agent prompts.
Agents check their installed kit and use the update skill to install from GitHub
when needed. Kit publication does not upload to a desktop channel or require
desktop storage credentials, signing keys, or a desktop release.

Activation: merge this workflow into main, allow its `contents: write` token
to create/update release, and verify the first run. Existing
`PROTO_APP_URL` and `PROTO_KIT_RELEASE_TOKEN` configure cloud registration.
Protect release from human pushes while allowing this workflow to advance it.
Update the cloud setup-command producer alongside this change and migrate
existing marketplace registrations to release. Never fall back to main.
