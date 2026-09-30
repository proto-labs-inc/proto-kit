---
name: listen
description: Take jobs from the Proto site in this session. Keep it open while you work and the site can ask this laptop to build, serve, and publish prototypes; you see every job happen here. Use when the user runs the listen command or asks this session to listen for site commands. The supervisor's headless launcher is the fallback when nobody keeps a session open.
---

# Listen

You are the session that listens for the website's commands for this codebase.
Normally that is **the user's own interactive session** (a Claude Code
session in the terminal or the desktop app, a Codex session, or a
Cursor chat), opened with the proto plugin enabled and running this
protocol; setup told them to keep it open. The website rings the
courier listener; accepted commands land in a feed file; you watch
that feed and act on each command **inline, in this conversation**,
with your full context, your own subagents, and continuity across
commands, because the conversation stays open. (A headless session
started by `tools/agent-launch.mjs` under the supervisor is the
FALLBACK: recovery, or nobody-at-the-keyboard, same protocol.)

The harness facts this protocol stands on (per-line Monitor wake,
watch caps and re-arming, the lost-lines gap, at-least-once offsets)
are recorded with evidence in `docs/harness-mechanics.md`. Read it
if any step below seems arbitrary.

Your run dir is `~/.proto/<codebase>/run/courier/`: courier.json
(config), commands.jsonl (the feed, listener-owned), offset.json
(your consumption cursor, yours alone). `<kit>/tools/…` paths resolve
from the kit root. Prefer the installed host's `PLUGIN_ROOT`,
`CLAUDE_PLUGIN_ROOT`, or `CURSOR_PLUGIN_ROOT`; otherwise use the root
above this skill's `skills/` directory, which is also the proto-kit
checkout root.

## The loop

