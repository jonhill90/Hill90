/**
 * OpenAPI spec accuracy tests for ModelPolicy.model_aliases (AI-121).
 *
 * W1: ModelPolicy component has model_aliases property.
 * W2: model_aliases type is object with additionalProperties: { type: string }.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const specPath = path.resolve(__dirname, '../openapi/openapi.yaml');
const spec = yaml.load(fs.readFileSync(specPath, 'utf8')) as Record<string, any>;

describe('ModelPolicy OpenAPI schema', () => {
  const modelPolicy = spec?.components?.schemas?.ModelPolicy;

  it('W1: ModelPolicy has model_aliases property', () => {
    expect(modelPolicy).toBeDefined();
    expect(modelPolicy.properties).toBeDefined();
    expect(modelPolicy.properties.model_aliases).toBeDefined();
  });

  it('W2: model_aliases is object with additionalProperties string', () => {
    const aliases = modelPolicy.properties.model_aliases;
    expect(aliases.type).toBe('object');
    expect(aliases.additionalProperties).toEqual({ type: 'string' });
  });
});
