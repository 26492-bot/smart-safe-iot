/**
 * ================================================================
 * SMART SAFE IoT - KidBright32 Arduino Firmware
 * ================================================================
 * Hardware Connections:
 *  - Keypad 4x4:
 *      * Rows:    GPIO 26, 27, 18, 19
 *      * Columns: GPIO 33, 23, 21, 22
 *  - LED Matrix HT16K33:
 *      * I2C Address: 0x70
 *      * SDA: GPIO 21 (Shared with Keypad Col 3)
 *      * SCL: GPIO 22 (Shared with Keypad Col 4)
 *  - Buzzer:
 *      * GPIO 13
 * ================================================================
 * Safe Logic:
 *  - Initial PIN: 1234 (stored in Flash NVS via Preferences.h)
 *  - Max PIN length: 4 digits
 *  - '#' confirm, '*' clear
 *  - Correct PIN:
 *      * Buzzer silent (รหัสถูก -> ไม่ต้องร้อง)
 *      * LED Matrix 1s ON, 1s OFF for 2 cycles
 *      * Event logged as SUCCESS
 *  - Wrong PIN:
 *      * Buzzer 1000 Hz + LED Matrix 0.5s ON, 0.5s OFF for 10 cycles
 *      * noTone() called when sequence completes
 *      * Event logged as FAILED
 *  - Bidirectional IoT:
 *      * Remote UNLOCK from Website
 *      * Remote SET_PASSWORD from Website saved to Flash NVS
 *      * Cloud PIN sync on startup
 *  - Non-blocking state machine (millis()) preserves WiFi/WebSocket connectivity
 *  - Security: Real passwords are NEVER displayed in Serial Monitor (shown as ****)
 * ================================================================
 */

#include <Wire.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"
#include "config.h"

// ================================================================
// CONSTANTS & STATE DEFINITIONS
// ================================================================
enum SafeState {
  STATE_IDLE,
  STATE_UNLOCKING,    // 1s ON, 1s OFF for 2 cycles (Total 4s)
  STATE_ALARM         // 0.5s ON, 0.5s OFF for 10 cycles (Total 10s)
};

SafeState currentState = STATE_IDLE;
unsigned long lastCycleToggle = 0;
int currentCycleCount = 0;
bool cyclePhaseActive = false;

// Keypad Buffer
char enteredPin[PIN_LENGTH + 1] = {0};
byte enteredIndex = 0;
String activePin = DEFAULT_PIN;

// NVS Flash storage
Preferences preferences;

// WebSockets Client
WebSocketsClient webSocket;
bool isWsConnected = false;
unsigned long lastHeartbeatTime = 0;
const unsigned long HEARTBEAT_INTERVAL = 20000; // 20 seconds

// 4x4 Keypad Matrix Mapping
// FIX: ย้าย ROW_PINS / COL_PINS มาไว้ใน .ino เพื่อป้องกัน multiple definition
const byte ROW_PINS[KEYPAD_ROWS] = { 26, 27, 18, 19 };
const byte COL_PINS[KEYPAD_COLS] = { 33, 23, 21, 22 };

const char KEY_MAP[KEYPAD_ROWS][KEYPAD_COLS] = {
  { '1', '2', '3', 'A' },
  { '4', '5', '6', 'B' },
  { '7', '8', '9', 'C' },
  { '*', '0', '#', 'D' }
};

// ================================================================
// BUZZER CONTROL (GPIO 13)
// ================================================================

void buzzerAlarmOn() {
  tone(PIN_BUZZER, 1000); // 1000 Hz alarm tone
}

void buzzerAlarmOff() {
  noTone(PIN_BUZZER);
  digitalWrite(PIN_BUZZER, LOW);
}

// ================================================================
// HT16K33 I2C LED MATRIX (0x70)
// ================================================================

void ht16k33_init() {
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  Wire.setClock(100000); // Standard 100kHz I2C

  // Turn on system oscillator (0x21)
  Wire.beginTransmission(LED_ADDRESS);
  Wire.write(0x21);
  Wire.endTransmission();

  // Display ON, no blinking (0x81)
  Wire.beginTransmission(LED_ADDRESS);
  Wire.write(0x81);
  Wire.endTransmission();

  // Dimming: maximum brightness (0xEF)
  Wire.beginTransmission(LED_ADDRESS);
  Wire.write(0xEF);
  Wire.endTransmission();

  // Initial display state: OFF
  setLedMatrix(false);
}

