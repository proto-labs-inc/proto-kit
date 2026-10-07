#!/usr/bin/env node
/** Register only the generated commit already published on release. */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export async function registerRelease({ app, token, commit, version, fetcher = fetch }) {
  if (!app || !token || !/^[0-9a-f]{40}$/.test(commit ?? "") || !/^0\.1\.0\+codex\.\d{14}$/.test(version ?? "")) {
    throw new Error("Missing or invalid release configuration");
  }
  const origin = new URL(app);
  if (origin.protocol !== "https:") throw new Error("Release registration requires HTTPS");
  const response = await fetcher(new URL("/api/kit-releases", origin), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ version, sourceCommit: commit }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail = typeof body?.error === "string"
      ? body.error.replaceAll(token, "[redacted]").replace(/[\r\n]+/g, " ").slice(0, 300)
      : "";
    throw new Error(`Release registration failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
  }
  const result = await response.json();
  if (!result.ok || result.version !== version || result.sourceCommit !== commit) throw new Error("Release registration was not confirmed");
  return { version, sourceCommit: commit };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.env.GITHUB_REF !== "refs/heads/main" || process.env.GITHUB_REPOSITORY !== "proto-labs-inc/proto-kit") {
      throw new Error("Only the published proto-kit main branch may register releases");
    }
    const commit = process.env.PROTO_RELEASE_SHA;
    if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("Missing source commit");
    const published = execFileSync("git", ["ls-remote", "origin", "refs/heads/release"], { encoding: "utf8" }).trim().split(/\s/)[0];
    if (published !== commit) throw new Error("Release commit is not the published release branch");
    const remote = JSON.parse(execFileSync("gh", ["api", `repos/proto-labs-inc/proto-kit/contents/.codex-plugin/plugin.json?ref=${commit}`, "-H", "Accept: application/vnd.github.raw+json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    if (remote.name !== "proto") throw new Error("Published manifest does not match the checkout");
    console.log(JSON.stringify(await registerRelease({ app: process.env.PROTO_APP_URL, token: process.env.PROTO_KIT_RELEASE_TOKEN, commit, version: remote.version })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
