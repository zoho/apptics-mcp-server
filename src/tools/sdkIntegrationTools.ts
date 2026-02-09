import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import type { Dirent } from "fs";
import { getAppticsClient, getAppticsSdkConfigClient } from "../appticsConfig.js";
import { completeIOSIntegration, verifyAppticsIntegration } from "../sdk-integration/ios/index.js";
import { validateOptionalModuleIds, OPTIONAL_MODULE_IDS } from "../sdk-integration/ios/appticsOptionalModules.js";
import { switchAppticsDependency } from "../dependency-switcher/ios/switcher.js";
import { detectAppticsDependency } from "../dependency-switcher/ios/detectors.js";
import type { IOSLanguage, TargetSelection } from "../dependency-switcher/ios/types.js";
import type { AppEntryPoint } from "../sdk-integration/ios/pbxprojUtils.js";

type IntegrationHints = {
  projectPath: string;
  targetName?: string | undefined;
  targetNames?: TargetSelection | undefined;
  language?: IOSLanguage | undefined;
  configFileSource?: string | undefined;
  appDelegatePath?: string | undefined;
  swiftUIAppPath?: string | undefined;
  appEntryPoint?: AppEntryPoint | undefined;
  alternateBundleId?: string | undefined;
};

type ResolvedIntegrationInputs = {
  projectPath: string;
  targetNames: string[];
  targetName: string;
  language: IOSLanguage;
  configFileSource: string;
  entryPoint: AppEntryPoint;
  entryFilePath: string;
  swiftUIAppPath?: string | undefined;
  appDelegatePath?: string | undefined;
};

type AppDelegateMatch = {
  path: string;
  language: IOSLanguage;
};

const DIRECTORY_SKIP_LIST = new Set([
  "Pods",
  ".git",
  "build",
  "DerivedData",
  "node_modules",
  ".build",
  ".expo"
]);

async function resolveIntegrationInputs(hints: IntegrationHints): Promise<ResolvedIntegrationInputs> {
  const resolvedProjectPath = path.resolve(hints.projectPath);
  const configFileSource = await resolveConfigFileSource(resolvedProjectPath, hints.configFileSource, hints.alternateBundleId);

  const normalizedSwiftUIPath = resolveMaybeRelativePath(resolvedProjectPath, hints.swiftUIAppPath);
  const validatedSwiftUIPath = normalizedSwiftUIPath
    ? await ensurePathExists(normalizedSwiftUIPath, "SwiftUI App file")
    : undefined;

  const normalizedAppDelegatePath = resolveMaybeRelativePath(resolvedProjectPath, hints.appDelegatePath);
  const validatedAppDelegatePath = normalizedAppDelegatePath
    ? await ensurePathExists(normalizedAppDelegatePath, "AppDelegate file")
    : undefined;

  const targetNames = await resolveTargetNames(
    resolvedProjectPath,
    hints.targetName ?? (hints.targetNames ? undefined : await inferTargetName(resolvedProjectPath)),
    hints.targetNames ?? (hints.targetName ? undefined : "all")
  );
  const primaryTargetForEntry = targetNames[0];

  const discoveredSwiftUIPath =
    validatedSwiftUIPath ??
    (await findSwiftUIAppFileForTarget(resolvedProjectPath, primaryTargetForEntry)) ??
    (await findSwiftUIAppFile(resolvedProjectPath));

  const discoveredAppDelegate = validatedAppDelegatePath
    ? { path: validatedAppDelegatePath, language: inferLanguageFromAppDelegate(validatedAppDelegatePath) }
    : (await findAppDelegateFileForTarget(resolvedProjectPath, primaryTargetForEntry)) ??
      (await findAppDelegateFile(resolvedProjectPath));
  const targetName = targetNames[0]!;

  const language = determineLanguage({
    providedLanguage: hints.language,
    swiftUIPath: discoveredSwiftUIPath,
    appDelegateMatch: discoveredAppDelegate
  });

  const entryResolution = resolveEntryPointSelection({
    preferredEntryPoint: hints.appEntryPoint,
    swiftUIPath: discoveredSwiftUIPath,
    appDelegateMatch: discoveredAppDelegate,
    language
  });

  return {
    projectPath: resolvedProjectPath,
    targetNames,
    targetName,
    language,
    configFileSource,
    entryPoint: entryResolution.entryPoint,
    entryFilePath: entryResolution.entryFilePath,
    swiftUIAppPath: entryResolution.swiftUIAppPath,
    appDelegatePath: entryResolution.appDelegatePath
  };
}

async function extractBundleIdFromProject(projectPath: string): Promise<string | null> {
  try {
    const pbxprojPath = await findPbxprojPath(projectPath);
    const { openProject, getNativeTargets } = await import('../sdk-integration/ios/utils.js');
    const parsed = await openProject(pbxprojPath);
    const objects = parsed.objects as Record<string, unknown>;
    const buildConfigs = (objects.XCBuildConfiguration ?? {}) as Record<string, { buildSettings?: Record<string, string> } | undefined>;
    const configLists = (objects.XCConfigurationList ?? {}) as Record<string, { buildConfigurations?: string[] } | undefined>;

    // Prefer bundle ID from a native (app) target's build configuration
    const nativeTargets = getNativeTargets(parsed.project);
    for (const { target } of nativeTargets) {
      const listId = (target as { buildConfigurationList?: string }).buildConfigurationList;
      if (!listId) continue;
      const list = configLists[listId];
      const configIds = list?.buildConfigurations;
      if (!Array.isArray(configIds)) continue;
      for (const configId of configIds) {
        const config = buildConfigs[configId];
        const buildSettings = config?.buildSettings;
        const bundleId = buildSettings?.PRODUCT_BUNDLE_IDENTIFIER;
        if (typeof bundleId === 'string' && bundleId.trim()) {
          return bundleId.trim();
        }
      }
    }

    // Fallback: any build configuration that has PRODUCT_BUNDLE_IDENTIFIER
    for (const [key, config] of Object.entries(buildConfigs)) {
      if (key.endsWith('_comment')) continue;
      const buildSettings = (config as any)?.buildSettings;
      const bundleId = buildSettings?.PRODUCT_BUNDLE_IDENTIFIER;
      if (typeof bundleId === 'string' && bundleId.trim()) {
        return bundleId.trim();
      }
    }

    return null;
  } catch (error) {
    return null;
  }
}

