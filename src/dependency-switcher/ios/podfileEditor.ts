/**
 * Podfile editor for adding/removing Apptics pods.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileExists } from '../../sdk-integration/ios/utils';
import { getBuildSettings } from '../../sdk-integration/ios/xcodeProjectParser';
import { getMinDeploymentTarget } from '../../sdk-integration/ios/pbxprojUtils';
import type { ApplePlatform } from '../../sdk-integration/ios/xcodeProjectParser';
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

/** Determine a :source suffix for Apptics pods when Podfile uses source_url. */
function getAppticsPodSourceSuffix(content: string): string {
  const hasSourceVar = content.includes('source_url =');
  const usesSourceVar =
    content.includes('Apptics-SDK/Scripts') && content.includes(':source => source_url');
  if (hasSourceVar && usesSourceVar) {
    return ', :source => source_url';
  }
  return '';
}

/** Ensure Podfile has a platform line (non-comment). Supports :ios and :osx (macOS). */
function ensurePlatformLine(content: string, platform: ApplePlatform, defaultVersion: string): string {
  const lines = splitLines(content);
  let hasPlatform = false;
  let firstTargetIdx = -1;
  let lastSourceIdx = -1;
  const podPlatform = platform === 'macos' ? ':osx' : ':ios';
  for (let i = 0; i < lines.length; i++) {
    const t = (lines[i] ?? '').trim();
    if (t.startsWith('#')) continue;
    if (t.startsWith('platform ') && (t.includes(':ios') || t.includes(':osx'))) {
      hasPlatform = true;
      break;
    }
    if (firstTargetIdx < 0 && t.startsWith('target ')) {
      firstTargetIdx = i;
    }
    if (t.startsWith('source ')) {
      lastSourceIdx = i;
    }
  }
  if (hasPlatform) return content;
  const insertAt = lastSourceIdx >= 0 ? lastSourceIdx + 1 : (firstTargetIdx >= 0 ? firstTargetIdx : 0);
  lines.splice(insertAt, 0, `platform ${podPlatform}, '${defaultVersion}'`, '');
  return lines.join('\n');
}

/** Add :source => source_url to Apptics pods inside a target block when missing. */
function addSourceSuffixToAppticsPodsInTarget(
  lines: string[],
  targetStartIdx: number,
  suffix: string
): void {
  if (!suffix) return;
  for (let i = targetStartIdx + 1; i < lines.length; i++) {
    const t = (lines[i] ?? '').trim();
    if (t === 'end') break;
    if (t.startsWith('target ')) break;
    if (t.startsWith('abstract_target ')) break;
    if (t.startsWith('pod ') && t.includes('Apptics') && !t.includes(':source =>')) {
      lines[i] = `${lines[i]}${suffix}`;
    }
  }
}

/** Check if the target block already contains an Apptics script_phase. */
function targetHasAppticsScriptPhase(lines: string[], targetStartIdx: number): boolean {
  for (let i = targetStartIdx + 1; i < lines.length; i++) {
    const t = (lines[i] ?? '').trim();
    if (t === 'end') break;
    if (t.startsWith('target ')) break;
    if (t.startsWith('abstract_target ')) break;
    if (t.startsWith('script_phase') && t.toLowerCase().includes('apptics')) return true;
  }
  return false;
}

/** Remove duplicate Apptics script_phase lines within a target block (keep first). */
function dedupeAppticsScriptPhases(lines: string[], targetStartIdx: number): void {
  const idxs: number[] = [];
  for (let i = targetStartIdx + 1; i < lines.length; i++) {
    const t = (lines[i] ?? '').trim();
    if (t === 'end') break;
    if (t.startsWith('target ')) break;
    if (t.startsWith('abstract_target ')) break;
    if (t.startsWith('script_phase') && t.toLowerCase().includes('apptics')) {
      idxs.push(i);
    }
  }
  if (idxs.length <= 1) return;
  // Remove duplicates from bottom to top, keep the first occurrence.
  for (let i = idxs.length - 1; i >= 1; i--) {
    lines.splice(idxs[i]!, 1);
  }
}

/** Remove duplicate Apptics script phases across all target blocks. */
function dedupeAppticsScriptPhasesInAllTargets(lines: string[]): void {
  for (let i = 0; i < lines.length; i++) {
    const t = (lines[i] ?? '').trim();
    if (t.startsWith('target ')) {
      dedupeAppticsScriptPhases(lines, i);
    }
  }
}

/**
 * Remove duplicate Apptics script phases in a Podfile (keep first per target).
 * Useful for recovering from invalid Podfile errors before pod install.
 */
