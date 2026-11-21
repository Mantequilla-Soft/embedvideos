import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';

// The /uploads tusd proxy and its timeout/counting middleware, against a local
// stand-in for tusd (nothing leaves the machine). The stub's port is chosen
// before src/index.ts reads TUSD_PORT, so the app is loaded inside beforeAll.

const seen: { method: string; url: string; proto?: string }[] = [];
let stub: http.Server;
let r: any;

beforeAll(async () => {
  stub = http.createServer((req, res) => {
    seen.push({ method: req.method!, url: req.url!, proto: req.headers['x-forwarded-proto'] as string | undefined });
    req.resume();
    req.on('end', () => {
      if (req.method === 'POST') { res.writeHead(201, { Location: '/uploads/abc123' }); return res.end(); }
      if (req.method === 'PATCH') { res.writeHead(204); return res.end(); }
      res.writeHead(200, { 'Access-Control-Expose-Headers': 'Upload-Offset' });
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  process.env.TUSD_PORT = String((stub.address() as AddressInfo).port);
  const { api } = await import('../helpers/app');
  r = await api();
});
afterAll(async () => { await new Promise((resolve) => stub.close(resolve)); });

describe('/uploads tusd proxy', () => {
  it('forwards creation with the full path and only the first forwarded proto', async () => {
    const res = await r.post('/uploads').set('X-Forwarded-Proto', 'https, http').set('Tus-Resumable', '1.0.0').send('');
    expect(res.status).toBe(201);
    expect(seen.at(-1)).toMatchObject({ method: 'POST', url: '/uploads', proto: 'https' });
    expect(res.headers['access-control-expose-headers']).toBe('X-Embed-URL, Retry-After');
  });

  it('forwards PATCH to the upload path and merges exposed headers', async () => {
    const res = await r.patch('/uploads/abc123').set('Content-Type', 'application/offset+octet-stream').send(Buffer.alloc(10));
    expect(res.status).toBe(204);
    expect(seen.at(-1)).toMatchObject({ method: 'PATCH', url: '/uploads/abc123' });

    const head = await r.get('/uploads/abc123');
    expect(head.status).toBe(200);
    expect(head.headers['access-control-expose-headers']).toBe('Upload-Offset, X-Embed-URL, Retry-After');
  });

  it('settles the in-flight upload counter after each request', async () => {
    await r.post('/uploads').send('');
    const health = await r.get('/health');
    expect(health.body.activeUploads).toBe(0);
  });
});
