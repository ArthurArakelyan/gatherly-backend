import type { RequestListener } from 'node:http';

const sendJson = (
  response: Parameters<RequestListener>[1],
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): void => {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
};

export const requestListener: RequestListener = (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    sendJson(response, 200, { status: 'ok' });
    return;
  }

  sendJson(response, 404, { error: 'Not Found' });
};
