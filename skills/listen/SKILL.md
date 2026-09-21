---
name: listen
description: Listen for website commands. The session that runs this watches the courier's command feed and acts on each command inline. Normally the user's own interactive session, in the terminal or a desktop app; the supervisor's headless launcher is the fallback. Use when the user runs the listen command or asks this session to listen for site commands.
---

# Listen

You are the session that listens for a product's website commands.
Normally that is **the user's own interactive Claude Code session** (in the terminal or the Claude Code
desktop app), opened with the proto plugin enabled and running this
protocol; setup told them to keep it open. The website rings the
courier listener; accepted commands land in a feed file; you watch
that feed and act on each command **inline, in this conversation** —
with your full context, your own subagents, and continuity across
commands, because the conversation stays open. (A headless session
started by `tools/agent-launch.mjs` under the supervisor is the
FALLBACK — recovery, or nobody-at-the-keyboard — same protocol.)

The harness facts this protocol stands on (per-line Monitor wake,
watch caps and re-arming, the lost-lines gap, at-least-once offsets)
are recorded with evidence in `docs/claude-code-mechanics.md`. Read it
if any step below seems arbitrary.

Your run dir is `~/.proto/<product>/run/courier/` — courier.json
(config), commands.jsonl (the feed, listener-owned), offset.json
(your consumption cursor, yours alone). `<kit>/tools/…` paths resolve
from the kit root: `${CLAUDE_PLUGIN_ROOT}` when running as the
installed proto plugin, else the proto-kit checkout.

## The loop

1. **Arm the watch** — how depends on the harness:
   - **Claude Code**: arm the Monitor tool on
     `node <kit>/tools/feed-tail.mjs <run-dir>`, description
     `"<product> command feed"`, a long timeout — it wakes you per
     line, idle costs nothing; re-arm when it ends. (The plugin also
     declares a `courier-feed` monitor that delivers the same lines
     automatically when the harness honors skill-invoke monitors.)
   - **Codex**: there is no push wake. Run the same feed-tail in a
     background terminal and check it on a relaxed interval while
     this session is open; `node <kit>/tools/feed-tail.mjs <run-dir>
     --once` drains anything pending whenever you (or the user) want
     a spot check. When nobody keeps a session open, the watch isn't
     your job at all: `tools/feed-drive.mjs` under the supervisor
     resumes your saved conversation per command.
2. **Act on each event line** `{"offset": N, "command": {…}}`, one at
   a time, in arrival order (your notifications are already serial —
   that IS the one-run-at-a-time queue):
   - `{"run": "<name>", "briefId"?}` — handle command `<name>`
     in-session: it names the kit skill to follow (create-prototype,
     import-design-system, serve), scoped to this product's
     workspaces. Cloud actions inside those flows go through the
     proto MCP tools (`provision_tunnel`, `register_prototype`,
     `list_comments`, …).

     **With a `briefId`** (the site's Execute path):
     1. Fetch the work: `get_brief {briefId}` → `{id, product,
        account, title, description, url, referenceHtml, status}`.
     2. Report `report_progress {briefId, status: "started"}` before
        any slow work, then keep the site honest at each phase
        change: `"building"` when the workspace work begins,
        `"serving"` when the serve flow starts, `"done"` when it's
        live and registered. The other statuses: `"failed"` and
        `"needs-input"`.
     3. Follow the named skill with the brief's fields (title,
        description, url, referenceHtml). Register with the brief's
        `account` as owner (fall back to config.json's
        `account.user`).
        Publish at the checkpoints: when you report `serving`,
        again before you report `done`, and whenever the current
        state is worth keeping. To publish, build the workspace with
        its own build script, then upload the output with `node
        <kit>/tools/publish.mjs <workspace>`. The published build is
        what viewers see when the laptop is gone.
     4. Any failure → `report_progress` `"failed"` with a **plain
        one-sentence message a non-engineer can read** — never a
        stack trace, never raw output. If the flow needs something
        only the user can give (a login, a decision), report
        `"needs-input"` with the question as the message, then park
        that command and move on; it resumes when the answer
        arrives.

     **Without a `briefId`**: follow the named skill directly and
     record the outcome in your `status.json` — progress reporting
     is per-brief.
   - `{"status": true}` — write a status report to
     `<run-dir>/status.json`: what you're working on, serving health
     (read the sibling run dirs' state.json + liveness), feed offset.
   - `{"restart-serving": "<slug>" | true}` — `node
     <kit>/tools/supervise.mjs stop|start` on the named sibling run
     dir (or all serving ones).
3. **Commit after acting**: write `{"offset": N}` (the acted line's
   offset) to `offset.json` via Bash. Not before — delivery is
   at-least-once, and committing early is how commands get lost.
4. **When the watch ends** (timeout — headless watches are capped),
   re-arm immediately: same Monitor command. feed-tail replays
   anything from your committed offset, so nothing that arrived in the
   gap is missed. Never finish a reply without an armed watch — an
   idle final message with no watch ends the session.
5. **Listener death is NOT a notification to you** — you watch the
   feed file, not the listener process, so you learn nothing when it
   dies. Its supervisor restarts it automatically; your job is only to
   *confirm* it when handling a `status` command: check the run dir's
   `state.json` + process liveness and include the listener's health
   in the report. If the supervisor itself is down, start it. Either
   way the feed file means commands were never lost while the port was
   dark — the site's POSTs failed fast and it knows to retry.

## Restart protocol

If you are told you were restarted (the launcher resumed you, or your
context begins mid-stream): don't re-run anything from memory — the
feed + offset.json are the truth. Re-read `courier.json`, arm the
watch (step 1), and let the replay deliver whatever you hadn't
committed. Duplicate delivery of a command you acted on but didn't
commit is possible; check its `id` against what you know you finished
before redoing expensive work.

## Boundaries

Same rules as every kit skill: workspaces stay naked, nothing lands in
the user's repos, no domains in anything you write, secrets stay in
their `chmod 600` files. You never parse raw HTTP — the listener
validated the command before it reached the feed. Do not stop the
listener or your own supervisor except when a command asks.
