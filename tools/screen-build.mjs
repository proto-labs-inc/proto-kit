/** The compiled half of a starter, bound to the immutable editable bundle. */
import { createHash, randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
const LIMIT = 128 * 1024 * 1024;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const excluded = (name) =>
  name.startsWith(".") ||
  /^(?:node_modules|__proto-workspace\.json|build\.json|tunnel\.json)$/.test(
    name,
  ) ||
  name.endsWith(".map");
function validate(build, sourceChecksum) {
  if (
    build.format !== "proto-screen-build-v1" ||
    build.sourceChecksum !== sourceChecksum ||
    !/^[a-f0-9]{64}$/.test(sourceChecksum)
  )
    throw new Error("Prepared build does not match the source bundle.");
  if (!Array.isArray(build.files) || build.files.length > 10000)
    throw new Error("Invalid prepared build.");
  const names = new Set();
  let size = 0;
  for (const file of build.files) {
    if (
      typeof file.path !== "string" ||
      file.path.includes("\\") ||
      file.path.includes(":") ||
      file.path.split("/").some((part) => !part || excluded(part)) ||
      names.has(file.path) ||
      typeof file.data !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        file.data,
      )
    )
      throw new Error("Unsafe prepared build entry.");
    names.add(file.path);
    size += Buffer.byteLength(file.data, "base64");
    if (size > LIMIT)
      throw new Error("Expanded prepared build exceeds 128 MB.");
  }
  for (const path of ["index.html", "prototype.json"])
    if (!names.has(path)) throw new Error(`Prepared build is missing ${path}.`);
  const manifest = JSON.parse(
    Buffer.from(
      build.files.find((f) => f.path === "prototype.json").data,
      "base64",
    ),
  );
  if (manifest.needsServer)
    throw new Error("Starters must work without a backend server.");
}
export function packScreenBuild(folder, sourceChecksum) {
  const root = resolve(folder);
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (excluded(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("Prepared builds cannot contain symlinks.");
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile())
        files.push({
          path: relative(root, path).split("\\").join("/"),
          data: readFileSync(path).toString("base64"),
        });
    }
  }
  walk(root);
  const build = { format: "proto-screen-build-v1", sourceChecksum, files };
  validate(build, sourceChecksum);
  const bytes = gzipSync(JSON.stringify(build));
  if (bytes.length > 32 * 1024 * 1024)
    throw new Error("Compressed prepared build exceeds 32 MB.");
  return bytes;
}
export function unpackScreenBuild(
  bytes,
  checksum,
  sourceChecksum,
  destination,
) {
  if (digest(bytes) !== checksum)
    throw new Error("Prepared build checksum mismatch.");
  const build = JSON.parse(gunzipSync(bytes, { maxOutputLength: LIMIT * 2 }));
  validate(build, sourceChecksum);
  if (existsSync(destination))
    throw new Error("Prepared build destination already exists.");
  const staging = `${destination}.partial-${randomBytes(6).toString("hex")}`;
  try {
    mkdirSync(staging, { recursive: true });
    for (const file of build.files) {
      const path = join(staging, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(file.data, "base64"));
    }
    renameSync(staging, destination);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
