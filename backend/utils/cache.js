/**
 * ============================================
 * CACHE - Sistema de cache em memória para API
 * ============================================
 */

class Cache {
    constructor(options = {}) {
        this.defaultTTL = options.defaultTTL || 60000; // 1 minuto padrão
        this.maxSize = options.maxSize || 1000;
        this.store = new Map();
        this.stats = {
            hits: 0,
            misses: 0,
            evictions: 0
        };
    }

    /**
     * Gera chave única para cache
     * @param {string} prefix - Prefixo da chave
     * @param {Array} args - Argumentos para compor a chave
     * @returns {string}
     */
    generateKey(prefix, ...args) {
        const key = `${prefix}:${args.map(a => JSON.stringify(a)).join(':')}`;
        return key;
    }

    /**
     * Obtém valor do cache
     * @param {string} key - Chave do cache
     * @returns {any|null}
     */
    get(key) {
        const entry = this.store.get(key);
        if (!entry) {
            this.stats.misses++;
            return null;
        }

        // Verifica se expirou
        if (entry.expires && Date.now() > entry.expires) {
            this.store.delete(key);
            this.stats.evictions++;
            this.stats.misses++;
            return null;
        }

        this.stats.hits++;
        return entry.value;
    }

    /**
     * Define valor no cache
     * @param {string} key - Chave do cache
     * @param {any} value - Valor a armazenar
     * @param {number} ttl - Tempo de vida em ms
     */
    set(key, value, ttl = null) {
        // Limpa espaço se necessário
        if (this.store.size >= this.maxSize) {
            this._evictOldest();
        }

        const expires = ttl ? Date.now() + ttl : Date.now() + this.defaultTTL;
        this.store.set(key, {
            value,
            expires,
            createdAt: Date.now()
        });
    }

    /**
     * Remove valor do cache
     * @param {string} key - Chave do cache
     */
    delete(key) {
        this.store.delete(key);
    }

    /**
     * Limpa todo o cache ou por prefixo
     * @param {string} prefix - Prefixo opcional para filtrar
     */
    clear(prefix = null) {
        if (!prefix) {
            this.store.clear();
        } else {
            for (const key of this.store.keys()) {
                if (key.startsWith(prefix)) {
                    this.store.delete(key);
                }
            }
        }
    }

    /**
     * Remove entradas expiradas
     * @returns {number} - Quantidade de entradas removidas
     */
    cleanup() {
        let removed = 0;
        const now = Date.now();
        for (const [key, entry] of this.store.entries()) {
            if (entry.expires && now > entry.expires) {
                this.store.delete(key);
                removed++;
                this.stats.evictions++;
            }
        }
        return removed;
    }

    /**
     * Remove entrada mais antiga (LRU simplificado)
     */
    _evictOldest() {
        let oldestKey = null;
        let oldestTime = Infinity;

        for (const [key, entry] of this.store.entries()) {
            if (entry.createdAt < oldestTime) {
                oldestTime = entry.createdAt;
                oldestKey = key;
            }
        }

        if (oldestKey) {
            this.store.delete(oldestKey);
            this.stats.evictions++;
        }
    }

    /**
     * Obtém estatísticas do cache
     * @returns {Object}
     */
    getStats() {
        const total = this.stats.hits + this.stats.misses;
        const hitRate = total > 0 ? ((this.stats.hits / total) * 100).toFixed(2) : 0;
        return {
            size: this.store.size,
            maxSize: this.maxSize,
            hits: this.stats.hits,
            misses: this.stats.misses,
            evictions: this.stats.evictions,
            hitRate: `${hitRate}%`
        };
    }

    /**
     * Executa função com cache
     * @param {string} key - Chave do cache
     * @param {Function} fn - Função para executar (deve retornar Promise)
     * @param {number} ttl - Tempo de vida em ms
     * @returns {Promise<any>}
     */
    async getOrSet(key, fn, ttl = null) {
        const cached = this.get(key);
        if (cached !== null) {
            return cached;
        }

        const value = await fn();
        this.set(key, value, ttl);
        return value;
    }
}

// Instância global para a API Betano
const betanoCache = new Cache({
    defaultTTL: 30000, // 30 segundos
    maxSize: 500
});

// Limpeza periódica (a cada 5 minutos)
setInterval(() => {
    const removed = betanoCache.cleanup();
    if (removed > 0) {
        console.log(`🗑️ Cache: ${removed} entradas expiradas removidas`);
    }
}, 300000);

module.exports = {
    Cache,
    betanoCache
};
