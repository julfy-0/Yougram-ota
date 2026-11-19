/**
 * Yougram OTA — Cloudflare Worker без R2. Данные лежат в GitHub-репозитории (папки в ветке main):
 *   apks/Yougram-v<версия>.apk   (или .zip с одним APK внутри, если APK больше 100 МБ)
 *   jsons/Update-v<версия>.json
 *   banners/Banner-v<версия>.png     (необязательно)
 * Версия вида 1.4.4-b1 (beta) или 1.4.4-r (стабильная). Воркер берёт самую новую версию канала по номеру.
 *
 * Маршруты:
 *   GET  /v1/check?channel=release|beta&code=<versionCode>&did=<id>  → {update:false} | {update:true, ...}
 *   GET  /v1/apk/<channel>/<versionCode>      (Range / HEAD)
 *   GET  /v1/banner/<channel>/<versionCode>
 *   GET  /v1/health
 *
 * Необязательный секрет GITHUB_TOKEN (Settings → Variables and Secrets) поднимает лимит GitHub API с 60 до 5000 в час.
 */

const OWNER = "julfy-0";
const REPO = "Yougram-ota"; // публичный репозиторий с папками apks/ и jsons/
const BRANCH = "main";

const RAW = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}`;
const LIST = `https://api.github.com/repos/${OWNER}/${REPO}/contents/jsons?ref=${BRANCH}`;
const ALLOWED = [`https://raw.githubusercontent.com/${OWNER}/`];
const allowed = (u) => typeof u === "string" && ALLOWED.some((p) => u.startsWith(p));

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });

export default {
  async fetch(req, env) {
    if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "method_not_allowed" }, 405);
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (path === "/v1/check") return await check(url, env);
      if (path === "/v1/health" || path === "/") return json({ ok: true, service: "yougram-ota", storage: "github" });

      let m = path.match(/^\/v1\/apk\/(release|beta)\/(\d{1,9})$/);
      if (m) {
        const man = await latest(m[1], env);
        if (!man || man.versionCode !== Number(m[2])) return json({ error: "not_found" }, 404);
        return await proxy(req, man.apkUrl, {
          type: man.zip ? "application/zip" : "application/vnd.android.package-archive",
          filename: `yougram-${man.versionCode}.${man.zip ? "zip" : "apk"}`,
        });
      }
      m = path.match(/^\/v1\/banner\/(release|beta)\/(\d{1,9})$/);
      if (m) {
        const man = await latest(m[1], env);
        if (!man || man.versionCode !== Number(m[2]) || !man.banner) return json({ error: "not_found" }, 404);
        return await proxy(req, man.banner, { type: "image/png" });
      }
      return json({ error: "not_found" }, 404);
    } catch (e) {
      return json({ error: "internal" }, 500);
    }
  },
};

function ghFetch(url, env, ttl) {
  const headers = { "user-agent": "yougram-ota", accept: "application/vnd.github+json" };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return fetch(url, { headers, cf: { cacheTtl: ttl, cacheEverything: true } });
}

const channelOf = (ver) => (/-b\d+$/i.test(ver) ? "beta" : "release");

/** "1.4.4-b2" → [1,4,4,0,2]; "1.4.4-r" или "1.4.4" → [1,4,4,1,0]. Другой формат → null. */
function versionKey(ver) {
  const m = ver.match(/^(\d+)\.(\d+)\.(\d+)(?:-(?:b(\d+)|r))?$/i);
  if (!m) return null;
  const beta = /-b\d+$/i.test(ver);
  return [+m[1], +m[2], +m[3], beta ? 0 : 1, beta ? +m[4] : 0];
}
const cmp = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

