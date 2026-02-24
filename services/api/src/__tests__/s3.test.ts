import { ensureBucket } from '../services/s3';

// Mock the entire @aws-sdk/client-s3 module
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
    HeadBucketCommand: jest.fn().mockImplementation((input: any) => ({ ...input, _type: 'HeadBucket' })),
    CreateBucketCommand: jest.fn().mockImplementation((input: any) => ({ ...input, _type: 'CreateBucket' })),
  };
});

const { S3Client } = require('@aws-sdk/client-s3');

describe('ensureBucket', () => {
  let client: any;

  beforeEach(() => {
    mockSend.mockReset();
    client = new S3Client({});
  });

  it('does nothing when bucket already exists', async () => {
    mockSend.mockResolvedValueOnce({});
    await ensureBucket(client, 'test-bucket');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toMatchObject({ Bucket: 'test-bucket', _type: 'HeadBucket' });
  });

  it('creates bucket when HeadBucket returns NotFound', async () => {
    const notFound = new Error('NotFound');
    notFound.name = 'NotFound';
    mockSend.mockRejectedValueOnce(notFound).mockResolvedValueOnce({});

    await ensureBucket(client, 'new-bucket');
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[1][0]).toMatchObject({ Bucket: 'new-bucket', _type: 'CreateBucket' });
  });

  it('creates bucket when HeadBucket returns NoSuchBucket', async () => {
    const noSuch = new Error('NoSuchBucket');
    noSuch.name = 'NoSuchBucket';
    mockSend.mockRejectedValueOnce(noSuch).mockResolvedValueOnce({});

    await ensureBucket(client, 'new-bucket');
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('creates bucket when HeadBucket returns 404 status', async () => {
    const err404: any = new Error('Not found');
    err404.name = 'SomeError';
    err404.$metadata = { httpStatusCode: 404 };
    mockSend.mockRejectedValueOnce(err404).mockResolvedValueOnce({});

    await ensureBucket(client, 'new-bucket');
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('rethrows unexpected errors', async () => {
    const unexpected = new Error('Access Denied');
    unexpected.name = 'AccessDenied';
    mockSend.mockRejectedValueOnce(unexpected);

    await expect(ensureBucket(client, 'test-bucket')).rejects.toThrow('Access Denied');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});
