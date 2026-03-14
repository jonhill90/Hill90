/**
 * Tests for structured audit log helper.
 * Verifies principal_type field is emitted in every log entry.
 */

import { auditLog } from '../helpers/audit';

describe('auditLog', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('AU-1: emits principal_type field for human', () => {
    auditLog('test_action', 'agent-1', 'user-uuid-123', 'human');
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(logged.principal_type).toBe('human');
  });

  it('AU-2: emits principal_type field for service', () => {
    auditLog('test_action', 'agent-1', 'service', 'service');
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(logged.principal_type).toBe('service');
  });

  it('AU-3: output includes all required fields', () => {
    auditLog('test_action', 'agent-1', 'user-uuid-123', 'human', { custom_key: 'value' });
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(logged).toEqual(expect.objectContaining({
      type: 'audit',
      action: 'test_action',
      agent_id: 'agent-1',
      user_sub: 'user-uuid-123',
      principal_type: 'human',
      custom_key: 'value',
    }));
    expect(logged.timestamp).toBeDefined();
  });
});
