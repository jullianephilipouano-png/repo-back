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

  // ✅ Create Express app
  const app = express();
  const PORT = process.env.PORT || 5000;

  /* ================================
    Core Security & Perf Middleware
  ================================ */
  app.set('trust proxy', 1);                 // if behind Nginx/Heroku/etc.
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow PDF inline for same site
  }));
  app.use(compression());
  if (process.env.NODE_ENV !== 'production') {
    app.use(morgan('dev'));
  }



  /* ================================
    CORS (with credentials)
  ================================ */
  const allowedOriginsList = (process.env.APP_ORIGIN || 'http://localhost:3000')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  // allow localhost / 127.0.0.1 / LAN (192.168.x.x) on common dev ports
  const devOriginRegex = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+)(?::(3000|5173|8080|8081|19006))?$/;

  const corsOptions = {
    origin(origin, cb) {
      // allow tools like curl/Postman (no Origin header)
      if (!origin) return cb(null, true);

      if (allowedOriginsList.includes(origin) || devOriginRegex.test(origin)) {
        return cb(null, true);
      }
      return cb(new Error('CORS: origin not allowed: ' + origin));
    },
    credentials: true,
    methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
    allowedHeaders: ['Content-Type','Authorization'],
    exposedHeaders: ['Content-Disposition'],
  };

  app.use(cors(corsOptions));
  // Express 5 requires RegExp for wildcards:
  app.options(/^\/api\/.*/, cors(corsOptions));

  // (optional) log to confirm what Origin the browser is sending
  app.use((req, _res, next) => {
    if (req.method === 'OPTIONS' || req.path.startsWith('/api/')) {
      console.log('🔎 Origin:', req.headers.origin, '→', req.method, req.path);
    }
    next();
  });


  /* ================================
    Body Parsers
  ================================ */
  app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));  // form-encoded (if needed)

  /* ================================
    MongoDB Connection
  ================================ */
  mongoose.set('strictQuery', true);
  mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log('✅ Connected to MongoDB Atlas (RepoCluster → repositoryDB)'))
  .catch(err => {
    console.error('❌ MongoDB Connection Error:', err.message);
    process.exit(1);
  });

  /* ================================
    Routes
  ================================ */
  // ⚠️ Do NOT expose /uploads publicly; all files must go through guarded routes
  // const path = require('path');
  // app.use('/uploads', express.static(path.join(__dirname, 'uploads'))); // ← keep disabled

  // Route mounts
  app.use('/api/auth',       require('./routes/auth'));
  app.use('/api/admin',      require('./routes/admin'));      // if present
  app.use('/api/faculty',    require('./routes/faculty'));
  app.use('/api/student',    require('./routes/student'));
  app.use('/api/research',   require('./routes/research'));   // your guarded file upload/delivery routes
  app.use('/api/staff',      require('./routes/staff'));
  app.use('/api/repository', require('./routes/repositoryRoutes'));
  app.use('/api/ai',         require('./routes/aiRoutes'));   // if present
  app.use('/api/research-admin', require('./routes/researchAdmin')); // staff controls (upload/visibility)


  /* ================================
    Health & Root
  ================================ */
  app.get('/healthz', (req, res) => {
    res.json({ ok: true, uptime: process.uptime(), env: process.env.NODE_ENV || 'dev' });
  });

  app.get('/', (req, res) => {
    res.send('🚀 Research Repository API is running...');
  });

  /* ================================
    404 handler
  ================================ */
  app.use((req, res, next) => {
    res.status(404).json({ error: 'Route not found' });
  });

  /* ================================
    Centralized Error Handler
    - Catches thrown/next(err) & CORS errors
    - Handles Multer/file errors gracefully
  ================================ */
  app.use((err, req, res, next) => {
    // CORS errors
    if (err && /CORS/.test(err.message)) {
      return res.status(403).json({ error: err.message });
    }

    // Multer limits / file filter errors
    if (err && (err.code === 'LIMIT_FILE_SIZE' || err.message?.includes('Only PDF') || err.message?.includes('Only DOC'))) {
      return res.status(400).json({ error: err.message || 'Invalid file upload' });
    }

    console.error('❌ Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

/* ================================
  Start Server
================================ */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});


  /* ================================
    Process-level safety
  ================================ */
  process.on('unhandledRejection', (reason) => {
    console.error('🧨 Unhandled Rejection:', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('🧨 Uncaught Exception:', err);
  });
