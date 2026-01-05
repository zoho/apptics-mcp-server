/**
 * SPM editor for adding/removing Apptics SPM package references
 */

import * as fs from 'fs/promises';
import { findPbxprojFile } from '../../sdk-integration/ios/utils';
import { genId, escapeRegex } from '../../sdk-integration/ios/utils';
import type { IOSLanguage } from './types';

const APPTICS_SPM_REPO_URL = 'https://github.com/zoho/Apptics-SP';

/**
 * Remove Apptics SPM package references from project
 */
export async function removeAppticsSPMFromProject(
  pbxprojPath: string,
  spmProductName?: string
): Promise<void> {
  let content = await fs.readFile(pbxprojPath, 'utf-8');
  
  // Find Apptics package reference ID
  const packageRefPattern = new RegExp(
    `([A-F0-9]{24})\\s*/\\*\\s*Apptics\\s*\\*/\\s*=\\s*\\{[\\s\\S]*?repositoryURL\\s*=\\s*"${escapeRegex(APPTICS_SPM_REPO_URL)}";[\\s\\S]*?\\};`,
    'm'
  );
  const packageRefMatch = content.match(packageRefPattern);
  
  if (!packageRefMatch || !packageRefMatch[1]) {
    // Package reference not found - might already be removed
    // But check for product dependencies anyway
    const productName = spmProductName || 'AppticsAnalytics';
    removeProductDependencies(content, productName);
    await fs.writeFile(pbxprojPath, content, 'utf-8');
    return;
  }
  
  const packageRefId = packageRefMatch[1];
  const productName = spmProductName || 'AppticsAnalytics';
  
  // 1. Remove package reference entry
  content = content.replace(packageRefPattern, '');
  
  // 2. Remove from project-level packageReferences
  const projectPackageRefPattern = new RegExp(
    `(packageReferences\\s*=\\s*\\([\\s\\S]*?)(\\s*${escapeRegex(packageRefId)}\\s*/\\*\\s*Apptics\\s*\\*/[,\\s]*)([\\s\\S]*?\\);)`,
    'm'
  );
  content = content.replace(projectPackageRefPattern, (match, before, refLine, after) => {
    // Remove the reference line, clean up trailing commas
    let cleaned = before + after;
    // Fix double commas or leading commas
    cleaned = cleaned.replace(/,\s*,/g, ',');
    cleaned = cleaned.replace(/\(\s*,/g, '(');
    cleaned = cleaned.replace(/,\s*\)/g, ')');
    return cleaned;
  });
  
  // 3. Remove product dependencies from all targets
  content = removeProductDependencies(content, productName);
  
  // 4. Remove XCSwiftPackageProductDependency entries
  const productDepPattern = new RegExp(
    `\\t\\t[A-F0-9]{24}\\s*/\\*\\s*${escapeRegex(productName)}\\s*\\*/\\s*=\\s*\\{[\\s\\S]*?productName\\s*=\\s*${escapeRegex(productName)};[\\s\\S]*?\\};\\n`,
    'g'
  );
  content = content.replace(productDepPattern, '');
  
  // 5. Remove Apptics-related build script phases
  // Look for script phases with Apptics in the script content
  const scriptPhasePattern = /([A-F0-9]{24})\s*\/\*\s*([^*]+)\s*\/\*\s*=\s*\{[\s\S]*?isa\s*=\s*PBXShellScriptBuildPhase;[\s\S]*?shellScript\s*=\s*"([\s\S]*?)";[\s\S]*?\};/g;
  let scriptMatch: RegExpExecArray | null;
  const scriptPhaseIds: string[] = [];
  
  while ((scriptMatch = scriptPhasePattern.exec(content)) !== null) {
    const scriptContent = scriptMatch[3];
    const phaseId = scriptMatch[1];
    if (scriptContent && phaseId && /Apptics|apptics/.test(scriptContent)) {
      scriptPhaseIds.push(phaseId);
    }
  }
  
  // Remove script phase entries
  for (const phaseId of scriptPhaseIds) {
    const phasePattern = new RegExp(
      `\\t\\t${escapeRegex(phaseId)}\\s*\/\\*\\s*[^*]+\\s*\\*\/\\s*=\\s*\\{[\\s\\S]*?\\};\\n`,
      'g'
    );
    content = content.replace(phasePattern, '');
    
    // Remove from target buildPhases
    const buildPhasesPattern = new RegExp(
      `(buildPhases\\s*=\\s*\\([\\s\\S]*?)(\\s*${escapeRegex(phaseId)}\\s*\/\\*\\s*[^*]+\\s*\\*/[,\\s]*)([\\s\\S]*?\\);)`,
      'g'
    );
    content = content.replace(buildPhasesPattern, (match, before, phaseLine, after) => {
      let cleaned = before + after;
      cleaned = cleaned.replace(/,\s*,/g, ',');
      cleaned = cleaned.replace(/\(\s*,/g, '(');
      cleaned = cleaned.replace(/,\s*\)/g, ')');
      return cleaned;
    });
  }
  
  await fs.writeFile(pbxprojPath, content, 'utf-8');
}

