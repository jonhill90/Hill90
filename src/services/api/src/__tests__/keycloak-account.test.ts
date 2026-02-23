import {
  getKeycloakProfile,
  updateKeycloakProfile,
  changeKeycloakPassword,
} from '../services/keycloak-account';

const TEST_ISSUER = 'https://auth.hill90.com/realms/hill90';
const TEST_TOKEN = 'test-bearer-token';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

beforeEach(() => {
  mockFetch.mockReset();
});

describe('getKeycloakProfile', () => {
  it('returns profile on 200', async () => {
    const profile = { username: 'jon', firstName: 'Jon', lastName: 'Hill', email: 'jon@hill90.com' };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => profile,
    });

    const result = await getKeycloakProfile(TEST_ISSUER, TEST_TOKEN);
    expect(result).toEqual(profile);
    expect(mockFetch).toHaveBeenCalledWith(
      `${TEST_ISSUER}/account`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${TEST_TOKEN}` }),
      })
    );
  });

  it('throws on non-200 response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    await expect(getKeycloakProfile(TEST_ISSUER, TEST_TOKEN)).rejects.toThrow('Keycloak Account API GET failed: 401');
  });
});

describe('updateKeycloakProfile', () => {
  it('GETs current profile then POSTs merged update', async () => {
    const current = { username: 'jon', firstName: 'Jon', lastName: 'Hill', email: 'jon@hill90.com' };
    const updated = { ...current, firstName: 'Jonathan' };

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => current })     // GET
      .mockResolvedValueOnce({ ok: true, json: async () => updated });    // POST

    const result = await updateKeycloakProfile(TEST_ISSUER, TEST_TOKEN, { firstName: 'Jonathan' });
    expect(result.firstName).toBe('Jonathan');
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Second call should be POST with merged body
    const postCall = mockFetch.mock.calls[1];
    expect(postCall[1].method).toBe('POST');
    const body = JSON.parse(postCall[1].body);
    expect(body.firstName).toBe('Jonathan');
    expect(body.lastName).toBe('Hill');
  });

  it('throws on POST failure', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ username: 'jon' }) })
      .mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'Forbidden' });

    await expect(updateKeycloakProfile(TEST_ISSUER, TEST_TOKEN, { firstName: 'X' }))
      .rejects.toThrow('Keycloak Account API POST failed: 403');
  });
});

describe('changeKeycloakPassword', () => {
  it('sends POST to credentials/password', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await changeKeycloakPassword(TEST_ISSUER, TEST_TOKEN, 'oldPass', 'newPass123');
    expect(mockFetch).toHaveBeenCalledWith(
      `${TEST_ISSUER}/account/credentials/password`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: `Bearer ${TEST_TOKEN}` }),
      })
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.currentPassword).toBe('oldPass');
    expect(body.newPassword).toBe('newPass123');
    expect(body.confirmation).toBe('newPass123');
  });

  it('throws specific message on 400 (invalid password)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'Bad Request' });
    await expect(changeKeycloakPassword(TEST_ISSUER, TEST_TOKEN, 'wrong', 'newPass123'))
      .rejects.toThrow('Invalid current password');
  });

  it('throws generic message on other errors', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Server Error' });
    await expect(changeKeycloakPassword(TEST_ISSUER, TEST_TOKEN, 'old', 'new12345'))
      .rejects.toThrow('Keycloak password change failed: 500');
  });
});