export async function dedupeAppticsScriptPhasesInPodfile(podfilePath: string): Promise<void> {
  const resolved = path.resolve(podfilePath);
  if (!(await fileExists(resolved))) {
    return;
  }
  const content = await fs.readFile(resolved, 'utf-8');
  const lines = splitLines(content);
  dedupeAppticsScriptPhasesInAllTargets(lines);
  const cleaned = lines.join('\n');
  if (cleaned !== content) {
    await fs.writeFile(resolved, cleaned, 'utf-8');
  }
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

  // Ensure platform line exists (prevents CocoaPods warning -> failure in some envs)
  const projectDir = path.dirname(podfilePath);
  const buildSettings = await getBuildSettings(projectDir);
  const defaultVersion = buildSettings.deploymentTarget ?? getMinDeploymentTarget(buildSettings.platform);
  content = ensurePlatformLine(content, buildSettings.platform, defaultVersion);

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
  const podSourceSuffix = getAppticsPodSourceSuffix(content);

  // Find main app target: exclude intents, widgets, extensions, tests.
  // Prefer the first target that actually exists in the Podfile.
  const excludePatterns = ['intent', 'widget', 'extension', 'uitest', 'unittest'];
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

  // Clean up duplicate Apptics script phases (if any) before inserting.
  dedupeAppticsScriptPhasesInAllTargets(lines);

  // Find main target line index (if present).
  let mainTargetLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isTargetDoLine(lines[i] ?? '', mainTargetName)) {
      mainTargetLineIdx = i;
      break;
    }
  }

  if (mainTargetLineIdx >= 0) {
    // Clean up duplicate Apptics script phases before any edits.
    dedupeAppticsScriptPhases(lines, mainTargetLineIdx);
    // Ensure existing Apptics pods use the same source (if required).
    addSourceSuffixToAppticsPodsInTarget(lines, mainTargetLineIdx, podSourceSuffix);
    content = lines.join('\n');
  }

  // Insert main Apptics pods into the main app target
  if (mainPods.length > 0 && !mainTargetAlreadyHasApptics && mainTargetLineIdx >= 0) {
    const podLines = mainPods
      .map((p) => `    pod '${p}', ${versionExpr}${podSourceSuffix}`)
      .join('\n');
    const scriptPhase =
      '    script_phase :name => \'Apptics pre build\', :script => \'sh "./Pods/Apptics-SDK/scripts/run" --upload-symbols-for-configurations="Release, Appstore" --config-file-path="${ZA_APPTICS_PATH}" --app-group-identifier="${ZA_WIDGET_APP_GROUP_ID}"\', :execution_position => :before_compile';
    const toInsert = targetHasAppticsScriptPhase(lines, mainTargetLineIdx)
      ? `${podLines}`
      : `${podLines}\n${scriptPhase}`;
    lines.splice(mainTargetLineIdx + 1, 0, toInsert);
    content = lines.join('\n');
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

  // Final cleanup: remove duplicate Apptics script phases after all edits.
  {
    const finalLines = splitLines(content);
    dedupeAppticsScriptPhasesInAllTargets(finalLines);
    content = finalLines.join('\n');
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

  // If Podfile exists, dedupe Apptics script phases before any edits.
  if (exists) {
    const original = await fs.readFile(resolved, 'utf-8');
    const lines = splitLines(original);
    dedupeAppticsScriptPhasesInAllTargets(lines);
    const cleaned = lines.join('\n');
    if (cleaned !== original) {
      await fs.writeFile(resolved, cleaned, 'utf-8');
    }
  }

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

  const buildSettings = await getBuildSettings(projectDir);
  const platform = buildSettings.platform;
  const deploymentVersion = buildSettings.deploymentTarget ?? getMinDeploymentTarget(platform);

  const podfileJson = exists
    ? await readPodfileJSON(resolved, projectDir)
    : createBasePodfile(targetNames, podsToAdd[0] ?? sdkPod, platform, deploymentVersion);

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
  const platformKey = platform === 'macos' ? 'osx' : 'ios';
  for (const tname of targetNames) {
    if (!existingNames.has(tname)) {
      podfileJson.target_definitions.push({
        name: tname,
        platform: { [platformKey]: deploymentVersion },
        uses_frameworks: true,
        dependencies: [...podsToAdd]
      });
    }
  }

  await writePodfileJSON(resolved, projectDir, podfileJson, platform, deploymentVersion);
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

async function writePodfileJSON(
  podfilePath: string,
  cwd: string,
  podfile: PodfileJSON,
  platform: ApplePlatform,
  deploymentVersion: string
): Promise<void> {
  // CocoaPods 1.16.x does not support `pod ipc podfile-from-json`, so render manually.
  const platformKey = platform === 'macos' ? 'osx' : 'ios';
  const version =
    podfile.target_definitions[0]?.children?.[0]?.platform?.[platformKey] ||
    podfile.target_definitions[0]?.platform?.[platformKey] ||
    deploymentVersion;
  const content = renderPodfile(podfile, platform, version);
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

function renderPodfile(podfile: PodfileJSON, platform: ApplePlatform, deploymentVersion: string): string {
  const podPlatform = platform === 'macos' ? ':osx' : ':ios';
  const platformKey = platform === 'macos' ? 'osx' : 'ios';
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
    const defVersion = def.platform?.[platformKey];
    if (defVersion) {
      lines.push(`${inner}platform ${podPlatform}, '${defVersion}'`);
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
  
function createBasePodfile(
  targetNames: string[],
  podName: string,
  platform: ApplePlatform,
  deploymentVersion: string
): PodfileJSON {
  const platformKey = platform === 'macos' ? 'osx' : 'ios';
  const defs = targetNames.map<PodTargetDefinition>((name) => ({
    name,
    platform: { [platformKey]: deploymentVersion },
    uses_frameworks: true,
    dependencies: [podName]
  }));

  return {
    target_definitions: defs
  };
}

