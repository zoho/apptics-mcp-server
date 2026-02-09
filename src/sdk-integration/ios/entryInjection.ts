import * as fs from 'fs/promises';
import { AppticsInitConfig, AppEntryPoint } from './pbxprojUtils';
import { parseSwiftFile, parseObjectiveCFile } from './swiftParser';
import { getOptionalModules } from './appticsOptionalModules';

export async function addAppticsImport(params: {
  entryFilePath: string;
  language: 'swift' | 'objc';
  packageManager?: 'cocoapods' | 'spm';
  spmProductName?: string;
  /** Optional module ids: add their import lines after the last import. */
  optionalModuleIds?: string[];
}) {
  const { entryFilePath, language, packageManager = 'spm', spmProductName, optionalModuleIds } = params;

  try {
    let content = await fs.readFile(entryFilePath, 'utf-8');
    
    const moduleName = packageManager === 'spm' 
      ? (spmProductName || 'Apptics')
      : 'Apptics';
    const importStatement = language === 'swift'
      ? `import ${moduleName}`
      : '#import <Apptics/Apptics.h>';

    let modified = false;
    if (!content.includes(importStatement)) {
      const lines = content.split('\n');
      let lastImportLine = -1;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]?.trim();
        if (!line) continue;
        if (language === 'swift' && line.startsWith('import ')) lastImportLine = i;
        if (language === 'objc' && line.startsWith('#import ')) lastImportLine = i;
      }
      if (lastImportLine >= 0) {
        lines.splice(lastImportLine + 1, 0, importStatement);
        content = lines.join('\n');
      } else {
        content = importStatement + '\n' + content;
      }
      modified = true;
    }

    // Add optional module imports after the last import (run even when core import already exists, so incremental module add works)
    if (optionalModuleIds && optionalModuleIds.length > 0) {
      const modules = getOptionalModules(optionalModuleIds);
      const lines2 = content.split('\n');
      let lastImportIdx = -1;
      for (let i = 0; i < lines2.length; i++) {
        const line = lines2[i]?.trim();
        if (language === 'swift' && line?.startsWith('import ')) lastImportIdx = i;
        if (language === 'objc' && line?.startsWith('#import ')) lastImportIdx = i;
      }
      if (lastImportIdx >= 0) {
        const toInsert: string[] = [];
        for (const m of modules) {
          const imp = language === 'swift' ? m.importSwift : m.importObjc;
          if (imp && !content.includes(imp)) toInsert.push(imp);
        }
        if (toInsert.length > 0) {
          lines2.splice(lastImportIdx + 1, 0, ...toInsert);
          content = lines2.join('\n');
          modified = true;
        }
      }
    }

    if (modified) {
      await fs.writeFile(entryFilePath, content, 'utf-8');
    }

    return {
      success: true,
      importAdded: modified,
      message: modified ? 'Import added successfully' : 'Import already exists'
    };
  } catch (error: any) {
    throw new Error(`Failed to add import: ${error.message}`);
  }
}

