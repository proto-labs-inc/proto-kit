import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { resolve, sep, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { launchedDisplayOr } from "./views.mjs";
import { headlessPage } from "./cdp/headless.mjs";
import { stableShot, VIEWPORT, FONTS_LOADED } from "./cdp/capture.mjs";

// Capture exactly the static files about to be published, not a potentially newer dev server.
export async function capturePublishedPreview(dist, build, reporter, revision) {
  const root = resolve(dist);
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
  const server = createServer((req, res) => {
    try {
      const path = resolve(root, "." + decodeURIComponent(new URL(req.url, "http://localhost").pathname));
      if (path !== root && !path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
      const file = statSync(path).isDirectory() ? join(path, "index.html") : path;
      res.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
      res.end(readFileSync(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  let opened;
  try {
    const viewport = build.tree?.viewport ?? { width: 1280, height: 800 };
    opened = await headlessPage(`http://127.0.0.1:${server.address().port}/`, { ...viewport, display: launchedDisplayOr(viewport) });
    const path = join(build.dir, "publish-preview.png");
    await stableShot(opened.page, `JSON.stringify([${VIEWPORT}, ${FONTS_LOADED}])`, path);
    reporter.send([{ kind: "preview", reportId: randomUUID(), revision, image: await reporter.upload(readFileSync(path)), ...viewport }]);
  } finally {
    if (opened) await opened.close();
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  }
}
