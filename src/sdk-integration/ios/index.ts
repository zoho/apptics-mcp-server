import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  addAppticsConfigFile,
  addAppticsManagerWrapper,
  APPTICS_MANAGER_SUGGESTION_SNIPPET,
  setupMultiEnvironmentConfig
} from './configFile';
import { createOrUpdatePodfile, runPodInstall } from './cocoapodsIntegration';
import {
  addBuildScriptPhaseWithParser,
  buildSPMScriptCommand,
  disableUserScriptSandboxing,
  repairLegacyAppticsScriptNames
} from './buildScriptPhase';
import { addAppticsImport, addAppticsInitialization } from './entryInjection';
import {
  MIN_COCOAPODS_VERSION,
  MIN_IOS_DEPLOYMENT_TARGET,
  MIN_SWIFT_VERSION,
  MIN_XCODE_VERSION,
  AppticsInitConfig,
  AppEntryPoint,
  ensureTargetHasProductDependency,
  assertTargetHasProductDependency,
  isVersionAtLeast,
  normalizeTargets,
  resolveEntryFileForTarget
} from './pbxprojUtils';
import { addSPMPackage } from './spmIntegration';
import { fileExists, findPbxprojFile, openProject, getNativeTargets } from './utils';
import { readPodfileJSON } from '../../dependency-switcher/ios/podfileEditor';
import { generateFailureReport, formatFailureReport } from './errorReporter';
import { getBuildSettings, getToolVersions } from './xcodeProjectParser';
import {
  getInstalledOptionalModuleIdsForCocoaPods,
  getSPMCoreProductName,
  getSPMProductNamesForTarget
} from './appticsOptionalModules';
import { parseSwiftFile } from './swiftParser';

/** Directories to skip when scanning project for Apptics init (avoid Pods, build, etc.) */
const SCAN_SKIP_DIRS = new Set([
  'Pods', 'build', '.build', 'DerivedData', 'node_modules',
  '.git', '.svn', 'Carthage', '.xcodeproj', '.xcworkspace'
]);

/**
 * Scans the project for Swift (and optionally Obj-C) files that contain
 * Apptics.initialize (direct init) or AppticsManager.shared.configure (manager init).
 * Used to detect init in helper files called from AppDelegate/main.
 */
async function scanProjectForAppticsInit(
  projectPath: string,
  language: 'swift' | 'objc'
): Promise<{ hasDirectInit: boolean; hasManagerInit: boolean }> {
  const result = { hasDirectInit: false, hasManagerInit: false };
  const maxFiles = 500;
  let filesChecked = 0;

  async function walk(dir: string): Promise<void> {
    if (result.hasDirectInit && result.hasManagerInit) return;
    if (filesChecked >= maxFiles) return;
    let entries: { name: string; isDirectory: boolean }[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true }).then(dirs =>
        dirs.map(d => ({ name: d.name, isDirectory: d.isDirectory() }))
      );
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory) {
        if (SCAN_SKIP_DIRS.has(e.name)) continue;
        await walk(path.join(dir, e.name));
      } else if (e.name.endsWith('.swift') || (language === 'objc' && (e.name.endsWith('.m') || e.name.endsWith('.mm')))) {
        if (filesChecked >= maxFiles) return;
        filesChecked++;
        try {
          const content = await fs.readFile(path.join(dir, e.name), 'utf-8');
          if (!result.hasDirectInit && (content.includes('Apptics.initialize') || content.includes('[Apptics initialize'))) {
            result.hasDirectInit = true;
          }
          if (!result.hasManagerInit && (content.includes('AppticsManager.shared.configure') || content.includes('AppticsManager.shared.initialize'))) {
            result.hasManagerInit = true;
          }
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  await walk(projectPath);
  return result;
}

const execAsync = promisify(exec);

/**
 * Generate helpful installation instructions for missing prerequisites
 */
function generateInstallationInstructions(
  prereqResult: Awaited<ReturnType<typeof checkIOSPrerequisites>>,
  packageManager: 'cocoapods' | 'spm'
): string {
  const instructions: string[] = [];
  
  // Check for missing Xcode
  if (prereqResult.xcodeVersion === '' || prereqResult.xcodeVersion === 'Unknown') {
    instructions.push(
      '📦 Xcode Installation:\n' +
      '   - Download from the Mac App Store: https://apps.apple.com/app/xcode/id497799835\n' +
      '   - Or install via command line: xcode-select --install\n' +
      '   - After installation, accept the license: sudo xcodebuild -license accept'
    );
  } else if (!isVersionAtLeast(prereqResult.xcodeVersion, MIN_XCODE_VERSION)) {
    instructions.push(
      `📦 Xcode Update Required:\n` +
      `   - Current version: ${prereqResult.xcodeVersion}\n` +
      `   - Required: ${MIN_XCODE_VERSION} or later\n` +
      `   - Update from the Mac App Store or download from: https://developer.apple.com/xcode/`
    );
  }
  
  // Check for missing CocoaPods (only if using CocoaPods)
  if (packageManager === 'cocoapods') {
    if (prereqResult.cocoapodsVersion === '' || prereqResult.cocoapodsVersion === 'Unknown') {
      instructions.push(
        '📦 CocoaPods Installation:\n' +
        '   - Install via RubyGems: sudo gem install cocoapods\n' +
        '   - Or use Homebrew: brew install cocoapods\n' +
        '   - Verify installation: pod --version'
      );
    } else if (!isVersionAtLeast(prereqResult.cocoapodsVersion, MIN_COCOAPODS_VERSION)) {
      instructions.push(
        `📦 CocoaPods Update Required:\n` +
        `   - Current version: ${prereqResult.cocoapodsVersion}\n` +
        `   - Required: ${MIN_COCOAPODS_VERSION} or later\n` +
        `   - Update: sudo gem install cocoapods`
      );
    }
  }
  
  // Check for iOS deployment target
  if (prereqResult.iosTargetVersion !== 'Unknown' && 
      !isVersionAtLeast(prereqResult.iosTargetVersion, MIN_IOS_DEPLOYMENT_TARGET)) {
    instructions.push(
      `📦 iOS Deployment Target Update Required:\n` +
      `   - Current target: iOS ${prereqResult.iosTargetVersion}\n` +
      `   - Required: iOS ${MIN_IOS_DEPLOYMENT_TARGET} or later\n` +
      `   - Update in Xcode: Project Settings → Deployment Info → iOS Deployment Target`
    );
  }
  
  // Check for Swift version
  if (prereqResult.swiftVersion && 
      !isVersionAtLeast(prereqResult.swiftVersion, MIN_SWIFT_VERSION)) {
    instructions.push(
      `📦 Swift Version Update Required:\n` +
      `   - Current version: Swift ${prereqResult.swiftVersion}\n` +
      `   - Required: Swift ${MIN_SWIFT_VERSION} or later\n` +
      `   - Update in Xcode: Project Settings → Build Settings → Swift Language Version\n` +
      `   - Or update Xcode (newer Xcode versions include newer Swift)`
    );
  }
  
  if (instructions.length === 0) {
    return 'Please install the missing prerequisites listed above.';
  }
  
  return 'Installation Instructions:\n\n' + instructions.join('\n\n');
}

export class BuildVerificationError extends Error {
  public readonly isBuildVerificationError = true;
  public readonly buildOutput: string | undefined;

  constructor(message: string, buildOutput?: string) {
    super(message);
    this.name = 'BuildVerificationError';
    this.buildOutput = buildOutput;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, BuildVerificationError);
    }
  }
}

