// PM2 config for the autoblog review watcher.
//
// This file is shipped as `autoblog/ecosystem.config.example.js`. Copy it to
// your **project root** as `ecosystem.config.js` (next to your package.json),
// then:
//
//   pm2 start ecosystem.config.js
//   pm2 save
//   pm2 startup        # follow the printed instructions to enable on boot
//
// The `script` path below assumes the standard layout: `autoblog/` lives at
// your project root. Edit it if you've placed the autoblog folder elsewhere.
//
// The watcher is the only daemon. It polls IMAP every 2 minutes and writes
// review reply outcomes (approve / changes_requested + feedback body) into
// the Queue tab of the project's Google Sheet. Nothing else. No git, no
// Claude. Topic research is not scheduled — `research.js` runs on demand
// from inside the pipeline (Step 1) when the queue is empty.

module.exports = {
  apps: [
    {
      name: 'autoblog-review-watcher',
      script: './autoblog/scripts/review-watcher.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 10000,
      watch: false,
      // Surface stdout/stderr via `pm2 logs autoblog-review-watcher`
    },
  ],
};
