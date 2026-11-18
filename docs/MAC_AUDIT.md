# گزارش بررسی ایستای Pulse Download Manager v1.0.20 — تمرکز بر macOS

**مرجع:** https://github.com/TheGreatAzizi/Pulse-Download-Manager/tree/v1.0.20  
**Commit:** `2b03c06ffe0a35f0e84f1f740fc149e5ec747363`  
**روش:** بررسی مستقیم فایل‌های موجود در tag مشخص‌شده، پیکربندی CI/Build و انتشار v1.0.20. **این گزارش جایگزین اجرای برنامه روی Mac M1، تست نفوذ یا تست عملکرد نیست.** «قطعی» به معنای وجود مشکل/فقدان پیاده‌سازی در سورس است، نه لزوماً بهره‌برداری عملی.

| # | شدت | وضعیت | ایراد/ریسک و شاهد | اقدام توسعه | خط در نسخهٔ مبنا | روش بررسی یا آزمون |
|---|---|---|---|---|---|---|
| 01 | P0 | قطعی | هیچ target و script ساخت macOS در `package.json` وجود ندارد؛ فقط `dist:win`, `dist:linux`. | افزودن build arm64، .app و DMG | `package.json:15` | بررسی scripts |
| 02 | P0 | قطعی | `.github/workflows/release.yml` فقط jobهای Windows/Linux دارد؛ در Release v1.0.20 فایل Mac دیده نمی‌شود. | افزودن CI macOS و artifact validation | `.github/workflows/release.yml:9` | بازکردن workflow انتشار |
| 03 | P0 | قطعی | `src/main/store.ts`، تابع `load`: هر خطای خواندن/تجزیه با taskهای خالی جایگزین می‌شود؛ تمایز فایل ناموجود با خراب وجود ندارد. | backup، quarantine، migration، recovery | `src/main/store.ts:54` | خراب‌کردن یک کپی از JSON و راه‌اندازی مجدد |
| 04 | P0 | قطعی | `src/main/engines/http.ts`، حدود خطوط 236–250: صرف وجود فایل نهایی بدون `.pulse-part` می‌تواند completed ثبت کند، بدون اعتبارسنجی محتوای اصلی. | validation فایل/metadata قبل از complete | `src/main/engines/http.ts:236` | راه‌اندازی مجدد با فایل نهایی هم‌نام |
| 05 | P1 | قطعی | `src/main/updater.ts` حدود 112–159: آبجکت `UpdateInfo` شامل URL، نام asset و canInstall از IPC/renderer پذیرفته می‌شود، download محدود به HTTPS است، checksum و منشأ دقیق enforce نمی‌شود؛ همچنین از نام asset برای مسیر محلی استفاده می‌شود. | Main-owned update discovery، allowlist، hash، safe basename، no arbitrary execution | `src/main/updater.ts:112` | بازبینی قرارداد ورودی آپدیتر |
| 06 | P1 | قطعی | `src/main/index.ts` خط 96: renderer با `sandbox:false` اجرا می‌شود. | sandbox:true و preload bridge محدود | `src/main/index.ts:96` | بررسی تنظیمات پنجره |
| 07 | P1 | قطعی | `src/main/store.ts` تنظیمات را از جمله `githubToken` در `pulse-state.json` JSON ساده ذخیره می‌کند؛ `src/main/ipc.ts` settings را در snapshot می‌فرستد. | Keychain، عدم exposure توکن | `src/main/store.ts:36، src/main/ipc.ts:35` | بازبینی snapshot و snapshot روی دیسک |
| 08 | P1 | قطعی | `src/main/autostart.ts` فقط Windows و Linux را پشتیبانی می‌کند؛ Login Item مک فعلاً غیرفعال است. | macOS launch-at-login opt-in | `src/main/autostart.ts:12` | بررسی Login Item روی مک |
| 09 | P1 | قطعی | `src/main/updater.ts`، `pickAsset` برای darwin `null` برمی‌گرداند و `canInstall` فقط ویندوز است. | مسیر به‌روزرسانی مستقل و امن مک | `src/main/updater.ts:42` | بررسی انتخاب asset مک |
| 10 | P1 | قطعی | `src/main/engines/youtube.ts` حدود 695–711 فایل `yt-dlp` عمومی را روی مک نصب می‌کند. فایل رسمی مستقل توصیه‌شده `yt-dlp_macos` است؛ نسخه عمومی به Python وابسته است. | macOS standalone، hash/امضا، نصب امن | `src/main/engines/youtube.ts:698` | اجرای نصب در پروفایل تمیز |
| 11 | P1 | قطعی | `src/main/engines/youtube.ts` دانلود binary را با `arrayBuffer()` به‌صورت کامل در حافظه می‌گیرد و صرفاً حجم بیش از یک مگابایت را بررسی می‌کند. | streaming و checksum/امضا | `src/main/engines/youtube.ts:704` | مقایسه فایل ناقص با checksum رسمی |
| 12 | P1 | قطعی | `src/main/engines/http.ts` در segment downloader به پاسخ 206 و Content-Range دقیق و هویت فایل در هر بخش اعتبارسنجی کامل نمی‌دهد؛ نوشتن با offset صورت می‌گیرد. | Content-Range/If-Range/ETag validation | `src/main/engines/http.ts:401` | پاسخ Range اشتباه در fixture |
| 13 | P1 | قطعی | `src/main/engines/http.ts` تابع `persist` از چند مسیر async فراخوانی می‌شود و خطای write swallowed است؛ serialization/atomic temp rename وجود ندارد. | صف نوشتن، atomic sidecar، flush | `src/main/engines/http.ts:370` | توقف حین نوشتن چند قطعه |
| 14 | P1 | قطعی | `src/main/manager.ts` حدود 498–513: `controllers.delete(id)` پیش از انتظار برای خاتمهٔ دانلود در حال اجرا صورت می‌گیرد؛ مسیر remove و deleteFiles ممکن است با write رقابت کند. | await engine shutdown قبل از delete | `src/main/manager.ts:498` | حذف هنگام دانلود فعال |
| 15 | P1 | قطعی | `src/main/manager.ts` حدود 516–543: کنترل path صرفاً lexically با `relative` است و `fs.rm(..., {recursive:true})` دارد؛ symlink و canonical path به‌طور کامل بررسی نمی‌شوند. | containment canonical و حذف فقط فایل مجاز | `src/main/manager.ts:515` | بررسی لینک نمادین در fixture موقت |
| 16 | P1 | قطعی | `src/main/manager.ts` خط 185 پروتکل FTP را مجاز می‌داند، ولی اجرای عادی به HTTP engine و Node fetch می‌رود. | reject شفاف یا FTP engine واقعی | `src/main/manager.ts:185` | ارسال URL با FTP |
| 17 | P1 | قطعی | فیلد `proxy` در `src/shared/types.ts` و `src/main/store.ts` وجود دارد، ولی در موتور HTTP/GitHub/YouTube اعمال نشده است. | پیاده‌سازی proxy واقعی و تست | `src/shared/types.ts:43` | تنظیم proxy آزمایشی |
| 18 | P1 | قطعی | `src/main/store.ts` در `flush` اگر نوشتن قبلی جریان داشته باشد بی‌درنگ برمی‌گردد؛ shutdown در `manager.ts` و app.exit در `index.ts` ممکن است پیش از نوشته‌شدن آخرین تغییرات پایان یابد. | flush قابل await و shutdown durable | `src/main/store.ts:97` | خروج هنگام ذخیره فعال |
| 19 | P1 | ریسک نیازمند تست | `resumeWithUrl` در `http.ts` با برابر بودن اندازهٔ فایل و Range قابل نگهداری، دادهٔ پیشین را می‌پذیرد؛ URL جدید با محتوای متفاوت ولی اندازهٔ یکسان می‌تواند دادهٔ ترکیبی تولید کند. | identity validation یا restart امن | `src/main/engines/http.ts:178` | تعویض محتوای هم‌اندازه |
| 20 | P1 | ریسک نیازمند تست | `uniquePath` فقط مسیر نهایی موجود را بررسی می‌کند، نه رزرو اتمیک sidecarهای فعال؛ دو task همنام ممکن است تداخل پیدا کنند. | reservation task-specific و race tests | `src/main/util.ts:104` | دو دانلود هم‌نام در یک پوشه |
| 21 | P2 | قطعی | `src/main/index.ts` با `frame:false` و `src/renderer/src/components/TitleBar.tsx` دکمه‌های ویندوزی رسم می‌کند. | traffic lights و native titlebar | `src/main/index.ts:87` | بازکردن پنجره روی مک |
| 22 | P2 | قطعی | `src/main/index.ts`: `Menu.setApplicationMenu(null)` منوی استاندارد macOS و shortcutهای Preferences/Quit را حذف می‌کند. | macOS App/Edit/Window menu | `src/main/index.ts:228` | زدن Cmd+, |
| 23 | P2 | قطعی | `src/main/index.ts`: Tray icon با PNG resize 24×24 ساخته می‌شود؛ template image مناسب منوبار macOS نیست. | template icon مناسب light/dark | `src/main/index.ts:192` | بررسی حالت روشن و تیره |
| 24 | P2 | قطعی | در `SettingsModal.tsx` browser cookie selector برای Chrome/Firefox/Edge/... وجود دارد ولی Safari گزینه ندارد. | Safari با رضایت صریح و fallback file | `src/renderer/src/components/SettingsModal.tsx:468` | بازکردن انتخاب‌گر کوکی |
| 25 | P2 | قطعی | `src/main/store.ts` مقدار پیش‌فرض User-Agent تقلید از Windows/Chrome 131 است، حتی روی Mac. | UA متناسب و قابل انتخاب امن | `src/main/store.ts:13` | بررسی User-Agent سرور آزمایشی |
| 26 | P2 | قطعی | `src/renderer/index.html` سیاست CSP شامل `script-src 'unsafe-inline'` است. | CSP سختگیرانه در production | `src/renderer/index.html:7` | بررسی policy بسته تولید |
| 27 | P2 | قطعی | `src/main/index.ts` `backgroundThrottling:false`، clipboard watcher 1.6 ثانیه‌ای دارد؛ مصرف منابع پس‌زمینه باید روی M1 اندازه‌گیری شود. | event-driven/opt-in و benchmark | `src/main/index.ts:99` | اندازه‌گیری idle روی M1 |
| 28 | P2 | قطعی | `package.json` تست/lint script ندارد و در درخت v1.0.20 پوشهٔ آزمون اختصاصی دیده نشد. | unit/integration/e2e tests | `package.json:9` | اجرای اسکریپت‌ها از checkout تازه |
| 29 | P2 | قطعی | GitHub issue #9 درخواست browser extension است؛ در درخت نسخهٔ مورد بررسی افزونهٔ Safari وجود ندارد. | فاز اختیاری Safari extension | `src/preload/index.ts:1` | بررسی فایل‌های فورک |
| 30 | P2 | ریسک نیازمند تست | `WebTorrent`، `ffmpeg`، باینری‌های جانبی و مسیرهای filesystem در `.app` بسته‌بندی‌شدهٔ arm64 هنوز نیازمند تست عملی هستند. | Package + ARM smoke test | `package.json:38` | آزمون smoke روی مک ARM |

