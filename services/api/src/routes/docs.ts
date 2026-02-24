import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';

const specPath = path.resolve(__dirname, '../openapi/openapi.yaml');
const specYaml = fs.readFileSync(specPath, 'utf-8');
export const spec = yaml.load(specYaml) as Record<string, unknown>;

export const docsRouter = Router();
docsRouter.use('/', swaggerUi.serve, swaggerUi.setup(spec as any, { customSiteTitle: 'Hill90 API Docs' }));

export const specRouter = Router();
specRouter.get('/', (_req, res) => {
  res.json(spec);
});
