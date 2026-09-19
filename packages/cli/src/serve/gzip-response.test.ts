/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express, { type Express } from 'express';
import supertest from 'supertest';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { acceptsGzip, gzipJsonResponses } from './gzip-response.js';

/** A transcript-shaped payload comfortably past the 1 KiB threshold. */
function largeJsonPayload(): Record<string, unknown> {
  const events = Array.from({ length: 120 }, (_, i) => ({
    id: i + 1,
    v: 1,
    type: 'session_update',
    data: {
      sessionId: 'session-large',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `assistant message chunk ${i} with repeated transcript prose `.repeat(
            3,
          ),
        },
      },
    },
  }));
  return {
    sessionId: 'session-large',
    attached: true,
    state: { phase: 'idle' },
    compactedReplay: events,
  };
}

function buildApp(
  routes: (app: Express) => void,
  middleware: express.RequestHandler = gzipJsonResponses(),
): Express {
  const app = express();
  app.use(middleware);
  routes(app);
  return app;
}

describe('acceptsGzip', () => {
  it.each([
    ['gzip', true],
    ['GZIP', true],
    ['deflate, gzip', true],
    ['gzip, deflate, br', true],
    ['gzip;q=0.5', true],
    ['gzip;q=1.0, br', true],
    ['br', false],
    ['deflate', false],
    ['', false],
    ['identity', false],
    ['gzip;q=0', false],
    ['gzip; q="0"', false],
    ['gzip;q=0.000, deflate', false],
    ['deflate, gzip; q=0', false],
  ])('Accept-Encoding %j -> %s', (header, expected) => {
    expect(acceptsGzip(header)).toBe(expected);
  });

  it('returns false for missing or non-string headers', () => {
    expect(acceptsGzip(undefined)).toBe(false);
    expect(acceptsGzip(['gzip'])).toBe(false);
  });
});

