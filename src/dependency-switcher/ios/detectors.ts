/**
 * Detection module for Apptics dependency state
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { findPbxprojFile, fileExists } from '../../sdk-integration/ios/utils';
import type { DependencyState, DetectionResult } from './types';

const APPTICS_SPM_REPO_URL = 'https://github.com/zoho/Apptics-SP';
const APPTICS_POD_PATTERN = /pod\s+['"]Apptics-(?:SDK|Swift)['"]/i;

/**
 * Detect current Apptics dependency integration state
 */
export async function detectAppticsDependency(projectPath: string): Promise<DetectionResult> {
  const resolvedPath = path.resolve(projectPath);
  const podfilePath = path.join(resolvedPath, 'Podfile');
  const hasPodfile = await fileExists(podfilePath);
  
  let hasCocoaPods = false;
  let appticsPodName: string | undefined;
  
  if (hasPodfile) {
    try {
      const podfileContent = await fs.readFile(podfilePath, 'utf-8');
      const podMatch = podfileContent.match(APPTICS_POD_PATTERN);
      if (podMatch) {
        hasCocoaPods = true;
        // Extract pod name
        const fullMatch = podMatch[0];
        const nameMatch = fullMatch.match(/Apptics-(SDK|Swift)/i);
        if (nameMatch) {
          appticsPodName = nameMatch[0];
        }
      }
    } catch (error) {
      // Podfile exists but couldn't read it - treat as no CocoaPods
    }
  }
  
  let hasSPM = false;
  let spmPackageRefId: string | undefined;
  let pbxprojPath: string | undefined;
  
  try {
    pbxprojPath = await findPbxprojFile(resolvedPath);
    const pbxContent = await fs.readFile(pbxprojPath, 'utf-8');
    
    // Check for Apptics SPM package reference
    if (pbxContent.includes(APPTICS_SPM_REPO_URL)) {
      // Find the package reference ID
      const packageRefPattern = new RegExp(
        `([A-F0-9]{24})\\s*/\\*\\s*Apptics\\s*\\*/\\s*=\\s*\\{[\\s\\S]*?repositoryURL\\s*=\\s*"${escapeRegex(APPTICS_SPM_REPO_URL)}";`,
        'm'
      );
      const packageRefMatch = pbxContent.match(packageRefPattern);
      if (packageRefMatch && packageRefMatch[1]) {
        spmPackageRefId = packageRefMatch[1];
        hasSPM = true;
      } else {
        // URL exists but reference structure might be different - check for packageProductDependencies
        // Look for any target with Apptics product dependency
        const productDepPattern = /packageProductDependencies\s*=\s*\(([\s\S]*?)\);/g;
        let match: RegExpExecArray | null;
        while ((match = productDepPattern.exec(pbxContent)) !== null) {
          if (match[1] && /Apptics/.test(match[1])) {
            hasSPM = true;
            break;
          }
        }
      }
    }
    
    // Also check Package.resolved if it exists
    if (!hasSPM) {
      const packageResolvedPath = path.join(resolvedPath, '.swiftpm', 'Package.resolved');
      if (await fileExists(packageResolvedPath)) {
        try {
          const resolvedContent = await fs.readFile(packageResolvedPath, 'utf-8');
          if (resolvedContent.includes(APPTICS_SPM_REPO_URL) || resolvedContent.includes('Apptics')) {
            hasSPM = true;
          }
        } catch {
          // Ignore read errors
        }
      }
    }
  } catch (error) {
    // Couldn't find or read pbxproj - treat as no SPM
  }
  
  let state: DependencyState;
  if (hasCocoaPods && hasSPM) {
    state = 'both';
  } else if (hasCocoaPods) {
    state = 'cocoapods';
  } else if (hasSPM) {
    state = 'spm';
  } else {
    state = 'none';
  }
  
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

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