/**
 * Remove product dependencies from all targets
 */
function removeProductDependencies(content: string, productName: string): string {
  // Find all packageProductDependencies blocks
  const depsPattern = /(packageProductDependencies\s*=\s*\()([\s\S]*?)(\)\s*;)/g;
  
  return content.replace(depsPattern, (match, open, depsBody, close) => {
    // Split dependencies and filter out Apptics
    const entries = depsBody
      .split(',')
      .map((s: string) => s.trim())
      .filter((s: string) => {
        // Remove entries that mention the product name
        return s.length > 0 && 
               !/^\)$/.test(s) && 
               !new RegExp(escapeRegex(productName), 'i').test(s) &&
               !/Apptics/i.test(s);
      });
    
    if (entries.length === 0) {
      // No dependencies left - remove the entire property
      return '';
    }
    
    // Rebuild the block
    return open + '\n' + 
           entries.map((e: string) => `\t\t\t\t${e.replace(/,$/, '')},`).join('\n') + 
           '\n\t\t\t' + close;
  });
}

/**
 * Add Apptics SPM package to project for specified targets
 * This reuses logic from iosIntegration.ts but adapted for the switcher
 */
export async function addAppticsSPMToProject(
  pbxprojPath: string,
  targetNames: string[],
  language: IOSLanguage,
  spmProductName?: string
): Promise<void> {
  let content = await fs.readFile(pbxprojPath, 'utf-8');
  const packageProductName = spmProductName || 'AppticsAnalytics';
  
  // Check if package already exists
  let packageExists = content.includes(APPTICS_SPM_REPO_URL);
  let existingPackageRefId: string | undefined;
  
  if (packageExists) {
    const packageRefPattern = new RegExp(
      `([A-F0-9]{24})\\s*\/\\*\\s*Apptics\\s*\\*\/\\s*=\\s*\\{[\\s\\S]*?repositoryURL\\s*=\\s*"${escapeRegex(APPTICS_SPM_REPO_URL)}";`,
      'm'
    );
    const packageRefMatch = content.match(packageRefPattern);
    if (packageRefMatch && packageRefMatch[1]) {
      existingPackageRefId = packageRefMatch[1];
    } else {
      packageExists = false;
    }
  }
  
  const packageRefId = existingPackageRefId || genId();
  const packageRefName = 'Apptics';
  
  // Add package reference if it doesn't exist
  if (!packageExists) {
    const packageRefEntry = `\t\t${packageRefId} /* ${packageRefName} */ = {\n` +
      `\t\t\tisa = XCRemoteSwiftPackageReference;\n` +
      `\t\t\trepositoryURL = "${APPTICS_SPM_REPO_URL}";\n` +
      `\t\t\trequirement = {\n` +
      `\t\t\t\tkind = upToNextMajorVersion;\n` +
      `\t\t\t\tminimumVersion = 1.0.0;\n` +
      `\t\t\t};\n` +
      `\t\t};\n`;
    
    const packageRefMarker = '/* End XCRemoteSwiftPackageReference section */';
    if (content.includes(packageRefMarker)) {
      content = content.replace(packageRefMarker, packageRefEntry + packageRefMarker);
    } else {
      // Create section after PBXProject
      const projectEndMarker = '/* End PBXProject section */';
      if (content.includes(projectEndMarker)) {
        const sectionHeader = '/* Begin XCRemoteSwiftPackageReference section */\n';
        content = content.replace(
          projectEndMarker,
          projectEndMarker + '\n' + sectionHeader + packageRefEntry + packageRefMarker
        );
      } else {
        throw new Error('Could not find suitable location to add XCRemoteSwiftPackageReference section');
      }
    }
    
    // Add to project-level packageReferences
    const projectPackageRefPattern = /(packageReferences\s*=\s*\()([\s\S]*?)(\);)/;
    const projectMatch = content.match(projectPackageRefPattern);
    
    if (projectMatch && projectMatch.index !== undefined) {
      const before = projectMatch[1];
      const existing = projectMatch[2] || '';
      const after = projectMatch[3];
      
      // Check if already in list
      if (!existing.includes(packageRefId)) {
        const newRefs = existing.trim() 
          ? `${existing.trim()}\n\t\t\t${packageRefId} /* ${packageRefName} */,`
          : `\n\t\t\t${packageRefId} /* ${packageRefName} */,`;
        content = content.replace(projectPackageRefPattern, before + newRefs + '\n\t\t' + after);
      }
    } else {
      // Create packageReferences at project level
      const projectPattern = /(rootObject\s*=\s*[A-F0-9]{24}\s*\/\*\s*Project\s*object\s*\/\*\/\s*=\s*\{[\s\S]*?)(\};)/;
      const rootMatch = content.match(projectPattern);
      if (rootMatch && rootMatch.index !== undefined) {
        const packageRefsBlock = `\n\t\tpackageReferences = (\n\t\t\t${packageRefId} /* ${packageRefName} */,\n\t\t);`;
        content = content.replace(projectPattern, rootMatch[1] + packageRefsBlock + rootMatch[2]);
      }
    }
  }
  
  // Find existing product dependency ID if package already exists
  let existingProductDepId: string | undefined;
  if (packageExists) {
    // Look for existing XCSwiftPackageProductDependency entry
    const existingProductDepPattern = new RegExp(
      `([A-F0-9]{24})\\s*\/\\*\\s*${escapeRegex(packageProductName)}\\s*\\*\/\\s*=\\s*\\{[\\s\\S]*?productName\\s*=\\s*${escapeRegex(packageProductName)};`,
      'm'
    );
    const existingProductDepMatch = content.match(existingProductDepPattern);
    if (existingProductDepMatch && existingProductDepMatch[1]) {
      existingProductDepId = existingProductDepMatch[1];
    }
  }
  
  // Generate or reuse product dependency ID
  // If package exists, try to find existing ID; otherwise generate one to reuse for all targets
  let productDependencyId = existingProductDepId;
  if (!productDependencyId) {
    productDependencyId = genId();
  }
  
  // Add product dependencies to each target
  for (const targetName of targetNames) {
    // Check if target already has this product dependency
    const targetHeaderPattern = new RegExp(
      `([A-F0-9]{24})\\s*\/\\*\\s*${escapeRegex(targetName)}\\s*\\*\/\\s*=\\s*\\{[\\s\\S]*?isa\\s*=\\s*PBXNativeTarget;`,
      'm'
    );
    const targetMatch = content.match(targetHeaderPattern);
    
    if (!targetMatch || !targetMatch.index) {
      throw new Error(`Target ${targetName} not found in project`);
    }
    
    const targetStart = targetMatch.index;
    const targetBlockStart = targetStart + targetMatch[0].length;
    
    // Find target block boundaries
    let braceDepth = 1;
    let targetBlockEnd = targetBlockStart;
    for (let i = targetBlockStart; i < content.length && braceDepth > 0; i++) {
      if (content[i] === '{') braceDepth++;
      if (content[i] === '}') braceDepth--;
      if (braceDepth === 0) {
        targetBlockEnd = i;
        break;
      }
    }
    
    const targetContent = content.slice(targetBlockStart, targetBlockEnd);
    const packageDepsPattern = /packageProductDependencies\s*=\s*\(([\s\S]*?)\)\s*;/;
    const packageDepsMatch = targetContent.match(packageDepsPattern);
    
    // Check if this target already has the product dependency
    const hasDependency = packageDepsMatch && packageDepsMatch[1] && 
      (packageDepsMatch[1].includes(packageProductName) || 
       (productDependencyId && packageDepsMatch[1].includes(productDependencyId)));
    
    if (!hasDependency) {
      // Target doesn't have the dependency - add it
      try {
        content = await addProductDependencyToTarget(content, targetName, packageRefId, packageProductName, productDependencyId);
        // Ensure the dependency is properly linked (double-check)
        content = ensureTargetHasProductDependency(content, targetName, packageProductName, productDependencyId);
      } catch (targetError: any) {
        throw new Error(`Failed to add product dependency to target ${targetName}: ${targetError.message}`);
      }
    }
  }
  
  // Ensure packageReferences exists at project level (always check, even if package existed)
  const projectPackageRefPattern = /(packageReferences\s*=\s*\()([\s\S]*?)(\);)/;
  const projectMatch = content.match(projectPackageRefPattern);
  
  if (!projectMatch) {
    // Create packageReferences at project level if it doesn't exist
    // Find PBXProject section - look for the pattern more flexibly
    const projectSectionPattern = /(isa\s*=\s*PBXProject;[\s\S]*?targets\s*=\s*\([\s\S]*?\);\s*)(\};)/;
    const rootMatch = content.match(projectSectionPattern);
    if (rootMatch && rootMatch.index !== undefined) {
      const packageRefsBlock = `\n\t\tpackageReferences = (\n\t\t\t${packageRefId} /* ${packageRefName} */,\n\t\t);`;
      content = content.replace(projectSectionPattern, rootMatch[1] + packageRefsBlock + rootMatch[2]);
    } else {
      // Fallback: find any PBXProject closing and insert before it
      const projectEndMarker = '/* End PBXProject section */';
      if (content.includes(projectEndMarker)) {
        const packageRefsBlock = `\n\t\tpackageReferences = (\n\t\t\t${packageRefId} /* ${packageRefName} */,\n\t\t);`;
        content = content.replace(projectEndMarker, packageRefsBlock + '\n' + projectEndMarker);
      }
    }
  } else {
    // Check if package reference is already in the list
    const existingRefs = projectMatch[2] || '';
    if (!existingRefs.includes(packageRefId)) {
      const before = projectMatch[1];
      const after = projectMatch[3];
      const newRefs = existingRefs.trim() 
        ? `${existingRefs.trim()}\n\t\t\t${packageRefId} /* ${packageRefName} */,`
        : `\n\t\t\t${packageRefId} /* ${packageRefName} */,`;
      content = content.replace(projectPackageRefPattern, before + newRefs + '\n\t\t' + after);
    }
  }
  
  // Write file once after all modifications
  await fs.writeFile(pbxprojPath, content, 'utf-8');
}

