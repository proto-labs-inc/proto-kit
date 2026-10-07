# proto-kit

The Proto plugin for Claude Code, Codex and Cursor. Skills live in
`skills/`, the tools they run in `tools/`, the library and workspace
templates in `template/`.

## GitHub owns release versions

Source changes go to main. `.github/workflows/register-release.yml` tests the
kit and generates a uniquely versioned snapshot on release. Do not manually
bump manifests for normal source changes or commit directly to release.
`tools/publish-release.mjs` stamps all versioned host manifests and records
source/run provenance. Normal plugin installs and updates use GitHub release;
local files are only used when the user explicitly requests a local install.

Run `node --test tools/publish-release.test.mjs tools/register-release.test.mjs`
when changing release automation. Preserve idempotent retries, monotonically
increasing versions, and fast-forward publication without force pushes.
