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
