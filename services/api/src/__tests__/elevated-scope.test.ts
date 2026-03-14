import { getAgentEffectiveScope } from '../helpers/elevated-scope';

jest.mock('../db/pool', () => {
  const mockQuery = jest.fn();
  return { getPool: () => ({ query: mockQuery }) };
});

const { getPool } = require('../db/pool');
const mockQuery = getPool().query as jest.Mock;

beforeEach(() => {
  mockQuery.mockReset();
});

describe('getAgentEffectiveScope', () => {
  // E1
  it('returns vps_system when agent has both elevated and non-elevated skills', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ scope: 'container_local' }, { scope: 'vps_system' }],
    });
    const result = await getAgentEffectiveScope('agent-uuid');
    expect(result).toBe('vps_system');
  });

  // E2
  it('returns container_local when agent has only container_local skills', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ scope: 'container_local' }],
    });
    const result = await getAgentEffectiveScope('agent-uuid');
    expect(result).toBe('container_local');
  });

  // E3
  it('returns null when agent has no skills', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const result = await getAgentEffectiveScope('agent-uuid');
    expect(result).toBeNull();
  });
});
