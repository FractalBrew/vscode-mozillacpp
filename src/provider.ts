/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as cpptools from 'vscode-cpptools';
import * as vscode from 'vscode';

import { SourceFolder } from './folders';
import { Workspace } from './workspace';
import { logItem, log } from './logging';
import { Disposable } from './shared';
import { config } from './config';

export class MachConfigurationProvider implements cpptools.CustomConfigurationProvider, Disposable {
  private api: cpptools.CppToolsApi;
  private workspace: Workspace;

  public name: string = 'Mozilla';
  public extensionId: string = 'fractalbrew.mozillacpp';

  public static async create(workspace: Workspace): Promise<MachConfigurationProvider|null> {
    let api: cpptools.CppToolsApi|undefined = await cpptools.getCppToolsApi(cpptools.Version.v2);
    if (api) {
      return new MachConfigurationProvider(api, workspace);
    }
    return null;
  }

  private constructor(api: cpptools.CppToolsApi, workspace: Workspace) {
    this.api = api;
    this.workspace = workspace;

    if (api.notifyReady) {
      // Inform cpptools that a custom config provider will be able to service the current workspace.
      api.registerCustomConfigurationProvider(this);

      // Notify cpptools that the provider is ready to provide IntelliSense configurations.
      api.notifyReady(this);
    } else {
      // Running on a version of cpptools that doesn't support v2 yet.

      // Inform cpptools that a custom config provider will be able to service the current workspace.
      api.registerCustomConfigurationProvider(this);
      api.didChangeCustomConfiguration(this);
    }
  }

  private showError(message: string): void {
    vscode.window.showErrorMessage(message);
  }

  public resetConfiguration(): void {
    this.api.didChangeCustomConfiguration(this);
  }

  public resetBrowseConfiguration(): void {
    this.api.didChangeCustomBrowseConfiguration(this);
  }

  public async canProvideConfiguration(uri: vscode.Uri): Promise<boolean> {
    try {
      let folder: SourceFolder|undefined = await this.workspace.getFolder(uri);
      return folder !== undefined && folder.isMozillaSource();
    } catch (e) {
      log.error('Failed to canProvildeConfiguration.', e);
      return false;
    }
  }

  public async provideConfigurations(uris: vscode.Uri[]): Promise<cpptools.SourceFileConfigurationItem[]> {
    let results: (undefined|cpptools.SourceFileConfigurationItem)[] = await Promise.all(uris.map(async (uri) => {
      try {
        let folder: SourceFolder|undefined = await this.workspace.getFolder(uri);
        if (!folder || !await folder.isMozillaSource()) {
          log.warn(`Asked for a configuration for a non-Mozilla file: ${uri.fsPath}`);
          return undefined;
        }

        let config: cpptools.SourceFileConfiguration|undefined = await folder.getSourceConfiguration(uri);
        if (config === undefined) {
          log.warn(`Unable to find configuration for ${uri.fsPath}.`);
          return undefined;
        }

        // Silly TypeScript!
        let realConfig: cpptools.SourceFileConfiguration = config;
        log.debug(`Returning configuration for ${uri.fsPath}.`, logItem(() => {
          return {
            includePath: realConfig.includePath,
            defines: `${realConfig.defines.length} defines`,
            intelliSenseMode: realConfig.intelliSenseMode,
            standard: realConfig.standard,
            forcedInclude: realConfig.forcedInclude,
            compilerPath: realConfig.compilerPath,
            windowsSdkVersion: realConfig.windowsSdkVersion,
          };
        }, config));

        return {
          uri: uri,
          configuration: config,
        };
      } catch (e) {
        log.error('Failed to generate configuration.', e);
        return undefined;
      }
    }));

    function hasConfig(item: cpptools.SourceFileConfigurationItem|undefined): item is cpptools.SourceFileConfigurationItem {
      return item !== undefined;
    }

    return results.filter(hasConfig);
  }

  public async canProvideBrowseConfiguration(): Promise<boolean> {
    try {
      return this.workspace.canProvideConfig();
    } catch (e) {
      log.error('Failed to canProvideBrowseConfiguration.', e);
      return false;
    }
  }

  public async provideBrowseConfiguration(): Promise<cpptools.WorkspaceBrowseConfiguration> {
    if (config.isTagParsingDisable()) {
      log.debug('Disabling browse path.');
      return {
        browsePath: [],
      };
    }

    try {
      let folders: SourceFolder[] = await this.workspace.getMozillaFolders();

      let browsePath: Set<string> = new Set();

      for (let folder of folders) {
        for (let path of folder.getIncludePaths()) {
          browsePath.add(path);
        }
      }

      let config: cpptools.WorkspaceBrowseConfiguration = {
        browsePath: Array.from(browsePath),
      };

      log.debug('Returning browse configuration.', config);
      return config;
    } catch (e) {
      log.error('Failed to provideBrowseConfiguration.', e);
      throw(e);
    }
  }

  public dispose(): void {
    this.api.dispose();
  }
}