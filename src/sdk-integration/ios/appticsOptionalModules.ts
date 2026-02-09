/**
 * Optional Apptics iOS modules registry.
 * Single source of truth for dependency names, config lines, and AppticsManager extensions.
 * No regex; all content is fixed string constants.
 *
 * CocoaPods: optional modules = separate pods (AppticsRemoteConfig, AppticsFeedbackKit, etc.).
 * SPM: Apptics-SP exposes per-module products. Integrate core (AppticsAnalytics or
 * AppticsAnalyticscoreWithKSCrash) by default and add optional SPM products when requested.
 *
 * Optional pods not on public CocoaPods trunk are skipped when generating the Podfile. For those
 * skipped modules we do NOT add imports or AppticsManager extensions (they would fail to compile
 * without the pod). Only add imports/config/extensions for modules whose pods are actually installed.
 */

/** Optional module ids whose pods are not added to the Podfile (e.g. not on public CocoaPods trunk). Do not add their imports or AppticsManager extensions. Set to [] to install all optional pods (requires pods to be available, e.g. private specs repo). */
export const SKIP_OPTIONAL_PODS_COCOAPODS: readonly string[] = [];

export interface AppticsOptionalModuleDescriptor {
  id: string;
  displayName: string;
  /** Pod names for CocoaPods. */
  cocoapods: { swift: string; objc: string };
  /** SPM product names (Apptics-SP). Omit for modules that are not separate SPM products (e.g. crashKit uses core variant). */
  spm?: { swift: string; objc: string };
  /** Exact line(s) to add in AppDelegate before Apptics.initialize (Swift). */
  configSwift?: string;
  /** Exact line(s) to add in AppDelegate before Apptics.initialize (Obj-C). */
  configObjc?: string;
  /** Import line for entry file (Swift). */
  importSwift?: string;
  /** Import line for entry file (Obj-C). */
  importObjc?: string;
  /** Import line for AppticsManager.swift when this module is enabled. */
  managerImportSwift?: string;
  /** Extension block for AppticsManager with module-specific helpers (Swift only). */
  managerExtensionSwift?: string;
}

