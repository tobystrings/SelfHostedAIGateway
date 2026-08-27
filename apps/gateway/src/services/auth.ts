import type { Database } from "../db/index.js";
import {
  apiKeyHash,
  newApiKey,
  passwordHash,
  passwordVerify,
} from "../utils/crypto.js";
import { GatewayError } from "../core/errors.js";

export class AuthService {
  constructor(private db: Database) {}

  async bootstrapAdmin(email: string, password: string) {
    const count = await this.db.query<{ n: string }>(
      "SELECT count(*)::text n FROM users",
    );
    if (Number(count.rows[0]?.n) > 0) return;

    const user = await this.db.query<{ id: string }>(
      "INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id",
      [email, passwordHash(password)],
    );
    await this.db.query(
      "INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE name='admin'",
      [user.rows[0]!.id],
    );
  }

  async login(email: string, password: string) {
    const result = await this.db.query<any>(
      "SELECT * FROM users WHERE email=$1 AND enabled",
      [email],
    );
    const user = result.rows[0];
    if (!user || !passwordVerify(password, user.password_hash)) {
      throw new GatewayError({
        code: "invalid_login",
        message: "Invalid credentials",
        type: "auth",
        retryable: false,
        status: 401,
      });
    }

    const roles = await this.db.query<{ name: string }>(
      "SELECT r.name FROM roles r JOIN user_roles ur ON ur.role_id=r.id WHERE ur.user_id=$1",
      [user.id],
    );
    await this.db.query("UPDATE users SET last_login_at=now() WHERE id=$1", [
      user.id,
    ]);
    return {
      id: user.id,
      email: user.email,
      roles: roles.rows.map((row) => row.name),
    };
  }

  async createApiKey(
    name: string,
    userId?: string,
    restrictions: {
      scopes?: string[];
      allowedProviders?: string[];
      allowedModels?: string[];
      expiresAt?: string;
    } = {},
  ) {
    const key = newApiKey();
    const hash = apiKeyHash(key);
    const scopes = restrictions.scopes?.length
      ? restrictions.scopes
      : ["gateway:invoke"];
    const result = await this.db.query<any>(
      `INSERT INTO client_api_keys(
        user_id,name,key_prefix,key_hash,scopes,allowed_providers,allowed_models,expires_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id,name,scopes,allowed_providers,allowed_models,expires_at,created_at`,
      [
        userId ?? null,
        name,
        key.slice(0, 10),
        hash,
        scopes,
        restrictions.allowedProviders ?? [],
        restrictions.allowedModels ?? [],
        restrictions.expiresAt ?? null,
      ],
    );
    return { ...result.rows[0], key };
  }

  async authenticateApiKey(key: string, ip?: string) {
    const result = await this.db.query<any>(
      "SELECT * FROM client_api_keys WHERE key_hash=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())",
      [apiKeyHash(key)],
    );
    const storedKey = result.rows[0];
    if (!storedKey) {
      throw new GatewayError({
        code: "invalid_api_key",
        message: "Invalid or expired API key",
        type: "auth",
        retryable: false,
        status: 401,
      });
    }

    await this.db.query(
      "UPDATE client_api_keys SET last_used_at=now(),last_used_ip=$2 WHERE id=$1",
      [storedKey.id, ip ?? null],
    );
    return {
      userId: storedKey.user_id,
      apiKeyId: storedKey.id,
      scopes: storedKey.scopes,
      allowedProviders: storedKey.allowed_providers,
      allowedModels: storedKey.allowed_models,
    };
  }
}