/** Самая свежая сборка канала по номеру версии в имени файла jsons/Update-v<версия>.json. */
async function latest(channel, env) {
  const r = await ghFetch(LIST, env, 120);
  if (!r.ok) return null;
  const files = await r.json();
  if (!Array.isArray(files)) return null;

  const cands = [];
  for (const f of files) {
    const m = f.name.match(/^Update-v(.+)\.json$/i);
    if (!m || channelOf(m[1]) !== channel) continue;
    const key = versionKey(m[1]);
    if (key) cands.push({ ver: m[1], key, url: f.download_url });
  }
  cands.sort((a, b) => cmp(b.key, a.key));

  for (const c of cands.slice(0, 3)) {
    if (!allowed(c.url)) continue;
    const jr = await ghFetch(c.url, env, 60);
    if (!jr.ok) continue;
    let man;
    try {
      man = await jr.json();
    } catch {
      continue;
    }
    if (!Number.isInteger(man.versionCode) || typeof man.versionName !== "string") continue;
    return {
      ...man,
      beta: Number.isInteger(man.beta) ? man.beta : channel === "beta" ? 1 : 0,
      // zip: true — на GitHub лежит ZIP с одним APK внутри (обход лимита 100 МБ на файл)
      apkUrl: `${RAW}/apks/Yougram-v${c.ver}.${man.zip ? "zip" : "apk"}`,
      banner: man.banner ? `${RAW}/banners/Banner-v${c.ver}.png` : null,
    };
  }
  return null;
}

/** Стабильная «корзина» 0..99 для устройства и версии (FNV-1a) — для поэтапной раздачи. */
function bucket(did, versionCode) {
  let h = 0x811c9dc5;
  const s = `${did}:${versionCode}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 100;
}

async function check(url, env) {
  const channel = url.searchParams.get("channel") === "beta" ? "beta" : "release";
  const code = parseInt(url.searchParams.get("code") || "0", 10) || 0;
  const did = (url.searchParams.get("did") || "").slice(0, 64);

  const [release, beta] = await Promise.all([
    latest("release", env),
    channel === "beta" ? latest("beta", env) : null,
  ]);

  // Бета-канал получает самую свежую сборку из обоих каналов, стабильный — только release.
  let best = release;
  let bestChannel = "release";
  if (beta && (!release || beta.versionCode > release.versionCode)) {
    best = beta;
    bestChannel = "beta";
  }
  if (!best || best.versionCode <= code) return json({ update: false });

  const rollout = Number.isInteger(best.rollout) ? Math.min(100, Math.max(0, best.rollout)) : 100;
  if (rollout < 100 && (!did || bucket(did, best.versionCode) >= rollout)) return json({ update: false });

  const base = `${url.origin}/v1`;
  return json({
    update: true,
    channel: bestChannel,
    versionName: best.versionName,
    versionCode: best.versionCode,
    beta: best.beta || 0,
    notes: best.notes || "",
    size: best.size || 0,
    sha256: best.sha256 || null,
    zip: Boolean(best.zip),
    zipSize: best.zipSize || 0,
    zipSha256: best.zipSha256 || null,
    apkUrl: `${base}/apk/${bestChannel}/${best.versionCode}`,
    bannerUrl: best.banner ? `${base}/banner/${bestChannel}/${best.versionCode}` : null,
  });
}

/** Стримит файл с GitHub приложению: поддерживает Range (докачка) и HEAD. */
async function proxy(req, target, { type, filename }) {
  const h = new Headers();
  for (const k of ["range", "if-range", "if-none-match", "if-modified-since"]) {
    const v = req.headers.get(k);
    if (v) h.set(k, v);
  }
  const up = await fetch(target, { method: req.method, headers: h, redirect: "follow" });
  if (up.status === 404) return json({ error: "not_found" }, 404);
  if (!up.ok && up.status !== 304) return json({ error: "upstream", status: up.status }, 502);

  const headers = new Headers();
  for (const k of ["content-length", "content-range", "etag", "last-modified"]) {
    const v = up.headers.get(k);
    if (v) headers.set(k, v);
  }
  headers.set("content-type", type);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "public, max-age=3600");
  headers.set("access-control-allow-origin", "*");
  if (filename) headers.set("content-disposition", `attachment; filename="${filename}"`);
  return new Response(req.method === "HEAD" ? null : up.body, { status: up.status, headers });
}
