#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import type { Dirent } from "fs";
import { getAppticsClient } from "./appticsConfig";
import { completeIOSIntegration, verifyAppticsIntegration } from "./sdk-integration/ios";
import { switchAppticsDependency } from "./dependency-switcher/ios/switcher";

const server = new McpServer({
  name: "zoho-apptics",
  version: "1.0.0"
});

type IOSLanguage = "swift" | "objc";
type AppEntryPointType = "appDelegate" | "swiftUI";
type TargetSelection = string[] | "all" | string;

server.registerTool("get_portals_and_projects_list", {
  description : `List all portals and their projects. 
  Each portal has a name and zsoid (use as portalId). Each project has a name and projectId. 
  Use this to discover valid portalId/projectId before project-scoped queries.`
}, async() => {
  const appticsClient = getAppticsClient();
  const result = await appticsClient.getPortalsAndProjects();
  return {
    content: [{type: 'text' as const, text: JSON.stringify(result)}]
  };
});

server.registerTool("get_crash_list", {
  description: ` Retrieves crash analytics data for your application with flexible filtering and pagination options.  
This tool enables querying crash records across app versions, platforms, and environments within a specified date range.

Use it to analyze crash trends, identify frequent crash types, or segment issues by platform and version.  
By default, the API returns up to 500 production crashes across all platforms and app versions.

The response includes crash identifiers, app version, OS, exception type, crash counts, affected users and devices, and a representative exception message.
  `,
  inputSchema: {
    portalId: z.string().describe("Portal identifier (zsoid) of the portal to which the project belongs."),
    projectId: z.string().describe("Project identifier within the specified portal."),
    startDate: z.string().optional().describe(
        `Inclusive start date for the query in dd-MM-YYYY format. Default: 7 days before today (excluding today).`
      ),
    endDate: z.string().optional().describe(
        `Inclusive end date for the query in dd-MM-YYYY format. Default: yesterday (today is excluded).`
      ),
    appVersion: z.string().optional().describe(
      `Optional comma-separated list of app versions to filter by.
Example: "3.0,3.1,4.0".
Defaults to all versions when omitted.`
      ),
    platform: z.string().optional().describe(
      `Optional comma-separated list of platforms to filter by.
Examples: "iOS,Android", "Windows,tvOS,watchOS,macOS".
Defaults to all supported platforms when omitted.`
      ),
      mode: z.string().optional().describe(
        `Environment filter. 0 for development, 1 for production. Default - 1 (production)`
      ),
      offset: z.string().optional().describe(
        `Starting position for result pagination (default - 0). Increment by limit value for next page (e.g., 501, 1001).`
      ),
      limit: z.string().optional().describe(
        `Number of results per page. Default and maximum: 500. Use smaller values to limit response size.`
      )
  },
  outputSchema: {
    data: z.array(
      z.object({
        AppVersion: z.string(),
        Status: z.number().int(),
        UniqueMessageID: z.string(),
        AppVersionID: z.number().int(),
        PID: z.number().int(),
        ExceptionType: z.string(),
        OS: z.string(),
        CrashCount: z.string(),
        UsersCount: z.string(),
        DevicesCount: z.string(),
        Exception: z.string()
      })
    )
  }
}, async({ portalId, projectId, startDate, endDate, appVersion, platform, mode, offset, limit}) => {
  const appticsClient = getAppticsClient();
  const result = await appticsClient.getCrashList(projectId, portalId, startDate, endDate, appVersion, platform, mode, offset, limit)
  const data = {
    data: (result as { data: [unknown]}).data
  };
  return {
    content: [{type: 'text', text: JSON.stringify(result)}],
    structuredContent: data
  }
});

server.registerTool("get_active_devices", {
   description: `
  Fetch active devices for a specific project. 
  Required: portalId (zsoid) and projectId. Optional: group by "platform", "devicetype", or "appversion"; specify startDate and endDate to filter by date range. 
  Defaults: group="platform"; date range = last 7 days (excluding today).
`,
  inputSchema: {
    portalId: z.string().describe("Portal identifier (zsoid) of the portal to which the project belongs."),
    projectId: z.string().describe("Project identifier within the specified portal."),
    group: z.enum(["platform","devicetype", "appversion"]).optional().describe(`Optional grouping criteria for active devices. Defaults to "platform"`),
    startDate: z.string().optional().describe(
        `Inclusive start date for the query in dd-MM-YYYY format. Default: 7 days before today (excluding today).`
      ),
    endDate: z.string().optional().describe(
        `Inclusive end date for the query in dd-MM-YYYY format. Default: yesterday (today is excluded).`
      ),
  }
}, async({ portalId, projectId, group, startDate, endDate }) => { 
  const appticsClient = getAppticsClient();
  const result = await appticsClient.getActiveDevices(projectId, portalId, startDate, endDate, group);
  return {
    content: [{type: 'text', text: JSON.stringify(result)}]
  };
});

