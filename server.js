// ================================
// Research Repository Backend Server
// ================================
require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');

// ================================
// App Init
// ================================
const app = express();
const PORT = process.env.PORT || 5000;

// ================================
// Trust proxy (Railway)
// ================================
app.set('trust proxy', 1);

// ================================
// Security & Performance
// ================================
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow inline PDF
  })
);
app.use(compression());

if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
}

// ================================
// CORS Configuration
// ================================
const allowedOriginsList = (process.env.APP_ORIGIN || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

// Allow localhost + LAN + Expo + Vercel preview domains
const devOriginRegex =
  /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+)(?::\d+)?$/;

const vercelRegex = /^https:\/\/.*\.vercel\.app$/;

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // Postman / curl

    if (
      allowedOriginsList.includes(origin) ||
      devOriginRegex.test(origin) ||
      vercelRegex.test(origin)
    ) {
      return cb(null, true);
    }

    return cb(new Error(`CORS: origin not allowed → ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Disposition'],
};

app.use(cors(corsOptions));
app.options(/^\/api\/.*/, cors(corsOptions));

// Debug incoming origins (optional)
app.use((req, _res, next) => {
  if (req.path.startsWith('/api')) {
    console.log('🔎', req.method, req.path, 'Origin:', req.headers.origin);
  }
  next();
});

// ================================
// Body Parsers
// ================================
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ================================
// MongoDB Connection (Railway Safe)
// ================================
mongoose.set('strictQuery', true);

mongoose
  .connect(process.env.MONGO_URI)
  .then(() =>
    console.log('✅ MongoDB connected (Atlas → repositoryDB)')
  )
  .catch(err => {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  });

// ================================
// Routes
// ================================
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/faculty', require('./routes/faculty'));
app.use('/api/student', require('./routes/student'));
app.use('/api/research', require('./routes/research'));
app.use('/api/staff', require('./routes/staff'));
app.use('/api/repository', require('./routes/repositoryRoutes'));
app.use('/api/ai', require('./routes/aiRoutes'));
app.use('/api/research-admin', require('./routes/researchAdmin'));

// ================================
// Health Check (Railway monitoring)
// ================================
app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    env: process.env.NODE_ENV || 'development',
  });
});

app.get('/', (_req, res) => {
  res.send('🚀 Research Repository API is running');
});

// ================================
// 404 Handler
// ================================
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ================================
// Central Error Handler
// ================================
app.use((err, _req, res, _next) => {
  if (/CORS/.test(err.message)) {
    return res.status(403).json({ error: err.message });
  }

  if (
    err.code === 'LIMIT_FILE_SIZE' ||
    /Only PDF|Only DOC/i.test(err.message)
  ) {
    return res.status(400).json({ error: err.message });
  }

  console.error('❌ Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ================================
// Start Server (Railway)
// ================================
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// ================================
// Graceful Shutdown (Railway restarts)
// ================================
const shutdown = async () => {
  console.log('🛑 Shutting down server...');
  server.close();
  await mongoose.connection.close(false);
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ================================
// Process Safety
// ================================
process.on('unhandledRejection', reason => {
  console.error('🧨 Unhandled Rejection:', reason);
});
process.on('uncaughtException', err => {
  console.error('🧨 Uncaught Exception:', err);
});
