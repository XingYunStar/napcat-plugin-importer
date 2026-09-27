/**
 * 导入器插件的离线测试：不需要 QQ / 不需要真容器。
 * 用一个 mock ctx 调用 plugin_init，拿到注册的路由，再用 mock req/res 走完整安装流程。
 * 运行：node test-importer.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-test-'));
const PLUGINS = path.join(ROOT, 'plugins');
fs.mkdirSync(PLUGINS, { recursive: true });

let pass = 0, fail = 0;
const tick = (ms) => new Promise(r => setTimeout(r, ms));
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅', name, extra); } else { fail++; console.log('  ❌', name, extra); }
};

// ---------------------------------------------------------------------------
// 造测试用 zip
// ---------------------------------------------------------------------------
const mkdir = (p) => fs.mkdirSync(p, { recursive: true });
const write = (p, s) => { mkdir(path.dirname(p)); fs.writeFileSync(p, s); };

const pkg = (name, extra = {}) => JSON.stringify({
  name, plugin: '测试插件', version: '1.2.3', type: 'module', main: 'index.mjs',
  description: 'test', author: 't', ...extra
}, null, 2);

function zipDir (srcDir, outZip, args = []) {
  fs.rmSync(outZip, { force: true });
  execFileSync('zip', ['-qr', ...args, outZip, '.'], { cwd: srcDir });
  return fs.readFileSync(outZip);
}

// A. 单层目录包裹（GitHub 仓库 zip 的常见形态）+ deflate
const srcA = path.join(ROOT, 'srcA');
write(path.join(srcA, 'my-plugin', 'package.json'), pkg('napcat-plugin-alpha'));
write(path.join(srcA, 'my-plugin', 'index.mjs'), 'export const plugin_init=async()=>{};');
write(path.join(srcA, 'my-plugin', 'lib', 'util.mjs'), 'export const a=1;');
const zipA = zipDir(srcA, path.join(ROOT, 'a.zip'));

// B. 根目录直接是插件（+ stored 不压缩）
const srcB = path.join(ROOT, 'srcB');
write(path.join(srcB, 'package.json'), pkg('napcat-plugin-beta'));
write(path.join(srcB, 'index.mjs'), 'export const plugin_init=async()=>{};');
const zipB = zipDir(srcB, path.join(ROOT, 'b.zip'), ['-0']);

// C. 路径穿越
const zipC = (() => {
  const bad = path.join(ROOT, 'bad');
  write(path.join(bad, 'package.json'), pkg('napcat-plugin-evil'));
  write(path.join(bad, 'index.mjs'), 'x');
  const z = path.join(ROOT, 'c.zip');
  execFileSync('zip', ['-qr', z, '.'], { cwd: bad });
  // 用 python 往 zip 里塞一个 ../evil.txt 条目
  execFileSync('python3', ['-c', `
import zipfile
z = zipfile.ZipFile(${JSON.stringify(z)}, 'a')
z.writestr('../evil.txt', 'pwn')
z.close()
`]);
  return fs.readFileSync(z);
})();

// D. 没有 package.json
const srcD = path.join(ROOT, 'srcD');
write(path.join(srcD, 'readme.txt'), 'nothing');
const zipD = zipDir(srcD, path.join(ROOT, 'd.zip'));

// E. 假 zip64（EOCD 里条目数写 0xffff）
const zipE = (() => {
  const b = Buffer.from(zipB);
  const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  b.writeUInt16LE(0xffff, eocd + 10);
  return b;
})();

// ---------------------------------------------------------------------------
// mock ctx
// ---------------------------------------------------------------------------
const statusFile = path.join(ROOT, 'plugins.json');
const state = { status: {}, loaded: new Set(), unregistered: [] };

class FakeLoader {
  isOfficialPlugin (id) { return id === 'napcat-plugin-builtin'; }
  getRejectReason (id, _dir) {
    if (this.isOfficialPlugin(id)) return null;
    return 'not in official plugin whitelist';
  }
}
const fakeLoader = new FakeLoader();

const pluginManager = {
  loader: fakeLoader,
  getPluginPath: () => PLUGINS,
  getPluginConfig: () => state.status,
  getAllPlugins: () => Object.keys(state.status).map(id => {
    let pj = {};
    try { pj = JSON.parse(fs.readFileSync(path.join(PLUGINS, id, 'package.json'), 'utf8')); } catch { /* ignore */ }
    return { id, name: pj.name, version: pj.version, packageJson: pj, enable: !!state.status[id], loaded: state.loaded.has(id), runtime: { status: state.loaded.has(id) ? 'loaded' : 'unloaded' } };
  }),
  setPluginStatus: async (id, enable) => { state.status[id] = enable; fs.writeFileSync(statusFile, JSON.stringify(state.status, null, 2)); },
  loadPluginById: async (id) => {
    const dir = path.join(PLUGINS, id);
    if (!fs.existsSync(path.join(dir, 'package.json'))) return false;
    // 模拟真实 loader：白名单拒绝的插件不会被加载
    if (fakeLoader.getRejectReason(id, dir)) return false;
    state.loaded.add(id);
    return true;
  },
  unregisterPlugin: async (id) => { state.unregistered.push(id); state.loaded.delete(id); },
  uninstallPlugin: async (id) => { fs.rmSync(path.join(PLUGINS, id), { recursive: true, force: true }); delete state.status[id]; state.loaded.delete(id); },
  reloadPlugin: async () => true,
  getPluginDataPath: (id) => path.join(ROOT, 'data', id),
  getPluginConfigPath: (id) => path.join(ROOT, 'data', id, 'config.json')
};

