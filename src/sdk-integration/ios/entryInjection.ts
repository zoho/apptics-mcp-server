import * as fs from 'fs/promises';
import { AppticsInitConfig, AppEntryPoint } from './pbxprojUtils';

export async function addAppticsImport(params: {
  entryFilePath: string;
  language: 'swift' | 'objc';
  packageManager?: 'cocoapods' | 'spm';
  spmProductName?: string;
}) {
  const { entryFilePath, language, packageManager = 'spm', spmProductName } = params;

  try {
    let content = await fs.readFile(entryFilePath, 'utf-8');
    
    const moduleName = packageManager === 'spm' 
      ? (spmProductName || 'Apptics')
      : 'Apptics';
    const importStatement = language === 'swift' 
      ? `import ${moduleName}` 
      : '#import <Apptics/Apptics.h>';

    if (content.includes(importStatement)) {
      return {
        success: true,
        importAdded: false,
        message: 'Import already exists'
      };
    }

    if (language === 'swift') {
      const lastImport = content.lastIndexOf('import ');
      const insertPos = content.indexOf('\n', lastImport) + 1;
      content = content.slice(0, insertPos) + importStatement + '\n' + content.slice(insertPos);
    } else {
      const lastImport = content.lastIndexOf('#import ');
      const insertPos = content.indexOf('\n', lastImport) + 1;
      content = content.slice(0, insertPos) + importStatement + '\n' + content.slice(insertPos);
    }

    await fs.writeFile(entryFilePath, content, 'utf-8');

    return {
      success: true,
      importAdded: true,
      message: 'Import added successfully'
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
}) {
  const {
    entryFilePath,
    language,
    entryPoint = 'appDelegate',
    verbose = true,
    includeAdvancedConfig = false,
    config,
    useManagerWrapper = false
  } = params;

  if (entryPoint === 'swiftUI' && language !== 'swift') {
    throw new Error('SwiftUI entry point is only supported for Swift projects');
  }
  if (useManagerWrapper && language !== 'swift') {
    throw new Error('Apptics manager wrapper is available only for Swift projects');
  }

  try {
    let content = await fs.readFile(entryFilePath, 'utf-8');
    
    const hasInitialization = language === 'objc'
      ? /\[Apptics initializeWithVerbose:/.test(content)
      : /Apptics\.initialize/.test(content) || /AppticsManager\.shared\.configure/.test(content);

    if (hasInitialization) {
      return {
        success: true,
        initializationAdded: false,
        message: 'Initialization already exists'
      };
    }

    if (entryPoint === 'swiftUI') {
      content = injectIntoSwiftUIApp(
        content,
        includeAdvancedConfig && !!config,
        config,
        verbose,
        useManagerWrapper
      );
    } else if (language === 'swift') {
      const methodPattern = /func application\([^{]+\{/;
      const methodMatch = content.match(methodPattern);
      if (!methodMatch || methodMatch.index === undefined) {
        throw new Error('Unable to locate application(_:didFinishLaunchingWithOptions:) in the provided file');
      }
      
      const methodStart = methodMatch.index;
      const methodBodyStart = content.indexOf('{', methodStart);
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
        if (/AppticsManager\.shared\.configure/.test(methodBodyContent) || 
            /Apptics\.initialize/.test(methodBodyContent)) {
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
        useManagerWrapper
      );
      content = content.replace(methodPattern, (match) => match + initCode);
    } else {
      const methodPattern = /- \(BOOL\)application:\(UIApplication \*\)application didFinishLaunchingWithOptions:[^{]+\{/;
      if (!methodPattern.test(content)) {
        throw new Error('Unable to locate application:didFinishLaunchingWithOptions: in the provided file');
      }
      const initCode = createObjcInitCode(includeAdvancedConfig && !!config, config, verbose);
      content = content.replace(methodPattern, (match) => match + initCode);
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
  useManagerWrapper: boolean
): string {
  const structMatch = content.match(/struct\s+\w+\s*:\s*App\s*\{/);
  if (!structMatch || structMatch.index === undefined) {
    throw new Error('SwiftUI App struct not found in the provided file');
  }

  const structStart = structMatch.index;
  const structOpenBrace = content.indexOf('{', structStart);
  if (structOpenBrace === -1) {
    throw new Error('Unable to parse SwiftUI App struct body');
  }

  const bodyIndex = content.indexOf('var body', structOpenBrace);
  if (bodyIndex === -1) {
    throw new Error('Could not locate SwiftUI App body to insert Apptics initialization');
  }

  const preBodySegment = content.slice(structOpenBrace + 1, bodyIndex);
  const initRegex = /init\s*\(\s*\)\s*\{/;
  const initCode = createSwiftInitCode(
    useAdvancedConfig,
    config,
    verbose,
    8,
    useManagerWrapper
  );

  if (initRegex.test(preBodySegment)) {
    const relativeInitIndex = preBodySegment.search(initRegex);
    const absoluteInitIndex = structOpenBrace + 1 + relativeInitIndex;
    const initBodyStart = content.indexOf('{', absoluteInitIndex);
    if (initBodyStart === -1) {
      throw new Error('Failed to locate SwiftUI init body');
    }
    
    const initBodyEnd = content.indexOf('}', initBodyStart);
    if (initBodyEnd !== -1) {
      const initBodyContent = content.slice(initBodyStart, initBodyEnd);
      if (/AppticsManager\.shared\.configure/.test(initBodyContent) || 
          /Apptics\.initialize/.test(initBodyContent)) {
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
  useManagerWrapper: boolean
): string {
  const indent = ' '.repeat(indentSize);
  const sendData = config?.sendDataOnMobileNetworkByDefault ?? true;
  const trackOn = config?.trackOnByDefault ?? true;
  const anonymousType = config?.anonymousType ?? 'pseudoAnonymous';

  if (useManagerWrapper) {
    if (useAdvancedConfig) {
      return `
${indent}// Configure Apptics via manager
${indent}AppticsManager.shared.configure(verbose: ${verbose}) { config in
${indent}    config.sendDataOnMobileNetworkByDefault = ${sendData}
${indent}    config.trackOnByDefault = ${trackOn}
${indent}    config.anonymousType = .${anonymousType}
${indent}}`;
    }

    return `
${indent}// Initialize Apptics via manager
${indent}AppticsManager.shared.configure(verbose: ${verbose})`;
  }

  if (useAdvancedConfig) {
    return `
${indent}// Configure Apptics SDK
${indent}AppticsConfig.default.sendDataOnMobileNetworkByDefault = ${sendData}
${indent}AppticsConfig.default.trackOnByDefault = ${trackOn}
${indent}AppticsConfig.default.anonymousType = .${anonymousType}

${indent}// Initialize Apptics
${indent}Apptics.initialize(withVerbose: ${verbose})`;
  }

  return `
${indent}// Initialize Apptics
${indent}Apptics.initialize(withVerbose: ${verbose})`;
}

function createObjcInitCode(
  useAdvancedConfig: boolean,
  config: AppticsInitConfig | undefined,
  verbose: boolean
): string {
  const sendData = config?.sendDataOnMobileNetworkByDefault ?? true;
  const trackOn = config?.trackOnByDefault ?? true;
  const anonymousType = config?.anonymousType ?? 'pseudoAnonymous';
  const anonType = anonymousType === 'nonAnonymous'
    ? 'APAnonymousTypeNonAnonymous'
    : 'APAnonymousTypePseudoAnonymous';

  if (useAdvancedConfig) {
    return `
    // Configure Apptics SDK
    AppticsConfig.defaultConfig.sendDataOnMobileNetworkByDefault = ${sendData ? 'YES' : 'NO'};
    AppticsConfig.defaultConfig.trackOnByDefault = ${trackOn ? 'YES' : 'NO'};
    AppticsConfig.defaultConfig.anonymousType = ${anonType};

    // Initialize Apptics
    [Apptics initializeWithVerbose:${verbose ? 'YES' : 'NO'}];`;
  }

  return `
    // Initialize Apptics
    [Apptics initializeWithVerbose:${verbose ? 'YES' : 'NO'}];`;
}

