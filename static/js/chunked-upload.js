// Client for the server-side resumable upload sessions (/api/uploads).
// Used for files above the server-advertised threshold; smaller files keep using
// the legacy multipart /api/upload path in script.js. Protocol: docs/ChunkedUploads.md
// in the TeleCloud backend repository.
//
// The module is DOM-free: all I/O goes through an injected `transport`, which keeps
// it testable from Node (see tests/chunked-upload.test.mjs).

const MIB = 1024 * 1024;
const DEFAULT_CHUNK = 32 * MIB;
const MAX_PARALLEL = 4;
const MAX_ATTEMPTS = 8;            // counted failures per chunk (network, 5xx, 422...)
const MAX_BUSY_WAIT_MS = 20 * 60 * 1000; // cumulative 429/503/in-progress waiting per chunk
const HASH_STEP = 2 * MIB;
const FINALIZE_TIMEOUT_MS = 30 * 60 * 1000; // stop polling a stuck 'finalizing' session
const TARGET_CHUNK_SECONDS = 40;   // aim for each chunk request to finish well under Cloudflare's ~100 s limit
const MIN_CHUNK = 4 * MIB;
const FALLBACK_CHUNK = 16 * MIB;   // used when the upload speed could not be measured
const PROBE_WARMUP_BYTES = 256 * 1024;
const PROBE_BYTES = 4 * MIB;
const PROBE_TIMEOUT_MS = 20 * 1000;
const SPEED_TTL_MS = 5 * 60 * 1000;      // a measured speed is reused for a queue of files
const SPEED_FAIL_TTL_MS = 60 * 1000;     // do not re-probe (up to 20 s) for every file after a failure

// ---------------------------------------------------------------------------
// Incremental SHA-256 (FIPS 180-4). crypto.subtle cannot stream, so the
// whole-file digest is fed piece by piece while the file is read with slice().
// ---------------------------------------------------------------------------
const K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

export class Sha256 {
    constructor() {
        this.h = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
        this.w = new Int32Array(64);
        this.buf = new Uint8Array(64);
        this.bufLen = 0;
        this.length = 0; // total bytes consumed (safe up to 2^53)
    }

    _block(b, o) {
        const w = this.w, h = this.h;
        for (let i = 0; i < 16; i++, o += 4) {
            w[i] = (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
        }
        for (let i = 16; i < 64; i++) {
            const a = w[i - 15], c = w[i - 2];
            const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
            const s1 = ((c >>> 17) | (c << 15)) ^ ((c >>> 19) | (c << 13)) ^ (c >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }
        let a = h[0], b1 = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
        for (let i = 0; i < 64; i++) {
            const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            const ch = (e & f) ^ (~e & g);
            const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
            const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            const maj = (a & b1) ^ (a & c) ^ (b1 & c);
            const t2 = (S0 + maj) | 0;
            hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b1; b1 = a; a = (t1 + t2) | 0;
        }
        h[0] += a; h[1] += b1; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }

    /** @param {Uint8Array} data */
    update(data) {
        let off = 0;
        const n = data.length;
        this.length += n;
        if (this.bufLen > 0) {
            const take = Math.min(64 - this.bufLen, n);
            this.buf.set(data.subarray(0, take), this.bufLen);
            this.bufLen += take;
            off = take;
            if (this.bufLen < 64) return this;
            this._block(this.buf, 0);
            this.bufLen = 0;
        }
        for (; off + 64 <= n; off += 64) this._block(data, off);
        if (off < n) {
            this.buf.set(data.subarray(off), 0);
            this.bufLen = n - off;
        }
        return this;
    }

    digestHex() {
        const bits = this.length * 8;
        const padLen = (this.bufLen < 56 ? 56 : 120) - this.bufLen;
        const tail = new Uint8Array(padLen + 8);
        tail[0] = 0x80;
        const dv = new DataView(tail.buffer);
        dv.setUint32(padLen, Math.floor(bits / 0x100000000));
        dv.setUint32(padLen + 4, bits >>> 0);
        const len = this.length;
        this.update(tail);
        this.length = len;
        let out = '';
        for (let i = 0; i < 8; i++) out += (this.h[i] >>> 0).toString(16).padStart(8, '0');
        return out;
    }
}

function toHex(buf) {
    const b = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
    return s;
}

/** Native SHA-256 of one buffer (secure contexts only). */
export async function sha256Hex(buffer, subtle = globalThis.crypto && globalThis.crypto.subtle) {
    return toHex(await subtle.digest('SHA-256', buffer));
}

/** The server requires X-Chunk-SHA256, which needs crypto.subtle (HTTPS / localhost only). */
export function canUseSessionUploads() {
    return !!(globalThis.crypto && globalThis.crypto.subtle && typeof Blob !== 'undefined' &&
        typeof Blob.prototype.arrayBuffer === 'function');
}

// ---------------------------------------------------------------------------
// Transport (browser): XMLHttpRequest, so chunk bodies report upload progress.
// ---------------------------------------------------------------------------
export function createXhrTransport(getCsrfToken) {
    return function request({ method, url, headers = {}, json, body, signal, onProgress }) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open(method, url);
            if (method !== 'GET') xhr.setRequestHeader('X-CSRF-Token', getCsrfToken());
            for (const k of Object.keys(headers)) xhr.setRequestHeader(k, headers[k]);
            let payload = body;
            if (json !== undefined) {
                xhr.setRequestHeader('Content-Type', 'application/json');
                payload = JSON.stringify(json);
            }
            const onAbort = () => xhr.abort();
            if (signal) {
                if (signal.aborted) return reject(abortError());
                signal.addEventListener('abort', onAbort, { once: true });
            }
            const done = () => { if (signal) signal.removeEventListener('abort', onAbort); };
            if (onProgress && xhr.upload) {
                xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
            }
            xhr.onload = () => {
                done();
                let parsed = null;
                try { parsed = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
                resolve({ status: xhr.status, retryAfter: xhr.getResponseHeader('Retry-After'), json: parsed });
            };
            xhr.onerror = () => { done(); reject(networkError('network error')); };
            xhr.ontimeout = xhr.onerror;
            xhr.onabort = () => { done(); reject(abortError()); };
            xhr.send(payload);
        });
    };
}