export async function checkIOSPrerequisites(projectPath: string, packageManager: 'cocoapods' | 'spm' = 'spm') {
  const results = {
    xcodeVersion: '',
    cocoapodsVersion: '',
    iosTargetVersion: '',
    swiftVersion: '',
    missingRequirements: [] as string[],
    allPrerequisitesMet: false
  };

  try {
    const toolVersions = await getToolVersions();
    results.xcodeVersion = toolVersions.xcodeVersion || 'Unknown';
    results.cocoapodsVersion = toolVersions.cocoapodsVersion || 'Unknown';
    
    if (results.xcodeVersion !== 'Unknown' && !isVersionAtLeast(results.xcodeVersion, MIN_XCODE_VERSION)) {
      results.missingRequirements.push(`Xcode ${MIN_XCODE_VERSION} or later required`);
    } else if (results.xcodeVersion === 'Unknown' || !results.xcodeVersion) {
      results.missingRequirements.push(`Xcode ${MIN_XCODE_VERSION} or later required (not found)`);
      results.xcodeVersion = '';
    }

    if (packageManager === 'cocoapods') {
      if (results.cocoapodsVersion !== 'Unknown' && !isVersionAtLeast(results.cocoapodsVersion, MIN_COCOAPODS_VERSION)) {
        results.missingRequirements.push(`CocoaPods ${MIN_COCOAPODS_VERSION} or later required`);
      } else if (results.cocoapodsVersion === 'Unknown' || !results.cocoapodsVersion) {
        results.missingRequirements.push(`CocoaPods ${MIN_COCOAPODS_VERSION} or later required (not found)`);
      }
    }

    const buildSettings = await getBuildSettings(projectPath);
    results.iosTargetVersion = buildSettings.iosDeploymentTarget ?? 'Unknown';
    results.swiftVersion = buildSettings.swiftVersion ?? toolVersions.swiftVersion ?? '';
    
    if (
      results.iosTargetVersion !== 'Unknown' &&
      !isVersionAtLeast(results.iosTargetVersion, MIN_IOS_DEPLOYMENT_TARGET)
    ) {
      results.missingRequirements.push(`iOS ${MIN_IOS_DEPLOYMENT_TARGET} or later target required`);
    }

    if (results.swiftVersion && !isVersionAtLeast(results.swiftVersion, MIN_SWIFT_VERSION)) {
      results.missingRequirements.push(`Swift ${MIN_SWIFT_VERSION} or later required`);
    }

    results.allPrerequisitesMet = results.missingRequirements.length === 0;
    return results;
  } catch (error: any) {
    throw new Error(`Prerequisites check failed: ${error.message}`);
  }
}

/**
 * Build verification runs xcodebuild to ensure the project compiles before/after integration.
 * To avoid creating a "build" folder inside the project:
 * - Prefer -workspace when .xcworkspace exists (e.g. after CocoaPods), so -scheme + -derivedDataPath work.
 * - Otherwise use -project and -scheme with -derivedDataPath.
 * - When falling back to -target we pass SYMROOT/OBJROOT to a temp dir (some projects still write to project/build).
 * - When using -workspace, CocoaPods' Pods.xcodeproj often sets SYMROOT to "${SRCROOT}/../build", so we always
 *   pass SYMROOT and OBJROOT to a temp dir to prevent creating project/build.
 */
