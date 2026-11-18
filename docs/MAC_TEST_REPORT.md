# گزارش آزمون Pulse Mac 1.0.20-mac.1

محیط اجرا در ۲۰۲۶-۱۱-۱۸، Debian Linux x86_64 با Node.js 24.22.1 و npm 11.9.0. مرجع upstream در [ممیزی](MAC_AUDIT.md) ثبت شده است. آزمون‌های HTTP و تورنت از دادهٔ تولیدشدهٔ محلی استفاده کردند.

| بررسی | نتیجه | شاهد یا علت |
|---|---|---|
| `npm ci` | PASS · 0 | نصب از lockfile |
| `npm run typecheck` | PASS · 0 | Main، preload و renderer |
| `npm run lint` | PASS · 0 | ESLint و git diff --check |
| `npm test` | PASS · 0 | ۲۶ موفق، ۰ ناموفق، ۰ ردشده در این محیط |
| `npm run build:mac` | PASS · 0 | تولید Main، preload و renderer در `out/` |
| `bash scripts/cross-app-linux.sh` | PASS · 0 | ساخت باندل ARM64 و بررسی فایل اجرایی و ده کتابخانهٔ بومی با `file` |
| دریافت مستقل yt-dlp و بررسی SHA‑256 | PASS · 0 | asset رسمی Universal، شامل arm64، با اندازه و hash نسخهٔ pin‌شده |
| `npm audit --json` | FAIL · 1 | گزارش ۴ High و ۶ Moderate. دامنه و بررسی زنجیره‌ها در [یادداشت امنیت](SECURITY_NOTES.md) |
| `npm run dist:mac:arm64` | SKIP · 1 | مرحلهٔ تولید DMG و امضا روی لینوکس در اسکریپت متوقف می‌شود |
| `bash scripts/verify-mac.sh` و اجرای package smoke | SKIP | به macOS ARM، lipo، codesign و hdiutil نیاز دارد. Workflow تعریف شده است |
| آزمون‌های GUI، VoiceOver، Dock، Notification Center، Login Item و Keychain | SKIP | در این محیط به مک دسترسی نبود |
| آزمون ویدئو، FFmpeg، Safari و جلسهٔ تورنت داخل باندل روی M1 | SKIP | WebTorrent روی localhost لینوکس و معماری افزونه‌ها جداگانه بررسی شدند |
| آزمون Sleep/Wake واقعی، تغییر شبکهٔ مک، جدا شدن حافظهٔ خارجی و بنچمارک M1 | SKIP | مک و دستگاه آزمون در دسترس نبود |
| انتقال کامل فایل واقعی ۱، ۴ یا ۱۰ GB و آزمایش حجم فیزیکی پر | SKIP | fixture sparse تنها درخواست Range و نوشتن sparse در موقعیت بالاتر از ۴ GiB را پوشش می‌دهد |

## شواهد تست‌های خودکار

- HTTP با Range معتبر و If-Range، redirect، Range خراب، نادیده گرفته شدن Range، HTTP 416، HTTP 401/403، طول مجهول، قطع socket، تغییر ETag برای محتوای هم‌اندازه، hash نادرست و دانلود چندبخشی پوشش داده شد.
- فرایند دانلود با SIGKILL پس از checkpoint دارای پیشرفت متوقف شد. موتور از روی همان checkpoint بازه‌های باقی‌مانده را درخواست کرد و SHA‑256 فایل نهایی با دادهٔ مرجع یکسان بود.
- پایان دانلود همزمان با نام تکراری، حفظ فایل هم‌نام و symlink، حذف فایل HTTP مالکیت‌یافته، نام فارسی، throttle مشترک HTTP و بازیابی انتشار ثبت‌شده پوشش دارند.
- ذخیرهٔ همزمان، نسخهٔ پشتیبان، مهاجرت تکراری و خرابی بدون backup با فایل‌های موقت آزموده شدند. آزمون ابطال یا مهاجرت Keychain روی مک باقی مانده است.
- اعتبارسنجی IPC در سطح schema، برخورد مسیر تورنت و انتقال WebTorrent روی localhost پوشش داده شد. fixture localhost اتصال DHT عمومی، resume تورنت داخل برنامه و عملکرد tracker را نمی‌سنجد.

```text
dist/mac-arm64/Pulse Mac.app/Contents/MacOS/Pulse Mac: Mach-O 64-bit arm64 executable, flags:<NOUNDEFS|DYLDLINK|TWOLEVEL|PIE>
```

باندل فوق تولید متقاطع از لینوکس، بدون امضای برنامه و بدون DMG است. برای نصب شخصی روی M1، اجرای [دستورات ساخت مک](../README_MAC_FA.md) روی خود مک مسیر تأییدپذیر است. محدودیت موتورهای انتقال و بازیابی در [معماری](MAC_ARCHITECTURE.md) ثبت شده‌اند.

## فایل‌های تغییرکرده نسبت به v1.0.20

```text
D	.github/workflows/debug.yml
M	.github/workflows/release.yml
A	.nvmrc
A	NOTICE
M	README.md
A	README_MAC_FA.md
A	docs/MAC_ARCHITECTURE.md
A	docs/MAC_AUDIT.md
A	docs/MAC_TEST_REPORT.md
A	docs/SECURITY_NOTES.md
M	electron.vite.config.ts
A	eslint.config.mjs
M	package-lock.json
M	package.json
A	resources/icon.icns
A	resources/menubarTemplate.png
A	resources/menubarTemplate@2x.png
A	scripts/cross-app-linux.sh
A	scripts/dist-mac.mjs
A	scripts/prune-native.cjs
A	scripts/verify-mac.sh
M	src/main/autostart.ts
A	src/main/credentials.ts
A	src/main/durable-file.ts
A	src/main/engines/http-network.ts
M	src/main/engines/http.ts
A	src/main/engines/torrent-path.ts
M	src/main/engines/torrent.ts
M	src/main/engines/youtube.ts
A	src/main/engines/ytdlp-release.ts
M	src/main/index.ts
M	src/main/ipc.ts
M	src/main/manager.ts
A	src/main/state-file.ts
M	src/main/store.ts
D	src/main/updater.ts
M	src/main/util.ts
A	src/main/validate.ts
M	src/main/webtorrent.d.ts
M	src/preload/index.ts
M	src/renderer/index.html
M	src/renderer/src/App.tsx
M	src/renderer/src/components/AddDownloadModal.tsx
M	src/renderer/src/components/DetailPanel.tsx
M	src/renderer/src/components/GithubBrowser.tsx
M	src/renderer/src/components/SettingsModal.tsx
M	src/renderer/src/components/Sidebar.tsx
D	src/renderer/src/components/TitleBar.tsx
D	src/renderer/src/components/UpdateModal.tsx
M	src/renderer/src/i18n.ts
M	src/renderer/src/state.tsx
M	src/renderer/src/styles.css
M	src/shared/ipc.ts
M	src/shared/types.ts
A	tests/fixtures/download-worker.ts
A	tests/http.test.ts
A	tests/state.test.ts
A	tests/torrent.test.ts
A	tests/urls.test.ts
```
