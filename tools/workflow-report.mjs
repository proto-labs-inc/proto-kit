import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export function workflowEvent(runDir, step, line, status = "active") {
  mkdirSync(runDir, { recursive: true });
  const path = join(runDir, "workflow.json");
  const previous = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  let revision = previous?.revision ?? randomUUID();
  if ((step === "copy" || step === "build") && previous?.step !== step) revision = randomUUID();
  const event = { kind: "workflow", reportId: randomUUID(), step, revision, status, line };
  writeFileSync(path, JSON.stringify(event));
  return event;
}
export function activityEvent(workflow, id, status, title, detail) {
  return { kind: "activity", reportId: randomUUID(), id, step: workflow.step, revision: workflow.revision, status, title, detail };
}
