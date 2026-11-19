# Yougram-ota

Сервер обновлений Yougram **без R2 и без оплаты**: файлы лежат прямо в этом репозитории, а Cloudflare Worker
отдаёт их приложению (приложение умеет ходить только на адрес `OTA_URL`).

```text
tools/add-release → apks/ + jsons/ → git push → GitHub ◀── Worker ◀── приложение (OTA_URL)
```

```text
apks/Yougram-v1.4.4-b1.apk       сборка (или .zip с APK внутри)
jsons/Update-v1.4.4-b1.json      описание (версия, заметки, размер, sha256)
banners/Banner-v1.4.4-b1.png     необязательно, 1000×400
docs/index.html                  сайт для скачивания (GitHub Pages / Cloudflare Pages)
```

Версия: `X.Y.Z-bN` — бета, `X.Y.Z-r` (или `X.Y.Z`) — стабильный релиз. Другие форматы воркер пропускает.
Старые версии остаются в папках навсегда; клиентам по OTA отдаётся самая новая версия канала.

> **Ограничения.** Репозиторий должен быть **публичным**. GitHub не принимает файлы больше 100 МБ
> (через сайт — больше 25 МБ), поэтому APK надо пушить через git/GitHub Desktop.
>
> **ZIP.** Если APK больше 95 МБ, `add-release` сам кладёт в `apks/` ZIP с одним APK внутри (`Yougram-v….zip`),
> а в JSON пишет `zip`, `zipSize`, `zipSha256`. Приложение скачивает архив, проверяет его и распаковывает APK
> само (нужна обновлённая папка `ota/` из `Yougram-app-ota-zip.zip`). Принудительно: `--zip`, отключить: `--no-zip`.
> Учтите: APK уже сжат, поэтому ZIP даёт выигрыш только если внутри есть несжатые части
> (например, нативные библиотеки или ресурсы без сжатия). Скрипт покажет размер до и после; если и ZIP больше
> 100 МБ, остаются GitHub Releases (лимит 2 ГБ на файл).

## 1. Репозиторий

Создайте публичный репозиторий `Yougram-ota` на GitHub и залейте проект:

```powershell
cd C:\dev\Yougram-ota
git init -b main
git add .
git commit -m "Yougram OTA"
git remote add origin https://github.com/julfy-0/Yougram-ota.git
git push -u origin main
```

Если имя пользователя или репозитория другие — поправьте `OWNER` / `REPO` вверху `worker.js`.

## 2. Воркер через сайт Cloudflare (без установки чего-либо)

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Compute → Workers & Pages → Create application → Hello World**.
2. Имя `yougram-ota` → **Deploy** → **Edit code**.
3. Удалите весь код, вставьте содержимое `worker.js` из этого репозитория → **Deploy**.
4. Откройте адрес воркера `https://yougram-ota.<поддомен>.workers.dev/v1/health` — должно быть
   `{"ok":true,"service":"yougram-ota","storage":"github"}`.

R2 и привязки (bindings) **не нужны**.

*Вариант через консоль:* `npx wrangler login` → `npx wrangler deploy`.
*Автодеплой:* секреты `CLOUDFLARE_API_TOKEN` (шаблон «Edit Cloudflare Workers») и `CLOUDFLARE_ACCOUNT_ID` в
Settings → Secrets → Actions; `deploy.yml` выкатывает воркер при изменении `worker.js` / `wrangler.toml`.

## 3. Приложение

В `local.properties` проекта Yougram (строку `UPDATE_URL=…` можно удалить):

```properties
OTA_URL=https://yougram-ota.<поддомен>.workers.dev
```

Адрес без `/` в конце. Пересоберите приложение.

## 4. Выпуск версии

### Скриптом (нужны Node 18+, git, Android SDK)

1. В `app/build.gradle.kts` поднимите `appVersion` (`1.4.4-b2`) и `versionCode`, соберите APK **тем же ключом `yougram.jks`**.
2. Создайте `notes.txt` — «что нового», по пункту на строку.
3. Один раз: `setx YOUGRAM_APP_DIR "C:\dev\Yougram"` (потом откройте новое окно PowerShell).
4. Запустите:

