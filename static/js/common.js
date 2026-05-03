/**
 * TeleCloud Common Utilities & I18n
 */

const TeleCloud = {
    version: window.TELECLOUD_VERSION || 'dev',
    availableLangs: [
        { code: 'vi', name: 'Tiếng Việt', flag: '🇻🇳' },
        { code: 'en', name: 'English', flag: '🇬🇧' },
        { code: 'km', name: 'Khmer', flag: '🇰🇭' },
        { code: 'ar', name: 'العربية', flag: '🇸🇦' },
        { code: 'hi', name: 'हिन्दी', flag: '🇮🇳' },
        { code: 'ru', name: 'Русский', flag: '🇷🇺' },
        { code: 'zh', name: '简体中文', flag: '🇨🇳' },
        { code: 'ja', name: '日本語', flag: '🇯🇵' }
    ],
    lang: localStorage.getItem('lang') || (function () {
        const browserLang = navigator.language.split('-')[0];
        const supported = ['vi', 'en', 'km', 'ar', 'hi', 'ru', 'zh', 'ja'];
        return supported.includes(browserLang) ? browserLang : 'en';
    })(),
    translations: {},

    async loadTranslations(lang) {
        if (this.translations[lang]) return;
        try {
            const response = await fetch(`/static/locales/${lang}.min.json?v=${this.version}`);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            this.translations[lang] = await response.json();
            window.dispatchEvent(new CustomEvent('tc-translations-loaded', { detail: { lang } }));
        } catch (e) {
            console.error('Failed to load translations for', lang, e);
        }
    },

    t(key, params = {}, lang = this.lang) {
        let text = (this.translations[lang] && this.translations[lang][key]) || key;
        Object.keys(params).forEach(p => {
            text = text.replace(`{${p}}`, params[p]);
        });
        return text;
    },

    async toggleLang() {
        const currentIndex = this.availableLangs.findIndex(l => l.code === this.lang);
        const nextIndex = (currentIndex + 1) % this.availableLangs.length;
        return await this.setLang(this.availableLangs[nextIndex].code);
    },

    async setLang(l) {
        this.lang = l;
        localStorage.setItem('lang', l);
        await this.loadTranslations(l);
        return l;
    },

    formatBytes(bytes, decimals = 2) {
        if (!+bytes) return '0 B';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    },

    formatDate(dateStr, lang = this.lang) {
        if (!dateStr) return '--';
        let d;
        if (dateStr.includes('T')) {
            d = new Date(dateStr);
        } else {
            const safeString = dateStr.replace(' ', 'T') + 'Z';
            d = new Date(safeString);
        }
        if (isNaN(d.getTime())) return dateStr;
        const options = { hour: '2-digit', minute: '2-digit' };
        
        const localeMap = {
            'vi': 'vi-VN',
            'en': 'en-US',
            'km': 'km-KH',
            'ar': 'ar-SA',
            'hi': 'hi-IN',
            'ru': 'ru-RU',
            'zh': 'zh-CN',
            'ja': 'ja-JP'
        };
        const locale = localeMap[lang] || 'en-US';
        
        return d.toLocaleDateString(locale) + ' ' + this.t('at_time', {}, lang) + ' ' + d.toLocaleTimeString(locale, options);
    },

    parseMarkdown(text) {
        if (!text) return '';
        // Security: Escape HTML special characters before processing markdown
        const escapedText = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');

        return escapedText
            .replace(/^### (.*$)/gim, '<h3 class="text-base font-bold mt-3 mb-1">$1</h3>')
            .replace(/^## (.*$)/gim, '<h2 class="text-lg font-bold mt-4 mb-2">$1</h2>')
            .replace(/^# (.*$)/gim, '<h1 class="text-xl font-bold mt-5 mb-2">$1</h1>')
            .replace(/^\* (.*$)/gim, '<li class="ml-4 list-disc">$1</li>')
            .replace(/^\- (.*$)/gim, '<li class="ml-4 list-disc">$1</li>')
            .replace(/\*\*(.*)\*\*/gim, '<strong>$1</strong>')
            .replace(/\*(.*)\*/gim, '<em>$1</em>')
            .replace(/`(.*?)`/gim, '<code class="bg-slate-200 dark:bg-slate-800 px-1 rounded font-mono text-xs">$1</code>')
            .replace(/\n/gim, '<br>');
    },

    getFileTypeData(filename) {
        if (!filename) return { n: 'type_unknown', c: 'bg-slate-100 dark:bg-slate-800', i: '<i class="fa-solid fa-file text-2xl"></i>' };
        const ext = filename.split('.').pop().toLowerCase();
        const types = {
            'jpg': { n: 'type_image', c: 'bg-rose-100 text-rose-500 dark:bg-rose-500/20 dark:text-rose-400', i: '<i class="fa-solid fa-image text-2xl"></i>' },
            'jpeg': 'jpg', 'png': 'jpg', 'gif': 'jpg', 'webp': 'jpg', 'svg': 'jpg', 'bmp': 'jpg', 'heic': 'jpg', 'heif': 'jpg',
            'mp4': { n: 'type_video', c: 'bg-purple-100 text-purple-500 dark:bg-purple-500/20 dark:text-purple-400', i: '<i class="fa-solid fa-film text-2xl"></i>' },
            'mov': 'mp4', 'avi': 'mp4', 'mkv': 'mp4', 'webm': 'mp4', 'ogg': 'mp4', 'ogv': 'mp4', '3gp': 'mp4', 'flv': 'mp4', 'wmv': 'mp4',
            'mp3': { n: 'type_audio', c: 'bg-amber-100 text-amber-500 dark:bg-amber-500/20 dark:text-amber-400', i: '<i class="fa-solid fa-music text-2xl"></i>' },
            'wav': 'mp3', 'flac': 'mp3', 'opus': 'mp3', 'm4a': 'mp3', 'oga': 'mp3', 'aac': 'mp3', 'm4b': 'mp3',
            'php': { n: 'type_code', c: 'bg-indigo-100 text-indigo-500 dark:bg-indigo-500/20 dark:text-indigo-400', i: '<i class="fa-solid fa-code text-2xl"></i>' },
            'js': 'php', 'html': 'php', 'css': 'php', 'py': 'php', 'json': 'php', 'sql': 'php', 'c': 'php', 'cpp': 'php', 'h': 'php', 'hpp': 'php', 'cs': 'php', 'java': 'php', 'rb': 'php', 'rs': 'php', 'swift': 'php',
            'zip': { n: 'type_archive', c: 'bg-orange-100 text-orange-500 dark:bg-orange-500/20 dark:text-orange-400', i: '<i class="fa-solid fa-file-zipper text-2xl"></i>' },
            'rar': 'zip', 'ipa': 'zip', 'tar': 'zip', 'gz': 'zip', '7z': 'zip', 'apk': 'zip', 'iso': 'zip', 'bz2': 'zip',
            'pdf': { n: 'type_doc', c: 'bg-red-100 text-red-500 dark:bg-red-500/20 dark:text-red-400', i: '<i class="fa-solid fa-file-pdf text-2xl"></i>' },
            'doc': 'pdf', 'docx': 'pdf', 'xls': 'pdf', 'xlsx': 'pdf', 'ppt': 'pdf', 'pptx': 'pdf', 'csv': 'pdf',
            'txt': { n: 'type_text', c: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400', i: '<i class="fa-solid fa-file-lines text-2xl"></i>' },
            'md': 'txt', 'log': 'txt', 'go': 'txt', 'yml': 'txt', 'yaml': 'txt', 'sh': 'txt', 'conf': 'txt', 'ini': 'txt'
        };
        let result = types[ext];
        if (typeof result === 'string') result = types[result];
        return result || { n: 'type_unknown', ext: ext.toUpperCase(), c: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400', i: '<i class="fa-solid fa-file text-2xl"></i>' };
    },

    /**
     * Reads the CSRF token from the csrf_token cookie set by the server.
     * Use this to attach an X-CSRF-Token header to all POST/PUT/DELETE fetch requests.
     * @returns {string} The CSRF token, or empty string if not found.
     */
    getCsrfToken() {
        const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
        return match ? decodeURIComponent(match[1]) : '';
    },

    /**
     * Copies text to the clipboard with fallback for non-secure contexts (HTTP).
     * @param {string} text The text to copy.
     * @returns {Promise} A promise that resolves when the text is copied.
     */
    async copyToClipboard(text) {
        if (navigator.clipboard && window.isSecureContext) {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch (err) {
                console.error('navigator.clipboard.writeText failed', err);
            }
        }

        // Fallback for non-secure contexts (HTTP) or failure
        const textArea = document.createElement("textarea");
        textArea.value = text;
        textArea.style.position = "fixed";
        textArea.style.left = "-9999px";
        textArea.style.top = "0";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        let success = false;
        try {
            success = document.execCommand('copy');
        } catch (err) {
            console.error('Fallback copy failed', err);
        }
        document.body.removeChild(textArea);
        if (!success) throw new Error('Copy failed');
        return true;
    },

    /**
     * Theme management logic
     */
    applyTheme(theme = 'system') {
        const html = document.documentElement;
        const body = document.body;
        
        // Update data-theme attribute
        if (body) body.setAttribute('data-theme', theme);
        
        if (theme === 'system') {
            if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
                html.classList.add('dark');
            } else {
                html.classList.remove('dark');
            }
        } else {
            // Locked themes: Neon, Cyberpunk, Lavender, Forest are dark. Others are light.
            const darkThemes = ['neon', 'cyberpunk', 'lavender', 'forest'];
            if (darkThemes.includes(theme)) {
                html.classList.add('dark');
            } else {
                html.classList.remove('dark');
            }
        }
    },

    initTheme(theme = 'system') {
        this.applyTheme(theme);
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            // Re-apply if it's currently system
            const currentTheme = document.body.getAttribute('data-theme') || theme;
            if (currentTheme === 'system') {
                this.applyTheme('system');
            }
        });
    }
};

// Initial load
TeleCloud.loadTranslations(TeleCloud.lang);
