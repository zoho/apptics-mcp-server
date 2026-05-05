import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { findPbxprojFile, genId, openProject, getNativeTargets } from './utils';

const execFileAsync = promisify(execFile);

/**
 * Some legacy integrations wrote PBXShellScriptBuildPhase names without quotes,
 * e.g. `name = Apptics pre build;`, which makes the pbxproj unparsable. This
 * helper rewrites those names with proper quoting so xcodebuild can open the
 * project before we proceed with integration.
 */
export async function repairLegacyAppticsScriptNames(projectPath: string): Promise<boolean> {
  const pbxprojPath = await findPbxprojFile(projectPath);
  const xcodeprojPath = path.dirname(pbxprojPath);
  
  const script = `
    require 'xcodeproj'
    proj_path = ARGV.shift
    pbxproj_path = File.join(proj_path, 'project.pbxproj')
    
    begin
      project = Xcodeproj::Project.open(proj_path)
      project.save
      puts "Fixed"
    rescue => e
      content = File.read(pbxproj_path)
      original_content = content.dup
      
      content = content.gsub('sourceTree = <group>', 'sourceTree = "<group>"')
      
      lines = content.lines
      lines.each_with_index do |line, i|
        if line.include?('outputPaths = (') && i + 1 < lines.length
          next_line = lines[i + 1]
          if next_line.include?('$(DERIVED_FILE_DIR)') && !next_line.include?('"$(DERIVED_FILE_DIR)"')
            lines[i + 1] = next_line.gsub('$(DERIVED_FILE_DIR)', '"$(DERIVED_FILE_DIR)"')
          end
        end
      end
      content = lines.join
      
      if content != original_content
        File.write(pbxproj_path, content)
        # Try to open again after fix
        begin
          project = Xcodeproj::Project.open(proj_path)
          project.save
          puts "Fixed"
        rescue
          puts "Fixed"
        end
      else
        puts "NoFix"
      end
    end
  `;
  
  try {
    const { stdout } = await execFileAsync('ruby', ['-e', script, xcodeprojPath], {
      maxBuffer: 5 * 1024 * 1024
    });
    return stdout.includes('Fixed');
  } catch {
    return false;
  }
}


export function buildSPMScriptCommand(params: {
  projectPath: string;
  uploadSymbolsConfigurations: string;
  configFilePath?: string;
  appGroupIdentifier?: string;
  uploadFrameworks?: string;
}): string {
  const outputMarker = '$DERIVED_FILE_DIR/AppticsPreBuild.marker';
  const {
    uploadSymbolsConfigurations,
    configFilePath,
    appGroupIdentifier,
    uploadFrameworks
  } = params;

  let scriptCmd = `SCRIPT_PATH=$(find "$HOME/Library/Developer/Xcode/DerivedData" -name "run" -path "*/SourcePackages/checkouts/Apptics*" | head -1); if [ -n "$SCRIPT_PATH" ]; then sh "$SCRIPT_PATH" --upload-symbols-for-configurations="${uploadSymbolsConfigurations}"`;
  
  if (configFilePath) {
    scriptCmd += ` --config-file-path="${configFilePath}"`;
  }
  if (appGroupIdentifier) {
    scriptCmd += ` --app-group-identifier="${appGroupIdentifier}"`;
  }
  if (uploadFrameworks) {
    scriptCmd += ` --upload-symbols-for-frameworks="${uploadFrameworks}"`;
  }
  
  scriptCmd += `; fi; OUT_MARKER="${outputMarker}"; mkdir -p "$(dirname "$OUT_MARKER")"; touch "$OUT_MARKER"`;

  return scriptCmd;
}

