// One workspace per target URL. All artifacts for a run live under
// runs/<slug>/ so work on different sites never mixes.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// A stable, readable slug from a URL: host + path, safe characters only.
export function slugFor(url) {
  const u = new URL(url);
  const raw = (u.host + u.pathname).replace(/\/$/, "");
  return raw.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 60);
}

// Make (or reuse) the run directory and return its paths.
// Pass a name to override the URL-derived slug — useful for localhost
// targets, where "localhost-3000" says nothing about the app.
export function workspace(url, { name, root = "runs" } = {}) {
  const slug = name || slugFor(url);
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  return {
    slug,
    dir,
    url,
    // per-artifact path helpers — everything is namespaced by slug
    file: (name) => join(dir, name),
    // diff page URL served by tools/serve.mjs, scoped to this run's images
    diffUrl: (realName, mineName, base = "http://localhost:8123") =>
      `${base}/tools/cdp/diff.html?a=/${dir}/${realName}&b=/${dir}/${mineName}`,
  };
}
