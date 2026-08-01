import { createServer } from 'node:http';

import request from 'supertest';

import { requestListener } from '../../src/app.js';

describe('GET /health', () => {
  it('reports that the process is healthy', async () => {
    const response = await request(createServer(requestListener)).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});
