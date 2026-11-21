import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { Readable, Writable } from 'stream';
import { writeFileSync } from 'fs';
import path from 'path';
import { pinFile, unpinFile, announceDHT } from '../../src/utils/ipfs';

/**
 * ipfs.ts talks to the local Kubo daemon with http.request. A real daemon may
 * be listening on 127.0.0.1:5001 on this machine, so http.request is replaced
 * with a fake that records the request and answers as each test says.
 */
type Answer =
  | { status: number; body?: string; statusMessage?: string }
  | { error: Error }
  | { hang: true };

interface Recorded {
  options: http.RequestOptions;
  body: string;
  timeoutMs?: number;
}

let answer: Answer;
let recorded: Recorded[];

function fakeRequest(options: http.RequestOptions, onResponse: (res: any) => void) {
  const rec: Recorded = { options, body: '' };
  recorded.push(rec);
  let onTimeout: (() => void) | undefined;
  const req: any = new Writable({
    write(chunk, _enc, cb) {
      rec.body += chunk.toString();
      cb();
    },
  });
  req.setTimeout = (ms: number, cb: () => void) => {
    rec.timeoutMs = ms;
    onTimeout = cb;
    return req;
  };
  const origDestroy = req.destroy.bind(req);
  req.destroy = (err?: Error) => {
    origDestroy();
    if (err) setImmediate(() => req.emit('error', err));
    return req;
  };
  req.on('finish', () => {
    setImmediate(() => {
      if ('error' in answer) {
        req.emit('error', answer.error);
      } else if ('hang' in answer) {
        onTimeout?.();
      } else {
        const res: any = Readable.from(answer.body ? [answer.body] : []);
        res.statusCode = answer.status;
        res.statusMessage = answer.statusMessage ?? (answer.status === 200 ? 'OK' : 'Internal Server Error');
        onResponse(res);
      }
    });
  });
  return req;
}

beforeEach(() => {
  recorded = [];
  answer = { status: 200, body: '' };
  vi.spyOn(http, 'request').mockImplementation(fakeRequest as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function tempVideo(): string {
  const p = path.join(process.env.UPLOAD_DIR!, `ipfs-${Math.random().toString(36).slice(2)}.mp4`);
  writeFileSync(p, 'FAKE-MP4-BYTES');
  return p;
}

describe('pinFile', () => {
  it('uploads the file as multipart to the local daemon and returns the CID', async () => {
    answer = { status: 200, body: JSON.stringify({ Name: 'x', Hash: 'QmPinned', Size: '14' }) };
    const result = await pinFile(tempVideo());
    expect(result).toEqual({ cid: 'QmPinned', endpoint: 'http://127.0.0.1:5001' });
    const { options, body } = recorded[0];
    expect(options).toMatchObject({ hostname: '127.0.0.1', port: '5001', path: '/api/v0/add?pin=true', method: 'POST' });
    expect(String((options.headers as any)['content-type'])).toMatch(/^multipart\/form-data; boundary=/);
    expect(body).toContain('FAKE-MP4-BYTES');
    expect(body).toContain('name="file"');
  });

  it('fails on a non-200 answer', async () => {
    answer = { status: 500, body: 'out of disk' };
    await expect(pinFile(tempVideo())).rejects.toThrow('Failed to pin file to IPFS: Error: IPFS API error: 500 Internal Server Error');
  });

  it('fails on an unreadable answer', async () => {
    answer = { status: 200, body: 'not json' };
    await expect(pinFile(tempVideo())).rejects.toThrow(/Failed to parse IPFS response/);
  });

  it('fails when the daemon is unreachable', async () => {
    answer = { error: new Error('connect ECONNREFUSED 127.0.0.1:5001') };
    await expect(pinFile(tempVideo())).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe('unpinFile', () => {
  it('removes the pin at the given endpoint', async () => {
    await expect(unpinFile('QmOld', 'http://10.0.0.5:5002')).resolves.toBeUndefined();
    expect(recorded[0].options).toMatchObject({ hostname: '10.0.0.5', port: '5002', path: '/api/v0/pin/rm?arg=QmOld', method: 'POST' });
  });

  it('defaults the port and rethrows failures', async () => {
    answer = { status: 500, body: 'not pinned or pinned indirectly' };
    await expect(unpinFile('QmX', 'http://ipfs.local')).rejects.toThrow('IPFS unpin API error: 500 Internal Server Error');
    expect(recorded[0].options.port).toBe(80);

    answer = { error: new Error('socket hang up') };
    await expect(unpinFile('QmX', 'http://ipfs.local')).rejects.toThrow('socket hang up');
  });
});

describe('announceDHT', () => {
  it('provides via the routing API (the old dht/provide endpoint is gone)', async () => {
    await announceDHT('QmAnn');
    expect(recorded[0].options).toMatchObject({ hostname: '127.0.0.1', port: '5001', path: '/api/v0/routing/provide?arg=QmAnn', method: 'POST' });
    expect(recorded[0].timeoutMs).toBe(30_000);
  });

  it('never throws: HTTP errors, network errors and timeouts are only logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    answer = { status: 500, body: 'removed' };
    await expect(announceDHT('Qm1')).resolves.toBeUndefined();
    answer = { error: new Error('ECONNREFUSED') };
    await expect(announceDHT('Qm2')).resolves.toBeUndefined();
    answer = { hang: true };
    await expect(announceDHT('Qm3')).resolves.toBeUndefined();
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('IPFS DHT provide API error: 500'))).toBe(true);
    expect(messages.some((m) => m.includes('timed out after 30000ms'))).toBe(true);
  });
});
