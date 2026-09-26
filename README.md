# NapCat 插件导入器（napcat-plugin-importer）

> 仓库：<https://cnb.cool/likefirefly/napcat-plugin-importer>

官方在 **v4.17.25** 的更新里把「导入插件」按钮和 `/api/Plugin/Import` 接口都注释掉了（commit `896e1c2` / `77bdcfd` / `740d211`）。
本项目用 **NapCat 自己的插件 API** 把这项能力加回来——不改 NapCat 源码、不重新编译：

- ✅ **「插件管理」页里的原生按钮**：位置、样式和官方原版一致（h1 标题右边、刷新按钮后面）
- ✅ **侧边栏「扩展页面 → 导入插件」**：拖拽上传 + 插件列表 + 一键卸载
- ✅ **带鉴权的 HTTP 接口**：可用 curl / 脚本调用
- ✅ **热加载**：装进来的插件立即生效，不需要重启 NapCat
- ✅ 零第三方依赖（只用 Node 内置模块），自带极简 unzip（支持 stored/deflate、GBK 文件名）

原理：插件运行时会注册自己的 API 与页面（`ctx.router` / `ctx.pluginManager`，v4.12.0 起就存在），
并把一段脚本**内联**写进 WebUI 的 `static/index.html`，在浏览器里把按钮插回「插件管理」页的 DOM。
内联（而不是外链 `<script src>`）是为了不额外请求 `/plugin/...` —— 反代只放行 `/webui` 与 `/api` 时也能用。

---

## 安装（git）

> 容器镜像里**没有 git**，所以 git 操作在**宿主机**做，再把目录拷进容器。

```bash
# 1) 宿主机克隆
git clone https://cnb.cool/likefirefly/napcat-plugin-importer.git /opt/napcat-plugins/napcat-plugin-importer

# 2) 拷进容器（目录名保持 napcat-plugin-importer）
docker cp /opt/napcat-plugins/napcat-plugin-importer napcat:/app/napcat/plugins/

# 3) 重启一次，让插件管理器扫描到它
docker restart napcat
```

4. 打开 WebUI → **插件管理** → 找到「插件导入器」→ 打开它的开关启用。
   启用后**刷新一下页面**，「插件管理」标题右边就会出现 **导入插件** 按钮（按钮由插件启动时自动注入）。

### 更新

```bash
cd /opt/napcat-plugins/napcat-plugin-importer && git pull
docker cp . napcat:/app/napcat/plugins/napcat-plugin-importer/
docker restart napcat
```

### 可选：用挂载卷（这样 `git pull` 后重启容器即可生效）

```bash
# ⚠️ 先用容器里现有的插件目录初始化宿主机目录，别让空目录盖掉镜像自带的插件
docker cp napcat:/app/napcat/plugins/. /opt/napcat-plugins/
# 之后启动容器时加： -v /opt/napcat-plugins:/app/napcat/plugins
```

---

## 用法

### ① 插件管理页的「导入插件」按钮

点一下 → 选择本地 `.zip` → 自动解压、启用、**热加载**，成功后页面自动刷新并在列表里看到新插件。

### ② 扩展页面

侧边栏 **扩展页面 → 导入插件**：拖拽上传、查看已装插件、一键卸载。

### ③ HTTP 接口

| 用途 | 路径 | 鉴权 |
|---|---|---|
| 导入插件 | `POST /plugin/napcat-plugin-importer/api/import` | 需要 |
| 导入插件 | `POST /api/Plugin/ext/napcat-plugin-importer/import` | 需要 |
| 插件列表 | `GET  /plugin/napcat-plugin-importer/api/list` | 需要 |
| 卸载插件 | `POST /plugin/napcat-plugin-importer/api/uninstall` | 需要 |
| 探活 | `GET  /plugin/napcat-plugin-importer/api/whoami` | 需要 |

请求体二选一：`application/octet-stream`（原始 zip）或 `application/json`（`{"filename":"x.zip","base64":"..."}`）。

