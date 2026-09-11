/**
 * End-to-End Integration Test Suite for Smart Safe IoT
 * ----------------------------------------------------
 * Validates:
 * 1. Health check & Server initialization
 * 2. Device WebSocket connection & status detection
 * 3. Remote UNLOCK triggering via REST API & WebSocket delivery
 * 4. Password change with correct current password & 4-digit validation
 * 5. Rejection of invalid password attempts
 * 6. Audit log recording & validation that passwords are never exposed
 * 7. Keypad event simulation & stats counting
 */

const http = require('http');
const path = require('path');
const { WebSocket } = require(path.join(__dirname, '../backend/node_modules/ws'));

const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runTests() {
  console.log('====================================================');
  console.log('🧪 RUNNING SMART SAFE IoT INTEGRATION TESTS');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(name, condition, extraInfo = '') {
    if (condition) {
      console.log(`✅ PASS: ${name}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${name} ${extraInfo}`);
      failed++;
    }
  }

  try {
    // 1. Health Check
    const health = await request('GET', '/api/health');
    assert('1. Server Health Check responds with status 200 and ok', health.status === 200 && health.body.status === 'ok');

    // 2. Connect Browser WebSocket Client
    const browserWs = new WebSocket(WS_URL);
    let browserMessages = [];
    browserWs.on('message', data => {
      browserMessages.push(JSON.parse(data.toString()));
    });
    await sleep(200);
    assert('2. Browser WebSocket Client connected successfully', browserWs.readyState === WebSocket.OPEN);

    // 3. Connect Mock ESP32 Device Client
    const deviceWs = new WebSocket(`${WS_URL}?role=device&secret=smart_safe_secret_key_2026`);
    let deviceCommands = [];
    deviceWs.on('message', data => {
      deviceCommands.push(JSON.parse(data.toString()));
    });
    await sleep(300);
    assert('3. Device WebSocket Client connected and identified', deviceWs.readyState === WebSocket.OPEN);

    // Verify Device Online Status in Stats
    const statsOnline = await request('GET', '/api/safe/stats');
    assert('4. Device status reflected as ONLINE in stats', statsOnline.body.isDeviceOnline === true);

    // 4. Test Keypad Events Ingestion
    deviceWs.send(JSON.stringify({
      type: 'EVENT',
      source: 'KEYPAD',
      status: 'SUCCESS',
      details: 'เปิดสำเร็จจาก Keypad (Integration Test)'
    }));
    await sleep(200);

    deviceWs.send(JSON.stringify({
      type: 'EVENT',
      source: 'KEYPAD',
      status: 'FAILED',
      details: 'รหัสผิดจาก Keypad (Integration Test)'
    }));
    await sleep(200);

    const statsAfterEvents = await request('GET', '/api/safe/stats');
    assert('5. Keypad events recorded in stats counters', statsAfterEvents.body.totalSuccess >= 1 && statsAfterEvents.body.totalFailed >= 1);

    // 5. Test Remote Unlock API
    const unlockRes = await request('POST', '/api/safe/unlock');
    assert('6. Remote UNLOCK API returned HTTP 200 success', unlockRes.status === 200 && unlockRes.body.success === true);

    // Verify ESP32 received UNLOCK command
    const unlockCmdReceived = deviceCommands.some(cmd => cmd.action === 'UNLOCK');
    assert('7. ESP32 received UNLOCK action via WebSocket', unlockCmdReceived);

    // 6. Test Change Password - Validation Rules
    const invalidFormatRes = await request('POST', '/api/safe/change-password', {
      currentPassword: '1234',
      newPassword: 'abcd', // invalid, must be 4 digits
      confirmPassword: 'abcd'
    });
    assert('8. Reject non-digit password', invalidFormatRes.status === 400);

    const mismatchRes = await request('POST', '/api/safe/change-password', {
      currentPassword: '1234',
      newPassword: '5678',
      confirmPassword: '9999' // mismatch
    });
    assert('9. Reject mismatched password confirmation', mismatchRes.status === 400);

    const wrongCurrentRes = await request('POST', '/api/safe/change-password', {
      currentPassword: '9999', // wrong current password
      newPassword: '5678',
      confirmPassword: '5678'
    });
    assert('10. Reject incorrect current password', wrongCurrentRes.status === 400);

    // 7. Test Successful Password Change
    const validChangeRes = await request('POST', '/api/safe/change-password', {
      currentPassword: '1234',
      newPassword: '4321',
      confirmPassword: '4321'
    });
    assert('11. Accept valid password change (1234 -> 4321)', validChangeRes.status === 200 && validChangeRes.body.success === true);

    // Verify ESP32 received SET_PASSWORD command
    const setPassCmd = deviceCommands.find(cmd => cmd.action === 'SET_PASSWORD');
    assert('12. ESP32 received SET_PASSWORD action with newPassword payload', setPassCmd && setPassCmd.payload.newPassword === '4321');

    // Restore password back to 1234
    await request('POST', '/api/safe/change-password', {
      currentPassword: '4321',
      newPassword: '1234',
      confirmPassword: '1234'
    });

    // 8. Test Audit Logs - Security Verification
    const logsRes = await request('GET', '/api/safe/logs');
    assert('13. Logs API returned array of log items', logsRes.status === 200 && Array.isArray(logsRes.body.logs));

    // Verify NO plaintext password appears in log table
    const logsString = JSON.stringify(logsRes.body.logs);
    assert('14. Security: No raw passwords exposed in logs table', !logsString.includes('4321') && !logsString.includes('1234'));

    // Clean up connections
    browserWs.close();
    deviceWs.close();

    console.log('\n====================================================');
    console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
    console.log('====================================================');

    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error('Unexpected error running integration tests:', err);
    process.exit(1);
  }
}

runTests();