void setLedMatrix(bool turnOn) {
  // CRITICAL: Ensure all keypad rows are INPUT (High-Z) before I2C transmission
  // so that any pressed key on col 21 or 22 cannot pull SDA or SCL to GND!
  for (int r = 0; r < KEYPAD_ROWS; r++) {
    pinMode(ROW_PINS[r], INPUT);
  }

  Wire.beginTransmission(LED_ADDRESS);
  Wire.write(0x00); // Start at display RAM address 0x00
  uint8_t fillByte = turnOn ? 0xFF : 0x00;
  for (int i = 0; i < 16; i++) {
    Wire.write(fillByte);
  }
  Wire.endTransmission();
}

// ================================================================
// MANUAL KEYPAD SCANNER (COMPATIBLE WITH SHARED GPIO 21/22)
// ================================================================

void initKeypadPins() {
  // All rows are initialized as INPUT (High-Z floating)
  for (int r = 0; r < KEYPAD_ROWS; r++) {
    pinMode(ROW_PINS[r], INPUT);
  }

  // Column pins initialized with pull-up resistors
  pinMode(COL_PINS[0], INPUT_PULLUP); // GPIO 33
  pinMode(COL_PINS[1], INPUT_PULLUP); // GPIO 23
  pinMode(COL_PINS[2], INPUT_PULLUP); // GPIO 21 (SDA, has onboard I2C pullup)
  pinMode(COL_PINS[3], INPUT_PULLUP); // GPIO 22 (SCL, has onboard I2C pullup)
}

char scanKeypadRaw() {
  // Guarantee all rows are High-Z initially
  for (int r = 0; r < KEYPAD_ROWS; r++) {
    pinMode(ROW_PINS[r], INPUT);
  }

  for (int r = 0; r < KEYPAD_ROWS; r++) {
    // Activate only this row by setting it OUTPUT LOW
    pinMode(ROW_PINS[r], OUTPUT);
    digitalWrite(ROW_PINS[r], LOW);
    delayMicroseconds(25); // Brief settling time

    for (int c = 0; c < KEYPAD_COLS; c++) {
      if (digitalRead(COL_PINS[c]) == LOW) {
        char key = KEY_MAP[r][c];
        // IMMEDIATELY restore row back to High-Z INPUT before returning!
        pinMode(ROW_PINS[r], INPUT);
        return key;
      }
    }

    // Restore row back to High-Z INPUT before scanning next row
    pinMode(ROW_PINS[r], INPUT);
    delayMicroseconds(5);
  }

  return 0; // No key pressed
}

char getPressedKey() {
  static char lastKey = 0;
  static unsigned long lastDebounceTime = 0;
  static bool isWaitingRelease = false;

  char rawKey = scanKeypadRaw();

  if (rawKey != 0) {
    if (!isWaitingRelease && (millis() - lastDebounceTime > 60)) {
      isWaitingRelease = true;
      lastKey = rawKey;
      lastDebounceTime = millis();
      return rawKey;
    }
  } else {
    if (isWaitingRelease && (millis() - lastDebounceTime > 60)) {
      isWaitingRelease = false;
      lastDebounceTime = millis();
    }
  }

  return 0;
}

// ================================================================
// FLASH MEMORY (NVS) MANAGEMENT
// ================================================================

void initFlashStorage() {
  preferences.begin("smart_safe", false);
  String stored = preferences.getString("pin", "");

  if (stored.length() == PIN_LENGTH) {
    activePin = stored;
    Serial.println("[NVS] Loaded saved PIN from Flash: ****");
  } else {
    activePin = DEFAULT_PIN;
    preferences.putString("pin", activePin);
    Serial.println("[NVS] Initialized default PIN to Flash: ****");
  }
}

void savePinToFlash(String newPin) {
  if (newPin.length() == PIN_LENGTH) {
    activePin = newPin;
    preferences.putString("pin", activePin);
    Serial.println("[NVS] Successfully saved new PIN to Flash: ****");
  }
}

