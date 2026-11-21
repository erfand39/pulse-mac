# Contributing to Pulse Mac

Thanks for helping improve Pulse Mac, a local-first download manager for Apple Silicon Macs. Focused bug reports, tested fixes and accessible interface improvements are welcome.

## Before you open a pull request

- Search open Issues and PRs to avoid duplicate work.
- For a new issue, include the macOS version, Apple Silicon model, app version, exact steps, expected result and actual result.
- Use **redacted** logs or screenshots: download URLs can contain tokens; never expose private links, API keys, credentials or file paths containing personal information.
- Keep PRs scoped to one issue and explain how to reproduce the problem.
- Use descriptive branches such as `fix/download-resume`, `feat/queue-controls`, or `docs/install-guide`.

## Local development

Requirements: **macOS 13 or newer on Apple Silicon**, and **Node.js 24.22.1** (see `.nvmrc`). Use the checked-in npm lockfile:

```bash
npm ci
npm run dev:mac
```

Before submitting a change, run:

```bash
npm run typecheck
npm run lint
npm test
npm run build:mac
```

To validate an ARM64 distributable on the supported macOS platform:

```bash
npm run dist:mac:arm64
bash scripts/verify-mac.sh
```

The existing **Pulse Mac ARM64** GitHub Actions workflow also runs type checking, linting, tests, packaging and a smoke check for pull requests. A green workflow is expected before merging code changes.

## Quality and safety checklist

- **Resume integrity:** Never overwrite already-completed chunks when a server ignores or changes Range requests.
- **Downloads:** Verify retries, cancellation, disk space errors, path handling and duplicate jobs.
- **Privacy:** Avoid leaking tokens or file paths into logs, screenshots, telemetry, issue reports or URLs.
- **macOS:** Check menu bar behavior, notifications, Apple Silicon packaging and light/dark themes.
- **Localization:** Ensure Persian/RTL text and numerals stay readable.
- **Licensing:** Respect `GPL-3.0-or-later`, existing notices and third-party license obligations.

Use the PR template and provide actual test outcomes; do not check off validation steps that have not run.

---

## مشارکت فارسی

برای گزارش خطا، نسخهٔ macOS، مدل مک، نسخهٔ برنامه، مراحل دقیق بازتولید و خروجی مورد انتظار را بنویسید. لینک‌های دانلود خصوصی، توکن‌ها، نام فایل‌های حساس یا اطلاعات شخصی را از گزارش‌ها و تصاویر حذف کنید.

پیش از Pull Request، دستورات `npm run typecheck`، `npm run lint`، `npm test` و `npm run build:mac` را اجرا کنید. پس از تأیید بررسی‌ها و بازبینی تغییر، PR را ادغام کنید؛ نه صرفاً برای دریافت Achievement.
