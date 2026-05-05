// ============================================
// CYPHER X - COMMAND FIXES
// Fixed implementations for all problematic commands
// ============================================

// ============= 1. VIEWONCE FIX =============
if (text === '.viewonce') {
  try {
    const source = msg.hasQuotedMsg ? await msg.getQuotedMessage() : msg;
    
    // Check if media exists
    if (!source.hasMedia) {
      return msg.reply(
        'I cannot access that view-once media.\n\n' +
        'Use .viewonce by replying directly to the original view-once message.\n' +
        'WhatsApp may block bot access if it has already been opened.'
      );
    }

    // Download the media
    const media = await source.downloadMedia().catch(err => {
      logLine(`View-once download error: ${err.message}`);
      return null;
    });

    if (!media) {
      return msg.reply(
        'I could not download that view-once media.\n' +
        'This sometimes happens if WhatsApp has already blocked access.'
      );
    }

    // Send back the media
    const ext = mediaExt(media);
    media.filename = `viewonce.${ext}`;
    return msg.reply(media, undefined, { caption: '✓ View-once media opened' });
  } catch (error) {
    logLine(`Viewonce command error: ${error.message}`);
    return msg.reply(`Error: ${error.message}`);
  }
}

// ============= 2-5. YOUTUBE DOWNLOAD FIXES =============
// Enhanced sendSong function with better error handling
async function sendSong(msg, query) {
  if (!query || query.length < 2) {
    return msg.reply('❌ Please provide a song name\n\nExample: .play Billie Eilish');
  }

  try {
    await msg.react('⏳');
    
    // Search for song
    let results;
    try {
      results = await ytSearch(query);
    } catch (err) {
      logLine(`YouTube search error: ${err.message}`);
      return msg.reply(`❌ Search failed: ${err.message}`);
    }

    if (!results || !results.videos || results.videos.length === 0) {
      await msg.react('❌');
      return msg.reply(`❌ No songs found for: "${query}"`);
    }

    const video = results.videos[0];
    
    if (!video.url) {
      await msg.react('❌');
      return msg.reply('❌ Invalid video source');
    }

    const title = safeFileName(video.title);
    const file = path.join(os.tmpdir(), `${Date.now()}-${title}.mp3`);

    await msg.react('⬇️');
    await msg.reply(`⏳ *Downloading:* ${video.title}\n*Channel:* ${video.author?.name || 'Unknown'}`);

    try {
      // Validate YouTube URL
      if (!ytdl.validateURL(video.url)) {
        throw new Error('Invalid YouTube URL');
      }

      // Download with timeout
      await Promise.race([
        convertYoutubeToMp3(video.url, file),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Download timeout (5min)')), 300000)
        )
      ]);

      // Verify file exists and has content
      const stats = fs.statSync(file);
      if (stats.size < 100000) {
        throw new Error('Downloaded file too small, possibly corrupted');
      }

      const media = MessageMedia.fromFilePath(file);
      media.filename = `${title}.mp3`;

      await msg.react('✅');
      await msg.reply(media, undefined, {
        sendAudioAsVoice: false,
        caption: `🎵 ${video.title}\n📤 ${video.url}`
      });

    } catch (downloadErr) {
      logLine(`MP3 download error: ${downloadErr.message}`);
      await msg.react('❌');
      
      // Send fallback with link
      return msg.reply(
        `❌ *Download failed*: ${downloadErr.message}\n\n` +
        `Here's the YouTube link instead:\n` +
        `*Title:* ${video.title}\n` +
        `*Channel:* ${video.author?.name || 'Unknown'}\n` +
        `*Link:* ${video.url}`
      );
    }
  } catch (error) {
    logLine(`Song command error: ${error.message}`);
    await msg.react('❌');
    return msg.reply(`❌ Error: ${error.message}`);
  } finally {
    // Clean up temp files
    const tmpDir = os.tmpdir();
    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith(Date.now().toString().slice(0, 9)));
    files.forEach(f => {
      try {
        fs.unlinkSync(path.join(tmpDir, f));
      } catch (e) { }
    });
  }
}

// Enhanced sendVideo function
async function sendVideo(msg, query) {
  if (!query || query.length < 2) {
    return msg.reply('❌ Please provide a video name\n\nExample: .play video Despacito');
  }

  try {
    await msg.react('⏳');
    
    // Search for video
    let results;
    try {
      results = await ytSearch(query);
    } catch (err) {
      logLine(`Video search error: ${err.message}`);
      return msg.reply(`❌ Search failed: ${err.message}`);
    }

    if (!results || !results.videos || results.videos.length === 0) {
      await msg.react('❌');
      return msg.reply(`❌ No videos found for: "${query}"`);
    }

    const video = results.videos[0];
    
    if (!video.url) {
      await msg.react('❌');
      return msg.reply('❌ Invalid video source');
    }

    const title = safeFileName(video.title);
    const file = path.join(os.tmpdir(), `${Date.now()}-${title}.mp4`);

    await msg.react('⬇️');
    await msg.reply(`⏳ *Downloading video:* ${video.title}\n*Duration:* ${video.timestamp || 'Unknown'}`);

    try {
      // Validate YouTube URL
      if (!ytdl.validateURL(video.url)) {
        throw new Error('Invalid YouTube URL');
      }

      // Download video with timeout
      await Promise.race([
        new Promise((resolve, reject) => {
          const stream = ytdl(video.url, {
            quality: 'highest',
            filter: format => format.container === 'mp4' && format.hasAudio && format.hasVideo
          });
          
          stream.on('error', reject);
          
          const writeStream = fs.createWriteStream(file);
          stream.pipe(writeStream);
          
          writeStream.on('finish', resolve);
          writeStream.on('error', reject);
        }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Download timeout (10min)')), 600000)
        )
      ]);

      // Verify file exists and has content
      const stats = fs.statSync(file);
      if (stats.size < 1000000) {
        throw new Error('Downloaded file too small, possibly corrupted');
      }

      const media = MessageMedia.fromFilePath(file);
      media.filename = `${title}.mp4`;

      await msg.react('✅');
      await msg.reply(media, undefined, { 
        caption: `🎬 ${video.title}\n📤 ${video.url}` 
      });

    } catch (downloadErr) {
      logLine(`Video download error: ${downloadErr.message}`);
      await msg.react('❌');
      
      // Send fallback with link
      return msg.reply(
        `❌ *Video download failed*: ${downloadErr.message}\n\n` +
        `Here's the YouTube link:\n` +
        `*Title:* ${video.title}\n` +
        `*Duration:* ${video.timestamp || 'Unknown'}\n` +
        `*Link:* ${video.url}`
      );
    }
  } catch (error) {
    logLine(`Video command error: ${error.message}`);
    await msg.react('❌');
    return msg.reply(`❌ Error: ${error.message}`);
  }
}

