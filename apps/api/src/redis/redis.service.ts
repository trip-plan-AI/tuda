import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;
  private available = false;

  onModuleInit() {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    this.client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      enableOfflineQueue: false,
    });

    this.client.on('connect', () => {
      this.available = true;
      this.logger.log('Redis connected');
    });

    this.client.on('error', () => {
      this.available = false;
    });

    this.client.connect().catch(() => {
      this.logger.warn('Redis unavailable — caching disabled');
    });
  }

  onModuleDestroy() {
    this.client?.disconnect();
  }

  get isAvailable() {
    return this.available;
  }

  async get(key: string): Promise<string | null> {
    if (!this.available) return null;
    try {
      return await this.client!.get(key);
    } catch {
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (!this.available) return;
    try {
      await this.client!.setex(key, ttlSeconds, value);
    } catch {
      // ignore
    }
  }

  async del(key: string): Promise<void> {
    if (!this.available) return;
    try {
      await this.client!.del(key);
    } catch {
      // ignore
    }
  }
}
