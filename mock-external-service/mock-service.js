const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { fork } = require('node:child_process');
const { getLanAddress } = require('./scripts/lanAddress');
const { generateVoiceTestWav } = require('./voiceTest');

const PORT = Number(process.env.PORT || 4200);
const HOST = '127.0.0.1';
const VERCEL_CALL_SERVER_URL = 'https://voip-ringio-prototype.vercel.app';
const MAX_LOG_ENTRIES = 80;
const agentState = {
  phase: 'idle',
  targetNumber: null,
  serverMode: null,
  serverUrl: null,
  startedAt: null,
  logs: [],
};
let agentProcess = null;
let voiceTestRunning = false;
const files = new Map([
  ['/', ['call-console.html', 'text/html; charset=utf-8']],
  ['/call-console.html', ['call-console.html', 'text/html; charset=utf-8']],
]);

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

function appendLog(message) {
  agentState.logs.push({ at: new Date().toISOString(), message });
  if (agentState.logs.length > MAX_LOG_ENTRIES) agentState.logs.shift();
}

function attachOutput(stream) {
  let pending = '';
  stream.on('data', (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) {
      const message = line.trim();
      if (!message) continue;
      appendLog(message);
    }
  });
  stream.on('end', () => {
    const message = pending.trim();
    if (message) appendLog(message);
  });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 4096) reject(new Error('Request body is too large.'));
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}

