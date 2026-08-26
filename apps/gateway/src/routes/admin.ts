import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import type { Database } from "../db/index.js";
import type { AuthService } from "../services/auth.js";
import type { AuditService } from "../services/audit.js";
import type { ProviderRegistry } from "../services/provider-registry.js";
import type { ModelRegistry } from "../services/model-registry.js";
import type { GatewayService } from "../services/gateway.js";
import type { RoutingEngine } from "../services/router.js";
import { signSession } from "../auth/session.js";
import { createAdapter } from "../adapters/index.js";
import { encryptSecret } from "../utils/crypto.js";
import { GatewayError } from "../core/errors.js";
export async function registerAdminRoutes(
  app: FastifyInstance,
  d: {
    config: AppConfig;
    db: Database;
    auth: AuthService;
    audit: AuditService;
    providers: ProviderRegistry;
    models: ModelRegistry;
    gateway: GatewayService;
    router: RoutingEngine;
  },
) {
  app.post("/api/admin/login", async (req: any, reply) => {
    const { email, password } = req.body ?? {};
    const user = await d.auth.login(String(email), String(password));
    const csrf = crypto.randomBytes(24).toString("base64url");
    const token = signSession(
      {
        sub: user.id,
        email: user.email,
        roles: user.roles,
        csrf,
        exp: Date.now() + 12 * 60 * 60 * 1000,
      },
      d.config.SESSION_SECRET,
    );
    reply.setCookie("gw_session", token, {
      httpOnly: true,
      sameSite: "strict",
      secure: d.config.SESSION_COOKIE_SECURE,
      path: "/",
    });
    return { user, csrf };
  });
  app.get(
    "/api/admin/me",
    { preHandler: (app as any).requireAdmin },
    async (req: any) => ({
      id: req.adminClaims.sub,
      email: req.adminClaims.email,
      roles: req.adminClaims.roles,
      csrf: req.adminClaims.csrf,
    }),
  );
  app.post(
    "/api/admin/logout",
    { preHandler: (app as any).requireAdmin },
    async (_req, reply) => {
      reply.clearCookie("gw_session", { path: "/" });
      return { ok: true };
    },
  );
  app.get(
    "/api/admin/dashboard",
    { preHandler: (app as any).requireAdmin },
    async () => {
      const r = await d.db.query<any>(
        `SELECT count(*)::int requests,COALESCE(sum(input_tokens+output_tokens),0)::bigint tokens,COALESCE(sum(estimated_cost_usd),0)::numeric spend FROM usage_records WHERE created_at>=now()-interval '30 days'`,
      );
      return r.rows[0];
    },
  );
  app.get(
    "/api/admin/providers",
    { preHandler: (app as any).requireAdmin },
    async () => {
      const r = await d.db.query<any>(
        "SELECT id,slug,kind,display_name,base_url,enabled,config,created_at,updated_at FROM providers ORDER BY slug",
      );
      return r.rows;
    },
  );
  app.post(
    "/api/admin/providers",
    { preHandler: (app as any).requireAdmin },
    async (req: any) => {
      const b = req.body ?? {};
      let encrypted = null;
      if (b.apiKey) {
        if (!d.config.MASTER_ENCRYPTION_KEY)
          throw new GatewayError({
            code: "master_key_required",
            message:
              "MASTER_ENCRYPTION_KEY is required to store provider credentials",
            type: "client",
            retryable: false,
            status: 400,
          });
        encrypted = encryptSecret(
          { apiKey: b.apiKey },
          d.config.MASTER_ENCRYPTION_KEY,
        );
      }
      const r = await d.db.query<any>(
        "INSERT INTO providers(slug,kind,display_name,base_url,enabled,encrypted_credentials,config) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,slug,kind,display_name,base_url,enabled",
        [
          b.slug,
          b.kind,
          b.displayName ?? b.slug,
          b.baseUrl,
          b.enabled !== false,
          encrypted,
          b.config ?? {},
        ],
      );
      d.providers.register(
        createAdapter({
          id: b.slug,
          kind: b.kind,
          baseUrl: b.baseUrl,
          apiKey: b.apiKey,
          headers: b.config?.headers,
        }),
      );
      await d.audit.log(
        req.adminClaims.sub,
        "provider.create",
        "provider",
        r.rows[0].id,
        "success",
        { slug: b.slug },
        req.ip,
      );
      return r.rows[0];
    },
  );
  app.post(
    "/api/admin/providers/:slug/test",
    { preHandler: (app as any).requireAdmin },
    async (req: any) =>
      d.providers.get(req.params.slug).health({
        signal: new AbortController().signal,
        requestId: crypto.randomUUID(),
      }),
  );
  app.post(
    "/api/admin/providers/:slug/discover",
    { preHandler: (app as any).requireAdmin },
    async (req: any) => {
      const slug = req.params.slug;
      const found = await d.providers.get(slug).discoverModels({
        signal: new AbortController().signal,
        requestId: crypto.randomUUID(),
      });
      const p = await d.db.query<any>(
        "SELECT id FROM providers WHERE slug=$1",
        [slug],
      );
      for (const m of found)
        await d.db.query(
          "INSERT INTO models(provider_id,upstream_id,display_name,capabilities) VALUES($1,$2,$3,$4) ON CONFLICT(provider_id,upstream_id) DO UPDATE SET display_name=EXCLUDED.display_name,capabilities=EXCLUDED.capabilities",
          [p.rows[0].id, m.id, m.displayName ?? m.id, m.capabilities],
        );
      const rows = await d.db.query<any>(
        "SELECT m.*,p.slug provider_slug FROM models m JOIN providers p ON p.id=m.provider_id WHERE p.enabled",
      );
      d.models.setMany(
        rows.rows.map((m: any) => ({
          provider: m.provider_slug,
          id: m.upstream_id,
          displayName: m.display_name,
          enabled: m.enabled,
          capabilities: m.capabilities,
          metadata: { alias: m.alias, routingPriority: m.routing_priority },
        })),
      );
      return found;
    },
  );
  app.get(
    "/api/admin/models",
    { preHandler: (app as any).requireAdmin },
    async () => {
      const r = await d.db.query<any>(
        "SELECT m.*,p.slug provider_slug FROM models m JOIN providers p ON p.id=m.provider_id ORDER BY p.slug,m.upstream_id",
      );
      return r.rows;
    },
  );
  app.patch(
    "/api/admin/models/:id",
    { preHandler: (app as any).requireAdmin },
    async (req: any) => {
      const b = req.body ?? {};
      const r = await d.db.query<any>(
        "UPDATE models SET enabled=COALESCE($2,enabled),alias=COALESCE($3,alias),routing_priority=COALESCE($4,routing_priority),capabilities=COALESCE($5,capabilities) WHERE id=$1 RETURNING *",
        [req.params.id, b.enabled, b.alias, b.routingPriority, b.capabilities],
      );
      return r.rows[0];
    },
  );
  app.get(
    "/api/admin/keys",
    { preHandler: (app as any).requireAdmin },
    async () => {
      const r = await d.db.query<any>(
        "SELECT id,user_id,name,key_prefix,scopes,allowed_providers,allowed_models,expires_at,revoked_at,created_at,last_used_at FROM client_api_keys ORDER BY created_at DESC",
      );
      return r.rows;
    },
  );
  app.post(
    "/api/admin/keys",
    { preHandler: (app as any).requireAdmin },
    async (req: any) => {
      const body = req.body ?? {};
      const k = await d.auth.createApiKey(body.name ?? "client", body.userId, {
        scopes: body.scopes,
        allowedProviders: body.allowedProviders,
        allowedModels: body.allowedModels,
        expiresAt: body.expiresAt,
      });
      await d.audit.log(
        req.adminClaims.sub,
        "api_key.create",
        "api_key",
        k.id,
        "success",
        { name: k.name },
        req.ip,
      );
      return k;
    },
  );
  app.delete(
    "/api/admin/keys/:id",
    { preHandler: (app as any).requireAdmin },
    async (req: any) => {
      await d.db.query(
        "UPDATE client_api_keys SET revoked_at=now() WHERE id=$1",
        [req.params.id],
      );
      return { ok: true };
    },
  );
  app.get(
    "/api/admin/usage",
    { preHandler: (app as any).requireAdmin },
    async (req: any) => {
      const r = await d.db.query<any>(
        "SELECT * FROM usage_records ORDER BY created_at DESC LIMIT $1",
        [Math.min(Number(req.query?.limit ?? 200), 1000)],
      );
      return r.rows;
    },
  );
  app.get(
    "/api/admin/routing",
    { preHandler: (app as any).requireAdmin },
    async () => {
      const [p, b, l] = await Promise.all([
        d.db.query("SELECT * FROM routing_policies ORDER BY priority"),
        d.db.query("SELECT * FROM budgets ORDER BY name"),
        d.db.query("SELECT * FROM rate_limit_policies ORDER BY name"),
      ]);
      return { policies: p.rows, budgets: b.rows, rateLimits: l.rows };
    },
  );
  app.post(
    "/api/admin/playground/chat",
    { preHandler: (app as any).requireAdmin },
    async (req: any) =>
      d.gateway.chat(req.body, { userId: req.adminClaims.sub }),
  );
}
