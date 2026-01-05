/**
 * Type definitions for Apptics Dependency Switcher
 */

export type DependencyState = 'spm' | 'cocoapods' | 'both' | 'none';
export type IOSLanguage = 'swift' | 'objc';
export type TargetSelection = string[] | 'all' | string;

export interface SwitchParams {
  projectPath: string;
  to: 'spm' | 'cocoapods';
  targetNames?: TargetSelection | undefined;
  language?: IOSLanguage | undefined;
  spmProductName?: string | undefined;
  confirmCocoapodsSwitch?: boolean | undefined;
  verbose?: boolean | undefined;
  skipBuild?: boolean | undefined;
}

export interface SwitchResult {
  success: boolean;
  fromState: DependencyState;
  toState: DependencyState;
  filesChanged: string[];
  backupPaths?: BackupPaths;
  buildValidation?: BuildValidationResult;
  message: string;
  error?: string;
  rollbackInstructions?: string;
}

export interface BackupPaths {
  podfile?: string;
  pbxproj?: string;
}

export interface BuildValidationResult {
  valid: boolean;
  errors?: string[] | undefined;
  warnings?: string[] | undefined;
  buildCommand?: string | undefined;
}

export interface DetectionResult {
  state: DependencyState;
  details: {
    hasCocoaPods?: boolean;
    hasSPM?: boolean;
    podfilePath?: string;
    pbxprojPath?: string;
    appticsPodName?: string;
    spmPackageRefId?: string;
  };
}

