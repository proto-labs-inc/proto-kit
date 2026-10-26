#!/usr/bin/env node
import { acquireSourceSession, releaseSourceSession } from "./source-session.mjs";
import { browserSessionPath, useBuildSession } from "./session-context.mjs";
const args = process.argv.slice(2);
const flag = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
if (flag("--codebase") && flag("--run")) useBuildSession(flag("--codebase"), flag("--run"));
if (!browserSessionPath()) throw new Error("usage: product-page.mjs <exact-url|release> --codebase <id> --run <runId> (or --browser-session <path>)");
if (args[0] === "release") console.log(JSON.stringify({ released: await releaseSourceSession() }));
else {
  const result = await acquireSourceSession(args[0], Number(flag("--port") ?? 9333));
  console.log(JSON.stringify({ url: result.tab.url, ...result.session, browserSession: browserSessionPath(), recovered: result.recovered }));
}
