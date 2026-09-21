---
name: publish-library
description: Publish your design-system library so it stays viewable after your laptop closes. Uploads the library as it stands to a permanent address and prints it. Use when the user runs the publish-library command, asks to publish the library, or wants the library viewable while their laptop is off.
---

# Publish the library

One action: upload the library folder as it stands and print where it
lives now.

1. Find the product id (the current product's `~/.proto/<id>/`; ask
   only if several products exist and the conversation doesn't say
   which).
2. Run `node tools/publish.mjs --library <product>` (kit tools
   resolve from `${CLAUDE_PLUGIN_ROOT}` when running as the installed
   proto plugin, else the proto-kit checkout). It refuses politely if
   the library has no `index.html` or no `manifest.json` — a library
   with nothing imported has nothing to publish; run
   import-design-system first.
3. Tell the user in one line: the library is published at the printed
   URL and stays viewable after this laptop closes.

The import-design-system skill publishes automatically when an import
finishes; this command exists for publishing again after manual edits
or when that step was skipped. Each publish uploads to a fresh path,
so links to earlier publishes keep working.
