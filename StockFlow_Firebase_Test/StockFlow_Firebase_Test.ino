/*
  =============================================================================
  STOCKFLOW - SISTEM SORTIR & TIMBANG OTOMATIS BERBASIS IOT (ESP8266 + FIREBASE)
  =============================================================================
  Board : NodeMCU ESP8266 V3 / V2 (Base Shield)
  
  DEFINISI PIN (Sesuai Skema Base Shield & sketch_nov9a):
  - RST_PIN   : D0 (GPIO 16) - Baris 1  -> Pin RST Modul RFID RC522
  - HX711_DT  : D1 (GPIO 5)  - Baris 2  -> Pin DT Load Cell HX711
  - HX711_SCK : D2 (GPIO 4)  - Baris 3  -> Pin SCK Load Cell HX711
  - SERVO_PIN : D3 (GPIO 0)  - Baris 4  -> Signal Servo SG90 (Diverter)
  - SS_PIN    : D4 (GPIO 2)  - Baris 5  -> Pin SDA / SS Modul RFID RC522
  - SPI SCK   : D5 (GPIO 14) - Baris 8  -> Otomatis SPI SCK RC522
  - SPI MISO  : D6 (GPIO 12) - Baris 9  -> Otomatis SPI MISO RC522
  - SPI MOSI  : D7 (GPIO 13) - Baris 10 -> Otomatis SPI MOSI RC522
  - MOTOR_IN1 : D8 (GPIO 15) - Baris 11 -> Pin IN1 Driver Motor MX1508
  
  FITUR LENGKAP:
  1. Koneksi WiFi & Firebase Realtime Database
  2. Pembacaan RFID RC522 (SDA=D4, RST=D0)
  3. Pembacaan Timbangan Load Cell HX711 (DT=D1, SCK=D2) dengan auto-tare & kalibrasi EEPROM
  4. Pengendalian Motor Dinamo Konveyor dari Web (STOP / RUN / PWM) via Firebase /device/control
  5. Pengendalian Servo Diverter SG90 (45° Jalur 1, 90° Standby, 135° Jalur 2)
  6. Log Transaksi Scan RFID + Beban ke /logs di Firebase
  7. Log Beban Saja (Deteksi berat tanpa RFID / Perintah Manual) ke /logs di Firebase
  8. Telemetri Real-time ke /device/status (Heartbeat, Berat Live, Status Motor, Status Sensor)
  9. Perintah Serial Monitor lengkap (Kompatibel dengan sketch_nov9a)
  =============================================================================
*/

#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecureBearSSL.h>
#include <SPI.h>
#include <MFRC522.h>
#include <HX711.h>
#include <Servo.h>
#include <EEPROM.h>
#include <time.h>

// =====================================
// KONFIGURASI JARINGAN & FIREBASE
// =====================================
const char* WIFI_SSID     = "TP-Link_DD96";
const char* WIFI_PASSWORD = "30665156";

const char* FIREBASE_URL =
  "https://stockflow-iot-default-rtdb.asia-southeast1.firebasedatabase.app";

// =====================================
// DEFINISI PIN (SESUAI SKEMA BASE SHIELD)
// =====================================
#define RST_PIN     D0  // GPIO 16 - Baris ke-1 (RFID Reset)
#define HX711_DT    D1  // GPIO 5  - Baris ke-2 (Load Cell Data)
#define HX711_SCK   D2  // GPIO 4  - Baris ke-3 (Load Cell Clock)
#define SERVO_PIN   D3  // GPIO 0  - Baris ke-4 (Servo SG90 Signal)
#define SS_PIN      D4  // GPIO 2  - Baris ke-5 (RFID RC522 SDA / SS)
#define MOTOR_IN1   D8  // GPIO 15 - Baris ke-11 (Driver Motor MX1508 IN1)

// =====================================
// SUDUT SERVO DIVERTER
// =====================================
#define SERVO_STANDBY 90
#define SERVO_JALUR1  45
#define SERVO_JALUR2  135

// Konfigurasi sortir otomatis saat scan RFID
const bool SERVO_MOVE_ON_SCAN = true;

// =====================================
// INTERVAL WAKTU & TIMING (ms)
// =====================================
const unsigned long PUSH_INTERVAL         = 3000; // Heartbeat status + berat live ke web
const unsigned long CONTROL_POLL_INTERVAL = 1500; // Cek perintah motor dari Firebase
const unsigned long READ_COOLDOWN         = 2000; // Jeda minimal antar pembacaan RFID
const unsigned long SETTLE_MS             = 500;  // Waktu timbangan stabil saat barang berhenti

