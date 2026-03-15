import { detectModelType } from '../helpers/model-type-detect';

/**
 * Shared test vectors H1-H7 for D7 parity.
 * Identical hardcoded input/output pairs in both TS and Python test suites.
 */
describe('detectModelType — D7 parity vectors', () => {
  it('H1: openai/text-embedding-3-small → embedding', () => {
    const result = detectModelType('openai/text-embedding-3-small');
    expect(result.detected_type).toBe('embedding');
    expect(result.capabilities).toEqual(['embedding']);
  });

  it('H2: openai/gpt-4o → chat+vision', () => {
    const result = detectModelType('openai/gpt-4o');
    expect(result.detected_type).toBe('chat');
    expect(result.capabilities).toEqual(['chat', 'function_calling', 'vision']);
  });

  it('H3: openai/gpt-4o-mini → chat+function_calling', () => {
    const result = detectModelType('openai/gpt-4o-mini');
    expect(result.detected_type).toBe('chat');
    expect(result.capabilities).toEqual(['chat', 'function_calling']);
  });

  it('H4: anthropic/claude-sonnet-4-20250514 → chat+function_calling', () => {
    const result = detectModelType('anthropic/claude-sonnet-4-20250514');
    expect(result.detected_type).toBe('chat');
    expect(result.capabilities).toEqual(['chat', 'function_calling']);
  });

  it('H5: openai/tts-1 → audio', () => {
    const result = detectModelType('openai/tts-1');
    expect(result.detected_type).toBe('audio');
    expect(result.capabilities).toEqual(['audio']);
  });

  it('H6: openai/dall-e-3 → image', () => {
    const result = detectModelType('openai/dall-e-3');
    expect(result.detected_type).toBe('image');
    expect(result.capabilities).toEqual(['image_generation']);
  });

  it('H7: some-unknown-model → chat default', () => {
    const result = detectModelType('some-unknown-model');
    expect(result.detected_type).toBe('chat');
    expect(result.capabilities).toEqual(['chat']);
  });
});
