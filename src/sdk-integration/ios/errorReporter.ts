import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getToolVersions, getBuildSettings } from './xcodeProjectParser';

const execAsync = promisify(exec);

/**
 * Error categories for better diagnostics
 */
export enum IntegrationErrorCategory {
  PREREQUISITES_MISSING = 'PREREQUISITES_MISSING',
  BUILD_VERIFICATION_FAILED = 'BUILD_VERIFICATION_FAILED',
  FILE_NOT_FOUND = 'FILE_NOT_FOUND',
  TARGET_NOT_FOUND = 'TARGET_NOT_FOUND',
  DEPENDENCY_INSTALLATION_FAILED = 'DEPENDENCY_INSTALLATION_FAILED',
  CONFIGURATION_ERROR = 'CONFIGURATION_ERROR',
  PROJECT_FILE_CORRUPTION = 'PROJECT_FILE_CORRUPTION',
  NETWORK_ERROR = 'NETWORK_ERROR',
  PERMISSION_ERROR = 'PERMISSION_ERROR',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR'
}

/**
 * Structured error information
 */
export interface IntegrationError {
  category: IntegrationErrorCategory;
  message: string;
  details?: string;
  buildOutput?: string;
  stack?: string;
}

/**
 * Environment information for debugging
 */
export interface EnvironmentInfo {
  xcodeVersion?: string;
  cocoapodsVersion?: string;
  swiftVersion?: string;
  iosDeploymentTarget?: string;
  nodeVersion: string;
  platform: string;
  arch: string;
}

/**
 * Complete failure report structure
 */
export interface IntegrationFailureReport {
  timestamp: string;
  projectPath: string;
  targets: string[];
  packageManager: 'cocoapods' | 'spm';
  language: 'swift' | 'objc';
  error: IntegrationError;
  stepsCompleted: string[];
  stepsFailed: string[];
  integrationReport: {
    prerequisitesChecked: boolean;
    packageManagerSetup: boolean;
    configFileAdded: boolean;
    sandboxingDisabled: boolean;
    dependenciesInstalled: boolean;
    importAdded: boolean;
    initializationAdded: boolean;
    managerFileAdded: boolean;
    managerWrapperUsed: boolean;
  };
  environment: EnvironmentInfo;
  suggestions: string[];
}

/**
 * Categorize error based on message content
 */
export function categorizeError(error: Error | string): IntegrationErrorCategory {
  const errorMessage = typeof error === 'string' ? error : error.message;
  const lowerMessage = errorMessage.toLowerCase();

  if (lowerMessage.includes('xcode') && (lowerMessage.includes('not found') || lowerMessage.includes('required'))) {
    return IntegrationErrorCategory.PREREQUISITES_MISSING;
  }
  if (lowerMessage.includes('cocoapods') && (lowerMessage.includes('not found') || lowerMessage.includes('required'))) {
    return IntegrationErrorCategory.PREREQUISITES_MISSING;
  }
  if (lowerMessage.includes('swift') && lowerMessage.includes('required')) {
    return IntegrationErrorCategory.PREREQUISITES_MISSING;
  }
  if (lowerMessage.includes('build failed') || lowerMessage.includes('build verification')) {
    return IntegrationErrorCategory.BUILD_VERIFICATION_FAILED;
  }
  if (lowerMessage.includes('not found') && (lowerMessage.includes('file') || lowerMessage.includes('path'))) {
    return IntegrationErrorCategory.FILE_NOT_FOUND;
  }
  if (lowerMessage.includes('target') && lowerMessage.includes('not found')) {
    return IntegrationErrorCategory.TARGET_NOT_FOUND;
  }
  if (lowerMessage.includes('pod install') || lowerMessage.includes('dependencies') || lowerMessage.includes('package')) {
    return IntegrationErrorCategory.DEPENDENCY_INSTALLATION_FAILED;
  }
  if (lowerMessage.includes('config') || lowerMessage.includes('bundle id')) {
    return IntegrationErrorCategory.CONFIGURATION_ERROR;
  }
  if (lowerMessage.includes('corrupt') || lowerMessage.includes('invalid') || lowerMessage.includes('malformed')) {
    return IntegrationErrorCategory.PROJECT_FILE_CORRUPTION;
  }
  if (lowerMessage.includes('network') || lowerMessage.includes('timeout') || lowerMessage.includes('connection')) {
    return IntegrationErrorCategory.NETWORK_ERROR;
  }
  if (lowerMessage.includes('permission') || lowerMessage.includes('eacces')) {
    return IntegrationErrorCategory.PERMISSION_ERROR;
  }

  return IntegrationErrorCategory.UNKNOWN_ERROR;
}

/**
 * Generate actionable suggestions based on error category
 */
