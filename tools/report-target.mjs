import { credentialFor, readConfig } from "./mcp-call.mjs";

export const REPORT_APP = "https://prototypes.fun";

/** Reporting belongs to the hosted service, even when the product app is
 * local or PROTO_APP selects a preview. Use the existing laptop identity;
 * storage credentials stay on the server. Resolve once per upload so begin
 * and finish cannot switch teams if another chat links the laptop meanwhile.
 * PROTO_REPORT_APP is an explicit reporting-service override for tests. */
export function reportTarget(codebase, config = readConfig(), override = process.env.PROTO_REPORT_APP) {
  const url = new URL(override?.trim() || REPORT_APP);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Proto reporting requires an HTTPS origin (or loopback HTTP for tests).");
  }
  return { app: url.origin, secret: credentialFor(config, { codebase }).secret };
}
