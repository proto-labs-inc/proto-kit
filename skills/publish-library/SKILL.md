---
name: publish-library
description: Publish your design-system library so it stays viewable after your laptop closes. Builds the library app and uploads the build to a permanent address and prints it. Use when the user runs the publish-library command, asks to publish the library, or wants the library viewable while their laptop is off.
---

# Publish the library

Two steps: build the library app, upload the build, and print where it
lives now.

1. Find the codebase id (the current codebase's `~/.proto/<id>/`; ask
   only if several codebases exist and the conversation doesn't say
   which).
2. Build: `pnpm build` in `~/.proto/<codebase>/library/` (the library
   is a Vite app; its build carries a copy of `public/`, where the
   import's data lives, so `dist/` is the whole library).
3. Run `node tools/publish.mjs --kind library --codebase <codebase>` (kit tools
   resolve from `${CLAUDE_PLUGIN_ROOT}` when running as the installed
   proto plugin, else the proto-kit checkout). It uploads `dist/` and
   refuses politely if there is no build or the build's
   `manifest.json` names no codebase: a library with nothing imported
   has nothing to publish; run import-design-system first.
4. Tell the user in one line: the library is published at the printed
   URL and stays viewable after this laptop closes.

The import-design-system skill publishes automatically when an import
finishes; this command exists for publishing again after manual edits
or when that step was skipped. Each publish uploads to a fresh path,
so links to earlier publishes keep working.