export function generateSuggestions(category: IntegrationErrorCategory, error: IntegrationError): string[] {
  const suggestions: string[] = [];

  switch (category) {
    case IntegrationErrorCategory.PREREQUISITES_MISSING:
      suggestions.push('Install or update the missing prerequisites (Xcode, CocoaPods, Swift)');
      suggestions.push('Run "xcodebuild -version" to verify Xcode installation');
      suggestions.push('Run "pod --version" to verify CocoaPods installation');
      suggestions.push('Check that your iOS deployment target meets minimum requirements (iOS 12.0+)');
      break;

    case IntegrationErrorCategory.BUILD_VERIFICATION_FAILED:
      suggestions.push('Fix any existing build errors in your project before integration');
      suggestions.push('Open the project in Xcode and try building manually to see detailed errors');
      suggestions.push('Check the buildOutput section in this report for specific error messages');
      suggestions.push('Ensure all existing dependencies are properly installed');
      suggestions.push('If a "build" folder appeared in your project (from verification), add "build/" to .gitignore and delete the folder if desired');
      break;

    case IntegrationErrorCategory.FILE_NOT_FOUND:
      suggestions.push('Verify the project path is correct and points to the directory containing .xcodeproj');
      suggestions.push('Ensure AppDelegate or SwiftUI App files exist in the project');
      suggestions.push('Provide explicit file paths using appDelegatePath or swiftUIAppPath parameters');
      break;

    case IntegrationErrorCategory.TARGET_NOT_FOUND:
      suggestions.push('Verify the target name matches exactly (case-sensitive)');
      suggestions.push('List available targets by checking the .xcodeproj in Xcode');
      suggestions.push('Use targetNames: "all" to integrate all available targets');
      break;

    case IntegrationErrorCategory.DEPENDENCY_INSTALLATION_FAILED:
      suggestions.push('Try running "pod install" or "pod update" manually');
      suggestions.push('Check your internet connection');
      suggestions.push('Clear CocoaPods cache: "pod cache clean --all"');
      suggestions.push('Update CocoaPods: "sudo gem install cocoapods"');
      suggestions.push('For SPM, try cleaning derived data and rebuilding');
      break;

    case IntegrationErrorCategory.CONFIGURATION_ERROR:
      suggestions.push('Verify the bundle ID is registered in Apptics Console (https://apptics.zoho.com)');
      suggestions.push('Ensure the bundle ID matches an iOS/Apple app (not Android)');
      suggestions.push('Check that apptics-config.plist exists or can be downloaded');
      suggestions.push('Use alternateBundleId parameter if your project bundle ID differs from registered app');
      break;

    case IntegrationErrorCategory.PROJECT_FILE_CORRUPTION:
      suggestions.push('Backup your project first');
      suggestions.push('Try opening and saving the project in Xcode to repair corruption');
      suggestions.push('Check for syntax errors in project.pbxproj file');
      suggestions.push('Restore from version control if corruption is severe');
      break;

    case IntegrationErrorCategory.NETWORK_ERROR:
      suggestions.push('Check your internet connection');
      suggestions.push('Verify you can access GitHub and CocoaPods repositories');
      suggestions.push('Try again after a few minutes');
      suggestions.push('Check if corporate firewall/proxy is blocking package downloads');
      break;

    case IntegrationErrorCategory.PERMISSION_ERROR:
      suggestions.push('Check file permissions in the project directory');
      suggestions.push('Ensure you have write access to the project files');
      suggestions.push('Try running with appropriate permissions');
      break;

    case IntegrationErrorCategory.UNKNOWN_ERROR:
      suggestions.push('Check the full error details and stack trace below');
      suggestions.push('Try running the integration again with verbose mode enabled');
      suggestions.push('Contact support with this failure report');
      break;
  }

  return suggestions;
}

/**
 * Collect environment information
 */
export async function collectEnvironmentInfo(): Promise<EnvironmentInfo> {
  const env: EnvironmentInfo = {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch
  };

  try {
    const toolVersions = await getToolVersions();
    env.xcodeVersion = toolVersions.xcodeVersion || 'Not installed';
    env.cocoapodsVersion = toolVersions.cocoapodsVersion || 'Not installed';
    env.swiftVersion = toolVersions.swiftVersion || 'Not installed';
  } catch {
    env.xcodeVersion = 'Not installed';
    env.cocoapodsVersion = 'Not installed';
    env.swiftVersion = 'Not installed';
  }

  return env;
}

/**
 * Generate and save failure report to disk
 */
export async function generateFailureReport(params: {
  projectPath: string;
  targets: string[];
  packageManager: 'cocoapods' | 'spm';
  language: 'swift' | 'objc';
  error: Error | string;
  stepsCompleted: string[];
  stepsFailed: string[];
  integrationReport: IntegrationFailureReport['integrationReport'];
  buildOutput?: string;
}): Promise<{ reportPath: string; report: IntegrationFailureReport }> {
  const {
    projectPath,
    targets,
    packageManager,
    language,
    error,
    stepsCompleted,
    stepsFailed,
    integrationReport,
    buildOutput
  } = params;

  const errorObj = typeof error === 'string' ? new Error(error) : error;
  const category = categorizeError(errorObj);
  
  const integrationError: IntegrationError = {
    category,
    message: errorObj.message,
    details: errorObj.toString(),
    ...(buildOutput && { buildOutput }),
    ...(errorObj.stack && { stack: errorObj.stack })
  };

  const suggestions = generateSuggestions(category, integrationError);
  const environment = await collectEnvironmentInfo();

  const report: IntegrationFailureReport = {
    timestamp: new Date().toISOString(),
    projectPath,
    targets,
    packageManager,
    language,
    error: integrationError,
    stepsCompleted,
    stepsFailed,
    integrationReport,
    environment,
    suggestions
  };

  // Save report to project directory
  const reportFileName = `apptics-integration-failure-${Date.now()}.json`;
  const reportPath = path.join(projectPath, reportFileName);
  
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  return { reportPath, report };
}

