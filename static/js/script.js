function cloudApp(initialIsLoggedIn, isAdmin = true, storageUsed = 0, webdavEnabled = false, webdavUser = '', webdavPassword = '', uploadAPIEnabled = false, uploadAPIKey = '', globalWebdavEnabled = true, globalAPIEnabled = true, webauthnRPID = '', webauthnOrigins = '', initialTheme = 'system') {
    return {
        isLoggedIn: initialIsLoggedIn,
        isAdmin: isAdmin,
        storageUsed: storageUsed,
        webdavEnabled: webdavEnabled,
        webdavUser: webdavUser,
        webdavPassword: webdavPassword,
        uploadAPIEnabled: uploadAPIEnabled,
        uploadAPIKey: uploadAPIKey,
        globalWebdavEnabled: globalWebdavEnabled,
        globalAPIEnabled: globalAPIEnabled,
        showAPIKey: false,
        childAPIKey: '',
        showChildAPIKey: false,
        ytdlpEnabled: false,
        ytdlpUrl: '',
        ytdlpLoading: false,
        ytdlpInfo: null,
        ytdlpSelectedFormat: '',
        ytdlpDownloadType: 'video',
        ytdlpHasCookie: false,
        currentTheme: initialTheme || 'system',
        setTheme(theme) {
            this.currentTheme = theme;
            TeleCloud.applyTheme(theme);
            // Save to database
            let fd = new FormData();
            fd.append('theme', theme);
            fetch('/api/settings/user/theme', { method: 'POST', body: fd, headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() } }).catch(e => console.error("Theme save failed:", e));
        },
        applyTheme() {
            TeleCloud.applyTheme(this.currentTheme);
        },
        get filteredYTDLPFormats() {
            if (!this.ytdlpInfo || !this.ytdlpInfo.formats) return [];
            return this.ytdlpInfo.formats.filter(f => {
                const vcodec = String(f.vcodec || '').toLowerCase();
                const acodec = String(f.acodec || '').toLowerCase();
                const res = String(f.resolution || '').toLowerCase();
                const note = String(f.format_note || f.format || '').toLowerCase();
                const ext = String(f.ext || '').toLowerCase();

                // Filter out non-media formats (thumbnails, storyboards)
                if (ext === 'mhtml' || ext === 'jpg' || ext === 'jpeg' || ext === 'png' ||
                    note.includes('storyboard') || note.includes('images')) return false;

                // isAudioOnly: vcodec is "none" OR resolution is "audio only"
                const isAudioOnly = vcodec === 'none' || res === 'audio only';

                if (this.ytdlpDownloadType === 'video') {
                    // For video: include formats that have video (not audio-only)
                    return !isAudioOnly;
                } else {
                    // For audio: include audio-only formats, prefer non-webm for better MP3 conversion
                    return isAudioOnly && acodec !== 'none' && acodec !== '';
                }
            }).sort((a, b) => {
                // Sort video by height desc, then filesize desc
                if (this.ytdlpDownloadType === 'video') {
                    return (b.height || 0) - (a.height || 0) ||
                        (b.filesize || b.filesize_approx || 0) - (a.filesize || a.filesize_approx || 0);
                }
                // Sort audio by filesize desc (higher bitrate usually = larger)
                return (b.filesize || b.filesize_approx || 0) - (a.filesize || a.filesize_approx || 0);
            });
        },
        formatQualityLabel(f) {
            if (!f) return '';
            let label = '';
            if (f.height && f.height > 0) {
                label = f.height + 'p';
            } else if (f.resolution && f.resolution !== 'audio only') {
                label = f.resolution;
            } else if (f.format_note) {
                const note = f.format_note.toLowerCase();
                if (note === 'medium') label = this.t('quality_medium');
                else if (note === 'low') label = this.t('quality_low');
                else if (note === 'tiny') label = this.t('quality_tiny');
                else if (note === 'ultralow') label = this.t('quality_ultralow');
                else label = f.format_note.charAt(0).toUpperCase() + f.format_note.slice(1);
            } else if (f.ext) {
                label = f.ext.toUpperCase();
            } else {
                label = 'Unknown';
            }
            
            // Standardize format display
            let ext = (f.ext || '').toUpperCase();
            if (this.ytdlpDownloadType === 'video') {
                // We force MP4 merger in backend for best compatibility
                ext = 'MP4';
            } else if (this.ytdlpDownloadType === 'audio') {
                // We force MP3 conversion in backend
                ext = 'MP3';
            }

            let size = '';
            const totalSize = f.filesize || f.filesize_approx;
            if (totalSize) size = ' - ' + this.formatBytes(totalSize);
            return `${label}${ext ? ' (' + ext + ')' : ''}${size}`;
        },
        webauthnRPID: webauthnRPID,
        webauthnOrigins: webauthnOrigins,
        currentTab: 'files',
        viewMode: localStorage.getItem('viewMode') || 'list',
        toggleViewMode() {
            this.viewMode = this.viewMode === 'list' ? 'grid' : 'list';
            localStorage.setItem('viewMode', this.viewMode);
        },
        updateAvailable: false,
        changelog: [],
        latestReleaseUrl: '',
        sortBy: 'name',
        sortOrder: 'asc',
        username: '',
        password: '', 
        confirmPassword: '',
        settingsForm: { oldPassword: '', newPassword: '', confirmPassword: '' },
        users: [],
        userForm: { username: '', password: '' },
        isCreatingUser: false,
        isLoggingIn: false,
        isLoading: false, 
        isRefreshing: false,
        isPreparingDownload: false,
        ws: null,
        lang: TeleCloud.lang,
        t(key, params) { return TeleCloud.t(key, params, this.lang); },
        handleCommonError(errorStr, defaultKey) {
            if (!errorStr) return this.t(defaultKey);
            const errorKey = 'err_' + errorStr.toLowerCase().replace(/ /g, '_');
            const translated = this.t(errorKey);
            return (translated !== errorKey) ? translated : (this.t(defaultKey) + ' (' + errorStr + ')');
        },
        async resetAdmin() {
            if (this.password !== this.confirmPassword) {
                this.showToast(this.t('toast_pass_mismatch'), 'error');
                return;
            }
            const urlParams = new URLSearchParams(window.location.search);
            const token = urlParams.get('token');
            if (!token) {
                this.showToast(this.t('invalid_token'), 'error');
                return;
            }
            let fd = new FormData();
            fd.append('token', token);
            fd.append('password', this.password);
            try {
                let res = await fetch('/reset-admin', { method: 'POST', body: fd, headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() } });
                if (res.ok) window.location.href = '/login';
                else {
                    let d = await res.json();
                    this.showToast(this.handleCommonError(d.error, 'reset_failed'), 'error');
                }
            } catch (e) {
                this.showToast(this.t('reset_error'), 'error');
            }
        },
        async setupAdmin() {
            if (this.password !== this.confirmPassword) {
                this.showToast(this.t('toast_pass_mismatch'), 'error');
                return;
            }
            let fd = new FormData();
            fd.append('username', this.username);
            fd.append('password', this.password);
            try {
                let res = await fetch('/setup', { method: 'POST', body: fd, headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() } });
                if (res.ok) window.location.href = '/';
                else {
                    let d = await res.json();
                    this.showToast(this.handleCommonError(d.error, 'setup_failed'), 'error');
                }
            } catch (e) {
                this.showToast(this.t('setup_error'), 'error');
            }
        },
        async changePassword() {
            if (this.settingsForm.newPassword !== this.settingsForm.confirmPassword) {
                this.showToast(this.t('toast_pass_mismatch'), 'error');
                return;
            }
            let fd = new FormData();
            fd.append('old_password', this.settingsForm.oldPassword);
            fd.append('new_password', this.settingsForm.newPassword);
            try {
                let res = await fetch('/api/settings/password', { method: 'POST', body: fd, headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() } });
                if (res.ok) {
                    this.showToast(this.t('toast_pass_changed'), 'success');
                    this.settingsForm = { oldPassword: '', newPassword: '', confirmPassword: '' };
                } else {
                    let d = await res.json();
                    this.showToast(this.handleCommonError(d.error, 'status_error'), 'error');
                }
            } catch (e) {
                this.showToast(this.t('conn_error'), 'error');
            }
        },
        async toggleWebDAV() {
            let newState = !this.webdavEnabled;
            let fd = new FormData();
            fd.append('enabled', newState);
            let url = this.isAdmin ? '/api/settings/webdav' : '/api/settings/child-webdav';
            try {
                let res = await fetch(url, { method: 'POST', body: fd, headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() } });
                if (res.ok) {
                    this.webdavEnabled = newState;
                } else {
                    let d = await res.json();
                    if (d.error === 'ADMIN_DISABLED') {
                        this.showToast(this.t('err_admin_disabled'), 'error');
                    } else {
                        this.showToast(this.t('webdav_toggle_error'), 'error');
                    }
                }
            } catch(e) {
                this.showToast(this.t('status_error'), 'error');
            }
        },
        async toggleUploadAPI() {
            let newState = !this.uploadAPIEnabled;
            let fd = new FormData();
            fd.append('enabled', newState);
            let url = this.isAdmin ? '/api/settings/upload-api' : '/api/settings/child-api';
            try {
                let res = await fetch(url, { method: 'POST', body: fd, headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() } });
                if (res.ok) {
                    this.uploadAPIEnabled = newState;
                    // Auto-generate a key if enabling and no key exists
                    if (newState && (this.isAdmin ? !this.uploadAPIKey : !this.childAPIKey)) {
                        this.isAdmin ? await this.regenerateAPIKey() : await this.regenerateChildAPIKey();
                    }
                } else {
                    let d = await res.json();
                    if (d.error === 'ADMIN_DISABLED') {
                        this.showToast(this.t('err_admin_disabled'), 'error');
                    } else {
                        this.showToast(this.t('api_toggle_error'), 'error');
                    }
                }
            } catch(e) {
                this.showToast(this.t('status_error'), 'error');
            }
        },
        async regenerateAPIKey() {
            try {
                let res = await fetch('/api/settings/upload-api/regenerate-key', { method: 'POST', headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() } });
                if (res.ok) {
                    let d = await res.json();
                    this.uploadAPIKey = d.api_key;
                    this.showAPIKey = true;
                    this.showToast(this.t('api_key_regenerated'), 'success');
                } else {
                    this.showToast(this.t('api_toggle_error'), 'error');
                }
            } catch(e) {
                this.showToast(this.t('status_error'), 'error');
            }
        },
        async deleteAPIKey() {
            const confirmed = await this.customConfirm(this.t('api_key_delete_title'), this.t('api_key_delete_msg'), true);
            if (!confirmed) return;
            try {
                let res = await fetch('/api/settings/upload-api/key', { method: 'DELETE', headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() } });
                if (res.ok) {
                    this.uploadAPIKey = '';
                    this.showAPIKey = false;
                    this.showToast(this.t('api_key_deleted'), 'success');
                }
            } catch(e) {
                this.showToast(this.t('status_error'), 'error');
            }
        },
        async fetchUsers() {
            try {
                const res = await fetch('/api/users');
                const data = await res.json();
                if (res.ok) {
                    this.users = data.users || [];
                }
            } catch (e) {
                console.error("Fetch users error", e);
            }
        },
        async fetchActiveTasks() {
            try {
                const res = await fetch('/api/tasks');
                const data = await res.json();
                if (res.ok && data.tasks) {
                    for (const [id, task] of Object.entries(data.tasks)) {
                        if (!this.uploadQueue.some(t => t.id === id)) {
                            // Don't restore finished tasks to keep UI clean
                            if (task.status === 'done' || task.status === 'error') continue;
                            
                            let displayProgress = task.percent;
                            if (task.status === 'telegram') {
                                displayProgress = 50 + Math.round(task.percent / 2);
                            } else if (task.status === 'downloading' || task.status === 'uploading_to_server') {
                                displayProgress = Math.round(task.percent / 2);
                            }

                            this.uploadQueue.push({
                                id: id,
                                name: task.filename || 'File',
                                progress: displayProgress,
                                statusText: task.status,
                                hasError: task.status === 'error',
                                isCancelled: false,
                                size: task.size || 0
                            });
                        }
                    }
                }
            } catch (e) {
                console.error("Fetch tasks error", e);
            }
        },
        async fetchChildAPIKey() {
            try {
                const res = await fetch('/api/settings/child-api-key');
                if (res.ok) {
                    const data = await res.json();
                    this.childAPIKey = data.api_key || '';
                }
            } catch (e) {
                console.error("Fetch child API key error", e);
            }
        },
        async regenerateChildAPIKey() {
            try {
                const res = await fetch('/api/settings/child-api-key', { method: 'POST', headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() } });
                if (res.ok) {
                    const data = await res.json();
                    this.childAPIKey = data.api_key;
                    this.showChildAPIKey = true;
                    this.showToast(this.t('api_key_regenerated'), 'success');
                } else {
                    this.showToast(this.t('api_toggle_error'), 'error');
                }
            } catch(e) {
                this.showToast(this.t('status_error'), 'error');
            }
        },
        async deleteChildAPIKey() {
            const confirmed = await this.customConfirm(this.t('api_key_delete_title'), this.t('api_key_delete_msg'), true);
            if (!confirmed) return;
            try {
                const res = await fetch('/api/settings/child-api-key', { method: 'DELETE', headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() } });
                if (res.ok) {
                    this.childAPIKey = '';
                    this.showChildAPIKey = false;
                    this.showToast(this.t('api_key_deleted'), 'success');
                }
            } catch(e) {
                this.showToast(this.t('status_error'), 'error');
            }
        },
        async createUser() {
            this.isCreatingUser = true;
            try {
                let fd = new FormData();
                fd.append('username', this.userForm.username);
                const res = await fetch('/api/users', { method: 'POST', body: fd, headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() } });
                if (res.ok) {
                    this.showToast(this.t('toast_user_created'), 'success');
                    this.userForm = { username: '' };
                    this.fetchUsers();
                } else {
                    const data = await res.json();
                    this.showToast(this.handleCommonError(data.error, 'status_error'), 'error');
                }
            } catch (e) {
                this.showToast(this.t('conn_error'), 'error');
            } finally {
                this.isCreatingUser = false;
            }
        },
        async deleteUser(username) {
            const confirmed = await this.customConfirm(this.t('delete_user_confirm_title'), this.t('delete_user_confirm_msg', {u: username}), true);
            if (!confirmed) return;
            try {
                const res = await fetch(`/api/users/${username}`, { method: 'DELETE', headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() } });
                if (res.ok) {
                    this.showToast(this.t('toast_user_deleted'), 'success');
                    this.fetchUsers();
                } else {
                    this.showToast(this.t('status_error'), 'error');
                }
            } catch (e) {
                this.showToast(this.t('conn_error'), 'error');
            }
        },
        async resetUserPassword(username) {
            const confirmed = await this.customConfirm(this.t('reset_password_confirm_title'), this.t('reset_password_confirm_msg', {u: username}), false);
            if (!confirmed) return;
            try {
                const res = await fetch(`/api/users/${username}/reset-pass`, { method: 'POST', headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() } });
                if (res.ok) {
                    this.showToast(this.t('toast_password_reset', {u: username}), 'success');
                } else {
                    this.showToast(this.t('status_error'), 'error');
                }
            } catch (e) {
                this.showToast(this.t('conn_error'), 'error');
            }
        },
        async saveWebAuthnSettings() {
            let fd = new FormData();
            fd.append('rpid', this.webauthnRPID);
            fd.append('origins', this.webauthnOrigins);
            try {
                let res = await fetch('/api/settings/webauthn', { method: 'POST', body: fd, headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() } });
                if (res.ok) {
                    this.showToast(this.t('toast_passkey_settings_saved'), 'success');
                } else {
                    this.showToast(this.t('status_error'), 'error');
                }
            } catch (e) {
                this.showToast(this.t('conn_error'), 'error');
            }
        },
        autoDetectWebAuthn() {
            this.webauthnRPID = window.location.hostname;
            this.webauthnOrigins = window.location.origin;
        },
        async autoDetectAndSaveWebAuthn() {
            this.autoDetectWebAuthn();
            await this.saveWebAuthnSettings();
        },

        async toggleLang() { 
            this.lang = await TeleCloud.toggleLang();
        },
        async setLang(code) {
            this.lang = await TeleCloud.setLang(code);
        },
        formatBytes(b, d) { return TeleCloud.formatBytes(b, d); },
        formatDate(d) { return TeleCloud.formatDate(d, this.lang); },
        getFileTypeData(f) { return TeleCloud.getFileTypeData(f); },
        parseMarkdown(t) { return TeleCloud.parseMarkdown(t); },

        startDownload(fileId) {
            this.isPreparingDownload = true;
            document.cookie = "dl_started=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
            const iframe = document.createElement('iframe');
            iframe.style.display = 'none';
            iframe.src = `/download/${fileId}`;
            document.body.appendChild(iframe);
            let checkCookie = setInterval(() => {
                if (document.cookie.includes('dl_started=1')) {
                    clearInterval(checkCookie);
                    this.isPreparingDownload = false;
                    this.showToast(this.t('toast_dl_started'), 'success');
                    document.cookie = "dl_started=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
                    setTimeout(() => iframe.remove(), 2000); 
                }
            }, 500);
            setTimeout(() => {
                if (this.isPreparingDownload) {
                    clearInterval(checkCookie);
                    this.isPreparingDownload = false;
                    iframe.remove();
                    this.showToast(this.t('toast_tg_timeout'), 'error');
                }
            }, 15000);
        },
        async downloadSelectedBatch() {
            const fileIdsToDownload = this.selectedIds.map(Number).filter(id => {
                const f = this.files.find(file => file.id === id);
                return f && !f.is_folder;
            });
            if (fileIdsToDownload.length === 0) {
                this.showToast(this.t('toast_only_files'), 'error');
                return;
            }
            if (this.selectedIds.length !== fileIdsToDownload.length) {
                this.showToast(this.t('toast_skipped_folders'));
            }
            this.showToast(this.t('toast_preparing_dl', {n: fileIdsToDownload.length}));
            this.isPreparingDownload = true;
            document.cookie = "dl_started=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
            for (let i = 0; i < fileIdsToDownload.length; i++) {
                const fileId = fileIdsToDownload[i];
                const iframe = document.createElement('iframe');
                iframe.style.display = 'none';
                iframe.src = `/download/${fileId}`;
                document.body.appendChild(iframe);
                if (i === 0) {
                    let checkCookie = setInterval(() => {
                        if (document.cookie.includes('dl_started=1')) {
                            clearInterval(checkCookie);
                            this.isPreparingDownload = false;
                            document.cookie = "dl_started=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
                        }
                    }, 500);
                    setTimeout(() => { if (this.isPreparingDownload) this.isPreparingDownload = false; }, 15000);
                }
                setTimeout(() => iframe.remove(), 20000);
                if (i < fileIdsToDownload.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 1500));
                }
            }
            this.selectedIds = [];
        },
        files: [], 
        searchQuery: '',
        currentPage: 1,
        itemsPerPage: 15,
        get filteredFiles() {
            let results = [...this.files];
            if (this.searchQuery.trim() !== '') {
                const query = this.searchQuery.toLowerCase();
                results = results.filter(f => f.filename.toLowerCase().includes(query));
            }

            return results.sort((a, b) => {
                // Folders always first
                if (a.is_folder && !b.is_folder) return -1;
                if (!a.is_folder && b.is_folder) return 1;

                let valA, valB;
                if (this.sortBy === 'name') {
                    valA = a.filename.toLowerCase();
                    valB = b.filename.toLowerCase();
                } else if (this.sortBy === 'date') {
                    valA = new Date(a.created_at).getTime() || 0;
                    valB = new Date(b.created_at).getTime() || 0;
                } else if (this.sortBy === 'size') {
                    valA = a.size || 0;
                    valB = b.size || 0;
                }

                if (valA < valB) return this.sortOrder === 'asc' ? -1 : 1;
                if (valA > valB) return this.sortOrder === 'asc' ? 1 : -1;
                return 0;
            });
        },
        toggleSort(field) {
            if (this.sortBy === field) {
                this.sortOrder = this.sortOrder === 'asc' ? 'desc' : 'asc';
            } else {
                this.sortBy = field;
                this.sortOrder = 'asc';
            }
        },
        get totalPages() {
            return Math.ceil(this.filteredFiles.length / this.itemsPerPage) || 1;
        },
        get displayedFiles() {
            const start = (this.currentPage - 1) * this.itemsPerPage;
            const end = start + this.itemsPerPage;
            return this.filteredFiles.slice(start, end);
        },
        currentPath: '/', 
        openMenuId: null,
        selectedIds: [], 
        clipboard: { action: null, ids: [] },
        dragOver: false, 
        uploadModal: false,
        uploadDragOver: false,
        uploadQueue: [], 
        isQueueMinimized: false,
        passkeys: [],
        get isAllUploadsDone() {
            if (this.uploadQueue.length === 0) return false;
            return this.uploadQueue.every(t => t.progress === 100 || t.isCancelled);
        },
        cancelUpload(taskId) {
            let task = this.uploadQueue.find(t => t.id === taskId);
            if (task && task.progress < 100) {
                task.isCancelled = true;
                task.statusText = this.t('cancelled');
                
                // Notify backend to cancel the task and clean up temporary files
                let fd = new FormData();
                fd.append('task_id', taskId);
                fd.append('filename', task.name);
                fetch('/api/cancel_upload', { method: 'POST', body: fd, headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() } }).catch(e => console.error("Cancel failed:", e));
            }
        },
        toastModal: { show: false, message: '', type: 'success' },
        toastTimeout: null,
        plyrInstance: null,
        fileInfoModal: { show: false, file: null, typeName: '', ext: '', svgIcon: '', bgColor: '', isMedia: false, mediaHtml: '', isLarge: false, isPreviewLoading: false, needsLoad: false, tooLarge: false },
        modal: { show: false, type: 'alert', title: '', message: '', input: '', resolve: null, isDanger: false, inputType: 'text' },
        contextMenu: { show: false, x: 0, y: 0, file: null },
        init() { 
            window.addEventListener('tc-translations-loaded', (e) => {
                this.lang = '';
                this.$nextTick(() => { this.lang = e.detail.lang; });
            });

            // Always apply theme (will be 'system' for non-logged-in users)
            TeleCloud.initTheme(this.currentTheme);

            if (this.isLoggedIn) {
                this.fetchFiles(false);
                this.checkUpdate();
                this.initWebSocket();
                this.fetchPasskeys();
                this.fetchActiveTasks();
                this.fetchYTDLPStatus();
                this.checkYTDLPCookies();
                
                if (!this.isAdmin) {
                    this.fetchChildAPIKey();
                }

                // Add hasError to existing tasks if any
                this.uploadQueue.forEach(t => { if(t.hasError === undefined) t.hasError = false; });

                // Warn user before leaving page if uploads are active
                window.addEventListener('beforeunload', (e) => {
                    const hasActiveUploads = this.uploadQueue.some(t => !t.hasError && t.progress < 100);
                    if (hasActiveUploads) {
                        e.preventDefault();
                        e.returnValue = ''; // Standard way to trigger the browser's confirmation dialog
                    }
                });
            }
        },
        async checkUpdate() {
            const compareVersions = (v1, v2) => {
                const p1 = (v1 || 'v0.0.0').replace(/^v/, '').split('.').map(Number);
                const p2 = (v2 || 'v0.0.0').replace(/^v/, '').split('.').map(Number);
                for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
                    const n1 = p1[i] || 0;
                    const n2 = p2[i] || 0;
                    if (n1 > n2) return 1;
                    if (n1 < n2) return -1;
                }
                return 0;
            };

            try {
                const res = await fetch('https://api.github.com/repos/dabeecao/telecloud-go/releases');
                if (res.ok) {
                    const releases = await res.json();
                    if (releases && releases.length > 0) {
                        const latest = releases[0];
                        const latestVersion = latest.tag_name;
                        const currentVersion = TeleCloud.version || 'v1.0.0';
                        
                        if (latestVersion && compareVersions(latestVersion, currentVersion) === 1) {
                            this.updateAvailable = true;
                            this.latestReleaseUrl = latest.html_url;
                            this.changelog = releases.slice(0, 5).map(r => ({
                                tag: r.tag_name,
                                name: r.name,
                                body: r.body,
                                url: r.html_url,
                                date: r.published_at
                            }));

                            const dismissedDate = localStorage.getItem('tc_update_dismissed');
                            const today = new Date().toDateString();
                            
                            if (dismissedDate !== today) {
                                const choice = await this.showUIModal('update', this.t('update_title'), this.t('update_msg') + ` (${latestVersion})`);
                                if (choice === 'confirm') {
                                    this.currentTab = 'changelog';
                                } else if (choice === 'dismiss_today') {
                                    localStorage.setItem('tc_update_dismissed', today);
                                }
                            }
                        }
                    }
                }
            } catch (e) { console.error('Failed to check for updates', e); }
        },
        initWebSocket() {
            if (this.ws) return;
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}/api/ws`;
            this.ws = new WebSocket(wsUrl);
            
            this.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    let task = this.uploadQueue.find(t => t.id === data.task_id);
                    if (task) {
                        if (task.isCancelled) return;
                        if (data.size && data.size > 0 && (!task.size || task.size === 0)) {
                            task.size = data.size;
                        }
                        if (data.status === 'downloading' || data.status === 'telegram' || data.status === 'done') {
                            let msg = data.message;
                            if (msg && msg.startsWith('uploading_part_')) {
                                const matchOf = msg.match(/uploading_part_(\d+)_of_(\d+)/);
                                if (matchOf) {
                                    msg = this.t('uploading_part_x_of_y', {x: matchOf[1], y: matchOf[2]});
                                } else {
                                    const matchSingle = msg.match(/uploading_part_(\d+)/);
                                    if (matchSingle) {
                                        msg = this.t('uploading_part', {n: matchSingle[1]});
                                    }
                                }
                            } else {
                                msg = this.t(msg);
                            }
                            task.statusText = msg || this.t(data.status);
                            task.hasError = false;
                        }

                        if (data.status === 'uploading_to_server' || data.status === 'downloading') {
                            if (!task.hasError) {
                                task.statusText = this.t(data.message) || task.statusText;
                                // Phase 1: 0-50%
                                if (data.percent !== undefined) {
                                    task.progress = Math.round(data.percent / 2);
                                }
                            }
                        } else if (data.message === 'waiting_slot') {
                            task.statusText = this.t('waiting_slot');
                            task.hasError = false;
                            // If waiting for Telegram upload, we're at 50%
                            // If waiting for yt-dlp download, we're at 0%
                            task.progress = (data.status === 'telegram') ? 50 : 0;
                        }

                        if (data.status === 'telegram' || data.status === 'done') {
                            // Phase 2: 50-100%
                            task.progress = 50 + Math.round(data.percent / 2);
                            if (data.uploaded_bytes && data.uploaded_bytes > 0) {
                                // Reset startTime when phase changes to get accurate phase speed
                                if (data.status === 'telegram' && task.statusText === this.t('pushing_to_tg')) {
                                     task.startTime = Date.now();
                                     task.uploadedBytes = 0;
                                }
                                
                                task.uploadedBytes = data.uploaded_bytes;
                                if (task.startTime) {
                                    const elapsed = (Date.now() - task.startTime) / 1000;
                                    if (elapsed > 0) {
                                        task.speed = task.uploadedBytes / elapsed;
                                    }
                                }
                            }
                        }

                        if (data.status === 'done') {
                            task.progress = 100;
                            task.statusText = this.t('done');
                            task.hasError = false;
                            this.fetchFiles(true);
                        } else if (data.status === 'error') {
                            const errorMsg = data.message;
                            const translated = this.t(errorMsg);
                            task.statusText = this.t('status_error') + ': ' + (translated !== errorMsg ? translated : errorMsg);
                            task.hasError = true;
                        }
                    }
                } catch (e) {
                    console.error('WS message error:', e);
                }
            };

            this.ws.onclose = () => {
                this.ws = null;
                // Reconnect after 5 seconds
                setTimeout(() => this.initWebSocket(), 5000);
            };

            this.ws.onerror = (err) => {
                console.error('WS error:', err);
                this.ws.close();
            };
        },
        showUIModal(type, title, message = '', defaultValue = '', isDanger = false, inputType = 'text') {
            return new Promise((resolve) => {
                this.modal = { show: true, type, title, message, input: defaultValue, resolve, isDanger, inputType };
                if (type === 'prompt') {
                    setTimeout(() => { if (this.$refs.modalInput) this.$refs.modalInput.focus(); }, 100);
                }
            });
        },
        closeUIModal(result) {
            if (this.modal.resolve) this.modal.resolve(result);
            this.modal.show = false;
        },
        async customPrompt(title, defaultValue = '', inputType = 'text') { return await this.showUIModal('prompt', title, '', defaultValue, false, inputType); },
        async customConfirm(title, message, isDanger = false) { return await this.showUIModal('confirm', title, message, '', isDanger); },
        async customAlert(title, message) { return await this.showUIModal('alert', title, message); },
        openContextMenu(e, file) {
            if (!file) return; 
            this.contextMenu.file = file;
            let x = e.clientX; let y = e.clientY;
            if (window.innerWidth - x < 210) x = window.innerWidth - 210;
            if (window.innerHeight - y < 250) y = window.innerHeight - 250;
            this.contextMenu.x = x;
            this.contextMenu.y = y;
            this.contextMenu.show = true;
        },
        closeContextMenu() { this.contextMenu.show = false; },
        async login() {
            if (this.isLoggingIn) return;
            this.isLoggingIn = true;
            try {
                const fd = new FormData(); 
                fd.append('username', this.username);
                fd.append('password', this.password);
                const res = await fetch('/login', { method: 'POST', body: fd });
                if (res.ok) {
                    const data = await res.json();
                    if (data.status === 'force_password_change') {
                        await this.customAlert(this.t('force_password_change_title'), this.t('force_password_change_msg'));
                        const newPass = await this.customPrompt(this.t('new_password'), "", "password");
                        if (!newPass) return;
                        const confirmPass = await this.customPrompt(this.t('confirm_password'), "", "password");
                        if (newPass !== confirmPass) {
                            this.showToast(this.t('toast_pass_mismatch'), 'error');
                            return;
                        }
                        
                        // Call change password API
                        let cfd = new FormData();
                        cfd.append('old_password', this.password);
                        cfd.append('new_password', newPass);
                        let cres = await fetch('/api/settings/password', { 
                            method: 'POST', 
                            body: cfd, 
                            headers: { 
                                'X-CSRF-Token': TeleCloud.getCsrfToken(),
                                // We need to pass the login credentials because we don't have a session yet
                                'Authorization': 'Basic ' + btoa(this.username + ':' + this.password)
                            } 
                        });

                        if (cres.ok) {
                            this.showToast(this.t('toast_pass_changed'), 'success');
                            // Update stored password to the new one so the next login() call succeeds
                            this.password = newPass;
                            // After change, log in again automatically to get a real session
                            this.isLoggingIn = false; 
                            return await this.login();
                        } else {
                            const d = await cres.json();
                            this.showToast(this.handleCommonError(d.error, 'status_error'), 'error');
                        }
                    } else {
                        window.location.href = '/'; 
                    }
                } else {
                    const data = await res.json();
                    this.showToast(this.handleCommonError(data.error, 'toast_login_fail'), 'error');
                }
            } catch (e) {
                this.showToast(this.t('conn_error'), 'error');
            } finally {
                this.isLoggingIn = false;
            }
        },
        async loginWithPasskey() {
            if (!window.PublicKeyCredential) {
                this.showToast(this.t('passkey_not_supported'), 'error');
                return;
            }
            try {
                const beginResp = await fetch('/api/passkey/login/begin' + (this.username ? '?username=' + this.username : ''));
                const options = await beginResp.json();
                if (options.error) throw new Error(options.error);
                const bufferToBase64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
                const base64ToBuffer = (base64) => {
                    const binary = atob(base64.replace(/-/g, "+").replace(/_/g, "/"));
                    const buffer = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) buffer[i] = binary.charCodeAt(i);
                    return buffer.buffer;
                };
                options.publicKey.challenge = base64ToBuffer(options.publicKey.challenge);
                if (options.publicKey.allowCredentials) {
                    options.publicKey.allowCredentials.forEach(c => c.id = base64ToBuffer(c.id));
                }
                const credential = await navigator.credentials.get(options);
                const finishResp = await fetch('/api/passkey/login/finish', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': TeleCloud.getCsrfToken() },
                    body: JSON.stringify({
                        id: credential.id,
                        rawId: bufferToBase64(credential.rawId),
                        type: credential.type,
                        response: {
                            authenticatorData: bufferToBase64(credential.response.authenticatorData),
                            clientDataJSON: bufferToBase64(credential.response.clientDataJSON),
                            signature: bufferToBase64(credential.response.signature),
                            userHandle: credential.response.userHandle ? bufferToBase64(credential.response.userHandle) : null
                        }
                    })
                });
                const result = await finishResp.json();
                if (result.status === 'force_password_change') {
                    await this.customAlert(this.t('force_password_change_title'), this.t('force_password_change_msg'));
                    const newPass = await this.customPrompt(this.t('new_password'), "", "password");
                    if (!newPass) return;
                    const confirmPass = await this.customPrompt(this.t('confirm_password'), "", "password");
                    if (newPass !== confirmPass) {
                        this.showToast(this.t('toast_pass_mismatch'), 'error');
                        return;
                    }
                    let cfd = new FormData();
                    cfd.append('old_password', "");
                    cfd.append('new_password', newPass);
                    let cres = await fetch('/api/settings/password', { method: 'POST', body: cfd, headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() } });
                    if (cres.ok) {
                        this.showToast(this.t('toast_pass_changed'), 'success');
                        window.location.href = '/';
                    } else {
                        const d = await cres.json();
                        this.showToast(this.handleCommonError(d.error, 'status_error'), 'error');
                    }
                } else if (result.status === 'success') {
                    window.location.href = '/';
                } else {
                    throw new Error(result.error || this.t('err_passkey_auth_failed'));
                }
            } catch (err) {
                if (err.name === 'AbortError' || err.name === 'NotAllowedError') return;
                console.error(err);
                this.showToast(this.t('passkey_error') + ': ' + err.message, 'error');
            }
        },

        async logout() { await fetch('/logout', { method: 'POST', headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() } }); window.location.href = '/login'; },
        getBreadcrumbs() { return this.currentPath === '/' ? [] : this.currentPath.split('/').filter(Boolean); },
        navigateToFolder(folderName) { this.currentPath = this.currentPath === '/' ? '/' + folderName : this.currentPath + '/' + folderName; this.fetchFiles(); },
        navigateToIndex(index) { this.currentPath = '/' + this.getBreadcrumbs().slice(0, index + 1).join('/'); this.fetchFiles(); },
        navigateTo(path) { this.currentPath = path; this.fetchFiles(); },
        async fetchFiles(silentLoad = false) {
            if (!silentLoad && (!this.files || this.files.length === 0)) { this.isLoading = true; } else { this.isRefreshing = true; }
            try {
                const res = await fetch(`/api/files?path=${encodeURIComponent(this.currentPath)}`);
                if (res.status === 401) {
                    window.location.href = '/login';
                    return;
                }
                if (res.status === 403) {
                    const data = await res.json();
                    if (data.error === 'force_password_change') {
                        this.logout();
                        return;
                    }
                }
                const data = await res.json();
                this.files = data.files || [];
                if (data.storage_used !== undefined) this.storageUsed = data.storage_used;
                this.selectedIds = this.selectedIds.filter(id => this.files.some(f => f.id === id));
                if (!silentLoad) { this.searchQuery = ''; this.currentPage = 1; } else { if (this.currentPage > this.totalPages) this.currentPage = Math.max(1, this.totalPages); }
            } catch (e) { console.error('Fetch error', e); } finally { this.isLoading = false; this.isRefreshing = false; }
        },
        async createNewFolder() {
            const name = await this.customPrompt(this.t('new_folder_title'), "");
            if (!name || name.trim() === "") return;
            const tempId = 'temp_' + Date.now();
            this.files.unshift({ id: tempId, filename: name.trim(), is_folder: true, size: 0, created_at: new Date().toISOString() });
            const fd = new FormData(); fd.append('name', name.trim()); fd.append('path', this.currentPath);
            const response = await fetch('/api/folders', { method: 'POST', body: fd, headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() } });
            if (response.ok) {
                this.fetchFiles(true); 
                this.showToast(this.t('toast_created', {n: name.trim()}));
            } else {
                const data = await response.json();
                this.showToast(this.handleCommonError(data.error, 'status_error'), 'error');
            }
        },
        copyToClipboard(action, idsArray) { this.clipboard = { action: action, ids: [...idsArray] }; this.selectedIds = []; },
        async executePaste() {
            if (this.clipboard.ids.length === 0) return;
            if (this.clipboard.action === 'move') this.files = this.files.filter(f => !this.clipboard.ids.includes(f.id));
            const response = await fetch('/api/actions/paste', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': TeleCloud.getCsrfToken() }, body: JSON.stringify({ action: this.clipboard.action, item_ids: this.clipboard.ids, destination: this.currentPath }) });
            if (response.ok) {
                this.clipboard = { action: null, ids: [] }; 
                this.fetchFiles(true);
                this.showToast(this.t('toast_pasted'));
            } else {
                const data = await response.json();
                this.showToast(this.handleCommonError(data.error, 'status_error'), 'error');
                this.fetchFiles(true);
            }
        },
        async deleteBatch() {
            const confirmed = await this.customConfirm(this.t('delete_confirm_title'), this.t('delete_batch_msg', {n: this.selectedIds.length}), true);
            if (!confirmed) return;
            const idsToDelete = [...this.selectedIds];
            this.files = this.files.filter(f => !idsToDelete.includes(f.id));
            this.selectedIds = [];
            let successCount = 0;
            let errorOccurred = false;
            for (let id of idsToDelete) {
                const response = await fetch(`/api/files/${id}`, { method: 'DELETE', headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() } });
                if (response.ok) successCount++;
                else errorOccurred = true;
            }
            this.fetchFiles(true);
            if (errorOccurred) {
                this.showToast(this.t('status_error'), 'error');
            } else {
                this.showToast(this.t('toast_deleted', {n: successCount}), 'success');
            }
        },
        remoteUploadModal: false,
        remoteUrl: '',
        remoteOverwrite: false,
        async submitRemoteUpload() {
            if (!this.remoteUrl) return;
            
            try {
                const u = new URL(this.remoteUrl);
                if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
            } catch (e) {
                this.showToast(this.t('err_invalid_url'), 'error');
                return;
            }
            this.remoteUploadModal = false;
            
            const taskId = 'task_' + Math.random().toString(36).substring(2, 11) + '_' + Date.now();
            
            // Push to queue immediately to catch fast WebSocket events
            this.uploadQueue.push({
                id: taskId,
                name: 'URL: ' + (this.remoteUrl.split('/').pop() || this.remoteUrl),
                progress: 0,
                statusText: this.t('preparing_upload'),
                isCancelled: false,
                hasError: false,
                size: 0
            });

            let fd = new FormData();
            fd.append('url', this.remoteUrl);
            fd.append('path', this.currentPath);
            fd.append('overwrite', this.remoteOverwrite);
            fd.append('task_id', taskId);
            
            const originalUrl = this.remoteUrl;
            this.remoteUrl = '';
            
            try {
                let res = await fetch('/api/remote-upload', { 
                    method: 'POST', 
                    body: fd, 
                    headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() } 
                });
                if (res.ok) {
                    this.showToast(this.t('toast_dl_started'), 'success');
                } else {
                    let d = await res.json();
                    // Remove from queue since it failed to start
                    this.uploadQueue = this.uploadQueue.filter(t => t.id !== taskId);
                    this.showToast(this.handleCommonError(d.error, 'status_error'), 'error');
                }
            } catch (e) {
                // Remove from queue since it failed to start
                this.uploadQueue = this.uploadQueue.filter(t => t.id !== taskId);
                this.showToast(this.t('conn_error'), 'error');
            }
        },

        async handleDrop(e) { 
            this.dragOver = false; 
            const files = await this.scanFiles(e.dataTransfer.items);
            this.uploadFiles(files); 
        },
        handleUploadModalSelect(e) { 
            this.uploadFiles(Array.from(e.target.files)); 
            e.target.value = ''; 
            this.uploadModal = false; 
        },
        async handleUploadModalDrop(e) { 
            this.uploadDragOver = false; 
            this.uploadModal = false; 
            const files = await this.scanFiles(e.dataTransfer.items);
            this.uploadFiles(files); 
        },
        async scanFiles(items) {
            const files = [];
            const scan = async (entry, path = '') => {
                if (entry.isFile) {
                    const file = await new Promise((resolve) => entry.file(resolve));
                    if (path) file.relativeDir = path.endsWith('/') ? path.slice(0, -1) : path;
                    files.push(file);
                } else if (entry.isDirectory) {
                    const reader = entry.createReader();
                    const entries = await new Promise((resolve) => {
                        let allEntries = [];
                        const read = () => {
                            reader.readEntries((results) => {
                                if (results.length) {
                                    allEntries = allEntries.concat(results);
                                    read();
                                } else {
                                    resolve(allEntries);
                                }
                            });
                        };
                        read();
                    });
                    for (const child of entries) {
                        await scan(child, path + entry.name + '/');
                    }
                }
            };

            for (const item of items) {
                if (item.webkitGetAsEntry) {
                    const entry = item.webkitGetAsEntry();
                    if (entry) await scan(entry);
                } else if (item.kind === 'file') {
                    files.push(item.getAsFile());
                }
            }
            return files;
        },
        async uploadFiles(fileList) {
            const newTasks = [];
            
            for (let i = 0; i < fileList.length; i++) {
                const file = fileList[i];
                // Create a stable task ID based on file metadata to support resuming
                const fileIdStr = `${file.name}_${file.size}_${file.lastModified}`;
                // Safely handle Unicode characters (like Vietnamese) for btoa
                const taskId = 'task_' + btoa(unescape(encodeURIComponent(fileIdStr))).replace(/[^a-zA-Z0-9]/g, '').substring(0, 32);
                
                // Check if a task with the same ID already exists in the queue
                const existingTaskIndex = this.uploadQueue.findIndex(t => t.id === taskId);
                if (existingTaskIndex !== -1) {
                    const existingTask = this.uploadQueue[existingTaskIndex];
                    // If it's already uploading and not cancelled/errored, don't add it again
                    if (existingTask.progress < 100 && !existingTask.isCancelled && !existingTask.hasError) {
                        continue;
                    }
                    // Otherwise, remove the old task (cancelled/errored/done) to avoid duplicate IDs in the UI
                    this.uploadQueue.splice(existingTaskIndex, 1);
                }

                const task = { 
                    id: taskId, 
                    name: file.name, 
                    progress: 0, 
                    statusText: this.t('waiting_slot'), 
                    isCancelled: false,
                    file: file,
                    hasError: false,
                    targetPath: (function(app, f) {
                        let rel = f.relativeDir;
                        if (!rel && f.webkitRelativePath) {
                            const parts = f.webkitRelativePath.split('/');
                            if (parts.length > 1) rel = parts.slice(0, -1).join('/');
                        }
                        if (rel) {
                            return app.currentPath === '/' ? '/' + rel : app.currentPath + '/' + rel;
                        }
                        return app.currentPath;
                    })(this, file),
                    size: file.size,
                    speed: 0,
                    uploadedBytes: 0,
                    startTime: null
                };
                
                newTasks.push(task);
            }
            
            // Add all to queue at once for better performance
            this.uploadQueue.unshift(...newTasks);
            
            const CONCURRENCY = 3;
            const activeQueue = newTasks.filter(t => !t.hasError);

            const processQueue = async () => {
                while (activeQueue.length > 0) {
                    const task = activeQueue.shift();
                    if (task.isCancelled) continue;
                    
                    task.statusText = this.t('preparing_upload');
                    await this.uploadSingleFile(task.file, task.id, task.targetPath);
                }
            };

            const workers = [];
            for (let i = 0; i < Math.min(CONCURRENCY, activeQueue.length); i++) {
                workers.push(processQueue());
            }
            await Promise.all(workers);
        },

        async retryUpload(taskId) {
            const task = this.uploadQueue.find(t => t.id === taskId);
            if (!task || !task.file) return;
            
            task.progress = 0;
            task.statusText = this.t('preparing_upload');
            task.isCancelled = false;
            
            await this.uploadSingleFile(task.file, taskId, task.targetPath);
        },

        async uploadSingleFile(file, taskId, targetPath) {
            const CHUNK_SIZE = 10 * 1024 * 1024;
            const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
            let hasError = false;
            let uploadedChunks = 0;

            // Check if server already has some chunks for this task
            let existingChunks = [];
            try {
                const checkRes = await fetch(`/api/upload/check/${taskId}`);
                if (checkRes.ok) {
                    const checkData = await checkRes.json();
                    existingChunks = checkData.chunks || [];
                    uploadedChunks = existingChunks.length;
                    const task = this.uploadQueue.find(t => t.id === taskId);
                    if (task && uploadedChunks > 0) {
                        task.progress = Math.round((uploadedChunks / totalChunks) * 50);
                        task.uploadedBytes = uploadedChunks * CHUNK_SIZE;
                    }
                }
            } catch (e) {
                console.error("Resume check failed:", e);
            }

            const task = this.uploadQueue.find(t => t.id === taskId);
            if (task) task.startTime = Date.now();

            // Worker pool for parallel chunks
            const CHUNK_CONCURRENCY = 3;
            const chunkQueue = Array.from({ length: totalChunks }, (_, i) => i)
                                    .filter(i => !existingChunks.includes(i));
            
            if (chunkQueue.length === 0 && totalChunks > 0) {
                // All chunks already uploaded
                const task = this.uploadQueue.find(t => t.id === taskId);
                if (task) {
                    task.progress = 50;
                    task.statusText = this.t('syncing_tg');
                }
                return;
            }
            
            const uploadWorker = async () => {
                while (chunkQueue.length > 0 && !hasError) {
                    const chunkIndex = chunkQueue.shift();
                    let taskObj = this.uploadQueue.find(t => t.id === taskId);
                    if (!taskObj || taskObj.isCancelled) break;

                    const start = chunkIndex * CHUNK_SIZE;
                    const end = Math.min(start + CHUNK_SIZE, file.size);
                    const chunk = file.slice(start, end);
                    const fd = new FormData(); 
                    fd.append('file', chunk); fd.append('filename', file.name); fd.append('path', targetPath); 
                    fd.append('task_id', taskId); fd.append('chunk_index', chunkIndex); fd.append('total_chunks', totalChunks);

                    let retries = 3;
                    let success = false;
                    while (retries > 0 && !success) {
                        try {
                            let task = this.uploadQueue.find(t => t.id === taskId);
                            if (task && !task.statusText.includes(this.t('status_error'))) {
                                task.statusText = `${this.t('pushing')} (${uploadedChunks + 1}/${totalChunks})... ${retries < 3 ? '(' + this.t('retry') + ' ' + (3 - retries) + ')' : ''}`;
                            }

                            const response = await fetch('/api/upload', { 
                                method: 'POST', 
                                body: fd, 
                                headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() } 
                            });
                            
                            if (!response.ok) throw new Error("Upload failed");
                            const result = await response.json();
                            
                            uploadedChunks++;
                            if (task) {
                                task.uploadedBytes += chunk.size;
                                const elapsed = (Date.now() - task.startTime) / 1000;
                                if (elapsed > 0) {
                                    // Use a bit of weighted average for smoother speed
                                    const currentSpeed = (task.uploadedBytes - (existingChunks.length * CHUNK_SIZE)) / elapsed;
                                    task.speed = currentSpeed;
                                }
                                task.progress = Math.round((uploadedChunks / totalChunks) * 50);
                            }
                            
                            if (result.status === "processing_telegram") {
                                if (task) task.statusText = this.t('syncing_tg');
                            }
                            success = true;
                        } catch (err) { 
                            retries--;
                            console.error(`Upload chunk ${chunkIndex} error (retries left: ${retries}):`, err);
                            if (retries === 0) {
                                let task = this.uploadQueue.find(t => t.id === taskId); 
                                if(task && !task.isCancelled) {
                                    task.statusText = this.t('conn_error');
                                    task.hasError = true;
                                }
                                hasError = true;
                            } else {
                                await new Promise(r => setTimeout(r, 2000)); // Wait before retry
                            }
                        }
                    }
                }
            };

            const workers = [];
            for (let i = 0; i < Math.min(CHUNK_CONCURRENCY, totalChunks); i++) {
                workers.push(uploadWorker());
            }
            await Promise.all(workers);
        },
        async toggleShare(file) {
            const targetFile = this.files.find(f => f.id === file.id);
            if (targetFile) {
                if (targetFile.share_token) {
                    const response = await fetch(`/api/files/${file.id}/share`, { method: 'DELETE', headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() } });
                    if (response.ok) {
                        targetFile.share_token = null;
                        this.showToast(this.t('toast_revoked'), 'success');
                    } else {
                        const data = await response.json();
                        this.showToast(this.handleCommonError(data.error, 'status_error'), 'error');
                    }
                } else {
                    targetFile.share_token = 'loading...';
                    const response = await fetch(`/api/files/${file.id}/share`, { method: 'POST', headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() } });
                    if (response.ok) {
                        const data = await response.json();
                        targetFile.share_token = data.share_token;
                        targetFile.direct_token = data.direct_token; 
                        this.copyShareLink(targetFile, 'regular');
                    } else {
                        targetFile.share_token = null;
                        const data = await response.json();
                        this.showToast(this.handleCommonError(data.error, 'status_error'), 'error');
                    }
                }
            }
        },
        async copyShareLink(file, type = 'regular') {
            const link = type === 'direct' ? `${window.location.origin}/dl/${file.direct_token}` : `${window.location.origin}/s/${file.share_token}`;
            try {
                await TeleCloud.copyToClipboard(link);
                const label = type === 'direct' ? this.t('link_direct') : this.t('link_share');
                this.showToast(this.t('toast_copied', {t: label}));
            } catch (err) {
                console.error('Failed to copy link:', err);
            }
        },
        showToast(msg, type = 'success') {
            this.toastModal = { show: true, message: msg, type: type };
            if (this.toastTimeout) clearTimeout(this.toastTimeout);
            this.toastTimeout = setTimeout(() => { this.toastModal.show = false; }, 3500);
        },
        async deleteFile(id) { 
            const confirmed = await this.customConfirm(this.t('delete_confirm_title'), this.t('delete_confirm_msg'), true); 
            if (!confirmed) return; 
            this.files = this.files.filter(f => f.id !== id);
            const response = await fetch(`/api/files/${id}`, { method: 'DELETE', headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() } }); 
            if (response.ok) {
                this.fetchFiles(true);
                this.showToast(this.t('toast_deleted', {n: 1}), 'success'); 
            } else {
                const data = await response.json();
                this.showToast(this.handleCommonError(data.error, 'status_error'), 'error');
                this.fetchFiles(true);
            }
        },
        async renameFile(file) { 
            const newName = await this.customPrompt(this.t('rename_title'), file.filename); 
            if (!newName || newName === file.filename) return; 
            const targetFile = this.files.find(f => f.id === file.id);
            if(targetFile) targetFile.filename = newName;
            const fd = new FormData(); fd.append('new_name', newName); 
            const response = await fetch(`/api/files/${file.id}/rename`, { method: 'PUT', body: fd, headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() } }); 
            if (response.ok) {
                this.fetchFiles(true); 
                this.showToast(this.t('toast_renamed')); 
            } else {
                const data = await response.json();
                this.showToast(this.handleCommonError(data.error, 'status_error'), 'error');
                this.fetchFiles(true);
            }
        },
        closeFileInfoModal() {
            this.fileInfoModal.show = false;
            if (this.plyrInstance) { this.plyrInstance.destroy(); this.plyrInstance = null; }
            setTimeout(() => { if (!this.fileInfoModal.show) { this.fileInfoModal.isMedia = false; this.fileInfoModal.mediaHtml = ''; this.fileInfoModal.isLarge = false; this.fileInfoModal.isPreviewLoading = false; this.fileInfoModal.needsLoad = false; this.fileInfoModal.tooLarge = false; } }, 300);
        },
        async showFileInfo(file) {
            if (file.is_folder) return;
            const typeData = this.getFileTypeData(file.filename);
            const ext = file.filename.split('.').pop().toLowerCase();
            const imgExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'heic', 'heif'];
            const videoExts = ['mp4', 'webm', 'ogg', 'mov', 'mkv', 'ogv', '3gp', 'flv', 'wmv'];
            const audioExts = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'opus', 'oga', 'aac', 'm4b'];
            const textExts = ['txt', 'md', 'log', 'json', 'js', 'py', 'go', 'html', 'css', 'yml', 'yaml', 'sql', 'sh', 'conf', 'ini', 'c', 'cpp', 'h', 'hpp', 'cs', 'java', 'rb', 'rs', 'swift'];
            
            const langMap = {
                'js': 'javascript', 'json': 'json', 'py': 'python', 'go': 'go', 
                'html': 'markup', 'css': 'css', 'yml': 'yaml', 'yaml': 'yaml',
                'sql': 'sql', 'sh': 'bash', 'md': 'markdown', 'c': 'clike', 'cpp': 'clike',
                'h': 'clike', 'hpp': 'clike', 'cs': 'clike', 'java': 'java', 'rb': 'ruby',
                'rs': 'rust', 'swift': 'swift'
            };

            const mimeTypes = { 
                'mp4': 'video/mp4', 'webm': 'video/webm', 'ogg': 'video/ogg', 'ogv': 'video/ogg',
                'mov': 'video/mp4', 'mkv': 'video/webm', 'mp3': 'audio/mpeg', 'wav': 'audio/wav', 
                'flac': 'audio/flac', 'm4a': 'audio/mp4', 'opus': 'audio/ogg', 'oga': 'audio/ogg',
                'aac': 'audio/aac', 'm4b': 'audio/mp4'
            };
            let isMedia = false; let mediaHtml = ''; let playerTarget = null;
            let isLarge = false;
            const streamUrl = `/api/files/${file.id}/stream`;
            const thumbUrl = `/api/files/${file.id}/thumb`;
            
            if (imgExts.includes(ext)) { 
                mediaHtml = '<img src="' + streamUrl + '" alt="' + file.filename + '" class="max-h-64 object-contain rounded-[1rem] w-full shadow-md">'; 
                isMedia = true; 
            } else if (videoExts.includes(ext)) {
                const typeAttr = mimeTypes[ext] || 'video/mp4';
                mediaHtml = '<div class="w-full relative z-20 rounded-[1rem] bg-black shadow-md"><video id="index-tele-player" playsinline controls preload="none" ' + (file.has_thumb ? 'data-poster="' + thumbUrl + '"' : '') + '><source src="' + streamUrl + '" type="' + typeAttr + '"></video></div>';
                isMedia = true; playerTarget = { el: '#index-tele-player', type: 'video' };
            } else if (audioExts.includes(ext)) {
                const typeAttr = mimeTypes[ext] || 'audio/mpeg';
                mediaHtml = '<div class="w-full relative z-20 rounded-[1rem] p-2 sm:p-4 bg-slate-100 dark:bg-slate-800/50 shadow-inner">' + (file.has_thumb ? '<img src="' + thumbUrl + '" class="w-32 h-32 mx-auto rounded-2xl mb-4 object-cover shadow-md">' : '<div class="w-32 h-32 mx-auto rounded-2xl mb-4 flex items-center justify-center bg-white dark:bg-slate-700 shadow-sm"><i class="fa-solid fa-music text-5xl text-slate-300 dark:text-slate-500"></i></div>') + '<audio id="index-tele-player" controls preload="none"><source src="' + streamUrl + '" type="' + typeAttr + '"></audio></div>';
                isMedia = true; playerTarget = { el: '#index-tele-player', type: 'audio' };
            } else if (textExts.includes(ext)) {
                this.fileInfoModal = { show: true, file: file, typeName: typeData.n, ext: typeData.ext || '', svgIcon: typeData.i, bgColor: typeData.c, isMedia: false, mediaHtml: '', isLarge: true, isPreviewLoading: false, needsLoad: false, tooLarge: false };
                
                if (file.size > 10 * 1024 * 1024) {
                    this.fileInfoModal.tooLarge = true;
                } else {
                    this.fileInfoModal.needsLoad = true;
                }
                return;
            }
            
            this.fileInfoModal = { show: true, file: file, typeName: typeData.n, ext: typeData.ext || '', svgIcon: typeData.i, bgColor: typeData.c, isMedia: isMedia, mediaHtml: mediaHtml, isLarge: isLarge, isPreviewLoading: false };
            if (playerTarget) {
                setTimeout(() => {
                    if (this.plyrInstance) this.plyrInstance.destroy();
                    const plyrOpts = playerTarget.type === 'audio'
                        ? { controls: ['play-large', 'play', 'progress', 'current-time', 'duration', 'mute', 'settings'], settings: ['speed'], speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] } }
                        : { ratio: '16:9', controls: ['play-large', 'play', 'progress', 'current-time', 'duration', 'mute', 'settings', 'fullscreen'], settings: ['speed'], speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] } };
                    this.plyrInstance = new Plyr(playerTarget.el, plyrOpts);
                }, 50);
            }
        },
        async loadFilePreview() {
            this.fileInfoModal.needsLoad = false;
            const file = this.fileInfoModal.file;
            const ext = file.filename.split('.').pop().toLowerCase();
            const streamUrl = `/api/files/${file.id}/stream`;
            const langMap = { 'js': 'javascript', 'json': 'json', 'py': 'python', 'go': 'go', 'html': 'markup', 'css': 'css', 'yml': 'yaml', 'yaml': 'yaml', 'sql': 'sql', 'sh': 'bash', 'md': 'markdown' };

            this.fileInfoModal.isPreviewLoading = true;
            this.fileInfoModal.isMedia = false;

            try {
                const response = await fetch(streamUrl, { headers: { 'Range': 'bytes=0-262144' } });
                if (!response.ok && response.status !== 206) throw new Error("Failed to fetch");
                const content = await response.text();
                
                let mediaHtml = '';
                if (ext === 'md') {
                    mediaHtml = `<div class="text-preview-container markdown-preview">${this.parseMarkdown(content)}</div>`;
                } else {
                    const lang = langMap[ext] || 'none';
                    mediaHtml = `<div class="text-preview-container"><pre><code class="language-${lang}">${content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre></div>`;
                }
                this.fileInfoModal.mediaHtml = mediaHtml;
                this.fileInfoModal.isMedia = true;
                
                if (ext !== 'md' && window.Prism) {
                    setTimeout(() => Prism.highlightAllUnder(document.querySelector('.text-preview-container')), 50);
                }
            } catch (e) {
                console.error("Preview failed", e);
                this.fileInfoModal.mediaHtml = `<div class="p-4 text-center text-red-500 text-sm">${this.t('preview_error')}</div>`;
                this.fileInfoModal.isMedia = true;
            } finally {
                this.fileInfoModal.isPreviewLoading = false;
            }
        },

        async fetchPasskeys() {
            try {
                const resp = await fetch('/api/passkeys');
                this.passkeys = (await resp.json()) || [];
            } catch (err) {
                console.error('Failed to fetch passkeys', err);
                this.passkeys = [];
            }
        },

        async registerPasskey() {
            if (!this.webauthnRPID) {
                this.showToast(this.t('err_passkey_not_configured'), 'error');
                if (this.isAdmin) this.currentTab = 'settings';
                return;
            }
            if (!window.PublicKeyCredential) {
                this.showToast(this.t('passkey_not_supported'), 'error');
                return;
            }

            const name = await this.customPrompt(this.t('passkey_name_prompt'), "My Passkey");
            if (!name) return;

            try {
                const beginResp = await fetch('/api/passkey/register/begin');
                const options = await beginResp.json();
                
                if (options.error) throw new Error(options.error);

                // Prepare options
                const bufferToBase64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
                const base64ToBuffer = (base64) => {
                    const binary = atob(base64.replace(/-/g, "+").replace(/_/g, "/"));
                    const buffer = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) buffer[i] = binary.charCodeAt(i);
                    return buffer.buffer;
                };

                options.publicKey.challenge = base64ToBuffer(options.publicKey.challenge);
                options.publicKey.user.id = base64ToBuffer(options.publicKey.user.id);
                if (options.publicKey.excludeCredentials) {
                    options.publicKey.excludeCredentials.forEach(c => c.id = base64ToBuffer(c.id));
                }

                const credential = await navigator.credentials.create(options);
                
                const finishResp = await fetch('/api/passkey/register/finish?name=' + encodeURIComponent(name), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': TeleCloud.getCsrfToken() },
                    body: JSON.stringify({
                        id: credential.id,
                        rawId: bufferToBase64(credential.rawId),
                        type: credential.type,
                        response: {
                            attestationObject: bufferToBase64(credential.response.attestationObject),
                            clientDataJSON: bufferToBase64(credential.response.clientDataJSON),
                            transports: credential.response.getTransports ? credential.response.getTransports() : []
                        }
                    })
                });

                const result = await finishResp.json();
                if (result.status === 'success') {
                    this.showToast(this.t('passkey_registered'), 'success');
                    this.fetchPasskeys();
                } else {
                    throw new Error(result.error || this.t('err_passkey_reg_failed'));
                }
            } catch (err) {
                if (err.name === 'AbortError' || err.name === 'NotAllowedError') return;
                console.error(err);
                this.showToast(this.t('passkey_error') + ': ' + err.message, 'error');
            }
        },

        async deletePasskey(id) {
            const ok = await this.customConfirm(this.t('delete_confirm_title'), this.t('delete_confirm_msg'), true);
            if (!ok) return;

            try {
                const resp = await fetch('/api/passkeys/' + id, {
                    method: 'DELETE',
                    headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() }
                });
                const result = await resp.json();
                if (result.status === 'success') {
                    this.showToast(this.t('passkey_deleted'), 'success');
                    this.fetchPasskeys();
                } else {
                    throw new Error(result.error);
                }
            } catch (err) {
                this.showToast(this.t('passkey_error'), 'error');
            }
        },

        async renamePasskey(id, currentName) {
            const newName = await this.customPrompt(this.t('passkey_name_prompt'), currentName || "");
            if (!newName || newName === currentName) return;

            try {
                const fd = new FormData();
                fd.append('name', newName);
                const resp = await fetch(`/api/passkeys/${id}/rename`, {
                    method: 'POST',
                    headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() },
                    body: fd
                });
                const result = await resp.json();
                if (result.status === 'success') {
                    this.showToast(this.t('passkey_renamed'), 'success');
                    this.fetchPasskeys();
                } else {
                    throw new Error(result.error);
                }
            } catch (err) {
                this.showToast(this.t('passkey_error'), 'error');
            }
        },
        async fetchYTDLPStatus() {
            try {
                const res = await fetch('/api/ytdlp/status');
                if (res.ok) {
                    const data = await res.json();
                    this.ytdlpEnabled = data.enabled;
                }
            } catch (e) { console.error('Failed to fetch ytdlp status', e); }
        },
        async checkYTDLPCookies() {
            try {
                const res = await fetch('/api/ytdlp/cookies/status');
                const d = await res.json();
                this.ytdlpHasCookie = d.has_cookie;
            } catch (e) {
                console.error('Failed to check cookies:', e);
            }
        },
        async uploadYTDLPCookies(e) {
            const file = e.target.files[0];
            if (!file) return;

            let fd = new FormData();
            fd.append('cookie_file', file);
            try {
                const res = await fetch('/api/ytdlp/cookies', { 
                    method: 'POST', 
                    body: fd, 
                    headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() } 
                });
                if (res.ok) {
                    this.ytdlpHasCookie = true;
                    this.showToast(this.t('toast_success'), 'success');
                } else {
                    const d = await res.json();
                    this.showToast(this.handleCommonError(d.error, 'upload_failed'), 'error');
                }
            } catch (e) {
                this.showToast(this.t('conn_error'), 'error');
            } finally {
                e.target.value = ''; // Reset input
            }
        },
        async removeYTDLPCookies() {
            try {
                const res = await fetch('/api/ytdlp/cookies', { 
                    method: 'DELETE', 
                    headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() } 
                });
                if (res.ok) {
                    this.ytdlpHasCookie = false;
                    this.showToast(this.t('toast_success'), 'success');
                } else {
                    this.showToast(this.t('status_error'), 'error');
                }
            } catch (e) {
                this.showToast(this.t('conn_error'), 'error');
            }
        },
        async fetchYTDLPFormats() {
            if (!this.ytdlpUrl) return;
            
            // Basic URL validation
            try {
                new URL(this.ytdlpUrl);
            } catch (e) {
                this.showToast(this.t('invalid_url'), 'error');
                return;
            }

            this.ytdlpLoading = true;
            this.ytdlpInfo = null;
            let fd = new FormData();
            fd.append('url', this.ytdlpUrl);
            try {
                const res = await fetch('/api/ytdlp/formats', { method: 'POST', body: fd, headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() } });
                const d = await res.json();
                if (res.ok) {
                    this.ytdlpInfo = d;
                    if (this.ytdlpInfo.formats && this.ytdlpInfo.formats.length > 0) {
                        this.ytdlpSelectedFormat = ''; // Default to best
                    }
                } else {
                    let errorMsg = d.error || 'ytdlp_error';
                    // Simplify complex yt-dlp error messages for the user
                    if (errorMsg.includes('Unsupported URL')) errorMsg = 'err_unsupported_url';
                    else if (errorMsg.includes('Unable to download webpage')) errorMsg = 'err_network_error';
                    else if (errorMsg.includes('Video unavailable')) errorMsg = 'err_video_unavailable';
                    
                    this.showToast(this.handleCommonError(errorMsg, 'ytdlp_error'), 'error');
                }
            } catch (e) {
                this.showToast(this.t('conn_error'), 'error');
            } finally {
                this.ytdlpLoading = false;
            }
        },
        async submitYTDLPDownload() {
            if (!this.ytdlpUrl) return;
            let fd = new FormData();
            fd.append('url', this.ytdlpUrl);
            fd.append('format_id', this.ytdlpSelectedFormat);
            fd.append('download_type', this.ytdlpDownloadType);
            fd.append('path', this.currentPath);
            try {
                const res = await fetch('/api/ytdlp/download', { method: 'POST', body: fd, headers: { 'X-CSRF-Token': TeleCloud.getCsrfToken() } });
                if (res.ok) {
                    const data = await res.json();
                    this.uploadQueue.push({
                        id: data.task_id,
                        name: this.ytdlpInfo ? this.ytdlpInfo.title : 'Media Download',
                        progress: 0,
                        statusText: this.t('initiating_ytdlp'),
                        hasError: false,
                        isCancelled: false,
                        size: 0,
                        startTime: Date.now(),
                        uploadedBytes: 0,
                        speed: 0
                    });
                    this.showToast(this.t('ytdlp_started'), 'success');
                    this.ytdlpUrl = '';
                    this.ytdlpInfo = null;
                } else {
                    const d = await res.json();
                    this.showToast(this.handleCommonError(d.error, 'ytdlp_error'), 'error');
                }
            } catch (e) {
                this.showToast(this.t('conn_error'), 'error');
            }
        }
    }
}

function shareApp(shareToken) {
    return {
        shareToken: shareToken,
        currentTab: 'files',
        viewMode: localStorage.getItem('viewMode') || 'list',
        toggleViewMode() {
            this.viewMode = this.viewMode === 'list' ? 'grid' : 'list';
            localStorage.setItem('viewMode', this.viewMode);
        },
        sortBy: 'name',
        sortOrder: 'asc',
        isLoading: false, 
        isRefreshing: false,
        isPreparingDownload: false,
        lang: TeleCloud.lang,
        toastModal: { show: false, message: '', type: 'success' },
        showToast(msg, type = 'success') {
            if (this.toastTimeout) clearTimeout(this.toastTimeout);
            this.toastModal = { show: true, message: msg, type: type };
            this.toastTimeout = setTimeout(() => { this.toastModal.show = false; }, 3500);
        },
        t(key, params) { return TeleCloud.t(key, params, this.lang); },
        formatBytes(b, d) { return TeleCloud.formatBytes(b, d); },
        formatDate(d) { return TeleCloud.formatDate(d, this.lang); },
        getFileTypeData(f) { return TeleCloud.getFileTypeData(f); },
        parseMarkdown(t) { return TeleCloud.parseMarkdown(t); },
        async toggleLang() { 
            this.lang = await TeleCloud.toggleLang();
        },
        async setLang(code) {
            this.lang = await TeleCloud.setLang(code);
        },
        
        startDownload(fileId) {
            this.isPreparingDownload = true;
            document.cookie = "dl_started=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
            const iframe = document.createElement('iframe');
            iframe.style.display = 'none';
            iframe.src = `/s/${this.shareToken}/file/${fileId}/dl`;
            document.body.appendChild(iframe);
            let checkCookie = setInterval(() => {
                if (document.cookie.includes('dl_started=1')) {
                    clearInterval(checkCookie);
                    this.isPreparingDownload = false;
                    document.cookie = "dl_started=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
                    setTimeout(() => iframe.remove(), 2000); 
                }
            }, 500);
            setTimeout(() => {
                if (this.isPreparingDownload) {
                    clearInterval(checkCookie);
                    this.isPreparingDownload = false;
                    iframe.remove();
                }
            }, 15000);
        },

        async downloadSelectedBatch() {
            const fileIdsToDownload = this.selectedIds.map(Number).filter(id => {
                const f = this.files.find(file => file.id === id);
                return f && !f.is_folder;
            });
            if (fileIdsToDownload.length === 0) {
                return;
            }
            this.isPreparingDownload = true;
            document.cookie = "dl_started=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
            for (let i = 0; i < fileIdsToDownload.length; i++) {
                const fileId = fileIdsToDownload[i];
                const iframe = document.createElement('iframe');
                iframe.style.display = 'none';
                iframe.src = `/s/${this.shareToken}/file/${fileId}/dl`;
                document.body.appendChild(iframe);
                if (i === 0) {
                    let checkCookie = setInterval(() => {
                        if (document.cookie.includes('dl_started=1')) {
                            clearInterval(checkCookie);
                            this.isPreparingDownload = false;
                            document.cookie = "dl_started=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
                        }
                    }, 500);
                    setTimeout(() => { if (this.isPreparingDownload) this.isPreparingDownload = false; }, 15000);
                }
                setTimeout(() => iframe.remove(), 20000);
                if (i < fileIdsToDownload.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 1500));
                }
            }
            this.selectedIds = [];
        },

        files: [], 
        searchQuery: '',
        currentPage: 1,
        itemsPerPage: 15,
        get filteredFiles() {
            let results = [...this.files];
            if (this.searchQuery.trim() !== '') {
                const query = this.searchQuery.toLowerCase();
                results = results.filter(f => f.filename.toLowerCase().includes(query));
            }

            return results.sort((a, b) => {
                if (a.is_folder && !b.is_folder) return -1;
                if (!a.is_folder && b.is_folder) return 1;

                let valA, valB;
                if (this.sortBy === 'name') {
                    valA = a.filename.toLowerCase();
                    valB = b.filename.toLowerCase();
                } else if (this.sortBy === 'date') {
                    valA = new Date(a.created_at).getTime() || 0;
                    valB = new Date(b.created_at).getTime() || 0;
                } else if (this.sortBy === 'size') {
                    valA = a.size || 0;
                    valB = b.size || 0;
                }

                if (valA < valB) return this.sortOrder === 'asc' ? -1 : 1;
                if (valA > valB) return this.sortOrder === 'asc' ? 1 : -1;
                return 0;
            });
        },
        toggleSort(field) {
            if (this.sortBy === field) {
                this.sortOrder = this.sortOrder === 'asc' ? 'desc' : 'asc';
            } else {
                this.sortBy = field;
                this.sortOrder = 'asc';
            }
        },
        get totalPages() {
            return Math.ceil(this.filteredFiles.length / this.itemsPerPage) || 1;
        },
        get displayedFiles() {
            const start = (this.currentPage - 1) * this.itemsPerPage;
            const end = start + this.itemsPerPage;
            return this.filteredFiles.slice(start, end);
        },
        currentPath: '/', 
        openMenuId: null,
        selectedIds: [], 

        plyrInstance: null,
        fileInfoModal: { show: false, file: null, typeName: '', ext: '', svgIcon: '', bgColor: '', isMedia: false, mediaHtml: '', isLarge: false, isPreviewLoading: false, needsLoad: false, tooLarge: false },
        contextMenu: { show: false, x: 0, y: 0, file: null },
        
        init() { 
            window.addEventListener('tc-translations-loaded', (e) => {
                this.lang = '';
                this.$nextTick(() => { this.lang = e.detail.lang; });
            });
            TeleCloud.initTheme('system');

            this.fetchFiles(false);
        },
        openContextMenu(e, file) {
            if (!file) return; 
            this.contextMenu.file = file;
            let x = e.clientX; let y = e.clientY;
            if (window.innerWidth - x < 210) x = window.innerWidth - 210;
            if (window.innerHeight - y < 250) y = window.innerHeight - 250;
            this.contextMenu.x = x;
            this.contextMenu.y = y;
            this.contextMenu.show = true;
        },
        closeContextMenu() { this.contextMenu.show = false; },
        getBreadcrumbs() { return this.currentPath === '/' ? [] : this.currentPath.split('/').filter(Boolean); },
        navigateToFolder(folderName) { this.currentPath = this.currentPath === '/' ? '/' + folderName : this.currentPath + '/' + folderName; this.fetchFiles(); },
        navigateToIndex(index) { this.currentPath = '/' + this.getBreadcrumbs().slice(0, index + 1).join('/'); this.fetchFiles(); },
        navigateTo(path) { this.currentPath = path; this.fetchFiles(); },
        async fetchFiles(silentLoad = false) {
            if (!silentLoad && (!this.files || this.files.length === 0)) { this.isLoading = true; } else { this.isRefreshing = true; }
            try {
                const res = await fetch(`/s/${this.shareToken}/api/files?path=${encodeURIComponent(this.currentPath)}`);
                const data = await res.json();
                this.files = data.files || [];
                this.selectedIds = this.selectedIds.filter(id => this.files.some(f => f.id === id));
                if (!silentLoad) { this.searchQuery = ''; this.currentPage = 1; } else { if (this.currentPage > this.totalPages) this.currentPage = Math.max(1, this.totalPages); }
            } catch (e) { console.error('Fetch error', e); } finally { this.isLoading = false; this.isRefreshing = false; }
        },
        
        closeFileInfoModal() {
            this.fileInfoModal.show = false;
            if (this.plyrInstance) { this.plyrInstance.destroy(); this.plyrInstance = null; }
            setTimeout(() => { if (!this.fileInfoModal.show) { this.fileInfoModal.isMedia = false; this.fileInfoModal.mediaHtml = ''; this.fileInfoModal.isLarge = false; this.fileInfoModal.isPreviewLoading = false; this.fileInfoModal.needsLoad = false; this.fileInfoModal.tooLarge = false; } }, 300);
        },
        async showFileInfo(file) {
            if (file.is_folder) return;
            const typeData = this.getFileTypeData(file.filename);
            const ext = file.filename.split('.').pop().toLowerCase();
            const imgExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'heic', 'heif'];
            const videoExts = ['mp4', 'webm', 'ogg', 'mov', 'mkv', 'ogv', '3gp', 'flv', 'wmv'];
            const audioExts = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'opus', 'oga', 'aac', 'm4b'];
            const textExts = ['txt', 'md', 'log', 'json', 'js', 'py', 'go', 'html', 'css', 'yml', 'yaml', 'sql', 'sh', 'conf', 'ini', 'c', 'cpp', 'h', 'hpp', 'cs', 'java', 'rb', 'rs', 'swift'];
            
            const mimeTypes = { 
                'mp4': 'video/mp4', 'webm': 'video/webm', 'ogg': 'video/ogg', 'ogv': 'video/ogg',
                'mov': 'video/mp4', 'mkv': 'video/webm', 'mp3': 'audio/mpeg', 'wav': 'audio/wav', 
                'flac': 'audio/flac', 'm4a': 'audio/mp4', 'opus': 'audio/ogg', 'oga': 'audio/ogg',
                'aac': 'audio/aac', 'm4b': 'audio/mp4'
            };
            let isMedia = false; let mediaHtml = ''; let playerTarget = null;
            let isLarge = false;
            const streamUrl = `/s/${this.shareToken}/file/${file.id}/stream`;
            const thumbUrl = `/s/${this.shareToken}/file/${file.id}/thumb`;
            
            if (imgExts.includes(ext)) { 
                mediaHtml = '<img src="' + streamUrl + '" alt="' + file.filename + '" class="max-h-64 object-contain rounded-[1rem] w-full shadow-md">'; 
                isMedia = true; 
            } else if (videoExts.includes(ext)) {
                const typeAttr = mimeTypes[ext] || 'video/mp4';
                mediaHtml = '<div class="w-full relative z-20 rounded-[1rem] bg-black shadow-md"><video id="index-tele-player" playsinline controls preload="none" ' + (file.has_thumb ? 'data-poster="' + thumbUrl + '"' : '') + '><source src="' + streamUrl + '" type="' + typeAttr + '"></video></div>';
                isMedia = true; playerTarget = { el: '#index-tele-player', type: 'video' };
            } else if (audioExts.includes(ext)) {
                const typeAttr = mimeTypes[ext] || 'audio/mpeg';
                mediaHtml = '<div class="w-full relative z-20 rounded-[1rem] p-2 sm:p-4 bg-slate-100 dark:bg-slate-800/50 shadow-inner">' + (file.has_thumb ? '<img src="' + thumbUrl + '" class="w-32 h-32 mx-auto rounded-2xl mb-4 object-cover shadow-md">' : '<div class="w-32 h-32 mx-auto rounded-2xl mb-4 flex items-center justify-center bg-white dark:bg-slate-700 shadow-sm"><i class="fa-solid fa-music text-5xl text-slate-300 dark:text-slate-500"></i></div>') + '<audio id="index-tele-player" controls preload="none"><source src="' + streamUrl + '" type="' + typeAttr + '"></audio></div>';
                isMedia = true; playerTarget = { el: '#index-tele-player', type: 'audio' };
            } else if (textExts.includes(ext)) {
                this.fileInfoModal = { show: true, file: file, typeName: typeData.n, ext: typeData.ext || '', svgIcon: typeData.i, bgColor: typeData.c, isMedia: false, mediaHtml: '', isLarge: true, isPreviewLoading: false, needsLoad: false, tooLarge: false };
                
                if (file.size > 10 * 1024 * 1024) {
                    this.fileInfoModal.tooLarge = true;
                } else {
                    this.fileInfoModal.needsLoad = true;
                }
                return;
            }
            
            this.fileInfoModal = { show: true, file: file, typeName: typeData.n, ext: typeData.ext || '', svgIcon: typeData.i, bgColor: typeData.c, isMedia: isMedia, mediaHtml: mediaHtml, isLarge: isLarge, isPreviewLoading: false };
            if (playerTarget) {
                setTimeout(() => {
                    if (this.plyrInstance) this.plyrInstance.destroy();
                    const plyrOpts = playerTarget.type === 'audio'
                        ? { controls: ['play-large', 'play', 'progress', 'current-time', 'duration', 'mute', 'settings'], settings: ['speed'], speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] } }
                        : { ratio: '16:9', controls: ['play-large', 'play', 'progress', 'current-time', 'duration', 'mute', 'settings', 'fullscreen'], settings: ['speed'], speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] } };
                    this.plyrInstance = new Plyr(playerTarget.el, plyrOpts);
                }, 50);
            }
        },
        async loadFilePreview() {
            this.fileInfoModal.needsLoad = false;
            const file = this.fileInfoModal.file;
            const ext = file.filename.split('.').pop().toLowerCase();
            const streamUrl = `/s/${this.shareToken}/file/${file.id}/stream`;
            const langMap = { 'js': 'javascript', 'json': 'json', 'py': 'python', 'go': 'go', 'html': 'markup', 'css': 'css', 'yml': 'yaml', 'yaml': 'yaml', 'sql': 'sql', 'sh': 'bash', 'md': 'markdown' };

            this.fileInfoModal.isPreviewLoading = true;
            this.fileInfoModal.isMedia = false;

            try {
                const response = await fetch(streamUrl, { headers: { 'Range': 'bytes=0-262144' } });
                if (!response.ok && response.status !== 206) throw new Error("Failed to fetch");
                const content = await response.text();
                
                let mediaHtml = '';
                if (ext === 'md') {
                    mediaHtml = `<div class="text-preview-container markdown-preview">${this.parseMarkdown(content)}</div>`;
                } else {
                    const lang = langMap[ext] || 'none';
                    mediaHtml = `<div class="text-preview-container"><pre><code class="language-${lang}">${content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre></div>`;
                }
                this.fileInfoModal.mediaHtml = mediaHtml;
                this.fileInfoModal.isMedia = true;
                
                if (ext !== 'md' && window.Prism) {
                    setTimeout(() => Prism.highlightAllUnder(document.querySelector('.text-preview-container')), 50);
                }
            } catch (e) {
                console.error("Preview failed", e);
                this.fileInfoModal.mediaHtml = `<div class="p-4 text-center text-red-500 text-sm">${this.t('preview_error')}</div>`;
                this.fileInfoModal.isMedia = true;
            } finally {
                this.fileInfoModal.isPreviewLoading = false;
            }
        }
    }
}