/*
 * 通知を受け取る部品（携帯・パソコンの中で、アプリを閉じていても動く）
 * Firebase の設定は、登録するときに画面から ?c=… で渡される（このファイルに鍵は入っていない）
 */
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

let cfg = {};
try { cfg = JSON.parse(new URL(self.location.href).searchParams.get('c') || '{}'); } catch (e) {}

if (cfg.apiKey) {
  firebase.initializeApp(cfg);
  const messaging = firebase.messaging();
  // 通知が届いたとき：アイコンの数字を変えて、通知を出す
  messaging.onBackgroundMessage(payload => {
    const d = (payload && payload.data) || {};
    const n = parseInt(d.badge || '0', 10) || 0;
    try {
      if (self.navigator.setAppBadge) (n ? self.navigator.setAppBadge(n) : self.navigator.clearAppBadge()).catch(() => {});
    } catch (e) {}
    return self.registration.showNotification(d.title || '現場TODO', {
      body: d.body || '新しいTODOが届きました。',
      icon: 'icons/icon-192.png',
      badge: 'icons/favicon-64.png',
      tag: 'genba-todo',      // 同じ種類の通知は1つにまとめる
      renotify: true          // まとめても、毎回音を鳴らす
    });
  });
}

// 通知を押したとき：アプリを開く（開いていれば前に出す）
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow('./');
  }));
});
