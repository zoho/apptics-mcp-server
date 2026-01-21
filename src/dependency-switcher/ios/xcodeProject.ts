import * as fs from 'fs/promises';
import xcode from 'xcode';

export interface ParsedXcodeProject {
  project: any;
  objects: any;
  save(): Promise<void>;
}

export async function openProject(pbxprojPath: string): Promise<ParsedXcodeProject> {
  const project = xcode.project(pbxprojPath);

  await new Promise<void>((resolve, reject) => {
    project.parse((err: unknown) => {
      if (err) {
        reject(err instanceof Error ? err : new Error('Failed to parse Xcode project'));
        return;
      }
      resolve();
    });
  });

  const objects = project.hash.project.objects;

  return {
    project,
    objects,
    async save() {
      const serialized = project.writeSync();
      await fs.writeFile(pbxprojPath, serialized, 'utf-8');
    }
  };
}

export function getNativeTargets(project: any): Array<{ id: string; name: string; target: any }> {
  const section = project.pbxNativeTargetSection();
  const results: Array<{ id: string; name: string; target: any }> = [];

  Object.entries(section).forEach(([key, value]) => {
    if (!key.endsWith('_comment') && value && typeof value === 'object') {
      const target: any = value;
      const name = target.name ?? target.productName;
      if (typeof name === 'string' && name.length > 0) {
        results.push({ id: key, name, target });
      }
    }
  });

  return results;
}
