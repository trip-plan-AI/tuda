import { Redis } from 'ioredis';
const redis = new Redis('redis://localhost:6379');
redis.del('geo:suggest:санкт-питер').then(() => process.exit(0));