// Direct command handlers
if (text.startsWith('.play ')) {
  const q = raw.slice(6).trim();
  if (!q) return msg.reply('❌ Write a song name after .play\n\nExamples:\n.play Billie Eilish\n.play video Despacito');
  
  if (q.toLowerCase().startsWith('video ')) {
    return sendVideo(msg, q.slice(6).trim());
  }
  return sendSong(msg, q);
}

if (text.startsWith('.ytmp3 ')) {
  const q = raw.slice(7).trim();
  if (!q) return msg.reply('❌ Write a song name after .ytmp3');
  return sendSong(msg, q);
}

if (text.startsWith('.ytmp4 ')) {
  const q = raw.slice(7).trim();
  if (!q) return msg.reply('❌ Write a video name after .ytmp4');
  return sendVideo(msg, q);
}

// ============= 6-9. STATUS FIXES =============
// These need to be added to CLIENT INITIALIZATION (before message handler)

// ADD THIS TO CLIENT.on('ready') OR AT STARTUP:
// Status viewing auto-handler
client.on('message', async (msg) => {
  try {
    // Handle status updates in real-time
    if (msg.from === 'status@broadcast') {
      const session = sessionSettings(name); // name from current session context
      
      // Auto-view statuses
      if (session.statusview === true) {
        if (msg.markSeen) {
          await msg.markSeen().catch(() => {});
        }
        if (client.sendSeen) {
          await client.sendSeen(msg.from).catch(() => {});
        }
      }
      
      // Auto-react to statuses
      if (session.statuslike === true && msg.react) {
        const emoji = session.statusReact || '💗';
        await msg.react(emoji).catch(() => {});
      }
    }
  } catch (error) {
    logLine(`Status auto-handler error: ${error.message}`);
  }
});

// Fixed status command handlers
if (text === '.viewstatus on') {
  session.statusview = true;
  session.statuslike = false;
  save(MEMORY_FILE, memory);
  return msg.reply('✅ *Status auto-view enabled*\n\nThe bot will automatically view all new statuses.');
}

if (text === '.viewstatus off') {
  session.statusview = false;
  save(MEMORY_FILE, memory);
  return msg.reply('❌ *Status auto-view disabled*');
}

if (text === '.likestatus on') {
  session.statuslike = true;
  session.statusview = true;
  save(MEMORY_FILE, memory);
  return msg.reply(`✅ *Status auto-react enabled*\n\nWill react with: ${session.statusReact || '💗'}`);
}

if (text === '.likestatus off') {
  session.statuslike = false;
  save(MEMORY_FILE, memory);
  return msg.reply('❌ *Status auto-react disabled*');
}

if (text.startsWith('.setstatus ')) {
  const statusText = raw.slice(11).trim();
  if (!statusText) return msg.reply('❌ Write status text after .setstatus');
  
  session.statusText = statusText;
  save(MEMORY_FILE, memory);
  
  // Try to set status immediately
  await client.setStatus(statusText).catch(err => {
    logLine(`Status set error: ${err.message}`);
  });
  
  return msg.reply(`✅ *Status updated*:\n"${statusText}"`);
}

if (text === '.autostatus on') {
  session.autostatus = true;
  save(MEMORY_FILE, memory);
  
  // Set status immediately
  if (session.statusText) {
    await client.setStatus(session.statusText).catch(() => {});
  }
  
  return msg.reply('✅ *Auto-status enabled*\n\nStatus will auto-update');
}

if (text === '.autostatus off') {
  session.autostatus = false;
  save(MEMORY_FILE, memory);
  return msg.reply('❌ *Auto-status disabled*');
}

// ============================================
// HELPER FUNCTIONS (if not already present)
// ============================================

function mediaExt(media) {
  const mime = (media && media.mimetype) || '';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('mpeg') || mime.includes('audio/mp3')) return 'mp3';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('image')) return 'jpg';
  if (mime.includes('video')) return 'mp4';
  if (mime.includes('audio')) return 'mp3';
  return 'bin';
}

function safeFileName(name) {
  return String(name || 'file')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '_')
    .trim()
    .slice(0, 100) || 'file';
}

function logLine(text) {
  const line = `[${new Date().toISOString()}] ${text}`;
  console.log(line);
  // Optionally save to logs array
  if (typeof botLogs !== 'undefined') {
    botLogs.push(line);
    if (botLogs.length > 200) botLogs.shift();
  }
}

// ============================================