export async function addAppticsInitialization(params: {
  entryFilePath: string;
  language: 'swift' | 'objc';
  entryPoint?: AppEntryPoint;
  verbose?: boolean;
  includeAdvancedConfig?: boolean;
  config?: AppticsInitConfig;
  useManagerWrapper?: boolean;
  /** Optional module ids: add their config lines before initialize/configure. */
  optionalModuleIds?: string[];
}) {
  const {
    entryFilePath,
    language,
    entryPoint = 'appDelegate',
    verbose = true,
    includeAdvancedConfig = false,
    config,
    useManagerWrapper = false,
    optionalModuleIds
  } = params;

  if (entryPoint === 'swiftUI' && language !== 'swift') {
    throw new Error('SwiftUI entry point is only supported for Swift projects');
  }
  if (useManagerWrapper && language !== 'swift') {
    throw new Error('Apptics manager wrapper is available only for Swift projects');
  }

  try {
    let content = await fs.readFile(entryFilePath, 'utf-8');
    
    let hasInitialization = false;
    if (language === 'objc') {
      const parsed = await parseObjectiveCFile(entryFilePath);
      hasInitialization = parsed.initialization.hasAppticsInitialization;
    } else {
      const parsed = await parseSwiftFile(entryFilePath);
      hasInitialization = parsed.initialization.hasAppticsInitialization || 
                         parsed.initialization.hasAppticsManagerConfiguration;
    }

    if (hasInitialization && (!optionalModuleIds || optionalModuleIds.length === 0)) {
      return {
        success: true,
        initializationAdded: false,
        message: 'Initialization already exists'
      };
    }

    if (hasInitialization && optionalModuleIds && optionalModuleIds.length > 0) {
      content = injectOptionalConfigLines(content, language, optionalModuleIds);
      await fs.writeFile(entryFilePath, content, 'utf-8');
      return {
        success: true,
        initializationAdded: false,
        message: 'Optional module config lines added to existing initialization'
      };
    }

    if (entryPoint === 'swiftUI') {
      content = injectIntoSwiftUIApp(
        content,
        includeAdvancedConfig && !!config,
        config,
        verbose,
        useManagerWrapper,
        optionalModuleIds
      );
    } else if (language === 'swift') {
      const methodSignature = 'func application';
      const methodIndex = findSwiftMethodStart(content, methodSignature);
      
      if (methodIndex === -1) {
        throw new Error('Unable to locate application(_:didFinishLaunchingWithOptions:) in the provided file');
      }
      
      const methodBodyStart = content.indexOf('{', methodIndex);
      if (methodBodyStart !== -1) {
        let braceDepth = 1;
        let methodBodyEnd = methodBodyStart + 1;
        for (let i = methodBodyStart + 1; i < content.length && braceDepth > 0; i++) {
          if (content[i] === '{') braceDepth++;
          if (content[i] === '}') braceDepth--;
          if (braceDepth === 0) {
            methodBodyEnd = i;
            break;
          }
        }
        
        const methodBodyContent = content.slice(methodBodyStart, methodBodyEnd);
        if (methodBodyContent.includes('AppticsManager.shared.configure') || 
            methodBodyContent.includes('Apptics.initialize')) {
          return {
            success: true,
            initializationAdded: false,
            message: 'Initialization already exists in method'
          };
        }
      }
      
      const initCode = createSwiftInitCode(
        includeAdvancedConfig && !!config,
        config,
        verbose,
        4,
        useManagerWrapper,
        optionalModuleIds
      );
      
      // Insert after opening brace
      content = content.slice(0, methodBodyStart + 1) + initCode + content.slice(methodBodyStart + 1);
    } else {
      const methodSignature = '- (BOOL)application:';
      const methodIndex = content.indexOf(methodSignature);
      
      if (methodIndex === -1) {
        throw new Error('Unable to locate application:didFinishLaunchingWithOptions: in the provided file');
      }
      
      const methodBodyStart = content.indexOf('{', methodIndex);
      if (methodBodyStart === -1) {
        throw new Error('Unable to locate method body opening brace');
      }
      
      const initCode = createObjcInitCode(includeAdvancedConfig && !!config, config, verbose, optionalModuleIds);
      content = content.slice(0, methodBodyStart + 1) + initCode + content.slice(methodBodyStart + 1);
    }

    await fs.writeFile(entryFilePath, content, 'utf-8');

    return {
      success: true,
      initializationAdded: true,
      message: 'Initialization added successfully'
    };
  } catch (error: any) {
    throw new Error(`Failed to add initialization: ${error.message}`);
  }
}

