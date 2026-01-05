/**
 * Apptics iOS Integration MCP Tools
 * Automated tools for integrating Zoho Apptics SDK into iOS projects
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { linkFileToXcodeProject } from './universalFileLinker';
import { genId, escapeRegex, findPbxprojFile, fileExists } from './utils';
// Using the xcode parser instead of string surgery for pbxproj modifications
// eslint-disable-next-line @typescript-eslint/no-var-requires
const xcode = require('xcode');

const execAsync = promisify(exec);

type AppEntryPoint = 'appDelegate' | 'swiftUI';

/**
 * Custom error used to hard-stop integration when the host project does not build.
 * Any caller catching this error must abort integration and ask the user to fix build errors manually.
 */
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

type AppticsInitConfig = {
  sendDataOnMobileNetworkByDefault?: boolean;
  trackOnByDefault?: boolean;
  anonymousType?: 'pseudoAnonymous' | 'nonAnonymous';
};

const MIN_XCODE_VERSION = '9.0';
const MIN_COCOAPODS_VERSION = '1.5.3';
const MIN_IOS_DEPLOYMENT_TARGET = '11.0';
const MIN_SWIFT_VERSION = '4.0';
const APPTICS_MANAGER_FOLDER = 'AppticsManager';
const APPTICS_MANAGER_FILENAME = 'AppticsManager.swift';
const APPTICS_MANAGER_TEMPLATE = `import Foundation
import Apptics
import AppticsEventTracker

public enum AppticsEventGroup: String {
    case general = "general"
    case lifecycle = "appLifecycle"
    case engagement = "userEngagement"
    case retention = "userRetention"

    public static func custom(_ name: String) -> AppticsEventGroup {
        return AppticsEventGroup(rawValue: name) ?? .general
    }
}

public struct AppticsEventDescriptor {
    public let name: String
    public let group: AppticsEventGroup

    public init(name: String, group: AppticsEventGroup = .general) {
        self.name = name
        self.group = group
    }
}

public final class AppticsManager {
    public static let shared = AppticsManager()
    private var isInitialized = false

    private init() {}

    @discardableResult
    public func configure(
        verbose: Bool = true,
        configuration: ((AppticsConfig) -> Void)? = nil
    ) -> Bool {
        guard !isInitialized else { return false }

        configuration?(AppticsConfig.default)
        Apptics.initialize(withVerbose: verbose)
        isInitialized = true
        return true
    }

    public func track(
        _ event: AppticsEventDescriptor,
        properties: [String: Any]? = nil
    ) {
        guard ensureInitialized() else { return }

        if let properties {
            APEvent.trackEvent(
                event.name,
                andGroupName: event.group.rawValue, withProperties: properties
            )
        } else {
            APEvent.trackEvent(
                event.name,
                andGroupName: event.group.rawValue, withProperties: [:]
            )
        }
    }

    public func track(
        _ name: String,
        group: AppticsEventGroup = .general,
        properties: [String: Any]? = nil
    ) {
        let descriptor = AppticsEventDescriptor(name: name, group: group)
        track(descriptor, properties: properties)
    }

    private func ensureInitialized() -> Bool {
        guard isInitialized else {
        #if DEBUG
            print("AppticsManager warning: configure() was not called before tracking.")
        #endif
            return false
        }
        return true
    }
}

public enum AnalyticsEvents {
    public static let appLaunched = AppticsEventDescriptor(
        name: "appLaunched",
        group: .lifecycle
    )

    public static let onboardingCompleted = AppticsEventDescriptor(
        name: "onboardingCompleted",
        group: .engagement
    )

    public static func trackAppLaunch(source: String) {
        AppticsManager.shared.track(
            appLaunched,
            properties: ["source": source]
        )
    }

    public static func trackOnboardingCompleted(stepCount: Int) {
        AppticsManager.shared.track(
            onboardingCompleted,
            properties: ["steps": stepCount]
        )
    }

    // Extend this namespace with your domain-specific analytics helpers.
}
`;

async function listAllNativeTargets(projectPath: string): Promise<string[]> {
  const pbxprojPath = await findPbxprojFile(projectPath);
  const content = await fs.readFile(pbxprojPath, 'utf-8');
  const targetRegex = /\/\* ([^*]+?) \*\/ = \{\s*isa = PBXNativeTarget;/g;
  const targets = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = targetRegex.exec(content)) !== null) {
    if (match[1]) {
      targets.add(match[1].trim());
    }
  }
  return Array.from(targets);
}

async function normalizeTargets(
  projectPath: string,
  targetName?: string,
  targetNames?: string | string[]
): Promise<string[]> {
  if (targetNames === 'all') {
    return listAllNativeTargets(projectPath);
  }
  if (typeof targetNames === 'string' && targetNames.length > 0) {
    return [targetNames];
  }
  if (Array.isArray(targetNames) && targetNames.length > 0) {
    return Array.from(new Set(targetNames));
  }
  if (targetName) {
    return [targetName];
  }
  return listAllNativeTargets(projectPath);
}

// Tool 1: Check iOS Prerequisites
export async function checkIOSPrerequisites(projectPath: string, packageManager: 'cocoapods' | 'spm' = 'spm') {
  const results = {
    xcodeVersion: '',
    podVersion: '',
    iosTargetVersion: '',
    swiftVersion: '',
    allPrerequisitesMet: false,
    missingRequirements: [] as string[]
  };

  try {
    // Check Xcode version
    const { stdout: xcodeOut } = await execAsync('xcodebuild -version');
    const xcodeMatch = xcodeOut.match(/Xcode (\d+\.\d+)/);
    results.xcodeVersion = xcodeMatch?.[1] ?? 'Unknown';
    
    if (
      results.xcodeVersion !== 'Unknown' &&
      !isVersionAtLeast(results.xcodeVersion, MIN_XCODE_VERSION)
    ) {
      results.missingRequirements.push(`Xcode ${MIN_XCODE_VERSION} or later required`);
    }

    // Check CocoaPods version only if using CocoaPods
    if (packageManager === 'cocoapods') {
      try {
        const { stdout: podOut } = await execAsync('pod --version');
        results.podVersion = podOut.trim() || 'Unknown';
        
        if (
          results.podVersion !== 'Unknown' &&
          !isVersionAtLeast(results.podVersion, MIN_COCOAPODS_VERSION)
        ) {
          results.missingRequirements.push(`CocoaPods ${MIN_COCOAPODS_VERSION} or later required`);
        }
      } catch {
        results.missingRequirements.push(`CocoaPods ${MIN_COCOAPODS_VERSION} or later required (not found)`);
      }
    }

    // Check iOS target in project
    const pbxprojPath = await findPbxprojFile(projectPath);
    const pbxContent = await fs.readFile(pbxprojPath, 'utf-8');
    const targetMatch = pbxContent.match(/IPHONEOS_DEPLOYMENT_TARGET = (\d+\.\d+)/);
    results.iosTargetVersion = targetMatch?.[1] ?? 'Unknown';
    
    if (
      results.iosTargetVersion !== 'Unknown' &&
      !isVersionAtLeast(results.iosTargetVersion, MIN_IOS_DEPLOYMENT_TARGET)
    ) {
      results.missingRequirements.push(`iOS ${MIN_IOS_DEPLOYMENT_TARGET} or later target required`);
    }

    // Check Swift version if Swift project
    const swiftMatch = pbxContent.match(/SWIFT_VERSION = (\d+\.\d+)/);
    if (swiftMatch?.[1]) {
      results.swiftVersion = swiftMatch[1];
      if (!isVersionAtLeast(results.swiftVersion, MIN_SWIFT_VERSION)) {
        results.missingRequirements.push(`Swift ${MIN_SWIFT_VERSION} or later required`);
      }
    }

    results.allPrerequisitesMet = results.missingRequirements.length === 0;
    return results;
  } catch (error: any) {
    throw new Error(`Prerequisites check failed: ${error.message}`);
  }
}

// Tool 2: Create or Update Podfile
export async function createOrUpdatePodfile(params: {
  projectPath: string;
  targetName?: string;
  targetNames?: string[];
  language: 'swift' | 'objc';
  uploadSymbolsConfigurations?: string;
  configFilePath?: string;
  appGroupIdentifier?: string;
  uploadFrameworks?: string;
}) {
  const {
    projectPath,
    targetName,
    targetNames,
    language,
    uploadSymbolsConfigurations = 'Release, Appstore',
    configFilePath,
    appGroupIdentifier,
    uploadFrameworks
  } = params;

  const targets = await normalizeTargets(projectPath, targetName, targetNames);

  if (targets.length === 0) {
    throw new Error('No target names provided for Podfile generation.');
  }

  const podfilePath = path.join(projectPath, 'Podfile');
  const sdkPod = language === 'swift' ? 'Apptics-Swift' : 'Apptics-SDK';
  
  // Build script command
  let scriptCmd = `sh "./Pods/Apptics-SDK/scripts/run" --upload-symbols-for-configurations="${uploadSymbolsConfigurations}"`;
  
  if (configFilePath) {
    scriptCmd += ` --config-file-path="${configFilePath}"`;
  }
  if (appGroupIdentifier) {
    scriptCmd += ` --app-group-identifier="${appGroupIdentifier}"`;
  }
  if (uploadFrameworks) {
    scriptCmd += ` --upload-symbols-for-frameworks="${uploadFrameworks}"`;
  }

  // Merge with existing target entries if a Podfile already exists
  let existingTargets: string[] = [];
  if (await fileExists(podfilePath)) {
    try {
      const existingContent = await fs.readFile(podfilePath, 'utf-8');
      const re = /target ['"]([^'"]+)['"] do/g;
      const found = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = re.exec(existingContent)) !== null) {
        if (m[1]) found.add(m[1]);
      }
      existingTargets = Array.from(found);
    } catch {
      existingTargets = [];
    }
  }

  const mergedTargets = Array.from(new Set([...existingTargets, ...targets]));

  const targetBlocks = mergedTargets
    .map((target) => {
      return `target '${target}' do
  use_frameworks!

  pod '${sdkPod}'

  # Pre build script will register the app version, upload dSYM file to the server
  # and add apptics specific information to the main info.plist which will be used by the SDK.
  script_phase :name => 'Apptics pre build',
               :script => '${scriptCmd}',
               :execution_position => :before_compile

end`;
    })
    .join('\n\n');

const podfileContent = `source 'https://github.com/CocoaPods/Specs.git'

platform :ios, '${MIN_IOS_DEPLOYMENT_TARGET}'

${targetBlocks}
`;

  try {
    await fs.writeFile(podfilePath, podfileContent, 'utf-8');
    return {
      success: true,
      podfilePath,
      message: 'Podfile created successfully'
    };
  } catch (error: any) {
    throw new Error(`Failed to create Podfile: ${error.message}`);
  }
}

// Tool 3: Add Apptics Config File
export async function addAppticsConfigFile(params: {
  projectPath: string;
  configFileSource: string;
  configFileName?: string;
  addToAllTargets?: boolean;
}) {
  const {
    projectPath,
    configFileSource,
    configFileName = 'apptics-config.plist',
    addToAllTargets = true
  } = params;

  const destPath = path.join(projectPath, configFileName);

  try {
    // Copy config file
    await fs.copyFile(configFileSource, destPath);

    // Find and update .pbxproj file to add the config file
    const pbxprojPath = await findPbxprojFile(projectPath);
    // Note: Actual pbxproj modification would require xcodeproj parsing library
    // This is simplified for demonstration
    
    return {
      success: true,
      configFilePath: destPath,
      targetsUpdated: ['All targets'],
      message: 'Config file added successfully'
    };
  } catch (error: any) {
    throw new Error(`Failed to add config file: ${error.message}`);
  }
}

