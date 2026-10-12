import { validateVerification } from "./screen-verification.mjs";
import { createHash, randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
  rmSync,
  lstatSync,
} from "node:fs";
import { join, dirname, resolve, relative, posix } from "node:path";
import { unpackScreenBuild } from "./screen-build.mjs";
import { pickPort } from "./ports.mjs";

const LIMIT = 128 * 1024 * 1024;
const EXCLUDED =
  /^(node_modules|\.git|\.next|dist|\.env(?:\..*)?|\.npmrc|\.DS_Store|__proto-workspace\.json|\.proto-starter\.json|build\.json|tunnel\.json)$/;
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
function safePath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path
      .split("/")
      .some((s) => !s || s === "." || s === ".." || EXCLUDED.test(s))
  );
}
function validateFiles(files) {
  if (!Array.isArray(files) || files.length > 10000)
    throw new Error("Invalid source bundle.");
  const names = new Set();
  let total = 0;
  for (const file of files) {
    if (
      !safePath(file.path) ||
      names.has(file.path) ||
      typeof file.data !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        file.data,
      )
    )
      throw new Error("Unsafe source bundle entry.");
    names.add(file.path);
    total += Buffer.byteLength(file.data, "base64");
    if (total > LIMIT)
      throw new Error("Expanded source bundle exceeds 128 MB.");
  }
  for (const file of files) {
    if (!/\.(?:[cm]?jsx?|tsx?|vue|json|css)$/.test(file.path)) continue;
    const source = Buffer.from(file.data, "base64").toString("utf8");
    if (/["'`](?:\/Users\/|\/home\/|[A-Z]:\\)/.test(source))
      throw new Error(
        "Replace absolute laptop paths before packing the starter.",
      );
    for (const match of source.matchAll(/["'`](\.\.?\/[^"'`\n]+)["'`]/g)) {
      const target = posix.normalize(
        posix.join(posix.dirname(file.path), match[1]),
      );
      if (target === ".." || target.startsWith("../"))
        throw new Error(
          "Vendor references outside the starter before packing it.",
        );
    }
  }
  for (const required of [
    "package.json",
    "public/prototype.json",
    "index.html",
  ])
    if (!names.has(required)) throw new Error(`Missing ${required}.`);
  if (
    !["pnpm-lock.yaml", "package-lock.json", "yarn.lock"].some((name) =>
      names.has(name),
    )
  )
    throw new Error("A dependency lockfile is required.");
  const pkg = JSON.parse(
    Buffer.from(files.find((f) => f.path === "package.json").data, "base64"),
  );
  for (const value of Object.values({
    ...pkg.dependencies,
    ...pkg.devDependencies,
  })) {
    if (typeof value === "string" && /^(file:|link:|workspace:)/.test(value)) {
      const path = value.replace(/^(file:|link:)/, "").replace(/^\.\//, "");
      if (!safePath(path) || !names.has(`${path}/package.json`))
        throw new Error(
          "Vendor local dependencies inside the starter before packing it.",
        );
    }
  }
}
export function screenDependencies(folder) {
  const pkg = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));
  const lockfiles = {};
  for (const name of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) {
    if (existsSync(join(folder, name)))
      lockfiles[name] = sha256(readFileSync(join(folder, name)));
  }
  return {
    dependencies: pkg.dependencies ?? {},
    devDependencies: pkg.devDependencies ?? {},
    lockfiles,
  };
}
export function packScreen(folder) {
  const root = resolve(folder);
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (EXCLUDED.test(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(
          "Vendor symlinked dependencies before packing a screen.",
        );
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile())
        files.push({
          path: relative(root, path).split("\\").join("/"),
          data: readFileSync(path).toString("base64"),
        });
    }
  }
  walk(root);
  validateFiles(files);
  const bytes = gzipSync(JSON.stringify({ format: "proto-screen-v1", files }));
  if (bytes.length > 32 * 1024 * 1024)
    throw new Error("Compressed source bundle exceeds 32 MB.");
  return bytes;
}
export function unpackScreen(bytes, checksum, destination) {
  if (sha256(bytes) !== checksum)
    throw new Error("Source bundle checksum mismatch.");
  const bundle = JSON.parse(gunzipSync(bytes, { maxOutputLength: LIMIT * 2 }));
  if (bundle.format !== "proto-screen-v1")
    throw new Error("Unsupported screen bundle version.");
  validateFiles(bundle.files);
  if (existsSync(destination)) throw new Error("Destination already exists.");
  const staging = `${destination}.partial-${randomBytes(6).toString("hex")}`;
  try {
    mkdirSync(staging, { recursive: true });
    for (const file of bundle.files) {
      const path = join(staging, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(file.data, "base64"));
    }
    renameSync(staging, destination);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
export async function cloneScreen(
  bytes,
  screen,
  { destination, slug, codebase, briefId, port, buildBytes },
) {
  validateVerification(screen.metadata?.verification, screen);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || !briefId)
    throw new Error("A new slug and exact brief ID are required.");
  if (existsSync(destination)) {
    const marker = join(destination, ".proto-starter.json");
    if (!existsSync(marker) || lstatSync(destination).isSymbolicLink())
      throw new Error("Do not overwrite an existing workspace.");
    const previous = JSON.parse(readFileSync(marker));
    if (previous.screenId !== screen.id || previous.briefId !== briefId)
      throw new Error("Workspace belongs to another request.");
    return {
      path: destination,
      resumed: true,
      port: JSON.parse(readFileSync(join(destination, "public/prototype.json")))
        .port,
    };
  }
  const selectedPort = port ?? (await pickPort({ from: 5173, to: 5999 }));
  const staging = `${destination}.clone-${randomBytes(6).toString("hex")}`;
  try {
    const prepared = screen.metadata?.preparedBuild;
    if (
      !buildBytes ||
      !prepared ||
      prepared.sourceChecksum !== screen.bundle_checksum
    )
      throw new Error(
        "This starter needs a prepared build. Run screen-index.mjs prepare for this screen first.",
      );
    unpackScreen(bytes, screen.bundle_checksum, staging);
    unpackScreenBuild(
      buildBytes,
      prepared.checksum,
      screen.bundle_checksum,
      join(staging, "dist"),
    );
    const manifestPath = join(staging, "public/prototype.json");
    const manifest = JSON.parse(readFileSync(manifestPath));
    manifest.name = screen.title;
    manifest.port = selectedPort;
    manifest.variantSets = [];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    writeFileSync(
      join(staging, "dist/prototype.json"),
      JSON.stringify(manifest, null, 2),
    );
    const pkg = JSON.parse(readFileSync(join(staging, "package.json")));
    pkg.name = slug;
    // Vite's CLI flag overrides any port frozen in the bundled config.
    pkg.scripts ??= {};
    if (!pkg.scripts.dev || !/\bvite\b/.test(pkg.scripts.dev))
      throw new Error("A Vite dev script is required for an editable starter.");
    pkg.scripts.dev = `${pkg.scripts.dev.replace(/\s+--port(?:=|\s+)\d+/g, "")} --port ${selectedPort} --strictPort`;
    writeFileSync(join(staging, "package.json"), JSON.stringify(pkg, null, 2));
    const identity = { codebase, slug, token: randomBytes(24).toString("hex") };
    writeFileSync(
      join(staging, "public/__proto-workspace.json"),
      JSON.stringify(identity, null, 2),
    );
    writeFileSync(
      join(staging, "dist/__proto-workspace.json"),
      JSON.stringify(identity, null, 2),
    );
    // Initial state is applied before the app and rig boot, so reload and Frame agree.
    const state = JSON.stringify(screen.initial_state).replace(/</g, "\\u003c");
    const initial = `<script>{const query=new URLSearchParams(location.search);if([...query.keys()].every(key=>key==='__protoTheme')){const state=${state};for(const [key,value] of Object.entries(state))query.set(key,value);if(query.size)history.replaceState(null,'',location.pathname+'?'+query+location.hash);}}</script>`;
    for (const htmlPath of [
      join(staging, "index.html"),
      join(staging, "dist/index.html"),
    ]) {
      writeFileSync(
        htmlPath,
        readFileSync(htmlPath, "utf8").replace(
          /<head(?:\s[^>]*)?>/i,
          (head) => `${head}${initial}`,
        ),
      );
    }
    writeFileSync(
      join(staging, ".proto-starter.json"),
      JSON.stringify({
        screenId: screen.id,
        briefId,
        preparedBuild: prepared.checksum,
      }),
    );
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(staging, destination);
    return {
      path: destination,
      port: selectedPort,
      resumed: false,
      serving: "prepared",
      dist: join(destination, "dist"),
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
