const { spawn } = require('node:child_process');
const path = require('node:path');
const { getLanAddress } = require('./lanAddress');

async function main() {
  const address = await getLanAddress();
  const serverUrl = `http://${address}:4100`;
  const projectRoot = process.cwd();
  const expoCli = path.join(projectRoot, 'node_modules', 'expo', 'bin', 'cli');
  console.log(`Using local call server ${serverUrl}`);

  const expo = spawn(process.execPath, [expoCli, 'start', '--dev-client', '--clear', '--lan'], {
    cwd: projectRoot,
    env: { ...process.env, EXPO_PUBLIC_CALL_SERVER_URL: serverUrl },
    stdio: 'inherit',
  });

  expo.once('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  expo.once('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});