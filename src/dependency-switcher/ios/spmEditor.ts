/**
 * SPM editor for adding/removing Apptics SPM package references without regex or raw text editing.
 */

import { genId } from '../../sdk-integration/ios/utils';
import type { IOSLanguage } from './types';
import { openProject, getNativeTargets } from './xcodeProject';

const APPTICS_SPM_REPO_URL = 'https://github.com/zoho/Apptics-SP';
const APPTICS_PACKAGE_NAME = 'Apptics';

export async function removeAppticsSPMFromProject(
  pbxprojPath: string,
  spmProductName?: string
): Promise<void> {
  const parsed = await openProject(pbxprojPath);
  const objects = parsed.objects;
  const productName = spmProductName ?? 'AppticsAnalytics';

  const packageIds = findPackageReferenceIds(objects, APPTICS_SPM_REPO_URL);
  if (packageIds.length === 0 && !hasProductDependency(objects, productName)) {
    return;
  }
  
  deletePackageReferences(objects, packageIds);
  deleteProjectPackageRefs(objects, packageIds);
  deleteProductDependencies(objects, productName, packageIds);
  removeAppticsScripts(objects);

  await parsed.save();
}

export async function addAppticsSPMToProject(
  pbxprojPath: string,
  targetNames: string[],
  _language: IOSLanguage,
  spmProductName?: string
): Promise<void> {
  const parsed = await openProject(pbxprojPath);
  const objects = parsed.objects;
  const packageProductName = spmProductName ?? 'AppticsAnalytics';
  
  const packageRefId = ensurePackageReference(objects, APPTICS_SPM_REPO_URL);
  ensureProjectHasPackageRef(objects, packageRefId, APPTICS_PACKAGE_NAME);

  const productDependencyId = ensureProductDependency(objects, packageRefId, packageProductName);

  const targets = getNativeTargets(parsed.project);
  const missingTargets = targetNames.filter(
    (name) => !targets.some((t) => t.name === name)
  );
  if (missingTargets.length > 0) {
    throw new Error(`Target(s) not found: ${missingTargets.join(', ')}`);
  }

  targetNames.forEach((targetName) => {
    const target = targets.find((t) => t.name === targetName);
    if (!target) return;
    ensureTargetHasProductDependency(target.target, productDependencyId, packageProductName);
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

function deleteProductDependencies(objects: any, productName: string, packageIds: string[]): void {
  const productSection = objects.XCSwiftPackageProductDependency ?? {};

  const toRemove: string[] = [];
  Object.entries(productSection).forEach(([key, value]) => {
    if (key.endsWith('_comment')) return;
    const entry: any = value;
    const matchesProduct = normalize(entry.productName).toLowerCase() === productName.toLowerCase();
    const matchesPackage = entry.package && packageIds.includes(entry.package);
    if (matchesProduct || matchesPackage) {
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

function hasProductDependency(objects: any, productName: string): boolean {
  const section = objects.XCSwiftPackageProductDependency ?? {};
  return Object.entries(section).some(([key, value]) => {
    if (key.endsWith('_comment')) return false;
    const entry: any = value;
    return normalize(entry.productName).toLowerCase() === productName.toLowerCase();
  });
}

function normalize(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).split('"').join('');
  }