const captured = { api: [], noauth: [], pages: [], static: [] };
const router = {
  api: (m, p, h) => captured.api.push({ m, p, h }),
  get: (p, h) => captured.api.push({ m: 'get', p, h }),
  post: (p, h) => captured.api.push({ m: 'post', p, h }),
  put: () => {}, delete: () => {}, patch: () => {}, all: () => {},
  apiNoAuth: (m, p, h) => captured.noauth.push({ m, p, h }),
  getNoAuth: (p, h) => captured.noauth.push({ m: 'get', p, h }),
  postNoAuth: (p, h) => captured.noauth.push({ m: 'post', p, h }),
  putNoAuth: () => {}, deleteNoAuth: () => {},
  page: (d) => captured.pages.push(d),
  pages: (ds) => captured.pages.push(...ds),
  static: (urlPath, localPath) => captured.static.push({ urlPath, localPath }), staticOnMem: () => {}
};

const ctx = {
  pluginName: 'napcat-plugin-importer',
  pluginPath: path.join(import.meta.dirname, '..'),
  configPath: path.join(ROOT, 'data', 'importer', 'config.json'),
  dataPath: path.join(ROOT, 'data', 'importer'),
  pluginManager, router,
  logger: { log: () => {}, info: () => {}, debug: () => {}, warn: () => {}, error: () => {} }
};

// 模拟官方 v4.18.8+ 的外壳 bundle（带白名单），用来验证白名单注入
const SHELL = path.join(ROOT, 'napcat.mjs');
fs.writeFileSync(SHELL, 'const x=1;\nconst wl = /* @__PURE__ */ new Set([\n  "napcat-plugin-builtin",\n  "napcat-plugin-cleaner",\n  "napcat-plugin-ssqq",\n  "napcat-plugin-qce"\n]);\nfunction getRejectReason(a,b){const r=1;return this.isOfficialPlugin(a)?null:r?`sensitive keyword`:"not in official plugin whitelist";}\n');

// ---------------------------------------------------------------------------
// 鉴权准备：伪造 config/webui.json（WebUI token 与端口）+ fetch stub（代理校验）
// ---------------------------------------------------------------------------
fs.mkdirSync(path.join(ROOT, 'config'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'config', 'webui.json'), JSON.stringify({ host: '0.0.0.0', port: 6099, token: 'testwebtoken' }));

