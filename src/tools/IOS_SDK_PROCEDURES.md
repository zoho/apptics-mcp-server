# iOS SDK: Integration and Dependency Switching

This document describes the procedures for the **integration** and **dependency switching** tools so developers and AI tools can understand and reproduce the steps.

---

## Overview

Two MCP tools handle Apptics on iOS:

1. **`integrate_apptics_ios_sdk`** – Add Apptics to an Xcode project (SPM or CocoaPods).
2. **`switch_apptics_dependency`** – Change Apptics between SPM and CocoaPods without touching other dependencies.

Third-party pods and SPM packages are left unchanged; only Apptics-related entries are added or removed.

---

## 1. Integration tool: `integrate_apptics_ios_sdk`

**When to use:** First-time Apptics setup, or adding optional modules to an already integrated project.

**Procedure (what the tool does):**

1. Repairs any existing Apptics-related project file issues.
2. Verifies the project builds (optional pre-check; skipped if Apptics is not yet present).
3. Checks prerequisites (Xcode, CocoaPods or SPM, iOS deployment target, Swift version).
4. Adds the Apptics dependency:
   - **SPM (default):** Adds the Apptics-SP package and links the chosen product(s).
   - **CocoaPods:** Creates/updates Podfile and runs `pod install`.
5. Adds or updates `apptics-config.plist` (downloaded for the project's bundle ID, or from `alternateBundleId` if provided).
6. Disables user script sandboxing for the Apptics script phase.
7. Installs dependencies (SPM resolve or `pod install`).
8. Creates or updates `AppticsManager.swift` (wrapper with optional-module extensions when requested).
9. Injects `import Apptics` (and optional module imports) and `Apptics.initialize` (or `AppticsManager.shared.configure()`) into the app entry (AppDelegate or SwiftUI `@main` App).
10. Validates project file syntax and runs a build verification (using a temp derived-data path to avoid creating a `build/` folder in the project when possible).

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `projectPath` | Yes | Absolute path to the Xcode project directory. |
| `packageManager` | No | `"spm"` (default) or `"cocoapods"`. |
| `targetNames` | No | `"all"` (default), a single target name, or array of names. Omit to integrate all targets. |
| `optionalModules` | No | Array of module ids: `remoteConfig`, `feedbackKit`, `rateUs`, `crashKit`, `apiTracker`, `inAppUpdate`, `messaging`, `crossPromotion`, `privacyShield`, `notificationServiceExtension`. |
| `notificationServiceExtensionTargetNames` | No | When `notificationServiceExtension` is in `optionalModules`, list NSE target name(s). |
| `alternateBundleId` | No | Bundle ID to fetch config for (if different from project). |
| `createAppticsManagerFile` | No | Default `true`; creates/updates `AppticsManager.swift`. |
| `verbose` | No | Default `true`; extra log output. |

**Target selection:** If the user specifies a target (e.g. "for SubB"), pass that name in `targetNames`. Use `"all"` to integrate every native app target.

**Optional modules:** For "add Rate Us" or "add Remote Config", pass the matching ids in `optionalModules`. When **adding** a module to an already integrated project, pass the **full** list (existing + new), e.g. `["rateUs", "crossPromotion"]`, so Podfile, entry-file imports, and AppticsManager stay in sync.

**Example (SPM, all targets, with Rate Us):**

```json
{
  "projectPath": "/absolute/path/to/YourApp",
  "packageManager": "spm",
  "targetNames": "all",
  "optionalModules": ["rateUs"],
  "verbose": true
}
```

**Notes:**

- Build verification uses a temp derived-data path to avoid creating a `build/` folder in the project; if `build/` still appears, add it to `.gitignore`.
- On failure, a detailed report is written under the project directory (e.g. `apptics-integration-failure-<timestamp>.json`) with steps completed/failed, environment info, and suggestions.

---

## 2. Dependency switcher: `switch_apptics_dependency`

**When to use:** Move Apptics from CocoaPods to SPM or from SPM to CocoaPods. Other pods and SPM packages are not modified.

**Procedure:**

- **CocoaPods → SPM**
  1. Detect Apptics pods in the Podfile (core + optional).
  2. Map those pods to SPM products (core + same optional modules).
  3. Create timestamped backups of `Podfile` and `project.pbxproj`.
  4. Remove only Apptics-related pod lines from the Podfile (other pods stay).
  5. Run `pod install` to update the Pods project (or remove Pods if none left).
  6. Remove CocoaPods script phases and framework references for Apptics from the Xcode project.
  7. Add the Apptics-SP package reference and the chosen SPM products to the project and link them to the targets.
  8. Run `xcodebuild -resolvePackageDependencies`.
  9. Validate build (optional).

- **SPM → CocoaPods**
  1. Detect Apptics SPM products in the project (core + optional).
  2. Map those products to CocoaPods pod names (main + same optional pods).
  3. Create timestamped backups of `Podfile` and `project.pbxproj`.
  4. Add the main Apptics pod and optional pods to the Podfile for the chosen targets (existing non-Apptics pods are preserved).
  5. Run `pod install`.
  6. Remove only the Apptics-SP package reference and its product dependencies from the project (other SPM packages stay).
  7. Validate build (optional).

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `projectPath` | Yes | Absolute path to the Xcode project directory. |
| `to` | Yes | `"spm"` or `"cocoapods"`. |
| `targetNames` | No | `"all"` (default), single name, or array. |
| `confirmSpmSwitch` | When switching to SPM | Must be `true` to proceed (e.g. "yes, switch to SPM"). |
| `language` | No | `"swift"` or `"objc"`; auto-detected if omitted. |
| `spmProductName` | No | SPM product name (default `"AppticsAnalytics"`). |
| `verbose` | No | Extra output. |
| `skipBuild` | No | Skip build validation after the switch. |

**Examples:**

Switch to SPM (with confirmation):

```json
{
  "projectPath": "/path/to/MyApp",
  "to": "spm",
  "confirmSpmSwitch": true,
  "verbose": true
}
```

Switch to CocoaPods:

```json
{
  "projectPath": "/path/to/MyApp",
  "to": "cocoapods",
  "targetNames": "all"
}
```

**Safety:**

- Backups: `Podfile.backup.<timestamp>`, `project.pbxproj.backup.<timestamp>`.
- Rollback: Restore those two files, then run `pod install` if using CocoaPods.
- Only Apptics-related entries are changed; other dependencies are preserved.

**Troubleshooting:**

- **"Apptics is configured with both SPM and CocoaPods"** – Remove one of them manually (delete Apptics package ref or Apptics pod lines and run `pod install`), then run the switch again.
- **"Pod install failed"** – Check CocoaPods (`pod --version`), Podfile syntax, and network; use the backup files to roll back.
- **"Target not found"** – Use exact target names from the project or `targetNames: "all"`.

---

## Summary for developers and AI tools

- **First-time setup:** Use `integrate_apptics_ios_sdk` with `projectPath` (and optionally `packageManager`, `targetNames`, `optionalModules`). The tool performs the full procedure above.
- **Add optional modules later:** Call `integrate_apptics_ios_sdk` again with the **full** list of desired modules in `optionalModules`.
- **Change package manager for Apptics only:** Use `switch_apptics_dependency` with `projectPath` and `to` (`"spm"` or `"cocoapods"`). Use `confirmSpmSwitch: true` when switching to SPM. Optional modules and third-party dependencies are preserved in both directions.
- **Get config for a bundle ID:** Use `fetch_apptics_config_by_bundle_id` with the iOS bundle ID to retrieve `apptics-config.plist` content.