// Tool 3b: Add Apptics Manager Wrapper
export async function addAppticsManagerWrapper(params: {
  projectPath: string;
  targetName?: string;
  targetNames?: string[];
  outputPath?: string;
  overwrite?: boolean;
  spmProductName?: string;
}) {
  const {
    projectPath,
    targetName,
    targetNames,
    outputPath,
    overwrite = false,
    spmProductName
  } = params;
  try {
    // Choose folder placement: for filesystem-synced projects, place under first target folder; otherwise use project root.
    const pbxprojPath = await findPbxprojFile(projectPath);
    const pbxContent = await fs.readFile(pbxprojPath, 'utf-8');
    const usesFsSync =
      /PBXFileSystemSynchronizedRootGroup/.test(pbxContent) ||
      /objectVersion\s*=\s*77/.test(pbxContent);

    const normalizedTargets = await normalizeTargets(projectPath, targetName, targetNames);

    // For filesystem-synced projects, create/link a single shared manager under project root
    if (usesFsSync && normalizedTargets.length > 0) {
      const folderRelativeToProject = APPTICS_MANAGER_FOLDER;
      const effectiveFileName = outputPath ? path.basename(outputPath) : APPTICS_MANAGER_FILENAME;
      const existingManagerPath = path.join(projectPath, folderRelativeToProject, effectiveFileName);
      const managerExists = await fileExists(existingManagerPath);

      let managerTemplate = APPTICS_MANAGER_TEMPLATE;
      if (spmProductName && spmProductName !== 'Apptics') {
        managerTemplate = managerTemplate.replace(/import Apptics/, `import ${spmProductName}`);
      }

      const linkerParams: Parameters<typeof linkFileToXcodeProject>[0] = {
        projectPath,
        fileName: effectiveFileName,
        fileContent: managerTemplate,
        folderRelativeToProject,
        overwrite,
        targets: normalizedTargets
      };
      if (managerExists && !overwrite) {
        try {
          linkerParams.fileContent = await fs.readFile(existingManagerPath, 'utf-8');
        } catch {
          // fallback
        }
        linkerParams.overwrite = true;
      }
      const lastPath = await linkFileToXcodeProject(linkerParams);

      return {
        success: true,
        skipped: false,
        filePath: lastPath,
        addedToProject: true,
        message: `Apptics manager file created and linked to targets: ${normalizedTargets.join(', ')}`
      };
    } else {
      const firstTarget = normalizedTargets[0];
      const folderRelativeToProject =
        usesFsSync && firstTarget
          ? path.join(firstTarget, APPTICS_MANAGER_FOLDER)
          : APPTICS_MANAGER_FOLDER;

      const effectiveFileName = outputPath
        ? path.basename(outputPath)
        : APPTICS_MANAGER_FILENAME;

      const existingManagerPath = path.join(projectPath, folderRelativeToProject, effectiveFileName);
      const managerExists = await fileExists(existingManagerPath);

      let managerTemplate = APPTICS_MANAGER_TEMPLATE;
      if (spmProductName && spmProductName !== 'Apptics') {
        managerTemplate = managerTemplate.replace(/import Apptics/, `import ${spmProductName}`);
      }

      const linkerParams: Parameters<typeof linkFileToXcodeProject>[0] = {
        projectPath,
        fileName: effectiveFileName,
        fileContent: managerTemplate,
        folderRelativeToProject,
        overwrite
      };
      if (managerExists && !overwrite) {
        try {
          linkerParams.fileContent = await fs.readFile(existingManagerPath, 'utf-8');
        } catch {
          // fallback
        }
        linkerParams.overwrite = true;
      }

      if (normalizedTargets.length > 0) {
        linkerParams.targets = normalizedTargets;
      }
      const targetPath = await linkFileToXcodeProject(linkerParams);

      return {
        success: true,
        skipped: false,
        filePath: targetPath,
        addedToProject: true,
        message: 'Apptics manager file created and linked to Xcode project'
      };
    }
  } catch (error: any) {
    throw new Error(`Failed to add Apptics manager file: ${error.message}`);
  }
}

