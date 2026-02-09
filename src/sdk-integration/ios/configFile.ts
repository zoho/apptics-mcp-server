import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { linkFileToXcodeProject } from './universalFileLinker';
import { fileExists, findPbxprojFile } from './utils';
import { normalizeTargets } from './pbxprojUtils';
import { isFileSystemSyncedProject } from './xcodeProjectParser';
import {
  APPTICS_MANAGER_PLACEHOLDER_IMPORTS,
  APPTICS_MANAGER_PLACEHOLDER_EXTENSIONS,
  buildManagerOptionalImports,
  buildManagerOptionalExtensions,
} from './appticsOptionalModules';

const APPTICS_MANAGER_FOLDER = 'AppticsManager';
const APPTICS_MANAGER_FILENAME = 'AppticsManager.swift';
const APPTICS_MANAGER_TEMPLATE = `import Foundation
import Apptics
import AppticsEventTracker
${APPTICS_MANAGER_PLACEHOLDER_IMPORTS}

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

${APPTICS_MANAGER_PLACEHOLDER_EXTENSIONS}

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

/**
 * Suggested snippet when Apptics is already initialized directly (e.g. Apptics.initialize(withVerbose:))
 * and we skip creating AppticsManager. User can copy this as a good-practice wrapper if they want.
 */
export const APPTICS_MANAGER_SUGGESTION_SNIPPET = `
// Optional: Use an AppticsManager wrapper for a single place to configure and track events.
// 1. Create a new file AppticsManager/AppticsManager.swift in your project.
// 2. Replace your existing Apptics.initialize(withVerbose: true) with:
//    AppticsManager.shared.configure(verbose: true)
// 3. Add AppticsManager.swift to your app target in Xcode.

import Foundation
import Apptics
import AppticsEventTracker

public final class AppticsManager {
    public static let shared = AppticsManager()
    private var isInitialized = false
    private init() {}

