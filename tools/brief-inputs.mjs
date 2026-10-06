/** Read the canonical saved-request contract; retired scalar columns are not inputs. */
export function readBriefInputs(brief) {
  const inputs = brief?.inputs;
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new Error('This saved request is missing its inputs object. Verify the Proto app migration before resuming this brief.');
  }
  if (typeof inputs.description !== 'string' || typeof inputs.useRealData !== 'boolean') {
    throw new Error('Invalid brief.inputs: description must be text and useRealData must be a boolean.');
  }
  for (const key of ['documentUrl', 'referenceUrl', 'referenceImage', 'referenceHtml']) {
    if (inputs[key] !== null && typeof inputs[key] !== 'string') {
      throw new Error(`Invalid brief.inputs.${key}: expected text or null.`);
    }
  }
  return inputs;
}