export async function verifyProjectBuilds(params: {
  projectPath: string;
  targetName: string;
  verbose?: boolean;
}): Promise<{ success: boolean; message: string; buildOutput?: string }> {
  const { projectPath, targetName, verbose = false } = params;
  
  try {
    if (verbose) console.error('Verifying project builds successfully before integration...');
    
    const pbxprojPath = await findPbxprojFile(projectPath);
    const xcodeprojPath = path.dirname(pbxprojPath);
    const xcodeprojName = path.basename(xcodeprojPath);
    const projectBaseName = xcodeprojName.replace(/\.xcodeproj$/, '');
    const workspacePath = path.join(projectPath, `${projectBaseName}.xcworkspace`);
    const workspaceExists = await fileExists(path.join(workspacePath, 'contents.xcworkspacedata'));
    const derivedDataPath = path.join(os.tmpdir(), `AppticsVerifyBuild-${Date.now()}`);
    const derivedDataArg = `-derivedDataPath "${derivedDataPath}"`;
    const buildDir = path.join(derivedDataPath, 'Build');
    const symrootObjroot = `SYMROOT="${buildDir}" OBJROOT="${path.join(buildDir, 'Intermediates.noindex')}"`;
    const destinationArg = `-destination "generic/platform=iOS"`;
    const schemeBuildArgs = `-scheme "${targetName}" ${destinationArg} -configuration Debug ${derivedDataArg} ${symrootObjroot}`;
    const targetBuildDir = path.join(os.tmpdir(), `AppticsVerifyBuild-${Date.now()}-target`);
    const targetBuildArgs = `-target "${targetName}" ${destinationArg} -configuration Debug SYMROOT="${targetBuildDir}" OBJROOT="${targetBuildDir}"`;

    const buildOpts = 'CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO 2>&1';
    let buildCommand: string;
    if (workspaceExists) {
      buildCommand = `xcodebuild -workspace "${projectBaseName}.xcworkspace" ${schemeBuildArgs} clean build ${buildOpts}`;
    } else {
      buildCommand = `xcodebuild -project "${xcodeprojName}" ${schemeBuildArgs} clean build ${buildOpts}`;
    }
    let buildOutput = '';
    let buildSucceeded = false;
    
    try {
      const { stdout, stderr } = await execAsync(buildCommand, {
        cwd: projectPath,
        maxBuffer: 10 * 1024 * 1024
      });
      
      buildOutput = stdout + stderr;
      buildSucceeded = buildOutput.includes('BUILD SUCCEEDED');
    } catch (error: any) {
      const errMsg = error.message || '';
      const output = (error.stdout || '') + (error.stderr || '');
      if (errMsg.includes('scheme') || output.includes('scheme') || output.includes('derivedDataPath')) {
        if (verbose) console.error('Scheme not found or derivedDataPath not allowed, trying direct target build...');
        // xcodebuild does NOT allow -target with -workspace; must use -project + -target for fallback
        buildCommand = `xcodebuild -project "${xcodeprojName}" ${targetBuildArgs} clean build ${buildOpts}`;
        
        try {
          const { stdout, stderr } = await execAsync(buildCommand, {
            cwd: projectPath,
            maxBuffer: 10 * 1024 * 1024
          });
          
          buildOutput = stdout + stderr;
          buildSucceeded = buildOutput.includes('BUILD SUCCEEDED');
        } catch (targetError: any) {
          buildOutput = (targetError.stdout || '') + (targetError.stderr || '');
        }
      } else {
        buildOutput = (error.stdout || '') + (error.stderr || '');
      }
    }
    
    if (buildSucceeded) {
      if (verbose) console.error('✓ Project builds successfully');
      const result: { success: boolean; message: string; buildOutput?: string } = {
        success: true,
        message: 'Project builds successfully'
      };
      if (verbose) {
        result.buildOutput = buildOutput;
      }
      return result;
    } else {
      const errorLines = buildOutput.split('\n').filter((line: string) => 
        line.includes('error:') || line.includes('ERROR:')
      );
      
      let errorMessage = 'Build failed with errors';
      if (errorLines.length > 0) {
        const meaningfulErrors = errorLines
          .slice(0, 5)
          .map((line: string) => line.trim())
          .filter((line: string) => line.length > 0);
        errorMessage = meaningfulErrors.join('; ');
      } else if (buildOutput.includes('No such scheme') || buildOutput.includes('does not contain a scheme')) {
        errorMessage = `Scheme "${targetName}" not found. Please ensure the scheme exists or specify the correct target name.`;
      } else if (buildOutput.includes('No such target')) {
        errorMessage = `Target "${targetName}" not found. Please ensure the target exists.`;
      }
      
      return {
        success: false,
        message: `Project build failed: ${errorMessage}.`,
        buildOutput: buildOutput
      };
    }
  } catch (error: any) {
    return {
      success: false,
      message: `Failed to verify project build: ${error.message}.`
    };
  }
}

