---
name: index-screens
description: Discover and review screenshots during codebase setup, then prepare the design system and build reusable screen replicas only after website confirmation. Also refresh screens and copy an indexed starter into a new prototype.
---

# Screenshot-first screen indexing

Use the installed kit root for `tools/…`. All work happens in this conversation;
never start a listener or wait for website commands. Website review is a real
approval boundary, including when setup was requested end to end.

## Discovery, before the design system

1. Verify `whoami` and the codebase's team. For staff preparation, validate
   `get_site_preparation` and the local `source.kind: "site"` record. No repository
   is required. Customer connection never invokes this discovery workflow. Do not attach, scaffold, import, host, or publish a design system yet.
2. Call `screen_index {operation:"latest",codebase}`. Resume an unfinished run.
   For first setup or an explicit refresh, create a UUID requestId, save it to
   `~/.proto/<codebase>/screens/index-request.json`, and call operation `begin`.
   Retain the returned indexId. Never replace an interrupted run.
3. Open the signed-in product using the host's browser skill. Inspect live navigation and reachable URLs. For a repository-based explicit
   refresh, source routes may supplement the live site. Discover meaningful tabs, dialogs, menus,
   empty/populated states. Do not perform destructive product actions to obtain
   a state. Record inaccessible screens as unresolved with notes, not as covered.
4. Capture PNG screenshots only. Do not replicate components or import the design
   system during this phase. Upload each reference with:
   `node <kit>/tools/screen-index.mjs capture <codebase> <indexId> <png>`.
   After each screen or small batch, save the accumulated inventory with phase
   `discovering`, keeping the returned version. On resume, reuse its completed
   captures. Partial discovery cannot be confirmed by the website.
5. Submit `screen_index` operation `inventory` with indexId, current version and
   phase `review` only when discovery is ready for review, and inventory entries: `{id: UUID,key,group,title,url,path,state,notes,screenshotKey,decision}`.
   Use stable keys for screens/states, the actual browser URL and pathname, and
   a string-to-string state map understood by the future rig. Never treat the URL
   alone as a state identity. decision is include, exclude, or unresolved.
   Capture required UI for each included state. Preserve user exclusions and
   notes; resolve additions by inspecting them, not by silently dropping them.
6. Open `<app>/prototypes/screens?codebase=<codebase>`. Tell the user to inspect
   screenshots, identify missing screens, and confirm coverage. Stop here.
   This is expected review, not a failure. Do not poll for confirmation.

## Resume after confirmation

1. Read operation `read` for the exact indexId from the continuation prompt.
   Require confirmed_version === inventory_version === the requested version.
   If they differ, send the user back to review and stop. The backend refuses
   unapproved transitions; never work around a refusal with local commands.
2. If the saved phase is `complete`, inspect each ready revision’s verification.
   Use prepare-screen’s Existing starters workflow to reverify missing or outdated
   reports. Do not transition a completed index back to replication. Report completion
   only when every included entry is currently selectable; repairs require a refresh.
   If the saved phase is
   `replicating`, skip directly to the remaining replicas. Otherwise claim
   operation `phase` with phase `library`. Preserve a ready library; otherwise follow
   import-design-system through its verification/publish gate, using the approved
   screenshots to guide coverage. An existing codebase reuses its library.
3. Claim phase `replicating`. For each included entry, invoke the shared
   prepare-screen skill with codebase, indexId, version and entryId. It owns
   reference inspection, copying, local behavior, responsive verification and
   artifact completion. For every initial screen, visually inspect source and copy
   at matching widths, reproduce mobile-only UI, and repair small overflow defects
   as part of the baseline. Reuse only revisions passing current verification.
   Report per-entry progress; preserve partial completion and resume checkpoints.
4. Mark phase complete only when every included entry is ready. Preserve partial
   completion and report individual failures. Do not say setup is complete while
   approved screens remain unfinished. Later refreshes repeat discovery/review.

## Copy a starter

For a saved brief with starter_screen_id, this replaces replication entirely:

1. Fetch get_brief and verify creator, codebase, saved status and action. Preserve
   the exact briefId. Use list_prototypes to choose an unused slug and claim it
   with begin_prototype_build. Completed requests are not started again.
2. Run `node <kit>/tools/screen-index.mjs clone <codebase> <starter_screen_id> <slug> <briefId>`.
   This verifies a cached or downloaded bundle, creates an independent workspace,
   writes fresh identity and port, and sets the initial state before app boot.
   It also verifies and copies the prepared build into `dist/`, giving source and
   dist the same fresh identity, manifest and initial state. It refuses unrelated
   existing workspaces and resumes only the same request without overwriting edits.
3. For an unchanged copy, do not install dependencies or compile. Serve the
   cloned `dist/` with `node <kit>/tools/serve.mjs <workspace>/dist <port>`, then
   publish it directly with `publish.mjs`. Register the prototype, smoke-test
   startup and initial state, and follow serve for supervision and publishing.
   Install locked dependencies and use the editable source only when the request
   includes actual edits; then rebuild and switch the supervised server to dev.
   Do not discover, replicate, or regenerate the starter.
   Report progress and completion on the original brief. Retain its starter ID.

## Custom URLs

A website brief without starter_screen_id authorizes preparation of its one
reference URL. After claiming the brief (started/building/serving), call
`screen_index {operation:"custom",briefId}` to obtain the index. Capture its
reference PNG, then call custom again with briefId, screenshotKey and initial
state to confirm the single-screen inventory. Claim replicating using the existing
library. Invoke the same prepare-screen workflow used for initial setup screens,
including visual inspection at matching widths and small responsive usability
repairs even for an unchanged-copy request. Wait for a verified screenId.
Clone it with `screen-index.mjs clone <codebase> <screenId> <slug> <briefId>`
before applying any requested prototype changes. Resume by reading the same
custom index, never by snapshotting a modified prototype. A legacy request with
an existing modified workspace and no baseline is blocked pending a separately
prepared baseline; do not overwrite it or archive its changes as the starter.

## Prepare existing starters

For an existing ready screen that predates prepared builds, run
`node <kit>/tools/screen-index.mjs prepare <codebase> <screenId>`. It downloads and
verifies the exact immutable source, builds it once in isolation and attaches the
compiled artifact to that same screen ID. An already-prepared screen is reused.
Never create a replacement screen or reconstruct the product to backfill a build.
