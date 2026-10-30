import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
/** A live owner is never evicted because a long build exceeded a timeout. */
export function assertMaintenanceAvailable(runDir) {
  let pid;
  try { pid = Number(readFileSync(join(runDir, 'maintenance.lock', 'pid'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && !existsSync(join(runDir, 'maintenance.lock'))) return; throw error; }
  if (!Number.isInteger(pid) || pid < 1) throw new Error('Prototype maintenance lock is incomplete. Retry shortly.');
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
  if (process.env.PROTO_MAINTENANCE_PID === String(pid)) return;
  throw new Error('This prototype is being updated. Try again when the update finishes.');
}
