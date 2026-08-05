'use strict';

const request = require('supertest');
const app = require('./app');

it('GET /ping returns 200', async () => {
  const before = Date.now();
  const res = await request(app).get('/ping');
  const after = Date.now();

  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toMatch(/application\/json/);
  expect(res.body.status).toBe('ok');
  expect(Object.keys(res.body).sort()).toEqual(['status', 'time']);
  expect(typeof res.body.time).toBe('string');
  expect(Number.isNaN(Date.parse(res.body.time))).toBe(false);
  expect(res.body.time).toBe(new Date(res.body.time).toISOString());
  expect(res.body.time.endsWith('Z')).toBe(true);

  const parsedTime = Date.parse(res.body.time);
  expect(parsedTime).toBeGreaterThanOrEqual(before - 1000);
  expect(parsedTime).toBeLessThanOrEqual(after + 1000);
});

it('unknown path returns 404 JSON', async () => {
  const res = await request(app).get('/nope');

  expect(res.status).toBe(404);
  expect(res.headers['content-type']).toMatch(/application\/json/);
  expect(res.body).toEqual({ error: 'not found' });
  expect(res.text.trim().startsWith('<')).toBe(false);
});

it('wrong method returns 404', async () => {
  // Citing FR-9: wrong method POST on /ping returns 404 error response as per product design.
  const res = await request(app).post('/ping');

  expect(res.status).toBe(404);
  expect(res.body).toEqual({ error: 'not found' });
});
