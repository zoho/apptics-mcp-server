/**
 * Podfile editor for adding/removing Apptics pods using structured CocoaPods IPC (no regex).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileExists } from '../../sdk-integration/ios/utils';
import type { IOSLanguage } from './types';

const execFileAsync = promisify(execFile);

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

export async function addAppticsPodToPodfile(
  podfilePath: string,
  targetNames: string[],
  language: IOSLanguage
): Promise<void> {
  const sdkPod = language === 'swift' ? 'Apptics-Swift' : 'Apptics-SDK';
  const resolved = path.resolve(podfilePath);
  const projectDir = path.dirname(resolved);
  const exists = await fileExists(resolved);

  const podfileJson = exists
    ? await readPodfileJSON(resolved, projectDir)
    : createBasePodfile(targetNames, sdkPod);

  // Flatten and remove duplicate Pods targets
  const flat: PodTargetDefinition[] = [];
  for (const def of podfileJson.target_definitions ?? []) {
    if (def.children && def.children.length > 0) {
      flat.push(...def.children);
    } else {
      flat.push(def);
    }
  }
  podfileJson.target_definitions = flat.filter((d) => d.name !== 'Pods');

  const targetsToUpdate = new Set(targetNames);
  applyToTargets(podfileJson.target_definitions, (target) => {
    if (!targetsToUpdate.has(target.name)) {
      return;
    }
    ensureDependency(target, sdkPod);
  });

  // Ensure all targets exist
  const existingNames = new Set(podfileJson.target_definitions.map(d => d.name));
  for (const tname of targetNames) {
    if (!existingNames.has(tname)) {
      podfileJson.target_definitions.push({
        name: tname,
        platform: { ios: '11.0' },
        uses_frameworks: true,
        dependencies: [sdkPod]
      });
    }
  }

  await writePodfileJSON(resolved, projectDir, podfileJson);
}
  
export async function removeAppticsPodFromPodfile(podfilePath: string): Promise<void> {
  const resolved = path.resolve(podfilePath);
  const projectDir = path.dirname(resolved);
  if (!(await fileExists(resolved))) {
    return;
  }
    
  const podfileJson = await readPodfileJSON(resolved, projectDir);

  // Flatten and remove duplicate Pods targets
  const flat: PodTargetDefinition[] = [];
  for (const def of podfileJson.target_definitions ?? []) {
    if (def.children && def.children.length > 0) {
      flat.push(...def.children);
    } else {
      flat.push(def);
    }
  }
  podfileJson.target_definitions = flat.filter((d) => d.name !== 'Pods');

  let changed = false;
  applyToTargets(podfileJson.target_definitions, (target) => {
    const beforeDeps = target.dependencies?.length ?? 0;
    target.dependencies = (target.dependencies ?? []).filter((dep) => {
      const name = dependencyName(dep);
      return !(name && name.toLowerCase().startsWith('apptics-'));
    });
    if (target.dependencies.length !== beforeDeps) {
      changed = true;
    }

    const scripts = target.script_phases ?? [];
    const filteredScripts = scripts.filter((phase) => {
      const name = (phase.name ?? '').toString().toLowerCase();
      const script = (phase.script ?? '').toString().toLowerCase();
      return !name.includes('apptics') && !script.includes('apptics');
    });
    if (filteredScripts.length !== scripts.length) {
      target.script_phases = filteredScripts;
      changed = true;
    }
  });

  // Always write if we removed Apptics or flattened structure
  await writePodfileJSON(resolved, projectDir, podfileJson);
}

export async function readPodfileJSON(podfilePath: string, cwd: string): Promise<PodfileJSON> {
  const { stdout } = await execFileAsync('pod', ['ipc', 'podfile-json', podfilePath], {
    cwd,
    maxBuffer: 5 * 1024 * 1024
  });
  return JSON.parse(stdout) as PodfileJSON;
}

async function writePodfileJSON(podfilePath: string, cwd: string, podfile: PodfileJSON): Promise<void> {
  // CocoaPods 1.16.x does not support `pod ipc podfile-from-json`, so render manually.
  const iosVersion =
    podfile.target_definitions[0]?.children?.[0]?.platform?.ios ||
    podfile.target_definitions[0]?.platform?.ios ||
    '11.0';
  const content = renderPodfile(podfile, iosVersion);
  await fs.writeFile(podfilePath, content, 'utf-8');
}

function ensureDependency(target: PodTargetDefinition, podName: string): void {
  const deps = target.dependencies ?? [];
  const has = deps.some((dep) => dependencyName(dep)?.toLowerCase() === podName.toLowerCase());
  if (!has) {
    deps.push(podName);
  }
  target.dependencies = deps;
}

function dependencyName(dep: PodDependency): string | undefined {
  if (typeof dep === 'string') {
    return dep;
  }
  if (Array.isArray(dep) && dep.length > 0) {
    const first = dep[0];
    return typeof first === 'string' ? first : undefined;
  }
  if (dep && typeof dep === 'object' && 'name' in dep && dep.name) {
    return String(dep.name);
  }
  return undefined;
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
    
function applyToTargets(defs: PodTargetDefinition[], fn: (target: PodTargetDefinition) => void): void {
  defs.forEach((def) => {
    fn(def);
    if (def.children && def.children.length > 0) {
      applyToTargets(def.children, fn);
    }
  });
  }
  
function createBasePodfile(targetNames: string[], podName: string): PodfileJSON {
  const defs = targetNames.map<PodTargetDefinition>((name) => ({
    name,
    platform: { ios: '11.0' },
    uses_frameworks: true,
    dependencies: [podName]
  }));

  return {
    target_definitions: defs
  };
}

