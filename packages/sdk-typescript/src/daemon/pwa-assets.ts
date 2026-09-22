/**
 * Public Web Shell PWA files mounted before bearer authentication.
 *
 * The daemon and standalone browser client both consume this table so their
 * route, content-type, and service-worker-scope contracts cannot drift apart.
 */
export const WEB_SHELL_PWA_ASSETS = [
  {
    route: '/manifest.webmanifest',
    contentType: 'application/manifest+json',
    serviceWorkerAllowed: false,
  },
  {
    route: '/sw.js',
    contentType: 'application/javascript',
    serviceWorkerAllowed: true,
  },
] as const;

export const WEB_SHELL_SERVICE_WORKER_ROUTE = WEB_SHELL_PWA_ASSETS.find(
  ({ serviceWorkerAllowed }) => serviceWorkerAllowed,
)!.route;
