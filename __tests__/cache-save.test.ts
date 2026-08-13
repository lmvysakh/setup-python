import {jest, describe, it, expect, beforeEach, afterEach} from '@jest/globals';
import {fileURLToPath} from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mock @actions modules before importing anything that depends on them
jest.unstable_mockModule('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  notice: jest.fn(),
  setFailed: jest.fn(),
  setOutput: jest.fn(),
  getInput: jest.fn(),
  getBooleanInput: jest.fn(),
  getMultilineInput: jest.fn(),
  addPath: jest.fn(),
  exportVariable: jest.fn(),
  saveState: jest.fn(),
  getState: jest.fn(),
  setSecret: jest.fn(),
  isDebug: jest.fn(() => false),
  startGroup: jest.fn(),
  endGroup: jest.fn(),
  group: jest.fn((_name: string, fn: () => Promise<unknown>) => fn()),
  toPlatformPath: jest.fn((p: string) => p),
  toWin32Path: jest.fn((p: string) => p),
  toPosixPath: jest.fn((p: string) => p)
}));

class MockValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

jest.unstable_mockModule('@actions/cache', () => ({
  saveCache: jest.fn(),
  restoreCache: jest.fn(),
  isFeatureAvailable: jest.fn(),
  ValidationError: MockValidationError,
  ReserveCacheError: MockValidationError
}));

jest.unstable_mockModule('@actions/exec', () => ({
  exec: jest.fn(),
  getExecOutput: jest.fn()
}));

// Dynamic imports after mocking
const core = await import('@actions/core');
const cache = await import('@actions/cache');
const exec = await import('@actions/exec');
const {run} = await import('../src/cache-save.js');
const {State} = await import('../src/cache-distributions/cache-distributor.js');

