import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { startTusd } from './utils/tusd';
import { validateUploadAuth } from './utils/uploadAuth';
import path from 'path';
import { unlinkSync } from 'fs';
import { Database, Encoder } from './database/mongodb';
import { generateVideoId } from './utils/videoId';
import { generateApiKey } from './utils/keyGenerator';
import { createApiKeyMiddleware } from './middleware/auth';
import { createAdminAuthMiddleware } from './middleware/adminAuth';
import { loadConfig } from './config/config';
import { pinFile, unpinFile, announceDHT } from './utils/ipfs';
import { JobDispatcher } from './dispatcher/jobDispatcher';
import { unwrapJWS, JWSAuthError } from './utils/jws';
import { CleanupService } from './utils/cleanup';
import { signUploadToken, generateTokenId, UploadTokenClaims } from './utils/uploadToken';

dotenv.config();

const app = express();
const config = loadConfig();

// Trust proxy to get correct protocol from X-Forwarded-Proto
app.set('trust proxy', true);

// Initialize database
const database = new Database(config.mongoUri, config.mongoDbName, config.mongoCollectionVideos);

// Initialize cleanup service
const cleanupService = new CleanupService(config.uploadDir, config.cleanupRetentionDays);

// Middleware
app.use(cors({
  exposedHeaders: ['X-Embed-URL', 'x-embed-url'],
}));
app.use(express.json());

// Increase timeout for TUS upload routes (default Node.js timeout is ~2min, videos need more)
app.use('/uploads', (req, res, next) => {
  res.setTimeout(30 * 60 * 1000); // 30 minutes
  next();
});

app.use(express.static('public'));

// Create auth middleware
const requireApiKey = createApiKeyMiddleware(database);
const requireAdminAuth = createAdminAuthMiddleware(config);

// Proxy /uploads to tusd — tusd handles TUS protocol, Concatenation extension, and parallel chunks.
// Use app.all (not app.use) so Express does NOT strip the /uploads prefix before forwarding.
// tusd v2 ignores HTTPResponse.Headers from hook responses entirely.
// We inject X-Embed-URL ourselves in proxyRes using two stores:
//   pending201EmbedUrls — FIFO queue: pushed in pre-create, consumed by the next 201
//   pending204EmbedUrls — Map by upload ID: set in pre-finish, consumed by the 204
const pending201EmbedUrls: string[] = [];
const pending204EmbedUrls = new Map<string, string>();

