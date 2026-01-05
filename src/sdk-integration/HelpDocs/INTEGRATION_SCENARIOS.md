# **Apptics iOS SDK Integration Scenarios**

This document tracks all integration scenarios for the Apptics iOS SDK integration tool. Scenarios are organized by status: ✅ Completed and 📋 To-Do.

---

## **✅ Completed Scenarios**

### ✅ **Package Manager Integration**

- **CocoaPods Integration**
  - Swift projects: `Apptics-Swift` pod
  - Objective-C projects: `Apptics-SDK` pod
  - Podfile creation/update with existing target merging
  - Pre-build script phase integration
  - `pod install` execution

- **Swift Package Manager (SPM) Integration**
  - Default package manager (SPM)
  - Repository: `https://github.com/zoho/Apptics-SP`
  - Default product: `AppticsAnalytics`
  - Custom product name support via `spmProductName`
  - Note: `Apptics` is a binary target, not a product
  - Package reference management
  - Product dependency linking
  - Automatic package resolution with fallback strategies

### ✅ **Language Support**

- **Swift Projects**
  - AppDelegate entry point
  - SwiftUI App entry point
  - AppticsManager wrapper support
  - Direct SDK initialization

- **Objective-C Projects**
  - AppDelegate entry point
  - Direct SDK initialization
  - No manager wrapper (Swift-only feature)

### ✅ **Entry Point Support**

- **AppDelegate Integration**
  - Swift: `application(_:didFinishLaunchingWithOptions:)`
  - Objective-C: `application:didFinishLaunchingWithOptions:`
  - Method detection and injection
  - Existing initialization detection

- **SwiftUI App Integration**
  - `@main struct App` detection
  - `init()` method injection
  - Existing init detection
  - Body placement logic

### ✅ **Entry Point Support**

- **Single Target**
  - Auto-detection from `.xcodeproj` name
  - Explicit target name specification
  - Case-insensitive matching

- **Multiple Targets**
  - Array of target names
  - Per-target entry file resolution
  - Per-target integration

- **All Targets**
  - `targetNames: "all"` option
  - Automatic discovery of all PBXNativeTarget entries
  - Batch integration

### ✅ **Manager Wrapper**

- **AppticsManager Creation**
  - Default creation (`createManagerFile: true`)
  - Custom file path support
  - Overwrite option
  - Template customization: Replaces `import Apptics` with custom `spmProductName` in template
  - Event tracking helpers: Includes `AnalyticsEvents` enum with pre-defined events

- **Manager Wrapper Usage**
  - `AppticsManager.shared.configure()` initialization
  - Event tracking via manager
  - Initialization guard: Prevents double initialization with `isInitialized` flag
  - DEBUG warnings: Prints warnings in debug builds if tracking before initialization

- **Direct SDK Usage**
  - `Apptics.initialize()` for Swift
  - `[Apptics initializeWithVerbose:]` for Objective-C
  - No wrapper dependency

### ✅ **Configuration Options**

- **Basic Initialization**
  - Minimal setup with defaults
  - Verbose mode toggle

- **Advanced Configuration**
  - `sendDataOnMobileNetworkByDefault` (default: true)
  - `trackOnByDefault` (default: true)
  - `anonymousType`: `pseudoAnonymous` | `nonAnonymous` (default: `pseudoAnonymous`)

### ✅ **Build Script Configuration**

- **Upload Symbols Configurations**
  - Default: `"Release, Appstore"`
  - Custom comma-separated configurations
  - CocoaPods script integration
  - SPM script integration

- **App Group Identifier**
  - Required for app extensions (widgets, watch extensions, etc.)
  - Optional parameter for app extensions
  - Script command integration
  - Shared configuration: Uses appGroupIdentifier for shared data between app and extensions
  - Extension targets: Can integrate into extension targets using targetNames

- **Upload Frameworks**
  - Optional third-party framework dSYM upload
  - Comma-separated list support

- **Config File Path**
  - Default: `apptics-config.plist` in project root
  - Custom path support

### ✅ **Project Structure Support**

- **Traditional Xcode Projects**
  - Standard `.pbxproj` structure
  - PBXBuildFile entries
  - Standard file linking

- **File System Synchronized Projects (Xcode 15+)**
  - `objectVersion 77` detection
  - `PBXFileSystemSynchronizedRootGroup` support
  - Special file placement logic
  - Different file placement logic for filesystem-synced projects
  - Shared manager file placement for filesystem-synced projects