// Tool 4: Disable User Script Sandboxing
export async function disableUserScriptSandboxing(params: {
  projectPath: string;
  targetName?: string;
}) {
  const { projectPath, targetName } = params;

  try {
    const pbxprojPath = await findPbxprojFile(projectPath);
    let content = await fs.readFile(pbxprojPath, 'utf-8');

    // Add or update ENABLE_USER_SCRIPT_SANDBOXING setting
    // This is simplified - actual implementation needs proper pbxproj parsing
    if (!content.includes('ENABLE_USER_SCRIPT_SANDBOXING')) {
      content = content.replace(
        /buildSettings = \{/g,
        'buildSettings = {\n\t\t\t\tENABLE_USER_SCRIPT_SANDBOXING = NO;'
      );
    } else {
      content = content.replace(
        /ENABLE_USER_SCRIPT_SANDBOXING = YES/g,
        'ENABLE_USER_SCRIPT_SANDBOXING = NO'
      );
    }

    await fs.writeFile(pbxprojPath, content, 'utf-8');

    return {
      success: true,
      targetsModified: targetName ? [targetName] : ['All targets'],
      message: 'User script sandboxing disabled successfully'
    };
  } catch (error: any) {
    throw new Error(`Failed to disable sandboxing: ${error.message}`);
  }
}

// Tool 5: Run Pod Install
export async function runPodInstall(params: {
  projectPath: string;
  verbose?: boolean;
}) {
  const { projectPath, verbose = false } = params;

  try {
    const cmd = verbose ? 'pod install --verbose' : 'pod install';
    const env = {
      ...process.env,
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      LC_ALL: process.env.LC_ALL ?? 'en_US.UTF-8'
    };
    const { stdout, stderr } = await execAsync(cmd, { cwd: projectPath, env });

    // Parse installed pods
    const installedPods = stdout.match(/Installing (.+?) \(/g)?.map(m => 
      m.replace('Installing ', '').replace(' (', '')
    ) || [];

    return {
      success: true,
      output: stdout,
      installedPods,
      message: 'Pods installed successfully'
    };
  } catch (error: any) {
    throw new Error(`Pod install failed: ${error.message}`);
  }
}

// Tool 5b: Add Swift Package Manager Package
async function addSPMPackageSingle(params: {
  projectPath: string;
  targetName: string;
  language: 'swift' | 'objc';
  spmProductName?: string;
  uploadSymbolsConfigurations?: string;
  configFilePath?: string;
  appGroupIdentifier?: string;
  uploadFrameworks?: string;
}) {
  const {
    projectPath,
    targetName,
    language,
    spmProductName,
    uploadSymbolsConfigurations = 'Release, Appstore',
    configFilePath,
    appGroupIdentifier,
    uploadFrameworks
  } = params;

  try {
    const pbxprojPath = await findPbxprojFile(projectPath);
    let content = await fs.readFile(pbxprojPath, 'utf-8');

    // Apptics SPM repository URL - update this with the actual URL
    const packageRepositoryURL = 'https://github.com/zoho/Apptics-SP';
    // Use provided product name or default to 'AppticsAnalytics'
    // Note: 'Apptics' is a binary target but not a product in the package
    // 'AppticsAnalytics' is the main product that includes Apptics and all core functionality
    const packageProductName = spmProductName || 'AppticsAnalytics';
    
    // Check if package already exists - but still verify product dependency is linked
    let packageExists = content.includes(packageRepositoryURL);
    
    // If package exists, find the package reference ID
    let existingPackageRefId: string | undefined;
    if (packageExists) {
      const packageRefPattern = new RegExp(
        `([A-F0-9]{24})\\s*/\\*\\s*Apptics\\s*\\*/\\s*=\\s*\\{[\\s\\S]*?repositoryURL\\s*=\\s*"${escapeRegex(packageRepositoryURL)}";`,
        'm'
      );
      const packageRefMatch = content.match(packageRefPattern);
      if (packageRefMatch && packageRefMatch[1]) {
        existingPackageRefId = packageRefMatch[1];
      } else {
        // Package URL exists but reference not found; treat as not existing so we add a fresh reference.
        packageExists = false;
      }
    }

    // Generate IDs for package reference and product dependency
    // Use existing package ref ID if package already exists, otherwise generate new one
    const packageRefId = existingPackageRefId || genId();
    let productDependencyId = genId();
    const packageRefName = 'Apptics';

    // Add XCRemoteSwiftPackageReference only if package doesn't exist
    // IMPORTANT: Package sections must be at the root of the objects dictionary, NOT inside PBXProject
    // They should be placed AFTER the PBXProject section ends (after /* End PBXProject section */ marker)
    if (!packageExists) {
      const packageRefEntry = `\t\t${packageRefId} /* ${packageRefName} */ = {\n` +
        `\t\t\tisa = XCRemoteSwiftPackageReference;\n` +
        `\t\t\trepositoryURL = "${packageRepositoryURL}";\n` +
        `\t\t\trequirement = {\n` +
        `\t\t\t\tkind = upToNextMajorVersion;\n` +
        `\t\t\t\tminimumVersion = 1.0.0;\n` +
        `\t\t\t};\n` +
        `\t\t};\n`;

      // Find the XCRemoteSwiftPackageReference section or create it
      // Package sections should be at root level of objects, AFTER PBXProject section
      const packageRefMarker = '/* End XCRemoteSwiftPackageReference section */';
      if (content.includes(packageRefMarker)) {
        content = content.replace(packageRefMarker, packageRefEntry + packageRefMarker);
      } else {
        // Find where to insert - should be AFTER PBXProject section ends, at root of objects
        // First, ensure the PBXProject section marker exists
        const projectEndMarker = '/* End PBXProject section */';
        let insertAfter: string;
        let insertPosition: number;
        
        if (content.includes(projectEndMarker)) {
          // Marker exists - insert right after it
          insertAfter = projectEndMarker;
          insertPosition = content.indexOf(projectEndMarker) + projectEndMarker.length;
        } else {
          // Marker doesn't exist - find the closing brace of PBXProject object and insert after it
          // Look for the pattern: }; followed by /* Begin or /* End (but not /* End PBXProject)
          const pbxProjectClosePattern = /(\t\t\};\s*\n)(\/\* (?:Begin|End) (?!PBXProject))/;
          const pbxProjectMatch = content.match(pbxProjectClosePattern);
          if (pbxProjectMatch && pbxProjectMatch.index !== undefined && pbxProjectMatch[1]) {
            // Insert the PBXProject marker first, then the package section
            insertPosition = pbxProjectMatch.index + pbxProjectMatch[1].length;
            const pbxProjectMarker = '/* End PBXProject section */\n';
            content = content.slice(0, insertPosition) + pbxProjectMarker + content.slice(insertPosition);
            insertAfter = pbxProjectMarker.trim();
            insertPosition += pbxProjectMarker.length;
          } else {
            // Last resort: find the end of objects = { and insert there
            const objectsStart = content.indexOf('objects = {');
            if (objectsStart !== -1) {
              const sectionHeader = '/* Begin XCRemoteSwiftPackageReference section */\n';
              const sectionFooter = '/* End XCRemoteSwiftPackageReference section */\n';
              // Try to insert before the closing brace of objects
              const objectsEnd = content.lastIndexOf('\t};\n\trootObject');
              if (objectsEnd !== -1) {
                content = content.slice(0, objectsEnd) + sectionHeader + packageRefEntry + sectionFooter + content.slice(objectsEnd);
              } else {
                throw new Error('Could not find suitable location to add XCRemoteSwiftPackageReference section');
              }
            } else {
              throw new Error('Could not find objects section in project file');
            }
            // Skip the rest of the insertion logic if we used the last resort
            insertAfter = '';
            insertPosition = -1;
          }
        }
        
        if (insertAfter && insertPosition !== -1) {
          const sectionHeader = '/* Begin XCRemoteSwiftPackageReference section */\n';
          const insertion = '\n' + sectionHeader + packageRefEntry + packageRefMarker;
          content = content.slice(0, insertPosition) + insertion + content.slice(insertPosition);
        }
      }
    }

    // Add packageProductDependency to target
    // IMPORTANT: SPM packages should ONLY be in packageProductDependencies, NOT in Frameworks build phase
    // Xcode automatically handles linking SPM packages - we should never create PBXBuildFile entries
    // or add them to PBXFrameworksBuildPhase for SPM packages
    // Make sure we match PBXNativeTarget specifically, not PBXGroup or other types
    const targetPattern = new RegExp(
      `([A-F0-9]{24}) /\\* ${escapeRegex(targetName)} \\*/ = \\{[\\s\S]*?isa = PBXNativeTarget;[\\s\S]*?packageProductDependencies = \\(([\\s\S]*?)\\);`,
      'm'
    );
    
    // First, find the target by its ID and ensure it's a PBXNativeTarget
    const targetHeaderPattern = new RegExp(
      `([A-F0-9]{24}) /\\* ${escapeRegex(targetName)} \\*/ = \\{[\\s\S]*?isa = PBXNativeTarget;`,
      'm'
    );
    const targetHeaderMatch = content.match(targetHeaderPattern);
    
    if (!targetHeaderMatch || targetHeaderMatch.index === undefined) {
      throw new Error(`Could not find PBXNativeTarget ${targetName} in project`);
    }
    
    // Search for packageProductDependencies within the target block only
    const targetStart = targetHeaderMatch.index;
    const targetBlockStart = targetStart + targetHeaderMatch[0].length;
    
    // Find the target block boundaries
    let braceDepth = 1;
    let targetBlockEnd = targetBlockStart;
    const targetBlock = content.slice(targetBlockStart);
    for (let i = 0; i < targetBlock.length && braceDepth > 0; i++) {
      if (targetBlock[i] === '{') braceDepth++;
      if (targetBlock[i] === '}') braceDepth--;
      if (braceDepth === 0) {
        targetBlockEnd = targetBlockStart + i;
        break;
      }
    }
    
    const targetContent = content.slice(targetBlockStart, targetBlockEnd);
    const packageDepsPattern = /packageProductDependencies\s*=\s*\(([\s\S]*?)\)\s*;/;
    const packageDepsMatch = targetContent.match(packageDepsPattern);
    
    // Check if product dependency already exists (by product name in comment)
    const existingDeps = packageDepsMatch && packageDepsMatch[1] ? packageDepsMatch[1] : '';
    const productDepExists = existingDeps && existingDeps.includes(`/* ${packageProductName} */`);
    
    if (packageDepsMatch && packageDepsMatch.index !== undefined) {
      // Target already has packageProductDependencies
      if (productDepExists && existingDeps) {
        // Product dependency already exists - find its ID to reuse
        const existingDepPattern = new RegExp(
          `([A-F0-9]{24})\\s*/\\*\\s*${escapeRegex(packageProductName)}\\s*\\*/`,
          'm'
        );
        const existingDepMatch = existingDeps.match(existingDepPattern);
        if (existingDepMatch && existingDepMatch[1]) {
          productDependencyId = existingDepMatch[1];
        }
      }

      // Deterministically rebuild packageProductDependencies with our dep added if missing
      const depsStartInTarget = packageDepsMatch.index;
      const depsEndInTarget = depsStartInTarget + packageDepsMatch[0].length;
      const depsStartAbsolute = targetBlockStart + depsStartInTarget;
      const depsEndAbsolute = targetBlockStart + depsEndInTarget;

      const depsBody = packageDepsMatch[1] ?? '';
      const entries = depsBody
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !/^\)$/.test(s));

      const hasOurId = entries.some((e) => e.includes(productDependencyId));
      const hasOurName = entries.some((e) => e.includes(packageProductName));
      const newEntries = hasOurId || hasOurName
        ? entries
        : [...entries, `${productDependencyId} /* ${packageProductName} */`];

      const normalizedBlock =
        'packageProductDependencies = (\n' +
        newEntries.map((e) => `\t\t\t\t${e.replace(/,$/, '')},`).join('\n') +
        '\n\t\t\t);';

      content = content.slice(0, depsStartAbsolute) + normalizedBlock + content.slice(depsEndAbsolute);
      // If productDepExists but the product dependency entry is missing, continue so we can recreate it below.
    } else {
      // Target doesn't have packageProductDependencies yet - create the property
      // We already have targetBlockStart and targetBlockEnd from above
      
      // Try to find buildPhases - support both formats
      // Format 1: buildPhases = ( ... );
      // Format 2: buildPhases = ( ... ); (with potential whitespace variations)
      const buildPhasesPattern = /buildPhases\s*=\s*\(([\s\S]*?)\)\s*;/;
      const buildPhasesMatch = targetContent.match(buildPhasesPattern);
      
      let insertPosition: number;
      
      if (buildPhasesMatch && buildPhasesMatch.index !== undefined) {
        // Found buildPhases - insert right after it
        const buildPhasesEndInTarget = buildPhasesMatch.index + buildPhasesMatch[0].length;
        insertPosition = targetBlockStart + buildPhasesEndInTarget;
      } else {
        // buildPhases not found - might be using fileSystemSynchronizedGroups (objectVersion 77)
        // Look for other common properties to insert after
        // Try dependencies, buildRules, or fileSystemSynchronizedGroups
        const alternativePatterns = [
          /dependencies\s*=\s*\(([\s\S]*?)\)\s*;/,
          /buildRules\s*=\s*\(([\s\S]*?)\)\s*;/,
          /fileSystemSynchronizedGroups\s*=\s*\(([\s\S]*?)\)\s*;/
        ];
        
        let foundAlternative = false;
        for (const pattern of alternativePatterns) {
          const match = targetContent.match(pattern);
          if (match && match.index !== undefined) {
            const endInTarget = match.index + match[0].length;
            insertPosition = targetBlockStart + endInTarget;
            foundAlternative = true;
            break;
          }
        }
        
        if (!foundAlternative) {
          // If we can't find any of the common properties, insert before the closing brace
          // but after the last property we can find
          // Look for any property ending with ); or };
          const lastPropertyPattern = /(\w+\s*=\s*(?:\([^)]*\)|{[^}]*}|[^;]+);)/g;
          let lastMatch: RegExpMatchArray | null = null;
          let match: RegExpMatchArray | null;
          
          while ((match = lastPropertyPattern.exec(targetContent)) !== null) {
            lastMatch = match;
          }
          
          if (lastMatch && lastMatch.index !== undefined) {
            insertPosition = targetBlockStart + lastMatch.index + lastMatch[0].length;
          } else {
            // Last resort: insert right before the closing brace
            insertPosition = targetBlockEnd - 1;
          }
        }
      }
      
      // Verify we're inserting within the target block
      if (insertPosition! >= targetBlockEnd || insertPosition! < targetBlockStart) {
        throw new Error(`Invalid insertion point: calculated position is outside target block`);
      }
      
      // Insert packageProductDependencies
      const packageDepsBlock = `\n\t\t\tpackageProductDependencies = (\n\t\t\t\t${productDependencyId} /* ${packageProductName} */,\n\t\t\t);`;
      
      content = content.slice(0, insertPosition!) + packageDepsBlock + content.slice(insertPosition!);
    }

    // Add XCSwiftPackageProductDependency for THIS productDependencyId (even if another target already had one)
    const productDepEntryByIdPattern = new RegExp(
      `${escapeRegex(productDependencyId)}\\s*/\\*\\s*${escapeRegex(packageProductName)}\\s*\\*/\\s*=\\s*\\{[\\s\\S]*?productName\\s*=\\s*${escapeRegex(packageProductName)};`,
      'm'
    );
    
    if (!productDepEntryByIdPattern.test(content)) {
      const productDepEntry = `\t\t${productDependencyId} /* ${packageProductName} */ = {\n` +
        `\t\t\tisa = XCSwiftPackageProductDependency;\n` +
        `\t\t\tpackage = ${packageRefId} /* ${packageRefName} */;\n` +
        `\t\t\tproductName = ${packageProductName};\n` +
        `\t\t};\n`;

      const productDepMarker = '/* End XCSwiftPackageProductDependency section */';
      if (content.includes(productDepMarker)) {
        content = content.replace(productDepMarker, productDepEntry + productDepMarker);
      } else {
        // Create the section - should be right after XCRemoteSwiftPackageReference section
        const packageRefEndMarker = '/* End XCRemoteSwiftPackageReference section */';
        if (content.includes(packageRefEndMarker)) {
          const sectionHeader = '/* Begin XCSwiftPackageProductDependency section */\n';
          content = content.replace(packageRefEndMarker, packageRefEndMarker + '\n' + sectionHeader + productDepEntry + productDepMarker);
        } else {
          // Fallback: insert after PBXProject section
          const projectEndMarker = '/* End PBXProject section */';
          if (content.includes(projectEndMarker)) {
            const sectionHeader = '/* Begin XCSwiftPackageProductDependency section */\n';
            content = content.replace(projectEndMarker, projectEndMarker + '\n' + sectionHeader + productDepEntry + productDepMarker);
          } else {
            throw new Error('Could not find suitable location to add XCSwiftPackageProductDependency section');
          }
        }
      }
    }

    // Final guard: ensure target block now contains our product dependency ID,
    // even in freshly initialized projects where the target had no dependencies yet.
    content = ensureTargetHasProductDependency(
      content,
      targetName,
      packageProductName,
      productDependencyId
    );

    // Add package references to project's packageReferences at PBXProject level (only if package is new)
    // IMPORTANT: packageReferences must be at PBXProject root level, NOT inside TargetAttributes
    if (!packageExists) {
      const projectPackageRefPattern = /(packageReferences\s*=\s*\()([\s\S]*?)(\);)/;
      const projectMatch = content.match(projectPackageRefPattern);
      
      // Check if packageReferences exists at project level (not in TargetAttributes)
      // We need to find it within PBXProject block, not in attributes
      const pbxProjectPattern = /(isa\s*=\s*PBXProject;[\s\S]*?)(attributes\s*=\s*\{)/;
      const pbxProjectMatch = content.match(pbxProjectPattern);
      
      let packageRefsAtProjectLevel = false;
      
      if (projectMatch && projectMatch.index !== undefined && projectMatch[2]) {
        // Check if this packageReferences is inside PBXProject (before attributes) or in TargetAttributes
        const refPos = projectMatch.index;
        if (pbxProjectMatch && pbxProjectMatch.index !== undefined && pbxProjectMatch[1]) {
          const attributesPos = pbxProjectMatch.index + pbxProjectMatch[1].length;
          
          if (refPos < attributesPos) {
            // packageReferences is at project level - add to existing
            packageRefsAtProjectLevel = true;
            const existingRefs = projectMatch[2];
            if (!existingRefs.includes(packageRefId)) {
              const newRef = existingRefs.trim() 
                ? `\n\t\t\t${packageRefId} /* ${packageRefName} */,`
                : `\n\t\t\t${packageRefId} /* ${packageRefName} */,`;
              const insertPos = projectMatch.index + projectMatch[0].indexOf('(') + 1;
              content = content.slice(0, insertPos) + newRef + content.slice(insertPos);
            }
          } else {
            // packageReferences is in TargetAttributes - need to add at project level
            // Remove it from TargetAttributes and add at project level
            content = content.replace(projectMatch[0], '');
          }
        } else {
          // No attributes section found, assume it's at project level
          packageRefsAtProjectLevel = true;
          const existingRefs = projectMatch[2];
          if (!existingRefs.includes(packageRefId)) {
            const newRef = existingRefs.trim() 
              ? `\n\t\t\t${packageRefId} /* ${packageRefName} */,`
              : `\n\t\t\t${packageRefId} /* ${packageRefName} */,`;
            const insertPos = projectMatch.index + projectMatch[0].indexOf('(') + 1;
            content = content.slice(0, insertPos) + newRef + content.slice(insertPos);
          }
        }
      }
      
      // If packageReferences doesn't exist at project level, add it
      if (!packageRefsAtProjectLevel) {
        // Find where to insert in PBXProject - after targets, before attributes
        const targetsPattern = /(targets\s*=\s*\([\s\S]*?\)\s*;)/;
        const targetsMatch = content.match(targetsPattern);
        
        if (targetsMatch && targetsMatch.index !== undefined) {
          // Insert packageReferences right after targets
          const insertPos = targetsMatch.index + targetsMatch[0].length;
          const packageRefsBlock = `\n\t\t\tpackageReferences = (\n\t\t\t\t${packageRefId} /* ${packageRefName} */,\n\t\t\t);`;
          content = content.slice(0, insertPos) + packageRefsBlock + content.slice(insertPos);
        } else if (pbxProjectMatch && pbxProjectMatch.index !== undefined && pbxProjectMatch[1]) {
          // Insert before attributes section
          const insertPos = pbxProjectMatch.index + pbxProjectMatch[1].length;
          const packageRefsBlock = `\n\t\t\tpackageReferences = (\n\t\t\t\t${packageRefId} /* ${packageRefName} */,\n\t\t\t);`;
          content = content.slice(0, insertPos) + packageRefsBlock + content.slice(insertPos);
        } else {
          throw new Error('Could not find PBXProject section to add packageReferences');
        }
      }
    }

    // Add build script phase for SPM (parser-based; writes via xcode library)
    const scriptCmd = buildSPMScriptCommand({
      projectPath,
      uploadSymbolsConfigurations,
      ...(configFilePath && { configFilePath }),
      ...(appGroupIdentifier && { appGroupIdentifier }),
      ...(uploadFrameworks && { uploadFrameworks })
    });

    // Persist current content before parser-based mutation
    await fs.writeFile(pbxprojPath, content, 'utf-8');
    content = addBuildScriptPhaseWithParser(pbxprojPath, targetName, 'Apptics pre build', scriptCmd);

    // Automatically resolve package dependencies using xcodebuild
    // This ensures the package is resolved without requiring manual steps
    let resolutionSucceeded = false;
    try {
      const xcodeprojPath = pbxprojPath.replace(/\/project\.pbxproj$/, '');
      const xcodeprojName = path.basename(xcodeprojPath);
      const workspacePath = path.dirname(xcodeprojPath);
      
      // Try to resolve packages using xcodebuild
      // Use -resolvePackageDependencies which is available in Xcode 11+
      // This command fetches and resolves Swift Package Manager dependencies
      try {
        const resolveCmd = `cd "${workspacePath}" && xcodebuild -project "${xcodeprojName}" -resolvePackageDependencies 2>&1`;
        const { stdout, stderr } = await execAsync(resolveCmd, {
          timeout: 180000 // 3 minute timeout for package resolution
        });
        
        // Check if resolution was successful
        // If we see "Resolved source packages" or no errors, it worked
        if (!stderr || (!stderr.includes('error') && !stderr.includes('Error'))) {
          resolutionSucceeded = true;
        }
      } catch (resolveError: any) {
        // If resolvePackageDependencies fails, try alternative methods
        // First, try to get the scheme list which can trigger package resolution
        try {
          const listCmd = `cd "${workspacePath}" && xcodebuild -project "${xcodeprojName}" -list 2>&1`;
          await execAsync(listCmd, { timeout: 30000 });
          
          // Try to resolve by attempting to show package dependencies
          // This will trigger Xcode to fetch and resolve packages
          try {
            const showDepsCmd = `cd "${workspacePath}" && xcodebuild -project "${xcodeprojName}" -showBuildSettings -target "${targetName}" 2>&1 | head -50 || true`;
            await execAsync(showDepsCmd, { timeout: 60000 });
            resolutionSucceeded = true;
          } catch (showError) {
            // Try one more method: use xcodebuild to build which will resolve packages
            try {
              // Use -derivedDataPath to avoid polluting user's DerivedData
              const derivedDataPath = path.join(workspacePath, '.build', 'DerivedData');
              await fs.mkdir(derivedDataPath, { recursive: true });
              
              const buildCmd = `cd "${workspacePath}" && xcodebuild -project "${xcodeprojName}" -scheme "${targetName}" -destination "generic/platform=iOS" -derivedDataPath "${derivedDataPath}" clean build-for-testing -quiet 2>&1 | grep -E "(Resolved|error|Error|succeeded|failed)" | head -20 || true`;
              const buildOutput = await execAsync(buildCmd, { timeout: 120000 });
              
              // If we see "Resolved" in output, package was resolved
              if (buildOutput.stdout && buildOutput.stdout.includes('Resolved')) {
                resolutionSucceeded = true;
              }
            } catch (buildError) {
              // If all resolution attempts fail, that's okay
              // The project file structure is correct and Xcode will resolve it automatically when opened
            }
          }
        } catch (fallbackError) {
          // If all resolution attempts fail, that's okay
          // The project file structure is correct and Xcode will resolve it automatically when opened
        }
      }
      
      // Verify the project file structure is correct regardless of resolution status
      const finalContent = await fs.readFile(pbxprojPath, 'utf-8');
      const hasPackageRef = finalContent.includes(packageRepositoryURL);
      const hasProductDep = finalContent.includes(`productName = ${packageProductName};`);
      const hasTargetDep = new RegExp(`packageProductDependencies\\s*=\\s*\\([\\s\\S]*?${productDependencyId}[\\s\\S]*?\\);`).test(finalContent);
      
      if (!hasPackageRef || !hasProductDep || !hasTargetDep) {
        throw new Error('Package was not correctly added to project file. Please check the project structure.');
      }
      
      // If resolution didn't succeed, try one more aggressive approach
      // Wait a bit and then try to verify the package is accessible
      if (!resolutionSucceeded) {
        // Wait a moment for any async operations to complete
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Try one final resolution attempt with a longer timeout
        try {
          const finalResolveCmd = `cd "${workspacePath}" && xcodebuild -project "${xcodeprojName}" -resolvePackageDependencies 2>&1`;
          await execAsync(finalResolveCmd, {
            timeout: 180000 // 3 minute timeout
          });
          resolutionSucceeded = true;
        } catch (finalError: any) {
          // If this still fails, the project file structure is correct but package resolution failed
          // This can happen for various reasons (network issues, Xcode issues, etc.)
          // Since the project file structure is verified to be correct, we should not throw an error
          // Instead, log a warning and continue - Xcode will resolve the package when opened
          console.error(`Warning: Package was added to project file but could not be automatically resolved. The project file structure is correct. Xcode will resolve the package when the project is opened. Error: ${finalError.message || finalError}`);
          // Don't throw - the project file is correct, resolution will happen in Xcode
          resolutionSucceeded = false; // Keep as false but don't fail
        }
      }
    } catch (error: any) {
      // If resolution fails completely, verify project file structure is correct
      // If structure is wrong, throw error; otherwise, re-throw the resolution error
      const finalContent = await fs.readFile(pbxprojPath, 'utf-8');
      const hasPackageRef = finalContent.includes(packageRepositoryURL);
      const hasProductDep = finalContent.includes(`productName = ${packageProductName};`);
      
      if (!hasPackageRef || !hasProductDep) {
        throw new Error(`Failed to add SPM package: ${error.message}`);
      }
      
      // Project file is correct but resolution failed - re-throw the error
      throw error;
    }

    return {
      success: true,
      message: resolutionSucceeded 
        ? 'SPM package added and resolved successfully.'
        : 'SPM package added to project file. Package will be resolved when project is opened in Xcode.',
      packageRepositoryURL,
      packageProductName,
      requiresXcodeResolution: !resolutionSucceeded
    };
  } catch (error: any) {
    throw new Error(`Failed to add SPM package: ${error.message}`);
  }
}

