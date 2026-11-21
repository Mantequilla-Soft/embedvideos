import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, symlinkSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { CleanupService } from '../../src/utils/cleanup';

const DAY = 24 * 60 * 60 * 1000;
let dir: string;

/** Writes a file of `size` bytes whose mtime is `ageDays` in the past. */
function file(name: string, size: number, ageDays: number) {
  const p = path.join(dir, name);
  writeFileSync(p, Buffer.alloc(size));
  const t = new Date(Date.now() - ageDays * DAY);
  utimesSync(p, t, t);
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cleanup-unit-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CleanupService.previewCleanup', () => {
  it('lists only files older than the retention, skipping directories, and deletes nothing', async () => {
    const old = file('old.mp4', 2048, 10);
    file('new.mp4', 1024, 1);
    mkdirSync(path.join(dir, 'olddir'));
    const t = new Date(Date.now() - 30 * DAY);
    utimesSync(path.join(dir, 'olddir'), t, t);

    const preview = await new CleanupService(dir, 7).previewCleanup();
    expect(preview.totalSize).toBe(2048);
    expect(preview.files).toHaveLength(1);
    expect(preview.files[0].name).toBe('old.mp4');
    expect(preview.files[0].size).toBe(2048);
    expect(preview.files[0].age).toBeGreaterThan(9.9);
    expect(existsSync(old)).toBe(true);
  });

  it('skips entries it cannot stat (dangling symlink)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    symlinkSync(path.join(dir, 'missing-target'), path.join(dir, 'dangling'));
    file('old.bin', 10, 30);
    const preview = await new CleanupService(dir, 7).previewCleanup();
    expect(preview.files.map((f) => f.name)).toEqual(['old.bin']);
    expect(err).toHaveBeenCalled();
  });

  it('returns an empty result for a missing directory', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await new CleanupService(path.join(dir, 'nope'), 7).previewCleanup()).toEqual({ files: [], totalSize: 0 });
  });
});

describe('CleanupService.runCleanup', () => {
  it('deletes old files, keeps new ones and directories, and reports stats', async () => {
    const old1 = file('a.mp4', 1000, 8);
    const old2 = file('b.mp4', 500, 100);
    const fresh = file('c.mp4', 300, 6);
    mkdirSync(path.join(dir, 'sub'));

    const stats = await new CleanupService(dir, 7).runCleanup();
    expect(stats).toEqual({ filesScanned: 4, filesDeleted: 2, bytesFreed: 1500, errors: [] });
    expect(existsSync(old1)).toBe(false);
    expect(existsSync(old2)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(path.join(dir, 'sub'))).toBe(true);
  });

  it('records a per-file error and carries on', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    symlinkSync(path.join(dir, 'missing-target'), path.join(dir, 'dangling'));
    file('old.bin', 10, 30);
    const stats = await new CleanupService(dir, 7).runCleanup();
    expect(stats.filesDeleted).toBe(1);
    expect(stats.errors).toHaveLength(1);
    expect(stats.errors[0]).toMatch(/^Failed to process dangling: /);
  });

  it('reports a missing directory as an error instead of throwing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const stats = await new CleanupService(path.join(dir, 'nope'), 7).runCleanup();
    expect(stats.filesScanned).toBe(0);
    expect(stats.errors[0]).toMatch(/^Cleanup failed: /);
  });

  it('retention 0 removes everything already on disk', async () => {
    file('x', 1, 0.001);
    const stats = await new CleanupService(dir, 0).runCleanup();
    expect(stats.filesDeleted).toBe(1);
  });
});

describe('CleanupService.start/stop', () => {
  it('runs immediately, then on the interval, and stops cleanly', async () => {
    vi.useFakeTimers();
    const svc = new CleanupService(dir, 7);
    const run = vi.spyOn(svc, 'runCleanup').mockResolvedValue({ filesScanned: 0, filesDeleted: 0, bytesFreed: 0, errors: [] });

    svc.start(2);
    expect(run).toHaveBeenCalledTimes(1);

    // A second start is ignored while running.
    svc.start(2);
    expect(run).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    expect(run).toHaveBeenCalledTimes(2);

    svc.stop();
    vi.advanceTimersByTime(10 * 60 * 60 * 1000);
    expect(run).toHaveBeenCalledTimes(2);

    // Can be started again after a stop; stop() twice is harmless.
    svc.start();
    expect(run).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(run).toHaveBeenCalledTimes(4);
    svc.stop();
    svc.stop();
  });

  it('logs instead of crashing when a run rejects', async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const svc = new CleanupService(dir, 7);
    vi.spyOn(svc, 'runCleanup').mockRejectedValue(new Error('boom'));
    svc.start(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    svc.stop();
    expect(err).toHaveBeenCalledWith('Initial cleanup failed:', expect.any(Error));
    expect(err).toHaveBeenCalledWith('Scheduled cleanup failed:', expect.any(Error));
  });
});