// ================================================================
// STATE MACHINE (NON-BLOCKING ANIMATIONS)
// ================================================================

void startUnlockSequence(const char* source) {
  Serial.printf("[SAFE] >>> UNLOCK TRIGGERED (%s) <<<\n", source);
  currentState = STATE_UNLOCKING;
  lastCycleToggle = millis();
  currentCycleCount = 0;
  cyclePhaseActive = true;

  // Correct PIN: Buzzer does NOT sound (รหัสถูก -> ไม่ต้องร้อง)
  buzzerAlarmOff();

  // Phase 1 ON: LED Matrix 1s ON
  setLedMatrix(true);
}

void startAlarmSequence() {
  Serial.println("[SAFE] >>> ALARM / WRONG PIN TRIGGERED <<<");
  currentState = STATE_ALARM;
  lastCycleToggle = millis();
  currentCycleCount = 0;
  cyclePhaseActive = true;

  // Phase 1 ON: Buzzer 1000 Hz + LED Matrix 0.5s ON
  setLedMatrix(true);
  buzzerAlarmOn();
}

void updateSafeStateMachine() {
  unsigned long now = millis();

  switch (currentState) {
    case STATE_IDLE:
      break;

    case STATE_UNLOCKING:
      // Correct PIN: LED Matrix 1s ON, 1s OFF for 2 cycles (Total 4s)
      if (cyclePhaseActive) {
        if (now - lastCycleToggle >= 1000) {
          cyclePhaseActive = false;
          lastCycleToggle = now;
          setLedMatrix(false); // Turn OFF
        }
      } else {
        if (now - lastCycleToggle >= 1000) {
          currentCycleCount++;
          if (currentCycleCount >= 2) {
            // Completed 2 full cycles: return to IDLE
            setLedMatrix(false);
            buzzerAlarmOff();
            currentState = STATE_IDLE;
            Serial.println("[SAFE] Unlock sequence completed. Ready.");
          } else {
            // Start next cycle: Turn ON
            cyclePhaseActive = true;
            lastCycleToggle = now;
            setLedMatrix(true);
          }
        }
      }
      break;

    case STATE_ALARM:
      // Wrong PIN: Buzzer 1000 Hz + LED Matrix 0.5s ON, 0.5s OFF for 10 cycles (Total 10s)
      if (cyclePhaseActive) {
        if (now - lastCycleToggle >= 500) {
          cyclePhaseActive = false;
          lastCycleToggle = now;
          setLedMatrix(false);
          buzzerAlarmOff();
        }
      } else {
        if (now - lastCycleToggle >= 500) {
          currentCycleCount++;
          if (currentCycleCount >= 10) {
            // Completed 10 full cycles: return to IDLE and ensure noTone()
            setLedMatrix(false);
            buzzerAlarmOff(); // Must call noTone() after finish
            currentState = STATE_IDLE;
            Serial.println("[SAFE] Alarm sequence completed. Ready.");
          } else {
            // Start next cycle: Turn ON Buzzer 1000 Hz + LED Matrix
            cyclePhaseActive = true;
            lastCycleToggle = now;
            setLedMatrix(true);
            buzzerAlarmOn();
          }
        }
      }
      break;
  }
}

// ================================================================
// EVENT REPORTING (WEBSOCKET + HTTP REST FALLBACK)
// ================================================================

void reportEventToServer(const char* source, const char* status, const char* details) {
  StaticJsonDocument<256> doc;
  doc["type"] = "EVENT";
  doc["source"] = source;
  doc["status"] = status;
  doc["details"] = details;

  String jsonString;
  serializeJson(doc, jsonString);

  // Send via WebSocket if connected
  if (isWsConnected) {
    webSocket.sendTXT(jsonString);
    Serial.printf("[WS SENT] %s\n", jsonString.c_str());
    return;
  }

  // Fallback to HTTP POST if WebSocket temporarily disconnected
  Serial.println("[HTTP FALLBACK] Sending event via REST API...");
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    String url = String(SERVER_HTTP_URL) + "/api/device/event";
    http.begin(url);
    http.addHeader("Content-Type", "application/json");
    int httpCode = http.POST(jsonString);
    Serial.printf("[HTTP] Result code: %d\n", httpCode);
    http.end();
  }
}

