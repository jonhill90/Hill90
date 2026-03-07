import { ensureRequiredToolsInstalled, reconcileToolInstalls, binaryInstallScript, validateDownloadUrl } from '../services/tool-installer';

const mockQuery = jest.fn();
const mockExec = jest.fn();
const mockExecStdin = jest.fn();
const mockFetch = jest.fn();

// Save original fetch
const originalFetch = global.fetch;

jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery }),
}));

jest.mock('../services/docker', () => ({
  execInContainerWithExit: (...args: any[]) => mockExec(...args),
  execWithStdin: (...args: any[]) => mockExecStdin(...args),
}));

function mockFetchResponse(status: number, body?: ArrayBuffer, headers?: Record<string, string>) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers || {}),
    arrayBuffer: () => Promise.resolve(body || new ArrayBuffer(0)),
  };
}

describe('tool-installer service', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockExec.mockReset();
    mockExecStdin.mockReset();
    mockFetch.mockReset();
    global.fetch = mockFetch as any;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('no-ops when agent has no required tools', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // required tools

    await ensureRequiredToolsInstalled('agent-db-id', 'agent-slug');

    expect(mockExec).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('marks builtin tool installed when command exists', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'tool-bash', name: 'bash', install_method: 'builtin', install_ref: '' }],
      }) // required tools
      .mockResolvedValue({ rowCount: 1 }); // status upserts
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '/usr/bin/bash\n', stderr: '' });

    await ensureRequiredToolsInstalled('agent-db-id', 'agent-slug');

    expect(mockExec).toHaveBeenCalledWith('agent-slug', ['bash', '-lc', 'command -v bash'], 30000);
    expect(mockQuery).toHaveBeenCalled();
  });

  it('installs binary gh into persistent tools path', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'tool-gh', name: 'gh', install_method: 'binary', install_ref: 'https://github.com/cli/cli/releases/download/v{version}/gh_{version}_linux_amd64.tar.gz' }],
      }) // required tools
      .mockResolvedValue({ rowCount: 1 }); // status upserts
    // Idempotency check: not installed
    mockExec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
    // Download
    mockFetch.mockResolvedValue(mockFetchResponse(200, new ArrayBuffer(100)));
    // Extract via stdin
    mockExecStdin.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await ensureRequiredToolsInstalled('agent-db-id', 'agent-slug');

    // Idempotency check
    expect(mockExec).toHaveBeenCalledWith(
      'agent-slug', ['test', '-x', '/data/tools/bin/gh'], 30000
    );
    // Extract: stdin called with Buffer
    expect(mockExecStdin).toHaveBeenCalledTimes(1);
    const stdinCall = mockExecStdin.mock.calls[0];
    expect(stdinCall[0]).toBe('agent-slug');
    expect(stdinCall[1][0]).toBe('bash');
    expect(stdinCall[1][1]).toBe('-lc');
    expect(Buffer.isBuffer(stdinCall[2])).toBe(true);
  });

  it('marks tool failed and throws on install error', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'tool-bash', name: 'bash', install_method: 'builtin', install_ref: '' }],
      }) // required tools
      .mockResolvedValue({ rowCount: 1 }); // pending + failed upserts
    mockExec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'not found' });

    await expect(ensureRequiredToolsInstalled('agent-db-id', 'agent-slug')).rejects.toThrow(
      /Failed installing required tool "bash"/
    );
  });

  // T1: installing status set before install attempt
  it('sets installing status before install attempt', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'tool-gh', name: 'gh', install_method: 'binary', install_ref: 'https://github.com/cli/cli/releases/download/v{version}/gh_{version}_linux_amd64.tar.gz' }],
      })
      .mockResolvedValue({ rowCount: 1 });
    mockExec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' }); // not installed
    mockFetch.mockResolvedValue(mockFetchResponse(200, new ArrayBuffer(100)));
    mockExecStdin.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await ensureRequiredToolsInstalled('agent-db-id', 'agent-slug');

    // First upsert should use 'installing'
    const upsertCalls = mockQuery.mock.calls.filter((c: any) => c[0].includes('INSERT INTO agent_tool_installs'));
    expect(upsertCalls.length).toBeGreaterThan(0);
    expect(upsertCalls[0][1][2]).toBe('installing');
  });

  // T2: retry once on transient binary failure, then succeed
  it('retries once on binary install failure then succeeds', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'tool-gh', name: 'gh', install_method: 'binary', install_ref: 'https://github.com/cli/cli/releases/download/v{version}/gh_{version}_linux_amd64.tar.gz' }],
      })
      .mockResolvedValue({ rowCount: 1 });
    // Idempotency check: not installed (both attempts)
    mockExec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
    // Download succeeds both times
    mockFetch.mockResolvedValue(mockFetchResponse(200, new ArrayBuffer(100)));
    // Extract: first attempt fails, retry succeeds
    mockExecStdin
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'tar error' })
      .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await ensureRequiredToolsInstalled('agent-db-id', 'agent-slug');
    // 2 idempotency checks + 2 extract attempts
    expect(mockExec).toHaveBeenCalledTimes(2);
    expect(mockExecStdin).toHaveBeenCalledTimes(2);
  });

  // T3: no retry for builtin
  it('does not retry builtin tool failure', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'tool-bash', name: 'bash', install_method: 'builtin', install_ref: '' }],
      })
      .mockResolvedValue({ rowCount: 1 });
    mockExec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'not found' });

    await expect(ensureRequiredToolsInstalled('agent-db-id', 'agent-slug')).rejects.toThrow();
    expect(mockExec).toHaveBeenCalledTimes(1); // no retry
  });

  // T4: timeout passed to execWithStdin for binary
  it('passes timeout to execWithStdin for binary installs', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'tool-gh', name: 'gh', install_method: 'binary', install_ref: 'https://github.com/cli/cli/releases/download/v{version}/gh_{version}_linux_amd64.tar.gz' }],
      })
      .mockResolvedValue({ rowCount: 1 });
    mockExec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' }); // not installed
    mockFetch.mockResolvedValue(mockFetchResponse(200, new ArrayBuffer(100)));
    mockExecStdin.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await ensureRequiredToolsInstalled('agent-db-id', 'agent-slug');

    expect(mockExecStdin).toHaveBeenCalledWith('agent-slug', expect.any(Array), expect.any(Buffer), 300000);
  });

  // T5: deterministic binary path for gh
  it('gh binary path resolves to gh_{v}_linux_amd64/bin/gh', () => {
    const tool = { id: 't1', name: 'gh', install_method: 'binary' as const, install_ref: 'https://github.com/cli/cli/releases/download/v{version}/gh_{version}_linux_amd64.tar.gz' };
    const script = binaryInstallScript(tool);
    expect(script).toContain('gh_2.74.2_linux_amd64/bin/gh');
    expect(script).not.toContain('find');
  });

  // T6: deterministic binary path for docker
  it('docker binary path resolves to docker/docker', () => {
    const tool = { id: 't2', name: 'docker', install_method: 'binary' as const, install_ref: 'https://download.docker.com/linux/static/stable/x86_64/docker-{version}.tgz' };
    const script = binaryInstallScript(tool);
    expect(script).toContain('docker/docker');
    expect(script).not.toContain('find');
  });

  // T7: no version configured throws clear error
  it('throws clear error when no version configured for binary tool', () => {
    const tool = { id: 't3', name: 'rg', install_method: 'binary' as const, install_ref: 'https://github.com/BurntSushi/ripgrep/releases/download/{version}/rg-{version}.tgz' };
    expect(() => binaryInstallScript(tool)).toThrow(/No version configured for binary tool "rg"/);
  });

  // T8: binary install uses cp with deterministic path (no find)
  it('binary install script uses cp with deterministic path, no find', () => {
    const tool = { id: 't1', name: 'gh', install_method: 'binary' as const, install_ref: 'https://github.com/cli/cli/releases/download/v{version}/gh_{version}_linux_amd64.tar.gz' };
    const script = binaryInstallScript(tool);
    expect(script).toMatch(/cp \/tmp\/hill90-tools\/gh_.*\/bin\/gh \/data\/tools\/bin/);
    expect(script).not.toContain('find');
    expect(script).not.toContain('head');
  });

  // T9: reconcile skips already-installed tools
  it('reconcile skips already-installed tools', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'tool-gh', name: 'gh', install_method: 'binary', install_ref: 'https://github.com/cli/cli/releases/download/v{version}/gh_{version}_linux_amd64.tar.gz' }],
      }) // required tools
      .mockResolvedValueOnce({
        rows: [{ tool_id: 'tool-gh', status: 'installed' }],
      }); // existing installs

    const result = await reconcileToolInstalls('agent-db-id', 'agent-slug');
    expect(result.alreadyInstalled).toEqual(['gh']);
    expect(result.installed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(mockExec).not.toHaveBeenCalled();
  });

  // T10: reconcile installs missing tools
  it('reconcile installs missing tools', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'tool-gh', name: 'gh', install_method: 'binary', install_ref: 'https://github.com/cli/cli/releases/download/v{version}/gh_{version}_linux_amd64.tar.gz' }],
      }) // required tools
      .mockResolvedValueOnce({ rows: [] }) // no existing installs
      .mockResolvedValue({ rowCount: 1 }); // upserts
    mockExec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' }); // not installed
    mockFetch.mockResolvedValue(mockFetchResponse(200, new ArrayBuffer(100)));
    mockExecStdin.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const result = await reconcileToolInstalls('agent-db-id', 'agent-slug');
    expect(result.installed).toEqual(['gh']);
    expect(mockExecStdin).toHaveBeenCalled();
  });

  // T11: reconcile reports failures without throwing
  it('reconcile reports failures without throwing', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'tool-gh', name: 'gh', install_method: 'binary', install_ref: 'https://github.com/cli/cli/releases/download/v{version}/gh_{version}_linux_amd64.tar.gz' }],
      }) // required tools
      .mockResolvedValueOnce({ rows: [] }) // no existing installs
      .mockResolvedValue({ rowCount: 1 }); // upserts
    mockExec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' }); // not installed
    mockFetch.mockResolvedValue(mockFetchResponse(200, new ArrayBuffer(100)));
    // Both extract attempts fail (initial + 1 retry)
    mockExecStdin.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'extract failed' });

    const result = await reconcileToolInstalls('agent-db-id', 'agent-slug');
    expect(result.failed).toEqual(['gh']);
    expect(result.installed).toEqual([]);
  });

  // T12: reconcile cleans up stale install records
  it('reconcile cleans up stale install records', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // no required tools (skill was removed)
      .mockResolvedValueOnce({
        rows: [{ tool_id: 'tool-old', status: 'installed' }],
      }) // stale install from previously-assigned skill
      .mockResolvedValue({ rowCount: 1 }); // DELETE

    const result = await reconcileToolInstalls('agent-db-id', 'agent-slug');
    expect(result.installed).toEqual([]);
    expect(result.alreadyInstalled).toEqual([]);

    // Verify DELETE was called for the stale tool
    const deleteCalls = mockQuery.mock.calls.filter((c: any) => c[0].includes('DELETE FROM agent_tool_installs'));
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0][1]).toEqual(['agent-db-id', 'tool-old']);
  });

  // T21: installBinary skips download when tool already installed
  it('skips download when binary tool already installed in container', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'tool-gh', name: 'gh', install_method: 'binary', install_ref: 'https://github.com/cli/cli/releases/download/v{version}/gh_{version}_linux_amd64.tar.gz' }],
      })
      .mockResolvedValue({ rowCount: 1 });
    // Idempotency check: already installed
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await ensureRequiredToolsInstalled('agent-db-id', 'agent-slug');

    expect(mockExec).toHaveBeenCalledWith(
      'agent-slug', ['test', '-x', '/data/tools/bin/gh'], 30000
    );
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockExecStdin).not.toHaveBeenCalled();
  });

  // T22: binaryInstallScript does not contain curl
  it('binaryInstallScript does not contain curl', () => {
    const tool = { id: 't1', name: 'gh', install_method: 'binary' as const, install_ref: 'https://github.com/cli/cli/releases/download/v{version}/gh_{version}_linux_amd64.tar.gz' };
    const script = binaryInstallScript(tool);
    expect(script).not.toContain('curl');
  });

  // T23: binaryInstallScript reads from stdin (tar -xzf -)
  it('binaryInstallScript reads tar from stdin', () => {
    const tool = { id: 't1', name: 'gh', install_method: 'binary' as const, install_ref: 'https://github.com/cli/cli/releases/download/v{version}/gh_{version}_linux_amd64.tar.gz' };
    const script = binaryInstallScript(tool);
    expect(script).toContain('tar -xzf - -C /tmp/hill90-tools');
  });

  // T24: validateDownloadUrl rejects HTTP URLs
  it('validateDownloadUrl rejects HTTP URLs', () => {
    expect(() => validateDownloadUrl('http://github.com/foo.tar.gz')).toThrow(
      /Download URL must use HTTPS/
    );
  });

  // T25: validateDownloadUrl rejects non-allowlisted hostname
  it('validateDownloadUrl rejects non-allowlisted hostname', () => {
    expect(() => validateDownloadUrl('https://evil.com/malicious.tgz')).toThrow(
      /not in allowlist/
    );
  });

  // T26: validateDownloadUrl accepts github.com HTTPS
  it('validateDownloadUrl accepts github.com HTTPS', () => {
    expect(() => validateDownloadUrl('https://github.com/cli/cli/releases/download/v2.74.2/gh_2.74.2_linux_amd64.tar.gz')).not.toThrow();
  });

  // T27: validateDownloadUrl accepts download.docker.com HTTPS
  it('validateDownloadUrl accepts download.docker.com HTTPS', () => {
    expect(() => validateDownloadUrl('https://download.docker.com/linux/static/stable/x86_64/docker-28.0.1.tgz')).not.toThrow();
  });

  // T28: validateDownloadUrl accepts release-assets.githubusercontent.com HTTPS
  it('validateDownloadUrl accepts release-assets.githubusercontent.com HTTPS', () => {
    expect(() => validateDownloadUrl('https://release-assets.githubusercontent.com/github-production-release-asset/foo.tar.gz')).not.toThrow();
  });

  // T29: validateDownloadUrl rejects malformed URL
  it('validateDownloadUrl rejects malformed URL', () => {
    expect(() => validateDownloadUrl('not-a-url')).toThrow(/Invalid download URL/);
  });

  // T30: installBinary rejects tool with disallowed install_ref host
  it('rejects binary tool with disallowed install_ref host', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'tool-gh', name: 'gh', install_method: 'binary', install_ref: 'https://evil.com/gh_{version}.tar.gz' }],
      })
      .mockResolvedValue({ rowCount: 1 });
    // Idempotency check: not installed
    mockExec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

    await expect(ensureRequiredToolsInstalled('agent-db-id', 'agent-slug')).rejects.toThrow(
      /not in allowlist/
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // T31: execWithStdin called with Buffer stdinData on success
  it('execWithStdin receives Buffer stdinData on successful binary install', async () => {
    const tarballBody = new ArrayBuffer(256);
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'tool-gh', name: 'gh', install_method: 'binary', install_ref: 'https://github.com/cli/cli/releases/download/v{version}/gh_{version}_linux_amd64.tar.gz' }],
      })
      .mockResolvedValue({ rowCount: 1 });
    mockExec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' }); // not installed
    mockFetch.mockResolvedValue(mockFetchResponse(200, tarballBody));
    mockExecStdin.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await ensureRequiredToolsInstalled('agent-db-id', 'agent-slug');

    expect(mockExecStdin).toHaveBeenCalledTimes(1);
    const stdinData = mockExecStdin.mock.calls[0][2];
    expect(Buffer.isBuffer(stdinData)).toBe(true);
    expect(stdinData.length).toBe(256);
  });

  // T32: Allowed host redirecting to disallowed host fails before body download
  it('fails when redirect goes to disallowed host', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'tool-gh', name: 'gh', install_method: 'binary', install_ref: 'https://github.com/cli/cli/releases/download/v{version}/gh_{version}_linux_amd64.tar.gz' }],
      })
      .mockResolvedValue({ rowCount: 1 });
    mockExec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' }); // not installed
    // First fetch returns redirect to disallowed host
    mockFetch.mockResolvedValue(
      mockFetchResponse(302, undefined, { location: 'https://evil.com/malicious.tgz' })
    );

    await expect(ensureRequiredToolsInstalled('agent-db-id', 'agent-slug')).rejects.toThrow(
      /not in allowlist/
    );
    // 2 attempts (initial + 1 retry), each does 1 fetch then fails on redirect validation
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // T33: Allowed-to-allowed redirect succeeds (github.com → objects.githubusercontent.com)
  it('follows redirect from allowed to allowed host', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'tool-gh', name: 'gh', install_method: 'binary', install_ref: 'https://github.com/cli/cli/releases/download/v{version}/gh_{version}_linux_amd64.tar.gz' }],
      })
      .mockResolvedValue({ rowCount: 1 });
    mockExec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' }); // not installed
    // First fetch: redirect to allowed CDN
    mockFetch
      .mockResolvedValueOnce(
        mockFetchResponse(302, undefined, { location: 'https://objects.githubusercontent.com/gh.tar.gz' })
      )
      .mockResolvedValueOnce(mockFetchResponse(200, new ArrayBuffer(100)));
    mockExecStdin.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await ensureRequiredToolsInstalled('agent-db-id', 'agent-slug');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockExecStdin).toHaveBeenCalledTimes(1);
  });

  // T34: Excessive redirects (> MAX_DOWNLOAD_REDIRECTS) fails deterministically
  it('fails on excessive redirects', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'tool-gh', name: 'gh', install_method: 'binary', install_ref: 'https://github.com/cli/cli/releases/download/v{version}/gh_{version}_linux_amd64.tar.gz' }],
      })
      .mockResolvedValue({ rowCount: 1 });
    mockExec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' }); // not installed
    // Always redirect (loop)
    mockFetch.mockResolvedValue(
      mockFetchResponse(302, undefined, { location: 'https://github.com/loop' })
    );

    await expect(ensureRequiredToolsInstalled('agent-db-id', 'agent-slug')).rejects.toThrow(
      /Too many redirects \(max 5\)/
    );
    // 2 attempts (initial + 1 retry), each exhausts 6 fetches (1 initial + 5 redirect hops)
    expect(mockFetch).toHaveBeenCalledTimes(12);
  });
});