const OPTIONAL_MODULES: AppticsOptionalModuleDescriptor[] = [
  {
    id: 'remoteConfig',
    displayName: 'Remote Configuration',
    cocoapods: { swift: 'AppticsRemoteConfig', objc: 'AppticsRemoteConfig' },
    spm: { swift: 'AppticsRemoteConfig', objc: 'AppticsRemoteConfig' },
    configSwift: 'AppticsConfig.default.enableRemoteConfig = true',
    configObjc: '[AppticsConfig defaultConfig].enableRemoteConfig = YES;',
    importSwift: 'import AppticsRemoteConfig',
    importObjc: '#import <AppticsRemoteConfig/AppticsRemoteConfig.h>',
    managerImportSwift: 'import AppticsRemoteConfig',
    managerExtensionSwift: `
extension AppticsManager {
    /// Fetch and activate remote config from the server. Call after configure().
    public func fetchRemoteConfig(completion: ((Bool) -> Void)? = nil) {
        guard ensureInitialized() else { completion?(false); return }
        let remoteConfig = APRemoteConfig.shared()
        if let completion = completion {
            remoteConfig.fetch { status in
                let ok = status == .success || status == .upToDate
                if ok { remoteConfig.activateFetched() }
                completion(ok)
            }
        } else {
            remoteConfig.fetchAndActivate()
        }
    }

    /// Get a string value from remote config.
    public func remoteConfigString(forKey key: String, coldFetch: Bool = false, fallbackOffline: Bool = false) -> String? {
        guard ensureInitialized() else { return nil }
        return APRemoteConfig.shared().getStringValue(key, coldFetch: coldFetch, fallbackWithOfflineValue: fallbackOffline)
    }
}
`.trim(),
  },
  {
    id: 'feedbackKit',
    displayName: 'In-app Feedback',
    cocoapods: { swift: 'AppticsFeedbackKitSwift', objc: 'AppticsFeedbackKit' },
    spm: { swift: 'AppticsFeedbackKitSwift', objc: 'AppticsFeedbackKit' },
    configSwift: 'AppticsConfig.default.enableFeedbackKit = true',
    configObjc: '[AppticsConfig defaultConfig].enableFeedbackKit = YES;',
    importSwift: 'import AppticsFeedbackKit',
    importObjc: '#import <AppticsFeedbackKit/AppticsFeedbackKit.h>',
    managerImportSwift: 'import AppticsFeedbackKit',
    managerExtensionSwift: `
extension AppticsManager {
    /// Present the in-app feedback screen.
    public func showFeedback() {
        guard ensureInitialized() else { return }
        FeedbackKit.showFeedback()
    }

    /// Present the help me screen.
    public func showHelpMe() {
        guard ensureInitialized() else { return }
        FeedbackKit.showHelpMe()
    }

    /// Enable shake-to-feedback (call after configure if desired).
    public static func enableShakeToFeedback(maxToleranceLimit: Int = 5) {
        FeedbackKit.startMonitoring(withShake: true, maxToleranceLimit: maxToleranceLimit)
    }
}
`.trim(),
  },
  {
    id: 'rateUs',
    displayName: 'Rate Us',
    cocoapods: { swift: 'AppticsRateUs', objc: 'AppticsRateUs' },
    spm: { swift: 'AppticsRateUs', objc: 'AppticsRateUs' },
    configSwift: 'AppticsConfig.default.enableRateUs = true',
    configObjc: '[AppticsConfig defaultConfig].enableRateUs = YES;',
    importSwift: 'import AppticsRateUs',
    importObjc: '#import <AppticsRateUs/AppticsRateUs.h>',
    managerImportSwift: 'import AppticsRateUs',
    managerExtensionSwift: `
extension AppticsManager {
    // Rate Us is controlled from the Apptics console (AppticsConfig.default.enableRateUs).
}
`.trim(),
  },
  {
    id: 'crashKit',
    displayName: 'Crash Reporting',
    /** Crash is included in Apptics-Swift/Apptics-SDK (AnalyticsWithMXCrash); no separate pod on CocoaPods. */
    cocoapods: { swift: '', objc: '' },
    configSwift: 'AppticsConfig.default.enableAutomaticCrashTracking = true',
    configObjc: '[AppticsConfig defaultConfig].enableAutomaticCrashTracking = YES;',
    managerExtensionSwift: `
extension AppticsManager {
    /// Set custom properties attached to crash reports.
    public func setCrashCustomProperty(_ info: [String: Any]) {
        guard ensureInitialized() else { return }
        Apptics.setCrashCustomProperty(info)
    }
}
`.trim(),
  },
  {
    id: 'apiTracker',
    displayName: 'API Tracker',
    cocoapods: { swift: 'AppticsApiTracker', objc: 'AppticsApiTracker' },
    spm: { swift: 'AppticsApiTracker', objc: 'AppticsApiTracker' },
    importSwift: 'import AppticsApiTracker',
    importObjc: '#import <AppticsApiTracker/AppticsApiTracker.h>',
    managerImportSwift: 'import AppticsApiTracker',
    managerExtensionSwift: `
extension AppticsManager {
    /// Enable API tracking for a URLSessionConfiguration. Use with URLSession(configuration: configuration).
    public static func enableApiTracking(for sessionConfiguration: URLSessionConfiguration) {
        APAPIManager.enable(for: sessionConfiguration)
    }
}
`.trim(),
  },
  {
    id: 'inAppUpdate',
    displayName: 'In-App Update',
    cocoapods: { swift: 'AppticsInAppUpdate', objc: 'AppticsInAppUpdate' },
    spm: { swift: 'AppticsInAppUpdate', objc: 'AppticsInAppUpdate' },
    /** AppticsConfig may not expose enableInAppUpdate; enable via plist or SDK defaults to avoid build errors. */
    importSwift: 'import AppticsInAppUpdate',
    importObjc: '#import <AppticsInAppUpdate/AppticsInAppUpdate.h>',
    managerImportSwift: 'import AppticsInAppUpdate',
    managerExtensionSwift: `
extension AppticsManager {
    /// Show the in-built version alert if an update is available (configure in Apptics console).
    public static func checkAndShowVersionAlert() {
        APAppUpdateManager.checkAndShowVersionAlert(nil)
    }

    /// Check for app updates (call from your update flow if needed).
    public static func checkForAppUpdates() {
        APAppUpdateManager.checkAndShowVersionAlert(nil)
    }
}
`.trim(),
  },
  {
    id: 'messaging',
    displayName: 'Push Messaging',
    cocoapods: { swift: 'AppticsMessaging', objc: 'AppticsMessaging' },
    spm: { swift: 'AppticsMessaging', objc: 'AppticsMessaging' },
    /** AppticsConfig may not expose enableMessaging; enable via plist or SDK defaults to avoid build errors. */
    importSwift: 'import AppticsMessaging',
    importObjc: '#import <AppticsMessaging/AppticsMessaging.h>',
    managerImportSwift: 'import AppticsMessaging',
    managerExtensionSwift: `
extension AppticsManager {
    /// Start push messaging service. Call from application(_:didFinishLaunchingWithOptions:) after configure().
    public static func startMessagingService() {
        APMessaging.startService()
    }

    public enum AnalyticsEvents {
        public static let appLaunched = AppticsEventDescriptor(
            name: "appLaunched",
            group: .lifecycle
        )
        public static let onboardingCompleted = AppticsEventDescriptor(
            name: "onboardingCompleted",
            group: .engagement
        )

        public static func trackAppLaunch(source: String) {
            AppticsManager.shared.track(
                appLaunched,
                properties: ["source": source]
            )
        }

        public static func trackOnboardingCompleted(stepCount: Int) {
            AppticsManager.shared.track(
                onboardingCompleted,
                properties: ["steps": stepCount]
            )
        }
    }
}
`.trim(),
  },
  {
    id: 'crossPromotion',
    displayName: 'Cross Promotion',
    cocoapods: { swift: 'AppticsCrossPromotion', objc: 'AppticsCrossPromotion' },
    spm: { swift: 'AppticsCrossPromotion', objc: 'AppticsCrossPromotion' },
  },
  {
    id: 'privacyShield',
    displayName: 'Privacy Shield',
    cocoapods: { swift: 'AppticsPrivacyShield', objc: 'AppticsPrivacyShield' },
    spm: { swift: 'AppticsPrivacyShield', objc: 'AppticsPrivacyShield' },
  },
  {
    id: 'extension',
    displayName: 'App Extension (Intents, Widgets, Share)',
    /** Lightweight Apptics SDK for app extensions - Intents, Widgets, Share extensions. */
    cocoapods: { swift: 'AppticsExtension', objc: 'AppticsExtension' },
    spm: { swift: 'AppticsExtension', objc: 'AppticsExtension' },
  },
  {
    id: 'notificationServiceExtension',
    displayName: 'Notification Service Extension',
    /** NSE pod is for the Notification Service Extension target only, not the main app. */
    cocoapods: { swift: 'AppticsNotificationServiceExtension', objc: 'AppticsNotificationServiceExtension' },
    spm: { swift: 'AppticsNotificationServiceExtension', objc: 'AppticsNotificationServiceExtension' },
    /** Config/imports for NSE go in the extension target's NotificationService class, not AppDelegate. */
    managerExtensionSwift: `
extension AppticsManager {
    // Notification Service Extension: add AppticsNotificationServiceExtension to your NSE target's Podfile and use the SDK in NotificationService.swift to modify notification content.
}
`.trim(),
  },
];

