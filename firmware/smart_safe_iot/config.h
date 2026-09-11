/**
 * ================================================================
 * SMART SAFE IoT - Hardware & Network Configuration
 * ================================================================
 * KidBright32 Board Pinout & Cloud Network Settings
 * ================================================================
 */

#ifndef CONFIG_H
#define CONFIG_H

#include <Arduino.h>

// ================================================================
// 1. BOARD SELECTION
// ================================================================
#define BOARD_TYPE_KIDBRIGHT32   // KidBright32 (V1.0 - V1.3)

// ================================================================
// 2. WIFI CONFIGURATION
// ================================================================
const char* WIFI_SSID     = "V";           // Your 2.4GHz WiFi SSID
const char* WIFI_PASSWORD = "11111111";    // Your WiFi Password

// ================================================================
// 3. IOT BACKEND SERVER CONFIGURATION
// ================================================================
// Local PC IP or Cloud Domain (e.g. "smart-safe-iot.onrender.com")
const char* SERVER_HOST = "192.168.114.171";
const uint16_t SERVER_PORT = 3000;
const bool USE_SSL = false; // Set to true when deploying with HTTPS/WSS (Port 443)

// WebSocket Endpoint
const char* WS_PATH = "/ws?role=device";

// HTTP REST Fallback base URL (used for initial startup PIN sync)
#define SERVER_HTTP_URL "http://192.168.114.171:3000"

// Device Secret Key (must match DEVICE_SECRET in backend .env)
const char* DEVICE_SECRET = "smart_safe_secret_key_2026";

// ================================================================
// 4. HARDWARE PIN DEFINITIONS (KidBright32 Source of Truth)
// ================================================================

// Keypad 4x4
const byte KEYPAD_ROWS = 4;
const byte KEYPAD_COLS = 4;

// Row Pins: GPIO 26, 27, 18, 19
const byte ROW_PINS[KEYPAD_ROWS] = { 26, 27, 18, 19 };

// Column Pins: GPIO 33, 23, 21, 22
// NOTE: GPIO 21 is shared with I2C SDA, GPIO 22 is shared with I2C SCL
const byte COL_PINS[KEYPAD_COLS] = { 33, 23, 21, 22 };

// LED Matrix HT16K33 (I2C)
#define LED_ADDRESS  0x70
#define PIN_I2C_SDA  21
#define PIN_I2C_SCL  22

// Buzzer: GPIO 13
const int PIN_BUZZER = 13;

// Onboard Indicator LED
const int PIN_LED_ONBOARD = 2;

// ================================================================
// 5. SAFE LOGIC DEFAULTS
// ================================================================
const char* DEFAULT_PIN = "1234";
const int PIN_LENGTH = 4;

#endif // CONFIG_H