function abortError() { const e = new Error('aborted'); e.name = 'AbortError'; return e; }
function networkError(msg) { const e = new Error(msg); e.network = true; return e; }

// ---------------------------------------------------------------------------
// Adaptive chunk size. The chunk size is fixed per session (sent in the create
// call), so it is picked from a quick upload-speed probe before POST /api/uploads.
// ---------------------------------------------------------------------------

/**
 * chunk = floor(bytesPerSec * targetSeconds / parallel), clamped to [minBytes, ceiling]
 * and rounded down to a whole MiB. An unusable speed yields min(ceiling, 16 MiB).
 * The ceiling always wins over minBytes (a server that advertises less than 4 MiB).
 */
export function chooseChunkSize({ bytesPerSec, parallel = 1, ceiling, targetSeconds = TARGET_CHUNK_SECONDS, minBytes = MIN_CHUNK }) {
    if (typeof bytesPerSec !== 'number' || !Number.isFinite(bytesPerSec) || bytesPerSec <= 0) {
        return Math.min(ceiling, FALLBACK_CHUNK);
    }
    const streams = Math.max(1, parallel || 1);
    const raw = Math.floor(bytesPerSec * targetSeconds / streams);
    const clamped = Math.min(ceiling, Math.max(minBytes, raw));
    return Math.max(MIB, Math.floor(clamped / MIB) * MIB);
}

/**
 * Measures the upload speed (bytes/second) with POST /api/uploads/probe: a 256 KiB warm-up
 * request, then a 4 MiB request of which only the second is timed (start of send to response).
 * Returns null on any error, 429/503/other non-200, abort or timeout (hard limit 20 s).
 * opts: { signal, timeoutMs, now }   (now: test seam, defaults to performance.now)
 */