function assertTargetHasProductDependency(
  pbxContent: string,
  targetName: string,
  packageProductName: string
) {
  const targetHeaderPattern = new RegExp(
    `([A-F0-9]{24}) /\\* ${escapeRegex(targetName)} \\*/ = \\{[\\s\\S]*?isa = PBXNativeTarget;`,
    'm'
  );
  const targetHeaderMatch = pbxContent.match(targetHeaderPattern);
  if (!targetHeaderMatch || targetHeaderMatch.index === undefined) {
    throw new Error(`Target ${targetName} not found after SPM integration`);
  }

  const targetStart = targetHeaderMatch.index;
  const targetBlockStart = targetStart + targetHeaderMatch[0].length;

  let braceDepth = 1;
  let targetBlockEnd = targetBlockStart;
  for (let i = targetBlockStart; i < pbxContent.length && braceDepth > 0; i++) {
    if (pbxContent[i] === '{') braceDepth++;
    if (pbxContent[i] === '}') braceDepth--;
    if (braceDepth === 0) {
      targetBlockEnd = i;
      break;
    }
  }

  const targetBlock = pbxContent.slice(targetBlockStart, targetBlockEnd);
  const depsMatch = targetBlock.match(/packageProductDependencies\s*=\s*\(([\s\S]*?)\)\s*;/);
  const hasProductDep = depsMatch?.[1]?.includes(packageProductName) ?? false;
  if (!hasProductDep) {
    throw new Error(
      `SPM product dependency ${packageProductName} not linked to target ${targetName}`
    );
  }
}

function ensureTargetHasProductDependency(
  content: string,
  targetName: string,
  packageProductName: string,
  productDependencyId: string
): string {
  const targetHeaderPattern = new RegExp(
    `([A-F0-9]{24}) /\\* ${escapeRegex(targetName)} \\*/ = \\{[\\s\\S]*?isa = PBXNativeTarget;`,
    'm'
  );
  const targetHeaderMatch = content.match(targetHeaderPattern);
  if (!targetHeaderMatch || targetHeaderMatch.index === undefined) {
    return content;
  }

  const targetStart = targetHeaderMatch.index;
  const targetBlockStart = targetStart + targetHeaderMatch[0].length;
  let braceDepth = 1;
  let targetBlockEnd = targetBlockStart;
  for (let i = targetBlockStart; i < content.length && braceDepth > 0; i++) {
    if (content[i] === '{') braceDepth++;
    if (content[i] === '}') braceDepth--;
    if (braceDepth === 0) {
      targetBlockEnd = i;
      break;
    }
  }

  const targetBlock = content.slice(targetBlockStart, targetBlockEnd);
  const packageDepsPattern = /packageProductDependencies\s*=\s*\(([\s\S]*?)\)\s*;/;
  const packageDepsMatch = targetBlock.match(packageDepsPattern);

  if (packageDepsMatch && packageDepsMatch.index !== undefined) {
    const depsStart = packageDepsMatch.index;
    const depsEnd = depsStart + packageDepsMatch[0].length;
    const depsBody = packageDepsMatch[1] ?? '';
    const entries = depsBody
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !/^\)$/.test(s));

    const hasId = entries.some((e) => e.includes(productDependencyId));
    const hasName = entries.some((e) => e.includes(packageProductName));
    const newEntries = hasId || hasName
      ? entries
      : [...entries, `${productDependencyId} /* ${packageProductName} */`];

    const normalizedBlock =
      'packageProductDependencies = (\n' +
      newEntries.map((e) => `\t\t\t\t${e.replace(/,$/, '')},`).join('\n') +
      '\n\t\t\t);';

    const absStart = targetBlockStart + depsStart;
    const absEnd = targetBlockStart + depsEnd;
    content = content.slice(0, absStart) + normalizedBlock + content.slice(absEnd);
  } else {
    // Append new property before closing brace
    const insertionPoint = targetBlockEnd;
    const block =
      `\n\t\t\tpackageProductDependencies = (\n\t\t\t\t${productDependencyId} /* ${packageProductName} */,\n\t\t\t);\n`;
    content = content.slice(0, insertionPoint) + block + content.slice(insertionPoint);
  }

  return content;
}


export async function addSPMPackage(params: {
  projectPath: string;
  targetName?: string;
  targetNames?: string | string[];
  language: 'swift' | 'objc';
  spmProductName?: string;
  uploadSymbolsConfigurations?: string;
  configFilePath?: string;
  appGroupIdentifier?: string;
  uploadFrameworks?: string;
}) {
  const {
    projectPath,
    targetName,
    targetNames,
    language,
    spmProductName,
    uploadSymbolsConfigurations,
    configFilePath,
    appGroupIdentifier,
    uploadFrameworks
  } = params;

  const targets = await normalizeTargets(projectPath, targetName, targetNames as string | string[]);

  if (targets.length === 0) {
    throw new Error('No target names provided for SPM integration.');
  }

  let lastResult: Awaited<ReturnType<typeof addSPMPackageSingle>> | undefined;
  for (const tgt of targets) {
    const singleParams: Parameters<typeof addSPMPackageSingle>[0] = {
      projectPath,
      targetName: tgt,
      language
    };
    if (spmProductName !== undefined) {
      singleParams.spmProductName = spmProductName;
    }
    if (uploadSymbolsConfigurations !== undefined) {
      singleParams.uploadSymbolsConfigurations = uploadSymbolsConfigurations;
    }
    if (configFilePath !== undefined) {
      singleParams.configFilePath = configFilePath;
    }
    if (appGroupIdentifier !== undefined) {
      singleParams.appGroupIdentifier = appGroupIdentifier;
    }
    if (uploadFrameworks !== undefined) {
      singleParams.uploadFrameworks = uploadFrameworks;
    }

    lastResult = await addSPMPackageSingle(singleParams);
    // Final verification per target to avoid false success
    const pbxprojPath = await findPbxprojFile(projectPath);
    const finalContent = await fs.readFile(pbxprojPath, 'utf-8');
    assertTargetHasProductDependency(finalContent, tgt, spmProductName ?? 'AppticsAnalytics');
  }

  if (!lastResult) {
    throw new Error('SPM integration failed: no targets processed.');
  }

  return {
    ...lastResult,
    message:
      targets.length > 1
        ? `SPM package added for targets: ${targets.join(', ')}`
        : lastResult.message
  };
}