export async function verifyAppticsIntegration(params: {
  projectPath: string;
  entryFilePath: string;
  entryPoint?: AppEntryPoint;
  language: 'swift' | 'objc';
  useManagerWrapper?: boolean;
  packageManager?: 'cocoapods' | 'spm';
  targetName?: string;
  targetNames?: string[];
}) {
  const {
    projectPath,
    entryFilePath,
    entryPoint = 'appDelegate',
    language,
    useManagerWrapper = false,
    packageManager = 'spm',
    targetName,
    targetNames
  } = params;
  
  const checks = {
    packageManagerSetup: false,
    appticsSDKConfigured: false,
    preBuildScriptConfigured: false,
    configFileExists: false,
    userScriptSandboxingDisabled: false,
    appticsImportPresent: false,
    appticsInitialized: false,
    dependenciesInstalled: false
  };

  const targetReports: Record<string, {
    productDependencyLinked?: boolean;
    preBuildScriptPresent?: boolean;
    userScriptSandboxingDisabled?: boolean;
  }> = {};
  const missingSteps: string[] = [];

  try {
    const pbxprojPath = await findPbxprojFile(projectPath);
    const projectWrapper = await openProject(pbxprojPath);
    const objects = projectWrapper.objects;
    const nativeTargets = getNativeTargets(projectWrapper.project);
    const discoveredTargets = nativeTargets.map((t) => t.name);
    const rawTargets = targetNames?.length
      ? Array.from(new Set(targetNames))
      : targetName
        ? [targetName]
        : discoveredTargets;
    const targets = rawTargets.filter((t): t is string => Boolean(t));

    if (packageManager === 'cocoapods') {
      const podfilePath = path.join(projectPath, 'Podfile');
      checks.packageManagerSetup = await fileExists(podfilePath);
      
      if (checks.packageManagerSetup) {
        try {
          const podfileJson = await readPodfileJSON(podfilePath, projectPath);
          const deps: string[] = [];
          const phases: string[] = [];
          const walk = (defs: any[]) => {
            defs.forEach((d) => {
              (d.dependencies ?? []).forEach((dep: any) => {
                if (typeof dep === 'string') deps.push(dep);
                else if (Array.isArray(dep) && dep[0]) deps.push(dep[0]);
                else if (dep && typeof dep === 'object' && dep.name) deps.push(String(dep.name));
              });
              (d.script_phases ?? []).forEach((p: any) => {
                if (p.name) phases.push(String(p.name));
              });
              if (d.children) walk(d.children);
            });
          };
          walk(podfileJson.target_definitions ?? []);
          checks.appticsSDKConfigured = deps.some((d) => d.toLowerCase().startsWith('apptics-'));
          checks.preBuildScriptConfigured = phases.some((p) => p.toLowerCase().includes('apptics pre build'));
        } catch {
          checks.appticsSDKConfigured = false;
          checks.preBuildScriptConfigured = false;
        }
      } else {
        missingSteps.push('Create Podfile with Apptics-SDK');
      }

      const podsPath = path.join(projectPath, 'Pods');
      checks.dependenciesInstalled = await fileExists(podsPath);
      if (!checks.dependenciesInstalled) {
        missingSteps.push('Run pod install');
      }
    } else {

      // SPM verification
      const packageRepositoryURL = 'https://github.com/zoho/Apptics-SP';
      const packageRefs = objects.XCRemoteSwiftPackageReference ?? {};
      const hasPackageRef = Object.values(packageRefs).some((ref: any) => {
        if (!ref || typeof ref !== 'object') return false;
        return String(ref.repositoryURL ?? '') === packageRepositoryURL;
      });
      checks.packageManagerSetup = hasPackageRef;
      checks.appticsSDKConfigured = hasPackageRef;
      const scriptPhases = objects.PBXShellScriptBuildPhase ?? {};
      const hasPreBuild = Object.values(scriptPhases).some((phase: any) => {
        if (!phase || typeof phase !== 'object') return false;
        const name = phase.name ? String(phase.name).toLowerCase() : '';
        return name.includes('apptics pre build');
      });
      checks.preBuildScriptConfigured = hasPreBuild;
      
      if (!checks.packageManagerSetup) {
        missingSteps.push('Add Apptics SPM package to project');
      }
      for (const tgt of targets) {
        const target = nativeTargets.find((t) => t.name === tgt);
        if (!target) {
          missingSteps.push(`Target not found in project: ${tgt}`);
          continue;
        }
        const deps: Array<{ value: string; comment?: string }> =
          (target.target.packageProductDependencies as Array<{ value: string; comment?: string }>) ?? [];
        const productSection = objects.XCSwiftPackageProductDependency ?? {};
        const hasProductDep = deps.some((dep) => {
          const entry = productSection[dep.value];
          const name = entry ? String(entry.productName ?? '').toLowerCase() : '';
          return name === 'appticsanalytics';
        });

        const phases: Array<{ value: string; comment?: string }> =
          (target.target.buildPhases as Array<{ value: string; comment?: string }>) ?? [];
        const hasPreBuildScript = phases.some((p) => {
          const phase = scriptPhases[p.value];
          if (!phase) return false;
          const name = phase.name ? String(phase.name).toLowerCase() : '';
          return name.includes('apptics pre build');
        });

        targetReports[tgt] = {
          productDependencyLinked: hasProductDep,
          preBuildScriptPresent: hasPreBuildScript,
          userScriptSandboxingDisabled: true // sandboxing check handled separately
        };

        if (!hasProductDep) {
          missingSteps.push(`SPM product dependency not linked to target ${tgt}`);
        }
        if (!hasPreBuildScript) {
          missingSteps.push(`Pre-build script not added to target ${tgt}`);
        }
      }
    }

    const configPath = path.join(projectPath, 'apptics-config.plist');
    checks.configFileExists = await fileExists(configPath);
    if (!checks.configFileExists) {
      missingSteps.push('Add apptics-config.plist to project root');
    }

    const buildConfigs = objects.XCBuildConfiguration ?? {};
    checks.userScriptSandboxingDisabled = Object.values(buildConfigs).some((cfg: any) => {
      if (!cfg || typeof cfg !== 'object') return false;
      return cfg.buildSettings?.ENABLE_USER_SCRIPT_SANDBOXING === 'NO';
    });
    if (!checks.userScriptSandboxingDisabled) {
      missingSteps.push('Disable user script sandboxing (ENABLE_USER_SCRIPT_SANDBOXING = NO)');
    }

    const entryContent = await fs.readFile(entryFilePath, 'utf-8');
    
    if (language === 'objc') {
      checks.appticsImportPresent = entryContent.includes('#import <Apptics/Apptics.h>') || 
                                     entryContent.includes('#import "Apptics.h"');
      checks.appticsInitialized = entryContent.includes('[Apptics initializeWithVerbose:') ||
                                   entryContent.includes('[Apptics initialize');
    } else {
      // Swift
      const lines = entryContent.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('import ') && (trimmed.includes('Apptics') || trimmed.includes('AppticsAnalytics'))) {
          checks.appticsImportPresent = true;
        }
        if (trimmed.includes('Apptics.initialize') || 
            trimmed.includes('AppticsManager.shared.configure') ||
            trimmed.includes('AppticsManager.shared.initialize')) {
          checks.appticsInitialized = true;
        }
      }
    }
    
    if (!checks.appticsImportPresent) {
      const target = entryPoint === 'swiftUI' ? 'SwiftUI App file' : 'AppDelegate';
      missingSteps.push(`Add Apptics import to ${target}`);
    }
    if (!checks.appticsInitialized) {
      const target = entryPoint === 'swiftUI'
        ? 'the SwiftUI App init()'
        : 'didFinishLaunchingWithOptions';
      missingSteps.push(`Add Apptics initialization in ${target}`);
    }

    const success = missingSteps.length === 0;

    return {
      success,
      checks,
      targetReports,
      missingSteps,
      message: success 
        ? 'All integration steps completed' 
        : `Missing ${missingSteps.length} step(s)`
    };
  } catch (error: any) {
    throw new Error(`Verification failed: ${error.message}`);
  }
}

