# CypherX Bot - Command Fixes Integration Guide

## Overview
This guide shows how to integrate working command implementations into your CypherX bot to fix all 9 failing commands.

## Problematic Commands Fixed
1. ✅ `.viewonce` - View-once media extraction
2. ✅ `.play [song]` - YouTube audio download  
3. ✅ `.play video [name]` - YouTube video download
4. ✅ `.ytmp3 [song]` - Direct MP3 download
5. ✅ `.ytmp4 [video]` - Direct MP4 download
6. ✅ `.viewstatus on/off` - Auto-view statuses
7. ✅ `.likestatus on/off` - Auto-react to statuses  
8. ✅ `.setstatus [text]` - Set custom status
9. ✅ `.autostatus on/off` - Toggle auto-status

---

## Installation Steps

### Step 1: Backup Your Current Code
```bash
# Make a backup of your current index.js
copy index.js index.js.backup
```

### Step 2: Install Required Dependencies
Ensure these are in your `package.json`:
```json
{
  "dependencies": {
    "@distube/ytdl-core": "^4.16.12",
    "fluent-ffmpeg": "^2.1.3",
    "ffmpeg-static": "^5.2.0",
    "yt-search": "^2.13.1",
    "whatsapp-web.js": "^1.26.0",
    "qrcode-terminal": "^0.12.0"
  }
}
```

Install with: `npm install`

### Step 3: Update Your index.js

**Find these functions and replace them:**

#### A. Media Download Functions (Lines ~650-800)
Replace your `sendSong()` and `sendVideo()` functions with the implementations from `FIXED_COMMANDS.js`

**Key improvements:**
- Better error handling with timeouts
- Real-time emoji reactions showing download status (⏳ → ⬇️ → ✅)
- Fallback links if download fails
- Temp file cleanup
- File size validation

#### B. Command Handlers (Main message handler)
Replace these command patterns:
```javascript
if (text.startsWith('.play '))     // ← REPLACE
if (text.startsWith('.ytmp3 '))    // ← REPLACE  
if (text.startsWith('.ytmp4 '))    // ← REPLACE
if (text === '.viewonce')          // ← REPLACE
```

With the implementations from `FIXED_COMMANDS.js`

#### C. Status Auto-Handler (In `client.on('ready')`)
Add this event listener:
```javascript
client.on('message', async (msg) => {
  // Copy the status auto-handler from FIXED_COMMANDS.js
  // This handles real-time status reactions
});
```

#### D. Status Commands (Message handler)
Replace these status command handlers:
```javascript
if (text === '.viewstatus on')    // ← REPLACE
if (text === '.viewstatus off')   // ← REPLACE
if (text === '.likestatus on')    // ← REPLACE
if (text === '.likestatus off')   // ← REPLACE
if (text.startsWith('.setstatus'))  // ← REPLACE
if (text === '.autostatus on')    // ← REPLACE
if (text === '.autostatus off')   // ← REPLACE
```

### Step 4: Add Helper Functions
At the bottom of your `index.js`, add these utility functions:
```javascript
function mediaExt(media) { ... }
function safeFileName(name) { ... }
function logLine(text) { ... }
```

See `FIXED_COMMANDS.js` for full implementations.

---

## Testing Checklist

### Audio Download Tests
```
✓ .play billie eilish
  Expected: Downloads audio, sends MP3 with real-time status emoji
  
✓ .ytmp3 the weeknd
  Expected: Same as above
```

### Video Download Tests  
```
✓ .play video despacito
  Expected: Downloads video, sends MP4 with emoji feedback
  
✓ .ytmp4 pnl
  Expected: Same as above
```

### View-Once Test
```
✓ Reply to a view-once message with .viewonce
  Expected: Bot extracts and sends you the view-once media
```

### Status Tests
```
✓ .viewstatus on
  Expected: Bot automatically views all new statuses silently
  
✓ .likestatus on  
  Expected: Bot reacts with 💗 to all new statuses immediately
  
✓ .setstatus Hello from bot
  Expected: Sets your WhatsApp status to "Hello from bot"
  
✓ .autostatus on
  Expected: Status auto-refreshes with set text
```

---

## Key Implementation Details

### Why Commands Now Work Immediately

