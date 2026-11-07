# Work from a copied prompt

Proto does not deliver website commands to agent sessions. The user starts work
by asking in the active conversation or pasting a website work/resume prompt.
Old courier-delivery envelopes are retired. Do not execute or replay them; ask
the user for a current work prompt instead.

For a prompt with a brief ID:

1. Use the configured app and authenticated `get_brief { briefId }`. Match the
   returned codebase and scoped target to the prompt. Do not switch teams to
   get around a refusal or treat the ID as a bearer credential. If
   authentication fails, reconnect through setup.
2. Read request content exclusively from `brief.inputs`: `description`,
   `documentUrl`, `referenceUrl`, `referenceImage`, `referenceHtml`, and
   `useRealData`. The retired top-level input columns may remain in responses
   during deployment; do not use them. This applies to creation, variations,
   section rebuilds, and resume. Identity, action, status, and target remain
   top-level. If `inputs` is absent or malformed, report a contract blocker in
   the active conversation instead of reconstructing it from retired columns.
   Read the persisted `action`. An `add-variants` brief routes to the
   add-variants or create-variant-set skill; a `rebuild-section` brief
   follows "Rebuilding one section" below. New prototypes are no longer
   copied: a `create-prototype` brief cannot be built by this kit; tell the
   user so in one sentence. Do not infer action from a prototype slug.
3. If a historical brief has no action, ask the user to choose its action in
   the website's resume flow. Never guess or create a replacement brief.
4. Preserve `briefId`, `prototype_slug`, `section`, and `parent_brief_id`.
   Use the existing target workspace. Report `started` when work begins,
   then phase progress, `needs-input`, failure, or completion as appropriate.
5. An explicit resume keeps the same workspace and saved checkpoint after
   matching ownership, codebase, and target. Do not rerun completed captures or
   publish a different prototype under the old brief. A finished request is not
   a new request; explain its existing result.

Questions are answered in this conversation. Save them in the build directory,
return `needs-input`, record the user's answer through `build-stream answered`,
and resume. Do not poll a remote feed or default a required choice.

Account linking is separate. Existing valid laptop credentials are reused;
ordinary work prompts contain no new linking code or durable credential. Only
an actual missing/invalid account link uses the setup flow. The website remains
a place to prepare work and review outward progress and published results.

## Rebuilding one section

A brief whose run is `rebuild-section` is a change asked from the
Frame's element picker on an existing copied prototype: `get_brief` gives
the prototype (`prototype_slug`), the component (`section`, its
`data-proto-id`) and the change (`description`, the Frame's full edit
prompt, scoped to that component and its variant). Report `started` when
work begins; only then may the Frame mark the component as rebuilding.
Then make the change in the prototype's workspace
(`~/.proto/<codebase>/prototypes/<slug>/`; the running dev server shows it
as you save), run `node <kit>/tools/check-states.mjs <workspace>` and, for
a variant, `node <kit>/tools/previews.mjs <workspace>`, then
`report_progress done`. When the prototype came from a streamed build
(`parent_brief_id` is set), run those two with `--brief <parent> --codebase <id>`
so the build's stream shows the change: the node is the one whose `marker`
is the section.
