/**
 * Smart Safe IoT Web Dashboard Client
 * Realtime WebSocket + REST API handler with sound feedback and interactive controls
 */

// State
const state = {
  successCount: 0,
  failedCount: 0,
  totalCount: 0,
  lastActivity: null,
  safeState: 'LOCKED',
  isDeviceOnline: false,
  logs: [],
  activeFilter: 'ALL',
  ws: null,
  reconnectInterval: 2000
};

// Web Audio Synthesizer for High-Tech Feedback
const AudioFX = {
  ctx: null,
  init() {
    if (!this.ctx && (window.AudioContext || window.webkitAudioContext)) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
  },
  playUnlock() {
    try {
      this.init();
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      // High-tech ascending dual-tone
      const osc1 = this.ctx.createOscillator();
      const osc2 = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc1.type = 'sine';
      osc2.type = 'triangle';

      osc1.frequency.setValueAtTime(523.25, now); // C5
      osc1.frequency.exponentialRampToValueAtTime(880, now + 0.15); // A5

      osc2.frequency.setValueAtTime(659.25, now + 0.08); // E5
      osc2.frequency.exponentialRampToValueAtTime(1046.50, now + 0.25); // C6

      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(this.ctx.destination);

      osc1.start(now);
      osc2.start(now + 0.08);
      osc1.stop(now + 0.35);
      osc2.stop(now + 0.35);
    } catch (e) {
      console.warn('Audio play error:', e);
    }
  },
  playAlert() {
    try {
      this.init();
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      // Low buzzy alert tone
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(300, now);
      osc.frequency.setValueAtTime(220, now + 0.1);

      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now);
      osc.stop(now + 0.3);
    } catch (e) {
      console.warn('Audio alert error:', e);
    }
  }
};

// UI Elements
const el = {
  liveClockText: document.getElementById('liveClockText'),
  deviceStatusBadge: document.getElementById('deviceStatusBadge'),
  deviceStatusText: document.getElementById('deviceStatusText'),
  statSuccessCount: document.getElementById('statSuccessCount'),
  statFailedCount: document.getElementById('statFailedCount'),
  lastActivityTime: document.getElementById('lastActivityTime'),
  lastActivityBadge: document.getElementById('lastActivityBadge'),
  lastActivityDetails: document.getElementById('lastActivityDetails'),
  safeStateTag: document.getElementById('safeStateTag'),
  safeDoorFrame: document.getElementById('safeDoorFrame'),
  safeStatusMessage: document.getElementById('safeStatusMessage'),
  btnOpenSafe: document.getElementById('btnOpenSafe'),
  changePasswordForm: document.getElementById('changePasswordForm'),
  currentPasswordInput: document.getElementById('currentPasswordInput'),
  newPasswordInput: document.getElementById('newPasswordInput'),
  confirmPasswordInput: document.getElementById('confirmPasswordInput'),
  btnSubmitPassword: document.getElementById('btnSubmitPassword'),
  pwdSpinner: document.getElementById('pwdSpinner'),
  pwdBtnText: document.getElementById('pwdBtnText'),
  logsTableBody: document.getElementById('logsTableBody'),
  toastContainer: document.getElementById('toastContainer'),
  filterButtons: document.querySelectorAll('.filter-btn'),
  keypadLiveDisplay: document.getElementById('keypadLiveDisplay'),
  pinDotsContainer: document.getElementById('pinDotsContainer'),
  pinDots: document.querySelectorAll('.pin-dot'),
  keypadDisplayStatus: document.getElementById('keypadDisplayStatus')
};

// Format Timestamp Helper (DD/MM/YYYY HH:mm:ss)
function formatTimestamp(isoStr) {
  if (!isoStr) return '-';
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr;
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');
    return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
  } catch (e) {
    return isoStr;
  }
}

// Live Clock Ticker
function updateClock() {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  el.liveClockText.textContent = `${hours}:${minutes}:${seconds}`;
}
setInterval(updateClock, 1000);
updateClock();

