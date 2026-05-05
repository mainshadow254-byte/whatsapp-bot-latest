# Mboka WhatsApp Bot on Windows RDP

## 1. Install Node.js

Install Node.js LTS on the Windows RDP VPS from:

https://nodejs.org/

After installing, open a new Command Prompt and check:

```cmd
node -v
npm.cmd -v
```

## 2. Put These Files in One Folder

Use one folder, for example:

```cmd
C:\mboka-bot
```

The required files are:

```txt
index.js
package.json
start-bot.cmd
```

## 3. Install Dependencies

Open Command Prompt in the bot folder:

```cmd
cd /d C:\mboka-bot
npm.cmd install
```

Use `npm.cmd`, not `npm`, because PowerShell may block `npm.ps1`.

## 4. Start the Bot

```cmd
npm.cmd start
```

or double-click:

```txt
start-bot.cmd
```

Scan the QR code from WhatsApp:

```txt
WhatsApp > Linked devices > Link a device
```

## 5. Add More Sessions

From WhatsApp, send:

```txt
.session add john
.session add mary
.session list
```

Each new session prints a new QR code in the RDP terminal.

## 6. Keep It Running

For simple hosting, leave the Command Prompt open and disconnect from RDP without signing out.

For stronger hosting, use Windows Task Scheduler:

1. Open Task Scheduler.
2. Create Task.
3. Trigger: At startup.
4. Action: Start a program.
5. Program: `C:\mboka-bot\start-bot.cmd`
6. Start in: `C:\mboka-bot`
7. Select "Run whether user is logged on or not".

Run the bot manually first to scan QR codes before relying on Task Scheduler.