async function removeAppticsSPMArtifacts(projectPath: string, targetNames: string[]): Promise<void> {
  const pbxprojPath = await findPbxprojFile(projectPath);
  const parsed = await openProject(pbxprojPath);
  const objects = parsed.objects;

  const productSection = objects.XCSwiftPackageProductDependency ?? {};
  const productIds = Object.entries(productSection)
    .filter(([key, entry]) => {
      if (key.endsWith('_comment')) return false;
      if (!entry || typeof entry !== 'object') return false;
      const name = String((entry as any).productName ?? '').toLowerCase();
      return name === 'appticsanalytics';
    })
    .map(([key]) => key);

  if (productIds.length > 0) {
    const targets = getNativeTargets(parsed.project).filter((t) => targetNames.includes(t.name));
    for (const tgt of targets) {
      const deps: Array<{ value: string; comment?: string }> =
        (tgt.target.packageProductDependencies as Array<{ value: string; comment?: string }>) ?? [];
      tgt.target.packageProductDependencies = deps.filter((dep) => !productIds.includes(dep.value));
    }

    for (const id of productIds) {
      delete productSection[id];
      delete productSection[`${id}_comment`];
    }
  }

  const packageRefs = objects.XCRemoteSwiftPackageReference ?? {};
  const packageRefIds = Object.entries(packageRefs)
    .filter(([key, entry]) => {
      if (key.endsWith('_comment')) return false;
      if (!entry || typeof entry !== 'object') return false;
      const repo = String((entry as any).repositoryURL ?? '').toLowerCase();
      return repo === 'https://github.com/zoho/apptics-sp';
    })
    .map(([key]) => key);

  if (packageRefIds.length > 0) {
    const projectPackageRefs = parsed.project.packageReferences ?? [];
    parsed.project.packageReferences = projectPackageRefs.filter(
      (ref: any) => !packageRefIds.includes(ref.value)
    );
    for (const id of packageRefIds) {
      delete packageRefs[id];
      delete packageRefs[`${id}_comment`];
    }
  }

  await parsed.save();
}

