import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  AZURE_CREDENTIAL_VARS,
  AZURE_SIGNING,
  LEGACY_REQUIRE_SIGNING_VAR,
  REQUIRE_SIGNING_VAR,
  assertSigned,
  azureSigningArgs,
  signatureProblem,
} from './windows-signing.mjs';

const CREDENTIALS = { AZURE_TENANT_ID: 'tenant', AZURE_CLIENT_ID: 'client', AZURE_CLIENT_SECRET: 'secret' };
const SIGNED = { status: 'Valid', subject: 'CN=Daniel Perez, O=Daniel Perez, L=Springfield, S=fl, C=US' };

describe('azureSigningArgs', () => {
  it('leaves a build without credentials unsigned', () => {
    expect(azureSigningArgs({}, 'win32')).toEqual([]);
    expect(azureSigningArgs({ AZURE_CLIENT_SECRET: '  ' }, 'win32')).toEqual([]);
  });

  it('passes the signing identity when the credentials are set', () => {
    const args = azureSigningArgs(CREDENTIALS, 'win32');
    expect(args).toEqual([
      '--config.win.azureSignOptions.publisherName=Daniel Perez',
      '--config.win.azureSignOptions.endpoint=https://eus.codesigning.azure.net/',
      '--config.win.azureSignOptions.codeSigningAccountName=ClaraCoder',
      '--config.win.azureSignOptions.certificateProfileName=claracoder-public',
    ]);
    // The credentials stay in the environment: electron-builder's signer reads them there.
    expect(args.join(' ')).not.toMatch(/tenant|client|secret/);
    expect(Object.keys(AZURE_SIGNING)).toHaveLength(args.length);
  });

  it('signs Windows builds only', () => {
    expect(azureSigningArgs(CREDENTIALS, 'darwin')).toEqual([]);
    expect(azureSigningArgs({ [REQUIRE_SIGNING_VAR]: '1' }, 'linux')).toEqual([]);
  });

  it('refuses a half-configured build', () => {
    for (const name of AZURE_CREDENTIAL_VARS) {
      const env = { ...CREDENTIALS, [name]: '' };
      expect(() => azureSigningArgs(env, 'win32')).toThrow(name);
    }
  });

  it('refuses an unsigned build when a release requires signing (VALKADE_ and legacy CLARA_)', () => {
    expect(() => azureSigningArgs({ [REQUIRE_SIGNING_VAR]: '1' }, 'win32')).toThrow(/unsigned release/);
    expect(() => azureSigningArgs({ [LEGACY_REQUIRE_SIGNING_VAR]: '1' }, 'win32')).toThrow(/unsigned release/);
    expect(azureSigningArgs({ ...CREDENTIALS, [REQUIRE_SIGNING_VAR]: '1' }, 'win32')).toHaveLength(4);
  });
});

describe('signature check', () => {
  it('accepts a valid signature from the publisher', () => {
    expect(signatureProblem(SIGNED)).toBeNull();
  });

  it('names what is wrong with any other file', () => {
    expect(signatureProblem({ status: 'NotSigned', subject: null })).toMatch(/NotSigned/);
    expect(signatureProblem({ status: 'HashMismatch', subject: SIGNED.subject })).toMatch(/HashMismatch/);
    expect(signatureProblem({ status: 'Valid', subject: 'CN=Someone Else, O=Someone Else, C=US' })).toMatch(/Someone Else/);
    // A longer name that only starts the same is another publisher.
    expect(signatureProblem({ status: 'Valid', subject: 'CN=Daniel Perezoso, C=US' })).toMatch(/not Daniel Perez/);
  });

  it('checks every file and reports each failure', () => {
    const read = (file: string) => (file === 'app.exe' ? SIGNED : { status: 'NotSigned', subject: null });
    expect(() => assertSigned(['app.exe'], AZURE_SIGNING.publisherName, read)).not.toThrow();
    expect(() => assertSigned(['app.exe', 'setup.exe', 'other.exe'], AZURE_SIGNING.publisherName, read)).toThrow(
      /setup\.exe: signature is NotSigned\n\s+other\.exe/,
    );
    // Signing was on, so "nothing to check" is a failure too.
    expect(() => assertSigned([], AZURE_SIGNING.publisherName, read)).toThrow(/no file to check/);
  });
});

describe('what a signed build signs (win.signExts)', () => {
  const require = createRequire(import.meta.url);
  const root = path.join(__dirname, '..');
  const config = require('js-yaml').load(readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'));
  // electron-builder's own rule, on this repository's patterns.
  const { WinPackager } = require('app-builder-lib');
  const signs = (file: string): boolean =>
    WinPackager.prototype.shouldSignFile.call({ platformSpecificBuildOptions: { signExts: config.win.signExts } }, file, true);
  const unpacked = 'release/win-unpacked/';

  it('pins nsis.guid to the former Clara Coder appId UUIDv5 for in-place upgrades', () => {
    expect(config.appId).toBe('com.valkade.app');
    expect(config.productName).toBe('ValkAde');
    expect(config.nsis.guid).toBe('ffde8062-591c-5d75-b490-4c9f6467c205');
  });

  it("signs ValkAde's own programs", () => {
    expect(signs(`${unpacked}ValkAde.exe`)).toBe(true);
    expect(signs(`${unpacked}resources/elevate.exe`)).toBe(true);
    expect(signs('release/ValkAde-0.6.0-Windows-x64.exe')).toBe(true);
    expect(signs('release/ValkAde-0.6.0-Windows-x64.__uninstaller.exe')).toBe(true);
    expect(signs('release/ValkAde-1.0.0-beta.3-Windows-arm64.exe')).toBe(true);
  });

  it('leaves bundled programs as they came', () => {
    for (const file of [
      'resources/runtime-python/python.exe',
      'resources/runtime-python/pythonw.exe',
      'resources/runtime-python/Scripts/black.exe',
      'resources/runtime-python/Lib/site-packages/nodejs_wheel/node.exe',
      'resources/runtime-python/Lib/site-packages/pip/_vendor/distlib/t64.exe',
      'resources/ripgrep/rg.exe',
      'resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe',
      'resources/app.asar.unpacked/node_modules/node-pty/build/Release/winpty-agent.exe',
    ]) {
      expect(signs(unpacked + file), file).toBe(false);
    }
  });
});