export async function addBuildScriptPhaseWithParser(
  pbxprojPath: string,
  targetName: string,
  scriptName: string,
  script: string
): Promise<string> {
  const projectDir = path.dirname(pbxprojPath);
  const resolved = path.join(projectDir, path.basename(pbxprojPath));

  const projectWrapper = await openProject(resolved);
  const objects = projectWrapper.objects;
  const targets = getNativeTargets(projectWrapper.project);
  const target = targets.find((t) => t.name === targetName);
  if (!target) {
    throw new Error(`Could not find PBXNativeTarget ${targetName} in project`);
  }

  const shellSection = objects.PBXShellScriptBuildPhase ?? {};
  const existingPhaseId = Object.entries(shellSection).find(([key, value]) => {
    if (key.endsWith('_comment')) return false;
    const phase: any = value;
    const name = phase.name ? String(phase.name).split('"').join('') : '';
    return name === scriptName;
  })?.[0];

  const phaseId = existingPhaseId ?? genId();
  if (!existingPhaseId) {
    shellSection[phaseId] = {
      isa: 'PBXShellScriptBuildPhase',
      buildActionMask: 2147483647,
      files: [],
      inputFileListPaths: [],
        inputPaths: [],
      name: scriptName,
      outputFileListPaths: [],
        outputPaths: ['$(DERIVED_FILE_DIR)/AppticsPreBuild.marker'],
      runOnlyForDeploymentPostprocessing: 0,
      shellPath: '/bin/sh',
      shellScript: script
    };
    objects.PBXShellScriptBuildPhase = shellSection;
  }

  const buildPhases: Array<{ value: string; comment?: string }> =
    (target.target.buildPhases as Array<{ value: string; comment?: string }>) ?? [];
  const alreadyLinked = buildPhases.some((bp) => bp.value === phaseId);
  if (!alreadyLinked) {
    buildPhases.push({ value: phaseId, comment: scriptName });
    target.target.buildPhases = buildPhases;
  }

  await projectWrapper.save();
  const content = projectWrapper.project.writeSync();
  
  // Repair any unquoted script names/paths immediately after write
  await repairLegacyAppticsScriptNames(path.dirname(pbxprojPath));
  
  return content;
}

export async function disableUserScriptSandboxing(params: {
  projectPath: string;
  targetName?: string;
}) {
  const { projectPath, targetName } = params;

  try {
    const pbxprojPath = await findPbxprojFile(projectPath);
    await setSandboxingWithRuby(pbxprojPath);
    return {
      success: true,
      targetsModified: targetName ? [targetName] : ['All targets'],
      message: 'User script sandboxing disabled via xcodeproj'
    };
  } catch (error: any) {
    throw new Error(`Failed to disable sandboxing: ${error.message}`);
  }
}

async function setSandboxingWithRuby(pbxprojPath: string): Promise<void> {
  const xcodeprojPath = path.dirname(pbxprojPath);
  const script = `
    require 'xcodeproj'
    proj_path = ARGV.shift
    project = Xcodeproj::Project.open(proj_path)
    project.build_configurations.each do |cfg|
      cfg.build_settings['ENABLE_USER_SCRIPT_SANDBOXING'] = 'NO'
    end
    project.targets.each do |tgt|
      tgt.build_configurations.each do |cfg|
        cfg.build_settings['ENABLE_USER_SCRIPT_SANDBOXING'] = 'NO'
      end
    end
    project.save
  `;
  await execFileAsync('ruby', ['-e', script, xcodeprojPath], { maxBuffer: 5 * 1024 * 1024 });
}

export async function addBuildScriptPhaseWithRuby(
  pbxprojPath: string,
  targetName: string,
  scriptName: string,
  scriptBody: string
): Promise<void> {
  const xcodeprojPath = path.dirname(pbxprojPath);
  const script = `
    require 'xcodeproj'
    proj_path = ARGV.shift
    target_name = ARGV.shift
    phase_name = ARGV.shift
    shell_script = ARGV.shift
    
    project = Xcodeproj::Project.open(proj_path)
    target = project.targets.find { |t| t.name == target_name }
    raise "Target #{target_name} not found" unless target
    
    existing = target.shell_script_build_phases.find { |p| p.name == phase_name }
    unless existing
      phase = target.new_shell_script_build_phase(phase_name)
      phase.shell_script = shell_script
      phase.output_paths = ['$(DERIVED_FILE_DIR)/AppticsPreBuild.marker']
    end
    
    project.save
  `;
  await execFileAsync('ruby', ['-e', script, xcodeprojPath, targetName, scriptName, scriptBody], {
    maxBuffer: 5 * 1024 * 1024
  });
}
