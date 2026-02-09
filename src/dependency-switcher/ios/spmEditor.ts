/**
 * SPM editor for adding/removing Apptics SPM package references.
 */

import { genId, openProject, getNativeTargets } from '../../sdk-integration/ios/utils';
import type { IOSLanguage } from './types';

const APPTICS_SPM_REPO_URL = 'https://github.com/zoho/Apptics-SP';
const APPTICS_PACKAGE_NAME = 'Apptics';

export async function removeAppticsSPMFromProject(
  pbxprojPath: string,
  _spmProductName?: string
): Promise<void> {
  const parsed = await openProject(pbxprojPath);
  const objects = parsed.objects;

  const packageIds = findPackageReferenceIds(objects, APPTICS_SPM_REPO_URL);
  if (packageIds.length === 0) {
    return;
  }

  deletePackageReferences(objects, packageIds);
  deleteProjectPackageRefs(objects, packageIds);
  deleteProductDependenciesByPackage(objects, packageIds);
  removeAppticsScripts(objects);

  await parsed.save();
}

/**
 * Map of target name -> SPM product names to add from Apptics-SP (e.g. AppticsAnalytics, AppticsRemoteConfig).
 * Main targets get core + optional products; NSE targets get only AppticsNotificationServiceExtension when requested.
 */
export async function addAppticsSPMToProject(
  pbxprojPath: string,
  targetProductMap: Record<string, string[]>,
  _language: IOSLanguage
): Promise<void> {
  const parsed = await openProject(pbxprojPath);
  const objects = parsed.objects;
  const targetNames = Object.keys(targetProductMap).filter((name) => (targetProductMap[name]?.length ?? 0) > 0);

  if (targetNames.length === 0) {
    return;
  }

  const packageRefId = ensurePackageReference(objects, APPTICS_SPM_REPO_URL);
  ensureProjectHasPackageRef(objects, packageRefId, APPTICS_PACKAGE_NAME);

  const targets = getNativeTargets(parsed.project);
  const missingTargets = targetNames.filter(
    (name) => !targets.some((t) => t.name === name)
  );
  if (missingTargets.length > 0) {
    throw new Error(`Target(s) not found: ${missingTargets.join(', ')}`);
  }

  targetNames.forEach((targetName) => {
    const target = targets.find((t) => t.name === targetName);
    const productNames = targetProductMap[targetName] ?? [];
    if (!target || productNames.length === 0) return;
    productNames.forEach((productName) => {
      const productDependencyId = ensureProductDependency(objects, packageRefId, productName);
      ensureTargetHasProductDependency(target.target, productDependencyId, productName);
    });
  });

  await parsed.save();
}

function findPackageReferenceIds(objects: any, repoUrl: string): string[] {
  const section = objects.XCRemoteSwiftPackageReference ?? {};
  const ids: string[] = [];
  Object.entries(section).forEach(([key, value]) => {
    if (key.endsWith('_comment')) return;
    const entry: any = value;
    const url = normalize(entry.repositoryURL);
    if (url === repoUrl) {
      ids.push(key);
    }
  });
  return ids;
}

function deletePackageReferences(objects: any, packageIds: string[]): void {
  const section = objects.XCRemoteSwiftPackageReference ?? {};
  packageIds.forEach((id) => {
    delete section[id];
  });
  objects.XCRemoteSwiftPackageReference = section;
      }

function deleteProjectPackageRefs(objects: any, packageIds: string[]): void {
  const projectSection = objects.PBXProject ?? {};
  Object.values(projectSection).forEach((project: any) => {
    if (!project || typeof project !== 'object' || project.packageReferences === undefined) return;
    const refs = project.packageReferences as Array<{ value: string; comment?: string }>;
    const filtered = (refs ?? []).filter((ref) => !packageIds.includes(ref.value));
    project.packageReferences = filtered;
  });
}

/** Remove all SPM product dependencies that reference the given package refs (e.g. Apptics-SP). */
function deleteProductDependenciesByPackage(objects: any, packageIds: string[]): void {
  const productSection = objects.XCSwiftPackageProductDependency ?? {};

  const toRemove: string[] = [];
  Object.entries(productSection).forEach(([key, value]) => {
    if (key.endsWith('_comment')) return;
    const entry: any = value;
    const matchesPackage = entry.package && packageIds.includes(entry.package);
    if (matchesPackage) {
      toRemove.push(key);
    }
  });

  toRemove.forEach((id) => delete productSection[id]);

  const nativeTargets = objects.PBXNativeTarget ?? {};
  Object.values(nativeTargets).forEach((target: any) => {
    if (!target || typeof target !== 'object') return;
    const deps = target.packageProductDependencies as Array<{ value: string; comment?: string }> | undefined;
    if (!deps) return;
    target.packageProductDependencies = deps.filter((dep) => !toRemove.includes(dep.value));
  });
}