function startAgent({ serverMode, targetNumber, availabilityPolicy }) {
  if (voiceTestRunning || (agentProcess && agentProcess.exitCode === null) || ['starting', 'ending'].includes(agentState.phase)) {
    return { statusCode: 409, body: { error: 'An agent call is already running.' } };
  }

  agentState.phase = 'starting';
  agentState.targetNumber = targetNumber;
  agentState.serverMode = serverMode;
  agentState.serverUrl = serverMode === 'vercel' ? VERCEL_CALL_SERVER_URL : null;
  agentState.startedAt = new Date().toISOString();
  agentState.logs = [];

  const launch = async () => {
    if (serverMode === 'local') agentState.serverUrl = `http://${await getLanAddress()}:4100`;
    appendLog(`Starting Gemini Live call to ${targetNumber} via ${agentState.serverMode}.`);

    const child = fork('agent.js', [], {
      cwd: __dirname,
      execArgv: ['--env-file=.env'],
      env: {
        ...process.env,
        CALL_SERVER_URL: agentState.serverUrl,
        SIMULATED_DESTINATION_NUMBER: targetNumber,
        CALL_AVAILABILITY_POLICY: availabilityPolicy,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    agentProcess = child;
    attachOutput(child.stdout);
    attachOutput(child.stderr);
    child.on('message', (event) => {
      if (event?.type === 'agent-status' && typeof event.phase === 'string') {
        agentState.phase = event.phase;
      }
    });
    child.on('error', (error) => {
      agentState.phase = 'error';
      appendLog(`Could not start the agent: ${error.message}`);
      if (agentProcess === child) agentProcess = null;
    });
    child.on('close', (code) => {
      if (!['error', 'rejected'].includes(agentState.phase)) agentState.phase = code === 0 ? 'ended' : 'error';
      appendLog(`Agent process exited with code ${code}.`);
      if (agentProcess === child) agentProcess = null;
    });
  };

  launch().catch((error) => {
    agentState.phase = 'error';
    appendLog(error.message);
    agentProcess = null;
  });
  return { statusCode: 202, body: { phase: agentState.phase } };
}

function checkServiceAuth(request) {
  const auth = request.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7).trim();
  const expected = process.env.AGENT_SERVICE_TOKEN || 'dev-test-token';
  return token === expected;
}

function startTaskAgent(task) {
  if (voiceTestRunning || (agentProcess && agentProcess.exitCode === null) || ['starting', 'ending'].includes(agentState.phase)) {
    return { statusCode: 409, body: { error: 'An agent call is already running.' } };
  }

  agentState.phase = 'starting';
  agentState.targetNumber = task.destination;
  agentState.serverMode = 'local';
  agentState.serverUrl = process.env.CALL_SERVER_URL || null;
  agentState.startedAt = new Date().toISOString();
  agentState.logs = [];
  agentState.currentTaskId = task.taskId;

  const launch = async () => {
    if (!agentState.serverUrl) {
      agentState.serverUrl = `http://${await getLanAddress()}:4100`;
    }
    appendLog(`Starting Gemini Live task ${task.taskId} to ${task.destination}.`);

    const child = fork('agent.js', [], {
      cwd: __dirname,
      execArgv: ['--env-file=.env'],
      env: {
        ...process.env,
        CALL_SERVER_URL: agentState.serverUrl,
        SIMULATED_DESTINATION_NUMBER: task.destination,
        CALL_AVAILABILITY_POLICY: task.availabilityPolicy || 'reject',
        VOICE_TASK_ID: task.taskId,
        CALL_TASK: JSON.stringify(task),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    agentProcess = child;
    attachOutput(child.stdout);
    attachOutput(child.stderr);
    child.on('message', (event) => {
      if (event?.type === 'agent-status' && typeof event.phase === 'string') {
        agentState.phase = event.phase;
      }
    });
    child.on('error', (error) => {
      agentState.phase = 'error';
      appendLog(`Could not start the agent: ${error.message}`);
      if (agentProcess === child) agentProcess = null;
    });
    child.on('close', (code) => {
      if (!['error', 'rejected'].includes(agentState.phase)) agentState.phase = code === 0 ? 'ended' : 'error';
      appendLog(`Agent process exited with code ${code}.`);
      if (agentProcess === child) agentProcess = null;
    });
  };

  launch().catch((error) => {
    agentState.phase = 'error';
    appendLog(error.message);
    agentProcess = null;
  });
  return { statusCode: 202, body: { phase: agentState.phase, taskId: task.taskId } };
}

async function handleApi(request, response, pathname) {
  if (request.method === 'GET' && (pathname === '/api/health' || pathname === '/health')) {
    return sendJson(response, 200, { status: 'ok', healthy: true });
  }

  if (request.method === 'GET' && pathname === '/api/task/status') {
    if (!checkServiceAuth(request)) return sendJson(response, 401, { error: 'Unauthorized.' });
    return sendJson(response, 200, {
      ...agentState,
      running: !!agentProcess && agentProcess.exitCode === null,
    });
  }

  if (request.method === 'POST' && pathname === '/api/task/start') {
    if (!checkServiceAuth(request)) return sendJson(response, 401, { error: 'Unauthorized.' });
    let task;
    try {
      task = await readJson(request);
    } catch (err) {
      return sendJson(response, 400, { error: err.message });
    }
    if (!task?.taskId || !task?.destination) {
      return sendJson(response, 400, { error: 'taskId and destination are required.' });
    }
    const result = startTaskAgent(task);
    return sendJson(response, result.statusCode, result.body);
  }

  if (request.method === 'POST' && pathname === '/api/task/stop') {
    if (!checkServiceAuth(request)) return sendJson(response, 401, { error: 'Unauthorized.' });
    if (!agentProcess || agentProcess.exitCode !== null) {
      return sendJson(response, 409, { error: 'No agent call is running.' });
    }
    agentState.phase = 'ending';
    appendLog('Ending the agent call via task API.');
    agentProcess.kill('SIGTERM');
    return sendJson(response, 202, { phase: agentState.phase });
  }
  if (request.method === 'GET' && pathname === '/api/status') {
    return sendJson(response, 200, {
      ...agentState,
      running: !!agentProcess && agentProcess.exitCode === null,
      voiceTestRunning,
    });
  }

  if (request.method === 'POST' && pathname === '/api/agent/voice-test') {
    if (voiceTestRunning || (agentProcess && agentProcess.exitCode === null)) {
      return sendJson(response, 409, { error: 'End the active call before testing PC audio.' });
    }
    voiceTestRunning = true;
    try {
      const audio = await generateVoiceTestWav();
      response.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': audio.length,
        'Cache-Control': 'no-store',
      });
      return response.end(audio);
    } catch (error) {
      return sendJson(response, 502, { error: error.message || 'Gemini voice test failed.' });
    } finally {
      voiceTestRunning = false;
    }
  }

  if (request.method === 'POST' && pathname === '/api/agent/start') {
    let input;
    try {
      input = await readJson(request);
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }

    const targetNumber = String(input?.targetNumber || '').trim().replace(/[\s().-]/g, '');
    const { serverMode, availabilityPolicy = 'reject' } = input || {};
    if (!/^\+?\d{7,15}$/.test(targetNumber)) {
      return sendJson(response, 400, { error: 'Enter a valid simulated destination number.' });
    }
    if (!['local', 'vercel'].includes(serverMode)) {
      return sendJson(response, 400, { error: 'Choose the local or Vercel call server.' });
    }
    if (!['reject', 'queue'].includes(availabilityPolicy)) {
      return sendJson(response, 400, { error: 'Choose reject or queue when no phone is available.' });
    }

    const result = startAgent({ serverMode, targetNumber, availabilityPolicy });
    return sendJson(response, result.statusCode, result.body);
  }

  if (request.method === 'POST' && pathname === '/api/agent/stop') {
    if (!agentProcess || agentProcess.exitCode !== null) {
      return sendJson(response, 409, { error: 'No agent call is running.' });
    }
    agentState.phase = 'ending';
    appendLog('Ending the agent call.');
    agentProcess.kill('SIGTERM');
    return sendJson(response, 202, { phase: agentState.phase });
  }

  return sendJson(response, 404, { error: 'Not found.' });
}

const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, `http://${HOST}`).pathname;
  if (pathname.startsWith('/api/')) {
    const origin = request.headers.origin;
    if (origin && ![`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`].includes(origin) && !checkServiceAuth(request)) {
      return sendJson(response, 403, { error: 'Call controls are available only from this local console.' });
    }
    return handleApi(request, response, pathname);
  }

  if (request.method !== 'GET') {
    response.writeHead(405).end('Method not allowed');
    return;
  }

  const file = files.get(new URL(request.url, 'http://localhost').pathname);
  if (!file) {
    response.writeHead(404).end('Not found');
    return;
  }

  response.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' });
  fs.createReadStream(path.join(__dirname, file[0])).pipe(response);
});

server.listen(PORT, HOST, () => {
  console.log(`Gemini Live call console ready at http://127.0.0.1:${PORT}`);
});
