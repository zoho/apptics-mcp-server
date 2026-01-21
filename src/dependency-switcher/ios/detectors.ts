/**
 * Detection module for Apptics dependency state without regex or raw text parsing.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { findPbxprojFile, fileExists } from '../../sdk-integration/ios/utils';
import { readPodfileJSON } from './podfileEditor';
import { openProject } from './xcodeProject';
import type { DependencyState, DetectionResult } from './types';

const APPTICS_SPM_REPO_URL = 'https://github.com/zoho/Apptics-SP';

export async function detectAppticsDependency(projectPath: string): Promise<DetectionResult> {
  const resolvedPath = path.resolve(projectPath);
  const podfilePath = path.join(resolvedPath, 'Podfile');
  const hasPodfile = await fileExists(podfilePath);
  
  const { hasCocoaPods, appticsPodName } = hasPodfile
    ? await detectPods(podfilePath, resolvedPath)
    : { hasCocoaPods: false, appticsPodName: undefined };

  const pbxprojPath = await findPbxprojFileSafe(resolvedPath);
  const { hasSPM, spmPackageRefId } = pbxprojPath
    ? await detectSPM(pbxprojPath)
    : { hasSPM: false, spmPackageRefId: undefined };

  const state: DependencyState =
    hasCocoaPods && hasSPM
      ? 'both'
      : hasCocoaPods
      ? 'cocoapods'
      : hasSPM
      ? 'spm'
      : 'none';
  
  const details: DetectionResult['details'] = {
    ...(hasCocoaPods && { hasCocoaPods }),
    ...(hasSPM && { hasSPM }),
    ...(hasPodfile && { podfilePath }),
    ...(pbxprojPath && { pbxprojPath }),
    ...(appticsPodName && { appticsPodName }),
    ...(spmPackageRefId && { spmPackageRefId })
  };
  
  return {
    state,
    details
  };
}

async function detectPods(podfilePath: string, cwd: string): Promise<{ hasCocoaPods: boolean; appticsPodName?: string }> {
  try {
    const podfileJson = await readPodfileJSON(podfilePath, cwd);
    const names = collectPodDependencies(podfileJson.target_definitions);
    const match = names.find((name) => name.toLowerCase().startsWith('apptics-'));
    if (match) {
      return { hasCocoaPods: true, appticsPodName: match };
    }
    return { hasCocoaPods: false };
  } catch {
    return { hasCocoaPods: false };
  }
}

function collectPodDependencies(defs: any[]): string[] {
  const names: string[] = [];
  defs.forEach((def) => {
    const deps: any[] = def.dependencies ?? [];
    deps.forEach((dep) => {
      const name = dependencyName(dep);
      if (name) names.push(name);
    });
    if (def.children && def.children.length > 0) {
      names.push(...collectPodDependencies(def.children));
    }
  });
  return names;
}

function dependencyName(dep: unknown): string | undefined {
  if (typeof dep === 'string') return dep;
  if (Array.isArray(dep) && dep.length > 0 && typeof dep[0] === 'string') {
    return dep[0];
  }
  if (dep && typeof dep === 'object' && 'name' in dep && (dep as any).name) {
    return String((dep as any).name);
  }
  return undefined;
}

async function detectSPM(pbxprojPath: string): Promise<{ hasSPM: boolean; spmPackageRefId?: string }> {
  try {
    const parsed = await openProject(pbxprojPath);
    const objects = parsed.objects;
    const packageSection = objects.XCRemoteSwiftPackageReference ?? {};
    for (const [key, value] of Object.entries(packageSection)) {
      if (key.endsWith('_comment')) continue;
      const entry: any = value;
      const repo = normalize(entry.repositoryURL);
      if (repo === APPTICS_SPM_REPO_URL) {
        return { hasSPM: true, spmPackageRefId: key };
      }
    }

    const productSection = objects.XCSwiftPackageProductDependency ?? {};
    const hasProduct = Object.entries(productSection).some(([key, value]) => {
      if (key.endsWith('_comment')) return false;
      const entry: any = value;
      const product = normalize(entry.productName).toLowerCase();
      return product.includes('apptics');
    });

    if (hasProduct) {
      return { hasSPM: true };
    }
  } catch {
    // ignore
  }

  return { hasSPM: false };
}

async function findPbxprojFileSafe(projectPath: string): Promise<string | undefined> {
  try {
    return await findPbxprojFile(projectPath);
  } catch {
    return undefined;
  }
}

function normalize(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).split('"').join('');
}

