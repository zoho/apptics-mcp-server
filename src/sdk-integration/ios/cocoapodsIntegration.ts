/**
 * CocoaPods integration for Apptics iOS SDK.
 * Apptics Core (Apptics-Swift / Apptics-SDK) is mandatory for optional modules.
 * When adding optional modules (e.g. feedbackKit), we add core + optional pods explicitly.
 * Optional pods may declare core as a dependency (to be tested); if so, we could later
 * add only optional pods when user requested optional modules.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileExists } from './utils';
import { resolveContainedPath } from '../pathContainment';
import { getMinDeploymentTarget, normalizeTargets } from './pbxprojUtils';
import { getBuildSettings } from './xcodeProjectParser';
import type { ApplePlatform } from './xcodeProjectParser';

/** AppticsNotificationServiceExtension pod requires platform :ios, '15.0' minimum. */
const NSE_MIN_IOS = '15.0';
import { isFileSystemSyncedProject } from './xcodeProjectParser';
import { readPodfileJSON } from '../../dependency-switcher/ios/podfileEditor';
import { getOptionalModules, SKIP_OPTIONAL_PODS_COCOAPODS } from './appticsOptionalModules';

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
  /** Optional module ids (e.g. remoteConfig, feedbackKit). Adds corresponding pods per target. */
  optionalModuleIds?: string[];
  /** Target names that are Notification Service Extension targets; they get only AppticsNotificationServiceExtension, no core pod. */
  notificationServiceExtensionTargetNames?: string[];
  /** Extra CocoaPods pod names to add to every main app target (e.g. missing or private pods). */
  additionalPodNames?: string[];
}) {
  const {
    projectPath,
    targetName,
    targetNames,
    language,
    uploadSymbolsConfigurations = 'Release, Appstore',
    configFilePath,
    appGroupIdentifier,
    uploadFrameworks,
    optionalModuleIds,
    notificationServiceExtensionTargetNames: nseTargetNamesParam = [],
    additionalPodNames = []
  } = params;

  const targets = await normalizeTargets(projectPath, targetName, targetNames);

  if (targets.length === 0) {
    throw new Error('No target names provided for Podfile generation.');
  }

  const nseSet = new Set<string>(nseTargetNamesParam);
  const mainTargetsSet = new Set<string>(targets.filter((t) => !nseSet.has(t)));
  const nseTargetsSet = new Set<string>(targets.filter((t) => nseSet.has(t)));
  const targetsSet = new Set<string>(targets);

  // Containment guard: never read/write a Podfile that is a symlink escaping the project (CWE-59).
  const podfilePath = await resolveContainedPath(projectPath, 'Podfile');
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

  const buildSettings = await getBuildSettings(projectPath);
  const platform = buildSettings.platform;
  const deploymentVersion = buildSettings.deploymentTarget ?? getMinDeploymentTarget(platform);

  ensureTargets(podfileJson, mainTargetsSet, sdkPod, scriptCmd, platform);
  // NSE is iOS-only; for macOS projects, nseTargetsSet is typically empty
  ensureTargetDefinitionsExist(podfileJson, nseTargetsSet, 'ios', NSE_MIN_IOS);

  const allMainPodNames: string[] = [...(additionalPodNames ?? [])];
  if (optionalModuleIds && optionalModuleIds.length > 0) {
    const skipSet = new Set(SKIP_OPTIONAL_PODS_COCOAPODS);
    const mainModuleIds = optionalModuleIds.filter((id) => id !== 'notificationServiceExtension' && !skipSet.has(id));
    const optionalPodNames = getOptionalModules(mainModuleIds)
      .map((m) => (language === 'swift' ? m.cocoapods.swift : m.cocoapods.objc))
      .filter((name): name is string => Boolean(name?.trim()));
    allMainPodNames.push(...optionalPodNames);

    const nsePodName = language === 'swift' ? 'AppticsNotificationServiceExtension' : 'AppticsNotificationServiceExtension';
    const wantsNse = optionalModuleIds.includes('notificationServiceExtension') && !skipSet.has('notificationServiceExtension');
    if (wantsNse) {
      allMainPodNames.push(nsePodName);
    }

    (podfileJson.target_definitions ?? [])
      .filter((d) => d.name !== 'Pods' && targetsSet.has(d.name))
      .forEach((def) => {
        if (mainTargetsSet.has(def.name)) {
          allMainPodNames.forEach((podName) => ensureDependency(def, podName));
        }
        if (nseTargetsSet.has(def.name) && wantsNse) {
          ensureDependency(def, nsePodName);
        }
      });
  } else if (allMainPodNames.length > 0) {
    (podfileJson.target_definitions ?? [])
      .filter((d) => d.name !== 'Pods' && mainTargetsSet.has(d.name))
      .forEach((def) => allMainPodNames.forEach((podName) => ensureDependency(def, podName)));
  }

  await writePodfileJSON(podfilePath, projectPath, podfileJson, platform, deploymentVersion);

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
    const cmd = verbose ? 'pod install --repo-update --verbose' : 'pod install --repo-update';
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

function renderPodfile(podfile: PodfileJSON, platform: ApplePlatform, deploymentVersion: string): string {
  const podPlatform = platform === 'macos' ? ':osx' : ':ios';
  const lines: string[] = [];
  lines.push(`source 'https://github.com/CocoaPods/Specs.git'`);
  lines.push('');
  lines.push(`platform ${podPlatform}, '${deploymentVersion}'`);
  lines.push('');

  const renderTarget = (def: PodTargetDefinition, indent: string) => {
    lines.push(`${indent}target '${def.name}' do`);
    const inner = `${indent}  `;
    if (def.uses_frameworks) {
      lines.push(`${inner}use_frameworks!`);
    }
    const defPlatform = platform === 'macos' ? def.platform?.osx : def.platform?.ios;
    if (defPlatform) {
      lines.push(`${inner}platform ${podPlatform}, '${defPlatform}'`);
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
      const escapedScript = String(script).split("'").join("\\'");
      lines.push(
        `${inner}script_phase :name => '${name}', :script => '${escapedScript}', :execution_position => :before_compile`
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
  script: string,
  platform: ApplePlatform
): void {
  flattenTargetDefinitions(podfile);
  const defs = podfile.target_definitions!;
  targets.forEach((targetName) => {
    const def = ensureTargetDefinition(defs, targetName, platform);
    ensureDependency(def, podName);
    ensureScriptPhase(def, script);
  });
}

/** Ensures target definitions exist for NSE (or other) targets without adding core pod or script. Uses platformOverride (e.g. 15.0 for NSE) when provided. NSE is iOS-only. */
function ensureTargetDefinitionsExist(
  podfile: PodfileJSON,
  targets: Set<string>,
  platform: ApplePlatform,
  platformOverride?: string
): void {
  if (targets.size === 0) return;
  flattenTargetDefinitions(podfile);
  const defs = podfile.target_definitions!;
  targets.forEach((targetName) => ensureTargetDefinition(defs, targetName, platform, platformOverride));
}

function flattenTargetDefinitions(podfile: PodfileJSON): void {
  const flat: PodTargetDefinition[] = [];
  for (const def of podfile.target_definitions ?? []) {
    if (def.children && def.children.length > 0) {
      flat.push(...def.children);
    } else {
      flat.push(def);
    }
  }
  podfile.target_definitions = flat.filter((d) => d.name !== 'Pods');
}

function ensureTargetDefinition(
  defs: PodTargetDefinition[],
  targetName: string,
  platform: ApplePlatform,
  platformOverride?: string
): PodTargetDefinition {
  const minTarget = getMinDeploymentTarget(platform);
  const version = platformOverride ?? minTarget;
  const platformKey = platform === 'macos' ? 'osx' : 'ios';
  let def = defs.find((d) => d.name === targetName);
  if (!def) {
    def = {
      name: targetName,
      platform: { [platformKey]: version },
      uses_frameworks: true,
      dependencies: [],
      script_phases: []
    };
    defs.push(def);
  } else if (platformOverride) {
    def.platform = { ...def.platform, [platformKey]: platformOverride };
  }
  return def;
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
  // CocoaPods ipc podfile-json outputs deps as { "PodName": [version, ...opts] }
  if (dep && typeof dep === 'object' && !Array.isArray(dep)) {
    const keys = Object.keys(dep as Record<string, unknown>).filter((k) => !k.endsWith('_comment'));
    if (keys.length === 1) return keys[0];
  }
  return undefined;
}

async function writePodfileJSON(
  podfilePath: string,
  _cwd: string,
  podfile: PodfileJSON,
  platform: ApplePlatform,
  deploymentVersion: string
): Promise<void> {
  const version =
    podfile.target_definitions[0]?.children?.[0]?.platform?.[platform === 'macos' ? 'osx' : 'ios'] ||
    podfile.target_definitions[0]?.platform?.[platform === 'macos' ? 'osx' : 'ios'] ||
    deploymentVersion;
  const content = renderPodfile(podfile, platform, version);
  await fs.writeFile(podfilePath, content, 'utf-8');
}