// app.use strips the mount path from req.url; app.all preserves it — tusd needs the full path.
const tusProxy = createProxyMiddleware({
  target: `http://127.0.0.1:${config.tusdPort}`,
  changeOrigin: false,
  xfwd: true,
  proxyTimeout: 30 * 60 * 1000,
  on: {
    proxyReq: (proxyReq, req) => {
      // xfwd appends ",http" to nginx's X-Forwarded-Proto. Fix: forward only the first value.
      const proto = req.headers['x-forwarded-proto'];
      if (proto) {
        const first = (Array.isArray(proto) ? proto[0] : proto).split(',')[0].trim();
        proxyReq.setHeader('X-Forwarded-Proto', first);
      }
    },
    proxyRes: (proxyRes, req) => {
      // Inject X-Embed-URL into the 201 (upload creation) for browser tus-js-client
      if (proxyRes.statusCode === 201 && pending201EmbedUrls.length > 0) {
        proxyRes.headers['x-embed-url'] = pending201EmbedUrls.shift()!;
      }
      // Inject X-Embed-URL into the 204 (upload complete) for mobile SDKs
      if (proxyRes.statusCode === 204) {
        const uploadId = (req.url || '').split('/').filter(Boolean).pop() || '';
        const embedUrl = pending204EmbedUrls.get(uploadId);
        if (embedUrl) {
          proxyRes.headers['x-embed-url'] = embedUrl;
          pending204EmbedUrls.delete(uploadId);
        }
      }
      const existing = (proxyRes.headers['access-control-expose-headers'] as string) || '';
      if (!existing.toLowerCase().includes('x-embed-url')) {
        proxyRes.headers['access-control-expose-headers'] =
          existing ? `${existing}, X-Embed-URL` : 'X-Embed-URL';
      }
    },
  },
});
// /uploads/token must be registered before the tusd proxy wildcard.
// app.all('/uploads/*') would otherwise swallow POST /uploads/token and
// forward it to tusd, which returns 412 (TUS Precondition Failed).
app.post('/uploads/token', requireApiKey, async (req: Request, res: Response) => {
  try {
    if (!config.uploadTokenSecret) {
      return res.status(503).json({
        error: 'Upload tokens are not configured',
        message: 'Set UPLOAD_TOKEN_SECRET to enable upload tokens',
      });
    }

    const { owner, frontend_app, short = false, allowed_origins = [], max_file_size, ttl } = req.body;

    if (!owner || typeof owner !== 'string') {
      return res.status(422).json({ error: 'owner (string) is required' });
    }

    const tokenTtl = Math.min(
      typeof ttl === 'number' && ttl > 0 ? ttl : config.uploadTokenDefaultTtl,
      config.uploadTokenMaxTtl
    );

    const maxFileSize = typeof max_file_size === 'number' && max_file_size > 0
      ? Math.min(max_file_size, config.uploadTokenMaxFileSize)
      : config.uploadTokenMaxFileSize;

    const now = Math.floor(Date.now() / 1000);
    const apiKeyData = (req as any).apiKey;

    // Assign the permlink here, at token issuance, and bind it to the token.
    // The client receives it in the response (permlink/embed_url below) and can
    // build the canonical embed URL without scraping a TUS response header —
    // which is what makes parallel/Concatenation uploads reliable.
    const permlink = generateVideoId();

    const claims: UploadTokenClaims = {
      jti: generateTokenId(),
      owner,
      app: frontend_app || apiKeyData?.app_name || 'unknown',
      issuedByKey: apiKeyData?.app_name || 'unknown',
      short: !!short,
      maxFileSize,
      allowedOrigins: Array.isArray(allowed_origins) ? allowed_origins : [],
      permlink,
      iat: now,
      exp: now + tokenTtl,
    };

    const token = signUploadToken(claims, config.uploadTokenSecret);
    const expiresAt = new Date(claims.exp * 1000).toISOString();
    const embedUrl = `${config.baseUrl}?v=${owner}/${permlink}`;

    console.log(`Upload token issued: ${owner}/${permlink} via ${claims.app} (ttl=${tokenTtl}s, jti=${claims.jti.slice(0, 8)}...)`);

    res.status(201).json({
      success: true,
      token,
      upload_url: `${req.protocol}://${req.get('host')}/uploads`,
      permlink,
      embed_url: embedUrl,
      expires_at: expiresAt,
    });
  } catch (error) {
    console.error('Error creating upload token:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.all('/uploads', tusProxy);
app.all('/uploads/*', tusProxy);

// Hook endpoint called by tusd for pre-create and post-finish events.
// Bound to 127.0.0.1 in tusd config — but guard here as defence-in-depth.
app.post('/tusd-hooks', express.json({ limit: '1mb' }), async (req: Request, res: Response) => {
  const remoteAddr = req.socket.remoteAddress;
  if (remoteAddr !== '127.0.0.1' && remoteAddr !== '::1' && remoteAddr !== '::ffff:127.0.0.1') {
    return res.status(403).json({});
  }

  const { Type, Event } = req.body;
  const { Upload, HTTPRequest } = Event || {};

  if (Type === 'pre-create') {
    const isPartial = !!Upload?.IsPartial;
    const authResult = await validateUploadAuth(
      HTTPRequest?.Header || {},
      Upload?.MetaData || {},
      Upload?.Size || null,
      database,
      config,
      isPartial
    );

    if (!authResult.ok) {
      return res.json({
        RejectUpload: true,
        HTTPResponse: {
          StatusCode: authResult.status,
          Body: JSON.stringify({ error: authResult.error }),
          Headers: { 'Content-Type': 'application/json' },
        },
      });
    }

    // Partial uploads are just chunk pieces — allow through without a DB record or embed URL.
    if (isPartial) {
      return res.json({});
    }

    const { owner, permlink, frontend_app, short, originalFilename, duration, size } = authResult;

    // Hard size cap, enforced for every upload regardless of auth method.
    // For parallel/Concatenation uploads this fires on the final concat, whose
    // Size is the sum of the already-uploaded parts.
    if (size != null && size > config.maxUploadSize) {
      console.warn(`Upload rejected: ${owner}/${permlink} size ${size} bytes exceeds cap ${config.maxUploadSize}`);
      return res.json({
        RejectUpload: true,
        HTTPResponse: {
          StatusCode: 413,
          Body: JSON.stringify({
            error: `Video exceeds the maximum allowed size of ${Math.round(config.maxUploadSize / (1024 * 1024 * 1024))}GB`,
          }),
          Headers: { 'Content-Type': 'application/json' },
        },
      });
    }

    console.log(`Upload metadata - short flag: "${Upload?.MetaData?.short}" -> parsed as: ${short}`);

    await database.createVideoEntry({
      owner,
      permlink,
      frontend_app,
      status: 'uploading',
      input_cid: null,
      ipfs_pin_endpoint: null,
      manifest_cid: null,
      thumbnail_url: null,
      short,
      duration,
      size,
      encodingProgress: 0,
      originalFilename,
      hive_author: null,
      hive_permlink: null,
      hive_title: null,
      hive_body: null,
      hive_tags: null,
      embed_url: null,
      embed_title: null,
      listed_on_3speak: frontend_app === '3speak-tv',
      processed: false,
      processedAt: null,
      views: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const embedUrl = `${config.baseUrl}?v=${owner}/${permlink}`;
    console.log(`Upload created: ${owner}/${permlink} [${frontend_app}] (${short ? 'short' : 'long'}, ${size} bytes)`);

    // Queue the embed URL so proxyRes can inject it into the 201 response.
    pending201EmbedUrls.push(embedUrl);
    setTimeout(() => {
      const idx = pending201EmbedUrls.indexOf(embedUrl);
      if (idx !== -1) pending201EmbedUrls.splice(idx, 1);
    }, 60_000);

    return res.json({
      ChangeFileInfo: {
        MetaData: {
          permlink,
          owner,
          frontend_app,
          short: String(short),
          originalFilename: originalFilename || '',
        },
      },
    });
  }

  if (Type === 'pre-finish') {
    // Store embed URL so proxyRes can inject it into the 204 response.
    if (!Upload?.IsPartial) {
      const { permlink, owner } = Upload?.MetaData || {};
      if (permlink && owner && Upload?.ID) {
        const embedUrl = `${config.baseUrl}?v=${owner}/${permlink}`;
        pending204EmbedUrls.set(Upload.ID, embedUrl);
        setTimeout(() => pending204EmbedUrls.delete(Upload.ID), 60_000);
      }
    }
    return res.json({});
  }

  if (Type === 'post-finish') {
    // Respond immediately — tusd already sent 204 to client. IPFS + job creation happen async.
    res.json({});

    if (!Upload?.IsPartial) {
      const filePath = Upload?.Storage?.Path;
      const meta = Upload?.MetaData || {};
      setImmediate(() => {
        processUploadAsync(filePath, meta, Upload?.Size || null, database, config)
          .catch((err: Error) => console.error('post-finish async error:', err));
      });
    }
    return;
  }

  return res.json({});
});

// Process completed upload: pin to IPFS, create encoding job, clean up temp file.
// Called asynchronously after tusd sends 204 to client — client does NOT wait for this.
async function processUploadAsync(
  filePath: string,
  meta: Record<string, string>,
  uploadSize: number | null,
  db: Database,
  cfg: typeof config
): Promise<void> {
  const permlink = meta.permlink;
  const owner = meta.owner;
  const short = meta.short === 'true';
  const originalFilename = meta.originalFilename || null;

  if (!permlink || !owner || !filePath) {
    console.error('post-finish: missing permlink, owner, or filePath', { permlink, owner, filePath });
    return;
  }

  try {
    console.log(`Pinning file to IPFS: ${filePath}`);
    const { cid: input_cid, endpoint: ipfs_pin_endpoint } = await pinFile(filePath);
    console.log(`File pinned successfully: ${input_cid} at ${ipfs_pin_endpoint}`);

    try {
      await announceDHT(input_cid);
    } catch (dhtError) {
      console.warn(`DHT announcement failed (non-critical): ${dhtError}`);
    }

    await db.updateVideoStatus(permlink, 'processing', {
      size: uploadSize,
      input_cid,
      ipfs_pin_endpoint,
      encodingProgress: 0,
    });

    try {
      await db.incrementUserUpload(owner, uploadSize || 0);
    } catch (statsError) {
      console.warn(`Failed to update user stats: ${statsError}`);
    }

    const premium = await db.isUserPremium(owner);
    await db.createJob({
      owner,
      permlink,
      status: 'pending',
      assignedWorker: null,
      encoderJobId: null,
      assignedAt: null,
      attemptCount: 0,
      lastError: null,
      encodingProgress: null,
      encodingStage: null,
      webhookReceivedAt: null,
      premium,
      short,
      fileSize: uploadSize,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    console.log(`Upload processed: ${owner}/${permlink} - Pinned: ${input_cid} - Job created`);

    try {
      unlinkSync(filePath);
      console.log(`Temp file cleaned up: ${filePath}`);
    } catch (cleanupError) {
      console.warn(`Failed to cleanup temp file: ${cleanupError}`);
    }
  } catch (error) {
    console.error(`processUploadAsync error for ${owner}/${permlink}:`, error);
    await db.updateVideoStatus(permlink, 'failed', { encodingProgress: 0 });
  }
}

// Create uploads directory if it doesn't exist
const uploadPath = path.resolve(config.uploadDir);
// Demo page endpoint
app.get('/', (req: Request, res: Response) => {
  res.redirect('/demo.html');
});

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', service: '3speak-video-upload' });
});

// Webhook endpoint for encoder callbacks
app.post('/webhook', async (req: Request, res: Response) => {
  try {
    // Verify webhook API key — accept global key (managed) or per-job token (community)
    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (apiKey !== config.webhookApiKey) {
      // Check per-job callback token
      const { owner: o, permlink: p } = req.body;
      if (!o || !p || !apiKey) {
        console.warn('Webhook received with invalid API key');
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const job = await database.getJob(o, p);
      if (!job || !job.callbackToken || job.callbackToken !== apiKey) {
        console.warn('Webhook received with invalid callback token');
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const {
      owner,
      permlink,
      status,
      manifest_cid,
      video_url,
      job_id,
      processing_time_seconds,
      qualities_encoded,
      encoder_id,
      error: encoderError,
      timestamp,
    } = req.body;

    console.log(`Webhook received: ${owner}/${permlink} - Status: ${status}`);

    if (status === 'complete') {
      // Update video with manifest_cid and mark as published
      await database.updateVideoStatus(permlink, 'published', {
        manifest_cid,
        encodingProgress: 100,
      });

      // Update job as completed
      await database.updateJobStatus(owner, permlink, 'completed', {
        webhookReceivedAt: new Date(),
      });
      
      // Update user stats for successful encoding
      try {
        await database.incrementUserSuccess(owner);
      } catch (statsError) {
        console.warn(`Failed to update user success stats: ${statsError}`);
      }

      // Unpin the input_cid now that encoding is complete
      try {
        const video = await database.getVideo(permlink);
        if (video && video.input_cid && video.ipfs_pin_endpoint) {
          console.log(`Unpinning input file for ${owner}/${permlink}: ${video.input_cid} from ${video.ipfs_pin_endpoint}`);
          await unpinFile(video.input_cid, video.ipfs_pin_endpoint);
        }
      } catch (unpinError) {
        console.warn(`Failed to unpin input_cid for ${owner}/${permlink}:`, unpinError);
        // Continue despite unpin failure
      }

      console.log(`Video encoding completed: ${owner}/${permlink} - Manifest: ${manifest_cid}`);
      res.json({ success: true, message: 'Webhook processed successfully' });
    } else if (status === 'failed') {
      // Retry budget: requeue up to 2 times before giving up permanently.
      // attemptCount tracks all prior encode attempts (dispatch failures + webhook failures).
      const MAX_ENCODE_ATTEMPTS = 2;
      const job = await database.getJob(owner, permlink);

      if (job && job.attemptCount < MAX_ENCODE_ATTEMPTS) {
        // Still within retry budget — requeue for the dispatcher to pick up.
        const nextAttempt = job.attemptCount + 1;
        await database.updateJobStatus(owner, permlink, 'pending', {
          webhookReceivedAt: new Date(),
          lastError: `${encoderError || 'Encoding failed'} (attempt ${nextAttempt}/${MAX_ENCODE_ATTEMPTS + 1}, requeueing)`,
          assignedWorker: null,
          encoderJobId: null,
          assignedAt: null,
          encodingProgress: null,
          encodingStage: null,
        });
        await database.incrementJobAttempt(owner, permlink);
        await database.updateVideoStatus(permlink, 'processing', { encodingProgress: 0 });
        console.warn(`Encoding failed for ${owner}/${permlink} (attempt ${nextAttempt}/${MAX_ENCODE_ATTEMPTS + 1}): ${encoderError} — requeueing`);
        res.json({ success: true, message: 'Webhook processed (failure recorded, job requeued)' });
      } else {
        // Retry budget exhausted — permanent failure.
        await database.updateVideoStatus(permlink, 'failed', { encodingProgress: 0 });
        await database.updateJobStatus(owner, permlink, 'failed', {
          webhookReceivedAt: new Date(),
          lastError: encoderError || 'Encoding failed',
        });

        try {
          await database.incrementUserFailure(owner);
        } catch (statsError) {
          console.warn(`Failed to update user failure stats: ${statsError}`);
        }

        // DO NOT unpin on failure - keep the file for potential retry or debugging

        console.error(`Video encoding permanently failed for ${owner}/${permlink} after ${(job?.attemptCount ?? 0) + 1} attempt(s): ${encoderError}`);
        res.json({ success: true, message: 'Webhook processed (failure recorded)' });
      }
    } else {
      console.warn(`Unknown webhook status: ${status}`);
      res.status(400).json({ error: 'Unknown status' });
    }
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Webhook endpoint for encoder progress pings
app.post('/webhook/progress', async (req: Request, res: Response) => {
  try {
    const apiKey = req.headers['x-api-key'] as string | undefined;
    const { owner, permlink, progress, stage } = req.body;

    if (!owner || !permlink || typeof progress !== 'number') {
      return res.status(400).json({ error: 'owner, permlink, and progress (number) are required' });
    }

    const job = await database.getJob(owner, permlink);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Verify auth — global key (managed) or per-job token (community)
    if (apiKey !== config.webhookApiKey) {
      if (!apiKey || !job.callbackToken || job.callbackToken !== apiKey) {
        console.warn('Progress webhook received with invalid API key');
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    await database.updateJobStatus(owner, permlink, 'encoding', {
      encodingProgress: progress,
      encodingStage: stage ?? null,
    });

    await database.updateVideoStatus(permlink, 'processing', {
      encodingProgress: progress,
    });

    console.log(`Progress update: ${owner}/${permlink} - ${progress}%${stage ? ` (${stage})` : ''}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Progress webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Community encoder endpoints (JWS-authenticated)

// Registration
app.post('/api/v0/gateway/updateNode', async (req: Request, res: Response) => {
  try {
    const { payload, did } = await unwrapJWS(req.body.jws);

    // Accept both node_info wrapper and flat payload
    const nodeInfo = payload.node_info || payload;
    const name = nodeInfo.name;
    const hiveAccount = nodeInfo.cryptoAccounts?.hive || nodeInfo.hive_account;
    const peerId = nodeInfo.peer_id;
    const commitHash = nodeInfo.commit_hash;

    const encoder = await database.upsertCommunityEncoder(did, {
      name,
      hiveAccount,
      peerId,
      commitHash,
    });

    console.log(`Community encoder registered: ${encoder.name} (${did})${hiveAccount ? ` [hive: ${hiveAccount}]` : ''}`);
    res.json({
      success: true,
      encoder: {
        name: encoder.name,
        did: encoder.did,
        tier: encoder.tier,
        access: encoder.access,
        enabled: encoder.enabled,
      },
    });
  } catch (error) {
    console.error('Community registration error:', error);
    if (error instanceof JWSAuthError) {
      return res.status(401).json({ error: 'Invalid JWS signature' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Job polling
app.post('/api/v0/gateway/myJob', async (req: Request, res: Response) => {
  try {
    const { did } = await unwrapJWS(req.body.jws);

    const encoder = await database.getEncoderByDid(did);
    if (!encoder) {
      return res.status(404).json({ error: 'Encoder not registered' });
    }
    if (!encoder.enabled || encoder.banned) {
      return res.status(403).json({ error: 'Encoder is disabled or banned' });
    }

    await database.updateEncoderLastSeen(did);

    const job = await database.claimNextCommunityJob(encoder.name, encoder.maxFileSize ?? null);
    if (!job) {
      return res.json({ success: true, job: null });
    }

    // Fetch video metadata for the job payload
    const video = await database.getVideo(job.permlink);
    if (!video || !video.input_cid) {
      // Job was claimed but video is missing — reset it
      await database.resetJob(job.owner, job.permlink);
      return res.json({ success: true, job: null });
    }

    const ipfsGateway = 'https://ipfs.3speak.tv/ipfs';
    console.log(`Community encoder [${encoder.name}] claimed job: ${job.owner}/${job.permlink}`);
    res.json({
      success: true,
      job: {
        owner: job.owner,
        permlink: job.permlink,
        input_cid: `${ipfsGateway}/${video.input_cid}`,
        short: video.short,
        premium: false,
        webhook_url: config.webhookUrl,
        api_key: job.callbackToken,
        frontend_app: video.frontend_app,
        originalFilename: video.originalFilename,
      },
    });
  } catch (error) {
    console.error('Community job poll error:', error);
    if (error instanceof JWSAuthError) {
      return res.status(401).json({ error: 'Invalid JWS signature' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Heartbeat
app.post('/api/v0/gateway/heartbeat', async (req: Request, res: Response) => {
  try {
    const { did } = await unwrapJWS(req.body.jws);

    const encoder = await database.getEncoderByDid(did);
    if (!encoder) {
      return res.status(404).json({ error: 'Encoder not registered' });
    }

    await database.updateEncoderLastSeen(did);
    res.json({ success: true });
  } catch (error) {
    console.error('Community heartbeat error:', error);
    if (error instanceof JWSAuthError) {
      return res.status(401).json({ error: 'Invalid JWS signature' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Public community encoder status — for monitoring dashboards
app.get('/api/v0/encoders/community', async (req: Request, res: Response) => {
  try {
    const allEncoders = await database.getAllEncoders();
    const now = Date.now();
    const ALIVE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

    const community = allEncoders
      .filter(e => (e.access ?? 'managed') === 'community')
      .map(e => ({
        name: e.name,
        enabled: e.enabled,
        banned: e.banned ?? false,
        lastSeenAt: e.lastSeenAt ?? null,
        alive: e.lastSeenAt ? (now - new Date(e.lastSeenAt).getTime()) < ALIVE_THRESHOLD_MS : false,
      }));

    res.json({ success: true, encoders: community });
  } catch (error) {
    console.error('Community encoder status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get video metadata endpoint
app.get('/video/:permlink', async (req: Request, res: Response) => {
  try {
    const { permlink } = req.params;
    const video = await database.getVideo(permlink);
    
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }
    
    res.json(video);
  } catch (error) {
    console.error('Error fetching video:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Check if a user has premium status (protected by API key)
app.get('/users/:username/premium', requireApiKey, async (req: Request, res: Response) => {
  try {
    const { username } = req.params;
    const user = await database.getUser(username);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    const premium = user.premium ?? false;
    res.json({ username, premium });
  } catch (error) {
    console.error('Error checking premium status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update video thumbnail endpoint (protected)
app.post('/video/:permlink/thumbnail', requireApiKey, async (req: Request, res: Response) => {
  try {
    const { permlink } = req.params;
    const { thumbnail_url } = req.body;
    
    if (!thumbnail_url) {
      return res.status(400).json({ error: 'thumbnail_url is required' });
    }
    
    // Check if video exists
    const video = await database.getVideo(permlink);
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }
    
    // Update thumbnail URL
    await database.updateVideoStatus(permlink, video.status, {
      thumbnail_url,
    });
    
    console.log(`Thumbnail updated for ${video.owner}/${permlink}`);
    res.json({ success: true, thumbnail_url });
  } catch (error) {
    console.error('Error updating thumbnail:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Link embed video to a Hive post (protected)
app.post('/video/:permlink/hive', requireApiKey, async (req: Request, res: Response) => {
  try {
    const { permlink } = req.params;
    const { hive_author, hive_permlink, hive_title, hive_body, hive_tags } = req.body;

    if (!hive_author || !hive_permlink) {
      return res.status(400).json({ error: 'hive_author and hive_permlink are required' });
    }

    const video = await database.getVideo(permlink);
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    await database.updateVideoStatus(permlink, video.status, {
      hive_author,
      hive_permlink,
      embed_url: `@${hive_author}/${hive_permlink}`,
      processed: true,
      ...(hive_title ? { hive_title } : {}),
      ...(hive_body ? { hive_body } : {}),
      ...(hive_tags ? { hive_tags } : {}),
    });

    console.log(`Hive link set for ${video.owner}/${permlink} -> @${hive_author}/${hive_permlink}`);
    res.json({ success: true, permlink, hive_author, hive_permlink });
  } catch (error) {
    console.error('Error linking Hive post:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Force re-dispatch a stuck job (protected)
app.post('/admin/jobs/:owner/:permlink/redispatch', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { owner, permlink } = req.params;

    const job = await database.getJob(owner, permlink);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const video = await database.getVideo(permlink);
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    if (!video.input_cid) {
      return res.status(400).json({ error: 'Video has no input_cid — nothing to dispatch' });
    }

    await database.resetJob(owner, permlink);
    await database.updateVideoStatus(permlink, 'processing', { encodingProgress: 0 });

    console.log(`Job manually reset to pending by admin: ${owner}/${permlink} (was: ${job.status})`);
    res.json({
      success: true,
      message: 'Job reset to pending. Dispatcher will pick it up on the next cycle.',
      job: { owner, permlink, previousStatus: job.status },
    });
  } catch (error) {
    console.error('Error re-dispatching job:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Create API Key (protected)
app.post('/admin/api-keys', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { app_name, owner } = req.body;
    
    if (!app_name || !owner) {
      return res.status(400).json({ error: 'app_name and owner are required' });
    }
    
    // Generate secure API key
    const key = generateApiKey(app_name);
    
    const apiKey = {
      key,
      app_name,
      owner,
      active: true,
      createdAt: new Date(),
      lastUsed: null,
    };
    
    await database.createApiKey(apiKey);
    
    console.log(`API key created for ${app_name} (${owner})`);
    res.json({ success: true, key, app_name, owner });
  } catch (error) {
    console.error('Error creating API key:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: List all API Keys (protected)
app.get('/admin/api-keys', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const keys = await database.getAllApiKeys();
    res.json({ keys });
  } catch (error) {
    console.error('Error fetching API keys:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Update API Key Status (activate/deactivate) (protected)
app.patch('/admin/api-keys/:key', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    const { active } = req.body;
    
    if (typeof active !== 'boolean') {
      return res.status(400).json({ error: 'active must be a boolean' });
    }
    
    const apiKey = await database.getApiKey(key);
    if (!apiKey) {
      return res.status(404).json({ error: 'API key not found' });
    }
    
    await database.updateApiKeyStatus(key, active);
    
    console.log(`API key ${key} ${active ? 'activated' : 'deactivated'}`);
    res.json({ success: true, key, active });
  } catch (error) {
    console.error('Error updating API key:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: List all users (protected)
app.get('/admin/users', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const skip = parseInt(req.query.skip as string) || 0;
    const search = req.query.search as string;
    const users = await database.getAllUsers(limit, skip, search);
    res.json({ users });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Ban/Unban user (protected)
app.patch('/admin/users/:username/ban', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { username } = req.params;
    const { banned } = req.body;
    
    if (typeof banned !== 'boolean') {
      return res.status(400).json({ error: 'banned must be a boolean' });
    }
    
    const user = await database.getUser(username);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    await database.banUser(username, banned);
    
    console.log(`User ${username} ${banned ? 'banned' : 'unbanned'}`);
    res.json({ success: true, username, banned });
  } catch (error) {
    console.error('Error banning user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Set/remove premium status (protected)
app.patch('/admin/users/:username/premium', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { username } = req.params;
    const { premium } = req.body;

    if (typeof premium !== 'boolean') {
      return res.status(400).json({ error: 'premium must be a boolean' });
    }

    const user = await database.getUser(username);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await database.setUserPremium(username, premium);

    console.log(`User ${username} premium status set to ${premium}`);
    res.json({ success: true, username, premium });
  } catch (error) {
    console.error('Error setting premium status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Cleanup preview (protected)
app.get('/admin/cleanup/preview', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const preview = await cleanupService.previewCleanup();
    const totalMB = (preview.totalSize / (1024 * 1024)).toFixed(2);
    res.json({
      filesCount: preview.files.length,
      totalSizeMB: totalMB,
      retentionDays: config.cleanupRetentionDays,
      files: preview.files.map(f => ({
        name: f.name,
        sizeMB: (f.size / (1024 * 1024)).toFixed(2),
        ageDays: f.age.toFixed(1),
      })),
    });
  } catch (error) {
    console.error('Error previewing cleanup:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Manual cleanup trigger (protected)
app.post('/admin/cleanup/run', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    console.log('Manual cleanup triggered by admin');
    const stats = await cleanupService.runCleanup();
    const mbFreed = (stats.bytesFreed / (1024 * 1024)).toFixed(2);
    res.json({
      success: true,
      filesScanned: stats.filesScanned,
      filesDeleted: stats.filesDeleted,
      bytesFreed: stats.bytesFreed,
      mbFreed,
      errors: stats.errors,
    });
  } catch (error) {
    console.error('Error running cleanup:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: List all encoders (protected) - API keys are stripped for security
app.get('/admin/encoders', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const encoders = await database.getAllEncoders();
    // Strip apiKey from response to prevent exposure
    const sanitized = encoders.map(({ apiKey, ...rest }) => rest);
    res.json({ encoders: sanitized });
  } catch (error) {
    console.error('Error fetching encoders:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Add encoder (protected)
app.post('/admin/encoders', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { name, url, apiKey, enabled = true, access = 'managed', tier = 'standard', maxFileSize } = req.body;

    if (!name || !url || !apiKey) {
      return res.status(400).json({ error: 'name, url, and apiKey are required' });
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    // Validate access and tier values
    const validAccess = ['managed', 'community'];
    const validTiers = ['performance', 'standard', 'lite'];
    if (!validAccess.includes(access)) {
      return res.status(400).json({ error: `access must be one of: ${validAccess.join(', ')}` });
    }
    if (!validTiers.includes(tier)) {
      return res.status(400).json({ error: `tier must be one of: ${validTiers.join(', ')}` });
    }
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    if (maxFileSize !== undefined && maxFileSize !== null &&
        (typeof maxFileSize !== 'number' || !Number.isFinite(maxFileSize) || maxFileSize <= 0)) {
      return res.status(400).json({ error: 'maxFileSize must be a positive number or null' });
    }

    const existing = await database.getEncoder(name);
    if (existing) {
      return res.status(409).json({ error: `Encoder '${name}' already exists` });
    }

    await database.createEncoder({
      name,
      url,
      apiKey,
      enabled,
      access,
      tier,
      ...(maxFileSize !== undefined && { maxFileSize }),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    console.log(`Encoder added: ${name} (${url}) [${access}/${tier}]`);
    res.json({ success: true, name, url, enabled, access, tier });
  } catch (error) {
    console.error('Error adding encoder:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Update encoder (enable/disable, change url or apiKey) (protected)
app.patch('/admin/encoders/:name', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const { url, apiKey, enabled, access, tier, maxFileSize, banned } = req.body;

    const encoder = await database.getEncoder(name);
    if (!encoder) {
      return res.status(404).json({ error: 'Encoder not found' });
    }

    const updates: Record<string, any> = {};
    if (url !== undefined) {
      // Validate URL format
      try {
        new URL(url);
      } catch {
        return res.status(400).json({ error: 'Invalid URL format' });
      }
      updates.url = url;
    }
    if (apiKey !== undefined) updates.apiKey = apiKey;
    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled must be a boolean' });
      }
      updates.enabled = enabled;
    }
    if (access !== undefined) {
      const validAccess = ['managed', 'community'];
      if (!validAccess.includes(access)) {
        return res.status(400).json({ error: `access must be one of: ${validAccess.join(', ')}` });
      }
      updates.access = access;
    }
    if (tier !== undefined) {
      const validTiers = ['performance', 'standard', 'lite'];
      if (!validTiers.includes(tier)) {
        return res.status(400).json({ error: `tier must be one of: ${validTiers.join(', ')}` });
      }
      updates.tier = tier;
    }
    if (maxFileSize !== undefined) {
      if (maxFileSize !== null &&
          (typeof maxFileSize !== 'number' || !Number.isFinite(maxFileSize) || maxFileSize <= 0)) {
        return res.status(400).json({ error: 'maxFileSize must be a positive number or null' });
      }
      updates.maxFileSize = maxFileSize;
    }

    if (banned !== undefined) {
      if (typeof banned !== 'boolean') {
        return res.status(400).json({ error: 'banned must be a boolean' });
      }
      updates.banned = banned;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    await database.updateEncoder(name, updates);

    console.log(`Encoder updated: ${name}`);
    res.json({ success: true, name, updates });
  } catch (error) {
    console.error('Error updating encoder:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Remove encoder (protected)
app.delete('/admin/encoders/:name', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { name } = req.params;

    const encoder = await database.getEncoder(name);
    if (!encoder) {
      return res.status(404).json({ error: 'Encoder not found' });
    }

    await database.deleteEncoder(name);

    console.log(`Encoder removed: ${name}`);
    res.json({ success: true, name });
  } catch (error) {
    console.error('Error removing encoder:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Encoder stats (aggregated from embed-jobs) (protected)
app.get('/admin/encoder-stats', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const period = (req.query.period as string) || '24h';
    const periodMs: Record<string, number> = {
      '24h': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000,
    };

    if (!periodMs[period]) {
      return res.status(400).json({ error: 'period must be one of: 24h, 7d, 30d' });
    }

    const since = new Date(Date.now() - periodMs[period]);
    const jobs = await database.getCompletedJobStats(since);
    const encoders = await database.getAllEncoders();

    // Build encoder lookup for tier/access metadata
    const encoderMap = new Map<string, Encoder>();
    for (const enc of encoders) {
      encoderMap.set(enc.name, enc);
    }

    // Group jobs by assignedWorker
    const grouped = new Map<string, typeof jobs>();
    for (const job of jobs) {
      const worker = job.assignedWorker ?? 'unknown';
      if (!grouped.has(worker)) grouped.set(worker, []);
      grouped.get(worker)!.push(job);
    }

    // Compute per-encoder metrics
    const encoderStats = Array.from(grouped.entries()).map(([encoderName, encoderJobs]) => {
      const encoder = encoderMap.get(encoderName);
      const completed = encoderJobs.filter(j => j.status === 'completed');
      const failed = encoderJobs.filter(j => j.status === 'failed');

      // Compute avg encode time from completed jobs with valid timestamps
      const encodeTimes = completed
        .filter(j => j.assignedAt && j.webhookReceivedAt)
        .map(j => new Date(j.webhookReceivedAt!).getTime() - new Date(j.assignedAt!).getTime());
      const avgEncodeTimeMs = encodeTimes.length > 0
        ? Math.round(encodeTimes.reduce((a, b) => a + b, 0) / encodeTimes.length)
        : 0;

      return {
        encoderName,
        tier: encoder?.tier ?? 'standard',
        access: encoder?.access ?? 'managed',
        totalJobs: encoderJobs.length,
        completedJobs: completed.length,
        failedJobs: failed.length,
        successRate: encoderJobs.length > 0
          ? Math.round((completed.length / encoderJobs.length) * 1000) / 10
          : 0,
        avgEncodeTimeMs,
      };
    });

    // Compute aggregate metrics
    const totalJobs = jobs.length;
    const totalCompleted = jobs.filter(j => j.status === 'completed').length;
    const totalFailed = jobs.filter(j => j.status === 'failed').length;
    const allEncodeTimes = jobs
      .filter(j => j.status === 'completed' && j.assignedAt && j.webhookReceivedAt)
      .map(j => new Date(j.webhookReceivedAt!).getTime() - new Date(j.assignedAt!).getTime());
    const periodHours = periodMs[period] / (60 * 60 * 1000);

    res.json({
      period,
      since: since.toISOString(),
      aggregate: {
        totalJobs,
        completedJobs: totalCompleted,
        failedJobs: totalFailed,
        successRate: totalJobs > 0
          ? Math.round((totalCompleted / totalJobs) * 1000) / 10
          : 0,
        avgEncodeTimeMs: allEncodeTimes.length > 0
          ? Math.round(allEncodeTimes.reduce((a, b) => a + b, 0) / allEncodeTimes.length)
          : 0,
        jobsPerHour: periodHours > 0
          ? Math.round((totalJobs / periodHours) * 10) / 10
          : 0,
      },
      encoders: encoderStats,
    });
  } catch (error) {
    console.error('Error fetching encoder stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server
let dispatcher: JobDispatcher;
let tusdProcess: ReturnType<typeof startTusd> | null = null;

async function start() {
  try {
    await database.connect(config.mongoDbName, config.mongoCollectionVideos);

    // Initialize upload token collection (TTL indexes for auto-cleanup)
    if (config.uploadTokenSecret) {
      await database.initUploadTokenCollection();
    } else {
      console.log('Upload token auth disabled (UPLOAD_TOKEN_SECRET not set)');
    }

    // Ensure demo API key exists
    const demoKey = await database.getApiKey(config.demoApiKey);
    if (!demoKey) {
      await database.createApiKey({
        key: config.demoApiKey,
        app_name: 'demo',
        owner: 'system',
        active: true,
        createdAt: new Date(),
        lastUsed: null,
      });
      console.log('Demo API key created');
    }
    
    // Seed encoders from env var that don't already exist in DB (backwards-compatible)
    const existingEncoders = await database.getAllEncoders();
    const existingNames = new Set(existingEncoders.map(e => e.name));
    const encodersToSeed = config.encoders.filter(e => !existingNames.has(e.name));
    
    if (encodersToSeed.length > 0) {
      console.log(`Seeding ${encodersToSeed.length} new encoder(s) from env into DB...`);
      for (const e of encodersToSeed) {
        await database.createEncoder({
          name: e.name,
          url: e.url,
          apiKey: e.apiKey,
          enabled: e.enabled,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        console.log(`  Seeded encoder: ${e.name}`);
      }
    }

    // Log current encoder pool
    const activeEncoders = (await database.getAllEncoders()).filter(e => e.enabled);
    if (activeEncoders.length > 0) {
      console.log(`Encoders available (${activeEncoders.length}):`);
      activeEncoders.forEach(e => console.log(`  - ${e.name}: ${e.url}`));
    } else {
      console.warn('⚠️  No enabled encoders in DB! Jobs will fail to dispatch.');
    }
    
    // Start job dispatcher (skip on secondary deployments — the dispatch path
    // isn't atomic across replicas, so two pollers can double-dispatch the same job).
    if (config.dispatcherEnabled) {
      dispatcher = new JobDispatcher(database, config);
      dispatcher.start(30); // Poll every 30 seconds
    } else {
      console.log('Job dispatcher disabled (DISPATCHER_ENABLED=false)');
    }

    // Start cleanup service
    if (config.cleanupEnabled) {
      cleanupService.start(config.cleanupIntervalHours);
    } else {
      console.log('Cleanup service disabled');
    }

    const server = app.listen(config.port, () => {
      console.log(`Server running on port ${config.port}`);
      console.log(`TUS endpoint: http://localhost:${config.port}/uploads`);
      // Start tusd after Express is listening so the hook endpoint is ready
      tusdProcess = startTusd(config, config.port);
    });

    server.requestTimeout = 30 * 60 * 1000;
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  if (tusdProcess) tusdProcess.kill('SIGTERM');
  if (dispatcher) dispatcher.stop();
  cleanupService.stop();
  await database.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  if (tusdProcess) tusdProcess.kill('SIGTERM');
  if (dispatcher) {
    dispatcher.stop();
  }
  cleanupService.stop();
  await database.close();
  process.exit(0);
});

start();