/**
 * Add product dependency to a specific target
 */
async function addProductDependencyToTarget(
  content: string,
  targetName: string,
  packageRefId: string,
  productName: string,
  productDependencyId: string
): Promise<string> {
  // Find target
  const targetHeaderPattern = new RegExp(
    `([A-F0-9]{24})\\s*\/\\*\\s*${escapeRegex(targetName)}\\s*\\*\/\\s*=\\s*\\{[\\s\\S]*?isa\\s*=\\s*PBXNativeTarget;`,
    'm'
  );
  const targetMatch = content.match(targetHeaderPattern);
  
  if (!targetMatch || !targetMatch.index || !targetMatch[1]) {
    throw new Error(`Target ${targetName} not found in project`);
  }
  
  const targetStart = targetMatch.index;
  const targetBlockStart = targetStart + targetMatch[0].length;
  
  // Find target block boundaries
  let braceDepth = 1;
  let targetBlockEnd = targetBlockStart;
  for (let i = targetBlockStart; i < content.length && braceDepth > 0; i++) {
    if (content[i] === '{') braceDepth++;
    if (content[i] === '}') braceDepth--;
    if (braceDepth === 0) {
      targetBlockEnd = i;
      break;
    }
  }
  
  const targetContent = content.slice(targetBlockStart, targetBlockEnd);
  const packageDepsPattern = /packageProductDependencies\s*=\s*\(([\s\S]*?)\)\s*;/;
  const packageDepsMatch = targetContent.match(packageDepsPattern);
  
  // Check if already exists with our specific ID
  if (packageDepsMatch && packageDepsMatch[1]) {
    const existingDeps = packageDepsMatch[1];
    // Check if this specific product dependency ID is already in the list
    if (existingDeps.includes(productDependencyId)) {
      // Already exists with this ID - just ensure the entry exists
      if (!content.includes(`${productDependencyId} /* ${productName} */ = {`)) {
        content = addProductDependencyEntry(content, productDependencyId, packageRefId, productName);
      }
      return content;
    }
    
    // Check if product name exists with a different ID - if so, we should still add our ID
    // (This allows multiple product dependencies if needed, though typically we want one)
    // For now, we'll add our ID to the list
    
    // Add to existing packageProductDependencies
    const depsStart = targetBlockStart + (packageDepsMatch.index || 0);
    const depsEnd = depsStart + packageDepsMatch[0].length;
    
    const entries = existingDeps
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !/^\)$/.test(s));
    
    // Check if product is already present (by name or ID)
    const hasProductName = entries.some(e => e.includes(`/* ${productName} */`));
    const hasProductId = entries.some(e => e.includes(productDependencyId));
    
    if (!hasProductName && !hasProductId) {
      // Add the dependency
      entries.push(`${productDependencyId} /* ${productName} */`);
      
      const normalizedBlock = 'packageProductDependencies = (\n' +
        entries.map(e => `\t\t\t\t${e.replace(/,$/, '')},`).join('\n') +
        '\n\t\t\t);';
      
      content = content.slice(0, depsStart) + normalizedBlock + content.slice(depsEnd);
    } else if (hasProductName && !hasProductId) {
      // Product name exists but with different ID - update to use our ID
      const existingDepPattern = new RegExp(
        `([A-F0-9]{24})\\s*\/\\*\\s*${escapeRegex(productName)}\\s*\\*\/`,
        'm'
      );
      const existingDepMatch = existingDeps.match(existingDepPattern);
      if (existingDepMatch && existingDepMatch[1] && existingDepMatch[1] !== productDependencyId) {
        // Replace entries that have the product name with our ID
        const updatedEntries = entries.map(e => {
          if (e.includes(`/* ${productName} */`)) {
            return `${productDependencyId} /* ${productName} */`;
          }
          return e;
        });
        
        const normalizedBlock = 'packageProductDependencies = (\n' +
          updatedEntries.map(e => `\t\t\t\t${e.replace(/,$/, '')},`).join('\n') +
          '\n\t\t\t);';
        content = content.slice(0, depsStart) + normalizedBlock + content.slice(depsEnd);
      }
    }
    // If both name and ID exist, nothing to do - already linked
  } else {
    // Create new packageProductDependencies
    const buildPhasesPattern = /buildPhases\s*=\s*\(([\s\S]*?)\)\s*;/;
    const buildPhasesMatch = targetContent.match(buildPhasesPattern);
    
    let insertPos: number;
    if (buildPhasesMatch && buildPhasesMatch.index !== undefined) {
      insertPos = targetBlockStart + buildPhasesMatch.index + buildPhasesMatch[0].length;
    } else {
      // Insert before closing brace
      insertPos = targetBlockEnd - 1;
    }
    
    const packageDepsBlock = `\n\t\t\tpackageProductDependencies = (\n\t\t\t\t${productDependencyId} /* ${productName} */,\n\t\t\t);`;
    content = content.slice(0, insertPos) + packageDepsBlock + content.slice(insertPos);
  }
  
  // Add XCSwiftPackageProductDependency entry if it doesn't exist
  content = addProductDependencyEntry(content, productDependencyId, packageRefId, productName);
  
  return content;
}

