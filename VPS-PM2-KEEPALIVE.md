# Keep The WhatsApp Bot Running On A VPS

Use PM2 so the bot keeps running after you close Termius/SSH and starts again after a VPS reboot.

## 1. Go To The Bot Folder

```bash
cd "/path/to/whatsapp bot"
```

If the bot is not on the VPS yet, upload the project folder first.

## 2. Install Dependencies

```bash
npm install
```

If the VPS is Ubuntu/Debian and Chromium fails to start, install the browser libraries:

```bash
sudo apt update
sudo apt install -y libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64 libpango-1.0-0 libcairo2 libnss3 libx11-xcb1
```

## 3. Install PM2

```bash
sudo npm install -g pm2
```

## 4. Install Media Helpers

Music/video commands use `yt-dlp` first, then fall back to other downloaders.

```bash
sudo apt install -y python3-pip ffmpeg
python3 -m pip install --user -U yt-dlp
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
export PATH="$HOME/.local/bin:$PATH"
yt-dlp --version
```

If YouTube blocks the VPS IP, set a proxy in `ecosystem.config.cjs`:

```js
YT_DLP_PROXY: 'http://user:pass@host:port'
```

RDP is not a proxy. RDP only lets you control the remote server screen; YouTube still sees the VPS IP. A real HTTP/SOCKS proxy or cookies file can help when YouTube blocks datacenter IPs.

## 5. Start Or Restart The Bot

```bash
pm2 start ecosystem.config.cjs
```

If it was already created in PM2:

```bash
pm2 restart githinji-whatsapp-bot
```

Watch the QR/login output:

```bash
pm2 logs githinji-whatsapp-bot
```

Stop watching logs with `Ctrl+C`. The bot keeps running.

## 6. Make It Survive VPS Reboots

Run:

```bash
pm2 save
pm2 startup
```

PM2 will print one `sudo env ... pm2 startup ...` command. Copy that exact command and run it.

Then save again:

```bash
pm2 save
```

## Useful Commands

```bash
pm2 status
pm2 logs githinji-whatsapp-bot
pm2 restart githinji-whatsapp-bot
pm2 stop githinji-whatsapp-bot
pm2 delete githinji-whatsapp-bot
```

## Important

Do not delete `.wwebjs_auth`; that folder contains the WhatsApp login session. If it is missing or corrupted, the bot will ask for a new QR scan.
