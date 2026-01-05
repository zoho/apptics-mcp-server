/**
 * Main dependency switcher orchestration
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { findPbxprojFile, fileExists } from '../../sdk-integration/ios/utils';
import { detectAppticsDependency } from './detectors';
import { addAppticsPodToPodfile, removeAppticsPodFromPodfile } from './podfileEditor';
import { addAppticsSPMToProject, removeAppticsSPMFromProject } from './spmEditor';
import { createBackups, validateBuildAfterSwitch, generateRollbackInstructions } from './buildValidator';
import type { SwitchParams, SwitchResult, IOSLanguage, TargetSelection } from './types';

const execAsync = promisify(exec);

/**
 * Main function to switch Apptics dependency
 */
export async function switchAppticsDependency(params: SwitchParams): Promise<SwitchResult> {
  const {
    projectPath,
    to,
    targetNames,
    language,
    spmProductName,
    confirmCocoapodsSwitch,
    verbose = false,
    skipBuild = false
  } = params;
  
  const resolvedPath = path.resolve(projectPath);
  const filesChanged: string[] = [];
  
  try {
    // Step 1: Detect current state
    if (verbose) console.error('Detecting current Apptics dependency state...');
    const detection = await detectAppticsDependency(resolvedPath);
    const fromState = detection.state;
    
    // Pre-flight checks
    if (fromState === 'both') {
      throw new Error(
        'Apptics is configured with both SPM and CocoaPods. ' +
        'Please manually remove one before switching. ' +
        'This prevents duplicate linkage issues.'
      );
    }
    
    if (fromState === 'none') {
      throw new Error(
        'Apptics is not currently integrated. ' +
        'Please use the integration tool first to add Apptics, then use this tool to switch dependency managers.'
      );
    }
    
    // Check if already in target state
    const targetState = to === 'spm' ? 'spm' : 'cocoapods';
    if (fromState === targetState) {
      return {
        success: true,
        fromState,
        toState: targetState,
        filesChanged: [],
        message: `Apptics is already using ${to}. No changes needed.`
      };
    }
    
    // Step 2: Resolve target names
    const resolvedTargetNames = await resolveTargetNames(resolvedPath, targetNames);
    if (resolvedTargetNames.length === 0) {
      throw new Error('No valid targets found. Please specify targetNames explicitly.');
    }
    
    // Step 3: Detect or use provided language
    const resolvedLanguage = language || await detectLanguage(resolvedPath);
    
    // Step 4: Create backups
    if (verbose) console.error('Creating backups...');
    const backups = await createBackups(resolvedPath);
    
    // Step 5: Perform switch
    if (to === 'cocoapods') {
      // SPM → CocoaPods
      if (!confirmCocoapodsSwitch) {
        throw new Error(
          'Switching to CocoaPods requires explicit confirmation. ' +
          'SPM is the recommended package manager. ' +
          'Set confirmCocoapodsSwitch: true to proceed.'
        );
      }
      
      if (verbose) console.error('Switching from SPM to CocoaPods...');
      
      // Add Apptics pod to Podfile
      const podfilePath = path.join(resolvedPath, 'Podfile');
      const podfileExists = await fileExists(podfilePath);
      
      if (!podfileExists) {
        // Create basic Podfile structure
        await createBasicPodfile(podfilePath, resolvedTargetNames, resolvedLanguage);
        filesChanged.push(podfilePath);
      } else {
        await addAppticsPodToPodfile(podfilePath, resolvedTargetNames, resolvedLanguage);
        filesChanged.push(podfilePath);
      }
      
      // Run pod install
      if (verbose) console.error('Running pod install...');
      try {
        const cmd = verbose ? 'pod install --verbose' : 'pod install';
        const env = {
          ...process.env,
          LANG: process.env.LANG ?? 'en_US.UTF-8',
          LC_ALL: process.env.LC_ALL ?? 'en_US.UTF-8'
        };
        await execAsync(cmd, { cwd: resolvedPath, env, timeout: 300000 });
      } catch (podError: any) {
        throw new Error(`pod install failed: ${podError.message}. Rollback using backups.`);
      }
      
      // Remove SPM references
      const pbxprojPath = await findPbxprojFile(resolvedPath);
      await removeAppticsSPMFromProject(pbxprojPath, spmProductName);
      filesChanged.push(pbxprojPath);
      
    } else {
      // CocoaPods → SPM
      if (verbose) console.error('Switching from CocoaPods to SPM...');
      
      // Remove Apptics pod from Podfile
      const podfilePath = path.join(resolvedPath, 'Podfile');
      if (await fileExists(podfilePath)) {
        await removeAppticsPodFromPodfile(podfilePath);
        filesChanged.push(podfilePath);
        
        // Run pod install to update Pods project
        if (verbose) console.error('Running pod install to update Pods project...');
        try {
          const cmd = verbose ? 'pod install --verbose' : 'pod install';
          const env = {
            ...process.env,
            LANG: process.env.LANG ?? 'en_US.UTF-8',
            LC_ALL: process.env.LC_ALL ?? 'en_US.UTF-8'
          };
          await execAsync(cmd, { cwd: resolvedPath, env, timeout: 300000 });
        } catch (podError: any) {
          // Continue even if pod install fails - might be okay if no other pods
          if (verbose) console.error(`pod install warning: ${podError.message}`);
        }
      }
      
      // Add SPM package (will add to all specified targets, even if package already exists)
      if (verbose) console.error(`Adding SPM package to targets: ${resolvedTargetNames.join(', ')}`);
      const pbxprojPath = await findPbxprojFile(resolvedPath);
      try {
        await addAppticsSPMToProject(pbxprojPath, resolvedTargetNames, resolvedLanguage, spmProductName);
        filesChanged.push(pbxprojPath);
        if (verbose) console.error('SPM package added successfully');
      } catch (spmError: any) {
        throw new Error(`Failed to add SPM package: ${spmError.message}`);
      }
      
      // Resolve SPM packages
      if (verbose) console.error('Resolving SPM packages...');
      try {
        const xcodeprojName = path.basename(pbxprojPath.replace('/project.pbxproj', ''));
        const resolveCmd = `cd "${resolvedPath}" && xcodebuild -project "${xcodeprojName}" -resolvePackageDependencies 2>&1`;
        await execAsync(resolveCmd, { timeout: 120000 });
      } catch (resolveError: any) {
        // Don't fail on resolution errors - Xcode will resolve on next build
        if (verbose) console.error(`Package resolution warning: ${resolveError.message}`);
      }
    }
    
    // Step 6: Validate build
    if (verbose) console.error('Validating build...');
    const buildValidation = await validateBuildAfterSwitch(resolvedPath, to, skipBuild);
    
    // Step 7: Return success result
    return {
      success: true,
      fromState,
      toState: targetState,
      filesChanged,
      backupPaths: backups,
      buildValidation,
      message: `Successfully switched Apptics from ${fromState} to ${to}.`,
      rollbackInstructions: generateRollbackInstructions(backups)
    };
    
  } catch (error: any) {
    // Return error result with rollback instructions
    const backups = await createBackups(resolvedPath).catch(() => ({}));
    
    return {
      success: false,
      fromState: (await detectAppticsDependency(resolvedPath).catch(() => ({ state: 'none' as const }))).state,
      toState: to,
      filesChanged,
      backupPaths: backups,
      error: error.message || 'Unknown error occurred',
      message: `Failed to switch Apptics dependency: ${error.message}`,
      rollbackInstructions: Object.keys(backups).length > 0 
        ? generateRollbackInstructions(backups)
        : 'No backups available. Please manually restore from version control.'
    };
  }
}