// T13 (unit): invalid HILL90_TOOL_INSTALL_RETRIES still retries (defaults to 1)
describe('tool-installer retry env safety', () => {
  it('invalid HILL90_TOOL_INSTALL_RETRIES defaults to 1 retry', async () => {
    const origEnv = process.env.HILL90_TOOL_INSTALL_RETRIES;
    process.env.HILL90_TOOL_INSTALL_RETRIES = 'not-a-number';

    // Re-import the module with fresh env
    jest.resetModules();
    const mockQueryInner = jest.fn();
    const mockExecInner = jest.fn();
    const mockExecStdinInner = jest.fn();
    const mockFetchInner = jest.fn();
    jest.doMock('../db/pool', () => ({ getPool: () => ({ query: mockQueryInner }) }));
    jest.doMock('../services/docker', () => ({
      execInContainerWithExit: (...args: any[]) => mockExecInner(...args),
      execWithStdin: (...args: any[]) => mockExecStdinInner(...args),
    }));
    global.fetch = mockFetchInner as any;

    const { ensureRequiredToolsInstalled: ensureFresh } = require('../services/tool-installer');

    mockQueryInner
      .mockResolvedValueOnce({
        rows: [{ id: 'tool-gh', name: 'gh', install_method: 'binary', install_ref: 'https://github.com/cli/cli/releases/download/v{version}/gh_{version}_linux_amd64.tar.gz' }],
      })
      .mockResolvedValue({ rowCount: 1 });
    // Idempotency check: not installed (all attempts)
    mockExecInner.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
    // Download succeeds
    mockFetchInner.mockResolvedValue(mockFetchResponse(200, new ArrayBuffer(100)));
    // Extract: first attempt fails, retry succeeds
    mockExecStdinInner
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'fail' })
      .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await ensureFresh('agent-db-id', 'agent-slug');
    // Should have retried (2 execStdin calls), proving NaN didn't yield 0 retries
    expect(mockExecStdinInner).toHaveBeenCalledTimes(2);

    // Restore
    if (origEnv === undefined) {
      delete process.env.HILL90_TOOL_INSTALL_RETRIES;
    } else {
      process.env.HILL90_TOOL_INSTALL_RETRIES = origEnv;
    }
  });
});