/** Normalize portals/projects API result to (projectId, zsoId) pairs for iterating. */
function getProjectPortalPairs(portalsResult: unknown): { projectId: string; zsoId: string }[] {
  const pairs: { projectId: string; zsoId: string }[] = [];
  const raw = portalsResult as Record<string, unknown> | unknown[];
  const portals = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).portals))
      ? (raw as Record<string, unknown>).portals as Record<string, unknown>[]
      : (raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).data))
        ? (raw as Record<string, unknown>).data as Record<string, unknown>[]
        : [];
  if (!Array.isArray(portals)) return pairs;
  for (const portal of portals) {
    if (!portal || typeof portal !== "object") continue;
    const p = portal as Record<string, unknown>;
    const zsoId = String(p.zsoid ?? p.zsoId ?? p.id ?? "").trim();
    const projects = Array.isArray(p.projects) ? p.projects : Array.isArray(p.projectList) ? p.projectList : [];
    for (const proj of projects) {
      if (!proj || typeof proj !== "object") continue;
      const pr = proj as Record<string, unknown>;
      // API returns "projectid" (all lowercase), not "projectId" or "project_id"
      const projectId = String(pr.projectid ?? pr.projectId ?? pr.project_id ?? pr.id ?? "").trim();
      if (projectId && zsoId) pairs.push({ projectId, zsoId });
    }
  }
  return pairs;
}

/**
 * If the bundle ID is registered in Apptics (any project), fetch and return its config plist content.
 * Returns null if credentials are missing, no match, or any API error (fallback to default config).
 */
export async function tryFetchAppticsConfigForBundleId(bundleId: string): Promise<string | null> {
  if (!bundleId || !bundleId.trim()) {
    return null;
  }
  try {
    const client = getAppticsClient();
    const sdkConfigClient = getAppticsSdkConfigClient();
    const portalsResult = await client.getPortalsAndProjects();
    const pairs = getProjectPortalPairs(portalsResult);
    for (const { projectId, zsoId } of pairs) {
      try {
        const appsResponse = await sdkConfigClient.getApplications(projectId, zsoId) as {
          result?: string;
          data?: Record<string, { identifier?: string; aaid?: number; brand?: string; type?: number }>;
        };
        const data = appsResponse?.data ?? {};
        for (const aaidStr of Object.keys(data)) {
          const app = data[aaidStr];
          if (!app) continue;
          if (app.identifier !== bundleId) continue;
          const isIos = app.brand === "Apple" || app.type === 0;
          if (!isIos) {
            continue;
          }
          const aaid = app.aaid ?? Number(aaidStr);
          if (!aaid) continue;
          const plistContent = await sdkConfigClient.downloadConfigFile(projectId, zsoId, aaid);
          return plistContent;
        }
      } catch (err) {
        continue;
      }
    }
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * Check if a filename looks like an Apptics config plist (e.g. apptics-config.plist,
 * Appstore-apptics-config.plist, Development/apptics-config.plist).
 */
function isAppticsConfigPlistName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".plist") && lower.includes("apptics") && (lower.includes("config") || lower.includes("-config"));
}

/**
 * Recursively search the project for existing Apptics config plist files.
 * Returns paths sorted by preference: exact "apptics-config.plist" first, then others.
 */
async function findExistingAppticsConfigInProject(projectPath: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (DIRECTORY_SKIP_LIST.has(e.name)) continue;
        await walk(full);
      } else if (e.isFile() && isAppticsConfigPlistName(e.name)) {
        found.push(full);
      }
    }
  }
  await walk(projectPath);
  // Prefer exact "apptics-config.plist" first, then any other
  found.sort((a, b) => {
    const baseA = path.basename(a).toLowerCase();
    const baseB = path.basename(b).toLowerCase();
    if (baseA === "apptics-config.plist" && baseB !== "apptics-config.plist") return -1;
    if (baseA !== "apptics-config.plist" && baseB === "apptics-config.plist") return 1;
    return a.localeCompare(b);
  });
  return found;
}

