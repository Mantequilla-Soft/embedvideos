import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Server } from '@tus/server';
import { FileStore } from '@tus/file-store';
import path from 'path';
import { unlinkSync } from 'fs';
import { Database } from './database/mongodb';
import { generateVideoId } from './utils/videoId';
import { generateApiKey } from './utils/keyGenerator';
import { createApiKeyMiddleware } from './middleware/auth';
import { createAdminAuthMiddleware } from './middleware/adminAuth';
import { loadConfig } from './config/config';
import { pinFile, unpinFile, announceDHT } from './utils/ipfs';
import { JobDispatcher } from './dispatcher/jobDispatcher';
import { CleanupService } from './utils/cleanup';

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

// Ensure X-Embed-URL is exposed via CORS on TUS upload routes
// (The @tus/server sets its own Access-Control-Expose-Headers, overriding Express cors middleware)
app.use('/uploads', (req, res, next) => {
  const origSetHeader = res.setHeader.bind(res);
  res.setHeader = function(name: string, value: any) {
    if (name.toLowerCase() === 'access-control-expose-headers' && typeof value === 'string') {
      if (!value.includes('X-Embed-URL')) {
        value = value + ', X-Embed-URL';
      }
    }
    return origSetHeader(name, value);
  } as any;
  next();
});
app.use(express.static('public'));

// Create auth middleware
const requireApiKey = createApiKeyMiddleware(database);
const requireAdminAuth = createAdminAuthMiddleware(config);

// Create uploads directory if it doesn't exist
const uploadPath = path.resolve(config.uploadDir);

