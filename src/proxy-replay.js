// Private, authenticated, bounded request replay. Interrupted files are discarded
// on startup: they are never a queue of requests to send after a restart.
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, chmod, open, readdir, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

export async function createReplayStore({ directory, encrypt, decrypt,
  maxBytes = 64 * 1024 * 1024, totalBytes = 256 * 1024 * 1024 } = {}) {
  if (![maxBytes, totalBytes].every(n => Number.isSafeInteger(n) && n > 0)) throw new TypeError('invalid replay limit');
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  for (const entry of await readdir(directory)) if (/^[a-f0-9-]{36}\.spool$/.test(entry)) await unlink(join(directory, entry));
  let reserved = 0;
  return {
    async start() {
      const id = randomUUID(), path = join(directory, id + '.spool');
      const file = await open(path, 'wx', 0o600);
      let sequence = 0, bytes = 0, sealed = false, disposed = false, writes = Promise.resolve();
      const write = event => {
        writes = writes.then(async () => {
          if (disposed) throw new Error('replay spool disposed');
          await file.writeFile(encrypt(JSON.stringify({ id, sequence: sequence++, ...event })) + '\n');
          await file.sync();
        });
        return writes;
      };
      return {
        id, path,
        get bytes() { return bytes; },
        async append(chunk) {
          if (sealed || disposed) throw new Error('replay spool closed');
          if (bytes + chunk.length > maxBytes || reserved + chunk.length > totalBytes)
            throw Object.assign(new Error('encrypted request replay capacity exceeded'), { code: 'REPLAY_LIMIT' });
          bytes += chunk.length; reserved += chunk.length;
          for (let i = 0; i < chunk.length; i += 65536) await write({ type: 'body', data: chunk.subarray(i, i + 65536).toString('base64') });
        },
        async seal(trailers) {
          if (sealed || disposed) throw new Error('replay spool closed');
          await write({ type: 'end', trailers }); sealed = true;
        },
        async *read() {
          if (!sealed || disposed) throw new Error('request is not completely replayable');
          await writes;
          const stream = createReadStream(path), lines = createInterface({ input: stream, crlfDelay: Infinity });
          let expected = 0, ended = false, count = 0;
          try {
            for await (const line of lines) {
              if (line.length > 150000 || ended) throw new Error('invalid replay record');
              const record = JSON.parse(decrypt(line));
              if (record.id !== id || record.sequence !== expected++) throw new Error('replay identity or ordering mismatch');
              if (record.type === 'body') { const chunk = Buffer.from(record.data, 'base64'); count += chunk.length; yield { chunk }; }
              else if (record.type === 'end' && Array.isArray(record.trailers)) { ended = true; yield { trailers: record.trailers }; }
              else throw new Error('invalid replay record');
            }
            if (!ended || count !== bytes) throw new Error('incomplete replay spool');
          } finally { lines.close(); stream.destroy(); }
        },
        async dispose() {
          if (disposed) return;
          // Finish any admitted write before closing/unlinking its file.
          await writes.catch(() => {}); disposed = true; reserved -= bytes;
          await file.close(); await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
        },
      };
    },
  };
}
