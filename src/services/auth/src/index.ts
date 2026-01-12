// Hill90 Auth Service
import express from 'express';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'auth' });
});

app.listen(PORT, () => {
  console.log(`Hill90 Auth service listening on port ${PORT}`);
});
