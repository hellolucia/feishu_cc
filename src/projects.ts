import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function resolveWorkspaceDir(): string {
  const raw = process.env.WORKSPACE_DIR ?? '~/workspace';
  return raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
}

function discoverProjects(): Record<string, string> {
  const workspaceDir = resolveWorkspaceDir();
  try {
    return Object.fromEntries(
      fs.readdirSync(workspaceDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => [d.name, path.join(workspaceDir, d.name)]),
    );
  } catch {
    return {};
  }
}

export function getProjects(): Record<string, string> {
  return discoverProjects();
}

export function resolvePath(name: string): string | null {
  if (!name) return null;
  const projects = discoverProjects();
  return projects[name] ?? null;
}

/** 返回默认项目路径，找不到时返回 WORKSPACE_DIR 本身 */
export function getDefaultCwd(): string {
  const defaultProject = process.env.DEFAULT_PROJECT ?? '';
  if (defaultProject) {
    const p = resolvePath(defaultProject);
    if (p) return p;
  }
  return resolveWorkspaceDir();
}
