# WhatsApp Bot - Comprehensive Analysis

## Overview
**Name:** Mboka WhatsApp Bot (Githinji Bot)  
**Version:** 1.0.0  
**Type:** WhatsApp Linked Device Bot  
**Platform:** Node.js (runs on Windows/Linux/RDP)  
**Main Framework:** whatsapp-web.js with local authentication

---

## Core Architecture

### Key Components

1. **Session Management**
   - Multiple WhatsApp sessions can be linked (e.g., 'main', 'john', 'mary')
   - Each session maintains independent state and settings
   - Sessions saved in `sessions.json`

2. **Data Persistence**
   - `memory.json`: Stores users, groups, sessions, warns, saved contacts, invite opt-ins
   - `ownerlock.json`: Owner/admin access control
   - `schedules.json`: Scheduled messages
   - All files are JSON-based for portability

3. **Core Libraries**
   - `whatsapp-web.js` (v1.26.0): WhatsApp client
   - `@distube/ytdl-core` (v4.16.12): YouTube downloading
   - `fluent-ffmpeg` (v2.1.3): Audio/video conversion
   - `yt-search` (v2.13.1): YouTube search
   - `qrcode-terminal` & `qrcode` (v1.5.4): QR code generation
   - `ffmpeg-static` (v5.2.0): FFmpeg binary

---

## Major Features

### 1. Session & Authentication Management
- **Multiple Linked Devices**: Support for multiple WhatsApp business accounts
- **QR Code Scanner**: Terminal QR code display for device linking
- **Session Commands**:
  - `.session add [name]` - Add new WhatsApp session
  - `.session list` - List active sessions
  - `.session delete [name]` - Remove session

### 2. Owner Lock & Access Control
- **Owner Lock Toggle**: `.ownerlock on/off` - Enable/disable command restrictions
- **Trusted Owners**: 
  - `.owner add @user` - Add trusted owner
  - `.owner remove @user` - Remove trusted owner
  - `.owner list` - List trusted owners
- **Primary Owner**: First deployed bot has special privileges

### 3. Personality & AI Features
- **Multiple Moods**: normal, jealous, clingy, sweet, sassy, shy, flirty, soft, teasing, savage, romantic, funny, loyal, rude, dramatic, girlfriend, bestie, rudeSoft
- **Smart AI Replies**: Optional OpenAI integration for intelligent responses (`.ai`, `.ask`, `.gpt`)
- **Feminine Responses**: Context-aware personalized replies
- **Persona System**: Custom personality settings per session (`.persona custom [description]`)

### 4. Message Media & Content Features

#### YouTube Content Download
- `.play [search]` - Search and download audio (MP3)
- `.ytmp3 [YouTube URL]` - Download MP3 from YouTube
- `.ytmp4 [YouTube URL]` - Download video (MP4)
- `.play video [search]` - Download video by search
- Quality: High audio bitrate MP3 (128kbps), highest quality MP4

#### Utilities
- `.qr [text]` - Generate QR code from text
- `.readmore [text]` - Add hidden text (for bypassing text limits)
- `.translate [text] to [language]` - Translate text (supports English, Swahili, French, Spanish, Arabic, German, Portuguese, Italian)
- `.define [word]` - Get word definition from dictionary API
- `.summarize [text]` - Create summary of text

### 5. Group Management & Moderation

#### Admin Controls (requires admin in group)
- `.setname [new name]` - Change group name
- `.setdesc [description]` - Set group description
- `.kick` - Remove user (reply to message or mention)
- `.add [number]` - Add user to group
- `.promote` - Make user group admin
- `.demote` - Remove admin status
- `.hidetag` - Send message as group notification
- `.deleteall` / `.deluser` - Delete all messages from a user
- `.purge` - Delete recent messages (up to 250 tracked)

#### Welcome & Goodbye
- `.setwelcome [text]` - Set join message (supports {name}, @user placeholders)
- `.setbye` / `.setgoodbye [text]` - Set leave message
- `.welcome` / `.goodbye` - Toggle welcome/goodbye messages

#### User Management
- `.mute [duration] @user` - Mute user (format: 5s, 10m, 2h, 1d)
- `.nickname @user [name]` - Set nickname for user
- `.warn` - Warn user (3-strike system by default)
- `.setwarnlimit [number]` - Set max warnings before kick

### 6. Group Protection & Anti-Features

All toggleable with admin commands in groups:

| Feature | Command | Purpose |
|---------|---------|---------|
| **Antilink** | `.antilink` | Remove/warn for group/channel links |
| **Antispam** | `.antispam` | Limit message frequency (configurable) |
| **Antibadword** | `.antibadword` | Filter & warn for bad words |
| **Antimention** | `.antimention` | Limit @-mentions per message |
| **Antidelete** | `.antidelete` | Log deleted messages |
| **Antiviewonce** | `.antiviewonce` | Auto-download disappearing photos |
| **Antiforeign** | `.antiforeign` | Kick non-Kenyan numbers (254 prefix) |
| **Antifake** | `.antifake` | Detect fake numbers |
| **Antimedia** | `.antimedia` | Block images/videos |
| **Antisticker** | `.antisticker` | Block stickers |
| **Antidocument** | `.antidocument` | Block document files |
| **Antiforward** | `.antiforward` | Block forwarded messages |
| **Antisale** | `.antisale` | Warn for buying/selling keywords |

**Configuration Commands**:
- `.antiword [word]` - Add word to bad word filter
- `.delword [word]` - Remove word from filter
- `.antimention limit [number]` - Set mention limit
- `.antispam set [limit] [seconds]` - Set spam threshold

### 7. Custom Auto-Reply System
- `.autoreply add [trigger] | [reply]` - Add custom response
- `.autoreply remove [trigger]` - Remove auto-reply
- Supports `{name}` and `@user` placeholders
- Per-group custom replies

### 8. Scheduled Messages
- `.schedule add [target] | [time] | [message]` - Schedule message to group
- `.schedule list` - List pending schedules
- `.schedule run` - Execute due schedules
- `.schedule cancel [id]` - Cancel schedule
- `.schedule groups` - List groups where bot is admin
- **Time Formats**: 
  - Relative: `10m`, `2h`, `1d`
  - Absolute: `YYYY-MM-DD HH:mm`
- **Timezone**: Africa/Nairobi (UTC+3)

### 9. Status & Presence Features
- `.setstatus [text]` - Set status message
- `.autostatus` - Auto-update status
- `.statusview` - Auto-view statuses
- `.likestatus [emoji]` - Auto-react to statuses with emoji
- `.reactstatus [emoji]` - Change status reaction emoji
- `.typing` - Show typing indicator
- `.online` - Show online status
- `.away` - Set away status
- `.autoreact [emoji]` - Auto-react to all DM messages

### 10. Entertainment & Games

#### Casual Commands
- `.joke` - Get random joke
- `.lovequote` - Get love quote
- `.fact` - Get random fact
- `.riddle` - Get riddle challenge
- `.coinflip` - Flip a coin
- `.dice` - Roll a dice
- `.rate me` - Get a rating (0-100%)
- `.roast` - Get roasted
- `.confess` - Get random confession
- `.pickline` - Get pickup line
- `.wouldyourather` - Get would-you-rather question
- `.truth` - Truth question
- `.dare` - Dare challenge

#### Games
- `.8ball` - Magic 8-ball
- `.ship [@user1] [@user2]` - Relationship compatibility % (0-100%)
- `.rps [rock|paper|scissors]` - Rock-paper-scissors
- `.tictactoe` - Tic-tac-toe game
- `.play [search]` - YouTube content search

### 11. Chatbot & DM Features
- `.chatbot pm` / `.pm` - Enable/disable PM chatbot mode
- `.chatbotgroup` - Enable/disable group chatbot
- `.mood [mood]` - Change response mood
- `.smart` - Enable smart AI replies (per DM)
- `.autoreply` - Enable auto-reply in groups

### 12. System & Admin Commands

#### Backup & Restore
- `.backup` - Export all bot data as JSON file
- `.restore` - Restore from backup (reply to backup file)

#### Session Control
- `.restart` - Restart bot process (needs PM2 or Task Scheduler)
- `.shutdown` - Shut down bot

#### Monitoring
- `.settings` - Show all active settings
- `.active` / `.toggles` - Show enabled features
- `.logs` - View last 25 bot logs

### 13. Privacy & Contact Features
- **Contact Saving**: Auto-save group member contacts
- **Invite Opt-ins**: Track who opts in for invites
- **User Nicknames**: Set display names for users
- **Message Caching**: 1000 message buffer per chat

---

## Settings Organization

### Session-Level Settings (Per WhatsApp Account)
```
pm: Boolean              # PM chatbot on/off
mood: String             # Response mood
away: Boolean            # Away status
smart: Boolean           # AI replies
typing: Boolean          # Show typing
autoreact: Boolean       # Auto-reaction emoji
statusview: Boolean      # Auto-view statuses
statuslike: Boolean      # Auto-react to statuses
statusReact: String      # Status reaction emoji
online: Boolean          # Online status
autostatus: Boolean      # Auto-status updates
statusText: String       # Status message
persona: String          # Custom AI persona
```