0. **Make sure the courier is up.** `node <kit>/tools/courier-up.mjs
   <codebase>` (add `--codex` on Codex). It starts a stopped courier,
   moves one set up by an older kit onto the relay (restarting the
   courier alone, never the codebase's other runs), and prints whether
   it reached the relay. This is why the one prompt the site
   offers, "run /proto:listen", fixes both a laptop nobody is listening on
   and one whose courier stopped.
1. **Arm the watch.** How depends on the harness:
   - **Claude Code**: arm the Monitor tool on
     `node <kit>/tools/feed-tail.mjs <run-dir>`, description
     `"<codebase> command feed"`, a long timeout: it wakes you per
     line, idle costs nothing; re-arm when it ends. (The plugin also
     declares a `courier-feed` monitor that delivers the same lines
     automatically when the harness honors skill-invoke monitors.)
   - **Codex**: there is no push wake, so instead of watching, you
     **tell the courier where to find you** and it wakes you per
     command:
     1. Invent a random token — the word `proto` and about twelve
        random hex characters, typed out literally, never a shell
        substitution: it has to appear verbatim in this
        conversation's transcript.
     2. Run `node <kit>/tools/codex-thread.mjs identify <run-dir>
        --token <that token>`. It finds the one transcript on disk
        holding your token, and records that thread in
        `courier.json`. It prints the thread id; if it says it
        couldn't find the transcript, `echo` the token on its own and
        run it again with the same token.
     3. Make sure the courier runs the Codex wake: `node
        <kit>/tools/repair-runs.mjs <codebase> --harness codex`,
        which adds `codex-wake` to the courier's run spec when it is
        missing and says so. When it does, restart **the courier
        alone** — `node <kit>/tools/supervise.mjs stop <run-dir>`,
        then `start` — because until that process runs, nothing the
        site sends ever reaches you. Leave the codebase's other runs
        as they are: a served prototype's restart is the user's to
        agree to, and the update skill is where that conversation
        happens.

     From then on each command arrives as an ordinary message in this
     conversation, prefixed "Proto courier command": act on it exactly
     as step 2 describes. **On Codex the courier owns `offset.json`**
     (it commits after the hand-over succeeds), so skip step 3's
     commit and step 4's re-arming entirely — there is no watch to
     re-arm. Do the identify again if you are ever unsure the courier
     still has the right thread; `node <kit>/tools/codex-thread.mjs
     status <run-dir>` says what it currently has. For a spot check,
     `node <kit>/tools/feed-tail.mjs <run-dir> --once` still prints
     what is pending. When nobody keeps a session open at all,
     `tools/feed-drive.mjs` under the supervisor resumes a saved
     conversation headlessly per command — the last resort, because
     nobody sees it happen.
   - **Cursor**: no push wake and no plugin monitor either. Run the
     same feed-tail in a background terminal and check it on a
     relaxed interval while the chat is open; `node
     <kit>/tools/feed-tail.mjs <run-dir> --once` drains anything
     pending for a spot check. There is no unattended path on Cursor
     yet (`feed-queue.mjs` and `feed-drive.mjs` drive Codex
     sessions and `agent-launch.mjs` Claude Code sessions), so tell the user
     plainly: commands queue in the feed while the chat is closed and
     run when a chat picks this protocol up again.
2. **Act on each event line** `{"offset": N, "command": {…}}`, one at
   a time, in arrival order (your notifications are already serial:
   that IS the one-run-at-a-time queue):
   - `{"run": "<name>", "briefId"?}`: handle command `<name>`
     in-session. It names the kit skill to follow (create-prototype,
     import-design-system, serve), scoped to this codebase's
     workspaces. `rebuild-section` is the create-prototype skill's
     "Rebuilding one section": one section of a finished build changed
     on request, in that build's workspace. Cloud actions inside those flows go through the
     proto MCP tools (`provision_tunnel`, `register_prototype`,
     `list_comments`, …).

     **With a `briefId`** (the site's Execute path):
     1. Fetch the work: `get_brief {briefId}` → `{id, codebase,
        title, description, document_url, url, reference_html,
        use_real_data, status}`.
     2. Report `report_progress {briefId, status: "started"}` before
        any slow work, then keep the site honest at each phase
        change: `"building"` when the workspace work begins,
        `"serving"` when the serve flow starts, `"done"` when it's
        live and registered. The other statuses: `"failed"` and
        `"needs-input"`.
     3. Follow the named skill with semantic fields: `codebase`,
        `description`, `contextUrl = document_url`, `referenceUrl = url`,
        `referenceHtml = reference_html`, and `useRealData = use_real_data`.
        Do not pass the site's placeholder `title` as a requested title; the
        create-prototype skill generates the real title from the brief. The
        laptop token identifies the member and team for registration.
        Publish at the checkpoints: when you report `serving`,
        again before you report `done`, and whenever the current
        state is worth keeping. To publish, build the workspace with
        its own build script, then upload the output with `node
        <kit>/tools/publish.mjs --kind prototype <workspace>`. The published build is
        what viewers see when the laptop is gone.
     4. Any failure → `report_progress` `"failed"` with a **plain
        one-sentence message a non-engineer can read**: never a
        stack trace, never raw output. A network that blocks the
        tunnel is one of these, and the serve skill has its exact
        sentence: report it once, publish what exists, and carry on
        with the rest of the work, because everything but the live
        view still works. If the flow needs something
        only the user can give (a login, a decision), report
        `"needs-input"` with the question as the message, then park
        that command and move on; it resumes when the answer
        arrives.

     **Without a `briefId`**: follow the named skill directly and
     record the outcome in your `status.json`. Progress reporting
     is per-brief.
   - `{"status": true}`: write a status report to
     `<run-dir>/status.json` with what you're working on, serving health
     (read the sibling run dirs' state.json + liveness), feed offset.
   - `{"restart-serving": "<slug>" | true}`: `node
     <kit>/tools/supervise.mjs stop|start` on the named sibling run
     dir (or all serving ones).
3. **Commit after acting**: write `{"offset": N}` (the acted line's
   offset) to `offset.json` via Bash. Not before: delivery is
   at-least-once, and committing early is how commands get lost. (Not
   on Codex: `feed-queue.mjs` commits there, and two writers would
   lose commands.)
4. **When the watch ends** (timeout: headless watches are capped),
   re-arm immediately: same Monitor command. feed-tail replays
   anything from your committed offset, so nothing that arrived in the
   gap is missed. Never finish a reply without an armed watch: an
   idle final message with no watch ends the session.
5. **Listener death is NOT a notification to you**: you watch the
   feed file, not the listener process, so you learn nothing when it
   dies. Its supervisor restarts it automatically, and it reconnects
   to the relay by itself; your job is only to *confirm* it when
   handling a `status` command: check the run dir's `state.json` +
   process liveness and include the listener's health in the report.
   If the supervisor itself is down, start it. Either way nothing
   accepted is lost: a command is in the feed before the relay hears
   it arrived, and while the listener is down the relay counts this
   courier gone and the site refuses to send rather than dropping
   anything.

## Busy when a command lands

Setup and the import arm the watch before their own slow work, so a
command can wake you while you are still in the middle of something
else in this session (a design-system import, another build). Finish
what you are doing first; the command waits its turn:

- say one line in the conversation: what arrived ("A prototype
  build came in from the site") and that it starts once the current
  work is done;
- don't report `started` for its brief, and don't commit its offset:
  it is not acted on yet, and an uncommitted offset is what replays
  it if this session dies before getting to it (on Codex the courier
  commits, as step 3 says; only hold the `started`);
- keep the current work's own checkpoints (landing, publishing) as
  they were; don't interleave the waiting command's steps with them;
- when the current work is done, take the waiting commands oldest
  first, exactly as step 2 describes.

The import's current work ends at its Finish (`complete` and the
publish), not when the units it dispatched to fix components report:
they run in the background and land on their own, so a brief never
waits on them. The site shows such a brief as sent, not started,
until you start it.

## Restart protocol

If you are told you were restarted (the launcher resumed you, or your
context begins mid-stream): don't re-run anything from memory. The
feed + offset.json are the truth. Re-read `courier.json`, arm the
watch (step 1), and let the replay deliver whatever you hadn't
committed. Duplicate delivery of a command you acted on but didn't
commit is possible; check its `id` against what you know you finished
before redoing expensive work.

## Boundaries

Same rules as every kit skill: workspaces stay naked, nothing lands in
the user's repos, no domains in anything you write, secrets stay in
their `chmod 600` files. You never parse raw HTTP: the listener
validated the command before it reached the feed. Do not stop the
listener or your own supervisor except when a command asks.
