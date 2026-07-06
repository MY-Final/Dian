# 插件 API 认证变更

## 背景

插件 API 的访问地址是 `/plugins/:name/api/*`。旧行为会默认跳过主站认证，方便插件 UI iframe 直接调用接口，但这也意味着插件 API 一旦暴露发消息、查库、写库等能力，就会成为未授权入口。

现在的默认行为改为：插件 API 需要主站 token。只有插件显式声明 `public: true` 的路由，才允许未登录访问。

## 默认私有 API

不传第四个参数时，路由默认需要认证。

```typescript
onSetup(ctx: PluginSetupContext): void {
  ctx.route("GET", "/settings", async (req, reply) => {
    return reply.send({ ok: true });
  });
}
```

前端调用时需要携带主站登录后拿到的 token。

```typescript
await fetch("/plugins/my-plugin/api/settings", {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
```

## 显式公开 API

如果某个接口确实需要匿名访问，例如插件 UI 的公开配置、健康检查、静态展示数据，可以在 `ctx.route()` 第四个参数里声明 `public: true`。

```typescript
onSetup(ctx: PluginSetupContext): void {
  ctx.route(
    "GET",
    "/public-info",
    async (req, reply) => {
      return reply.send({ name: "my-plugin", status: "ok" });
    },
    { public: true },
  );
}
```

匿名用户可以访问：

```bash
curl http://localhost:3000/plugins/my-plugin/api/public-info
```

## 使用建议

- 默认不要声明 `public: true`。
- 公开接口不要执行发消息、改配置、写数据库、删除数据等敏感操作。
- 公开接口返回的数据应避免包含 token、密钥、用户隐私、服务器路径等信息。
- 插件 UI 如果需要访问私有 API，应通过主站登录态拿 token 后请求。

## 兼容性

已有 `ctx.route(method, path, handler)` 写法仍可用，但行为从“默认公开”变为“默认需要认证”。如果旧插件依赖匿名访问，需要显式改成 `ctx.route(method, path, handler, { public: true })`。
