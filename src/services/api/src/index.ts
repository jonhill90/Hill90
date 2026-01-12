// Hill90 API Service
// TypeScript/Express API Gateway

import express, { Application } from 'express';

const app: Application = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'api' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Hill90 API service listening on port ${PORT}`);
});
