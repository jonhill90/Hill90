import { processAvatar } from '../services/avatar';
import sharp from 'sharp';

describe('processAvatar', () => {
  it('produces a 256x256 WebP image', async () => {
    // Create a small test image (red 100x100 PNG)
    const input = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();

    const output = await processAvatar(input);
    const metadata = await sharp(output).metadata();

    expect(metadata.width).toBe(256);
    expect(metadata.height).toBe(256);
    expect(metadata.format).toBe('webp');
  });

  it('handles rectangular images (crop to cover)', async () => {
    const input = await sharp({
      create: { width: 400, height: 200, channels: 3, background: { r: 0, g: 255, b: 0 } },
    })
      .png()
      .toBuffer();

    const output = await processAvatar(input);
    const metadata = await sharp(output).metadata();

    expect(metadata.width).toBe(256);
    expect(metadata.height).toBe(256);
    expect(metadata.format).toBe('webp');
  });
});