/**
 * Add XCSwiftPackageProductDependency entry
 */
function addProductDependencyEntry(
  content: string,
  productDependencyId: string,
  packageRefId: string,
  productName: string
): string {
  const productDepEntryPattern = new RegExp(
    `${escapeRegex(productDependencyId)}\\s*\/\\*\\s*${escapeRegex(productName)}\\s*\\*\/\\s*=\\s*\\{[\\s\\S]*?productName\\s*=\\s*${escapeRegex(productName)};`,
    'm'
  );
  
  if (productDepEntryPattern.test(content)) {
    return content; // Already exists
  }
  
  const productDepEntry = `\t\t${productDependencyId} /* ${productName} */ = {\n` +
    `\t\t\tisa = XCSwiftPackageProductDependency;\n` +
    `\t\t\tpackage = ${packageRefId} /* Apptics */;\n` +
    `\t\t\tproductName = ${productName};\n` +
    `\t\t};\n`;
  
  const productDepMarker = '/* End XCSwiftPackageProductDependency section */';
  if (content.includes(productDepMarker)) {
    return content.replace(productDepMarker, productDepEntry + productDepMarker);
  } else {
    const packageRefEndMarker = '/* End XCRemoteSwiftPackageReference section */';
    if (content.includes(packageRefEndMarker)) {
      const sectionHeader = '/* Begin XCSwiftPackageProductDependency section */\n';
      return content.replace(
        packageRefEndMarker,
        packageRefEndMarker + '\n' + sectionHeader + productDepEntry + productDepMarker
      );
    } else {
      const projectEndMarker = '/* End PBXProject section */';
      if (content.includes(projectEndMarker)) {
        const sectionHeader = '/* Begin XCSwiftPackageProductDependency section */\n';
        return content.replace(
          projectEndMarker,
          projectEndMarker + '\n' + sectionHeader + productDepEntry + productDepMarker
        );
      } else {
        throw new Error('Could not find suitable location to add XCSwiftPackageProductDependency section');
      }
    }
  }
}