/**
 * Format failure report for console output
 */
export function formatFailureReport(report: IntegrationFailureReport): string {
  const lines: string[] = [];
  
  lines.push('═══════════════════════════════════════════════════════════');
  lines.push('   APPTICS SDK INTEGRATION FAILURE REPORT');
  lines.push('═══════════════════════════════════════════════════════════\n');
  
  lines.push(`Timestamp: ${report.timestamp}`);
  lines.push(`Project: ${report.projectPath}`);
  lines.push(`Targets: ${report.targets.join(', ')}`);
  lines.push(`Package Manager: ${report.packageManager}`);
  lines.push(`Language: ${report.language}\n`);
  
  lines.push('─────────────────────────────────────────────────────────');
  lines.push('ERROR DETAILS');
  lines.push('─────────────────────────────────────────────────────────');
  lines.push(`Category: ${report.error.category}`);
  lines.push(`Message: ${report.error.message}\n`);
  
  if (report.stepsCompleted.length > 0) {
    lines.push('─────────────────────────────────────────────────────────');
    lines.push('STEPS COMPLETED ✓');
    lines.push('─────────────────────────────────────────────────────────');
    report.stepsCompleted.forEach((step, i) => {
      lines.push(`${i + 1}. ${step}`);
    });
    lines.push('');
  }
  
  if (report.stepsFailed.length > 0) {
    lines.push('─────────────────────────────────────────────────────────');
    lines.push('STEPS FAILED ✗');
    lines.push('─────────────────────────────────────────────────────────');
    report.stepsFailed.forEach((step, i) => {
      lines.push(`${i + 1}. ${step}`);
    });
    lines.push('');
  }
  
  lines.push('─────────────────────────────────────────────────────────');
  lines.push('INTEGRATION STATUS');
  lines.push('─────────────────────────────────────────────────────────');
  lines.push(`Prerequisites Checked: ${report.integrationReport.prerequisitesChecked ? '✓' : '✗'}`);
  lines.push(`Package Manager Setup: ${report.integrationReport.packageManagerSetup ? '✓' : '✗'}`);
  lines.push(`Config File Added: ${report.integrationReport.configFileAdded ? '✓' : '✗'}`);
  lines.push(`Sandboxing Disabled: ${report.integrationReport.sandboxingDisabled ? '✓' : '✗'}`);
  lines.push(`Dependencies Installed: ${report.integrationReport.dependenciesInstalled ? '✓' : '✗'}`);
  lines.push(`Import Added: ${report.integrationReport.importAdded ? '✓' : '✗'}`);
  lines.push(`Initialization Added: ${report.integrationReport.initializationAdded ? '✓' : '✗'}`);
  lines.push(`Manager File Added: ${report.integrationReport.managerFileAdded ? '✓' : '✗'}\n`);
  
  lines.push('─────────────────────────────────────────────────────────');
  lines.push('ENVIRONMENT');
  lines.push('─────────────────────────────────────────────────────────');
  lines.push(`Xcode: ${report.environment.xcodeVersion}`);
  lines.push(`CocoaPods: ${report.environment.cocoapodsVersion}`);
  lines.push(`Swift: ${report.environment.swiftVersion}`);
  lines.push(`Node: ${report.environment.nodeVersion}`);
  lines.push(`Platform: ${report.environment.platform} (${report.environment.arch})\n`);
  
  if (report.suggestions.length > 0) {
    lines.push('─────────────────────────────────────────────────────────');
    lines.push('SUGGESTED FIXES');
    lines.push('─────────────────────────────────────────────────────────');
    report.suggestions.forEach((suggestion, i) => {
      lines.push(`${i + 1}. ${suggestion}`);
    });
    lines.push('');
  }
  
  if (report.error.buildOutput) {
    lines.push('─────────────────────────────────────────────────────────');
    lines.push('BUILD OUTPUT (Last 100 lines)');
    lines.push('─────────────────────────────────────────────────────────');
    const buildLines = report.error.buildOutput.split('\n').slice(-100);
    lines.push(buildLines.join('\n'));
    lines.push('');
  }
  
  lines.push('═══════════════════════════════════════════════════════════');
  lines.push('Full details saved to failure report JSON file');
  lines.push('═══════════════════════════════════════════════════════════');
  
  return lines.join('\n');
}
