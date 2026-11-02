import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerRelease } from "./register-release.mjs";

test("kit release workflow registers GitHub releases without a desktop publishing dependency", () => {
  const workflow = readFileSync(new URL("../.github/workflows/register-release.yml", import.meta.url), "utf8");
  const steps = workflow.split(/^      - /m).slice(1);
  const publication = steps.findIndex(step => step.includes("run: node tools/publish-release.mjs"));
  const registration = steps.findIndex(step => step.includes("run: node tools/register-release.mjs"));
  assert.ok(publication >= 0, "generate and publish the release first");
  assert.equal(registration, publication + 1, "register immediately after GitHub publication");
  assert.match(steps[registration], /if: github.ref == 'refs\/heads\/main'/);
  assert.match(steps[registration], /PROTO_RELEASE_SHA: \$\{\{ steps.release.outputs.commit \}\}/);
  assert.doesNotMatch(workflow, /DESKTOP_|publish-desktop|@vercel\/blob/);
});

const input = { app: "https://proto.test", token: "test-only", commit: "a".repeat(40), version: "0.1.0+codex.20261002000000" };
test("release registration sends the verified pair and requires confirmation", async () => {
  const result = await registerRelease({ ...input, fetcher: async (url, options) => {
    assert.equal(url.href, "https://proto.test/api/kit-releases");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer test-only");
    const body = JSON.parse(options.body);
    assert.deepEqual(body, { version: input.version, sourceCommit: input.commit });
    return Response.json({ ok: true, ...body });
  } });
  assert.equal(result.version, input.version);
  await assert.rejects(registerRelease({ ...input, fetcher: async () => new Response("", { status: 409 }) }), /409/);
  await assert.rejects(registerRelease({ ...input, fetcher: async () => Response.json({ ok: true }) }), /not confirmed/);
});
test("invalid release configuration never sends credentials", async () => {
  const fetcher = () => { throw new Error("must not fetch"); };
  for (const change of [{ app: "http://proto.test" }, { token: "" }, { version: "latest" }, { commit: "bad" }]) {
    await assert.rejects(registerRelease({ ...input, ...change, fetcher }), /configuration|HTTPS/);
  }
});

test("registration errors include the API explanation without exposing credentials", async () => {
  await assert.rejects(registerRelease({ ...input, fetcher: async () => Response.json({ error: "version already belongs to another commit" }, { status: 409 }) }), /HTTP 409.*version already belongs to another commit/);
  await assert.rejects(registerRelease({ ...input, fetcher: async () => new Response("<html>Bad gateway</html>", { status: 502 }) }), /^Error: Release registration failed \(HTTP 502\)$/);
  await assert.rejects(registerRelease({ ...input, fetcher: async () => Response.json({ error: `Rejected ${input.token}` }, { status: 401 }) }), error => !error.message.includes(input.token) && error.message.includes("[redacted]"));
});