// Toast Notifications
function showToast(title, message, variant = 'info', duration = 4500) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${variant}`;
  toast.innerHTML = `
    <div class="toast-content">
      <div class="toast-title">${title}</div>
      <div class="toast-message">${message}</div>
    </div>
  `;
  el.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// Connect Real-Time WebSocket
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  console.log('[WS] Connecting to:', wsUrl);
  const ws = new WebSocket(wsUrl);
  state.ws = ws;

  ws.onopen = () => {
    console.log('[WS] Connected successfully');
    state.reconnectInterval = 2000;
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleSocketMessage(msg);
    } catch (err) {
      console.error('[WS] Parse error:', err);
    }
  };

  ws.onclose = () => {
    console.warn(`[WS] Disconnected. Retrying in ${state.reconnectInterval / 1000}s...`);
    setTimeout(connectWebSocket, state.reconnectInterval);
    state.reconnectInterval = Math.min(state.reconnectInterval * 1.5, 15000);
  };

  ws.onerror = (err) => {
    console.error('[WS] Socket error:', err);
  };
}

// Handle Incoming Real-Time WebSocket Messages
function handleSocketMessage(msg) {
  switch (msg.type) {
    case 'INIT_STATE':
      state.successCount = msg.payload.successCount || 0;
      state.failedCount = msg.payload.failedCount || 0;
      state.totalCount = msg.payload.totalCount || 0;
      state.lastActivity = msg.payload.lastActivity || null;
      state.safeState = msg.payload.safeState || 'LOCKED';
      state.isDeviceOnline = !!msg.payload.isDeviceOnline;
      state.logs = msg.payload.logs || [];
      updateDashboardUI();
      break;

    case 'STATS_UPDATE':
      state.successCount = msg.payload.successCount || 0;
      state.failedCount = msg.payload.failedCount || 0;
      state.totalCount = msg.payload.totalCount || 0;
      state.lastActivity = msg.payload.lastActivity || null;
      state.safeState = msg.payload.safeState || state.safeState;
      if (typeof msg.payload.isDeviceOnline !== 'undefined') {
        state.isDeviceOnline = msg.payload.isDeviceOnline;
      }
      updateDashboardUI();
      break;

    case 'DEVICE_STATUS':
      state.isDeviceOnline = !!msg.payload.isDeviceOnline;
      updateDeviceBadgeUI();
      showToast(
        'สถานะฮาร์ดแวร์',
        state.isDeviceOnline ? 'ESP32 เชื่อมต่อกับระบบแล้ว' : 'ESP32 หลุดการเชื่อมต่อ',
        state.isDeviceOnline ? 'success' : 'info',
        3000
      );
      break;

    case 'NEW_LOG':
      const newLog = msg.payload;
      state.logs.unshift(newLog);
      state.lastActivity = newLog;

      if (newLog.status === 'SUCCESS') {
        state.successCount++;
        triggerSafeUnlockAnimation();
        AudioFX.playUnlock();
        showToast(
          'เปิดตู้สำเร็จ',
          `${newLog.source === 'KEYPAD' ? 'กดรหัสถูกต้องจาก Keypad' : 'สั่งเปิดจากเว็บไซต์'}`,
          'success'
        );
      } else {
        state.failedCount++;
        triggerSafeFailedAnimation();
        AudioFX.playAlert();
        showToast(
          'รหัสไม่ถูกต้อง!',
          'มีการกดรหัสผิดที่ Keypad หน้าตู้เซฟ (Buzzer ทำงาน)',
          'error'
        );
      }
      state.totalCount = state.successCount + state.failedCount;
      updateDashboardUI();
      break;

    case 'TOAST':
      if (msg.payload) {
        showToast(msg.payload.title, msg.payload.message, msg.payload.variant || 'info');
      }
      break;

    case 'KEYPRESS':
      handleKeypadLiveDisplay(msg.payload);
      break;
  }
}

// Handle Real-time Keypad Display on Web
let keypadClearTimer = null;
function handleKeypadLiveDisplay(payload) {
  if (!el.keypadLiveDisplay || !el.pinDotsContainer) return;

  const action = payload.action;
  const count = payload.count || 0;
  const key = payload.key || '';
  const pin = payload.pin || '';

  if (keypadClearTimer) clearTimeout(keypadClearTimer);

  if (action === 'CLEAR') {
    if (el.keypadDisplayStatus) {
      el.keypadDisplayStatus.textContent = 'ล้างข้อมูล (*)';
      el.keypadDisplayStatus.className = 'keypad-display-status clear';
    }
    el.pinDotsContainer.innerHTML = '<span class="pin-dot-placeholder">กดปุ่มที่ Keypad</span>';
    keypadClearTimer = setTimeout(() => {
      if (el.keypadDisplayStatus) {
        el.keypadDisplayStatus.textContent = 'รอรับข้อมูล...';
        el.keypadDisplayStatus.className = 'keypad-display-status';
      }
    }, 2000);
  } else if (action === 'CONFIRM') {
    if (el.keypadDisplayStatus) {
      el.keypadDisplayStatus.textContent = 'กำลังตรวจสอบรหัส (#)...';
      el.keypadDisplayStatus.className = 'keypad-display-status checking';
    }
    keypadClearTimer = setTimeout(() => {
      if (el.keypadDisplayStatus) {
        el.keypadDisplayStatus.textContent = 'รอรับข้อมูล...';
        el.keypadDisplayStatus.className = 'keypad-display-status';
      }
      el.pinDotsContainer.innerHTML = '<span class="pin-dot-placeholder">กดปุ่มที่ Keypad</span>';
    }, 3000);
  } else if (action === 'DIGIT') {
    if (el.keypadDisplayStatus) {
      el.keypadDisplayStatus.textContent = `กดเลข '${key}' (${count}/4)`;
      el.keypadDisplayStatus.className = 'keypad-display-status active';
    }

    // Render numbers pressed visually in clean digit boxes
    let html = '';
    for (let i = 0; i < 4; i++) {
      if (i < pin.length) {
        const char = pin[i];
        html += `<div class="pin-digit-box filled bounce-in">${char}</div>`;
      } else {
        html += `<div class="pin-digit-box empty"></div>`;
      }
    }
    el.pinDotsContainer.innerHTML = html;

    // Play click sound if enabled
    try {
      if (typeof AudioFX !== 'undefined' && AudioFX.playClick) {
        AudioFX.playClick();
      }
    } catch(e) {}

    // Auto reset after 8 seconds of inactivity
    keypadClearTimer = setTimeout(() => {
      if (el.keypadDisplayStatus) {
        el.keypadDisplayStatus.textContent = 'รอรับข้อมูล...';
        el.keypadDisplayStatus.className = 'keypad-display-status';
      }
      el.pinDotsContainer.innerHTML = '<span class="pin-dot-placeholder">กดปุ่มที่ Keypad</span>';
    }, 8000);
  }
}

// Update UI with Current State
function updateDashboardUI() {
  // Counters
  el.statSuccessCount.textContent = state.successCount;
  el.statFailedCount.textContent = state.failedCount;

  // Last Activity
  if (state.lastActivity && state.lastActivity.created_at) {
    el.lastActivityTime.textContent = formatTimestamp(state.lastActivity.created_at);
    el.lastActivityBadge.textContent = state.lastActivity.source === 'KEYPAD' ? 'Keypad' : 'Website';
    el.lastActivityDetails.textContent = state.lastActivity.details || (state.lastActivity.status === 'SUCCESS' ? 'เปิดสำเร็จ' : 'รหัสผิด');
  } else {
    el.lastActivityTime.textContent = 'ยังไม่มีประวัติ';
    el.lastActivityBadge.textContent = '-';
    el.lastActivityDetails.textContent = 'รอการทำงาน...';
  }

  // Device Status Badge
  updateDeviceBadgeUI();

  // Render Table
  renderLogsTable();

  // Refresh Charts
  loadChartData();
}

function updateDeviceBadgeUI() {
  if (state.isDeviceOnline) {
    el.deviceStatusBadge.className = 'device-status-badge online';
    el.deviceStatusText.textContent = 'ESP32 ONLINE';
    el.deviceStatusBadge.setAttribute('title', 'บอร์ด KidBright32 / ESP32 กำลังเชื่อมต่อ Online');
  } else {
    el.deviceStatusBadge.className = 'device-status-badge offline';
    el.deviceStatusText.textContent = 'ESP32 OFFLINE';
    el.deviceStatusBadge.setAttribute('title', 'ยังไม่พบการเชื่อมต่อจากบอร์ด ESP32');
  }
}

// Visual Safe Door Animations
let lockTimeout = null;

function triggerSafeUnlockAnimation() {
  el.safeDoorFrame.classList.add('unlocked');
  el.safeStateTag.className = 'safe-state-tag unlocked';
  el.safeStateTag.textContent = 'UNLOCKED';
  el.safeStatusMessage.textContent = '🔓 ปลดล็อกตู้เซฟแล้ว (LED Matrix กำลังกระพริบ)';

  if (lockTimeout) clearTimeout(lockTimeout);
  lockTimeout = setTimeout(() => {
    el.safeDoorFrame.classList.remove('unlocked');
    el.safeStateTag.className = 'safe-state-tag locked';
    el.safeStateTag.textContent = 'LOCKED';
    el.safeStatusMessage.textContent = 'ระบบล็อกอยู่ - พร้อมรับคำสั่งจากเว็บหรือ Keypad';
  }, 4500);
}

function triggerSafeFailedAnimation() {
  el.safeDoorFrame.style.animation = 'none';
  void el.safeDoorFrame.offsetWidth; // force reflow
  el.safeDoorFrame.style.boxShadow = '0 0 40px rgba(244, 63, 94, 0.6), inset 0 0 30px rgba(244, 63, 94, 0.4)';
  el.safeStatusMessage.textContent = '⚠️ รหัสไม่ถูกต้อง! Buzzer แจ้งเตือน 10 ครั้ง';

  setTimeout(() => {
    el.safeDoorFrame.style.boxShadow = '';
    el.safeStatusMessage.textContent = 'ระบบล็อกอยู่ - พร้อมรับคำสั่งจากเว็บหรือ Keypad';
  }, 5000);
}

// Render History Table with Filtering
function renderLogsTable() {
  const filtered = state.logs.filter((log) => {
    if (state.activeFilter === 'ALL') return true;
    if (state.activeFilter === 'KEYPAD') return log.source === 'KEYPAD';
    if (state.activeFilter === 'WEBSITE') return log.source === 'WEBSITE';
    if (state.activeFilter === 'SUCCESS') return log.status === 'SUCCESS';
    if (state.activeFilter === 'FAILED') return log.status === 'FAILED';
    return true;
  });

  if (filtered.length === 0) {
    el.logsTableBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="4" class="text-center">ไม่พบข้อมูลประวัติการใช้งานในตัวกรองนี้</td>
      </tr>
    `;
    return;
  }

  el.logsTableBody.innerHTML = filtered.map((log) => {
    const isSuccess = log.status === 'SUCCESS';
    const isKeypad = log.source === 'KEYPAD';
    
    const sourceBadge = isKeypad
      ? '<span class="badge-source keypad">🔢 เปิดจาก Keypad</span>'
      : '<span class="badge-source website">📱 เปิดจาก Website</span>';

    const resultBadge = isSuccess
      ? '<span class="badge-result success">✅ สำเร็จ</span>'
      : '<span class="badge-result failed">❌ รหัสไม่ถูกต้อง</span>';

    return `
      <tr>
        <td class="log-time">${formatTimestamp(log.created_at)}</td>
        <td>${sourceBadge}</td>
        <td>${resultBadge}</td>
        <td>${log.details || (isSuccess ? 'เปิดตู้สำเร็จ' : 'รหัสผิด')}</td>
      </tr>
    `;
  }).join('');
}