### Group-Level Settings
```
chatbot: Boolean         # Group chatbot enabled
autoreply: Boolean       # Auto-reply enabled
customReplies: Array     # Custom response triggers
mood: String             # Group response mood
welcome/goodbye: String  # Join/leave messages
welcomeOn/goodbyeOn: Boolean
warnLimit: Number        # Warnings before kick
muted: Object            # Muted user timeouts
badwords: Array          # Custom bad words list
allowedPrefix: String    # Foreign number detection prefix
spamLimit/spamSeconds: Number  # Spam detection
antimentionLimit: Number # Max mentions allowed
```

---

## Technical Specifications

### File Structure
```
index.js           # Main bot logic (3000+ lines)
package.json       # Dependencies
index.html         # Web registration UI (unused/legacy)
styles.css         # Web styles (unused/legacy)
start-bot.cmd      # Windows batch starter
start-server.ps1   # PowerShell starter
memory.json        # Persistent data store
sessions.json      # Session config
ownerlock.json     # Owner access control
schedules.json     # Scheduled messages
README-RDP.md      # Setup guide for Windows RDP
```

### Memory Management
- Message cache: Max 1000 messages per chat
- Tracked messages: 250 per user per chat
- Bot logs: Last 25 entries
- Spam buckets: Rate limiting per user/chat
- Auto-warn tracking: Prevents spam warnings

### Performance Features
- Lazy loading of contacts
- Message de-duplication via `processedMessages` Set
- Temporary file cleanup for media downloads
- Resource pooling for API calls

---

## Known Capabilities & Limitations

### Supported Features
✅ Multiple concurrent sessions  
✅ Group/Private message distinction  
✅ Media download & conversion (MP3/MP4)  
✅ Message scheduling with timezone  
✅ Persistent user/group memory  
✅ Advanced moderation tooling  
✅ Custom personality & AI integration  
✅ Event-driven architecture (ready, message, etc.)  

### Limitations
❌ No built-in database (JSON file-based)  
❌ OpenAI integration requires API key (not included)  
❌ FFmpeg required for media conversion  
❌ Limited to WhatsApp Web protocol  
❌ No webhook/REST API exposure  
❌ Single-instance deployment (though multi-session)  

---

## Deployment Notes

### Requirements
- Node.js 14+
- FFmpeg installed
- Windows RDP/Linux/Local machine
- Internet connection for YT downloads & APIs

### Setup Steps
1. Install Node.js
2. Install dependencies: `npm install`
3. Run: `node index.js` (or use start-bot.cmd on Windows)
4. Scan QR code with WhatsApp → Linked Devices
5. Configure settings via commands

### Environment Variables
- `OPENAI_API_KEY` (optional) - For smart AI replies
- `OPENAI_MODEL` (optional) - Defaults to 'gpt-4.1-mini'

---

## Bot Personality System

The bot has **15+ mood presets** with pre-written responses for each:
- **Flirty**: Playful, charming responses
- **Soft**: Gentle, empathetic replies
- **Teasing**: Playful mockery
- **Clingy**: Attention-seeking behavior
- **Jealous**: Protective responses
- **Savage**: Sharp, witty roasts
- **Romantic**: Sweet, affectionate messages
- **Funny**: Humorous, joking responses
- **Loyal**: Supportive, trusting tone
- **Shy**: Bashful, reserved replies
- **Dramatic**: Theatrical, exaggerated responses
- **Girlfriend**: Demanding, affectionate (mixed)
- **Bestie**: Loyal friend mode
- **RudeSoft**: Blunt but caring

Each mood has 10+ pre-written response templates that randomize.

---

## Summary

This is a **comprehensive WhatsApp automation bot** with:
1. **Multi-session support** for running multiple WhatsApp accounts
2. **Advanced group moderation** with 15+ anti-features
3. **Entertainment & gamification** features
4. **Personality system** with mood/persona customization
5. **Media handling** (YouTube MP3/MP4 downloads)
6. **Message scheduling** with timezone support
7. **Persistent memory** for users, groups, and contacts
8. **Owner-based access control** for sensitive commands
9. **Smart AI integration** (optional OpenAI)
10. **Event tracking** (warns, mutes, scheduled events)

**Primary Use Cases**:
- Group management and moderation
- WhatsApp business automation
- Entertainment bot for group chats
- Media content distribution
- Community management tool