/**
 * Ensure target has product dependency (verification and fix)
 */
function ensureTargetHasProductDependency(
  content: string,
  targetName: string,
  packageProductName: string,
  productDependencyId: string
): string {
  const targetHeaderPattern = new RegExp(
    `([A-F0-9]{24})\\s*\/\\*\\s*${escapeRegex(targetName)}\\s*\\*\/\\s*=\\s*\\{[\\s\\S]*?isa\\s*=\\s*PBXNativeTarget;`,
    'm'
  );
  const targetHeaderMatch = content.match(targetHeaderPattern);
  if (!targetHeaderMatch || targetHeaderMatch.index === undefined) {
    return content;
  }

  const targetStart = targetHeaderMatch.index;
  const targetBlockStart = targetStart + targetHeaderMatch[0].length;
  let braceDepth = 1;
  let targetBlockEnd = targetBlockStart;
  for (let i = targetBlockStart; i < content.length && braceDepth > 0; i++) {
    if (content[i] === '{') braceDepth++;
    if (content[i] === '}') braceDepth--;
    if (braceDepth === 0) {
      targetBlockEnd = i;
      break;
    }
  }

  const targetBlock = content.slice(targetBlockStart, targetBlockEnd);
  const packageDepsPattern = /packageProductDependencies\s*=\s*\(([\s\S]*?)\)\s*;/;
  const packageDepsMatch = targetBlock.match(packageDepsPattern);

  if (packageDepsMatch && packageDepsMatch.index !== undefined) {
    const depsStart = packageDepsMatch.index;
    const depsEnd = depsStart + packageDepsMatch[0].length;
    const depsBody = packageDepsMatch[1] ?? '';
    const entries = depsBody
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !/^\)$/.test(s));

    const hasId = entries.some((e) => e.includes(productDependencyId));
    const hasName = entries.some((e) => e.includes(packageProductName));
    const newEntries = hasId || hasName
      ? entries
      : [...entries, `${productDependencyId} /* ${packageProductName} */`];

    const normalizedBlock =
      'packageProductDependencies = (\n' +
      newEntries.map((e) => `\t\t\t\t${e.replace(/,$/, '')},`).join('\n') +
      '\n\t\t\t);';

    const absStart = targetBlockStart + depsStart;
    const absEnd = targetBlockStart + depsEnd;
    return content.slice(0, absStart) + normalizedBlock + content.slice(absEnd);
  } else {
    // Append new property before closing brace
    const insertionPoint = targetBlockEnd;
    const block =
      `\n\t\t\tpackageProductDependencies = (\n\t\t\t\t${productDependencyId} /* ${packageProductName} */,\n\t\t\t);\n`;
    return content.slice(0, insertionPoint) + block + content.slice(insertionPoint);
  }
}