export async function measureUploadSpeed(transport, opts = {}) {
    const now = opts.now || (() => (globalThis.performance ? performance.now() : Date.now()));
    const ac = new AbortController();
    const outer = opts.signal;
    const onOuterAbort = () => ac.abort();
    if (outer) {
        if (outer.aborted) return null;
        outer.addEventListener('abort', onOuterAbort, { once: true });
    }
    let timer;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { ac.abort(); reject(new Error('probe timeout')); }, opts.timeoutMs || PROBE_TIMEOUT_MS);
    });
    const post = (body) => transport({
        method: 'POST', url: '/api/uploads/probe', body, signal: ac.signal,
        headers: { 'Content-Type': 'application/octet-stream' },
    });
    const run = async () => {
        const buf = new Uint8Array(PROBE_BYTES); // zero-filled; the warm-up sends a view of the same memory
        const warm = await post(buf.subarray(0, PROBE_WARMUP_BYTES));
        if (!warm || warm.status !== 200) return null;
        const t0 = now();
        const res = await post(buf);
        const seconds = (now() - t0) / 1000;
        if (!res || res.status !== 200) return null;
        return PROBE_BYTES / Math.max(seconds, 0.001);
    };
    try {
        return await Promise.race([run(), deadline]);
    } catch (e) {
        return null;
    } finally {
        clearTimeout(timer);
        deadline.catch(() => {});
        if (outer) outer.removeEventListener('abort', onOuterAbort);
    }
}

// In-memory for the page lifetime; shared by every upload of a queue. Holds the pending
// promise too, so files that start together share a single probe.
const sharedSpeedCache = { entry: null };
export function resetSpeedCache(cache = sharedSpeedCache) { cache.entry = null; }

/** Cached measureUploadSpeed: ~5 min for a measurement, ~1 min for a failure (null). */
export function getCachedUploadSpeed(transport, { cache = sharedSpeedCache, now, measure = measureUploadSpeed } = {}) {
    const clock = now || (() => (globalThis.performance ? performance.now() : Date.now()));
    const e = cache.entry;
    if (e && clock() - e.at < e.ttl) return e.promise;
    const entry = { at: clock(), ttl: SPEED_TTL_MS, promise: null };
    // No per-upload signal here: one file being cancelled must not fail the probe the others wait on.
    entry.promise = measure(transport, { now }).then((v) => {
        entry.at = clock();
        entry.ttl = v == null ? SPEED_FAIL_TTL_MS : SPEED_TTL_MS;
        return v;
    });
    cache.entry = entry;
    return entry.promise;
}

export class UploadError extends Error {
    constructor(code, message, extra = {}) {
        super(message || code);
        this.name = 'UploadError';
        this.code = code;
        Object.assign(this, extra);
    }
}

// Session ids are not credentials (every call is also authenticated and scoped to the
// owner). They are only remembered together with the destination folder, because the
// session view does not report it and resuming into another folder would misplace the file.
const STORE_KEY = 'tc_upload_sessions';
function defaultStore() {
    try {
        const ls = globalThis.localStorage;
        if (!ls) return null;
        return {
            read: () => JSON.parse(ls.getItem(STORE_KEY) || '{}') || {},
            write: (m) => ls.setItem(STORE_KEY, JSON.stringify(m)),
        };
    } catch (e) { return null; }
}

const sleepAbortable = (ms, signal) => new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(abortError()); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
});

function parseRetryAfter(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    let sec = Number.isFinite(n) ? n : (Date.parse(v) - Date.now()) / 1000;
    if (!Number.isFinite(sec)) return null;
    return Math.min(120, Math.max(1, sec)) * 1000;
}

// Session errors after which a *resumed* session is discarded and recreated once.
const RESTART_CODES = new Set(['chunk_conflict', 'session_not_found', 'session_failed', 'session_cancelled', 'session_not_open', 'checksum_conflict']);

/**
 * One file upload through the session API.
 *
 * opts: {
 *   file, targetPath, overwrite, config (GET /api/uploads/config), transport,
 *   onProgress(uploadedBytes), onStatus(kind, info), onSession(id)   // all optional
 *   store, sleep, random, subtle, speedCache, measureSpeed            // test seams
 * }
 * run() resolves {fileId, finalName}; rejects with UploadError (or AbortError after cancel()).
 */
export class SessionUpload {
    constructor(opts) {
        this.o = opts;
        this.file = opts.file;
        this.req = opts.transport;
        this.ac = new AbortController();
        this.cancelled = false;
        this.subtle = opts.subtle || (globalThis.crypto && globalThis.crypto.subtle);
        this.store = opts.store === undefined ? defaultStore() : opts.store;
        this.random = opts.random || Math.random;
        this.sleep = opts.sleep || sleepAbortable;
        this.sessionId = null;
        this.hashState = { stop: false };
        const cfg = opts.config || {};
        const maxChunk = Math.min(cfg.max_chunk_size_bytes || 50 * MIB, 50 * MIB);
        this.chunkSize = Math.max(MIB, Math.min(cfg.chunk_size_bytes || DEFAULT_CHUNK, maxChunk));
        this.parallel = Math.max(1, Math.min(cfg.max_parallel_chunks || 3, MAX_PARALLEL));
    }

