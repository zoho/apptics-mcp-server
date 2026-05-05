/**
 * Podfile editor for adding/removing Apptics pods.
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

/** Pod names that extension targets need (lightweight SDK for extensions). */
const EXTENSION_PODS = new Set(['appticsextension', 'appticsnotificationserviceextension']);

/** Check if Podfile has structure we must preserve (post_install, use_frameworks!, etc.). */
function podfileHasPreservableStructure(content: string): boolean {
  if (content.includes('use_frameworks!')) return true;
  if (content.includes('inhibit_all_warnings!')) return true;
  const postIdx = content.indexOf('post_install');
  if (postIdx >= 0) {
    const after = content.slice(postIdx + 'post_install'.length).trimStart();
    if (after.startsWith('do')) return true;
  }
  return false;
}

/** Split content into lines without regex (handles \\r\\n). */
function splitLines(s: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\n') {
      let end = i;
      if (end > start && s[end - 1] === '\r') end--;
      lines.push(s.slice(start, end));
      start = i + 1;
    }
  }
  if (start < s.length) {
    let end = s.length;
    if (s[end - 1] === '\r') end--;
    lines.push(s.slice(start, end));
  }
  return lines;
}

/** Check if line is a target 'Name' do declaration. */
function isTargetDoLine(line: string, targetName: string): boolean {
  const t = line.trim();
  if (!t.startsWith('target')) return false;
  const q1 = "'" + targetName + "'";
  const q2 = '"' + targetName + '"';
  if (!t.includes(q1) && !t.includes(q2)) return false;
  return t.includes(' do') || t.endsWith(' do');
}

/** Check if content already has pod 'PodName' (case-insensitive). */
function contentHasPod(content: string, podName: string): boolean {
  const lower = content.toLowerCase();
  const p = podName.toLowerCase();
  return lower.includes("pod '" + p + "'") || lower.includes('pod "' + p + '"');
}

/**
 * Add Apptics pods via line-by-line text editing. No regex. Preserves post_install,
 * use_frameworks!, inhibit_all_warnings!, def blocks, and script phases.
 */
