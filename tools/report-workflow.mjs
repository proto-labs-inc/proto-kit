#!/usr/bin/env node
// Report real agent work before a workspace exists. JSON input contains only verified facts.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { buildFolder } from "./build-folder.mjs";
import { createReporter } from "./build-report.mjs";
import { workflowEvent } from "./workflow-report.mjs";
const [briefId, codebase, step, input] = process.argv.slice(2);
if (!briefId || !codebase || !["connect", "review", "copy", "build", "check", "publish"].includes(step) || !input || !/^[a-zA-Z0-9-]+$/.test(briefId) || !/^[a-zA-Z0-9-]+$/.test(codebase)) throw new Error("usage: report-workflow.mjs <briefId> <codebase> <step> <report.json>");
const body = JSON.parse(readFileSync(input, "utf8"));
if (typeof body.line !== "string" || !body.line.trim()) throw new Error("report.line must describe the actual work as a nonempty string");
if (body.events !== undefined && !Array.isArray(body.events)) throw new Error("report.events must be an array");
const runDir = buildFolder(codebase, briefId);
const reporter = createReporter({ codebase, briefId, runDir });
const workflow = workflowEvent(runDir, step, body.line);
reporter.send([workflow, ...(body.events ?? []).map(event => ({ ...event, reportId: event.reportId ?? randomUUID(), ...(event.kind === "activity" ? { step, revision: workflow.revision } : {}) }))]);
await reporter.flush();
