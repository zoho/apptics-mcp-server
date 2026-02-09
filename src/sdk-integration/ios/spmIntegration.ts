import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { findPbxprojFile } from './utils';
import { assertTargetHasProductDependency, normalizeTargets } from './pbxprojUtils';
import { isFileSystemSyncedProject } from './xcodeProjectParser';
import { buildSPMScriptCommand, addBuildScriptPhaseWithRuby } from './buildScriptPhase';
import { addAppticsSPMToProject } from '../../dependency-switcher/ios/spmEditor';
import { getSPMProductNamesForTarget } from './appticsOptionalModules';

const execAsync = promisify(exec);
const { execFile } = require('child_process');
const execFileAsync = promisify(execFile);

async function addSPMPackageWithRuby(
  projectPath: string,
  targetName: string,
  productNames: string[]
): Promise<void> {
  if (productNames.length === 0) return;
  const pbxprojPath = await findPbxprojFile(projectPath);
  const xcodeprojPath = path.dirname(pbxprojPath);
  const script = `
    require 'xcodeproj'
    proj_path = ARGV.shift
    target_name = ARGV.shift
    product_names = ARGV
    
    project = Xcodeproj::Project.open(proj_path)
    target = project.targets.find { |t| t.name == target_name }
    raise "Target #{target_name} not found" unless target
    
    repo_url = 'https://github.com/zoho/Apptics-SP'
    pkg_ref = project.root_object.package_references.find { |ref| ref.repositoryURL == repo_url }
    unless pkg_ref
      pkg_ref = project.new(Xcodeproj::Project::Object::XCRemoteSwiftPackageReference)
      pkg_ref.repositoryURL = repo_url
      pkg_ref.requirement = { 'kind' => 'upToNextMajorVersion', 'minimumVersion' => '3.0.0' }
      project.root_object.package_references << pkg_ref
    end
    
    product_names.each do |product_name|
      existing_dep = target.package_product_dependencies.find { |dep| dep.product_name == product_name }
      unless existing_dep
        prod_dep = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
        prod_dep.product_name = product_name
        prod_dep.package = pkg_ref
        target.package_product_dependencies << prod_dep
      end
    end
    
    project.save
  `;
  await execFileAsync('ruby', ['-e', script, xcodeprojPath, targetName, ...productNames], {
    cwd: projectPath,
    maxBuffer: 5 * 1024 * 1024
  });
}

export async function addSPMPackage(params: {
  projectPath: string;
  targetName?: string;
  targetNames?: string | string[];
  language: 'swift' | 'objc';
  /** Override core product (default: AppticsAnalytics or AppticsAnalyticscoreWithKSCrash when crashKit requested). */
  spmProductName?: string;
  /** Optional module ids; SPM products are added per module (core + optional). */
  optionalModuleIds?: string[];
  /** NSE target names get only AppticsNotificationServiceExtension when notificationServiceExtension is requested. */
  notificationServiceExtensionTargetNames?: string[];
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
    optionalModuleIds = [],
    notificationServiceExtensionTargetNames = [],
    uploadSymbolsConfigurations = 'Release, Appstore',
    configFilePath,
    appGroupIdentifier,
    uploadFrameworks
  } = params;

  const targets = await normalizeTargets(projectPath, targetName, targetNames as string | string[]);

  if (targets.length === 0) {
    throw new Error('No target names provided for SPM integration.');
  }

  const targetProductMap: Record<string, string[]> = {};
  for (const tgt of targets) {
    const products = getSPMProductNamesForTarget(
      optionalModuleIds,
      language,
      tgt,
      notificationServiceExtensionTargetNames,
      spmProductName
    );
    if (products.length > 0) {
      targetProductMap[tgt] = products;
    }
  }

  const pbxprojPath = await findPbxprojFile(projectPath);
  const usesFsSync = await isFileSystemSyncedProject(projectPath);

  if (usesFsSync) {
    for (const tgt of targets) {
      const products = targetProductMap[tgt];
      if (products?.length) {
        await addSPMPackageWithRuby(projectPath, tgt, products);
      }
    }
  } else {
    await addAppticsSPMToProject(pbxprojPath, targetProductMap, language);
  }

  const scriptCmd = buildSPMScriptCommand({
    projectPath,
    uploadSymbolsConfigurations,
    ...(configFilePath && { configFilePath }),
    ...(appGroupIdentifier && { appGroupIdentifier }),
    ...(uploadFrameworks && { uploadFrameworks })
  });
  for (const tgt of targets) {
    if (targetProductMap[tgt]?.length) {
      await addBuildScriptPhaseWithRuby(pbxprojPath, tgt, 'Apptics pre build', scriptCmd);
    }
  }

  let resolutionSucceeded = false;
  try {
    const xcodeprojPath = pbxprojPath.replace(/\/project\.pbxproj$/, '');
    const xcodeprojName = path.basename(xcodeprojPath);
    const workspacePath = path.dirname(xcodeprojPath);
    const resolveCmd = `cd "${workspacePath}" && xcodebuild -project "${xcodeprojName}" -resolvePackageDependencies 2>&1`;
    const { stderr } = await execAsync(resolveCmd, { timeout: 180000 });
    if (!stderr || (!stderr.includes('error') && !stderr.includes('Error'))) {
      resolutionSucceeded = true;
    }
  } catch (resolveError: any) {
    const stderr = resolveError.stderr as string | undefined;
    const stdout = resolveError.stdout as string | undefined;
    if (stderr?.includes('error') || stdout?.includes('error')) {
      throw resolveError;
    }
    resolutionSucceeded = true;
  }

  for (const tgt of targets) {
    const products = targetProductMap[tgt] ?? [];
    for (const productName of products) {
      await assertTargetHasProductDependency(projectPath, tgt, productName);
    }
  }

  const firstTarget = targets[0];
  const coreProduct =
    (firstTarget !== undefined ? targetProductMap[firstTarget]?.[0] : undefined) ??
    spmProductName ??
    'AppticsAnalytics';
  return {
    success: true,
    message:
      targets.length > 1
        ? `SPM package added for targets: ${targets.join(', ')}`
        : resolutionSucceeded
          ? 'SPM package added and resolved successfully.'
          : 'SPM package added to project file. Package will be resolved when project is opened in Xcode.',
    packageRepositoryURL: 'https://github.com/zoho/Apptics-SP',
    packageProductName: coreProduct,
    requiresXcodeResolution: !resolutionSucceeded
  };
}

