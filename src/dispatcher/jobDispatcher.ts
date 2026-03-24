import { Database, Encoder, EncoderTier } from '../database/mongodb';
import { Config } from '../config/config';

export class JobDispatcher {
  private database: Database;
  private config: Config;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  // Per-tier round-robin counters
  private tierCounters: Record<string, number> = {};

  constructor(database: Database, config: Config) {
    this.database = database;
    this.config = config;
  }

  /**
   * Get next encoder using tier-aware selection with round-robin within tier.
   *
   * Dispatch rules:
   *   Premium jobs → managed performance, fallback to managed standard. Never lite, never community.
   *   Free jobs    → standard or lite (any access). Never performance.
   *   Short videos → any managed encoder (any tier), filtered by maxFileSize. Fast turnaround, but 480p doesn't need performance tier.
   *
   * File size is checked against encoder.maxFileSize when set.
   */
  private async getNextEncoder(premium: boolean, fileSize: number | null, isShort: boolean) {
    const allEncoders = await this.database.getAllEncoders();
    const enabledManaged = allEncoders.filter(e =>
      e.enabled && (e.access ?? 'managed') === 'managed'
    );

    if (isShort) {
      // Short videos — managed only (fast turnaround), any tier (480p doesn't need GPU)
      const eligibleShort = enabledManaged.filter(
        e => e.maxFileSize == null || (fileSize != null && fileSize <= e.maxFileSize)
      );
      if (eligibleShort.length > 0) return this.roundRobin(eligibleShort, 'short');
      // Fallback: ignore maxFileSize if no encoder qualifies
      return this.roundRobin(enabledManaged, 'short');
    }

    if (premium) {
      // Premium: try performance first, then standard. Never lite.
      const perfEncoders = this.filterByTierAndSize(enabledManaged, 'performance', fileSize);
      if (perfEncoders.length > 0) return this.roundRobin(perfEncoders, 'performance');

      const stdEncoders = this.filterByTierAndSize(enabledManaged, 'standard', fileSize);
      if (stdEncoders.length > 0) return this.roundRobin(stdEncoders, 'standard');

      throw new Error('No suitable managed encoders available for premium job');
    }

    // Free user: try standard first, then lite. Never performance.
    const allEnabled = allEncoders.filter(e => e.enabled);

    const stdEncoders = this.filterByTierAndSize(allEnabled, 'standard', fileSize);
    if (stdEncoders.length > 0) return this.roundRobin(stdEncoders, 'free-standard');

    const liteEncoders = this.filterByTierAndSize(allEnabled, 'lite', fileSize);
    if (liteEncoders.length > 0) return this.roundRobin(liteEncoders, 'free-lite');

    throw new Error('No suitable encoders available for free job');
  }

  /**
   * Filter encoders by tier and file size capacity.
   * Encoders without a tier field default to 'standard'.
   * Encoders without maxFileSize accept any file size.
   */
  private filterByTierAndSize(encoders: Encoder[], tier: EncoderTier, fileSize: number | null): Encoder[] {
    return encoders.filter(e => {
      const encoderTier = e.tier ?? 'standard';
      if (encoderTier !== tier) return false;
      // Unknown file size → only allow encoders with no cap
      if (e.maxFileSize != null && (fileSize == null || fileSize > e.maxFileSize)) return false;
      return true;
    });
  }

  /**
   * Round-robin selection within a group of encoders.
   * Each tier key gets its own counter to avoid skew.
   */
  private roundRobin(encoders: Encoder[], tierKey: string): Encoder {
    if (encoders.length === 0) {
      throw new Error(`No encoders available for tier: ${tierKey}`);
    }
    const counter = this.tierCounters[tierKey] ?? 0;
    const encoder = encoders[counter % encoders.length];
    this.tierCounters[tierKey] = counter + 1;
    return encoder;
  }

