import { questionEvent } from './questions.mjs';
const steps = ['connect', 'review', 'copy', 'build', 'check', 'publish'];
const statuses = ['active', 'completed', 'failed'];
/** Validate the runner/reporting envelopes before putting them in the durable queue. */
export function validateReport(event) {
  const text = (key, max, empty = false) => {
    if (typeof event[key] !== 'string' || (!empty && !event[key].trim()) || event[key].length > max) throw new Error(`Invalid ${event.kind}.${key}`);
  };
  if (['workflow', 'activity'].includes(event.kind)) {
    const allowed = event.kind === 'activity' ? [...statuses, 'pending', 'blocked'] : statuses;
    if (!steps.includes(event.step) || !allowed.includes(event.status)) throw new Error('Invalid workflow step or status');
    text('reportId', 100); text('revision', 100);
    if (event.kind === 'workflow') text('line', 200);
    else { text('id', 100); text('title', 120); text('detail', 1000, true); }
  }
  if (event.kind === 'question') { const parsed = questionEvent(event); if (parsed instanceof Error) throw parsed; }
  if (event.kind === 'answered') {
    if (!/^q-[a-z0-9-]+$/.test(event.questionId)) throw new Error('Invalid answer question ID');
    if (event.by === 'option') text('option', 40);
    else if (event.by === 'reply') text('text', 500);
    else throw new Error('An answer must be an explicit option or reply');
  }
  const number = (key, { min = 0, max = Infinity, integer = false } = {}) => {
    if (!Number.isFinite(event[key]) || event[key] < min || event[key] > max || (integer && !Number.isInteger(event[key]))) throw new Error(`Invalid ${event.kind}.${key}`);
  };
  const url = (key, max) => { text(key, max); try { new URL(event[key]); } catch { throw new Error(`Invalid ${event.kind}.${key}`); } };
  const rect = value => {
    if (!value || !['x','y','w','h'].every(key => Number.isFinite(value[key])) || value.w < 0 || value.h < 0) throw new Error('Invalid event rectangle');
  };
  if (event.reportId !== undefined) text('reportId', 100);
  if (event.revision !== undefined) text('revision', 100);
  for (const key of ['image', 'diff']) if (event[key] !== undefined) url(key, 500);
  switch (event.kind) {
    case 'workflow': case 'activity': case 'question': case 'answered': break;
    case 'reference': case 'preview':
      url('image', 500); number('width', { min: 1, max: 10000, integer: true }); number('height', { min: 1, max: 40000, integer: true });
      if (event.kind === 'preview') { text('reportId', 100); text('revision', 100); }
      if (event.url !== undefined) url('url', 2000);
      break;
    case 'found':
      text('id', 80); if (event.parent !== null) text('parent', 80); text('raw', 120); rect(event.rect); break;
    case 'named':
      text('id', 80); text('name', 80);
      if (!['section', 'leaf', 'packaging'].includes(event.role)) throw new Error('Invalid named.role');
      if (event.marker !== undefined && (!/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/.test(event.marker) || event.marker.length > 80)) throw new Error('Invalid named.marker');
      break;
    case 'pass':
      text('id', 80); number('pass', { min: 1, max: 100, integer: true });
      if (event.mismatch !== null) number('mismatch', { integer: true }); break;
    case 'matched': text('id', 80); if (event.rect !== undefined) rect(event.rect); break;
    case 'focus': if (event.id !== null) text('id', 80); break;
    case 'queued': text('id', 80); break;
    case 'rebuild': text('id', 80); text('request', 500); break;
    case 'titled': text('title', 80); break;
    case 'connection':
      text('reportId', 100); for (const key of ['laptop', 'team', 'codebase']) text(key, 200, true); break;
    case 'context':
      text('reportId', 100); text('description', 20000, true); text('summary', 20000, true);
      if (!Array.isArray(event.sources) || event.sources.length > 20) throw new Error('Invalid context.sources');
      for (const source of event.sources) {
        if (typeof source.title !== 'string' || source.title.length > 200 || typeof source.url !== 'string' || source.url.length > 2000 || !/^https?:\/\//.test(source.url)) throw new Error('Invalid context source');
        new URL(source.url);
      }
      break;
    case 'phase':
      if (!['awaiting-agent','connecting','sending','waking','attaching','reading','curating','replicating','building','composing','serving','ready','needs-input','failed'].includes(event.phase)) throw new Error('Invalid phase');
      text('line', 200); break;
    default: throw new Error(`Unsupported outbound event: ${event.kind}`);
  }
  return event;
}
