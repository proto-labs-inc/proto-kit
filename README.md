# proto-kit

Proto's installable surface — everything a customer's machine runs. The
cloud product lives in the `proto` repo; this repo is what their coding
agent installs and drives.

## Layout

| Path | What it is |
| --- | --- |
| `template/library/` | The design-system library viewer: a raw-HTML app the import fills with extracted tokens, type styles, and components. Scaffolded to `~/.proto/<project>/library/`, served locally, framed by the Proto app. |
| `tools/` | Deterministic helpers. `serve.mjs` (static server with CORS + no-store + `?ls` listing, for anything the laptop serves), `cdp/` (the CDP reading/verification toolkit absorbed from replicate: attach, wireframe, capture, pixel diff), `fake-import/` (plays a recorded design-system import against a library folder, for demos and UI work). |
| `skills/` | The agent protocols. `import-design-system/` (source repo + live page over CDP → the library contract). Soon: setup, create-prototype, serve. |
| `docs/` | `library-contract.md` — the frozen manifest/progress/components contract both the fake driver and the real import write. |
| `cli/` | (soon) The `proto` CLI. |

A plugin manifest will wrap `skills/` + `tools/` for Claude Code's
marketplace; the same content transforms into Cursor rules. The core stays
harness-neutral: markdown protocols + plain scripts.

## The laptop layout this kit produces

```
~/.proto/
├─ config.json              account link, global settings
└─ <project>/               one per product being prototyped
   ├─ project.json          source pointers (repo path, live URL)
   ├─ library/              design-system viewer + extracted pieces
   └─ prototypes/<slug>/    prototype workspaces (vite + rig + prototype.json)
```

## Demo: watch a design system populate

```sh
# scaffold a library and serve it
cp -r template/library /tmp/demo-library
node tools/serve.mjs /tmp/demo-library 5210

# in another terminal: play the fake import into it
node tools/fake-import/run.mjs /tmp/demo-library

# open http://localhost:5210 and watch it fill in
```