// =====================================
// KALIBRASI HX711 & EEPROM
// =====================================
const float DEFAULT_SCALE_FACTOR = 420.0;
const uint32_t EEPROM_MAGIC      = 0x53464C57;

// =====================================
// OBJEK PERANGKAT
// =====================================
MFRC522 rfid(SS_PIN, RST_PIN);
HX711 scale;
Servo sorterServo;

// =====================================
// STATUS PERANGKAT & SENSOR
// =====================================
bool rfidOK        = false;
bool hx711OK       = false;
bool servoOK       = false;
bool motorRunning  = false;
int  motorSpeed    = 255;  // PWM 0 - 255

String servoState  = "standby";
int servoAngle     = SERVO_STANDBY;

float scaleFactor  = DEFAULT_SCALE_FACTOR;
float currentWeight= 0.0;
long  currentRaw   = 0;
String lastUID     = "-";

unsigned long lastPush        = 0;
unsigned long lastControlPoll = 0;
unsigned long lastRead        = 0;
int scanCounter               = 0;

// Variabel auto-log untuk beban tanpa RFID
unsigned long weightStableStart   = 0;
bool weightLoggedForObject        = false;

// =====================================
// UTILITAS WAKTU & FORMAT
// =====================================

String getTimestamp() {
  time_t now = time(nullptr);
  if (now < 1700000000) return "time_not_synced";

  struct tm t;
  gmtime_r(&now, &t);
  char buf[30];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &t);
  return String(buf);
}

String readUID() {
  String uid = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) uid += "0";
    uid += String(rfid.uid.uidByte[i], HEX);
  }
  uid.toUpperCase();
  return uid;
}

// =====================================
// KONTROL MOTOR KONVEYOR
// =====================================

void setMotor(bool run, int speed = 255) {
  motorRunning = run;
  motorSpeed = constrain(speed, 0, 255);

  if (motorRunning && motorSpeed > 0) {
    if (motorSpeed >= 250) {
      digitalWrite(MOTOR_IN1, HIGH);
    } else {
      analogWrite(MOTOR_IN1, motorSpeed);
    }
    Serial.print(">>> [MOTOR] Konveyor JALAN (PWM: ");
    Serial.print(motorSpeed);
    Serial.println(")");
  } else {
    motorRunning = false;
    digitalWrite(MOTOR_IN1, LOW);
    Serial.println(">>> [MOTOR] Konveyor BERHENTI (STOP)");
  }
}

// =====================================
// KONTROL SERVO DIVERTER
// =====================================

void moveServo(int angle, const char* state) {
  servoState = state;
  servoAngle = angle;
  sorterServo.write(angle);
  delay(400);
}

void servoToStandby() {
  moveServo(SERVO_STANDBY, "standby");
}

// =====================================
// FIREBASE REST API
// =====================================

bool sendFirebase(const String& path, const char* method, const String& json) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[Firebase] WiFi terputus, data gagal dikirim.");
    return false;
  }

  BearSSL::WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  http.setTimeout(5000);

  String url = String(FIREBASE_URL) + path + ".json";

  if (!http.begin(client, url)) {
    Serial.println("[Firebase] Gagal memulai koneksi HTTP!");
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  int code = http.sendRequest(method, json);

  bool ok = (code >= 200 && code < 300);
  if (!ok) {
    Serial.print("[Firebase Error] ");
    Serial.print(method);
    Serial.print(" ");
    Serial.print(path);
    Serial.print(" -> ");
    Serial.println(code);
  }

  http.end();
  return ok;
}

