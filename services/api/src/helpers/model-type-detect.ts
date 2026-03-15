/**
 * Canonical model type detection contract (D7).
 *
 * Rules evaluated top-to-bottom, first match wins.
 * This specification is implemented identically in Python (model_type_detect.py).
 * Parity enforced by shared test vectors H1-H7 in both test suites.
 */

export interface DetectedModel {
  detected_type: string;
  capabilities: string[];
}

const DETECTION_RULES: Array<{
  test: (model: string) => boolean;
  detected_type: string;
  capabilities: string[];
}> = [
  {
    test: (m) => m.includes('embed'),
    detected_type: 'embedding',
    capabilities: ['embedding'],
  },
  {
    test: (m) => m.includes('tts') || m.includes('audio'),
    detected_type: 'audio',
    capabilities: ['audio'],
  },
  {
    test: (m) => m.includes('dall-e') || m.includes('image-generation'),
    detected_type: 'image',
    capabilities: ['image_generation'],
  },
  {
    test: (m) => m.includes('whisper') || m.includes('transcription'),
    detected_type: 'transcription',
    capabilities: ['transcription'],
  },
  {
    // gpt-4o but NOT gpt-4o-mini
    test: (m) => m.includes('gpt-4o') && !m.includes('gpt-4o-mini'),
    detected_type: 'chat',
    capabilities: ['chat', 'function_calling', 'vision'],
  },
  {
    test: (m) => m.includes('gpt-4o-mini'),
    detected_type: 'chat',
    capabilities: ['chat', 'function_calling'],
  },
  {
    test: (m) => m.includes('claude-'),
    detected_type: 'chat',
    capabilities: ['chat', 'function_calling'],
  },
];

const DEFAULT_RESULT: DetectedModel = {
  detected_type: 'chat',
  capabilities: ['chat'],
};

export function detectModelType(litellmModel: string): DetectedModel {
  const lower = litellmModel.toLowerCase();
  for (const rule of DETECTION_RULES) {
    if (rule.test(lower)) {
      return { detected_type: rule.detected_type, capabilities: [...rule.capabilities] };
    }
  }
  return { ...DEFAULT_RESULT, capabilities: [...DEFAULT_RESULT.capabilities] };
}
