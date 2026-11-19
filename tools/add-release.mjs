#!/usr/bin/env node
/**
 * Добавляет сборку Yougram в репозиторий OTA: кладёт APK в apks/, описание в jsons/ (и баннер в banners/).
 * Нужен Node 18+ и Android SDK (aapt2). Работает на Windows / macOS / Linux.
 *
 *   node tools/add-release.mjs <app.apk> [--notes файл|"текст"] [--banner banner.png] [--rollout 1..100]
 *                              [--zip | --no-zip] [--push] [--dry-run] [--version-name 1.4.4-b1 --version-code 41]
 *
 * Версию, versionCode и пакет берёт из самого APK. Канал — из суффикса версии:
 * «1.4.4-b2» → beta №2, «1.4.4-r» или «1.4.4» → release.
 * Файлы: apks/Yougram-v<версия>.apk, jsons/Update-v<версия>.json, banners/Banner-v<версия>.png
 *
 * --push: делает git commit + push в два шага — сначала APK (и баннер), потом JSON,
 *         чтобы клиенты не увидели обновление раньше, чем появится файл.
 * --rollout N: раздать только ~N% устройств. Чтобы раздать всем, запустите снова с тем же APK и --rollout 100.
 * --zip: положить в apks/ не APK, а ZIP с одним APK внутри (приложение само распакует). Включается автоматически,
 *        если APK больше 95 МБ — так обходится лимит GitHub 100 МБ на файл. --no-zip отключает автоупаковку.
 * --version-name / --version-code: задать вручную, если aapt2 недоступен.
 */
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = "app.yougram";
const win = process.platform === "win32";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GITHUB_LIMIT = 100 * 1024 * 1024;
const AUTO_ZIP_FROM = 95 * 1024 * 1024;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** ZIP с одной записью (deflate). Без зависимостей; файл до 4 ГБ. */
function makeZip(entryName, data) {
  const name = Buffer.from(entryName, "utf8");
  const crc = crc32(data);
  const body = deflateRawSync(data, { level: 9 });
  const useDeflate = body.length < data.length;
  const payload = useDeflate ? body : data;
  const method = useDeflate ? 8 : 0;
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // версия
  local.writeUInt16LE(0x0800, 6); // имя в UTF-8
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42); // смещение локального заголовка

  const cdOffset = local.length + name.length + payload.length;
  const cdSize = central.length + name.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);

  return Buffer.concat([local, name, payload, central, name, eocd]);
}