  /**
   * Start the dispatcher polling loop
   */
  start(intervalSeconds: number = 30): void {
    if (this.isRunning) {
      console.log('Dispatcher already running');
      return;
    }

    this.isRunning = true;
    console.log(`Starting job dispatcher (polling every ${intervalSeconds}s)`);

    // Run immediately, then on interval
    this.processJobs();
    this.intervalId = setInterval(() => this.processJobs(), intervalSeconds * 1000);
  }

  /**
   * Stop the dispatcher polling loop
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.isRunning = false;
      console.log('Job dispatcher stopped');
    }
  }

  /**
   * Process pending jobs
   */
  private async processJobs(): Promise<void> {
    try {
      const pendingJobs = await this.database.getPendingJobs(5);

      if (pendingJobs.length === 0) {
        return; // No jobs to process
      }

      console.log(`Found ${pendingJobs.length} pending job(s)`);

      for (const job of pendingJobs) {
        try {
          await this.dispatchJob(job.owner, job.permlink);
        } catch (error) {
          console.error(`Failed to dispatch job ${job.owner}/${job.permlink}:`, error);

          // Increment attempt count and set error
          await this.database.incrementJobAttempt(job.owner, job.permlink);
          await this.database.updateJobStatus(job.owner, job.permlink, 'pending', {
            lastError: error instanceof Error ? error.message : String(error),
          });

          // If too many attempts, mark as failed
          if (job.attemptCount >= 3) {
            await this.database.updateJobStatus(job.owner, job.permlink, 'failed', {
              lastError: `Max attempts exceeded: ${error instanceof Error ? error.message : String(error)}`,
            });
            await this.database.updateVideoStatus(job.permlink, 'failed');
            console.error(`Job ${job.owner}/${job.permlink} failed after ${job.attemptCount} attempts`);
          }
        }
      }
    } catch (error) {
      console.error('Error processing jobs:', error);
    }
  }

  /**
   * Dispatch a single job to the encoder
   */
  private async dispatchJob(owner: string, permlink: string): Promise<void> {
    // Get video metadata
    const video = await this.database.getVideo(permlink);
    if (!video) {
      throw new Error(`Video not found: ${permlink}`);
    }

    if (!video.input_cid) {
      throw new Error(`Video has no input_cid: ${permlink}`);
    }

    // Look up premium status for this user
    const premium = await this.database.isUserPremium(owner);
    const fileSize = video.size ?? null;

    // Prepare encoder request with full IPFS gateway URL
    const ipfsGateway = 'https://ipfs.3speak.tv/ipfs';
    const encoderRequest = {
      owner,
      permlink,
      input_cid: `${ipfsGateway}/${video.input_cid}`,
      short: video.short,
      premium,
      webhook_url: this.config.webhookUrl,
      api_key: this.config.webhookApiKey,
      frontend_app: video.frontend_app,
      originalFilename: video.originalFilename,
    };

    // Select encoder using tier-aware routing
    const encoder = await this.getNextEncoder(premium, fileSize, video.short);
    const encoderTier = encoder.tier ?? 'standard';
    const encoderAccess = encoder.access ?? 'managed';
    console.log(`Dispatching job to [${encoder.name}] (${encoderAccess}/${encoderTier}): ${owner}/${permlink} [premium=${premium}, size=${fileSize}]`);
    console.log(`Encoder request payload:`, JSON.stringify(encoderRequest, null, 2));

    // Call encoder API
    const response = await fetch(`${encoder.url}/encode`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': encoder.apiKey,
      },
      body: JSON.stringify(encoderRequest),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Encoder API error: ${response.status} - ${errorText}`);
    }

    const result = await response.json() as { job_id: string; encoder_id?: string };
    console.log(`Job dispatched successfully to [${encoder.name}]: ${result.job_id}`);

    // Update job status to encoding
    await this.database.updateJobStatus(owner, permlink, 'encoding', {
      encoderJobId: result.job_id,
      assignedWorker: encoder.name,
      assignedAt: new Date(),
      lastError: null, // clear stale error if any
    });
  }
}
