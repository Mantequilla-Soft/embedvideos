export interface EncoderConfig {
  name: string;
  url: string;
  apiKey: string;
  enabled: boolean;
}

export interface Config {
  port: number;
  tusdPort: number;
  tusdBinaryPath: string;
  mongoUri: string;
  mongoDbName: string;
  mongoCollectionVideos: string;
  mongoCollectionUsers: string;
  mongoCollectionKeys: string;
  mongoCollectionJobs: string;
  uploadDir: string;
  baseUrl: string;
  demoApiKey: string;
  adminPassword: string;
  ipfsApiAddr: string;
  encoders: EncoderConfig[];
  webhookApiKey: string;
  webhookUrl: string;
  cleanupEnabled: boolean;
  cleanupIntervalHours: number;
  cleanupRetentionDays: number;
  uploadTokenSecret: string;
  uploadTokenDefaultTtl: number;
  uploadTokenMaxTtl: number;
  uploadTokenMaxFileSize: number;
  // Hard cap on a single video upload's total size, enforced in the pre-create
  // hook for every upload regardless of auth method (API key or token). Default 5 GiB.
  maxUploadSize: number;
  // When false, the JobDispatcher poll loop is not started. Set on secondary
  // deployments that share a Mongo embed-jobs collection with a primary so only
  // one instance dispatches encoder jobs (the dispatch path is not atomic across
  // instances, so two pollers can double-dispatch the same job).
  dispatcherEnabled: boolean;
  // 🔐 3speak-gate: entitlement and content-key service for gated (paid)
  // content. When gateUrl is empty, gated uploads are refused at token
  // issuance, because a gated video nobody can register is a video nobody can
  // ever play.
  gateUrl: string;
  gateInternalApiKey: string;
  // CDN base the gate fetches encrypted manifests from. Must be a host in the
  // gate's own GATE_UPSTREAM_HOSTS allowlist or registration is rejected.
  gateCdnBase: string;
  /**
   * Daily upload limits: warm-up accounts always, free Hive accounts only when
   * UPLOAD_LIMIT_FREE_UPLOADS_CAPPED=true, or through other apps by the
   * checker's publish limit. See src/utils/uploadLimits.ts.
   */
  uploadLimits: UploadLimitsConfig;
}

export interface UploadLimitsConfig {
  /** UPLOAD_DAILY_LIMITS_ENABLED. On unless set to exactly "false". */
  enabled: boolean;
  /**
   * UPLOAD_LIMIT_FREE_UPLOADS_CAPPED. Off unless set to exactly "true": free
   * Hive accounts have no upload cap, their limit is on publishing (the checker
   * enforces it when a post is scheduled). "true" brings back the free plan's
   * upload cap below.
   */
  freeUploadsCapped: boolean;
  /** Regular (non-short) videos per rolling 24 hours for a free Hive account (only while capped). */
  videosPerDay: number;
  /** Shorts per rolling 24 hours for a free Hive account (only while capped). */
  shortsPerDay: number;
  /** Regular videos per rolling 24 hours for a warm-up account (no Hive account yet). */
  warmupVideosPerDay: number;
  /** Shorts per rolling 24 hours for a warm-up account. */
  warmupShortsPerDay: number;
  /** Owners never limited (lowercased). */
  exempt: string[];
  /** Checker endpoint that says whether a handle is a warm-up (incubating) account. */
  warmupLookupUrl: string;
  /** Hive API nodes for the "this warm-up handle is not also a Hive account" check. */
  hiveApiNodes: string[];
  /** UPLOAD_UPGRADE_URL: where a refused uploader can get Pro. `{owner}` (or `{user}`) is replaced. */
  upgradeUrl: string;
  /**
   * UPLOAD_PUBLISH_CHECK_ENABLED. On unless set to exactly "false". While free
   * uploads are not capped, an upload by a free Hive account through an app
   * outside `publishCheckSkipApps` is refused when the checker says that owner
   * cannot publish one more of its kind right now (those apps publish to Hive
   * straight after the upload, with no scheduling).
   */
  publishCheckEnabled: boolean;
  /** UPLOAD_PUBLISH_CHECK_URL: checker base URL that answers GET /publish-quota/:owner. No trailing slash. */
  publishCheckUrl: string;
  /**
   * UPLOAD_PUBLISH_CHECK_SKIP_APPS: API key `app_name`s (lowercased) whose
   * uploads skip the publish check, because the app checks the publish limit
   * itself and lets people schedule (3speak.tv's studio and editor).
   */
  publishCheckSkipApps: string[];
}