async function resolveConfigFileSource(projectPath: string, provided?: string, alternateBundleId?: string): Promise<string> {
  if (provided) {
    const candidate = resolveMaybeRelativePath(projectPath, provided);
    if (!candidate) {
      throw new Error("configFileSource is invalid.");
    }
    await ensurePathExists(candidate, "Apptics config file");
    return candidate;
  }

  const defaultPath = path.join(projectPath, "apptics-config.plist");
  const existingConfigs = await findExistingAppticsConfigInProject(projectPath);
  const existing = existingConfigs[0];
  if (existing) {
    return existing;
  }
  if (!(await pathExists(defaultPath))) {
    const projectBundleId = await extractBundleIdFromProject(projectPath);
    
    if (!projectBundleId && !alternateBundleId) {
      throw new Error(
        `❌ Unable to extract bundle ID from Xcode project.\n\n` +
        `Please ensure your project has PRODUCT_BUNDLE_IDENTIFIER set in build settings.\n` +
        `Example: com.company.appname\n\n` +
        `Alternatively, you can provide an alternate bundle ID that's already registered in Apptics:\n` +
        `{ "alternateBundleId": "com.your.registered.bundle.id" }`
      );
    }
    
    // Try with alternate bundle ID first if provided, otherwise use project bundle ID
    const bundleIdToCheck = alternateBundleId || projectBundleId!;
    const configFromApptics = await tryFetchAppticsConfigForBundleId(bundleIdToCheck);
    
    if (configFromApptics) {
      await fs.writeFile(defaultPath, configFromApptics, "utf-8");
      if (alternateBundleId && alternateBundleId !== projectBundleId) {
        console.error(
          `\n⚠️  Note: Using config for bundle ID "${alternateBundleId}" ` +
          `(project bundle ID is "${projectBundleId}").\n` +
          `The config file will work, but be aware of the bundle ID mismatch.\n`
        );
      }
    } else {
      // Config not found
      if (alternateBundleId) {
        // User provided alternate bundle ID but it's not registered
        throw new Error(
          `❌ Alternate bundle ID "${alternateBundleId}" is not registered in Apptics.\n\n` +
          `Please verify the bundle ID and ensure it exists in Apptics Console:\n` +
          `https://apptics.zoho.com\n\n` +
          `The bundle ID must be:\n` +
          `- An iOS/Apple app (not Android)\n` +
          `- Exactly matching the bundle ID in Apptics (case-sensitive)\n\n` +
          `${projectBundleId ? `Project bundle ID detected: ${projectBundleId}` : ''}`
        );
      } else {
        // Project bundle ID not registered
        throw new Error(
          `❌ Bundle ID "${projectBundleId}" is not registered in Apptics.\n\n` +
          `Option 1: Register this bundle ID in Apptics\n` +
          `1. Go to Apptics Console: https://apptics.zoho.com\n` +
          `2. Select or create a project\n` +
          `3. Add a new iOS application with bundle ID: ${projectBundleId}\n` +
          `4. Wait for the app to be created\n` +
          `5. Then run the integration again\n\n` +
          `Option 2: Use a different bundle ID that's already registered\n` +
          `Re-run the integration with the alternateBundleId parameter:\n` +
          `{ "alternateBundleId": "com.your.registered.bundle.id" }\n\n` +
          `The integration will automatically download the config file.`
        );
      }
    }
  }
  return defaultPath;
}

function resolveMaybeRelativePath(projectPath: string, maybePath?: string): string | undefined {
  if (!maybePath) {
    return undefined;
  }

  if (path.isAbsolute(maybePath)) {
    return maybePath;
  }

  return path.join(projectPath, maybePath);
}