- **Workspace Projects**
  - Handles `.xcworkspace` scenarios (CocoaPods creates workspaces)
  - Direct project builds: Falls back to direct target builds when schemes don't exist

### ✅ **File Placement**

- **Manager File Location**
  - Default: `<projectPath>/AppticsManager/AppticsManager.swift`
  - Custom: `appticsManagerFilePath` parameter
  - Overwrite: `overwriteAppticsManagerFile: true/false`

### ✅ **Auto-Detection**

- **Target Detection**
  - Auto-discovery from `.pbxproj`
  - Case-insensitive matching (matches targets case-insensitively if exact match fails)
  - Target existence validation
  - Target name variations: Handles targets with spaces, special characters

- **Language Detection**
  - Swift: `.swift` files, SwiftUI `@main` struct
  - Objective-C: `.m`/`.mm` files
  - Fallback to Swift if ambiguous

- **Entry Point Detection**
  - SwiftUI: searches for `@main struct App`
  - AppDelegate: searches for `AppDelegate.swift`/`.m`/`.mm`
  - Target-specific folder search: Searches in `<targetName>/` folder first, then project-wide
  - Per-target entry files: Each target can have its own AppDelegate/SwiftUI App file
  - Project-wide fallback search

### ✅ **Prerequisites Checking**

- **Xcode Version Check**
  - Minimum: 9.0
  - Version parsing and comparison

- **CocoaPods Version Check**
  - Minimum: 1.5.3
  - Only checked when using CocoaPods
  - Error handling for missing CocoaPods

- **iOS Deployment Target Check**
  - Minimum: 11.0
  - Parsing from project file

- **Swift Version Check**
  - Minimum: 4.0
  - Only checked for Swift projects

### ✅ **Build Verification**

- **Pre-Integration Build Check**
  - Verifies project builds before integration
  - Scheme-based build attempt
  - Target-based build fallback
  - BuildVerificationError on failure (hard stop)
  - Build output capture

### ✅ **Configuration File Management**

- **Config File Addition**
  - Default location: `<projectPath>/apptics-config.plist`
  - Custom path: Supports `configFilePath` parameter
  - File copying: Copies from source to destination

- **Multi-Environment Config**
  - Multiple config files support
  - Environment-specific naming: `apptics-config-{env}.plist`

### ✅ **Verification**

- **Post-Integration Verification**
  - Per-target verification: Checks each target individually for SPM product dependencies
  - Package manager setup check
  - SDK configuration verification
  - Build script presence: Verifies script phase exists in target's buildPhases
  - Package reference location: Verifies package references are at PBXProject level (not TargetAttributes)
  - Product dependency linking: Verifies `packageProductDependencies` contains Apptics product
  - Pre-build script verification
  - Config file existence check
  - Sandboxing disabled check
  - Import verification
  - Initialization verification

### ✅ **Idempotency & Re-run Support**

- **Existing Podfile Handling**
  - Merges with existing targets
  - Preserves other pods
  - Target deduplication

- **Existing SPM Package Handling**
  - Reuses existing package reference IDs
  - Avoids duplicate package references
  - Product dependency deduplication

- **Existing Import Detection**
  - Detects `import Apptics` (Swift)
  - Detects `#import <Apptics/Apptics.h>` (Objective-C)
  - Skips if already present

- **Existing Initialization Detection**
  - Detects `Apptics.initialize()`
  - Detects `AppticsManager.shared.configure()`
  - Method-level detection for AppDelegate
  - Init-level detection for SwiftUI
  - Skips if already present

- **Existing Manager File Handling**
  - Reuses existing `AppticsManager.swift` if present and `overwrite: false`
  - Overwrite option support
  - Content preservation

- **Existing Build Script Phase Detection**
  - Skips duplicate "Apptics pre build" scripts
  - Per-target script phase management

### ✅ **Import Statement Variations**

- **SPM Import Statements**
  - Default: `import Apptics` (when `spmProductName` not specified)
  - Custom product: `import AppticsAnalytics` (or custom `spmProductName`)
  - Manager template: Both `import Apptics` and `import AppticsEventTracker` (for event tracking)

- **CocoaPods Import Statements**
  - Swift: `import Apptics`
  - Objective-C: `#import <Apptics/Apptics.h>`

### ✅ **Error Handling**

- **BuildVerificationError**
  - Hard stop on build failure
  - Build output capture
  - Clear error messages

- **Missing Prerequisites**
  - Lists all missing requirements
  - Specific version requirements
  - Actionable error messages

- **Target Not Found**
  - Lists available targets
  - Case-insensitive suggestions

