---
name: debug
description: >-
  Send the Proto team a debug report of this session, with the user's
  permission: the whole conversation, its subagents' transcripts and this
  laptop's Proto logs, so they can see exactly what went wrong. Run only
  when the user asks for it by name (the debug command, or "send Proto a
  debug report"); never on your own, never as a fix for something failing.
disable-model-invocation: true
---

# Debug report

The user is sending this session to the Proto team, usually because
someone at Proto asked them to during a demo. Everything after the
command is their note (`/proto:debug the import got stuck on buttons`);
there may be none.

All `<kit>/tools/…` paths resolve from the kit root: prefer the
installed host's `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT` or
`CURSOR_PLUGIN_ROOT`, otherwise the root above this skill's `skills/`
directory.

**Cursor is not supported yet.** If you are running in Cursor, say so
in one sentence ("Debug reports from Cursor aren't supported yet; the
Proto team can take this session another way.") and stop. Claude Code
and Codex are supported.

## 1. Find this session and say what will be sent

Make up a fresh token, `dbgmark-` followed by 12 random lowercase
letters and digits, and write it literally into the command; never
reuse one. The token is how the tool finds this session's transcript on
disk, so it must appear in the command exactly as run:

```bash
node <kit>/tools/debug-report.mjs plan --token dbgmark-<random>
```

It prints `{ harness, subagents, logs, files, totalBytes }`. If it
fails, tell the user what it said and stop.

## 2. Ask, and wait for a yes

Ask once, plainly, with the real numbers. For example:

> This will send the Proto team this whole conversation, 3 subagent
> transcripts and 5 Proto log files (about 12 MB). It includes
> everything from this session, including code I read from your
> project. Credentials are blanked out. Send it?

Use the harness's question tool when it has one. Do nothing more until
the user answers. Anything but a clear yes means stop and say nothing
was sent.

## 3. Send

Same token. Pass the user's note exactly as they wrote it, quoted for
the shell, and the codebase this session was working on when there is
one:

```bash
node <kit>/tools/debug-report.mjs send --token dbgmark-<same> --note '<their note>' --codebase <codebase>
```

Leave out `--note` or `--codebase` when there is none. This can take a
while for a long session; progress goes to stderr. Never shorten,
filter or split what it sends.

It prints `{ id, files, totalBytes }` only once the Proto site has
confirmed every file arrived.

## 4. Thank them

Only after `send` succeeded, say exactly this, with the id:

> Thank you for helping make Proto a better product for you. Your report
> ID is `<id>` if you'd like to mention it to us.

If `send` failed, do not thank them or give an id. Say in one sentence
that the report did not go through and why, as the tool said it. If it
says Proto is not set up on this laptop, the setup skill fixes that.
