module.exports = {
  apps: [
    {
      name: 'githinji-whatsapp-bot',
      script: 'index.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '4G',
      restart_delay: 15000,
      exp_backoff_restart_delay: 10000,
      kill_timeout: 60000,
      env: {
        NODE_ENV: 'production',
        PUPPETEER_EXECUTABLE_PATH: '/usr/bin/google-chrome',
        YT_DLP_PATH: 'yt-dlp',
        YT_DLP_PROXY: ''
      }
    }
  ]
};
