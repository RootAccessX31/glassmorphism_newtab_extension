// --- ANTI-FLASH INJECTION (Executes instantly to hide the dark-blue screen if video/image is selected) ---
(function preventBackgroundFlash() {
    const cachedBgType = localStorage.getItem('cachedBgType') || 'image';
    if (cachedBgType === 'image' || cachedBgType === 'video') {
        const style = document.createElement('style');
        style.innerHTML = '#bg-color { display: none !important; }';
        if (document.head) document.head.appendChild(style);
        else document.documentElement.appendChild(style);
    }
})();

// --- 1. Fast IndexedDB Wrapper (Native ArrayBuffer) ---
const DB_NAME = 'DashboardMediaDB';

function initDB() {
    return new Promise((resolve) => {
        try {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('media')) {
                    db.createObjectStore('media');
                }
            };
            req.onsuccess = (e) => resolve(e.target.result);
            req.onerror = () => resolve(null);
        } catch (e) {
            resolve(null);
        }
    });
}

async function saveMediaBlob(key, blob) {
    const db = await initDB();
    if (!db) return;
    try {
        const buffer = await blob.arrayBuffer(); // Extremely fast binary storage
        const type = blob.type;
        return new Promise(resolve => {
            try {
                const tx = db.transaction('media', 'readwrite');
                tx.objectStore('media').put({ buffer, type }, key);
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            } catch (e) { resolve(); }
        });
    } catch (e) {
        console.error("Failed to save media buffer", e);
    }
}