describe('run', () => {
  const pipFileLockHash =
    'd1dd6218299d8a6db5fc2001d988b34a8b31f1e9d0bb4534d377dde7c19f64b3';
  const requirementsHash =
    'd8110e0006d7fb5ee76365d565eef9d37df1d11598b912d3eb66d398d57a1121';
  const requirementsLinuxHash =
    '2d0ff7f46b0e120e3d3294db65768b474934242637b9899b873e6283dfd16d7c';
  const poetryLockHash =
    '571bf984f8d210e6a97f854e479fdd4a2b5af67b5fdac109ec337a0ea16e7836';

  let infoSpy: jest.Mock;
  let warningSpy: jest.Mock;
  let debugSpy: jest.Mock;
  let saveStateSpy: jest.Mock;
  let getStateSpy: jest.Mock;
  let setFailedSpy: jest.Mock;
  let saveCacheSpy: jest.Mock;
  let getExecOutputSpy: jest.Mock;

  function setInput(name: string, value: string): void {
    process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] = value;
  }

  beforeEach(() => {
    process.env['RUNNER_OS'] = process.env['RUNNER_OS'] ?? 'linux';
    for (const key in process.env) {
      if (key.startsWith('INPUT_')) {
        delete process.env[key];
      }
    }

    infoSpy = core.info as jest.Mock;
    infoSpy.mockImplementation(() => undefined);

    warningSpy = core.warning as jest.Mock;
    warningSpy.mockImplementation(() => undefined);

    debugSpy = core.debug as jest.Mock;
    debugSpy.mockImplementation(() => undefined);

    saveStateSpy = core.saveState as jest.Mock;
    saveStateSpy.mockImplementation(() => undefined);

    getStateSpy = core.getState as jest.Mock;
    (getStateSpy as jest.Mock<typeof core.getState>).mockImplementation(
      (input: string) => {
        if (input === State.CACHE_PATHS) {
          return JSON.stringify([__dirname]);
        }
        return requirementsHash;
      }
    );

    setFailedSpy = core.setFailed as jest.Mock;

    getExecOutputSpy = exec.getExecOutput as jest.Mock;
    (
      getExecOutputSpy as jest.Mock<typeof exec.getExecOutput>
    ).mockImplementation(async (input: string) => {
      if (input.includes('pip')) {
        return {stdout: 'pip', stderr: '', exitCode: 0};
      }

      return {stdout: '', stderr: 'Error occured', exitCode: 2};
    });

    saveCacheSpy = cache.saveCache as jest.Mock;
    saveCacheSpy.mockImplementation(() => undefined);
  });

  describe('Package manager validation', () => {
    it('Package manager is not provided, skip caching', async () => {
      setInput('cache', '');
      await run();

      expect(infoSpy).not.toHaveBeenCalled();
      expect(saveCacheSpy).not.toHaveBeenCalled();
      expect(setFailedSpy).not.toHaveBeenCalled();
    });
  });

  describe('Validate unchanged cache is not saved', () => {
    it('should not save cache for pip', async () => {
      setInput('cache', 'pip');
      setInput('python-version', '3.10.0');

      await run();

      expect(debugSpy).toHaveBeenCalledWith(
        `paths for caching are ${__dirname}`
      );
      expect(getStateSpy).toHaveBeenCalledTimes(3);
      expect(infoSpy).toHaveBeenCalledWith(
        `Cache hit occurred on the primary key ${requirementsHash}, not saving cache.`
      );
      expect(setFailedSpy).not.toHaveBeenCalled();
    });

    it('should not save cache for pipenv', async () => {
      setInput('cache', 'pipenv');
      setInput('python-version', '3.10.0');

      await run();

      expect(debugSpy).toHaveBeenCalledWith(
        `paths for caching are ${__dirname}`
      );
      expect(getStateSpy).toHaveBeenCalledTimes(3);
      expect(infoSpy).toHaveBeenCalledWith(
        `Cache hit occurred on the primary key ${requirementsHash}, not saving cache.`
      );
      expect(setFailedSpy).not.toHaveBeenCalled();
    });
  });

  describe('action saves the cache', () => {
    it('saves cache from pip', async () => {
      setInput('cache', 'pip');
      setInput('python-version', '3.10.0');
      (getStateSpy as jest.Mock<typeof core.getState>).mockImplementation(
        (name: string) => {
          if (name === State.CACHE_MATCHED_KEY) {
            return requirementsHash;
          } else if (name === State.CACHE_PATHS) {
            return JSON.stringify([__dirname]);
          } else {
            return pipFileLockHash;
          }
        }
      );

      await run();

      expect(getStateSpy).toHaveBeenCalledTimes(3);
      expect(infoSpy).not.toHaveBeenCalledWith(
        `Cache hit occurred on the primary key ${requirementsHash}, not saving cache.`
      );
      expect(saveCacheSpy).toHaveBeenCalled();
      expect(infoSpy).toHaveBeenLastCalledWith(
        `Cache saved with the key: ${pipFileLockHash}`
      );
      expect(setFailedSpy).not.toHaveBeenCalled();
    });

    it('saves cache from pipenv', async () => {
      setInput('cache', 'pipenv');
      setInput('python-version', '3.10.0');
      (getStateSpy as jest.Mock<typeof core.getState>).mockImplementation(
        (name: string) => {
          if (name === State.CACHE_MATCHED_KEY) {
            return pipFileLockHash;
          } else if (name === State.CACHE_PATHS) {
            return JSON.stringify([__dirname]);
          } else {
            return requirementsHash;
          }
        }
      );

      await run();

      expect(getStateSpy).toHaveBeenCalledTimes(3);
      expect(infoSpy).not.toHaveBeenCalledWith(
        `Cache hit occurred on the primary key ${pipFileLockHash}, not saving cache.`
      );
      expect(saveCacheSpy).toHaveBeenCalled();
      expect(infoSpy).toHaveBeenLastCalledWith(
        `Cache saved with the key: ${requirementsHash}`
      );
      expect(setFailedSpy).not.toHaveBeenCalled();
    });

    it('saves cache from poetry', async () => {
      setInput('cache', 'poetry');
      setInput('python-version', '3.10.0');
      (getStateSpy as jest.Mock<typeof core.getState>).mockImplementation(
        (name: string) => {
          if (name === State.CACHE_MATCHED_KEY) {
            return poetryLockHash;
          } else if (name === State.CACHE_PATHS) {
            return JSON.stringify([__dirname]);
          } else {
            return requirementsHash;
          }
        }
      );

      await run();

      expect(getStateSpy).toHaveBeenCalledTimes(3);
      expect(infoSpy).not.toHaveBeenCalledWith(
        `Cache hit occurred on the primary key ${poetryLockHash}, not saving cache.`
      );
      expect(saveCacheSpy).toHaveBeenCalled();
      expect(infoSpy).toHaveBeenLastCalledWith(
        `Cache saved with the key: ${requirementsHash}`
      );
      expect(setFailedSpy).not.toHaveBeenCalled();
    });

    it('saves with -1 cacheId , should not fail workflow', async () => {
      setInput('cache', 'poetry');
      setInput('python-version', '3.10.0');
      (getStateSpy as jest.Mock<typeof core.getState>).mockImplementation(
        (name: string) => {
          if (name === State.STATE_CACHE_PRIMARY_KEY) {
            return poetryLockHash;
          } else if (name === State.CACHE_PATHS) {
            return JSON.stringify([__dirname]);
          } else {
            return requirementsHash;
          }
        }
      );

      saveCacheSpy.mockImplementation(() => {
        return -1;
      });

      await run();

      expect(getStateSpy).toHaveBeenCalledTimes(3);
      expect(infoSpy).not.toHaveBeenCalled();
      expect(saveCacheSpy).toHaveBeenCalled();
      expect(infoSpy).not.toHaveBeenLastCalledWith(
        `Cache saved with the key: ${poetryLockHash}`
      );
      expect(setFailedSpy).not.toHaveBeenCalled();
    });

    it('saves with error from toolkit, should not fail the workflow', async () => {
      setInput('cache', 'npm');
      setInput('python-version', '3.10.0');
      (getStateSpy as jest.Mock<typeof core.getState>).mockImplementation(
        (name: string) => {
          if (name === State.STATE_CACHE_PRIMARY_KEY) {
            return poetryLockHash;
          } else if (name === State.CACHE_PATHS) {
            return JSON.stringify([__dirname]);
          } else {
            return requirementsHash;
          }
        }
      );

      saveCacheSpy.mockImplementation(() => {
        throw new cache.ValidationError('Validation failed');
      });

      await run();

      expect(getStateSpy).toHaveBeenCalledTimes(3);
      expect(infoSpy).not.toHaveBeenCalledWith();
      expect(saveCacheSpy).toHaveBeenCalled();
      expect(setFailedSpy).not.toHaveBeenCalled();
    });

    it('should not save the cache when requested not to', async () => {
      setInput('cache', 'pip');
      setInput('cache-save', 'false');
      setInput('python-version', '3.10.0');
      await run();
      expect(infoSpy).toHaveBeenCalledWith(
        'Not saving cache since `cache-save` is false'
      );
      expect(saveCacheSpy).not.toHaveBeenCalled();
      expect(setFailedSpy).not.toHaveBeenCalled();
    });
  });

  afterEach(() => {
    jest.resetAllMocks();
    jest.clearAllMocks();
  });
});