async function ensurePathExists(candidate: string, label: string): Promise<string> {
  if (!(await pathExists(candidate))) {
    throw new Error(`${label} not found at ${candidate}`);
  }
  return candidate;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function findPbxprojPath(projectPath: string): Promise<string> {
  // Check if projectPath is already pointing to project.pbxproj
  if (projectPath.endsWith('project.pbxproj')) {
    const stats = await fs.stat(projectPath).catch(() => null);
    if (stats?.isFile()) {
      return projectPath;
    }
  }
  
  // Check if projectPath is already a .xcodeproj directory
  if (projectPath.endsWith('.xcodeproj')) {
    const pbxprojPath = path.join(projectPath, 'project.pbxproj');
    const stats = await fs.stat(pbxprojPath).catch(() => null);
    if (stats?.isFile()) {
      return pbxprojPath;
    }
    // If it's a .xcodeproj directory but project.pbxproj doesn't exist, go up one level
    projectPath = path.dirname(projectPath);
  }
  
  const entries = await fs.readdir(projectPath);
  const xcodeproj = entries.find((entry) => entry.endsWith(".xcodeproj"));
  if (!xcodeproj) {
    throw new Error(`No .xcodeproj found under ${projectPath}`);
  }
  return path.join(projectPath, xcodeproj, "project.pbxproj");
}

async function listProjectTargets(projectPath: string): Promise<string[]> {
  const pbxprojPath = await findPbxprojPath(projectPath);
  const { openProject, getNativeTargets } = await import('../sdk-integration/ios/utils.js');
  const parsed = await openProject(pbxprojPath);
  const nativeTargets = getNativeTargets(parsed.project);
  return nativeTargets.map((t: { name: string }) => t.name);
}

async function inferTargetName(projectPath: string): Promise<string | undefined> {
  try {
    const entries = await fs.readdir(projectPath);
    const xcodeproj = entries.find((entry) => entry.endsWith(".xcodeproj"));
    if (xcodeproj) {
      return path.basename(xcodeproj, ".xcodeproj");
    }
  } catch {
    // ignore
  }
  return undefined;
}

async function resolveTargetNames(
  projectPath: string,
  providedTargetName?: string,
  providedTargetNames?: TargetSelection
): Promise<string[]> {
  const discoveredTargets = await listProjectTargets(projectPath);

  const normalizeList = (items: string[]) =>
    Array.from(
      new Set(
        items
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
      )
    );

  if (providedTargetNames === "all") {
    if (discoveredTargets.length === 0) {
      throw new Error(
        "No PBXNativeTarget entries found. Provide targetNames explicitly."
      );
    }
    return normalizeList(discoveredTargets);
  }

  if (Array.isArray(providedTargetNames) && providedTargetNames.length > 0) {
    const normalized = normalizeList(providedTargetNames);
    // Try exact matches first, then case-insensitive matches
    const matched: string[] = [];
    const missing: string[] = [];
    
    for (const target of normalized) {
      const exactMatch = discoveredTargets.find((dt) => dt === target);
      if (exactMatch) {
        matched.push(exactMatch);
      } else {
        const caseInsensitiveMatch = discoveredTargets.find(
          (dt) => dt.toLowerCase() === target.toLowerCase()
        );
        if (caseInsensitiveMatch) {
          matched.push(caseInsensitiveMatch);
        } else {
          missing.push(target);
        }
      }
    }
    
    if (missing.length > 0 && discoveredTargets.length > 0) {
      throw new Error(
        `Target(s) not found: ${missing.join(
          ", "
        )}. Available targets: ${discoveredTargets.join(", ")}`
      );
    }
    return matched.length > 0 ? matched : normalized;
  }

  if (typeof providedTargetNames === "string" && providedTargetNames.length > 0) {
    const normalized = normalizeList([providedTargetNames]);
    // Try exact match first
    let matched = normalized.filter((t) => discoveredTargets.includes(t));
    // If no exact match, try case-insensitive match
    if (matched.length === 0 && normalized.length > 0) {
      const targetToMatch = normalized[0]!;
      const caseInsensitiveMatch = discoveredTargets.find(
        (dt) => dt.toLowerCase() === targetToMatch.toLowerCase()
      );
      if (caseInsensitiveMatch) {
        matched = [caseInsensitiveMatch];
      }
    }
    if (matched.length === 0 && discoveredTargets.length > 0) {
      throw new Error(
        `Target not found: ${normalized[0]}. Available targets: ${discoveredTargets.join(
          ", "
        )}`
      );
    }
    return matched.length > 0 ? matched : normalized;
  }

  if (providedTargetName) {
    const normalized = normalizeList([providedTargetName]);
    // Try exact match first
    let matched = normalized.filter((t) => discoveredTargets.includes(t));
    // If no exact match, try case-insensitive match
    if (matched.length === 0 && normalized.length > 0) {
      const targetToMatch = normalized[0]!;
      const caseInsensitiveMatch = discoveredTargets.find(
        (dt) => dt.toLowerCase() === targetToMatch.toLowerCase()
      );
      if (caseInsensitiveMatch) {
        matched = [caseInsensitiveMatch];
      }
    }
    if (matched.length === 0 && discoveredTargets.length > 0) {
      throw new Error(
        `Target not found: ${normalized[0]}. Available targets: ${discoveredTargets.join(
          ", "
        )}`
      );
    }
    return matched.length > 0 ? matched : normalized;
  }

  if (discoveredTargets.length === 1) {
    const soleTarget = discoveredTargets[0]!;
    return [soleTarget];
  }

  if (discoveredTargets.length === 0) {
    throw new Error(
      "No targets discovered. Provide targetNames or targetName explicitly."
    );
  }

  throw new Error(
    `Multiple targets found: ${discoveredTargets.join(
      ", "
    )}. Specify targetNames (array) or pass \"all\" to integrate all targets.`
  );
}

function determineLanguage(params: {
  providedLanguage?: IOSLanguage | undefined;
  swiftUIPath?: string | undefined;
  appDelegateMatch?: AppDelegateMatch | undefined;
}): IOSLanguage {
  if (params.providedLanguage) {
    return params.providedLanguage;
  }
  if (params.swiftUIPath) {
    return "swift";
  }
  if (params.appDelegateMatch) {
    return params.appDelegateMatch.language;
  }
  return "swift";
}

function resolveEntryPointSelection(params: {
  preferredEntryPoint?: AppEntryPoint | undefined;
  swiftUIPath?: string | undefined;
  appDelegateMatch?: AppDelegateMatch | undefined;
  language: IOSLanguage;
}): {
  entryPoint: AppEntryPoint;
  entryFilePath: string;
  swiftUIAppPath?: string | undefined;
  appDelegatePath?: string | undefined;
} {
  if (params.preferredEntryPoint === "swiftUI") {
    if (params.language !== "swift") {
      throw new Error("SwiftUI entry point requires a Swift project (language: swift).");
    }
    if (!params.swiftUIPath) {
      throw new Error("SwiftUI entry point requested but no SwiftUI @main App file was found. Provide swiftUIAppPath.");
    }
    return {
      entryPoint: "swiftUI",
      entryFilePath: params.swiftUIPath,
      swiftUIAppPath: params.swiftUIPath
    };
  }

  if (params.preferredEntryPoint === "appDelegate") {
    if (!params.appDelegateMatch) {
      throw new Error("AppDelegate entry point requested but no AppDelegate file was found. Provide appDelegatePath.");
    }
    return {
      entryPoint: "appDelegate",
      entryFilePath: params.appDelegateMatch.path,
      appDelegatePath: params.appDelegateMatch.path
    };
  }

  if (params.swiftUIPath && params.language === "swift") {
    return {
      entryPoint: "swiftUI",
      entryFilePath: params.swiftUIPath,
      swiftUIAppPath: params.swiftUIPath
    };
  }

  if (params.appDelegateMatch) {
    return {
      entryPoint: "appDelegate",
      entryFilePath: params.appDelegateMatch.path,
      appDelegatePath: params.appDelegateMatch.path
    };
  }

  throw new Error("Unable to locate a SwiftUI @main App or AppDelegate file. Provide appDelegatePath or swiftUIAppPath explicitly.");
}

function inferLanguageFromAppDelegate(filePath: string): IOSLanguage {
  return filePath.endsWith(".m") || filePath.endsWith(".mm") ? "objc" : "swift";
}

async function findSwiftUIAppFile(projectPath: string): Promise<string | undefined> {
  return findFileByPredicate(projectPath, async (candidate) => {
    if (!candidate.endsWith(".swift")) {
      return false;
    }
    const content = await readFileSnippet(candidate, 4000);
    const lines = content.split('\n');
    let hasMain = false;
    let hasAppStruct = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('@main')) hasMain = true;
      if (trimmed.includes('struct ') && trimmed.includes(': App')) hasAppStruct = true;
    }
    return hasMain && hasAppStruct;
  });
}

async function findAppDelegateFile(projectPath: string): Promise<AppDelegateMatch | undefined> {
  const swiftPath = await findFileByPredicate(projectPath, async (candidate) =>
    candidate.endsWith("AppDelegate.swift")
  );
  if (swiftPath) {
    return { path: swiftPath, language: "swift" };
  }

  const objcPath = await findFileByPredicate(projectPath, async (candidate) =>
    candidate.endsWith("AppDelegate.m") || candidate.endsWith("AppDelegate.mm")
  );
  if (objcPath) {
    return { path: objcPath, language: "objc" };
  }

  return undefined;
}