// ================================================================
// CLOUD PIN SYNCHRONIZATION (REST API)
// ================================================================

void syncPinWithCloud() {
  if (WiFi.status() != WL_CONNECTED) return;

  Serial.println("[SYNC] Checking cloud server for active PIN...");
  HTTPClient http;
  String url = String(SERVER_HTTP_URL) + "/api/device/sync-pin";
  http.begin(url);
  http.setTimeout(3000);

  int httpCode = http.GET();
  if (httpCode == 200) {
    String payload = http.getString();
    StaticJsonDocument<256> doc;
    DeserializationError error = deserializeJson(doc, payload);

    if (!error && doc["success"].as<bool>()) {
      String cloudPin = doc["pin"].as<String>();
      if (cloudPin.length() == PIN_LENGTH && cloudPin != activePin) {
        Serial.println("[SYNC] Updating PIN from Cloud to Flash (****)");
        savePinToFlash(cloudPin);
      } else {
        Serial.println("[SYNC] Device PIN is in sync with Cloud (****)");
      }
    }
  } else {
    Serial.printf("[SYNC] Cloud sync returned HTTP %d\n", httpCode);
  }
  http.end();
}

// ================================================================
// WEBSOCKET CLIENT EVENT HANDLER
// ================================================================

void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      isWsConnected = false;
      Serial.println("[WS] Disconnected from server.");
      break;

    case WStype_CONNECTED: {
      isWsConnected = true;
      Serial.println("[WS] Connected to Smart Safe Cloud Server!");

      // Identify this connection as an IoT Hardware device
      StaticJsonDocument<256> doc;
      doc["type"] = "IDENTIFY";
      doc["role"] = "device";
      doc["secret"] = DEVICE_SECRET;
      String identifyMsg;
      serializeJson(doc, identifyMsg);
      webSocket.sendTXT(identifyMsg);
      break;
    }

    case WStype_TEXT: {
      StaticJsonDocument<512> doc;
      DeserializationError error = deserializeJson(doc, payload, length);

      if (error) {
        Serial.printf("[WS] JSON parse failed: %s\n", error.c_str());
        return;
      }

      const char* msgType = doc["type"] | "";
      const char* action  = doc["action"] | "";

      // 1. Remote Unlock Command from Website
      if (strcmp(action, "UNLOCK") == 0) {
        Serial.println("[WS CMD] Received Remote UNLOCK from Website!");
        startUnlockSequence("WEBSITE");
      }

      // 2. Change PIN Command from Website
      else if (strcmp(action, "SET_PASSWORD") == 0) {
        const char* newPin = doc["payload"]["newPassword"] | "";
        if (strlen(newPin) == PIN_LENGTH) {
          Serial.println("[WS CMD] Received Remote SET_PASSWORD: **** (Updating Flash NVS)");
          savePinToFlash(String(newPin));

          // Acknowledge back to server
          StaticJsonDocument<128> ack;
          ack["type"] = "PASSWORD_ACK";
          ack["status"] = "OK";
          String ackStr;
          serializeJson(ack, ackStr);
          webSocket.sendTXT(ackStr);
        }
      }

      // 3. Heartbeat Pong
      else if (strcmp(msgType, "PONG") == 0) {
        // Keepalive OK
      }
      break;
    }

    case WStype_PONG:
      break;

    case WStype_ERROR:
      Serial.println("[WS] Socket error encountered");
      break;

    default:
      break;
  }
}

// ================================================================
// KEYPAD SCANNING & INPUT PROCESSING
// ================================================================

