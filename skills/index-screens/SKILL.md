---
name: index-screens
description: Discover and review screenshots during codebase setup, then prepare the design system and build reusable screen replicas only after website confirmation. Also refresh screens and copy an indexed starter into a new prototype.
---

# Screenshot-first screen indexing

Use the installed kit root for `tools/…`. All work happens in this conversation;
never start a listener or wait for website commands. Website review is a real
approval boundary, including when setup was requested end to end.

## Discovery, before the design system

1. Verify `whoami` and the codebase's team. Connect the source through setup if
   needed. Do not attach, scaffold, import, host, or publish a design system yet.
2. Call `screen_index {operation:"latest",codebase}`. Resume an unfinished run.
   For first setup or an explicit refresh, create a UUID requestId, save it to
   `~/.proto/<codebase>/screens/index-request.json`, and call operation `begin`.
   Retain the returned indexId. Never replace an interrupted run.
3. Open the signed-in product using the host's browser skill. Inspect source
   routes and primary navigation. Discover meaningful tabs, dialogs, menus,
   empty/populated states. Do not perform destructive product actions to obtain
   a state. Record inaccessible screens as unresolved with notes, not as covered.
4. Capture PNG screenshots only. Do not replicate components or import the design
   system during this phase. Upload each reference with:
   `node <kit>/tools/screen-index.mjs capture <codebase> <indexId> <png>`.
5. Submit `screen_index` operation `inventory` with indexId, current version and
   inventory entries: `{id: UUID,key,group,title,url,path,state,notes,screenshotKey,decision}`.
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
2. If the saved phase is `complete`, report completion and stop. If it is
   `replicating`, skip directly to the remaining replicas. Otherwise claim
   operation `phase` with phase `library`. Only now call
   `attach_onboarding_library`. Preserve a ready library; otherwise follow
   import-design-system through its verification/publish gate, using the approved
   screenshots to guide coverage. An existing codebase reuses its library.
3. Claim phase `replicating`. For each included entry, reuse an already-ready
   revision from this run (`read.screens`, status ready). Otherwise build an isolated standalone Vite replica
   from the product's source and real design system. Use a local run key
   `<indexId>-<version>-<entryId>` as the build-stream brief argument, always with
   `--no-send`. Read, curate and name the page through build-stream. Then run
   `scaffold.mjs <entry-id> --codebase <codebase> --brief <run-key> --screen-index <indexId> --inventory-version <version> --screen-entry <entryId>`.
   This verifies cloud approval before writing an isolated workspace under
   `~/.proto/<codebase>/screens/work/<indexId>/<version>/<entryId>/`.
   Run `replicate.mjs <run-key> --codebase <codebase> --no-send`, then the normal
   checking tools. Replicate rechecks approval before working. Do not register
   templates as user prototypes or create variant sets.
4. Vendor the required library snapshot and local packages inside the starter.
   Include assets, realistic fixtures, lockfile, package.json, index.html and
   public/prototype.json. Resolve imports into the bundle; never depend on an
   absolute laptop path or the mutable sibling library. Exclude secrets, actual
   session state, browser credentials and node_modules. Interactions use isolated
   fixtures rather than modifying the live product. Related states can share a
   bundle, but every entry must have a verified initial URL state.
5. Report copying/checking/failure with operation `progress`. Check screenshots
   against the reference, exercise included interactions, and round-trip rig
   state through URLs. Do not upload an unverified replica as ready.
6. `node <kit>/tools/screen-index.mjs upload <codebase> <indexId> <version> <entryId> <workspace>`
   returns screenId. Call `finish` with screenId and visual/interactions/state
   verification booleans only after all three checks pass. Retry the same entry
   after interruption; a ready revision is immutable.
7. Mark phase complete only when every included entry is ready. Preserve partial
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
   It refuses unrelated existing workspaces and resumes only the same request.
3. Install from the included lockfile using the normal package manager/cache.
   Do not discover, replicate, or regenerate the starter. Register the prototype,
   smoke-test startup and initial state, then use serve to supervise and publish.
   Report progress and completion on the original brief. Retain its starter ID.

## Custom URLs

A website brief without starter_screen_id requests replication of that one URL.
Use create-prototype normally with the existing library. The user authorized only
that screen; wider indexing must go through screenshot review. After verifying
it, call `screen_index` operation `custom` with the exact briefId first to get
its indexId. Capture and upload a screenshot into that index, then call `custom`
again with briefId, screenshotKey and state. This creates a single-screen
approved inventory from the saved request. Claim phase `replicating` using the
existing library, then upload and finish the verified baseline at
`~/.proto/<codebase>/screens/custom-requests/<briefId>/` as above. Never upload a
prototype with the requested changes as the source screen. If this is a legacy
request without a verified baseline checkpoint, preserve the prototype and report
that its starter cannot be saved from the modified workspace. If catalog
upload fails, preserve the working prototype and report that saving its starter
needs retry; do not rebuild or discard the prototype.