```bash
# 访问口令 = WebUI 的 token（config/webui.json 里的 token）
TOKEN=$(docker exec napcat sed -n 's/.*"token": *"\([^"]*\)".*/\1/p' /app/napcat/config/webui.json)

# 导入
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/octet-stream' \
     --data-binary @my-plugin.zip \
     "http://127.0.0.1:6003/plugin/napcat-plugin-importer/api/import?filename=my-plugin.zip"

# 列表
curl -s -H "Authorization: Bearer $TOKEN" \
     http://127.0.0.1:6003/plugin/napcat-plugin-importer/api/list

# 无凭证应当被拒（401）
curl -s -o /dev/null -w '%{http_code}\n' \
     http://127.0.0.1:6003/plugin/napcat-plugin-importer/api/list
```

---

## 鉴权

默认开启，凭证两种任选其一，放在 `Authorization: Bearer <值>` 或 `?token=<值>`：

1. **WebUI 登录凭证**（默认允许，页面免输入）
   导入页面与 WebUI 同源，直接复用你登录 WebUI 的凭证；插件把它代理给 WebUI 自己的
   `POST /api/auth/check` 校验 —— 不接触签发密钥，也不绕过凭证吊销与有效期。
2. **访问口令**
   默认值 = WebUI 的 `token`；可以在插件配置里用 `accessToken` 单独设置。
   校验方式与 NapCat 登录一致：`sha256(口令 + ".napcat")`，定时安全比较。

防护：同一 IP 连续失败 10 次锁定 5 分钟；口令用 `crypto.timingSafeEqual` 比较；
未通过鉴权时导入页面不渲染任何数据。

### 插件配置

WebUI → 插件管理 → 插件导入器 → **配置**：

| 键 | 默认 | 说明 |
|---|---|---|
| `requireAuth` | `true` | 是否启用鉴权 |
| `trustWebUiCredential` | `true` | 是否允许复用 WebUI 登录凭证（关掉后必须手输口令） |
| `accessToken` | `""` | 自定义访问口令；留空用 WebUI 的 token |
| `allowPage` | `true` | 是否注册侧边栏扩展页面 |
| `injectButton` | `true` | 是否把「导入插件」按钮注入「插件管理」页 |

---

## 可选：解除官方限制（容器内执行）

> ⚠️ 下面两条都是修改容器里的 `/app/napcat/napcat.mjs`：**执行完必须重启 NapCat 才生效**
> （运行中的进程已经加载了旧代码）。重启方式二选一：
>
> - 宿主机执行：`docker restart napcat`
> - 或在 WebUI 里调接口（需凭证）：
>   ```bash
>   curl -s -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:6003/api/Process/Restart
>   ```
>
> NapCat 升级/更新会覆盖 `napcat.mjs`，届时需要重做；命令里已包含备份步骤。

### ① 无视官方插件白名单（仅官方 v4.18.8+ 存在白名单）

从 v4.18.8 起，NapCat 只允许加载白名单内的插件（`napcat-plugin-builtin` / `cleaner` / `ssqq` / `qce`），
其它插件会被拒绝加载（日志里能看到 `Rejected xxx: not in official plugin whitelist`）。
把这段校验换成 `return null;` 即可放行：

**容器内执行：**

```bash
# 1) 备份
cp /app/napcat/napcat.mjs /app/napcat/napcat.mjs.bak
# 2) 打补丁
perl -0pi -e 's/return this\.isOfficialPlugin\(e\) \? null : r \? `sensitive keyword "\$\{r\}"` : "not in official plugin whitelist";/return null;/g' /app/napcat/napcat.mjs
# 3) 验证（期望 0）
grep -c "not in official plugin whitelist" /app/napcat/napcat.mjs
# 4) 重启 NapCat 才生效 —— 容器内没有 docker，回宿主机执行：
#    docker restart napcat
```

**宿主机一条龙（含重启）：**

```bash
docker exec napcat cp /app/napcat/napcat.mjs /app/napcat/napcat.mjs.bak
docker exec napcat perl -0pi -e 's/return this\.isOfficialPlugin\(e\) \? null : r \? `sensitive keyword "\$\{r\}"` : "not in official plugin whitelist";/return null;/g' /app/napcat/napcat.mjs
docker restart napcat
```

