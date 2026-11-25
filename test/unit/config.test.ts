import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadConfig, loadUploadLimitsConfig } from '../../src/config/config';

// loadConfig reads process.env on every call, so each test sets what it needs
// and the original environment is restored afterwards.
const KEYS = [
  'PORT', 'TUSD_PORT', 'TUSD_BINARY_PATH', 'MONGODB_URI', 'MONGODB_DATABASE', 'MONGODB_COLLECTION_VIDEOS',
  'MONGODB_COLLECTION_USERS', 'MONGODB_COLLECTION_KEYS', 'MONGODB_COLLECTION_JOBS', 'UPLOAD_DIR', 'BASE_URL',
  'DEMO_API_KEY', 'ADMIN_PASSWORD', 'IPFS_API_ADDR', 'ENCODERS', 'ENCODER_API_URL', 'ENCODER_API_KEY',
  'WEBHOOK_API_KEY', 'WEBHOOK_URL', 'CLEANUP_ENABLED', 'CLEANUP_INTERVAL_HOURS', 'CLEANUP_RETENTION_DAYS',
  'UPLOAD_TOKEN_SECRET', 'UPLOAD_TOKEN_DEFAULT_TTL', 'UPLOAD_TOKEN_MAX_TTL', 'UPLOAD_TOKEN_MAX_FILE_SIZE',
  'MAX_UPLOAD_SIZE', 'DISPATCHER_ENABLED', 'GATE_URL', 'GATE_INTERNAL_API_KEY', 'GATE_CDN_BASE',
  'UPLOAD_DAILY_LIMITS_ENABLED', 'UPLOAD_LIMIT_FREE_UPLOADS_CAPPED', 'UPLOAD_LIMIT_VIDEOS_PER_DAY', 'UPLOAD_LIMIT_SHORTS_PER_DAY',
  'UPLOAD_LIMIT_EXEMPT', 'UPLOAD_LIMIT_WARMUP_LOOKUP_URL', 'UPLOAD_LIMIT_HIVE_NODES', 'UPLOAD_UPGRADE_URL',
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe('loadConfig defaults', () => {
  it('fills every field from defaults with an empty environment', () => {
    const c = loadConfig();
    expect(c).toMatchObject({
      port: 3000,
      tusdPort: 1080,
      tusdBinaryPath: './bin/tusd',
      mongoUri: '',
      mongoDbName: 'threespeak',
      mongoCollectionVideos: 'embed-video',
      mongoCollectionUsers: 'embed-users',
      mongoCollectionKeys: 'embed-api-keys',
      mongoCollectionJobs: 'embed-jobs',
      uploadDir: './uploads',
      baseUrl: 'https://play.3speak.tv/embed',
      adminPassword: 'change-me-in-production',
      ipfsApiAddr: '/ip4/127.0.0.1/tcp/5001',
      encoders: [],
      webhookApiKey: '',
      webhookUrl: '',
      cleanupEnabled: true,
      cleanupIntervalHours: 24,
      cleanupRetentionDays: 7,
      uploadTokenSecret: '',
      uploadTokenDefaultTtl: 600,
      uploadTokenMaxTtl: 1800,
      uploadTokenMaxFileSize: 1024 * 1024 * 1024,
      maxUploadSize: 5 * 1024 * 1024 * 1024,
      dispatcherEnabled: true,
      gateUrl: '',
      gateInternalApiKey: '',
      gateCdnBase: 'https://ipfs.3speak.tv/ipfs',
    });
    expect(c.demoApiKey).toMatch(/^sk_demo_/);
    expect(c.uploadLimits).toEqual({
      enabled: true,
      freeUploadsCapped: false,
      videosPerDay: 1,
      shortsPerDay: 3,
      warmupVideosPerDay: 3,
      warmupShortsPerDay: 3,
      exempt: [],
      warmupLookupUrl: 'https://checker.3speak.tv/incubation/authors',
      hiveApiNodes: ['https://api.hive.blog', 'https://api.deathwing.me', 'https://anyx.io'],
      upgradeUrl: 'https://3speak.tv/wallet/{owner}#pro',
    });
  });
});

describe('loadConfig from env', () => {
  it('reads and parses each variable', () => {
    Object.assign(process.env, {
      PORT: '8080', TUSD_PORT: '1111', TUSD_BINARY_PATH: '/bin/t', MONGODB_URI: 'mongodb://x',
      MONGODB_DATABASE: 'db1', MONGODB_COLLECTION_VIDEOS: 'v', MONGODB_COLLECTION_USERS: 'u',
      MONGODB_COLLECTION_KEYS: 'k', MONGODB_COLLECTION_JOBS: 'j', UPLOAD_DIR: '/up', BASE_URL: 'https://b',
      DEMO_API_KEY: 'demo', ADMIN_PASSWORD: 'pw', IPFS_API_ADDR: 'http://ipfs', WEBHOOK_API_KEY: 'wk',
      WEBHOOK_URL: 'https://hook', CLEANUP_ENABLED: 'false', CLEANUP_INTERVAL_HOURS: '6',
      CLEANUP_RETENTION_DAYS: '2', UPLOAD_TOKEN_SECRET: 'sec', UPLOAD_TOKEN_DEFAULT_TTL: '60',
      UPLOAD_TOKEN_MAX_TTL: '120', UPLOAD_TOKEN_MAX_FILE_SIZE: '1000', MAX_UPLOAD_SIZE: '2000',
      DISPATCHER_ENABLED: 'false', GATE_URL: 'https://gate', GATE_INTERNAL_API_KEY: 'gk', GATE_CDN_BASE: 'https://cdn',
    });
    expect(loadConfig()).toMatchObject({
      port: 8080, tusdPort: 1111, tusdBinaryPath: '/bin/t', mongoUri: 'mongodb://x', mongoDbName: 'db1',
      mongoCollectionVideos: 'v', mongoCollectionUsers: 'u', mongoCollectionKeys: 'k', mongoCollectionJobs: 'j',
      uploadDir: '/up', baseUrl: 'https://b', demoApiKey: 'demo', adminPassword: 'pw', ipfsApiAddr: 'http://ipfs',
      webhookApiKey: 'wk', webhookUrl: 'https://hook', cleanupEnabled: false, cleanupIntervalHours: 6,
      cleanupRetentionDays: 2, uploadTokenSecret: 'sec', uploadTokenDefaultTtl: 60, uploadTokenMaxTtl: 120,
      uploadTokenMaxFileSize: 1000, maxUploadSize: 2000, dispatcherEnabled: false, gateUrl: 'https://gate',
      gateInternalApiKey: 'gk', gateCdnBase: 'https://cdn',
    });
  });

  it('only "false" turns cleanup and the dispatcher off', () => {
    process.env.CLEANUP_ENABLED = '0';
    process.env.DISPATCHER_ENABLED = 'no';
    const c = loadConfig();
    expect(c.cleanupEnabled).toBe(true);
    expect(c.dispatcherEnabled).toBe(true);
  });
});

describe('parseEncoders (via loadConfig)', () => {
  it('keeps only enabled encoders from the ENCODERS JSON array', () => {
    process.env.ENCODERS = JSON.stringify([
      { name: 'a', url: 'https://a', apiKey: 'ka', enabled: true },
      { name: 'b', url: 'https://b', apiKey: 'kb', enabled: false },
    ]);
    expect(loadConfig().encoders).toEqual([{ name: 'a', url: 'https://a', apiKey: 'ka', enabled: true }]);
  });

  it('ENCODERS wins over the legacy single-encoder variables', () => {
    process.env.ENCODERS = JSON.stringify([{ name: 'a', url: 'https://a', apiKey: 'ka', enabled: true }]);
    process.env.ENCODER_API_URL = 'https://legacy';
    process.env.ENCODER_API_KEY = 'lk';
    expect(loadConfig().encoders.map((e) => e.name)).toEqual(['a']);
  });

  it('falls back to ENCODER_API_URL + ENCODER_API_KEY', () => {
    process.env.ENCODER_API_URL = 'https://legacy';
    process.env.ENCODER_API_KEY = 'lk';
    expect(loadConfig().encoders).toEqual([{ name: 'default', url: 'https://legacy', apiKey: 'lk', enabled: true }]);
  });

  it('falls back to legacy when ENCODERS lists only disabled encoders', () => {
    process.env.ENCODERS = JSON.stringify([{ name: 'b', url: 'https://b', apiKey: 'kb', enabled: false }]);
    process.env.ENCODER_API_URL = 'https://legacy';
    process.env.ENCODER_API_KEY = 'lk';
    expect(loadConfig().encoders.map((e) => e.name)).toEqual(['default']);
  });

  it('needs both legacy variables', () => {
    process.env.ENCODER_API_URL = 'https://legacy';
    expect(loadConfig().encoders).toEqual([]);
  });

  it('logs and ignores malformed ENCODERS JSON', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.ENCODERS = '{not json';
    expect(loadConfig().encoders).toEqual([]);
    expect(err).toHaveBeenCalledWith('Failed to parse ENCODERS env variable:', expect.any(SyntaxError));
  });
});

