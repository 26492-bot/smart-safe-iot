/**
 * ================================================================
 * SMART SAFE IoT - KidBright32 (ALL-IN-ONE SINGLE FILE)
 * ================================================================
 * โค้ดฉบับรวมไฟล์เดียว (ไม่ต้องใช้ config.h แยก)
 * แก้อาการ "config.h: No such file or directory" ใน Arduino IDE
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

// ================================================================
// 1. ตั้งค่าเครือข่ายและเซิร์ฟเวอร์ (CONFIG)
// ================================================================
const char* WIFI_SSID     = "V";           // ชื่อ WiFi ของคุณ
const char* WIFI_PASSWORD = "11111111";    // รหัสผ่าน WiFi ของคุณ

// IP ของคอมพิวเตอร์ที่รัน Server อยู่ขณะนี้
const char* SERVER_HOST = "192.168.114.171";
const uint16_t SERVER_PORT = 3000;
const bool USE_SSL = false; // true เมื่อใช้ HTTPS/WSS (พอร์ต 443)

// WebSocket Endpoint
const char* WS_PATH = "/ws?role=device";

// HTTP REST URL สำหรับตอนเปิดเครื่อง Sync รหัสผ่าน
#define SERVER_HTTP_URL "http://192.168.114.171:3000"

// รหัสอุปกรณ์ (ตรงกับ backend .env)
const char* DEVICE_SECRET = "smart_safe_secret_key_2026";

// ================================================================
// 2. ขาเชื่อมต่อฮาร์ดแวร์ (KidBright32)
// ================================================================
const byte KEYPAD_ROWS = 4;
const byte KEYPAD_COLS = 4;

// Keypad Rows: GPIO 26, 27, 18, 19
const byte ROW_PINS[KEYPAD_ROWS] = { 26, 27, 18, 19 };

// Keypad Columns: GPIO 33, 23, 21, 22 (21 และ 22 ใช้ร่วมกับ I2C)
const byte COL_PINS[KEYPAD_COLS] = { 33, 23, 21, 22 };

// LED Matrix HT16K33
#define LED_ADDRESS  0x70
#define PIN_I2C_SDA  21
#define PIN_I2C_SCL  22

// Buzzer: GPIO 13
const int PIN_BUZZER = 13;

// ค่าเริ่มต้นรหัสผ่าน
const char* DEFAULT_PIN = "1234";
const int PIN_LENGTH = 4;

// ================================================================
// 3. ตัวแปรและสถานะการทำงาน
// ================================================================
enum SafeState {
  STATE_IDLE,
  STATE_UNLOCKING,    // 1s ON, 1s OFF รวม 2 รอบ
  STATE_ALARM         // 0.5s ON, 0.5s OFF รวม 10 รอบ
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
const unsigned long HEARTBEAT_INTERVAL = 20000;

// ผังปุ่ม Keypad 4x4
const char KEY_MAP[KEYPAD_ROWS][KEYPAD_COLS] = {
  { '1', '2', '3', 'A' },
  { '4', '5', '6', 'B' },
  { '7', '8', '9', 'C' },
  { '*', '0', '#', 'D' }
};

// ================================================================
// 4. ฟังก์ชันควบคุม BUZZER (GPIO 13)
// ================================================================

void buzzerAlarmOn() {
  tone(PIN_BUZZER, 1000); // ความถี่ 1000 Hz
}

void buzzerAlarmOff() {
  noTone(PIN_BUZZER);
  digitalWrite(PIN_BUZZER, LOW);
}

// ================================================================
// 5. ฟังก์ชันควบคุม LED MATRIX HT16K33 (0x70)
// ================================================================

void ht16k33_init() {
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  Wire.setClock(100000);

  // Turn on system oscillator (0x21)
  Wire.beginTransmission(LED_ADDRESS);
  Wire.write(0x21);
  Wire.endTransmission();

  // Display ON, no blinking (0x81)
  Wire.beginTransmission(LED_ADDRESS);
  Wire.write(0x81);
  Wire.endTransmission();

  // Brightness max (0xEF)
  Wire.beginTransmission(LED_ADDRESS);
  Wire.write(0xEF);
  Wire.endTransmission();

  // เริ่มต้นดับไฟ
  setLedMatrix(false);
}

void setLedMatrix(bool turnOn) {
  // ตั้งขาแถวเป็น INPUT (High-Z) ก่อนส่ง I2C ป้องกันการกดปุ่มชนกับ SDA/SCL
  for (int r = 0; r < KEYPAD_ROWS; r++) {
    pinMode(ROW_PINS[r], INPUT);
  }

  Wire.beginTransmission(LED_ADDRESS);
  Wire.write(0x00);
  uint8_t fillByte = turnOn ? 0xFF : 0x00;
  for (int i = 0; i < 16; i++) {
    Wire.write(fillByte);
  }
  Wire.endTransmission();
}

// ================================================================
// 6. ฟังก์ชัน MANUAL KEYPAD SCANNER
// ================================================================

void initKeypadPins() {
  for (int r = 0; r < KEYPAD_ROWS; r++) {
    pinMode(ROW_PINS[r], INPUT);
  }
  pinMode(COL_PINS[0], INPUT_PULLUP); // 33
  pinMode(COL_PINS[1], INPUT_PULLUP); // 23
  pinMode(COL_PINS[2], INPUT_PULLUP); // 21 (SDA)
  pinMode(COL_PINS[3], INPUT_PULLUP); // 22 (SCL)
}

char scanKeypadRaw() {
  for (int r = 0; r < KEYPAD_ROWS; r++) {
    pinMode(ROW_PINS[r], INPUT);
  }

  for (int r = 0; r < KEYPAD_ROWS; r++) {
    pinMode(ROW_PINS[r], OUTPUT);
    digitalWrite(ROW_PINS[r], LOW);
    delayMicroseconds(25);

    for (int c = 0; c < KEYPAD_COLS; c++) {
      if (digitalRead(COL_PINS[c]) == LOW) {
        char key = KEY_MAP[r][c];
        pinMode(ROW_PINS[r], INPUT); // คืนค่าเป็น High-Z ทันที
        return key;
      }
    }

    pinMode(ROW_PINS[r], INPUT);
    delayMicroseconds(5);
  }

  return 0;
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
// 7. จัดการ FLASH MEMORY (NVS)
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
// 8. STATE MACHINE (NON-BLOCKING)
// ================================================================

void startUnlockSequence(const char* source) {
  Serial.printf("[SAFE] >>> UNLOCK TRIGGERED (%s) <<<\n", source);
  currentState = STATE_UNLOCKING;
  lastCycleToggle = millis();
  currentCycleCount = 0;
  cyclePhaseActive = true;

  // รหัสถูก: ไม่ต้องร้อง
  buzzerAlarmOff();

  // ติด 1 วินาที
  setLedMatrix(true);
}

void startAlarmSequence() {
  Serial.println("[SAFE] >>> ALARM / WRONG PIN TRIGGERED <<<");
  currentState = STATE_ALARM;
  lastCycleToggle = millis();
  currentCycleCount = 0;
  cyclePhaseActive = true;

  // รหัสผิด: Buzzer 1000 Hz + LED ติด 0.5 วินาที
  setLedMatrix(true);
  buzzerAlarmOn();
}

void updateSafeStateMachine() {
  unsigned long now = millis();

  switch (currentState) {
    case STATE_IDLE:
      break;

    case STATE_UNLOCKING:
      // รหัสถูก: ติด 1 วินาที / ดับ 1 วินาที รวม 2 รอบ
      if (cyclePhaseActive) {
        if (now - lastCycleToggle >= 1000) {
          cyclePhaseActive = false;
          lastCycleToggle = now;
          setLedMatrix(false);
        }
      } else {
        if (now - lastCycleToggle >= 1000) {
          currentCycleCount++;
          if (currentCycleCount >= 2) {
            setLedMatrix(false);
            buzzerAlarmOff();
            currentState = STATE_IDLE;
            Serial.println("[SAFE] Unlock sequence completed. Ready.");
          } else {
            cyclePhaseActive = true;
            lastCycleToggle = now;
            setLedMatrix(true);
          }
        }
      }
      break;

    case STATE_ALARM:
      // รหัสผิด: Buzzer 1000 Hz + LED ติด 0.5 วินาที / ดับ 0.5 วินาที รวม 10 รอบ
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
            setLedMatrix(false);
            buzzerAlarmOff(); // noTone() เมื่อจบ
            currentState = STATE_IDLE;
            Serial.println("[SAFE] Alarm sequence completed. Ready.");
          } else {
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
// 9. การส่ง EVENT และ WEBSOCKET
// ================================================================

void reportEventToServer(const char* source, const char* status, const char* details) {
  StaticJsonDocument<256> doc;
  doc["type"] = "EVENT";
  doc["source"] = source;
  doc["status"] = status;
  doc["details"] = details;

  String jsonString;
  serializeJson(doc, jsonString);

  if (isWsConnected) {
    webSocket.sendTXT(jsonString);
    Serial.printf("[WS SENT] %s\n", jsonString.c_str());
    return;
  }

  // HTTP REST Fallback
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

void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      isWsConnected = false;
      Serial.println("[WS] Disconnected from server.");
      break;

    case WStype_CONNECTED: {
      isWsConnected = true;
      Serial.println("[WS] Connected to Smart Safe Cloud Server!");

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
      if (error) return;

      const char* action = doc["action"] | "";

      // ปลดล็อกตู้เซฟจากหน้าเว็บ
      if (strcmp(action, "UNLOCK") == 0) {
        Serial.println("[WS CMD] Received Remote UNLOCK from Website!");
        startUnlockSequence("WEBSITE");
      }

      // เปลี่ยนรหัสผ่านจากหน้าเว็บ
      else if (strcmp(action, "SET_PASSWORD") == 0) {
        const char* newPin = doc["payload"]["newPassword"] | "";
        if (strlen(newPin) == PIN_LENGTH) {
          Serial.println("[WS CMD] Received Remote SET_PASSWORD: **** (Updating Flash NVS)");
          savePinToFlash(String(newPin));

          StaticJsonDocument<128> ack;
          ack["type"] = "PASSWORD_ACK";
          ack["status"] = "OK";
          String ackStr;
          serializeJson(ack, ackStr);
          webSocket.sendTXT(ackStr);
        }
      }
      break;
    }

    default:
      break;
  }
}

// ================================================================
// 10. สแกน KEYPAD
// ================================================================

void handleKeypadInput() {
  char key = getPressedKey();
  if (!key) return;

  // กด * : ล้างรหัส
  if (key == '*') {
    enteredIndex = 0;
    memset(enteredPin, 0, sizeof(enteredPin));
    Serial.println("[KEYPAD] Input cleared (*)");
    return;
  }

  // กด # : ยืนยันรหัส
  if (key == '#') {
    if (enteredIndex == 0) return;

    enteredPin[enteredIndex] = '\0';
    Serial.println("[KEYPAD] Submitted PIN: ****");

    if (String(enteredPin) == activePin) {
      Serial.println("[KEYPAD] => PIN CORRECT! UNLOCKING...");
      startUnlockSequence("KEYPAD");
      reportEventToServer("KEYPAD", "SUCCESS", "เปิดสำเร็จจาก Keypad");
    } else {
      Serial.println("[KEYPAD] => WRONG PIN! TRIGGERING ALARM...");
      startAlarmSequence();
      reportEventToServer("KEYPAD", "FAILED", "รหัสผิดจาก Keypad");
    }

    enteredIndex = 0;
    memset(enteredPin, 0, sizeof(enteredPin));
    return;
  }

  // ตัวเลข 0 - 9
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
// 11. SETUP
// ================================================================

void setup() {
  // ปิดระบบ Brownout Detector เพื่อไม่ให้ชิป ESP32 รีเซ็ตตัวเองตอนดึงกระแสเปิด WiFi
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);

  Serial.begin(115200);
  delay(1000);

  Serial.println("\n==================================================");
  Serial.println("   🛡️  SMART SAFE IoT - KIDBRIGHT32 READY");
  Serial.println("==================================================");

  // 1. Buzzer
  pinMode(PIN_BUZZER, OUTPUT);
  buzzerAlarmOff();

  // 2. Keypad
  initKeypadPins();

  // 3. LED Matrix HT16K33
  ht16k33_init();

  // 4. Flash NVS
  initFlashStorage();

  // 5. WiFi
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

    syncPinWithCloud();

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
// 12. LOOP
// ================================================================

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    webSocket.loop();

    if (isWsConnected && (millis() - lastHeartbeatTime >= HEARTBEAT_INTERVAL)) {
      lastHeartbeatTime = millis();
      webSocket.sendTXT("{\"type\":\"PING\"}");
    }
  }

  handleKeypadInput();
  updateSafeStateMachine();
}