async function findSwiftUIAppFileForTarget(projectPath: string, targetName?: string): Promise<string | undefined> {
  if (!targetName) return undefined;
  
  // First try: look in directory named after target
  const targetDir = path.join(projectPath, targetName);
  if (await pathExists(targetDir)) {
    const result = await findSwiftUIAppFile(targetDir);
    if (result) return result;
  }
  
  // Second try: search for files containing target name in their path
  // This handles cases where target files are in subdirectories like "SubB/SubB/App.swift"
  const allSwiftFiles = await findFileByPredicate(projectPath, async (candidate) => {
    const normalized = candidate.toLowerCase();
    return (normalized.includes(targetName.toLowerCase()) && 
            (normalized.endsWith('app.swift') || normalized.includes('@main')));
  });
  if (allSwiftFiles) {
    try {
      const content = await fs.readFile(allSwiftFiles, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('@main')) return allSwiftFiles;
        if (trimmed.includes('struct ') && trimmed.includes(': App')) return allSwiftFiles;
      }
    } catch {
      // ignore
    }
  }
  
  return undefined;
}

async function findAppDelegateFileForTarget(projectPath: string, targetName?: string): Promise<AppDelegateMatch | undefined> {
  if (!targetName) return undefined;
  
  // First try: look in directory named after target
  const targetDir = path.join(projectPath, targetName);
  if (await pathExists(targetDir)) {
    const swiftPath = await findFileByPredicate(targetDir, async (candidate) =>
      candidate.endsWith("AppDelegate.swift")
    );
    if (swiftPath) {
      return { path: swiftPath, language: "swift" };
    }

    const objcPath = await findFileByPredicate(targetDir, async (candidate) =>
      candidate.endsWith("AppDelegate.m") || candidate.endsWith("AppDelegate.mm")
    );
    if (objcPath) {
      return { path: objcPath, language: "objc" };
    }
  }
  
  // Second try: search for AppDelegate files containing target name in their path
  // This handles cases where target files are in subdirectories
  const swiftDelegatePath = await findFileByPredicate(projectPath, async (candidate) => {
    const normalized = candidate.toLowerCase();
    return normalized.includes(targetName.toLowerCase()) && 
           candidate.endsWith("AppDelegate.swift");
  });
  if (swiftDelegatePath) {
    return { path: swiftDelegatePath, language: "swift" };
  }

  const objcDelegatePath = await findFileByPredicate(projectPath, async (candidate) => {
    const normalized = candidate.toLowerCase();
    return normalized.includes(targetName.toLowerCase()) && 
           (candidate.endsWith("AppDelegate.m") || candidate.endsWith("AppDelegate.mm"));
  });
  if (objcDelegatePath) {
    return { path: objcDelegatePath, language: "objc" };
  }

  return undefined;
}

async function readFileSnippet(filePath: string, maxLength: number): Promise<string> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content.slice(0, maxLength);
  } catch {
    return "";
  }
}

async function findFileByPredicate(
  root: string,
  predicate: (candidate: string) => Promise<boolean>
): Promise<string | undefined> {
  const stack: string[] = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    const entries = await safeReaddir(current);
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!DIRECTORY_SKIP_LIST.has(entry.name)) {
          stack.push(fullPath);
        }
      } else if (entry.isFile()) {
        if (await predicate(fullPath)) {
          return fullPath;
        }
      }
    }
  }

  return undefined;
}

