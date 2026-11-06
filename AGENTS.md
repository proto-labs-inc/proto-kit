# proto-kit

The Proto plugin for Claude Code, Codex and Cursor. Skills live in
`skills/`, the tools they run in `tools/`, the library and workspace
templates in `template/`.

## Wireframe authoring

Draw wireframes edge to edge on a white or transparent canvas. Do not add gray backgrounds, gray insets, outer mats, or decorative page frames. This applies to PR-plan assets, sketch bases, directions, refinements, and detail options.

## GitHub owns release versions

Source changes go to main. `.github/workflows/register-release.yml` tests the
kit and generates a uniquely versioned snapshot on release. Do not manually
bump manifests for normal source changes or commit directly to release.
`tools/publish-release.mjs` stamps all versioned host manifests and records
source/run provenance. Normal plugin installs and updates use GitHub release;
local files are only used when the user explicitly requests a local install.

Other source branches publish to `preview/<branch>` the same way, for Vercel
previews of the proto branch with the same name: a feature that spans proto
and proto-kit uses one branch name in both repos.

Run `node --test tools/check-plugin.test.mjs tools/update-plugin.test.mjs tools/publish-release.test.mjs tools/register-release.test.mjs`
when changing release automation. Preserve idempotent retries, monotonically
increasing versions, and fast-forward publication without force pushes.

## Desktop release approval

Before changing bundled Electron code, preload contracts, local agent integration,
or other capabilities that require a signed desktop release, explain the release
requirement and proposed changes, then pause for user approval before editing.
An after-the-fact notice is insufficient. The cloud UI migration and initial
bootstrap/integration release requested on 2026-10-23 are already authorized.
That authorization does not cover future desktop releases or production publication.