async function getMediaBlob(key) {
    const db = await initDB();
    if (!db) return null;
    return new Promise(resolve => {
        try {
            const req = db.transaction('media').objectStore('media').get(key);
            req.onsuccess = () => {
                const res = req.result;
                if (res && res.buffer) {
                    resolve(new Blob([res.buffer], { type: res.type })); // Fast binary reassembly
                } else if (res) {
                    resolve(res); 
                } else {
                    resolve(null);
                }
            };
            req.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
    });
}

// Start fetching media immediately before the rest of the script loads
let preloadedMediaPromise = getMediaBlob('customBg').catch(() => null);

// --- 2. State & Defaults ---
const defaultShortcuts = [
    { id: 's_1', name: 'YouTube', url: 'https://youtube.com', customIcon: '' },
    { id: 's_2', name: 'Gmail', url: 'https://mail.google.com', customIcon: '' },
    { id: 's_3', name: 'Telegram', url: 'https://web.telegram.org', customIcon: '' },
    { id: 's_4', name: 'WhatsApp', url: 'https://web.whatsapp.com', customIcon: '' },
    { id: 's_5', name: 'Twitter', url: 'https://x.com', customIcon: '' },
    { id: 's_6', name: 'Discord', url: 'https://discord.com/app', customIcon: '' }
];

const defaultBgState = {
    type: 'image', 
    color: '#1a1a2e',
    brightness: 100,
    blur: false,
    posX: 0,
    posY: 0,
    rotation: 0,
    soundEnabled: false 
};

const defaultState = {
    bg: defaultBgState,
    dockBlur: 20,
    showShortcuts: true,
    adaptiveIcons: true,
    shortcuts: defaultShortcuts,
    widgets: [
        { id: 'w_clock', type: 'clock', x: 100, y: 100, width: 350, height: 150, op: 0.1, color: '255,255,255', blur: 15, borderOp: 0.2, radius: 24 },
        { id: 'w_search', type: 'search', x: 500, y: 100, width: 600, height: 64, op: 0.1, color: '255,255,255', blur: 15, borderOp: 0.2, radius: 32 }
    ]
};

let appState = JSON.parse(JSON.stringify(defaultState));
let isEditing = false;
let selectedWidgetId = null;

let isDragging = false, isResizing = false, isDraggingPanel = false;
let currentW = null, startX, startY, startWx, startWy, startWw, startWh;
let pStartX, pStartY, pStartMouseX, pStartMouseY;

let modalBlob = null;
let modalMediaType = 'image';
let modalStaging = {
    brightness: 100,
    blur: false,
    posX: 0,
    posY: 0,
    rotation: 0,
    soundEnabled: false
};
let isDraggingCrop = false;
let cropMouseStartX = 0, cropMouseStartY = 0, cropStartPosX = 0, cropStartPosY = 0;

const FEEDBACK_API_URL = 'http://localhost:5000/api/feedback';

// --- 3. Synchronous Loading Initialization ---
async function init() {
    chrome.storage.local.get(['dashboardState'], async (res) => {
        try {
            if (res && res.dashboardState) {
                appState = Object.assign({}, defaultState, res.dashboardState);
                if (!appState.shortcuts || appState.shortcuts.length === 0) appState.shortcuts = JSON.parse(JSON.stringify(defaultShortcuts));
                if (!appState.widgets || appState.widgets.length === 0) appState.widgets = JSON.parse(JSON.stringify(defaultState.widgets));
            }

            // Sync visual controls
            applyDockBlur();
            applyShortcutsVisibility();
            applyAdaptiveIcons();

            // AWAIT the background to load synchronously to perfectly align UI and Background
            await applyBackground();

            // Instantly render UI directly over the ready background
            renderWorkspace();
            renderShortcutsBar();
            renderEditShortcutsList();
            setupClockTick();
            setInterval(setupClockTick, 1000);
            bindUI();
            bindModalUI();
        } catch (err) {
            console.error("Init Error:", err);
            renderWorkspace();
            renderShortcutsBar();
            bindUI();
        }
    });
}

function saveState() {
    chrome.storage.local.set({ dashboardState: appState });
}

function applyDockBlur() {
    document.documentElement.style.setProperty('--dock-blur', (appState.dockBlur || 20) + 'px');
}

function applyShortcutsVisibility() {
    const dock = document.getElementById('widget-shortcuts');
    if (dock) {
        dock.style.display = appState.showShortcuts !== false ? 'flex' : 'none';
    }
}

function applyAdaptiveIcons() {
    const isAdaptive = appState.adaptiveIcons !== false;
    document.querySelectorAll('.shortcut-icon img').forEach(img => {
        img.style.filter = isAdaptive ? 'grayscale(0.2) contrast(1.1)' : 'none';
    });
}

// --- 4. Background Rendering ---
async function applyBackground() {
    try {
        const b = appState.bg || defaultBgState;
        const bgColor = document.getElementById('bg-color');
        const imgEl = document.getElementById('bg-image');
        const vidEl = document.getElementById('bg-video');

        if (!bgColor || !imgEl || !vidEl) return;

        if (b.type === 'color') {
            bgColor.style.display = 'block';
            bgColor.style.backgroundColor = b.color || '#1a1a2e';
            imgEl.style.display = 'none';
            vidEl.pause();
            vidEl.style.display = 'none';
        } else {
            bgColor.style.display = 'none'; // Force hide solid color
            
            const mediaData = await preloadedMediaPromise || await getMediaBlob('customBg');
            preloadedMediaPromise = null;

            const activeEl = b.type === 'image' ? imgEl : vidEl;
            const inactiveEl = b.type === 'image' ? vidEl : imgEl;

            inactiveEl.style.display = 'none';
            if (inactiveEl.tagName === 'VIDEO') inactiveEl.pause();

            if (activeEl) {
                if (mediaData && mediaData instanceof Blob) {
                    activeEl.src = URL.createObjectURL(mediaData);
                } else if (b.type === 'image') {
                    activeEl.src = 'image_4af89b.jpg';
                }

                if (b.type === 'video' && vidEl) {
                    vidEl.muted = !b.soundEnabled;
                    vidEl.play().catch(() => {});
                }

                activeEl.style.display = 'block';
                activeEl.style.filter = `brightness(${b.brightness || 100}%) ${b.blur ? 'blur(16px)' : ''}`;
                activeEl.style.transform = `translate(calc(-50% + ${b.posX || 0}px), calc(-50% + ${b.posY || 0}px)) rotate(${b.rotation || 0}deg) scale(1.15)`;
            }
        }
    } catch (err) {
        console.error("Background render error:", err);
    }
}

// --- 5. Workspace & Widgets ---
function renderWorkspace() {
    const ws = document.getElementById('workspace');
    if (!ws) return;
    const currentIds = appState.widgets.map(w => w.id);

    Array.from(ws.children).forEach(child => {
        if (child.id !== 'widget-ai-tools' && child.id !== 'widget-shortcuts') {
            if (!currentIds.includes(child.id)) ws.removeChild(child);
        }
    });

    appState.widgets.forEach(w => {
        let el = document.getElementById(w.id);
        let isNew = false;

        if (!el) {
            isNew = true;
            el = document.createElement('div');
            el.className = `widget widget-${w.type}`;
            el.id = w.id;
            el.innerHTML = `
                <div class="widget-bg"></div>
                <div class="widget-content"></div>
                <div class="resize-handle"></div>
            `;
            ws.appendChild(el);
        }

        updateWidgetStyle(w);

        if (isNew) {
            rebuildWidgetContent(w, el);
            el.addEventListener('mousedown', (e) => handleDragStart(e, w));
            const handle = el.querySelector('.resize-handle');
            if (handle) {
                handle.addEventListener('mousedown', (e) => handleResizeStart(e, w));
            }
        }
    });
}

function updateWidgetStyle(w) {
    const el = document.getElementById(w.id);
    if (!el) return;
    try {
        el.style.setProperty('--w-x', w.x + 'px');
        el.style.setProperty('--w-y', w.y + 'px');
        el.style.setProperty('--w-width', w.width + 'px');
        el.style.setProperty('--w-height', w.height + 'px');
        el.style.setProperty('--w-bg-opacity', w.op);
        el.style.setProperty('--w-bg-color', w.color);
        el.style.setProperty('--w-blur', w.blur + 'px');
        el.style.setProperty('--w-border-op', w.borderOp);
        el.style.setProperty('--w-radius', w.radius + 'px');
    } catch(e){}
}

function rebuildWidgetContent(w, el = null) {
    if (!el) el = document.getElementById(w.id);
    if (!el) return;

    const contentDiv = el.querySelector('.widget-content');
    if (!contentDiv) return;
    let contentHtml = '';

    if (w.type === 'clock') {
        contentHtml = `<h1 class="clock-time">00:00</h1><p class="clock-date">Date</p>`;
    } else if (w.type === 'search') {
        contentHtml = `
            <div class="search-widget-container">
                <div class="search-g-icon">
                    <svg width="20" height="20" viewBox="0 0 24 24"><path fill="#fff" d="M12.24 10.285V14.4h6.806c-.275 1.765-2.056 5.174-6.806 5.174-4.095 0-7.439-3.389-7.439-7.574s3.345-7.574 7.439-7.574c2.33 0 3.891.989 4.785 1.849l3.254-3.138C18.189 1.186 15.479 0 12.24 0c-6.635 0-12 5.365-12 12s5.365 12 12 12c6.926 0 11.52-4.869 11.52-11.726 0-.788-.085-1.39-.189-1.989H12.24z"/></svg>
                </div>
                <div class="search-divider"></div>
                <form id="form-${w.id}" action="https://www.google.com/search" method="GET" class="search-form">
                    <input type="text" name="q" class="search-input" placeholder="Ask Google" autocomplete="off">
                </form>
                <div class="search-actions">
                    <button class="chrome-ai-btn btn-ai-mode" title="Ask Google AI">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                            <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
                            <path d="M19 5l-1.5 3.5L14 10l3.5 1.5L19 15l1.5-3.5L24 10l-3.5-1.5z"/>
                        </svg>
                        AI Mode
                    </button>
                </div>
            </div>
        `;
    } else if (w.type === 'spotify') {
        const spUrl = w.spUrl || '';
        if (spUrl) {
            contentHtml = `<iframe src="${spUrl}" width="100%" height="100%" frameBorder="0" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy" style="border-radius: ${w.radius}px; pointer-events: auto;"></iframe>`;
        } else {
            contentHtml = `
                <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center; padding: 20px; color: white;">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="#1DB954" style="margin-bottom:12px;"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.84.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.6.18-1.2.72-1.38 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.56.3z"/></svg>
                    <h3 style="margin: 0 0 6px 0; font-size: 1.1rem; font-weight: 600;">Spotify Widget</h3>
                    <p style="margin: 0; font-size: 0.85rem; opacity: 0.8; line-height: 1.4;">Click <b>⚙ Customize</b>, select this widget, and paste your own song or playlist link.</p>
                </div>
            `;
        }
    } else if (w.type === 'todo') {
        const tasks = w.tasks || [];
        let tasksHtml = tasks.map((t, i) => `
            <div class="todo-item ${t.completed ? 'completed' : ''}" data-index="${i}">
                <div class="todo-checkbox"></div>
                <span class="todo-item-text">${t.text}</span>
                <button class="btn-todo-del" title="Delete">✕</button>
            </div>
        `).join('');

        contentHtml = `
            <div class="todo-header">To Do List</div>
            <div class="todo-input-group">
                <input type="text" class="todo-input" placeholder="Add task...">
                <button class="btn-todo-add">+</button>
            </div>
            <div class="todo-list">
                ${tasksHtml}
            </div>
        `;
    } else if (w.type === 'notes') {
        const notes = w.notes || [];
        let notesHtml = notes.map((n, i) => `
            <div class="note-item" data-index="${i}">
                <div class="note-content">
                    <input type="text" class="note-title" value="${n.title}" placeholder="Title">
                    <textarea class="note-text" placeholder="Note text">${n.text}</textarea>
                </div>
                <div class="note-meta">
                    <span class="note-date">${n.date}</span>
                    <button class="btn-note-del">✕</button>
                </div>
            </div>
        `).join('');

        contentHtml = `
            <div class="notes-header">
                <h3>Notes</h3>
                <button class="btn-notes-add">+</button>
            </div>
            <div class="notes-list">
                ${notesHtml}
            </div>
        `;
    }

    contentDiv.innerHTML = contentHtml;

    if (w.type === 'clock') setupClockTick();

    if (w.type === 'todo') {
        const addBtn = el.querySelector('.btn-todo-add');
        const input = el.querySelector('.todo-input');
        const list = el.querySelector('.todo-list');

        const addTask = () => {
            const text = input.value.trim();
            if (text) {
                if (!w.tasks) w.tasks = [];
                w.tasks.push({ text: text, completed: false });
                saveState();
                rebuildWidgetContent(w, el);
            }
        };

        if (addBtn) addBtn.onclick = addTask;
        if (input) input.onkeypress = (e) => { if (e.key === 'Enter') addTask(); };

        if (list) {
            list.onclick = (e) => {
                const item = e.target.closest('.todo-item');
                if (!item) return;
                const index = parseInt(item.dataset.index);

                if (e.target.classList.contains('todo-checkbox')) {
                    w.tasks[index].completed = !w.tasks[index].completed;
                    saveState();
                    rebuildWidgetContent(w, el);
                } else if (e.target.classList.contains('btn-todo-del')) {
                    w.tasks.splice(index, 1);
                    saveState();
                    rebuildWidgetContent(w, el);
                }
            };
        }
    }

    if (w.type === 'notes') {
        const addBtn = el.querySelector('.btn-notes-add');
        const list = el.querySelector('.notes-list');

        if (addBtn) {
            addBtn.onclick = () => {
                if (!w.notes) w.notes = [];
                const d = new Date();
                const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                w.notes.unshift({ title: 'New note', text: '', date: dateStr });
                saveState();
                rebuildWidgetContent(w, el);
            };
        }

        if (list) {
            list.onclick = (e) => {
                const item = e.target.closest('.note-item');
                if (!item) return;
                const index = parseInt(item.dataset.index);

                if (e.target.closest('.btn-note-del')) {
                    w.notes.splice(index, 1);
                    saveState();
                    rebuildWidgetContent(w, el);
                }
            };

            list.addEventListener('input', (e) => {
                const item = e.target.closest('.note-item');
                if (!item) return;
                const index = parseInt(item.dataset.index);

                if (e.target.classList.contains('note-title')) {
                    w.notes[index].title = e.target.value;
                    saveState();
                } else if (e.target.classList.contains('note-text')) {
                    w.notes[index].text = e.target.value;
                    saveState();
                }
            });
        }
    }

    if (w.type === 'search') {
        const aiBtn = el.querySelector('.btn-ai-mode');
        const searchInput = el.querySelector('.search-input');

        if (aiBtn) {
            aiBtn.onclick = (e) => {
                if (isEditing) return;
                e.preventDefault();
                const query = searchInput ? searchInput.value.trim() : '';
                if (query) {
                    window.location.href = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
                } else {
                    window.location.href = 'https://www.google.com/';
                }
            };
        }
    }
}

// --- 6. Shortcuts Bar & Edit View ---
function renderShortcutsBar() {
    const container = document.getElementById('widget-shortcuts');
    if (!container) return;
    container.innerHTML = '';

    if (appState.shortcuts) {
        appState.shortcuts.forEach(s => {
            const link = document.createElement('a');
            link.className = 'shortcut-icon';
            link.href = s.url;
            link.title = s.name;

            let iconSrc = s.customIcon;
            if (!iconSrc) {
                let domain = '#';
                try { domain = new URL(s.url).hostname; } catch(e){}
                iconSrc = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
            }

            link.innerHTML = `<img src="${iconSrc}" alt="${s.name}" onerror="this.style.display='none'">`;
            container.appendChild(link);
        });
    }

    applyAdaptiveIcons();
}

function renderEditShortcutsList() {
    const container = document.getElementById('shortcuts-edit-list');
    if (!container) return;
    container.innerHTML = '';

    if (appState.shortcuts) {
        appState.shortcuts.forEach(s => {
            const card = document.createElement('div');
            card.className = 'shortcut-edit-card';
            card.innerHTML = `
                <div class="drag-handle">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="9" cy="12" r="1.5"/><circle cx="9" cy="6" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>
                </div>
                <div class="shortcut-inputs">
                    <input type="text" class="sc-name" value="${s.name}" data-id="${s.id}" data-key="name">
                    <div class="sc-row"><span class="sc-icon">🌍</span><input type="text" value="${s.url}" data-id="${s.id}" data-key="url"></div>
                    <div class="sc-row"><span class="sc-icon">🖼️</span><input type="text" value="${s.customIcon || ''}" placeholder="Custom Icon URL" data-id="${s.id}" data-key="customIcon"></div>
                </div>
                <div class="shortcut-actions">
                    <button class="btn-up-sc" data-id="${s.id}" title="Upload Icon">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                    </button>
                    <button class="btn-del-sc" data-id="${s.id}" title="Delete">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                </div>
            `;
            container.appendChild(card);
        });
    }

    container.querySelectorAll('input').forEach(input => {
        input.oninput = (e) => {
            const id = e.target.dataset.id;
            const key = e.target.dataset.key;
            const targetSC = appState.shortcuts.find(sc => sc.id === id);
            if (targetSC) targetSC[key] = e.target.value;
            saveState();
            renderShortcutsBar();
        };
    });

    container.querySelectorAll('.btn-up-sc').forEach(btn => {
        btn.onclick = () => {
            const id = btn.dataset.id;
            const targetSC = appState.shortcuts.find(sc => sc.id === id);
            if (!targetSC) return;

            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'image/*';
            fileInput.onchange = (event) => {
                const file = event.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (eReader) => {
                    targetSC.customIcon = eReader.target.result;
                    saveState();
                    renderEditShortcutsList();
                    renderShortcutsBar();
                };
                reader.readAsDataURL(file);
            };
            fileInput.click();
        };
    });

    container.querySelectorAll('.btn-del-sc').forEach(btn => {
        btn.onclick = () => {
            const id = btn.dataset.id;
            appState.shortcuts = appState.shortcuts.filter(sc => sc.id !== id);
            saveState();
            renderEditShortcutsList();
            renderShortcutsBar();
        };
    });
}

function setupClockTick() {
    const now = new Date();
    document.querySelectorAll('.widget-clock').forEach(el => {
        const timeEl = el.querySelector('.clock-time');
        const dateEl = el.querySelector('.clock-date');
        if (timeEl) timeEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (dateEl) dateEl.textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    });
}

// --- 7. Drag & Resize Logic ---
function handleDragStart(e, w) {
    if (!isEditing || e.target.classList.contains('resize-handle')) return;
    if (['INPUT', 'BUTTON', 'TEXTAREA'].includes(e.target.tagName)) return;
    selectWidget(w);
    isDragging = true;
    currentW = w;
    startX = e.clientX; startY = e.clientY;
    startWx = w.x; startWy = w.y;
}

function handleResizeStart(e, w) {
    if (!isEditing) return;
    e.stopPropagation();
    selectWidget(w);
    isResizing = true;
    currentW = w;
    startX = e.clientX; startY = e.clientY;
    startWw = w.width; startWh = w.height;
}

window.addEventListener('mousemove', (e) => {
    if (isDragging && currentW) {
        currentW.x = startWx + (e.clientX - startX);
        currentW.y = startWy + (e.clientY - startY);
        const el = document.getElementById(currentW.id);
        if (el) {
            try {
                el.style.setProperty('--w-x', currentW.x + 'px');
                el.style.setProperty('--w-y', currentW.y + 'px');
            } catch(e){}
        }
    }
    if (isResizing && currentW) {
        currentW.width = Math.max(100, startWw + (e.clientX - startX));
        currentW.height = Math.max(50, startWh + (e.clientY - startY));
        const el = document.getElementById(currentW.id);
        if (el) {
            try {
                el.style.setProperty('--w-width', currentW.width + 'px');
                el.style.setProperty('--w-height', currentW.height + 'px');
            } catch(e){}
        }
    }
    if (isDraggingPanel) {
        const settingsPanel = document.getElementById('settings-panel');
        if (settingsPanel) {
            try {
                settingsPanel.style.left = (pStartX + (e.clientX - pStartMouseX)) + 'px';
                settingsPanel.style.top = (pStartY + (e.clientY - pStartMouseY)) + 'px';
            } catch(e){}
        }
    }
    if (isDraggingCrop) {
        modalStaging.posX = cropStartPosX + (e.clientX - cropMouseStartX);
        modalStaging.posY = cropStartPosY + (e.clientY - cropMouseStartY);
        updateModalPreviewTransform();
    }
});

window.addEventListener('mouseup', () => {
    if (isDragging || isResizing) saveState();
    isDragging = false;
    isResizing = false;
    isDraggingPanel = false;
    isDraggingCrop = false;
});

// --- 8. UI Binding (Connected to Panel) ---
function bindUI() {
    const settingShowShortcuts = document.getElementById('setting-show-shortcuts');
    if (settingShowShortcuts) {
        settingShowShortcuts.checked = appState.showShortcuts !== false;
        settingShowShortcuts.onchange = (e) => {
            appState.showShortcuts = e.target.checked;
            applyShortcutsVisibility();
            saveState();
        };
    }

    const mainView = document.getElementById('main-settings-view');
    const editView = document.getElementById('edit-shortcuts-view');
    const btnOpenEdit = document.getElementById('btn-open-edit-shortcuts');
    const btnBackEdit = document.getElementById('btn-back-shortcuts');

    if (btnOpenEdit && mainView && editView) {
        btnOpenEdit.onclick = () => {
            mainView.classList.add('hidden');
            editView.classList.remove('hidden');
        };
    }
    if (btnBackEdit && mainView && editView) {
        btnBackEdit.onclick = () => {
            editView.classList.add('hidden');
            mainView.classList.remove('hidden');
        };
    }

    const btnAddShortcut = document.getElementById('btn-add-shortcut');
    if (btnAddShortcut) {
        btnAddShortcut.onclick = () => {
            appState.shortcuts.unshift({ id: 's_' + Date.now(), name: 'New Shortcut', url: 'https://', customIcon: '' });
            saveState();
            renderEditShortcutsList();
            renderShortcutsBar();
        };
    }

    const btnResetShortcuts = document.getElementById('btn-reset-shortcuts');
    if (btnResetShortcuts) {
        btnResetShortcuts.onclick = () => {
            appState.shortcuts = JSON.parse(JSON.stringify(defaultShortcuts));
            saveState();
            renderEditShortcutsList();
            renderShortcutsBar();
        };
    }

    const settingAdaptiveIcons = document.getElementById('setting-adaptive-icons');
    if (settingAdaptiveIcons) {
        settingAdaptiveIcons.checked = appState.adaptiveIcons !== false;
        settingAdaptiveIcons.onchange = (e) => {
            appState.adaptiveIcons = e.target.checked;
            applyAdaptiveIcons();
            saveState();
        };
    }

    const dockBlurSetting = document.getElementById('setting-dock-blur');
    if (dockBlurSetting) {
        dockBlurSetting.value = appState.dockBlur || 20;
        dockBlurSetting.oninput = (e) => {
            appState.dockBlur = e.target.value;
            applyDockBlur();
            saveState();
        };
    }

    const btnGithub = document.getElementById('btn-github');
    if (btnGithub) {
        btnGithub.onclick = () => window.open('https://github.com/', '_blank');
    }

    const feedbackModal = document.getElementById('feedback-modal');
    const feedbackBtn = document.getElementById('btn-feedback');
    const closeFeedbackBtn = document.getElementById('btn-feedback-close');
    const cancelFeedbackBtn = document.getElementById('btn-feedback-cancel');
    const submitFeedbackBtn = document.getElementById('btn-feedback-submit');
    const starSpans = document.querySelectorAll('#feedback-stars span');
    let selectedRating = 0;

    if (feedbackBtn && feedbackModal) {
        feedbackBtn.onclick = () => {
            feedbackModal.classList.remove('hidden');
            selectedRating = 0;
            starSpans.forEach(s => s.classList.remove('active'));
            document.getElementById('feedback-message').value = '';
            document.getElementById('feedback-email').value = '';
            const status = document.getElementById('feedback-status');
            if (status) status.textContent = '';
        };

        const closeFeedback = () => feedbackModal.classList.add('hidden');
        if (closeFeedbackBtn) closeFeedbackBtn.onclick = closeFeedback;
        if (cancelFeedbackBtn) cancelFeedbackBtn.onclick = closeFeedback;

        starSpans.forEach(star => {
            star.onclick = (e) => {
                selectedRating = parseInt(e.target.dataset.value);
                starSpans.forEach((s, index) => {
                    s.classList.toggle('active', index < selectedRating);
                });
            };
        });

        if (submitFeedbackBtn) {
            submitFeedbackBtn.onclick = async () => {
                const category = document.getElementById('feedback-category').value;
                const message = document.getElementById('feedback-message').value.trim();
                const email = document.getElementById('feedback-email').value.trim();
                const statusMsg = document.getElementById('feedback-status');

                if (selectedRating === 0 || message === '') {
                    statusMsg.textContent = 'Please provide a rating and message.';
                    statusMsg.style.color = '#ff6b6b';
                    return;
                }

                submitFeedbackBtn.disabled = true;
                submitFeedbackBtn.textContent = 'Sending...';

                let extVersion = '1.0.0';
                if (window.chrome && chrome.runtime && chrome.runtime.getManifest) {
                    extVersion = chrome.runtime.getManifest().version;
                }

                try {
                    const res = await fetch(FEEDBACK_API_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ rating: selectedRating, category, message, email, extensionVersion: extVersion })
                    });
                    const data = await res.json();
                    if (data.success) {
                        statusMsg.textContent = 'Thank you for your feedback!';
                        statusMsg.style.color = '#4ade80';
                        setTimeout(closeFeedback, 2000);
                    } else {
                        throw new Error(data.message);
                    }
                } catch (err) {
                    statusMsg.textContent = err.message || 'Network error. Try again.';
                    statusMsg.style.color = '#ff6b6b';
                } finally {
                    submitFeedbackBtn.disabled = false;
                    submitFeedbackBtn.textContent = 'Submit Feedback';
                }
            };
        }
    }

    const editModeBtn = document.getElementById('btn-edit-mode');
    const settingsPanel = document.getElementById('settings-panel');
    if (editModeBtn && settingsPanel) {
        editModeBtn.onclick = () => {
            isEditing = !isEditing;
            document.body.classList.toggle('is-editing', isEditing);
            settingsPanel.classList.toggle('hidden', !isEditing);
            if (isEditing) {
                try {
                    settingsPanel.style.left = 'auto';
                    settingsPanel.style.right = '20px';
                    settingsPanel.style.top = '20px';
                } catch(e){}
            }
            if (!isEditing) deselectWidget();
        };
        const closeSettings = document.getElementById('btn-close-settings');
        if (closeSettings) closeSettings.onclick = () => editModeBtn.click();
    }

    if (settingsPanel) {
        const panelHeader = settingsPanel.querySelector('.panel-header');
        if (panelHeader) {
            panelHeader.addEventListener('mousedown', (e) => {
                if (e.target.closest('#btn-close-settings')) return;
                isDraggingPanel = true;
                const rect = settingsPanel.getBoundingClientRect();
                pStartX = rect.left;
                pStartY = rect.top;
                pStartMouseX = e.clientX;
                pStartMouseY = e.clientY;
                try {
                    settingsPanel.style.right = 'auto';
                    settingsPanel.style.left = pStartX + 'px';
                    settingsPanel.style.top = pStartY + 'px';
                } catch(e){}
            });
        }
    }

    document.querySelectorAll('.mat-card-header').forEach(header => {
        header.onclick = () => {
            const body = header.nextElementSibling;
            const chevron = header.querySelector('.chevron');
            if (body) body.classList.toggle('hidden');
            if (chevron && body) chevron.textContent = body.classList.contains('hidden') ? '▼' : '▲';
        };
    });

    const bgTypeSelect = document.getElementById('setting-bg-type');
    if (bgTypeSelect) {
        bgTypeSelect.value = appState.bg.type;
        bgTypeSelect.onchange = (e) => {
            appState.bg.type = e.target.value;
            localStorage.setItem('cachedBgType', e.target.value); // Cache for instant loads
            saveState();
            applyBackground();
        };
    }

    const btnAdjustBg = document.getElementById('btn-adjust-bg');
    const bgUpload = document.getElementById('setting-bg-upload');

    if (btnAdjustBg) {
        btnAdjustBg.onclick = async () => {
            if (bgUpload && bgUpload.files && bgUpload.files.length > 0) {
                const file = bgUpload.files[0];
                const isVideo = file.type.includes('video') || file.name.endsWith('.mp4');
                openCropModal(file, isVideo ? 'video' : 'image');
                return;
            }

            const blob = await getMediaBlob('customBg');
            if (blob && typeof blob === 'string') {
                openCropModal(blob, appState.bg.type);
            } else {
                fetch('image_4af89b.jpg')
                    .then(r => r.blob())
                    .then(defaultBlob => openCropModal(defaultBlob, 'image'))
                    .catch(() => alert("Please upload an image or video file first."));
            }
        };
    }

    if (bgUpload) {
        bgUpload.onclick = (e) => { e.target.value = null; };
        bgUpload.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const isVideo = file.type.includes('video') || file.name.endsWith('.mp4');
            const mediaType = isVideo ? 'video' : 'image';

            appState.bg.type = mediaType;
            localStorage.setItem('cachedBgType', mediaType); // Cache for instant loads
            if (bgTypeSelect) bgTypeSelect.value = mediaType;

            openCropModal(file, mediaType);
        };
    }

    const btnAddClock = document.getElementById('btn-add-clock');
    if (btnAddClock) btnAddClock.onclick = () => addWidget('clock');
    const btnAddSearch = document.getElementById('btn-add-search');
    if (btnAddSearch) btnAddSearch.onclick = () => addWidget('search');
    const btnAddSpotify = document.getElementById('btn-add-spotify');
    if (btnAddSpotify) btnAddSpotify.onclick = () => addWidget('spotify');
    const btnAddTodo = document.getElementById('btn-add-todo');
    if (btnAddTodo) btnAddTodo.onclick = () => addWidget('todo');
    const btnAddNotes = document.getElementById('btn-add-notes');
    if (btnAddNotes) btnAddNotes.onclick = () => addWidget('notes');

    const btnToggleAi = document.getElementById('btn-toggle-ai');
    const widgetAiTools = document.getElementById('widget-ai-tools');
    const widgetShortcuts = document.getElementById('widget-shortcuts');
    const settingShowAi = document.getElementById('setting-show-ai');

    if (btnToggleAi && widgetAiTools && widgetShortcuts) {
        btnToggleAi.onclick = () => {
            widgetAiTools.classList.toggle('expanded');
            widgetShortcuts.classList.toggle('slide-out-right');
        };
    }

    if (settingShowAi && widgetAiTools) {
        settingShowAi.onchange = (e) => {
            try {
                widgetAiTools.style.display = e.target.checked ? 'flex' : 'none';
            } catch(e){}
        };
    }
}

