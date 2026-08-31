// PM2 config for VPS deployment: pm2 start ecosystem.config.js
// Cluster mode uses every CPU core; sessions live in MySQL so this is safe.
module.exports = {
  apps: [{
    name: 'workpulse',
    script: 'server.js',
    instances: 'max',
    exec_mode: 'cluster',
    max_memory_restart: '300M',
    env: { NODE_ENV: 'production' }
  }]
};