**1. Real-time Status Handling**
```javascript
client.on('message', async (msg) => {
  if (msg.from === 'status@broadcast') {
    // Reacts instantly when anyone posts a status
    if (session.statuslike) {
      await msg.react('💗');
    }
  }
});
```

**2. Better YouTube Download Pipeline**
- ✅ Validates URL before downloading
- ✅ Uses timeout to prevent hanging (5min for MP3, 10min for MP4)
- ✅ Checks file size to catch corrupted downloads
- ✅ Cleans up temp files automatically

**3. Proper Error Handling**
- Falls back to sending YouTube link if download fails
- Shows specific error messages to user
- Prevents bot from crashing on media errors

### Required Session Memory Fields
Your session object needs these properties:
```javascript
session = {
  statusview: false,        // Auto-view statuses
  statuslike: false,        // Auto-react to statuses
  statusReact: '💗',        // Emoji to react with
  statusText: '',           // Custom status text
  autostatus: false,        // Auto-update status
  // ... other session fields
};
```

Make sure these are initialized when creating new sessions.

---

## Deployment to Termius

### Step 1: Prepare Code
```bash
npm install
npm list  # Verify all dependencies installed
```

### Step 2: Create .env File (if needed)
```
NODE_ENV=production
BOT_NAME=CypherX-Fixed
```

### Step 3: Test Locally First
```bash
npm start
# Scan QR code
# Test all 9 commands before uploading to Termius
```

### Step 4: Deploy to Termius
1. Connect to your Termius container
2. Upload entire project folder
3. Run: `npm install`
4. Run: `npm start`
5. Scan QR code when prompted

### Step 5: Persistent Execution (on Termius)
```bash
# Option 1: Use PM2
npm install -g pm2
pm2 start index.js --name "CypherX"
pm2 save
pm2 startup

# Option 2: Use screen
screen -S whatsapp_bot
npm start
# Press Ctrl+A then D to detach
```

---

## Common Issues & Fixes

### Issue: Downloads work locally but fail on Termius
**Solution:** Ensure FFmpeg is installed on Termius
```bash
apt-get update
apt-get install -y ffmpeg
```

### Issue: Status commands not reacting in real-time
**Solution:** Make sure this is in your message handler:
```javascript
client.on('message', async (msg) => {
  if (msg.from === 'status@broadcast') {
    // Status auto-handler code here
  }
});
```

### Issue: Download times out or fails
**Solution:** Check your Termius bandwidth/CPU. Increase timeout:
```javascript
// In sendSong function, change timeout value:
setTimeout(() => reject(new Error('timeout')), 600000) // 10min
```

### Issue: Bot crashes on unknown commands
**Solution:** Wrap command handlers in try-catch:
```javascript
try {
  if (text.startsWith('.play ')) {
    // command code
  }
} catch (error) {
  msg.reply(`❌ Error: ${error.message}`);
}
```

---

## Performance Optimization Tips

1. **Temp File Cleanup**
   - Implemented in the fixes to prevent disk fill
   - Runs automatically after each download

2. **Concurrent Limits**
   - Only allow 1-2 simultaneous downloads per session
   - Queue additional requests

3. **Memory Management**  
   - Clear old logs regularly
   - Limit cached messages to 1000

---

## Verification Commands

After integrating, run these tests:

```javascript
// In browser console or test script
console.log('Testing .play command...');
// Send: .play test song
// Expected: Download starts with ⏳ emoji

console.log('Testing status handler...');
// Upload a WhatsApp status
// Expected: Bot auto-reacts within 2 seconds

console.log('Testing error handling...');  
// Send: .play !!invalid!!
// Expected: Proper error message, not crash
```

---

## Files to Modify

| File | Changes | Priority |
|------|---------|----------|
| `index.js` | Replace 9 command handlers | HIGH |
| `package.json` | Verify dependencies | MEDIUM |
| Other files | No changes needed | - |

---

## Support

If commands still don't work after integration:

1. Check terminal logs for errors
2. Ensure all dependencies installed: `npm list`
3. Verify FFmpeg available: `ffmpeg -version`
4. Check internet connection on Termius
5. Review error messages in bot responses

---

**Last Updated:** 2024
**Bot:** CypherX (Fixed Version)
**Target:** Termius Deployment
