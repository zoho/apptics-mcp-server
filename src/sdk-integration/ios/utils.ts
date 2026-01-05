/**
 * Shared utilities for iOS SDK integration
 */

import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Generate a 24-character hex ID for Xcode project entries
 */
export function genId(): string {
  return Array.from({ length: 24 }, () => 
    '0123456789ABCDEF'[Math.floor(Math.random() * 16)]
  ).join('');
}

/**
 * Escape special regex characters in a string
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find the project.pbxproj file in the given project path
 */
export async function findPbxprojFile(projectPath: string): Promise<string> {
  const entries = await fs.readdir(projectPath);
  const xcodeproj = entries.find(f => f.endsWith('.xcodeproj'));
  
  if (!xcodeproj) {
    throw new Error(`No .xcodeproj found under ${projectPath}`);
  }
  
  return path.join(projectPath, xcodeproj, 'project.pbxproj');
}

/**
 * Check if a file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find a field value within a braced structure, handling nested braces.
 * 
 * In Xcode project files, structures look like:
 *   ID / * name * / = {
 *     isa = StructureType;
 *     fieldName = "value";
 *   }
 * 
 * This function finds structures where `isa = structureType` and extracts the field value.
 * 
 * @param content - The content to search in
 * @param structureType - The isa type to find (e.g., 'PBXFileSystemSynchronizedRootGroup' or 'PBXNativeTarget')
 * @param fieldName - The field name to find (e.g., 'path' or 'name')
 * @returns The field value if found, null otherwise
 */
export function findFieldInBracedStructure(
  content: string,
  structureType: string,
  fieldName: string
): string | null {
  const escapedType = escapeRegex(structureType);
  // Find structures that contain "isa = StructureType"
  // Pattern: ID /* comment */ = { ... isa = StructureType; ... }
  const isaPattern = new RegExp(`isa\\s*=\\s*${escapedType}\\s*;`, 'g');
  let isaMatch: RegExpMatchArray | null;

  while ((isaMatch = isaPattern.exec(content)) !== null) {
    if (isaMatch.index === undefined) continue;
    
    // Find the opening brace of this structure by going backwards
    // Look for the pattern: ID /* comment */ = {
    let braceStart = -1;
    for (let i = isaMatch.index; i >= 0; i--) {
      if (content[i] === '{') {
        // Check if this is the opening brace of our structure
        // Look backwards for "= {" pattern
        let j = i - 1;
        while (j >= 0 && /\s/.test(content[j]!)) j--; // Skip whitespace
        if (j >= 0 && content[j] === '=') {
          braceStart = i;
          break;
        }
      }
    }

    if (braceStart === -1) continue;

    // Find the matching closing brace, handling nested braces
    let braceDepth = 1; // We already found the opening brace
    let braceEnd = -1;
    for (let i = braceStart + 1; i < content.length; i++) {
      if (content[i] === '{') {
        braceDepth++;
      } else if (content[i] === '}') {
        braceDepth--;
        if (braceDepth === 0) {
          braceEnd = i;
          break;
        }
      }
    }

    if (braceEnd === -1) continue; // Unmatched braces

    // Search for the field within this structure
    const structureContent = content.slice(braceStart, braceEnd + 1);
    const escapedFieldName = escapeRegex(fieldName);
    const fieldPattern = new RegExp(`${escapedFieldName}\\s*=\\s*([^;]+);`);
    const fieldMatch = structureContent.match(fieldPattern);
    if (fieldMatch && fieldMatch[1]) {
      return fieldMatch[1].trim().replace(/^"|"$/g, '');
    }
  }

  return null;
}

