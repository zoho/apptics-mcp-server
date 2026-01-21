/**
 * Universal File Linker for Xcode Projects
 * 
 * Creates source files and properly links them into Xcode project files (project.pbxproj).
 * This replaces the Python script to eliminate the Python dependency.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { genId, findPbxprojFile, fileExists } from './utils';
import { openProject, getNativeTargets } from '../../dependency-switcher/ios/xcodeProject';

interface LinkerParams {
  projectPath: string;
  fileContent: string;
  fileName: string;
  folderRelativeToProject: string;
  overwrite: boolean;
  targets?: string[];
}

async function ensureFileOnDisk(
  projectPath: string,
  folderRel: string,
  fileName: string,
  content: string,
  overwrite: boolean
): Promise<string> {
  const folder = folderRel ? path.join(projectPath, folderRel) : projectPath;
  await fs.mkdir(folder, { recursive: true });
  const dest = path.join(folder, fileName);
  if (!(await fileExists(dest)) || overwrite) {
    await fs.writeFile(dest, content, 'utf-8');
  }
  return dest;
}

function findGroupByPath(objects: any, segments: string[]): string | undefined {
  const groups = objects.PBXGroup ?? {};
  return Object.entries(groups).find(([key, value]) => {
    if (key.endsWith('_comment')) return false;
    const entry: any = value;
    const pathProp = entry.path ? String(entry.path) : '';
    const nameProp = entry.name ? String(entry.name) : '';
    return pathProp === segments.join('/') || nameProp === segments[segments.length - 1];
  })?.[0];
}

function ensureGroup(objects: any, mainGroupId: string, folderRel: string): string {
  if (!folderRel) return mainGroupId;
  const segments = folderRel.split('/').filter(Boolean);
  let currentId = mainGroupId;
  const groups = objects.PBXGroup ?? {};

  for (let i = 0; i < segments.length; i++) {
    const subPath = segments.slice(0, i + 1);
    const existing = findGroupByPath(objects, subPath);
    if (existing) {
      currentId = existing;
      continue;
  }
    const newId = genId();
    const name = segments[i];
    groups[newId] = {
      isa: 'PBXGroup',
      children: [],
      name,
      path: subPath.join('/'),
      sourceTree: '<group>'
    };

    // attach to parent
    const parent = groups[currentId];
    parent.children = parent.children || [];
    const already = parent.children.some((c: any) => c.value === newId);
    if (!already) {
      parent.children.push({ value: newId, comment: name });
      }
    currentId = newId;
    }

  objects.PBXGroup = groups;
  return currentId;
}

function ensureFileReference(
  objects: any,
  groupId: string,
  fileName: string,
  relPath: string
): string {
  const fileSection = objects.PBXFileReference ?? {};
  const existing = Object.entries(fileSection).find(([key, value]) => {
    if (key.endsWith('_comment')) return false;
    const entry: any = value;
    return entry.name === fileName || entry.path === relPath;
  });
  if (existing) {
    return existing[0];
  }

  const fileRefId = genId();
  fileSection[fileRefId] = {
    isa: 'PBXFileReference',
    lastKnownFileType: 'sourcecode.swift',
    name: fileName,
    path: relPath,
    sourceTree: '<group>'
  };
  objects.PBXFileReference = fileSection;

  const groups = objects.PBXGroup ?? {};
  const group = groups[groupId];
  group.children = group.children || [];
  group.children.push({ value: fileRefId, comment: fileName });
  groups[groupId] = group;
  objects.PBXGroup = groups;

  return fileRefId;
}

function findSourcesPhaseId(target: any): string | undefined {
  const phases: Array<{ value: string; comment?: string }> = target.buildPhases ?? [];
  return phases.find((p) => (p.comment ?? '').includes('Sources'))?.value;
    }

function ensureBuildFile(objects: any, fileRefId: string, fileName: string): string {
  const buildSection = objects.PBXBuildFile ?? {};
  const existing = Object.entries(buildSection).find(([key, value]) => {
    if (key.endsWith('_comment')) return false;
    const entry: any = value;
    return entry.fileRef === fileRefId;
  });
  if (existing) return existing[0];

  const buildId = genId();
  buildSection[buildId] = {
    isa: 'PBXBuildFile',
    fileRef: fileRefId,
    comment: `${fileName} in Sources`
  };
  objects.PBXBuildFile = buildSection;
  return buildId;
}

function ensureFileInSourcesPhase(
  objects: any,
  sourcesPhaseId: string,
  buildFileId: string,
  fileName: string
): void {
  const sourcesSection = objects.PBXSourcesBuildPhase ?? {};
  const phase = sourcesSection[sourcesPhaseId];
  if (!phase) return;
  phase.files = phase.files || [];
  const already = phase.files.some((f: any) => f.value === buildFileId);
  if (!already) {
    phase.files.push({ value: buildFileId, comment: `${fileName} in Sources` });
  }
  sourcesSection[sourcesPhaseId] = phase;
  objects.PBXSourcesBuildPhase = sourcesSection;
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
  
  const dest = await ensureFileOnDisk(
    resolvedProjectPath,
    folderRelativeToProject,
    fileName,
    fileContent,
    overwrite
  );

  const projectWrapper = await openProject(pbxprojPath);
  const objects = projectWrapper.objects;
  const nativeTargets = getNativeTargets(projectWrapper.project);
  const targetNames = targets && targets.length > 0 ? targets : nativeTargets.map((t) => t.name);

  const mainGroupId = projectWrapper.project.getFirstProject().firstProject.mainGroup;
  const groupId = ensureGroup(objects, mainGroupId, folderRelativeToProject);
  // Use file name relative to the containing group to avoid creating
  // external file references (which show as arrows in Xcode).
  const fileRefId = ensureFileReference(objects, groupId, fileName, fileName);
  const buildFileId = ensureBuildFile(objects, fileRefId, fileName);

  for (const tgtName of targetNames) {
    const target = nativeTargets.find((t) => t.name === tgtName);
    if (!target) continue;
    const sourcesPhaseId = findSourcesPhaseId(target.target);
    if (!sourcesPhaseId) continue;
    ensureFileInSourcesPhase(objects, sourcesPhaseId, buildFileId, fileName);
  }

  await projectWrapper.save();
  return dest;
}

