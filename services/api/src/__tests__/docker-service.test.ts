describe('Docker service module', () => {
  it('exports all expected functions', () => {
    const dockerModule = require('../services/docker');
    expect(dockerModule.createAndStartContainer).toBeDefined();
    expect(dockerModule.stopAndRemoveContainer).toBeDefined();
    expect(dockerModule.inspectContainer).toBeDefined();
    expect(dockerModule.getContainerLogs).toBeDefined();
    expect(dockerModule.removeAgentVolumes).toBeDefined();
    expect(dockerModule.reconcileAgentStatuses).toBeDefined();
    expect(dockerModule.execInContainer).toBeDefined();
    expect(dockerModule.execInContainerWithExit).toBeDefined();
    expect(dockerModule.execWithStdin).toBeDefined();
  });
});

describe('CreateAgentContainerOpts interface', () => {
  // DS-1: image param accepted by interface
  it('accepts optional image parameter in opts type', () => {
    // TypeScript compilation verifies the interface accepts `image`.
    // This test validates the type is importable and structurally correct.
    const opts: import('../services/docker').CreateAgentContainerOpts = {
      agentId: 'test',
      hostConfigPath: '/data',
      cpus: '1.0',
      memLimit: '1g',
      pidsLimit: 200,
      image: 'custom:v1',
    };
    expect(opts.image).toBe('custom:v1');
  });

  // DS-2: image param is optional (undefined falls back to default)
  it('image param is optional (undefined by default)', () => {
    const opts: import('../services/docker').CreateAgentContainerOpts = {
      agentId: 'test',
      hostConfigPath: '/data',
      cpus: '1.0',
      memLimit: '1g',
      pidsLimit: 200,
    };
    expect(opts.image).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T5/T6: createAndStartContainer applies profile metadata
// ---------------------------------------------------------------------------

describe('createAndStartContainer metadata application', () => {
  const mockStart = jest.fn().mockResolvedValue(undefined);
  const mockInspect = jest.fn().mockResolvedValue({ Id: 'container-id-abc' });
  const mockCreateContainer = jest.fn().mockResolvedValue({ start: mockStart, inspect: mockInspect });
  const mockGetContainer = jest.fn().mockImplementation(() => {
    const err: any = new Error('not found');
    err.statusCode = 404;
    throw err;
  });

  beforeEach(() => {
    jest.resetModules();
    mockCreateContainer.mockClear();
    mockStart.mockClear();
    mockInspect.mockClear();
    process.env.AGENTBOX_CONFIG_HOST_PATH = '/opt/hill90/agentbox-configs';

    jest.doMock('dockerode', () => {
      return jest.fn().mockImplementation(() => ({
        createContainer: mockCreateContainer,
        getContainer: mockGetContainer,
      }));
    });
  });

  afterEach(() => {
    delete process.env.AGENTBOX_CONFIG_HOST_PATH;
    jest.restoreAllMocks();
  });

  // T5: extra_env from metadata is appended to container Env
  it('T5: applies extra_env from metadata to container Env array', async () => {
    const { createAndStartContainer } = require('../services/docker');

    await createAndStartContainer({
      agentId: 'test-agent',
      hostConfigPath: '/opt/hill90/agentbox-configs',
      cpus: '2.0',
      memLimit: '2g',
      pidsLimit: 300,
      env: ['WORK_TOKEN=abc'],
      metadata: {
        extra_env: ['PLAYWRIGHT_BROWSERS_PATH=/data/browsers', 'CUSTOM_VAR=hello'],
      },
    });

    expect(mockCreateContainer).toHaveBeenCalledTimes(1);
    const createOpts = mockCreateContainer.mock.calls[0][0];

    // Verify extra_env entries are in the Env array
    expect(createOpts.Env).toContain('PLAYWRIGHT_BROWSERS_PATH=/data/browsers');
    expect(createOpts.Env).toContain('CUSTOM_VAR=hello');
    // Standard env should also be present
    expect(createOpts.Env).toContain('AGENT_ID=test-agent');
    expect(createOpts.Env).toContain('WORK_TOKEN=abc');
  });

  // T6: shm_size from metadata is set on HostConfig.ShmSize
  it('T6: applies shm_size from metadata to HostConfig.ShmSize', async () => {
    const { createAndStartContainer } = require('../services/docker');

    await createAndStartContainer({
      agentId: 'test-agent',
      hostConfigPath: '/opt/hill90/agentbox-configs',
      cpus: '2.0',
      memLimit: '2g',
      pidsLimit: 300,
      metadata: {
        shm_size: '256m',
      },
    });

    expect(mockCreateContainer).toHaveBeenCalledTimes(1);
    const createOpts = mockCreateContainer.mock.calls[0][0];

    // ShmSize should be 256 * 1024 * 1024 = 268435456 bytes
    expect(createOpts.HostConfig.ShmSize).toBe(256 * 1024 * 1024);
  });

  // T5b: no metadata means no extra env or shm
  it('no metadata produces no ShmSize and standard Env only', async () => {
    const { createAndStartContainer } = require('../services/docker');

    await createAndStartContainer({
      agentId: 'test-agent',
      hostConfigPath: '/opt/hill90/agentbox-configs',
      cpus: '1.0',
      memLimit: '1g',
      pidsLimit: 200,
    });

    expect(mockCreateContainer).toHaveBeenCalledTimes(1);
    const createOpts = mockCreateContainer.mock.calls[0][0];

    expect(createOpts.HostConfig.ShmSize).toBeUndefined();
    expect(createOpts.Env).not.toContain('PLAYWRIGHT_BROWSERS_PATH=/data/browsers');
  });
});

describe('resolveAgentNetwork', () => {
  const { resolveAgentNetwork, AGENT_NETWORK, AGENT_SANDBOX_NETWORK } = require('../services/docker');

  // T5
  it('AGENT_SANDBOX_NETWORK constant is hill90_agent_sandbox', () => {
    expect(AGENT_SANDBOX_NETWORK).toBe('hill90_agent_sandbox');
  });

  // T6
  it('AGENT_NETWORK constant is hill90_agent_internal', () => {
    expect(AGENT_NETWORK).toBe('hill90_agent_internal');
  });

  // T1
  it('returns sandbox for null scope', () => {
    expect(resolveAgentNetwork(null)).toBe('hill90_agent_sandbox');
  });

  // T2
  it('returns sandbox for container_local', () => {
    expect(resolveAgentNetwork('container_local')).toBe('hill90_agent_sandbox');
  });

  // T3
  it('returns agent_internal for host_docker', () => {
    expect(resolveAgentNetwork('host_docker')).toBe('hill90_agent_internal');
  });

  // T4
  it('returns agent_internal for vps_system', () => {
    expect(resolveAgentNetwork('vps_system')).toBe('hill90_agent_internal');
  });
});
