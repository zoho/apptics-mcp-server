/**
 * Build validator and backup utilities
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { findPbxprojFile, fileExists } from '../../sdk-integration/ios/utils';
import type { BackupPaths, BuildValidationResult } from './types';

const execAsync = promisify(exec);

/**
 * Create backups of Podfile and project.pbxproj
 */
export async function createBackups(projectPath: string): Promise<BackupPaths> {
  const resolvedPath = path.resolve(projectPath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const backups: BackupPaths = {};
  
  // Backup Podfile
  const podfilePath = path.join(resolvedPath, 'Podfile');
  if (await fileExists(podfilePath)) {
    const backupPath = `${podfilePath}.backup.${timestamp}`;
    await fs.copyFile(podfilePath, backupPath);
    backups.podfile = backupPath;
  }
  
  // Backup project.pbxproj
  try {
    const pbxprojPath = await findPbxprojFile(resolvedPath);
    const backupPath = `${pbxprojPath}.backup.${timestamp}`;
    await fs.copyFile(pbxprojPath, backupPath);
    backups.pbxproj = backupPath;
  } catch (error) {
    // pbxproj not found - that's okay, just skip backup
  }
  
  return backups;
}

/**
 * Validate build after switching
 */
export async function validateBuildAfterSwitch(
  projectPath: string,
  switchedTo: 'spm' | 'cocoapods',
  skipBuild?: boolean
): Promise<BuildValidationResult> {
  if (skipBuild) {
    return {
      valid: true,
      warnings: ['Build validation skipped']
    };
  }
  
  const resolvedPath = path.resolve(projectPath);
  const errors: string[] = [];
  const warnings: string[] = [];
  let buildCommand: string | undefined;
  
  try {
    // Determine which file to use for build
    let buildFile: string;
    
    if (switchedTo === 'cocoapods') {
      // Look for .xcworkspace
      const entries = await fs.readdir(resolvedPath);
      const workspace = entries.find(e => e.endsWith('.xcworkspace'));
      if (workspace) {
        buildFile = path.join(resolvedPath, workspace);
        buildCommand = `xcodebuild -workspace "${workspace}" -list`;
      } else {
        warnings.push('No .xcworkspace found - CocoaPods may not be properly installed. Run "pod install".');
        // Fall back to .xcodeproj
        const xcodeproj = entries.find(e => e.endsWith('.xcodeproj'));
        if (xcodeproj) {
          buildFile = path.join(resolvedPath, xcodeproj);
          buildCommand = `xcodebuild -project "${xcodeproj}" -list`;
        } else {
          errors.push('No .xcodeproj or .xcworkspace found');
          return { valid: false, errors, warnings: warnings.length > 0 ? warnings : undefined, buildCommand };
        }
      }
    } else {
      // SPM - use .xcodeproj
      const entries = await fs.readdir(resolvedPath);
      const xcodeproj = entries.find(e => e.endsWith('.xcodeproj'));
      if (xcodeproj) {
        buildFile = path.join(resolvedPath, xcodeproj);
        buildCommand = `xcodebuild -project "${xcodeproj}" -list`;
      } else {
        errors.push('No .xcodeproj found');
        return { valid: false, errors, warnings: warnings.length > 0 ? warnings : undefined, buildCommand };
      }
    }
    
    // Run xcodebuild -list to verify project structure
    try {
      const { stdout, stderr } = await execAsync(
        `cd "${resolvedPath}" && ${buildCommand}`,
        { timeout: 30000 }
      );
      
      if (stderr && !stdout) {
        warnings.push(`xcodebuild -list produced warnings: ${stderr.slice(0, 200)}`);
      }
      
      // For SPM, also try to resolve packages
      if (switchedTo === 'spm') {
        try {
          const xcodeprojName = path.basename(buildFile);
          const resolveCmd = `cd "${resolvedPath}" && xcodebuild -project "${xcodeprojName}" -resolvePackageDependencies 2>&1`;
          await execAsync(resolveCmd, { timeout: 60000 });
        } catch (resolveError: any) {
          warnings.push(`Package resolution warning: ${resolveError.message?.slice(0, 200) || 'Unknown error'}`);
          // Don't fail validation for package resolution issues
        }
      }
      
      return {
        valid: true,
        warnings: warnings.length > 0 ? warnings : undefined,
        buildCommand: buildCommand
      };
    } catch (buildError: any) {
      errors.push(`Build validation failed: ${buildError.message?.slice(0, 300) || 'Unknown error'}`);
      return { valid: false, errors, warnings: warnings.length > 0 ? warnings : undefined, buildCommand };
    }
  } catch (error: any) {
    errors.push(`Validation error: ${error.message || 'Unknown error'}`);
    return { valid: false, errors, warnings: warnings.length > 0 ? warnings : undefined };
  }
}

/**
 * Generate rollback instructions
 */
export function generateRollbackInstructions(backups: BackupPaths): string {
  const instructions: string[] = [];
  
  instructions.push('To rollback the dependency switch:');
  
  if (backups.podfile) {
    instructions.push(`1. Restore Podfile: cp "${backups.podfile}" "${backups.podfile.replace(/\.backup\.[^/]+$/, '')}"`);
  }
  
  if (backups.pbxproj) {
    instructions.push(`2. Restore project.pbxproj: cp "${backups.pbxproj}" "${backups.pbxproj.replace(/\.backup\.[^/]+$/, '')}"`);
  }
  
  if (backups.podfile) {
    instructions.push('3. Run: pod install');
  }
  
  instructions.push('4. Open the project in Xcode and verify it builds correctly');
  
  return instructions.join('\n');
}

