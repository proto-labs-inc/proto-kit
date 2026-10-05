# Report prototype progress

Use the same saved briefId for every operation. Enter Connect immediately when
starting connection verification, before whoami and get_brief finish. Using the
existing credential for the requested app and codebase, send a connect report
with an active activity titled "Verifying laptop connection". This is work in
progress, not a claim that the connection or request has been verified. Do not
include a connection event or completed activity until verification succeeds.

Then call whoami and get_brief and verify the member, team, codebase, action,
target, and recorded checkpoint. If done, report the existing completion to the
user and stop; never restart a completed request. If a verified resume is already
past Connect, preserve its checkpoint rather than resetting it. If disconnected,
keep Connect as the current step in chat, reconnect through setup, and send the
pending connect report as soon as authentication permits it. Never claim a report
reached the site when it failed. Never send tokens, credentials, or local paths
in connection details.

## Before a workspace exists

Write a JSON report file and run:

`node tools/report-workflow.mjs <briefId> <codebase> <step> <report.json>`

Steps are connect, review, copy, build, check, publish. The report is `{line, events}`.
The helper supplies revision and report IDs. Send actual progress as it happens.
An activity contains `{kind: "activity", id, status, title, detail}`. Keep its id
stable; status is pending, active, completed, blocked, or failed. Use base-form
copy for pending work, present-progressive for active work, and past-tense for
completed work. Do not invent checks or mark inferred results completed.

After whoami and get_brief verify the connection and request, complete the same
Connect activity and add a connection event: `{kind: "connection", laptop, team, codebase}` using display names only.
Then report review before reading context. Report a context event containing
`{kind: "context", description, summary, sources: [{title, url}]}`. Preserve the
original description exactly. Summarize only retrieved content, never guesses.
Use an empty summary until read. Description-only requests have no sources.
Report actual reference access, design-system inspection, and scope review as
activities. Choose a title and unused slug from the content, then call
begin_prototype_build with the original briefId. Do not create a replacement.

## Build and check

Copy is a distinct step: reference capture, naming, replication, composition, and
the copy-quality gate all report copy. After the gate passes or the user chooses
to proceed, report build before applying the requested change. Copy, replication,
check-states, and publish report their own work. Before editing
the requested changes or fixing failed checks, report build with the helper.
Run check-states after changes; it reports real checks and the default screenshot.
Repeat build/check as necessary, preserving unaffected components. Use the same
briefId and workspace on resume. A report failure leaves a durable outbox; flush
or rerun the reporting helper to retry before proceeding. Do not ignore failures.

## Action needed

Use build-stream question with --kind generic or copy-gate and a stable
--question-key. Options are optional for a free-text/access request. The local
workflow step is attached automatically. The shared website notice displays it;
answers come only from this chat. Required input stops dependent work. Record
answers using build-stream answered, then resume the same checkpoint. Never clear
a question with a phase report or select an answer on a timer.

## Publish

Build the workspace, then run publish.mjs. It captures the actual static build,
uploads it, and verifies availability through finish_publish before reporting done.
Do not send a phase ready event or use a heartbeat as completion. If publishing
fails, keep the request unfinished and report the failure. The gallery continues
to show the current request when its modal is closed.