describe('gzipJsonResponses middleware', () => {
  it('compresses large JSON responses for gzip-capable clients', async () => {
    const payload = largeJsonPayload();
    const identity = Buffer.byteLength(JSON.stringify(payload));
    const app = buildApp((a) => {
      a.get('/session/:id/load', (_req, res) => {
        res.status(200).json(payload);
      });
    });

    const res = await supertest(app)
      .get('/session/large/load')
      .set('Accept-Encoding', 'gzip, deflate, br');

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(String(res.headers['vary']).toLowerCase()).toContain(
      'accept-encoding',
    );
    // Transcript-shaped JSON must shrink dramatically; this also pins the
    // compression win the PR claims. content-length carries the wire (gzip)
    // byte count — superagent transparently decompresses it before exposing
    // res.body, mirroring what browser fetch does for the Web Shell client.
    expect(res.headers['content-length']).toBeDefined();
    expect(Number(res.headers['content-length'])).toBeLessThan(identity / 2);
    expect(res.body).toEqual(payload);
  });

  it('sends identity responses when the client does not offer gzip', async () => {
    const payload = largeJsonPayload();
    const app = buildApp((a) => {
      a.get('/session/:id/load', (_req, res) => {
        res.json(payload);
      });
    });

    // `identity` (not "no header"): superagent always sends a default
    // `Accept-Encoding: gzip, deflate`, so "no header" cannot be expressed.
    for (const encoding of ['identity', 'deflate', 'br', 'gzip;q=0']) {
      const res = await supertest(app)
        .get('/session/large/load')
        .set('Accept-Encoding', encoding);
      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.body).toEqual(payload);
    }
  });

  it('skips bodies below the threshold', async () => {
    const app = buildApp((a) => {
      a.get('/small', (_req, res) => {
        res.json({ ok: true, note: 'tiny body' });
      });
    });

    const res = await supertest(app)
      .get('/small')
      .set('Accept-Encoding', 'gzip');

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body).toEqual({ ok: true, note: 'tiny body' });
  });

  it('still advertises Vary: Accept-Encoding on small JSON pass-throughs', async () => {
    const app = buildApp((a) => {
      a.get('/small', (_req, res) => {
        res.json({ ok: true });
      });
    });

    const res = await supertest(app)
      .get('/small')
      .set('Accept-Encoding', 'gzip');

    expect(String(res.headers['vary']).toLowerCase()).toContain(
      'accept-encoding',
    );
  });

  it('does not compress HEAD responses', async () => {
    const app = buildApp((a) => {
      a.head('/session/:id/load', (_req, res) => {
        res.json(largeJsonPayload());
      });
    });

    const res = await supertest(app)
      .head('/session/large/load')
      .set('Accept-Encoding', 'gzip');

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(String(res.headers['vary']).toLowerCase()).toContain(
      'accept-encoding',
    );
  });

  it('does not double-encode responses that already carry Content-Encoding', async () => {
    const raw = Buffer.from(JSON.stringify({ pre: 'encoded' }));
    const app = buildApp((a) => {
      a.get('/pre-encoding', (_req, res) => {
        res.setHeader('Content-Encoding', 'gzip');
        res.send(gzipSync(raw));
      });
    });

    const res = await supertest(app)
      .get('/pre-encoding')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    // Exactly the one pre-set value, no second encoding layered on top:
    // superagent transparently inflates one gzip layer, and the result must
    // be the original JSON — a double-encoded body would leave gzip bytes
    // that fail JSON.parse.
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({
      pre: 'encoded',
    });
  });

  it('leaves SSE / res.write streaming responses untouched', async () => {
    const app = buildApp((a) => {
      a.get('/events', (_req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.flushHeaders?.();
        res.write(`data: ${JSON.stringify('event '.repeat(512))}\n\n`);
        res.end();
      });
    });

    const res = await supertest(app)
      .get('/events')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.toString('utf8')).toContain('data: "event');
  });

  it('leaves attachment downloads untouched', async () => {
    const body = JSON.stringify(largeJsonPayload());
    const app = buildApp((a) => {
      a.get('/export', (_req, res) => {
        res
          .status(200)
          .set('Content-Type', 'application/json')
          .set('Content-Disposition', 'attachment; filename="transcript.json"')
          .send(body);
      });
    });

    const res = await supertest(app)
      .get('/export')
      .set('Accept-Encoding', 'gzip');

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(res.text)).toEqual(largeJsonPayload());
  });

  it('leaves non-JSON (HTML) responses untouched', async () => {
    const app = buildApp((a) => {
      a.get('/html', (_req, res) => {
        res
          .status(200)
          .set('Content-Type', 'text/html; charset=utf-8')
          .send(`<html><body>${'x'.repeat(4096)}</body></html>`);
      });
    });

    const res = await supertest(app)
      .get('/html')
      .set('Accept-Encoding', 'gzip');

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.text).toContain('<html>');
  });

  it('leaves 204/304 responses untouched', async () => {
    const app = buildApp((a) => {
      a.get('/no-content', (_req, res) => {
        res.status(204).json({ never: 'sent' });
      });
      a.get('/not-modified', (_req, res) => {
        res.status(304).json({ never: 'sent' });
      });
    });

    for (const path of ['/no-content', '/not-modified']) {
      const res = await supertest(app).get(path).set('Accept-Encoding', 'gzip');
      expect([204, 304]).toContain(res.status);
      expect(res.headers['content-encoding']).toBeUndefined();
    }
  });

  it('drops the identity ETag on the compressed path', async () => {
    const app = buildApp((a) => {
      a.get('/etagged', (_req, res) => {
        res.set('ETag', '"identity-tag"').json(largeJsonPayload());
      });
    });

    const identityRes = await supertest(app)
      .get('/etagged')
      .set('Accept-Encoding', 'identity');
    expect(identityRes.headers['etag']).toBe('"identity-tag"');

    const gzipRes = await supertest(app)
      .get('/etagged')
      .set('Accept-Encoding', 'gzip');
    expect(gzipRes.headers['content-encoding']).toBe('gzip');
    expect(gzipRes.headers['etag']).toBeUndefined();
  });

  it('compresses Buffer bodies sent via res.send with a JSON content type', async () => {
    const payload = largeJsonPayload();
    const app = buildApp((a) => {
      a.get('/buffered', (_req, res) => {
        res.set('Content-Type', 'application/json; charset=utf-8');
        res.send(Buffer.from(JSON.stringify(payload)));
      });
    });

    const res = await supertest(app)
      .get('/buffered')
      .set('Accept-Encoding', 'gzip');

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.body).toEqual(payload);
  });

  it('never sends a compressed representation larger than identity', async () => {
    // Random base64 carries ~6 bits of entropy per character: wrapped in JSON
    // it stays past the threshold while barely compressing, and the middleware
    // must prefer whichever representation is actually smaller.
    const blob = randomBytes(6144).toString('base64');
    const app = buildApp((a) => {
      a.get('/random', (_req, res) => {
        res.json({ blob });
      });
    });

    const identity = Buffer.byteLength(JSON.stringify({ blob }));
    const res = await supertest(app)
      .get('/random')
      .set('Accept-Encoding', 'gzip');

    expect(res.status).toBe(200);
    if (res.headers['content-encoding'] === 'gzip') {
      expect(Number(res.headers['content-length'])).toBeLessThan(identity);
      expect(res.body).toEqual({ blob });
    } else {
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.body).toEqual({ blob });
    }
  });

  it('honors a custom threshold option', async () => {
    // 240 bytes of highly repetitive text: below the 1 KiB default (skipped)
    // but above a custom threshold of 8, and compressible enough that the
    // gzip result beats identity so the compressed path is taken.
    const app = buildApp(
      (a) => {
        a.get('/tiniest', (_req, res) => {
          res.json({ blob: 'a'.repeat(232) });
        });
      },
      gzipJsonResponses({ threshold: 8 }),
    );

    const defaultThresholdRes = await supertest(app)
      .get('/tiniest')
      .set('Accept-Encoding', 'identity');
    expect(defaultThresholdRes.headers['content-encoding']).toBeUndefined();

    const res = await supertest(app)
      .get('/tiniest')
      .set('Accept-Encoding', 'gzip');

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.body).toEqual({ blob: 'a'.repeat(232) });
  });

  it('keeps error-status JSON bodies functional', async () => {
    const message = 'x'.repeat(2048);
    const app = buildApp((a) => {
      a.get('/fails', (_req, res) => {
        res.status(400).json({ error: message, code: 'bad_request' });
      });
    });

    const res = await supertest(app)
      .get('/fails')
      .set('Accept-Encoding', 'gzip');

    expect(res.status).toBe(400);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.body).toEqual({ error: message, code: 'bad_request' });
  });
});
