// Service Worker — Notificações Push do Radar da Bet
// Escopo: raiz do site (/sw.js)

self.addEventListener('push', event => {
    if (!event.data) return;
    let data;
    try { data = event.data.json(); } catch(e) { data = { title: 'Radar da Bet', body: event.data.text() }; }
    const title = data.title || '🎯 Radar da Bet';
    const options = {
        body:      data.body     || '',
        icon:      '/favicon.ico',
        badge:     '/favicon.ico',
        tag:       data.tag      || 'alerta-preditivo',
        renotify:  true,
        data:      { url: data.url || '/' },
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
    const url = event.notification.data?.url || '/';
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
            for (const client of windowClients) {
                if ((client.url === url || client.url.startsWith(self.location.origin)) && 'focus' in client)
                    return client.focus();
            }
            if (clients.openWindow) return clients.openWindow(url);
        })
    );
});
