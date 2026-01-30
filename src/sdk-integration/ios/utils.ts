/**
 * Shared utilities for iOS SDK integration
 */

import * as fs from 'fs/promises';
import * as path from 'path';

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