async function addAppticsPodToPodfileTextBased(
  podfilePath: string,
  targetNames: string[],
  language: IOSLanguage,
  podNamesToAdd: string[]
): Promise<void> {
  let content = await fs.readFile(podfilePath, 'utf-8');

  // Ensure $apptics_version exists
  const hasAppticsVersion =
    content.includes('$apptics_version=') || content.includes("$apptics_version =");
  if (!hasAppticsVersion) {
    const idx = content.indexOf('workspace ');
    if (idx >= 0) {
      const endOfLine = content.indexOf('\n', idx);
      const insertAt = endOfLine < 0 ? content.length : endOfLine;
      content =
        content.slice(0, insertAt) +
        "\n\n$apptics_version = '3.3.9'" +
        content.slice(insertAt);
    }
  }

  const mainPods = podNamesToAdd.filter(
    (p) => !EXTENSION_PODS.has(p.toLowerCase())
  );
  const hasExtensionPod = podNamesToAdd.some((p) =>
    EXTENSION_PODS.has(p.toLowerCase())
  );
  const extensionPod =
    podNamesToAdd.find((p) => p.toLowerCase() === 'appticsextension') ||
    (hasExtensionPod ? 'AppticsExtension' : null);
  const versionExpr = hasAppticsVersion ? '$apptics_version' : "'3.3.9'";

  // Find main app target: exclude intents, widgets, extensions, tests.
  // Prefer the first target that actually exists in the Podfile.
  const excludePatterns = ['intent', 'widget', 'extension', 'uitest', 'unittest', 'test'];
  const candidates = targetNames.filter(
    (t) => !excludePatterns.some((p) => t.toLowerCase().includes(p))
  );
  let mainTargetName = candidates[0] ?? targetNames[0] ?? 'ZohoAssist';

  const lines = splitLines(content);
  // Use first target that exists in Podfile (in case mainTargetName not in Podfile)
  for (const t of candidates.length > 0 ? candidates : targetNames) {
    const found = lines.some((line) => isTargetDoLine(line, t));
    if (found) {
      mainTargetName = t;
      break;
    }
  }

  const mainTargetAlreadyHasApptics = mainPods.some((p) => contentHasPod(content, p));

  // Insert main Apptics pods into the main app target
  if (mainPods.length > 0 && !mainTargetAlreadyHasApptics) {
    let mainTargetLineIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (isTargetDoLine(lines[i] ?? '', mainTargetName)) {
        mainTargetLineIdx = i;
        break;
      }
    }
    if (mainTargetLineIdx >= 0) {
      const podLines = mainPods
        .map((p) => `    pod '${p}', ${versionExpr}`)
        .join('\n');
      const scriptPhase =
        '    script_phase :name => \'Apptics pre build\', :script => \'sh "./Pods/Apptics-SDK/scripts/run" --upload-symbols-for-configurations="Release, Appstore" --config-file-path="${ZA_APPTICS_PATH}" --app-group-identifier="${ZA_WIDGET_APP_GROUP_ID}"\', :execution_position => :before_compile';
      const toInsert = `${podLines}\n${scriptPhase}`;
      lines.splice(mainTargetLineIdx + 1, 0, toInsert);
      content = lines.join('\n');
    }
  }

  // Insert AppticsExtension into def extension_common
  if (extensionPod && !contentHasPod(content, extensionPod)) {
    const extLines = splitLines(content);
    for (let i = 0; i < extLines.length; i++) {
      const t = (extLines[i] ?? '').trim();
      if (t.startsWith('def ') && t.includes('extension_common')) {
        extLines.splice(i + 1, 0, `  pod '${extensionPod}', ${versionExpr}`);
        content = extLines.join('\n');
        break;
      }
    }
  }

  await fs.writeFile(podfilePath, content, 'utf-8');
}

/**
 * Add Apptics pods to the Podfile. If podNamesToAdd is provided (e.g. from SPM→CocoaPods switch),
 * adds all of those pods (main + optional); otherwise adds only the main SDK pod.
 * When the Podfile has post_install, use_frameworks!, or inhibit_all_warnings!, uses text-based
 * editing to preserve that structure instead of JSON round-trip.
 */
export async function addAppticsPodToPodfile(
  podfilePath: string,
  targetNames: string[],
  language: IOSLanguage,
  podNamesToAdd?: string[]
): Promise<void> {
  const sdkPod = language === 'swift' ? 'Apptics-Swift' : 'Apptics-SDK';
  const podsToAdd = (podNamesToAdd?.length ?? 0) > 0 ? podNamesToAdd! : [sdkPod];
  const resolved = path.resolve(podfilePath);
  const projectDir = path.dirname(resolved);
  const exists = await fileExists(resolved);

  // Use text-based editing when Podfile has structure we must preserve
  if (exists && podNamesToAdd && podNamesToAdd.length > 0) {
    const content = await fs.readFile(resolved, 'utf-8');
    if (podfileHasPreservableStructure(content)) {
      await addAppticsPodToPodfileTextBased(
        resolved,
        targetNames,
        language,
        podNamesToAdd
      );
      return;
    }
  }

  const podfileJson = exists
    ? await readPodfileJSON(resolved, projectDir)
    : createBasePodfile(targetNames, podsToAdd[0] ?? sdkPod);

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
    for (const podName of podsToAdd) {
      ensureDependency(target, podName);
    }
  });

  // Ensure all targets exist
  const existingNames = new Set(podfileJson.target_definitions.map(d => d.name));
  for (const tname of targetNames) {
    if (!existingNames.has(tname)) {
      podfileJson.target_definitions.push({
        name: tname,
        platform: { ios: '11.0' },
        uses_frameworks: true,
        dependencies: [...podsToAdd]
      });
    }
  }

  await writePodfileJSON(resolved, projectDir, podfileJson);
}
  