function injectIntoSwiftUIApp(
  content: string,
  useAdvancedConfig: boolean,
  config: AppticsInitConfig | undefined,
  verbose: boolean,
  useManagerWrapper: boolean,
  optionalModuleIds?: string[]
): string {
  // Find the struct declaration with ": App"
  const structRegex = /struct\s+\w+\s*:\s*App\s*\{/;
  const structMatch = content.match(structRegex);
  
  if (!structMatch || structMatch.index === undefined) {
    throw new Error('SwiftUI App struct not found in the provided file');
  }
  
  const structOpenBrace = structMatch.index + structMatch[0].length - 1;

  // Find 'var body' after the struct opening brace
  const bodyIndex = content.indexOf('var body', structOpenBrace);
  if (bodyIndex === -1) {
    throw new Error('Could not locate SwiftUI App body to insert Apptics initialization');
  }

  const preBodySegment = content.slice(structOpenBrace + 1, bodyIndex);
  const initCode = createSwiftInitCode(
    useAdvancedConfig,
    config,
    verbose,
    8,
    useManagerWrapper,
    optionalModuleIds
  );

  const hasInit = preBodySegment.includes('init()');
  
  if (hasInit) {
    const initStart = preBodySegment.indexOf('init()');
    const absoluteInitIndex = structOpenBrace + 1 + initStart;
    const initBodyStart = content.indexOf('{', absoluteInitIndex);
    if (initBodyStart === -1) {
      throw new Error('Failed to locate SwiftUI init body');
    }
    
    const initBodyEnd = content.indexOf('}', initBodyStart);
    if (initBodyEnd !== -1) {
      const initBodyContent = content.slice(initBodyStart, initBodyEnd);
      if (initBodyContent.includes('AppticsManager.shared.configure') || 
          initBodyContent.includes('Apptics.initialize')) {
        return content;
      }
    }
    
    return (
      content.slice(0, initBodyStart + 1) +
      initCode +
      '\n' +
      content.slice(initBodyStart + 1)
    );
  }

  const insertPos = content.lastIndexOf('\n', bodyIndex);
  const safeInsertPos = insertPos === -1 ? bodyIndex : insertPos;
  const initBlock = `\n    init() {${initCode}\n    }\n`;
  return content.slice(0, safeInsertPos) + initBlock + content.slice(safeInsertPos);
}

function createSwiftInitCode(
  useAdvancedConfig: boolean,
  config: AppticsInitConfig | undefined,
  verbose: boolean,
  indentSize: number,
  useManagerWrapper: boolean,
  optionalModuleIds?: string[]
): string {
  const indent = ' '.repeat(indentSize);
  const sendData = config?.sendDataOnMobileNetworkByDefault ?? true;
  const trackOn = config?.trackOnByDefault ?? true;
  const anonymousType = config?.anonymousType ?? 'pseudoAnonymous';

  const optionalConfigLines: string[] = [];
  if (optionalModuleIds && optionalModuleIds.length > 0) {
    const modules = getOptionalModules(optionalModuleIds);
    for (const m of modules) {
      if (m.configSwift) optionalConfigLines.push(`${indent}${m.configSwift}`);
    }
  }
  const optionalBlock =
    optionalConfigLines.length > 0
      ? `\n${optionalConfigLines.join('\n')}\n`
      : '';

  if (useManagerWrapper) {
    if (useAdvancedConfig) {
      return `${optionalBlock}
${indent}// Configure Apptics via manager
${indent}AppticsManager.shared.configure(verbose: ${verbose}) { config in
${indent}    config.sendDataOnMobileNetworkByDefault = ${sendData}
${indent}    config.trackOnByDefault = ${trackOn}
${indent}    config.anonymousType = .${anonymousType}
${indent}}`;
    }

    return `${optionalBlock}
${indent}// Initialize Apptics via manager
${indent}AppticsManager.shared.configure(verbose: ${verbose})`;
  }

  if (useAdvancedConfig) {
    return `${optionalBlock}
${indent}// Configure Apptics SDK
${indent}AppticsConfig.default.sendDataOnMobileNetworkByDefault = ${sendData}
${indent}AppticsConfig.default.trackOnByDefault = ${trackOn}
${indent}AppticsConfig.default.anonymousType = .${anonymousType}

${indent}// Initialize Apptics
${indent}Apptics.initialize(withVerbose: ${verbose})`;
  }

  return `${optionalBlock}
${indent}// Initialize Apptics
${indent}Apptics.initialize(withVerbose: ${verbose})`;
}

/**
 * When initialization already exists, inject optional module config lines before the configure/initialize call.
 */
function injectOptionalConfigLines(
  content: string,
  language: 'swift' | 'objc',
  optionalModuleIds: string[]
): string {
  const modules = getOptionalModules(optionalModuleIds);
  const linesToAdd: string[] = [];
  for (const m of modules) {
    const line = language === 'swift' ? m.configSwift : m.configObjc;
    if (line && !content.includes(line)) linesToAdd.push(line);
  }
  if (linesToAdd.length === 0) return content;

  const indent = language === 'swift' ? '    ' : '    ';
  const block = linesToAdd.map((l) => indent + l.trim()).join('\n');

  const searchPatterns =
    language === 'swift'
      ? ['AppticsManager.shared.configure', 'Apptics.initialize(withVerbose:']
      : ['[Apptics initializeWithVerbose:'];
  let insertIndex = -1;
  for (const pattern of searchPatterns) {
    const idx = content.indexOf(pattern);
    if (idx !== -1) {
      insertIndex = idx;
      break;
    }
  }
  if (insertIndex === -1) return content;

  const lineStart = content.lastIndexOf('\n', insertIndex);
  const insertAt = lineStart === -1 ? 0 : lineStart + 1;
  return content.slice(0, insertAt) + '\n' + block + '\n' + content.slice(insertAt);
}

/**
 * Find Swift method start position.
 */
function findSwiftMethodStart(content: string, methodSignature: string): number {
  const lines = content.split('\n');
  let charCount = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) {
      charCount += 1; // +1 for newline
      continue;
    }
    if (line.includes(methodSignature)) {
      return charCount + line.indexOf(methodSignature);
    }
    charCount += line.length + 1; // +1 for newline
  }
  
  return -1;
}

