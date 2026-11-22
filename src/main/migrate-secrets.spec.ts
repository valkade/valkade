import * as crypto from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path = require('path');
import { afterEach, describe, expect, it } from 'vitest';
import {
  decryptWindowsV10Blob,
  readLegacyWindowsOsCryptKey,
  reencryptMigratedWindowsSecrets,
  type MigrationSafeStorageLike,
} from './migrate-secrets';

function encryptV10(plain: string, key: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from('v10', 'ascii'), iv, ct, tag]);
}

function makeFakeSafeStorage(key: Buffer): MigrationSafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => encryptV10(plain, key),
    decryptString: (blob: Buffer) => {
      const dec = decryptWindowsV10Blob(blob, key);
      if (dec === null) {
        throw new Error('Decryption failed');
      }
      return dec;
    },
  };
}

describe('migrate-secrets (Windows safeStorage re-encryption)', () => {
  let root: string;

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function setupDirs(): { legacyDir: string; targetDir: string } {
    root = mkdtempSync(path.join(tmpdir(), 'valkade-migrate-secrets-'));
    const legacyDir = path.join(root, 'clara-coder');
    const targetDir = path.join(root, 'valkade');
    mkdirSync(path.join(targetDir, 'secrets'), { recursive: true });
    mkdirSync(legacyDir, { recursive: true });
    return { legacyDir, targetDir };
  }

  it('unwraps legacy Local State DPAPI key and re-encrypts config.json + anthropic-api-key.bin into the new profile key', () => {
    const { legacyDir, targetDir } = setupDirs();
    const oldKey = crypto.randomBytes(32);
    const newKey = crypto.randomBytes(32);
    const newSafeStorage = makeFakeSafeStorage(newKey);

    // Legacy Local State stores base64("DPAPI" + dpapiBlob)
    const fakeDpapiBlob = Buffer.concat([Buffer.from('WRAPPED:'), oldKey]);
    const localState = {
      os_crypt: {
        encrypted_key: Buffer.concat([Buffer.from('DPAPI', 'ascii'), fakeDpapiBlob]).toString('base64'),
      },
    };
    writeFileSync(path.join(legacyDir, 'Local State'), JSON.stringify(localState), 'utf-8');

    const dpapiUnprotect = (enc: Buffer): Buffer | null =>
      enc.subarray(0, 8).toString('utf8') === 'WRAPPED:' ? Buffer.from(enc.subarray(8)) : null;

    const oldOpenRouter = `clara-secret:v1:${encryptV10('sk-or-secret-123', oldKey).toString('base64')}`;
    const oldHfToken = `clara-secret:v1:${encryptV10('hf_token_abc', oldKey).toString('base64')}`;
    const oldMcpHeader = `clara-secret:v1:${encryptV10('Bearer xyz-999', oldKey).toString('base64')}`;
    const alreadyNew = `clara-secret:v1:${encryptV10('already-new-key', newKey).toString('base64')}`;

    writeFileSync(
      path.join(targetDir, 'config.json'),
      JSON.stringify(
        {
          llmProviders: [
            { id: 'openrouter', apiKey: oldOpenRouter },
            { id: 'custom', apiKey: alreadyNew },
          ],
          modelManager: { huggingFaceToken: oldHfToken },
          mcpServers: [{ id: 's1', headers: { Authorization: oldMcpHeader } }],
          plainSetting: 'untouched',
        },
        null,
        2,
      ),
      'utf-8',
    );
    writeFileSync(
      path.join(targetDir, 'secrets', 'anthropic-api-key.bin'),
      encryptV10('sk-ant-api03-test-key', oldKey),
    );

    const res = reencryptMigratedWindowsSecrets(legacyDir, targetDir, {
      platform: 'win32',
      safeStorage: newSafeStorage,
      dpapiUnprotect,
    });

    expect(res).toEqual({
      configSecretsReencrypted: 3,
      anthropicKeyReencrypted: true,
    });

    // Every config secret is now decryptable by the NEW profile safeStorage.
    const nextCfg = JSON.parse(readFileSync(path.join(targetDir, 'config.json'), 'utf-8'));
    const dec = (s: string) =>
      newSafeStorage.decryptString(Buffer.from(s.slice('clara-secret:v1:'.length), 'base64'));
    expect(dec(nextCfg.llmProviders[0].apiKey)).toBe('sk-or-secret-123');
    expect(dec(nextCfg.llmProviders[1].apiKey)).toBe('already-new-key');
    expect(dec(nextCfg.modelManager.huggingFaceToken)).toBe('hf_token_abc');
    expect(dec(nextCfg.mcpServers[0].headers.Authorization)).toBe('Bearer xyz-999');
    expect(nextCfg.plainSetting).toBe('untouched');

    // Anthropic key file is also decryptable by the NEW profile safeStorage.
    const nextBin = readFileSync(path.join(targetDir, 'secrets', 'anthropic-api-key.bin'));
    expect(newSafeStorage.decryptString(nextBin)).toBe('sk-ant-api03-test-key');
  });

  it('skips cleanly on non-Windows platforms', () => {
    const { legacyDir, targetDir } = setupDirs();
    const res = reencryptMigratedWindowsSecrets(legacyDir, targetDir, {
      platform: 'linux',
      safeStorage: makeFakeSafeStorage(crypto.randomBytes(32)),
    });
    expect(res).toEqual({
      configSecretsReencrypted: 0,
      anthropicKeyReencrypted: false,
      skippedReason: 'non-windows',
    });
  });

  it('returns null safely when legacy Local State is missing or malformed', () => {
    const { legacyDir } = setupDirs();
    expect(readLegacyWindowsOsCryptKey(legacyDir, () => crypto.randomBytes(32))).toBeNull();

    writeFileSync(path.join(legacyDir, 'Local State'), '{not-json', 'utf-8');
    expect(readLegacyWindowsOsCryptKey(legacyDir, () => crypto.randomBytes(32))).toBeNull();

    writeFileSync(
      path.join(legacyDir, 'Local State'),
      JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('WRONG_PREFIX').toString('base64') } }),
      'utf-8',
    );
    expect(readLegacyWindowsOsCryptKey(legacyDir, () => crypto.randomBytes(32))).toBeNull();
  });
});
