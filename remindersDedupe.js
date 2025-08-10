import Redis from 'ioredis';
const redis = new Redis(process.env.REDIS_URL);

export async function markAndCheck(key, ttlSec) {
  const ok = await redis.set(key, '1', 'EX', ttlSec, 'NX');
  return ok === 'OK'; // true = first time
}