    status(kind, info) { if (this.o.onStatus) this.o.onStatus(kind, info || {}); }

    // Idempotent; resolves once the session has been DELETEd (best effort).
    cancel() {
        if (!this.cancelling) {
            this.cancelled = true;
            this.ac.abort();
            this.cancelling = this.sessionId ? this._discard(this.sessionId) : Promise.resolve();
        }
        return this.cancelling;
    }

    async _discard(id) {
        this._forget(id);
        try { await this.req({ method: 'DELETE', url: `/api/uploads/${id}` }); } catch (e) { /* best effort; TTL cleans up */ }
    }

    _remember(id) {
        try {
            if (!this.store) return;
            const m = this.store.read();
            m[id] = this.o.targetPath;
            const keys = Object.keys(m);
            for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete m[k];
            this.store.write(m);
        } catch (e) { /* storage unavailable */ }
    }
    _forget(id) {
        try {
            if (!this.store) return;
            const m = this.store.read();
            if (id in m) { delete m[id]; this.store.write(m); }
        } catch (e) { /* storage unavailable */ }
    }
    _remembered() { try { return this.store ? this.store.read() : {}; } catch (e) { return {}; } }

    async run() {
        let resumed = false;
        for (let round = 0; ; round++) {
            try {
                const session = round === 0 ? await this._findResumable() : null;
                resumed = !!session;
                return await this._upload(session || await this._create());
            } catch (e) {
                if (this.cancelled) throw abortError();
                if (round === 0 && resumed && e instanceof UploadError && RESTART_CODES.has(e.code)) {
                    // Stale or conflicting leftover session: start over once with a fresh one.
                    await this._discard(this.sessionId);
                    this.sessionId = null;
                    continue;
                }
                throw e;
            } finally {
                this.hashState.stop = true;
            }
        }
    }

    async _json(method, url, extra) {
        const res = await this.req({ method, url, signal: this.ac.signal, ...extra });
        return res;
    }

    // GET with the usual retry rules; returns the parsed body of a 2xx answer.
    async _call(method, url, json, okStatuses = [200, 201, 202]) {
        const res = await this._withRetry(() => this._json(method, url, json === undefined ? {} : { json }), okStatuses);
        return res;
    }

    // Generic retry wrapper for small control calls (not chunk PUTs).
    async _withRetry(fn, okStatuses) {
        let fails = 0;
        let waited = 0;
        for (;;) {
            if (this.cancelled) throw abortError();
            let res;
            try {
                res = await fn();
            } catch (e) {
                if (e.name === 'AbortError') throw e;
                if (++fails >= MAX_ATTEMPTS) throw new UploadError('network', 'network error');
                await this._backoff(fails);
                continue;
            }
            if (okStatuses.includes(res.status)) return res;
            const code = (res.json && res.json.error) || `http_${res.status}`;
            if (res.status === 429 || res.status === 503) {
                const ms = parseRetryAfter(res.retryAfter) ?? 2000;
                waited += ms;
                if (waited > MAX_BUSY_WAIT_MS) throw new UploadError(code, 'server busy', { status: res.status });
                this.status('waiting', { seconds: Math.ceil(ms / 1000) });
                await this.sleep(ms, this.ac.signal);
                continue;
            }
            if (res.status >= 500 && ++fails < MAX_ATTEMPTS) { await this._backoff(fails); continue; }
            throw new UploadError(code, res.json && res.json.message, { status: res.status, reason: res.json && res.json.message });
        }
    }

    async _backoff(attempt, minMs = 0) {
        const base = Math.min(30000, 1000 * 2 ** (attempt - 1));
        const ms = Math.max(minMs, base * (0.5 + this.random() * 0.5));
        this.status('retry', { attempt, seconds: Math.ceil(ms / 1000) });
        await this.sleep(ms, this.ac.signal);
    }