const AUTH_HDR = { authorization: 'Bearer testwebtoken' };
const CRED = Buffer.from(JSON.stringify({ Data: { CreatedTime: 1790000000, HashEncoded: 'x' }, Hmac: 'y' })).toString('base64');
let fetchStub = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opt) => (fetchStub ? fetchStub(url, opt) : realFetch(url, opt));

// ---------------------------------------------------------------------------
// 载入插件模块
// ---------------------------------------------------------------------------
const mod = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'index.mjs')).href);
const { readZip, planInstall } = mod;

console.log('\n【1】 ZIP 解析与规划');
check('deflate zip 能解析', readZip(zipA).length >= 3, `条目数=${readZip(zipA).length}`);
check('stored zip 能解析', readZip(zipB).length >= 2, `条目数=${readZip(zipB).length}`);
check('剥掉顶层目录后能定位 package.json', planInstall(readZip(zipA), 'a.zip').id === 'napcat-plugin-alpha');
check('根目录形态能定位 package.json', planInstall(readZip(zipB), 'b.zip').id === 'napcat-plugin-beta');
check('路径穿越包被拒绝', (() => { try { planInstall(readZip(zipC), 'c.zip'); return false; } catch { return true; } })());
check('没有 package.json 被拒绝', (() => { try { planInstall(readZip(zipD), 'd.zip'); return false; } catch { return true; } })());
check('假 zip64 被识别并报错', (() => { try { readZip(zipE); return false; } catch (e) { return /zip64/.test(e.message); } })());

check('未放行前，非官方插件会被白名单拒绝（闸门对手）', fakeLoader.getRejectReason('napcat-plugin-alpha', 'x') !== null);

console.log('\n【2】 路由注册');
await mod.plugin_init(ctx);
check('注册了需认证 POST /import', captured.api.some(r => r.p === '/import' && r.m === 'post'));
check('注册了需认证 GET /list', captured.api.some(r => r.p === '/list' && r.m === 'get'));
check('注册了免认证 POST /import', captured.noauth.some(r => r.p === '/import' && r.m === 'post'));
check('注册了扩展页面 import', captured.pages.some(p => p.path === 'import' && /import\.html$/.test(p.htmlFile)));
check('插件启动后，本进程内白名单已放行（新插件免重启）', fakeLoader.getRejectReason('napcat-plugin-alpha', 'x') === null);

check('页面 HTML 文件真实存在', fs.existsSync(path.join(ctx.pluginPath, 'webui', 'import.html')));