> 实测：该命令在官方 v4.18.19 外壳上精确命中，把那一行替换为 `return null;`，替换后外壳 `node --check` 通过。
> 说明：本插件自己启动时会**在内存里放行白名单**（把 loader 上的 `isOfficialPlugin` 改恒真），
> 所以只装本插件其实不需要这一条；这条主要给「其它插件被白名单拦下」准备。

### ② 使用社区插件源（插件商店）

把官方商店索引换成社区维护的索引，插件商店里能刷到更多插件：

**容器内执行：**

```bash
sed -i 's/NapNeko\/napcat-plugin-index/HolyFoxTeam\/napcat-plugin-community-index/g' /app/napcat/napcat.mjs
# 同样需要重启 NapCat 才生效 —— 回宿主机执行： docker restart napcat
```

**宿主机一条龙（含重启）：**

```bash
docker exec napcat sed -i 's/NapNeko\/napcat-plugin-index/HolyFoxTeam\/napcat-plugin-community-index/g' /app/napcat/napcat.mjs
docker restart napcat
```

> 实测：官方 v4.18.19 外壳里命中原地址，替换为
> `https://raw.githubusercontent.com/HolyFoxTeam/napcat-plugin-community-index/main/plugins.v4.json`；改完重启，去「插件商店」刷新即可。

---

## 按钮不显示？排查顺序

1. **必须是"整页刷新"**：在 WebUI 里点侧边栏「插件管理」属于 SPA 内部跳转，**不会重新加载 index.html**，
   注入的脚本自然没跑。按 `Ctrl+Shift+R`（或 `F5`）整页刷新一次即可。
2. **看浏览器控制台**：整页刷新后应能看到
   `[importer-btn] 已加载（接口候选：…）` 与 `[importer-btn] 已注入「导入插件」按钮`。
   - 只看到"已加载"、没有"已注入" → 页面结构和你报告的一样，可把控制台内容发出来（v1.0.1 起这种情况会自动在右下角给悬浮按钮）
   - 两条都没有 → 脚本没跑，检查是不是用了旧缓存（强刷 / 清站点数据）或浏览器插件拦截
3. **反代**：WebUI 装在子路径（如 `/napcat/webui/...`）时，脚本会按候选顺序自动探测接口地址
   `/api/Plugin/ext/...` → `<前缀>/api/...` → `/plugin/.../api`；如果全都 404，说明反代没放行 `/api` 或 `/plugin`。
4. **确认插件真的启用了**：插件管理页能看到「插件导入器」且开关是打开的；
   没启用则 `plugin_init` 不会执行，也就不会注入。
5. **确认版本**：v1.0.1 起按钮脚本是内联进 index.html 的（`grep -c napcat-plugin-importer /app/napcat/static/index.html` 应为 2）。

手动回滚注入（万一需要）：

```bash
docker exec napcat sh -c 'mv /app/napcat/static/index.html.napcat-importer.bak /app/napcat/static/index.html'
```

## 目录结构

```
napcat-plugin-importer/
├── package.json          # 插件元信息（name 即插件 ID）
├── index.mjs             # 插件主体：鉴权 / 路由 / 页面 / zip 解压 / 白名单处理 / 按钮注入
└── webui/
    ├── import.html       # 侧边栏「扩展页面」用的导入界面
    └── inject.js         # 注入到 WebUI 主页面、把按钮放回「插件管理」页的脚本
```

## 本地测试（可选）

```bash
node test/plugin.test.mjs        # 79 项：路由 / 鉴权 / zip 解析 / 白名单处理 / 按钮注入 / 逐字节还原
npm i jsdom && node test/inject-dom.test.mjs   # 21 项：jsdom 模拟「插件管理」页里按钮的真实行为
```

## 兼容性

- NapCat **v4.12.0 及以上**（只要该版本支持插件）；已在 v4.18.19 实测
- 官方白名单限制（v4.18.8+）由插件自行处理，无需手工改外壳

## 许可

MIT