// Mengirimkan heartbeat dan status perangkat ke /device/status
void sendDeviceStatus() {
  bool wifiOk = (WiFi.status() == WL_CONNECTED);

  String json = "{";
  json += "\"online\":true,";
  json += "\"rfidOk\":";       json += rfidOK  ? "true," : "false,";
  json += "\"hx711Ok\":";      json += hx711OK ? "true," : "false,";
  json += "\"servoOk\":";      json += servoOK ? "true," : "false,";
  json += "\"servoState\":\""; json += servoState; json += "\",";
  json += "\"servoAngle\":";   json += String(servoAngle); json += ",";
  json += "\"motorRunning\":"; json += motorRunning ? "true," : "false,";
  json += "\"motorSpeed\":";   json += String(motorSpeed); json += ",";
  json += "\"wifiOk\":";       json += wifiOk ? "true," : "false,";
  json += "\"wifiRssi\":";     json += String(wifiOk ? WiFi.RSSI() : 0); json += ",";
  json += "\"weightGram\":";   json += String(currentWeight, 1); json += ",";
  json += "\"weightRaw\":";    json += String(currentRaw); json += ",";
  json += "\"lastUID\":\"";    json += lastUID; json += "\",";
  json += "\"uptimeSec\":";    json += String(millis() / 1000); json += ",";
  json += "\"freeHeap\":";     json += String(ESP.getFreeHeap()); json += ",";
  json += "\"lastSeen\":\"";   json += getTimestamp(); json += "\",";
  json += "\"lastSeenMs\":{\".sv\":\"timestamp\"}";
  json += "}";

  sendFirebase("/device/status", "PATCH", json);
}

// Mengirim log riwayat transaksi atau penimbangan ke /logs
void sendLogRecord(const String& uid, float grams, long raw, int jalur, const String& status, const String& produk) {
  String json = "{";
  json += "\"UID\":\"";        json += uid; json += "\",";
  json += "\"Bobot\":";        json += String(grams, 1); json += ",";
  json += "\"weightRaw\":";    json += String(raw); json += ",";
  json += "\"servoAngle\":";   json += String(jalur); json += ",";
  json += "\"Status\":\"";     json += status; json += "\",";
  json += "\"Produk\":\"";     json += produk; json += "\",";
  json += "\"Timestamp\":\"";  json += getTimestamp(); json += "\",";
  json += "\"tsServer\":{\".sv\":\"timestamp\"}";
  json += "}";

  bool ok = sendFirebase("/logs", "POST", json);
  if (ok) {
    Serial.println(">>> [LOG TERKIRIM KE FIREBASE] UID: " + uid + " | Berat: " + String(grams, 1) + " g | Status: " + status);
  }
}

// Cek perintah dari web (misal: tombol Hentikan Motor di web)
void checkFirebaseControl() {
  if (WiFi.status() != WL_CONNECTED) return;

  BearSSL::WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  http.setTimeout(3500);

  // Periksa path /device/status/control.json (diizinkan oleh Firebase Rules /device/status)
  String url = String(FIREBASE_URL) + "/device/status/control.json";

  if (!http.begin(client, url)) return;

  int code = http.GET();
  if (code >= 200 && code < 300) {
    String payload = http.getString();
    http.end();

    // 1. Cek parameter "motor": true / false
    int mIdx = payload.indexOf("\"motor\":");
    if (mIdx != -1) {
      String sub = payload.substring(mIdx + 8);
      sub.trim();
      bool shouldRun = (sub.startsWith("true") || sub.startsWith("1"));
      if (shouldRun != motorRunning) {
        Serial.print(">>> [KONTROL WEB] Motor diubah: ");
        Serial.println(shouldRun ? "JALAN" : "BERHENTI");
        setMotor(shouldRun, motorSpeed);
        sendDeviceStatus();
      }
    }

    // 2. Cek parameter "speed": int (0 - 255)
    int sIdx = payload.indexOf("\"speed\":");
    if (sIdx != -1) {
      int spd = payload.substring(sIdx + 8).toInt();
      if (spd > 0 && spd <= 255 && spd != motorSpeed) {
        motorSpeed = spd;
        if (motorRunning) {
          analogWrite(MOTOR_IN1, motorSpeed);
        }
      }
    }

    // 3. Cek perintah khusus (tare atau log beban instan dari web)
    if (payload.indexOf("\"tare\":true") != -1) {
      scale.tare(10);
      Serial.println(">>> [KONTROL WEB] Perintah Tare dijalankan.");
      sendFirebase("/device/status/control", "PATCH", "{\"tare\":false}");
    }
    return;
  }
  http.end();
}

// =====================================
// PEMBACAAN SENSOR (HX711 & RFID)
// =====================================

bool checkRFID() {
  byte v = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  if (v == 0x00 || v == 0xFF) {
    rfid.PCD_Init();
    delay(10);
    v = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  }
  return (v != 0x00 && v != 0xFF);
}

bool readScale(long &raw, float &grams, byte samples = 3) {
  if (!scale.wait_ready_timeout(250)) {
    hx711OK = false;
    return false;
  }

  hx711OK = true;
  raw = scale.read_average(samples);
  grams = (raw - scale.get_offset()) / scale.get_scale();

  if (fabs(grams) < 0.5) grams = 0.0;
  return true;
}