- **Entry Point Not Found**
  - Specific errors for missing AppDelegate
  - Specific errors for missing SwiftUI App
  - Guidance for manual specification

- **Scheme Not Found**
  - Falls back to direct target build (when schemes don't exist)
  - Clear error messages

- **Package Resolution Failure**
  - Continues if project structure is correct
  - Multiple fallback strategies
  - Verification of project file structure

### ✅ **SPM Package Resolution Strategies**

- **Primary Resolution Method**
  - `xcodebuild -resolvePackageDependencies`

- **Fallback Methods**
  - `xcodebuild -list` (triggers resolution)
  - `xcodebuild -showBuildSettings` (triggers resolution)
  - `xcodebuild clean build-for-testing` (triggers resolution)

- **Timeout Handling**
  - 3-minute timeout for package resolution
  - Graceful degradation

- **Verification**
  - Validates package structure even if resolution fails
  - Checks package reference, product dependency, target dependency

### ✅ **File Linking**

- **Existing File Reference Reuse**
  - Reuses existing PBXFileReference IDs
  - Preserves other target memberships

- **File Cleanup**
  - Removes malformed existing references
  - Clean state before adding

- **Group Creation**
  - Creates folder groups if needed
  - Proper group hierarchy

- **Target Membership**
  - Links file to specified targets only
  - Per-target file linking

### ✅ **Build Script Commands**

- **CocoaPods Script**
  - Direct path: `./Pods/Apptics-SDK/scripts/run`
  - Parameter passing

- **SPM Script**
  - Dynamic find command: `find "$HOME/Library/Developer/Xcode/DerivedData" -name "run" -path "*/SourcePackages/checkouts/Apptics*"`
  - DerivedData path resolution
  - Conditional execution: Wrapped in `if [ -n "$SCRIPT_PATH" ]; then ... fi` for SPM

### ✅ **Podfile Generation**

- **Platform Specification**
  - Always sets `platform :ios, '11.0'`

- **Source Specification**
  - Always includes `source 'https://github.com/CocoaPods/Specs.git'`

- **Framework Usage**
  - Always includes `use_frameworks!`

- **Script Phase Execution**
  - `:execution_position => :before_compile`

### ✅ **SwiftUI-Specific Features**

- **Init Method Detection**
  - Looks for existing `init()` method in SwiftUI App struct
  - Proper brace depth tracking: Properly handles nested braces in SwiftUI App struct

- **Init Injection**
  - Injects into existing `init()` if found
  - Creates new `init()` if not found

- **Body Placement**
  - Inserts `init()` before `var body` property

### ✅ **Objective-C Specific Features**

- **Method Signature Matching**
  - Exact signature matching: Matches `- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:`
  - Return type handling: Preserves `BOOL` return type

- **Config Syntax**
  - `YES`/`NO` for booleans
  - Enum constants for anonymous type

### ✅ **Verbose Mode**

- **Verbose Logging**
  - Default: `true`
  - Step-by-step output
  - Build output on errors

---

## **📋 To-Do Scenarios**

### ⬜ **App Extensions Support**

- **Widget Extensions**
  - Widget target integration
  - Shared app group configuration
  - Extension-specific initialization

- **Watch Extensions**
  - watchOS target support
  - Watch app integration
  - Shared data via app groups

- **tvOS Extensions**
  - tvOS target support
  - Extension integration

- **Notification Service Extensions**
  - Notification extension target support
  - Extension initialization

- **Share Extensions**
  - Share extension target support
  - Extension integration

- **Action Extensions**
  - Action extension target support
  - Extension integration

### ⬜ **Platform Support**

- **macOS Support**
  - macOS target detection
  - macOS-specific configuration
  - Platform-specific build scripts

- **watchOS Support**
  - watchOS target detection
  - watchOS-specific configuration
  - Watch app integration

- **tvOS Support**
  - tvOS target detection
  - tvOS-specific configuration
  - tvOS app integration

- **Cross-Platform Projects**
  - Multi-platform target support
  - Platform-specific configurations
  - Unified integration flow

### ⬜ **Workspace Support**

- **Workspace Detection**
  - `.xcworkspace` detection
  - Workspace vs project handling
  - Multiple projects in workspace

- **Workspace Integration**
  - Workspace-level package management
  - Shared dependencies across projects
  - Workspace scheme support

### ⬜ **Advanced Configuration**

- **Custom Build Configurations**
  - Debug/Release/Staging configurations
  - Configuration-specific settings
  - Conditional compilation

- **Environment Variables**
  - Build-time environment variables
  - Configuration via environment
  - CI/CD integration

- **Feature Flags**
  - Conditional SDK features
  - Feature flag integration
  - Runtime configuration

### ⬜ **Testing & Validation**

- **Unit Test Integration**
  - Test target support
  - Mock SDK for testing
  - Test configuration

- **UI Test Integration**
  - UI test target support
  - Test-specific configuration

- **Snapshot Test Support**
  - Snapshot test target support
  - Test configuration

### ⬜ **Advanced Manager Features**

- **Custom Event Groups**
  - User-defined event groups
  - Custom group validation
  - Group-based filtering

- **Event Validation**
  - Event name validation
  - Property type checking
  - Schema validation

- **Batch Event Tracking**
  - Batch event submission
  - Offline event queuing
  - Event batching configuration

### ⬜ **Analytics Features**

- **Screen Tracking**
  - Automatic screen view tracking
  - Custom screen names
  - Screen view properties

- **User Identification**
  - User ID tracking
  - User property tracking
  - User segmentation

- **Session Management**
  - Custom session handling
  - Session properties
  - Session lifecycle events

### ⬜ **Performance & Optimization**

- **Lazy Initialization**
  - Deferred SDK initialization
  - On-demand initialization
  - Performance optimization

- **Background Processing**
  - Background task support
  - Background data upload
  - Background processing configuration

- **Data Compression**
  - Compressed data transmission
  - Compression configuration
  - Bandwidth optimization

### ⬜ **Security & Privacy**

- **Data Encryption**
  - Encrypted data transmission
  - Encryption configuration
  - Security settings

- **Privacy Compliance**
  - GDPR compliance features
  - CCPA compliance features
  - Privacy configuration

- **Data Retention**
  - Configurable data retention
  - Data expiration policies
  - Storage management

### ⬜ **Integration Enhancements**

- **Carthage Support**
  - Carthage integration
  - Framework linking
  - Carthage-specific configuration

- **Manual Integration**
  - Manual framework integration
  - Framework copying
  - Manual linking guide

- **React Native Integration**
  - React Native bridge
  - Native module integration
  - React Native-specific API

- **Flutter Integration**
  - Flutter plugin support
  - Platform channel integration
  - Flutter-specific API

- **Xamarin Integration**
  - Xamarin binding support
  - Native binding integration
  - Xamarin-specific API

### ⬜ **Documentation & Tooling**

- **Integration Wizard**
  - Interactive CLI wizard
  - Step-by-step guidance
  - Configuration assistant

- **Migration Tools**
  - Migration from other analytics SDKs
  - Data migration utilities
  - Migration guides

- **Rollback Support**
  - Integration rollback
  - Cleanup utilities
  - State restoration

### ⬜ **Monitoring & Debugging**

- **Debug Mode**
  - Enhanced debug logging
  - Debug UI
  - Debug configuration

- **Integration Health Check**
  - Health check API
  - Integration status monitoring
  - Health check dashboard

- **Error Reporting**
  - Integration error tracking
  - Error reporting UI
  - Error analytics

### ⬜ **CI/CD Integration**

- **GitHub Actions**
  - GitHub Actions workflow
  - Automated integration
  - CI/CD templates

- **GitLab CI**
  - GitLab CI configuration
  - Automated integration
  - CI/CD templates

- **Jenkins Integration**
  - Jenkins pipeline support
  - Automated integration
  - Pipeline templates

- **Fastlane Integration**
  - Fastlane plugin
  - Automated integration
  - Fastlane actions

### ⬜ **Advanced Features**

- **A/B Testing Integration**
  - A/B test framework integration
  - Experiment tracking
  - Variant tracking

- **Crash Reporting Integration**
  - Crash reporting SDK integration
  - Crash analytics
  - Crash reporting configuration

- **Performance Monitoring**
  - Performance metrics tracking
  - Performance monitoring SDK
  - Performance analytics

- **Real-time Analytics**
  - Real-time event streaming
  - Live analytics dashboard
  - Real-time configuration

---

## **Status Legend**

- ✅ **Completed**: Feature is fully implemented and tested
- 📋 **To-Do**: Feature is planned but not yet implemented
- 🔄 **In Progress**: Feature is currently being developed
- ⚠️ **Blocked**: Feature is blocked by dependencies or issues

---

## **Notes**

- This document is updated as scenarios are completed
- Each scenario should be moved from "To-Do" to "Completed" when implemented
- Add new scenarios to "To-Do" as they are identified
- Use the status legend to track progress

---

**Last Updated**: 2024-12-19

