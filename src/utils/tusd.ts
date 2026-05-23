import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { Config } from '../config/config';

export function startTusd(config: Config, appPort: number): ChildProcess {
  const binaryPath = path.resolve(config.tusdBinaryPath);
  const uploadDir = path.resolve(config.uploadDir);

  const args = [
    '--host', '127.0.0.1',
    '--port', config.tusdPort.toString(),
    '--base-path', '/uploads',
    '--behind-proxy',
    '--upload-dir', uploadDir,
    '--hooks-http', `http://127.0.0.1:${appPort}/tusd-hooks`,
    '--hooks-enabled-events', 'pre-create,pre-finish,post-finish',
    '--cors-allow-origin', '.*',
    '--cors-allow-headers', 'X-API-Key,Authorization,Origin,X-Requested-With,Content-Type,Upload-Length,Upload-Offset,Tus-Resumable,Upload-Metadata,Upload-Defer-Length,Upload-Concat,X-HTTP-Method-Override',
    '--cors-expose-headers', 'X-Embed-URL,Upload-Offset,Location,Upload-Length,Tus-Version,Tus-Resumable,Tus-Max-Size,Tus-Extension,Upload-Metadata,Upload-Defer-Length,Upload-Concat',
    '--max-size', '0',
  ];

  console.log(`Starting tusd on 127.0.0.1:${config.tusdPort} (uploads → ${uploadDir})`);

  const proc = spawn(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  proc.stdout?.on('data', (d: Buffer) => {
    d.toString().split('\n').filter(Boolean).forEach(line => console.log(`[tusd] ${line}`));
  });
  proc.stderr?.on('data', (d: Buffer) => {
    d.toString().split('\n').filter(Boolean).forEach(line => console.error(`[tusd] ${line}`));
  });
  proc.on('exit', (code, signal) => {
    if (signal) {
      console.log(`[tusd] terminated by signal ${signal}`);
    } else {
      console.log(`[tusd] exited with code ${code}`);
    }
  });
  proc.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`[tusd] failed to start: ${err.message}`);
    if (err.code === 'ENOENT') {
      console.error(`[tusd] binary not found at: ${binaryPath}`);
      console.error(`[tusd] run: bash scripts/install-tusd.sh`);
    }
  });

  return proc;
}
