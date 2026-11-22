import { afterEach, describe, expect, it } from 'vitest';
import { envClara } from './env-clara';
import { envValkade, legacyEnvKeys, setEnvValkade } from './env-valkade';

const SUFFIX = 'ENV_VALKADE_SPEC';
const KEYS = [`VALKADE_${SUFFIX}`, `CLARA_${SUFFIX}`, `NEMO_${SUFFIX}`];

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

describe('envValkade', () => {
  it('reads VALKADE_, then CLARA_, then NEMO_', () => {
    process.env[`NEMO_${SUFFIX}`] = 'nemo';
    expect(envValkade(SUFFIX)).toBe('nemo');
    process.env[`CLARA_${SUFFIX}`] = 'clara';
    expect(envValkade(SUFFIX)).toBe('clara');
    process.env[`VALKADE_${SUFFIX}`] = ' valkade ';
    expect(envValkade(SUFFIX)).toBe('valkade');
  });

  it('skips blank values and returns undefined when nothing is set', () => {
    expect(envValkade(SUFFIX)).toBeUndefined();
    process.env[`VALKADE_${SUFFIX}`] = '  ';
    process.env[`CLARA_${SUFFIX}`] = 'clara';
    expect(envValkade(SUFFIX)).toBe('clara');
  });

  it('keeps envClara as an alias', () => {
    process.env[`VALKADE_${SUFFIX}`] = 'valkade';
    expect(envClara(SUFFIX)).toBe('valkade');
  });
});

describe('setEnvValkade', () => {
  it('sets VALKADE_ and drops the legacy spellings', () => {
    process.env[`CLARA_${SUFFIX}`] = 'old';
    process.env[`NEMO_${SUFFIX}`] = 'older';
    setEnvValkade(SUFFIX, 'new');
    expect(KEYS.map((key) => process.env[key])).toEqual(['new', undefined, undefined]);
  });

  it('clears all three when the value is empty', () => {
    process.env[`VALKADE_${SUFFIX}`] = 'x';
    process.env[`CLARA_${SUFFIX}`] = 'y';
    setEnvValkade(SUFFIX, '');
    expect(envValkade(SUFFIX)).toBeUndefined();
  });

  it('lists the legacy keys', () => {
    expect(legacyEnvKeys(SUFFIX)).toEqual(KEYS.slice(1));
  });
});
