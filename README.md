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

| 用途 | 路径 | 接受哪种凭证 |
|---|---|---|
| 导入插件 | `POST /plugin/napcat-plugin-importer/api/import` | 登录凭证 **或** webui.json 的 token |
| 插件列表 | `GET  /plugin/napcat-plugin-importer/api/list` | 同上 |
| 卸载插件 | `POST /plugin/napcat-plugin-importer/api/uninstall` | 同上 |
| 探活 | `GET  /plugin/napcat-plugin-importer/api/whoami` | 同上 |
| 导入插件 | `POST /api/Plugin/ext/napcat-plugin-importer/import` | **只认登录凭证**（NapCat 自己的鉴权中间件先拦一道） |

> 区别见下面「两种凭证」：走 `/api/...` 的路径由 NapCat 的中间件先校验，必须用登录凭证；
> 走 `/plugin/.../api/...` 的路径由本插件自己校验，所以 webui.json 里的 token 可以直接当访问口令用。

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

默认开启。先分清两样东西——它们**不是**同一个值：

| | 原始 token（口令） | 登录凭证 Credential |
|---|---|---|
| 在哪 | `config/webui.json` 的 `"token"`（明文，长期有效） | `POST /api/auth/login` 的返回；浏览器存在 `localStorage['token']` |
| 长相 | 一串随机字符串 | `base64(JSON{Data:{CreatedTime,HashEncoded},Hmac:…})` |
| 有效期 | 长期（改它需重启 NapCat，服务端启动时已缓存） | **1 小时**；登出/改密即失效 |
| 签名密钥 | — | `NAPCAT_WEBUI_JWT_SECRET_KEY` 环境变量，未设置则为进程内随机数 |
| 过 NapCat 自己的 `/api/*` | ❌ 不行（`{"code":-1,"message":"Unauthorized"}`） | ✅ 可以 |
| 过本插件的接口 | ✅ 可以（当访问口令） | ✅ 可以（代理给 `/api/auth/check` 校验） |

用 token 换一个登录凭证（**纯 shell，不需要 python / node / jq**；前端登录发的就是这个 hash）：

```bash
TOK=$(docker exec napcat sed -n 's/.*"token": *"\([^"]*\)".*/\1/p' /app/napcat/config/webui.json)
HASH=$(printf '%s' "${TOK}.napcat" | sha256sum | cut -d' ' -f1)        # sha256(token + ".napcat")
CRED=$(curl -s -X POST http://127.0.0.1:6003/api/auth/login \
       -H 'Content-Type: application/json' -d "{\"hash\":\"${HASH}\"}" \
       | sed -n 's/.*"Credential":"\([^"]*\)".*/\1/p')               # 用 sed 抠字段，无需 python
# 之后凡是 /api/* 都用它，例如「启用/禁用插件」＝ WebUI 那个开关调的就是这个接口：
curl -s -X POST http://127.0.0.1:6003/api/Plugin/SetStatus \
  -H "Authorization: Bearer $CRED" -H 'Content-Type: application/json' \
  -d '{"id":"napcat-plugin-xxx","enable":true}'
```

也可以直接用仓库里的脚本（同样纯 shell，失败会给出原因）：

```bash
CRED=$(./tools/napcat-cred.sh napcat)          # 默认容器 napcat、127.0.0.1:6003
./tools/napcat-cred.sh napcat3 6003            # 指定容器与端口
NAPCAT_WEBUI_TOKEN=你的token ./tools/napcat-cred.sh '' 6003   # 不经容器，直接用 token
```

> 备注：凭证 1 小时有效、登出/改密即失效；带 2FA 的 WebUI 本脚本不处理。
> 若只是调**本插件**的接口，不必换凭证——直接用 webui.json 里的 token 当访问口令即可（不会过期）。
> 浏览器里手动取：DevTools → Application → Local Storage → 键 `token`（值是 JSON 字符串，去掉引号就是凭证）；
> 或 DevTools → Network → 任一 `/api/...` 请求 → Request Headers 里的 `Authorization`。

> 注意：NapCat 的鉴权失败返回的是 **HTTP 200 + `{"code":-1,"message":"Unauthorized"}`**，
> 判断成功与否要看 body 里的 `code`，不能只看 HTTP 状态码（本插件则返回真正的 401）。
> 也支持用查询参数传：`?webui_token=<凭证>`（插件页面 iframe 就是这么用的）。
> 若开了 2FA，`login` 第一次会返回 `require2FA:true`，需要再带上 `totpCode`。

凭证两种任选其一，放在 `Authorization: Bearer <值>` 或 `?token=<值>`：

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

## 点侧边栏就能看到按钮吗？

能。只要**这一次页面加载**里带上了注入脚本，之后在侧边栏点「插件管理」就会**立即**出现按钮：

