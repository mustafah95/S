import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { publish } from '../lib/events.js';

const run = promisify(execFile);

/** Restarts the application services after an update or on request from the Update Center. */
export interface ServiceController {
  kind: string;
  restart(services: ('api' | 'worker')[]): Promise<void>;
}

const serviceName = (s: 'api' | 'worker') =>
  config.serviceNames.find((n) => n.toLowerCase().includes(s)) ?? (s === 'api' ? 'SofiaAPI' : 'SofiaWorker');

export function createController(kind = config.serviceController): ServiceController {
  switch (kind) {
    case 'windows':
      return {
        kind,
        async restart(services) {
          for (const s of services) {
            await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Restart-Service -Name '${serviceName(s)}' -Force`], { windowsHide: true });
          }
        },
      };
    case 'systemd':
      return {
        kind,
        async restart(services) {
          for (const s of services) await run('systemctl', ['restart', serviceName(s)]);
        },
      };
    case 'launcher':
      // Docker and the Windows/Linux launcher: the process exits on request and the launcher (or Docker's restart
      // policy) starts it again from the release that current.json now points to.
      return {
        kind,
        async restart(services) {
          for (const s of services) await publish({ type: 'control', action: 'restart', target: s });
        },
      };
    default:
      return { kind: 'none', async restart() {} };
  }
}
