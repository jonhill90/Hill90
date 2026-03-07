import { ensureRequiredToolsInstalled, reconcileToolInstalls, binaryInstallScript } from '../services/tool-installer';

const mockQuery = jest.fn();
const mockExec = jest.fn();

jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery }),
}));

jest.mock('../services/docker', () => ({
  execInContainerWithExit: (...args: any[]) => mockExec(...args),
}));

describe('tool-installer service', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockExec.mockReset();
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
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await ensureRequiredToolsInstalled('agent-db-id', 'agent-slug');

    expect(mockExec).toHaveBeenCalledTimes(1);
    const call = mockExec.mock.calls[0];
    expect(call[0]).toBe('agent-slug');
    expect(call[1][0]).toBe('bash');
    expect(call[1][1]).toBe('-lc');
    expect(call[1][2]).toContain("/data/tools/bin/'gh'");
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
        rows: [{ id: 'tool-gh', name: 'gh', install_method: 'binary', install_ref: 'https://example.com/gh_{version}.tar.gz' }],
      })
      .mockResolvedValue({ rowCount: 1 });
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

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
        rows: [{ id: 'tool-gh', name: 'gh', install_method: 'binary', install_ref: 'https://example.com/gh_{version}.tar.gz' }],
      })
      .mockResolvedValue({ rowCount: 1 });
    mockExec
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'network timeout' }) // first attempt fails
      .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }); // retry succeeds

    await ensureRequiredToolsInstalled('agent-db-id', 'agent-slug');
    expect(mockExec).toHaveBeenCalledTimes(2);
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

  // T4: timeout passed to exec for binary
  it('passes timeout to execInContainerWithExit for binary installs', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'tool-gh', name: 'gh', install_method: 'binary', install_ref: 'https://example.com/gh_{version}.tar.gz' }],
      })
      .mockResolvedValue({ rowCount: 1 });
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await ensureRequiredToolsInstalled('agent-db-id', 'agent-slug');

    expect(mockExec).toHaveBeenCalledWith('agent-slug', expect.any(Array), 300000);
  });

  // T5: deterministic binary path for gh
  it('gh binary path resolves to gh_{v}_linux_amd64/bin/gh', () => {
    const tool = { id: 't1', name: 'gh', install_method: 'binary' as const, install_ref: 'https://example.com/gh_{version}.tar.gz' };
    const script = binaryInstallScript(tool);
    expect(script).toContain('gh_2.74.2_linux_amd64/bin/gh');
    expect(script).not.toContain('find');
  });

  // T6: deterministic binary path for docker
  it('docker binary path resolves to docker/docker', () => {
    const tool = { id: 't2', name: 'docker', install_method: 'binary' as const, install_ref: 'https://example.com/docker-{version}.tgz' };
    const script = binaryInstallScript(tool);
    expect(script).toContain('docker/docker');
    expect(script).not.toContain('find');
  });

  // T7: no version configured throws clear error
  it('throws clear error when no version configured for binary tool', () => {
    const tool = { id: 't3', name: 'rg', install_method: 'binary' as const, install_ref: 'https://example.com/rg-{version}.tgz' };
    expect(() => binaryInstallScript(tool)).toThrow(/No version configured for binary tool "rg"/);
  });

  // T8: binary install uses cp with deterministic path (no find)
  it('binary install script uses cp with deterministic path, no find', () => {
    const tool = { id: 't1', name: 'gh', install_method: 'binary' as const, install_ref: 'https://example.com/gh_{version}.tar.gz' };
    const script = binaryInstallScript(tool);
    expect(script).toMatch(/cp \/tmp\/hill90-tools\/gh_.*\/bin\/gh \/data\/tools\/bin/);
    expect(script).not.toContain('find');
    expect(script).not.toContain('head');
  });

  // T9: reconcile skips already-installed tools
  it('reconcile skips already-installed tools', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'tool-gh', name: 'gh', install_method: 'binary', install_ref: 'https://example.com/gh.tar.gz' }],
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
        rows: [{ id: 'tool-gh', name: 'gh', install_method: 'binary', install_ref: 'https://example.com/gh_{version}.tar.gz' }],
      }) // required tools
      .mockResolvedValueOnce({ rows: [] }) // no existing installs
      .mockResolvedValue({ rowCount: 1 }); // upserts
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const result = await reconcileToolInstalls('agent-db-id', 'agent-slug');
    expect(result.installed).toEqual(['gh']);
    expect(mockExec).toHaveBeenCalled();
  });

  // T11: reconcile reports failures without throwing
  it('reconcile reports failures without throwing', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'tool-gh', name: 'gh', install_method: 'binary', install_ref: 'https://example.com/gh_{version}.tar.gz' }],
      }) // required tools
      .mockResolvedValueOnce({ rows: [] }) // no existing installs
      .mockResolvedValue({ rowCount: 1 }); // upserts
    // Both attempts fail (initial + 1 retry)
    mockExec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'download failed' });

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
    jest.doMock('../db/pool', () => ({ getPool: () => ({ query: mockQueryInner }) }));
    jest.doMock('../services/docker', () => ({
      execInContainerWithExit: (...args: any[]) => mockExecInner(...args),
    }));

    const { ensureRequiredToolsInstalled: ensureFresh } = require('../services/tool-installer');

    mockQueryInner
      .mockResolvedValueOnce({
        rows: [{ id: 'tool-gh', name: 'gh', install_method: 'binary', install_ref: 'https://example.com/gh_{version}.tar.gz' }],
      })
      .mockResolvedValue({ rowCount: 1 });
    mockExecInner
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'fail' }) // first attempt
      .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }); // retry

    await ensureFresh('agent-db-id', 'agent-slug');
    // Should have retried (2 exec calls), proving NaN didn't yield 0 retries
    expect(mockExecInner).toHaveBeenCalledTimes(2);

    // Restore
    if (origEnv === undefined) {
      delete process.env.HILL90_TOOL_INSTALL_RETRIES;
    } else {
      process.env.HILL90_TOOL_INSTALL_RETRIES = origEnv;
    }
  });
});