describe('loadUploadLimitsConfig', () => {
  it('parses counts, exempt list and hive nodes from an explicit env', () => {
    expect(loadUploadLimitsConfig({
      UPLOAD_DAILY_LIMITS_ENABLED: 'false',
      UPLOAD_LIMIT_FREE_UPLOADS_CAPPED: 'true',
      UPLOAD_LIMIT_VIDEOS_PER_DAY: '5',
      UPLOAD_LIMIT_SHORTS_PER_DAY: '0',
      UPLOAD_LIMIT_WARMUP_VIDEOS_PER_DAY: '2',
      UPLOAD_LIMIT_WARMUP_SHORTS_PER_DAY: '4',
      UPLOAD_LIMIT_EXEMPT: ' @Alice, bob ,,',
      UPLOAD_LIMIT_WARMUP_LOOKUP_URL: 'https://w',
      UPLOAD_LIMIT_HIVE_NODES: 'https://h1, https://h2 ,',
      UPLOAD_UPGRADE_URL: 'https://up/{user}',
    })).toEqual({
      enabled: false,
      freeUploadsCapped: true,
      videosPerDay: 5,
      shortsPerDay: 0,
      warmupVideosPerDay: 2,
      warmupShortsPerDay: 4,
      exempt: ['alice', 'bob'],
      warmupLookupUrl: 'https://w',
      hiveApiNodes: ['https://h1', 'https://h2'],
      upgradeUrl: 'https://up/{user}',
    });
  });

  it('falls back on negative or non-numeric counts', () => {
    const c = loadUploadLimitsConfig({ UPLOAD_LIMIT_VIDEOS_PER_DAY: '-1', UPLOAD_LIMIT_SHORTS_PER_DAY: 'lots' });
    expect(c.videosPerDay).toBe(1);
    expect(c.shortsPerDay).toBe(3);
    expect(c.enabled).toBe(true);
    expect(c.freeUploadsCapped).toBe(false);
  });

  it('caps free uploads only for exactly "true"', () => {
    for (const v of ['1', 'yes', 'TRUE', ' true', '']) {
      expect(loadUploadLimitsConfig({ UPLOAD_LIMIT_FREE_UPLOADS_CAPPED: v }).freeUploadsCapped).toBe(false);
    }
    expect(loadUploadLimitsConfig({ UPLOAD_LIMIT_FREE_UPLOADS_CAPPED: 'true' }).freeUploadsCapped).toBe(true);
  });
});
