import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { linkFileToXcodeProject } from './universalFileLinker';
import { fileExists, findPbxprojFile } from './utils';
import { normalizeTargets, isFileSystemSyncedProject } from './pbxprojUtils';

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
    const normalizedSource = path.resolve(configFileSource);
    const normalizedDest = path.resolve(destPath);
    if (normalizedSource !== normalizedDest) {
      await fs.copyFile(configFileSource, destPath);
    }

    await findPbxprojFile(projectPath);

    return {
      success: true,
      configFilePath: destPath,
      targetsUpdated: addToAllTargets ? ['All targets'] : [],
      message: 'Config file added successfully'
    };
  } catch (error: any) {
    throw new Error(`Failed to add config file: ${error.message}`);
  }
}

export async function addAppticsManagerWrapper(params: {
  projectPath: string;
  targetName?: string;
  targetNames?: string[];
  outputPath?: string;
  overwrite?: boolean;
  spmProductName?: string;
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
      if (spmProductName && spmProductName !== 'Apptics') {
        managerTemplate = managerTemplate.replace(/import Apptics/, `import ${spmProductName}`);
      }

    await fs.mkdir(path.join(projectPath, folderRelativeToProject), { recursive: true });
    if (!managerExists || overwrite) {
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

