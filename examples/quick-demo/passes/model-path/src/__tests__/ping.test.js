const request = require('supertest');
const app = require('../app');

describe('Ping Service', () => {
  it('GET /ping returns 200 with status ok and a parseable ISO timestamp', async () => {
    const res = await request(app).get('/ping');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(Object.keys(res.body).sort()).toEqual(['status', 'time']);
    expect(res.body.status).toBe('ok');
    expect(Number.isNaN(Date.parse(res.body.time))).toBe(false);
    expect(res.body.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('unknown path and wrong method return the 404 JSON body', async () => {
    // GET /nope
    const resGet = await request(app).get('/nope');
    expect(resGet.status).toBe(404);
    expect(resGet.headers['content-type']).toMatch(/application\/json/);
    expect(resGet.body).toEqual({ error: 'not found' });
    expect(resGet.text).not.toMatch(/<html/i);

    // POST /ping
    const resPost = await request(app).post('/ping');
    expect(resPost.status).toBe(404);
    expect(resPost.headers['content-type']).toMatch(/application\/json/);
    expect(resPost.body).toEqual({ error: 'not found' });
    expect(resPost.text).not.toMatch(/<html/i);
  });
});
