import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import { findPbxprojFile } from './utils';
import { assertTargetHasProductDependency, normalizeTargets, isFileSystemSyncedProject } from './pbxprojUtils';
import { addBuildScriptPhaseWithParser, buildSPMScriptCommand, addBuildScriptPhaseWithRuby } from './buildScriptPhase';
import { addAppticsSPMToProject } from '../../dependency-switcher/ios/spmEditor';

const execAsync = promisify(exec);
const { execFile } = require('child_process');
const execFileAsync = promisify(execFile);

async function addSPMPackageWithRuby(
  projectPath: string,
  targetName: string,
  productName: string
): Promise<void> {
  const pbxprojPath = await findPbxprojFile(projectPath);
  const xcodeprojPath = path.dirname(pbxprojPath);
  const script = `
    require 'xcodeproj'
    proj_path = ARGV.shift
    target_name = ARGV.shift
    product_name = ARGV.shift
    
    project = Xcodeproj::Project.open(proj_path)
    target = project.targets.find { |t| t.name == target_name }
    raise "Target #{target_name} not found" unless target
    
    # Add SPM package reference
    repo_url = 'https://github.com/zoho/Apptics-SP'
    pkg_ref = project.root_object.package_references.find { |ref| ref.repositoryURL == repo_url }
    unless pkg_ref
      pkg_ref = project.new(Xcodeproj::Project::Object::XCRemoteSwiftPackageReference)
      pkg_ref.repositoryURL = repo_url
      pkg_ref.requirement = { 'kind' => 'upToNextMajorVersion', 'minimumVersion' => '3.0.0' }
      project.root_object.package_references << pkg_ref
    end
    
    # Link product dependency to target
    existing_dep = target.package_product_dependencies.find { |dep| dep.product_name == product_name }
    unless existing_dep
      prod_dep = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
      prod_dep.product_name = product_name
      prod_dep.package = pkg_ref
      target.package_product_dependencies << prod_dep
    end
    
    project.save
  `;
  await execFileAsync('ruby', ['-e', script, xcodeprojPath, targetName, productName], {
    cwd: projectPath,
    maxBuffer: 5 * 1024 * 1024
  });
}

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
    const packageProductName = spmProductName ?? 'AppticsAnalytics';
    const usesFsSync = await isFileSystemSyncedProject(projectPath);

    if (usesFsSync) {
      // For fs-sync projects, use Ruby xcodeproj for all operations to avoid corruption
      await addSPMPackageWithRuby(projectPath, targetName, packageProductName);
    } else {
      await addAppticsSPMToProject(pbxprojPath, [targetName], language, spmProductName);
    }
    
    // Use Ruby xcodeproj for build script phases to ensure proper serialization (no regex needed)
    const scriptCmd = buildSPMScriptCommand({
      projectPath,
      uploadSymbolsConfigurations,
      ...(configFilePath && { configFilePath }),
      ...(appGroupIdentifier && { appGroupIdentifier }),
      ...(uploadFrameworks && { uploadFrameworks })
    });
    await addBuildScriptPhaseWithRuby(pbxprojPath, targetName, 'Apptics pre build', scriptCmd);

    let resolutionSucceeded = false;
    try {
      const xcodeprojPath = pbxprojPath.replace(/\/project\.pbxproj$/, '');
      const xcodeprojName = path.basename(xcodeprojPath);
      const workspacePath = path.dirname(xcodeprojPath);
      
      try {
        const resolveCmd = `cd "${workspacePath}" && xcodebuild -project "${xcodeprojName}" -resolvePackageDependencies 2>&1`;
        const { stdout, stderr } = await execAsync(resolveCmd, {
          timeout: 180000
        });
        
        if (!stderr || (!stderr.includes('error') && !stderr.includes('Error'))) {
          resolutionSucceeded = true;
        }
      } catch (resolveError: any) {
        const stderr = resolveError.stderr as string | undefined;
        const stdout = resolveError.stdout as string | undefined;
        
        if (stderr && (stderr.includes('error') || stderr.includes('Error'))) {
          throw resolveError;
        }
        if (stdout && (stdout.includes('error') || stdout.includes('Error'))) {
          throw resolveError;
        }
        
        resolutionSucceeded = true;
      }
    } catch (error: any) {
      throw error;
    }

    return {
      success: true,
      message: resolutionSucceeded 
        ? 'SPM package added and resolved successfully.'
        : 'SPM package added to project file. Package will be resolved when project is opened in Xcode.',
      packageRepositoryURL: 'https://github.com/zoho/Apptics-SP',
      packageProductName,
      requiresXcodeResolution: !resolutionSucceeded
    };
  } catch (error: any) {
    throw new Error(`Failed to add SPM package: ${error.message}`);
  }
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
    await assertTargetHasProductDependency(projectPath, tgt, spmProductName ?? 'AppticsAnalytics');
  }

  // Safety net: make sure every target declares the AppticsAnalytics product dependency
  // in packageProductDependencies, even if the package/product IDs already existed.
  try {
      for (const tgt of targets) {
      await assertTargetHasProductDependency(projectPath, tgt, spmProductName ?? 'AppticsAnalytics');
    }
  } catch {
    // best-effort guard; ignore if it fails
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