// ---------------------------------------------------------------------------
// mock req/res
// ---------------------------------------------------------------------------
const mkRes = () => {
  const r = { _json: null, statusCode: 200 };
  r.json = (j) => { r._json = j; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.send = () => r; r.setHeader = () => r;
  return r;
};
const importRoute = captured.api.find(r => r.p === '/import' && r.m === 'post');
const listRoute = captured.api.find(r => r.p === '/list');
const uninstallRoute = captured.api.find(r => r.p === '/uninstall');

const postJson = async (obj) => {
  const res = mkRes();
  await importRoute.h({ headers: { 'content-type': 'application/json', ...AUTH_HDR }, body: obj, query: {}, raw: null }, res);
  return res._json;
};

console.log('\n【3】 安装流程（JSON + base64，模拟前端页面）');
let r1 = await postJson({ filename: 'a.zip', base64: zipA.toString('base64') });
check('返回 code=0', r1 && r1.code === 0, JSON.stringify(r1 && r1.message));
check('插件 ID 正确', r1.data && r1.data.pluginId === 'napcat-plugin-alpha');
check('文件写入插件目录', fs.existsSync(path.join(PLUGINS, 'napcat-plugin-alpha', 'index.mjs')));
check('子目录文件也写入', fs.existsSync(path.join(PLUGINS, 'napcat-plugin-alpha', 'lib', 'util.mjs')));
check('写入 plugins.json 并启用', state.status['napcat-plugin-alpha'] === true);
check('已热加载（白名单被内存放行，无需重启）', r1.data.loaded === true && state.loaded.has('napcat-plugin-alpha'));
check('结果标记 needRestart=false', r1.data.needRestart === false);
check('结果标记 whitelistRelaxed=true', r1.data.whitelistRelaxed === true);
check('白名单里已注入插件 ID', fs.readFileSync(SHELL, 'utf8').includes('"napcat-plugin-alpha"'));
check('原白名单项未被破坏', ['builtin', 'cleaner', 'ssqq', 'qce'].every(k => fs.readFileSync(SHELL, 'utf8').includes(`napcat-plugin-${k}`)));
check('外壳文件语法仍合法', (() => { try { execFileSync('node', ['--check', SHELL]); return true; } catch { return false; } })());

console.log('\n【4】 原始 octet-stream 上传（模拟 curl）');
{
  const res = mkRes();
  await importRoute.h({ headers: { 'content-type': 'application/octet-stream', ...AUTH_HDR }, body: {}, query: { filename: 'b.zip' }, raw: Readable.from(zipB) }, res);
  check('返回 code=0', res._json && res._json.code === 0, JSON.stringify(res._json && res._json.message));
  check('插件 B 安装成功', fs.existsSync(path.join(PLUGINS, 'napcat-plugin-beta', 'package.json')));
  check('插件 B 已启用', state.status['napcat-plugin-beta'] === true);
}

console.log('\n【5】 重复安装（覆盖旧目录 + 备份）');
state.status['napcat-plugin-alpha'] = false; state.loaded.delete('napcat-plugin-alpha');
let r5 = await postJson({ filename: 'a.zip', base64: zipA.toString('base64') });
check('重复安装成功', r5.code === 0);
check('覆盖前调用过 unregister', state.unregistered.includes('napcat-plugin-alpha'));
check('生成了 .bak- 备份目录', fs.readdirSync(PLUGINS).some(d => d.startsWith('.bak-napcat-plugin-alpha')));
check('再次安装时白名单不重复注入', (fs.readFileSync(SHELL, 'utf8').match(/"napcat-plugin-alpha"/g) || []).length === 1);

console.log('\n【6】 失败路径');
let r6 = await postJson({ filename: 'c.zip', base64: zipC.toString('base64') });
check('穿越包被拒绝且 code!=0', r6.code !== 0, r6.message);
check('穿越文件没有落到磁盘', !fs.existsSync(path.join(ROOT, 'evil.txt')) && !fs.existsSync(path.join(PLUGINS, '..', 'evil.txt')));
let r6b = await postJson({ filename: 'd.zip', base64: zipD.toString('base64') });
check('无 package.json 被拒绝', r6b.code !== 0, r6b.message);
let r6c = await postJson({ filename: 'x.zip', base64: '' });
check('空内容被拒绝', r6c.code !== 0, r6c.message);

console.log('\n【7】 列表 / 卸载');
{
  const res = mkRes();
  await listRoute.h({ headers: { ...AUTH_HDR }, body: {}, query: {}, raw: null }, res);
  const ids = (res._json.data.plugins || []).map(p => p.id);
  check('列表包含两个测试插件', ids.includes('napcat-plugin-alpha') && ids.includes('napcat-plugin-beta'), ids.join(','));
}
{
  const res = mkRes();
  await uninstallRoute.h({ headers: { ...AUTH_HDR }, body: { id: 'napcat-plugin-beta' }, query: {}, raw: null }, res);
  check('卸载成功', res._json.code === 0, res._json.message);
  check('目录已删除', !fs.existsSync(path.join(PLUGINS, 'napcat-plugin-beta')));
}
{
  const res = mkRes();
  await uninstallRoute.h({ headers: { ...AUTH_HDR }, body: { id: 'napcat-plugin-importer' }, query: {}, raw: null }, res);
  check('拒绝卸载自己', res._json.code !== 0, res._json.message);
}


console.log('\n【8】 GBK 文件名（Windows 中文 zip，手工构造 legacy 编码 zip）');
{
  const gz = path.join(ROOT, 'gbk.zip');
  execFileSync('python3', ['-c', `
import struct, zlib
def mkzip(entries):
    out = b''; central = b''; off = 0
    for name, data in entries:
        crc = zlib.crc32(data) & 0xffffffff
        co = zlib.compressobj(9, zlib.DEFLATED, -15)
        cdata = co.compress(data) + co.flush()
        lh = struct.pack('<IHHHHHIIIHH', 0x04034b50, 20, 0, 8, 0, 0, crc, len(cdata), len(data), len(name), 0) + name
        out += lh + cdata
        central += struct.pack('<IHHHHHHIIIHHHHHII', 0x02014b50, 20, 20, 0, 8, 0, 0, crc, len(cdata), len(data), len(name), 0, 0, 0, 0, 0, off) + name
        off += len(lh) + len(cdata)
    eocd = struct.pack('<IHHHHIIH', 0x06054b50, 0, 0, len(entries), len(entries), len(central), len(out), 0)
    return out + central + eocd
pkg = '{"name":"napcat-plugin-gbk","version":"1.0.0"}'.encode()
open(${JSON.stringify(gz)}, 'wb').write(mkzip([(b'package.json', pkg), ('\u63d2\u4ef6/\u56fe\u6807.png'.encode('gbk'), b'PNGDATA')]))
`]);
  const ents = readZip(fs.readFileSync(gz));
  const names = ents.map(e => e.name);
  check('GBK 条目名被正确解码', names.some(n => n.includes('图标.png')), names.join(' | '));
  check('GBK 包能正常规划安装', planInstall(ents, 'gbk.zip').id === 'napcat-plugin-gbk');
}


console.log('\n【9】 鉴权');
{
  const cfgFile = path.join(ROOT, 'data', 'importer', 'config.json');
  fs.rmSync(cfgFile, { force: true });
  const call = async (headers, body) => {
    const res = mkRes();
    await importRoute.h({
      headers: Object.assign({ 'content-type': 'application/json' }, headers),
      body: body || { filename: 'b.zip', base64: zipB.toString('base64') },
      query: {}, raw: null
    }, res);
    return { json: res._json, status: res.statusCode };
  };

  let r = await call({});
  check('无凭证 → 401', r.status === 401 && r.json.code !== 0, r.json.message);
  r = await call({ 'x-forwarded-for': '1.1.1.1' });
  check('仍无凭证（换 IP）→ 401', r.status === 401);
  r = await call({ authorization: 'Bearer wrong-token' });
  check('口令错误 → 401', r.status === 401, r.json.message);
  r = await call({ ...AUTH_HDR });
  check('WebUI token 作访问口令 → 通过', r.status !== 401 && r.json.code === 0, r.json.message);

  // —— WebUI 登录凭证：代理给 WebUI 的 /api/auth/check ——
  let seen = null;
  fetchStub = async (url, opt) => { seen = { url, opt }; return { ok: true, json: async () => ({ code: 0 }) }; };
  r = await call({ authorization: 'Bearer ' + CRED });
  check('WebUI 凭证（代理校验通过）→ 通过', r.json.code === 0, r.json.message);
  check('确实请求了 /api/auth/check 且带上凭证', !!seen && /\/api\/auth\/check$/.test(seen.url) && seen.opt.headers.Authorization === 'Bearer ' + CRED);
  fetchStub = async () => ({ ok: true, json: async () => ({ code: -1, message: 'Authorization Failed' }) });
  r = await call({ authorization: 'Bearer ' + CRED });
  check('WebUI 凭证无效 → 401', r.status === 401, r.json.message);
  fetchStub = async () => { throw new Error('ECONNREFUSED'); };
  r = await call({ authorization: 'Bearer ' + CRED });
  check('WebUI 不可达时凭证路径 → 401（不误放行）', r.status === 401, r.json.message);
  fetchStub = null;

  // 老运行时没有全局 fetch：凭证路径应优雅失败，但口令路径仍可用
  {
    const savedFetch = globalThis.fetch;
    // eslint-disable-next-line no-global-assign
    globalThis.fetch = undefined;
    r = await call({ authorization: 'Bearer ' + CRED });
    check('运行时无 fetch：凭证路径 401（不崩）', r.status === 401, r.json.message);
    r = await call({ ...AUTH_HDR });
    check('运行时无 fetch：口令路径仍可用', r.json.code === 0, r.json.message);
    globalThis.fetch = savedFetch;
  }

  // —— 插件配置里的访问口令 ——
  fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
  fs.writeFileSync(cfgFile, JSON.stringify({ requireAuth: true, trustWebUiCredential: true, accessToken: 'my-own-pass', allowPage: true }));
  r = await call({ authorization: 'Bearer my-own-pass' });
  check('插件配置 accessToken 生效', r.json.code === 0, r.json.message);
  r = await call({ authorization: 'Bearer testwebtoken' });
  check('配置了口令后 WebUI token 不再通过', r.status === 401, r.json.message);

  // —— 关闭鉴权 ——
  fs.writeFileSync(cfgFile, JSON.stringify({ requireAuth: false }));
  r = await call({});
  check('requireAuth=false → 免鉴权', r.json.code === 0, r.json.message);
  fs.rmSync(cfgFile, { force: true });

  // —— 暴力破解锁定 ——
  const ip = '9.9.9.9';
  for (let i = 0; i < 10; i++) await call({ 'x-forwarded-for': ip });
  r = await call({ 'x-forwarded-for': ip });
  check('同一 IP 连续失败 10 次 → 429 锁定', r.status === 429, r.json.message);
  r = await call({ 'x-forwarded-for': ip, ...AUTH_HDR });
  check('锁定期间口令正确也被挡', r.status === 429, r.json.message);
  r = await call({ ...AUTH_HDR });
  check('其他 IP 不受影响', r.json.code === 0);

  // —— 页面也走鉴权：页面里没有凭证时不应请求数据 ——
  const html = fs.readFileSync(path.join(ctx.pluginPath, 'webui', 'import.html'), 'utf8');
  check('页面含鉴权闸门文案', html.includes('需要鉴权') && html.includes('使用 WebUI 登录凭证'));
  check('页面从同源 localStorage 取 WebUI 凭证', /localStorage\.getItem\(WEBUI_TOKEN_KEY\)/.test(html) && /'token'/.test(html));
  check('页面所有请求都带 Authorization', html.includes("headers.Authorization = 'Bearer ' + auth"));

  // —— allowPage=false 时不注册免鉴权页面 ——
  fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
  fs.writeFileSync(cfgFile, JSON.stringify({ allowPage: false }));
  captured.pages.length = 0;
  await mod.plugin_init(ctx);
  check('allowPage=false → 不再注册扩展页面', captured.pages.length === 0);
  check('allowPage=false 时接口仍注册', captured.api.some(x => x.p === '/import'));
  fs.rmSync(cfgFile, { force: true });
}


console.log('\n【10】 WebUI「导入插件」按钮注入（插件管理页）');
{
  const staticDir = path.join(ROOT, 'static');
  fs.mkdirSync(staticDir, { recursive: true });
  const idx = path.join(staticDir, 'index.html');
  const ORIGINAL = '<!doctype html>\n<html><head><title>NapCat WebUI</title></head>\n<body>\n<div id="root"></div>\n<script type="module" src="/assets/index-x.js"></script>\n</body>\n</html>\n';
  const cfgFile = path.join(ROOT, 'data', 'importer', 'config.json');
  fs.rmSync(cfgFile, { force: true });
  fs.writeFileSync(idx, ORIGINAL);
  captured.static.length = 0;

  await mod.plugin_init(ctx);
  let after = fs.readFileSync(idx, 'utf8');
  check('index.html 内联注入了脚本', after.includes('__napcatImporterBtnLoaded'));
  check('注入带标记注释（可精确移除）', after.includes('<!-- napcat-plugin-importer -->'));
  check('脚本插在 </body> 之前', after.indexOf('__napcatImporterBtnLoaded') < after.indexOf('</body>'));
  check('原文件已备份且内容一致', fs.existsSync(idx + '.napcat-importer.bak') && fs.readFileSync(idx + '.napcat-importer.bak', 'utf8') === ORIGINAL);
  check('内联脚本含接口候选（兼容反代前缀）', after.includes("/api/Plugin/ext/' + PLUGIN_ID") && after.includes("p.indexOf('/webui')"));
  check('内联脚本能被浏览器直接执行（无外链 src）', !/<script src=[^>]*inject/.test(after));
  check('注册了静态路由 /static → webui', captured.static.some(x => x.urlPath === '/static' && /webui$/.test(x.localPath)));
  check('二次 init 不重复注入（标记只出现一次）', (fs.readFileSync(idx, 'utf8').match(/<!-- napcat-plugin-importer -->/g) || []).length === 1);

  // 换掉 inject.js 内容 → 再次 init 应当把新内容同步进 index.html
  const jsCopy = path.join(ROOT, 'inject-copy.js');
  fs.copyFileSync(path.join(ctx.pluginPath, 'webui', 'inject.js'), jsCopy);
  const modified = fs.readFileSync(jsCopy, 'utf8').replace("var MARK_TEXT = '插件管理'", "var MARK_TEXT = '插件管理'; var __TEST_MARK__ = 1;");
  fs.writeFileSync(path.join(ctx.pluginPath, 'webui', 'inject.js'), modified);
  await mod.plugin_init(ctx);
  check('脚本更新后会同步进 index.html', fs.readFileSync(idx, 'utf8').includes('__TEST_MARK__'));
  check('更新后仍只有一份注入', (fs.readFileSync(idx, 'utf8').match(/<!-- napcat-plugin-importer -->/g) || []).length === 1);
  fs.copyFileSync(jsCopy, path.join(ctx.pluginPath, 'webui', 'inject.js')); // 还原
  fs.rmSync(jsCopy, { force: true });
  await mod.plugin_init(ctx);

  await mod.plugin_cleanup(ctx);
  check('plugin_cleanup 摘掉注入且逐字节还原', fs.readFileSync(idx, 'utf8') === ORIGINAL);

  // 关掉开关
  fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
  fs.writeFileSync(cfgFile, JSON.stringify({ injectButton: false }));
  fs.writeFileSync(idx, ORIGINAL);
  await mod.plugin_init(ctx);
  check('injectButton=false 时不注入', !fs.readFileSync(idx, 'utf8').includes('inject.js'));
  fs.rmSync(cfgFile, { force: true });

  // 原子写入 & 守护注入
  check('writeFileAtomic 能替换内容且不留临时文件', (() => {
    const f = path.join(ROOT, 'atomic.txt');
    fs.writeFileSync(f, 'old');
    const how = mod.writeFileAtomic(f, 'new-content');
    const left = fs.readdirSync(ROOT).filter(n => n.startsWith('.napcat-importer.') && n.endsWith('.tmp'));
    return fs.readFileSync(f, 'utf8') === 'new-content' && left.length === 0 && (how === 'rename' || how === 'write');
  })());
  check('注入被覆盖后 ensureWebUiInjection 会补回', (() => {
    fs.writeFileSync(idx, ORIGINAL);                                  // 模拟被别的工具重写
    const again = mod.ensureWebUiInjection(ctx);
    return again === true && fs.readFileSync(idx, 'utf8').includes('__napcatImporterBtnLoaded');
  })());

  // 注入脚本本体
  const jsPath = path.join(ctx.pluginPath, 'webui', 'inject.js');
  const js = fs.readFileSync(jsPath, 'utf8');
  check('inject.js 语法通过 node --check', (() => { try { execFileSync('node', ['--check', jsPath]); return true; } catch { return false; } })());
  check('inject.js 用「插件管理」h1 作锚点', js.includes("'插件管理'"));
  check('inject.js 复用原版按钮样式类', js.includes('bg-primary-100/50') && js.includes('hover:bg-primary-200/50') && js.includes('text-primary-700'));
  check('inject.js 调用导入接口', js.includes("'/import'"));
  check('inject.js 点击时先探测插件在线', js.includes("api('/list'") && js.includes('pluginAlive'));
  check('inject.js 接口候选含 /api 与 /plugin 两种路径', js.includes("/api/Plugin/ext/") && js.includes("'/plugin/' + PLUGIN_ID + '/api'"));
  check('inject.js 锚点缺失时有右下角兜底按钮', js.includes('injectFab') && js.includes('FAB_DELAY'));
  check('inject.js 有 SPA 重注入（MutationObserver）', js.includes('MutationObserver') && js.includes('setInterval'));
  check('inject.js 凭证失败时提示输入口令', js.includes('window.prompt') && js.includes('napcat-importer-token'));
}


console.log('\n【11】 守护注入：被外部工具覆盖后自动补回（事件驱动 + 轮询兜底）');
{
  const staticDir = path.join(ROOT, 'static');
  const idx = path.join(staticDir, 'index.html');
  const ORIG = '<!doctype html>\n<html><body><div id="root"></div></body></html>\n';
  const cfgFile = path.join(ROOT, 'data', 'importer', 'config.json');
  fs.writeFileSync(idx, ORIG);
  fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
  fs.writeFileSync(cfgFile, JSON.stringify({ injectWatchIntervalMs: 120 }));  // 测试用：短间隔
  await mod.plugin_init(ctx);
  check('init 时注入成功', fs.readFileSync(idx, 'utf8').includes('__napcatImporterBtnLoaded'));

  // 模拟“面板脚本以 root 重写 index.html”，把注入冲掉
  fs.writeFileSync(idx, ORIG + '<!-- 外部工具重写 -->\n');
  await tick(500);
  check('被覆盖后自动补回（≤500ms）', fs.readFileSync(idx, 'utf8').includes('__napcatImporterBtnLoaded'));
  check('补回后外部工具的内容仍在（不是整文件覆盖）', fs.readFileSync(idx, 'utf8').includes('外部工具重写'));

  // cleanup 之后不应再补
  await mod.plugin_cleanup(ctx);
  fs.writeFileSync(idx, ORIG);
  await tick(400);
  check('cleanup 后停止守护（不再自动补回）', !fs.readFileSync(idx, 'utf8').includes('__napcatImporterBtnLoaded'));
  fs.rmSync(cfgFile, { force: true });
}


console.log('\n【12】 社区索引安全扫描（HIGH 规则）自查 —— 防止 PR 被误判无法合并');
{
  const repoRoot = path.join(import.meta.dirname, '..');
  // 社区索引 scripts/security-scan.mjs 的 HIGH 规则（命中即 has_high_risks=true → PR 无法自动合并）
  const RULES = [
    { name: 'Exec/Spawn (RCE Risk)', re: /child_process|exec\(|spawn\(|execSync|spawnSync/ },
    { name: 'Eval/Function (Code Injection)', re: /eval\(|new Function\(/ },
    { name: 'Obfuscated Code (Hex)', re: /_0x[a-f0-9]{4,}/ },
    { name: 'Minified/Obfuscated Line', re: /.{1000,}/ }
  ];
  // 扫描器会忽略 .md/.json/.yml 等，这里只查会被扫的发布文件
  const SCANNED = ['index.mjs', 'webui/inject.js', 'webui/import.html'];
  for (const f of SCANNED) {
    const lines = fs.readFileSync(path.join(repoRoot, f), 'utf8').split('\n');
    for (const r of RULES) {
      const idx = lines.findIndex(l => r.re.test(l));
      check(`${f} 无「${r.name}」`, idx < 0, idx >= 0 ? `第 ${idx + 1} 行: ${lines[idx].trim().slice(0, 70)}` : '');
    }
  }
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
fs.rmSync(ROOT, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