export async function completeIOSIntegration(params: {
  projectPath: string;
  targetName?: string;
  targetNames?: string[];
  language: 'swift' | 'objc';
  configFileSource: string;
  entryFilePath: string;
  entryPoint?: AppEntryPoint;
  packageManager?: 'cocoapods' | 'spm';
  spmProductName?: string;
  /** Optional module ids (e.g. remoteConfig, feedbackKit). Configures dependencies and updates AppticsManager. */
  optionalModuleIds?: string[];
  /** When using notificationServiceExtension, target name(s) of the NSE so the NSE pod is added only to those targets. */
  notificationServiceExtensionTargetNames?: string[];
  /** Extra CocoaPods pod names to add to every main app target (e.g. missing or private pods). */
  additionalCocoaPods?: string[];
  verbose?: boolean;
  config?: any;
  createManagerFile?: boolean;
  managerFilePath?: string;
  overwriteManagerFile?: boolean;
  useManagerWrapper?: boolean;
}) {
  const {
    projectPath,
    targetName,
    targetNames,
    language,
    configFileSource,
    entryFilePath,
    entryPoint = 'appDelegate',
    packageManager = 'spm',
    spmProductName,
    optionalModuleIds,
    notificationServiceExtensionTargetNames,
    additionalCocoaPods = [],
    verbose,
    config,
    createManagerFile,
    managerFilePath,
  overwriteManagerFile = false,
  useManagerWrapper
  } = params;
  const targets = await normalizeTargets(projectPath, targetName, targetNames);
  if (targets.length === 0) {
    throw new Error('No target names provided for integration.');
  }
  /** Only add imports, config, and AppticsManager content for modules whose pods are actually installed (CocoaPods: exclude skipped pods). */
  const optionalIdsForCode =
    packageManager === 'cocoapods' && optionalModuleIds?.length
      ? getInstalledOptionalModuleIdsForCocoaPods(optionalModuleIds)
      : optionalModuleIds ?? [];
  /** SPM core product for main import/manager (AppticsAnalytics or AppticsAnalyticscoreWithKSCrash when crashKit requested). */
  const coreProductName =
    packageManager === 'spm'
      ? (spmProductName ?? getSPMCoreProductName(optionalModuleIds ?? []))
      : spmProductName;
  const shouldCreateManager = createManagerFile !== false; // default: always create unless explicitly disabled
  const managerWrapperFlag = useManagerWrapper ?? shouldCreateManager;

  const stepsCompleted: string[] = [];
  const stepsFailed: string[] = [];
  
  const integrationReport: {
    targets: string[];
    prerequisitesChecked: boolean;
    packageManagerSetup: boolean;
    configFileAdded: boolean;
    sandboxingDisabled: boolean;
    dependenciesInstalled: boolean;
    importAdded: boolean;
    initializationAdded: boolean;
    managerFileAdded: boolean;
    managerWrapperUsed: boolean;
    managerSkippedReason?: string;
    managerSuggestionSnippet?: string;
  } = {
    targets,
    prerequisitesChecked: false,
    packageManagerSetup: false,
    configFileAdded: false,
    sandboxingDisabled: false,
    dependenciesInstalled: false,
    importAdded: false,
    initializationAdded: false,
    managerFileAdded: false,
    managerWrapperUsed: false
  };

  try {
    if (verbose) console.error('Step -1: Repairing any corrupted project file syntax...');
    const repaired = await repairLegacyAppticsScriptNames(projectPath);
    if (repaired) {
      stepsCompleted.push('Repaired project file syntax issues');
    }

    if (verbose) console.error('Step 0: Verifying project builds successfully...');
    for (const tgt of targets) {
      const buildVerification = await verifyProjectBuilds({
        projectPath,
        targetName: tgt,
        ...(verbose !== undefined && { verbose })
      });
      
      if (!buildVerification.success) {
        // Allow a soft pass if the failure is specifically due to missing Apptics
        // modules and the target does not yet link the Apptics package. This lets
        // multi-target projects that only had the manager file linked continue
        // through integration so we can add the package dependency.
        const output = buildVerification.buildOutput ?? buildVerification.message ?? '';
        const missingAppticsModule =
          output.includes("Unable to find module dependency: 'Apptics'") ||
          output.includes("Unable to find module dependency: 'AppticsEventTracker'");
        const missingAppticsManager =
          output.toLowerCase().includes("cannot find 'appticsmanager' in scope") ||
          output.includes("Use of unresolved identifier 'AppticsManager'");

        if (missingAppticsModule || missingAppticsManager) {
          stepsCompleted.push(
            `Build verification skipped for ${tgt} (missing Apptics dependencies pre-integration); proceeding to add package.`
          );
          continue;
        }

        stepsFailed.push(`Build verification failed for ${tgt}: ${buildVerification.message}`);
        throw new BuildVerificationError(
          `SDK integration stopped because the project build failed for target ${tgt}.\n\n${buildVerification.message}` +
          (buildVerification.buildOutput && verbose
            ? `\n\nBuild output (truncated):\n${buildVerification.buildOutput.slice(-2000)}`
            : ''),
          buildVerification.buildOutput
        );
      }
    }
    stepsCompleted.push(`Project build verification passed for ${targets.join(', ')}`);
    
    if (verbose) console.error('Step 1: Checking prerequisites...');
    const prereqResult = await checkIOSPrerequisites(projectPath, packageManager);
    integrationReport.prerequisitesChecked = prereqResult.allPrerequisitesMet;
    if (prereqResult.allPrerequisitesMet) {
      stepsCompleted.push('Prerequisites check passed');
    } else {
      const missingReqs = prereqResult.missingRequirements.join(', ');
      stepsFailed.push(`Prerequisites check failed: ${missingReqs}`);
      
      // Generate helpful installation instructions
      const installationInstructions = generateInstallationInstructions(prereqResult, packageManager);
      const errorMessage = `Prerequisites not met:\n\n${missingReqs}\n\n${installationInstructions}`;
      
      throw new Error(errorMessage);
    }

    if (packageManager === 'cocoapods') {
      if (verbose) console.error('Step 2: Creating Podfile...');
      await createOrUpdatePodfile({
        projectPath,
        targetNames: targets,
        language,
        ...(config ?? {}),
        ...(optionalModuleIds && optionalModuleIds.length > 0 ? { optionalModuleIds } : {}),
        ...(notificationServiceExtensionTargetNames && notificationServiceExtensionTargetNames.length > 0 ? { notificationServiceExtensionTargetNames } : {}),
        ...(additionalCocoaPods && additionalCocoaPods.length > 0 ? { additionalPodNames: additionalCocoaPods } : {})
      });
      integrationReport.packageManagerSetup = true;
      stepsCompleted.push('Podfile created');
    } else {
      if (verbose) console.error('Step 2: Adding SPM package...');
      await addSPMPackage({
        projectPath,
        targetNames: targets,
        language,
        spmProductName: coreProductName,
        optionalModuleIds,
        notificationServiceExtensionTargetNames,
        ...(config ?? {})
      });
      integrationReport.packageManagerSetup = true;
      stepsCompleted.push('SPM package added');
    }

    if (verbose) console.error('Step 3: Adding config file...');
    await addAppticsConfigFile({
      projectPath,
      configFileSource,
      targetNames: targets
    });
    integrationReport.configFileAdded = true;
    stepsCompleted.push('Config file added');

    if (verbose) console.error('Step 4: Disabling user script sandboxing...');
    await disableUserScriptSandboxing({ projectPath });
    integrationReport.sandboxingDisabled = true;
    stepsCompleted.push('User script sandboxing disabled');

    if (packageManager === 'cocoapods') {
      if (verbose) console.error('Step 5: Installing pods...');
      const podParams = verbose !== undefined ? { projectPath, verbose } : { projectPath };
      await runPodInstall(podParams);
      integrationReport.dependenciesInstalled = true;
      stepsCompleted.push('Pods installed');
      // Ensure any lingering SPM artifacts are removed when using CocoaPods.
      await removeAppticsSPMArtifacts(projectPath, targets);
    } else {
      integrationReport.dependenciesInstalled = true;
      stepsCompleted.push('SPM dependencies resolved');
    }

    // Detect existing Apptics init: first check entry file only; if not found there, run project-wide scan
    // (e.g. init in a helper called from AppDelegate). If direct init without manager → skip manager and skip injecting init.
    let skipManagerBecauseDirectInit = false;
    const resolvedEntryPath = path.isAbsolute(entryFilePath) ? entryFilePath : path.resolve(projectPath, entryFilePath);
    if (shouldCreateManager && language === 'swift') {
      try {
        const parsed = await parseSwiftFile(resolvedEntryPath);
        const entryHasDirectInit = parsed.initialization.hasAppticsInitialization;
        const entryHasManagerInit = parsed.initialization.hasAppticsManagerConfiguration;
        if (entryHasDirectInit && !entryHasManagerInit) {
          skipManagerBecauseDirectInit = true;
          integrationReport.managerSkippedReason = 'existing_direct_init';
          integrationReport.managerSuggestionSnippet = APPTICS_MANAGER_SUGGESTION_SNIPPET;
        } else if (!entryHasDirectInit && !entryHasManagerInit) {
          const scanned = await scanProjectForAppticsInit(projectPath, language);
          if (scanned.hasDirectInit && !scanned.hasManagerInit) {
            skipManagerBecauseDirectInit = true;
            integrationReport.managerSkippedReason = 'existing_direct_init';
            integrationReport.managerSuggestionSnippet = APPTICS_MANAGER_SUGGESTION_SNIPPET;
          }
        }
      } catch {
        // Proceed with creating manager as before.
      }
    }

    if (shouldCreateManager && !skipManagerBecauseDirectInit) {
      if (verbose) console.error('Step 6: Adding Apptics manager wrapper...');
      const managerResult = await addAppticsManagerWrapper({
        projectPath,
        targetNames: targets,
        ...(managerFilePath ? { outputPath: managerFilePath } : {}),
        overwrite: overwriteManagerFile,
        ...(coreProductName ? { spmProductName: coreProductName } : {}),
        ...(optionalIdsForCode.length > 0 ? { optionalModuleIds: optionalIdsForCode } : {})
      });
      integrationReport.managerFileAdded = managerResult.success;
      integrationReport.managerWrapperUsed = managerWrapperFlag;
      stepsCompleted.push('Apptics manager wrapper added');
    } else if (skipManagerBecauseDirectInit) {
      stepsCompleted.push(
        'AppticsManager skipped (Apptics already initialized directly); see integrationReport.managerSuggestionSnippet to add wrapper manually if desired'
      );
    }

    // Resolve per-target entry files so sub-targets also receive imports/initialization.
    const entryFiles = new Map<string, string>(); // entryFilePath -> representative target
    for (const tgt of targets) {
      const resolvedEntry = await resolveEntryFileForTarget(
        projectPath,
        tgt,
        entryPoint,
        language,
        entryFilePath
      );
      if (!entryFiles.has(resolvedEntry)) {
        entryFiles.set(resolvedEntry, tgt);
      }
    }

    if (verbose) console.error('Step 7: Adding import...');
    for (const [entryPath] of entryFiles) {
      await addAppticsImport({
        entryFilePath: entryPath,
        language,
        packageManager,
        ...(coreProductName ? { spmProductName: coreProductName } : {}),
        ...(optionalIdsForCode.length > 0 ? { optionalModuleIds: optionalIdsForCode } : {})
      });
    }
    integrationReport.importAdded = true;
    stepsCompleted.push(
      `Import added to entry file${entryFiles.size > 1 ? 's' : ''} (${[...entryFiles.values()].join(', ')})`
    );

    if (verbose) console.error('Step 8: Adding initialization...');
    if (!skipManagerBecauseDirectInit) {
      for (const [entryPath] of entryFiles) {
        const initParams: Parameters<typeof addAppticsInitialization>[0] = {
          entryFilePath: entryPath,
          language,
          entryPoint,
          includeAdvancedConfig: !!config,
          useManagerWrapper: managerWrapperFlag
        };
        if (verbose !== undefined) {
          initParams.verbose = verbose;
        }
        if (config) {
          initParams.config = config as AppticsInitConfig;
        }
        if (optionalIdsForCode.length > 0) {
          initParams.optionalModuleIds = optionalIdsForCode;
        }
        await addAppticsInitialization(initParams);
      }
      integrationReport.initializationAdded = true;
      stepsCompleted.push(
        `Initialization added to entry file${entryFiles.size > 1 ? 's' : ''} (${[...entryFiles.values()].join(', ')})`
      );
    } else {
      stepsCompleted.push(
        'Initialization skipped (Apptics already initialized elsewhere in project; avoid double-init)'
      );
    }

    // Final safety net: ensure every target has all required SPM product dependencies.
    if (packageManager === 'spm') {
      try {
        for (const tgt of targets) {
          const productNames = getSPMProductNamesForTarget(
            optionalModuleIds ?? [],
            language,
            tgt,
            notificationServiceExtensionTargetNames ?? []
          );
          for (const productName of productNames) {
            await ensureTargetHasProductDependency(projectPath, tgt, productName);
          }
        }
      } catch {
        // best-effort; ignore
      }
    }

    // Final repair step: ensure project file is valid after all operations
    // This fixes any corruption that may have occurred during integration
    if (verbose) console.error('Final step: Ensuring project file syntax is valid...');
    try {
      const repaired = await repairLegacyAppticsScriptNames(projectPath);
      if (repaired) {
        stepsCompleted.push('Project file syntax validated and repaired');
      }
    } catch (repairError: any) {
      // Don't fail integration if repair fails, but log it
      if (verbose) console.error(`Warning: Final project file repair failed: ${repairError.message}`);
    }

    return {
      success: true,
      stepsCompleted,
      stepsFailed,
      integrationReport,
      message: 'Apptics integration completed successfully'
    };
  } catch (error: any) {
    // Generate detailed failure report
    let failureReportPath: string | undefined;
    let failureReportFormatted: string | undefined;
    
    try {
      const buildOutput = error instanceof BuildVerificationError ? error.buildOutput : undefined;
      
      const reportParams: Parameters<typeof generateFailureReport>[0] = {
        projectPath,
        targets,
        packageManager: packageManager ?? 'spm',
        language,
        error,
        stepsCompleted,
        stepsFailed: [...stepsFailed, error.message],
        integrationReport
      };
      
      if (buildOutput) {
        reportParams.buildOutput = buildOutput;
      }
      
      const { reportPath, report } = await generateFailureReport(reportParams);
      
      failureReportPath = reportPath;
      failureReportFormatted = formatFailureReport(report);
      
      // Output formatted report in verbose mode
      if (verbose) {
        console.error('\n' + failureReportFormatted);
        console.error(`\n📄 Detailed failure report saved to: ${reportPath}\n`);
      }
    } catch (reportError: any) {
      // If report generation fails, log but don't let it override the original error
      if (verbose) {
        console.error(`Warning: Failed to generate failure report: ${reportError.message}`);
      }
    }
    
    return {
      success: false,
      stepsCompleted,
      stepsFailed: [...stepsFailed, error.message],
      integrationReport,
      message: `Integration failed: ${error.message}`,
      error: error instanceof BuildVerificationError ? error : undefined,
      failureReportPath,
      failureReportFormatted
    };
  }
}

export {
  addAppticsConfigFile,
  addAppticsInitialization,
  addAppticsImport,
  addAppticsManagerWrapper,
  addBuildScriptPhaseWithParser,
  addSPMPackage,
  buildSPMScriptCommand,
  createOrUpdatePodfile,
  disableUserScriptSandboxing,
  runPodInstall,
  setupMultiEnvironmentConfig
};

// Export error reporting functionality
export {
  generateFailureReport,
  formatFailureReport,
  categorizeError,
  generateSuggestions,
  collectEnvironmentInfo,
  IntegrationErrorCategory,
  type IntegrationError,
  type IntegrationFailureReport,
  type EnvironmentInfo
} from './errorReporter';