/**
 * Resolve target names from input
 */
async function resolveTargetNames(
  projectPath: string,
  targetNames?: TargetSelection
): Promise<string[]> {
  const pbxprojPath = await findPbxprojFile(projectPath);
  const content = await fs.readFile(pbxprojPath, 'utf-8');
  const targetRegex = /\/\* ([^*]+?) \*\/ = \{\s*isa = PBXNativeTarget;/g;
  const allTargets = new Set<string>();
  let match: RegExpExecArray | null;
  
  while ((match = targetRegex.exec(content)) !== null) {
    if (match[1]) {
      allTargets.add(match[1].trim());
    }
  }
  
  const discoveredTargets = Array.from(allTargets);
  
  if (targetNames === 'all') {
    return discoveredTargets;
  }
  
  if (Array.isArray(targetNames) && targetNames.length > 0) {
    const normalized = targetNames.map(t => t.trim()).filter(t => t.length > 0);
    const matched: string[] = [];
    
    for (const target of normalized) {
      const exactMatch = discoveredTargets.find(dt => dt === target);
      if (exactMatch) {
        matched.push(exactMatch);
      } else {
        const caseInsensitiveMatch = discoveredTargets.find(
          dt => dt.toLowerCase() === target.toLowerCase()
        );
        if (caseInsensitiveMatch) {
          matched.push(caseInsensitiveMatch);
        }
      }
    }
    
    if (matched.length === 0 && discoveredTargets.length > 0) {
      throw new Error(
        `Target(s) not found: ${normalized.join(', ')}. ` +
        `Available targets: ${discoveredTargets.join(', ')}`
      );
    }
    
    return matched.length > 0 ? matched : normalized;
  }
  
  if (typeof targetNames === 'string' && targetNames.length > 0) {
    const exactMatch = discoveredTargets.find(dt => dt === targetNames);
    if (exactMatch) {
      return [exactMatch];
    }
    const caseInsensitiveMatch = discoveredTargets.find(
      dt => dt.toLowerCase() === targetNames.toLowerCase()
    );
    if (caseInsensitiveMatch) {
      return [caseInsensitiveMatch];
    }
    if (discoveredTargets.length > 0) {
      throw new Error(
        `Target not found: ${targetNames}. ` +
        `Available targets: ${discoveredTargets.join(', ')}`
      );
    }
    return [targetNames];
  }
  
  // Default: return all discovered targets
  return discoveredTargets;
}

/**
 * Detect project language
 */
async function detectLanguage(projectPath: string): Promise<IOSLanguage> {
  // Look for Swift files first
  const entries = await fs.readdir(projectPath, { recursive: true, withFileTypes: true }).catch(() => []);
  
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.swift')) {
      return 'swift';
    }
  }
  
  // Look for Objective-C files
  for (const entry of entries) {
    if (entry.isFile() && (entry.name.endsWith('.m') || entry.name.endsWith('.mm'))) {
      return 'objc';
    }
  }
  
  // Default to Swift
  return 'swift';
}

/**
 * Create basic Podfile structure
 */
async function createBasicPodfile(
  podfilePath: string,
  targetNames: string[],
  language: IOSLanguage
): Promise<void> {
  const sdkPod = language === 'swift' ? 'Apptics-Swift' : 'Apptics-SDK';
  const targetBlocks = targetNames.map(target => 
    `target '${target}' do
  use_frameworks!

  pod '${sdkPod}'
end`
  ).join('\n\n');
  
  const podfileContent = `source 'https://github.com/CocoaPods/Specs.git'

platform :ios, '11.0'

${targetBlocks}
`;
  
  await fs.writeFile(podfilePath, podfileContent, 'utf-8');
}