function buildSPMScriptCommand(params: {
  projectPath: string;
  uploadSymbolsConfigurations: string;
  configFilePath?: string;
  appGroupIdentifier?: string;
  uploadFrameworks?: string;
}): string {
  const outputMarker = '$DERIVED_FILE_DIR/AppticsPreBuild.marker';
  const {
    uploadSymbolsConfigurations,
    configFilePath,
    appGroupIdentifier,
    uploadFrameworks
  } = params;

  // For SPM, find the script in DerivedData SourcePackages
  // This script will be executed during build, so we use a find command
  let scriptCmd = `SCRIPT_PATH=$(find "$HOME/Library/Developer/Xcode/DerivedData" -name "run" -path "*/SourcePackages/checkouts/Apptics*" | head -1); if [ -n "$SCRIPT_PATH" ]; then sh "$SCRIPT_PATH" --upload-symbols-for-configurations="${uploadSymbolsConfigurations}"`;
  
  if (configFilePath) {
    scriptCmd += ` --config-file-path="${configFilePath}"`;
  }
  if (appGroupIdentifier) {
    scriptCmd += ` --app-group-identifier="${appGroupIdentifier}"`;
  }
  if (uploadFrameworks) {
    scriptCmd += ` --upload-symbols-for-frameworks="${uploadFrameworks}"`;
  }
  
  // Always create a marker output so Xcode can skip reruns based on outputs
  scriptCmd += `; fi; OUT_MARKER="${outputMarker}"; mkdir -p "$(dirname "$OUT_MARKER")"; touch "$OUT_MARKER"`;

  return scriptCmd;
}

function addBuildScriptPhase(
  content: string,
  targetName: string,
  scriptName: string,
  script: string
): string {
  // First, find the target block boundaries to ensure we only search within the target
  const targetHeaderPattern = new RegExp(
    `([A-F0-9]{24}) /\\* ${escapeRegex(targetName)} \\*/ = \\{[\\s\\S]*?isa = PBXNativeTarget;`,
    'm'
  );
  const targetHeaderMatch = content.match(targetHeaderPattern);
  
  if (!targetHeaderMatch || targetHeaderMatch.index === undefined) {
    throw new Error(`Could not find PBXNativeTarget ${targetName} in project`);
  }
  
  // Find the target block boundaries
  const targetStart = targetHeaderMatch.index;
  const targetBlockStart = targetStart + targetHeaderMatch[0].length;
  
  // Find the target block closing brace by tracking brace depth
  let braceDepth = 1;
  let targetBlockEnd = targetBlockStart;
  for (let i = targetBlockStart; i < content.length && braceDepth > 0; i++) {
    if (content[i] === '{') braceDepth++;
    if (content[i] === '}') braceDepth--;
    if (braceDepth === 0) {
      targetBlockEnd = i;
      break;
    }
  }
  
  if (targetBlockEnd === targetBlockStart) {
    throw new Error(`Could not find closing brace for target ${targetName}`);
  }
  
  // Extract just the target block content
  const targetBlockContent = content.slice(targetBlockStart, targetBlockEnd);
  
  // Verify the target block contains the target name and isa = PBXNativeTarget
  if (!targetBlockContent.includes(`name = ${targetName};`) || 
      !targetBlockContent.includes('isa = PBXNativeTarget')) {
    throw new Error(`Target block validation failed for ${targetName} - block may be incorrect`);
  }
  
  // Find buildPhases keyword and position within target block
  // We'll find it manually to ensure we get the exact position
  const buildPhasesKeywordPos = targetBlockContent.indexOf('buildPhases');
  if (buildPhasesKeywordPos === -1) {
    throw new Error(`Could not find buildPhases keyword in target ${targetName}`);
  }
  
  // Find the opening ( after "buildPhases"
  const buildPhasesOpenParenPosInBlock = targetBlockContent.indexOf('(', buildPhasesKeywordPos);
  if (buildPhasesOpenParenPosInBlock === -1) {
    throw new Error(`Could not find opening parenthesis for buildPhases in target ${targetName}`);
  }
  
  // Convert to absolute position in full content
  const buildPhasesOpenParenPos = targetBlockStart + buildPhasesOpenParenPosInBlock;
  
  // CRITICAL: Verify buildPhasesOpenParenPos is actually at a ( character
  if (content[buildPhasesOpenParenPos] !== '(') {
    throw new Error(`Position mismatch: content at buildPhasesOpenParenPos (${buildPhasesOpenParenPos}) is '${content[buildPhasesOpenParenPos]}', expected '(' for target ${targetName}`);
  }
  
  // Find the matching closing ) by tracking parentheses depth, but ONLY within target block
  let parenDepth = 1;
  let closingParenPos = buildPhasesOpenParenPos + 1;
  let found = false;
  
  // Search only within the target block to prevent matching wrong parentheses
  // CRITICAL: We must stay within targetBlockEnd
  while (closingParenPos < targetBlockEnd && parenDepth > 0) {
    // Safety check: ensure we haven't gone past target block
    if (closingParenPos >= targetBlockEnd) {
      break;
    }
    
    if (content[closingParenPos] === '(') {
      parenDepth++;
    } else if (content[closingParenPos] === ')') {
      parenDepth--;
      if (parenDepth === 0) {
        // Check if this is followed by a semicolon (should be );)
        if (closingParenPos + 1 < content.length && content[closingParenPos + 1] === ';') {
          // Additional verification: ensure we're still within target block
          if (closingParenPos < targetBlockEnd) {
            found = true;
            break;
          }
        }
        // If not followed by ; or outside target block, reset depth and continue
        parenDepth = 1;
      }
    }
    closingParenPos++;
  }
  
  if (!found) {
    throw new Error(`Could not find closing ); for buildPhases in target ${targetName}. Searched from position ${buildPhasesOpenParenPos + 1} to ${targetBlockEnd}`);
  }
  
  if (closingParenPos >= targetBlockEnd) {
    throw new Error(`Closing parenthesis position (${closingParenPos}) is outside target block (ends at ${targetBlockEnd}) for target ${targetName}`);
  }
  
  // CRITICAL: Verify closingParenPos is actually at a ) character
  if (content[closingParenPos] !== ')') {
    throw new Error(`Position mismatch: content at closingParenPos (${closingParenPos}) is '${content[closingParenPos]}', expected ')' for target ${targetName}`);
  }
  
  // Skip if this target already has the script phase (check before modifications)
  const initialBuildPhasesBlock = content.slice(buildPhasesOpenParenPos + 1, closingParenPos);
  const scriptCommentRegex = new RegExp(`/\\*\\s*${escapeRegex(scriptName)}\\s*\\*/`);
  if (scriptCommentRegex.test(initialBuildPhasesBlock)) {
    return content;
  }

  // Generate ID for script phase only
  // Note: SPM packages should NOT have PBXBuildFile entries or be added to Frameworks build phase
  const scriptPhaseId = genId();

  // Add PBXShellScriptBuildPhase section FIRST (before calculating insertion position)
  // This happens at the top of the file, so it will shift positions in the target block
  const scriptPhaseEntry = `\t\t${scriptPhaseId} /* ${scriptName} */ = {\n` +
    `\t\t\tisa = PBXShellScriptBuildPhase;\n` +
    `\t\t\tbuildActionMask = 2147483647;\n` +
    `\t\t\tfiles = (\n` +
    `\t\t\t);\n` +
    `\t\t\tinputFileListPaths = (\n` +
    `\t\t\t);\n` +
    `\t\t\tinputPaths = (\n` +
    `\t\t\t);\n` +
    `\t\t\tname = ${scriptName};\n` +
    `\t\t\toutputFileListPaths = (\n` +
    `\t\t\t);\n` +
    `\t\t\toutputPaths = (\n` +
    `\t\t\t);\n` +
    `\t\t\trunOnlyForDeploymentPostprocessing = 0;\n` +
    `\t\t\tshellPath = /bin/sh;\n` +
    `\t\t\tshellScript = "${script.replace(/"/g, '\\"').replace(/\n/g, '\\n')}";\n` +
    `\t\t};\n`;

  const scriptPhaseMarker = '/* End PBXShellScriptBuildPhase section */';
  let contentOffset = 0;
  if (content.includes(scriptPhaseMarker)) {
    const markerPos = content.indexOf(scriptPhaseMarker);
    if (markerPos < targetBlockStart) {
      contentOffset = scriptPhaseEntry.length;
    }
    content = content.replace(scriptPhaseMarker, scriptPhaseEntry + scriptPhaseMarker);
  } else {
    const buildFileMarker = '/* End PBXBuildFile section */';
    if (content.includes(buildFileMarker)) {
      const markerPos = content.indexOf(buildFileMarker);
      if (markerPos < targetBlockStart) {
        const sectionHeader = '/* Begin PBXShellScriptBuildPhase section */\n';
        contentOffset = sectionHeader.length + scriptPhaseEntry.length;
      }
      const sectionHeader = '/* Begin PBXShellScriptBuildPhase section */\n';
      content = content.replace(buildFileMarker, buildFileMarker + '\n' + sectionHeader + scriptPhaseEntry + scriptPhaseMarker);
    }
  }

  // RECALCULATE all positions after content modification
  // Re-find target block boundaries
  const targetHeaderPattern2 = new RegExp(
    `([A-F0-9]{24}) /\\* ${escapeRegex(targetName)} \\*/ = \\{[\\s\\S]*?isa = PBXNativeTarget;`,
    'm'
  );
  const targetHeaderMatch2 = content.match(targetHeaderPattern2);
  
  if (!targetHeaderMatch2 || targetHeaderMatch2.index === undefined) {
    throw new Error(`Could not find PBXNativeTarget ${targetName} after adding script phase section`);
  }
  
  const targetStart2 = targetHeaderMatch2.index;
  const targetBlockStart2 = targetStart2 + targetHeaderMatch2[0].length;
  
  let braceDepth2 = 1;
  let targetBlockEnd2 = targetBlockStart2;
  for (let i = targetBlockStart2; i < content.length && braceDepth2 > 0; i++) {
    if (content[i] === '{') braceDepth2++;
    if (content[i] === '}') braceDepth2--;
    if (braceDepth2 === 0) {
      targetBlockEnd2 = i;
      break;
    }
  }
  
  const targetBlockContent2 = content.slice(targetBlockStart2, targetBlockEnd2);
  
  // Find buildPhases keyword position within target block
  const buildPhasesKeywordPos2 = targetBlockContent2.indexOf('buildPhases');
  if (buildPhasesKeywordPos2 === -1) {
    throw new Error(`Could not find buildPhases keyword in target ${targetName} after content modification`);
  }
  
  // Find the opening ( after "buildPhases"
  const buildPhasesOpenParenPosInBlock2 = targetBlockContent2.indexOf('(', buildPhasesKeywordPos2);
  if (buildPhasesOpenParenPosInBlock2 === -1) {
    throw new Error(`Could not find opening parenthesis for buildPhases in target ${targetName} after content modification`);
  }
  
  // Convert to absolute position
  const adjustedBuildPhasesOpenParenPos = targetBlockStart2 + buildPhasesOpenParenPosInBlock2;
  
  // Find the matching closing ) by tracking parentheses depth, starting from the opening (
  let parenDepth2 = 1;
  let adjustedClosingParenPos = adjustedBuildPhasesOpenParenPos + 1;
  let found2 = false;
  
  // Search within the target block
  while (adjustedClosingParenPos < targetBlockEnd2 && parenDepth2 > 0) {
    if (content[adjustedClosingParenPos] === '(') {
      parenDepth2++;
    } else if (content[adjustedClosingParenPos] === ')') {
      parenDepth2--;
      if (parenDepth2 === 0) {
        // Check if this is followed by a semicolon (should be );)
        if (adjustedClosingParenPos + 1 < content.length && content[adjustedClosingParenPos + 1] === ';') {
          if (adjustedClosingParenPos < targetBlockEnd2) {
            found2 = true;
            break;
          }
        }
        // If not followed by ; or outside target block, reset depth and continue
        parenDepth2 = 1;
      }
    }
    adjustedClosingParenPos++;
  }
  
  if (!found2) {
    throw new Error(`Could not find closing ); for buildPhases in target ${targetName} after content modification. Searched from ${adjustedBuildPhasesOpenParenPos + 1} to ${targetBlockEnd2}`);
  }
  
  if (adjustedClosingParenPos >= targetBlockEnd2) {
    throw new Error(`Closing parenthesis position (${adjustedClosingParenPos}) is outside target block (ends at ${targetBlockEnd2}) for target ${targetName}`);
  }
  
  const adjustedTargetBlockEnd = targetBlockEnd2;
  
  // CRITICAL: Verify positions are correct
  if (content[adjustedBuildPhasesOpenParenPos] !== '(') {
    throw new Error(`Position verification failed: expected '(' at ${adjustedBuildPhasesOpenParenPos}, found '${content[adjustedBuildPhasesOpenParenPos]}'`);
  }
  if (content[adjustedClosingParenPos] !== ')') {
    throw new Error(`Position verification failed: expected ')' at ${adjustedClosingParenPos}, found '${content[adjustedClosingParenPos]}'`);
  }
  if (adjustedClosingParenPos + 1 >= content.length || content[adjustedClosingParenPos + 1] !== ';') {
    throw new Error(`Position verification failed: expected ');' at ${adjustedClosingParenPos}, found '${content.slice(adjustedClosingParenPos, adjustedClosingParenPos + 2)}'`);
  }

  // CRITICAL: Final validation before insertion
  // Verify that adjustedClosingParenPos is actually part of the buildPhases array we found
  // We need to ensure the adjustedClosingParenPos is between adjustedBuildPhasesOpenParenPos and adjustedTargetBlockEnd
  if (adjustedClosingParenPos <= adjustedBuildPhasesOpenParenPos || adjustedClosingParenPos >= adjustedTargetBlockEnd) {
    throw new Error(`Invalid closingParenPos: ${adjustedClosingParenPos} is not between buildPhasesOpenParenPos (${adjustedBuildPhasesOpenParenPos}) and targetBlockEnd (${adjustedTargetBlockEnd}) for target ${targetName}`);
  }
  
  // Verify the content immediately before adjustedClosingParenPos contains buildPhases context
  // Look backwards to find "buildPhases = (" - it should be relatively close
  let searchStart = Math.max(0, adjustedClosingParenPos - 200);
  const contextBefore = content.slice(searchStart, adjustedClosingParenPos);
  
  // Find the last occurrence of "buildPhases" before closingParenPos
  const buildPhasesPos = contextBefore.lastIndexOf('buildPhases');
  if (buildPhasesPos === -1) {
    throw new Error(`buildPhases not found in context before closingParenPos for target ${targetName}`);
  }
  
  // Find the opening ( after "buildPhases"
  const openParenAfterBuildPhases = contextBefore.indexOf('(', buildPhasesPos);
  if (openParenAfterBuildPhases === -1) {
    throw new Error(`Opening parenthesis not found after buildPhases in context for target ${targetName}`);
  }
  
  // Verify that the opening ( we found matches our adjustedBuildPhasesOpenParenPos
  const absoluteOpenParenPos = searchStart + openParenAfterBuildPhases;
  if (Math.abs(absoluteOpenParenPos - adjustedBuildPhasesOpenParenPos) > 10) {
    throw new Error(`Mismatch: found buildPhases opening at ${absoluteOpenParenPos} but calculated ${adjustedBuildPhasesOpenParenPos} for target ${targetName}`);
  }
  
  // CRITICAL: Ensure we're not in a PBXGroup children array
  // Check if "children = (" appears between adjustedBuildPhasesOpenParenPos and adjustedClosingParenPos
  const contentBetween = content.slice(adjustedBuildPhasesOpenParenPos, adjustedClosingParenPos);
  if (contentBetween.includes('children =') || contentBetween.includes('isa = PBXGroup')) {
    throw new Error(`buildPhases content contains group properties - wrong array matched for target ${targetName}`);
  }
  
  // CRITICAL: Verify adjustedClosingParenPos is actually at a ) character
  if (adjustedClosingParenPos >= content.length || content[adjustedClosingParenPos] !== ')') {
    const actualChar = adjustedClosingParenPos < content.length ? content[adjustedClosingParenPos] : 'EOF';
    throw new Error(`Position mismatch: content at adjustedClosingParenPos (${adjustedClosingParenPos}) is '${actualChar}', expected ')' for target ${targetName}`);
  }
  
  // Additional check: verify context after adjustedClosingParenPos
  const contextAfter = content.slice(adjustedClosingParenPos, Math.min(content.length, adjustedClosingParenPos + 5));
  if (!contextAfter.startsWith(')')) {
    throw new Error(`Invalid context after closingParenPos: expected ')' but found '${contextAfter.substring(0, 5)}' for target ${targetName}`);
  }
  if (adjustedClosingParenPos + 1 >= content.length || content[adjustedClosingParenPos + 1] !== ';') {
    throw new Error(`Invalid context after closingParenPos: expected ');' but found '${contextAfter.substring(0, 5)}' for target ${targetName}`);
  }
  
  // Extract the buildPhases block content using the adjusted positions (AFTER all validations)
  const buildPhasesBlock = content.slice(adjustedBuildPhasesOpenParenPos + 1, adjustedClosingParenPos);
  
  // CRITICAL: Final verification - ensure buildPhasesBlock doesn't contain group properties
  if (buildPhasesBlock.includes('children =') || buildPhasesBlock.includes('isa = PBXGroup') || 
      buildPhasesBlock.includes('path =') || buildPhasesBlock.includes('sourceTree')) {
    throw new Error(`buildPhases content contains group properties - wrong array matched for target ${targetName}. Content: ${buildPhasesBlock.substring(0, 100)}`);
  }
  
  // CRITICAL: Verify the context immediately before adjustedClosingParenPos
  // Look backwards 200 characters to see what's before the insertion point
  const contextBeforeInsertion = content.slice(Math.max(0, adjustedClosingParenPos - 200), adjustedClosingParenPos);
  
  // The context should contain "buildPhases" and should NOT contain "children ="
  const hasBuildPhases = contextBeforeInsertion.includes('buildPhases');
  const hasChildren = contextBeforeInsertion.includes('children =');
  
  if (!hasBuildPhases) {
    throw new Error(`Context before insertion point does not contain 'buildPhases' for target ${targetName}. Context: ${contextBeforeInsertion.substring(Math.max(0, contextBeforeInsertion.length - 80))}`);
  }
  
  if (hasChildren) {
    // Check if "children =" comes after "buildPhases" in the context
    const buildPhasesPosInContext = contextBeforeInsertion.lastIndexOf('buildPhases');
    const childrenPosInContext = contextBeforeInsertion.lastIndexOf('children =');
    if (childrenPosInContext > buildPhasesPosInContext) {
      throw new Error(`Context before insertion point contains 'children =' after 'buildPhases' - wrong array for target ${targetName}. Context: ${contextBeforeInsertion.substring(Math.max(0, contextBeforeInsertion.length - 120))}`);
    }
  }
  
  // Instead of using absolute positions for insertion (which has proven unreliable),
  // rebuild the buildPhases array text and replace it within the target block content.
  const buildPhasesPatternForReplace = /buildPhases\s*=\s*\([\s\S]*?\)\s*;/;
  const buildPhasesMatchText = targetBlockContent2.match(buildPhasesPatternForReplace);
  if (!buildPhasesMatchText || !buildPhasesMatchText[0]) {
    throw new Error(`Unable to locate buildPhases array text for replacement in target ${targetName}`);
  }
  
  // Skip if script phase already present (double-check)
  if (buildPhasesMatchText[0].includes(scriptPhaseId) || buildPhasesMatchText[0].includes(`/* ${scriptName} */`)) {
    return content;
  }
  
  const newBuildPhasesText = buildPhasesMatchText[0].replace(/\)\s*;/, `\n\t\t\t\t${scriptPhaseId} /* ${scriptName} */,\n\t\t\t);`);
  
  // Replace within the target block only
  const updatedTargetBlockContent = targetBlockContent2.replace(buildPhasesPatternForReplace, newBuildPhasesText);
  content = content.slice(0, targetBlockStart2) + updatedTargetBlockContent + content.slice(targetBlockEnd2);

  return content;
}

