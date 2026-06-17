# modvc-Run    
MODVC_STATE

TG_TOKEN

TG_CHAT_ID

控制台脚本要把 IndexedDB 里的内容也整个导出来,Playwright 那边要把这些数据原样写回 IndexedDB,再让页面重新加载,Firebase SDK 自己读到 IndexedDB 里有登录态,就会认为已登录
```
(async function () {
  const origin = window.location.origin;

  // 1. localStorage
  const localStorageItems = [];
  for (let i = 0; i < localStorage.length; i++) {
    const name = localStorage.key(i);
    localStorageItems.push({ name, value: localStorage.getItem(name) });
  }

  // 2. sessionStorage
  const sessionStorageItems = [];
  for (let i = 0; i < sessionStorage.length; i++) {
    const name = sessionStorage.key(i);
    sessionStorageItems.push({ name, value: sessionStorage.getItem(name) });
  }

  // 3. 非 HttpOnly 的 Cookie
  const cookies = document.cookie
    .split(';')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const idx = c.indexOf('=');
      return {
        name: c.slice(0, idx),
        value: c.slice(idx + 1),
        domain: window.location.hostname,
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: window.location.protocol === 'https:',
        sameSite: 'Lax',
      };
    });

  // 4. IndexedDB —— Firebase 等登录方式真正存登录态的地方
  async function dumpIndexedDB() {
    if (!('indexedDB' in window) || !indexedDB.databases) return [];
    const dbsMeta = await indexedDB.databases();
    const result = [];

    for (const meta of dbsMeta) {
      if (!meta.name) continue;
      try {
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open(meta.name);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });

        const stores = [];
        for (const storeName of db.objectStoreNames) {
          const tx = db.transaction(storeName, 'readonly');
          const store = tx.objectStore(storeName);

          const indexes = [];
          for (const idxName of store.indexNames) {
            const idx = store.index(idxName);
            indexes.push({ name: idx.name, keyPath: idx.keyPath, unique: idx.unique, multiEntry: idx.multiEntry });
          }

          const records = await new Promise((resolve, reject) => {
            const items = [];
            const cursorReq = store.openCursor();
            cursorReq.onsuccess = (e) => {
              const cursor = e.target.result;
              if (cursor) {
                items.push({ key: cursor.key, value: cursor.value });
                cursor.continue();
              } else {
                resolve(items);
              }
            };
            cursorReq.onerror = () => reject(cursorReq.error);
          });

          stores.push({
            name: storeName,
            keyPath: store.keyPath,
            autoIncrement: store.autoIncrement,
            indexes,
            records,
          });
        }

        result.push({ name: meta.name, version: db.version, stores });
        db.close();
      } catch (e) {
        console.log('读取 IndexedDB 数据库失败:', meta.name, e);
      }
    }
    return result;
  }

  const indexedDBDump = await dumpIndexedDB();

  const state = {
    cookies,
    origins: [{ origin, localStorage: localStorageItems }],
    sessionStorage: sessionStorageItems,
    indexedDB: indexedDBDump,
  };

  const json = JSON.stringify(state, null, 2);
  console.log(json);
  console.log(`共导出 ${json.length} 字符，IndexedDB 数据库数量: ${indexedDBDump.length}`);

  try {
    copy(json);
    console.log('%c✅ 已复制到剪贴板，直接粘贴为 GitHub Secret: MODVC_STATE 即可', 'color:#3fb950;font-weight:bold;font-size:13px;');
  } catch (e) {
    console.log('⚠️ 自动复制失败，请手动从上面输出的 JSON 中全选复制');
  }
})();
```
