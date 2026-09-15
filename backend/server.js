/**
 * IoT Smart Safe - Main Express & WebSocket Server
 */

const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { WebSocketServer, WebSocket } = require('ws');
require('dotenv').config();

const db = require('./db');

// Initialize database
db.initDb();

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const DEVICE_SECRET = process.env.DEVICE_SECRET || 'smart_safe_secret_key_2026';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Set up WebSocket server
const wss = new WebSocketServer({ server, path: '/ws' });

// Track connected clients
const browserClients = new Set();
const deviceClients = new Set();

/**
 * Broadcast an event to all connected web browser dashboards
 */
function broadcastToBrowsers(messageObj) {
  const payload = JSON.stringify(messageObj);
  for (const client of browserClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

/**
 * Broadcast a command to connected ESP32 device(s)
 */
function sendCommandToDevice(commandObj) {
  const payload = JSON.stringify(commandObj);
  let delivered = false;
  for (const device of deviceClients) {
    if (device.readyState === WebSocket.OPEN) {
      device.send(payload);
      delivered = true;
    }
  }
  return delivered;
}

/**
 * Broadcast updated stats and latest activity to all dashboards
 */
function broadcastStatsUpdate() {
  const stats = db.getStats();
  broadcastToBrowsers({
    type: 'STATS_UPDATE',
    payload: {
      ...stats,
      isDeviceOnline: deviceClients.size > 0
    }
  });
}

// WebSocket Connection Handling
wss.on('connection', (ws, req) => {
  const urlParams = new URLSearchParams(req.url.replace(/^.*\?/, ''));
  const roleParam = urlParams.get('role');
  const secretParam = urlParams.get('secret');

  let clientRole = 'browser';
  let pendingDeviceAuthTimeout = null;

  function authenticateAsDevice() {
    if (pendingDeviceAuthTimeout) {
      clearTimeout(pendingDeviceAuthTimeout);
      pendingDeviceAuthTimeout = null;
    }

    // Only one physical safe exists - if an older device socket is still
    // registered (e.g. a stale session left over from a WiFi drop that never
    // closed cleanly), kick it out so the device count can never accumulate
    // ghost entries and "ESP32 ONLINE" always reflects the latest connection.
    for (const existing of Array.from(deviceClients)) {
      if (existing !== ws) {
        deviceClients.delete(existing);
        existing.terminate();
      }
    }

    browserClients.delete(ws);
    clientRole = 'device';
    deviceClients.add(ws);
    console.log(`[WS] ESP32 Device authenticated (${req.socket.remoteAddress}). Total devices: ${deviceClients.size}`);

    // Broadcast device status to web clients
    broadcastToBrowsers({
      type: 'DEVICE_STATUS',
      payload: { isDeviceOnline: true, deviceCount: deviceClients.size }
    });
  }

  if (roleParam === 'device') {
    if (secretParam === DEVICE_SECRET) {
      // Secret was already provided in the connection URL
      authenticateAsDevice();
    } else {
      // Do NOT count this as an online device yet - wait for a valid IDENTIFY
      // message carrying the correct secret. Without this check, anyone could
      // open /ws?role=device and falsely show "ESP32 ONLINE" on the dashboard.
      console.log(`[WS] Device connection pending authentication (${req.socket.remoteAddress})`);
      pendingDeviceAuthTimeout = setTimeout(() => {
        console.log('[WS] Device did not authenticate in time. Closing connection.');
        ws.close(4001, 'Authentication timeout');
      }, 5000);
    }
  } else {
    browserClients.add(ws);
    console.log(`[WS] Web Browser connected. Total browsers: ${browserClients.size}`);

    // Immediately send current stats and device status to new browser
    const stats = db.getStats();
    ws.send(JSON.stringify({
      type: 'INIT_STATE',
      payload: {
        ...stats,
        isDeviceOnline: deviceClients.size > 0,
        logs: db.getLogs(50)
      }
    }));
  }

  // Handle incoming messages
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Device identification from payload
      if (msg.type === 'IDENTIFY') {
        if (msg.role === 'device') {
          if (msg.secret !== DEVICE_SECRET) {
            console.log('[WS] Rejected IDENTIFY: invalid device secret');
            ws.close(4001, 'Invalid device secret');
            return;
          }
          authenticateAsDevice();
        }
        return;
      }

      // Heartbeat ping
      if (msg.type === 'PING') {
        ws.send(JSON.stringify({ type: 'PONG', timestamp: new Date().toISOString() }));
        return;
      }

      // Hardware Device Event: Keypad success/failed reported from ESP32
      if (msg.type === 'EVENT' || msg.source === 'KEYPAD') {
        const source = msg.source || 'KEYPAD';
        const status = msg.status || 'SUCCESS';
        const details = msg.details || (status === 'SUCCESS' ? 'เปิดสำเร็จจาก Keypad' : 'รหัสผิดจาก Keypad');

        console.log(`[EVENT] Received from ${source}: ${status} - ${details}`);
        db.addLog(source, status, details);

        // Notify browsers of new log entry and updated counters
        broadcastToBrowsers({
          type: 'NEW_LOG',
          payload: {
            source,
            status,
            details,
            created_at: new Date().toISOString()
          }
        });
        broadcastStatsUpdate();
      }

      // Live Keypad Input: Relay digit/clear/confirm events to browser dashboards
      if (msg.type === 'KEYPRESS') {
        broadcastToBrowsers({
          type: 'KEYPRESS',
          payload: {
            action: msg.action,
            count: msg.count || 0,
            key: msg.key || '',
            pin: msg.pin || ''
          }
        });
      }

      // Acknowledgment of password change from ESP32
      if (msg.type === 'PASSWORD_ACK') {
        console.log('[WS] ESP32 confirmed password update in Flash memory:', msg.status);
        broadcastToBrowsers({
          type: 'TOAST',
          payload: {
            title: 'ESP32 Synced',
            message: 'ตู้เซฟอัปเดตรหัสผ่านใหม่ลง Flash สำเร็จแล้ว',
            variant: 'success'
          }
        });
      }
    } catch (e) {
      console.error('[WS] Error processing message:', e.message);
    }
  });

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // Client disconnect
  ws.on('close', () => {
    if (pendingDeviceAuthTimeout) {
      clearTimeout(pendingDeviceAuthTimeout);
      pendingDeviceAuthTimeout = null;
    }
    if (clientRole === 'device') {
      deviceClients.delete(ws);
      console.log(`[WS] ESP32 Device disconnected. Remaining devices: ${deviceClients.size}`);
      broadcastToBrowsers({
        type: 'DEVICE_STATUS',
        payload: { isDeviceOnline: deviceClients.size > 0, deviceCount: deviceClients.size }
      });
    } else {
      browserClients.delete(ws);
      console.log(`[WS] Browser disconnected. Remaining browsers: ${browserClients.size}`);
    }
  });

  ws.on('error', (err) => {
    console.error('[WS] Connection error:', err.message);
  });
});