    @discardableResult
    public func configure(verbose: Bool = true, configuration: ((AppticsConfig) -> Void)? = nil) -> Bool {
        guard !isInitialized else { return false }
        configuration?(AppticsConfig.default)
        Apptics.initialize(withVerbose: verbose)
        isInitialized = true
        return true
    }
}
`;

export async function addAppticsConfigFile(params: {
  projectPath: string;
  configFileSource: string;
  configFileName?: string;
  addToAllTargets?: boolean;
  targetNames?: string[];
}) {
  const {
    projectPath,
    configFileSource,
    configFileName = 'apptics-config.plist',
    addToAllTargets = true,
    targetNames
  } = params;

  const destPath = path.join(projectPath, configFileName);

  try {
    const normalizedSource = path.resolve(configFileSource);
    const normalizedDest = path.resolve(destPath);
    if (normalizedSource !== normalizedDest) {
      await fs.copyFile(configFileSource, destPath);
    }

    // Check if config file is already in project
    const pbxprojPath = await findPbxprojFile(projectPath);
    const pbxprojContent = await fs.readFile(pbxprojPath, 'utf-8');
    const configFileAlreadyInProject = pbxprojContent.includes(`${configFileName} in Resources`) || 
                                       pbxprojContent.includes(`${configFileName} in Sources`);

    if (configFileAlreadyInProject) {
      return {
        success: true,
        configFilePath: destPath,
        targetsUpdated: targetNames ?? ['All targets'],
        message: 'Config file already exists in project, skipped linking to avoid duplicates'
      };
    }

    // Read config content for linking
    const configContent = await fs.readFile(destPath, 'utf-8');

    // Link config file to Xcode project using resources build phase
    await linkConfigFileAsResource(projectPath, configFileName, targetNames);

    return {
      success: true,
      configFilePath: destPath,
      targetsUpdated: targetNames ?? ['All targets'],
      message: 'Config file added and linked to Xcode project successfully'
    };
  } catch (error: any) {
    throw new Error(`Failed to add config file: ${error.message}`);
  }
}

async function linkConfigFileAsResource(
  projectPath: string,
  configFileName: string,
  targetNames?: string[]
): Promise<void> {
  const pbxprojPath = await findPbxprojFile(projectPath);
  const xcodeprojPath = path.dirname(pbxprojPath);
  
  // Use Ruby xcodeproj to link config file specifically to Resources build phase
  const targetArgs = targetNames && targetNames.length > 0 ? targetNames : [];
  const script = `
    require 'xcodeproj'
    proj_path = ARGV.shift
    file_name = ARGV.shift
    targets = ARGV
    
    project = Xcodeproj::Project.open(proj_path)
    main_group = project.main_group
    
    # Find or create file reference in main group (project root)
    file_ref = main_group.files.find { |f| f.path == file_name || f.display_name == file_name }
    unless file_ref
      file_ref = main_group.new_file(file_name)
      file_ref.source_tree = '<group>' if file_ref.source_tree.nil? || file_ref.source_tree.to_s != '<group>'
    end
    
    # Add to Resources build phase (not Sources)
    if targets.length > 0
      targets.each do |tname|
        tgt = project.targets.find { |t| t.name == tname }
        next unless tgt
        # Check if already in resources
        unless tgt.resources_build_phase.files_references.include?(file_ref)
          tgt.resources_build_phase.add_file_reference(file_ref)
        end
      end
    else
      # Add to all native targets
      project.targets.each do |tgt|
        next unless tgt.respond_to?(:resources_build_phase)
        unless tgt.resources_build_phase.files_references.include?(file_ref)
          tgt.resources_build_phase.add_file_reference(file_ref)
        end
      end
    end
    
    project.save
    
    # Fix any unquoted sourceTree values
    pbxproj_path = File.join(proj_path, 'project.pbxproj')
    content = File.read(pbxproj_path)
    if content.include?('sourceTree = <group>')
      content = content.gsub('sourceTree = <group>', 'sourceTree = "<group>"')
      File.write(pbxproj_path, content)
    end
  `;
  
  await execFileAsync('ruby', ['-e', script, xcodeprojPath, configFileName, ...targetArgs], {
    cwd: projectPath,
    maxBuffer: 5 * 1024 * 1024
  });
}

export async function addAppticsManagerWrapper(params: {
  projectPath: string;
  targetName?: string;
  targetNames?: string[];
  outputPath?: string;
  overwrite?: boolean;
  spmProductName?: string;
  /** Optional module ids (e.g. remoteConfig, feedbackKit). Fills placeholders and adds module-specific extensions. */
  optionalModuleIds?: string[];
  // When true, do not attempt pbxproj linking (useful for fs-synced projects to avoid corruption).
  skipProjectLink?: boolean;
}) {
  const {
    projectPath,
    targetName,
    targetNames,
    outputPath,
    overwrite = false,
    spmProductName,
    optionalModuleIds,
    skipProjectLink
  } = params;
  try {
    const usesFsSync = await isFileSystemSyncedProject(projectPath);
    const normalizedTargets = await normalizeTargets(projectPath, targetName, targetNames);

      const folderRelativeToProject = APPTICS_MANAGER_FOLDER;

      const effectiveFileName = outputPath
        ? path.basename(outputPath)
        : APPTICS_MANAGER_FILENAME;

      const existingManagerPath = path.join(projectPath, folderRelativeToProject, effectiveFileName);
      const managerExists = await fileExists(existingManagerPath);

      let managerTemplate = APPTICS_MANAGER_TEMPLATE;
      // Always keep `import Apptics` - AppticsConfig and Apptics.initialize are in the Apptics module.
      // When using SPM with AppticsAnalytics, that product brings in Apptics as a dependency.
      const optionalIds = optionalModuleIds ?? [];
      const optionalImports = buildManagerOptionalImports(optionalIds);
      const optionalExtensions = buildManagerOptionalExtensions(optionalIds);
      managerTemplate = managerTemplate
        .replace(APPTICS_MANAGER_PLACEHOLDER_IMPORTS, optionalImports)
        .replace(APPTICS_MANAGER_PLACEHOLDER_EXTENSIONS, optionalExtensions);

    await fs.mkdir(path.join(projectPath, folderRelativeToProject), { recursive: true });
    const shouldWriteManager =
      !managerExists || overwrite || optionalIds.length > 0;
    if (shouldWriteManager) {
      await fs.writeFile(existingManagerPath, managerTemplate, 'utf-8');
    }

    const shouldLink = !skipProjectLink;
    if (!shouldLink) {
      return {
        success: true,
        skipped: false,
        filePath: existingManagerPath,
        addedToProject: false,
        message: 'Apptics manager written to disk (linking skipped)'
      };
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
    try {
      const targetPath = usesFsSync
        ? await linkAppticsManagerWithXcodeproj(
            projectPath,
            folderRelativeToProject,
            effectiveFileName,
            normalizedTargets
          )
        : await linkFileToXcodeProject(linkerParams);

      return {
        success: true,
        skipped: false,
        filePath: targetPath,
        addedToProject: true,
        message: 'Apptics manager file created and linked to Xcode project'
      };
    } catch (err) {
      // Fallback: keep file on disk even if linking fails
      await fs.mkdir(path.join(projectPath, folderRelativeToProject), { recursive: true });
      await fs.writeFile(existingManagerPath, managerTemplate, 'utf-8');
      return {
        success: true,
        skipped: false,
        filePath: existingManagerPath,
        addedToProject: false,
        message: `Apptics manager written to disk (link failed: ${(err as Error).message})`
      };
    }
  } catch (error: any) {
    throw new Error(`Failed to add Apptics manager file: ${error.message}`);
  }
}

const execFileAsync = promisify(execFile);

async function linkAppticsManagerWithXcodeproj(
  projectPath: string,
  folderRelativeToProject: string,
  fileName: string,
  targets: string[]
): Promise<string> {
  const pbxprojPath = await findPbxprojFile(projectPath);
  const xcodeprojPath = path.dirname(pbxprojPath);
  const script = `
    require 'xcodeproj'
    proj_path = ARGV.shift
    folder_rel = ARGV.shift
    file_name = ARGV.shift
    targets = ARGV
    project = Xcodeproj::Project.open(proj_path)
    main_group = project.main_group
    dir = folder_rel && folder_rel.length > 0 ? folder_rel : '.'
    if dir == '.'
      group = main_group
    else
      group = main_group.groups.find { |g| g.display_name == dir || g.path == dir }
      unless group
        group = main_group.new_group(dir, dir)
        # source_tree is already set to "<group>" by new_group, no need to set again
      end
    end
    file_ref = group.files.find { |f| f.path == file_name || f.display_name == file_name }
    unless file_ref
      file_ref = group.new_file(file_name)
      # source_tree is already set to "<group>" by new_file, no need to set again
    end
    targets.each do |tname|
      tgt = project.targets.find { |t| t.name == tname }
      next unless tgt
      unless tgt.source_build_phase.files_references.include?(file_ref)
        tgt.add_file_references([file_ref])
      end
    end
    project.save
  `;
  await execFileAsync('ruby', ['-e', script, xcodeprojPath, folderRelativeToProject, fileName, ...targets], {
    cwd: projectPath,
    maxBuffer: 5 * 1024 * 1024
  });
  const relPathForReturn =
    folderRelativeToProject && folderRelativeToProject.length > 0
      ? path.join(projectPath, folderRelativeToProject, fileName)
      : path.join(projectPath, fileName);
  return relPathForReturn;
}

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

export {
  APPTICS_MANAGER_FOLDER,
  APPTICS_MANAGER_FILENAME,
  APPTICS_MANAGER_TEMPLATE
};