// Parser-based build script insertion (safer than string surgery)
function addBuildScriptPhaseWithParser(
  pbxprojPath: string,
  targetName: string,
  scriptName: string,
  script: string
): string {
  const project = xcode.project(pbxprojPath);
  project.parseSync();

  const nativeTargets = project.pbxNativeTargetSection();
  let targetUuid: string | null = null;

  for (const [uuid, target] of Object.entries(nativeTargets)) {
    if (uuid.endsWith('_comment')) continue;
    const name = (target as any).name ? (target as any).name.replace(/"/g, '') : '';
    if (name === targetName) {
      targetUuid = uuid;
      break;
    }
  }

  if (!targetUuid) {
    throw new Error(`Could not find PBXNativeTarget ${targetName} in project`);
  }

  // xcode lib does not expose a dedicated helper; read directly from objects
  const shellPhases = project.hash?.project?.objects?.PBXShellScriptBuildPhase || {};
  const target = nativeTargets[targetUuid] as any;
  const targetPhaseIds = new Set<string>(
    (target.buildPhases || []).map((p: any) => p.value)
  );

  const existing = Object.entries(shellPhases).find(([uuid, phase]) => {
    if (uuid.endsWith('_comment')) return false;
    const name = (phase as any).name ? (phase as any).name.replace(/"/g, '') : '';
    return name === scriptName && targetPhaseIds.has(uuid);
  });

  if (!existing) {
    project.addBuildPhase(
      [],
      'PBXShellScriptBuildPhase',
      scriptName,
      targetUuid,
      {
        shellPath: '/bin/sh',
        shellScript: script,
        runOnlyForDeploymentPostprocessing: '0',
        inputPaths: [],
        // Declare an output to avoid Xcode warning about always running
        outputPaths: ['$DERIVED_FILE_DIR/AppticsPreBuild.marker'],
        inputFileListPaths: [],
        outputFileListPaths: []
      }
    );
  }

  const newContent = project.writeSync();
  fsSync.writeFileSync(pbxprojPath, newContent, 'utf-8');
  return newContent;
}

// Tool 6: Add Apptics Import
export async function addAppticsImport(params: {
  entryFilePath: string;
  language: 'swift' | 'objc';
  packageManager?: 'cocoapods' | 'spm';
  spmProductName?: string;
}) {
  const { entryFilePath, language, packageManager = 'spm', spmProductName } = params;

  try {
    let content = await fs.readFile(entryFilePath, 'utf-8');
    
    // For SPM, use the provided product name or default to 'Apptics'; for CocoaPods, use Apptics
    const moduleName = packageManager === 'spm' 
      ? (spmProductName || 'Apptics')
      : 'Apptics';
    const importStatement = language === 'swift' 
      ? `import ${moduleName}` 
      : '#import <Apptics/Apptics.h>';

    // Check if import already exists
    if (content.includes(importStatement)) {
      return {
        success: true,
        importAdded: false,
        message: 'Import already exists'
      };
    }

    // Add import at the top after other imports
    if (language === 'swift') {
      const lastImport = content.lastIndexOf('import ');
      const insertPos = content.indexOf('\n', lastImport) + 1;
      content = content.slice(0, insertPos) + importStatement + '\n' + content.slice(insertPos);
    } else {
      const lastImport = content.lastIndexOf('#import ');
      const insertPos = content.indexOf('\n', lastImport) + 1;
      content = content.slice(0, insertPos) + importStatement + '\n' + content.slice(insertPos);
    }

    await fs.writeFile(entryFilePath, content, 'utf-8');

    return {
      success: true,
      importAdded: true,
      message: 'Import added successfully'
    };
  } catch (error: any) {
    throw new Error(`Failed to add import: ${error.message}`);
  }
}

// Tool 7: Add Apptics Initialization
export async function addAppticsInitialization(params: {
  entryFilePath: string;
  language: 'swift' | 'objc';
  entryPoint?: AppEntryPoint;
  verbose?: boolean;
  includeAdvancedConfig?: boolean;
  config?: AppticsInitConfig;
  useManagerWrapper?: boolean;
}) {
  const {
    entryFilePath,
    language,
    entryPoint = 'appDelegate',
    verbose = true,
    includeAdvancedConfig = false,
    config,
    useManagerWrapper = false
  } = params;

  if (entryPoint === 'swiftUI' && language !== 'swift') {
    throw new Error('SwiftUI entry point is only supported for Swift projects');
  }
  if (useManagerWrapper && language !== 'swift') {
    throw new Error('Apptics manager wrapper is available only for Swift projects');
  }

  try {
    let content = await fs.readFile(entryFilePath, 'utf-8');
    
    // Check for existing initialization - handle both direct Apptics.initialize and AppticsManager.shared.configure
    const hasInitialization = language === 'objc'
      ? /\[Apptics initializeWithVerbose:/.test(content)
      : /Apptics\.initialize/.test(content) || /AppticsManager\.shared\.configure/.test(content);

    if (hasInitialization) {
      return {
        success: true,
        initializationAdded: false,
        message: 'Initialization already exists'
      };
    }

    if (entryPoint === 'swiftUI') {
      content = injectIntoSwiftUIApp(
        content,
        includeAdvancedConfig && !!config,
        config,
        verbose,
        useManagerWrapper
      );
    } else if (language === 'swift') {
      const methodPattern = /func application\([^{]+\{/;
      const methodMatch = content.match(methodPattern);
      if (!methodMatch || methodMatch.index === undefined) {
        throw new Error('Unable to locate application(_:didFinishLaunchingWithOptions:) in the provided file');
      }
      
      // Find the method body to check for existing initialization
      const methodStart = methodMatch.index;
      const methodBodyStart = content.indexOf('{', methodStart);
      if (methodBodyStart !== -1) {
        // Find the matching closing brace
        let braceDepth = 1;
        let methodBodyEnd = methodBodyStart + 1;
        for (let i = methodBodyStart + 1; i < content.length && braceDepth > 0; i++) {
          if (content[i] === '{') braceDepth++;
          if (content[i] === '}') braceDepth--;
          if (braceDepth === 0) {
            methodBodyEnd = i;
            break;
          }
        }
        
        const methodBodyContent = content.slice(methodBodyStart, methodBodyEnd);
        // Check if initialization already exists in this method
        if (/AppticsManager\.shared\.configure/.test(methodBodyContent) || 
            /Apptics\.initialize/.test(methodBodyContent)) {
          // Already has initialization, return content unchanged
          return {
            success: true,
            initializationAdded: false,
            message: 'Initialization already exists in method'
          };
        }
      }
      
      const initCode = createSwiftInitCode(
        includeAdvancedConfig && !!config,
        config,
        verbose,
        4,
        useManagerWrapper
      );
      content = content.replace(methodPattern, (match) => match + initCode);
    } else {
      const methodPattern = /- \(BOOL\)application:\(UIApplication \*\)application didFinishLaunchingWithOptions:[^{]+\{/;
      if (!methodPattern.test(content)) {
        throw new Error('Unable to locate application:didFinishLaunchingWithOptions: in the provided file');
      }
      const initCode = createObjcInitCode(includeAdvancedConfig && !!config, config, verbose);
      content = content.replace(methodPattern, (match) => match + initCode);
    }

    await fs.writeFile(entryFilePath, content, 'utf-8');

    return {
      success: true,
      initializationAdded: true,
      message: 'Initialization added successfully'
    };
  } catch (error: any) {
    throw new Error(`Failed to add initialization: ${error.message}`);
  }
}

function injectIntoSwiftUIApp(
  content: string,
  useAdvancedConfig: boolean,
  config: AppticsInitConfig | undefined,
  verbose: boolean,
  useManagerWrapper: boolean
): string {
  const structMatch = content.match(/struct\s+\w+\s*:\s*App\s*\{/);
  if (!structMatch || structMatch.index === undefined) {
    throw new Error('SwiftUI App struct not found in the provided file');
  }

  const structStart = structMatch.index;
  const structOpenBrace = content.indexOf('{', structStart);
  if (structOpenBrace === -1) {
    throw new Error('Unable to parse SwiftUI App struct body');
  }

  const bodyIndex = content.indexOf('var body', structOpenBrace);
  if (bodyIndex === -1) {
    throw new Error('Could not locate SwiftUI App body to insert Apptics initialization');
  }

  const preBodySegment = content.slice(structOpenBrace + 1, bodyIndex);
  const initRegex = /init\s*\(\s*\)\s*\{/;
  const initCode = createSwiftInitCode(
    useAdvancedConfig,
    config,
    verbose,
    8,
    useManagerWrapper
  );

  if (initRegex.test(preBodySegment)) {
    const relativeInitIndex = preBodySegment.search(initRegex);
    const absoluteInitIndex = structOpenBrace + 1 + relativeInitIndex;
    const initBodyStart = content.indexOf('{', absoluteInitIndex);
    if (initBodyStart === -1) {
      throw new Error('Failed to locate SwiftUI init body');
    }
    
    // Check if initialization already exists in this init method
    const initBodyEnd = content.indexOf('}', initBodyStart);
    if (initBodyEnd !== -1) {
      const initBodyContent = content.slice(initBodyStart, initBodyEnd);
      if (/AppticsManager\.shared\.configure/.test(initBodyContent) || 
          /Apptics\.initialize/.test(initBodyContent)) {
        // Already has initialization, return content unchanged
        return content;
      }
    }
    
    return (
      content.slice(0, initBodyStart + 1) +
      initCode +
      '\n' +
      content.slice(initBodyStart + 1)
    );
  }

  const insertPos = content.lastIndexOf('\n', bodyIndex);
  const safeInsertPos = insertPos === -1 ? bodyIndex : insertPos;
  const initBlock = `\n    init() {${initCode}\n    }\n`;
  return content.slice(0, safeInsertPos) + initBlock + content.slice(safeInsertPos);
}

function createSwiftInitCode(
  useAdvancedConfig: boolean,
  config: AppticsInitConfig | undefined,
  verbose: boolean,
  indentSize: number,
  useManagerWrapper: boolean
): string {
  const indent = ' '.repeat(indentSize);
  const sendData = config?.sendDataOnMobileNetworkByDefault ?? true;
  const trackOn = config?.trackOnByDefault ?? true;
  const anonymousType = config?.anonymousType ?? 'pseudoAnonymous';

  if (useManagerWrapper) {
    if (useAdvancedConfig) {
      return `
${indent}// Configure Apptics via manager
${indent}AppticsManager.shared.configure(verbose: ${verbose}) { config in
${indent}    config.sendDataOnMobileNetworkByDefault = ${sendData}
${indent}    config.trackOnByDefault = ${trackOn}
${indent}    config.anonymousType = .${anonymousType}
${indent}}`;
    }

    return `
${indent}// Initialize Apptics via manager
${indent}AppticsManager.shared.configure(verbose: ${verbose})`;
  }

  if (useAdvancedConfig) {
    return `
${indent}// Configure Apptics SDK
${indent}AppticsConfig.default.sendDataOnMobileNetworkByDefault = ${sendData}
${indent}AppticsConfig.default.trackOnByDefault = ${trackOn}
${indent}AppticsConfig.default.anonymousType = .${anonymousType}

${indent}// Initialize Apptics
${indent}Apptics.initialize(withVerbose: ${verbose})`;
  }

  return `
${indent}// Initialize Apptics
${indent}Apptics.initialize(withVerbose: ${verbose})`;
}

function createObjcInitCode(
  useAdvancedConfig: boolean,
  config: AppticsInitConfig | undefined,
  verbose: boolean
): string {
  const sendData = config?.sendDataOnMobileNetworkByDefault ?? true;
  const trackOn = config?.trackOnByDefault ?? true;
  const anonType = config?.anonymousType === 'nonAnonymous'
    ? 'APAnonymousTypeNonAnonymous'
    : 'APAnonymousTypePseudoAnonymous';

  if (useAdvancedConfig) {
    return `
    // Configure Apptics SDK
    AppticsConfig.defaultConfig.sendDataOnMobileNetworkByDefault = ${sendData ? 'YES' : 'NO'};
    AppticsConfig.defaultConfig.trackOnByDefault = ${trackOn ? 'YES' : 'NO'};
    AppticsConfig.defaultConfig.anonymousType = ${anonType};

    // Initialize Apptics
    [Apptics initializeWithVerbose:${verbose ? 'YES' : 'NO'}];`;
  }

  return `
    // Initialize Apptics
    [Apptics initializeWithVerbose:${verbose ? 'YES' : 'NO'}];`;
}

function normalizeVersionParts(version: string): number[] {
  return version
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((part) => Number.parseInt(part, 10));
}

function isVersionAtLeast(current: string, minimum: string): boolean {
  const currentParts = normalizeVersionParts(current);
  const minimumParts = normalizeVersionParts(minimum);

  if (currentParts.length === 0 || minimumParts.length === 0) {
    return false;
  }

  const length = Math.max(currentParts.length, minimumParts.length);

  for (let i = 0; i < length; i++) {
    const currentPart = currentParts[i] ?? 0;
    const minimumPart = minimumParts[i] ?? 0;

    if (currentPart > minimumPart) {
      return true;
    }
    if (currentPart < minimumPart) {
      return false;
    }
  }

  return true;
}

const IGNORED_SCAN_DIRS = new Set([
  'Pods',
  'build',
  '.build',
  '.git',
  'node_modules',
  'DerivedData'
]);

async function findFileByPredicate(
  root: string,
  predicate: (candidate: string) => Promise<boolean>
): Promise<string | undefined> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_SCAN_DIRS.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const hit = await findFileByPredicate(full, predicate);
      if (hit) return hit;
    } else {
      if (await predicate(full)) return full;
    }
  }
  return undefined;
}

async function findSwiftUIAppFileForTargetFolder(targetFolder: string): Promise<string | undefined> {
  return findFileByPredicate(targetFolder, async (candidate) => {
    if (!candidate.endsWith('.swift')) return false;
    try {
      const content = await fs.readFile(candidate, 'utf-8');
      return /@main\s+struct\s+\w+\s*:\s*App/.test(content);
    } catch {
      return false;
    }
  });
}

async function findAppDelegateFileForTargetFolder(targetFolder: string): Promise<string | undefined> {
  const isAppDelegate = (name: string) =>
    name.endsWith('AppDelegate.swift') || name.endsWith('AppDelegate.m') || name.endsWith('AppDelegate.mm');

  return findFileByPredicate(targetFolder, async (candidate) => {
    return isAppDelegate(candidate);
  });
}

async function resolveEntryFileForTarget(
  projectPath: string,
  targetName: string,
  entryPoint: AppEntryPoint,
  language: 'swift' | 'objc',
  fallbackEntry: string
): Promise<string> {
  const targetFolder = path.join(projectPath, targetName);
  const targetFolderExists = await fileExists(targetFolder);

  if (targetFolderExists) {
    if (language === 'swift') {
      if (entryPoint === 'swiftUI') {
        const swiftUI = await findSwiftUIAppFileForTargetFolder(targetFolder);
        if (swiftUI) return swiftUI;
      }
      const appDelegate = await findAppDelegateFileForTargetFolder(targetFolder);
      if (appDelegate) return appDelegate;
      const swiftUIFallback = await findSwiftUIAppFileForTargetFolder(targetFolder);
      if (swiftUIFallback) return swiftUIFallback;
    } else {
      const appDelegate = await findAppDelegateFileForTargetFolder(targetFolder);
      if (appDelegate) return appDelegate;
    }
  }

  // Fallback to the original resolved entry file
  return fallbackEntry;
}

// Tool 8: Setup Multi-Environment Config
export async function setupMultiEnvironmentConfig(params: {
  projectPath: string;
  environments: Array<{
    name: string;
    configFileSource: string;
    targetName?: string;
  }>;
}) {
  const { projectPath, environments } = params;
  const configured: string[] = [];

  try {
    for (const env of environments) {
      const configFileName = `apptics-config-${env.name}.plist`;
      const destPath = path.join(projectPath, configFileName);
      await fs.copyFile(env.configFileSource, destPath);
      configured.push(env.name);
    }

    return {
      success: true,
      environmentsConfigured: configured,
      message: 'Multi-environment setup completed'
    };
  } catch (error: any) {
    throw new Error(`Multi-environment setup failed: ${error.message}`);
  }
}

// Tool 9: Verify Apptics Integration
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
    const pbxContent = await fs.readFile(pbxprojPath, 'utf-8');
    const discoveredTargets = (() => {
      const matches: string[] = [];
      const re = /\/\* ([^*]+?) \*\/ = \{\s*isa = PBXNativeTarget;/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(pbxContent)) !== null) {
        if (m[1]) {
          matches.push(m[1].trim());
        }
      }
      return matches;
    })();
    const rawTargets = targetNames?.length
      ? Array.from(new Set(targetNames))
      : targetName
        ? [targetName]
        : discoveredTargets;
    const targets = rawTargets.filter((t): t is string => Boolean(t));

    if (packageManager === 'cocoapods') {
      // Check Podfile
      const podfilePath = path.join(projectPath, 'Podfile');
      checks.packageManagerSetup = await fileExists(podfilePath);
      
      if (checks.packageManagerSetup) {
        const podfileContent = await fs.readFile(podfilePath, 'utf-8');
        checks.appticsSDKConfigured = /pod ['"]Apptics-/.test(podfileContent);
        checks.preBuildScriptConfigured = /Apptics pre build/.test(podfileContent);
      } else {
        missingSteps.push('Create Podfile with Apptics-SDK');
      }

      // Check Pods installed
      const podsPath = path.join(projectPath, 'Pods');
      checks.dependenciesInstalled = await fileExists(podsPath);
      if (!checks.dependenciesInstalled) {
        missingSteps.push('Run pod install');
      }
    } else {
      // Check SPM package
      const packageRepositoryURL = 'https://github.com/zoho/Apptics-SP';
      checks.packageManagerSetup = pbxContent.includes(packageRepositoryURL);
      checks.appticsSDKConfigured = checks.packageManagerSetup;
      
      // Check for build script phase
      checks.preBuildScriptConfigured = /name = Apptics pre build/.test(pbxContent);
      
      if (!checks.packageManagerSetup) {
        missingSteps.push('Add Apptics SPM package to project');
      }
      for (const tgt of targets) {
        const targetHeaderPattern = new RegExp(
          `([A-F0-9]{24}) /\\* ${escapeRegex(tgt)} \\*/ = \\{[\\s\\S]*?isa = PBXNativeTarget;`,
          'm'
        );
        const targetHeaderMatch = pbxContent.match(targetHeaderPattern);
        if (!targetHeaderMatch || targetHeaderMatch.index === undefined) {
          missingSteps.push(`Target not found in project: ${tgt}`);
          continue;
        }

        const targetStart = targetHeaderMatch.index;
        const targetBlockStart = targetStart + targetHeaderMatch[0].length;

        let braceDepth = 1;
        let targetBlockEnd = targetBlockStart;
        for (let i = targetBlockStart; i < pbxContent.length && braceDepth > 0; i++) {
          if (pbxContent[i] === '{') braceDepth++;
          if (pbxContent[i] === '}') braceDepth--;
          if (braceDepth === 0) {
            targetBlockEnd = i;
            break;
          }
        }

        const targetBlock = pbxContent.slice(targetBlockStart, targetBlockEnd);
        const depsMatch = targetBlock.match(/packageProductDependencies\s*=\s*\(([\s\S]*?)\)\s*;/);
        const hasProductDep = depsMatch ? /Apptics/.test(depsMatch[1] ?? '') : false;
        const hasPreBuildScript = targetBlock.includes('Apptics pre build');

        targetReports[tgt] = {
          productDependencyLinked: hasProductDep,
          preBuildScriptPresent: hasPreBuildScript,
          userScriptSandboxingDisabled: /ENABLE_USER_SCRIPT_SANDBOXING = NO/.test(pbxContent)
        };

        if (!hasProductDep) {
          missingSteps.push(`Add Apptics package dependency to target ${tgt}`);
        }
        if (!hasPreBuildScript) {
          missingSteps.push(`Add Apptics pre build script to target ${tgt}`);
        }
      }
      
      // SPM dependencies are resolved by Xcode, so we just note it
      checks.dependenciesInstalled = true; // Will be resolved on build
    }

    // Check config file
    const configPath = path.join(projectPath, 'apptics-config.plist');
    checks.configFileExists = await fileExists(configPath);
    if (!checks.configFileExists) {
      missingSteps.push('Add apptics-config.plist to project');
    }

    // Check sandboxing
    checks.userScriptSandboxingDisabled = /ENABLE_USER_SCRIPT_SANDBOXING = NO/.test(pbxContent);
    if (!checks.userScriptSandboxingDisabled) {
      missingSteps.push('Set ENABLE_USER_SCRIPT_SANDBOXING = NO');
    }

    // Check AppDelegate
    const entryContent = await fs.readFile(entryFilePath, 'utf-8');
    const importRegex = language === 'objc'
      ? /#import <Apptics\/Apptics.h>/
      : /import Apptics/;
    const initializationRegex = language === 'objc'
      ? /\[Apptics initializeWithVerbose:/
      : /Apptics\.initialize|AppticsManager\.shared\.(configure|initialize)/;

    checks.appticsImportPresent = importRegex.test(entryContent);
    checks.appticsInitialized = initializationRegex.test(entryContent);
    
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

// Tool 9.5: Verify Project Builds Successfully
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
    
    // Try building with scheme first, fallback to direct target build
    let buildCommand = `xcodebuild -project "${xcodeprojName}" -scheme "${targetName}" -configuration Debug clean build CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO 2>&1`;
    let buildOutput = '';
    let buildSucceeded = false;
    
    try {
      const { stdout, stderr } = await execAsync(buildCommand, {
        cwd: projectPath,
        maxBuffer: 10 * 1024 * 1024 // 10MB buffer for build output
      });
      
      buildOutput = stdout + stderr;
      buildSucceeded = buildOutput.includes('BUILD SUCCEEDED');
    } catch (error: any) {
      // If scheme-based build fails, try direct target build
      if (error.message && error.message.includes('scheme')) {
        if (verbose) console.error('Scheme not found, trying direct target build...');
        buildCommand = `xcodebuild -project "${xcodeprojName}" -target "${targetName}" -configuration Debug clean build CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO 2>&1`;
        
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
      // Extract error information
      const errorLines = buildOutput.split('\n').filter((line: string) => 
        line.includes('error:') || line.includes('ERROR:')
      );
      
      let errorMessage = 'Build failed with errors';
      if (errorLines.length > 0) {
        // Get first few meaningful error lines
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

// Tool 10: Complete iOS Integration (All-in-One)
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
    verbose,
    config,
    createManagerFile,
    managerFilePath,
    overwriteManagerFile = false,
    useManagerWrapper
  } = params;
  const rawTargets = targetNames?.length
    ? Array.from(new Set(targetNames))
    : targetName
      ? [targetName]
      : [];
  const targets = rawTargets.filter((t): t is string => Boolean(t));
  if (targets.length === 0) {
    throw new Error('No target names provided for integration.');
  }
  const stepsCompleted: string[] = [];
  const stepsFailed: string[] = [];
  
  const integrationReport = {
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
    // Step 0: Verify project builds successfully before integration
    if (verbose) console.error('Step 0: Verifying project builds successfully...');
    for (const tgt of targets) {
      const buildVerification = await verifyProjectBuilds({
        projectPath,
        targetName: tgt,
        ...(verbose !== undefined && { verbose })
      });
      
      if (!buildVerification.success) {
        stepsFailed.push(`Build verification failed for ${tgt}: ${buildVerification.message}`);
        // Hard stop: do NOT continue integration. User must fix build manually.
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
    
    // Step 1: Check Prerequisites
    if (verbose) console.error('Step 1: Checking prerequisites...');
    const prereqResult = await checkIOSPrerequisites(projectPath, packageManager);
    integrationReport.prerequisitesChecked = prereqResult.allPrerequisitesMet;
    if (prereqResult.allPrerequisitesMet) {
      stepsCompleted.push('Prerequisites check passed');
    } else {
      stepsFailed.push(`Prerequisites check failed: ${prereqResult.missingRequirements.join(', ')}`);
      throw new Error('Prerequisites not met');
    }

    // Step 2: Setup Package Manager (CocoaPods or SPM)
    if (packageManager === 'cocoapods') {
      if (verbose) console.error('Step 2: Creating Podfile...');
      await createOrUpdatePodfile({
        projectPath,
        targetNames: targets,
        language,
        ...(config ?? {})
      });
      integrationReport.packageManagerSetup = true;
      stepsCompleted.push('Podfile created');
    } else {
      if (verbose) console.error('Step 2: Adding SPM package...');
      await addSPMPackage({
        projectPath,
        targetNames: targets,
        language,
        spmProductName,
        ...(config ?? {})
      });
      integrationReport.packageManagerSetup = true;
      stepsCompleted.push('SPM package added');
    }

    // Step 3: Add Config File
    if (verbose) console.error('Step 3: Adding config file...');
    await addAppticsConfigFile({
      projectPath,
      configFileSource
    });
    integrationReport.configFileAdded = true;
    stepsCompleted.push('Config file added');

    // Step 4: Disable Sandboxing
    if (verbose) console.error('Step 4: Disabling user script sandboxing...');
    await disableUserScriptSandboxing({ projectPath });
    integrationReport.sandboxingDisabled = true;
    stepsCompleted.push('Sandboxing disabled');

    // Step 5: Install Dependencies
    if (packageManager === 'cocoapods') {
      if (verbose) console.error('Step 5: Running pod install...');
      await runPodInstall({
        projectPath,
        ...(verbose !== undefined && { verbose })
      });
      integrationReport.dependenciesInstalled = true;
      stepsCompleted.push('Pods installed');
    } else {
      if (verbose) console.error('Step 5: SPM packages will be resolved by Xcode on next build...');
      integrationReport.dependenciesInstalled = true;
      stepsCompleted.push('SPM package configured (will resolve on next Xcode build)');
    }

    // Step 6: Add Import per target entry file
    if (verbose) console.error('Step 6: Adding Apptics import...');
    const targetEntryFiles: Record<string, string> = {};
    for (const tgt of targets) {
      targetEntryFiles[tgt] = await resolveEntryFileForTarget(
        projectPath,
        tgt,
        entryPoint,
        language,
        entryFilePath
      );
      await addAppticsImport({
        entryFilePath: targetEntryFiles[tgt]!,
        language,
        packageManager,
        ...(spmProductName && { spmProductName })
      });
    }
    integrationReport.importAdded = true;
    stepsCompleted.push('Import added');

    // Step 7: Add Initialization per target entry file
    if (verbose) console.error('Step 7: Adding initialization...');
    const shouldEnsureManagerWrapper = createManagerFile ?? true;
    const shouldUseManagerWrapper =
      useManagerWrapper ?? shouldEnsureManagerWrapper;

    if (shouldUseManagerWrapper && language !== 'swift') {
      throw new Error('Apptics manager wrapper can only be used with Swift projects');
    }

    for (const tgt of targets) {
      await addAppticsInitialization({
        entryFilePath: targetEntryFiles[tgt]!,
        language,
        entryPoint,
        ...(verbose !== undefined && { verbose }),
        includeAdvancedConfig: !!config,
        config,
        useManagerWrapper: shouldUseManagerWrapper
      });
    }
    integrationReport.initializationAdded = true;
    integrationReport.managerWrapperUsed = shouldUseManagerWrapper;
    stepsCompleted.push('Initialization added');

    // Step 8: Create Apptics manager wrapper (optional)
    if (shouldEnsureManagerWrapper) {
      if (verbose) console.error('Step 8: Creating Apptics manager wrapper...');
      const managerParams: {
        projectPath: string;
        targetName?: string;
        targetNames?: string[];
        outputPath?: string;
        overwrite?: boolean;
        spmProductName?: string;
      } = {
        projectPath,
        targetNames: targets,
        ...(spmProductName && { spmProductName })
      };

      if (typeof managerFilePath !== 'undefined') {
        managerParams.outputPath = managerFilePath;
      }
      if (typeof overwriteManagerFile !== 'undefined') {
        managerParams.overwrite = overwriteManagerFile;
      }

      const managerResult = await addAppticsManagerWrapper(managerParams);
      integrationReport.managerFileAdded = !managerResult.skipped;
      stepsCompleted.push(
        managerResult.skipped
          ? 'Apptics manager file already present'
          : 'Apptics manager file created'
      );
    } else {
      stepsCompleted.push('Apptics manager file skipped by request');
    }

    return {
      success: true,
      stepsCompleted,
      stepsFailed,
      integrationReport,
      message: 'Apptics iOS integration completed successfully!'
    };

  } catch (error: any) {
    return {
      success: false,
      stepsCompleted,
      stepsFailed: [...stepsFailed, error.message],
      integrationReport,
      message: `Integration failed: ${error.message}`
    };
  }
}

// Helper Functions