/**
 * Returns Apptics-related pod names per target from the Podfile.
 * Used when switching to SPM to add the correct SPM products per target
 * (e.g. extension targets get AppticsExtension, main app gets full suite).
 */
export async function getAppticsPodNamesByTargetFromPodfile(podfilePath: string): Promise<Record<string, string[]>> {
  const resolved = path.resolve(podfilePath);
  const projectDir = path.dirname(resolved);
  if (!(await fileExists(resolved))) {
    return {};
  }
  try {
    const podfileJson = await readPodfileJSON(resolved, projectDir);
    const result: Record<string, string[]> = {};
    const visit = (def: PodTargetDefinition, inheritedApptics: string[] = []) => {
      const name = def.name;
      if (name === 'Pods') {
        for (const child of def.children ?? []) visit(child, inheritedApptics);
        return;
      }
      const deps: string[] = [...inheritedApptics];
      for (const dep of def.dependencies ?? []) {
        const n = dependencyName(dep);
        if (n && n.toLowerCase().startsWith('apptics') && !deps.includes(n)) deps.push(n);
      }
      if (deps.length > 0) result[name] = deps;
      for (const child of def.children ?? []) visit(child, deps);
    };
    for (const def of podfileJson.target_definitions ?? []) visit(def);
    return result;
  } catch {
    return {};
  }
}

/**
 * Returns Apptics-related pod names currently in the Podfile (main + optional).
 * Used when switching to SPM to add the same modules via SPM products.
 */
export async function getAppticsPodNamesFromPodfile(podfilePath: string): Promise<string[]> {
  const resolved = path.resolve(podfilePath);
  const projectDir = path.dirname(resolved);
  if (!(await fileExists(resolved))) {
    return [];
  }
  const podfileJson = await readPodfileJSON(resolved, projectDir);
  const flat: PodTargetDefinition[] = [];
  for (const def of podfileJson.target_definitions ?? []) {
    if (def.children && def.children.length > 0) {
      flat.push(...def.children);
    } else {
      flat.push(def);
    }
  }
  const names = new Set<string>();
  applyToTargets(flat.filter((d) => d.name !== 'Pods'), (target) => {
    for (const dep of target.dependencies ?? []) {
      const name = dependencyName(dep);
      if (name && name.toLowerCase().startsWith('apptics')) {
        names.add(name);
      }
    }
  });
  return Array.from(names);
}

/**
 * Remove Apptics pods and script phases from Podfile using text-based editing.
 * This preserves the original Podfile structure (sources, post_install, def blocks,
 * abstract targets, variables) which would be lost by JSON round-trip + render.
 */
/** Check if line is an Apptics pod or Apptics script_phase (no regex). */
function isAppticsPodOrScriptPhaseLine(line: string): boolean {
  const t = line.trim();
  if (t.startsWith('pod ') && t.includes('Apptics')) return true;
  if (t.startsWith('script_phase') && t.includes('Apptics')) return true;
  return false;
}

export async function removeAppticsPodFromPodfile(podfilePath: string): Promise<void> {
  const resolved = path.resolve(podfilePath);
  if (!(await fileExists(resolved))) {
    return;
  }

  const content = await fs.readFile(resolved, 'utf-8');
  const lines = splitLines(content);
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (isAppticsPodOrScriptPhaseLine(line)) continue;
    result.push(line);
  }

  await fs.writeFile(resolved, result.join('\n'), 'utf-8');
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
  // CocoaPods ipc podfile-json outputs deps as { "PodName": [version, ...opts] }
  if (dep && typeof dep === 'object' && !Array.isArray(dep)) {
    const keys = Object.keys(dep as Record<string, unknown>).filter((k) => !k.endsWith('_comment'));
    if (keys.length === 1) return keys[0];
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
        `${inner}script_phase :name => '${name}', :script => '${String(script).split("'").join("\\'")}', :execution_position => :before_compile`
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