async function safeReaddir(dirPath: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Register SDK integration tools to the MCP server
 */
export function registerSdkIntegrationTools(server: McpServer): void {
  // Fetch Apptics config by bundle ID (e.g. to download apptics-config.plist for a registered app)
  server.registerTool("fetch_apptics_config_by_bundle_id", {
    description: "Fetch Apptics configuration (apptics-config.plist content) for a given iOS bundle ID. Use when the app is registered in Apptics and you need the config file (e.g. for integration, alternate bundle ID, or verification).",
    inputSchema: {
      bundleId: z.string().describe("iOS bundle ID to fetch config for (e.g. com.example.app)")
    }
  }, async ({ bundleId }) => {
    const configContent = await tryFetchAppticsConfigForBundleId(bundleId);
    if (configContent) {
      return {
        content: [{
          type: 'text' as const,
          text: `Config found for ${bundleId}\n\nPreview (first 500 chars):\n${configContent.substring(0, 500)}${configContent.length > 500 ? '...' : ''}\n\nFull length: ${configContent.length} bytes`
        }]
      };
    } else {
      return {
        content: [{
          type: 'text' as const,
          text: `No config found for bundle ID: ${bundleId}. Ensure the app is registered in Apptics and the bundle ID is correct.`
        }]
      };
    }
  });

  // iOS SDK Integration Tool
  server.registerTool("integrate_apptics_ios_sdk", {
    description: `🚨 MCP TOOL AVAILABLE - USE THIS TOOL, NOT WEB SEARCH OR MANUAL FILE CREATION 🚨

This is an automated MCP tool named "integrate_apptics_ios_sdk" that integrates Zoho Apptics SDK into iOS Xcode projects.

CRITICAL: When the user requests ANY of these phrases, you MUST call the MCP tool "integrate_apptics_ios_sdk" immediately:
- "integrate apptics ios sdk"
- "add apptics to ios project"  
- "integrate apptics sdk"
- "add apptics ios"
- "install apptics ios sdk"
- "setup apptics for ios"
- "integrate apptics"
- Any variation of integrating Apptics into an iOS project

DO NOT:
- ❌ Search the web for integration instructions
- ❌ Manually create Swift files
- ❌ Manually edit Xcode project files
- ❌ Write code snippets
- ❌ Create TODO lists

DO THIS INSTEAD:
- ✅ Call the MCP tool "integrate_apptics_ios_sdk" with the projectPath parameter
- ✅ The tool handles ALL integration steps automatically

WHAT IT DOES:
1. Checks prerequisites (Xcode version, CocoaPods/SPM, iOS deployment target)
2. Adds Apptics SDK dependency via CocoaPods or Swift Package Manager (defaults to SPM)
3. Adds apptics-config.plist to the project
4. Disables user script sandboxing in Xcode project
5. Installs dependencies (runs pod install for CocoaPods, resolves SPM packages)
6. Adds Apptics import statements to entry files
7. Injects Apptics initialization code into AppDelegate or SwiftUI App
8. Creates AppticsManager.swift wrapper file (optional, enabled by default)
9. Links all files to Xcode project targets
10. Verifies the integration

REQUIRED: Only the projectPath parameter is required. The tool auto-detects:
- Target names (can also specify via targetNames parameter)
- Project language (Swift/Objective-C)
- Entry point (AppDelegate vs SwiftUI App)
- Config file location

TARGET SELECTION: When the user mentions a specific target name (e.g., "in the SubB target", "for SubB", "to SubB", "SubB target"), extract the target name and pass it via the targetNames parameter. Examples:
- "integrate apptics ios sdk" → no targetNames (defaults to all targets)
- "integrate apptics ios sdk in all targets" → targetNames: "all"
- "integrate apptics ios sdk in the SubB target" → targetNames: "SubB"
- "integrate apptics ios sdk for SubB and MainApp" → targetNames: ["SubB", "MainApp"]

OPTIONAL MODULES: When the user asks for extra features, pass the corresponding ids in optionalModules. Valid ids: remoteConfig, feedbackKit, rateUs, crashKit, apiTracker, inAppUpdate, messaging, crossPromotion, privacyShield, notificationServiceExtension. Map natural language to ids and pass an array. Examples:
- "integrate Apptics with Remote Config" or "add remote configuration" → optionalModules: ["remoteConfig"]
- "integrate with in-app feedback" or "add FeedbackKit" → optionalModules: ["feedbackKit"]
- "add rate us / in-app rating" → optionalModules: ["rateUs"]
- "include crash reporting" or "add crash kit" → optionalModules: ["crashKit"]
- "add API tracking" or "track API calls" → optionalModules: ["apiTracker"]
- "add in-app update" → optionalModules: ["inAppUpdate"]
- "add push messaging" or "Apptics Messaging" → optionalModules: ["messaging"]
- "add cross promotion" or "AppticsCrossPromotion" → optionalModules: ["crossPromotion"]
- "add privacy shield" or "AppticsPrivacyShield" → optionalModules: ["privacyShield"]
- "add Notification Service Extension" or "push notification content extension" → optionalModules: ["notificationServiceExtension"]; also pass notificationServiceExtensionTargetNames with the NSE target name(s) and include those targets in targetNames.
- "add all optional modules" → optionalModules: ["remoteConfig", "feedbackKit", "rateUs", "crashKit", "apiTracker", "inAppUpdate", "messaging", "crossPromotion", "privacyShield"] (add notificationServiceExtension + notificationServiceExtensionTargetNames if the project has an NSE target).
- No mention of optional features → omit optionalModules (core only).

INCREMENTAL OPTIONAL MODULES: When the user asks to \"add\" an optional module (e.g. \"add Privacy Shield\") to an already-integrated project, pass the FULL list of desired optional modules (existing + new), e.g. optionalModules: [\"rateUs\", \"privacyShield\"], not just the new one. This keeps Podfile, entry-file imports/config, and AppticsManager in sync and avoids manual steps.

PACKAGE MANAGER BEHAVIOR FOR OPTIONAL MODULES:
- CocoaPods: optional modules add separate pods (e.g. AppticsRemoteConfig, AppticsFeedbackKit) per requested module.
- SPM: Apptics-SP supports per-module products. By default only the core product (AppticsAnalytics or AppticsAnalyticscoreWithKSCrash when crashKit is requested) is added. When optionalModules are requested, add the corresponding SPM products per module (e.g. AppticsRemoteConfig, AppticsFeedbackKitSwift) in addition to config and AppticsManager extensions.

This is a complete, automated integration tool that modifies Xcode project files directly.`,
    inputSchema: {
      projectPath: z.string().describe("Absolute path to the iOS Xcode project directory"),
      packageManager: z.enum(["cocoapods", "spm"]).optional().default("spm").describe("Package manager to use for SDK integration. 'cocoapods' for CocoaPods or 'spm' for Swift Package Manager. Defaults to 'spm' if not specified."),
      spmProductName: z.string().optional().describe("SPM package product name (e.g., 'AppticsAnalytics'). If not specified, defaults to 'AppticsAnalytics' for both Swift and Objective-C projects. Note: 'Apptics' is a binary target but not a product; 'AppticsAnalytics' is the main product that includes Apptics and all core functionality."),
      targetName: z.string().optional().describe("Xcode target name. Defaults to the .xcodeproj name. DEPRECATED: Prefer using targetNames parameter instead."),
      targetNames: z.union([z.literal("all"), z.array(z.string()), z.string()]).optional().describe("List of Xcode targets to integrate. Pass \"all\" to integrate every discovered target. When user mentions a specific target name (e.g., 'in the SubB target', 'for SubB'), extract the target name and pass it here as a string. For multiple targets, pass an array of strings. Examples: 'SubB' for single target, ['SubB', 'MainApp'] for multiple, 'all' for all targets."),
      language: z.enum(["swift", "objc"]).optional().describe("Project language. Defaults to Swift when detectable."),
      configFileSource: z.string().optional().describe("Path to the apptics-config.plist file. Defaults to <projectPath>/apptics-config.plist."),
      alternateBundleId: z.string().optional().describe("Optional iOS bundle ID to use if the project's bundle ID is not registered in Apptics. The tool will verify this bundle ID exists in Apptics and download its config. Useful when: (1) Project bundle ID differs from registered app, (2) Using a development/staging bundle ID, (3) Testing with an existing app's config. Must be an iOS/Apple bundle ID (e.g., 'com.company.app'), not Android."),
      appDelegatePath: z.string().optional().describe("Absolute or project-relative path to AppDelegate file (e.g., AppDelegate.swift). Only needed if auto-detection fails."),
      swiftUIAppPath: z.string().optional().describe("Absolute or project-relative path to the SwiftUI App entry file (e.g., MyApp.swift). Only needed if auto-detection fails."),
      appEntryPoint: z.enum(["appDelegate","swiftUI"]).optional().describe("Where to insert the Apptics initialization. Defaults to 'swiftUI' when a SwiftUI @main App is detected; otherwise 'appDelegate'."),
      verbose: z.boolean().optional().default(true).describe("Enable verbose mode for SDK initialization"),
      createAppticsManagerFile: z.boolean().optional().default(true).describe("Set to true to generate an AppticsManager.swift convenience wrapper inside the project."),
      appticsManagerFilePath: z.string().optional().describe("Optional absolute or project-relative path where AppticsManager.swift should be written. Defaults to <projectPath>/AppticsManager.swift."),
      overwriteAppticsManagerFile: z.boolean().optional().describe("Overwrite AppticsManager.swift if it already exists."),
      useAppticsManagerWrapper: z.boolean().optional().describe("Use AppticsManager shared wrapper for initialization/tracking. Defaults to true when createAppticsManagerFile is true."),
      optionalModules: z.array(z.string()).optional().describe(`Optional Apptics module ids to add (dependencies + AppticsManager extensions). Valid ids: ${OPTIONAL_MODULE_IDS.join(", ")}. Example: ["remoteConfig", "feedbackKit", "rateUs"].`),
      notificationServiceExtensionTargetNames: z.array(z.string()).optional().describe("When using optionalModules including 'notificationServiceExtension', list the Notification Service Extension target name(s) here so the NSE pod is added only to those targets. Main app targets get other optional pods; NSE targets get only AppticsNotificationServiceExtension."),
      additionalCocoaPods: z.array(z.string()).optional().describe("Extra CocoaPods pod names to add to every main app target (e.g. missing or private pods). Example: [\"SomePrivatePod\", \"AppticsNotificationServiceExtension\"] when you need pods not in the optional modules list."),
      config: z.object({
        sendDataOnMobileNetworkByDefault: z.boolean().optional().default(true).describe("Allow SDK to send data over mobile network"),
        trackOnByDefault: z.boolean().optional().default(true).describe("Enable tracking by default before user consent"),
        anonymousType: z.enum(["pseudoAnonymous", "nonAnonymous"]).optional().default("pseudoAnonymous").describe("Type of tracking (pseudoAnonymous or nonAnonymous)"),
        uploadSymbolsConfigurations: z.string().optional().default("Release, Appstore").describe("Comma-separated build configurations for dSYM upload (e.g., 'Release, Appstore')"),
        appGroupIdentifier: z.string().optional().describe("Optional app group identifier if app extensions are used"),
        uploadFrameworks: z.string().optional().describe("Optional comma-separated list of third-party frameworks for dSYM upload (e.g., 'AFNetworking, SwiftyJSON')"),
        configFilePath: z.string().optional().describe("Optional custom path to apptics-config.plist if not in project root")
      }).optional()
    }
  }, async({
    projectPath,
    packageManager,
    spmProductName,
    targetName,
    targetNames,
    language,
    configFileSource,
    alternateBundleId,
    appDelegatePath,
    swiftUIAppPath,
    appEntryPoint,
    verbose,
    config,
    optionalModules,
    notificationServiceExtensionTargetNames,
    additionalCocoaPods,
    createAppticsManagerFile,
    appticsManagerFilePath,
    overwriteAppticsManagerFile,
    useAppticsManagerWrapper
  }) => {
    const resolvedInputs = await resolveIntegrationInputs({
      projectPath,
      targetName,
      targetNames,
      language,
      configFileSource,
      alternateBundleId,
      appDelegatePath,
      swiftUIAppPath,
      appEntryPoint
    });

    const optionalModuleIds = optionalModules && optionalModules.length > 0
      ? (() => {
          const { valid, invalid } = validateOptionalModuleIds(optionalModules);
          if (invalid.length > 0) {
            throw new Error(
              `Invalid optionalModules: ${invalid.join(", ")}. Valid ids: ${OPTIONAL_MODULE_IDS.join(", ")}.`
            );
          }
          return valid;
        })()
      : undefined;

    const requestedPM = packageManager ?? 'spm';

    // If Apptics is already integrated via the other package manager (or both), switch first then run integrate
    const detection = await detectAppticsDependency(resolvedInputs.projectPath);
    const needsSwitch =
      (detection.state === 'spm' && requestedPM === 'cocoapods') ||
      (detection.state === 'cocoapods' && requestedPM === 'spm') ||
      detection.state === 'both';

    let switchResult: Awaited<ReturnType<typeof switchAppticsDependency>> | undefined;

    if (needsSwitch) {
      if (verbose) {
        console.error(`Apptics is currently integrated via ${detection.state}. Switching to ${requestedPM} first...`);
      }
      switchResult = await switchAppticsDependency({
        projectPath: resolvedInputs.projectPath,
        to: requestedPM,
        targetNames: resolvedInputs.targetNames,
        language: resolvedInputs.language,
        ...(spmProductName && { spmProductName }),
        confirmSpmSwitch: requestedPM === 'spm',
        verbose: !!verbose,
        skipBuild: true
      });
      if (!switchResult.success) {
        const responseData: any = {
          success: false,
          switched: true,
          switchResult,
          message: `Switch to ${requestedPM} failed. Integration not run.`
        };
        if (switchResult.needsConfirmation) {
          responseData.needsConfirmation = switchResult.needsConfirmation;
          responseData.message = `Switch requires confirmation (e.g. confirmSpmSwitch: true when switching to SPM).`;
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(responseData, null, 2) }] };
      }
      if (verbose) {
        console.error(`Switched to ${requestedPM}. Proceeding with config, entry, and manager steps...`);
      }
    }

    // Run complete integration
    const integrationParams: Parameters<typeof completeIOSIntegration>[0] = {
      projectPath: resolvedInputs.projectPath,
      targetNames: resolvedInputs.targetNames,
      language: resolvedInputs.language,
      configFileSource: resolvedInputs.configFileSource,
      entryFilePath: resolvedInputs.entryFilePath,
      entryPoint: resolvedInputs.entryPoint,
      packageManager: packageManager ?? 'spm',
      ...(spmProductName && { spmProductName }),
      ...(optionalModuleIds && optionalModuleIds.length > 0 && { optionalModuleIds }),
      ...(notificationServiceExtensionTargetNames && notificationServiceExtensionTargetNames.length > 0 && { notificationServiceExtensionTargetNames }),
      ...(additionalCocoaPods && additionalCocoaPods.length > 0 && { additionalCocoaPods }),
      verbose,
      config
    };

    integrationParams.createManagerFile =
      typeof createAppticsManagerFile !== "undefined" ? createAppticsManagerFile : true;
    if (typeof appticsManagerFilePath !== "undefined") {
      const resolvedManagerPath = resolveMaybeRelativePath(resolvedInputs.projectPath, appticsManagerFilePath);
      if (resolvedManagerPath) {
        integrationParams.managerFilePath = resolvedManagerPath;
      }
    }
    if (typeof overwriteAppticsManagerFile !== "undefined") {
      integrationParams.overwriteManagerFile = overwriteAppticsManagerFile;
    }
    const managerWrapperPreference =
      typeof useAppticsManagerWrapper !== "undefined"
        ? useAppticsManagerWrapper
        : integrationParams.createManagerFile;

    if (typeof managerWrapperPreference !== "undefined") {
      integrationParams.useManagerWrapper = managerWrapperPreference;
    }

    const result = await completeIOSIntegration(integrationParams);

    // Also run verification to get final checks
    let verificationChecks = {};
    try {
      const verification = await verifyAppticsIntegration({
        projectPath: resolvedInputs.projectPath,
        entryFilePath: resolvedInputs.entryFilePath,
        language: resolvedInputs.language,
        entryPoint: resolvedInputs.entryPoint,
        targetNames: resolvedInputs.targetNames,
        useManagerWrapper: managerWrapperPreference ?? false,
        packageManager: packageManager ?? 'spm'
      });
      verificationChecks = verification.checks;
    } catch (error) {
      // Verification might fail if integration failed
      console.error('Verification check failed:', error);
    }

    // Format response based on success/failure
    const responseData: any = {
      ...result,
      verificationChecks
    };
    if (switchResult) {
      responseData.switched = true;
      responseData.switchResult = switchResult;
    }

    // If integration failed and we have a failure report, add helpful info
    if (!result.success && result.failureReportPath) {
      responseData.failureReport = {
        path: result.failureReportPath,
        message: `A detailed failure report has been saved to: ${result.failureReportPath}`,
        instructions: 'Share this file with the development team or support for detailed diagnostics.'
      };
    }

    return {
      content: [{
        type: 'text', 
        text: JSON.stringify(responseData, null, 2)
      }]
    };
  });

  // Apptics Dependency Switcher Tool
  server.registerTool("switch_apptics_dependency", {
    description: `Switch Apptics iOS SDK dependency between Swift Package Manager (SPM) and CocoaPods.

This tool allows you to switch Apptics dependency integration from SPM to CocoaPods or vice versa.
It automatically handles:
- Detecting current dependency state
- Creating backups before modifications
- Adding/removing Apptics pods from Podfile
- Adding/removing Apptics SPM package references
- Running pod install when needed
- Validating the build after switching

Note: SPM is the recommended package manager. Switching from CocoaPods to SPM requires explicit confirmation.`,
    inputSchema: {
      projectPath: z.string().describe("Absolute path to the iOS Xcode project directory"),
      to: z.enum(["spm", "cocoapods"]).describe("Target dependency manager to switch to"),
      targetNames: z.union([z.literal("all"), z.array(z.string()), z.string()]).optional().describe("List of Xcode targets to switch. Pass \"all\" to switch all targets, or provide specific target names as a string or array."),
      language: z.enum(["swift", "objc"]).optional().describe("Project language. Auto-detected if not provided."),
      spmProductName: z.string().optional().describe("SPM package product name (e.g., 'AppticsAnalytics'). Defaults to 'AppticsAnalytics' if not specified."),
      confirmSpmSwitch: z.boolean().optional().describe("Required confirmation when switching from CocoaPods to SPM (SPM is recommended). Must be true to proceed."),
      verbose: z.boolean().optional().default(false).describe("Enable verbose output"),
      skipBuild: z.boolean().optional().default(false).describe("Skip build validation after switching")
    }
  }, async ({
    projectPath,
    to,
    targetNames,
    language,
    spmProductName,
    confirmSpmSwitch,
    verbose,
    skipBuild
  }) => {
    const result = await switchAppticsDependency({
      projectPath,
      to,
      ...(targetNames !== undefined && { targetNames }),
      ...(language !== undefined && { language }),
      ...(spmProductName !== undefined && { spmProductName }),
      ...(confirmSpmSwitch !== undefined && { confirmSpmSwitch }),
      verbose,
      skipBuild
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  });
}
