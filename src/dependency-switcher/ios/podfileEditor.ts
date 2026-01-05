/**
 * Podfile editor for adding/removing Apptics pods
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { fileExists } from '../../sdk-integration/ios/utils';
import type { IOSLanguage } from './types';

const APPTICS_POD_PATTERN = /pod\s+['"]Apptics-(?:SDK|Swift)['"]/i;

/**
 * Add Apptics pod to Podfile for specified targets
 */
export async function addAppticsPodToPodfile(
  podfilePath: string,
  targetNames: string[],
  language: IOSLanguage
): Promise<void> {
  const content = await fs.readFile(podfilePath, 'utf-8');
  const sdkPod = language === 'swift' ? 'Apptics-Swift' : 'Apptics-SDK';
  const podLine = `  pod '${sdkPod}'`;
  
  // Check if Apptics pod already exists
  if (APPTICS_POD_PATTERN.test(content)) {
    // Check if it's in the right targets - if not, we might need to add it
    // For now, if it exists anywhere, we'll assume it's configured
    return;
  }
  
  // Parse Podfile structure to find target blocks
  const targetBlocks = findTargetBlocks(content, targetNames);
  
  if (targetBlocks.length === 0) {
    throw new Error(`No matching target blocks found in Podfile for targets: ${targetNames.join(', ')}`);
  }
  
  let modifiedContent = content;
  
  // Add pod line to each target block
  for (const block of targetBlocks) {
    const { start, end, targetName } = block;
    const blockContent = content.slice(start, end);
    
    // Check if pod line already exists in this block
    if (APPTICS_POD_PATTERN.test(blockContent)) {
      continue;
    }
    
    // Find insertion point - after "use_frameworks!" or at the start of pod declarations
    let insertPos = -1;
    
    // Look for existing pod declarations
    const podMatch = blockContent.match(/^\s*pod\s+['"]/m);
    if (podMatch && podMatch.index !== undefined) {
      // Insert before first pod
      insertPos = start + podMatch.index;
    } else {
      // Look for "use_frameworks!" line
      const frameworksMatch = blockContent.match(/^\s*use_frameworks!\s*$/m);
      if (frameworksMatch && frameworksMatch.index !== undefined) {
        // Insert after use_frameworks!
        const lineEnd = blockContent.indexOf('\n', frameworksMatch.index);
        insertPos = start + (lineEnd !== -1 ? lineEnd + 1 : frameworksMatch.index + frameworksMatch[0].length);
      } else {
        // Insert after "do" line
        const doMatch = blockContent.match(/^\s*do\s*$/m);
        if (doMatch && doMatch.index !== undefined) {
          const lineEnd = blockContent.indexOf('\n', doMatch.index);
          insertPos = start + (lineEnd !== -1 ? lineEnd + 1 : doMatch.index + doMatch[0].length);
        } else {
          // Last resort: insert at start of block (after opening)
          insertPos = start + blockContent.indexOf('do') + 2;
        }
      }
    }
    
    if (insertPos === -1) {
      throw new Error(`Could not find insertion point in target block: ${targetName}`);
    }
    
    // Insert pod line with proper indentation
    const indent = getIndentationAt(content, insertPos);
    const lineToInsert = `${indent}pod '${sdkPod}'\n`;
    modifiedContent = modifiedContent.slice(0, insertPos) + lineToInsert + modifiedContent.slice(insertPos);
    
    // Update positions for subsequent blocks
    const offset = lineToInsert.length;
    const currentIndex = targetBlocks.indexOf(block);
    for (let i = currentIndex + 1; i < targetBlocks.length; i++) {
      const nextBlock = targetBlocks[i];
      if (nextBlock) {
        nextBlock.start += offset;
        nextBlock.end += offset;
      }
    }
  }
  
  await fs.writeFile(podfilePath, modifiedContent, 'utf-8');
}

/**
 * Remove Apptics pods from Podfile
 */
export async function removeAppticsPodFromPodfile(podfilePath: string): Promise<void> {
  const content = await fs.readFile(podfilePath, 'utf-8');
  
  // Check if Apptics pod exists
  if (!APPTICS_POD_PATTERN.test(content)) {
    // Even if pod doesn't exist, check for Apptics script phases and remove them
    const hasAppticsScript = /Apptics\s+pre\s+build/i.test(content);
    if (!hasAppticsScript) {
      return; // Nothing to remove
    }
  }
  
  let modifiedContent = content;
  
  // Remove all Apptics pod lines
  // Match: optional whitespace, "pod", whitespace, quote, "Apptics-", (SDK|Swift), quote, optional comma, newline
  const podLinePattern = /^\s*pod\s+['"]Apptics-(?:SDK|Swift)['"]\s*,?\s*$/gm;
  modifiedContent = modifiedContent.replace(podLinePattern, '');
  
  // Remove Apptics pre-build script phases
  // The script_phase is typically formatted as multi-line:
  //   # Pre build script will register the app version, upload dSYM file to the server
  //   # and add apptics specific information to the main info.plist which will be used by the SDK.
  //   script_phase :name => 'Apptics pre build',
  //                :script => 'sh "./Pods/Apptics-SDK/scripts/run" ...',
  //                :execution_position => :before_compile
  
  // Find and remove script_phase blocks that contain "Apptics pre build"
  // We'll use a more robust approach: find the start line, then match until execution_position
  
  // First, find all occurrences of script_phase with "Apptics pre build"
  const scriptPhaseStartPattern = /^\s*script_phase\s*:name\s*=>\s*['"]Apptics\s+pre\s+build['"]/gmi;
  let match: RegExpExecArray | null;
  
  // We need to process from end to start to maintain correct indices
  const matches: Array<{ start: number; end: number }> = [];
  while ((match = scriptPhaseStartPattern.exec(modifiedContent)) !== null) {
    if (match.index !== undefined) {
      const start = match.index;
      // Find the end of this script_phase block (the line with execution_position)
      let pos = start + match[0].length;
      let foundEnd = false;
      let end = pos;
      
      // Look for the execution_position line
      while (pos < modifiedContent.length && !foundEnd) {
        const lineEnd = modifiedContent.indexOf('\n', pos);
        const line = lineEnd !== -1 
          ? modifiedContent.slice(pos, lineEnd)
          : modifiedContent.slice(pos);
        
        if (/^\s*:execution_position\s*=>\s*:before_compile/.test(line)) {
          end = lineEnd !== -1 ? lineEnd + 1 : modifiedContent.length;
          foundEnd = true;
        } else if (lineEnd === -1) {
          // Reached end of file
          end = modifiedContent.length;
          foundEnd = true;
        } else {
          pos = lineEnd + 1;
        }
      }
      
      if (foundEnd) {
        matches.push({ start, end });
      }
    }
  }
  
  // Remove matches from end to start to maintain indices
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    if (match) {
      const { start, end } = match;
      modifiedContent = modifiedContent.slice(0, start) + modifiedContent.slice(end);
    }
  }
  
  // Remove comment lines about Apptics pre-build script (if they exist)
  // These are typically 1-2 lines before the script_phase
  const appticsCommentPattern = /^\s*#\s*Pre\s+build\s+script[^\n]*\n\s*#\s*and\s+add\s+apptics[^\n]*SDK\.\s*$/gmi;
  modifiedContent = modifiedContent.replace(appticsCommentPattern, '');
  
  // Also remove single comment line if it mentions Apptics pre-build
  const singleCommentPattern = /^\s*#\s*Pre\s+build\s+script[^\n]*(?:apptics|Apptics)[^\n]*SDK\.\s*$/gmi;
  modifiedContent = modifiedContent.replace(singleCommentPattern, '');
  
  // Remove any trailing commas on previous lines if Apptics pod was the last item
  // This is a simple cleanup - remove comma from line before if it's now empty or just whitespace
  modifiedContent = modifiedContent.replace(/(,\s*\n)(\s*\n)/g, '$2');
  
  // Clean up any empty lines that might have been left
  modifiedContent = modifiedContent.replace(/\n\s*\n\s*\n/g, '\n\n');
  
  await fs.writeFile(podfilePath, modifiedContent, 'utf-8');
}

/**
 * Find target blocks in Podfile content
 */
interface TargetBlock {
  start: number;
  end: number;
  targetName: string;
}

function findTargetBlocks(content: string, targetNames: string[]): TargetBlock[] {
  const blocks: TargetBlock[] = [];
  const targetPattern = /target\s+['"]([^'"]+)['"]\s+do/g;
  
  let match: RegExpExecArray | null;
  while ((match = targetPattern.exec(content)) !== null) {
    const targetName = match[1];
    
    if (!targetName) {
      continue;
    }
    
    // Check if this target is in our list (or if we're processing all targets)
    if (targetNames.length > 0 && !targetNames.includes(targetName)) {
      continue;
    }
    
    const start = match.index;
    if (start === undefined) {
      continue;
    }
    
    // Find matching "end" for this target block
    let depth = 1;
    let pos = match.index + match[0].length;
    let end = -1;
    
    while (pos < content.length && depth > 0) {
      if (content.slice(pos).startsWith('target')) {
        depth++;
        pos += 6;
      } else if (content.slice(pos).startsWith('end')) {
        depth--;
        if (depth === 0) {
          // Find the end of this "end" keyword
          const endMatch = content.slice(pos).match(/^end\b/);
          if (endMatch) {
            end = pos + endMatch[0].length;
          }
          break;
        }
        pos += 3;
      } else {
        pos++;
      }
    }
    
    if (end === -1) {
      // Couldn't find matching end - skip this block
      continue;
    }
    
    blocks.push({ start, end, targetName });
  }
  
  return blocks;
}

/**
 * Get indentation at a specific position in content
 */
function getIndentationAt(content: string, pos: number): string {
  // Find the start of the line
  let lineStart = pos;
  while (lineStart > 0 && content[lineStart - 1] !== '\n') {
    lineStart--;
  }
  
  // Count leading spaces/tabs
  let indent = '';
  let i = lineStart;
  while (i < content.length && (content[i] === ' ' || content[i] === '\t')) {
    indent += content[i];
    i++;
  }
  
  // If we're at the start of a line, use standard 2-space indent
  if (indent === '' && pos === lineStart) {
    return '  ';
  }
  
  return indent || '  ';
}

