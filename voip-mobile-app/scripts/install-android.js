const { spawnSync } = require('node:child_process');
const path = require('node:path');

const APP_ID = 'com.ringio.voice';
const METRO_PORT = 8081;

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    ...opts,
  });
  if (res.error) throw res.error;
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

function connectedDevices() {
  const { out } = run('adb', ['devices']);
  return out
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.split('\t'))
    .filter(([serial, state]) => serial && state && state.trim() === 'device')
    .map(([serial]) => serial.trim());
}

function pickDevice(serials) {
  const requested = process.argv[2];
  if (requested) {
    const match = serials.find((s) => s === requested || s.includes(requested));
    if (!match) throw new Error(`Device "${requested}" not found. Connected: ${serials.join(', ') || '(none)'}`);
    return match;
  }

  // One phone can show up twice (Wi-Fi IP:port + mDNS TLS). Prefer the IP connection and drop mDNS duplicates.
  const byIp = serials.filter((s) => /^\d+(\.\d+){3}:\d+$/.test(s));
  const byUsb = serials.filter((s) => !byIp.includes(s) && !s.includes('_adb-tls-connect._tcp'));
  const ranked = [...byIp, ...byUsb];
  if (ranked.length === 0) {
    throw new Error(`No adb device online. Connected: ${serials.join(', ') || '(none)'}`);
  }
  if (ranked.length > 1) {
    console.log(`Multiple devices found: ${ranked.join(', ')} — using ${ranked[0]}. Pass a serial to choose.`);
  }
  return ranked[0];
}

function main() {
  const projectRoot = process.cwd();
  const androidDir = path.join(projectRoot, 'android');
  const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
  const gradleArgs = ['assembleDebug', '--console=plain'];
  const apkPath = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');

  const device = pickDevice(connectedDevices());
  console.log(`Building debug APK for ${device}...`);

  const build =
    process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/c', 'gradlew.bat', ...gradleArgs], { cwd: androidDir, stdio: 'inherit' })
      : spawnSync(gradlew, gradleArgs, { cwd: androidDir, stdio: 'inherit' });
  if (build.error) throw build.error;
  if (build.status !== 0) {
    throw new Error(`Gradle build failed with code ${build.status}`);
  }

  console.log('Installing APK...');
  const install = run('adb', ['-s', device, 'install', '-r', apkPath]);
  if (install.code !== 0) {
    throw new Error(`adb install failed:\n${install.out}`);
  }
  console.log(install.out.trim());

  // Best effort: let the dev client reach Metro on this machine.
  const reverse = run('adb', ['-s', device, 'reverse', `tcp:${METRO_PORT}`, `tcp:${METRO_PORT}`]);
  if (reverse.code === 0) {
    console.log(`adb reverse tcp:${METRO_PORT} ok (start Metro with npm run phone or npm start)`);
  }

  const launch = run('adb', ['-s', device, 'shell', 'am', 'start', '-n', `${APP_ID}/.MainActivity`]);
  if (launch.code === 0) {
    console.log('App launched.');
  } else {
    console.log(`Installed but could not auto-launch:\n${launch.out.trim()}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