```powershell
.\tools\release.ps1                  # возьмёт свежий APK, спросит подтверждение, запушит
.\tools\release.ps1 -DryRun          # ничего не записывает
.\tools\release.ps1 -Rollout 10      # ~10% устройств; потом тот же APK с -Rollout 100
.\tools\release.ps1 -NoPush          # только записать файлы, git сделаете сами
.\tools\release.ps1 -Banner banner.png -Notes "- Исправления" -Yes
```

Без PowerShell: `node tools/add-release.mjs app.apk --notes notes.txt --push`.
Если aapt2 не находится — укажите `ANDROID_HOME` или `--version-name 1.4.4-b2 --version-code 42`.

Скрипт считает размер и sha256, кладёт файлы и пушит **в два шага: сначала APK, потом JSON** — пока JSON не
опубликован, сервер версию не предлагает.

### Вручную

1. Положите APK как `apks/Yougram-v1.4.4-b2.apk`, запушьте.
2. Создайте `jsons/Update-v1.4.4-b2.json` и запушьте **после** APK:

```json
{
  "versionName": "1.4.4",
  "versionCode": 42,
  "beta": 2,
  "notes": "- Новый экран обновлений\n- Исправления",
  "size": 123456789,
  "sha256": "хэш в нижнем регистре",
  "banner": false,
  "rollout": 100
}
```

`versionName` — без суффикса; для стабильной версии `beta` = 0. `banner: true` — только если есть `banners/Banner-v….png`.

```powershell
(Get-Item .\apks\Yougram-v1.4.4-b2.apk).Length
(Get-FileHash .\apks\Yougram-v1.4.4-b2.apk -Algorithm SHA256).Hash.ToLower()
```

Через 2–5 минут (кэш GitHub и воркера) проверьте:
`https://yougram-ota.<поддомен>.workers.dev/v1/check?channel=beta&code=1`

## 5. Переход со старой системы (один раз)

Уже установленные сборки ходят за обновлениями на GitHub. Первую сборку с `OTA_URL` выложите по-старому:
GitHub Release приложения + `update-beta.json` (и `update.json`) в репозитории `Yougram` с новыми `versionCode`/`apkUrl`.
Пользователи поставят её, и дальше обновления идут только отсюда.

## 6. Сайт для скачивания (папка `docs/`)

Статический сайт без сборки: карточка последней версии (переключатель «Стабильная / Бета», заметки, размер,
sha256, кнопка «Скачать») и под ней кнопка «Старые версии» со списком всех прежних сборок.
Данные он берёт прямо из `jsons/` этого репозитория, поэтому после выпуска версии сайт обновляется сам.

Настройки — вверху скрипта в `docs/index.html` (`OWNER`, `REPO`, `BRANCH`).

**GitHub Pages:** Settings → Pages → Source: *Deploy from a branch* → ветка `main`, папка `/docs`.
Сайт будет по адресу `https://<логин>.github.io/Yougram-ota/`.

**Cloudflare Pages:** Workers & Pages → Create application → Pages → Connect to Git → выберите репозиторий →
*Build command* пусто, *Build output directory* `docs` → Save and Deploy.

## Откат

Удалите `jsons/Update-v<последняя>.json` — воркер возьмёт предыдущую версию. Если она уже установлена у
пользователей, ничего не произойдёт; чтобы «откатить» их, опубликуйте старый APK как новую версию с большим `versionCode`.

## Если что-то не работает

| Симптом | Причина / решение |
|---|---|
| `/v1/check` всегда `{"update":false}` | `versionCode` не больше установленного; другой канал; rollout < 100; неверный формат имени; ещё не прошёл кэш |
| `/v1/check` → `{"error":"internal"}` | исчерпан лимит GitHub API (60/ч): добавьте секрет `GITHUB_TOKEN` воркеру |
| в приложении «сервер обновлений не настроен» | пустой/не-https `OTA_URL`; пересоберите приложение |
| «не совпадает sha256» | в JSON хэш другого файла или с заглавными буквами |
| «APK подписан другим ключом» | собрано другим keystore, чем установленная версия |
| `/v1/apk/…` → 404 | APK не запушен или имя не `Yougram-v<версия>.apk` |
