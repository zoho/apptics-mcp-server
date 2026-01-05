# CursorAI Prompt: Add “Switch Dependency” MCP Tool (SPM ↔ CocoaPods) for Apptics iOS SDK

I already have an MCP tool that integrates the Apptics iOS SDK. Now I want to add a **separate MCP tool** that can **switch Apptics dependency integration** between **Swift Package Manager (SPM)** and **CocoaPods**.

## Key Constraints
- The new **switch-dependency tool must NOT disturb or modify** the existing integration tool behavior.
- Do not refactor/move existing integration code unless absolutely required.
- Support **single-target and multi-target** iOS projects.
- When CocoaPods is involved, **do NOT delete or rewrite** `Podfile` or `Podfile.lock`.
  - Podfile may contain other dependencies.
  - Only add/remove **Apptics-related pod entries**.

## Repository Structure (current)
```
.
├── src
│   ├── appticsConfig.ts
│   ├── appticsNetworkClient.ts
│   ├── index.ts
│   └── sdk-integration
│       ├── HelpDocs
│       └── ios
│           ├── iosIntegration.ts
│           ├── universalFileLinker.ts
│           └── utils.ts
```

## Deliverable: New Tool Module (do not touch existing integration tool)
Add a new folder under `src/` for the dependency switcher tool:

```
src/
  dependency-switcher/
    ios/
      switcher.ts
      detectors.ts
      podfileEditor.ts
      spmEditor.ts
      buildValidator.ts
      types.ts
      README.md
```

The new tool should be registered/exported from `src/index.ts` **as a separate tool** (new MCP command), without changing existing `sdk-integration/ios/iosIntegration.ts` logic.

## What the Switcher Tool Must Do

### 1) Detect current Apptics dependency integration
Return one of: `spm | cocoapods | both | none`

Signals:
- CocoaPods: `Podfile` contains Apptics pods (only for Apptics detection)
- SPM: `project.pbxproj` includes Apptics package reference/product dependency or `Package.resolved` includes Apptics

If `both`, report conflict and require explicit resolution (do not auto-remove).

### 2) Support switching directions
#### A) SPM → CocoaPods (Apptics only)
- Before switching: warn that **SPM is recommended**, and require confirmation:
  - “SPM is recommended. Do you still want to switch Apptics to CocoaPods?”
- If confirmed:
  - Add Apptics `pod` lines into the correct `target` block(s) in Podfile (single + multi target).
  - Do not modify other pods.
  - Run `pod install` (or instruct if CLI not available; but implement the logic to attempt).
  - Remove **only Apptics-related SPM references** from the Xcode project.

#### B) CocoaPods → SPM (Apptics only)
- Remove only Apptics `pod` lines from Podfile (preserve everything else).
- Do NOT delete `Podfile` or `Podfile.lock`.
- Run `pod install` so the Pods project updates without Apptics.
- Add Apptics as an SPM package to the Xcode project and link products to the correct targets.

### 3) Multi-target requirements
- Must correctly handle:
  - multiple `target 'AppTarget' do ... end` blocks
  - shared pod definitions via helper functions (e.g., `def shared_pods` / `abstract_target`)
  - multiple Xcode targets in pbxproj
- Switching should be target-aware: apply Apptics changes to the correct targets (or all iOS app targets by default).

### 4) Safety and Build Validation
- Always create backups before edits:
  - `Podfile` (copy)
  - `.xcodeproj/project.pbxproj` (copy)
- Validate build after switching:
  - If pods remain -> build using `.xcworkspace` if present
  - Otherwise -> build `.xcodeproj`
- Detect and prevent duplicate Apptics linkage (from both managers).
- If validation fails:
  - return clear error + what changed
  - provide rollback instructions (restore backups)

## MCP Tool API (suggested)
Create a new MCP tool command like:
- `switch_apptics_dependency`

Inputs:
- `projectPath`
- `to`: `"spm" | "cocoapods"`
- `targets?`: optional list of target names; if omitted, apply to all relevant iOS targets
- `confirmCocoapodsSwitch?`: boolean (required for SPM→CocoaPods; if false, abort with warning)

Output:
- detected state before/after
- files changed
- build validation results

## Implementation Notes
- Reuse existing helper utilities from `sdk-integration/ios/utils.ts` only if it does not change their behavior.
- Keep switcher logic self-contained.
- Add a short README for the new tool describing usage and rollback.

Now implement this new tool module, wire it into `src/index.ts`, and keep existing integration tool untouched.