function parseCount(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** API key app names: trimmed and lowercased, compared case-insensitively. Empty or unset = the default. */
function parseAppList(raw: string | undefined, fallback: string): string[] {
  const list = (raw || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : fallback.split(',');
}

function parseList(raw: string | undefined): string[] {
  return (raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

export function loadUploadLimitsConfig(env: NodeJS.ProcessEnv = process.env): UploadLimitsConfig {
  const hiveNodes = (env.UPLOAD_LIMIT_HIVE_NODES || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    enabled: env.UPLOAD_DAILY_LIMITS_ENABLED !== 'false',
    freeUploadsCapped: env.UPLOAD_LIMIT_FREE_UPLOADS_CAPPED === 'true',
    videosPerDay: parseCount(env.UPLOAD_LIMIT_VIDEOS_PER_DAY, 1),
    shortsPerDay: parseCount(env.UPLOAD_LIMIT_SHORTS_PER_DAY, 3),
    warmupVideosPerDay: parseCount(env.UPLOAD_LIMIT_WARMUP_VIDEOS_PER_DAY, 3),
    warmupShortsPerDay: parseCount(env.UPLOAD_LIMIT_WARMUP_SHORTS_PER_DAY, 3),
    exempt: parseList(env.UPLOAD_LIMIT_EXEMPT),
    warmupLookupUrl: env.UPLOAD_LIMIT_WARMUP_LOOKUP_URL || 'https://checker.3speak.tv/incubation/authors',
    hiveApiNodes: hiveNodes.length ? hiveNodes : ['https://api.hive.blog', 'https://api.deathwing.me', 'https://anyx.io'],
    upgradeUrl: env.UPLOAD_UPGRADE_URL || 'https://3speak.tv/wallet/{owner}#pro',
    publishCheckEnabled: env.UPLOAD_PUBLISH_CHECK_ENABLED !== 'false',
    publishCheckUrl: (env.UPLOAD_PUBLISH_CHECK_URL || '').trim().replace(/\/+$/, '') || 'https://checker.3speak.tv',
    publishCheckSkipApps: parseAppList(env.UPLOAD_PUBLISH_CHECK_SKIP_APPS, '3speak,3speak-editor'),
  };
}

function parseEncoders(): EncoderConfig[] {
  const encoders: EncoderConfig[] = [];
  
  // Parse ENCODERS environment variable (JSON array format)
  // Example: [{"name":"snapie","url":"https://snapie.3speak.tv","apiKey":"key1","enabled":true}]
  const encodersJson = process.env.ENCODERS;
  if (encodersJson) {
    try {
      const parsed = JSON.parse(encodersJson) as EncoderConfig[];
      encoders.push(...parsed.filter(e => e.enabled));
    } catch (error) {
      console.error('Failed to parse ENCODERS env variable:', error);
    }
  }
  
  // Fallback: legacy single encoder config
  if (encoders.length === 0 && process.env.ENCODER_API_URL && process.env.ENCODER_API_KEY) {
    encoders.push({
      name: 'default',
      url: process.env.ENCODER_API_URL,
      apiKey: process.env.ENCODER_API_KEY,
      enabled: true,
    });
  }
  
  return encoders;
}

export function loadConfig(): Config {
  return {
    port: parseInt(process.env.PORT || '3000', 10),
    tusdPort: parseInt(process.env.TUSD_PORT || '1080', 10),
    tusdBinaryPath: process.env.TUSD_BINARY_PATH || './bin/tusd',
    mongoUri: process.env.MONGODB_URI || '',
    mongoDbName: process.env.MONGODB_DATABASE || 'threespeak',
    mongoCollectionVideos: process.env.MONGODB_COLLECTION_VIDEOS || 'embed-video',
    mongoCollectionUsers: process.env.MONGODB_COLLECTION_USERS || 'embed-users',
    mongoCollectionKeys: process.env.MONGODB_COLLECTION_KEYS || 'embed-api-keys',
    mongoCollectionJobs: process.env.MONGODB_COLLECTION_JOBS || 'embed-jobs',
    uploadDir: process.env.UPLOAD_DIR || './uploads',
    baseUrl: process.env.BASE_URL || 'https://play.3speak.tv/embed',
    demoApiKey: process.env.DEMO_API_KEY || 'sk_demo_b0d3f4b972c5065b701394df3de2f44fd59aa3244c58c478',
    adminPassword: process.env.ADMIN_PASSWORD || 'change-me-in-production',
    ipfsApiAddr: process.env.IPFS_API_ADDR || '/ip4/127.0.0.1/tcp/5001',
    encoders: parseEncoders(),
    webhookApiKey: process.env.WEBHOOK_API_KEY || '',
    webhookUrl: process.env.WEBHOOK_URL || '',
    cleanupEnabled: process.env.CLEANUP_ENABLED !== 'false',
    cleanupIntervalHours: parseInt(process.env.CLEANUP_INTERVAL_HOURS || '24', 10),
    cleanupRetentionDays: parseInt(process.env.CLEANUP_RETENTION_DAYS || '7', 10),
    uploadTokenSecret: process.env.UPLOAD_TOKEN_SECRET || '',
    uploadTokenDefaultTtl: parseInt(process.env.UPLOAD_TOKEN_DEFAULT_TTL || '600', 10),
    uploadTokenMaxTtl: parseInt(process.env.UPLOAD_TOKEN_MAX_TTL || '1800', 10),
    uploadTokenMaxFileSize: parseInt(process.env.UPLOAD_TOKEN_MAX_FILE_SIZE || String(1024 * 1024 * 1024), 10),
    maxUploadSize: parseInt(process.env.MAX_UPLOAD_SIZE || String(5 * 1024 * 1024 * 1024), 10),
    dispatcherEnabled: process.env.DISPATCHER_ENABLED !== 'false',
    gateUrl: process.env.GATE_URL || '',
    gateInternalApiKey: process.env.GATE_INTERNAL_API_KEY || '',
    gateCdnBase: process.env.GATE_CDN_BASE || 'https://ipfs.3speak.tv/ipfs',
    uploadLimits: loadUploadLimitsConfig(),
  };
}
