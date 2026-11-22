/**
 * Windows Electron ``safeStorage`` secret re-encryption for Clara Coder → ValkAde migration.
 *
 * On Windows, Chromium's ``os_crypt`` (backing ``electron.safeStorage``) stores a per-``userData``
 * 32-byte AES-256-GCM master key wrapped with Win32 DPAPI inside ``{userData}/Local State``
 * (``os_crypt.encrypted_key`` = ``base64("DPAPI" + CryptProtectData(key))``).
 *
 * Because the pre-boot migration window runs inside ValkAde's new ``userData`` profile (which has
 * its own ``Local State`` key), copied ``clara-secret:v1:...`` values in ``config.json`` and
 * ``secrets/anthropic-api-key.bin`` cannot be decrypted by the new profile's ``safeStorage`` until
 * they are unwrapped with the legacy profile's master key and re-encrypted with the active
 * profile's ``safeStorage.encryptString``.
 *
 * Everything happens in-process and in memory (zero subprocesses, zero temp plaintext, zero
 * secret logging). The legacy master key buffer is zeroed in ``finally``.
 */
import * as crypto from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import path = require('path');

const SECRET_DISK_PREFIX = 'clara-secret:v1:';
const ANTHROPIC_KEY_REL_PATH = path.join('secrets', 'anthropic-api-key.bin');
const DPAPI_PREFIX = Buffer.from('DPAPI', 'ascii');
const V10_PREFIX = Buffer.from('v10', 'ascii');
const AES_256_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const CRYPTPROTECT_UI_FORBIDDEN = 0x1;

export type MigrationSafeStorageLike = {
  isEncryptionAvailable: () => boolean;
  encryptString: (plain: string) => Buffer;
  decryptString: (blob: Buffer) => string;
};

export interface ReencryptSecretsOptions {
  /** Override platform check in tests (defaults to `process.platform`). */
  platform?: NodeJS.Platform;
  /** Override Electron safeStorage in tests. */
  safeStorage?: MigrationSafeStorageLike | null;
  /** Override Win32 CryptUnprotectData in tests. */
  dpapiUnprotect?: (encrypted: Buffer) => Buffer | null;
}

export interface ReencryptSecretsResult {
  configSecretsReencrypted: number;
  anthropicKeyReencrypted: boolean;
  skippedReason?: string;
}

let dpapiLoaded = false;
let cryptUnprotectDataFn:
  | ((
      dataIn: { cbData: number; pbData: Buffer },
      descr: null,
      entropy: null,
      reserved: null,
      prompt: null,
      flags: number,
      dataOut: Record<string, unknown>,
    ) => number)
  | null = null;
let localFreeFn: ((ptr: unknown) => unknown) | null = null;
let koffiModule: typeof import('koffi') | null = null;

function tryGetElectronSafeStorage(): MigrationSafeStorageLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { safeStorage?: MigrationSafeStorageLike };
    const ss = electron?.safeStorage;
    if (
      ss &&
      typeof ss.isEncryptionAvailable === 'function' &&
      typeof ss.encryptString === 'function' &&
      typeof ss.decryptString === 'function' &&
      ss.isEncryptionAvailable()
    ) {
      return ss;
    }
  } catch {
    /* non-Electron host */
  }
  return null;
}