function die(msg) {
  console.error(`add-release: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const o = { rollout: 100, push: false, dryRun: false, zip: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? die(`после ${a} нужно значение`);
    if (a === "--notes") o.notes = next();
    else if (a === "--banner") o.banner = next();
    else if (a === "--rollout") o.rollout = parseInt(next(), 10);
    else if (a === "--version-name") o.versionName = next();
    else if (a === "--version-code") o.versionCode = parseInt(next(), 10);
    else if (a === "--push") o.push = true;
    else if (a === "--zip") o.zip = true;
    else if (a === "--no-zip") o.zip = false;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a.startsWith("--")) die(`неизвестный флаг ${a}`);
    else rest.push(a);
  }
  o.apk = rest[0];
  return o;
}

function findAapt2() {
  const roots = new Set([process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].filter(Boolean));
  for (const dir of [process.cwd(), process.env.YOUGRAM_APP_DIR].filter(Boolean)) {
    try {
      const m = readFileSync(join(dir, "local.properties"), "utf8").match(/^sdk\.dir=(.+)$/m);
      if (m) roots.add(m[1].trim().replace(/\\:/g, ":").replace(/\\\\/g, "\\"));
    } catch {}
  }
  if (process.env.LOCALAPPDATA) roots.add(join(process.env.LOCALAPPDATA, "Android", "Sdk"));
  if (homedir()) {
    roots.add(join(homedir(), "Library", "Android", "sdk"));
    roots.add(join(homedir(), "Android", "Sdk"));
  }
  const exe = win ? "aapt2.exe" : "aapt2";
  for (const root of roots) {
    const bt = join(root, "build-tools");
    if (!existsSync(bt)) continue;
    const versions = readdirSync(bt).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) {
      const p = join(bt, v, exe);
      if (existsSync(p)) return p;
    }
  }
  return exe;
}

function readBadging(apk) {
  let out;
  try {
    out = execFileSync(findAapt2(), ["dump", "badging", apk], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    die("не удалось запустить aapt2 (Android SDK → build-tools). Задайте ANDROID_HOME или передайте --version-name и --version-code.");
  }
  const m = out.match(/package: name='([^']+)' versionCode='(\d+)' versionName='([^']*)'/);
  if (!m) die("в выводе aapt2 нет информации о пакете — это точно APK?");
  return { pkg: m[1], versionCode: parseInt(m[2], 10), versionName: m[3] };
}

async function sha256(file) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}

function git(...args) {
  execFileSync("git", args, { cwd: ROOT, stdio: "inherit" });
}

function notesFrom(arg) {
  if (!arg) return "";
  return (existsSync(arg) ? readFileSync(arg, "utf8") : arg).replace(/\r\n/g, "\n").trim();
}

const o = parseArgs(process.argv.slice(2));
if (!o.apk) die('укажите APK:  node tools/add-release.mjs app-release.apk --notes notes.txt');
if (!existsSync(o.apk)) die(`файл не найден: ${o.apk}`);
if (!(o.rollout >= 1 && o.rollout <= 100)) die("--rollout: число от 1 до 100");

let info;
if (o.versionName && o.versionCode) info = { pkg: PACKAGE, versionName: o.versionName, versionCode: o.versionCode };
else info = readBadging(o.apk);
if (info.pkg !== PACKAGE) die(`пакет ${info.pkg}, ожидается ${PACKAGE}`);

const full = info.versionName; // например 1.4.4-b2
if (!/^\d+\.\d+\.\d+(-b\d+|-r)?$/i.test(full)) {
  die(`версия «${full}» не подходит: нужен формат X.Y.Z-bN (бета) или X.Y.Z-r (релиз)`);
}
const bm = full.match(/^(.*?)-b(\d+)$/i);
const beta = bm ? parseInt(bm[2], 10) : 0;
const base = bm ? bm[1] : full.replace(/-r$/i, "");
const channel = beta > 0 ? "beta" : "release";

const size = statSync(o.apk).size;
const hash = await sha256(o.apk);
const useZip = o.zip ?? size > AUTO_ZIP_FROM;
let zipBuf = null;
if (useZip) {
  zipBuf = makeZip(`Yougram-v${full}.apk`, readFileSync(o.apk));
  console.log(`ZIP: ${(size / 1048576).toFixed(1)} МБ → ${(zipBuf.length / 1048576).toFixed(1)} МБ`);
  if (zipBuf.length > GITHUB_LIMIT) {
    die(`даже в ZIP файл весит ${(zipBuf.length / 1048576).toFixed(1)} МБ — GitHub не принимает файлы больше 100 МБ. Нужен другой способ хранения (GitHub Releases).`);
  }
} else if (size > GITHUB_LIMIT) {
  die(`APK весит ${(size / 1048576).toFixed(1)} МБ — GitHub не принимает файлы больше 100 МБ. Попробуйте --zip или GitHub Releases.`);
}

let bannerFile = null;
if (o.banner) {
  if (!existsSync(o.banner)) die(`баннер не найден: ${o.banner}`);
  if (extname(o.banner).toLowerCase() !== ".png") die("баннер должен быть PNG (1000×400)");
  bannerFile = o.banner;
}

const apkRel = `apks/Yougram-v${full}.${useZip ? "zip" : "apk"}`;
const jsonRel = `jsons/Update-v${full}.json`;
const bannerRel = `banners/Banner-v${full}.png`;

const manifest = {
  versionName: base,
  versionCode: info.versionCode,
  beta,
  notes: notesFrom(o.notes),
  size,
  sha256: hash,
  ...(useZip ? { zip: true, zipSize: zipBuf.length, zipSha256: createHash("sha256").update(zipBuf).digest("hex") } : {}),
  banner: Boolean(bannerFile),
  rollout: o.rollout,
  publishedAt: new Date().toISOString(),
};

console.log(`Канал: ${channel} · ${full} (код ${info.versionCode}) · ${(size / 1048576).toFixed(1)} МБ · rollout ${o.rollout}%`);
console.log(`sha256 ${hash}`);
console.log(`→ ${apkRel}${bannerFile ? `\n→ ${bannerRel}` : ""}\n→ ${jsonRel}`);

if (o.dryRun) {
  console.log("Готово (dry-run, ничего не записано).");
  process.exit(0);
}

for (const d of ["apks", "jsons", "banners"]) mkdirSync(join(ROOT, d), { recursive: true });
const apkDest = join(ROOT, apkRel);
if (useZip) writeFileSync(apkDest, zipBuf);
else if (resolve(o.apk) !== apkDest) copyFileSync(o.apk, apkDest);
if (bannerFile) copyFileSync(bannerFile, join(ROOT, bannerRel));
writeFileSync(join(ROOT, jsonRel), JSON.stringify(manifest, null, 2) + "\n");

if (o.push) {
  // Сначала файлы, потом JSON: пока JSON не опубликован, сервер версию не предлагает.
  git("add", apkRel, ...(bannerFile ? [bannerRel] : []));
  git("commit", "-m", `APK ${full}`);
  git("push");
  git("add", jsonRel);
  git("commit", "-m", `Update ${full}`);
  git("push");
  console.log(`Готово: ${full} опубликована в канале ${channel}. Сервер увидит её через 2–5 минут.`);
} else {
  console.log(
    `Файлы записаны. Теперь закоммитьте и запушьте: сначала ${apkRel}${bannerFile ? ` и ${bannerRel}` : ""}, затем ${jsonRel}.`,
  );
}