const MODULE_MAP = new Map<string, AppticsOptionalModuleDescriptor>(
  OPTIONAL_MODULES.map((m) => [m.id, m])
);

export const OPTIONAL_MODULE_IDS: readonly string[] = OPTIONAL_MODULES.map((m) => m.id);

export function getOptionalModule(id: string): AppticsOptionalModuleDescriptor | undefined {
  return MODULE_MAP.get(id);
}

export function getOptionalModules(ids: string[]): AppticsOptionalModuleDescriptor[] {
  const out: AppticsOptionalModuleDescriptor[] = [];
  for (const id of ids) {
    const m = MODULE_MAP.get(id);
    if (m) out.push(m);
  }
  return out;
}

export function validateOptionalModuleIds(ids: string[]): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  const set = new Set(OPTIONAL_MODULE_IDS);
  for (const id of ids) {
    if (set.has(id)) valid.push(id);
    else invalid.push(id);
  }
  return { valid, invalid };
}

/** For CocoaPods: return only module ids whose pods are actually added (exclude SKIP_OPTIONAL_PODS_COCOAPODS). Use this for entry imports, config lines, and AppticsManager content so we don't reference uninstalled pods. */
export function getInstalledOptionalModuleIdsForCocoaPods(optionalModuleIds: string[]): string[] {
  const skipSet = new Set(SKIP_OPTIONAL_PODS_COCOAPODS);
  return optionalModuleIds.filter((id) => !skipSet.has(id));
}