// Active Dead Connection Cleaner (every 3 seconds)
// Detects when ESP32 powers off or USB cable is unplugged - worst case is
// two missed pings, so ~6s max instead of the previous ~16s
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('[WS] Terminating unresponsive/dead socket connection...');
      const hadDevice = deviceClients.has(ws);
      deviceClients.delete(ws);
      browserClients.delete(ws);
      
      if (hadDevice) {
        broadcastToBrowsers({
          type: 'DEVICE_STATUS',
          payload: { isDeviceOnline: deviceClients.size > 0, deviceCount: deviceClients.size }
        });
      }
      return ws.terminate();
    }

    ws.isAlive = false;
    ws.ping();
  });
}, 3000);

// ==========================================
// REST API ROUTES
// ==========================================

// Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    isDeviceOnline: deviceClients.size > 0,
    connectedDevices: deviceClients.size,
    connectedBrowsers: browserClients.size
  });
});

// Get Dashboard Stats
app.get('/api/safe/stats', (req, res) => {
  try {
    const stats = db.getStats();
    res.json({
      success: true,
      ...stats,
      isDeviceOnline: deviceClients.size > 0
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get Historical Logs
app.get('/api/safe/logs', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 200);
    const logs = db.getLogs(limit);
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Chart Data: Hourly activity for today + overall breakdown
app.get('/api/safe/chart-data', (req, res) => {
  try {
    const logs = db.getLogs(200);
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD

    // Hourly buckets for today (0-23)
    const hourlySuccess = new Array(24).fill(0);
    const hourlyFailed  = new Array(24).fill(0);

    // Last 7 days daily buckets
    const dailyMap = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      dailyMap[d.toISOString().slice(0, 10)] = { success: 0, failed: 0 };
    }

    logs.forEach(log => {
      const d = new Date(log.created_at);
      const dayKey = d.toISOString().slice(0, 10);
      const hour   = d.getHours();
      const isSuccess = log.status === 'SUCCESS';

      // Hourly (today only)
      if (dayKey === todayStr) {
        if (isSuccess) hourlySuccess[hour]++;
        else           hourlyFailed[hour]++;
      }

      // Daily (last 7 days)
      if (dailyMap[dayKey] !== undefined) {
        if (isSuccess) dailyMap[dayKey].success++;
        else           dailyMap[dayKey].failed++;
      }
    });

    const dailyLabels  = Object.keys(dailyMap);
    const dailySuccess = dailyLabels.map(k => dailyMap[k].success);
    const dailyFailed  = dailyLabels.map(k => dailyMap[k].failed);

    const stats = db.getStats();

    res.json({
      success: true,
      donut: {
        labels: ['สำเร็จ', 'รหัสผิด'],
        values: [stats.successCount, stats.failedCount]
      },
      hourly: {
        labels: Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2,'0')}:00`),
        success: hourlySuccess,
        failed: hourlyFailed
      },
      daily: {
        labels: dailyLabels,
        success: dailySuccess,
        failed: dailyFailed
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Remote Unlock from Website
app.post('/api/safe/unlock', (req, res) => {
  try {
    console.log('[API] Remote unlock command received from Web Dashboard');

    // Send command to connected ESP32 device(s)
    const isDeviceDelivered = sendCommandToDevice({
      type: 'COMMAND',
      action: 'UNLOCK',
      timestamp: new Date().toISOString()
    });

    // If the device never received the command, nothing actually happened
    // at the safe - don't log a fake SUCCESS entry or tell the browser the
    // unlock worked.
    if (!isDeviceDelivered) {
      return res.json({
        success: false,
        message: 'ส่งคำสั่งไม่สำเร็จ: ESP32 ออฟไลน์อยู่ ตู้เซฟไม่ได้ถูกปลดล็อกจริง',
        isDeviceOnline: false
      });
    }

    const logDetails = 'สั่งเปิดจากเว็บไซต์ (ส่งคำสั่งถึง ESP32 สำเร็จ)';
    db.addLog('WEBSITE', 'SUCCESS', logDetails);

    // Broadcast to web dashboards
    broadcastToBrowsers({
      type: 'NEW_LOG',
      payload: {
        source: 'WEBSITE',
        status: 'SUCCESS',
        details: logDetails,
        created_at: new Date().toISOString()
      }
    });
    broadcastStatsUpdate();

    res.json({
      success: true,
      message: 'ส่งคำสั่งเปิดตู้เซฟไปยัง ESP32 สำเร็จ',
      isDeviceOnline: true
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Change Safe Password from Website
app.post('/api/safe/change-password', (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({
        success: false,
        message: 'กรุณากรอกข้อมูลให้ครบทุกช่อง'
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: 'รหัสผ่านใหม่และการยืนยันรหัสผ่านไม่ตรงกัน'
      });
    }

    if (!/^\d{4}$/.test(newPassword)) {
      return res.status(400).json({
        success: false,
        message: 'รหัสผ่านต้องเป็นตัวเลข 4 หลักเท่านั้น (เช่น 1234)'
      });
    }

    // Verify current password against database
    const isCurrentValid = db.checkPassword(currentPassword);
    if (!isCurrentValid) {
      return res.status(400).json({
        success: false,
        message: 'รหัสผ่านปัจจุบันไม่ถูกต้อง'
      });
    }

    // Update password in database
    db.updateSafePassword(newPassword);
    console.log('[API] Safe password updated successfully in DB');

    // Push new password command to ESP32 device
    const isDeviceDelivered = sendCommandToDevice({
      type: 'COMMAND',
      action: 'SET_PASSWORD',
      payload: {
        newPassword
      }
    });

    // Notify connected browsers (Never expose actual password in broadcast)
    const syncMessage = isDeviceDelivered
      ? 'เปลี่ยนรหัสผ่านตู้เซฟเรียบร้อยแล้ว สามารถใช้รหัสใหม่ที่ Keypad ได้ทันที'
      : 'เปลี่ยนรหัสผ่านในระบบเรียบร้อยแล้ว แต่ ESP32 ออฟไลน์อยู่ - รหัสใหม่จะมีผลที่ Keypad เมื่อบอร์ดเชื่อมต่อ Cloud อีกครั้ง';
    broadcastToBrowsers({
      type: 'TOAST',
      payload: {
        title: 'รหัสผ่านเปลี่ยนสำเร็จ',
        message: syncMessage,
        variant: isDeviceDelivered ? 'success' : 'info'
      }
    });

    res.json({
      success: true,
      message: syncMessage,
      isDeviceOnline: isDeviceDelivered
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Device Event Ingestion via HTTP REST (Fallback if WebSocket drops)
app.post('/api/device/event', (req, res) => {
  try {
    const { source, status, details } = req.body;
    const cleanSource = source === 'WEBSITE' ? 'WEBSITE' : 'KEYPAD';
    const cleanStatus = status === 'SUCCESS' ? 'SUCCESS' : 'FAILED';
    const cleanDetails = details || (cleanStatus === 'SUCCESS' ? 'เปิดสำเร็จ' : 'รหัสไม่ถูกต้อง');

    db.addLog(cleanSource, cleanStatus, cleanDetails);

    broadcastToBrowsers({
      type: 'NEW_LOG',
      payload: {
        source: cleanSource,
        status: cleanStatus,
        details: cleanDetails,
        created_at: new Date().toISOString()
      }
    });
    broadcastStatsUpdate();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Device Sync Endpoint: ESP32 retrieves the active PIN on initial boot
app.get('/api/device/sync-pin', (req, res) => {
  try {
    const pin = db.getDevicePin();
    res.json({
      success: true,
      pin,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Fallback to index.html for Single Page App
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Start Server - bind to 0.0.0.0 for cloud hosting (Render, Railway, etc.)
const HOST = '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`====================================================`);
  console.log(`  🛡️  SMART SAFE IoT SERVER RUNNING`);
  console.log(`  🌐  Web Dashboard:  http://localhost:${PORT}`);
  console.log(`  ⚡  WebSocket URL:   ws://localhost:${PORT}/ws`);
  console.log(`  🔌  Device Connect: ws://localhost:${PORT}/ws?role=device`);
  console.log(`  ☁️  Host Binding:    ${HOST}:${PORT}`);
  console.log(`====================================================`);
});