    async _findResumable() {
        try {
            const res = await this._json('GET', '/api/uploads');
            if (res.status !== 200 || !res.json || !Array.isArray(res.json.sessions)) return null;
            const remembered = this._remembered();
            const name = this.file.name.trim();
            const hit = res.json.sessions.find(s =>
                s.filename === name && s.total_size === this.file.size &&
                (s.state === 'open' || s.state === 'finalizing') &&
                remembered[s.id] === this.o.targetPath);
            if (hit) this.sessionId = hit.id;
            return hit || null;
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            return null;
        }
    }

    // New sessions only: a resumed session keeps the chunk size it was created with.
    async _pickChunkSize() {
        const ceiling = this.chunkSize;
        let bytesPerSec = null;
        try {
            this.status('probing');
            const probe = getCachedUploadSpeed(this.req, { cache: this.o.speedCache || sharedSpeedCache, measure: this.o.measureSpeed || measureUploadSpeed });
            // Stop waiting as soon as this upload is cancelled (the shared probe itself keeps running).
            bytesPerSec = await Promise.race([probe, new Promise((_, reject) => {
                if (this.ac.signal.aborted) return reject(abortError());
                this.ac.signal.addEventListener('abort', () => reject(abortError()), { once: true });
            })]);
        } catch (e) {
            if (e.name === 'AbortError') throw e;
        }
        return chooseChunkSize({ bytesPerSec, parallel: this.parallel, ceiling });
    }

    async _create() {
        const chunkSize = await this._pickChunkSize();
        const res = await this._call('POST', '/api/uploads', {
            filename: this.file.name,
            path: this.o.targetPath,
            size: this.file.size,
            mime_type: this.file.type || '',
            overwrite: !!this.o.overwrite,
            chunk_size: chunkSize,
        });
        this.sessionId = res.json.id;
        this._remember(this.sessionId);
        if (this.o.onSession) this.o.onSession(this.sessionId);
        if (this.cancelled) { await this._discard(this.sessionId); throw abortError(); }
        return res.json;
    }

    async _upload(session) {
        this.sessionId = session.id;
        if (this.o.onSession) this.o.onSession(session.id);
        if (this.cancelled) { await this._discard(session.id); throw abortError(); }
        const size = this.file.size;
        const chunkSize = session.chunk_size;
        const total = session.total_chunks || Math.ceil(size / chunkSize);
        this.chunkBytes = new Float64Array(total);
        this.uploaded = 0;
        this.hashState = { stop: false };

        const confirm = (ranges) => {
            const ok = new Uint8Array(total);
            for (const [a, b] of ranges || []) for (let i = a; i <= b && i < total; i++) ok[i] = 1;
            return ok;
        };
        const sizeOf = (i) => Math.min(chunkSize, size - i * chunkSize);
        const setBytes = (i, n) => {
            this.uploaded += n - this.chunkBytes[i];
            this.chunkBytes[i] = n;
            if (this.o.onProgress) this.o.onProgress(Math.min(size, this.uploaded));
        };
        let ok = confirm(session.confirmed_ranges);
        for (let i = 0; i < total; i++) if (ok[i]) setBytes(i, sizeOf(i));

        // Whole-file digest runs alongside the upload, reading the file independently.
        const hashPromise = this._hashFile(this.hashState);
        hashPromise.catch(() => {});

        for (let pass = 0; ; pass++) {
            const queue = [];
            for (let i = 0; i < total; i++) if (!ok[i]) queue.push(i);
            let failure = null;
            const worker = async () => {
                while (queue.length && !failure && !this.cancelled) {
                    const i = queue.shift();
                    try {
                        await this._putChunk(session.id, i, chunkSize, sizeOf(i), setBytes);
                        ok[i] = 1;
                    } catch (e) { failure = failure || e; }
                }
            };
            await Promise.all(Array.from({ length: Math.min(this.parallel, queue.length) }, worker));
            if (this.cancelled) throw abortError();
            if (failure) throw failure;

            this.status('verifying');
            const sha = await hashPromise;
            try {
                return await this._finalize(session.id, sha);
            } catch (e) {
                // Server lost some chunks (e.g. staging cleaned): re-sync and send the gaps.
                if (e instanceof UploadError && e.code === 'incomplete_upload' && pass < 3) {
                    const st = await this._call('GET', `/api/uploads/${session.id}`, undefined, [200]);
                    ok = confirm(st.json.confirmed_ranges);
                    this.uploaded = 0; this.chunkBytes.fill(0);
                    for (let i = 0; i < total; i++) if (ok[i]) setBytes(i, sizeOf(i));
                    continue;
                }
                throw e;
            }
        }
    }

