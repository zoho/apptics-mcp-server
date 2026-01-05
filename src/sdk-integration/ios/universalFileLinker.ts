/**
 * Universal File Linker for Xcode Projects
 * 
 * Creates source files and properly links them into Xcode project files (project.pbxproj).
 * This replaces the Python script to eliminate the Python dependency.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { genId, escapeRegex, findPbxprojFile, fileExists, findFieldInBracedStructure } from './utils';

interface LinkerParams {
  projectPath: string;
  fileContent: string;
  fileName: string;
  folderRelativeToProject: string;
  overwrite: boolean;
  targets?: string[];
}

function findExistingFileRefId(content: string, fileName: string): string | undefined {
  const re = new RegExp(`\\t\\t([A-F0-9]{24}) /\\* ${escapeRegex(fileName)} \\*/ = \\{isa = PBXFileReference;`, 'm');
  const m = content.match(re);
  return m?.[1];
}

async function ensureFile(
  projectPath: string,
  folderRel: string,
  fileName: string,
  content: string,
  overwrite: boolean
): Promise<string> {
  const folder = folderRel ? path.join(projectPath, folderRel) : projectPath;
  await fs.mkdir(folder, { recursive: true });
  
  const dest = path.join(folder, fileName);
  
  if (await fileExists(dest) && !overwrite) {
    return dest;
  }
  
  await fs.writeFile(dest, content, 'utf-8');
  return dest;
}

function ensureSectionMarkers(content: string, sectionName: string): string {
  const beginMarker = `/* Begin ${sectionName} section */`;
  const endMarker = `/* End ${sectionName} section */`;

  if (content.includes(beginMarker) && content.includes(endMarker)) {
    return content;
  }

  // Insert stub section just before the closing of the objects dictionary (before the "};" that precedes rootObject)
  const objectsClosePattern = /\n\s*\};\s*\n\s*rootObject/;
  const match = content.match(objectsClosePattern);
  const insertPos = match && match.index !== undefined ? match.index + 1 : content.length;

  const stub = `\n${beginMarker}\n${endMarker}\n`;
  return content.slice(0, insertPos) + stub + content.slice(insertPos);
}



function removeExisting(content: string, fileName: string, groupName?: string, folderRel?: string): string {
  // Step 1: Find and remove PBXFileReference entries
  const fileRefRe = new RegExp(
    `\t\t([A-F0-9]{24}) /\\* ${escapeRegex(fileName)} \\*/ = {[^}]+};\\n`,
    'g'
  );
  const fileIds: string[] = [];
  let match;
  
  while ((match = fileRefRe.exec(content)) !== null) {
    if (match[1]) {
      fileIds.push(match[1]);
    }
  }
  content = content.replace(fileRefRe, '');

  // Step 2: Remove PBXBuildFile entries that point to those refs
  const buildIds: string[] = [];
  if (fileIds.length > 0) {
    const idPat = fileIds.join('|');
    const buildRe = new RegExp(
      `\t\t([A-F0-9]{24}) /\\* ${escapeRegex(fileName)} in Sources \\*/ = ` +
      `{isa = PBXBuildFile; fileRef = (${idPat}) /\\* .*? \\*/; };\\n`,
      'g'
    );
    
    while ((match = buildRe.exec(content)) !== null) {
      if (match[1]) {
        buildIds.push(match[1]);
      }
    }
    content = content.replace(buildRe, '');

    // Step 3: Remove file refs from ALL PBXGroup children arrays
    for (const fid of fileIds) {
      const groupPattern = new RegExp(
        `(([A-F0-9]{24})(?: /\\* [^*]+ \\*/)? = \\{[\\s\\S]*?isa = PBXGroup;[\\s\\S]*?children = \\(([\\s\\S]*?)\\);)`,
        'g'
      );
      
      content = content.replace(groupPattern, (match, fullMatch, groupId, childrenContent) => {
        // Remove the file ID from children_content
        let cleaned = childrenContent.replace(
          new RegExp(`\\s*${escapeRegex(fid)}\\s*/\\*\\s*${escapeRegex(fileName)}\\s*\\*/,?\\s*\\n?`, 'g'),
          ''
        );
        // Also remove if on same line as closing
        cleaned = cleaned.replace(
          new RegExp(`\\s*${escapeRegex(fid)}\\s*/\\*\\s*${escapeRegex(fileName)}\\s*\\*/,?\\s*\\);`, 'g'),
          ');'
        );
        // Remove trailing blank lines
        cleaned = cleaned.replace(/\s+$/, '');
        
        return fullMatch.replace(childrenContent, cleaned);
      });
    }

    // Step 4: Remove build file refs from Sources build phases
    for (const bid of buildIds) {
      const pattern = new RegExp(
        `(\t\t\t\t)${escapeRegex(bid)}\\s*/\\*\\s*${escapeRegex(fileName)}\\s*in\\s*Sources\\s*\\*/,?\\s*\\n`,
        'g'
      );
      content = content.replace(pattern, '');
    }
  }

  // Cleanup fallback: remove any stray PBXBuildFile entries/comments for this file name even if fileRef/buildIds were not resolved
  content = content.replace(
    new RegExp(`\\t\\t[A-F0-9]{24} /\\* ${escapeRegex(fileName)} in Sources \\*/ = {[^}]+};\\s*\\n?`, 'g'),
    ''
  );

  // Cleanup fallback: remove any stray references in Sources phases regardless of buildIds
  content = content.replace(
    new RegExp(
      `(\\t\\t\\t\\t)[A-F0-9]{24}\\s*/\\*\\s*${escapeRegex(fileName)}\\s*in\\s*Sources\\s*\\*/[^\\n]*\\n?`,
      'g'
    ),
    ''
  );

  // Step 5: Remove any orphan AppticsManager group children if present
  const orphanGroupChild = new RegExp(`\\s*[A-F0-9]{24}\\s*/\\*\\s*AppticsManager\\s*\\*/,?\\s*\\n`, 'g');
  content = content.replace(orphanGroupChild, '');

  // Step 6: Remove existing AppticsManager group block (to avoid malformed state) and its references
  if (groupName && folderRel) {
    const groupBlockRe = new RegExp(
      `\\t\\t([A-F0-9]{24}) /\\* ${escapeRegex(groupName)} \\*/ = \\{[\\s\\S]*?isa = PBXGroup;[\\s\\S]*?path = ${escapeRegex(folderRel)};[\\s\\S]*?sourceTree = "<group>";\\s*\\t\\t\\};\\n`,
      'g'
    );
    const groupIds: string[] = [];
    let gm;
    while ((gm = groupBlockRe.exec(content)) !== null) {
      if (gm[1]) {
        groupIds.push(gm[1]);
      }
    }
    content = content.replace(groupBlockRe, '');

    if (groupIds.length > 0) {
      const gidPat = groupIds.map(escapeRegex).join('|');
      const childRefRe = new RegExp(`\\s*(?:${gidPat}) /\\* ${escapeRegex(groupName)} \\*/,?\\n`, 'g');
      content = content.replace(childRefRe, '');
    }
  }

  return content;
}

function findMainGroup(content: string): string {
  const m = content.match(/mainGroup = ([A-F0-9]{24});/);
  if (!m || !m[1]) {
    throw new Error('mainGroup not found in pbxproj');
  }
  return m[1];
}

function ensureGroup(
  content: string,
  folderRel: string,
  parentGroupId: string
): [string, string] {
  const groupName = folderRel.split('/').pop() || '';
  if (!groupName) {
    return [content, parentGroupId];
  }

  const groupRe = new RegExp(
    `([A-F0-9]{24}) /\\* ${escapeRegex(groupName)} \\*/ = \\{[\\s\\S]*?isa = PBXGroup;[\\s\\S]*?path = ${escapeRegex(folderRel)};[\\s\\S]*?sourceTree = "<group>";\\n\t\t};`,
    'm'
  );
  const m = content.match(groupRe);
  let groupId = m ? m[1] : null;

  if (!groupId) {
    // Create new group
    groupId = genId();
    const groupEntry =
      `\t\t${groupId} /* ${groupName} */ = {\n` +
      `\t\t\tisa = PBXGroup;\n` +
      `\t\t\tchildren = (\n` +
      `\t\t\t);\n` +
      `\t\t\tpath = ${folderRel};\n` +
      `\t\t\tsourceTree = "<group>";\n` +
      `\t\t};\n`;

    const marker = '/* End PBXGroup section */';
    if (!content.includes(marker)) {
      throw new Error('PBXGroup section not found');
    }
    content = content.replace(marker, groupEntry + marker);
  }

  // Always ensure the group is attached to parent group's children
  const parentRe = new RegExp(
    `(${escapeRegex(parentGroupId)})(?: /\\* [^*]+ \\*/)? = \\{[\\s\\S]*?isa = PBXGroup;[\\s\\S]*?children = \\(([\\s\\S]*?)\\);`,
    'm'
  );
  const pm = content.match(parentRe);
  if (pm && pm[2] && pm.index !== undefined) {
    const childrenBlock = pm[2];
    if (!childrenBlock.includes(groupId!)) {
      const start = pm.index + pm[0].indexOf(childrenBlock);
      const end = start + childrenBlock.length;
      let newChildrenBlock = childrenBlock.trim();
      if (newChildrenBlock) {
        newChildrenBlock = newChildrenBlock + `\n\t\t\t\t${groupId} /* ${groupName} */,`;
      } else {
        newChildrenBlock = `\n\t\t\t\t${groupId} /* ${groupName} */,`;
      }
      content = content.slice(0, start) + newChildrenBlock + content.slice(end);
    }
  } else {
    throw new Error(`parent group ${parentGroupId} not found`);
  }

  return [content, groupId];
}

function insertFileRef(
  content: string,
  fileRefId: string,
  fileName: string,
  relPath: string
): string {
  const entry =
    `\t\t${fileRefId} /* ${fileName} */ = ` +
    `{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; ` +
    `name = ${fileName}; path = ${relPath}; sourceTree = "<group>"; };\n`;
  const marker = '/* End PBXFileReference section */';
  if (!content.includes(marker)) {
    throw new Error('PBXFileReference section not found');
  }
  return content.replace(marker, entry + marker);
}

function insertIntoGroupChildren(
  content: string,
  groupId: string,
  fileRefId: string,
  fileName: string
): string {
  // Find the group entry - look for the group ID with optional comment
  const groupHeaderPattern = new RegExp(
    `(${escapeRegex(groupId)})(?: /\\* [^*]+ \\*/)? = \\{`
  );
  const headerMatch = content.match(groupHeaderPattern);
  
  if (!headerMatch || headerMatch.index === undefined) {
    return content;
  }

  // Find the children block within this group
  const groupStart = headerMatch.index;
  const groupBlockStart = groupStart + headerMatch[0].length;
  
  // Find the closing brace of this group to limit our search
  let braceDepth = 1;
  let groupBlockEnd = groupBlockStart;
  for (let i = groupBlockStart; i < content.length && braceDepth > 0; i++) {
    if (content[i] === '{') braceDepth++;
    if (content[i] === '}') braceDepth--;
    if (braceDepth === 0) {
      groupBlockEnd = i;
      break;
    }
  }

  const groupBlock = content.slice(groupBlockStart, groupBlockEnd);
  
  // Find children = ( within this group block
  const childrenMatch = groupBlock.match(/children\s*=\s*\(([\s\S]*?)\);/);
  
  if (!childrenMatch || childrenMatch.index === undefined || !childrenMatch[1]) {
    return content;
  }

  const childrenBlock = childrenMatch[1];
  
  // Check if file reference already exists
  if (childrenBlock.includes(fileRefId)) {
    return content;
  }

  // Calculate the absolute position of the children block end
  const childrenBlockStartInGroup = groupBlockStart + childrenMatch.index + childrenMatch[0].indexOf('(') + 1;
  const childrenBlockEndInContent = childrenBlockStartInGroup + childrenBlock.length;
  
  // Insert the file reference
  const line = childrenBlock.trim() ? 
    `\n\t\t\t\t${fileRefId} /* ${fileName} */,` :
    `\n\t\t\t\t${fileRefId} /* ${fileName} */,`;
  
  return content.slice(0, childrenBlockEndInContent) + line + content.slice(childrenBlockEndInContent);
}

function insertBuildFileAndSources(
  content: string,
  buildFileId: string,
  fileRefId: string,
  fileName: string,
  targets?: string[]
): string {
  const findSourcesPhaseIds = (source: string, targetNames: string[]): string[] => {
    const ids: string[] = [];

    const headerRe = /([A-F0-9]{24}) \/\* ([^*]+) \*\/ = \{/g;
    let m: RegExpExecArray | null;

    while ((m = headerRe.exec(source)) !== null) {
      const commentName = m[2]?.trim();
      const targetId = m[1];
      if (!commentName || !targetNames.some((t) => t === commentName)) {
        // Skip if this block isn't one of the requested targets
        continue;
      }

      // Walk braces from the start of this block
      const start = m.index + m[0].length;
      let depth = 1;
      let end = start;
      for (let i = start; i < source.length; i++) {
        const ch = source[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
      const block = source.slice(start, end);
      if (!/isa\s*=\s*PBXNativeTarget;/.test(block)) continue;

      // Match target name inside the block to avoid collisions with groups sharing the same comment
      const nameMatch = block.match(/name\s*=\s*([^;]+);/);
      const blockName = nameMatch?.[1]?.trim() ?? commentName;
      if (!targetNames.some((t) => t === blockName)) continue;

      const phasesMatch = block.match(/buildPhases\s*=\s*\(([\s\S]*?)\);/);
      const phasesBlock = phasesMatch?.[1] ?? '';
      const pm = phasesBlock.match(/([A-F0-9]{24}) \/\* Sources \*\//);
      if (pm && pm[1]) ids.push(pm[1]);
    }

    return ids;
  };

  // Add PBXBuildFile entry
  const entry =
    `\t\t${buildFileId} /* ${fileName} in Sources */ = ` +
    `{isa = PBXBuildFile; fileRef = ${fileRefId} /* ${fileName} */; };\n`;
  const marker = '/* End PBXBuildFile section */';
  if (!content.includes(marker)) {
    throw new Error('PBXBuildFile section not found');
  }
  content = content.replace(marker, entry + marker);

  // Attach into Sources build phases
  const phaseIds: string[] = [];
  if (targets) {
    phaseIds.push(...findSourcesPhaseIds(content, targets));
    // Respect explicit target selection: if nothing matched, do not fallback to all sources
    if (phaseIds.length === 0) {
      return content;
    }
  } else {
    const sourcesRe = /([A-F0-9]{24}) \/\* Sources \*\/ = \{/g;
    let m;
    while ((m = sourcesRe.exec(content)) !== null) {
      if (m[1]) {
        phaseIds.push(m[1]);
      }
    }
  }

  for (const sid of [...new Set(phaseIds)]) {
    const marker = `${sid} /* Sources */ = {`;
    const idx = content.indexOf(marker);
    if (idx === -1) continue;
    const filesIdx = content.indexOf('files = (', idx);
    if (filesIdx === -1) continue;
    const insertPos = content.indexOf(');', filesIdx);
    if (insertPos === -1) continue;

    const slice = content.slice(filesIdx, insertPos);
    if (slice.includes(fileName)) continue;

    const line = `\n\t\t\t\t${buildFileId} /* ${fileName} in Sources */,`;
    content = content.slice(0, insertPos) + line + content.slice(insertPos);
  }

  return content;
}

export async function linkFileToXcodeProject(params: LinkerParams): Promise<string> {
  const {
    projectPath,
    fileContent,
    fileName,
    folderRelativeToProject,
    overwrite,
    targets
  } = params;

  const resolvedProjectPath = path.resolve(projectPath);
  const pbxprojPath = await findPbxprojFile(resolvedProjectPath);
  
  let content = await fs.readFile(pbxprojPath, 'utf-8');
  
  // Check if project uses File System Synchronized Groups (Xcode 15+, objectVersion 77)
  const usesFileSystemSync = /PBXFileSystemSynchronizedRootGroup/.test(content) || 
                             /objectVersion\s*=\s*77/.test(content);
  
  // Place the file on disk
  const dest = await ensureFile(
    resolvedProjectPath,
    folderRelativeToProject,
    fileName,
    fileContent,
    overwrite
  );

  // Ensure legacy section markers exist so the rest of the linker can operate, even on objectVersion 77 projects
  content = ensureSectionMarkers(content, 'PBXFileReference');
  content = ensureSectionMarkers(content, 'PBXBuildFile');
  content = ensureSectionMarkers(content, 'PBXGroup');

  // Try to reuse existing file reference to preserve memberships in other targets
  const existingFileRefId = findExistingFileRefId(content, fileName);

  // Only clean if no existing ref is found (i.e., first time linking this file)
  if (!existingFileRefId) {
    content = removeExisting(content, fileName, folderRelativeToProject?.split('/').pop(), folderRelativeToProject);
  }

  const effectiveFileRefId = existingFileRefId ?? genId();
  const fileRefId = effectiveFileRefId;
  const buildFileId = genId();

  const mainGroupId = findMainGroup(content);
  const [updatedContent, groupId] = ensureGroup(content, folderRelativeToProject, mainGroupId);
  content = updatedContent;

  // When a PBXGroup has a path set, file references inside it should be relative to that path
  // So if group has path="AppticsManager", file ref should have path="AppticsManager.swift" (not "AppticsManager/AppticsManager.swift")
  const fileRefPath = fileName; // Relative to the group's path
  if (!existingFileRefId) {
    content = insertFileRef(content, effectiveFileRefId, fileName, fileRefPath);
  }
  content = insertIntoGroupChildren(content, groupId, effectiveFileRefId, fileName);
  content = insertBuildFileAndSources(content, buildFileId, fileRefId, fileName, targets);

  // Final verification: Ensure file is NOT in Products group
  const productsGroupMatch = content.match(/([A-F0-9]{24})\s*\/\*\s*Products\s*\*\/ = \{/);
  if (productsGroupMatch && productsGroupMatch[1]) {
    const productsGroupId = productsGroupMatch[1];
    const productsPattern = new RegExp(
      `(${escapeRegex(productsGroupId)}\\s*/\\*\\s*Products\\s*\\*/ = \\{[\\s\\S]*?children = \\()([\\s\\S]*?)(\\);)`,
      'm'
    );
    content = content.replace(productsPattern, (match, header, children, closing) => {
      // Remove file_ref_id if present
      let cleaned = children.replace(
        new RegExp(`\\s*${escapeRegex(fileRefId)}\\s*/\\*\\s*${escapeRegex(fileName)}\\s*\\*/,?\\s*\\n?`, 'g'),
        ''
      );
      cleaned = cleaned.replace(
        new RegExp(`\\s*${escapeRegex(fileRefId)}\\s*/\\*\\s*${escapeRegex(fileName)}\\s*\\*/,?\\s*\\);`, 'g'),
        ');'
      );
      cleaned = cleaned.replace(/\s+$/, '');
      return header + cleaned + closing;
    });
  }

  await fs.writeFile(pbxprojPath, content, 'utf-8');
  return dest;
}

