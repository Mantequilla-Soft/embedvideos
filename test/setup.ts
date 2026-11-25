import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomBytes } from 'crypto';

// Settings every test file starts from, before src/index.ts reads them. Each
// file gets its own database and upload folder, so files never see each
// other's rows.
process.env.MONGODB_DATABASE = `test_${randomBytes(6).toString('hex')}`;
process.env.UPLOAD_DIR = mkdtempSync(path.join(tmpdir(), 'embed-test-'));
process.env.UPLOAD_TOKEN_SECRET ??= 'test-upload-token-secret-0123456789abcdef';
process.env.ADMIN_PASSWORD ??= 'test-admin-password';
process.env.DEMO_API_KEY ??= 'sk_test_demo_key';
process.env.WEBHOOK_API_KEY ??= 'test-webhook-key';
process.env.WEBHOOK_URL ??= '';
process.env.BASE_URL ??= 'https://play.test/embed';
process.env.IPFS_API_ADDR ??= 'http://127.0.0.1:5999';
process.env.CLEANUP_ENABLED ??= 'false';
process.env.DISPATCHER_ENABLED ??= 'false';
// No test asks the real checker for a publish quota. Files that test the
// publish limit for other apps switch it on and stub the checker.
process.env.UPLOAD_PUBLISH_CHECK_ENABLED ??= 'false';
