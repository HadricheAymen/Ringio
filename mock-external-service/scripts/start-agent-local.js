const { spawn } = require('node:child_process');
const { getLanAddress } = require('./lanAddress');

async function main() {
  const address = await getLanAddress();
  const serverUrl = `http://${address}:4100`;
  const projectRoot = process.cwd();
  console.log(`Using local call server ${serverUrl}`);

  const agent = spawn(process.execPath, ['--env-file=.env', 'agent.js'], {
    cwd: projectRoot,
    env: { ...process.env, CALL_SERVER_URL: serverUrl },
    stdio: 'inherit',
  });

  agent.once('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  agent.once('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});