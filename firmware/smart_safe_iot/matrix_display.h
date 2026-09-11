/**
 * Matrix Display Helper (Optional Extension)
 * Supports MAX7219 (8x8 SPI) and KidBright (16x8 I2C) Matrix Displays
 */

#ifndef MATRIX_DISPLAY_H
#define MATRIX_DISPLAY_H

#include <Arduino.h>

// Icon Bitmaps for 8x8 Matrix Displays
// 1 = LED ON, 0 = LED OFF

// Icon: Unlocked Safe / Checkmark
const byte ICON_UNLOCKED[8] = {
  0b00000000,
  0b00000001,
  0b00000011,
  0b00000110,
  0b10001100,
  0b11011000,
  0b01110000,
  0b00100000
};

// Icon: Locked Safe / Padlock
const byte ICON_LOCKED[8] = {
  0b00111100,
  0b01000010,
  0b01000010,
  0b11111111,
  0b11100111,
  0b11100111,
  0b11111111,
  0b11111111
};

// Icon: Alarm / Error 'X'
const byte ICON_ERROR[8] = {
  0b11000011,
  0b11100111,
  0b01111110,
  0b00111100,
  0b00111100,
  0b01111110,
  0b11100111,
  0b11000011
};

#endif // MATRIX_DISPLAY_H
