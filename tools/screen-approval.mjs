import { callTool } from "./mcp-call.mjs";
export async function requireScreenApproval(
  codebase,
  screenIndex,
  invoke = callTool,
) {
  const result = await invoke("screen_index", {
    operation: "replication-check",
    codebase,
    ...screenIndex,
  });
  const text = result.content
    ?.filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  if (result.isError) throw new Error(text || "Screen approval check failed.");
  const approval = JSON.parse(text);
  if (
    approval.approved !== true ||
    approval.indexId !== screenIndex.indexId ||
    approval.version !== screenIndex.version ||
    approval.entryId !== screenIndex.entryId
  )
    throw new Error("Screen inventory approval does not match this work.");
}
