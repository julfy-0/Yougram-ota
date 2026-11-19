#!/usr/bin/env node
/**
 * Добавляет сборку Yougram в репозиторий OTA: кладёт APK в apks/, описание в jsons/ (и баннер в banners/).
 * Нужен Node 18+ и Android SDK (aapt2). Работает на Windows / macOS / Linux.
 *
 *   node tools/add-release.mjs <app.apk> [--notes файл|"текст"] [--banner banner.png] [--rollout 1..100]
 *                              [--push] [--dry-run] [--version-name 1.4.4-b1 --version-code 41]
 *
 * Версию, versionCode и пакет берёт из самого APK. Канал — из суффикса версии:
 * «1.4.4-b2» → beta №2, «1.4.4-r» или «1.4.4» → release.
 * Файлы: apks/Yougram-v<версия>.apk, jsons/Update-v<версия>.json, banners/Banner-v<версия>.png
 *
 * --push: делает git commit + push в два шага — сначала APK (и баннер), потом JSON,
 *         чтобы клиенты не увидели обновление раньше, чем появится файл.
 * --rollout N: раздать только ~N% устройств. Чтобы раздать всем, запустите снова с тем же APK и --rollout 100.
 * --version-name / --version-code: задать вручную, если aapt2 недоступен.
 */
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = "app.yougram";
const win = process.platform === "win32";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GITHUB_LIMIT = 100 * 1024 * 1024;

function die(msg) {
  console.error(`add-release: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const o = { rollout: 100, push: false, dryRun: false };
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
if (size > GITHUB_LIMIT) {
  die(`APK весит ${(size / 1048576).toFixed(1)} МБ — GitHub не принимает файлы больше 100 МБ. Нужен другой способ хранения.`);
}
const hash = await sha256(o.apk);

let bannerFile = null;
if (o.banner) {
  if (!existsSync(o.banner)) die(`баннер не найден: ${o.banner}`);
  if (extname(o.banner).toLowerCase() !== ".png") die("баннер должен быть PNG (1000×400)");
  bannerFile = o.banner;
}

const apkRel = `apks/Yougram-v${full}.apk`;
const jsonRel = `jsons/Update-v${full}.json`;
const bannerRel = `banners/Banner-v${full}.png`;

const manifest = {
  versionName: base,
  versionCode: info.versionCode,
  beta,
  notes: notesFrom(o.notes),
  size,
  sha256: hash,
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
if (resolve(o.apk) !== apkDest) copyFileSync(o.apk, apkDest);
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