// Action: Remote Safe Unlock
el.btnOpenSafe.addEventListener('click', async () => {
  AudioFX.init();
  el.btnOpenSafe.disabled = true;

  try {
    const res = await fetch('/api/safe/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();

    if (data.success) {
      triggerSafeUnlockAnimation();
      AudioFX.playUnlock();
      showToast('คำสั่งสำเร็จ', data.message, 'success');
    } else {
      showToast('เกิดข้อผิดพลาด', data.message || 'ไม่สามารถส่งคำสั่งเปิดตู้ได้', 'error');
    }
  } catch (err) {
    console.error('Unlock error:', err);
    showToast('ข้อผิดพลาดการเชื่อมต่อ', 'ไม่สามารถติดต่อเซิร์ฟเวอร์ได้', 'error');
  } finally {
    setTimeout(() => {
      el.btnOpenSafe.disabled = false;
    }, 2500);
  }
});

// Action: Password Form Submit
el.changePasswordForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const currentPassword = el.currentPasswordInput.value.trim();
  const newPassword = el.newPasswordInput.value.trim();
  const confirmPassword = el.confirmPasswordInput.value.trim();

  // Basic Validations
  if (!currentPassword || !newPassword || !confirmPassword) {
    showToast('ข้อมูลไม่ครบ', 'กรุณากรอกข้อมูลให้ครบทุกช่อง', 'error');
    return;
  }

  if (newPassword !== confirmPassword) {
    showToast('รหัสไม่ตรงกัน', 'รหัสผ่านใหม่และการยืนยันรหัสผ่านไม่ตรงกัน', 'error');
    return;
  }

  if (!/^\d{4}$/.test(newPassword)) {
    showToast('รูปแบบไม่ถูกต้อง', 'รหัสผ่านต้องเป็นตัวเลข 4 หลักเท่านั้น', 'error');
    return;
  }

  // Submit to Backend
  el.pwdSpinner.classList.remove('hidden');
  el.pwdBtnText.textContent = 'กำลังบันทึก...';
  el.btnSubmitPassword.disabled = true;

  try {
    const res = await fetch('/api/safe/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword, confirmPassword })
    });
    const data = await res.json();

    if (data.success) {
      showToast('สำเร็จ', data.message, 'success');
      el.changePasswordForm.reset();
    } else {
      showToast('เปลี่ยนรหัสไม่สำเร็จ', data.message || 'รหัสผ่านเดิมไม่ถูกต้อง', 'error');
    }
  } catch (err) {
    console.error('Password change error:', err);
    showToast('ข้อผิดพลาดการเชื่อมต่อ', 'ไม่สามารถติดต่อเซิร์ฟเวอร์ได้', 'error');
  } finally {
    el.pwdSpinner.classList.add('hidden');
    el.pwdBtnText.textContent = 'บันทึกรหัสผ่านใหม่';
    el.btnSubmitPassword.disabled = false;
  }
});

