import { MongoClient, Db, Collection } from 'mongodb';

export type VideoStatus = 'uploading' | 'processing' | 'published' | 'failed' | 'deleted';

export interface VideoMetadata {
  owner: string;
  permlink: string;
  frontend_app: string;
  status: VideoStatus;
  input_cid: string | null;
  ipfs_pin_endpoint: string | null;
  manifest_cid: string | null;
  thumbnail_url: string | null;
  short: boolean;
  duration: number | null;
  size: number | null;
  encodingProgress: number;
  originalFilename: string | null;
  hive_author: string | null;
  hive_permlink: string | null;
  hive_title: string | null;
  hive_body: string | null;
  hive_tags: string[] | null;
  embed_url: string | null;
  embed_title: string | null;
  listed_on_3speak: boolean;
  processed: boolean;
  processedAt: Date | null;
  views: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface User {
  username: string;
  banned: boolean;
  banReason: string | null;
  bannedAt: Date | null;
  bannedBy: string | null;
  uploadRestricted: boolean;
  maxDailyUploads: number | null;
  maxFileSize: number | null;
  stats: {
    totalUploads: number;
    totalStorageUsed: number;
    successfulUploads: number;
    failedUploads: number;
    lastUpload: Date | null;
  };
  premium?: boolean;
  trustLevel: 'new' | 'trusted' | 'verified' | 'restricted';
  adminNotes: string;
  firstSeen: Date;
  lastActivity: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiKey {
  key: string;
  app_name: string;
  owner: string;
  active: boolean;
  createdAt: Date;
  lastUsed: Date | null;
}

export type EncoderAccess = 'managed' | 'community';
export type EncoderTier = 'performance' | 'standard' | 'lite';

export interface Encoder {
  name: string;
  url: string;
  apiKey: string;
  enabled: boolean;
  access?: EncoderAccess;
  tier?: EncoderTier;
  maxFileSize?: number | null;
  // Community encoder fields
  did?: string;
  displayName?: string;
  hiveAccount?: string;
  peerId?: string;
  commitHash?: string;
  lastSeenAt?: Date;
  banned?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type JobStatus = 'pending' | 'encoding' | 'completed' | 'failed';

export interface EncodingJob {
  owner: string;
  permlink: string;
  status: JobStatus;
  assignedWorker: string | null;
  encoderJobId: string | null;
  assignedAt: Date | null;
  attemptCount: number;
  lastError: string | null;
  encodingProgress: number | null;
  encodingStage: string | null;
  webhookReceivedAt: Date | null;
  callbackToken?: string | null;
  // Denormalized for community job claiming
  premium?: boolean;
  short?: boolean;
  fileSize?: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export class Database {
  private client: MongoClient;
  private db: Db | null = null;
  private collection: Collection<VideoMetadata> | null = null;

  constructor(connectionString: string, dbName: string, collectionName: string) {
    this.client = new MongoClient(connectionString);
  }

  // Create an index but tolerate one that already exists with different options
  // (this DB is shared, and e.g. the embed-encoders `name` index already exists
  // with a collation). IndexOptionsConflict (85) / IndexKeySpecsConflict (86)
  // mean the constraint is already in place — log and continue instead of
  // crashing startup.
  private async ensureIndex(collection: Collection<any>, keys: any, options?: any): Promise<void> {
    try {
      await collection.createIndex(keys, options);
    } catch (err: any) {
      if (err?.code === 85 || err?.code === 86) {
        console.warn(`[mongodb] index ${JSON.stringify(keys)} already exists with different options — keeping existing`);
        return;
      }
      throw err;
    }
  }

  async connect(dbName: string, collectionName: string): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(dbName);
    this.collection = this.db.collection<VideoMetadata>(collectionName);

    // Create indexes (tolerant of pre-existing conflicting definitions)
    await this.ensureIndex(this.collection, { permlink: 1 }, { unique: true });

    const encodersCollection = this.db.collection<Encoder>('embed-encoders');
    await this.ensureIndex(encodersCollection, { name: 1 }, { unique: true });
    await this.ensureIndex(encodersCollection, { did: 1 }, { unique: true, sparse: true });

    // Index for community job claiming (findOneAndUpdate filter)
    const jobsCollection = this.db.collection<EncodingJob>('embed-jobs');
    await this.ensureIndex(jobsCollection, { status: 1, premium: 1, short: 1, createdAt: 1 });

    console.log('Connected to MongoDB');
  }

  async createVideoEntry(metadata: VideoMetadata): Promise<void> {
    if (!this.collection) {
      throw new Error('Database not connected');
    }
    await this.collection.insertOne(metadata);
  }

  async updateVideoStatus(
    permlink: string,
    status: VideoStatus,
    additionalData?: Partial<VideoMetadata>
  ): Promise<void> {
    if (!this.collection) {
      throw new Error('Database not connected');
    }
    await this.collection.updateOne(
      { permlink },
      { $set: { status, updatedAt: new Date(), ...additionalData } }
    );
  }

  async getVideo(permlink: string): Promise<VideoMetadata | null> {
    if (!this.collection) {
      throw new Error('Database not connected');
    }
    return this.collection.findOne({ permlink });
  }

  async getStaleUploads(hoursOld: number): Promise<VideoMetadata[]> {
    if (!this.collection) {
      throw new Error('Database not connected');
    }
    const cutoffDate = new Date(Date.now() - hoursOld * 60 * 60 * 1000);
    return this.collection.find({
      status: 'uploading',
      createdAt: { $lt: cutoffDate }
    }).toArray();
  }

  async getStaleProcessing(hoursOld: number): Promise<VideoMetadata[]> {
    if (!this.collection) {
      throw new Error('Database not connected');
    }
    const cutoffDate = new Date(Date.now() - hoursOld * 60 * 60 * 1000);
    return this.collection.find({
      status: 'processing',
      updatedAt: { $lt: cutoffDate }
    }).toArray();
  }

  // API Key Management Methods
  async createApiKey(apiKey: ApiKey): Promise<void> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const keysCollection = this.db.collection<ApiKey>('embed-api-keys');
    await keysCollection.insertOne(apiKey);
  }

  async getApiKey(key: string): Promise<ApiKey | null> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const keysCollection = this.db.collection<ApiKey>('embed-api-keys');
    return keysCollection.findOne({ key });
  }

  async getAllApiKeys(): Promise<ApiKey[]> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const keysCollection = this.db.collection<ApiKey>('embed-api-keys');
    return keysCollection.find({}).sort({ createdAt: -1 }).toArray();
  }

