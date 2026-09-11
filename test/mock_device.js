/**
 * Hardware Mock Device & Integration Test
 * ---------------------------------------
 * Simulates an ESP32 / KidBright32 board connecting via WebSocket.
 * Used for testing bidirectional cloud communication, remote unlock,
 * remote PIN updates, and audit logging.
 */

const path = require('path');
const { WebSocket } = require(path.join(__dirname, '../backend/node_modules/ws'));
const http = require('http');

const PORT = process.env.PORT || 3000;
const WS_URL = `ws://localhost:${PORT}/ws?role=device&secret=smart_safe_secret_key_2026`;
const HTTP_URL = `http://localhost:${PORT}`;

let currentLocalPin = '1234';

console.log('====================================================');
console.log('🤖 STARTING ESP32 HARDWARE SIMULATOR (MOCK DEVICE)');
console.log(`Connecting to: ${WS_URL}`);
console.log('====================================================\n');

const ws = new WebSocket(WS_URL);

ws.on('open', () => {
  console.log('✅ [MOCK ESP32] Connected to Cloud Server via WebSocket!');
  console.log(`🔑 [MOCK ESP32] Current Active PIN in Flash: "${currentLocalPin}"`);

  // Simulate startup PIN sync via HTTP REST
  http.get(`${HTTP_URL}/api/device/sync-pin`, (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        console.log(`🔄 [MOCK ESP32] Cloud PIN Sync result:`, json);
        if (json.pin) currentLocalPin = json.pin;
      } catch (e) {
        console.error('Sync parse error:', e.message);
      }
    });
  });

  // After 2 seconds, simulate user entering correct PIN on keypad
  setTimeout(() => {
    console.log('\n👉 [MOCK ESP32] Simulating User typing CORRECT PIN [1][2][3][4][#] on Keypad...');
    const successPayload = {
      type: 'EVENT',
      source: 'KEYPAD',
      status: 'SUCCESS',
      details: 'เปิดสำเร็จจาก Keypad (Simulated)'
    };
    ws.send(JSON.stringify(successPayload));
    console.log('📤 [MOCK ESP32] Sent SUCCESS event to Cloud Server.');
  }, 2000);

  // After 4 seconds, simulate user entering WRONG PIN on keypad
  setTimeout(() => {
    console.log('\n👉 [MOCK ESP32] Simulating User typing WRONG PIN [9][9][9][9][#] on Keypad...');
    const failedPayload = {
      type: 'EVENT',
      source: 'KEYPAD',
      status: 'FAILED',
      details: 'รหัสผิดจาก Keypad (Simulated)'
    };
    ws.send(JSON.stringify(failedPayload));
    console.log('📤 [MOCK ESP32] Sent FAILED event to Cloud Server.');
  }, 4000);
});

ws.on('message', (raw) => {
  try {
    const msg = JSON.parse(raw.toString());
    console.log('\n📥 [MOCK ESP32] Received message from server:', msg);

    // Handle remote UNLOCK command
    if (msg.action === 'UNLOCK') {
      console.log('🔓 [MOCK ESP32] >>> EXECUTING UNLOCK: LED Matrix 1s ON, 1s OFF for 2 cycles! <<<');
    }

    // Handle remote SET_PASSWORD command
    if (msg.action === 'SET_PASSWORD') {
      const newPin = msg.payload.newPassword;
      console.log(`🔐 [MOCK ESP32] >>> UPDATING PIN IN FLASH MEMORY: "${currentLocalPin}" -> "${newPin}" <<<`);
      currentLocalPin = newPin;

      // Send ACK back
      ws.send(JSON.stringify({
        type: 'PASSWORD_ACK',
        status: 'OK',
        activePin: currentLocalPin
      }));
      console.log('📤 [MOCK ESP32] Sent PASSWORD_ACK to Cloud Server.');
    }
  } catch (e) {
    console.error('Error parsing server message:', e.message);
  }
});

ws.on('close', () => {
  console.log('❌ [MOCK ESP32] Disconnected from server.');
});

ws.on('error', (err) => {
  console.error('❌ [MOCK ESP32] Connection error:', err.message);
});

// Keep process alive for testing
setTimeout(() => {
  console.log('\n====================================================');
  console.log('✨ [MOCK ESP32] Test cycle complete. Standing by for commands...');
  console.log('====================================================\n');
}, 6000);
