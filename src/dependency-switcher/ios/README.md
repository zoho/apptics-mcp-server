# Apptics Dependency Switcher Tool

This tool allows you to switch the Apptics iOS SDK dependency between **Swift Package Manager (SPM)** and **CocoaPods** without having to manually edit project files.

## Overview

The dependency switcher tool:
- Detects the current Apptics dependency state (SPM, CocoaPods, both, or none)
- Safely switches between dependency managers
- Creates backups before making changes
- Validates the build after switching
- Provides rollback instructions if something goes wrong

## Usage

### MCP Tool: `switch_apptics_dependency`

**Parameters:**
- `projectPath` (required): Absolute path to the iOS Xcode project directory
- `to` (required): Target dependency manager - `"spm"` or `"cocoapods"`
- `targetNames` (optional): Target names to switch. Can be:
  - `"all"` - Switch all targets
  - `string` - Single target name
  - `string[]` - Array of target names
  - If omitted, defaults to all discovered targets
- `language` (optional): Project language - `"swift"` or `"objc"`. Auto-detected if not provided
- `spmProductName` (optional): SPM product name (defaults to `"AppticsAnalytics"`)
- `confirmSpmSwitch` (optional but required to proceed when switching from CocoaPods to SPM). If omitted the tool will stop and ask you to confirm.
- `verbose` (optional): Enable verbose output (default: `false`)
- `skipBuild` (optional): Skip build validation after switching (default: `false`)

### Example: Switch from CocoaPods to SPM

```json
{
  "projectPath": "/path/to/MyApp",
  "to": "spm",
  "targetNames": "all",
  "confirmSpmSwitch": true,
  "verbose": true
}
```

### Example: Switch from SPM to CocoaPods

```json
{
  "projectPath": "/path/to/MyApp",
  "to": "cocoapods",
  "targetNames": ["MyApp", "MyAppExtension"],
  "language": "swift"
}
```

## How It Works

### SPM → CocoaPods Flow

1. **Detection**: Checks if Apptics is currently using SPM
2. **Backup**: Creates timestamped backups of `Podfile` and `project.pbxproj`
3. **Add Pod**: Adds Apptics pod (`Apptics-Swift` or `Apptics-SDK`) to Podfile for specified targets
4. **Pod Install**: Runs `pod install` to install CocoaPods dependencies
5. **Remove SPM**: Removes Apptics SPM package references from `project.pbxproj`
6. **Validation**: Validates the build structure

### CocoaPods → SPM Flow

1. **Detection**: Checks if Apptics is currently using CocoaPods
2. **Confirmation**: If `confirmSpmSwitch` is not provided, the tool stops and asks you to confirm (SPM is recommended). Re-run with `confirmSpmSwitch: true` to proceed.
3. **Backup**: Creates timestamped backups of `Podfile` and `project.pbxproj`
4. **Remove Pod**: Removes Apptics pod lines from Podfile (preserves other pods)
5. **Pod Install**: Runs `pod install` to update Pods project
6. **Add SPM**: Adds Apptics SPM package reference and product dependencies to `project.pbxproj`
7. **Resolve Packages**: Runs `xcodebuild -resolvePackageDependencies`
8. **Validation**: Validates the build structure

## Multi-Target Support

The tool supports projects with multiple targets:

- **All Targets**: Use `targetNames: "all"` to switch all discovered targets
- **Specific Targets**: Provide an array of target names: `targetNames: ["MainApp", "Extension"]`
- **Single Target**: Provide a string: `targetNames: "MainApp"`

The tool automatically:
- Parses Podfile to find target blocks
- Adds/removes pods in the correct target scopes
- Handles `abstract_target` and shared pod definitions
- Links SPM product dependencies to all specified targets

## Safety Features

### Backups

Before making any changes, the tool creates timestamped backups:
- `Podfile.backup.<timestamp>`
- `project.pbxproj.backup.<timestamp>`

### Conflict Detection

The tool detects and prevents:
- **Both managers**: If Apptics is configured with both SPM and CocoaPods, it throws an error requiring manual resolution
- **No integration**: If Apptics is not integrated, it suggests using the integration tool first

### Rollback Instructions

If switching fails, the tool provides rollback instructions:

```
To rollback the dependency switch:
1. Restore Podfile: cp "Podfile.backup.<timestamp>" "Podfile"
2. Restore project.pbxproj: cp "project.pbxproj.backup.<timestamp>" "project.pbxproj"
3. Run: pod install
4. Open the project in Xcode and verify it builds correctly
```

## Error Handling

The tool handles various error scenarios:

- **Build validation failures**: Returns warnings but doesn't fail the switch
- **Pod install failures**: Throws error with rollback instructions
- **Missing targets**: Provides list of available targets
- **Invalid project structure**: Clear error messages

## Limitations

1. **Podfile Structure**: The tool uses regex-based parsing for Podfile editing. Complex Podfile structures with custom Ruby code may require manual intervention.

2. **Build Script Phases**: When switching from CocoaPods to SPM, the tool removes Apptics-related build script phases. You may need to manually add SPM build script phases if required.

3. **Package.resolved**: The tool doesn't modify `Package.resolved` directly. Xcode will regenerate it on the next build.

4. **Other Dependencies**: The tool only modifies Apptics-related entries. Other SPM packages or CocoaPods dependencies are preserved.

## Best Practices

1. **Version Control**: Commit your changes before switching
2. **Test After Switch**: Always test your app after switching dependency managers
3. **Use SPM**: SPM is the recommended package manager for new projects
4. **Backup First**: The tool creates backups, but it's good practice to have your own backups

## Troubleshooting

### "Apptics is configured with both SPM and CocoaPods"

Manually remove one dependency manager before switching:
- Remove SPM: Delete package reference from Xcode project
- Remove CocoaPods: Remove pod line from Podfile and run `pod install`

### "Pod install failed"

Check:
- CocoaPods is installed: `pod --version`
- Podfile syntax is correct
- Network connectivity for pod specs
- Use rollback instructions to restore backups

### "Target not found"

Verify target names match exactly (case-sensitive):
- List targets: Check `project.pbxproj` for `PBXNativeTarget` entries
- Use `targetNames: "all"` to switch all targets

## Related Tools

- **Integration Tool**: Use `integrate_apptics_ios_sdk` to initially integrate Apptics
- **Verification**: The integration tool includes verification checks

## Implementation Details

The switcher tool is implemented in separate modules:

- `detectors.ts`: Detects current dependency state
- `podfileEditor.ts`: Adds/removes Apptics pods from Podfile
- `spmEditor.ts`: Adds/removes Apptics SPM references from project.pbxproj
- `buildValidator.ts`: Validates build and creates backups
- `switcher.ts`: Main orchestration logic

The tool is completely separate from the integration tool and does not modify its behavior.

