import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { findPbxprojFile, openProject, getNativeTargets } from './utils';

const execFileAsync = promisify(execFile);

/**
 * Extract build settings from Xcode project using Ruby xcodeproj library.
 */
export async function getBuildSettings(
  projectPath: string,
  targetName?: string
): Promise<{
  iosDeploymentTarget?: string;
  swiftVersion?: string;
  objectVersion?: string;
}> {
  const pbxprojPath = await findPbxprojFile(projectPath);
  const xcodeprojPath = path.dirname(pbxprojPath);

  const script = `
    require 'xcodeproj'
    require 'json'
    
    proj_path = ARGV.shift
    target_name = ARGV.shift
    
    project = Xcodeproj::Project.open(proj_path)
    
    result = {
      object_version: project.object_version
    }
    
    # Get build settings from project level
    project.build_configurations.each do |config|
      settings = config.build_settings
      result[:ios_deployment_target] ||= settings['IPHONEOS_DEPLOYMENT_TARGET']
      result[:swift_version] ||= settings['SWIFT_VERSION']
    end
    
    # If target specified, get target-specific settings
    if target_name && !target_name.empty?
      target = project.targets.find { |t| t.name == target_name }
      if target
        target.build_configurations.each do |config|
          settings = config.build_settings
          result[:ios_deployment_target] ||= settings['IPHONEOS_DEPLOYMENT_TARGET']
          result[:swift_version] ||= settings['SWIFT_VERSION']
        end
      end
    end
    
    puts JSON.generate(result)
  `;

  try {
    const args = targetName ? [xcodeprojPath, targetName] : [xcodeprojPath, ''];
    const { stdout } = await execFileAsync('ruby', ['-e', script, ...args], {
      maxBuffer: 5 * 1024 * 1024
    });

    const result = JSON.parse(stdout.trim());
    return {
      iosDeploymentTarget: result.ios_deployment_target,
      swiftVersion: result.swift_version,
      objectVersion: result.object_version
    };
  } catch (error: any) {
    throw new Error(`Failed to extract build settings: ${error.message}`);
  }
}

/**
 * Check if project uses PBXFileSystemSynchronizedRootGroup (Xcode 15+ feature).
 */
export async function isFileSystemSyncedProject(projectPath: string): Promise<boolean> {
  try {
    const pbxprojPath = await findPbxprojFile(projectPath);
    const parsed = await openProject(pbxprojPath);
    const objects = parsed.objects;

    // Check for PBXFileSystemSynchronizedRootGroup section
    const hasFsSyncGroup = !!objects.PBXFileSystemSynchronizedRootGroup;
    
    // Also check object version >= 77
    const buildSettings = await getBuildSettings(projectPath);
    const objectVersion = buildSettings.objectVersion ? parseInt(buildSettings.objectVersion, 10) : 0;
    const hasHighObjectVersion = objectVersion >= 77;

    return hasFsSyncGroup || hasHighObjectVersion;
  } catch {
    return false;
  }
}

/**
 * Get tool versions.
 */
export async function getToolVersions(): Promise<{
  xcodeVersion: string;
  swiftVersion: string;
  cocoapodsVersion: string;
}> {
  const result = {
    xcodeVersion: '',
    swiftVersion: '',
    cocoapodsVersion: ''
  };

  // Get Xcode version using Ruby xcodeproj
  try {
    const script = `
      require 'xcodeproj'
      puts Xcodeproj::XCScheme.user_data_dir(Xcodeproj::Workspace.new_from_xcworkspace('.'))
    `;
    
    // Fallback to xcodebuild since xcodeproj doesn't expose version directly
    const { stdout } = await execFileAsync('xcodebuild', ['-version'], {
      maxBuffer: 1024 * 1024
    });
    
    // Parse structured output (first line is "Xcode X.Y.Z")
    const lines = stdout.trim().split('\n');
    if (lines.length > 0) {
      const firstLine = lines[0];
      if (firstLine) {
        const parts = firstLine.split(' ');
        if (parts.length >= 2 && parts[0] === 'Xcode' && parts[1]) {
          result.xcodeVersion = parts[1];
        }
      }
    }
  } catch {
    result.xcodeVersion = '';
  }

  // Get Swift version
  try {
    const { stdout } = await execFileAsync('swift', ['--version'], {
      maxBuffer: 1024 * 1024
    });
    
    // Parse structured output (format: "Swift version X.Y.Z ...")
    const lines = stdout.trim().split('\n');
    if (lines.length > 0) {
      const firstLine = lines[0];
      if (firstLine) {
        const parts = firstLine.split(' ');
        const versionIndex = parts.indexOf('version');
        if (versionIndex >= 0 && versionIndex + 1 < parts.length) {
          const version = parts[versionIndex + 1];
          if (version) {
            result.swiftVersion = version;
          }
        }
      }
    }
  } catch {
    result.swiftVersion = '';
  }

  // Get CocoaPods version
  try {
    const { stdout } = await execFileAsync('pod', ['--version'], {
      maxBuffer: 1024 * 1024
    });
    
    // Output is just the version number, already clean
    result.cocoapodsVersion = stdout.trim();
  } catch {
    result.cocoapodsVersion = '';
  }

  return result;
}