// --- 9. Media Customizer Modal ---
async function openCropModal(fileOrBase64, type) {
    modalMediaType = type;

    modalStaging = {
        brightness: appState.bg.brightness !== undefined ? appState.bg.brightness : 100,
        blur: appState.bg.blur !== undefined ? appState.bg.blur : false,
        posX: appState.bg.posX !== undefined ? appState.bg.posX : 0,
        posY: appState.bg.posY !== undefined ? appState.bg.posY : 0,
        rotation: appState.bg.rotation !== undefined ? appState.bg.rotation : 0,
        soundEnabled: appState.bg.soundEnabled !== undefined ? appState.bg.soundEnabled : false
    };

    const modal = document.getElementById('media-crop-modal');
    const imgEl = document.getElementById('crop-preview-img');
    const vidEl = document.getElementById('crop-preview-video');

    let renderUrl = '';
    if (typeof fileOrBase64 === 'string') {
        renderUrl = fileOrBase64;
        modalBlob = null;
    } else {
        renderUrl = URL.createObjectURL(fileOrBase64);
        modalBlob = fileOrBase64;
    }

    if (modalMediaType === 'video') {
        if (imgEl) imgEl.style.display = 'none';
        if (vidEl) {
            vidEl.src = renderUrl;
            vidEl.muted = !modalStaging.soundEnabled;
            vidEl.style.display = 'block';
            vidEl.play().catch(() => {});
        }
    } else {
        if (vidEl) {
            vidEl.pause();
            vidEl.style.display = 'none';
        }
        if (imgEl) {
            imgEl.src = renderUrl;
            imgEl.style.display = 'block';
        }
    }

    const brightnessEl = document.getElementById('crop-brightness');
    if (brightnessEl) brightnessEl.value = modalStaging.brightness;
    const valBrightnessEl = document.getElementById('val-crop-brightness');
    if (valBrightnessEl) valBrightnessEl.textContent = `${modalStaging.brightness}%`;

    const blurBtn = document.getElementById('btn-crop-blur');
    if (blurBtn) {
        blurBtn.textContent = modalStaging.blur ? 'Blur: On' : 'Blur: Off';
        blurBtn.classList.toggle('active', modalStaging.blur);
    }

    updateModalPreviewTransform();
    if (modal) modal.classList.remove('hidden');
}

