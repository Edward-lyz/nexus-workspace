import { signal } from '@preact/signals';

interface NotificationData {
  id: string;
  title: string;
  body: string;
}

export const notifications = signal<NotificationData[]>([]);

export function showNotificationBanner(title: string, body: string): void {
  const notification: NotificationData = {
    id: `notif-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title,
    body,
  };

  notifications.value = [...notifications.value, notification];

  setTimeout(() => {
    notifications.value = notifications.value.filter(n => n.id !== notification.id);
  }, 5000);
}

export function NotificationBanner() {
  const notifs = notifications.value;
  if (notifs.length === 0) return null;

  return (
    <div class="notification-stack">
      {notifs.map(n => (
        <div key={n.id} class="notification-banner">
          <div class="notification-title">{n.title}</div>
          <div class="notification-body">{n.body}</div>
          <button
            class="notification-dismiss"
            onClick={() => {
              notifications.value = notifications.value.filter(x => x.id !== n.id);
            }}
          >x</button>
        </div>
      ))}
    </div>
  );
}
