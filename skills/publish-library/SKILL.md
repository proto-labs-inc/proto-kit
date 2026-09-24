---
name: publish-library
description: Publish your design-system library so it stays viewable after your laptop closes. Builds the library app and uploads the build to a permanent address and prints it. Use when the user runs the publish-library command, asks to publish the library, or wants the library viewable while their laptop is off.
---

# Publish the library

One command builds the library app, uploads the build and prints where
it lives now.

1. Find the codebase id (the current codebase's `~/.proto/<id>/`; ask
   only if several codebases exist and the conversation doesn't say
   which).
2. Run `node tools/publish-library.mjs <codebase>` (kit tools resolve
   from `${CLAUDE_PLUGIN_ROOT}` when running as the installed proto
   plugin, else the proto-kit checkout). It runs `pnpm build` in
   `~/.proto/<codebase>/library/` (the library is a Vite app; its build
   carries a copy of `public/`, where the import's data lives, so
   `dist/` is the whole library), then uploads `dist/`. It refuses
   politely when the library's `manifest.json` names no codebase: a
   library with nothing imported has nothing to publish; run
   import-design-system first. If another publish is running it waits
   for it, then builds, so it carries everything on disk by then.
3. Tell the user in one line: the library is published at the printed
   URL and stays viewable after this laptop closes.

The import-design-system skill runs this command after every component
lands and again when the import finishes; this command exists for
publishing again after manual edits. Each publish uploads to a fresh
path, so links to earlier publishes keep working.