function updateModalPreviewTransform() {
    const activeEl = modalMediaType === 'video' ? document.getElementById('crop-preview-video') : document.getElementById('crop-preview-img');
    if (!activeEl) return;

    try {
        activeEl.style.filter = `brightness(${modalStaging.brightness}%) ${modalStaging.blur ? 'blur(10px)' : ''}`;
        activeEl.style.transform = `translate(${modalStaging.posX}px, ${modalStaging.posY}px) rotate(${modalStaging.rotation}deg) scale(1.15)`;
    } catch(e){}
}

function closeCropModal() {
    const modal = document.getElementById('media-crop-modal');
    if (modal) modal.classList.add('hidden');
    const vidEl = document.getElementById('crop-preview-video');
    if (vidEl) vidEl.pause();
}

function bindModalUI() {
    const viewport = document.getElementById('crop-viewport');
    if (viewport) {
        viewport.addEventListener('mousedown', (e) => {
            isDraggingCrop = true;
            cropMouseStartX = e.clientX;
            cropMouseStartY = e.clientY;
            cropStartPosX = modalStaging.posX;
            cropStartPosY = modalStaging.posY;
        });
    }

    const brightnessInput = document.getElementById('crop-brightness');
    if (brightnessInput) {
        brightnessInput.oninput = (e) => {
            modalStaging.brightness = parseInt(e.target.value);
            const valEl = document.getElementById('val-crop-brightness');
            if (valEl) valEl.textContent = `${modalStaging.brightness}%`;
            updateModalPreviewTransform();
        };
    }

    const blurBtn = document.getElementById('btn-crop-blur');
    if (blurBtn) {
        blurBtn.onclick = () => {
            modalStaging.blur = !modalStaging.blur;
            blurBtn.textContent = modalStaging.blur ? 'Blur: On' : 'Blur: Off';
            blurBtn.classList.toggle('active', modalStaging.blur);
            updateModalPreviewTransform();
        };
    }

    const cropSoundInput = document.getElementById('crop-video-sound');
    if (cropSoundInput) {
        cropSoundInput.onchange = (e) => {
            modalStaging.soundEnabled = e.target.checked;
            const vidEl = document.getElementById('crop-preview-video');
            if (vidEl) vidEl.muted = !modalStaging.soundEnabled;
        };
    }

    const btnCenter = document.getElementById('btn-crop-center');
    if (btnCenter) {
        btnCenter.onclick = () => {
            modalStaging.posX = 0;
            modalStaging.posY = 0;
            updateModalPreviewTransform();
        };
    }

    const btnRotCCW = document.getElementById('btn-crop-rot-ccw');
    if (btnRotCCW) {
        btnRotCCW.onclick = () => {
            modalStaging.rotation = (modalStaging.rotation - 90) % 360;
            updateModalPreviewTransform();
        };
    }
    const btnRotCW = document.getElementById('btn-crop-rot-cw');
    if (btnRotCW) {
        btnRotCW.onclick = () => {
            modalStaging.rotation = (modalStaging.rotation + 90) % 360;
            updateModalPreviewTransform();
        };
    }

    const btnClose = document.getElementById('btn-crop-close');
    if (btnClose) btnClose.onclick = closeCropModal;
    const btnCancel = document.getElementById('btn-crop-cancel');
    if (btnCancel) btnCancel.onclick = closeCropModal;

    const btnApply = document.getElementById('btn-crop-apply');
    if (btnApply) {
        btnApply.onclick = async () => {
            if (modalBlob) {
                await saveMediaBlob('customBg', modalBlob);
            }
            appState.bg.type = modalMediaType;
            appState.bg.brightness = modalStaging.brightness;
            appState.bg.blur = modalStaging.blur;
            appState.bg.posX = modalStaging.posX;
            appState.bg.posY = modalStaging.posY;
            appState.bg.rotation = modalStaging.rotation;
            appState.bg.soundEnabled = modalStaging.soundEnabled;

            const bgTypeSelect = document.getElementById('setting-bg-type');
            if (bgTypeSelect) bgTypeSelect.value = modalMediaType;
            localStorage.setItem('cachedBgType', modalMediaType);

            saveState();
            await applyBackground();
            closeCropModal();
        };
    }
}

