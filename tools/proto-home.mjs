/**
 * The Proto folder: config.json, each codebase's workspaces and run
 * records, traces and the headless browser's profile. PROTO_HOME names it
 * (the Proto desktop app keeps its own, inside the app's data folder);
 * otherwise it is ~/.proto.
 */
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const protoHome = () => process.env.PROTO_HOME || join(process.env.HOME || homedir(), ".proto");

/** A path's segments below the Proto folder, or null when it is outside it. */
export function belowProtoHome(path) {
  const rel = relative(protoHome(), resolve(path));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep);
}
