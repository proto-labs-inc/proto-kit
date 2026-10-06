# Work from a copied prompt

Proto does not deliver website commands to agent sessions. The user starts work
by asking in the active conversation or pasting a website work/resume prompt.
Old courier-delivery envelopes are retired. Do not execute or replay them; ask
the user for a current work prompt instead.

For a prompt with a brief ID:

1. For create-prototype, follow `docs/build-progress.md` immediately: enter
   Connect with an active verification activity before whoami and get_brief
   finish, using the existing credential. Do not report a verified connection
   until those checks succeed. If authentication fails, reconnect through setup.
   Use the configured app and authenticated `get_brief { briefId }`. Match the
   returned codebase and scoped target to the prompt. Do not switch teams to
   get around a refusal or treat the ID as a bearer credential.
2. Read request content exclusively from `brief.inputs`: `description`,
   `documentUrl`, `referenceUrl`, `referenceImage`, `referenceHtml`, and
   `useRealData`. The retired top-level input columns may remain in responses
   during deployment; do not use them. This applies to creation, variations,
   section rebuilds, and resume. Identity, action, status, and target remain
   top-level. If `inputs` is absent or malformed, report a contract blocker in
   the active conversation instead of reconstructing it from retired columns.
   Read the persisted `action`: `create-prototype`, `add-variants`, or
   `rebuild-section`. Route to the matching skill (section changes use the
   create-prototype skill's section-only procedure). Do not infer action from
   a prototype slug: creation briefs also gain a slug when built.
3. If a historical brief has no action, ask the user to choose its action in
   the website's resume flow. Never guess or create a replacement brief.
4. Preserve `briefId`, `prototype_slug`, `section`, and `parent_brief_id`.
   For a new prototype, pass the existing ID to `begin_prototype_build`; for
   edits use the existing target workspace. Report `started` when work begins,
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

For create-prototype progress, follow `docs/build-progress.md`: report on the saved brief before context access, keep its ID, and preserve questions and checkpoints. Registration and heartbeat are availability signals, not completion.
