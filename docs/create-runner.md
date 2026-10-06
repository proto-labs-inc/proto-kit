# Create-prototype runner

The agent makes source, design and implementation decisions. Three commands own
mechanical work, always scoped to the exact brief ID:

```sh
node tools/proto-build.mjs prepare <briefId> --codebase <id> --title "<title>"
node tools/proto-build.mjs check-baseline <briefId> --codebase <id>
node tools/proto-build.mjs finish <briefId> --codebase <id> --changed <markers>
```

Each prints one JSON result. `needs-agent` returns work/diagnostics; `needs-input`
requires a conversation answer; `retryable-error` preserves completed operations;
`done` returns completion. Logs belong to stderr. `--no-send` only redirects build
events locally; it is not a dry run and does not disable cloud claims or hosting.

`runner.json` is an atomically written versioned checkpoint under the build
folder. `runner.lock` excludes concurrent commands for the same brief. A dead
process's lock is recoverable; live processes are never evicted by age. Commands
release the lock while the agent edits. Existing screenshot builds recover their
workspace and references but recheck unverifiable old visual evidence. Completed
briefs are read-only. Missing or contradictory ownership requires resolution.

Workspace fingerprints include uncommitted contents, omit dependencies/build
output and generated preview metadata, and invalidate only affected checks.
Reference bytes are verified on every stage. Baseline checks additionally key on
the source component map and capture settings. Changing a baseline cannot reuse
an earlier acceptance. Answers remain in the conversation's durable history.

Publication stores an output fingerprint and receipt before completion. Known
uploaded builds retry finish; verified builds retry availability and reporting.
Expired incomplete uploads use a new immutable path. Do not delete receipts or
rerun builds to repair report delivery. Question history uses the ordered outbox,
with answers sent after their questions and explicit acknowledgments.

Timings distinguish network, subprocess, browser, hosting and stage durations,
cache hits, and intervals awaiting agent/user work. Stage totals include child
durations; do not add them together. Waiting intervals are elapsed wall time,
not measurements of model execution.

## Release and validation

Deploy the cloud atomic-claim/registration contract first. whoami advertises
`prototype-build-claims-v1`; the runner stops before claiming when absent. Then
publish a version-bumped kit and verify its complete installed snapshot. Do not
update a compatible plugin on every build. No first-time setup or import redesign
is part of this release. Deployments are separate operational actions.

Run node --test tools/proto-runner.test.mjs and the reporting, questions,
screenshot, copy-gate and publishing suites. Set PROTO_SCREENSHOT_BROWSER_TEST=1
for local browser fixtures. Set PROTO_RUNNER_BROWSER_TEST=1 for the real React/Vue
scaffold-to-publication fixtures; these use disposable workspaces and a local
mock cloud, including fresh kit snapshots and warm-run timing. Use the cloud disposable PostgreSQL fixture to check
concurrent claims. Warm retries must preserve reference/workspace identity and
avoid duplicate installations, unchanged captures and successful publications.