/** Placeholder in AppticsManager template for optional import lines. */
export const APPTICS_MANAGER_PLACEHOLDER_IMPORTS = '{{APPTICS_OPTIONAL_IMPORTS}}';

/** Placeholder in AppticsManager template for optional extension blocks. */
export const APPTICS_MANAGER_PLACEHOLDER_EXTENSIONS = '{{APPTICS_OPTIONAL_EXTENSIONS}}';

/**
 * Build optional import lines for AppticsManager.swift (one per module).
 */
export function buildManagerOptionalImports(moduleIds: string[]): string {
  const modules = getOptionalModules(moduleIds);
  const lines = modules
    .map((m) => m.managerImportSwift)
    .filter((line): line is string => Boolean(line));
  return lines.length ? lines.join('\n') : '';
}

/**
 * Build optional extension blocks for AppticsManager.swift (concatenated).
 */
export function buildManagerOptionalExtensions(moduleIds: string[]): string {
  const modules = getOptionalModules(moduleIds);
  const blocks = modules
    .map((m) => m.managerExtensionSwift)
    .filter((block): block is string => Boolean(block));
  return blocks.length ? blocks.join('\n\n') : '';
}

/** Core SPM product: AppticsAnalytics (no crash) or AppticsAnalyticscoreWithKSCrash when crashKit is requested. */
export function getSPMCoreProductName(optionalModuleIds: string[]): string {
  return optionalModuleIds?.includes('crashKit') ? 'AppticsAnalyticscoreWithKSCrash' : 'AppticsAnalytics';
}

/** SPM product names for main app targets: core + optional products (excluding crashKit and notificationServiceExtension). */
export function getSPMProductNamesForMainTargets(
  optionalModuleIds: string[],
  language: 'swift' | 'objc',
  coreProductOverride?: string
): string[] {
  const core = coreProductOverride ?? getSPMCoreProductName(optionalModuleIds ?? []);
  const mainModuleIds = (optionalModuleIds ?? []).filter(
    (id) => id !== 'crashKit' && id !== 'notificationServiceExtension'
  );
  const optionalProducts = getOptionalModules(mainModuleIds)
    .map((m) => (m.spm ? (language === 'swift' ? m.spm.swift : m.spm.objc) : ''))
    .filter((name): name is string => Boolean(name?.trim()));
  return [core, ...optionalProducts];
}

