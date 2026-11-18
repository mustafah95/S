Sofia's Resto-Lounge - Linux / cloud server (Docker)        خادم Linux أو سحابي
=========================================================================

Optional alternative to the Windows server (folder 1). Requires Docker with the Compose plugin and internet access
during the first build.

  unzip sofia-{VERSION}-source.zip -d sofia && cd sofia/deploy
  ./generate-env.sh > .env && chmod 600 .env
  # edit .env: SOFIA_SITE_ADDRESS=book.example.com  SOFIA_PUBLIC_URL=https://book.example.com  SOFIA_ACME_EMAIL=...
  docker compose up -d --build
  grep SOFIA_SETUP_TOKEN .env        # token for the first-run setup wizard

PostgreSQL stays on an internal Docker network (never published). Caddy obtains the HTTPS certificate
automatically when the domain points to the server and ports 80/443 are open. Full guide: docs/OPERATIONS.md
inside the source archive.

sofia-{VERSION}.tar.gz is the release package used by the Update Center and the installers (signed separately).

بالعربية: بديل اختياري لخادم Windows. يتطلب Docker. فك ضغط ملف المصدر، ثم في مجلد deploy نفّذ الأوامر أعلاه،
ثم افتح عنوان النطاق وأكمل معالج الإعداد برمز SOFIA_SETUP_TOKEN الموجود في ملف .env.

Note: the Docker image has not been built in the development environment yet (no Docker available there).
