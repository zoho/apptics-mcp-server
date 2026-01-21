import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileExists } from './utils';
import { MIN_IOS_DEPLOYMENT_TARGET, normalizeTargets, isFileSystemSyncedProject } from './pbxprojUtils';
import { readPodfileJSON } from '../../dependency-switcher/ios/podfileEditor';

const execAsync = promisify(exec);

export async function createOrUpdatePodfile(params: {
  projectPath: string;
  targetName?: string;
  targetNames?: string[];
  language: 'swift' | 'objc';
  uploadSymbolsConfigurations?: string;
  configFilePath?: string;
  appGroupIdentifier?: string;
  uploadFrameworks?: string;
}) {
  const {
    projectPath,
    targetName,
    targetNames,
    language,
    uploadSymbolsConfigurations = 'Release, Appstore',
    configFilePath,
    appGroupIdentifier,
    uploadFrameworks
  } = params;

  const targets = await normalizeTargets(projectPath, targetName, targetNames);

  if (targets.length === 0) {
    throw new Error('No target names provided for Podfile generation.');
  }

  const podfilePath = path.join(projectPath, 'Podfile');
  const sdkPod = language === 'swift' ? 'Apptics-Swift' : 'Apptics-SDK';
  
  const usesFsSync = await isFileSystemSyncedProject(projectPath);
  let scriptCmd: string;
  if (usesFsSync) {
    // Avoid calling bundled script to prevent sandbox issues on fs-synced/Xcode15 projects.
    scriptCmd = 'echo "Apptics pre build skipped for filesystem-synced project"';
  } else {
    scriptCmd = `sh "./Pods/Apptics-SDK/scripts/run" --upload-symbols-for-configurations="${uploadSymbolsConfigurations}"`;
  if (configFilePath) {
    scriptCmd += ` --config-file-path="${configFilePath}"`;
  }
  if (appGroupIdentifier) {
    scriptCmd += ` --app-group-identifier="${appGroupIdentifier}"`;
  }
  if (uploadFrameworks) {
    scriptCmd += ` --upload-symbols-for-frameworks="${uploadFrameworks}"`;
  }
  }

  const podfileJson = (await fileExists(podfilePath))
    ? await readPodfileJSON(podfilePath, projectPath).catch(() => createBasePodfileJSON())
    : createBasePodfileJSON();

  const targetsSet = new Set<string>(targets);
  ensureTargets(podfileJson, targetsSet, sdkPod, scriptCmd);

  await writePodfileJSON(podfilePath, projectPath, podfileJson);

    return {
      success: true,
      podfilePath,
      message: 'Podfile created successfully'
    };
}

export async function runPodInstall(params: {
  projectPath: string;
  verbose?: boolean;
}) {
  const { projectPath, verbose = false } = params;

  try {
    const cmd = verbose ? 'pod install --verbose' : 'pod install';
    const env = {
      ...process.env,
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      LC_ALL: process.env.LC_ALL ?? 'en_US.UTF-8'
    };
    const { stdout } = await execAsync(cmd, { cwd: projectPath, env });

    const installedPods = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('Installing '))
      .map((line) => {
        const withoutPrefix = line.slice('Installing '.length);
        const idx = withoutPrefix.indexOf(' (');
        return idx >= 0 ? withoutPrefix.slice(0, idx) : withoutPrefix;
      });

    return {
      success: true,
      output: stdout,
      installedPods,
      message: 'Pods installed successfully'
    };
  } catch (error: any) {
    throw new Error(`Pod install failed: ${error.message}`);
  }
}

type PodDependency = string | [string, ...string[]] | { name?: string };

interface PodScriptPhase {
  name?: string;
  script?: string;
  [key: string]: unknown;
}

interface PodTargetDefinition {
  name: string;
  dependencies?: PodDependency[];
  children?: PodTargetDefinition[];
  platform?: Record<string, string>;
  uses_frameworks?: unknown;
  script_phases?: PodScriptPhase[];
  abstract?: boolean;
  [key: string]: unknown;
}

interface PodfileJSON {
  target_definitions: PodTargetDefinition[];
  [key: string]: unknown;
}