void updateSensors() {
  rfidOK = checkRFID();

  long raw;
  float g;
  if (readScale(raw, g, 3)) {
    currentRaw = raw;
    currentWeight = g;
  }
}

// =====================================
// EEPROM & KALIBRASI
// =====================================

void loadScaleFactor() {
  EEPROM.begin(16);
  uint32_t magic = 0;
  EEPROM.get(0, magic);

  if (magic == EEPROM_MAGIC) {
    EEPROM.get(4, scaleFactor);
  }

  if (isnan(scaleFactor) || fabs(scaleFactor) < 0.0001) {
    scaleFactor = DEFAULT_SCALE_FACTOR;
  }
}

void saveScaleFactor() {
  EEPROM.put(0, EEPROM_MAGIC);
  EEPROM.put(4, scaleFactor);
  EEPROM.commit();
}

// =====================================
// SERIAL COMMAND HANDLER
// =====================================

void handleSerial() {
  if (!Serial.available()) return;

  String cmd = Serial.readStringUntil('\n');
  cmd.trim();
  if (cmd.length() == 0) return;

  char first = cmd.charAt(0);

  switch (first) {
    case '1':
      setMotor(true, 255);
      sendFirebase("/device/status/control", "PATCH", "{\"motor\":true,\"speed\":255}");
      sendDeviceStatus();
      break;

    case '2':
      setMotor(true, 160);
      sendFirebase("/device/status/control", "PATCH", "{\"motor\":true,\"speed\":160}");
      sendDeviceStatus();
      break;

    case '0':
      setMotor(false, 0);
      sendFirebase("/device/status/control", "PATCH", "{\"motor\":false,\"speed\":0}");
      sendDeviceStatus();
      break;

    case '3':
      moveServo(SERVO_JALUR1, "jalur1");
      Serial.println(">>> [SERVO] Belok Kiri (45° Jalur 1)");
      break;

    case '4':
      servoToStandby();
      Serial.println(">>> [SERVO] Posisi Tengah/Netral (90° Standby)");
      break;

    case '5':
      moveServo(SERVO_JALUR2, "jalur2");
      Serial.println(">>> [SERVO] Belok Kanan (135° Jalur 2)");
      break;

    case 't':
    case 'T':
      if (scale.wait_ready_timeout(500)) {
        scale.tare(10);
        Serial.println(">>> [HX711] Timbangan di-reset ke 0.0 gram (Tare Selesai).");
        sendDeviceStatus();
      } else {
        Serial.println(">>> [HX711] Modul timbangan tidak siap!");
      }
      break;

    case 's':
    case 'S':
      Serial.print(">>> [HX711] Scale Factor saat ini: ");
      Serial.println(scaleFactor, 4);
      break;

    case 'w':
    case 'W':
      // Perintah manual untuk mencatat log beban saja
      Serial.println(">>> [MANUAL LOG] Mengirim Log Beban Saja ke Firebase...");
      sendLogRecord("BEBAN-MANUAL", currentWeight, currentRaw, SERVO_STANDBY, "Beban Saja", "Penimbangan Manual");
      sendDeviceStatus();
      break;

    case 'c':
    case 'C': {
      float known = cmd.substring(1).toFloat();
      if (known <= 0) {
        Serial.println(">>> [KALIBRASI] Format: c200 (contoh: beban 200 gram di atas timbangan)");
        return;
      }
      if (!scale.wait_ready_timeout(500)) {
        Serial.println(">>> [HX711] Modul timbangan tidak siap!");
        return;
      }
      long raw = scale.read_average(15);
      scaleFactor = (float)(raw - scale.get_offset()) / known;
      scale.set_scale(scaleFactor);
      saveScaleFactor();
      Serial.print(">>> [KALIBRASI BERHASIL] Scale factor baru: ");
      Serial.println(scaleFactor, 4);
      sendDeviceStatus();
      break;
    }

    default:
      Serial.println("---------------------------------------------");
      Serial.println("DAFTAR PERINTAH SERIAL MONITOR:");
      Serial.println(" [1] Dinamo Konveyor JALAN (Kecepatan Penuh 255)");
      Serial.println(" [2] Dinamo Konveyor JALAN PELAN (PWM 160)");
      Serial.println(" [0] Dinamo Konveyor BERHENTI (STOP)");
      Serial.println(" [3] Servo Belok KIRI (45° Jalur 1)");
      Serial.println(" [4] Servo Posisi TENGAH (90° Standby)");
      Serial.println(" [5] Servo Belok KANAN (135° Jalur 2)");
      Serial.println(" [w] Catat Log Beban Saja ke Firebase");
      Serial.println(" [t] Tare / Reset Timbangan ke 0.0 gram");
      Serial.println(" [c<gram>] Kalibrasi (contoh: c200)");
      Serial.println(" [s] Tampilkan Scale Factor saat ini");
      Serial.println("---------------------------------------------");
      break;
  }
}

