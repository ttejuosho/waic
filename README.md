# WhatsApp Notifier

A lightweight WhatsApp relay bot built on [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js). It forwards incoming messages from allowed contacts to a designated notification number, and routes your replies back to the original sender.

---

## How it works

1. A message arrives from an allowed contact (filtered by `pushname` — currently `"XXXX"`).
2. The bot forwards it to `NOTIFICATION_NUMBER`.
3. The mapping between the forwarded notification and the original sender is stored in `replyMap`.
4. When you quote-reply to a forwarded notification, the bot sends your reply back to the original sender.

---

## Requirements

- Node.js 18+
- A WhatsApp account to run the bot on (requires scanning a QR code on first run)

---

## Installation

```bash
npm install whatsapp-web.js qrcode-terminal
```

---

## Configuration

Open `notifier.js` and update the following constants at the top of the file:

| Constant                | Description                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `NOTIFICATION_NUMBER`   | The WhatsApp number that receives forwarded messages, in the format `<country_code><number>@c.us`       |
| `senderName === "XXXX"` | The display name filter for allowed senders — change this to match the contact name you want to monitor |
| `MAX_MAP_SIZE`          | Maximum number of reply mappings held in memory (default: `5`)                                          |

---

## Running

```bash
node notifier.js
```

On first run, a QR code will be printed to the terminal. Scan it with the WhatsApp account you want the bot to run on. The session is persisted locally via `LocalAuth` so subsequent runs will not require re-scanning.

---

## Replying to messages

When a forwarded message appears in your notification thread, **quote-reply** to it. The bot detects the quoted message ID, looks it up in `replyMap`, and forwards your reply to the original sender.

> Only quote-replies are forwarded. Sending a message to the notification thread without quoting does nothing.

---

## Reply map behaviour

The `replyMap` is an in-memory `Map` that holds up to `MAX_MAP_SIZE` entries. When the map is full, the oldest entry is evicted before a new one is added (FIFO).

**Important:** the map does not persist across restarts. If the process restarts, any previously forwarded notifications can no longer be replied to via the bot — you would need to reply manually from your phone.

---

## Reconnection

If the WhatsApp session disconnects, the bot will automatically attempt to reconnect after 5 seconds by calling `client.destroy()` followed by `client.initialize()`.

---

## Project structure

```
notifier.js      # Main bot logic
.wwebjs_auth/    # Auto-generated session data (created on first run)
```

---

## Limitations

- The sender filter is name-based (`pushname`), which can change if the contact updates their WhatsApp display name.
- The reply map is capped at 5 entries — in high-volume scenarios, older mappings will be evicted and those threads can no longer be replied to via the bot.
- No message persistence across restarts.
