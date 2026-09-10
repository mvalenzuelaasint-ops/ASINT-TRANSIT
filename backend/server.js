import express from 'express';
import cors from 'cors';
import vanguardTransitRouter from './routes/vanguardTransit.js';
import heuristicRouter from './routes/heuristic.js';
import tasasOcupacionRouter from './routes/tasas_ocupacion.js';
import trayectosRouter from './routes/trayectos.js';
import icfRouter from './routes/icf.js';
import ipRouter from './routes/ip.js';
import irRouter from './routes/ir.js';
import tripyRouter from './routes/tripy.js';

const app = express();
const PORT = process.env.PORT || 3001;
const DEFAULT_ORIGINS = [
  'http://localhost:5173',
  // El sitio de Netlify se recreo bajo la cuenta nueva (mvalenzuelaasint-ops) y
  // cambio de subdominio; el anterior (asint-transit.netlify.app) ya no existe.
  'https://nabla-asint-transit.netlify.app',
];
const allowedOrigins = (process.env.CORS_ORIGINS || DEFAULT_ORIGINS.join(','))
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

app.get('/api', (_req, res) => {
  res.json({
    status: 'NOMINAL',
    services: {
      vanguardTransit: '/api/vanguard-transit',
      heuristic: '/api/heuristic',
      tasasOcupacion: '/api/tasas-ocupacion',
      trayectos: '/api/trayectos',
      icf: '/api/icf',
      ip: '/api/ip',
      ir: '/api/ir',
      tripy: '/api/tripy',
    },
  });
});

app.use('/api/vanguard-transit', vanguardTransitRouter);
app.use('/api/heuristic', heuristicRouter);
app.use('/api/tasas-ocupacion', tasasOcupacionRouter);
app.use('/api/trayectos', trayectosRouter);
app.use('/api/icf', icfRouter);
app.use('/api/ip', ipRouter);
app.use('/api/ir', irRouter);
app.use('/api/tripy', tripyRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'NOMINAL', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`[ASINT] Central backend running on http://localhost:${PORT}`);
});