server.registerTool("get_crash_count_by_date", {
  description: `
  Fetch aggregated crash statistics over a specified date range.

The API returns **time-series data** keyed by date (epoch timestamp), platform wise. Time-series data will be keyed by hour of the day, if the data is fetched for single day (same start and end dates)
For each day or each hour, the following metrics are provided:
- **crashcount** - Total number of crashes recorded on that day.
- **issuecount** - Number of **unique issues** (distinct crash signatures) that caused crashes.
- **devicecount** - Number of **unique devices** affected by those crashes.
- **usercount** - Number of **unique users** affected by those crashes.

By default, these data will be provided for all platforms and aggregated for all app versions in the platform.
You can optionally pass one or more platforms and/or app versions as comma-separated lists
to narrow down the results (e.g., \`"iOS,Android"\` or \`"3.0,3.1,4.0"\`).

Supported platforms are iOS, Android, Windows, tvOS, watchOS, macOS. The platforms are case sensitive.

Ideal for **trend analysis** and **crash monitoring dashboards**.`,
  inputSchema: {
    portalId: z.string().describe("Portal identifier (zsoid) of the portal to which the project belongs."),
    projectId: z.string().describe("Project identifier within the specified portal."),
    startDate: z.string().optional().describe(
        `Inclusive start date for the query in dd-MM-YYYY format. Default: 7 days before today (excluding today).`
      ),
    endDate: z.string().optional().describe(
        `Inclusive end date for the query in dd-MM-YYYY format. Default: yesterday (today is excluded).`
      ),
    appVersion: z.string().optional().describe(
      `Optional comma-separated list of app versions to filter by.
Example: "3.0,3.1,4.0".
Defaults to all versions when omitted.`
      ),
    platform: z.string().optional().describe(
      `Optional comma-separated list of platforms to filter by.
Examples: "iOS,Android", "Windows,tvOS,watchOS,macOS".
Defaults to all supported platforms when omitted.`
      )
    },
  }, async({portalId, projectId, startDate, endDate, appVersion, platform}) => {
    const appticsClient = getAppticsClient();
    const data = await appticsClient.getCrashCountByDate(projectId, portalId, startDate, endDate, appVersion, platform)
    return {
      content: [{type: 'text', text: JSON.stringify(data)}]
    }
  });

  server.registerTool("get_crash_detail", {
  description: `
  Retrieves comprehensive details about a specific crash event using its unique identifier (uniqueid).
This tool helps developers and support engineers debug and analyze the root cause of a crash by fetching complete metadata, including:

Exception details (type, message, and stack trace)
Affected screen or activity
Device and OS specifications
Network status and session context
App version, user information, and custom properties

By default, it searches across all app versions, but it can be filtered using an appversion parameter.`,
  inputSchema: {
    portalId: z.string().describe("Portal identifier (zsoid) of the portal to which the project belongs."),
    projectId: z.string().describe("Project identifier within the specified portal."),
    uniqueId: z.string().describe("Unique crash identifier. This can be obtained from the crash list API"),
    startDate: z.string().optional().describe(
        `Inclusive start date for the query in dd-MM-YYYY format. Default: 7 days before today (excluding today).`
      ),
    endDate: z.string().optional().describe(
        `Inclusive end date for the query in dd-MM-YYYY format. Default: yesterday (today is excluded).`
      ),
    appVersion: z.string().optional().describe(
      `Optional comma-separated list of app versions to filter by.
Example: "3.0,3.1,4.0".
Defaults to all versions when omitted.`
      )
    },
  }, async({portalId, projectId, uniqueId, startDate, endDate, appVersion}) => {
    const appticsClient = getAppticsClient();
    const data = await appticsClient.getCrashDetail(projectId, portalId, uniqueId, startDate, endDate, appVersion)
    return {
      content: [{type: 'text', text: JSON.stringify(data)}]
    }
  });

  server.registerTool("get_device_specific_crash_distribution", {
  description: `
  Retrieves crash distribution data grouped by device model for a specific crash.
This endpoint helps identify device-specific crash trends, allowing developers to detect hardware compatibility problems, performance issues, or device-specific bugs.

It requires a unique crash identifier (uniqueid) obtained from the crash list API, and can optionally be filtered by app version.
The response provides a breakdown showing which device models are most affected by the crash and their respective crash counts.

By default, the API analyzes all app versions, with support for pagination (limit and offset) for large datasets.
  `,
  inputSchema: {
    portalId: z.string().describe("Portal identifier (zsoid) of the portal to which the project belongs."),
    projectId: z.string().describe("Project identifier within the specified portal."),
    uniqueId: z.string().describe("Unique crash identifier. This can be obtained from the crash list API"),
    startDate: z.string().optional().describe(
        `Inclusive start date for the query in dd-MM-YYYY format. Default: 7 days before today (excluding today).`
      ),
    endDate: z.string().optional().describe(
        `Inclusive end date for the query in dd-MM-YYYY format. Default: yesterday (today is excluded).`
      ),
    appVersion: z.string().optional().describe(
      `Optional comma-separated list of app versions to filter by.
Example: "3.0,3.1,4.0".
Defaults to all versions when omitted.`
      ),
      offset: z.string().optional().describe(
        `Starting position for result pagination (default - 0). Increment by limit value for next page (e.g., 501, 1001).`
      ),
      limit: z.string().optional().describe(
        `Number of results per page. Default and maximum: 500. Use smaller values to limit response size.`
      )
    },
  }, async({portalId, projectId, uniqueId, startDate, endDate, appVersion, limit, offset}) => {
    const appticsClient = getAppticsClient();
    const data = await appticsClient.getDeviceSpecificCrashDistribution(projectId, portalId, uniqueId, startDate, endDate, appVersion, limit, offset)
    return {
      content: [{type: 'text', text: JSON.stringify(data)}]
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

This is a complete, automated integration tool that modifies Xcode project files directly.`,
    inputSchema: {
      projectPath: z.string().describe("Absolute path to the iOS Xcode project directory"),
    packageManager: z.enum(["cocoapods", "spm"]).optional().default("spm").describe("Package manager to use for SDK integration. 'cocoapods' for CocoaPods or 'spm' for Swift Package Manager. Defaults to 'spm' if not specified."),
    spmProductName: z.string().optional().describe("SPM package product name (e.g., 'AppticsAnalytics'). If not specified, defaults to 'AppticsAnalytics' for both Swift and Objective-C projects. Note: 'Apptics' is a binary target but not a product; 'AppticsAnalytics' is the main product that includes Apptics and all core functionality."),
    targetName: z.string().optional().describe("Xcode target name. Defaults to the .xcodeproj name. DEPRECATED: Prefer using targetNames parameter instead."),
    targetNames: z.union([z.literal("all"), z.array(z.string()), z.string()]).optional().describe("List of Xcode targets to integrate. Pass \"all\" to integrate every discovered target. When user mentions a specific target name (e.g., 'in the SubB target', 'for SubB'), extract the target name and pass it here as a string. For multiple targets, pass an array of strings. Examples: 'SubB' for single target, ['SubB', 'MainApp'] for multiple, 'all' for all targets."),
    language: z.enum(["swift", "objc"]).optional().describe("Project language. Defaults to Swift when detectable."),
    configFileSource: z.string().optional().describe("Path to the apptics-config.plist file. Defaults to <projectPath>/apptics-config.plist."),
    appDelegatePath: z.string().optional().describe("Absolute or project-relative path to AppDelegate file (e.g., AppDelegate.swift). Only needed if auto-detection fails."),
    swiftUIAppPath: z.string().optional().describe("Absolute or project-relative path to the SwiftUI App entry file (e.g., MyApp.swift). Only needed if auto-detection fails."),
    appEntryPoint: z.enum(["appDelegate","swiftUI"]).optional().describe("Where to insert the Apptics initialization. Defaults to 'swiftUI' when a SwiftUI @main App is detected; otherwise 'appDelegate'."),
      verbose: z.boolean().optional().default(true).describe("Enable verbose mode for SDK initialization"),
    createAppticsManagerFile: z.boolean().optional().default(true).describe("Set to true to generate an AppticsManager.swift convenience wrapper inside the project."),
    appticsManagerFilePath: z.string().optional().describe("Optional absolute or project-relative path where AppticsManager.swift should be written. Defaults to <projectPath>/AppticsManager.swift."),
    overwriteAppticsManagerFile: z.boolean().optional().describe("Overwrite AppticsManager.swift if it already exists."),
    useAppticsManagerWrapper: z.boolean().optional().describe("Use AppticsManager shared wrapper for initialization/tracking. Defaults to true when createAppticsManagerFile is true."),
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
  appDelegatePath,
  swiftUIAppPath,
  appEntryPoint,
  verbose,
  config,
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
      appDelegatePath,
    swiftUIAppPath,
    appEntryPoint
  });

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

    return {
      content: [{
        type: 'text', 
        text: JSON.stringify({
          ...result,
          verificationChecks
        }, null, 2)
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


type IntegrationHints = {
  projectPath: string;
  targetName?: string | undefined;
  targetNames?: TargetSelection | undefined;
  language?: IOSLanguage | undefined;
  configFileSource?: string | undefined;
  appDelegatePath?: string | undefined;
  swiftUIAppPath?: string | undefined;
  appEntryPoint?: AppEntryPointType | undefined;
};

type ResolvedIntegrationInputs = {
  projectPath: string;
  targetNames: string[];
  targetName: string;
  language: IOSLanguage;
  configFileSource: string;
  entryPoint: AppEntryPointType;
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
  const configFileSource = await resolveConfigFileSource(resolvedProjectPath, hints.configFileSource);

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
    hints.targetName ?? (await inferTargetName(resolvedProjectPath)),
    hints.targetNames
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
    const content = await fs.readFile(pbxprojPath, 'utf-8');
    
    // Find XCBuildConfiguration sections
    // Pattern: ID /* ConfigName */ = { isa = XCBuildConfiguration; buildSettings = { ... PRODUCT_BUNDLE_IDENTIFIER = "bundle.id"; ... }; };
    const buildConfigPattern = /isa\s*=\s*XCBuildConfiguration\s*;[\s\S]*?buildSettings\s*=\s*\{([\s\S]*?)\};/g;
    let match: RegExpExecArray | null;
    
    while ((match = buildConfigPattern.exec(content)) !== null) {
      if (match[1]) {
        // Look for PRODUCT_BUNDLE_IDENTIFIER within this buildSettings block
        const bundleIdPattern = /PRODUCT_BUNDLE_IDENTIFIER\s*=\s*"([^"]+)";/;
        const bundleIdMatch = match[1].match(bundleIdPattern);
        if (bundleIdMatch && bundleIdMatch[1]) {
          return bundleIdMatch[1];
        }
      }
    }
    
    // Fallback: search for PRODUCT_BUNDLE_IDENTIFIER anywhere in the file
    const directPattern = /PRODUCT_BUNDLE_IDENTIFIER\s*=\s*"([^"]+)";/;
    const directMatch = content.match(directPattern);
    if (directMatch && directMatch[1]) {
      return directMatch[1];
    }
    
    return null;
  } catch (error) {
    // If we can't extract bundle ID, return null and use default
    return null;
  }
}

async function createDefaultAppticsConfig(configPath: string, bundleId?: string | null): Promise<void> {
  // Use provided bundle ID or fallback to dummy value
  const finalBundleId = bundleId || 'com.jambav.AppticsPlayground';
  
  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>API_KEY</key>
	<string>177905A90B3685D62B75F4E04405C63F7BEF0E878187AF6B448BB9FCA14DBAB7</string>
	<key>BUNDLE_ID</key>
	<string>${finalBundleId}</string>
	<key>SERVER_URL</key>
	<string>https://sdk-apptics.zoho.com</string>
</dict>
</plist>`;
  
  await fs.writeFile(configPath, plistContent, 'utf-8');
}

async function resolveConfigFileSource(projectPath: string, provided?: string): Promise<string> {
  if (provided) {
    const candidate = resolveMaybeRelativePath(projectPath, provided);
    if (!candidate) {
      throw new Error("configFileSource is invalid.");
    }
    await ensurePathExists(candidate, "Apptics config file");
    return candidate;
  }

  const defaultPath = path.join(projectPath, "apptics-config.plist");
  // If config file doesn't exist, create it with dummy values
  if (!(await pathExists(defaultPath))) {
    // Try to extract bundle ID from the project
    const bundleId = await extractBundleIdFromProject(projectPath);
    await createDefaultAppticsConfig(defaultPath, bundleId);
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
  const content = await fs.readFile(pbxprojPath, "utf-8");
  const targetRegex = /\/\* ([^*]+?) \*\/ = \{\s*isa = PBXNativeTarget;/g;
  const targets = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = targetRegex.exec(content)) !== null) {
    if (match[1]) {
      targets.add(match[1].trim());
    }
  }
  return Array.from(targets);
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
  preferredEntryPoint?: AppEntryPointType | undefined;
  swiftUIPath?: string | undefined;
  appDelegateMatch?: AppDelegateMatch | undefined;
  language: IOSLanguage;
}): {
  entryPoint: AppEntryPointType;
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
    return /@main\s+struct\s+\w+\s*:\s*App/.test(content);
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
    // Verify it's actually a SwiftUI App file
    try {
      const content = await fs.readFile(allSwiftFiles, 'utf-8');
      if (/struct\s+\w+\s*:\s*App/.test(content) || /@main/.test(content)) {
        return allSwiftFiles;
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


const transport = new StdioServerTransport();
(async () => {
  await server.connect(transport);
})();
