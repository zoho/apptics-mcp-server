/**
 * Main dependency switcher orchestration
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { findPbxprojFile, fileExists } from '../../sdk-integration/ios/utils';
import { openProject, getNativeTargets } from './xcodeProject';
import { detectAppticsDependency } from './detectors';
import { addAppticsPodToPodfile, removeAppticsPodFromPodfile } from './podfileEditor';
import { addAppticsSPMToProject, removeAppticsSPMFromProject } from './spmEditor';
import { createBackups, validateBuildAfterSwitch, generateRollbackInstructions, cleanupBackups } from './buildValidator';
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
    confirmSpmSwitch,
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
      if (verbose) {
        console.error('Warning: Both SPM and CocoaPods detected. Will clean up and switch to target dependency manager.');
      }
      // Don't fail - proceed with switch and clean up conflicting state
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
      if (verbose) console.error('Switching from SPM to CocoaPods...');
      
      // Add Apptics pod to Podfile
      const podfilePath = path.join(resolvedPath, 'Podfile');
        await addAppticsPodToPodfile(podfilePath, resolvedTargetNames, resolvedLanguage);
        filesChanged.push(podfilePath);
      
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
      if (fromState === 'cocoapods' && !confirmSpmSwitch) {
        return {
          success: false,
          fromState,
          toState: targetState,
          filesChanged,
          message: 'SPM is recommended. Do you want to switch Apptics to SPM? Reply with confirmSpmSwitch: true (yes) to proceed.',
          needsConfirmation: true,
          rollbackInstructions: 'No changes made. Re-run with confirmSpmSwitch: true to proceed.'
        };
      }
      if (verbose) console.error('Switching from CocoaPods to SPM...');
      
      // Remove Apptics pod from Podfile
      const podfilePath = path.join(resolvedPath, 'Podfile');
      if (await fileExists(podfilePath)) {
        await removeAppticsPodFromPodfile(podfilePath);
        filesChanged.push(podfilePath);
        
        // Run pod install to clean up Pods folder (remove Apptics pods)
        if (verbose) console.error('Running pod install to clean up Pods folder...');
        try {
          const cmd = verbose ? 'pod install --verbose' : 'pod install';
          const env = {
            ...process.env,
            LANG: process.env.LANG ?? 'en_US.UTF-8',
            LC_ALL: process.env.LC_ALL ?? 'en_US.UTF-8'
          };
          await execAsync(cmd, { cwd: resolvedPath, env, timeout: 300000 });
          if (verbose) console.error('✓ Pods folder cleaned up');
        } catch (podError: any) {
          // If no other pods remain, Podfile will be empty and pod install may fail
          // In that case, manually remove Pods folder and Podfile.lock
          if (verbose) console.error(`Pod install failed (might be okay if no other pods): ${podError.message}`);
          
          // Check if Podfile has any remaining dependencies
          try {
            const content = await fs.readFile(podfilePath, 'utf-8');
            const hasDeps = /pod\s+['"]/.test(content);
            if (!hasDeps) {
              // No dependencies left - safe to remove Pods folder
              if (verbose) console.error('No pods remaining, cleaning up Pods folder...');
              const podsDir = path.join(resolvedPath, 'Pods');
              const podfileLock = path.join(resolvedPath, 'Podfile.lock');
              const workspace = path.join(resolvedPath, path.basename(resolvedPath) + '.xcworkspace');
              
              if (await fileExists(podsDir)) {
                await fs.rm(podsDir, { recursive: true, force: true });
              }
              if (await fileExists(podfileLock)) {
                await fs.unlink(podfileLock);
              }
              // Keep workspace but remove Pods reference (Xcode will ignore it)
            }
          } catch {
            // Ignore cleanup errors
          }
        }
      }
      
      // Remove CocoaPods artifacts first
      const pbxprojPath = await findPbxprojFile(resolvedPath);
      if (verbose) console.error('Removing CocoaPods artifacts...');
      await removeCocoaPodsScriptPhases(pbxprojPath, resolvedTargetNames);
      await removeCocoaPodsArtifacts(pbxprojPath, resolvedTargetNames);
      
      // Add SPM package (will add to all specified targets, even if package already exists)
      if (verbose) console.error(`Adding SPM package to targets: ${resolvedTargetNames.join(', ')}`);
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
    
    // Step 7: Clean up backups on success
    await cleanupBackups(backups);
    
    // Step 8: Return success result
    return {
      success: true,
      fromState,
      toState: targetState,
      filesChanged,
      message: `Successfully switched Apptics from ${fromState} to ${to}.`,
      buildValidation
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
  const parsed = await openProject(pbxprojPath);
  const discoveredTargets = getNativeTargets(parsed.project).map((t) => t.name);
  
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

async function removeCocoaPodsScriptPhases(pbxprojPath: string, targetNames: string[]): Promise<void> {
  try {
    const parsed = await openProject(pbxprojPath);
    const objects = parsed.objects;
    const targets = getNativeTargets(parsed.project);
    
    const scriptSection = objects.PBXShellScriptBuildPhase ?? {};
    const cocoaPodsPhaseIds: string[] = [];
    
    Object.entries(scriptSection).forEach(([key, value]) => {
      if (key.endsWith('_comment')) return;
      const phase: any = value;
      const name = (phase.name ?? '').toString();
      const nameLower = name.toLowerCase();
      // Remove CocoaPods-generated phases like "[CP] Embed Pods Frameworks", "[CP] Check Pods Manifest.lock"
      if (nameLower.startsWith('[cp]') || nameLower.includes('[cp]') || 
          (nameLower.includes('pods') && (nameLower.includes('framework') || nameLower.includes('manifest')))) {
        cocoaPodsPhaseIds.push(key);
      }
    });
    
    for (const targetName of targetNames) {
      const target = targets.find((t) => t.name === targetName);
      if (!target) continue;
      
      const buildPhases: Array<{ value: string; comment?: string }> =
        (target.target.buildPhases as Array<{ value: string; comment?: string }>) ?? [];
      target.target.buildPhases = buildPhases.filter((bp) => !cocoaPodsPhaseIds.includes(bp.value));
    }
    
    // Remove the phase objects themselves
    for (const phaseId of cocoaPodsPhaseIds) {
      delete scriptSection[phaseId];
      delete scriptSection[`${phaseId}_comment`];
    }
    
    await parsed.save();
  } catch (error: any) {
    // Don't fail the switch if cleanup fails
    console.error(`Warning: Failed to remove CocoaPods script phases: ${error.message}`);
  }
}
async function removeCocoaPodsArtifacts(pbxprojPath: string, targetNames: string[]): Promise<void> {
  try {
    const parsed = await openProject(pbxprojPath);
    const objects = parsed.objects;
    const targets = getNativeTargets(parsed.project);
    
    // Remove xcconfig references from build configurations
    const configSection = objects.XCBuildConfiguration ?? {};
    Object.entries(configSection).forEach(([key, value]) => {
      if (key.endsWith('_comment')) return;
      const config: any = value;
      if (config.baseConfigurationReference) {
        delete config.baseConfigurationReference;
      }
    });
    
    // Remove Pods framework references from Frameworks build phase
    for (const targetName of targetNames) {
      const target = targets.find((t) => t.name === targetName);
      if (!target) continue;
      
      const frameworks = objects.PBXFrameworksBuildPhase ?? {};
      const frameworksPhases: Array<{ value: string; comment?: string }> =
        (target.target.buildPhases as Array<{ value: string; comment?: string }>) ?? [];
      
      for (const phaseRef of frameworksPhases) {
        const phase = frameworks[phaseRef.value];
        if (!phase) continue;
        const files: Array<{ value: string; comment?: string }> = phase.files ?? [];
        phase.files = files.filter((f) => {
          const comment = (f.comment ?? '').toString().toLowerCase();
          return !comment.includes('pods_');
        });
      }
    }
    
    await parsed.save();
  } catch (error: any) {
    console.error(`Warning: Failed to remove CocoaPods artifacts: ${error.message}`);
  }
}