/** SPM product names for a single target. NSE targets get only AppticsNotificationServiceExtension when that module is requested. */
export function getSPMProductNamesForTarget(
  optionalModuleIds: string[],
  language: 'swift' | 'objc',
  targetName: string,
  notificationServiceExtensionTargetNames: string[] = [],
  coreProductOverride?: string
): string[] {
  const nseSet = new Set(notificationServiceExtensionTargetNames ?? []);
  if (nseSet.has(targetName)) {
    return optionalModuleIds?.includes('notificationServiceExtension') ? ['AppticsNotificationServiceExtension'] : [];
  }
  return getSPMProductNamesForMainTargets(optionalModuleIds ?? [], language, coreProductOverride);
}

const CORE_SPM_PRODUCT = 'AppticsAnalytics';
const CORE_SPM_PRODUCT_WITH_CRASH = 'AppticsAnalyticscoreWithKSCrash';
const CORE_SPM_PRODUCTS = new Set([CORE_SPM_PRODUCT, CORE_SPM_PRODUCT_WITH_CRASH]);

const EXTENSION_ONLY_PODS = new Set(['appticsextension', 'appticsnotificationserviceextension']);

/**
 * Map CocoaPods pod names (from Podfile) to SPM product names for switching CocoaPods → SPM.
 * Returns [core product, ...optional products] so the same modules are available after the switch.
 * For extension-only targets (only AppticsExtension or AppticsNotificationServiceExtension),
 * returns just that product - no core SDK.
 */
export function getSPMProductNamesFromCocoaPodsPodNames(
  podNames: string[],
  language: 'swift' | 'objc'
): string[] {
  const podSet = new Set(podNames.map((p) => p.trim().toLowerCase()));
  const isExtensionOnly =
    podSet.size > 0 &&
    [...podSet].every((p) => EXTENSION_ONLY_PODS.has(p));
  if (isExtensionOnly) {
    const products: string[] = [];
    for (const m of OPTIONAL_MODULES) {
      const podName = (language === 'swift' ? m.cocoapods.swift : m.cocoapods.objc)?.trim();
      if (!podName || !m.spm) continue; // Only add modules whose pod was explicitly in Podfile
      if (podSet.has(podName.toLowerCase())) {
        const spmName = language === 'swift' ? m.spm.swift : m.spm.objc;
        if (spmName && !products.includes(spmName)) products.push(spmName);
      }
    }
    return products;
  }
  const products: string[] = [CORE_SPM_PRODUCT];
  for (const m of OPTIONAL_MODULES) {
    const podName = (language === 'swift' ? m.cocoapods.swift : m.cocoapods.objc)?.trim();
    if (!podName || !m.spm) continue; // Only add modules whose pod was explicitly in Podfile
    if (podSet.has(podName.toLowerCase())) {
      const spmName = language === 'swift' ? m.spm.swift : m.spm.objc;
      if (spmName && !products.includes(spmName)) products.push(spmName);
    }
  }
  return products;
}

/** Main CocoaPods SDK pod names (no optional modules). */
const MAIN_PODS_SWIFT = 'Apptics-Swift';
const MAIN_PODS_OBJC = 'Apptics-SDK';

/**
 * Map SPM product names (from project) to CocoaPods pod names for switching SPM → CocoaPods.
 * Returns [main pod, ...optional pods] so the same modules are available after the switch.
 */
export function getCocoaPodsPodNamesFromSPMProductNames(
  productNames: string[],
  language: 'swift' | 'objc'
): string[] {
  const productSet = new Set(productNames.map((p) => p.trim()));
  const mainPod = language === 'swift' ? MAIN_PODS_SWIFT : MAIN_PODS_OBJC;
  const pods: string[] = [];

  const hasCore = productSet.has(CORE_SPM_PRODUCT) || productSet.has(CORE_SPM_PRODUCT_WITH_CRASH);
  if (hasCore || productSet.size === 0) {
    pods.push(mainPod);
  }

  for (const m of OPTIONAL_MODULES) {
    const spmName = language === 'swift' ? m.spm?.swift : m.spm?.objc;
    if (spmName && productSet.has(spmName)) {
      const podName = language === 'swift' ? m.cocoapods.swift : m.cocoapods.objc;
      if (podName && !pods.includes(podName)) pods.push(podName);
    }
  }
  return pods;
}
