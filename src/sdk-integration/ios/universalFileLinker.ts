/**
 * Universal File Linker for Xcode Projects
 * 
 * Creates source files and properly links them into Xcode project files (project.pbxproj).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { findPbxprojFile, fileExists } from './utils';

const execFileAsync = promisify(execFile);

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
  const xcodeprojPath = path.dirname(pbxprojPath);
  
  // Ensure file exists on disk first
  const dest = await ensureFileOnDisk(
    resolvedProjectPath,
    folderRelativeToProject,
    fileName,
    fileContent,
    overwrite
  );

  const targetNames = targets && targets.length > 0 ? targets : [];
  const script = `
    require 'xcodeproj'
    proj_path = ARGV.shift
    folder_rel = ARGV.shift
    file_name = ARGV.shift
    targets = ARGV
    
    project = Xcodeproj::Project.open(proj_path)
    main_group = project.main_group
    
    # Find or create the folder group
    dir = folder_rel && folder_rel.length > 0 ? folder_rel : '.'
    if dir == '.'
      group = main_group
    else
      segments = dir.split('/').reject(&:empty?)
      group = main_group
      segments.each do |seg|
        sub_group = group.groups.find { |g| g.display_name == seg || g.path == seg }
        if sub_group
          group = sub_group
        else
          group = group.new_group(seg, seg)
          # source_tree is already set to "<group>" by new_group, no need to set again
        end
      end
    end
    
    # Find or create file reference
    file_ref = group.files.find { |f| f.path == file_name || f.display_name == file_name }
    unless file_ref
      file_ref = group.new_file(file_name)
      # Ensure sourceTree is properly set and will be serialized correctly
      file_ref.source_tree = '<group>' if file_ref.source_tree.nil? || file_ref.source_tree.to_s != '<group>'
    end
    
    # Add to targets if specified
    if targets.length > 0
      targets.each do |tname|
        tgt = project.targets.find { |t| t.name == tname }
        next unless tgt
        unless tgt.source_build_phase.files_references.include?(file_ref)
          tgt.add_file_references([file_ref])
        end
      end
    else
      # Add to all native targets if no targets specified
      project.targets.each do |tgt|
        next unless tgt.respond_to?(:source_build_phase)
        unless tgt.source_build_phase.files_references.include?(file_ref)
          tgt.add_file_references([file_ref])
        end
      end
    end
    
    project.save
    
    # Fix any unquoted sourceTree values that Ruby xcodeproj may have written
    # This is a workaround for a Ruby xcodeproj serialization issue
    pbxproj_path = File.join(proj_path, 'project.pbxproj')
    content = File.read(pbxproj_path)
    if content.include?('sourceTree = <group>')
      content = content.gsub('sourceTree = <group>', 'sourceTree = "<group>"')
      File.write(pbxproj_path, content)
    end
  `;
  
  await execFileAsync('ruby', ['-e', script, xcodeprojPath, folderRelativeToProject, fileName, ...targetNames], {
    cwd: resolvedProjectPath,
    maxBuffer: 5 * 1024 * 1024
  });
  
  return dest;
}