// TUS server setup
const tusServer = new Server({
  path: '/uploads',
  datastore: new FileStore({ directory: uploadPath }),
  respectForwardedHeaders: true,
  async onUploadCreate(req, res, upload) {
    try {
      // Validate API key for TUS uploads
      const apiKey = req.headers['x-api-key'] as string || 
                     req.headers['authorization']?.replace('Bearer ', '');
      
      if (!apiKey) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'API key required' }));
        return res;
      }
      
      const keyData = await database.getApiKey(apiKey);
      if (!keyData || !keyData.active) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Invalid or inactive API key' }));
        return res;
      }
      
      // Update last used timestamp
      database.updateApiKeyLastUsed(apiKey).catch(console.error);
      
      // Extract metadata from upload
      const owner = upload.metadata?.owner || upload.metadata?.username || 'unknown';
      const permlink = generateVideoId();
      const frontend_app = upload.metadata?.frontend_app || 'unknown';
      const short = upload.metadata?.short === 'true';
      const size = upload.size || null;
      const originalFilename = upload.metadata?.filename || null;
      
      console.log(`Upload metadata - short flag: "${upload.metadata?.short}" -> parsed as: ${short}`);
      
      // Check/create user and verify not banned
      let user = await database.getUser(owner);
      if (!user) {
        // Create new user entry
        await database.createUser({
          username: owner,
          banned: false,
          banReason: null,
          bannedAt: null,
          bannedBy: null,
          uploadRestricted: false,
          maxDailyUploads: null,
          maxFileSize: null,
          stats: {
            totalUploads: 0,
            totalStorageUsed: 0,
            successfulUploads: 0,
            failedUploads: 0,
            lastUpload: null,
          },
          trustLevel: 'new',
          adminNotes: '',
          firstSeen: new Date(),
          lastActivity: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        console.log(`New user created: ${owner}`);
      } else if (user.banned) {
        // User is banned, reject upload
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'User is banned from uploading' }));
        return res;
      }
      
      // Store permlink in upload metadata for later use
      upload.metadata = upload.metadata || {};
      upload.metadata.permlink = permlink;
      upload.metadata.owner = owner;

      // Create initial database entry
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
        duration: null,
        size,
        encodingProgress: 0,
        originalFilename,
        hive_author: null,
        hive_permlink: null,
        hive_title: null,
        hive_body: null,
        hive_tags: null,
        listed_on_3speak: frontend_app === '3speak-tv',
        processed: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      console.log(`Upload created: ${owner}/${permlink} [${frontend_app}] (${short ? 'short' : 'long'}, ${size} bytes)`);
      
      // Return the embed URL immediately
      const embedUrl = `${config.baseUrl}?v=${owner}/${permlink}`;
      res.setHeader('X-Embed-URL', embedUrl);
      
      return res;
    } catch (error) {
      console.error('Upload creation error:', error);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Upload creation failed' }));
      return res;
    }
  },
  async onUploadFinish(req, res, upload) {
    const permlink = upload.metadata?.permlink;
    const owner = upload.metadata?.owner;
    const frontend_app = upload.metadata?.frontend_app;
    const short = upload.metadata?.short === 'true';
    const originalFilename = upload.metadata?.originalFilename;

    // Set embed URL on finish response too (so tus-js-client can capture it)
    if (permlink && owner) {
      const embedUrl = `${config.baseUrl}?v=${owner}/${permlink}`;
      res.setHeader('X-Embed-URL', embedUrl);
    }

    if (permlink && owner && upload.storage) {
      try {
        // Pin file to IPFS
        const filePath = (upload.storage as any).path;
        console.log(`Pinning file to IPFS: ${filePath}`);
        const { cid: input_cid, endpoint: ipfs_pin_endpoint } = await pinFile(filePath);
        console.log(`File pinned successfully: ${input_cid} at ${ipfs_pin_endpoint}`);
        
        // Announce to DHT for better discoverability
        try {
          await announceDHT(input_cid);
        } catch (dhtError) {
          console.warn(`DHT announcement failed (non-critical): ${dhtError}`);
        }
        
        // Update video with input_cid and pin location
        await database.updateVideoStatus(permlink, 'processing', {
          size: upload.size || null,
          input_cid,
          ipfs_pin_endpoint,
          encodingProgress: 0,
        });
        
        // Update user stats for successful upload
        try {
          await database.incrementUserUpload(owner, upload.size || 0);
        } catch (statsError) {
          console.warn(`Failed to update user stats: ${statsError}`);
        }
        
        // Create encoding job
        await database.createJob({
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
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        
        console.log(`Upload completed: ${owner}/${permlink} - Pinned: ${input_cid} - Job created`);
        
        // Clean up TUS file
        try {
          unlinkSync(filePath);
          console.log(`TUS file cleaned up: ${filePath}`);
        } catch (cleanupError) {
          console.warn(`Failed to cleanup TUS file: ${cleanupError}`);
        }
      } catch (error) {
        console.error(`Upload finish error for ${owner}/${permlink}:`, error);
        await database.updateVideoStatus(permlink, 'failed', {
          encodingProgress: 0,
        });
      }
    }
    
    return res;
  },
});

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
    // Verify webhook API key
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== config.webhookApiKey) {
      console.warn('Webhook received with invalid API key');
      return res.status(401).json({ error: 'Unauthorized' });
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
      // Update video as failed
      await database.updateVideoStatus(permlink, 'failed', {
        encodingProgress: 0,
      });

      // Update job as failed
      await database.updateJobStatus(owner, permlink, 'failed', {
        webhookReceivedAt: new Date(),
        lastError: encoderError || 'Encoding failed',
      });
      
      // Update user stats for failed encoding
      try {
        await database.incrementUserFailure(owner);
      } catch (statsError) {
        console.warn(`Failed to update user failure stats: ${statsError}`);
      }

      // DO NOT unpin on failure - keep the file for potential retry or debugging

      console.error(`Video encoding failed: ${owner}/${permlink} - Error: ${encoderError}`);
      res.json({ success: true, message: 'Webhook processed (failure recorded)' });
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
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== config.webhookApiKey) {
      console.warn('Progress webhook received with invalid API key');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { owner, permlink, progress, stage } = req.body;

    if (!owner || !permlink || typeof progress !== 'number') {
      return res.status(400).json({ error: 'owner, permlink, and progress (number) are required' });
    }

    const job = await database.getJob(owner, permlink);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
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
    } as any);

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

// Mount TUS server - handle all HTTP methods
app.all('/uploads', tusServer.handle.bind(tusServer));
app.all('/uploads/*', tusServer.handle.bind(tusServer));

// Start server
let dispatcher: JobDispatcher;

async function start() {
  try {
    await database.connect(config.mongoDbName, config.mongoCollectionVideos);
    
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
    
    // Log encoder configuration
    const enabledEncoders = config.encoders.filter(e => e.enabled);
    if (enabledEncoders.length > 0) {
      console.log(`Encoders available (${enabledEncoders.length}):`);
      enabledEncoders.forEach(e => console.log(`  - ${e.name}: ${e.url}`));
    } else {
      console.warn('⚠️  No encoders configured! Jobs will fail to dispatch.');
    }
    
    // Start job dispatcher
    dispatcher = new JobDispatcher(database, config);
    dispatcher.start(30); // Poll every 30 seconds
    
    // Start cleanup service
    if (config.cleanupEnabled) {
      cleanupService.start(config.cleanupIntervalHours);
    } else {
      console.log('Cleanup service disabled');
    }
    
    app.listen(config.port, () => {
      console.log(`Server running on port ${config.port}`);
      console.log(`TUS endpoint: http://localhost:${config.port}/uploads`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  if (dispatcher) {
    dispatcher.stop();
  }
  cleanupService.stop();
  await database.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  if (dispatcher) {
    dispatcher.stop();
  }
  cleanupService.stop();
  await database.close();
  process.exit(0);
});

start();
