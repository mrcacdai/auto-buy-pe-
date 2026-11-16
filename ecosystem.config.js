/**
 * ecosystem.config.js — Chạy bot 24/7 bằng PM2
 *
 * Cài PM2:      npm install -g pm2
 * Khởi động:    pm2 start ecosystem.config.js
 * Xem log:      pm2 logs mc-bedrock-bot
 * Giữ khởi động cùng máy: pm2 save && pm2 startup
 */
module.exports = {
  apps: [
    {
      name: 'mc-bedrock-bot',
      script: 'index.js',
      instances: 1,
      autorestart: true,
      watch: ['index.js', 'src', 'web'],
      ignore_watch: ['node_modules', 'data', '.git', '*.log', 'logs'],
      max_memory_restart: '1G',
      node_args: '--no-deprecation',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        FORCE_COLOR: '1',
      },
    },
  ],
};
