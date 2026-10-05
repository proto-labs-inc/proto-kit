/** Neutral question schema shared by local build questions and read-only history. */
import { randomBytes } from "node:crypto";

const ID = /^[a-z0-9][a-z0-9-]*$/;
export const QUESTION_FORMS = ["copy-gate", "generic"];

/** A question id: short, unique within its build. */
export function newQuestionId() {
  return `q-${randomBytes(4).toString("hex")}`;
}

const isId = (value) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= 40 && ID.test(value.trim());
const text = (value, max) => (typeof value === "string" && value.trim().length > 0 && value.trim().length <= max ? value.trim() : null);

/**
 * The question event the site stores, from the agent's fields, or an
 * Error naming everything the site would refuse. `form` is copy-gate or
 * generic; options are zero to three { id, label }.
 */
export function questionEvent(fields) {
  const problems = [];
  const event = { kind: "question", id: fields.id, form: fields.form };
  if (!isId(fields.id)) problems.push("the question id must be lowercase letters, digits and dashes, at most 40");
  if (!QUESTION_FORMS.includes(fields.form)) problems.push(`--kind must be one of ${QUESTION_FORMS.join(", ")}`);
  event.text = text(fields.text, 200);
  if (!event.text) problems.push("the question must be 1 to 200 characters");
  for (const key of ["detail", "impact"]) {
    if (fields[key] === undefined) continue;
    event[key] = text(fields[key], 500);
    if (!event[key]) problems.push(`--${key} must be 1 to 500 characters`);
  }
  const options = fields.options ?? [];
  event.options = options.map((option) => ({ id: option.id?.trim(), label: text(option.label, 40) }));
  if (options.length === 1 || options.length > 3) problems.push("a question has no options or 2 or 3 options");
  if (fields.step !== undefined) {
    if (!["connect", "review", "copy", "build", "check", "publish"].includes(fields.step)) problems.push("unknown workflow step");
    else event.step = fields.step;
  }
  for (const option of event.options) {
    if (!isId(option.id)) problems.push(`option id "${option.id}" must be lowercase letters, digits and dashes`);
    if (!option.label) problems.push(`option ${option.id} needs a label of 1 to 40 characters`);
  }
  const ids = event.options.map((option) => option.id);
  if (new Set(ids).size !== ids.length) problems.push("option ids must differ");
  if (fields.recommended !== undefined) {
    event.recommended = fields.recommended;
    if (!ids.includes(fields.recommended)) problems.push("--recommended must be one of the options");
  }
  if (fields.suggestions !== undefined && fields.suggestions.length > 0) {
    event.suggestions = fields.suggestions.map((suggestion) => text(suggestion, 80));
    if (event.suggestions.length > 3) problems.push("at most 3 suggestions");
    if (event.suggestions.some((suggestion) => !suggestion)) problems.push("each suggestion is 1 to 80 characters");
  }
  if (fields.copied !== undefined) {
    event.copied = fields.copied;
    if (!Number.isFinite(fields.copied) || fields.copied < 0 || fields.copied > 100) problems.push("--copied is 0 to 100");
  }
  if (fields.missing !== undefined) {
    event.missing = fields.missing;
    if (fields.missing.length > 40) problems.push("--missing names at most 40 parts");
    if (fields.missing.some((id) => !text(id, 80))) problems.push("each --missing node id is 1 to 80 characters");
  }
  if (fields.form === "copy-gate" && (fields.copied === undefined || fields.missing === undefined)) problems.push("a copy-gate question carries --copied and --missing");
  if (problems.length > 0) return new Error(problems.join("; "));
  return event;
}
