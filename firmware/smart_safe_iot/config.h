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
// FIX: ใช้ #define แทน const char* เพื่อป้องกัน multiple definition error
#define WIFI_SSID     "TNW-WIFI2"   // Your 2.4GHz WiFi SSID
#define WIFI_PASSWORD ""            // Your WiFi Password (empty for open network)

// ================================================================
// 3. IOT BACKEND SERVER CONFIGURATION
// ================================================================
// Local PC IP or Cloud Domain (e.g. "smart-safe-iot.onrender.com")
#define SERVER_HOST    "smart-safe-iot.onrender.com"
#define SERVER_PORT    443
#define USE_SSL        true   // Set to true when deploying with HTTPS/WSS (Port 443)

// WebSocket Endpoint
#define WS_PATH        "/ws?role=device"

// HTTP REST Fallback base URL (used for initial startup PIN sync)
#define SERVER_HTTP_URL "https://smart-safe-iot.onrender.com"

// Device Secret Key (must match DEVICE_SECRET in backend .env)
#define DEVICE_SECRET  "smart_safe_secret_key_2026"

// ================================================================
// 4. HARDWARE PIN DEFINITIONS (KidBright32 Source of Truth)
// ================================================================

// Keypad 4x4
#define KEYPAD_ROWS  4
#define KEYPAD_COLS  4

// ================================================================
// 5. SAFE LOGIC DEFAULTS
// ================================================================
#define DEFAULT_PIN   "1234"
#define PIN_LENGTH    4

// LED Matrix HT16K33 (I2C)
#define LED_ADDRESS   0x70
#define PIN_I2C_SDA   21
#define PIN_I2C_SCL   22

// Buzzer: GPIO 13
#define PIN_BUZZER    13

// Onboard Indicator LED
#define PIN_LED_ONBOARD 2

#endif // CONFIG_H
