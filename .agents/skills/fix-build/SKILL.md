---
name: fix-build
description: Fix electron-vite build failures by reading the errors, patching the failing files, and rerunning the build. Use when the user explicitly asks to fix a build failure.
---

# Fix build

When the electron-vite build fails, read the error output, identify the failing file(s), and fix the issue. Run `npx electron-vite build` again to verify.
