# TeleCloud Frontend Assets

This repository contains the source code for the TeleCloud web interface.

## 📁 Repository Structure
- `templates/`: Go HTML templates.
- `static/`: Frontend assets (CSS, JS, Fonts).
- `build-frontend.sh/bat`: Build scripts for minification and bundling.
- `tailwind.config.js`: Tailwind CSS configuration.

## 🛠️ Build Process
The main TeleCloud repository integrates this as a git submodule. During the build process (Docker or GitHub Actions), the following steps are performed:
1. Fetch this submodule into the `web/` directory.
2. Run `build-frontend.sh` to generate minified assets (`*.min.js`, `*.min.css`).
3. Compile the Go binary with embedded assets.

### Local Development
To manually build the frontend assets:
1. Ensure you have **Node.js** and **npm** installed.
2. Download the **Tailwind CLI** binary for your OS and place it in this directory.
3. Run:
   ```bash
   chmod +x build-frontend.sh
   ./build-frontend.sh
   ```

## ⚠️ Note
Minified files are ignored by git to keep the repository clean. They are generated only during the build process.

---
Developed by [@dabeecao](https://github.com/dabeecao)
