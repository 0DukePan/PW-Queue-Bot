'use strict';

/**
 * Micro serveur HTTP de supervision.
 *
 * Railway (et la plupart des plateformes) attend qu'un port soit ouvert pour
 * considérer le service comme « healthy » ; il permet aussi de vérifier la
 * taille de la file sans ouvrir Discord.
 */

const http = require('node:http');

/**
 * @param {{
 *   port: number,
 *   logger: import('./env').Logger,
 *   status: () => Record<string, unknown>,
 * }} options
 */
function startHealthServer({ port, logger, status }) {
  if (!port) return null;

  const server = http.createServer((request, response) => {
    const url = request.url ?? '/';

    if (request.method === 'GET' && (url === '/health' || url === '/' || url === '/healthz')) {
      const body = JSON.stringify({ ok: true, ...status() });
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(body);
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  });

  server.keepAliveTimeout = 5000;
  server.on('error', (error) => {
    logger.warn('Serveur de supervision indisponible', { error: error?.message ?? error });
  });

  server.listen(port, () => {
    logger.info('Serveur de supervision à l’écoute.', { port });
  });

  server.unref?.();
  return server;
}

module.exports = { startHealthServer };
