import { describe, expect, it } from 'vitest';
import { buildWebRouteUrl, parseWebRoute, routeForView } from './routes';

function route(input: string) {
  return parseWebRoute(new URL(input, 'http://localhost'));
}

describe('web routes', () => {
  it('parses chat and session routes', () => {
    expect(route('/')).toEqual({ view: 'chat' });
    expect(route('/session/abc-123')).toEqual({
      view: 'chat',
      sessionId: 'abc-123',
    });
    expect(route('/session/abc-123/')).toEqual({
      view: 'chat',
      sessionId: 'abc-123',
    });
  });

  it('falls back to chat for unknown or malformed routes', () => {
    expect(route('/unknown')).toEqual({ view: 'chat' });
    expect(route('/session/%E0%A4%A')).toEqual({ view: 'chat' });
  });

  it('parses primary workspace views', () => {
    expect(route('/sessions')).toEqual({ view: 'sessions' });
    expect(route('/files')).toEqual({ view: 'files', path: undefined });
    expect(route('/mcp')).toEqual({ view: 'mcp' });
    expect(route('/tools')).toEqual({ view: 'tools' });
    expect(route('/skills')).toEqual({ view: 'skills' });
    expect(route('/memory')).toEqual({ view: 'memory' });
    expect(route('/settings')).toEqual({ view: 'settings' });
  });

  it('parses files paths', () => {
    expect(route('/files?path=package.json')).toEqual({
      view: 'files',
      path: 'package.json',
    });
    expect(route('/files?path=packages%2Fweb%2Fsrc%2FApp.tsx')).toEqual({
      view: 'files',
      path: 'packages/web/src/App.tsx',
    });
  });

  it('builds URLs', () => {
    expect(buildWebRouteUrl({ view: 'chat' })).toBe('/');
    expect(buildWebRouteUrl({ view: 'chat', sessionId: 'abc-123' })).toBe(
      '/session/abc-123',
    );
    expect(buildWebRouteUrl({ view: 'sessions' })).toBe('/sessions');
    expect(buildWebRouteUrl({ view: 'files' })).toBe('/files');
    expect(buildWebRouteUrl({ view: 'files', path: '.' })).toBe('/files');
    expect(
      buildWebRouteUrl({ view: 'files', path: 'packages/web/src/App.tsx' }),
    ).toBe('/files?path=packages%2Fweb%2Fsrc%2FApp.tsx');
  });

  it('builds route for sidebar views', () => {
    expect(routeForView('chat', 'session-id')).toEqual({
      view: 'chat',
      sessionId: 'session-id',
    });
    expect(routeForView('tools')).toEqual({ view: 'tools' });
  });
});
