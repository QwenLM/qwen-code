/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { RequestHandler } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTHENTICATED_REQUEST } from '../auth.js';
import { tagListener } from '../local-control/listener-identity.js';
import {
  findExplicitCandidate,
  listLanCandidates,
} from '../local-control/lan-interfaces.js';
import {
  InvalidLocalControlTargetError,
  LocalControlBindError,
  type LocalControlService,
} from '../local-control/service.js';
import { registerWorkspaceLocalControlRoutes } from './workspace-local-control.js';
import {
  writeStderrLineSafe,
  writeStdoutLineSafe,
} from '../../utils/stdioHelpers.js';

vi.mock('../../utils/stdioHelpers.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/stdioHelpers.js')>();
  return {
    ...actual,
    writeStderrLineSafe: vi.fn(),
    writeStdoutLineSafe: vi.fn(),
  };
});

// The enable route gates posted addresses on the live candidate list and the
// withUiData payload checks whether the granted address is still held; both
// are stubbed per test so no host interface state leaks in.
vi.mock('../local-control/lan-interfaces.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../local-control/lan-interfaces.js')>();
  return {
    ...actual,
    listLanCandidates: vi.fn(() => []),
    findExplicitCandidate: vi.fn(() => undefined),
  };
});

/** Marks the request bearer-authenticated the way `bearerAuth` does after
 *  verifying a token — the routes key the pairing-secret redaction on it
 *  (#9106). */
const asAuthenticated: RequestHandler = (req, _res, next) => {
  (req as unknown as Record<symbol, true>)[AUTHENTICATED_REQUEST] = true;
  next();
};

