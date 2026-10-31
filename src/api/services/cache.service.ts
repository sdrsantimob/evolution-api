import { ICache } from '@api/abstract/abstract.cache';
import { Logger } from '@config/logger.config';
import { BufferJSON } from 'baileys';

export class CacheService {
  private readonly logger = new Logger('CacheService');

  constructor(private readonly cache: ICache) {
    if (cache) {
      this.logger.verbose(`cacheservice created using cache engine: ${cache.constructor?.name}`);
    } else {
      this.logger.verbose(`cacheservice disabled`);
    }
  }

  async get(key: string): Promise<any> {
    if (!this.cache) {
      return;
    }
    return this.cache.get(key);
  }

  public async hGet(key: string, field: string) {
    if (!this.cache) {
      return null;
    }
    try {
      const data = await this.cache.hGet(key, field);

      if (data) {
        return JSON.parse(data, BufferJSON.reviver);
      }

      return null;
    } catch (error) {
      this.logger.error(error);
      return null;
    }
  }

  async set(key: string, value: any, ttl?: number) {
    if (!this.cache) {
      return;
    }
    this.cache.set(key, value, ttl);
  }

  /**
   * Leitura que distingue "não existe" (null) de "o Redis falhou" (erro). Usada só para o crachá da
   * sessão do WhatsApp: tratar falha como "não existe" faz o conector criar um crachá novo (QR) e
   * depois gravá-lo por cima do verdadeiro.
   */
  public async hGetStrict(key: string, field: string) {
    if (!this.cache) throw new Error('cache indisponível');
    const strict = (this.cache as any).hGetStrict;
    if (typeof strict !== 'function') throw new Error('cache sem leitura estrita');
    const data = await strict.call(this.cache, key, field);
    return data ? JSON.parse(data, BufferJSON.reviver) : null;
  }

  public async hSet(key: string, field: string, value: any) {
    if (!this.cache) {
      return;
    }
    try {
      const json = JSON.stringify(value, BufferJSON.replacer);

      await this.cache.hSet(key, field, json);
    } catch (error) {
      this.logger.error(error);
    }
  }

  async has(key: string) {
    if (!this.cache) {
      return;
    }
    return this.cache.has(key);
  }

  async delete(key: string) {
    if (!this.cache) {
      return;
    }
    return this.cache.delete(key);
  }

  async hDelete(key: string, field: string) {
    if (!this.cache) {
      return false;
    }
    try {
      await this.cache.hDelete(key, field);
      return true;
    } catch (error) {
      this.logger.error(error);
      return false;
    }
  }

  async deleteAll(appendCriteria?: string) {
    if (!this.cache) {
      return;
    }
    return this.cache.deleteAll(appendCriteria);
  }

  async keys(appendCriteria?: string) {
    if (!this.cache) {
      return;
    }
    return this.cache.keys(appendCriteria);
  }
}