// =====================================
// KONEKSI WIFI & NTP WAKTU
// =====================================

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("[WiFi] Menghubungkan ke ");
  Serial.print(WIFI_SSID);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("[WiFi] TERHUBUNG! IP: ");
    Serial.println(WiFi.localIP());

    configTime(0, 0, "pool.ntp.org", "time.google.com");
    Serial.print("[NTP] Sinkronisasi waktu...");
    for (int i = 0; i < 15 && time(nullptr) < 1700000000; i++) {
      delay(400);
      Serial.print(".");
    }
    Serial.println(" Selesai.");
  } else {
    Serial.println("[WiFi] GAGAL TERHUBUNG! Periksa SSID & Password.");
  }
}

// =====================================
// SETUP SISTEM
// =====================================

void setup() {
  // 1. Kunci mati motor konveyor sejak detik pertama (keamanan hardware)
  pinMode(MOTOR_IN1, OUTPUT);
  digitalWrite(MOTOR_IN1, LOW);

  Serial.begin(115200);
  delay(500);

  Serial.println("\n=============================================");
  Serial.println("   STOCKFLOW - ESP8266 + FIREBASE TEST (v3)  ");
  Serial.println("=============================================");

  // 2. Inisialisasi Servo SG90 di pin D3
  sorterServo.attach(SERVO_PIN, 500, 2400);
  sorterServo.write(SERVO_STANDBY);
  servoOK = sorterServo.attached();
  Serial.print("[CEK] Servo SG90 (Pin D3): ");
  Serial.println(servoOK ? "TERHUBUNG (Standby 90°)" : "GAGAL");

  // 3. Inisialisasi SPI & RFID RC522 (SDA=D4, RST=D0)
  SPI.begin();
  rfid.PCD_Init();
  delay(50);
  byte v = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  if (v == 0x00 || v == 0xFF) {
    rfidOK = false;
    Serial.println("[CEK] Modul RFID RC522: GAGAL TERBACA! Cek koneksi pin D0, D4, D5, D6, D7.");
  } else {
    rfidOK = true;
    Serial.print("[CEK] Modul RFID RC522: TERHUBUNG! (Firmware Version: 0x");
    Serial.print(v, HEX);
    Serial.println(")");
  }

  // 4. Inisialisasi Load Cell HX711 (DT=D1, SCK=D2)
  loadScaleFactor();
  scale.begin(HX711_DT, HX711_SCK);
  scale.set_scale(scaleFactor);
  delay(200);

  Serial.print("[CEK] Modul Load Cell HX711: ");
  if (scale.wait_ready_timeout(1000)) {
    hx711OK = true;
    scale.tare(10);
    Serial.println("TERHUBUNG & TARE (0.0 g) BERHASIL!");
  } else {
    hx711OK = false;
    Serial.println("GAGAL! Cek kabel D1 (DT) dan D2 (SCK).");
  }

  // 5. Hubungkan ke WiFi dan kirim status awal ke Firebase
  connectWiFi();
  updateSensors();

  if (WiFi.status() == WL_CONNECTED) {
    // Sinkronkan status kontrol motor dari Firebase
    checkFirebaseControl();
    sendDeviceStatus();
  }

  Serial.println("---------------------------------------------");
  Serial.println("SISTEM SIAP! Tempelkan kartu RFID atau taruh beban.");
  Serial.println("Gunakan perintah '0' untuk STOP, '1' untuk RUN motor.");
  Serial.println("---------------------------------------------\n");
}

// =====================================
// LOOP UTAMA
// =====================================