function renderPodfile(podfile: PodfileJSON, iosVersion: string): string {
  const lines: string[] = [];
  lines.push(`source 'https://github.com/CocoaPods/Specs.git'`);
  lines.push('');
  lines.push(`platform :ios, '${iosVersion}'`);
  lines.push('');

  const renderTarget = (def: PodTargetDefinition, indent: string) => {
    lines.push(`${indent}target '${def.name}' do`);
    const inner = `${indent}  `;
    if (def.uses_frameworks) {
      lines.push(`${inner}use_frameworks!`);
    }
    if (def.platform?.ios) {
      lines.push(`${inner}platform :ios, '${def.platform.ios}'`);
    }
    for (const dep of def.dependencies ?? []) {
      const name = dependencyName(dep);
      if (name) {
        lines.push(`${inner}pod '${name}'`);
      }
    }
    for (const phase of def.script_phases ?? []) {
      const name = phase.name ?? '';
      const script = phase.script ?? '';
      lines.push(
        `${inner}script_phase :name => '${name}', :script => '${String(script).replace(/'/g, "\\'")}', :execution_position => :before_compile`
      );
    }
    for (const child of def.children ?? []) {
      lines.push('');
      renderTarget(child, inner);
    }
    lines.push(`${indent}end`);
  };

  for (const def of podfile.target_definitions ?? []) {
    renderTarget(def, '');
    lines.push('');
  }

  return lines.join('\n').trim() + '\n';
}

function createBasePodfileJSON(): PodfileJSON {
  return {
    target_definitions: []
  };
}

function ensureTargets(
  podfile: PodfileJSON,
  targets: Set<string>,
  podName: string,
  script: string
): void {
  // Flatten existing children and drop any targets named 'Pods' to avoid duplicates.
  const flat: PodTargetDefinition[] = [];
  for (const def of podfile.target_definitions ?? []) {
    if (def.children && def.children.length > 0) {
      flat.push(...def.children);
    } else {
      flat.push(def);
    }
  }
  podfile.target_definitions = flat.filter((d) => d.name !== 'Pods');

  const defs = podfile.target_definitions;
  targets.forEach((targetName) => {
    let def = defs.find((d) => d.name === targetName);
    if (!def) {
      def = {
        name: targetName,
        platform: { ios: MIN_IOS_DEPLOYMENT_TARGET },
        uses_frameworks: true,
        dependencies: [],
        script_phases: []
      };
      defs.push(def);
    }
    ensureDependency(def, podName);
    ensureScriptPhase(def, script);
  });
}

function ensureDependency(target: PodTargetDefinition, podName: string): void {
  const deps = target.dependencies ?? [];
  const has = deps.some((dep) => dependencyName(dep)?.toLowerCase() === podName.toLowerCase());
  if (!has) {
    deps.push(podName);
  }
  target.dependencies = deps;
}

function ensureScriptPhase(target: PodTargetDefinition, script: string): void {
  const phases = target.script_phases ?? [];
  const exists = phases.some((phase) => {
    const name = phase.name ? String(phase.name).toLowerCase() : '';
    const body = phase.script ? String(phase.script).toLowerCase() : '';
    return name === 'apptics pre build' || body === script.toLowerCase();
  });
  if (!exists) {
    phases.push({
      name: 'Apptics pre build',
      script,
      execution_position: 'before_compile'
    });
  }
  target.script_phases = phases;
}

function dependencyName(dep: PodDependency): string | undefined {
  if (typeof dep === 'string') return dep;
  if (Array.isArray(dep) && dep.length > 0 && typeof dep[0] === 'string') {
    return dep[0];
  }
  if (dep && typeof dep === 'object' && 'name' in dep && (dep as any).name) {
    return String((dep as any).name);
  }
  return undefined;
}

async function writePodfileJSON(podfilePath: string, _cwd: string, podfile: PodfileJSON): Promise<void> {
  const iosVersion =
    podfile.target_definitions[0]?.children?.[0]?.platform?.ios ||
    podfile.target_definitions[0]?.platform?.ios ||
    MIN_IOS_DEPLOYMENT_TARGET;
  const content = renderPodfile(podfile, iosVersion);
  await fs.writeFile(podfilePath, content, 'utf-8');
}
