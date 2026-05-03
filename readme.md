# TeleCloud Frontend Assets

This repository contains the source code for the [TeleCloud](https://github.com/dabeecao/telecloud-go) web interface.

## 📁 Repository Structure
- `templates/`: Go HTML templates.
- `static/`: Frontend assets (CSS, JS, Fonts).
- `static/locales/`: JSON translation files.
- `build-frontend.sh/bat`: Build scripts for minification and bundling.
- `tailwind.config.js`: Tailwind CSS configuration.

## 🌍 Contributing Translations (Localization)

### English
If you would like to contribute a new language or improve an existing translation, please follow these steps:

1.  **Locate translation files**: Language files are located in the `static/locales/` directory in JSON format (e.g., `en.json`, `vi.json`).
2.  **Add a new language**:
    *   Create a new JSON file with the ISO language code (e.g., `fr.json` for French).
    *   Copy the content from `en.json` and translate the values into your language.
    *   Open `static/js/common.js` and add the new language to the `availableLangs` array:
        ```javascript
        { code: 'fr', name: 'Français', flag: '🇫🇷' }
        ```
3.  **Submit a Pull Request**: Once finished, submit a Pull Request (PR) to this repository.

### Tiếng Việt
Nếu bạn muốn đóng góp bản dịch cho một ngôn ngữ mới hoặc cải thiện bản dịch hiện có, hãy làm theo các bước sau:

1.  **Tìm tệp bản dịch**: Các tệp ngôn ngữ nằm trong thư mục `static/locales/` dưới định dạng JSON (ví dụ: `vi.json`, `en.json`).
2.  **Thêm ngôn ngữ mới**:
    *   Tạo một tệp JSON mới với mã ngôn ngữ ISO (ví dụ: `fr.json` cho tiếng Pháp).
    *   Sao chép nội dung từ `en.json` và dịch các giá trị sang ngôn ngữ của bạn.
    *   Mở tệp `static/js/common.js` và thêm ngôn ngữ mới vào mảng `availableLangs`:
        ```javascript
        { code: 'fr', name: 'Français', flag: '🇫🇷' }
        ```
3.  **Gửi Pull Request**: Sau khi hoàn tất, hãy gửi một Pull Request (PR) vào repository này.

## 🛠️ Build Process
The main TeleCloud repository integrates this as a git submodule. During the build process (Docker or GitHub Actions), the following steps are performed:
1. Fetch this submodule into the `web/` directory.
2. Run `build-frontend.sh` to generate minified assets (`*.min.js`, `*.min.css`).
3. Compile the Go binary with embedded assets.

### Local Development
To manually build the frontend assets:
1. Ensure you have **Node.js** and **npm** installed.
2. Ensure your local branch is up to date with `origin/main`.
3. Run:
   - **Linux/macOS:**
     ```bash
     chmod +x build-frontend.sh
     ./build-frontend.sh
     ```
   - **Windows:**
     ```bat
     build-frontend.bat
     ```

## ⚠️ Note
Minified files are ignored by git to keep the repository clean. They are generated only during the build process.

---
Developed by [@dabeecao](https://github.com/dabeecao)