  async updateApiKeyStatus(key: string, active: boolean): Promise<void> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const keysCollection = this.db.collection<ApiKey>('embed-api-keys');
    await keysCollection.updateOne({ key }, { $set: { active } });
  }

  async updateApiKeyLastUsed(key: string): Promise<void> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const keysCollection = this.db.collection<ApiKey>('embed-api-keys');
    await keysCollection.updateOne({ key }, { $set: { lastUsed: new Date() } });
  }

  // User Stats Methods
  async incrementUserUpload(username: string, fileSize: number): Promise<void> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const usersCollection = this.db.collection<User>('embed-users');
    await usersCollection.updateOne(
      { username },
      {
        $inc: {
          'stats.totalUploads': 1,
          'stats.totalStorageUsed': fileSize
        },
        $set: {
          'stats.lastUpload': new Date(),
          lastActivity: new Date(),
          updatedAt: new Date()
        }
      }
    );
  }

  async incrementUserSuccess(username: string): Promise<void> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const usersCollection = this.db.collection<User>('embed-users');
    await usersCollection.updateOne(
      { username },
      {
        $inc: { 'stats.successfulUploads': 1 },
        $set: {
          lastActivity: new Date(),
          updatedAt: new Date()
        }
      }
    );
  }

  async incrementUserFailure(username: string): Promise<void> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const usersCollection = this.db.collection<User>('embed-users');
    await usersCollection.updateOne(
      { username },
      {
        $inc: { 'stats.failedUploads': 1 },
        $set: {
          lastActivity: new Date(),
          updatedAt: new Date()
        }
      }
    );
  }

  // Encoding Job Management Methods
  async createJob(job: EncodingJob): Promise<void> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const jobsCollection = this.db.collection<EncodingJob>('embed-jobs');
    
    // Ensure unique compound index exists
    await jobsCollection.createIndex({ owner: 1, permlink: 1 }, { unique: true });
    
    await jobsCollection.insertOne(job);
  }

  async getJob(owner: string, permlink: string): Promise<EncodingJob | null> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const jobsCollection = this.db.collection<EncodingJob>('embed-jobs');
    return jobsCollection.findOne({ owner, permlink });
  }

  async getPendingJobs(limit: number = 10): Promise<EncodingJob[]> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const jobsCollection = this.db.collection<EncodingJob>('embed-jobs');
    return jobsCollection
      .find({ status: 'pending' })
      .sort({ createdAt: 1 })
      .limit(limit)
      .toArray();
  }

  /**
   * Atomically claim the next pending managed job (premium or free, non-short or short).
   * Uses findOneAndUpdate so two concurrent dispatchers cannot claim the same job.
   * Returns null if no pending job matches.
   */
  async claimNextManagedJob(filter: { premium?: boolean; short?: boolean }): Promise<EncodingJob | null> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const jobsCollection = this.db.collection<EncodingJob>('embed-jobs');
    const query: any = { status: 'pending' };
    if (filter.premium !== undefined) query.premium = filter.premium;
    if (filter.short !== undefined) query.short = filter.short;

    return jobsCollection.findOneAndUpdate(
      query,
      { $set: { status: 'encoding' as JobStatus, updatedAt: new Date() } },
      { sort: { createdAt: 1 }, returnDocument: 'after' }
    );
  }

  async updateJobStatus(
    owner: string,
    permlink: string,
    status: JobStatus,
    additionalData?: Partial<EncodingJob>
  ): Promise<void> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const jobsCollection = this.db.collection<EncodingJob>('embed-jobs');
    await jobsCollection.updateOne(
      { owner, permlink },
      { $set: { status, updatedAt: new Date(), ...additionalData } }
    );
  }

  async incrementJobAttempt(owner: string, permlink: string): Promise<void> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const jobsCollection = this.db.collection<EncodingJob>('embed-jobs');
    await jobsCollection.updateOne(
      { owner, permlink },
      { $inc: { attemptCount: 1 }, $set: { updatedAt: new Date() } }
    );
  }

  async resetJob(owner: string, permlink: string): Promise<void> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const jobsCollection = this.db.collection<EncodingJob>('embed-jobs');
    await jobsCollection.updateOne(
      { owner, permlink },
      {
        $set: {
          status: 'pending',
          attemptCount: 0,
          assignedWorker: null,
          encoderJobId: null,
          assignedAt: null,
          lastError: null,
          encodingProgress: null,
          encodingStage: null,
          updatedAt: new Date(),
        },
      }
    );
  }

  async resetStalledJob(owner: string, permlink: string): Promise<boolean> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const jobsCollection = this.db.collection<EncodingJob>('embed-jobs');
    const result = await jobsCollection.updateOne(
      { owner, permlink, status: 'encoding' },
      {
        $set: {
          status: 'pending',
          assignedWorker: null,
          encoderJobId: null,
          assignedAt: null,
          lastError: 'Reset due to stall (no progress update)',
          encodingProgress: null,
          encodingStage: null,
          updatedAt: new Date(),
        },
        $inc: { attemptCount: 1 },
      }
    );
    return result.modifiedCount > 0;
  }

  async failStalledJob(owner: string, permlink: string, error: string): Promise<boolean> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const jobsCollection = this.db.collection<EncodingJob>('embed-jobs');
    const result = await jobsCollection.updateOne(
      { owner, permlink, status: 'encoding' },
      {
        $set: {
          status: 'failed',
          lastError: error,
          updatedAt: new Date(),
        },
      }
    );
    return result.modifiedCount > 0;
  }

  async getStalledJobs(minutesOld: number): Promise<EncodingJob[]> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const cutoffDate = new Date(Date.now() - minutesOld * 60 * 1000);
    const jobsCollection = this.db.collection<EncodingJob>('embed-jobs');
    return jobsCollection.find({
      status: 'encoding',
      updatedAt: { $lt: cutoffDate }
    }).toArray();
  }

  async getCompletedJobStats(since: Date): Promise<EncodingJob[]> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const jobsCollection = this.db.collection<EncodingJob>('embed-jobs');
    return jobsCollection.find({
      status: { $in: ['completed', 'failed'] },
      updatedAt: { $gte: since }
    }).toArray();
  }

  // User management methods
  async getUser(username: string): Promise<User | null> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const usersCollection = this.db.collection<User>('embed-users');
    return usersCollection.findOne({ username });
  }

  async createUser(user: User): Promise<void> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const usersCollection = this.db.collection<User>('embed-users');
    await usersCollection.insertOne(user);
  }

  async getAllUsers(limit: number = 50, skip: number = 0, search?: string): Promise<User[]> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const usersCollection = this.db.collection<User>('embed-users');
    
    const query = search 
      ? { username: { $regex: search, $options: 'i' } }
      : {};
    
    return usersCollection
      .find(query)
      .sort({ lastActivity: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();
  }

  async banUser(username: string, banned: boolean): Promise<void> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const usersCollection = this.db.collection<User>('embed-users');
    await usersCollection.updateOne(
      { username },
      { $set: { banned, updatedAt: new Date() } }
    );
  }

  // Premium User Methods

  async isUserPremium(username: string): Promise<boolean> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const usersCollection = this.db.collection<User>('embed-users');
    const user = await usersCollection.findOne({ username });
    return user?.premium ?? false;
  }

  async setUserPremium(username: string, premium: boolean): Promise<void> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const usersCollection = this.db.collection<User>('embed-users');
    const result = await usersCollection.updateOne(
      { username },
      { $set: { premium, updatedAt: new Date() } }
    );
    if (result.matchedCount === 0) {
      throw new Error(`User not found: ${username}`);
    }
  }

  // Encoder Management Methods
  async getAllEncoders(): Promise<Encoder[]> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const encodersCollection = this.db.collection<Encoder>('embed-encoders');
    return encodersCollection.find({}).sort({ createdAt: 1 }).toArray();
  }

  async getEncoder(name: string): Promise<Encoder | null> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const encodersCollection = this.db.collection<Encoder>('embed-encoders');
    return encodersCollection.findOne({ name });
  }

  async createEncoder(encoder: Encoder): Promise<void> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const encodersCollection = this.db.collection<Encoder>('embed-encoders');
    await encodersCollection.insertOne(encoder);
  }

  async updateEncoder(name: string, data: Partial<Encoder>): Promise<void> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const encodersCollection = this.db.collection<Encoder>('embed-encoders');
    await encodersCollection.updateOne(
      { name },
      { $set: { ...data, updatedAt: new Date() } }
    );
  }

  async deleteEncoder(name: string): Promise<void> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const encodersCollection = this.db.collection<Encoder>('embed-encoders');
    await encodersCollection.deleteOne({ name });
  }

  // Community encoder methods

  async getEncoderByDid(did: string): Promise<Encoder | null> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const encodersCollection = this.db.collection<Encoder>('embed-encoders');
    return encodersCollection.findOne({ did });
  }

  async upsertCommunityEncoder(did: string, data: {
    name?: string;
    hiveAccount?: string;
    peerId?: string;
    commitHash?: string;
  }): Promise<Encoder> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const encodersCollection = this.db.collection<Encoder>('embed-encoders');
    const now = new Date();
    // Name is always derived from DID — stable, unique, not user-controlled
    const stableName = `community-${did.slice(-12)}`;

    const result = await encodersCollection.findOneAndUpdate(
      { did },
      {
        $set: {
          ...(data.name !== undefined && { displayName: data.name }),
          ...(data.hiveAccount !== undefined && { hiveAccount: data.hiveAccount }),
          ...(data.peerId !== undefined && { peerId: data.peerId }),
          ...(data.commitHash !== undefined && { commitHash: data.commitHash }),
          lastSeenAt: now,
          updatedAt: now,
        },
        $setOnInsert: {
          name: stableName,
          did,
          url: '',
          apiKey: '',
          enabled: true,
          access: 'community' as EncoderAccess,
          tier: 'lite' as EncoderTier,
          banned: false,
          maxFileSize: null,
          createdAt: now,
        },
      },
      { upsert: true, returnDocument: 'after' }
    );

    return result!;
  }

  async updateEncoderLastSeen(did: string): Promise<void> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const encodersCollection = this.db.collection<Encoder>('embed-encoders');
    await encodersCollection.updateOne(
      { did },
      { $set: { lastSeenAt: new Date() } }
    );
  }

  async claimNextCommunityJob(encoderName: string, maxFileSize: number | null): Promise<EncodingJob | null> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const jobsCollection = this.db.collection<EncodingJob>('embed-jobs');
    const now = new Date();

    // Require explicit premium: false and short: false — reject legacy jobs
    // that lack these fields to prevent leaking premium/short work
    const filter: any = {
      status: 'pending',
      premium: false,
      short: false,
    };

    // Capped encoders only claim jobs with known size within bounds
    // Uncapped encoders accept any size (including unknown)
    if (maxFileSize != null) {
      filter.fileSize = { $gt: 0, $lte: maxFileSize };
    }

    const callbackToken = require('crypto').randomBytes(32).toString('hex');
    const result = await jobsCollection.findOneAndUpdate(
      filter,
      {
        $set: {
          status: 'encoding' as JobStatus,
          assignedWorker: encoderName,
          assignedAt: now,
          updatedAt: now,
          callbackToken,
        },
      },
      { sort: { createdAt: 1 }, returnDocument: 'after' }
    );

    return result;
  }

  // Upload Token single-use tracking
  // Uses a lightweight collection with TTL index for automatic cleanup

  async initUploadTokenCollection(): Promise<void> {
    if (!this.db) throw new Error('Database not connected');
    const col = this.db.collection('embed-upload-tokens');
    // Auto-delete consumed tokens after 24h (cleanup safety net)
    await col.createIndex({ consumedAt: 1 }, { expireAfterSeconds: 86400 });
    // Also expire by the token's own expiry
    await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await col.createIndex({ jti: 1 }, { unique: true });
  }

  /**
   * Try to consume a token (mark as used). Returns true if successful,
   * false if the token was already consumed.
   * Uses atomic upsert to prevent race conditions.
   */
  async consumeUploadToken(jti: string, expiresAt: Date): Promise<boolean> {
    if (!this.db) throw new Error('Database not connected');
    const col = this.db.collection('embed-upload-tokens');
    try {
      await col.insertOne({
        jti,
        consumedAt: new Date(),
        expiresAt,
      });
      return true; // Token consumed successfully (first use)
    } catch (err: any) {
      if (err?.code === 11000) {
        return false; // Duplicate key — token already consumed
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
