/**
 * Shared utilities for iOS SDK integration
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import xcode from 'xcode';

export interface ParsedXcodeProject {
  project: any;
  objects: any;
  save(): Promise<void>;
}

/**
 * Generate a 24-character hex ID for Xcode project entries
 */
export function genId(): string {
  return Array.from({ length: 24 }, () => 
    '0123456789ABCDEF'[Math.floor(Math.random() * 16)]
  ).join('');
}

/**
 * Find the project.pbxproj file in the given project path
 */
export async function findPbxprojFile(projectPath: string): Promise<string> {
  // Check if projectPath is already pointing to project.pbxproj
  if (projectPath.endsWith('project.pbxproj')) {
    const stats = await fs.stat(projectPath).catch(() => null);
    if (stats?.isFile()) {
      return projectPath;
    }
  }
  
  // Check if projectPath is already a .xcodeproj directory
  if (projectPath.endsWith('.xcodeproj')) {
    const pbxprojPath = path.join(projectPath, 'project.pbxproj');
    const stats = await fs.stat(pbxprojPath).catch(() => null);
    if (stats?.isFile()) {
      return pbxprojPath;
    }
    // If it's a .xcodeproj directory but project.pbxproj doesn't exist, go up one level
    projectPath = path.dirname(projectPath);
  }
  
  const entries = await fs.readdir(projectPath);
  const xcodeproj = entries.find(f => f.endsWith('.xcodeproj'));
  
  if (!xcodeproj) {
    throw new Error(`No .xcodeproj found under ${projectPath}`);
  }
  
  return path.join(projectPath, xcodeproj, 'project.pbxproj');
}

/**
 * Check if a file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Open and parse an Xcode project file
 */
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

/**
 * Get native targets from an Xcode project
 */
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