    async _hashFile(state) {
        const h = new Sha256();
        for (let off = 0; off < this.file.size; off += HASH_STEP) {
            if (state.stop || this.cancelled) throw abortError();
            const buf = await this.file.slice(off, Math.min(off + HASH_STEP, this.file.size)).arrayBuffer();
            h.update(new Uint8Array(buf));
            await new Promise(r => setTimeout(r, 0)); // keep the UI responsive
        }
        return h.digestHex();
    }

    async _putChunk(id, index, chunkSize, expected, setBytes) {
        const start = index * chunkSize;
        const buf = await this.file.slice(start, start + expected).arrayBuffer();
        if (buf.byteLength !== expected) throw new UploadError('file_changed', 'file changed while uploading');
        const digest = await sha256Hex(buf, this.subtle);
        let fails = 0;
        let waited = 0;
        for (;;) {
            if (this.cancelled) throw abortError();
            let res;
            try {
                res = await this.req({
                    method: 'PUT', url: `/api/uploads/${id}/chunks/${index}`, body: buf, signal: this.ac.signal,
                    headers: { 'X-Chunk-SHA256': digest },
                    onProgress: (loaded) => setBytes(index, Math.min(loaded, expected)),
                });
            } catch (e) {
                if (e.name === 'AbortError') throw e;
                res = null; // dropped/reset connection: outcome unknown, resending is safe
            }
            if (res && res.status === 200 && res.json && Number(res.json.index) === index) {
                setBytes(index, expected);
                return;
            }
            setBytes(index, 0);
            const code = res && res.json && res.json.error;
            const st = res ? res.status : 0;
            if (res && (st === 429 || st === 503 || (st === 409 && code === 'chunk_in_progress'))) {
                const ms = parseRetryAfter(res.retryAfter) ?? 1500;
                waited += ms;
                if (waited > MAX_BUSY_WAIT_MS) throw new UploadError(code || 'server_busy', 'server busy', { status: st });
                this.status('waiting', { seconds: Math.ceil(ms / 1000) });
                await this.sleep(ms + this.random() * 500, this.ac.signal);
                continue;
            }
            // Fatal: conflicting content, auth/CSRF/session problems, disk full, other 4xx except retryable ones.
            const retryable = !res || st >= 500 || st === 422 || st === 408 || (st >= 200 && st < 300) ||
                (st === 400 && (code === 'chunk_length_mismatch' || code === 'chunk_read_failed'));
            if (!retryable) throw new UploadError(code || `http_${st}`, res.json && res.json.message, { status: st });
            if (++fails >= MAX_ATTEMPTS) {
                throw new UploadError(code || 'network', 'chunk failed', { status: st, network: !res });
            }
            await this._backoff(fails);
        }
    }

    async _finalize(id, sha256) {
        let view = (await this._call('POST', `/api/uploads/${id}/finalize`, { sha256 })).json;
        this.status('finalizing');
        const deadline = Date.now() + FINALIZE_TIMEOUT_MS;
        for (;;) {
            if (view.state === 'finalized') {
                this._forget(id);
                return { fileId: view.file_id, finalName: view.final_name };
            }
            if (view.state === 'failed' || view.state === 'cancelled') {
                throw new UploadError('session_' + view.state, view.failure_reason, { reason: view.failure_reason });
            }
            if (Date.now() > deadline) throw new UploadError('finalize_timeout', 'server did not finish storing the file');
            await this.sleep(2000, this.ac.signal);
            view = (await this._call('GET', `/api/uploads/${id}`, undefined, [200])).json;
        }
    }
}

/**
 * Returns the server config when the session API should be used for `file`, else null
 * (disabled, errored, below threshold, or crypto.subtle unavailable on a non-HTTPS origin).
 */
export async function getSessionConfig(transport) {
    if (!canUseSessionUploads()) return null;
    try {
        const res = await transport({ method: 'GET', url: '/api/uploads/config' });
        if (res.status !== 200 || !res.json || !res.json.enabled) return null;
        return res.json;
    } catch (e) { return null; }
}

export function shouldUseSessions(config, file) {
    return !!config && file.size > 0 && file.size > (config.threshold_bytes || 0);
}
