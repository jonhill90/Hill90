import { ensureRequiredToolsInstalled } from '../services/tool-installer';

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

    expect(mockExec).toHaveBeenCalledWith('agent-slug', ['bash', '-lc', 'command -v bash']);
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
    expect(call[1][2]).toContain('/data/tools/bin/gh');
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
});