## مرزبندی مهم

- یافته‌های «قطعی» از خواندن سورس و نبود/وجود کد به‌دست آمده‌اند؛ شدت‌ها اولویت **برای ساخت نسخهٔ اختصاصی Mac** هستند.
- ریسک‌های مربوط به دادهٔ خراب، امنیت IPC و رقابت عملیات باید با test harness و شواهد عملی اعتبارسنجی شوند؛ ادعای اثبات exploitation در این گزارش مطرح نیست.
- نقاط مثبت را نیز حفظ کنید: `contextIsolation:true`، `nodeIntegration:false`، فایل‌های part/meta، پشتیبانی چند موتور، امکان تغییر URL دانلود و جداسازی Main/Preload/Renderer.

## لینک‌های شواهد

- [package.json](https://github.com/TheGreatAzizi/Pulse-Download-Manager/blob/v1.0.20/package.json)
- [release.yml](https://github.com/TheGreatAzizi/Pulse-Download-Manager/blob/v1.0.20/.github/workflows/release.yml)
- [src/main/index.ts](https://github.com/TheGreatAzizi/Pulse-Download-Manager/blob/v1.0.20/src/main/index.ts)
- [src/main/store.ts](https://github.com/TheGreatAzizi/Pulse-Download-Manager/blob/v1.0.20/src/main/store.ts)
- [src/main/manager.ts](https://github.com/TheGreatAzizi/Pulse-Download-Manager/blob/v1.0.20/src/main/manager.ts)
- [src/main/updater.ts](https://github.com/TheGreatAzizi/Pulse-Download-Manager/blob/v1.0.20/src/main/updater.ts)
- [src/main/engines/http.ts](https://github.com/TheGreatAzizi/Pulse-Download-Manager/blob/v1.0.20/src/main/engines/http.ts)
- [src/main/engines/youtube.ts](https://github.com/TheGreatAzizi/Pulse-Download-Manager/blob/v1.0.20/src/main/engines/youtube.ts)
- [src/renderer/index.html](https://github.com/TheGreatAzizi/Pulse-Download-Manager/blob/v1.0.20/src/renderer/index.html)
- [yt-dlp official installation assets](https://github.com/yt-dlp/yt-dlp#release-files)
- [Apple notarization guide](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)

## وضعیت Git پیش از تغییر

درخت کار تمیز بود و tag به commit بالا resolve شد. شاخهٔ محلی `mac-personal` از همان commit ایجاد شد. این جدول وضعیت مبنا را ثبت می‌کند. نتایج اجرای فورک در MAC_TEST_REPORT آمده‌اند.