- v1.0.3 起额外挂了路由钩子（`history.pushState` / `replaceState` / `popstate` / `hashchange`），
  点导航栏切换路由后 **60ms 内**注入完成（此前靠 MutationObserver 的 250ms 防抖 + 1.5s 轮询兜底）
- 还叠了启动重试阶梯（300ms/800ms/1.5s/3s/6s）、DOM 变化监听、1.5s 定时兜底
- 万一某些改版改了页面结构（找不到 `<h1>插件管理</h1>` 锚点），在插件管理路由上会退化为右下角悬浮按钮

**唯一做不到的事**：给「已经打开、但加载的是注入之前的 index.html」的页面动态塞脚本——
这是浏览器机制（JS 必须随页面加载）。WebUI 自身也没有可借用的自动刷新通道：

- Service Worker 只 `register()`，没有 `updatefound` / `controllerchange` 自动 reload
- `request.ts` 里的 `window.location.reload()` 触发条件是「/api 返回 Unauthorized」，会顺带清掉登录态，不能用

所以遇到"页面开着但没按钮"时，不按 F5 也有三条路：

1. **中键 / Ctrl+点击侧边栏的「插件管理」→ 新标签页打开**：新标签是整页加载，天然带脚本
2. **点 WebUI 的「重启进程」**：重启后前端会自己 `location.reload()`（`waitForBackendReady`），全程不用手按刷新（代价：QQ 重连约 40 秒）
3. **把脚本写进你自己的模板**（下面是给"用面板脚本统一改 index.html"的场景）：
   ```html
   <!-- napcat-plugin-importer -->
   <script src="/plugin/napcat-plugin-importer/files/static/inject.js" defer></script>
   ```
   外链形式依赖 `/plugin/` 路径可达；想完全不依赖，就把插件 `webui/inject.js` 的内容内联进去。
   这样所有容器、任何一次页面加载都自带脚本，"第一次要刷新"的问题彻底消失。

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
5. **看容器日志有没有 `注入按钮失败`**：

   ```bash
   docker logs <容器名> 2>&1 | grep -i "注入按钮"
   ```
   如果是 `EACCES: permission denied, open '.../static/index.html'`，说明该文件属主不是运行 NapCat 的用户
   （常见于：面板/自定义脚本以 root 改写过 index.html）。**v1.0.2 起已改为"临时文件 + rename"，
   只依赖目录写权限，这种场景会自动成功**；旧版本可以一次性修属主：

   ```bash
   docker exec -u 0 <容器名> chown -R napcat:napcat /app/napcat/static
   docker restart <容器名>          # 或在插件管理页把导入器关掉再打开，让注入重试
   ```
6. **若页面被别的工具反复重写**（例如你有面板脚本/定时任务统一改 `index.html`）：
   v1.0.2 起默认开启守护注入，被覆盖后自动补回：

   | 触发方式 | 反应速度 |
   |---|---|
   | 容器内进程改写（含插件自身） | **事件驱动**，`fs.watch` 监听目录 + 300ms 防抖 → **实测约 0.3 秒** |
   | 宿主机 `docker cp` 回写进容器 | inotify **不保证**派发（`docker cp` 直接写 overlay 的 upperdir，绕过挂载），由轮询兜底 → **默认 5 秒** |
   | 周期 | 由配置 `injectWatchIntervalMs` 控制（默认 `5000`，设 `0` 则只依赖事件） |

   **要不要改你外部脚本？看它怎么判断：**

   - 若它是**幂等/标记判断**（例如宝塔脚本里那句 `✓ index.html 已是目标状态，跳过`），
     **不需要改**：插件注入的内容不参与它的标记计数，它会继续跳过，两边不会互相覆盖。
   - 只有当它**真的重建**时（换版本、改端口、`force=true`、标记计数不对）才会冲掉注入，
     此时守护会在上面那张表的时间内补回（容器内写入 ~0.3s；`docker cp` 写入 ≤`injectWatchIntervalMs`）。
   - 想要"零空窗"（连那 0.3–5 秒都不要）时，才需要把它模板里也加上同一段注入：

     ```html
     <!-- napcat-plugin-importer -->
     <script src="/plugin/napcat-plugin-importer/files/static/inject.js" defer></script>
     ```

     （加完可以 `injectWatch: false` 关掉守护。）

   顺带说明版本差异：守护注入是 **v1.0.2** 才引入的（当时是固定 60 秒轮询），
   **v1.0.4** 起改为"`fs.watch` 事件驱动 + 5 秒轮询兜底"；
   想用回 60 秒的节奏，把配置 `injectWatchIntervalMs` 设为 `60000` 即可，无需改代码。

## 目录结构

```
napcat-plugin-importer/
├── package.json          # 插件元信息（name 即插件 ID）
├── index.mjs             # 插件主体：鉴权 / 路由 / 页面 / zip 解压 / 白名单处理 / 按钮注入
├── tools/
│   └── napcat-cred.sh    # 纯 shell 换取 WebUI 登录凭证（Authorization 用）
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
