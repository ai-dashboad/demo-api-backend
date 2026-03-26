import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import type { Pool } from 'pg';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
// Fixed salt is acceptable here: the security guarantee comes from the master key
// entropy, not from per-secret salts (which scrypt is not used for in this pattern).
const KDF_SALT = 'opendev-secrets-v1';

export interface StoredSecret {
  name: string;
  created_at: Date;
  updated_at: Date;
}

export class SecretsManager {
  private readonly encryptionKey: Buffer;

  constructor(
    private readonly pool: Pool,
    masterKey: string,
  ) {
    if (!masterKey || masterKey.length < 32) {
      throw new Error(
        'SECRETS_MASTER_KEY must be at least 32 characters. ' +
        'Generate one with: openssl rand -hex 32',
      );
    }
    // Derive a fixed-length AES key from the master key material.
    // scryptSync is intentionally slow to resist brute-force if the DB leaks.
    this.encryptionKey = scryptSync(masterKey, KDF_SALT, KEY_LENGTH);
  }

  private encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.encryptionKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    // Encoding: iv:authTag:ciphertext — all hex, colon-delimited.
    // Auth tag provides tamper detection; changing any byte fails decryption.
    return [
      iv.toString('hex'),
      authTag.toString('hex'),
      encrypted.toString('hex'),
    ].join(':');
  }

  private decrypt(encoded: string): string {
    const parts = encoded.split(':');
    if (parts.length !== 3) {
      throw new Error('Ciphertext format is invalid — expected iv:authTag:ciphertext');
    }
    const [ivHex, authTagHex, encryptedHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');

    const decipher = createDecipheriv(ALGORITHM, this.encryptionKey, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(encrypted).toString('utf8') + decipher.final('utf8');
  }

  async set(name: string, value: string): Promise<void> {
    const encrypted = this.encrypt(value);
    await this.pool.query(
      `INSERT INTO secrets (name, value_encrypted)
       VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE
         SET value_encrypted = EXCLUDED.value_encrypted,
             updated_at       = now()`,
      [name, encrypted],
    );
  }

  async get(name: string): Promise<string | null> {
    const result = await this.pool.query<{ value_encrypted: string }>(
      'SELECT value_encrypted FROM secrets WHERE name = $1',
      [name],
    );
    if (result.rows.length === 0) return null;
    return this.decrypt(result.rows[0].value_encrypted);
  }

  async delete(name: string): Promise<void> {
    await this.pool.query('DELETE FROM secrets WHERE name = $1', [name]);
  }

  async list(): Promise<StoredSecret[]> {
    const result = await this.pool.query<StoredSecret>(
      'SELECT name, created_at, updated_at FROM secrets ORDER BY name',
    );
    return result.rows;
  }
}
