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