// Toggle Password Visibility Eye Buttons
document.querySelectorAll('.btn-toggle-pwd').forEach((btn) => {
  btn.addEventListener('click', () => {
    const targetId = btn.getAttribute('data-target');
    const input = document.getElementById(targetId);
    if (input.type === 'password') {
      input.type = 'text';
      btn.style.color = 'var(--cyan-accent)';
    } else {
      input.type = 'password';
      btn.style.color = '';
    }
  });
});

// Filter Table Buttons
el.filterButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    el.filterButtons.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.activeFilter = btn.getAttribute('data-filter');
    renderLogsTable();
  });
});

// ==========================================
// CHART.JS INTEGRATION
// ==========================================
let donutChart = null;
let dailyChart = null;

function initCharts() {
  const ctxDonut = document.getElementById('chartDonut');
  const ctxDaily = document.getElementById('chartDaily');

  if (!ctxDonut || !ctxDaily || typeof Chart === 'undefined') {
    console.warn('Chart.js or canvas element not found.');
    return;
  }

  // Common dark theme options
  Chart.defaults.font.family = "'Outfit', sans-serif";
  Chart.defaults.color = '#94a3b8';

  // Donut Chart
  donutChart = new Chart(ctxDonut, {
    type: 'doughnut',
    data: {
      labels: ['สำเร็จ', 'รหัสผิด'],
      datasets: [{
        data: [0, 0],
        backgroundColor: ['#10b981', '#f43f5e'],
        hoverBackgroundColor: ['#34d399', '#fb7185'],
        borderWidth: 0,
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '72%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: '#cbd5e1',
            usePointStyle: true,
            padding: 15,
            font: { size: 12 }
          }
        },
        tooltip: {
          backgroundColor: '#0f172a',
          titleColor: '#f8fafc',
          bodyColor: '#cbd5e1',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          padding: 10
        }
      }
    }
  });

  // Daily Bar Chart
  dailyChart = new Chart(ctxDaily, {
    type: 'bar',
    data: {
      labels: [],
      datasets: [
        {
          label: 'เปิดสำเร็จ',
          data: [],
          backgroundColor: '#10b981',
          borderRadius: 6,
          maxBarThickness: 28
        },
        {
          label: 'รหัสผิด',
          data: [],
          backgroundColor: '#f43f5e',
          borderRadius: 6,
          maxBarThickness: 28
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'top',
          align: 'end',
          labels: {
            color: '#cbd5e1',
            usePointStyle: true,
            boxWidth: 8,
            font: { size: 12 }
          }
        },
        tooltip: {
          backgroundColor: '#0f172a',
          titleColor: '#f8fafc',
          bodyColor: '#cbd5e1',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          padding: 10
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#64748b', font: { size: 11 } }
        },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: '#64748b', precision: 0, font: { size: 11 } }
        }
      }
    }
  });
}