void handleKeypadInput() {
  char key = getPressedKey();
  if (!key) return;

  // 1. Clear / Cancel Key: '*'
  if (key == '*') {
    enteredIndex = 0;
    memset(enteredPin, 0, sizeof(enteredPin));
    Serial.println("[KEYPAD] Input cleared (*)");
    return;
  }

  // 2. Confirm Key: '#'
  if (key == '#') {
    if (enteredIndex == 0) {
      Serial.println("[KEYPAD] Empty PIN entered.");
      return;
    }

    enteredPin[enteredIndex] = '\0';
    Serial.println("[KEYPAD] Submitted PIN: ****");

    // Verify entered PIN against active PIN
    if (String(enteredPin) == activePin) {
      Serial.println("[KEYPAD] => PIN CORRECT! UNLOCKING...");
      startUnlockSequence("KEYPAD");
      reportEventToServer("KEYPAD", "SUCCESS", "เปิดสำเร็จจาก Keypad");
    } else {
      Serial.println("[KEYPAD] => WRONG PIN! TRIGGERING ALARM...");
      startAlarmSequence();
      reportEventToServer("KEYPAD", "FAILED", "รหัสผิดจาก Keypad");
    }

    // Reset buffer
    enteredIndex = 0;
    memset(enteredPin, 0, sizeof(enteredPin));
    return;
  }

  // 3. Digit Keys: '0' - '9'
  if (key >= '0' && key <= '9') {
    if (enteredIndex < PIN_LENGTH) {
      enteredPin[enteredIndex++] = key;
      enteredPin[enteredIndex] = '\0';
      Serial.printf("[KEYPAD] Digit entered (%d/%d)\n", enteredIndex, PIN_LENGTH);
    } else {
      Serial.println("[KEYPAD] Max 4 digits reached. Press # to confirm or * to clear.");
    }
  }
}

// ================================================================
// SETUP
// ================================================================

void setup() {
  // ปิดระบบ Brownout Detector เพื่อไม่ให้ชิป ESP32 รีเซ็ตตัวเองตอนดึงกระแสเปิด WiFi
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);

  Serial.begin(115200);
  delay(1000);

  Serial.println("\n==================================================");
  Serial.println("   🛡️  SMART SAFE IoT - KIDBRIGHT32 READY");
  Serial.println("==================================================");

  // 1. Initialize Buzzer Pin
  pinMode(PIN_BUZZER, OUTPUT);
  buzzerAlarmOff();

  // 2. Initialize Keypad Pins (Rows as High-Z, Cols as INPUT_PULLUP)
  initKeypadPins();

  // 3. Initialize HT16K33 LED Matrix (I2C 0x70 on SDA 21, SCL 22)
  ht16k33_init();

  // 4. Initialize Flash Memory (NVS)
  initFlashStorage();

  // 5. Connect to WiFi
  Serial.printf("[WIFI] Connecting to %s...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setTxPower(WIFI_POWER_15dBm); // ลดกำลังส่งเล็กน้อยเพื่อลดกระแสกระชาก
  delay(100);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long wifiStart = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - wifiStart < 15000)) {
    delay(500);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WIFI] Connected successfully!");
    Serial.printf("[WIFI] Device IP: %s\n", WiFi.localIP().toString().c_str());

    // Sync active PIN from Cloud Server
    syncPinWithCloud();

    // Configure WebSocket Client
    // FIX: USE_SSL / SERVER_HOST / SERVER_PORT / WS_PATH เป็น #define แล้ว (ใช้ได้ปกติ)
    if (USE_SSL) {
      webSocket.beginSSL(SERVER_HOST, SERVER_PORT, WS_PATH);
    } else {
      webSocket.begin(SERVER_HOST, SERVER_PORT, WS_PATH);
    }
    webSocket.onEvent(webSocketEvent);
    webSocket.setReconnectInterval(5000);
    webSocket.enableHeartbeat(15000, 3000, 2);

    Serial.printf("[WS] Connecting to ws%s://%s:%d%s\n", USE_SSL ? "s" : "", SERVER_HOST, SERVER_PORT, WS_PATH);
  } else {
    Serial.println("\n[WIFI] Could not connect. Operating in OFFLINE SAFE mode.");
  }
}

// ================================================================
// MAIN LOOP
// ================================================================

void loop() {
  // 1. Maintain WebSocket connection if WiFi connected
  if (WiFi.status() == WL_CONNECTED) {
    webSocket.loop();

    // Heartbeat ping
    if (isWsConnected && (millis() - lastHeartbeatTime >= HEARTBEAT_INTERVAL)) {
      lastHeartbeatTime = millis();
      webSocket.sendTXT("{\"type\":\"PING\"}");
    }
  }

  // 2. Scan Keypad input
  handleKeypadInput();

  // 3. Update Non-blocking State Machine (Buzzer & LED Matrix animations)
  updateSafeStateMachine();
}