void loop() {
  // A. Penanganan Reconnect WiFi Otomatis
  static unsigned long lastReconnect = 0;
  if (WiFi.status() != WL_CONNECTED && millis() - lastReconnect > 15000) {
    lastReconnect = millis();
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }

  // B. Proses Perintah dari Serial Monitor
  handleSerial();

  // C. Cek Perintah Kontrol dari Web (Firebase /device/control)
  if (millis() - lastControlPoll >= CONTROL_POLL_INTERVAL) {
    lastControlPoll = millis();
    checkFirebaseControl();
  }

  // D. Kirim Heartbeat & Berat Live ke /device/status
  if (millis() - lastPush >= PUSH_INTERVAL) {
    lastPush = millis();
    updateSensors();

    Serial.print("[MONITOR] Berat: ");
    Serial.print(currentWeight, 1);
    Serial.print(" g | Motor: ");
    Serial.print(motorRunning ? "JALAN" : "STOP");
    Serial.print(" | RFID: ");
    Serial.print(rfidOK ? "OK" : "X");
    Serial.print(" | HX711: ");
    Serial.print(hx711OK ? "OK" : "X");
    Serial.print(" | Servo: ");
    Serial.println(servoState);

    sendDeviceStatus();
  }

  // E. Deteksi Kartu / Tag RFID (Sesuai Referensi sketch_nov9a)
  if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
    String uid = readUID();
    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();

    if (millis() - lastRead >= READ_COOLDOWN) {
      lastRead = millis();
      lastUID = uid;
      rfidOK = true;

      Serial.println("\n=============================================");
      Serial.println(">>> [RFID DETECTED] UID Kartu: " + uid);

      // Hentikan sejenak motor jika sedang berjalan agar penimbangan presisi
      bool previousMotorState = motorRunning;
      if (previousMotorState) {
        digitalWrite(MOTOR_IN1, LOW);
      }

      // Beri waktu timbangan stabil (settle)
      delay(SETTLE_MS);

      long raw = 0;
      float grams = 0;
      if (readScale(raw, grams, 5)) {
        currentRaw = raw;
        currentWeight = grams;
        Serial.print(">>> [HX711] Berat Terukur: ");
        Serial.print(grams, 1);
        Serial.print(" gram (Raw: ");
        Serial.print(raw);
        Serial.println(")");
      } else {
        Serial.println(">>> [HX711] Sensor timbangan tidak merespons!");
      }

      // Klasifikasi status paket
      String statusStr = "Valid";
      if (grams < 20.0 || grams > 800.0) {
        statusStr = "Anomali";
      }

      // Gerakkan servo penyortir
      int targetAngle = SERVO_STANDBY;
      if (SERVO_MOVE_ON_SCAN && servoOK) {
        targetAngle = (statusStr == "Valid") ? SERVO_JALUR1 : SERVO_JALUR2;
        moveServo(targetAngle, "sorting");
        delay(450);
        servoToStandby();
      }
      scanCounter++;

      // Kirim log transaksi lengkap ke Firebase
      sendLogRecord(uid, grams, raw, targetAngle, statusStr, "Paket Sortir");

      // Kembalikan motor ke status semula jika tadi sedang berjalan
      if (previousMotorState && motorRunning) {
        if (motorSpeed >= 250) {
          digitalWrite(MOTOR_IN1, HIGH);
        } else {
          analogWrite(MOTOR_IN1, motorSpeed);
        }
      }

      sendDeviceStatus();
      lastPush = millis();
      Serial.println("=============================================\n");
    }
  }

  // F. Fitur "Log Buat Beban Saja" Secara Otomatis
  // Jika ada benda di atas timbangan (> 10 gram) selama 2.5 detik tanpa RFID,
  // sistem akan otomatis mencatatnya sebagai transaksi "Beban Saja".
  if (currentWeight > 10.0) {
    if (weightStableStart == 0) {
      weightStableStart = millis();
    } else if (millis() - weightStableStart > 2500 && !weightLoggedForObject) {
      weightLoggedForObject = true;
      Serial.println("\n>>> [AUTO LOG BEBAN] Benda terdeteksi di timbangan tanpa scan RFID: " + String(currentWeight, 1) + " g");
      sendLogRecord("BEBAN-ONLY", currentWeight, currentRaw, SERVO_STANDBY, "Beban Saja", "Penimbangan Otomatis");
      sendDeviceStatus();
      lastPush = millis();
    }
  } else if (currentWeight < 5.0) {
    // Reset status saat timbangan kosong kembali
    weightStableStart = 0;
    weightLoggedForObject = false;
  }

  delay(20);
}
