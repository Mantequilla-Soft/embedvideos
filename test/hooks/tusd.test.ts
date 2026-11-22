import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import path from 'path';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from 'child_process';
import { startTusd } from '../../src/utils/tusd';

const spawnMock = vi.mocked(spawn);

function fakeProc() {
  const proc: any = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

const cfg = { tusdBinaryPath: './bin/tusd', uploadDir: './uploads', tusdPort: 1080 } as any;

let proc: any;
let log: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.restoreAllMocks();
  proc = fakeProc();
  spawnMock.mockReset();
  spawnMock.mockReturnValue(proc);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  err = vi.spyOn(console, 'error').mockImplementation(() => {});
});

const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

describe('startTusd', () => {
  it('spawns tusd on loopback with hooks pointing back at the app', () => {
    const returned = startTusd(cfg, 3123);
    expect(returned).toBe(proc);
    const [bin, args, opts] = spawnMock.mock.calls[0] as [string, string[], any];
    expect(bin).toBe(path.resolve('./bin/tusd'));
    expect(flag(args, '--host')).toBe('127.0.0.1');
    expect(flag(args, '--port')).toBe('1080');
    expect(flag(args, '--base-path')).toBe('/uploads');
    expect(flag(args, '--upload-dir')).toBe(path.resolve('./uploads'));
    expect(flag(args, '--hooks-http')).toBe('http://127.0.0.1:3123/tusd-hooks');
    expect(flag(args, '--hooks-enabled-events')).toBe('pre-create,pre-finish,post-finish');
    expect(flag(args, '--max-size')).toBe('0');
    expect(args).toContain('--behind-proxy');
    // The browser must be able to read the embed URL and the daily-limit Retry-After.
    expect(flag(args, '--cors-expose-headers').split(',')).toEqual(expect.arrayContaining(['X-Embed-URL', 'Retry-After']));
    expect(flag(args, '--cors-allow-headers').split(',')).toEqual(expect.arrayContaining(['X-API-Key', 'Authorization', 'Upload-Concat']));
    expect(opts).toEqual({ stdio: ['ignore', 'pipe', 'pipe'] });
  });

  it('relays tusd output line by line', () => {
    startTusd(cfg, 3000);
    proc.stdout.emit('data', Buffer.from('line one\n\nline two\n'));
    proc.stderr.emit('data', Buffer.from('oops\n'));
    expect(log).toHaveBeenCalledWith('[tusd] line one');
    expect(log).toHaveBeenCalledWith('[tusd] line two');
    expect(log).not.toHaveBeenCalledWith('[tusd] ');
    expect(err).toHaveBeenCalledWith('[tusd] oops');
  });

  it('logs exits by code and by signal', () => {
    startTusd(cfg, 3000);
    proc.emit('exit', 2, null);
    proc.emit('exit', null, 'SIGTERM');
    expect(log).toHaveBeenCalledWith('[tusd] exited with code 2');
    expect(log).toHaveBeenCalledWith('[tusd] terminated by signal SIGTERM');
  });

  it('explains a missing binary', () => {
    startTusd(cfg, 3000);
    proc.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    expect(err).toHaveBeenCalledWith('[tusd] failed to start: spawn ENOENT');
    expect(err).toHaveBeenCalledWith(`[tusd] binary not found at: ${path.resolve('./bin/tusd')}`);
    expect(err).toHaveBeenCalledWith('[tusd] run: bash scripts/install-tusd.sh');

    err.mockClear();
    proc.emit('error', Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    expect(err).toHaveBeenCalledTimes(1);
  });

  it('copes with a process that has no stdio pipes', () => {
    const bare: any = new EventEmitter();
    spawnMock.mockReturnValue(bare);
    expect(() => startTusd(cfg, 3000)).not.toThrow();
  });
});