// --- 10. Widget Helpers ---
function addWidget(type) {
    let wWidth = 300, wHeight = 100, wRadius = 16, spLink = '', tasks = [], notes = [];
    if (type === 'spotify') { wWidth = 360; wHeight = 352; }
    else if (type === 'todo') { wWidth = 320; wHeight = 350; }
    else if (type === 'search') { wWidth = 600; wHeight = 64; wRadius = 32; }
    else if (type === 'notes') { wWidth = 340; wHeight = 250; }

    const newW = {
        id: 'w_' + Date.now(), type, x: 200, y: 200, width: wWidth, height: wHeight, 
        op: 0.2, color: '255,255,255', blur: 15, borderOp: 0.1, radius: wRadius, spUrl: spLink, tasks, notes
    };
    appState.widgets.push(newW);
    saveState();
    renderWorkspace();
    selectWidget(newW);
}

function selectWidget(w) {
    selectedWidgetId = w.id;
    document.querySelectorAll('.widget').forEach(el => el.classList.remove('selected'));
    const target = document.getElementById(w.id);
    if (target) target.classList.add('selected');

    const editor = document.getElementById('widget-editor');
    if (editor) editor.classList.remove('hidden');

    const spGroup = document.getElementById('spotify-edit-group');
    if (spGroup) {
        if (w.type === 'spotify') {
            spGroup.classList.remove('hidden');
            const spInput = document.getElementById('edit-w-sp-url');
            if (spInput) {
                spInput.value = w.spUrl || '';
                spInput.onchange = (e) => {
                    let val = e.target.value;
                    if (val.includes('spotify.com') && !val.includes('/embed/')) {
                        try {
                            const path = new URL(val).pathname;
                            val = `https://open.spotify.com/embed${path}?theme=0`;
                        } catch(err){}
                    }
                    w.spUrl = val;
                    saveState();
                    rebuildWidgetContent(w);
                    selectWidget(w);
                };
            }
        } else {
            spGroup.classList.add('hidden');
        }
    }

    const keys = { op: 'edit-w-op', blur: 'edit-w-blur', radius: 'edit-w-radius' };
    for (let [prop, id] of Object.entries(keys)) {
        const el = document.getElementById(id);
        if (el) {
            el.value = w[prop] || 0; 
            el.oninput = () => {
                w[prop] = prop === 'op' ? parseFloat(el.value) : parseInt(el.value);
                const valOp = document.getElementById('val-w-op');
                const valRad = document.getElementById('val-w-radius');
                if (prop === 'op' && valOp) valOp.textContent = Math.round(w[prop] * 100);
                if (prop === 'radius' && valRad) valRad.textContent = w[prop];
                updateWidgetStyle(w);
                if (w.type === 'spotify' && prop === 'radius') rebuildWidgetContent(w);
                saveState();
            };
        }
    }

    const valOp = document.getElementById('val-w-op');
    if (valOp) valOp.textContent = Math.round((w.op || 0.2) * 100);
    const valRad = document.getElementById('val-w-radius');
    if (valRad) valRad.textContent = w.radius || 16;

    const btnDel = document.getElementById('btn-delete-widget');
    if (btnDel) {
        btnDel.onclick = () => {
            appState.widgets = appState.widgets.filter(wg => wg.id !== w.id);
            saveState(); 
            renderWorkspace(); 
            deselectWidget();
        };
    }
}

function deselectWidget() {
    selectedWidgetId = null;
    document.querySelectorAll('.widget').forEach(el => el.classList.remove('selected'));
    const editor = document.getElementById('widget-editor');
    if (editor) editor.classList.add('hidden');
}

document.addEventListener('DOMContentLoaded', init);