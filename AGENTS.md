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

Other source branches publish to `preview/<branch>` the same way, for Vercel
previews of the proto branch with the same name: a feature that spans proto
and proto-kit uses one branch name in both repos.

Run `node --test tools/check-plugin.test.mjs tools/update-plugin.test.mjs tools/publish-release.test.mjs tools/register-release.test.mjs`
when changing release automation. Preserve idempotent retries, monotonically
increasing versions, and fast-forward publication without force pushes.

## Desktop delivery and release approval

After the signed OTA bootstrap, desktop agents use independently updated kit
archives. The release workflow publishes an immutable Ed25519-signed archive
before registering the kit version with the cloud. Desktop compares its installed
version with that requirement on every message and activates needed updates
between turns. Normal plugin hosts continue using the GitHub release branch.

Compatible changes to skills, tools and templates do not require a desktop
release. Preserve the artifact schema, signing contract and bridge compatibility.
If a change needs new native operations, a newer bridge, different trust keys or
an incompatible installed loader, inspect the current desktop integration and
explain the specific release requirement before editing. Pause for explicit user
approval, including automatic signed publication after merge to main and green
CI. Reuse approval for the same scope; ask again only when scope materially
changes. If discovered after edits begin, disclose them before proceeding and do
not silently revert the user's work.

Approved native work also updates the cloud repository's
`apps/desktop/release-intent.json`. Its release workflow consumes that intent;
no second publishing approval or manual package-version bump is required. Do not
create a native intent for kit-only changes. Review actual edits before finishing
and report any remaining native release requirement. Docs and tests alone do not
need a release notice. Apps predating OTA need one manual bootstrap installation.

Artifact publication also requires
`node --test tools/publish-desktop-artifact.test.mjs` in addition to the release
tests above. Keep archives immutable, publish descriptors after payloads, and
never expose signing keys or storage credentials in a release.