describe('Local Control routes', () => {
  beforeEach(() => {
    vi.mocked(listLanCandidates).mockReturnValue([]);
    vi.mocked(findExplicitCandidate).mockClear();
    vi.mocked(findExplicitCandidate).mockReturnValue(undefined);
  });

  it('flushes a LAN disable response before closing its connection', async () => {
    const app = express();
    const server = createServer(app);
    const disable = vi.fn(async () => {
      server.closeAllConnections();
      return { active: false };
    });
    registerWorkspaceLocalControlRoutes(app, {
      service: {
        disable,
      } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({}),
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as AddressInfo).port;
    tagListener(server, {
      kind: 'local-control',
      authority: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
    });

    try {
      const response = await request(server)
        .post('/workspace/local-control/disable')
        .set('Host', `127.0.0.1:${port}`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ active: false });
      expect(disable).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('allows tokenless loopback enable through the route listener gate', async () => {
    const app = express();
    const enable = vi.fn(async () => ({ active: true }));
    registerWorkspaceLocalControlRoutes(app, {
      service: {
        enable,
      } as unknown as LocalControlService,
      mutate: (opts) => (_req, res, next) => {
        if (opts?.strict) {
          res.status(401).json({ code: 'token_required' });
          return;
        }
        next();
      },
      safeBody: () => ({}),
    });

    const response = await request(app).post('/workspace/local-control/enable');

    expect(response.status).toBe(200);
    expect(response.body.active).toBe(true);
    expect(enable).toHaveBeenCalledOnce();
  });

  it('rejects runtime enable when the primary bind is not loopback', async () => {
    // The runtime route preserves the same documented deployment boundary as
    // the `--local-control` CLI flag.
    const app = express();
    const enable = vi.fn();
    registerWorkspaceLocalControlRoutes(app, {
      service: { enable } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({}),
      primaryBindHostname: '0.0.0.0',
    });

    const response = await request(app).post('/workspace/local-control/enable');

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('local_control_non_loopback_bind');
    expect(enable).not.toHaveBeenCalled();
  });

  it('allows runtime enable on a loopback primary bind', async () => {
    const app = express();
    const enable = vi.fn(async () => ({ active: true }));
    registerWorkspaceLocalControlRoutes(app, {
      service: { enable } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({}),
      primaryBindHostname: '127.0.0.1',
    });

    const response = await request(app).post('/workspace/local-control/enable');

    expect(response.status).toBe(200);
    expect(enable).toHaveBeenCalledOnce();
  });

  it('rejects enable when the Web Shell is unavailable', async () => {
    const app = express();
    const enable = vi.fn();
    registerWorkspaceLocalControlRoutes(app, {
      service: { enable } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({}),
      webShellAvailable: false,
    });

    const response = await request(app).post('/workspace/local-control/enable');

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('local_control_web_shell_unavailable');
    expect(enable).not.toHaveBeenCalled();
  });

  it('maps malformed Local Control targets to input errors', async () => {
    const app = express();
    registerWorkspaceLocalControlRoutes(app, {
      service: {
        enable: vi.fn(async () => {
          throw new InvalidLocalControlTargetError();
        }),
      } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({ target: 'http://%' }),
    });

    const response = await request(app).post('/workspace/local-control/enable');

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('invalid_local_control_target');
  });

  it.each(['stderr', 'daemon', 'broken-daemon'])(
    'logs unexpected enable failures with %s logging',
    async (logging) => {
      const app = express();
      const bindCause = Object.assign(
        new Error('listen EACCES: permission denied'),
        { code: 'EACCES' },
      );
      const failure = new LocalControlBindError(
        'bind_denied',
        'EACCES',
        'Local Control does not have permission to bind the selected address. Check system network permissions and try again.',
        bindCause,
      );
      const daemonLog = logging === 'stderr' ? undefined : { error: vi.fn() };
      if (logging === 'broken-daemon') {
        daemonLog!.error.mockImplementation(() => {
          throw new Error('Log sink closed');
        });
      }
      registerWorkspaceLocalControlRoutes(app, {
        service: {
          enable: vi.fn(async () => {
            throw failure;
          }),
        } as unknown as LocalControlService,
        daemonLog,
        mutate: () => (_req, _res, next) => next(),
        safeBody: () => ({}),
      });
      vi.mocked(writeStderrLineSafe).mockClear();

      const response = await request(app).post(
        '/workspace/local-control/enable',
      );

      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        error: failure.message,
        code: 'bind_denied',
      });
      const diagnostic = `Local Control enable failed (EACCES): ${failure.message}`;
      if (daemonLog) {
        expect(daemonLog.error).toHaveBeenCalledExactlyOnceWith(
          diagnostic,
          failure,
          {
            route: 'POST /workspace/local-control/enable',
            errno: 'EACCES',
          },
        );
      }
      if (logging === 'daemon') {
        expect(writeStderrLineSafe).not.toHaveBeenCalled();
      } else {
        expect(writeStderrLineSafe).toHaveBeenCalledWith(
          `qwen serve: ${diagnostic}`,
        );
      }
    },
  );

  it.each([
    {
      errno: 'EADDRINUSE',
      code: 'address_in_use',
      message:
        'The selected Local Control address is already in use. Release the conflicting listener and try again.',
    },
    {
      errno: 'EADDRNOTAVAIL',
      code: 'invalid_address',
      message:
        'The selected Local Control address is no longer available. Refresh the network selection and try again.',
    },
  ] as const)('maps $errno to the typed $code response', async (entry) => {
    const app = express();
    const failure = new LocalControlBindError(
      entry.code,
      entry.errno,
      entry.message,
      Object.assign(new Error(`listen ${entry.errno}`), {
        code: entry.errno,
      }),
    );
    registerWorkspaceLocalControlRoutes(app, {
      service: {
        enable: vi.fn(async () => {
          throw failure;
        }),
      } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({}),
    });

    const response = await request(app).post('/workspace/local-control/enable');

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: entry.message, code: entry.code });
  });

  it('keeps the generic code for non-bind enable failures', async () => {
    const app = express();
    registerWorkspaceLocalControlRoutes(app, {
      service: {
        enable: vi.fn(async () => {
          throw new Error('Unexpected setup failure');
        }),
      } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({}),
    });

    const response = await request(app).post('/workspace/local-control/enable');

    expect(response.status).toBe(500);
    expect(response.body.code).toBe('local_control_enable_failed');
  });

  it('keeps serving status when the pairing URL exceeds the QR capacity', async () => {
    // The pairing URL is caller-influenced (`target` deep-links) and can grow
    // past the QR encoder's limit. The QR block is best-effort: the request
    // must stay 200 with the raw URL intact instead of 500ing for as long as
    // Local Control is active (which would wedge the card with no way to
    // disable).
    const oversizedUrl = `http://192.168.1.10:4170/?t=${'a'.repeat(2000)}`;
    const app = express();
    app.use(asAuthenticated);
    registerWorkspaceLocalControlRoutes(app, {
      service: {
        status: vi.fn(() => ({ active: true, url: oversizedUrl })),
      } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({}),
    });

    const response = await request(app).get('/workspace/local-control');

    expect(response.status).toBe(200);
    expect(response.body.active).toBe(true);
    expect(response.body.url).toBe(oversizedUrl);
    expect(response.body.qrText).toBeUndefined();
  });

  it('renders the QR block for an in-capacity pairing URL', async () => {
    // Happy path must stay covered: the QR block is the primary phone-pairing
    // affordance, and a regression that silently stops assigning `qrText`
    // (encoder upgrade, refactor) should not ship with green tests.
    const url = 'http://192.168.1.10:4170/#token=abc123';
    const app = express();
    app.use(asAuthenticated);
    registerWorkspaceLocalControlRoutes(app, {
      service: {
        status: vi.fn(() => ({ active: true, url })),
      } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({}),
    });

    const response = await request(app).get('/workspace/local-control');

    expect(response.status).toBe(200);
    expect(typeof response.body.qrText).toBe('string');
    expect(response.body.qrText.length).toBeGreaterThan(0);
    expect(response.body.urlRedacted).toBeUndefined();
  });

  it('withholds the pairing secret when operator authority is omitted', async () => {
    // Isolated route mounts default trustedLoopbackMode to false. The pairing
    // token (in `url`'s fragment and encoded in `qrText`) must remain redacted
    // unless the mount explicitly supplies trusted authority or middleware
    // verifies a listener credential.
    const url = 'http://192.168.1.10:4170/#token=abc123';
    const app = express();
    registerWorkspaceLocalControlRoutes(app, {
      service: {
        status: vi.fn(() => ({ active: true, url })),
      } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({}),
    });

    const response = await request(app).get('/workspace/local-control');

    expect(response.status).toBe(200);
    expect(response.body.active).toBe(true);
    expect(response.body.url).toBeUndefined();
    expect(response.body.qrText).toBeUndefined();
    expect(response.body.urlRedacted).toBe(true);
  });

  it('returns the pairing secret to a trusted-loopback primary caller', async () => {
    const url = 'http://192.168.1.10:4170/#token=abc123';
    const app = express();
    registerWorkspaceLocalControlRoutes(app, {
      service: {
        status: vi.fn(() => ({ active: true, url })),
      } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({}),
      trustedLoopbackMode: true,
    });

    const response = await request(app).get('/workspace/local-control');

    expect(response.status).toBe(200);
    expect(response.body.url).toBe(url);
    expect(typeof response.body.qrText).toBe('string');
    expect(response.body.urlRedacted).toBeUndefined();
  });

  it('still returns the full pairing payload to authenticated callers (#9106)', async () => {
    const url = 'http://192.168.1.10:4170/#token=abc123';
    const app = express();
    app.use(asAuthenticated);
    registerWorkspaceLocalControlRoutes(app, {
      service: {
        status: vi.fn(() => ({ active: true, url })),
      } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({}),
    });

    const response = await request(app).get('/workspace/local-control');

    expect(response.status).toBe(200);
    expect(response.body.url).toBe(url);
    expect(response.body.urlRedacted).toBeUndefined();
  });

  it('redacts an unauthenticated enable response and prints the URL to the daemon terminal (#9106)', async () => {
    const url = 'http://192.168.1.10:4170/#token=abc123';
    const app = express();
    registerWorkspaceLocalControlRoutes(app, {
      service: {
        enable: vi.fn(async () => ({ active: true, url })),
      } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({}),
      primaryBindHostname: '127.0.0.1',
    });
    vi.mocked(writeStdoutLineSafe).mockClear();

    const response = await request(app).post('/workspace/local-control/enable');

    expect(response.status).toBe(200);
    expect(response.body.active).toBe(true);
    expect(response.body.url).toBeUndefined();
    expect(response.body.qrText).toBeUndefined();
    expect(response.body.urlRedacted).toBe(true);
    // The operator still needs the URL to pair; the daemon terminal is the one
    // channel a local attacker cannot read over HTTP.
    expect(writeStdoutLineSafe).toHaveBeenCalledWith(
      expect.stringContaining(url),
    );
  });

  it('returns a trusted-loopback enable secret without duplicate terminal output', async () => {
    const url = 'http://192.168.1.10:4170/#token=abc123';
    const app = express();
    registerWorkspaceLocalControlRoutes(app, {
      service: {
        enable: vi.fn(async () => ({ active: true, url })),
      } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({}),
      primaryBindHostname: '127.0.0.1',
      trustedLoopbackMode: true,
    });
    vi.mocked(writeStdoutLineSafe).mockClear();

    const response = await request(app).post('/workspace/local-control/enable');

    expect(response.status).toBe(200);
    expect(response.body.url).toBe(url);
    expect(typeof response.body.qrText).toBe('string');
    expect(writeStdoutLineSafe).not.toHaveBeenCalled();
  });

  it('rejects an HTTP-posted address that is neither a current candidate nor the operator grant (#14136)', async () => {
    // The explicit opt-in belongs to the CLI flag: a local process posting a
    // non-candidate address must not move the listener onto it and walk away
    // with the pairing credential.
    const app = express();
    const enable = vi.fn(async () => ({ active: true }));
    registerWorkspaceLocalControlRoutes(app, {
      service: {
        enable,
        status: vi.fn(() => ({ active: false })),
      } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({ address: '203.0.113.10' }),
    });

    const response = await request(app).post('/workspace/local-control/enable');

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('unknown_lan_interface');
    expect(response.body.interfaces).toEqual([]);
    expect(enable).not.toHaveBeenCalled();
  });

  it('answers a re-post of the currently served address instead of gating it', async () => {
    // The served address may have left the candidate list (DHCP reassigned
    // the adapter) while the listener stays bound. The service no-ops an
    // enable while active, so gating the re-post would 409 a client that
    // should get the live pairing material back.
    const app = express();
    const enable = vi.fn(async () => ({
      active: true,
      address: '192.168.1.10',
    }));
    registerWorkspaceLocalControlRoutes(app, {
      service: {
        status: vi.fn(() => ({ active: true, address: '192.168.1.10' })),
        enable,
      } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({ address: '192.168.1.10' }),
    });

    const response = await request(app).post('/workspace/local-control/enable');

    expect(response.status).toBe(200);
    expect(enable).toHaveBeenCalledOnce();
  });

  it('names --local-control-address when the posted address is held but never granted (#14136)', async () => {
    // The host HAS the address (a tunnel or a routable pick the automatic
    // filter excludes), so the absence wording would mislead; the remedy is
    // the CLI grant, and the card renders this message verbatim.
    vi.mocked(findExplicitCandidate).mockReturnValue({
      interfaceName: 'utun4',
      address: '10.8.0.2',
    });
    const app = express();
    const enable = vi.fn(async () => ({ active: true }));
    registerWorkspaceLocalControlRoutes(app, {
      service: {
        enable,
        status: vi.fn(() => ({ active: false })),
      } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({ address: '10.8.0.2' }),
    });

    const response = await request(app).post('/workspace/local-control/enable');

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('local_control_address_not_granted');
    expect(response.body.error).toContain('--local-control-address');
    expect(response.body.interfaces).toEqual([]);
    expect(enable).not.toHaveBeenCalled();
    // The gate's held/absent classification must consult the live interface
    // table — a substituted one would mis-classify the refusal.
    expect(findExplicitCandidate).toHaveBeenCalledWith(
      '10.8.0.2',
      networkInterfaces(),
    );
  });

  it('classifies a reserved address shape as never acceptable, not absent (#14136)', async () => {
    // Every host holds 127.0.0.1, yet no host can expose it; the refusal must
    // name the shape rule rather than claim the address is missing.
    const app = express();
    const enable = vi.fn(async () => ({ active: true }));
    registerWorkspaceLocalControlRoutes(app, {
      service: {
        enable,
        status: vi.fn(() => ({ active: false })),
      } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({ address: '127.0.0.1' }),
    });

    const response = await request(app).post('/workspace/local-control/enable');

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('reserved_lan_address');
    expect(response.body.error).toContain('reserved address shape');
    expect(enable).not.toHaveBeenCalled();
  });

  it('still refuses a different non-candidate address while a grant is recorded', async () => {
    // The grant admits exactly the granted address; its existence must not
    // relax the gate into a blanket admit for anything else.
    const app = express();
    const enable = vi.fn(async () => ({ active: true }));
    registerWorkspaceLocalControlRoutes(app, {
      service: {
        enable,
        status: vi.fn(() => ({ active: false })),
        grantedExplicitCandidate: {
          interfaceName: 'utun4',
          address: '10.8.0.2',
        },
      } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({ address: '203.0.113.99' }),
    });

    const response = await request(app).post('/workspace/local-control/enable');

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('unknown_lan_interface');
    expect(enable).not.toHaveBeenCalled();
  });

  it('passes a current automatic candidate through to enable', async () => {
    vi.mocked(listLanCandidates).mockReturnValue([
      { interfaceName: 'en0', address: '192.168.1.10' },
    ]);
    const app = express();
    const enable = vi.fn(async () => ({ active: true }));
    registerWorkspaceLocalControlRoutes(app, {
      service: {
        enable,
        status: vi.fn(() => ({ active: false })),
      } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({ address: '192.168.1.10' }),
    });

    const response = await request(app).post('/workspace/local-control/enable');

    expect(response.status).toBe(200);
    // Exact args: the HTTP route must never forward allowExplicitAddress —
    // minting the standing grant is the CLI flag path's alone.
    expect(enable).toHaveBeenCalledWith({
      address: '192.168.1.10',
      target: undefined,
    });
  });

  it('passes the operator-granted explicit address through to enable', async () => {
    // The Web Shell card re-posts the CLI-granted address after a disable;
    // the gate admits exactly that address and no other non-candidate.
    const app = express();
    const enable = vi.fn(async () => ({ active: true }));
    registerWorkspaceLocalControlRoutes(app, {
      service: {
        enable,
        status: vi.fn(() => ({ active: false })),
        grantedExplicitCandidate: {
          interfaceName: 'utun4',
          address: '10.8.0.2',
        },
      } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({ address: '10.8.0.2' }),
    });

    const response = await request(app).post('/workspace/local-control/enable');

    expect(response.status).toBe(200);
    expect(enable).toHaveBeenCalledWith({
      address: '10.8.0.2',
      target: undefined,
    });
  });

  it('surfaces the operator-granted explicit address only while the host still holds it', async () => {
    // The card renders explicitCandidate as a labelled row and re-posts it on
    // re-enable; once the host stops holding the address the field must
    // disappear so the card can drop the stale grant.
    const app = express();
    registerWorkspaceLocalControlRoutes(app, {
      service: {
        status: vi.fn(() => ({ active: false })),
        grantedExplicitCandidate: {
          interfaceName: 'utun4',
          address: '10.8.0.2',
        },
      } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({}),
    });
    vi.mocked(findExplicitCandidate).mockReturnValue({
      interfaceName: 'utun4',
      address: '10.8.0.2',
    });

    const held = await request(app).get('/workspace/local-control');
    expect(held.status).toBe(200);
    expect(held.body.explicitCandidate).toEqual({
      interfaceName: 'utun4',
      address: '10.8.0.2',
    });
    // The recorded grant is provenance, reported beside the liveness probe.
    expect(held.body.grantedAddress).toBe('10.8.0.2');
    // The grant is surfaced as its own field, never folded into the
    // automatic-candidate list the QR button resolves against.
    expect(held.body.interfaces).toEqual([]);
    // The held check must pass the live interface table: findExplicitCandidate
    // has no default for it, so dropping the argument throws inside the GET.
    expect(findExplicitCandidate).toHaveBeenCalledWith(
      '10.8.0.2',
      networkInterfaces(),
    );

    vi.mocked(findExplicitCandidate).mockClear();
    vi.mocked(findExplicitCandidate).mockReturnValue(undefined);
    const gone = await request(app).get('/workspace/local-control');
    expect(gone.status).toBe(200);
    expect(gone.body.explicitCandidate).toBeUndefined();
    // Provenance outlives the host's hold on the address: the card needs it
    // to keep offering the granted pick after a VPN/DHCP flap.
    expect(gone.body.grantedAddress).toBe('10.8.0.2');
    expect(findExplicitCandidate).toHaveBeenCalledWith(
      '10.8.0.2',
      networkInterfaces(),
    );
  });

  it('keeps the granted address out of the automatic-candidate list', async () => {
    vi.mocked(listLanCandidates).mockReturnValue([
      { interfaceName: 'en0', address: '192.168.1.10' },
    ]);
    vi.mocked(findExplicitCandidate).mockReturnValue({
      interfaceName: 'utun4',
      address: '10.8.0.2',
    });
    const app = express();
    registerWorkspaceLocalControlRoutes(app, {
      service: {
        status: vi.fn(() => ({ active: false })),
        grantedExplicitCandidate: {
          interfaceName: 'utun4',
          address: '10.8.0.2',
        },
      } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({}),
    });

    const response = await request(app).get('/workspace/local-control');

    expect(response.status).toBe(200);
    expect(response.body.interfaces).toEqual([
      { interfaceName: 'en0', address: '192.168.1.10' },
    ]);
    expect(response.body.explicitCandidate).toEqual({
      interfaceName: 'utun4',
      address: '10.8.0.2',
    });
  });
});
