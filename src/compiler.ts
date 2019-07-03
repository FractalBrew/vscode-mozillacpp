/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ProcessResult, exec, CmdArgs } from './exec';
import { log } from './logging';
import { Path, Disposable, StateProvider, splitCmdLine } from './shared';
import { config } from './config';

type VERSIONS = 'c89' | 'c99' | 'c11' | 'c++98' | 'c++03' | 'c++11' | 'c++14' | 'c++17';
type INTELLISENSE_MODES = 'msvc-x64' | 'gcc-x64' | 'clang-x64';

const FRAMEWORK_MARKER: string = ' (framework directory)';

const CPP_STANDARD: VERSIONS = 'c++14';
const CPP_VERSION: string = CPP_STANDARD;
const C_STANDARD: VERSIONS = 'c99';
const C_VERSION: string = 'gnu99';

export enum FileType {
  C = 'c',
  CPP = 'cpp',
}

export interface Define {
  key: string;
  value: string;
}

function buildDefine(text: string, splitter: string): Define {
  let pos: number = text.indexOf(splitter);
  if (pos >= 0) {
    return {
      key: text.substring(0, pos),
      value: text.substring(pos + 1),
    };
  }

  return {
    key: text,
    value: '1',
  };
}

export interface CompileConfig {
  includes: Set<string>;
  defines: Map<string, Define>;
  forcedIncludes: Set<string>;
  intelliSenseMode: INTELLISENSE_MODES;
  standard: VERSIONS;
}

function cloneConfig(config: CompileConfig): CompileConfig {
  return {
    includes: new Set(config.includes),
    defines: new Map(config.defines),
    forcedIncludes: new Set(config.forcedIncludes),
    intelliSenseMode: config.intelliSenseMode,
    standard: config.standard,
  };
}

function addCompilerArgumentsToConfig(cmdLine: string|undefined, forceIncludeArg: string, config: CompileConfig): void {
  if (!cmdLine) {
    return;
  }

  let args: string[] = splitCmdLine(cmdLine);
  let arg: string|undefined;
  while (arg = args.shift()) {
    if (arg.length < 2 || (arg.charAt(0) !== '-' && arg.charAt(0) !== '/')) {
      continue;
    }

    switch (arg.charAt(1)) {
      case 'D':
        let define: Define = buildDefine(arg.substring(2), '=');
        config.defines.set(define.key, define);
        continue;
      case 'I':
        config.includes.add(arg.substring(2));
        continue;
    }

    if (arg === forceIncludeArg) {
      let include: string|undefined = args.shift();
      if (include) {
        config.forcedIncludes.add(include);
      }
      continue;
    }
  }
}

export abstract class Compiler implements Disposable, StateProvider {
  protected srcdir: Path;
  protected command: CmdArgs;
  protected type: FileType;
  protected defaults: CompileConfig;

  protected constructor(srcdir: Path, command: CmdArgs, type: FileType, defaults: CompileConfig) {
    this.srcdir = srcdir;
    this.command = command;
    this.type = type;
    this.defaults = defaults;
  }

  public dispose(): void {
  }

  public async toState(): Promise<any> {
    return {
      type: this.type,
      command: this.command,
      override: await config.getCompiler(this.srcdir.toUri(), this.type),
      includes: this.defaults.includes.size,
      defines: this.defaults.defines.size,
    };
  }

  public static async create(srcdir: Path, command: CmdArgs, type: FileType, config: Map<string, string>): Promise<Compiler> {
    let compilerType: string|undefined = config.get('CC_TYPE');
    if (!compilerType) {
      throw new Error('Unable to determine compiler types.');
    }

    switch (compilerType) {
      case 'clang':
        return ClangCompiler.fetch(srcdir, command, type, config);
      case 'clang-cl':
      case 'msvc':
        return MsvcCompiler.fetch(srcdir, command, type, compilerType);
      default:
        throw new Error(`Unknown compiler type ${compilerType}.`);
    }
  }

  protected async getCommand(): Promise<CmdArgs> {
    return (await config.getCompiler(this.srcdir.toUri(), this.type)) || this.command.slice(0);
  }

  public getDefaultConfiguration(): CompileConfig {
    return cloneConfig(this.defaults);
  }