function unprotectWindowsDpapi(encrypted: Buffer): Buffer | null {
  if (encrypted.length === 0) return null;
  try {
    if (!dpapiLoaded) {
      dpapiLoaded = true;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const koffi = require('koffi') as typeof import('koffi');
      koffiModule = koffi;
      const crypt32 = koffi.load('crypt32.dll');
      const kernel32 = koffi.load('kernel32.dll');
      const blobStruct = koffi.struct('VALKADE_DATA_BLOB', {
        cbData: 'uint32',
        pbData: 'void *',
      });
      cryptUnprotectDataFn = crypt32.func('CryptUnprotectData', 'int', [
        koffi.pointer(blobStruct),
        'void *',
        'void *',
        'void *',
        'void *',
        'uint32',
        koffi.out(koffi.pointer(blobStruct)),
      ]);
      localFreeFn = kernel32.func('LocalFree', 'void *', ['void *']);
    }
    if (!cryptUnprotectDataFn || !localFreeFn || !koffiModule) {
      return null;
    }
    const outBlob: { cbData?: number; pbData?: unknown } = {};
    const ok = cryptUnprotectDataFn(
      { cbData: encrypted.length, pbData: encrypted },
      null,
      null,
      null,
      null,
      CRYPTPROTECT_UI_FORBIDDEN,
      outBlob,
    );
    if (!ok || !outBlob.pbData || typeof outBlob.cbData !== 'number' || outBlob.cbData <= 0) {
      return null;
    }
    try {
      const bytes = koffiModule.decode(outBlob.pbData, 'uint8', outBlob.cbData) as Uint8Array;
      return Buffer.from(bytes);
    } finally {
      localFreeFn(outBlob.pbData);
    }
  } catch (err) {
    console.warn('[app-data] Windows DPAPI unwrap failed while migrating secrets:', err);
    return null;
  }
}

/**
 * Read and DPAPI-unwrap Chromium's 32-byte AES-256 master key from ``{legacyDir}/Local State``.
 * Caller MUST zero the returned Buffer in a ``finally`` block.
 */
export function readLegacyWindowsOsCryptKey(
  legacyDir: string,
  dpapiUnprotect: (encrypted: Buffer) => Buffer | null = unprotectWindowsDpapi,
): Buffer | null {
  const localStatePath = path.join(legacyDir, 'Local State');
  if (!existsSync(localStatePath)) {
    return null;
  }
  let encodedKey: string;
  try {
    const parsed = JSON.parse(readFileSync(localStatePath, 'utf-8')) as {
      os_crypt?: { encrypted_key?: unknown };
    };
    if (typeof parsed?.os_crypt?.encrypted_key !== 'string' || !parsed.os_crypt.encrypted_key) {
      return null;
    }
    encodedKey = parsed.os_crypt.encrypted_key;
  } catch {
    return null;
  }

  const raw = Buffer.from(encodedKey, 'base64');
  if (raw.length <= DPAPI_PREFIX.length || !raw.subarray(0, DPAPI_PREFIX.length).equals(DPAPI_PREFIX)) {
    return null;
  }

  const key = dpapiUnprotect(raw.subarray(DPAPI_PREFIX.length));
  if (!key || key.length !== AES_256_KEY_BYTES) {
    key?.fill(0);
    return null;
  }
  return key;
}

/** Decrypt a Chromium ``v10`` AES-256-GCM ``safeStorage`` payload using ``masterKey``. */
export function decryptWindowsV10Blob(blob: Buffer, masterKey: Buffer): string | null {
  const minLength = V10_PREFIX.length + GCM_NONCE_BYTES + GCM_TAG_BYTES;
  if (blob.length < minLength || !blob.subarray(0, V10_PREFIX.length).equals(V10_PREFIX)) {
    return null;
  }
  const nonceStart = V10_PREFIX.length;
  const ciphertextStart = nonceStart + GCM_NONCE_BYTES;
  const tagStart = blob.length - GCM_TAG_BYTES;

  const nonce = blob.subarray(nonceStart, ciphertextStart);
  const ciphertext = blob.subarray(ciphertextStart, tagStart);
  const authTag = blob.subarray(tagStart);

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, nonce);
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString('utf-8');
  } catch {
    return null;
  }
}

function reencryptSingleBlob(
  blob: Buffer,
  legacyMasterKey: Buffer,
  ss: MigrationSafeStorageLike,
): Buffer | null {
  // Already decryptable under the current profile — leave intact.
  try {
    ss.decryptString(blob);
    return null;
  } catch {
    /* expected when encrypted under the legacy profile's Local State key */
  }

  const plain = decryptWindowsV10Blob(blob, legacyMasterKey);
  if (plain === null) {
    return null;
  }
  try {
    return ss.encryptString(plain);
  } catch {
    return null;
  }
}

