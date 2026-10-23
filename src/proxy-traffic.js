// Complete, encrypted application-HTTP capture. Each fsync finishes before the
// captured bytes are forwarded. No body is buffered in memory as a whole.
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, chmod, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export async function createTrafficStore({ db, directory, encrypt, decrypt }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  db.exec(`CREATE TABLE IF NOT EXISTS proxy_traffic (
    id INTEGER PRIMARY KEY AUTOINCREMENT, file_id TEXT NOT NULL UNIQUE,
    started TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    finished TEXT, client_id INTEGER, provider TEXT, status INTEGER,
    state TEXT NOT NULL DEFAULT 'running', request_bytes INTEGER NOT NULL DEFAULT 0,
    response_bytes INTEGER NOT NULL DEFAULT 0
  )`);
  const fileFor = (row) => join(directory, row.file_id + '.events');
  const find = db.prepare('SELECT * FROM proxy_traffic WHERE id=?');
  const update = db.prepare(`UPDATE proxy_traffic SET finished=?,state=?,status=?,request_bytes=?,response_bytes=? WHERE id=?`);
  const writeEvent = async (file, fileId, sequence, event) => {
    await file.writeFile(encrypt(JSON.stringify({ capture_id: fileId, sequence, event })) + '\n');
    await file.sync();
  };
  const readEvents = async function* (row) {
    const stream = createReadStream(fileFor(row));
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let sequence = 0, last;
    try {
      for await (const line of lines) if (line) {
        const record = JSON.parse(decrypt(line));
        if (record.capture_id !== row.file_id || record.sequence !== sequence) throw new Error('traffic event identity or ordering mismatch');
        last = record.event;
        yield { sequence: sequence++, ...record.event };
      }
      if (!['running', 'logging_error'].includes(row.state) && !['end', 'interrupted'].includes(last?.type)) throw new Error('traffic capture is missing its terminal event');
    } finally { lines.close(); stream.destroy(); }
  };
  // A request still running after a process restart was interrupted, not complete.
  for (const row of db.prepare("SELECT * FROM proxy_traffic WHERE state='running'").all()) {
    let file;
    try {
      let sequence = 0, requestBytes = 0, responseBytes = 0, status = row.status;
      for await (const event of readEvents(row)) {
        sequence++;
        if (event.type === 'request_body') requestBytes += Buffer.from(event.data, 'base64').length;
        if (event.type === 'response_body') responseBytes += Buffer.from(event.data, 'base64').length;
        if (event.type === 'response') status = event.status;
      }
      file = await open(fileFor(row), 'a', 0o600);
      await writeEvent(file, row.file_id, sequence, { type: 'interrupted', at: new Date().toISOString(), reason: 'process restarted before completion' });
      update.run(new Date().toISOString(), 'interrupted', status, requestBytes, responseBytes, row.id);
    } catch { update.run(new Date().toISOString(), 'logging_error', row.status, row.request_bytes, row.response_bytes, row.id); }
    finally { if (file) await file.close(); }
  }
  return {
    async start({ clientId = null, provider = null, ...request }) {
      const fileId = randomUUID();
      const file = await open(join(directory, fileId + '.events'), 'wx', 0o600);
      let id;
      try {
        await writeEvent(file, fileId, 0, { type: 'request', at: new Date().toISOString(), ...request });
        id = Number(db.prepare('INSERT INTO proxy_traffic(file_id,client_id,provider) VALUES(?,?,?)').run(fileId, clientId, provider).lastInsertRowid);
      } catch (e) { await file.close(); throw e; }
      let closed = false, closing = false, finishing, requestBytes = 0, responseBytes = 0, sequence = 1, writes = Promise.resolve();
      const append = (type, data = {}) => {
        if (closed || closing) return Promise.reject(new Error('capture is closed'));
        writes = writes.then(async () => {
          await writeEvent(file, fileId, sequence++, { type, at: new Date().toISOString(), ...data });
          if (type === 'request_body') requestBytes += Buffer.from(data.data, 'base64').length;
          if (type === 'response_body') responseBytes += Buffer.from(data.data, 'base64').length;
        });
        return writes;
      };
      return {
        id, append,
        async chunk(direction, chunk) {
          // Bound encrypted line size even if a caller supplies a very large chunk.
          for (let i = 0; i < chunk.length; i += 65536) {
            const part = chunk.subarray(i, i + 65536);
            await append(direction + '_body', { encoding: 'base64', data: part.toString('base64') });
          }
        },
        finish(state, status = null, extra = {}) {
          if (finishing) return finishing;
          closing = true;
          finishing = (async () => {
            try {
              await writes;
              await writeEvent(file, fileId, sequence++, { type: 'end', at: new Date().toISOString(), state, status, request_bytes: requestBytes, response_bytes: responseBytes, ...extra });
              update.run(new Date().toISOString(), state, status, requestBytes, responseBytes, id);
            } catch (e) {
              update.run(new Date().toISOString(), 'logging_error', status, requestBytes, responseBytes, id); throw e;
            } finally { closed = true; await file.close(); }
          })();
          return finishing;
        },
      };
    },
    list(limit = 100, before = Number.MAX_SAFE_INTEGER) {
      return db.prepare('SELECT id,started,finished,client_id,provider,status,state,request_bytes,response_bytes FROM proxy_traffic WHERE id<? ORDER BY id DESC LIMIT ?').all(before, limit);
    },
    get(id) {
      const row = find.get(id);
      if (!row) return null;
      const { file_id, ...publicRow } = row;
      return publicRow;
    },
    async *events(id) {
      const row = find.get(id);
      if (!row) return;
      yield* readEvents(row);
    },
    async page(id, after = -1, limit = 100) {
      const events = [];
      for await (const event of this.events(id)) {
        if (event.sequence <= after) continue;
        if (events.length === limit) return { events, next_after: events.at(-1).sequence };
        events.push(event);
      }
      return { events, next_after: null };
    },
    async download(id, res) {
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="proxy-traffic-${id}.ndjson"` });
      try {
        for await (const event of this.events(id)) {
          if (res.destroyed) return;
          if (!res.write(JSON.stringify(event) + '\n')) await new Promise((resolve, reject) => {
            const cleanup = () => { res.off('drain', ready); res.off('close', closed); res.off('error', failed); };
            const ready = () => { cleanup(); resolve(); };
            const failed = (error) => { cleanup(); reject(error); };
            const closed = () => failed(new Error('closed'));
            res.once('drain', ready); res.once('close', closed); res.once('error', failed);
          });
        }
        res.end();
      } catch { res.destroy(); }
    },
  };
}
