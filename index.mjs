/**
 * 插件导入器 —— 把被官方注释掉的「导入插件」能力以“插件”的形式加回来（带鉴权）。
 *
 * 为什么这是“任意版本通用”：
 *   NapCat 从 v4.12.0 起就提供插件 API：`ctx.router`（注册 API 路由 / WebUI 扩展页面）与
 *   `ctx.pluginManager`（安装、启用、加载插件），与「导入插件」按钮/接口是否被注释无关。
 *
 * 鉴权（本版新增，默认开启）：
 *   1) WebUI 登录凭证（默认允许）：页面与 WebUI 同源，直接读 localStorage.token 当 Bearer；
 *      插件把该凭证代理给 WebUI 自己的 `POST /api/auth/check` 校验 —— 用的还是 NapCat 原有鉴权，
 *      因此不需要知道签发密钥，也不会绕过 WebUI 的凭证吊销/一小时有效期逻辑。
 *   2) 访问口令：默认值 = WebUI 的 token（读 `config/webui.json`），可在插件配置里覆盖；
 *      校验方式与 NapCat 登录一致：sha256(候选 + ".napcat") 定时安全比较。
 *   3) 全部接口（含免鉴权挂载路径 /plugin/<id>/api/*）都要过这道闸；连续失败会被临时锁定。
 *   4) `allowPage` 关掉后干脆不注册扩展页面，只保留带凭证的 HTTP 接口。
 *
 * 依赖：只用 Node 内置模块（node:fs / node:path / node:zlib / node:crypto），零第三方依赖。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const PLUGIN_ID = 'napcat-plugin-importer';
const MAX_ZIP_BYTES = 200 * 1024 * 1024;   // 上传上限
const AUTH_LOCK_THRESHOLD = 10;            // 同一 IP 连续失败次数
const AUTH_LOCK_MS = 5 * 60 * 1000;        // 锁定时长
const AUTH_FAIL_WINDOW_MS = 5 * 60 * 1000; // 失败计数窗口
const WHITELIST_RE = /new Set\(\[\s*"napcat-plugin-[^"]*"(?:\s*,\s*"napcat-plugin-[^"]*")*\s*\]\)/;

let log = (...a) => console.log('[importer]', ...a);
const authState = new Map(); // ip -> { count, first, until }

const DEFAULT_CONFIG = {
  requireAuth: true,
  trustWebUiCredential: true,
  accessToken: '',
  allowPage: true,
  injectButton: true
};

// ============================================================================
// 一、配置（可在 WebUI 的插件配置弹窗里改，写 <config>/plugins/<id>/config.json）
// ============================================================================

export const plugin_config_schema = [
  { key: 'requireAuth', type: 'boolean', label: '启用鉴权', default: true,
    description: '关闭后任何人都能通过本插件安装插件，强烈不建议' },
  { key: 'trustWebUiCredential', type: 'boolean', label: '允许使用 WebUI 登录凭证', default: true,
    description: '允许导入页面直接复用你登录 WebUI 的凭证（免输入口令）' },
  { key: 'accessToken', type: 'string', label: '访问口令', default: '',
    description: '留空则使用 WebUI 的 token（config/webui.json 里的 token）' },
  { key: 'allowPage', type: 'boolean', label: '注册 WebUI 扩展页面', default: true,
    description: 'NapCat 的扩展页面本身是免鉴权下发的；关掉后只能用带凭证的 HTTP 接口' },
  { key: 'injectButton', type: 'boolean', label: '把「导入插件」按钮注入到插件管理页', default: true,
    description: '往 WebUI 的 static/index.html 注入一行脚本（原文件备份为 index.html.napcat-importer.bak），按钮位置/样式与官方原版一致' }
];

const cfgPath = (ctx) => ctx.configPath || path.join(ctx.dataPath || '.', 'config.json');

function loadConfig (ctx) {
  try {
    const raw = fs.readFileSync(cfgPath(ctx), 'utf8');
    const j = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...(j && typeof j === 'object' ? j : {}) };
  } catch { return { ...DEFAULT_CONFIG }; }
}

function saveConfig (ctx, cfg) {
  const p = cfgPath(ctx);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
}

export const plugin_get_config = async (ctx) => loadConfig(ctx);
export const plugin_set_config = async (ctx, cfg) => saveConfig(ctx, { ...DEFAULT_CONFIG, ...(cfg || {}) });

// ============================================================================
// 二、鉴权
// ============================================================================

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest();
/** 与 NapCat 登录一致的口令摘要 */
const pwHash = (token) => sha256(String(token) + '.napcat');
function safeEqualHex (a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch { return false; }
}

