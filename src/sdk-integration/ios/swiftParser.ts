import * as fs from 'fs/promises';

/**
 * Swift/Objective-C code parser using efficient text-based parsing.
 */

export interface SwiftUIAppInfo {
  found: boolean;
  structName?: string;
  hasInit: boolean;
  initLocation?: { line: number; column: number };
  bodyLocation?: { line: number; column: number };
}

export interface AppDelegateInfo {
  found: boolean;
  className?: string;
  hasDidFinishLaunching: boolean;
  methodLocation?: { line: number; column: number };
}

export interface ImportInfo {
  hasAppticsImport: boolean;
  hasAppticsManagerImport: boolean;
  lastImportLine: number;
}

export interface InitializationInfo {
  hasAppticsInitialization: boolean;
  hasAppticsManagerConfiguration: boolean;
}

/**
 * Parse Swift file structure using efficient text-based parsing.
 */
export async function parseSwiftFile(filePath: string): Promise<{
  swiftUIApp?: SwiftUIAppInfo;
  appDelegate?: AppDelegateInfo;
  imports: ImportInfo;
  initialization: InitializationInfo;
}> {
  const content = await fs.readFile(filePath, 'utf-8');
  const lines = content.split('\n');
  return parseSwiftFileTokenBased(content, lines);
}

/**
 * Text-based parser for Swift files.
 */
function parseSwiftFileTokenBased(content: string, lines: string[]): {
  swiftUIApp?: SwiftUIAppInfo;
  appDelegate?: AppDelegateInfo;
  imports: ImportInfo;
  initialization: InitializationInfo;
} {
  let lastImportLine = 0;
  let hasAppticsImport = false;
  let hasAppticsManagerImport = false;
  let hasSwiftUIApp = false;
  let hasAppDelegate = false;
  let hasDidFinishLaunching = false;
  let hasAppticsInit = false;
  let hasAppticsManagerConfig = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;

    if (line.startsWith('import ')) {
      lastImportLine = i + 1;
      const importName = line.substring('import '.length).trim();
      if (importName === 'Apptics' || importName === 'AppticsAnalytics' || importName.startsWith('Apptics')) {
        hasAppticsImport = true;
      }
      if (importName.includes('AppticsManager')) {
        hasAppticsManagerImport = true;
      }
    }

    // SwiftUI App detection
    if (line.includes('@main')) {
      hasSwiftUIApp = true;
    }

    // AppDelegate detection
    if (line.includes('class ') && (line.includes('AppDelegate') || line.includes(': UIApplicationDelegate'))) {
      hasAppDelegate = true;
    }
    if (line.includes('func application') && line.includes('didFinishLaunchingWithOptions')) {
      hasDidFinishLaunching = true;
    }

    if (line.includes('Apptics.initialize')) {
      hasAppticsInit = true;
    }
    if (line.includes('AppticsManager.shared.configure') || line.includes('AppticsManager.shared.initialize')) {
      hasAppticsManagerConfig = true;
    }
  }

  return {
    swiftUIApp: hasSwiftUIApp ? { found: true, hasInit: false } : { found: false, hasInit: false },
    appDelegate: hasAppDelegate ? { found: true, hasDidFinishLaunching } : { found: false, hasDidFinishLaunching: false },
    imports: {
      hasAppticsImport,
      hasAppticsManagerImport,
      lastImportLine
    },
    initialization: {
      hasAppticsInitialization: hasAppticsInit,
      hasAppticsManagerConfiguration: hasAppticsManagerConfig
    }
  };
}

/**
 * Parse Objective-C file structure.
 */
export async function parseObjectiveCFile(filePath: string): Promise<{
  appDelegate?: AppDelegateInfo;
  imports: ImportInfo;
  initialization: InitializationInfo;
}> {
  const content = await fs.readFile(filePath, 'utf-8');
  const lines = content.split('\n');

  let lastImportLine = 0;
  let hasAppticsImport = false;
  let hasAppDelegate = false;
  let hasDidFinishLaunching = false;
  let hasAppticsInit = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;

    if (line.startsWith('#import ')) {
      lastImportLine = i + 1;
      if (line.includes('<Apptics/Apptics.h>') || line.includes('"Apptics.h"')) {
        hasAppticsImport = true;
      }
    }

    // AppDelegate detection
    if (line.includes('@interface ') && line.includes('AppDelegate')) {
      hasAppDelegate = true;
    }
    if (line.includes('- (BOOL)application:') && line.includes('didFinishLaunchingWithOptions:')) {
      hasDidFinishLaunching = true;
    }

    // Initialization detection
    if (line.includes('[Apptics initialize') || line.includes('[Apptics initializeWithVerbose:')) {
      hasAppticsInit = true;
    }
  }

  return {
    appDelegate: hasAppDelegate ? { found: true, hasDidFinishLaunching } : { found: false, hasDidFinishLaunching: false },
    imports: {
      hasAppticsImport,
      hasAppticsManagerImport: false,
      lastImportLine
    },
    initialization: {
      hasAppticsInitialization: hasAppticsInit,
      hasAppticsManagerConfiguration: false
    }
  };
}

/**
 * Find the insertion point for code in a Swift method or init block.
 */
export function findMethodInsertionPoint(
  content: string,
  methodSignature: string
): { index: number; indent: string } | null {
  const lines = content.split('\n');
  let foundMethod = false;
  let braceDepth = 0;
  let methodStartLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    if (!foundMethod && line.includes(methodSignature)) {
      foundMethod = true;
      methodStartLine = i;
    }

    if (foundMethod) {
      // Count braces to find method body start
      for (const char of line) {
        if (char === '{') {
          braceDepth++;
          if (braceDepth === 1) {
            // Found opening brace of method
            const indent = line.substring(0, line.indexOf('{'));
            const insertLine = i + 1;
            const insertIndex = content.split('\n').slice(0, insertLine).join('\n').length + 1;
            return {
              index: insertIndex,
              indent: indent + '    ' // Add 4 spaces for method body indent
            };
          }
        }
        if (char === '}') {
          braceDepth--;
        }
      }
    }
  }

  return null;
}