function createObjcInitCode(
  useAdvancedConfig: boolean,
  config: AppticsInitConfig | undefined,
  verbose: boolean,
  optionalModuleIds?: string[]
): string {
  const sendData = config?.sendDataOnMobileNetworkByDefault ?? true;
  const trackOn = config?.trackOnByDefault ?? true;
  const anonymousType = config?.anonymousType ?? 'pseudoAnonymous';
  const anonType = anonymousType === 'nonAnonymous'
    ? 'APAnonymousTypeNonAnonymous'
    : 'APAnonymousTypePseudoAnonymous';

  const optionalConfigLines: string[] = [];
  if (optionalModuleIds && optionalModuleIds.length > 0) {
    const modules = getOptionalModules(optionalModuleIds);
    for (const m of modules) {
      if (m.configObjc) optionalConfigLines.push(`    ${m.configObjc}`);
    }
  }
  const optionalBlock =
    optionalConfigLines.length > 0 ? '\n' + optionalConfigLines.join('\n') + '\n\n' : '';

  if (useAdvancedConfig) {
    return `${optionalBlock}
    // Configure Apptics SDK
    AppticsConfig.defaultConfig.sendDataOnMobileNetworkByDefault = ${sendData ? 'YES' : 'NO'};
    AppticsConfig.defaultConfig.trackOnByDefault = ${trackOn ? 'YES' : 'NO'};
    AppticsConfig.defaultConfig.anonymousType = ${anonType};

    // Initialize Apptics
    [Apptics initializeWithVerbose:${verbose ? 'YES' : 'NO'}];`;
  }

  return `${optionalBlock}
    // Initialize Apptics
    [Apptics initializeWithVerbose:${verbose ? 'YES' : 'NO'}];`;
}