/** NapCat 根目录（plugins 的上一级） */
const napcatRoot = (ctx) => path.dirname(ctx.pluginManager.getPluginPath());

/** 读 WebUI 配置里的 token / host / port */
function readWebUiConfig (ctx) {
  try {
    const p = path.join(napcatRoot(ctx), 'config', 'webui.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { token: typeof j.token === 'string' ? j.token : '', host: j.host || '0.0.0.0', port: Number(j.port) || 6099 };
  } catch { return { token: '', host: '0.0.0.0', port: 6099 }; }
}

/** 当前生效的访问口令：插件配置优先，否则用 WebUI 的 token */
function effectiveToken (ctx) {
  const cfg = loadConfig(ctx);
  if (cfg.accessToken) return { token: String(cfg.accessToken), source: 'plugin-config' };
  const w = readWebUiConfig(ctx);
  return { token: w.token, source: 'webui.json' };
}

const bearerOf = (req) => {
  const h = req.headers && (req.headers.authorization || req.headers.Authorization);
  const m = /^Bearer\s+(.+)$/i.exec(String(h || ''));
  if (m) return m[1].trim();
  const q = req.query && (req.query.token || req.query.webui_token);
  return q ? String(Array.isArray(q) ? q[0] : q).trim() : '';
};

const clientIp = (req) => {
  const raw = req.raw || {};
  const fwd = req.headers && req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return (raw.socket && raw.socket.remoteAddress) || (raw.ip) || 'unknown';
};

/** 看起来像 WebUI 凭证？（base64(JSON{Data,Hmac})） */
function parseCredential (s) {
  try {
    const j = JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
    return j && j.Data && j.Hmac ? j : null;
  } catch { return null; }
}

/** 交给 WebUI 自己校验凭证（POST /api/auth/check） */
async function verifyViaWebUi (ctx, credential) {
  if (typeof fetch !== 'function') return false; // 老运行时没有 fetch，退回口令校验
  const w = readWebUiConfig(ctx);
  const host = /^(0\.0\.0\.0|::|\[::\])$/.test(String(w.host)) ? '127.0.0.1' : w.host;
  const url = `http://${host}:${w.port}/api/auth/check`;
  const signal = (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
    ? AbortSignal.timeout(3000) : undefined;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credential}` },
      signal
    });
    const j = await r.json().catch(() => null);
    return !!(r.ok && j && j.code === 0);
  } catch (e) {
    log('校验 WebUI 凭证失败（将回退到口令校验）：' + (e && e.message));
    return false;
  }
}

function locked (ip) {
  const s = authState.get(ip);
  if (!s) return 0;
  if (s.until && s.until > Date.now()) return s.until - Date.now();
  return 0;
}
function noteFailure (ip) {
  const now = Date.now();
  const s = authState.get(ip) || { count: 0, first: now, until: 0 };
  if (now - s.first > AUTH_FAIL_WINDOW_MS) { s.count = 0; s.first = now; }
  s.count += 1;
  if (s.count >= AUTH_LOCK_THRESHOLD) { s.until = now + AUTH_LOCK_MS; s.count = 0; s.first = now; }
  authState.set(ip, s);
}
function noteSuccess (ip) { authState.delete(ip); }

/**
 * 校验一个请求；返回 { ok, mode } 或 { ok:false, status, message }
 */
export async function authenticate (ctx, req) {
  const cfg = loadConfig(ctx);
  const ip = clientIp(req);
  const wait = locked(ip);
  if (wait > 0) {
    return { ok: false, status: 429, message: `尝试过于频繁，请 ${Math.ceil(wait / 1000)} 秒后再试` };
  }
  if (!cfg.requireAuth) return { ok: true, mode: 'disabled' };

  const bearer = bearerOf(req);
  if (!bearer) {
    noteFailure(ip);
    return { ok: false, status: 401, message: 'Unauthorized：需要 WebUI 登录凭证或访问口令' };
  }

  // 1) WebUI 登录凭证
  if (cfg.trustWebUiCredential && parseCredential(bearer)) {
    if (await verifyViaWebUi(ctx, bearer)) { noteSuccess(ip); return { ok: true, mode: 'webui-credential' }; }
    noteFailure(ip);
    return { ok: false, status: 401, message: 'Unauthorized：WebUI 凭证无效或已过期' };
  }

  // 2) 访问口令（默认 = WebUI token）
  const { token, source } = effectiveToken(ctx);
  if (!token) {
    return { ok: false, status: 401, message: '服务端未配置访问口令，请在插件配置里设置 accessToken' };
  }
  if (safeEqualHex(crypto.createHash('sha256').update(pwHash(bearer)).digest('hex'), crypto.createHash('sha256').update(pwHash(token)).digest('hex'))) {
    noteSuccess(ip);
    return { ok: true, mode: 'access-token:' + source };
  }
  noteFailure(ip);
  return { ok: false, status: 401, message: 'Unauthorized：口令不正确' };
}

// ============================================================================
// 三、极简 ZIP 读取（中央目录方式，支持 stored(0) 与 deflate(8)）
// ============================================================================

function decodeName (nameBuf, flag) {
  if (flag & 0x800) return nameBuf.toString('utf8');
  try { return new TextDecoder('gbk').decode(nameBuf); } catch { /* ignore */ }
  try { return new TextDecoder('utf-8', { fatal: false }).decode(nameBuf); } catch { /* ignore */ }
  return nameBuf.toString('latin1');
}

/** 解析 zip，返回 [{ name, data }]（目录项已过滤） */
export function readZip (buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('不是有效的 zip 文件');
  const EOCD = 0x06054b50;
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件（找不到中央目录结尾）');

  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) {
    throw new Error('暂不支持 zip64 压缩包，请用标准 zip 重新打包（zip -r x.zip 目录）');
  }

  const out = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const flag = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = decodeName(buf.subarray(p + 46, p + 46 + nameLen), flag);
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('zip 局部文件头损坏');
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`不支持的压缩方式 (method=${method})，请用标准 deflate/zip 打包`);

    out.push({ name, data });
  }
  return out;
}

function normalizeEntry (name) {
  const n = String(name).replace(/\\/g, '/');
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n)) throw new Error(`压缩包内含有绝对路径：${n}`);
  const parts = n.split('/').filter(s => s !== '' && s !== '.');
  if (parts.some(s => s === '..')) throw new Error(`压缩包内含有非法路径：${n}`);
  if (!parts.length) return null;
  if (parts[0] === '__MACOSX') return null;
  const base = parts[parts.length - 1];
  if (base === '.DS_Store' || base === 'Thumbs.db' || base === 'desktop.ini') return null;
  return parts.join('/');
}

/** 规划安装：剥掉多余的顶层目录、定位 package.json */
export function planInstall (entries, filename) {
  const all = new Map();
  for (const e of entries) {
    const rel = normalizeEntry(e.name);
    if (rel) all.set(rel, e.data);
  }
  if (!all.size) throw new Error('压缩包是空的');

  let prefix = '';
  if (!all.has('package.json')) {
    const tops = new Set([...all.keys()].map(k => k.split('/')[0]));
    if (tops.size === 1) {
      const t = [...tops][0];
      if ([...all.keys()].every(k => k.includes('/'))) prefix = t + '/';
    }
  }
  const files = new Map();
  for (const [k, v] of all) {
    if (prefix && !k.startsWith(prefix)) continue;
    files.set(prefix ? k.slice(prefix.length) : k, v);
  }
  const pkgBuf = files.get('package.json');
  if (!pkgBuf) throw new Error('插件包里找不到 package.json（不是合法插件包）');

  let pkg;
  try { pkg = JSON.parse(pkgBuf.toString('utf8')); } catch { throw new Error('package.json 不是合法 JSON'); }
  const id = String(pkg.name || '').trim() ||
    path.basename(String(filename || 'plugin.zip').replace(/\.zip$/i, '')).trim();
  if (!id) throw new Error('无法确定插件 ID（package.json 缺少 name）');
  if (!/^[A-Za-z0-9._@/-]+$/.test(id)) throw new Error(`插件 ID 含非法字符：${id}`);

  return { id, pkg, files, prefix };
}

// ============================================================================
// 四、白名单闸门（官方 v4.18.8+ 会拒绝非白名单插件）
// ============================================================================

function findShellFiles (root) {
  const hits = [];
  let names;
  try { names = fs.readdirSync(root); } catch { return hits; }
  for (const n of names) {
    if (!/\.(mjs|js|cjs)$/i.test(n)) continue;
    const full = path.join(root, n);
    try {
      const st = fs.statSync(full);
      if (!st.isFile() || st.size > 80 * 1024 * 1024) continue;
      const s = fs.readFileSync(full, 'utf8');
      if (s.includes('not in official plugin whitelist') || s.includes('getRejectReason')) hits.push({ file: full, content: s });
    } catch { /* ignore */ }
  }
  return hits;
}

/** 把插件 ID 注入官方白名单数组（磁盘，重启后仍有效） */
function patchWhitelistOnDisk (root, id) {
  let changed = false;
  for (const { file, content } of findShellFiles(root)) {
    if (!content.includes('not in official plugin whitelist')) continue;
    const m = content.match(WHITELIST_RE);
    if (!m || m[0].includes(`"${id}"`)) continue;
    const lit = m[0];
    const close = lit.lastIndexOf(']');
    const injected = lit.slice(0, close).replace(/\s*$/, '') + `,"${id}"` + lit.slice(close);
    fs.writeFileSync(file, content.slice(0, m.index) + injected + content.slice(m.index + lit.length), 'utf8');
    log(`白名单已注入 ${id} → ${path.basename(file)}（重启后仍有效）`);
    changed = true;
  }
  return changed;
}

/**
 * 在“当前进程”里放行官方白名单 —— 无需重启即可加载新插件。
 * loader 原型上的 isOfficialPlugin() 是白名单判定入口（esbuild 默认不压缩属性名，各版本都是 pluginManager.loader）。
 */
function relaxWhitelistInMemory (pluginManager) {
  try {
    const loader = pluginManager && (pluginManager.loader || pluginManager.pluginLoader);
    if (!loader) return false;
    const proto = Object.getPrototypeOf(loader);
    if (!proto || typeof proto.isOfficialPlugin !== 'function') return false;
    if (!proto.__napcatImporterRelaxed) {
      Object.defineProperty(proto, '__napcatImporterRelaxed', { value: true, enumerable: false, configurable: true });
      proto.isOfficialPlugin = function () { return true; };
      log('已在本进程内放行插件白名单（新插件可免重启加载）');
    }
    return true;
  } catch (e) { log('内存放行白名单失败：' + (e && e.message)); return false; }
}

// ============================================================================
// 四点五、把「导入插件」按钮注入 WebUI 的插件管理页
// ============================================================================

const WEBUI_MARK = '<!-- napcat-plugin-importer -->';

const webuiIndexPath = (ctx) => path.join(napcatRoot(ctx), 'static', 'index.html');
const webuiScriptPath = (ctx) => path.join(ctx.pluginPath, 'webui', 'inject.js');

/**
 * 内联脚本块：把插件自带的 webui/inject.js 直接写进 index.html。
 * 内联（而不是 <script src>）是为了不额外请求 /plugin/...——反代只放行 /webui 时也能用。
 */
function webuiSnippet (ctx) {
  let js;
  try { js = fs.readFileSync(webuiScriptPath(ctx), 'utf8'); }
  catch (e) { log('读不到 webui/inject.js：' + (e && e.message)); return ''; }
  js = js.replace(/<\/script/gi, '<\\/script'); // 防止提前闭合
  return `${WEBUI_MARK}\n<script>\n${js}\n</script>\n`;
}

/** 往 static/index.html 注入按钮脚本（幂等；首次会自动备份原文件） */
export function injectWebUiButton (ctx) {
  const p = webuiIndexPath(ctx);
  let html;
  try { html = fs.readFileSync(p, 'utf8'); } catch (e) {
    log(`注入按钮失败：读不到 ${p}（${e && e.message}）`);
    return false;
  }
  const snippet = webuiSnippet(ctx);
  if (!snippet) return false;

  const re = new RegExp(`${WEBUI_MARK}\\s*<script>[\\s\\S]*?</script>\\n?`, 'g');
  const hadMarker = html.includes(WEBUI_MARK);
  const out = hadMarker
    ? html.replace(re, snippet)
    : (html.includes('</body>') ? html.replace('</body>', snippet + '</body>') : html + '\n' + snippet);
  if (out === html) return true; // 已是最新，无需改动

  try {
    const bak = p + '.napcat-importer.bak';
    if (!fs.existsSync(bak)) fs.copyFileSync(p, bak);
    fs.writeFileSync(p, out, 'utf8');
    log(hadMarker
      ? `已更新 WebUI 里注入的「导入插件」脚本（${p}，浏览器需刷新一次）`
      : `已把「导入插件」按钮内联进 WebUI：${p}（原文件备份 ${path.basename(bak)}）`);
    return true;
  } catch (e) {
    log('注入按钮失败：' + (e && e.message));
    return false;
  }
}

/** 卸载插件时把注入的脚本摘掉（恢复原样） */
export function removeInjectedWebUiButton (ctx) {
  const p = webuiIndexPath(ctx);
  try {
    const html = fs.readFileSync(p, 'utf8');
    if (!html.includes(WEBUI_MARK)) return false;
    // 只删我们自己插入的那一段，保留原有缩进 → 还原后与原文逐字节一致
    const re = new RegExp(`${WEBUI_MARK}\\s*<script>[\\s\\S]*?</script>\\n?`, 'g');
    fs.writeFileSync(p, html.replace(re, ''), 'utf8');
    log('已移除 WebUI 里注入的「导入插件」按钮');
    return true;
  } catch { return false; }
}

// ============================================================================
// 五、安装流程
// ============================================================================

function rmrf (p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }

async function installFromZip (ctx, zipBuf, filename) {
  const entries = readZip(zipBuf);
  const { id, pkg, files } = planInstall(entries, filename);

  const pluginsDir = ctx.pluginManager.getPluginPath();
  fs.mkdirSync(pluginsDir, { recursive: true });
  const target = path.join(pluginsDir, id);

  if (fs.existsSync(target)) {
    const bak = path.join(pluginsDir, `.bak-${id}-${Date.now()}`);
    try { fs.renameSync(target, bak); } catch { rmrf(target); }
    try { await ctx.pluginManager.unregisterPlugin(id); } catch { /* ignore */ }
  }

  for (const [rel, data] of files) {
    const full = path.join(target, rel);
    if (!path.resolve(full).startsWith(path.resolve(target) + path.sep)) throw new Error(`非法路径：${rel}`);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
  }
  log(`已写入 ${files.size} 个文件 → ${target}`);

  const whitelistRelaxed = relaxWhitelistInMemory(ctx.pluginManager);
  let whitelistPatched = false;
  try { whitelistPatched = patchWhitelistOnDisk(path.dirname(pluginsDir), id); } catch (e) { log('白名单处理失败:', e.message); }

  let loaded = false, enabled = false, error = '';
  try { await ctx.pluginManager.setPluginStatus(id, true); enabled = true; } catch (e) { error = String(e && e.message ? e.message : e); }
  try { loaded = await ctx.pluginManager.loadPluginById(id); } catch (e) { error = String(e && e.message ? e.message : e); }

  const needRestart = !loaded && whitelistPatched;
  const message = loaded
    ? `插件 ${id} 已导入并加载成功`
    : (needRestart
        ? `插件 ${id} 已安装，但当前版本的官方白名单刚被改写，需要重启 NapCat 后才会加载`
        : `插件 ${id} 已安装并启用，但加载失败${error ? '：' + error : ''}（请检查插件结构或看日志）`);

  return {
    pluginId: id, name: pkg.plugin || pkg.name || id, version: pkg.version || '0.0.0',
    files: files.size, installPath: target, enabled, loaded,
    whitelistRelaxed, whitelistPatched, needRestart, message
  };
}

async function listPlugins (ctx) {
  let all = [];
  try { all = ctx.pluginManager.getAllPlugins() || []; } catch { /* ignore */ }
  return all.map(p => ({
    id: p.id,
    name: (p.packageJson && p.packageJson.plugin) || p.name || p.id,
    version: p.version || '',
    enable: !!p.enable,
    loaded: !!p.loaded,
    status: p.runtime && p.runtime.status ? p.runtime.status : (p.loaded ? 'loaded' : 'unloaded'),
    description: (p.packageJson && p.packageJson.description) || ''
  })).sort((a, b) => a.id.localeCompare(b.id));
}

/** 统一取 body：JSON{filename,base64} 或 原始 octet-stream */
async function readBody (req) {
  const ctype = String((req.headers && req.headers['content-type']) || '');
  if (ctype.includes('application/json')) {
    const body = req.body || {};
    const filename = String(body.filename || 'plugin.zip');
    const b64 = String(body.base64 || body.data || '').replace(/^data:[^,]*,/, '');
    if (!b64) throw new Error('请求体缺少 base64 字段');
    return { filename, buf: Buffer.from(b64, 'base64') };
  }
  const raw = req.raw;
  if (!raw || typeof raw[Symbol.asyncIterator] !== 'function') throw new Error('无法读取请求体，请用 application/octet-stream 或 application/json');
  const chunks = [];
  let size = 0;
  for await (const c of raw) {
    size += c.length;
    if (size > MAX_ZIP_BYTES) throw new Error('文件过大（上限 200MB）');
    chunks.push(c);
  }
  const filename = String((req.query && (req.query.filename || req.query.name)) || 'plugin.zip');
  return { filename, buf: Buffer.concat(chunks) };
}

const ok = (res, data) => res.json({ code: 0, data, message: 'ok' });
const fail = (res, msg, status) => {
  if (typeof res.status === 'function' && status) res.status(status);
  return res.json({ code: -1, message: String(msg) });
};

function makeHandlers (ctx) {
  /** 每个接口都先过鉴权闸门 */
  const guard = (handler) => async (req, res) => {
    const auth = await authenticate(ctx, req);
    if (!auth.ok) {
      log(`鉴权失败（${clientIp(req)}）：${auth.message}`);
      return fail(res, auth.message, auth.status || 401);
    }
    return handler(req, res, auth);
  };

  const importHandler = guard(async (req, res, auth) => {
    try {
      const { filename, buf } = await readBody(req);
      if (!buf.length) return fail(res, '上传内容为空', 400);
      log(`收到导入请求（${auth.mode}）：${filename}（${(buf.length / 1024).toFixed(1)} KB）`);
      const data = await installFromZip(ctx, buf, filename);
      log(data.message);
      return ok(res, data);
    } catch (e) {
      log('导入失败：', e && e.message);
      return fail(res, e && e.message ? e.message : e, 400);
    }
  });

  const listHandler = guard(async (_req, res, auth) => {
    try { return ok(res, { plugins: await listPlugins(ctx), auth: auth.mode }); }
    catch (e) { return fail(res, e && e.message ? e.message : e, 500); }
  });

  const uninstallHandler = guard(async (req, res) => {
    try {
      const body = req.body || {};
      const id = String(body.id || (req.query && req.query.id) || '');
      if (!id) return fail(res, '缺少 id', 400);
      if (id === PLUGIN_ID) return fail(res, '不能卸载导入器自己（请用 WebUI 插件页卸载）', 400);
      await ctx.pluginManager.uninstallPlugin(id, !!body.cleanData);
      return ok(res, { pluginId: id, message: `插件 ${id} 已卸载` });
    } catch (e) { return fail(res, e && e.message ? e.message : e, 500); }
  });

  /** 给页面用：只回报鉴权状态，不需要凭证？不 —— 同样需要凭证，仅回报成功信息 */
  const whoamiHandler = guard(async (_req, res, auth) => ok(res, { authenticated: true, mode: auth.mode }));

  return { importHandler, listHandler, uninstallHandler, whoamiHandler };
}

// ============================================================================
// 六、插件入口
// ============================================================================

export const plugin_init = async (ctx) => {
  if (ctx && ctx.logger) log = (...a) => ctx.logger.info(...a);
  const cfg = loadConfig(ctx);
  const { token, source } = effectiveToken(ctx);

  // 本插件启动即放行白名单：之后导入的插件都能免重启加载
  relaxWhitelistInMemory(ctx.pluginManager);

  const { importHandler, listHandler, uninstallHandler, whoamiHandler } = makeHandlers(ctx);

  // 需认证接口（NapCat 鉴权 + 本插件鉴权，双保险）
  ctx.router.post('/import', importHandler);
  ctx.router.get('/list', listHandler);
  ctx.router.post('/uninstall', uninstallHandler);
  ctx.router.get('/whoami', whoamiHandler);

  // 静态资源：/plugin/<id>/files/static/*  → 插件目录下 webui/（注入脚本用它）
  ctx.router.static('/static', 'webui');

  // 免鉴权挂载路径（/plugin/<id>/api/*）——由本插件自己的鉴权把关
  ctx.router.postNoAuth('/import', importHandler);
  ctx.router.getNoAuth('/list', listHandler);
  ctx.router.postNoAuth('/uninstall', uninstallHandler);
  ctx.router.getNoAuth('/whoami', whoamiHandler);

  // WebUI 扩展页面（NapCat 的扩展页面是免鉴权下发的，页面内所有操作都要凭证）
  if (cfg.allowPage) {
    ctx.router.page({
      path: 'import', title: '导入插件', icon: '📦',
      htmlFile: 'webui/import.html',
      description: '上传本地 zip 安装/启用插件（需鉴权）'
    });
  }

  // 把按钮注入 WebUI 主页面（「插件管理」页）
  if (cfg.injectButton) injectWebUiButton(ctx);

  log(`已注册：${cfg.allowPage ? '页面 /plugin/' + PLUGIN_ID + '/page/import ；' : ''}接口 /api/Plugin/ext/${PLUGIN_ID}/import`);
  log(`WebUI 按钮注入：${cfg.injectButton ? '开' : '关'}；静态资源 /plugin/${PLUGIN_ID}/files/static/`);
  log(`鉴权：requireAuth=${cfg.requireAuth} trustWebUiCredential=${cfg.trustWebUiCredential} 口令来源=${cfg.accessToken ? 'plugin-config' : source}${token ? '' : '（未取到口令！）'}`);
};

export const plugin_cleanup = async (ctx) => {
  if (ctx && loadConfig(ctx).injectButton !== false) removeInjectedWebUiButton(ctx);
};

export default { plugin_init, plugin_cleanup, plugin_config_schema, plugin_get_config, plugin_set_config };
