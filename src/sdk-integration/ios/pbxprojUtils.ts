import * as fs from 'fs/promises';
import * as path from 'path';
import { fileExists, findPbxprojFile, genId } from './utils';
import { openProject, getNativeTargets } from '../../dependency-switcher/ios/xcodeProject';

export type AppEntryPoint = 'appDelegate' | 'swiftUI';

export type AppticsInitConfig = {
  sendDataOnMobileNetworkByDefault?: boolean;
  trackOnByDefault?: boolean;
  anonymousType?: 'pseudoAnonymous' | 'nonAnonymous';
};

export const MIN_XCODE_VERSION = '9.0';
export const MIN_COCOAPODS_VERSION = '1.5.3';
export const MIN_IOS_DEPLOYMENT_TARGET = '11.0';
export const MIN_SWIFT_VERSION = '4.0';

export async function isFileSystemSyncedProject(projectPath: string): Promise<boolean> {
  try {
    const pbxprojPath = await findPbxprojFile(projectPath);
    const content = await fs.readFile(pbxprojPath, 'utf-8');
    return /PBXFileSystemSynchronizedRootGroup/.test(content) || /objectVersion\s*=\s*77/.test(content);
  } catch {
    return false;
  }
}

export async function listAllNativeTargets(projectPath: string): Promise<string[]> {
  const pbxprojPath = await findPbxprojFile(projectPath);
  const parsed = await openProject(pbxprojPath);
  return getNativeTargets(parsed.project).map((t) => t.name);
}

export async function normalizeTargets(
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

function normalizeVersionParts(version: string): number[] {
  return version
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((part) => Number.parseInt(part, 10));
}

export function isVersionAtLeast(current: string, minimum: string): boolean {
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

export async function findFileByPredicate(
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

export async function findSwiftUIAppFileForTargetFolder(targetFolder: string): Promise<string | undefined> {
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

export async function findAppDelegateFileForTargetFolder(targetFolder: string): Promise<string | undefined> {
  const isAppDelegate = (name: string) =>
    name.endsWith('AppDelegate.swift') || name.endsWith('AppDelegate.m') || name.endsWith('AppDelegate.mm');

  return findFileByPredicate(targetFolder, async (candidate) => {
    return isAppDelegate(candidate);
  });
}

export async function resolveEntryFileForTarget(
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

  return fallbackEntry;
}

export async function ensureTargetHasProductDependency(
  projectPath: string,
  targetName: string,
  packageProductName: string,
  productDependencyId?: string
): Promise<void> {
  const pbxprojPath = await findPbxprojFile(projectPath);
  const parsed = await openProject(pbxprojPath);
  const objects = parsed.objects;
  const targets = getNativeTargets(parsed.project);
  const target = targets.find((t) => t.name === targetName);
  if (!target) {
    throw new Error(`Target ${targetName} not found`);
  }

  const productSection = objects.XCSwiftPackageProductDependency ?? {};
  let depId = productDependencyId;
  if (!depId) {
    depId = Object.entries(productSection).find(([key, value]) => {
      if (key.endsWith('_comment')) return false;
      const entry: any = value;
      const name = String(entry.productName ?? '').toLowerCase();
      return name === packageProductName.toLowerCase();
    })?.[0];
  }
  if (!depId) {
    depId = genId();
    productSection[depId] = {
      isa: 'XCSwiftPackageProductDependency',
      productName: packageProductName
    };
    objects.XCSwiftPackageProductDependency = productSection;
  }

  const deps: Array<{ value: string; comment?: string }> =
    (target.target.packageProductDependencies as Array<{ value: string; comment?: string }>) ?? [];
  const already = deps.some((d) => d.value === depId);
  if (!already) {
    deps.push({ value: depId, comment: packageProductName });
    target.target.packageProductDependencies = deps;
  }

  await parsed.save();
}

export async function assertTargetHasProductDependency(
  projectPath: string,
  targetName: string,
  packageProductName: string
): Promise<void> {
  const pbxprojPath = await findPbxprojFile(projectPath);
  const parsed = await openProject(pbxprojPath);
  const objects = parsed.objects;
  const targets = getNativeTargets(parsed.project);
  const target = targets.find((t) => t.name === targetName);
  if (!target) {
    throw new Error(`Target ${targetName} not found after SPM integration`);
  }
  const deps: Array<{ value: string; comment?: string }> =
    (target.target.packageProductDependencies as Array<{ value: string; comment?: string }>) ?? [];
  const productSection = objects.XCSwiftPackageProductDependency ?? {};
  const has = deps.some((dep) => {
    const entry = productSection[dep.value];
    const name = entry ? String(entry.productName ?? '').toLowerCase() : '';
    return name === packageProductName.toLowerCase();
  });
  if (!has) {
    throw new Error(`SPM product dependency ${packageProductName} not linked to target ${targetName}`);
  }
}

