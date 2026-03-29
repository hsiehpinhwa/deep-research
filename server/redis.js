// server/redis.js
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const JOB_TTL      = 60 * 60 * 24 * 7; // 7 days
const ACTIVE_INDEX = 'active_jobs';      // Redis Set tracking active job IDs
// Note: Upstash free tier does not support KEYS command — use Redis Set instead

export async function createJob(id, topic, email) {
  const now = new Date().toISOString();
  const job = { id, topic, email, status: 'queued', created_at: now, updated_at: now };
  await redis.hset(`job:${id}`, job);
  await redis.expire(`job:${id}`, JOB_TTL);
  await redis.sadd(ACTIVE_INDEX, id);
  return job;
}

export async function getJob(id) {
  return redis.hgetall(`job:${id}`);
}

export async function updateJobStatus(id, status, extra = {}) {
  await redis.hset(`job:${id}`, {
    status,
    updated_at: new Date().toISOString(),
    ...extra,
  });
  if (status === 'done' || status === 'error') {
    await redis.srem(ACTIVE_INDEX, id);
  }
}

export async function getActiveJobs() {
  const ids = await redis.smembers(ACTIVE_INDEX);
  if (!ids.length) return [];
  return Promise.all(ids.map(id => redis.hgetall(`job:${id}`)));
}