async function loadChartData() {
  try {
    const res = await fetch('/api/safe/chart-data');
    const data = await res.json();
    if (data.success) {
      // Donut
      if (donutChart) {
        donutChart.data.datasets[0].data = data.donut.values;
        donutChart.update();
      }
      const total = (data.donut.values[0] || 0) + (data.donut.values[1] || 0);
      const totalEl = document.getElementById('donutTotal');
      if (totalEl) totalEl.textContent = total;

      // Daily
      if (dailyChart) {
        const formattedLabels = data.daily.labels.map((l) => {
          const parts = l.split('-');
          return parts.length === 3 ? `${parts[2]}/${parts[1]}` : l;
        });
        dailyChart.data.labels = formattedLabels;
        dailyChart.data.datasets[0].data = data.daily.success;
        dailyChart.data.datasets[1].data = data.daily.failed;
        dailyChart.update();
      }
    }
  } catch (err) {
    console.warn('Failed to load chart data:', err);
  }
}

// Initialize on page load
window.addEventListener('DOMContentLoaded', () => {
  initCharts();
  connectWebSocket();

  // Initial REST fetch in case WebSocket takes a moment
  fetch('/api/safe/stats')
    .then((r) => r.json())
    .then((data) => {
      if (data.success) {
        state.successCount = data.successCount;
        state.failedCount = data.failedCount;
        state.totalCount = data.totalCount;
        state.lastActivity = data.lastActivity;
        state.safeState = data.safeState;
        state.isDeviceOnline = data.isDeviceOnline;
        updateDashboardUI();
      }
    })
    .catch((err) => console.warn('Init fetch stats error:', err));

  fetch('/api/safe/logs?limit=50')
    .then((r) => r.json())
    .then((data) => {
      if (data.success && Array.isArray(data.logs)) {
        state.logs = data.logs;
        renderLogsTable();
      }
    })
    .catch((err) => console.warn('Init fetch logs error:', err));

  loadChartData();
});
