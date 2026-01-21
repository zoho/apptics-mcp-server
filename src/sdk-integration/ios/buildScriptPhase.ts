import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { findPbxprojFile, genId } from './utils';
import { openProject, getNativeTargets } from '../../dependency-switcher/ios/xcodeProject';

/**
 * Some legacy integrations wrote PBXShellScriptBuildPhase names without quotes,
 * e.g. `name = Apptics pre build;`, which makes the pbxproj unparsable. This
 * helper rewrites those names with proper quoting so xcodebuild can open the
 * project before we proceed with integration.
 */
export async function repairLegacyAppticsScriptNames(projectPath: string): Promise<boolean> {
  const pbxprojPath = await findPbxprojFile(projectPath);
  let content = await fs.readFile(pbxprojPath, 'utf-8');

  const replacements: Array<{ pattern: RegExp; replacement: string }> = [
    { pattern: /\bname\s*=\s*Apptics pre build\s*;/g, replacement: 'name = "Apptics pre build";' },
    { pattern: /\bname\s*=\s*Apptics post build\s*;/g, replacement: 'name = "Apptics post build";' },
    { pattern: /\bname\s*=\s*Apptics prebuild\s*;/g, replacement: 'name = "Apptics prebuild";' }
  ];

  let updated = false;
  for (const { pattern, replacement } of replacements) {
    if (pattern.test(content)) {
      content = content.replace(pattern, replacement);
      updated = true;
    }
  }

  // Some legacy phases also wrote the shellScript without quotes. Replace the raw
  // Apptics prebuild script with a properly escaped string literal.
  const rawScriptPattern =
    /shellScript = SCRIPT_PATH=\$\(find "\$HOME\/Library\/Developer\/Xcode\/DerivedData" -name "run" -path "\*\/SourcePackages\/checkouts\/Apptics\*" \| head -1\); if \[ -n "\$SCRIPT_PATH" \]; then sh "\$SCRIPT_PATH" --upload-symbols-for-configurations="Release, Appstore"; fi; OUT_MARKER="\$DERIVED_FILE_DIR\/AppticsPreBuild\.marker"; mkdir -p "\$\(dirname "\$OUT_MARKER"\)"; touch "\$OUT_MARKER";/g;
  if (rawScriptPattern.test(content)) {
    const sanitizedScript = buildSPMScriptCommand({
      projectPath,
      uploadSymbolsConfigurations: 'Release, Appstore'
    });
    const escaped = sanitizedScript.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    content = content.replace(rawScriptPattern, `shellScript = "${escaped}";`);
    updated = true;
  }

  if (updated) {
    await fs.writeFile(pbxprojPath, content, 'utf-8');
  }

  return updated;
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

// Deprecated legacy entry point removed: all script phase mutations now use structured edits only.

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
        outputPaths: ['$DERIVED_FILE_DIR/AppticsPreBuild.marker'],
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
    const content = await fs.readFile(pbxprojPath, 'utf-8');
    const usesFsSync =
      /PBXFileSystemSynchronizedRootGroup/.test(content) || /objectVersion\s*=\s*77/.test(content);
    if (usesFsSync) {
      // For filesystem-synced projects, rely on Ruby xcodeproj to update build settings
      await setSandboxingWithRuby(pbxprojPath);
      return {
        success: true,
        targetsModified: targetName ? [targetName] : ['All targets'],
        message: 'User script sandboxing disabled via xcodeproj (filesystem-synced project)'
      };
    }

    const projectWrapper = await openProject(pbxprojPath);
    const objects = projectWrapper.objects;
    const configs = objects.XCBuildConfiguration ?? {};
    Object.entries(configs).forEach(([key, value]) => {
      if (key.endsWith('_comment')) return;
      const config: any = value;
      config.buildSettings = config.buildSettings || {};
      if (config.buildSettings.ENABLE_USER_SCRIPT_SANDBOXING !== 'NO') {
        config.buildSettings.ENABLE_USER_SCRIPT_SANDBOXING = 'NO';
      }
    });
    await projectWrapper.save();

    return {
      success: true,
      targetsModified: targetName ? [targetName] : ['All targets'],
      message: 'User script sandboxing disabled successfully'
    };
  } catch (error: any) {
    throw new Error(`Failed to disable sandboxing: ${error.message}`);
  }
}

const execFileAsync = promisify(execFile);

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
