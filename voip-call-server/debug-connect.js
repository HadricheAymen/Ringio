const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const { io } = require('socket.io-client');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

(async () => {
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; console.log('STDERR', JSON.stringify(chunk)); });

  for (let attempt = 0; attempt < 20; attempt += 1) {
    console.log('attempt', attempt + 1, 'connecting to', url);
    try {
      const socket = io(url, {
        transports: ['websocket'],
        reconnection: false,
        timeout: 2000,
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 2000);
        socket.once('connect', () => {
          clearTimeout(timer);
          console.log('connected');
          socket.disconnect();
          resolve();
        });
        socket.once('connect_error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      console.log('success');
      child.kill();
      return;
    } catch (error) {
      console.log('connect failed', error.message);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  console.log('final stderr', JSON.stringify(stderr));
  child.kill();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