function removeAppticsScripts(objects: any): void {
  const scripts = objects.PBXShellScriptBuildPhase ?? {};
  const idsToDelete: string[] = [];
  Object.entries(scripts).forEach(([key, value]) => {
    if (key.endsWith('_comment')) return;
    const entry: any = value;
    const script = normalize(entry.shellScript).toLowerCase();
    const name = normalize(entry.name).toLowerCase();
    if (script.includes('apptics') || name.includes('apptics')) {
      idsToDelete.push(key);
}
  });

  idsToDelete.forEach((id) => delete scripts[id]);

  const nativeTargets = objects.PBXNativeTarget ?? {};
  Object.values(nativeTargets).forEach((target: any) => {
    if (!target || typeof target !== 'object') return;
    const phases = target.buildPhases as Array<{ value: string; comment?: string }> | undefined;
    if (!phases) return;
    target.buildPhases = phases.filter((phase) => !idsToDelete.includes(phase.value));
  });
}

function ensurePackageReference(objects: any, repoUrl: string): string {
  const section = objects.XCRemoteSwiftPackageReference ?? {};
  let existingId: string | undefined;
  Object.entries(section).forEach(([key, value]) => {
    if (key.endsWith('_comment')) return;
    const entry: any = value;
    const url = normalize(entry.repositoryURL);
    if (url === repoUrl) {
      existingId = key;
    }
  });

  if (existingId) {
    return existingId;
  }

  const id = genId();
  section[id] = {
    isa: 'XCRemoteSwiftPackageReference',
    repositoryURL: repoUrl,
    requirement: {
      kind: 'upToNextMajorVersion',
      minimumVersion: '3.0.0'
    }
  };

  objects.XCRemoteSwiftPackageReference = section;
  return id;
}

function ensureProjectHasPackageRef(objects: any, packageRefId: string, comment: string): void {
  const projectSection = objects.PBXProject ?? {};
  Object.values(projectSection).forEach((project: any) => {
    if (!project || typeof project !== 'object') return;
    const refs = (project.packageReferences as Array<{ value: string; comment?: string }>) ?? [];
    const already = refs.some((ref) => ref.value === packageRefId);
    if (!already) {
      refs.push({ value: packageRefId, comment });
      project.packageReferences = refs;
    }
  });
  }
  
function ensureProductDependency(objects: any, packageRefId: string, productName: string): string {
  const section = objects.XCSwiftPackageProductDependency ?? {};
  let existingId: string | undefined;
  Object.entries(section).forEach(([key, value]) => {
    if (key.endsWith('_comment')) return;
    const entry: any = value;
    if (
      normalize(entry.productName).toLowerCase() === productName.toLowerCase() &&
      normalize(entry.package).length > 0
    ) {
      existingId = key;
    }
  });

  if (existingId) {
    return existingId;
  }

  const id = genId();
  section[id] = {
    isa: 'XCSwiftPackageProductDependency',
    productName,
    package: packageRefId
  };
  objects.XCSwiftPackageProductDependency = section;
  return id;
}

function ensureTargetHasProductDependency(target: any, productDependencyId: string, productName: string): void {
  const deps = (target.packageProductDependencies as Array<{ value: string; comment?: string }>) ?? [];
  const already = deps.some((dep) => dep.value === productDependencyId);
  if (!already) {
    deps.push({ value: productDependencyId, comment: productName });
    target.packageProductDependencies = deps;
  }
}

function normalize(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).split('"').join('');
}

/**
 * Returns Apptics SPM product names currently linked in the project (from Apptics-SP).
 * Used when switching to CocoaPods to add the same modules via pods.
 */
export async function getAppticsSPMProductNamesFromProject(pbxprojPath: string): Promise<string[]> {
  const parsed = await openProject(pbxprojPath);
  const objects = parsed.objects;
  const packageIds = findPackageReferenceIds(objects, APPTICS_SPM_REPO_URL);
  if (packageIds.length === 0) return [];

  const productNames = new Set<string>();
  const section = objects.XCSwiftPackageProductDependency ?? {};
  Object.entries(section).forEach(([key, value]) => {
    if (key.endsWith('_comment')) return;
    const entry: any = value;
    if (entry.package && packageIds.includes(entry.package)) {
      const name = normalize(entry.productName);
      if (name) productNames.add(name);
    }
  });
  return Array.from(productNames);
}
