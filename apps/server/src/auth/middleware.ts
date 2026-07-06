import type { FastifyRequest, FastifyReply } from "fastify";
import type { AuthService } from "./service.js";
import { pluginManager } from "@myfinal/plugin-runtime";

/** 不需要认证的路由白名单（精确前缀匹配） */
const PUBLIC_PREFIXES = [
  "/auth/login",
  "/auth/check",
  "/health",
  "/status",
];

function isPublicPath(url: string, method: string): boolean {
  // 从完整 URL 或路径中提取纯路径部分（去掉 scheme/host/query）
  let path: string;
  try {
    // 如果是完整 URL（含 scheme），解析出 pathname
    path = url.startsWith("http") ? new URL(url).pathname : url;
  } catch {
    path = url;
  }
  // 去掉查询参数（兼容 ?token=xxx 的情况）
  path = path.split("?")[0];
  if (/^\/plugins\/[^/]+\/ui(?:\/|$)/.test(path)) return true;
  if (isPublicPluginApiPath(path, method)) return true;
  return PUBLIC_PREFIXES.some((p) => path.startsWith(p));
}

function isPublicPluginApiPath(path: string, method: string): boolean {
  const match = path.match(/^\/plugins\/([^/]+)\/api(?:\/(.*))?$/);
  if (!match) return false;

  let pluginName: string;
  try {
    pluginName = decodeURIComponent(match[1]);
  } catch {
    return false;
  }

  const plugin = pluginManager.plugins.find((p) => p.meta.name === pluginName);
  if (!plugin) return false;

  const subPath = `/${match[2] ?? ""}`.replace(/\/+$/, "") || "/";
  return plugin.routes.some((route) =>
    route.public === true &&
    route.method === method &&
    (route.path === subPath || route.path === `${subPath}/` || `${route.path}/` === subPath || matchPluginRoute(route.path, subPath))
  );
}

function matchPluginRoute(routePath: string, actualPath: string): boolean {
  const routeParts = routePath.split("/").filter(Boolean);
  const actualParts = actualPath.split("/").filter(Boolean);
  if (routeParts.length !== actualParts.length) return false;
  return routeParts.every((part, index) => part.startsWith(":") || part === actualParts[index]);
}

/**
 * 创建认证中间件（Fastify preHandler hook）
 * 未认证时返回 401
 */
export function createAuthMiddleware(authService: AuthService) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    // 白名单路由跳过认证
    if (isPublicPath(request.url, request.method)) return;

    // 未配置密码时跳过认证（首次部署未设置密码）
    if (!authService.isConfigured()) return;

    // 优先从 Authorization header 获取 token，其次从 query 参数获取（用于 SSE）
    let token: string | undefined;
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      token = authHeader.slice(7);
    } else {
      // SSE 连接通过 query 参数传递 token
      const query = request.query as Record<string, string | undefined>;
      token = query.token;
    }

    if (!token) {
      return reply.status(401).send({ error: "未登录" });
    }

    const payload = authService.verifyToken(token);
    if (!payload) {
      return reply.status(401).send({ error: "Token 无效或已过期" });
    }
  };
}