  public getIncludePaths(): Set<string> {
    return new Set(this.defaults.includes);
  }

  public abstract addCompilerArgumentsToConfig(cmdLine: string|undefined, config: CompileConfig): void;
}

class ClangCompiler extends Compiler {
  public dispose(): void {
    super.dispose();
  }

  public async toState(): Promise<any> {
    let state: any = await super.toState();
    state.type = 'clang';
    return state;
  }

  private static parseCompilerDefaults(output: string, defaults: CompileConfig): void {
    let lines: string[] = output.trim().split('\n');

    let inIncludes: boolean = false;
    for (let line of lines) {
      if (inIncludes) {
        if (line.charAt(0) === ' ') {
          let include: string = line.trim();
          if (include.endsWith(FRAMEWORK_MARKER)) {
            defaults.includes.add(include.substring(0, include.length - FRAMEWORK_MARKER.length));
          } else {
            defaults.includes.add(include);
          }
          continue;
        } else {
          inIncludes = false;
        }
      }

      if (line.startsWith('#include ')) {
        inIncludes = true;
      } else if (line.startsWith('#define ')) {
        let define: Define = buildDefine(line.substring(8).trim(), ' ');
        defaults.defines.set(define.key, define);
      }
    }
  }

  public static async fetch(srcdir: Path, command: CmdArgs, type: FileType, buildConfig: Map<string, string>): Promise<Compiler> {
    let sdk: string|undefined = undefined;
    if (process.platform === 'darwin') {
      sdk = buildConfig.get('MACOS_SDK_DIR');
    }

    let defaultCmd: CmdArgs = (await config.getCompiler(srcdir.toUri(), type)) || command.slice(0);

    switch (type) {
      case FileType.CPP:
        defaultCmd.push(`-std=${CPP_VERSION}`, '-xc++');
        break;
      case FileType.C:
        defaultCmd.push(`-std=${C_VERSION}`, '-xc');
        break;
    }

    if (sdk) {
      if (process.platform === 'darwin') {
        defaultCmd.push('-isysroot', sdk);
      }
    }

    defaultCmd.push('-Wp,-v', '-E', '-dD', '/dev/null');

    try {
      let result: ProcessResult = await exec(defaultCmd);

      let defaults: CompileConfig = {
        includes: new Set(),
        defines: new Map(),
        forcedIncludes: new Set(),
        intelliSenseMode: 'clang-x64' as INTELLISENSE_MODES,
        standard: type === FileType.C ? C_STANDARD : CPP_STANDARD,
      };

      ClangCompiler.parseCompilerDefaults(result.stdout, defaults);
      ClangCompiler.parseCompilerDefaults(result.stderr, defaults);

      if (defaults.includes.size === 0 || defaults.defines.size === 0) {
        throw new Error('Compiler returned empty includes or defined.');
      }

      return new ClangCompiler(srcdir, command, type, defaults);
    } catch (e) {
      log.error('Failed to get compiler defaults', e);
      throw e;
    }
  }

  public addCompilerArgumentsToConfig(cmdLine: string|undefined, config: CompileConfig): void {
    addCompilerArgumentsToConfig(cmdLine, '-include', config);
  }
}

class MsvcCompiler extends Compiler {
  public dispose(): void {
    super.dispose();
  }

  public async toState(): Promise<any> {
    let state: any = await super.toState();
    state.type = 'clang';
    return state;
  }

  public static async fetch(srcdir: Path, command: CmdArgs, type: FileType, compilerType: string): Promise<Compiler> {
    let defaults: CompileConfig = {
      includes: new Set(),
      defines: new Map(),
      forcedIncludes: new Set(),
      intelliSenseMode: compilerType === 'msvc' ? 'msvc-x64' : 'clang-x64' as INTELLISENSE_MODES,
      standard: type === FileType.C ? C_STANDARD : CPP_STANDARD,
    };

    if (defaults.includes.size === 0 || defaults.defines.size === 0) {
      throw new Error('Compiler returned empty includes or defined.');
    }

    return new MsvcCompiler(srcdir, command, type, defaults);
  }

  public addCompilerArgumentsToConfig(cmdLine: string|undefined, config: CompileConfig): void {
    addCompilerArgumentsToConfig(cmdLine, '-FI', config);
  }
}