function walkAndReencryptConfigValue(
  value: unknown,
  legacyMasterKey: Buffer,
  ss: MigrationSafeStorageLike,
  stats: { count: number },
): unknown {
  if (typeof value === 'string') {
    if (!value.startsWith(SECRET_DISK_PREFIX)) {
      return value;
    }
    const rawBlob = Buffer.from(value.slice(SECRET_DISK_PREFIX.length), 'base64');
    const nextBlob = reencryptSingleBlob(rawBlob, legacyMasterKey, ss);
    if (!nextBlob) {
      return value;
    }
    stats.count += 1;
    return `${SECRET_DISK_PREFIX}${nextBlob.toString('base64')}`;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const updated = walkAndReencryptConfigValue(item, legacyMasterKey, ss, stats);
      if (updated !== item) changed = true;
      return updated;
    });
    return changed ? next : value;
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    let next: Record<string, unknown> | null = null;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const updated = walkAndReencryptConfigValue(v, legacyMasterKey, ss, stats);
      if (updated !== v) {
        next ??= { ...(value as Record<string, unknown>) };
        next[k] = updated;
      }
    }
    return next ?? value;
  }
  return value;
}

/**
 * Re-encrypt migrated ``config.json`` secrets (``clara-secret:v1:...``) and
 * ``secrets/anthropic-api-key.bin`` from ``legacyDir``'s Windows ``Local State`` key
 * into the active ValkAde ``safeStorage`` key. Never throws; never logs secret values.
 */
export function reencryptMigratedWindowsSecrets(
  legacyDir: string,
  targetDir: string,
  options?: ReencryptSecretsOptions,
): ReencryptSecretsResult {
  const platform = options?.platform ?? process.platform;
  if (platform !== 'win32') {
    return {
      configSecretsReencrypted: 0,
      anthropicKeyReencrypted: false,
      skippedReason: 'non-windows',
    };
  }

  const ss = options?.safeStorage !== undefined ? options.safeStorage : tryGetElectronSafeStorage();
  if (!ss || !ss.isEncryptionAvailable()) {
    return {
      configSecretsReencrypted: 0,
      anthropicKeyReencrypted: false,
      skippedReason: 'safe-storage-unavailable',
    };
  }

  const legacyMasterKey = readLegacyWindowsOsCryptKey(legacyDir, options?.dpapiUnprotect);
  if (!legacyMasterKey) {
    return {
      configSecretsReencrypted: 0,
      anthropicKeyReencrypted: false,
      skippedReason: 'legacy-key-unavailable',
    };
  }

  const stats = { count: 0 };
  let anthropicKeyReencrypted = false;

  try {
    const configPath = path.join(targetDir, 'config.json');
    if (existsSync(configPath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf-8'));
        const updated = walkAndReencryptConfigValue(parsed, legacyMasterKey, ss, stats);
        if (updated !== parsed && stats.count > 0) {
          writeFileSync(configPath, JSON.stringify(updated, null, 2), 'utf-8');
        }
      } catch (err) {
        console.warn('[app-data] Could not re-encrypt migrated config.json secrets:', err);
      }
    }

    const anthropicKeyPath = path.join(targetDir, ANTHROPIC_KEY_REL_PATH);
    if (existsSync(anthropicKeyPath)) {
      try {
        const rawBlob = readFileSync(anthropicKeyPath);
        const nextBlob = reencryptSingleBlob(rawBlob, legacyMasterKey, ss);
        if (nextBlob) {
          writeFileSync(anthropicKeyPath, nextBlob, { mode: 0o600 });
          anthropicKeyReencrypted = true;
        }
      } catch (err) {
        console.warn('[app-data] Could not re-encrypt migrated Claude API key:', err);
      }
    }
  } finally {
    legacyMasterKey.fill(0);
  }

  const total = stats.count + (anthropicKeyReencrypted ? 1 : 0);
  if (total > 0) {
    console.log(`[app-data] Re-encrypted ${total} migrated secret(s) for ValkAde.`);
  }

  return {
    configSecretsReencrypted: stats.count,
    anthropicKeyReencrypted,
  };
}
