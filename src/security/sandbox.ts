import { execSync } from 'child_process';
import * as os from 'os';

export interface SandboxConfig {
  enabled: boolean;
  allowedPaths: string[];
  allowedDomains: string[];
}

let sandboxAvailable: boolean | null = null;

export function isSandboxAvailable(): boolean {
  if (sandboxAvailable !== null) return sandboxAvailable;

  const platform = os.platform();

  const checkCmd = platform === 'win32' ? 'where' : 'which';

  if (platform === 'darwin') {
    // Check for sandbox-exec (macOS Seatbelt)
    try {
      execSync(`${checkCmd} sandbox-exec`, { stdio: 'pipe' });
      sandboxAvailable = true;
    } catch {
      sandboxAvailable = false;
    }
  } else if (platform === 'linux') {
    // Check for bubblewrap
    try {
      execSync(`${checkCmd} bwrap`, { stdio: 'pipe' });
      sandboxAvailable = true;
    } catch {
      sandboxAvailable = false;
    }
  } else {
    // Windows: no sandbox support yet
    sandboxAvailable = false;
  }

  return sandboxAvailable;
}

export function wrapCommand(command: string, config: SandboxConfig): string {
  if (!config.enabled || !isSandboxAvailable()) {
    return command;
  }

  const platform = os.platform();

  if (platform === 'darwin') {
    return wrapWithSeatbelt(command, config);
  } else if (platform === 'linux') {
    return wrapWithBubblewrap(command, config);
  }

  return command;
}

function wrapWithSeatbelt(command: string, config: SandboxConfig): string {
  const cwd = process.cwd();
  const home = process.env['HOME'] || process.env['USERPROFILE'] || '~';

  // Build sandbox profile
  const profile = [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    // Read access to system paths
    '(allow file-read* (subpath "/usr"))',
    '(allow file-read* (subpath "/bin"))',
    '(allow file-read* (subpath "/sbin"))',
    '(allow file-read* (subpath "/Library"))',
    '(allow file-read* (subpath "/System"))',
    '(allow file-read* (subpath "/private/tmp"))',
    '(allow file-read* (subpath "/dev"))',
    // Read+write to CWD
    `(allow file-read* (subpath "${cwd}"))`,
    `(allow file-write* (subpath "${cwd}"))`,
    // Read access to home dir essentials
    `(allow file-read* (subpath "${home}/.node"))`,
    `(allow file-read* (subpath "${home}/.npm"))`,
    `(allow file-read* (subpath "${home}/.nvm"))`,
    `(allow file-read* (subpath "${home}/.codi"))`,
    // Network (allow for now, can restrict later)
    '(allow network*)',
  ];

  // Additional allowed paths
  for (const p of config.allowedPaths) {
    profile.push(`(allow file-read* (subpath "${p}"))`);
    profile.push(`(allow file-write* (subpath "${p}"))`);
  }

  const profileStr = profile.join('\n');
  const escaped = command.replace(/'/g, "'\\''");
  return `sandbox-exec -p '${profileStr}' /bin/bash -c '${escaped}'`;
}

function wrapWithBubblewrap(command: string, config: SandboxConfig): string {
  const cwd = process.cwd();
  const home = process.env['HOME'] || process.env['USERPROFILE'] || '~';

  const args = [
    'bwrap',
    '--ro-bind /usr /usr',
    '--ro-bind /bin /bin',
    '--ro-bind /lib /lib',
    '--ro-bind /lib64 /lib64 2>/dev/null',
    '--ro-bind /etc /etc',
    '--proc /proc',
    '--dev /dev',
    '--tmpfs /tmp',
    `--bind ${cwd} ${cwd}`,
    `--ro-bind ${home}/.node ${home}/.node 2>/dev/null`,
    `--ro-bind ${home}/.npm ${home}/.npm 2>/dev/null`,
    `--bind ${home}/.codi ${home}/.codi 2>/dev/null`,
    '--unshare-user',
    '--die-with-parent',
    `--chdir ${cwd}`,
  ];

  for (const p of config.allowedPaths) {
    args.push(`--bind ${p} ${p}`);
  }

  args.push('--', '/bin/bash', '-c', `"${command.replace(/"/g, '\\"')}"`);

  return args.join(' ');
}
